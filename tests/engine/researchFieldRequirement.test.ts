import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";
import { FIX_ZERO, fixFromInt, toRaw } from "../../src/engine/fp";
import {
  currentResearch,
  fieldBlockedResearches,
  fieldRequirementRemaining,
  fieldRequirementTicks,
  isFieldRequirementMet,
  ticksUntilResearchCompleteGated,
} from "../../src/engine/rules/research";
import { applyFieldRunProgress, computeFieldRunGains } from "../../src/engine/rules/techMemory";
import type { EngineContent, TechDef } from "../../src/engine/rules/types";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import { getFieldRunTicks, requireEntity, type GameState } from "../../src/engine/state/state";
import { setFieldRunTicks } from "../../src/engine/state/update";
import {
  FORGE,
  HEARTH,
  STUDY_DESK,
  WOOD,
  content as baseContent,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// [M67] 研究ペーシング = 実地要件(GDD 5 / 5.2 の第2ゲート)。
// 2026-08-06裁定・台帳v20 必-1 の最小形。
//
// このファイルが固定するのは 5 点:
//   (1) **不活性の既定** — content に `research.recipeRunTicks` が無ければ
//       蓄積もゲートも一切走らない(= M67 以前と 1 bit も違わない)
//   (2) **ゲートの発火 / 非発火** — 研究点が満了しても実地要件が未達なら完了せず、
//       該当施設が稼働していれば要件充足 tick ちょうどで完了する
//   (3) **分割不変性** — 充足 tick ちょうどで advance を区切っても一括実行と一致する
//   (4) **点の行き先** — 満了して実地要件待ちの研究には研究点が入らず、次の研究へ回る
//       (入り続けるとその run の研究がまるごと止まる)
//   (5) **セーブ往復** — `fieldRunTicksByTechId` が直列化を無損失で往復し、
//       空なら M67 以前とバイト同一
// ---------------------------------------------------------------------------

const WORKER = id("aRui");

/** 実地要件が「かまど」= 3 回(recipeRunTicks 10 なら 30 tick)の tech。 */
const TECH_HEARTH: TechDef = {
  id: id("techHearthCraft"),
  researchCostFix: fixFromInt(10),
  fieldFacilityId: HEARTH.id,
  fieldRequirementCount: 3,
};

/** 実地要件が「鍛冶場」の tech(かまど盤面では永久に満たされない)。 */
const TECH_FORGE: TechDef = {
  id: id("techForgeCraft"),
  researchCostFix: fixFromInt(10),
  fieldFacilityId: FORGE.id,
  fieldRequirementCount: 2,
};

const TECH_DEFS = new Map([
  [TECH_HEARTH.id, TECH_HEARTH],
  [TECH_FORGE.id, TECH_FORGE],
]);

/** 実地要件が不活性な content(M67 以前と同一挙動)。 */
function inactiveContent(): EngineContent {
  return { ...baseContent(), techDefs: TECH_DEFS };
}

/** 実地要件が有効な content(レシピ 1 回 = 10 tick の稼働)。 */
function activeContent(recipeRunTicks = 10): EngineContent {
  return { ...inactiveContent(), research: { recipeRunTicks } };
}

/**
 * 住民 1 人がかまどで働き、研究点を産む書見台にもう 1 人が就く盤面。
 * 研究点は 1 tick あたり `STUDY_DESK` の Lv1 産出ぶん入る。
 */
function board(researchTechId = TECH_HEARTH.id, progressHuman = 0): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    resident("bMina", { assignedFacilityId: id("fDesk") }),
    facility("fHearth", HEARTH.id, 8, [WORKER]),
    facility("fDesk", STUDY_DESK.id, 20, [id("bMina")]),
    resource("wStock", WOOD),
    research("rTarget", researchTechId, progressHuman),
  ]);
}

function json(state: GameState): string {
  return JSON.stringify(toSerializable(state));
}

function completedTickOf(state: GameState, name = "rTarget"): number | null {
  return requireEntity(state, id(name), "research").completedTick;
}

// ===========================================================================
// 1. 不活性の既定(M67 以前と 1 bit も違わない)
// ===========================================================================

describe("[M67] content に research ブロックが無ければ完全に不活性", () => {
  it("fieldRequirementTicks が 0 = 要件なし", () => {
    expect(fieldRequirementTicks(inactiveContent(), TECH_HEARTH.id)).toBe(0);
    expect(fieldRequirementTicks(activeContent(), TECH_HEARTH.id)).toBe(30);
    // 定義に count が無い tech は要件なし(engine のテストフィクスチャ経路)。
    expect(fieldRequirementTicks(activeContent(), id("techUnknown"))).toBe(0);
  });

  it("蓄積レートが空 = fieldRunTicksByTechId にキーが 1 つも生えない", () => {
    const state = board();
    const gains = computeFieldRunGains(state, inactiveContent(), () => true);
    expect(gains).toEqual([]);
    const ctx = createAdvanceContext(state, inactiveContent());
    const next = advance(state, ctx, 200);
    expect(next.fieldRunTicksByTechId.size).toBe(0);
  });

  it("直列化形に fieldRunTicksByTechId キーが現れない(旧セーブとバイト同一)", () => {
    const state = board();
    expect(json(state)).not.toContain("fieldRunTicksByTechId");
    expect(json(fromSerializable(toSerializable(state)))).toBe(json(state));
  });
});

// ===========================================================================
// 2. ゲートの発火 / 非発火
// ===========================================================================

describe("[M67] 実地要件が研究完了をゲートする", () => {
  it("該当施設が稼働していれば要件を満たして完了する(発火しない側)", () => {
    const c = activeContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 200);
    expect(completedTickOf(next)).not.toBeNull();
    // かまどは毎 tick 1 基稼働 = 要件 30 tick は tick 30 で満ちる。
    expect(toRaw(getFieldRunTicks(next, TECH_HEARTH.id) ?? FIX_ZERO)).toBeGreaterThanOrEqual(
      30_000_000,
    );
  });

  it("該当施設が 1 基も稼働していなければ研究点が満了しても完了しない(発火する側)", () => {
    const c = activeContent();
    // 鍛冶場を要求する tech。盤面に鍛冶場は無い = 実地稼働レート 0。
    const state = board(TECH_FORGE.id);
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 2000);
    expect(completedTickOf(next)).toBeNull();
    // 研究点は満了している(= 完了を止めているのは第2ゲートだけ)。
    expect(toRaw(requireEntity(next, id("rTarget"), "research").progress)).toBeGreaterThanOrEqual(
      10_000_000,
    );
    expect(fieldBlockedResearches(next, c).map((r) => r.id)).toEqual([id("rTarget")]);
  });

  it("実地要件を実効化しない content では同じ盤面で完了する(対照)", () => {
    const state = board(TECH_FORGE.id);
    const ctx = createAdvanceContext(state, inactiveContent());
    expect(completedTickOf(advance(state, ctx, 2000))).not.toBeNull();
  });

  it("完了 tick は「研究点満了 tick」と「実地要件充足 tick」の max", () => {
    // 研究点は 1 tick で満了する進行度を与え、実地要件だけを残す。
    const c = activeContent(50); // 3 回 × 50 = 150 tick
    const state = board(TECH_HEARTH.id, 9);
    const ctx = createAdvanceContext(state, c);
    const next = advance(state, ctx, 400);
    expect(completedTickOf(next)).toBe(150);
  });

  it("ticksUntilResearchCompleteGated が max を返し、レート 0 なら null", () => {
    const points = fixFromInt(10);
    const rate = fixFromInt(1);
    // 研究点 10 tick / 実地 4 tick → 10。
    expect(ticksUntilResearchCompleteGated(points, rate, fixFromInt(4), rate)).toBe(10);
    // 研究点 4 tick / 実地 10 tick → 10。
    expect(ticksUntilResearchCompleteGated(fixFromInt(4), rate, points, rate)).toBe(10);
    // 実地レート 0 = 到達しない。
    expect(ticksUntilResearchCompleteGated(points, rate, fixFromInt(4), FIX_ZERO)).toBeNull();
    // 実地要件が既に満ちていれば実地レート 0 でも研究点だけで決まる。
    expect(ticksUntilResearchCompleteGated(points, rate, FIX_ZERO, FIX_ZERO)).toBe(10);
  });
});

// ===========================================================================
// 3. 分割不変性(充足 tick ちょうどで区切る)
// ===========================================================================

describe("[M67] 完了ゲートの分割不変性", () => {
  const c = activeContent(50); // 実地要件 = 150 tick

  function runSplit(state: GameState, splitTick: number, toTick: number): GameState {
    const ctx = createAdvanceContext(state, c);
    const mid = advance(state, ctx, splitTick);
    return advance(mid, createAdvanceContext(mid, c), toTick);
  }

  it("実地要件の充足 tick ちょうどで区切っても一括実行と一致する", () => {
    const state = board(TECH_HEARTH.id, 9);
    const whole = advance(state, createAdvanceContext(state, c), 400);
    expect(json(runSplit(state, 150, 400))).toBe(json(whole));
  });

  it("充足 tick の 1 手前 / 1 手後で区切っても一致する", () => {
    const state = board(TECH_HEARTH.id, 9);
    const whole = advance(state, createAdvanceContext(state, c), 400);
    expect(json(runSplit(state, 149, 400))).toBe(json(whole));
    expect(json(runSplit(state, 151, 400))).toBe(json(whole));
  });

  it("実地要件がずっと未達のまま刻んでも一致する(蓄積は線形)", () => {
    const state = board(TECH_FORGE.id);
    const whole = advance(state, createAdvanceContext(state, c), 500);
    expect(json(runSplit(state, 137, 500))).toBe(json(whole));
  });

  it("applyFieldRunProgress は分割しても総和が一致する(閉形式)", () => {
    const state = board();
    const gains = computeFieldRunGains(state, c, () => true);
    const whole = applyFieldRunProgress(state, gains, 100);
    const split = applyFieldRunProgress(applyFieldRunProgress(state, gains, 37), gains, 63);
    expect(json(split)).toBe(json(whole));
  });
});

// ===========================================================================
// 4. 点の行き先(満了 + 実地要件待ちの研究には入らない)
// ===========================================================================

describe("[M67] 満了して実地要件待ちの研究には研究点が入らない", () => {
  function twoResearchBoard(): GameState {
    return stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fDesk") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      facility("fDesk", STUDY_DESK.id, 20, [id("bMina")]),
      resource("wStock", WOOD),
      // ID 昇順で rBlocked が先。実地要件(鍛冶場)は永久に満たされない。
      research("rBlocked", TECH_FORGE.id, 10),
      research("rNext", TECH_HEARTH.id, 0),
    ]);
  }

  it("currentResearch が満了済みの実地要件待ちを飛ばす(content 付きのときだけ)", () => {
    const state = twoResearchBoard();
    // 引数 1 つ = M67 以前の挙動(ID 昇順の先頭)。
    expect(currentResearch(state)?.id).toBe(id("rBlocked"));
    expect(currentResearch(state, activeContent())?.id).toBe(id("rNext"));
    // 実地要件が不活性な content では飛ばさない。
    expect(currentResearch(state, inactiveContent())?.id).toBe(id("rBlocked"));
  });

  it("研究が止まらず次の tech が完了する(点の吸い込み防止)", () => {
    const c2 = activeContent();
    const state = twoResearchBoard();
    const next = advance(state, createAdvanceContext(state, c2), 500);
    expect(completedTickOf(next, "rNext")).not.toBeNull();
    expect(completedTickOf(next, "rBlocked")).toBeNull();
  });

  it("実地要件が満ちれば、点の行き先から外れていた研究も完了する", () => {
    const c2 = activeContent();
    let state = twoResearchBoard();
    // 鍛冶場を建てて就労させる = 実地稼働レートが立つ。
    state = stateOf([
      ...[...state.entityStateById.values()],
      resident("cSora", { assignedFacilityId: id("fForge") }),
      facility("fForge", FORGE.id, 0, [id("cSora")]),
    ]);
    const next = advance(state, createAdvanceContext(state, c2), 500);
    expect(completedTickOf(next, "rBlocked")).not.toBeNull();
  });
});

// ===========================================================================
// 5. セーブ往復
// ===========================================================================

describe("[M67] fieldRunTicksByTechId の直列化", () => {
  it("非空なら往復して同一(キーは techId 昇順)", () => {
    const state = setFieldRunTicks(board(), [
      [TECH_FORGE.id, fixFromInt(7)],
      [TECH_HEARTH.id, fixFromInt(3)],
    ]);
    expect([...state.fieldRunTicksByTechId.keys()]).toEqual([TECH_FORGE.id, TECH_HEARTH.id]);
    const roundTripped = fromSerializable(toSerializable(state));
    expect(json(roundTripped)).toBe(json(state));
    expect(toRaw(getFieldRunTicks(roundTripped, TECH_HEARTH.id) ?? FIX_ZERO)).toBe(3_000_000);
  });

  it("advance で生えた値も往復する", () => {
    const c = activeContent();
    const state = board();
    const next = advance(state, createAdvanceContext(state, c), 100);
    expect(next.fieldRunTicksByTechId.size).toBeGreaterThan(0);
    expect(json(fromSerializable(toSerializable(next)))).toBe(json(next));
  });

  it("要件の残りと充足判定が state から求まる", () => {
    const c = activeContent();
    const state = setFieldRunTicks(board(), [[TECH_HEARTH.id, fixFromInt(12)]]);
    const target = requireEntity(state, id("rTarget"), "research");
    expect(toRaw(fieldRequirementRemaining(state, c, target))).toBe(18_000_000);
    expect(isFieldRequirementMet(state, c, target)).toBe(false);
    const met = setFieldRunTicks(state, [[TECH_HEARTH.id, fixFromInt(30)]]);
    expect(isFieldRequirementMet(met, c, requireEntity(met, id("rTarget"), "research"))).toBe(true);
  });
});
