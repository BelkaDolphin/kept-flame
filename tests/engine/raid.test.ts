import { describe, expect, it } from "vitest";

import { advance, advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  colonyDefenseFix,
  isPerimeterCell,
  nextRaidTick,
  raidStrengthFix,
  resolveRaid,
} from "../../src/engine/rules/raid";
import type { EngineContent, EraDef, RaidParams, TechDef } from "../../src/engine/rules/types";
import { requireEntity, type GameState } from "../../src/engine/state/state";
import {
  HEARTH,
  STUDY_DESK,
  WATCHTOWER,
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
// [M66] 襲撃(GDD 11.7 段10)と防衛係数(GDD 6.2「見張り台」/ 11.1 の戦闘式)。
//
// このファイルが固定するのは 5 点:
//   (1) 外周セル判定(6×8 格子の x=0/5・y=0/7)と配置ボーナスの掛かり方
//   (2) Σ防衛戦力 = 防衛係数(Lv) × 配置ボーナス の総和
//   (3) 襲撃強度の時代逓増(到達エラ order)
//   (4) 勝敗 = 防衛 + seededRoll >= 強度。負けたら在庫の lootRatio ぶんだけ失う
//       (**住民は死なない / 施設も壊れない** = GDD 11.1 の全滅回避フェイルセーフ)
//   (5) **反証**: 見張り台を外す(または content の raid ブロックを外す)と
//       同じ seed・同じ tick で結果が変わる(= 防衛係数と襲撃機構が実際に効いている)
//   加えて分割不変性(襲撃 tick ちょうどで advance を割っても最終 state が一致)。
// ---------------------------------------------------------------------------

const RAID: RaidParams = {
  intervalTicks: 4320,
  baseStrengthFix: fixFromInt(30),
  strengthGrowthPerEraFix: fixFromInt(25),
  rollRange: 40,
  perimeterDefenseMulFix: fixFromRaw(1_500_000),
  lootRatioFix: fixFromRaw(50_000), // 0.05
};

const RAID_DEFS = new Map([
  [HEARTH.id, HEARTH],
  [STUDY_DESK.id, STUDY_DESK],
  [WATCHTOWER.id, WATCHTOWER],
]);

function raidContent(overrides: Partial<EngineContent> = {}): EngineContent {
  return content({ facilityDefs: RAID_DEFS, raid: RAID, ...overrides });
}

describe("[M66] 外周セル(GDD 6.2「外周ほど防衛係数上昇」の最小解釈)", () => {
  it("6×8 格子の外周(x=0/5・y=0/7)を外周と判定する", () => {
    for (const cell of [0, 5, 6, 11, 42, 47, 1, 46]) {
      expect(isPerimeterCell(cell)).toBe(true);
    }
  });

  it("内側(x=1..4 かつ y=1..6)は外周でない", () => {
    for (const cell of [7, 8, 9, 10, 13, 40]) {
      expect(isPerimeterCell(cell)).toBe(false);
    }
  });

  it("格子外のセル番号は例外", () => {
    expect(() => isPerimeterCell(48)).toThrow();
    expect(() => isPerimeterCell(-1)).toThrow();
  });
});

describe("[M66] Σ防衛戦力(colonyDefenseFix)", () => {
  it("外周の見張り台には配置ボーナスが掛かる", () => {
    const state = stateOf([facility("facilityTowerA", WATCHTOWER.id, 0, [], 1)]);
    // Lv1 = 20、外周ボーナス ×1.5 → 30。
    expect(toRaw(colonyDefenseFix(state, raidContent(), RAID.perimeterDefenseMulFix))).toBe(
      30_000_000,
    );
  });

  it("内側の見張り台は素の防衛係数のまま", () => {
    const state = stateOf([facility("facilityTowerA", WATCHTOWER.id, 7, [], 1)]);
    expect(toRaw(colonyDefenseFix(state, raidContent(), RAID.perimeterDefenseMulFix))).toBe(
      20_000_000,
    );
  });

  it("防衛係数を持たない施設は寄与しない", () => {
    const state = stateOf([facility("facilityHearth", HEARTH.id, 0, [], 1)]);
    expect(toRaw(colonyDefenseFix(state, raidContent(), RAID.perimeterDefenseMulFix))).toBe(0);
  });

  it("Lv を上げると防衛係数が上がる", () => {
    const lv1 = stateOf([facility("facilityTowerA", WATCHTOWER.id, 7, [], 1)]);
    const lv4 = stateOf([facility("facilityTowerA", WATCHTOWER.id, 7, [], 4)]);
    const c = raidContent();
    expect(toRaw(colonyDefenseFix(lv4, c, RAID.perimeterDefenseMulFix))).toBeGreaterThan(
      toRaw(colonyDefenseFix(lv1, c, RAID.perimeterDefenseMulFix)),
    );
  });
});

describe("[M66] 襲撃強度の時代逓増(GDD 11.1)", () => {
  const TECH_E1: TechDef = { id: id("techE1"), researchCostFix: fixFromInt(10), eraId: "e1" };
  const TECH_E2: TechDef = { id: id("techE2"), researchCostFix: fixFromInt(10), eraId: "e2" };
  const ERAS = new Map<string, EraDef>([
    [
      "e1",
      {
        id: "e1",
        order: 1,
        baseEraFix: fixFromInt(30),
        multiplierFix: fixFromInt(1),
        gateTechId: id("techE1"),
        criticalPathMax: 3,
      },
    ],
    [
      "e2",
      {
        id: "e2",
        order: 2,
        baseEraFix: fixFromInt(60),
        multiplierFix: fixFromInt(2),
        gateTechId: id("techE2"),
        criticalPathMax: 3,
      },
    ],
  ]);

  function eraContent(): EngineContent {
    return raidContent({
      techDefs: new Map([
        [TECH_E1.id, TECH_E1],
        [TECH_E2.id, TECH_E2],
      ]),
      eraDefs: ERAS,
    });
  }

  it("到達エラ 1(何も完了していない)なら基準強度", () => {
    const state = stateOf([research("researchE1", TECH_E1.id)]);
    expect(toRaw(raidStrengthFix(state, eraContent()))).toBe(30_000_000);
  });

  it("E2 の tech を完了していると 1 段ぶん逓増する", () => {
    const state = stateOf([
      { ...research("researchE2", TECH_E2.id), completedTick: 10 },
      research("researchE1", TECH_E1.id),
    ]);
    expect(toRaw(raidStrengthFix(state, eraContent()))).toBe(55_000_000);
  });
});

describe("[M66] 襲撃周期(絶対グリッド)", () => {
  it("次の判定 tick は intervalTicks の倍数(tick 0 は判定しない)", () => {
    const c = raidContent();
    expect(nextRaidTick(c, 0)).toBe(4320);
    expect(nextRaidTick(c, 4319)).toBe(4320);
    expect(nextRaidTick(c, 4320)).toBe(4320);
    expect(nextRaidTick(c, 4321)).toBe(8640);
  });

  it("content に raid ブロックが無ければ null(= 一度も襲撃されない)", () => {
    expect(nextRaidTick(content({ facilityDefs: RAID_DEFS }), 0)).toBeNull();
  });
});

describe("[M66] 襲撃の解決と全滅回避フェイルセーフ", () => {
  function board(withTower: boolean): GameState {
    const entities = [
      resident("residentA"),
      facility("facilityHearth", HEARTH.id, 8, [id("residentA")], 1),
      resource("resourceWood", WOOD, 1000),
    ];
    return stateOf(
      withTower ? [...entities, facility("facilityTowerA", WATCHTOWER.id, 0, [], 1)] : entities,
    );
  }

  it("防衛 0 では撃退できず在庫の lootRatio ぶんが略奪される", () => {
    const state = board(false);
    const ctx = createAdvanceContext(state, raidContent());
    const result = resolveRaid(state, ctx, 4320);
    expect(result.repelled).toBe(false);
    // 1000 × 0.05 = 50 を失う。
    expect(toRaw(requireEntity(result.state, id("resourceWood"), "resource").stock)).toBe(
      950_000_000,
    );
    expect(toRaw(result.lootTotalFix)).toBe(50_000_000);
  });

  it("**反証**: 外周に見張り台があると同じ tick・同じ seed で撃退でき在庫が減らない", () => {
    const state = board(true);
    const ctx = createAdvanceContext(state, raidContent());
    const result = resolveRaid(state, ctx, 4320);
    // 防衛 30 ≥ 強度 30 なので seededRoll に依らず撃退。
    expect(result.repelled).toBe(true);
    expect(toRaw(requireEntity(result.state, id("resourceWood"), "resource").stock)).toBe(
      1_000_000_000,
    );
    expect(toRaw(result.lootTotalFix)).toBe(0);
  });

  it("住民は死なず施設も壊れない(全滅回避フェイルセーフ)", () => {
    const state = board(false);
    const ctx = createAdvanceContext(state, raidContent());
    const result = resolveRaid(state, ctx, 4320);
    expect(requireEntity(result.state, id("residentA"), "resident").life).toBeUndefined();
    expect(result.state.entityStateById.size).toBe(state.entityStateById.size);
  });

  it("在庫 0 の資源は負在庫にならない", () => {
    const state = stateOf([resource("resourceWood", WOOD, 0)]);
    const ctx = createAdvanceContext(state, raidContent());
    const result = resolveRaid(state, ctx, 4320);
    expect(toRaw(requireEntity(result.state, id("resourceWood"), "resource").stock)).toBe(0);
  });

  it("raid ブロックが無い content で呼ぶと例外(不活性の明示)", () => {
    const state = board(false);
    const c = content({ facilityDefs: RAID_DEFS });
    const ctx = createAdvanceContext(state, c);
    expect(() => resolveRaid(state, ctx, 4320)).toThrow();
  });
});

describe("[M66] scheduler 段10 への結線", () => {
  function board(): GameState {
    return stateOf([
      resident("residentA"),
      facility("facilityHearth", HEARTH.id, 8, [id("residentA")], 1),
      resource("resourceWood", WOOD, 1000),
    ]);
  }

  it("周期 tick で襲撃が発火しカウンタに乗る", () => {
    const c = raidContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const report = advanceWithReport(state, ctx, 4321);
    expect(report.raidCount).toBe(1);
    expect(report.raidRepelledCount).toBe(0);
  });

  it("周期前は 1 度も発火しない", () => {
    const c = raidContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    expect(advanceWithReport(state, ctx, 4320).raidCount).toBe(0);
  });

  it("**反証**: raid ブロックが無ければ同じ区間で 1 度も発火しない", () => {
    const c = content({ facilityDefs: RAID_DEFS });
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const report = advanceWithReport(state, ctx, 10_000);
    expect(report.raidCount).toBe(0);
  });

  it("分割不変性: 襲撃 tick ちょうどで区切っても最終 state が一致する", () => {
    const c = raidContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const whole = advance(state, ctx, 9000);
    const split = advance(advance(state, ctx, 4320), ctx, 9000);
    expect(toRaw(requireEntity(split, id("resourceWood"), "resource").stock)).toBe(
      toRaw(requireEntity(whole, id("resourceWood"), "resource").stock),
    );
    expect(split.tick).toBe(whole.tick);
  });

  it("複数周期ぶん進めると襲撃回数が周期どおりに増える", () => {
    const c = raidContent();
    const state = board();
    const ctx = createAdvanceContext(state, c);
    const report = advanceWithReport(state, ctx, 4320 * 3 + 1);
    expect(report.raidCount).toBe(3);
  });
});
