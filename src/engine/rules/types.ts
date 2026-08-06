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
import type { EntityId, FacilityFootprint, InheritTrack } from "../state/state";
import type { CondExpr } from "./cond";
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
  /**
   * [M50] 建設 / 増築コスト(GDD 12.1 [2026-07-30裁定])。
   *
   * **省略時は無料**。省略を許すのは `workerSlotsByLevel` / `footprint` と同じ
   * 理由(engine のテストフィクスチャのような縮約 facility 定義でも rules が
   * 動くようにするため)で、**実 content は必ず値を持つ** ——
   * `schema/engineContent.ts` の `toFacilityDef` が欠落を reject する
   * (「schema では省略可・ローダーでは必須」の二段構え・GDD 12.1 の裁定本文)。
   *
   * 読むのは `commands.ts`(配置 / 増築の支払い)**だけ**である。tick ループは
   * 一切読まないので、この値を後から変えても既存 state の未来 tick は動かない
   * = golden vector に影響しない(`workerSlotsByLevel` と同じ性質)。
   */
  readonly cost?: FacilityCostDef;
  /**
   * [M66] Lv 別の同時休養枠(index 0 = Lv1・**整数の人数**)。GDD 11.2 の回復条件
   * 「療養所で休養1日」の受け皿であり、実装は `rules/care.ts`。
   *
   * **省略時はこの施設が休養枠を提供しない**。盤面の休養枠が 0 なら
   * `careRecipientsAt` は常に空を返す = M66 以前と 1 bit も違わない。
   */
  readonly careCapacityByLevel?: readonly number[];
  /**
   * [M66] Lv 別の防衛係数(index 0 = Lv1)。GDD 6.2「見張り台 → 外周ほど防衛係数
   * 上昇」の Σ防衛戦力の項であり、実装は `rules/raid.ts`。
   *
   * **省略時はこの施設が防衛に寄与しない**。
   */
  readonly defenseByLevel?: readonly Fix[];
}

/**
 * [M65] 施設 1 基のコスト行 1 本(1 資源ぶん)。{@link FacilityCostDef} の
 * 第2行以降がこの形で並ぶ。
 */
export interface FacilityCostLineDef {
  /** コストを引き落とす resource 定義 ID。 */
  readonly resourceId: EntityId;
  /** Lv1 で建てるときのコスト。 */
  readonly buildFix: Fix;
  /**
   * Lv 別の増築コスト。**index i = Lv(i+1) → Lv(i+2)**。長さは他の Lv 別カーブと
   * 揃えてあるので最後の要素(Lv5 → Lv6)は読まれない(schema/facility.ts [M50])。
   */
  readonly upgradeByLevel: readonly Fix[];
}

/**
 * [M50] 施設 1 基の建設 / 増築コスト(GDD 12.1 [2026-07-30裁定] / GDD 6.7 の
 * 廃材 3 出口(1))。
 *
 * **[M65] 複数資源になった**(2026-08-06裁定・ロードマップ M65)。M50 は「支払う
 * 資源は施設 1 基につき 1 種」だったが、M40 が「消費先の無い資源6種の接続は
 * content の additive 規約では実行不能」と機械証明したため、コスト行を増やせる形
 * へ広げた(schema/facility.ts 冒頭 [M65])。
 *
 * **第1行(主資源)を平置きのまま残してある**のは、M50 形の呼び出し側
 * (`src/ui/derived.ts` の建設/増築カード等)を 1 行も変えずに通すためであり、
 * 単一資源の content では {@link extraLines} が undefined = M50 と 1 bit も
 * 違わない経路になる。追加行の支払いは `commands.ts` の `payFacilityCost` が
 * 主資源のあとに続けて引く。
 */
export interface FacilityCostDef extends FacilityCostLineDef {
  /**
   * [M65] 2 種目以降のコスト行(content の記載順)。**省略 = 単一資源**
   * (M50 と同一挙動)。空配列にはしない(undefined に畳む)。
   */
  readonly extraLines?: readonly FacilityCostLineDef[];
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
   * **[M67] `fieldRequirement.count` は {@link fieldRequirementCount} で実効化
   * された**(2026-08-06裁定・台帳v20 必-1)。`recipe` は識別子のまま据え置きで、
   * ローダーは写さない(recipe entity は MVP 対象外)。
   */
  readonly fieldFacilityId?: EntityId;
  /**
   * [M67] 実地要件の回数(content の `tech.fieldRequirement.count`)。
   * GDD 5「テックは前提＋researchCost＋**実地要件(該当施設で該当レシピを N 回
   * 稼働)**で解禁」の N であり、engine は
   * `N × content.research.recipeRunTicks` tick の**該当施設の稼働**として
   * 解釈する(`ResearchPacingParams`)。
   *
   * **省略時 / `content.research` が無い場合は実地要件が働かない**
   * (研究点だけで完了する = M67 以前と同じ)。engine のテストフィクスチャや
   * 既存 conformance シナリオはこの経路を通る。
   */
  readonly fieldRequirementCount?: number;
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

// --- 3e. exploration(GDD 8.1〜8.6)— M21 ------------------------------------

/**
 * [M21] 距離帯の正本(**裁定 B7**: 近郊 = `near` / 遠隔 = `far` / 深部 = `deep`)。
 * 並びは UTF-16 昇順 = 集合演算の安定順序(GDD 11.7)であり、宣言順に意味は無い。
 */
export const DISTANCE_BANDS = ["deep", "far", "near"] as const;

/** {@link DISTANCE_BANDS} のいずれか。 */
export type DistanceBand = (typeof DISTANCE_BANDS)[number];

/** 未知の文字列が距離帯のいずれかか(型ガード)。セーブ復元の入口が使う。 */
export function isDistanceBand(value: string): value is DistanceBand {
  for (const band of DISTANCE_BANDS) {
    if (band === value) return true;
  }
  return false;
}

/**
 * [M21] 距離帯 1 本ぶんのパラメータ(GDD 8.1 / 8.2 / 8.5)。
 *
 * 難度・R は**人間単位の整数**で持つ(Fix ではない)。理由は 2 つ:
 *   (a) 判定は `combatPower`(0〜100 スケール)との比較なので同じ尺度で読める
 *   (b) 一様抽選 `uniformIntFromDraw` のレンジ幅上限
 *       ({@link ../stochastic.UNIFORM_SPAN_MAX} = 2,097,152)は raw 幅に掛かる
 *       ため、Fix のまま 0〜100 を一様に引くと上界を超える
 */
export interface ExplorationBandParams {
  /** GDD 8.1 の `base_time`(往復の基礎 tick)。1 以上。 */
  readonly baseTravelTicks: number;
  /** イベント列のノード数の下限(GDD 8.2: 3〜8)。 */
  readonly nodeCountMin: number;
  /** 同上限。{@link ../commands.DISPATCH_EVENT_NODES_MAX} 以下。 */
  readonly nodeCountMax: number;
  /** ノード難度の下限(人間単位の整数)。 */
  readonly difficultyMin: number;
  /** 同上限。 */
  readonly difficultyMax: number;
  /** GDD 8.2 の `seededRoll(0..R)` の R(人間単位の整数)。 */
  readonly rollRange: number;
  /** 判定成功 1 ノードあたりの報酬量。 */
  readonly rewardPerNodeFix: Fix;
  /** 報酬を受け取る resource 定義 ID。 */
  readonly rewardResourceId: EntityId;
  /** 判定失敗 1 回あたりの負傷蓄積(0〜100 スケール・GDD 8.5)。 */
  readonly injuryPerFailureFix: Fix;
  /** 脱落(= 1 名が失われる)累積負傷の閾値(GDD 8.5)。 */
  readonly casualtyInjuryThresholdFix: Fix;
  /** 1 ノードあたり「探索での保護」が起きる確率(GDD 7.7)。 */
  readonly rescueChanceFix: Fix;
  /**
   * 安全曲線の基準全滅確率(GDD 8.5 / 8.6)。**ROI(期待値)の解析モデル専用**で
   * あり、実際の全滅は負傷の累積という決定論経路で起きる
   * (`rules/exploration.ts` §4)。
   */
  readonly wipeBasePFix: Fix;
}

/**
 * [M21] 探索全体のパラメータ(`balance.json` の `exploration` ブロック)。
 *
 * **このブロックが content に無ければ {@link EngineContent.exploration} は
 * undefined** であり、派遣コマンドは `contentUnsupported` で拒否される
 * (= M21 以前と完全に同一挙動)。
 */
export interface ExplorationParams {
  /** 距離帯別のパラメータ(3 種とも必須)。 */
  readonly byBand: { readonly [K in DistanceBand]: ExplorationBandParams };
  /** GDD 8.3「撤退 = 資源半分確保で以降ノード打ち切り」の 0.5。 */
  readonly withdrawRewardRatioFix: Fix;
  /** GDD 8.3「強行 = 失敗時の負傷リスク ×1.5」の 1.5。 */
  readonly pressInjuryMulFix: Fix;
  /** 慎重(`cautious`)が撤退に踏み切る累積負傷(GDD 8.3 の「直前選択」の自動化)。 */
  readonly withdrawInjuryThresholdFix: Fix;
  /**
   * GDD 8.2 判定式の「装備補正」。item(装備)は MVP 未実装なので**チーム一律の
   * 1 段**であり、item が入る段で「装備ロードアウトの関数」へ差し替える。
   * combatPower 側へ混ぜないのは二重計上を避けるため(GDD 8.2 裁定)。
   */
  readonly equipmentBonusFix: Fix;
  /** GDD 8.1「チーム平均体力＋装備で最大 -30% 短縮」の 0.30。 */
  readonly travelSpeedupMaxFix: Fix;
  /** ROI の分母「逸失生産」= 派遣者 1 人 1 tick あたりの機会費用(GDD 8.6)。 */
  readonly forgoneOutputPerWorkerTickFix: Fix;
  /** ROI の分母「(B)喪失損失」= (B) 資産 1 件の金銭換算(GDD 8.6)。 */
  readonly rareAssetValueFix: Fix;
  /** 安全曲線の全滅確率の上限(GDD 8.5「理不尽全滅はしない曲線」)。 */
  readonly wipeMaxPFix: Fix;
  //
  // **[M64・2026-08-04裁定・台帳v17 必-1(案1)] `rewardOverflow` は撤廃した。**
  // M22 が置いた「探索報酬だけに掛かる独自の固定上限」(`{policy:'discard',
  // capacity:200}`)は、400 スケール再校正(M39/M40)から取り残されて薪 200 以上の
  // 報酬を黙殺していた(R5-A01・fatal)。上限の出所は
  // `balance.storage.baseCapacity` + 保管施設の加算式(GDD 6.7 [2026-08-02裁定])
  // 1 系統に統一され、探索報酬は本拠生産と同じ `rules/storage.ts` §2b を通る。
  // 旧キーが残った content はスキーマの未知キーとして黙って無視される
  // (reject しない = 後方互換)。
}

// --- 3f. event(GDD 8.2〜8.4 / 12.1 / 12.2)— M22 -----------------------------

/**
 * [M22] event ノードの choice 1 件(GDD 8.3「判定前の質的分岐」/ GDD 12.1
 * `choices[{label, effect}]`)。
 *
 * 4 つの効果軸はいずれも**比率**であり、`schema/event.ts` の
 * `EFFECT_MOD_RANGE`(±1)/ `INJURY_RISK_MUL_RANGE`(0〜5)がレンジを持つ。
 * 省略された軸はここでは中立値(mod は 0 / mul は 1)で埋まっているので、
 * engine 側に「指定されたか」の分岐は残らない。
 */
export interface EventChoiceDef {
  /** 表示ラベル(UI 用。RNG の salt にも使う = `choiceKey`・ADR-007)。 */
  readonly label: string;
  /**
   * 「慎重 = 成功率+」の量。判定式の左辺へ `successMod × R` を加える
   * (一様乱数 0..R のモデルでは、これがそのまま成功確率の増分になる)。
   */
  readonly successModFix: Fix;
  /** 「報酬-」「報酬+」の量。ノード報酬に `(1 + rewardMod)` を掛ける。 */
  readonly rewardModFix: Fix;
  /** 「難度+」の量。ノード難度に `(1 + difficultyMod)` を掛ける。 */
  readonly difficultyModFix: Fix;
  /** 「強行 = 負傷リスク ×1.5」の量。失敗時の負傷に掛ける(既定 1.0)。 */
  readonly injuryRiskMulFix: Fix;
}

/**
 * [M22] `destroyRecords{medium, scope}` の対象媒体
 * (GDD 11.1 [2026-07-27追補]・engine 既知の 2 種 + 「媒体を問わない」)。
 */
export const DESTROY_RECORDS_MEDIA = ["any", "paper", "stoneTablet"] as const;

/** {@link DESTROY_RECORDS_MEDIA} のいずれか。 */
export type DestroyRecordsMedium = (typeof DESTROY_RECORDS_MEDIA)[number];

/** 未知の文字列が対象媒体のいずれかか(型ガード)。 */
export function isDestroyRecordsMedium(value: string): value is DestroyRecordsMedium {
  for (const medium of DESTROY_RECORDS_MEDIA) {
    if (medium === value) return true;
  }
  return false;
}

/**
 * [M22] `destroyRecords{medium, scope}` の対象範囲(GDD 11.1 追補)。
 *
 *   all       : `medium` に一致する完成済み記録すべて
 *   flammable : そのうち**可燃**なものだけ(火災の既定形。`medium: "any"` と
 *               組めば GDD 11.1 の「可燃記録の焼失」そのものになる)
 *   oldest    : そのうち最も古い 1 枚(完成 tick 昇順 → ID 昇順で一意)
 */
export const DESTROY_RECORDS_SCOPES = ["all", "flammable", "oldest"] as const;

/** {@link DESTROY_RECORDS_SCOPES} のいずれか。 */
export type DestroyRecordsScope = (typeof DESTROY_RECORDS_SCOPES)[number];

/** 未知の文字列が対象範囲のいずれかか(型ガード)。 */
export function isDestroyRecordsScope(value: string): value is DestroyRecordsScope {
  for (const scope of DESTROY_RECORDS_SCOPES) {
    if (scope === value) return true;
  }
  return false;
}

/**
 * [M22] 分岐の結果(GDD 12.1 [2026-07-27追補]「`branches[].result` 語彙に
 * `destroyRecords{medium, scope}` を予約する」)。
 *
 *   continue       : そのまま次のノードへ(既定。state を動かさない)
 *   withdraw       : ここで探索を打ち切る(GDD 8.3 撤退 = 報酬半分・以降なし)
 *   destroyRecords : 記録を破壊する(GDD 11.1 追補の焼失セマンティクス)
 *
 * **MVP では content 側から `destroyRecords` を使わない**(火災イベントを
 * 1 本も入れない・GDD 11.1 追補)。engine には効果プリミティブだけを置き、
 * 挙動を conformance で固定しておくことで、MVP 後に **event JSON の additive
 * 追加だけ**で火災を解禁できる(engine 変更なし = golden 不変 = bump 不要)。
 */
export type EventResult =
  | { readonly kind: "continue" }
  | { readonly kind: "withdraw" }
  | {
      readonly kind: "destroyRecords";
      readonly medium: DestroyRecordsMedium;
      readonly scope: DestroyRecordsScope;
    };

/** {@link EventResult} の種別(UTF-16 昇順・schema 側の語彙表と対で維持する)。 */
export const EVENT_RESULT_KINDS = ["continue", "destroyRecords", "withdraw"] as const;

/** {@link EVENT_RESULT_KINDS} のいずれか。 */
export type EventResultKind = (typeof EVENT_RESULT_KINDS)[number];

/** 未知の文字列が結果種別のいずれかか(型ガード)。 */
export function isEventResultKind(value: string): value is EventResultKind {
  for (const kind of EVENT_RESULT_KINDS) {
    if (kind === value) return true;
  }
  return false;
}

/**
 * [M22] 判定後の分岐 1 本(GDD 12.1 `branches[{cond, result, logTemplate}]`)。
 * `cond` は**コンパイル済み**の内部表現であり、実行時に文字列パースは走らない
 * (rules/cond.ts §1)。
 */
export interface EventBranchDef {
  readonly cond: CondExpr;
  readonly result: EventResult;
  /**
   * 帰還ログの本文テンプレ(GDD 8.4)。`{name}` 形式のプレースホルダのみを
   * 許し、語彙は `rules/event.ts` の `LOG_TEMPLATE_PLACEHOLDERS` が正本
   * (未知プレースホルダはロード時 reject)。**レンダリング済みの完成文字列**が
   * セーブへ入るので、後日テンプレを直しても過去ログは壊れない(GDD 12.5-7)。
   */
  readonly logTemplate: string;
}

/**
 * [M22] event のノード 1 件(GDD 12.1 の `nodes[]`)。
 *
 * 難度と R が**人間単位の整数**なのは {@link ExplorationBandParams} と同じ理由
 * (一様抽選のレンジ幅上限に掛からないため)。
 */
export interface EventNodeDef {
  /** 判定難度(人間単位の整数。combatPower と同じ 0〜100 スケール)。 */
  readonly difficulty: number;
  /** `seededRoll(0..R)` の R(人間単位の整数)。 */
  readonly rollRange: number;
  /**
   * 「関連ステータス」の重み(GDD 8.2「関連ステータスはイベント種別で変わる」)。
   * 基礎ステ 5 種ぶん。指定の無い stat は 0 で埋まっている。
   */
  readonly statWeights: StatWeights;
  /**
   * 派生値 `combatPower` の重み(裁定 B8「`statWeights` に `combatPower` を
   * 書く場合、ローダーは基礎ステと別扱いで解決する」)。省略時は 0。
   */
  readonly combatPowerWeightFix: Fix;
  /** 判定前の質的分岐(GDD 8.3)。空なら選択肢なし。 */
  readonly choices: readonly EventChoiceDef[];
  /** 判定後の分岐(GDD 12.1)。**最後の 1 本は無条件成立**(ロードが強制)。 */
  readonly branches: readonly EventBranchDef[];
}

/**
 * [M22] event 定義(GDD 12.1 の `event(id, destTags, nodes[])`)。
 *
 * **省略可の content カテゴリ**であり、`content/event.json` が無い盤面では
 * {@link EngineContent.eventDefs} が空 Map になる。そのとき派遣は M21 と同じ
 * 手続き生成(`rules/exploration.ts` §3)へフォールバックし、1 bit も
 * 挙動が変わらない。
 */
export interface EventDef {
  readonly id: EntityId;
  /** この event が出うる距離帯(裁定 B7)。 */
  readonly destTags: readonly DistanceBand[];
  /** イベント列(3〜8 ノード・GDD 8.2)。 */
  readonly nodes: readonly EventNodeDef[];
}

// --- 3g. outpost(GDD 9.2 / 12.1)— M24 ---------------------------------------
//
//   GDD 9.2「供給 supply = baseSupply(type) × 常駐人数 × 拠点Lv × (1 − 翳り率)」
//   の「baseSupply(type) × 拠点Lv」を、facility.outputPerTickByLevel と同じ
//   オーサリング時展開(GDD 11.7「非整数べき乗は実行時計算禁止」)で
//   {@link OutpostTypeDef.supplyPerResidentTickByLevel} 1 本にまとめる。
//   「翳り率 = clamp(0, 幕塵後退度 × shadeSensitivity, 1)」の幕塵後退度は
//   幕塵メーター(GDD 11.7 段90)が未実装(scheduler.ts の PIPELINE_STAGE.dust
//   参照)のため、本モジュールは呼び出し側から**引数で受け取る**(state には
//   持たせない)。既定は常に 0(= 翳りなし)として渡すこと。幕塵メーター実装後は
//   その値をそのままここへ渡せば式が完成する形にしてある。

/** [M24] 拠点の維持コスト式パラメータ(GDD 9.2 upkeepFormula)。 */
export interface OutpostUpkeepParams {
  /** 常駐 1 人あたりの食料維持費(GDD 9.2「食料baseFood × 常駐人数」)。 */
  readonly baseFoodFix: Fix;
  /** 士気ケアの基礎費用(GDD 9.2「士気ケアbaseMorale × 距離帯係数」の baseMorale)。 */
  readonly baseMoraleCareFix: Fix;
}

/**
 * [M24] 拠点の脅威パラメータ(GDD 12.1 `hazard{intensity,growth,min,max}`)。
 * 0〜1 スケールの「脅威強度」であり、設置からの経過日数に応じて線形に育つ
 * (GDD 11.7 の非整数べき乗禁止に従い、増加は乗算でなく加算のみ)。
 */
export interface OutpostHazardParams {
  /** 設置直後(経過0日)の脅威強度。 */
  readonly intensityFix: Fix;
  /** 1 ゲーム日(1440 tick)あたりの脅威増分。 */
  readonly growthPerDayFix: Fix;
  /** 脅威強度の下限(intensity 未満には下がらない)。 */
  readonly minFix: Fix;
  /** 脅威強度の上限。 */
  readonly maxFix: Fix;
}

/**
 * [M24] 衛星拠点タイプ 1 種ぶんの定義(GDD 9.2 / 12.1
 * `outpostType(id, resource, baseSupply, capacityCurve, upkeepFormula,
 * hazard{intensity,growth,min/max}, shadeSensitivity)`)。
 */
export interface OutpostTypeDef {
  readonly id: EntityId;
  /** 供給する資源の定義 ID(GDD 9.2「タイプ別供給」)。本拠側と**同じ ID 空間**を
   * 共有する(= 供給は本拠在庫の同じ resource entity へ入る。二重計上を防ぐ
   * 構造上の根拠)。 */
  readonly resourceId: EntityId;
  /**
   * Lv 別・常駐 1 人あたりの 1 tick 供給量(index 0 = Lv1)。
   * `baseSupply × capacityCurve[Lv-1]` をオーサリング時に個別 FP 展開したもの
   * (facility.outputPerTickByLevel と同型・GDD 11.7)。
   */
  readonly supplyPerResidentTickByLevel: readonly Fix[];
  readonly upkeep: OutpostUpkeepParams;
  readonly hazard: OutpostHazardParams;
  /** 翳り率への感度(GDD 9.2「拠点固有shadeSensitivity」)。 */
  readonly shadeSensitivityFix: Fix;
}

/**
 * [M24] 拠点網全体のパラメータ(`balance.json` の `outpost` ブロック)。
 * **ブロックごと省略可**(欠落は undefined)。省略時は engine 側で維持費の
 * 距離帯係数が求まらないため、rules/outpost.ts の維持費計算が RulesError で
 * 止まる(= 拠点システムが不活性。storage/exploration 等の既存ブロックと同じ
 * 「省略時は当該システム不活性」の形)。
 */
export interface OutpostParams {
  /** 距離帯別の維持費係数(GDD 9.2「士気ケア...×距離帯係数」・裁定 B7)。 */
  readonly distanceBandUpkeepMulFix: { readonly [K in DistanceBand]: Fix };
}

/**
 * [M52] 瓦礫の開墾パラメータ(`balance.json` の `reclaim` ブロック・GDD 9.1)。
 * **ブロックごと省略可**(欠落は undefined)。省略時は `commands.ts` の
 * `reclaimCell` が `contentUnsupported` で拒否する(= 開墾システムが不活性。
 * storage / exploration / outpost と同じ「省略時は当該システム不活性」の形)。
 *
 * **コスト曲線を配列で持たない**のは、facility の `lvCurve` / outpostType の
 * `capacityCurve`(どちらもオーサリング時に個別 FP 展開する規約)と意図的に
 * 異なる。理由は 2 つ:
 *   (a) 解放数の上限は盤面の瓦礫枚数で決まり、初期配置(content)と外周拡張
 *       (GDD 9.1 の 6×8 → 8×10)で動く。段数が動く曲線を配列で持つと、
 *       初期配置を 1 枚増やすたびに表の長さを直す必要が出る。
 *   (b) GDD 9.1 / 11.1 はここだけ**式そのもの**(`base × 1.15^解放数 + cap`)を
 *       正本として書いている。式を engine が持てば、cap 到達点のような性質を
 *       テストで直接固定できる(rules/reclaim.ts §2)。
 */
export interface ReclaimParams {
  /** 解放数 0(最初の 1 枚)の開墾コスト。 */
  readonly baseCostFix: Fix;
  /** 逓増の底(GDD 9.1 の 1.15)。1.0 以上。 */
  readonly costGrowthFix: Fix;
  /** GDD 9.1 の「最終セルでも到達可能な明示上限 cap」。 */
  readonly costCapFix: Fix;
  /** コストを引き落とす resource 定義 ID。 */
  readonly costResourceId: EntityId;
  /**
   * 新規ゲームの初期瓦礫セル(**セル番号の昇順・重複なし**・GDD 6.1
   * 「初期利用可は一部、残りは瓦礫」)。
   *
   * これは**生成パラメータ**であって現在の盤面ではない。読むのは
   * `rules/reclaim.ts` の `initialTerrain` **だけ**であり、既存 state を
   * 遡って書き換えることは無い(content の footprint を配置時にだけ読む
   * M16 の規律と同じ・footprint.ts §1)。
   */
  readonly initialRubbleCells: readonly number[];
}

// --- 3h. exodus / 継承点(GDD 10.2〜10.5 / 11.4-6)— M28 ----------------------

/**
 * [M28] 大移動(Exodus)と継承点のパラメータ(`balance.json` の `exodus`
 * ブロック・GDD 10.2〜10.5)。**ブロックごと省略可**(欠落は undefined)。
 * 省略時は `commands.ts` の `executeExodus` / `purchaseInheritBonus` が
 * `contentUnsupported` で拒否する(= 周回システム不活性。storage / exploration /
 * outpost / reclaim と同じ「省略時は当該システム不活性」の形)。
 *
 * ===========================================================================
 * 「想定石版総数(到達エラ)」を **静的テーブル**で持つ理由(GDD 10.2)
 * ===========================================================================
 * GDD 10.2 は容量式の第 1 項について「各エラのクリティカルパス＋標準想定葉テック
 * 本数からなる**静的テーブル値**とし、週次葉テック追加では変動させない
 * (セーブ互換単純化)」と明記している。よって engine は **content の tech 定義を
 * 数えない**({@link expectedTabletsByEra} を引くだけ)。数えてしまうと、週次の
 * additive な葉テック追加だけでキャラバン容量が動き、同じセーブの大移動結果が
 * content 版で変わる = ADR 3軸(b)「additive-only で吸収」が破れる。
 *
 * ===========================================================================
 * 段階コストを配列で持つ理由(GDD 10.3 の `cost(n) = 50 × 1.5^(購入済み段階n)`)
 * ===========================================================================
 * 実行時の非整数べき乗は ADR-006 の Math 許可リストで禁止であり、GDD 11.7 の
 * 「非整数べき乗はオーサリング時に個別 FP 値へ展開」に従って **展開済みの
 * 段階コスト列**({@link tierCosts} = GDD 10.3 の 50/75/113/169)を content が
 * 持つ。配列の長さがそのまま「各ボーナスの上限段数」(GDD 10.3「各ボーナスに
 * 上限段階」)= **青天井にならないことの構造的な根拠**(GDD 11.4-6)である。
 * `rules/reclaim.ts` が `1.15^n` を mulFix 反復で作っているのと扱いが違うのは、
 * あちらは段数の上限が盤面(瓦礫枚数)で動くのに対し、こちらは段数そのものが
 * 仕様(4 段)だからである。
 */
export interface ExodusParams {
  /** GDD 10.2 の `0.35`(`容量 = ceil(想定石版総数 × 0.35) + 継承点ボーナス`)。 */
  readonly caravanRatioFix: Fix;
  /**
   * GDD 10.2「想定石版総数(到達エラ)」の静的テーブル(eraId → 本数)。
   * 到達エラのエントリが無い content では容量の第 1 項が 0 になる。
   */
  readonly expectedTabletsByEra: ReadonlyMap<string, number>;
  /** GDD 10.2 の `0.5`(`crewCap = ceil(生存人数 × 0.5) + 継承ボーナス`)。 */
  readonly crewRatioFix: Fix;
  /** GDD 10.3 獲得式の `到達エラ × 10` の 10。 */
  readonly eraPointsFix: Fix;
  /** GDD 10.3 獲得式の `成文化率(%) × 0.5` の 0.5(**% 1 点あたり**)。 */
  readonly codifyRatePointsFix: Fix;
  /** GDD 10.3 獲得式の `生存住民数 × 2` の 2。 */
  readonly survivorPointsFix: Fix;
  /**
   * GDD 10.3 の段階コスト(展開済み・**昇順**)。`tierCosts[n]` = 購入済み n 段の
   * 状態で次の 1 段を買うコスト。長さ = 上限段数(GDD 10.3 は 4 段 = 50/75/113/169)。
   */
  readonly tierCosts: readonly number[];
  /** 系統 1 段あたりのボーナス量(整数)。3 系統とも必須。 */
  readonly trackBonusPerTier: { readonly [K in InheritTrack]: number };
  /** `startingStock` 系統のボーナスが積まれる resource 定義 ID。 */
  readonly startingStockResourceId: EntityId;
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
  /**
   * [M21] 探索パラメータ(GDD 8.1〜8.6)。**省略時は派遣そのものができない**
   * (`commands.ts` の `dispatchExpedition` が `contentUnsupported` で拒否)。
   */
  readonly exploration?: ExplorationParams;
  /**
   * [M22] event 定義(GDD 12.1 / 8.2〜8.4)。**省略時 / 空のとき、派遣は M21 の
   * 手続き生成へフォールバックする**(= M22 以前と 1 bit も違わない)。
   * `content/event.json` はまだ無く、投入は M23 の担当。
   */
  readonly eventDefs?: ReadonlyMap<EntityId, EventDef>;
  /**
   * [M24] 衛星拠点タイプ定義(GDD 9.2 / 12.1)。**省略時 / 空のとき、拠点系の
   * rules(rules/outpost.ts)は呼び出されると RulesError で止まる**(= 拠点機構
   * そのものが無いことの明示。facility 同様「定義が無い ID を使おうとしたら止まる」
   * 既存方針を踏襲)。
   */
  readonly outpostTypeDefs?: ReadonlyMap<EntityId, OutpostTypeDef>;
  /**
   * [M24] 拠点網全体のパラメータ(GDD 9.2)。**省略時は維持費の距離帯係数が
   * 求まらない**(rules/outpost.ts の維持費計算が RulesError)。
   */
  readonly outpost?: OutpostParams;
  /**
   * [M52] 瓦礫の開墾パラメータ(GDD 9.1)。**省略時は開墾できない**
   * (`commands.ts` の `reclaimCell` が `contentUnsupported` で拒否)。
   * 既に置かれた瓦礫の**配置判定**(`placeFacility` の拒否)はこのブロックが
   * 無くても効く —— 瓦礫は state 権威であり、content はコストと初期配置しか
   * 持たないためである。
   */
  readonly reclaim?: ReclaimParams;
  /**
   * [M28] 大移動 / 継承点のパラメータ(GDD 10.2〜10.5)。**省略時は大移動も
   * 継承ボーナス購入もできない**(`commands.ts` の `executeExodus` /
   * `purchaseInheritBonus` が `contentUnsupported` で拒否)。
   */
  readonly exodus?: ExodusParams;
  /**
   * [M67] 研究ペーシング(GDD 5.2 の第2ゲート = 実地要件)。**省略時は実地要件が
   * ゲートとして働かない**(= M67 以前と 1 bit も違わない)。既存 conformance
   * シナリオはこのブロックを持たないので、golden vector の既存分は不活性。
   */
  readonly research?: ResearchPacingParams;
  /**
   * [M66] 療養所の休養(GDD 11.2 の回復条件の第2枝)。**省略時は休養が働かない**
   * (= M66 以前と 1 bit も違わない)。既存 conformance シナリオはこのブロックを
   * 持たないので、golden vector の既存分は不活性。
   */
  readonly care?: CareParams;
  /**
   * [M66] 襲撃(GDD 11.7 段10 / 11.1 の戦闘式)。**省略時は襲撃が一度も起きない**
   * (= M66 以前と 1 bit も違わない)。`care` と同じ立場。
   */
  readonly raid?: RaidParams;
  /**
   * [M72] 士気の更新規則(GDD 4.2 / 7.3 / 11.2)。**省略時は士気が業務で動かない**
   * (= M72 以前と 1 bit も違わない。士気を書き換えるのは伴侶喪失の bond ペナ
   * だけ、という M13 以来の状態)。`care` / `raid` と同じ立場。
   */
  readonly morale?: MoraleParams;
}

/**
 * [M72] 士気モデルのパラメータ(2026-08-06裁定・台帳v20 必-4)。
 *
 * GDD は「過酷業務・派遣・士気切れに晒すと想起困難」(4.2)・「通常業務就労かつ
 * 士気 ≥40 を持続、または療養所で休養1日」(11.2)・「絆は士気補正+と士気回復+を
 * 生む」(7.3)と**士気が動く前提**で書かれているが、士気を動かす規則そのものは
 * 未実装だった。ここがその規則の content 側パラメータである
 * (`rules/morale.ts` §1 に各値の設計根拠)。
 */
export interface MoraleParams {
  /** 過酷業務(`FacilityDef.harshWork`)への就労 1 日あたりの士気低下量。 */
  readonly harshWorkDropPerDayFix: Fix;
  /** 通常業務への就労 1 日あたりの士気回復量。 */
  readonly normalWorkRecoverPerDayFix: Fix;
  /** 療養所で休養している間の 1 日あたりの追加回復量(`rules/care.ts`)。 */
  readonly careRecoverPerDayFix: Fix;
  /**
   * **業務由来の低下の下限**(実効士気・人間単位)。GDD 11.2 の moraleW 閾値 30 を
   * 日常業務では割らせないための設計値(rules/morale.ts §1(c))。
   */
  readonly routineFloorFix: Fix;
  /**
   * GDD 11.5 の bot 判断閾値(士気 <40 で過酷業務・派遣に回さない)。
   * engine は読まないが、sim(`sim/strategy/recallGuard.ts`)が content から
   * 読むための単一の置き場所である(ハードコード排除・台帳v20 必-4)。
   */
  readonly recallGuardThresholdFix: Fix;
}

/**
 * [M66] 療養所の休養パラメータ(GDD 11.2「回復条件: …または療養所で休養1日」)。
 * 休養枠そのものは施設側(`FacilityDef.careCapacityByLevel`)にある。
 */
export interface CareParams {
  /** 休養で想起困難が解けるまでの tick(GDD の「1日」= 1440)。 */
  readonly restRecoveryTicks: number;
}

/**
 * [M66] 襲撃パラメータ(GDD 11.1「戦闘: 勝敗 = (Σ防衛戦力 × 配置ボーナス +
 * seededRoll) vs 襲撃強度(時代逓増)」/ GDD 11.7 段10)。
 */
export interface RaidParams {
  /** 襲撃判定の周期(tick)。判定 tick は絶対グリッド `n × intervalTicks`。 */
  readonly intervalTicks: number;
  /** 到達エラ 1 における襲撃強度。 */
  readonly baseStrengthFix: Fix;
  /** 到達エラが 1 段上がるごとの強度増分(「時代逓増」)。 */
  readonly strengthGrowthPerEraFix: Fix;
  /** seededRoll の上限(0〜この値の一様整数)。 */
  readonly rollRange: number;
  /** 外周セルの防衛施設に掛かる配置ボーナス(GDD 6.2「外周ほど」)。 */
  readonly perimeterDefenseMulFix: Fix;
  /** 撃退失敗時に各資源から失われる比率。 */
  readonly lootRatioFix: Fix;
}

/**
 * [M67] 研究ペーシングのパラメータ(2026-08-06裁定・台帳v20 必-1 の最小形)。
 *
 * `tech.fieldRequirement` の recipe ID は**識別子のまま据え置き**であり、
 * 実効化するのは `count` だけである。「該当施設で該当レシピを N 回稼働」を
 * 「該当施設(`TechDef.fieldFacilityId`)が `N × recipeRunTicks` tick 稼働する」
 * と読み替える(recipe entity は MVP 対象外)。
 */
export interface ResearchPacingParams {
  /** レシピ 1 回ぶんの稼働 tick 換算(1 以上の整数)。 */
  readonly recipeRunTicks: number;
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

/**
 * [M24] outpostType 定義を引く。
 *
 * @throws {RulesError} 定義が無い場合(content に outpostTypeDefs ブロックが
 *   無い場合を含む)
 */
export function requireOutpostTypeDef(content: EngineContent, defId: EntityId): OutpostTypeDef {
  const def = content.outpostTypeDefs?.get(defId);
  if (def === undefined) {
    throw new RulesError(`outpostType 定義 "${defId}" が content に無い(GDD 9.2 / 12.1)`);
  }
  return def;
}

/**
 * [M24] 拠点網パラメータを引く。
 *
 * @throws {RulesError} content に outpost ブロックが無い場合
 */
export function requireOutpostParams(content: EngineContent): OutpostParams {
  if (content.outpost === undefined) {
    throw new RulesError(
      "content に balance の outpost ブロックが無いので拠点の維持費が求まらない(GDD 9.2)",
    );
  }
  return content.outpost;
}

/**
 * [M52] 開墾パラメータを引く。
 *
 * @throws {RulesError} content に reclaim ブロックが無い場合
 */
export function requireReclaimParams(content: EngineContent): ReclaimParams {
  if (content.reclaim === undefined) {
    throw new RulesError(
      "content に balance の reclaim ブロックが無いので開墾コストが求まらない(GDD 9.1)",
    );
  }
  return content.reclaim;
}

/**
 * [M28] 大移動 / 継承点のパラメータを引く。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function requireExodusParams(content: EngineContent): ExodusParams {
  if (content.exodus === undefined) {
    throw new RulesError(
      "content に balance の exodus ブロックが無いので大移動と継承点が成立しない(GDD 10.2〜10.5)",
    );
  }
  return content.exodus;
}
