// ---------------------------------------------------------------------------
// src/ui/screens/grid/GridBoard.tsx のテスト(M18)。
//
// `GridCell` / `resolveTapAction` は hooks を使わない純関数(コンポーネント)
// なので、Preact の render() を経由せず**直接呼び出して**vnode 構造を検証する
// (vitest は `environment: "node"` で DOM が無く、jsdom も devDependencies に
// 無い=ADR-001。実 DOM マウントの計測はこのテストの対象外——詳細は本タスクの
// 最終報告を参照)。
//
// ここで確認すること:
//   1. アンカー/連結/空きの3通りの描画が M17 申し送りどおり(枠・バッジ・数値は
//      アンカーにのみ)
//   2. タップの意味づけ(選択 vs 配置)が「置けるかどうか」を判定せず、
//      空きセルかどうかだけで決まること(architecture.md §6 の7箇条目)
//   3. 48セル分の vnode 構築が実用的な時間で終わり、要素数が概ね
//      「1セルあたり数個 × 48」の桁に収まること(DOM マウント時間そのものの
//      代理指標。実測は§末尾コメント参照)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { cellIdOf, GRID_CELL_COUNT, type Tag } from "../../../src/engine/adjacency";
import { FIX_ONE, FIX_ZERO } from "../../../src/engine/fp";
import type { CellViewModel } from "../../../src/ui/derived";
import {
  GridCell,
  defaultTagGlyph,
  resolveTapAction,
  type PendingPlacement,
} from "../../../src/ui/screens/grid/GridBoard";
import { HEARTH, id } from "../fixtures";

function emptyCellView(cellIndex: number): CellViewModel {
  return {
    cellIndex,
    cellId: cellIdOf(cellIndex),
    occupied: false,
    facilityId: null,
    defId: null,
    anchorCellIndex: null,
    tags: [],
    level: 0,
    workerCount: 0,
    multiplierFix: FIX_ONE,
    multiplierApprox: 1,
    bonusFix: FIX_ZERO,
    overcrowdPenaltyFix: FIX_ZERO,
    overcrowdedNeighborCount: 0,
    overcrowded: false,
  };
}

function occupiedCellView(
  cellIndex: number,
  anchorCellIndex: number,
  overrides: Partial<CellViewModel> = {},
): CellViewModel {
  return {
    ...emptyCellView(cellIndex),
    occupied: true,
    facilityId: id("fTest"),
    defId: HEARTH.id,
    anchorCellIndex,
    tags: ["heat"] as readonly Tag[],
    level: 2,
    workerCount: 3,
    multiplierFix: FIX_ONE,
    multiplierApprox: 1,
    ...overrides,
  };
}

/** vnode ツリーの「要素」ノード数(preact の DOM 要素に対応する vnode のみ数える。文字列子は数えない)。 */
function countElementNodes(node: unknown): number {
  if (node === null || node === undefined || typeof node !== "object") return 0;
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  let count = typeof vnode.type === "string" ? 1 : 0;
  const children = vnode.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) count += countElementNodes(child);
  } else if (children !== undefined) {
    count += countElementNodes(children);
  }
  return count;
}

describe("GridCell(空きセル)", () => {
  it("最小構成(プレースホルダのみ)で枠・バッジ・数値を持たない", () => {
    const vnode = GridCell({ cell: emptyCellView(5), selected: false, tagGlyph: defaultTagGlyph });
    expect(vnode.props.class).toContain("kf-cell--empty");
    expect(countElementNodes(vnode)).toBe(2); // container + placeholder
  });
});

describe("GridCell(アンカーセル・[M17]申し送りの装飾規約)", () => {
  it("アンカーセルには枠・タグ・Lv/就労者バッジ・乗数の数値まで出す", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, tagGlyph: defaultTagGlyph });
    expect(vnode.props.class).toContain("kf-cell--occupied");
    // container + tag + value + badge = 4要素。
    expect(countElementNodes(vnode)).toBe(4);
  });

  it("選択中は kf-cell--selected クラスが付く", () => {
    const cell = occupiedCellView(10, 10);
    const selected = GridCell({ cell, selected: true, tagGlyph: defaultTagGlyph });
    const notSelected = GridCell({ cell, selected: false, tagGlyph: defaultTagGlyph });
    expect(selected.props.class).toContain("kf-cell--selected");
    expect(notSelected.props.class).not.toContain("kf-cell--selected");
  });

  it("過密中は kf-cell--overcrowded クラスが付く", () => {
    const cell = occupiedCellView(10, 10, { overcrowded: true });
    const vnode = GridCell({ cell, selected: false, tagGlyph: defaultTagGlyph });
    expect(vnode.props.class).toContain("kf-cell--overcrowded");
  });
});

describe("GridCell(連結セル・非アンカー)", () => {
  it("枠・バッジ・数値を一切持たない([M17] 1施設1回のみ装飾)", () => {
    // アンカーは 10、自分自身は 11(2×1 施設の2セル目、という想定)。
    const cell = occupiedCellView(11, 10);
    const vnode = GridCell({ cell, selected: false, tagGlyph: defaultTagGlyph });
    expect(vnode.props.class).toContain("kf-cell--connected");
    expect(vnode.props.class).not.toContain("kf-cell--occupied");
    // container のみ(子要素なし)。
    expect(countElementNodes(vnode)).toBe(1);
  });

  it("selected=true を渡しても連結セルは装飾を変えない(枠が無いため意味を持たない)", () => {
    const cell = occupiedCellView(11, 10);
    const vnode = GridCell({ cell, selected: true, tagGlyph: defaultTagGlyph });
    expect(vnode.props.class).not.toContain("kf-cell--selected");
  });
});

describe("resolveTapAction(判定は行わず「空きセルか」だけで振り分ける・architecture.md §6)", () => {
  const cells: readonly CellViewModel[] = Array.from({ length: GRID_CELL_COUNT }, (_, i) =>
    i === 3 ? occupiedCellView(3, 3) : emptyCellView(i),
  );
  const pending: PendingPlacement = { facilityId: id("fNew"), defId: HEARTH.id };

  it("配置待ちが無ければ常に選択", () => {
    expect(resolveTapAction(cells, null, 3)).toEqual({ kind: "select", cellIndex: 3 });
    expect(resolveTapAction(cells, null, 5)).toEqual({ kind: "select", cellIndex: 5 });
  });

  it("配置待ちがあり空きセルなら placeFacility コマンドを組み立てる", () => {
    const action = resolveTapAction(cells, pending, 5);
    expect(action).toEqual({
      kind: "place",
      command: {
        kind: "placeFacility",
        facilityId: pending.facilityId,
        defId: pending.defId,
        cellIndex: 5,
      },
    });
  });

  it("配置待ちがあっても占有セルなら選択にフォールバックする(置けるかの判定はしない)", () => {
    expect(resolveTapAction(cells, pending, 3)).toEqual({ kind: "select", cellIndex: 3 });
  });

  it("範囲外セル番号は none", () => {
    expect(resolveTapAction(cells, null, 999)).toEqual({ kind: "none" });
  });
});

describe("defaultTagGlyph", () => {
  it("タグ無しは空文字", () => {
    expect(defaultTagGlyph([])).toBe("");
  });
  it("複数タグを連結する(本実装=4重符号化はM19の担当)", () => {
    expect(defaultTagGlyph(["heat", "noise"])).toBe("熱騒");
  });
});

describe("[proxy] 48セル分のvnode構築コスト(実DOMマウント時間の代理指標)", () => {
  it("48セル(混在)を組み立てて要素数と所要時間を記録する", () => {
    const cells: CellViewModel[] = [];
    for (let i = 0; i < GRID_CELL_COUNT; i++) {
      if (i % 4 === 0) cells.push(occupiedCellView(i, i));
      else if (i % 4 === 1) cells.push(occupiedCellView(i, i - 1));
      else cells.push(emptyCellView(i));
    }

    const iterations = 200;
    const started = performance.now();
    let totalElements = 0;
    for (let iter = 0; iter < iterations; iter++) {
      totalElements = 0;
      for (const cell of cells) {
        const vnode = GridCell({ cell, selected: false, tagGlyph: defaultTagGlyph });
        totalElements += countElementNodes(vnode);
      }
    }
    const elapsedMs = performance.now() - started;

    // 実測値をテスト出力へ残す(自動テストでの数値捏造防止=CLAUDE.md「幻覚防止」)。
    // これは Node 上の vnode 構築コストであり、`docs/design/perf-boundaries.md`
    // の B4(render() + 強制レイアウト)そのものではない。真の DOM マウント時間は
    // 別途ブラウザでの計測が必要(最終報告の ★ 項目を参照)。
    console.log(
      `[M18 proxy] 48cell × ${String(iterations)}回 vnode構築 = ${elapsedMs.toFixed(3)}ms` +
        `(1回あたり ${(elapsedMs / iterations).toFixed(4)}ms・要素数=${String(totalElements)})`,
    );

    // 48セル中12個がアンカー(4要素)・12個が連結(1要素)・24個が空き(2要素)。
    expect(totalElements).toBe(12 * 4 + 12 * 1 + 24 * 2);
    // 200回反復でも実用時間に収まること(この時点では実 DOM を作っていないので
    // 非常に高速なはず。閾値は「壊れたら気づける」程度の緩いガード)。
    expect(elapsedMs).toBeLessThan(1000);
  });
});
