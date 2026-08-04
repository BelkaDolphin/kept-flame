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

import { advance, createAdvanceContext } from "../../src/engine/advance";
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
  type StorageParams,
} from "../../src/engine/rules/types";
import {
  placeStartingFacilities,
  STARTER_BED_CELL_1,
  STARTER_BED_CELL_2,
} from "../../src/engine/rules/worldGen";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import {
  entitiesOfKind,
  isAliveResident,
  type EntityId,
  type GameState,
} from "../../src/engine/state/state";
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

/** [M68] 寝床(GDD 6.2「寝床」)。content/facility.json の `bed` と同じ形。 */
const BED: FacilityDef = {
  id: id("bed"),
  tags: ["calm"],
  harshWork: false,
  outputPerTickByLevel: [fixFromInt(0), fixFromInt(0), fixFromInt(0), fixFromInt(0), fixFromInt(0)],
  output: { kind: "research" },
  bedCapacityByLevel: [3, 4, 5, 6, 7],
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

/** [R2-A01] 廃材(GDD 6.7)を宣言した content。薪だけ上限つき + スポンジ 50%。 */
const WASTE = id("waste");
const STORAGE: StorageParams = {
  wasteResourceId: WASTE,
  baseCapacityByResourceId: new Map([[WOOD, fixFromInt(100)]]),
  wasteConversionRatioByResourceId: new Map([[WOOD, fixFromRaw(500_000)]]),
  wasteToResearchRatioFix: fixFromRaw(100_000),
  buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
  codifyWasteSubstitutionMaxFix: fixFromRaw(50_000),
};

/** state から resourceId 一致の resource entity を引く(無ければ undefined)。 */
function resourceOf(state: GameState, resourceId: EntityId) {
  return entitiesOfKind(state, "resource").find((r) => r.resourceId === resourceId);
}

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

/** [M68] `fullContent` に寝床定義(`bed`)も足した content。 */
function fullContentWithBed(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = fullContent(overrides);
  const facilityDefs = new Map(base.facilityDefs);
  facilityDefs.set(BED.id, BED);
  return { ...base, facilityDefs };
}

/** [M68] `RECORD_MEDIA.byMedium.stoneTablet` の costResourceId(粘土)。 */
const CLAY = id("clay");

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

  // --- [R2-A01] 廃材の受け皿(§2(a'))-----------------------------------------

  it("storage.wasteResourceId があれば廃材の resource entity を在庫0で作る", () => {
    const c = fullContent({ storage: STORAGE });
    const bare = stateOf([resident("alpha"), resident("beta")]);
    const next = placeStartingFacilities(bare, c);
    const waste = resourceOf(next, WASTE);
    expect(waste).toBeDefined();
    // ID は engine の採番規約(stock + 先頭大文字化)。migration v6→v7 が補填する
    // ID と一致していること(= 新規/既存セーブで同じ受け皿になる)。
    expect(waste?.id).toBe(id("stockWaste"));
    expect(toRaw(waste!.stock)).toBe(0);
  });

  it("廃材の在庫が既にあれば触らない(大移動の継承・救済済みセーブを潰さない)", () => {
    const c = fullContent({ storage: STORAGE });
    const bare = stateOf([
      resident("alpha"),
      { kind: "resource", id: id("resourceWaste"), resourceId: WASTE, stock: fixFromInt(7) },
    ]);
    const next = placeStartingFacilities(bare, c);
    const wastes = entitiesOfKind(next, "resource").filter((r) => r.resourceId === WASTE);
    expect(wastes.length).toBe(1);
    expect(toRaw(wastes[0]!.stock)).toBe(toRaw(fixFromInt(7)));
  });

  it("storage を持たない content では廃材 entity を作らない(省略時は不活性・§3)", () => {
    const c = fullContent();
    expect(c.storage).toBeUndefined();
    const next = placeStartingFacilities(stateOf([resident("alpha")]), c);
    expect(resourceOf(next, WASTE)).toBeUndefined();
  });

  it("wasteResourceId が null なら作らない(廃材変換を行わない content)", () => {
    const c = fullContent({ storage: { ...STORAGE, wasteResourceId: null } });
    const next = placeStartingFacilities(stateOf([resident("alpha")]), c);
    expect(entitiesOfKind(next, "resource").some((r) => r.resourceId === WASTE)).toBe(false);
  });

  // --- [M68] 初期寝床(§2(d)/R4-A15)-------------------------------------------

  it("bed の定義があれば Lv1 の寝床を2基、hearth/workbenchと別セルに置く", () => {
    const c = fullContentWithBed();
    const bare = stateOf([resident("alpha"), resident("beta")]);
    const next = placeStartingFacilities(bare, c);

    const beds = entitiesOfKind(next, "facility").filter((f) => f.defId === BED.id);
    expect(beds.length).toBe(2);
    const cells = beds.map((f) => f.cellIndex).sort((a, b) => a - b);
    expect(cells).toEqual([STARTER_BED_CELL_1, STARTER_BED_CELL_2]);
    for (const bed of beds) {
      expect(bed.level).toBe(1);
      expect(bed.workerIds).toEqual([]);
    }
    // hearth/workbench も別セルに変わらず存在する(衝突していない)。
    expect(entitiesOfKind(next, "facility").length).toBe(4);
  });

  it("bed の定義が無ければ寝床は置かない(hearth/workbench とは独立・§3)", () => {
    const c = fullContent(); // bed を持たない既存 fullContent。
    const next = placeStartingFacilities(stateOf([resident("alpha")]), c);
    expect(entitiesOfKind(next, "facility").some((f) => f.defId === BED.id)).toBe(false);
    // hearth/workbench 2 つだけ(bed が無くても他が壊れない)。
    expect(entitiesOfKind(next, "facility").length).toBe(2);
  });

  it("bed 定義があっても hearth/workbench が欠ければそちらは置かれない(§3 は独立に効く)", () => {
    const c = fullContentWithBed({ facilityDefs: new Map([[BED.id, BED]]) });
    const next = placeStartingFacilities(stateOf([resident("alpha")]), c);
    const facilities = entitiesOfKind(next, "facility");
    expect(facilities.every((f) => f.defId === BED.id)).toBe(true);
    expect(facilities.length).toBe(2);
  });

  // --- [M68] 粘土の最低保証(§2(e)/R4-A11)-------------------------------------

  it("recordMedia があれば石板1枚ぶんの粘土(baseCostFix×costMulFix)を下限保証する", () => {
    const c = fullContent();
    const next = placeStartingFacilities(stateOf([resident("alpha")]), c);
    const clay = resourceOf(next, CLAY);
    expect(clay).toBeDefined();
    // RECORD_MEDIA: baseCostFix=20 × stoneTablet.costMulFix=1 → floor 20。
    expect(toRaw(clay!.stock)).toBe(toRaw(fixFromInt(20)));
  });

  it("既存の粘土在庫が floor 以上なら減らさない(大移動の継承ボーナスを潰さない)", () => {
    const c = fullContent();
    const bare = stateOf([
      resident("alpha"),
      { kind: "resource", id: id("stockClay"), resourceId: CLAY, stock: fixFromInt(500) },
    ]);
    const next = placeStartingFacilities(bare, c);
    const clay = resourceOf(next, CLAY);
    expect(toRaw(clay!.stock)).toBe(toRaw(fixFromInt(500)));
  });

  it("recordMedia を持たない content では粘土 entity を作らない(省略時は不活性)", () => {
    const { recordMedia, ...withoutRecordMedia } = fullContent();
    void recordMedia;
    const next = placeStartingFacilities(stateOf([resident("alpha")]), withoutRecordMedia);
    expect(resourceOf(next, CLAY)).toBeUndefined();
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

  // --- [M68] 新規ゲームでも寝床+粘土が生成される(placeStartingFacilities 経由)---

  it("石板1枚ぶんの粘土が積まれる(R4-A11・placeStartingFacilities 経由)", () => {
    const c = fullContent();
    const state = createNewGameState(c, { algoVersion: 3 });
    expect(toRaw(resourceOf(state, CLAY)!.stock)).toBe(toRaw(fixFromInt(20)));
  });

  it("bed 定義があれば新規ゲームにも寝床2基が含まれる(R4-A15)", () => {
    const c = fullContentWithBed();
    const state = createNewGameState(c, { algoVersion: 3 });
    const facilities = entitiesOfKind(state, "facility");
    // hearth + workbench + 寝床2基。
    expect(facilities.length).toBe(4);
    expect(facilities.filter((f) => f.defId === BED.id).length).toBe(2);
  });

  it("寝床を含む content でも同一入力ならバイト同一(決定論を壊していない・R4-A15)", () => {
    const c = fullContentWithBed();
    const a = createNewGameState(c, { algoVersion: 3 });
    const b = createNewGameState(c, { algoVersion: 3 });
    expect(JSON.stringify(toSerializable(a))).toBe(JSON.stringify(toSerializable(b)));
  });

  it("content に workbench 定義が無い場合は RulesError(起動要件・§0)", () => {
    const c = fullContent({ facilityDefs: new Map([[HEARTH.id, HEARTH]]) });
    expect(() => createNewGameState(c, { algoVersion: 3 })).toThrow(RulesError);
  });

  it("[R2-A01] 保管上限を超えて生産し続けても止まらず、廃材が実際に積み上がる", () => {
    // プレイテスト評価 Round 2 の fatal の再現形: 上限つき資源 + スポンジ機構が
    // 有効な content で新規ゲームを作り、上限を超えるまで advance する。
    // 修正前はここで「廃材 "waste" の resource entity が state に無い」で停止した。
    const c = fullContent({ storage: STORAGE });
    const state = createNewGameState(c, { algoVersion: 3 });
    expect(toRaw(resourceOf(state, WASTE)!.stock)).toBe(0);

    const ctx = createAdvanceContext(state, c);
    const after = advance(state, ctx, 300);

    expect(after.tick).toBe(300);
    // 薪は上限で頭打ち、超過分の 50% が廃材として積まれている。
    expect(toRaw(resourceOf(after, WOOD)!.stock)).toBe(toRaw(fixFromInt(100)));
    expect(toRaw(resourceOf(after, WASTE)!.stock)).toBeGreaterThan(0);
  });

  it("content に townParams が無い場合は RulesError(life が生成できない・GDD 7.5)", () => {
    // exactOptionalPropertyTypes 下では `{ town: undefined }` を明示できない
    // (キー自体を省略するのが正しい「無い」の表現)ので rest 構文でキーを外す。
    const { town, ...withoutTown } = fullContent();
    void town;
    expect(() => createNewGameState(withoutTown, { algoVersion: 3 })).toThrow(RulesError);
  });
});
