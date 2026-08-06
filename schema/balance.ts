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

import {
  IssueCollector,
  expectArray,
  expectBoolean,
  expectExactNumber,
  expectInteger,
  expectNumber,
  expectRecord,
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
  //
  // **[M64] `rewardOverflow` は撤廃した**(2026-08-04裁定・台帳v17 必-1 案1)。
  // 探索報酬の受入上限は `storage`(基礎容量 + 保管施設の加算式・GDD 6.7
  // [2026-08-02裁定])1 系統に統一された。旧キーが残っている content は
  // **未知キーとして黙って無視される**(reject しない = 後方互換)。
}

/**
 * [M24] 拠点網全体のパラメータ(GDD 9.2)。**ブロックごと省略可**(欠落は null)。
 * 省略時は engine 側で拠点の維持費(距離帯係数)が求まらない
 * (rules/outpost.ts の維持費計算が RulesError で止まる = 拠点システム不活性)。
 */
export interface OutpostBalanceContent {
  /** 距離帯別(裁定 B7 の `near`/`far`/`deep` が 3 つとも必須)。維持費の係数。 */
  readonly distanceBandUpkeepMul: { readonly [band: string]: number };
}

/**
 * [M52] 瓦礫の開墾パラメータ(GDD 9.1)。**ブロックごと省略可**(欠落は null)。
 * 省略時は engine 側で開墾コストが求まらず、`commands.ts` の `reclaimCell` が
 * `contentUnsupported` で拒否する(= 開墾システム不活性)。
 *
 * `initialRubbleCells` は**新規ゲームの生成パラメータ**であって現在の盤面では
 * ない(盤面の権威は state・src/engine/rules/reclaim.ts §1)。
 */
export interface ReclaimBalanceContent {
  /** 解放数 0(最初の 1 枚)の開墾コスト。 */
  readonly baseCost: number;
  /** 逓増の底(GDD 9.1 の 1.15)。 */
  readonly costGrowth: number;
  /** GDD 9.1 の「最終セルでも到達可能な明示上限 cap」。 */
  readonly costCap: number;
  /** コストを引き落とす resource 定義 ID。 */
  readonly costResourceId: string;
  /** 新規ゲームの初期瓦礫セル(セル番号の昇順・重複なし・0〜47)。 */
  readonly initialRubbleCells: readonly number[];
}

/**
 * [M28] 大移動 / 継承点のパラメータ(GDD 10.2〜10.5)。**ブロックごと省略可**
 * (欠落は null)。省略時は engine 側で `commands.ts` の `executeExodus` /
 * `purchaseInheritBonus` が `contentUnsupported` で拒否する(= 周回システム不活性)。
 *
 * `expectedTabletsByEra` は GDD 10.2 が明記する**静的テーブル値**であり、
 * content の tech 本数から数えてはならない(週次葉テック追加で容量が動くと
 * セーブ互換の前提が崩れる)。`inheritTierCosts` は GDD 10.3 の
 * `cost(n) = 50 × 1.5^n` をオーサリング時に展開した列(50/75/113/169)で、
 * **配列の長さがそのまま上限段数**= 青天井にならないことの構造的根拠になる。
 */
export interface ExodusBalanceContent {
  /** GDD 10.2 のキャラバン容量比 0.35。 */
  readonly caravanRatio: number;
  /** GDD 10.2 の乗員定員比 0.5。 */
  readonly crewRatio: number;
  /** eraId → 想定石版総数(静的テーブル・GDD 10.2)。 */
  readonly expectedTabletsByEra: { readonly [eraId: string]: number };
  /** GDD 10.3 獲得式の `到達エラ × 10`。 */
  readonly eraPoints: number;
  /** GDD 10.3 獲得式の `成文化率(%) × 0.5`。 */
  readonly codifyRatePoints: number;
  /** GDD 10.3 獲得式の `生存住民数 × 2`。 */
  readonly survivorPoints: number;
  /** GDD 10.3 の段階コスト(展開済み・昇順・長さ = 上限段数)。 */
  readonly inheritTierCosts: readonly number[];
  /** 継承系統 → 1 段あたりのボーナス量。3 系統とも必須。 */
  readonly inheritBonusPerTier: { readonly [track: string]: number };
  /** `startingStock` 系統のボーナスが積まれる resource 定義 ID。 */
  readonly startingStockResourceId: string;
}

/**
 * [M67] 研究ペーシング(GDD 5.2 の第2ゲート = 実地要件)のパラメータ。
 * 2026-08-06裁定・台帳v20 必-1 の最小形。
 */
export interface ResearchPacingContent {
  /**
   * `tech.fieldRequirement.count` 1 回ぶんを「該当施設での稼働 tick 数」へ
   * 換算する係数。実地要件 = `count × recipeRunTicks` tick の稼働。
   * recipe entity は MVP 対象外なので、レシピ 1 回の実施を**稼働時間**で
   * 代理表現する(recipe ID は識別子のまま据え置き)。
   */
  readonly recipeRunTicks: number;
}

export interface BalanceContent {
  readonly fpScale: number;
  readonly algoVersion: number;
  readonly coarseTickMinutes: number;
  readonly offlineClampTick: number;
  readonly safetyFactor: number;
  readonly recallRiskParams: RecallRiskParams;
  /**
   * [M67] GDD 5.2 の研究ペーシング。JSON に無ければ null
   * (= 実地要件がゲートとして働かない = M67 以前と同じ挙動)。
   */
  readonly research: ResearchPacingContent | null;
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
  /** [M24] GDD 9.2 の拠点網パラメータ。JSON に無ければ null(拠点の維持費が求まらない)。 */
  readonly outpost: OutpostBalanceContent | null;
  /** [M52] GDD 9.1 の開墾パラメータ。JSON に無ければ null(開墾不可)。 */
  readonly reclaim: ReclaimBalanceContent | null;
  /** [M28] GDD 10.2〜10.5 の大移動 / 継承点。JSON に無ければ null(周回不可)。 */
  readonly exodus: ExodusBalanceContent | null;
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
  };
}

// --- [M24] outpost(GDD 9.2)---------------------------------------------------

/** 維持費の距離帯係数の保守境界(GDD 9.2「距離帯係数」。近郊を基準に遠隔ほど高い想定)。 */
const DISTANCE_BAND_UPKEEP_MUL_RANGE: NumericRange = { min: 0, max: 10 };

function validateOutpostBalance(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): OutpostBalanceContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const rawBands = expectRecord(
    obj["distanceBandUpkeepMul"],
    `${path}.distanceBandUpkeepMul`,
    issues,
  );
  if (rawBands === undefined) return undefined;

  const distanceBandUpkeepMul: { [band: string]: number } = {};
  let ok_ = true;
  for (const band of EXPLORATION_BANDS) {
    const value = expectNumber(
      rawBands[band],
      `${path}.distanceBandUpkeepMul.${band}`,
      issues,
      DISTANCE_BAND_UPKEEP_MUL_RANGE,
    );
    if (value === undefined) {
      ok_ = false;
      continue;
    }
    distanceBandUpkeepMul[band] = value;
  }
  if (!ok_) return undefined;
  return { distanceBandUpkeepMul };
}

// --- [M52] reclaim(GDD 9.1)---------------------------------------------------

/** 開墾コストの保守境界(資源量。lvCurve と同じ上限に揃える)。 */
const RECLAIM_COST_RANGE: NumericRange = { min: 0, max: 1_000_000_000 };

/**
 * 逓増の底の許容レンジ。**下限 1.0** は engine 側の cap 打ち切りが依拠する単調性
 * (src/engine/rules/reclaim.ts §2)の前提であり、片方だけ緩めないこと。
 * 上限 2.0 は GDD 9.1 が「旧 1.6 は指数爆発ゆえ廃し 1.15 へ緩和」と定めた趣旨から、
 * 旧値 1.6 を含みつつ明らかな爆発域を弾く保守境界とする。
 */
const RECLAIM_GROWTH_RANGE: NumericRange = { min: 1, max: 2 };

/**
 * 初期瓦礫セル番号の許容レンジ。**6×8 格子の通し番号 0〜47**
 * (engine 側の権威は `src/engine/adjacency.ts` の GRID_CELL_COUNT。schema は
 * engine を import できるが、ここは他の数値レンジと同じ書き方に揃えて定数で持ち、
 * 突き合わせは `schema/engineContent.ts` の変換で行う ——
 * `FOOTPRINT_DIMENSION_RANGE` と engine の `FOOTPRINT_DIM_MAX` の関係と同型)。
 */
const RUBBLE_CELL_INDEX_RANGE: NumericRange = { min: 0, max: 47 };

function validateInitialRubbleCells(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const array = expectArray(raw, path, issues);
  if (array === undefined) return undefined;

  const cells: number[] = [];
  let previous = -1;
  let ok_ = true;
  for (let i = 0; i < array.length; i++) {
    const cell = expectInteger(array[i], `${path}[${String(i)}]`, issues, RUBBLE_CELL_INDEX_RANGE);
    if (cell === undefined) {
      ok_ = false;
      continue;
    }
    if (cell <= previous) {
      // 昇順・重複なしを schema で強制する。engine 側(state.ts 不変条件 (i))と
      // 同じ正準形にしておかないと、content から作った初期盤面だけが
      // `createGameState` の検査で落ちる = 起動できない content ができてしまう。
      issues.add(
        `${path}[${String(i)}]`,
        `初期瓦礫セルはセル番号の昇順・重複なしが必須(${String(previous)} → ${String(cell)})`,
      );
      ok_ = false;
      continue;
    }
    previous = cell;
    cells.push(cell);
  }
  if (!ok_) return undefined;
  return cells;
}

/**
 * [M67] `research`(省略可)の検証。`recipeRunTicks` は 1 以上の整数
 * (0 を許すと「実地要件は書いてあるが常に充足済み」が静かに成立する)。
 */
function validateResearchPacing(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): ResearchPacingContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const recipeRunTicks = expectInteger(
    obj["recipeRunTicks"],
    `${path}.recipeRunTicks`,
    issues,
    RECIPE_RUN_TICKS_RANGE,
  );
  if (recipeRunTicks === undefined) return undefined;
  return { recipeRunTicks };
}

/** [M67] レシピ 1 回の稼働 tick 換算の値域(1 tick 〜 1 ゲーム年ぶん)。 */
const RECIPE_RUN_TICKS_RANGE: NumericRange = { min: 1, max: 525_600 };

function validateReclaim(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): ReclaimBalanceContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const baseCost = expectNumber(obj["baseCost"], `${path}.baseCost`, issues, RECLAIM_COST_RANGE);
  const costGrowth = expectNumber(
    obj["costGrowth"],
    `${path}.costGrowth`,
    issues,
    RECLAIM_GROWTH_RANGE,
  );
  const costCap = expectNumber(obj["costCap"], `${path}.costCap`, issues, RECLAIM_COST_RANGE);
  const costResourceId = validateId(obj["costResourceId"], `${path}.costResourceId`, issues);
  const initialRubbleCells = validateInitialRubbleCells(
    obj["initialRubbleCells"] ?? [],
    `${path}.initialRubbleCells`,
    issues,
  );

  if (
    baseCost === undefined ||
    costGrowth === undefined ||
    costCap === undefined ||
    costResourceId === undefined ||
    initialRubbleCells === undefined
  ) {
    return undefined;
  }
  if (costCap < baseCost) {
    // cap が base を下回ると最初の 1 枚から cap 張り付き = 逓増が観測できない。
    // GDD 9.1 の「最終セルでも到達可能な明示上限」の意図に反するので止める。
    issues.add(
      `${path}.costCap`,
      `上限 ${String(costCap)} が基準コスト ${String(baseCost)} を下回る(GDD 9.1 の cap は逓増の頭打ち)`,
    );
    return undefined;
  }
  return { baseCost, costGrowth, costCap, costResourceId, initialRubbleCells };
}

// --- [M28] exodus(GDD 10.2〜10.5)---------------------------------------------

/** 想定石版総数(静的テーブル)の保守境界。盤面規模から見て 1000 本を上限とする。 */
const EXPECTED_TABLETS_RANGE: NumericRange = { min: 0, max: 1000 };

/** 継承点まわりの係数・コストの保守境界(点は整数スケール)。 */
const INHERIT_POINT_RANGE: NumericRange = { min: 0, max: 1_000_000 };

/** 1 段あたりのボーナス量の保守境界(枠・人数・在庫のいずれも小さい整数)。 */
const INHERIT_BONUS_RANGE: NumericRange = { min: 0, max: 10_000 };

/**
 * GDD 10.3「各ボーナス上限 **4段**」に対する保守境界。1 段未満(= 買えない)と
 * 極端な段数(= 実質青天井)を弾く。**この上限が effective に働くのは engine 側の
 * `inheritTierMax`(段階コスト列の長さ)なので、ここは「列の長さの妥当域」だけを見る。
 */
const INHERIT_TIER_COUNT_RANGE: NumericRange = { min: 1, max: 20 };

/** 継承系統の正本(engine の `INHERIT_TRACKS` と一致していること)。 */
const INHERIT_TRACK_IDS: readonly string[] = ["caravanCapacity", "crewCapacity", "startingStock"];

function validateExpectedTabletsByEra(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): { readonly [eraId: string]: number } | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const result: Record<string, number> = {};
  const issuesBefore = issues.list().length;
  for (const key of Object.keys(obj)) {
    const eraId = validateId(key, `${path}.${key}`, issues);
    const value = expectInteger(obj[key], `${path}.${key}`, issues, EXPECTED_TABLETS_RANGE);
    if (eraId === undefined || value === undefined) continue;
    result[eraId] = value;
  }
  return issues.list().length === issuesBefore ? result : undefined;
}

function validateInheritTierCosts(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const array = expectArray(raw, path, issues);
  if (array === undefined) return undefined;
  if (array.length < INHERIT_TIER_COUNT_RANGE.min || array.length > INHERIT_TIER_COUNT_RANGE.max) {
    issues.add(
      path,
      `段階コスト列の長さ ${String(array.length)} が ${String(INHERIT_TIER_COUNT_RANGE.min)}〜` +
        `${String(INHERIT_TIER_COUNT_RANGE.max)} の外(長さ = 上限段数・GDD 10.3 は 4 段)`,
    );
    return undefined;
  }
  const costs: number[] = [];
  let previous = -1;
  let valid = true;
  for (let i = 0; i < array.length; i++) {
    const cost = expectInteger(array[i], `${path}[${String(i)}]`, issues, INHERIT_POINT_RANGE);
    if (cost === undefined) {
      valid = false;
      continue;
    }
    if (cost < previous) {
      // `cost(n) = 50 × 1.5^n` は単調増加。逓減する列は「後の段ほど安い」= 上限
      // クランプの意味(GDD 11.4-6 の青天井禁止)が崩れるので弾く。
      issues.add(
        `${path}[${String(i)}]`,
        `段階コストが逓減している(${String(previous)} → ${String(cost)})。` +
          "GDD 10.3 の cost(n) = 50 × 1.5^n は単調増加",
      );
      valid = false;
      continue;
    }
    previous = cost;
    costs.push(cost);
  }
  return valid ? costs : undefined;
}

function validateInheritBonusPerTier(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): { readonly [track: string]: number } | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const result: Record<string, number> = {};
  let valid = true;
  for (const track of INHERIT_TRACK_IDS) {
    const value = expectInteger(obj[track], `${path}.${track}`, issues, INHERIT_BONUS_RANGE);
    if (value === undefined) {
      valid = false;
      continue;
    }
    result[track] = value;
  }
  for (const key of Object.keys(obj)) {
    if (INHERIT_TRACK_IDS.includes(key)) continue;
    // 未知の系統を黙って捨てると「JSON には書いたのに効かない」になる。
    issues.add(`${path}.${key}`, `継承系統 "${key}" は engine のレジストリ(3 系統)に無い`);
    valid = false;
  }
  return valid ? result : undefined;
}

function validateExodus(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): ExodusBalanceContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const caravanRatio = expectNumber(
    obj["caravanRatio"],
    `${path}.caravanRatio`,
    issues,
    UNIT_RANGE,
  );
  const crewRatio = expectNumber(obj["crewRatio"], `${path}.crewRatio`, issues, UNIT_RANGE);
  const expectedTabletsByEra = validateExpectedTabletsByEra(
    obj["expectedTabletsByEra"] ?? {},
    `${path}.expectedTabletsByEra`,
    issues,
  );
  const eraPoints = expectNumber(
    obj["eraPoints"],
    `${path}.eraPoints`,
    issues,
    INHERIT_POINT_RANGE,
  );
  const codifyRatePoints = expectNumber(
    obj["codifyRatePoints"],
    `${path}.codifyRatePoints`,
    issues,
    INHERIT_POINT_RANGE,
  );
  const survivorPoints = expectNumber(
    obj["survivorPoints"],
    `${path}.survivorPoints`,
    issues,
    INHERIT_POINT_RANGE,
  );
  const inheritTierCosts = validateInheritTierCosts(
    obj["inheritTierCosts"],
    `${path}.inheritTierCosts`,
    issues,
  );
  const inheritBonusPerTier = validateInheritBonusPerTier(
    obj["inheritBonusPerTier"],
    `${path}.inheritBonusPerTier`,
    issues,
  );
  const startingStockResourceId = validateId(
    obj["startingStockResourceId"],
    `${path}.startingStockResourceId`,
    issues,
  );

  if (
    caravanRatio === undefined ||
    crewRatio === undefined ||
    expectedTabletsByEra === undefined ||
    eraPoints === undefined ||
    codifyRatePoints === undefined ||
    survivorPoints === undefined ||
    inheritTierCosts === undefined ||
    inheritBonusPerTier === undefined ||
    startingStockResourceId === undefined
  ) {
    return undefined;
  }
  return {
    caravanRatio,
    crewRatio,
    expectedTabletsByEra,
    eraPoints,
    codifyRatePoints,
    survivorPoints,
    inheritTierCosts,
    inheritBonusPerTier,
    startingStockResourceId,
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
  const rawResearch = obj["research"];
  const research =
    rawResearch === undefined
      ? null
      : (validateResearchPacing(rawResearch, "$.research", issues) ?? undefined);
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
  const rawOutpost = obj["outpost"];
  const outpost =
    rawOutpost === undefined
      ? null
      : (validateOutpostBalance(rawOutpost, "$.outpost", issues) ?? undefined);
  const rawReclaim = obj["reclaim"];
  const reclaim =
    rawReclaim === undefined
      ? null
      : (validateReclaim(rawReclaim, "$.reclaim", issues) ?? undefined);
  const rawExodus = obj["exodus"];
  const exodus =
    rawExodus === undefined ? null : (validateExodus(rawExodus, "$.exodus", issues) ?? undefined);

  if (
    fpScale === undefined ||
    algoVersion === undefined ||
    coarseTickMinutes === undefined ||
    offlineClampTick === undefined ||
    safetyFactor === undefined ||
    recallRiskParams === undefined ||
    research === undefined ||
    storage === undefined ||
    eras === undefined ||
    recordMedia === undefined ||
    townParams === undefined ||
    exploration === undefined ||
    outpost === undefined ||
    reclaim === undefined ||
    exodus === undefined
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
    research,
    storage,
    eras,
    recordMedia,
    townParams,
    exploration,
    outpost,
    reclaim,
    exodus,
  });
}
