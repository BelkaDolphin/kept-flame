import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";
import { FIX_ZERO, fixFromInt, fixFromRaw, toApproxNumber, toRaw } from "../../src/engine/fp";
import { careRecipientsAt } from "../../src/engine/rules/care";
import {
  applyMoraleProgress,
  computeMoraleRates,
  effectiveMoraleFix,
  moraleTraitAddFix,
  perTickFromPerDayFix,
} from "../../src/engine/rules/morale";
import { recallRiskPerDay } from "../../src/engine/rules/recall";
import type { TraitDef } from "../../src/engine/rules/stats";
import type { EngineContent, MoraleParams } from "../../src/engine/rules/types";
import { requireEntity, type EntityId, type GameState } from "../../src/engine/state/state";
import { setTechMemory } from "../../src/engine/state/update";
import {
  FORGE,
  HEARTH,
  INFIRMARY,
  STUDY_DESK,
  TECH_BRONZE,
  WOOD,
  content,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// [M72] 士気モデル(GDD 4.2 / 7.2 / 7.3 / 11.2 / 11.5・台帳v20 必-4)。
//
// このファイルが固定するのは 6 点:
//   (1) 過酷業務で低下・通常業務で回復・無配属/派遣中は動かない
//   (2) 業務由来の低下は routineFloor(**実効士気**)で止まる
//       = GDD 11.2 の moraleW 閾値 30 を日常業務では割らない
//   (3) trait 楽観/悲観(±10)が実効士気に効き、moraleW の判定もそれで動く
//   (4) 療養所で休養している間は追加回復が乗る(M66 の受け皿への結線)
//   (5) 分割不変性(クランプ込みで、区間をどこで割っても同じ士気になる)
//   (6) **反証**: content の `morale` ブロックを外すと士気は 1 も動かない
// ---------------------------------------------------------------------------

const MORALE: MoraleParams = {
  harshWorkDropPerDayFix: fixFromRaw(2_500_000),
  normalWorkRecoverPerDayFix: fixFromInt(1),
  careRecoverPerDayFix: fixFromInt(2),
  routineFloorFix: fixFromInt(35),
  recallGuardThresholdFix: fixFromInt(40),
};

const OPTIMIST: TraitDef = {
  id: id("traitOptimist"),
  statAddFixById: new Map(),
  statMulFixById: new Map(),
  yieldMulFix: fixFromInt(1),
  moraleAddFix: fixFromInt(10),
};
const PESSIMIST: TraitDef = {
  id: id("traitPessimist"),
  statAddFixById: new Map(),
  statMulFixById: new Map(),
  yieldMulFix: fixFromInt(1),
  moraleAddFix: fixFromInt(-10),
};

const DEFS = new Map([
  [HEARTH.id, HEARTH],
  [FORGE.id, FORGE],
  [STUDY_DESK.id, STUDY_DESK],
  [INFIRMARY.id, INFIRMARY],
]);

function moraleContent(overrides: Partial<EngineContent> = {}): EngineContent {
  return content({
    facilityDefs: DEFS,
    traitDefs: new Map([
      [OPTIMIST.id, OPTIMIST],
      [PESSIMIST.id, PESSIMIST],
    ]),
    morale: MORALE,
    ...overrides,
  });
}

/** 過酷業務 1 人・通常業務 1 人・無配属 1 人の盤面。 */
function board(moraleHuman = 60, traitIds: readonly EntityId[] = []): GameState {
  return stateOf([
    resident("residentHarsh", {
      assignedFacilityId: id("facilityForge"),
      morale: fixFromInt(moraleHuman),
      traitIds,
    }),
    resident("residentNormal", {
      assignedFacilityId: id("facilityHearth"),
      morale: fixFromInt(moraleHuman),
    }),
    resident("residentIdle", { morale: fixFromInt(moraleHuman) }),
    facility("facilityForge", FORGE.id, 0, [id("residentHarsh")], 1),
    facility("facilityHearth", HEARTH.id, 8, [id("residentNormal")], 1),
    resource("resourceWood", WOOD, 0),
  ]);
}

function moraleOf(state: GameState, residentId: string): number {
  return toApproxNumber(requireEntity(state, id(residentId), "resident").morale);
}

describe("[M72] レート換算と実効士気", () => {
  it("1 日あたりレートは 1 回だけの floor 除算で per-tick 化する", () => {
    // 2.5/日 → floor(2_500_000 / 1440) = 1736 raw/tick。
    expect(toRaw(perTickFromPerDayFix(fixFromRaw(2_500_000)))).toBe(1736);
  });

  it("trait 楽観 +10 / 悲観 -10 が実効士気に効く(GDD 7.2)", () => {
    const c = moraleContent();
    const plain = resident("residentA", { morale: fixFromInt(50) });
    const optimist = resident("residentB", { morale: fixFromInt(50), traitIds: [OPTIMIST.id] });
    const pessimist = resident("residentC", { morale: fixFromInt(50), traitIds: [PESSIMIST.id] });
    expect(toRaw(moraleTraitAddFix(plain, c))).toBe(0);
    expect(toApproxNumber(effectiveMoraleFix(plain, c))).toBe(50);
    expect(toApproxNumber(effectiveMoraleFix(optimist, c))).toBe(60);
    expect(toApproxNumber(effectiveMoraleFix(pessimist, c))).toBe(40);
  });

  it("実効士気は 0〜100 にクランプされる(GDD 7.1)", () => {
    const c = moraleContent();
    const high = resident("residentA", { morale: fixFromInt(95), traitIds: [OPTIMIST.id] });
    const low = resident("residentB", { morale: fixFromInt(5), traitIds: [PESSIMIST.id] });
    expect(toApproxNumber(effectiveMoraleFix(high, c))).toBe(100);
    expect(toApproxNumber(effectiveMoraleFix(low, c))).toBe(0);
  });

  it("moraleW の判定も実効士気で動く(悲観は同じ蓄積士気でもリスクが高い)", () => {
    const c = moraleContent();
    const state = stateOf([
      resident("residentPlain", { morale: fixFromInt(35) }),
      resident("residentPessimist", { morale: fixFromInt(35), traitIds: [PESSIMIST.id] }),
      research("researchBronze", TECH_BRONZE.id),
    ]);
    const plain = requireEntity(state, id("residentPlain"), "resident");
    const pessimist = requireEntity(state, id("residentPessimist"), "resident");
    // 実効 35 → moraleW なし / 実効 25 → +0.10(GDD 11.2)。
    expect(toRaw(recallRiskPerDay(state, c, plain))).toBe(0);
    expect(toRaw(recallRiskPerDay(state, c, pessimist))).toBe(100_000);
  });
});

describe("[M72] 業務による低下と回復", () => {
  it("過酷業務は下がり、通常業務は上がり、無配属は動かない", () => {
    const c = moraleContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440); // 1 ゲーム日
    expect(moraleOf(next, "residentHarsh")).toBeCloseTo(60 - 2.5, 2);
    expect(moraleOf(next, "residentNormal")).toBeCloseTo(60 + 1, 2);
    expect(moraleOf(next, "residentIdle")).toBe(60);
  });

  it("派遣中は動かない(GDD が名指すのは過酷業務と通常業務就労だけ)", () => {
    const c = moraleContent();
    const state = stateOf([
      resident("residentA", {
        assignedFacilityId: id("facilityForge"),
        dispatched: true,
        morale: fixFromInt(60),
      }),
      facility("facilityForge", FORGE.id, 0, [id("residentA")], 1),
      resource("resourceWood", WOOD, 0),
    ]);
    const ctx = createAdvanceContext(state, c);
    expect(moraleOf(advance(state, ctx, 1440), "residentA")).toBe(60);
  });

  it("**反証**: morale ブロックが無ければ 1 も動かない(= M72 以前と同一)", () => {
    const c = content({ facilityDefs: DEFS });
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440 * 10);
    expect(moraleOf(next, "residentHarsh")).toBe(60);
    expect(moraleOf(next, "residentNormal")).toBe(60);
  });
});

describe("[M72] routine floor(業務由来の低下は 30 を割らない)", () => {
  it("過酷業務を続けても実効士気は routineFloor で止まる", () => {
    const c = moraleContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    // 60 → 35 まで 10 日。40 日進めても floor から下へは行かない。
    const next = advance(state, ctx, 1440 * 40);
    expect(moraleOf(next, "residentHarsh")).toBeCloseTo(35, 1);
  });

  it("[30,40) 帯に留まる = GDD 11.5 の bot 閾値を下回りつつ 11.2 の 30 は割らない", () => {
    const c = moraleContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440 * 40);
    const moraleFix = effectiveMoraleFix(requireEntity(next, id("residentHarsh"), "resident"), c);
    expect(toApproxNumber(moraleFix)).toBeGreaterThanOrEqual(30);
    expect(toApproxNumber(moraleFix)).toBeLessThan(40);
  });

  it("floor は**実効士気**に掛かるので悲観 trait でも 30 を割らない", () => {
    const c = moraleContent();
    const state = board(60, [PESSIMIST.id]);
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440 * 40);
    const harsh = requireEntity(next, id("residentHarsh"), "resident");
    expect(toApproxNumber(effectiveMoraleFix(harsh, c))).toBeCloseTo(35, 1);
    // 蓄積士気そのものは floor + 10 で止まっている(trait ぶんずれている)。
    expect(moraleOf(next, "residentHarsh")).toBeCloseTo(45, 1);
  });

  it("floor より下から始まった住民を業務由来の低下でさらに掘らない(伴侶喪失の保全)", () => {
    const c = moraleContent();
    const state = board(20);
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440 * 5);
    expect(moraleOf(next, "residentHarsh")).toBe(20);
  });

  it("回復側は 100 で頭打ち", () => {
    const c = moraleContent();
    const state = board(99);
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 1440 * 10);
    expect(moraleOf(next, "residentNormal")).toBe(100);
  });
});

describe("[M72] 療養所の休養が士気回復の受け皿になる(M66 との結線)", () => {
  function careBoard(): GameState {
    let state = stateOf([
      resident("residentHarsh", {
        assignedFacilityId: id("facilityForge"),
        morale: fixFromInt(50),
      }),
      facility("facilityForge", FORGE.id, 0, [id("residentHarsh")], 1),
      facility("facilityInfirmary", INFIRMARY.id, 8, [], 1),
      research("researchBronze", TECH_BRONZE.id),
      resource("resourceWood", WOOD, 0),
    ]);
    // 想起困難中 = 休養の対象(rules/care.ts §1(a))。
    state = setTechMemory(state, `residentHarsh|${String(TECH_BRONZE.id)}`, {
      masteryFix: FIX_ZERO,
      impairedUntilTick: 100_000,
    });
    return state;
  }

  it("休養中は追加回復が乗り、過酷業務の低下が相殺される", () => {
    const c = moraleContent({ care: { restRecoveryTicks: 1440 } });
    const state = careBoard();
    expect(careRecipientsAt(state, c, 0)).toEqual([id("residentHarsh")]);
    const rates = computeMoraleRates(state, c, 0);
    // -2.5/日 + 2.0/日 = -0.5/日(per-tick は floor 除算なので符号だけ見る)。
    expect(toRaw(rates.entries[0]?.ratePerTickFix ?? FIX_ZERO)).toBeLessThan(0);
    const next = applyMoraleProgress(state, rates, 1440);
    expect(moraleOf(next, "residentHarsh")).toBeGreaterThan(50 - 2.5);
  });

  it("療養所が無ければ休養の追加回復は乗らない(反証)", () => {
    const c = moraleContent({ care: { restRecoveryTicks: 1440 } });
    const state = careBoard();
    const withoutInfirmary = stateOf(
      [...state.entityStateById.values()].filter((e) => e.id !== id("facilityInfirmary")),
    );
    expect(careRecipientsAt(withoutInfirmary, c, 0)).toEqual([]);
  });
});

describe("[M72] 分割不変性(advance をどこで割っても同じ士気)", () => {
  it("floor に当たる区間を跨いでも一致する", () => {
    const c = moraleContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const whole = advance(state, ctx, 1440 * 20);
    let split = state;
    for (const boundary of [700, 5000, 14_400, 1440 * 20]) {
      split = advance(split, ctx, boundary);
    }
    expect(moraleOf(split, "residentHarsh")).toBe(moraleOf(whole, "residentHarsh"));
    expect(moraleOf(split, "residentNormal")).toBe(moraleOf(whole, "residentNormal"));
  });

  it("上限 100 に当たる区間を跨いでも一致する", () => {
    const c = moraleContent();
    const state = board(99);
    const ctx = createAdvanceContext(state, c);
    const whole = advance(state, ctx, 1440 * 10);
    const split = advance(advance(state, ctx, 1000), ctx, 1440 * 10);
    expect(moraleOf(split, "residentNormal")).toBe(moraleOf(whole, "residentNormal"));
  });
});
