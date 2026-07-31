// ---------------------------------------------------------------------------
// src/ui/screens/chronicle/ChronicleScreen.tsx のテスト(M32)。
//
// `memoirEntryText`/`MemoirRow` は hooks を使わない純関数なので、Preact の
// render() を通さず直接呼んで検証する(facilityScreen.test.ts と同じ方針)。
// `ChronicleScreen` 本体(hooks あり)は登録テスト(appShell.test.ts)のみ。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { MemoirFeedEntry } from "../../../src/ui/derived";
import { MemoirRow, memoirEntryText } from "../../../src/ui/screens/chronicle/ChronicleScreen";

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

describe("memoirEntryText(GDD 7.3・事実だけの文言・網羅switch)", () => {
  it("加入/死亡", () => {
    expect(memoirEntryText({ kind: "arrival", tick: 0 })).toBe("加入した。");
    expect(memoirEntryText({ kind: "death", tick: 0 })).toBe("亡くなった。");
  });

  it("絆節目/絆喪失(相手ID・節目段を含む)", () => {
    expect(
      memoirEntryText({ kind: "bondMilestone", tick: 0, partnerId: id("aKaya"), tier: 2 }),
    ).toBe("aKaya との絆が深まった(節目2)。");
    expect(memoirEntryText({ kind: "partnerLost", tick: 0, partnerId: id("aKaya") })).toBe(
      "絆を結んでいた aKaya を喪った。",
    );
  });

  it("探索での保護(距離帯・被保護者IDを含む)", () => {
    expect(
      memoirEntryText({
        kind: "explorationRescue",
        tick: 0,
        rescuedId: id("aRescued"),
        band: "far",
      }),
    ).toBe("遠隔探索で aRescued を保護した。");
  });

  it("bio 3種(候補番号のみ・実文言は捏造しない)", () => {
    expect(memoirEntryText({ kind: "bioCatchphrase", tick: 0, variantIndex: 3 })).toContain("口癖");
    expect(memoirEntryText({ kind: "bioFear", tick: 0, variantIndex: 1 })).toContain("恐れ");
    expect(memoirEntryText({ kind: "bioOrigin", tick: 0, variantIndex: 2 })).toContain("出自");
  });
});

describe("MemoirRow(⑧住民memoir1件)", () => {
  it("住民IDと文言を表示する", () => {
    const feedEntry: MemoirFeedEntry = {
      residentId: id("aRui"),
      entry: { kind: "arrival", tick: 120 },
    };
    const vnode = MemoirRow({ feedEntry });
    const text = flattenText(vnode);
    expect(text).toContain("aRui");
    expect(text).toContain("加入した");
  });
});
