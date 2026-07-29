// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 住民寿命モデル — GDD 7.5 / 7.7 / 11.4-4 / ADR-006 / ADR-018(1)
//
// ===========================================================================
// 1. 分布の表し方(exp / log を 1 度も通さずに対数正規を実装する)
// ===========================================================================
//   GDD 7.5 は寿命を「seed 駆動の**離散**対数正規近似(平均 = 432,000 tick =
//   約300日、σ = 平均の 0.25)」と定める。対数正規の逆 CDF は
//   `exp(σ Φ⁻¹(p) − σ²/2)` であり `exp` を要するが、ADR-006 の Math 許可リストは
//   `exp` / `log` / 非整数べき乗を **禁止**(ECMA-262 が implementation-approximated
//   と定めるためエンジン間で bit が一致しない)。
//
//   本モジュールは GDD 11.7 の既定路線をそのまま分布へ適用して回避する:
//
//     「非整数べき乗は実行時計算を一切禁止し、オーサリング時に固定小数点値を
//       事前計算し JSON へ個別値として書き出す」(GDD 11.7 / ADR-006)
//
//   すなわち **逆 CDF を等確率 N 分位で展開したテーブルを content に置き**
//   (`balance.json` の `townParams.lifespanQuantileMul`)、実行時は
//
//     draw(uint32) ──整数除算──▶ 分位の添字 i ──表引き──▶ 倍率 m_i
//     lifespanTick = floor(平均寿命 × m_i)
//
//   だけを行う。**乗算と floor 除算しか現れない**ので ADR-006 に完全に収まる。
//   これは「対数正規に似た別の分布で代用した」のではなく「対数正規を N 個の
//   等確率原子へ離散化したもの」であり、GDD の 離散…近似 という語と一致する。
//
//   テーブルが本当に対数正規かどうかは content ローダー
//   (`schema/engineContent.ts` の `validateLifespanQuantileTable`)が
//   **整数演算だけで**平均 ≒ 1.0 と 変動係数 ≒ `lifespanSigma` を検証する。
//   engine 側はテーブルを信頼して引くだけであり、分布の妥当性の番人は
//   人間専用(CODEOWNERS)の schema 層にある。
//
// ===========================================================================
// 2. ADR-018 の段階との関係(段階2 へ踏み込まないことの根拠)
// ===========================================================================
//   ADR-018(2) がテスト依存の安全網になると警告しているのは
//   **「他の確率系の状態変化がどのクロックの再サンプリングを要求するか」の
//   依存カスケード**である。寿命は
//     - 住民 1 人につき生涯 1 回だけ引く
//     - salt が residentId のみ(他の確率系の状態を一切参照しない)
//     - 引いた結果は `life.lifespanTick` として state に固定され、以後
//       再サンプリングされない
//   ので依存カスケードを持たない。したがって逆 CDF を使ってはいるが
//   ADR-018 の**段階1(独立系)**の範囲であり、段階2 の next-reaction 機構
//   (recallRisk の moraleW/dispatchW が動くたびクロックを引き直す類)には
//   踏み込んでいない。想起困難(rules/recall.ts)の per-step 全再評価は
//   従来どおり段階1 のまま無変更である。
//
// ===========================================================================
// 3. 「唯一保持者残存想定tick」(GDD 11.4-4)の機械算出
// ===========================================================================
//   GDD 11.4-4 の sim assert
//     「唯一保持者残存想定tick ≥ 成文化所要tick × 1.5」
//   の左辺を出すのが {@link remainingLifeTicks} であり、**GameState も content も
//   要らない純関数**である({@link ResidentLife} と評価 tick だけを取る)。
//   記憶巧者の `memoryDecayDelay = 1.5`(GDD 7.5)と安全係数(GDD 11.3)を
//   込みで判定するのが {@link codifyDeadlineMarginTicks} / {@link meetsCodifyDeadline}。
//   sim / bot / UI はこの 3 本だけを使い、寿命の内部表現に触らないこと。
// ---------------------------------------------------------------------------

import { FIX_ONE, FIX_SCALE, floorDivInt, mulFixInt, subFix, toRaw, type Fix } from "../fp";
import { DOMAIN_TAGS } from "../rng/domainTags";
import type { EntityId, ResidentLife, ResidentState } from "../state/state";
import { hashedDrawUint32, saltFromId, uniformIntFromDraw } from "../stochastic";
import { RulesError, type TownParams } from "./types";

// --- 1. 生涯の純関数(§3) --------------------------------------------------

/** 死亡する tick(= `bornTick + lifespanTick`)。 */
export function deathTickOf(life: ResidentLife): number {
  return life.bornTick + life.lifespanTick;
}

/** 評価 tick における年齢(= `t − bornTick`)。 */
export function ageTicksAt(life: ResidentLife, atTick: number): number {
  return atTick - life.bornTick;
}

/**
 * **GDD 11.4-4 の「残存想定tick」**(= `lifespanTick − ageTick` = `deathTick − t`)。
 *
 * 寿命モデルの純関数であり、GameState も content も RNG も参照しない。負値は
 * 「既に寿命を過ぎている」を意味する(人口下限の保持で死亡が延期されている
 * 住民・rules/population.ts §3 はこの状態を取り得る)ので **0 でクランプしない**。
 */
export function remainingLifeTicks(life: ResidentLife, atTick: number): number {
  return deathTickOf(life) - atTick;
}

/**
 * 住民の残存想定tick。寿命を持たない住民(`life` 省略)は **null**
 * (= 「寿命という概念が付いていない」を「余命 0」と混同させないため)。
 * 既に死亡している住民は死亡 tick 基準ではなく寿命基準の値をそのまま返す。
 */
export function remainingLifeTicksOfResident(
  resident: ResidentState,
  atTick: number,
): number | null {
  return resident.life === undefined ? null : remainingLifeTicks(resident.life, atTick);
}

/** {@link codifyDeadlineMarginTicks} の入力(GDD 11.4-4 の不等式の全項)。 */
export interface CodifyDeadlineInput {
  /** 対象住民の生涯。 */
  readonly life: ResidentLife;
  /** 判定する tick。 */
  readonly atTick: number;
  /**
   * 成文化所要 tick。GDD 11.1 [2026-07-27追補] より **石板(遅い方)の値で
   * 評価する**(保守側)。算出は rules/codify.ts。
   */
  readonly requiredCodifyTicks: number;
  /** GDD 11.3 の安全係数(1.5 に統一)。 */
  readonly safetyFactorFix: Fix;
  /**
   * GDD 7.5 の `memoryDecayDelay`。記憶巧者 trait を持つ住民は 1.5、
   * それ以外は {@link FIX_ONE}。判定側で trait を解決してから渡す
   * (寿命モデルに trait レジストリを持ち込まないため)。
   */
  readonly memoryDecayDelayFix: Fix;
}

/**
 * GDD 11.4-4 の余裕 tick
 * = `残存想定tick × memoryDecayDelay − 成文化所要tick × 安全係数`。
 *
 * 0 以上なら assert が通る。floor 方向へ丸める(安全側 = 余裕を過大評価しない)。
 */
export function codifyDeadlineMarginTicks(input: CodifyDeadlineInput): number {
  return floorDivInt(toRaw(codifyDeadlineMarginFix(input)), FIX_SCALE);
}

/** {@link codifyDeadlineMarginTicks} の Fix 版(丸める前の値)。 */
export function codifyDeadlineMarginFix(input: CodifyDeadlineInput): Fix {
  const remaining = remainingLifeTicks(input.life, input.atTick);
  const grace = mulFixInt(input.memoryDecayDelayFix, remaining);
  const required = mulFixInt(input.safetyFactorFix, input.requiredCodifyTicks);
  return subFix(grace, required);
}

/** GDD 11.4-4 の assert そのもの(余裕が 0 以上か)。 */
export function meetsCodifyDeadline(input: CodifyDeadlineInput): boolean {
  return toRaw(codifyDeadlineMarginFix(input)) >= 0;
}

// --- 2. 抽選(§1) ---------------------------------------------------------

/**
 * 寿命 `lifespanTick` を引く(§1)。同じ (worldSeed, residentId) なら常に同じ値で
 * あり、**住民の生成順に依存しない**(hash アドレス方式・stochastic.ts §2(a))。
 *
 * 戻り値は 1 以上の整数 tick(テーブル最小倍率でも 0 tick にならないよう下限 1)。
 *
 * @throws {RulesError} 分位テーブルが空 / 添字が引けない場合
 * @throws {StochasticError} テーブル長が {@link UNIFORM_SPAN_MAX} を超える場合
 */
export function rollLifespanTicks(
  worldSeedU32: number,
  residentId: EntityId,
  town: TownParams,
): number {
  const table = town.lifespanQuantileMulFix;
  if (table.length === 0) {
    throw new RulesError(
      "townParams.lifespanQuantileMul が空(寿命の逆 CDF テーブルが無い・rules/lifespan.ts §1)",
    );
  }
  const draw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.lifespan, [saltFromId(residentId)]);
  const index = uniformIntFromDraw(draw, 0, table.length - 1);
  const multiplier = table[index];
  if (multiplier === undefined) {
    throw new RulesError(
      `lifespan 分位テーブルの添字 ${String(index)} が引けない(長さ ${String(table.length)}・実装バグ)`,
    );
  }
  // 平均寿命(整数 tick)× 倍率(Fix)→ floor で整数 tick へ落とす。
  // 中間積は raw(<= 数百万)× tick(<= 数百万)= 1e13 オーダーで安全整数内。
  const ticks = floorDivInt(toRaw(mulFixInt(multiplier, town.lifespanMeanTicks)), FIX_SCALE);
  return ticks < 1 ? 1 : ticks;
}

/**
 * 加入時点の年齢(tick)を引く。晴天漂着(GDD 7.7)は「流れ着いた生存者」であって
 * 新生児ではないので、加入時に既に年齢を持つ。一様分布
 * `[joinAgeMinTicks, joinAgeMaxTicks]`(両端含む)。
 *
 * 寿命とは**別ドメイン**(`joinAge`)から引く = 年齢と寿命が相関しない
 * (同じストリームを共有すると「長寿の者ほど若く着く」等の隠れた相関が出る)。
 */
export function rollJoinAgeTicks(
  worldSeedU32: number,
  residentId: EntityId,
  town: TownParams,
): number {
  const draw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.joinAge, [saltFromId(residentId)]);
  return uniformIntFromDraw(draw, town.joinAgeMinTicks, town.joinAgeMaxTicks);
}

/**
 * 加入する住民 1 人の生涯を決定論生成する(GDD 7.7「人物・寿命は seed 決定論生成」)。
 * 新規ゲームの初期住民も晴天漂着も探索での保護も、この 1 本を通すこと。
 *
 * 年齢が寿命以上になった場合は `lifespanTick − 1` で頭打ちにする。加入した
 * その tick に死ぬ住民は「加入」になっておらず、人口下限の議論(GDD 7.6)も
 * 成り立たなくなるため、**必ず 1 tick 以上生きる**ことを構造で保証する。
 */
export function createResidentLife(
  worldSeedU32: number,
  residentId: EntityId,
  joinTick: number,
  town: TownParams,
): ResidentLife {
  const lifespanTick = rollLifespanTicks(worldSeedU32, residentId, town);
  const rawAge = rollJoinAgeTicks(worldSeedU32, residentId, town);
  const age = rawAge >= lifespanTick ? lifespanTick - 1 : rawAge;
  return { bornTick: joinTick - age, lifespanTick, diedTick: null };
}

/** 記憶巧者かどうかから `memoryDecayDelay`(GDD 7.5)を選ぶ小さな橋渡し。 */
export function memoryDecayDelayFor(town: TownParams, isMemoryKeeper: boolean): Fix {
  return isMemoryKeeper ? town.memoryDecayDelayFix : FIX_ONE;
}
