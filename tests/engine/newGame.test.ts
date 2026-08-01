// ---------------------------------------------------------------------------
// M53: ニューゲーム生成 + 難度シード。
//   `src/newGame.ts`(生成器本体)/ `src/difficulty.ts`
//   (難度シードの content 変換・composition root)/ `src/engine/rules/worldGen.ts`
//   (開始施設・詰み防止の共通生成器)を検収条件に沿って固定する:
//
//   - 同一 worldSeed でニューゲーム生成がバイト同一(serialize 往復)
//   - 初期住民全員が life を持つ(= explorationTeamCandidates の候補に挙がる)
//   - 難度「穏」で該当係数(recallRisk / exploration の負傷)が反映される
//   - `hearth`/`workbench` が揃わない content では開始施設が 1 つも増えない
//     (既存 conformance 縮約 content との非干渉)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { explorationTeamCandidates } from "../../src/engine/assist/exploration";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  RulesError,
  type EngineContent,
  type ExplorationBandParams,
  type ExplorationParams,
  type FacilityDef,
  type ReclaimParams,
  type RecordMediaParams,
} from "../../src/engine/rules/types";
import { placeStartingFacilities } from "../../src/engine/rules/worldGen";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import { entitiesOfKind, isAliveResident } from "../../src/engine/state/state";
import {
  DEFAULT_DIFFICULTY_SEED_ID,
  DIFFICULTY_SEED_IDS,
  applyDifficultySeed,
  isDifficultySeedId,
} from "../../src/difficulty";
import { createNewGameState } from "../../src/newGame";

import {
  RECALL_RISK,
  content as baseContent,
  HEARTH,
  WOOD,
  id,
  resident,
  stateOf,
} from "./fixtures";
import { TEST_TOWN } from "./lifespanFixtures";

// --- 難度シード(difficulty.ts)----------------------------------------

const ONE_BAND: ExplorationBandParams = {
  baseTravelTicks: 960,
  nodeCountMin: 3,
  nodeCountMax: 4,
  difficultyMin: 100,
  difficultyMax: 200,
  rollRange: 90,
  rewardPerNodeFix: fixFromInt(10),
  rewardResourceId: WOOD,
  injuryPerFailureFix: fixFromInt(8), // 8.0
  casualtyInjuryThresholdFix: fixFromInt(60),
  rescueChanceFix: fixFromRaw(60_000),
  wipeBasePFix: fixFromRaw(100_000),
};

const EXPLORATION: ExplorationParams = {
  byBand: { deep: ONE_BAND, far: ONE_BAND, near: ONE_BAND },
  withdrawRewardRatioFix: fixFromRaw(500_000),
  pressInjuryMulFix: fixFromRaw(1_500_000),
  withdrawInjuryThresholdFix: fixFromInt(30),
  equipmentBonusFix: fixFromInt(0),
  travelSpeedupMaxFix: fixFromRaw(300_000),
  forgoneOutputPerWorkerTickFix: fixFromInt(1),
  rareAssetValueFix: fixFromInt(20_000),
  wipeMaxPFix: fixFromRaw(350_000),
};

describe("difficulty.ts: 難度シード「穏」", () => {
  it("DIFFICULTY_SEED_IDS/isDifficultySeedId/既定値", () => {
    expect(DIFFICULTY_SEED_IDS).toEqual(["calm", "standard"]);
    expect(isDifficultySeedId("calm")).toBe(true);
    expect(isDifficultySeedId("standard")).toBe(true);
    expect(isDifficultySeedId("hard")).toBe(false);
    expect(DEFAULT_DIFFICULTY_SEED_ID).toBe("standard");
  });

  it("standard は content を無変更(参照同一)で返す", () => {
    const c: EngineContent = { ...baseContent(), exploration: EXPLORATION };
    expect(applyDifficultySeed(c, "standard")).toBe(c);
  });

  it("calm は recallRisk の加算項と上限を厳密に半分にする(GDD 2.2 想起困難頻度0.5倍)", () => {
    const c = baseContent();
    const calm = applyDifficultySeed(c, "calm");
    expect(toRaw(calm.recallRisk.basePFix)).toBe(toRaw(RECALL_RISK.basePFix) / 2);
    expect(toRaw(calm.recallRisk.pMaxFix)).toBe(toRaw(RECALL_RISK.pMaxFix) / 2);
    expect(toRaw(calm.recallRisk.moraleBonusMidFix)).toBe(toRaw(RECALL_RISK.moraleBonusMidFix) / 2);
    expect(toRaw(calm.recallRisk.moraleBonusLowFix)).toBe(toRaw(RECALL_RISK.moraleBonusLowFix) / 2);
    expect(toRaw(calm.recallRisk.dispatchWFix)).toBe(toRaw(RECALL_RISK.dispatchWFix) / 2);
    // 半分にしない項はそのまま(GDD 2.2 が名指ししていない係数を動かさない)。
    expect(calm.recallRisk.loadWHarshFix).toBe(RECALL_RISK.loadWHarshFix);
    expect(calm.recallRisk.masteryResistMaxFix).toBe(RECALL_RISK.masteryResistMaxFix);
  });

  it("calm は exploration の負傷蓄積を半分にする(GDD 2.2 (B)出現頻度低)", () => {
    const c: EngineContent = { ...baseContent(), exploration: EXPLORATION };
    const calm = applyDifficultySeed(c, "calm");
    const band = calm.exploration?.byBand.near;
    expect(band).toBeDefined();
    expect(toRaw(band!.injuryPerFailureFix)).toBe(toRaw(ONE_BAND.injuryPerFailureFix) / 2);
    // 負傷以外は動かさない。
    expect(band!.casualtyInjuryThresholdFix).toBe(ONE_BAND.casualtyInjuryThresholdFix);
    expect(calm.exploration?.wipeMaxPFix).toBe(EXPLORATION.wipeMaxPFix);
  });

  it("content.exploration が無い content では calm でも exploration は undefined のまま", () => {
    const c = baseContent();
    expect(c.exploration).toBeUndefined();
    expect(applyDifficultySeed(c, "calm").exploration).toBeUndefined();
  });
});

// --- 開始盤面の共通生成器(rules/worldGen.ts)---------------------------------

const WORKBENCH: FacilityDef = {
  id: id("workbench"),
  tags: ["lore"],
  harshWork: false,
  outputPerTickByLevel: [fixFromInt(1), fixFromInt(1), fixFromInt(1), fixFromInt(1), fixFromInt(1)],
  output: { kind: "research" },
};

const RECLAIM: ReclaimParams = {
  baseCostFix: fixFromInt(40),
  costGrowthFix: fixFromRaw(1_150_000),
  costCapFix: fixFromInt(2000),
  costResourceId: WOOD,
  initialRubbleCells: [12, 13, 14],
};

const RECORD_MEDIA: RecordMediaParams = {
  baseCostFix: fixFromInt(20),
  baseDurationTicks: 720,
  printingTechId: null,
  printingCostMulFix: fixFromRaw(500_000),
  printingTimeMulFix: fixFromRaw(500_000),
  byMedium: {
    stoneTablet: {
      costMulFix: fixFromInt(1),
      timeMulFix: fixFromInt(1),
      caravanWeightFix: fixFromInt(1),
      flammable: false,
      costResourceId: id("clay"),
    },
    paper: {
      costMulFix: fixFromRaw(600_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: id("paper"),
    },
  },
};

const TECH_FIRE_STARTING = id("techFireStarting");

/** 開始施設・寿命どちらも活性化する content(HEARTH は fixtures.ts と同じ ID)。 */
function fullContent(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = baseContent({
    facilityDefs: new Map([
      [HEARTH.id, HEARTH],
      [WORKBENCH.id, WORKBENCH],
    ]),
    techDefs: new Map([
      [TECH_FIRE_STARTING, { id: TECH_FIRE_STARTING, researchCostFix: fixFromInt(10) }],
    ]),
  });
  return {
    facilityDefs: base.facilityDefs,
    techDefs: base.techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    town: TEST_TOWN,
    reclaim: RECLAIM,
    recordMedia: RECORD_MEDIA,
    ...overrides,
  };
}

describe("rules/worldGen.ts: placeStartingFacilities", () => {
  it("hearth/workbench が揃っていれば、生存住民の先頭2名を割り当てて設置する", () => {
    const c = fullContent();
    const bare = stateOf([resident("alpha"), resident("beta"), resident("gamma")]);
    const next = placeStartingFacilities(bare, c);

    const facilities = entitiesOfKind(next, "facility");
    expect(facilities.length).toBe(2);
    const hearth = facilities.find((f) => f.defId === HEARTH.id);
    const workbench = facilities.find((f) => f.defId === WORKBENCH.id);
    expect(hearth?.workerIds.length).toBe(1);
    expect(workbench?.workerIds.length).toBe(1);
    expect(hearth?.workerIds[0]).not.toBe(workbench?.workerIds[0]);

    // 割り当てた住民側の assignedFacilityId も揃っている。
    const workerId = hearth?.workerIds[0];
    const workerEntity = next.entityStateById.get(workerId!);
    expect(workerEntity?.kind).toBe("resident");
    if (workerEntity?.kind === "resident") {
      expect(workerEntity.assignedFacilityId).toBe(hearth?.id);
    }
  });

  it("workbench 定義が無ければ施設は 1 つも置かない(全か無か・§3)", () => {
    const c = fullContent({ facilityDefs: new Map([[HEARTH.id, HEARTH]]) });
    const bare = stateOf([resident("alpha")]);
    const next = placeStartingFacilities(bare, c);
    expect(entitiesOfKind(next, "facility").length).toBe(0);
  });

  it("既に facility を持つ state へ呼ぶと RulesError で止まる", () => {
    const c = fullContent();
    const bare = stateOf([resident("alpha")], {});
    const withFacility = placeStartingFacilities(bare, c);
    expect(() => placeStartingFacilities(withFacility, c)).toThrow(RulesError);
  });

  it("reclaim があれば開墾コスト(解放数0の1回ぶん)未満にしない(詰み防止・GDD9.1)", () => {
    const c = fullContent();
    const bare = stateOf([resident("alpha"), resident("beta")]);
    const next = placeStartingFacilities(bare, c);
    const stock = [...entitiesOfKind(next, "resource")].find((r) => r.resourceId === WOOD);
    expect(stock).toBeDefined();
    expect(toRaw(stock!.stock)).toBeGreaterThanOrEqual(toRaw(RECLAIM.baseCostFix));
  });

  it("既存在庫が floor 以上なら減らさない(大移動の継承ボーナスを潰さない)", () => {
    const c = fullContent();
    const bare = stateOf([
      resident("alpha"),
      { kind: "resource", id: id("stockWood"), resourceId: WOOD, stock: fixFromInt(9999) },
    ]);
    const next = placeStartingFacilities(bare, c);
    const stock = [...entitiesOfKind(next, "resource")].find((r) => r.resourceId === WOOD);
    expect(toRaw(stock!.stock)).toBe(toRaw(fixFromInt(9999)));
  });

  it("content の全 facility 出力ぶん、resource entity を在庫0で先に作る(産出先クラッシュの回避)", () => {
    const c = fullContent();
    const bare = stateOf([resident("alpha"), resident("beta")]);
    const next = placeStartingFacilities(bare, c);
    // HEARTH(fixtures.ts)は WOOD を産出する。
    const wood = [...entitiesOfKind(next, "resource")].find((r) => r.resourceId === WOOD);
    expect(wood).toBeDefined();
  });
});

// --- 生成器本体(src/newGame.ts)---------------------------------------------

describe("src/newGame.ts: createNewGameState", () => {
  it("同一入力ならバイト同一(serialize 往復も同一)", () => {
    const c = fullContent();
    const a = createNewGameState(c, { algoVersion: 3 });
    const b = createNewGameState(c, { algoVersion: 3 });
    const bytesA = JSON.stringify(toSerializable(a));
    const bytesB = JSON.stringify(toSerializable(b));
    expect(bytesA).toBe(bytesB);

    const roundTripped = fromSerializable(toSerializable(a));
    expect(JSON.stringify(toSerializable(roundTripped))).toBe(bytesA);
  });

  it("worldSeed が違えば結果も変わる(固定シードでないことの確認)", () => {
    const c = fullContent();
    const a = createNewGameState(c, { algoVersion: 3, worldSeed: "seedOne" });
    const b = createNewGameState(c, { algoVersion: 3, worldSeed: "seedTwo" });
    expect(JSON.stringify(toSerializable(a))).not.toBe(JSON.stringify(toSerializable(b)));
  });

  it("初期住民全員が life を持ち、探索編成の候補に挙がる(GDD 7.7 / 8.1)", () => {
    const c = fullContent();
    const state = createNewGameState(c, { algoVersion: 3 });
    const residents = entitiesOfKind(state, "resident");
    expect(residents.length).toBe(6);
    for (const r of residents) {
      expect(r.life).toBeDefined();
      expect(isAliveResident(r)).toBe(true);
    }
    const candidates = explorationTeamCandidates(state);
    expect(candidates.length).toBe(6);
  });

  it("難度シード calm/standard のどちらでも生成でき、住民構成は変わらない", () => {
    // 係数(recallRisk / exploration)が実際に半分になることは
    // difficulty.ts 側のテストが直接固定している。ここでは
    // createNewGameState が difficultySeedId を最後まで通しエラーなく完走する
    // こと・難度が住民の人数や ID を動かさないこと(content 変換であって
    // 住民生成規則そのものは変えない)だけを確認する。
    const c = fullContent();
    const standard = createNewGameState(c, { algoVersion: 3, difficultySeedId: "standard" });
    const calm = createNewGameState(c, { algoVersion: 3, difficultySeedId: "calm" });
    expect(entitiesOfKind(calm, "resident").length).toBe(
      entitiesOfKind(standard, "resident").length,
    );
  });

  it("開始施設(hearth/workbench)が置かれ、就労者が割り当てられる", () => {
    const c = fullContent();
    const state = createNewGameState(c, { algoVersion: 3 });
    const facilities = entitiesOfKind(state, "facility");
    expect(facilities.length).toBe(2);
    for (const f of facilities) {
      expect(f.workerIds.length).toBe(1);
    }
  });

  it("content に workbench 定義が無い場合は RulesError(起動要件・§0)", () => {
    const c = fullContent({ facilityDefs: new Map([[HEARTH.id, HEARTH]]) });
    expect(() => createNewGameState(c, { algoVersion: 3 })).toThrow(RulesError);
  });

  it("content に townParams が無い場合は RulesError(life が生成できない・GDD 7.5)", () => {
    // exactOptionalPropertyTypes 下では `{ town: undefined }` を明示できない
    // (キー自体を省略するのが正しい「無い」の表現)ので rest 構文でキーを外す。
    const { town, ...withoutTown } = fullContent();
    void town;
    expect(() => createNewGameState(withoutTown, { algoVersion: 3 })).toThrow(RulesError);
  });
});
