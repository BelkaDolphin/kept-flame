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

import { describe, expect, it } from "vitest";

import { TICK_MS } from "../../src/engine/advance";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "../../src/platform/catchUp";
import {
  ClockError,
  createTickDriver,
  planTick,
  type MonotonicClock,
  type TickAnchor,
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
