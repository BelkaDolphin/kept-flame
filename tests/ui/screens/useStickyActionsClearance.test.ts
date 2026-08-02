// ---------------------------------------------------------------------------
// src/ui/screens/useStickyActionsClearance.ts の純関数部分のテスト(M61/FC3)。
//
// DOM 測定を伴う hook 本体(useStickyActionsClearance)はこのリポジトリの
// vitest 環境(jsdom 無し・ADR-001)では直接テストできない(ColonyClock 等と
// 同じ切り分け・実機検証は Playwright)。ここでは純粋な計算部分だけを固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  clearanceMarginPx,
  verticalOverlapPx,
} from "../../../src/ui/screens/useStickyActionsClearance";

describe("verticalOverlapPx", () => {
  it("重なりが無ければ0(bより上)", () => {
    expect(verticalOverlapPx({ top: 0, bottom: 100 }, { top: 200, bottom: 300 })).toBe(0);
  });

  it("重なりが無ければ0(bより下)", () => {
    expect(verticalOverlapPx({ top: 200, bottom: 300 }, { top: 0, bottom: 100 })).toBe(0);
  });

  it("部分的に重なる場合は重なり幅を返す(R1-C03の実測値と同型)", () => {
    // 実測: expedition 390x844 で sticky top=715/bottom=784, roi top=690/bottom=760
    // だが、ここでは軽い数値で同じ形を確認する。
    expect(verticalOverlapPx({ top: 671, bottom: 740 }, { top: 690, bottom: 760 })).toBe(50);
  });

  it("完全に内包される場合は内側の高さぶん", () => {
    expect(verticalOverlapPx({ top: 0, bottom: 100 }, { top: 20, bottom: 80 })).toBe(60);
  });

  it("接するだけ(隙間0)は重なり0", () => {
    expect(verticalOverlapPx({ top: 0, bottom: 100 }, { top: 100, bottom: 200 })).toBe(0);
  });
});

describe("clearanceMarginPx", () => {
  it("重なりが無ければ0(margin を足さない)", () => {
    expect(clearanceMarginPx(0)).toBe(0);
  });

  it("重なりがあれば重なり分+余裕4pxを返す", () => {
    expect(clearanceMarginPx(50)).toBe(54);
  });
});
