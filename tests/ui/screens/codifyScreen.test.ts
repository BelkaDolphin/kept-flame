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
  seedMissingMediumDefaults,
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

// ---------------------------------------------------------------------------
// [M62/FC5a] seedMissingMediumDefaults: 媒体既定値の「初回だけ計算・以後固定」
//
// R2-FC5(a) の再現+修正の固定: ある行をキュー投入して在庫が動いても、
// 既に既定値が割り当て済みの**他行**は変わらない。
// ---------------------------------------------------------------------------
describe("[M62/FC5a] seedMissingMediumDefaults(他行の媒体セレクタが勝手に変わるバグの修正)", () => {
  const techA = techEntry({ techId: id("techFireStarting") });
  const techB = techEntry({ techId: id("techPottery") });

  it("初めて見た techId には defaultFor の結果を割り当てる", () => {
    const result = seedMissingMediumDefaults(new Map(), [techA, techB], () => "stoneTablet");
    expect(result.get(techA.techId)).toBe("stoneTablet");
    expect(result.get(techB.techId)).toBe("stoneTablet");
  });

  it("[R2-FC5a の再現] 既に値がある techId は defaultFor の戻り値が変わっても上書きしない", () => {
    // 1 回目: 両方とも石板が既定(在庫が足りている状態を模す)。
    const seeded = seedMissingMediumDefaults(new Map(), [techA, techB], () => "stoneTablet");
    expect(seeded.get(techA.techId)).toBe("stoneTablet");
    expect(seeded.get(techB.techId)).toBe("stoneTablet");

    // techA をキュー投入した結果、在庫が減って defaultFor が「紙」を返すように
    // なった(=バグ発生時の状況)。しかし techB は一度も操作していない。
    const reseeded = seedMissingMediumDefaults(seeded, [techA, techB], () => "paper");

    // 両方とも stoneTablet のまま(defaultFor の新しい戻り値に引きずられない)。
    expect(reseeded.get(techA.techId)).toBe("stoneTablet");
    expect(reseeded.get(techB.techId)).toBe("stoneTablet");
  });

  it("新しく増えた techId だけ既定値が足される(既存 techId は不変)", () => {
    const seeded = seedMissingMediumDefaults(new Map(), [techA], () => "stoneTablet");
    const withNewTech = seedMissingMediumDefaults(seeded, [techA, techB], () => "paper");
    expect(withNewTech.get(techA.techId)).toBe("stoneTablet");
    expect(withNewTech.get(techB.techId)).toBe("paper");
  });

  it("変化が無ければ同じ参照を返す(不要な再描画を起こさない)", () => {
    const seeded = seedMissingMediumDefaults(new Map(), [techA, techB], () => "stoneTablet");
    const again = seedMissingMediumDefaults(seeded, [techA, techB], () => "paper");
    expect(again).toBe(seeded);
  });

  it("空の techs 一覧では何も足さない(既存の選択もそのまま)", () => {
    const seeded = seedMissingMediumDefaults(new Map(), [techA], () => "stoneTablet");
    const result = seedMissingMediumDefaults(seeded, [], () => "paper");
    expect(result).toBe(seeded);
  });
});

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

  it("[M61/FC11・R1-A15] costPreview があればキューに入れる前に必要資源を見せる", () => {
    const vnode = CodifyTechRow({
      entry: techEntry(),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
      costPreview: { resourceId: id("clay"), amountApprox: 12 },
    });
    const text = flattenText(vnode);
    expect(text).toContain("必要資源");
    expect(text).toContain("粘土");
    expect(text).toContain("12.0");
  });

  it("costPreview 省略時は「必要資源」欄を出さない(後方互換)", () => {
    const vnode = CodifyTechRow({
      entry: techEntry(),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    expect(flattenText(vnode)).not.toContain("必要資源");
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

describe("[M54] CodifyTechRow: 作業中の記録の取消(返金なし・GDD 6.2)", () => {
  it("onCancel 省略時は取消ボタンを描かない(既存呼び出し互換)", () => {
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
    expect(flattenText(vnode)).not.toContain("取消");
  });

  it("onCancel を渡すと作業中の記録ごとに取消ボタンが出て、押すと codifyId で呼ばれる", () => {
    const onCancel = vi.fn();
    const vnode = CodifyTechRow({
      entry: techEntry({
        pendingRecords: [
          { entityId: id("cJob1"), medium: "paper", progressApprox: 5, requiredWorkApprox: 20 },
        ],
      }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
      onCancel,
    });
    const text = flattenText(vnode);
    expect(text).toContain("取消");
    expect(text).toContain("返金なし");
    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onCancel).toHaveBeenCalledWith(id("cJob1"));
  });

  it("複数の作業中記録があれば取消ボタンもその数だけ出る", () => {
    const onCancel = vi.fn();
    const vnode = CodifyTechRow({
      entry: techEntry({
        pendingRecords: [
          { entityId: id("cJob1"), medium: "paper", progressApprox: 5, requiredWorkApprox: 20 },
          {
            entityId: id("cJob2"),
            medium: "stoneTablet",
            progressApprox: 1,
            requiredWorkApprox: 10,
          },
        ],
      }),
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
      onCancel,
    });
    let count = 0;
    function countButtons(node: unknown): void {
      if (Array.isArray(node)) {
        for (const child of node) countButtons(child);
        return;
      }
      if (node === null || node === undefined || typeof node !== "object") return;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly children?: unknown; readonly class?: string };
      };
      if (
        candidate.type === "button" &&
        typeof candidate.props?.class === "string" &&
        candidate.props.class.includes("cancel-button")
      ) {
        count++;
      }
      if (typeof candidate.type === "function") {
        countButtons((candidate.type as (props: unknown) => unknown)(candidate.props));
        return;
      }
      countButtons(candidate.props?.children);
    }
    countButtons(vnode);
    expect(count).toBe(2);
  });
});

describe("CodifySuggestionRow(おまかせ成文化 1 件・GDD 2.1)", () => {
  // [M61/FC11・R1-A21] 手書きの連番(order プロップ)は削除した——描画先が
  // <ol> なのでブラウザのマーカー番号と二重表示("1. 1. 土器…")になっていた。
  it("媒体・所要/累積・間に合う見込みを表示する(手書きの連番は付けない)", () => {
    const vnode = CodifySuggestionRow({
      suggestion: suggestion({ onSchedule: true, durationTicks: 40, cumulativeTicks: 90 }),
    });
    const text = flattenText(vnode);
    expect(text).toContain("火起こし");
    expect(text).toContain("石板");
    expect(text).toContain("間に合う見込み");
    // [M61/FC5⑤] 所要/累積は formatTickSpan 経由(40tick=40分・90tick=1時間30分)。
    expect(text).toContain("40分");
    expect(text).toContain("1時間30分");
    expect(text).not.toContain("tick");
  });

  it("onSchedule=false は「間に合わない見込み」", () => {
    const vnode = CodifySuggestionRow({ suggestion: suggestion({ onSchedule: false }) });
    expect(flattenText(vnode)).toContain("間に合わない見込み");
  });

  it("無期限(hasDeadline=false)は tick 数を出さない", () => {
    const vnode = CodifySuggestionRow({
      suggestion: suggestion({ hasDeadline: false, residualTick: 9007199254740991 }),
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
