import { describe, expect, it } from "vitest";

import { createAdvanceContext } from "../../src/engine/advance";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  activeWorkerCount,
  applyProduction,
  computeProductionRates,
  facilityOutputPerTick,
  isWorkerActive,
} from "../../src/engine/rules/production";
import {
  currentResearch,
  researchRemaining,
  ticksUntilResearchComplete,
} from "../../src/engine/rules/research";
import { recallRiskPerDay, recallTechIds } from "../../src/engine/rules/recall";
import { RulesError } from "../../src/engine/rules/types";
import { requireEntity, type GameState } from "../../src/engine/state/state";
import {
  FORGE,
  HEARTH,
  MEMORY_KEEPER_TRAIT,
  STUDY_DESK,
  TECH_BRONZE,
  TECH_IRON,
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
// 縮約 rules 3 本の式そのもののテスト(統合は advance.test.ts)。
//
// (C) の recallRisk は GDD 11.2 の表を項ごとに固定する。中核ジレンマの数式なので
// 「どの項がどれだけ効くか」を数値で押さえておかないと、バランス調整のときに
// 式の解釈がずれても気づけない。
// ---------------------------------------------------------------------------

const C = content();
const WORKER = id("aRui");

/** 住民 1 人 + 施設 1 基の盤面(loadW の検証用)。 */
function assignedTo(defId: string, overrides: Parameters<typeof resident>[1] = {}): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fWork"), ...overrides }),
    facility("fWork", id(defId), 8, [WORKER]),
    resource("wStock", WOOD),
  ]);
}

function riskOf(state: GameState): number {
  return toRaw(recallRiskPerDay(state, C, requireEntity(state, WORKER, "resident")));
}

describe("(C) recallRisk の各項(GDD 11.2)", () => {
  it("通常業務: base_p 0.05 × loadW 0.5 = 0.025", () => {
    expect(riskOf(assignedTo("hearth"))).toBe(25_000);
  });

  it("過酷業務: base_p 0.05 × loadW 2.0 = 0.10", () => {
    expect(riskOf(assignedTo("forge"))).toBe(100_000);
  });

  it("無配属は loadW = 0(就労していない)", () => {
    const state = stateOf([resident("aRui"), resource("wStock", WOOD)]);
    expect(riskOf(state)).toBe(0);
  });

  it("士気 <30 で +0.10、<15 で +0.20(強い方のみ)", () => {
    expect(riskOf(assignedTo("hearth", { morale: fixFromInt(30) }))).toBe(25_000);
    expect(riskOf(assignedTo("hearth", { morale: fixFromInt(29) }))).toBe(125_000);
    expect(riskOf(assignedTo("hearth", { morale: fixFromInt(15) }))).toBe(125_000);
    expect(riskOf(assignedTo("hearth", { morale: fixFromInt(14) }))).toBe(225_000);
  });

  it("探索派遣中で +0.15", () => {
    expect(riskOf(assignedTo("hearth", { dispatched: true }))).toBe(175_000);
  });

  it("定着度は上限 0.20 で打ち止め、負値は 0 扱い", () => {
    expect(riskOf(assignedTo("forge", { mastery: fixFromRaw(50_000) }))).toBe(50_000);
    // mastery 0.5 は上限 0.20 にクランプ → 0.10 - 0.20 = 負 → 0 へクランプ。
    expect(riskOf(assignedTo("forge", { mastery: fixFromRaw(500_000) }))).toBe(0);
    expect(riskOf(assignedTo("forge", { mastery: fixFromRaw(-100_000) }))).toBe(100_000);
  });

  it("記憶巧者 trait で -0.15", () => {
    const withTrait = assignedTo("forge", {
      morale: fixFromInt(14),
      traitIds: [MEMORY_KEEPER_TRAIT],
    });
    const without = assignedTo("forge", { morale: fixFromInt(14) });
    expect(riskOf(without)).toBe(300_000);
    expect(riskOf(withTrait)).toBe(150_000);
  });

  it("p_max 0.35 でクランプされる", () => {
    const worst = assignedTo("forge", { morale: fixFromInt(10), dispatched: true });
    // 0.10 + 0.20 + 0.15 = 0.45 → 0.35。
    expect(riskOf(worst)).toBe(350_000);
  });

  it("下限 0 でクランプされる", () => {
    expect(riskOf(assignedTo("hearth", { traitIds: [MEMORY_KEEPER_TRAIT] }))).toBe(0);
  });

  it("配属先の定義が content に無ければ例外(黙って 0 にしない)", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fWork") }),
      facility("fWork", id("unknownDef"), 8, [WORKER]),
    ]);
    expect(() => riskOf(state)).toThrow(RulesError);
  });
});

describe("(C) 判定対象の技術", () => {
  it("research entity の techId を ID 昇順で返す", () => {
    const state = stateOf([
      research("sIron", TECH_IRON.id),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
    // research entity の ID 昇順 = rBronze, sIron。
    expect(recallTechIds(state)).toEqual(["techBronze", "techIron"]);
  });

  it("research entity が無ければ空", () => {
    expect(recallTechIds(stateOf([resident("aRui")]))).toEqual([]);
  });
});

describe("(A) 生産レート", () => {
  it("同じ資源へ出す施設のレートは合算される", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("gForge") }),
      facility("fHearth", HEARTH.id, 0, [WORKER]),
      facility("gForge", FORGE.id, 47, [id("bMina")]),
      resource("wStock", WOOD),
    ]);
    const rates = computeProductionRates(state, createAdvanceContext(state, C));
    // かまど 1.0 + 鍛冶場 2.0(隣接していないのでボーナスなし)。
    expect(toRaw(rates.resourceRateByResourceId.get(WOOD) ?? fixFromInt(0))).toBe(3_000_000);
    expect(toRaw(rates.researchRateFix)).toBe(0);
  });

  it("研究机は研究レートへ入る", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fDesk") }),
      facility("fDesk", STUDY_DESK.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    const rates = computeProductionRates(state, createAdvanceContext(state, C));
    expect(toRaw(rates.researchRateFix)).toBe(1_000_000);
    expect(rates.resourceRateByResourceId.size).toBe(0);
  });

  it("就労者ゼロの施設はレートに寄与しない", () => {
    const state = stateOf([facility("fHearth", HEARTH.id, 8, []), resource("wStock", WOOD)]);
    const rates = computeProductionRates(state, createAdvanceContext(state, C));
    expect(rates.resourceRateByResourceId.size).toBe(0);
  });

  it("稼働判定: 派遣中と想起困難中は数えない", () => {
    expect(isWorkerActive(resident("aRui"), 0)).toBe(true);
    expect(isWorkerActive(resident("aRui", { dispatched: true }), 0)).toBe(false);
    const impaired = resident("aRui", { recallImpairedUntilTick: 100 });
    expect(isWorkerActive(impaired, 99)).toBe(false);
    expect(isWorkerActive(impaired, 100)).toBe(true);
    expect(isWorkerActive(impaired, 101)).toBe(true);
  });

  it("activeWorkerCount は state を見て数える", () => {
    const state = stateOf([
      resident("aRui"),
      resident("bMina", { dispatched: true }),
      resident("cSora", { recallImpairedUntilTick: 50 }),
      facility("fHearth", HEARTH.id, 8, [WORKER, id("bMina"), id("cSora")]),
      resource("wStock", WOOD),
    ]);
    const f = requireEntity(state, id("fHearth"), "facility");
    expect(activeWorkerCount(state, f, 0)).toBe(1);
    expect(activeWorkerCount(state, f, 50)).toBe(2);
  });

  it("Lv 別の産出は個別 FP 展開値をそのまま引く", () => {
    expect(toRaw(facilityOutputPerTick(HEARTH, 1))).toBe(1_000_000);
    expect(toRaw(facilityOutputPerTick(HEARTH, 5))).toBe(1_749_006);
    expect(() => facilityOutputPerTick(HEARTH, 0)).toThrow(RulesError);
    expect(() => facilityOutputPerTick(HEARTH, 6)).toThrow(RulesError);
  });

  it("区間長が 1 未満の積分は呼び出し側のバグとして例外", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    const rates = computeProductionRates(state, createAdvanceContext(state, C));
    expect(() => applyProduction(state, rates, 0)).toThrow(RulesError);
    expect(() => applyProduction(state, rates, 1.5)).toThrow(RulesError);
  });
});

describe("(B) 研究完了の予測", () => {
  it("切り上げ: 端数は 1 tick 繰り上がる", () => {
    expect(ticksUntilResearchComplete(fixFromInt(100), fixFromInt(1))).toBe(100);
    expect(ticksUntilResearchComplete(fixFromRaw(100_000_001), fixFromInt(1))).toBe(101);
    expect(ticksUntilResearchComplete(fixFromRaw(1), fixFromInt(1))).toBe(1);
  });

  it("レートが 0 以下なら到達しない(null)", () => {
    expect(ticksUntilResearchComplete(fixFromInt(100), fixFromInt(0))).toBe(null);
    expect(ticksUntilResearchComplete(fixFromInt(100), fixFromInt(-1))).toBe(null);
  });

  it("残りが 0 以下なら現在 tick で完了(0)", () => {
    expect(ticksUntilResearchComplete(fixFromInt(0), fixFromInt(1))).toBe(0);
    expect(ticksUntilResearchComplete(fixFromInt(-5), fixFromInt(1))).toBe(0);
  });

  it("残り = コスト - 進行度", () => {
    const state = stateOf([research("rBronze", TECH_BRONZE.id, 40), resource("wStock", WOOD)]);
    const r = requireEntity(state, id("rBronze"), "research");
    expect(toRaw(researchRemaining(C, r))).toBe(60_000_000);
  });

  it("現在の研究は未完了のうち ID 昇順で最初(単一キュー)", () => {
    const state = stateOf([
      research("sIron", TECH_IRON.id),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
    expect(currentResearch(state)?.id).toBe("rBronze");
    expect(currentResearch(stateOf([resource("wStock", WOOD)]))).toBe(undefined);
  });

  it("tech 定義が content に無ければ例外", () => {
    const state = stateOf([research("rBronze", id("unknownTech"))]);
    const r = requireEntity(state, id("rBronze"), "research");
    expect(() => researchRemaining(C, r)).toThrow(RulesError);
  });
});
