import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/engine/canonicalize";
import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

// ---------------------------------------------------------------------------
// content/*.json のダミーコンテンツ全ファイルが検証を通ることの確認
// (T6 指示書「ダミーcontent全ファイルが検証を通ること」)、および
// ロード時正準化パス(ADR-023(1))の配線確認。
// ---------------------------------------------------------------------------

function dummyBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

describe("validateContentBundle — ダミー content", () => {
  it("content/*.json 全ファイルが検証を通る", () => {
    const result = validateContentBundle(dummyBundle());
    if (!result.ok) {
      // 失敗時は原因を出力してデバッグしやすくする(schema reject 再試行コスト削減の実演)。
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
  });

  it("tech 3件・facility 3件・trait 2件がロードされる(規模の確認)", () => {
    const result = validateContentBundle(dummyBundle());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tech).toHaveLength(3);
      expect(result.value.facility).toHaveLength(3);
      expect(result.value.trait).toHaveLength(2);
    }
  });
});

describe("validateContentBundle — 不合格ケース", () => {
  it("カテゴリ間 ID 衝突を reject する(ADR-024(1))", () => {
    const bundle = dummyBundle();
    const clashing: RawContentBundle = {
      ...bundle,
      facility: [...bundle.facility, { ...(bundle.facility[0] as object), id: "techFireStarting" }],
    };
    const result = validateContentBundle(clashing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("techFireStarting"))).toBe(true);
    }
  });

  it("存在しない facility を参照する fieldRequirement を reject する", () => {
    const bundle = dummyBundle();
    const broken: RawContentBundle = {
      ...bundle,
      tech: [
        {
          id: "techGhost",
          era: "e1",
          lossClass: "criticalRecoverable",
          prereqs: [],
          researchCost: 30,
          fieldRequirement: { facility: "nonexistentFacility", recipe: "recipeX", count: 1 },
          unlocks: [],
          leaf: true,
        },
      ],
    };
    const result = validateContentBundle(broken);
    expect(result.ok).toBe(false);
  });

  it("prereqs の循環参照を reject する", () => {
    const bundle = dummyBundle();
    const cyclic: RawContentBundle = {
      ...bundle,
      tech: [
        {
          id: "techA",
          era: "e1",
          lossClass: "criticalRecoverable",
          prereqs: ["techB"],
          researchCost: 30,
          fieldRequirement: { facility: "hearth", recipe: "recipeX", count: 1 },
          unlocks: [],
          leaf: false,
        },
        {
          id: "techB",
          era: "e1",
          lossClass: "criticalRecoverable",
          prereqs: ["techA"],
          researchCost: 30,
          fieldRequirement: { facility: "hearth", recipe: "recipeY", count: 1 },
          unlocks: [],
          leaf: false,
        },
      ],
    };
    const result = validateContentBundle(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("循環参照"))).toBe(true);
    }
  });
});

describe("正準化パスの配線(ADR-023(1))", () => {
  it("canonicalizeJson は冪等(2回通しても1回と同じ)", () => {
    const once = canonicalizeJson(techJson[0]);
    const twice = canonicalizeJson(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("キー順序が異なる同値 JSON は canonicalizeJson で同一バイト列になる", () => {
    const reordered = {
      leaf: false,
      unlocks: ["techPottery", "techBasketWeaving"],
      fieldRequirement: { count: 3, recipe: "recipeKindling", facility: "hearth" },
      researchCost: 30,
      prereqs: [],
      lossClass: "criticalRecoverable",
      era: "e1",
      id: "techFireStarting",
    };
    const original = techJson[0];
    expect(JSON.stringify(canonicalizeJson(reordered))).toBe(
      JSON.stringify(canonicalizeJson(original)),
    );
  });

  it("content バンドル検証は正準化を経由する(非有限数値を reject)", () => {
    const bundle = dummyBundle();
    const withNaN: RawContentBundle = {
      ...bundle,
      balance: { ...(bundle.balance as object), fpScale: Number.NaN },
    };
    expect(() => validateContentBundle(withNaN)).toThrow();
  });
});
