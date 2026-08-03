// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 経済プローブ(M40 の再校正を数値で設計するための計測) —
//   GDD 5.1(指数コスト vs 線形供給)/ 5.2(到達目安)/ 6.7(保管上限)/
//   8.6(探索 ROI)/ 9.2(拠点供給)/ 11.1(経済数式)
//
// ===========================================================================
// 1. 何を測るか(M40 の 5 つの問いに 1 対 1 で対応)
// ===========================================================================
//   (1) facilityEconomics  — 施設ごとの「Lv1 就労 1 名の産出」と「自分の建設費を
//       稼ぐのに要する tick」。**1 tick = 1 実分**(GDD 11.1)なので、この値が
//       そのまま「次のアクションまでの実時間」になる。
//   (2) earlyGameActionGaps — 「即座に使える手があれば必ず打つ」貪欲プレイヤー
//       を序盤 3 ゲーム日ぶん走らせ、資源で律速されるアクション(建設/増築/
//       開墾)の**間隔**を測る。ユーザー実プレイ報告「序盤にやることがなくなる」
//       の定量化。
//   (3) researchPacing — 開始盤面の研究レートと E1 全 tech の完了 tick。
//       研究だけが突出して速い(R4-A07/B02)かどうかの判定に使う。
//   (4) explorationRoiVsActual — 派遣前 ROI(band パラメータの解析モデル)と
//       実際の派遣結果(event テーブル駆動)の乖離(R4-A08)。
//   (5) outpostVsFacility — 拠点供給レートと同資源の施設産出レートの比(R4-A06)。
//   (6) resourceAccounting — 40 ゲーム日の貪欲 run 後の資源別
//       累計産出/累計超過/在庫(GDD 11.4-7c の内訳)。
//
// ===========================================================================
// 2. 決定論
// ===========================================================================
//   `Math.random` / `Date.now` を使わない。worldSeed は固定文字列。
//   `performance.now()` は使わない(本プローブは所要時間を報告しない)。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { advanceWithReport, createAdvanceContext } from "../src/engine/advance";
import {
  apply,
  facilityBuildCostFix,
  facilityUpgradeCostFix,
  facilityMaxLevel,
  facilityWorkerSlots,
  type Command,
} from "../src/engine/commands";
import { toRaw, type Fix } from "../src/engine/fp";
import { buildDispatchSnapshot, explorationRoi } from "../src/engine/rules/exploration";
import { computeProductionRates } from "../src/engine/rules/production";
import { reclaimCostFix } from "../src/engine/rules/reclaim";
import type { DistanceBand, EngineContent } from "../src/engine/rules/types";
import {
  entitiesOfKind,
  entityIdFromString,
  isRubbleCell,
  livingResidents,
  type EntityId,
  type GameState,
} from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";
import { createNewGameState } from "../src/newGame";

import { pickResearchTarget, researchCommand } from "./strategy/commonActions";
import { greedyBot, STRATEGY_BOTS } from "./strategy/bots";
import { resolveStrategyContent, runStrategyBot } from "./strategy/runStrategy";
import { isMainModule, writeJsonReport } from "./cliUtil";

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

const PROBE_SEED = "m40-economy-probe";
const SIM_ALGO_VERSION = 1;

/** 1e6 固定小数点 raw → 人間可読な数値(丸め誤差を持ち込まないよう小数 6 桁)。 */
function human(fix: Fix | undefined): number {
  return fix === undefined ? 0 : toRaw(fix) / 1e6;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// --- 1. 施設の経済性 ---------------------------------------------------------

export interface FacilityEconomicsRow {
  readonly facilityId: string;
  readonly outputKind: string;
  readonly outputResourceId: string | null;
  /** Lv1 就労 1 名・隣接補正なし・中立ステータスでの 1 tick 産出。 */
  readonly ratePerTickLv1: number;
  /** 同上を 1 ゲーム日(= 実 24 時間)へ換算。 */
  readonly ratePerGameDayLv1: number;
  readonly buildCostResourceId: string | null;
  readonly buildCost: number;
  /** 自分の建設費を自分 1 棟で稼ぐのに要する tick(= 実分)。産出資源が建設費資源と違う場合は null。 */
  readonly selfBuildTicks: number | null;
  readonly upgradeLv1To2Cost: number;
  /** lvCurve[0] / buildCost.amount(クリープ検出のメトリクスと同じ量)。 */
  readonly outputPerBuildCost: number | null;
}

function facilityEconomics(content: EngineContent): readonly FacilityEconomicsRow[] {
  const rows: FacilityEconomicsRow[] = [];
  for (const def of content.facilityDefs.values()) {
    const rate = human(def.outputPerTickByLevel[0]);
    const buildCost = human(facilityBuildCostFix(def));
    const costResourceId = def.cost?.resourceId ?? null;
    const outputResourceId = def.output.kind === "resource" ? String(def.output.resourceId) : null;
    rows.push({
      facilityId: String(def.id),
      outputKind: def.output.kind,
      outputResourceId,
      ratePerTickLv1: round(rate, 6),
      ratePerGameDayLv1: round(rate * GAME_DAY_TICKS, 3),
      buildCostResourceId: costResourceId === null ? null : String(costResourceId),
      buildCost: round(buildCost, 3),
      selfBuildTicks:
        outputResourceId !== null &&
        costResourceId !== null &&
        outputResourceId === String(costResourceId) &&
        rate > 0
          ? Math.round(buildCost / rate)
          : null,
      upgradeLv1To2Cost: round(human(facilityUpgradeCostFix(def, 1)), 3),
      outputPerBuildCost: buildCost > 0 ? round(rate / buildCost, 8) : null,
    });
  }
  rows.sort((l, r) => (l.facilityId < r.facilityId ? -1 : l.facilityId > r.facilityId ? 1 : 0));
  return rows;
}

// --- 2. 序盤のアクション間隔 -------------------------------------------------

/** 貪欲プレイヤーが取ったアクション 1 件。 */
export interface ProbeAction {
  readonly tick: number;
  readonly kind: string;
  readonly subject: string;
  readonly gapTicks: number;
}

export interface EarlyGameProbeResult {
  readonly horizonTicks: number;
  readonly actions: readonly ProbeAction[];
  /** 資源で律速されるアクション(建設/増築/開墾)の間隔。 */
  readonly resourceGatedGapTicks: readonly number[];
  readonly medianGapTicks: number;
  readonly maxGapTicks: number;
  readonly firstDayActionCount: number;
  readonly finalStockByResourceId: Readonly<Record<string, number>>;
}

/**
 * 建設候補の優先順(「拡大再生産を最優先する素朴なプレイヤー」)。
 *
 * ID 昇順や「現基数が最小」で選ぶと寝床・療養所のような**産出に寄与しない枠**
 * ばかり建って序盤の収入が伸びず、待ち時間が実際より悲観的に出る。ここは
 * 「次のアクションまでどれだけ待たされるか」を**プレイヤーが最善を尽くした
 * 場合の下界**として測りたいので、産出施設 → 生活基盤 → 効果未実装枠の順に
 * 並べる(sim/strategy/bots.ts の bot 優先順とは目的が違うので別に持つ)。
 */
const EAGER_BUILD_PRIORITY: readonly string[] = [
  "hearth",
  "waterTank",
  "kitchenGarden",
  "scriptorium",
  "charcoalKiln",
  "workbench",
  "researchDesk",
  "bed",
  "warehouse",
  "forge",
  "explorationHq",
  "foundry",
  "watchtower",
  "infirmary",
];

function allFacilityDefIds(content: EngineContent): readonly EntityId[] {
  const known = EAGER_BUILD_PRIORITY.map((id) => entityIdFromString(id)).filter((id) =>
    content.facilityDefs.has(id),
  );
  const rest = [...content.facilityDefs.keys()]
    .filter((id) => !known.includes(id))
    .sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
  return [...known, ...rest];
}

function stockOf(state: GameState, resourceId: EntityId | null | undefined): number {
  if (resourceId === undefined || resourceId === null) return 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === resourceId) return human(resource.stock);
  }
  return 0;
}

function firstFreeCell(state: GameState, content: EngineContent): number | null {
  const width = 6;
  const height = 8;
  const occupied = new Set<number>();
  for (const facility of entitiesOfKind(state, "facility")) {
    const footprint = content.facilityDefs.get(facility.defId)?.footprint ?? {
      width: 1,
      height: 1,
    };
    const baseRow = Math.floor(facility.cellIndex / width);
    const baseCol = facility.cellIndex % width;
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        occupied.add((baseRow + dy) * width + (baseCol + dx));
      }
    }
  }
  for (let cell = 0; cell < width * height; cell++) {
    if (occupied.has(cell)) continue;
    if (isRubbleCell(state, cell)) continue;
    return cell;
  }
  return null;
}

function nextFacilityId(state: GameState, defId: EntityId): EntityId {
  let n = 1;
  const stem = `fac${String(defId).charAt(0).toUpperCase()}${String(defId).slice(1)}`;
  for (;;) {
    const candidate = entityIdFromString(`${stem}${String(n)}`);
    let taken = false;
    for (const facility of entitiesOfKind(state, "facility")) {
      if (facility.id === candidate) taken = true;
    }
    if (!taken) return candidate;
    n++;
  }
}

/** 無配属の生存住民(ID 昇順・先頭)。 */
function firstIdleResidentId(state: GameState): EntityId | null {
  for (const resident of livingResidents(state)) {
    if (resident.assignedFacilityId === null) return resident.id;
  }
  return null;
}

/** 就労枠に空きのある施設(優先順の先頭)。 */
function firstFacilityWithFreeSlot(state: GameState, content: EngineContent): EntityId | null {
  const order = allFacilityDefIds(content);
  let best: { id: EntityId; rank: number } | null = null;
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined) continue;
    const slots = facilityWorkerSlots(def, facility.level) ?? 0;
    if (facility.workerIds.length >= slots) continue;
    const rank = order.indexOf(facility.defId);
    if (best === null || rank < best.rank) best = { id: facility.id, rank };
  }
  return best === null ? null : best.id;
}

/**
 * 「打てる手があれば即座に打つ」貪欲プレイヤー。1 手だけ返す(なければ null)。
 * 優先順は 配属 → 建設 → 増築 → 開墾。研究着手は資源を消費しないので別枠。
 */
function nextEagerCommand(state: GameState, content: EngineContent): Command | null {
  // 配属(無料): 遊んでいる住民を空き枠へ入れる。
  const idleId = firstIdleResidentId(state);
  if (idleId !== null) {
    const facilityId = firstFacilityWithFreeSlot(state, content);
    if (facilityId !== null) {
      return { kind: "assignResident", residentId: idleId, facilityId };
    }
  }

  const cell = firstFreeCell(state, content);
  if (cell !== null) {
    for (const defId of allFacilityDefIds(content)) {
      const def = content.facilityDefs.get(defId);
      if (def === undefined) continue;
      const footprint = def.footprint ?? { width: 1, height: 1 };
      if (footprint.width > 1 || footprint.height > 1) continue; // 1×1 のみ(配置探索を単純化)
      // 就労枠を持つ施設は、入れる住民が居ないなら建てない(空き施設は産出 0)。
      const slots = facilityWorkerSlots(def, 1) ?? 0;
      if (slots > 0 && idleId === null) continue;
      const cost = human(facilityBuildCostFix(def));
      if (cost > stockOf(state, def.cost?.resourceId)) continue;
      return {
        kind: "placeFacility",
        facilityId: nextFacilityId(state, defId),
        defId,
        cellIndex: cell,
      };
    }
  }
  // 増築: 建設優先順の先頭側から、払えるものを増築する(産出施設の底上げ優先)。
  const order = allFacilityDefIds(content);
  let upgradeTarget: { id: EntityId; rank: number; level: number } | null = null;
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = content.facilityDefs.get(facility.defId);
    if (def === undefined) continue;
    if (facility.level >= facilityMaxLevel(def)) continue;
    const cost = human(facilityUpgradeCostFix(def, facility.level));
    if (cost > stockOf(state, def.cost?.resourceId)) continue;
    const rank = order.indexOf(facility.defId);
    if (
      upgradeTarget === null ||
      rank < upgradeTarget.rank ||
      (rank === upgradeTarget.rank && facility.level < upgradeTarget.level)
    ) {
      upgradeTarget = { id: facility.id, rank, level: facility.level };
    }
  }
  if (upgradeTarget !== null) {
    return { kind: "upgradeFacility", facilityId: upgradeTarget.id };
  }
  // 開墾: 空きセルが無いときだけ。
  if (cell === null && content.reclaim !== undefined) {
    const cost = human(reclaimCostFix(content.reclaim, state.terrain.reclaimedCount));
    if (cost <= stockOf(state, content.reclaim.costResourceId)) {
      for (let candidate = 0; candidate < 48; candidate++) {
        if (isRubbleCell(state, candidate)) return { kind: "reclaimCell", cellIndex: candidate };
      }
    }
  }
  return null;
}

const RESOURCE_GATED_KINDS = new Set(["placeFacility", "upgradeFacility", "reclaimCell"]);

export function runEarlyGameProbe(
  content: EngineContent,
  horizonTicks: number,
): EarlyGameProbeResult {
  let state = createNewGameState(content, {
    algoVersion: SIM_ALGO_VERSION,
    worldSeed: PROBE_SEED,
  });
  let ctx = createAdvanceContext(state, content);
  const actions: ProbeAction[] = [];
  let lastResourceGatedTick = 0;
  const step = 10; // coarseTickMinutes と同じ粒度

  for (let cursor = step; cursor <= horizonTicks; cursor += step) {
    state = advanceWithReport(state, ctx, cursor).state;

    // 研究は資源を消費しないので、着手できるなら常に着手しておく(研究点が
    // 遊ばないようにする = 実プレイヤーの挙動)。
    const target = pickResearchTarget(state, content, true);
    if (target !== undefined) {
      const result = apply(state, content, researchCommand(target));
      if (result.ok && result.changed) {
        state = result.state;
        actions.push({ tick: cursor, kind: "beginResearch", subject: String(target), gapTicks: 0 });
      }
    }

    for (let guard = 0; guard < 8; guard++) {
      const command = nextEagerCommand(state, content);
      if (command === null) break;
      const result = apply(state, content, command);
      if (!result.ok) break;
      state = result.state;
      const kind = command.kind;
      const subject =
        command.kind === "placeFacility"
          ? String(command.defId)
          : command.kind === "upgradeFacility"
            ? String(command.facilityId)
            : command.kind === "reclaimCell"
              ? String(command.cellIndex)
              : "";
      const gap = RESOURCE_GATED_KINDS.has(kind) ? cursor - lastResourceGatedTick : 0;
      if (RESOURCE_GATED_KINDS.has(kind)) lastResourceGatedTick = cursor;
      actions.push({ tick: cursor, kind, subject, gapTicks: gap });
      if (kind === "placeFacility") ctx = createAdvanceContext(state, content);
    }
  }

  const gaps = actions.filter((a) => RESOURCE_GATED_KINDS.has(a.kind)).map((a) => a.gapTicks);
  const sorted = [...gaps].sort((l, r) => l - r);
  const median = sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0);
  const finalStock: Record<string, number> = {};
  for (const resource of entitiesOfKind(state, "resource")) {
    finalStock[String(resource.resourceId)] = round(human(resource.stock), 2);
  }
  return {
    horizonTicks,
    actions,
    resourceGatedGapTicks: gaps,
    medianGapTicks: median,
    maxGapTicks: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
    firstDayActionCount: actions.filter(
      (a) => a.tick <= GAME_DAY_TICKS && RESOURCE_GATED_KINDS.has(a.kind),
    ).length,
    finalStockByResourceId: finalStock,
  };
}

// --- 3. 研究ペーシング -------------------------------------------------------

export interface ResearchPacingResult {
  /** 開始盤面(作業台 Lv1 就労 1 名)の 1 tick あたり研究点。 */
  readonly startingResearchRatePerTick: number;
  readonly startingResearchRatePerGameDay: number;
  /** tech ID → researchCost / 開始レート(= 単独で完了するのに要する tick)。 */
  readonly ticksPerTechAtStartRate: Readonly<Record<string, number>>;
  /** E1 クリティカルパス(techFireStarting→techPottery→techStorage)の合計 tick。 */
  readonly e1CriticalPathTicks: number;
  /** 実 run(貪欲・10 ゲーム日)で era order が上がった tick。 */
  readonly firstTickByEraOrder: Readonly<Record<number, number>>;
  /**
   * 5戦略bot の実 run(20 ゲーム日)における研究レート標本(min/中央/max)。
   * **bot の意思決定 cadence(1 ゲーム日 1 本)が律速し続ける条件**
   * `最大 researchCost / botレート < 1440 tick` を判定するための入力。
   */
  readonly botResearchRatePerTick: Readonly<
    Record<string, { min: number; median: number; max: number }>
  >;
  /** 最大 researchCost(= 律速判定の分子)。 */
  readonly maxResearchCost: number;
}

function researchPacing(content: EngineContent): ResearchPacingResult {
  const state = createNewGameState(content, {
    algoVersion: SIM_ALGO_VERSION,
    worldSeed: PROBE_SEED,
  });
  const ctx = createAdvanceContext(state, content);
  const rate = human(computeProductionRates(state, ctx).researchRateFix);
  const perTech: Record<string, number> = {};
  for (const tech of content.techDefs.values()) {
    const cost = human(tech.researchCostFix);
    perTech[String(tech.id)] = rate > 0 ? round(cost / rate, 2) : -1;
  }
  const path = ["techFireStarting", "techPottery", "techStorage"];
  let pathTicks = 0;
  for (const id of path) pathTicks += perTech[id] ?? 0;

  const run = runStrategyBot({ bot: greedyBot, totalTicks: GAME_DAY_TICKS * 10 });

  const botRates: Record<string, { min: number; median: number; max: number }> = {};
  for (const bot of STRATEGY_BOTS) {
    const botRun = runStrategyBot({ bot, totalTicks: GAME_DAY_TICKS * 20 });
    const values = botRun.samples.map((s) => s.researchRateRaw / 1e6).sort((l, r) => l - r);
    botRates[bot.id] = {
      min: round(values[0] ?? 0, 6),
      median: round(values[Math.floor((values.length - 1) / 2)] ?? 0, 6),
      max: round(values[values.length - 1] ?? 0, 6),
    };
  }
  let maxCost = 0;
  for (const tech of content.techDefs.values()) {
    maxCost = Math.max(maxCost, human(tech.researchCostFix));
  }

  return {
    startingResearchRatePerTick: round(rate, 6),
    startingResearchRatePerGameDay: round(rate * GAME_DAY_TICKS, 2),
    ticksPerTechAtStartRate: perTech,
    e1CriticalPathTicks: round(pathTicks, 2),
    firstTickByEraOrder: run.metrics.firstTickByEraOrder,
    botResearchRatePerTick: botRates,
    maxResearchCost: round(maxCost, 2),
  };
}

// --- 4. 探索 ROI(モデル)と実際の派遣結果 -----------------------------------

export interface ExplorationRoiRow {
  readonly band: string;
  readonly teamSize: number;
  readonly modelExpectedReward: number;
  readonly modelSuccessProbability: number;
  readonly modelForgoneOutput: number;
  readonly modelRoi: number | null;
  /** 実際に派遣スナップショットが確定させた総報酬(= 帰還時に入る量)。 */
  readonly actualGrossReward: number;
  readonly actualNodeCount: number;
  readonly actualSuccessCount: number;
  /** actualGrossReward / modelExpectedReward。1.0 なら乖離なし。 */
  readonly actualOverModel: number | null;
}

function explorationRoiVsActual(content: EngineContent): readonly ExplorationRoiRow[] {
  const state = createNewGameState(content, {
    algoVersion: SIM_ALGO_VERSION,
    worldSeed: PROBE_SEED,
  });
  const residents = livingResidents(state);
  const bands: readonly DistanceBand[] = ["near", "far", "deep"];
  const rows: ExplorationRoiRow[] = [];
  const eventIdsByBand = new Map<DistanceBand, EntityId>();
  const eventDefs = content.eventDefs;
  if (eventDefs !== undefined) {
    const ids = [...eventDefs.keys()].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0));
    for (const band of bands) {
      for (const id of ids) {
        if (eventDefs.get(id)?.destTags.includes(band) === true) {
          eventIdsByBand.set(band, id);
          break;
        }
      }
    }
  }

  for (const band of bands) {
    for (let teamSize = 1; teamSize <= 4; teamSize++) {
      const memberIds = residents.slice(0, teamSize).map((r) => r.id);
      if (memberIds.length < teamSize) continue;
      const roi = explorationRoi(state, content, band, memberIds);
      const destinationId = eventIdsByBand.get(band);
      let actualGross = 0;
      let nodeCount = 0;
      let successCount = 0;
      if (destinationId !== undefined) {
        const snapshot = buildDispatchSnapshot(state, content, 0x1234_5678, {
          dispatchId: entityIdFromString("probeDispatch"),
          destinationId,
          band,
          memberIds,
          stance: "cautious",
          dispatchTick: 0,
        });
        actualGross = human(snapshot.rewardFix);
        nodeCount = snapshot.nodes.length;
        for (const node of snapshot.nodes) if (node.success) successCount++;
      }
      rows.push({
        band,
        teamSize,
        modelExpectedReward: round(human(roi.expectedRewardFix), 3),
        modelSuccessProbability: round(human(roi.successProbabilityFix), 4),
        modelForgoneOutput: round(human(roi.forgoneOutputFix), 3),
        modelRoi: roi.roiFix === null ? null : round(human(roi.roiFix), 4),
        actualGrossReward: round(actualGross, 3),
        actualNodeCount: nodeCount,
        actualSuccessCount: successCount,
        actualOverModel:
          human(roi.expectedRewardFix) === 0
            ? null
            : round(actualGross / human(roi.expectedRewardFix), 3),
      });
    }
  }
  return rows;
}

// --- 5. 拠点供給 vs 施設産出 -------------------------------------------------

export interface OutpostComparisonRow {
  readonly outpostTypeId: string;
  readonly resourceId: string;
  /** 常駐 1 名・Lv1 の 1 tick 供給。 */
  readonly supplyPerTick: number;
  readonly supplyPerGameDay: number;
  /** 同じ資源を産む施設の Lv1 産出/tick。 */
  readonly facilityRatePerTick: number | null;
  readonly ratio: number | null;
}

function readOutpostTypeJson(): readonly {
  id: string;
  resource: string;
  baseSupply: number;
}[] {
  return JSON.parse(readFileSync(`${CONTENT_DIR}outpostType.json`, "utf8")) as readonly {
    id: string;
    resource: string;
    baseSupply: number;
  }[];
}

function outpostVsFacility(content: EngineContent): readonly OutpostComparisonRow[] {
  const defs = readOutpostTypeJson();
  const rateByResource = new Map<string, number>();
  for (const def of content.facilityDefs.values()) {
    if (def.output.kind !== "resource") continue;
    rateByResource.set(String(def.output.resourceId), human(def.outputPerTickByLevel[0]));
  }
  return defs.map((def) => {
    const facilityRate = rateByResource.get(def.resource) ?? null;
    return {
      outpostTypeId: def.id,
      resourceId: def.resource,
      supplyPerTick: def.baseSupply,
      supplyPerGameDay: def.baseSupply * GAME_DAY_TICKS,
      facilityRatePerTick: facilityRate,
      ratio:
        facilityRate === null || facilityRate === 0
          ? null
          : round(def.baseSupply / facilityRate, 1),
    };
  });
}

// --- 6. 資源会計(40 ゲーム日の貪欲 run) ------------------------------------

export interface ResourceAccountingRow {
  readonly resourceId: string;
  readonly finalStock: number;
  readonly cumulativeProduced: number;
  readonly cumulativeOverflow: number;
  readonly lossRate: number | null;
}

function resourceAccounting(botId = "greedy"): {
  readonly botId: string;
  readonly rows: readonly ResourceAccountingRow[];
  readonly colonyLossRate: number;
  readonly reclaimCount: number;
  readonly placeFacilityCount: number;
} {
  const bot = STRATEGY_BOTS.find((b) => b.id === botId) ?? greedyBot;
  const run = runStrategyBot({ bot, totalTicks: GAME_DAY_TICKS * 40 });
  const rows: ResourceAccountingRow[] = [];
  let produced = 0;
  let overflow = 0;
  for (const resource of entitiesOfKind(run.state, "resource")) {
    const p = human(resource.cumulativeProduced);
    const o = human(resource.cumulativeOverflow);
    produced += p;
    overflow += o;
    rows.push({
      resourceId: String(resource.resourceId),
      finalStock: round(human(resource.stock), 2),
      cumulativeProduced: round(p, 2),
      cumulativeOverflow: round(o, 2),
      lossRate: p === 0 ? null : round(o / p, 4),
    });
  }
  return {
    botId,
    rows,
    colonyLossRate: produced === 0 ? 0 : round(overflow / produced, 4),
    reclaimCount: run.metrics.reclaimCount,
    placeFacilityCount: run.metrics.placeFacilityCount,
  };
}

// --- 6b. オーバーフロー損失率のピーク走査(夜間ゲート 11.4-7c と同じ入力) ----

export interface OverflowScanRow {
  readonly botId: string;
  readonly seed: string;
  /** 標本上の最大損失率(夜間ゲートが判定に使う値と同じ取り方)。 */
  readonly maxLossRate: number;
  readonly maxAtTick: number;
  /** era order -> 到達 tick(GDD 11.4-3 の入力)。 */
  readonly firstTickByEraOrder: Readonly<Record<number, number>>;
  /** 研究レートが 0 だった標本数 / 全標本数(研究停止の可視化)。 */
  readonly researchZeroSamples: number;
  readonly sampleCount: number;
  readonly finalFacilityCount: number;
  readonly finalPopulation: number;
  readonly completedResearch: number;
  /** ピーク時点の資源別内訳。 */
  readonly breakdownAtPeak: Readonly<Record<string, { produced: number; overflow: number }>>;
}

/** 夜間ゲートと同じ 5 bot × 3 seed で損失率のピークを走査する。 */
function overflowScan(): readonly OverflowScanRow[] {
  const seeds = ["nightly-a", "nightly-b", "nightly-c"];
  const rows: OverflowScanRow[] = [];
  for (const bot of STRATEGY_BOTS) {
    for (const seed of seeds) {
      const run = runStrategyBot({ bot, totalTicks: GAME_DAY_TICKS * 40, worldSeed: seed });
      let maxRate = 0;
      let maxTick = 0;
      for (const sample of run.samples) {
        if (sample.overflowLossRateRaw / 1e6 > maxRate) {
          maxRate = sample.overflowLossRateRaw / 1e6;
          maxTick = sample.tick;
        }
      }
      const breakdown: Record<string, { produced: number; overflow: number }> = {};
      for (const resource of entitiesOfKind(run.state, "resource")) {
        breakdown[String(resource.resourceId)] = {
          produced: round(human(resource.cumulativeProduced), 1),
          overflow: round(human(resource.cumulativeOverflow), 1),
        };
      }
      rows.push({
        botId: bot.id,
        seed,
        maxLossRate: round(maxRate, 4),
        maxAtTick: maxTick,
        firstTickByEraOrder: run.metrics.firstTickByEraOrder,
        researchZeroSamples: run.samples.filter((x) => x.researchRateRaw === 0).length,
        sampleCount: run.samples.length,
        finalFacilityCount: run.metrics.finalFacilityCount,
        finalPopulation: run.metrics.finalLivingPopulation,
        completedResearch: run.metrics.finalCompletedResearchCount,
        breakdownAtPeak: breakdown,
      });
    }
  }
  return rows;
}

// --- 7. 入口 -----------------------------------------------------------------

export interface EconomyProbeReport {
  readonly gameDayTicks: number;
  readonly facilityEconomics: readonly FacilityEconomicsRow[];
  readonly earlyGame: EarlyGameProbeResult;
  readonly research: ResearchPacingResult;
  readonly exploration: readonly ExplorationRoiRow[];
  readonly outpost: readonly OutpostComparisonRow[];
  readonly accounting: readonly ReturnType<typeof resourceAccounting>[];
  readonly overflowScan: readonly OverflowScanRow[];
}

export function runEconomyProbe(): EconomyProbeReport {
  const content = resolveStrategyContent();
  return {
    gameDayTicks: GAME_DAY_TICKS,
    facilityEconomics: facilityEconomics(content),
    earlyGame: runEarlyGameProbe(content, GAME_DAY_TICKS * 3),
    research: researchPacing(content),
    exploration: explorationRoiVsActual(content),
    outpost: outpostVsFacility(content),
    accounting: STRATEGY_BOTS.map((b) => resourceAccounting(b.id)),
    overflowScan: overflowScan(),
  };
}

async function main(): Promise<void> {
  const report = runEconomyProbe();
  const outPath = process.argv[2] ?? "sim/output/economy-probe.json";
  await writeJsonReport(outPath, report as unknown);
  const eg = report.earlyGame;
  console.log(`=== M40 経済プローブ ===`);
  console.log(
    `序盤(3ゲーム日)の資源律速アクション: ${String(eg.resourceGatedGapTicks.length)} 件 / ` +
      `間隔 中央値 ${String(eg.medianGapTicks)} tick(= 実分)/ 最大 ${String(eg.maxGapTicks)} tick`,
  );
  console.log(`第1ゲーム日のアクション数: ${String(eg.firstDayActionCount)}`);
  console.log(
    `研究: 開始レート ${String(report.research.startingResearchRatePerTick)}/tick ` +
      `= ${String(report.research.startingResearchRatePerGameDay)}/ゲーム日 / ` +
      `E1クリティカルパス3本 合計 ${String(report.research.e1CriticalPathTicks)} tick`,
  );
  for (const acc of report.accounting)
    console.log(`オーバーフロー損失率(40日・${acc.botId}): ${String(acc.colonyLossRate)}`);
  console.log(`→ ${outPath}`);
}

if (isMainModule(import.meta.url)) {
  await main();
}
