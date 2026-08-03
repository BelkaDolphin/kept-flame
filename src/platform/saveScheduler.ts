// ---------------------------------------------------------------------------
// セーブ書込のスケジューラ(2秒デバウンス + 絶対時間/件数の強制フラッシュ)
// — M3 / ADR-012(1)
//
// ===========================================================================
// 0. このモジュールが解く問題
// ===========================================================================
//   ADR-012(1) の原文: 「`visibilitychange`/`pagehide` 依存のみだと iOS の
//   イベント未発火終了パスで直近進行が丸ごと消える欠陥を修正。2秒デバウンス +
//   ライフサイクルイベントに加え『**経過15秒 または 25コマンドごと**』の
//   絶対時間/絶対件数の強制フラッシュを追加(catch-up 中は末尾1回)」。
//
//   つまり書込トリガは 4 系統あり、**デバウンスは他の 3 つを遅らせてはならない**:
//     (1) デバウンス   : 最後のコマンドから 2 秒静かなら書く(通常の書込)
//     (2) 絶対時間     : 前回書込から 15 秒経ったら、コマンドが続いていても書く
//     (3) 絶対件数     : 25 コマンド溜まったら即書く
//     (4) ライフサイクル: visibilitychange(hidden)/ pagehide で即書く
//   これらは OR であって、(1) が (2)(3) を押し流す実装は ADR の欠陥修正を
//   無効化する。本実装は「デバウンスの発火時刻は**絶対時間の締切を越えられない**」
//   (`nextDelayMs`)という形で 1 箇所に閉じ込めてある。
//
//   **[M63/R4-A09 一次特定・5番目の追加トリガ]** M62 で `recordCommandOutcome`
//   をプレイヤー操作へ結線したにもかかわらず、Round 4 実測で「建設直後に即
//   リロード」すると保存されていない事象を再現した(Playwright での実機再現・
//   ADR 上の(4)を人為的に模した検証で確定): (4) のライフサイクルフラッシュは
//   `visibilitychange`/`pagehide` の**発火自体**はしているが、その中で始めた
//   非同期の IDB 書込は**実際のページ遷移(reload/close)ではドキュメント破棄と
//   競走し、勝つ保証が無い**(ブラウザは pagehide 内の非同期処理の完了を待たない
//   ——iOS の「未発火」問題とは別種の「発火はするが完走しない」問題)。
//   タブを裏へ回すだけ(実際には遷移しない)場合は同じ非同期書込が確実に完了
//   することも実測済みなので、**配線自体(M62)は壊れていない**。
//   対策として (5) **操作直後の即時フラッシュ**を追加する(既存 4 系統を
//   置き換えない・削らない・純粋な追加): `recordCommandOutcome` が記録を
//   受理した直後に `flush("command")` を呼び、2 秒デバウンスを待たず書込を
//   始める。これで「操作→即リロード」の間に非同期書込が要る時間は
//   (エンコード+IDB put の実測 ms オーダー)まで縮む(2000ms 待ちが構造的に
//   不要になる)。tick 駆動の自動保存(`recordCommands` を直接呼ぶ経路)は
//   これまでどおりデバウンスのままで、書込頻度は変えない。
//
// ===========================================================================
// 1. 時刻は注入する(platform 層でも Date/setTimeout を直に呼ばない)
// ===========================================================================
//   engine の決定論規則(ADR-006/026)は platform 層には掛からないので、ここで
//   `performance.now()` / `setTimeout` を呼ぶこと自体は禁止ではない。それでも
//   {@link SaveClock} として注入可能にしてあるのは **テストを決定論にする**ため
//   である。実時間に依存するテストは (a) 遅い (b) CI の負荷でしか落ちない
//   flaky を生む (c) 15 秒の絶対フラッシュを検証できない(15 秒待てない)。
//   注入にしておけば「時刻を進める」テストが同期的に書ける。
//
//   既定実装 {@link systemSaveClock} が `Date.now()` ではなく
//   `performance.now()` を使うのは単調性のためである。絶対フラッシュの判定は
//   「前回書込からの**経過**」であり、NTP 同期や夏時間で壁時計が巻き戻ると
//   `Date.now()` では締切が未来へ飛ぶ(= 書込が飛ぶ)。
//   なお ADR-026 の「単調タイムスタンプ + 0〜72h クランプ + レート制限」を担う
//   `clock.ts` は**別物**である。あちらは *tick を進めるための経過時刻*、
//   こちらは *いつ書くかのタイマ* で、用途も値域も違う。
//
// ===========================================================================
// 2. 書込は必ず直列化する
// ===========================================================================
//   IDB 書込は非同期なので、飛行中にさらにコマンドが来る。同じキーへ 2 本の
//   put を並行に走らせると、**どちらが後に着くかが不定**になり「新しい state を
//   書いたのに古い state が残る」経路が開く。よって書込は 1 本の Promise 鎖へ
//   繋ぎ、飛行中に溜まった変更は次の 1 回にまとめる(= 書込回数も減る)。
// ---------------------------------------------------------------------------

import type { CommandResult } from "../engine/commands";
import type { GameState } from "../engine/state/state";

// --- 1. 注入する時計 --------------------------------------------------------

/** タイマの取り消し。二重に呼んでも安全であること。 */
export type CancelTimer = () => void;

/** スケジューラが必要とする時刻機能はこの 2 つだけ(§1)。 */
export interface SaveClock {
  /** 単調増加のミリ秒。差分だけを使うので原点は問わない。 */
  now(): number;
  /** `delayMs` 後に `callback` を 1 回呼ぶ。戻り値を呼べば取り消す。 */
  setTimer(delayMs: number, callback: () => void): CancelTimer;
}

/** 実行環境の時計。`performance.now()`(単調)+ `setTimeout`(§1)。 */
export const systemSaveClock: SaveClock = {
  now: () => performance.now(),
  setTimer: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

// --- 2. 既定値(ADR-012(1) の数値そのもの) --------------------------------

/** 最後のコマンドから静かになるのを待つ時間。 */
export const SAVE_DEBOUNCE_MS = 2_000;
/** 前回書込からこれだけ経ったらコマンドが続いていても書く。 */
export const SAVE_MAX_INTERVAL_MS = 15_000;
/** これだけコマンドが溜まったら即書く。 */
export const SAVE_MAX_COMMANDS = 25;

/** 何をきっかけに書いたか。ログ/計測で「どのトリガが効いているか」を見るため。 */
export type FlushReason =
  /** 2秒デバウンス(通常経路)。 */
  | "debounce"
  /** 前回書込から 15 秒(絶対時間)。 */
  | "elapsed"
  /** 25 コマンド(絶対件数)。 */
  | "command-count"
  /** visibilitychange(hidden)/ pagehide。 */
  | "lifecycle"
  /** catch-up 完了時の「末尾1回」。 */
  | "catch-up-end"
  /** 呼び出し側からの明示フラッシュ。 */
  | "manual"
  /**
   * [M63/R4-A09 一次特定] プレイヤー操作(`recordCommandOutcome`)の直後の
   * 即時フラッシュ。§0 の 4 トリガに対する **5番目の追加トリガ**(既存 4 つを
   * 置き換えない・削らない)。`recordCommandOutcome` の JSDoc に根拠あり。
   */
  | "command";

/** 1 回の書込の素性。 */
export interface FlushInfo {
  readonly reason: FlushReason;
  /** この書込がまとめて反映したコマンド数。 */
  readonly commandCount: number;
  /** 書込を開始した時刻(`clock.now()`)。 */
  readonly startedAt: number;
}

export interface SaveSchedulerOptions {
  /** 実際に 1 回書く関数。通常は `(state) => saveGameState(db, state)`。 */
  readonly write: (state: GameState) => Promise<unknown>;
  /** 時計(既定 = {@link systemSaveClock})。テストは偽物を渡す(§1)。 */
  readonly clock?: SaveClock;
  readonly debounceMs?: number;
  readonly maxIntervalMs?: number;
  readonly maxCommands?: number;
  /** 書込成功のたびに呼ばれる(計測・デバッグ用)。 */
  readonly onFlush?: (info: FlushInfo) => void;
  /**
   * 書込失敗の通知先。**省略すると失敗は握り潰されず**、そのフラッシュが返す
   * Promise が reject する(自動フラッシュは誰も await しないので unhandled
   * rejection として表に出る)。黙って消えるより騒がしい方を既定にしてある。
   */
  readonly onError?: (error: unknown, info: FlushInfo) => void;
}

// --- 3. スケジューラ本体 ----------------------------------------------------

/**
 * 「いつ書くか」だけを持つ。**何を書くかは知らない**(最後に渡された
 * GameState をそのまま `write` へ渡す)ので、IDB でもエクスポート先でも
 * 同じスケジューラが使える。
 *
 * 使い方:
 *   const scheduler = new SaveScheduler({ write: (s) => saveGameState(db, s) });
 *   scheduler.recordCommands(state);      // コマンド適用のたびに
 *   await scheduler.flush("manual");      // 明示的に書きたいとき
 *   scheduler.dispose();                  // 破棄(タイマを止めるだけ)
 */
export class SaveScheduler {
  private readonly clock: SaveClock;
  private readonly debounceMs: number;
  private readonly maxIntervalMs: number;
  private readonly maxCommands: number;

  /** 未書込の最新 state。null = 書くものが無い。 */
  private pendingState: GameState | null = null;
  private pendingCommands = 0;
  /** 前回**書込完了**時刻。絶対時間の締切はここから測る。 */
  private lastFlushAt: number;
  private cancelTimer: CancelTimer | null = null;
  /** 飛行中の書込鎖(§2)。常に解決する(失敗は握った上で外へ流す)。 */
  private inFlight: Promise<void> | null = null;
  private suspended = false;
  private disposed = false;

  constructor(private readonly options: SaveSchedulerOptions) {
    this.clock = options.clock ?? systemSaveClock;
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.maxIntervalMs = options.maxIntervalMs ?? SAVE_MAX_INTERVAL_MS;
    this.maxCommands = options.maxCommands ?? SAVE_MAX_COMMANDS;
    if (this.debounceMs < 0 || this.maxIntervalMs <= 0 || this.maxCommands <= 0) {
      throw new Error("SaveScheduler: しきい値は正の値であること");
    }
    if (this.debounceMs > this.maxIntervalMs) {
      // デバウンスが絶対時間より長いと、絶対フラッシュが常に先に来て
      // デバウンスが死ぬ。設定ミスとして受け取らない。
      throw new Error("SaveScheduler: debounceMs は maxIntervalMs 以下であること");
    }
    this.lastFlushAt = this.clock.now();
  }

  /** 未書込の変更があるか。 */
  get isDirty(): boolean {
    return this.pendingState !== null;
  }

  /** 未書込のコマンド数(件数フラッシュの残り = maxCommands - これ)。 */
  get pendingCommandCount(): number {
    return this.pendingCommands;
  }

  /**
   * コマンドを適用したことを伝える。ADR-012(1) の 4 トリガのうち (1)(2)(3) は
   * すべてここから出る。
   *
   * @param state 適用後の最新 state(飛行中の書込があっても最新だけが残る)
   * @param commandCount 一度に適用したコマンド数(既定 1)
   */
  recordCommands(state: GameState, commandCount = 1): void {
    if (this.disposed) throw new Error("SaveScheduler: dispose 済み");
    if (commandCount <= 0 || !Number.isSafeInteger(commandCount)) {
      throw new Error("SaveScheduler: commandCount は 1 以上の整数であること");
    }
    this.pendingState = state;
    this.pendingCommands += commandCount;

    // catch-up 中は書かない(ADR-012(1)「catch-up 中は末尾1回」)。
    // 数万 tick の巻き戻し中に 25 コマンドごとの書込を許すと、復帰のたびに
    // IDB へ数百回書くことになり、2 秒予算(ADR-012(4))を食い潰す。
    if (this.suspended) return;

    if (this.pendingCommands >= this.maxCommands) {
      void this.flush("command-count");
      return;
    }
    const now = this.clock.now();
    const untilDeadline = this.lastFlushAt + this.maxIntervalMs - now;
    if (untilDeadline <= 0) {
      void this.flush("elapsed");
      return;
    }
    // デバウンスは絶対時間の締切を越えられない(§0)。
    const delay = Math.min(this.debounceMs, untilDeadline);
    this.armTimer(delay, delay < this.debounceMs ? "elapsed" : "debounce");
  }

  /**
   * [M49] engine コマンド層({@link ../engine/commands.ts apply})の結果を
   * そのまま渡す、**コマンド適用側の唯一の結線点**。
   *
   * `recordCommands` を直に呼ぶ形だと、呼び出し側が
   *   (a) reject されたコマンドまで数えて 25 件の締切を早める
   *   (b) 列コマンド(原子適用)を 1 件と数えるか N 件と数えるかを取り違える
   * という 2 つの間違いを起こしやすい。ここで一元的に:
   *   - `ok: false`(reject)     → **何も記録しない**(state は 1 bit も
   *     変わっていないので、書く理由が無い)
   *   - `changed: false`         → 記録しない(同上)
   *   - 上記以外                 → `commandCount` 件として記録する
   * と決めておく。
   *
   * **[M63/R4-A09 一次特定] 受理したら即フラッシュする(§0 の 5 番目のトリガ
   * `"command"`)**。理由: プレイヤー操作は「今まさに手を動かした」瞬間であり、
   * その直後にタブを閉じる/リロードする行為は実プレイでもプレイテストの
   * 確認手順でも普通に起きる。ところが 2 秒デバウンス中(まだ `armTimer` の
   * タイマーが走っているだけ)にページが破棄されると、その後のライフサイクル
   * フラッシュ(`attachLifecycleFlush`)は**発火はしても**非同期の IDB 書込が
   * ドキュメント破棄と競走して負けることがあり(実 Playwright 再現済み・§0
   * 追記参照)、直近の操作が黙って失われる。catch-up 中(`suspended`)は
   * 「末尾1回」契約を壊さないよう即時フラッシュしない
   * (`recordCommands` 自身は catch-up 中は何もしないが、`flush` はその区別を
   * 持たないため、ここで明示的に避ける)。
   *
   * @returns 記録した(= 書込トリガの対象にした)なら true
   */
  recordCommandOutcome(result: CommandResult): boolean {
    if (!result.ok || !result.changed) return false;
    this.recordCommands(result.state, result.commandCount);
    if (!this.suspended) void this.flush("command");
    return true;
  }

  /**
   * catch-up(長期不在復帰)の開始を伝える。以後 `recordCommands` は
   * 書込を起こさない。{@link endCatchUp} で末尾 1 回だけ書く。
   */
  beginCatchUp(): void {
    if (this.disposed) throw new Error("SaveScheduler: dispose 済み");
    this.suspended = true;
    this.clearTimer();
  }

  /**
   * catch-up の終了を伝え、溜まった変更を**1 回だけ**書く
   * (ADR-012(1)「catch-up 中は末尾1回」)。
   */
  endCatchUp(): Promise<void> {
    if (this.disposed) throw new Error("SaveScheduler: dispose 済み");
    this.suspended = false;
    return this.flush("catch-up-end");
  }

  /**
   * いま溜まっている変更を即座に書く。書くものが無ければ、飛行中の書込が
   * あればその完了を、無ければ解決済み Promise を返す。
   *
   * 返る Promise は書込の完了を待つ。`onError` を渡していない場合、書込が
   * 失敗するとこの Promise は reject する(§SaveSchedulerOptions)。
   */
  flush(reason: FlushReason = "manual"): Promise<void> {
    this.clearTimer();
    if (this.pendingState === null) {
      return this.inFlight ?? Promise.resolve();
    }
    const state = this.pendingState;
    const info: FlushInfo = {
      reason,
      commandCount: this.pendingCommands,
      startedAt: this.clock.now(),
    };
    this.pendingState = null;
    this.pendingCommands = 0;

    // 直列化(§2): 飛行中があればその後ろへ繋ぐ。
    //
    // 内部鎖 `gate` は**必ず解決する** Promise にしておく。呼び出し側へ返す
    // `settled` と分けてあるのは 2 つの理由による:
    //   (a) 内部鎖が reject のままだと、次の書込が前段の失敗で巻き添えになる。
    //   (b) `settled` に内部で then を付けてしまうと「失敗が処理済み」と
    //       見なされ、誰も await していない自動フラッシュの失敗が**静かに
    //       消える**(unhandled rejection として表に出なくなる)。
    const previous = this.inFlight ?? Promise.resolve();
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = () => {
        resolve(undefined);
      };
    });
    this.inFlight = gate;

    const settled: Promise<void> = previous.then(async () => {
      try {
        try {
          await this.options.write(state);
          this.lastFlushAt = this.clock.now();
          this.options.onFlush?.(info);
        } catch (error: unknown) {
          // 失敗しても締切の起点は進める。進めないと、失敗が続く間ずっと
          // 「締切超過」と判定され、毎コマンド書込を試みる暴走になる。
          this.lastFlushAt = this.clock.now();
          if (this.options.onError === undefined) throw error;
          this.options.onError(error, info);
        }
      } finally {
        if (this.inFlight === gate) this.inFlight = null;
        openGate();
      }
    });
    return settled;
  }

  /** タイマを止める(書込中のものは止めない)。以後の操作は例外になる。 */
  dispose(): void {
    this.clearTimer();
    this.pendingState = null;
    this.pendingCommands = 0;
    this.disposed = true;
  }

  private armTimer(delayMs: number, reason: FlushReason): void {
    this.clearTimer();
    this.cancelTimer = this.clock.setTimer(delayMs, () => {
      this.cancelTimer = null;
      if (this.disposed || this.suspended) return;
      void this.flush(reason);
    });
  }

  private clearTimer(): void {
    if (this.cancelTimer === null) return;
    const cancel = this.cancelTimer;
    this.cancelTimer = null;
    cancel();
  }
}

// --- 4. ライフサイクルイベント(ADR-012(1) の 4 番目のトリガ) --------------

/** `addEventListener` を持つもの(`window` / `document` / テストの偽物)。 */
export interface LifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * ライフサイクルイベントで即時フラッシュするよう配線する。戻り値を呼ぶと外す。
 *
 * `visibilitychange` は**隠れたときだけ**書く(表に戻ったときに書いても
 * 意味が無い)。判定を `isHidden` として外から渡せるのは、`document` を
 * 持たない環境(テスト・Worker)でも配線を検証できるようにするため。
 *
 * ADR-012(1) の主旨は「ライフサイクルイベント**だけ**に頼らない」であって
 * 「使わない」ではない。絶対時間/件数フラッシュ(§0 の (2)(3))と併用して
 * 初めて iOS の未発火終了パスが塞がる。
 */
export function attachLifecycleFlush(
  scheduler: SaveScheduler,
  target: LifecycleTarget,
  isHidden: () => boolean = () => document.visibilityState === "hidden",
): () => void {
  const onVisibilityChange = (): void => {
    if (isHidden()) void scheduler.flush("lifecycle");
  };
  const onPageHide = (): void => {
    void scheduler.flush("lifecycle");
  };
  target.addEventListener("visibilitychange", onVisibilityChange);
  target.addEventListener("pagehide", onPageHide);
  return () => {
    target.removeEventListener("visibilitychange", onVisibilityChange);
    target.removeEventListener("pagehide", onPageHide);
  };
}
