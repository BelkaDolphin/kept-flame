import { describe, expect, it } from "vitest";

import { advance, advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import { FIX_ZERO, fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  BOND_MILESTONE_TIER_FIXES,
  bondValueOf,
  computeBondRates,
} from "../../src/engine/rules/bond";
import { isWorkerActive, isWorkerActiveAtFacility } from "../../src/engine/rules/production";
import { recallRiskPerDay } from "../../src/engine/rules/recall";
import { currentResearch } from "../../src/engine/rules/research";
import {
  applyMasteryProgress,
  applyTechLossOnDeath,
  buildImpairmentIndex,
  heldTechIdsOf,
  indexStopsFacility,
  isTechImpaired,
  isTechRelatedImpaired,
  isTechUnlocked,
  masteryGainPerTickFix,
  masteryResistBaseFix,
  memoryTechIdsOf,
  setTechImpairedUntil,
  techHoldersOf,
  techMasteryOf,
  techMemoryKeyOf,
  techMemoryOf,
} from "../../src/engine/rules/techMemory";
import type { EngineContent, TechDef } from "../../src/engine/rules/types";
import { memoirLogOf } from "../../src/engine/rules/memoir";
import { toSerializable } from "../../src/engine/state/serialize";
import { requireEntity, type EntityId, type GameState } from "../../src/engine/state/state";
import { setTechMemory } from "../../src/engine/state/update";
import {
  FORGE,
  HEARTH,
  STUDY_DESK,
  WOOD,
  content,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";
import { BUNKS, residentDyingAt, townContent } from "./lifespanFixtures";

// ---------------------------------------------------------------------------
// [M13] 想起リスクの本式化(tech 別停止 / mastery / (B) 一回性喪失)と、
// M12 の memoir/bond 純関数の tick 結線。
//
// このファイルが固定するのは 5 点:
//   (1) 「関連生産」の解決 — tech.fieldRequirement.facility で停止範囲が決まり、
//       実地要件不明の tech は住民単位の全停止へフォールバックする
//   (2) masteryResist(u,t) — 住民スカラ + tech 別蓄積、上限 0.20 の clamp(裁定 N12)
//   (3) (B) 一回性喪失 — 保持者ゼロ かつ 記録ゼロ のときだけ喪失し、
//       (A) は再研究可能 / (B) は永久に対象外
//   (4) memoir/bond の tick 結線 — 蓄積・節目・相方喪失が scheduler 上で起きる
//   (5) **分割不変性** — 回復 tick / 節目到達 tick / 死亡(喪失)tick / mastery が
//       上限に張り付く tick、いずれの「境界ちょうど」で区切っても state が一致する
// ---------------------------------------------------------------------------

const WORKER = id("aRui");
const WORKER2 = id("bMina");

/** 実地要件が「かまど」の tech(停止範囲・定着の蓄積先が hearth になる)。 */
const TECH_HEARTH: TechDef = {
  id: id("techHearthCraft"),
  researchCostFix: fixFromInt(10),
  fieldFacilityId: HEARTH.id,
};

/** 実地要件が「鍛冶場」の tech(hearth 就労者には関係しない)。 */
const TECH_FORGE: TechDef = {
  id: id("techForgeCraft"),
  researchCostFix: fixFromInt(10),
  fieldFacilityId: FORGE.id,
  lossClass: "rareIrreversible",
};

/** 実地要件を持たない tech(縮約フォールバック = 住民単位の全停止)。 */
const TECH_NOFIELD: TechDef = {
  id: id("techNoField"),
  researchCostFix: fixFromInt(10),
};

function contentWith(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = content();
  return {
    ...base,
    techDefs: new Map([
      [TECH_HEARTH.id, TECH_HEARTH],
      [TECH_FORGE.id, TECH_FORGE],
      [TECH_NOFIELD.id, TECH_NOFIELD],
    ]),
    ...overrides,
  };
}

/** 定着が蓄積する content(1 日 +0.0144 = per-tick raw 10)。 */
function masteryContent(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = contentWith(overrides);
  return {
    ...base,
    recallRisk: { ...base.recallRisk, masteryGainPerFieldWorkDayFix: fixFromRaw(14_400) },
  };
}

function json(state: GameState): string {
  return JSON.stringify(toSerializable(state));
}

function stock(state: GameState, name = "wStock"): number {
  return toRaw(requireEntity(state, id(name), "resource").stock);
}

/** 住民 1 人がかまどで働く盤面。 */
function hearthBoard(): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    facility("fHearth", HEARTH.id, 8, [WORKER]),
    resource("wStock", WOOD),
  ]);
}

// ===========================================================================
// 1. 「関連生産」の解決(GDD 11.2「当該住民の当該 tech 関連生産のみ停止」)
// ===========================================================================

describe("[M13] tech 別停止(GDD 11.2 の本式)", () => {
  it("実地要件が同じ施設の tech で想起困難になると、その施設での寄与が 0 になる", () => {
    const c = contentWith();
    let state = hearthBoard();
    state = setTechImpairedUntil(state, WORKER, TECH_HEARTH.id, 100);
    const ctx = createAdvanceContext(state, c);
    expect(stock(advance(state, ctx, 100))).toBe(0);
  });

  it("実地要件が別施設の tech で想起困難になっても、その施設の生産は止まらない", () => {
    const c = contentWith();
    let state = hearthBoard();
    state = setTechImpairedUntil(state, WORKER, TECH_FORGE.id, 100);
    const ctx = createAdvanceContext(state, c);
    // かまど Lv1 = 1.0/tick × 100 tick。想起困難は鍛冶場側の技術なので無関係。
    expect(stock(advance(state, ctx, 100))).toBe(100_000_000);
  });

  it("実地要件を持たない tech は住民単位の全停止へフォールバックする(縮約互換)", () => {
    const c = contentWith();
    let state = hearthBoard();
    state = setTechImpairedUntil(state, WORKER, TECH_NOFIELD.id, 100);
    const ctx = createAdvanceContext(state, c);
    expect(stock(advance(state, ctx, 100))).toBe(0);
  });

  it("住民単位スカラ(recallImpairedUntilTick)は従来どおり全停止として尊重される", () => {
    const c = contentWith();
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth"), recallImpairedUntilTick: 100 }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    expect(stock(advance(state, createAdvanceContext(state, c), 100))).toBe(0);
  });

  it("techMemory が空なら isWorkerActiveAtFacility は isWorkerActive と同値", () => {
    const c = contentWith();
    const state = hearthBoard();
    const worker = requireEntity(state, WORKER, "resident");
    expect(state.techMemoryByKey.size).toBe(0);
    expect(isWorkerActiveAtFacility(state, c, worker, HEARTH.id, 0)).toBe(
      isWorkerActive(worker, 0),
    );
  });

  it("索引(buildImpairmentIndex)と全件走査(isTechRelatedImpaired)が一致する", () => {
    const c = contentWith();
    let state = hearthBoard();
    state = setTechImpairedUntil(state, WORKER, TECH_HEARTH.id, 100);
    state = setTechImpairedUntil(state, WORKER2, TECH_NOFIELD.id, 50);
    const index = buildImpairmentIndex(state, c, 10);
    for (const residentId of [WORKER, WORKER2]) {
      for (const defId of [HEARTH.id, FORGE.id, STUDY_DESK.id]) {
        expect(indexStopsFacility(index, residentId, defId)).toBe(
          isTechRelatedImpaired(state, c, residentId, defId, 10),
        );
      }
    }
    // 全停止(実地要件不明)と施設限定の違いが索引に現れている。
    expect(indexStopsFacility(index, WORKER2, STUDY_DESK.id)).toBe(true);
    expect(indexStopsFacility(index, WORKER, STUDY_DESK.id)).toBe(false);
  });

  it("回復 tick を過ぎれば止まらない(比較のみで表現・状態遷移を持たない)", () => {
    const c = contentWith();
    let state = hearthBoard();
    state = setTechImpairedUntil(state, WORKER, TECH_HEARTH.id, 40);
    const ctx = createAdvanceContext(state, c);
    // [0,40) は停止、[40,100) は稼働 → 60 tick 分。
    expect(stock(advance(state, ctx, 100))).toBe(60_000_000);
    expect(isTechImpaired(state, WORKER, TECH_HEARTH.id, 39)).toBe(true);
    expect(isTechImpaired(state, WORKER, TECH_HEARTH.id, 40)).toBe(false);
  });
});

// ===========================================================================
// 2. masteryResist(u,t)(GDD 11.2 / 裁定 N12)
// ===========================================================================

describe("[M13] masteryResist(u,t) と裁定 N12 の clamp 挙動", () => {
  it("住民スカラと tech 別蓄積は加算され、上限(0.20)でクランプされる", () => {
    const c = contentWith();
    let state = hearthBoard();
    // 住民スカラ 0.05 + tech 別 0.04 = 0.09。
    state = setTechMemory(state, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: fixFromRaw(40_000),
      impairedUntilTick: 0,
    });
    const withScalar = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth"), mastery: fixFromRaw(50_000) }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    const merged = setTechMemory(withScalar, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: fixFromRaw(40_000),
      impairedUntilTick: 0,
    });
    expect(
      toRaw(
        masteryResistBaseFix(merged, c, requireEntity(merged, WORKER, "resident"), TECH_HEARTH.id),
      ),
    ).toBe(90_000);
    // 上限超過は 0.20 で打ち止め。
    const over = setTechMemory(withScalar, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: fixFromRaw(900_000),
      impairedUntilTick: 0,
    });
    expect(
      toRaw(masteryResistBaseFix(over, c, requireEntity(over, WORKER, "resident"), TECH_HEARTH.id)),
    ).toBe(200_000);
    // techMemory が無い tech は住民スカラだけ(= M13 以前と同一)。
    expect(
      toRaw(
        masteryResistBaseFix(merged, c, requireEntity(merged, WORKER, "resident"), TECH_FORGE.id),
      ),
    ).toBe(50_000);
    expect(toRaw(techMasteryOf(state, WORKER, TECH_FORGE.id))).toBe(0);
  });

  it("上限 0.20 は過酷業務の base_p × loadW = 0.10 を完全に相殺する(裁定 N12・意図的)", () => {
    const c = contentWith();
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fForge") }),
      facility("fForge", FORGE.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    const full = setTechMemory(state, techMemoryKeyOf(WORKER, TECH_FORGE.id), {
      masteryFix: fixFromRaw(200_000),
      impairedUntilTick: 0,
    });
    const worker = requireEntity(full, WORKER, "resident");
    // 過酷業務 = 0.05 × 2.0 = 0.10、mastery 0.20 を引いて clamp(0, ...) = 0。
    expect(toRaw(recallRiskPerDay(full, c, worker, TECH_FORGE.id))).toBe(0);
    // 蓄積が無い別 tech では相殺されない。
    expect(toRaw(recallRiskPerDay(full, c, worker, TECH_HEARTH.id))).toBe(100_000);
  });

  it("per-tick レートは per-day 値を 1 回だけ floor 除算して作る(分割で丸めが動かない)", () => {
    expect(toRaw(masteryGainPerTickFix(masteryContent()))).toBe(10);
    // 省略時は蓄積しない = M13 以前と同一。
    expect(toRaw(masteryGainPerTickFix(contentWith()))).toBe(0);
  });
});

// ===========================================================================
// 3. 定着の蓄積(実地稼働・GDD 4「解禁 → 実地稼働で記憶定着」)
// ===========================================================================

describe("[M13] 定着の蓄積(tick ループ結線)", () => {
  /** かまど就労 + techHearthCraft が解禁済みの盤面。 */
  function unlockedBoard(): GameState {
    return stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      {
        kind: "research",
        id: id("rHearth"),
        techId: TECH_HEARTH.id,
        progress: fixFromInt(10),
        completedTick: 0,
      },
    ]);
  }

  it("解禁済み tech の実地要件施設で稼働すると定着が蓄積する", () => {
    const state = unlockedBoard();
    const c = masteryContent();
    expect(isTechUnlocked(state, TECH_HEARTH.id)).toBe(true);
    const after = advance(state, createAdvanceContext(state, c), 1440);
    // per-tick raw 10 × 1440 tick = 14_400(= 1 日あたり 0.0144)。
    expect(toRaw(techMasteryOf(after, WORKER, TECH_HEARTH.id))).toBe(14_400);
    expect(heldTechIdsOf(after, WORKER)).toEqual([TECH_HEARTH.id]);
  });

  it("未解禁(research が未完了)の tech は蓄積しない", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      research("rHearth", TECH_HEARTH.id),
    ]);
    const after = advance(state, createAdvanceContext(state, masteryContent()), 1440);
    expect(after.techMemoryByKey.size).toBe(0);
  });

  it("実地要件が別施設の tech は蓄積しない", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      {
        kind: "research",
        id: id("rForge"),
        techId: TECH_FORGE.id,
        progress: fixFromInt(10),
        completedTick: 0,
      },
    ]);
    const after = advance(state, createAdvanceContext(state, masteryContent()), 1440);
    expect(toRaw(techMasteryOf(after, WORKER, TECH_FORGE.id))).toBe(0);
  });

  it("上限(masteryResistMax = 0.20)で張り付き、それ以上は増えない", () => {
    const state = unlockedBoard();
    const c = masteryContent();
    const ctx = createAdvanceContext(state, c);
    // 200_000 / 10 = 20_000 tick で上限へ到達する。
    const atCap = advance(state, ctx, 20_000);
    expect(toRaw(techMasteryOf(atCap, WORKER, TECH_HEARTH.id))).toBe(200_000);
    const beyond = advance(state, ctx, 40_000);
    expect(toRaw(techMasteryOf(beyond, WORKER, TECH_HEARTH.id))).toBe(200_000);
  });

  it("applyMasteryProgress は deltaTicks < 1 を reject する", () => {
    const state = unlockedBoard();
    const c = masteryContent();
    expect(() => applyMasteryProgress(state, c, [], 0)).toThrow();
  });

  it("[分割不変] 上限へ張り付く tick ちょうどで区切っても一致する", () => {
    const state = unlockedBoard();
    const ctx = createAdvanceContext(state, masteryContent());
    const whole = advance(state, ctx, 30_000);
    const split = advance(advance(state, ctx, 20_000), ctx, 30_000);
    expect(json(split)).toBe(json(whole));
  });

  it("[分割不変] 定着が動いている区間を任意 tick で区切っても一致する", () => {
    const state = unlockedBoard();
    const ctx = createAdvanceContext(state, masteryContent());
    const whole = advance(state, ctx, 5_000);
    for (const cut of [1, 7, 10, 1234, 4999]) {
      const split = advance(advance(state, ctx, cut), ctx, 5_000);
      expect(json(split)).toBe(json(whole));
    }
  });
});

// ===========================================================================
// 4. (C) 抽選の本式(per-tech 独立・GDD 11.2)
// ===========================================================================

describe("[M13] (C) 抽選は (住民, tech) 単位で独立に発生する", () => {
  /** p_step = 1.0 になる content(ステップ幅 = 1 日)。 */
  function certainContent(durationTicks = 720): EngineContent {
    const base = contentWith();
    return {
      ...base,
      coarseTickMinutes: 1440,
      recallRisk: {
        ...base.recallRisk,
        basePFix: fixFromInt(1),
        loadWNormalFix: fixFromInt(1),
        loadWHarshFix: fixFromInt(1),
        pMaxFix: fixFromInt(1),
        durationMinTicks: durationTicks,
        durationMaxTicks: durationTicks,
      },
    };
  }

  function twoTechBoard(): GameState {
    return stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      research("rHearth", TECH_HEARTH.id),
      research("sForge", TECH_FORGE.id),
    ]);
  }

  it("同一住民の 2 tech が同じステップで独立に発生する(T5 の住民単位抑制を撤去)", () => {
    const state = twoTechBoard();
    const report = advanceWithReport(state, createAdvanceContext(state, certainContent()), 1440);
    expect(report.stochasticStepCount).toBe(1);
    expect(report.stochasticTrialCount).toBe(2);
    // T5 なら 1 件(住民単位抑制)。M13 は 2 件。
    expect(report.recallOccurrenceCount).toBe(2);
    expect(memoryTechIdsOf(report.state, WORKER)).toEqual([TECH_FORGE.id, TECH_HEARTH.id]);
    // 住民単位スカラは抽選が書かない。
    expect(requireEntity(report.state, WORKER, "resident").recallImpairedUntilTick).toBe(0);
  });

  it("同一 (住民, tech) が想起困難中なら新規発生にならない(持続は延長されない)", () => {
    const state = twoTechBoard();
    const c = certainContent(2000);
    const report = advanceWithReport(state, createAdvanceContext(state, c), 2880);
    // ステップは tick 0 と 1440。1440 時点では until=2000 なのでどちらも再発生しない。
    expect(report.stochasticStepCount).toBe(2);
    expect(report.stochasticTrialCount).toBe(4);
    expect(report.recallOccurrenceCount).toBe(2);
    expect(techMemoryOf(report.state, WORKER, TECH_HEARTH.id)?.impairedUntilTick).toBe(2000);
  });

  it("同 tick に同じ住民の 2 件が回復しても回復境界は 1 本に畳まれる(全順序の維持)", () => {
    const state = twoTechBoard();
    // 持続を固定値にすれば 2 tech の回復 tick が一致する。
    const c = certainContent(720);
    const report = advanceWithReport(state, createAdvanceContext(state, c), 1440, {
      collectSegments: true,
    });
    const recover = report.segments.filter((s) => s.endEventKinds.includes("recallRecover"));
    expect(recover.map((s) => s.toTick)).toEqual([720]);
    expect(recover[0]?.endEventKinds.filter((k) => k === "recallRecover")).toHaveLength(1);
  });

  it("[分割不変] 回復 tick ちょうどで区切っても state が一致する", () => {
    const state = twoTechBoard();
    const ctx = createAdvanceContext(state, certainContent(720));
    const whole = advance(state, ctx, 1440);
    const split = advance(advance(state, ctx, 720), ctx, 1440);
    expect(json(split)).toBe(json(whole));
  });

  it("[分割不変] 想起困難 + 定着 + bond が同時に動く区間を刻んでも一致する", () => {
    const base = certainContent(720);
    const c: EngineContent = {
      ...base,
      coarseTickMinutes: 10,
      recallRisk: { ...base.recallRisk, masteryGainPerFieldWorkDayFix: fixFromRaw(14_400) },
    };
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      resource("wStock", WOOD),
      {
        kind: "research",
        id: id("rHearth"),
        techId: TECH_HEARTH.id,
        progress: fixFromInt(10),
        completedTick: 0,
      },
      research("sForge", TECH_FORGE.id),
    ]);
    const ctx = createAdvanceContext(state, c);
    const whole = advance(state, ctx, 3000);
    for (const cut of [10, 720, 721, 1440, 2999]) {
      const split = advance(advance(state, ctx, cut), ctx, 3000);
      expect(json(split)).toBe(json(whole));
    }
  });
});

// ===========================================================================
// 5. (B) 一回性喪失(GDD 7.4)
// ===========================================================================

describe("[M13] 技術喪失の二層(GDD 7.4)", () => {
  function heldBoard(techId: EntityId, researchName = "rHearth"): GameState {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      {
        kind: "research",
        id: id(researchName),
        techId,
        progress: fixFromInt(10),
        completedTick: 0,
      },
    ]);
    // 保持者にする(定着 > 0)。
    const held = setTechMemory(state, techMemoryKeyOf(WORKER, techId), {
      masteryFix: fixFromRaw(100_000),
      impairedUntilTick: 0,
    });
    // 死亡済み(tombstone)にする。
    return {
      ...held,
      entityStateById: new Map(held.entityStateById).set(WORKER, {
        ...requireEntity(held, WORKER, "resident"),
        life: { bornTick: -100, lifespanTick: 100, diedTick: 0 },
      }),
    };
  }

  it("(A) は喪失しても再研究できる(研究が未完了へ戻り loss.irreversible = false)", () => {
    const c = contentWith();
    const state = heldBoard(TECH_HEARTH.id);
    const result = applyTechLossOnDeath(state, c, WORKER, 500);
    expect(result.lost).toEqual([{ techId: TECH_HEARTH.id, irreversible: false }]);
    const research0 = requireEntity(result.state, id("rHearth"), "research");
    expect(research0.completedTick).toBeNull();
    expect(toRaw(research0.progress)).toBe(0);
    expect(research0.loss).toEqual({ tick: 500, irreversible: false, lastHolderId: WORKER });
    // 再研究の対象に残る(GDD 7.4「失っても必ず再取得可能」)。
    expect(currentResearch(result.state)?.id).toBe(id("rHearth"));
  });

  it("(B) は永久喪失し、研究対象から外れる", () => {
    const c = contentWith();
    const state = heldBoard(TECH_FORGE.id, "rForge");
    const result = applyTechLossOnDeath(state, c, WORKER, 700);
    expect(result.lost).toEqual([{ techId: TECH_FORGE.id, irreversible: true }]);
    const research0 = requireEntity(result.state, id("rForge"), "research");
    expect(research0.loss?.irreversible).toBe(true);
    expect(currentResearch(result.state)).toBeUndefined();
  });

  it("記録(成文化)が 1 枚でも残っていれば喪失しない", () => {
    const c = contentWith();
    const base = heldBoard(TECH_HEARTH.id);
    const withRecord: GameState = {
      ...base,
      entityStateById: new Map(base.entityStateById).set(id("cRecord"), {
        kind: "codify",
        id: id("cRecord"),
        techId: TECH_HEARTH.id,
        medium: "stoneTablet",
        requiredWork: fixFromInt(1),
        progress: fixFromInt(1),
        completedTick: 10,
      }),
    };
    const result = applyTechLossOnDeath(withRecord, c, WORKER, 500);
    expect(result.lost).toEqual([]);
    expect(requireEntity(result.state, id("rHearth"), "research").completedTick).toBe(0);
  });

  it("生存保持者が残っていれば喪失しない", () => {
    const c = contentWith();
    const base = heldBoard(TECH_HEARTH.id);
    const withOther = setTechMemory(
      {
        ...base,
        entityStateById: new Map(base.entityStateById).set(
          WORKER2,
          resident("bMina", { assignedFacilityId: id("fHearth") }),
        ),
      },
      techMemoryKeyOf(WORKER2, TECH_HEARTH.id),
      { masteryFix: fixFromRaw(50_000), impairedUntilTick: 0 },
    );
    expect(techHoldersOf(withOther, TECH_HEARTH.id)).toEqual([WORKER2]);
    expect(applyTechLossOnDeath(withOther, c, WORKER, 500).lost).toEqual([]);
  });

  it("定着 0(実地稼働していない)tech は保持していないので喪失対象にならない", () => {
    const c = contentWith();
    const base = heldBoard(TECH_HEARTH.id);
    const zeroed = setTechMemory(base, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: FIX_ZERO,
      impairedUntilTick: 800,
    });
    expect(heldTechIdsOf(zeroed, WORKER)).toEqual([]);
    expect(applyTechLossOnDeath(zeroed, c, WORKER, 500).lost).toEqual([]);
  });

  it("生存している住民に対して呼ぶと reject する(死亡処理の後に呼ぶ契約)", () => {
    const c = contentWith();
    const state = hearthBoard();
    expect(() => applyTechLossOnDeath(state, c, WORKER, 100)).toThrow();
  });
});

// ===========================================================================
// 6. memoir / bond の tick 結線(M12 の純関数を scheduler へ)
// ===========================================================================

describe("[M13] memoir / bond の tick 結線", () => {
  /** 寝床 + townParams + 2 人共働、片方が tick 500 で死ぬ盤面。 */
  function mortalCoworkBoard(deathTick = 500): GameState {
    return stateOf([
      residentDyingAt("aRui", deathTick, 500),
      resident("bMina", { assignedFacilityId: id("fHearth"), morale: fixFromInt(80) }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      // 寝床 Lv1 = 2 床 → 人口下限 = min(ceil(2 × 0.5), 6) = 1。生存 2 人なので
      // 1 人の死亡は下限ゲート(GDD 7.6)に掛からず成立する。
      facility("fBunks", BUNKS.id, 0, [], 1),
      resource("wStock", WOOD),
    ]);
  }

  function mortalContent(): EngineContent {
    const town = townContent();
    return {
      ...town,
      techDefs: contentWith().techDefs,
      // 加入で人が増えると盤面が読みにくくなるので周期を地平線より後ろへ。
      town: { ...town.town!, arrivalIntervalTicks: 1_000_000 },
    };
  }

  it("bond が tick ループで蓄積する((A) 区間の閉形式)", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      resource("wStock", WOOD),
    ]);
    const after = advance(state, createAdvanceContext(state, contentWith()), 1440);
    // per-tick raw 694 × 1440 = 999_360(1 日あたり ≈ +1.0)。
    expect(toRaw(bondValueOf(after, WORKER, WORKER2))).toBe(999_360);
  });

  it("節目に到達すると両者の memoirLog へ bondMilestone が付く(記録 tick は解析値)", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      resource("wStock", WOOD),
    ]);
    const tier1 = BOND_MILESTONE_TIER_FIXES[0];
    if (tier1 === undefined) throw new Error("テスト前提: 節目が無い");
    const after = advance(state, createAdvanceContext(state, contentWith()), 20_000);
    const entryA = memoirLogOf(after, WORKER)?.entries.find((e) => e.kind === "bondMilestone");
    const entryB = memoirLogOf(after, WORKER2)?.entries.find((e) => e.kind === "bondMilestone");
    expect(entryA?.kind).toBe("bondMilestone");
    expect(entryB?.kind).toBe("bondMilestone");
    if (entryA?.kind === "bondMilestone") {
      // ceil(10e6 / 694) = 14410。区間の終端ではなく到達 tick が入る。
      expect(entryA.tick).toBe(14_410);
      expect(entryA.tier).toBe(1);
      expect(entryA.partnerId).toBe(WORKER2);
    }
  });

  it("[分割不変] 節目到達 tick ちょうどで区切っても memoirLog が一致する", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      resource("wStock", WOOD),
    ]);
    const ctx = createAdvanceContext(state, contentWith());
    const whole = advance(state, ctx, 20_000);
    for (const cut of [14_409, 14_410, 14_411, 15_000]) {
      const split = advance(advance(state, ctx, cut), ctx, 20_000);
      expect(json(split)).toBe(json(whole));
    }
  });

  it("死亡で本人の death 記録・相方の partnerLost 記録・士気ペナが入る(段70)", () => {
    const state = mortalCoworkBoard(500);
    const c = mortalContent();
    const report = advanceWithReport(state, createAdvanceContext(state, c), 1000);
    expect(report.residentDeathCount).toBe(1);

    const deadLog = memoirLogOf(report.state, WORKER);
    expect(deadLog?.entries.some((e) => e.kind === "death")).toBe(true);

    const survivorLog = memoirLogOf(report.state, WORKER2);
    const lost = survivorLog?.entries.find((e) => e.kind === "partnerLost");
    expect(lost?.kind).toBe("partnerLost");
    if (lost?.kind === "partnerLost") {
      expect(lost.tick).toBe(500);
      expect(lost.partnerId).toBe(WORKER);
    }
    // bond 値の 50% が一時士気ペナ(GDD 7.3 [2026-07-30裁定])。
    const survivor = requireEntity(report.state, WORKER2, "resident");
    expect(toRaw(survivor.morale)).toBeLessThan(toRaw(fixFromInt(80)));
  });

  it("[分割不変] 死亡 tick ちょうどで区切っても state が一致する", () => {
    const state = mortalCoworkBoard(500);
    const ctx = createAdvanceContext(state, mortalContent());
    const whole = advance(state, ctx, 1000);
    for (const cut of [499, 500, 501]) {
      const split = advance(advance(state, ctx, cut), ctx, 1000);
      expect(json(split)).toBe(json(whole));
    }
  });

  it("[分割不変] 技術喪失が起きる死亡 tick ちょうどで区切っても一致する", () => {
    const base = mortalCoworkBoard(500);
    const withResearch: GameState = {
      ...base,
      entityStateById: new Map(base.entityStateById).set(id("rHearth"), {
        kind: "research",
        id: id("rHearth"),
        techId: TECH_HEARTH.id,
        progress: fixFromInt(10),
        completedTick: 0,
      }),
    };
    const held = setTechMemory(withResearch, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: fixFromRaw(100_000),
      impairedUntilTick: 0,
    });
    const ctx = createAdvanceContext(held, mortalContent());
    const whole = advanceWithReport(held, ctx, 1000);
    expect(whole.techLossCount).toBe(1);
    expect(whole.irreversibleTechLossCount).toBe(0);
    expect(requireEntity(whole.state, id("rHearth"), "research").loss?.tick).toBe(500);
    for (const cut of [499, 500, 501]) {
      const split = advance(advance(held, ctx, cut), ctx, 1000);
      expect(json(split)).toBe(json(whole.state));
    }
  });

  it("bond の共働レートは tick ループの区間境界で再評価される(死亡で 0 になる)", () => {
    const state = mortalCoworkBoard(500);
    const c = mortalContent();
    const ctx = createAdvanceContext(state, c);
    const after = advance(state, ctx, 1000);
    // [0,500) の 500 tick 分だけ蓄積し、死亡後は増えない。
    const rates = computeBondRates(state, 0);
    expect(rates.entries).toHaveLength(1);
    expect(toRaw(bondValueOf(after, WORKER, WORKER2))).toBe(694 * 500);
  });
});

// ===========================================================================
// 7. 直列化の往復(新フィールド)
// ===========================================================================

describe("[M13] 直列化", () => {
  it("techMemoryByKey が空ならキーごと省略される(既存セーブのバイト列不変)", () => {
    const json0 = toSerializable(hearthBoard());
    expect("techMemoryByKey" in json0).toBe(false);
  });

  it("techMemory / research.loss を持つ state が往復でバイト同一", () => {
    const base = heldLossState();
    const round = json(base);
    expect(round).toBe(json(base));
    expect("techMemoryByKey" in toSerializable(base)).toBe(true);
  });

  function heldLossState(): GameState {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
      {
        kind: "research",
        id: id("rHearth"),
        techId: TECH_HEARTH.id,
        progress: FIX_ZERO,
        completedTick: null,
        loss: { tick: 42, irreversible: true, lastHolderId: WORKER },
      },
    ]);
    return setTechMemory(state, techMemoryKeyOf(WORKER, TECH_HEARTH.id), {
      masteryFix: fixFromRaw(123),
      impairedUntilTick: 77,
    });
  }
});
