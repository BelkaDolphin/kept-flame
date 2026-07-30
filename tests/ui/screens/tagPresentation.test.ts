// ---------------------------------------------------------------------------
// TagIcons.tsx / TagChip.tsx / LegendPanel.tsx / CellBreakdownView.tsx の
// 構造テスト(M19)。Preact の render() を経由しない vnode 構造検証
// (gridBoard.test.ts と同じ方針・ADR-001: jsdom 非依存)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { ADJACENCY_TAGS } from "../../../src/engine/adjacency";
import { fixFromInt, fixFromRaw } from "../../../src/engine/fp";
import { CellBreakdownView } from "../../../src/ui/screens/grid/CellBreakdownView";
import { LegendPanel } from "../../../src/ui/screens/grid/LegendPanel";
import { TagChip } from "../../../src/ui/screens/grid/TagChip";
import { TagIconDefs, TagSymbol, tagSymbolId } from "../../../src/ui/screens/grid/TagIcons";
import type { CellAdjacencyBreakdown } from "../../../src/ui/screens/grid/adjacencyBreakdown";

function findAll(
  node: unknown,
  predicate: (v: { readonly type?: unknown; readonly props?: unknown }) => boolean,
): unknown[] {
  const results: unknown[] = [];
  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n === null || n === undefined || typeof n !== "object") return;
    const v = n as { readonly type?: unknown; readonly props?: { readonly children?: unknown } };
    // [M19] 関数コンポーネント(TagSymbol/TagChip 等)は h() 時点では type が
    // 関数参照のまま。hooks 非使用の純関数である前提で直接呼び出して展開する。
    if (typeof v.type === "function") {
      walk((v.type as (props: unknown) => unknown)(v.props));
      return;
    }
    if (predicate(v)) results.push(v);
    walk(v.props?.children);
  }
  walk(node);
  return results;
}

describe("tagSymbolId", () => {
  it("タグ+バリアントからidを組み立てる", () => {
    expect(tagSymbolId("heat", "full")).toBe("kf-tag-heat-full");
    expect(tagSymbolId("lore", "mini")).toBe("kf-tag-lore-mini");
  });
});

describe("TagIconDefs", () => {
  it("7タグ × full/mini の symbol(14個)+ lore専用チップsymbol(1個)+ 4パターン + loreチップパターンを持つ", () => {
    const vnode = TagIconDefs();
    const symbols = findAll(vnode, (v) => v.type === "symbol");
    // 7種 × 2バリアント = 14個 + lore の chip 専用 full(mini無し)1個 = 15個。
    expect(symbols).toHaveLength(15);
    const patterns = findAll(vnode, (v) => v.type === "pattern");
    // foul/damp/calm/lore の4個 + lore チップ用1個 = 5個。
    expect(patterns).toHaveLength(5);
  });
});

describe("TagSymbol", () => {
  it("<svg><use></svg> の2要素を返す(spec §5.1)", () => {
    const vnode = TagSymbol({ tag: "heat", variant: "full", sizePx: 26 });
    expect(vnode.type).toBe("svg");
    const uses = findAll(vnode, (v) => v.type === "use");
    expect(uses).toHaveLength(1);
  });

  it("lore + chipContext のときチップ専用symbolを参照する", () => {
    const vnode = TagSymbol({ tag: "lore", variant: "full", chipContext: true, sizePx: 26 });
    const use = findAll(vnode, (v) => v.type === "use")[0] as {
      readonly props: { readonly href: string };
    };
    expect(use.props.href).toBe("#kf-tag-lore-full-chip");
  });

  it("lore + chipContext=false のときは通常symbolを参照する", () => {
    const vnode = TagSymbol({ tag: "lore", variant: "full", sizePx: 26 });
    const use = findAll(vnode, (v) => v.type === "use")[0] as {
      readonly props: { readonly href: string };
    };
    expect(use.props.href).toBe("#kf-tag-lore-full");
  });
});

describe("TagChip(44px・4重符号化の完全形)", () => {
  it("値を渡すと数値プレートが出る", () => {
    const vnode = TagChip({ tag: "heat", valueText: "+20" });
    expect(vnode.props.class).toBe("kf-tag-chip");
    const values = findAll(
      vnode,
      (v) => (v.props as { readonly class?: string } | undefined)?.class === "kf-tag-chip__value",
    );
    expect(values).toHaveLength(1);
  });

  it("値を省略すると数値プレートを出さない", () => {
    const vnode = TagChip({ tag: "heat" });
    const values = findAll(
      vnode,
      (v) => (v.props as { readonly class?: string } | undefined)?.class === "kf-tag-chip__value",
    );
    expect(values).toHaveLength(0);
  });
});

describe("LegendPanel(GDD 6.5 MVP要件)", () => {
  it("7タグぶんのチップを並べる", () => {
    const vnode = LegendPanel({});
    const chips = findAll(
      vnode,
      (v) => (v.props as { readonly class?: string } | undefined)?.class === "kf-tag-chip",
    );
    expect(chips).toHaveLength(ADJACENCY_TAGS.length);
  });

  it("overcrowd 情報を渡すと文言に反映される", () => {
    const vnode = LegendPanel({ overcrowd: { threshold: 3, penaltyPerExcessPercent: -10 } });
    const notes = findAll(vnode, (v) => v.type === "p");
    const text = JSON.stringify(notes);
    expect(text).toContain("3");
  });
});

describe("CellBreakdownView(GDD 6.5 内訳ビュー)", () => {
  it("breakdown が null なら空メッセージ", () => {
    const vnode = CellBreakdownView({ cellId: null, breakdown: null });
    const empties = findAll(
      vnode,
      (v) => (v.props as { readonly class?: string } | undefined)?.class === "kf-breakdown__empty",
    );
    expect(empties.length).toBeGreaterThan(0);
  });

  it("breakdown があればタグ別バケツを表示する(桁数制約無しの生パーセント)", () => {
    const breakdown: CellAdjacencyBreakdown = {
      buckets: [
        {
          tag: "heat",
          neighborAnchors: [1],
          effectiveAnchors: [1],
          excessAnchors: [],
          contributions: [
            {
              neighborAnchorCellIndex: 1,
              selfTag: "heat",
              neighborTag: "heat",
              effect: {
                effect: "yieldMul",
                target: { kind: "any" },
                valueFix: fixFromRaw(200_000),
              },
              applied: true,
            },
          ],
          rawPenaltyFix: fixFromInt(0),
        },
      ],
      bonusFix: fixFromRaw(200_000),
      overcrowdPenaltyFix: fixFromInt(0),
      multiplierFix: fixFromRaw(1_200_000),
      overcrowdedNeighborCount: 0,
    };
    const vnode = CellBreakdownView({ cellId: "c01", breakdown });
    // JSX の隣接する {式} は別々の子要素になる(1文字列へ連結されない)ため、
    // 断片ごとに含まれているかを確認する。
    const text = JSON.stringify(vnode);
    expect(text).toContain("1.20");
    expect(text).toContain("+20.0%");
    expect(text).toContain("最終乗数");
  });
});
