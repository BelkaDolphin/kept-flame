// ---------------------------------------------------------------------------
// M34: `src/ui/NotificationOptInBanner.tsx` のテスト。
//
// `InstallPromotionBanner.tsx` と同じ方針(hooks 無し・直接呼び出し)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { NotificationOptInBanner } from "../../src/ui/NotificationOptInBanner";

interface Btn {
  readonly type: "button";
  readonly props: { readonly onClick: () => void };
}

function actionButtons(vnode: {
  readonly props: { readonly children: readonly unknown[] };
}): readonly [Btn, Btn] {
  const actionsDiv = vnode.props.children[2] as {
    readonly props: { readonly children: readonly [Btn, Btn] };
  };
  return actionsDiv.props.children;
}

describe("NotificationOptInBanner", () => {
  it("visible: false なら null を返す(通知不可経路では何も描かない・GDD 13.3)", () => {
    const vnode = NotificationOptInBanner({
      visible: false,
      onRequestPermission: () => undefined,
      onClose: () => undefined,
    });
    expect(vnode).toBeNull();
  });

  it("visible: true なら許可要求ボタンと閉じるボタンを持つ", () => {
    const onRequestPermission = vi.fn();
    const onClose = vi.fn();
    const vnode = NotificationOptInBanner({ visible: true, onRequestPermission, onClose })!;
    const [primary, close] = actionButtons(vnode);
    primary.props.onClick();
    expect(onRequestPermission).toHaveBeenCalledTimes(1);
    close.props.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("role=region + aria-label を持つ", () => {
    const vnode = NotificationOptInBanner({
      visible: true,
      onRequestPermission: () => undefined,
      onClose: () => undefined,
    })!;
    expect(vnode.props.role).toBe("region");
    expect(vnode.props["aria-label"]).toBe("通知の許可");
  });

  it("許可しなくても既存導線(バッジ/ダイジェスト)で確認できる旨を明記する", () => {
    const vnode = NotificationOptInBanner({
      visible: true,
      onRequestPermission: () => undefined,
      onClose: () => undefined,
    })!;
    const text = JSON.stringify(vnode);
    expect(text).toContain("ホームハブのバッジ");
    expect(text).toContain("帰還ダイジェスト");
  });
});
