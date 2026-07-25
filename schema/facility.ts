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
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
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

export interface FacilityContent {
  readonly id: string;
  readonly tags: readonly FacilityTag[];
  readonly slots: FacilitySlots;
  readonly lvCurve: readonly number[];
  readonly overflowCapPolicy: string;
  readonly footprint: FacilityFootprint;
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

  if (
    id === undefined ||
    tags === undefined ||
    slots === undefined ||
    lvCurve === undefined ||
    overflowCapPolicy === undefined ||
    footprint === undefined
  ) {
    return fail(issues.list());
  }

  return ok({ id, tags, slots, lvCurve, overflowCapPolicy, footprint });
}
