// ---------------------------------------------------------------------------
// trait content スキーマ — GDD §7.2/§12.1、ADR「entity スキーマ」608行
//
// `trait(id, effects[{stat,op[mul|add],value(min/max)}], stackRule,
//  maxPerResident=3)` を最小実装する。
//
// **[M7] 種別別レンジの精密化を実施した(旧コメントの追随課題を解消)。**
// 旧実装は「stat レジストリが未確定」を理由に mul を [0.7, 1.5] の外側包絡線
// 1 本で見ていたが、裁定 B8(ステータス正本 5 種 + 派生値 `combatPower`)が
// 確定したので、GDD 7.2 の「ステータス倍率 ±30% 以内」を該当キーにだけ厳格へ
// 適用する:
//   - 基礎ステ 5 種 / 派生値 `combatPower` への mul : [0.7, 1.3]
//   - それ以外(`yieldMul` / 成文化速度など)への mul : [0.7, 1.5]
// add は GDD に明示レンジが無いため従来どおり ±30(0〜100 スケール上の保守境界)。
//
// **キー語彙そのものの受理/拒否はここでは行わない。** 「写せる語彙か・未実装
// ゆえ読み飛ばす語彙か・未知ゆえ reject か」の 3 分類は engine の実装状況に
// 依存する判断であり、レジストリは `schema/engineContent.ts` §1(e) が単独で
// 持つ(2 箇所に分けると必ず食い違う)。本ファイルは「どのキー種別なら
// どの数値レンジか」だけを見る。
// ---------------------------------------------------------------------------

import { RESIDENT_DERIVED_STAT_IDS, RESIDENT_STAT_IDS } from "../src/engine/rules/stats";
import { MAX_TRAITS_PER_RESIDENT } from "../src/engine/state/state";
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

/** GDD 7.2「ステータス倍率 ±30% 以内」。基礎ステ 5 種と派生値に適用(§冒頭 [M7])。 */
const STAT_MUL_VALUE_RANGE = { min: 0.7, max: 1.3 };
/** ステータス以外(成文化速度・`yieldMul` 等)の倍率レンジ(GDD 7.2 の代表値)。 */
const MUL_VALUE_RANGE = { min: 0.7, max: 1.5 };
/** ステータスは0〜100スケール(GDD 7.1)。加算効果の保守境界(GDD に明示レンジ無し)。 */
const ADD_VALUE_RANGE = { min: -30, max: 30 };

/**
 * [M7] mul のレンジが厳格側([0.7,1.3])になるキー = 裁定 B8 のステータス
 * 名前空間(基礎 5 種 + 派生値)。engine 側の正本レジストリをそのまま使うので、
 * 正本が増えたらここも自動的に追随する。
 */
const STAT_NAMESPACE_KEYS: ReadonlySet<string> = new Set<string>([
  ...RESIDENT_STAT_IDS,
  ...RESIDENT_DERIVED_STAT_IDS,
]);

/** GDD 7.2「暴走」対策の目安上限(GDD に明示無し。保守値)。 */
const MAX_EFFECTS = 6;

/**
 * GDD 7.2: 1住民の trait 保持上限は3個に固定(スキーマ強制)。
 * 値の正本は engine 側({@link MAX_TRAITS_PER_RESIDENT})— state 側の強制と
 * content 側の強制が食い違わないよう定数を共有する。
 */
const MAX_PER_RESIDENT_FIXED = MAX_TRAITS_PER_RESIDENT;

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
  const range =
    op === "add"
      ? ADD_VALUE_RANGE
      : STAT_NAMESPACE_KEYS.has(stat)
        ? STAT_MUL_VALUE_RANGE
        : MUL_VALUE_RANGE;
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
