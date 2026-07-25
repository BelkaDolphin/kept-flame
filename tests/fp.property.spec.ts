import { describe, expect, it } from "vitest";
import {
  type Fix,
  fixFromRaw,
  fixFromInt,
  toApproxNumber,
  addFix,
  subFix,
  negFix,
  minFix,
  maxFix,
  clampFix,
  sumFix,
  mulFix,
  mulFixProven,
  mulFixBig,
  mulFixInt,
  floorDivFix,
  floorDivFixBig,
  floorDivInt,
  isqrt,
  isqrtBig,
  sqrtFix,
  FIX_SCALE,
  FIX_ONE,
  FIX_ZERO,
  FIX_MAX,
  FIX_MIN,
  FIX_RAW_ABS_MAX,
  FIX_MUL_SYMMETRIC_BOUND,
  FIX_INT_ABS_MAX,
  FixRangeError,
  FixDivisionByZeroError,
} from "../src/engine/fp";

// ---------------------------------------------------------------------------
// fp.ts(1e6固定小数点演算層)の差分テスト + プロパティテスト。
//
// 目的は 2 つ:
//   (1) 経路一致性 — mulFix/mulFixBig/mulFixProven、floorDivFix/floorDivFixBig
//       が「BigInt で数学的定義そのまま書いたオラクル」と全入力で一致すること
//       (ADR-006「未証明経路は BigInt 必須」「number 経路と BigInt 経路は全入力で
//       同値」の機械確認そのもの)。
//   (2) fp.ts 冒頭コメント §2/§3 が主張する代数的性質(floor の定義、-0 非正規化、
//       floor 方向が -∞ であること等)を PRNG で量産したケースで検査する。
//
// オラクルは fp.ts の内部実装をコピーしない独立実装であること自体に意味がある
// (実装のバグがオラクル側にも紛れ込むのを避けるため)。PRNG は決定論的固定シード
// のみを使い、Math.random / Date.now は使わない。
//
// tests/fp.spec.ts(通常の単体テスト、別ファイル)とは役割を分けており、
// このファイルは触らない・作らない対象に含まれない(このファイル自体が成果物)。
// ---------------------------------------------------------------------------

// --- BigInt オラクル ---------------------------------------------------------

const BIG_SCALE = 1_000_000n;
const BIG_MAX_SAFE = 9_007_199_254_740_991n; // 2^53 - 1
const BIG_MIN_SAFE = -BIG_MAX_SAFE;

/**
 * floor 除算の真値。BigInt の `/` は 0 方向 trunc なので符号補正を入れる。
 * fp.ts の実装をコピーせず、floor の数学的定義から独立に書いたもの。
 */
function floorDivOracle(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/** 値が Fix の安全整数域(±(2^53-1))を外れているか。 */
function isOutOfSafeRange(value: bigint): boolean {
  return value > BIG_MAX_SAFE || value < BIG_MIN_SAFE;
}

// --- 決定論PRNG(mulberry32) -------------------------------------------------

/** 固定シード群。同じ入力列を再現するため常にこの配列だけを使う。 */
const SEEDS: readonly number[] = [0x12345678, 0x9e3779b9, 1, 0xffffffff];

/**
 * mulberry32。32bit 符号なし整数を返す決定論PRNG。
 * Math.imul + >>> 0 のみで完結し、Math.random には一切依存しない。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function nextUint32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const BITS_21_MASK = 0x1fffff; // 2^21 - 1
const TWO_POW_21 = 0x200000; // 2^21

/**
 * [0, 2^53-1] の安全整数を一様に生成する。32bit 出力を 2 回呼び、
 * 上位32bit×下位21bit で合成する(high * 2^21 + low の最大値がちょうど
 * 2^53-1 になる = FIX_RAW_ABS_MAX と一致する)。
 */
function nextSafeUint53(rng: () => number): number {
  const high = rng();
  const low = rng() & BITS_21_MASK;
  return high * TWO_POW_21 + low;
}

/** [0, maxAbs](maxAbs <= 2^53-1)の整数を生成する(剰余法。一様性より網羅性優先)。 */
function nextUintUpTo(rng: () => number, maxAbs: number): number {
  if (maxAbs <= 0) return 0;
  return nextSafeUint53(rng) % (maxAbs + 1);
}

/** [-maxAbs, maxAbs] の符号付き整数を生成する(0 を含む)。 */
function nextIntInRange(rng: () => number, maxAbs: number): number {
  const magnitude = nextUintUpTo(rng, maxAbs);
  const negative = (rng() & 1) === 1;
  return negative ? -magnitude : magnitude;
}

/** [-maxAbs, -1] ∪ [1, maxAbs] の符号付き整数を生成する(0 を除外。除数生成用)。 */
function nextNonZeroIntInRange(rng: () => number, maxAbs: number): number {
  const magnitude = 1 + nextUintUpTo(rng, maxAbs - 1);
  const negative = (rng() & 1) === 1;
  return negative ? -magnitude : magnitude;
}

// マグニチュード帯(raw 値)。
const BOUND_SMALL = FIX_SCALE; // |raw| <= 1e6
const BOUND_MEDIUM = 1_000_000_000; // |raw| <= 1e9
const BOUND_LARGE = FIX_RAW_ABS_MAX; // |raw| <= 2^53-1

// --- 差分検査ヘルパ ----------------------------------------------------------

/**
 * mulFix / mulFixBig / mulFixProven の三経路を BigInt オラクルへ突合する。
 * - mulFix / mulFixBig は常に数学的真値と一致するか、真値が安全整数域を
 *   外れる場合は両方とも FixRangeError を投げる。
 * - mulFixProven は中間積(a*b、除算前)が 2^53 境界を超えたら FixRangeError。
 *   超えなければ「中間積が域内 ⇒ 最終値 floor(P/1e6) は必ず域内」なので
 *   mulFix と同じ値を返す。
 */
function checkMulTriple(a: Fix, b: Fix): void {
  const product = BigInt(a) * BigInt(b);
  const trueValue = floorDivOracle(product, BIG_SCALE);
  const finalOutOfRange = isOutOfSafeRange(trueValue);
  const intermediateOutOfRange = isOutOfSafeRange(product);

  if (finalOutOfRange) {
    expect(() => mulFix(a, b)).toThrow(FixRangeError);
    expect(() => mulFixBig(a, b)).toThrow(FixRangeError);
  } else {
    const expected = Number(trueValue);
    expect(mulFix(a, b)).toBe(expected);
    expect(mulFixBig(a, b)).toBe(expected);
  }

  if (intermediateOutOfRange) {
    expect(() => mulFixProven(a, b)).toThrow(FixRangeError);
  } else {
    expect(finalOutOfRange).toBe(false);
    expect(mulFixProven(a, b)).toBe(Number(trueValue));
  }
}

/** floorDivFix / floorDivFixBig を BigInt オラクルへ突合する。b は 0 でないこと。 */
function checkFloorDivPair(a: Fix, b: Fix): void {
  const numerator = BigInt(a) * BIG_SCALE;
  const trueValue = floorDivOracle(numerator, BigInt(b));
  if (isOutOfSafeRange(trueValue)) {
    expect(() => floorDivFix(a, b)).toThrow(FixRangeError);
    expect(() => floorDivFixBig(a, b)).toThrow(FixRangeError);
  } else {
    const expected = Number(trueValue);
    expect(floorDivFix(a, b)).toBe(expected);
    expect(floorDivFixBig(a, b)).toBe(expected);
  }
}

/** mulFixInt を BigInt オラクルへ突合する。 */
function checkMulFixIntPair(a: Fix, k: number): void {
  const trueValue = BigInt(a) * BigInt(k);
  if (isOutOfSafeRange(trueValue)) {
    expect(() => mulFixInt(a, k)).toThrow(FixRangeError);
  } else {
    expect(mulFixInt(a, k)).toBe(Number(trueValue));
  }
}

/** floorDivInt を BigInt オラクルへ突合する。結果は |a| 以下なので域外にはならない。 */
function checkFloorDivIntPair(a: number, b: number): void {
  const trueValue = floorDivOracle(BigInt(a), BigInt(b));
  expect(floorDivInt(a, b)).toBe(Number(trueValue));
}

// ---------------------------------------------------------------------------

describe("決定論PRNG", () => {
  it("同じシードから同じ入力列を再現する", () => {
    const a = mulberry32(0x12345678);
    const b = mulberry32(0x12345678);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 20; i++) {
      seqA.push(a());
      seqB.push(b());
    }
    expect(seqA).toEqual(seqB);
  });

  it("異なるシードは異なる入力列を生成する", () => {
    const a = mulberry32(0x12345678);
    const b = mulberry32(1);
    expect(a()).not.toBe(b());
  });
});

describe("mulFix / mulFixBig / mulFixProven 経路一致性", () => {
  it("小(|raw| <= 1e6)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        checkMulTriple(
          fixFromRaw(nextIntInRange(rng, BOUND_SMALL)),
          fixFromRaw(nextIntInRange(rng, BOUND_SMALL)),
        );
      }
    }
  });

  it("中(|raw| <= 1e9)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        checkMulTriple(
          fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM)),
          fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM)),
        );
      }
    }
  });

  it("大(|raw| <= 2^53-1)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        checkMulTriple(
          fixFromRaw(nextIntInRange(rng, BOUND_LARGE)),
          fixFromRaw(nextIntInRange(rng, BOUND_LARGE)),
        );
      }
    }
  });

  it("混合(小×大、2^53境界を跨ぐ組合せ)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const small = fixFromRaw(nextIntInRange(rng, BOUND_SMALL));
        const large = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        if (i % 2 === 0) {
          checkMulTriple(small, large);
        } else {
          checkMulTriple(large, small);
        }
      }
    }
  });

  it("負数の floor 方向: 0方向trunc ではなく -∞方向floor である(明示例)", () => {
    expect(mulFix(fixFromRaw(-1), fixFromRaw(1))).toBe(-1);
    expect(mulFix(fixFromRaw(1), fixFromRaw(-1))).toBe(-1);
    expect(mulFix(fixFromRaw(-1_000_001), fixFromRaw(1_000_001))).toBe(-1_000_003);
  });
});

describe("floorDivFix / floorDivFixBig 経路一致性", () => {
  it("被除数small〜large、除数positive", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const b = fixFromRaw(1 + nextUintUpTo(rng, BOUND_MEDIUM));
        checkFloorDivPair(a, b);
      }
    }
  });

  it("被除数small〜large、除数negative", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const b = fixFromRaw(-(1 + nextUintUpTo(rng, BOUND_MEDIUM)));
        checkFloorDivPair(a, b);
      }
    }
  });

  it("0除算は FixDivisionByZeroError(両経路)", () => {
    expect(() => floorDivFix(fixFromInt(1), FIX_ZERO)).toThrow(FixDivisionByZeroError);
    expect(() => floorDivFixBig(fixFromInt(1), FIX_ZERO)).toThrow(FixDivisionByZeroError);
  });

  it("負数の floor 方向: 明示例(切り捨てが -∞ 方向であること)", () => {
    // floor(-1 * 1e6 / 2e6) = floor(-0.5) = -1(trunc なら 0 になるはず)。
    expect(floorDivFix(fixFromRaw(-1), fixFromInt(2))).toBe(-1);
    // -7/3 = -2.333... なので floor は -2.333334(raw -2_333_334)。
    // trunc なら -2.333333(raw -2_333_333)になり、floor と食い違う。
    expect(floorDivFix(fixFromInt(-7), fixFromInt(3))).toBe(fixFromRaw(-2_333_334));
  });
});

describe("mulFixInt 経路一致性", () => {
  it("a はsmall〜large、k は符号付き安全整数", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const k = nextIntInRange(rng, BOUND_LARGE);
        checkMulFixIntPair(a, k);
      }
    }
  });

  it("単位元: mulFixInt(a,1)===a、mulFixInt(a,0)===0", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 50; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        expect(mulFixInt(a, 1)).toBe(a);
        expect(mulFixInt(a, 0)).toBe(0);
      }
    }
  });
});

describe("floorDivInt", () => {
  it("floor(a/b) を BigInt オラクルと突合(除数の符号は正負両方)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 100; i++) {
        const a = nextIntInRange(rng, BOUND_LARGE);
        const magnitude = 1 + nextUintUpTo(rng, BOUND_MEDIUM);
        const b = i % 2 === 0 ? magnitude : -magnitude;
        checkFloorDivIntPair(a, b);
      }
    }
  });

  it("0除算は FixDivisionByZeroError", () => {
    expect(() => floorDivInt(10, 0)).toThrow(FixDivisionByZeroError);
  });

  it("負数の floor 方向の明示例", () => {
    expect(floorDivInt(-1, 2)).toBe(-1);
    expect(floorDivInt(-7, 2)).toBe(-4);
  });
});

describe("代数的プロパティ", () => {
  it("mulFix の交換律(両方とも成功する/両方とも同じ例外を投げるを含めて検査)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const b = fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM));

        let resultAB: Fix | "throw";
        try {
          resultAB = mulFix(a, b);
        } catch (e) {
          expect(e).toBeInstanceOf(FixRangeError);
          resultAB = "throw";
        }

        let resultBA: Fix | "throw";
        try {
          resultBA = mulFix(b, a);
        } catch (e) {
          expect(e).toBeInstanceOf(FixRangeError);
          resultBA = "throw";
        }

        expect(resultAB).toBe(resultBA);
      }
    }
  });

  it("単位元: mulFix(a, FIX_ONE) === a", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        expect(mulFix(a, FIX_ONE)).toBe(a);
      }
    }
  });

  it("mulFix は floor の定義そのものを満たす: r*1e6 <= a*b < (r+1)*1e6", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const b = fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM));
        const product = BigInt(a) * BigInt(b);
        const trueValue = floorDivOracle(product, BIG_SCALE);
        if (isOutOfSafeRange(trueValue)) continue; // mulFix は域外なら例外を投げる側の話であり、定義検査の対象外
        const r = mulFix(a, b);
        const rBig = BigInt(r);
        expect(rBig * BIG_SCALE <= product).toBe(true);
        expect(product < (rBig + 1n) * BIG_SCALE).toBe(true);
      }
    }
  });

  it("floorDivFix は floor の定義を満たす(b の符号で不等号の向きが反転する)", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
        const b = fixFromRaw(nextNonZeroIntInRange(rng, BOUND_MEDIUM));
        const numerator = BigInt(a) * BIG_SCALE;
        const bBig = BigInt(b);
        const trueValue = floorDivOracle(numerator, bBig);
        if (isOutOfSafeRange(trueValue)) continue;
        const r = floorDivFix(a, b);
        const rBig = BigInt(r);
        if (bBig > 0n) {
          expect(rBig * bBig <= numerator).toBe(true);
          expect(numerator < (rBig + 1n) * bBig).toBe(true);
        } else {
          expect(rBig * bBig >= numerator).toBe(true);
          expect(numerator > (rBig + 1n) * bBig).toBe(true);
        }
      }
    }
  });

  describe("加減算", () => {
    it("addFix は交換律を満たす", () => {
      for (const seed of SEEDS) {
        const rng = mulberry32(seed);
        for (let i = 0; i < 250; i++) {
          const a = fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM));
          const b = fixFromRaw(nextIntInRange(rng, BOUND_MEDIUM));
          expect(addFix(a, b)).toBe(addFix(b, a));
        }
      }
    });

    it("subFix(a,a) === 0", () => {
      for (const seed of SEEDS) {
        const rng = mulberry32(seed);
        for (let i = 0; i < 100; i++) {
          const a = fixFromRaw(nextIntInRange(rng, BOUND_LARGE));
          expect(subFix(a, a)).toBe(0);
        }
      }
    });

    it("sumFix は逐次 addFix と一致する", () => {
      for (const seed of SEEDS) {
        const rng = mulberry32(seed);
        for (let trial = 0; trial < 50; trial++) {
          const values: Fix[] = [];
          for (let i = 0; i < 20; i++) {
            values.push(fixFromRaw(nextIntInRange(rng, BOUND_SMALL)));
          }
          let expected = FIX_ZERO;
          for (const v of values) {
            expected = addFix(expected, v);
          }
          expect(sumFix(values)).toBe(expected);
        }
      }
    });

    it("加減算の桁溢れは FixRangeError", () => {
      expect(() => addFix(FIX_MAX, fixFromInt(1))).toThrow(FixRangeError);
      expect(() => subFix(FIX_MIN, fixFromInt(1))).toThrow(FixRangeError);
    });
  });

  describe("clampFix / minFix / maxFix の境界", () => {
    it("clampFix: 等号ケースと範囲内/範囲外", () => {
      const lo = fixFromInt(-10);
      const hi = fixFromInt(10);
      expect(clampFix(lo, lo, hi)).toBe(lo);
      expect(clampFix(hi, lo, hi)).toBe(hi);
      expect(clampFix(fixFromInt(0), lo, hi)).toBe(fixFromInt(0));
      expect(clampFix(fixFromInt(-100), lo, hi)).toBe(lo);
      expect(clampFix(fixFromInt(100), lo, hi)).toBe(hi);
    });

    it("clampFix: lo > hi は FixRangeError", () => {
      expect(() => clampFix(fixFromInt(0), fixFromInt(10), fixFromInt(-10))).toThrow(FixRangeError);
    });

    it("minFix / maxFix: 等号・大小両方向", () => {
      const a = fixFromInt(3);
      const b = fixFromInt(7);
      expect(minFix(a, b)).toBe(a);
      expect(minFix(b, a)).toBe(a);
      expect(minFix(a, a)).toBe(a);
      expect(maxFix(a, b)).toBe(b);
      expect(maxFix(b, a)).toBe(b);
      expect(maxFix(a, a)).toBe(a);
    });
  });

  it("-0 が結果に漏れない(全経路で Object.is(result, -0) === false)", () => {
    const zero = fixFromRaw(0);
    const negFive = fixFromRaw(-5_000_000); // -5.0

    expect(Object.is(mulFix(zero, negFive), -0)).toBe(false);
    expect(Object.is(mulFixBig(zero, negFive), -0)).toBe(false);
    expect(Object.is(mulFixInt(zero, -5), -0)).toBe(false);
    expect(Object.is(floorDivFix(zero, negFive), -0)).toBe(false);
    expect(Object.is(floorDivFixBig(zero, negFive), -0)).toBe(false);
    expect(Object.is(negFix(zero), -0)).toBe(false);
    expect(Object.is(sumFix([]), -0)).toBe(false);
  });
});

describe("isqrt", () => {
  it("0..20000 の全数で r*r <= n < (r+1)^2 を満たす", () => {
    for (let n = 0; n <= 20000; n++) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });

  it("完全平方数とその±1(k=1,2,3,1000,65535,65536,FIX_MUL_SYMMETRIC_BOUND)", () => {
    const bases = [1, 2, 3, 1000, 65535, 65536, FIX_MUL_SYMMETRIC_BOUND];
    for (const k of bases) {
      // FIX_MUL_SYMMETRIC_BOUND^2 = 9007199136250225 <= 2^53-1 なので
      // BigInt→Number 変換は厳密(fp.ts 冒頭コメント §4 の早見表)。
      const n = Number(BigInt(k) * BigInt(k));
      expect(isqrt(n)).toBe(k);
      expect(isqrt(n - 1)).toBe(k - 1);
      expect(isqrt(n + 1)).toBe(k);
    }
  });

  it("isqrt(Number.MAX_SAFE_INTEGER) === FIX_MUL_SYMMETRIC_BOUND", () => {
    expect(isqrt(Number.MAX_SAFE_INTEGER)).toBe(FIX_MUL_SYMMETRIC_BOUND);
  });

  it("PRNGで生成した 2000 件の n(0..2^53-1)で性質検査 + isqrtBig との一致", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 500; i++) {
        const n = nextSafeUint53(rng);
        const r = isqrt(n);
        const nBig = BigInt(n);
        const rBig = BigInt(r);
        // number で (r+1)^2 を作ると 2^53 を超えて丸まりうるため必ず BigInt で検査する。
        expect(rBig * rBig <= nBig).toBe(true);
        expect(nBig < (rBig + 1n) * (rBig + 1n)).toBe(true);
        expect(Number(isqrtBig(nBig))).toBe(r);
      }
    }
  });

  it("負数・非整数・NaN・Infinity で FixRangeError", () => {
    expect(() => isqrt(-1)).toThrow(FixRangeError);
    expect(() => isqrt(1.5)).toThrow(FixRangeError);
    expect(() => isqrt(Number.NaN)).toThrow(FixRangeError);
    expect(() => isqrt(Number.POSITIVE_INFINITY)).toThrow(FixRangeError);
    expect(() => isqrtBig(-1n)).toThrow(FixRangeError);
  });
});

describe("sqrtFix", () => {
  function assertSqrtFixProperty(a: Fix): void {
    const r = sqrtFix(a);
    const scaled = BigInt(a) * BIG_SCALE;
    const rBig = BigInt(r);
    expect(rBig * rBig <= scaled).toBe(true);
    expect(scaled < (rBig + 1n) * (rBig + 1n)).toBe(true);
  }

  it("number経路(a <= FIX_INT_ABS_MAX)でオラクルの性質を満たす", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const a = fixFromRaw(nextUintUpTo(rng, FIX_INT_ABS_MAX));
        assertSqrtFixProperty(a);
      }
    }
  });

  it("BigInt経路(a > FIX_INT_ABS_MAX)でオラクルの性質を満たす", () => {
    for (const seed of SEEDS) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 250; i++) {
        const extra = nextUintUpTo(rng, BOUND_LARGE - FIX_INT_ABS_MAX - 1);
        const a = fixFromRaw(FIX_INT_ABS_MAX + 1 + extra);
        assertSqrtFixProperty(a);
      }
    }
  });

  it("特殊値: sqrtFix(FIX_ONE)===FIX_ONE、sqrtFix(4)===2、sqrtFix(0)===0", () => {
    expect(sqrtFix(FIX_ONE)).toBe(FIX_ONE);
    expect(sqrtFix(fixFromInt(4))).toBe(fixFromInt(2));
    expect(sqrtFix(FIX_ZERO)).toBe(FIX_ZERO);
  });

  it("負数は FixRangeError", () => {
    expect(() => sqrtFix(fixFromRaw(-1))).toThrow(FixRangeError);
  });
});

describe("生成口", () => {
  it("fixFromRaw: 非整数・NaN・Infinity・-Infinity・±2^53 は FixRangeError、±(2^53-1) は成功", () => {
    expect(() => fixFromRaw(1.5)).toThrow(FixRangeError);
    expect(() => fixFromRaw(Number.NaN)).toThrow(FixRangeError);
    expect(() => fixFromRaw(Number.POSITIVE_INFINITY)).toThrow(FixRangeError);
    expect(() => fixFromRaw(Number.NEGATIVE_INFINITY)).toThrow(FixRangeError);
    expect(() => fixFromRaw(2 ** 53)).toThrow(FixRangeError);
    expect(() => fixFromRaw(-(2 ** 53))).toThrow(FixRangeError);
    expect(fixFromRaw(FIX_RAW_ABS_MAX)).toBe(FIX_RAW_ABS_MAX);
    expect(fixFromRaw(-FIX_RAW_ABS_MAX)).toBe(-FIX_RAW_ABS_MAX);
  });

  it("fixFromInt: ±FIX_INT_ABS_MAX は成功、その±1は FixRangeError、非整数も FixRangeError", () => {
    expect(fixFromInt(FIX_INT_ABS_MAX)).toBe(FIX_INT_ABS_MAX * FIX_SCALE);
    expect(fixFromInt(-FIX_INT_ABS_MAX)).toBe(-FIX_INT_ABS_MAX * FIX_SCALE);
    expect(() => fixFromInt(FIX_INT_ABS_MAX + 1)).toThrow(FixRangeError);
    expect(() => fixFromInt(-(FIX_INT_ABS_MAX + 1))).toThrow(FixRangeError);
    expect(() => fixFromInt(1.5)).toThrow(FixRangeError);
  });

  it("toApproxNumber: 基本的な往復", () => {
    expect(toApproxNumber(fixFromInt(1))).toBe(1);
    expect(toApproxNumber(fixFromInt(-5))).toBe(-5);
    expect(toApproxNumber(fixFromRaw(500_000))).toBe(0.5);
    expect(toApproxNumber(FIX_ZERO)).toBe(0);
  });
});
