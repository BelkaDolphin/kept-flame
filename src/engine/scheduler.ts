// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 離散事象スケジューラ — ADR-008 / GDD 11.8 / 11.7 / 11.9
//
// tick を 1 個ずつ回すのではなく、「レートが変わらない区間を閉形式で飛ばし、
// 区間の境界(離散事象)だけを順に処理する」ことで 72h(4320 tick)の catch-up を
// 数百ステップに圧縮する。ここがその中心。
//
// ===========================================================================
// 1. (A)(B)(C) 区間分類の実装方式(GDD 11.8)
// ===========================================================================
//   GDD 11.8 の 3 分類を、本実装では**「区間は常に (A)、境界に (B)(C) がある」**
//   という形で表現する:
//
//     (A) 定常生産区間 — 生産レート・研究レートが一定の区間。区分求積の閉形式
//         (レート × 区間長)で一発計算する。→ rules/production.ts, research.ts
//     (B) レート変化イベント — その tick でレートが変わる点。研究完了
//         (完了 tick は現在レートから解析的に予測)と、想起困難の回復
//         (回復 tick は発生時に確定)。→ 積分区間の分割点になる。
//     (C) 確率イベント区間 — 粗粒度ステップ(既定 10 分)ごとにベルヌーイ試行を
//         全ペア再評価する段階1(ADR-009/018(1))。ステップ境界そのものが
//         分割点であり、区間内では確率イベントが起きないので (A) が成立する。
//
//   **中心的な不変条件**: レートを変える状態変化は必ず境界イベントとして heap に
//   載っていること。載っていない変化があると (A) の閉形式が静かに誤差を持ち、
//   golden vector にしか現れないバグになる。レートを変えるのは
//     研究完了(研究レートの向き先が変わる)/ 想起困難の発生(就労者が落ちる)/
//     想起困難の回復(就労者が戻る)/ [M11] 寿命死(就労者が減る)/
//     [M11] 晴天漂着(住民が増える = (C) の判定ペアが増える)
//   であり、想起困難の発生は (C) ステップ境界と同 tick なので新たな境界を要さない。
//   M11 の 2 つは新しい境界イベント(段65 加入 / 段70 死亡)として heap に載る。
//
//   **[M13] 新しく区間内で積分する量を 2 つ足したが、境界は増えない**:
//     bond(共働の絆・GDD 7.3)   — どのレートにも影響しない(士気補正は未実装)
//     mastery(定着度・GDD 11.2) — 生産レートに影響せず、影響先の (C) 抽選確率は
//                                  必ず粗粒度ステップ境界で評価される
//   どちらも「レート × 区間長」の閉形式であり、節目(bond)の記録 tick は区間内の
//   **解析的な到達 tick**を使うので分割不変(rules/bond.ts の crossingsInInterval)。
//
//   **[M72] 士気(morale)も同じ**: 業務による低下/回復・休養による回復は
//   「レート × 区間長」の閉形式(rules/morale.ts)であり、レートを決める入力
//   (配属・派遣・休養・生死)はすべて既存の境界でしか変わらない。士気が変えるのは
//   (C) 抽選の確率(moraleW)であり、それは必ず粗粒度ステップ境界で評価される。
//
//   **[M50] 成文化を結線したが、新しい種類の境界は増えていない**: 成文化の作業は
//   研究と同じ「レート × 区間長」の (A) 積分(`applyCodifyProgress`)で、完了は
//   研究完了と同じ**レート依存の解析的予測**(`syncCodifyCompletionEvent`)である。
//   よってレートを変える状態変化の一覧に「成文化完了(学者の作業が次のジョブへ
//   向く)」が 1 つ増えただけで、区間分類の構造は変わらない。
//   衛星供給([M25] 段80)と違って離散事象が要るのは、完了が**在庫ではなく
//   キューの先頭を差し替える**からである(= レートの向き先が変わる)。
//
//   段階2(逆 CDF で次発生 tick を一発サンプリングして (C) 区間も飛ばす)は
//   ADR-018(3) のとおり MVP 後。段階1 のステップ境界は「(C) がある限り
//   coarseTickMinutes ごとに必ず区間が切れる」ことを意味するので、72h catch-up の
//   ステップ数は 4320/10 = 432 が下限になる(#1 の compute 予算の主項)。
//
// ===========================================================================
// 2. tick の意味と半開区間の規約
// ===========================================================================
//   `state.tick = T` は「**tick T の頭**の状態」= tick < T の生産とイベントは
//   すべて適用済み、を意味する。`runSchedule(state, ctx, T')` は半開区間
//   [T, T') を進める:
//     - 生産/研究の積分は区間長 = (境界 − カーソル) tick ぶん
//     - tick が t のイベントは、カーソルが t に達した時点で(その tick 以降の
//       積分より**前**に)処理される
//     - tick == T' のイベントは処理しない(それは次回の advance の担当)
//   この規約により `advance(0→100)` と `advance(0→50)+advance(50→100)` が
//   完全に一致する(分割不変)。粗粒度ステップのグリッドが state.tick 起点でなく
//   **tick の絶対値** に固定されている(stochastic.ts coarseStepIndexOf)ことが
//   その前提であり、分割不変性はテストで固定してある。
//
// ===========================================================================
// 3. tie-break(同一 tick に複数イベント)— GDD 11.7 / ADR-008
// ===========================================================================
//   比較キーは (tick 昇順, パイプライン段, entityId の UTF-16 昇順) の 3 段で、
//   **これが全順序になる**ように「同じ 3 つ組のイベントは 2 つ存在できない」を
//   push 時に強制する({@link EventQueue.push} が重複キーを reject)。全順序ゆえ
//   heap の内部配置(挿入順・再構築の有無)がイベントの処理順に影響しない
//   = 決定論が heap の実装詳細から独立する。
//
//   パイプライン段は GDD 11.7 の「同一 tick 内優先順位固定」に従う:
//     襲撃判定 → 負傷反映 → 生産 → 研究 → 成文化完了 → 探索解決 →
//     死亡/全滅判定 → 衛星供給 → 幕塵メーター更新
//   GDD の一覧に想起困難は現れないため、本実装は「負傷反映と生産の間」に
//   回復 → 発生抽選の 2 段を置く({@link PIPELINE_STAGE})。根拠は 2 つ:
//     (a) 就労可否は生産の入力なので、生産(= 次の (A) 区間の積分)より前に
//         確定していなければならない
//     (b) 回復を発生抽選より前に置くと、「持続がちょうど切れる tick に同じ住民が
//         再抽選される」挙動になる。逆順だと 1 ステップぶん再抽選が遅れる。
//         どちらでも決定論は保たれるが、前者のほうが「回復した瞬間からリスクに
//         戻る」という GDD の記述に近い。
//   この 2 段の位置は GDD 11.7 の一覧を補完する解釈であり、GDD 側へ追記するかは
//   ユーザー判断事項として報告する。
//
// ===========================================================================
// 4. 72h クランプ(GDD 11.1 / 11.9)
// ===========================================================================
//   オフライン差分は 0〜72h(4320 tick)にクランプする。クランプは
//   「経過実時間 → tick 差」の変換段({@link clampOfflineTickDelta}・ADR-026 の
//   targetTick 式)で掛ける。`runSchedule` 自体は区間長に上限を設けない —
//   夜間 sim は 1 run = 2,304 粗粒度ステップ(≈16 ゲーム日 = 23,040 tick 以上)を
//   回すので(ADR-014)、ここで 4320 を強制すると sim が走らなくなる。
//   「実時間経過に対する上限」と「エンジンが進める tick 幅」を混同しないこと。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "./canonicalize";
import { FIX_ZERO, type Fix } from "./fp";
import {
  entitiesOfKind,
  getTechMemory,
  isAliveResident,
  requireEntity,
  techMemoryKeys,
  type CodifyState,
  type EntityId,
  type GameState,
  type ResearchState,
} from "./state/state";
import { setField } from "./state/update";
import { applyBondProgress, applyPartnerLossEffects, computeBondRates } from "./rules/bond";
import {
  applyCodifyProgress,
  codifyRemaining,
  completeCodification,
  currentCodification,
  ticksUntilCodifyComplete,
} from "./rules/codify";
import { resolveExpedition } from "./rules/exploration";
import { deathTickOf } from "./rules/lifespan";
import { recordDeathMemoir } from "./rules/memoir";
import { applyMoraleProgress, computeMoraleRates } from "./rules/morale";
import { applyOutpostSupply, computeOutpostSupplyRates } from "./rules/outpost";
import { nextRaidTick, resolveRaid } from "./rules/raid";
import { applyArrival, applyResidentDeath, nextArrivalTick } from "./rules/population";
import { applyProduction, computeProductionRates, type ProductionRates } from "./rules/production";
import {
  applyFieldRunProgress,
  applyMasteryProgress,
  applyTechLossOnDeath,
} from "./rules/techMemory";
import {
  applyResearchProgress,
  completeResearch,
  currentResearch,
  fieldBlockedResearches,
  fieldRequirementRemaining,
  researchRemaining,
  ticksUntilFieldRequirement,
  ticksUntilResearchCompleteGated,
} from "./rules/research";
import { evaluateRecallCoarseStep } from "./rules/recall";
import type { AdvanceContext } from "./rules/types";
import { nextCoarseStepTickAtOrAfter } from "./stochastic";

/** スケジューラの使い方の誤り(過去への advance・同 tick への再予約など)。 */
export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerError";
  }
}

// --- 1. 72h クランプ -------------------------------------------------------

/** 1 tick = 1 分(ADR-026 / GDD 11.1)。 */
export const TICK_MS = 60_000;

/** オフライン差分のクランプ上限 = 72h = 4320 tick(GDD 11.1 / 11.9・balance.offlineClampTick)。 */
export const OFFLINE_CLAMP_TICK = 4320;

/**
 * オフライン経過の tick 差を 0〜{@link OFFLINE_CLAMP_TICK} にクランプする(§4)。
 * 負値(単調時刻の巻き戻し)は 0 に落とす — 巻き戻しの**検知**は
 * platform 側(localStorage/IDB 二重保存・GDD 11.9)の担当で、engine は
 * 「負の経過では進まない」ことだけを保証する。
 */
export function clampOfflineTickDelta(tickDelta: number): number {
  if (!Number.isSafeInteger(tickDelta)) {
    throw new SchedulerError(
      `clampOfflineTickDelta: tick 差 ${String(tickDelta)} が安全整数でない`,
    );
  }
  if (tickDelta < 0) return 0;
  return tickDelta > OFFLINE_CLAMP_TICK ? OFFLINE_CLAMP_TICK : tickDelta;
}

// --- 2. イベントと tie-break ----------------------------------------------

/**
 * 同一 tick 内の処理順(§3)。GDD 11.7 の 9 段に 10 刻みの番号を振り、
 * 未実装の段も**番号だけ予約**してある(後から挿入しても既存の相対順序が動かない)。
 */
export const PIPELINE_STAGE = {
  /** 襲撃判定([M66] 結線済み・GDD 11.7 段10 / 11.1 の戦闘式・rules/raid.ts)。 */
  raid: 10,
  /** 負傷反映(未実装)。 */
  injury: 20,
  /** 想起困難の回復(T5・§3(b))。 */
  recallRecover: 22,
  /** 想起困難の発生抽選 = (C) 粗粒度ステップ(T5)。 */
  recallRoll: 24,
  /** 生産(T5 では (A) 区間の積分であってイベントではない)。 */
  production: 30,
  /** 研究完了(T5)。 */
  research: 40,
  /**
   * 成文化完了([M50] 結線済み・GDD 11.7 段50)。
   *
   * 研究完了(段40)と**完全に同型**である: 区間の進行は (A) の閉形式
   * (`rules/codify.ts` の `applyCodifyProgress`)で積分し、完了 tick は現在の
   * レートから解析的に予測して heap の離散事象にする(`syncCodifyCompletionEvent`)。
   * よって新しい概念は 1 つも増えていない —— M6 が予測関数を research と同型に
   * 作っておいた狙い(rules/codify.ts §1)がここで効く。
   */
  codify: 50,
  /** 探索解決([M21] 派遣の帰還・GDD 8.2 / 11.7 段60)。 */
  exploration: 60,
  /**
   * [M11] 晴天漂着による加入(GDD 7.7)。**GDD 11.7 の一覧に無い段**であり、
   * 予約番号 60〜70 の間に置いた解釈である(裁定 B1 と同種の GDD 側の穴)。
   * 根拠は 2 つ:
   *   (a) 探索での保護(段60)も加入経路なので、加入系をまとめて置ける
   *   (b) **死亡判定(段70)より前**でなければ、GDD 7.6 の「6未満なら次回加入
   *       イベントを前倒し確定」による同一 tick の救済が成立しない
   *       (加入で人口が増えた後に死亡ゲートを評価する順序になる)
   */
  arrival: 65,
  /** 死亡/全滅判定([M11] 寿命死・GDD 11.7 段70)。 */
  death: 70,
  /**
   * [M25] 衛星供給(GDD 9.2 / 11.7 段80)。`rules/outpost.ts` の
   * `applyOutpostSupply` は生産(段30)と同じく**区間の閉形式積分**であって
   * 離散イベントではないので、`SchedulerEventKind` は増やさず §6 の (A) 区間
   * 積分ブロックへ生産・研究・bond・mastery と並べて畳み込む(下記 §6 参照)。
   * この定数は「同一 tick 内優先順位における位置」の予約番号として残す。
   */
  satellite: 80,
  /** 幕塵メーター更新(未実装)。 */
  dust: 90,
} as const;

/** 離散事象の種類(T5 の 3 種 + M11 の 2 種 + M21 の 1 種 + M50 の 1 種 + M66 の 1 種)。 */
export type SchedulerEventKind =
  | "codifyComplete"
  | "expeditionReturn"
  | "raid"
  | "recallRecover"
  | "residentArrival"
  | "residentDeath"
  | "stochasticStep"
  | "researchComplete";

const STAGE_BY_KIND: { readonly [K in SchedulerEventKind]: number } = {
  codifyComplete: PIPELINE_STAGE.codify,
  expeditionReturn: PIPELINE_STAGE.exploration,
  raid: PIPELINE_STAGE.raid,
  recallRecover: PIPELINE_STAGE.recallRecover,
  residentArrival: PIPELINE_STAGE.arrival,
  residentDeath: PIPELINE_STAGE.death,
  stochasticStep: PIPELINE_STAGE.recallRoll,
  researchComplete: PIPELINE_STAGE.research,
};

/** GDD 11.8 の区間分類における境界の種別。 */
export type BoundaryClass =
  /** (B) レート変化イベント。 */
  | "rateChange"
  /** (C) 確率イベント区間の境界(粗粒度ステップ)。 */
  | "stochastic"
  /** 区間分類ではなく advance の終端(toTick)。 */
  | "horizon";

/**
 * イベント種別 → 境界の分類(§1)。
 *
 * `recallRecover` が (B) に分類される点が (C) との噛み合いの要: 発生自体は (C) の
 * 抽選結果だが、**回復 tick で生産レートが戻る**のでレート変化イベントである。
 */
export function classifyEventBoundary(kind: SchedulerEventKind): BoundaryClass {
  switch (kind) {
    // [M11] `residentArrival` は就労可能な住民を増やし、`residentDeath` は減らす。
    // どちらも次の区間の生産レートを変える = (B) レート変化イベントである。
    // [M21] `expeditionReturn` は派遣者を本拠へ戻し(dispatchW が外れ、就労可能に
    // なる)報酬を在庫へ入れるので、同じく (B) レート変化イベントである。
    // [M50] `codifyComplete` は成文化キューの先頭を次のジョブへ進める(= 学者の
    // 作業が向かう先が変わる)ので、`researchComplete` と同じ (B) である。
    // [M66] `raid` は撃退に失敗すると在庫が減る = 次の区間の建設可否が変わるが、
    // **生産レートそのものは変えない**。それでも (B) に分類するのは、この分類が
    // 「(C) の粗粒度ステップかどうか」を区別するためのものであり、確率抽選を
    // 伴いつつ (C) のグリッドに載らない襲撃は (B) 側に置くのが自然だからである
    // (区間の切れ方は同じ)。
    case "codifyComplete":
    case "expeditionReturn":
    case "raid":
    case "recallRecover":
    case "researchComplete":
    case "residentArrival":
    case "residentDeath":
      return "rateChange";
    case "stochasticStep":
      return "stochastic";
    default: {
      const unhandled: never = kind;
      throw new SchedulerError(`未知のイベント種別 ${String(unhandled)}`);
    }
  }
}

/** 離散事象 1 件。`entityId` は対象 entity(粗粒度ステップは対象なしの null)。 */
export interface ScheduledEvent {
  readonly tick: number;
  readonly kind: SchedulerEventKind;
  readonly entityId: EntityId | null;
}

/** tie-break キーの文字列表現(重複検出用・§3)。 */
function eventKeyOf(event: ScheduledEvent): string {
  return `${String(event.tick)}|${String(STAGE_BY_KIND[event.kind])}|${event.entityId ?? ""}`;
}

/**
 * イベントの全順序比較(§3)。(tick, パイプライン段, entityId) の 3 段。
 * 3 つ組が同じイベントは同時に存在できない({@link EventQueue} が拒否する)ので、
 * この比較で 0 が返るのは同一イベントを自分自身と比べたときだけ。
 */
export function compareScheduledEvents(a: ScheduledEvent, b: ScheduledEvent): number {
  if (a.tick !== b.tick) return a.tick < b.tick ? -1 : 1;
  const stageA = STAGE_BY_KIND[a.kind];
  const stageB = STAGE_BY_KIND[b.kind];
  if (stageA !== stageB) return stageA < stageB ? -1 : 1;
  return compareUtf16(a.entityId ?? "", b.entityId ?? "");
}

// --- 3. 離散事象ヒープ -----------------------------------------------------

/**
 * 二分ヒープ(最小ヒープ)。比較は {@link compareScheduledEvents} の全順序なので、
 * 取り出し順は内部配置に依存しない(§3)。
 *
 * ADR-028(1) の「生スプレッド禁止」は state のサブツリー複製が対象であり、
 * このヒープの in-place swap は eslint.config.js の (g) で明示的に対象外とされて
 * いる(ヒープは state に載らない advance 中の一時構造)。
 */
export class EventQueue {
  private readonly heap: ScheduledEvent[] = [];
  private readonly keys = new Set<string>();

  get size(): number {
    return this.heap.length;
  }

  /** 次に処理されるイベントの tick。空なら null。 */
  peekTick(): number | null {
    const top = this.heap[0];
    return top === undefined ? null : top.tick;
  }

  /** 次に処理されるイベント(取り出さない)。空なら undefined。 */
  peek(): ScheduledEvent | undefined {
    return this.heap[0];
  }

  /**
   * その種別のイベントが入っていれば返す。**同時に 1 件までしか存在しない種別**
   * (T5 では researchComplete)専用で、2 件以上見つかったら実装バグとして止める。
   *
   * @throws {SchedulerError} 同種別が 2 件以上ある場合
   */
  findByKind(kind: SchedulerEventKind): ScheduledEvent | undefined {
    let found: ScheduledEvent | undefined;
    for (const event of this.heap) {
      if (event.kind !== kind) continue;
      if (found !== undefined) {
        throw new SchedulerError(
          `種別 ${kind} のイベントが 2 件以上ある(findByKind は単一前提・実装バグ)`,
        );
      }
      found = event;
    }
    return found;
  }

  /**
   * その (tick, 段, entityId) のイベントが既に入っているか。
   *
   * [M13] 想起困難が (住民, tech) 別になったため、**同じ住民の別 tech が同じ tick に
   * 回復する**ことが起きる。回復イベントは状態遷移を持たない純粋な区間境界
   * (rules/recall.ts 末尾)なので、同じキーは 1 本あれば足りる。重複 push は
   * §3 の全順序を壊すので、呼び出し側はここで存在を確かめてから積む。
   */
  hasEvent(event: ScheduledEvent): boolean {
    return this.keys.has(eventKeyOf(event));
  }

  /**
   * イベントを積む。
   *
   * @throws {SchedulerError} tick が安全整数でない場合、または (tick, 段, entityId)
   *   が既存イベントと同一の場合(全順序が崩れるため・§3)
   */
  push(event: ScheduledEvent): void {
    if (!Number.isSafeInteger(event.tick) || event.tick < 0) {
      throw new SchedulerError(`イベントの tick ${String(event.tick)} が 0 以上の整数でない`);
    }
    const key = eventKeyOf(event);
    if (this.keys.has(key)) {
      throw new SchedulerError(
        `イベント (tick=${String(event.tick)}, kind=${event.kind}, entityId=${event.entityId ?? "-"}) が重複している` +
          `(tie-break の全順序が崩れるため禁止・§3)`,
      );
    }
    this.keys.add(key);
    this.heap.push(event);
    this.siftUp(this.heap.length - 1);
  }

  /**
   * イベント処理中の再予約。**必ず未来の tick** でなければならない
   * (同 tick への再予約を許すとループが進まなくなる)。
   *
   * @throws {SchedulerError} tick が cursorTick 以下の場合
   */
  pushAfter(event: ScheduledEvent, cursorTick: number): void {
    if (event.tick <= cursorTick) {
      throw new SchedulerError(
        `tick ${String(cursorTick)} の処理中に tick ${String(event.tick)} のイベントを予約した` +
          `(同 tick 以前への再予約は進行が止まるため禁止)`,
      );
    }
    this.push(event);
  }

  /**
   * 先頭を取り出す。
   *
   * @throws {SchedulerError} 空の場合
   */
  pop(): ScheduledEvent {
    const top = this.heap[0];
    if (top === undefined) {
      throw new SchedulerError("空のヒープから pop した");
    }
    this.keys.delete(eventKeyOf(top));
    const last = this.heap.pop();
    if (last !== undefined && this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** 同じ (kind, entityId) のイベントを取り除く(無ければ何もしない)。 */
  remove(kind: SchedulerEventKind, entityId: EntityId | null): void {
    const remaining: ScheduledEvent[] = [];
    for (const event of this.heap) {
      if (event.kind === kind && event.entityId === entityId) {
        this.keys.delete(eventKeyOf(event));
        continue;
      }
      remaining.push(event);
    }
    if (remaining.length === this.heap.length) return;
    this.heap.length = 0;
    for (const event of remaining) {
      this.heap.push(event);
    }
    // 末尾から順に下げれば O(n) で再ヒープ化できる。
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  /**
   * [M67] その種別のイベントを**全件**返す(取り出さない)。`findByKind` と違い
   * 複数件を許す種別(researchComplete は実地要件待ちで同時に複数ありうる)の
   * 同期に使う。返す順序はヒープの内部配置に依らないよう全順序でソートする。
   */
  entriesOfKind(kind: SchedulerEventKind): readonly ScheduledEvent[] {
    const found: ScheduledEvent[] = [];
    for (const event of this.heap) {
      if (event.kind === kind) found.push(event);
    }
    return found.sort(compareScheduledEvents);
  }

  /** 全イベントを処理順(全順序)で返す。テスト・診断用(キューは空になる)。 */
  drainSorted(): readonly ScheduledEvent[] {
    const result: ScheduledEvent[] = [];
    while (this.heap.length > 0) {
      result.push(this.pop());
    }
    return result;
  }

  private siftUp(from: number): void {
    let index = from;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const child = this.heap[index];
      const above = this.heap[parent];
      if (child === undefined || above === undefined) break;
      if (compareScheduledEvents(child, above) >= 0) break;
      this.heap[index] = above;
      this.heap[parent] = child;
      index = parent;
    }
  }

  private siftDown(from: number): void {
    let index = from;
    const length = this.heap.length;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      let smallest = left;
      const leftEvent = this.heap[left];
      const rightEvent = right < length ? this.heap[right] : undefined;
      if (
        leftEvent !== undefined &&
        rightEvent !== undefined &&
        compareScheduledEvents(rightEvent, leftEvent) < 0
      ) {
        smallest = right;
      }
      const current = this.heap[index];
      const candidate = this.heap[smallest];
      if (current === undefined || candidate === undefined) break;
      if (compareScheduledEvents(candidate, current) >= 0) break;
      this.heap[index] = candidate;
      this.heap[smallest] = current;
      index = smallest;
    }
  }
}

// --- 4. キューの再構成(state から) ---------------------------------------

/**
 * state から離散事象キューを組み立てる。**セーブに eventQueueSnapshot を持たず、
 * 毎回ここで再構成する**(state.ts §4 の設計判断)。
 *
 * 積むのは 4 種:
 *   (C) 粗粒度ステップ — tick の絶対グリッド上で state.tick 以降の最初の 1 個
 *       (以降はステップ処理の中で次を予約する)
 *   (B) 想起困難の回復 — `recallImpairedUntilTick` が未来の住民ぶん
 *   (B) [M11] 寿命死 — `life` を持つ生存住民の死亡 tick ぶん
 *   (B) [M11] 晴天漂着 — 加入グリッド上で state.tick 以降の最初の 1 個
 * 研究完了 (B) は**レート依存**なので、区間ごとに
 * {@link syncResearchCompletionEvent} が予測して同期する。
 *
 * `toTick` 以降のイベントは積まない(この advance では処理されないため。
 * 次回の advance で state から再構成される)。
 *
 * **死亡だけは「既に過ぎている」場合も積む**(`max(死亡tick, state.tick)`)。
 * 回復イベントは状態遷移を持たないので取りこぼしても state が食い違わないが
 * (rules/recall.ts 末尾)、死亡は state を変えるので取りこぼすと分割不変性が
 * 壊れる。ちょうど死亡 tick で advance を区切ると、前半は `< toTick` に掛からず
 * 積まれず、後半は `state.tick == 死亡tick` で積まれてその場で発火する
 * = 一括で進めた場合と一致する。
 */
export function buildEventQueue(state: GameState, ctx: AdvanceContext, toTick: number): EventQueue {
  const queue = new EventQueue();

  const firstStep = nextCoarseStepTickAtOrAfter(state.tick, ctx.content.coarseTickMinutes);
  if (firstStep < toTick) {
    queue.push({ tick: firstStep, kind: "stochasticStep", entityId: null });
  }

  for (const resident of entitiesOfKind(state, "resident")) {
    const until = resident.recallImpairedUntilTick;
    if (until > state.tick && until < toTick) {
      pushRecallRecover(queue, until, resident.id);
    }
    // [M11] 寿命を持たない住民(既存 conformance シナリオの全員)は死なない。
    if (resident.life === undefined || !isAliveResident(resident)) continue;
    const dieAt = Math.max(deathTickOf(resident.life), state.tick);
    if (dieAt < toTick) {
      queue.push({ tick: dieAt, kind: "residentDeath", entityId: resident.id });
    }
  }

  // [M13] (住民, tech) 別の想起困難の回復(GDD 11.2 の本式・rules/techMemory.ts)。
  // キーは `"residentId|techId"` で反復順はキー昇順(state.ts 不変条件 (f))。
  // 同じ住民の複数 tech が同じ tick に回復する場合は境界 1 本に畳む。
  for (const key of techMemoryKeys(state)) {
    const memory = getTechMemory(state, key);
    if (memory === undefined) continue;
    const until = memory.impairedUntilTick;
    if (until <= state.tick || until >= toTick) continue;
    const residentId = techMemoryResidentIdOf(key);
    if (residentId === null) continue;
    pushRecallRecover(queue, until, residentId);
  }

  // [M21] 探索の帰還(GDD 11.7 段60)。**死亡と同じく「既に過ぎている」場合も積む**
  // (`max(帰還tick, state.tick)`): 帰還は state を変える(報酬・派遣解除・脱落)ので
  // 取りこぼすと分割不変性が壊れる。ちょうど帰還 tick で advance を区切った場合、
  // 前半は `< toTick` に掛からず積まれず、後半は `state.tick == 帰還tick` で
  // 積まれてその場で発火する = 一括で進めた場合と一致する。
  for (const snapshot of state.dispatchSnapshots) {
    const returnAt = Math.max(snapshot.returnTick, state.tick);
    if (returnAt < toTick) {
      queue.push({ tick: returnAt, kind: "expeditionReturn", entityId: snapshot.id });
    }
  }

  // [M11] 晴天漂着。加入機構が不活性(寝床上限 0 / townParams 不在)なら null。
  const arrivalTick = nextArrivalTick(state, ctx.content, state.tick);
  if (arrivalTick !== null && arrivalTick < toTick) {
    queue.push({ tick: arrivalTick, kind: "residentArrival", entityId: null });
  }

  // [M66] 襲撃(GDD 11.7 段10)。晴天漂着と同じ絶対グリッド方式なので、
  // state にカウンタを持たずに次の判定 tick が決まる(rules/raid.ts §1(e))。
  // content に raid ブロックが無ければ null = 一度も積まれない。
  const raidTick = nextRaidTick(ctx.content, state.tick);
  if (raidTick !== null && raidTick < toTick) {
    queue.push({ tick: raidTick, kind: "raid", entityId: null });
  }

  return queue;
}

/**
 * [M13] `"residentId|techId"` の住民 ID 部分。形式が違えば null
 * (engine 内で作られるキーは必ず `techMemoryKeyOf` を通るので通常は起きない。
 * セーブ側の形式検査は serialize.ts の担当)。
 */
function techMemoryResidentIdOf(key: string): EntityId | null {
  const separator = key.indexOf("|");
  if (separator <= 0) return null;
  return key.slice(0, separator) as EntityId;
}

/**
 * [M13] 想起困難の回復境界を積む(同じキーが既にあれば何もしない)。
 * 回復は状態遷移を持たない純粋な区間境界なので、1 本に畳んで問題ない
 * ({@link EventQueue.hasEvent} の doc)。
 */
function pushRecallRecover(
  queue: EventQueue,
  tick: number,
  residentId: EntityId,
  cursorTick?: number,
): void {
  const event: ScheduledEvent = { tick, kind: "recallRecover", entityId: residentId };
  if (queue.hasEvent(event)) return;
  if (cursorTick === undefined) {
    queue.push(event);
    return;
  }
  queue.pushAfter(event, cursorTick);
}

/**
 * 研究完了 (B) の予測イベントを現在レートに合わせて同期する。
 *
 * レートは区間ごとに変わり得る(就労者が想起困難で落ちる等)ので、
 *   - 予測 tick が変わっていたら古いイベントを取り除いて積み直す
 *   - レート 0 / 全研究完了なら取り除くだけ
 * とする。
 *
 * 予測は通常カーソルより先だが、**カーソルと同 tick になる場合がある**:
 * 進行度が既にコストへ達している state(完了 tick ちょうどで advance を区切った
 * 場合など・rules/research.ts の ticksUntilResearchComplete 参照)。この場合は
 * 現在 tick で完了させることが分割不変性の要件であり、処理すれば次の研究へ移る
 * ので進行は止まらない(§2)。だから `pushAfter` ではなく `push` を使う。
 */
export function syncResearchCompletionEvent(
  queue: EventQueue,
  state: GameState,
  ctx: AdvanceContext,
  research: ResearchState | undefined,
  rates: ProductionRates,
  cursorTick: number,
): void {
  // 望ましいイベント集合(entityId → tick)。M67 以前は常に高々 1 件だった。
  const desired = new Map<EntityId, number>();
  if (research !== undefined) {
    // [M67] 完了は「研究点満了」と「実地要件充足」の **遅い方**(rules/research.ts §3)。
    // 実地要件の蓄積レートも同じ (A) 区間のレート(`rates.fieldRunGains`)なので、
    // 区間ごとに作り直すだけで済む = 新しい種類の境界は増えない。
    const ticks = ticksUntilResearchCompleteGated(
      researchRemaining(ctx.content, research),
      rates.researchRateFix,
      fieldRequirementRemaining(state, ctx.content, research),
      fieldRunRateOf(rates, research.techId),
    );
    if (ticks !== null) desired.set(research.id, cursorTick + ticks);
  }
  // [M67] 研究点は満了したが実地要件待ちの研究(= 点の行き先からは外れている)も
  // 完了だけはする。要件が満ちる tick は同じ閉形式で求まる(rules/research.ts §3)。
  for (const blocked of fieldBlockedResearches(state, ctx.content)) {
    if (desired.has(blocked.id)) continue;
    const ticks = ticksUntilFieldRequirement(
      fieldRequirementRemaining(state, ctx.content, blocked),
      fieldRunRateOf(rates, blocked.techId),
    );
    if (ticks !== null) desired.set(blocked.id, cursorTick + ticks);
  }

  for (const existing of queue.entriesOfKind("researchComplete")) {
    const wanted = existing.entityId === null ? undefined : desired.get(existing.entityId);
    if (wanted === existing.tick) {
      // 既に正しい tick で積まれている。二重 push を避けるため望み集合から外す。
      if (existing.entityId !== null) desired.delete(existing.entityId);
      continue;
    }
    queue.remove("researchComplete", existing.entityId);
  }
  for (const [entityId, tick] of desired) {
    queue.push({ tick, kind: "researchComplete", entityId });
  }
}

/**
 * [M67] その tech の実地稼働レート(`ProductionRates.fieldRunGains` は techId 昇順の
 * 小さな配列。該当が無ければ 0 = 実地要件が進まない)。
 */
function fieldRunRateOf(rates: ProductionRates, techId: EntityId): Fix {
  for (const gain of rates.fieldRunGains) {
    if (gain.techId === techId) return gain.gainPerTickFix;
  }
  return FIX_ZERO;
}

/**
 * [M50] 成文化完了 (B) の予測イベントを現在レートに合わせて同期する。
 *
 * {@link syncResearchCompletionEvent} と**同じ構造・同じ規約**である
 * (rules/codify.ts §1 が予測関数を research と同型に作ってある狙い):
 *   - 予測 tick が変わっていたら古いイベントを取り除いて積み直す
 *   - レート 0(学者が 1 人も稼働していない)/ キューが空なら取り除くだけ
 *   - 予測がカーソルと同 tick になる場合があるので `push`(`pushAfter` ではない)
 *
 * `buildEventQueue` で積まない理由も研究完了と同じ: 完了 tick は**レート依存**
 * であり、区間ごとに作り直さなければ「学者が想起困難で落ちた」等でレートが
 * 変わったときに予測が古いまま残る。
 */
export function syncCodifyCompletionEvent(
  queue: EventQueue,
  codify: CodifyState | undefined,
  rates: ProductionRates,
  cursorTick: number,
): void {
  let desiredTick: number | null = null;
  if (codify !== undefined) {
    const ticks = ticksUntilCodifyComplete(codifyRemaining(codify), rates.codifyLaborFix);
    if (ticks !== null) desiredTick = cursorTick + ticks;
  }

  const existing = queue.findByKind("codifyComplete");
  if (
    existing !== undefined &&
    existing.tick === desiredTick &&
    existing.entityId === (codify?.id ?? null)
  ) {
    return;
  }
  if (existing !== undefined) queue.remove("codifyComplete", existing.entityId);
  if (desiredTick !== null && codify !== undefined) {
    queue.push({ tick: desiredTick, kind: "codifyComplete", entityId: codify.id });
  }
}

// --- 5. 区間の記録 ---------------------------------------------------------

/** 1 つの (A) 区間の記録(区間分類の可視化・計測・テスト用)。 */
export interface SegmentRecord {
  readonly fromTick: number;
  /** 半開区間の終端(この tick は含まない・§2)。 */
  readonly toTick: number;
  /** 区間を切った理由。 */
  readonly endBoundary: BoundaryClass;
  /** 終端で処理されたイベント種別(全順序による処理順)。horizon なら空。 */
  readonly endEventKinds: readonly SchedulerEventKind[];
}

/** {@link runSchedule} の結果と、計測に使うカウンタ。 */
export interface ScheduleReport {
  readonly state: GameState;
  /** (A) 区間の本数(長さ 0 の区間は数えない)。 */
  readonly segmentCount: number;
  /** 処理した (C) 粗粒度ステップの回数。 */
  readonly stochasticStepCount: number;
  /** 引いたベルヌーイ試行の総数(ADR-014 の 138,240 判定/run の実測値)。 */
  readonly stochasticTrialCount: number;
  /** 処理した (B) レート変化イベントの件数。 */
  readonly rateChangeEventCount: number;
  /** 新規に発生した想起困難の件数(計測 #5 の頻度の分子)。 */
  readonly recallOccurrenceCount: number;
  /** [M11] 晴天漂着で実際に加入した人数(判定回数ではない)。 */
  readonly residentArrivalCount: number;
  /** [M11] 実際に死亡した人数。 */
  readonly residentDeathCount: number;
  /**
   * [M11] 人口下限の保持で**延期された**死亡の件数(GDD 7.6・
   * rules/population.ts §3)。同じ住民が複数回延期されれば複数回数える。
   */
  readonly deferredDeathCount: number;
  /**
   * [M13] 死亡によって喪失した技術の件数(GDD 7.4 の (A)+(B) 合計)。
   * golden vector のカウンタ 5 種には**入れない**(conformance/goldenVector.ts の
   * `countersOfReport` は固定 5 フィールド)。観測は #5 再計測(M14)と単体テスト。
   */
  readonly techLossCount: number;
  /** [M13] うち (B) rareIrreversible = 永久喪失の件数。 */
  readonly irreversibleTechLossCount: number;
  /** [M21] 帰還解決した派遣の本数(GDD 11.7 段60)。 */
  readonly expeditionReturnCount: number;
  /** [M21] 探索で脱落した人数(段70 の死亡ゲートへ渡した件数。延期されうる)。 */
  readonly explorationCasualtyCount: number;
  /** [M21] 探索での保護で加入した人数(GDD 7.7・晴天漂着とは別口)。 */
  readonly explorationRescueCount: number;
  /**
   * [M50] 完成した記録の枚数(GDD 11.7 段50)。golden vector のカウンタ 5 種には
   * **入れない**(`conformance/goldenVector.ts` の `countersOfReport` は固定 5
   * フィールド・`techLossCount` と同じ扱い)。観測は単体テストと、完成が
   * `rateChangeEventCount` を 1 増やすことによる既存カウンタ経由。
   */
  readonly codificationCompleteCount: number;
  /**
   * [M66] 解決した襲撃の回数(GDD 11.7 段10)。golden vector のカウンタ 5 種には
   * **入れない**(`conformance/goldenVector.ts` の `countersOfReport` は固定 5
   * フィールド・`techLossCount` と同じ扱い)。襲撃は `rateChangeEventCount` を
   * 1 増やすので既存カウンタ経由でも観測できる。
   */
  readonly raidCount: number;
  /** [M66] うち撃退できた回数(GDD 11.1 の「勝敗」の勝ち側)。 */
  readonly raidRepelledCount: number;
  /** `collectSegments` を有効にしたときだけ非空。 */
  readonly segments: readonly SegmentRecord[];
}

/** {@link runSchedule} のオプション。 */
export interface ScheduleOptions {
  /**
   * (A) 区間の記録を集めるか(既定 false)。72h catch-up で 400〜500 件程度の
   * 小さなオブジェクトになるが、夜間 sim の内側ループでは不要なので既定は off
   * (ADR-029(1) のアロケーション有界化の趣旨)。
   */
  readonly collectSegments?: boolean;
}

// --- 6. 本体 ---------------------------------------------------------------

/**
 * 半開区間 [state.tick, toTick) を進める(§2)。
 *
 * 手順(1 反復 = 1 区間):
 *   1. 現在の state からレートを計算する((A) 区間の入口)
 *   2. 研究完了 (B) の予測を現在レートで同期する
 *   3. 次のイベント tick と toTick の小さい方を境界にする
 *   4. 境界まで (A) の閉形式で積分し、カーソルを進める
 *   5. 境界の tick を持つイベントを全順序(§3)の順で処理する
 *
 * @throws {SchedulerError} toTick が state.tick より小さい / 整数でない場合
 */
export function runSchedule(
  state: GameState,
  ctx: AdvanceContext,
  toTick: number,
  options: ScheduleOptions = {},
): ScheduleReport {
  if (!Number.isSafeInteger(toTick) || toTick < 0) {
    throw new SchedulerError(`runSchedule: toTick ${String(toTick)} が 0 以上の整数でない`);
  }
  if (toTick < state.tick) {
    throw new SchedulerError(
      `runSchedule: toTick ${String(toTick)} が現在 tick ${String(state.tick)} より小さい(時間は巻き戻せない)`,
    );
  }

  const collectSegments = options.collectSegments === true;
  const segments: SegmentRecord[] = [];
  let next = state;
  let segmentCount = 0;
  let stochasticStepCount = 0;
  let stochasticTrialCount = 0;
  let rateChangeEventCount = 0;
  let recallOccurrenceCount = 0;
  let residentArrivalCount = 0;
  let residentDeathCount = 0;
  let deferredDeathCount = 0;
  let techLossCount = 0;
  let irreversibleTechLossCount = 0;
  let expeditionReturnCount = 0;
  let explorationCasualtyCount = 0;
  let explorationRescueCount = 0;
  let codificationCompleteCount = 0;
  let raidCount = 0;
  let raidRepelledCount = 0;

  if (toTick === state.tick) {
    return {
      state: next,
      segmentCount,
      stochasticStepCount,
      stochasticTrialCount,
      rateChangeEventCount,
      recallOccurrenceCount,
      residentArrivalCount,
      residentDeathCount,
      deferredDeathCount,
      techLossCount,
      irreversibleTechLossCount,
      expeditionReturnCount,
      explorationCasualtyCount,
      explorationRescueCount,
      codificationCompleteCount,
      raidCount,
      raidRepelledCount,
      segments,
    };
  }

  const queue = buildEventQueue(state, ctx, toTick);
  let cursor = state.tick;

  while (cursor < toTick) {
    const segmentStart = cursor;

    // 1〜2. (A) 区間の入口: レート確定 → (B) 予測の同期。
    const rates = computeProductionRates(next, ctx);
    // [M67] 研究点の行き先は「点が満了し実地要件待ち」の研究を飛ばす
    // (rules/research.ts §3)。content に research ブロックが無ければ従来と同一。
    const researchTarget = currentResearch(next, ctx.content);
    // [M12/M13] bond(共働の絆)も同じ (A) 区間のレートである。生産と同じ位置で
    // 1 回だけ確定させる(区間中に共働の顔ぶれが変わらないことが (A) の前提)。
    const bondRates = computeBondRates(next, cursor);
    // [M25] 衛星供給(GDD 9.2 / 11.7 段80・PIPELINE_STAGE.satellite)も同じ (A)
    // 区間のレートである。翳り率は幕塵メーター(段90)が未実装のため既定の
    // FIX_ZERO(rules/outpost.ts §3)。常駐人数/拠点Lvは Command 経由でしか
    // 変わらない(このタスクは scheduler 内に配置/常駐コマンドを持たない)ので、
    // production と同じく区間内で変化しない = 境界イベントを新設する必要がない。
    const outpostRates = computeOutpostSupplyRates(next, ctx.content);
    // [M72] 士気(GDD 11.2 / 7.2)も bond と同じ (A) 区間のレートである。
    // レートを決める入力(配属・派遣・休養・生死)はすべて既存の区間境界でしか
    // 変わらないので、新しい境界イベントは 1 つも増えない(rules/morale.ts §3)。
    // `content.morale` が無ければ常に空 = M72 以前と 1 bit も違わない。
    const moraleRates = computeMoraleRates(next, ctx.content, cursor);
    // [M50] 成文化(GDD 11.7 段50)。研究と同じ「区間の入口でレート確定 →
    // (B) 予測を同期」の 2 段(rules/codify.ts §1)。
    const codifyTarget = currentCodification(next);
    syncResearchCompletionEvent(queue, next, ctx, researchTarget, rates, cursor);
    syncCodifyCompletionEvent(queue, codifyTarget, rates, cursor);

    // 3. 境界の決定。イベントが toTick 以降なら地平線で切る。
    const eventTick = queue.peekTick();
    const boundary = eventTick === null || eventTick > toTick ? toTick : eventTick;

    // 4. (A) の閉形式で積分(区間長 = boundary - cursor tick ぶん)。
    if (boundary > cursor) {
      const delta = boundary - cursor;
      next = applyProduction(next, rates, delta);
      if (researchTarget !== undefined) {
        next = applyResearchProgress(next, researchTarget.id, rates.researchRateFix, delta);
      }
      // [M50] 成文化の作業進行(GDD 11.1「学者作業時間」)。生産・研究と同じ
      // 「レート × 区間長」の閉形式(rules/codify.ts の applyCodifyProgress)で
      // あり、離散イベントは完了(段50)だけである。キューが空 = 記録を 1 枚も
      // 作っていない盤面では no-op(既存 golden シナリオはすべてこれ)。
      if (codifyTarget !== undefined) {
        next = applyCodifyProgress(next, codifyTarget.id, rates.codifyLaborFix, delta);
      }
      // [M12] bond の蓄積と節目の記録(GDD 7.3)。節目の記録 tick は区間内の
      // **解析的な到達 tick** なので分割不変(rules/bond.ts の crossingsInInterval)。
      next = applyBondProgress(next, bondRates, delta, boundary);
      // [M72] 士気の積分(GDD 11.2 の moraleW の入力)。bond と同型の閉形式で、
      // クランプ(上限 100 / 業務由来の下限 routineFloor)が単調なので分割不変。
      next = applyMoraleProgress(next, moraleRates, delta);
      // [M13] 実地稼働による定着度の蓄積(GDD 11.2 / 4)。生産と同じレート×区間長。
      next = applyMasteryProgress(next, ctx.content, rates.masteryGains, delta);
      // [M67] 実地要件(GDD 5.2 の第2ゲート)の稼働蓄積。定着とまったく同じ
      // 「レート × 区間長」の閉形式(rules/techMemory.ts §4b)であり、完了 tick の
      // 予測(段40)が max(研究点満了, 実地要件充足)へ広がっただけで境界は増えない。
      next = applyFieldRunProgress(next, rates.fieldRunGains, delta);
      // [M25] 衛星供給(GDD 9.2 / 11.7 段80)。生産と同じ「レート × 区間長」の
      // 閉形式(rules/outpost.ts の applyOutpostSupply)。既存 golden シナリオは
      // 拠点ゼロなので outpostRates.resourceRateByResourceId は常に空 = no-op。
      next = applyOutpostSupply(next, outpostRates, delta);
      next = setField(next, "tick", boundary);
      cursor = boundary;
      segmentCount++;
    }

    // tick == toTick のイベントは処理しない(§2 の半開区間規約)。
    if (cursor >= toTick) {
      if (collectSegments && boundary > segmentStart) {
        segments.push({
          fromTick: segmentStart,
          toTick: boundary,
          endBoundary: "horizon",
          endEventKinds: [],
        });
      }
      break;
    }

    // 5. 境界のイベントを全順序(§3)の順に処理する。
    const processed: SchedulerEventKind[] = [];
    while (queue.peekTick() === cursor) {
      const event = queue.pop();
      processed.push(event.kind);
      switch (event.kind) {
        case "stochasticStep": {
          const result = evaluateRecallCoarseStep(next, ctx, cursor);
          next = result.state;
          stochasticStepCount++;
          stochasticTrialCount += result.trialCount;
          recallOccurrenceCount += result.occurrences.length;
          // 発生した想起困難の回復は (C) が生んだ (B) 境界(§1)。
          // 地平線より後のものは積まない(次回の advance が state から再構成する)。
          for (const occurrence of result.occurrences) {
            if (occurrence.untilTick >= toTick) continue;
            // [M13] 同じ住民の別 tech が同じ tick に回復する場合は境界 1 本に畳む。
            pushRecallRecover(queue, occurrence.untilTick, occurrence.residentId, cursor);
          }
          const nextStep = cursor + ctx.content.coarseTickMinutes;
          if (nextStep < toTick) {
            queue.pushAfter({ tick: nextStep, kind: "stochasticStep", entityId: null }, cursor);
          }
          break;
        }
        case "raid": {
          // [M66] 襲撃判定(GDD 11.7 段10)。撃退に失敗すると在庫の一部が
          // 略奪される(住民は死なない = GDD 11.1 の全滅回避フェイルセーフ・
          // rules/raid.ts §1(d))。次の判定 tick は必ず積み直す(周期グリッドを
          // 切らさない —— 晴天漂着と同じ規約)。
          const raidResult = resolveRaid(next, ctx, cursor);
          next = raidResult.state;
          rateChangeEventCount++;
          raidCount++;
          if (raidResult.repelled) raidRepelledCount++;
          const nextRaid = nextRaidTick(ctx.content, cursor + 1);
          if (nextRaid !== null && nextRaid < toTick) {
            queue.pushAfter({ tick: nextRaid, kind: "raid", entityId: null }, cursor);
          }
          break;
        }
        case "recallRecover": {
          // **状態は変えない。** このイベントは (A) 区間を切るためだけに存在する
          // (回復は `recallImpairedUntilTick` と tick の比較で表現され、フラグを
          // 0 に戻すと分割不変性が壊れる。理由は rules/recall.ts 末尾のコメント)。
          // 境界として存在することで、次の区間のレートが就労者復帰後の値になる。
          requireEventEntityId(event);
          rateChangeEventCount++;
          break;
        }
        case "researchComplete": {
          next = completeResearch(next, ctx.content, requireEventEntityId(event), cursor);
          rateChangeEventCount++;
          break;
        }
        case "codifyComplete": {
          // [M50] 記録 1 枚の完成(GDD 11.7 段50)。研究完了と同じく**この tick 以降
          // の区間から**次のジョブへレートが向く。完成した記録は
          // `isCodified`(rules/codify.ts §3)を通じて技術喪失判定(GDD 7.4 /
          // 11.1 追補の焼失セマンティクス)へ効くが、それは段70(死亡)側が
          // 都度読む値なので、ここで追加の状態遷移は要らない。
          next = completeCodification(next, requireEventEntityId(event), cursor);
          rateChangeEventCount++;
          codificationCompleteCount++;
          break;
        }
        case "residentArrival": {
          // [M11] 晴天漂着(GDD 7.7)。寝床が埋まっていれば判定だけ行って誰も
          // 増えないが、次の判定 tick は必ず積み直す(周期の grid を切らさない)。
          const result = applyArrival(next, ctx, cursor);
          next = result.state;
          rateChangeEventCount++;
          if (result.arrivedId !== null) {
            residentArrivalCount++;
            // **加入した住民の死亡イベントをその場で積む。** buildEventQueue は
            // advance の入口で 1 回しか走らないので、ここで積まないと「この
            // advance の中で生まれて死ぬはずだった住民」の死亡が丸ごと落ちる
            // (= 一括で進めた場合と刻んで進めた場合で state が食い違う)。
            // createResidentLife が「必ず 1 tick 以上生きる」を保証しているので
            // 死亡 tick は必ず cursor より後 = pushAfter の前提を満たす。
            const arrived = requireEntity(next, result.arrivedId, "resident");
            if (arrived.life !== undefined) {
              const dieAt = deathTickOf(arrived.life);
              if (dieAt < toTick) {
                queue.pushAfter(
                  { tick: dieAt, kind: "residentDeath", entityId: result.arrivedId },
                  cursor,
                );
              }
            }
          }
          const followUp = nextArrivalTick(next, ctx.content, cursor + 1);
          if (followUp !== null && followUp < toTick) {
            queue.pushAfter({ tick: followUp, kind: "residentArrival", entityId: null }, cursor);
          }
          break;
        }
        case "expeditionReturn": {
          // [M21] 探索の帰還(GDD 8.2 / 11.7 段60)。**content を読まない**
          // (結果は派遣確定時のスナップショットに焼き込み済み・
          // rules/exploration.ts §1)。
          const dispatchId = requireEventEntityId(event);
          const resolution = resolveExpedition(next, ctx, dispatchId, cursor);
          next = resolution.state;
          rateChangeEventCount++;
          expeditionReturnCount++;
          explorationRescueCount += resolution.rescuedIds.length;
          // 保護で加入した住民の死亡イベントを積む(晴天漂着と同じ理由:
          // buildEventQueue は advance の入口で 1 回しか走らないため・§6)。
          for (const rescuedId of resolution.rescuedIds) {
            const rescued = requireEntity(next, rescuedId, "resident");
            if (rescued.life === undefined) continue;
            const dieAt = deathTickOf(rescued.life);
            if (dieAt > cursor && dieAt < toTick) {
              queue.pushAfter({ tick: dieAt, kind: "residentDeath", entityId: rescuedId }, cursor);
            }
          }
          // **脱落者はここで殺さない。** 同 tick の段70(死亡/全滅判定)へ回すことで、
          // 人口下限の絶対保証(GDD 7.6 の死亡ゲート)・memoirLog・bond 士気ペナ・
          // 技術喪失(GDD 7.4)の既存経路をそのまま通す(rules/exploration.ts §4)。
          // 段70 は段60 より後なので、同 tick への push で必ずこの周回に処理される。
          for (const casualtyId of resolution.casualtyIds) {
            const deathEvent: ScheduledEvent = {
              tick: cursor,
              kind: "residentDeath",
              entityId: casualtyId,
            };
            explorationCasualtyCount++;
            // 同じ住民の寿命死が既に同 tick で積まれていることがある(全順序が
            // 崩れるので二重には積まない。死亡処理は冪等 = 先に死んでいれば
            // `applyResidentDeath` が died:false を返す)。
            if (!queue.hasEvent(deathEvent)) queue.push(deathEvent);
          }
          break;
        }
        case "residentDeath": {
          // [M11] 寿命死(GDD 7.5)。人口下限を割る死は延期される(GDD 7.6 /
          // rules/population.ts §3)。延期は取り消しではないので、人口が増えうる
          // 唯一の未来 tick = 次の加入 tick へ再予約して取りこぼさない。
          const residentId = requireEventEntityId(event);
          const result = applyResidentDeath(next, ctx, residentId, cursor);
          next = result.state;
          rateChangeEventCount++;
          if (result.died) {
            residentDeathCount++;
            // [M12/M13] 死亡の 3 つの帰結を**この順で**適用する(memoirLog は
            // 追記順がバイト列を決めるので順序が仕様・rules/memoir.ts):
            //   (1) 本人の死亡記録
            //   (2) bond を結んでいた相方の記録 + 一時士気ペナ(GDD 7.3)
            //   (3) 技術喪失((A) は停滞のみ / (B) は永久・GDD 7.4)
            next = recordDeathMemoir(next, residentId, cursor);
            next = applyPartnerLossEffects(next, residentId, cursor);
            const lossResult = applyTechLossOnDeath(next, ctx.content, residentId, cursor);
            next = lossResult.state;
            for (const lost of lossResult.lost) {
              techLossCount++;
              if (lost.irreversible) irreversibleTechLossCount++;
            }
          }
          if (result.deferredByFloor) {
            deferredDeathCount++;
            const retryTick = nextArrivalTick(next, ctx.content, cursor + 1);
            if (retryTick !== null && retryTick < toTick) {
              queue.pushAfter(
                { tick: retryTick, kind: "residentDeath", entityId: residentId },
                cursor,
              );
            }
          }
          break;
        }
        default: {
          const unhandled: never = event.kind;
          throw new SchedulerError(`未知のイベント種別 ${String(unhandled)}`);
        }
      }
    }

    if (collectSegments) {
      const first = processed[0];
      segments.push({
        fromTick: segmentStart,
        toTick: cursor,
        // 同 tick に複数種が来た場合は、全順序で先に処理された種別の分類を記す。
        endBoundary: first === undefined ? "horizon" : classifyEventBoundary(first),
        endEventKinds: processed,
      });
    }
  }

  return {
    state: next,
    segmentCount,
    stochasticStepCount,
    stochasticTrialCount,
    rateChangeEventCount,
    recallOccurrenceCount,
    residentArrivalCount,
    residentDeathCount,
    deferredDeathCount,
    techLossCount,
    irreversibleTechLossCount,
    expeditionReturnCount,
    explorationCasualtyCount,
    explorationRescueCount,
    codificationCompleteCount,
    raidCount,
    raidRepelledCount,
    segments,
  };
}

function requireEventEntityId(event: ScheduledEvent): EntityId {
  if (event.entityId === null) {
    throw new SchedulerError(`イベント ${event.kind} に対象 entity が無い(実装バグ)`);
  }
  return event.entityId;
}
