// ---------------------------------------------------------------------------
// M16: content の `facility.footprint` → engine の `FacilityDef.footprint` 写像の
// テスト(`schema/engineContent.ts`)。
//
// 固定するのは 3 点:
//   (1) 実 content の footprint がそのまま engine 内部表現へ写ること
//       (現 content は 1×1 が 2 件・2×1 が 1 件 = 大型施設が既に居る)
//   (2) **engine の `FOOTPRINT_DIM_MAX` と schema の値域が食い違わないこと**
//       — engine は schema を import できないので定義が 2 箇所にある(ADJACENCY_TAGS と
//       FACILITY_TAGS と同じ構造)。突き合わせる場所はここ 1 箇所だけである。
//   (3) 値域外(3×3 等)の footprint は content ロード段階で reject されること
//       = engine の配置コマンドへ表現不能な形が届かないこと
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";
import { FOOTPRINT_DIM_MAX, isValidFootprintDims } from "../../src/engine/footprint";
import { entityIdFromString } from "../../src/engine/state/state";
import type { EngineContent } from "../../src/engine/rules/types";

function rawBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

/** footprint を差し替えた facility content を持つバンドル。 */
function withFootprint(footprint: unknown): RawContentBundle {
  const bundle = rawBundle();
  const facilities = clone(bundle.facility) as Record<string, unknown>[];
  const first = facilities[0];
  if (first === undefined) throw new Error("facility content が空");
  first["footprint"] = footprint;
  return { ...bundle, facility: facilities };
}

function isRejected(bundle: RawContentBundle): boolean {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) return true;
  return !loadEngineContent(validated.value).ok;
}

describe("facility.footprint → FacilityDef.footprint", () => {
  const content = load(rawBundle());

  it("実 content の footprint がそのまま写る(forge は 2×1 の大型施設)", () => {
    expect(content.facilityDefs.get(entityIdFromString("hearth"))?.footprint).toEqual({
      width: 1,
      height: 1,
    });
    expect(content.facilityDefs.get(entityIdFromString("forge"))?.footprint).toEqual({
      width: 2,
      height: 1,
    });
    expect(content.facilityDefs.get(entityIdFromString("workbench"))?.footprint).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("全 facility 定義の footprint が engine の値域に収まる(定義 2 箇所の突き合わせ)", () => {
    expect(content.facilityDefs.size).toBeGreaterThan(0);
    for (const def of content.facilityDefs.values()) {
      const footprint = def.footprint;
      if (footprint === undefined) throw new Error(`${def.id}: 実 content は footprint 必須`);
      expect(isValidFootprintDims(footprint)).toBe(true);
    }
  });

  it("engine の上限は GDD 6.1 の 2(2×1 / 2×2 まで)", () => {
    expect(FOOTPRINT_DIM_MAX).toBe(2);
  });

  it("1〜2 の組み合わせはすべて通る(1×2 の縦長も content 側で表現可能)", () => {
    for (const footprint of [
      { width: 1, height: 1 },
      { width: 2, height: 1 },
      { width: 1, height: 2 },
      { width: 2, height: 2 },
    ]) {
      expect(isRejected(withFootprint(footprint))).toBe(false);
      expect(
        load(withFootprint(footprint)).facilityDefs.get(entityIdFromString("hearth"))?.footprint,
      ).toEqual(footprint);
    }
  });

  it("engine が表現できない footprint は content ロードで reject される", () => {
    for (const footprint of [
      { width: 3, height: 1 },
      { width: 1, height: 3 },
      { width: 0, height: 1 },
      { width: 1.5, height: 1 },
      { width: 2 },
      null,
      "2x2",
    ]) {
      expect(isRejected(withFootprint(footprint))).toBe(true);
    }
  });
});
