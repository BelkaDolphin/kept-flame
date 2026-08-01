import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import outpostTypeJson from "../../content/outpostType.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";
import { toRaw } from "../../src/engine/fp";
import { requireOutpostParams, requireOutpostTypeDef } from "../../src/engine/rules/types";
import type { EngineContent } from "../../src/engine/rules/types";
import { entityIdFromString } from "../../src/engine/state/state";

// ---------------------------------------------------------------------------
// [M24] outpostType / balance.outpost の content ローダー配線のテスト
// (schema/engineContent.ts §6f)。中心は 2 つ:
//   (1) 実 content(content/outpostType.json + content/balance.json の
//       outpost ブロック)が engine 内部表現へ正しく写る
//   (2) **省略時は M24 以前と 1 bit も違わない**(既存 golden vector 64 本を
//       生成する conformance/scenarios.ts の loadBaseRawContentBundle は
//       outpostType を読まないため、そちらは常にこの経路)
// ---------------------------------------------------------------------------

/** outpostType を持たない基本バンドル(他 engineContent*.test.ts と同一形)。 */
function baseRawBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

function rawBundle(): RawContentBundle {
  return { ...baseRawBundle(), outpostType: outpostTypeJson };
}

function load(bundle: RawContentBundle): EngineContent {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  }
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) {
    throw new Error(`ロードで落ちた: ${JSON.stringify(loaded.issues)}`);
  }
  return loaded.value;
}

const id = entityIdFromString;

describe("outpostType が engine 内部表現へ写る", () => {
  it("3 タイプすべてが outpostTypeDefs に載る", () => {
    const content = load(rawBundle());
    expect([...(content.outpostTypeDefs?.keys() ?? [])]).toEqual([
      "outpostFarm",
      "outpostForest",
      "outpostMine",
    ]);
  });

  it("outpostMine の値が 1e6 化されて写る", () => {
    const content = load(rawBundle());
    const mine = requireOutpostTypeDef(content, id("outpostMine"));
    expect(mine.resourceId).toBe("iron");
    expect(mine.supplyPerResidentTickByLevel.map((f) => toRaw(f))).toEqual([
      40_000_000, 46_000_000, 52_900_000, 60_835_000, 69_960_250,
    ]);
    expect(toRaw(mine.upkeep.baseFoodFix)).toBe(20_000_000);
    expect(toRaw(mine.upkeep.baseMoraleCareFix)).toBe(5_000_000);
    expect(toRaw(mine.hazard.intensityFix)).toBe(50_000);
    expect(toRaw(mine.hazard.growthPerDayFix)).toBe(10_000);
    expect(toRaw(mine.hazard.minFix)).toBe(50_000);
    expect(toRaw(mine.hazard.maxFix)).toBe(600_000);
    expect(toRaw(mine.shadeSensitivityFix)).toBe(800_000);
  });

  it("balance.outpost の距離帯係数が 3 帯とも写る", () => {
    const content = load(rawBundle());
    const params = requireOutpostParams(content);
    expect(toRaw(params.distanceBandUpkeepMulFix.near)).toBe(1_000_000);
    expect(toRaw(params.distanceBandUpkeepMulFix.far)).toBe(1_400_000);
    expect(toRaw(params.distanceBandUpkeepMulFix.deep)).toBe(1_800_000);
  });
});

describe("省略時は M24 以前と同一挙動", () => {
  it("outpostType キーを持たないバンドルでは outpostTypeDefs が空", () => {
    const content = load(baseRawBundle());
    expect(content.outpostTypeDefs?.size ?? 0).toBe(0);
    expect(() => requireOutpostTypeDef(content, id("outpostMine"))).toThrow();
  });

  it("balance.outpost が無ければ outpost ブロックが undefined になる", () => {
    const bundle = rawBundle();
    const balance = JSON.parse(JSON.stringify(balanceJson)) as Record<string, unknown>;
    delete balance["outpost"];
    const content = load({ ...bundle, balance });
    expect(content.outpost).toBeUndefined();
    expect(() => requireOutpostParams(content)).toThrow();
  });

  it("他カテゴリ(facility/tech)は outpostType 追加の影響を受けない", () => {
    const content = load(rawBundle());
    // [M58] facility 14 種(GDD 6.1)。
    expect([...content.facilityDefs.keys()]).toEqual([
      "bed",
      "charcoalKiln",
      "explorationHq",
      "forge",
      "foundry",
      "hearth",
      "infirmary",
      "kitchenGarden",
      "researchDesk",
      "scriptorium",
      "warehouse",
      "watchtower",
      "waterTank",
      "workbench",
    ]);
  });
});

describe("reject 系", () => {
  it("hazard.min > hazard.max の outpostType は検証段で reject される", () => {
    const bundle = rawBundle();
    const patched = [
      ...(JSON.parse(JSON.stringify(outpostTypeJson)) as (typeof outpostTypeJson)[number][]),
    ];
    const first = patched[0];
    if (first === undefined) throw new Error("outpostTypeJson が空");
    patched[0] = { ...first, hazard: { ...first.hazard, min: 0.9, max: 0.1 } };
    const validated = validateContentBundle({ ...bundle, outpostType: patched });
    expect(validated.ok).toBe(false);
  });

  it("outpostType の ID が facility 等と重複していればグローバル一意性違反", () => {
    const bundle = rawBundle();
    const patched = [
      ...(JSON.parse(JSON.stringify(outpostTypeJson)) as (typeof outpostTypeJson)[number][]),
    ];
    const first = patched[0];
    if (first === undefined) throw new Error("outpostTypeJson が空");
    patched[0] = { ...first, id: "hearth" };
    const validated = validateContentBundle({ ...bundle, outpostType: patched });
    expect(validated.ok).toBe(false);
    if (validated.ok) return;
    expect(validated.issues.some((issue) => issue.message.includes("グローバル一意"))).toBe(true);
  });
});
