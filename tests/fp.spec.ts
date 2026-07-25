import { describe, expect, it } from "vitest";

import {
  FIX_INT_ABS_MAX,
  FIX_MAX,
  FIX_MIN,
  FIX_MUL_SYMMETRIC_BOUND,
  FIX_ONE,
  FIX_RAW_ABS_MAX,
  FIX_SCALE,
  FIX_ZERO,
  FixDivisionByZeroError,
  FixRangeError,
  absFix,
  addFix,
  clampFix,
  fixFromInt,
  fixFromRaw,
  floorDivFix,
  floorDivFixBig,
  floorDivInt,
  isqrt,
  isqrtBig,
  maxFix,
  minFix,
  mulFix,
  mulFixBig,
  mulFixInt,
  mulFixProven,
  negFix,
  sqrtFix,
  subFix,
  sumFix,
  toApproxNumber,
  toRaw,
  type Fix,
} from "../src/engine/fp";

// ---------------------------------------------------------------------------
// 固定小数点層(ADR-006 / GDD 11.7)の spec。
//
// このファイルは「手計算ベクタ + 境界値 + 経路一致性」を担当する。期待値は
// すべて BigInt で独立に計算した数値リテラルとして埋め込んである(実装を呼んで
// 期待値を作ると恒真式になるため)。網羅的なランダム差分/プロパティ検査は
// tests/fp.property.spec.ts が担当する。
//
// 期待値は Fix(branded number)ではなく raw の number で書き、toRaw() で
// 剥がして比較する。
// ---------------------------------------------------------------------------

/** raw から Fix を作る短縮。テスト内の可読性のためだけの別名。 */
const f = (raw: number): Fix => fixFromRaw(raw);

/** Fix から raw を剥がす短縮。 */
const r = (v: Fix): number => toRaw(v);

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991 = 2^53-1

describe("定数", () => {
  it("スケールと単位元", () => {
    expect(FIX_SCALE).toBe(1_000_000);
    expect(r(FIX_ONE)).toBe(1_000_000);
    expect(r(FIX_ZERO)).toBe(0);
    expect(FIX_RAW_ABS_MAX).toBe(MAX_SAFE);
    expect(r(FIX_MAX)).toBe(MAX_SAFE);
    expect(r(FIX_MIN)).toBe(-MAX_SAFE);
  });

  it("FIX_MUL_SYMMETRIC_BOUND は floor(sqrt(2^53-1)) である", () => {
    const b = BigInt(FIX_MUL_SYMMETRIC_BOUND);
    expect(FIX_MUL_SYMMETRIC_BOUND).toBe(94_906_265);
    expect(b * b <= BigInt(MAX_SAFE)).toBe(true);
    expect((b + 1n) * (b + 1n) > BigInt(MAX_SAFE)).toBe(true);
  });

  it("FIX_INT_ABS_MAX は floor((2^53-1)/1e6) である", () => {
    const b = BigInt(FIX_INT_ABS_MAX);
    expect(FIX_INT_ABS_MAX).toBe(9_007_199_254);
    expect(b * 1_000_000n <= BigInt(MAX_SAFE)).toBe(true);
    expect((b + 1n) * 1_000_000n > BigInt(MAX_SAFE)).toBe(true);
  });

  // fp.ts §4 の「number 経路が安全な入力範囲」早見表が腐るのを防ぐ検算。
  // 表の値を変えたらこのテストが落ちる = 表と実際の境界が乖離しない。
  it("§4 早見表(係数 × 量の上界)の検算", () => {
    const table: readonly (readonly [number, number])[] = [
      [2_000_000, 4_503_599_627],
      [10_000_000, 900_719_925],
      [100_000_000, 90_071_992],
    ];
    for (const [coeff, quantity] of table) {
      const c = BigInt(coeff);
      const q = BigInt(quantity);
      expect(c * q <= BigInt(MAX_SAFE)).toBe(true);
      expect(c * (q + 1n) > BigInt(MAX_SAFE)).toBe(true);
    }
  });
});

describe("生成と取り出し", () => {
  it("fixFromRaw は安全整数のみ受け付ける", () => {
    expect(r(fixFromRaw(0))).toBe(0);
    expect(r(fixFromRaw(MAX_SAFE))).toBe(MAX_SAFE);
    expect(r(fixFromRaw(-MAX_SAFE))).toBe(-MAX_SAFE);
    for (const bad of [1.5, 0.000001, NaN, Infinity, -Infinity, MAX_SAFE + 1, -(MAX_SAFE + 1)]) {
      expect(() => fixFromRaw(bad)).toThrow(FixRangeError);
    }
  });

  it("fixFromRaw は -0 を +0 に正規化する", () => {
    expect(Object.is(r(fixFromRaw(-0)), 0)).toBe(true);
  });

  it("fixFromInt は人間単位整数を 1e6 倍する", () => {
    expect(r(fixFromInt(0))).toBe(0);
    expect(r(fixFromInt(1))).toBe(1_000_000);
    expect(r(fixFromInt(-3))).toBe(-3_000_000);
    expect(r(fixFromInt(FIX_INT_ABS_MAX))).toBe(9_007_199_254_000_000);
    expect(r(fixFromInt(-FIX_INT_ABS_MAX))).toBe(-9_007_199_254_000_000);
    for (const bad of [FIX_INT_ABS_MAX + 1, -(FIX_INT_ABS_MAX + 1), 1.5, NaN, Infinity]) {
      expect(() => fixFromInt(bad)).toThrow(FixRangeError);
    }
  });

  it("toApproxNumber は表示用の近似(engine へ戻さない)", () => {
    expect(toApproxNumber(fixFromInt(3))).toBe(3);
    expect(toApproxNumber(f(1_500_000))).toBe(1.5);
    expect(toApproxNumber(f(-1))).toBe(-0.000001);
  });
});

// ---------------------------------------------------------------------------
// mulFix 手計算ベクタ。
//   期待値は BigInt で floor((a*b)/1e6) を独立計算した値。
//   bigOnly = true は「中間積が 2^53 を超える = BigInt 経路でしか正しく出せない」
//   ケース(mulFixProven が FixRangeError を投げる側)。
// ---------------------------------------------------------------------------
interface MulVector {
  readonly a: number;
  readonly b: number;
  readonly expected: number;
  readonly bigOnly: boolean;
  readonly note: string;
}

const MUL_VECTORS: readonly MulVector[] = [
  { a: 1_500_000, b: 2_000_000, expected: 3_000_000, bigOnly: false, note: "1.5 * 2.0 = 3.0" },
  { a: 100_000, b: 100_000, expected: 10_000, bigOnly: false, note: "0.1 * 0.1 = 0.01" },
  { a: 500_000, b: 500_000, expected: 250_000, bigOnly: false, note: "0.5 * 0.5 = 0.25" },
  { a: 1, b: 1, expected: 0, bigOnly: false, note: "1e-6 * 1e-6 は floor で 0" },
  { a: -1, b: 1, expected: -1, bigOnly: false, note: "負の微小積は floor で -1e-6(trunc なら 0)" },
  { a: 1, b: -1, expected: -1, bigOnly: false, note: "符号の位置によらず floor" },
  { a: -1, b: -1, expected: 0, bigOnly: false, note: "負 * 負 = 正の微小積は 0" },
  { a: 1_000_001, b: 1_000_001, expected: 1_000_002, bigOnly: false, note: "端数切り捨て" },
  {
    a: -1_000_001,
    b: 1_000_001,
    expected: -1_000_003,
    bigOnly: false,
    note: "負数は -∞ 方向へ切り捨て(trunc なら -1000002)",
  },
  { a: 999_999, b: 999_999, expected: 999_998, bigOnly: false, note: "0.999999^2" },
  { a: -999_999, b: 999_999, expected: -999_999, bigOnly: false, note: "負数側の floor" },
  { a: 3_333_333, b: 3_000_000, expected: 9_999_999, bigOnly: false, note: "割り切れる積" },
  { a: 1_234_567, b: 7_654_321, expected: 9_449_772, bigOnly: false, note: "一般の端数" },
  {
    a: 2_000_000_000,
    b: 3_000_000,
    expected: 6_000_000_000,
    bigOnly: false,
    note: "中間積 6e15 < 2^53 = number 経路",
  },
  {
    a: 3_000_000_000,
    b: 3_000_000,
    expected: 9_000_000_000,
    bigOnly: false,
    note: "中間積 9e15 < 2^53 = number 経路の上端付近",
  },
  {
    a: 3_100_000_000,
    b: 3_000_000,
    expected: 9_300_000_000,
    bigOnly: true,
    note: "中間積 9.3e15 > 2^53 = BigInt 経路",
  },
  {
    a: 441_650_591,
    b: 20_394_401,
    expected: 9_007_199_254,
    bigOnly: false,
    note: "中間積がちょうど 2^53-1(number 経路の厳密上端)",
  },
  {
    a: -441_650_591,
    b: 20_394_401,
    expected: -9_007_199_255,
    bigOnly: false,
    note: "中間積がちょうど -(2^53-1)。floor で -9007199255",
  },
  {
    a: 134_217_728,
    b: 67_108_864,
    expected: 9_007_199_254,
    bigOnly: true,
    note: "中間積がちょうど 2^53(2^27 * 2^26)= BigInt 経路の下端",
  },
  {
    a: -134_217_728,
    b: 67_108_864,
    expected: -9_007_199_255,
    bigOnly: true,
    note: "中間積がちょうど -2^53",
  },
  {
    a: MAX_SAFE,
    b: 1_000_000,
    expected: MAX_SAFE,
    bigOnly: true,
    note: "raw 最大 * 1.0 = 恒等(中間積は 9e21)",
  },
  {
    a: -MAX_SAFE,
    b: 1_000_000,
    expected: -MAX_SAFE,
    bigOnly: true,
    note: "raw 最小 * 1.0 = 恒等",
  },
  {
    a: MAX_SAFE,
    b: 999_999,
    expected: 9_007_190_247_541_736,
    bigOnly: true,
    note: "raw 最大 * 0.999999",
  },
];

describe("mulFix 手計算ベクタ(floor 規約・GDD 11.7)", () => {
  for (const v of MUL_VECTORS) {
    it(`mulFix(${v.a}, ${v.b}) = ${v.expected} — ${v.note}`, () => {
      expect(r(mulFix(f(v.a), f(v.b)))).toBe(v.expected);
      // 交換律(floor は積の順序に依存しない)
      expect(r(mulFix(f(v.b), f(v.a)))).toBe(v.expected);
      // BigInt 固定経路と一致
      expect(r(mulFixBig(f(v.a), f(v.b)))).toBe(v.expected);
    });
  }

  it("mulFixProven は値域証明済みのときだけ number 経路で同値を返す", () => {
    for (const v of MUL_VECTORS) {
      if (v.bigOnly) {
        // 中間積が 2^53 境界を超える = 値域証明が破れた側
        expect(() => mulFixProven(f(v.a), f(v.b))).toThrow(FixRangeError);
      } else {
        expect(r(mulFixProven(f(v.a), f(v.b)))).toBe(v.expected);
      }
    }
  });

  it("1.0 は乗法の単位元", () => {
    for (const raw of [0, 1, -1, 1_234_567, -7_654_321, MAX_SAFE, -MAX_SAFE]) {
      expect(r(mulFix(f(raw), FIX_ONE))).toBe(raw);
      expect(r(mulFix(FIX_ONE, f(raw)))).toBe(raw);
    }
  });

  it("結果が安全整数の範囲を超えたら FixRangeError", () => {
    expect(() => mulFix(FIX_MAX, FIX_MAX)).toThrow(FixRangeError);
    expect(() => mulFixBig(FIX_MAX, FIX_MAX)).toThrow(FixRangeError);
    expect(() => mulFix(FIX_MAX, f(2_000_000))).toThrow(FixRangeError);
  });
});

// ---------------------------------------------------------------------------
// ADR-006 が撤回した旧設計(除算「後」にだけ 2^53 を検査する)の回帰テスト。
// ---------------------------------------------------------------------------
describe("ADR-006 fatal 回帰: 中間積の丸めは除算後の検査では捕まらない", () => {
  // a ≈ 1e9 raw(人間単位 1000.000016)、b = 1e12 raw(人間単位 1e6)。
  // 中間積 1.000000016e21 は倍精度で丸められるが、÷1e6 した後の値は
  // 2^53 未満なので「事後 assert」は素通りする。真値は BigInt で
  // floor(1000000016 * 1000000000000 / 1e6) = 1000000016000000。
  const a = 1_000_000_016;
  const b = 1_000_000_000_000;
  const truth = 1_000_000_016_000_000;

  it("旧設計(除算後にだけ検査)は実際に誤った値を通す", () => {
    const naive = Math.floor((a * b) / FIX_SCALE); // 旧設計の再現
    expect(Number.isSafeInteger(naive)).toBe(true); // 事後 assert は通過してしまう
    expect(naive).toBe(1_000_000_015_999_999); // しかし値が 1 ずれている
    expect(naive).not.toBe(truth);
  });

  it("mulFix は除算前ガードで BigInt 経路へ落ち、厳密値を返す", () => {
    expect(r(mulFix(f(a), f(b)))).toBe(truth);
    expect(r(mulFixBig(f(a), f(b)))).toBe(truth);
    expect(() => mulFixProven(f(a), f(b))).toThrow(FixRangeError);
  });

  it("同種の既知ケース群でも number 経路の素朴計算と分岐する", () => {
    const cases: readonly (readonly [number, number, number])[] = [
      [1_000_000_010, 1_234_567_890_123, 1_234_567_902_468_678],
      [1_000_000_019, 1_234_567_890_123, 1_234_567_913_579_789],
      [704_327_437, 9_209_000_000_000, 6_486_151_367_333_000],
      [562_248_724, 5_907_000_000_000, 3_321_203_212_668_000],
      [21_741_673, 9_531_000_000_000, 207_219_885_363_000],
    ];
    for (const [x, y, expected] of cases) {
      expect(r(mulFix(f(x), f(y)))).toBe(expected);
      expect(Math.floor((x * y) / FIX_SCALE)).not.toBe(expected);
    }
  });
});

describe("mulFixInt(スケール補正なし)", () => {
  it("手計算ベクタ", () => {
    expect(r(mulFixInt(f(1_500_000), 3))).toBe(4_500_000);
    expect(r(mulFixInt(f(1_500_000), 0))).toBe(0);
    expect(r(mulFixInt(f(-1_500_000), 3))).toBe(-4_500_000);
    expect(r(mulFixInt(f(1_500_000), -3))).toBe(-4_500_000);
    expect(r(mulFixInt(f(1), 1))).toBe(1);
  });

  it("中間積が 2^53 を超えても BigInt 経路で厳密", () => {
    // 3_000_000_000_000 * 3001 = 9.003e15 < 2^53 (number 経路)
    expect(r(mulFixInt(f(3_000_000_000_000), 3001))).toBe(9_003_000_000_000_000);
    // 3_000_000_000_000 * 3002 = 9.006e15 < 2^53 だが 3003 で超える
    expect(r(mulFixInt(f(3_000_000_000_000), 3002))).toBe(9_006_000_000_000_000);
    expect(() => mulFixInt(f(3_000_000_000_000), 3003)).toThrow(FixRangeError);
  });

  it("整数でない係数を拒否する", () => {
    for (const bad of [1.5, NaN, Infinity, MAX_SAFE + 1]) {
      expect(() => mulFixInt(f(1_000_000), bad)).toThrow(FixRangeError);
    }
  });
});

describe("floorDivFix / floorDivFixBig", () => {
  const vectors: readonly (readonly [number, number, number, string])[] = [
    [3_000_000, 2_000_000, 1_500_000, "3.0 / 2.0 = 1.5"],
    [1_000_000, 3_000_000, 333_333, "1.0 / 3.0 は切り捨て"],
    [1, 3_000_000, 0, "微小 / 3.0 = 0"],
    [-1, 3_000_000, -1, "負の微小 / 3.0 は floor で -1e-6"],
    [7_000_000, -2_000_000, -3_500_000, "除数が負"],
    [-7_000_000, 2_000_000, -3_500_000, "被除数が負"],
    [-7_000_000, -2_000_000, 3_500_000, "両方負"],
    [10_000_000_000, 3_000_000, 3_333_333_333, "10000 / 3.0"],
    [MAX_SAFE, 1_000_000, MAX_SAFE, "raw 最大 / 1.0 = 恒等(BigInt 経路)"],
  ];

  for (const [a, b, expected, note] of vectors) {
    it(`floorDivFix(${a}, ${b}) = ${expected} — ${note}`, () => {
      expect(r(floorDivFix(f(a), f(b)))).toBe(expected);
      expect(r(floorDivFixBig(f(a), f(b)))).toBe(expected);
    });
  }

  it("|a| > 9_007_199_254 では BigInt 経路(中間値 a*1e6 が 2^53 を超える)", () => {
    // number 経路の上端: 9_007_199_254 * 1e6 = 9007199254000000 <= 2^53-1
    expect(r(floorDivFix(f(9_007_199_254), FIX_ONE))).toBe(9_007_199_254);
    expect(r(floorDivFix(f(9_007_199_255), FIX_ONE))).toBe(9_007_199_255);
    expect(r(floorDivFix(f(-9_007_199_255), FIX_ONE))).toBe(-9_007_199_255);
  });

  it("0 除算は FixDivisionByZeroError", () => {
    expect(() => floorDivFix(f(1_000_000), FIX_ZERO)).toThrow(FixDivisionByZeroError);
    expect(() => floorDivFixBig(f(1_000_000), FIX_ZERO)).toThrow(FixDivisionByZeroError);
  });

  it("結果が安全整数の範囲を超えたら FixRangeError", () => {
    expect(() => floorDivFix(FIX_MAX, f(1))).toThrow(FixRangeError);
  });
});

describe("floorDivInt(素の整数の floor 除算)", () => {
  it("符号の組合せで trunc ではなく floor になる", () => {
    expect(floorDivInt(7, 2)).toBe(3);
    expect(floorDivInt(-7, 2)).toBe(-4);
    expect(floorDivInt(7, -2)).toBe(-4);
    expect(floorDivInt(-7, -2)).toBe(3);
    expect(floorDivInt(6, 3)).toBe(2);
    expect(floorDivInt(-6, 3)).toBe(-2);
    expect(floorDivInt(0, -5)).toBe(0);
    expect(Object.is(floorDivInt(0, -5), 0)).toBe(true);
    expect(floorDivInt(MAX_SAFE, -1)).toBe(-MAX_SAFE);
    expect(floorDivInt(MAX_SAFE, 1)).toBe(MAX_SAFE);
  });

  it("大きな被除数でも厳密(L2)", () => {
    expect(floorDivInt(MAX_SAFE, 3)).toBe(3_002_399_751_580_330);
    expect(floorDivInt(-MAX_SAFE, 3)).toBe(-3_002_399_751_580_331);
    expect(floorDivInt(MAX_SAFE, MAX_SAFE)).toBe(1);
    expect(floorDivInt(MAX_SAFE - 1, MAX_SAFE)).toBe(0);
    expect(floorDivInt(-MAX_SAFE + 1, MAX_SAFE)).toBe(-1);
  });

  it("0 除算と非安全整数を拒否する", () => {
    expect(() => floorDivInt(1, 0)).toThrow(FixDivisionByZeroError);
    expect(() => floorDivInt(1.5, 1)).toThrow(FixRangeError);
    expect(() => floorDivInt(1, 1.5)).toThrow(FixRangeError);
    expect(() => floorDivInt(NaN, 1)).toThrow(FixRangeError);
  });
});

describe("加減算・比較・クランプ・総和", () => {
  it("加減算の手計算ベクタ", () => {
    expect(r(addFix(f(1_500_000), f(2_500_000)))).toBe(4_000_000);
    expect(r(addFix(f(-1_500_000), f(2_500_000)))).toBe(1_000_000);
    expect(r(subFix(f(1_500_000), f(2_500_000)))).toBe(-1_000_000);
    expect(r(subFix(f(1_500_000), f(1_500_000)))).toBe(0);
    expect(r(negFix(f(1_500_000)))).toBe(-1_500_000);
    expect(r(negFix(f(-1_500_000)))).toBe(1_500_000);
    expect(r(absFix(f(-1_500_000)))).toBe(1_500_000);
    expect(r(absFix(f(1_500_000)))).toBe(1_500_000);
    expect(r(absFix(FIX_MIN))).toBe(MAX_SAFE);
  });

  it("2^53 境界の桁溢れを検出する(L3)", () => {
    expect(r(addFix(f(MAX_SAFE - 1), f(1)))).toBe(MAX_SAFE);
    expect(() => addFix(FIX_MAX, f(1))).toThrow(FixRangeError);
    expect(() => addFix(FIX_MAX, FIX_MAX)).toThrow(FixRangeError);
    expect(() => subFix(FIX_MIN, f(1))).toThrow(FixRangeError);
    expect(r(subFix(FIX_MIN, f(-1)))).toBe(-MAX_SAFE + 1);
  });

  it("min / max / clamp", () => {
    expect(r(minFix(f(1), f(2)))).toBe(1);
    expect(r(maxFix(f(1), f(2)))).toBe(2);
    expect(r(minFix(f(-1), f(-2)))).toBe(-2);
    expect(r(maxFix(f(-1), f(-2)))).toBe(-1);
    expect(r(clampFix(f(5), f(0), f(10)))).toBe(5);
    expect(r(clampFix(f(-1), f(0), f(10)))).toBe(0);
    expect(r(clampFix(f(11), f(0), f(10)))).toBe(10);
    expect(r(clampFix(f(0), f(0), f(10)))).toBe(0);
    expect(r(clampFix(f(10), f(0), f(10)))).toBe(10);
    expect(r(clampFix(f(3), f(3), f(3)))).toBe(3);
    expect(() => clampFix(f(3), f(10), f(0))).toThrow(FixRangeError);
  });

  it("sumFix は途中経過でも桁溢れを検出する(saturating 検知)", () => {
    expect(r(sumFix([]))).toBe(0);
    expect(r(sumFix([f(1), f(2), f(3)]))).toBe(6);
    expect(r(sumFix([f(-1_000_000), f(1_500_000), f(-500_000)]))).toBe(0);
    // 最後にまとめて検査する実装なら通ってしまう並び(途中で 2^53 を超えて戻る)
    expect(() => sumFix([FIX_MAX, FIX_MAX, FIX_MIN])).toThrow(FixRangeError);
    // 逐次 addFix と一致する
    const values = [f(11), f(-22), f(333), f(-4444), f(55_555)];
    let acc = FIX_ZERO;
    for (const v of values) acc = addFix(acc, v);
    expect(r(sumFix(values))).toBe(r(acc));
  });
});

describe("isqrt(整数ニュートン法)", () => {
  it("小さな既知値", () => {
    const known: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [8, 2],
      [9, 3],
      [10, 3],
      [15, 3],
      [16, 4],
      [24, 4],
      [25, 5],
      [999_999, 999],
      [1_000_000, 1_000],
    ];
    for (const [n, expected] of known) {
      expect(isqrt(n)).toBe(expected);
    }
  });

  it("完全平方数 ±1(小〜大)", () => {
    const roots = [1, 2, 3, 7, 100, 1_000, 65_535, 65_536, 1_000_000, 94_906_264, 94_906_265];
    for (const k of roots) {
      const sq = BigInt(k) * BigInt(k);
      expect(isqrt(Number(sq))).toBe(k);
      expect(isqrt(Number(sq - 1n))).toBe(k - 1);
      if (sq + 1n <= BigInt(MAX_SAFE)) {
        expect(isqrt(Number(sq + 1n))).toBe(k);
      }
    }
  });

  it("2^53 近傍の上端", () => {
    expect(isqrt(MAX_SAFE)).toBe(94_906_265);
    expect(isqrt(9_007_199_136_250_225)).toBe(94_906_265); // 94906265^2
    expect(isqrt(9_007_199_136_250_224)).toBe(94_906_264); // 完全平方 -1
    expect(isqrt(9_007_199_136_250_226)).toBe(94_906_265); // 完全平方 +1
  });

  it("0..20000 の全域で r^2 <= n < (r+1)^2", () => {
    for (let n = 0; n <= 20_000; n++) {
      const s = isqrt(n);
      expect(s * s <= n && n < (s + 1) * (s + 1)).toBe(true);
    }
  });

  it("不正な入力を拒否する", () => {
    for (const bad of [-1, -0.5, 1.5, NaN, Infinity, MAX_SAFE + 1]) {
      expect(() => isqrt(bad)).toThrow(FixRangeError);
    }
  });

  it("isqrtBig と一致する", () => {
    for (const n of [0, 1, 2, 3, 4, 10, 9_999, 1_000_000, 123_456_789, MAX_SAFE]) {
      expect(Number(isqrtBig(BigInt(n)))).toBe(isqrt(n));
    }
    // number の値域外
    const big = 12_345_678_901_234_567_890n;
    const s = isqrtBig(big);
    expect(s * s <= big && big < (s + 1n) * (s + 1n)).toBe(true);
    expect(() => isqrtBig(-1n)).toThrow(FixRangeError);
  });
});

describe("sqrtFix", () => {
  it("手計算ベクタ", () => {
    expect(r(sqrtFix(FIX_ZERO))).toBe(0);
    expect(r(sqrtFix(FIX_ONE))).toBe(1_000_000); // sqrt(1) = 1
    expect(r(sqrtFix(f(4_000_000)))).toBe(2_000_000); // sqrt(4) = 2
    expect(r(sqrtFix(f(2_000_000)))).toBe(1_414_213); // sqrt(2) = 1.414213...(切り捨て)
    expect(r(sqrtFix(f(250_000)))).toBe(500_000); // sqrt(0.25) = 0.5
  });

  it("number 経路と BigInt 経路の境界を跨いでも厳密", () => {
    // a * 1e6 が 2^53 を超えるのは a > 9_007_199_254
    expect(r(sqrtFix(f(9_007_199_254)))).toBe(94_906_265);
    expect(r(sqrtFix(f(9_007_199_255)))).toBe(94_906_265);
    expect(r(sqrtFix(FIX_MAX))).toBe(94_906_265_624);
  });

  it("負数を拒否する", () => {
    expect(() => sqrtFix(f(-1))).toThrow(FixRangeError);
    expect(() => sqrtFix(FIX_MIN)).toThrow(FixRangeError);
  });
});

describe("-0 が状態へ漏れない", () => {
  it("各演算の結果は常に +0", () => {
    const zeros: readonly Fix[] = [
      mulFix(FIX_ZERO, f(-5_000_000)),
      mulFix(f(-5_000_000), FIX_ZERO),
      mulFixBig(FIX_ZERO, f(-5_000_000)),
      mulFixProven(FIX_ZERO, f(-5_000_000)),
      mulFixInt(FIX_ZERO, -5),
      mulFixInt(f(-5_000_000), 0),
      floorDivFix(FIX_ZERO, f(-5_000_000)),
      floorDivFixBig(FIX_ZERO, f(-5_000_000)),
      addFix(FIX_ZERO, FIX_ZERO),
      subFix(f(5), f(5)),
      negFix(FIX_ZERO),
      absFix(FIX_ZERO),
      sumFix([]),
      sumFix([f(-5), f(5)]),
      sqrtFix(FIX_ZERO),
      fixFromInt(-0),
    ];
    for (const z of zeros) {
      expect(r(z)).toBe(0);
      expect(Object.is(r(z), -0)).toBe(false);
    }
  });

  it("Fix 以外を返す関数も +0 を返す", () => {
    expect(Object.is(isqrt(-0), -0)).toBe(false);
    expect(Object.is(isqrt(0), -0)).toBe(false);
    expect(Object.is(floorDivInt(0, -5), -0)).toBe(false);
    expect(Object.is(floorDivInt(-1, 5), -1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 決定論的に生成した既知シード列で number 経路と BigInt 経路を突合する。
// (Math.random は engine 同様テストでも使わない。網羅版は fp.property.spec.ts)
// ---------------------------------------------------------------------------
describe("経路一致性(決定論シード列)", () => {
  /** xorshift32。テスト入力の生成専用(engine の PRNG とは無関係)。 */
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
  }

  /** |値| <= absMax の raw を作る。上位 21bit * 2^32 + 下位 32bit で 2^53-1 まで厳密。 */
  function nextRaw(rng: () => number, absMax: number): number {
    const hi = rng() % 2_097_152;
    const lo = rng();
    const magnitude = (hi * 4_294_967_296 + lo) % (absMax + 1);
    return rng() % 2 === 0 ? magnitude : -magnitude;
  }

  function floorDivOracle(n: bigint, d: bigint): bigint {
    const q = n / d;
    return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
  }

  const BUCKETS: readonly (readonly [string, number])[] = [
    ["小(<=1e6)", 1_000_000],
    ["中(<=1e9)", 1_000_000_000],
    ["大(<=1e12)", 1_000_000_000_000],
    ["最大(<=2^53-1)", MAX_SAFE],
  ];

  for (const [label, absMax] of BUCKETS) {
    it(`mulFix: number 経路と BigInt 経路が一致 — ${label}`, () => {
      const rng = makeRng(0x9e37_79b9);
      let bigPathCount = 0;
      for (let i = 0; i < 500; i++) {
        const a = nextRaw(rng, absMax);
        const b = nextRaw(rng, absMax);
        const product = BigInt(a) * BigInt(b);
        const productAbs = product < 0n ? -product : product;
        // 中間積が 2^53 を超える = BigInt 経路(結果が値域内かどうかとは別)
        const viaBigInt = productAbs > BigInt(MAX_SAFE);
        if (viaBigInt) bigPathCount++;

        const truth = floorDivOracle(product, 1_000_000n);
        const outOfRange = truth > BigInt(MAX_SAFE) || truth < -BigInt(MAX_SAFE);
        if (outOfRange) {
          expect(() => mulFix(f(a), f(b))).toThrow(FixRangeError);
          expect(() => mulFixBig(f(a), f(b))).toThrow(FixRangeError);
          continue;
        }
        expect(r(mulFix(f(a), f(b)))).toBe(Number(truth));
        expect(r(mulFixBig(f(a), f(b)))).toBe(Number(truth));
        if (viaBigInt) {
          expect(() => mulFixProven(f(a), f(b))).toThrow(FixRangeError);
        } else {
          expect(r(mulFixProven(f(a), f(b)))).toBe(Number(truth));
        }
      }
      // 大きい帯では BigInt 経路を実際に踏んでいることを確認(経路の空振り防止)
      if (absMax >= 1_000_000_000_000) {
        expect(bigPathCount).toBeGreaterThan(0);
      }
    });

    it(`floorDivFix: number 経路と BigInt 経路が一致 — ${label}`, () => {
      const rng = makeRng(0x1234_5678);
      for (let i = 0; i < 500; i++) {
        const a = nextRaw(rng, absMax);
        const b = nextRaw(rng, absMax);
        if (b === 0) continue;
        const truth = floorDivOracle(BigInt(a) * 1_000_000n, BigInt(b));
        const outOfRange = truth > BigInt(MAX_SAFE) || truth < -BigInt(MAX_SAFE);
        if (outOfRange) {
          expect(() => floorDivFix(f(a), f(b))).toThrow(FixRangeError);
          expect(() => floorDivFixBig(f(a), f(b))).toThrow(FixRangeError);
          continue;
        }
        expect(r(floorDivFix(f(a), f(b)))).toBe(Number(truth));
        expect(r(floorDivFixBig(f(a), f(b)))).toBe(Number(truth));
      }
    });
  }

  it("isqrt: 決定論シード列で r^2 <= n < (r+1)^2 (BigInt で検査)", () => {
    const rng = makeRng(0xdead_beef);
    for (let i = 0; i < 1_000; i++) {
      const n = Math.abs(nextRaw(rng, MAX_SAFE));
      const s = BigInt(isqrt(n));
      const nb = BigInt(n);
      expect(s * s <= nb && nb < (s + 1n) * (s + 1n)).toBe(true);
      expect(Number(isqrtBig(nb))).toBe(isqrt(n));
    }
  });

  it("sqrtFix: 決定論シード列でオラクルと一致(両経路)", () => {
    const rng = makeRng(0x0000_0001);
    for (let i = 0; i < 500; i++) {
      const a = Math.abs(nextRaw(rng, MAX_SAFE));
      const scaled = BigInt(a) * 1_000_000n;
      const s = BigInt(r(sqrtFix(f(a))));
      expect(s * s <= scaled && scaled < (s + 1n) * (s + 1n)).toBe(true);
    }
  });
});
