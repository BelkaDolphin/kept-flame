// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 夜間ゲート(GDD 11.4 の 11 条件)— M38
//
// ===========================================================================
// 0. このファイルの契約
// ===========================================================================
//   GDD 11.4 は「simボット検証条件(毎晩アサート・**全て不等式**)」として 11 条件を
//   定義している。本モジュールはその 11 条件を {@link NightlyAssert} として実装
//   する。**1 件たりとも bool 判定へ化けさせない**ため、全 assert が
//
//       measured(実測値) ・ threshold(閾値) ・ comparator(不等号)
//
//   の 3 つを必ず持ち、`status` はこの 3 つから機械的に導かれる
//   ({@link evaluateComparator} が唯一の判定器。個別の if 文で pass/fail を
//   書く場所はこのファイルに 1 つも無い)。GDD が「bool」と書いている 11.4-1 も
//   「到達 bot 数 ≥ 1」という不等式へ落として実装する。
//
//   条件の一部は **現行の content / 実装では構造的に検証できない**。それらは
//   `status: "unverifiable"` とし、`unverifiableReason`(なぜ測れないか)と
//   `unblockCondition`(何が揃えば測れるか)を機械可読で持たせる。**数値を
//   捏造して pass にはしない**(先行計測の `unmeasured` 前例と同じ流儀・
//   docs/measurements/summary.md §1)。
//
// ===========================================================================
// 1. owner("structural" / "balance")の意味 — CI 赤色化の線引き
// ===========================================================================
//   `owner: "structural"` = engine / bot / content の**構造**が壊れていれば落ちる
//   assert(ソフトロック・人口下限・決定論・カバレッジ等)。週次 content PR の
//   guardrail(`.github/workflows/content-guardrail.yml` の「段階sim1000」)は
//   **この束だけ**を必須ゲートにする(`sim/stagedSim.ts`)。
//
//   `owner: "balance"` = 数値バランスの収束条件(到達 tick レンジ・頻度レンジ等)。
//   これはロードマップ M39〜M41(E1/E2/E3 段階収束)の**入力**であり、M38 時点で
//   赤いのは想定内である。夜間ゲート CLI(`npm run sim:nightly-gate`)は全 11 条件
//   を評価して balance の fail でも終了コード 1 を返す(= M39 の作業対象が
//   機械可読で出る)が、content PR の CI をそれで赤くはしない。
//   **★この線引きは M38 の設計判断**(タスク報告の ★ リスト参照)。
//
// ===========================================================================
// 2. 決定論
// ===========================================================================
//   Math.random / Date.now / new Date は 1 つも使わない(`performance.now()` は
//   実行時間メタのみ・sim/runner.ts と同じ規律)。同じ options なら
//   `assertsOnly` 部分は常にバイト同一の JSON になる(`elapsedMs` を除く)。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJsonOfState, digestOfCanonicalJson } from "../conformance/goldenVector";

import { compareUtf16 } from "../src/engine/canonicalize";
import { soleKeeperRecoverabilityIssues } from "../src/engine/graph";
import { FIX_ONE, fixFromRaw, toRaw } from "../src/engine/fp";
import { planCodification } from "../src/engine/rules/codify";
import { inheritTierCost, inheritTierMax } from "../src/engine/rules/exodus";
import { explorationRoi, rareAssetCountOf } from "../src/engine/rules/exploration";
import { codifyDeadlineMarginTicks, memoryDecayDelayFor } from "../src/engine/rules/lifespan";
import { isTechUnlocked } from "../src/engine/rules/techMemory";
import { criticalPathTechIds, erasInOrder } from "../src/engine/rules/techTree";
import type { DistanceBand, EngineContent } from "../src/engine/rules/types";
import { livingResidents, type EntityId } from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";

import { isMainModule, writeJsonReport } from "./cliUtil";
import { measureEventCoverageFrequency } from "./eventReachability";
import { measureRecallFrequency } from "./recallFrequency";
import { ADVERSARIAL_BOTS, runAdversarialBotAsNewGame } from "./strategy/adversarialBots";
import { STRATEGY_BOTS } from "./strategy/bots";
import { soleUncodifiedHeldTechIds } from "./strategy/recallGuard";
import {
  resolveStrategyContent,
  runStrategyBot,
  type StrategyRunResult,
} from "./strategy/runStrategy";

// --- 1. assert の型と唯一の判定器 --------------------------------------------

/** 不等号。`in-range` は `threshold <= measured <= thresholdUpper`。 */
export type AssertComparator = ">=" | ">" | "<=" | "<" | "in-range";

export type AssertStatus = "pass" | "fail" | "unverifiable";

/** GDD 11.4 の 1 条件(または条件内の 1 項)。 */
export interface NightlyAssert {
  /** `gdd-11.4-<番号>[<枝>]`。機械可読の安定 ID。 */
  readonly id: string;
  readonly gddRef: string;
  readonly title: string;
  /** 実際に評価している不等式(人間可読)。bool へ化けていないことの自己申告。 */
  readonly inequality: string;
  readonly comparator: AssertComparator;
  /** 実測値。`unverifiable` のときは測れた範囲の値(意味は detail に書く)。 */
  readonly measured: number;
  readonly threshold: number;
  /** `in-range` のときの上限。 */
  readonly thresholdUpper: number | null;
  readonly unit: string;
  readonly status: AssertStatus;
  readonly owner: "structural" | "balance";
  /** 実測値の出どころ(どの run / どの静的解析か)。 */
  readonly detail: string;
  /** `unverifiable` のときだけ非 null。 */
  readonly unverifiableReason: string | null;
  /** `unverifiable` のときだけ非 null(何が揃えば測れるか)。 */
  readonly unblockCondition: string | null;
}

/** **唯一の pass/fail 判定器**(§0)。個別 if で status を作る場所を作らない。 */
export function evaluateComparator(
  comparator: AssertComparator,
  measured: number,
  threshold: number,
  thresholdUpper: number | null,
): boolean {
  switch (comparator) {
    case ">=":
      return measured >= threshold;
    case ">":
      return measured > threshold;
    case "<=":
      return measured <= threshold;
    case "<":
      return measured < threshold;
    case "in-range":
      return thresholdUpper !== null && measured >= threshold && measured <= thresholdUpper;
  }
}

interface AssertInput {
  readonly id: string;
  readonly gddRef: string;
  readonly title: string;
  readonly inequality: string;
  readonly comparator: AssertComparator;
  readonly measured: number;
  readonly threshold: number;
  readonly thresholdUpper?: number;
  readonly unit: string;
  readonly owner: "structural" | "balance";
  readonly detail: string;
  /** 与えると status は無条件で `unverifiable`(measured は参考値として残す)。 */
  readonly unverifiableReason?: string;
  readonly unblockCondition?: string;
}

function makeAssert(input: AssertInput): NightlyAssert {
  const thresholdUpper = input.thresholdUpper ?? null;
  const unverifiable = input.unverifiableReason !== undefined;
  const status: AssertStatus = unverifiable
    ? "unverifiable"
    : evaluateComparator(input.comparator, input.measured, input.threshold, thresholdUpper)
      ? "pass"
      : "fail";
  return {
    id: input.id,
    gddRef: input.gddRef,
    title: input.title,
    inequality: input.inequality,
    comparator: input.comparator,
    measured: input.measured,
    threshold: input.threshold,
    thresholdUpper,
    unit: input.unit,
    status,
    owner: input.owner,
    detail: input.detail,
    unverifiableReason: input.unverifiableReason ?? null,
    unblockCondition: input.unblockCondition ?? null,
  };
}

// --- 2. 実行オプション --------------------------------------------------------

export interface NightlyGateOptions {
  /** `"full"` = 毎晩ゲート / `"quick"` = CI・テスト用の縮小版。 */
  readonly profile?: "full" | "quick";
  /** 戦略bot run に使う worldSeed 群(省略時はプロファイル既定)。 */
  readonly strategySeeds?: readonly string[];
  /** 戦略bot 1 run の tick 数(省略時はプロファイル既定)。 */
  readonly runTicks?: number;
  /** 決定論 assert(11.4-5)の試行回数。 */
  readonly determinismRuns?: number;
  /** event カバレッジ(11.4-10)の試行回数。 */
  readonly eventCoverageSamples?: number;
  /** 想起困難頻度(11.4-8)の縮約盤面 seed 数。 */
  readonly recallSeedCount?: number;
}

interface ResolvedOptions {
  readonly profile: "full" | "quick";
  readonly strategySeeds: readonly string[];
  readonly runTicks: number;
  readonly determinismRuns: number;
  readonly determinismTicks: number;
  readonly eventCoverageSamples: number;
  readonly recallSeedCount: number;
}

/** GDD 11.4-10 の「1000回中最低N回」の N(GDD が例示した 20 をそのまま採る)。 */
export const EVENT_COVERAGE_MIN_HITS = 20;
/** GDD 11.4-10 の「1000回」。 */
export const EVENT_COVERAGE_SAMPLES_FULL = 1000;
/** GDD 11.4-5 の「1000回」。 */
export const DETERMINISM_RUNS_FULL = 1000;
/** GDD 11.4-7 の「オーバーフロー損失率 < 15%」。 */
export const OVERFLOW_LOSS_RATE_MAX_FIX_RAW = 150_000;
/**
 * [M75] GDD 11.4-7a の拠点網 ROI 下限(**1.2**・[2026-08-07裁定・台帳v24])。
 *
 * GDD 11.4-7 は M74 まで ROI の数値閾値を持たず、本 assert は
 * 「閾値が無い + bot が拠点を 1 基も建てない」の二重の理由で unverifiable
 * だった(M39 が後者を『計測器の穴』として機械確認・台帳v22)。
 *
 * 1.2 の根拠: 帯平均 ROI の下限と同値に揃えた(同じ「投資に対する見返り」の
 * 尺度に 2 通りの下限を作らない)。実測の余裕は十分ある —— content の 3 タイプ
 * の supply/upkeep 比は 鉱山 1.60 / 農園 3.16 / 林 2.22
 * (docs/measurements/balance-m40-e2-recalibration-2026-08-03.json)で、
 * 最も薄い鉱山を最も高い距離帯係数(deep 1.8)で常駐 1 名で建てても 1.379。
 * GDD 9.2 の「維持 > 供給の死重が生じない baseSupply 初期値を sim で担保」を
 * 不等式へ落とすと下限 1.0 だが、それでは翳り率や (B) 喪失の余地が無いので
 * 1.2 を取る。
 */
export const OUTPOST_NETWORK_ROI_MIN = 1.2;
/** GDD 11.4-8 のレンジ(回/住民/週)。 */
export const RECALL_PER_RESIDENT_WEEK_MIN = 1;
export const RECALL_PER_RESIDENT_WEEK_MAX = 3;
/**
 * GDD 11.4-3 の E3 到達レンジ(日)。
 *
 * **[2026-08-06・Phase D(M41 本体)] [7,18] → [8,16] へ改訂(= GDD 5.2 / 11.4-3 の
 * 原設計値へ復帰)。** 実測が 15 run すべて 8〜16 日に収まったことによる。
 *
 * 経緯:
 *   ・[2026-08-02裁定・台帳v15 必-2] で [8,16] → [7,18] へ**緩めた**。当時の
 *     律速は「研究点の供給 vs コスト」ではなく **bot が壁テックまでに踏破する
 *     tech の本数**(1 ゲーム日 1 本の意思決定 cadence)で、本数比 2.29 に対し
 *     旧レンジの窓が 16/8 = 2.0 倍しかなく content 数値だけでは原理的に
 *     収められないと M39 が証明したため
 *     (docs/measurements/balance-m39-e1-convergence-2026-08-02.json)。
 *   ・その原因(cadence)は [Phase A] の研究 1 日複数本化で、第2ゲートの不在は
 *     M67(fieldRequirement 実効化)で解消済み。Phase D では **bot が「研究が
 *     実地要件で止まっている作業場」を優先して回す**ようになり、戦略差は
 *     「研究点の供給量」という本来の軸だけに戻った。
 *   ・Phase D 実測(full profile・5戦略bot × 3seed = 15 run):
 *     最小 **8.0 日**(greedy 3seed / placementVariant 3seed / codifyFirst nightly-a)・
 *     最大 **14.0 日**(explorationFirst/nightly-c)。レンジ上限を実測最大の 14 では
 *     なく設計値 16 に置くのは、**assert を実測へ後追いで貼り替えない**ため
 *     (余裕 2 日 = 12.5%。M64 のときの「上限 18 日ちょうど・余裕ゼロ」を繰り返さない)。
 *     正本は sim/output/nightly-gate-report.phaseD.json。
 * GDD 5.2 のエラ表と GDD 11.4-3 の本文も同日に [8,16] へ戻してある(両者が
 * 食い違ったまま運用しない、が本改訂の主目的)。
 */
export const ERA3_REACH_DAYS_MIN = 8;
export const ERA3_REACH_DAYS_MAX = 16;
/** GDD 11.4-6 の「全系統上限 10〜18 周」。 */
export const ALL_TRACK_MAX_CYCLES_MIN = 10;
export const ALL_TRACK_MAX_CYCLES_MAX = 18;
/**
 * GDD 10.3 の代表周回(到達E3 + 成文化率60% + 生存12人 = 84点)。
 * `rules/exodus.ts` の `earnedInheritPoints` の doc が同じ数値を持つ。
 */
export const REPRESENTATIVE_CYCLE_POINTS = 84;
/** [M38] era 移行後の研究速度低下を見る窓(GDD 11.4-7 の「N tick 窓」の N)。 */
export const ERA_TRANSITION_WINDOW_TICKS = GAME_DAY_TICKS * 3;

function resolveOptions(options: NightlyGateOptions): ResolvedOptions {
  const profile = options.profile ?? "full";
  const full = profile === "full";
  return {
    profile,
    strategySeeds:
      options.strategySeeds ?? (full ? ["nightly-a", "nightly-b", "nightly-c"] : ["nightly-quick"]),
    runTicks: options.runTicks ?? GAME_DAY_TICKS * (full ? 40 : 20),
    determinismRuns: options.determinismRuns ?? (full ? DETERMINISM_RUNS_FULL : 25),
    determinismTicks: GAME_DAY_TICKS * 2,
    eventCoverageSamples:
      options.eventCoverageSamples ?? (full ? EVENT_COVERAGE_SAMPLES_FULL : 120),
    recallSeedCount: options.recallSeedCount ?? (full ? 8 : 2),
  };
}

// --- 3. content 側の読み取り(EngineContent に写っていない値) ------------------

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

function readContentJson(fileName: string): unknown {
  return JSON.parse(readFileSync(`${CONTENT_DIR}${fileName}`, "utf8")) as unknown;
}

/**
 * `balance.safetyFactor`(GDD 11.3 の 1.5 統一)。`EngineContent` へは写って
 * いないため、schema 検証済みの JSON から直接読む(`sim/eventReachability.ts`
 * と同じ readFileSync + JSON.parse 方式・新規依存なし)。
 */
function readSafetyFactor(): number {
  const balance = readContentJson("balance.json") as { readonly safetyFactor?: number };
  return balance.safetyFactor ?? 1.5;
}

interface TechJson {
  readonly id: string;
  readonly lossClass: "criticalRecoverable" | "rareIrreversible";
  readonly prereqs: readonly string[];
  readonly fieldRequirement: {
    readonly facility: string;
    readonly recipe: string;
    readonly count: number;
  };
  readonly unlocks: readonly string[];
}
interface FacilityJson {
  readonly id: string;
  readonly slots: {
    readonly lv1: number;
    readonly lv2: number;
    readonly lv3: number;
    readonly lv4: number;
    readonly lv5: number;
  };
  readonly buildCost?: { readonly resourceId: string };
}

// --- 4. 実 run の収集 ---------------------------------------------------------

interface StrategyRunRecord {
  readonly botId: string;
  readonly seed: string;
  readonly result: StrategyRunResult;
}

function runStrategyMatrix(options: ResolvedOptions): readonly StrategyRunRecord[] {
  const records: StrategyRunRecord[] = [];
  for (const bot of STRATEGY_BOTS) {
    for (const seed of options.strategySeeds) {
      records.push({
        botId: bot.id,
        seed,
        result: runStrategyBot({ bot, totalTicks: options.runTicks, worldSeed: seed }),
      });
    }
  }
  return records;
}

// --- 5. 個別 assert -----------------------------------------------------------

/** 11.4-1: 全クリティカルパステックが ≥1 戦略botで到達可能。 */
function assertCriticalPathReachable(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): NightlyAssert {
  const criticalIds: EntityId[] = [];
  for (const era of erasInOrder(content)) criticalIds.push(...criticalPathTechIds(content, era.id));

  let minBots = Number.POSITIVE_INFINITY;
  let worstTechId = "(なし)";
  for (const techId of criticalIds) {
    let bots = 0;
    for (const record of records) {
      if (isTechUnlocked(record.result.state, techId)) {
        bots++;
      }
    }
    if (bots < minBots) {
      minBots = bots;
      worstTechId = String(techId);
    }
  }
  if (criticalIds.length === 0) {
    return makeAssert({
      id: "gdd-11.4-1",
      gddRef: "GDD 11.4-1",
      title: "全クリティカルパステックが ≥1 戦略botで到達可能",
      inequality: "min_t |{run : t が解禁済み}| >= 1",
      comparator: ">=",
      measured: 0,
      threshold: 1,
      unit: "run",
      owner: "structural",
      detail: "content にクリティカルパステックが 1 本も無い",
      unverifiableReason: "content の era 定義または壁テックが空でクリティカルパスが導けない",
      unblockCondition: "content/balance.json の eras[].gateTechId と content/tech.json の整備",
    });
  }
  return makeAssert({
    id: "gdd-11.4-1",
    gddRef: "GDD 11.4-1",
    title: "全クリティカルパステックが ≥1 戦略botで到達可能",
    inequality: "min_t |{run : t が解禁済み}| >= 1",
    comparator: ">=",
    measured: minBots,
    threshold: 1,
    unit: "run",
    owner: "structural",
    detail:
      `クリティカルパス ${String(criticalIds.length)} 本 × ${String(records.length)} run。` +
      `最少到達は "${worstTechId}" の ${String(minBots)} run`,
  });
}

/** 各 run の「クリティカル資源」= 開墾コスト資源 ∪ その run が実際に建てた施設の建設コスト資源。 */
function criticalResourceIdsOf(
  content: EngineContent,
  facilities: readonly FacilityJson[],
  builtDefIds: readonly string[],
): readonly string[] {
  const ids = new Set<string>();
  const reclaimResource = content.reclaim?.costResourceId;
  if (reclaimResource !== undefined) ids.add(String(reclaimResource));
  for (const facility of facilities) {
    if (!builtDefIds.includes(facility.id)) continue;
    const resourceId = facility.buildCost?.resourceId;
    if (resourceId !== undefined) ids.add(resourceId);
  }
  return [...ids].sort();
}

/**
 * 11.4-2a: クリティカル資源の生産経路が run 中ずっと存在する(= ソフトロックゼロ)。
 *
 * **[M38] GDD 11.4-2 の「>0 を全tick維持」を字義どおり `min_標本(レート) > 0` に
 * すると、GDD 11.2 の想起困難と構造的に両立しない**: 想起困難は「当該住民の当該
 * tech 関連生産のみ停止」であり、その資源の就労者が 1 人しか居ない盤面では
 * その間レートが 0 になる(設計どおりの挙動)。よって不等式は
 * 「その run のどこかで産出できていること(= 産出経路の存在)」に取り、
 * **瞬時値の 0 率は同条件の別 assert(2a-strict)として正直に別立て**にする。
 */
function assertNoSoftlockRates(
  content: EngineContent,
  facilities: readonly FacilityJson[],
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  let minMaxRateRaw = Number.POSITIVE_INFINITY;
  let worstCapability = "(なし)";
  let maxZeroRatePermille = 0;
  let worstZero = "(なし)";
  let pairCount = 0;

  for (const record of records) {
    const criticalIds = criticalResourceIdsOf(
      content,
      facilities,
      record.result.metrics.builtFacilityDefIds,
    );
    // 建設途上の標本は「まだその資源を作る施設を建てていない」だけでソフト
    // ロックではないため、その施設が建った後(= 後半の標本)だけを見る。
    const samples = record.result.samples;
    const half = Math.floor(samples.length / 2);
    const tail = samples.slice(half);
    for (const resourceId of criticalIds) {
      pairCount++;
      let maxRate = 0;
      let zeroCount = 0;
      for (const sample of tail) {
        const rate = sample.resourceRateRawById[resourceId] ?? 0;
        if (rate > maxRate) maxRate = rate;
        if (rate <= 0) zeroCount++;
      }
      if (maxRate < minMaxRateRaw) {
        minMaxRateRaw = maxRate;
        worstCapability = `${record.botId}/${record.seed}:${resourceId}`;
      }
      const zeroPermille = tail.length === 0 ? 0 : Math.round((zeroCount / tail.length) * 1000);
      if (zeroPermille > maxZeroRatePermille) {
        maxZeroRatePermille = zeroPermille;
        worstZero = `${record.botId}/${record.seed}:${resourceId}(${String(zeroCount)}/${String(tail.length)} 標本)`;
      }
    }
  }

  return [
    makeAssert({
      id: "gdd-11.4-2a",
      gddRef: "GDD 11.4-2",
      title: "ソフトロックゼロ(クリティカル資源の産出経路が存在)",
      inequality: "min_(run, 資源) max_標本(生産レート raw) > 0",
      comparator: ">",
      measured: Number.isFinite(minMaxRateRaw) ? minMaxRateRaw : 0,
      threshold: 0,
      unit: "1e6 raw / tick",
      owner: "structural",
      detail:
        "クリティカル資源 = 開墾コスト資源 ∪ その run が建てた施設の建設コスト資源。" +
        `${String(records.length)} run × 計 ${String(pairCount)} (run,資源) ペアを run 後半の標本で評価。最小は ${worstCapability}`,
    }),
    makeAssert({
      id: "gdd-11.4-2a-strict",
      gddRef: "GDD 11.4-2",
      title: "クリティカル資源のレートが**全 tick** > 0(字義どおりの読み)",
      inequality: "max_(run, 資源) レート 0 の標本率(‰) <= 閾値",
      comparator: "<=",
      measured: maxZeroRatePermille,
      threshold: 0,
      unit: "‰",
      owner: "balance",
      detail: `最悪は ${worstZero}`,
      unverifiableReason:
        "GDD 11.4-2 の『全tick維持』と GDD 11.2 の想起困難(当該住民の当該生産のみ停止)は、" +
        "その資源の就労者が 1 人しか居ない盤面では構造的に両立しない(停止中はレートが 0 になるのが設計どおりの挙動)。" +
        "『全tick』の許容 0 率が GDD に無いため閾値を置けない",
      unblockCondition:
        "GDD 11.4-2 に「クリティカル資源の停止許容率」または「就労者の冗長化要件」を明記する(M39 の裁定事項)。" +
        "実測値(最悪 0 率)は measured に出してあるので、閾値が決まれば即判定できる",
    }),
  ];
}

/** 11.4-2b: (A)テック再取得ルートの静的解析(prereq グラフ + 実地要件)。 */
function assertRecoverability(
  techs: readonly TechJson[],
  facilities: readonly FacilityJson[],
): NightlyAssert {
  const issues = soleKeeperRecoverabilityIssues(techs, facilities);
  return makeAssert({
    id: "gdd-11.4-2b",
    gddRef: "GDD 11.4-2",
    title: "(A)技術再取得ルート常時存在(静的グラフ解析)",
    inequality: "再取得不能な (A) テック件数 <= 0",
    comparator: "<=",
    measured: issues.length,
    threshold: 0,
    unit: "件",
    owner: "structural",
    detail:
      issues.length === 0
        ? `tech ${String(techs.length)} 本 / facility ${String(facilities.length)} 種で再取得不能ゼロ`
        : issues.map((issue) => `${issue.techId}: ${issue.kind}`).join(" / "),
  });
}

/** 11.4-3: エラ壁テック到達 tick が設計レンジ内(E3 = 8〜16 日)。 */
function assertEraReachRange(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  const eras = erasInOrder(content);
  const asserts: NightlyAssert[] = [];
  for (const era of eras) {
    const order = era.order;
    const ticks: { readonly label: string; readonly tick: number }[] = [];
    for (const record of records) {
      const tick = record.result.metrics.firstTickByEraOrder[order];
      if (tick !== undefined) ticks.push({ label: `${record.botId}/${record.seed}`, tick });
    }
    const reachedCount = ticks.length;
    const isE3 = order === 3;

    if (!isE3) {
      // GDD 11.4-3 は E3 のレンジしか数値を与えていない。E1/E2 は「全戦略が到達
      // すること」だけを不等式にし、レンジ判定は unverifiable として正直に出す。
      asserts.push(
        makeAssert({
          id: `gdd-11.4-3-era${String(order)}`,
          gddRef: "GDD 11.4-3",
          title: `エラ order=${String(order)} の壁テック到達レンジ`,
          inequality: "設計レンジ下限 <= 到達日 <= 設計レンジ上限",
          comparator: "in-range",
          measured: reachedCount === 0 ? 0 : Math.max(...ticks.map((t) => t.tick)) / GAME_DAY_TICKS,
          threshold: 0,
          thresholdUpper: 0,
          unit: "ゲーム日",
          owner: "balance",
          detail:
            reachedCount === 0
              ? "どの run も到達していない"
              : ticks.map((t) => `${t.label}=${(t.tick / GAME_DAY_TICKS).toFixed(1)}日`).join(" "),
          unverifiableReason: `GDD 11.4-3 は E3(8〜16日)しか設計レンジの数値を与えていない(era order=${String(order)} のレンジが正本に存在しない)`,
          unblockCondition: `GDD 11.4-3 に era "${era.id}" の到達レンジを明記する(M39/M40 の裁定事項)`,
        }),
      );
      continue;
    }

    if (reachedCount < records.length) {
      asserts.push(
        makeAssert({
          id: "gdd-11.4-3-era3-reached",
          gddRef: "GDD 11.4-3",
          title: "E3 壁テックへ全戦略が到達",
          inequality: "E3 到達 run 数 >= 全 run 数",
          comparator: ">=",
          measured: reachedCount,
          threshold: records.length,
          unit: "run",
          owner: "balance",
          detail: `${String(reachedCount)}/${String(records.length)} run が E3 到達`,
        }),
      );
      continue;
    }

    const minDays = Math.min(...ticks.map((t) => t.tick)) / GAME_DAY_TICKS;
    const maxDays = Math.max(...ticks.map((t) => t.tick)) / GAME_DAY_TICKS;
    asserts.push(
      makeAssert({
        id: "gdd-11.4-3-era3-lower",
        gddRef: "GDD 11.4-3",
        title: "E3 到達が早すぎない(全戦略)",
        inequality: `min_run(E3 到達日) >= ${String(ERA3_REACH_DAYS_MIN)}`,
        comparator: ">=",
        measured: minDays,
        threshold: ERA3_REACH_DAYS_MIN,
        unit: "ゲーム日",
        owner: "balance",
        detail: ticks.map((t) => `${t.label}=${(t.tick / GAME_DAY_TICKS).toFixed(1)}日`).join(" "),
      }),
      makeAssert({
        id: "gdd-11.4-3-era3-upper",
        gddRef: "GDD 11.4-3",
        title: "E3 到達が遅すぎない(全戦略)",
        inequality: `max_run(E3 到達日) <= ${String(ERA3_REACH_DAYS_MAX)}`,
        comparator: "<=",
        measured: maxDays,
        threshold: ERA3_REACH_DAYS_MAX,
        unit: "ゲーム日",
        owner: "balance",
        detail: ticks.map((t) => `${t.label}=${(t.tick / GAME_DAY_TICKS).toFixed(1)}日`).join(" "),
      }),
    );
  }
  return asserts;
}

/** 11.4-4: 唯一保持者残存想定tick ≥ 成文化所要tick × 1.5(石板で評価)。 */
function assertCodifyDeadline(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): NightlyAssert {
  const town = content.town;
  const safetyFactorRaw = Math.round(readSafetyFactor() * 1_000_000);
  const memoryKeeperTraitId = content.recallRisk.memoryKeeperTraitId;

  let minMargin = Number.POSITIVE_INFINITY;
  let worst = "(該当ペアなし)";
  let pairCount = 0;

  for (const record of records) {
    const state = record.result.state;
    for (const resident of livingResidents(state)) {
      const life = resident.life;
      if (life === undefined) continue;
      for (const techId of soleUncodifiedHeldTechIds(state, resident.id)) {
        const plan = planCodification(content, techId, "stoneTablet", false);
        const memoryDecayDelayFix =
          town === undefined
            ? FIX_ONE
            : memoryDecayDelayFor(
                town,
                memoryKeeperTraitId !== null && resident.traitIds.includes(memoryKeeperTraitId),
              );
        const margin = codifyDeadlineMarginTicks({
          life,
          atTick: state.tick,
          requiredCodifyTicks: plan.durationTicks,
          safetyFactorFix: fixFromRaw(safetyFactorRaw),
          memoryDecayDelayFix,
        });
        pairCount++;
        if (margin < minMargin) {
          minMargin = margin;
          worst = `${record.botId}/${record.seed}:${String(resident.id)}/${String(techId)}`;
        }
      }
    }
  }

  if (pairCount === 0) {
    return makeAssert({
      id: "gdd-11.4-4",
      gddRef: "GDD 11.4-4",
      title: "唯一保持者残存想定tick ≥ 成文化所要tick × 1.5",
      inequality: "min_(住民,技術) (残存tick × memoryDecayDelay − 成文化所要tick × 1.5) >= 0",
      comparator: ">=",
      measured: 0,
      threshold: 0,
      unit: "tick",
      owner: "balance",
      detail: "run 終了時点で「未成文の唯一保持技術」を持つ生存住民が 1 人も居ない",
      unverifiableReason:
        "評価対象ペア(未成文の唯一保持者 × その技術)が run 終了時点で 0 件で、不等式の左辺が定義されない",
      unblockCondition:
        "唯一保持者が残る盤面(成文化を怠る bot / 短い run)を評価対象へ加える。M38 の run は成文化優先botを含むため 0 件になりうる",
    });
  }

  return makeAssert({
    id: "gdd-11.4-4",
    gddRef: "GDD 11.4-4",
    title: "唯一保持者残存想定tick ≥ 成文化所要tick × 1.5",
    inequality: "min_(住民,技術) (残存tick × memoryDecayDelay − 成文化所要tick × 1.5) >= 0",
    comparator: ">=",
    measured: minMargin,
    threshold: 0,
    unit: "tick",
    owner: "balance",
    detail: `${String(pairCount)} ペアを評価(所要は石板 = 遅い方・GDD 11.1 追補)。最小余裕は ${worst}`,
  });
}

/** 11.4-5: 同一 seed の反復が完全一致(canonical digest)。 */
function assertDeterminism(options: ResolvedOptions): NightlyAssert {
  const digests = new Set<string>();
  const seed = "nightly-determinism";
  for (const bot of STRATEGY_BOTS) {
    for (let i = 0; i < options.determinismRuns; i++) {
      const result = runStrategyBot({
        bot,
        totalTicks: options.determinismTicks,
        worldSeed: seed,
      });
      digests.add(`${bot.id}:${digestOfCanonicalJson(canonicalJsonOfState(result.state))}`);
    }
  }
  // bot ごとに 1 個ずつになるのが正常(digest に botId を前置しているため)。
  return makeAssert({
    id: "gdd-11.4-5",
    gddRef: "GDD 11.4-5",
    title: "同一seedの反復試行が完全一致",
    inequality: "相異なる digest 数 <= bot 数",
    comparator: "<=",
    measured: digests.size,
    threshold: STRATEGY_BOTS.length,
    unit: "digest",
    owner: "structural",
    detail:
      `${String(STRATEGY_BOTS.length)} bot × ${String(options.determinismRuns)} 回 ` +
      `(1 run = ${String(options.determinismTicks)} tick)。` +
      (options.determinismRuns < DETERMINISM_RUNS_FULL
        ? `**GDD の 1000 回に対し ${String(options.determinismRuns)} 回の縮小プロファイル**`
        : "GDD 記載どおり 1000 回"),
  });
}

/** 11.4-6: 周回健全性(単調改善 / 青天井でない / 1周1段階 / 全系統上限 10〜18周)。 */
function assertProgressionHealth(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  const params = content.exodus;
  if (params === undefined) {
    return [
      makeAssert({
        id: "gdd-11.4-6",
        gddRef: "GDD 11.4-6",
        title: "周回健全性",
        inequality: "(content 未整備)",
        comparator: ">=",
        measured: 0,
        threshold: 0,
        unit: "-",
        owner: "structural",
        detail: "content に exodus ブロックが無い",
        unverifiableReason: "content/balance.json に exodus ブロックが無く継承点機構が不活性",
        unblockCondition: "content/balance.json へ exodus ブロックを追加",
      }),
    ];
  }

  const tierMax = inheritTierMax(params);
  const tracks = Object.keys(params.trackBonusPerTier).sort();

  // (a) 単調改善: 1 段あたりのボーナス増分が全系統で正。
  let minBonusPerTier = Number.POSITIVE_INFINITY;
  for (const track of tracks) {
    const perTier = params.trackBonusPerTier[track as keyof typeof params.trackBonusPerTier];
    if (perTier < minBonusPerTier) minBonusPerTier = perTier;
  }

  // (b) 青天井でない: 上限段を超えるコストが引けない(= 購入不能)。
  //     不等式化: 「無限の点で買い進めたときの総購入段数 <= 系統数 × 上限段」。
  let purchasable = 0;
  for (let t = 0; t < tierMax + 5; t++) {
    if (inheritTierCost(params, t) !== null) purchasable++;
  }
  const purchasableTotal = purchasable * tracks.length;

  // (c) 1 周 1 段階購入可(代表周回)。
  const firstTierCost = inheritTierCost(params, 0) ?? 0;

  // (d) 全系統上限到達 10〜18 周。
  let totalTierCost = 0;
  for (let t = 0; t < tierMax; t++) totalTierCost += inheritTierCost(params, t) ?? 0;
  totalTierCost *= tracks.length;
  const cyclesAtRepresentative = Math.ceil(totalTierCost / REPRESENTATIVE_CYCLE_POINTS);

  // 実 run の周回獲得点(参考値・detail に出す)。
  const runPoints: number[] = [];
  for (const record of records) runPoints.push(record.result.metrics.earnedInheritPoints);
  const runPointsMin = runPoints.length === 0 ? 0 : Math.min(...runPoints);

  return [
    makeAssert({
      id: "gdd-11.4-6a",
      gddRef: "GDD 11.4-6",
      title: "継承ボーナスが段ごとに単調改善",
      inequality: "min_系統(1段あたり増分) > 0",
      comparator: ">",
      measured: Number.isFinite(minBonusPerTier) ? minBonusPerTier : 0,
      threshold: 0,
      unit: "ボーナス量/段",
      owner: "structural",
      detail: `系統 ${tracks.join(",")} / 上限 ${String(tierMax)} 段`,
    }),
    makeAssert({
      id: "gdd-11.4-6b",
      gddRef: "GDD 11.4-6",
      title: "上限クランプで青天井にならない",
      inequality: "購入可能な総段数 <= 系統数 × 上限段",
      comparator: "<=",
      measured: purchasableTotal,
      threshold: tracks.length * tierMax,
      unit: "段",
      owner: "structural",
      detail: `${String(tierMax)} 段を超える段のコストは null(購入不能)`,
    }),
    makeAssert({
      id: "gdd-11.4-6c",
      gddRef: "GDD 11.4-6",
      title: "代表周回で1周1段階購入可",
      inequality: `代表周回の継承点(${String(REPRESENTATIVE_CYCLE_POINTS)}) >= 第1段コスト`,
      comparator: ">=",
      measured: REPRESENTATIVE_CYCLE_POINTS,
      threshold: firstTierCost,
      unit: "継承点",
      owner: "balance",
      detail:
        `代表周回 = GDD 10.3(到達E3 + 成文化率60% + 生存12人)。` +
        `実 run の最小獲得点は ${String(runPointsMin)}(${runPoints.join(",")})`,
    }),
    makeAssert({
      id: "gdd-11.4-6d",
      gddRef: "GDD 11.4-6",
      title: "全系統上限到達 10〜18 周",
      inequality: `${String(ALL_TRACK_MAX_CYCLES_MIN)} <= ceil(全系統総コスト / 代表周回点) <= ${String(ALL_TRACK_MAX_CYCLES_MAX)}`,
      comparator: "in-range",
      measured: cyclesAtRepresentative,
      threshold: ALL_TRACK_MAX_CYCLES_MIN,
      thresholdUpper: ALL_TRACK_MAX_CYCLES_MAX,
      unit: "周",
      owner: "balance",
      detail:
        `全系統総コスト = ${String(totalTierCost)} 点(${tracks.length} 系統 × ` +
        `${String(tierMax)} 段)、代表周回 ${String(REPRESENTATIVE_CYCLE_POINTS)} 点`,
    }),
  ];
}

/** 11.4-7: 拠点網ROI / 探索ROI(B損失込)/ オーバーフロー損失率 / era移行後の研究速度低下。 */
function assertRoiAndOverflow(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  const asserts: NightlyAssert[] = [];

  // (a) 拠点網 ROI。[M75] 実 run の観測へ結線した(GDD 11.4-7 [2026-08-07裁定])。
  //     判定値は **拠点を建てた run の最小 ROI**(保守側 = 1 run でも下限を割れば
  //     fail)。ROI の計算は engine の `outpostNetworkRoi`(GDD 9.2 の式)であり、
  //     sim 側に再実装は無い(`runStrategy.ts` が run 終了時点の値を metrics へ載せる)。
  const outpostTypeCount = content.outpostTypeDefs?.size ?? 0;
  const outpostRoiDetail: string[] = [];
  let minOutpostRoi = Number.POSITIVE_INFINITY;
  let totalOutpostCount = 0;
  let totalStationedCount = 0;
  const outpostTypeIdsSeen = new Set<string>();
  const outpostBandsSeen = new Set<string>();
  for (const record of records) {
    const metrics = record.result.metrics;
    totalOutpostCount += metrics.finalOutpostCount;
    totalStationedCount += metrics.finalStationedResidentCount;
    for (const typeId of metrics.builtOutpostTypeIds) outpostTypeIdsSeen.add(typeId);
    for (const band of metrics.outpostBands) outpostBandsSeen.add(band);
    if (metrics.finalOutpostCount === 0) continue;
    const roi =
      metrics.finalOutpostNetworkRoiRaw === null ? null : metrics.finalOutpostNetworkRoiRaw / 1e6;
    outpostRoiDetail.push(
      `${record.botId}/${record.seed}=${roi === null ? "null(分母0)" : roi.toFixed(4)}` +
        `(拠点${String(metrics.finalOutpostCount)}基/常駐${String(metrics.finalStationedResidentCount)}名)`,
    );
    if (roi !== null && roi < minOutpostRoi) minOutpostRoi = roi;
  }
  const outpostRoiMeasured = Number.isFinite(minOutpostRoi) ? minOutpostRoi : 0;
  const outpostDetail =
    `content の outpostType 定義数 = ${String(outpostTypeCount)}。` +
    `全 ${String(records.length)} run の拠点 ${String(totalOutpostCount)} 基 / 常駐 ` +
    `${String(totalStationedCount)} 名(タイプ ${[...outpostTypeIdsSeen].sort(compareUtf16).join(",") || "なし"} / ` +
    `距離帯 ${[...outpostBandsSeen].sort(compareUtf16).join(",") || "なし"})。` +
    (outpostRoiDetail.length === 0 ? "" : `run 別 ROI: ${outpostRoiDetail.join(" ")}`);
  asserts.push(
    Number.isFinite(minOutpostRoi)
      ? makeAssert({
          id: "gdd-11.4-7a",
          gddRef: "GDD 11.4-7",
          title: "拠点網ROI",
          inequality: `min_run(拠点網ROI = Σsupply / (Σupkeep + Σ期待B喪失損失)) >= ${String(OUTPOST_NETWORK_ROI_MIN)}`,
          comparator: ">=",
          measured: outpostRoiMeasured,
          threshold: OUTPOST_NETWORK_ROI_MIN,
          unit: "比",
          owner: "balance",
          detail: outpostDetail,
        })
      : makeAssert({
          id: "gdd-11.4-7a",
          gddRef: "GDD 11.4-7",
          title: "拠点網ROI",
          inequality: `min_run(拠点網ROI = Σsupply / (Σupkeep + Σ期待B喪失損失)) >= ${String(OUTPOST_NETWORK_ROI_MIN)}`,
          comparator: ">=",
          measured: 0,
          threshold: OUTPOST_NETWORK_ROI_MIN,
          unit: "比",
          owner: "balance",
          detail: outpostDetail,
          unverifiableReason:
            outpostTypeCount === 0
              ? "content に outpostType 定義が 1 件も無く、拠点を 1 基も建てられない"
              : "全 run で拠点が 1 基も建たず(または ROI の分母が 0 で)不等式の左辺が定義されない",
          unblockCondition:
            "bot の拠点方針(sim/strategy/bots.ts の OUTPOST_POLICY_*)が実 run で 1 基以上建てられる盤面にする(常駐に回せる人数 / 設置コストの在庫)",
        }),
  );

  // (b) 探索 ROI((B) 喪失込み)。B 損失項が機能しているかは別 assert(11.4-11b)。
  const exploration = content.exploration;
  const bands: readonly DistanceBand[] = ["near", "far", "deep"];
  const roiDetail: string[] = [];
  if (exploration !== undefined) {
    const record = records[0];
    if (record !== undefined) {
      const members = livingResidents(record.result.state)
        .slice(0, 2)
        .map((resident) => resident.id);
      for (const band of bands) {
        const roi = explorationRoi(record.result.state, content, band, members);
        roiDetail.push(
          `${band}=${roi.roiFix === null ? "null" : (toRaw(roi.roiFix) / 1e6).toFixed(3)}`,
        );
      }
    }
  }
  asserts.push(
    makeAssert({
      id: "gdd-11.4-7b",
      gddRef: "GDD 11.4-7",
      title: "探索ROI((B)喪失損失込み)",
      inequality: "探索ROI = 期待報酬 / (逸失生産 + 期待B喪失損失) >= 下限",
      comparator: ">=",
      measured: 0,
      threshold: 0,
      unit: "比",
      owner: "balance",
      detail:
        roiDetail.length === 0 ? "content に exploration ブロックが無い" : roiDetail.join(" "),
      unverifiableReason:
        "GDD 11.4-7 は探索ROIの数値閾値を与えていない(『<15%』はオーバーフロー損失率だけに掛かる)",
      unblockCondition:
        "GDD 11.4-7 に探索ROIの下限値を明記する(M39〜M41 の裁定事項)。measured の欄には代表チームの実測 ROI を detail として出してある",
    }),
  );

  // (c) オーバーフロー損失率 < 15%。
  let maxOverflowRaw = 0;
  for (const record of records) {
    for (const sample of record.result.samples) {
      if (sample.overflowLossRateRaw > maxOverflowRaw) maxOverflowRaw = sample.overflowLossRateRaw;
    }
  }
  const capacityDefined = (content.storage?.baseCapacityByResourceId.size ?? 0) > 0;
  asserts.push(
    makeAssert({
      id: "gdd-11.4-7c",
      gddRef: "GDD 11.4-7",
      title: "オーバーフロー損失率 < 15%",
      inequality: "max_(run, 標本) オーバーフロー損失率 < 0.15",
      comparator: "<",
      measured: maxOverflowRaw,
      threshold: OVERFLOW_LOSS_RATE_MAX_FIX_RAW,
      unit: "1e6 raw(率)",
      owner: "balance",
      detail:
        `全 run の全標本で最大 ${(maxOverflowRaw / 1e6).toFixed(6)}。` +
        (capacityDefined
          ? "content の storage.baseCapacity に上限が定義されている"
          : "**注意: content の `storage.baseCapacity` が空 = 保管上限が無いためオーバーフロー機構自体が走らない。よってこの assert は現在ほぼ恒真である**(保管庫 content 投入後に再評価が要る)"),
    }),
  );

  // (d) era 移行後 N tick 窓の実効研究速度低下。
  let maxDropPermille = 0;
  let dropDetail = "(era 移行が標本に現れない)";
  for (const record of records) {
    const samples = record.result.samples;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      const cur = samples[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur.reachedEraOrder <= prev.reachedEraOrder) continue;
      const before = windowMeanResearchRate(
        samples,
        cur.tick - ERA_TRANSITION_WINDOW_TICKS,
        cur.tick,
      );
      const after = windowMeanResearchRate(
        samples,
        cur.tick,
        cur.tick + ERA_TRANSITION_WINDOW_TICKS,
      );
      if (before <= 0) continue;
      const dropPermille = Math.round(((before - after) / before) * 1000);
      if (dropPermille > maxDropPermille) {
        maxDropPermille = dropPermille;
        dropDetail =
          `${record.botId}/${record.seed} era→${String(cur.reachedEraOrder)} @tick ${String(cur.tick)}: ` +
          `${(before / 1e6).toFixed(2)} → ${(after / 1e6).toFixed(2)}`;
      }
    }
  }
  asserts.push(
    makeAssert({
      id: "gdd-11.4-7d",
      gddRef: "GDD 11.4-7",
      title: "era移行後 N tick 窓の実効研究速度低下が閾値以内",
      inequality: "max_(run, era移行) 低下率(‰) <= 閾値",
      comparator: "<=",
      measured: maxDropPermille,
      threshold: 0,
      unit: "‰",
      owner: "balance",
      detail: `窓 N = ${String(ERA_TRANSITION_WINDOW_TICKS)} tick(3 ゲーム日)。最大低下は ${dropDetail}`,
      unverifiableReason: "GDD 11.4-7 は『N tick 窓』の N も『閾値以内』の閾値も数値を与えていない",
      unblockCondition:
        "GDD 11.4-7 に窓 N と低下率の上限を明記する(M40「era 移行後 N tick 窓の実効研究速度低下が閾値内」が検収条件に持つ数値)",
    }),
  );

  return asserts;
}

function windowMeanResearchRate(
  samples: readonly { readonly tick: number; readonly researchRateRaw: number }[],
  fromTick: number,
  toTick: number,
): number {
  let sum = 0;
  let count = 0;
  for (const sample of samples) {
    if (sample.tick < fromTick || sample.tick >= toTick) continue;
    sum += sample.researchRateRaw;
    count++;
  }
  return count === 0 ? 0 : sum / count;
}

/** 11.4-8: 想起困難頻度が 1〜3 回/住民/週(縮約盤面 + 実 run の 2 本立て)。 */
function assertRecallFrequency(
  options: ResolvedOptions,
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  const seeds: string[] = [];
  for (let i = 0; i < options.recallSeedCount; i++) seeds.push(`recall-freq-${String(i)}`);
  const reduced = measureRecallFrequency({ seeds });

  let occurrences = 0;
  let residentWeeks = 0;
  const perBot: string[] = [];
  for (const record of records) {
    occurrences += record.result.metrics.recallOccurrenceCount;
    residentWeeks += record.result.metrics.residentWeeksObserved;
    perBot.push(
      `${record.botId}/${record.seed}=` +
        (
          record.result.metrics.recallOccurrenceCount /
          Math.max(1e-9, record.result.metrics.residentWeeksObserved)
        ).toFixed(3),
    );
  }
  const realRate = residentWeeks <= 0 ? 0 : occurrences / residentWeeks;

  return [
    makeAssert({
      id: "gdd-11.4-8a",
      gddRef: "GDD 11.4-8",
      title: "想起困難頻度(縮約盤面・盤面平均)",
      inequality: "1 <= 回/住民/週 <= 3",
      comparator: "in-range",
      measured: reduced.overallOccurrencesPerResidentPerWeek,
      threshold: RECALL_PER_RESIDENT_WEEK_MIN,
      thresholdUpper: RECALL_PER_RESIDENT_WEEK_MAX,
      unit: "回/住民/週",
      owner: "balance",
      detail:
        `sim/board.ts の代表10パターン × ${String(seeds.length)} seed。` +
        `判定単位は盤面平均(裁定B9)。パターン別レンジ ` +
        `${Math.min(...reduced.byPattern.map((p) => p.occurrencesPerResidentPerWeek)).toFixed(4)}` +
        `〜${Math.max(...reduced.byPattern.map((p) => p.occurrencesPerResidentPerWeek)).toFixed(4)}`,
    }),
    makeAssert({
      id: "gdd-11.4-8b",
      gddRef: "GDD 11.4-8",
      title: "想起困難頻度(**実 run** 盤面・盤面平均)",
      inequality: "1 <= 回/住民/週 <= 3",
      comparator: "in-range",
      measured: realRate,
      threshold: RECALL_PER_RESIDENT_WEEK_MIN,
      thresholdUpper: RECALL_PER_RESIDENT_WEEK_MAX,
      unit: "回/住民/週",
      owner: "balance",
      detail:
        `5戦略bot の実 run(縮約でない content・${String(records.length)} run)で ` +
        `${String(occurrences)} 件 / ${residentWeeks.toFixed(2)} 住民週。bot 別: ${perBot.join(" ")}`,
    }),
  ];
}

/** 11.4-9: 人口が全 tick・全 bot で下限 `min(寝床×0.5, 6)` 以上。 */
function assertPopulationFloor(records: readonly StrategyRunRecord[]): NightlyAssert {
  let minMargin = Number.POSITIVE_INFINITY;
  let worst = "(標本なし)";
  for (const record of records) {
    for (const sample of record.result.samples) {
      const margin = sample.livingPopulation - sample.populationFloor;
      if (margin < minMargin) {
        minMargin = margin;
        worst =
          `${record.botId}/${record.seed} @tick ${String(sample.tick)}: ` +
          `人口 ${String(sample.livingPopulation)} / 下限 ${String(sample.populationFloor)}` +
          `(寝床上限 ${String(sample.bedCapacity)})`;
      }
    }
  }
  return makeAssert({
    id: "gdd-11.4-9",
    gddRef: "GDD 11.4-9",
    title: "人口が下限 min(寝床×0.5, 6) 以上",
    inequality: "min_(run, 標本) (生存人口 − 人口下限) >= 0",
    comparator: ">=",
    measured: Number.isFinite(minMargin) ? minMargin : 0,
    threshold: 0,
    unit: "人",
    owner: "structural",
    detail:
      `最小余裕は ${worst}。**大移動(乗員選抜)は対象外**` +
      "([2026-08-02裁定・台帳v12 必-2] GDD 7.6 の下限保証は周回内の死亡経路のみ)。" +
      "本 assert の run は exodus を行わない(runStrategyBot の既定)",
  });
}

/** 11.4-10: 各ノード/分岐が 1000 回中最低 N 回到達。 */
function assertEventCoverage(options: ResolvedOptions): NightlyAssert {
  const coverage = measureEventCoverageFrequency(options.eventCoverageSamples);
  const scaledMin = Math.round(
    (EVENT_COVERAGE_MIN_HITS * options.eventCoverageSamples) / EVENT_COVERAGE_SAMPLES_FULL,
  );
  const threshold = Math.max(1, scaledMin);
  return makeAssert({
    id: "gdd-11.4-10",
    gddRef: "GDD 11.4-10",
    title: "各ノード/分岐が1000回中最低N回到達",
    inequality: `min_(ノード, 分岐) 到達回数 >= ${String(threshold)}`,
    comparator: ">=",
    measured: coverage.minHits,
    threshold,
    unit: "回",
    owner: "structural",
    detail:
      `${String(options.eventCoverageSamples)} 試行 / event ${String(coverage.eventCount)} 本 ` +
      `/ ノード ${String(coverage.totalNodes)} / 分岐 ${String(coverage.totalBranches)}。` +
      `最少到達は ${coverage.minHitsLabel}` +
      (options.eventCoverageSamples === EVENT_COVERAGE_SAMPLES_FULL
        ? "(GDD 記載どおり 1000 試行・N=20)"
        : `(縮小プロファイル。閾値は 1000 試行 N=${String(EVENT_COVERAGE_MIN_HITS)} を試行数で按分した ${String(threshold)})`),
  });
}

/** 11.4-11: 貪欲botが唯一/レア保持者を派遣する頻度の観測 + B損失項が効いているか。 */
function assertGreedyRareDispatch(
  content: EngineContent,
  records: readonly StrategyRunRecord[],
): readonly NightlyAssert[] {
  let members = 0;
  let sole = 0;
  let rare = 0;
  for (const record of records) {
    if (record.botId !== "greedy") continue;
    members += record.result.metrics.dispatchedMemberCount;
    sole += record.result.metrics.dispatchedSoleHolderCount;
    rare += record.result.metrics.dispatchedRareAssetCount;
  }

  const observation = makeAssert({
    id: "gdd-11.4-11a",
    gddRef: "GDD 11.4-11",
    title: "貪欲botが唯一/レア保持者を派遣する頻度の観測が成立している",
    inequality: "貪欲botの派遣延べ人数 >= 1(= 頻度の分母が立っている)",
    comparator: ">=",
    measured: members,
    threshold: 1,
    unit: "人",
    owner: "structural",
    detail:
      `唯一保持者 ${String(sole)} 人 / (B)レア資産 ${String(rare)} 件 / 派遣延べ ${String(members)} 人。` +
      `唯一保持者率 = ${(members === 0 ? 0 : sole / members).toFixed(3)}。` +
      "GDD 11.4-11 は『頻度の観測』であって上限値を与えていないため、本 assert は" +
      "「観測が成立していること」を不等式にしている(頻度そのものは detail の実測値)",
  });

  // (B) 損失項が ROI の分母に実際に効いているか(= 数値として 0 でないか)。
  let expectedRareLossRaw = 0;
  let roiDetail = "(評価できる run が無い)";
  for (const record of records) {
    const state = record.result.state;
    for (const resident of livingResidents(state)) {
      const memberIds = [resident.id];
      if (rareAssetCountOf(state, content, memberIds) === 0) continue;
      const roi = explorationRoi(state, content, "near", memberIds);
      expectedRareLossRaw = toRaw(roi.expectedRareLossFix);
      roiDetail =
        `${record.botId}/${record.seed}:${String(resident.id)} rareAssetCount=${String(roi.rareAssetCount)} ` +
        `期待B喪失損失raw=${String(expectedRareLossRaw)}`;
      break;
    }
    if (expectedRareLossRaw > 0) break;
  }

  const roiTerm =
    expectedRareLossRaw > 0
      ? makeAssert({
          id: "gdd-11.4-11b",
          gddRef: "GDD 11.4-11",
          title: "探索ROIの (B) 喪失損失項が実際に効いている",
          inequality: "(B)資産を持つ住民を含むチームの期待B喪失損失 > 0",
          comparator: ">",
          measured: expectedRareLossRaw,
          threshold: 0,
          unit: "1e6 raw",
          owner: "structural",
          detail: roiDetail,
        })
      : makeAssert({
          id: "gdd-11.4-11b",
          gddRef: "GDD 11.4-11",
          title: "探索ROIの (B) 喪失損失項が実際に効いている",
          inequality: "(B)資産を持つ住民を含むチームの期待B喪失損失 > 0",
          comparator: ">",
          measured: 0,
          threshold: 0,
          unit: "1e6 raw",
          owner: "structural",
          detail: roiDetail,
          unverifiableReason:
            "run 終了時点で (B) rareIrreversible の唯一保持者が 1 人も居ない(現行 content/tech.json の lossClass は全 24 本が criticalRecoverable の可能性がある)",
          unblockCondition:
            "content/tech.json に lossClass=rareIrreversible の tech を含めるか、(B) 保持者が残る盤面を評価対象に加える",
        });

  return [observation, roiTerm];
}

/** 敵対bot 6種が毎晩ゲートとして実際に走ったこと(GDD 11.6)。 */
function assertAdversarialBotsRun(runTicks: number): NightlyAssert {
  let ran = 0;
  const details: string[] = [];
  for (const bot of ADVERSARIAL_BOTS) {
    const result = runAdversarialBotAsNewGame(bot, runTicks, "nightly-adversarial");
    ran++;
    details.push(`${bot.id}:log${String(result.adversarialLog.length)}`);
  }
  return makeAssert({
    id: "gdd-11.6",
    gddRef: "GDD 11.6",
    title: "敵対シナリオbot 6種が毎晩ゲートとして走る",
    inequality: "走った敵対bot 数 >= 6",
    comparator: ">=",
    measured: ran,
    threshold: 6,
    unit: "bot",
    owner: "structural",
    detail: details.join(" "),
  });
}

// --- 6. 入口 ------------------------------------------------------------------

export interface NightlyGateReport {
  readonly profile: "full" | "quick";
  readonly options: ResolvedOptions;
  readonly asserts: readonly NightlyAssert[];
  readonly passCount: number;
  readonly failCount: number;
  readonly unverifiableCount: number;
  /** `owner: "structural"` の fail 件数(CI の必須ゲートが見る値)。 */
  readonly structuralFailCount: number;
  /** 実 run の観測(タスク報告の元データ)。 */
  readonly runObservations: readonly {
    readonly botId: string;
    readonly seed: string;
    readonly builtFacilityDefIds: readonly string[];
    readonly finalReachedEraOrder: number;
    readonly finalCompletedResearchCount: number;
    readonly finalCodifiedRecordCount: number;
    readonly finalBoardOutputScoreRaw: number;
    readonly dispatchCount: number;
    readonly reclaimCount: number;
    readonly recallGuardBlockCount: number;
    readonly recallOccurrenceCount: number;
    readonly minLivingPopulation: number;
    /** [M66] 解決した襲撃の回数(GDD 11.7 段10)。 */
    readonly raidCount: number;
    /** [M66] うち撃退できた回数(見張り台の防衛係数が効いた証跡)。 */
    readonly raidRepelledCount: number;
    /** [M72] 全標本・全生存住民の実効士気の最小値(raw)。 */
    readonly minEffectiveMoraleRaw: number | null;
    /** [M72] 過酷業務就労者だけの実効士気の最小値(raw)。 */
    readonly minHarshWorkerMoraleRaw: number | null;
    /** [M72] 過酷業務就労者の延べ標本数と、そのうち [30,40) / <30 の件数。 */
    readonly harshWorkerSampleCount: number;
    readonly harshWorkerGuardBandSampleCount: number;
    readonly harshWorkerBelowMidSampleCount: number;
    /** [M75] 衛星拠点(GDD 9.2 / 11.4-7a)。設置 / 駐在の成立本数と最終状態。 */
    readonly outpostEstablishCount: number;
    readonly outpostStationCount: number;
    readonly finalOutpostCount: number;
    readonly finalStationedResidentCount: number;
    readonly builtOutpostTypeIds: readonly string[];
    readonly outpostBands: readonly string[];
    /** [M75] run 終了時点の拠点網 ROI(raw・1e6 スケール)。拠点 0 基なら null。 */
    readonly finalOutpostNetworkRoiRaw: number | null;
    readonly finalOutpostSupplyRaw: number;
    readonly finalOutpostUpkeepRaw: number;
    readonly finalOutpostRareLossRaw: number;
  }[];
}

export function runNightlyGate(options: NightlyGateOptions = {}): NightlyGateReport {
  const resolved = resolveOptions(options);
  const content = resolveStrategyContent();
  const techs = readContentJson("tech.json") as readonly TechJson[];
  const facilities = readContentJson("facility.json") as readonly FacilityJson[];

  const records = runStrategyMatrix(resolved);

  const asserts: NightlyAssert[] = [
    assertCriticalPathReachable(content, records),
    ...assertNoSoftlockRates(content, facilities, records),
    assertRecoverability(techs, facilities),
    ...assertEraReachRange(content, records),
    assertCodifyDeadline(content, records),
    assertDeterminism(resolved),
    ...assertProgressionHealth(content, records),
    ...assertRoiAndOverflow(content, records),
    ...assertRecallFrequency(resolved, records),
    assertPopulationFloor(records),
    assertEventCoverage(resolved),
    ...assertGreedyRareDispatch(content, records),
    assertAdversarialBotsRun(resolved.runTicks),
  ];

  let passCount = 0;
  let failCount = 0;
  let unverifiableCount = 0;
  let structuralFailCount = 0;
  for (const entry of asserts) {
    if (entry.status === "pass") passCount++;
    else if (entry.status === "unverifiable") unverifiableCount++;
    else {
      failCount++;
      if (entry.owner === "structural") structuralFailCount++;
    }
  }

  return {
    profile: resolved.profile,
    options: resolved,
    asserts,
    passCount,
    failCount,
    unverifiableCount,
    structuralFailCount,
    runObservations: records.map((record) => ({
      botId: record.botId,
      seed: record.seed,
      builtFacilityDefIds: record.result.metrics.builtFacilityDefIds,
      finalReachedEraOrder: record.result.metrics.finalReachedEraOrder,
      finalCompletedResearchCount: record.result.metrics.finalCompletedResearchCount,
      finalCodifiedRecordCount: record.result.metrics.finalCodifiedRecordCount,
      finalBoardOutputScoreRaw: record.result.metrics.finalBoardOutputScoreRaw,
      dispatchCount: record.result.metrics.dispatchCount,
      reclaimCount: record.result.metrics.reclaimCount,
      recallGuardBlockCount: record.result.recallGuardLog.length,
      recallOccurrenceCount: record.result.metrics.recallOccurrenceCount,
      minLivingPopulation: record.result.metrics.minLivingPopulation,
      raidCount: record.result.metrics.raidCount,
      raidRepelledCount: record.result.metrics.raidRepelledCount,
      minEffectiveMoraleRaw: record.result.metrics.minEffectiveMoraleRaw,
      minHarshWorkerMoraleRaw: record.result.metrics.minHarshWorkerMoraleRaw,
      harshWorkerSampleCount: record.result.metrics.harshWorkerSampleCount,
      harshWorkerGuardBandSampleCount: record.result.metrics.harshWorkerGuardBandSampleCount,
      harshWorkerBelowMidSampleCount: record.result.metrics.harshWorkerBelowMidSampleCount,
      outpostEstablishCount: record.result.metrics.outpostEstablishCount,
      outpostStationCount: record.result.metrics.outpostStationCount,
      finalOutpostCount: record.result.metrics.finalOutpostCount,
      finalStationedResidentCount: record.result.metrics.finalStationedResidentCount,
      builtOutpostTypeIds: record.result.metrics.builtOutpostTypeIds,
      outpostBands: record.result.metrics.outpostBands,
      finalOutpostNetworkRoiRaw: record.result.metrics.finalOutpostNetworkRoiRaw,
      finalOutpostSupplyRaw: record.result.metrics.finalOutpostSupplyRaw,
      finalOutpostUpkeepRaw: record.result.metrics.finalOutpostUpkeepRaw,
      finalOutpostRareLossRaw: record.result.metrics.finalOutpostRareLossRaw,
    })),
  };
}

// --- 7. CLI -------------------------------------------------------------------

function formatAssert(entry: NightlyAssert): string {
  const mark = entry.status === "pass" ? "PASS" : entry.status === "fail" ? "FAIL" : "UNVERIFIABLE";
  const bound =
    entry.comparator === "in-range"
      ? `[${String(entry.threshold)}, ${String(entry.thresholdUpper)}]`
      : `${entry.comparator} ${String(entry.threshold)}`;
  return (
    `[${mark}] ${entry.id} ${entry.title}\n` +
    `        不等式: ${entry.inequality}\n` +
    `        実測 = ${String(entry.measured)} ${entry.unit} / 閾値 ${bound} (owner=${entry.owner})\n` +
    `        ${entry.detail}` +
    (entry.unverifiableReason === null
      ? ""
      : `\n        検証不能理由: ${entry.unverifiableReason}`) +
    (entry.unblockCondition === null ? "" : `\n        解消条件: ${entry.unblockCondition}`)
  );
}

async function main(): Promise<void> {
  const profile = process.argv.includes("--quick") ? "quick" : "full";
  const report = runNightlyGate({ profile });
  console.log(`\n=== 夜間ゲート(GDD 11.4)profile=${report.profile} ===\n`);
  for (const entry of report.asserts) console.log(formatAssert(entry));
  console.log(
    `\npass=${String(report.passCount)} fail=${String(report.failCount)} ` +
      `unverifiable=${String(report.unverifiableCount)} ` +
      `(うち structural fail=${String(report.structuralFailCount)})`,
  );
  await writeJsonReport("sim/output/nightly-gate-report.json", report);
  if (report.failCount > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  await main();
}
