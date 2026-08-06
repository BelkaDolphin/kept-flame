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
    // [束B/B-4] 建設コスト欄の追加(derived.ts)に追随。既定はテスト都合で
    // 「無料」に揃え、コスト表示を確認するテストだけ overrides で足す。
    buildCostApprox: null,
    buildCostResourceId: null,
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
    const vnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: false,
      insufficient: false,
      onPick,
    });
    expect(flattenText(vnode)).toContain("かまど");
    const button = vnode.props.children as { readonly props: { readonly onClick: () => void } };
    button.props.onClick();
    expect(onPick).toHaveBeenCalledWith(id("hearth"));
  });

  it("active=true なら選択中クラスが付く", () => {
    const activeVnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: true,
      insufficient: false,
      onPick: () => undefined,
    });
    const button = activeVnode.props.children as { readonly props: { readonly class: string } };
    expect(button.props.class).toContain("kf-catalog__button--active");
  });

  it("未登録の施設 ID はラベルテーブルに無くても raw ID をそのまま出す(捏造しない)", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry({ defId: id("granary") }),
      active: false,
      insufficient: false,
      onPick: () => undefined,
    });
    expect(flattenText(vnode)).toContain("granary");
  });

  it("[束B/B-4] コストを併記し、在庫不足は色(専用クラス)+記号(▲)の両方で示す", () => {
    // [M73/R8-03] 表記は「コスト 資源名 数量」へ揃えた(③増築カードの
    // 「増築コスト: 薪 45」・⑥成文化の「必要資源: 粘土 20」と同じ並び。
    // 複数資源を「・」で連ねたときに数量と資源名の対応が崩れないため)。
    const entry = catalogEntry({ buildCostApprox: 30, buildCostResourceId: id("firewood") });
    const affordable = FacilityCatalogButton({
      entry,
      active: false,
      insufficient: false,
      onPick: () => undefined,
    });
    expect(flattenText(affordable)).toContain("コスト 薪 30");
    expect(flattenText(affordable)).not.toContain("▲");

    const insufficient = FacilityCatalogButton({
      entry,
      active: false,
      insufficient: true,
      onPick: () => undefined,
    });
    const text = flattenText(insufficient);
    expect(text).toContain("▲");
    expect(text).toContain("コスト 薪 30");
    const button = insufficient.props.children as { readonly props: { readonly class: string } };
    expect(button.props.class).toContain("kf-catalog__button--insufficient");
  });

  it("[M73/R8-03 fatal] 複数資源コスト(M65 の extraLines)を全行表示する", () => {
    const entry = catalogEntry({
      defId: id("scriptorium"),
      buildCostApprox: 14,
      buildCostResourceId: id("firewood"),
      buildCostLines: [
        { resourceId: id("firewood"), amountApprox: 14 },
        { resourceId: id("clay"), amountApprox: 6 },
      ],
    });
    const text = flattenText(
      FacilityCatalogButton({ entry, active: false, insufficient: false, onPick: () => undefined }),
    );
    expect(text).toContain("薪 14");
    expect(text).toContain("粘土 6");
  });

  it("[束B/B-4] コストが無い(buildCostApprox=null)施設は「コストなし」と表示する", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: false,
      insufficient: false,
      onPick: () => undefined,
    });
    expect(flattenText(vnode)).toContain("コストなし");
  });

  it("[M61/FC6] effectHint があれば建設前ヒントを添える(寝床の実効果/保管庫の実効果/非稼働の未実装)", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: false,
      insufficient: false,
      onPick: () => undefined,
      effectHint: "全資源の保管上限を設定(Lv1: 400)。上限を超えた分の産出は失われます。",
    });
    expect(flattenText(vnode)).toContain("保管上限を設定");
  });

  it("effectHint 省略時は何も添えない(通常施設・後方互換)", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry(),
      active: false,
      insufficient: false,
      onPick: () => undefined,
    });
    expect(flattenText(vnode)).not.toContain("保管上限");
    expect(flattenText(vnode)).not.toContain("効果は未実装");
  });
});

describe("FacilityCatalogPanel(②の施設カタログ全体)", () => {
  const catalog = [catalogEntry({ defId: id("hearth") }), catalogEntry({ defId: id("workbench") })];

  it("カタログ全件を並べ、配置待ちが無ければキャンセルボタンを出さない", () => {
    const vnode = FacilityCatalogPanel({
      catalog,
      pendingDefId: null,
      resources: [],
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
      resources: [],
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

  it("[M73/R8-03 fatal] 第2行以降の在庫不足も「▲」で示す(以前は主資源だけ見ていた)", () => {
    const watchtower = catalogEntry({
      defId: id("watchtower"),
      buildCostApprox: 30,
      buildCostResourceId: id("firewood"),
      buildCostLines: [
        { resourceId: id("firewood"), amountApprox: 30 },
        { resourceId: id("copper"), amountApprox: 5 },
      ],
    });
    // 薪は足りるが銅が 0 = engine は insufficientResource で拒否する状況。
    const vnode = FacilityCatalogPanel({
      catalog: [watchtower],
      pendingDefId: null,
      resources: [
        {
          entityId: id("resFirewood"),
          resourceId: id("firewood"),
          stockFix: fixFromInt(100),
          stockApprox: 100,
          capacityApprox: null,
          atCapacity: false,
        },
      ],
      onPick: () => undefined,
      onCancel: () => undefined,
    });
    expect(flattenText(vnode)).toContain("▲");
  });

  it("[M73/R8-03] 全行の在庫が足りていれば「▲」を出さない", () => {
    const watchtower = catalogEntry({
      defId: id("watchtower"),
      buildCostApprox: 30,
      buildCostResourceId: id("firewood"),
      buildCostLines: [
        { resourceId: id("firewood"), amountApprox: 30 },
        { resourceId: id("copper"), amountApprox: 5 },
      ],
    });
    const vnode = FacilityCatalogPanel({
      catalog: [watchtower],
      pendingDefId: null,
      resources: [
        {
          entityId: id("resFirewood"),
          resourceId: id("firewood"),
          stockFix: fixFromInt(100),
          stockApprox: 100,
          capacityApprox: null,
          atCapacity: false,
        },
        {
          entityId: id("resCopper"),
          resourceId: id("copper"),
          stockFix: fixFromInt(9),
          stockApprox: 9,
          capacityApprox: null,
          atCapacity: false,
        },
      ],
      onPick: () => undefined,
      onCancel: () => undefined,
    });
    expect(flattenText(vnode)).not.toContain("▲");
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

  it("[M63/R4-A12/A13・M71/R6-A06 で改訂] 端数のある在庫は整数切り捨て(HUD と揃える)・コストは整形ヘルパを通す", () => {
    const info: ReclaimInfo = {
      available: true,
      nextCostApprox: 30.712345,
      costResourceId: id("firewood"),
      availableStockApprox: 417.29,
      reclaimedCount: 3,
    };
    const vnode = ReclaimPanel({ cell: rubbleCell, info, onReclaim: () => undefined });
    const text = flattenText(vnode);
    // 生の float(417.29 や 30.712345)がそのまま出ない(旧「開墾パネル在庫417.29」の解消)。
    expect(text).not.toContain("417.29");
    expect(text).not.toContain("30.712345");
    expect(text).toContain("417"); // 在庫は整数切り捨て(formatResourceStock)。
    // [M71/R6-A06] 「約」を付ける場合は整数へ丸める(旧: 小数第1位「30.7」を
    // そのまま出していた=「約」との併記が粒度不揃いだった・reclaimCostText 参照)。
    expect(text).toContain("約31");
  });

  it("[M71/R6-A06] 小数を含むコストは「約」+整数へ丸める(「約」と小数第1位の併記という粒度の不揃いを解消)", () => {
    const decimalInfo: ReclaimInfo = {
      available: true,
      nextCostApprox: 79.4,
      costResourceId: id("firewood"),
      availableStockApprox: 100,
      reclaimedCount: 5,
    };
    const decimalVnode = ReclaimPanel({
      cell: rubbleCell,
      info: decimalInfo,
      onReclaim: () => undefined,
    });
    const decimalText = flattenText(decimalVnode);
    expect(decimalText).toContain("約79");
    // 「約」と小数第1位の併記(旧「約79.4」)をやめた(R6-A06)。
    expect(decimalText).not.toContain("79.4");

    const integerInfo: ReclaimInfo = {
      available: true,
      nextCostApprox: 60,
      costResourceId: id("firewood"),
      availableStockApprox: 100,
      reclaimedCount: 0,
    };
    const integerVnode = ReclaimPanel({
      cell: rubbleCell,
      info: integerInfo,
      onReclaim: () => undefined,
    });
    const integerText = flattenText(integerVnode);
    // このファイルの flattenText は要素間の区切りに "|" を挟む(ファイル冒頭の
    // doc 参照)ので、「開墾コスト: 」と近似値は別ノードとして別々に確認する。
    expect(integerText).toContain("開墾コスト:");
    expect(integerText).toContain("60");
    expect(integerText).not.toContain("約");
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
