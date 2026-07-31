// ---------------------------------------------------------------------------
// src/ui/screens/outposts/OutpostsScreen.tsx のテスト(M32)。
//
// `OutpostCard` は hooks を使わない純関数なので、Preact の render() を通さず
// 直接呼んで検証する(facilityScreen.test.ts と同じ方針)。`OutpostsScreen`
// 本体(hooks あり)は登録テスト(appShell.test.ts)のみ。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { OutpostRosterEntry } from "../../../src/ui/derived";
import { OutpostCard } from "../../../src/ui/screens/outposts/OutpostsScreen";

const id = entityIdFromString;

function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return flattenText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return flattenText(vnode.props?.children);
}

function outpost(overrides: Partial<OutpostRosterEntry> = {}): OutpostRosterEntry {
  return {
    outpostId: id("outpost1"),
    outpostTypeId: id("outpostMine"),
    resourceId: id("iron"),
    band: "near",
    level: 1,
    residentIds: [id("aRui")],
    establishedTick: 0,
    supplyApprox: 10,
    upkeepApprox: 4,
    netRevenueApprox: 6,
    hazardApprox: 0.05,
    rareAssetCount: 0,
    expectedRareLossApprox: 0,
    roiApprox: 2.5,
    ...overrides,
  };
}

describe("OutpostCard(⑨拠点1基・GDD 9.2・検収条件=(B)損失項が画面に出ているか)", () => {
  it("タイプ名(GDD 9.2の用語)・供給・維持費・ネット収益・危険度・ROIを表示する", () => {
    const vnode = OutpostCard({ outpost: outpost() });
    const text = flattenText(vnode);
    expect(text).toContain("鉱山");
    expect(text).toContain("供給");
    expect(text).toContain("維持費");
    expect(text).toContain("ネット収益");
    // [束B/B-2] 英語のまま出ていた "hazard" をプレイヤー語(危険度)へ改めた。
    expect(text).toContain("危険度");
    expect(text).not.toContain("hazard");
    expect(text).toContain("ROI");
  });

  it("(B)喪失リスク項を隠さない(GDD 8.6 を援用・本タスクの検収条件)", () => {
    const vnode = OutpostCard({
      outpost: outpost({ rareAssetCount: 2, expectedRareLossApprox: 12.5 }),
    });
    const text = flattenText(vnode);
    expect(text).toContain("(B)喪失リスク");
    expect(text).toContain("12.5");
    expect(text).toContain("2 件");
  });

  it("ネット収益が負なら放棄検討の注記を出す", () => {
    const vnode = OutpostCard({ outpost: outpost({ netRevenueApprox: -3 }) });
    expect(flattenText(vnode)).toContain("放棄を検討");
  });

  it("ROI が null(分母0)なら「算出不可」", () => {
    const vnode = OutpostCard({ outpost: outpost({ roiApprox: null }) });
    expect(flattenText(vnode)).toContain("算出不可");
  });
});
