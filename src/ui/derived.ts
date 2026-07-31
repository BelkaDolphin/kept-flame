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
//   UI 用に式を書き直さない。**[M17] 大型施設の判定基準セル集合も engine と同じ
//   footprint.ts の `adjacencyBasisCells` を呼ぶ**(GDD 6.3 が「`adjacency.json`
//   スキーマと UI プレビュー共通ロジック」と定めている部分)。よって UI 表示の
//   乗数と、生産式が使う
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
  type CellOccupant,
  type Tag,
} from "../engine/adjacency";
import {
  UNIT_FOOTPRINT,
  adjacencyBasisCells,
  footprintFitsGrid,
  isUnitFootprint,
  occupiedCells,
} from "../engine/footprint";
import { FIX_ONE, FIX_ZERO, toApproxNumber, toRaw, type Fix } from "../engine/fp";
import { isCodified } from "../engine/rules/codify";
import { techHoldersOf } from "../engine/rules/techMemory";
import {
  lossClassOfTech,
  requireFacilityDef,
  type EngineContent,
  type RecordMedium,
} from "../engine/rules/types";
import {
  entitiesOfKind,
  type CodifyState,
  type DispatchSnapshot,
  type EntityId,
  type GameState,
  type MemoirEntry,
  type RenderedLogEntry,
  type ResidentState,
} from "../engine/state/state";
import type { ScreenId } from "./screens";
import {
  computeAdjacencyBreakdown,
  type CellAdjacencyBreakdown,
} from "./screens/grid/adjacencyBreakdown";
import { computed, type ReadonlyComputed } from "./reactive";
import type { CellPlacement, ReadonlyStoreSources, StoreSources } from "./sources";

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

/**
 * [M17] その施設の判定基準セル集合(GDD 6.3)。**engine と同じ 1 実装**を呼ぶ
 * (§3 の規律。UI 用に「大型施設の近傍」を書き直さない)。
 *
 * 1×1 はモジュール読込時に作った {@link NEIGHBOR_CELLS} を返す近道を通る。
 * `adjacencyBasisCells([cell])` と**同じ集合**であり(順序だけ違い、順序は
 * `computeCellAdjacency` の中で辞書順へ再ソートされるので結果に残らない・
 * footprint.ts §3)、評価ごとの配列生成を避けるためだけの分岐である。
 */
function basisCellsOfPlacement(placement: CellPlacement): readonly number[] {
  if (isUnitFootprint(placement.footprint)) return neighborsOf(placement.anchorCellIndex);
  return adjacencyBasisCells(occupiedCells(placement.anchorCellIndex, placement.footprint));
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
  /**
   * [M17] 占有矩形のアンカーセル(空きセルは null)。大型施設(GDD 6.1)は
   * 全占有セルが同じ施設・同じ乗数を返すので、格子UI(M18)は
   * `anchorCellIndex === cellIndex` のセルにだけ枠/バッジ/数値を描き、
   * 残りの占有セルは連結表示に使う。
   */
  readonly anchorCellIndex: number | null;
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
    a.anchorCellIndex === b.anchorCellIndex &&
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
  /** 施設が占有しているセルの数。[M17] 大型施設は占有セル数ぶん数える。 */
  readonly occupiedCellCount: number;
  readonly emptyCellCount: number;
  /**
   * 過密ペナルティが実際に掛かっている**施設**の数。
   * [M17] 大型施設はアンカーセルでのみ数える(1 施設 1 回・GDD 6.3)。
   *
   * **[M29・2026-07-30裁定] `overcrowdedCellCount` から改名した。** 実態が
   * 「セルの数」ではなく「施設の数」であり(アンカーのみ集計)、同じ型の中で
   * `occupiedCellCount`(セル単位)と単位が違うことが名前から読めなかったため。
   * 改名の影響は本ファイルと `tests/ui/derived.test.ts` に閉じており、engine /
   * schema / content / conformance には 1 バイトも波及しない(この型は派生値で
   * あって state ではなく、直列化も golden vector も通らない)。詳細は
   * `docs/design/ui-spec.md` §6。
   */
  readonly overcrowdedFacilityCount: number;
  /** 無効化された近傍の総数(タグ横断)。[M17] 同じく施設単位の合計。 */
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

/**
 * [M29] 緊急度バッジ 1 件(GDD 2.2 / 4.1(a))。**点灯しているものだけ**が並ぶ。
 *
 * ここに文言(表示テキスト)は持たない。持たせると「同じ意味の日本語が
 * derived と画面の 2 箇所に出る」ことになるうえ、件数以外が変わらないのに
 * 文字列が新しくなって `equals` が効かなくなるためである。文言は
 * `src/ui/screens/home/HomeHub.tsx` の静的な表が持つ。
 */
export interface HomeAlert {
  readonly id: HomeAlertId;
  /** 赤/黄/灰(GDD 4.1(a))。 */
  readonly level: UrgencyLevel;
  /** バッジをタップしたときの遷移先(GDD 6.6「ワンタップ遷移」)。 */
  readonly screen: ScreenId;
  /** 点灯の根拠になった件数(1 以上。0 のバッジは並ばない)。 */
  readonly count: number;
}

/**
 * [M29] 緊急度の 3 段(GDD 4.1(a): 赤 = (B)喪失接近 / 黄 = 先延ばしコスト /
 * 灰 = 任意)。
 *
 * **赤は限定点灯**(GDD 2.2)。「危ない気がする」では点けず、(B) 分類の技術が
 * 実際に喪失へ近づいている状況だけに使う。
 */
export type UrgencyLevel = "critical" | "warn" | "info";

/** [M29] バッジの種類。表示順は宣言順(重い順)。 */
export const HOME_ALERT_IDS = [
  "bLossImminent",
  "recallImpaired",
  "codifyPending",
  "researchIdle",
  "expeditionActive",
  "idleResidents",
] as const;

export type HomeAlertId = (typeof HOME_ALERT_IDS)[number];

/** [M29] ①ホームハブのバッジ列(ADR-027(4) の「軽量 computed」)。 */
export interface HomeAlerts {
  /** 点灯中のバッジ(重い順 = {@link HOME_ALERT_IDS} の宣言順)。 */
  readonly alerts: readonly HomeAlert[];
  readonly criticalCount: number;
  readonly warnCount: number;
  readonly infoCount: number;
}

function homeAlertsEqual(a: HomeAlerts, b: HomeAlerts): boolean {
  if (a.alerts.length !== b.alerts.length) return false;
  for (let i = 0; i < a.alerts.length; i++) {
    const left = a.alerts[i];
    const right = b.alerts[i];
    if (left === undefined || right === undefined) return false;
    if (left.id !== right.id || left.count !== right.count || left.level !== right.level) {
      return false;
    }
  }
  return true;
}

/**
 * [M29] (B) 一回性喪失が「実際に近づいている」技術(GDD 2.2 の赤バッジ条件)。
 *
 * 条件は 4 つ全部の重なりであり、1 つでも欠ければ点かない:
 *   (1) `lossClass = rareIrreversible`(= (B)。(A) は再研究できるので赤にしない・GDD 7.4)
 *   (2) 解禁済み(未研究の技術は失いようがない)
 *   (3) 未成文(記録が 1 枚でもあれば喪失しない・rules/codify.ts)
 *   (4) 生存保持者が 1 人だけ で、その 1 人が **派遣中** または **士気が下位閾値未満**
 *       (GDD 2.2 の例示「唯一保持者を派遣中 × 士気危機の重なり等」そのもの)
 *
 * 判定に使う述語はすべて engine の既存実装(`isCodified` / `techHoldersOf` /
 * `lossClassOfTech`)であり、UI 側に喪失判定を書き写していない。
 * 士気の閾値も content(`recallRisk.moraleThresholdLowFix`)から引く。
 */
function bLossImminentTechIds(state: GameState, content: EngineContent): readonly EntityId[] {
  const moraleCrisisRaw = toRaw(content.recallRisk.moraleThresholdLowFix);
  const result: EntityId[] = [];
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick === null) continue;
    const techId = research.techId;
    // content に定義が無い tech(理論上は起きない)でホーム画面を落とさない。
    if (!content.techDefs.has(techId)) continue;
    if (lossClassOfTech(content, techId) !== "rareIrreversible") continue;
    if (isCodified(state, techId)) continue;

    const holders = techHoldersOf(state, techId);
    if (holders.length !== 1) continue;
    const holderId = holders[0];
    if (holderId === undefined) continue;
    const holder = state.entityStateById.get(holderId);
    if (holder === undefined || holder.kind !== "resident") continue;
    if (!holder.dispatched && toRaw(holder.morale) >= moraleCrisisRaw) continue;
    result.push(techId);
  }
  return result;
}

/** [M29] 未成文のまま残っている解禁済み技術(生存保持者あり)の件数。 */
function pendingCodifyTechCount(state: GameState, content: EngineContent): number {
  let count = 0;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick === null) continue;
    if (!content.techDefs.has(research.techId)) continue;
    if (isCodified(state, research.techId)) continue;
    if (techHoldersOf(state, research.techId).length === 0) continue;
    count++;
  }
  return count;
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
  /**
   * [M29] ①ホームハブの緊急度バッジ(GDD 2.2 / 4.1(a) / 6.6)。
   * `homeBadges` と同じく **tick を含めない**(§2)ので、件数が動かない限り
   * バッジ行は再描画されない。
   */
  readonly homeAlerts: ReadonlyComputed<HomeAlerts>;

  /** 選択中セルの表示モデル(未選択は null)。③施設詳細と②の選択枠が読む。 */
  readonly selectedCell: ReadonlyComputed<CellViewModel | null>;
  /**
   * [M19] 選択中セルの内訳(GDD 6.5 の内訳ビュー)。未選択/空きセルは null。
   * 依存は `selectedCell` と同じセル局所(自セル + 判定基準セル)なので
   * fan-in 上界は崩れない(§3(a)と同型)。
   */
  readonly selectedCellBreakdown: ReadonlyComputed<CellAdjacencyBreakdown | null>;
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
      anchorCellIndex: null,
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
    anchorCellIndex: placement.anchorCellIndex,
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

          // [M17] 大型施設は自セルの 8 近傍ではなく**占有矩形の外周**が基準
          // (GDD 6.3)。非アンカーセルからも同じ集合になるので、同じ施設の
          // どのセルを読んでも同じ結果が出る(= ボーナスは 1 施設 1 回)。
          const basisCells = basisCellsOfPlacement(self);
          const occupancy = new Map<number, CellOccupant>();
          for (const basisCell of basisCells) {
            const neighbor = sources.cellPlacement[basisCell]?.value ?? null;
            if (neighbor === null) continue;
            occupancy.set(basisCell, {
              anchorCellIndex: neighbor.anchorCellIndex,
              tags: neighbor.tags,
            });
          }
          return computeCellAdjacency(adjacencyMatrix.value, occupancy, {
            cellIndex: self.anchorCellIndex,
            defId: self.defId,
            tags: self.tags,
            basisCells,
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
      let overcrowdedFacilityCount = 0;
      let overcrowdedNeighborTotal = 0;
      for (let cellIndex = 0; cellIndex < GRID_CELL_COUNT; cellIndex++) {
        const node = cellAdjacency[cellIndex];
        const result = node === undefined ? null : node.value;
        if (result === null) continue;
        occupiedCellCount++;
        // [M17] 過密は**施設**の性質なので、大型施設が占有セル数ぶん重複計上
        // されないようアンカーセルでだけ数える(GDD 6.3「1 施設 1 回」)。
        // 占有セル数そのものは上の occupiedCellCount がセル単位で数える。
        const placement = sources.cellPlacement[cellIndex]?.value ?? null;
        if (placement !== null && placement.anchorCellIndex !== cellIndex) continue;
        if (result.overcrowdedNeighborCount > 0) {
          overcrowdedFacilityCount++;
          overcrowdedNeighborTotal += result.overcrowdedNeighborCount;
        }
      }
      return {
        occupiedCellCount,
        emptyCellCount: GRID_CELL_COUNT - occupiedCellCount,
        overcrowdedFacilityCount,
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

  const homeAlerts = computed<HomeAlerts>(
    () => {
      const state: GameState = sources.state.value;
      const content: EngineContent = sources.content.value;
      const badges = homeBadges.value;

      const counts: { readonly [K in HomeAlertId]: number } = {
        bLossImminent: bLossImminentTechIds(state, content).length,
        recallImpaired: badges.impairedResidentCount,
        codifyPending: pendingCodifyTechCount(state, content),
        researchIdle: badges.activeResearchCount === 0 ? 1 : 0,
        expeditionActive: state.dispatchSnapshots.length,
        idleResidents: badges.idleResidentCount,
      };
      const levels: { readonly [K in HomeAlertId]: UrgencyLevel } = {
        bLossImminent: "critical",
        recallImpaired: "warn",
        codifyPending: "warn",
        researchIdle: "warn",
        expeditionActive: "info",
        idleResidents: "info",
      };
      const screens: { readonly [K in HomeAlertId]: ScreenId } = {
        bLossImminent: "codify",
        recallImpaired: "residents",
        codifyPending: "codify",
        researchIdle: "research",
        expeditionActive: "expedition",
        idleResidents: "residents",
      };

      const alerts: HomeAlert[] = [];
      let criticalCount = 0;
      let warnCount = 0;
      let infoCount = 0;
      for (const id of HOME_ALERT_IDS) {
        const count = counts[id];
        if (count <= 0) continue;
        const level = levels[id];
        alerts.push({ id, level, screen: screens[id], count });
        if (level === "critical") criticalCount++;
        else if (level === "warn") warnCount++;
        else infoCount++;
      }
      return { alerts, criticalCount, warnCount, infoCount };
    },
    { equals: homeAlertsEqual, name: "homeAlerts" },
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

  // [M19] 選択セルの内訳(GDD 6.5)。cellAdjacency[i] と同じ基準セル収集を
  // もう一度なぞる必要がある(computeCellAdjacency は内訳を返さないため・
  // adjacencyBreakdown.ts 冒頭コメント参照)。依存はやはりセル局所のみ。
  const selectedCellBreakdown = computed<CellAdjacencyBreakdown | null>(
    () => {
      const cellIndex = sources.selectedCellIndex.value;
      if (cellIndex === null) return null;
      const placementSignal = sources.cellPlacement[cellIndex];
      if (placementSignal === undefined) {
        throw new RangeError(`選択セル ${String(cellIndex)} が格子の範囲を外れている`);
      }
      const placement = placementSignal.value;
      if (placement === null) return null;

      const basisCells = basisCellsOfPlacement(placement);
      const occupancy = new Map<number, CellOccupant>();
      for (const basisCell of basisCells) {
        const neighbor = sources.cellPlacement[basisCell]?.value ?? null;
        if (neighbor === null) continue;
        occupancy.set(basisCell, {
          anchorCellIndex: neighbor.anchorCellIndex,
          tags: neighbor.tags,
        });
      }
      return computeAdjacencyBreakdown(adjacencyMatrix.value, occupancy, {
        cellIndex: placement.anchorCellIndex,
        defId: placement.defId,
        tags: placement.tags,
        basisCells,
      });
    },
    { name: "selectedCellBreakdown" },
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
    homeAlerts,
    selectedCell,
    selectedCellBreakdown,
  };
}

// --- 5. 配置プレビュー(GDD 6.5 MVP必須・M19) --------------------------------
//
// pendingPlacement(施設カタログでの選択・M30 が画面から渡す)は store の
// signal ではなく画面コンポーネントの一時的な状態なので、他の派生値のように
// signal グラフの computed() にはしない(architecture.md §6 の規律は「signal
// グラフに新しい依存経路を書くな」であって、store から一回読みする純関数まで
// 禁じるものではない)。GridBoard.tsx は `useMemo` の中からこの関数を呼ぶ。
//
// 判定と同じ 1 実装を使う(GDD 6.3 の共通ロジック要件): 既存施設の occupancy は
// 変えず、候補アンカーセルへ**仮に**置いた場合の `computeCellAdjacency` を
// 呼ぶだけで「置いたらどうなるか」を計算できる(adjacency.ts §1 のコメント
// どおり・state を作らない)。

export interface PlacementPreviewCell {
  readonly cellIndex: number;
  /** footprint が盤内に収まり、かつ全占有セルが空いている。 */
  readonly fits: boolean;
  readonly multiplierApprox: number;
  readonly bonusFix: Fix;
  readonly overcrowdPenaltyFix: Fix;
  readonly overcrowdedNeighborCount: number;
}

const PREVIEW_UNFIT: Omit<PlacementPreviewCell, "cellIndex"> = {
  fits: false,
  multiplierApprox: 1,
  bonusFix: FIX_ZERO,
  overcrowdPenaltyFix: FIX_ZERO,
  overcrowdedNeighborCount: 0,
};

/**
 * 48 セル全部について「ここに `defId` を置いたら」の予測乗数を計算する。
 * 既存の占有(peek・非追跡)はそのままに、候補アンカーだけを仮定するので
 * 既存施設の乗数には一切触れない(= 二次効果の再計算はしない・最終報告の
 * ★ 注記参照)。
 *
 * @throws {RulesError} `defId` が content に無い場合
 */
export function computePlacementPreview(
  sources: ReadonlyStoreSources,
  content: EngineContent,
  worldSeedU32: number,
  defId: EntityId,
): readonly PlacementPreviewCell[] {
  const def = requireFacilityDef(content, defId);
  const footprint = def.footprint ?? UNIT_FOOTPRINT;
  const matrix = applySeedOffsets(content.adjacency, worldSeedU32);

  const occupancy = new Map<number, CellOccupant>();
  for (let i = 0; i < GRID_CELL_COUNT; i++) {
    const placement = sources.cellPlacement[i]?.peek() ?? null;
    if (placement === null) continue;
    occupancy.set(i, { anchorCellIndex: placement.anchorCellIndex, tags: placement.tags });
  }

  const results: PlacementPreviewCell[] = [];
  for (let anchor = 0; anchor < GRID_CELL_COUNT; anchor++) {
    if (!footprintFitsGrid(anchor, footprint)) {
      results.push({ cellIndex: anchor, ...PREVIEW_UNFIT });
      continue;
    }
    const cells = occupiedCells(anchor, footprint);
    const allEmpty = cells.every((c) => !occupancy.has(c));
    if (!allEmpty) {
      results.push({ cellIndex: anchor, ...PREVIEW_UNFIT });
      continue;
    }
    const basisCells = isUnitFootprint(footprint)
      ? neighborCellIndices(anchor)
      : adjacencyBasisCells(cells);
    const result = computeCellAdjacency(matrix, occupancy, {
      cellIndex: anchor,
      defId,
      tags: def.tags,
      basisCells,
    });
    results.push({
      cellIndex: anchor,
      fits: true,
      multiplierApprox: toApproxNumber(result.multiplierFix),
      bonusFix: result.bonusFix,
      overcrowdPenaltyFix: result.overcrowdPenaltyFix,
      overcrowdedNeighborCount: result.overcrowdedNeighborCount,
    });
  }
  return results;
}

// --- 6. ⑫帰還ダイジェスト(GDD 4.2「復帰専用画面」・M29) --------------------
//
// GDD 4.2 は「**ネガティブ先頭単独表示 → ダイジェスト → ドリルダウン**の3段」と
// 定める。本節はその 3 段ぶんの表示モデルを **engine の既存フィールドを読んで
// 並べ替えるだけ**で組み立てる純関数である(新しい engine 計算を足さない)。
//
// (a) **「不在中」の起点は engine の state に無い。** `lastSeenTick` のような
//     フィールドを GameState へ足すのは engine 変更(= golden vector と
//     saveSchemaVersion に波及)なので採らず、composition root が持つ
//     「catch-up 前の tick」を `sinceTick` として引数で受け取る。これは
//     セーブに載らない UI 状態である(docs/design/ui-spec.md §4)。
//
// (b) **未帰還の派遣スナップショットから結果を読まない。** `DispatchSnapshot` は
//     派遣確定時に脱落者まで含めて確定している(GDD 12.5-7)ので、そこから
//     「全滅」「脱落」を先に表示するとプレイヤーへの盛大なネタバレになる。
//     ダイジェストが読むのは **既に起きたこと**(住民の `life.diedTick`・
//     research の `loss`・memoir・レンダリング済み帰還ログ)だけであり、
//     未帰還の派遣については「何件が未帰還か」しか出さない。
//
// (c) 派生値(computed)にしていないのは、`sinceTick` が画面側の一時状態であり
//     signal グラフに入らないためである(§5 の `computePlacementPreview` と
//     同じ扱い・architecture.md §6 の規律どおり)。

/** ⑫の 1 段目(ネガティブ先頭単独表示)の種別。重い順。 */
export const DIGEST_LEAD_KINDS = [
  "rareTechLost",
  "residentDeath",
  "recoverableTechLost",
  "partnerLost",
  "none",
] as const;

export type DigestLeadKind = (typeof DIGEST_LEAD_KINDS)[number];

/** ⑫の 1 段目。`kind: "none"` なら「悪い知らせは無い」を単独表示する。 */
export interface DigestLead {
  readonly kind: DigestLeadKind;
  /** ドリルダウン先(`none` のときはホームハブ)。 */
  readonly screen: ScreenId;
  /** 同種の出来事の件数(1 以上。`none` は 0)。 */
  readonly count: number;
  /** 代表の対象 ID(技術 / 住民)。`none` は null。 */
  readonly subjectId: EntityId | null;
  /** 代表の発生 tick。`none` は null。 */
  readonly tick: number | null;
}

/** ⑫の 2 段目に並べる要約行の種別(表示順は宣言順)。 */
export const DIGEST_ROW_IDS = [
  "residentDeaths",
  "techLosses",
  "returnLogs",
  "rescues",
  "arrivals",
  "bondMilestones",
  "expeditionsInFlight",
  "overcrowdedFacilities",
] as const;

export type DigestRowId = (typeof DIGEST_ROW_IDS)[number];

/** ⑫の 2 段目 1 行 = 3 段目(ドリルダウン)の遷移元。文言は画面側が持つ。 */
export interface DigestRow {
  readonly id: DigestRowId;
  readonly screen: ScreenId;
  /** 件数(1 以上。0 の行は並ばない)。 */
  readonly count: number;
  /** 悪い知らせか(意匠を分けるため。色だけに頼らずラベルも変える)。 */
  readonly negative: boolean;
}

/** ⑫の表示モデル。 */
export interface ReturnDigestView {
  /** 「不在中」の起点(排他: この tick は含まない)。 */
  readonly sinceTick: number;
  readonly nowTick: number;
  /** `nowTick - sinceTick`(= 不在中に進んだ tick 数 = 分)。 */
  readonly elapsedTicks: number;
  readonly lead: DigestLead;
  readonly rows: readonly DigestRow[];
  /** 不在中の帰還ログ(**新しい順**)。GDD 8.4 のレンダリング済み文字列。 */
  readonly logEntries: readonly RenderedLogEntry[];
  /** 上限 50 件を超えて畳まれた帰還ログの累計(GDD 8.4 / 12.5-9)。 */
  readonly foldedLogCount: number;
  /** 1 件でも報告することがあるか(false なら「変わりありません」)。 */
  readonly hasNews: boolean;
}

export interface ReturnDigestInput {
  /** 「不在中」の起点。通常は起動直後(catch-up 前)の `state.tick`。 */
  readonly sinceTick: number;
  /**
   * 盤面の集計(`store.derived.gridSummary`)。⑫は `gridSummary` を読んでよい
   * 数少ない画面である(§1(b) の用途制限どおり)。
   */
  readonly gridSummary: GridSummary;
}

interface DigestLeadCandidate {
  readonly kind: DigestLeadKind;
  readonly screen: ScreenId;
  readonly subjectId: EntityId;
  readonly tick: number;
}

/** 代表 1 件の選び方: 種別の重さ → 発生 tick 昇順 → 対象 ID 昇順(全順序)。 */
function pickLeadCandidate(candidates: readonly DigestLeadCandidate[]): DigestLeadCandidate | null {
  let best: DigestLeadCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const bestRank = DIGEST_LEAD_KINDS.indexOf(best.kind);
    const rank = DIGEST_LEAD_KINDS.indexOf(candidate.kind);
    if (rank !== bestRank) {
      if (rank < bestRank) best = candidate;
      continue;
    }
    if (candidate.tick !== best.tick) {
      if (candidate.tick < best.tick) best = candidate;
      continue;
    }
    if (candidate.subjectId < best.subjectId) best = candidate;
  }
  return best;
}

/** 住民 1 人の memoir を「不在中」で絞って数える。 */
function countMemoirSince(
  resident: ResidentState,
  sinceTick: number,
  kinds: ReadonlySet<MemoirEntry["kind"]>,
): number {
  const memoir = resident.memoir;
  if (memoir === undefined) return 0;
  let count = 0;
  for (const entry of memoir.entries) {
    if (entry.tick <= sinceTick) continue;
    if (kinds.has(entry.kind)) count++;
  }
  return count;
}

const ARRIVAL_KINDS: ReadonlySet<MemoirEntry["kind"]> = new Set(["arrival"]);
const RESCUE_KINDS: ReadonlySet<MemoirEntry["kind"]> = new Set(["explorationRescue"]);
const BOND_KINDS: ReadonlySet<MemoirEntry["kind"]> = new Set(["bondMilestone"]);

/**
 * ⑫帰還ダイジェストの表示モデルを組み立てる(GDD 4.2)。
 *
 * **state を 1 バイトも変えない純関数**であり、engine の計算も 1 つも呼ばない
 * (既存フィールドの読み出しと並べ替えだけ)。
 *
 * @throws {RangeError} `sinceTick` が整数でない / 現在 tick より未来の場合
 */
export function buildReturnDigest(state: GameState, input: ReturnDigestInput): ReturnDigestView {
  const sinceTick = input.sinceTick;
  if (!Number.isSafeInteger(sinceTick) || sinceTick < 0) {
    throw new RangeError(`sinceTick ${String(sinceTick)} が 0 以上の整数でない`);
  }
  if (sinceTick > state.tick) {
    throw new RangeError(
      `sinceTick ${String(sinceTick)} が現在 tick ${String(state.tick)} より未来(起点の取り違え)`,
    );
  }

  const leadCandidates: DigestLeadCandidate[] = [];
  let deathCount = 0;
  let rareLossCount = 0;
  let recoverableLossCount = 0;
  let arrivalCount = 0;
  let rescueCount = 0;
  let bondMilestoneCount = 0;
  let partnerLostCount = 0;

  for (const entity of state.entityStateById.values()) {
    if (entity.kind === "resident") {
      const diedTick = entity.life?.diedTick ?? null;
      if (diedTick !== null && diedTick > sinceTick) {
        deathCount++;
        leadCandidates.push({
          kind: "residentDeath",
          screen: "residents",
          subjectId: entity.id,
          tick: diedTick,
        });
      }
      arrivalCount += countMemoirSince(entity, sinceTick, ARRIVAL_KINDS);
      rescueCount += countMemoirSince(entity, sinceTick, RESCUE_KINDS);
      bondMilestoneCount += countMemoirSince(entity, sinceTick, BOND_KINDS);
      for (const memoirEntry of entity.memoir?.entries ?? []) {
        if (memoirEntry.kind !== "partnerLost" || memoirEntry.tick <= sinceTick) continue;
        partnerLostCount++;
        leadCandidates.push({
          kind: "partnerLost",
          screen: "chronicle",
          subjectId: entity.id,
          tick: memoirEntry.tick,
        });
      }
      continue;
    }
    if (entity.kind !== "research") continue;
    const loss = entity.loss;
    if (loss === undefined || loss.tick <= sinceTick) continue;
    if (loss.irreversible) rareLossCount++;
    else recoverableLossCount++;
    leadCandidates.push({
      // (B) は取り返しがつかない = 最優先。(A) は再研究できるので停滞コスト扱い(GDD 7.4)。
      kind: loss.irreversible ? "rareTechLost" : "recoverableTechLost",
      screen: "research",
      subjectId: entity.techId,
      tick: loss.tick,
    });
  }

  const picked = pickLeadCandidate(leadCandidates);
  const leadCountByKind: { readonly [K in DigestLeadKind]: number } = {
    rareTechLost: rareLossCount,
    residentDeath: deathCount,
    recoverableTechLost: recoverableLossCount,
    partnerLost: partnerLostCount,
    none: 0,
  };
  const lead: DigestLead =
    picked === null
      ? { kind: "none", screen: "home", count: 0, subjectId: null, tick: null }
      : {
          kind: picked.kind,
          screen: picked.screen,
          count: leadCountByKind[picked.kind],
          subjectId: picked.subjectId,
          tick: picked.tick,
        };

  // 帰還ログは古い順に積まれている(state.ts の RenderedLogState)ので、
  // 不在中のぶんだけ取り出して新しい順へ反転する。
  const logEntries: RenderedLogEntry[] = [];
  for (let i = state.renderedLogs.entries.length - 1; i >= 0; i--) {
    const entry = state.renderedLogs.entries[i];
    if (entry === undefined) continue;
    if (entry.tick <= sinceTick) break;
    logEntries.push(entry);
  }

  const inFlight: readonly DispatchSnapshot[] = state.dispatchSnapshots;
  const counts: { readonly [K in DigestRowId]: number } = {
    residentDeaths: deathCount,
    techLosses: rareLossCount + recoverableLossCount,
    returnLogs: logEntries.length,
    rescues: rescueCount,
    arrivals: arrivalCount,
    bondMilestones: bondMilestoneCount,
    expeditionsInFlight: inFlight.length,
    overcrowdedFacilities: input.gridSummary.overcrowdedFacilityCount,
  };
  const screens: { readonly [K in DigestRowId]: ScreenId } = {
    residentDeaths: "residents",
    techLosses: "research",
    returnLogs: "chronicle",
    rescues: "residents",
    arrivals: "residents",
    bondMilestones: "chronicle",
    expeditionsInFlight: "expedition",
    overcrowdedFacilities: "grid",
  };
  const negatives: { readonly [K in DigestRowId]: boolean } = {
    residentDeaths: true,
    techLosses: true,
    returnLogs: false,
    rescues: false,
    arrivals: false,
    bondMilestones: false,
    expeditionsInFlight: false,
    overcrowdedFacilities: true,
  };

  const rows: DigestRow[] = [];
  for (const id of DIGEST_ROW_IDS) {
    const count = counts[id];
    if (count <= 0) continue;
    rows.push({ id, screen: screens[id], count, negative: negatives[id] });
  }

  return {
    sinceTick,
    nowTick: state.tick,
    elapsedTicks: state.tick - sinceTick,
    lead,
    rows,
    logEntries,
    foldedLogCount: state.renderedLogs.foldedCount,
    hasNews: rows.length > 0 || lead.kind !== "none",
  };
}
