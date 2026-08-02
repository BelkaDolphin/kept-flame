// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 戦略bot ランナー(複数周回対応) — M36
//   GDD 11.4(simボット検証条件)/ 10.2〜10.5(大移動)/ ADR-014(sim の形)
//
// ===========================================================================
// 1. 何をするランナーか
// ===========================================================================
//   `src/newGame.ts` の実 content(縮約ではない content/*.json そのもの)で
//   1 本のゲームを立ち上げ、{@link StrategyBot} を日次(既定)で呼びながら
//   `advanceWithReport` で進める。bot が返すコマンドは 1 個ずつ
//   `commands.ts` の {@link apply} へ渡し、reject は静かに捨てて次のコマンドへ
//   進む(bot は決定論的だが「今はできない」提案を出すことがあり、それは
//   プレイヤー操作の失敗と同じ扱いにする・commands.ts §3 の思想を踏襲)。
//
//   sim/board.ts(先行計測 #3/#4/#5 用の縮約盤面)とは別物である: あちらは
//   ADR-014 の判定数を再現する固定20人盤面、こちらは実際に住民数人から
//   施設を建て・研究を進め・派遣し・成文化し・大移動する「1 プレイスルー」を
//   模す。GDD 11.4-1(全クリティカルパステックが到達可能)・11.4-11(貪欲bot
//   の派遣頻度観測)はこちらの形でないと検証できない。
//
// ===========================================================================
// 2. 複数周回(大移動をまたぐ実行)
// ===========================================================================
//   `options.exodusIntervalTicks` を指定すると、その間隔ごとに
//   「未帰還の派遣が無ければ `recommendExodusPlan`(M28)で下ごしらえした
//   プランをそのまま `executeExodus` する」を試みる。プランは
//   `resolveExodusPlan` で事前に「容量超過が無いか」を確認してから適用する
//   (超過があれば `executeExodus` コマンドが reject するため、その前に
//   自前で確認して安全に retry する)。指定しなければ大移動は一度も起きない
//   (既定 = 無効。1 周だけの比較 run 用)。
//
// ===========================================================================
// 3. content(event を含む実 content を明示的に組み立てる)
// ===========================================================================
//   `sim/board.ts` の {@link resolveSimContent} が使う
//   `conformance/scenarios.ts` の `loadBaseRawContentBundle` は event.json を
//   読まない(conformance シナリオが event を使わないため)。本ランナーは
//   探索派遣を実際に行うので、`ContentPatch` で `content/event.json` を
//   追加してから解決する(`sim/eventReachability.ts` と同じ
//   readFileSync + JSON.parse 方式・新規 npm 依存なし)。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RawContentBundle } from "../../schema/contentBundle";

import { createNewGameState, type NewGameOptions } from "../../src/newGame";
import { type DifficultySeedId } from "../../src/difficulty";

import { advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import { compareUtf16 } from "../../src/engine/canonicalize";
import { apply } from "../../src/engine/commands";
import { toRaw } from "../../src/engine/fp";
import { completedRecords } from "../../src/engine/rules/codify";
import {
  earnedInheritPoints,
  recommendExodusPlan,
  reachedEraOrder,
  resolveExodusPlan,
} from "../../src/engine/rules/exodus";
import { rareAssetCountOf } from "../../src/engine/rules/exploration";
import { populationViewOf } from "../../src/engine/rules/population";
import { computeProductionRates } from "../../src/engine/rules/production";
import { colonyOverflowLossRate } from "../../src/engine/rules/storage";
import type { AdvanceContext, EngineContent } from "../../src/engine/rules/types";
import {
  entitiesOfKind,
  livingResidents,
  type EntityId,
  type GameState,
} from "../../src/engine/state/state";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";

import { resolveSimContent, type ContentPatch } from "../board";
import { boardOutputScore } from "./commonActions";
import { soleUncodifiedHeldTechIds } from "./recallGuard";
import type { RecallGuardLogEntry, StrategyBot } from "./types";

// --- 1. content(event を追加した実 content) --------------------------------

const CONTENT_DIR = fileURLToPath(new URL("../../content/", import.meta.url));

function readEventJson(): readonly unknown[] {
  return JSON.parse(readFileSync(`${CONTENT_DIR}event.json`, "utf8")) as readonly unknown[];
}

/** `resolveSimContent` へ渡す patch: `content/event.json` を追加する(§3)。 */
const withEventContent: ContentPatch = (raw: RawContentBundle): RawContentBundle => ({
  tech: raw.tech,
  facility: raw.facility,
  trait: raw.trait,
  adjacency: raw.adjacency,
  balance: raw.balance,
  event: readEventJson(),
});

/** 実 content を event 込みで解決する(本モジュール公開・テストの content 検査にも使う)。 */
export function resolveStrategyContent(): EngineContent {
  return resolveSimContent(withEventContent);
}

/**
 * `NewGameOptions.algoVersion` は content が持たない値であり composition root が
 * 渡す(`src/newGame.ts` §1 の doc)。simulation の判断・golden vector のいずれも
 * 読まない純粋なメタデータ(engine 側に参照箇所が無いことを確認済み)なので、
 * sim 用に固定値を割り当てる。
 */
const SIM_ALGO_VERSION = 1;

// --- 2. 入出力の型 -----------------------------------------------------------

export interface StrategyRunOptions {
  readonly bot: StrategyBot;
  /** この run が進める tick 数(絶対 tick 数)。 */
  readonly totalTicks: number;
  readonly worldSeed?: string;
  readonly difficultySeedId?: DifficultySeedId;
  /**
   * 大移動を試みる間隔(tick)。**省略時は大移動を一度も行わない**
   * (1 周だけの戦略比較 run 用の既定)。
   */
  readonly exodusIntervalTicks?: number;
}

/**
 * [M38] bot 呼び出し境界(既定 = 1 ゲーム日)ごとの観測サンプル。夜間ゲート
 * (`sim/nightlyGate.ts`)の「全 tick 維持」系 assert は、この標本の**最小値**を
 * 実測値として使う(粗粒度の標本であることは報告側で明示する)。
 */
export interface StrategyRunSample {
  readonly tick: number;
  readonly livingPopulation: number;
  /** `populationFloorOf`(GDD 7.6 の `min(寝床上限×0.5, 6)`)。 */
  readonly populationFloor: number;
  readonly bedCapacity: number;
  readonly reachedEraOrder: number;
  /** 1 tick あたり研究点産出(raw)。 */
  readonly researchRateRaw: number;
  /** 資源 ID → 1 tick あたり産出(raw)。 */
  readonly resourceRateRawById: Readonly<Record<string, number>>;
  /** 盤面全体のオーバーフロー損失率(raw・GDD 11.4-7)。 */
  readonly overflowLossRateRaw: number;
  readonly facilityCount: number;
  /** 建っている施設の**種類数**([M38] 施設14種化の観測値)。 */
  readonly distinctFacilityDefCount: number;
}

/** 5戦略bot の観測指標(タスク報告の実測値の元データ)。 */
export interface StrategyRunMetrics {
  readonly finalTick: number;
  /** 実際に成立した大移動の回数(§2)。 */
  readonly exodusCount: number;
  /** 成立した `dispatchExpedition` の本数。 */
  readonly dispatchCount: number;
  /** 成立した `beginCodification` の本数。 */
  readonly codifyBeginCount: number;
  /** 成立した `placeFacility` の本数。 */
  readonly placeFacilityCount: number;
  /** [M38] 成立した `reclaimCell` の本数(GDD 9.1)。 */
  readonly reclaimCount: number;
  /** 成立した `beginResearch` の回数(選び直しも含む)。 */
  readonly researchSelectCount: number;
  /** bot が提案したが reject された(または executeExodus の下ごしらえで見送った)件数。 */
  readonly rejectedCommandCount: number;
  /** `reachedEraOrder` が最初に 1 以上になった tick(未到達なら null)。 */
  readonly firstEraOrderOneTick: number | null;
  /** [M38] エラ order(1/2/3…)→ 最初にそこへ到達した tick(GDD 11.4-3)。 */
  readonly firstTickByEraOrder: Readonly<Record<number, number>>;
  readonly finalReachedEraOrder: number;
  readonly finalCompletedResearchCount: number;
  readonly finalCodifiedRecordCount: number;
  /** `boardOutputScore`(assist/placement.ts)の raw 値。 */
  readonly finalBoardOutputScoreRaw: number;
  readonly finalFacilityCount: number;
  readonly finalLivingPopulation: number;
  /** [M38] 建てた施設の種類(定義 ID・昇順)。GDD 6.1 の 14 種のうち何種に届いたか。 */
  readonly builtFacilityDefIds: readonly string[];
  /** [M38] 標本上の最小生存人口(GDD 11.4-9)。 */
  readonly minLivingPopulation: number;
  /** [M38] 派遣した延べ人数(GDD 11.4-11 の分母)。 */
  readonly dispatchedMemberCount: number;
  /** [M38] 派遣した人のうち「未成文の唯一保持者」だった延べ人数(GDD 11.4-11 の分子)。 */
  readonly dispatchedSoleHolderCount: number;
  /** [M38] 派遣チームが抱えた (B) レア資産の延べ件数(`rareAssetCountOf`・GDD 8.6)。 */
  readonly dispatchedRareAssetCount: number;
  /** [M38] この state を今畳んだときに得る継承点(GDD 10.3・11.4-6)。 */
  readonly earnedInheritPoints: number;
  /** [M38] 大移動が成立するたびに記録した「その周回の継承点」(GDD 11.4-6)。 */
  readonly inheritPointsPerCycle: readonly number[];
  /** [M38] run 中に実際に発生した想起困難の件数(GDD 11.2/11.4-8 の実 run 観測)。 */
  readonly recallOccurrenceCount: number;
  /** [M38] 想起困難の判定対象になった延べ「住民 × ゲーム週」(11.4-8 の分母)。 */
  readonly residentWeeksObserved: number;
}

export interface StrategyRunResult {
  readonly state: GameState;
  readonly content: EngineContent;
  readonly metrics: StrategyRunMetrics;
  /** GDD 11.5 のガードが実際にブロックした全件(検収条件のログ証跡)。 */
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
  /** [M38] bot 呼び出し境界ごとの観測標本(夜間ゲートの入力)。 */
  readonly samples: readonly StrategyRunSample[];
  /** 実行時間(ms)。`performance.now()` の差分。計測メタとしてのみ使う。 */
  readonly elapsedMs: number;
}

// --- 3. NewGameOptions の組み立て(exactOptionalPropertyTypes 対応) --------
//
// `NewGameOptions` の省略可フィールドへ明示的に `undefined` を渡すと
// exactOptionalPropertyTypes(tsconfig strict)がエラーにするため、
// `commands.ts` の `payFacilityCost` 等と同じく分岐で作り分ける
// (生スプレッドは使わない)。

function buildNewGameOptions(run: StrategyRunOptions): NewGameOptions {
  const { worldSeed, difficultySeedId } = run;
  if (worldSeed === undefined) {
    if (difficultySeedId === undefined) return { algoVersion: SIM_ALGO_VERSION };
    return { algoVersion: SIM_ALGO_VERSION, difficultySeedId };
  }
  if (difficultySeedId === undefined) return { algoVersion: SIM_ALGO_VERSION, worldSeed };
  return { algoVersion: SIM_ALGO_VERSION, worldSeed, difficultySeedId };
}

function countCompletedResearch(state: GameState): number {
  let count = 0;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick !== null) count++;
  }
  return count;
}

// --- 3b. [M38] 観測(夜間ゲートの入力) ---------------------------------------

/** bot 呼び出し境界 1 点ぶんの観測(`StrategyRunSample`)。 */
function sampleOf(
  state: GameState,
  ctx: AdvanceContext,
  content: EngineContent,
  reachedEraOrderValue: number,
): StrategyRunSample {
  const rates = computeProductionRates(state, ctx);
  const resourceRateRawById: Record<string, number> = {};
  for (const [resourceId, rateFix] of rates.resourceRateByResourceId) {
    resourceRateRawById[String(resourceId)] = toRaw(rateFix);
  }
  const view = populationViewOf(state, content);
  const defIds = new Set<EntityId>();
  let facilityCount = 0;
  for (const facility of entitiesOfKind(state, "facility")) {
    defIds.add(facility.defId);
    facilityCount++;
  }
  return {
    tick: state.tick,
    livingPopulation: view.living,
    populationFloor: view.floor,
    bedCapacity: view.bedCapacity,
    reachedEraOrder: reachedEraOrderValue,
    researchRateRaw: toRaw(rates.researchRateFix),
    resourceRateRawById,
    overflowLossRateRaw: toRaw(colonyOverflowLossRate(state)),
    facilityCount,
    distinctFacilityDefCount: defIds.size,
  };
}

/** 派遣 1 本ぶんの「唯一保持者 / (B)レア資産」観測(GDD 11.4-11)。 */
function observeDispatchHolders(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
): { memberCount: number; soleHolderCount: number; rareAssetCount: number } {
  let soleHolderCount = 0;
  for (const memberId of memberIds) {
    if (soleUncodifiedHeldTechIds(state, memberId).length > 0) soleHolderCount++;
  }
  return {
    memberCount: memberIds.length,
    soleHolderCount,
    rareAssetCount: rareAssetCountOf(state, content, memberIds),
  };
}

// --- 4. 大移動の下ごしらえ(§2) ----------------------------------------------

/**
 * 大移動 1 回を試みる。適用できたら true(呼び出し側が ctx を作り直す)。
 * 「未帰還の派遣がある」「乗員 0 名」「容量超過」はどれも異常ではなく
 * 「今回は見送り、次の間隔でまた試す」を意味する(呼び出し側が retry する)。
 */
function tryExodus(
  state: GameState,
  content: EngineContent,
): { readonly state: GameState; readonly applied: boolean; readonly attempted: boolean } {
  if (state.dispatchSnapshots.length > 0) return { state, applied: false, attempted: false };

  const plan = recommendExodusPlan(state, content);
  if (plan.crewIds.length === 0) return { state, applied: false, attempted: false };

  const resolution = resolveExodusPlan(state, content, plan);
  if (resolution.droppedCrewIds.length > 0 || resolution.droppedRecordIds.length > 0) {
    return { state, applied: false, attempted: false };
  }

  const result = apply(state, content, {
    kind: "executeExodus",
    recordIds: plan.recordIds,
    crewIds: plan.crewIds,
  });
  if (!result.ok) return { state, applied: false, attempted: true };
  return { state: result.state, applied: true, attempted: true };
}

// --- 5. 入口 -----------------------------------------------------------------

/**
 * 1 run 実行する(M36 の 5戦略bot 検証ハーネス)。**bot 自体は state と
 * worldSeed(+tick)だけの純関数なので、この関数も同一入力から常に同一結果を
 * 返す**(`performance.now()` は elapsedMs のみに使う計測メタ)。
 */
export function runStrategyBot(options: StrategyRunOptions): StrategyRunResult {
  const content = resolveStrategyContent();
  let state = createNewGameState(content, buildNewGameOptions(options));
  let ctx = createAdvanceContext(state, content);

  const targetTick = state.tick + options.totalTicks;
  const exodusIntervalTicks = options.exodusIntervalTicks;
  let nextExodusCheckTick =
    exodusIntervalTicks === undefined ? Number.POSITIVE_INFINITY : state.tick + exodusIntervalTicks;

  const recallGuardLog: RecallGuardLogEntry[] = [];
  const samples: StrategyRunSample[] = [];
  const firstTickByEraOrder: Record<number, number> = {};
  const inheritPointsPerCycle: number[] = [];
  let exodusCount = 0;
  let dispatchCount = 0;
  let codifyBeginCount = 0;
  let placeFacilityCount = 0;
  let reclaimCount = 0;
  let researchSelectCount = 0;
  let rejectedCommandCount = 0;
  let firstEraOrderOneTick: number | null = null;
  let dispatchedMemberCount = 0;
  let dispatchedSoleHolderCount = 0;
  let dispatchedRareAssetCount = 0;
  let recallOccurrenceCount = 0;
  let residentWeekTicks = 0;

  const bot = options.bot;
  const start = performance.now();
  let cursor = state.tick;

  while (cursor < targetTick) {
    const boundary = Math.min(cursor + bot.intervalTicks, targetTick);
    const populationBefore = livingResidents(state).length;
    const tickBefore = state.tick;
    const report = advanceWithReport(state, ctx, boundary);
    state = report.state;
    recallOccurrenceCount += report.recallOccurrenceCount;
    residentWeekTicks += populationBefore * (state.tick - tickBefore);
    cursor = state.tick;

    const eraOrder = reachedEraOrder(state, content);
    if (firstEraOrderOneTick === null && eraOrder >= 1) firstEraOrderOneTick = cursor;
    for (let order = 1; order <= eraOrder; order++) {
      if (firstTickByEraOrder[order] === undefined) firstTickByEraOrder[order] = cursor;
    }
    samples.push(sampleOf(state, ctx, content, eraOrder));

    if (cursor >= targetTick) break;

    // 大移動の判定は bot.decide() より**前**に行う: advance 直後(派遣が帰還
    // したかもしれないが、まだ今日の新規派遣コマンドは 1 つも積まれていない
    // 瞬間)の state を見ないと、「毎日ほぼ必ず 1 本は派遣中」という bot の
    // 定常状態のせいで大移動の機会が実質的に来なくなる(bot.decide() の後で
    // 判定すると、今日 apply した新しい派遣が即座に「派遣中」として映ってしまう)。
    if (exodusIntervalTicks !== undefined && cursor >= nextExodusCheckTick) {
      // 畳む直前の state で「その周回の継承点」を記録する(GDD 10.3・11.4-6)。
      const pointsBeforeExodus = earnedInheritPoints(state, content);
      const outcome = tryExodus(state, content);
      state = outcome.state;
      if (outcome.applied) {
        exodusCount++;
        inheritPointsPerCycle.push(pointsBeforeExodus);
        ctx = createAdvanceContext(state, content);
        nextExodusCheckTick = cursor + exodusIntervalTicks;
      } else {
        if (outcome.attempted) rejectedCommandCount++;
        // 未帰還の派遣待ち・容量超過・乗員0名のいずれでも、次の bot 呼び出しで再試行する。
        nextExodusCheckTick = cursor + bot.intervalTicks;
      }
    }

    const decision = bot.decide(state, content, ctx.worldSeedU32, cursor);
    recallGuardLog.push(...decision.recallGuardLog);

    let placementChanged = false;
    for (const command of decision.commands) {
      // 派遣は「適用前の state」で唯一保持/(B)レアを数える(GDD 11.4-11 の観測)。
      const dispatchObservation =
        command.kind === "dispatchExpedition"
          ? observeDispatchHolders(state, content, command.teamResidentIds)
          : null;

      const result = apply(state, content, command);
      if (!result.ok) {
        rejectedCommandCount++;
        continue;
      }
      state = result.state;
      if (command.kind === "placeFacility") {
        placeFacilityCount++;
        placementChanged = true;
      } else if (command.kind === "demolishFacility" || command.kind === "upgradeFacility") {
        placementChanged = true;
      } else if (command.kind === "reclaimCell") {
        reclaimCount++;
        placementChanged = true;
      } else if (command.kind === "dispatchExpedition") {
        dispatchCount++;
        if (dispatchObservation !== null) {
          dispatchedMemberCount += dispatchObservation.memberCount;
          dispatchedSoleHolderCount += dispatchObservation.soleHolderCount;
          dispatchedRareAssetCount += dispatchObservation.rareAssetCount;
        }
      } else if (command.kind === "beginCodification") {
        codifyBeginCount++;
      } else if (command.kind === "beginResearch") {
        researchSelectCount++;
      }
    }
    // advance.ts §2: 配置変更コマンドを適用したらコンテキストを作り直す。
    if (placementChanged) ctx = createAdvanceContext(state, content);
  }

  const elapsedMs = performance.now() - start;
  const builtDefIds = new Set<string>();
  for (const facility of entitiesOfKind(state, "facility")) builtDefIds.add(String(facility.defId));
  let minLivingPopulation = livingResidents(state).length;
  for (const sample of samples) {
    if (sample.livingPopulation < minLivingPopulation)
      minLivingPopulation = sample.livingPopulation;
  }

  const metrics: StrategyRunMetrics = {
    finalTick: state.tick,
    exodusCount,
    dispatchCount,
    codifyBeginCount,
    placeFacilityCount,
    reclaimCount,
    researchSelectCount,
    rejectedCommandCount,
    firstEraOrderOneTick,
    firstTickByEraOrder,
    finalReachedEraOrder: reachedEraOrder(state, content),
    finalCompletedResearchCount: countCompletedResearch(state),
    finalCodifiedRecordCount: completedRecords(state).length,
    finalBoardOutputScoreRaw: toRaw(boardOutputScore(state, content)),
    finalFacilityCount: entitiesOfKind(state, "facility").length,
    finalLivingPopulation: livingResidents(state).length,
    builtFacilityDefIds: [...builtDefIds].sort(compareUtf16),
    minLivingPopulation,
    dispatchedMemberCount,
    dispatchedSoleHolderCount,
    dispatchedRareAssetCount,
    earnedInheritPoints: earnedInheritPoints(state, content),
    inheritPointsPerCycle,
    recallOccurrenceCount,
    residentWeeksObserved: residentWeekTicks / (GAME_DAY_TICKS * 7),
  };

  return { state, content, metrics, recallGuardLog, samples, elapsedMs };
}
