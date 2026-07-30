// ---------------------------------------------------------------------------
// src/ui/screens/grid/GridBoard.tsx のテスト(M18/M19)。
//
// [M19] `tagGlyph`(文字列を返すだけの仮実装・M18)は本タスクで4重符号化の
// 本実装(TagSymbol による SVG 記号 + パターン + LOD 劣化)へ置き換わったため、
// このファイルの DOM 要素数アサーションは**全面的に更新した**(既存テスト改変。
// M18 のコメントが「本実装(4重符号化)はM19の担当」と明記していた箇所であり、
// 差し替えは織り込み済み・最終報告に理由を記載)。
//
// `GridCell` は引き続き hooks を使わない純関数(コンポーネント)であり、
// Preact の render() を経由せず直接呼び出して vnode 構造を検証する
// (vitest は `environment: "node"` で DOM が無く jsdom も devDependencies に
// 無い=ADR-001)。
//
// ここで確認すること:
//   1. アンカー/連結/空きの3通りの描画が M17 申し送りどおり(枠・バッジ・数値は
//      アンカーにのみ)
//   2. [M19] タグマーカーが LOD(zoom)に応じて記号バリアント/チャネル数を
//      切り替えること(spec §7.2 の劣化順序どおり)
//   3. [M19] 常時過密警告バッジ・配置プレビュー(色+記号+数値)が出ること
//   4. タップの意味づけ(選択 vs 配置)が「置けるかどうか」を判定せず、
//      空きセルかどうかだけで決まること(architecture.md §6 の7箇条目)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { cellIdOf, GRID_CELL_COUNT, type Tag } from "../../../src/engine/adjacency";
import { FIX_ONE, FIX_ZERO, fixFromRaw } from "../../../src/engine/fp";
import type { CellViewModel } from "../../../src/ui/derived";
import {
  GridCell,
  buildPreviewView,
  resolveTapAction,
  type CellPreviewView,
  type PendingPlacement,
} from "../../../src/ui/screens/grid/GridBoard";
import { HEARTH, id } from "../fixtures";

// --- ズーム値の代表点(spec §7.2 の5段全部を踏める値。CELL_SIZE_PX=56 前提の
//     computeRawMarkerPx(zoom) = round(0.273*56*zoom) から逆算した) ----------
const ZOOM_L1 = 1.6; // raw 24 -> L1(24-26・4チャネル)
const ZOOM_L2 = 1.4; // raw 21 -> L2(20-23・3チャネル)
const ZOOM_L3 = 1.0; // raw 15 -> L3(15-19・2チャネル)
const ZOOM_L4 = 0.7; // raw 11 -> L4(9-14・mini・2チャネル)
const ZOOM_L5 = 0.3; // raw 5  -> L5(<9・記号撤去・1チャネル)

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
    ...overrides,
  };
}

/**
 * vnode ツリーの「要素」ノード数(preact の DOM 要素に対応する vnode のみ数える。
 * 文字列/真偽値の子は数えない)。
 *
 * [M19] 2点の注意:
 *   1. `{tags.map(...)}{overflowCount > 0 && (...)}` のような JSX は
 *      `children = [mappedArray, exprOrFalse]` という**配列を含む配列**を作る。
 *      配列はどの深さに現れても先に展開する(そうしないと `.map()` 由来の
 *      子が丸ごと数え漏れる)。
 *   2. `<TagSymbol>` 等の関数コンポーネントは h() 時点では type が関数参照の
 *      ままで、その props.children は「実際にレンダーされた中身」ではない。
 *      hooks を使わない純関数コンポーネントである前提で、ここで直接呼び出して
 *      展開してから数える(GridCell 自身を直接呼ぶのと同じ方針の延長)。
 */
function countElementNodes(node: unknown): number {
  if (Array.isArray(node)) {
    let count = 0;
    for (const child of node) count += countElementNodes(child);
    return count;
  }
  if (node === null || node === undefined || typeof node !== "object") return 0;
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return countElementNodes((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  const own = typeof vnode.type === "string" ? 1 : 0;
  return own + countElementNodes(vnode.props?.children);
}

describe("GridCell(空きセル)", () => {
  it("プレビュー無しなら枠・バッジ・数値を持たない(プレースホルダのみ)", () => {
    const vnode = GridCell({ cell: emptyCellView(5), selected: false, zoom: ZOOM_L3 });
    expect(vnode.props.class).toContain("kf-cell--empty");
    expect(countElementNodes(vnode)).toBe(2); // container + placeholder
  });
});

describe("GridCell(アンカーセル・4重符号化とLOD・[M17]申し送りの装飾規約)", () => {
  it("L1(zoom大)は記号+パターン(symbol full)+数値まで全部出す(4チャネル)", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L1 });
    expect(vnode.props.class).toContain("kf-cell--occupied");
    expect(vnode.props["data-lod"]).toBe("L1");
    // container + markers-span + marker-span + svg + use + value + badge = 7。
    expect(countElementNodes(vnode)).toBe(7);
  });

  it("L2は数値チャネルが落ちる(spec §7.2)がパターンは残る(3チャネル)", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L2 });
    expect(vnode.props["data-lod"]).toBe("L2");
    // container + markers-span + marker-span + svg + use + badge = 6(数値無し)。
    expect(countElementNodes(vnode)).toBe(6);
  });

  it("L3(既定ズーム相当)は数値チャネルが落ちる(spec §7.2: L2でnumeral消失)", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    expect(vnode.props["data-lod"]).toBe("L3");
    // container + markers-span + marker-span + svg + use + badge = 6(数値無し)。
    expect(countElementNodes(vnode)).toBe(6);
  });

  it("L4はmini記号(要素数はL3と同じ・svg+useの中身だけ変わる)", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L4 });
    expect(vnode.props["data-lod"]).toBe("L4");
    expect(countElementNodes(vnode)).toBe(6);
  });

  it("L5は記号を撤去し集約ドットへ切り替える(spec §7.4)", () => {
    const cell = occupiedCellView(10, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L5 });
    expect(vnode.props["data-lod"]).toBe("L5");
    // container + markers-span + marker-span + dot-span + badge = 5(svg/use無し)。
    expect(countElementNodes(vnode)).toBe(5);
  });

  it("複数タグ(2個)は2個ぶんの記号が並ぶ", () => {
    const cell = occupiedCellView(10, 10, { tags: ["heat", "noise"] });
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    // container + markers-span + (marker-span+svg+use)*2 + badge = 9。
    expect(countElementNodes(vnode)).toBe(9);
  });

  it("3タグ以上は先頭2個 + `+n` バッジ(spec §6.4)", () => {
    const cell = occupiedCellView(10, 10, { tags: ["heat", "noise", "lore"] });
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    // container + markers-span + (marker-span+svg+use)*2 + overflow-span + badge = 10。
    expect(countElementNodes(vnode)).toBe(10);
  });

  it("選択中は kf-cell--selected クラスが付く", () => {
    const cell = occupiedCellView(10, 10);
    const selected = GridCell({ cell, selected: true, zoom: ZOOM_L3 });
    const notSelected = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    expect(selected.props.class).toContain("kf-cell--selected");
    expect(notSelected.props.class).not.toContain("kf-cell--selected");
  });

  it("過密中は kf-cell--overcrowded クラス + 常時過密警告バッジが付く", () => {
    const cell = occupiedCellView(10, 10, { overcrowded: true, overcrowdedNeighborCount: 2 });
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    expect(vnode.props.class).toContain("kf-cell--overcrowded");
    // L3(6要素)+ 過密バッジ1個 = 7。
    expect(countElementNodes(vnode)).toBe(7);
  });

  it("過密バッジは非スケーリング(NON_SCALING_MIN_PX.overcrowdBadge=12px)を指定する", () => {
    const cell = occupiedCellView(10, 10, { overcrowded: true, overcrowdedNeighborCount: 1 });
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L1 });
    const badge = findChildByClass(vnode, "kf-cell__overcrowd-badge");
    expect(badge).toBeDefined();
    expect(badge?.props?.style).toContain("12px");
  });
});

/** 子要素の中から class 名で1個探す(countElementNodes と同じ緩い型・配列展開で走査)。 */
function findChildByClass(
  node: unknown,
  className: string,
): { readonly props?: { readonly class?: string; readonly style?: string } } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findChildByClass(child, className);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown; readonly class?: string };
  };
  if (typeof vnode.type === "function") {
    return findChildByClass((vnode.type as (props: unknown) => unknown)(vnode.props), className);
  }
  if (vnode.props?.class === className) {
    return vnode as { readonly props: { readonly class: string; readonly style?: string } };
  }
  return findChildByClass(vnode.props?.children, className);
}

describe("GridCell(連結セル・非アンカー)", () => {
  it("枠・バッジ・数値を一切持たない([M17] 1施設1回のみ装飾)", () => {
    // アンカーは 10、自分自身は 11(2×1 施設の2セル目、という想定)。
    const cell = occupiedCellView(11, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    expect(vnode.props.class).toContain("kf-cell--connected");
    expect(vnode.props.class).not.toContain("kf-cell--occupied");
    // container のみ(子要素なし)。
    expect(countElementNodes(vnode)).toBe(1);
  });

  it("タグ色(tint)を背景に塗る(M17申し送り: タグ色の塗りのみ)", () => {
    const cell = occupiedCellView(11, 10);
    const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
    expect(vnode.props.style).toContain("#FAEDEA"); // heat の tint。
  });

  it("selected=true を渡しても連結セルは装飾を変えない(枠が無いため意味を持たない)", () => {
    const cell = occupiedCellView(11, 10);
    const vnode = GridCell({ cell, selected: true, zoom: ZOOM_L3 });
    expect(vnode.props.class).not.toContain("kf-cell--selected");
  });
});

describe("[M19] 配置プレビュー(GDD 6.5 MVP必須)", () => {
  it("buildPreviewView: fits=false なら null(プレビューを出さない)", () => {
    expect(
      buildPreviewView({
        cellIndex: 0,
        fits: false,
        multiplierApprox: 1,
        bonusFix: FIX_ZERO,
        overcrowdPenaltyFix: FIX_ZERO,
        overcrowdedNeighborCount: 0,
      }),
    ).toBeNull();
  });

  it("buildPreviewView: ネットがプラスなら add・マイナスなら sub", () => {
    const addView = buildPreviewView({
      cellIndex: 0,
      fits: true,
      multiplierApprox: 1.2,
      bonusFix: fixFromRaw(200_000),
      overcrowdPenaltyFix: FIX_ZERO,
      overcrowdedNeighborCount: 0,
    });
    expect(addView?.kind).toBe("add");
    expect(addView?.percentLabel).toBe("+20");

    const subView = buildPreviewView({
      cellIndex: 0,
      fits: true,
      multiplierApprox: 0.9,
      bonusFix: FIX_ZERO,
      overcrowdPenaltyFix: fixFromRaw(-100_000),
      overcrowdedNeighborCount: 1,
    });
    expect(subView?.kind).toBe("sub");
    expect(subView?.percentLabel).toBe("-10");
  });

  it("GridCell: 空きセル + preview(add)は色+記号(+)+数値を出す(3要素)", () => {
    const preview: CellPreviewView = { kind: "add", percentLabel: "+20" };
    const vnode = GridCell({ cell: emptyCellView(5), selected: false, zoom: ZOOM_L3, preview });
    expect(vnode.props.class).toContain("kf-cell--preview-add");
    expect(vnode.props.style).toContain("#EDF3EA"); // previewAdd の面色。
    // container + symbol-span("+") + value-span("+20") = 3。
    expect(countElementNodes(vnode)).toBe(3);
  });

  it("GridCell: 空きセル + preview(sub)は previewSub 面色になる", () => {
    const preview: CellPreviewView = { kind: "sub", percentLabel: "-10" };
    const vnode = GridCell({ cell: emptyCellView(5), selected: false, zoom: ZOOM_L3, preview });
    expect(vnode.props.class).toContain("kf-cell--preview-sub");
    expect(vnode.props.style).toContain("#F7ECEB"); // previewSub の面色。
  });

  it("preview が null なら通常の空きセル描画のまま", () => {
    const vnode = GridCell({
      cell: emptyCellView(5),
      selected: false,
      zoom: ZOOM_L3,
      preview: null,
    });
    expect(countElementNodes(vnode)).toBe(2);
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
        const vnode = GridCell({ cell, selected: false, zoom: ZOOM_L3 });
        totalElements += countElementNodes(vnode);
      }
    }
    const elapsedMs = performance.now() - started;

    // 実測値をテスト出力へ残す(自動テストでの数値捏造防止=CLAUDE.md「幻覚防止」)。
    // これは Node 上の vnode 構築コストであり、`docs/design/perf-boundaries.md`
    // の B4(render() + 強制レイアウト)そのものではない。真の DOM マウント時間は
    // `bench/gridMount.html`(M19 追加)が実ブラウザで計測する(最終報告参照)。
    console.log(
      `[M19 proxy] 48cell × ${String(iterations)}回 vnode構築 = ${elapsedMs.toFixed(3)}ms` +
        `(1回あたり ${(elapsedMs / iterations).toFixed(4)}ms・要素数=${String(totalElements)})`,
    );

    // 48セル中12個がアンカー(L3・単一タグ・6要素)・12個が連結(1要素)・24個が空き(2要素)。
    expect(totalElements).toBe(12 * 6 + 12 * 1 + 24 * 2);
    // 200回反復でも実用時間に収まること(この時点では実 DOM を作っていないので
    // 非常に高速なはず。閾値は「壊れたら気づける」程度の緩いガード)。
    expect(elapsedMs).toBeLessThan(1000);
  });
});
