// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 想起困難の発生頻度 予備判定 — GDD 11.2/11.4-8 / 先行計測計画 §5.2 #5
//
// 縮約盤面(住民20・tech3・施設/士気/派遣の代表10パターン・sim/board.ts)を
// 10分粒度で1週間(GAME_DAY_TICKS×7 = 10080 tick)ぶん進め、住民あたりの
// 想起困難の発生回数を集計する。判断基準(GDD 11.4-8)は「週1〜3回/住民」。
//
// ===========================================================================
// 1. なぜ (C) だけを直接評価するのか
// ===========================================================================
//   `ScheduleReport.recallOccurrenceCount` は集計済みの総数しか持たず、住民 ID
//   別の内訳が無い(conformance/goldenVector.ts のカウンタ設計どおり)。パターン
//   別の内訳を出すには住民 ID 付きの発生イベントが要るため、engine の
//   `evaluateRecallCoarseStep`(rules/recall.ts・T5 実装済みの実際の (C) 評価)を
//   scheduler.ts と同じ絶対 tick グリッドで直接、逐次呼ぶ。
//
//   これが scheduler 経由の結果と一致する根拠: 縮約 state では
//   recallRiskPerDay(住民の士気/派遣/定着度/配属先の harshWork)が生産・研究の
//   進行から独立している(rules/production.ts・research.ts のどちらも resident
//   の該当フィールドを書き換えない・state.ts §3)。よって生産/研究を回さずに
//   (C) だけを直接評価しても、想起困難まわりの結果(発生回数・
//   recallImpairedUntilTick)は scheduler 経由と一致するはずである。
//   この前提を `crossCheckAgainstScheduler` で毎回検証し、崩れていたら測定を
//   信用せず例外で止める(engine を書き換えず報告する方針・
//   tools/genGoldenVectors.ts §7.2 規則8 と同じ姿勢)。
//
// ===========================================================================
// 2. 縮約による乖離(正直な明示)
// ===========================================================================
//   GDD 11.2 の `recallRisk(住民u, tech t)` は「u が記憶している未成文の tech」
//   を走るが、縮約 state は誰がどの技術を記憶しているかを持たないため、判定
//   ペアは「全住民 × 全 research entity の techId」になる(rules/recall.ts §3(a))。
//   回復条件も「通常業務就労かつ士気 ≥40 を持続、または療養所で休養1日」ではなく
//   持続 d(1〜2日)の満了のみ(§3(c))。よって本判定は「縮約盤面での予備判定」
//   であり、住民系(記憶モデル・療養所・士気回復)の実装後に本判定へ差し替える
//   必要がある(T9 指示書のとおり)。
// ---------------------------------------------------------------------------

import { advanceWithReport, createAdvanceContext } from "../src/engine/advance";
import { toRaw } from "../src/engine/fp";
import type { AdvanceContext, EngineContent } from "../src/engine/rules/types";
import { evaluateRecallCoarseStep, type RecallOccurrence } from "../src/engine/rules/recall";
import {
  entitiesOfKind,
  getTechMemory,
  requireEntity,
  techMemoryKeys,
  type GameState,
} from "../src/engine/state/state";
import { GAME_DAY_TICKS, nextCoarseStepTickAtOrAfter } from "../src/engine/stochastic";

import {
  PATTERNS,
  RESIDENTS_PER_PATTERN,
  buildPatternBoard,
  patchWithoutMorale,
  patternIdOfResidentId,
  resolveSimContent,
} from "./board";
import { isMainModule, writeJsonReport } from "./cliUtil";

export class RecallFrequencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecallFrequencyError";
  }
}

/** GDD 11.4-8: 週1〜3回/住民が「日常危機化が sim で機能している」判定レンジ。 */
const EXPECTED_RANGE = { minPerWeek: 1, maxPerWeek: 3 } as const;

const WEEK_TICKS = GAME_DAY_TICKS * 7; // 10080
const DEFAULT_SEED_COUNT = 8;

function defaultSeeds(count: number): readonly string[] {
  const seeds: string[] = [];
  for (let i = 0; i < count; i++) seeds.push(`recall-freq-${String(i)}`);
  return seeds;
}

interface StepwiseResult {
  readonly finalState: GameState;
  readonly occurrences: readonly RecallOccurrence[];
}

/** (C) だけを直接、粗粒度ステップの絶対グリッドで逐次評価する(§1)。 */
function stepwiseRecallOccurrences(
  content: EngineContent,
  ctx: AdvanceContext,
  initialState: GameState,
  totalTicks: number,
): StepwiseResult {
  let state = initialState;
  const occurrences: RecallOccurrence[] = [];
  const targetTick = initialState.tick + totalTicks;
  let stepTick = nextCoarseStepTickAtOrAfter(state.tick, content.coarseTickMinutes);
  while (stepTick < targetTick) {
    const result = evaluateRecallCoarseStep(state, ctx, stepTick);
    state = result.state;
    occurrences.push(...result.occurrences);
    stepTick += content.coarseTickMinutes;
  }
  return { finalState: state, occurrences };
}

/**
 * scheduler 経由(runSchedule 全体)の結果と (C) 単独評価の結果が一致するかを検証する(§1)。
 *
 * [M14] `techMemoryByKey`(M13 で追加された (住民,技術) 別の記憶・想起困難記録)の
 * 全キーも突合する。旧来は住民単位スカラ `recallImpairedUntilTick` だけを見ていたが、
 * M13 以降の抽選はそのスカラへ書かなくなった(rules/recall.ts §3 末尾)ため、
 * 住民単位スカラの一致だけでは (C) 単独評価が tech 別の記憶を正しく再現しているかを
 * 検出できない。テック別の想起困難記録・定着度蓄積の両方が本チェックの対象。
 */
function crossCheckAgainstScheduler(
  ctx: AdvanceContext,
  initialState: GameState,
  totalTicks: number,
  stepwise: StepwiseResult,
  seed: string,
): void {
  const fullReport = advanceWithReport(initialState, ctx, initialState.tick + totalTicks);
  if (fullReport.recallOccurrenceCount !== stepwise.occurrences.length) {
    throw new RecallFrequencyError(
      `seed "${seed}": scheduler 集計(${String(fullReport.recallOccurrenceCount)})と ` +
        `(C) 単独評価(${String(stepwise.occurrences.length)})の発生件数が食い違う` +
        "(生産/研究が想起困難の入力に影響しないという前提が崩れている可能性)",
    );
  }
  for (const resident of entitiesOfKind(stepwise.finalState, "resident")) {
    const viaScheduler = requireEntity(fullReport.state, resident.id, "resident");
    if (viaScheduler.recallImpairedUntilTick !== resident.recallImpairedUntilTick) {
      throw new RecallFrequencyError(
        `seed "${seed}": resident "${resident.id}" の recallImpairedUntilTick が ` +
          "scheduler 経路と (C) 単独評価で食い違う",
      );
    }
  }

  // [M14] techMemoryByKey(住民×tech別の想起困難記録・定着度)の全キーを突合する。
  const techMemoryKeySet = new Set<string>([
    ...techMemoryKeys(stepwise.finalState),
    ...techMemoryKeys(fullReport.state),
  ]);
  for (const key of techMemoryKeySet) {
    const viaStepwise = getTechMemory(stepwise.finalState, key);
    const viaScheduler = getTechMemory(fullReport.state, key);
    const stepwiseSnapshot =
      viaStepwise === undefined
        ? null
        : ([toRaw(viaStepwise.masteryFix), viaStepwise.impairedUntilTick] as const);
    const schedulerSnapshot =
      viaScheduler === undefined
        ? null
        : ([toRaw(viaScheduler.masteryFix), viaScheduler.impairedUntilTick] as const);
    if (
      stepwiseSnapshot === null || schedulerSnapshot === null
        ? stepwiseSnapshot !== schedulerSnapshot
        : stepwiseSnapshot[0] !== schedulerSnapshot[0] ||
          stepwiseSnapshot[1] !== schedulerSnapshot[1]
    ) {
      throw new RecallFrequencyError(
        `seed "${seed}": techMemory("${key}") が scheduler 経路と (C) 単独評価で食い違う` +
          "(mastery 蓄積または (住民,技術) 別の想起困難記録が (C) 単独評価に漏れている可能性)",
      );
    }
  }
}

export interface PatternFrequency {
  readonly patternId: string;
  readonly title: string;
  readonly residentCount: number;
  readonly occurrenceCount: number;
  readonly occurrencesPerResidentPerWeek: number;
}

export interface RecallFrequencyReport {
  readonly seeds: readonly string[];
  readonly weekTicks: number;
  readonly totalResidentWeeks: number;
  readonly totalOccurrences: number;
  readonly overallOccurrencesPerResidentPerWeek: number;
  readonly byPattern: readonly PatternFrequency[];
  /** GDD 11.4-8: 週1〜3回/住民のレンジ内か。 */
  readonly withinExpectedRange: boolean;
}

export interface RecallFrequencyParams {
  readonly seeds?: readonly string[];
}

/** 計測 #5 本体: 代表10パターン × 複数 seed × 1週間で発生頻度を集計する。 */
export function measureRecallFrequency(params: RecallFrequencyParams = {}): RecallFrequencyReport {
  const seeds = params.seeds ?? defaultSeeds(DEFAULT_SEED_COUNT);
  // [M72] 代表10パターンの「士気」を固定点として測る計測なので、士気モデルは
  // 外した content で測る(sim/board.ts の `patchWithoutMorale` の doc に理由)。
  const content = resolveSimContent(patchWithoutMorale());

  const occurrenceCountByPattern = new Map<string, number>();
  for (const pattern of PATTERNS) occurrenceCountByPattern.set(pattern.id, 0);
  let totalOccurrences = 0;

  for (const seed of seeds) {
    const initialState = buildPatternBoard(seed, content);
    const ctx = createAdvanceContext(initialState, content);
    const stepwise = stepwiseRecallOccurrences(content, ctx, initialState, WEEK_TICKS);
    crossCheckAgainstScheduler(ctx, initialState, WEEK_TICKS, stepwise, seed);

    for (const occurrence of stepwise.occurrences) {
      const patternId = patternIdOfResidentId(occurrence.residentId);
      occurrenceCountByPattern.set(patternId, (occurrenceCountByPattern.get(patternId) ?? 0) + 1);
      totalOccurrences++;
    }
  }

  const byPattern: PatternFrequency[] = PATTERNS.map((pattern) => {
    const occurrenceCount = occurrenceCountByPattern.get(pattern.id) ?? 0;
    const residentWeeks = RESIDENTS_PER_PATTERN * seeds.length;
    return {
      patternId: pattern.id,
      title: pattern.title,
      residentCount: RESIDENTS_PER_PATTERN,
      occurrenceCount,
      occurrencesPerResidentPerWeek: occurrenceCount / residentWeeks,
    };
  });

  const totalResidentWeeks = PATTERNS.length * RESIDENTS_PER_PATTERN * seeds.length;
  const overallOccurrencesPerResidentPerWeek = totalOccurrences / totalResidentWeeks;

  return {
    seeds,
    weekTicks: WEEK_TICKS,
    totalResidentWeeks,
    totalOccurrences,
    overallOccurrencesPerResidentPerWeek,
    byPattern,
    withinExpectedRange:
      overallOccurrencesPerResidentPerWeek >= EXPECTED_RANGE.minPerWeek &&
      overallOccurrencesPerResidentPerWeek <= EXPECTED_RANGE.maxPerWeek,
  };
}

// --- CLI ---------------------------------------------------------------------

async function main(): Promise<void> {
  const report = measureRecallFrequency();
  console.log(`\n=== 想起困難 発生頻度 予備判定(${String(report.seeds.length)} seed × 1週間) ===`);
  console.table(
    report.byPattern.map((p) => ({
      pattern: p.patternId,
      title: p.title,
      occurrences: p.occurrenceCount,
      "回/住民/週": p.occurrencesPerResidentPerWeek.toFixed(3),
    })),
  );
  console.log(
    `全体: ${report.overallOccurrencesPerResidentPerWeek.toFixed(3)} 回/住民/週` +
      `(判断基準 週1〜3回: ${report.withinExpectedRange ? "OK" : "NG"})`,
  );
  console.log(
    "注意: 縮約盤面(src/engine/rules/recall.ts §3)は判定ペアを「全住民×全research entity」" +
      "とし、住民ごとの技術記憶モデル・療養所/士気回復は未実装(本判定は住民系実装後に" +
      "本計測へ差し替えること)。",
  );

  await writeJsonReport("sim/output/recall-frequency-report.json", report);
}

if (isMainModule(import.meta.url)) {
  await main();
}
