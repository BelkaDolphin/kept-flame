// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 士気(morale)— GDD 4.2 / 7.2 / 7.3 / 11.2 / M72
//
// ===========================================================================
// 1. GDD のどこを実装しているか / GDD が書いていない点の最小解釈
// ===========================================================================
//   GDD は士気が**動く前提**で書かれている:
//     - 4.2「未成文技術の保持者を過酷業務・探索派遣・**士気切れ**に晒すと…」
//     - 11.2「moraleW: 士気 <30 で +0.10、士気 <15 で +0.20」
//       「回復条件: **通常業務就労かつ士気 ≥40 を持続**、または療養所で休養1日」
//     - 7.2「trait 8種: … 楽観 / 悲観 …」(content は `morale ±10` を定義済み)
//     - 7.3「絆は士気補正+と士気回復+を生む」「相方の喪失で一時的士気ペナ」
//     - 11.5「未成文の唯一保持技術を持つ住民は**士気 <40 では**過酷業務・派遣に
//       回さない」(sim bot の判断)
//   ところが M72 以前、engine で士気を書き換えるのは**伴侶喪失の減算 1 箇所だけ**
//   (`rules/bond.ts` の `applyPartnerLossEffects`)であり、業務による低下も回復も
//   存在しなかった。その結果 sim の想起ガードは全 15 run で発火 0 回=
//   GDD 11.5 の日単位ジレンマが未検証だった(台帳v20 必-4)。本モジュールが
//   その欠落を埋める。
//
//   **[解釈] GDD が書いていない点**:
//     (a) **低下/回復の量**は GDD に無い。`balance.morale` の設計値とし、
//         レートの根拠は §2 に書く(bond の蓄積レートと同じ立場)。
//     (b) **派遣中・無配属の士気**を GDD は書いていない。GDD が名指すのは
//         「過酷業務(低下)」と「通常業務就労(回復)」の 2 つだけなので、
//         **どちらでもない住民のレートは 0**(動かない)とする最小解釈を採る。
//     (c) **業務由来の低下には下限({@link MoraleParams.routineFloorFix})を置く**。
//         GDD 11.1 は士気低下を「記憶劣化の喪失トリガ」ではなく一時想起困難の
//         入力として並べており、11.2 の moraleW(<30 で +0.10 = 通常業務者の
//         リスクが約6.5倍)は**危機**の表現である。日々の労働だけで全住民が
//         そこへ落ちると「危機」が定常状態になってしまうので、業務由来の低下は
//         floor で止め、30 割れは**喪失/危機イベント由来**(伴侶喪失の bond ペナ・
//         GDD 7.3)にのみ残す。floor は**実効士気**(trait 込み・§3)へ掛けるので、
//         悲観 trait を持つ住民でも業務だけで 30 を割ることはない。
//     (d) **trait の士気効果**(GDD 7.2 楽観/悲観 ±10)は「実効士気 = 蓄積士気 +
//         Σtrait 加算」として反映する(`rules/stats.ts` の実効ステータスと同じ
//         合成の考え方)。trait は state を書き換えず、読み出し時に効く。
//
// ===========================================================================
// 2. レート設計(content/balance.json の `morale` ブロック)
// ===========================================================================
//   平衡は「低下レートと回復レートの比」と floor で決まる:
//     - 過酷業務に就き続ける住民 → floor(実効 35)へ収束して**そこに留まる**
//       = GDD 11.5 の bot 閾値 40 を必ず下回る = 想起ガードが発火する
//       = しかし 11.2 の 30 は割らない = moraleW は 0 のまま(11.4-8b を動かさない)
//     - 通常業務に戻ると回復レートで 40 を超え、再び過酷業務の候補に戻る
//       (= GDD 11.5 が想定する日単位のジレンマが循環する)
//   初期士気 60(`src/newGame.ts`)/ 加入士気 50(`rules/population.ts`)から
//   floor までの到達日数は 60 → 40 が 8 日、60 → 35 が 10 日(既定値)。
//   夜間 sim の 1 run = 40 ゲーム日なので、ガードが踏まれる余地が十分にある。
//
// ===========================================================================
// 3. 決定論と (A) 区間の閉形式(bond と同型)
// ===========================================================================
//   `computeMoraleRates`(区間の入口でレート確定)→ `applyMoraleProgress`
//   (レート × 区間長を一括適用)の 2 段で、`rules/bond.ts` と同じ形にしてある。
//   区間内でレートが変わらないことの根拠:
//     - 配属(`assignedFacilityId`)は Command 経路でしか変わらない
//     - 派遣状態は帰還イベント(段60)= 既に区間境界
//     - 休養(`rules/care.ts`)の顔ぶれは想起困難の発生((C) ステップ境界)と
//       回復((B) recallRecover 境界)でしか変わらない
//     - 死亡/加入も境界イベント
//   よって**新しい境界イベントを 1 つも増やさずに** (A) の閉形式が成立する。
//
//   クランプは単調なので分割不変である:
//     正のレート: `min(100, x + rΔ)` は Δ を割っても同じ
//     負のレート: `max(min(x, floor), x + rΔ)` も同じ(floor 未満から始まった
//     場合は「業務由来の低下では**それ以上掘らない**」= 何も動かない)
//   走査順は住民 entity の ID 昇順(`entitiesOfKind` の正準順・GDD 11.7)。
// ---------------------------------------------------------------------------

import {
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromInt,
  fixFromRaw,
  floorDivInt,
  maxFix,
  minFix,
  mulFixInt,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import { GAME_DAY_TICKS } from "../stochastic";
import {
  entitiesOfKind,
  isAliveResident,
  requireEntity,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";
import { careRecipientsAt } from "./care";
import { resolveMoraleTraitDefs, traitMoraleAddFix } from "./stats";
import { requireFacilityDef, RulesError, type EngineContent } from "./types";

/** 士気の下限(GDD 7.1 の「0〜100・上限厳守」と同じクランプ)。 */
export const MORALE_MIN_FIX: Fix = FIX_ZERO;
/** 士気の上限。 */
export const MORALE_MAX_FIX: Fix = fixFromInt(100);

/**
 * 1 日あたりの人間単位レートを 1 tick あたりの Fix へ落とす
 * (**掛けてから 1 回だけ floor 除算**する `rules/bond.ts` の作法と同じ)。
 */
export function perTickFromPerDayFix(perDayFix: Fix): Fix {
  return fixFromRaw(floorDivInt(toRaw(perDayFix), GAME_DAY_TICKS));
}

/**
 * その住民の trait による士気加算(GDD 7.2 楽観 +10 / 悲観 -10・§1(d))。
 * trait 定義が無い / 士気に効く trait を持たなければ 0。
 */
export function moraleTraitAddFix(resident: ResidentState, content: EngineContent): Fix {
  let total = FIX_ZERO;
  for (const def of resolveMoraleTraitDefs(resident.traitIds, content.traitDefs)) {
    total = addFix(total, traitMoraleAddFix(def));
  }
  return total;
}

/**
 * **実効士気** = clamp(蓄積士気 + trait 加算, 0, 100)(§1(d))。
 *
 * GDD 11.2 の moraleW と GDD 11.5 の bot 閾値はどちらもこの値で判定する
 * (「楽観な人は同じ状況でも参っていない」という trait の意味がそのまま効く)。
 */
export function effectiveMoraleFix(resident: ResidentState, content: EngineContent): Fix {
  const add = moraleTraitAddFix(resident, content);
  if (toRaw(add) === 0) return resident.morale;
  return clampFix(addFix(resident.morale, add), MORALE_MIN_FIX, MORALE_MAX_FIX);
}

/** 1 住民ぶんの士気レート(人間単位/tick)。 */
export interface MoraleRateEntry {
  readonly residentId: EntityId;
  /** 正 = 回復 / 負 = 低下。0 の住民は載せない。 */
  readonly ratePerTickFix: Fix;
  /**
   * その住民の**蓄積士気**の下限(実効士気が {@link MoraleParams.routineFloorFix}
   * を割らない位置・§1(c))。低下側のクランプにだけ使う。
   */
  readonly storedFloorFix: Fix;
}

/** {@link computeMoraleRates} の結果。`entries` は住民 ID 昇順(§3)。 */
export interface MoraleRates {
  readonly entries: readonly MoraleRateEntry[];
}

/** レートが 1 件も無い(= 士気機構が不活性)ことの明示。 */
export const NO_MORALE_RATES: MoraleRates = { entries: [] };

/**
 * 現在の state から 1 tick あたりの士気レートを計算する((A) 区間の入口・§3)。
 *
 * `content.morale` が無ければ**常に空**(= M72 以前と 1 bit も違わない)。
 *
 * @throws {RulesError} 配属先 facility の定義が content に無い場合
 */
export function computeMoraleRates(
  state: GameState,
  content: EngineContent,
  tick: number,
): MoraleRates {
  const params = content.morale;
  if (params === undefined) return NO_MORALE_RATES;

  const harshDrop = perTickFromPerDayFix(params.harshWorkDropPerDayFix);
  const normalRecover = perTickFromPerDayFix(params.normalWorkRecoverPerDayFix);
  const careRecover = perTickFromPerDayFix(params.careRecoverPerDayFix);
  // 休養している住民(ID 昇順・枠数まで)。`content.care` が無ければ空。
  const careSet = new Set<EntityId>(careRecipientsAt(state, content, tick));

  const entries: MoraleRateEntry[] = [];
  for (const resident of entitiesOfKind(state, "resident")) {
    if (!isAliveResident(resident)) continue;

    let rate = FIX_ZERO;
    // (b) 派遣中は「過酷業務でも通常業務でもない」= 0(§1(b))。
    if (!resident.dispatched && resident.assignedFacilityId !== null) {
      const facility = requireEntity(state, resident.assignedFacilityId, "facility");
      const def = requireFacilityDef(content, facility.defId);
      rate = def.harshWork ? subFix(FIX_ZERO, harshDrop) : normalRecover;
    }
    if (careSet.has(resident.id)) rate = addFix(rate, careRecover);
    if (toRaw(rate) === 0) continue;

    // 実効士気の floor を蓄積士気の座標へ写す(trait 加算のぶんだけずらす)。
    const storedFloorFix = clampFix(
      subFix(params.routineFloorFix, moraleTraitAddFix(resident, content)),
      MORALE_MIN_FIX,
      MORALE_MAX_FIX,
    );
    entries.push({ residentId: resident.id, ratePerTickFix: rate, storedFloorFix });
  }
  return { entries };
}

/**
 * (A) 区間ぶんの士気変化を一括適用する(`rules/bond.ts` の `applyBondProgress` と
 * 同型・§3)。
 *
 * - 回復(正のレート): `min(100, 士気 + レート × Δ)`
 * - 低下(負のレート): `max(min(士気, storedFloor), 士気 + レート × Δ)`
 *   —— **既に floor より下にいる住民を業務由来の低下でさらに掘らない**
 *   (伴侶喪失の bond ペナ(GDD 7.3)で沈んだ士気を、そこからさらに日常業務が
 *   削っていくのは「危機は危機由来」の設計(§1(c))に反する)
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない場合
 */
export function applyMoraleProgress(
  state: GameState,
  rates: MoraleRates,
  deltaTicks: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyMoraleProgress: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  if (rates.entries.length === 0) return state;

  let next = state;
  for (const entry of rates.entries) {
    const delta = mulFixInt(entry.ratePerTickFix, deltaTicks);
    if (toRaw(delta) === 0) continue;
    next = updateEntity(next, entry.residentId, "resident", (resident) => {
      const moved = addFix(resident.morale, delta);
      const clamped =
        toRaw(delta) > 0
          ? minFix(moved, MORALE_MAX_FIX)
          : maxFix(moved, minFix(resident.morale, entry.storedFloorFix));
      if (toRaw(clamped) === toRaw(resident.morale)) return resident;
      return setField(resident, "morale", clampFix(clamped, MORALE_MIN_FIX, MORALE_MAX_FIX));
    });
  }
  return next;
}

/**
 * 士気の帯(観測・sim レポート用)。GDD 11.2 の閾値(30 / 15)と GDD 11.5 の
 * bot 閾値(40)で切る。engine のロジックはこの関数を読まない。
 */
export function moraleBandOf(effectiveMoraleFixValue: Fix): "critical" | "low" | "guard" | "ok" {
  const raw = toRaw(effectiveMoraleFixValue);
  if (raw < 15 * FIX_SCALE) return "critical";
  if (raw < 30 * FIX_SCALE) return "low";
  if (raw < 40 * FIX_SCALE) return "guard";
  return "ok";
}
