import { describe, expect, it } from "vitest";

import { createAdvanceContext } from "../../src/engine/advance";
import { FIX_ONE, fixFromInt, fixFromRaw, mulFix, toRaw, type Fix } from "../../src/engine/fp";
import {
  activeLaborFix,
  computeProductionRates,
  residentContribution,
} from "../../src/engine/rules/production";
import {
  NEUTRAL_CONTRIBUTION_IS_ONE,
  NEUTRAL_RESIDENT_STATS,
  RESIDENT_STAT_IDS,
  TRAIT_YIELD_MUL_MAX_FIX,
  UNIFORM_STAT_WEIGHTS,
  effectiveStats,
  resolveTraitDefs,
  traitYieldMultiplier,
  workerContribution,
  type ResidentStatId,
  type ResidentStats,
  type StatWeights,
  type TraitDef,
} from "../../src/engine/rules/stats";
import type { EngineContent, FacilityDef } from "../../src/engine/rules/types";
import type { EntityId, GameState, ResidentState } from "../../src/engine/state/state";

import {
  HEARTH,
  RECALL_RISK,
  STUDY_DESK,
  WOOD,
  facility,
  id,
  matrix,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// M5「rules 全系統化(1)」の生産式(GDD 11.1 の全系統形)のテスト。
//
// 中心は 2 つ:
//   (1) **中立既定値では T5 の縮約形と 1 bit も違わない**(既存 golden vector 37 本が
//       動かないことの根拠。golden:check が本番の検証で、ここは式レベルの固定)
//   (2) ステータス 5 種(裁定 B8)・重み・trait 倍率が GDD の式どおりに効く
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

function weightsOf(vigor: number, dex: number, intellect: number, fort: number, will: number) {
  return {
    vigor: fixFromRaw(vigor),
    dexterity: fixFromRaw(dex),
    intellect: fixFromRaw(intellect),
    fortitude: fixFromRaw(fort),
    will: fixFromRaw(will),
  } satisfies StatWeights;
}

function traitOf(
  name: string,
  options: {
    readonly add?: readonly (readonly [ResidentStatId, number])[];
    readonly mul?: readonly (readonly [ResidentStatId, number])[];
    readonly yieldMulRaw?: number;
  } = {},
): TraitDef {
  return {
    id: id(name),
    statAddFixById: new Map((options.add ?? []).map(([s, v]) => [s, fixFromInt(v)] as const)),
    statMulFixById: new Map((options.mul ?? []).map(([s, v]) => [s, fixFromRaw(v)] as const)),
    yieldMulFix: fixFromRaw(options.yieldMulRaw ?? toRaw(FIX_ONE)),
  };
}

/** fixtures の content() は M5 の省略可フィールドを持たないので、ここで組み立てる。 */
function contentOf(
  options: {
    readonly facilityDefs?: readonly FacilityDef[];
    readonly traitDefs?: readonly TraitDef[];
  } = {},
): EngineContent {
  const facilityDefs = options.facilityDefs ?? [HEARTH, STUDY_DESK];
  return {
    facilityDefs: new Map(facilityDefs.map((def) => [def.id, def] as const)),
    techDefs: new Map(),
    adjacency: matrix(),
    recallRisk: RECALL_RISK,
    coarseTickMinutes: 10,
    traitDefs: new Map((options.traitDefs ?? []).map((def) => [def.id, def] as const)),
  };
}

/** 就労者 1 人の hearth 盤面(隣接ボーナスが掛からないよう単独配置)。 */
function boardWith(residents: readonly ResidentState[]): GameState {
  const workerIds: EntityId[] = residents.map((r) => r.id);
  return stateOf([
    ...residents,
    facility("fHearth", HEARTH.id, 0, workerIds),
    resource("rWood", WOOD, 0),
  ]);
}

function woodRate(state: GameState, content: EngineContent): Fix {
  const rates = computeProductionRates(state, createAdvanceContext(state, content));
  return rates.resourceRateByResourceId.get(WOOD) ?? fixFromInt(0);
}

describe("中立既定値 = T5 縮約形との厳密一致(GDD 11.1)", () => {
  it("ステータス未設定・trait 無し・重み未指定の寄与はちょうど 1.0", () => {
    expect(NEUTRAL_CONTRIBUTION_IS_ONE).toBe(true);
    expect(toRaw(workerContribution(NEUTRAL_RESIDENT_STATS, UNIFORM_STAT_WEIGHTS, []))).toBe(
      toRaw(FIX_ONE),
    );
  });

  it("residentContribution の近道は一般経路と同値", () => {
    const content = contentOf();
    const worker = resident("aRui");
    expect(toRaw(residentContribution(worker, HEARTH, content))).toBe(
      toRaw(workerContribution(NEUTRAL_RESIDENT_STATS, UNIFORM_STAT_WEIGHTS, [])),
    );
  });

  it("Σ寄与が稼働就労者数に一致する(2 人なら 2.0)", () => {
    const content = contentOf();
    const state = boardWith([resident("aRui"), resident("bMina")]);
    const facilityState = state.entityStateById.get(id("fHearth"));
    if (facilityState?.kind !== "facility") throw new Error("盤面の組み立てが違う");
    expect(toRaw(activeLaborFix(state, content, facilityState, HEARTH, 0))).toBe(2_000_000);
  });

  it("レートが `出力(Lv) × 隣接乗数 × 人数` と厳密一致する", () => {
    const content = contentOf();
    const state = boardWith([resident("aRui"), resident("bMina")]);
    // HEARTH Lv1 = 1.0/tick、単独配置なので隣接乗数 1.0、稼働 2 人。
    expect(toRaw(woodRate(state, content))).toBe(2_000_000);
  });

  it("想起困難中/派遣中の住民は寄与しない(稼働の定義は T5 と同じ)", () => {
    const content = contentOf();
    const state = boardWith([
      resident("aRui", { dispatched: true }),
      resident("bMina", { recallImpairedUntilTick: 100 }),
      resident("cSora"),
    ]);
    expect(toRaw(woodRate(state, content))).toBe(1_000_000);
  });
});

describe("ステータス 5 種(裁定 B8)が生産式に効く", () => {
  it("全ステータス 100 なら寄与 2.0(= 100/50)", () => {
    const content = contentOf();
    const strong = { ...resident("aRui"), stats: statsOf(100, 100, 100, 100, 100) };
    expect(toRaw(residentContribution(strong, HEARTH, content))).toBe(2_000_000);
    expect(toRaw(woodRate(boardWith([strong]), content))).toBe(2_000_000);
  });

  it("全ステータス 0 なら寄与 0(その住民は産出に寄与しない)", () => {
    const content = contentOf();
    const weak = { ...resident("aRui"), stats: statsOf(0, 0, 0, 0, 0) };
    expect(toRaw(residentContribution(weak, HEARTH, content))).toBe(0);
  });

  it("施設の statWeights が「関連ステータス」を選ぶ", () => {
    const scholarly: FacilityDef = {
      ...HEARTH,
      // 知性のみを参照する施設(総和 1.0)。
      statWeights: weightsOf(0, 0, 1_000_000, 0, 0),
    };
    const content = contentOf({ facilityDefs: [scholarly, STUDY_DESK] });
    const thinker = { ...resident("aRui"), stats: statsOf(0, 0, 100, 0, 0) };
    // 知性 100 のみ参照 → 100/50 = 2.0
    expect(toRaw(residentContribution(thinker, scholarly, content))).toBe(2_000_000);
    // 等分既定なら (0.2 × 100)/50 = 0.4
    expect(toRaw(residentContribution(thinker, HEARTH, content))).toBe(400_000);
  });

  it("重みが等分でも中立ステータスなら 1.0 のまま(重み総和 1 の帰結)", () => {
    const weighted: FacilityDef = { ...HEARTH, statWeights: weightsOf(500_000, 500_000, 0, 0, 0) };
    const content = contentOf({ facilityDefs: [weighted] });
    expect(toRaw(residentContribution(resident("aRui"), weighted, content))).toBe(toRaw(FIX_ONE));
  });

  it("ステータスは 0〜100 にクランプされる(GDD 7.1 上限厳守)", () => {
    const over = effectiveStats(statsOf(200, -50, 100, 0, 50), []);
    expect(toRaw(over.vigor)).toBe(100_000_000);
    expect(toRaw(over.dexterity)).toBe(0);
  });
});

describe("trait 倍率(GDD 7.2 / 11.1)", () => {
  it("yieldMul は生産式の trait 倍率項として掛かる", () => {
    const craftsman = traitOf("traitCraftsman", { yieldMulRaw: 1_200_000 });
    const content = contentOf({ traitDefs: [craftsman] });
    const worker = { ...resident("aRui"), traitIds: [craftsman.id] };
    expect(toRaw(residentContribution(worker, HEARTH, content))).toBe(1_200_000);
    expect(toRaw(woodRate(boardWith([worker]), content))).toBe(1_200_000);
  });

  it("同種効果は乗算合成され、カテゴリ上限でクランプされる", () => {
    const t1 = traitOf("traitA", { yieldMulRaw: 1_500_000 });
    const t2 = traitOf("traitB", { yieldMulRaw: 1_500_000 });
    // 1.5 × 1.5 = 2.25 → 上限 1.5 へクランプ
    expect(toRaw(traitYieldMultiplier([t1, t2]))).toBe(toRaw(TRAIT_YIELD_MUL_MAX_FIX));
  });

  it("ステータスへの add / mul が (base + Σadd) × Πmul で合成される", () => {
    const brawn = traitOf("traitBrawn", { add: [["vigor", 20]], mul: [["vigor", 1_100_000]] });
    const stats = effectiveStats(NEUTRAL_RESIDENT_STATS, [brawn]);
    // (50 + 20) × 1.1 = 77
    expect(toRaw(stats.vigor)).toBe(77_000_000);
    // 他のステータスは素通し
    expect(toRaw(stats.will)).toBe(50_000_000);
  });

  it("trait のステータス効果が生産寄与まで届く(倍率と二重計上しない)", () => {
    // 器用のみを参照する施設 + 器用 +30 の trait → (50+30)/50 = 1.6
    const nimble: FacilityDef = { ...HEARTH, statWeights: weightsOf(0, 1_000_000, 0, 0, 0) };
    const deft = traitOf("traitDeft", { add: [["dexterity", 30]] });
    const content = contentOf({ facilityDefs: [nimble], traitDefs: [deft] });
    const worker = { ...resident("aRui"), traitIds: [deft.id] };
    expect(toRaw(residentContribution(worker, nimble, content))).toBe(1_600_000);
    expect(toRaw(woodRate(boardWith([worker]), content))).toBe(1_600_000);
  });

  it("ステータス効果と yieldMul は別の項として掛かる", () => {
    const nimble: FacilityDef = { ...HEARTH, statWeights: weightsOf(0, 1_000_000, 0, 0, 0) };
    const both = traitOf("traitBoth", { add: [["dexterity", 30]], yieldMulRaw: 1_500_000 });
    const content = contentOf({ facilityDefs: [nimble], traitDefs: [both] });
    const worker = { ...resident("aRui"), traitIds: [both.id] };
    // 1.6 × 1.5 = 2.4
    expect(toRaw(residentContribution(worker, nimble, content))).toBe(2_400_000);
  });

  it("生産へ効かない trait(記憶巧者など)は寄与を変えない", () => {
    const memoryKeeper = traitOf("traitMemoryKeeper");
    const content = contentOf({ traitDefs: [memoryKeeper] });
    const worker = { ...resident("aRui"), traitIds: [memoryKeeper.id] };
    expect(resolveTraitDefs(worker.traitIds, content.traitDefs)).toHaveLength(0);
    expect(toRaw(residentContribution(worker, HEARTH, content))).toBe(toRaw(FIX_ONE));
  });

  it("content に無い traitId は読み飛ばす(セーブ由来の未知 ID で落ちない)", () => {
    const content = contentOf();
    const worker = { ...resident("aRui"), traitIds: [id("traitGhost")] };
    expect(toRaw(residentContribution(worker, HEARTH, content))).toBe(toRaw(FIX_ONE));
  });

  it("ステータス倍率の合成は ±30% でクランプされる(GDD 7.2)", () => {
    const t1 = traitOf("traitA", { mul: [["vigor", 1_300_000]] });
    const t2 = traitOf("traitB", { mul: [["vigor", 1_300_000]] });
    const stats = effectiveStats(NEUTRAL_RESIDENT_STATS, [t1, t2]);
    // 1.3 × 1.3 = 1.69 → 1.3 へクランプ → 50 × 1.3 = 65
    expect(toRaw(stats.vigor)).toBe(65_000_000);
  });
});

describe("正本 ID とレジストリ", () => {
  it("ステータス 5 種の正本英字 ID は裁定 B8 のとおり(順序も固定)", () => {
    expect([...RESIDENT_STAT_IDS]).toEqual([
      "vigor",
      "dexterity",
      "intellect",
      "fortitude",
      "will",
    ]);
  });

  it("等分既定の総和はちょうど 1.0", () => {
    const total = RESIDENT_STAT_IDS.reduce(
      (acc, statId) => acc + toRaw(UNIFORM_STAT_WEIGHTS[statId]),
      0,
    );
    expect(total).toBe(toRaw(FIX_ONE));
  });

  it("寄与 × 人数の式が mulFix でも厳密(縮約形との一致の代数的根拠)", () => {
    // mulFix(x, N × 1e6) === x × N が成り立つことを、桁の大きい x でも確かめる。
    const x = fixFromRaw(7_123_456_789);
    expect(toRaw(mulFix(x, fixFromInt(3)))).toBe(7_123_456_789 * 3);
  });
});
