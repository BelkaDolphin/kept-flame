// ---------------------------------------------------------------------------
// T5(最小tickエンジン)のテスト用フィクスチャ。
//
// vitest の include は `tests/**/*.{test,spec}.ts` なので、このファイル自体は
// テストとして収集されない共有ヘルパである。
//
// 縮約 content(rules/types.ts §2)と縮約盤面を組み立てる。数値は GDD の値を
// そのまま使い(recallRisk は GDD 11.2 の表)、施設の産出は「Lv1 で 1.0/tick、
// 以降 1.15 倍の個別 FP 展開」という分かりやすい形に固定する。
// ---------------------------------------------------------------------------

import {
  createAdjacencyMatrix,
  type AdjacencyMatrix,
  type AdjacencyPairEntry,
  type CellOccupant,
  type SeedOffsetRange,
  type Tag,
} from "../../src/engine/adjacency";
import { occupiedCells } from "../../src/engine/footprint";
import { fixFromInt, fixFromRaw, type Fix } from "../../src/engine/fp";
import type {
  EngineContent,
  FacilityDef,
  RecallRiskParams,
  TechDef,
} from "../../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityId,
  type EntityState,
  type FacilityFootprint,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "../../src/engine/state/state";
import { createGameState } from "../../src/engine/state/update";

export const id = (value: string): EntityId => entityIdFromString(value);

export const META: GameStateMeta = {
  // [M22] 現行のセーブスキーマ版(src/platform/migration.ts の SAVE_SCHEMA_VERSION)。
  // ここが現行版でないと「現行版はそのまま通す」経路のテストが移行段を走ってしまう。
  saveSchemaVersion: 4,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 0,
};

/** `base × 1.15^(Lv-1)` をオーサリング時展開した想定の Lv1〜5 の個別 FP 値。 */
export function lvCurve(baseHuman: number): readonly Fix[] {
  const raw = baseHuman * 1_000_000;
  return [
    fixFromRaw(raw),
    fixFromRaw(Math.floor(raw * 1.15)),
    fixFromRaw(Math.floor(raw * 1.15 * 1.15)),
    fixFromRaw(Math.floor(raw * 1.15 * 1.15 * 1.15)),
    fixFromRaw(Math.floor(raw * 1.15 * 1.15 * 1.15 * 1.15)),
  ];
}

// --- content ---------------------------------------------------------------

export const WOOD = id("wood");

/** かまど: 熱源・通常業務・薪を産出。 */
export const HEARTH: FacilityDef = {
  id: id("hearth"),
  tags: ["heat"],
  harshWork: false,
  outputPerTickByLevel: lvCurve(1),
  output: { kind: "resource", resourceId: WOOD },
};

/** 鍛冶場: 熱源・**過酷業務**・薪を産出(loadW ×2.0 の検証用)。 */
export const FORGE: FacilityDef = {
  id: id("forge"),
  tags: ["heat"],
  harshWork: true,
  outputPerTickByLevel: lvCurve(2),
  output: { kind: "resource", resourceId: WOOD },
};

/** 研究机: 学芸・通常業務・研究点を産出。 */
export const STUDY_DESK: FacilityDef = {
  id: id("studyDesk"),
  tags: ["lore"],
  harshWork: false,
  outputPerTickByLevel: lvCurve(1),
  output: { kind: "research" },
};

/** 製錬炉: 熱源 + 騒音(複数タグの過密同時参加の検証用)。 */
export const SMELTER: FacilityDef = {
  id: id("smelter"),
  tags: ["heat", "noise"],
  harshWork: true,
  outputPerTickByLevel: lvCurve(1),
  output: { kind: "resource", resourceId: WOOD },
};

export const TECH_BRONZE: TechDef = {
  id: id("techBronze"),
  researchCostFix: fixFromInt(100),
};

export const TECH_IRON: TechDef = {
  id: id("techIron"),
  researchCostFix: fixFromInt(50),
};

export const MEMORY_KEEPER_TRAIT = id("traitMemoryKeeper");

/** GDD 11.2 の表そのもの。 */
export const RECALL_RISK: RecallRiskParams = {
  basePFix: fixFromRaw(50_000), // 0.05
  pMaxFix: fixFromRaw(350_000), // 0.35
  loadWHarshFix: fixFromRaw(2_000_000), // ×2.0
  loadWNormalFix: fixFromRaw(500_000), // ×0.5
  moraleThresholdMidFix: fixFromInt(30),
  moraleBonusMidFix: fixFromRaw(100_000), // +0.10
  moraleThresholdLowFix: fixFromInt(15),
  moraleBonusLowFix: fixFromRaw(200_000), // +0.20
  dispatchWFix: fixFromRaw(150_000), // +0.15
  masteryResistMaxFix: fixFromRaw(200_000), // 0.20
  memoryKeeperResistFix: fixFromRaw(-150_000), // -0.15
  memoryKeeperTraitId: MEMORY_KEEPER_TRAIT,
  durationMinTicks: 1440,
  durationMaxTicks: 2880,
};

/** 熱源×熱源 +20%(GDD 6.2)。target=any にして縮約 rules から効くようにする。 */
export const HEAT_PAIR: AdjacencyPairEntry = {
  tagA: "heat",
  tagB: "heat",
  effect: { effect: "yieldMul", target: { kind: "any" }, valueFix: fixFromRaw(200_000) },
};

export function matrix(
  pairs: readonly AdjacencyPairEntry[] = [HEAT_PAIR],
  seedOffset: SeedOffsetRange | null = null,
): AdjacencyMatrix {
  return createAdjacencyMatrix({
    pairs,
    overcrowd: {
      threshold: 3,
      penaltyPerExcessFix: fixFromRaw(-100_000), // -0.10
      clampFix: fixFromRaw(600_000), // ±0.6
    },
    seedOffset,
  });
}

export function content(overrides: Partial<EngineContent> = {}): EngineContent {
  const base: EngineContent = {
    facilityDefs: new Map([
      [HEARTH.id, HEARTH],
      [FORGE.id, FORGE],
      [STUDY_DESK.id, STUDY_DESK],
      [SMELTER.id, SMELTER],
    ]),
    techDefs: new Map([
      [TECH_BRONZE.id, TECH_BRONZE],
      [TECH_IRON.id, TECH_IRON],
    ]),
    adjacency: matrix(),
    recallRisk: RECALL_RISK,
    coarseTickMinutes: 10,
  };
  return {
    facilityDefs: overrides.facilityDefs ?? base.facilityDefs,
    techDefs: overrides.techDefs ?? base.techDefs,
    adjacency: overrides.adjacency ?? base.adjacency,
    recallRisk: overrides.recallRisk ?? base.recallRisk,
    coarseTickMinutes: overrides.coarseTickMinutes ?? base.coarseTickMinutes,
  };
}

// --- entity ----------------------------------------------------------------

export function resident(
  name: string,
  overrides: Partial<Omit<ResidentState, "kind" | "id">> = {},
): ResidentState {
  return {
    kind: "resident",
    id: id(name),
    morale: overrides.morale ?? fixFromInt(50),
    mastery: overrides.mastery ?? fixFromInt(0),
    assignedFacilityId: overrides.assignedFacilityId ?? null,
    dispatched: overrides.dispatched ?? false,
    traitIds: overrides.traitIds ?? [],
    recallImpairedUntilTick: overrides.recallImpairedUntilTick ?? 0,
  };
}

export function facility(
  name: string,
  defId: EntityId,
  cellIndex: number,
  workerIds: readonly EntityId[] = [],
  level = 1,
  /** [M16] 占有形状(GDD 6.1)。省略 = 1×1(= キーごと持たない正準形)。 */
  footprint?: FacilityFootprint,
): FacilityState {
  if (footprint === undefined) {
    return { kind: "facility", id: id(name), defId, level, cellIndex, workerIds };
  }
  return { kind: "facility", id: id(name), defId, level, cellIndex, workerIds, footprint };
}

export function research(name: string, techId: EntityId, progressHuman = 0): ResearchState {
  return {
    kind: "research",
    id: id(name),
    techId,
    progress: fixFromInt(progressHuman),
    completedTick: null,
  };
}

export function resource(name: string, resourceId: EntityId, stockHuman = 0): ResourceState {
  return { kind: "resource", id: id(name), resourceId, stock: fixFromInt(stockHuman) };
}

export function stateOf(
  entities: readonly EntityState[],
  meta: Partial<GameStateMeta> = {},
): GameState {
  return createGameState(
    {
      saveSchemaVersion: meta.saveSchemaVersion ?? META.saveSchemaVersion,
      contentVersion: meta.contentVersion ?? META.contentVersion,
      algoVersion: meta.algoVersion ?? META.algoVersion,
      worldSeed: meta.worldSeed ?? META.worldSeed,
      tick: meta.tick ?? META.tick,
    },
    entities,
  );
}

/**
 * タグ列を持つセル配置を直接作る(adjacency 単体テスト用)。
 *
 * [M17] `CellOccupancy` の値は「占有者(アンカー + タグ列)」になったので、
 * `[cellIndex, tags]` の組は **1×1 施設**(アンカー = そのセル)として展開する。
 * 大型施設を含む配置は {@link largeOccupancyOf} を使う。
 */
export function occupancyOf(
  entries: readonly (readonly [number, readonly Tag[]])[],
): Map<number, CellOccupant> {
  const occupancy = new Map<number, CellOccupant>();
  for (const [cellIndex, tags] of entries) {
    occupancy.set(cellIndex, { anchorCellIndex: cellIndex, tags });
  }
  return occupancy;
}

/**
 * [M17] 大型施設を含むセル配置を作る。1 エントリ = 1 施設で、占有セル集合は
 * engine と同じ `occupiedCells`(footprint.ts)で展開する
 * (テスト側で占有形状の計算を書き直さない)。
 *
 * @throws {Error} 占有セルが重複した場合(1 セル = 1 施設・GDD 6.1)
 */
export function largeOccupancyOf(
  entries: readonly (readonly [number, FacilityFootprint, readonly Tag[]])[],
): Map<number, CellOccupant> {
  const occupancy = new Map<number, CellOccupant>();
  for (const [anchorCellIndex, footprint, tags] of entries) {
    const occupant: CellOccupant = { anchorCellIndex, tags };
    for (const cellIndex of occupiedCells(anchorCellIndex, footprint)) {
      if (occupancy.has(cellIndex)) {
        throw new Error(`フィクスチャの占有セル ${String(cellIndex)} が重複している`);
      }
      occupancy.set(cellIndex, occupant);
    }
  }
  return occupancy;
}
