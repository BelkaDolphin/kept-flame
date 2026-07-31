// ---------------------------------------------------------------------------
// src/ui/screens/RejectionBanner.tsx のテスト(M30・束B/B-1で改訂)。
//
// ②③④共通のコマンド拒否表示。hooks を使わない純関数コンポーネントなので、
// Preact の render() を通さず直接呼んで検証する(gridBoard.test.ts と同じ方針)。
//
// [束B/B-1] 表示文言は `playerRejectionMessage`(rejectionMessages.ts)経由の
// プレイヤー語に変わった。元の engine message は title/data-original-message
// 属性へ退避される(デバッグ用)。code → 文言の網羅性は
// tests/ui/screens/rejectionMessages.test.ts が別途担当する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import { RejectionBanner } from "../../../src/ui/screens/RejectionBanner";

const id = entityIdFromString;

describe("RejectionBanner(コマンド拒否の表示・commands.ts §2/§3)", () => {
  it("プレイヤー語化した文言を表示し、code を data 属性に持つ(分岐は code 側で行う規約)", () => {
    const vnode = RejectionBanner({
      rejection: {
        code: "insufficientResource",
        commandKind: "reclaimCell",
        commandIndex: 0,
        subjectId: null,
        cellIndex: 5,
        limit: null,
        actual: null,
        resourceId: id("firewood"),
        requiredRaw: 40_000_000,
        availableRaw: 10_000_000,
        ownerTask: null,
        message: "資源が不足しています(開発者向けの元文言)",
      },
    });
    expect(vnode.props["data-rejection-code"]).toBe("insufficientResource");
    // プレイヤー語化された文言(1e6 raw 値の生値ではなく人間可読の量)。
    expect(vnode.props.children).toBe("薪が足りません(必要 40 / 所持 10)。");
  });

  it("元の engine message は title と data-original-message に残す(デバッグ用)", () => {
    const originalMessage = '資源 "firewood" が不足(必要 40000000 / 在庫 10000000)';
    const vnode = RejectionBanner({
      rejection: {
        code: "insufficientResource",
        commandKind: "reclaimCell",
        commandIndex: 0,
        subjectId: null,
        cellIndex: 5,
        limit: null,
        actual: null,
        resourceId: id("firewood"),
        requiredRaw: 40_000_000,
        availableRaw: 10_000_000,
        ownerTask: null,
        message: originalMessage,
      },
    });
    expect(vnode.props.title).toBe(originalMessage);
    expect(vnode.props["data-original-message"]).toBe(originalMessage);
  });

  it("role=alert を持つ(スクリーンリーダーへ即時通知)", () => {
    const vnode = RejectionBanner({
      rejection: {
        code: "levelAtMax",
        commandKind: "upgradeFacility",
        commandIndex: 0,
        subjectId: id("facHearth1"),
        cellIndex: null,
        limit: 5,
        actual: 5,
        resourceId: null,
        requiredRaw: null,
        availableRaw: null,
        ownerTask: null,
        message: "既に上限Lvです",
      },
    });
    expect(vnode.props.role).toBe("alert");
    expect(vnode.props.children).toBe("この施設は既に Lv5 です(上限 Lv5)。");
  });

  it("未知の code(型システムをすり抜けた異常系)は元の message へフォールバックする", () => {
    const vnode = RejectionBanner({
      rejection: {
        // @ts-expect-error 意図的に語彙外の code を渡す(実行時の防御を確認する)
        code: "somethingNew",
        commandKind: null,
        commandIndex: 0,
        subjectId: null,
        cellIndex: null,
        limit: null,
        actual: null,
        resourceId: null,
        requiredRaw: null,
        availableRaw: null,
        ownerTask: null,
        message: "未知コードの元メッセージ",
      },
    });
    expect(vnode.props.children).toBe("未知コードの元メッセージ");
  });
});
