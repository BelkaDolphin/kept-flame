// ---------------------------------------------------------------------------
// src/ui/screens/format.ts のテスト。
//
// `formatGameClock`/`formatTickSpan` は既存(tests/ui/screens/appShell.test.ts
// で固定済み)。ここでは [M61/FC11] で追加/拡張した桁整形を確認する:
//   - formatResourceAmount の3桁区切り(R1-A22「firewood 1,620,004.7」)
//   - formatApproxDecimal1(R1-A22「戦力59.5125」→ 小数1桁)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { formatApproxDecimal1, formatResourceAmount } from "../../../src/ui/screens/format";

describe("[M61/FC11] formatResourceAmount: 3桁区切り + 小数第1位", () => {
  it("1000未満は区切りなし(既存挙動を維持)", () => {
    expect(formatResourceAmount(0)).toBe("0");
    expect(formatResourceAmount(999)).toBe("999");
    expect(formatResourceAmount(59.5)).toBe("59.5");
  });

  it("1000以上は3桁ごとにカンマを入れる", () => {
    expect(formatResourceAmount(1000)).toBe("1,000");
    expect(formatResourceAmount(1620004.7)).toBe("1,620,004.7");
    expect(formatResourceAmount(1000000)).toBe("1,000,000");
  });

  it("小数第1位までに丸める(区切りが小数部を巻き込まない)", () => {
    expect(formatResourceAmount(1620004.74)).toBe("1,620,004.7");
    expect(formatResourceAmount(1620004.75)).toBe("1,620,004.8");
  });

  it("有限数でなければ例外", () => {
    expect(() => formatResourceAmount(Number.NaN)).toThrow(RangeError);
    expect(() => formatResourceAmount(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("[M61/FC11] formatApproxDecimal1: 戦力・士気等の小数第1位表示", () => {
  it("常に小数第1位まで出す(整数でも .0 を出す)", () => {
    expect(formatApproxDecimal1(50)).toBe("50.0");
    expect(formatApproxDecimal1(59.5125)).toBe("59.5");
  });

  it("桁区切りは付けない(戦力・士気は3桁を超えない値域)", () => {
    expect(formatApproxDecimal1(1234.5)).toBe("1234.5");
  });

  it("有限数でなければ例外", () => {
    expect(() => formatApproxDecimal1(Number.NaN)).toThrow(RangeError);
  });
});
