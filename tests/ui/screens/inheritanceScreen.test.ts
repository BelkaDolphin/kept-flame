// ---------------------------------------------------------------------------
// src/ui/screens/inheritance/InheritanceScreen.tsx のテスト(M33)。
//
// `InheritTrackRow` は hooks を使わない純関数コンポーネントなので、
// Preact の render() を通さず直接呼んで vnode 構造を検証する
// (expeditionScreen.test.ts と同じ方針)。数値の正しさ(段階コスト・上限
// クランプ・青天井禁止)自体は `tests/engine/exodus.test.ts` が固定済みなので、
// ここでは「engine の値をそのまま表示しているか」だけを確認する。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
  availableInheritPoints,
  inheritBonusOf,
  inheritTierCost,
  inheritTierMax,
} from "../../../src/engine/rules/exodus";
import { inheritTierOf } from "../../../src/engine/state/state";
import { setProgression } from "../../../src/engine/state/update";
import { InheritTrackRow } from "../../../src/ui/screens/inheritance/InheritanceScreen";
import { exodusContent } from "../m33Fixtures";
import { boardState } from "../fixtures";

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

describe("InheritTrackRow(⑪の1系統)", () => {
  it("段階・ボーナス・次段コストを表示する", () => {
    const vnode = InheritTrackRow({
      track: "caravanCapacity",
      currentTier: 1,
      maxTier: 4,
      currentBonus: 2,
      bonusPerTier: 2,
      nextCost: 75,
      onPurchase: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("キャラバン容量");
    expect(text).toContain("段階 1/4");
    expect(text).toContain("+2");
    expect(text).toContain("次の1段のコスト: 75点");
    expect(text).toContain("購入する");
  });

  it("上限段(nextCost=null)は非活性ボタンで「上限」と表示する(GDD 11.4-6 の青天井禁止)", () => {
    const vnode = InheritTrackRow({
      track: "startingStock",
      currentTier: 4,
      maxTier: 4,
      currentBonus: 100,
      bonusPerTier: 25,
      nextCost: null,
      onPurchase: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("上限段に達しています");
    const button = vnode.props.children as readonly {
      readonly props?: { readonly disabled?: boolean };
    }[];
    const buttonNode = button[button.length - 1];
    expect(buttonNode?.props?.disabled).toBe(true);
  });

  it("押すと onPurchase(track) が呼ばれる", () => {
    const onPurchase = vi.fn();
    const vnode = InheritTrackRow({
      track: "crewCapacity",
      currentTier: 0,
      maxTier: 4,
      currentBonus: 0,
      bonusPerTier: 1,
      nextCost: 50,
      onPurchase,
    });
    const button = vnode.props.children as readonly {
      readonly props?: { readonly onClick?: () => void };
    }[];
    button[button.length - 1]?.props?.onClick?.();
    expect(onPurchase).toHaveBeenCalledWith("crewCapacity");
  });
});

describe("engine の継承点計算を直接呼ぶだけ(UI 側の再計算なし)", () => {
  it("purchaseInheritTier で 1 段購入した後、availableInheritPoints/inheritBonusOf が反映される", () => {
    const content = exodusContent();
    const params = content.exodus;
    if (params === undefined)
      throw new Error("params が undefined(フィクスチャの exodus ブロック欠落)");
    const state = boardState();
    const withPoints = setProgression(state, {
      runCount: 1,
      cumulativeInheritPoints: 84,
      inheritTiers: [],
    });
    expect(availableInheritPoints(withPoints, content)).toBe(84);
    expect(inheritTierCost(params, inheritTierOf(withPoints, "caravanCapacity"))).toBe(50);
    expect(inheritTierMax(params)).toBe(4);
    expect(inheritBonusOf(withPoints, content, "caravanCapacity")).toBe(0);

    const afterPurchase = setProgression(withPoints, {
      runCount: 1,
      cumulativeInheritPoints: 84,
      inheritTiers: [{ track: "caravanCapacity", tier: 1 }],
    });
    expect(availableInheritPoints(afterPurchase, content)).toBe(34); // 84 - 50
    expect(inheritBonusOf(afterPurchase, content, "caravanCapacity")).toBe(2);
    expect(inheritTierCost(params, inheritTierOf(afterPurchase, "caravanCapacity"))).toBe(75);
  });
});
