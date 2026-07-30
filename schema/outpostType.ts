// ---------------------------------------------------------------------------
// outpostType content スキーマ — GDD §9.2 / §12.1、M24
//
// GDD 12.1: `outpostType(id, resource, baseSupply, capacityCurve,
// upkeepFormula, hazard{intensity,growth,min/max}, shadeSensitivity)`。
//
// `resource` は resource カテゴリが未実装(facility.ts / balance.ts と同じ
// 事情)のため実在確認はしない。**本拠 facility の output.resourceId と
// 同じ ID 空間を指す**ことが「本拠と拠点で二重計上しない」構造の根拠であり
// (二重の資源ストックを作らない・src/engine/rules/outpost.ts §2)、その根拠を
// 壊さないためにも新しい resource カテゴリを作らずID文字列で受ける現行方式を
// 踏襲する。
//
// `capacityCurve` は facility.lvCurve と同型(GDD 11.7「非整数べき乗は実行時
// 計算禁止・Lv 別に個別 FP 値を事前計算」)。GDD 9.2 の生式
// `supply = baseSupply(type) × 常駐人数 × 拠点Lv × (1 − 翳り率)` の
// 「baseSupply(type) × 拠点Lv」を capacityCurve[Lv-1] 1本にまとめて表現する
// (facility の `outputPerTickByLevel` が `base × 1.15^(Lv-1)` を折り込むのと
// 同じ判断)。`capacityCurve[0]` は `baseSupply` と一致することを要求する
// (二重の真実を作らない)。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
  expectNumber,
  expectRecord,
  fail,
  ok,
  validateId,
  type NumericRange,
  type ValidationResult,
} from "./common";

/** facility.lvCurve と同じ Lv1〜Lv5 の 5 段。 */
const LEVEL_COUNT = 5;

/** baseSupply / capacityCurve の値域(facility.ts の LV_CURVE_VALUE_RANGE と同じ保守境界)。 */
const SUPPLY_VALUE_RANGE: NumericRange = { min: 0.000_001, max: 1_000_000_000 };

/** upkeepFormula(食料・士気ケア)の値域。 */
const UPKEEP_VALUE_RANGE: NumericRange = { min: 0, max: 1_000_000 };

/** hazard の intensity/min/max は 0〜1 スケール(GDD 12.1「0〜1 の脅威強度」の解釈)。 */
const HAZARD_UNIT_RANGE: NumericRange = { min: 0, max: 1 };

/** hazard.growth(1 ゲーム日あたりの増分)の保守境界。 */
const HAZARD_GROWTH_RANGE: NumericRange = { min: 0, max: 1 };

/** shadeSensitivity の保守境界(GDD 9.2 の翳り率係数。1 超を許して感度差を表現可能にする)。 */
const SHADE_SENSITIVITY_RANGE: NumericRange = { min: 0, max: 10 };

export interface OutpostUpkeepFormulaContent {
  readonly baseFood: number;
  readonly baseMoraleCare: number;
}

export interface OutpostHazardContent {
  readonly intensity: number;
  readonly growth: number;
  readonly min: number;
  readonly max: number;
}

export interface OutpostTypeContent {
  readonly id: string;
  readonly resource: string;
  readonly baseSupply: number;
  readonly capacityCurve: readonly number[];
  readonly upkeepFormula: OutpostUpkeepFormulaContent;
  readonly hazard: OutpostHazardContent;
  readonly shadeSensitivity: number;
}

function validateCapacityCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LEVEL_COUNT) {
    issues.add(
      path,
      `capacityCurve は長さ ${String(LEVEL_COUNT)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, SUPPLY_VALUE_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    if (cur <= prev) {
      issues.add(
        path,
        `capacityCurve は Lv が上がるにつれ狭義単調増加が必須(GDD 9.2「拠点Lv」倍率): ${values.join(",")}`,
      );
      return undefined;
    }
  }
  return values;
}

function validateUpkeepFormula(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): OutpostUpkeepFormulaContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const baseFood = expectNumber(obj["baseFood"], `${path}.baseFood`, issues, UPKEEP_VALUE_RANGE);
  const baseMoraleCare = expectNumber(
    obj["baseMoraleCare"],
    `${path}.baseMoraleCare`,
    issues,
    UPKEEP_VALUE_RANGE,
  );
  if (baseFood === undefined || baseMoraleCare === undefined) return undefined;
  return { baseFood, baseMoraleCare };
}

function validateHazard(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): OutpostHazardContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const intensity = expectNumber(obj["intensity"], `${path}.intensity`, issues, HAZARD_UNIT_RANGE);
  const growth = expectNumber(obj["growth"], `${path}.growth`, issues, HAZARD_GROWTH_RANGE);
  const min = expectNumber(obj["min"], `${path}.min`, issues, HAZARD_UNIT_RANGE);
  const max = expectNumber(obj["max"], `${path}.max`, issues, HAZARD_UNIT_RANGE);
  if (intensity === undefined || growth === undefined || min === undefined || max === undefined) {
    return undefined;
  }
  if (min > max) {
    issues.add(path, `hazard.min (${String(min)}) は hazard.max (${String(max)}) 以下が必須`);
    return undefined;
  }
  if (intensity < min || intensity > max) {
    issues.add(
      path,
      `hazard.intensity (${String(intensity)}) は [min, max] = [${String(min)}, ${String(max)}] の範囲内が必須`,
    );
    return undefined;
  }
  return { intensity, growth, min, max };
}

export function validateOutpostType(raw: unknown): ValidationResult<OutpostTypeContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const resource = validateId(obj["resource"], "$.resource", issues);
  const baseSupply = expectNumber(obj["baseSupply"], "$.baseSupply", issues, SUPPLY_VALUE_RANGE);
  const capacityCurve = validateCapacityCurve(obj["capacityCurve"], "$.capacityCurve", issues);
  const upkeepFormula = validateUpkeepFormula(obj["upkeepFormula"], "$.upkeepFormula", issues);
  const hazard = validateHazard(obj["hazard"], "$.hazard", issues);
  const shadeSensitivity = expectNumber(
    obj["shadeSensitivity"],
    "$.shadeSensitivity",
    issues,
    SHADE_SENSITIVITY_RANGE,
  );

  if (
    id === undefined ||
    resource === undefined ||
    baseSupply === undefined ||
    capacityCurve === undefined ||
    upkeepFormula === undefined ||
    hazard === undefined ||
    shadeSensitivity === undefined
  ) {
    return fail(issues.list());
  }

  // capacityCurve[0] は baseSupply と一致すること(二重の真実を作らない・ファイル冒頭)。
  if (capacityCurve[0] !== baseSupply) {
    issues.add(
      "$.capacityCurve[0]",
      `capacityCurve[0](${String(capacityCurve[0])})は baseSupply(${String(baseSupply)})と一致が必須`,
    );
    return fail(issues.list());
  }

  return ok({ id, resource, baseSupply, capacityCurve, upkeepFormula, hazard, shadeSensitivity });
}
