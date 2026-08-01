// ---------------------------------------------------------------------------
// M54: `src/ui/LoadFailureBanner.tsx` のテスト。
//
// hooks を持たない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(`installPromotionBanner.test.ts` と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { LoadFailureBanner } from "../../src/ui/LoadFailureBanner";

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

describe("LoadFailureBanner", () => {
  it("visible: false なら null を返す(DOM に出さない)", () => {
    const vnode = LoadFailureBanner({
      visible: false,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    });
    expect(vnode).toBeNull();
  });

  it("＋設定画面へのボタンを押すと onGoToSettings が呼ばれる", () => {
    const onGoToSettings = vi.fn();
    const vnode = LoadFailureBanner({
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
    const vnode = LoadFailureBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose,
    })!;
    const [, closeButton] = actionChildren(vnode);
    (closeButton as Btn).props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("role=alert(その場で気づかせる通知)+ aria-label を持つ", () => {
    const vnode = LoadFailureBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    })!;
    expect(vnode.props.role).toBe("alert");
    expect(vnode.props["aria-label"]).toBe("セーブの読み込みに失敗しました");
  });

  it("新規開始したことと復元導線を明記する(黙って何も起きない、を作らない)", () => {
    const vnode = LoadFailureBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    })!;
    const text = JSON.stringify(vnode);
    expect(text).toContain("読み込めませんでした");
    expect(text).toContain("インポート");
  });
});
