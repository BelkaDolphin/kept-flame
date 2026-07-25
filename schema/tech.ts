// ---------------------------------------------------------------------------
// tech content スキーマ — GDD §5/§12.1、ADR「entity スキーマ」608行
//
// この検証器はエンティティ単体の形(型・レンジ・enum)だけを見る。prereqs の
// 実在確認・自己参照禁止・循環検出・fieldRequirement.facility の実在確認は
// 他カテゴリ(facility)を跨ぐため contentBundle.ts 側の責務とする。
//
// スコープ外(意図的に未実装。T6 は最小セット):
//   - GDD 12.3 の researchCost 目安レンジ機械算出(era内で取り得る n の
//     最小〜最大値を prereq グラフから求め base_era×1.2^n の ±25% 以内か
//     検証するアルゴリズム)。到達可能な n の全域計算は分岐トポロジ依存で
//     複雑度が高く、最小 schema の対象外とした。researchCost は「正の整数」
//     という形式チェックのみ行う。実装は followup。
//   - fieldRequirement.recipe / unlocks の対象カテゴリ(recipe/era)は T6 の
//     ロード対象に含まれないため、実在確認は行わずフォーマットのみ検証する。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
  expectBoolean,
  expectEnum,
  expectInteger,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type ValidationResult,
} from "./common";

/** GDD 7.4: (A)必ず再取得可能 / (B)一回性喪失を許容。 */
export const TECH_LOSS_CLASSES = ["criticalRecoverable", "rareIrreversible"] as const;
export type TechLossClass = (typeof TECH_LOSS_CLASSES)[number];

/** GDD 5.1: クリティカルパスの前提は1〜3個。ただし era 起点(壁テックへ向かう最初の一歩)は0個を許容する。 */
const MAX_PREREQS = 3;

const RESEARCH_COST_RANGE = { min: 1, max: 1_000_000 };
const FIELD_REQUIREMENT_COUNT_RANGE = { min: 1, max: 1_000 };

export interface TechFieldRequirement {
  readonly facility: string;
  readonly recipe: string;
  readonly count: number;
}

export interface TechContent {
  readonly id: string;
  readonly era: string;
  readonly lossClass: TechLossClass;
  readonly prereqs: readonly string[];
  readonly researchCost: number;
  readonly fieldRequirement: TechFieldRequirement;
  readonly unlocks: readonly string[];
  readonly leaf: boolean;
}

function validatePrereqs(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly string[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length > MAX_PREREQS) {
    issues.add(path, `prereqs は最大 ${String(MAX_PREREQS)} 個(GDD 5.1)`);
    return undefined;
  }
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const id = validateId(arr[i], `${path}[${String(i)}]`, issues);
    if (id === undefined) return undefined;
    result.push(id);
  }
  return result;
}

function validateUnlocks(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly string[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  const result: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const id = validateId(arr[i], `${path}[${String(i)}]`, issues);
    if (id === undefined) return undefined;
    result.push(id);
  }
  return result;
}

function validateFieldRequirement(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): TechFieldRequirement | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const facility = validateId(obj["facility"], `${path}.facility`, issues);
  const recipe = validateId(obj["recipe"], `${path}.recipe`, issues);
  const count = expectInteger(obj["count"], `${path}.count`, issues, FIELD_REQUIREMENT_COUNT_RANGE);
  if (facility === undefined || recipe === undefined || count === undefined) return undefined;
  return { facility, recipe, count };
}

export function validateTech(raw: unknown): ValidationResult<TechContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const era = expectString(obj["era"], "$.era", issues);
  const lossClass = expectEnum(obj["lossClass"], TECH_LOSS_CLASSES, "$.lossClass", issues);
  const prereqs = validatePrereqs(obj["prereqs"], "$.prereqs", issues);
  const researchCost = expectInteger(
    obj["researchCost"],
    "$.researchCost",
    issues,
    RESEARCH_COST_RANGE,
  );
  const fieldRequirement = validateFieldRequirement(
    obj["fieldRequirement"],
    "$.fieldRequirement",
    issues,
  );
  const unlocks = validateUnlocks(obj["unlocks"], "$.unlocks", issues);
  const leaf = expectBoolean(obj["leaf"], "$.leaf", issues);

  if (
    id === undefined ||
    era === undefined ||
    lossClass === undefined ||
    prereqs === undefined ||
    researchCost === undefined ||
    fieldRequirement === undefined ||
    unlocks === undefined ||
    leaf === undefined
  ) {
    return fail(issues.list());
  }

  if (prereqs.includes(id)) {
    issues.add("$.prereqs", `自己参照 prereq は禁止("${id}")`);
    return fail(issues.list());
  }

  return ok({ id, era, lossClass, prereqs, researchCost, fieldRequirement, unlocks, leaf });
}
