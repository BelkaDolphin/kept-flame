// ---------------------------------------------------------------------------
// src/ui/screens/facility/FacilityScreen.tsx のテスト(M30)。
//
// `FacilityWorkerRow`/`FacilityDetailPanel` は hooks を使わない純関数
// コンポーネントなので、Preact の render() を通さず直接呼んで vnode 構造を
// 検証する(gridBoard.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { FacilityDetailView, FacilityWorkerView } from "../../../src/ui/derived";
import {
  FacilityDetailPanel,
  FacilityWorkerRow,
} from "../../../src/ui/screens/facility/FacilityScreen";

const id = entityIdFromString;

function workerView(overrides: Partial<FacilityWorkerView> = {}): FacilityWorkerView {
  return {
    residentId: id("aRui"),
    moraleApprox: 60,
    alive: true,
    dispatched: false,
    recallImpaired: false,
    ...overrides,
  };
}

function detailView(overrides: Partial<FacilityDetailView> = {}): FacilityDetailView {
  return {
    facilityId: id("facHearth1"),
    defId: id("hearth"),
    cellIndex: 14,
    cellId: "c14",
    tags: ["heat"],
    level: 2,
    maxLevel: 5,
    slotsMax: null,
    workers: [workerView()],
    outputKind: "resource",
    outputResourceId: id("firewood"),
    outputPerTickApprox: 1.5,
    multiplierApprox: 1.2,
    // [束B/B-4] 増築コスト欄の追加(derived.ts)に追随。既定は「無料」に揃え、
    // コスト表示を確認するテストだけ overrides で足す。
    upgradeCostApprox: null,
    upgradeCostResourceId: null,
    ...overrides,
  };
}

/**
 * vnode ツリーから全テキストを集める(検索用の緩い走査)。
 *
 * 区切り無しで連結する——`Lv{level}` のような JSX は `["Lv", level]` という
 * 隣接した子の配列になり、実際の DOM でも区切り無しで連続して描画される
 * (gridScreen.test.ts の `flattenText` は要素間の区切りに使うため "|" を
 * 挟むが、こちらは「1 つの文としてそのまま読めるか」を確認したいのであえて
 * 区切らない)。
 */
function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
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

describe("FacilityWorkerRow(想起困難/派遣中/死亡tombstoneの状態表示・GDD 7.1/7.5/11.2)", () => {
  it("平常時はステータス badge を 1 つも出さない", () => {
    const vnode = FacilityWorkerRow({ worker: workerView() });
    const text = flattenText(vnode);
    // [束B/B-3] 住民IDは residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
    expect(text).toContain("士気60");
    expect(text).not.toContain("死亡");
    expect(text).not.toContain("派遣中");
    expect(text).not.toContain("想起困難");
  });

  it("死亡tombstone(alive=false)は「死亡」を出す", () => {
    const vnode = FacilityWorkerRow({ worker: workerView({ alive: false }) });
    expect(flattenText(vnode)).toContain("死亡");
  });

  it("派遣中と想起困難は同時に出せる", () => {
    const vnode = FacilityWorkerRow({
      worker: workerView({ dispatched: true, recallImpaired: true }),
    });
    const text = flattenText(vnode);
    expect(text).toContain("派遣中");
    expect(text).toContain("想起困難");
  });
});

describe("FacilityDetailPanel(選択施設の Lv/産出/就労者/増築)", () => {
  it("Lv・上限Lv・産出・就労者数を表示する", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("Lv2");
    expect(text).toContain("Lv5");
    expect(text).toContain("1.50");
    expect(text).toContain("薪");
    // [束B/B-3] 住民IDは residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
  });

  it("研究点産出(resourceId=null)は「研究点」と表示する", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ outputKind: "research", outputResourceId: null }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("研究点");
  });

  it("就労者0人は「就労者がいません」と表示する(捏造しない)", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ workers: [] }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("就労者がいません");
  });

  it("[束B/B-2] 増築コストが無い(def.cost 省略)場合は「コストはかかりません」と正直に表示する", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    expect(flattenText(vnode)).toContain("増築コストはかかりません。");
  });

  it("[束B/B-2/B-4] 増築コストがある場合は資源名+量を実額表示する(M50結線済み)", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ upgradeCostApprox: 45, upgradeCostResourceId: id("firewood") }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("増築コスト: 薪 45");
  });

  it("[束B/B-2] 既に上限Lvなら「既に上限Lvです」と表示する", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({
        level: 5,
        maxLevel: 5,
        upgradeCostApprox: null,
        upgradeCostResourceId: null,
      }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("既に上限Lvです。");
  });

  it("増築ボタンは Lv 上限でも非活性にせず、押すと onUpgrade が呼ばれる(判定は engine に委ねる)", () => {
    const onUpgrade = vi.fn();
    const atMax = detailView({ level: 5, maxLevel: 5 });
    const vnode = FacilityDetailPanel({ detail: atMax, onUpgrade });
    expect(flattenText(vnode)).toContain("Lv6");

    // 最後の div(増築ブロック)内の button を辿る。
    function findButton(
      node: unknown,
    ): { readonly props: { readonly onClick: () => void } } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findButton(child);
          if (found !== null) return found;
        }
        return null;
      }
      if (node === null || node === undefined || typeof node !== "object") return null;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly children?: unknown; readonly onClick?: unknown };
      };
      if (typeof candidate.type === "function") {
        return findButton((candidate.type as (props: unknown) => unknown)(candidate.props));
      }
      if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
        return candidate as { readonly props: { readonly onClick: () => void } };
      }
      return findButton(candidate.props?.children);
    }

    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onUpgrade).toHaveBeenCalledOnce();
  });
});
