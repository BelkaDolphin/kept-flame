// ---------------------------------------------------------------------------
// [M11] 人口下限保証と獲得/規模 — GDD 7.6 / 7.7 / 11.4-9 / 11.7
//
// 中心の検収条件は **「人口が全 tick で min(寝床×0.5, 6) 以上」**(GDD 11.4-9)。
// これを「たまたま満たした」ではなく **構造的に満たす**ことを見るため、
//   T1: 開始時に 人口 >= 下限 なら全 tick で 人口 >= 下限
//   T2: 開始時に 人口 < 下限 でも人口は減らない(全ての死亡が延期される)
// の 2 つを、1 tick ずつ進めて**全 tick を実際に走査して**検証する。
//
// 併せて T5 の中心不変条件である分割不変性
// (advance(0→T2) == advance(0→T1)+advance(T1→T2))を、加入 tick ちょうど・
// 死亡 tick ちょうどを含む区切りで固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { advance, advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import { fixFromInt } from "../../src/engine/fp";
import {
  applyArrival,
  applyResidentDeath,
  arrivalIntervalTicksOf,
  arrivalResidentIdOf,
  bedCapacityOf,
  livingPopulationOf,
  nextArrivalTick,
  nextArrivalTickAtOrAfter,
  populationFloorOf,
  populationViewOf,
} from "../../src/engine/rules/population";
import { computeProductionRates } from "../../src/engine/rules/production";
import { deathTickOf } from "../../src/engine/rules/lifespan";
import type { AdvanceContext, EngineContent } from "../../src/engine/rules/types";
import { requireEntity, type GameState } from "../../src/engine/state/state";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import { content, facility, HEARTH, id, resource, resident, stateOf, WOOD } from "./fixtures";
import {
  agedResident,
  bunksOnlyContent,
  BUNKS_ID,
  eid,
  residentDyingAt,
  townContent,
} from "./lifespanFixtures";

function ctxOf(state: GameState, engineContent: EngineContent): AdvanceContext {
  return createAdvanceContext(state, engineContent);
}

/** 1 tick ずつ進めながら各 tick の生存人口を記録する(全 tick 走査)。 */
function livingByTick(state: GameState, engineContent: EngineContent, toTick: number): number[] {
  const ctx = ctxOf(state, engineContent);
  const series: number[] = [livingPopulationOf(state)];
  let current = state;
  for (let tick = current.tick + 1; tick <= toTick; tick++) {
    current = advance(current, ctx, tick);
    series.push(livingPopulationOf(current));
  }
  return series;
}

// --- 1. 寝床上限と人口下限の式(GDD 7.6 §2)-------------------------------

describe("[M11] 寝床上限(GDD 7.7)", () => {
  it("bedCapacityByLevel を持つ施設の Lv 別値を合計する", () => {
    const state = stateOf([facility("bunksA", BUNKS_ID, 0, [], 1)]);
    expect(bedCapacityOf(state, townContent())).toBe(2);

    const bigger = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      facility("bunksB", BUNKS_ID, 1, [], 3),
    ]);
    expect(bedCapacityOf(bigger, townContent())).toBe(16);
  });

  it("寝床を持たない施設は 0 として無視される(既存 content が該当)", () => {
    const state = stateOf([facility("hearthA", HEARTH.id, 0)]);
    expect(bedCapacityOf(state, townContent())).toBe(0);
  });

  it("Lv が寝床カーブの範囲外なら黙って 0 にせず停止する", () => {
    const state = stateOf([facility("bunksA", BUNKS_ID, 0, [], 9)]);
    expect(() => bedCapacityOf(state, townContent())).toThrow(/寝床上限が定義に無い/);
  });
});

describe("[M11] 人口下限 min(寝床 × 0.5, 6)(GDD 7.6 / 11.4-9)", () => {
  const c = townContent();

  it("整数化は ceil(人口は整数なので「>= 2.5」は「>= 3」と同値)", () => {
    expect(populationFloorOf(0, c)).toBe(0);
    expect(populationFloorOf(1, c)).toBe(1);
    expect(populationFloorOf(4, c)).toBe(2);
    expect(populationFloorOf(5, c)).toBe(3);
    expect(populationFloorOf(11, c)).toBe(6);
  });

  it("6 で頭打ちになる(GDD 7.6 の絶対保証)", () => {
    expect(populationFloorOf(12, c)).toBe(6);
    expect(populationFloorOf(40, c)).toBe(6);
  });

  it("townParams が無い content では下限が 0(M11 が不活性)", () => {
    expect(populationFloorOf(40, content())).toBe(0);
  });
});

// --- 2. 加入グリッド(GDD 7.7 §4)------------------------------------------

describe("[M11] 晴天漂着の加入グリッド", () => {
  it("周期の倍数に固定され、tick 0 では起きない", () => {
    expect(nextArrivalTickAtOrAfter(0, 100)).toBe(100);
    expect(nextArrivalTickAtOrAfter(1, 100)).toBe(100);
    expect(nextArrivalTickAtOrAfter(100, 100)).toBe(100);
    expect(nextArrivalTickAtOrAfter(101, 100)).toBe(200);
    expect(nextArrivalTickAtOrAfter(999, 100)).toBe(1000);
  });

  it("人口が下限を下回ると周期が短くなる(GDD 7.6 の頻度 ×1.5)", () => {
    const c = townContent();
    // 寝床 10 → 下限 5。住民 3 人 = 不足。
    const scarce = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      resident("residentA"),
      resident("residentB"),
      resident("residentC"),
    ]);
    expect(populationViewOf(scarce, c).scarce).toBe(true);
    expect(arrivalIntervalTicksOf(scarce, c)).toBe(66);
    expect(nextArrivalTick(scarce, c, 0)).toBe(66);

    const enough = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      resident("residentA"),
      resident("residentB"),
      resident("residentC"),
      resident("residentD"),
      resident("residentE"),
    ]);
    expect(populationViewOf(enough, c).scarce).toBe(false);
    expect(arrivalIntervalTicksOf(enough, c)).toBe(100);
  });

  it("寝床上限 0 / townParams 不在なら加入判定そのものが積まれない(不活性)", () => {
    const noBeds = stateOf([facility("hearthA", HEARTH.id, 0), resident("residentA")]);
    expect(nextArrivalTick(noBeds, townContent(), 0)).toBeNull();

    const withBeds = stateOf([facility("bunksA", BUNKS_ID, 0, [], 1)]);
    expect(nextArrivalTick(withBeds, bunksOnlyContent(), 0)).toBeNull();
  });
});

describe("[M11] applyArrival(GDD 7.7 寝床上限内の決定論的定期加入)", () => {
  const c = townContent();

  it("空きがあれば 1 人増え、ID は加入 tick から決まる", () => {
    const state = stateOf([facility("bunksA", BUNKS_ID, 0, [], 1)]);
    const result = applyArrival(state, ctxOf(state, c), 100);
    expect(result.arrivedId).toBe(arrivalResidentIdOf(100));
    expect(result.arrivedId).toBe("residentDrift100");
    expect(livingPopulationOf(result.state)).toBe(1);

    const arrived = requireEntity(result.state, eid("residentDrift100"), "resident");
    expect(arrived.life).not.toBeUndefined();
    expect(arrived.life?.diedTick).toBeNull();
    // 加入した tick より後に死ぬ(必ず 1 tick 以上生きる)。
    expect(
      deathTickOf(arrived.life ?? { bornTick: 0, lifespanTick: 0, diedTick: null }),
    ).toBeGreaterThan(100);
    // 人物像は中立(memoirLog / trait 抽選は M12 以降)。
    expect(arrived.traitIds).toEqual([]);
    expect(arrived.stats).toBeUndefined();
    expect(arrived.assignedFacilityId).toBeNull();
  });

  it("寝床が埋まっていれば誰も増えない", () => {
    // 寝床 Lv1 = 2 床、住民 2 人。
    const state = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 1),
      resident("residentA"),
      resident("residentB"),
    ]);
    const result = applyArrival(state, ctxOf(state, c), 100);
    expect(result.arrivedId).toBeNull();
    expect(result.state).toBe(state);
  });

  it("死者は寝床を占有しない(tombstone は人口に数えない)", () => {
    const state = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 1),
      agedResident("residentA", 0, 500),
      residentDyingAt("residentB", 10, 500),
    ]);
    const ctx = ctxOf(state, c);
    const afterDeath = applyResidentDeath(state, ctx, eid("residentB"), 10);
    expect(afterDeath.died).toBe(true);
    expect(livingPopulationOf(afterDeath.state)).toBe(1);
    const result = applyArrival(afterDeath.state, ctx, 100);
    expect(result.arrivedId).not.toBeNull();
  });
});

// --- 3. 死亡と人口下限ゲート(GDD 7.6 §3)---------------------------------

describe("[M11] applyResidentDeath", () => {
  it("死亡すると tombstone になり、就労参照が掃除される", () => {
    // 寝床なし = 下限 0 なので死亡が許される。
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA")]),
      residentDyingAt("residentA", 10),
      resource("resourceWood", WOOD),
    ]);
    const ctx = ctxOf(state, townContent());
    const before = computeProductionRates(state, ctx);
    expect(before.resourceRateByResourceId.size).toBe(1);

    const result = applyResidentDeath(state, ctx, eid("residentA"), 10);
    expect(result.died).toBe(true);
    expect(result.deferredByFloor).toBe(false);

    const dead = requireEntity(result.state, eid("residentA"), "resident");
    expect(dead.life?.diedTick).toBe(10);
    expect(dead.assignedFacilityId).toBeNull();
    expect(requireEntity(result.state, eid("hearthA"), "facility").workerIds).toEqual([]);
    expect(livingPopulationOf(result.state)).toBe(0);

    // レートが落ちる = 死亡が (B) レート変化イベントであることの実体。
    const after = computeProductionRates(result.state, ctx);
    expect(after.resourceRateByResourceId.size).toBe(0);
  });

  it("人口下限を割る死は延期され、state が 1 bit も動かない", () => {
    // 寝床 10 → 下限 5。住民ちょうど 5 人。
    const state = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      residentDyingAt("residentA", 10),
      agedResident("residentB", 0, 5000),
      agedResident("residentC", 0, 5000),
      agedResident("residentD", 0, 5000),
      agedResident("residentE", 0, 5000),
    ]);
    const result = applyResidentDeath(state, ctxOf(state, townContent()), eid("residentA"), 10);
    expect(result.died).toBe(false);
    expect(result.deferredByFloor).toBe(true);
    expect(result.state).toBe(state);
    expect(livingPopulationOf(result.state)).toBe(5);
  });

  it("既に死亡している住民への二重適用は何もしない", () => {
    const state = stateOf([residentDyingAt("residentA", 10)]);
    const ctx = ctxOf(state, townContent());
    const first = applyResidentDeath(state, ctx, eid("residentA"), 10);
    const second = applyResidentDeath(first.state, ctx, eid("residentA"), 20);
    expect(second.died).toBe(false);
    expect(second.state).toBe(first.state);
    expect(requireEntity(second.state, eid("residentA"), "resident").life?.diedTick).toBe(10);
  });

  it("寿命を持たない住民への死亡処理は黙って通さない", () => {
    const state = stateOf([resident("residentA")]);
    expect(() =>
      applyResidentDeath(state, ctxOf(state, townContent()), eid("residentA"), 10),
    ).toThrow(/寿命\(life\)を持たない/);
  });
});

// --- 4. 検収条件: 全 tick で人口 >= 下限(GDD 11.4-9)----------------------

/** 寝床 Lv5(10床・下限 5)に 5 人。各人の寿命が順に切れていく盤面。 */
function floorScenario(): GameState {
  return stateOf([
    facility("bunksA", BUNKS_ID, 0, [], 5),
    residentDyingAt("residentA", 50),
    residentDyingAt("residentB", 120),
    residentDyingAt("residentC", 300),
    residentDyingAt("residentD", 700),
    residentDyingAt("residentE", 900),
  ]);
}

describe("[M11][検収] 人口が全 tick で min(寝床×0.5, 6) 以上(GDD 11.4-9)", () => {
  it("T1: 開始時に下限以上なら、全 tick で下限以上", () => {
    const c = townContent();
    const state = floorScenario();
    const floor = populationViewOf(state, c).floor;
    expect(floor).toBe(5);

    const series = livingByTick(state, c, 1000);
    expect(series).toHaveLength(1001);
    for (let tick = 0; tick < series.length; tick++) {
      expect({ tick, living: series[tick] }).toEqual({ tick, living: expect.any(Number) });
      expect(series[tick] ?? 0).toBeGreaterThanOrEqual(floor);
    }
  });

  it("寿命は取り消されていない(下限を上回った tick で実際に死ぬ)", () => {
    const c = townContent();
    const report = advanceWithReport(floorScenario(), ctxOf(floorScenario(), c), 1000);
    expect(report.residentDeathCount).toBeGreaterThan(0);
    expect(report.deferredDeathCount).toBeGreaterThan(0);
    expect(report.residentArrivalCount).toBeGreaterThan(0);
    // 死者と加入者が釣り合い、人口は下限を保つ。
    expect(livingPopulationOf(report.state)).toBeGreaterThanOrEqual(5);
  });

  it("同一 tick では 加入(段65)→ 死亡(段70)の順で処理される(同 tick 救済)", () => {
    // tick 50 の死亡は下限のため延期され、加入 tick 100 で救済されて成立する。
    const c = townContent();
    const state = floorScenario();
    const ctx = ctxOf(state, c);
    const at99 = advance(state, ctx, 100);
    expect(requireEntity(at99, eid("residentA"), "resident").life?.diedTick).toBeNull();

    const at101 = advance(state, ctx, 101);
    expect(requireEntity(at101, eid("residentA"), "resident").life?.diedTick).toBe(100);
    // 加入が先に効いているので、死亡直後でも人口は下限のまま。
    expect(livingPopulationOf(at101)).toBe(5);
    expect(requireEntity(at101, eid("residentDrift100"), "resident").kind).toBe("resident");
  });

  it("T2: 開始時に下限未満でも人口は減らず、加入で下限まで回復する", () => {
    const c = townContent();
    // 寝床 10 → 下限 5。住民 3 人(全員すでに寿命切れ)。
    const state = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      residentDyingAt("residentA", 10),
      residentDyingAt("residentB", 20),
      residentDyingAt("residentC", 30),
    ]);
    const floor = populationViewOf(state, c).floor;
    expect(floor).toBe(5);
    expect(populationViewOf(state, c).scarce).toBe(true);

    const series = livingByTick(state, c, 1000);
    // (1) 開始人口を下回らない
    for (const living of series) expect(living).toBeGreaterThanOrEqual(3);
    // (2) 下限まで回復する
    expect(Math.max(...series)).toBeGreaterThanOrEqual(floor);
    // (3) 一度下限へ到達したら以後は下限を割らない
    const firstAtFloor = series.findIndex((living) => living >= floor);
    expect(firstAtFloor).toBeGreaterThan(0);
    for (let tick = firstAtFloor; tick < series.length; tick++) {
      expect(series[tick] ?? 0).toBeGreaterThanOrEqual(floor);
    }
  });

  it("寝床を増築して下限が跳ね上がった状態でも人口は減らない", () => {
    // 寝床 12 床 → 下限 6。住民 2 人(寿命切れ)= 下限を大きく下回る。
    const c = townContent();
    const state = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      facility("bunksB", BUNKS_ID, 1, [], 1),
      residentDyingAt("residentA", 5),
      residentDyingAt("residentB", 15),
    ]);
    expect(populationViewOf(state, c).floor).toBe(6);
    const series = livingByTick(state, c, 600);
    for (const living of series) expect(living).toBeGreaterThanOrEqual(2);
    expect(Math.max(...series)).toBeGreaterThanOrEqual(6);
  });
});

// --- 5. 分割不変性(T5 の中心不変条件)------------------------------------

describe("[M11] 分割不変性(加入 tick・死亡 tick ちょうどで区切っても一致)", () => {
  const c = townContent();

  function serialized(state: GameState): string {
    return JSON.stringify(toSerializable(state));
  }

  it.each([1, 49, 50, 51, 66, 99, 100, 101, 120, 199, 200, 333, 700, 999])(
    "advance(0→1000) == advance(0→%i)+advance(%i→1000)",
    (splitTick) => {
      const state = floorScenario();
      const ctx = ctxOf(state, c);
      const oneShot = advance(state, ctx, 1000);
      const split = advance(advance(state, ctx, splitTick), ctx, 1000);
      expect(serialized(split)).toBe(serialized(oneShot));
    },
  );

  it("回帰: 同一 advance の中で「加入 → その住民が寿命死」まで到達する", () => {
    // buildEventQueue は advance の入口で 1 回しか走らないため、加入処理の中で
    // 新住民の死亡イベントを積まないと、この死亡が一括実行でだけ落ちる
    // (= 分割不変性が壊れる)。実装時に実際に踏んだバグの検出器。
    const state = floorScenario();
    const ctx = ctxOf(state, c);
    const oneShot = advanceWithReport(state, ctx, 1000);
    const arrivedThenDied = [...oneShot.state.entityStateById.values()].filter(
      (entity) =>
        entity.kind === "resident" &&
        entity.id.startsWith("residentDrift") &&
        entity.life?.diedTick !== null &&
        entity.life !== undefined,
    );
    expect(arrivedThenDied.length).toBeGreaterThan(0);
  });

  it("1 tick ずつ 1000 回進めても一括と一致する", () => {
    const state = floorScenario();
    const ctx = ctxOf(state, c);
    let stepwise = state;
    for (let tick = 1; tick <= 1000; tick++) {
      stepwise = advance(stepwise, ctx, tick);
    }
    expect(serialized(stepwise)).toBe(serialized(advance(state, ctx, 1000)));
  });

  it("生涯を持つ住民のセーブ往復がバイト同一(life の直列化)", () => {
    const state = advance(floorScenario(), ctxOf(floorScenario(), c), 1000);
    const json = toSerializable(state);
    expect(toSerializable(fromSerializable(json))).toEqual(json);
    expect(JSON.stringify(toSerializable(fromSerializable(json)))).toBe(JSON.stringify(json));
  });
});

// --- 6. 不活性(golden vector 不変の根拠)---------------------------------

describe("[M11] townParams があっても寝床が無ければ完全に不活性", () => {
  /** M11 以前と同型の盤面(住民は life を持たない・寝床施設も無い)。 */
  function legacyBoard(): GameState {
    return stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
      facility("hearthB", HEARTH.id, 1, [eid("residentC")]),
      resident("residentA"),
      resident("residentB"),
      resident("residentC", { morale: fixFromInt(20) }),
      resource("resourceWood", WOOD),
    ]);
  }

  it("townParams の有無で state もカウンタも 1 bit も変わらない", () => {
    const board = legacyBoard();
    const withoutTown = advanceWithReport(board, ctxOf(board, content()), 4320);
    const withTown = advanceWithReport(board, ctxOf(board, townContent()), 4320);

    expect(JSON.stringify(toSerializable(withTown.state))).toBe(
      JSON.stringify(toSerializable(withoutTown.state)),
    );
    expect(withTown.segmentCount).toBe(withoutTown.segmentCount);
    expect(withTown.stochasticStepCount).toBe(withoutTown.stochasticStepCount);
    expect(withTown.stochasticTrialCount).toBe(withoutTown.stochasticTrialCount);
    expect(withTown.rateChangeEventCount).toBe(withoutTown.rateChangeEventCount);
    expect(withTown.recallOccurrenceCount).toBe(withoutTown.recallOccurrenceCount);
  });

  it("寿命の無い住民は死なず、加入も起きない", () => {
    const board = legacyBoard();
    const report = advanceWithReport(board, ctxOf(board, townContent()), 4320);
    expect(report.residentDeathCount).toBe(0);
    expect(report.deferredDeathCount).toBe(0);
    expect(report.residentArrivalCount).toBe(0);
    expect(livingPopulationOf(report.state)).toBe(3);
  });

  it("寝床施設はあるが townParams が無い content でも不活性", () => {
    const board = stateOf([
      facility("bunksA", BUNKS_ID, 0, [], 5),
      residentDyingAt("residentA", 50),
    ]);
    const report = advanceWithReport(board, ctxOf(board, bunksOnlyContent()), 1000);
    expect(report.residentArrivalCount).toBe(0);
    // 下限 0 なので死亡自体は起きる(不活性なのは加入側)。
    expect(report.residentDeathCount).toBe(1);
  });
});

// --- 7. 死者の扱い ---------------------------------------------------------

describe("[M11] 死者は生産にも想起困難の判定にも参加しない", () => {
  it("死者は稼働就労者から外れ、(C) の試行ペアからも外れる", () => {
    const c = townContent();
    // 下限 0(寝床なし)の盤面で確実に死なせる。
    const state = stateOf([
      facility("studyDeskA", id("studyDesk"), 0, [eid("residentA"), eid("residentB")]),
      residentDyingAt("residentA", 100),
      agedResident("residentB", 0, 100_000),
      {
        kind: "research",
        id: eid("researchFire"),
        techId: id("techBronze"),
        progress: fixFromInt(0),
        completedTick: null,
      },
    ]);
    const ctx = ctxOf(state, c);

    // tick 100 の粗粒度ステップ(段24)は死亡(段70)より**前**に走るので、
    // 死亡が試行数へ効き始めるのは次のステップ(110)から。境界を跨がないよう
    // 110 で切って比較する。
    const before = advanceWithReport(state, ctx, 110);
    const after = advanceWithReport(state, ctx, 200);
    expect(after.residentDeathCount).toBe(1);

    // 死亡前の粗粒度ステップは住民 2 人ぶんの試行を引いている。
    const trialsBefore = before.stochasticTrialCount / before.stochasticStepCount;
    expect(trialsBefore).toBe(2);
    const afterSteps = after.stochasticStepCount - before.stochasticStepCount;
    const afterTrials = after.stochasticTrialCount - before.stochasticTrialCount;
    expect(afterTrials / afterSteps).toBe(1);

    // 就労参照も掃除されている。
    expect(requireEntity(after.state, eid("studyDeskA"), "facility").workerIds).toEqual([
      eid("residentB"),
    ]);
  });
});
