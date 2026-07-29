// ---------------------------------------------------------------------------
// [M11] 住民寿命モデル・人口下限・晴天漂着のテスト用フィクスチャ。
//
// vitest の include は `tests/**/*.{test,spec}.ts` なので、このファイル自体は
// テストとして収集されない共有ヘルパである(tests/engine/fixtures.ts と同じ扱い)。
//
// 既存の縮約盤面(fixtures.ts)へ **寝床施設と townParams を足すだけ**で M11 の
// 機構が起動する、という構造をそのまま表現してある。逆に言えば、この 2 つを
// 足さない限り M11 は完全に不活性であり、既存 conformance シナリオが動かない
// ことの根拠になっている(src/engine/rules/population.ts §1)。
//
// 寿命の分位テーブルは **本番 content とは別の、桁を読みやすい 4 分位**を使う
// (平均 1000 tick × 倍率 0.5/1.0/1.5/2.0 = 寿命 500/1000/1500/2000)。
// 本番テーブル(64 分位の対数正規)そのものの検証は tests/engine/lifespan.test.ts
// が content/balance.json を直接読んで行う。
// ---------------------------------------------------------------------------

import { FIX_ZERO, fixFromInt, fixFromRaw, type Fix } from "../../src/engine/fp";
import type { EngineContent, FacilityDef, TownParams } from "../../src/engine/rules/types";
import type { EntityId, ResidentState } from "../../src/engine/state/state";
import { content, id, resident, WOOD } from "./fixtures";

/** 寝床(GDD 6.1 の施設14種のうち「寝床」)。産出は持たない。 */
export const BUNKS: FacilityDef = {
  id: id("bunks"),
  tags: ["calm"],
  harshWork: false,
  outputPerTickByLevel: [FIX_ZERO, FIX_ZERO, FIX_ZERO, FIX_ZERO, FIX_ZERO],
  output: { kind: "resource", resourceId: WOOD },
  bedCapacityByLevel: [2, 4, 6, 8, 10],
};

/** 寝床を持たない参照用の施設定義(寝床上限 0 の盤面を作るため)。 */
export const BUNKS_ID = BUNKS.id;

/** テスト用 townParams。桁が読みやすい値にしてある。 */
export const TEST_TOWN: TownParams = {
  lifespanMeanTicks: 1000,
  lifespanQuantileMulFix: [
    fixFromRaw(500_000),
    fixFromRaw(1_000_000),
    fixFromRaw(1_500_000),
    fixFromRaw(2_000_000),
  ],
  memoryDecayDelayFix: fixFromRaw(1_500_000),
  populationFloorBedRatioFix: fixFromRaw(500_000),
  populationFloorAbsolute: 6,
  arrivalIntervalTicks: 100,
  // 100 / 1.5 = 66.67 → floor 66(ローダーが行う変換と同じ)。
  scarcityArrivalIntervalTicks: 66,
  joinAgeMinTicks: 0,
  joinAgeMaxTicks: 400,
};

/** 既存の縮約 content に寝床施設と townParams を足す。 */
export function townContent(townOverrides: Partial<TownParams> = {}): EngineContent {
  const base = content();
  const facilityDefs = new Map(base.facilityDefs);
  facilityDefs.set(BUNKS.id, BUNKS);
  return {
    facilityDefs,
    techDefs: base.techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    town: { ...TEST_TOWN, ...townOverrides },
  };
}

/** 寝床施設だけ足して townParams は足さない content(不活性の対照群)。 */
export function bunksOnlyContent(): EngineContent {
  const base = content();
  const facilityDefs = new Map(base.facilityDefs);
  facilityDefs.set(BUNKS.id, BUNKS);
  return {
    facilityDefs,
    techDefs: base.techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
  };
}

/** 寿命を持つ住民。`deathTick = bornTick + lifespanTick`。 */
export function agedResident(
  name: string,
  bornTick: number,
  lifespanTick: number,
  overrides: Partial<Omit<ResidentState, "kind" | "id" | "life">> = {},
): ResidentState {
  const base = resident(name, overrides);
  return {
    kind: "resident",
    id: base.id,
    morale: base.morale,
    mastery: base.mastery,
    assignedFacilityId: base.assignedFacilityId,
    dispatched: base.dispatched,
    traitIds: base.traitIds,
    recallImpairedUntilTick: base.recallImpairedUntilTick,
    life: { bornTick, lifespanTick, diedTick: null },
  };
}

/** 「tick T ちょうどに死ぬ」住民(bornTick を逆算する)。 */
export function residentDyingAt(
  name: string,
  deathTick: number,
  lifespanTick = 500,
): ResidentState {
  return agedResident(name, deathTick - lifespanTick, lifespanTick);
}

/** 人間可読値 → Fix(テスト内の読みやすさ用)。 */
export function fixOf(human: number): Fix {
  return fixFromInt(human);
}

/** entity ID(テストから短く書くため)。 */
export function eid(value: string): EntityId {
  return id(value);
}
