// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 派生値(computed)の定義 — ADR-002(2) / ADR-027 / ADR-029(2)
//
// ストアが持つ派生値は**ここで全部宣言する**(ADR リポ構成 src/ui/store.ts の
// 「画面別/近傍セル別 computed() 明示定義」)。画面コンポーネントが自分で
// `computed(() => store.sources.state.value...)` を書き始めると、
// ADR-002(2) の fan-in 上界がコードから読めなくなるため。
//
// ===========================================================================
// 1. 2 層構造:セル局所(O(近傍))と 全体集計(別 signal)
// ===========================================================================
//   (a) **セル局所**  cellAdjacency[i] / cellView[i]
//       依存は自セル + 8 近傍の配置素性のみ。1 セル編集で再計算されるのは
//       高々 9 個(ADR-002(2) の「再描画上界 O(8)」)。格子画面の各セル
//       コンポーネントはこれを 1 個だけ購読する。
//
//   (b) **全体集計**  gridSummary
//       48 セル全部に依存する。**セル表示コンポーネントから購読してはならない**
//       (ADR-002(2)「グリッド全体を跨ぐ単一集計 signal を表示層の依存に置かない」)。
//       用途は②格子ビューの凡例/警告総数と⑫帰還ダイジェストに限る。
//
// ===========================================================================
// 2. 値の派生(資源・研究・住民)は state signal 直依存でよい
// ===========================================================================
//   これらは毎 tick 変わるのが仕様であり、セル単位に割る意味がない。
//   代わりに ADR-027(2) の「非アクティブ画面はアンマウント」で守る:
//   computed は遅延評価なので、画面がアンマウントされて購読が切れれば
//   dirty の印が付くだけで評価されない。
//
//   ホームハブだけは常時見えるので、そこに出す `homeBadges` は
//   **件数だけ**にして tick を含めない(ADR-027(4)「軽量 computed に限定」)。
//   tick を混ぜると毎分オブジェクトが変わり、バッジ行が毎分再描画される。
//
// ===========================================================================
// 3. 隣接乗数は engine と同じ 1 実装(単一正準実装の維持)
// ===========================================================================
//   cellAdjacency は engine の {@link computeCellAdjacency} をそのまま呼ぶ。
//   UI 用に式を書き直さない。よって UI 表示の乗数と、生産式が使う
//   `AdvanceContext.multiplierByFacilityId`(engine が同じ関数で precompute
//   したもの)は常に一致する。この一致は tests/ui/derived.test.ts が直接
//   assert している(乖離したら即落ちる)。
// ---------------------------------------------------------------------------

import {
  GRID_CELL_COUNT,
  applySeedOffsets,
  cellIdOf,
  computeCellAdjacency,
  neighborCellIndices,
  type AdjacencyMatrix,
  type CellAdjacencyResult,
  type Tag,
} from "../engine/adjacency";
import { FIX_ONE, FIX_ZERO, toApproxNumber, toRaw, type Fix } from "../engine/fp";
import type { RecordMedium } from "../engine/rules/types";
import {
  entitiesOfKind,
  type CodifyState,
  type EntityId,
  type GameState,
} from "../engine/state/state";
import { computed, type ReadonlyComputed } from "./reactive";
import type { StoreSources } from "./sources";

/** 8 近傍の一覧は盤面形状だけで決まる静的値なので、モジュール読込時に 1 回作る。 */
const NEIGHBOR_CELLS: readonly (readonly number[])[] = (() => {
  const result: (readonly number[])[] = [];
  for (let i = 0; i < GRID_CELL_COUNT; i++) {
    result.push(neighborCellIndices(i));
  }
  return result;
})();

function neighborsOf(cellIndex: number): readonly number[] {
  const neighbors = NEIGHBOR_CELLS[cellIndex];
  if (neighbors === undefined) {
    throw new RangeError(`セル番号 ${String(cellIndex)} が格子の範囲を外れている`);
  }
  return neighbors;
}

// --- 1. セル局所の派生値 ---------------------------------------------------

/** セル 1 個の表示モデル。②格子ビュー / ③施設詳細が読む単位。 */
export interface CellViewModel {
  readonly cellIndex: number;
  /** 安定文字列 ID(`c00`〜`c47`)。key 属性・辞書順選抜の基準(GDD 6.3(c))。 */
  readonly cellId: string;
  readonly occupied: boolean;
  readonly facilityId: EntityId | null;
  readonly defId: EntityId | null;
  /** 施設タグ(4重符号化の記号/色/パターンの引き当て元・ADR-003)。 */
  readonly tags: readonly Tag[];
  readonly level: number;
  readonly workerCount: number;
  /** 産出乗数 = max(0, 1 + ボーナス + 過密ペナ)。空きセルは 1.0。 */
  readonly multiplierFix: Fix;
  /** 表示用の近似値(4重符号化の「数値」・GDD 6.5)。 */
  readonly multiplierApprox: number;
  readonly bonusFix: Fix;
  readonly overcrowdPenaltyFix: Fix;
  /** 過密でボーナスが無効化された近傍の件数(常時過密警告バッジ・GDD 6.5)。 */
  readonly overcrowdedNeighborCount: number;
  readonly overcrowded: boolean;
}

function cellAdjacencyEquals(
  a: CellAdjacencyResult | null,
  b: CellAdjacencyResult | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    toRaw(a.multiplierFix) === toRaw(b.multiplierFix) &&
    toRaw(a.bonusFix) === toRaw(b.bonusFix) &&
    toRaw(a.overcrowdPenaltyFix) === toRaw(b.overcrowdPenaltyFix) &&
    a.overcrowdedNeighborCount === b.overcrowdedNeighborCount
  );
}

function cellViewEquals(a: CellViewModel, b: CellViewModel): boolean {
  return (
    a.cellIndex === b.cellIndex &&
    a.occupied === b.occupied &&
    a.facilityId === b.facilityId &&
    a.defId === b.defId &&
    a.tags === b.tags &&
    a.level === b.level &&
    a.workerCount === b.workerCount &&
    toRaw(a.multiplierFix) === toRaw(b.multiplierFix) &&
    toRaw(a.bonusFix) === toRaw(b.bonusFix) &&
    toRaw(a.overcrowdPenaltyFix) === toRaw(b.overcrowdPenaltyFix) &&
    a.overcrowdedNeighborCount === b.overcrowdedNeighborCount
  );
}

// --- 2. 全体集計(セル表示の依存に置かない・§1(b)) --------------------------

/** 格子全体の集計。②の凡例/総数と⑫帰還ダイジェスト専用。 */
export interface GridSummary {
  readonly occupiedCellCount: number;
  readonly emptyCellCount: number;
  /** 過密ペナルティが実際に掛かっているセルの数。 */
  readonly overcrowdedCellCount: number;
  /** 無効化された近傍の総数(タグ横断)。 */
  readonly overcrowdedNeighborTotal: number;
}

// --- 3. 値の派生(§2) ------------------------------------------------------

export interface ResourceView {
  readonly entityId: EntityId;
  readonly resourceId: EntityId;
  readonly stockFix: Fix;
  readonly stockApprox: number;
}

export interface ResearchView {
  readonly entityId: EntityId;
  readonly techId: EntityId;
  readonly progressFix: Fix;
  readonly progressApprox: number;
  readonly completedTick: number | null;
  readonly completed: boolean;
}

export interface ResidentView {
  readonly entityId: EntityId;
  readonly moraleApprox: number;
  readonly masteryApprox: number;
  readonly assignedFacilityId: EntityId | null;
  readonly dispatched: boolean;
  /** 現在 tick で想起困難が続いているか(GDD 11.2)。 */
  readonly recallImpaired: boolean;
  readonly recallImpairedUntilTick: number;
  readonly traitIds: readonly EntityId[];
}

export interface CodifyView {
  readonly entityId: EntityId;
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  readonly progressApprox: number;
  readonly requiredWorkApprox: number;
  readonly completedTick: number | null;
  readonly completed: boolean;
}

/**
 * ①ホームハブの緊急度バッジ(ADR-027(4))。**tick を含めない**(§2)。
 * 件数が動かない限り再描画も起きない。
 */
export interface HomeBadges {
  readonly residentCount: number;
  /** 想起困難で稼働できない住民(GDD 11.2)。 */
  readonly impairedResidentCount: number;
  /** どの施設にも就いていない住民。 */
  readonly idleResidentCount: number;
  readonly dispatchedResidentCount: number;
  readonly facilityCount: number;
  readonly activeResearchCount: number;
  readonly completedResearchCount: number;
  /** 成文化キューに並んでいる記録(未完了)。 */
  readonly pendingCodifyCount: number;
  readonly completedCodifyCount: number;
}

function homeBadgesEqual(a: HomeBadges, b: HomeBadges): boolean {
  return (
    a.residentCount === b.residentCount &&
    a.impairedResidentCount === b.impairedResidentCount &&
    a.idleResidentCount === b.idleResidentCount &&
    a.dispatchedResidentCount === b.dispatchedResidentCount &&
    a.facilityCount === b.facilityCount &&
    a.activeResearchCount === b.activeResearchCount &&
    a.completedResearchCount === b.completedResearchCount &&
    a.pendingCodifyCount === b.pendingCodifyCount &&
    a.completedCodifyCount === b.completedCodifyCount
  );
}

// --- 4. 派生値一式 ---------------------------------------------------------

/**
 * ストアが公開する派生値。**画面はここにあるものだけを購読する**。
 * 新しい画面の派生値が要るときは、画面側で computed を書かずにここへ足す
 * (fan-in の設計をこのファイル 1 枚で読めるようにするため)。
 */
export interface StoreDerived {
  /** シード揺らぎ(GDD 6.4-2)を焼き込んだ隣接行列。content + worldSeed 依存。 */
  readonly adjacencyMatrix: ReadonlyComputed<AdjacencyMatrix>;
  /** 長さ 48。空きセルは null。依存は自セル + 8 近傍の配置素性のみ(§1(a))。 */
  readonly cellAdjacency: readonly ReadonlyComputed<CellAdjacencyResult | null>[];
  /** 長さ 48。②格子ビューの 1 セルが購読する単位。 */
  readonly cellView: readonly ReadonlyComputed<CellViewModel>[];
  /** 全体集計(§1(b))。セル表示から購読しないこと。 */
  readonly gridSummary: ReadonlyComputed<GridSummary>;

  readonly tick: ReadonlyComputed<number>;
  readonly resources: ReadonlyComputed<readonly ResourceView[]>;
  readonly research: ReadonlyComputed<readonly ResearchView[]>;
  readonly residents: ReadonlyComputed<readonly ResidentView[]>;
  readonly codify: ReadonlyComputed<readonly CodifyView[]>;
  readonly homeBadges: ReadonlyComputed<HomeBadges>;

  /** 選択中セルの表示モデル(未選択は null)。③施設詳細と②の選択枠が読む。 */
  readonly selectedCell: ReadonlyComputed<CellViewModel | null>;
}

const EMPTY_TAGS: readonly Tag[] = [];

function buildCellView(
  cellIndex: number,
  sources: StoreSources,
  adjacency: CellAdjacencyResult | null,
): CellViewModel {
  const facilitySignal = sources.cellFacility[cellIndex];
  const placementSignal = sources.cellPlacement[cellIndex];
  if (facilitySignal === undefined || placementSignal === undefined) {
    throw new RangeError(`セル番号 ${String(cellIndex)} が格子の範囲を外れている`);
  }
  // どちらも**自セルの**根 signal であり、近傍は読まない(fan-in はセル局所)。
  const facility = facilitySignal.value;
  const placement = placementSignal.value;

  if (facility === null || adjacency === null || placement === null) {
    return {
      cellIndex,
      cellId: cellIdOf(cellIndex),
      occupied: false,
      facilityId: null,
      defId: null,
      tags: EMPTY_TAGS,
      level: 0,
      workerCount: 0,
      multiplierFix: FIX_ONE,
      multiplierApprox: 1,
      bonusFix: FIX_ZERO,
      overcrowdPenaltyFix: FIX_ZERO,
      overcrowdedNeighborCount: 0,
      overcrowded: false,
    };
  }

  return {
    cellIndex,
    cellId: cellIdOf(cellIndex),
    occupied: true,
    facilityId: facility.id,
    defId: facility.defId,
    tags: placement.tags,
    level: facility.level,
    workerCount: facility.workerIds.length,
    multiplierFix: adjacency.multiplierFix,
    multiplierApprox: toApproxNumber(adjacency.multiplierFix),
    bonusFix: adjacency.bonusFix,
    overcrowdPenaltyFix: adjacency.overcrowdPenaltyFix,
    overcrowdedNeighborCount: adjacency.overcrowdedNeighborCount,
    overcrowded: adjacency.overcrowdedNeighborCount > 0,
  };
}

/** 根 signal から派生値一式を組み立てる。ストア 1 個につき 1 回だけ呼ばれる。 */
export function createStoreDerived(sources: StoreSources): StoreDerived {
  const adjacencyMatrix = computed<AdjacencyMatrix>(
    () => applySeedOffsets(sources.content.value.adjacency, sources.worldSeedU32.value),
    { name: "adjacencyMatrix" },
  );

  const cellAdjacency: ReadonlyComputed<CellAdjacencyResult | null>[] = [];
  for (let i = 0; i < GRID_CELL_COUNT; i++) {
    const cellIndex = i;
    cellAdjacency.push(
      computed<CellAdjacencyResult | null>(
        () => {
          const placementSignal = sources.cellPlacement[cellIndex];
          if (placementSignal === undefined) {
            throw new RangeError(`セル番号 ${String(cellIndex)} が格子の範囲を外れている`);
          }
          const self = placementSignal.value;
          // 空きセルは近傍を 1 つも読まない = 近傍が変わっても再計算されない。
          if (self === null) return null;

          const occupancy = new Map<number, readonly Tag[]>();
          for (const neighborIndex of neighborsOf(cellIndex)) {
            const neighbor = sources.cellPlacement[neighborIndex]?.value ?? null;
            if (neighbor !== null) occupancy.set(neighborIndex, neighbor.tags);
          }
          return computeCellAdjacency(adjacencyMatrix.value, occupancy, {
            cellIndex,
            defId: self.defId,
            tags: self.tags,
          });
        },
        { equals: cellAdjacencyEquals, name: `cellAdjacency[${String(i)}]` },
      ),
    );
  }

  const cellView: ReadonlyComputed<CellViewModel>[] = [];
  for (let i = 0; i < GRID_CELL_COUNT; i++) {
    const cellIndex = i;
    cellView.push(
      computed<CellViewModel>(
        () => {
          const adjacency = cellAdjacency[cellIndex];
          if (adjacency === undefined) {
            throw new RangeError(`セル番号 ${String(cellIndex)} が格子の範囲を外れている`);
          }
          return buildCellView(cellIndex, sources, adjacency.value);
        },
        { equals: cellViewEquals, name: `cellView[${String(i)}]` },
      ),
    );
  }

  const gridSummary = computed<GridSummary>(
    () => {
      let occupiedCellCount = 0;
      let overcrowdedCellCount = 0;
      let overcrowdedNeighborTotal = 0;
      for (const node of cellAdjacency) {
        const result = node.value;
        if (result === null) continue;
        occupiedCellCount++;
        if (result.overcrowdedNeighborCount > 0) {
          overcrowdedCellCount++;
          overcrowdedNeighborTotal += result.overcrowdedNeighborCount;
        }
      }
      return {
        occupiedCellCount,
        emptyCellCount: GRID_CELL_COUNT - occupiedCellCount,
        overcrowdedCellCount,
        overcrowdedNeighborTotal,
      };
    },
    { name: "gridSummary" },
  );

  const tick = computed<number>(() => sources.state.value.tick, { name: "tick" });

  const resources = computed<readonly ResourceView[]>(
    () => {
      const state: GameState = sources.state.value;
      return entitiesOfKind(state, "resource").map((resource) => ({
        entityId: resource.id,
        resourceId: resource.resourceId,
        stockFix: resource.stock,
        stockApprox: toApproxNumber(resource.stock),
      }));
    },
    { name: "resources" },
  );

  const research = computed<readonly ResearchView[]>(
    () => {
      const state: GameState = sources.state.value;
      return entitiesOfKind(state, "research").map((entry) => ({
        entityId: entry.id,
        techId: entry.techId,
        progressFix: entry.progress,
        progressApprox: toApproxNumber(entry.progress),
        completedTick: entry.completedTick,
        completed: entry.completedTick !== null,
      }));
    },
    { name: "research" },
  );

  const residents = computed<readonly ResidentView[]>(
    () => {
      const state: GameState = sources.state.value;
      return entitiesOfKind(state, "resident").map((resident) => ({
        entityId: resident.id,
        moraleApprox: toApproxNumber(resident.morale),
        masteryApprox: toApproxNumber(resident.mastery),
        assignedFacilityId: resident.assignedFacilityId,
        dispatched: resident.dispatched,
        recallImpaired: resident.recallImpairedUntilTick > state.tick,
        recallImpairedUntilTick: resident.recallImpairedUntilTick,
        traitIds: resident.traitIds,
      }));
    },
    { name: "residents" },
  );

  const codify = computed<readonly CodifyView[]>(
    () => {
      const state: GameState = sources.state.value;
      return entitiesOfKind(state, "codify").map((job: CodifyState) => ({
        entityId: job.id,
        techId: job.techId,
        medium: job.medium,
        progressApprox: toApproxNumber(job.progress),
        requiredWorkApprox: toApproxNumber(job.requiredWork),
        completedTick: job.completedTick,
        completed: job.completedTick !== null,
      }));
    },
    { name: "codify" },
  );

  const homeBadges = computed<HomeBadges>(
    () => {
      const state: GameState = sources.state.value;
      let residentCount = 0;
      let impairedResidentCount = 0;
      let idleResidentCount = 0;
      let dispatchedResidentCount = 0;
      let facilityCount = 0;
      let activeResearchCount = 0;
      let completedResearchCount = 0;
      let pendingCodifyCount = 0;
      let completedCodifyCount = 0;

      for (const entity of state.entityStateById.values()) {
        switch (entity.kind) {
          case "resident":
            residentCount++;
            if (entity.recallImpairedUntilTick > state.tick) impairedResidentCount++;
            if (entity.assignedFacilityId === null && !entity.dispatched) idleResidentCount++;
            if (entity.dispatched) dispatchedResidentCount++;
            break;
          case "facility":
            facilityCount++;
            break;
          case "research":
            if (entity.completedTick === null) activeResearchCount++;
            else completedResearchCount++;
            break;
          case "codify":
            if (entity.completedTick === null) pendingCodifyCount++;
            else completedCodifyCount++;
            break;
          case "resource":
            break;
          default: {
            const unhandled: never = entity;
            throw new TypeError(`未知の entity 種別 ${JSON.stringify(unhandled)}`);
          }
        }
      }

      return {
        residentCount,
        impairedResidentCount,
        idleResidentCount,
        dispatchedResidentCount,
        facilityCount,
        activeResearchCount,
        completedResearchCount,
        pendingCodifyCount,
        completedCodifyCount,
      };
    },
    { equals: homeBadgesEqual, name: "homeBadges" },
  );

  const selectedCell = computed<CellViewModel | null>(
    () => {
      const cellIndex = sources.selectedCellIndex.value;
      if (cellIndex === null) return null;
      const node = cellView[cellIndex];
      if (node === undefined) {
        throw new RangeError(`選択セル ${String(cellIndex)} が格子の範囲を外れている`);
      }
      return node.value;
    },
    { name: "selectedCell" },
  );

  return {
    adjacencyMatrix,
    cellAdjacency,
    cellView,
    gridSummary,
    tick,
    resources,
    research,
    residents,
    codify,
    homeBadges,
    selectedCell,
  };
}
