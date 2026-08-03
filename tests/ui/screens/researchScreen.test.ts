// ---------------------------------------------------------------------------
// src/ui/screens/research/ResearchScreen.tsx のテスト(M31)。
//
// `ResearchTechRow`/`ResearchEraSection`/`groupResearchTreeByEra` は hooks を
// 使わない純関数(コンポーネント)なので、Preact の render() を通さず直接呼んで
// vnode 構造を検証する(facilityScreen.test.ts/residentsScreen.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { ResearchTreeEntry } from "../../../src/ui/derived";
import {
  ResearchEraSection,
  ResearchTechRow,
  groupResearchTreeByEra,
  researchEntityIdFor,
} from "../../../src/ui/screens/research/ResearchScreen";

const id = entityIdFromString;

function entry(overrides: Partial<ResearchTreeEntry> = {}): ResearchTreeEntry {
  return {
    techId: id("techFireStarting"),
    eraId: "e1",
    lossClass: "criticalRecoverable",
    prereqTechIds: [],
    prereqsMet: true,
    researchCostApprox: 30,
    status: "notStarted",
    progressApprox: null,
    isCurrentResearchTarget: false,
    ...overrides,
  };
}

/** vnode ツリーから全テキストを区切り無しで集める(facilityScreen.test.ts と同型)。 */
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

/** 最初に見つかった button を返す(facilityScreen.test.ts の findButton と同型)。 */
function findButton(node: unknown): { readonly props: { readonly onClick: () => void } } | null {
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

describe("researchEntityIdFor(beginResearch へ渡す research entity ID)", () => {
  it("techId から決定論的に作る(同じ techId は常に同じ ID)", () => {
    expect(researchEntityIdFor(id("techFireStarting"))).toBe(
      researchEntityIdFor(id("techFireStarting")),
    );
    expect(researchEntityIdFor(id("techFireStarting"))).not.toBe(
      researchEntityIdFor(id("techPottery")),
    );
  });
});

describe("ResearchTechRow: (A)/(B) 常時判別可能(GDD 7.4・M31 検収条件)", () => {
  it("(A) criticalRecoverable は「再取得可能」の文言を出す", () => {
    const vnode = ResearchTechRow({
      entry: entry({ lossClass: "criticalRecoverable" }),
      onBeginResearch: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("A");
    expect(text).toContain("再取得可能");
  });

  it("(B) rareIrreversible は「取り返し不可」の文言を出す(色だけに頼らない)", () => {
    const vnode = ResearchTechRow({
      entry: entry({ lossClass: "rareIrreversible", techId: id("techLens") }),
      onBeginResearch: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("B");
    expect(text).toContain("一回性喪失");
    expect(text).toContain("取り返し不可");
  });

  it("(A)/(B) バッジは completed/lost 等どの状態でも常に出る(GDD 7.4 の検収条件)", () => {
    for (const status of [
      "notStarted",
      "researching",
      "completed",
      "lostRecoverable",
      "lostIrreversible",
    ] as const) {
      const vnode = ResearchTechRow({
        entry: entry({ lossClass: "rareIrreversible", status, progressApprox: 5 }),
        onBeginResearch: () => undefined,
      });
      expect(flattenText(vnode)).toContain("一回性喪失");
    }
  });
});

describe("ResearchTechRow: 状態文言(未着手/研究中/解禁済み/停滞喪失/一回性喪失)", () => {
  it("notStarted は「未着手」", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "notStarted" }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("未着手");
  });

  it("researching は進行度とコストを表示する", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "researching", progressApprox: 12.3, researchCostApprox: 30 }),
      onBeginResearch: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("研究中");
    expect(text).toContain("12.3");
    // [M63/R4-A12/A13] formatResourceAmount 経由に統一(整数値は末尾 ".0" を
    // 出さない——旧「研究コスト30.0」の不揃いの解消)。
    expect(text).toContain("30");
    expect(text).not.toContain("30.0");
  });

  it("researching かつキュー先頭でない場合は「キュー待ち」を添える", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "researching", progressApprox: 0, isCurrentResearchTarget: false }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("キュー待ち");
  });

  it("completed は「解禁済み」", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "completed" }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("解禁済み");
  });

  it("lostRecoverable は (A) の「再研究できます」を出す", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "lostRecoverable" }),
      onBeginResearch: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("停滞中");
    expect(text).toContain("再研究できます");
  });

  it("lostIrreversible は「二度と得られません」を出す(GDD 7.4「取り返しがつかない」)", () => {
    const vnode = ResearchTechRow({
      entry: entry({ status: "lostIrreversible", lossClass: "rareIrreversible" }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("二度と得られません");
  });
});

describe("ResearchTechRow: 前提表示", () => {
  it("前提が無ければ「起点テック」", () => {
    const vnode = ResearchTechRow({
      entry: entry({ prereqTechIds: [] }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("起点テック");
  });

  it("前提が全て解禁済みなら「すべて解禁済み」", () => {
    const vnode = ResearchTechRow({
      entry: entry({ prereqTechIds: [id("techFireStarting")], prereqsMet: true }),
      onBeginResearch: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("火起こし");
    expect(text).toContain("すべて解禁済み");
  });

  it("前提が未解禁なら「未解禁のものがあります」(判定は書かず表示のみ)", () => {
    const vnode = ResearchTechRow({
      entry: entry({ prereqTechIds: [id("techFireStarting")], prereqsMet: false }),
      onBeginResearch: () => undefined,
    });
    expect(flattenText(vnode)).toContain("未解禁のものがあります");
  });
});

describe("ResearchTechRow: 「研究を開始」は常に活性(判定は engine の M50 reject に委ねる)", () => {
  it.each([
    "notStarted",
    "researching",
    "completed",
    "lostRecoverable",
    "lostIrreversible",
  ] as const)("status=%s でも押すと onBeginResearch(techId) が呼ばれる", (status) => {
    const onBeginResearch = vi.fn();
    const vnode = ResearchTechRow({
      entry: entry({ status, techId: id("techPottery") }),
      onBeginResearch,
    });
    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onBeginResearch).toHaveBeenCalledWith(id("techPottery"));
  });
});

describe("groupResearchTreeByEra(GDD 5.2「エラ別テック一覧」)", () => {
  it("同じエラの連続をまとめる(既にエラ順に並んでいる前提)", () => {
    const entries = [
      entry({ techId: id("techFireStarting"), eraId: "e1" }),
      entry({ techId: id("techPottery"), eraId: "e1" }),
      entry({ techId: id("techCharcoalKiln"), eraId: "e2" }),
    ];
    const groups = groupResearchTreeByEra(entries);
    expect(groups.map((g) => g.eraId)).toEqual(["e1", "e2"]);
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[1]?.entries).toHaveLength(1);
  });

  it("空配列は空配列", () => {
    expect(groupResearchTreeByEra([])).toEqual([]);
  });

  it("エラ不明(null)も 1 グループとして扱う", () => {
    const groups = groupResearchTreeByEra([entry({ eraId: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.eraId).toBeNull();
  });
});

describe("ResearchEraSection", () => {
  it("エラ名を見出しに出し、行を並べる", () => {
    const group = {
      eraId: "e1",
      entries: [entry({ techId: id("techFireStarting") }), entry({ techId: id("techPottery") })],
    };
    const vnode = ResearchEraSection({ group, onBeginResearch: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("灰の時代");
    expect(text).toContain("火起こし");
    expect(text).toContain("土器");
  });
});
