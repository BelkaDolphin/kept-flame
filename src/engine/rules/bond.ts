// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 絆(bond)— GDD 7.3 / M12
//
// ===========================================================================
// 1. 位置づけ(GDD 7.3「絆(bond)」)
// ===========================================================================
//   「同一施設で共働した住民ペアに bond 値が決定論蓄積し、士気補正＋と士気回復
//   ＋を生む。相方の喪失で bond 相手に一時的士気ペナ」を実装する。M6(成文化)・
//   M11(寿命)と同じく **tick ループへは結線しない**(scheduler.ts 無改変の
//   タスク指示・並行 M49 との衝突回避)。ここでは
//     computeBondRates(state, tick)     ↔ computeProductionRates(rules/production.ts)
//     applyBondProgress(rates, Δtick)   ↔ applyProduction
//   という (A) 区間の閉形式パターンを production.ts とそろえてあるので、
//   結線側(将来タスク)は新しい概念を持ち込まずに済む。
//
// ===========================================================================
// 2. 保存形式は GameState 直下の Map(state.ts の bondByPairKey 参照)
// ===========================================================================
//   独立 entity(`kind: "bond"`)にする案も検討したが、`EntityKind`/
//   `EntityState` へ新種別を足すと `src/ui/derived.ts` 等の既存の網羅 switch
//   (`default: never`)が壊れることが typecheck で判明した(UI はこのタスクの
//   担当外)。そこで rngState と同型の `GameState.bondByPairKey`
//   (`ReadonlyMap<string, Fix>`)として持つ。キーは {@link bondPairKeyOf} で
//   2 者の ID を辞書順正規化してから合成するので、どちらを先に渡しても同じ
//   キーになる。state/update.ts への追加は `setBondValue`/`createGameState` の
//   4 番目の引数のみ(rngState の実装をそのまま踏襲)。
//
// ===========================================================================
// 3. 決定論(検収条件「Map 反復順依存が無いこと」への回答)
// ===========================================================================
//   {@link computeBondRates} は施設ごとの `workerIds`(state.ts の不変条件により
//   ID 昇順)を走査するだけで、内部で使う一時 Map はペアの**集約**(同じペアの
//   寄与を合算する)にしか使わず、**返す配列は最後に pairKey の UTF-16 昇順へ
//   明示ソートしてから返す**(Map の反復順・挿入順を一切外へ漏らさない)。
//   {@link applyBondProgress} もそのソート済み配列を辿るだけなので、
//   処理順は常に pairKey 昇順で再現可能。{@link bondPartnersOf} も
//   `state.bondByPairKey` を明示的に `bondPairKeys`(昇順)で辿ってから
//   partnerId で明示ソートし直す(2 段とも Map の内部順に依存しない)。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import {
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromInt,
  fixFromRaw,
  floorDivInt,
  mulFix,
  mulFixInt,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import { GAME_DAY_TICKS } from "../stochastic";
import {
  bondPairKeys,
  entitiesOfKind,
  getBondValue,
  requireEntity,
  type EntityId,
  type GameState,
} from "../state/state";
import { setBondValue, setField, updateEntity } from "../state/update";
import { appendMemoirEntry } from "./memoir";
import { isWorkerActive } from "./production";
import { RulesError } from "./types";

// --- 1. 定数(GDD に明示の無い engine 定数・要ユーザー判断) -----------------

/** bond 値の上限(人間単位)。**GDD に明示が無い engine 定数**(要ユーザー判断)。 */
export const BOND_MAX_FIX: Fix = fixFromInt(100);

/**
 * 共働 1 tick あたりの bond 蓄積率(人間単位/tick)。GDD 7.3 は「決定論蓄積」
 * としか書いておらず速度は明示が無い(要ユーザー判断)。「1 日(1440 tick)あたり
 * 1.0」に相当する値を、production.ts のレート(1 tick あたり Fix を
 * `mulFixInt(rate, Δtick)` で区間積分する)と同じ形にするため、**事前に 1 回だけ
 * floor 除算**して求める(stochastic.ts の `perCoarseStepProbability` と同じ
 * 「掛けてから 1 回だけ floor 除算」の作法。ここは乗算対象が定数 1 のみなので
 * 実質 `floorDivInt(FIX_SCALE, GAME_DAY_TICKS)`)。
 */
export const BOND_GAIN_PER_COWORK_TICK_FIX: Fix = fixFromRaw(
  floorDivInt(FIX_SCALE, GAME_DAY_TICKS),
);

/** 節目の絆値(昇順・人間単位)。**GDD に明示が無い engine 定数**(要ユーザー判断)。 */
export const BOND_MILESTONE_TIER_FIXES: readonly Fix[] = [
  fixFromInt(10),
  fixFromInt(25),
  fixFromInt(50),
];

/**
 * 相方喪失の士気ペナ = 蓄積 bond 値 × この比率(GDD 7.3「一時的士気ペナ」)。
 * **比率は GDD に明示が無い engine 定数**(要ユーザー判断)。
 */
export const PARTNER_LOSS_MORALE_PENALTY_RATIO_FIX: Fix = fixFromRaw(500_000); // 0.5

// --- 2. ペアキーとクエリ(state.ts の bondByPairKey 参照) ------------------

/**
 * 住民ペアの bond ペアキーを決定論導出する(state.ts の GameState.bondByPairKey
 * 参照)。2 者の ID を UTF-16 昇順に正規化してから合成するので、どちらを先に
 * 渡しても同じキーになる。
 *
 * @throws {RulesError} 同一 ID を渡した場合(自分自身とは bond を結ばない)
 */
export function bondPairKeyOf(residentAId: EntityId, residentBId: EntityId): string {
  if (residentAId === residentBId) {
    throw new RulesError(`bondPairKeyOf: 同一 ID "${residentAId}" どうしの bond は定義されない`);
  }
  return compareUtf16(residentAId, residentBId) < 0
    ? `${residentAId}|${residentBId}`
    : `${residentBId}|${residentAId}`;
}

/** 住民ペアの現在の bond 値(未形成なら 0)。 */
export function bondValueOf(state: GameState, residentAId: EntityId, residentBId: EntityId): Fix {
  return getBondValue(state, bondPairKeyOf(residentAId, residentBId)) ?? FIX_ZERO;
}

/**
 * ある住民が結んでいる全 bond(partnerId 昇順)。GDD 7.3 の「記憶の可視化」
 * (誰との絆を持っているか)と、喪失時の士気ペナ適用
 * ({@link applyPartnerLossEffects})の両方が使う(§3 のソート規律を参照)。
 */
export function bondPartnersOf(
  state: GameState,
  residentId: EntityId,
): readonly { readonly partnerId: EntityId; readonly valueFix: Fix }[] {
  const result: { partnerId: EntityId; valueFix: Fix }[] = [];
  for (const pairKey of bondPairKeys(state)) {
    const [a, b] = pairKey.split("|");
    if (a === undefined || b === undefined) continue;
    let partnerId: string | undefined;
    if (a === residentId) partnerId = b;
    else if (b === residentId) partnerId = a;
    if (partnerId === undefined) continue;
    const value = getBondValue(state, pairKey);
    if (value === undefined) continue;
    result.push({ partnerId: partnerId as EntityId, valueFix: value });
  }
  return result.sort((x, y) => compareUtf16(x.partnerId, y.partnerId));
}

// --- 3. (A) 区間の閉形式(production.ts と同型・§1) ------------------------

/** 1 ペアぶんの bond 蓄積レート。 */
export interface BondRateEntry {
  readonly residentAId: EntityId;
  readonly residentBId: EntityId;
  readonly gainPerTickFix: Fix;
}

/** {@link computeBondRates} の結果。`entries` は pairKey 昇順(§3)。 */
export interface BondRates {
  readonly entries: readonly BondRateEntry[];
}

/**
 * 現在の state から 1 tick あたりの bond 蓄積レートを計算する
 * ((A) 区間の入口・production.ts の `computeProductionRates` と同型)。
 *
 * 稼働の定義は production.ts の {@link isWorkerActive} をそのまま使う
 * (探索派遣中・想起困難中は共働とみなさない)。1 施設に 3 人以上いれば
 * 全ペア(組合せ)が対象。
 */
export function computeBondRates(state: GameState, tick: number): BondRates {
  const byPairKey = new Map<string, BondRateEntry>();

  for (const facility of entitiesOfKind(state, "facility")) {
    const active: EntityId[] = [];
    for (const workerId of facility.workerIds) {
      if (isWorkerActive(requireEntity(state, workerId, "resident"), tick)) active.push(workerId);
    }
    // workerIds は ID 昇順(state.ts の不変条件)なので、filter 後も昇順のまま
    // = 以下の i<j ペア列挙は常に a<b で回る。
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        if (a === undefined || b === undefined) continue;
        const pairKey = bondPairKeyOf(a, b);
        const existing = byPairKey.get(pairKey);
        const gain =
          existing === undefined
            ? BOND_GAIN_PER_COWORK_TICK_FIX
            : addFix(existing.gainPerTickFix, BOND_GAIN_PER_COWORK_TICK_FIX);
        byPairKey.set(pairKey, { residentAId: a, residentBId: b, gainPerTickFix: gain });
      }
    }
  }

  // Map の挿入順(= 施設の走査順)を外へ漏らさないよう、pairKey の UTF-16 昇順へ
  // 明示ソートしてから返す(§3)。
  const entries = [...byPairKey.entries()]
    .sort((x, y) => compareUtf16(x[0], y[0]))
    .map(([, entry]) => entry);
  return { entries };
}

/**
 * `before` → `after` の間に新たに超えた節目のうち**最高位**を返す(複数またぎは
 * 最高位 1 件だけを記録し、1 度の区間で bondMilestone が段階分だけ増殖しない
 * ようにする)。超えていなければ null。tier は 1 始まり。
 */
function highestTierCrossed(before: Fix, after: Fix): number | null {
  let crossed: number | null = null;
  for (let i = 0; i < BOND_MILESTONE_TIER_FIXES.length; i++) {
    const threshold = BOND_MILESTONE_TIER_FIXES[i];
    if (threshold === undefined) continue;
    if (toRaw(before) < toRaw(threshold) && toRaw(after) >= toRaw(threshold)) {
      crossed = i + 1;
    }
  }
  return crossed;
}

/**
 * (A) 区間ぶんの bond 蓄積を一括適用する(production.ts の `applyProduction` と
 * 同型)。上限({@link BOND_MAX_FIX})でクランプし、節目
 * ({@link BOND_MILESTONE_TIER_FIXES})を新たに超えたペアには両者の memoirLog へ
 * `bondMilestone` エントリを追記する(GDD 7.3「記憶の可視化」の材料)。
 *
 * `atTick` はエントリのタイムスタンプに使う絶対 tick(呼び出し側が
 * production.ts と同じ「区間の終端(boundary)」を渡すことを想定)。
 *
 * 決定論: {@link BondRates.entries} は既に pairKey 昇順(§3)なので、この関数は
 * 受け取った順にそのまま処理するだけでよい(再ソートしない)。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない場合
 */
export function applyBondProgress(
  state: GameState,
  rates: BondRates,
  deltaTicks: number,
  atTick: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyBondProgress: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  let next = state;
  for (const rateEntry of rates.entries) {
    if (toRaw(rateEntry.gainPerTickFix) === 0) continue;
    const gain = mulFixInt(rateEntry.gainPerTickFix, deltaTicks);
    const before = bondValueOf(next, rateEntry.residentAId, rateEntry.residentBId);
    const after = clampFix(addFix(before, gain), FIX_ZERO, BOND_MAX_FIX);
    if (toRaw(after) === toRaw(before)) continue;

    next = setBondValue(next, bondPairKeyOf(rateEntry.residentAId, rateEntry.residentBId), after);

    const crossedTier = highestTierCrossed(before, after);
    if (crossedTier !== null) {
      next = appendMemoirEntry(next, rateEntry.residentAId, {
        kind: "bondMilestone",
        tick: atTick,
        partnerId: rateEntry.residentBId,
        tier: crossedTier,
      });
      next = appendMemoirEntry(next, rateEntry.residentBId, {
        kind: "bondMilestone",
        tick: atTick,
        partnerId: rateEntry.residentAId,
        tier: crossedTier,
      });
    }
  }
  return next;
}

// --- 4. 相方の喪失(GDD 7.3「相方の喪失で bond 相手に一時的士気ペナ」) ------

/** bond 値に応じた一時的士気ペナ(§1 の定数)。 */
export function moralePenaltyOnPartnerLoss(bondValueFix: Fix): Fix {
  return mulFix(bondValueFix, PARTNER_LOSS_MORALE_PENALTY_RATIO_FIX);
}

/**
 * 住民 `deceasedId` の死亡に伴う bond 側の効果を適用する: 結んでいた全相方
 * (partnerId 昇順・{@link bondPartnersOf})の memoirLog へ `partnerLost` を
 * 追記し、蓄積 bond 値に応じた一時的士気ペナ({@link moralePenaltyOnPartnerLoss}）
 * を科す(士気は 0 未満にならない・GDD 7.1「0〜100・上限厳守」と同じクランプ)。
 *
 * bond 値が 0(実質未形成)の相方は対象外。呼び出し側(rules/population.ts の
 * `applyResidentDeath` 相当)は本人の tombstone 化・
 * `rules/memoir.ts` の `recordDeathMemoir` と併せて呼ぶこと
 * (本関数は死亡そのものを扱わない)。
 */
export function applyPartnerLossEffects(
  state: GameState,
  deceasedId: EntityId,
  tick: number,
): GameState {
  let next = state;
  for (const partner of bondPartnersOf(state, deceasedId)) {
    if (toRaw(partner.valueFix) <= 0) continue;
    next = appendMemoirEntry(next, partner.partnerId, {
      kind: "partnerLost",
      tick,
      partnerId: deceasedId,
    });
    const penalty = moralePenaltyOnPartnerLoss(partner.valueFix);
    next = updateEntity(next, partner.partnerId, "resident", (r) =>
      setField(r, "morale", clampFix(subFix(r.morale, penalty), FIX_ZERO, fixFromInt(100))),
    );
  }
  return next;
}
