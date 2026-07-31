// ---------------------------------------------------------------------------
// src/ui/screens/grid/GridScreen.tsx のテスト(M30)。
//
// `FacilityCatalogButton`/`FacilityCatalogPanel`/`ReclaimPanel` は hooks を
// 使わない純関数コンポーネントなので、Preact の render() を通さず直接呼んで
// vnode 構造を検証する(gridBoard.test.ts / homeHub.test.ts と同じ方針・
// vitest は `environment: "node"` で jsdom 無し)。`RejectionBanner` は
// ②③④共通の別ファイル(src/ui/screens/RejectionBanner.tsx)へ切り出したので
// tests/ui/screens/rejectionBanner.test.ts を参照。
//
// `GridScreen` 本体(hooks あり)は登録テスト(registry 経由の型検査)のみで
// 済ませる——実際のマウント確認は `npm run build` + ブラウザ実機の担当
// (docs/design/architecture.md §6-3 / appShell.test.ts と同じ切り分け)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { FIX_ZERO, fixFromInt } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import type { CellViewModel, FacilityCatalogEntry, ReclaimInfo } from "../../../src/ui/derived";
import {
  FacilityCatalogButton,
  FacilityCatalogPanel,
  ReclaimPanel,
} from "../../../src/ui/screens/grid/GridScreen";

const id = entityIdFromString;

function catalogEntry(overrides: Partial<FacilityCatalogEntry> = {}): FacilityCatalogEntry {
  return {
    defId: id("hearth"),
    tags: ["heat"],
    footprint: { width: 1, height: 1 },
    harshWork: false,
    outputKind: "resource",
    outputResourceId: id("firewood"),
    ...overrides,
  };
}

function emptyCellView(cellIndex: number, overrides: Partial<CellViewModel> = {}): CellViewModel {
  return {
    cellIndex,
    cellId: `c${String(cellIndex).padStart(2, "0")}`,
    occupied: false,
    facilityId: null,
    defId: null,
    anchorCellIndex: null,
    tags: [],
    level: 0,
    workerCount: 0,
    multiplierFix: fixFromInt(1),
    multiplierApprox: 1,
    bonusFix: FIX_ZERO,
    overcrowdPenaltyFix: FIX_ZERO,
    overcrowdedNeighborCount: 0,
    overcrowded: false,
    isRubble: false,
    ...overrides,
  };
}

/** vnode ツリーから class 属性を持つ全文字列を集める(検索用の緩い走査)。 */
function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("|");
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return flattenText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return flattenText(vnode.props?.children);
}

describe("FacilityCatalogButton(施設カタログ1件)", () => {
  it("施設名+footprintを表示し、押すと defId で onPick が呼ばれる", () => {
    const onPick = vi.fn();
    const vnode = FacilityCatalogButton({ entry: catalogEntry(), active: false, onPick });
    expect(flattenText(vnode)).toContain("かまど");
    const button = vnode.props.children as { readonly props: { readonly onClick: () => void } };
    button.props.onClick();
    expect(onPick).toHaveBeenCalledWith(id("hearth"));
  });

  it("active=true なら選択中クラスが付く", () => {
    const activeVnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: true,
      onPick: () => undefined,
    });
    const button = activeVnode.props.children as { readonly props: { readonly class: string } };
    expect(button.props.class).toContain("kf-catalog__button--active");
  });

  it("未登録の施設 ID はラベルテーブルに無くても raw ID をそのまま出す(捏造しない)", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry({ defId: id("granary") }),
      active: false,
      onPick: () => undefined,
    });
    expect(flattenText(vnode)).toContain("granary");
  });
});

describe("FacilityCatalogPanel(②の施設カタログ全体)", () => {
  const catalog = [catalogEntry({ defId: id("hearth") }), catalogEntry({ defId: id("workbench") })];

  it("カタログ全件を並べ、配置待ちが無ければキャンセルボタンを出さない", () => {
    const vnode = FacilityCatalogPanel({
      catalog,
      pendingDefId: null,
      onPick: () => undefined,
      onCancel: () => undefined,
    });
    expect(flattenText(vnode)).not.toContain("キャンセル");
  });

  it("配置待ち中はキャンセルボタンが出て、押すと onCancel が呼ばれる", () => {
    const onCancel = vi.fn();
    const vnode = FacilityCatalogPanel({
      catalog,
      pendingDefId: id("hearth"),
      onPick: () => undefined,
      onCancel,
    });
    expect(flattenText(vnode)).toContain("キャンセル");
    // children: [h3, ul, cancelButton] のうち最後がキャンセルボタン。
    const children = vnode.props.children as readonly unknown[];
    const cancelButton = children[children.length - 1] as {
      readonly props: { readonly onClick: () => void };
    };
    cancelButton.props.onClick();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("ReclaimPanel(瓦礫の開墾・GDD 9.1 / M52申し送り)", () => {
  const rubbleCell = emptyCellView(30, { isRubble: true });

  it("content に reclaim ブロックが無ければ不活性メッセージを出し、ボタンを出さない", () => {
    const info: ReclaimInfo = {
      available: false,
      nextCostApprox: null,
      costResourceId: null,
      availableStockApprox: null,
      reclaimedCount: 0,
    };
    const vnode = ReclaimPanel({ cell: rubbleCell, info, onReclaim: () => undefined });
    expect(flattenText(vnode)).toContain("無効");
    expect(flattenText(vnode)).not.toContain("開墾する");
  });

  it("コスト/在庫/通算開墾数を表示し、ボタンを押すと onReclaim が呼ばれる", () => {
    const info: ReclaimInfo = {
      available: true,
      nextCostApprox: 40,
      costResourceId: id("firewood"),
      availableStockApprox: 60,
      reclaimedCount: 0,
    };
    const onReclaim = vi.fn();
    const vnode = ReclaimPanel({ cell: rubbleCell, info, onReclaim });
    const text = flattenText(vnode);
    expect(text).toContain("40");
    expect(text).toContain("薪");
    expect(text).toContain("60");
    expect(text).toContain("開墾する");

    // children = [h3, フラグメント(p, p, button)]。ボタンはフラグメントの末尾。
    const children = vnode.props.children as readonly unknown[];
    const fragment = children[children.length - 1] as {
      readonly props: { readonly children: readonly unknown[] };
    };
    const fragmentChildren = fragment.props.children;
    const button = fragmentChildren[fragmentChildren.length - 1] as {
      readonly props: { readonly onClick: () => void };
    };
    button.props.onClick();
    expect(onReclaim).toHaveBeenCalledOnce();
  });

  it("ボタンは常に有効(在庫不足の判定はしない・engine の insufficientResource reject に委ねる)", () => {
    const info: ReclaimInfo = {
      available: true,
      nextCostApprox: 2000,
      costResourceId: id("firewood"),
      availableStockApprox: 0,
      reclaimedCount: 47,
    };
    const vnode = ReclaimPanel({ cell: rubbleCell, info, onReclaim: () => undefined });
    expect(flattenText(vnode)).toContain("開墾する");
  });
});
