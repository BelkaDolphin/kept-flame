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

  it("絆節目/絆喪失(相手ID・節目段を含む・束B/B-3でresidentDisplayName経由)", () => {
    expect(
      memoirEntryText({ kind: "bondMilestone", tick: 0, partnerId: id("aKaya"), tier: 2 }),
    ).toBe("AKaya との絆が深まった(節目2)。");
    expect(memoirEntryText({ kind: "partnerLost", tick: 0, partnerId: id("aKaya") })).toBe(
      "絆を結んでいた AKaya を喪った。",
    );
  });

  it("探索での保護(距離帯・被保護者IDを含む・束B/B-3でresidentDisplayName経由)", () => {
    expect(
      memoirEntryText({
        kind: "explorationRescue",
        tick: 0,
        rescuedId: id("aRescued"),
        band: "far",
      }),
    ).toBe("遠隔探索で ARescued を保護した。");
  });

  it("[M62/FC4・R2-A07] bio 3種は事実だけを伝え、内部の抽選インデックスを露出しない(実文言は捏造しない)", () => {
    const catchphrase = memoirEntryText({ kind: "bioCatchphrase", tick: 0, variantIndex: 3 });
    const fear = memoirEntryText({ kind: "bioFear", tick: 0, variantIndex: 1 });
    const origin = memoirEntryText({ kind: "bioOrigin", tick: 0, variantIndex: 2 });
    expect(catchphrase).toBe("口癖が記録された。");
    expect(fear).toBe("恐れが記録された。");
    expect(origin).toBe("出自が記録された。");
    // 内部インデックス("候補#N")の露出が無いこと(R2-A07 の再発防止)。
    for (const text of [catchphrase, fear, origin]) {
      expect(text).not.toContain("#");
      expect(text).not.toContain("候補");
    }
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
    // [束B/B-3] residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
    expect(text).toContain("加入した");
  });
});
