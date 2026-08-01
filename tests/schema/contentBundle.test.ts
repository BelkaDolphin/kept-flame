import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/engine/canonicalize";
import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContentOrThrow } from "../../schema/engineContent";

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

  // [M6] tech は E1〜E3 の 24 本(GDD 5.2)へ additive 追加した。
  // [M7] trait は GDD 7.2 の MVP 8 種へ additive 追加した。
  // [M58] facility は GDD 6.1 の 14 種(かまど/貯水槽/菜園/寝床/作業台/炭焼き窯/
  // 製錬炉/鍛冶場/研究机/写字室/保管庫/見張り台/探索本部/療養所)が出揃った。
  it("tech 24件・facility 14件・trait 8件がロードされる(規模の確認)", () => {
    const result = validateContentBundle(dummyBundle());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tech).toHaveLength(24);
      expect(result.value.facility).toHaveLength(14);
      expect(result.value.trait).toHaveLength(8);
    }
  });
});

// ---------------------------------------------------------------------------
// [M58] 施設14種拡充の固定テスト。
//   要件:①GDD 6.1 の 14 種すべてがスキーマ valid で engine content(カタログ)へ
//        載る ②粘土・紙(GDD 11.3 の跨時代資源 / 11.1 の記録媒体コスト)に
//        本拠内で完結する入手経路(facility.output)が存在する。
// ---------------------------------------------------------------------------

describe("[M58] 施設14種(GDD 6.1)がカタログに載る", () => {
  const GDD_6_1_FACILITY_IDS = [
    "hearth",
    "waterTank",
    "kitchenGarden",
    "bed",
    "workbench",
    "charcoalKiln",
    "foundry",
    "forge",
    "researchDesk",
    "scriptorium",
    "warehouse",
    "watchtower",
    "explorationHq",
    "infirmary",
  ] as const;

  it("14種すべてが schema valid かつ engine content へロードされる", () => {
    const validated = validateContentBundle(dummyBundle());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const loaded = loadEngineContentOrThrow(validated.value);
    expect(loaded.facilityDefs.size).toBe(14);
    for (const facilityId of GDD_6_1_FACILITY_IDS) {
      expect(loaded.facilityDefs.has(facilityId as never)).toBe(true);
    }
  });

  it("粘土(clay)に本拠内の入手経路が存在する(貯水槽)", () => {
    const validated = validateContentBundle(dummyBundle());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const producers = validated.value.facility.filter(
      (f) => f.output?.kind === "resource" && f.output.resourceId === "clay",
    );
    expect(producers.map((f) => f.id)).toEqual(["waterTank"]);
  });

  it("紙(paper)に本拠内の入手経路が存在する(写字室)", () => {
    const validated = validateContentBundle(dummyBundle());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const producers = validated.value.facility.filter(
      (f) => f.output?.kind === "resource" && f.output.resourceId === "paper",
    );
    expect(producers.map((f) => f.id)).toEqual(["scriptorium"]);
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
      // [M10] techFireStarting.unlocks の stale 修正(GDD 12.1 [2026-07-29追補])に
      // 合わせて techStoneTools / techWaterDrawing を追加済み。
      unlocks: ["techPottery", "techBasketWeaving", "techStoneTools", "techWaterDrawing"],
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
