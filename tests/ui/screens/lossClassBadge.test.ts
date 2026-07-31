// ---------------------------------------------------------------------------
// src/ui/screens/LossClassBadge.tsx のテスト(束B/B-5)。
//
// hooks を使わない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで検証する(rejectionBanner.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { LossClassBadge } from "../../../src/ui/screens/LossClassBadge";

describe("LossClassBadge(束B/B-5: title属性で説明を添える)", () => {
  it("(A) criticalRecoverable: 再取得可能の説明を title に持つ", () => {
    const vnode = LossClassBadge({ lossClass: "criticalRecoverable" });
    expect(vnode.props.title).toContain("もう一度取得できます");
    expect(vnode.props["data-loss-class"]).toBe("criticalRecoverable");
  });

  it("(B) rareIrreversible: 取り返しがつかないことの説明を title に持つ", () => {
    const vnode = LossClassBadge({ lossClass: "rareIrreversible" });
    expect(vnode.props.title).toContain("二度と取り戻せません");
    expect(vnode.props["data-loss-class"]).toBe("rareIrreversible");
  });
});
