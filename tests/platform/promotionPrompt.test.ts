// ---------------------------------------------------------------------------
// M34: `src/platform/promotionPrompt.ts`(誘導バナー汎用トラッカー)のテスト。
//
// `backupReminder.test.ts` と同じ方針で、実時間を一切使わずに偽の壁時計を
// 注入して検証する。固定するのは:
//   1. 初回観測からの猶予(minElapsedSinceFirstSeenMs)
//   2. 再表示間隔(reshowIntervalMs)
//   3. 通算表示回数の上限(maxShowCount)
//   4. 3 条件の AND(backupReminder の OR とは対照的)
//   5. 壁時計の巻き戻りで経過が負にならない(§3 の防御)
//   6. snapshot/initialSnapshot による永続化の往復
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  PromotionPromptError,
  PromotionPromptTracker,
  loadPromotionPromptSnapshot,
  savePromotionPromptSnapshot,
  type PromptStorageLike,
  type WallClock,
} from "../../src/platform/promotionPrompt";

class FakeClock implements WallClock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: number): void {
    this.current = at;
  }
}

describe("初回観測からの猶予", () => {
  it("猶予未満は shouldShow: false", () => {
    const clock = new FakeClock(1_000);
    const tracker = new PromotionPromptTracker({ clock, minElapsedSinceFirstSeenMs: 10_000 });
    clock.advance(9_999);
    expect(tracker.status().shouldShow).toBe(false);
  });

  it("猶予に達すると shouldShow: true(他条件が満たされていれば)", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock, minElapsedSinceFirstSeenMs: 10_000 });
    clock.advance(10_000);
    expect(tracker.status().shouldShow).toBe(true);
  });

  it("既定は猶予 0(即座に出せる)", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock });
    expect(tracker.status().shouldShow).toBe(true);
  });
});

describe("再表示間隔(しつこくしない・§1)", () => {
  it("表示直後は次の間隔まで shouldShow: false", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock, reshowIntervalMs: 5_000 });
    expect(tracker.status().shouldShow).toBe(true);
    tracker.recordShown();
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(4_999);
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(1);
    expect(tracker.status().shouldShow).toBe(true);
  });

  it("既定は再表示間隔が事実上無制限(1 度出したら以後出さない)", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock });
    tracker.recordShown();
    clock.advance(365 * 24 * 60 * 60 * 1000);
    expect(tracker.status().shouldShow).toBe(false);
  });
});

describe("通算表示回数の上限(いつかは黙る・§1)", () => {
  it("上限に達すると capped: true・shouldShow は恒久的に false", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({
      clock,
      reshowIntervalMs: 1_000,
      maxShowCount: 2,
    });
    tracker.recordShown();
    clock.advance(1_000);
    expect(tracker.status().capped).toBe(false);
    tracker.recordShown();
    expect(tracker.status().capped).toBe(true);
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(1_000_000);
    expect(tracker.status().shouldShow).toBe(false);
  });

  it("既定は上限なし", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock, reshowIntervalMs: 0 });
    for (let i = 0; i < 50; i++) tracker.recordShown();
    expect(tracker.status().capped).toBe(false);
  });
});

describe("3 条件の AND(backupReminder.ts の OR とは対照的)", () => {
  it("猶予・間隔・上限のいずれか 1 つでも満たさなければ shouldShow: false", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({
      clock,
      minElapsedSinceFirstSeenMs: 100,
      reshowIntervalMs: 100,
      maxShowCount: 2,
    });
    // 猶予未満
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(100);
    // 猶予は満たすが未表示なので true
    expect(tracker.status().shouldShow).toBe(true);
    tracker.recordShown();
    // 直後は間隔未満
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(100);
    expect(tracker.status().shouldShow).toBe(true);
    tracker.recordShown();
    // 上限に達した
    expect(tracker.status().shouldShow).toBe(false);
  });
});

describe("壁時計の巻き戻り(§3)", () => {
  it("経過を負にせず 0 に丸める(巻き戻りで永久に出なくなる方向へは壊れない)", () => {
    const clock = new FakeClock(10_000);
    const tracker = new PromotionPromptTracker({ clock, minElapsedSinceFirstSeenMs: 0 });
    clock.set(0); // システム時刻が過去へ巻き戻った
    const status = tracker.status();
    expect(status.elapsedSinceFirstSeenMs).toBe(0);
    expect(status.shouldShow).toBe(true);
  });
});

describe("snapshot / initialSnapshot(永続化の往復)", () => {
  it("snapshot から別トラッカーを復元すると同じ判定になる", () => {
    const clock = new FakeClock();
    const tracker = new PromotionPromptTracker({ clock, reshowIntervalMs: 1_000 });
    tracker.recordShown();
    clock.advance(500);

    const snapshot = tracker.snapshot();
    const restored = new PromotionPromptTracker({
      clock,
      reshowIntervalMs: 1_000,
      initialSnapshot: snapshot,
    });
    expect(restored.status()).toEqual(tracker.status());
  });

  it("initialSnapshot 省略時は未観測扱い(firstSeenAt = 構築時刻)", () => {
    const clock = new FakeClock(42);
    const tracker = new PromotionPromptTracker({ clock });
    expect(tracker.snapshot()).toEqual({ firstSeenAt: 42, lastShownAt: null, shownCount: 0 });
  });
});

describe("設定の検証", () => {
  it("minElapsedSinceFirstSeenMs が負/非有限なら拒否する", () => {
    expect(() => new PromotionPromptTracker({ minElapsedSinceFirstSeenMs: -1 })).toThrow(
      PromotionPromptError,
    );
    expect(() => new PromotionPromptTracker({ minElapsedSinceFirstSeenMs: Number.NaN })).toThrow();
  });

  it("reshowIntervalMs が負なら拒否する(Infinity は許容)", () => {
    expect(() => new PromotionPromptTracker({ reshowIntervalMs: -1 })).toThrow();
    expect(
      () => new PromotionPromptTracker({ reshowIntervalMs: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });

  it("maxShowCount が 0 以下/非整数なら拒否する(Infinity は許容)", () => {
    expect(() => new PromotionPromptTracker({ maxShowCount: 0 })).toThrow();
    expect(() => new PromotionPromptTracker({ maxShowCount: 1.5 })).toThrow();
    expect(
      () => new PromotionPromptTracker({ maxShowCount: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });
});

describe("永続化ヘルパ(loadPromotionPromptSnapshot/savePromotionPromptSnapshot)", () => {
  function fakeStorage(initial: Record<string, string> = {}): PromptStorageLike {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it("無い場合は null", () => {
    expect(loadPromotionPromptSnapshot(fakeStorage(), "kf:test")).toBeNull();
  });

  it("壊れた JSON は null(投げない)", () => {
    expect(
      loadPromotionPromptSnapshot(fakeStorage({ "kf:test": "{not json" }), "kf:test"),
    ).toBeNull();
  });

  it("形が違う値は null(必須キー欠落)", () => {
    const storage = fakeStorage({ "kf:test": JSON.stringify({ shownCount: 1 }) });
    expect(loadPromotionPromptSnapshot(storage, "kf:test")).toBeNull();
  });

  it("保存 → 読出の往復が一致する", () => {
    const storage = fakeStorage();
    const snapshot = { firstSeenAt: 10, lastShownAt: 20, shownCount: 3 };
    savePromotionPromptSnapshot(storage, "kf:test", snapshot);
    expect(loadPromotionPromptSnapshot(storage, "kf:test")).toEqual(snapshot);
  });

  it("setItem が例外を投げても save は投げない(致命的でない・§3)", () => {
    const storage: PromptStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() =>
      savePromotionPromptSnapshot(storage, "kf:test", {
        firstSeenAt: 0,
        lastShownAt: null,
        shownCount: 0,
      }),
    ).not.toThrow();
  });

  it("getItem が例外を投げても load は null を返す(投げない)", () => {
    const storage: PromptStorageLike = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => undefined,
    };
    expect(loadPromotionPromptSnapshot(storage, "kf:test")).toBeNull();
  });
});
