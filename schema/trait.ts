// ---------------------------------------------------------------------------
// trait content スキーマ — GDD §7.2/§12.1、ADR「entity スキーマ」608行
//
// `trait(id, effects[{stat,op[mul|add],value(min/max)}], stackRule,
//  maxPerResident=3)` を最小実装する。
//
// value のレンジ(mul/add それぞれ)は GDD 7.2 が挙げる代表例
// (ステータス倍率±30%以内=[0.7,1.3] / 成文化速度倍率0.7〜1.5等)の外側
// 包絡線を採用した保守境界であり、係数種別(どの stat か)ごとの精密なレンジ
// 分けは行っていない。GDD はステータス種別ごとの数値キー名を定めておらず
// (それは production rule 実装側=T5 が確定する)、種別別レンジの精密化は
// stat レジストリが定まった後の追随課題としてここに明記する。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
  expectEnum,
  expectExactNumber,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type ValidationResult,
} from "./common";

export const TRAIT_OPS = ["mul", "add"] as const;
export type TraitOp = (typeof TRAIT_OPS)[number];

/** GDD 7.2 が挙げる代表レンジ(±30%=[0.7,1.3]、成文化速度=[0.7,1.5])の外側包絡線。 */
const MUL_VALUE_RANGE = { min: 0.7, max: 1.5 };
/** ステータスは0〜100スケール(GDD 7.1)。加算効果の保守境界(GDD に明示レンジ無し)。 */
const ADD_VALUE_RANGE = { min: -30, max: 30 };

/** GDD 7.2「暴走」対策の目安上限(GDD に明示無し。保守値)。 */
const MAX_EFFECTS = 6;

/** GDD 7.2: 1住民の trait 保持上限は3個に固定(スキーマ強制)。 */
const MAX_PER_RESIDENT_FIXED = 3;

export interface TraitEffect {
  readonly stat: string;
  readonly op: TraitOp;
  readonly value: number;
}

export interface TraitContent {
  readonly id: string;
  readonly effects: readonly TraitEffect[];
  readonly stackRule: string;
  readonly maxPerResident: number;
}

function validateEffect(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): TraitEffect | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const stat = expectString(obj["stat"], `${path}.stat`, issues);
  const op = expectEnum(obj["op"], TRAIT_OPS, `${path}.op`, issues);
  if (stat === undefined || op === undefined) return undefined;
  const range = op === "mul" ? MUL_VALUE_RANGE : ADD_VALUE_RANGE;
  const value = expectNumber(obj["value"], `${path}.value`, issues, range);
  if (value === undefined) return undefined;
  return { stat, op, value };
}

function validateEffects(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly TraitEffect[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length === 0) {
    issues.add(path, "effects は1個以上必須");
    return undefined;
  }
  if (arr.length > MAX_EFFECTS) {
    issues.add(path, `effects は最大 ${String(MAX_EFFECTS)} 個`);
    return undefined;
  }
  const result: TraitEffect[] = [];
  for (let i = 0; i < arr.length; i++) {
    const effect = validateEffect(arr[i], `${path}[${String(i)}]`, issues);
    if (effect === undefined) return undefined;
    result.push(effect);
  }
  return result;
}

export function validateTrait(raw: unknown): ValidationResult<TraitContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const effects = validateEffects(obj["effects"], "$.effects", issues);
  const stackRule = expectString(obj["stackRule"], "$.stackRule", issues);
  const maxPerResident = expectExactNumber(
    obj["maxPerResident"],
    MAX_PER_RESIDENT_FIXED,
    "$.maxPerResident",
    issues,
  );

  if (
    id === undefined ||
    effects === undefined ||
    stackRule === undefined ||
    maxPerResident === undefined
  ) {
    return fail(issues.list());
  }

  return ok({ id, effects, stackRule, maxPerResident });
}
