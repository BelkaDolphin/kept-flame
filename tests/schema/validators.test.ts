import { describe, expect, it } from "vitest";

import { validateAdjacency } from "../../schema/adjacency";
import { validateBalance } from "../../schema/balance";
import { validateFacility } from "../../schema/facility";
import { validateTech } from "../../schema/tech";
import { validateTrait } from "../../schema/trait";

// ---------------------------------------------------------------------------
// 各カテゴリのスキーマ検証器(schema/*.ts)の合格/不合格ケース。
//
// 「1エンティティに複数欠陥があっても issues を集めて返す」設計(common.ts)
// の確認も兼ねて、各カテゴリで代表的な不合格パターンを複数試す:
//   - id フォーマット違反(ADR-011)
//   - enum 違反
//   - レンジ外の数値
//   - 構造欠落(必須フィールド無し)
// ---------------------------------------------------------------------------

describe("validateTech", () => {
  const validTech = {
    id: "techFireStarting",
    era: "e1",
    lossClass: "criticalRecoverable",
    prereqs: [],
    researchCost: 30,
    fieldRequirement: { facility: "hearth", recipe: "recipeKindling", count: 3 },
    unlocks: ["techPottery"],
    leaf: false,
  };

  it("有効な tech を受理する", () => {
    const result = validateTech(validTech);
    expect(result.ok).toBe(true);
  });

  it("id が ADR-011 の正規表現に違反すると reject する", () => {
    const result = validateTech({ ...validTech, id: "Tech_Fire" });
    expect(result.ok).toBe(false);
  });

  it("lossClass が enum 外だと reject する", () => {
    const result = validateTech({ ...validTech, lossClass: "permanent" });
    expect(result.ok).toBe(false);
  });

  it("prereqs が4個以上だと reject する(GDD 5.1: 最大3個)", () => {
    const result = validateTech({
      ...validTech,
      prereqs: ["techA", "techB", "techC", "techD"],
    });
    expect(result.ok).toBe(false);
  });

  it("自己参照 prereq を reject する", () => {
    const result = validateTech({ ...validTech, prereqs: ["techFireStarting"] });
    expect(result.ok).toBe(false);
  });

  it("researchCost が0以下だと reject する", () => {
    const result = validateTech({ ...validTech, researchCost: 0 });
    expect(result.ok).toBe(false);
  });

  it("fieldRequirement 欠落を reject する", () => {
    const withoutFieldRequirement = {
      id: validTech.id,
      era: validTech.era,
      lossClass: validTech.lossClass,
      prereqs: validTech.prereqs,
      researchCost: validTech.researchCost,
      unlocks: validTech.unlocks,
      leaf: validTech.leaf,
    };
    const result = validateTech(withoutFieldRequirement);
    expect(result.ok).toBe(false);
  });
});

describe("validateFacility", () => {
  const validFacility = {
    id: "hearth",
    tags: ["heat"],
    slots: { lv1: 1, lv2: 1, lv3: 2, lv4: 2, lv5: 3 },
    lvCurve: [100, 115, 132.25, 152.0875, 174.900625],
    overflowCapPolicy: "convertToWaste",
    footprint: { width: 1, height: 1 },
  };

  it("有効な facility を受理する", () => {
    const result = validateFacility(validFacility);
    expect(result.ok).toBe(true);
  });

  it("未知タグを reject する", () => {
    const result = validateFacility({ ...validFacility, tags: ["fire"] });
    expect(result.ok).toBe(false);
  });

  it("タグの重複を reject する", () => {
    const result = validateFacility({ ...validFacility, tags: ["heat", "heat"] });
    expect(result.ok).toBe(false);
  });

  it("lvCurve が長さ5でないと reject する", () => {
    const result = validateFacility({ ...validFacility, lvCurve: [100, 115] });
    expect(result.ok).toBe(false);
  });

  it("lvCurve が単調増加でないと reject する", () => {
    const result = validateFacility({ ...validFacility, lvCurve: [100, 90, 132, 152, 174] });
    expect(result.ok).toBe(false);
  });

  it("slots がLvにつれ減少すると reject する(GDD 7.7)", () => {
    const result = validateFacility({
      ...validFacility,
      slots: { lv1: 3, lv2: 2, lv3: 2, lv4: 2, lv5: 3 },
    });
    expect(result.ok).toBe(false);
  });

  it("footprint が範囲外だと reject する", () => {
    const result = validateFacility({ ...validFacility, footprint: { width: 3, height: 1 } });
    expect(result.ok).toBe(false);
  });
});

describe("validateTrait", () => {
  const validTrait = {
    id: "traitScholar",
    effects: [{ stat: "researchSpeed", op: "mul", value: 1.3 }],
    stackRule: "multiplicative",
    maxPerResident: 3,
  };

  it("有効な trait を受理する", () => {
    const result = validateTrait(validTrait);
    expect(result.ok).toBe(true);
  });

  it("maxPerResident が3以外だと reject する(GDD 7.2固定)", () => {
    const result = validateTrait({ ...validTrait, maxPerResident: 4 });
    expect(result.ok).toBe(false);
  });

  it("mul の value がレンジ外だと reject する", () => {
    const result = validateTrait({
      ...validTrait,
      effects: [{ stat: "researchSpeed", op: "mul", value: 5.0 }],
    });
    expect(result.ok).toBe(false);
  });

  it("op が enum 外だと reject する", () => {
    const result = validateTrait({
      ...validTrait,
      effects: [{ stat: "researchSpeed", op: "divide", value: 1.3 }],
    });
    expect(result.ok).toBe(false);
  });

  it("effects が空だと reject する", () => {
    const result = validateTrait({ ...validTrait, effects: [] });
    expect(result.ok).toBe(false);
  });
});

describe("validateAdjacency", () => {
  const validAdjacency = {
    schemaVersion: 1,
    tagMatrix: {
      "heat|heat": { effect: "forgeYield", target: "forge", valueFP: 0.2 },
    },
    overcrowd: { threshold: 3, penaltyPerExcessFP: -0.1, clampFP: 0.6 },
    seedOffsetRange: { min: -0.2, max: 0.2 },
  };

  it("有効な adjacency を受理する", () => {
    const result = validateAdjacency(validAdjacency);
    expect(result.ok).toBe(true);
  });

  it("タグペアキーの逆順(非正準形)を reject する", () => {
    // "clean" < "heat"(辞書順)が正準形。逆順の "heat|clean" は reject する。
    const result = validateAdjacency({
      ...validAdjacency,
      tagMatrix: { "heat|clean": { effect: "x", target: "y", valueFP: 0.1 } },
    });
    expect(result.ok).toBe(false);
  });

  it("未知タグを含むキーを reject する", () => {
    const result = validateAdjacency({
      ...validAdjacency,
      tagMatrix: { "fire|heat": { effect: "x", target: "y", valueFP: 0.1 } },
    });
    expect(result.ok).toBe(false);
  });

  it("seedOffsetRange の min > max を reject する", () => {
    const result = validateAdjacency({
      ...validAdjacency,
      seedOffsetRange: { min: 0.5, max: -0.5 },
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateBalance", () => {
  const validBalance = {
    fpScale: 1_000_000,
    algoVersion: 1,
    coarseTickMinutes: 10,
    offlineClampTick: 4320,
    safetyFactor: 1.5,
    recallRiskParams: {
      base_p: 0.05,
      p_max: 0.35,
      loadWHarsh: 2.0,
      loadWNormal: 0.5,
      moraleThresholdMid: 30,
      moraleBonusMid: 0.1,
      moraleThresholdLow: 15,
      moraleBonusLow: 0.2,
      dispatchW: 0.15,
      masteryResistMax: 0.2,
      memoryKeeperResist: -0.15,
    },
  };

  it("有効な balance を受理する", () => {
    const result = validateBalance(validBalance);
    expect(result.ok).toBe(true);
  });

  it("fpScale が1e6以外だと reject する(ADR-006固定)", () => {
    const result = validateBalance({ ...validBalance, fpScale: 100 });
    expect(result.ok).toBe(false);
  });

  it("safetyFactor が1.5以外だと reject する(GDD 11.3統一)", () => {
    const result = validateBalance({ ...validBalance, safetyFactor: 1.2 });
    expect(result.ok).toBe(false);
  });

  it("base_p > p_max を reject する", () => {
    const result = validateBalance({
      ...validBalance,
      recallRiskParams: { ...validBalance.recallRiskParams, base_p: 0.5, p_max: 0.35 },
    });
    expect(result.ok).toBe(false);
  });

  it("moraleBonusLow < moraleBonusMid を reject する(士気が低いほど加算が大きい前提)", () => {
    const result = validateBalance({
      ...validBalance,
      recallRiskParams: { ...validBalance.recallRiskParams, moraleBonusLow: 0.05 },
    });
    expect(result.ok).toBe(false);
  });
});
