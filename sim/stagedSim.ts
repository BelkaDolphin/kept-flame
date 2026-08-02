// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 段階的 sim 1000 回 — M38 / ADR-015 正準順序 4/10 / GDD 12.4
//
// ===========================================================================
// 0. 何のためのゲートか
// ===========================================================================
//   ADR-015(2) の正準パイプライン 4 段目「段階 sim1000」の**実体**である。
//   M46 は枠(ジョブ定義と順序)だけを固定し、`.github/workflows/
//   content-guardrail.yml` の当該ジョブは「未実装で保護効果ゼロ」と機械可読で
//   宣言していた。本モジュールがその宣言を置き換える。
//
//   週次 content PR が壊しうるのは**構造**(ソフトロック・人口下限・決定論・
//   コマンド拒否の暴発)であり、数値バランスの収束(到達 tick レンジ等)は
//   M39〜M41 の担当なので、このゲートは `sim/nightlyGate.ts` の
//   `owner: "structural"` 側だけを必須にする(nightlyGate.ts §1 の線引き)。
//
// ===========================================================================
// 1. 「段階的」の意味(GDD 12.4)
// ===========================================================================
//   同じ長さの run を 1000 回まわすのではなく、**短い run を多数 → 長い run を
//   少数**の 3 段に配分する(合計はちょうど 1000 runs)。短い段で「投入直後に
//   壊れる content」を安く弾き、長い段で「じわじわ壊れる content」を拾う。
//
//     stage-short  : 60% = 600 runs ×  2 ゲーム日
//     stage-medium : 30% = 300 runs ×  7 ゲーム日
//     stage-long   : 10% = 100 runs × 20 ゲーム日
//
//   bot は 11 本(5戦略 + 敵対6種)を run 添字の剰余で巡回する(= どの段でも
//   11 本すべてが必ず現れる)。seed も run 添字から決定論的に作る。
//
// ===========================================================================
// 2. 判定(全て不等式・bool へ化けさせない)
// ===========================================================================
//   run ごとに以下を数え、**閾値超過が 1 件でもあれば終了コード 1**(CI が赤)。
//     (a) 人口下限余裕      min(生存人口 − 人口下限) >= 0     … GDD 11.4-9
//     (b) 施設数            最終施設数 >= 1                   … 盤面が消えない
//     (c) 例外              throw された run 数 <= 0
//     (d) 決定論            同一 (bot, seed) の再実行が digest 一致(抜き取り)
//
//   閾値そのものと実測値の両方を JSON へ出す(`sim/output/staged-sim-report.json`)。
// ---------------------------------------------------------------------------

import { canonicalJsonOfState, digestOfCanonicalJson } from "../conformance/goldenVector";

import type { GameState } from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";

import { isMainModule, writeJsonReport } from "./cliUtil";
import { ADVERSARIAL_BOTS, runAdversarialBotAsNewGame } from "./strategy/adversarialBots";
import { STRATEGY_BOTS } from "./strategy/bots";
import { runStrategyBot } from "./strategy/runStrategy";

export interface StagedSimStage {
  readonly id: string;
  /** この段が担当する run 数。 */
  readonly runs: number;
  /** 1 run の長さ(ゲーム日)。 */
  readonly days: number;
}

/** 既定の 3 段(§1)。合計 1000 runs。 */
export const DEFAULT_STAGES: readonly StagedSimStage[] = [
  { id: "stage-short", runs: 600, days: 2 },
  { id: "stage-medium", runs: 300, days: 7 },
  { id: "stage-long", runs: 100, days: 20 },
];

export interface StagedSimOptions {
  readonly stages?: readonly StagedSimStage[];
  /** 決定論の抜き取り再実行数(段ごと)。 */
  readonly determinismSpotChecks?: number;
}

export interface StagedSimViolation {
  readonly stageId: string;
  readonly runIndex: number;
  readonly botId: string;
  readonly seed: string;
  readonly kind: "populationFloor" | "facilityCount" | "exception" | "determinism";
  readonly measured: number;
  readonly threshold: number;
  readonly detail: string;
}

export interface StagedSimStageReport {
  readonly id: string;
  readonly runs: number;
  readonly days: number;
  /** min(生存人口 − 人口下限) の全 run 最小値。 */
  readonly minPopulationFloorMargin: number;
  /** 最終施設数の全 run 最小値。 */
  readonly minFinalFacilityCount: number;
  readonly exceptionCount: number;
  readonly determinismSpotChecks: number;
  readonly determinismMismatches: number;
}

export interface StagedSimReport {
  readonly totalRuns: number;
  readonly botCount: number;
  readonly stages: readonly StagedSimStageReport[];
  readonly violations: readonly StagedSimViolation[];
  /** 実行時間(ms)。計測メタとしてのみ使う。 */
  readonly elapsedMs: number;
}

interface AnyBot {
  readonly id: string;
  readonly kind: "strategy" | "adversarial";
}

const ALL_BOTS: readonly AnyBot[] = [
  ...STRATEGY_BOTS.map((bot) => ({ id: bot.id, kind: "strategy" as const })),
  ...ADVERSARIAL_BOTS.map((bot) => ({ id: bot.id, kind: "adversarial" as const })),
];

interface RunOutcome {
  readonly state: GameState;
  readonly minPopulationFloorMargin: number;
  readonly finalFacilityCount: number;
}

function runOne(bot: AnyBot, seed: string, totalTicks: number): RunOutcome {
  if (bot.kind === "strategy") {
    const strategyBot = STRATEGY_BOTS.find((candidate) => candidate.id === bot.id);
    if (strategyBot === undefined) throw new Error(`未知の戦略bot "${bot.id}"`);
    const result = runStrategyBot({ bot: strategyBot, totalTicks, worldSeed: seed });
    let margin = Number.POSITIVE_INFINITY;
    for (const sample of result.samples) {
      const value = sample.livingPopulation - sample.populationFloor;
      if (value < margin) margin = value;
    }
    return {
      state: result.state,
      minPopulationFloorMargin: Number.isFinite(margin) ? margin : 0,
      finalFacilityCount: result.metrics.finalFacilityCount,
    };
  }

  const adversarialBot = ADVERSARIAL_BOTS.find((candidate) => candidate.id === bot.id);
  if (adversarialBot === undefined) throw new Error(`未知の敵対bot "${bot.id}"`);
  const result = runAdversarialBotAsNewGame(adversarialBot, totalTicks, seed);
  let facilityCount = 0;
  let living = 0;
  for (const entity of result.state.entityStateById.values()) {
    if (entity.kind === "facility") facilityCount++;
    if (entity.kind === "resident" && (entity.life?.diedTick ?? null) === null) living++;
  }
  // 敵対bot は「わざと壊す」bot なので人口下限余裕は評価対象にしない
  // (GDD 11.6 の (a)(c) は唯一保持者を全滅させるのが目的)。ここでは
  // 「人口が 0 にならない」ことだけを見る(GDD 7.6 の全滅回避フェイルセーフ)。
  return {
    state: result.state,
    minPopulationFloorMargin: living - 1,
    finalFacilityCount: facilityCount,
  };
}

export function runStagedSim(options: StagedSimOptions = {}): StagedSimReport {
  const stages = options.stages ?? DEFAULT_STAGES;
  const spotChecks = options.determinismSpotChecks ?? 2;
  const start = performance.now();

  const violations: StagedSimViolation[] = [];
  const stageReports: StagedSimStageReport[] = [];
  let totalRuns = 0;
  let globalIndex = 0;

  for (const stage of stages) {
    const totalTicks = GAME_DAY_TICKS * stage.days;
    let minMargin = Number.POSITIVE_INFINITY;
    let minFacilities = Number.POSITIVE_INFINITY;
    let exceptionCount = 0;
    let determinismMismatches = 0;
    const digestByKey = new Map<string, string>();

    for (let i = 0; i < stage.runs; i++) {
      const bot = ALL_BOTS[globalIndex % ALL_BOTS.length];
      globalIndex++;
      totalRuns++;
      if (bot === undefined) continue;
      const seed = `staged-${stage.id}-${String(i)}`;

      let outcome: RunOutcome;
      try {
        outcome = runOne(bot, seed, totalTicks);
      } catch (error) {
        exceptionCount++;
        violations.push({
          stageId: stage.id,
          runIndex: i,
          botId: bot.id,
          seed,
          kind: "exception",
          measured: 1,
          threshold: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (outcome.minPopulationFloorMargin < minMargin) {
        minMargin = outcome.minPopulationFloorMargin;
      }
      if (outcome.finalFacilityCount < minFacilities) minFacilities = outcome.finalFacilityCount;

      if (outcome.minPopulationFloorMargin < 0) {
        violations.push({
          stageId: stage.id,
          runIndex: i,
          botId: bot.id,
          seed,
          kind: "populationFloor",
          measured: outcome.minPopulationFloorMargin,
          threshold: 0,
          detail: "生存人口が人口下限(GDD 7.6)を割った",
        });
      }
      if (outcome.finalFacilityCount < 1) {
        violations.push({
          stageId: stage.id,
          runIndex: i,
          botId: bot.id,
          seed,
          kind: "facilityCount",
          measured: outcome.finalFacilityCount,
          threshold: 1,
          detail: "run 終了時点で施設が 1 基も無い(盤面が消えている)",
        });
      }

      if (i < spotChecks) {
        digestByKey.set(
          `${bot.id}:${seed}`,
          digestOfCanonicalJson(canonicalJsonOfState(outcome.state)),
        );
      }
    }

    // 決定論の抜き取り: 同じ (bot, seed) をもう一度回して digest 一致を確かめる。
    for (const [key, digest] of digestByKey) {
      const [botId, seed] = key.split(":");
      const bot = ALL_BOTS.find((candidate) => candidate.id === botId);
      if (bot === undefined || seed === undefined) continue;
      const again = runOne(bot, seed, totalTicks);
      const againDigest = digestOfCanonicalJson(canonicalJsonOfState(again.state));
      if (againDigest !== digest) {
        determinismMismatches++;
        violations.push({
          stageId: stage.id,
          runIndex: -1,
          botId: bot.id,
          seed,
          kind: "determinism",
          measured: 1,
          threshold: 0,
          detail: `同一 (bot, seed) の再実行で digest が一致しない(${digest} vs ${againDigest})`,
        });
      }
    }

    stageReports.push({
      id: stage.id,
      runs: stage.runs,
      days: stage.days,
      minPopulationFloorMargin: Number.isFinite(minMargin) ? minMargin : 0,
      minFinalFacilityCount: Number.isFinite(minFacilities) ? minFacilities : 0,
      exceptionCount,
      determinismSpotChecks: digestByKey.size,
      determinismMismatches,
    });
  }

  return {
    totalRuns,
    botCount: ALL_BOTS.length,
    stages: stageReports,
    violations,
    elapsedMs: performance.now() - start,
  };
}

// --- CLI ---------------------------------------------------------------------

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");
  const report = runStagedSim(
    quick
      ? {
          stages: [
            { id: "stage-short", runs: 33, days: 2 },
            { id: "stage-medium", runs: 22, days: 5 },
            { id: "stage-long", runs: 11, days: 10 },
          ],
          determinismSpotChecks: 1,
        }
      : {},
  );

  console.log(
    `\n=== 段階sim(ADR-015 正準順序 4/10)${String(report.totalRuns)} runs / bot ${String(report.botCount)} 本 ===`,
  );
  console.table(
    report.stages.map((stage) => ({
      stage: stage.id,
      runs: stage.runs,
      days: stage.days,
      "min(人口−下限)": stage.minPopulationFloorMargin,
      min施設数: stage.minFinalFacilityCount,
      例外: stage.exceptionCount,
      決定論抜取: stage.determinismSpotChecks,
      不一致: stage.determinismMismatches,
    })),
  );
  console.log(
    `違反 ${String(report.violations.length)} 件 / 実行時間 ${(report.elapsedMs / 1000).toFixed(1)} 秒`,
  );
  for (const violation of report.violations.slice(0, 20)) {
    console.error(
      `  VIOLATION ${violation.kind} ${violation.stageId}#${String(violation.runIndex)} ` +
        `${violation.botId}/${violation.seed}: 実測 ${String(violation.measured)} / 閾値 ${String(violation.threshold)} — ${violation.detail}`,
    );
  }

  await writeJsonReport("sim/output/staged-sim-report.json", report);
  if (report.violations.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  await main();
}
