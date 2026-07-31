// ---------------------------------------------------------------------------
// src/ui/screens/RejectionBanner.tsx のテスト(M30)。
//
// ②③④共通のコマンド拒否表示。hooks を使わない純関数コンポーネントなので、
// Preact の render() を通さず直接呼んで検証する(gridBoard.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import { RejectionBanner } from "../../../src/ui/screens/RejectionBanner";

const id = entityIdFromString;

describe("RejectionBanner(コマンド拒否の表示・commands.ts §2/§3)", () => {
  it("message を表示し、code を data 属性に持つ(分岐は code 側で行う規約)", () => {
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
        message: "資源が不足しています",
      },
    });
    expect(vnode.props["data-rejection-code"]).toBe("insufficientResource");
    expect(vnode.props.children).toBe("資源が不足しています");
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
  });
});
