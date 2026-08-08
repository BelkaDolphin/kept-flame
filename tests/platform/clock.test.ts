// ---------------------------------------------------------------------------
// src/platform/clock.ts のテスト(M29)— ADR-026
//
// M29 の検分観点は **「タイマー発火回数に依存する経路が 1 つも無いか」**である。
// ここではそれを次の 3 段で固定する:
//
//   1. `planTick` が (anchor, nowMs) だけの純関数であること(同じ入力 → 同じ出力)
//   2. driver を「1 回だけ pump」した場合と「同じ時間の間に 600 回 pump」した
//      場合で、**進んだ tick も onAdvance に渡った値の合計も完全に一致**すること
//   3. 間引き(バックグラウンドタブ相当 = 長時間 pump されない)でも、復帰後の
//      1 回の pump で同じところまで進むこと
//
// 時計は注入(`MonotonicClock`)なので `performance.now()` にも実タイマにも
// 触らない = テスト自体が実時間に依存しない。
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

import { TICK_MS } from "../../src/engine/advance";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "../../src/platform/catchUp";
import {
  ClockError,
  computeOfflineElapsedMs,
  createTickDriver,
  defaultTickScheduler,
  planTick,
  TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES,
  type MonotonicClock,
  type TickAnchor,
  type TickDriver,
} from "../../src/platform/clock";

/** 手で進める偽物の単調時計。 */
function fakeClock(
  startMs = 0,
): MonotonicClock & { set(ms: number): void; advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ANCHOR: TickAnchor = { anchorMs: 1000, anchorTick: 100 };

describe("planTick(ADR-026 の targetTick 式・純関数)", () => {
  it("同じ入力なら常に同じ出力(呼び出し回数も順序も影響しない)", () => {
    const first = planTick(ANCHOR, 1000 + 5 * TICK_MS);
    for (let i = 0; i < 50; i++) {
      const again = planTick(ANCHOR, 1000 + 5 * TICK_MS);
      expect(again).toEqual(first);
    }
    expect(first.targetTick).toBe(105);
    expect(first.tickDelta).toBe(5);
  });

  it("1 tick に満たない経過は進まない(端数は次のアンカーへ持ち越す)", () => {
    const plan = planTick(ANCHOR, 1000 + TICK_MS - 1);
    expect(plan.tickDelta).toBe(0);
    expect(plan.targetTick).toBe(100);
    // 進んでいないのでアンカーは動かない = 端数 ms が失われない。
    expect(plan.nextAnchor).toEqual(ANCHOR);
  });

  it("アンカーは tick 境界へ厳密に進む(floor 除算の加法性・§2)", () => {
    const plan = planTick(ANCHOR, 1000 + 3 * TICK_MS + 777);
    expect(plan.tickDelta).toBe(3);
    expect(plan.nextAnchor).toEqual({ anchorMs: 1000 + 3 * TICK_MS, anchorTick: 103 });
  });

  it("72h(4320 tick)でクランプする(GDD 11.9)", () => {
    const plan = planTick(ANCHOR, 1000 + 10_000 * TICK_MS);
    expect(plan.tickDelta).toBe(4320);
    expect(plan.targetTick).toBe(100 + 4320);
  });

  it("600 tick を超える差分は Worker 経路と判定する(ADR-019/029)", () => {
    const small = planTick(ANCHOR, 1000 + LIVE_ADVANCE_MAX_TICK_DELTA * TICK_MS);
    expect(small.route).toBe("main-structural-sharing");
    const large = planTick(ANCHOR, 1000 + (LIVE_ADVANCE_MAX_TICK_DELTA + 1) * TICK_MS);
    expect(large.route).toBe("worker-draft-snapshot");
  });

  it("巻き戻しは tick を 1 も動かさず、アンカーだけ引き直す(§4)", () => {
    const plan = planTick(ANCHOR, 0);
    expect(plan.rewound).toBe(true);
    expect(plan.tickDelta).toBe(0);
    expect(plan.nextAnchor).toEqual({ anchorMs: 0, anchorTick: 100 });
  });

  it("非有限の時刻は例外(単調時刻ソースの異常を握り潰さない)", () => {
    expect(() => planTick(ANCHOR, Number.NaN)).toThrow(ClockError);
    expect(() => planTick({ anchorMs: Number.POSITIVE_INFINITY, anchorTick: 0 }, 1)).toThrow(
      ClockError,
    );
  });
});

describe("TickDriver(発火回数非依存・M29 検分観点)", () => {
  /** 経過 `totalMs` を `pumps` 回に等分して pump する。戻り値は onAdvance に渡った tick 列。 */
  function runDriver(totalMs: number, pumps: number): { readonly calls: number[] } {
    const clock = fakeClock(0);
    const calls: number[] = [];
    const driver = createTickDriver({
      startTick: 0,
      clock,
      onAdvance: (toTick) => calls.push(toTick),
      // 駆動源は自前で回す(このテストは実タイマを 1 つも使わない)。
      schedule: () => () => undefined,
    });
    for (let i = 1; i <= pumps; i++) {
      clock.set(Math.floor((totalMs * i) / pumps));
      driver.pump();
    }
    return { calls };
  }

  it("1 回 pump と 600 回 pump で到達 tick が完全に一致する", () => {
    const totalMs = 137 * TICK_MS + 12_345;
    const once = runDriver(totalMs, 1);
    const many = runDriver(totalMs, 600);
    const lastOnce = once.calls[once.calls.length - 1];
    const lastMany = many.calls[many.calls.length - 1];
    expect(lastOnce).toBe(137);
    expect(lastMany).toBe(137);
    // 呼ばれた**回数**は当然違う(それが「発火回数」)が、結果は同じ。
    expect(once.calls.length).toBe(1);
    expect(many.calls.length).toBeGreaterThan(1);
  });

  it("pump の刻み方を変えても到達 tick は同じ(1/3/7/60/600 分割)", () => {
    const totalMs = 251 * TICK_MS + 59_999;
    const reached = [1, 3, 7, 60, 600].map((pumps) => {
      const { calls } = runDriver(totalMs, pumps);
      return calls[calls.length - 1];
    });
    expect(reached).toEqual([251, 251, 251, 251, 251]);
  });

  it("長時間 pump されなくても(背景タブ間引き)復帰後の 1 回で追いつく", () => {
    const clock = fakeClock(0);
    const calls: number[] = [];
    const driver = createTickDriver({
      startTick: 10,
      clock,
      onAdvance: (toTick) => calls.push(toTick),
      schedule: () => () => undefined,
    });
    clock.advance(90 * TICK_MS);
    driver.pump();
    expect(calls).toEqual([100]);
    expect(driver.anchor()).toEqual({ anchorMs: 90 * TICK_MS, anchorTick: 100 });
  });

  it("pump 回数は診断値であって計算には使われない(進まない pump は 0 件の通知)", () => {
    const clock = fakeClock(0);
    const calls: number[] = [];
    const driver = createTickDriver({
      startTick: 0,
      clock,
      onAdvance: (toTick) => calls.push(toTick),
      schedule: () => () => undefined,
    });
    for (let i = 0; i < 100; i++) driver.pump();
    expect(driver.pumpCount()).toBe(100);
    expect(calls).toEqual([]);
    expect(driver.anchor()).toEqual({ anchorMs: 0, anchorTick: 0 });
  });

  it("600 tick 超は onAdvance でなく onCatchUpRequired へ回し、アンカーを動かさない", () => {
    const clock = fakeClock(0);
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const driver = createTickDriver({
      startTick: 0,
      clock,
      onAdvance: (toTick) => advanced.push(toTick),
      onCatchUpRequired: (toTick) => catchUps.push(toTick),
      schedule: () => () => undefined,
    });
    clock.advance(1000 * TICK_MS);
    driver.pump();
    expect(advanced).toEqual([]);
    expect(catchUps).toEqual([1000]);
    // catch-up の完了までアンカーは動かない(二重に進めないため)。
    expect(driver.anchor()).toEqual({ anchorMs: 0, anchorTick: 0 });

    // 完了報告(syncTo)でアンカーが引き直される。
    driver.syncTo(1000);
    expect(driver.anchor()).toEqual({ anchorMs: 1000 * TICK_MS, anchorTick: 1000 });
  });

  it("start/stop は駆動源を着脱するだけ(結果には影響しない)", () => {
    const clock = fakeClock(0);
    let started = 0;
    let stopped = 0;
    const driver = createTickDriver({
      startTick: 0,
      clock,
      onAdvance: () => undefined,
      schedule: () => {
        started++;
        return () => {
          stopped++;
        };
      },
    });
    driver.start();
    driver.start(); // 二重起動は無視
    expect(started).toBe(1);
    driver.stop();
    driver.stop();
    expect(stopped).toBe(1);
  });

  it("startTick / syncTo は 0 以上の整数のみ", () => {
    expect(() => createTickDriver({ startTick: -1, onAdvance: () => undefined })).toThrow(
      ClockError,
    );
    const driver = createTickDriver({
      startTick: 0,
      clock: fakeClock(0),
      onAdvance: () => undefined,
      schedule: () => () => undefined,
    });
    expect(() => driver.syncTo(1.5)).toThrow(ClockError);
  });
});

// ---------------------------------------------------------------------------
// [R1-A01/A02] 駆動源は pump の例外で死なない(clock.ts §5)
//
// AIプレイテスト Round 1 の fatal 2 件は、`pump()` が投げると
// `requestAnimationFrame(loop)` の再予約に到達せず rAF 連鎖が永久に切れる
// ——「ゲーム内時刻が二度と進まない」——という構造が原因だった。ここでは
// **rAF を偽物に差し替えて**、投げ続けても予約が続くこと/連続失敗では自ら
// 止まること/1 回でも成功すればカウンタが戻ることを固定する。
// ---------------------------------------------------------------------------

interface FakeRaf {
  /** 予約済みコールバックを 1 フレームぶん実行する。 */
  frame(): void;
  /** 予約待ちのコールバック数(0 なら連鎖が切れている)。 */
  pendingCount(): number;
  restore(): void;
}

type RafGlobal = typeof globalThis & {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

function installFakeRaf(): FakeRaf {
  const target = globalThis as RafGlobal;
  const originalRequest = target.requestAnimationFrame;
  const originalCancel = target.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;

  target.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  };
  target.cancelAnimationFrame = (handle: number): void => {
    callbacks.delete(handle);
  };

  return {
    frame(): void {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    },
    pendingCount: () => callbacks.size,
    restore(): void {
      if (originalRequest === undefined) delete target.requestAnimationFrame;
      else target.requestAnimationFrame = originalRequest;
      if (originalCancel === undefined) delete target.cancelAnimationFrame;
      else target.cancelAnimationFrame = originalCancel;
    },
  };
}

describe("defaultTickScheduler(pump が投げても連鎖が切れない・§5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pump が毎回投げても、上限に達するまでは次フレームの予約が続く", () => {
    const raf = installFakeRaf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let calls = 0;
      const stop = defaultTickScheduler(() => {
        calls++;
        throw new Error("pump が壊れている");
      });
      expect(raf.pendingCount()).toBe(1);

      // 上限の 1 つ手前まで: 毎フレーム呼ばれ、毎フレーム予約し直される。
      for (let i = 1; i < TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES; i++) {
        raf.frame();
        expect(calls).toBe(i);
        expect(raf.pendingCount()).toBe(1);
      }
      // ログは「1 連続につき 2 行まで」の 1 行目だけが出ている。
      expect(errors).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      errors.mockRestore();
      raf.restore();
    }
  });

  it("連続失敗が上限に達したら自ら止まる(無限エラーループにしない)", () => {
    const raf = installFakeRaf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let calls = 0;
      defaultTickScheduler(() => {
        calls++;
        throw new Error("pump が壊れている");
      });
      for (let i = 0; i < TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES + 3; i++) raf.frame();

      expect(calls).toBe(TICK_SCHEDULER_MAX_CONSECUTIVE_FAILURES);
      expect(raf.pendingCount()).toBe(0);
      // 1 行目(最初の失敗)+ 停止の 1 行 = 2 行だけ(毎フレーム吐かない)。
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
      raf.restore();
    }
  });

  it("1 回でも成功すれば失敗カウンタは 0 に戻る(たまに失敗する pump では止まらない)", () => {
    const raf = installFakeRaf();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let calls = 0;
      const stop = defaultTickScheduler(() => {
        calls++;
        // 2 回に 1 回だけ投げる = 連続失敗は常に 1。
        if (calls % 2 === 1) throw new Error("たまに壊れる pump");
      });
      for (let i = 0; i < 40; i++) raf.frame();

      expect(calls).toBe(40);
      expect(raf.pendingCount()).toBe(1);
      // 停止行は 1 度も出ていない(= 上限に達していない)。
      expect(errors.mock.calls.every((call) => !String(call[0]).includes("駆動を止める"))).toBe(
        true,
      );
      stop();
      expect(raf.pendingCount()).toBe(0);
    } finally {
      errors.mockRestore();
      raf.restore();
    }
  });

  it("投げない pump では従来どおり毎フレーム呼ばれ、stop() で止まる", () => {
    const raf = installFakeRaf();
    try {
      let calls = 0;
      const stop = defaultTickScheduler(() => {
        calls++;
      });
      raf.frame();
      raf.frame();
      expect(calls).toBe(2);
      stop();
      raf.frame();
      expect(calls).toBe(2);
      expect(raf.pendingCount()).toBe(0);
    } finally {
      raf.restore();
    }
  });

  it("rAF が無い環境では 1 秒間隔へ落ちる(そちらも例外で止まらない)", () => {
    // 既定の Node 実行環境には requestAnimationFrame が無い(= この分岐)。
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let calls = 0;
      const stop = defaultTickScheduler(() => {
        calls++;
        throw new Error("pump が壊れている");
      });
      vi.advanceTimersByTime(3000);
      expect(calls).toBe(3);
      stop();
      vi.advanceTimersByTime(3000);
      expect(calls).toBe(3);
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// [台帳v26 必-1] 起動時オフライン復帰(clock.ts §7)
//
// ユーザー実プレイ報告「かまど 1・薪 1 本に数時間」の真因は、**ブラウザを
// 閉じていた時間がゲーム内から丸ごと消えていた**ことだった:
// `performance.now()` の原点はページ読み込みのたびに 0 へ戻るので、初期アンカーを
// `{anchorMs: clock.now(), anchorTick: セーブの tick}` と置くと起動直後の経過は
// 必ず ≒0ms = 差分 0 になる。受け皿(72h クランプ・Worker catch-up・⑫帰還
// ダイジェスト)は全て実装済みで、**入口の材料だけが無かった**。
//
// ここが固定するのは 4 点:
//   (a) 壁時計どうしの引き算(`computeOfflineElapsedMs`)が起動経路で**投げない**
//   (b) `startElapsedMs` 省略 / 0 は従来と 1 bit も変わらない
//   (c) N 分の不在 → 初回 pump で N tick(端数 ms も §2 どおり持ち越す)
//   (d) 72h 超は初回 pump が Worker 経路になり、`syncTo` 後に**残余経過が消える**
//       (= クランプが正しく効き、二度目の catch-up を誘発しない)
// ---------------------------------------------------------------------------

describe("computeOfflineElapsedMs(壁時計どうしの引き算・§7)", () => {
  /** 固定のエポック ms(persistence.test.ts と同じ値)。実時刻に依存させない。 */
  const SAVED_AT_MS = 1_754_000_000_000;

  it("経過はそのまま ms で返る", () => {
    expect(computeOfflineElapsedMs(SAVED_AT_MS, SAVED_AT_MS + 90 * TICK_MS)).toBe(90 * TICK_MS);
  });

  it("savedAtMs が不明(null)なら 0 = 台帳v26 必-1 以前と同じ挙動へ落ちる", () => {
    expect(computeOfflineElapsedMs(null, SAVED_AT_MS)).toBe(0);
  });

  it("端末時計の巻き戻し(未来のセーブ)は 0 へ倒す(負を通さない)", () => {
    expect(computeOfflineElapsedMs(SAVED_AT_MS, SAVED_AT_MS - 1)).toBe(0);
    expect(computeOfflineElapsedMs(SAVED_AT_MS, SAVED_AT_MS)).toBe(0);
  });

  it("非有限は 0(起動経路なので決して投げない)", () => {
    expect(computeOfflineElapsedMs(Number.NaN, SAVED_AT_MS)).toBe(0);
    expect(computeOfflineElapsedMs(Number.NEGATIVE_INFINITY, SAVED_AT_MS)).toBe(0);
    expect(computeOfflineElapsedMs(SAVED_AT_MS, Number.POSITIVE_INFINITY)).toBe(0);
    expect(computeOfflineElapsedMs(SAVED_AT_MS, Number.NaN)).toBe(0);
  });

  it("小数 ms は floor(単調時刻側の整数化と揃える)", () => {
    expect(computeOfflineElapsedMs(SAVED_AT_MS, SAVED_AT_MS + 1500.7)).toBe(1500);
  });
});

describe("TickDriver の startElapsedMs(起動時オフライン復帰・§7)", () => {
  /** 駆動源を回さない(= 実タイマに触れない)driver を組む。 */
  function bootDriver(options: {
    readonly startTick: number;
    readonly startElapsedMs?: number;
    readonly clock: MonotonicClock;
    readonly advanced: number[];
    readonly catchUps: number[];
  }): TickDriver {
    return createTickDriver({
      startTick: options.startTick,
      // exactOptionalPropertyTypes: 省略時は**キーごと渡さない**(= 既定 0)。
      ...(options.startElapsedMs === undefined ? {} : { startElapsedMs: options.startElapsedMs }),
      clock: options.clock,
      onAdvance: (toTick) => options.advanced.push(toTick),
      onCatchUpRequired: (toTick) => options.catchUps.push(toTick),
      schedule: () => () => undefined,
    });
  }

  it("省略と 0 は同じ = 従来どおりアンカーは now そのもの(初回 pump は 0 tick)", () => {
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const omitted = bootDriver({ startTick: 7, clock: fakeClock(12_345), advanced, catchUps });
    const zero = bootDriver({
      startTick: 7,
      startElapsedMs: 0,
      clock: fakeClock(12_345),
      advanced,
      catchUps,
    });
    expect(omitted.anchor()).toEqual({ anchorMs: 12_345, anchorTick: 7 });
    expect(zero.anchor()).toEqual(omitted.anchor());
    omitted.pump();
    zero.pump();
    expect(advanced).toEqual([]);
    expect(catchUps).toEqual([]);
  });

  it("N 分の不在は初回 pump で N tick 進む(ここが fatal の直接の修正点)", () => {
    const clock = fakeClock(0);
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const driver = bootDriver({
      startTick: 100,
      startElapsedMs: 90 * TICK_MS,
      clock,
      advanced,
      catchUps,
    });
    // アンカーだけが過去へずれる(駆動ロジックには分岐が 1 つも増えていない)。
    expect(driver.anchor()).toEqual({ anchorMs: -90 * TICK_MS, anchorTick: 100 });

    const plan = driver.pump();
    expect(plan.tickDelta).toBe(90);
    expect(plan.route).toBe("main-structural-sharing");
    expect(advanced).toEqual([190]);
    expect(catchUps).toEqual([]);
    expect(driver.anchor()).toEqual({ anchorMs: 0, anchorTick: 190 });
  });

  it("不在ぶんの端数 ms も捨てずに持ち越す(§2 の性質が不在にも効く)", () => {
    const clock = fakeClock(0);
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const driver = bootDriver({
      startTick: 0,
      startElapsedMs: 3 * TICK_MS + 777,
      clock,
      advanced,
      catchUps,
    });
    driver.pump();
    expect(advanced).toEqual([3]);
    expect(driver.anchor()).toEqual({ anchorMs: -777, anchorTick: 3 });
    // 端数 777ms が残っているので、次の 1 tick は TICK_MS - 777 で来る。
    clock.set(TICK_MS - 777);
    driver.pump();
    expect(advanced).toEqual([3, 4]);
  });

  it("不在ぶんと画面を開いてからの経過は同じ式で足される(起動だけの特別扱いが無い)", () => {
    const clock = fakeClock(1000);
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const driver = bootDriver({
      startTick: 0,
      startElapsedMs: 5 * TICK_MS,
      clock,
      advanced,
      catchUps,
    });
    clock.advance(3 * TICK_MS);
    driver.pump();
    expect(advanced).toEqual([8]);
  });

  it("負・非有限の startElapsedMs は ClockError(呼び出し側で丸める契約)", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        createTickDriver({
          startTick: 0,
          startElapsedMs: bad,
          clock: fakeClock(0),
          onAdvance: () => undefined,
          schedule: () => () => undefined,
        }),
      ).toThrow(ClockError);
    }
  });

  it("72h 超の不在は初回 pump が Worker 経路 + syncTo 後に残余経過が消える(§7)", () => {
    const clock = fakeClock(0);
    const advanced: number[] = [];
    const catchUps: number[] = [];
    /** 100 時間の不在(72h クランプの外側)。 */
    const absenceMs = 100 * 60 * TICK_MS;
    const driver = bootDriver({
      startTick: 0,
      startElapsedMs: absenceMs,
      clock,
      advanced,
      catchUps,
    });

    const plan = driver.pump();
    expect(plan.tickDelta).toBe(4320); // 72h クランプ(GDD 11.9)
    expect(plan.route).toBe("worker-draft-snapshot");
    expect(advanced).toEqual([]);
    expect(catchUps).toEqual([4320]);
    // catch-up の完了までアンカーは動かない(二重に進めないため)。
    expect(driver.anchor()).toEqual({ anchorMs: -absenceMs, anchorTick: 0 });

    // catch-up 完了報告。アンカーが**現在時刻**へ引き直され、72h を超えた
    // 残余(28h ぶん)はここで捨てられる = クランプが正しく効いている。
    driver.syncTo(4320);
    expect(driver.anchor()).toEqual({ anchorMs: 0, anchorTick: 4320 });
    const after = driver.pump();
    expect(after.tickDelta).toBe(0);
    expect(catchUps).toEqual([4320]);
  });

  it("⑫帰還ダイジェストのしきい値(tick 差 60)が boot 経路で満たされる", () => {
    // `src/main.tsx` の DIGEST_MIN_ELAPSED_TICKS(= 1 ゲーム時間・ui-spec §4)。
    const digestMinElapsedTicks = 60;
    const bootTick = 500;
    const savedAtMs = 1_754_000_000_000;
    const nowWallMs = savedAtMs + 90 * TICK_MS; // 90 分ぶりの再訪
    const advanced: number[] = [];
    const catchUps: number[] = [];

    const driver = bootDriver({
      startTick: bootTick,
      startElapsedMs: computeOfflineElapsedMs(savedAtMs, nowWallMs),
      clock: fakeClock(0),
      advanced,
      catchUps,
    });
    const bootPlan = driver.pump();
    expect(bootPlan.targetTick - bootTick).toBe(90);
    expect(bootPlan.targetTick - bootTick).toBeGreaterThanOrEqual(digestMinElapsedTicks);
  });

  it("[回帰] 材料が無ければ同じ状況で 0 tick(修正前の壊れ方の記録)", () => {
    const advanced: number[] = [];
    const catchUps: number[] = [];
    const driver = bootDriver({ startTick: 500, clock: fakeClock(0), advanced, catchUps });
    const bootPlan = driver.pump();
    // ページを開いた直後なので経過は 0ms。セーブ時刻を知らない限り、どれだけ
    // 長く閉じていてもここは 0 のままになる —— これが台帳v26 必-1 の fatal。
    expect(bootPlan.targetTick - 500).toBe(0);
  });
});
