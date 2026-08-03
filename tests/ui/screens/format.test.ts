// ---------------------------------------------------------------------------
// src/ui/screens/format.ts のテスト。
//
// `formatGameClock`/`formatTickSpan` は既存(tests/ui/screens/appShell.test.ts
// で固定済み)。ここでは [M61/FC11] で追加/拡張した桁整形を確認する:
//   - formatResourceAmount の3桁区切り(R1-A22「firewood 1,620,004.7」)
//   - formatApproxDecimal1(R1-A22「戦力59.5125」→ 小数1桁)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  formatApproxDecimal1,
  formatRatePerMinute,
  formatResourceAmount,
  formatResourceStock,
} from "../../../src/ui/screens/format";

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

describe("[2026-08-02 実プレイ報告] formatResourceStock: 在庫は整数切り捨て+3桁区切り", () => {
  it("端数は切り捨てる(四捨五入しない —— 所持量を多く見せない)", () => {
    expect(formatResourceStock(43.9)).toBe("43");
    expect(formatResourceStock(0.7)).toBe("0");
    expect(formatResourceStock(1620004.7)).toBe("1,620,004");
  });

  it("整数はそのまま(小数点を出さない)", () => {
    expect(formatResourceStock(0)).toBe("0");
    expect(formatResourceStock(400)).toBe("400");
    expect(formatResourceStock(1000000)).toBe("1,000,000");
  });

  it("コスト表示(formatResourceAmount)とは役割が別 —— 同じ入力で端数の有無が異なり得る", () => {
    expect(formatResourceAmount(43.2)).toBe("43.2");
    expect(formatResourceStock(43.2)).toBe("43");
  });

  it("有限数でなければ例外", () => {
    expect(() => formatResourceStock(Number.NaN)).toThrow(RangeError);
    expect(() => formatResourceStock(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("[M62/FC4] formatRatePerMinute: /tick の内部語を /分 へ(GDD 11.1・R2-D01)", () => {
  it("formatResourceAmount と同じ桁整形に「/分」を付ける", () => {
    expect(formatRatePerMinute(1.5)).toBe("1.5/分");
    expect(formatRatePerMinute(100)).toBe("100/分");
    expect(formatRatePerMinute(0)).toBe("0/分");
  });

  it("3桁区切りも資源在庫表示(HUD)と一致する(R2-FC9: 薪だけ体裁が揃わない不統一の解消)", () => {
    expect(formatRatePerMinute(1620004.7)).toBe("1,620,004.7/分");
  });

  it("内部語 tick を含まない", () => {
    expect(formatRatePerMinute(42)).not.toContain("tick");
  });
});

describe("[M63/R4-A02] formatRatePerMinute: 1 未満は有効数字方式で小数桁を増やす(「0/分」虚偽表示の解消)", () => {
  it("1/3000 再校正後の資材施設レート(0.004〜0.035)が「0/分」に潰れない", () => {
    // 実 content(hearth の lvCurve)由来の値。
    expect(formatRatePerMinute(0.035)).not.toBe("0/分");
    expect(formatRatePerMinute(0.004)).not.toBe("0/分");
    expect(formatRatePerMinute(0.035)).toBe("0.035/分");
    expect(formatRatePerMinute(0.004)).toBe("0.0040/分");
  });

  it("[台本T7] hearth の lvCurve 5段が全て異なる表示になる(増築でLv間のレート差が判別できる)", () => {
    const hearthLvCurve = [0.035, 0.04025, 0.046287, 0.053231, 0.061215];
    const texts = hearthLvCurve.map((value) => formatRatePerMinute(value));
    expect(new Set(texts).size).toBe(hearthLvCurve.length);
  });

  it("[台本T7] より桁の小さいカーブ(0.004系)も5段全て異なる表示になる", () => {
    const smallLvCurve = [0.004, 0.0046, 0.00529, 0.006083, 0.006996];
    const texts = smallLvCurve.map((value) => formatRatePerMinute(value));
    expect(new Set(texts).size).toBe(smallLvCurve.length);
  });

  it("0 ちょうどは従来どおり「0/分」", () => {
    expect(formatRatePerMinute(0)).toBe("0/分");
  });

  it("1 以上は既存の formatResourceAmount 経由のまま(3桁区切り・小数第1位)", () => {
    expect(formatRatePerMinute(1620004.7)).toBe("1,620,004.7/分");
  });

  it("負のレート(隣接ペナルティ等)でも符号を保ったまま丸める", () => {
    expect(formatRatePerMinute(-0.035)).toBe("-0.035/分");
  });

  it("有限数でなければ例外", () => {
    expect(() => formatRatePerMinute(Number.NaN)).toThrow(RangeError);
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
