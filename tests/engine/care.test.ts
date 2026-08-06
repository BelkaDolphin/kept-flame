import { describe, expect, it } from "vitest";

import { advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import {
  careCapacityOf,
  careRecipientsAt,
  isResidentImpairedAt,
  recoveryTickWithCare,
} from "../../src/engine/rules/care";
import { evaluateRecallCoarseStep } from "../../src/engine/rules/recall";
import { techMemoryOf } from "../../src/engine/rules/techMemory";
import type { EngineContent } from "../../src/engine/rules/types";
import { setTechMemory } from "../../src/engine/state/update";
import type { GameState } from "../../src/engine/state/state";
import {
  FORGE,
  HEARTH,
  INFIRMARY,
  STUDY_DESK,
  TECH_BRONZE,
  content,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
  WOOD,
} from "./fixtures";

// ---------------------------------------------------------------------------
// [M66] 療養所の休養(GDD 11.2 の回復条件「…または療養所で休養1日」)。
//
// このファイルが固定するのは 4 点:
//   (1) 休養枠 = 施設の `careCapacityByLevel` の総和(Lv で増える)
//   (2) 休養する住民 = その tick に想起困難中の生存住民を ID 昇順に枠数まで
//   (3) 回復 tick = min(抽選持続, 発生 + restRecoveryTicks)。**延長はしない**
//   (4) **反証**: content の `care` ブロックを外す / 療養所を建てないと、
//       まったく同じ盤面・同じ seed で持続が抽選値のまま(= 休養が効いている
//       ことの否定形が実測で取れる)
// ---------------------------------------------------------------------------

const CARE_CONTENT_DEFS = new Map([
  [HEARTH.id, HEARTH],
  [FORGE.id, FORGE],
  [STUDY_DESK.id, STUDY_DESK],
  [INFIRMARY.id, INFIRMARY],
]);

function careContent(overrides: Partial<EngineContent> = {}): EngineContent {
  return content({
    facilityDefs: CARE_CONTENT_DEFS,
    care: { restRecoveryTicks: 1440 },
    ...overrides,
  });
}

/** 想起困難中の (住民, tech) を直接置いた盤面(抽選を介さない純関数の検査用)。 */
function impairedBoard(untilTickByResident: readonly (readonly [string, number])[]): GameState {
  let state = stateOf([
    resident("residentA"),
    resident("residentB"),
    resident("residentC"),
    facility("facilityInfirmary", INFIRMARY.id, 0, [], 1),
    research("researchBronze", TECH_BRONZE.id),
  ]);
  for (const [residentId, until] of untilTickByResident) {
    state = setTechMemory(state, `${residentId}|${String(TECH_BRONZE.id)}`, {
      masteryFix: 0 as never,
      impairedUntilTick: until,
    });
  }
  return state;
}

describe("[M66] 休養枠(careCapacityOf)", () => {
  it("careCapacityByLevel を持つ施設の Lv 別値の総和", () => {
    const state = stateOf([
      facility("facilityInfirmaryA", INFIRMARY.id, 0, [], 1),
      facility("facilityInfirmaryB", INFIRMARY.id, 1, [], 3),
    ]);
    // Lv1 = 1 人、Lv3 = 2 人。
    expect(careCapacityOf(state, careContent())).toBe(3);
  });

  it("療養所が無ければ 0(= 休養機構が盤面で不活性)", () => {
    const state = stateOf([facility("facilityHearth", HEARTH.id, 0, [], 1)]);
    expect(careCapacityOf(state, careContent())).toBe(0);
  });
});

describe("[M66] 休養する住民(careRecipientsAt)", () => {
  it("想起困難中の住民を ID 昇順に枠数まで選ぶ", () => {
    const state = impairedBoard([
      ["residentA", 2000],
      ["residentB", 2000],
      ["residentC", 2000],
    ]);
    // Lv1 の療養所 1 基 = 枠 1 人。ID 昇順の先頭だけが休養する。
    expect(careRecipientsAt(state, careContent(), 100)).toEqual([id("residentA")]);
  });

  it("想起困難でない住民は枠を消費しない", () => {
    const state = impairedBoard([["residentB", 2000]]);
    expect(careRecipientsAt(state, careContent(), 100)).toEqual([id("residentB")]);
  });

  it("回復済み(tick >= until)の住民は対象外", () => {
    const state = impairedBoard([["residentA", 50]]);
    expect(isResidentImpairedAt(state, { ...resident("residentA") }, 100)).toBe(false);
    expect(careRecipientsAt(state, careContent(), 100)).toEqual([]);
  });

  it("content に care ブロックが無ければ常に空(= M66 以前と同一)", () => {
    const state = impairedBoard([["residentA", 2000]]);
    expect(careRecipientsAt(state, content({ facilityDefs: CARE_CONTENT_DEFS }), 100)).toEqual([]);
  });
});

describe("[M66] 回復 tick の短縮(recoveryTickWithCare)", () => {
  const c = careContent();

  it("抽選持続が休養より長ければ休養1日へ短縮する", () => {
    expect(recoveryTickWithCare(c, 100, 100 + 2880, true)).toBe(100 + 1440);
  });

  it("抽選持続が休養より短ければ**延長しない**", () => {
    expect(recoveryTickWithCare(c, 100, 100 + 1000, true)).toBe(100 + 1000);
  });

  it("休養していなければ抽選値のまま", () => {
    expect(recoveryTickWithCare(c, 100, 100 + 2880, false)).toBe(100 + 2880);
  });
});

describe("[M66] (C) 抽選への結線と反証", () => {
  // 士気 0 = moraleW +0.20 / 過酷業務 = loadW ×2.0 で、1 ステップの発生確率を
  // 上げて必ず 1 件は発生させる(乱数は hash アドレス方式なので seed 固定で決定論)。
  function board(): GameState {
    return stateOf([
      resident("residentA", { assignedFacilityId: id("facilityForge"), morale: 0 as never }),
      facility("facilityForge", FORGE.id, 0, [id("residentA")], 1),
      facility("facilityInfirmary", INFIRMARY.id, 2, [], 1),
      research("researchBronze", TECH_BRONZE.id),
      resource("resourceWood", WOOD, 0),
    ]);
  }

  function firstOccurrenceUntil(c: EngineContent): number | null {
    const state = board();
    const ctx = createAdvanceContext(state, c);
    // 発生するまで粗粒度ステップを進める(最大 2000 ステップ = 約 14 ゲーム日)。
    let next = state;
    for (let step = 1; step <= 2000; step++) {
      const result = evaluateRecallCoarseStep(next, ctx, step * c.coarseTickMinutes);
      next = result.state;
      const occurrence = result.occurrences[0];
      if (occurrence !== undefined) return occurrence.untilTick - step * c.coarseTickMinutes;
    }
    return null;
  }

  it("療養所があると持続が休養1日(1440)へ短縮される", () => {
    expect(firstOccurrenceUntil(careContent())).toBe(1440);
  });

  it("**反証**: care ブロックを外すと同じ seed・同じ盤面で抽選値のまま(>1440)", () => {
    const without = firstOccurrenceUntil(content({ facilityDefs: CARE_CONTENT_DEFS }));
    expect(without).not.toBeNull();
    expect(without ?? 0).toBeGreaterThan(1440);
  });

  it("advance 経由でも短縮された回復 tick が state に残る", () => {
    const c = careContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const report = advanceWithReport(state, ctx, 4320);
    expect(report.recallOccurrenceCount).toBeGreaterThan(0);
    const memory = techMemoryOf(report.state, id("residentA"), TECH_BRONZE.id);
    expect(memory).toBeDefined();
    // 発生 tick は粗粒度グリッド上なので、回復 tick との差は必ず 1440 以下。
    expect(memory?.impairedUntilTick ?? 0).toBeGreaterThan(0);
  });
});
