// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- sim 校正 — ADR-014 / 先行計測計画 §5.2 #3・#4
//
// runner.ts の 1 run(縮約盤面・20人×3tech・代表 bot 込み)を複数 seed で
// 実行し、ウォームアップを除いた実測 sec/run の中央値から
//
//   shards = min(20, ceil(totalRuns × measuredSecPerRun / targetGoalSec))
//
// で週次/夜間のシャード数を導出する(ADR-014(1))。`targetGoalSec` は
// 「目標 <30分」の 30 分そのもの(計画書 §5.2 #3 の判断基準)。360分キャップは
// 導出式には使わず、導出結果(predictedWallClockSec)が守れているかの
// 別判定として扱う(ADR-014 の「シャード最大20 + Fallback で再校正」の趣旨に
// 沿い、達成できなければ Fallback 発動を促す情報として報告する)。
//
// #4(1分tick Fallback)は同一ハーネスに coarseTickMinutes=1 の content patch を
// 渡すだけで再校正できる(ADR-014(3))。1 run の tick 幅(RUN_TOTAL_TICKS)は
// 粒度に関わらず固定するので、1分tick 化で (C) の粗粒度ステップ数だけが
// ちょうど10倍になる(計画書 §5.2 #4 の「step 数10倍化」の実装)。
//
// 実行: node --experimental-strip-types --import ./tools/tsLoaderRegister.mjs
//   sim/calibrate.ts
// ---------------------------------------------------------------------------

import { createAdvanceContext } from "../src/engine/advance";

import { buildPatternBoard, patchCoarseTickMinutes, resolveSimContent } from "./board";
import { dispatchBot } from "./bots/dispatchBot";
import { reassignmentBot } from "./bots/reassignmentBot";
import { isMainModule, writeJsonReport } from "./cliUtil";
import { runNightSim, type SimBot } from "./runner";
import { ADVERSARIAL_BOTS, runAdversarialBotAsNewGame } from "./strategy/adversarialBots";
import { STRATEGY_BOTS } from "./strategy/bots";
import { runStrategyBot } from "./strategy/runStrategy";

/** ADR-014: 1 run = 2,304 粗粒度ステップ(10分粒度)。 */
const RUN_COARSE_STEPS = 2304;
const BASELINE_COARSE_TICK_MINUTES = 10;
/**
 * 1 run が進める絶対 tick 数。coarseTickMinutes に関わらず**固定**する
 * (= 23,040 tick = 16 ゲーム日相当)。Fallback(#4)で 1分tick にしても
 * 同じ実時間幅を進め、(C) の粗粒度ステップ数だけが 10 倍化する設計
 * (計画書 §5.2 #4)。
 */
const RUN_TOTAL_TICKS = RUN_COARSE_STEPS * BASELINE_COARSE_TICK_MINUTES;

const WEEKLY_TOTAL_RUNS = 11000;
const NIGHTLY_TOTAL_RUNS = 2200;
const MAX_SHARDS = 20;
const TARGET_GOAL_SEC = 30 * 60;
const TARGET_CAP_SEC = 360 * 60;

const DEFAULT_WARMUP_RUNS = 2;
const DEFAULT_MEASURED_RUNS = 5;

export interface CalibrationRunSample {
  readonly seed: string;
  readonly elapsedMs: number;
}

export interface ShardPlan {
  readonly totalRuns: number;
  readonly shards: number;
  readonly runsPerShard: number;
  readonly predictedWallClockSec: number;
  /** 目標 <30分(計画書 §5.2 #3)を満たすか。 */
  readonly meetsGoal: boolean;
  /** 360分キャップ(ADR-014)を満たすか。 */
  readonly withinCap: boolean;
}

export interface CalibrationReport {
  readonly label: string;
  readonly coarseTickMinutes: number;
  readonly totalTicksPerRun: number;
  readonly warmup: readonly CalibrationRunSample[];
  readonly measured: readonly CalibrationRunSample[];
  readonly measuredSecPerRun: number;
  readonly weekly: ShardPlan;
  readonly nightly: ShardPlan;
}

/** 中央値(偶数個は中央2件の平均)。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median: 空配列(measuredRuns が 0 件になっている)");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const value = sorted[mid];
    if (value === undefined) throw new Error("median: 内部不整合");
    return value;
  }
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower === undefined || upper === undefined) throw new Error("median: 内部不整合");
  return (lower + upper) / 2;
}

/** ADR-014(1) のシャード導出式。 */
export function deriveShardPlan(totalRuns: number, measuredSecPerRun: number): ShardPlan {
  const totalWorkSec = totalRuns * measuredSecPerRun;
  const shards = Math.min(MAX_SHARDS, Math.max(1, Math.ceil(totalWorkSec / TARGET_GOAL_SEC)));
  const runsPerShard = Math.ceil(totalRuns / shards);
  const predictedWallClockSec = runsPerShard * measuredSecPerRun;
  return {
    totalRuns,
    shards,
    runsPerShard,
    predictedWallClockSec,
    meetsGoal: predictedWallClockSec <= TARGET_GOAL_SEC,
    withinCap: predictedWallClockSec <= TARGET_CAP_SEC,
  };
}

function defaultSeeds(count: number, prefix: string): readonly string[] {
  const seeds: string[] = [];
  for (let i = 0; i < count; i++) seeds.push(`${prefix}-${String(i)}`);
  return seeds;
}

export interface RunCalibrationParams {
  readonly label: string;
  readonly coarseTickMinutes: number;
  readonly warmupRuns?: number;
  readonly measuredRuns?: number;
  readonly seeds?: readonly string[];
  readonly bots?: readonly SimBot[];
}

/**
 * #3(coarseTickMinutes=10・既定)/ #4(coarseTickMinutes=1・Fallback)共通の
 * 校正ハーネス。bot 込みで測るのが既定(夜間 sim の代表負荷込みの実測・
 * MEMORY.md T5 の「botロジック込みの本計測はT9」に対する回答)。
 */
export function runCalibration(params: RunCalibrationParams): CalibrationReport {
  const warmupRuns = params.warmupRuns ?? DEFAULT_WARMUP_RUNS;
  const measuredRunsCount = params.measuredRuns ?? DEFAULT_MEASURED_RUNS;
  const seeds =
    params.seeds ?? defaultSeeds(warmupRuns + measuredRunsCount, `calibrate-${params.label}`);
  if (seeds.length < warmupRuns + measuredRunsCount) {
    throw new Error("runCalibration: seeds が warmup+measured の合計より少ない");
  }
  const bots = params.bots ?? [reassignmentBot, dispatchBot];

  const content =
    params.coarseTickMinutes === BASELINE_COARSE_TICK_MINUTES
      ? resolveSimContent()
      : resolveSimContent(patchCoarseTickMinutes(params.coarseTickMinutes));

  const samples: CalibrationRunSample[] = [];
  for (const seed of seeds) {
    const initialState = buildPatternBoard(seed, content);
    const ctx = createAdvanceContext(initialState, content);
    const result = runNightSim(content, initialState, ctx, { totalTicks: RUN_TOTAL_TICKS, bots });
    samples.push({ seed, elapsedMs: result.elapsedMs });
  }

  const warmup = samples.slice(0, warmupRuns);
  const measured = samples.slice(warmupRuns, warmupRuns + measuredRunsCount);
  const measuredSecPerRun = median(measured.map((s) => s.elapsedMs)) / 1000;

  return {
    label: params.label,
    coarseTickMinutes: params.coarseTickMinutes,
    totalTicksPerRun: RUN_TOTAL_TICKS,
    warmup,
    measured,
    measuredSecPerRun,
    weekly: deriveShardPlan(WEEKLY_TOTAL_RUNS, measuredSecPerRun),
    nightly: deriveShardPlan(NIGHTLY_TOTAL_RUNS, measuredSecPerRun),
  };
}

// --- [M38] bot 最大11本での再校正(ADR-014(3) / summary.md §2.1) --------------
//
// 先行計測 #3/#4(上の baseline/fallback)は **bot 2 本**(sim/bots/ の
// reassignmentBot / dispatchBot)で測った値であり、`docs/measurements/summary.md`
// §2.1 が「MVP の 5戦略 + 敵対 6種 = 最大 11 本になった時点で
// `measuredSecPerRun` は再校正が必要(ADR-014(3))。現在の余裕(29.8%)は bot 数の
// 増加を吸収できる幅として十分だが、**再校正の義務は消えない**」と明記している。
// その義務をここで果たす。
//
// 「1 run」の定義: **1 bot が 1 ゲームを `RUN_TOTAL_TICKS` ぶん遊ぶ**。
// baseline/fallback の 1 run(縮約20人盤面を bot 2 本込みで進める)とは盤面も
// 中身も違うので、同じ tick 幅(23,040 tick = 16 ゲーム日)を使って**比較可能**に
// してある。夜間 2200 runs / 週次 11000 runs の「run」はこの単位で数える。

/** [M38] bot 1 本ぶんの校正サンプル。 */
export interface BotSuiteSample {
  readonly botId: string;
  readonly kind: "strategy" | "adversarial";
  readonly seed: string;
  readonly elapsedMs: number;
}

export interface BotSuiteCalibrationReport {
  readonly label: string;
  readonly botCount: number;
  readonly totalTicksPerRun: number;
  readonly coarseTickMinutes: number;
  readonly samples: readonly BotSuiteSample[];
  /** 全サンプルの中央値(秒)。 */
  readonly measuredSecPerRun: number;
  /** 最も遅かった bot(最悪ケースの目安)。 */
  readonly slowestBotId: string;
  readonly slowestSecPerRun: number;
  readonly weekly: ShardPlan;
  readonly nightly: ShardPlan;
  /** 最悪 bot だけで週次を回した場合の悲観見積り。 */
  readonly weeklyWorstCase: ShardPlan;
}

export interface BotSuiteCalibrationParams {
  readonly seeds?: readonly string[];
  readonly totalTicks?: number;
}

/** [M38] 5戦略bot + 敵対bot6種(= 最大11本)での `measuredSecPerRun` 再校正。 */
export function runBotSuiteCalibration(
  params: BotSuiteCalibrationParams = {},
): BotSuiteCalibrationReport {
  const seeds = params.seeds ?? ["calibrate-bots11-a", "calibrate-bots11-b"];
  const totalTicks = params.totalTicks ?? RUN_TOTAL_TICKS;

  // ウォームアップ(V8 の JIT・content ロードのコストを測定値へ混ぜない)。
  const warmupBot = STRATEGY_BOTS[0];
  if (warmupBot !== undefined) {
    runStrategyBot({ bot: warmupBot, totalTicks, worldSeed: "calibrate-bots11-warmup" });
  }
  const warmupAdversarial = ADVERSARIAL_BOTS[0];
  if (warmupAdversarial !== undefined) {
    runAdversarialBotAsNewGame(warmupAdversarial, totalTicks, "calibrate-bots11-warmup");
  }

  const samples: BotSuiteSample[] = [];
  for (const seed of seeds) {
    for (const bot of STRATEGY_BOTS) {
      const result = runStrategyBot({ bot, totalTicks, worldSeed: seed });
      samples.push({ botId: bot.id, kind: "strategy", seed, elapsedMs: result.elapsedMs });
    }
    for (const bot of ADVERSARIAL_BOTS) {
      const start = performance.now();
      runAdversarialBotAsNewGame(bot, totalTicks, seed);
      samples.push({
        botId: bot.id,
        kind: "adversarial",
        seed,
        elapsedMs: performance.now() - start,
      });
    }
  }

  const measuredSecPerRun = median(samples.map((s) => s.elapsedMs)) / 1000;

  let slowestBotId = "(なし)";
  let slowestMs = 0;
  for (const sample of samples) {
    if (sample.elapsedMs > slowestMs) {
      slowestMs = sample.elapsedMs;
      slowestBotId = sample.botId;
    }
  }
  const slowestSecPerRun = slowestMs / 1000;

  return {
    label: "bots11-strategy5-plus-adversarial6",
    botCount: STRATEGY_BOTS.length + ADVERSARIAL_BOTS.length,
    totalTicksPerRun: totalTicks,
    coarseTickMinutes: BASELINE_COARSE_TICK_MINUTES,
    samples,
    measuredSecPerRun,
    slowestBotId,
    slowestSecPerRun,
    weekly: deriveShardPlan(WEEKLY_TOTAL_RUNS, measuredSecPerRun),
    nightly: deriveShardPlan(NIGHTLY_TOTAL_RUNS, measuredSecPerRun),
    weeklyWorstCase: deriveShardPlan(WEEKLY_TOTAL_RUNS, slowestSecPerRun),
  };
}

// --- CLI ---------------------------------------------------------------------

function printReport(report: CalibrationReport): void {
  console.log(`\n=== ${report.label}(coarseTickMinutes=${String(report.coarseTickMinutes)}) ===`);
  console.log(
    `1 run = ${String(report.totalTicksPerRun)} tick` +
      `(${String(report.totalTicksPerRun / report.coarseTickMinutes)} 粗粒度ステップ)`,
  );
  console.table(report.measured.map((s) => ({ seed: s.seed, elapsedMs: s.elapsedMs.toFixed(2) })));
  console.log(
    `measuredSecPerRun(中央値, warmup ${String(report.warmup.length)} 件除外) = ` +
      `${report.measuredSecPerRun.toFixed(4)} s`,
  );
  for (const [name, plan] of [
    ["weekly(11000 runs)", report.weekly],
    ["nightly(2200 runs)", report.nightly],
  ] as const) {
    console.log(
      `  ${name}: shards=${String(plan.shards)} runsPerShard=${String(plan.runsPerShard)} ` +
        `predictedWallClock=${(plan.predictedWallClockSec / 60).toFixed(1)}min ` +
        `目標<30min:${plan.meetsGoal ? "OK" : "NG"} 360minキャップ:${plan.withinCap ? "OK" : "NG"}`,
    );
  }
}

function printBotSuiteReport(report: BotSuiteCalibrationReport): void {
  console.log(`
=== ${report.label}(bot ${String(report.botCount)} 本・[M38] 再校正) ===`);
  console.log(
    `1 run = ${String(report.totalTicksPerRun)} tick` +
      `(${String(report.totalTicksPerRun / report.coarseTickMinutes)} 粗粒度ステップ)`,
  );
  console.table(
    report.samples.map((s) => ({
      bot: s.botId,
      kind: s.kind,
      seed: s.seed,
      elapsedMs: s.elapsedMs.toFixed(2),
    })),
  );
  console.log(
    `measuredSecPerRun(全 ${String(report.samples.length)} サンプルの中央値) = ` +
      `${report.measuredSecPerRun.toFixed(4)} s / 最遅 ${report.slowestBotId} = ` +
      `${report.slowestSecPerRun.toFixed(4)} s`,
  );
  for (const [name, plan] of [
    ["weekly(11000 runs・中央値)", report.weekly],
    ["weekly(11000 runs・最遅bot悲観)", report.weeklyWorstCase],
    ["nightly(2200 runs・中央値)", report.nightly],
  ] as const) {
    console.log(
      `  ${name}: shards=${String(plan.shards)} runsPerShard=${String(plan.runsPerShard)} ` +
        `predictedWallClock=${(plan.predictedWallClockSec / 60).toFixed(1)}min ` +
        `目標<30min:${plan.meetsGoal ? "OK" : "NG"} 360minキャップ:${plan.withinCap ? "OK" : "NG"}`,
    );
  }
}

async function main(): Promise<void> {
  const baseline = runCalibration({ label: "baseline-10min", coarseTickMinutes: 10 });
  const fallback = runCalibration({ label: "fallback-1min", coarseTickMinutes: 1 });
  const bots11 = runBotSuiteCalibration();

  printReport(baseline);
  printReport(fallback);
  printBotSuiteReport(bots11);

  console.log(
    "\n注意: ローカル実測(このマシン)は GitHub Actions runner より速く出る可能性が高い" +
      "(上振れ)。本判定は Actions 実機での再計測が必要(ADR-014・先行計測計画 §5.1 と同種の注意)。",
  );

  await writeJsonReport("sim/output/calibrate-report.json", { baseline, fallback, bots11 });
}

if (isMainModule(import.meta.url)) {
  await main();
}
