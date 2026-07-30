// ---------------------------------------------------------------------------
// M16: `src/engine/footprint.ts`(施設 footprint の幾何)のテスト。
//
// 固定するのは 4 点:
//   (1) 占有セル集合の導出が **昇順・アンカー = 最小** であること(footprint.ts §1)
//   (2) 盤外へはみ出す組み合わせが**切り詰められず**例外になること
//       (静かな縮退の禁止。「2×2 のつもりが右端で 2×1」を作らない)
//   (3) GDD 6.3 の判定基準セル(全占有セルの 8 近傍の和集合 − 自セル群)が
//       **入力の並び順に依存しない**こと(決定論)
//   (4) 盤面の占有照会が大型施設の**非アンカーセルにもヒット**すること
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  GRID_CELL_COUNT,
  GRID_HEIGHT,
  GRID_WIDTH,
  neighborCellIndices,
} from "../../src/engine/adjacency";
import {
  FOOTPRINT_DIM_MAX,
  FootprintError,
  UNIT_FOOTPRINT,
  adjacencyBasisCells,
  adjacencyBasisCellsOfFacility,
  anchorCellOfOccupied,
  facilityOccupyingCell,
  findOccupancyConflict,
  footprintFitsGrid,
  footprintOfFacility,
  isUnitFootprint,
  isValidFootprintDims,
  occupiedCells,
  occupiedCellsOfFacility,
} from "../../src/engine/footprint";
import type { FacilityFootprint } from "../../src/engine/state/state";

import { HEARTH, facility, id, stateOf } from "./fixtures";

const FP_1X1: FacilityFootprint = { width: 1, height: 1 };
const FP_2X1: FacilityFootprint = { width: 2, height: 1 };
const FP_1X2: FacilityFootprint = { width: 1, height: 2 };
const FP_2X2: FacilityFootprint = { width: 2, height: 2 };

/** 格子の形が前提と合っているか(6×8 = 48)。ここが変わると期待値の手計算が崩れる。 */
describe("前提", () => {
  it("格子は 6×8 = 48 セル(GDD 6.1)", () => {
    expect(GRID_WIDTH).toBe(6);
    expect(GRID_HEIGHT).toBe(8);
    expect(GRID_CELL_COUNT).toBe(48);
  });

  it("footprint の 1 辺の上限は 2(GDD 6.1 の 2×1 / 2×2)", () => {
    expect(FOOTPRINT_DIM_MAX).toBe(2);
  });
});

// --- 1. 値域 ---------------------------------------------------------------

describe("isValidFootprintDims / isUnitFootprint", () => {
  it("1〜2 の整数だけが有効", () => {
    for (const footprint of [FP_1X1, FP_2X1, FP_1X2, FP_2X2]) {
      expect(isValidFootprintDims(footprint)).toBe(true);
    }
    for (const footprint of [
      { width: 0, height: 1 },
      { width: 1, height: 0 },
      { width: 3, height: 1 },
      { width: 1, height: 3 },
      { width: 1.5, height: 1 },
      { width: Number.NaN, height: 1 },
      { width: -1, height: -1 },
    ]) {
      expect(isValidFootprintDims(footprint)).toBe(false);
    }
  });

  it("1×1 だけが「省略と同義」", () => {
    expect(isUnitFootprint(UNIT_FOOTPRINT)).toBe(true);
    expect(isUnitFootprint(FP_1X1)).toBe(true);
    expect(isUnitFootprint(FP_2X1)).toBe(false);
    expect(isUnitFootprint(FP_1X2)).toBe(false);
    expect(isUnitFootprint(FP_2X2)).toBe(false);
  });

  it("省略された footprint は 1×1 として解決される(既定値)", () => {
    expect(footprintOfFacility(facility("fA", HEARTH.id, 0))).toEqual(FP_1X1);
    expect(footprintOfFacility(facility("fB", HEARTH.id, 0, [], 1, FP_2X2))).toEqual(FP_2X2);
  });
});

// --- 2. 占有セル集合 -------------------------------------------------------

describe("occupiedCells", () => {
  it("1×1 は基準セルだけ", () => {
    expect(occupiedCells(0, FP_1X1)).toEqual([0]);
    expect(occupiedCells(47, FP_1X1)).toEqual([47]);
  });

  it("2×1 は右隣、1×2 は下隣を占有する(cellIndex = y*6 + x)", () => {
    expect(occupiedCells(0, FP_2X1)).toEqual([0, 1]);
    expect(occupiedCells(0, FP_1X2)).toEqual([0, 6]);
    expect(occupiedCells(7, FP_2X1)).toEqual([7, 8]);
    expect(occupiedCells(7, FP_1X2)).toEqual([7, 13]);
  });

  it("2×2 は 4 セルを昇順で返す", () => {
    expect(occupiedCells(0, FP_2X2)).toEqual([0, 1, 6, 7]);
    expect(occupiedCells(7, FP_2X2)).toEqual([7, 8, 13, 14]);
    // 右下角へちょうど収まる位置(x=4, y=6)。
    expect(occupiedCells(40, FP_2X2)).toEqual([40, 41, 46, 47]);
  });

  it("常に昇順で、先頭がアンカー(= 最小セル番号)", () => {
    for (const footprint of [FP_1X1, FP_2X1, FP_1X2, FP_2X2]) {
      for (let cell = 0; cell < GRID_CELL_COUNT; cell++) {
        if (!footprintFitsGrid(cell, footprint)) continue;
        const cells = occupiedCells(cell, footprint);
        expect(cells.length).toBe(footprint.width * footprint.height);
        expect([...cells].sort((l, r) => l - r)).toEqual([...cells]);
        expect(cells[0]).toBe(cell);
        expect(anchorCellOfOccupied(cells)).toBe(cell);
      }
    }
  });

  it("横方向の回り込みは起きない(右端の 2×1 は次行へ回らず「入らない」)", () => {
    // x = 5(右端)の列。2×1 / 2×2 はどれも収まらない。
    for (let y = 0; y < GRID_HEIGHT; y++) {
      const cell = y * GRID_WIDTH + 5;
      expect(footprintFitsGrid(cell, FP_2X1)).toBe(false);
      expect(footprintFitsGrid(cell, FP_2X2)).toBe(false);
      expect(footprintFitsGrid(cell, FP_1X1)).toBe(true);
    }
    expect(() => occupiedCells(5, FP_2X1)).toThrow(FootprintError);
  });

  it("下端の 1×2 / 2×2 は入らない", () => {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const cell = 7 * GRID_WIDTH + x; // 最下行
      expect(footprintFitsGrid(cell, FP_1X2)).toBe(false);
      expect(footprintFitsGrid(cell, FP_2X2)).toBe(false);
    }
    expect(() => occupiedCells(42, FP_1X2)).toThrow(FootprintError);
    expect(() => occupiedCells(47, FP_2X2)).toThrow(FootprintError);
  });

  it("盤外の基準セル・値域外の footprint は例外(黙って切り詰めない)", () => {
    expect(() => occupiedCells(48, FP_1X1)).toThrow(FootprintError);
    expect(() => occupiedCells(-1, FP_1X1)).toThrow(FootprintError);
    expect(() => occupiedCells(0, { width: 3, height: 1 })).toThrow(FootprintError);
    expect(footprintFitsGrid(48, FP_1X1)).toBe(false);
    expect(footprintFitsGrid(1.5, FP_1X1)).toBe(false);
  });

  it("空の占有セル集合からアンカーは導出できない", () => {
    expect(() => anchorCellOfOccupied([])).toThrow(FootprintError);
  });
});

describe("occupiedCellsOfFacility", () => {
  it("footprint 省略の施設は基準セル 1 個(M16 以前と同一)", () => {
    expect(occupiedCellsOfFacility(facility("fA", HEARTH.id, 13))).toEqual([13]);
  });

  it("明示された 1×1 も基準セル 1 個(省略と同義)", () => {
    expect(occupiedCellsOfFacility(facility("fA", HEARTH.id, 13, [], 1, FP_1X1))).toEqual([13]);
  });

  it("大型施設は矩形の全セル", () => {
    expect(occupiedCellsOfFacility(facility("fA", HEARTH.id, 7, [], 1, FP_2X2))).toEqual([
      7, 8, 13, 14,
    ]);
  });

  it("値域外の cellIndex を持つ 1×1 は M16 以前と同じく黙って通す(層分けの維持)", () => {
    // cellIndex 単独の値域検査は schema 検証器の担当(serialize.ts §2)であり、
    // footprint を足したことで既存の壊れた state の壊れ方を変えない。
    expect(occupiedCellsOfFacility(facility("fA", HEARTH.id, 999))).toEqual([999]);
  });
});

// --- 3. GDD 6.3 の判定基準セル ---------------------------------------------

describe("adjacencyBasisCells", () => {
  it("1×1 では 8 近傍と同じ集合(順序は昇順)", () => {
    for (let cell = 0; cell < GRID_CELL_COUNT; cell++) {
      const basis = adjacencyBasisCells([cell]);
      const neighbors = [...neighborCellIndices(cell)].sort((l, r) => l - r);
      expect(basis).toEqual(neighbors);
    }
  });

  it("2×2 の外周(自セル群を除外・重複除去)を昇順で返す", () => {
    // 左上角の 2×2([0,1,6,7])の外周は (2,0) (2,1) (0,2) (1,2) (2,2) の 5 セル。
    expect(adjacencyBasisCells([0, 1, 6, 7])).toEqual([2, 8, 12, 13, 14]);
  });

  it("内側に置いた 2×1 の外周は 10 セル(矩形の周長)", () => {
    expect(adjacencyBasisCells([7, 8])).toEqual([0, 1, 2, 3, 6, 9, 12, 13, 14, 15]);
  });

  it("自セル群は必ず除外される(GDD 6.3)", () => {
    const occupied = occupiedCells(14, FP_2X2);
    const basis = adjacencyBasisCells(occupied);
    for (const own of occupied) {
      expect(basis).not.toContain(own);
    }
  });

  it("入力の並び順に依存しない(決定論)", () => {
    const occupied = occupiedCells(19, FP_2X2);
    const expected = adjacencyBasisCells(occupied);
    // 並べ替え・重複を混ぜても同じ集合が返る(真偽配列で集合化しているため)。
    const permutations: readonly (readonly number[])[] = [
      [...occupied].reverse(),
      [occupied[1] ?? 0, occupied[3] ?? 0, occupied[0] ?? 0, occupied[2] ?? 0],
      [...occupied, ...occupied],
    ];
    for (const permuted of permutations) {
      expect(adjacencyBasisCells(permuted)).toEqual(expected);
    }
  });

  it("重複を含まず昇順(= cellId 辞書順)である", () => {
    for (const anchor of [0, 5, 7, 40, 42, 47]) {
      for (const footprint of [FP_1X1, FP_2X1, FP_1X2, FP_2X2]) {
        if (!footprintFitsGrid(anchor, footprint)) continue;
        const basis = adjacencyBasisCells(occupiedCells(anchor, footprint));
        expect(new Set(basis).size).toBe(basis.length);
        expect([...basis].sort((l, r) => l - r)).toEqual([...basis]);
      }
    }
  });

  it("空集合・盤外セルは例外", () => {
    expect(() => adjacencyBasisCells([])).toThrow(FootprintError);
    expect(() => adjacencyBasisCells([48])).toThrow(FootprintError);
    expect(() => adjacencyBasisCells([0, -1])).toThrow(FootprintError);
  });

  it("施設からの導出は占有セル集合経由と一致する", () => {
    const large = facility("fA", HEARTH.id, 7, [], 1, FP_2X2);
    expect(adjacencyBasisCellsOfFacility(large)).toEqual(
      adjacencyBasisCells(occupiedCellsOfFacility(large)),
    );
    const unit = facility("fB", HEARTH.id, 7);
    expect(adjacencyBasisCellsOfFacility(unit)).toEqual(adjacencyBasisCells([7]));
  });
});

// --- 4. 盤面の占有 ---------------------------------------------------------

describe("facilityOccupyingCell / findOccupancyConflict", () => {
  const state = stateOf([
    facility("fLarge", HEARTH.id, 7, [], 1, FP_2X2), // 7, 8, 13, 14
    facility("fSmall", HEARTH.id, 20),
  ]);

  it("大型施設は非アンカーセルでもヒットする(M16 の要点)", () => {
    for (const cell of [7, 8, 13, 14]) {
      expect(facilityOccupyingCell(state, cell)?.id).toBe(id("fLarge"));
    }
  });

  it("1×1 は基準セルだけヒットする", () => {
    expect(facilityOccupyingCell(state, 20)?.id).toBe(id("fSmall"));
    expect(facilityOccupyingCell(state, 21)).toBeUndefined();
  });

  it("空きセルは undefined", () => {
    for (const cell of [0, 1, 6, 9, 12, 15, 47]) {
      expect(facilityOccupyingCell(state, cell)).toBeUndefined();
    }
  });

  it("衝突は「セル番号が最小のもの」を返す", () => {
    // 2×2 を cell 1 に置こうとすると [1,2,7,8] を占有 → 7 と 8 で fLarge と衝突。
    const conflict = findOccupancyConflict(state, occupiedCells(1, FP_2X2));
    expect(conflict?.cellIndex).toBe(7);
    expect(conflict?.facility.id).toBe(id("fLarge"));
  });

  it("衝突が無ければ null", () => {
    expect(findOccupancyConflict(state, occupiedCells(30, FP_2X2))).toBeNull();
  });

  it("自分自身は除外できる(置き直しのための口)", () => {
    expect(findOccupancyConflict(state, [7, 8], id("fLarge"))).toBeNull();
    expect(findOccupancyConflict(state, [7, 8, 20], id("fLarge"))?.facility.id).toBe(id("fSmall"));
  });
});
