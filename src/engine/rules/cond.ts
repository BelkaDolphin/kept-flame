// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- event cond DSL の**評価器** — GDD 12.2 / ADR-006 / M22
//
// ===========================================================================
// 1. パースは engine の外、評価は engine の中(役割分担の根拠)
// ===========================================================================
//   GDD 12.2 は cond を「jsep AST のホワイトリスト」として固定すると定める。
//   しかし jsep は npm パッケージであり、engine は**非相対 import が全面禁止**
//   (eslint.config.js SYNTAX_IMPORT / OUTER_LAYER_GROUPS)である。したがって
//   engine 内で cond 文字列をパースすることはできないし、してはならない。
//
//   そこで責務を 2 つに割る:
//     (a) **文字列 → AST** : `schema/event.ts` が jsep でパースし、ホワイトリスト
//         (許可ノード種 / 許可識別子 / 許可演算子 / 許可関数)へ照合する。
//     (b) **AST → 内部表現 → 真偽値** : `schema/engineContent.ts` が (a) の結果を
//         本ファイルの {@link CondExpr}(engine 内部表現)へ**コンパイル**し、
//         engine は {@link evaluateCond} でそれを歩くだけにする。
//
//   この分割には副産物が 3 つある:
//     - 実行時に文字列パースが 1 度も走らない(ADR-029 のアロケーション有界化)。
//     - `no-eval` / `no-new-func`(engine 純粋性ルール)と構造的に無縁になる。
//     - **型検査をロード時に済ませられる**(§3)。派遣確定コマンドの最中に
//       「string と number を比較した」で例外を投げる経路が消える。
//
// ===========================================================================
// 2. 数値はすべて 1e6 固定小数点(検収条件「浮動小数を 1 度も通らない」)
// ===========================================================================
//   {@link CondValue} の数値枝は {@link Fix} しか持たない。比較は
//   `toRaw(a) < toRaw(b)` のような**整数比較**だけで行い、除算・乗算・
//   Math 関数は 1 つも使わない。content の数値リテラル(`0.15` 等)は
//   `schema/engineContent.ts` の `rawFromHumanNumber`(10 進文字列経由の厳密変換)
//   で Fix になってからここへ来るので、倍精度の丸めが混入する経路が無い。
//   `injuryCount` のような整数量も {@link fixFromInt} で Fix にしてから比較する
//   (「整数どうしなら素の number でよい」を許すと、混在した式で暗黙変換が
//   必要になり、そこが浮動小数の入口になる)。
//
// ===========================================================================
// 3. 静的型付け(ロード時に落とす)
// ===========================================================================
//   変数・関数の戻り型はすべて静的に決まる({@link condVariableType} /
//   {@link condFunctionType})。よって {@link condExprType} が AST を 1 度歩けば
//   式全体の型が決まり、
//     - 比較の両辺の型不一致
//     - 大小比較に string / boolean を使う
//     - `&&` / `||` の被演算子が boolean でない
//     - cond 全体が boolean にならない
//   をすべて**ロード時に reject** できる。engine 側の {@link evaluateCond} は
//   その保証の下で動くが、セーブ由来の壊れた入力に備えて防御的な
//   {@link CondError} も残してある(黙って false を返さない)。
//
// ===========================================================================
// 4. 語彙(GDD 12.2 の変数一覧に engine 側の意味を与えたもの)
// ===========================================================================
//   GDD 12.2 は変数名しか定めていないので、意味づけは M22 の裁定である
//   (要ユーザー判断として報告する)。{@link CondContext} の各フィールドの doc に
//   1 つずつ根拠を書いてある。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import { FIX_ZERO, fixFromInt, toRaw, type Fix } from "../fp";

/** cond の評価/型付けの誤り(ロード側で落としきれなかった場合の防御)。 */
export class CondError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CondError";
  }
}

// --- 1. 語彙(GDD 12.2) -----------------------------------------------------

/**
 * 裸の識別子として書ける変数(GDD 12.2 の変数一覧のうち関数でないもの)。
 * 並びは UTF-16 昇順(集合演算の安定順序・GDD 11.7)。
 */
export const COND_VARIABLES = [
  "difficulty",
  "equipType",
  "injuryCount",
  "statWeights",
  "teamPower",
] as const;

/** {@link COND_VARIABLES} のいずれか。 */
export type CondVariable = (typeof COND_VARIABLES)[number];

/** 未知の文字列が cond 変数のいずれかか(型ガード)。 */
export function isCondVariable(value: string): value is CondVariable {
  for (const name of COND_VARIABLES) {
    if (name === value) return true;
  }
  return false;
}

/**
 * 引数 1 個の関数(ADR「entity スキーマ」633行
 * 「hasTrait(traitId)/maxStatHolder(stat)等の引数付き関数」)。
 */
export const COND_FUNCTIONS = ["hasTrait", "maxStatHolder"] as const;

/** {@link COND_FUNCTIONS} のいずれか。 */
export type CondFunction = (typeof COND_FUNCTIONS)[number];

/** 未知の文字列が cond 関数のいずれかか(型ガード)。 */
export function isCondFunction(value: string): value is CondFunction {
  for (const name of COND_FUNCTIONS) {
    if (name === value) return true;
  }
  return false;
}

/** GDD 12.2 の許可演算子のうち比較演算子(UTF-16 昇順)。 */
export const COND_COMPARE_OPERATORS = ["!=", "<", "<=", "==", ">", ">="] as const;

/** {@link COND_COMPARE_OPERATORS} のいずれか。 */
export type CondCompareOperator = (typeof COND_COMPARE_OPERATORS)[number];

/** 大小比較(= 数値どうしにしか使えない演算子)。 */
const ORDERING_OPERATORS: readonly CondCompareOperator[] = ["<", "<=", ">", ">="];

/** GDD 12.2 の許可演算子のうち論理演算子。 */
export const COND_LOGICAL_OPERATORS = ["&&", "||"] as const;

/** {@link COND_LOGICAL_OPERATORS} のいずれか。 */
export type CondLogicalOperator = (typeof COND_LOGICAL_OPERATORS)[number];

/** cond の値の型(§3 の静的型)。 */
export const COND_TYPES = ["boolean", "number", "string"] as const;

/** {@link COND_TYPES} のいずれか。 */
export type CondType = (typeof COND_TYPES)[number];

// --- 2. 値と式(engine 内部表現) --------------------------------------------

/**
 * cond の値。**数値枝は {@link Fix} のみ**(§2)。
 */
export type CondValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly valueFix: Fix }
  | { readonly kind: "string"; readonly value: string };

/**
 * cond の内部表現(コンパイル済み AST)。`schema/event.ts` の jsep AST と
 * 1 対 1 に対応するが、**engine 側の型だけで閉じている**(jsep 型に依存しない)。
 */
export type CondExpr =
  | { readonly kind: "literal"; readonly value: CondValue }
  | { readonly kind: "variable"; readonly name: CondVariable }
  | { readonly kind: "call"; readonly fn: CondFunction; readonly arg: CondValue }
  | {
      readonly kind: "compare";
      readonly op: CondCompareOperator;
      readonly left: CondExpr;
      readonly right: CondExpr;
    }
  | {
      readonly kind: "logical";
      readonly op: CondLogicalOperator;
      readonly left: CondExpr;
      readonly right: CondExpr;
    };

/** 値の型を返す。 */
export function condValueType(value: CondValue): CondType {
  switch (value.kind) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default: {
      const unhandled: never = value;
      throw new CondError(`未知の cond 値 ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * 変数の型(§3)。
 *
 * `equipType` だけが string で、残りは数値である。`statWeights` を数値にして
 * いる理由は {@link CondContext.statWeightsTotalFix} の doc を参照。
 */
export function condVariableType(name: CondVariable): CondType {
  return name === "equipType" ? "string" : "number";
}

/**
 * 関数の戻り型(§3)と引数の型。
 *   `hasTrait(traitId)`     : string → boolean
 *   `maxStatHolder(statId)` : string → number
 */
export function condFunctionType(fn: CondFunction): {
  readonly arg: CondType;
  readonly result: CondType;
} {
  return fn === "hasTrait"
    ? { arg: "string", result: "boolean" }
    : { arg: "string", result: "number" };
}

/**
 * 式全体の型(§3)。**ロード側がこれを呼んで boolean 以外を reject する**のが
 * 「実行時に型エラーで落ちない」ことの根拠である。
 *
 * @throws {CondError} 比較の両辺の型不一致 / 大小比較の非数値 /
 *                     論理演算子の非 boolean / 関数の引数型不一致
 */
export function condExprType(expr: CondExpr): CondType {
  switch (expr.kind) {
    case "literal":
      return condValueType(expr.value);
    case "variable":
      return condVariableType(expr.name);
    case "call": {
      const signature = condFunctionType(expr.fn);
      const argType = condValueType(expr.arg);
      if (argType !== signature.arg) {
        throw new CondError(
          `cond 関数 "${expr.fn}" の引数は ${signature.arg} が必須(実際: ${argType})`,
        );
      }
      return signature.result;
    }
    case "compare": {
      const leftType = condExprType(expr.left);
      const rightType = condExprType(expr.right);
      if (leftType !== rightType) {
        throw new CondError(
          `cond の比較 "${expr.op}" の両辺の型が違う(左: ${leftType} / 右: ${rightType})。` +
            "暗黙変換は行わない(GDD 12.2 のホワイトリストに型変換は無い)",
        );
      }
      if (isOrderingOperator(expr.op) && leftType !== "number") {
        throw new CondError(
          `cond の大小比較 "${expr.op}" は数値どうしにしか使えない(実際: ${leftType})`,
        );
      }
      return "boolean";
    }
    case "logical": {
      const leftType = condExprType(expr.left);
      const rightType = condExprType(expr.right);
      if (leftType !== "boolean" || rightType !== "boolean") {
        throw new CondError(
          `cond の論理演算 "${expr.op}" の被演算子は boolean が必須` +
            `(左: ${leftType} / 右: ${rightType})`,
        );
      }
      return "boolean";
    }
    default: {
      const unhandled: never = expr;
      throw new CondError(`未知の cond 式 ${JSON.stringify(unhandled)}`);
    }
  }
}

function isOrderingOperator(op: CondCompareOperator): boolean {
  for (const candidate of ORDERING_OPERATORS) {
    if (candidate === op) return true;
  }
  return false;
}

// --- 3. 評価コンテキスト(§4) -----------------------------------------------

/**
 * cond を評価するための入力。**判定の直前**(そのノードの choice 効果まで
 * 適用し終えた時点)の値で埋めること。
 *
 * 各フィールドの意味づけは GDD 12.2 が変数名しか定めていないための M22 裁定
 * である(★要ユーザー判断)。
 */
export interface CondContext {
  /**
   * GDD 8.2 の判定式左辺のうち乱数を除いた部分 =
   * 「関連チーム総合力 + 装備補正」。**そのノードの `statWeights` で重み付けした
   * 総合力**であり、choice の `successMod` 補正も適用済みの、実際に difficulty と
   * 比べる値そのものである(cond で `teamPower >= difficulty` と書いたときの
   * 意味が判定式と一致する)。
   */
  readonly teamPowerFix: Fix;
  /**
   * そのノードの難度。choice の `difficultyMod` 適用**後**の確定値
   * (「大胆 = 難度+」を選んだ後の値で分岐が判断される)。
   */
  readonly difficultyFix: Fix;
  /**
   * そのノードの `statWeights` の**値の総和**。
   *
   * GDD 12.2 は `statWeights` をオブジェクトとして挙げるが、cond DSL は
   * MemberExpression(`statWeights.vigor`)を許可しない(`schema/event.ts` §2)
   * ため、裸の識別子に与えられる意味は「オブジェクトのスカラ縮約」しかない。
   * 総和を採ったのは、これが content 側だけで決まる量であり
   * (state に依存しない)、`teamPower` と意味が重複しないためである。
   */
  readonly statWeightsTotalFix: Fix;
  /**
   * ここまでのノードで積んだ**判定失敗の回数**(= 負傷を負った回数)。
   * GDD 8.3 の文面分岐「負傷有無」の判定材料であり、
   * `injuryCount == 0` で無傷分岐が書ける。
   */
  readonly injuryCount: number;
  /**
   * 装備ロードアウトの種別。item(装備)は MVP 未実装なので常に
   * {@link EQUIP_TYPE_NONE} である(GDD 8.1 の「装備ロードアウト」が入る段で
   * 実データに差し替わる)。cond から参照できる語彙だけを先に確定させてある。
   */
  readonly equipType: string;
  /** チームの誰かが持っている trait の ID 集合(`hasTrait` の母集合)。 */
  readonly teamTraitIds: ReadonlySet<string>;
  /**
   * stat ID → チーム内の**最大値**(`maxStatHolder` の戻り値)。
   * 基礎ステ 5 種と派生値 `combatPower` を持つ。未登録の stat は 0 を返す
   * (ロード側が正本語彙を強制しているので通常は起きない)。
   */
  readonly maxStatFixByStatId: ReadonlyMap<string, Fix>;
}

/** 装備が未実装であることを表す `equipType` の値(§4)。 */
export const EQUIP_TYPE_NONE = "none";

// --- 4. 評価(§2 の整数演算だけで閉じる) -----------------------------------

/**
 * cond を評価して真偽値を返す。
 *
 * **浮動小数を 1 度も通らない**: 数値は Fix のまま {@link toRaw} で整数化して
 * 比較するだけで、除算・乗算・Math 関数を使わない(§2)。
 * 文字列比較も `compareUtf16`(UTF-16 コードユニット比較)であり
 * ロケール依存の `localeCompare` を使わない(ADR-010)。
 *
 * `&&` / `||` は**短絡評価しない**。両辺とも副作用の無い純関数評価であり、
 * 短絡しても結果は同じだが、「評価回数が式の形に依存しない」ほうが
 * 決定論の議論が単純になるためである(評価コストは AST サイズに比例で有界)。
 *
 * @throws {CondError} 型が合わない場合(ロード側で落ちているはずの防御)
 */
export function evaluateCond(expr: CondExpr, ctx: CondContext): boolean {
  const value = evaluateValue(expr, ctx);
  if (value.kind !== "boolean") {
    throw new CondError(`cond 全体は boolean でなければならない(実際: ${condValueType(value)})`);
  }
  return value.value;
}

function evaluateValue(expr: CondExpr, ctx: CondContext): CondValue {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "variable":
      return evaluateVariable(expr.name, ctx);
    case "call":
      return evaluateCall(expr.fn, expr.arg, ctx);
    case "compare": {
      const left = evaluateValue(expr.left, ctx);
      const right = evaluateValue(expr.right, ctx);
      return { kind: "boolean", value: compareValues(expr.op, left, right) };
    }
    case "logical": {
      const left = requireBoolean(evaluateValue(expr.left, ctx), expr.op);
      const right = requireBoolean(evaluateValue(expr.right, ctx), expr.op);
      return { kind: "boolean", value: expr.op === "&&" ? left && right : left || right };
    }
    default: {
      const unhandled: never = expr;
      throw new CondError(`未知の cond 式 ${JSON.stringify(unhandled)}`);
    }
  }
}

function evaluateVariable(name: CondVariable, ctx: CondContext): CondValue {
  switch (name) {
    case "teamPower":
      return { kind: "number", valueFix: ctx.teamPowerFix };
    case "difficulty":
      return { kind: "number", valueFix: ctx.difficultyFix };
    case "statWeights":
      return { kind: "number", valueFix: ctx.statWeightsTotalFix };
    case "injuryCount":
      // 整数量も Fix にしてから比べる(§2: 素の number との混在を作らない)。
      return { kind: "number", valueFix: fixFromInt(ctx.injuryCount) };
    case "equipType":
      return { kind: "string", value: ctx.equipType };
    default: {
      const unhandled: never = name;
      throw new CondError(`未知の cond 変数 "${String(unhandled)}"`);
    }
  }
}

function evaluateCall(fn: CondFunction, arg: CondValue, ctx: CondContext): CondValue {
  if (arg.kind !== "string") {
    throw new CondError(`cond 関数 "${fn}" の引数は string(実際: ${condValueType(arg)})`);
  }
  switch (fn) {
    case "hasTrait":
      return { kind: "boolean", value: ctx.teamTraitIds.has(arg.value) };
    case "maxStatHolder":
      return { kind: "number", valueFix: ctx.maxStatFixByStatId.get(arg.value) ?? FIX_ZERO };
    default: {
      const unhandled: never = fn;
      throw new CondError(`未知の cond 関数 "${String(unhandled)}"`);
    }
  }
}

function requireBoolean(value: CondValue, op: CondLogicalOperator): boolean {
  if (value.kind !== "boolean") {
    throw new CondError(
      `cond の論理演算 "${op}" の被演算子が boolean でない(実際: ${condValueType(value)})`,
    );
  }
  return value.value;
}

/**
 * 2 値の比較(§2)。数値は raw 整数、文字列は UTF-16 コードユニット、
 * boolean は等値のみ。型が違う組は `==` を false・`!=` を true とし、
 * 大小比較は {@link CondError}(ロード側で落ちているはず)。
 */
function compareValues(op: CondCompareOperator, left: CondValue, right: CondValue): boolean {
  if (left.kind !== right.kind) {
    if (op === "==") return false;
    if (op === "!=") return true;
    throw new CondError(
      `cond の大小比較 "${op}" の両辺の型が違う(左: ${condValueType(left)} / 右: ${condValueType(right)})`,
    );
  }
  if (left.kind === "boolean" && right.kind === "boolean") {
    if (op === "==") return left.value === right.value;
    if (op === "!=") return left.value !== right.value;
    throw new CondError(`cond の大小比較 "${op}" は boolean どうしには使えない`);
  }
  if (left.kind === "string" && right.kind === "string") {
    const order = compareUtf16(left.value, right.value);
    return applyOrder(op, order);
  }
  if (left.kind === "number" && right.kind === "number") {
    const leftRaw = toRaw(left.valueFix);
    const rightRaw = toRaw(right.valueFix);
    const order = leftRaw === rightRaw ? 0 : leftRaw < rightRaw ? -1 : 1;
    return applyOrder(op, order);
  }
  throw new CondError(`cond の比較 "${op}" に未知の値種が来た`);
}

/** 比較結果(-1/0/1)を演算子へ写す。 */
function applyOrder(op: CondCompareOperator, order: number): boolean {
  switch (op) {
    case "==":
      return order === 0;
    case "!=":
      return order !== 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    default: {
      const unhandled: never = op;
      throw new CondError(`未知の cond 比較演算子 "${String(unhandled)}"`);
    }
  }
}
