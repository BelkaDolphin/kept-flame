// ---------------------------------------------------------------------------
// src/ui/screens/codify/CodifyScreen.tsx のテスト(M31)。
//
// `CodifyTechRow`/`CodifySuggestionRow`/`CodifySuggestionPanel`/`mediumLabel` は
// hooks を使わない純関数(コンポーネント)なので、Preact の render() を通さず
// 直接呼んで vnode 構造を検証する(facilityScreen.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { CodifySuggestionView, CodifyTechEntry } from "../../../src/ui/derived";
import {
  CodifySuggestionPanel,
  CodifySuggestionRow,
  CodifyTechRow,
  mediumLabel,
} from "../../../src/ui/screens/codify/CodifyScreen";

const id = entityIdFromString;

function techEntry(overrides: Partial<CodifyTechEntry> = {}): CodifyTechEntry {
  return {
    techId: id("techFireStarting"),
    lossClass: "criticalRecoverable",
    holderIds: [id("aRui")],
    uniqueHolder: true,
    isCodified: false,
    recordedMedia: [],
    pendingRecords: [],
    residualTick: 1000,
    hasDeadline: true,
    maxRecallRiskPercentApprox: 3.5,
    ...overrides,
  };
}

function suggestion(overrides: Partial<CodifySuggestionView> = {}): CodifySuggestionView {
  return {
    techId: id("techFireStarting"),
    medium: "stoneTablet",
    codifyId: id("techFireStartingRecordStone"),
    residualTick: 1000,
    hasDeadline: true,
    durationTicks: 40,
    cumulativeTicks: 40,
    onSchedule: true,
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

function findSelect(
  node: unknown,
): { readonly props: { readonly onChange: (e: Event) => void } } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelect(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (node === null || node === undefined || typeof node !== "object") return null;
  const candidate = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (candidate.type === "select") {
    return candidate as { readonly props: { readonly onChange: (e: Event) => void } };
  }
  if (typeof candidate.type === "function") {
    return findSelect((candidate.type as (props: unknown) => unknown)(candidate.props));
  }
  return findSelect(candidate.props?.children);
}

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

function fakeChangeEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

describe("mediumLabel(RecordMedium の全件を必ず埋める・GDD 11.1追補)", () => {
  it("stoneTablet=石板 / paper=紙", () => {
    expect(mediumLabel("stoneTablet")).toBe("石板");
    expect(mediumLabel("paper")).toBe("紙");
  });
});

describe("CodifyTechRow: 保持者・唯一保持・記録済み・作業中", () => {
  it("唯一保持は「(唯一保持)」を強調する", () => {
    const vnode = CodifyTechRow({
      entry: techEntry({ uniqueHolder: true, holderIds: [id("aRui")] }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    expect(flattenText(vnode)).toContain("唯一保持");
  });

  it("複数保持は「(唯一保持)」を出さない", () => {
    const vnode = CodifyTechRow({
      entry: techEntry({ uniqueHolder: false, holderIds: [id("aRui"), id("aKaya")] }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("保持者 2人");
    expect(text).not.toContain("唯一保持");
  });

  it("保持者 0 人は残存想定/想起リスクの行を出さない(捏造しない)", () => {
    const vnode = CodifyTechRow({
      entry: techEntry({ holderIds: [], uniqueHolder: false, maxRecallRiskPercentApprox: null }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("保持者 0人");
    expect(text).not.toContain("残存想定");
  });

  it("無期限(寿命モデル未設定)は tick 数を出さない", () => {
    const vnode = CodifyTechRow({
      entry: techEntry({ hasDeadline: false, residualTick: 9007199254740991 }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("無期限");
    expect(text).not.toContain("9007199254740991");
  });

  it("未記録は「未記録」、記録済みは媒体を列挙する", () => {
    const notRecorded = CodifyTechRow({
      entry: techEntry({ isCodified: false }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    expect(flattenText(notRecorded)).toContain("未記録");

    const recorded = CodifyTechRow({
      entry: techEntry({ isCodified: true, recordedMedia: ["paper", "stoneTablet"] }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const text = flattenText(recorded);
    expect(text).toContain("記録済み");
    expect(text).toContain("紙");
    expect(text).toContain("石板");
  });

  it("作業中の記録(pendingRecords)は進行度を表示する", () => {
    const vnode = CodifyTechRow({
      entry: techEntry({
        pendingRecords: [
          { entityId: id("cJob1"), medium: "paper", progressApprox: 5, requiredWorkApprox: 20 },
        ],
      }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("作業中");
    expect(text).toContain("5.0");
    expect(text).toContain("20.0");
  });
});

describe("CodifyTechRow: 媒体トグル + キュー投入(ロードマップ M31 行 [2026-07-27追補])", () => {
  it("媒体セレクトを変えると onMediumChange(techId, medium) が呼ばれる", () => {
    const onMediumChange = vi.fn();
    const vnode = CodifyTechRow({
      entry: techEntry({ techId: id("techPottery") }),
      selectedMedium: "stoneTablet",
      onMediumChange,
      onEnqueue: () => undefined,
    });
    const select = findSelect(vnode);
    expect(select).not.toBeNull();
    select?.props.onChange(fakeChangeEvent("paper"));
    expect(onMediumChange).toHaveBeenCalledWith(id("techPottery"), "paper");
  });

  it("「キューに入れる」を押すと onEnqueue(techId, selectedMedium) が呼ばれる(判定は engine の reject に委ねる)", () => {
    const onEnqueue = vi.fn();
    const vnode = CodifyTechRow({
      entry: techEntry({ techId: id("techPottery") }),
      selectedMedium: "paper",
      onMediumChange: () => undefined,
      onEnqueue,
    });
    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onEnqueue).toHaveBeenCalledWith(id("techPottery"), "paper");
  });
});

describe("CodifySuggestionRow(おまかせ成文化 1 件・GDD 2.1)", () => {
  it("順番・媒体・所要/累積tick・間に合う見込みを表示する", () => {
    const vnode = CodifySuggestionRow({
      suggestion: suggestion({ onSchedule: true, durationTicks: 40, cumulativeTicks: 90 }),
      order: 3,
    });
    const text = flattenText(vnode);
    expect(text).toContain("3.");
    expect(text).toContain("火起こし");
    expect(text).toContain("石板");
    expect(text).toContain("40");
    expect(text).toContain("90");
    expect(text).toContain("間に合う見込み");
  });

  it("onSchedule=false は「間に合わない見込み」", () => {
    const vnode = CodifySuggestionRow({ suggestion: suggestion({ onSchedule: false }), order: 1 });
    expect(flattenText(vnode)).toContain("間に合わない見込み");
  });

  it("無期限(hasDeadline=false)は tick 数を出さない", () => {
    const vnode = CodifySuggestionRow({
      suggestion: suggestion({ hasDeadline: false, residualTick: 9007199254740991 }),
      order: 1,
    });
    const text = flattenText(vnode);
    expect(text).toContain("無期限");
    expect(text).not.toContain("9007199254740991");
  });
});

describe("CodifySuggestionPanel(提案→確認→適用・GDD 2.1)", () => {
  it("提案 0 件は「対象がありません」を出し、適用ボタンを出さない(捏造しない)", () => {
    const vnode = CodifySuggestionPanel({
      suggestions: [],
      outcome: null,
      onApply: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("対象がありません");
    expect(findButton(vnode)).toBeNull();
  });

  it("提案があれば一覧を出し、適用ボタンを押すと onApply が呼ばれる", () => {
    const onApply = vi.fn();
    const vnode = CodifySuggestionPanel({
      suggestions: [suggestion()],
      outcome: null,
      onApply,
    });
    expect(flattenText(vnode)).toContain("火起こし");
    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("適用結果(outcome)を表示する", () => {
    const vnode = CodifySuggestionPanel({
      suggestions: [suggestion()],
      outcome: { appliedCount: 1, total: 2, stoppedAtTechId: id("techPottery") },
      onApply: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("1/2件を適用しました");
    expect(text).toContain("土器で停止");
  });
});
