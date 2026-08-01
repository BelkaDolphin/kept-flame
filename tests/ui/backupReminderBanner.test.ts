// ---------------------------------------------------------------------------
// M54: `src/ui/BackupReminderBanner.tsx` のテスト。
//
// hooks を持たない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(`installPromotionBanner.test.ts` と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { BackupReminderBanner } from "../../src/ui/BackupReminderBanner";

interface Btn {
  readonly type: "button";
  readonly props: { readonly onClick: () => void; readonly children: unknown };
}

function actionChildren(root: {
  readonly props: { readonly children: readonly unknown[] };
}): readonly Btn[] {
  const actionsDiv = root.props.children[2] as {
    readonly props: { readonly children: readonly Btn[] };
  };
  return actionsDiv.props.children;
}

describe("BackupReminderBanner", () => {
  it("visible: false なら null を返す(DOM に出さない)", () => {
    const vnode = BackupReminderBanner({
      visible: false,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    });
    expect(vnode).toBeNull();
  });

  it("＋設定画面へのボタンを押すと onGoToSettings が呼ばれる", () => {
    const onGoToSettings = vi.fn();
    const vnode = BackupReminderBanner({
      visible: true,
      onGoToSettings,
      onClose: () => undefined,
    })!;
    const [settingsButton] = actionChildren(vnode);
    (settingsButton as Btn).props.onClick();
    expect(onGoToSettings).toHaveBeenCalledTimes(1);
  });

  it("閉じるボタンで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    const vnode = BackupReminderBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose,
    })!;
    const [, closeButton] = actionChildren(vnode);
    (closeButton as Btn).props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("role=region + aria-label を持つ(スクリーンリーダー対応)", () => {
    const vnode = BackupReminderBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    })!;
    expect(vnode.props.role).toBe("region");
    expect(vnode.props["aria-label"]).toBe("バックアップのお願い");
  });

  it("エクスポート導線への案内文を含む", () => {
    const vnode = BackupReminderBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    })!;
    const text = JSON.stringify(vnode);
    expect(text).toContain("バックアップ");
    expect(text).toContain("設定画面");
  });
});
