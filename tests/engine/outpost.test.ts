import { describe, expect, it } from "vitest";

import { createAdvanceContext } from "../../src/engine/advance";
import { FIX_ONE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import {
  applyOutpostSupply,
  assertNoDoubleStationedResidents,
  computeOutpostSupplyRates,
  outpostHazardFix,
  outpostNetRevenueFix,
  outpostNetworkRoi,
  outpostRoi,
  outpostShadeRateFix,
  outpostSupplyRateFix,
  outpostUpkeepRateFix,
  stationedResidentIds,
} from "../../src/engine/rules/outpost";
import { applyProduction, computeProductionRates } from "../../src/engine/rules/production";
import {
  RulesError,
  type DistanceBand,
  type EngineContent,
  type OutpostParams,
  type OutpostTypeDef,
} from "../../src/engine/rules/types";
import { entitiesOfKind, type OutpostState } from "../../src/engine/state/state";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";

import { HEARTH, WOOD, content, facility, id, resident, resource, stateOf } from "./fixtures";

// ---------------------------------------------------------------------------
// [M24] 衛星拠点(供給/維持費/hazard/ROI)のテスト(GDD 9.2 / 8.6 / 11.4-7)。
// 中心は 3 つ:
//   (1) 供給/維持費/hazard の式が GDD どおりに計算されること
//   (2) 拠点網 ROI がテストできる形で算出されること(GDD 11.4-7)
//   (3) **本拠と拠点で資源系の二重計上が無いこと**(検分観点そのもの)
// ---------------------------------------------------------------------------

const MINE: OutpostTypeDef = {
  id: id("outpostMineTest"),
  // WOOD は fixtures.ts の HEARTH/FORGE と**同じ resourceId**(意図的)。
  // (3) の検証を、実際に同じ resource entity へ両方が書き込む形で行うため。
  resourceId: WOOD,
  supplyPerResidentTickByLevel: [
    fixFromInt(10),
    fixFromInt(11),
    fixFromInt(12),
    fixFromInt(13),
    fixFromInt(14),
  ],
  upkeep: { baseFoodFix: fixFromInt(2), baseMoraleCareFix: fixFromInt(1) },
  hazard: {
    intensityFix: fixFromRaw(50_000), // 0.05
    growthPerDayFix: fixFromRaw(100_000), // 0.10/day
    minFix: fixFromRaw(50_000), // 0.05
    maxFix: fixFromRaw(600_000), // 0.60
  },
  shadeSensitivityFix: fixFromInt(1),
};

const OUTPOST_PARAMS: OutpostParams = {
  distanceBandUpkeepMulFix: {
    near: fixFromInt(1),
    far: fixFromRaw(1_400_000), // 1.4
    deep: fixFromRaw(1_800_000), // 1.8
  },
};

function contentWithOutpost(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = content(overrides);
  return {
    ...base,
    outpostTypeDefs: new Map([[MINE.id, MINE]]),
    outpost: OUTPOST_PARAMS,
  };
}

function outpostOf(
  name: string,
  band: DistanceBand,
  residentIds: readonly ReturnType<typeof id>[],
  overrides: Partial<Omit<OutpostState, "id" | "band" | "residentIds">> = {},
): OutpostState {
  return {
    id: id(name),
    outpostTypeId: MINE.id,
    level: 1,
    band,
    residentIds,
    establishedTick: 0,
    ...overrides,
  };
}

// --- 1. hazard ---------------------------------------------------------------

describe("outpostHazardFix(GDD 12.1)", () => {
  it("設置直後(経過0日)は intensity そのもの", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1")]);
    expect(toRaw(outpostHazardFix(outpost, MINE, 0))).toBe(50_000);
  });

  it("経過日数に応じて線形に育つ", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1")], { establishedTick: 0 });
    const tick = GAME_DAY_TICKS * 3; // 3 日経過
    // 0.05 + 0.10*3 = 0.35
    expect(toRaw(outpostHazardFix(outpost, MINE, tick))).toBe(350_000);
  });

  it("上限でクランプされる", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1")], { establishedTick: 0 });
    const tick = GAME_DAY_TICKS * 100; // 十分に経過
    expect(toRaw(outpostHazardFix(outpost, MINE, tick))).toBe(toRaw(MINE.hazard.maxFix));
  });

  it("tick が establishedTick より前(state 不整合)でも経過0日として扱う", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1")], { establishedTick: 1000 });
    expect(toRaw(outpostHazardFix(outpost, MINE, 0))).toBe(50_000);
  });

  it("hazard.min > hazard.max の定義は RulesError", () => {
    const broken: OutpostTypeDef = {
      ...MINE,
      hazard: { ...MINE.hazard, minFix: fixFromRaw(700_000), maxFix: fixFromRaw(600_000) },
    };
    const outpost = outpostOf("outpostA", "near", [id("r1")]);
    expect(() => outpostHazardFix(outpost, broken, 0)).toThrow(RulesError);
  });
});

// --- 2. 翳り率・供給 -----------------------------------------------------------

describe("outpostShadeRateFix / outpostSupplyRateFix(GDD 9.2)", () => {
  it("幕塵後退度 0 なら翳り率 0", () => {
    expect(toRaw(outpostShadeRateFix(FIX_ZERO, MINE))).toBe(0);
  });

  it("幕塵後退度 × shadeSensitivity が 1 を超えても 1 でクランプ", () => {
    expect(toRaw(outpostShadeRateFix(FIX_ONE, MINE))).toBe(toRaw(FIX_ONE));
  });

  it("供給 = 1 人あたり供給(Lv別) × 常駐人数 ×(1−翳り率)", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1"), id("r2")], { level: 2 });
    // Lv2 = 11、2 人、翳りなし → 22
    expect(toRaw(outpostSupplyRateFix(outpost, MINE, FIX_ZERO))).toBe(22_000_000);
  });

  it("翳り率が掛かると供給が減る", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1"), id("r2")], { level: 2 });
    // shadeSensitivity=1 なので幕塵後退度 0.5 → 翳り率 0.5 → 22 * 0.5 = 11
    const hazeRecessionDegreeFix = fixFromRaw(500_000);
    expect(toRaw(outpostSupplyRateFix(outpost, MINE, hazeRecessionDegreeFix))).toBe(11_000_000);
  });

  it("Lv が定義の配列長を外れていれば RulesError", () => {
    const outpost = outpostOf("outpostA", "near", [id("r1")], { level: 6 });
    expect(() => outpostSupplyRateFix(outpost, MINE, FIX_ZERO)).toThrow(RulesError);
  });
});

// --- 3. 維持費・ネット収益 -----------------------------------------------------

describe("outpostUpkeepRateFix / outpostNetRevenueFix(GDD 9.2)", () => {
  it("維持費 = 食料×人数 + 士気ケア×距離帯係数", () => {
    const outpost = outpostOf("outpostA", "far", [id("r1"), id("r2"), id("r3")]);
    // 食料 2*3=6、士気ケア 1*1.4=1.4 → 7.4
    expect(toRaw(outpostUpkeepRateFix(outpost, MINE, OUTPOST_PARAMS))).toBe(7_400_000);
  });

  it("距離帯が違えば維持費も違う(near と deep)", () => {
    const near = outpostOf("outpostA", "near", [id("r1")]);
    const deep = outpostOf("outpostB", "deep", [id("r2")]);
    const nearUpkeep = toRaw(outpostUpkeepRateFix(near, MINE, OUTPOST_PARAMS));
    const deepUpkeep = toRaw(outpostUpkeepRateFix(deep, MINE, OUTPOST_PARAMS));
    expect(deepUpkeep).toBeGreaterThan(nearUpkeep);
  });

  it("ネット収益 = supply − upkeep", () => {
    const supply = fixFromInt(20);
    const upkeep = fixFromInt(7);
    expect(toRaw(outpostNetRevenueFix(supply, upkeep))).toBe(toRaw(fixFromInt(13)));
  });
});

// --- 4. 二重計上の防止(検分観点) ----------------------------------------------

describe("assertNoDoubleStationedResidents(検分観点: 二重計上の防止)", () => {
  it("本拠就労/探索派遣と重複しない拠点常駐は許可", () => {
    const state = stateOf([
      resident("rHome"),
      resident("rOutpost"),
      facility("fHearth", HEARTH.id, 0, [id("rHome")]),
    ]);
    const withOutpost = {
      ...state,
      outpostsById: new Map([[id("oA"), outpostOf("oA", "near", [id("rOutpost")])]]),
    };
    expect(() => assertNoDoubleStationedResidents(withOutpost)).not.toThrow();
  });

  it("facility.workerIds と拠点常駐の重複は RulesError", () => {
    const state = stateOf([
      resident("rShared"),
      facility("fHearth", HEARTH.id, 0, [id("rShared")]),
    ]);
    const withOutpost = {
      ...state,
      outpostsById: new Map([[id("oA"), outpostOf("oA", "near", [id("rShared")])]]),
    };
    expect(() => assertNoDoubleStationedResidents(withOutpost)).toThrow(RulesError);
  });

  it("探索派遣中(dispatched=true)の住民の拠点常駐は RulesError", () => {
    const state = stateOf([resident("rDispatched", { dispatched: true })]);
    const withOutpost = {
      ...state,
      outpostsById: new Map([[id("oA"), outpostOf("oA", "near", [id("rDispatched")])]]),
    };
    expect(() => assertNoDoubleStationedResidents(withOutpost)).toThrow(RulesError);
  });

  it("同一住民が複数拠点に常駐していれば RulesError", () => {
    const state = stateOf([resident("rBoth")]);
    const withOutposts = {
      ...state,
      outpostsById: new Map([
        [id("oA"), outpostOf("oA", "near", [id("rBoth")])],
        [id("oB"), outpostOf("oB", "far", [id("rBoth")])],
      ]),
    };
    expect(() => assertNoDoubleStationedResidents(withOutposts)).toThrow(RulesError);
  });

  it("stationedResidentIds は ID 昇順で平坦化する", () => {
    const state = stateOf([]);
    const withOutposts = {
      ...state,
      outpostsById: new Map([
        [id("oB"), outpostOf("oB", "near", [id("rZ")])],
        [id("oA"), outpostOf("oA", "near", [id("rA")])],
      ]),
    };
    expect(stationedResidentIds(withOutposts)).toEqual(["rA", "rZ"]);
  });
});

// --- 5. 供給レートの集約と適用(二重計上しない構造の実証) -----------------------

describe("computeOutpostSupplyRates / applyOutpostSupply(二重計上の構造的防止)", () => {
  it("本拠生産と拠点供給は同じ resource entity へ加算され、別ストックを作らない", () => {
    // HEARTH(1人稼働・WOOD 産出)+ 拠点(2人常駐・同じ WOOD へ供給)を同一盤面に置く。
    let state = stateOf([
      resident("rHome"),
      resident("rOutpostA"),
      resident("rOutpostB"),
      facility("fHearth", HEARTH.id, 0, [id("rHome")]),
      resource("wStock", WOOD, 0),
    ]);
    state = {
      ...state,
      outpostsById: new Map([
        [id("oMine"), outpostOf("oMine", "near", [id("rOutpostA"), id("rOutpostB")])],
      ]),
    };

    const engineContent = contentWithOutpost();
    const ctx = createAdvanceContext(state, engineContent);
    const productionRates = computeProductionRates(state, ctx);
    const outpostRates = computeOutpostSupplyRates(state, engineContent);

    const deltaTicks = 10;
    let next = applyProduction(state, productionRates, deltaTicks);
    next = applyOutpostSupply(next, outpostRates, deltaTicks);

    // (a) WOOD の resource entity は依然として 1 個だけ(二重の資源ストックが
    //     生成されていないことの直接証拠)。
    const woodEntities = entitiesOfKind(next, "resource").filter((r) => r.resourceId === WOOD);
    expect(woodEntities).toHaveLength(1);

    // (b) 最終在庫 = 本拠生産ぶん + 拠点供給ぶんの単純和(取りこぼし・重複が無い)。
    const productionGain = productionRates.resourceRateByResourceId.get(WOOD);
    if (productionGain === undefined) throw new Error("HEARTH の生産レートが無い(テスト前提)");
    const outpostGain = outpostRates.resourceRateByResourceId.get(WOOD);
    if (outpostGain === undefined) throw new Error("拠点の供給レートが無い(テスト前提)");
    const expectedStock = toRaw(productionGain) * deltaTicks + toRaw(outpostGain) * deltaTicks;
    expect(toRaw(woodEntities[0]?.stock ?? (0 as unknown as Fix))).toBe(expectedStock);
  });

  it("常駐者が facility.workerIds と重複していれば集約時に RulesError(§2 の唯一の入口)", () => {
    let state = stateOf([resident("rShared"), facility("fHearth", HEARTH.id, 0, [id("rShared")])]);
    state = {
      ...state,
      outpostsById: new Map([[id("oMine"), outpostOf("oMine", "near", [id("rShared")])]]),
    };
    expect(() => computeOutpostSupplyRates(state, contentWithOutpost())).toThrow(RulesError);
  });

  it("複数拠点が同じ資源を供給すれば加算される", () => {
    let state = stateOf([resident("r1"), resident("r2")]);
    state = {
      ...state,
      outpostsById: new Map([
        [id("oA"), outpostOf("oA", "near", [id("r1")])],
        [id("oB"), outpostOf("oB", "near", [id("r2")])],
      ]),
    };
    const rates = computeOutpostSupplyRates(state, contentWithOutpost());
    // 1 人ぶん Lv1 供給 10 × 2 拠点 = 20
    expect(toRaw(rates.resourceRateByResourceId.get(WOOD) ?? FIX_ZERO)).toBe(20_000_000);
  });

  it("拠点が 1 つも無ければレートは空(既存挙動と同一)", () => {
    const state = stateOf([]);
    const rates = computeOutpostSupplyRates(state, contentWithOutpost());
    expect(rates.resourceRateByResourceId.size).toBe(0);
  });

  it("applyOutpostSupply は供給先の resource entity が無いと RulesError", () => {
    let state = stateOf([resident("r1")]);
    state = {
      ...state,
      outpostsById: new Map([[id("oMine"), outpostOf("oMine", "near", [id("r1")])]]),
    };
    const rates = computeOutpostSupplyRates(state, contentWithOutpost());
    expect(() => applyOutpostSupply(state, rates, 10)).toThrow(RulesError);
  });
});

// --- 6. ROI(GDD 8.6 の (B) 喪失金銭化を援用・GDD 11.4-7) ----------------------

describe("outpostRoi / outpostNetworkRoi(GDD 11.4-7 拠点網ROI)", () => {
  it("exploration ブロックが無ければ (B) 喪失項は 0(ROI = supply/upkeep)", () => {
    let state = stateOf([resident("r1"), resident("r2")]);
    const outpost = outpostOf("oMine", "near", [id("r1"), id("r2")]);
    state = { ...state, outpostsById: new Map([[outpost.id, outpost]]) };

    const report = outpostRoi(state, contentWithOutpost(), outpost, 0, FIX_ZERO);
    expect(report.rareAssetCount).toBe(0);
    expect(toRaw(report.expectedRareLossFix)).toBe(0);
    expect(report.roiFix).not.toBeNull();
    if (report.roiFix === null) return;
    // supply=20(2人×Lv1=10)、upkeep=food(2×2=4)+moraleCare(1×1)=5 → ROI=4.0
    expect(toRaw(report.supplyValueFix)).toBe(20_000_000);
    expect(toRaw(report.upkeepValueFix)).toBe(5_000_000);
    expect(toRaw(report.roiFix)).toBe(toRaw(fixFromInt(4)));
    expect(toRaw(report.netRevenueFix)).toBe(toRaw(fixFromInt(15)));
  });

  it("拠点網 ROI は全拠点の合算(拠点が無い網は全て 0/null)", () => {
    const state = stateOf([]);
    const network = outpostNetworkRoi(state, contentWithOutpost(), 0, FIX_ZERO);
    expect(network.outpostCount).toBe(0);
    expect(toRaw(network.totalSupplyValueFix)).toBe(0);
    expect(toRaw(network.totalUpkeepValueFix)).toBe(0);
    expect(network.roiFix).toBeNull();
    expect(network.perOutpost).toEqual([]);
  });

  it("拠点網 ROI は各拠点の supply/upkeep を合算してから比を取る", () => {
    let state = stateOf([resident("r1"), resident("r2")]);
    const outpostA = outpostOf("oA", "near", [id("r1")]);
    const outpostB = outpostOf("oB", "far", [id("r2")]);
    state = {
      ...state,
      outpostsById: new Map([
        [outpostA.id, outpostA],
        [outpostB.id, outpostB],
      ]),
    };
    const network = outpostNetworkRoi(state, contentWithOutpost(), 0, FIX_ZERO);
    expect(network.outpostCount).toBe(2);
    expect(network.perOutpost.map((r) => r.outpostId)).toEqual(["oA", "oB"]);
    // supply: 各 1 人 Lv1 = 10 → 合計 20
    expect(toRaw(network.totalSupplyValueFix)).toBe(20_000_000);
    // upkeep: near = food2+moraleCare1 = 3、far = food2+moraleCare1.4 = 3.4 → 合計 6.4
    expect(toRaw(network.totalUpkeepValueFix)).toBe(6_400_000);
    expect(toRaw(network.totalNetRevenueFix)).toBe(toRaw(fixFromRaw(20_000_000 - 6_400_000)));
  });

  it("outpostType 定義が無い拠点への ROI 算出は RulesError", () => {
    let state = stateOf([resident("r1")]);
    const outpost = outpostOf("oGhost", "near", [id("r1")], {
      outpostTypeId: id("outpostUnknown"),
    });
    state = { ...state, outpostsById: new Map([[outpost.id, outpost]]) };
    expect(() => outpostRoi(state, contentWithOutpost(), outpost, 0)).toThrow(RulesError);
  });

  it("balance.outpost ブロックが無い content では ROI が RulesError", () => {
    let state = stateOf([resident("r1")]);
    const outpost = outpostOf("oMine", "near", [id("r1")]);
    state = { ...state, outpostsById: new Map([[outpost.id, outpost]]) };
    // exactOptionalPropertyTypes ゆえ `outpost: undefined` を書けないので、
    // outpostTypeDefs だけを足した(outpost ブロックを持たない)content を組む。
    const noParams: EngineContent = { ...content(), outpostTypeDefs: new Map([[MINE.id, MINE]]) };
    expect(() => outpostRoi(state, noParams, outpost, 0)).toThrow(RulesError);
  });
});
