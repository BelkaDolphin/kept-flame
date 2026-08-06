// ---------------------------------------------------------------------------
// catch-up オフロードの中核(Worker 非依存の純粋部)— T11 / ADR-019 / ADR-029
// 境界定義の正は `docs/design/perf-boundaries.md` §3 B1 / §7。
//
// `worker.ts`(Worker エントリ)と `workerClient.ts`(メイン側ハンドル)の両方が
// このモジュールを参照する。Worker グローバル(`postMessage` / `addEventListener`)
// にも DOM にも触れないので、**vitest から直接叩ける**のが配置の理由である
// (Worker 実体は Playwright スモークで確認する)。
//
// ===========================================================================
// 1. 二系統の切替点はこのファイルの `CATCH_UP_UPDATE_MODES` ただ 1 箇所
// ===========================================================================
//   ADR-029(1) の核:
//     - catch-up(長期不在復帰)  = Worker-local の**可変ドラフト**を in-place
//       更新し、**完了時に一度だけ**不変スナップショット化してメインへ転送。
//       アロケーションは「ドラフト1個 + 完了時1スナップショット」に圧縮される。
//     - foreground live play(短い差分) = **構造共有**(ADR-028)。
//
//   この 2 系統を型と実装の対で持つのが {@link CATCH_UP_UPDATE_MODES} である。
//   どちらの系統を使うかは {@link chooseCatchUpRoute}(ADR-026(3) の tick 差
//   しきい値)が決める。系統を増減させるときはこの 2 定数だけを触ること。
//
//   **現状 `"mutable-draft"` は未実装で、呼ぶと例外になる。** 理由を正直に書く:
//   可変ドラフトは engine 側に「ドラフト表現 + in-place 更新 API」を足さないと
//   実装できない(`src/engine/scheduler.ts` の runSchedule はイベントごとに
//   新しい GameState を作る構造共有前提であり、platform 層から差し替えられない)。
//   T11 は `src/engine/**` を変更しないタスクなので、切替点と不変条件
//   (= 完了スナップショットは 1 回だけ)を先に固定し、engine 側の draft API が
//   入った時点でこの 1 箇所を埋める。**予算判定に使う数値は現行の
//   `"structural-sharing"` 実測**であり、可変ドラフト導入後は B1 が下がる
//   (= 現在値は上限側の見積り)。
//
// ===========================================================================
// 2. 「完了時に 1 回だけスナップショット」は境界の不変条件である
// ===========================================================================
//   {@link createWorkerSession} は 1 リクエストにつき **ちょうど 1 通**の
//   完了メッセージしか出さない(途中経過の state を投げない)。これが
//   ADR-029(1) の「完了時に一度だけ転送」に対応する platform 側の保証であり、
//   `tests/platform/catchUp.test.ts` が post 回数で固定している。
//
// ===========================================================================
// 3. 時刻の扱い(perf-boundaries §7-1)
// ===========================================================================
//   Worker の `performance.now()` は**そのワーカ固有の timeOrigin** を基準に
//   するので、メインで取った時刻と引き算してはならない。本モジュールが外へ
//   出すのは**継続時間(ms)だけ**であり、絶対時刻は 1 つも渡さない。
// ---------------------------------------------------------------------------

import { advanceWithReport, createAdvanceContext } from "../engine/advance";
import type { Fix } from "../engine/fp";
import type { AdvanceContext, EngineContent } from "../engine/rules/types";
import type { ScheduleReport } from "../engine/scheduler";
import type { EntityId, GameState } from "../engine/state/state";

/** catch-up 経路の失敗(未実装の系統・壊れたメッセージ・不変条件違反)。 */
export class CatchUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatchUpError";
  }
}

// --- 1. 経路の選択(ADR-026(3)) -------------------------------------------

/**
 * メインスレッド同期 advance のままでよい tick 差の上限(ADR-026(3):
 * 「目安 ≤600 tick = 粗粒度60 step 以下」)。これを**超えたら** Worker へ委譲する。
 */
export const LIVE_ADVANCE_MAX_TICK_DELTA = 600;

/**
 * 進める経路。名前に更新方式まで入れてあるのは、経路と方式が 1 対 1 で
 * 対応している(§1)ことをコード上で読めるようにするため。
 */
export type CatchUpRoute = "main-structural-sharing" | "worker-draft-snapshot";

/**
 * tick 差から経路を決める(ADR-026(3))。
 *
 * @throws {CatchUpError} tick 差が負 / 非整数の場合(巻戻し検知は platform の
 *   別責務であり、ここへ負値が来るのは呼び出し側のバグ)
 */
export function chooseCatchUpRoute(tickDelta: number): CatchUpRoute {
  if (!Number.isSafeInteger(tickDelta) || tickDelta < 0) {
    throw new CatchUpError(
      `chooseCatchUpRoute: tick 差 ${String(tickDelta)} が 0 以上の整数でない`,
    );
  }
  return tickDelta <= LIVE_ADVANCE_MAX_TICK_DELTA
    ? "main-structural-sharing"
    : "worker-draft-snapshot";
}

// --- 2. 二系統の切替点(ADR-029(1)) ---------------------------------------

/** state 更新方式。§1 のとおりこの union が二系統そのもの。 */
export type StateUpdateStrategy = "mutable-draft" | "structural-sharing";

/**
 * 1 系統ぶんの実装。`advance` が「進める」、`snapshot` が「メインへ渡せる
 * 不変スナップショットにする」。構造共有系では state が最初から不変なので
 * `snapshot` は検証だけ(コピーしない)、可変ドラフト系では**ここが唯一の
 * コピー地点**になる。
 */
export interface CatchUpUpdateMode {
  readonly id: StateUpdateStrategy;
  /**
   * 半開区間 [state.tick, toTick) を進める。コンテキスト構築(engine 共通の
   * precompute)は系統に依らないので {@link runCatchUp} 側で済ませ、ここには
   * 「ループをどう回すか」= 系統差そのものだけを残す。
   */
  readonly advance: (state: GameState, ctx: AdvanceContext, toTick: number) => ScheduleReport;
  readonly snapshot: (state: GameState) => GameState;
}

/**
 * スナップショットの不変条件を検査する(state.ts の不変条件 (a)(b))。
 *
 * 可変ドラフト系を入れたときに「in-place 更新で正準順が壊れたドラフトを
 * そのままメインへ渡す」事故を止めるための検出器であり、構造共有系でも同じ
 * 検査を通す(検査の有無で系統差が出ないようにするため)。entity 数は
 * 高々 100 オーダーなので O(n) 検査のコストは B1 に対して無視できる。
 *
 * @throws {CatchUpError} キーと id の食い違い / 正準順(ID 昇順)違反
 */
export function assertCanonicalSnapshot(state: GameState): void {
  let previous: EntityId | null = null;
  for (const [id, entity] of state.entityStateById) {
    if (entity.id !== id) {
      throw new CatchUpError(
        `スナップショット不変条件違反: キー "${id}" と id "${entity.id}" が食い違う`,
      );
    }
    if (previous !== null && !(previous < id)) {
      throw new CatchUpError(
        `スナップショット不変条件違反: entityStateById が ID 昇順でない("${previous}" の後に "${id}")`,
      );
    }
    previous = id;
  }
}

/**
 * 構造共有系(ADR-028)。engine の純関数をそのまま呼ぶ。
 * foreground live play の正規経路であり、可変ドラフトが入るまでは
 * catch-up もこれを使う(§1)。
 */
const STRUCTURAL_SHARING_MODE: CatchUpUpdateMode = {
  id: "structural-sharing",
  advance: (state, ctx, toTick) => advanceWithReport(state, ctx, toTick),
  snapshot: (state) => {
    // 既に不変。コピーせず不変条件だけ確認して同一参照を返す。
    assertCanonicalSnapshot(state);
    return state;
  },
};

/**
 * 可変ドラフト系(ADR-029(1))。**未実装**。
 * 埋めるには engine 側にドラフト表現と in-place 更新 API が要る(§1)。
 */
const MUTABLE_DRAFT_MODE: CatchUpUpdateMode = {
  id: "mutable-draft",
  advance: () => {
    throw new CatchUpError(
      "可変ドラフト系(ADR-029(1))は未実装。engine 側に「ドラフト表現 + in-place 更新 API」" +
        "を足す必要があり、T11(src/engine/** 変更禁止)のスコープ外。" +
        "実装するときは src/platform/catchUp.ts の CATCH_UP_UPDATE_MODES のこの 1 箇所を埋める。",
    );
  },
  snapshot: (state) => {
    // 可変ドラフト系ではここが「ドラフト → 不変スナップショット」の唯一の
    // コピー地点になる(完了時 1 回だけ・ADR-029(1))。
    assertCanonicalSnapshot(state);
    return state;
  },
};

/** **二系統の切替点はここ 1 箇所**(§1)。 */
export const CATCH_UP_UPDATE_MODES: { readonly [K in StateUpdateStrategy]: CatchUpUpdateMode } = {
  "structural-sharing": STRUCTURAL_SHARING_MODE,
  "mutable-draft": MUTABLE_DRAFT_MODE,
};

/**
 * Worker 内で実際に使う系統。可変ドラフトの engine 側 API が入ったら
 * `"mutable-draft"` へ倒す(そのときは B1 の実測値を取り直すこと)。
 */
export const ACTIVE_CATCH_UP_STRATEGY: StateUpdateStrategy = "structural-sharing";

// --- 3. catch-up 本体 ------------------------------------------------------

/** Worker 内で測った内訳(継続時間のみ・§3)。 */
export interface CatchUpPhaseMs {
  /** `createAdvanceContext`(隣接乗数の precompute)。B1 の内側(§7-5)。 */
  readonly contextBuildMs: number;
  /** 離散事象ループ本体。 */
  readonly advanceMs: number;
  /** ドラフト → 不変スナップショット化(構造共有系では検証のみ)。 */
  readonly snapshotMs: number;
}

/** engine の自己申告カウンタ(ワークロードが設計どおりかの検証用)。 */
export interface CatchUpCounters {
  readonly segmentCount: number;
  readonly stochasticStepCount: number;
  readonly stochasticTrialCount: number;
  readonly rateChangeEventCount: number;
  readonly recallOccurrenceCount: number;
  /**
   * [M73/R8-05] 不在中に解決した襲撃の回数(GDD 11.7 段10)。ワークロード検証では
   * なく **UI の通知**のために返す —— 襲撃は撃退でも略奪でも完全に無音で、
   * 在庫が黙って減るだけだった(Round 8 実測)。前景の tick は
   * `advanceWithReport` から同じ 2 本を取れるが、Worker catch-up の
   * `ScheduleReport` は Worker 内にしか無いのでここへ載せて渡す。
   */
  readonly raidCount: number;
  /** [M73/R8-05] うち撃退できた回数。 */
  readonly raidRepelledCount: number;
}

/**
 * `AdvanceContext` のうち**メインへ返す部分**。`content` は既にメイン側にあるので
 * 積まない(積むと catch-up のたびに content を転送することになり ADR-029(1) の
 * 「content は 1 回だけ」に反する)。
 *
 * なぜ返す必要があるのか: 隣接乗数 `multiplierByFacilityId` は UI の表示値でも
 * ある。これを返さないとメイン側が B3(ハイドレーション)で
 * `createAdvanceContext` を呼び直すことになり、perf-boundaries §3 B3 の
 * 「B3 は engine の再計算を含まない」に反する。Worker が計算済みの値を
 * 完了スナップショットと一緒に 1 回で渡すのが境界どおりの形。
 *
 * 施設の配置・Lv・就労割当は advance 中に変わらない(rules/types.ts §5 の前提)
 * ので、advance 前に作ったこの値は advance 後の state に対しても有効である。
 */
export interface TransferableAdvanceContext {
  readonly worldSeedU32: number;
  readonly multiplierByFacilityId: ReadonlyMap<EntityId, Fix>;
}

/** 転送されてきた部分と手元の content から `AdvanceContext` を組み直す(計算はしない)。 */
export function restoreAdvanceContext(
  content: EngineContent,
  transferred: TransferableAdvanceContext,
): AdvanceContext {
  return {
    content,
    worldSeedU32: transferred.worldSeedU32,
    multiplierByFacilityId: transferred.multiplierByFacilityId,
  };
}

export interface CatchUpOutcome {
  readonly snapshot: GameState;
  readonly advanceContext: TransferableAdvanceContext;
  readonly strategy: StateUpdateStrategy;
  readonly phaseMs: CatchUpPhaseMs;
  readonly counters: CatchUpCounters;
}

/**
 * 目標 tick まで進めて、メインへ渡せる不変スナップショットを 1 つ作る。
 *
 * `createAdvanceContext` はこの関数の**内側**で呼ぶ(perf-boundaries §7-5:
 * B1 の内側 = Worker 側で実行する)。
 *
 * @throws {CatchUpError} 未実装の系統 / スナップショット不変条件違反
 * @throws {SchedulerError} 目標 tick が現在 tick より小さい場合
 */
export function runCatchUp(
  state: GameState,
  content: EngineContent,
  targetTick: number,
  strategy: StateUpdateStrategy = ACTIVE_CATCH_UP_STRATEGY,
): CatchUpOutcome {
  const mode = CATCH_UP_UPDATE_MODES[strategy];
  const t0 = performance.now();
  const context = createAdvanceContext(state, content);
  const t1 = performance.now();
  const report = mode.advance(state, context, targetTick);
  const t2 = performance.now();
  const snapshot = mode.snapshot(report.state);
  const t3 = performance.now();

  return {
    snapshot,
    advanceContext: {
      worldSeedU32: context.worldSeedU32,
      multiplierByFacilityId: context.multiplierByFacilityId,
    },
    strategy: mode.id,
    phaseMs: { contextBuildMs: t1 - t0, advanceMs: t2 - t1, snapshotMs: t3 - t2 },
    counters: {
      segmentCount: report.segmentCount,
      stochasticStepCount: report.stochasticStepCount,
      stochasticTrialCount: report.stochasticTrialCount,
      rateChangeEventCount: report.rateChangeEventCount,
      recallOccurrenceCount: report.recallOccurrenceCount,
      raidCount: report.raidCount,
      raidRepelledCount: report.raidRepelledCount,
    },
  };
}

// --- 4. メッセージ規約 -----------------------------------------------------
//
// content は初期化時に 1 回だけ転送する(ADR-029(1))。catch-up 要求のたびに
// content を積むと、structured clone のコストが毎回 B1 に乗ってしまう。
// `EngineContent` は Map / プレーンオブジェクト / 数値 / 文字列だけで構成
// されるので構造化複製できる(関数を持たない = rules/types.ts の型定義どおり)。

export const CATCH_UP_PROTOCOL_VERSION = 1;

/** メイン → Worker。 */
export type MainToWorkerMessage =
  | {
      readonly kind: "catchUp";
      readonly requestId: number;
      /** 復元済み state(構造化複製で Map ごと渡る)。 */
      readonly state: GameState;
      readonly targetTick: number;
      readonly strategy: StateUpdateStrategy;
    }
  | { readonly kind: "init"; readonly content: EngineContent };

/** Worker → メイン。 */
export type WorkerToMainMessage =
  | {
      readonly kind: "done";
      readonly requestId: number;
      readonly snapshot: GameState;
      /** UI が表示に使う隣接乗数など(§3 の TransferableAdvanceContext)。 */
      readonly advanceContext: TransferableAdvanceContext;
      readonly strategy: StateUpdateStrategy;
      readonly phaseMs: CatchUpPhaseMs;
      /** メッセージ受領〜postMessage 直前までの Worker 内総時間(§3)。 */
      readonly handlerMs: number;
      readonly counters: CatchUpCounters;
    }
  | { readonly kind: "booted"; readonly protocolVersion: number }
  | { readonly kind: "failed"; readonly requestId: number | null; readonly message: string }
  | { readonly kind: "ready" };

function messageKindOf(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `<${value === null ? "null" : typeof value}>`;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "<kind 無し>";
}

/**
 * 構造化複製で渡ってきた値が EngineContent の形をしているかを確認する。
 *
 * ここは**同一アプリ内**の境界(自分のメインスレッドが送ったもの)であり、
 * セーブのような外来データの入口ではない。よって serialize.ts のような全項目
 * 検証はせず、「clone で Map が Map のまま渡ったか」「content 未転送のまま
 * catch-up が来ていないか」を捕まえる最小限の形検査に留める。
 *
 * @throws {CatchUpError} 形が違う場合
 */
function requireEngineContent(value: unknown): EngineContent {
  const o = value as Partial<EngineContent> | null | undefined;
  if (
    o === null ||
    o === undefined ||
    !(o.facilityDefs instanceof Map) ||
    !(o.techDefs instanceof Map) ||
    typeof o.coarseTickMinutes !== "number"
  ) {
    throw new CatchUpError(
      "init メッセージの content が EngineContent の形をしていない(構造化複製の破損か送信側のバグ)",
    );
  }
  return o as EngineContent;
}

// --- 5. Worker セッション(メッセージ処理の純粋部) ------------------------

/**
 * Worker 側の状態機械。`post` を注入するので Worker グローバルに依存せず、
 * vitest から「1 リクエスト = 完了メッセージ 1 通」(§2)を検査できる。
 */
export interface WorkerSession {
  /** 1 メッセージを処理する。例外は投げず `failed` を post する。 */
  handle(data: unknown): void;
  /** content を受け取り済みか(テスト・診断用)。 */
  isInitialized(): boolean;
}

export function createWorkerSession(post: (message: WorkerToMainMessage) => void): WorkerSession {
  let content: EngineContent | null = null;

  const handleCatchUp = (message: Extract<MainToWorkerMessage, { kind: "catchUp" }>): void => {
    const t0 = performance.now();
    if (content === null) {
      post({
        kind: "failed",
        requestId: message.requestId,
        message: "init(content 1回転送)より先に catchUp が来た",
      });
      return;
    }
    const outcome = runCatchUp(message.state, content, message.targetTick, message.strategy);
    const handlerMs = performance.now() - t0;
    // ここが「完了時に一度だけ」の転送(§2 / ADR-029(1))。
    post({
      kind: "done",
      requestId: message.requestId,
      snapshot: outcome.snapshot,
      advanceContext: outcome.advanceContext,
      strategy: outcome.strategy,
      phaseMs: outcome.phaseMs,
      handlerMs,
      counters: outcome.counters,
    });
  };

  return {
    isInitialized: () => content !== null,
    handle: (data: unknown): void => {
      const kind = messageKindOf(data);
      let requestId: number | null = null;
      try {
        if (kind === "init") {
          content = requireEngineContent(
            (data as Extract<MainToWorkerMessage, { kind: "init" }>).content,
          );
          post({ kind: "ready" });
          return;
        }
        if (kind === "catchUp") {
          const message = data as Extract<MainToWorkerMessage, { kind: "catchUp" }>;
          requestId = message.requestId;
          handleCatchUp(message);
          return;
        }
        throw new CatchUpError(`未知のメッセージ種別 ${kind}`);
      } catch (error: unknown) {
        post({
          kind: "failed",
          requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
