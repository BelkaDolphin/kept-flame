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
import { apply } from "../../src/engine/commands";
import { toRaw } from "../../src/engine/fp";
import { completedRecords } from "../../src/engine/rules/codify";
import {
  recommendExodusPlan,
  reachedEraOrder,
  resolveExodusPlan,
} from "../../src/engine/rules/exodus";
import type { EngineContent } from "../../src/engine/rules/types";
import { entitiesOfKind, livingResidents, type GameState } from "../../src/engine/state/state";

import { resolveSimContent, type ContentPatch } from "../board";
import { boardOutputScore } from "./commonActions";
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
  /** 成立した `beginResearch` の回数(選び直しも含む)。 */
  readonly researchSelectCount: number;
  /** bot が提案したが reject された(または executeExodus の下ごしらえで見送った)件数。 */
  readonly rejectedCommandCount: number;
  /** `reachedEraOrder` が最初に 1 以上になった tick(未到達なら null)。 */
  readonly firstEraOrderOneTick: number | null;
  readonly finalReachedEraOrder: number;
  readonly finalCompletedResearchCount: number;
  readonly finalCodifiedRecordCount: number;
  /** `boardOutputScore`(assist/placement.ts)の raw 値。 */
  readonly finalBoardOutputScoreRaw: number;
  readonly finalFacilityCount: number;
  readonly finalLivingPopulation: number;
}

export interface StrategyRunResult {
  readonly state: GameState;
  readonly content: EngineContent;
  readonly metrics: StrategyRunMetrics;
  /** GDD 11.5 のガードが実際にブロックした全件(検収条件のログ証跡)。 */
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
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
  let exodusCount = 0;
  let dispatchCount = 0;
  let codifyBeginCount = 0;
  let placeFacilityCount = 0;
  let researchSelectCount = 0;
  let rejectedCommandCount = 0;
  let firstEraOrderOneTick: number | null = null;

  const bot = options.bot;
  const start = performance.now();
  let cursor = state.tick;

  while (cursor < targetTick) {
    const boundary = Math.min(cursor + bot.intervalTicks, targetTick);
    const report = advanceWithReport(state, ctx, boundary);
    state = report.state;
    cursor = state.tick;

    if (firstEraOrderOneTick === null && reachedEraOrder(state, content) >= 1) {
      firstEraOrderOneTick = cursor;
    }

    if (cursor >= targetTick) break;

    // 大移動の判定は bot.decide() より**前**に行う: advance 直後(派遣が帰還
    // したかもしれないが、まだ今日の新規派遣コマンドは 1 つも積まれていない
    // 瞬間)の state を見ないと、「毎日ほぼ必ず 1 本は派遣中」という bot の
    // 定常状態のせいで大移動の機会が実質的に来なくなる(bot.decide() の後で
    // 判定すると、今日 apply した新しい派遣が即座に「派遣中」として映ってしまう)。
    if (exodusIntervalTicks !== undefined && cursor >= nextExodusCheckTick) {
      const outcome = tryExodus(state, content);
      state = outcome.state;
      if (outcome.applied) {
        exodusCount++;
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
      } else if (command.kind === "dispatchExpedition") {
        dispatchCount++;
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
  const metrics: StrategyRunMetrics = {
    finalTick: state.tick,
    exodusCount,
    dispatchCount,
    codifyBeginCount,
    placeFacilityCount,
    researchSelectCount,
    rejectedCommandCount,
    firstEraOrderOneTick,
    finalReachedEraOrder: reachedEraOrder(state, content),
    finalCompletedResearchCount: countCompletedResearch(state),
    finalCodifiedRecordCount: completedRecords(state).length,
    finalBoardOutputScoreRaw: toRaw(boardOutputScore(state, content)),
    finalFacilityCount: entitiesOfKind(state, "facility").length,
    finalLivingPopulation: livingResidents(state).length,
  };

  return { state, content, metrics, recallGuardLog, elapsedMs };
}
