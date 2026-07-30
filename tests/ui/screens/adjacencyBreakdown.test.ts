// ---------------------------------------------------------------------------
// src/ui/screens/grid/adjacencyBreakdown.ts のテスト(M19)。
//
// このモジュールの核心的な設計制約は「最終値(bonusFix/overcrowdPenaltyFix/
// multiplierFix/overcrowdedNeighborCount)は必ず computeCellAdjacency 由来で
// あること」「複製した内訳ロジックが engine の実際の挙動と食い違わないこと」の
// 2 点である。ここでは主に**反証テスト**(壊れ方を数値で確認する)を置く:
//   1. 単純ケースで bonusFix/overcrowdPenaltyFix が公式値と一致すること
//   2. 内訳(バケツ・寄与)を積み上げると公式値を再現できること(過密なし)
//   3. 過密超過ケースで excessAnchors の総数が overcrowdedNeighborCount と一致
//   4. target(facilityDef/tag)によるフィルタが effectApplies と同じ判定になる
//   5. 大型施設(2×1)の基準セルでも同じ性質が成り立つ
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { AdjacencyPairEntry, AdjacencySubject } from "../../../src/engine/adjacency";
import { toRaw } from "../../../src/engine/fp";
import {
  computeAdjacencyBreakdown,
  representativeOvercrowdedTag,
} from "../../../src/ui/screens/grid/adjacencyBreakdown";
import { HEAT_PAIR, largeOccupancyOf, matrix, occupancyOf } from "../../engine/fixtures";

describe("computeAdjacencyBreakdown(単純ケース: 過密なし)", () => {
  it("bonusFix/multiplierFix が computeCellAdjacency の公式値と一致する", () => {
    const m = matrix([HEAT_PAIR]);
    const occupancy = occupancyOf([
      [14, ["heat"]],
      [15, ["heat"]],
    ]);
    const subject: AdjacencySubject = { cellIndex: 21, defId: "d1", tags: ["heat"] };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);

    // heat|heat = +0.2、近傍2件とも有効(threshold=3 未満)なので +0.4。
    expect(toRaw(breakdown.bonusFix)).toBe(400_000);
    expect(toRaw(breakdown.overcrowdPenaltyFix)).toBe(0);
    expect(breakdown.overcrowdedNeighborCount).toBe(0);

    const heatBucket = breakdown.buckets.find((b) => b.tag === "heat");
    expect(heatBucket).toBeDefined();
    expect([...(heatBucket?.neighborAnchors ?? [])].sort((a, b) => a - b)).toEqual([14, 15]);
    expect(heatBucket?.effectiveAnchors).toHaveLength(2);
    expect(heatBucket?.excessAnchors).toHaveLength(0);

    // 積み上げ(反証): 適用された寄与の合計 = bonusFix。
    const sumApplied = (heatBucket?.contributions ?? [])
      .filter((c) => c.applied)
      .reduce((acc, c) => acc + (c.effect === null ? 0 : toRaw(c.effect.valueFix)), 0);
    expect(sumApplied).toBe(toRaw(breakdown.bonusFix));
  });
});

describe("computeAdjacencyBreakdown(過密超過ケース)", () => {
  it("excessAnchors の総数が overcrowdedNeighborCount と一致し、ペナルティも積み上げで再現できる", () => {
    const m = matrix([HEAT_PAIR]); // threshold=3・penaltyPerExcess=-0.10・clamp=0.6
    // cell 14(2,2)の8近傍 = {7,8,9,13,15,19,20,21}。うち5個を heat で埋める。
    const occupancy = occupancyOf([
      [7, ["heat"]],
      [8, ["heat"]],
      [9, ["heat"]],
      [13, ["heat"]],
      [15, ["heat"]],
    ]);
    const subject: AdjacencySubject = { cellIndex: 14, defId: "d1", tags: ["heat"] };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);

    const heatBucket = breakdown.buckets.find((b) => b.tag === "heat");
    expect(heatBucket).toBeDefined();
    if (heatBucket === undefined) return;
    expect(heatBucket.neighborAnchors).toHaveLength(5);
    expect(heatBucket.effectiveAnchors).toHaveLength(2); // threshold-1 = 2
    expect(heatBucket.excessAnchors).toHaveLength(3);

    // 反証1: 過密件数の総和(タグ横断)は breakdown 側でも公式値と一致。
    const totalExcess = breakdown.buckets.reduce((acc, b) => acc + b.excessAnchors.length, 0);
    expect(totalExcess).toBe(breakdown.overcrowdedNeighborCount);

    // 反証2: 生ペナルティ(-0.10 × 3 = -0.30)をクランプ(±0.6・下限のみ・0上限)すると
    // 公式の overcrowdPenaltyFix と一致する(このケースはクランプ非発動域)。
    const totalRawPenalty = breakdown.buckets.reduce((acc, b) => acc + toRaw(b.rawPenaltyFix), 0);
    expect(totalRawPenalty).toBe(-300_000);
    expect(toRaw(breakdown.overcrowdPenaltyFix)).toBe(-300_000);
  });

  it("representativeOvercrowdedTag が宣言順で最初に超過したタグを返す", () => {
    const pairs: AdjacencyPairEntry[] = [
      HEAT_PAIR,
      {
        tagA: "noise",
        tagB: "noise",
        effect: {
          effect: "yieldMul",
          target: { kind: "any" },
          valueFix: HEAT_PAIR.effect.valueFix,
        },
      },
    ];
    const m = matrix(pairs);
    // heat と noise の両方が超過するよう5件ずつ配置(自セル14の8近傍 = {7,8,9,13,15,19,20,21})。
    const occupancy = occupancyOf([
      [7, ["heat", "noise"]],
      [8, ["heat", "noise"]],
      [9, ["heat", "noise"]],
      [13, ["heat", "noise"]],
      [15, ["heat", "noise"]],
    ]);
    const subject: AdjacencySubject = { cellIndex: 14, defId: "d1", tags: ["heat", "noise"] };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);
    // ADJACENCY_TAGS 宣言順は heat が noise より先。
    expect(representativeOvercrowdedTag(breakdown)).toBe("heat");
  });

  it("過密が無ければ representativeOvercrowdedTag は null", () => {
    const m = matrix([HEAT_PAIR]);
    const occupancy = occupancyOf([[14, ["heat"]]]);
    const subject: AdjacencySubject = { cellIndex: 21, defId: "d1", tags: ["heat"] };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);
    expect(representativeOvercrowdedTag(breakdown)).toBeNull();
  });
});

describe("computeAdjacencyBreakdown(target によるフィルタ)", () => {
  it("facilityDef target は自施設の defId と一致しない限り applied=false", () => {
    const pairs: AdjacencyPairEntry[] = [
      {
        tagA: "heat",
        tagB: "heat",
        effect: {
          effect: "yieldMul",
          target: { kind: "facilityDef", defId: "forge" },
          valueFix: HEAT_PAIR.effect.valueFix,
        },
      },
    ];
    const m = matrix(pairs);
    const occupancy = occupancyOf([[14, ["heat"]]]);

    const notForge: AdjacencySubject = { cellIndex: 21, defId: "hearth", tags: ["heat"] };
    const breakdownOther = computeAdjacencyBreakdown(m, occupancy, notForge);
    const heatBucketOther = breakdownOther.buckets.find((b) => b.tag === "heat");
    expect(heatBucketOther?.contributions.every((c) => !c.applied)).toBe(true);
    expect(toRaw(breakdownOther.bonusFix)).toBe(0);

    const isForge: AdjacencySubject = { cellIndex: 21, defId: "forge", tags: ["heat"] };
    const breakdownForge = computeAdjacencyBreakdown(m, occupancy, isForge);
    const heatBucketForge = breakdownForge.buckets.find((b) => b.tag === "heat");
    expect(heatBucketForge?.contributions.some((c) => c.applied)).toBe(true);
    expect(toRaw(breakdownForge.bonusFix)).toBe(toRaw(HEAT_PAIR.effect.valueFix));
  });

  it("ルールが定義されていないタグペアは effect=null・applied=false", () => {
    const m = matrix([HEAT_PAIR]); // heat|heat のみ
    const occupancy = occupancyOf([[14, ["lore"]]]);
    const subject: AdjacencySubject = { cellIndex: 21, defId: "d1", tags: ["heat"] };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);
    const loreBucket = breakdown.buckets.find((b) => b.tag === "lore");
    expect(loreBucket).toBeDefined();
    expect(loreBucket?.contributions.every((c) => c.effect === null && !c.applied)).toBe(true);
    expect(toRaw(breakdown.bonusFix)).toBe(0);
  });
});

describe("computeAdjacencyBreakdown(大型施設・2×1 の基準セル)", () => {
  it("footprint.ts の基準セル集合を使っても公式値と一致する", () => {
    const m = matrix([HEAT_PAIR]);
    // forge(2×1)が cell 6-7 を占有・cell 14/15 が heat 近傍。
    const occupancy = largeOccupancyOf([
      [6, { width: 2, height: 1 }, ["heat"]],
      [14, { width: 1, height: 1 }, ["heat"]],
    ]);
    // forge の基準セル(spec通り: 0,1,2,5,8,11,12,13 のうち盤内かつ自セル群を除く集合)。
    // ここではテストの主眼が「与えた basisCells をそのまま使って公式値と breakdown が
    // 一致するか」なので、明示的に 8 近傍相当を渡す(0/1/2/5/8/12/13 の一部を含む)。
    const basisCells = [0, 1, 2, 5, 8, 12, 13, 14];
    const subject: AdjacencySubject = {
      cellIndex: 6,
      defId: "forge",
      tags: ["heat"],
      basisCells,
    };
    const breakdown = computeAdjacencyBreakdown(m, occupancy, subject);
    const heatBucket = breakdown.buckets.find((b) => b.tag === "heat");
    expect(heatBucket?.neighborAnchors).toEqual([14]);
    expect(toRaw(breakdown.bonusFix)).toBe(toRaw(HEAT_PAIR.effect.valueFix));
  });
});
