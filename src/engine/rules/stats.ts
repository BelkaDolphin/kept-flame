// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 住民ステータス 5 種と trait 倍率の合成 — GDD 7.1 / 7.2 / 11.1
//
// ===========================================================================
// 1. このモジュールの位置づけ(M5「rules 全系統化(1)」)
// ===========================================================================
//   T5 の縮約生産式は
//     ratePerTick = 出力(Lv) × 隣接乗数 × 稼働就労者数
//   であり、GDD 11.1 の完全形
//     yield = baseYield × facilityLv係数 × (1 + Σ隣接補正)
//             × (Σ担当者ステータス寄与 / 50) × trait倍率
//   のうち「Σ担当者ステータス寄与 / 50」と「trait 倍率」を 1.0 に固定していた。
//   本モジュールはその 2 項を実装する。
//
//   **中立既定値の設計原則**: ステータス未設定の住民は全ステータスが基準値 50
//   (GDD 7.1「基準50」)、trait 未保持なら倍率 1.0 とする。この既定の下では
//   1 就労者あたりの寄与が **厳密に 1.0(raw 1_000_000)** になり、縮約形の
//   「稼働就労者数」と 1 bit も違わない({@link NEUTRAL_CONTRIBUTION_IS_ONE} の
//   証明。tests で機械確認する)。既存 golden vector 37 本が動かない根拠がこれ。
//
// ===========================================================================
// 2. 正本 ID(裁定 B8・GDD 7.1)
// ===========================================================================
//   ステータス 5 種の英字 ID 正本は vigor / dexterity / intellect / fortitude /
//   will。{@link RESIDENT_STAT_IDS} の**宣言順が集合演算の加算順序**でもある
//   (GDD 11.7「全集合演算は安定順序で計算」)。派生値 combatPower は基礎ステと
//   別名前空間であり、ここには含めない(GDD 7.1 の注記)。派生値側の名前空間は
//   {@link RESIDENT_DERIVED_STAT_IDS}(§5)。
//
// ===========================================================================
// 3. trait 効果モデル(GDD 7.2 の解釈)
// ===========================================================================
//   GDD 7.2 は `trait.effects[{stat, op[mul|add], value}]` と「同種効果は乗算合成
//   → カテゴリ別上限クランプ」だけを定め、GDD 11.1 の生産式には別途「× trait倍率」
//   の項がある。両者を二重計上しないため、本実装は次のように読み分ける:
//
//     (a) `stat` が 5 種のいずれか → **ステータスへの効果**。同一 stat について
//         add は総和、mul は総乗で合成し、`(base + Σadd) × Πmul` を 0〜100 に
//         クランプする(GDD 7.1「0〜100・上限厳守」)。
//     (b) `stat` が予約語 `yieldMul` → **生産式の「trait 倍率」項そのもの**。
//         総乗で合成しカテゴリ上限でクランプする。
//
//   合成順序は「住民の traitIds 順(= ID 昇順・state の不変条件)」→「trait 内の
//   effects 配列順(content の記述順)」に固定する。floor 丸めがあるため総乗は
//   順序依存であり、順序の固定が決定論の要件になる。
//
//   **上限クランプの値は GDD に明示が無い**。GDD 7.2 が挙げるのは *1 効果あたりの*
//   レンジ(ステータス倍率 ±30% 以内 / 成文化速度 0.7〜1.5)だけで、3 個まで
//   重ねた**合成後**の上限は書かれていない。本実装は保守側として「1 効果あたりの
//   レンジをそのまま合成後の上限にも使う」= ステータス倍率 [0.7, 1.3]、
//   trait 倍率 [0.7, 1.5] を engine 定数として採用する(裁定 N2 と同じ理由で
//   content 化しない = 変えると golden が動くため)。**要ユーザー判断**として
//   報告する。
//
// ===========================================================================
// 4. 値域と mulFixProven(ADR-006 §4 の証明の書き方)
// ===========================================================================
//   本モジュールは fp.ts の「証明済み経路」= {@link mulFixProven} を使う数少ない
//   場所である。使えるのは全オペランドに**構造的な上界**があるため:
//     - ステータス値      : クランプ後 0〜100        → |raw| <= 1e8
//     - ステータス重み    : 0〜1(総和 1 をローダーが強制) → |raw| <= 1e6
//     - trait 倍率        : クランプ後 0.7〜1.5      → |raw| <= 1.5e6
//     - trait 加算の合成  : 1 trait 最大 6 効果 × |30|、1 住民最大 3 trait
//                           (schema/trait.ts の MAX_EFFECTS / maxPerResident)
//                           → |Σadd| <= 540、base 込みで |base + Σadd| <= 640
//   各乗算の中間積は §ごとの doc コメントに計算を書いてある。上界の根拠が
//   schema の制約である箇所は、schema 側を緩めたら証明が破れる(fp.ts §4 の
//   「上界は schema 検証器の min/max と対で維持すること」)。
// ---------------------------------------------------------------------------

import {
  FIX_ONE,
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromInt,
  fixFromRaw,
  floorDivFix,
  mulFixProven,
  toRaw,
  type Fix,
} from "../fp";
import type { EntityId } from "../state/state";

// --- 1. ステータス 5 種(裁定 B8) -------------------------------------------

/**
 * 住民ステータス 5 種の正本英字 ID(裁定 B8 / GDD 7.1)。
 * **宣言順が集合演算の加算順序**(GDD 11.7)。
 */
export const RESIDENT_STAT_IDS = ["vigor", "dexterity", "intellect", "fortitude", "will"] as const;

/** ステータス 5 種のいずれか。 */
export type ResidentStatId = (typeof RESIDENT_STAT_IDS)[number];

/** 未知の文字列がステータス 5 種のいずれかか(型ガード)。 */
export function isResidentStatId(value: string): value is ResidentStatId {
  for (const statId of RESIDENT_STAT_IDS) {
    if (statId === value) return true;
  }
  return false;
}

/** 住民のステータス一式。人間単位 0〜100 の Fix(GDD 7.1「0〜100・上限厳守」)。 */
export type ResidentStats = { readonly [K in ResidentStatId]: Fix };

/** ステータスの下限 = 0(GDD 7.1)。 */
export const STAT_MIN_FIX = FIX_ZERO;
/** ステータスの上限 = 100(GDD 7.1)。 */
export const STAT_MAX_FIX = fixFromInt(100);
/** ステータスの基準値 = 50。生産式の除数(GDD 7.1「基準50」/ 11.1 の `/50`)。 */
export const STAT_BASELINE_FIX = fixFromInt(50);

/**
 * ステータス未設定の住民に使う中立既定値(全ステータス = 基準 50)。
 * この値では 1 就労者あたりの寄与が厳密に 1.0 になる(§1)。
 */
export const NEUTRAL_RESIDENT_STATS: ResidentStats = {
  vigor: STAT_BASELINE_FIX,
  dexterity: STAT_BASELINE_FIX,
  intellect: STAT_BASELINE_FIX,
  fortitude: STAT_BASELINE_FIX,
  will: STAT_BASELINE_FIX,
};

// --- 2. ステータス重み(施設ごとの「関連ステータス」) -----------------------

/**
 * 施設が就労者のどのステータスをどれだけ参照するか(GDD 11.1「Σ担当者**関連**
 * ステータス寄与」の「関連」の実体)。
 *
 * 不変条件: 各値は 0 以上 1 以下、**総和はちょうど 1.0**。総和 1 を強制するのは
 * 中立性のため — 総和が 1 なら「全ステータス 50 の住民の寄与 = 50」であり
 * `/50` で厳密に 1.0 になる(§1)。強制は content ローダー
 * (`schema/engineContent.ts`)が行う。
 */
export type StatWeights = { readonly [K in ResidentStatId]: Fix };

/** ステータス重みの総和の正本値 = 1.0。 */
export const STAT_WEIGHT_SUM_FIX = FIX_ONE;

/**
 * 重み未指定の施設に使う中立既定値(5 種を等分 = 各 0.2)。
 *
 * 0.2 は 1e6 スケールで厳密表現でき、`0.2 × 50 = 10` も厳密なので、
 * 中立ステータスとの組合せで総和がちょうど 50.0 になる(§1 の証明の要)。
 */
export const UNIFORM_STAT_WEIGHTS: StatWeights = {
  vigor: fixFromRaw(200_000),
  dexterity: fixFromRaw(200_000),
  intellect: fixFromRaw(200_000),
  fortitude: fixFromRaw(200_000),
  will: fixFromRaw(200_000),
};

// --- 3. trait 定義(content の内部表現) ------------------------------------

/**
 * trait の効果のうち **engine が生産式へ写せるもの**だけを持つ内部表現。
 * content の `trait.effects[]` からの写像は `schema/engineContent.ts` の責務で、
 * 写せない効果(健康・成文化速度など未実装システム向け)の扱いもそちら側に書いてある。
 */
export interface TraitDef {
  readonly id: EntityId;
  /** stat → 加算値(op="add")。未登録の stat は 0 として扱う。 */
  readonly statAddFixById: ReadonlyMap<ResidentStatId, Fix>;
  /** stat → 倍率(op="mul")。未登録の stat は 1.0 として扱う。 */
  readonly statMulFixById: ReadonlyMap<ResidentStatId, Fix>;
  /** GDD 11.1 の「trait 倍率」項(予約語 `yieldMul`)。効果が無ければ 1.0。 */
  readonly yieldMulFix: Fix;
  /**
   * [M7] 派生値(§5・`combatPower`)への加算効果。**省略時は効果なし**。
   * 基礎ステと別名前空間で持つ(GDD 7.1「基礎ステと同じ名前空間で扱わないこと」)。
   */
  readonly derivedAddFixById?: ReadonlyMap<ResidentDerivedStatId, Fix>;
  /** [M7] 派生値への倍率効果。**省略時は 1.0**。 */
  readonly derivedMulFixById?: ReadonlyMap<ResidentDerivedStatId, Fix>;
}

/** trait 倍率(生産式の項)の合成後クランプ下限(§3)。 */
export const TRAIT_YIELD_MUL_MIN_FIX = fixFromRaw(700_000);
/** trait 倍率(生産式の項)の合成後クランプ上限(§3)。 */
export const TRAIT_YIELD_MUL_MAX_FIX = fixFromRaw(1_500_000);
/** ステータス倍率の合成後クランプ下限 = 0.7(GDD 7.2「±30% 以内」・§3)。 */
export const TRAIT_STAT_MUL_MIN_FIX = fixFromRaw(700_000);
/** ステータス倍率の合成後クランプ上限 = 1.3(同上)。 */
export const TRAIT_STAT_MUL_MAX_FIX = fixFromRaw(1_300_000);

/** 効果を 1 つも持たない中立 trait(テスト・既定値用)。 */
export function neutralTraitDef(id: EntityId): TraitDef {
  return {
    id,
    statAddFixById: new Map(),
    statMulFixById: new Map(),
    yieldMulFix: FIX_ONE,
  };
}

/**
 * その trait が生産式に影響するか。1 つも影響しないなら合成をまるごと省ける
 * (`traitMemoryKeeper` のように想起困難側だけに効く trait が該当)。
 *
 * 派生値(§5)への効果は生産式に一切載らないので**ここでは見ない**
 * (見てしまうと「combatPower だけ動かす trait」が生産式の合成経路に入り、
 *  効かないはずの trait が floor 丸めの順序を変えてしまう)。
 */
export function affectsProduction(def: TraitDef): boolean {
  return (
    def.statAddFixById.size > 0 ||
    def.statMulFixById.size > 0 ||
    toRaw(def.yieldMulFix) !== toRaw(FIX_ONE)
  );
}

/**
 * [M7] その trait が派生値 combatPower(§5)に影響するか。
 *
 * 基礎ステータスへの効果も combatPower の重み付き和を通して効くので、
 * `statAdd` / `statMul` も対象に含める。逆に `yieldMul` は**生産式専用の項**
 * なので含めない(GDD 11.1 の「trait 倍率」は産出量に掛かる係数であって
 * 住民の強さではない)。
 */
export function affectsCombatPower(def: TraitDef): boolean {
  return (
    def.statAddFixById.size > 0 ||
    def.statMulFixById.size > 0 ||
    (def.derivedAddFixById?.size ?? 0) > 0 ||
    (def.derivedMulFixById?.size ?? 0) > 0
  );
}

/**
 * 住民の traitIds から trait 定義を引く(**content に無い ID は読み飛ばす**)。
 *
 * 読み飛ばしを許すのは、state 側の traitIds が content と独立に存在し得るため
 * (セーブに残った trait ID / conformance シナリオが content に無い trait を
 * 住民へ付ける等)。「content に載っているのに engine が写せない効果」を黙って
 * 捨てないための reject は**ローダー側**(`schema/engineContent.ts`)の責務であり、
 * ここでの読み飛ばしとは層が違う。
 *
 * 返す順序は traitIds の順(= state の不変条件により ID 昇順)。
 */
function resolveTraitDefsBy(
  traitIds: readonly EntityId[],
  traitDefs: ReadonlyMap<EntityId, TraitDef> | undefined,
  affects: (def: TraitDef) => boolean,
): readonly TraitDef[] {
  if (traitDefs === undefined || traitDefs.size === 0 || traitIds.length === 0) return [];
  const result: TraitDef[] = [];
  for (const traitId of traitIds) {
    const def = traitDefs.get(traitId);
    if (def !== undefined && affects(def)) result.push(def);
  }
  return result;
}

/** 生産式に効く trait だけを引く({@link resolveTraitDefsBy})。 */
export function resolveTraitDefs(
  traitIds: readonly EntityId[],
  traitDefs: ReadonlyMap<EntityId, TraitDef> | undefined,
): readonly TraitDef[] {
  return resolveTraitDefsBy(traitIds, traitDefs, affectsProduction);
}

/** [M7] 派生値 combatPower(§5)に効く trait だけを引く。 */
export function resolveCombatTraitDefs(
  traitIds: readonly EntityId[],
  traitDefs: ReadonlyMap<EntityId, TraitDef> | undefined,
): readonly TraitDef[] {
  return resolveTraitDefsBy(traitIds, traitDefs, affectsCombatPower);
}

// --- 4. 合成 ---------------------------------------------------------------

/**
 * 1 ステータスぶんの trait 適用: `clamp(0, (base + Σadd) × clamp(Πmul), 100)`。
 *
 * 値域証明(mulFixProven の根拠・§4):
 *   - `base + Σadd`: base は 0〜100(呼び出し側でクランプ済み)、Σadd は
 *     schema/trait.ts の ADD_VALUE_RANGE(±30)× MAX_EFFECTS(6)× maxPerResident(3)
 *     = ±540 が上界。よって |base + Σadd| <= 640 → |raw| <= 6.4e8。
 *   - `Πmul`: 直前に [0.7, 1.3] へクランプしてあるので |raw| <= 1.3e6。
 *   - 中間積 <= 6.4e8 × 1.3e6 = 8.32e14 < 9007199254740991 = 2^53-1。**証明成立**。
 *   (合成中の Πmul 自身の中間積は 1.3e6 × 1.5e6 = 1.95e12 で自明に収まる。
 *    1.5e6 は schema の MUL_VALUE_RANGE 上限。)
 */
function applyTraitsToStat(
  statId: ResidentStatId,
  rawBaseFix: Fix,
  traits: readonly TraitDef[],
): Fix {
  let addSum = FIX_ZERO;
  let mulProduct = FIX_ONE;
  for (const trait of traits) {
    const add = trait.statAddFixById.get(statId);
    if (add !== undefined) addSum = addFix(addSum, add);
    const mul = trait.statMulFixById.get(statId);
    // 1 効果あたりの倍率は schema で [0.7, 1.5]。中間積 <= 1.3e6 × 1.5e6 = 1.95e12。
    if (mul !== undefined) mulProduct = mulFixProven(mulProduct, mul);
    // 都度クランプすることで Πmul の上界を常に 1.3e6 に保つ(上の証明の前提)。
    mulProduct = clampFix(mulProduct, TRAIT_STAT_MUL_MIN_FIX, TRAIT_STAT_MUL_MAX_FIX);
  }
  return composeStatEffect(rawBaseFix, addSum, mulProduct);
}

/**
 * `clamp(0, (clamp(0, base, 100) + Σadd) × Πmul, 100)` の共通部分。
 * {@link applyTraitsToStat} と {@link applyTraitsToDerived} が同じ丸め順序を
 * 使うための単一実装(片方だけ順序が変わると同じ trait が場所によって違う値を
 * 出す)。
 *
 * 値域証明(呼び出し側が満たすべき前提つき):
 *   - `rawBaseFix` は入口でクランプするので 0〜100 → |raw| <= 1e8。
 *   - `addSum` は |Σadd| <= 540(§4)→ |base + Σadd| <= 640 → |raw| <= 6.4e8。
 *   - `mulProduct` は呼び出し側が [0.7, 1.3] へクランプ済み → |raw| <= 1.3e6。
 *   - 中間積 <= 6.4e8 × 1.3e6 = 8.32e14 < 9007199254740991 = 2^53-1。**証明成立**。
 */
function composeStatEffect(rawBaseFix: Fix, addSum: Fix, mulProduct: Fix): Fix {
  // 証明の前提「base は 0〜100」を入口で成立させる(値域外のセーブ由来値でも
  // mulFixProven が破れないように)。
  const baseFix = clampFix(rawBaseFix, STAT_MIN_FIX, STAT_MAX_FIX);
  const shifted = addFix(baseFix, addSum);
  const scaled = mulProduct === FIX_ONE ? shifted : mulFixProven(shifted, mulProduct);
  return clampFix(scaled, STAT_MIN_FIX, STAT_MAX_FIX);
}

/**
 * trait 適用後のステータス一式。走査順は {@link RESIDENT_STAT_IDS} の宣言順に
 * 相当する固定順序(明示的に 5 項を書き下しているので反復順に依存しない)。
 */
export function effectiveStats(base: ResidentStats, traits: readonly TraitDef[]): ResidentStats {
  if (traits.length === 0) {
    return {
      vigor: clampFix(base.vigor, STAT_MIN_FIX, STAT_MAX_FIX),
      dexterity: clampFix(base.dexterity, STAT_MIN_FIX, STAT_MAX_FIX),
      intellect: clampFix(base.intellect, STAT_MIN_FIX, STAT_MAX_FIX),
      fortitude: clampFix(base.fortitude, STAT_MIN_FIX, STAT_MAX_FIX),
      will: clampFix(base.will, STAT_MIN_FIX, STAT_MAX_FIX),
    };
  }
  return {
    vigor: applyTraitsToStat("vigor", base.vigor, traits),
    dexterity: applyTraitsToStat("dexterity", base.dexterity, traits),
    intellect: applyTraitsToStat("intellect", base.intellect, traits),
    fortitude: applyTraitsToStat("fortitude", base.fortitude, traits),
    will: applyTraitsToStat("will", base.will, traits),
  };
}

/**
 * GDD 11.1 の「trait 倍率」項。同種効果を総乗合成し、カテゴリ上限でクランプする
 * (§3)。
 *
 * 値域証明: 各 `yieldMulFix` は schema の MUL_VALUE_RANGE により |raw| <= 1.5e6、
 * 累積側は毎回 [0.7, 1.5] へクランプするので |raw| <= 1.5e6。
 * 中間積 <= 1.5e6 × 1.5e6 = 2.25e12 < 2^53-1。**証明成立**。
 */
export function traitYieldMultiplier(traits: readonly TraitDef[]): Fix {
  let product = FIX_ONE;
  for (const trait of traits) {
    if (toRaw(trait.yieldMulFix) === toRaw(FIX_ONE)) continue;
    product = clampFix(
      mulFixProven(product, trait.yieldMulFix),
      TRAIT_YIELD_MUL_MIN_FIX,
      TRAIT_YIELD_MUL_MAX_FIX,
    );
  }
  return product;
}

/**
 * 重み付きステータス寄与 `Σ(weight_s × stat_s)`。走査は
 * {@link RESIDENT_STAT_IDS} の宣言順(GDD 11.7 の安定順序)。
 *
 * 値域証明: weight は [0, 1](ローダーが総和 1 を強制)→ |raw| <= 1e6、
 * stat はクランプ済み 0〜100 → |raw| <= 1e8。
 * 中間積 <= 1e6 × 1e8 = 1e14 < 9007199254740991 = 2^53-1。**証明成立**。
 * (この上界の根拠は「ローダーの重み検証」と「effectiveStats のクランプ」の
 *  2 つ。どちらかを緩めるならここも mulFix へ戻すこと。)
 */
export function weightedStatSum(stats: ResidentStats, weights: StatWeights): Fix {
  let sum = FIX_ZERO;
  for (const statId of RESIDENT_STAT_IDS) {
    sum = addFix(sum, mulFixProven(weights[statId], stats[statId]));
  }
  return sum;
}

/**
 * 1 就労者あたりの生産寄与 = `(Σ重み付き実効ステータス / 50) × trait倍率`
 * (GDD 11.1 の第 4・第 5 項)。
 *
 * 評価順は **trait のステータス効果 →(重み付き総和 / 50)→ trait 倍率** で固定。
 * trait はステータスと倍率の両方に効き得る(§3(a)(b))ので、どちらの経路も
 * ここを 1 度だけ通る = 二重計上が構造的に起きない。
 *
 * **中立既定値では厳密に 1.0** になる(§1):
 *   Σ(0.2 × 50) = 5 × 10.0 = 50.0 → floorDiv(50.0, 50.0) = 1.0 → × 1.0 = 1.0
 * したがって Σ寄与 = 稼働就労者数 × 1.0 となり、縮約形と 1 bit も違わない。
 *
 * 値域証明(最後の乗算): Σ重み付きステータス <= 100(総和 1 の重み × 上限 100)
 * より statShare <= 2.0 → |raw| <= 2e6。trait 倍率はクランプ済みで |raw| <= 1.5e6。
 * 中間積 <= 2e6 × 1.5e6 = 3e12 < 2^53-1。**証明成立**。
 */
export function workerContribution(
  stats: ResidentStats,
  weights: StatWeights,
  traits: readonly TraitDef[],
): Fix {
  // effectiveStats を必ず通す(weightedStatSum の mulFixProven は
  // 「ステータスが 0〜100 にクランプ済み」を証明の前提にしている)。
  const effective = effectiveStats(stats, traits);
  const statShare = floorDivFix(weightedStatSum(effective, weights), STAT_BASELINE_FIX);
  const yieldMul = traitYieldMultiplier(traits);
  if (toRaw(yieldMul) === toRaw(FIX_ONE)) return statShare;
  return mulFixProven(statShare, yieldMul);
}

/**
 * 「中立既定値では 1 就労者の寄与がちょうど 1.0」という §1 の主張を、実際に
 * 計算して確かめた結果。定数として持つのではなく毎回計算しているので、
 * 丸め規約や既定値を変えると即座に false になる(テストが検出する)。
 */
export const NEUTRAL_CONTRIBUTION_IS_ONE: boolean =
  toRaw(workerContribution(NEUTRAL_RESIDENT_STATS, UNIFORM_STAT_WEIGHTS, [])) === toRaw(FIX_ONE);

// ===========================================================================
// 5. 派生値 combatPower(裁定 B8 / GDD 7.1 の注記 / GDD 8.2)— M7
// ===========================================================================
//   GDD 8.2 の判定式
//     成否 = (関連チーム総合力 + 装備補正 + seededRoll(0..R)) >= difficulty
//   に現れる「戦力」は基礎ステ 5 種ではなく**派生値**であり、英字 ID は
//   `combatPower`(裁定 B8)。GDD は「算出式は engine 実装時に確定する」として
//   式を未確定のまま残していたので、本モジュールが次の形で確定させる。
//
//     combatPower(住民) = clamp(0,
//         (Σ_s COMBAT_POWER_WEIGHTS[s] × 実効ステータス_s + Σ派生add)
//         × clamp(Π派生mul, 0.7, 1.3), 100)
//
//   設計上の要点は 4 つ:
//
//   (1) **装備は式に含めない。** GDD 8.2 の判定式は「関連チーム総合力 **+ 装備
//       補正**」と装備を*別項*で足している。combatPower 側にも装備を混ぜると
//       同じ装備が 2 度効く。よって combatPower は**住民の素の強さ**だけを表し、
//       装備補正は探索解決(M21)が判定式の別項として足す。GDD 8.2 の
//       「それらと装備から算出される派生値」という表現とは、
//       「装備込みの最終戦力 = combatPower + 装備補正」という分解で整合する。
//
//   (2) **基礎ステと同じ 0〜100 スケールに載せる。** 重みの総和を 1.0 に固定して
//       あるので、全ステ 50 の中立住民の combatPower はちょうど 50 になる
//       ({@link NEUTRAL_COMBAT_POWER_IS_BASELINE})。これにより
//       `event.nodes[].statWeights` に `combatPower` を基礎ステと並べて書いても
//       スケールが揃う(GDD 8.2「statWeights に combatPower を書く場合、
//       ローダーは基礎ステと別扱いで解決する」の「別扱い」= 名前空間だけの話に
//       なり、値の桁は揃う)。
//
//   (3) **trait は 2 段で効く。** まず基礎ステへの効果が {@link effectiveStats}
//       で入り(怪力の vigor +15 等)、次に派生値そのものへの効果
//       (`stat: "combatPower"`)が重み付き和の後に乗る。どちらの経路も 1 度だけ
//       通るので二重計上しない(生産式の `yieldMul` と同じ規律・§3)。
//       `yieldMul` は生産量に掛かる係数であって住民の強さではないため
//       combatPower には**効かない**。
//
//   (4) **重み配分は GDD に無い engine 定数**(→ 要ユーザー判断)。GDD 8.2 は
//       「遭遇 = 戦力」としか書いておらず内訳を定めていない。下記
//       {@link COMBAT_POWER_WEIGHTS} は「戦うのは体と胆力、器用さが次、
//       知性は戦闘に寄与しない」という GDD 7.1 の語感からの配分であり、
//       裁定 N2 / §3 のクランプ値と同じ理由で content 化しない
//       (変えると golden vector が動くため balance JSON から触らせない)。
// ---------------------------------------------------------------------------

/**
 * 派生ステータスの正本 ID(裁定 B8)。**基礎ステ 5 種とは別名前空間**であり
 * (GDD 7.1「基礎ステと同じ名前空間で扱わないこと」)、両者の ID が衝突していない
 * ことはテストで機械確認する。
 */
export const RESIDENT_DERIVED_STAT_IDS = ["combatPower"] as const;

/** 派生ステータスのいずれか。 */
export type ResidentDerivedStatId = (typeof RESIDENT_DERIVED_STAT_IDS)[number];

/** 未知の文字列が派生ステータスのいずれかか(型ガード)。 */
export function isResidentDerivedStatId(value: string): value is ResidentDerivedStatId {
  for (const derivedId of RESIDENT_DERIVED_STAT_IDS) {
    if (derivedId === value) return true;
  }
  return false;
}

/**
 * combatPower の基礎ステ配分(§5(4)・**GDD に無い engine 定数**)。
 *
 * 総和はちょうど 1.0 = {@link STAT_WEIGHT_SUM_FIX}(施設のステータス重みと同じ
 * 不変条件)。総和 1.0 が「中立住民の combatPower = 基準 50」の根拠であり、
 * ここを崩すと戦力のスケールだけが静かにずれる。
 *
 * 内訳: 体力 0.35 / 頑健 0.30 / 器用 0.20 / 意志 0.15 / 知性 0.00。
 */
export const COMBAT_POWER_WEIGHTS: StatWeights = {
  vigor: fixFromRaw(350_000),
  dexterity: fixFromRaw(200_000),
  intellect: FIX_ZERO,
  fortitude: fixFromRaw(300_000),
  will: fixFromRaw(150_000),
};

/**
 * 派生値 1 つぶんの trait 適用。合成規則・クランプ幅は基礎ステと同じ
 * ([0.7, 1.3]・GDD 7.2 [2026-07-28追補])— combatPower は「ステータス倍率」の
 * カテゴリに属する派生値であり、生産の `yieldMul`([0.7, 1.5])とは別カテゴリ。
 *
 * 値域証明: {@link composeStatEffect} の前提をここで満たす。
 *   - base = 重み付き和(総和 1.0 の重み × 0〜100)→ 0〜100。
 *   - Σadd は基礎ステと同じ上界(schema の ADD_VALUE_RANGE ±30 × 6 効果 ×
 *     3 trait = ±540)。
 *   - Πmul は毎周 [0.7, 1.3] へクランプ → |raw| <= 1.3e6。合成中の中間積は
 *     1.3e6 × 1.5e6 = 1.95e12 < 2^53-1。**証明成立**。
 */
function applyTraitsToDerived(
  derivedId: ResidentDerivedStatId,
  rawBaseFix: Fix,
  traits: readonly TraitDef[],
): Fix {
  let addSum = FIX_ZERO;
  let mulProduct = FIX_ONE;
  for (const trait of traits) {
    const add = trait.derivedAddFixById?.get(derivedId);
    if (add !== undefined) addSum = addFix(addSum, add);
    const mul = trait.derivedMulFixById?.get(derivedId);
    if (mul !== undefined) mulProduct = mulFixProven(mulProduct, mul);
    mulProduct = clampFix(mulProduct, TRAIT_STAT_MUL_MIN_FIX, TRAIT_STAT_MUL_MAX_FIX);
  }
  return composeStatEffect(rawBaseFix, addSum, mulProduct);
}

/**
 * 住民 1 人の戦力 `combatPower`(§5)。基礎ステと同じ 0〜100 スケール。
 *
 * 評価順は **trait のステータス効果 → 重み付き和 → trait の派生値効果** で固定
 * (順序を変えると floor 丸めの位置が変わる)。`traits` は
 * {@link resolveCombatTraitDefs} で引いたもの(= ID 昇順)を渡すこと。
 *
 * 値域証明(重み付き和): {@link weightedStatSum} と同一
 * (重み <= 1e6 × ステータス <= 1e8 = 1e14 < 2^53-1)。
 */
export function combatPowerFix(base: ResidentStats, traits: readonly TraitDef[]): Fix {
  const effective = effectiveStats(base, traits);
  const derived = weightedStatSum(effective, COMBAT_POWER_WEIGHTS);
  if (traits.length === 0) return derived;
  return applyTraitsToDerived("combatPower", derived, traits);
}

/**
 * GDD 8.2「関連チーム総合力」のうち戦力ぶん = チーム員の combatPower の総和。
 *
 * 整数加算なので加算順序に依存しない(それでも呼び出し側は ID 昇順で渡すこと。
 * GDD 11.7 の安定順序を破ると、将来ここに順序依存の項を足したときに静かに壊れる)。
 * 装備補正・seededRoll・difficulty との比較は探索解決(M21)の担当であり、
 * ここは「素の戦力の集計」までで止める(§5(1))。
 *
 * 値域: 1 人あたり <= 100、チームは GDD 8.1 で 1〜4 名なので <= 400。
 * 上限そのものの強制は派遣コマンド(M21)の責務。
 */
export function teamCombatPowerFix(memberPowers: readonly Fix[]): Fix {
  let total = FIX_ZERO;
  for (const power of memberPowers) {
    total = addFix(total, power);
  }
  return total;
}

/**
 * 「中立既定値(全ステ 50)の住民の combatPower はちょうど基準 50」という
 * §5(2) の主張を実際に計算して確かめた結果。{@link NEUTRAL_CONTRIBUTION_IS_ONE}
 * と同じく、重み配分や丸め規約を変えると即座に false になる。
 */
export const NEUTRAL_COMBAT_POWER_IS_BASELINE: boolean =
  toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, [])) === toRaw(STAT_BASELINE_FIX);
