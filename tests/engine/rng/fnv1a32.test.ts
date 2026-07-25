import { describe, expect, it } from "vitest";
import {
  fnv1a32,
  fnv1a32Uint32,
  FNV_OFFSET_BASIS,
  hashRngDomain,
} from "../../../src/engine/rng/fnv1a32";
import { DOMAIN_TAGS } from "../../../src/engine/rng/domainTags";

// ---------------------------------------------------------------------------
// FNV-1a-32 標準テストベクタとの突合。
//
// 出典: Landon Curt Noll et al. の public domain reference test suite
//   https://github.com/lcn2/fnv/blob/master/test_fnv.c
// 該当箇所: `fnv_test_str[]`(テスト対象文字列。121行目付近)と
// `fnv1a_32_vector[]`(期待hash値。735行目付近)。以下12件は
// fnv_test_str のインデックス0〜11("" から "foobar" までの接頭辞列)と
// それに対応する fnv1a_32_vector の値をそのまま書き写したもの。
// ASCII文字列のみを対象とするため、UTF-16コードユニット単位で走査する
// 本実装(fnv1a32.ts 冒頭コメント参照)でも標準のバイト単位FNV-1aと
// 完全に一致する。
// ---------------------------------------------------------------------------

const STANDARD_VECTORS: readonly (readonly [string, number])[] = [
  ["", 0x811c9dc5],
  ["a", 0xe40c292c],
  ["b", 0xe70c2de5],
  ["c", 0xe60c2c52],
  ["d", 0xe10c2473],
  ["e", 0xe00c22e0],
  ["f", 0xe30c2799],
  ["fo", 0x6222e842],
  ["foo", 0xa9f37ed7],
  ["foob", 0x3f5076ef],
  ["fooba", 0x39aaa18a],
  ["foobar", 0xbf9cf968],
];

describe("fnv1a32: 標準テストベクタ(FNVリファレンス実装)との突合", () => {
  for (const [input, expected] of STANDARD_VECTORS) {
    it(`fnv1a32(${JSON.stringify(input)}) === 0x${expected.toString(16)}`, () => {
      expect(fnv1a32(input)).toBe(expected >>> 0);
    });
  }

  it("空文字列のhashはFNV offset basisそのものと一致する", () => {
    expect(fnv1a32("")).toBe(FNV_OFFSET_BASIS);
    expect(FNV_OFFSET_BASIS).toBe(0x811c9dc5);
  });

  it("同じ文字列は常に同じhashを返す(決定論)", () => {
    expect(fnv1a32("kept-flame")).toBe(fnv1a32("kept-flame"));
  });

  it("1文字違うだけでhashが変わる(雪崩性の最低限のスモークテスト)", () => {
    expect(fnv1a32("exploration")).not.toBe(fnv1a32("explorationX"));
  });
});

describe("fnv1a32Uint32: uint32値の畳み込み", () => {
  it("異なる数値は(基本的に)異なるhashを生む", () => {
    const a = fnv1a32Uint32(FNV_OFFSET_BASIS, 1);
    const b = fnv1a32Uint32(FNV_OFFSET_BASIS, 2);
    expect(a).not.toBe(b);
  });

  it("seedを変えると同じ数値でも異なるhashになる(ドメイン分離の土台)", () => {
    const a = fnv1a32Uint32(FNV_OFFSET_BASIS, 42);
    const b = fnv1a32Uint32(fnv1a32("salt"), 42);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// hashRngDomain: ADR-007の `hash(worldSeed, domainTag, salt...)` 実装。
// ドメイン分離が実際に異なる列を生むことを確認する(実装内容5の要件)。
// ---------------------------------------------------------------------------

describe("hashRngDomain: ドメイン分離hash(ADR-007)", () => {
  it("同じ worldSeed/domainTag/salt なら常に同じhashを返す(決定論)", () => {
    const a = hashRngDomain(123, DOMAIN_TAGS.exploration, [1, 2, 3]);
    const b = hashRngDomain(123, DOMAIN_TAGS.exploration, [1, 2, 3]);
    expect(a).toBe(b);
  });

  it("worldSeedが違えば異なるhashを生む", () => {
    const a = hashRngDomain(1, DOMAIN_TAGS.exploration, [1, 2, 3]);
    const b = hashRngDomain(2, DOMAIN_TAGS.exploration, [1, 2, 3]);
    expect(a).not.toBe(b);
  });

  it("saltが違えば異なるhashを生む(branchId/choiceKeyが異なる枝の独立性)", () => {
    const retreatBranch = hashRngDomain(
      1,
      DOMAIN_TAGS.exploration,
      [/* dispatchId */ 10, /* nodeIndex */ 2, /* branchId */ 0, /* choiceKey */ 1],
    );
    const pushBranch = hashRngDomain(
      1,
      DOMAIN_TAGS.exploration,
      [/* dispatchId */ 10, /* nodeIndex */ 2, /* branchId */ 1, /* choiceKey */ 1],
    );
    expect(retreatBranch).not.toBe(pushBranch);
  });

  it("saltの要素数が違えば異なるhashを生む(空saltと非空saltの衝突がない)", () => {
    const a = hashRngDomain(1, DOMAIN_TAGS.exploration, []);
    const b = hashRngDomain(1, DOMAIN_TAGS.exploration, [0]);
    expect(a).not.toBe(b);
  });
});
