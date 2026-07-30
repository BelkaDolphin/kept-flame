import { describe, expect, it } from "vitest";

import {
  computeCellAdjacency,
  createAdjacencyMatrix,
  neighborCellIndices,
  type AdjacencyMatrix,
  type AdjacencyPairEntry,
  type AdjacencySubject,
  type CellOccupancy,
  type CellOccupant,
  type Tag,
} from "../../src/engine/adjacency";
import {
  adjacencyBasisCells,
  adjacencyBasisCellsOfFacility,
  occupiedCells,
} from "../../src/engine/footprint";
import { fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  buildCellOccupancy,
  computeMultiplierByFacilityId,
} from "../../src/engine/rules/production";
import { RulesError, type FacilityDef } from "../../src/engine/rules/types";
import type { FacilityFootprint, GameState } from "../../src/engine/state/state";
import {
  FORGE,
  HEARTH,
  SMELTER,
  content,
  facility,
  id,
  largeOccupancyOf,
  matrix,
  occupancyOf,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// [M17] 大型施設(GDD 6.1 の 2×1 / 1×2 / 2×2)の隣接判定のテスト。
//
// 主眼は 5 つ:
//   (1) 判定基準セル集合(GDD 6.3: 全占有セルの外周 8 近傍 − 自セル群)で
//       ボーナス / 過密ペナ / 超過数が決まること(adjacency.ts §3(e))
//   (2) 近傍側の大型施設も **1 施設 1 回**しか数えないこと(同 §3(f))
//   (3) 1×1 では `basisCells` を渡しても渡さなくても**完全に同じ結果**であること
//       = golden 40 本が動かない根拠(既存盤面は全て 1×1)
//   (4) 盤端で回り込みが起きないこと
//   (5) **占有形状の権威は state の footprint** であり content ではないこと
//       (GDD 6.1 [2026-07-30裁定])
//
// 2×1 / 2×2 の基準セル集合は手計算した固定値で先に押さえる(導出関数と
// 期待値が同じ間違いをしないようにするため)。
// ---------------------------------------------------------------------------

const W2H1: FacilityFootprint = { width: 2, height: 1 };
const W1H2: FacilityFootprint = { width: 1, height: 2 };
const W2H2: FacilityFootprint = { width: 2, height: 2 };

/** 2×1 をアンカー 8(x2,y1)へ置いたときの判定基準セル(手計算・昇順)。 */
const BASIS_2X1_AT_8 = [1, 2, 3, 4, 7, 10, 13, 14, 15, 16];
/** 2×2 をアンカー 8 へ置いたときの判定基準セル(手計算・昇順)。 */
const BASIS_2X2_AT_8 = [1, 2, 3, 4, 7, 10, 13, 16, 19, 20, 21, 22];
/** 2×1 を右上端のアンカー 4(x4,y0)へ置いたとき(盤端で削られる・昇順)。 */
const BASIS_2X1_AT_4 = [3, 9, 10, 11];

/** 大型施設を「自分自身も occupancy に載っている」形で subject にする。 */
function largeSubject(
  anchorCellIndex: number,
  footprint: FacilityFootprint,
  tags: readonly Tag[],
  defId = "hearth",
): AdjacencySubject {
  return {
    cellIndex: anchorCellIndex,
    defId,
    tags,
    basisCells: adjacencyBasisCells(occupiedCells(anchorCellIndex, footprint)),
  };
}

/** basisCells を落として「1×1 として扱う」比較対象を作る。 */
function asUnit(subject: AdjacencySubject): AdjacencySubject {
  return { cellIndex: subject.cellIndex, defId: subject.defId, tags: subject.tags };
}

function pair(tagA: Tag, tagB: Tag, raw: number): AdjacencyPairEntry {
  return {
    tagA,
    tagB,
    effect: { effect: "yieldMul", target: { kind: "any" }, valueFix: fixFromRaw(raw) },
  };
}

describe("判定基準セル集合(GDD 6.3)が手計算値と一致する", () => {
  it("2×1 は 10 セル・2×2 は 12 セル(自セル群を除外・昇順)", () => {
    expect(adjacencyBasisCells(occupiedCells(8, W2H1))).toEqual(BASIS_2X1_AT_8);
    expect(adjacencyBasisCells(occupiedCells(8, W2H2))).toEqual(BASIS_2X2_AT_8);
  });

  it("盤端では回り込まずに削られる(2×1 @ 4 は 4 セルだけ)", () => {
    expect(adjacencyBasisCells(occupiedCells(4, W2H1))).toEqual(BASIS_2X1_AT_4);
    // 次の行の先頭(cell 6)は含まれない = 横方向の回り込み無し。
    expect(BASIS_2X1_AT_4).not.toContain(6);
  });

  it("1×1 の基準セル集合は 8 近傍と同じ集合(順序だけ違う)", () => {
    for (let cellIndex = 0; cellIndex < 48; cellIndex++) {
      const basis = adjacencyBasisCells([cellIndex]);
      expect(basis).toEqual([...neighborCellIndices(cellIndex)].sort((l, r) => l - r));
    }
  });
});

describe("大型施設のボーナス / 過密 / 超過数は基準セル集合で決まる(adjacency.ts §3(e))", () => {
  const m = matrix(); // heat|heat +0.2 / threshold 3 / ペナ -0.10 / clamp ±0.6

  /** 2×1 @ 8(heat)+ 1×1 heat を任意セルへ。subject 自身も occupancy に載せる。 */
  function boardWith2x1(neighborCells: readonly number[]): CellOccupancy {
    const entries: (readonly [number, FacilityFootprint, readonly Tag[]])[] = [[8, W2H1, ["heat"]]];
    for (const cell of neighborCells) entries.push([cell, { width: 1, height: 1 }, ["heat"]]);
    return largeOccupancyOf(entries);
  }

  it("アンカーの 8 近傍に無い基準セル(cell 4)の熱源も効く", () => {
    // cell 4 は cell 9(2 番目の占有セル)の近傍であり、cell 8 の近傍ではない。
    expect(neighborCellIndices(8)).not.toContain(4);
    expect(BASIS_2X1_AT_8).toContain(4);

    const occupancy = boardWith2x1([1, 4]);
    const subject = largeSubject(8, W2H1, ["heat"]);

    const large = computeCellAdjacency(m, occupancy, subject);
    expect(toRaw(large.bonusFix)).toBe(400_000); // cell 1 と cell 4 の 2 件
    expect(toRaw(large.multiplierFix)).toBe(1_400_000);

    // 同じ盤面を 1×1 として扱うと cell 1 の 1 件だけになる(= 差が観測できる)。
    const unit = computeCellAdjacency(m, occupancy, asUnit(subject));
    expect(toRaw(unit.bonusFix)).toBe(200_000);
    expect(toRaw(unit.multiplierFix)).toBe(1_200_000);
  });

  it("自分自身の占有セルはタグペアに参加しない(自施設は近傍でない)", () => {
    const occupancy = boardWith2x1([]);
    const subject = largeSubject(8, W2H1, ["heat"]);
    expect(toRaw(computeCellAdjacency(m, occupancy, subject).multiplierFix)).toBe(1_000_000);
    // 1×1 として扱った場合も、cell 9 は「自施設(アンカー 8)」なので数えない。
    expect(toRaw(computeCellAdjacency(m, occupancy, asUnit(subject)).multiplierFix)).toBe(
      1_000_000,
    );
  });

  it("基準セルに同一タグ 4 件で有効 2 件 + 超過 2 件のペナ", () => {
    const occupancy = boardWith2x1([1, 2, 3, 4]);
    const result = computeCellAdjacency(m, occupancy, largeSubject(8, W2H1, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(400_000);
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-200_000);
    expect(result.overcrowdedNeighborCount).toBe(2);
    expect(toRaw(result.multiplierFix)).toBe(1_200_000);
  });

  it("2×2 は下辺の外周(cell 19 / 22)も基準に入る", () => {
    const occupancy = largeOccupancyOf([
      [8, W2H2, ["heat"]],
      [19, { width: 1, height: 1 }, ["heat"]],
      [22, { width: 1, height: 1 }, ["heat"]],
    ]);
    const subject = largeSubject(8, W2H2, ["heat"]);
    expect(toRaw(computeCellAdjacency(m, occupancy, subject).bonusFix)).toBe(400_000);
    // 1×1 扱いでは 19 / 22 はどちらも近傍ではない(占有セル 9/14/15 は自施設)。
    expect(toRaw(computeCellAdjacency(m, occupancy, asUnit(subject)).bonusFix)).toBe(0);
  });

  it("1×2(縦長)も同格に扱える(GDD 6.1 [2026-07-30裁定])", () => {
    // 1×2 @ 8 は cell 8 と cell 14 を占有。cell 20 は 14 の近傍で 8 の近傍ではない。
    expect(occupiedCells(8, W1H2)).toEqual([8, 14]);
    expect(neighborCellIndices(8)).not.toContain(20);
    const occupancy = largeOccupancyOf([
      [8, W1H2, ["heat"]],
      [20, { width: 1, height: 1 }, ["heat"]],
    ]);
    const subject = largeSubject(8, W1H2, ["heat"]);
    expect(toRaw(computeCellAdjacency(m, occupancy, subject).bonusFix)).toBe(200_000);
    expect(toRaw(computeCellAdjacency(m, occupancy, asUnit(subject)).bonusFix)).toBe(0);
  });

  it("盤端の大型施設は回り込まない(2×1 @ 4 に cell 6 の熱源は効かない)", () => {
    const subject = largeSubject(4, W2H1, ["heat"]);
    const wrapAround = largeOccupancyOf([
      [4, W2H1, ["heat"]],
      [6, { width: 1, height: 1 }, ["heat"]],
    ]);
    expect(toRaw(computeCellAdjacency(m, wrapAround, subject).bonusFix)).toBe(0);

    const inBasis = largeOccupancyOf([
      [4, W2H1, ["heat"]],
      [3, { width: 1, height: 1 }, ["heat"]],
    ]);
    expect(toRaw(computeCellAdjacency(m, inBasis, subject).bonusFix)).toBe(200_000);
  });
});

describe("近傍側の大型施設も 1 施設 1 回(adjacency.ts §3(f))", () => {
  const m = matrix();

  it("2 セルで接する 2×1 の近傍はボーナスも過密カウントも 1 件", () => {
    // cell 1 と cell 2 はどちらも cell 8 の 8 近傍。
    expect(neighborCellIndices(8)).toContain(1);
    expect(neighborCellIndices(8)).toContain(2);

    const one2x1 = largeOccupancyOf([
      [8, { width: 1, height: 1 }, ["heat"]],
      [1, W2H1, ["heat"]],
    ]);
    const merged = computeCellAdjacency(m, one2x1, {
      cellIndex: 8,
      defId: "hearth",
      tags: ["heat"],
    });
    expect(toRaw(merged.bonusFix)).toBe(200_000); // 1 施設ぶんだけ
    expect(merged.overcrowdedNeighborCount).toBe(0);

    // 同じ 2 セルを別々の 1×1 が占めていれば 2 件になる(= 重複除去の効果が見える)。
    const two1x1 = occupancyOf([
      [8, ["heat"]],
      [1, ["heat"]],
      [2, ["heat"]],
    ]);
    const separate = computeCellAdjacency(m, two1x1, {
      cellIndex: 8,
      defId: "hearth",
      tags: ["heat"],
    });
    expect(toRaw(separate.bonusFix)).toBe(400_000);
  });

  it("大型施設 2 基が基準セルを分け合っても過密は施設数で数える", () => {
    // 2×1 @ 1(cells 1,2)と 2×1 @ 13(cells 13,14)は cell 8 の近傍を計 4 セル埋める。
    const occupancy = largeOccupancyOf([
      [8, { width: 1, height: 1 }, ["heat"]],
      [1, W2H1, ["heat"]],
      [13, W2H1, ["heat"]],
    ]);
    const result = computeCellAdjacency(m, occupancy, {
      cellIndex: 8,
      defId: "hearth",
      tags: ["heat"],
    });
    // 施設は 2 基 = threshold 3 未満 → 超過なし・ボーナス 2 件。
    expect(result.overcrowdedNeighborCount).toBe(0);
    expect(toRaw(result.bonusFix)).toBe(400_000);
  });
});

describe("複数タグ × 大型施設 × クランプ境界", () => {
  /** heat|heat +0.1 / noise|noise +0.1 / ペナ -0.15 / clamp ±0.6。 */
  const fine: AdjacencyMatrix = createAdjacencyMatrix({
    pairs: [pair("heat", "heat", 100_000), pair("noise", "noise", 100_000)],
    overcrowd: {
      threshold: 3,
      penaltyPerExcessFix: fixFromRaw(-150_000),
      clampFix: fixFromRaw(600_000),
    },
    seedOffset: null,
  });

  it("タグごとに独立集計し、ペナは**タグ横断の合計**を 1 回だけクランプする", () => {
    // 2×1 @ 8(heat+noise)の基準セル 10 個すべてを heat+noise の 1×1 で埋める。
    const entries: (readonly [number, FacilityFootprint, readonly Tag[]])[] = [
      [8, W2H1, ["heat", "noise"]],
    ];
    for (const cell of BASIS_2X1_AT_8) {
      entries.push([cell, { width: 1, height: 1 }, ["heat", "noise"]]);
    }
    const result = computeCellAdjacency(
      fine,
      largeOccupancyOf(entries),
      largeSubject(8, W2H1, ["heat", "noise"], "smelter"),
    );

    // heat / noise それぞれ 10 件 → 有効 2 件・超過 8 件。
    expect(result.overcrowdedNeighborCount).toBe(16);
    // ボーナス = (2 × 0.1) × 2 タグ = +0.4(±60% クランプ未発動)。
    expect(toRaw(result.bonusFix)).toBe(400_000);
    // ペナ生値 = 2 タグ × 8 × -0.15 = -2.40 → clampFP で -0.60。
    // **タグごとにクランプしていたら -1.20 になり乗数は 0.2 になる**ので、
    // この 0.8 が「クランプは 1 施設 1 回」の反証テストになっている。
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-600_000);
    expect(toRaw(result.multiplierFix)).toBe(800_000);
  });

  it("複数タグの大型近傍は各タグに 1 回ずつだけ参加する", () => {
    // 2×1 @ 1(heat+noise)が cell 8 の近傍 2 セルを埋める。
    const occupancy = largeOccupancyOf([
      [8, { width: 1, height: 1 }, ["heat", "noise"]],
      [1, W2H1, ["heat", "noise"]],
    ]);
    const result = computeCellAdjacency(fine, occupancy, {
      cellIndex: 8,
      defId: "smelter",
      tags: ["heat", "noise"],
    });
    // heat 1 件 + noise 1 件 = +0.2(重複除去が無ければ +0.4)。
    expect(toRaw(result.bonusFix)).toBe(200_000);
    expect(result.overcrowdedNeighborCount).toBe(0);
  });
});

describe("順序非依存(決定論)", () => {
  const m = matrix();

  it("basisCells の並びを逆にしても結果は同一", () => {
    const occupancy = largeOccupancyOf([
      [8, W2H1, ["heat"]],
      [1, { width: 1, height: 1 }, ["heat"]],
      [2, { width: 1, height: 1 }, ["heat"]],
      [4, { width: 1, height: 1 }, ["heat"]],
      [16, { width: 1, height: 1 }, ["heat"]],
    ]);
    const ascending = largeSubject(8, W2H1, ["heat"]);
    const reversed: AdjacencySubject = {
      cellIndex: 8,
      defId: "hearth",
      tags: ["heat"],
      basisCells: [...BASIS_2X1_AT_8].reverse(),
    };
    const a = computeCellAdjacency(m, occupancy, ascending);
    const b = computeCellAdjacency(m, occupancy, reversed);
    expect(toRaw(b.bonusFix)).toBe(toRaw(a.bonusFix));
    expect(toRaw(b.overcrowdPenaltyFix)).toBe(toRaw(a.overcrowdPenaltyFix));
    expect(b.overcrowdedNeighborCount).toBe(a.overcrowdedNeighborCount);
    expect(toRaw(a.overcrowdPenaltyFix)).toBe(-200_000); // 実際に過密している盤面
  });

  it("occupancy の挿入順を変えても結果は同一", () => {
    const cells: readonly number[] = [1, 2, 4, 16];
    const forward = new Map<number, CellOccupant>();
    const backward = new Map<number, CellOccupant>();
    const self: CellOccupant = { anchorCellIndex: 8, tags: ["heat"] };
    for (const cell of occupiedCells(8, W2H1)) {
      forward.set(cell, self);
      backward.set(cell, self);
    }
    for (const cell of cells) forward.set(cell, { anchorCellIndex: cell, tags: ["heat"] });
    for (const cell of [...cells].reverse()) {
      backward.set(cell, { anchorCellIndex: cell, tags: ["heat"] });
    }
    const subject = largeSubject(8, W2H1, ["heat"]);
    expect(toRaw(computeCellAdjacency(m, backward, subject).multiplierFix)).toBe(
      toRaw(computeCellAdjacency(m, forward, subject).multiplierFix),
    );
  });
});

describe("1×1 は basisCells の有無で 1 bit も変わらない(golden 40 本不変の根拠)", () => {
  const m = matrix();

  it("48 セル全部で「省略」と「明示」が完全一致する", () => {
    // 過密・複数タグ・盤端が混ざった盤面を 1 つ作り、全セルから見比べる。
    const occupancy = occupancyOf([
      [0, ["heat"]],
      [1, ["heat", "noise"]],
      [2, ["heat"]],
      [6, ["damp"]],
      [7, ["heat"]],
      [8, ["heat", "noise"]],
      [13, ["lore"]],
      [14, ["heat"]],
      [41, ["heat"]],
      [47, ["heat", "damp"]],
    ]);
    const tagged = createAdjacencyMatrix({
      pairs: [
        pair("heat", "heat", 300_000),
        pair("noise", "noise", 100_000),
        pair("damp", "heat", -100_000),
      ],
      overcrowd: {
        threshold: 3,
        penaltyPerExcessFix: fixFromRaw(-100_000),
        clampFix: fixFromRaw(600_000),
      },
      seedOffset: null,
    });

    let compared = 0;
    for (const [cellIndex, occupant] of occupancy) {
      const base: AdjacencySubject = {
        cellIndex,
        defId: "hearth",
        tags: occupant.tags,
      };
      const explicit: AdjacencySubject = {
        cellIndex,
        defId: "hearth",
        tags: occupant.tags,
        basisCells: adjacencyBasisCells([cellIndex]),
      };
      for (const matrixUnderTest of [m, tagged]) {
        const omitted = computeCellAdjacency(matrixUnderTest, occupancy, base);
        const given = computeCellAdjacency(matrixUnderTest, occupancy, explicit);
        expect(toRaw(given.bonusFix)).toBe(toRaw(omitted.bonusFix));
        expect(toRaw(given.overcrowdPenaltyFix)).toBe(toRaw(omitted.overcrowdPenaltyFix));
        expect(toRaw(given.multiplierFix)).toBe(toRaw(omitted.multiplierFix));
        expect(given.overcrowdedNeighborCount).toBe(omitted.overcrowdedNeighborCount);
        compared++;
      }
    }
    expect(compared).toBe(20);
  });
});

describe("state → occupancy / subject の橋渡し(rules/production.ts)", () => {
  const ADJACENCY = matrix();

  it("大型施設は全占有セルに同じ占有者が載る", () => {
    const state = stateOf([facility("fBig", HEARTH.id, 8, [], 1, W2H1)]);
    const occupancy = buildOccupancy(state);
    expect([...occupancy.keys()]).toEqual([8, 9]);
    expect(occupancy.get(8)).toBe(occupancy.get(9)); // 同一参照 = 同一施設
    expect(occupancy.get(9)?.anchorCellIndex).toBe(8);
  });

  it("非アンカーセルの衝突も 1 セル = 1 施設として reject する", () => {
    const state = stateOf([
      facility("fBig", HEARTH.id, 8, [], 1, W2H1),
      facility("fSmall", HEARTH.id, 9),
    ]);
    expect(() => buildOccupancy(state)).toThrow(RulesError);
  });

  it("subject の basisCells は footprint から導出される(乗数は 1 施設 1 エントリ)", () => {
    const state = stateOf([
      facility("fBig", HEARTH.id, 8, [], 1, W2H1),
      facility("fSide", HEARTH.id, 4),
    ]);
    const multipliers = computeMultiplierByFacilityId(state, content(), ADJACENCY);
    // 占有セル数ではなく施設数ぶんのエントリ。
    expect([...multipliers.keys()]).toEqual([id("fBig"), id("fSide")]);
    // cell 4 は cell 9 の近傍なので効く(= basisCells が使われている)。
    expect(toRaw(multipliers.get(id("fBig")) ?? fixFromRaw(0))).toBe(1_200_000);
    expect(adjacencyBasisCellsOfFacility(facility("fBig", HEARTH.id, 8, [], 1, W2H1))).toEqual(
      BASIS_2X1_AT_8,
    );
  });

  it("**content の footprint は権威でない**: state に footprint が無い施設は 1×1", () => {
    // content 上 2×1 の定義(GDD 6.1 の forge 相当)を作る。
    const wideForge: FacilityDef = {
      id: FORGE.id,
      tags: FORGE.tags,
      harshWork: FORGE.harshWork,
      outputPerTickByLevel: FORGE.outputPerTickByLevel,
      output: FORGE.output,
      footprint: W2H1,
    };
    const wideContent = content({
      facilityDefs: new Map([
        [HEARTH.id, HEARTH],
        [wideForge.id, wideForge],
        [SMELTER.id, SMELTER],
      ]),
    });

    // cell 4 は「2×1 として見たときだけ」近傍になるセル。
    const legacyState = stateOf([
      facility("fForge", FORGE.id, 8), // footprint キーなし = 1×1 の正準形
      facility("fSide", HEARTH.id, 4),
    ]);
    const legacy = computeMultiplierByFacilityId(legacyState, wideContent, ADJACENCY);
    expect(toRaw(legacy.get(id("fForge")) ?? fixFromRaw(0))).toBe(1_000_000);

    // 同じ content で、state 側に footprint を焼き込んだ盤面だけが 2×1 になる。
    const bakedState = stateOf([
      facility("fForge", FORGE.id, 8, [], 1, W2H1),
      facility("fSide", HEARTH.id, 4),
    ]);
    const baked = computeMultiplierByFacilityId(bakedState, wideContent, ADJACENCY);
    expect(toRaw(baked.get(id("fForge")) ?? fixFromRaw(0))).toBe(1_200_000);
  });
});

/** 既定 content で占有マップを組む(テストの定型を畳んだだけ)。 */
function buildOccupancy(state: GameState): CellOccupancy {
  return buildCellOccupancy(state, content());
}
