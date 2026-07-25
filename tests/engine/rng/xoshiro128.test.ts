import { describe, expect, it } from "vitest";
import {
  seedXoshiro128,
  splitmix32Next,
  xoshiro128Next,
  type Xoshiro128State,
} from "../../../src/engine/rng/xoshiro128";

// ---------------------------------------------------------------------------
// xoshiro128** (v1.1) 参照実装との突合テスト。
//
// 出典1(アルゴリズム定義): https://prng.di.unimi.it/xoshiro128starstar.c
//   (Blackman & Vigna, 2018, public domain。2026-07-25 に生ソースを取得して
//   確認。ファイル冒頭コメントに "version 1.0 had mistakenly s[0] instead of
//   s[1] as state word passed to the scrambler" と明記されており、本実装・
//   本テストは訂正後の v1.1(s[1] を使う版)を対象とする)。
//
// 出典2(既知ベクタ、先頭10件): rand_xoshiro (Rust) クレートの reference テスト
//   https://github.com/rust-random/rngs/blob/master/rand_xoshiro/src/xoshiro128starstar.rs
//   ```
//   let mut rng = Xoshiro128StarStar::from_seed([1,0,0,0, 2,0,0,0, 3,0,0,0, 4,0,0,0]);
//   // -> state words (LE): s0=1, s1=2, s2=3, s3=4
//   let expected = [11520, 0, 5927040, 70819200, 2031721883, 1637235492,
//                   1287239034, 3734860849, 3729100597, 4258142804];
//   ```
//   コメント曰く "These values were produced with the reference implementation
//   (v1.1): http://xoshiro.di.unimi.it/xoshiro128starstar.c"。
//
// 下記 VECTORS の先頭10件はそのまま上記の公開ベクタ(出典2)。
// 11件目以降は同じ seed (1,2,3,4) から続けて
// 生成した値で、出典1の C ロジックを Python と JavaScript の2つの独立した
// 言語で個別にトレースし(本実装ファイルとは別のスクラッチスクリプト)、
// 先頭10件が出典2と一致すること・11件目以降が両言語間で完全一致すること
// (bit-for-bit)を確認した上でここへ書き写している。つまり実装コード自身の
// 出力をコピーした「自己一致」テストではない。
//
// なお Apache Commons RNG の XoShiRo128StarStar 実装(commons-rng-core)は
// 同じ SEED 表記に対し異なる出力列を返すことを調査時に確認した。これは
// 同実装が(コメント上は「参照Cコードの実行結果」としつつも)v1.0 の
// バグ版アルゴリズム(s[0] を使う版)を実装しているためであり、本テストの
// 採用ベクタ(v1.1・rand_xoshiro 由来)とは非互換。混同を避けるため
// 本テストでは採用しない。
// ---------------------------------------------------------------------------

const SEED: Xoshiro128State = [1, 2, 3, 4];

// seed(1,2,3,4) から30回 next() を呼んだ出力列。
const VECTORS: readonly number[] = [
  // --- 先頭10件: rand_xoshiro 公開ベクタと一致(出典2) ---
  11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
  4258142804,
  // --- 11件目以降: 同一 seed の続き(Python/JS 二重トレースで相互検証済み) ---
  337829053, 2142557243, 3576906021, 2006103318, 3870238204, 1001584594, 3804789018, 2299676403,
  3571406116, 2962224741, 2455399324, 2204902570, 3487887384, 4280504250, 539482314, 1610455189,
  2787735797, 738153673, 361528596, 2300077205,
];

describe("xoshiro128** 参照実装との突合", () => {
  it(`公開ベクタと一致する(${VECTORS.length}件、最低20件要件を満たす)`, () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);

    let state: Xoshiro128State = SEED;
    const actual: number[] = [];
    for (let i = 0; i < VECTORS.length; i++) {
      const draw = xoshiro128Next(state);
      actual.push(draw.value);
      state = draw.state;
    }
    expect(actual).toEqual(VECTORS);
  });

  it("next()は入力stateを書き換えない純関数である", () => {
    const before: Xoshiro128State = [1, 2, 3, 4];
    const snapshot = [...before];
    xoshiro128Next(before);
    expect(before).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// splitmix32 (seed 展開) の32bit境界の構造化テスト(ADR-007)。
//
// 出典: splitmix32.c (Kaito Udagawa, 2016, CC0)
//   https://github.com/umireon/my-random-stuff/blob/e7b17f992955f4dbb02d4016682113b48b2f6ec1/xorshift/splitmix32.c
// 下記の期待値は、上記Cソースのロジック(GOLDEN_GAMMA加算 + MurmurHash3
// fmix32 finalizer)を Python と JavaScript で個別にトレースし、
// 両言語で完全一致することを確認した上で書き写している。
// ---------------------------------------------------------------------------

interface BoundaryCase {
  readonly name: string;
  readonly state: number;
  readonly expectedValue: number;
  readonly expectedNextState: number;
}

const BOUNDARY_CASES: readonly BoundaryCase[] = [
  {
    name: "0x00000000",
    state: 0x00000000,
    expectedValue: 0x92ca2f0e,
    expectedNextState: 0x9e3779b9,
  },
  {
    name: "0xFFFFFFFF",
    state: 0xffffffff,
    expectedValue: 0x36deb503,
    expectedNextState: 0x9e3779b8,
  },
  {
    name: "0x7FFFFFFF",
    state: 0x7fffffff,
    expectedValue: 0x32a452cd,
    expectedNextState: 0x1e3779b8,
  },
  {
    name: "0x80000000",
    state: 0x80000000,
    expectedValue: 0xbd12a56a,
    expectedNextState: 0x1e3779b9,
  },
];

describe("splitmix32: 32bit境界の構造化テスト(ADR-007)", () => {
  for (const c of BOUNDARY_CASES) {
    it(`state=${c.name} は既知ベクタ通りの value/nextState を返す`, () => {
      const draw = splitmix32Next(c.state);
      expect(draw.value).toBe(c.expectedValue >>> 0);
      expect(draw.state).toBe(c.expectedNextState >>> 0);
    });
  }

  it("state=0xFFFFFFFF からのnextStateはGOLDEN_GAMMA加算がuint32でオーバーフローせず折り返す", () => {
    // 0xFFFFFFFF + 0x9e3779b9 = 0x19e3779b8 (33bit) -> 下位32bitは 0x9e3779b8。
    const draw = splitmix32Next(0xffffffff);
    expect(draw.state).toBe(0x9e3779b8);
  });

  it("4つの境界値は互いに異なるvalue/nextStateを生む(境界での縮退がない)", () => {
    const draws = BOUNDARY_CASES.map((c) => splitmix32Next(c.state));
    const values = draws.map((d) => d.value);
    const states = draws.map((d) => d.state);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(states).size).toBe(states.length);
  });
});

// ---------------------------------------------------------------------------
// seedXoshiro128: worldSeed -> xoshiro128** 4語state の展開。
// splitmix32を単一アキュムレータで4回連続呼び出す実装なので、
// splitmix32Next を手動で4回連鎖させた結果と一致するはず。
// ---------------------------------------------------------------------------

describe("seedXoshiro128: worldSeedからのseed展開", () => {
  it("splitmix32Nextを手動で4回連鎖させた結果と一致する(worldSeed=1)", () => {
    const r0 = splitmix32Next(1 >>> 0);
    const r1 = splitmix32Next(r0.state);
    const r2 = splitmix32Next(r1.state);
    const r3 = splitmix32Next(r2.state);
    const expected: Xoshiro128State = [r0.value, r1.value, r2.value, r3.value];

    expect(seedXoshiro128(1)).toEqual(expected);
  });

  it("既知ベクタ: worldSeed=1 の展開結果(splitmix32.cトレースより)", () => {
    // x[0]=1 から splitmix32 を4回連鎖: verify_splitmix32.{py,mjs} で
    // Python/JavaScript 双方から得た先頭4件(前掲の32bit境界テストと同一の
    // 参照実装トレースの一部)。
    expect(seedXoshiro128(1)).toEqual([2527132011, 314344336, 2535364964, 2041432039]);
  });

  for (const worldSeed of [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 12345, 999999937]) {
    it(`worldSeed=${worldSeed} の展開stateは全語0にならない(構造的保証、ADR-007)`, () => {
      const state = seedXoshiro128(worldSeed);
      expect(state.some((word) => word !== 0)).toBe(true);
    });
  }

  it("異なるworldSeedは異なるstateを生む", () => {
    const a = seedXoshiro128(1);
    const b = seedXoshiro128(2);
    expect(a).not.toEqual(b);
  });
});
