// ---------------------------------------------------------------------------
// src/ui/screens/Toast.tsx のテスト(M63/R4-A14: 廃材代替の消費内訳句 /
// M70/R5-A04: 消費量表示の ±1 ずれ解消)。
//
// `resourceSpendBreakdownPhrase` は判定を一切持たない純関数(前後在庫の差分
// だけを見る)。廃材代替(GDD 6.7 の3出口)が実際に起きたかどうかも、この
// 「観測された消費量」からしか判断しない。
//
// [M70/R5-A04] 差分の入力は Fix(1e6 固定小数点の raw 整数)。近似値(number)
// どうしを引くと IEEE754 の丸め誤差で ±1 ずれることがあったため、
// `resourceSpendBreakdownPhrase` 自体が Fix を受け取り、固定小数点のまま
// 差を取ってから 1 度だけ近似値へ変換する設計へ変わった。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt, fixFromRaw } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import { resourceSpendBreakdownPhrase } from "../../../src/ui/screens/Toast";

const id = entityIdFromString;
const FIREWOOD = id("firewood");
const WASTE = id("waste");

describe("[M63/R4-A14] resourceSpendBreakdownPhrase(廃材代替の消費内訳句)", () => {
  it("廃材代替が起きた場合は「主資源N+廃材M」の内訳を返す(R4-A14のタスク例に一致)", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: fixFromInt(60), afterStockFix: fixFromInt(32) },
      { resourceId: WASTE, beforeStockFix: fixFromInt(20), afterStockFix: fixFromInt(13) },
    );
    expect(text).toBe("薪28+廃材7");
  });

  it("廃材代替が起きていない(廃材在庫が動いていない)場合は主資源だけの句", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: fixFromInt(60), afterStockFix: fixFromInt(25) },
      { resourceId: WASTE, beforeStockFix: fixFromInt(20), afterStockFix: fixFromInt(20) },
    );
    expect(text).toBe("薪35");
  });

  it("廃材資源そのものが渡されない(content に wasteResourceId が無い)場合も主資源だけの句", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: fixFromInt(60), afterStockFix: fixFromInt(25) },
      { resourceId: null, beforeStockFix: null, afterStockFix: null },
    );
    expect(text).toBe("薪35");
  });

  it("主資源のコストが無い(増築コストなし等)場合は空文字列", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: null, beforeStockFix: null, afterStockFix: null },
      { resourceId: WASTE, beforeStockFix: fixFromInt(20), afterStockFix: fixFromInt(13) },
    );
    expect(text).toBe("");
  });

  it("主資源が拒否等で動いていない(before===after)場合は空文字列", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: fixFromInt(60), afterStockFix: fixFromInt(60) },
      { resourceId: WASTE, beforeStockFix: fixFromInt(20), afterStockFix: fixFromInt(20) },
    );
    expect(text).toBe("");
  });

  it("整数切り捨て後に差が無ければ廃材ぶんの内訳は付けない(端数だけの変動をノイズとして無視)", () => {
    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: fixFromInt(60), afterStockFix: fixFromInt(25) },
      {
        resourceId: WASTE,
        beforeStockFix: fixFromRaw(20_400_000),
        afterStockFix: fixFromRaw(20_100_000),
      },
    );
    expect(text).toBe("薪35");
  });
});

describe("[M70/R5-A04] resourceSpendBreakdownPhrase: 固定小数点のまま差を取る(±1ずれの解消)", () => {
  it("在庫の小数部次第で近似値どうしの減算が丸め誤差を生む組でも、実コストどおりの整数を返す", () => {
    // 在庫 raw: 16,000,002(≈16.000002) → 2,000,002(≈2.000002)。実消費は
    // ちょうど 14,000,000(=14)だが、`16.000002 - 2.000002` を素の number
    // 減算で行うと IEEE754 の丸め誤差で 13.999999999999998 になり、
    // floor すると 13(実コスト 14 より 1 少ない = R5-A04 の再現条件)。
    // Fix のまま(整数)差を取れば厳密に 14,000,000 になり、この誤差は起きない。
    const before = fixFromRaw(16_000_002);
    const after = fixFromRaw(2_000_002);
    // 素の number 減算だと丸め誤差が起きる入力であることの前提確認。
    expect(Math.floor(before / 1_000_000 - after / 1_000_000)).toBe(13);

    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: before, afterStockFix: after },
      { resourceId: null, beforeStockFix: null, afterStockFix: null },
    );
    expect(text).toBe("薪14");
  });

  it("近似値どうしの減算だと 0 に潰れて「消費なし」に見えてしまう組でも、Fix ベースなら消費量が出る", () => {
    // 在庫 raw: 1,000,001(≈1.000001) → 1(≈0.000001)。実消費はちょうど
    // 1,000,000(=1)だが、`1.000001 - 0.000001` を素の number 減算で行うと
    // 0.9999999999999999 になり floor で 0(=「消費した」と言えるほどの変化が
    // 無い、と誤判定されて句が付かなくなっていた)。
    const before = fixFromRaw(1_000_001);
    const after = fixFromRaw(1);
    expect(Math.floor(before / 1_000_000 - after / 1_000_000)).toBe(0);

    const text = resourceSpendBreakdownPhrase(
      { resourceId: FIREWOOD, beforeStockFix: before, afterStockFix: after },
      { resourceId: null, beforeStockFix: null, afterStockFix: null },
    );
    expect(text).toBe("薪1");
  });
});
