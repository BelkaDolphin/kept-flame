// ---------------------------------------------------------------------------
// src/ui/screens/Toast.tsx のテスト(M63/R4-A14: 廃材代替の消費内訳句)。
//
// `resourceSpendBreakdownPhrase` は判定を一切持たない純関数(前後在庫の差分
// だけを見る)。廃材代替(GDD 6.7 の3出口)が実際に起きたかどうかも、この
// 「観測された消費量」からしか判断しない。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import { resourceSpendBreakdownPhrase } from "../../../src/ui/screens/Toast";

const id = entityIdFromString;
const FIREWOOD = id("firewood");
const WASTE = id("waste");

describe("[M63/R4-A14] resourceSpendBreakdownPhrase(廃材代替の消費内訳句)", () => {
  it("廃材代替が起きた場合は「主資源N+廃材M」の内訳を返す(R4-A14のタスク例に一致)", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockApprox: 60, afterStockApprox: 32 },
      { resourceId: WASTE, beforeStockApprox: 20, afterStockApprox: 13 },
    );
    expect(text).toBe("薪28+廃材7");
  });

  it("廃材代替が起きていない(廃材在庫が動いていない)場合は主資源だけの句", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockApprox: 60, afterStockApprox: 25 },
      { resourceId: WASTE, beforeStockApprox: 20, afterStockApprox: 20 },
    );
    expect(text).toBe("薪35");
  });

  it("廃材資源そのものが渡されない(content に wasteResourceId が無い)場合も主資源だけの句", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockApprox: 60, afterStockApprox: 25 },
      { resourceId: null, beforeStockApprox: null, afterStockApprox: null },
    );
    expect(text).toBe("薪35");
  });

  it("主資源のコストが無い(増築コストなし等)場合は空文字列", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: null, beforeStockApprox: null, afterStockApprox: null },
      { resourceId: WASTE, beforeStockApprox: 20, afterStockApprox: 13 },
    );
    expect(text).toBe("");
  });

  it("主資源が拒否等で動いていない(before===after)場合は空文字列", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockApprox: 60, afterStockApprox: 60 },
      { resourceId: WASTE, beforeStockApprox: 20, afterStockApprox: 20 },
    );
    expect(text).toBe("");
  });

  it("整数切り捨て後に差が無ければ廃材ぶんの内訳は付けない(端数だけの変動をノイズとして無視)", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockApprox: 60, afterStockApprox: 25 },
      { resourceId: WASTE, beforeStockApprox: 20.4, afterStockApprox: 20.1 },
    );
    expect(text).toBe("薪35");
  });
});
