// ---------------------------------------------------------------------------
// M57: `src/ui/onboarding/steps.ts` の文言テスト。
//
// 検収条件「用語説明がGDDの定義と矛盾しないこと」と対になる、初回ガイド側の
// 機械検証: プレイヤー語彙のみ(内部ID・GDD番号・tick生値を出さない=束B/E/F
// の掃討基準)を満たしているかを固定する
// (`tests/ui/screens/gddNumberSweep.test.ts` の丸数字検査と同じ発想)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  ONBOARDING_FINISH_LABEL,
  ONBOARDING_NEXT_LABEL,
  ONBOARDING_SKIP_LABEL,
  ONBOARDING_STEPS,
} from "../../src/ui/onboarding/steps";

const CIRCLED_NUMBER_PATTERN = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬]/;
const GDD_NUMBER_PATTERN = /GDD\s*\d/i;

describe("ONBOARDING_STEPS", () => {
  it("数ステップ(3〜4枚)のカード列である(タスク指示のスコープ)", () => {
    expect(ONBOARDING_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(ONBOARDING_STEPS.length).toBeLessThanOrEqual(4);
  });

  it("各ステップが一意な id とタイトル・本文を持つ", () => {
    const ids = new Set(ONBOARDING_STEPS.map((step) => step.id));
    expect(ids.size).toBe(ONBOARDING_STEPS.length);
    for (const step of ONBOARDING_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it("中核フック「知識を書き残して火を継ぐ」の趣旨(GDD §2/§4.2/§7.4)を含む", () => {
    const allText = ONBOARDING_STEPS.map((step) => `${step.title}${step.body}`).join("");
    expect(allText).toContain("成文化");
    expect(allText).toContain("記憶");
  });

  it("プレイヤー語彙のみ(丸数字・GDD番号・内部IDを出さない)", () => {
    for (const step of ONBOARDING_STEPS) {
      const text = `${step.title}${step.body}`;
      expect(CIRCLED_NUMBER_PATTERN.test(text)).toBe(false);
      expect(GDD_NUMBER_PATTERN.test(text)).toBe(false);
    }
  });

  it("最終カードのボタン文言はスキップと明確に区別される", () => {
    expect(ONBOARDING_FINISH_LABEL).not.toBe(ONBOARDING_SKIP_LABEL);
    expect(ONBOARDING_FINISH_LABEL).not.toBe(ONBOARDING_NEXT_LABEL);
  });
});
