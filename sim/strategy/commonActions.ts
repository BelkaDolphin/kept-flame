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
  facilityBuildCostLines,
  facilityWorkerSlots,
  type AssignResidentCommand,
  type BeginCodificationCommand,
  type BeginResearchCommand,
  type DispatchExpeditionCommand,
  type PlaceFacilityCommand,
  type ReclaimCellCommand,
} from "../../src/engine/commands";
import { compareUtf16 } from "../../src/engine/canonicalize";
import { toRaw, FIX_ONE } from "../../src/engine/fp";
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
import { populationViewOf } from "../../src/engine/rules/population";
import { nextReclaimCostFix } from "../../src/engine/rules/reclaim";
import { currentResearch } from "../../src/engine/rules/research";
import { resolveCapacityByResourceId } from "../../src/engine/rules/storage";
import { isTechUnlocked, researchEntityOfTech } from "../../src/engine/rules/techMemory";
import { isCriticalPathTech } from "../../src/engine/rules/techTree";
import {
  prereqsOfTech,
  type DistanceBand,
  type EngineContent,
  type FacilityDef,
} from "../../src/engine/rules/types";
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
import { setField } from "../../src/engine/state/update";
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

/**
 * 現在その定義の施設で働いている住民の総数(定義 ID 別)。[Phase A] §4b の
 * 実地要件充足判定(まだ誰も働いていない施設を見つける)にも使うため export する。
 */
export function workerCountByDefId(state: GameState): Map<EntityId, number> {
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
  reservedResidentIds: ReadonlySet<EntityId> = new Set(),
): AssignmentResult {
  const idle = livingIdleResidents(state).filter(
    (resident) => !reservedResidentIds.has(resident.id),
  );
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

/**
 * [M65] 建設コストの全行(複数資源)に対して在庫が足りるか。
 *
 * M65 以前は「主資源 1 行」しか見ておらず、`buildCost` が複数資源になった
 * 段(engine の `payFacilityCost`)と食い違うと **bot が払えない建設を提案し
 * 続けて他の候補も建たない**(候補は `canAffordBuild` で絞られるため)。
 * 計測器の述語を engine の判定と一致させるための追従であり、bot の戦略
 * (何をどの順で建てるか)は 1 mm も変えていない。
 */
function canAffordBuild(state: GameState, def: FacilityDef): boolean {
  for (const line of facilityBuildCostLines(def)) {
    if (resourceStockRaw(state, line.resourceId) < toRaw(line.costFix)) return false;
  }
  return true;
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

/**
 * [Phase D] その施設定義を**いま盤面のどこかに置けるか**(費用は見ない・幾何だけ)。
 *
 * 実地要件が要求する forge は 2×1 なので、空きセルが 2 枚あっても**横に隣接
 * していなければ置けない**。開墾のしきい値(`reclaimMinFreeCells` = 3)は
 * 「1×1 が置ける空きセルの枚数」しか見ないため、この状態では開墾も走らず
 * 建設も通らないまま何日も止まる(実測 explorationFirst/nightly-b: 実地要件で
 * 詰まった day 27 から forge が建つ day 35 まで 8 日間)。呼び出し側はこの
 * 述語が false のときだけ、しきい値を無視して開墾を 1 枚走らせる。
 */
export function canPlaceFacilityDef(
  state: GameState,
  content: EngineContent,
  defId: EntityId,
): boolean {
  const def = content.facilityDefs.get(defId);
  if (def === undefined) return false;
  const footprint = def.footprint ?? UNIT_FOOTPRINT;
  if (!isValidFootprintDims(footprint)) return false;
  return naivePlacementCell(state, footprint) !== null;
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
    if (!canAffordBuild(state, def)) continue;
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
  if (!canAffordBuild(state, def)) return undefined;
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

// --- 3a2. 寝床建設(GDD 7.7 の晴天漂着を詰まらせない・[Phase D]) -------------
//
// [Phase D] 5戦略bot は寝床(bed)を `ALL_FACILITY_DEF_IDS` の一般順でしか
// 建てないため、実 run の多くが**寝床上限ちょうどで人口が頭打ち**になる
// (実測: codifyFirst/nightly-a は寝床 2 基 = 上限 6 人に人口 6 人で 40 日間
// 張り付き、施設 11 種・26 基に対して就労者が 6 人しか居ない盤面になる)。
// GDD 7.7 の晴天漂着は「寝床上限内」でしか起きないので、寝床を建てない限り
// 住民は 1 人も増えない —— つまりこの頭打ちは**盤面の物理的制約ではなく
// bot が寝床を建てないという計測器側の欠落**である。
//
// この欠落が M67(実地要件)と噛み合うと恒久停止になる: 施設数 > 住民数の
// 盤面では均等配属が全員を先に埋めてしまい、あとから建った forge が
// 最後まで無人 → `techSmelting` の実地要件が永久に満たされず E3 未到達
// (`gdd-11.4-3-era3-reached` の残り 1 run の真因)。
//
// よって倉庫(§3a)とまったく同じ「需要駆動 + 通常の建設候補選定より優先」の
// 形で、**人口が寝床上限に達していたら寝床を 1 基**提案する。
// 判断材料は `populationViewOf`(engine の公開 API)だけで、bot 固有の推定を
// 持ち込まない。寝床が 1 基も建っていない盤面(= 上限 0)でも提案する
// (`populationViewOf` の `bedCapacity < 1` では漂着経路そのものが閉じる)。

/**
 * 寝床を建てる価値があるか([Phase D]・§3a2)。3 条件の連言:
 *
 *   (1) `living >= bedCapacity`(= `rules/population.ts` の加入ゲートと同じ
 *       不等式。晴天漂着が寝床で止まっている)
 *   (2) 無配属の住民が 1 人も居ない(= 今居る人手は使い切っている)
 *   (3) 就労枠の空いた施設インスタンスがまだある(= 人を増やせば働き口がある)
 *
 * (2)(3) は「寝床を建て続けて盤面を食い潰す」退化を防ぐための条件である。
 * (2) が無いと、探索で保護加入が毎日湧く探索優先 bot は保護加入が寝床上限を
 * 無視する(GDD 8.1④)ぶん `living >= bedCapacity` が恒常的に真になり、
 * **毎日寝床を建て続けて盤面を埋め、forge(2×1)を 1 基も置けなくなる**
 * (実測: explorationFirst/nightly-c が寝床 7 基・空きセル 0 で E3 未到達)。
 */
export function shouldBuildBed(state: GameState, content: EngineContent): boolean {
  const view = populationViewOf(state, content);
  if (view.living < view.bedCapacity) return false;
  if (livingIdleResidents(state).length > 0) return false;
  return hasOpenWorkerSlot(state, content);
}

/** 就労枠に空きのある施設インスタンスが 1 つでもあるか({@link shouldBuildBed} (3))。 */
function hasOpenWorkerSlot(state: GameState, content: EngineContent): boolean {
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined) continue;
    const slots = facilityWorkerSlots(def, facility.level);
    if (slots === undefined || slots > facility.workerIds.length) return true;
  }
  return false;
}

/**
 * 人口が寝床上限で頭打ちのときだけ寝床を 1 基提案する([Phase D]・§3a2)。
 * 建設ロジックの部品は {@link buildWarehouseCommand} と同一(配置は
 * `qualityRatioFix = 1.0` の推奨配置)。
 */
export function buildBedCommand(
  state: GameState,
  content: EngineContent,
  bedDefId: EntityId,
): PlaceFacilityCommand | undefined {
  if (!shouldBuildBed(state, content)) return undefined;

  const def = content.facilityDefs.get(bedDefId);
  if (def === undefined) return undefined;
  if (!canAffordBuild(state, def)) return undefined;
  const footprint = def.footprint ?? UNIT_FOOTPRINT;
  if (!isValidFootprintDims(footprint)) return undefined;

  const facilityId = nextFacilityEntityId(state, bedDefId);
  const plan = suggestPlacementsAvoidingRubble(state, content, [{ facilityId, defId: bedDefId }], {
    qualityRatioFix: FIX_ONE,
  });
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

/**
 * [Phase D] `defId` の施設を**置けるようにする**瓦礫を 1 枚だけ開墾する提案
 * (置けるようになる瓦礫が無ければ {@link buildReclaimCommand} の既定
 * =「セル番号最小の瓦礫」へ落ちる)。
 *
 * セル番号最小から順に開墾する既定の規則は、2×1 の forge のように**横に
 * 隣接した 2 枚**を要求する施設に対して極端に効率が悪い(実測 explorationFirst:
 * 開墾費が上限 300 に張り付いた状態で 1 枚/2 日しか開けられず、開いた枠は
 * どれも単独 = forge が置けないまま 8 日以上停滞した)。
 * 「1 枚開墾したら置けるか」を engine の配置検査そのもの
 * ({@link canPlaceFacilityDef})で試すだけなので、bot 側に独自の幾何判定を
 * 持ち込まない。
 */
export function buildReclaimCommandForFacility(
  state: GameState,
  content: EngineContent,
  defId: EntityId,
): ReclaimCellCommand | undefined {
  if (content.reclaim === undefined) return undefined;
  const costFix = nextReclaimCostFix(state, content);
  if (resourceStockRaw(state, content.reclaim.costResourceId) < toRaw(costFix)) return undefined;
  for (const cell of state.terrain.rubbleCells) {
    if (canPlaceFacilityDef(withoutRubbleCell(state, cell), content, defId)) {
      return { kind: "reclaimCell", cellIndex: cell };
    }
  }
  const fallback = state.terrain.rubbleCells[0];
  return fallback === undefined ? undefined : { kind: "reclaimCell", cellIndex: fallback };
}

/**
 * 「そのセルの瓦礫だけを取り除いた」仮想 state({@link buildReclaimCommandForFacility}
 * の試行用 / 同一 tick に開墾と建設を両方積むときの建設側の入力)。
 *
 * 実際の開墾コマンドは engine 側で費用も `reclaimedCount` も動かすが、ここで
 * 見たいのは**配置検査に使う占有情報だけ**なので地形以外は触らない
 * (bot の判断は決定論的な読み取りのみ)。費用まで写さないので、開墾で在庫が
 * 減って建設が払えなくなる tick では建設コマンドが engine 側で reject される
 * ——これは runStrategy.ts §1 が明示する「bot は『今はできない』提案を出す
 * ことがあり、それはプレイヤー操作の失敗と同じ扱い」の範囲。
 */
export function stateWithCellReclaimed(state: GameState, cell: number): GameState {
  return withoutRubbleCell(state, cell);
}

function withoutRubbleCell(state: GameState, cell: number): GameState {
  return setField(state, "terrain", {
    ...state.terrain,
    rubbleCells: state.terrain.rubbleCells.filter((c) => c !== cell),
  });
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

/**
 * その tick に着手する研究を**複数本**選ぶ([Phase A]・台帳v20 必-3(2))。
 *
 * `pickResearchTarget`(単数形)は 1 日 1 回の意思決定につき `beginResearch` を
 * 高々 1 回しか呼ばないため、bot の E3 到達日が「実際の研究点の供給」ではなく
 * 「1 日 1 本の意思決定 cadence」でほぼ決まってしまっていた
 * (`docs/measurements/summary.md` の ERA3_REACH_DAYS 改訂の経緯・nightlyGate.ts
 * `ERA3_REACH_DAYS_MIN/MAX` の doc を参照)。
 *
 * `beginResearch` は「まだ research entity の無い tech」に対しては新規作成 +
 * 選択、「既にある tech」に対しては選択し直すだけ(§2 `applyBeginResearch`)なので、
 * **同一 tick で複数回呼んでも研究点が分裂することはない**(常に最後に呼んだ
 * 対象だけが `currentResearch` になる・`rules/research.ts` §2)。この性質を使い、
 * 「まだ着手していない reachable tech を**全て**その日のうちに entity 化して
 * バックログへ積む」ことと「実際に研究点を受け取る対象は従来どおり 1 本」の
 * 両立を図る:
 *
 *   1. 従来の `pickResearchTarget` と**同じ規則**で「今日の主対象」を決める
 *      (preferCriticalPath なら reachable な CP tech、無ければ何も進行して
 *      いないときだけ reachable[0])。
 *   2. reachable な残り全部を先に `beginResearch` してから、主対象(または
 *      主対象が無いなら現在進行中の研究)を**最後に**呼び直して選択を戻す。
 *
 * こうして積んだバックログは、主対象が完了して選択が失効した瞬間に
 * `currentResearch` のフォールバック(entity ID 昇順で最初の未完了)が自動で
 * 次を拾う(`rules/research.ts` §2 の (2))。よって主対象が 1 日の途中で完了
 * すれば、**次の bot 意思決定を待たずに同日中へ別の tech が着手される** ——
 * これが「研究点が許す限り同日に複数の研究を開始/キューできる」の実体。
 *
 * 戻り値は `beginResearch` を呼ぶ順(= 適用順)の tech ID 配列。最後の要素が
 * その tick の選択勝者になる。
 */
export function pickResearchTargets(
  state: GameState,
  content: EngineContent,
  preferCriticalPath: boolean,
): readonly EntityId[] {
  const reachable = reachableUnstartedTechIds(state, content);
  if (reachable.length === 0) return [];

  const primary = pickResearchTarget(state, content, preferCriticalPath);
  if (primary !== undefined) {
    return [...reachable.filter((techId) => techId !== primary), primary];
  }

  // 主対象なし = 割り込まない(preferCriticalPath でない、または CP 候補が
  // 無く、かつ既に何か進行中)。バックログだけ積み、選択は現在の研究へ戻す。
  const current = currentResearch(state);
  if (current === undefined) return reachable;
  return [...reachable, current.techId];
}

/** `beginResearch` コマンドを組み立てる(researchId は techId から決定論的に導出)。 */
export function researchCommand(techId: EntityId): BeginResearchCommand {
  return { kind: "beginResearch", researchId: entityIdFromString(`research${techId}`), techId };
}

// --- 4b. 実地要件施設の先回り充足([Phase A]・GDD 5 / 12.1 `fieldRequirement`) --
//
// [2026-08-06裁定・台帳v20 必-5] tech 全 24 本に `fieldRequirement`(該当施設で
// 該当レシピを N 回稼働・GDD 5)が定義済みだが、engine 側は count のみが将来
// 実効化される予定でまだ実装していない(M67・台帳v20 の「M67 の地雷」)。
// このタスクの時点で研究は一切ゲートされないため、以下の 2 関数は**今回の
// nightly gate の数値には影響しない**(fieldRequirement を読むだけで、まだ
// 何も強制しない)。狙いは M67 が実効化した瞬間に explorationFirst のような
// 「過酷業務(forge)を回避する」bot が永久停止しないよう、**研究予定 tech が
// 要求する施設を先回りで建設・配属しておく**能力を今のうちに bot へ持たせて
// おくこと。
//
// explorationFirst の forge/foundry 回避(bots.ts §3)自体は変更しない
// (ユーザー承認済みだが、それでも「過酷業務を避ける」という bot の戦略差は
// GDD 11.4-1 の観測対象として意味を保っている)。代わりに「研究予定 tech が
// その施設を要求する tick だけ」bots.ts 側で建設/配属へ一時的に割り込ませる
// (§3a の倉庫と同じ「1 tick 1 特別枠」の規模感)。
//
// **「研究予定 tech」= 現在選択中の 1 本だけ**にする(`currentResearchTechId`)。
//
// **配属側は優先度の差し込みではなく「余った住民だけを使う」方式にする**
// ({@link buildFieldRequirementStaffingCommand})。[Phase A] 実装の最初の版は
// 建設・配属の両方を `defPriority` の先頭へ差し込んでいたが、
// `buildAssignmentCommands` の均等配属(§2 の doc)は**無配属の住民しか動かさず、
// 一度決まった配属は動かさない**ため、たった 1 tick の割り込みでもその日
// たまたま無配属だった住民を恒久的に奪い、後から通常優先順へ戻しても
// 二度と埋まらない(住民 8 人に施設 12〜13 種という小規模な盤面では
// 「その日空いていた住民」の奪い合いがそのまま固定化する)。実測: hearth の
// 唯一の就労者が要求施設側へ奪われ、以後 hearth が恒久的に無人化 =
// 薪産出が run 後半でゼロに張り付く構造的ソフトロック(`gdd-11.4-2a` 構造
// fail・`tests/sim/nightlyGate.test.ts` で検出)。
//
// 対策 = 通常の `buildAssignmentCommands`(policies.assignment・無改変)を
// **先に**実行し、そこで無配属のまま残った住民だけを実地要件施設へ回す
// (bots.ts 側で「今 tick に他の提案が使った住民 ID」を集合として渡す)。
// これなら通常配属が誰も奪われず、実地要件側は「今日どうせ誰も割り当てられ
// なかった余剰」だけを使う——奪い合いが構造的に起きない。
//
// 建設側は「余りものだけ」にする必要が無い(1 basisを新設するだけで既存施設の
// 就労者を奪わない)ため、引き続き `defPriority` の先頭へ差し込む方式のまま
// (`fieldFacilityIdsNeedingConstruction`)。
//
// **割り込みは「まだ満たしていない」間だけ**にする(建設は現基数 0 の間だけ、
// 配属は施設が建っていて就労者 0 の間だけ)。1 基建って 1 人就けば通常の
// 優先順へ戻す(= この施設だけを優遇し続けない)。

/**
 * tech ID の集合から、その `fieldRequirement.facility`(= `TechDef.fieldFacilityId`)
 * を重複なく集める(未定義の tech / fieldFacilityId 省略時は無視)。
 * 戻り値の順序は `techIds` の走査順で最初に現れた施設 ID から([Phase A])。
 */
export function fieldFacilityIdsFor(
  techIds: readonly EntityId[],
  content: EngineContent,
): readonly EntityId[] {
  const seen = new Set<EntityId>();
  const result: EntityId[] = [];
  for (const techId of techIds) {
    const facilityId = content.techDefs.get(techId)?.fieldFacilityId;
    if (facilityId === undefined || seen.has(facilityId)) continue;
    seen.add(facilityId);
    result.push(facilityId);
  }
  return result;
}

/**
 * {@link fieldFacilityIdsFor} のうち、**まだ 1 基も建っていない**ものだけを
 * 残す(建設側の優先度差し込みに使う)。1 基建てば以後は通常の
 * `buildFacilityCommand` の「現基数最小」規則に任せる。
 */
export function fieldFacilityIdsNeedingConstruction(
  techIds: readonly EntityId[],
  state: GameState,
  content: EngineContent,
): readonly EntityId[] {
  const counts = facilityCountByDefId(state);
  return fieldFacilityIdsFor(techIds, content).filter((id) => (counts.get(id) ?? 0) === 0);
}

/**
 * {@link fieldFacilityIdsFor} のうち、**施設は建っているが就労者が 0 人**の
 * ものだけを残す(配属側の優先度差し込みに使う)。まだ影も形も無い施設は
 * 配属できないので除外し、1 人就けば以後は通常の `buildAssignmentCommands`
 * の「就労者最少」規則に任せる(= この施設だけを優遇し続けない)。
 */
export function fieldFacilityIdsNeedingStaffing(
  techIds: readonly EntityId[],
  state: GameState,
  content: EngineContent,
): readonly EntityId[] {
  const facilityCounts = facilityCountByDefId(state);
  const workerCounts = workerCountByDefId(state);
  return fieldFacilityIdsFor(techIds, content).filter(
    (id) => (facilityCounts.get(id) ?? 0) > 0 && (workerCounts.get(id) ?? 0) === 0,
  );
}

/**
 * [Phase B / M67] クリティカル資源(建設/開墾コスト資源)を産出する施設定義の
 * うち、**就労者が 1 人も居ない**ものを定義 ID 昇順で返す。
 *
 * M67 で実地要件が実効化されると bot は forge のような施設をわざわざ建てて
 * 就労させるようになるが、そこで作られた鉄が foundry の建設コストに使われた
 * 瞬間、**鉄はクリティカル資源になる**(`gdd-11.4-2a` の定義)。研究が全部
 * 終わったあとに forge の就労者が死亡/派遣で抜けるとその資源の産出経路が
 * run 後半で 0 になり、構造 assert が落ちる(実測 researchFirst/nightly-b:iron)。
 * 均等配属は配属替えをしないため、無配属が居ない盤面では二度と埋まらない。
 * 実地要件の配置替えと**同じ部品**で埋め直せるようにする。
 */
export function unstaffedCriticalProducerDefIds(
  state: GameState,
  content: EngineContent,
): readonly EntityId[] {
  const criticalResourceIds = criticalBuildResourceIds(state, content);
  if (criticalResourceIds.size === 0) return [];
  const workerCounts = workerCountByDefId(state);
  const result: EntityId[] = [];
  const seen = new Set<EntityId>();
  for (const facility of entitiesOfKind(state, "facility")) {
    if (seen.has(facility.defId)) continue;
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "resource") continue;
    if (!criticalResourceIds.has(def.output.resourceId)) continue;
    seen.add(facility.defId);
    if ((workerCounts.get(facility.defId) ?? 0) > 0) continue;
    result.push(facility.defId);
  }
  return result.sort(compareUtf16);
}

export interface FieldRequirementStaffingResult {
  readonly command: AssignResidentCommand | undefined;
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
}

/**
 * 実地要件施設(`facilityId`)へ、**通常の均等配属が使わなかった余りの住民**
 * だけで 1 人配属する(§4b 冒頭の doc「奪い合いを避ける」設計)。
 *
 * `alreadyAssignedResidentIds` は同一 tick 内で他の提案(呼び出し側が先に
 * 実行した通常の `buildAssignmentCommands`)が既に使った住民 ID。これに
 * 含まれる住民には触れない。空きスロットが無い/対象施設が存在しない/
 * 使える余り住民が居ない(過酷業務なら {@link recallGuardBlocks} 込み)の
 * いずれかなら `command: undefined`。
 */
export function buildFieldRequirementStaffingCommand(
  state: GameState,
  content: EngineContent,
  facilityId: EntityId,
  alreadyAssignedResidentIds: ReadonlySet<EntityId>,
  tick: number,
  botId: string,
  allowReassign = false,
): FieldRequirementStaffingResult {
  const def = content.facilityDefs.get(facilityId);
  if (def === undefined) return { command: undefined, recallGuardLog: [] };

  let targetFacilityId: EntityId | undefined;
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.defId !== facilityId) continue;
    const slots = facilityWorkerSlots(def, facility.level);
    const openSlots =
      slots === undefined ? Number.POSITIVE_INFINITY : slots - facility.workerIds.length;
    if (openSlots <= 0) continue;
    targetFacilityId = facility.id;
    break;
  }
  if (targetFacilityId === undefined) return { command: undefined, recallGuardLog: [] };

  const recallGuardLog: RecallGuardLogEntry[] = [];
  for (const resident of staffingCandidates(state, content, allowReassign)) {
    if (alreadyAssignedResidentIds.has(resident.id)) continue;
    if (def.harshWork) {
      const check = recallGuardBlocks(state, content, resident, "harshAssignment", tick, botId);
      if (check.blocked) {
        if (check.logEntry !== null) recallGuardLog.push(check.logEntry);
        continue;
      }
    }
    return {
      command: { kind: "assignResident", residentId: resident.id, facilityId: targetFacilityId },
      recallGuardLog,
    };
  }
  return { command: undefined, recallGuardLog };
}

/**
 * [Phase B / M67] 実地要件施設へ回せる住民(**無配属が先・次に配置替え可能な
 * 配属済み**)。ID 昇順(`entitiesOfKind` の正準順)。
 *
 * Phase A は「無配属の余り住民だけ」だったが、M67 で実地要件が実効化すると
 * それでは足りないことが実測で判明した: 8 人規模の盤面では run の早い段階で
 * 全住民が配属され、**その後に建った実地要件施設(典型は forge)が最後まで
 * 無人のまま**になる(均等配属 `buildAssignmentCommands` は無配属の住民しか
 * 動かさない)。結果、研究点が満了しても実地要件が永久に満たされず
 * **researchFirst / codifyFirst が E2 で恒久停止**した(40 ゲーム日 run で
 * `techSmelting` が field=0 のまま・`gdd-11.4-3-era3-reached` が 7/15 へ)。
 *
 * 配置替えの対象は 2 段で絞る(実測で 2 回作り直した):
 *   (1) **クリティカル資源の唯一の就労者は除外**({@link soleCriticalProducerResidentIds}・
 *       派遣保護と同じ定義を再利用)。Phase A が踏んだ「hearth の唯一の就労者を
 *       奪って薪産出が恒久ゼロ」(`gdd-11.4-2a` 構造 fail)を防ぐ。
 *   (2) さらに **資源産出施設(`output.kind === "resource"`)で就労者が 1 人だけ**
 *       の住民も除外する。(1) だけでは不足だった: 実地要件の対象施設は tech が
 *       進むたび forge ↔ workbench と入れ替わるので、「今 forge が要る」→ forge へ
 *       移す →「次は workbench が要る」→ forge の唯一の就労者を workbench へ戻す、
 *       という往復が起き、鉄の産出レートが run 後半の全標本で 0 になった
 *       (`gdd-11.4-2a` 構造 fail・実測 researchFirst/nightly-b:iron)。研究点を
 *       産む施設(`output.kind === "research"`)は盤面に何種もあるので、そちらから
 *       1 人借りても産出経路は消えない。
 *   (3) ただし研究点を産む施設が**盤面で 1 基しか稼働していない**なら、その
 *       就労者も除外する({@link soleStaffedResearchProducerResidentIds})。
 *       (2) だけだと研究点産出が全滅する逆向きの偏りが起きた。
 * **無配属が 1 人でも居ればそちらが優先**であり、さらに `allowReassign` が false
 * (= 研究が実際には実地要件で詰まっていない)なら配置替えは一切行わない。
 * 通常時の挙動は Phase A と同一である。
 *
 * **[Phase D] 無配属と配置替え候補を「早期 return」ではなく連結で返す。**
 * Phase B の形は `idle.length > 0` なら配置替え候補を 1 人も見なかったため、
 * **無配属が居るのにその全員が同一 tick の通常配属で使われてしまう盤面**
 * (探索優先 bot: 保護加入で無配属が毎日湧き、均等配属がその日のうちに全員
 * 埋める)では、実地要件施設が永久に無人のまま残った。呼び出し側は
 * `alreadyAssignedResidentIds` で「今 tick に既に使った住民」を弾くので、
 * 連結にしておけば**無配属が余っていればそちらが必ず先に選ばれる**という
 * 優先順は保たれたまま、余りが尽きたときだけ配置替えへ進む。
 * 実測: `gdd-11.4-3-era3-reached` の未到達 run のうち explorationFirst の 2 本
 * (nightly-b / nightly-c)がこれで解消する。
 */
function staffingCandidates(
  state: GameState,
  content: EngineContent,
  allowReassign: boolean,
): readonly ResidentState[] {
  const idle = livingIdleResidents(state);
  if (!allowReassign) return idle;
  const protectedIds = new Set<EntityId>([
    ...soleCriticalProducerResidentIds(state, content),
    ...soleResourceProducerResidentIds(state, content),
    ...soleStaffedResearchProducerResidentIds(state, content),
  ]);
  const result: ResidentState[] = [...idle];
  for (const resident of entitiesOfKind(state, "resident")) {
    if (!isAliveResident(resident)) continue;
    if (resident.dispatched) continue;
    if (resident.assignedFacilityId === null) continue;
    if (protectedIds.has(resident.id)) continue;
    result.push(resident);
  }
  return result;
}

/**
 * [Phase B / M67] 研究点を産む施設(`output.kind === "research"`)で就労者が
 * 居るものが**盤面にただ 1 基**のとき、その就労者を保護する
 * ({@link staffingCandidates} (3))。ここを抜くと「資源産出は全部保護 →
 * 動かせるのは研究点産出だけ → 研究点産出が全滅」という逆向きの偏りが起き、
 * 研究レートが run 後半で 0 に張り付いた(実測 greedy/nightly-b: 研究点産出
 * 施設の就労者が 0 人・techSmelting が progress=0 のまま)。
 */
function soleStaffedResearchProducerResidentIds(
  state: GameState,
  content: EngineContent,
): ReadonlySet<EntityId> {
  const staffed: EntityId[][] = [];
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.workerIds.length === 0) continue;
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "research") continue;
    staffed.push([...facility.workerIds]);
  }
  if (staffed.length !== 1) return new Set();
  return new Set(staffed[0]);
}

/**
 * [Phase B / M67] 資源産出施設(`output.kind === "resource"`)のうち、その施設
 * インスタンスの就労者が 1 人だけのものの住民 ID({@link staffingCandidates} (2))。
 * {@link soleCriticalProducerResidentIds} と違い**定義単位ではなくインスタンス
 * 単位**で見る(同じ定義が 2 基あっても、片方を空にすればその基の産出は 0 になる)。
 */
function soleResourceProducerResidentIds(
  state: GameState,
  content: EngineContent,
): ReadonlySet<EntityId> {
  const result = new Set<EntityId>();
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.workerIds.length !== 1) continue;
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "resource") continue;
    const soleWorkerId = facility.workerIds[0];
    if (soleWorkerId !== undefined) result.add(soleWorkerId);
  }
  return result;
}

/**
 * 現在研究点を受け取っている研究対象の tech ID(`rules/research.ts` の
 * `currentResearch` そのまま。何も進行していなければ undefined)。
 * 「研究予定 tech」を実地要件の対象へ絞り込む入口として使う([Phase A] §4b)。
 */
export function currentResearchTechId(state: GameState): EntityId | undefined {
  return currentResearch(state)?.techId;
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

/**
 * 現在建っている施設の建設コスト資源 ∪ 開墾コスト資源([Phase A]・
 * `sim/nightlyGate.ts` の `criticalResourceIdsOf` と同じ考え方 — GDD 11.4-2
 * 「ソフトロックゼロ」が実際に見ている「クリティカル資源」の定義)。
 */
function criticalBuildResourceIds(state: GameState, content: EngineContent): ReadonlySet<EntityId> {
  const ids = new Set<EntityId>();
  const reclaimResourceId = content.reclaim?.costResourceId;
  if (reclaimResourceId !== undefined) ids.add(reclaimResourceId);
  for (const facility of entitiesOfKind(state, "facility")) {
    const resourceId = content.facilityDefs.get(facility.defId)?.cost?.resourceId;
    if (resourceId !== undefined) ids.add(resourceId);
  }
  return ids;
}

/**
 * クリティカル資源(上記)を産出する施設**定義**のうち、現在の就労者が
 * 丁度 1 人だけのものを見つけ、その住民 ID を集める([Phase A])。
 *
 * 派遣候補プール(`explorationTeamCandidates`)は配属済みの住民も含む
 * (GDD 8.1・bots.ts §3 冒頭の doc)ため、クリティカル資源の**唯一の**
 * 就労者を派遣で引き剥がすと、その資源の産出経路が run 残り全体でゼロに
 * 固定されうる(均等配属 `buildAssignmentCommands` は配属替えをしないため
 * 一度崩れると回復しない)。
 *
 * **対象をクリティカル資源の産出施設だけに絞る**理由: 最初の実装は
 * 「施設定義を問わず就労者が 1 人だけの全施設」を対象にしたところ、8 人規模の
 * 盤面では就労者の大半が何かの「唯一の 1 人」になり、`buildDispatchCommands`
 * の「保護してもなお派遣枠を満たせるか」判定(§ 冒頭の doc)がほぼ常に
 * 「満たせない」側へ落ちて保護が空振りした(実測: `gdd-11.4-2a` が再発)。
 * クリティカル資源(通常は 1〜2 施設定義)だけに絞ると保護対象がぐっと減り、
 * 判定が「満たせる」側に収まりやすくなる。
 */
function soleCriticalProducerResidentIds(
  state: GameState,
  content: EngineContent,
): ReadonlySet<EntityId> {
  const criticalResourceIds = criticalBuildResourceIds(state, content);
  if (criticalResourceIds.size === 0) return new Set();

  const workerIdsByDefId = new Map<EntityId, EntityId[]>();
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.workerIds.length === 0) continue;
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined || def.output.kind !== "resource") continue;
    if (!criticalResourceIds.has(def.output.resourceId)) continue;
    const list = workerIdsByDefId.get(facility.defId);
    if (list === undefined) {
      workerIdsByDefId.set(facility.defId, [...facility.workerIds]);
    } else {
      list.push(...facility.workerIds);
    }
  }
  const result = new Set<EntityId>();
  for (const workerIds of workerIdsByDefId.values()) {
    if (workerIds.length !== 1) continue;
    const soleWorkerId = workerIds[0];
    if (soleWorkerId !== undefined) result.add(soleWorkerId);
  }
  return result;
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
 * [Phase D] **未完了の研究が実地要件で待っている施設**のうち、就労者の居る
 * インスタンスが盤面に 1 基しか無いものの就労者 ID
 * ({@link buildDispatchCommands} のベストエフォート保護)。
 *
 * 「1 基しか無いとき」に絞るのは、2 基以上稼働していれば 1 人出しても
 * その施設定義の稼働(= 実地要件の蓄積)が止まらないためで、
 * {@link soleStaffedResearchProducerResidentIds} と同じ考え方である。
 */
function soleFieldRequirementWorkerResidentIds(
  state: GameState,
  content: EngineContent,
): ReadonlySet<EntityId> {
  const neededDefIds = new Set<EntityId>();
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick !== null) continue;
    const facilityDefId = content.techDefs.get(research.techId)?.fieldFacilityId;
    if (facilityDefId !== undefined) neededDefIds.add(facilityDefId);
  }
  if (neededDefIds.size === 0) return new Set();

  const staffedByDefId = new Map<EntityId, EntityId[][]>();
  for (const facility of entitiesOfKind(state, "facility")) {
    if (!neededDefIds.has(facility.defId)) continue;
    if (facility.workerIds.length === 0) continue;
    const list = staffedByDefId.get(facility.defId) ?? [];
    list.push([...facility.workerIds]);
    staffedByDefId.set(facility.defId, list);
  }
  const result = new Set<EntityId>();
  for (const instances of staffedByDefId.values()) {
    if (instances.length !== 1) continue;
    for (const workerId of instances[0] ?? []) result.add(workerId);
  }
  return result;
}

/**
 * 探索チームを提案する(GDD 11.5 のガード付き)。ガードでブロックされた住民は
 * `suggestExpeditionTeams` の候補プールから除外する(= 派遣しない。GDD 11.5
 * 「派遣に回さない」の実装そのもの)。
 *
 * [Phase A] 余裕があれば {@link soleCriticalProducerResidentIds} も除外
 * リストへ足す——「派遣候補は配属済みの住民も含む」(GDD 8.1)ことと、均等配属
 * (`buildAssignmentCommands`)が配属替えを一切しないことの組み合わせにより、
 * クリティカル資源の**唯一の**就労者を派遣で引き剥がすと、その資源の産出経路が
 * run 残り全体でゼロに固定されうる(実測: teamSize 3 化で
 * `gdd-11.4-2a`(ソフトロックゼロ)が構造 fail になるケースを
 * `tests/sim/nightlyGate.test.ts` で検出・再現)。
 *
 * **保護は「それでも派遣枠を満たせる場合だけ」のベストエフォート**にする。
 * GDD 11.5 のガード(想起リスク)は必須(除外しても派遣ゼロになるならゼロで
 * 正しい)だが、就労者保護まで無条件必須にすると、population が小さい bot
 * (例: 貪欲・5 日おき 1 回・teamSize 3)がプール不足で**一度も派遣できなく
 * なる**副作用が実測で出た(`gdd-11.4-11a`「貪欲botの派遣延べ人数 >= 1」が
 * 構造 fail 化)。保護を足しても閾値を満たせるときだけ足し、満たせないときは
 * 保護なし(= 従来どおり GDD 11.5 のガードのみ)で派遣する。
 *
 * **[Phase D] 同じベストエフォート枠へ 2 つ足す。**
 *   (a) {@link soleFieldRequirementWorkerResidentIds} —— M67 の実地要件は
 *       「その施設が**稼働している** tick」だけ積み上がり、稼働の判定は生産式と
 *       同じ「派遣中・想起困難中でない就労者が 1 人以上」である
 *       (`rules/techMemory.ts` `computeFieldRunGains`)。作業場の唯一の就労者を
 *       出したまま帰還を待つ日が続くと、研究が待っている作業場が回らない。
 *   (b) `justAssignedResidentIds` —— **同じ tick に配属したばかりの住民**。
 *       bot の提案は 1 つの state から一括で組み立てられ適用だけが逐次なので、
 *       Phase C までの形は「無配属の住民を作業場へ配属し、その同じ住民を同じ
 *       tick の派遣に載せる」提案を毎日出していた(実測 explorationFirst:
 *       workbench の就労者が毎日 0 人に戻り、E1 の workbench 系 4 本が 12 日
 *       以上「点は満了・実地要件だけ未達」で滞留 → E3 到達 30〜36 日)。
 *       配属した本人をその日のうちに引き剥がすのは人間のプレイでも起こらない
 *       判断であり、**bot の戦略差(探索優先は派遣が多い)には影響しない**
 *       (候補プールから 1 日ぶんの新規配属者が抜けるだけで、派遣枠は
 *       他の候補で埋まる)。
 */
export function buildDispatchCommands(
  state: GameState,
  content: EngineContent,
  tick: number,
  policy: DispatchPolicy,
  botId: string,
  justAssignedResidentIds: ReadonlySet<EntityId> = new Set(),
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
  const recallGuardExcludeIds = new Set<EntityId>();
  const candidates = explorationTeamCandidates(state);
  for (const resident of candidates) {
    const check = recallGuardBlocks(state, content, resident, "dispatch", tick, botId);
    if (check.blocked) {
      recallGuardExcludeIds.add(resident.id);
      if (check.logEntry !== null) recallGuardLog.push(check.logEntry);
    }
  }

  const threshold = policy.teamSize * availableSlots + policy.minIdlePoolSlack;
  // [Phase D] 保護は **all-or-nothing ではなく 1 人ずつ**足す。Phase A/B の形は
  // 「全部足しても閾値を満たせるなら全部・でなければ 1 人も保護しない」だった
  // ため、人口の小さい盤面では**保護がまるごと消える**(実測 explorationFirst:
  // 候補 6〜7 人 / 閾値 5 に対し保護対象が 2 人以上あると全部落ち、hearth の
  // 唯一の就労者が毎日引き剥がされて techCharcoalKiln の実地要件が 10 日以上
  // 進まない)。優先順は「クリティカル資源の唯一の就労者 → 研究が待っている
  // 作業場の唯一の就労者 → 今日配属したばかりの住民」で、同順位は ID 昇順
  // (全順序 = 決定論)。閾値を割る 1 人手前で止めるので、
  // `gdd-11.4-11a`(貪欲botの派遣延べ人数 >= 1)を壊さない性質は変わらない。
  const candidateIds = new Set(candidates.map((resident) => resident.id));
  const excluded = new Set<EntityId>();
  for (const residentId of recallGuardExcludeIds) {
    if (candidateIds.has(residentId)) excluded.add(residentId);
  }
  // 今日配属したばかりの住民の除外は**必須**(ベストエフォートではない)。
  // 同じ tick に「作業場へ配属する」と「探索へ送り出す」を同時に提案するのは
  // それ自体が自己矛盾で、閾値の都合で矛盾を許すと実地要件が永久に進まない。
  // 除外の結果プールが閾値を割ればその日は派遣しない(= 人手を使い切った日)。
  for (const residentId of justAssignedResidentIds) {
    if (candidateIds.has(residentId)) excluded.add(residentId);
  }
  const protectionGroups: readonly (readonly EntityId[])[] = [
    [...soleCriticalProducerResidentIds(state, content)].sort(compareUtf16),
    [...soleFieldRequirementWorkerResidentIds(state, content)].sort(compareUtf16),
  ];
  for (const group of protectionGroups) {
    for (const residentId of group) {
      if (!candidateIds.has(residentId) || excluded.has(residentId)) continue;
      if (candidates.length - (excluded.size + 1) < threshold) continue;
      excluded.add(residentId);
    }
  }
  const excludeResidentIds = [...excluded];

  const poolSize = candidates.length - excludeResidentIds.length;
  if (poolSize < threshold) {
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
