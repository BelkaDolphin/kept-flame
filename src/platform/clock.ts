// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 単調時刻とフォアグラウンド tick 駆動 — ADR-026 / GDD 11.9
//
// ===========================================================================
// 1. 「タイマー発火回数に依存する経路を 1 つも作らない」の実装形
// ===========================================================================
//   ADR-026 の決定は tick を**単調経過時刻の純関数**として定義することである:
//
//     targetTick = anchorTick + clamp(0, floor((nowMs - anchorMs)/60000), 4320)
//
//   本ファイルの {@link planTick} がその式そのものであり、**引数以外のものを
//   一切読まない純関数**である(内部に「何回目の呼び出しか」という状態が無い)。
//   {@link TickDriver.pump} は「時刻を 1 回読んで planTick に渡す」だけなので、
//   rAF が 60Hz で回ろうが、バックグラウンドタブで 1 分に 1 回へ間引かれようが、
//   同じ時刻に対して同じ結果を返す。
//
//   **カウンタ方式(`tick++` を setInterval で回す)は本ファイルのどこにも無い。**
//   これは規律ではなく構造で保証されている: 駆動側(`schedule`)は「pump を呼べ」
//   という合図しか出せず、pump は合図の回数を数える手段を持たない。
//
// ===========================================================================
// 2. 再アンカー(remainder を捨てない・それでも発火回数非依存)
// ===========================================================================
//   進めた ぶんだけアンカーを**厳密に**進める(`anchorMs += delta * TICK_MS`)。
//   端数 ms は次回へ持ち越されるので、こまめに pump しても放っておいても
//   総 tick 数は変わらない。floor 除算は tick 境界で加法的だからである:
//
//     floor((t - t0)/M) = d1 + floor((t - (t0 + d1*M))/M)   (d1 = floor((t1-t0)/M))
//
//   この等式が「pump の回数が結果に影響しない」ことの数学的な根拠であり、
//   tests/platform/clock.test.ts が 1 回 pump と 600 回 pump の等価性として固定する。
//
//   72h クランプ(4320 tick)が掛かった場合だけは等式が崩れる(クランプは
//   意図的な情報落ちなので当然である)。クランプは**オフライン復帰の上限**で
//   あり(GDD 11.9)、その領域は Worker catch-up 経路(§3)が扱う。
//
// ===========================================================================
// 3. メイン経路と Worker 経路の分岐は「差分の大きさ」だけで決まる
// ===========================================================================
//   `chooseCatchUpRoute`(platform/catchUp.ts)が唯一の判定であり、ここで
//   再実装しない。600 tick を超える差分をメインスレッドで advance すると
//   ADR-019/ADR-029 の予算が黙って破れるため、ストア側も例外にする
//   (`src/ui/store.ts` §4)。よって driver は「メイン経路なら onAdvance、
//   そうでなければ onCatchUpRequired」を呼び分けるだけにしてある。
//
// ===========================================================================
// 4. 巻き戻しの検知(GDD 11.9 / ADR-012)
// ===========================================================================
//   単調時刻ソース(`performance.now()`)が巻き戻ることは仕様上ありえないが、
//   実装差・ページ復元・注入されたテスト用時計では起こりうる。負の経過は
//   engine 側(`elapsedMsToTickDelta`)が 0 に落とすので**進行方向へは絶対に
//   影響しない**。本ファイルはそれを `rewound: true` として観測可能にし、
//   アンカーを現在時刻へ引き直して以後の計測が壊れないようにする。
//
// ===========================================================================
// 5. 駆動源は pump の例外で死なない(R1-A01/A02 の再発防止線)
// ===========================================================================
//   `defaultTickScheduler` の rAF ループは「pump した後に次フレームを予約する」
//   形をしていたため、pump が 1 度でも throw すると予約に到達せず**rAF 連鎖が
//   永久に切れ、ゲーム内時刻が二度と進まなくなる**(AIプレイテスト Round 1 の
//   fatal 2 件が実際にこれで凍結した)。予約を `finally` へ移し、pump の例外は
//   駆動源の中で捕まえる。
//
//   ただし「毎フレーム同じ例外を握り潰して回り続ける」のも異常なので、
//   {@link TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES} 回**連続**で失敗したら
//   駆動を止め、ログは 1 連続につき 2 行までに抑える(コンソールの氾濫でページを
//   固めない)。1 回でも成功すればカウンタは 0 に戻る。
//
//   **これは防衛線であって修正ではない。** pump が throw する原因(= 世界を
//   入れ替えたのにアンカーを引き直していない・§6)は呼び出し側で直すこと。
//
// ===========================================================================
// 6. 世界を入れ替えたら必ず {@link TickDriver.syncTo}(呼び出し側の義務)
// ===========================================================================
//   アンカーは「この実時刻のとき、ゲーム内 tick はこれだった」という対応表で
//   あり、**state を丸ごと差し替える操作(セーブのインポート・最初からやり直す・
//   新規ゲーム)はこの対応を無効にする**。引き直さないまま次の pump が走ると、
//   driver は旧世界基準の targetTick を出し、ストア側は新 state の tick との
//   巨大な差(> 600)を見て例外にする(`src/ui/store.ts` §4)= §5 の凍結に至る。
//
//   結線の実体は composition root(`src/main.tsx`)にあり、ストアの
//   `onWorldLoaded` 通知から `syncTo` を呼ぶ形で**構造的に**取りこぼしを
//   防いでいる(世界の入れ替えは `worldLoaded` イベント 1 種類しかない)。
// ---------------------------------------------------------------------------

import { TICK_MS, computeTargetTick } from "../engine/advance";
import { LIVE_ADVANCE_MAX_TICK_DELTA, chooseCatchUpRoute, type CatchUpRoute } from "./catchUp";

export { LIVE_ADVANCE_MAX_TICK_DELTA, TICK_MS };

/** 時計まわりの使い方の誤り(非有限の時刻・負の tick など)。 */
export class ClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockError";
  }
}

// --- 1. 単調時刻ソース -------------------------------------------------------

/**
 * 単調時刻(ms)の供給元。**注入可能**にしてあるのは、テストが
 * `performance.now()` に触れずに任意の時刻列を与えられるようにするためで、
 * 本番では {@link performanceClock} 1 つだけを使う。
 */
export interface MonotonicClock {
  now(): number;
}

/** 本番の時計。`performance.now()` は単調(ADR-012 の巻戻し検知の基準)。 */
export const performanceClock: MonotonicClock = {
  now(): number {
    return performance.now();
  },
};

// --- 2. アンカーと純関数(§1/§2) --------------------------------------------

/** tick 算出の基準点。「この実時刻のとき、ゲーム内 tick はこれだった」。 */
export interface TickAnchor {
  readonly anchorMs: number;
  readonly anchorTick: number;
}

/** {@link planTick} の結果。**state は 1 つも動いていない**(純関数)。 */
export interface TickPlan {
  /** 進めるべきゲーム内 tick(= `anchorTick + 経過 tick`)。 */
  readonly targetTick: number;
  /** `targetTick - anchor.anchorTick`。0 なら進める必要が無い。 */
  readonly tickDelta: number;
  /** メインスレッドで進めてよいか(§3)。`tickDelta === 0` でも判定は返す。 */
  readonly route: CatchUpRoute;
  /** 単調時刻が巻き戻っていたか(§4)。 */
  readonly rewound: boolean;
  /** 進めた後のアンカー(端数 ms を持ち越す・§2)。 */
  readonly nextAnchor: TickAnchor;
}

function requireFiniteMs(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ClockError(`${label} ${String(value)} が有限でない(単調時刻ソースの異常)`);
  }
}

/**
 * ADR-026 の targetTick 式(§1)。**この関数が tick 駆動の全てである**。
 *
 * 引数は「基準点」と「今の単調時刻」だけで、呼ばれた回数・間隔・順序を
 * 一切参照しない。同じ (anchor, nowMs) には常に同じ結果を返す。
 *
 * @throws {ClockError} 時刻が非有限の場合
 * @throws {AdvanceError} anchorTick が 0 以上の整数でない / 経過 ms が安全整数超過の場合
 */
export function planTick(anchor: TickAnchor, nowMs: number): TickPlan {
  requireFiniteMs(nowMs, "現在の単調時刻");
  requireFiniteMs(anchor.anchorMs, "アンカーの単調時刻");

  const elapsedMs = nowMs - anchor.anchorMs;
  const rewound = elapsedMs < 0;
  // 巻き戻しは engine 側で 0 に落ちる(advance.ts の elapsedMsToTickDelta)。
  // ここでアンカーを現在時刻へ引き直すのは、以後の経過が負のまま固まるのを
  // 防ぐためだけであり、tick は 1 つも動かない(§4)。
  const targetTick = computeTargetTick(anchor.anchorTick, elapsedMs);
  const tickDelta = targetTick - anchor.anchorTick;

  const nextAnchor: TickAnchor = rewound
    ? { anchorMs: nowMs, anchorTick: anchor.anchorTick }
    : { anchorMs: anchor.anchorMs + tickDelta * TICK_MS, anchorTick: targetTick };

  return {
    targetTick,
    tickDelta,
    route: chooseCatchUpRoute(tickDelta),
    rewound,
    nextAnchor,
  };
}

// --- 3. 駆動(合図の回数を数えない・§1) ------------------------------------

/**
 * 「そろそろ pump を呼んでほしい」という合図だけを出す駆動源。
 *
 * **合図の回数・間隔は結果に影響しない**(§1)。既定は rAF、無ければ 1 秒間隔の
 * setInterval。どちらでも tick の結果は同じである。
 */
export type TickScheduler = (pump: () => void) => () => void;

/**
 * 既定の駆動源が「もう回しても無駄」と判断して自ら止まるまでの**連続**失敗回数。
 * 1 回でも成功したら 0 に戻る(§5)。
 */
export const TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * 既定の駆動源。rAF があれば rAF、無ければ 1 秒間隔(ADR-026(2) の「rAF または1秒間隔」)。
 *
 * **pump が投げても合図を止めない**(§5)。次フレームの予約は `finally` に置いて
 * あり、例外経路からは到達不能な位置に一切書かない。
 */
export const defaultTickScheduler: TickScheduler = (pump) => {
  let consecutiveFailures = 0;
  let stopped = false;
  /** 駆動源そのものの解除(rAF なら cancelAnimationFrame、無ければ clearInterval)。 */
  let cancelSource: () => void = () => undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelSource();
  };

  /**
   * 1 回ぶんの合図。**例外を外へ出さない**(出すと呼び出し元の予約が飛ぶ)。
   * 同じ例外が毎フレーム出続けてもログは 1 連続につき 2 行までに抑える(§5)。
   */
  const pumpOnce = (): void => {
    if (stopped) return;
    try {
      pump();
      consecutiveFailures = 0;
    } catch (error: unknown) {
      consecutiveFailures++;
      if (consecutiveFailures === 1) {
        console.error("[clock] tick pump が例外を投げた(駆動は継続する)", error);
      }
      if (consecutiveFailures >= TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `[clock] tick pump が ${String(TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES)} 回連続で失敗したので駆動を止める` +
            "(以後この駆動源は合図を出さない。原因を直してから再読み込みすること)",
        );
        stop();
      }
    }
  };

  if (typeof requestAnimationFrame === "function") {
    let handle = 0;
    const loop = (): void => {
      if (stopped) return;
      try {
        pumpOnce();
      } finally {
        // 次フレームの予約は**必ず**通る位置に置く(§5)。
        if (!stopped) handle = requestAnimationFrame(loop);
      }
    };
    cancelSource = () => {
      cancelAnimationFrame(handle);
    };
    handle = requestAnimationFrame(loop);
    return stop;
  }
  const timer = setInterval(pumpOnce, 1000);
  cancelSource = () => {
    clearInterval(timer);
  };
  return stop;
};

export interface TickDriverOptions {
  /** 起点のゲーム内 tick(通常はロード直後の `state.tick`)。 */
  readonly startTick: number;
  /** メイン経路で進められるとき(≤600 tick)に呼ばれる。 */
  readonly onAdvance: (toTick: number) => void;
  /** Worker 経路が要るとき(>600 tick)に呼ばれる。省略時は何もしない。 */
  readonly onCatchUpRequired?: (toTick: number) => void;
  readonly clock?: MonotonicClock;
  readonly schedule?: TickScheduler;
}

export interface TickDriver {
  /**
   * 時刻を 1 回読んで、進むべきなら `onAdvance` / `onCatchUpRequired` を呼ぶ。
   * **何回呼んでも結果は時刻だけで決まる**(§1)。進まなかった場合も
   * {@link TickPlan} を返す(`tickDelta === 0`)。
   */
  pump(): TickPlan;
  /** 駆動源を回し始める(既に回っていれば何もしない)。 */
  start(): void;
  stop(): void;
  /**
   * 外部要因(Worker catch-up 完了・セーブ復元・世界の入れ替え)で tick が
   * 動いたときにアンカーを引き直す。**進行方向の判断はしない**。
   *
   * 呼び出し側の義務は §6 を参照(世界を入れ替えたら必ずここへ通す)。
   */
  syncTo(tick: number): void;
  /** 現在のアンカー(診断・テスト用)。 */
  anchor(): TickAnchor;
  /** `pump` を実行した回数(**診断専用**。tick 計算には 1 度も使われない)。 */
  pumpCount(): number;
}

/**
 * フォアグラウンド tick 駆動を作る(ADR-026)。アプリ 1 起動につき 1 個。
 *
 * @throws {ClockError} startTick が 0 以上の整数でない場合
 */
export function createTickDriver(options: TickDriverOptions): TickDriver {
  if (!Number.isSafeInteger(options.startTick) || options.startTick < 0) {
    throw new ClockError(`startTick ${String(options.startTick)} が 0 以上の整数でない`);
  }
  const clock = options.clock ?? performanceClock;
  const schedule = options.schedule ?? defaultTickScheduler;

  let anchor: TickAnchor = { anchorMs: clock.now(), anchorTick: options.startTick };
  let stopSchedule: (() => void) | null = null;
  let pumpCount = 0;

  function pump(): TickPlan {
    pumpCount++;
    const plan = planTick(anchor, clock.now());
    if (plan.tickDelta === 0) {
      // 巻き戻し時だけはアンカーを引き直す(§4)。tick は動かさない。
      if (plan.rewound) anchor = plan.nextAnchor;
      return plan;
    }
    if (plan.route === "main-structural-sharing") {
      anchor = plan.nextAnchor;
      options.onAdvance(plan.targetTick);
      return plan;
    }
    // Worker 経路。アンカーは動かさない —— 進んだかどうかは catch-up の完了
    // (`syncTo`)で確定するため、ここで先に進めると二重に進む恐れがある。
    options.onCatchUpRequired?.(plan.targetTick);
    return plan;
  }

  return {
    pump,

    start(): void {
      if (stopSchedule !== null) return;
      stopSchedule = schedule(() => {
        pump();
      });
    },

    stop(): void {
      if (stopSchedule === null) return;
      stopSchedule();
      stopSchedule = null;
    },

    syncTo(tick: number): void {
      if (!Number.isSafeInteger(tick) || tick < 0) {
        throw new ClockError(`syncTo の tick ${String(tick)} が 0 以上の整数でない`);
      }
      anchor = { anchorMs: clock.now(), anchorTick: tick };
    },

    anchor: () => anchor,
    pumpCount: () => pumpCount,
  };
}
