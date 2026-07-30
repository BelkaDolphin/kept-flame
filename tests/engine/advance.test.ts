import { describe, expect, it } from "vitest";

import {
  AdvanceError,
  OFFLINE_CLAMP_TICK,
  advance,
  advanceByElapsedMs,
  advanceWithReport,
  computeTargetTick,
  createAdvanceContext,
  elapsedMsToTickDelta,
} from "../../src/engine/advance";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import { SchedulerError } from "../../src/engine/scheduler";
import { toSerializable } from "../../src/engine/state/serialize";
import { requireEntity, type GameState } from "../../src/engine/state/state";
import { techMemoryOf } from "../../src/engine/rules/techMemory";
import type { EngineContent } from "../../src/engine/rules/types";
import {
  FORGE,
  HEARTH,
  STUDY_DESK,
  TECH_BRONZE,
  TECH_IRON,
  WOOD,
  content,
  facility,
  id,
  matrix,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// tick 前進の統合テスト。縮約 rules 3 本((A)生産 / (B)研究完了 / (C)想起困難)が
// 離散事象スケジューラの上で噛み合うことを確認する。
//
// 決定論の要として固定するのは 4 点:
//   (1) ADR-026 の targetTick 式(経過 ms → tick、72h クランプ)
//   (2) (A) が閉形式であること(レート × 区間長が tick ループと一致)
//   (3) (B) の完了 tick が解析予測どおりで、レート変化で予測が作り直されること
//   (4) **分割不変**: どこで advance を区切っても直列化バイト列が一致する
// ---------------------------------------------------------------------------

const WORKER = id("aRui");
const WORKER2 = id("bMina");

function ctxOf(state: GameState, c: EngineContent = content()) {
  return createAdvanceContext(state, c);
}

function json(state: GameState): string {
  return JSON.stringify(toSerializable(state));
}

function stock(state: GameState, name = "wStock"): number {
  return toRaw(requireEntity(state, id(name), "resource").stock);
}

/** 生産のみ(住民 1 人・かまど 1 基・隣接なし)の最小盤面。 */
function productionState(): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    facility("fHearth", HEARTH.id, 8, [WORKER]),
    resource("wStock", WOOD),
  ]);
}

/** 研究のみ(住民 1 人・研究机 1 基)の盤面。研究点 1.0/tick。 */
function researchState(progressHuman = 0): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fDesk") }),
    facility("fDesk", STUDY_DESK.id, 8, [WORKER]),
    research("rBronze", TECH_BRONZE.id, progressHuman),
    resource("wStock", WOOD),
  ]);
}

describe("ADR-026 targetTick 式", () => {
  it("1 tick = 1 分、端数は切り捨て", () => {
    expect(elapsedMsToTickDelta(0)).toBe(0);
    expect(elapsedMsToTickDelta(59_999)).toBe(0);
    expect(elapsedMsToTickDelta(60_000)).toBe(1);
    expect(elapsedMsToTickDelta(119_999)).toBe(1);
    expect(elapsedMsToTickDelta(120_000)).toBe(2);
  });

  it("小数 ms も決定論的に切り捨てられる", () => {
    expect(elapsedMsToTickDelta(60_000.999)).toBe(1);
    expect(elapsedMsToTickDelta(59_999.999)).toBe(0);
  });

  it("72h でクランプされる(GDD 11.1 / 11.9)", () => {
    const seventyTwoHours = 4320 * 60_000;
    expect(elapsedMsToTickDelta(seventyTwoHours - 1)).toBe(4319);
    expect(elapsedMsToTickDelta(seventyTwoHours)).toBe(OFFLINE_CLAMP_TICK);
    expect(elapsedMsToTickDelta(seventyTwoHours + 60_000)).toBe(OFFLINE_CLAMP_TICK);
    expect(elapsedMsToTickDelta(seventyTwoHours * 100)).toBe(OFFLINE_CLAMP_TICK);
  });

  it("負の経過(巻き戻し)は進まない", () => {
    expect(elapsedMsToTickDelta(-1)).toBe(0);
    expect(elapsedMsToTickDelta(-60_000_000)).toBe(0);
  });

  it("非有限 / 巨大値は例外", () => {
    expect(() => elapsedMsToTickDelta(Number.NaN)).toThrow(AdvanceError);
    expect(() => elapsedMsToTickDelta(Number.POSITIVE_INFINITY)).toThrow(AdvanceError);
    expect(() => elapsedMsToTickDelta(1e300)).toThrow(AdvanceError);
  });

  it("targetTick = startTick + クランプ済み差分", () => {
    expect(computeTargetTick(100, 600_000)).toBe(110);
    expect(computeTargetTick(100, 1e12)).toBe(100 + OFFLINE_CLAMP_TICK);
    expect(() => computeTargetTick(-1, 0)).toThrow(AdvanceError);
    expect(() => computeTargetTick(1.5, 0)).toThrow(AdvanceError);
  });

  it("発火回数に依存しない: 経過が同じなら何回に分けても同じ tick", () => {
    const state = productionState();
    const ctx = ctxOf(state);
    const once = advanceByElapsedMs(state, ctx, 600_000);
    let stepwise = state;
    for (let i = 0; i < 10; i++) stepwise = advanceByElapsedMs(stepwise, ctx, 60_000);
    expect(stepwise.tick).toBe(once.tick);
    expect(json(stepwise)).toBe(json(once));
  });
});

describe("(A) 定常生産区間の閉形式(GDD 11.8(A))", () => {
  it("レート × 区間長 でストックが増える", () => {
    const state = productionState();
    const next = advance(state, ctxOf(state), 100);
    // Lv1 のかまど = 1.0/tick、隣接なし・就労者 1 人 → 100 tick で 100。
    expect(stock(next)).toBe(100_000_000);
    expect(next.tick).toBe(100);
  });

  it("Lv が上がると個別 FP 展開値が使われる", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER], 3),
      resource("wStock", WOOD),
    ]);
    const next = advance(state, ctxOf(state), 10);
    // lvCurve(1)[2] = floor(1e6 * 1.15 * 1.15) = 1_322_500
    expect(stock(next)).toBe(1_322_500 * 10);
  });

  it("就労者数に比例する", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      resource("wStock", WOOD),
    ]);
    expect(stock(advance(state, ctxOf(state), 10))).toBe(20_000_000);
  });

  it("隣接ボーナスが乗る(熱源×熱源 +20%)", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      facility("fForge", FORGE.id, 9, []),
      resource("wStock", WOOD),
    ]);
    expect(stock(advance(state, ctxOf(state), 10))).toBe(12_000_000);
  });

  it("派遣中の住民は稼働しない", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth"), dispatched: true }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      resource("wStock", WOOD),
    ]);
    expect(stock(advance(state, ctxOf(state), 100))).toBe(0);
  });

  it("1 tick ずつ進めても一括でも同じ(閉形式 = 逐次ループ)", () => {
    const state = productionState();
    const ctx = ctxOf(state);
    let stepwise = state;
    for (let tick = 1; tick <= 60; tick++) stepwise = advance(stepwise, ctx, tick);
    expect(json(stepwise)).toBe(json(advance(state, ctx, 60)));
  });

  it("同 tick への advance は何も変えない", () => {
    const state = productionState();
    const next = advance(state, ctxOf(state), 0);
    expect(next).toBe(state);
  });

  it("過去への advance は例外(時間は巻き戻らない)", () => {
    const state = advance(productionState(), ctxOf(productionState()), 10);
    expect(() => advance(state, ctxOf(state), 9)).toThrow(SchedulerError);
  });
});

describe("(B) 研究完了 = レート変化イベント(GDD 11.8(B))", () => {
  it("予測どおりの tick で完了する", () => {
    const state = researchState();
    // 研究机 Lv1 = 1.0/tick、コスト 100 → 100 tick で完了。
    const report = advanceWithReport(state, ctxOf(state), 150, { collectSegments: true });
    const completed = requireEntity(report.state, id("rBronze"), "research");
    expect(completed.completedTick).toBe(100);
    expect(toRaw(completed.progress)).toBe(100_000_000);
    expect(report.rateChangeEventCount).toBe(1);
    // tick 100 は粗粒度ステップ境界(10 の倍数)でもあるので、同 tick に
    // (C)抽選 → (B)完了 の 2 イベントが全順序で並ぶ(GDD 11.7 の段順)。
    const atCompletion = report.segments.filter((s) => s.toTick === 100);
    expect(atCompletion.map((s) => s.endEventKinds)).toEqual([
      ["stochasticStep", "researchComplete"],
    ]);
  });

  it("完了 tick の直前では未完了(境界が 1 tick 単位で正しい)", () => {
    const state = researchState();
    const ctx = ctxOf(state);
    expect(requireEntity(advance(state, ctx, 100), id("rBronze"), "research").completedTick).toBe(
      null,
    );
    expect(requireEntity(advance(state, ctx, 101), id("rBronze"), "research").completedTick).toBe(
      100,
    );
  });

  it("切り上げ: 端数があると 1 tick 遅れて完了する", () => {
    // 進行度 99.5 / コスト 100 / レート 1.0 → 残り 0.5 → 1 tick で完了。
    const state = researchState(0);
    const ctx = ctxOf(state);
    const seeded = advance(state, ctx, 99);
    expect(requireEntity(seeded, id("rBronze"), "research").completedTick).toBe(null);
    const done = advance(seeded, ctx, 101);
    expect(requireEntity(done, id("rBronze"), "research").completedTick).toBe(100);
  });

  it("完了後は次の研究(ID 昇順)へレートが向く", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fDesk") }),
      facility("fDesk", STUDY_DESK.id, 8, [WORKER]),
      research("rBronze", TECH_BRONZE.id),
      research("sIron", TECH_IRON.id),
      resource("wStock", WOOD),
    ]);
    // techBronze(100)→ tick 100、techIron(50)→ さらに 50 tick で tick 150。
    const next = advance(state, ctxOf(state), 200);
    expect(requireEntity(next, id("rBronze"), "research").completedTick).toBe(100);
    expect(requireEntity(next, id("sIron"), "research").completedTick).toBe(150);
  });

  it("研究レートが 0 なら完了イベントは発生しない", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
    const report = advanceWithReport(state, ctxOf(state), 500);
    expect(requireEntity(report.state, id("rBronze"), "research").completedTick).toBe(null);
    expect(report.rateChangeEventCount).toBe(0);
    // (B) が無いので区間を切るのは (C) 粗粒度ステップだけ = 500/10 本。
    expect(report.segmentCount).toBe(50);
    expect(report.stochasticStepCount).toBe(50);
  });

  it("進行度が既にコストを満たしている state は現在 tick で完了する(分割不変の要件)", () => {
    const state = researchState(120);
    const next = advance(state, ctxOf(state), 5);
    expect(requireEntity(next, id("rBronze"), "research").completedTick).toBe(0);
  });

  it("完了 tick ちょうどで区切っても一括と一致する(分割不変)", () => {
    const state = researchState();
    const ctx = ctxOf(state);
    // tick 100 が完了 tick。半開区間の規約でその advance では完了せず、
    // 次の advance の頭で完了する。
    const atBoundary = advance(state, ctx, 100);
    expect(requireEntity(atBoundary, id("rBronze"), "research").completedTick).toBe(null);
    const split = advance(atBoundary, ctx, 200);
    expect(requireEntity(split, id("rBronze"), "research").completedTick).toBe(100);
    expect(json(split)).toBe(json(advance(state, ctx, 200)));
  });
});

describe("(C) 想起困難 = 確率イベント区間(GDD 11.8(C) / 段階1)", () => {
  /**
   * (C) の経路を確実に踏ませる content。
   *
   * GDD 11.2 の確率は **1 ゲーム日あたり**なので、1 ステップあたり確率は
   * `p_day × coarse / 1440`(stochastic.ts の線形按分)になる。p=1.0/日 でも
   * 10 分ステップでは 0.69% しか当たらないため、確実に当てたい試験では
   * ステップ幅を 1 日(1440)にして p_step = p_day = 1.0 にする。
   */
  function certainRecallContent(durationTicks = 720): EngineContent {
    const base = content();
    return content({
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
    });
  }

  /** 生産 + 判定対象の技術(research entity)を持つ盤面。 */
  function recallState(): GameState {
    return stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
  }

  it("粗粒度ステップは 10 tick ごとに発火し、試行数 = ステップ × 住民 × 技術", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      resident("bMina", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER, WORKER2]),
      research("rBronze", TECH_BRONZE.id),
      research("sIron", TECH_IRON.id),
      resource("wStock", WOOD),
    ]);
    const report = advanceWithReport(state, ctxOf(state), 100);
    // tick 0,10,...,90 の 10 ステップ。住民 2 × 技術 2 = 4 判定/ステップ。
    expect(report.stochasticStepCount).toBe(10);
    expect(report.stochasticTrialCount).toBe(40);
  });

  it("1 分 tick(Fallback)ではステップ数が 10 倍になる(ADR-014(3))", () => {
    const state = productionState();
    const report = advanceWithReport(state, ctxOf(state, content({ coarseTickMinutes: 1 })), 100);
    expect(report.stochasticStepCount).toBe(100);
  });

  it("発生すると生産が止まり、持続満了で戻る((C) が生む (B) 境界)", () => {
    const c = certainRecallContent(720);
    const state = recallState();
    const report = advanceWithReport(state, ctxOf(state, c), 1440, { collectSegments: true });

    // tick 0 のステップで必ず発生 → 持続 720 tick → tick 720 が (B) 境界。
    expect(report.recallOccurrenceCount).toBe(1);
    // [M13] 想起困難の記録先は (住民, tech) 別の techMemoryByKey へ移った
    // (住民単位スカラ recallImpairedUntilTick は抽選が書かなくなった・recall.ts §3)。
    expect(techMemoryOf(report.state, WORKER, TECH_BRONZE.id)?.impairedUntilTick).toBe(720);
    const recover = report.segments.filter((s) => s.endEventKinds.includes("recallRecover"));
    expect(recover.map((s) => s.toTick)).toEqual([720]);
    expect(recover[0]?.endBoundary).toBe("rateChange");
    // [0,720) は停止、[720,1440) は稼働 → 720 tick 分だけ産出。
    expect(stock(report.state)).toBe(720_000_000);
  });

  it("発生中は生産に寄与しない", () => {
    const c = certainRecallContent(720);
    const state = recallState();
    expect(stock(advance(state, ctxOf(state, c), 720))).toBe(0);
    expect(stock(advance(state, ctxOf(state, c), 700))).toBe(0);
  });

  it("発生確率 0 なら誰も想起困難にならない(試行は行われる)", () => {
    const c = content({ recallRisk: { ...content().recallRisk, basePFix: fixFromRaw(0) } });
    const state = recallState();
    const report = advanceWithReport(state, ctxOf(state, c), 1440);
    expect(report.stochasticTrialCount).toBe(144); // 144 ステップ × 住民 1 × 技術 1
    expect(report.recallOccurrenceCount).toBe(0);
    expect(stock(report.state)).toBe(1_440_000_000);
  });

  it("判定対象の技術が無ければ試行も発生も 0", () => {
    const report = advanceWithReport(
      productionState(),
      ctxOf(productionState(), certainRecallContent()),
      1440,
    );
    expect(report.stochasticTrialCount).toBe(0);
    expect(report.recallOccurrenceCount).toBe(0);
  });

  it("持続の抽選は逐次ストリーム(rngState)を消費する", () => {
    const c = certainRecallContent();
    const state = recallState();
    expect(state.rngState.size).toBe(0);
    const next = advance(state, ctxOf(state, c), 30);
    expect(next.rngState.size).toBe(1);
  });

  it("発生中は再抽選しても新規発生にならない(持続は延長されない)", () => {
    const c = certainRecallContent(2000);
    const state = recallState();
    // ステップは tick 0 と 1440。1440 時点では until=2000 なので発生しない。
    const report = advanceWithReport(state, ctxOf(state, c), 2880);
    expect(report.stochasticStepCount).toBe(2);
    expect(report.stochasticTrialCount).toBe(2);
    expect(report.recallOccurrenceCount).toBe(1);
    expect(techMemoryOf(report.state, WORKER, TECH_BRONZE.id)?.impairedUntilTick).toBe(2000);
  });

  it("回復 tick ちょうどで区切っても state が一致する(分割不変)", () => {
    // 回復イベントは境界としてのみ存在し state を変えないので、
    // 半開区間の規約でイベントが発火しない区切り方でも結果が同じになる。
    const c = certainRecallContent(720);
    const state = recallState();
    const ctx = ctxOf(state, c);
    const whole = advance(state, ctx, 1440);
    const split = advance(advance(state, ctx, 720), ctx, 1440);
    expect(json(split)).toBe(json(whole));
  });

  it("士気・派遣・trait が確率へ効く(GDD 11.2 の各項)", () => {
    // 同じ seed・同じ配置で、士気だけ下げると発生が増える。
    const c = content({
      recallRisk: { ...content().recallRisk, durationMinTicks: 10, durationMaxTicks: 10 },
    });
    const healthy = stateOf([
      resident("aRui", { assignedFacilityId: id("fForge"), morale: fixFromInt(80) }),
      facility("fForge", FORGE.id, 8, [WORKER]),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
    const miserable = stateOf([
      resident("aRui", {
        assignedFacilityId: id("fForge"),
        morale: fixFromInt(10),
        dispatched: false,
      }),
      facility("fForge", FORGE.id, 8, [WORKER]),
      research("rBronze", TECH_BRONZE.id),
      resource("wStock", WOOD),
    ]);
    const healthyReport = advanceWithReport(healthy, ctxOf(healthy, c), 14_400);
    const miserableReport = advanceWithReport(miserable, ctxOf(miserable, c), 14_400);
    expect(miserableReport.recallOccurrenceCount).toBeGreaterThan(
      healthyReport.recallOccurrenceCount,
    );
  });
});

describe("決定論と分割不変(advance.ts §3)", () => {
  /** (A)(B)(C) 全部を踏む盤面。 */
  function mixedState(worldSeed = "seedAlpha"): GameState {
    return stateOf(
      [
        resident("aRui", { assignedFacilityId: id("fForge"), morale: fixFromInt(20) }),
        resident("bMina", { assignedFacilityId: id("fDesk"), morale: fixFromInt(40) }),
        resident("cSora", { assignedFacilityId: id("fHearth"), dispatched: true }),
        facility("fForge", FORGE.id, 8, [WORKER]),
        facility("fDesk", STUDY_DESK.id, 9, [WORKER2]),
        facility("fHearth", HEARTH.id, 14, [id("cSora")]),
        research("rBronze", TECH_BRONZE.id),
        research("sIron", TECH_IRON.id),
        resource("wStock", WOOD),
      ],
      { worldSeed },
    );
  }

  it("同じ入力から 2 回進めるとバイト同一", () => {
    const state = mixedState();
    const ctx = ctxOf(state);
    expect(json(advance(state, ctx, 4320))).toBe(json(advance(state, ctx, 4320)));
  });

  it("どこで区切っても結果が一致する(catch-up の分割不変)", () => {
    const state = mixedState();
    const ctx = ctxOf(state);
    const whole = advance(state, ctx, 4320);
    for (const splits of [[37], [10], [1, 2, 3], [1439, 1440, 1441], [2000, 4000, 4319]]) {
      let partial = state;
      for (const at of splits) partial = advance(partial, ctx, at);
      partial = advance(partial, ctx, 4320);
      expect(json(partial)).toBe(json(whole));
    }
  });

  it("1 粗粒度ステップずつ進めても一括と一致する(sim ハーネスの前提)", () => {
    const state = mixedState();
    const ctx = ctxOf(state);
    let stepwise = state;
    for (let tick = 10; tick <= 1440; tick += 10) stepwise = advance(stepwise, ctx, tick);
    expect(json(stepwise)).toBe(json(advance(state, ctx, 1440)));
  });

  it("worldSeed が変わると結果が変わる(seed が実際に効いている)", () => {
    const a = mixedState("seedAlpha");
    const b = mixedState("seedBeta");
    expect(json(advance(b, ctxOf(b), 4320))).not.toBe(json(advance(a, ctxOf(a), 4320)));
  });

  it("シード揺らぎ付きの隣接行列でも決定論(周回固定値)", () => {
    const shaken = content({
      adjacency: matrix(undefined, { minFix: fixFromRaw(-200_000), maxFix: fixFromRaw(200_000) }),
    });
    const state = mixedState();
    const first = advance(state, ctxOf(state, shaken), 1440);
    const second = advance(state, ctxOf(state, shaken), 1440);
    expect(json(second)).toBe(json(first));
    // 揺らぎが無い行列とは結果が違う(揺らぎが効いている)。
    expect(json(first)).not.toBe(json(advance(state, ctxOf(state), 1440)));
  });

  it("72h catch-up が 432 粗粒度ステップで完了する(#1 の compute 主項)", () => {
    const state = mixedState();
    const report = advanceWithReport(state, ctxOf(state), OFFLINE_CLAMP_TICK);
    expect(report.stochasticStepCount).toBe(432);
    expect(report.state.tick).toBe(4320);
    // 区間数はステップ数以上(レート変化イベントの分だけ増える)。
    expect(report.segmentCount).toBeGreaterThanOrEqual(432);
  });

  it("(A)(B)(C) の境界が区間記録に現れ、区間が連続する", () => {
    // 研究コストを 103 にすると完了 tick が粗粒度グリッド(10 の倍数)から外れ、
    // (B) 単独の境界が現れる。
    const offGrid = content({
      techDefs: new Map([
        [TECH_BRONZE.id, { id: TECH_BRONZE.id, researchCostFix: fixFromInt(103) }],
        [TECH_IRON.id, TECH_IRON],
      ]),
    });
    const state = mixedState();
    const report = advanceWithReport(state, ctxOf(state, offGrid), 1440, {
      collectSegments: true,
    });
    const classes = new Set(report.segments.map((s) => s.endBoundary));
    expect(classes.has("stochastic")).toBe(true);
    expect(classes.has("rateChange")).toBe(true);
    expect(classes.has("horizon")).toBe(true);
    expect(
      report.segments.filter((s) => s.endBoundary === "rateChange").map((s) => s.toTick),
    ).toContain(103);
    // 区間は連続していて隙間が無い。
    let cursor = 0;
    for (const segment of report.segments) {
      expect(segment.fromTick).toBe(cursor);
      cursor = segment.toTick;
    }
    expect(cursor).toBe(1440);
  });

  it("collectSegments を指定しないと区間記録は空(既定でアロケーションしない)", () => {
    const state = mixedState();
    expect(advanceWithReport(state, ctxOf(state), 100).segments).toEqual([]);
  });
});

describe("content の整合違反は黙って進まない", () => {
  it("同じセルに 2 施設があると例外", () => {
    const state = stateOf([
      facility("fHearth", HEARTH.id, 8, []),
      facility("gForge", FORGE.id, 8, []),
      resource("wStock", WOOD),
    ]);
    expect(() => ctxOf(state)).toThrow(/1 セル/);
  });

  it("facility 定義が content に無いと例外", () => {
    const state = stateOf([facility("fHearth", id("unknownDef"), 8, []), resource("wStock", WOOD)]);
    expect(() => ctxOf(state)).toThrow(/facility 定義/);
  });

  it("産出先の resource entity が無いと例外(産出を静かに捨てない)", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER]),
    ]);
    expect(() => advance(state, ctxOf(state), 10)).toThrow(/resource entity/);
  });

  it("Lv が定義の範囲外だと例外", () => {
    const state = stateOf([
      resident("aRui", { assignedFacilityId: id("fHearth") }),
      facility("fHearth", HEARTH.id, 8, [WORKER], 6),
      resource("wStock", WOOD),
    ]);
    expect(() => advance(state, ctxOf(state), 10)).toThrow(/Lv6/);
  });
});
