// ---------------------------------------------------------------------------
// ⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理(M32)のテスト用フィクスチャ。
//
// vitest の include は `tests/**/*.{test,spec}.ts` なので、このファイル自体は
// テストとして収集されない共有ヘルパである(tests/ui/fixtures.ts と同じ扱い)。
//
// `src/newGame.ts` は住民に `life` を付けない暫定実装(GDD 8.1 の派遣拒否条件に
// 引っかかり誰も派遣できない)ため、タスク指示どおり**テスト内だけ**で
// exploration / outpost が動く content + state を組み立てる。数値は
// GDD 8.1〜8.6 / 9.2 の式を満たす範囲で読みやすい値に決め打ちしてある
// (`tests/engine/exploration.test.ts` / `outpost.test.ts` と同じ立場)。
// ---------------------------------------------------------------------------

import { FIX_ZERO, fixFromInt, fixFromRaw } from "../../src/engine/fp";
import type {
  DistanceBand,
  EngineContent,
  ExplorationParams,
  OutpostParams,
  OutpostTypeDef,
} from "../../src/engine/rules/types";
import { entityIdFromString, type EntityId, type OutpostState } from "../../src/engine/state/state";
import { boardContent } from "./fixtures";
import { agedResident } from "../engine/lifespanFixtures";

const eid = entityIdFromString;

/** 報酬・供給の受け皿(`tests/engine/fixtures.ts` の WOOD と同じ resourceId)。 */
export const M32_REWARD_RESOURCE = eid("wood");

function bandParams(rewardResourceId: EntityId) {
  return {
    baseTravelTicks: 60,
    nodeCountMin: 3,
    nodeCountMax: 3,
    difficultyMin: 40,
    difficultyMax: 40,
    rollRange: 20,
    rewardPerNodeFix: fixFromInt(10),
    rewardResourceId,
    injuryPerFailureFix: fixFromInt(10),
    casualtyInjuryThresholdFix: fixFromInt(100),
    rescueChanceFix: FIX_ZERO,
    wipeBasePFix: fixFromRaw(500_000), // 0.5
  };
}

/** GDD 8.1〜8.6 の exploration ブロック(3 距離帯とも同型の読みやすい値)。 */
export const M32_EXPLORATION_PARAMS: ExplorationParams = {
  byBand: {
    near: bandParams(M32_REWARD_RESOURCE),
    far: bandParams(M32_REWARD_RESOURCE),
    deep: bandParams(M32_REWARD_RESOURCE),
  },
  withdrawRewardRatioFix: fixFromRaw(500_000), // 0.5
  pressInjuryMulFix: fixFromRaw(1_500_000), // 1.5
  withdrawInjuryThresholdFix: fixFromInt(50),
  equipmentBonusFix: FIX_ZERO,
  travelSpeedupMaxFix: fixFromRaw(300_000), // 0.3
  forgoneOutputPerWorkerTickFix: fixFromInt(1),
  rareAssetValueFix: fixFromInt(100),
  wipeMaxPFix: fixFromRaw(700_000), // 0.7
};

/** GDD 9.2 の拠点タイプ(3 タイプのうち鉱山ぶん。テストは 1 種で足りる)。 */
export const M32_OUTPOST_TYPE: OutpostTypeDef = {
  id: eid("outpostMineTest"),
  resourceId: eid("iron"),
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
    minFix: fixFromRaw(50_000),
    maxFix: fixFromRaw(600_000), // 0.60
  },
  shadeSensitivityFix: fixFromInt(1),
};

export const M32_OUTPOST_PARAMS: OutpostParams = {
  distanceBandUpkeepMulFix: {
    near: fixFromInt(1),
    far: fixFromRaw(1_400_000), // 1.4
    deep: fixFromRaw(1_800_000), // 1.8
  },
};

/** exploration + outpost の両ブロックを足した content(`{...boardContent(), …}` の定型)。 */
export function m32Content(overrides: Partial<EngineContent> = {}): EngineContent {
  return {
    ...boardContent(),
    exploration: M32_EXPLORATION_PARAMS,
    outpostTypeDefs: new Map([[M32_OUTPOST_TYPE.id, M32_OUTPOST_TYPE]]),
    outpost: M32_OUTPOST_PARAMS,
    ...overrides,
  };
}

/** 寿命あり・生存・非派遣中の派遣候補になれる住民。 */
export function candidateResident(
  name: string,
  overrides: Parameters<typeof agedResident>[3] = {},
) {
  return agedResident(name, 0, 5000, overrides);
}

export function outpostOf(
  name: string,
  band: DistanceBand,
  residentIds: readonly EntityId[],
  overrides: Partial<Omit<OutpostState, "id" | "band" | "residentIds">> = {},
): OutpostState {
  return {
    id: eid(name),
    outpostTypeId: M32_OUTPOST_TYPE.id,
    level: 1,
    band,
    residentIds,
    establishedTick: 0,
    ...overrides,
  };
}
