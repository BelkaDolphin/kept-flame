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

describe("[M62/FC3改訂] clearanceMarginPx(絶対値ベース: sticky帯の下端まで押し下げる)", () => {
  it("重なりが無ければ0(margin を足さない)", () => {
    expect(clearanceMarginPx({ top: 0, bottom: 100 }, { top: 200, bottom: 300 })).toBe(0);
  });

  it("部分的な重なり: margin適用後は実際に重なりが0になる(R1-C03の実測値と同型)", () => {
    const content = { top: 671, bottom: 740 };
    const sticky = { top: 690, bottom: 760 };
    const margin = clearanceMarginPx(content, sticky);
    // 押し下げた後の contentRect で再測定 → 重なりが実際に消えていることを固定する
    // (この「押し下げた後で確認する」形が、収束しない旧式を検出できなかった
    // 弱点への直接の回答)。
    const shifted = { top: content.top + margin, bottom: content.bottom + margin };
    expect(verticalOverlapPx(shifted, sticky)).toBe(0);
  });

  it("[R2-E01の再現] 直前コンテンツがsticky帯を完全に内包するケースでも収束する(実測値そのもの)", () => {
    // scratchpad r2-axisCE/round-02-axisCE-result.json の実測値:
    // content top=784.6/bottom=1092.19(内包)、sticky top=895.0/bottom=964.0(69px)。
    // 旧式(overlapPx+4=72.97px)を足しても実測重なりは69pxのまま変化しなかった。
    const content = { top: 784.6, bottom: 1092.19 };
    const sticky = { top: 895.0, bottom: 964.0 };
    // 旧式の値を足しても収束しないことをまず確認する(回帰検出用の前提固定)。
    const oldFormulaMargin = verticalOverlapPx(content, sticky) + 4;
    const shiftedByOldFormula = {
      top: content.top + oldFormulaMargin,
      bottom: content.bottom + oldFormulaMargin,
    };
    expect(verticalOverlapPx(shiftedByOldFormula, sticky)).toBe(69);

    // 新式は同じ入力で実際に重なりを0まで収束させる。
    const margin = clearanceMarginPx(content, sticky);
    const shifted = { top: content.top + margin, bottom: content.bottom + margin };
    expect(verticalOverlapPx(shifted, sticky)).toBe(0);
    expect(margin).toBeCloseTo(964.0 - 784.6 + 4, 5);
  });

  it("完全に内包される単純ケースでも収束する", () => {
    const content = { top: 0, bottom: 100 };
    const sticky = { top: 20, bottom: 80 };
    const margin = clearanceMarginPx(content, sticky);
    const shifted = { top: content.top + margin, bottom: content.bottom + margin };
    expect(verticalOverlapPx(shifted, sticky)).toBe(0);
  });
});
