// ---------------------------------------------------------------------------
// balance content スキーマ — ADR「balance(人間専用)」641行、GDD §11.1〜§11.3
//
// balance.json は CODEOWNERS で人間専用(ADR リポ構成591行)。T6 はその
// スキーマ検証器を用意するだけで、週次 LLM 運営パイプライン(bot作成PR等・
// ADR-030)は範囲外。
//
// T4 state.ts §3 が明記する「3 rules(生産/研究/想起困難)が読む値」に合わせ、
// このスキーマも recallRiskParams を中心とした最小フィールドのみを対象と
// する。ADR のサンプル(641行)にある lifespan/populationFloor/eraTable/
// caravanRatio/roiRange/assistEfficiencyCap は住民寿命モデル・人口下限・
// 周回・アシストAI等 T4/T6 のスコープ外システム向けであり、T6 では未実装
// (state.ts §3 が明示的に除外した対象と同じ理由。それらのシステム実装時に
// 追加すること)。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectExactNumber,
  expectInteger,
  expectNumber,
  expectRecord,
  fail,
  ok,
  type NumericRange,
  type ValidationResult,
} from "./common";

/** ADR-006: 固定小数点スケールは 1e6 固定。 */
const FP_SCALE = 1_000_000;
/** GDD 11.1: オフライン差分は72h=4320tick固定クランプ。 */
const OFFLINE_CLAMP_TICK = 4320;
/** GDD 11.3: 安全係数は1.5に統一(旧1.2は撤回)。 */
const SAFETY_FACTOR = 1.5;

const POSITIVE_INT: NumericRange = { min: 1, max: 1_000_000 };
const UNIT_RANGE: NumericRange = { min: 0, max: 1 };
const MORALE_SCALE_RANGE: NumericRange = { min: 0, max: 100 };
const RESIST_RANGE: NumericRange = { min: -1, max: 1 };

export interface RecallRiskParams {
  /** GDD 11.2 base_p。 */
  readonly base_p: number;
  /** GDD 11.2 p_max。 */
  readonly p_max: number;
  /** GDD 11.2 loadW: 過酷業務 ×2.0。 */
  readonly loadWHarsh: number;
  /** GDD 11.2 loadW: 通常業務 ×0.5。 */
  readonly loadWNormal: number;
  /** GDD 11.2 moraleW: 士気しきい値(中位、既定30)。 */
  readonly moraleThresholdMid: number;
  /** GDD 11.2 moraleW: 中位しきい値未満時の加算(既定+0.10)。 */
  readonly moraleBonusMid: number;
  /** GDD 11.2 moraleW: 士気しきい値(低位、既定15)。 */
  readonly moraleThresholdLow: number;
  /** GDD 11.2 moraleW: 低位しきい値未満時の加算(既定+0.20)。 */
  readonly moraleBonusLow: number;
  /** GDD 11.2 dispatchW: 探索派遣中 +0.15。 */
  readonly dispatchW: number;
  /** GDD 11.2 masteryResist: 実地稼働で蓄積する定着度の上限(0〜0.20)。 */
  readonly masteryResistMax: number;
  /** GDD 11.2 masteryResist: 記憶巧者 trait による追加軽減(-0.15)。 */
  readonly memoryKeeperResist: number;
}

export interface BalanceContent {
  readonly fpScale: number;
  readonly algoVersion: number;
  readonly coarseTickMinutes: number;
  readonly offlineClampTick: number;
  readonly safetyFactor: number;
  readonly recallRiskParams: RecallRiskParams;
}

function validateRecallRiskParams(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RecallRiskParams | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const base_p = expectNumber(obj["base_p"], `${path}.base_p`, issues, UNIT_RANGE);
  const p_max = expectNumber(obj["p_max"], `${path}.p_max`, issues, UNIT_RANGE);
  const loadWHarsh = expectNumber(obj["loadWHarsh"], `${path}.loadWHarsh`, issues, {
    min: 0,
    max: 10,
  });
  const loadWNormal = expectNumber(obj["loadWNormal"], `${path}.loadWNormal`, issues, {
    min: 0,
    max: 10,
  });
  const moraleThresholdMid = expectNumber(
    obj["moraleThresholdMid"],
    `${path}.moraleThresholdMid`,
    issues,
    MORALE_SCALE_RANGE,
  );
  const moraleBonusMid = expectNumber(
    obj["moraleBonusMid"],
    `${path}.moraleBonusMid`,
    issues,
    UNIT_RANGE,
  );
  const moraleThresholdLow = expectNumber(
    obj["moraleThresholdLow"],
    `${path}.moraleThresholdLow`,
    issues,
    MORALE_SCALE_RANGE,
  );
  const moraleBonusLow = expectNumber(
    obj["moraleBonusLow"],
    `${path}.moraleBonusLow`,
    issues,
    UNIT_RANGE,
  );
  const dispatchW = expectNumber(obj["dispatchW"], `${path}.dispatchW`, issues, UNIT_RANGE);
  const masteryResistMax = expectNumber(
    obj["masteryResistMax"],
    `${path}.masteryResistMax`,
    issues,
    UNIT_RANGE,
  );
  const memoryKeeperResist = expectNumber(
    obj["memoryKeeperResist"],
    `${path}.memoryKeeperResist`,
    issues,
    RESIST_RANGE,
  );

  if (
    base_p === undefined ||
    p_max === undefined ||
    loadWHarsh === undefined ||
    loadWNormal === undefined ||
    moraleThresholdMid === undefined ||
    moraleBonusMid === undefined ||
    moraleThresholdLow === undefined ||
    moraleBonusLow === undefined ||
    dispatchW === undefined ||
    masteryResistMax === undefined ||
    memoryKeeperResist === undefined
  ) {
    return undefined;
  }

  if (base_p > p_max) {
    issues.add(path, `base_p (${String(base_p)}) は p_max (${String(p_max)}) 以下が必須`);
    return undefined;
  }
  if (loadWHarsh <= loadWNormal) {
    issues.add(
      path,
      `loadWHarsh (${String(loadWHarsh)}) は loadWNormal (${String(loadWNormal)}) より大が必須(GDD 11.2: 過酷×2.0 > 通常×0.5)`,
    );
    return undefined;
  }
  if (moraleThresholdLow >= moraleThresholdMid) {
    issues.add(
      path,
      `moraleThresholdLow (${String(moraleThresholdLow)}) は moraleThresholdMid (${String(moraleThresholdMid)}) 未満が必須`,
    );
    return undefined;
  }
  if (moraleBonusLow < moraleBonusMid) {
    issues.add(
      path,
      `moraleBonusLow (${String(moraleBonusLow)}) は moraleBonusMid (${String(moraleBonusMid)}) 以上が必須(士気が低いほど加算大)`,
    );
    return undefined;
  }

  return {
    base_p,
    p_max,
    loadWHarsh,
    loadWNormal,
    moraleThresholdMid,
    moraleBonusMid,
    moraleThresholdLow,
    moraleBonusLow,
    dispatchW,
    masteryResistMax,
    memoryKeeperResist,
  };
}

export function validateBalance(raw: unknown): ValidationResult<BalanceContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const fpScale = expectExactNumber(obj["fpScale"], FP_SCALE, "$.fpScale", issues);
  const algoVersion = expectInteger(obj["algoVersion"], "$.algoVersion", issues, POSITIVE_INT);
  const coarseTickMinutes = expectInteger(
    obj["coarseTickMinutes"],
    "$.coarseTickMinutes",
    issues,
    POSITIVE_INT,
  );
  const offlineClampTick = expectExactNumber(
    obj["offlineClampTick"],
    OFFLINE_CLAMP_TICK,
    "$.offlineClampTick",
    issues,
  );
  const safetyFactor = expectExactNumber(
    obj["safetyFactor"],
    SAFETY_FACTOR,
    "$.safetyFactor",
    issues,
  );
  const recallRiskParams = validateRecallRiskParams(
    obj["recallRiskParams"],
    "$.recallRiskParams",
    issues,
  );

  if (
    fpScale === undefined ||
    algoVersion === undefined ||
    coarseTickMinutes === undefined ||
    offlineClampTick === undefined ||
    safetyFactor === undefined ||
    recallRiskParams === undefined
  ) {
    return fail(issues.list());
  }

  return ok({
    fpScale,
    algoVersion,
    coarseTickMinutes,
    offlineClampTick,
    safetyFactor,
    recallRiskParams,
  });
}
