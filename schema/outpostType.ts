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
//
// ---------------------------------------------------------------------------
// [M75] 追加フィールド `buildCost`(GDD 9.2 [2026-08-07裁定]・台帳v24 / M39 ③)
// ---------------------------------------------------------------------------
// 旧裁定([2026-08-01裁定・台帳v8 追-2])は「拠点の設置コストは MVP ではゼロ。
// 導入する場合は `outpostType` スキーマへの content 項目追加として行う」であり、
// M39 のトリアージ(`docs/measurements/balance-m39-2026-08-07.json` の ③)が
// 「facility の `buildCost`(M65 で単一形→複数資源形へ拡幅済み)と同じ形を
// outpostType へ横展開する」を推奨案として出した。本フィールドがその実装である。
//
//   単一形: { "resourceId": "firewood", "amount": 40 }
//   配列形: [ { "resourceId": "firewood", "amount": 40 },
//             { "resourceId": "iron", "amount": 12 } ]
//
// facility 側との差は 1 点だけ:**増築コスト(`upgradeCostCurve`)を持たない**。
// 拠点に増築コマンドが無い(`IMPLEMENTED_COMMAND_KINDS` に upgradeOutpost は
// 無く、`establishOutpost` は常に Lv1 で据える)ため、書けても読む場所が無い
// キーを増やさない。よって M65 の非対称規約(第1行は増築費を持てない / 第2行
// 以降は必須)もここには無く、行は「資源 ID + 量」だけである。
//
// **省略可**(JSON に無ければ null = 設置は無料 = M24〜M74 と 1 bit も違わない)。
// facility の `buildCost` がローダー必須(欠落を reject)なのに対しこちらを
// 省略可のままにするのは、既存の conformance 凍結スナップショット
// (`conformance/content-snapshot/outpostType.json`)と engine 側テスト
// フィクスチャを 1 バイトも変えずに通すため(schema/facility.ts 冒頭 [T7] の
// 二段構えを「省略 = 無料」側へ倒した形)。実 content の 3 タイプは
// `content/outpostType.json` で全て明示している。
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

/** [M75] 設置コストの値域(`schema/facility.ts` の `COST_VALUE_RANGE` と同じ境界)。 */
const COST_VALUE_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

/** [M75] 設置コスト 1 行(資源 ID + 量)。増築コストは持たない(ファイル冒頭 [M75])。 */
export interface OutpostBuildCostLine {
  readonly resourceId: string;
  readonly amount: number;
}

/**
 * [M75] `buildCost` が取りうる形。単一オブジェクト形と 1 行以上の配列形
 * (ファイル冒頭 [M75] の節が規約の正本)。
 */
export type OutpostBuildCostContent = OutpostBuildCostLine | readonly OutpostBuildCostLine[];

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
  /**
   * [M75] 設置コスト(GDD 9.2 [2026-08-07裁定])。JSON に無ければ null
   * (= 設置は無料。ファイル冒頭 [M75] の節)。
   */
  readonly buildCost: OutpostBuildCostContent | null;
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

/** [M75] 設置コスト 1 行(資源 ID + 非負の量)の検証。 */
function validateBuildCostLine(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): OutpostBuildCostLine | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const resourceId = validateId(obj["resourceId"], `${path}.resourceId`, issues);
  const amount = expectNumber(obj["amount"], `${path}.amount`, issues, COST_VALUE_RANGE);
  if (resourceId === undefined || amount === undefined) return undefined;
  return { resourceId, amount };
}

/**
 * [M75] `buildCost`(省略可)の検証。単一オブジェクト形と配列形の union
 * (ファイル冒頭 [M75])。配列形は 1 行以上・資源 ID の重複禁止。
 */
function validateBuildCost(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): OutpostBuildCostContent | undefined {
  if (!Array.isArray(raw)) return validateBuildCostLine(raw, path, issues);
  if (raw.length === 0) {
    issues.add(path, "buildCost の配列形は 1 行以上が必須(空配列は無料と区別できない)");
    return undefined;
  }
  const lines: OutpostBuildCostLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const line = validateBuildCostLine(raw[i], `${path}[${String(i)}]`, issues);
    if (line === undefined) return undefined;
    if (seen.has(line.resourceId)) {
      issues.add(
        `${path}[${String(i)}].resourceId`,
        `資源 "${line.resourceId}" が buildCost に 2 行ある(1 資源 1 行)`,
      );
      return undefined;
    }
    seen.add(line.resourceId);
    lines.push(line);
  }
  return lines;
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
  // [M75] 省略可(欠落は null = 無料)。値があれば形を検査する。
  const rawBuildCost = obj["buildCost"];
  const buildCost =
    rawBuildCost === undefined
      ? null
      : (validateBuildCost(rawBuildCost, "$.buildCost", issues) ?? undefined);

  if (
    id === undefined ||
    resource === undefined ||
    baseSupply === undefined ||
    capacityCurve === undefined ||
    upkeepFormula === undefined ||
    hazard === undefined ||
    shadeSensitivity === undefined ||
    buildCost === undefined
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

  return ok({
    id,
    resource,
    baseSupply,
    capacityCurve,
    upkeepFormula,
    hazard,
    shadeSensitivity,
    buildCost,
  });
}
