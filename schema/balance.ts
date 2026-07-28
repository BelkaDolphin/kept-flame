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
  validateId,
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
/**
 * [T7] 想起困難の持続 tick(GDD 11.2「持続 d = 1〜2日」)の許容レンジ。
 * 1 tick = 1 分なので 1 日 = 1440。上限は 1 週間(10080)を保守境界とする。
 */
const RECALL_DURATION_TICKS_RANGE: NumericRange = { min: 1, max: 10_080 };

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
  /**
   * [T7] 記憶巧者 trait の content ID(省略可・欠落は null)。
   * GDD 11.2 は「記憶巧者trait −0.15」と効果量だけを定めており、どの trait entity が
   * それに該当するかは content 側の対応付けなので balance に置く。省略時は
   * 「この content には記憶巧者 trait が無い」= engine 側 memoryKeeperTraitId が null。
   * 指定した場合の trait 実在確認は contentBundle.ts の cross-ref が行う。
   */
  readonly memoryKeeperTraitId: string | null;
  /**
   * [T7] 発生時の持続 tick の下限(GDD 11.2「d = 1〜2日」の 1 日 = 1440。省略可)。
   * 省略可にしているのは既存 content/テストを壊さないため。engine へ写す段
   * (schema/engineContent.ts)は欠落を reject する。
   */
  readonly durationTicksMin: number | null;
  /** [T7] 発生時の持続 tick の上限(GDD 11.2 の 2 日 = 2880。省略可)。 */
  readonly durationTicksMax: number | null;
}

/**
 * [M5] 保管庫オーバーフロー・廃材スポンジ・廃材3出口(GDD 6.7)のパラメータ。
 *
 * **ブロックごと省略可**(欠落は null)。省略時は engine 側で上限判定も廃材生成も
 * 走らない = 既存挙動と完全に同一。資源ごとの上限/変換率は
 * 「resource 定義 ID → 値」のオブジェクトで持つ(resource カテゴリが未実装のため
 * ID の実在確認は行わない。GDD 12.1 の `item.overflow{policy,convertTo,ratio}` へ
 * 移すのは item カテゴリを足す段の作業)。
 */
export interface StorageParamsContent {
  /** 廃材の resource 定義 ID。null なら超過分は全て破棄。 */
  readonly wasteResourceId: string | null;
  /** resource 定義 ID → 基礎保管容量。ここに無い資源は**上限なし**。 */
  readonly baseCapacity: { readonly [resourceId: string]: number };
  /** resource 定義 ID → 超過分の廃材変換率(0〜1)。無指定は 0 = 単純破棄。 */
  readonly wasteConversionRatio: { readonly [resourceId: string]: number };
  /** GDD 6.7 3出口(3)「廃材 N → RP 1」の 1/N。 */
  readonly wasteToResearchRatio: number;
  /** GDD 6.7 3出口(1)「施設増築コストの一部代替(最大20%)」。 */
  readonly buildCostWasteSubstitutionMax: number;
  /** GDD 6.7 3出口(2)「成文化の粘土代替(低比率)」。 */
  readonly codifyWasteSubstitutionMax: number;
}

export interface BalanceContent {
  readonly fpScale: number;
  readonly algoVersion: number;
  readonly coarseTickMinutes: number;
  readonly offlineClampTick: number;
  readonly safetyFactor: number;
  readonly recallRiskParams: RecallRiskParams;
  /** [M5] GDD 6.7 の保管庫パラメータ。JSON に無ければ null。 */
  readonly storage: StorageParamsContent | null;
}

/** [M5] 保管容量の保守境界(lvCurve と同じ上限)。 */
const CAPACITY_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

/** [M5] GDD 6.7「最大20%」を上限とする代替比率の保守境界。 */
const SUBSTITUTION_RATIO_RANGE: NumericRange = { min: 0, max: 0.2 };

function validateResourceNumberMap(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  range: NumericRange,
): { readonly [resourceId: string]: number } | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const result: Record<string, number> = {};
  const issuesBefore = issues.list().length;
  for (const key of Object.keys(obj)) {
    const resourceId = validateId(key, `${path}.${key}`, issues);
    const value = expectNumber(obj[key], `${path}.${key}`, issues, range);
    if (resourceId === undefined || value === undefined) continue;
    result[resourceId] = value;
  }
  return issues.list().length === issuesBefore ? result : undefined;
}

function validateStorage(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): StorageParamsContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const rawWasteResourceId = obj["wasteResourceId"];
  const wasteResourceId =
    rawWasteResourceId === undefined || rawWasteResourceId === null
      ? null
      : (validateId(rawWasteResourceId, `${path}.wasteResourceId`, issues) ?? undefined);
  const baseCapacity = validateResourceNumberMap(
    obj["baseCapacity"] ?? {},
    `${path}.baseCapacity`,
    issues,
    CAPACITY_RANGE,
  );
  const wasteConversionRatio = validateResourceNumberMap(
    obj["wasteConversionRatio"] ?? {},
    `${path}.wasteConversionRatio`,
    issues,
    UNIT_RANGE,
  );
  const wasteToResearchRatio = expectNumber(
    obj["wasteToResearchRatio"],
    `${path}.wasteToResearchRatio`,
    issues,
    UNIT_RANGE,
  );
  const buildCostWasteSubstitutionMax = expectNumber(
    obj["buildCostWasteSubstitutionMax"],
    `${path}.buildCostWasteSubstitutionMax`,
    issues,
    SUBSTITUTION_RATIO_RANGE,
  );
  const codifyWasteSubstitutionMax = expectNumber(
    obj["codifyWasteSubstitutionMax"],
    `${path}.codifyWasteSubstitutionMax`,
    issues,
    SUBSTITUTION_RATIO_RANGE,
  );

  if (
    wasteResourceId === undefined ||
    baseCapacity === undefined ||
    wasteConversionRatio === undefined ||
    wasteToResearchRatio === undefined ||
    buildCostWasteSubstitutionMax === undefined ||
    codifyWasteSubstitutionMax === undefined
  ) {
    return undefined;
  }

  // 廃材変換率が指定されているのに変換先が無ければ、変換分は行き場を失う
  // (黙って破棄せず reject する。GDD 6.7 のスポンジ機構が成立しない設定)。
  if (wasteResourceId === null && Object.keys(wasteConversionRatio).length > 0) {
    issues.add(
      `${path}.wasteResourceId`,
      "wasteConversionRatio が指定されているのに wasteResourceId が無い(廃材の行き先が決まらない)",
    );
    return undefined;
  }

  return {
    wasteResourceId,
    baseCapacity,
    wasteConversionRatio,
    wasteToResearchRatio,
    buildCostWasteSubstitutionMax,
    codifyWasteSubstitutionMax,
  };
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

  // 省略可フィールド(ファイル冒頭 [T7]): キーが無ければ null、あれば形式を検証する。
  const rawTraitId = obj["memoryKeeperTraitId"];
  const memoryKeeperTraitId =
    rawTraitId === undefined
      ? null
      : (validateId(rawTraitId, `${path}.memoryKeeperTraitId`, issues) ?? undefined);
  const rawDurationMin = obj["durationTicksMin"];
  const durationTicksMin =
    rawDurationMin === undefined
      ? null
      : (expectInteger(
          rawDurationMin,
          `${path}.durationTicksMin`,
          issues,
          RECALL_DURATION_TICKS_RANGE,
        ) ?? undefined);
  const rawDurationMax = obj["durationTicksMax"];
  const durationTicksMax =
    rawDurationMax === undefined
      ? null
      : (expectInteger(
          rawDurationMax,
          `${path}.durationTicksMax`,
          issues,
          RECALL_DURATION_TICKS_RANGE,
        ) ?? undefined);

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
    memoryKeeperResist === undefined ||
    memoryKeeperTraitId === undefined ||
    durationTicksMin === undefined ||
    durationTicksMax === undefined
  ) {
    return undefined;
  }

  if (
    durationTicksMin !== null &&
    durationTicksMax !== null &&
    durationTicksMin > durationTicksMax
  ) {
    issues.add(
      path,
      `durationTicksMin (${String(durationTicksMin)}) は durationTicksMax (${String(durationTicksMax)}) 以下が必須`,
    );
    return undefined;
  }
  if ((durationTicksMin === null) !== (durationTicksMax === null)) {
    issues.add(
      path,
      "durationTicksMin / durationTicksMax は両方指定か両方省略のいずれか(片方だけの指定は持続レンジが決まらない)",
    );
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
    memoryKeeperTraitId,
    durationTicksMin,
    durationTicksMax,
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
  const rawStorage = obj["storage"];
  const storage =
    rawStorage === undefined
      ? null
      : (validateStorage(rawStorage, "$.storage", issues) ?? undefined);

  if (
    fpScale === undefined ||
    algoVersion === undefined ||
    coarseTickMinutes === undefined ||
    offlineClampTick === undefined ||
    safetyFactor === undefined ||
    recallRiskParams === undefined ||
    storage === undefined
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
    storage,
  });
}
