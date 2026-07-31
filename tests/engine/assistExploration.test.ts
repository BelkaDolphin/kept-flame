// ---------------------------------------------------------------------------
// M27 探索編成テンプレアシスト(戦力充足 + 80/100 約束)のテスト。
//
// 検収条件(ロードマップ M27 行):
//   ① 80% 検証: 代表プールで理論最大(候補プールの上位 teamSize 名の戦力)との比較
//   ② 検分: 3 アシストが同じ「80/100」の尺度で測られているか
//
// M26(推奨配置)と全く同じ構造で検証する: `qualityRatio = 1.0` で理論最大へ
// 厳密退化することを固定し、既定値(0.75)で 8 割前後に落ちることを代表プール
// 5 種 × 総当たり(小規模なので teamSize 人組の全列挙)で確認する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  ASSIST_TEAM_TARGET_RATIO,
  explorationTeamCandidates,
  suggestExpeditionTeams,
  teamPlanToCommands,
  type TeamRequest,
} from "../../src/engine/assist/exploration";
import { AssistError } from "../../src/engine/assist/placement";
import { apply } from "../../src/engine/commands";
import { FIX_ONE, fixFromInt, toApproxNumber, toRaw } from "../../src/engine/fp";
import type { DistanceBand, EngineContent, ExplorationParams } from "../../src/engine/rules/types";
import type { EntityState, GameState, ResidentState } from "../../src/engine/state/state";
import { content, facility, id, resource, stateOf, HEARTH, WOOD } from "./fixtures";

// --- 1. テスト用 content -----------------------------------------------------

/** 縮約 content + exploration(装備補正は既定 0 = 尺度を素の戦力和のまま保つ)。 */
function teamContent(equipmentBonusHuman = 0): EngineContent {
  const base = content();
  const bandBase = {
    baseTravelTicks: 100,
    nodeCountMin: 3,
    nodeCountMax: 3,
    difficultyMin: 100,
    difficultyMax: 100,
    rollRange: 1,
    rewardPerNodeFix: fixFromInt(5),
    rewardResourceId: WOOD,
    injuryPerFailureFix: fixFromInt(10),
    casualtyInjuryThresholdFix: fixFromInt(100),
    rescueChanceFix: fixFromInt(0),
    wipeBasePFix: fixFromInt(0),
  };
  const exploration: ExplorationParams = {
    byBand: { near: bandBase, far: bandBase, deep: bandBase },
    withdrawRewardRatioFix: fixFromInt(0),
    pressInjuryMulFix: fixFromInt(1),
    withdrawInjuryThresholdFix: fixFromInt(1000),
    equipmentBonusFix: fixFromInt(equipmentBonusHuman),
    travelSpeedupMaxFix: fixFromInt(0),
    forgoneOutputPerWorkerTickFix: fixFromInt(1),
    rareAssetValueFix: fixFromInt(100),
    wipeMaxPFix: fixFromInt(1),
  };
  return {
    facilityDefs: base.facilityDefs,
    techDefs: base.techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    exploration,
  };
}

/**
 * combatPower がちょうど `powerValue`(0〜100)になる住民。4 種の関連ステータス
 * (vigor/dexterity/fortitude/will)を全て同値にすると、重み配分の総和が
 * 1.0(`COMBAT_POWER_WEIGHTS`・rules/stats.ts)なので combatPower = その値に
 * 厳密に一致する(intellect は戦力に効かないので中立値 50 のまま)。
 */
function teamMember(name: string, powerValue: number, lifespanTick = 1_000_000): ResidentState {
  const statFix = fixFromInt(powerValue);
  return {
    kind: "resident",
    id: id(name),
    morale: fixFromInt(50),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
    stats: {
      vigor: statFix,
      dexterity: statFix,
      intellect: fixFromInt(50),
      fortitude: statFix,
      will: statFix,
    },
    life: { bornTick: 0, lifespanTick, diedTick: null },
  };
}

// --- 2. 代表プール5種(GDD 7.7「常時8〜20人規模」に収まる小規模プール) ------

interface Pool {
  readonly name: string;
  readonly powers: readonly number[];
  readonly teamSize: number;
}

/**
 * 5 種の代表プール(2026-07-31 実測・下記「80% 検証」の実測値コメント参照)。
 * 「戦力がほぼ均一」「二極化」「小規模」「開きが大きい」「単独 1 名編成」の
 * 5 パターンで、M26 の代表盤面 5 種と同じ立場を取る。
 */
const POOLS: readonly Pool[] = [
  { name: "p1-均一に近い", powers: [90, 85, 80, 75, 70, 65, 60, 55, 50, 45], teamSize: 4 },
  { name: "p2-二極化", powers: [95, 92, 90, 40, 38, 35, 33, 30], teamSize: 4 },
  { name: "p3-小規模プール", powers: [80, 60, 50, 45, 40], teamSize: 3 },
  { name: "p4-開きが大きい", powers: [100, 95, 70, 65, 40, 35, 20, 15], teamSize: 4 },
  { name: "p5-単独1名編成", powers: [90, 70, 50, 30], teamSize: 1 },
];

function poolKey(pool: Pool): string {
  return pool.name.replace(/[^a-zA-Z0-9]/g, "");
}

function buildPoolState(pool: Pool): GameState {
  const entities: EntityState[] = pool.powers.map((power, i) =>
    teamMember(`resident${poolKey(pool)}${String(i)}`, power),
  );
  return stateOf(entities);
}

function requestFor(pool: Pool, dispatchIdSuffix = ""): TeamRequest {
  return {
    dispatchId: id(`dispatch${poolKey(pool)}${dispatchIdSuffix}`),
    destinationId: id(`dest${poolKey(pool)}${dispatchIdSuffix}`),
    band: "near" as DistanceBand,
    stance: "press",
    teamSize: pool.teamSize,
  };
}

/** JS 側で独立に計算した「理論最大」(上位 teamSize 名の戦力和 + 装備補正)。 */
function independentBestPower(pool: Pool, equipmentBonusHuman: number): number {
  const sorted = [...pool.powers].sort((a, b) => b - a);
  const top = sorted.slice(0, pool.teamSize);
  return top.reduce((a, b) => a + b, 0) + equipmentBonusHuman;
}

// --- 3. 80% 検証(検収条件①②) --------------------------------------------

describe("M27 探索編成テンプレ: プール理論最大との比(80/100 約束)", () => {
  interface Measured {
    readonly pool: string;
    readonly best: number;
    readonly greedy: number;
    readonly assist: number;
    readonly greedyRatio: number;
    readonly assistRatio: number;
  }

  const measured: Measured[] = [];
  for (const pool of POOLS) {
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const greedyPlan = suggestExpeditionTeams(state, engineContent, [requestFor(pool, "g")], {
      qualityRatioFix: FIX_ONE,
    });
    const assistPlan = suggestExpeditionTeams(state, engineContent, [requestFor(pool, "a")]);

    const greedy = greedyPlan.suggestions[0];
    const assist = assistPlan.suggestions[0];
    if (greedy === undefined || assist === undefined) throw new Error("提案が空(前提が崩れている)");

    const bestApprox = toApproxNumber(greedy.teamPowerFix);
    // 独立計算(JS の単純ソート)と一致することを確認(理論最大の二重検証)。
    expect(bestApprox).toBeCloseTo(independentBestPower(pool, 0), 6);

    measured.push({
      pool: pool.name,
      best: bestApprox,
      greedy: bestApprox,
      assist: toApproxNumber(assist.teamPowerFix),
      greedyRatio: toApproxNumber(greedy.teamPowerFix) / bestApprox,
      assistRatio: toApproxNumber(assist.teamPowerFix) / bestApprox,
    });
  }

  // -------------------------------------------------------------------------
  // 2026-07-31 実測(ASSIST_TEAM_TARGET_RATIO = 0.75・装備補正 0)
  //
  //   プール                最大   貪欲   アシスト  貪欲/最大  アシスト/最大
  //   p1 均一に近い          330    330    270       1.000      0.818
  //   p2 二極化              317    317    245       1.000      0.773
  //   p3 小規模プール        190    190    165       1.000      0.868
  //   p4 開きが大きい        330    330    245       1.000      0.742
  //   p5 単独1名編成         90     90     70        1.000      0.778
  //                                                   平均      0.796
  //
  // qualityRatio=1.0(貪欲)は定義上どの要求順でも到達可能な合計の理論最大に
  // 厳密一致する(§2 の「合計は要求順に依存しない」証明のとおり)。
  // -------------------------------------------------------------------------

  it("実測が想定どおり並ぶ(全プールで比が有限、最大が正)", () => {
    expect(measured).toHaveLength(POOLS.length);
    for (const row of measured) {
      expect(Number.isFinite(row.assistRatio)).toBe(true);
      expect(row.best).toBeGreaterThan(0);
    }
  });

  it("qualityRatio = 1.0 は理論最大に厳密一致する(素の貪欲への退化)", () => {
    for (const row of measured) {
      expect(row.greedyRatio).toBe(1);
    }
  });

  it.each(measured)("$pool: アシストは理論最大の 90% 以下", ({ assistRatio }) => {
    expect(assistRatio).toBeLessThanOrEqual(0.9);
  });

  it.each(measured)("$pool: アシストは理論最大の 70% 以上(使い物になる下限)", ({ assistRatio }) => {
    expect(assistRatio).toBeGreaterThanOrEqual(0.7);
  });

  it("代表プール平均が 8 割前後(0.75〜0.90)に収まる", () => {
    let sum = 0;
    for (const row of measured) sum += row.assistRatio;
    const mean = sum / measured.length;
    expect(mean).toBeGreaterThanOrEqual(0.75);
    expect(mean).toBeLessThanOrEqual(0.9);
  });

  it("既定の qualityRatio は 0.75(プール比 0.80 前後へ校正した値)", () => {
    expect(toRaw(ASSIST_TEAM_TARGET_RATIO)).toBe(750_000);
  });
});

// --- 4. 複数要求(同時派遣枠)の共有プール ------------------------------------

describe("M27 探索編成テンプレ: 複数要求の合計は要求順に依存しない(§2)", () => {
  it("qualityRatio=1.0 なら要求順を変えても合計戦力は不変(理論最大への退化)", () => {
    const pool: Pool = { name: "multi", powers: [90, 80, 70, 60, 50, 40], teamSize: 2 };
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const reqA: TeamRequest = {
      dispatchId: id("dispatchMultiA"),
      destinationId: id("destMultiA"),
      band: "near",
      stance: "press",
      teamSize: 2,
    };
    const reqB: TeamRequest = {
      dispatchId: id("dispatchMultiB"),
      destinationId: id("destMultiB"),
      band: "far",
      stance: "cautious",
      teamSize: 2,
    };

    const forward = suggestExpeditionTeams(state, engineContent, [reqA, reqB], {
      qualityRatioFix: FIX_ONE,
    });
    const backward = suggestExpeditionTeams(state, engineContent, [reqB, reqA], {
      qualityRatioFix: FIX_ONE,
    });

    const sumOf = (plan: typeof forward): number =>
      plan.suggestions.reduce((acc, s) => acc + toApproxNumber(s.teamPowerFix), 0);

    // 上位 4 名(90+80+70+60=300)を 2 要求で使い切る = 理論最大。
    expect(sumOf(forward)).toBeCloseTo(300, 6);
    expect(sumOf(backward)).toBeCloseTo(300, 6);
    expect(sumOf(forward)).toBeCloseTo(sumOf(backward), 6);

    // どちらのメンバーも重複しない(共有プールの占有が正しく機能している)。
    const allMembers = [...forward.suggestions[0]!.memberIds, ...forward.suggestions[1]!.memberIds];
    expect(new Set(allMembers).size).toBe(4);
  });
});

// --- 5. 決定論と純粋性 -------------------------------------------------------

describe("M27 探索編成テンプレ: 決定論と純粋性", () => {
  const pool = POOLS[1];
  if (pool === undefined) throw new Error("プール p2 が無い");
  const state = buildPoolState(pool);
  const engineContent = teamContent(0);

  it("同一入力 → 同一出力(2 回呼んで完全一致)", () => {
    const first = suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    const second = suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    expect(second).toStrictEqual(first);
  });

  it("state を 1 bit も変えない", () => {
    const snapshot = JSON.stringify([...state.entityStateById.entries()]);
    suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    expect(JSON.stringify([...state.entityStateById.entries()])).toBe(snapshot);
  });

  it("選ばれるメンバーは常に住民 ID 昇順", () => {
    const plan = suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    const memberIds = plan.suggestions[0]?.memberIds;
    expect(memberIds).toBeDefined();
    if (memberIds === undefined) return;
    const sorted = [...memberIds].sort();
    expect(memberIds).toStrictEqual(sorted);
  });
});

// --- 6. 候補プール(GDD 8.1 [2026-07-30裁定]② の再利用確認) ------------------

describe("M27 探索編成テンプレ: 候補プール(寿命を持たない住民は除外)", () => {
  it("life を持たない住民は候補に含まれない(寿命モデル不活性の住民を混ぜない)", () => {
    const withLife = teamMember("residentWithLife", 80);
    const noLife: ResidentState = {
      kind: "resident",
      id: id("residentNoLife"),
      morale: fixFromInt(50),
      mastery: fixFromInt(0),
      assignedFacilityId: null,
      dispatched: false,
      traitIds: [],
      recallImpairedUntilTick: 0,
    };
    const state = stateOf([withLife, noLife]);
    const candidates = explorationTeamCandidates(state);
    expect(candidates.map((r) => r.id)).toStrictEqual([withLife.id]);
  });
});

// --- 7. 盤面制約(枯渇・除外リスト) ------------------------------------------

describe("M27 探索編成テンプレ: プール制約", () => {
  it("プールが尽きたら例外にせず unfulfilledRequests へ載せる", () => {
    const pool: Pool = { name: "starved", powers: [80, 60], teamSize: 4 };
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const plan = suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    expect(plan.suggestions).toStrictEqual([]);
    expect(plan.unfulfilledRequests).toHaveLength(1);
  });

  it("excludeResidentIds(唯一保持者を本拠に残す等)で除外した住民は選ばれない", () => {
    const pool: Pool = { name: "exclude", powers: [90, 80, 70, 60, 50], teamSize: 2 };
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const topMemberId = id(`resident${poolKey(pool)}0`);
    const plan = suggestExpeditionTeams(state, engineContent, [requestFor(pool)], {
      qualityRatioFix: FIX_ONE,
      excludeResidentIds: [topMemberId],
    });
    const memberIds = plan.suggestions[0]?.memberIds ?? [];
    expect(memberIds).not.toContain(topMemberId);
  });
});

// --- 8. 提案は実際に dispatchExpedition として受理される --------------------

describe("M27 探索編成テンプレ: 提案は commands.ts に受理される", () => {
  it("提案をそのまま適用すると派遣が確定する", () => {
    const pool = POOLS[2];
    if (pool === undefined) throw new Error("プール p3 が無い");
    let state = buildPoolState(pool);
    state = stateOf([
      ...state.entityStateById.values(),
      facility("hearthForDispatch", HEARTH.id, 0),
      resource("woodForDispatch", WOOD),
    ] as EntityState[]);
    const engineContent = teamContent(0);
    const plan = suggestExpeditionTeams(state, engineContent, [requestFor(pool)]);
    const commands = teamPlanToCommands(plan);
    expect(commands).toHaveLength(1);

    let next = state;
    for (const command of commands) {
      const result = apply(next, engineContent, command);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      next = result.state;
    }
  });
});

// --- 9. 入力の契約 ------------------------------------------------------------

describe("M27 探索編成テンプレ: 入力の契約", () => {
  const pool = POOLS[0];
  if (pool === undefined) throw new Error("プール p1 が無い");

  it("teamSize が 1〜4 の範囲外なら AssistError", () => {
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const bad: TeamRequest = { ...requestFor(pool), teamSize: 5 };
    expect(() => suggestExpeditionTeams(state, engineContent, [bad])).toThrow(AssistError);
  });

  it("要求内で dispatchId が重複したら AssistError", () => {
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const req = requestFor(pool);
    expect(() => suggestExpeditionTeams(state, engineContent, [req, req])).toThrow(AssistError);
  });

  it("既存の未帰還派遣と dispatchId が衝突したら AssistError", () => {
    let state = buildPoolState(pool);
    state = stateOf([
      ...state.entityStateById.values(),
      facility("hearthForClash", HEARTH.id, 0),
      resource("woodForClash", WOOD),
    ] as EntityState[]);
    const engineContent = teamContent(0);
    const req = requestFor(pool);
    const firstPlan = suggestExpeditionTeams(state, engineContent, [req]);
    const applied = apply(state, engineContent, teamPlanToCommands(firstPlan)[0]!);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("unreachable");

    expect(() => suggestExpeditionTeams(applied.state, engineContent, [req])).toThrow(AssistError);
  });

  it("要求が空なら提案も空", () => {
    const state = buildPoolState(pool);
    const engineContent = teamContent(0);
    const plan = suggestExpeditionTeams(state, engineContent, []);
    expect(plan.suggestions).toStrictEqual([]);
    expect(plan.unfulfilledRequests).toStrictEqual([]);
  });
});
