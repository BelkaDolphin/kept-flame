// ---------------------------------------------------------------------------
// src/ui/screens/cellCoordinate.ts のテスト(M61/FC5)。
//
// 確認すること: (1) cellId文字列("c00"等)・cellIndex数値のどちらからも同じ
// 座標が出る (2) col=x+1・row=y+1(cellIndex = row*GRID_WIDTH + col の逆変換)
// (3) 規則に合わない/範囲外の入力は raw をそのまま返す(捏造しない)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { GRID_CELL_COUNT, GRID_WIDTH } from "../../../src/engine/adjacency";
import { cellCoordinateLabel } from "../../../src/ui/screens/cellCoordinate";

describe("cellCoordinateLabel(内部セルIDの人間可読座標化・R1-A17)", () => {
  it("c00 は 1列1行(原点)", () => {
    expect(cellCoordinateLabel("c00")).toBe("1列1行");
    expect(cellCoordinateLabel(0)).toBe("1列1行");
  });

  it("GRID_WIDTH-1 列目(行内最後)は折り返さず同じ行", () => {
    const lastColIndex = GRID_WIDTH - 1;
    expect(cellCoordinateLabel(lastColIndex)).toBe(`${String(GRID_WIDTH)}列1行`);
  });

  it("1行下(cellIndex = GRID_WIDTH)は1列2行", () => {
    expect(cellCoordinateLabel(GRID_WIDTH)).toBe("1列2行");
  });

  it("最終セル(GRID_CELL_COUNT-1)まで例外にならない", () => {
    expect(() => cellCoordinateLabel(GRID_CELL_COUNT - 1)).not.toThrow();
  });

  it("cellId文字列とcellIndex数値で同じ結果になる(c12の例)", () => {
    expect(cellCoordinateLabel("c12")).toBe(cellCoordinateLabel(12));
  });

  it("規則に合わないIDは捏造せずrawのまま返す", () => {
    expect(cellCoordinateLabel("facHearth1")).toBe("facHearth1");
    expect(cellCoordinateLabel("c99")).toBe("c99"); // 範囲外(0〜47)
  });
});
