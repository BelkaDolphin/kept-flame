// ---------------------------------------------------------------------------
// facility content スキーマ — GDD §6.1/§6.2/§12.1、ADR「共通規約」602行以降
//
// 施設は「上限値管理のみに役割限定」(GDD 12.1)。隣接効果の実体は
// adjacency.json のタグ×タグ行列側にあり、facility は自身が持つタグ集合
// (FACILITY_TAGS の部分集合)だけを申告する。この FACILITY_TAGS が
// adjacency.ts のタグ全域(TAG_UNIVERSE)としても再利用される単一ソース。
//
// タグ7種の英字IDは docs/design/tags-spec.md 末尾の機械可読 JSON(T13後半)を
// 出典とする: heat/clean/foul/noise/damp/calm/lore。
//
// ---------------------------------------------------------------------------
// [T7] 縮約 rules 向け追加フィールド `harshWork` / `output`(いずれも省略可)
// ---------------------------------------------------------------------------
// engine の縮約 rules(`src/engine/rules/types.ts` の FacilityDef)は
//   harshWork : GDD 11.2 の loadW を ×2.0(過酷業務)/ ×0.5(通常)に振り分ける
//   output    : GDD 11.1 の産出先(resource ストック / 研究点)
// を要求するが、ADR「entity スキーマ」616行の facility スケッチにはどちらも無い
// (最終形では産出先は recipe entity 側に載る想定であり、recipe カテゴリは
// T6/T7 のロード対象外)。そこで本スキーマでは **省略可**(欠落は null)として
// additive に受け付け、「engine へ写すのに必須」の強制は content ローダー
// (schema/engineContent.ts)側で行う:
//   - schema 段: 形式のみ検証(既存 content・既存テストを壊さない)
//   - loader 段: 欠落を reject(縮約 rules が読む値を黙って既定値で埋めない)
// recipe カテゴリを追加する際に `output` の出所をそちらへ移すこと。
//
// ---------------------------------------------------------------------------
// [M5] 追加フィールド `statWeights` / `storageCapacityCurve` / `storedResourceIds`
// ---------------------------------------------------------------------------
// いずれも **省略可**。同じく「schema 段は形式のみ・省略を許す」「loader 段が
// engine への写し方を決める」の二段構えで、既存 content と既存テストを壊さない。
//   statWeights          : GDD 11.1「Σ担当者**関連**ステータス寄与」の「関連」。
//                          ステータス 5 種(裁定 B8)への重みで、**総和 1.0** を
//                          要求する(中立性の根拠 = src/engine/rules/stats.ts §2)。
//                          省略時は engine 側の等分既定(各 0.2)。
//   storageCapacityCurve : GDD 6.7 / 12.1「施設側は上限値管理のみに役割限定」。
//                          Lv 別の保管容量。省略時は容量を提供しない。
//   storedResourceIds    : 容量の対象資源。省略/null は全資源(汎用倉庫)。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
  expectBoolean,
  expectEnum,
  expectInteger,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type ValidationResult,
} from "./common";

/** タグ7種(GDD 6.2: 熱源/清浄/汚染/騒音/湿潤/静穏/学芸)。adjacency.ts と共有する唯一のソース。 */
export const FACILITY_TAGS = ["heat", "clean", "foul", "noise", "damp", "calm", "lore"] as const;
export type FacilityTag = (typeof FACILITY_TAGS)[number];

function isFacilityTag(value: string): value is FacilityTag {
  return (FACILITY_TAGS as readonly string[]).includes(value);
}

/** GDD 6.1: 1セル=1施設(大型は2×1/2×2占有)。width/height はセル数。 */
const FOOTPRINT_DIMENSION_RANGE = { min: 1, max: 2 };

/** GDD 7.7: 就労スロットは施設ごと・Lvで増加。負値は無効、上限は保守的な目安値。 */
const SLOT_RANGE = { min: 0, max: 20 };

/** ADR「entity スキーマ」616行: lvCurve = base × 1.15^(Lv-1) の個別FP展開値。正の値のみ。 */
const LV_CURVE_LENGTH = 5;
const LV_CURVE_VALUE_RANGE = { min: 0.000001, max: 1_000_000_000 };

export interface FacilitySlots {
  readonly lv1: number;
  readonly lv2: number;
  readonly lv3: number;
  readonly lv4: number;
  readonly lv5: number;
}

export interface FacilityFootprint {
  readonly width: number;
  readonly height: number;
}

/** GDD 11.1 の産出先。研究点は resource ストックではなく研究進行度へ入る。 */
export const FACILITY_OUTPUT_KINDS = ["resource", "research"] as const;
export type FacilityOutputKind = (typeof FACILITY_OUTPUT_KINDS)[number];

/** `output`(省略可)。resource の場合のみ産出先 ID を持つ。 */
export type FacilityOutputContent =
  { readonly kind: "resource"; readonly resourceId: string } | { readonly kind: "research" };

/** [M5] ステータス 5 種(裁定 B8)への重み。総和 1.0(検証はローダー側)。 */
export const RESIDENT_STAT_KEYS = ["vigor", "dexterity", "intellect", "fortitude", "will"] as const;
export type ResidentStatKey = (typeof RESIDENT_STAT_KEYS)[number];

/** [M5] 重みは 0〜1(総和 1.0 の突き合わせは engineContent.ts が行う)。 */
const STAT_WEIGHT_RANGE = { min: 0, max: 1 };

/** [M5] 保管容量の Lv 別カーブ。lvCurve と同じ長さ・非負。 */
const CAPACITY_VALUE_RANGE = { min: 0, max: 1_000_000_000 };

export type FacilityStatWeights = { readonly [K in ResidentStatKey]: number };

export interface FacilityContent {
  readonly id: string;
  readonly tags: readonly FacilityTag[];
  readonly slots: FacilitySlots;
  readonly lvCurve: readonly number[];
  readonly overflowCapPolicy: string;
  readonly footprint: FacilityFootprint;
  /** [M5] ステータス重み。JSON に無ければ null(engine 側が等分既定を使う)。 */
  readonly statWeights: FacilityStatWeights | null;
  /** [M5] Lv 別の保管容量。JSON に無ければ null(容量を提供しない)。 */
  readonly storageCapacityCurve: readonly number[] | null;
  /** [M5] 容量の対象資源 ID。JSON に無ければ null(= 全資源)。 */
  readonly storedResourceIds: readonly string[] | null;
  /**
   * GDD 11.2 の過酷業務(製錬/鍛冶/高炉等)か。JSON に無ければ null
   * (= engine へ写す段で reject。ファイル冒頭 [T7] の節を参照)。
   */
  readonly harshWork: boolean | null;
  /** GDD 11.1 の産出先。JSON に無ければ null(同上)。 */
  readonly output: FacilityOutputContent | null;
}

const SLOT_LEVEL_KEYS = ["lv1", "lv2", "lv3", "lv4", "lv5"] as const;

function validateTags(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly FacilityTag[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length === 0) {
    issues.add(path, "tags は1個以上必須");
    return undefined;
  }
  const issuesBefore = issues.list().length;
  const tags: FacilityTag[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (typeof entry !== "string" || !isFacilityTag(entry)) {
      issues.add(
        `${path}[${String(i)}]`,
        `タグは ${FACILITY_TAGS.join(" | ")} のいずれかが必須(実際: ${JSON.stringify(entry)})`,
      );
      continue;
    }
    if (seen.has(entry)) {
      issues.add(`${path}[${String(i)}]`, `タグ "${entry}" が重複`);
      continue;
    }
    seen.add(entry);
    tags.push(entry);
  }
  // 個別タグの欠陥は continue で集約しつつ全件走査するが(1回で全欠陥を報告)、
  // 1件でも欠陥があれば呼び出し元には undefined を返し reject させる。
  return issues.list().length === issuesBefore ? tags : undefined;
}

function validateSlots(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilitySlots | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const values: number[] = [];
  for (const key of SLOT_LEVEL_KEYS) {
    const n = expectInteger(obj[key], `${path}.${key}`, issues, SLOT_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    if (cur < prev) {
      issues.add(
        path,
        `slots は Lv が上がるにつれ単調非減少が必須(GDD 7.7「Lvで増加」): ${values.join(",")}`,
      );
      return undefined;
    }
  }
  const [lv1, lv2, lv3, lv4, lv5] = values;
  return {
    lv1: lv1 ?? 0,
    lv2: lv2 ?? 0,
    lv3: lv3 ?? 0,
    lv4: lv4 ?? 0,
    lv5: lv5 ?? 0,
  };
}

function validateLvCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `lvCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, LV_CURVE_VALUE_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    if (cur <= prev) {
      issues.add(
        path,
        `lvCurve は Lv が上がるにつれ狭義単調増加が必須(base × 1.15^(Lv-1)): ${values.join(",")}`,
      );
      return undefined;
    }
  }
  return values;
}

function validateFootprint(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityFootprint | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const width = expectInteger(obj["width"], `${path}.width`, issues, FOOTPRINT_DIMENSION_RANGE);
  const height = expectInteger(obj["height"], `${path}.height`, issues, FOOTPRINT_DIMENSION_RANGE);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

/**
 * `output`(省略可)の検証。`kind` が resource のときだけ `resourceId` を要求する。
 * resource カテゴリは T6/T7 のロード対象外なので**実在確認は行わない**
 * (産出先 entity の不在は engine 側の applyProduction が実行時に reject する)。
 */
function validateOutput(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityOutputContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const kind = expectEnum(obj["kind"], FACILITY_OUTPUT_KINDS, `${path}.kind`, issues);
  if (kind === undefined) return undefined;
  if (kind === "research") return { kind: "research" };
  const resourceId = validateId(obj["resourceId"], `${path}.resourceId`, issues);
  if (resourceId === undefined) return undefined;
  return { kind: "resource", resourceId };
}

/** [M5] `statWeights`(省略可)の検証。5 種すべてを要求する(部分指定は曖昧)。 */
function validateStatWeights(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityStatWeights | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const values: number[] = [];
  for (const key of RESIDENT_STAT_KEYS) {
    const n = expectNumber(obj[key], `${path}.${key}`, issues, STAT_WEIGHT_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  const [vigor, dexterity, intellect, fortitude, will] = values;
  return {
    vigor: vigor ?? 0,
    dexterity: dexterity ?? 0,
    intellect: intellect ?? 0,
    fortitude: fortitude ?? 0,
    will: will ?? 0,
  };
}

/** [M5] `storageCapacityCurve`(省略可)の検証。Lv1〜Lv5 の 5 個・非負。 */
function validateCapacityCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `storageCapacityCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, CAPACITY_VALUE_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  return values;
}

/** [M5] `storedResourceIds`(省略可)の検証。ID 規則に一致する文字列の配列。 */
function validateStoredResourceIds(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly string[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  const ids: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const value = validateId(arr[i], `${path}[${String(i)}]`, issues);
    if (value === undefined) return undefined;
    ids.push(value);
  }
  return ids;
}

export function validateFacility(raw: unknown): ValidationResult<FacilityContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const tags = validateTags(obj["tags"], "$.tags", issues);
  const slots = validateSlots(obj["slots"], "$.slots", issues);
  const lvCurve = validateLvCurve(obj["lvCurve"], "$.lvCurve", issues);
  const overflowCapPolicy = expectString(obj["overflowCapPolicy"], "$.overflowCapPolicy", issues);
  const footprint = validateFootprint(obj["footprint"], "$.footprint", issues);

  // 省略可フィールド: キーが無ければ null、あれば形式を検証する。
  const rawHarshWork = obj["harshWork"];
  const harshWork =
    rawHarshWork === undefined
      ? null
      : (expectBoolean(rawHarshWork, "$.harshWork", issues) ?? undefined);
  const rawOutput = obj["output"];
  const output =
    rawOutput === undefined ? null : (validateOutput(rawOutput, "$.output", issues) ?? undefined);

  // [M5] 追加の省略可フィールド。
  const rawStatWeights = obj["statWeights"];
  const statWeights =
    rawStatWeights === undefined
      ? null
      : (validateStatWeights(rawStatWeights, "$.statWeights", issues) ?? undefined);
  const rawCapacityCurve = obj["storageCapacityCurve"];
  const storageCapacityCurve =
    rawCapacityCurve === undefined
      ? null
      : (validateCapacityCurve(rawCapacityCurve, "$.storageCapacityCurve", issues) ?? undefined);
  const rawStoredResourceIds = obj["storedResourceIds"];
  const storedResourceIds =
    rawStoredResourceIds === undefined
      ? null
      : (validateStoredResourceIds(rawStoredResourceIds, "$.storedResourceIds", issues) ??
        undefined);

  if (
    id === undefined ||
    tags === undefined ||
    slots === undefined ||
    lvCurve === undefined ||
    overflowCapPolicy === undefined ||
    footprint === undefined ||
    harshWork === undefined ||
    output === undefined ||
    statWeights === undefined ||
    storageCapacityCurve === undefined ||
    storedResourceIds === undefined
  ) {
    return fail(issues.list());
  }

  return ok({
    id,
    tags,
    slots,
    lvCurve,
    overflowCapPolicy,
    footprint,
    harshWork,
    output,
    statWeights,
    storageCapacityCurve,
    storedResourceIds,
  });
}
