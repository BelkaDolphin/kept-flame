import { describe, expect, it } from "vitest";

import { checkGlobalIdUniqueness } from "../../schema/idRegistry";

// ---------------------------------------------------------------------------
// グローバル ID 一意性検証器(ADR-024(1))のテスト。
// entityStateById が単一 namespace(T4 state.ts)であることの裏付けとして、
// カテゴリ間衝突(シャドーイング)を確実に検出できることを確認する。
// ---------------------------------------------------------------------------

describe("checkGlobalIdUniqueness", () => {
  it("全カテゴリで ID が重複していなければ issue 無し", () => {
    const issues = checkGlobalIdUniqueness({
      tech: ["techFireStarting", "techPottery"],
      facility: ["hearth", "forge"],
      trait: ["traitScholar"],
    });
    expect(issues).toHaveLength(0);
  });

  it("カテゴリを跨いだ ID 衝突を検出する", () => {
    const issues = checkGlobalIdUniqueness({
      tech: ["sharedId"],
      facility: ["sharedId"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("sharedId");
  });

  it("同一カテゴリ内の重複も検出する(additive diff すり抜けの保険)", () => {
    const issues = checkGlobalIdUniqueness({
      tech: ["techA", "techA"],
    });
    expect(issues).toHaveLength(1);
  });

  it("空のカテゴリ集合では issue 無し", () => {
    const issues = checkGlobalIdUniqueness({});
    expect(issues).toHaveLength(0);
  });

  it("3カテゴリ以上に跨る衝突を全て検出する", () => {
    const issues = checkGlobalIdUniqueness({
      tech: ["x"],
      facility: ["x"],
      trait: ["x"],
    });
    // 最初に見つかったカテゴリ(アルファベット順: facility)を正とし、
    // 残り2カテゴリ分(tech, trait)を衝突として報告する。
    expect(issues).toHaveLength(2);
  });
});
