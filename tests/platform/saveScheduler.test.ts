// ---------------------------------------------------------------------------
// M3: `src/platform/saveScheduler.ts`(2秒デバウンス + 絶対時間/件数の
// 強制フラッシュ・ADR-012(1))のテスト。
//
// **実時間を一切使わない**。時計は注入された {@link FakeClock} が進めるので、
// 15 秒の絶対フラッシュも 1ms も待たずに検証でき、CI 負荷で揺れる余地が無い
// (saveScheduler.ts §1 が注入可能にしてある理由そのもの)。
//
// 唯一の実時間依存は `flushMicrotasks()` の `setTimeout(0)` である。これは
// 「待つ」ためではなく「マイクロタスク(= 書込 Promise 鎖)を全部流す」ため
// のもので、待ち時間の長さは結果に影響しない。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { GameState } from "../../src/engine/state/state";
import {
  attachLifecycleFlush,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_COMMANDS,
  SAVE_MAX_INTERVAL_MS,
  SaveScheduler,
  type CancelTimer,
  type FlushInfo,
  type LifecycleTarget,
  type SaveClock,
} from "../../src/platform/saveScheduler";

import { apply, type Command } from "../../src/engine/commands";

import { HEARTH, content, facility, id, resident, stateOf } from "../engine/fixtures";

const STATE = stateOf([resident("residentA")]);
const STATE_B = stateOf([resident("residentA"), resident("residentB")]);

/** 手で進める時計。同じ時刻に複数のタイマがあれば登録順に発火する。 */
class FakeClock implements SaveClock {
  private current = 0;
  private nextId = 1;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number {
    return this.current;
  }

  setTimer(delayMs: number, callback: () => void): CancelTimer {
    const timerId = this.nextId++;
    this.timers.push({ id: timerId, at: this.current + delayMs, callback });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== timerId);
    };
  }

  /** 時刻を進め、期限の来たタイマを発火し、書込の Promise 鎖を流す。 */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.current = due.at;
      due.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  /** タイマを張らずに時刻だけ動かす(締切超過の再現用)。 */
  set(at: number): void {
    this.current = at;
  }

  get armedTimerCount(): number {
    return this.timers.length;
  }
}

/** マイクロタスクを全部流す(マクロタスクを 1 つ挟めば必ず空になる)。 */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

interface Harness {
  readonly clock: FakeClock;
  readonly scheduler: SaveScheduler;
  readonly writes: GameState[];
  readonly flushes: FlushInfo[];
}

function harness(
  overrides: { readonly write?: (state: GameState) => Promise<unknown> } = {},
): Harness {
  const clock = new FakeClock();
  const writes: GameState[] = [];
  const flushes: FlushInfo[] = [];
  const scheduler = new SaveScheduler({
    clock,
    write:
      overrides.write ??
      ((state: GameState) => {
        writes.push(state);
        return Promise.resolve();
      }),
    onFlush: (info) => flushes.push(info),
  });
  return { clock, scheduler, writes, flushes };
}

// --- 1. 2秒デバウンス ------------------------------------------------------

describe("2秒デバウンス", () => {
  it("2 秒経つまで書かない", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.recordCommands(STATE);
    await clock.advance(SAVE_DEBOUNCE_MS - 1);
    expect(writes).toHaveLength(0);
    await clock.advance(1);
    expect(writes).toEqual([STATE]);
    scheduler.dispose();
  });

  it("コマンドが続く間はタイマが張り直される(静かになってから 2 秒)", async () => {
    const { clock, scheduler, writes, flushes } = harness();
    scheduler.recordCommands(STATE);
    await clock.advance(1_500);
    scheduler.recordCommands(STATE_B);
    await clock.advance(1_500);
    expect(writes).toHaveLength(0);
    await clock.advance(500);
    expect(writes).toEqual([STATE_B]);
    expect(flushes[0]?.reason).toBe("debounce");
    expect(flushes[0]?.commandCount).toBe(2);
    scheduler.dispose();
  });

  it("書くものが無ければタイマも書込も起きない", async () => {
    const { clock, scheduler, writes } = harness();
    await scheduler.flush("manual");
    await clock.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(writes).toHaveLength(0);
    expect(clock.armedTimerCount).toBe(0);
    scheduler.dispose();
  });
});

// --- 2. 絶対件数(25 コマンド) ---------------------------------------------

describe("絶対件数の強制フラッシュ", () => {
  it("25 コマンド目で即書く(デバウンスを待たない)", async () => {
    const { clock, scheduler, writes, flushes } = harness();
    for (let i = 0; i < SAVE_MAX_COMMANDS - 1; i++) {
      scheduler.recordCommands(STATE);
    }
    expect(writes).toHaveLength(0);
    scheduler.recordCommands(STATE_B);
    await flushMicrotasks();
    expect(writes).toEqual([STATE_B]);
    expect(flushes[0]?.reason).toBe("command-count");
    expect(flushes[0]?.commandCount).toBe(SAVE_MAX_COMMANDS);
    expect(clock.now()).toBe(0);
    scheduler.dispose();
  });

  it("まとめて数えたコマンドでも件数上限で発火する", async () => {
    const { scheduler, writes, flushes } = harness();
    scheduler.recordCommands(STATE, SAVE_MAX_COMMANDS);
    await flushMicrotasks();
    expect(writes).toEqual([STATE]);
    expect(flushes[0]?.reason).toBe("command-count");
    scheduler.dispose();
  });

  it("書込後は件数カウンタが 0 に戻る", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.recordCommands(STATE, SAVE_MAX_COMMANDS);
    await flushMicrotasks();
    expect(scheduler.pendingCommandCount).toBe(0);
    scheduler.recordCommands(STATE_B);
    expect(scheduler.pendingCommandCount).toBe(1);
    await clock.advance(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(2);
    scheduler.dispose();
  });
});

// --- 3. 絶対時間(15 秒) ---------------------------------------------------

describe("絶対時間の強制フラッシュ", () => {
  it("コマンドが 1 秒ごとに続いてもデバウンスが 15 秒を越えて先送りしない", async () => {
    const { clock, scheduler, writes, flushes } = harness();
    for (let elapsed = 1_000; elapsed <= SAVE_MAX_INTERVAL_MS; elapsed += 1_000) {
      scheduler.recordCommands(STATE);
      await clock.advance(1_000);
      if (elapsed < SAVE_MAX_INTERVAL_MS) {
        expect(writes).toHaveLength(0);
      }
    }
    expect(clock.now()).toBe(SAVE_MAX_INTERVAL_MS);
    expect(writes).toHaveLength(1);
    expect(flushes[0]?.reason).toBe("elapsed");
    scheduler.dispose();
  });

  it("締切を過ぎてからのコマンドは即書く", async () => {
    const { clock, scheduler, writes, flushes } = harness();
    clock.set(SAVE_MAX_INTERVAL_MS + 1);
    scheduler.recordCommands(STATE);
    await flushMicrotasks();
    expect(writes).toEqual([STATE]);
    expect(flushes[0]?.reason).toBe("elapsed");
    scheduler.dispose();
  });

  it("締切は**前回書込**から測り直される", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.recordCommands(STATE);
    await clock.advance(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(1);
    // 直前に書いたので、次の締切は 2000 + 15000 = 17000。
    scheduler.recordCommands(STATE_B);
    await clock.advance(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(2);
    scheduler.dispose();
  });
});

// --- 4. catch-up 中は末尾 1 回 ---------------------------------------------

describe("catch-up", () => {
  it("catch-up 中は件数も時間も発火せず、終了時に 1 回だけ書く", async () => {
    const { clock, scheduler, writes, flushes } = harness();
    scheduler.beginCatchUp();
    for (let i = 0; i < SAVE_MAX_COMMANDS * 3; i++) {
      scheduler.recordCommands(STATE);
    }
    await clock.advance(SAVE_MAX_INTERVAL_MS * 3);
    expect(writes).toHaveLength(0);

    await scheduler.endCatchUp();
    expect(writes).toEqual([STATE]);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.reason).toBe("catch-up-end");
    expect(flushes[0]?.commandCount).toBe(SAVE_MAX_COMMANDS * 3);
    scheduler.dispose();
  });

  it("catch-up 開始時に張ってあったタイマは止まる", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.recordCommands(STATE);
    expect(clock.armedTimerCount).toBe(1);
    scheduler.beginCatchUp();
    expect(clock.armedTimerCount).toBe(0);
    await clock.advance(SAVE_MAX_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    scheduler.dispose();
  });

  it("catch-up 終了後は通常のデバウンスへ戻る", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.beginCatchUp();
    scheduler.recordCommands(STATE);
    await scheduler.endCatchUp();
    expect(writes).toHaveLength(1);
    scheduler.recordCommands(STATE_B);
    await clock.advance(SAVE_DEBOUNCE_MS);
    expect(writes).toEqual([STATE, STATE_B]);
    scheduler.dispose();
  });
});

// --- 5. ライフサイクルイベント ----------------------------------------------

class FakeLifecycleTarget implements LifecycleTarget {
  private readonly listeners = new Map<string, (() => void)[]>();

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

describe("attachLifecycleFlush", () => {
  it("pagehide で即書く", async () => {
    const { scheduler, writes } = harness();
    const target = new FakeLifecycleTarget();
    attachLifecycleFlush(scheduler, target, () => true);
    scheduler.recordCommands(STATE);
    target.dispatch("pagehide");
    await flushMicrotasks();
    expect(writes).toEqual([STATE]);
    scheduler.dispose();
  });

  it("visibilitychange は隠れたときだけ書く", async () => {
    const { scheduler, writes } = harness();
    const target = new FakeLifecycleTarget();
    let hidden = false;
    attachLifecycleFlush(scheduler, target, () => hidden);
    scheduler.recordCommands(STATE);
    target.dispatch("visibilitychange");
    await flushMicrotasks();
    expect(writes).toHaveLength(0);

    hidden = true;
    target.dispatch("visibilitychange");
    await flushMicrotasks();
    expect(writes).toEqual([STATE]);
    scheduler.dispose();
  });

  it("戻り値を呼べば配線が外れる", () => {
    const { scheduler } = harness();
    const target = new FakeLifecycleTarget();
    const detach = attachLifecycleFlush(scheduler, target, () => true);
    expect(target.count("pagehide")).toBe(1);
    detach();
    expect(target.count("pagehide")).toBe(0);
    expect(target.count("visibilitychange")).toBe(0);
    scheduler.dispose();
  });
});

// --- 6. 書込の直列化と失敗 --------------------------------------------------

describe("書込の直列化", () => {
  it("飛行中の書込が終わるまで次の書込を始めない", async () => {
    const started: number[] = [];
    const resolvers: (() => void)[] = [];
    const clock = new FakeClock();
    const scheduler = new SaveScheduler({
      clock,
      write: (state: GameState) => {
        started.push(state.entityStateById.size);
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
    });

    scheduler.recordCommands(STATE);
    const first = scheduler.flush("manual");
    await flushMicrotasks();
    expect(started).toEqual([1]);

    scheduler.recordCommands(STATE_B);
    const second = scheduler.flush("manual");
    await flushMicrotasks();
    // 1 本目が未完了なので 2 本目はまだ始まっていない。
    expect(started).toEqual([1]);

    resolvers[0]?.();
    await flushMicrotasks();
    expect(started).toEqual([1, 2]);
    resolvers[1]?.();
    await Promise.all([first, second]);
    scheduler.dispose();
  });

  it("飛行中に溜まった変更は次の 1 回にまとめられる(最新だけ書く)", async () => {
    const written: GameState[] = [];
    const resolvers: (() => void)[] = [];
    const clock = new FakeClock();
    const scheduler = new SaveScheduler({
      clock,
      write: (state: GameState) => {
        written.push(state);
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
    });

    scheduler.recordCommands(STATE);
    void scheduler.flush("manual");
    await flushMicrotasks();

    scheduler.recordCommands(STATE);
    scheduler.recordCommands(STATE_B);
    void scheduler.flush("manual");
    resolvers[0]?.();
    await flushMicrotasks();
    resolvers[1]?.();
    await flushMicrotasks();
    expect(written).toEqual([STATE, STATE_B]);
    scheduler.dispose();
  });
});

describe("書込の失敗", () => {
  it("onError があれば通知され、以後の書込は巻き添えにならない", async () => {
    const failures: unknown[] = [];
    const written: GameState[] = [];
    const clock = new FakeClock();
    let failNext = true;
    const scheduler = new SaveScheduler({
      clock,
      write: (state: GameState) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("QuotaExceededError"));
        }
        written.push(state);
        return Promise.resolve();
      },
      onError: (error) => failures.push(error),
    });

    scheduler.recordCommands(STATE);
    await scheduler.flush("manual");
    expect(failures).toHaveLength(1);
    expect(written).toHaveLength(0);

    scheduler.recordCommands(STATE_B);
    await scheduler.flush("manual");
    expect(written).toEqual([STATE_B]);
    scheduler.dispose();
  });

  it("onError が無ければ flush の Promise が reject する(黙って消さない)", async () => {
    const clock = new FakeClock();
    const scheduler = new SaveScheduler({
      clock,
      write: () => Promise.reject(new Error("書けない")),
    });
    scheduler.recordCommands(STATE);
    await expect(scheduler.flush("manual")).rejects.toThrow("書けない");
    scheduler.dispose();
  });

  it("失敗しても締切の起点は進む(毎コマンド書込の暴走を防ぐ)", async () => {
    const attempts: number[] = [];
    const clock = new FakeClock();
    const scheduler = new SaveScheduler({
      clock,
      write: () => {
        attempts.push(clock.now());
        return Promise.reject(new Error("書けない"));
      },
      onError: () => undefined,
    });
    clock.set(SAVE_MAX_INTERVAL_MS + 1);
    scheduler.recordCommands(STATE);
    await flushMicrotasks();
    expect(attempts).toHaveLength(1);
    // 締切が更新されていなければ、次のコマンドでも即書込になってしまう。
    scheduler.recordCommands(STATE_B);
    await flushMicrotasks();
    expect(attempts).toHaveLength(1);
    scheduler.dispose();
  });
});

// --- 7. 設定と後始末 --------------------------------------------------------

describe("設定と後始末", () => {
  it("既定値は ADR-012(1) の数値", () => {
    expect(SAVE_DEBOUNCE_MS).toBe(2_000);
    expect(SAVE_MAX_INTERVAL_MS).toBe(15_000);
    expect(SAVE_MAX_COMMANDS).toBe(25);
  });

  it("デバウンスが絶対時間より長い設定は拒否する", () => {
    expect(
      () =>
        new SaveScheduler({
          clock: new FakeClock(),
          write: () => Promise.resolve(),
          debounceMs: 20_000,
          maxIntervalMs: 15_000,
        }),
    ).toThrow();
  });

  it("しきい値が 0 以下の設定は拒否する", () => {
    expect(
      () =>
        new SaveScheduler({
          clock: new FakeClock(),
          write: () => Promise.resolve(),
          maxCommands: 0,
        }),
    ).toThrow();
  });

  it("dispose 後はタイマも書込も起きない", async () => {
    const { clock, scheduler, writes } = harness();
    scheduler.recordCommands(STATE);
    scheduler.dispose();
    await clock.advance(SAVE_MAX_INTERVAL_MS);
    expect(writes).toHaveLength(0);
    expect(clock.armedTimerCount).toBe(0);
    expect(() => scheduler.recordCommands(STATE)).toThrow();
  });

  it("commandCount は 1 以上の整数のみ", () => {
    const { scheduler } = harness();
    expect(() => scheduler.recordCommands(STATE, 0)).toThrow();
    expect(() => scheduler.recordCommands(STATE, 1.5)).toThrow();
    scheduler.dispose();
  });
});

// --- 6. コマンド適用との結線(M49) ----------------------------------------

describe("recordCommandOutcome(engine コマンド層との結線・M49)", () => {
  const CONTENT = content();
  const BOARD = stateOf([facility("fHearth", HEARTH.id, 14), resident("aRui")]);

  const PLACE: Command = {
    kind: "placeFacility",
    facilityId: id("fNew"),
    defId: HEARTH.id,
    cellIndex: 21,
  };

  it("受理されたコマンドは書込トリガとして数える", async () => {
    const { clock, scheduler, writes } = harness();
    const result = apply(BOARD, CONTENT, PLACE);

    expect(scheduler.recordCommandOutcome(result)).toBe(true);
    expect(scheduler.pendingCommandCount).toBe(1);
    await clock.advance(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(1);
    if (result.ok) expect(writes[0]).toBe(result.state);
    scheduler.dispose();
  });

  it("拒否されたコマンドは 1 件も数えない(state が動いていないので書く理由が無い)", async () => {
    const { clock, scheduler, writes } = harness();
    // セル 14 は占有済み = cellOccupied で reject される。
    const result = apply(BOARD, CONTENT, { ...PLACE, cellIndex: 14 });

    expect(result.ok).toBe(false);
    expect(scheduler.recordCommandOutcome(result)).toBe(false);
    expect(scheduler.isDirty).toBe(false);
    expect(scheduler.pendingCommandCount).toBe(0);
    await clock.advance(SAVE_MAX_INTERVAL_MS * 2);
    expect(writes).toHaveLength(0);
    scheduler.dispose();
  });

  it("列コマンドは要素数ぶん数える(25 件の絶対フラッシュの単位を取り違えない)", () => {
    const { scheduler } = harness();
    const result = apply(BOARD, CONTENT, [
      PLACE,
      { kind: "assignResident", residentId: id("aRui"), facilityId: id("fNew") },
    ]);

    expect(scheduler.recordCommandOutcome(result)).toBe(true);
    expect(scheduler.pendingCommandCount).toBe(2);
    scheduler.dispose();
  });
});
