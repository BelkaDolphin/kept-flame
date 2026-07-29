import { describe, expect, it } from "vitest";

import { FIX_ONE, fixFromInt, fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import { residentCombatPower, teamCombatPower } from "../../src/engine/rules/combat";
import {
  COMBAT_POWER_WEIGHTS,
  NEUTRAL_COMBAT_POWER_IS_BASELINE,
  NEUTRAL_RESIDENT_STATS,
  RESIDENT_DERIVED_STAT_IDS,
  RESIDENT_STAT_IDS,
  STAT_BASELINE_FIX,
  STAT_MAX_FIX,
  affectsCombatPower,
  affectsProduction,
  combatPowerFix,
  isResidentDerivedStatId,
  isResidentStatId,
  resolveCombatTraitDefs,
  resolveTraitDefs,
  teamCombatPowerFix,
  type ResidentDerivedStatId,
  type ResidentStatId,
  type ResidentStats,
  type TraitDef,
} from "../../src/engine/rules/stats";
import type { EngineContent } from "../../src/engine/rules/types";

import { HEARTH, RECALL_RISK, id, matrix, resident, stateOf } from "./fixtures";

// ---------------------------------------------------------------------------
// M7「住民ステータス/trait の engine 反映」の派生値 combatPower(裁定 B8・GDD 8.2)。
//
// 見るのは 4 点:
//   (1) 式が GDD 8.2 と整合する形で**固定小数点で閉じている**(中立住民 = 基準 50)
//   (2) 基礎ステと派生値が**別名前空間**であること(GDD 7.1 の注記)
//   (3) trait が「基礎ステ経由」と「派生値へ直接」の 2 経路で効き、
//       どちらも 1 度だけ通る(二重計上しない)
//   (4) 生産式の trait 倍率(yieldMul)は combatPower に**効かない**
// ---------------------------------------------------------------------------

function statsOf(vigor: number, dex: number, intellect: number, fort: number, will: number) {
  return {
    vigor: fixFromInt(vigor),
    dexterity: fixFromInt(dex),
    intellect: fixFromInt(intellect),
    fortitude: fixFromInt(fort),
    will: fixFromInt(will),
  } satisfies ResidentStats;
}

function traitOf(
  name: string,
  options: {
    readonly add?: readonly (readonly [ResidentStatId, number])[];
    readonly mul?: readonly (readonly [ResidentStatId, number])[];
    readonly derivedAdd?: readonly (readonly [ResidentDerivedStatId, number])[];
    readonly derivedMul?: readonly (readonly [ResidentDerivedStatId, number])[];
    readonly yieldMulRaw?: number;
  } = {},
): TraitDef {
  return {
    id: id(name),
    statAddFixById: new Map((options.add ?? []).map(([s, v]) => [s, fixFromInt(v)] as const)),
    statMulFixById: new Map((options.mul ?? []).map(([s, v]) => [s, fixFromRaw(v)] as const)),
    yieldMulFix: fixFromRaw(options.yieldMulRaw ?? toRaw(FIX_ONE)),
    derivedAddFixById: new Map(
      (options.derivedAdd ?? []).map(([d, v]) => [d, fixFromInt(v)] as const),
    ),
    derivedMulFixById: new Map(
      (options.derivedMul ?? []).map(([d, v]) => [d, fixFromRaw(v)] as const),
    ),
  };
}

function contentOf(traitDefs: readonly TraitDef[] = []): EngineContent {
  return {
    facilityDefs: new Map([[HEARTH.id, HEARTH]]),
    techDefs: new Map(),
    adjacency: matrix(),
    recallRisk: RECALL_RISK,
    coarseTickMinutes: 10,
    traitDefs: new Map(traitDefs.map((def) => [def.id, def] as const)),
  };
}

describe("名前空間(裁定 B8 / GDD 7.1 の注記)", () => {
  it("派生値 ID は基礎ステ 5 種と重ならない", () => {
    for (const derivedId of RESIDENT_DERIVED_STAT_IDS) {
      expect(RESIDENT_STAT_IDS as readonly string[]).not.toContain(derivedId);
      expect(isResidentStatId(derivedId)).toBe(false);
      expect(isResidentDerivedStatId(derivedId)).toBe(true);
    }
  });

  it("正本の派生値は combatPower ただ 1 つ(GDD 8.2)", () => {
    expect([...RESIDENT_DERIVED_STAT_IDS]).toEqual(["combatPower"]);
  });

  it("基礎ステ 5 種は派生値として解決されない", () => {
    for (const statId of RESIDENT_STAT_IDS) {
      expect(isResidentDerivedStatId(statId)).toBe(false);
    }
  });
});

describe("算出式(GDD 8.2 / rules/stats.ts §5)", () => {
  it("重みの総和はちょうど 1.0(基礎ステと同じ 0〜100 スケールに載せる根拠)", () => {
    let sum = 0;
    for (const statId of RESIDENT_STAT_IDS) {
      sum += toRaw(COMBAT_POWER_WEIGHTS[statId]);
    }
    expect(sum).toBe(1_000_000);
  });

  it("中立住民(全ステ 50)の戦力はちょうど基準 50", () => {
    expect(NEUTRAL_COMBAT_POWER_IS_BASELINE).toBe(true);
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, []))).toBe(toRaw(STAT_BASELINE_FIX));
  });

  it("重み付き和そのもの(知性は戦力に寄与しない)", () => {
    // 0.35×80 + 0.20×40 + 0.00×100 + 0.30×60 + 0.15×20 = 28 + 8 + 0 + 18 + 3 = 57
    expect(toRaw(combatPowerFix(statsOf(80, 40, 100, 60, 20), []))).toBe(57_000_000);
  });

  it("知性だけ動かしても戦力は動かない(重み 0)", () => {
    const low = combatPowerFix(statsOf(50, 50, 0, 50, 50), []);
    const high = combatPowerFix(statsOf(50, 50, 100, 50, 50), []);
    expect(toRaw(low)).toBe(toRaw(high));
  });

  it("全ステ上限の住民でも 100 を超えない(0〜100 スケールで閉じる)", () => {
    expect(toRaw(combatPowerFix(statsOf(100, 100, 100, 100, 100), []))).toBe(toRaw(STAT_MAX_FIX));
  });
});

describe("trait の 2 経路(基礎ステ経由 / 派生値へ直接)", () => {
  it("基礎ステへの効果は重み付き和を通して戦力に反映される", () => {
    const strongArm = traitOf("traitStrongArm", { add: [["vigor", 10]] });
    // vigor 50 → 60 で 0.35 × 10 = +3.5
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [strongArm]))).toBe(53_500_000);
  });

  it("派生値への倍率は重み付き和の後に乗る", () => {
    const explorer = traitOf("traitExplorer", { derivedMul: [["combatPower", 1_200_000]] });
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [explorer]))).toBe(60_000_000);
  });

  it("派生値への加算と倍率は (base + Σadd) × Πmul の順で合成される", () => {
    const t = traitOf("traitProbe", {
      derivedAdd: [["combatPower", 10]],
      derivedMul: [["combatPower", 1_200_000]],
    });
    // (50 + 10) × 1.2 = 72
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [t]))).toBe(72_000_000);
  });

  it("2 経路を併せ持つ trait でも各経路を 1 度だけ通る(二重計上しない)", () => {
    const both = traitOf("traitStrongArm", {
      add: [["vigor", 10]],
      derivedMul: [["combatPower", 1_200_000]],
    });
    // (0.35×60 + 0.20×50 + 0.30×50 + 0.15×50) × 1.2 = 53.5 × 1.2 = 64.2
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [both]))).toBe(64_200_000);
  });

  it("生産式の trait 倍率(yieldMul)は戦力に効かない", () => {
    const artisan = traitOf("traitArtisan", { yieldMulRaw: 1_500_000 });
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [artisan]))).toBe(toRaw(STAT_BASELINE_FIX));
  });

  it("派生値の倍率も合成後 [0.7, 1.3] にクランプされる(GDD 7.2 追補)", () => {
    const boosts = [1, 2, 3].map((n) =>
      traitOf(`traitBoost${String(n)}`, { derivedMul: [["combatPower", 1_300_000]] }),
    );
    // 1.3^3 = 2.197 だがカテゴリ上限 1.3 で頭打ち。
    expect(toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, boosts))).toBe(65_000_000);
  });

  it("派生値だけを動かす trait は生産式の合成対象に入らない", () => {
    const explorer = traitOf("traitExplorer", { derivedMul: [["combatPower", 1_200_000]] });
    expect(affectsProduction(explorer)).toBe(false);
    expect(affectsCombatPower(explorer)).toBe(true);

    const traitDefs = new Map([[explorer.id, explorer]]);
    expect(resolveTraitDefs([explorer.id], traitDefs)).toHaveLength(0);
    expect(resolveCombatTraitDefs([explorer.id], traitDefs)).toHaveLength(1);
  });

  it("yieldMul だけの trait は戦力の合成対象に入らない", () => {
    const artisan = traitOf("traitArtisan", { yieldMulRaw: 1_100_000 });
    expect(affectsProduction(artisan)).toBe(true);
    expect(affectsCombatPower(artisan)).toBe(false);
  });
});

describe("state への結線(rules/combat.ts)", () => {
  it("ステータス未設定の住民は中立既定値(= 戦力 50)", () => {
    const state = stateOf([resident("aRui")]);
    const content = contentOf();
    const rui = state.entityStateById.get(id("aRui"));
    expect(rui?.kind).toBe("resident");
    if (rui?.kind !== "resident") return;
    expect(toRaw(residentCombatPower(rui, content))).toBe(toRaw(STAT_BASELINE_FIX));
  });

  it("content に無い trait ID は読み飛ばす(セーブ側の trait が content と独立でよい)", () => {
    const holder = { ...resident("aRui"), traitIds: [id("traitGhost")] };
    const state = stateOf([holder]);
    expect(toRaw(residentCombatPower(holder, contentOf()))).toBe(toRaw(STAT_BASELINE_FIX));
    expect(state.entityStateById.size).toBe(1);
  });

  it("チーム総合力はメンバーの戦力の総和(GDD 8.2)", () => {
    const explorer = traitOf("traitExplorer", { derivedMul: [["combatPower", 1_200_000]] });
    const content = contentOf([explorer]);
    const plain = resident("aRui");
    const strong = { ...resident("bMina"), traitIds: [explorer.id] };
    const state = stateOf([plain, strong]);
    // 50 + 60 = 110
    expect(toRaw(teamCombatPower(state, [plain.id, strong.id], content))).toBe(110_000_000);
  });

  it("チーム総合力は加算順序に依存しない(整数加算)", () => {
    const explorer = traitOf("traitExplorer", { derivedMul: [["combatPower", 1_200_000]] });
    const content = contentOf([explorer]);
    const plain = resident("aRui");
    const strong = { ...resident("bMina"), traitIds: [explorer.id] };
    const state = stateOf([plain, strong]);
    expect(toRaw(teamCombatPower(state, [plain.id, strong.id], content))).toBe(
      toRaw(teamCombatPower(state, [strong.id, plain.id], content)),
    );
  });

  it("空チームの総合力は 0", () => {
    const empty: readonly Fix[] = [];
    expect(toRaw(teamCombatPowerFix(empty))).toBe(0);
  });

  it("存在しない住民 ID は黙って 0 にせず例外にする", () => {
    const state = stateOf([resident("aRui")]);
    expect(() => teamCombatPower(state, [id("zGhost")], contentOf())).toThrow();
  });
});
