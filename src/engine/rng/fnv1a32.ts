// ---------------------------------------------------------------------------
// FNV-1a-32 (Fowler/Noll/Vo hash, 32bit 版)。ADR-007 の RNG ドメイン分離 hash。
//
// --- 参照実装・テストベクタの出典 ---
// Landon Curt Noll et al., public domain reference test suite:
//   https://github.com/lcn2/fnv (test_fnv.c)
//   http://www.isthe.com/chongo/tech/comp/fnv/index.html
// アルゴリズム定義(FNV-1a, 32bit):
//   hash = 0x811c9dc5 (FNV offset basis)
//   for each byte b: hash = hash XOR b; hash = (hash * 0x01000193) mod 2^32 (FNV prime)
//
// --- 文字列の走査単位 ---
// String.prototype.charCodeAt による UTF-16 コードユニット単位。ADR-010 が
// content 正準化ソートを UTF-16 コードユニット順に統一していることに合わせ、
// TextEncoder 等のホスト API(engine では未許可・eslint.config.js の
// GLOBAL_IO 相当に準ずる思想)に依存せず文字列を決定論的に数値化する。
// domainTag/content ID は ADR-011 の命名正規表現 `^[a-z][a-zA-Z0-9_]*$` により
// ASCII のみなので、コードユニット値はそのまま ASCII バイト値と一致し、
// 標準(バイト単位)の FNV-1a-32 公開テストベクタと完全一致する
// (tests/engine/rng/fnv1a32.test.ts で確認)。非 ASCII 入力に対しては
// 「UTF-16 コードユニット単位の FNV-1a」であり、標準の UTF-8 バイト単位 FNV
// とは値が異なる点に注意(本エンジンの入力はドメインタグ/ID/salt に限られ
// ASCII のみを想定するため実用上の差異はない)。
// ---------------------------------------------------------------------------

import type { DomainTag } from "./domainTags";

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

// hash(uint32) * FNV_PRIME_32 の積は Number の安全整数境界 2^53 を超えうる
// ため、通常の `*` 演算子では丸めが発生し得る。Math.imul は ECMA-262 が
// 「ToInt32 変換後の下位32bit を返す厳密演算」と規定する exact 演算であり、
// [2026-07-25改訂] で ADR-006 の Math 許可リストへ追加された
// (ユーザー承認済み。根拠: ADR-007 との矛盾解消)。ただし Math.imul の返り値は
// signed int32(ECMA-262 が ToInt32 の値域で規定)であり、旧 imul32 の
// `>>> 0` 付き unsigned 出力と異なるため、末尾に `>>> 0` を明示して
// uint32 契約(fnv1a32/fnv1a32Uint32 が hash を >>> 0 せず直接返す前提)を保つ。
/** FNV-1a-32 の1バイト分の畳み込み(XOR してから FNV prime を掛ける)。 */
function foldByte(hash: number, byte: number): number {
  return Math.imul((hash ^ byte) >>> 0, FNV_PRIME_32) >>> 0;
}

/**
 * 文字列を FNV-1a-32 で hash する。`seed` を渡すと、その値を初期状態として
 * 続けて畳み込む(ドメイン分離のための連結に使う。省略時は FNV offset basis)。
 */
export function fnv1a32(input: string, seed: number = FNV_OFFSET_BASIS_32): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash = foldByte(hash, input.charCodeAt(i));
  }
  return hash;
}

/**
 * uint32 の数値1個を FNV-1a-32 へ畳み込む(4バイト、MSB から順に XOR/乗算)。
 * worldSeed や salt 要素(dispatchId/nodeIndex 等)は文字列化せず数値のまま
 * バイト分解して畳み込む(10進表記や符号表記への依存を構造的に排除する。
 * ADR-010 の「ロケール非依存」の考え方を数値側にも適用したもの)。
 */
export function fnv1a32Uint32(seed: number, value: number): number {
  let hash = seed >>> 0;
  const v = value >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) {
    hash = foldByte(hash, (v >>> shift) & 0xff);
  }
  return hash;
}

/** FNV-1a-32 の offset basis(=空入力に対する hash 値)。 */
export const FNV_OFFSET_BASIS = FNV_OFFSET_BASIS_32;

/**
 * ADR-007 の RNG ドメイン構成 `hash(worldSeed, domainTag, salt...)` の単一実装。
 * worldSeed → domainTag 文字列 → salt 各要素(uint32)の順で同一 hash へ
 * 畳み込む。得られた uint32 を `seedXoshiro128()`(xoshiro128.ts)へ渡すと
 * そのドメイン/salt に固有の RNG ストリーム seed になる。domainTag は
 * `domainTags.ts` の frozen レジストリの値のみを受け付ける(ADR-024(2))。
 */
export function hashRngDomain(
  worldSeed: number,
  domainTag: DomainTag,
  salt: readonly number[],
): number {
  let hash = fnv1a32Uint32(FNV_OFFSET_BASIS_32, worldSeed);
  hash = fnv1a32(domainTag, hash);
  for (const s of salt) {
    hash = fnv1a32Uint32(hash, s);
  }
  return hash;
}
