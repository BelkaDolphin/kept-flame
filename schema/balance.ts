// ---------------------------------------------------------------------------
// balance content スキーマ — ADR「balance(人間専用)」641行、GDD §11.1〜§11.3
//
// balance.json は CODEOWNERS で人間専用(ADR リポ構成591行)。T6 はその
// スキーマ検証器を用意するだけで、週次 LLM 運営パイプライン(bot作成PR等・
// ADR-030)は範囲外。
//
// T4 state.ts §3 が明記する「3 rules(生産/研究/想起困難)が読む値」に合わせ、
// このスキーマは recallRiskParams を中心とした最小フィールドから始まり、
// システム実装ごとに additive で伸ばしている。ADR のサンプル(641行)にある
// うち eraTable(M6 `eras`)・lifespan/populationFloor(M11 `townParams`)は
// 実装済み、caravanRatio/roiRange/assistEfficiencyCap は周回・アシストAI等
// 未実装システム向けで引き続き対象外(それらのシステム実装時に追加すること)。
//
// **追加は必ず「ブロックごと省略可・省略時は当該システムが不活性」の形で行う**
// (M5 `storage` / M6 `eras`・`recordMedia` / M11 `townParams` の全てがこの形)。
// これが「新フィールド追加で既存 golden vector が動かない」ことの schema 側の
// 根拠である。
// ---------------------------------------------------------------------------

import { OVERFLOW_POLICIES, isOverflowPolicyKind } from "../src/engine/rules/types";
import {
  IssueCollector,
  expectArray,
  expectBoolean,
  expectExactNumber,
  expectInteger,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type NumericRange,
  type ValidationResult,
} from "./common";

/** ADR-006: 固定小数点スケールは 1e6 固定。 */
const FP_SCALE = 1_000_000;
/** GDD 11.1: オフライン差分は72h=4320tick固定クランプ。 */
const OFFLINE_CLAMP_TICK = 4320;
/** GDD 11.3: 安全係数は1.5に統一(旧1.2は撤回)。 */
const SAFETY_FACTOR = 1.5;

const POSITIVE_INT: NumericRange = { min: 1, max: 1_000_000 };
const UNIT_RANGE: NumericRange = { min: 0, max: 1 };
const MORALE_SCALE_RANGE: NumericRange = { min: 0, max: 100 };
const RESIST_RANGE: NumericRange = { min: -1, max: 1 };
/**
 * [T7] 想起困難の持続 tick(GDD 11.2「持続 d = 1〜2日」)の許容レンジ。
 * 1 tick = 1 分なので 1 日 = 1440。上限は 1 週間(10080)を保守境界とする。
 */
const RECALL_DURATION_TICKS_RANGE: NumericRange = { min: 1, max: 10_080 };

export interface RecallRiskParams {
  /** GDD 11.2 base_p。 */
  readonly base_p: number;
  /** GDD 11.2 p_max。 */
  readonly p_max: number;
  /** GDD 11.2 loadW: 過酷業務 ×2.0。 */
  readonly loadWHarsh: number;
  /** GDD 11.2 loadW: 通常業務 ×0.5。 */
  readonly loadWNormal: number;
  /** GDD 11.2 moraleW: 士気しきい値(中位、既定30)。 */
  readonly moraleThresholdMid: number;
  /** GDD 11.2 moraleW: 中位しきい値未満時の加算(既定+0.10)。 */
  readonly moraleBonusMid: number;
  /** GDD 11.2 moraleW: 士気しきい値(低位、既定15)。 */
  readonly moraleThresholdLow: number;
  /** GDD 11.2 moraleW: 低位しきい値未満時の加算(既定+0.20)。 */
  readonly moraleBonusLow: number;
  /** GDD 11.2 dispatchW: 探索派遣中 +0.15。 */
  readonly dispatchW: number;
  /** GDD 11.2 masteryResist: 実地稼働で蓄積する定着度の上限(0〜0.20)。 */
  readonly masteryResistMax: number;
  /** GDD 11.2 masteryResist: 記憶巧者 trait による追加軽減(-0.15)。 */
  readonly memoryKeeperResist: number;
  /**
   * [T7] 記憶巧者 trait の content ID(省略可・欠落は null)。
   * GDD 11.2 は「記憶巧者trait −0.15」と効果量だけを定めており、どの trait entity が
   * それに該当するかは content 側の対応付けなので balance に置く。省略時は
   * 「この content には記憶巧者 trait が無い」= engine 側 memoryKeeperTraitId が null。
   * 指定した場合の trait 実在確認は contentBundle.ts の cross-ref が行う。
   */
  readonly memoryKeeperTraitId: string | null;
  /**
   * [T7] 発生時の持続 tick の下限(GDD 11.2「d = 1〜2日」の 1 日 = 1440。省略可)。
   * 省略可にしているのは既存 content/テストを壊さないため。engine へ写す段
   * (schema/engineContent.ts)は欠落を reject する。
   */
  readonly durationTicksMin: number | null;
  /** [T7] 発生時の持続 tick の上限(GDD 11.2 の 2 日 = 2880。省略可)。 */
  readonly durationTicksMax: number | null;
  /**
   * [M13] masteryResist の**蓄積速度**: 実地稼働 1 ゲーム日(1440 tick)あたりの
   * 定着度の増分(GDD 11.2「実地稼働で蓄積する定着度」・省略可・欠落は null)。
   *
   * GDD に速度の明示が無い暫定値であり、バランス調整段(M39〜M41)で裁定 N12
   * (上限 0.20 の相殺挙動)と対で再評価する。省略時は engine 側で蓄積が起きない
   * = M13 以前と完全に同一挙動。
   *
   * **1440 の約数になる値を選ぶこと**: engine は per-tick レートへ 1 回だけ
   * floor 除算して落とすので(分割不変性のため)、約数でない値は静かに丸まる。
   */
  readonly masteryGainPerFieldWorkDay: number | null;
}

/**
 * [M5] 保管庫オーバーフロー・廃材スポンジ・廃材3出口(GDD 6.7)のパラメータ。
 *
 * **ブロックごと省略可**(欠落は null)。省略時は engine 側で上限判定も廃材生成も
 * 走らない = 既存挙動と完全に同一。資源ごとの上限/変換率は
 * 「resource 定義 ID → 値」のオブジェクトで持つ(resource カテゴリが未実装のため
 * ID の実在確認は行わない。GDD 12.1 の `item.overflow{policy,convertTo,ratio}` へ
 * 移すのは item カテゴリを足す段の作業)。
 */
export interface StorageParamsContent {
  /** 廃材の resource 定義 ID。null なら超過分は全て破棄。 */
  readonly wasteResourceId: string | null;
  /** resource 定義 ID → 基礎保管容量。ここに無い資源は**上限なし**。 */
  readonly baseCapacity: { readonly [resourceId: string]: number };
  /** resource 定義 ID → 超過分の廃材変換率(0〜1)。無指定は 0 = 単純破棄。 */
  readonly wasteConversionRatio: { readonly [resourceId: string]: number };
  /** GDD 6.7 3出口(3)「廃材 N → RP 1」の 1/N。 */
  readonly wasteToResearchRatio: number;
  /** GDD 6.7 3出口(1)「施設増築コストの一部代替(最大20%)」。 */
  readonly buildCostWasteSubstitutionMax: number;
  /** GDD 6.7 3出口(2)「成文化の粘土代替(低比率)」。 */
  readonly codifyWasteSubstitutionMax: number;
}

/**
 * [M6] エラ定義(GDD 5.1 のコスト表 / GDD 12.1 の `era` エンティティ)。
 *
 * GDD 12.1 は `era(id, order, gateTechId, baseEra, eraMultiplier)` を独立カテゴリ
 * として挙げているが、T6 は era カテゴリをロード対象に含めていない。ブロックを
 * 1 つ足すほうが「新カテゴリ + ファイル + 正準化 + ID レジストリ」より小さいので、
 * **暫定的に balance へ置く**(era カテゴリを足す段でそちらへ移すこと)。
 */
export interface EraContent {
  readonly id: string;
  /** 時代順(1 始まり)。 */
  readonly order: number;
  /** GDD 5.1 の base_era(E1=30 / E2=60 / E3=120)。 */
  readonly baseEra: number;
  /** GDD 5.1 の era_multiplier(E1=1 / E2=2 / E3=4)。成文化の時代係数でもある。 */
  readonly eraMultiplier: number;
  /** そのエラの壁テック(GDD 5.2)。tech カテゴリの実在確認は contentBundle。 */
  readonly gateTechId: string;
  /** GDD 5.1「n の上限＝各エラのクリティカルパス本数で固定」。 */
  readonly criticalPathMax: number;
}

/** [M6] 記録媒体 1 種のパラメータ(GDD 11.1 [2026-07-27追補] の表)。 */
export interface RecordMediumContent {
  readonly costMul: number;
  readonly timeMul: number;
  readonly caravanWeight: number;
  readonly flammable: boolean;
  /** コストを支払う資源(石板 = 粘土 / 紙 = 紙)。resource カテゴリ未実装ゆえ実在確認なし。 */
  readonly costResourceId: string;
}

/**
 * [M6] 成文化と記録媒体のパラメータ(GDD 11.1 追補 / 12.1 追補)。
 *
 * 媒体は engine 既知の 2 種固定なので、キーは `stoneTablet` / `paper` の
 * **2 つちょうど**を要求する(欠落も余剰も reject)。
 */
export interface RecordMediaContent {
  readonly baseCost: number;
  readonly baseDurationTicks: number;
  readonly printingTechId: string | null;
  readonly printingCostMul: number;
  readonly printingTimeMul: number;
  readonly stoneTablet: RecordMediumContent;
  readonly paper: RecordMediumContent;
}

/**
 * [M11] 人口下限 `min(寝床上限 × bedRatio, absolute)`(GDD 7.6 / 11.4-9)。
 * GDD 12.1 の `townParams(... populationFloor)` を式のまま分解したもの。
 */
export interface PopulationFloorContent {
  /** GDD 7.6 の 0.5(寝床上限に掛ける比率)。 */
  readonly bedRatio: number;
  /** GDD 7.6 の 6(絶対保証される人数の上限側)。 */
  readonly absolute: number;
}

/**
 * [M11] 住民寿命モデル・人口下限・獲得/規模(GDD 7.5〜7.7 / 12.1 `townParams`)。
 *
 * **ブロックごと省略可**(欠落は null)。省略時は engine 側で寿命の抽選も
 * 晴天漂着も走らない = M11 以前と完全に同一挙動。
 *
 * `lifespanQuantileMul` は「対数正規の逆 CDF をオーサリング時に等確率分位で
 * 展開した倍率表」であり、GDD 11.7 /ADR-006 が定める「非整数べき乗は実行時に
 * 計算せず JSON へ個別値として書き出す」の分布版である(詳細は
 * `src/engine/rules/lifespan.ts` §1)。表が本当に `lifespanSigma` の対数正規かは
 * `schema/engineContent.ts` が平均と変動係数を整数演算で検証する。
 */
export interface TownParamsContent {
  /** GDD 7.5 の平均寿命(432,000 tick = 約300日)。 */
  readonly lifespanMeanTicks: number;
  /**
   * GDD 7.5 の σ。**「平均の 0.25」という GDD の文言どおり変動係数
   * (標準偏差 ÷ 平均)として解釈する**。`lifespanQuantileMul` の生成パラメータ
   * であり、engine へは写らない代わりにローダーが表と突き合わせて検証する。
   */
  readonly lifespanSigma: number;
  /** 平均寿命に対する倍率の分位表(昇順・全て正・連続版の期待値が 1.0)。 */
  readonly lifespanQuantileMul: readonly number[];
  /** GDD 7.5 の記憶巧者 `memoryDecayDelay`(1.5)。 */
  readonly memoryDecayDelay: number;
  /** GDD 7.6 の人口下限。 */
  readonly populationFloor: PopulationFloorContent;
  /** GDD 7.7 の晴天漂着の周期(tick)。 */
  readonly arrivalIntervalTicks: number;
  /** GDD 7.6「下限を下回ると漂着加入頻度 ×1.5」の 1.5。 */
  readonly scarcityArrivalFrequencyMul: number;
  /** 加入時年齢(tick)の下限。 */
  readonly joinAgeMinTicks: number;
  /** 加入時年齢(tick)の上限。 */
  readonly joinAgeMaxTicks: number;
}

/**
 * [M21] 距離帯 1 本ぶんの探索パラメータ(GDD 8.1 / 8.2 / 8.5)。
 * 難度・R・ノード数は**人間単位の整数**(engine 側 rules/types.ts の doc 参照)。
 */
export interface ExplorationBandContent {
  readonly baseTravelTicks: number;
  readonly nodeCountMin: number;
  readonly nodeCountMax: number;
  readonly difficultyMin: number;
  readonly difficultyMax: number;
  readonly rollRange: number;
  readonly rewardPerNode: number;
  readonly rewardResourceId: string;
  readonly injuryPerFailure: number;
  readonly casualtyInjuryThreshold: number;
  readonly rescueChance: number;
  readonly wipeBaseP: number;
}

/**
 * [M21] 探索パラメータ(GDD 8.1〜8.6)。**ブロックごと省略可**(欠落は null)。
 * 省略時は engine 側で派遣コマンドが `contentUnsupported` になる = M21 以前と
 * 完全に同一挙動。
 */
/**
 * [M22] 探索報酬のオーバーフロー方策(GDD 12.1 の
 * `item(… overflow{policy, convertTo, ratio})` / GDD 6.7)。**省略可**であり、
 * 省略時は上限なし(= M21 と完全に同一挙動)。
 *
 * 置き場が balance なのは item カテゴリが MVP に無いためで、item entity が
 * 入ったら方策の**出所だけ**がそちらへ移る(engine 側の primitive は不変)。
 */
export interface RewardOverflowContent {
  /** `discard`(超過分破棄・GDD 6.7 の原則)/ `convert`(変換)。 */
  readonly policy: string;
  /** 受け取り上限。 */
  readonly capacity: number;
  /** `convert` のときの変換先 resource 定義 ID。`discard` では null。 */
  readonly convertTo: string | null;
  /** `convert` のときの変換率(0〜1)。`discard` では 0。 */
  readonly ratio: number;
}

export interface ExplorationContent {
  readonly withdrawRewardRatio: number;
  readonly pressInjuryMul: number;
  readonly withdrawInjuryThreshold: number;
  readonly equipmentBonus: number;
  readonly travelSpeedupMax: number;
  readonly forgoneOutputPerWorkerTick: number;
  readonly rareAssetValue: number;
  readonly wipeMaxP: number;
  /** 距離帯別(裁定 B7 の `near`/`far`/`deep` が 3 つとも必須)。 */
  readonly bands: { readonly [band: string]: ExplorationBandContent };
  /** [M22] 報酬のオーバーフロー方策。JSON に無ければ null(上限なし)。 */
  readonly rewardOverflow: RewardOverflowContent | null;
}

export interface BalanceContent {
  readonly fpScale: number;
  readonly algoVersion: number;
  readonly coarseTickMinutes: number;
  readonly offlineClampTick: number;
  readonly safetyFactor: number;
  readonly recallRiskParams: RecallRiskParams;
  /** [M5] GDD 6.7 の保管庫パラメータ。JSON に無ければ null。 */
  readonly storage: StorageParamsContent | null;
  /** [M6] GDD 5.1 のエラ表。JSON に無ければ null(= エラという概念が無い content)。 */
  readonly eras: readonly EraContent[] | null;
  /** [M6] GDD 11.1 追補の記録媒体パラメータ。JSON に無ければ null(成文化不可)。 */
  readonly recordMedia: RecordMediaContent | null;
  /** [M11] GDD 7.5〜7.7 の住民系パラメータ。JSON に無ければ null(寿命/漂着なし)。 */
  readonly townParams: TownParamsContent | null;
  /** [M21] GDD 8.1〜8.6 の探索パラメータ。JSON に無ければ null(派遣不可)。 */
  readonly exploration: ExplorationContent | null;
}

/** [M5] 保管容量の保守境界(lvCurve と同じ上限)。 */
const CAPACITY_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

/** [M5] GDD 6.7「最大20%」を上限とする代替比率の保守境界。 */
const SUBSTITUTION_RATIO_RANGE: NumericRange = { min: 0, max: 0.2 };

function validateResourceNumberMap(
  raw: unknown,
  path: string,
  issues: IssueCollector,
  range: NumericRange,
): { readonly [resourceId: string]: number } | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const result: Record<string, number> = {};
  const issuesBefore = issues.list().length;
  for (const key of Object.keys(obj)) {
    const resourceId = validateId(key, `${path}.${key}`, issues);
    const value = expectNumber(obj[key], `${path}.${key}`, issues, range);
    if (resourceId === undefined || value === undefined) continue;
    result[resourceId] = value;
  }
  return issues.list().length === issuesBefore ? result : undefined;
}

function validateStorage(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): StorageParamsContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const rawWasteResourceId = obj["wasteResourceId"];
  const wasteResourceId =
    rawWasteResourceId === undefined || rawWasteResourceId === null
      ? null
      : (validateId(rawWasteResourceId, `${path}.wasteResourceId`, issues) ?? undefined);
  const baseCapacity = validateResourceNumberMap(
    obj["baseCapacity"] ?? {},
    `${path}.baseCapacity`,
    issues,
    CAPACITY_RANGE,
  );
  const wasteConversionRatio = validateResourceNumberMap(
    obj["wasteConversionRatio"] ?? {},
    `${path}.wasteConversionRatio`,
    issues,
    UNIT_RANGE,
  );
  const wasteToResearchRatio = expectNumber(
    obj["wasteToResearchRatio"],
    `${path}.wasteToResearchRatio`,
    issues,
    UNIT_RANGE,
  );
  const buildCostWasteSubstitutionMax = expectNumber(
    obj["buildCostWasteSubstitutionMax"],
    `${path}.buildCostWasteSubstitutionMax`,
    issues,
    SUBSTITUTION_RATIO_RANGE,
  );
  const codifyWasteSubstitutionMax = expectNumber(
    obj["codifyWasteSubstitutionMax"],
    `${path}.codifyWasteSubstitutionMax`,
    issues,
    SUBSTITUTION_RATIO_RANGE,
  );

  if (
    wasteResourceId === undefined ||
    baseCapacity === undefined ||
    wasteConversionRatio === undefined ||
    wasteToResearchRatio === undefined ||
    buildCostWasteSubstitutionMax === undefined ||
    codifyWasteSubstitutionMax === undefined
  ) {
    return undefined;
  }

  // 廃材変換率が指定されているのに変換先が無ければ、変換分は行き場を失う
  // (黙って破棄せず reject する。GDD 6.7 のスポンジ機構が成立しない設定)。
  if (wasteResourceId === null && Object.keys(wasteConversionRatio).length > 0) {
    issues.add(
      `${path}.wasteResourceId`,
      "wasteConversionRatio が指定されているのに wasteResourceId が無い(廃材の行き先が決まらない)",
    );
    return undefined;
  }

  return {
    wasteResourceId,
    baseCapacity,
    wasteConversionRatio,
    wasteToResearchRatio,
    buildCostWasteSubstitutionMax,
    codifyWasteSubstitutionMax,
  };
}

// --- [M6] eras / recordMedia -----------------------------------------------

/** GDD 5.1 のエラ表は E1〜E5 の 5 段(MVP は E1〜E3)。 */
const ERA_ORDER_RANGE: NumericRange = { min: 1, max: 5 };
/** base_era は 30〜480(GDD 5.1 の表)を含む保守境界。 */
const BASE_ERA_RANGE: NumericRange = { min: 1, max: 100_000 };
/** era_multiplier は 1〜16(GDD 5.1 の表)を含む保守境界。 */
const ERA_MULTIPLIER_RANGE: NumericRange = { min: 1, max: 1_000 };
/** クリティカルパス本数の上限(GDD 5.1 は E1=3 / E2=3 / E3=4 程度)。 */
const CRITICAL_PATH_MAX_RANGE: NumericRange = { min: 1, max: 20 };
/** 媒体倍率(コスト/時間)の保守境界。0 は「タダ/即完了」になるので除外する。 */
const MEDIUM_MUL_RANGE: NumericRange = { min: 0.000_001, max: 100 };
/** キャラバン重み(石版換算枠)。石板 1.0 / 紙 0.25(GDD 11.1 追補)。 */
const CARAVAN_WEIGHT_RANGE: NumericRange = { min: 0, max: 100 };
/** 印刷バフの倍率。バフなので 1 以下(GDD 5.2「-50% / ×2」= 0.5)。 */
const PRINTING_MUL_RANGE: NumericRange = { min: 0.000_001, max: 1 };
/** 記録 1 枚の基準コスト。 */
const RECORD_BASE_COST_RANGE: NumericRange = { min: 0, max: 1_000_000 };
/** 記録 1 枚の基準作業 tick(1 分 tick 換算)。上限は 30 日ぶん。 */
const RECORD_BASE_DURATION_RANGE: NumericRange = { min: 1, max: 43_200 };

function validateEra(raw: unknown, path: string, issues: IssueCollector): EraContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const id = validateId(obj["id"], `${path}.id`, issues);
  const order = expectInteger(obj["order"], `${path}.order`, issues, ERA_ORDER_RANGE);
  const baseEra = expectNumber(obj["baseEra"], `${path}.baseEra`, issues, BASE_ERA_RANGE);
  const eraMultiplier = expectNumber(
    obj["eraMultiplier"],
    `${path}.eraMultiplier`,
    issues,
    ERA_MULTIPLIER_RANGE,
  );
  const gateTechId = validateId(obj["gateTechId"], `${path}.gateTechId`, issues);
  const criticalPathMax = expectInteger(
    obj["criticalPathMax"],
    `${path}.criticalPathMax`,
    issues,
    CRITICAL_PATH_MAX_RANGE,
  );

  if (
    id === undefined ||
    order === undefined ||
    baseEra === undefined ||
    eraMultiplier === undefined ||
    gateTechId === undefined ||
    criticalPathMax === undefined
  ) {
    return undefined;
  }
  return { id, order, baseEra, eraMultiplier, gateTechId, criticalPathMax };
}

function validateEras(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly EraContent[] | undefined {
  if (!Array.isArray(raw)) {
    issues.add(path, "eras は配列(GDD 5.1 のエラ表)");
    return undefined;
  }
  const source = raw as readonly unknown[];
  const eras: EraContent[] = [];
  for (let i = 0; i < source.length; i++) {
    const era = validateEra(source[i], `${path}[${String(i)}]`, issues);
    if (era !== undefined) eras.push(era);
  }
  if (eras.length !== source.length) return undefined;

  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  for (const era of eras) {
    if (seenIds.has(era.id)) {
      issues.add(path, `エラ ID "${era.id}" が重複している`);
      return undefined;
    }
    seenIds.add(era.id);
    if (seenOrders.has(era.order)) {
      issues.add(path, `エラ order ${String(era.order)} が重複している(時代順が一意に決まらない)`);
      return undefined;
    }
    seenOrders.add(era.order);
  }
  return eras;
}

function validateRecordMedium(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RecordMediumContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const costMul = expectNumber(obj["costMul"], `${path}.costMul`, issues, MEDIUM_MUL_RANGE);
  const timeMul = expectNumber(obj["timeMul"], `${path}.timeMul`, issues, MEDIUM_MUL_RANGE);
  const caravanWeight = expectNumber(
    obj["caravanWeight"],
    `${path}.caravanWeight`,
    issues,
    CARAVAN_WEIGHT_RANGE,
  );
  const flammable = expectBoolean(obj["flammable"], `${path}.flammable`, issues);
  const costResourceId = validateId(obj["costResourceId"], `${path}.costResourceId`, issues);

  if (
    costMul === undefined ||
    timeMul === undefined ||
    caravanWeight === undefined ||
    flammable === undefined ||
    costResourceId === undefined
  ) {
    return undefined;
  }
  return { costMul, timeMul, caravanWeight, flammable, costResourceId };
}

function validateRecordMedia(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RecordMediaContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const baseCost = expectNumber(
    obj["baseCost"],
    `${path}.baseCost`,
    issues,
    RECORD_BASE_COST_RANGE,
  );
  const baseDurationTicks = expectInteger(
    obj["baseDurationTicks"],
    `${path}.baseDurationTicks`,
    issues,
    RECORD_BASE_DURATION_RANGE,
  );
  const rawPrintingTechId = obj["printingTechId"];
  const printingTechId =
    rawPrintingTechId === undefined || rawPrintingTechId === null
      ? null
      : (validateId(rawPrintingTechId, `${path}.printingTechId`, issues) ?? undefined);
  const printingCostMul = expectNumber(
    obj["printingCostMul"],
    `${path}.printingCostMul`,
    issues,
    PRINTING_MUL_RANGE,
  );
  const printingTimeMul = expectNumber(
    obj["printingTimeMul"],
    `${path}.printingTimeMul`,
    issues,
    PRINTING_MUL_RANGE,
  );
  const stoneTablet = validateRecordMedium(obj["stoneTablet"], `${path}.stoneTablet`, issues);
  const paper = validateRecordMedium(obj["paper"], `${path}.paper`, issues);

  if (
    baseCost === undefined ||
    baseDurationTicks === undefined ||
    printingTechId === undefined ||
    printingCostMul === undefined ||
    printingTimeMul === undefined ||
    stoneTablet === undefined ||
    paper === undefined
  ) {
    return undefined;
  }

  // GDD 11.1 追補の表そのもの。ここを崩すと「紙＝安い/速い/軽い、石板＝高い/遅い/重い」
  // という媒体選択のジレンマ(=このシステムの存在理由)が消えるので機械強制する。
  if (paper.costMul > stoneTablet.costMul) {
    issues.add(path, "紙は石板よりコストが安いこと(GDD 11.1 追補: 紙 = 安・速)");
    return undefined;
  }
  if (paper.timeMul > stoneTablet.timeMul) {
    issues.add(path, "紙は石板より学者作業時間が短いこと(GDD 11.1 追補)");
    return undefined;
  }
  if (paper.caravanWeight >= stoneTablet.caravanWeight) {
    issues.add(path, "紙は石板よりキャラバン重みが軽いこと(GDD 10.2 追補: 石板 1.0 / 紙 0.25)");
    return undefined;
  }
  if (!paper.flammable || stoneTablet.flammable) {
    issues.add(path, "可燃なのは紙のみ(GDD 11.1 追補: 石板 = 不燃)");
    return undefined;
  }

  return {
    baseCost,
    baseDurationTicks,
    printingTechId,
    printingCostMul,
    printingTimeMul,
    stoneTablet,
    paper,
  };
}

// --- [M11] townParams(GDD 7.5〜7.7 / 12.1)---------------------------------

/** 平均寿命の保守境界。1 tick 〜 100 年相当(GDD 7.5 は 432,000 = 約300日)。 */
const LIFESPAN_MEAN_RANGE: NumericRange = { min: 1, max: 52_560_000 };
/** GDD 7.5 の σ(変動係数)。0 は「全員が同じ寿命」= 分布が退化するので除外。 */
const LIFESPAN_SIGMA_RANGE: NumericRange = { min: 0.01, max: 1 };
/** 分位倍率の保守境界。0 以下は寿命 0 を生むので除外。 */
const LIFESPAN_QUANTILE_MUL_RANGE: NumericRange = { min: 0.000_001, max: 100 };
/** 分位表の分割数。粗すぎると寿命が数値化けするので下限 8。上限は一様分布の実装上限。 */
const LIFESPAN_QUANTILE_COUNT_RANGE: NumericRange = { min: 8, max: 2_097_152 };
/** GDD 7.5 の memoryDecayDelay。1 未満は「猶予」でなく短縮になるので除外。 */
const MEMORY_DECAY_DELAY_RANGE: NumericRange = { min: 1, max: 10 };
/** GDD 7.6 の寝床比率。 */
const POPULATION_FLOOR_BED_RATIO_RANGE: NumericRange = { min: 0, max: 1 };
/** GDD 7.6 の絶対保証人数(6)。GDD 7.7 の規模 8〜20 を超える値は設定ミス。 */
const POPULATION_FLOOR_ABSOLUTE_RANGE: NumericRange = { min: 0, max: 20 };
/** 晴天漂着の周期。上限は 30 日ぶん(1 分 tick 換算)。 */
const ARRIVAL_INTERVAL_RANGE: NumericRange = { min: 1, max: 43_200 };
/** GDD 7.6 の頻度倍率(1.5)。1 未満は「不足時に遅くなる」ので除外。 */
const SCARCITY_FREQUENCY_MUL_RANGE: NumericRange = { min: 1, max: 10 };
/** 加入時年齢(tick)。0(新生児)〜 100 年相当。 */
const JOIN_AGE_RANGE: NumericRange = { min: 0, max: 52_560_000 };
/**
 * 加入時年齢のレンジ幅の上限。`src/engine/stochastic.ts` の `UNIFORM_SPAN_MAX`
 * (= floor((2^53-1)/(2^32-1)))と同値。ここを超えると一様抽選の中間積が
 * 2^53 を超えて厳密でなくなる。engine 側は例外を投げるが、content の段で止める。
 */
const JOIN_AGE_SPAN_MAX = 2_097_152;

function validatePopulationFloor(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): PopulationFloorContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const bedRatio = expectNumber(
    obj["bedRatio"],
    `${path}.bedRatio`,
    issues,
    POPULATION_FLOOR_BED_RATIO_RANGE,
  );
  const absolute = expectInteger(
    obj["absolute"],
    `${path}.absolute`,
    issues,
    POPULATION_FLOOR_ABSOLUTE_RANGE,
  );
  if (bedRatio === undefined || absolute === undefined) return undefined;
  return { bedRatio, absolute };
}

function validateLifespanQuantileMul(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (
    arr.length < LIFESPAN_QUANTILE_COUNT_RANGE.min ||
    arr.length > LIFESPAN_QUANTILE_COUNT_RANGE.max
  ) {
    issues.add(
      path,
      `分位表の要素数 ${String(arr.length)} が [${String(LIFESPAN_QUANTILE_COUNT_RANGE.min)}, ` +
        `${String(LIFESPAN_QUANTILE_COUNT_RANGE.max)}] の外`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const value = expectNumber(
      arr[i],
      `${path}[${String(i)}]`,
      issues,
      LIFESPAN_QUANTILE_MUL_RANGE,
    );
    if (value !== undefined) values.push(value);
  }
  if (values.length !== arr.length) return undefined;

  // 逆 CDF は単調非減少でなければならない。崩れていれば「分位表」ではない。
  for (let i = 1; i < values.length; i++) {
    const previous = values[i - 1] ?? 0;
    const current = values[i] ?? 0;
    if (current < previous) {
      issues.add(
        `${path}[${String(i)}]`,
        `分位表は昇順が必須(逆 CDF の単調性)。${String(previous)} の次が ${String(current)}`,
      );
      return undefined;
    }
  }
  return values;
}

function validateTownParams(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): TownParamsContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const lifespanMeanTicks = expectInteger(
    obj["lifespanMeanTicks"],
    `${path}.lifespanMeanTicks`,
    issues,
    LIFESPAN_MEAN_RANGE,
  );
  const lifespanSigma = expectNumber(
    obj["lifespanSigma"],
    `${path}.lifespanSigma`,
    issues,
    LIFESPAN_SIGMA_RANGE,
  );
  const lifespanQuantileMul = validateLifespanQuantileMul(
    obj["lifespanQuantileMul"],
    `${path}.lifespanQuantileMul`,
    issues,
  );
  const memoryDecayDelay = expectNumber(
    obj["memoryDecayDelay"],
    `${path}.memoryDecayDelay`,
    issues,
    MEMORY_DECAY_DELAY_RANGE,
  );
  const populationFloor = validatePopulationFloor(
    obj["populationFloor"],
    `${path}.populationFloor`,
    issues,
  );
  const arrivalIntervalTicks = expectInteger(
    obj["arrivalIntervalTicks"],
    `${path}.arrivalIntervalTicks`,
    issues,
    ARRIVAL_INTERVAL_RANGE,
  );
  const scarcityArrivalFrequencyMul = expectNumber(
    obj["scarcityArrivalFrequencyMul"],
    `${path}.scarcityArrivalFrequencyMul`,
    issues,
    SCARCITY_FREQUENCY_MUL_RANGE,
  );
  const joinAgeMinTicks = expectInteger(
    obj["joinAgeMinTicks"],
    `${path}.joinAgeMinTicks`,
    issues,
    JOIN_AGE_RANGE,
  );
  const joinAgeMaxTicks = expectInteger(
    obj["joinAgeMaxTicks"],
    `${path}.joinAgeMaxTicks`,
    issues,
    JOIN_AGE_RANGE,
  );

  if (
    lifespanMeanTicks === undefined ||
    lifespanSigma === undefined ||
    lifespanQuantileMul === undefined ||
    memoryDecayDelay === undefined ||
    populationFloor === undefined ||
    arrivalIntervalTicks === undefined ||
    scarcityArrivalFrequencyMul === undefined ||
    joinAgeMinTicks === undefined ||
    joinAgeMaxTicks === undefined
  ) {
    return undefined;
  }

  if (joinAgeMinTicks > joinAgeMaxTicks) {
    issues.add(
      path,
      `joinAgeMinTicks (${String(joinAgeMinTicks)}) は joinAgeMaxTicks (${String(joinAgeMaxTicks)}) 以下が必須`,
    );
    return undefined;
  }
  if (joinAgeMaxTicks - joinAgeMinTicks + 1 > JOIN_AGE_SPAN_MAX) {
    issues.add(
      path,
      `加入時年齢のレンジ幅が上限 ${String(JOIN_AGE_SPAN_MAX)} を超えている` +
        "(一様抽選の中間積が 2^53 を超えて厳密でなくなる・src/engine/stochastic.ts §3)",
    );
    return undefined;
  }

  return {
    lifespanMeanTicks,
    lifespanSigma,
    lifespanQuantileMul,
    memoryDecayDelay,
    populationFloor,
    arrivalIntervalTicks,
    scarcityArrivalFrequencyMul,
    joinAgeMinTicks,
    joinAgeMaxTicks,
  };
}

function validateRecallRiskParams(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RecallRiskParams | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const base_p = expectNumber(obj["base_p"], `${path}.base_p`, issues, UNIT_RANGE);
  const p_max = expectNumber(obj["p_max"], `${path}.p_max`, issues, UNIT_RANGE);
  const loadWHarsh = expectNumber(obj["loadWHarsh"], `${path}.loadWHarsh`, issues, {
    min: 0,
    max: 10,
  });
  const loadWNormal = expectNumber(obj["loadWNormal"], `${path}.loadWNormal`, issues, {
    min: 0,
    max: 10,
  });
  const moraleThresholdMid = expectNumber(
    obj["moraleThresholdMid"],
    `${path}.moraleThresholdMid`,
    issues,
    MORALE_SCALE_RANGE,
  );
  const moraleBonusMid = expectNumber(
    obj["moraleBonusMid"],
    `${path}.moraleBonusMid`,
    issues,
    UNIT_RANGE,
  );
  const moraleThresholdLow = expectNumber(
    obj["moraleThresholdLow"],
    `${path}.moraleThresholdLow`,
    issues,
    MORALE_SCALE_RANGE,
  );
  const moraleBonusLow = expectNumber(
    obj["moraleBonusLow"],
    `${path}.moraleBonusLow`,
    issues,
    UNIT_RANGE,
  );
  const dispatchW = expectNumber(obj["dispatchW"], `${path}.dispatchW`, issues, UNIT_RANGE);
  const masteryResistMax = expectNumber(
    obj["masteryResistMax"],
    `${path}.masteryResistMax`,
    issues,
    UNIT_RANGE,
  );
  const memoryKeeperResist = expectNumber(
    obj["memoryKeeperResist"],
    `${path}.memoryKeeperResist`,
    issues,
    RESIST_RANGE,
  );

  // 省略可フィールド(ファイル冒頭 [T7]): キーが無ければ null、あれば形式を検証する。
  const rawTraitId = obj["memoryKeeperTraitId"];
  const memoryKeeperTraitId =
    rawTraitId === undefined
      ? null
      : (validateId(rawTraitId, `${path}.memoryKeeperTraitId`, issues) ?? undefined);
  const rawDurationMin = obj["durationTicksMin"];
  const durationTicksMin =
    rawDurationMin === undefined
      ? null
      : (expectInteger(
          rawDurationMin,
          `${path}.durationTicksMin`,
          issues,
          RECALL_DURATION_TICKS_RANGE,
        ) ?? undefined);
  const rawMasteryGain = obj["masteryGainPerFieldWorkDay"];
  const masteryGainPerFieldWorkDay =
    rawMasteryGain === undefined
      ? null
      : (expectNumber(rawMasteryGain, `${path}.masteryGainPerFieldWorkDay`, issues, UNIT_RANGE) ??
        undefined);
  const rawDurationMax = obj["durationTicksMax"];
  const durationTicksMax =
    rawDurationMax === undefined
      ? null
      : (expectInteger(
          rawDurationMax,
          `${path}.durationTicksMax`,
          issues,
          RECALL_DURATION_TICKS_RANGE,
        ) ?? undefined);

  if (
    base_p === undefined ||
    p_max === undefined ||
    loadWHarsh === undefined ||
    loadWNormal === undefined ||
    moraleThresholdMid === undefined ||
    moraleBonusMid === undefined ||
    moraleThresholdLow === undefined ||
    moraleBonusLow === undefined ||
    dispatchW === undefined ||
    masteryResistMax === undefined ||
    memoryKeeperResist === undefined ||
    memoryKeeperTraitId === undefined ||
    durationTicksMin === undefined ||
    durationTicksMax === undefined ||
    masteryGainPerFieldWorkDay === undefined
  ) {
    return undefined;
  }

  if (
    durationTicksMin !== null &&
    durationTicksMax !== null &&
    durationTicksMin > durationTicksMax
  ) {
    issues.add(
      path,
      `durationTicksMin (${String(durationTicksMin)}) は durationTicksMax (${String(durationTicksMax)}) 以下が必須`,
    );
    return undefined;
  }
  if ((durationTicksMin === null) !== (durationTicksMax === null)) {
    issues.add(
      path,
      "durationTicksMin / durationTicksMax は両方指定か両方省略のいずれか(片方だけの指定は持続レンジが決まらない)",
    );
    return undefined;
  }

  if (base_p > p_max) {
    issues.add(path, `base_p (${String(base_p)}) は p_max (${String(p_max)}) 以下が必須`);
    return undefined;
  }
  if (loadWHarsh <= loadWNormal) {
    issues.add(
      path,
      `loadWHarsh (${String(loadWHarsh)}) は loadWNormal (${String(loadWNormal)}) より大が必須(GDD 11.2: 過酷×2.0 > 通常×0.5)`,
    );
    return undefined;
  }
  if (moraleThresholdLow >= moraleThresholdMid) {
    issues.add(
      path,
      `moraleThresholdLow (${String(moraleThresholdLow)}) は moraleThresholdMid (${String(moraleThresholdMid)}) 未満が必須`,
    );
    return undefined;
  }
  if (moraleBonusLow < moraleBonusMid) {
    issues.add(
      path,
      `moraleBonusLow (${String(moraleBonusLow)}) は moraleBonusMid (${String(moraleBonusMid)}) 以上が必須(士気が低いほど加算大)`,
    );
    return undefined;
  }

  return {
    base_p,
    p_max,
    loadWHarsh,
    loadWNormal,
    moraleThresholdMid,
    moraleBonusMid,
    moraleThresholdLow,
    moraleBonusLow,
    dispatchW,
    masteryResistMax,
    memoryKeeperResist,
    memoryKeeperTraitId,
    durationTicksMin,
    durationTicksMax,
    masteryGainPerFieldWorkDay,
  };
}

// --- [M21] exploration(GDD 8.1〜8.6)-----------------------------------------

/** 距離帯の正本(裁定 B7)。engine 側 `rules/types.ts` の DISTANCE_BANDS と同一。 */
const EXPLORATION_BANDS = ["near", "far", "deep"] as const;

const TRAVEL_TICKS_RANGE: NumericRange = { min: 1, max: 43_200 };

/** GDD 8.2「イベント列 3〜8 ノード」。engine の DISPATCH_EVENT_NODES_MAX と一致。 */
const NODE_COUNT_RANGE: NumericRange = { min: 1, max: 8 };

/** 難度・R は combatPower(0〜100)× チーム人数の尺度。保守的に 1〜1000。 */
const DIFFICULTY_RANGE: NumericRange = { min: 1, max: 1_000 };

const REWARD_PER_NODE_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

const INJURY_RANGE: NumericRange = { min: 0, max: 1_000 };

/** GDD 8.1「最大 -30% 短縮」。上限側に余裕を持たせて 0〜0.5。 */
const TRAVEL_SPEEDUP_RANGE: NumericRange = { min: 0, max: 0.5 };

/** GDD 8.3「強行 = 負傷リスク ×1.5」。 */
const PRESS_INJURY_MUL_RANGE: NumericRange = { min: 1, max: 5 };

const FORGONE_OUTPUT_RANGE: NumericRange = { min: 0, max: 1_000 };

const RARE_ASSET_VALUE_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

function validateExplorationBand(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): ExplorationBandContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const baseTravelTicks = expectInteger(
    obj["baseTravelTicks"],
    `${path}.baseTravelTicks`,
    issues,
    TRAVEL_TICKS_RANGE,
  );
  const nodeCountMin = expectInteger(
    obj["nodeCountMin"],
    `${path}.nodeCountMin`,
    issues,
    NODE_COUNT_RANGE,
  );
  const nodeCountMax = expectInteger(
    obj["nodeCountMax"],
    `${path}.nodeCountMax`,
    issues,
    NODE_COUNT_RANGE,
  );
  const difficultyMin = expectInteger(
    obj["difficultyMin"],
    `${path}.difficultyMin`,
    issues,
    DIFFICULTY_RANGE,
  );
  const difficultyMax = expectInteger(
    obj["difficultyMax"],
    `${path}.difficultyMax`,
    issues,
    DIFFICULTY_RANGE,
  );
  const rollRange = expectInteger(obj["rollRange"], `${path}.rollRange`, issues, DIFFICULTY_RANGE);
  const rewardPerNode = expectNumber(
    obj["rewardPerNode"],
    `${path}.rewardPerNode`,
    issues,
    REWARD_PER_NODE_RANGE,
  );
  const rewardResourceId = validateId(obj["rewardResourceId"], `${path}.rewardResourceId`, issues);
  const injuryPerFailure = expectNumber(
    obj["injuryPerFailure"],
    `${path}.injuryPerFailure`,
    issues,
    INJURY_RANGE,
  );
  const casualtyInjuryThreshold = expectNumber(
    obj["casualtyInjuryThreshold"],
    `${path}.casualtyInjuryThreshold`,
    issues,
    INJURY_RANGE,
  );
  const rescueChance = expectNumber(
    obj["rescueChance"],
    `${path}.rescueChance`,
    issues,
    UNIT_RANGE,
  );
  const wipeBaseP = expectNumber(obj["wipeBaseP"], `${path}.wipeBaseP`, issues, UNIT_RANGE);

  if (
    baseTravelTicks === undefined ||
    nodeCountMin === undefined ||
    nodeCountMax === undefined ||
    difficultyMin === undefined ||
    difficultyMax === undefined ||
    rollRange === undefined ||
    rewardPerNode === undefined ||
    rewardResourceId === undefined ||
    injuryPerFailure === undefined ||
    casualtyInjuryThreshold === undefined ||
    rescueChance === undefined ||
    wipeBaseP === undefined
  ) {
    return undefined;
  }
  if (nodeCountMax < nodeCountMin) {
    issues.add(path, `nodeCountMax(${String(nodeCountMax)})は nodeCountMin 以上が必須`);
    return undefined;
  }
  if (difficultyMax < difficultyMin) {
    issues.add(path, `difficultyMax(${String(difficultyMax)})は difficultyMin 以上が必須`);
    return undefined;
  }
  if (casualtyInjuryThreshold <= 0) {
    issues.add(
      `${path}.casualtyInjuryThreshold`,
      "脱落閾値は正が必須(0 だと 1 度の失敗で全員脱落する)",
    );
    return undefined;
  }
  return {
    baseTravelTicks,
    nodeCountMin,
    nodeCountMax,
    difficultyMin,
    difficultyMax,
    rollRange,
    rewardPerNode,
    rewardResourceId,
    injuryPerFailure,
    casualtyInjuryThreshold,
    rescueChance,
    wipeBaseP,
  };
}

/** [M22] 報酬のオーバーフロー方策(GDD 12.1 `item.overflow`)。 */
function validateRewardOverflow(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): RewardOverflowContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const policy = expectString(obj["policy"], `${path}.policy`, issues);
  const capacity = expectNumber(obj["capacity"], `${path}.capacity`, issues, CAPACITY_RANGE);
  const ratio = expectNumber(obj["ratio"], `${path}.ratio`, issues, UNIT_RANGE);
  if (policy === undefined || capacity === undefined || ratio === undefined) return undefined;
  if (!isOverflowPolicyKind(policy)) {
    issues.add(
      `${path}.policy`,
      `policy は ${OVERFLOW_POLICIES.join(" | ")} のいずれか(実際: ${JSON.stringify(policy)})`,
    );
    return undefined;
  }
  const rawConvertTo = obj["convertTo"];
  if (policy === "discard") {
    if (rawConvertTo !== undefined && rawConvertTo !== null) {
      issues.add(`${path}.convertTo`, "policy=discard では convertTo は null / 省略が必須");
      return undefined;
    }
    return { policy, capacity, convertTo: null, ratio };
  }
  const convertTo = expectString(rawConvertTo, `${path}.convertTo`, issues);
  if (convertTo === undefined) return undefined;
  return { policy, capacity, convertTo, ratio };
}

function validateExploration(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): ExplorationContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const withdrawRewardRatio = expectNumber(
    obj["withdrawRewardRatio"],
    `${path}.withdrawRewardRatio`,
    issues,
    UNIT_RANGE,
  );
  const pressInjuryMul = expectNumber(
    obj["pressInjuryMul"],
    `${path}.pressInjuryMul`,
    issues,
    PRESS_INJURY_MUL_RANGE,
  );
  const withdrawInjuryThreshold = expectNumber(
    obj["withdrawInjuryThreshold"],
    `${path}.withdrawInjuryThreshold`,
    issues,
    INJURY_RANGE,
  );
  const equipmentBonus = expectNumber(
    obj["equipmentBonus"],
    `${path}.equipmentBonus`,
    issues,
    MORALE_SCALE_RANGE,
  );
  const travelSpeedupMax = expectNumber(
    obj["travelSpeedupMax"],
    `${path}.travelSpeedupMax`,
    issues,
    TRAVEL_SPEEDUP_RANGE,
  );
  const forgoneOutputPerWorkerTick = expectNumber(
    obj["forgoneOutputPerWorkerTick"],
    `${path}.forgoneOutputPerWorkerTick`,
    issues,
    FORGONE_OUTPUT_RANGE,
  );
  const rareAssetValue = expectNumber(
    obj["rareAssetValue"],
    `${path}.rareAssetValue`,
    issues,
    RARE_ASSET_VALUE_RANGE,
  );
  const wipeMaxP = expectNumber(obj["wipeMaxP"], `${path}.wipeMaxP`, issues, UNIT_RANGE);

  // [M22] 省略可。キー不在 = 上限なし(M21 と同一挙動)。
  const rawOverflow = obj["rewardOverflow"];
  const rewardOverflow =
    rawOverflow === undefined
      ? null
      : (validateRewardOverflow(rawOverflow, `${path}.rewardOverflow`, issues) ?? undefined);

  const rawBands = expectRecord(obj["bands"], `${path}.bands`, issues);
  let bands: { [band: string]: ExplorationBandContent } | undefined = {};
  if (rawBands === undefined) {
    bands = undefined;
  } else {
    for (const band of EXPLORATION_BANDS) {
      const value = rawBands[band];
      if (value === undefined) {
        issues.add(`${path}.bands`, `距離帯 "${band}" が必須(裁定 B7: near/far/deep)`);
        bands = undefined;
        continue;
      }
      const parsed = validateExplorationBand(value, `${path}.bands.${band}`, issues);
      if (parsed === undefined) {
        bands = undefined;
        continue;
      }
      if (bands !== undefined) bands[band] = parsed;
    }
  }

  if (
    withdrawRewardRatio === undefined ||
    pressInjuryMul === undefined ||
    withdrawInjuryThreshold === undefined ||
    equipmentBonus === undefined ||
    travelSpeedupMax === undefined ||
    forgoneOutputPerWorkerTick === undefined ||
    rareAssetValue === undefined ||
    wipeMaxP === undefined ||
    rewardOverflow === undefined ||
    bands === undefined
  ) {
    return undefined;
  }
  return {
    withdrawRewardRatio,
    pressInjuryMul,
    withdrawInjuryThreshold,
    equipmentBonus,
    travelSpeedupMax,
    forgoneOutputPerWorkerTick,
    rareAssetValue,
    wipeMaxP,
    bands,
    rewardOverflow,
  };
}

export function validateBalance(raw: unknown): ValidationResult<BalanceContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const fpScale = expectExactNumber(obj["fpScale"], FP_SCALE, "$.fpScale", issues);
  const algoVersion = expectInteger(obj["algoVersion"], "$.algoVersion", issues, POSITIVE_INT);
  const coarseTickMinutes = expectInteger(
    obj["coarseTickMinutes"],
    "$.coarseTickMinutes",
    issues,
    POSITIVE_INT,
  );
  const offlineClampTick = expectExactNumber(
    obj["offlineClampTick"],
    OFFLINE_CLAMP_TICK,
    "$.offlineClampTick",
    issues,
  );
  const safetyFactor = expectExactNumber(
    obj["safetyFactor"],
    SAFETY_FACTOR,
    "$.safetyFactor",
    issues,
  );
  const recallRiskParams = validateRecallRiskParams(
    obj["recallRiskParams"],
    "$.recallRiskParams",
    issues,
  );
  const rawStorage = obj["storage"];
  const storage =
    rawStorage === undefined
      ? null
      : (validateStorage(rawStorage, "$.storage", issues) ?? undefined);
  const rawEras = obj["eras"];
  const eras =
    rawEras === undefined ? null : (validateEras(rawEras, "$.eras", issues) ?? undefined);
  const rawRecordMedia = obj["recordMedia"];
  const recordMedia =
    rawRecordMedia === undefined
      ? null
      : (validateRecordMedia(rawRecordMedia, "$.recordMedia", issues) ?? undefined);
  const rawTownParams = obj["townParams"];
  const townParams =
    rawTownParams === undefined
      ? null
      : (validateTownParams(rawTownParams, "$.townParams", issues) ?? undefined);
  const rawExploration = obj["exploration"];
  const exploration =
    rawExploration === undefined
      ? null
      : (validateExploration(rawExploration, "$.exploration", issues) ?? undefined);

  if (
    fpScale === undefined ||
    algoVersion === undefined ||
    coarseTickMinutes === undefined ||
    offlineClampTick === undefined ||
    safetyFactor === undefined ||
    recallRiskParams === undefined ||
    storage === undefined ||
    eras === undefined ||
    recordMedia === undefined ||
    townParams === undefined ||
    exploration === undefined
  ) {
    return fail(issues.list());
  }

  return ok({
    fpScale,
    algoVersion,
    coarseTickMinutes,
    offlineClampTick,
    safetyFactor,
    recallRiskParams,
    storage,
    eras,
    recordMedia,
    townParams,
    exploration,
  });
}
