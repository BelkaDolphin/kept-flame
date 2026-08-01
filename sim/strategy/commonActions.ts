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
import { currentResearch } from "../../src/engine/rules/research";
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
}

/** `defPriority` の順に、空きスロットがある施設インスタンスを列挙する。 */
function openFacilitiesByDefPriority(
  state: GameState,
  content: EngineContent,
  defPriority: readonly EntityId[],
): readonly OpenFacility[] {
  const result: OpenFacility[] = [];
  for (const defId of defPriority) {
    const def = content.facilityDefs.get(defId);
    if (def === undefined) continue;
    for (const facility of entitiesOfKind(state, "facility")) {
      if (facility.defId !== defId) continue;
      const slots = facilityWorkerSlots(def, facility.level);
      const openSlots =
        slots === undefined ? Number.POSITIVE_INFINITY : slots - facility.workerIds.length;
      if (openSlots <= 0) continue;
      result.push({ facility, defId, harsh: def.harshWork, openSlots });
    }
  }
  return result;
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
 * 無配属の住民を、方針の優先順に空きスロットへ割り当てる(GDD 11.5 のガード付き)。
 *
 * 過酷業務(`def.harshWork`)への割当は {@link recallGuardBlocks} を通す。ブロック
 * されたら**その施設定義**を諦め(1 住民 1 回だけログ)、優先順の次の施設定義を
 * 試す。同一 tick 内の枠の奪い合いはローカルな予約カウンタで解消する。
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
  const reserved = new Map<EntityId, number>();
  const commands: AssignResidentCommand[] = [];
  const recallGuardLog: RecallGuardLogEntry[] = [];

  for (const resident of idle) {
    const blockedHarshDefIds = new Set<EntityId>();
    let loggedForResident = false;
    for (const open of openFacilities) {
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
  readonly defPriority: readonly EntityId[];
  readonly placement: "assist" | "naive";
}

/**
 * 新規施設を 1 基だけ提案する(この tick で建てすぎない)。`defPriority` の
 * 順に「定義がある」→「払える」→「置ける」を試し、最初に成立したものを返す。
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
  for (const defId of policy.defPriority) {
    const def = content.facilityDefs.get(defId);
    if (def === undefined) continue;
    if (!canAffordBuild(state, def, facilityBuildCostFix(def))) continue;

    const facilityId = nextFacilityEntityId(state, defId);
    const footprint = def.footprint ?? UNIT_FOOTPRINT;
    if (!isValidFootprintDims(footprint)) continue;

    if (policy.placement === "assist") {
      const plan = suggestPlacementsAvoidingRubble(state, content, [{ facilityId, defId }], {
        qualityRatioFix: FIX_ONE,
      });
      const command = placementPlanToCommands(plan)[0];
      if (command === undefined) continue;
      return command;
    }

    const cellIndex = naivePlacementCell(state, footprint);
    if (cellIndex === null) continue;
    return { kind: "placeFacility", facilityId, defId, cellIndex };
  }
  return undefined;
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
