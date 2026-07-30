// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- rules 共通型: content の内部表現と advance のコンテキスト
//
// ===========================================================================
// 1. ここにある型は「正準化済みの content 内部表現」である
// ===========================================================================
//   ADR-023(1) は「content バンドルは canonicalize.ts を通してから内部表現化する」
//   ことを強制し、ADR-023(2) は engine が content 由来オブジェクトを
//   `Object.keys` / `for-in` で直接走査することを禁じている。したがって engine の
//   rules は**生の JSON を一切見ない**。JSON → ここの型への変換(値の 1e6 化、
//   ID の検証、effect/target 語彙の写像)は content ロード側の責務であり、
//   写せない値は黙って捨てずロード時に reject すること。
//
//   数値はすべて {@link Fix}(1e6 固定小数点)で入っている前提。人間可読値の
//   まま持ち込むと乗算のスケール補正が二重/欠落になるため、境界は
//   fp.ts の fixFromRaw / fixFromInt に限る。
//
// ===========================================================================
// 2. 縮約スコープ(先行計測計画 §2.1 P1「rules 縮約 3 本」)
// ===========================================================================
//   実装するのは (A)生産 / (B)研究完了 / (C)想起困難 の 3 本だけであり、
//   襲撃・探索解決・衛星供給・幕塵・成文化は**作らない**(計測 12 項目のどれにも
//   要らない)。よって content 内部表現もその 3 本が読む値に限る:
//     facility 定義 : タグ(隣接)/ 過酷業務か(loadW)/ Lv 別産出 / 産出先
//     tech 定義     : 研究コスト
//     adjacency     : タグ×タグ行列 + 過密 + シード揺らぎ
//     recallRisk    : GDD 11.2 の全パラメータ
//     coarseTickMinutes : 粗粒度ステップ幅(balance)
//   trait 倍率(生産側)・保管庫オーバーフロー・開墾・era 昇格は縮約の対象外。
//   足すときは「3 本の rule が実際に読むか」を基準にすること。
// ---------------------------------------------------------------------------

import type { AdjacencyMatrix, Tag } from "../adjacency";
import type { Fix } from "../fp";
import type { EntityId, FacilityFootprint } from "../state/state";
import type { StatWeights, TraitDef } from "./stats";

/** rules の入力の誤り(content 定義の欠落・Lv 範囲外・産出先不在など)。 */
export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesError";
  }
}

// --- 1. facility 定義 ------------------------------------------------------

/** 施設の産出先。研究点は resource entity ではなく research entity へ入る。 */
export type FacilityOutput =
  { readonly kind: "resource"; readonly resourceId: EntityId } | { readonly kind: "research" };

/**
 * 施設定義(content)。state 側の {@link FacilityState} は「どの定義の実体が
 * どのセルに Lv いくつで建っていて誰が就いているか」だけを持つ(正規化)。
 */
export interface FacilityDef {
  readonly id: EntityId;
  /** GDD 6.2 の隣接解決に使うタグ(タグ7種の部分集合)。 */
  readonly tags: readonly Tag[];
  /**
   * 過酷業務(製錬/鍛冶/高炉等)か。GDD 11.2 の loadW を
   * ×2.0(過酷)/ ×0.5(通常)のどちらにするかを決める。
   */
  readonly harshWork: boolean;
  /**
   * Lv 別の 1 tick あたり基礎産出(index 0 = Lv1)。
   * `base × 1.15^(Lv-1)` は**オーサリング時に個別 FP 値へ展開済み**であり、
   * 実行時のべき乗計算は行わない(GDD 11.7 / ADR-006)。
   */
  readonly outputPerTickByLevel: readonly Fix[];
  readonly output: FacilityOutput;
  /**
   * [M5] GDD 11.1「Σ担当者**関連**ステータス寄与」の「関連」の実体
   * (rules/stats.ts §2)。**省略時は {@link UNIFORM_STAT_WEIGHTS}(5 種等分)**
   * であり、その既定では中立ステータスの就労者 1 人の寄与が厳密に 1.0 になる
   * = T5 縮約形と 1 bit も違わない。
   */
  readonly statWeights?: StatWeights;
  /**
   * [M5] 保管庫としての容量寄与(GDD 6.7 / 12.1「施設側は上限値管理のみに
   * 役割限定」)。**省略時はこの施設が容量を提供しない**。
   */
  readonly storage?: FacilityStorageDef;
  /**
   * [M11] Lv 別の寝床上限(index 0 = Lv1・**整数の人数**)。GDD 7.7
   * 「寝床上限内の決定論的定期加入」と GDD 7.6 の人口下限 `min(寝床×0.5, 6)` の
   * 「寝床」がこれである。
   *
   * **省略時はこの施設が寝床を提供しない**。現 content には寝床施設が無いので
   * 盤面の寝床上限は 0 になり、その状態では人口下限が 0・晴天漂着も起きない
   * = M11 以前と 1 bit も違わない(rules/population.ts §1)。
   */
  readonly bedCapacityByLevel?: readonly number[];
  /**
   * [M49] Lv 別の就労スロット数(index 0 = Lv1・**整数の人数**)。
   * GDD 7.7「割り振りは施設ごと就労スロット(Lvで増加)」の上限であり、
   * `content/facility.json` の `slots.lv1〜lv5` がそのまま写る。
   *
   * **省略時は上限なし**(就労者を何人でも割り当てられる)。省略を許すのは
   * engine のテストフィクスチャのような縮約 facility 定義でも rules が動く
   * ようにするためで、実 content は必ず値を持つ(schema で必須)。
   *
   * 読むのは `commands.ts`(住民割当の上限検査)**だけ**である。生産式は
   * 「実際に workerIds に載っている人数」で計算するので、この値を後から
   * 増減しても既存 state の産出は変わらない = golden vector に影響しない。
   */
  readonly workerSlotsByLevel?: readonly number[];
  /**
   * [M16] 占有形状(GDD 6.1「大型は 2×1 / 2×2 占有」)。
   * `content/facility.json` の `footprint` がそのまま写る。
   *
   * **省略時は 1×1**。省略を許すのは engine のテストフィクスチャのような縮約
   * facility 定義でも rules が動くようにするためで、実 content は必ず値を持つ
   * (`schema/facility.ts` で必須)。
   *
   * 読むのは `commands.ts` の配置コマンド**だけ**であり、そこで
   * `FacilityState.footprint` へ焼き込む(content 変更が既存盤面の占有形状を
   * 遡って変えないため・footprint.ts §1)。既存 state の占有形状は
   * この値を後から変えても動かない = golden vector に影響しない。
   */
  readonly footprint?: FacilityFootprint;
}

/**
 * [M5] 施設が提供する保管容量(GDD 6.7)。
 *
 * 資源ごとの上限は「balance の基礎容量 + 建っている保管施設の寄与」の総和であり、
 * **どちらも無い資源は上限なし**(= オーバーフローが起きない)として扱う。
 * この「無指定 = 無限」の既定が、上限を一切設定していない既存 conformance
 * シナリオで新機構が完全に不活性になる根拠である。
 */
export interface FacilityStorageDef {
  /** Lv 別の容量(index 0 = Lv1)。`outputPerTickByLevel` と同じ個別 FP 展開。 */
  readonly capacityByLevel: readonly Fix[];
  /**
   * 容量を提供する対象の resource 定義 ID(ID 昇順)。
   * null は「全資源」(汎用倉庫)。
   */
  readonly resourceIds: readonly EntityId[] | null;
}

// --- 2. tech 定義 ----------------------------------------------------------

/**
 * [M6] 技術喪失の二層(GDD 7.4)。
 *   (A) criticalRecoverable : クリティカルパス技術。失っても必ず再取得可能。
 *   (B) rareIrreversible    : 一回性喪失を許容する希少側。
 * 「取り返しのつかない喪失」は (B) のみに使う(GDD 7.4)。
 */
export const TECH_LOSS_CLASSES = ["criticalRecoverable", "rareIrreversible"] as const;

/** {@link TECH_LOSS_CLASSES} のいずれか。 */
export type TechLossClass = (typeof TECH_LOSS_CLASSES)[number];

/**
 * 省略時の lossClass。**安全側((A) = 再取得可能)** に倒す。
 * (B) は「永久に失ってよい」という強い宣言なので、既定で選ばれてはならない。
 */
export const DEFAULT_TECH_LOSS_CLASS: TechLossClass = "criticalRecoverable";

/**
 * 技術定義(content)。
 *
 * T5 縮約は研究コストだけを読んでいた。M6 で `eraId` / `lossClass` / `prereqs` を
 * 足したが、いずれも**省略可**である(既定値は下の各フィールドの doc 参照)。
 * 省略可にしてあるのは M5 の `statWeights` / `storage` と同じ理由 —
 * 「未設定なら M6 以前と 1 bit も違わない」を型で保証するため。
 */
export interface TechDef {
  readonly id: EntityId;
  readonly researchCostFix: Fix;
  /**
   * [M6] 所属エラの ID(GDD 5.2 の E1〜E3 = `e1`/`e2`/`e3`)。
   * **省略時はエラ不明**として扱い、成文化の時代係数は 1.0、
   * researchCost レンジ検証(GDD 12.3)は対象外になる。
   */
  readonly eraId?: string;
  /** [M6] GDD 7.4 の二層。**省略時は {@link DEFAULT_TECH_LOSS_CLASS}**。 */
  readonly lossClass?: TechLossClass;
  /**
   * [M6] 前提テック(ID 昇順)。**省略時は空**(エラ起点)。
   * 実在確認と循環検出は content ロード側(`schema/contentBundle.ts`)の責務で、
   * ここへ来る時点では解決済みの ID が並んでいる。
   */
  readonly prereqs?: readonly EntityId[];
  /**
   * [M13] 実地要件の施設(content の `tech.fieldRequirement.facility`)。
   * GDD 5「テックは前提＋researchCost＋**実地要件(該当施設で該当レシピを N 回
   * 稼働)**で解禁」の「該当施設」であり、GDD 4「技術は **解禁 → 実地稼働で記憶
   * 定着 → 成文化で盤石**」の「実地稼働」の場所でもある。M13 はこれを 2 つの
   * 用途に使う(`rules/techMemory.ts`):
   *   (1) `masteryResist(u,t)` の蓄積 — この施設で稼働している間だけ定着する
   *   (2) 「当該住民の**当該 tech 関連**生産のみ停止」(GDD 11.2)の
   *       「関連生産」の解決 — 想起困難中はこの施設での寄与だけが 0 になる
   *
   * **省略可**。省略時は
   *   (1) 定着が一切蓄積しない
   *   (2) 停止範囲が決まらないので**住民単位の全停止**(= T5 縮約と同じ挙動)へ
   *       フォールバックする
   * となる。省略を許すのは engine のテストフィクスチャのような縮約 tech 定義でも
   * rules が動くようにするためで、実 content は必ず値を持つ(schema で必須)。
   *
   * `fieldRequirement.recipe` / `count`(N 回稼働)は engine 未実装であり
   * content ローダーが写さない(レシピ系が入る段の担当)。
   */
  readonly fieldFacilityId?: EntityId;
}

/**
 * [M6] エラ定義(GDD 5.1 のコスト表 / GDD 12.1 の `era` エンティティ)。
 *
 * era は独立した content カテゴリになっていない(T6 のロード対象外)ため、
 * 暫定的に `balance.json` の `eras` ブロックから読む。era カテゴリを足す段で
 * そちらへ移すこと。
 */
export interface EraDef {
  readonly id: string;
  /** 時代順(1 始まり)。エラ間の前後関係の唯一の根拠。 */
  readonly order: number;
  /**
   * GDD 5.1 の `base_era`(E1=30 / E2=60 / E3=120)。**researchCost の
   * レンジ検証(GDD 12.3)にだけ使う**。実行時のコストは tech 個別値が正。
   */
  readonly baseEraFix: Fix;
  /**
   * GDD 5.1 の `era_multiplier`(E1=1 / E2=2 / E3=4)。
   * 成文化コスト/時間の「時代係数」(GDD 11.1)としても使う。
   */
  readonly multiplierFix: Fix;
  /** そのエラの壁テック(GDD 12.1 `era.gateTechId`)。クリティカルパスの終点。 */
  readonly gateTechId: EntityId;
  /**
   * GDD 5.1「n の上限＝各エラのクリティカルパス本数で固定」の上限値。
   * 実際のクリティカルパス本数は prereq グラフから機械算出し、この値を
   * 超えていないかを `rules/techTree.ts` が検査する。
   */
  readonly criticalPathMax: number;
}

// --- 3. recallRisk パラメータ(GDD 11.2) ----------------------------------

/**
 * 想起困難の発生式のパラメータ。GDD 11.2 の表そのもの:
 *
 *   p = clamp(0, base_p × loadW(施設負荷) + moraleW + dispatchW
 *                 − masteryResist(u,t), p_max)
 *
 * すべて `balance.json`(人間専用・CODEOWNERS)由来で、min/max レンジ制約は
 * schema 検証器の担当。
 */
export interface RecallRiskParams {
  /** base_p(GDD: 0.05)。 */
  readonly basePFix: Fix;
  /** p_max(GDD: 0.35)。 */
  readonly pMaxFix: Fix;
  /** 過酷業務就労時の loadW(GDD: 2.0)。 */
  readonly loadWHarshFix: Fix;
  /** 通常業務就労時の loadW(GDD: 0.5)。 */
  readonly loadWNormalFix: Fix;
  /** 士気の中位閾値(GDD: 30)。これ未満で moraleBonusMid。 */
  readonly moraleThresholdMidFix: Fix;
  /** 士気 < 中位閾値 の加算(GDD: +0.10)。 */
  readonly moraleBonusMidFix: Fix;
  /** 士気の下位閾値(GDD: 15)。これ未満で moraleBonusLow(より強い方を採用)。 */
  readonly moraleThresholdLowFix: Fix;
  /** 士気 < 下位閾値 の加算(GDD: +0.20)。 */
  readonly moraleBonusLowFix: Fix;
  /** 探索派遣中の加算 dispatchW(GDD: +0.15)。 */
  readonly dispatchWFix: Fix;
  /** 定着度 masteryResist の上限(GDD: 0.20)。state の mastery をここで打ち止める。 */
  readonly masteryResistMaxFix: Fix;
  /**
   * 記憶巧者 trait の耐性(GDD: -0.15)。**負値**で持ち、masteryResist へ加算する
   * (符号を content 側と揃える。`balance.json` の memoryKeeperResist と同じ)。
   */
  readonly memoryKeeperResistFix: Fix;
  /** 記憶巧者 trait の content ID。該当 trait が無い content では null。 */
  readonly memoryKeeperTraitId: EntityId | null;
  /** 発生時の持続 tick の下限(GDD: 1 日 = 1440)。 */
  readonly durationMinTicks: number;
  /** 発生時の持続 tick の上限(GDD: 2 日 = 2880)。 */
  readonly durationMaxTicks: number;
  /**
   * [M13] 実地稼働 1 ゲーム日(1440 tick)あたりの `masteryResist` 蓄積量
   * (GDD 11.2「masteryResist: **実地稼働で蓄積する**定着度(0〜0.20)」の速度)。
   *
   * **GDD に速度の明示が無い**ため暫定値であり、バランス調整段(M39〜M41)で
   * 再評価する(裁定 N12 の「mastery 上限 0.20 の相殺は MVP 現状維持」と対で
   * 見直す量である)。
   *
   * **省略可**: 省略時は蓄積が一切起きない(= M13 以前と 1 bit も違わない)。
   * 上限は {@link masteryResistMaxFix} で、蓄積側でも同じ値でクランプする。
   */
  readonly masteryGainPerFieldWorkDayFix?: Fix;
}

// --- 3b. 保管庫パラメータ(GDD 6.7)— M5 -----------------------------------

/**
 * 保管庫オーバーフロー・廃材スポンジ・廃材 3 出口のパラメータ(GDD 6.7)。
 * すべて `balance.json` の `storage` ブロック由来(人間専用・CODEOWNERS)。
 *
 * **このブロックが content に無ければ {@link EngineContent.storage} は undefined**
 * であり、上限判定も廃材生成も一切走らない(既存挙動と完全に同一)。
 */
export interface StorageParams {
  /**
   * 廃材(GDD 6.7)の resource 定義 ID。null なら廃材変換を行わない
   * (超過分は全て破棄)。
   */
  readonly wasteResourceId: EntityId | null;
  /**
   * resource 定義 ID → 基礎容量。ここにも保管施設にも現れない資源は**上限なし**。
   */
  readonly baseCapacityByResourceId: ReadonlyMap<EntityId, Fix>;
  /**
   * resource 定義 ID → 超過分の廃材変換率(0〜1)。GDD 6.7「低次資源(薪・石等)は
   * 超過分を一定比率で廃材へ自動変換(スポンジ機構)」。
   * 未登録の資源は変換率 0 = 単純破棄(GDD 6.7「原則超過分破棄」)。
   */
  readonly wasteConversionRatioByResourceId: ReadonlyMap<EntityId, Fix>;
  /**
   * 廃材 → 研究点の変換率(GDD 6.7 の 3 出口(3)「廃材 N → RP 1」の 1/N)。
   */
  readonly wasteToResearchRatioFix: Fix;
  /** 施設増築コストを廃材で代替できる上限比率(GDD 6.7「最大20%」)。 */
  readonly buildCostWasteSubstitutionMaxFix: Fix;
  /** 成文化の粘土を廃材で代替できる上限比率(GDD 6.7「低比率」)。 */
  readonly codifyWasteSubstitutionMaxFix: Fix;
}

// --- 3c. 記録媒体パラメータ(GDD 11.1 [2026-07-27追補])— M6 -----------------

/**
 * [M6] 記録媒体(GDD 11.1 追補)。**engine 既知の 2 種固定(enum)**であり、
 * content カテゴリではない。並びは UTF-16 昇順 = 集合演算の安定順序(GDD 11.7)。
 *
 *   paper       : 安い/速い/軽い(キャラバン 0.25)/**可燃**
 *   stoneTablet : 高い/遅い/重い(キャラバン 1.0)/不燃
 */
export const RECORD_MEDIA = ["paper", "stoneTablet"] as const;

/** {@link RECORD_MEDIA} のいずれか。 */
export type RecordMedium = (typeof RECORD_MEDIA)[number];

/** 未知の文字列が記録媒体のいずれかか(型ガード)。 */
export function isRecordMedium(value: string): value is RecordMedium {
  for (const medium of RECORD_MEDIA) {
    if (medium === value) return true;
  }
  return false;
}

/** 媒体 1 種ぶんのパラメータ(GDD 11.1 追補の表)。 */
export interface RecordMediumParams {
  /** 記録 1 枚のコスト倍率(石板 = 基準 ×1.0)。 */
  readonly costMulFix: Fix;
  /** 学者作業時間の倍率(石板 = 基準 ×1.0)。 */
  readonly timeMulFix: Fix;
  /** 大移動キャラバンの石版換算枠の消費量(石板 1.0 / 紙 0.25・GDD 10.2 追補)。 */
  readonly caravanWeightFix: Fix;
  /** 可燃か(紙 = true)。焼失は M22 の `destroyRecords` が扱う。 */
  readonly flammable: boolean;
  /** コストを支払う資源の定義 ID(石板 = 粘土 / 紙 = 紙・GDD 11.1)。 */
  readonly costResourceId: EntityId;
}

/**
 * [M6] 成文化と記録媒体のパラメータ(`balance.json` の `recordMedia` ブロック)。
 *
 * **このブロックが content に無ければ {@link EngineContent.recordMedia} は
 * undefined** であり、成文化コマンドは一切実行できない(= M6 以前と同一挙動)。
 */
export interface RecordMediaParams {
  /** 記録 1 枚の基準コスト(時代係数・媒体倍率を掛ける前)。 */
  readonly baseCostFix: Fix;
  /** 記録 1 枚の基準学者作業時間(tick)。媒体倍率を掛ける前。 */
  readonly baseDurationTicks: number;
  /**
   * E3「簡易印刷」テックの content ID(GDD 5.2)。null なら印刷バフ無し。
   * **バフは紙のみに適用**(GDD 11.1 追補)。
   */
  readonly printingTechId: EntityId | null;
  /** 印刷解禁時の紙のコスト倍率(GDD 5.2「成文化コスト -50%」= 0.5)。 */
  readonly printingCostMulFix: Fix;
  /** 印刷解禁時の紙の時間倍率(GDD 5.2「速度 ×2」= 0.5)。 */
  readonly printingTimeMulFix: Fix;
  /** 媒体別パラメータ。2 種とも必須(enum 固定なので欠落は content ロードが reject)。 */
  readonly byMedium: { readonly [K in RecordMedium]: RecordMediumParams };
}

// --- 3d. townParams(GDD 7.5〜7.7 / 12.1)— M11 ------------------------------

/**
 * [M11] 住民寿命モデル・人口下限・獲得/規模のパラメータ
 * (`balance.json` の `townParams` ブロック・GDD 12.1 の `townParams(...)`)。
 *
 * **このブロックが content に無ければ {@link EngineContent.town} は undefined**
 * であり、寿命の抽選も晴天漂着も一切走らない(= M11 以前と同一挙動)。
 *
 * ===========================================================================
 * 寿命分布の表現方法(GDD 7.5「離散対数正規近似」を ADR-006 の下で実装する)
 * ===========================================================================
 * GDD 7.5 は「seed 駆動の離散対数正規近似(平均 = 432,000 tick、σ = 平均の 0.25)」
 * と定めるが、対数正規の逆 CDF は `exp` を要し **ADR-006 の Math 許可リストで
 * 禁止**(implementation-approximated = エンジン間 bit 不一致)である。
 *
 * そこで GDD 11.7 の既定路線 —「非整数べき乗は実行時計算を一切禁止し、
 * オーサリング時に固定小数点値を事前計算し JSON へ個別値として書き出す」— を
 * そのまま分布へ適用する:
 *
 *   1. オーサリング時に、対数正規の逆 CDF を **等確率 N 分位の代表値**として
 *      展開し、平均寿命に対する**倍率**の配列にして content へ書く
 *      ({@link lifespanQuantileMulFix})。
 *   2. 実行時は「一様 uint32 draw → 添字(整数除算)→ 倍率 → 平均寿命に乗算」
 *      だけを行う。**超越関数は 1 度も現れない**。
 *
 * これは近似ではなく「離散化した対数正規そのもの」であり、GDD の 離散 という
 * 語とも整合する。分布の妥当性(平均 = 1.0・変動係数 = `lifespanSigma`)は
 * content ローダー(`schema/engineContent.ts`)が **整数演算だけで機械検証**する
 * ので、テーブルを手で書き換えて分布を静かにずらすことはできない。
 *
 * ADR-018 の段階との関係: 本モジュールが引くのは「住民 1 人につき 1 回の独立な
 * 逆 CDF サンプリング」であり、他の確率系の状態に依存しない = 段階2 の
 * next-reaction 依存カスケード(ADR-018(2))には**一切踏み込まない**。
 */
export interface TownParams {
  /** GDD 7.5 の平均寿命(既定 432,000 tick = 約 300 日)。1 以上の整数。 */
  readonly lifespanMeanTicks: number;
  /**
   * 平均寿命に対する倍率の分位テーブル(**昇順・全て正**)。
   * 添字 i は等確率 `1/N` の分位に対応し、代表値は分位区間の中点 `(i+0.5)/N`。
   * 連続版の期待値が 1.0 になるよう正規化してある(= 平均寿命が
   * {@link lifespanMeanTicks} に一致する)。
   */
  readonly lifespanQuantileMulFix: readonly Fix[];
  /**
   * GDD 7.5 の `memoryDecayDelay`(記憶巧者 = 1.5)。
   * 「成文化猶予 = 寿命換算で 1.5 倍の余裕」を GDD 11.4-4 の
   * 「唯一保持者残存想定tick ≥ 成文化所要tick × 安全係数」判定へ供給する
   * (rules/lifespan.ts の {@link codifyDeadlineMarginTicks})。
   */
  readonly memoryDecayDelayFix: Fix;
  /** GDD 7.6 の人口下限 `min(寝床上限 × 0.5, 6)` の **0.5**。 */
  readonly populationFloorBedRatioFix: Fix;
  /** GDD 7.6 の人口下限 `min(寝床上限 × 0.5, 6)` の **6**(絶対保証の上限側)。 */
  readonly populationFloorAbsolute: number;
  /** GDD 7.7「定期加入(晴天漂着)」の周期(tick)。1 以上の整数。 */
  readonly arrivalIntervalTicks: number;
  /**
   * GDD 7.6「人口が下限を下回ると漂着加入頻度 ×1.5」を**周期**の側で表したもの
   * (= `floor(arrivalIntervalTicks / 頻度倍率)`)。周期どうしの比較は整数のまま
   * 行えるので、実行時に固定小数点の除算が要らない。
   * 不変条件: `1 <= scarcityArrivalIntervalTicks <= arrivalIntervalTicks`。
   */
  readonly scarcityArrivalIntervalTicks: number;
  /** 加入時年齢(tick)の下限。0 以上の整数。 */
  readonly joinAgeMinTicks: number;
  /** 加入時年齢(tick)の上限。{@link joinAgeMinTicks} 以上。 */
  readonly joinAgeMaxTicks: number;
}

// --- 4. content 全体 -------------------------------------------------------

/**
 * engine が読む content の全体(正準化済み内部表現)。
 *
 * Map の反復順は ID の昇順であることを前提にしてよい(ロード側が
 * canonicalize.ts のキーソートを通してから構築する)。rules 側で反復順に
 * 依存する集合演算を書く場合は、state 側と同じく明示ソートを挟むこと。
 */
export interface EngineContent {
  readonly facilityDefs: ReadonlyMap<EntityId, FacilityDef>;
  readonly techDefs: ReadonlyMap<EntityId, TechDef>;
  /** シード揺らぎ適用**前**の行列。適用は advance のコンテキスト構築時に行う。 */
  readonly adjacency: AdjacencyMatrix;
  readonly recallRisk: RecallRiskParams;
  /** 粗粒度ステップ幅(分 = tick)。MVP は 10(balance.coarseTickMinutes)。 */
  readonly coarseTickMinutes: number;
  /**
   * [M5] trait 定義(GDD 7.2)。**省略時は「生産へ効く trait が 1 つも無い」**
   * = 全住民の trait 倍率 1.0(rules/stats.ts §1 の中立既定値)。
   */
  readonly traitDefs?: ReadonlyMap<EntityId, TraitDef>;
  /**
   * [M5] 保管庫パラメータ(GDD 6.7)。**省略時は上限なし**(オーバーフロー機構が
   * 走らない)。
   */
  readonly storage?: StorageParams;
  /**
   * [M5] content の `trait.effects[].stat` のうち、engine が現時点で生産式へ
   * 写せなかったキーの一覧(重複なし・UTF-16 昇順)。
   *
   * 隣接効果と違い trait 効果は **reject せず読み飛ばす**(理由は
   * `schema/engineContent.ts` §1(e))。ただし「黙って捨てた」状態にはしないため、
   * 何を捨てたかをここへ機械可読で残し、テストで固定する。
   */
  readonly unrepresentedTraitEffects?: readonly string[];
  /**
   * [M6] エラ定義(GDD 5.1)。**省略時はエラという概念が無い content** として
   * 扱い、成文化の時代係数は 1.0、tech ツリー検査(rules/techTree.ts)は
   * 空の結果を返す。
   */
  readonly eraDefs?: ReadonlyMap<string, EraDef>;
  /**
   * [M6] 記録媒体パラメータ(GDD 11.1 追補)。**省略時は成文化が実行できない**
   * (rules/codify.ts の全コマンドが RulesError)。
   */
  readonly recordMedia?: RecordMediaParams;
  /**
   * [M11] 住民寿命・人口下限・獲得/規模のパラメータ(GDD 7.5〜7.7 / 12.1)。
   * **省略時は寿命の抽選も晴天漂着も走らない**(rules/population.ts §1)。
   */
  readonly town?: TownParams;
}

// --- 5. advance のコンテキスト ---------------------------------------------

/**
 * 1 回の advance の間だけ不変な、state 以外の入力をまとめたもの。
 * 構築は advance.ts の `createAdvanceContext`。
 *
 * ここに precompute を集約しているのは (A)(B)(C) の区間分割と噛み合っている:
 * セグメントごとに再計算するのは「レートを変える状態」(就労可否・研究の進行度)
 * だけで、**配置に依存する隣接乗数はセグメント境界で変わらない**。よって
 * 隣接計算は advance 1 回につき 1 度で済み(ADR-002(2) の O(近傍)を毎セグメント
 * 払わない)、72h catch-up でも隣接コストは 4320 tick 分に増えない。
 *
 * 前提: **advance の途中で施設の配置・Lv・就労者の割当は変わらない**
 * (それらの変更は Command 経路であり T5 のスコープ外)。配置を変えたら
 * コンテキストを作り直すこと。
 */
export interface AdvanceContext {
  readonly content: EngineContent;
  /** worldSeed(文字列)を uint32 へ落としたもの。hash アドレス方式 RNG の入力。 */
  readonly worldSeedU32: number;
  /** 施設 entity ID → 隣接ボーナス/過密ペナ込みの産出乗数。 */
  readonly multiplierByFacilityId: ReadonlyMap<EntityId, Fix>;
}

/**
 * 施設定義を引く。定義の欠落は黙って読み飛ばさない(content の整合違反は
 * schema 検証器で弾かれているべきものなので、ここへ来たら実装/ロードのバグ)。
 *
 * @throws {RulesError} 定義が無い場合
 */
export function requireFacilityDef(content: EngineContent, defId: EntityId): FacilityDef {
  const def = content.facilityDefs.get(defId);
  if (def === undefined) {
    throw new RulesError(`facility 定義 "${defId}" が content に無い`);
  }
  return def;
}

/**
 * 技術定義を引く。
 *
 * @throws {RulesError} 定義が無い場合
 */
export function requireTechDef(content: EngineContent, techId: EntityId): TechDef {
  const def = content.techDefs.get(techId);
  if (def === undefined) {
    throw new RulesError(`tech 定義 "${techId}" が content に無い`);
  }
  return def;
}

/**
 * [M6] tech の所属エラ定義を引く。エラ不明(`eraId` 省略 / `eraDefs` 省略 /
 * 該当 ID 無し)なら undefined。**呼び出し側は「エラ不明 = 時代係数 1.0」を
 * 既定として扱う**(rules/codify.ts §2)。
 */
export function eraDefOfTech(content: EngineContent, techId: EntityId): EraDef | undefined {
  const eraId = requireTechDef(content, techId).eraId;
  if (eraId === undefined) return undefined;
  return content.eraDefs?.get(eraId);
}

/**
 * [M6] tech の lossClass(GDD 7.4)。**省略時は
 * {@link DEFAULT_TECH_LOSS_CLASS}**。
 */
export function lossClassOfTech(content: EngineContent, techId: EntityId): TechLossClass {
  return requireTechDef(content, techId).lossClass ?? DEFAULT_TECH_LOSS_CLASS;
}

/** [M6] tech の前提テック(ID 昇順)。**省略時は空**。 */
export function prereqsOfTech(content: EngineContent, techId: EntityId): readonly EntityId[] {
  return requireTechDef(content, techId).prereqs ?? EMPTY_PREREQS;
}

/** 共有の空配列(エラ起点テックでアロケーションしないため)。 */
const EMPTY_PREREQS: readonly EntityId[] = [];
