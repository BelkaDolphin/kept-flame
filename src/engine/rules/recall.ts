// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- (C)想起困難 = 確率イベント区間 — GDD 11.2 / 11.8(C) / ADR-009/018
//
// ===========================================================================
// 1. (C) 区間の扱い(GDD 11.8(C) と段階1 の関係)
// ===========================================================================
//   GDD 11.8(C) は「確率イベント区間は閉形式解を持たない」ことを認め、毎 tick 逐次
//   判定に戻すのでなく「次発生 tick を幾何分布の逆 CDF で一発サンプリングして
//   その時刻へジャンプする」離散事象方式を将来形として示している。ただし
//   ADR-009 / ADR-018(1) は **MVP = 段階1(粗粒度 per-step 全再評価)** と定め、
//   逆 CDF(段階2 next-reaction + fpLog)は MVP 後の追加投資としている。
//   本モジュールは段階1 = 粗粒度ステップごとの全ペア再評価だけを実装する。
//   fpLog(非整数対数)は ADR-006 の Math 許可リストで禁止されており、段階2 は
//   その導入とカスケードレジストリの人力保守を伴うため、段階1 実装を恒久の
//   グラウンドトゥルースとして残す設計になっている。
//
//   (C) が (A)(B) と噛み合う点: **発生した想起困難は生産レートを変える**ので、
//   発生 tick(= 粗粒度ステップ境界)と回復 tick(= 発生 + 持続)は両方とも
//   積分区間の分割点になる。回復側は「(C) の結果として生まれた (B) 境界」であり、
//   scheduler がこれを離散事象として持つことで (A) の閉形式が保たれる。
//
// ===========================================================================
// 2. 発生式(GDD 11.2)
// ===========================================================================
//   p(1 ゲーム日 = 1440 tick あたり)
//     = clamp(0, base_p × loadW(施設負荷) + moraleW + dispatchW
//                 − masteryResist(u,t), p_max)
//     loadW        : 過酷業務 ×2.0 / 通常業務 ×0.5 / 無配属は 0(就労していない)
//     moraleW      : 士気 <30 で +0.10、<15 で +0.20(強い方を採る)
//     dispatchW    : 探索派遣中 +0.15
//     masteryResist: 実地稼働の定着度(0〜0.20)+ 記憶巧者 trait −0.15
//   1 ステップあたり確率への変換は stochastic.ts の
//   {@link perCoarseStepProbability}(線形按分・pow 禁止の理由もそこに記載)。
//
// ===========================================================================
// 3. 縮約と本式(T5 → M13)
// ===========================================================================
//   T5(先行計測)は 3 点を縮約していた。**M13 で (b) を本式へ上げた**:
//
//   (a) **判定ペア** — [縮約のまま] GDD の `recallRisk(住民u, tech t)` は
//       「u が記憶している未成文の tech」を走る。判定ペアは
//       「全生存住民 × 全 research entity の techId」のままである。理由は
//       rules/techMemory.ts §2(a): ADR-014 の「20人×3tech×2,304step =
//       138,240 ベルヌーイ判定/run」という計測 #3/#4 の入力を保つため、および
//       保持していない tech の想起困難は上界として安全側だから。
//   (b) **停止の粒度** — [M13 本式] GDD の「当該住民の当該 tech 関連生産のみ停止」
//       を `GameState.techMemoryByKey` の (住民, tech) 別 `impairedUntilTick` で
//       表現する。止まるのは当該 tech の実地要件施設
//       (`tech.fieldRequirement.facility`)での寄与だけであり、実地要件が
//       content に無い tech は住民単位の全停止へフォールバックする
//       (rules/techMemory.ts §1・§2)。
//       これに伴い **同一住民の別 tech は独立に発生する**(下記)。
//   (c) **回復条件** — [M66 で第2枝を実装] 「通常業務就労かつ士気 ≥40 を持続」は
//       縮約のまま(持続 d の満了のみ)だが、「**または療養所で休養1日**」は
//       `rules/care.ts` として実装した。発生した (u,t) の回復 tick は
//       「発生 + 抽選持続」と「発生 + `balance.care.restRecoveryTicks`」の
//       **早い方**になる(療養所の休養枠に入れた住民のみ)。content に
//       `care` ブロックが無い / 盤面に休養枠が無い場合は M66 以前と同一。
//
//   **発生の抑制は (住民, tech) 単位**(M13)。T5 は「既に想起困難中の**住民**には
//   新規発生を積まない」という住民単位の抑制だったが、GDD 11.2 は
//   「(u,t) ごとの確率」「他生産・他住民は影響なし」と定めており、同一住民の
//   別 tech が同時に想起困難になることを排除していない。よって抑制は
//   「その (u,t) が既に想起困難中なら積まない」に限る。
//   **これは T5 と観測挙動が変わる本式化であり、golden vector の変化 = algoVersion
//   bump を伴う**(ADR-016)。
//
//   ベルヌーイ試行そのものは**発生中でも全ペアぶん引く**: 段階1 の
//   「per-step 全再評価」を試行数の面でも崩さないため(= #3 の 138,240 判定/run が
//   状態依存で目減りしない)であり、hash アドレス方式ゆえ引いても引かなくても
//   他ペアの結果は変わらない。
//
//   `ResidentState.recallImpairedUntilTick`(住民単位スカラ)は**残す**が、
//   M13 以降の抽選はそこへ書かない。プリロードされたセーブ・テストフィクスチャ・
//   sim パターンが「住民単位の全停止」を直接置く口として生き続け、生産側
//   (rules/production.ts の `isWorkerActive`)はこれを従来どおり尊重する。
// ---------------------------------------------------------------------------

import { FIX_ZERO, addFix, clampFix, maxFix, minFix, mulFix, subFix, type Fix } from "../fp";
import { DOMAIN_TAGS } from "../rng/domainTags";
import {
  bernoulliHit,
  coarseStepIndexOf,
  drawFromStream,
  hashedDrawUint32,
  perCoarseStepProbability,
  saltFromId,
  uniformIntFromDraw,
} from "../stochastic";
import {
  entitiesOfKind,
  isAliveResident,
  requireEntity,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../state/state";
import { careRecipientsAt, recoveryTickWithCare } from "./care";
import { isTechImpaired, masteryResistBaseFix, setTechImpairedUntil } from "./techMemory";
import { RulesError, requireFacilityDef, type AdvanceContext, type EngineContent } from "./types";

/** 判定対象の技術 ID(§3(a): research entity の techId・ID 昇順)。 */
export function recallTechIds(state: GameState): readonly EntityId[] {
  const result: EntityId[] = [];
  for (const research of entitiesOfKind(state, "research")) {
    result.push(research.techId);
  }
  return result;
}

/**
 * 住民 1 人の 1 ゲーム日あたり想起困難発生確率(§2 / GDD 11.2)。
 *
 * 加算は式の左から右へ固定順で行う(浮動小数ではないので結合律は保たれるが、
 * 途中の値域検査は順序依存・fp.ts sumFix の注記と同じ理由)。
 *
 * loadW は住民側の `assignedFacilityId`(配属先 facility **entity** の ID)から
 * その facility 定義を引いて決める。生産側が `facility.workerIds` を見るのに対し
 * こちらは住民→施設の逆向きの参照を使うので、両者が食い違う state は
 * 「配属したのに workerIds に入っていない」等の整合違反になる(整合の担保は
 * 配属 Command の実装事項であり T5 のスコープ外)。
 *
 * @throws {EntityLookupError} 配属先の facility entity が state に無い場合
 * @throws {RulesError} 配属先 facility の定義が content に無い場合
 */
export function recallRiskPerDay(
  state: GameState,
  content: EngineContent,
  resident: ResidentState,
  techId: EntityId | null = null,
): Fix {
  const p = content.recallRisk;

  // loadW: 配属先の過酷業務フラグで決まる。無配属は就労していないので 0。
  let loadW = FIX_ZERO;
  if (resident.assignedFacilityId !== null) {
    const facility = requireEntity(state, resident.assignedFacilityId, "facility");
    loadW = requireFacilityDef(content, facility.defId).harshWork
      ? p.loadWHarshFix
      : p.loadWNormalFix;
  }

  // base_p × loadW。どちらも係数なので値域は小さいが、content 由来で上界を
  // 証明できないため既定 API の mulFix(必要時 BigInt・fp.ts §4)を使う。
  let risk = mulFix(p.basePFix, loadW);

  // moraleW: 下位閾値のほうが強いので、そちらに掛かったら中位は使わない。
  if (resident.morale < p.moraleThresholdLowFix) {
    risk = addFix(risk, p.moraleBonusLowFix);
  } else if (resident.morale < p.moraleThresholdMidFix) {
    risk = addFix(risk, p.moraleBonusMidFix);
  }

  if (resident.dispatched) {
    risk = addFix(risk, p.dispatchWFix);
  }

  // masteryResist = clamp(住民スカラ + 当該 tech の実地蓄積, 0, 上限)
  //                 + 記憶巧者 trait 耐性(負値)。
  // [M13] tech 別の蓄積は rules/techMemory.ts。techId を渡さない呼び出し
  // (tech に依らない上界の見積り)では住民スカラだけを使う = T5 と同一。
  let resist =
    techId === null
      ? maxFix(FIX_ZERO, minFix(resident.mastery, p.masteryResistMaxFix))
      : maxFix(FIX_ZERO, masteryResistBaseFix(state, content, resident, techId));
  if (p.memoryKeeperTraitId !== null && resident.traitIds.includes(p.memoryKeeperTraitId)) {
    // memoryKeeperResistFix は負値(-0.15)。resist は「引く量」なので符号を反転して足す。
    resist = subFix(resist, p.memoryKeeperResistFix);
  }
  risk = subFix(risk, resist);

  return clampFix(risk, FIX_ZERO, p.pMaxFix);
}

/** 想起困難が新たに発生した 1 件(scheduler が回復イベントを積むための情報)。 */
export interface RecallOccurrence {
  readonly residentId: EntityId;
  /** [M13] 発生した技術(GDD 11.2 の `recallRisk(u,t)` の t)。 */
  readonly techId: EntityId;
  /** 回復する tick(= 発生 tick + 持続)。 */
  readonly untilTick: number;
}

/** {@link evaluateRecallCoarseStep} の結果。 */
export interface RecallStepResult {
  readonly state: GameState;
  /** 引いたベルヌーイ試行の総数(計測 #3/#4 の判定数の実測に使う)。 */
  readonly trialCount: number;
  /** 新規発生(住民 ID 昇順)。 */
  readonly occurrences: readonly RecallOccurrence[];
}

/**
 * 粗粒度ステップ 1 回ぶんの (C) 全再評価(段階1・§1)。
 *
 * 走査順は住民 ID 昇順 × 技術 ID 昇順に固定(GDD 11.7 の逐次カスケード順序)。
 * 発生の抽選は hash アドレス方式(順序非依存)、持続日数だけ逐次ストリーム
 * (domainTag `recallDuration`)から引く(stochastic.ts §2)。
 *
 * @throws {RulesError} 持続の下限/上限が不正な場合
 * @throws {StochasticError} 確率が [0,1] を外れた場合(= content のレンジ制約漏れ)
 */
export function evaluateRecallCoarseStep(
  state: GameState,
  ctx: AdvanceContext,
  stepTick: number,
): RecallStepResult {
  const content = ctx.content;
  const params = content.recallRisk;
  if (
    !Number.isSafeInteger(params.durationMinTicks) ||
    !Number.isSafeInteger(params.durationMaxTicks) ||
    params.durationMinTicks < 1 ||
    params.durationMaxTicks < params.durationMinTicks
  ) {
    throw new RulesError(
      `recallRisk の持続 tick(${String(params.durationMinTicks)}〜${String(params.durationMaxTicks)})が不正`,
    );
  }

  const stepIndex = coarseStepIndexOf(stepTick, content.coarseTickMinutes);
  const techIds = recallTechIds(state);
  const residents = entitiesOfKind(state, "resident");

  let next = state;
  let trialCount = 0;
  const occurrences: RecallOccurrence[] = [];

  for (const resident of residents) {
    // [M11] 死者は判定ペアに入らない(記憶ごと失われている)。試行数も引かない
    // ので、死者が 1 人も居ない盤面では M11 以前と試行列が完全に一致する。
    if (!isAliveResident(resident)) continue;
    const residentSalt = saltFromId(resident.id);
    // [M13] 住民単位スカラの想起困難は「全 tech が止まっている」状態なので、
    // その間は新規発生を積まない(T5 の抑制と同じ扱い。プリロードされたセーブや
    // sim パターンがこのスカラを使う・§3 末尾)。
    const residentWideImpaired = stepTick < resident.recallImpairedUntilTick;

    for (const techId of techIds) {
      // [M13] mastery は (住民, tech) 別なので p も tech ごとに計算する
      // (士気・派遣・配属はステップ内で変わらないので、変わるのは mastery 項だけ)。
      const pStep = perCoarseStepProbability(
        recallRiskPerDay(state, content, resident, techId),
        content.coarseTickMinutes,
      );
      const draw = hashedDrawUint32(ctx.worldSeedU32, DOMAIN_TAGS.recall, [
        residentSalt,
        saltFromId(techId),
        stepIndex,
      ]);
      trialCount++;
      if (!bernoulliHit(pStep, draw)) continue;
      // [M13] 抑制は (住民, tech) 単位(§3)。試行は上で引き終えているので
      // 以降のペアの乱数列には影響しない。
      if (residentWideImpaired) continue;
      // `next` を見る(`state` ではない): 同じ techId を持つ research entity が
      // 2 つある content でも同一 (u,t) を二重に発生させないため。
      if (isTechImpaired(next, resident.id, techId, stepTick)) continue;

      const durationDraw = drawFromStream(next, DOMAIN_TAGS.recallDuration);
      next = durationDraw.state;
      const drawnUntilTick =
        stepTick +
        uniformIntFromDraw(durationDraw.value, params.durationMinTicks, params.durationMaxTicks);
      // [M66] まず抽選どおりに書いてから、療養所の休養枠に入るかを判定して
      // 短縮する(GDD 11.2「療養所で休養1日」・rules/care.ts §1(a)(b))。
      // 枠の判定は**発生を書き込んだ後の state** で行う: この住民自身も
      // 「想起困難中」として枠を数える対象だからである。住民の走査は ID 昇順で、
      // `careRecipientsAt` も ID 昇順に枠を埋めるので、後から発生した上位 ID の
      // 住民が既に処理した下位 ID の住民の枠を奪うことはない(同一ステップ内で
      // 判定が安定する)。`content.care` が無ければ短縮は起きない。
      next = setTechImpairedUntil(next, resident.id, techId, drawnUntilTick);
      const underCare = careRecipientsAt(next, content, stepTick).includes(resident.id);
      const untilTick = recoveryTickWithCare(content, stepTick, drawnUntilTick, underCare);
      if (untilTick !== drawnUntilTick) {
        next = setTechImpairedUntil(next, resident.id, techId, untilTick);
      }
      occurrences.push({ residentId: resident.id, techId, untilTick });
    }
  }

  return { state: next, trialCount, occurrences };
}

// ---------------------------------------------------------------------------
// 回復について: **状態遷移を持たない**(scheduler の recallRecover イベントは
// 区間境界としてのみ存在する)。
//
// 回復は `impairedUntilTick`([M13] は techMemoryByKey 側・住民単位スカラは
// `recallImpairedUntilTick`)と現在 tick の比較だけで表現され
// (`tick >= until` なら稼働・rules/production.ts の isWorkerActiveAtFacility)、
// 回復 tick でフラグを 0 に戻す処理は**入れない**。理由は分割不変性(advance.ts §3):
// 半開区間の規約(scheduler.ts §2)により tick == toTick のイベントは処理されない
// ため、ちょうど回復 tick で advance を区切ると「フラグを 0 に戻すイベント」が
// どちらの advance でも発火せず、一括で進めた場合(発火する)と state が
// 食い違ってしまう。比較だけで判定する設計にしておけば、区切り位置に関わらず
// state が一致する = golden vector が分割位置に依存しない。
//
// 満了済みの until がフラグに残り続けるが、これは「最後に回復した tick」の記録で
// あり、発生判定(`stepTick < until`)・稼働判定のどちらも正しく動く。
// ---------------------------------------------------------------------------
