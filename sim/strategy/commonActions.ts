// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 5戦略bot 共有の判断部品 — M36
//
// 5戦略bot(貪欲/研究優先/探索優先/配置戦略違い/成文化優先)が組み合わせて使う
// 部品群。ここに集めた関数は engine の公開 API(commands の語彙・assist 3種・
// rules の derived 関数)だけを呼び、独自の判定式は持たない。各関数は
// **その時点の state から見た 1 手(または少数の手)を提案するだけ**で、
// state は一切変更しない(適用は呼び出し側 = sim/strategy/runStrategy.ts の
// `apply` 呼び出しに一本化する)。
//
// 「1 tick ぶんの決定をまとめて 1 つの state スナップショットから作る」ため、
// 同じ tick 内で複数の提案が同じ枠(施設スロット・派遣枠)を奪い合わないよう、
// 各 build* 関数は**ローカルな予約カウンタ**で競合を解消してから
// コマンド列を返す(state 自体は読むだけ)。
// ---------------------------------------------------------------------------

import {
  CONCURRENT_DISPATCH_MAX,
  activeDispatchCount,
  facilityBuildCostFix,
  facilityWorkerSlots,
  type AssignResidentCommand,
  type BeginCodificationCommand,
  type BeginResearchCommand,
  type DispatchExpeditionCommand,
  type PlaceFacilityCommand,
  type ReclaimCellCommand,
} from "../../src/engine/commands";
import { compareUtf16 } from "../../src/engine/canonicalize";
import { toRaw, FIX_ONE, type Fix } from "../../src/engine/fp";
import {
  findOccupancyConflict,
  footprintFitsGrid,
  isValidFootprintDims,
  occupiedCells,
  UNIT_FOOTPRINT,
} from "../../src/engine/footprint";
import {
  boardOutputScore,
  placementPlanToCommands,
  suggestPlacementsAvoidingRubble,
} from "../../src/engine/assist/placement";
import { codificationPlanToCommands, suggestCodification } from "../../src/engine/assist/codify";
import {
  explorationTeamCandidates,
  suggestExpeditionTeams,
  teamPlanToCommands,
  type TeamRequest,
} from "../../src/engine/assist/exploration";
import { currentCodification } from "../../src/engine/rules/codify";
import { nextReclaimCostFix } from "../../src/engine/rules/reclaim";
import { currentResearch } from "../../src/engine/rules/research";
import { resolveCapacityByResourceId } from "../../src/engine/rules/storage";
import { isTechUnlocked, researchEntityOfTech } from "../../src/engine/rules/techMemory";
import { isCriticalPathTech } from "../../src/engine/rules/techTree";
import { prereqsOfTech, type DistanceBand, type EngineContent } from "../../src/engine/rules/types";
import {
  entitiesOfKind,
  entityIdFromString,
  firstRubbleCellIn,
  isAliveResident,
  type DispatchStance,
  type EntityId,
  type FacilityState,
  type GameState,
  type ResidentState,
} from "../../src/engine/state/state";
import { GRID_CELL_COUNT } from "../../src/engine/adjacency";
import { recallGuardBlocks } from "./recallGuard";
import type { RecallGuardLogEntry } from "./types";

export { boardOutputScore };

/** `stem` + ID 先頭大文字化(`worldGen.ts` / `newGame.ts` と同型の採番規約)。 */
function capitalize(value: string): string {
  const head = value.charAt(0);
  return head.toUpperCase() + value.slice(1);
}

// --- 1. 住民の抽出 -----------------------------------------------------------

/** 生存・非派遣・無配属の住民(ID 昇順・`entitiesOfKind` の正準順のまま)。 */
export function livingIdleResidents(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const resident of entitiesOfKind(state, "resident")) {
    if (!isAliveResident(resident)) continue;
    if (resident.dispatched) continue;
    if (resident.assignedFacilityId !== null) continue;
    result.push(resident);
  }
  return result;
}

// --- 2. 就労スロットの空き(§ 配属) ------------------------------------------

interface OpenFacility {
  readonly facility: FacilityState;
  readonly defId: EntityId;
  readonly harsh: boolean;
  readonly openSlots: number;
  /** `policy.defPriority` の添字([M38] 均等配属の tie-break)。 */
  readonly priorityIndex: number;
}

/**
 * `defPriority` の順に、空きスロットがある施設インスタンスを列挙する
 * (返り値は定義優先順 → 同一定義内は entity ID の正準順)。
 */
function openFacilitiesByDefPriority(
  state: GameState,
  content: EngineContent,
  defPriority: readonly EntityId[],
): readonly OpenFacility[] {
  const result: OpenFacility[] = [];
  for (let i = 0; i < defPriority.length; i++) {
    const defId = defPriority[i];
    if (defId === undefined) continue;
    const def = content.facilityDefs.get(defId);
    if (def === undefined) continue;
    for (const facility of entitiesOfKind(state, "facility")) {
      if (facility.defId !== defId) continue;
      const slots = facilityWorkerSlots(def, facility.level);
      const openSlots =
        slots === undefined ? Number.POSITIVE_INFINITY : slots - facility.workerIds.length;
      if (openSlots <= 0) continue;
      result.push({ facility, defId, harsh: def.harshWork, openSlots, priorityIndex: i });
    }
  }
  return result;
}

/** 現在その定義の施設で働いている住民の総数(定義 ID 別)。 */
function workerCountByDefId(state: GameState): Map<EntityId, number> {
  const counts = new Map<EntityId, number>();
  for (const facility of entitiesOfKind(state, "facility")) {
    counts.set(facility.defId, (counts.get(facility.defId) ?? 0) + facility.workerIds.length);
  }
  return counts;
}

/** 住民配属の方針。`defPriority` は「まず埋めたい施設定義 ID」の優先順。 */
export interface AssignmentPolicy {
  readonly defPriority: readonly EntityId[];
}

export interface AssignmentResult {
  readonly commands: readonly AssignResidentCommand[];
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
}

/**
 * 無配属の住民を空きスロットへ割り当てる(GDD 11.5 のガード付き)。
 *
 * **[M38] 選び方 = 「その定義でいま働いている人数が最小の施設、同数なら
 * `defPriority` の先頭側、さらに同じなら entity ID の正準順」**。
 *
 * M36 実装は「`defPriority` の順に最初に空いている枠」だった。施設14種化
 * (M58)+ 開墾でインスタンス数が人口を大きく超える盤面になると、この規則は
 * **先頭の定義だけを埋め続け、後ろの定義へ 1 人も回らない**。しかも
 * 本関数は無配属の住民しか動かさない(配属替えをしない)ので、一度偏ると
 * 回復しない。実測(修正前・貪欲・30 ゲーム日): 住民 6 名が hearth×2 と
 * 資源系に張り付き、研究点産出施設が全て無人 = 研究レートが恒久的に 0 で
 * era 1 止まり。均等配属にすると 24 本完了・era 3 到達へ戻る。
 *
 * 過酷業務(`def.harshWork`)への割当は {@link recallGuardBlocks} を通す。ブロック
 * されたら**その施設定義**を諦め(1 住民 1 回だけログ)、次の候補を試す。
 * 同一 tick 内の枠の奪い合いはローカルな予約カウンタで解消する。
 */
export function buildAssignmentCommands(
  state: GameState,
  content: EngineContent,
  policy: AssignmentPolicy,
  tick: number,
  botId: string,
): AssignmentResult {
  const idle = livingIdleResidents(state);
  if (idle.length === 0) return { commands: [], recallGuardLog: [] };

  const openFacilities = openFacilitiesByDefPriority(state, content, policy.defPriority);
  const workersByDefId = workerCountByDefId(state);
  const reserved = new Map<EntityId, number>();
  const commands: AssignResidentCommand[] = [];
  const recallGuardLog: RecallGuardLogEntry[] = [];

  for (const resident of idle) {
    const blockedHarshDefIds = new Set<EntityId>();
    let loggedForResident = false;
    // 均等配属の全順序(定義の現就労者数 → 優先順 → 列挙順)。同一キーは無い。
    const ordered = [...openFacilities].sort(
      (l, r) =>
        (workersByDefId.get(l.defId) ?? 0) - (workersByDefId.get(r.defId) ?? 0) ||
        l.priorityIndex - r.priorityIndex,
    );

    for (const open of ordered) {
      if (blockedHarshDefIds.has(open.defId)) continue;
      const already = reserved.get(open.facility.id) ?? 0;
      if (already >= open.openSlots) continue;

      if (open.harsh) {
        const check = recallGuardBlocks(state, content, resident, "harshAssignment", tick, botId);
        if (check.blocked) {
          blockedHarshDefIds.add(open.defId);
          if (check.logEntry !== null && !loggedForResident) {
            recallGuardLog.push(check.logEntry);
            loggedForResident = true;
          }
          continue;
        }
      }

      reserved.set(open.facility.id, already + 1);
      workersByDefId.set(open.defId, (workersByDefId.get(open.defId) ?? 0) + 1);
      commands.push({
        kind: "assignResident",
        residentId: resident.id,
        facilityId: open.facility.id,
      });
      break;
    }
  }

  return { commands, recallGuardLog };
}

// --- 3. 建設(配置) ----------------------------------------------------------

function nextFacilityEntityId(state: GameState, defId: EntityId): EntityId {
  for (let n = 1; ; n++) {
    const candidate = entityIdFromString(`fac${capitalize(defId)}${String(n)}`);
    if (!state.entityStateById.has(candidate)) return candidate;
  }
}

function resourceStockRaw(state: GameState, resourceId: EntityId): number {
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === resourceId) return toRaw(resource.stock);
  }
  return 0;
}

function canAffordBuild(
  state: GameState,
  def: { readonly cost?: { readonly resourceId: EntityId } },
  costFix: Fix | undefined,
): boolean {
  if (costFix === undefined) return true;
  const resourceId = def.cost?.resourceId;
  if (resourceId === undefined) return true;
  return resourceStockRaw(state, resourceId) >= toRaw(costFix);
}

/** M26 アシストを使わない素朴な配置(§「配置戦略違い」bot 用)。セル番号昇順の first-fit。 */
function naivePlacementCell(
  state: GameState,
  footprint: { readonly width: number; readonly height: number },
): number | null {
  for (let anchor = 0; anchor < GRID_CELL_COUNT; anchor++) {
    if (!footprintFitsGrid(anchor, footprint)) continue;
    const cells = occupiedCells(anchor, footprint);
    if (firstRubbleCellIn(state, cells) !== null) continue;
    if (findOccupancyConflict(state, cells) !== null) continue;
    return anchor;
  }
  return null;
}

/** 建設の方針。`placement` が bot ごとの差(GDD 11.4-1 の「配置戦略違い」)。 */
export interface BuildPolicy {
  /**
   * 建設候補の定義 ID(優先順)。**[M38] 施設14種すべてを載せること**を前提に
   * した順序である(M36 実装時は `hearth`/`workbench`/`forge` の 3 種しか
   * 載っておらず、M58 で追加された 11 種を bot が一度も建てられなかった —
   * 台帳v11 追-8 の申し送り)。
   */
  readonly defPriority: readonly EntityId[];
  readonly placement: "assist" | "naive";
}

/** 現在建っている施設を定義 ID 別に数える([M38] 建設候補の多様化に使う)。 */
export function facilityCountByDefId(state: GameState): ReadonlyMap<EntityId, number> {
  const counts = new Map<EntityId, number>();
  for (const facility of entitiesOfKind(state, "facility")) {
    counts.set(facility.defId, (counts.get(facility.defId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 新規施設を 1 基だけ提案する(この tick で建てすぎない)。
 *
 * **[M38] 選び方 = 「建設可能な候補のうち現基数が最小のもの、同数なら
 * `defPriority` の先頭側」**。M36 実装は `defPriority` の先頭から最初に成立した
 * ものを返していたため、先頭の定義(貪欲なら `hearth`)が資源的に常に建てられる
 * 限り**その 1 種だけを建て続け**、M58 で追加された施設が実 run に一度も現れ
 * なかった(実測: 30 ゲーム日 run で hearth×11 + workbench×1)。現基数の最小を
 * 選ぶ規則にすると、`defPriority` の順序は「同数のときどれを先に建てるか」
 * = 序盤の建設順という bot の戦略差として残りつつ、盤面は 14 種へ広がる。
 *
 * `placement: "assist"` は M26 推奨配置(`suggestPlacementsAvoidingRubble`)を
 * **qualityRatioFix = 1.0**(素の貪欲・M26 §3 の退化条件)で呼ぶ ——
 * 「配置戦略違い」bot(`"naive"`)との比較を成立させるため、既定の 80/100
 * スロットル(0.65)ではなく常に「その手で到達しうる最大増分」を狙う。
 * `"naive"` はセル番号昇順の first-fit(隣接を一切考慮しない、engine の
 * footprint/occupancy の生の検査だけを使う)。素の貪欲は全候補の中から
 * 最大増分を選ぶので、同じ候補集合の中の 1 点でしかない naive の結果**以上**
 * にしかならない(`boardOutputScore` の不等式が構造的に保証される)。
 */
export function buildFacilityCommand(
  state: GameState,
  content: EngineContent,
  policy: BuildPolicy,
): PlaceFacilityCommand | undefined {
  const counts = facilityCountByDefId(state);

  interface Candidate {
    readonly defId: EntityId;
    readonly footprint: { readonly width: number; readonly height: number };
    readonly count: number;
    readonly priorityIndex: number;
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < policy.defPriority.length; i++) {
    const defId = policy.defPriority[i];
    if (defId === undefined) continue;
    const def = content.facilityDefs.get(defId);
    if (def === undefined) continue;
    if (!canAffordBuild(state, def, facilityBuildCostFix(def))) continue;
    const footprint = def.footprint ?? UNIT_FOOTPRINT;
    if (!isValidFootprintDims(footprint)) continue;
    candidates.push({ defId, footprint, count: counts.get(defId) ?? 0, priorityIndex: i });
  }
  // (現基数 昇順, 優先順 昇順)の全順序。同一キーは存在しない(priorityIndex が一意)。
  candidates.sort((l, r) => l.count - r.count || l.priorityIndex - r.priorityIndex);

  for (const candidate of candidates) {
    const facilityId = nextFacilityEntityId(state, candidate.defId);
    if (policy.placement === "assist") {
      const plan = suggestPlacementsAvoidingRubble(
        state,
        content,
        [{ facilityId, defId: candidate.defId }],
        { qualityRatioFix: FIX_ONE },
      );
      const command = placementPlanToCommands(plan)[0];
      if (command === undefined) continue;
      return command;
    }
    const cellIndex = naivePlacementCell(state, candidate.footprint);
    if (cellIndex === null) continue;
    return { kind: "placeFacility", facilityId, defId: candidate.defId, cellIndex };
  }
  return undefined;
}

// --- 3a. 倉庫建設(GDD 6.7 の正規あふれ対策・[Phase A]) ----------------------
//
// [2026-08-06裁定・台帳v20 必-3(1)] 全 15 run(旧5戦略bot×3seed)で倉庫
// (warehouse)を建てた bot が 0 だった構造要因の分析(台帳v20)を受けて追加する。
//
// `buildFacilityCommand` の「現基数最小 → defPriority 優先順」という一般規則
// だけに任せると、warehouse は `ALL_FACILITY_DEF_IDS` の中では中位の優先度
// (bots.ts の各 bot 定義を参照)にしか置かれておらず、その「順番」が回ってくる
// 頃には盤面の空きセルが 2×2(warehouse の footprint)を取れないほど埋まって
// いることが多い(初期の空き 12 セルは他の 1×1 施設に先に使われる)。
// 「あふれの接近を検知したら建てる」という**需要駆動**のトリガをここに独立させ、
// 通常の建設候補選定より**優先して**倉庫を提案することで、この構造的な後回しを
// 断ち切る(GDD 6.7 が想定する「あふれたら倉庫を建てる」プレイヤー行動の最小形)。
//
// 判断材料は `resolveCapacityByResourceId`(rules/storage.ts の公開 API)と
// 現在の資源在庫だけであり、bot が既に見ている決定論的な state 以外は使わない。

/**
 * 保管上限つきの資源のうち、在庫が上限の {@link WAREHOUSE_TRIGGER_RATIO_NUM}/
 * {@link WAREHOUSE_TRIGGER_RATIO_DEN}(既定 60%)以上に達しているものが
 * 1 つでもあるか。整数比較(`toRaw` の raw 値同士)で判定し、浮動小数の丸め差を
 * 結果に持ち込まない。
 *
 * **60% は実測比較で選んだ値**(Phase A stage1)。30% まで下げても
 * 11.4-7c(オーバーフロー損失率)の全 run 最大値は 1 bit も変わらない
 * (最大値を出しているのは explorationFirst で、この bot は在庫が上限に
 * 張り付く(比率 1.0)日が何日も続くほど溢れているため、閾値をどれだけ下げても
 * 検知タイミングは変わらない — ボトルネックは検知の鈍さではなく盤面上に
 * 倉庫の footprint(2×2)を置ける空きが 1 基ぶんしか無いこと)。それでいて
 * 閾値を下げると他 4 戦略でも「あと 1 段の余裕がある日」に前倒しで倉庫を
 * 建ててしまい、その 1 tick 分の建設順序ずれが `gdd-11.4-3-era3-upper`
 * (E3 到達 <= 18 日)を 1 run 押し出して新規 fail を作る実測結果になった
 * (30% 閾値: greedy/nightly-c が 19 日)。的が外れている資源を投じて新しい
 * fail を作らないため 60% に留める。Phase A のヒューリスティック定数であり、
 * content/balance.json の数値ではない。上限が 1 つも無い盤面では常に false。
 */
const WAREHOUSE_TRIGGER_RATIO_NUM = 3;
const WAREHOUSE_TRIGGER_RATIO_DEN = 5;

export function anyResourceNearingCapacity(state: GameState, content: EngineContent): boolean {
  const capacities = resolveCapacityByResourceId(state, content);
  if (capacities.size === 0) return false;
  for (const resource of entitiesOfKind(state, "resource")) {
    const capacityFix = capacities.get(resource.resourceId);
    if (capacityFix === undefined) continue;
    const capacityRaw = toRaw(capacityFix);
    if (capacityRaw <= 0) continue;
    const stockRaw = toRaw(resource.stock);
    if (stockRaw * WAREHOUSE_TRIGGER_RATIO_DEN >= capacityRaw * WAREHOUSE_TRIGGER_RATIO_NUM) {
      return true;
    }
  }
  return false;
}

/**
 * 保管上限のあふれ(またはその接近)を検知したときだけ、倉庫(warehouse)を
 * 1 基提案する([Phase A])。`warehouseDefId` は呼び出し側(bots.ts)が持つ
 * 施設 ID を渡してもらう(commonActions.ts は特定の施設 ID を知らない、という
 * 既存の設計を踏襲する)。
 *
 * 建設ロジック自体は `buildFacilityCommand` と同じ部品(`canAffordBuild` /
 * `suggestPlacementsAvoidingRubble` を `qualityRatioFix = 1.0` で呼ぶ)を使う —
 * 「配置戦略違い」bot との比較(§3 冒頭の doc)を壊さないため。
 */
export function buildWarehouseCommand(
  state: GameState,
  content: EngineContent,
  warehouseDefId: EntityId,
): PlaceFacilityCommand | undefined {
  if (!anyResourceNearingCapacity(state, content)) return undefined;

  const def = content.facilityDefs.get(warehouseDefId);
  if (def === undefined) return undefined;
  if (!canAffordBuild(state, def, facilityBuildCostFix(def))) return undefined;
  const footprint = def.footprint ?? UNIT_FOOTPRINT;
  if (!isValidFootprintDims(footprint)) return undefined;

  const facilityId = nextFacilityEntityId(state, warehouseDefId);
  const plan = suggestPlacementsAvoidingRubble(
    state,
    content,
    [{ facilityId, defId: warehouseDefId }],
    { qualityRatioFix: FIX_ONE },
  );
  return placementPlanToCommands(plan)[0];
}

// --- 3b. 開墾(GDD 9.1・[M38]) -----------------------------------------------

/**
 * 1×1 が置ける空きセルの数(瓦礫でも占有済みでもないセル)。
 * `naivePlacementCell` と同じ engine 検査(footprint/occupancy/rubble)を使う。
 */
export function freeUnitCellCount(state: GameState): number {
  let count = 0;
  for (let cell = 0; cell < GRID_CELL_COUNT; cell++) {
    const cells = occupiedCells(cell, UNIT_FOOTPRINT);
    if (firstRubbleCellIn(state, cells) !== null) continue;
    if (findOccupancyConflict(state, cells) !== null) continue;
    count++;
  }
  return count;
}

/**
 * 空きセルが `minFreeCells` を下回っていて、かつ開墾コストを払えるなら
 * **セル番号が最小の瓦礫 1 枚**を開墾する提案を返す([M38])。
 *
 * M36 の bot は開墾を一度も行わなかったため、`content/balance.json` の
 * `initialRubbleCells`(セル 12〜47 が瓦礫)により盤面が**12 セット固定**で、
 * 施設 14 種を建て分ける余地が構造的に無かった。開墾を入れて初めて
 * 「14 種を建てた盤面」が実 run に出る。
 */
export function buildReclaimCommand(
  state: GameState,
  content: EngineContent,
  minFreeCells: number,
): ReclaimCellCommand | undefined {
  if (minFreeCells <= 0) return undefined;
  if (content.reclaim === undefined) return undefined;
  if (freeUnitCellCount(state) >= minFreeCells) return undefined;
  const cell = state.terrain.rubbleCells[0];
  if (cell === undefined) return undefined;
  const costFix = nextReclaimCostFix(state, content);
  if (resourceStockRaw(state, content.reclaim.costResourceId) < toRaw(costFix)) return undefined;
  return { kind: "reclaimCell", cellIndex: cell };
}

// --- 4. 研究(GDD 5) ---------------------------------------------------------

/**
 * まだ research entity が無く、直接前提が全て解禁済みの tech(techId 昇順)。
 * `beginResearch` で新しく entity を作れる候補そのもの。
 */
export function reachableUnstartedTechIds(
  state: GameState,
  content: EngineContent,
): readonly EntityId[] {
  const result: EntityId[] = [];
  const ids = [...content.techDefs.keys()].sort(compareUtf16);
  for (const techId of ids) {
    if (researchEntityOfTech(state, techId) !== undefined) continue;
    let prereqsMet = true;
    for (const prereqId of prereqsOfTech(content, techId)) {
      if (!isTechUnlocked(state, prereqId)) {
        prereqsMet = false;
        break;
      }
    }
    if (prereqsMet) result.push(techId);
  }
  return result;
}

/**
 * 次に着手する tech を選ぶ(呼ばない = 何もしないという判断も含む)。
 *
 * `preferCriticalPath` = true(研究優先bot)は、まだ着手していない**クリティカル
 * パス上**の tech(GDD 5.1)があれば ID 昇順の最初の 1 本を**即座に**返す
 * (`beginResearch` は既存の進行中研究があっても選択を上書きするので、これは
 * 分岐 tech からクリティカルパスへの割り込みになる)。クリティカルパス上に
 * 新規候補が無ければ、他 bot と同じ「何も進行していない ときだけ ID 昇順の
 * 最初の 1 本」という穴埋めへ落ちる(GDD 5.1 に無い分岐も枯らさない)。
 */
export function pickResearchTarget(
  state: GameState,
  content: EngineContent,
  preferCriticalPath: boolean,
): EntityId | undefined {
  const reachable = reachableUnstartedTechIds(state, content);
  if (preferCriticalPath) {
    for (const techId of reachable) {
      if (isCriticalPathTech(content, techId)) return techId;
    }
  }
  if (currentResearch(state) === undefined) return reachable[0];
  return undefined;
}

/** `beginResearch` コマンドを組み立てる(researchId は techId から決定論的に導出)。 */
export function researchCommand(techId: EntityId): BeginResearchCommand {
  return { kind: "beginResearch", researchId: entityIdFromString(`research${techId}`), techId };
}

// --- 5. 成文化(GDD 6.2 / M27 アシスト) --------------------------------------

/**
 * 成文化を 1 件だけ着手する(単一キュー・M27 §2「一度に1件ずつ前提」)。
 * 既に作業中の記録があれば何もしない(undefined)。
 */
export function codifyCommand(
  state: GameState,
  content: EngineContent,
  atTick: number,
): BeginCodificationCommand | undefined {
  if (currentCodification(state) !== undefined) return undefined;
  const plan = suggestCodification(state, content, atTick);
  return codificationPlanToCommands(plan)[0];
}

// --- 6. 探索派遣(GDD 8.1 / M27 アシスト) ------------------------------------

/** `content.eventDefs` のうち、その距離帯に出る ID 昇順で最初の 1 件。 */
export function firstEventIdForBand(
  content: EngineContent,
  band: DistanceBand,
): EntityId | undefined {
  const eventDefs = content.eventDefs;
  if (eventDefs === undefined) return undefined;
  const ids = [...eventDefs.keys()].sort(compareUtf16);
  for (const id of ids) {
    if (eventDefs.get(id)?.destTags.includes(band) === true) return id;
  }
  return undefined;
}

function nextDispatchEntityId(state: GameState, salt: number): EntityId {
  for (let n = salt; ; n++) {
    const candidate = entityIdFromString(`dispatch${String(state.tick)}n${String(n)}`);
    if (isDispatchIdFree(state, candidate)) return candidate;
  }
}

function isDispatchIdFree(state: GameState, id: EntityId): boolean {
  if (state.entityStateById.has(id)) return false;
  for (const snapshot of state.dispatchSnapshots) {
    if (snapshot.id === id) return false;
  }
  return true;
}

/** 探索派遣の方針。`bands` は空きスロット分だけ順に(巡回で)使う。 */
export interface DispatchPolicy {
  readonly bands: readonly DistanceBand[];
  readonly teamSize: number;
  readonly maxNewDispatchesPerTick: number;
  /** 派遣後になおプールに残しておきたい最低人数(施設労働力の温存)。 */
  readonly minIdlePoolSlack: number;
  /** 撤退 / 強行の方針(GDD 8.3)。 */
  readonly stance: DispatchStance;
}

export interface DispatchResult {
  readonly commands: readonly DispatchExpeditionCommand[];
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
}

/**
 * 探索チームを提案する(GDD 11.5 のガード付き)。ガードでブロックされた住民は
 * `suggestExpeditionTeams` の候補プールから除外する(= 派遣しない。GDD 11.5
 * 「派遣に回さない」の実装そのもの)。
 */
export function buildDispatchCommands(
  state: GameState,
  content: EngineContent,
  tick: number,
  policy: DispatchPolicy,
  botId: string,
): DispatchResult {
  if (content.exploration === undefined || policy.bands.length === 0) {
    return { commands: [], recallGuardLog: [] };
  }
  const availableSlots = Math.min(
    CONCURRENT_DISPATCH_MAX - activeDispatchCount(state),
    policy.maxNewDispatchesPerTick,
  );
  if (availableSlots <= 0) return { commands: [], recallGuardLog: [] };

  const recallGuardLog: RecallGuardLogEntry[] = [];
  const excludeResidentIds: EntityId[] = [];
  const candidates = explorationTeamCandidates(state);
  for (const resident of candidates) {
    const check = recallGuardBlocks(state, content, resident, "dispatch", tick, botId);
    if (check.blocked) {
      excludeResidentIds.push(resident.id);
      if (check.logEntry !== null) recallGuardLog.push(check.logEntry);
    }
  }

  const poolSize = candidates.length - excludeResidentIds.length;
  if (poolSize < policy.teamSize * availableSlots + policy.minIdlePoolSlack) {
    return { commands: [], recallGuardLog };
  }

  const requests: TeamRequest[] = [];
  for (let i = 0; i < availableSlots; i++) {
    const band = policy.bands[i % policy.bands.length];
    if (band === undefined) continue;
    const destinationId = firstEventIdForBand(content, band);
    if (destinationId === undefined) continue;
    requests.push({
      dispatchId: nextDispatchEntityId(state, i),
      destinationId,
      band,
      stance: policy.stance,
      teamSize: policy.teamSize,
    });
  }
  if (requests.length === 0) return { commands: [], recallGuardLog };

  const plan = suggestExpeditionTeams(state, content, requests, { excludeResidentIds });
  return { commands: teamPlanToCommands(plan), recallGuardLog };
}
