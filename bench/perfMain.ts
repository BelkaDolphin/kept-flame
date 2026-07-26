// ---------------------------------------------------------------------------
// オフライン復帰2秒予算(計測 #1)の 4 区間ベンチ — T10 実装 / T11 差し替え
// 境界定義の正は `docs/design/perf-boundaries.md`。このファイルはそこで決めた
// 境界を**そのまま**実装する係であり、ここで境界を足し引きしてはならない
// (設計文書 §2 R8: 新しいコストが出たら文書を先に直す)。
//
// 実行順(復帰経路の順・設計文書 §1):
//   B2 restore → B1 compute → B3 hydrate → B4 mount
//
// T11 で差し替わったもの(設計文書 §7 / §12):
//   - B2 = `src/platform/persistence.ts` の `loadLatestSave`
//          (読出 tx 生成 → get → integrityChecksum 検証 → parse → deserialize)
//   - B1 = `src/platform/workerClient.ts` 経由の Worker catch-up。
//          **判定は往復込みの `computeWallMs`**(設計文書 §7-2)。
//   - メインスレッド同期 advance は消さず `sensitivity.computeOnMainThread` へ
//     (ADR-026(3) の実アプリ別経路であり、差分が計測 #8 そのもの)。
//
// T12 で足したもの(設計文書 §8。4 区間の内側は 1 つも変えていない):
//   - `performance.measureUserAgentSpecificMemory()` を**試行の境界**
//     (試行開始前 / B4+アンマウント後)だけで前後取得し、ヒープ増分を出す
//     (計測 #2 前半)。区間内や区間間には絶対に置かない(§8-1: async で GC を
//     誘発しうるため R2/R4 違反になる)。API 不在(Firefox/WebKit)・非
//     cross-origin-isolated では `memory.supported=false` + 理由を機械可読で残す。
//   - GC ポーズ(#2 後半)は CDP トレースでしか取れないため、このファイルではなく
//     `bench/gcTrace.spec.ts`(Playwright chromium 限定)が担当する。
//
// 計測窓の内側では素の `performance.now()` しか呼ばない。User Timing の
// mark/measure(T12 の CDP トレース切り出し用・設計文書 §8-3)は、取得済みの
// タイムスタンプを `{ startTime }` 指定で**後から**発行する(設計文書 §2 R5)。
// ---------------------------------------------------------------------------

import { h, render } from "preact";

import {
  buildPaddedPerfBoard,
  buildPerfBoard,
  loadPerfContent,
  PERF_FACILITY_COUNT,
  PERF_RESIDENT_COUNT,
  PERF_TARGET_TICK,
  PERF_WORLD_SEED,
  TARGET_SAVE_BYTES,
} from "./perfBoard";
import { DOM_NODES_PER_CELL, EXPECTED_DOM_NODES, PerfGrid, buildGridViewModel } from "./perfGrid";
import {
  buildMemoryReport,
  buildPerfResult,
  summarizeInterval,
  type IntervalId,
  type PerfEngineCounters,
  type PerfMemoryReport,
  type PerfMemoryScopeBytes,
  type PerfMemorySample,
  type PerfMeta,
  type PerfResult,
  type PerfSupplementary,
  type PerfWorkerReport,
  type TrialSample,
} from "./perfStats";

import { advanceWithReport, createAdvanceContext } from "../src/engine/advance";
import { GRID_CELL_COUNT } from "../src/engine/adjacency";
import { toSerializable } from "../src/engine/state/serialize";
import type { GameState } from "../src/engine/state/state";
import {
  ACTIVE_CATCH_UP_STRATEGY,
  CATCH_UP_PROTOCOL_VERSION,
  chooseCatchUpRoute,
  restoreAdvanceContext,
} from "../src/platform/catchUp";
import {
  deleteSaveDb,
  loadLatestSave,
  openSaveDb,
  saveGameState,
} from "../src/platform/persistence";
import { startCatchUpWorker, type CatchUpWorkerHandle } from "../src/platform/workerClient";

/** 計測試行数(計画 §5.2 #1「各10回試行の中央値」)。 */
const MEASURED_TRIALS = 10;
/** ウォームアップ試行数(中央値には入れない・設計文書 §2)。 */
const WARMUP_TRIALS = 1;

/**
 * ベンチ専用の IndexedDB 名。`persistence.ts` の既定(`kept-flame`)とは別名に
 * して、実アプリのセーブと混ざらないようにする(ベンチは毎回 DB を消す)。
 */
const PERF_DB_NAME = "kept-flame-perf-bench";
const PERF_SAVE_KEY = "perfMain";
const PERF_PADDED_SAVE_KEY = "perfPadded";

const encoder = new TextEncoder();

function byteLengthOf(text: string): number {
  return encoder.encode(text).length;
}

// --- User Timing(計測窓の外から発行する・設計文書 §2 R5 / §8-3) ----------

function emitMarks(intervalId: IntervalId, trial: number, start: number, end: number): void {
  try {
    performance.mark(`kf:${intervalId}:start`, { startTime: start });
    performance.mark(`kf:${intervalId}:end`, { startTime: end });
    performance.measure(`kf:${intervalId}`, { start, end, detail: { trial } });
  } catch {
    // User Timing L3 の startTime 指定に未対応のエンジンでは諦める。
    // 計測値そのものは performance.now() 由来なので影響しない。
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

// --- メモリ計測(計測 #2 前半・T12・設計文書 §8) -----------------------------
//
// `performance.measureUserAgentSpecificMemory()` は WICG Measure Memory API の
// 実験的シグネチャで lib.dom.d.ts に型定義が無いため、既存の `deviceMemory`
// (`buildMeta`)と同じ流儀で `unknown` 経由の型アサーションを使う。

interface RawMemoryAttribution {
  readonly url?: string;
  readonly scope?: string;
}

interface RawMemoryBreakdownEntry {
  readonly bytes: number;
  readonly attribution: readonly RawMemoryAttribution[];
  readonly types: readonly string[];
}

interface RawMemoryMeasurement {
  readonly bytes: number;
  readonly breakdown: readonly RawMemoryBreakdownEntry[];
}

type MeasureMemoryFn = () => Promise<RawMemoryMeasurement>;

function getMeasureMemoryFn(): MeasureMemoryFn | null {
  const fn = (performance as unknown as { readonly measureUserAgentSpecificMemory?: unknown })
    .measureUserAgentSpecificMemory;
  return typeof fn === "function" ? (fn.bind(performance) as unknown as MeasureMemoryFn) : null;
}

/**
 * API 不在の理由を機械可読な固定文字列で返す(計画 §6.3 と同じ「null + 理由」方式)。
 * `null` = API が使える。
 */
function memoryUnsupportedReason(
  measureMemoryFn: MeasureMemoryFn | null,
): PerfMemoryReport["unsupportedReason"] {
  if (measureMemoryFn !== null) return null;
  // cross-origin isolated でも API 自体が無ければ Chromium 系以外(計画 §6.3)。
  return globalThis.crossOriginIsolated === true ? "unsupported-api" : "not-cross-origin-isolated";
}

/**
 * 1 スコープぶんの内訳へ集計する。`attribution` は同一 agent cluster
 * (メインの Window + catch-up Worker)を跨ぐため、先頭要素の scope で仕分ける
 * (設計文書 §8 冒頭の指示どおり breakdown を window/worker 別に残す)。
 *
 * @throws {Error} `measureUserAgentSpecificMemory` 自体が例外/reject で終わった場合
 */
async function sampleMemoryScope(measureMemoryFn: MeasureMemoryFn): Promise<PerfMemoryScopeBytes> {
  const result = await measureMemoryFn();
  let windowBytes = 0;
  let workerBytes = 0;
  let otherBytes = 0;
  for (const entry of result.breakdown) {
    const scope = entry.attribution[0]?.scope;
    if (scope === "Window") windowBytes += entry.bytes;
    else if (scope === "Worker") workerBytes += entry.bytes;
    else otherBytes += entry.bytes;
  }
  return { windowBytes, workerBytes, otherBytes, totalBytes: result.bytes };
}

/**
 * `typeof === "function"` は真でも呼び出しが失敗しうる(実測で確認済み:
 * Playwright の headless Chromium 151 は `crossOriginIsolated: true` でも
 * `measureUserAgentSpecificMemory()` が `SecurityError` を投げる。headed では
 * 成功する — ヘッドレス自動化固有の既知の制約)。ベンチ全体を失敗させたくないので
 * ここで握り潰し、最後のエラーメッセージだけ `state` に残す。
 */
async function sampleMemoryScopeSafe(
  measureMemoryFn: MeasureMemoryFn,
  state: { errorMessage: string | null },
): Promise<PerfMemoryScopeBytes | null> {
  try {
    return await sampleMemoryScope(measureMemoryFn);
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
    return null;
  }
}

// --- 1 試行 ----------------------------------------------------------------

interface TrialOutcome {
  readonly sample: TrialSample;
  readonly counters: PerfEngineCounters;
  readonly domNodeCount: number;
  readonly unmountMs: number;
  readonly advancedTick: number;
  readonly snapshotEntityCount: number;
  readonly strategy: string;
}

interface TrialDeps {
  readonly db: IDBDatabase;
  readonly content: ReturnType<typeof loadPerfContent>;
  readonly container: HTMLElement;
  readonly worker: CatchUpWorkerHandle;
}

async function runTrial(trial: number, warmup: boolean, deps: TrialDeps): Promise<TrialOutcome> {
  const { db, content, container, worker } = deps;

  // === B2 restore: IDB 読出 + checksum + JSON.parse + deserialize ==========
  // 内訳は persistence.ts が自分の内側で取った生タイムスタンプ(marks)から
  // 組み立て、関数呼び出しの前後の残差は callOverhead として明示計上する
  // (下位区間が親を過不足なく分割する・設計文書 §2 R7)。
  const r0 = performance.now();
  const restored = await loadLatestSave(db, PERF_SAVE_KEY);
  const r1 = performance.now();
  const state: GameState = restored.state;
  const m = restored.marks;

  // === B1 compute: 72h catch-up(Worker 往復込み)==========================
  const catchUp = await worker.catchUp(state, PERF_TARGET_TICK);
  const advanced = catchUp.snapshot;

  // === B3 hydrate: GameState → 派生値 + ルート vnode ======================
  const h0 = performance.now();
  // 隣接乗数は B1(Worker 側)で計算済みのものが完了メッセージで返ってくる。
  // ここで `createAdvanceContext` を呼び直すと B3 に engine の再計算が入り、
  // 設計文書 §3 B3 の「含まないもの: engine の再計算」に反する(§12-3)。
  const ctx = restoreAdvanceContext(content, catchUp.advanceContext);
  const viewModel = buildGridViewModel(advanced, content, ctx);
  const h1 = performance.now();
  const vnode = h(PerfGrid, { cells: viewModel.cells });
  const h2 = performance.now();

  // === B4 mount: 240 DOM 生成 + 同期レイアウト ===========================
  const m0 = performance.now();
  render(vnode, container);
  const m1 = performance.now();
  const rect = container.getBoundingClientRect();
  const m2 = performance.now();

  // --- ここから先は区間外(設計文書 §2 R6) ---
  if (rect.width < 0) {
    throw new Error("レイアウト強制が最適化で消えた(getBoundingClientRect が無効)");
  }
  const domNodeCount = container.querySelectorAll("*").length;

  const u0 = performance.now();
  render(null, container);
  const u1 = performance.now();

  const restoreMs = r1 - r0;
  const intervalMs = {
    restore: restoreMs,
    compute: catchUp.computeWallMs,
    hydrate: h2 - h0,
    mount: m2 - m0,
  } as const;

  emitMarks("restore", trial, r0, r1);
  // B1 は Worker 側の timeOrigin と混ざらないよう、メイン側の
  // 「postMessage 直前 → 完了メッセージ受信」窓をそのまま mark にする。
  emitMarks("compute", trial, r1, r1 + catchUp.computeWallMs);
  emitMarks("hydrate", trial, h0, h2);
  emitMarks("mount", trial, m0, m2);

  return {
    sample: {
      trial,
      warmup,
      intervalMs,
      subIntervalMs: {
        "restore.idbGet": m.afterIdbGet - m.enter,
        "restore.checksum": m.afterChecksum - m.afterIdbGet,
        "restore.parse": m.afterParse - m.afterChecksum,
        "restore.deserialize": m.afterDeserialize - m.afterParse,
        "restore.callOverhead": restoreMs - (m.afterDeserialize - m.enter),
        "compute.requestPost": catchUp.requestPostMs,
        "compute.workerContextBuild": catchUp.phaseMs.contextBuildMs,
        "compute.workerAdvance": catchUp.phaseMs.advanceMs,
        "compute.workerSnapshot": catchUp.phaseMs.snapshotMs,
        "compute.workerOther":
          catchUp.workerHandlerMs -
          (catchUp.phaseMs.contextBuildMs + catchUp.phaseMs.advanceMs + catchUp.phaseMs.snapshotMs),
        "compute.transport": catchUp.transportMs,
        "hydrate.viewModel": h1 - h0,
        "hydrate.vnode": h2 - h1,
        "mount.render": m1 - m0,
        "mount.layout": m2 - m1,
      },
    },
    counters: catchUp.counters,
    domNodeCount,
    unmountMs: u1 - u0,
    advancedTick: advanced.tick,
    snapshotEntityCount: advanced.entityStateById.size,
    strategy: catchUp.strategy,
  };
}

/**
 * B2 だけを容量目標付近(≈512KB)の合成セーブで測る(設計文書 §3 B2)。
 * 予算判定には使わない参考値。
 */
async function runSaveSizeSensitivity(
  db: IDBDatabase,
  paddedEntityCount: number,
): Promise<{ readonly samples: TrialSample[] }> {
  const samples: TrialSample[] = [];
  for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
    const t0 = performance.now();
    const restored = await loadLatestSave(db, PERF_PADDED_SAVE_KEY);
    const t1 = performance.now();
    if (restored.state.entityStateById.size !== paddedEntityCount) {
      throw new Error("合成セーブの entity 数が復元後に一致しない");
    }
    const m = restored.marks;
    samples.push({
      trial: i,
      warmup: i < 0,
      intervalMs: { restore: t1 - t0, compute: 0, hydrate: 0, mount: 0 },
      subIntervalMs: {
        "restore.idbGet": m.afterIdbGet - m.enter,
        "restore.checksum": m.afterChecksum - m.afterIdbGet,
        "restore.parse": m.afterParse - m.afterChecksum,
        "restore.deserialize": m.afterDeserialize - m.afterParse,
        "restore.callOverhead": t1 - t0 - (m.afterDeserialize - m.enter),
      },
    });
    await yieldToEventLoop();
  }
  return { samples };
}

/**
 * 同じ catch-up をメインスレッド同期 advance で回す(設計文書 §3 B1 の
 * 「メインスレッド版でよい根拠」/ ADR-026(3) の別経路)。Worker 経路との差が
 * Worker 越しの往復コスト = 計測 #8 の本体になる。
 */
function runMainThreadCompute(
  state: GameState,
  content: ReturnType<typeof loadPerfContent>,
): TrialSample[] {
  const samples: TrialSample[] = [];
  for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
    const c0 = performance.now();
    const ctx = createAdvanceContext(state, content);
    const c1 = performance.now();
    const report = advanceWithReport(state, ctx, PERF_TARGET_TICK);
    const c2 = performance.now();
    if (report.state.tick !== PERF_TARGET_TICK) {
      throw new Error("メインスレッド比較 run が目標 tick へ届いていない");
    }
    samples.push({
      trial: i,
      warmup: i < 0,
      intervalMs: { restore: 0, compute: c2 - c0, hydrate: 0, mount: 0 },
      subIntervalMs: { "compute.contextBuild": c1 - c0, "compute.advance": c2 - c1 },
    });
  }
  return samples;
}

// --- メタデータ(非決定値の隔離先・設計文書 §9) ---------------------------

function buildMeta(): PerfMeta {
  const nav = navigator as unknown as { readonly deviceMemory?: number };
  return {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio,
    viewportCss: { widthPx: window.innerWidth, heightPx: window.innerHeight },
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    timeOriginMs: performance.timeOrigin,
  };
}

// --- 実行本体 --------------------------------------------------------------

async function runBench(
  container: HTMLElement,
  onStatus: (text: string) => void,
): Promise<PerfResult> {
  onStatus("content をロード中…");
  const l0 = performance.now();
  const content = loadPerfContent();
  const l1 = performance.now();

  onStatus("代表盤面を構築中…");
  const b0 = performance.now();
  const board = buildPerfBoard(content, PERF_WORLD_SEED);
  const b1 = performance.now();

  // 前回実行の DB を消してから測る = idbOpen を必ず cold(初回作成込み)で
  // 測れるようにする(設計文書 §11-(1) の判断材料)。
  onStatus("IndexedDB を準備中…");
  // 前回実行の DB を消す。これがこのページで**最初の IndexedDB 呼び出し**なので、
  // IndexedDB サブシステム自体の起動コストはここに落ちる(設計文書 §11-(1) の
  // 「idbOpen 44.6ms」が DB 作成コストなのかサブシステム起動なのかの切り分け)。
  const d0 = performance.now();
  await deleteSaveDb(PERF_DB_NAME);
  const d1 = performance.now();
  const o0 = performance.now();
  const db = await openSaveDb(PERF_DB_NAME);
  const o1 = performance.now();
  const put = await saveGameState(db, board, PERF_SAVE_KEY);
  const o2 = performance.now();
  // 既存 DB を開き直したときの open(cold との差が DB 作成コスト)。
  db.close();
  const o3 = performance.now();
  const db2 = await openSaveDb(PERF_DB_NAME);
  const o4 = performance.now();

  onStatus("catch-up Worker を起動中…");
  const worker = await startCatchUpWorker(content);

  const deps: TrialDeps = { db: db2, content, container, worker };
  const samples: TrialSample[] = [];
  const unmountValues: number[] = [];
  const memorySamples: PerfMemorySample[] = [];
  let counters: PerfEngineCounters | null = null;
  let domNodeCount = 0;
  let snapshotEntityCount = 0;
  let strategy = ACTIVE_CATCH_UP_STRATEGY as string;

  // 計測 #2 前半(設計文書 §8): API の可否は実行の頭で 1 回だけ判定する
  // (試行ごとに変わるものではないため、ループの中で毎回 typeof チェックしない)。
  const measureMemoryFn = getMeasureMemoryFn();
  const memoryProbeState: { errorMessage: string | null } = { errorMessage: null };

  try {
    for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
      onStatus(
        i < 0
          ? "ウォームアップ試行を実行中…"
          : `計測試行 ${String(i + 1)} / ${String(MEASURED_TRIALS)} …`,
      );
      // --- メモリ計測「試行開始前」(設計文書 §8-1: 区間の外・4区間の直前) ---
      const memBefore =
        measureMemoryFn === null
          ? null
          : await sampleMemoryScopeSafe(measureMemoryFn, memoryProbeState);
      const outcome = await runTrial(i, i < 0, deps);
      // --- メモリ計測「B4 終了 + アンマウント後」(runTrial が既にアンマウント済み) ---
      const memAfter =
        measureMemoryFn === null
          ? null
          : await sampleMemoryScopeSafe(measureMemoryFn, memoryProbeState);
      if (memBefore !== null && memAfter !== null) {
        memorySamples.push({
          trial: i,
          warmup: i < 0,
          before: memBefore,
          after: memAfter,
          deltaTotalBytes: memAfter.totalBytes - memBefore.totalBytes,
        });
      }
      samples.push(outcome.sample);
      unmountValues.push(outcome.unmountMs);
      domNodeCount = outcome.domNodeCount;
      snapshotEntityCount = outcome.snapshotEntityCount;
      strategy = outcome.strategy;
      if (counters === null) {
        counters = outcome.counters;
      } else if (counters.stochasticTrialCount !== outcome.counters.stochasticTrialCount) {
        throw new Error("試行ごとに engine のカウンタが変わっている(ワークロードが決定論でない)");
      }
      if (outcome.advancedTick !== PERF_TARGET_TICK) {
        throw new Error(
          `catch-up が目標 tick へ届いていない(${String(outcome.advancedTick)} != ${String(PERF_TARGET_TICK)})`,
        );
      }
      await yieldToEventLoop();
    }
    if (counters === null) throw new Error("試行が 1 回も走っていない");
    // fn が有って実際にサンプルが 1 つも取れなかったのは呼び出し失敗
    // (headless Chromium の既知の制約・上記コメント参照)。
    const memoryReason: PerfMemoryReport["unsupportedReason"] =
      measureMemoryFn === null
        ? memoryUnsupportedReason(measureMemoryFn)
        : memorySamples.length === 0
          ? "measurement-error"
          : null;
    const memory = buildMemoryReport(
      memorySamples,
      measureMemoryFn !== null,
      memoryReason,
      memoryProbeState.errorMessage,
    );

    onStatus("save サイズ感度(≈512KB)を計測中…");
    const paddedBoard = buildPaddedPerfBoard(
      content,
      TARGET_SAVE_BYTES,
      (state) => byteLengthOf(JSON.stringify(toSerializable(state))),
      PERF_WORLD_SEED,
    );
    const paddedPut = await saveGameState(db2, paddedBoard, PERF_PADDED_SAVE_KEY);
    const sensitivityRun = await runSaveSizeSensitivity(db2, paddedBoard.entityStateById.size);

    onStatus("メインスレッド同期 advance(比較用)を計測中…");
    const mainThreadSamples = runMainThreadCompute(board, content);

    const unmountMedian = summarizeInterval(
      unmountValues.map((ms, index) => ({
        trial: index - WARMUP_TRIALS,
        warmup: index < WARMUP_TRIALS,
        intervalMs: { restore: ms, compute: 0, hydrate: 0, mount: 0 },
        subIntervalMs: {},
      })),
      "restore",
    ).medianMs;

    const restoreSummary = summarizeInterval(samples, "restore");
    const computeSummary = summarizeInterval(samples, "compute");
    const supplementary: PerfSupplementary = {
      contentLoadMs: l1 - l0,
      contentJsonParseMs: 0,
      boardBuildMs: b1 - b0 + put.encodeMs,
      idbOpenMs: o1 - o0,
      idbPutMs: o2 - o1,
      unmountMedianMs: unmountMedian,
      restoreWithOpenMs: o1 - o0 + restoreSummary.medianMs,
      idbOpenWarmMs: o4 - o3,
      idbFirstTouchMs: d1 - d0,
      saveEncodeMs: put.encodeMs,
    };

    const workerReport: PerfWorkerReport = {
      lifecycle: "preboot",
      protocolVersion: CATCH_UP_PROTOCOL_VERSION,
      updateStrategy: strategy,
      route: chooseCatchUpRoute(PERF_TARGET_TICK),
      bootMs: worker.bootMs,
      contentTransferMs: worker.contentTransferMs,
      computeWorkerMedianMs:
        (computeSummary.subIntervalMedianMs["workerContextBuild"] ?? 0) +
        (computeSummary.subIntervalMedianMs["workerAdvance"] ?? 0) +
        (computeSummary.subIntervalMedianMs["workerSnapshot"] ?? 0) +
        (computeSummary.subIntervalMedianMs["workerOther"] ?? 0),
      snapshotTransferMedianMs: computeSummary.subIntervalMedianMs["transport"] ?? 0,
      requestPostMedianMs: computeSummary.subIntervalMedianMs["requestPost"] ?? 0,
      computeWallWithBootMs: computeSummary.medianMs + worker.bootMs + worker.contentTransferMs,
      snapshotEntityCount,
    };

    const result = buildPerfResult({
      meta: buildMeta(),
      workload: {
        worldSeed: PERF_WORLD_SEED,
        startTick: 0,
        targetTick: PERF_TARGET_TICK,
        coarseTickMinutes: content.coarseTickMinutes,
        residentCount: PERF_RESIDENT_COUNT,
        facilityCount: PERF_FACILITY_COUNT,
        researchCount: content.techDefs.size,
        entityCount: board.entityStateById.size,
        gridCells: GRID_CELL_COUNT,
        domNodesPerCell: DOM_NODES_PER_CELL,
        expectedDomNodes: EXPECTED_DOM_NODES,
        saveBytes: byteLengthOf(JSON.stringify(toSerializable(board))),
        measuredTrials: MEASURED_TRIALS,
        warmupTrials: WARMUP_TRIALS,
        integrityChecksum: put.integrityChecksum,
      },
      engineCounters: counters,
      samples,
      supplementary,
      sensitivity: {
        restoreAtTargetSaveBytes: {
          saveBytes: paddedPut.payloadLength,
          entityCount: paddedBoard.entityStateById.size,
          summary: summarizeInterval(sensitivityRun.samples, "restore"),
        },
        computeOnMainThread: {
          summary: summarizeInterval(mainThreadSamples, "compute"),
          route: "main-structural-sharing",
        },
      },
      observedDomNodeCount: domNodeCount,
      worker: workerReport,
      memory,
    });

    // 計測後に格子を残しておく(目視確認用・計測窓の外)。
    const finalCtx = createAdvanceContext(board, content);
    render(h(PerfGrid, { cells: buildGridViewModel(board, content, finalCtx).cells }), container);

    onStatus("完了。");
    return result;
  } finally {
    worker.terminate();
  }
}

// --- 表示 ------------------------------------------------------------------

function appendRow(
  parent: HTMLTableSectionElement,
  cellTexts: readonly string[],
  tag: "td" | "th",
): void {
  const tr = document.createElement("tr");
  for (const text of cellTexts) {
    const cell = document.createElement(tag);
    cell.textContent = text;
    tr.appendChild(cell);
  }
  parent.appendChild(tr);
}

const INTERVAL_LABEL: { readonly [K in IntervalId]: string } = {
  restore: "B2 restore (persistence: get+checksum+parse+deserialize)",
  compute: "B1 compute (Worker 72h catch-up・往復込み)",
  hydrate: "B3 hydrate (state→派生値)",
  mount: "B4 mount (240 DOM + layout)",
};

function renderResultTable(root: HTMLElement, result: PerfResult): void {
  root.textContent = "";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  appendRow(
    thead,
    ["区間", "中央値 ms", "warmup ms", "min", "max", "予算 ms", "判定(素値)", "×K=5 判定"],
    "th",
  );
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const id of ["restore", "compute", "hydrate", "mount"] as const) {
    const summary = result.intervals[id];
    const raw = result.judgement.desktopRaw.perInterval[id];
    const k = result.judgement.withProvisionalK.perInterval[id];
    appendRow(
      tbody,
      [
        INTERVAL_LABEL[id],
        String(summary.medianMs),
        String(summary.warmupMs),
        String(summary.minMs),
        String(summary.maxMs),
        String(raw.budgetMs),
        raw.verdict,
        k.verdict,
      ],
      "td",
    );
  }
  appendRow(
    tbody,
    [
      "合計(試行ごとの4区間和の中央値)",
      String(result.judgement.desktopRaw.totalMs),
      "—",
      "—",
      "—",
      String(result.budgets.total),
      result.judgement.desktopRaw.totalVerdict,
      result.judgement.withProvisionalK.totalVerdict,
    ],
    "td",
  );
  table.appendChild(tbody);
  root.appendChild(table);

  const notes = document.createElement("ul");
  const worker = result.worker;
  const lines = [
    `DOM 要素数: 実測 ${String(result.observed.domNodeCount)} / 期待 ${String(result.workload.expectedDomNodes)}(${result.observed.domNodeCountMatchesExpected ? "一致" : "不一致"})`,
    `engine カウンタ: 粗粒度ステップ ${String(result.engineCounters.stochasticStepCount)} / ベルヌーイ判定 ${String(result.engineCounters.stochasticTrialCount)} / (A)区間 ${String(result.engineCounters.segmentCount)} / 想起困難 ${String(result.engineCounters.recallOccurrenceCount)}`,
    `セーブ: 代表盤面 ${String(result.workload.saveBytes)} B(entity ${String(result.workload.entityCount)})/ checksum ${String(result.workload.integrityChecksum ?? "—")}`,
    result.sensitivity.restoreAtTargetSaveBytes === null
      ? "save サイズ感度: 未計測"
      : `save サイズ感度(参考): ${String(result.sensitivity.restoreAtTargetSaveBytes.saveBytes)} B で restore 中央値 ${String(result.sensitivity.restoreAtTargetSaveBytes.summary.medianMs)} ms`,
    worker === null
      ? "Worker: 未使用"
      : `Worker(${worker.lifecycle} / ${worker.updateStrategy} / ${worker.route}): boot ${worker.bootMs.toFixed(3)} ms / content 転送 ${worker.contentTransferMs.toFixed(3)} ms / 内訳 worker ${worker.computeWorkerMedianMs.toFixed(3)} ms + 要求post ${worker.requestPostMedianMs.toFixed(3)} ms + 転送残差 ${worker.snapshotTransferMedianMs.toFixed(3)} ms`,
    result.sensitivity.computeOnMainThread === undefined
      ? "メインスレッド比較: 未計測"
      : `メインスレッド同期 advance(比較・ADR-026(3) 別経路): 中央値 ${String(result.sensitivity.computeOnMainThread.summary.medianMs)} ms`,
    `補助: contentLoad ${result.supplementary.contentLoadMs.toFixed(3)} ms / IDB 初回接触 ${(result.supplementary.idbFirstTouchMs ?? 0).toFixed(3)} ms / idbOpen(cold) ${result.supplementary.idbOpenMs.toFixed(3)} ms / idbOpen(warm) ${(result.supplementary.idbOpenWarmMs ?? 0).toFixed(3)} ms / idbPut ${result.supplementary.idbPutMs.toFixed(3)} ms / restore+open ${result.supplementary.restoreWithOpenMs.toFixed(3)} ms`,
    `crossOriginIsolated=${String(result.meta.crossOriginIsolated)}(false の Firefox/WebKit では performance.now が 1ms へ丸められる)`,
    result.memory.supported
      ? `ヒープ増分(計測 #2 前半・試行境界の前後差分): ピーク ${String(result.memory.peakDeltaMb)} MB / 中央値 ${String(result.memory.medianDeltaBytes)} B / warmup ${String(result.memory.warmupDeltaBytes)} B(判断基準 ≤48MB。GC ポーズは bench/gcTrace.spec.ts が別 JSON で出す)`
      : `ヒープ増分: 計測不可(理由=${String(result.memory.unsupportedReason)}。計画 §6.3 の iOS Safari 等)`,
    "この結果はデスクトップの下限見積りであり #1 の合否ではない(設計文書 §0)。",
  ];
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    notes.appendChild(li);
  }
  root.appendChild(notes);
}

function showStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
}

/** コピー/ダウンロードの結果を数秒だけ表示する(T14・両ボタン共通)。 */
function flashStatus(statusEl: HTMLElement, msg: string): void {
  statusEl.textContent = msg;
  setTimeout(() => {
    statusEl.textContent = "";
  }, 3000);
}

function copyResultJson(textarea: HTMLTextAreaElement, statusEl: HTMLElement): void {
  const text = textarea.value;
  if (navigator.clipboard as unknown) {
    navigator.clipboard.writeText(text).then(
      () => {
        flashStatus(statusEl, "コピーしました");
      },
      () => {
        textarea.focus();
        textarea.select();
        flashStatus(statusEl, "コピー失敗: テキストエリアを手動で選択してください");
      },
    );
    return;
  }
  textarea.focus();
  textarea.select();
  flashStatus(statusEl, "コピー失敗: テキストエリアを手動で選択してください");
}

/**
 * 結果 JSON をファイルとしてダウンロードする(T14: 実機での結果回収手段。
 * `docs/measurements/device-testing-guide.md` の「PC へ送る手段」の1つ)。
 * クリップボード API が無い/権限が無い実機でもファイル共有アプリ経由で送れる。
 */
function downloadResultJson(textarea: HTMLTextAreaElement, statusEl: HTMLElement): void {
  const text = textarea.value;
  if (text.length === 0) {
    flashStatus(statusEl, "先に計測を実行してください");
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = url;
  link.download = `kept-flame-perf-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 3000);
  flashStatus(statusEl, "ダウンロードしました");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`要素 #${id} が見つからない`);
  return el as T;
}

function main(): void {
  const runButton = requireElement<HTMLButtonElement>("run-btn");
  const statusEl = requireElement("status");
  const resultsRoot = requireElement("results-root");
  const gridRoot = requireElement("grid-root");
  const jsonArea = requireElement<HTMLTextAreaElement>("result-json");
  const copyButton = requireElement<HTMLButtonElement>("copy-json-btn");
  const downloadButton = requireElement<HTMLButtonElement>("download-json-btn");
  const copyStatus = requireElement("copy-status");

  copyButton.addEventListener("click", () => {
    copyResultJson(jsonArea, copyStatus);
  });
  downloadButton.addEventListener("click", () => {
    downloadResultJson(jsonArea, copyStatus);
  });

  runButton.addEventListener("click", () => {
    runButton.disabled = true;
    runBench(gridRoot, (text) => {
      showStatus(statusEl, text);
    })
      .then((result) => {
        renderResultTable(resultsRoot, result);
        jsonArea.value = JSON.stringify(result, null, 2);
        (window as unknown as { __PERF_RESULT__: unknown }).__PERF_RESULT__ = result;
        (window as unknown as { __PERF_DONE__: boolean }).__PERF_DONE__ = true;
        runButton.disabled = false;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(statusEl, `失敗: ${message}`);
        (window as unknown as { __PERF_ERROR__: string }).__PERF_ERROR__ = message;
        (window as unknown as { __PERF_DONE__: boolean }).__PERF_DONE__ = true;
        runButton.disabled = false;
      });
  });

  if (new URLSearchParams(window.location.search).get("autorun") === "1") {
    runButton.click();
  }
}

main();
