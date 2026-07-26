// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- sim ランナー — 先行計測計画 §2.1 P2 / ADR-014
//
// 1 run = 夜間 sim 相当: 縮約盤面(sim/board.ts)を、代表 bot(sim/bots/)の
// 決定論的な状態操作を挟みながら一定 tick 数まで advance する。
//
// 決定論の境界: run の**結果**(state / カウンタ)は worldSeed と content と
// bot 列だけで決まる。`performance.now()` は実時間計測のメタデータとしてのみ
// 使い(T9 指示書で明示的に許可)、Math.random/Date.now は一切使わない
// (elapsedMs 以外は毎回ビット同一)。
//
// bot は施設の配置(cellIndex/defId)を変えない前提(sim/bots/*.ts 参照)。
// 配置は advance の間ずっと不変なので、AdvanceContext(隣接乗数の precompute・
// rules/types.ts §5)は run 全体で 1 個を使い回せる。
// ---------------------------------------------------------------------------

import { advanceWithReport } from "../src/engine/advance";
import type { AdvanceContext, EngineContent } from "../src/engine/rules/types";
import type { GameState } from "../src/engine/state/state";

import { countersOfReport, sumCounters, type GoldenCounters } from "../conformance/goldenVector";

/**
 * 計測用ダミー bot 1 本。`intervalTicks` ごとに `apply` を tick の絶対グリッド
 * (state.tick 起点でなく tick の絶対値・stochastic.ts の粗粒度ステップと同じ思想)
 * 上で呼ぶ。
 */
export interface SimBot {
  readonly id: string;
  /** 発火間隔(tick)。1 以上の整数。 */
  readonly intervalTicks: number;
  /**
   * `state` を決定論的に変える純関数。同じ引数なら常に同じ結果を返すこと
   * (worldSeedU32/tick 以外の非決定な入力を混ぜない)。施設の配置
   * (cellIndex/defId)は変えないこと(変えるなら呼び出し側で advance context を
   * 作り直す必要がある・rules/types.ts §5)。
   */
  readonly apply: (
    state: GameState,
    content: EngineContent,
    worldSeedU32: number,
    tick: number,
  ) => GameState;
}

export interface RunNightSimOptions {
  /** この run が進める tick 数(coarseTickMinutes に関わらず絶対 tick 数で指定)。 */
  readonly totalTicks: number;
  /** 適用する bot 列(既定は空 = bot 無し)。 */
  readonly bots?: readonly SimBot[];
}

export interface RunNightSimResult {
  readonly state: GameState;
  readonly counters: GoldenCounters;
  /** 実行時間(ms)。`performance.now()` の差分。計測メタとしてのみ使う。 */
  readonly elapsedMs: number;
}

/** `tick` より真に大きい、`intervalTicks` の倍数のうち最小のもの(絶対グリッド)。 */
function nextMultipleStrictlyAfter(tick: number, intervalTicks: number): number {
  const rem = tick % intervalTicks;
  return rem === 0 ? tick + intervalTicks : tick + (intervalTicks - rem);
}

/**
 * 1 run 実行する(計測 #3/#4/#5 共通ハーネス)。
 *
 * bot が無ければ 1 回の `advanceWithReport` だけで済ませる(ADR-014 の
 * 「1 run」の形そのまま)。bot があれば各 bot の `intervalTicks` の境界で
 * advance を区切り、その都度 bot を適用する。
 */
export function runNightSim(
  content: EngineContent,
  initialState: GameState,
  ctx: AdvanceContext,
  options: RunNightSimOptions,
): RunNightSimResult {
  const bots = options.bots ?? [];
  const targetTick = initialState.tick + options.totalTicks;
  const worldSeedU32 = ctx.worldSeedU32;

  const start = performance.now();
  let state = initialState;
  const counterList: GoldenCounters[] = [];

  if (bots.length === 0) {
    const report = advanceWithReport(state, ctx, targetTick);
    counterList.push(countersOfReport(report));
    state = report.state;
  } else {
    let cursor = state.tick;
    while (cursor < targetTick) {
      let boundary = targetTick;
      for (const bot of bots) {
        const candidate = nextMultipleStrictlyAfter(cursor, bot.intervalTicks);
        if (candidate < boundary) boundary = candidate;
      }

      const report = advanceWithReport(state, ctx, boundary);
      counterList.push(countersOfReport(report));
      state = report.state;
      cursor = boundary;

      if (cursor >= targetTick) break;
      for (const bot of bots) {
        if (cursor % bot.intervalTicks === 0) {
          state = bot.apply(state, content, worldSeedU32, cursor);
        }
      }
    }
  }

  const elapsedMs = performance.now() - start;
  return { state, counters: sumCounters(counterList), elapsedMs };
}
