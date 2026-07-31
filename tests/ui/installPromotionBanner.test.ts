// ---------------------------------------------------------------------------
// M34: `src/ui/InstallPromotionBanner.tsx` のテスト。
//
// hooks を持たない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(`tests/ui/screens/homeHub.test.ts` の UrgencyBadge と
// 同じ方針: JSX の既知の形をそのまま `.props.children[n]` で辿る)。固定するのは:
//   1. visible: false なら null(DOM に出さない)
//   2. canPromptDirectly の有無でネイティブボタンの有無が切り替わる(iOS 分岐)
//   3. ボタン押下でコールバックがそのまま呼ばれる(判定を持たない)
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { InstallPromotionBanner } from "../../src/ui/InstallPromotionBanner";

interface Btn {
  readonly type: "button";
  readonly props: { readonly onClick: () => void; readonly children: unknown };
}

/** actions div(root の 3 番目の子)の中身。canPromptDirectly のときだけ先頭にボタンが乗る。 */
function actionChildren(root: {
  readonly props: { readonly children: readonly unknown[] };
}): readonly (Btn | false)[] {
  const actionsDiv = root.props.children[2] as {
    readonly props: { readonly children: readonly (Btn | false)[] };
  };
  return actionsDiv.props.children;
}

describe("InstallPromotionBanner", () => {
  it("visible: false なら null を返す(DOM に出さない)", () => {
    const vnode = InstallPromotionBanner({
      visible: false,
      canPromptDirectly: true,
      onInstall: () => undefined,
      onClose: () => undefined,
    });
    expect(vnode).toBeNull();
  });

  it("canPromptDirectly: true ならネイティブ導線のボタンを持つ", () => {
    const onInstall = vi.fn();
    const vnode = InstallPromotionBanner({
      visible: true,
      canPromptDirectly: true,
      onInstall,
      onClose: () => undefined,
    })!;
    const [installButton, closeButton] = actionChildren(vnode);
    expect(installButton).not.toBe(false);
    expect(closeButton).not.toBe(false);
    (installButton as Btn).props.onClick();
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("canPromptDirectly: false(iOS 等)ならネイティブボタンは無い(閉じるのみ)", () => {
    const vnode = InstallPromotionBanner({
      visible: true,
      canPromptDirectly: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    })!;
    const [installButton, closeButton] = actionChildren(vnode);
    expect(installButton).toBe(false);
    expect(closeButton).not.toBe(false);
  });

  it("閉じるボタンで onClose が呼ばれる", () => {
    const onClose = vi.fn();
    const vnode = InstallPromotionBanner({
      visible: true,
      canPromptDirectly: false,
      onInstall: () => undefined,
      onClose,
    })!;
    const [, closeButton] = actionChildren(vnode);
    (closeButton as Btn).props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("role=region + aria-label を持つ(スクリーンリーダー対応)", () => {
    const vnode = InstallPromotionBanner({
      visible: true,
      canPromptDirectly: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    })!;
    expect(vnode.props.role).toBe("region");
    expect(vnode.props["aria-label"]).toBe("ホーム画面への追加");
  });

  it("テキストにタイトルと(iOS 向け)手順誘導を含む(色/API 有無だけに頼らない)", () => {
    const vnode = InstallPromotionBanner({
      visible: true,
      canPromptDirectly: false,
      onInstall: () => undefined,
      onClose: () => undefined,
    })!;
    const text = JSON.stringify(vnode);
    expect(text).toContain("ホーム画面に追加");
    expect(text).toContain("共有メニュー");
  });
});
