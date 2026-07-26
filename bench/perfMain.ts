// ---------------------------------------------------------------------------
// オフライン復帰2秒予算(計測 #1)の 4 区間ベンチ — T10
// 境界定義の正は `docs/design/perf-boundaries.md`。このファイルはそこで決めた
// 境界を**そのまま**実装する係であり、ここで境界を足し引きしてはならない
// (設計文書 §2 R8: 新しいコストが出たら文書を先に直す)。
//
// 実行順(復帰経路の順・設計文書 §1):
//   B2 restore → B1 compute → B3 hydrate → B4 mount
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
  getSaveText,
  openPerfDb,
  putSaveText,
  PERF_PADDED_SAVE_KEY,
  PERF_SAVE_KEY,
} from "./perfIdb";
import {
  buildPerfResult,
  summarizeInterval,
  type IntervalId,
  type PerfEngineCounters,
  type PerfMeta,
  type PerfResult,
  type PerfSupplementary,
  type TrialSample,
} from "./perfStats";

import { advanceWithReport, createAdvanceContext } from "../src/engine/advance";
import { GRID_CELL_COUNT } from "../src/engine/adjacency";
import { fromSerializable, toSerializable } from "../src/engine/state/serialize";
import type { GameState } from "../src/engine/state/state";

/** 計測試行数(計画 §5.2 #1「各10回試行の中央値」)。 */
const MEASURED_TRIALS = 10;
/** ウォームアップ試行数(中央値には入れない・設計文書 §2)。 */
const WARMUP_TRIALS = 1;

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

// --- 1 試行 ----------------------------------------------------------------

interface TrialOutcome {
  readonly sample: TrialSample;
  readonly counters: PerfEngineCounters;
  readonly domNodeCount: number;
  readonly unmountMs: number;
  readonly advancedTick: number;
}

interface TrialDeps {
  readonly db: IDBDatabase;
  readonly content: ReturnType<typeof loadPerfContent>;
  readonly container: HTMLElement;
}

async function runTrial(trial: number, warmup: boolean, deps: TrialDeps): Promise<TrialOutcome> {
  const { db, content, container } = deps;

  // === B2 restore: IDB 読出 + JSON.parse + deserialize ====================
  const r0 = performance.now();
  const saveText = await getSaveText(db, PERF_SAVE_KEY);
  const r1 = performance.now();
  const parsed: unknown = JSON.parse(saveText);
  const r2 = performance.now();
  const state: GameState = fromSerializable(parsed);
  const r3 = performance.now();

  // === B1 compute: 72h catch-up ==========================================
  const c0 = performance.now();
  const ctx = createAdvanceContext(state, content);
  const c1 = performance.now();
  const report = advanceWithReport(state, ctx, PERF_TARGET_TICK);
  const advanced = report.state;
  const c2 = performance.now();

  // === B3 hydrate: GameState → 派生値 + ルート vnode ======================
  const h0 = performance.now();
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

  const intervalMs = {
    restore: r3 - r0,
    compute: c2 - c0,
    hydrate: h2 - h0,
    mount: m2 - m0,
  } as const;

  emitMarks("restore", trial, r0, r3);
  emitMarks("compute", trial, c0, c2);
  emitMarks("hydrate", trial, h0, h2);
  emitMarks("mount", trial, m0, m2);

  return {
    sample: {
      trial,
      warmup,
      intervalMs,
      subIntervalMs: {
        "restore.idbGet": r1 - r0,
        "restore.parse": r2 - r1,
        "restore.deserialize": r3 - r2,
        "compute.contextBuild": c1 - c0,
        "compute.advance": c2 - c1,
        "hydrate.viewModel": h1 - h0,
        "hydrate.vnode": h2 - h1,
        "mount.render": m1 - m0,
        "mount.layout": m2 - m1,
      },
    },
    counters: {
      segmentCount: report.segmentCount,
      stochasticStepCount: report.stochasticStepCount,
      stochasticTrialCount: report.stochasticTrialCount,
      rateChangeEventCount: report.rateChangeEventCount,
      recallOccurrenceCount: report.recallOccurrenceCount,
    },
    domNodeCount,
    unmountMs: u1 - u0,
    advancedTick: advanced.tick,
  };
}

/**
 * B2 だけを容量目標付近(≈512KB)の合成セーブで測る(設計文書 §3 B2)。
 * 予算判定には使わない参考値。
 */
async function runSaveSizeSensitivity(
  db: IDBDatabase,
  paddedText: string,
  paddedEntityCount: number,
): Promise<{
  readonly saveBytes: number;
  readonly entityCount: number;
  readonly samples: TrialSample[];
}> {
  await putSaveText(db, PERF_PADDED_SAVE_KEY, paddedText);
  const samples: TrialSample[] = [];
  for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
    const t0 = performance.now();
    const text = await getSaveText(db, PERF_PADDED_SAVE_KEY);
    const t1 = performance.now();
    const parsed: unknown = JSON.parse(text);
    const t2 = performance.now();
    const restored = fromSerializable(parsed);
    const t3 = performance.now();
    if (restored.entityStateById.size !== paddedEntityCount) {
      throw new Error("合成セーブの entity 数が復元後に一致しない");
    }
    samples.push({
      trial: i,
      warmup: i < 0,
      intervalMs: { restore: t3 - t0, compute: 0, hydrate: 0, mount: 0 },
      subIntervalMs: {
        "restore.idbGet": t1 - t0,
        "restore.parse": t2 - t1,
        "restore.deserialize": t3 - t2,
      },
    });
    await yieldToEventLoop();
  }
  return { saveBytes: byteLengthOf(paddedText), entityCount: paddedEntityCount, samples };
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
  const saveText = JSON.stringify(toSerializable(board));
  const b1 = performance.now();

  onStatus("IndexedDB を準備中…");
  const o0 = performance.now();
  const db = await openPerfDb();
  const o1 = performance.now();
  await putSaveText(db, PERF_SAVE_KEY, saveText);
  const o2 = performance.now();

  const deps: TrialDeps = { db, content, container };
  const samples: TrialSample[] = [];
  const unmountValues: number[] = [];
  let counters: PerfEngineCounters | null = null;
  let domNodeCount = 0;

  for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
    onStatus(
      i < 0
        ? "ウォームアップ試行を実行中…"
        : `計測試行 ${String(i + 1)} / ${String(MEASURED_TRIALS)} …`,
    );
    const outcome = await runTrial(i, i < 0, deps);
    samples.push(outcome.sample);
    unmountValues.push(outcome.unmountMs);
    domNodeCount = outcome.domNodeCount;
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

  onStatus("save サイズ感度(≈512KB)を計測中…");
  const paddedBoard = buildPaddedPerfBoard(
    content,
    TARGET_SAVE_BYTES,
    (state) => byteLengthOf(JSON.stringify(toSerializable(state))),
    PERF_WORLD_SEED,
  );
  const paddedText = JSON.stringify(toSerializable(paddedBoard));
  const sensitivityRun = await runSaveSizeSensitivity(
    db,
    paddedText,
    paddedBoard.entityStateById.size,
  );

  const unmountMedian = summarizeInterval(
    unmountValues.map((ms, index) => ({
      trial: index - WARMUP_TRIALS,
      warmup: index < WARMUP_TRIALS,
      intervalMs: { restore: ms, compute: 0, hydrate: 0, mount: 0 },
      subIntervalMs: {},
    })),
    "restore",
  ).medianMs;

  const restoreMedian = summarizeInterval(samples, "restore").medianMs;
  const supplementary: PerfSupplementary = {
    contentLoadMs: l1 - l0,
    contentJsonParseMs: 0,
    boardBuildMs: b1 - b0,
    idbOpenMs: o1 - o0,
    idbPutMs: o2 - o1,
    unmountMedianMs: unmountMedian,
    restoreWithOpenMs: o1 - o0 + restoreMedian,
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
      saveBytes: byteLengthOf(saveText),
      measuredTrials: MEASURED_TRIALS,
      warmupTrials: WARMUP_TRIALS,
    },
    engineCounters: counters,
    samples,
    supplementary,
    sensitivity: {
      restoreAtTargetSaveBytes: {
        saveBytes: sensitivityRun.saveBytes,
        entityCount: sensitivityRun.entityCount,
        summary: summarizeInterval(sensitivityRun.samples, "restore"),
      },
    },
    observedDomNodeCount: domNodeCount,
  });

  // 計測後に格子を残しておく(目視確認用・計測窓の外)。
  const finalCtx = createAdvanceContext(board, content);
  render(h(PerfGrid, { cells: buildGridViewModel(board, content, finalCtx).cells }), container);

  onStatus("完了。");
  return result;
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
  restore: "B2 restore (IDB+parse+deserialize)",
  compute: "B1 compute (72h catch-up)",
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
  const lines = [
    `DOM 要素数: 実測 ${String(result.observed.domNodeCount)} / 期待 ${String(result.workload.expectedDomNodes)}(${result.observed.domNodeCountMatchesExpected ? "一致" : "不一致"})`,
    `engine カウンタ: 粗粒度ステップ ${String(result.engineCounters.stochasticStepCount)} / ベルヌーイ判定 ${String(result.engineCounters.stochasticTrialCount)} / (A)区間 ${String(result.engineCounters.segmentCount)} / 想起困難 ${String(result.engineCounters.recallOccurrenceCount)}`,
    `セーブ: 代表盤面 ${String(result.workload.saveBytes)} B(entity ${String(result.workload.entityCount)})`,
    result.sensitivity.restoreAtTargetSaveBytes === null
      ? "save サイズ感度: 未計測"
      : `save サイズ感度(参考): ${String(result.sensitivity.restoreAtTargetSaveBytes.saveBytes)} B で restore 中央値 ${String(result.sensitivity.restoreAtTargetSaveBytes.summary.medianMs)} ms`,
    `補助: contentLoad ${String(result.supplementary.contentLoadMs.toFixed(3))} ms / idbOpen ${String(result.supplementary.idbOpenMs.toFixed(3))} ms / idbPut ${String(result.supplementary.idbPutMs.toFixed(3))} ms / restore+open ${String(result.supplementary.restoreWithOpenMs.toFixed(3))} ms`,
    `crossOriginIsolated=${String(result.meta.crossOriginIsolated)}(false の Firefox/WebKit では performance.now が 1ms へ丸められる)`,
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

function copyResultJson(textarea: HTMLTextAreaElement, statusEl: HTMLElement): void {
  const done = (msg: string): void => {
    statusEl.textContent = msg;
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
  };
  const text = textarea.value;
  if (navigator.clipboard as unknown) {
    navigator.clipboard.writeText(text).then(
      () => {
        done("コピーしました");
      },
      () => {
        textarea.focus();
        textarea.select();
        done("コピー失敗: テキストエリアを手動で選択してください");
      },
    );
    return;
  }
  textarea.focus();
  textarea.select();
  done("コピー失敗: テキストエリアを手動で選択してください");
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
  const copyStatus = requireElement("copy-status");

  copyButton.addEventListener("click", () => {
    copyResultJson(jsonArea, copyStatus);
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
