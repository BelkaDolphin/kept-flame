import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import {
  TRAIT_YIELD_MUL_STAT_KEY,
  UNREPRESENTABLE_CONTENT_TRAIT_STATS,
  loadEngineContent,
} from "../../schema/engineContent";
import { toRaw } from "../../src/engine/fp";
import { RESIDENT_STAT_IDS } from "../../src/engine/rules/stats";
import type { EngineContent } from "../../src/engine/rules/types";

// ---------------------------------------------------------------------------
// M5 でローダーへ足した 3 つの写像のテスト:
//   (a) trait 効果       — 未実装は「記録して読み飛ばす」/ 未知は reject(§1(e))
//   (b) facility の statWeights — 総和 1.0 の強制(中立性の根拠)
//   (c) balance.storage  — GDD 6.7 のパラメータ
// ---------------------------------------------------------------------------

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

/** 検証 → ロードを通し、成功なら EngineContent を返す。 */
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

/** 検証 or ロードで出た issue の path 一覧(どちらで落ちても拾う)。 */
function issuePaths(bundle: RawContentBundle): readonly string[] {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) return validated.issues.map((issue) => issue.path);
  const loaded = loadEngineContent(validated.value);
  return loaded.ok ? [] : loaded.issues.map((issue) => issue.path);
}

function withTraits(effects: readonly unknown[]): RawContentBundle {
  const bundle = rawBundle();
  return {
    ...bundle,
    trait: [
      ...(clone(bundle.trait) as unknown[]),
      { id: "traitProbe", effects, stackRule: "multiplicative", maxPerResident: 3 },
    ],
  };
}

function withFacilityPatch(patch: Record<string, unknown>): RawContentBundle {
  const bundle = rawBundle();
  return {
    ...bundle,
    facility: (clone(bundle.facility) as Record<string, unknown>[]).map((f) =>
      f["id"] === "hearth" ? { ...f, ...patch } : f,
    ),
  };
}

describe("(a) trait 効果の写像(§1(e))", () => {
  it("ダミー content の trait が読める(未実装効果は記録して読み飛ばす)", () => {
    const content = load(rawBundle());
    expect([...(content.traitDefs?.keys() ?? [])]).toEqual(["traitFrail", "traitScholar"]);
    // content/trait.json は researchSpeed(学者)と health(病弱)を使っている。
    expect(content.unrepresentedTraitEffects).toEqual(["health", "researchSpeed"]);
  });

  it("未実装効果しか持たない trait は生産に一切影響しない", () => {
    const content = load(rawBundle());
    const scholar = content.traitDefs?.get("traitScholar" as never);
    expect(scholar).toBeDefined();
    expect(scholar?.statAddFixById.size).toBe(0);
    expect(scholar?.statMulFixById.size).toBe(0);
    expect(toRaw(scholar?.yieldMulFix ?? (0 as never))).toBe(1_000_000);
  });

  it("ステータス 5 種(裁定 B8)への効果は写る", () => {
    const content = load(
      withTraits([
        { stat: "vigor", op: "add", value: 10 },
        { stat: "vigor", op: "mul", value: 1.2 },
      ]),
    );
    const probe = content.traitDefs?.get("traitProbe" as never);
    expect(toRaw(probe?.statAddFixById.get("vigor") ?? (0 as never))).toBe(10_000_000);
    expect(toRaw(probe?.statMulFixById.get("vigor") ?? (0 as never))).toBe(1_200_000);
  });

  it(`予約語 ${TRAIT_YIELD_MUL_STAT_KEY} は GDD 11.1 の trait 倍率項として写る`, () => {
    const content = load(withTraits([{ stat: TRAIT_YIELD_MUL_STAT_KEY, op: "mul", value: 1.25 }]));
    expect(toRaw(content.traitDefs?.get("traitProbe" as never)?.yieldMulFix ?? (0 as never))).toBe(
      1_250_000,
    );
  });

  it(`${TRAIT_YIELD_MUL_STAT_KEY} に op="add" は reject`, () => {
    const paths = issuePaths(
      withTraits([{ stat: TRAIT_YIELD_MUL_STAT_KEY, op: "add", value: 10 }]),
    );
    expect(paths).toContain("trait.traitProbe.effects[0].op");
  });

  it("未知の stat キー(タイポ等)は reject する", () => {
    const paths = issuePaths(withTraits([{ stat: "vigour", op: "add", value: 10 }]));
    expect(paths).toContain("trait.traitProbe.effects[0].stat");
  });

  it("未実装として読み飛ばすキーはレジストリに載っているものだけ", () => {
    for (const stat of Object.keys(UNREPRESENTABLE_CONTENT_TRAIT_STATS)) {
      expect(RESIDENT_STAT_IDS as readonly string[]).not.toContain(stat);
      expect(stat).not.toBe(TRAIT_YIELD_MUL_STAT_KEY);
    }
    const content = load(withTraits([{ stat: "codifySpeed", op: "mul", value: 1.4 }]));
    expect(content.unrepresentedTraitEffects).toContain("codifySpeed");
  });
});

describe("(b) facility.statWeights の総和 1.0 強制", () => {
  it("総和 1.0 なら写る", () => {
    const content = load(
      withFacilityPatch({
        statWeights: { vigor: 0.5, dexterity: 0.5, intellect: 0, fortitude: 0, will: 0 },
      }),
    );
    const hearth = content.facilityDefs.get("hearth" as never);
    expect(toRaw(hearth?.statWeights?.vigor ?? (0 as never))).toBe(500_000);
    expect(toRaw(hearth?.statWeights?.will ?? (1 as never))).toBe(0);
  });

  it("総和が 1.0 でなければ reject(産出が静かにスケールするため)", () => {
    const paths = issuePaths(
      withFacilityPatch({
        statWeights: { vigor: 0.5, dexterity: 0.5, intellect: 0.5, fortitude: 0, will: 0 },
      }),
    );
    expect(paths).toContain("facility.hearth.statWeights");
  });

  it("5 種のいずれかが欠けていれば reject(部分指定は曖昧)", () => {
    const paths = issuePaths(
      withFacilityPatch({ statWeights: { vigor: 1, dexterity: 0, intellect: 0, fortitude: 0 } }),
    );
    expect(paths.some((path) => path.includes("statWeights"))).toBe(true);
  });

  it("省略時はキーごと現れない(engine 側の等分既定が使われる)", () => {
    const content = load(rawBundle());
    expect(content.facilityDefs.get("hearth" as never)?.statWeights).toBeUndefined();
  });
});

describe("(b') facility の保管容量(GDD 12.1)", () => {
  it("storageCapacityCurve / storedResourceIds が写る", () => {
    const content = load(
      withFacilityPatch({
        storageCapacityCurve: [100, 200, 300, 400, 500],
        storedResourceIds: ["iron", "firewood"],
      }),
    );
    const storage = content.facilityDefs.get("hearth" as never)?.storage;
    expect(storage?.capacityByLevel.map(toRaw)).toEqual([
      100_000_000, 200_000_000, 300_000_000, 400_000_000, 500_000_000,
    ]);
    // 対象資源は ID 昇順の正準順へ揃える。
    expect(storage?.resourceIds).toEqual(["firewood", "iron"]);
  });

  it("storedResourceIds 省略は「全資源」(null)", () => {
    const content = load(withFacilityPatch({ storageCapacityCurve: [1, 2, 3, 4, 5] }));
    expect(content.facilityDefs.get("hearth" as never)?.storage?.resourceIds).toBeNull();
  });

  it("省略時は容量を提供しない", () => {
    const content = load(rawBundle());
    expect(content.facilityDefs.get("hearth" as never)?.storage).toBeUndefined();
  });
});

describe("(c) balance.storage(GDD 6.7)", () => {
  it("ダミー content の storage ブロックが写る", () => {
    const content = load(rawBundle());
    expect(content.storage?.wasteResourceId).toBe("waste");
    expect(toRaw(content.storage?.wasteToResearchRatioFix ?? (0 as never))).toBe(100_000);
    expect(toRaw(content.storage?.buildCostWasteSubstitutionMaxFix ?? (0 as never))).toBe(200_000);
    expect(
      toRaw(
        content.storage?.wasteConversionRatioByResourceId.get("firewood" as never) ?? (0 as never),
      ),
    ).toBe(500_000);
    // 基礎容量は未設定 = どの資源も上限なし(既定の不活性)。
    expect(content.storage?.baseCapacityByResourceId.size).toBe(0);
  });

  it("storage ブロックが無ければ undefined(上限判定が走らない)", () => {
    const bundle = rawBundle();
    const balance = clone(bundle.balance) as Record<string, unknown>;
    delete balance["storage"];
    expect(load({ ...bundle, balance }).storage).toBeUndefined();
  });

  it("廃材変換率だけあって変換先が無い設定は reject", () => {
    const bundle = rawBundle();
    const balance = clone(bundle.balance) as Record<string, unknown>;
    balance["storage"] = {
      wasteResourceId: null,
      baseCapacity: {},
      wasteConversionRatio: { firewood: 0.5 },
      wasteToResearchRatio: 0.1,
      buildCostWasteSubstitutionMax: 0.2,
      codifyWasteSubstitutionMax: 0.05,
    };
    expect(issuePaths({ ...bundle, balance })).toContain("balance.$.storage.wasteResourceId");
  });

  it("GDD 6.7「最大20%」を超える代替比率は reject", () => {
    const bundle = rawBundle();
    const balance = clone(bundle.balance) as Record<string, unknown>;
    const storage = clone(balance["storage"]) as Record<string, unknown>;
    storage["buildCostWasteSubstitutionMax"] = 0.5;
    expect(issuePaths({ ...bundle, balance: { ...balance, storage } })).toContain(
      "balance.$.storage.buildCostWasteSubstitutionMax",
    );
  });
});
