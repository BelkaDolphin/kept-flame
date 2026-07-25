// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- JSON 正準化パス — ADR-023(1) / ADR-010
//
// content バンドル(および save の直列化形)を「同じ値なら常に同じ形」へ畳む
// 単一実装。ロード/ビルド時にこのパスを必ず通してから内部表現化することで、
// キー順序に暗黙依存するコードが存在しても sim 結果が変わらない状態を作る
// (ADR-023: 整形ツールがキー順だけ変えた差分を content-diff-gate が「値不変」
// として承認しても、正準化後の内部表現は不変)。
//
// eslint.config.js の EXEMPT_CANONICALIZE により、engine で唯一
// `Object.keys` による生オブジェクト走査が許されるファイルである。裏を返すと
// 「正準化されていない生 JSON を走査してよいのはここだけ」という線引きそのもの
// なので、他所へ走査ロジックを持ち出さないこと。
//
// ===========================================================================
// 1. 正準形の仕様(この 8 項目が本モジュールの契約)
// ===========================================================================
//  (1) オブジェクト  : 自身の列挙可能な文字列キーを UTF-16 コードユニット昇順
//                      (compareUtf16)に並べ替えた新しいオブジェクトを返す。
//                      値は再帰的に正準化する。
//  (2) 配列          : 順序は**保持**する(ソートしない)。配列は順序そのものが
//                      データであり、並べ替えは値の改変になる。要素は再帰。
//  (3) null/真偽/文字列: そのまま(文字列は正規化も NFC 変換もしない。Unicode
//                      正規化はホスト実装差を持ち込みうるので engine では行わず、
//                      content 側の入力規律とする)。
//  (4) 数値          : 有限値のみ許可。NaN / ±Infinity は reject(JSON.stringify
//                      が null へ潰し、情報が黙って消えるため)。-0 は +0 へ
//                      正規化する(JSON 往復で符号が消えるため、残すと往復前後で
//                      Object.is が食い違う。fp.ts §2(b) と同じ規約)。
//  (5) それ以外の値  : undefined / function / symbol / bigint / Map / Set / Date /
//                      クラスインスタンス(= prototype が Object.prototype でも
//                      null でもないオブジェクト)は reject。JSON に表現が無い、
//                      または往復で別物になるものを黙って通さない。
//  (6) `__proto__` キー: reject。`out[key] = v` の形で書き戻すと own property に
//                      ならず prototype 差し替えとして解釈され、キーが黙って
//                      消える。content/save に現れる正当な理由も無い。
//  (7) 冪等          : canonicalizeJson(canonicalizeJson(x)) は x を 1 回通した
//                      ものとキー順まで含めて同一。
//  (8) 非破壊        : 入力は一切変更しない。オブジェクト/配列は新規に作る。
//
// ===========================================================================
// 2. なぜ UTF-16 コードユニット順か(ADR-010)
// ===========================================================================
//   `localeCompare` / `Intl.Collator` はロケールと ICU バージョンに依存し、
//   同じ入力でも環境が変われば順序が変わる = 決定論を壊す(engine では lint 禁止)。
//   一方 JS の関係演算子 `<` `>` による文字列比較は ECMA-262 が「UTF-16 コード
//   ユニット値の辞書式比較」と規定しており、実装・ロケール・ICU 版に依存しない。
//   よって比較器は `<`/`>` だけで書く(compareUtf16)。
//
//   これは**コードポイント順ではない**点に注意。サロゲートペア(U+10000 以上)は
//   先頭コードユニットが 0xD800〜0xDBFF なので、U+E000〜U+FFFF の文字より
//   「小さい」と判定される(例: "\u{1F600}"(0xD83D...) < "�")。
//   本エンジンはキー順を「決定論的に一意であること」だけに使い、人間向けの
//   自然な並びを要求しないので、この差は仕様として受け入れる
//   (tests/engine/canonicalize.test.ts で境界を固定してある)。
//
// ===========================================================================
// 3. 再帰深さの上限
// ===========================================================================
//   MAX_DEPTH を超えたら CanonicalizeError で停止する。目的は 2 つ:
//     - 想定外に深い/循環した構造でスタックオーバーフロー(環境依存の落ち方)に
//       なる前に、決定論的な例外へ寄せる。
//     - JSON.parse 由来の値に循環は無いが、本関数は engine 内のオブジェクトにも
//       適用できる(serialize.ts が使う)ため、循環は必ず止める必要がある。
// ---------------------------------------------------------------------------

/** JSON のプリミティブ値。 */
export type JsonPrimitive = null | boolean | number | string;

/** JSON で表現できる値の全体(正準化の入出力の型)。 */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** JSON オブジェクト(キーは文字列、値は JsonValue)。 */
export type JsonObject = { readonly [key: string]: JsonValue };

/** JSON 配列。 */
export type JsonArray = readonly JsonValue[];

/**
 * 正準化できない入力(JSON に表現できない値・非有限数・`__proto__` キー・
 * 深さ超過)。入力の純関数なので決定論を壊さない(同じ入力なら必ず同じ例外)。
 */
export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizeError";
  }
}

/** 再帰の深さ上限(§3)。content の実データは高々 5〜6 段で、64 は十分な余裕。 */
const MAX_DEPTH = 64;

/**
 * UTF-16 コードユニット順の文字列比較器(ADR-010)。engine 内でキー/ID を
 * 並べ替えるときは必ずこれを使う(`localeCompare` は lint 禁止)。
 *
 * JS の `<` / `>` はコードユニット値の辞書式比較として ECMA-262 に規定されて
 * いるため、ロケール・ICU 版・実装に依存しない。順序の性質は §2 を参照。
 *
 * @returns a < b なら負、a > b なら正、等しければ 0
 */
export function compareUtf16(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 数値の正準化(§1(4))。非有限は reject、-0 は +0 へ畳む。
 */
function canonicalizeNumber(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new CanonicalizeError(
      `${path}: 非有限の数値 ${String(value)} は JSON で表現できない(JSON.stringify が null へ潰す)`,
    );
  }
  // value === 0 は -0 でも真。ここで +0 に畳む(fp.ts §2(b) と同じ規約)。
  return value === 0 ? 0 : value;
}

function canonicalizeAt(value: unknown, path: string, depth: number): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizeError(
      `${path}: 入れ子が深さ上限 ${String(MAX_DEPTH)} を超えた(循環参照または想定外の構造)`,
    );
  }

  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === "boolean" || valueType === "string") {
    return value as boolean | string;
  }
  if (valueType === "number") {
    return canonicalizeNumber(value as number, path);
  }
  if (valueType !== "object") {
    throw new CanonicalizeError(
      `${path}: ${valueType} は JSON に表現できない(undefined/function/symbol/bigint は content・save に置けない)`,
    );
  }

  if (Array.isArray(value)) {
    // 配列は順序を保持する(§1(2))。
    const source = value as readonly unknown[];
    const result: JsonValue[] = [];
    for (let i = 0; i < source.length; i++) {
      result.push(canonicalizeAt(source[i], `${path}[${String(i)}]`, depth + 1));
    }
    return result;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    // Map / Set / Date / クラスインスタンスはここで落ちる(§1(5))。
    throw new CanonicalizeError(
      `${path}: プレーンオブジェクトでない値(Map/Set/Date/クラスインスタンス等)は正準化できない`,
    );
  }

  const source = value as Record<string, unknown>;
  // Object.keys は新しい配列を返すので、sort による入力の破壊は起きない(§1(8))。
  // シンボルキーは Object.keys が拾わない = JSON.stringify と同じく無視される。
  const keys = Object.keys(source).sort(compareUtf16);
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (key === "__proto__") {
      throw new CanonicalizeError(
        `${path}: キー "__proto__" は禁止(代入が own property にならず値が黙って消える)`,
      );
    }
    result[key] = canonicalizeAt(source[key], `${path}.${key}`, depth + 1);
  }
  return result;
}

/**
 * JSON 値を正準形(§1)へ畳む。content ロード/ビルドの単一正準化パス
 * (ADR-023(1))であり、save の直列化形も serialize.ts がこれを通す。
 *
 * 型付きのオーバーロード(1 本目)は「正準化は値の型を変えず順序だけを正す」
 * ことを型に載せたもの。JSON.parse の戻り値のような `unknown` を渡す場合は
 * 2 本目が選ばれ、戻り値は JsonValue になる(実行時の検証はどちらも同じ)。
 *
 * @throws {CanonicalizeError} JSON に表現できない値・非有限数・`__proto__`
 *   キー・深さ上限超過(§1(4)(5)(6)・§3)
 */
export function canonicalizeJson<T extends JsonValue>(value: T): T;
export function canonicalizeJson(value: unknown): JsonValue;
export function canonicalizeJson(value: unknown): JsonValue {
  return canonicalizeAt(value, "$", 0);
}
