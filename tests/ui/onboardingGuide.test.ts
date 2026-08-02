// ---------------------------------------------------------------------------
// M57: `src/ui/onboarding/OnboardingGuide.tsx` のテスト。
//
// hooks を持たない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(`installPromotionBanner.test.ts`/`backupReminderBanner.test.ts`
// と同じ方針)。ボタンの位置に依存しないよう、vnode ツリーを再帰的に走査して
// type="button" の要素を集める汎用ヘルパを使う
// (`tests/ui/screens/settingsScreen.test.ts` の `flattenText` と同じ発想)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { OnboardingGuide } from "../../src/ui/onboarding/OnboardingGuide";
import { ONBOARDING_STEPS } from "../../src/ui/onboarding/steps";

interface Vnode {
  readonly type?: unknown;
  readonly props?: {
    readonly children?: unknown;
    readonly onClick?: () => void;
    readonly [key: string]: unknown;
  };
}

interface ButtonNode {
  readonly text: string;
  readonly onClick: () => void;
}

function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const vnode = node as Vnode;
  return flattenText(vnode.props?.children);
}

/** vnode ツリーを再帰的に走査し、`<button>` 要素を出現順に集める。 */
function collectButtons(node: unknown): ButtonNode[] {
  if (Array.isArray(node)) return node.flatMap(collectButtons);
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  const vnode = node as Vnode;
  if (vnode.type === "button") {
    return [{ text: flattenText(vnode.props?.children), onClick: vnode.props!.onClick! }];
  }
  return collectButtons(vnode.props?.children);
}

function render(overrides: Partial<Parameters<typeof OnboardingGuide>[0]> = {}) {
  return OnboardingGuide({
    visible: true,
    stepIndex: 0,
    onNext: () => undefined,
    onSkip: () => undefined,
    onFinish: () => undefined,
    ...overrides,
  });
}

describe("OnboardingGuide", () => {
  it("visible: false なら null を返す(DOM に出さない)", () => {
    expect(render({ visible: false })).toBeNull();
  });

  it("role=dialog + aria-modal を持つ(スクリーンリーダー対応)", () => {
    const vnode = render()!;
    expect(vnode.props.role).toBe("dialog");
    expect(vnode.props["aria-modal"]).toBe("true");
  });

  it("stepIndex に応じたカードのタイトル・本文を表示する", () => {
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      const vnode = render({ stepIndex: i })!;
      const text = flattenText(vnode);
      expect(text).toContain(ONBOARDING_STEPS[i]!.title);
      expect(text).toContain(ONBOARDING_STEPS[i]!.body);
    }
  });

  it("最終カードより前では「次へ」ボタンがあり、押すと onNext が呼ばれる(「はじめる」は出ない)", () => {
    const onNext = vi.fn();
    const vnode = render({ stepIndex: 0, onNext })!;
    const buttons = collectButtons(vnode);
    const next = buttons.find((b) => b.text === "次へ");
    expect(next).toBeDefined();
    next!.onClick();
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(buttons.some((b) => b.text === "はじめる")).toBe(false);
  });

  it("最終カードでは「はじめる」ボタンがあり、押すと onFinish が呼ばれる(「次へ」は出ない)", () => {
    const onFinish = vi.fn();
    const lastIndex = ONBOARDING_STEPS.length - 1;
    const vnode = render({ stepIndex: lastIndex, onFinish })!;
    const buttons = collectButtons(vnode);
    const finish = buttons.find((b) => b.text === "はじめる");
    expect(finish).toBeDefined();
    finish!.onClick();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(buttons.some((b) => b.text === "次へ")).toBe(false);
  });

  it("どのカードでも「スキップ」ボタンがあり、押すと onSkip が呼ばれる", () => {
    const onSkip = vi.fn();
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      const vnode = render({ stepIndex: i, onSkip })!;
      const skip = collectButtons(vnode).find((b) => b.text === "スキップ");
      expect(skip).toBeDefined();
      skip!.onClick();
    }
    expect(onSkip).toHaveBeenCalledTimes(ONBOARDING_STEPS.length);
  });

  it("範囲外の stepIndex は clamp される(呼び出し側のバグでも例外を投げない)", () => {
    expect(() => render({ stepIndex: -1 })).not.toThrow();
    expect(() => render({ stepIndex: 999 })).not.toThrow();
    const overflow = render({ stepIndex: 999 })!;
    expect(flattenText(overflow)).toContain(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!.title);
  });

  it("進捗表示(N / 総数)を含む", () => {
    const vnode = render({ stepIndex: 1 })!;
    const text = flattenText(vnode);
    expect(text).toContain(`2 / ${String(ONBOARDING_STEPS.length)}`);
  });
});
