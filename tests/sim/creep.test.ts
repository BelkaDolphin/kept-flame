// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 統計クリープ検出(M38)のテスト
//   ADR-015 正準順序 7/10 / GDD 12.4「同カテゴリ同era効率分布のZ-score外れ値監視」
//
// 検収条件: content-guardrail の「7. 統計クリープ検出」ジョブが**実際に検査し、
// 閾値超過で赤くなる**こと。ここでは (a) 現行 content で偽陽性ゼロ
// (b) 外れ値を仕込むと確実に検出される (c) 小標本は pass と偽らず「判定省略」
// になる (d) 未カバーカテゴリが正直に開示されている、の 4 点を固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  analyzeGroup,
  MIN_GROUP_SIZE,
  RELATIVE_DEVIATION_THRESHOLD,
  runCreepDetection,
  Z_THRESHOLD,
} from "../../sim/creep";

describe("統計クリープ検出", () => {
  it("現行 content では外れ値ゼロ(偽陽性が出ない)", () => {
    const report = runCreepDetection();
    expect(report.outlierCount).toBe(0);
    expect(report.groups.length).toBeGreaterThan(0);
    // 実測値(max|z|)と閾値の両方がレポートに載っている(bool ではない)。
    for (const group of report.groups) {
      expect(Number.isFinite(group.maxAbsLeaveOneOutZ)).toBe(true);
      expect(Number.isFinite(group.maxRelativeDeviation)).toBe(true);
    }
    expect(report.zThreshold).toBe(Z_THRESHOLD);
    expect(report.relativeDeviationThreshold).toBe(RELATIVE_DEVIATION_THRESHOLD);
  });

  it("外れ値(1 件だけ極端に効率の良い entity)を仕込むと検出される", () => {
    const samples = [
      { id: "a", value: 10 },
      { id: "b", value: 10 },
      { id: "c", value: 11 },
      { id: "d", value: 10 },
      { id: "e", value: 11 },
      { id: "f", value: 10 },
      { id: "g", value: 11 },
      { id: "h", value: 10 },
      { id: "creeping", value: 40 },
    ];
    const group = analyzeGroup("test", "value", samples);
    expect(group.evaluated).toBe(true);
    expect(group.outliers.map((outlier) => outlier.entityId)).toEqual(["creeping"]);
    const outlier = group.outliers[0];
    // 素の z は masking で 2.66 まで下がり検出できない。leave-one-out なら通る(§1)。
    expect(Math.abs(outlier?.leaveOneOutZ ?? 0)).toBeGreaterThan(Z_THRESHOLD);
    expect(outlier?.relativeDeviation ?? 0).toBeGreaterThan(RELATIVE_DEVIATION_THRESHOLD);
    // masking の実証: 自分を含めた素の z は閾値 3.0 を下回る(だから loo を使う)。
    const naiveZ = (40 - group.mean) / group.stdev;
    expect(naiveZ).toBeLessThan(Z_THRESHOLD);
  });

  it("素直な分布では外れ値にしない(閾値が緩すぎない)", () => {
    const samples = [
      { id: "a", value: 10 },
      { id: "b", value: 12 },
      { id: "c", value: 14 },
      { id: "d", value: 16 },
      { id: "e", value: 18 },
      { id: "f", value: 20 },
    ];
    expect(analyzeGroup("test", "value", samples).outliers).toEqual([]);
  });

  it("標本数が MIN_GROUP_SIZE 未満なら pass と偽らず「判定省略」になる", () => {
    const samples = [
      { id: "a", value: 1 },
      { id: "b", value: 1 },
      { id: "c", value: 100 },
    ];
    const group = analyzeGroup("test", "value", samples);
    expect(samples.length).toBeLessThan(MIN_GROUP_SIZE);
    expect(group.evaluated).toBe(false);
    expect(group.skipReason).not.toBeNull();
    expect(group.outliers).toEqual([]);
  });

  it("未カバーの content カテゴリが理由つきで開示されている", () => {
    const report = runCreepDetection();
    expect(report.uncoveredCategories.length).toBeGreaterThan(0);
    for (const entry of report.uncoveredCategories) {
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
    expect(report.uncoveredCategories.map((entry) => entry.category)).toContain("event");
  });

  it("同一入力で同じ結果(決定論)", () => {
    expect(JSON.stringify(runCreepDetection())).toBe(JSON.stringify(runCreepDetection()));
  });
});
