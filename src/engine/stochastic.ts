// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 確率系 段階1(粗粒度ベルヌーイ) — ADR-009 / ADR-018(1) / GDD 11.8(C)
//
// ===========================================================================
// 1. 段階1 だけを実装する(段階2 は作らない)
// ===========================================================================
//   ADR-018(1) は「MVP 段階1(粗粒度 per-step 全再評価)は依存グラフ列挙が
//   原理的に不要 = 構造的に見落とし不能であり、これを恒久のグラウンドトゥルース・
//   オラクルとして保持する」と定めている。本モジュールはその段階1 だけを持つ:
//
//     粗粒度ステップ(既定 10 分 = balance.coarseTickMinutes)ごとに、
//     対象の全ペアについて発生確率を**毎回ゼロから再計算**し、
//     ベルヌーイ試行を 1 回引く。
//
//   段階2(next-reaction + fpLog + カスケードレジストリ)は**意図的に存在しない**。
//   ADR-018(2) の通り段階2 の依存カスケード正当性はテスト依存の安全網であり、
//   ADR-018(3) が「段階2 は MVP 後の追加投資」と位置づけている。先行計測
//   (計画書 §2.1 P1「段階1のみ」)でも段階2 は作らないと明記されている。
//   段階2 を足すときは、この段階1 実装を差分オラクルとして残したまま並走させる。
//
// ===========================================================================
// 2. 2 つの引き方(hash アドレス方式 / 逐次ストリーム方式)
// ===========================================================================
//   (a) {@link hashedDrawUint32} — `hash(worldSeed, domainTag, salt...)` から
//       毎回 seed を作って xoshiro128** を 1 ステップ回す。**順序非依存**で
//       状態を持たない。段階1 の per-step 全再評価はこちらを使う:
//       評価順を変えても・一部を飛ばしても各ペアの結果が変わらないので、
//       「per-step 全再評価が構造的に見落とし不能」という ADR-018(1) の主張が
//       ストリーム位置のズレで崩れることがない。ADR-007 が生成器を
//       xoshiro128** に固定しているため、hash 値をそのまま乱数として使わず
//       必ず生成器を 1 ステップ通す。
//
//   (b) {@link drawFromStream} — GameState.rngState の当該ドメインのストリームを
//       1 ステップ進める(セーブフォーマットの `rngState` そのもの・ADR-007)。
//       低頻度で順序が確定している抽選(想起困難の持続日数など)に使う。
//       同じ domainTag を (a) と (b) で共用しないこと(1 タグ = 1 確率系・
//       ADR-024(2))。どちらの方式かは rng/domainTags.ts に明記してある。
//
// ===========================================================================
// 3. 一様乱数の作り方(すべて整数演算・許可リスト内)
// ===========================================================================
//   uint32 の draw から確率/範囲へ落とす計算は「先に掛けて後で floor 除算」の
//   固定順序で行い、fp.ts の補題 L1/L2(中間積が 2^53 未満なら厳密、安全整数
//   どうしの Math.floor 除算は厳密)で誤差ゼロを保証する。各関数の doc に
//   中間積の上界を書いてある。倍精度の割り算で確率へ落とす実装(draw / 2^32 を
//   float で作る)は禁止 — 丸めがエンジン差を持ち込みうるため。
// ---------------------------------------------------------------------------

import { FIX_SCALE, floorDivInt, fixFromRaw, toRaw, type Fix } from "./fp";
import { fnv1a32, hashRngDomain } from "./rng/fnv1a32";
import type { DomainTag } from "./rng/domainTags";
import { seedXoshiro128, xoshiro128Next } from "./rng/xoshiro128";
import type { GameState } from "./state/state";
import { setRngState } from "./state/update";

/** 確率系の使い方の誤り(確率が [0,1] 外、レンジ幅が上限超過など)。 */
export class StochasticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StochasticError";
  }
}

/** 実装している確率系の段階(ADR-009/018)。段階2 は未実装。 */
export const STOCHASTIC_STAGE = 1;

/** 1 ゲーム日の tick 数(GDD 11.2 の recallRisk は 1 日あたりの確率)。 */
export const GAME_DAY_TICKS = 1440;

/** uint32 の全域幅 = 2^32。確率/範囲への写像の分母。 */
export const UINT32_SPAN = 4_294_967_296;

/**
 * {@link uniformIntFromDraw} / {@link uniformFixFromDraw} が受け付けるレンジ幅の
 * 上限 = floor((2^53-1) / (2^32-1))。
 *
 * 中間積 `draw * span` を厳密に保つための境界:
 *   (2^32-1) * 2_097_152 = 2^53 - 2^21 = 9_007_199_252_643_840 <= 2^53-1
 *   (2^32-1) * 2_097_153 は 2^53-1 を超える
 */
export const UNIFORM_SPAN_MAX = 2_097_152;

// --- 1. salt / seed の作り方 -----------------------------------------------

/**
 * worldSeed(文字列)を RNG の入力 uint32 へ落とす。
 *
 * `hashRngDomain` は worldSeed を uint32 で受けるので、文字列シードは必ず
 * ここを通す(呼び出し側で別の畳み込みを書くと同じ worldSeed が別ストリームに
 * なる)。実体は FNV-1a-32(ADR-007 のドメイン分離 hash と同じ関数)。
 */
export function worldSeedToUint32(worldSeed: string): number {
  return fnv1a32(worldSeed);
}

/**
 * ID 文字列を salt 要素(uint32)へ落とす。
 *
 * ADR-007 の salt は uint32 の列なので、entity ID / content ID を salt に混ぜる
 * ときはここを通す。32bit ゆえ理論上は ID 衝突(2 つの ID が同じ salt になる)が
 * あり得るが、衝突しても「その 2 者が同じ乱数列を共有する」だけで決定論は壊れず、
 * 現実の ID 数(高々数百)では確率が無視できる。
 */
export function saltFromId(id: string): number {
  return fnv1a32(id);
}

/**
 * hash アドレス方式の draw(§2(a))。`hash(worldSeed, domainTag, salt...)` から
 * seed 展開して xoshiro128** を 1 ステップ回した uint32 を返す。
 *
 * 同じ (worldSeed, domainTag, salt) なら常に同じ値。ストリーム状態を持たない。
 */
export function hashedDrawUint32(
  worldSeedU32: number,
  domainTag: DomainTag,
  salt: readonly number[],
): number {
  return xoshiro128Next(seedXoshiro128(hashRngDomain(worldSeedU32, domainTag, salt))).value;
}

/** {@link drawFromStream} の結果: 引いた値と、ストリームを進めた後の state。 */
export interface StreamDrawResult {
  readonly value: number;
  readonly state: GameState;
}

/**
 * 逐次ストリーム方式の draw(§2(b))。GameState.rngState の当該ドメインを
 * 1 ステップ進め、新しい state と一緒に返す。
 *
 * 当該ドメインの状態が無い場合は `hash(worldSeed, domainTag, [])` から seed を
 * 展開して開始する(遅延初期化 = セーブに rngState が無い状態から始めても
 * 結果は同じ・state.ts §4)。
 */
export function drawFromStream(state: GameState, domainTag: DomainTag): StreamDrawResult {
  const current = state.rngState.get(domainTag);
  const from =
    current ?? seedXoshiro128(hashRngDomain(worldSeedToUint32(state.worldSeed), domainTag, []));
  const drawn = xoshiro128Next(from);
  return { value: drawn.value, state: setRngState(state, domainTag, drawn.state) };
}

// --- 2. ベルヌーイ試行 -----------------------------------------------------

/**
 * ベルヌーイ試行。確率 `pFix`(Fix・0.0〜1.0)で true。
 *
 * `threshold = floor(p_raw * 2^32 / 1e6)` と比較する。中間積は
 * `1e6 * 2^32 = 4.295e15 < 2^53-1` なので厳密(L1)、除算も安全整数どうしなので
 * 厳密(L2)。p=0 なら threshold=0 で常に false、p=1 なら threshold=2^32 で
 * uint32 は必ずそれ未満なので常に true。
 *
 * @throws {StochasticError} p が [0, 1] の外(= 呼び出し側の clamp 漏れ)
 */
export function bernoulliHit(pFix: Fix, drawUint32: number): boolean {
  const p = toRaw(pFix);
  if (p < 0 || p > FIX_SCALE) {
    throw new StochasticError(
      `bernoulliHit: 確率 ${String(p)} が [0, ${String(FIX_SCALE)}](= 0.0〜1.0)の外`,
    );
  }
  return drawUint32 < floorDivInt(p * UINT32_SPAN, FIX_SCALE);
}

// --- 3. 一様分布 -----------------------------------------------------------

function requireSpan(span: number, what: string): void {
  if (!Number.isSafeInteger(span) || span < 1) {
    throw new StochasticError(`${what}: レンジ幅 ${String(span)} が 1 以上の整数でない`);
  }
  if (span > UNIFORM_SPAN_MAX) {
    throw new StochasticError(
      `${what}: レンジ幅 ${String(span)} が上限 ${String(UNIFORM_SPAN_MAX)} を超えている` +
        `(中間積 draw*span が 2^53 を超えて厳密でなくなる)`,
    );
  }
}

/**
 * 整数の一様分布 [minInclusive, maxInclusive]。
 * `min + floor(draw * span / 2^32)`(span = max - min + 1)。
 *
 * @throws {StochasticError} min > max、または span が {@link UNIFORM_SPAN_MAX} 超過
 */
export function uniformIntFromDraw(
  drawUint32: number,
  minInclusive: number,
  maxInclusive: number,
): number {
  const span = maxInclusive - minInclusive + 1;
  requireSpan(span, "uniformIntFromDraw");
  return minInclusive + floorDivInt(drawUint32 * span, UINT32_SPAN);
}

/**
 * Fix の一様分布 [loFix, hiFix](両端含む・raw 1 刻み)。
 * 隣接行列のシード揺らぎ(adjacency.ts §4)が使う。
 *
 * @throws {StochasticError} lo > hi、または raw のレンジ幅が上限超過
 */
export function uniformFixFromDraw(drawUint32: number, loFix: Fix, hiFix: Fix): Fix {
  const lo = toRaw(loFix);
  const span = toRaw(hiFix) - lo + 1;
  requireSpan(span, "uniformFixFromDraw");
  return fixFromRaw(lo + floorDivInt(drawUint32 * span, UINT32_SPAN));
}

// --- 4. 粗粒度ステップ -----------------------------------------------------

function requireCoarseTickMinutes(coarseTickMinutes: number): void {
  if (
    !Number.isSafeInteger(coarseTickMinutes) ||
    coarseTickMinutes < 1 ||
    coarseTickMinutes > GAME_DAY_TICKS
  ) {
    throw new StochasticError(
      `coarseTickMinutes ${String(coarseTickMinutes)} は 1〜${String(GAME_DAY_TICKS)} の整数` +
        `(1 = Fallback の 1 分 tick・ADR-014(3))`,
    );
  }
}

/**
 * 粗粒度ステップの通し番号 = floor(tick / coarseTickMinutes)。
 *
 * **tick の絶対グリッドに固定**してあることが重要で、これにより
 * 「どこで advance を区切っても踏むステップの集合が同じ」= オフライン復帰の
 * catch-up が分割不変になる(0→100 を 2 回に割っても結果が一致する)。
 * ステップ番号は RNG の salt に入るので、グリッドが state.tick 起点だと
 * 区切り方で乱数列が変わってしまう。
 */
export function coarseStepIndexOf(tick: number, coarseTickMinutes: number): number {
  requireCoarseTickMinutes(coarseTickMinutes);
  return floorDivInt(tick, coarseTickMinutes);
}

/** その tick が粗粒度ステップの境界か(= ステップが発火する tick か)。 */
export function isCoarseStepTick(tick: number, coarseTickMinutes: number): boolean {
  requireCoarseTickMinutes(coarseTickMinutes);
  return tick - coarseStepIndexOf(tick, coarseTickMinutes) * coarseTickMinutes === 0;
}

/** `tick` 以降(同 tick を含む)で最初の粗粒度ステップ境界の tick。 */
export function nextCoarseStepTickAtOrAfter(tick: number, coarseTickMinutes: number): number {
  const index = coarseStepIndexOf(tick, coarseTickMinutes);
  const floored = index * coarseTickMinutes;
  return floored === tick ? tick : floored + coarseTickMinutes;
}

/**
 * 1 日あたりの確率を 1 粗粒度ステップあたりの確率へ落とす。
 *
 * `p_step = p_day * coarseTickMinutes / 1440`(一様ハザードの線形按分)。
 *
 * 厳密には `1 - (1 - p_day)^(Δ/1440)` だが、非整数べき乗は ADR-006 の Math
 * 許可リストで**禁止**(implementation-approximated でエンジン間 bit 不一致)で
 * あり、オーサリング時の個別 FP 展開(GDD 11.7)もステップ確率のような動的な
 * 指数には使えない。よって線形按分を正準実装とする。p_day <= 0.35(GDD 11.2 の
 * p_max)かつ Δ/1440 <= 1/144 の範囲では両者の差は p_day^2 のオーダーで小さく、
 * 発生頻度が GDD 11.4-8 の「週1〜3回/住民」レンジに収まるかは先行計測 #5 で
 * 実測して判定する(合わなければ base_p 側の校正で吸収する)。
 *
 * 中間積は `p_day_raw(<=1e6) * coarseTickMinutes(<=1440) <= 1.44e9` で厳密(L1)。
 *
 * @throws {StochasticError} coarseTickMinutes が 1〜1440 の整数でない場合
 */
export function perCoarseStepProbability(pPerDayFix: Fix, coarseTickMinutes: number): Fix {
  requireCoarseTickMinutes(coarseTickMinutes);
  return fixFromRaw(floorDivInt(toRaw(pPerDayFix) * coarseTickMinutes, GAME_DAY_TICKS));
}
