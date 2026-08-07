import { describe, expect, it } from "vitest";

import outpostTypeJson from "../../content/outpostType.json";
import { validateOutpostType } from "../../schema/outpostType";

// ---------------------------------------------------------------------------
// [M24] outpostType content スキーマ(GDD 9.2 / 12.1)のテスト。
// ---------------------------------------------------------------------------

function validContent(): Record<string, unknown> {
  return {
    id: "outpostMineTest",
    resource: "iron",
    baseSupply: 40,
    capacityCurve: [40, 46, 52.9, 60.835, 69.96025],
    upkeepFormula: { baseFood: 20, baseMoraleCare: 5 },
    hazard: { intensity: 0.05, growth: 0.01, min: 0.05, max: 0.6 },
    shadeSensitivity: 0.8,
  };
}

describe("validateOutpostType — 正常系", () => {
  it("ダミー outpostType が通る", () => {
    const result = validateOutpostType(validContent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("outpostMineTest");
    expect(result.value.resource).toBe("iron");
    expect(result.value.capacityCurve).toEqual([40, 46, 52.9, 60.835, 69.96025]);
  });

  it("実 content/outpostType.json の 3 件が全て通る", () => {
    expect(outpostTypeJson.length).toBe(3);
    for (const raw of outpostTypeJson) {
      const result = validateOutpostType(raw);
      expect(result.ok, JSON.stringify("issues" in result ? result.issues : [])).toBe(true);
    }
  });
});

describe("validateOutpostType — reject 系", () => {
  it("id 欠落は reject", () => {
    const raw = validContent();
    delete raw["id"];
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("resource 欠落は reject", () => {
    const raw = validContent();
    delete raw["resource"];
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("capacityCurve の長さが 5 でなければ reject", () => {
    const raw = validContent();
    raw["capacityCurve"] = [40, 46, 52.9, 60.835];
    const result = validateOutpostType(raw);
    expect(result.ok).toBe(false);
  });

  it("capacityCurve が単調増加でなければ reject", () => {
    const raw = validContent();
    raw["capacityCurve"] = [40, 46, 46, 60.835, 69.96025];
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("capacityCurve[0] が baseSupply と一致しなければ reject(二重の真実の防止)", () => {
    const raw = validContent();
    raw["baseSupply"] = 41;
    const result = validateOutpostType(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "$.capacityCurve[0]")).toBe(true);
  });

  it("hazard.min が hazard.max を超えていれば reject", () => {
    const raw = validContent();
    raw["hazard"] = { intensity: 0.5, growth: 0.01, min: 0.7, max: 0.6 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("hazard.intensity が [min, max] の外なら reject", () => {
    const raw = validContent();
    raw["hazard"] = { intensity: 0.9, growth: 0.01, min: 0.05, max: 0.6 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("hazard.min が範囲 [0,1] の外なら reject", () => {
    const raw = validContent();
    raw["hazard"] = { intensity: 0.05, growth: 0.01, min: -0.1, max: 0.6 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("upkeepFormula の値が負なら reject", () => {
    const raw = validContent();
    raw["upkeepFormula"] = { baseFood: -1, baseMoraleCare: 5 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("shadeSensitivity が範囲外なら reject", () => {
    const raw = validContent();
    raw["shadeSensitivity"] = -1;
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("baseSupply が 0 以下なら reject", () => {
    const raw = validContent();
    raw["baseSupply"] = 0;
    raw["capacityCurve"] = [0, 46, 52.9, 60.835, 69.96025];
    expect(validateOutpostType(raw).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [M75] buildCost(GDD 9.2 [2026-08-07裁定]・schema/outpostType.ts 冒頭 [M75])
// ---------------------------------------------------------------------------

describe("validateOutpostType — [M75] buildCost", () => {
  it("省略時は null(設置無料 = M74 以前と同一挙動)", () => {
    const result = validateOutpostType(validContent());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toBeNull();
  });

  it("単一オブジェクト形が通る", () => {
    const raw = validContent();
    raw["buildCost"] = { resourceId: "firewood", amount: 36 };
    const result = validateOutpostType(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toEqual({ resourceId: "firewood", amount: 36 });
  });

  it("配列形(複数資源)が通る", () => {
    const raw = validContent();
    raw["buildCost"] = [
      { resourceId: "firewood", amount: 45 },
      { resourceId: "iron", amount: 12 },
    ];
    const result = validateOutpostType(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toEqual([
      { resourceId: "firewood", amount: 45 },
      { resourceId: "iron", amount: 12 },
    ]);
  });

  it("空配列は reject(無料と区別できない)", () => {
    const raw = validContent();
    raw["buildCost"] = [];
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("同じ資源が 2 行あれば reject", () => {
    const raw = validContent();
    raw["buildCost"] = [
      { resourceId: "firewood", amount: 10 },
      { resourceId: "firewood", amount: 20 },
    ];
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("amount が負なら reject", () => {
    const raw = validContent();
    raw["buildCost"] = { resourceId: "firewood", amount: -1 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("resourceId 欠落は reject", () => {
    const raw = validContent();
    raw["buildCost"] = { amount: 10 };
    expect(validateOutpostType(raw).ok).toBe(false);
  });

  it("実 content の 3 タイプは全て buildCost を持つ", () => {
    for (const rawType of outpostTypeJson) {
      const result = validateOutpostType(rawType);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.buildCost).not.toBeNull();
    }
  });
});
