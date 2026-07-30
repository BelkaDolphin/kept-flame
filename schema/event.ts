// ---------------------------------------------------------------------------
// event content スキーマ(最小実装・先行計測 #12「エンティティ制作素工数」向け)
// — GDD §8.1〜8.4/§12.1/§12.2、ADR「entity スキーマ」633行
//
// ===========================================================================
// [M22] engine ローダーへ結線済み(旧「スタンドアロン検証器」の解消)
// ===========================================================================
//   T5〜T7 の間、本ファイルは `validateEvent()` を単体で呼ぶスタンドアロン検証に
//   留めてあった(engine の縮約 rules が探索を消費しなかったため)。**M22 で
//   event ランタイムを実装したので結線した**:
//     - `schema/contentBundle.ts` の `RawContentBundle.event`(**省略可**)/
//       `ContentBundle.event` に組み込み、グローバル ID 一意性(ADR-024(1))と
//       同じ関門を通す
//     - `schema/engineContent.ts` が `EngineContent.eventDefs` へ写す
//       (cond は {@link CondAst} 経由で `src/engine/rules/cond.ts` の `CondExpr` へ
//        **コンパイル**され、engine は実行時に文字列パースを 1 度も行わない)
//   `content/event.json` はまだ存在せず(投入は M23)、`event` キーが無い raw は
//   空配列として扱われるので、既存の呼び出し側・既存 golden vector は不変である。
//
//   **2 段構えの厳格度**(裁定 N5 と同じ形): `validateEvent()` の既定は緩く、
//   `ContentBundle` 経由(= engine へ到達する唯一の経路)だけが
//   `{ strict: true }` で正本語彙を強制する。理由は下記「要ユーザー判断」の (b)。
//
// ===========================================================================
// 対象範囲(オーサリング計測に必要な最小限。GDD 8.1〜8.4/12.1/12.2 の全域では
// ない。削った点は各セクションのコメントに明記)
// ===========================================================================
//   ADR entity スキーマ(633行)の sketch:
//     event(id, destTags, nodes[{difficulty, R, statWeights,
//           choices[{label,effect}], branches[{cond,result,logTemplate}]}])
//   を最小実装する。
//
// ===========================================================================
// 要ユーザー判断: 英字ID正本の欠如(golden-vector-spec.md §8-3 と同種の穴)
// ===========================================================================
//   GDD 8.1 は距離帯を「近郊/遠隔/深部」の日本語のみで表記し、英字IDの正本が
//   無い(facility タグ7種は tags-spec.md が正本を持つが、距離帯には対応する
//   spec が無い)。本ファイルは近郊=near/遠隔=far/深部=deep という英字IDを
//   オーサリング側で暫定採用した({@link EVENT_DEST_TAGS})。
//
//   **[2026-07-27裁定 B7/B8 で両方の正本が確定した。** 距離帯は near/far/deep
//   (= 本ファイルの暫定採用がそのまま正本になった)、ステータスは
//   `vigor`/`dexterity`/`intellect`/`fortitude`/`will` + 派生値 `combatPower`。**
//
//   **[M22] 締めた。ただし `{ strict: true }` のときだけ**({@link
//   ValidateEventOptions})。権威は engine の `RESIDENT_STAT_IDS` /
//   `RESIDENT_DERIVED_STAT_IDS`({@link EVENT_STAT_WEIGHT_KEYS} はその並べ替え
//   ビュー)であり、`schema/engineContent.ts` の trait 側と同じ形になっている。
//   既定を緩いままにしたのは次の (b) のためである:
//     (a) 〈解消済み〉engine へ写す経路が無い、という旧理由は結線で消えた。
//     (b) `docs/measurements/authoring-samples/*.json` は**正本確定前の
//         オーサリング計測の成果物**であり、裁定 B8 が「計測サンプルは書き換え
//         不要」と明記している(`resilience`/`power` という statWeights キーと
//         `partial`/`retreat`/`success_solo`/`success_wounded` という result が
//         残っている)。既定を厳格にすると計測の記録を壊すことになる。
//   ⇒ 「engine へ到達する content は厳格・計測サンプルの単体検証は緩い」を
//      2 段構えで両立させた(★要ユーザー判断として M22 報告に記載)。
// ---------------------------------------------------------------------------

import jsep from "jsep";

import { RESIDENT_DERIVED_STAT_IDS, RESIDENT_STAT_IDS } from "../src/engine/rules/stats";
import {
  DESTROY_RECORDS_MEDIA,
  DESTROY_RECORDS_SCOPES,
  EVENT_RESULT_KINDS,
  isDestroyRecordsMedium,
  isDestroyRecordsScope,
} from "../src/engine/rules/types";
import { compareUtf16 } from "../src/engine/canonicalize";
import {
  IssueCollector,
  expectArray,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type NumericRange,
  type ValidationResult,
} from "./common";

// --- 1. destTags -------------------------------------------------------------

/**
 * GDD 8.1「近郊/遠隔/深部の3距離帯」の暫定英字ID(ファイル冒頭の要ユーザー判断を参照)。
 */
export const EVENT_DEST_TAGS = ["near", "far", "deep"] as const;
export type EventDestTag = (typeof EVENT_DEST_TAGS)[number];

function isEventDestTag(value: string): value is EventDestTag {
  return (EVENT_DEST_TAGS as readonly string[]).includes(value);
}

const DEST_TAGS_COUNT_RANGE: NumericRange = { min: 1, max: EVENT_DEST_TAGS.length };

function validateDestTags(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly EventDestTag[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length < DEST_TAGS_COUNT_RANGE.min || arr.length > DEST_TAGS_COUNT_RANGE.max) {
    issues.add(
      path,
      `destTags は1〜${String(DEST_TAGS_COUNT_RANGE.max)}個(距離帯: ${EVENT_DEST_TAGS.join(",")})が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const issuesBefore = issues.list().length;
  const tags: EventDestTag[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (typeof entry !== "string" || !isEventDestTag(entry)) {
      issues.add(
        `${path}[${String(i)}]`,
        `destTags は ${EVENT_DEST_TAGS.join(" | ")} のいずれかが必須(実際: ${JSON.stringify(entry)})`,
      );
      continue;
    }
    if (seen.has(entry)) {
      issues.add(`${path}[${String(i)}]`, `destTags "${entry}" が重複`);
      continue;
    }
    seen.add(entry);
    tags.push(entry);
  }
  return issues.list().length === issuesBefore ? tags : undefined;
}

// --- 2. cond DSL ホワイトリスト(GDD 12.2) -----------------------------------

/**
 * GDD 12.2「branches[].cond で参照可能な変数」のうち、裸の識別子として使える語彙。
 * `hasTrait` / `maxStatHolder` は関数呼び出し専用({@link ALLOWED_COND_FUNCTIONS})。
 *
 * 削った点: GDD は `statWeights` をオブジェクトとして挙げるが、本検証器は
 * MemberExpression(`statWeights.vigor` 等のプロパティアクセス)を許可しない
 * (§2 の AST 許可ノード種を参照)。バンドルされた値との比較には向かないため、
 * 実質的には識別子として単体比較に使う想定に限定される(GDD の意図より狭い)。
 */
const ALLOWED_COND_IDENTIFIERS = [
  "teamPower",
  "difficulty",
  "statWeights",
  "injuryCount",
  "equipType",
] as const;

/** ADR「entity スキーマ」633行「hasTrait(traitId)/maxStatHolder(stat)等の引数付き関数」。 */
const ALLOWED_COND_FUNCTIONS = ["hasTrait", "maxStatHolder"] as const;

/** GDD 12.2「許可演算子(==, !=, <, <=, >, >=, &&, ||)」。 */
const ALLOWED_COND_OPERATORS = ["==", "!=", "<", "<=", ">", ">=", "&&", "||"] as const;

const COND_MAX_LENGTH = 300;

/**
 * jsep AST を歩いて許可ノード種のみで構成されているか検証する。
 *
 * 許可: Literal(string/number/boolean) / Identifier(許可リスト内) /
 *       BinaryExpression(許可演算子のみ、`&&`/`||` も同ノード種) /
 *       CallExpression(callee が許可関数、引数はちょうど1個の Literal)。
 * 不許可(削った点): MemberExpression(オブジェクトプロパティアクセス) /
 *       UnaryExpression(`!` 等。GDD 12.2 の許可演算子に単項否定が無い) /
 *       ConditionalExpression(三項演算子) / ArrayExpression / Compound /
 *       SequenceExpression / ThisExpression。
 */
/**
 * [M22] ホワイトリスト検証を通った cond の**中間表現**。
 *
 * jsep の型に依存せず、数値は**人間可読値のまま**持つ(1e6 化は
 * `schema/engineContent.ts` の `rawFromHumanNumber` が行う。ここで Fix に
 * すると engineContent → event の循環 import になるため層を分けてある)。
 * engine の `CondExpr`(`src/engine/rules/cond.ts`)へはローダーが写す。
 */
export type CondAst =
  | { readonly kind: "numberLiteral"; readonly value: number }
  | { readonly kind: "stringLiteral"; readonly value: string }
  | { readonly kind: "booleanLiteral"; readonly value: boolean }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "call"; readonly fn: string; readonly arg: CondAst }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: CondAst;
      readonly right: CondAst;
    };

function walkCondNode(
  node: jsep.Expression,
  path: string,
  issues: IssueCollector,
): CondAst | undefined {
  switch (node.type) {
    case "Literal": {
      const value: unknown = (node as jsep.Literal).value;
      if (typeof value === "number") return { kind: "numberLiteral", value };
      if (typeof value === "string") return { kind: "stringLiteral", value };
      if (typeof value === "boolean") return { kind: "booleanLiteral", value };
      issues.add(path, `cond のリテラルは string/number/boolean のみ許可(実際: ${typeof value})`);
      return undefined;
    }
    case "Identifier": {
      const name = (node as jsep.Identifier).name;
      if (!(ALLOWED_COND_IDENTIFIERS as readonly string[]).includes(name)) {
        issues.add(
          path,
          `cond の識別子 "${name}" が許可リスト(${ALLOWED_COND_IDENTIFIERS.join(",")})に無い(GDD 12.2)`,
        );
        return undefined;
      }
      return { kind: "variable", name };
    }
    case "BinaryExpression": {
      const bin = node as jsep.BinaryExpression;
      let operatorOk = true;
      if (!(ALLOWED_COND_OPERATORS as readonly string[]).includes(bin.operator)) {
        issues.add(
          path,
          `cond の演算子 "${bin.operator}" が許可リスト(${ALLOWED_COND_OPERATORS.join(",")})に無い(GDD 12.2)`,
        );
        operatorOk = false;
      }
      const left = walkCondNode(bin.left, path, issues);
      const right = walkCondNode(bin.right, path, issues);
      if (!operatorOk || left === undefined || right === undefined) return undefined;
      return { kind: "binary", operator: bin.operator, left, right };
    }
    case "CallExpression": {
      const call = node as jsep.CallExpression;
      const callee = call.callee;
      if (
        callee.type !== "Identifier" ||
        !(ALLOWED_COND_FUNCTIONS as readonly string[]).includes((callee as jsep.Identifier).name)
      ) {
        issues.add(
          path,
          `cond の関数呼び出しは ${ALLOWED_COND_FUNCTIONS.join(",")} のみ許可(ADR「entity スキーマ」633行)`,
        );
        return undefined;
      }
      if (call.arguments.length !== 1) {
        issues.add(
          path,
          `cond の関数呼び出しは引数1個のみ許可(実際: ${String(call.arguments.length)}個)`,
        );
        return undefined;
      }
      const arg = call.arguments[0];
      if (arg === undefined || arg.type !== "Literal") {
        issues.add(path, "cond の関数引数は string/number/boolean リテラルのみ許可");
        return undefined;
      }
      const argAst = walkCondNode(arg, path, issues);
      if (argAst === undefined) return undefined;
      return { kind: "call", fn: (callee as jsep.Identifier).name, arg: argAst };
    }
    default:
      issues.add(
        path,
        `cond に許可されない構文 "${node.type}" が含まれる` +
          "(許可: Literal/Identifier/BinaryExpression/CallExpression)",
      );
      return undefined;
  }
}

/**
 * [M22] cond 文字列をホワイトリスト検証しつつ {@link CondAst} へ落とす。
 * **jsep を呼ぶのはこの関数だけ**であり、engine 側は文字列を 1 度も見ない
 * (`src/engine/rules/cond.ts` §1)。
 */
export function parseCondAst(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): CondAst | undefined {
  const str = expectString(raw, path, issues);
  if (str === undefined) return undefined;
  if (str.length > COND_MAX_LENGTH) {
    issues.add(
      path,
      `cond は${String(COND_MAX_LENGTH)}文字以内が必須(実際: ${String(str.length)}文字)`,
    );
    return undefined;
  }
  let ast: jsep.Expression;
  try {
    ast = jsep(str);
  } catch (error) {
    issues.add(
      path,
      `cond の構文解析に失敗(jsep): ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  const issuesBefore = issues.list().length;
  const compiled = walkCondNode(ast, path, issues);
  return issues.list().length === issuesBefore ? compiled : undefined;
}

/** {@link parseCond} の結果(元の文字列と中間表現の対)。 */
export interface CondParseResult {
  readonly text: string;
  readonly ast: CondAst;
}

/** cond を 1 度だけ解析して文字列と {@link CondAst} を返す。 */
export function parseCond(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): CondParseResult | undefined {
  const str = expectString(raw, path, issues);
  if (str === undefined) return undefined;
  const ast = parseCondAst(str, path, issues);
  return ast === undefined ? undefined : { text: str, ast };
}

// --- 3. choices[].effect ------------------------------------------------------

const EFFECT_MOD_RANGE: NumericRange = { min: -1, max: 1 };
const INJURY_RISK_MUL_RANGE: NumericRange = { min: 0, max: 5 };

/**
 * GDD 8.3 の質的分岐(「慎重=成功率+/報酬-」「大胆=報酬+/難度+」
 * 「強行=全取得を狙うが負傷リスク×1.5」)を表す最小限のフラットな数値効果。
 *
 * 削った点: 各軸間の相互作用式(強行時の負傷リスク計算式そのもの等)は
 * engine 側で event システムを実装する際に確定するものとし、本スキーマは
 * 「値が指定されればレンジ内であること」の形式検証のみ行う。最低1軸は
 * 指定必須(trait.ts の effects 同様、無効果の choice を防ぐ)。
 */
export interface EventEffect {
  readonly successMod: number | null;
  readonly rewardMod: number | null;
  readonly difficultyMod: number | null;
  readonly injuryRiskMul: number | null;
}

function validateEffect(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): EventEffect | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const readMod = (key: string): number | null | undefined => {
    const value = obj[key];
    if (value === undefined) return null;
    return expectNumber(value, `${path}.${key}`, issues, EFFECT_MOD_RANGE) ?? undefined;
  };

  const successMod = readMod("successMod");
  const rewardMod = readMod("rewardMod");
  const difficultyMod = readMod("difficultyMod");

  const rawInjuryRiskMul = obj["injuryRiskMul"];
  const injuryRiskMul =
    rawInjuryRiskMul === undefined
      ? null
      : (expectNumber(rawInjuryRiskMul, `${path}.injuryRiskMul`, issues, INJURY_RISK_MUL_RANGE) ??
        undefined);

  if (
    successMod === undefined ||
    rewardMod === undefined ||
    difficultyMod === undefined ||
    injuryRiskMul === undefined
  ) {
    return undefined;
  }
  if (
    successMod === null &&
    rewardMod === null &&
    difficultyMod === null &&
    injuryRiskMul === null
  ) {
    issues.add(
      path,
      "effect は successMod/rewardMod/difficultyMod/injuryRiskMul のうち最低1個の指定が必須(無効果の choice を防ぐ)",
    );
    return undefined;
  }
  return { successMod, rewardMod, difficultyMod, injuryRiskMul };
}

const CHOICES_COUNT_RANGE: NumericRange = { min: 0, max: 4 };

export interface EventChoice {
  readonly label: string;
  readonly effect: EventEffect;
}

function validateChoices(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly EventChoice[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length > CHOICES_COUNT_RANGE.max) {
    issues.add(path, `choices は最大${String(CHOICES_COUNT_RANGE.max)}個(GDD 8.3: 二択想定)`);
    return undefined;
  }
  const result: EventChoice[] = [];
  for (let i = 0; i < arr.length; i++) {
    const entryPath = `${path}[${String(i)}]`;
    const obj = expectRecord(arr[i], entryPath, issues);
    if (obj === undefined) return undefined;
    const label = expectString(obj["label"], `${entryPath}.label`, issues);
    const effect = validateEffect(obj["effect"], `${entryPath}.effect`, issues);
    if (label === undefined || effect === undefined) return undefined;
    result.push({ label, effect });
  }
  return result;
}

// --- 4. nodes[].statWeights ----------------------------------------------------

const STAT_WEIGHT_RANGE: NumericRange = { min: 0, max: 1 };

/**
 * [M22] `statWeights` のキーとして書ける正本語彙(裁定 B8)。
 *
 * **engine の `RESIDENT_STAT_IDS` / `RESIDENT_DERIVED_STAT_IDS` が単一の権威**で
 * あり(`schema/engineContent.ts` の trait 側と同じ形)、ここは並べ替えた
 * ビューでしかない。engine 側にステータスが増えたらこの配列は自動で追随する。
 */
export const EVENT_STAT_WEIGHT_KEYS: readonly string[] = [
  ...RESIDENT_STAT_IDS,
  ...RESIDENT_DERIVED_STAT_IDS,
].sort(compareUtf16);

function isEventStatWeightKey(key: string): boolean {
  for (const known of EVENT_STAT_WEIGHT_KEYS) {
    if (known === key) return true;
  }
  return false;
}

/** {@link validateEvent} のオプション。 */
export interface ValidateEventOptions {
  /**
   * [M22] **engine へ到達する content として厳格に検証するか**。
   * 対象は 2 つで、どちらも「engine 側の enum が正本」である:
   *   (a) `statWeights` のキー(裁定 B8 の正本語彙・{@link EVENT_STAT_WEIGHT_KEYS})
   *   (b) `branches[].result` の文字列短縮記法(:{@link EVENT_RESULT_LABELS})
   *
   * **既定は false(緩い)** である。裁定 B8 が
   * 「`docs/measurements/authoring-samples/*.json` は正本確定前のオーサリング
   * 計測の成果物であり書き換え不要」と明記しており、そこには
   * `resilience` / `power`(statWeights)や `partial` / `retreat` /
   * `success_solo` / `success_wounded`(result)という自由文字列が残っている
   * ためである(ファイル冒頭 (b) の注記)。
   *
   * **engine へ到達する経路(`schema/contentBundle.ts` 経由)は必ず true** で
   * 呼ぶので、実際に engine が読む content では正本語彙が強制される。
   * 「schema 単体では緩い・ローダーでは厳しい」という二段構えは
   * 裁定 N5(facility.harshWork 等)と同じ形である。
   */
  readonly strict?: boolean;
}

/**
 * GDD 8.2「関連ステータスはイベント種別で変わる」を表す stat名→重みの record。
 * `strict` のときだけキーを正本語彙(裁定 B8)へ制限する
 * ({@link ValidateEventOptions.strictStatWeights})。
 */
function validateStatWeights(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  strict: boolean,
): Readonly<Record<string, number>> | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    issues.add(path, "statWeights は1個以上必須");
    return undefined;
  }
  const issuesBefore = issues.list().length;
  const result: Record<string, number> = {};
  for (const key of keys) {
    if (strict && !isEventStatWeightKey(key)) {
      issues.add(
        `${path}.${key}`,
        `statWeights のキー "${key}" が正本語彙(裁定 B8: ${EVENT_STAT_WEIGHT_KEYS.join(",")})に無い`,
      );
      continue;
    }
    const weight = expectNumber(obj[key], `${path}.${key}`, issues, STAT_WEIGHT_RANGE);
    if (weight !== undefined) result[key] = weight;
  }
  return issues.list().length === issuesBefore ? result : undefined;
}

// --- 5. nodes[].branches -------------------------------------------------------

const BRANCHES_COUNT_RANGE: NumericRange = { min: 1, max: 8 };

/**
 * [M22] `branches[].result` を**文字列**で書くときの語彙(UTF-16 昇順)。
 *
 * GDD 12.1 [2026-07-27追補] は result の語彙に `destroyRecords{medium, scope}` を
 * 予約する = **result はパラメータを持ちうる**ということなので、正本の形は
 * オブジェクト({@link EventResultObject})である。文字列はその短縮記法であり、
 * 次の 4 語だけを認める:
 *
 *   continue / success / failure : 状態を動かさない**説明ラベル**(成否そのものは
 *                                  GDD 8.2 の判定式が既に決めているので、この語が
 *                                  判定を左右することはない)
 *   withdraw                     : GDD 8.3 の撤退(以降のノードを踏まない)
 *
 * `success` / `failure` を残しているのは `docs/measurements/authoring-samples/`
 * の #12 計測サンプルがこの 2 語を使っており、裁定 B8 が計測サンプルの
 * 書き換えを不要としているためである。
 */
export const EVENT_RESULT_LABELS = ["continue", "failure", "success", "withdraw"] as const;

/** {@link EVENT_RESULT_LABELS} のいずれか。 */
export type EventResultLabel = (typeof EVENT_RESULT_LABELS)[number];

function isEventResultLabel(value: string): value is EventResultLabel {
  return (EVENT_RESULT_LABELS as readonly string[]).includes(value);
}

/** [M22] `branches[].result` のオブジェクト形(パラメータを持つ結果)。 */
export interface EventResultObject {
  readonly kind: string;
  /** `destroyRecords` のときの対象媒体。 */
  readonly medium?: string;
  /** `destroyRecords` のときの対象範囲。 */
  readonly scope?: string;
}

/** [M22] `branches[].result` の全体(短縮記法の文字列 or オブジェクト)。 */
export type EventResultContent = EventResultLabel | EventResultObject;

/**
 * [M22] `result` を検証する。文字列は {@link EVENT_RESULT_LABELS}、オブジェクトは
 * `kind` が engine の `EVENT_RESULT_KINDS`(`src/engine/rules/types.ts` が権威)。
 *
 * `destroyRecords` は `medium` / `scope` が必須で、値は engine の enum
 * (`DESTROY_RECORDS_MEDIA` / `DESTROY_RECORDS_SCOPES`)に限る。**MVP では
 * content 側から使わない**(GDD 11.1 追補「火災イベントは MVP に1本も入れない」)
 * が、語彙と検証は先に確定させておく。
 */
function validateResult(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  strict: boolean,
): EventResultContent | undefined {
  if (typeof raw === "string") {
    if (!strict) {
      // 緩いモード(#12 計測サンプル互換)。engine へ写す段(strict)で語彙を締める。
      if (raw.length === 0) {
        issues.add(path, "result は非空文字列が必須");
        return undefined;
      }
      return raw as EventResultLabel;
    }
    if (!isEventResultLabel(raw)) {
      issues.add(
        path,
        `result の文字列は ${EVENT_RESULT_LABELS.join(" | ")} のいずれか(実際: ${JSON.stringify(raw)})。` +
          "パラメータを持つ結果はオブジェクト形で書く(GDD 12.1 [2026-07-27追補])",
      );
      return undefined;
    }
    return raw;
  }
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const kind = expectString(obj["kind"], `${path}.kind`, issues);
  if (kind === undefined) return undefined;
  if (!(EVENT_RESULT_KINDS as readonly string[]).includes(kind)) {
    issues.add(
      `${path}.kind`,
      `result の kind "${kind}" が語彙(${EVENT_RESULT_KINDS.join(",")})に無い`,
    );
    return undefined;
  }
  if (kind !== "destroyRecords") return { kind };

  const medium = expectString(obj["medium"], `${path}.medium`, issues);
  const scope = expectString(obj["scope"], `${path}.scope`, issues);
  if (medium === undefined || scope === undefined) return undefined;
  if (!isDestroyRecordsMedium(medium)) {
    issues.add(
      `${path}.medium`,
      `destroyRecords の medium は ${DESTROY_RECORDS_MEDIA.join(" | ")} のいずれか(実際: ${JSON.stringify(medium)})`,
    );
    return undefined;
  }
  if (!isDestroyRecordsScope(scope)) {
    issues.add(
      `${path}.scope`,
      `destroyRecords の scope は ${DESTROY_RECORDS_SCOPES.join(" | ")} のいずれか(実際: ${JSON.stringify(scope)})`,
    );
    return undefined;
  }
  return { kind, medium, scope };
}

export interface EventBranch {
  readonly cond: string;
  /** [M22] ホワイトリスト検証済みの cond 中間表現({@link CondAst})。 */
  readonly condAst: CondAst;
  readonly result: EventResultContent;
  readonly logTemplate: string;
}

function validateBranches(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  strict: boolean,
): readonly EventBranch[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length < BRANCHES_COUNT_RANGE.min || arr.length > BRANCHES_COUNT_RANGE.max) {
    issues.add(
      path,
      `branches は${String(BRANCHES_COUNT_RANGE.min)}〜${String(BRANCHES_COUNT_RANGE.max)}個が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const result: EventBranch[] = [];
  for (let i = 0; i < arr.length; i++) {
    const entryPath = `${path}[${String(i)}]`;
    const obj = expectRecord(arr[i], entryPath, issues);
    if (obj === undefined) return undefined;
    const cond = parseCond(obj["cond"], `${entryPath}.cond`, issues);
    const result_ = validateResult(obj["result"], `${entryPath}.result`, issues, strict);
    // GDD 8.4「帰還ログのスナップショット形式」: プレースホルダ語彙の検査は
    // engine の `LOG_TEMPLATE_PLACEHOLDERS` を権威とするローダー側で行う
    // (ここは汎用の非空文字列としてのみ検証)。
    const logTemplate = expectString(obj["logTemplate"], `${entryPath}.logTemplate`, issues);
    if (cond === undefined || result_ === undefined || logTemplate === undefined) return undefined;
    result.push({ cond: cond.text, condAst: cond.ast, result: result_, logTemplate });
  }
  return result;
}

// --- 6. nodes ------------------------------------------------------------------

const NODE_COUNT_RANGE: NumericRange = { min: 3, max: 8 };
const DIFFICULTY_RANGE: NumericRange = { min: 1, max: 1_000_000 };
const ROLL_RANGE: NumericRange = { min: 1, max: 1_000_000 };

export interface EventNode {
  readonly difficulty: number;
  readonly R: number;
  readonly statWeights: Readonly<Record<string, number>>;
  readonly choices: readonly EventChoice[];
  readonly branches: readonly EventBranch[];
}

function validateNode(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  strict: boolean,
): EventNode | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const difficulty = expectNumber(
    obj["difficulty"],
    `${path}.difficulty`,
    issues,
    DIFFICULTY_RANGE,
  );
  const r = expectNumber(obj["R"], `${path}.R`, issues, ROLL_RANGE);
  const statWeights = validateStatWeights(
    obj["statWeights"],
    `${path}.statWeights`,
    issues,
    strict,
  );
  const choices = validateChoices(obj["choices"], `${path}.choices`, issues);
  const branches = validateBranches(obj["branches"], `${path}.branches`, issues, strict);

  if (
    difficulty === undefined ||
    r === undefined ||
    statWeights === undefined ||
    choices === undefined ||
    branches === undefined
  ) {
    return undefined;
  }
  return { difficulty, R: r, statWeights, choices, branches };
}

function validateNodes(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  strict: boolean,
): readonly EventNode[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length < NODE_COUNT_RANGE.min || arr.length > NODE_COUNT_RANGE.max) {
    issues.add(
      path,
      `nodes は${String(NODE_COUNT_RANGE.min)}〜${String(NODE_COUNT_RANGE.max)}個が必須(GDD 8.2: イベント列3〜8ノード。実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const result: EventNode[] = [];
  for (let i = 0; i < arr.length; i++) {
    const node = validateNode(arr[i], `${path}[${String(i)}]`, issues, strict);
    if (node === undefined) return undefined;
    result.push(node);
  }
  return result;
}

// --- 7. 入口 --------------------------------------------------------------------

export interface EventContent {
  readonly id: string;
  readonly destTags: readonly EventDestTag[];
  readonly nodes: readonly EventNode[];
}

export function validateEvent(
  raw: unknown,
  options: ValidateEventOptions = {},
): ValidationResult<EventContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const destTags = validateDestTags(obj["destTags"], "$.destTags", issues);
  const nodes = validateNodes(obj["nodes"], "$.nodes", issues, options.strict ?? false);

  if (id === undefined || destTags === undefined || nodes === undefined) {
    return fail(issues.list());
  }

  return ok({ id, destTags, nodes });
}
