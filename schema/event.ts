// ---------------------------------------------------------------------------
// event content スキーマ(最小実装・先行計測 #12「エンティティ制作素工数」向け)
// — GDD §8.1〜8.4/§12.1/§12.2、ADR「entity スキーマ」633行
//
// ===========================================================================
// スタンドアロン検証器である(engine ローダーへ非接続)
// ===========================================================================
//   T5 の縮約 rules は production/research/recall の3本のみ(state.ts §3)で
//   探索(event)を消費しない。よって本ファイルは
//     - `schema/engineContent.ts` へは接続しない(engine 内部表現への写像なし)
//     - `schema/contentBundle.ts` の `ContentBundle` にも組み込まない
//   単体で `validateEvent()` を呼ぶスタンドアロン検証に留める。理由:
//   組み込むと tech/facility/trait/adjacency/balance の既存5カテゴリの
//   検証結果(グローバル ID 一意性・cross-ref)に波及するリスクがあり、
//   「探索システムの実装(T5/T6 スコープ外)を先取りしない」という各ファイルの
//   既存スコープ外宣言(tech.ts/facility.ts 冒頭)と整合させるため。
//   event システムを実装するタスクで初めて engineContent.ts 側の対応を追加し、
//   その時に本ファイルを ContentBundle へ additive に組み込むこと。
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
//   `vigor`/`dexterity`/`intellect`/`fortitude`/`will` + 派生値 `combatPower`。
//   **`statWeights` のキーを正本語彙へ制限するのは event content を
//   ContentBundle へ組み込む段(探索ランタイム = M21/M22)で行う**。理由は 2 つ:
//     (a) 本ファイルはまだ ContentBundle に載っておらず(冒頭の注記)、engine へ
//         写す経路が無いため、制限しても効くのは計測用サンプルの検証だけ。
//     (b) `docs/measurements/authoring-samples/*.retest-*.json` は
//         **正本確定前のオーサリング計測の成果物**であり、裁定 B8 が
//         「計測サンプルは書き換え不要」と明記している(`resilience`/`power` の
//         ような自由文字列が残っている)。今ここを締めると計測の記録を
//         壊すことになる。
//   M21/M22 で締めるときは、engine の RESIDENT_STAT_IDS /
//   RESIDENT_DERIVED_STAT_IDS を単一の権威として参照すること
//   (`schema/engineContent.ts` の trait 側と同じ形)。**
// ---------------------------------------------------------------------------

import jsep from "jsep";

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
function walkCondNode(node: jsep.Expression, path: string, issues: IssueCollector): void {
  switch (node.type) {
    case "Literal":
      return;
    case "Identifier": {
      const name = (node as jsep.Identifier).name;
      if (!(ALLOWED_COND_IDENTIFIERS as readonly string[]).includes(name)) {
        issues.add(
          path,
          `cond の識別子 "${name}" が許可リスト(${ALLOWED_COND_IDENTIFIERS.join(",")})に無い(GDD 12.2)`,
        );
      }
      return;
    }
    case "BinaryExpression": {
      const bin = node as jsep.BinaryExpression;
      if (!(ALLOWED_COND_OPERATORS as readonly string[]).includes(bin.operator)) {
        issues.add(
          path,
          `cond の演算子 "${bin.operator}" が許可リスト(${ALLOWED_COND_OPERATORS.join(",")})に無い(GDD 12.2)`,
        );
      }
      walkCondNode(bin.left, path, issues);
      walkCondNode(bin.right, path, issues);
      return;
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
        return;
      }
      if (call.arguments.length !== 1) {
        issues.add(
          path,
          `cond の関数呼び出しは引数1個のみ許可(実際: ${String(call.arguments.length)}個)`,
        );
        return;
      }
      const arg = call.arguments[0];
      if (arg === undefined || arg.type !== "Literal") {
        issues.add(path, "cond の関数引数は string/number/boolean リテラルのみ許可");
        return;
      }
      return;
    }
    default:
      issues.add(
        path,
        `cond に許可されない構文 "${node.type}" が含まれる` +
          "(許可: Literal/Identifier/BinaryExpression/CallExpression)",
      );
  }
}

function validateCond(raw: unknown, path: string, issues: IssueCollector): string | undefined {
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
  walkCondNode(ast, path, issues);
  return issues.list().length === issuesBefore ? str : undefined;
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
 * GDD 8.2「関連ステータスはイベント種別で変わる」を表す stat名→重みの record。
 * stat 名は現状**自由文字列**のまま検証している。正本語彙(裁定 B8)への制限を
 * M21/M22 まで遅らせる理由はファイル冒頭の注記を参照。
 */
function validateStatWeights(
  raw: unknown,
  path: string,
  issues: IssueCollector,
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
    const weight = expectNumber(obj[key], `${path}.${key}`, issues, STAT_WEIGHT_RANGE);
    if (weight !== undefined) result[key] = weight;
  }
  return issues.list().length === issuesBefore ? result : undefined;
}

// --- 5. nodes[].branches -------------------------------------------------------

const BRANCHES_COUNT_RANGE: NumericRange = { min: 1, max: 8 };

export interface EventBranch {
  readonly cond: string;
  readonly result: string;
  readonly logTemplate: string;
}

function validateBranches(
  raw: unknown,
  path: string,
  issues: IssueCollector,
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
    const cond = validateCond(obj["cond"], `${entryPath}.cond`, issues);
    // GDD 8.4「帰還ログのスナップショット形式」: result/logTemplate に共通語彙の
    // 正本が無い(汎用の非空文字列としてのみ検証。値の意味論は engine 実装時に定める)。
    const result_ = expectString(obj["result"], `${entryPath}.result`, issues);
    const logTemplate = expectString(obj["logTemplate"], `${entryPath}.logTemplate`, issues);
    if (cond === undefined || result_ === undefined || logTemplate === undefined) return undefined;
    result.push({ cond, result: result_, logTemplate });
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

function validateNode(raw: unknown, path: string, issues: IssueCollector): EventNode | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const difficulty = expectNumber(
    obj["difficulty"],
    `${path}.difficulty`,
    issues,
    DIFFICULTY_RANGE,
  );
  const r = expectNumber(obj["R"], `${path}.R`, issues, ROLL_RANGE);
  const statWeights = validateStatWeights(obj["statWeights"], `${path}.statWeights`, issues);
  const choices = validateChoices(obj["choices"], `${path}.choices`, issues);
  const branches = validateBranches(obj["branches"], `${path}.branches`, issues);

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
    const node = validateNode(arr[i], `${path}[${String(i)}]`, issues);
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

export function validateEvent(raw: unknown): ValidationResult<EventContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const destTags = validateDestTags(obj["destTags"], "$.destTags", issues);
  const nodes = validateNodes(obj["nodes"], "$.nodes", issues);

  if (id === undefined || destTags === undefined || nodes === undefined) {
    return fail(issues.list());
  }

  return ok({ id, destTags, nodes });
}
