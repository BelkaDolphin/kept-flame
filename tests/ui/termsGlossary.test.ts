// ---------------------------------------------------------------------------
// M57: `src/ui/onboarding/TermsGlossary.tsx` のテスト。
//
// hooks を持たない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(`onboardingGuide.test.ts` と同じ方針・同じヘルパ形)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { GLOSSARY_TERMS } from "../../src/ui/onboarding/glossaryTerms";
import { TermsGlossary } from "../../src/ui/onboarding/TermsGlossary";

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

describe("TermsGlossary", () => {
  it("visible: false なら null を返す(DOM に出さない)", () => {
    expect(TermsGlossary({ visible: false, onClose: () => undefined })).toBeNull();
  });

  it("role=dialog + aria-modal を持つ(スクリーンリーダー対応)", () => {
    const vnode = TermsGlossary({ visible: true, onClose: () => undefined })!;
    expect(vnode.props.role).toBe("dialog");
    expect(vnode.props["aria-modal"]).toBe("true");
    expect(vnode.props["aria-label"]).toBe("用語ミニ辞典");
  });

  it("収録した10語すべての用語と定義を表示する", () => {
    const vnode = TermsGlossary({ visible: true, onClose: () => undefined })!;
    const text = flattenText(vnode);
    for (const entry of GLOSSARY_TERMS) {
      expect(text).toContain(entry.term);
      expect(text).toContain(entry.definition);
    }
  });

  it("閉じるボタンを押すと onClose が呼ばれる", () => {
    const onClose = vi.fn();
    const vnode = TermsGlossary({ visible: true, onClose })!;
    const closeButton = collectButtons(vnode).find((b) => b.text === "閉じる");
    expect(closeButton).toBeDefined();
    closeButton!.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
