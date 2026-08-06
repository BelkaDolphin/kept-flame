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
import { FIX_ONE, FIX_ZERO, mulFix, toApproxNumber, toRaw, type Fix } from "../engine/fp";
import { compareUtf16 } from "../engine/canonicalize";
import {
  CODIFY_NO_DEADLINE_TICKS,
  codifyResidualTick,
  suggestCodification,
} from "../engine/assist/codify";
import { explorationTeamCandidates } from "../engine/assist/exploration";
import {
  isCodified,
  isPrintingUnlocked,
  planCodification,
  recordMediaOfTech,
} from "../engine/rules/codify";
import { residentCombatPower } from "../engine/rules/combat";
import {
  explorationRoi,
  type ExplorationRoiOptions,
  type ExplorationRoiReport,
} from "../engine/rules/exploration";
import { outpostNetworkRoi } from "../engine/rules/outpost";
import { populationViewOf, type PopulationView } from "../engine/rules/population";
import {
  activeLaborFix,
  facilityOutputPerTick,
  isWorkerActiveAtFacility,
} from "../engine/rules/production";
import { reclaimCostFix } from "../engine/rules/reclaim";
import { recallRiskPerDay } from "../engine/rules/recall";
import { colonyDefenseFix, hasDefense, nextRaidTick, raidStrengthFix } from "../engine/rules/raid";
import { resolveCapacityByResourceId } from "../engine/rules/storage";
import {
  currentResearch,
  fieldBlockedResearches,
  fieldRequirementTicks,
  isFieldRequirementMet,
} from "../engine/rules/research";
import { NEUTRAL_RESIDENT_STATS, effectiveStats, resolveTraitDefs } from "../engine/rules/stats";
import { erasInOrder, techsOfEra } from "../engine/rules/techTree";
import {
  isTechImpaired,
  isTechUnlocked,
  memoryTechIdsOf,
  techHoldersOf,
  techImpairmentStopsFacility,
  techMemoryOf,
} from "../engine/rules/techMemory";
import {
  lossClassOfTech,
  prereqsOfTech,
  requireFacilityDef,
  type DistanceBand,
  type EngineContent,
  type FacilityDef,
  type RecordMedium,
  type TechLossClass,
} from "../engine/rules/types";
import {
  allOutposts,
  entitiesOfKind,
  getFieldRunTicks,
  isAliveResident,
  livingResidents,
  type CodifyState,
  type DispatchSnapshot,
  type DispatchStance,
  type EntityId,
  type FacilityFootprint,
  type GameState,
  type MemoirEntry,
  type RenderedLogEntry,
  type RenderedLogState,
  type ResearchState,
  type ResidentState,
} from "../engine/state/state";
import type { ScreenId } from "./screens";
import {
  computeAdjacencyBreakdown,
  type CellAdjacencyBreakdown,
} from "./screens/grid/adjacencyBreakdown";
import { computed, type ReadonlyComputed } from "./reactive";
import type { CellPlacement, RaidTally, ReadonlyStoreSources, StoreSources } from "./sources";

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
  /**
   * [M30] 未開墾の瓦礫か(GDD 9.1)。`occupied` とは独立の性質(瓦礫セルには
   * 施設を置けないので通常は両立しないが、値としては別々に持つ)。
   * `sources.cellRubble[cellIndex]` をそのまま写す(§0 の自セル限定 fan-in)。
   */
  readonly isRubble: boolean;
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
    a.overcrowdedNeighborCount === b.overcrowdedNeighborCount &&
    a.isRubble === b.isRubble
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
  /**
   * [M63/R4-A04・GDD 6.7] この資源の現在の保管上限(基礎400+建っている保管庫
   * のLv合計×400・engine 唯一の正本実装 `resolveCapacityByResourceId` をその
   * まま呼ぶ)。上限を持たない資源(倉庫が無い盤面・content に storage ブロック
   * が無い等)は null——**null は「上限に達していない」ではなく「上限という
   * 概念が無い」を表す**(呼び出し側は null を false 扱いしないこと)。
   */
  readonly capacityApprox: number | null;
  /**
   * [M63/R4-A04] 在庫が現在の保管上限に達している(以上)か。上限が無ければ
   * 常に false。
   *
   * **既知の非対称(拠点供給は上限を無視する・R4-A04/構造発見)**: 施設産出は
   * 上限で頭打ちになるが、衛星拠点からの供給は上限判定を通らないため、在庫が
   * 上限を大幅に超えたまま増え続ける資源がありうる(例: 穀物が上限を無視して
   * 76,980 まで増加)。その場合でも `stockApprox >= capacityApprox` は
   * 数値としては真であり、この値は「上限相当に達しているという実態」を偽らず
   * そのまま表す(超過の原因が施設産出か拠点供給かは区別しない)。engine 側の
   * 判定(拠点供給にも上限を効かせるか)は M40(台帳v16 必-2)の担当であり、
   * この表示はどちらの結論でも壊れない。
   */
  readonly atCapacity: boolean;
}

export interface ResearchView {
  readonly entityId: EntityId;
  readonly techId: EntityId;
  readonly progressFix: Fix;
  readonly progressApprox: number;
  readonly completedTick: number | null;
  readonly completed: boolean;
}

/**
 * [2026-08-02裁定・台帳v10 必-1] ヘッダ研究チップ(§7 手前参照)が表示する最小限の
 * 値。「いま研究点が実際に流れ込んでいる対象」= `currentResearch(state)`
 * (`engine/rules/research.ts` §2。選択が有効ならそれ/無ければ ID 昇順先頭)
 * であり、`researchTree` 全 24 行を組み立てずに済む軽量版。
 */
export interface ResearchChipView {
  readonly techId: EntityId;
  /** floor 済みの整数(0〜100)。研究コストが 0 以下の tech は 100 固定。 */
  readonly progressPercent: number;
  /**
   * [2026-08-02差し戻し・台帳v10 必-1] **台帳の眼目そのもの**: 対象 tech は
   * 選ばれている(`completedTick === null` かつ (B) 未喪失)のに、研究点レートが
   * 実質 0(= 研究点産出施設に「稼働」就労者が誰もいない。作業台から人を外した
   * 等)で進捗が凍っている状態。`hasActiveResearchProduction` 参照。
   */
  readonly stalled: boolean;
  /**
   * [M73/R8-04 fatal] 研究点は満了しているのに実地要件(M67)が未達で完了できない
   * 状態。**この旗が立っているときの `progressPercent` は 100 でも完了しない**
   * ——「🔬 100%」のまま何時間も動かない見え方(Round 8 実測)を、チップ自身が
   * 「実地要件待ち」と言うことで解く。
   *
   * 立つのは「実地要件待ちの研究しか残っていない」場合だけである(それ以外は
   * `currentResearch` が点の行き先を次の研究へ回すので、チップは進んでいる方を
   * 指す)。省略時(既存テストフィクスチャ互換)は false 扱い。
   */
  readonly awaitingFieldRequirement?: boolean;
}

/**
 * [2026-08-02差し戻し・台帳v10 必-1] 研究点レートが実際に正か
 * (= 研究点産出施設(`output.kind === "research"`)が 1 つでも「稼働」しているか)。
 *
 * 台帳v10 必-1 の眼目は「作業台から人を外して研究が止まっていても気づけない」
 * ことへの対応であり、`currentResearch` の**選択の有無**(state が対象を持つか)
 * だけでは検出できない——選択は生きたまま、稼働就労者が 0 人になって研究点
 * レートだけが 0 に落ちるケースが本命である。
 *
 * `computeProductionRates`(rules/production.ts)を丸ごと呼ぶと保管上限解決・
 * mastery 蓄積まで走る重い処理になるので、ここでは同モジュールが公開する
 * 2 つの純関数(`facilityOutputPerTick`/`activeLaborFix`)だけを使い、
 * 「研究点産出施設のうち基礎産出と稼働労働の両方が正のものが 1 つでもあるか」
 * だけを見る軽量判定にする。
 *
 * **隣接乗数を掛けずに済む根拠**: 隣接ボーナス/過密ペナルティはタグ横断で
 * ±60%にクランプされる(GDD 6.3・adjacency.ts の `ADJACENCY_CLAMP_*`)ため、
 * 乗数は常に正である。よって `base>0 && labor>0` ⟺
 * `rate = base×multiplier×labor > 0`(正の乗数を掛けても符号は保存される)。
 * 乗数を実際に読まずに済むので、ヘッダの軽量チップ 1 個のために隣接行列
 * computed への依存を増やさずに済む。
 *
 * **精度の限界(既知・意図的な妥協)**: `activeLaborFix` は住民単位の想起困難
 * 停止(`isWorkerActiveAtFacility`)までは見るが、`buildImpairmentIndex`(区間
 * ごと 1 パスの索引)は渡さない——引数省略時はその場で都度判定する低頻度経路
 * になる(production.ts の doc 参照)。③施設詳細(`buildFacilityDetail` 系)が
 * 同じ精度(索引省略)で妥協しているのに揃えたもので、ヘッダのチップ 1 個の
 * ために (住民,tech) 別索引を毎 tick 再構築するコストは払わない。
 */
function hasActiveResearchProduction(state: GameState, content: EngineContent): boolean {
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "research") continue;
    if (toRaw(facilityOutputPerTick(def, facility.level)) <= 0) continue;
    if (toRaw(activeLaborFix(state, content, facility, def, state.tick)) > 0) return true;
  }
  return false;
}

/**
 * [M70/R5-A02] ⑤研究画面が「研究点の産出が想起困難で止まっている」ことを
 * 明示するための 1 件(住民 × 研究点産出施設)。
 *
 * `hasActiveResearchProduction` は「止まっているか(bool)」までしか返さない
 * (§ 直前の doc「ヘッダのチップ 1 個のために索引を作らない」)。5 番目の画面
 * (研究ツリー)は常時マウントされないぶん重くしてよいので、ここでは
 * 「誰の・どのtechが」まで踏み込む——中核フック「知識は人の記憶に宿る」の
 * 失敗が見えない、という R5-A02 の眼目そのものへの回答。
 *
 * 死亡/派遣中/住民単位スカラでの全停止は**対象外**(それらは他のバッジで
 * 既に見えている・②③④の規律と同じ「二重に説明しない」)。ここが拾うのは
 * 「一見 就労可能に見えるのに (住民,tech) 別想起困難だけで生産が止まっている」
 * 本式(M13)特有の見えない失敗だけである。
 */
export interface ResearchStallNote {
  readonly residentId: EntityId;
  readonly facilityDefId: EntityId;
  /** この施設の寄与を止めている tech(techId昇順)。 */
  readonly techIds: readonly EntityId[];
}

function buildResearchStallNotes(
  state: GameState,
  content: EngineContent,
): readonly ResearchStallNote[] {
  if (state.techMemoryByKey.size === 0) return [];
  const notes: ResearchStallNote[] = [];
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "research") continue;
    for (const workerId of facility.workerIds) {
      const resident = state.entityStateById.get(workerId);
      if (resident === undefined || resident.kind !== "resident") continue;
      if (!isAliveResident(resident) || resident.dispatched) continue;
      if (state.tick < resident.recallImpairedUntilTick) continue;
      const impairments = residentTechImpairments(state, workerId, state.tick);
      if (impairments.length === 0) continue;
      const techIds = impairedTechIdsAtFacility(impairments, content, def.id);
      if (techIds.length === 0) continue;
      notes.push({ residentId: workerId, facilityDefId: def.id, techIds });
    }
  }
  // 施設 ID 反復順(entitiesOfKind=ID昇順)× workerIds(ID昇順)で組んでいるが、
  // 明示ソートで全順序を固定する(§3 の規律どおり反復順に頼らない)。
  notes.sort(
    (a, b) =>
      compareUtf16(a.residentId, b.residentId) || compareUtf16(a.facilityDefId, b.facilityDefId),
  );
  return notes;
}

/**
 * [M30] ステータス 5 種(裁定 B8 / GDD 7.1)の表示値。trait 適用後
 * (`effectiveStats`)を近似値へ落としたもの——生産式が実際に読む値と同じ
 * (rules/production.ts の `residentContribution` と同一の合成経路)。
 */
export interface ResidentStatsView {
  readonly vigorApprox: number;
  readonly dexterityApprox: number;
  readonly intellectApprox: number;
  readonly fortitudeApprox: number;
  readonly willApprox: number;
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
  /** [M30] ステータス 5 種(trait 適用後)。GDD 7.1。 */
  readonly stats: ResidentStatsView;
  /** [M30] 生存しているか(GDD 7.5 の tombstone)。`isAliveResident` をそのまま写す。 */
  readonly alive: boolean;
  /** [M30] 死亡した tick(生存中は null)。 */
  readonly diedTick: number | null;
  /**
   * [M70/R5-A02] 現在アクティブな (住民,tech) 別想起困難(techId昇順)。
   * `recallImpaired`(住民単位スカラ)と独立——M13 以降の実プレイの抽選は
   * こちらにしか書かない(rules/recall.ts §3)ので、④住民一覧はここを見ないと
   * 「就労1/1なのに産出0/分が延々続く」の理由が一切見えない(R5-A02 の眼目)。
   * 省略時(既存テストフィクスチャ互換)は空扱い(`?? []`)。
   */
  readonly techImpairments?: readonly TechImpairmentView[];
  /**
   * [M70/R5-A07] 衛星拠点に常駐中ならその拠点 ID(GDD 9.2)。常駐でなければ
   * null。省略時(既存テストフィクスチャ互換)は null 扱い(`?? null`)。
   */
  readonly stationedOutpostId?: EntityId | null;
}

/**
 * [M30] 住民 1 人ぶんのステータス 5 種を表示用に組み立てる。
 *
 * **生産式(rules/production.ts の `residentContribution`)と同じ合成経路**
 * (`resolveTraitDefs` → `effectiveStats`)を呼ぶだけで、表示用に式を書き直さ
 * ない(architecture.md §6 の「単一正準実装」の規律を住民ステータスへも適用)。
 * ステータス未設定の住民は {@link NEUTRAL_RESIDENT_STATS}(基準 50)が既定値
 * になる(rules/stats.ts §1 と同じ中立既定値)。
 */
function residentStatsView(resident: ResidentState, content: EngineContent): ResidentStatsView {
  const traits = resolveTraitDefs(resident.traitIds, content.traitDefs);
  const effective = effectiveStats(resident.stats ?? NEUTRAL_RESIDENT_STATS, traits);
  return {
    vigorApprox: toApproxNumber(effective.vigor),
    dexterityApprox: toApproxNumber(effective.dexterity),
    intellectApprox: toApproxNumber(effective.intellect),
    fortitudeApprox: toApproxNumber(effective.fortitude),
    willApprox: toApproxNumber(effective.will),
  };
}

/**
 * [M70/R5-A02] (住民,tech) 別の想起困難 1 件(techId 昇順)。
 *
 * `derived.ts:326`(旧・ヘッダチップの doc)が「既知・意図的な妥協」と明記して
 * いた精度の限界(索引省略の低頻度経路)をそのまま使う——住民は高々数十人
 * (GDD 7.7)なので、③④⑤の表示専用にここで毎回全 tech を舐めても O(住民×tech)
 * で軽い(homeBadges と同じ立場・§3-2 冒頭 doc)。
 */
export interface TechImpairmentView {
  readonly techId: EntityId;
  /** 回復する tick(GDD 11.2)。「対象techが分かる」表示の材料。 */
  readonly untilTick: number;
}

/**
 * その住民が**現在**想起困難中の (tech別) 一覧(techId昇順)。
 * `state.techMemoryByKey` が空(既存セーブ・conformance シナリオ)なら
 * `memoryTechIdsOf` が空配列を返すので O(1) で空になる。
 */
function residentTechImpairments(
  state: GameState,
  residentId: EntityId,
  tick: number,
): readonly TechImpairmentView[] {
  const result: TechImpairmentView[] = [];
  for (const techId of memoryTechIdsOf(state, residentId)) {
    if (!isTechImpaired(state, residentId, techId, tick)) continue;
    const memory = techMemoryOf(state, residentId, techId);
    // isTechImpaired が true を返した以上 memory は必ず存在する(techMemory.ts
    // §1 の doc どおり)。防御的に undefined をスキップするだけで捏造はしない。
    if (memory === undefined) continue;
    result.push({ techId, untilTick: memory.impairedUntilTick });
  }
  return result;
}

/**
 * `residentTechImpairments` の結果のうち、この施設定義での寄与を実際に
 * 止めている tech だけ(`techImpairmentStopsFacility`・rules/techMemory.ts §1
 * の本式規則をそのまま呼ぶ・techId 昇順は入力の順序を保つ)。
 */
function impairedTechIdsAtFacility(
  impairments: readonly TechImpairmentView[],
  content: EngineContent,
  facilityDefId: EntityId,
): readonly EntityId[] {
  const result: EntityId[] = [];
  for (const impairment of impairments) {
    const tech = content.techDefs.get(impairment.techId);
    if (tech === undefined || techImpairmentStopsFacility(tech, facilityDefId)) {
      result.push(impairment.techId);
    }
  }
  return result;
}

/**
 * [M70/R5-A07] 衛星拠点に常駐中の住民 → その拠点 ID(GDD 9.2)。
 * `allOutposts(state)` を 1 パスするだけで、拠点数・常駐数とも高々数十
 * (OUTPOST_RESIDENTS_MAX=4・GDD 9.2)なので軽い。
 */
function stationedOutpostIdByResident(state: GameState): ReadonlyMap<EntityId, EntityId> {
  const result = new Map<EntityId, EntityId>();
  for (const outpost of allOutposts(state)) {
    for (const residentId of outpost.residentIds) {
      result.set(residentId, outpost.id);
    }
  }
  return result;
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
  // [M73/R8-04 fatal] 研究点は満了したのに実地要件(M67)が未達で完了できない
  // 研究がある。「🔬 100% のまま何時間も動かない」の唯一の手がかりが無かった
  // (Round 8 実測)ため、ホームの「いま手を入れるところ」へ導線を出す。
  "researchFieldBlocked",
  // [M73/R8-05] 襲撃機構は動いているのに盤面の防衛戦力が 0(見張り台が無い/
  // 外周に無い)。襲撃は無音で蓄えを削るので、備えが無いことだけは先に伝える
  // (灰=任意。実際に撃退できるかは乱数を含むので断定しない)。
  "raidUndefended",
  // [M63/R4-A04・GDD 6.7] 保管上限に達している資源がある(産出が頭打ち/廃材化
  // している)ことの黄警告。既存4件と同じ「点灯しているものだけ並ぶ」規律。
  "storageAtCapacity",
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

/**
 * [M63/R4-A04・GDD 6.7] 在庫が現在の保管上限に達している(以上)資源の件数。
 *
 * `resources` computed と同じ `resolveCapacityByResourceId`(engine 唯一の
 * 正本実装)を呼ぶだけで、上限式そのものは書き写さない。**上限が無い資源
 * (倉庫が無い/content に storage ブロックが無い)は対象外**——「上限という
 * 概念自体が無い」ことと「上限に達していない」ことを混同しない。
 *
 * 拠点供給が上限を無視して増え続ける既知の非対称(構造発見・R4-A04)がある
 * 資源も、数値としては `stock >= capacity` を満たせばここに数える——原因の
 * 切り分け(施設産出の頭打ちか拠点供給の非対称か)はしない「実態表示」に
 * 徹する方針(facilityEffect.ts §2 末尾の追記と同じ立場)。
 */
function storageAtCapacityResourceCount(state: GameState, content: EngineContent): number {
  const capacities = resolveCapacityByResourceId(state, content);
  if (capacities.size === 0) return 0;
  let count = 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    const capacityFix = capacities.get(resource.resourceId);
    if (capacityFix === undefined) continue;
    if (toRaw(resource.stock) >= toRaw(capacityFix)) count++;
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

// --- 3-2. 施設カタログ/一覧/詳細/開墾(M30・GDD 6.1/6.5/7.7/9.1) -------------
//
// ③施設詳細・④住民配置・②の瓦礫開墾導線が読む値。施設数は高々数十・住民数は
// 8〜20 人(GDD 7.7)という規模感なので、§3 の値の派生と同じく state/content へ
// 直依存してよい(セル局所の fan-in 上界は §1 の cellView/cellAdjacency だけが
// 守るべき契約であり、ここは対象外)。

/**
 * [M30] 施設の最大 Lv / Lv 別就労スロット数。
 *
 * **`src/engine/commands.ts` の `facilityMaxLevel`/`facilityWorkerSlots` と
 * 同じ計算の意図的な複製**である。`commands.ts` は UI からの import を
 * `store.ts` 1 箇所に制限する検収済みの単一入口(architecture.md §4-1・
 * `tests/engine/commands.test.ts` 「検分: 判定は engine にあり UI に無い」)
 * であり、`src/ui/**` の他ファイルから import すると検収が壊れる。
 *
 * ここで要るのは「置けるか/払えるか」の**判定**ではなく、Lv 別配列の**構造**
 * (最短の配列長・省略時のフォールバック)から決まる表示専用の値であり、
 * commands.ts 側の判定ロジックとは独立に変わりようがない(配列の形が
 * 双方の唯一の入力)。M19★5 の adjacencyBreakdown.ts と同じ立場で軽い重複を
 * 許容し、engine 側にネイティブ公開する形への一本化は将来のタスクへ送る
 * (最終報告の★参照)。
 */
function displayFacilityMaxLevel(def: FacilityDef): number {
  let max = def.outputPerTickByLevel.length;
  if (def.storage !== undefined && def.storage.capacityByLevel.length < max) {
    max = def.storage.capacityByLevel.length;
  }
  if (def.bedCapacityByLevel !== undefined && def.bedCapacityByLevel.length < max) {
    max = def.bedCapacityByLevel.length;
  }
  if (def.workerSlotsByLevel !== undefined && def.workerSlotsByLevel.length < max) {
    max = def.workerSlotsByLevel.length;
  }
  return max;
}

/** `undefined` = 上限なし(commands.ts の `facilityWorkerSlots` と同じ意味)。 */
function displayFacilityWorkerSlots(def: FacilityDef, level: number): number | undefined {
  const slots = def.workerSlotsByLevel;
  if (slots === undefined) return undefined;
  if (slots.length === 0) return 0;
  return slots[level - 1] ?? slots[slots.length - 1];
}

/**
 * [M73/R8-03 fatal] コスト行 1 本の表示値(engine の
 * `commands.ts` の `ResolvedCostLine` と同型・第1行が主資源)。
 *
 * **なぜ derived 側に持つのか**: M65 で施設コストが複数資源になったのに、UI は
 * 第1行(主資源)しか持っていなかったため、②カタログ・③増築カード・成功トースト
 * のすべてが「表示どおりの資源では払えないコスト」を出していた(Round 8 実測
 * 4 件・写字室は表示 薪14 に対し実消費 薪14+粘土6)。
 *
 * 値の作り方は `commands.ts` の `facilityBuildCostLines`/`facilityUpgradeCostLines`
 * と**同じ**だが、§3-2 冒頭 doc のとおり `src/ui/**` は `engine/commands.ts` を
 * import できない(単一入口 = `store.ts` のみ・`tests/engine/commands.test.ts`
 * の検分が固定している)。ここで要るのは「払えるか」の**判定**ではなく
 * `def.cost` の**構造**(行の並び・Lv 別配列のフォールバック)から決まる表示専用の
 * 値であり、`displayFacilityMaxLevel`/`buildCostApprox` と同じ立場の意図的な複製
 * である(在庫と突き合わせる「▲」も色分けのための表示であり、拒否の権威は
 * engine の `insufficientResource` にある)。
 */
export interface CostLineView {
  readonly resourceId: EntityId;
  readonly amountApprox: number;
}

/** コスト定義を持たない(無料の)施設のための共有の空配列。 */
const NO_COST_LINES: readonly CostLineView[] = [];

/** [M73/R8-03] Lv1 建設の全コスト行(第1行が主資源・`def.cost` 省略なら空=無料)。 */
function displayFacilityBuildCostLines(def: FacilityDef): readonly CostLineView[] {
  const cost = def.cost;
  if (cost === undefined) return NO_COST_LINES;
  const lines: CostLineView[] = [
    { resourceId: cost.resourceId, amountApprox: toApproxNumber(cost.buildFix) },
  ];
  for (const extra of cost.extraLines ?? []) {
    lines.push({ resourceId: extra.resourceId, amountApprox: toApproxNumber(extra.buildFix) });
  }
  return lines;
}

/**
 * [M73/R8-03] `fromLevel` → `fromLevel + 1` の増築の全コスト行。主資源の段が
 * 無ければ空(= 無料)——`facilityUpgradeCostLines` と同じ規約。
 */
function displayFacilityUpgradeCostLines(
  def: FacilityDef,
  fromLevel: number,
): readonly CostLineView[] {
  const cost = def.cost;
  if (cost === undefined) return NO_COST_LINES;
  const primaryFix = displayUpgradeCostOfLine(cost.upgradeByLevel, fromLevel);
  if (primaryFix === undefined) return NO_COST_LINES;
  const lines: CostLineView[] = [
    { resourceId: cost.resourceId, amountApprox: toApproxNumber(primaryFix) },
  ];
  for (const extra of cost.extraLines ?? []) {
    const fix = displayUpgradeCostOfLine(extra.upgradeByLevel, fromLevel);
    if (fix === undefined) continue;
    lines.push({ resourceId: extra.resourceId, amountApprox: toApproxNumber(fix) });
  }
  return lines;
}

/** コスト行 1 本の `fromLevel` → `fromLevel + 1` 増築費(index は Lv-1・配列超えは最後の段)。 */
function displayUpgradeCostOfLine(curve: readonly Fix[], fromLevel: number): Fix | undefined {
  if (curve.length === 0) return undefined;
  return curve[fromLevel - 1] ?? curve[curve.length - 1];
}

/** [M30] 施設カタログ 1 件(②の「何を建てるか」・content のみに依存)。 */
export interface FacilityCatalogEntry {
  readonly defId: EntityId;
  readonly tags: readonly Tag[];
  readonly footprint: FacilityFootprint;
  readonly harshWork: boolean;
  readonly outputKind: "resource" | "research";
  readonly outputResourceId: EntityId | null;
  /**
   * [束B/B-4] Lv1 建設コスト(GDD 12.1)。`def.cost` 省略時は無料(`null`)——
   * `commands.ts` の `facilityBuildCostFix` と同じ意味の値を**意図的に複製**
   * している(commands.ts は import 経路を store.ts 1 箇所に制限する検収済みの
   * 単一入口であり、`displayFacilityMaxLevel` 等と同じ理由で UI からは
   * 直接呼べない・本ファイル §3-2 冒頭の doc 参照)。
   */
  readonly buildCostApprox: number | null;
  readonly buildCostResourceId: EntityId | null;
  /**
   * [M73/R8-03 fatal] **実際に払う全コスト行**(第1行 = 上の
   * `buildCostApprox`/`buildCostResourceId` と同じ主資源)。M65 の複数資源コストを
   * 画面が 1 行も落とさずに出すための値({@link CostLineView} の doc)。
   * 省略時(既存テストフィクスチャ互換)は「主資源だけ」として扱う。
   */
  readonly buildCostLines?: readonly CostLineView[];
}

function facilityCatalogEntryOf(def: FacilityDef): FacilityCatalogEntry {
  return {
    defId: def.id,
    tags: def.tags,
    footprint: def.footprint ?? UNIT_FOOTPRINT,
    harshWork: def.harshWork,
    outputKind: def.output.kind,
    outputResourceId: def.output.kind === "resource" ? def.output.resourceId : null,
    buildCostApprox: def.cost === undefined ? null : toApproxNumber(def.cost.buildFix),
    buildCostResourceId: def.cost?.resourceId ?? null,
    buildCostLines: displayFacilityBuildCostLines(def),
  };
}

/** ID 昇順(GDD 11.7 の安定順序)。content の Map 反復順に依存しない。 */
function buildFacilityCatalog(content: EngineContent): readonly FacilityCatalogEntry[] {
  const entries = Array.from(content.facilityDefs.values(), facilityCatalogEntryOf);
  entries.sort((a, b) => compareUtf16(a.defId, b.defId));
  return entries;
}

/** [M30] 盤面に建っている施設 1 基(④の就労先選択)。 */
export interface FacilityRosterEntry {
  readonly facilityId: EntityId;
  readonly defId: EntityId;
  readonly cellIndex: number;
  readonly cellId: string;
  readonly level: number;
  readonly tags: readonly Tag[];
  readonly workerIds: readonly EntityId[];
  /** `null` = 上限なし(commands.ts の `facilityWorkerSlots` と同じ意味)。 */
  readonly slotsMax: number | null;
}

/** `entitiesOfKind` が返す順序(ID 昇順・state.ts §3(a))をそのまま使う。 */
function buildFacilityRoster(
  state: GameState,
  content: EngineContent,
): readonly FacilityRosterEntry[] {
  const entries: FacilityRosterEntry[] = [];
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    // content に定義が無い(理論上は起きない)状態で画面を落とさない、
    // という §3 の bLossImminentTechIds と同じ防御的スキップ。
    if (def === undefined) continue;
    entries.push({
      facilityId: facility.id,
      defId: facility.defId,
      cellIndex: facility.cellIndex,
      cellId: cellIdOf(facility.cellIndex),
      level: facility.level,
      tags: def.tags,
      workerIds: facility.workerIds,
      slotsMax: displayFacilityWorkerSlots(def, facility.level) ?? null,
    });
  }
  return entries;
}

/** [M30] 選択施設の就労者 1 人(③施設詳細の就労者一覧)。 */
export interface FacilityWorkerView {
  readonly residentId: EntityId;
  readonly moraleApprox: number;
  readonly alive: boolean;
  readonly dispatched: boolean;
  readonly recallImpaired: boolean;
  /**
   * [M70/R5-A02] この施設での寄与を実際に止めている想起困難tech(techId昇順)。
   * `recallImpaired`(住民単位スカラ)とは独立——空でも `recallImpaired` が
   * true なことはあるし(住民単位の全停止)、逆に `recallImpaired=false` でも
   * ここが非空なことがある((住民,tech) 別停止だけが効いている・M13 本式)。
   * 省略時(既存テストフィクスチャ互換)は空扱い(`?? []`)。
   */
  readonly impairedTechIds?: readonly EntityId[];
  /**
   * [M73/R8-14] `impairedTechIds` に**入らなかった**想起困難の件数(= この施設の
   * 寄与は止めていない tech の想起困難)。
   *
   * ④住民一覧は住民単位で「想起困難」を常時出すのに、③施設詳細は当該施設に
   * 関わる tech だけを出すため、同じ住民の状態が画面間で食い違って見えた
   * (R8-C03)。**絞り込み自体は正しい**(③の役目は「この施設の産出が止まって
   * いる理由」を示すことで、無関係な想起困難まで出すとこの施設が止まっている
   * かのような誤読になる)ので、規則は変えずに「ほかに N 件ある」ことを明示して
   * 矛盾に見えないようにする。省略時は 0 扱い。
   */
  readonly otherImpairedTechCount?: number;
}

/** [M30] 選択施設の詳細(③施設詳細/増築)。 */
export interface FacilityDetailView {
  readonly facilityId: EntityId;
  readonly defId: EntityId;
  readonly cellIndex: number;
  readonly cellId: string;
  readonly tags: readonly Tag[];
  readonly level: number;
  readonly maxLevel: number;
  /** `null` = 上限なし。 */
  readonly slotsMax: number | null;
  readonly workers: readonly FacilityWorkerView[];
  readonly outputKind: "resource" | "research";
  readonly outputResourceId: EntityId | null;
  /**
   * 現在の実際の産出レート(GDD 11.1 の全系統形。1 tick あたり)。
   * `facilityOutputPerTick`(Lv 別基礎産出)× `multiplierApprox`(隣接乗数・
   * ②と同じ `computeCellAdjacency`)× `activeLaborFix`(稼働就労者の寄与総和)
   * という **engine と同じ 3 項の積**で求める(rules/production.ts §2 の式を
   * 表示用に書き直さない)。
   */
  readonly outputPerTickApprox: number;
  /** ②のセルと同じ隣接乗数(`selectedCell.multiplierApprox` を転記)。 */
  readonly multiplierApprox: number;
  /**
   * [束B/B-4] 次の Lv への増築コスト(GDD 12.1)。既に上限 Lv なら `null`
   * (増築先が無い)。`def.cost` 省略時も `null`(無料)。`commands.ts` の
   * `facilityUpgradeCostFix` と同じ意味の値の意図的な複製(§3-2 冒頭 doc)。
   */
  readonly upgradeCostApprox: number | null;
  readonly upgradeCostResourceId: EntityId | null;
  /**
   * [M73/R8-03 fatal] **実際に払う全コスト行**(第1行 = 上の
   * `upgradeCostApprox`/`upgradeCostResourceId` と同じ主資源)。上限 Lv では空。
   * 省略時(既存テストフィクスチャ互換)は「主資源だけ」として扱う。
   */
  readonly upgradeCostLines?: readonly CostLineView[];
}

/**
 * [束B/B-4] `fromLevel` → `fromLevel + 1` の増築コスト。`commands.ts` の
 * `facilityUpgradeCostFix` と同じ規約(index は Lv-1・配列より大きい Lv は
 * 最後の段の値)。
 */
function displayFacilityUpgradeCostFix(def: FacilityDef, fromLevel: number): Fix | undefined {
  const cost = def.cost;
  if (cost === undefined) return undefined;
  return displayUpgradeCostOfLine(cost.upgradeByLevel, fromLevel);
}

/**
 * 選択セルの施設詳細を組み立てる。**隣接乗数は `cell`(= `computeCellAdjacency`
 * の結果)からもらう**——`AdvanceContext.multiplierByFacilityId` を再度引かず、
 * ②の内訳ビューと同じ 1 個の数値を見せるため(両者の一致は
 * tests/ui/derived.test.ts が既に固定している§3 の規律の延長)。
 */
function buildFacilityDetail(
  state: GameState,
  content: EngineContent,
  cell: CellViewModel,
): FacilityDetailView | null {
  if (!cell.occupied || cell.facilityId === null) return null;
  const facilityEntity = state.entityStateById.get(cell.facilityId);
  if (facilityEntity === undefined || facilityEntity.kind !== "facility") return null;
  const def = content.facilityDefs.get(facilityEntity.defId);
  if (def === undefined) return null;

  const workers: FacilityWorkerView[] = [];
  for (const workerId of facilityEntity.workerIds) {
    const residentEntity = state.entityStateById.get(workerId);
    if (residentEntity === undefined || residentEntity.kind !== "resident") continue;
    // [M70/R5-A02] この施設の寄与を実際に止めている tech だけ(techImpairmentStopsFacility)。
    const impairments = residentTechImpairments(state, workerId, state.tick);
    const impairedTechIds = impairedTechIdsAtFacility(impairments, content, def.id);
    workers.push({
      residentId: workerId,
      moraleApprox: toApproxNumber(residentEntity.morale),
      alive: isAliveResident(residentEntity),
      dispatched: residentEntity.dispatched,
      recallImpaired: residentEntity.recallImpairedUntilTick > state.tick,
      impairedTechIds,
      // [M73/R8-14] 絞り込みで落ちた件数(④住民一覧との非対称を明示するため)。
      otherImpairedTechCount: impairments.length - impairedTechIds.length,
    });
  }

  const outputRateFix = mulFix(
    mulFix(facilityOutputPerTick(def, facilityEntity.level), cell.multiplierFix),
    activeLaborFix(state, content, facilityEntity, def, state.tick),
  );

  const maxLevel = displayFacilityMaxLevel(def);
  const upgradeCostFix =
    facilityEntity.level >= maxLevel
      ? undefined
      : displayFacilityUpgradeCostFix(def, facilityEntity.level);

  return {
    facilityId: facilityEntity.id,
    defId: facilityEntity.defId,
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    tags: cell.tags,
    level: facilityEntity.level,
    maxLevel,
    slotsMax: displayFacilityWorkerSlots(def, facilityEntity.level) ?? null,
    workers,
    outputKind: def.output.kind,
    outputResourceId: def.output.kind === "resource" ? def.output.resourceId : null,
    outputPerTickApprox: toApproxNumber(outputRateFix),
    multiplierApprox: cell.multiplierApprox,
    upgradeCostApprox: upgradeCostFix === undefined ? null : toApproxNumber(upgradeCostFix),
    upgradeCostResourceId: upgradeCostFix === undefined ? null : (def.cost?.resourceId ?? null),
    // [M73/R8-03] 上限 Lv なら増築先が無いので空(主資源の行だけを null にして
    // 追加行が残る、という不整合を作らない)。
    upgradeCostLines:
      facilityEntity.level >= maxLevel
        ? NO_COST_LINES
        : displayFacilityUpgradeCostLines(def, facilityEntity.level),
  };
}

/** [M30] 開墾(GDD 9.1)の現況。②の瓦礫セル選択時に表示する。 */
export interface ReclaimInfo {
  /** content に `balance.reclaim` ブロックがあるか(無ければ開墾システム不活性)。 */
  readonly available: boolean;
  /** 次の 1 枚の開墾コスト(近似値)。`available=false` なら null。 */
  readonly nextCostApprox: number | null;
  readonly costResourceId: EntityId | null;
  /** コスト資源の現在庫(近似値)。受け皿 entity が無ければ null。 */
  readonly availableStockApprox: number | null;
  readonly reclaimedCount: number;
}

function buildReclaimInfo(state: GameState, content: EngineContent): ReclaimInfo {
  const params = content.reclaim;
  if (params === undefined) {
    return {
      available: false,
      nextCostApprox: null,
      costResourceId: null,
      availableStockApprox: null,
      reclaimedCount: state.terrain.reclaimedCount,
    };
  }
  const costFix = reclaimCostFix(params, state.terrain.reclaimedCount);
  let availableStockApprox: number | null = null;
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId !== params.costResourceId) continue;
    availableStockApprox = toApproxNumber(resource.stock);
    break;
  }
  return {
    available: true,
    nextCostApprox: toApproxNumber(costFix),
    costResourceId: params.costResourceId,
    availableStockApprox,
    reclaimedCount: state.terrain.reclaimedCount,
  };
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
  /**
   * [M61/FC11・R1-A26] 完了した大移動の回数(`state.progression.runCount`・
   * 0 = 1 周目)。ColonyClock の「周回N・第M日」表記に使う(tick は周回を跨いで
   * リセットしない設計=GDD/裁定どおり。表記だけで誤解を解く)。
   */
  readonly runCount: ReadonlyComputed<number>;
  readonly resources: ReadonlyComputed<readonly ResourceView[]>;
  readonly research: ReadonlyComputed<readonly ResearchView[]>;
  /**
   * [2026-08-02裁定・台帳v10 必-1] ヘッダ研究チップ用の軽量版(§7 手前・
   * `ResearchChipView` 参照)。`researchTree`(全 tech 24 行)と違い
   * 「いま点が流れ込んでいる 1 件」だけを持つ。
   */
  readonly researchChip: ReadonlyComputed<ResearchChipView | null>;
  /**
   * [M70/R5-A02] ⑤研究画面が「誰の・どのtechの想起困難で研究点産出が止まって
   * いるか」を明示するための一覧(`ResearchStallNote` の doc 参照)。
   */
  readonly researchStallNotes: ReadonlyComputed<readonly ResearchStallNote[]>;
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

  /**
   * [M30] 施設カタログ(②の「何を建てるか」の選択肢)。content のみに依存し
   * state を読まない(建てられる種類は盤面と無関係)。
   */
  readonly facilityCatalog: ReadonlyComputed<readonly FacilityCatalogEntry[]>;
  /**
   * [M30] 盤面に建っている施設の一覧(④の就労先選択・GDD 7.7)。
   * `resources`/`residents` と同じく state 直依存(値の派生・§2)。
   */
  readonly facilityRoster: ReadonlyComputed<readonly FacilityRosterEntry[]>;
  /**
   * [M30] 選択中セルの施設詳細(③施設詳細/増築)。未選択/空き/瓦礫セルは null。
   * `selectedCell` を先に読み、施設が無ければ state/content へ触れずに
   * 早期 return する(selectedCellBreakdown と同じ短絡の作法)。
   */
  readonly selectedFacilityDetail: ReadonlyComputed<FacilityDetailView | null>;
  /**
   * [M30] 開墾(GDD 9.1)の現況。次の 1 枚のコストは選択セルに依らず
   * `state.terrain.reclaimedCount` だけで決まる(rules/reclaim.ts §2)ので、
   * セル局所ではなく全体の値として持つ。
   */
  readonly reclaimInfo: ReadonlyComputed<ReclaimInfo>;

  /**
   * [M31] ⑤研究ツリー(GDD 5 / 7.4)。content の tech 全件(ID 昇順)に対し、
   * state 側の research entity から状態を重ね合わせる。state 直依存(§2 の
   * 「値の派生」と同じ扱い・tech 数は MVP 24 本程度)。
   */
  readonly researchTree: ReadonlyComputed<readonly ResearchTreeEntry[]>;
  /**
   * [M31] ⑥成文化キューの対象(GDD 7.4/7.5/11.1追補)。解禁済み(`isTechUnlocked`)
   * の tech だけを並べる(未解禁は成文化しようがない・喪失中は解禁が取り消されて
   * いるので自然に外れる)。
   */
  readonly codifyTechs: ReadonlyComputed<readonly CodifyTechEntry[]>;
  /**
   * [M31] おまかせ成文化の提案(`engine/assist/codify.ts` の `suggestCodification`
   * をそのまま呼ぶ・M27 のヒューリスティックを再実装しない)。画面は「適用」を
   * 押すまで state を動かさない(提案は常に読み取り専用)。
   */
  readonly codifySuggestions: ReadonlyComputed<readonly CodifySuggestionView[]>;
  /**
   * [M71/R6-A01] `codifySuggestions` の在庫フィルタ(R5-A08)で除外された候補の
   * 理由一覧。CodifyScreen.tsx の空メッセージが理由を語れるようにするための値
   * (`CodifySuggestionExclusionView` の doc 参照)。
   */
  readonly codifySuggestionExclusions: ReadonlyComputed<readonly CodifySuggestionExclusionView[]>;
  /**
   * [M32] ⑦探索本部の派遣候補(GDD 8.1 [2026-07-30裁定]②「寿命を持たない
   * 住民は派遣拒否」を候補列挙の段階で先に除外・M27 と同じ立場)。
   * [R8-01] 衛星拠点に常駐中の住民も同じく候補に出ない(engine の
   * `dispatchCandidates` が除外する)。
   */
  readonly expeditionCandidates: ReadonlyComputed<readonly ExpeditionCandidateView[]>;
  /** [M32] ⑦/⑧が読む未帰還派遣一覧(派遣 ID 昇順・state.ts 不変条件(g))。 */
  readonly expeditionDispatches: ReadonlyComputed<readonly ExpeditionDispatchView[]>;
  /** [M32] ⑦の派遣枠使用状況(GDD 8.1「派遣枠上限＝同時2枠」)。 */
  readonly expeditionSlots: ReadonlyComputed<ExpeditionSlotView>;
  /** [M32] ⑧が読む住民 memoir の一覧(tick 昇順・GDD 7.3)。 */
  readonly memoirFeed: ReadonlyComputed<readonly MemoirFeedEntry[]>;
  /** [M32] ⑧が読む帰還ログ(GDD 8.4・レンダリング済み文字列・50件上限)。 */
  readonly renderedLog: ReadonlyComputed<RenderedLogState>;
  /** [M32] ⑨衛星拠点の一覧 + 拠点網 ROI(GDD 9.2 / 11.4-7)。 */
  readonly outpostOverview: ReadonlyComputed<OutpostOverviewView>;
  /**
   * [M62/FC6b・R2-A08] 人口/寝床上限(GDD 7.6/7.7)。engine の
   * `populationViewOf` をそのまま返す(新規判定なし)。①ホームハブが
   * 「住民 N/寝床上限 M」の形で表示する(以前はどの画面にも寝床上限の
   * 現在値が出ておらず、寝床が実際に機能していることが伝わらなかった)。
   */
  readonly populationSummary: ReadonlyComputed<PopulationView>;
  /**
   * [M73/R8-05] 襲撃の見通し({@link RaidOutlookView})。襲撃機構が不活性な
   * content では `active: false` の 1 個だけを返す(捏造しない)。
   */
  readonly raidOutlook: ReadonlyComputed<RaidOutlookView>;
  /**
   * [M73/R8-05] このセッション中に解決した襲撃の累計(揮発・`sources.raidTally`
   * の写し)。シェルの通知ウォッチャが差分検知に使う。
   */
  readonly raidTally: ReadonlyComputed<RaidTally>;
}

const EMPTY_TAGS: readonly Tag[] = [];

function buildCellView(
  cellIndex: number,
  sources: StoreSources,
  adjacency: CellAdjacencyResult | null,
  isRubble: boolean,
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
      isRubble,
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
    // [M30] 占有セルは配置時に瓦礫が拒否されている(commands.ts の
    // cellIsRubble)ので通常は false だが、手編集セーブ等の異常系でも
    // 値を捏造せず素直に写す(rules/reclaim.ts §1 のコメントと同じ立場)。
    isRubble,
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
          const rubbleSignal = sources.cellRubble[cellIndex];
          if (adjacency === undefined || rubbleSignal === undefined) {
            throw new RangeError(`セル番号 ${String(cellIndex)} が格子の範囲を外れている`);
          }
          // [M30] 自セルのみを読む(§0 の fan-in 上界を保つ・cellFacility/
          // cellPlacement と同じ扱い)。
          return buildCellView(cellIndex, sources, adjacency.value, rubbleSignal.value);
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
  const runCount = computed<number>(() => sources.state.value.progression.runCount, {
    name: "runCount",
  });

  const resources = computed<readonly ResourceView[]>(
    () => {
      const state: GameState = sources.state.value;
      const content: EngineContent = sources.content.value;
      // [M63/R4-A04] 上限は engine 側の唯一の正本実装をそのまま呼ぶ(基礎400+
      // 建っている保管庫のLv合計×400・GDD 6.7)。UI 側で加算式を書き写さない。
      const capacities = resolveCapacityByResourceId(state, content);
      return entitiesOfKind(state, "resource").map((resource) => {
        const capacityFix = capacities.get(resource.resourceId) ?? null;
        const capacityApprox = capacityFix === null ? null : toApproxNumber(capacityFix);
        return {
          entityId: resource.id,
          resourceId: resource.resourceId,
          stockFix: resource.stock,
          stockApprox: toApproxNumber(resource.stock),
          capacityApprox,
          atCapacity: capacityFix !== null && toRaw(resource.stock) >= toRaw(capacityFix),
        };
      });
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

  /**
   * [2026-08-02裁定・台帳v10 必-1] ヘッダ研究チップ。`currentResearch` が
   * undefined(未選択かつ未完了 research が無い = 対象そのものが無い)なら null。
   * 対象があっても `stalled` が true なら「選ばれてはいるが進んでいない」
   * (`hasActiveResearchProduction` 直前の doc 参照・差し戻しの本題)。
   */
  const researchChip = computed<ResearchChipView | null>(
    () => {
      const state: GameState = sources.state.value;
      const content: EngineContent = sources.content.value;
      // [M73/R8-04 fatal] **content を渡す**(M67 のリダイレクト追従)。以前は
      // 引数 1 つで呼んでいたため、点が満了して実地要件待ちの研究をチップが
      // 指し続け、「🔬 100%」が完了せず動かない見え方になっていた。
      const current = currentResearch(state, content);
      if (current === undefined) return null;
      const def = content.techDefs.get(current.techId);
      if (def === undefined) return null; // 参照整合は engine 側が保証するが、表示側は捏造しない。
      const stalled = !hasActiveResearchProduction(state, content);
      // リダイレクト先が無い(全部が実地要件待ち)ときだけ立つ旗。判定は engine の
      // `isFieldRequirementMet` をそのまま呼ぶ(UI に条件を書かない)。
      const awaitingFieldRequirement = !isFieldRequirementMet(state, content, current);
      const costApprox = toApproxNumber(def.researchCostFix);
      if (costApprox <= 0) {
        return { techId: current.techId, progressPercent: 100, stalled, awaitingFieldRequirement };
      }
      const progressApprox = toApproxNumber(current.progress);
      const clampedApprox = Math.min(progressApprox, costApprox);
      return {
        techId: current.techId,
        progressPercent: Math.floor((clampedApprox / costApprox) * 100),
        stalled,
        awaitingFieldRequirement,
      };
    },
    { name: "researchChip" },
  );

  const researchStallNotes = computed<readonly ResearchStallNote[]>(
    () => buildResearchStallNotes(sources.state.value, sources.content.value),
    { name: "researchStallNotes" },
  );

  const residents = computed<readonly ResidentView[]>(
    () => {
      const state: GameState = sources.state.value;
      const content: EngineContent = sources.content.value;
      // [M70/R5-A07] 拠点常駐者の索引は 1 回だけ作って全住民で使い回す。
      const stationedByResident = stationedOutpostIdByResident(state);
      return entitiesOfKind(state, "resident").map((resident) => ({
        entityId: resident.id,
        moraleApprox: toApproxNumber(resident.morale),
        masteryApprox: toApproxNumber(resident.mastery),
        assignedFacilityId: resident.assignedFacilityId,
        dispatched: resident.dispatched,
        recallImpaired: resident.recallImpairedUntilTick > state.tick,
        recallImpairedUntilTick: resident.recallImpairedUntilTick,
        traitIds: resident.traitIds,
        stats: residentStatsView(resident, content),
        alive: isAliveResident(resident),
        diedTick: resident.life?.diedTick ?? null,
        // [M70/R5-A02]
        techImpairments: residentTechImpairments(state, resident.id, state.tick),
        // [M70/R5-A07]
        stationedOutpostId: stationedByResident.get(resident.id) ?? null,
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
      // [M70/R5-A02] 想起困難バッジは住民単位スカラだけでなく (住民,tech) 別
      // (M13 の実プレイ抽選はこちらにしか書かない・rules/recall.ts §3)も見る。
      // [M70/R5-A07] 拠点常駐者は「無配属で暇している」に数えない(idle の意味を
      // 「就いていない」から「安全に配属できるのに就いていない」へ正す)。
      const stationedByResident = stationedOutpostIdByResident(state);
      const techImpairedResidentIds =
        state.techMemoryByKey.size === 0
          ? null
          : new Set(
              livingResidents(state)
                .filter(
                  (resident) => residentTechImpairments(state, resident.id, state.tick).length > 0,
                )
                .map((resident) => resident.id),
            );
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
            if (
              entity.recallImpairedUntilTick > state.tick ||
              techImpairedResidentIds?.has(entity.id) === true
            ) {
              impairedResidentCount++;
            }
            if (
              entity.assignedFacilityId === null &&
              !entity.dispatched &&
              !stationedByResident.has(entity.id)
            ) {
              idleResidentCount++;
            }
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
        // [M73/R8-04] engine の `fieldBlockedResearches` をそのまま数える。
        researchFieldBlocked: fieldBlockedResearches(state, content).length,
        storageAtCapacity: storageAtCapacityResourceCount(state, content),
        // [M73/R8-05] 襲撃が起きうる盤面で防衛戦力が 0 のときだけ 1 件。判定は
        // engine の `hasDefense`(rules/raid.ts)をそのまま呼ぶ。
        raidUndefended: content.raid !== undefined && !hasDefense(state, content) ? 1 : 0,
        expeditionActive: state.dispatchSnapshots.length,
        idleResidents: badges.idleResidentCount,
      };
      const levels: { readonly [K in HomeAlertId]: UrgencyLevel } = {
        bLossImminent: "critical",
        recallImpaired: "warn",
        codifyPending: "warn",
        researchIdle: "warn",
        researchFieldBlocked: "warn",
        storageAtCapacity: "warn",
        raidUndefended: "info",
        expeditionActive: "info",
        idleResidents: "info",
      };
      const screens: { readonly [K in HomeAlertId]: ScreenId } = {
        bLossImminent: "codify",
        recallImpaired: "residents",
        codifyPending: "codify",
        researchIdle: "research",
        researchFieldBlocked: "research",
        storageAtCapacity: "grid",
        raidUndefended: "grid",
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

  // [M30] content のみに依存(盤面と無関係の「何を建てられるか」)。
  const facilityCatalog = computed<readonly FacilityCatalogEntry[]>(
    () => buildFacilityCatalog(sources.content.value),
    { name: "facilityCatalog" },
  );

  // [M30] state 直依存(§2 の「値の派生」と同じ扱い・施設数は高々数十)。
  const facilityRoster = computed<readonly FacilityRosterEntry[]>(
    () => buildFacilityRoster(sources.state.value, sources.content.value),
    { name: "facilityRoster" },
  );

  // [M30] selectedCell を先に読み、未選択/空き/瓦礫セルなら state/content へ
  // 触れずに早期 return する(selectedCellBreakdown と同じ短絡の作法)。
  const selectedFacilityDetail = computed<FacilityDetailView | null>(
    () => {
      const cell = selectedCell.value;
      if (cell === null || !cell.occupied) return null;
      return buildFacilityDetail(sources.state.value, sources.content.value, cell);
    },
    { name: "selectedFacilityDetail" },
  );

  // [M30] 開墾(GDD 9.1)。次のコストは選択セルに依らないので全体の値として持つ。
  const reclaimInfo = computed<ReclaimInfo>(
    () => buildReclaimInfo(sources.state.value, sources.content.value),
    { name: "reclaimInfo" },
  );

  // [M31] ⑤研究ツリー(GDD 5/7.4)。state 直依存(§2 の「値の派生」と同じ扱い)。
  const researchTree = computed<readonly ResearchTreeEntry[]>(
    () => buildResearchTree(sources.state.value, sources.content.value),
    { name: "researchTree" },
  );

  // [M31] ⑥成文化キュー対象(GDD 7.4/7.5/11.1追補)。
  const codifyTechs = computed<readonly CodifyTechEntry[]>(
    () => buildCodifyTechs(sources.state.value, sources.content.value),
    { name: "codifyTechs" },
  );

  // [M31] おまかせ成文化の提案(§7 参照)。[M71/R6-A01] 除外理由
  // (`codifySuggestionExclusions`)も同じ 1 回の分割(`partitionCodifySuggestions`)
  // から作る——`suggestCodification` の呼び出しを 2 重化しないため、まず
  // 分割結果そのものを 1 個の computed に持たせ、2 つの公開 computed はそこから
  // 射影するだけにする(computed から computed を読む・reactive.ts の通常の
  // 合成)。
  const codifySuggestionPartition = computed<CodifySuggestionPartition>(
    () => partitionCodifySuggestions(sources.state.value, sources.content.value),
    { name: "codifySuggestionPartition" },
  );
  const codifySuggestions = computed<readonly CodifySuggestionView[]>(
    () => codifySuggestionPartition.value.accepted,
    { name: "codifySuggestions" },
  );
  const codifySuggestionExclusions = computed<readonly CodifySuggestionExclusionView[]>(
    () => codifySuggestionPartition.value.excluded,
    { name: "codifySuggestionExclusions" },
  );

  // [M32] ⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理(§8 の builder を呼ぶだけ)。
  const expeditionCandidates = computed<readonly ExpeditionCandidateView[]>(
    () => buildExpeditionCandidates(sources.state.value, sources.content.value),
    { name: "expeditionCandidates" },
  );
  const expeditionDispatches = computed<readonly ExpeditionDispatchView[]>(
    () => buildExpeditionDispatches(sources.state.value),
    { name: "expeditionDispatches" },
  );
  const expeditionSlots = computed<ExpeditionSlotView>(
    () => buildExpeditionSlots(sources.state.value),
    { name: "expeditionSlots" },
  );
  const memoirFeed = computed<readonly MemoirFeedEntry[]>(
    () => buildMemoirFeed(sources.state.value),
    { name: "memoirFeed" },
  );
  const renderedLog = computed<RenderedLogState>(() => sources.state.value.renderedLogs, {
    name: "renderedLog",
  });
  const outpostOverview = computed<OutpostOverviewView>(
    () => buildOutpostOverview(sources.state.value, sources.content.value),
    { name: "outpostOverview" },
  );
  // [M62/FC6b・R2-A08] 人口/寝床上限の表示(engine の既存 derived 呼びのみ・
  // 新規判定なし)。`populationViewOf` をそのまま呼ぶだけで、下限判定
  // (`scarce`)も含めて engine 側の 1 実装を使い回す。
  const populationSummary = computed<PopulationView>(
    () => populationViewOf(sources.state.value, sources.content.value),
    { name: "populationSummary" },
  );
  // [M73/R8-05] 襲撃の見通し(§9)。tick を読むので毎分再評価されるが、
  // `equals` で「次回予定/戦力/強度が同じなら再描画しない」まで落とす。
  const raidOutlook = computed<RaidOutlookView>(
    () => buildRaidOutlook(sources.state.value, sources.content.value),
    { equals: raidOutlookEquals, name: "raidOutlook" },
  );
  const raidTally = computed<RaidTally>(() => sources.raidTally.value, { name: "raidTally" });

  return {
    adjacencyMatrix,
    cellAdjacency,
    cellView,
    gridSummary,
    tick,
    runCount,
    resources,
    research,
    researchChip,
    researchStallNotes,
    residents,
    codify,
    homeBadges,
    homeAlerts,
    selectedCell,
    selectedCellBreakdown,
    facilityCatalog,
    facilityRoster,
    selectedFacilityDetail,
    reclaimInfo,
    researchTree,
    codifyTechs,
    codifySuggestions,
    codifySuggestionExclusions,
    expeditionCandidates,
    expeditionDispatches,
    expeditionSlots,
    memoirFeed,
    renderedLog,
    outpostOverview,
    populationSummary,
    raidOutlook,
    raidTally,
  };
}

// --- 9. [M73/R8-05] 襲撃の見通し(GDD 11.1 の戦闘式 / 11.7 段10・M66)----------
//
//   Round 8 実測: 襲撃(3日周期)は撃退でも略奪でも**完全に無音**で、第10日00:00に
//   全資源が同時に約5%減るだけだった(UI 出力ゼロ)。襲撃機構の存在自体が
//   伝わらないので、見張り台を建てる動機も生まれない。
//
//   **engine を変えずに出せるものだけを出す**(タスク指示の制約優先順位(1)):
//   次回の判定 tick(`nextRaidTick`)・盤面の防衛戦力(`colonyDefenseFix`)・
//   襲撃の強さ(`raidStrengthFix`)・略奪比率(content)は**すべて engine の
//   読み取り専用関数 / content から取れる**。発生の通知は engine の自己申告
//   カウンタ(`ScheduleReport.raidCount`)を揮発の累計へ足したもの
//   (`sources.raidTally`)をシェルが差分検知する。**襲撃の履歴を state へ持たせる
//   設計は採らない**(直列化に載って golden 89 本が割れる・sources.ts の doc)。

/** [M73/R8-05] 襲撃の見通し(①ホームハブ・③見張り台の判断材料)。 */
export interface RaidOutlookView {
  /** content に `raid` ブロックがあるか(無ければ襲撃は一度も起きない)。 */
  readonly active: boolean;
  /** 次の襲撃判定 tick(絶対グリッド)。不活性なら null。 */
  readonly nextRaidTick: number | null;
  /** 盤面の防衛戦力(外周配置ボーナス込み・`colonyDefenseFix` そのまま)。 */
  readonly defenseApprox: number;
  /** 今の襲撃の強さ(`raidStrengthFix` そのまま・到達エラで逓増)。 */
  readonly strengthApprox: number;
  /** 撃退に失敗したときに各資源から失われる比率(%表示用)。 */
  readonly lootPercentApprox: number;
  /** 乱数の幅を最悪に引いても撃退できるか(= 防衛戦力だけで強さを上回る)。 */
  readonly repelCertain: boolean;
  /** 乱数の幅を最良に引いても撃退できないか(= 防衛が絶望的に足りない)。 */
  readonly repelImpossible: boolean;
}

const INACTIVE_RAID_OUTLOOK: RaidOutlookView = {
  active: false,
  nextRaidTick: null,
  defenseApprox: 0,
  strengthApprox: 0,
  lootPercentApprox: 0,
  repelCertain: false,
  repelImpossible: false,
};

function raidOutlookEquals(a: RaidOutlookView, b: RaidOutlookView): boolean {
  return (
    a.active === b.active &&
    a.nextRaidTick === b.nextRaidTick &&
    a.defenseApprox === b.defenseApprox &&
    a.strengthApprox === b.strengthApprox &&
    a.lootPercentApprox === b.lootPercentApprox &&
    a.repelCertain === b.repelCertain &&
    a.repelImpossible === b.repelImpossible
  );
}

/**
 * 襲撃の見通しを組み立てる。**判定式は engine の関数をそのまま呼ぶ**
 * (`colonyDefenseFix`/`raidStrengthFix`/`nextRaidTick`)。乱数の幅
 * (`rollRange`)との比較だけはこの層で行うが、これは `resolveRaid` が使う式
 * `防衛 + roll >= 強さ` の両端(roll=0 と roll=rollRange)を当てはめた
 * **同じ式の評価**であり、第二の判定モデルではない。
 */
function buildRaidOutlook(state: GameState, content: EngineContent): RaidOutlookView {
  const raid = content.raid;
  if (raid === undefined) return INACTIVE_RAID_OUTLOOK;
  const defenseApprox = toApproxNumber(
    colonyDefenseFix(state, content, raid.perimeterDefenseMulFix),
  );
  const strengthApprox = toApproxNumber(raidStrengthFix(state, content));
  return {
    active: true,
    nextRaidTick: nextRaidTick(content, state.tick),
    defenseApprox,
    strengthApprox,
    lootPercentApprox: toApproxNumber(raid.lootRatioFix) * 100,
    repelCertain: defenseApprox >= strengthApprox,
    repelImpossible: defenseApprox + raid.rollRange < strengthApprox,
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
 * **[M30] 瓦礫セル(GDD 9.1)も `fits=false` にする**——`placeFacility` は
 * 占有セルのいずれかが瓦礫なら `cellIsRubble` で reject するので(commands.ts
 * §4)、プレビューが「置ける」と示して実際は reject される食い違いを防ぐ
 * (GDD 6.3 の「共通ロジック」要件をここでも満たす)。
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
    const anyRubble = cells.some((c) => sources.cellRubble[c]?.peek() ?? false);
    if (!allEmpty || anyRubble) {
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
  // [M70/R5-A06] 帰還した派遣の隊員は配属が自動復帰しない(GDD の仕様どおり=
  // engine 側は変えない)ので、少なくとも 1 件の帰還があった不在期間だけ、
  // 現在無配属の住民がいることを明示する(returnLogs の直後=帰還がらみ)。
  "returnedUnassignedResidents",
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
  // [M70/R5-A06] 帰還後に配属が自動復帰しない(engineの仕様どおり)ことの明示。
  // 拠点常駐者は「無配属」に数えない(R5-A07 と同じ定義・homeBadges と揃える)。
  let idleResidentCount = 0;
  const stationedByResident = stationedOutpostIdByResident(state);

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
      if (
        isAliveResident(entity) &&
        !entity.dispatched &&
        entity.assignedFacilityId === null &&
        !stationedByResident.has(entity.id)
      ) {
        idleResidentCount++;
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
  // [M70/R5-A06] 少なくとも 1 件の帰還ログがあった不在期間だけ点灯する
  // (帰還と無関係に常時「無配属がいる」を言うと既存の idleResidents ホーム
  // バッジと重複するため・帰還ダイジェストは「帰還が理由でこうなったかも
  // しれない」という文脈を添える専用の行)。
  const returnedUnassignedResidents = logEntries.length > 0 ? idleResidentCount : 0;
  const counts: { readonly [K in DigestRowId]: number } = {
    residentDeaths: deathCount,
    techLosses: rareLossCount + recoverableLossCount,
    returnLogs: logEntries.length,
    returnedUnassignedResidents,
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
    returnedUnassignedResidents: "residents",
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
    returnedUnassignedResidents: true,
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

// --- 7. ⑤研究ツリー / ⑥成文化キュー(M31)— GDD 5 / 7.4 / 7.5 / 11.1追補 / 2.1 ---
//
// ===========================================================================
// 1. 二重の正直な開示(★ 最終報告で必ず参照すること)
// ===========================================================================
//   [2026-08-01 M50 で (a)(b)(c) すべて解消] (a) `beginResearch` は実装済み
//       (選択が有効ならそれ/無ければ従来の ID 昇順先頭)。M31 の「M50 実装後
//       に画面側を 1 行も変えずに動き出す」設計どおり、⑤は無変更で動いている。
//       (b) 成文化の tick 結線も実装済み(`PIPELINE_STAGE.codify` 段50)。
//       (c) 取消コマンド `cancelCodification` も新設済み——ただし⑥の取消
//       ボタン自体は未設置(M50 は UI 非接触の縛り。次の UI タスクで接続)。
//
// ===========================================================================
// 2. (A)/(B) の常時判別(GDD 7.4・M31 検収条件)
// ===========================================================================
//   `ResearchTreeEntry.lossClass` は状態に関わらず**全 tech で常に**持つ値。
//   画面側はこれを毎行のバッジにする(喪失していなくても (A)/(B) が見える)。
//   実際に一回性喪失した tech は `status: "lostIrreversible"` で追加の強い
//   表現を出す(GDD 7.4「取り返しがつかない」の具体化)。
// ---------------------------------------------------------------------------

/** ⑤研究ツリー 1 行の状態(state.research + loss を状態機械へ写したもの)。 */
export const RESEARCH_TREE_STATUSES = [
  "notStarted",
  "researching",
  "completed",
  "lostRecoverable",
  "lostIrreversible",
] as const;

export type ResearchTreeStatus = (typeof RESEARCH_TREE_STATUSES)[number];

/** ⑤研究ツリー 1 行(content の tech 定義 + state の research entity の重ね合わせ)。 */
export interface ResearchTreeEntry {
  readonly techId: EntityId;
  /** `TechDef.eraId` 省略時は null(GDD 5.1 のエラ不明扱いと同じ)。 */
  readonly eraId: string | null;
  /** GDD 7.4 の二層。**状態に関わらず常に持つ**(§2)。 */
  readonly lossClass: TechLossClass;
  /** 前提 tech(ID 昇順・`prereqsOfTech` そのまま)。 */
  readonly prereqTechIds: readonly EntityId[];
  /** 前提が全て解禁済みか(表示専用の参考情報。ボタンの活性/非活性には使わない)。 */
  readonly prereqsMet: boolean;
  readonly researchCostApprox: number;
  readonly status: ResearchTreeStatus;
  /** `status` が `researching` のときだけ非 null。 */
  readonly progressApprox: number | null;
  /** 単一キュー(research.ts §2)の先頭 = 実際に研究点が入っている対象か。 */
  readonly isCurrentResearchTarget: boolean;
  /**
   * [M73/R8-04 fatal] M67 実地要件({@link FieldRequirementView})。要件を持たない
   * tech / `content.research` が無い content では null。省略時(既存テスト
   * フィクスチャ互換)も null 扱い。
   */
  readonly fieldRequirement?: FieldRequirementView | null;
  /**
   * [M73/R8-04 fatal] 研究点は満了したのに実地要件が未達で**完了できない**状態。
   * この行の「進行度 40/40」「100%」が完了を意味しないことを画面が言うための旗
   * (engine 側の `isPointsSaturated` と同じ条件・研究点はこの研究を飛ばして
   * 次へ回されている)。省略時は false 扱い。
   */
  readonly awaitingFieldRequirement?: boolean;
}

/**
 * [M73/R8-04 fatal] M67 実地要件の表示値(GDD 5「該当施設で該当レシピを N 回稼働」)。
 *
 * Round 8 実測: 研究点が満了しても実地要件が未達なら完了しないのに、UI は
 * 「研究中: 進行度 40/40」「100%」を出し続けて約29ゲーム時間静止した(= 100% 表示が
 * 完了を意味しない虚偽表示)。要件の内容・進捗・行き先のどれも全画面に無かった。
 *
 * **レシピ名を出さない理由**: content の `tech.fieldRequirement.recipe` は
 * 識別子のまま据え置きで(recipe カテゴリは MVP 対象外)、ローダーが
 * `TechDef` へ写していない(`rules/types.ts` の `fieldRequirementCount` doc)。
 * engine が持っていない情報を UI で作らない(捏造しない)ので、要件は
 * 「該当施設での稼働 N 回」として見せる。
 */
export interface FieldRequirementView {
  /** 稼働が数えられる施設(`TechDef.fieldFacilityId`)。省略 content では null。 */
  readonly facilityDefId: EntityId | null;
  /** 必要な稼働回数(`tech.fieldRequirement.count`)。 */
  readonly requiredCount: number;
  /** 済んだ回数(切り捨て。1 回 = `research.recipeRunTicks` tick の稼働)。 */
  readonly completedCount: number;
  /** 充足済みか(`isFieldRequirementMet` と同じ意味)。 */
  readonly met: boolean;
  /**
   * その施設が**いま**稼働しているか(稼働就労者が 1 人以上)。engine が蓄積に
   * 使う述語(`isWorkerActiveAtFacility`)をそのまま呼ぶので、「建ててあるのに
   * 誰も就いていないので永久に進まない」状態を正直に出せる。
   */
  readonly facilityRunning: boolean;
}

/**
 * [M73/R8-04] 実地要件の表示値を組み立てる。`content.research` が無い / tech に
 * `fieldRequirementCount` が無い(= 要件なし)なら null。
 *
 * 必要 tick は engine の `fieldRequirementTicks`(唯一の正本)をそのまま呼び、
 * 「回数 × 1回の tick 数」の掛け算を UI 側で書き直さない。
 */
function fieldRequirementViewOf(
  state: GameState,
  content: EngineContent,
  techId: EntityId,
): FieldRequirementView | null {
  const requiredTicks = fieldRequirementTicks(content, techId);
  if (requiredTicks <= 0) return null;
  const def = content.techDefs.get(techId);
  const requiredCount = def?.fieldRequirementCount ?? 0;
  const runTicks = content.research?.recipeRunTicks ?? 0;
  const accumulatedTicks = toApproxNumber(getFieldRunTicks(state, techId) ?? FIX_ZERO);
  const facilityDefId = def?.fieldFacilityId ?? null;
  return {
    facilityDefId,
    requiredCount,
    completedCount:
      runTicks <= 0 ? 0 : Math.min(requiredCount, Math.floor(accumulatedTicks / runTicks)),
    met: accumulatedTicks >= requiredTicks,
    facilityRunning: facilityDefId !== null && isFacilityDefRunning(state, content, facilityDefId),
  };
}

/**
 * [M73/R8-04] その施設定義の基が 1 つでも「稼働就労者つき」で建っているか。
 * 判定は engine の `isWorkerActiveAtFacility`(実地稼働の蓄積・生産式が使うのと
 * 同一の述語)をそのまま呼ぶ——UI 側に「稼働とは何か」を書かない。
 */
function isFacilityDefRunning(
  state: GameState,
  content: EngineContent,
  facilityDefId: EntityId,
): boolean {
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.defId !== facilityDefId) continue;
    for (const workerId of facility.workerIds) {
      const resident = state.entityStateById.get(workerId);
      if (resident === undefined || resident.kind !== "resident") continue;
      if (isWorkerActiveAtFacility(state, content, resident, facilityDefId, state.tick))
        return true;
    }
  }
  return false;
}

/**
 * tech の表示順(GDD 5.2「エラ別テック一覧」)= エラ順(`erasInOrder`) × エラ内
 * ID 昇順(`techsOfEra` がそのまま返す順序)。エラ不明(`eraDefs` 省略 / tech の
 * `eraId` が省略・content に存在しないエラを指す等)の tech は末尾へ ID 昇順で
 * 追加する(GDD 5.1 の「エラ不明」扱いと同じ・techTree.ts の網羅から漏れる分の
 * 受け皿)。`techTree.ts` の関数をそのまま使い、順序ロジックを画面側で複製しない。
 */
function orderedTechIds(content: EngineContent): readonly EntityId[] {
  const result: EntityId[] = [];
  const seen = new Set<EntityId>();
  for (const era of erasInOrder(content)) {
    for (const def of techsOfEra(content, era.id)) {
      if (seen.has(def.id)) continue;
      seen.add(def.id);
      result.push(def.id);
    }
  }
  for (const techId of [...content.techDefs.keys()].sort(compareUtf16)) {
    if (!seen.has(techId)) result.push(techId);
  }
  return result;
}

/**
 * ⑤研究ツリーの表示モデルを組み立てる。content の tech 全件(エラ順・§ 直前の
 * `orderedTechIds`)を軸にし、state 側に research entity が無い tech は
 * `notStarted` として並べる(`beginResearch` 未実装により、これらは engine
 * 側の手段では現状增えないが、画面としては「まだ手を付けていない」を正直に
 * 見せる)。
 */
function buildResearchTree(state: GameState, content: EngineContent): readonly ResearchTreeEntry[] {
  const researchByTechId = new Map<EntityId, ResearchState>();
  for (const entry of entitiesOfKind(state, "research")) {
    // 同一 techId の research entity が複数あることは現行の生成経路では
    // 起きないが、起きても「先に見つかった方」を表示専用として拾う
    // (`currentResearch` と違い一意性を強制する場ではないため)。
    if (!researchByTechId.has(entry.techId)) researchByTechId.set(entry.techId, entry);
  }
  // [M73/R8-04 fatal] **content を渡す**。省略すると M67 のリダイレクト
  // (点が満了して実地要件待ちの研究を飛ばす・rules/research.ts の
  // `isPointsSaturated`)が効かず、「選択中」と「実際に点が入っている研究」が
  // ずれたまま表示される(Phase B からの申し送り)。
  const current = currentResearch(state, content);
  // [M73/R8-04] 点は満了したが実地要件待ちで完了できない研究(engine の
  // `fieldBlockedResearches` をそのまま呼ぶ・UI 側に条件を書かない)。
  const fieldBlockedTechIds = new Set(
    fieldBlockedResearches(state, content).map((research) => research.techId),
  );
  const techIds = orderedTechIds(content);

  const result: ResearchTreeEntry[] = [];
  for (const techId of techIds) {
    const def = content.techDefs.get(techId);
    if (def === undefined) continue;
    const research = researchByTechId.get(techId);
    const prereqTechIds = prereqsOfTech(content, techId);
    const prereqsMet = prereqTechIds.every((prereqId) => isTechUnlocked(state, prereqId));

    const researchCostApprox = toApproxNumber(def.researchCostFix);
    let status: ResearchTreeStatus;
    let progressApprox: number | null = null;
    if (research === undefined) {
      status = "notStarted";
    } else if (research.completedTick !== null) {
      status = "completed";
    } else if (research.loss !== undefined) {
      // GDD 7.4: completedTick は喪失時に null へ戻る。(A) は再研究可能な
      // 「停滞」、(B) は `currentResearch` の対象からも外れる「一回性」。
      status = research.loss.irreversible ? "lostIrreversible" : "lostRecoverable";
    } else {
      status = "researching";
      // [束B/m-2] 表示のみのクランプ。`research.progress` は完了 tick ちょうどで
      // 区切ると切り上げ由来の余剰(research.ts の規約)を残したまま完了扱いに
      // なる前の 1 tick だけコストを僅かに超えることがあり、素の値をそのまま
      // 出すと「進行度 31.0/30.0」のような見た目になる(engine の値自体は
      // 1 bit も変えない・表示のみのクランプ)。
      progressApprox = Math.min(toApproxNumber(research.progress), researchCostApprox);
    }

    result.push({
      techId,
      eraId: def.eraId ?? null,
      lossClass: lossClassOfTech(content, techId),
      prereqTechIds,
      prereqsMet,
      researchCostApprox,
      status,
      progressApprox,
      isCurrentResearchTarget: current !== undefined && current.techId === techId,
      fieldRequirement: fieldRequirementViewOf(state, content, techId),
      awaitingFieldRequirement: fieldBlockedTechIds.has(techId),
    });
  }
  return result;
}

/** ⑥成文化キューの作業中(未完了)記録 1 件。 */
export interface CodifyPendingRecordView {
  readonly entityId: EntityId;
  readonly medium: RecordMedium;
  /** §1(b) のとおり、tick 結線が無いため現状は着手時の値のまま動かない。 */
  readonly progressApprox: number;
  readonly requiredWorkApprox: number;
}

/** ⑥成文化キュー 1 行(解禁済み tech 1 本ぶん)。 */
export interface CodifyTechEntry {
  readonly techId: EntityId;
  readonly lossClass: TechLossClass;
  /** 生存保持者(ID 昇順・`techHoldersOf` そのまま)。 */
  readonly holderIds: readonly EntityId[];
  readonly uniqueHolder: boolean;
  /** 完了済み記録が 1 件以上あるか(`isCodified`)。 */
  readonly isCodified: boolean;
  /** 完了済み記録の媒体一覧(`recordMediaOfTech`・宣言順)。 */
  readonly recordedMedia: readonly RecordMedium[];
  /** 作業中(未完了)の記録一覧。 */
  readonly pendingRecords: readonly CodifyPendingRecordView[];
  /**
   * [2026-07-31裁定=GDD 7.5] 生存保持者中の最小残存想定tick
   * (`codifyResidualTick` そのまま)。`hasDeadline` が false のときは
   * {@link CODIFY_NO_DEADLINE_TICKS}(寿命モデル不活性)であり、画面は
   * この値をそのまま tick 数として表示しない。
   */
  readonly residualTick: number;
  readonly hasDeadline: boolean;
  /** 保持者のうち最大の 1 日あたり想起リスク(%表示用)。保持者 0 人は null。 */
  readonly maxRecallRiskPercentApprox: number | null;
}

/**
 * ⑥成文化キューの対象一覧を組み立てる。**解禁済み(`isTechUnlocked`)の tech
 * だけ**を並べる(未解禁は成文化しようがなく、一回性喪失/停滞喪失中の tech は
 * `completedTick` が null へ戻っていて `isTechUnlocked` が自然に false を返す
 * ので、ここで重ねて除外条件を書く必要が無い)。
 */
function buildCodifyTechs(state: GameState, content: EngineContent): readonly CodifyTechEntry[] {
  const techIds = [...content.techDefs.keys()].sort(compareUtf16);
  const result: CodifyTechEntry[] = [];

  for (const techId of techIds) {
    if (!isTechUnlocked(state, techId)) continue;
    const holderIds = techHoldersOf(state, techId);

    const pendingRecords: CodifyPendingRecordView[] = [];
    for (const job of entitiesOfKind(state, "codify")) {
      if (job.techId !== techId || job.completedTick !== null) continue;
      pendingRecords.push({
        entityId: job.id,
        medium: job.medium,
        progressApprox: toApproxNumber(job.progress),
        requiredWorkApprox: toApproxNumber(job.requiredWork),
      });
    }

    let maxRecallRiskPercentApprox: number | null = null;
    for (const holderId of holderIds) {
      const holder = state.entityStateById.get(holderId);
      if (holder === undefined || holder.kind !== "resident") continue;
      const riskPercent = toApproxNumber(recallRiskPerDay(state, content, holder, techId)) * 100;
      if (maxRecallRiskPercentApprox === null || riskPercent > maxRecallRiskPercentApprox) {
        maxRecallRiskPercentApprox = riskPercent;
      }
    }

    const residualTick = codifyResidualTick(state, techId, state.tick);
    result.push({
      techId,
      lossClass: lossClassOfTech(content, techId),
      holderIds,
      uniqueHolder: holderIds.length === 1,
      isCodified: isCodified(state, techId),
      recordedMedia: recordMediaOfTech(state, techId),
      pendingRecords,
      residualTick,
      hasDeadline: residualTick !== CODIFY_NO_DEADLINE_TICKS,
      maxRecallRiskPercentApprox,
    });
  }
  return result;
}

/** おまかせ成文化の提案 1 件(`CodificationSuggestion` の表示用ラップ)。 */
export interface CodifySuggestionView {
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  /** `beginCodification` へそのまま渡せる entity ID(`codifyRecordId` 由来)。 */
  readonly codifyId: EntityId;
  readonly residualTick: number;
  readonly hasDeadline: boolean;
  readonly durationTicks: number;
  readonly cumulativeTicks: number;
  readonly onSchedule: boolean;
}

/**
 * [M71/R6-A01] `buildCodifySuggestions` の在庫フィルタ(R5-A08)で**落とされた**
 * 候補 1 件(除外理由つき)。
 *
 * 空メッセージ(CodifyScreen.tsx の `CodifySuggestionPanel`)が「対象がありません
 * (保持者がいる未成文の技術がありません)」という固定文言のまま、実際には
 * 除外理由(在庫不足)がある候補が同画面の他行に並んで見える矛盾(R6-A01)への
 * 対応。ここでは「不足していたコスト資源」だけを持ち、件数集計・文言化は
 * 画面側の責務とする(`HomeAlert`/`derived.ts` 冒頭の「文言は画面が持つ」規律
 * どおり)。
 */
export interface CodifySuggestionExclusionView {
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  /** 除外理由になった、在庫が足りなかったコスト資源。 */
  readonly resourceId: EntityId;
}

/** {@link partitionCodifySuggestions} の戻り値(accepted/excluded を 1 回の
 * `suggestCodification` 呼び出しから同時に作るための内部型)。 */
interface CodifySuggestionPartition {
  readonly accepted: readonly CodifySuggestionView[];
  readonly excluded: readonly CodifySuggestionExclusionView[];
}

/** その資源の在庫近似値(受け皿 entity が無ければ 0・`buildReclaimInfo` と同型)。 */
function resourceStockApproxOrZero(state: GameState, resourceId: EntityId): number {
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === resourceId) return toApproxNumber(resource.stock);
  }
  return 0;
}

/**
 * おまかせ成文化の提案(GDD 2.1「おまかせ成文化」)。**state を 1 バイトも
 * 動かさない**(`suggestCodification` は読み取り専用・§1 と同じ立場)。
 *
 * `content.recordMedia` が無い content(engine のテストフィクスチャ等)では
 * `suggestCodification` が候補到達時に例外を投げうる(`planCodification` が
 * `recordMedia` を必須にするため)ので、ここで先に空へ倒す
 * (`reclaimInfo`/`buildReclaimInfo` の「機構が無ければ不活性」と同じ作法)。
 *
 * **[M70/R5-A08] 入手不能な媒体(コスト資源の在庫が足りない)は提案しない。**
 * engine のヒューリスティック(`suggestCodification`)は在庫を見ずに並べる
 * (§2 の定義どおり)ため、紙0・写字室なしの盤面でも紙媒体を提案し、適用すると
 * `insufficientResource` で即座に停止し「0/1件を適用しました」が古いまま
 * 残り続けていた(R5-A08)。ここでやるのは CodifyScreen.tsx の
 * `defaultMediumFor` と同じ「在庫を見て選ぶ」UI アシストの延長であり
 * (§ 既存の precedent)、`suggestCodification` の並び順/優先度そのものは
 * 書き換えない(=engine の判定ロジックを UI で二重実装しない)——1 件も選ばず
 * 落とすだけ。**既知の単純化**: 廃材代替(`codifyWasteSubstitution`)は加味
 * しない(CodifyScreen.tsx `defaultMediumFor` の doc と同じ簡易判定)。落とした
 * ぶんだけ `cumulativeTicks`/`onSchedule` は「その手も含めて流したときの値」の
 * ままになる(安全側に倒れるだけで、engine の実際のキュー結果とは無関係な表示
 * 専用値なので実害はない)。
 */
// [M71/R6-A01] `buildCodifySuggestions`(旧名)を accepted/excluded を同時に
// 作る `partitionCodifySuggestions` へ拡張した。落ちた候補も
// {@link CodifySuggestionExclusionView} として集める理由は 2 つ:
// ① `suggestCodification` を accepted 用/excluded 用で 2 回呼ぶ無駄を避ける
// ② 判定条件(在庫 < コスト)を 1 箇所にしか書かないことで、accepted と
//    excluded の基準が将来ズレる事故を構造的に防ぐ。
function partitionCodifySuggestions(
  state: GameState,
  content: EngineContent,
): CodifySuggestionPartition {
  if (content.recordMedia === undefined) return { accepted: [], excluded: [] };
  const plan = suggestCodification(state, content, state.tick);
  const printingUnlocked = isPrintingUnlocked(state, content);
  const accepted: CodifySuggestionView[] = [];
  const excluded: CodifySuggestionExclusionView[] = [];
  for (const suggestion of plan.suggestions) {
    const costPlan = planCodification(
      content,
      suggestion.techId,
      suggestion.medium,
      printingUnlocked,
    );
    const stockApprox = resourceStockApproxOrZero(state, costPlan.costResourceId);
    if (stockApprox < toApproxNumber(costPlan.costFix)) {
      excluded.push({
        techId: suggestion.techId,
        medium: suggestion.medium,
        resourceId: costPlan.costResourceId,
      });
      continue;
    }
    accepted.push({
      techId: suggestion.techId,
      medium: suggestion.medium,
      codifyId: suggestion.codifyId,
      residualTick: suggestion.residualTick,
      hasDeadline: suggestion.residualTick !== CODIFY_NO_DEADLINE_TICKS,
      durationTicks: suggestion.durationTicks,
      cumulativeTicks: suggestion.cumulativeTicks,
      onSchedule: suggestion.onSchedule,
    });
  }
  return { accepted, excluded };
}

// --- 8. 探索本部/冒険記/衛星拠点(⑦⑧⑨・M32)------------------------------------
//
// 3 画面とも「engine の既存データ/既存計算を読むだけ」(GDD 8.6 の ROI 式は
// rules/exploration.ts の explorationRoi を、GDD 9.2 / 11.4-7 の拠点網 ROI は
// rules/outpost.ts の outpostNetworkRoi をそのまま呼ぶ。UI 側で式を書き直さない
// —— §3 冒頭の「単一正準実装」の規律を⑦⑨へも適用する)。
//
// (a) 探索編成テンプレの提案(assist/exploration.ts の suggestExpeditionTeams)は
//     **画面(ExpeditionScreen.tsx)側が直接呼ぶ**。ここの expeditionCandidates
//     と違い、提案は「その場のチーム人数/除外指定」という画面ローカルの一時
//     入力に依存するので、signal グラフの computed にする理由が無い
//     (§5 の computePlacementPreview と同じ立場)。
// (b) ROI プレビュー({@link previewExplorationRoi})も同じ理由で computed に
//     しない —— 距離帯とチーム編成という画面ローカルの選択に依存するため。

/** ⑦の派遣候補 1 名(GDD 8.1 [2026-07-30裁定]②「寿命を持たない住民は除外」)。 */
export interface ExpeditionCandidateView {
  readonly entityId: EntityId;
  /** GDD 8.2 の combatPower(装備補正を含まないチーム編成前の個人値)。 */
  readonly combatPowerApprox: number;
  readonly moraleApprox: number;
  readonly traitIds: readonly EntityId[];
}

/** ⑦/⑧が読む未帰還派遣 1 件(`DispatchSnapshot` の表示用の写し)。 */
export interface ExpeditionDispatchView {
  readonly dispatchId: EntityId;
  readonly destinationId: EntityId;
  readonly band: DistanceBand;
  readonly stance: DispatchStance;
  readonly memberIds: readonly EntityId[];
  readonly dispatchTick: number;
  readonly returnTick: number;
  readonly rewardResourceId: EntityId;
  readonly rewardApprox: number;
  readonly withdrawn: boolean;
  readonly casualtyMemberIds: readonly EntityId[];
}

/** ⑦の派遣枠使用状況(GDD 8.1「派遣枠上限＝同時2枠」)。 */
export interface ExpeditionSlotView {
  readonly used: number;
  readonly max: number;
}

/**
 * ⑧が読む住民 memoir 1 件(GDD 7.3)。文言は持たず(テンプレ ID + 決定論
 * パラメータのまま・state.ts の doc「実文言は content/UI 層の担当」)、
 * 画面側(ChronicleScreen.tsx)が種別ごとの文言テーブルを持つ
 * (ReturnDigest.tsx の DIGEST_LEAD_TEXT と同じ作法)。
 */
export interface MemoirFeedEntry {
  readonly residentId: EntityId;
  readonly entry: MemoirEntry;
}

/** ⑨の拠点 1 基(GDD 9.2)。ROI 内訳は `rules/outpost.ts` の算出をそのまま写す。 */
export interface OutpostRosterEntry {
  readonly outpostId: EntityId;
  readonly outpostTypeId: EntityId;
  readonly resourceId: EntityId;
  readonly band: DistanceBand;
  readonly level: number;
  readonly residentIds: readonly EntityId[];
  readonly establishedTick: number;
  readonly supplyApprox: number;
  readonly upkeepApprox: number;
  readonly netRevenueApprox: number;
  /** hazard(GDD 9.2 の「駐在員が (B) 資産を失う期待確率」・0〜1)。 */
  readonly hazardApprox: number;
  readonly rareAssetCount: number;
  /** 期待 (B) 喪失損失(GDD 8.6 を拠点へ援用・rules/outpost.ts §4)。 */
  readonly expectedRareLossApprox: number;
  /** ROI = supply / (upkeep + 期待B喪失損失)。分母 0 なら null。 */
  readonly roiApprox: number | null;
}

/** ⑨の拠点網全体(GDD 11.4-7「拠点網ROI」)。 */
export interface OutpostNetworkView {
  readonly outpostCount: number;
  readonly totalSupplyApprox: number;
  readonly totalUpkeepApprox: number;
  readonly totalNetRevenueApprox: number;
  readonly totalExpectedRareLossApprox: number;
  readonly roiApprox: number | null;
}

/** ⑨の表示モデル一式(1 回の `outpostNetworkRoi` 呼び出しから両方を作る・§7)。 */
export interface OutpostOverviewView {
  readonly network: OutpostNetworkView;
  readonly roster: readonly OutpostRosterEntry[];
}

/**
 * [M32] ⑦の派遣候補一覧。`assist/exploration.ts` の `explorationTeamCandidates`
 * (死亡 / 派遣中 / **拠点常駐中** / 寿命なし住民の事前除外込み)をそのまま
 * 呼ぶ——候補列挙のロジックをここで書き直さない(M27 の既存実装と 2 通りの
 * 候補基準を作らないため)。
 *
 * [R8-01] 拠点常駐者の除外は engine 側(`rules/exploration.ts` の
 * `dispatchCandidates`)で行われる。ここへ `stationedOutpostIdByResident` を
 * 使った 2 つめのフィルタを足すと、engine の事前 reject と UI の候補基準が
 * 別々に育つので**足さない**。
 */
function buildExpeditionCandidates(
  state: GameState,
  content: EngineContent,
): readonly ExpeditionCandidateView[] {
  return explorationTeamCandidates(state).map((resident) => ({
    entityId: resident.id,
    combatPowerApprox: toApproxNumber(residentCombatPower(resident, content)),
    moraleApprox: toApproxNumber(resident.morale),
    traitIds: resident.traitIds,
  }));
}

/** [M32] 未帰還派遣一覧(`state.dispatchSnapshots` は既に派遣 ID 昇順)。 */
function buildExpeditionDispatches(state: GameState): readonly ExpeditionDispatchView[] {
  return state.dispatchSnapshots.map((snapshot) => ({
    dispatchId: snapshot.id,
    destinationId: snapshot.destinationId,
    band: snapshot.band,
    stance: snapshot.stance,
    memberIds: snapshot.memberIds,
    dispatchTick: snapshot.dispatchTick,
    returnTick: snapshot.returnTick,
    rewardResourceId: snapshot.rewardResourceId,
    rewardApprox: toApproxNumber(snapshot.rewardFix),
    withdrawn: snapshot.withdrawn,
    casualtyMemberIds: snapshot.casualtyMemberIds,
  }));
}

/**
 * GDD 8.1「派遣枠上限＝同時2枠」。**`src/engine/commands.ts` の
 * `CONCURRENT_DISPATCH_MAX` と同じ計算の意図的な複製**である
 * (`tests/engine/commands.test.ts`「検分: engine コマンドを呼ぶ ui ファイルは
 * store.ts だけ(単一入口)」が `derived.ts` からの `engine/commands` import を
 * 禁じているため、値だけを写す。§3-2 の `displayFacilityMaxLevel` と同じ
 * 立場の軽い重複であり、engine 側にネイティブ公開する形への一本化は将来の
 * タスクへ送る・最終報告の★参照)。
 */
const EXPEDITION_CONCURRENT_DISPATCH_MAX = 2;

function buildExpeditionSlots(state: GameState): ExpeditionSlotView {
  return { used: state.dispatchSnapshots.length, max: EXPEDITION_CONCURRENT_DISPATCH_MAX };
}

/**
 * [M32] 住民 memoir を 1 本の feed へ平坦化する。走査は `entitiesOfKind` の
 * 正準順(住民 ID 昇順)だが、表示は出来事の時系列(tick 昇順)にしたいので
 * 明示ソートを挟む(tick が同値なら住民 ID 昇順で決定論の全順序にする)。
 */
function buildMemoirFeed(state: GameState): readonly MemoirFeedEntry[] {
  const feed: MemoirFeedEntry[] = [];
  for (const resident of entitiesOfKind(state, "resident")) {
    for (const entry of resident.memoir?.entries ?? []) {
      feed.push({ residentId: resident.id, entry });
    }
  }
  feed.sort((a, b) => {
    if (a.entry.tick !== b.entry.tick) return a.entry.tick - b.entry.tick;
    return compareUtf16(a.residentId, b.residentId);
  });
  return feed;
}

/**
 * [M32] ⑨の表示モデル(GDD 9.2 / 11.4-7)。**`outpostNetworkRoi` を 1 回だけ
 * 呼び**、その `perOutpost`(= `allOutposts(state)` と同じ順序・
 * rules/outpost.ts §7 の doc)を使って拠点 1 基ぶんの内訳を作る——同じ ROI を
 * ここで再計算しない(§3 の規律をそのまま踏襲)。
 *
 * 拠点が 1 つも無い盤面(新規ゲームの既定)では `allOutposts` が空配列を返し、
 * `outpostNetworkRoi` は outpostType 定義の有無を検査せずに全フィールド
 * 0/null で返す(rules/outpost.ts の doc どおり)ので、content に拠点系
 * ブロックが無い盤面でもこの関数は安全に呼べる。
 */
function buildOutpostOverview(state: GameState, content: EngineContent): OutpostOverviewView {
  const report = outpostNetworkRoi(state, content, state.tick);
  const outposts = allOutposts(state);
  const roster: OutpostRosterEntry[] = [];
  for (let i = 0; i < outposts.length; i++) {
    const outpost = outposts[i];
    const perOutpost = report.perOutpost[i];
    if (outpost === undefined || perOutpost === undefined) continue;
    // content に定義が無い(理論上は起きない)状態で画面を落とさない
    // (§3 の bLossImminentTechIds / buildFacilityRoster と同じ防御的スキップ)。
    const resourceId =
      content.outpostTypeDefs?.get(outpost.outpostTypeId)?.resourceId ?? outpost.outpostTypeId;
    roster.push({
      outpostId: outpost.id,
      outpostTypeId: outpost.outpostTypeId,
      resourceId,
      band: outpost.band,
      level: outpost.level,
      residentIds: outpost.residentIds,
      establishedTick: outpost.establishedTick,
      supplyApprox: toApproxNumber(perOutpost.supplyValueFix),
      upkeepApprox: toApproxNumber(perOutpost.upkeepValueFix),
      netRevenueApprox: toApproxNumber(perOutpost.netRevenueFix),
      hazardApprox: toApproxNumber(perOutpost.hazardFix),
      rareAssetCount: perOutpost.rareAssetCount,
      expectedRareLossApprox: toApproxNumber(perOutpost.expectedRareLossFix),
      roiApprox: perOutpost.roiFix === null ? null : toApproxNumber(perOutpost.roiFix),
    });
  }
  return {
    network: {
      outpostCount: report.outpostCount,
      totalSupplyApprox: toApproxNumber(report.totalSupplyValueFix),
      totalUpkeepApprox: toApproxNumber(report.totalUpkeepValueFix),
      totalNetRevenueApprox: toApproxNumber(report.totalNetRevenueFix),
      totalExpectedRareLossApprox: toApproxNumber(report.totalExpectedRareLossFix),
      roiApprox: report.roiFix === null ? null : toApproxNumber(report.roiFix),
    },
    roster,
  };
}

/**
 * [M32] ⑦の目的地選択肢(GDD 8.1「目的地」= 距離帯 + M22 の event content)。
 * content にその距離帯へ出る event が無ければ空(= 画面側が手続き生成
 * フォールバックの 1 択を出す・ExpeditionScreen.tsx の doc)。
 */
export function explorationDestinationsForBand(
  content: EngineContent,
  band: DistanceBand,
): readonly EntityId[] {
  const ids: EntityId[] = [];
  for (const [defId, def] of content.eventDefs ?? []) {
    if (def.destTags.includes(band)) ids.push(defId);
  }
  return ids.sort(compareUtf16);
}

/**
 * [M32] ⑦の派遣前 ROI プレビュー(GDD 8.6・検収条件そのもの=(B)損失リスク項が
 * 画面に出ているか)。**`explorationRoi` をそのまま呼ぶ**(UI 独自の式を
 * 書かない)。content に exploration ブロックが無ければ null(= 派遣システム
 * そのものが不活性)。
 *
 * **[M73/R8-08] `options` を素通しする**。Phase D で engine 側に
 * `destinationId`/`stance` 指定の API が入っていたのに UI が渡していなかったため、
 * 近郊の 3 目的地で表示が 1 文字も変わらない(= 帯平均のまま)状態だった
 * (Round 8 実測)。方針(撤退重視/強行)も choices の選ばれ方を変えて難度と報酬を
 * 動かすので、画面で選んだ値をそのまま渡す。目的地に対応する event が content に
 * 無ければ engine 側が M21 の手続きモデルへフォールバックする(捏造はしない)。
 */
export function previewExplorationRoi(
  state: GameState,
  content: EngineContent,
  band: DistanceBand,
  memberIds: readonly EntityId[],
  options: ExplorationRoiOptions = {},
): ExplorationRoiReport | null {
  if (content.exploration === undefined) return null;
  return explorationRoi(state, content, band, memberIds, options);
}
