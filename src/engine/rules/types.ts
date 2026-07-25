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
import type { EntityId } from "../state/state";

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
}

// --- 2. tech 定義 ----------------------------------------------------------

/** 技術定義(content)。縮約では研究コストだけを読む。 */
export interface TechDef {
  readonly id: EntityId;
  readonly researchCostFix: Fix;
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
