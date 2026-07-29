import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContentOrThrow } from "../../schema/engineContent";
import { fixFromInt, toRaw } from "../../src/engine/fp";
import { residentCombatPower } from "../../src/engine/rules/combat";
import { residentContribution } from "../../src/engine/rules/production";
import { STAT_BASELINE_FIX, type ResidentStats } from "../../src/engine/rules/stats";
import type { EngineContent, FacilityDef } from "../../src/engine/rules/types";
import { entityIdFromString, type EntityId } from "../../src/engine/state/state";

import { resident } from "./fixtures";

// ---------------------------------------------------------------------------
// M7「生産式への結線」の**実 content 版**。
//
// M5 が固定したのは合成の式そのもの(合成テストは rulesProduction.test.ts)で、
// content 側は中立既定値のままだった。ここでは
//   content/facility.json の statWeights(GDD 11.1「関連ステータス」)
//   content/trait.json の MVP 8 種(GDD 7.2)
// という**実データ**を正規経路(validateContentBundle → loadEngineContent)で
// 通し、住民の実ステータスと噛み合って GDD の式どおりの数値が出ることを見る。
//
// 隣接乗数を通すと worldSeed 由来の揺らぎが混ざるので、ここでは 1 就労者あたりの
// 寄与(GDD 11.1 の第 4・第 5 項)を直接見る。乗数と掛け合わせた先は
// rulesProduction.test.ts / golden vector の担当。
// ---------------------------------------------------------------------------

const CONTENT: EngineContent = loadEngineContentOrThrow(
  (() => {
    const bundle: RawContentBundle = {
      tech: techJson,
      facility: facilityJson,
      trait: traitJson,
      adjacency: adjacencyJson,
      balance: balanceJson,
    };
    const validated = validateContentBundle(bundle);
    if (!validated.ok) throw new Error(`content 検証で落ちた: ${JSON.stringify(validated.issues)}`);
    return validated.value;
  })(),
);

const idOf = (value: string): EntityId => entityIdFromString(value);

function facilityDef(defId: string): FacilityDef {
  const def = CONTENT.facilityDefs.get(idOf(defId));
  if (def === undefined) throw new Error(`facility "${defId}" が content に無い`);
  return def;
}

function statsOf(vigor: number, dex: number, intellect: number, fort: number, will: number) {
  return {
    vigor: fixFromInt(vigor),
    dexterity: fixFromInt(dex),
    intellect: fixFromInt(intellect),
    fortitude: fixFromInt(fort),
    will: fixFromInt(will),
  } satisfies ResidentStats;
}

function worker(options: {
  readonly stats?: ResidentStats;
  readonly traitIds?: readonly string[];
}) {
  const base = { ...resident("aRui"), traitIds: (options.traitIds ?? []).map(idOf) };
  return options.stats === undefined ? base : { ...base, stats: options.stats };
}

describe("実 content の statWeights と実ステータスが噛み合う(GDD 11.1)", () => {
  it("中立住民は施設に重みがあっても寄与ちょうど 1.0(縮約互換の核心)", () => {
    // 総和 1.0 の重み × 全ステ 50 = 50 → /50 = 1.0。重みの配分によらない。
    expect(toRaw(residentContribution(worker({}), facilityDef("forge"), CONTENT))).toBe(1_000_000);
    expect(toRaw(residentContribution(worker({}), facilityDef("workbench"), CONTENT))).toBe(
      1_000_000,
    );
    expect(toRaw(residentContribution(worker({}), facilityDef("hearth"), CONTENT))).toBe(1_000_000);
  });

  it("鍛冶場(体力0.4/器用0.3/頑健0.3)は関連ステータスだけを見る", () => {
    // 0.4×80 + 0.3×60 + 0×10 + 0.3×70 + 0×20 = 71 → /50 = 1.42
    const smith = worker({ stats: statsOf(80, 60, 10, 70, 20) });
    expect(toRaw(residentContribution(smith, facilityDef("forge"), CONTENT))).toBe(1_420_000);
  });

  it("同じ住民でも施設が変われば寄与が変わる(適性・GDD 7.7)", () => {
    // workbench は 知性0.5/器用0.4/意志0.1: 0.5×10 + 0.4×60 + 0.1×20 = 31 → 0.62
    const smith = worker({ stats: statsOf(80, 60, 10, 70, 20) });
    expect(toRaw(residentContribution(smith, facilityDef("workbench"), CONTENT))).toBe(620_000);
  });

  it("重み未指定の施設は 5 種等分(中立既定)のまま", () => {
    // hearth は statWeights を持たない: (80+60+10+70+20)/5 = 48 → /50 = 0.96
    const smith = worker({ stats: statsOf(80, 60, 10, 70, 20) });
    expect(toRaw(residentContribution(smith, facilityDef("hearth"), CONTENT))).toBe(960_000);
  });
});

describe("実 content の trait 8 種が生産式へ効く(GDD 7.2)", () => {
  it("職人: 器用 ×1.2 と yieldMul ×1.1 が別項として掛かる", () => {
    // 器用 60 → 72。0.4×80 + 0.3×72 + 0.3×70 = 74.6 → /50 = 1.492 → ×1.1 = 1.6412
    const artisan = worker({ stats: statsOf(80, 60, 10, 70, 20), traitIds: ["traitArtisan"] });
    expect(toRaw(residentContribution(artisan, facilityDef("forge"), CONTENT))).toBe(1_641_200);
  });

  it("怪力: 体力 +15 は生産へ効き、combatPower 倍率は生産へ効かない", () => {
    // 体力 50 → 65。0.4×65 + 0.3×50 + 0.3×50 = 56 → /50 = 1.12
    const strong = worker({ traitIds: ["traitStrongArm"] });
    expect(toRaw(residentContribution(strong, facilityDef("forge"), CONTENT))).toBe(1_120_000);
  });

  it("学者: 未実装効果しか持たない trait は寄与を動かさない", () => {
    const scholar = worker({ traitIds: ["traitScholar"] });
    expect(toRaw(residentContribution(scholar, facilityDef("workbench"), CONTENT))).toBe(1_000_000);
  });

  it("記憶巧者: 想起側の効果は生産へ漏れず、知性 +5 だけが効く", () => {
    // workbench の 知性0.5: 50 → 55 で +2.5 → (0.5×55 + 0.4×50 + 0.1×50) = 52.5 → 1.05
    const keeper = worker({ traitIds: ["traitMemoryKeeper"] });
    expect(toRaw(residentContribution(keeper, facilityDef("workbench"), CONTENT))).toBe(1_050_000);
  });
});

describe("実 content の trait が派生値 combatPower へ効く(GDD 8.2)", () => {
  it("trait 無しの中立住民は基準 50", () => {
    expect(toRaw(residentCombatPower(worker({}), CONTENT))).toBe(toRaw(STAT_BASELINE_FIX));
  });

  it("怪力: 体力 +15(重み 0.35 = +5.25)と combatPower ×1.2 の 2 段", () => {
    // (0.35×65 + 0.20×50 + 0.30×50 + 0.15×50) = 55.25 → ×1.2 = 66.3
    const strong = worker({ traitIds: ["traitStrongArm"] });
    expect(toRaw(residentCombatPower(strong, CONTENT))).toBe(66_300_000);
  });

  it("探索者: 体力 +5(= +1.75)と combatPower ×1.15", () => {
    // (0.35×55 + 0.20×50 + 0.30×50 + 0.15×50) = 51.75 → ×1.15 = 59.5125
    const explorer = worker({ traitIds: ["traitExplorer"] });
    expect(toRaw(residentCombatPower(explorer, CONTENT))).toBe(59_512_500);
  });

  it("職人の yieldMul は戦力に効かない(生産式専用の項)", () => {
    // 器用 ×1.2 = 60 の寄与 (0.20×60 - 0.20×50 = +2) だけが効く。
    const artisan = worker({ traitIds: ["traitArtisan"] });
    expect(toRaw(residentCombatPower(artisan, CONTENT))).toBe(52_000_000);
  });
});
