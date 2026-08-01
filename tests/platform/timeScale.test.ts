// ---------------------------------------------------------------------------
// src/platform/timeScale.ts のテスト(M59)— テストプレイ加速モードの倍速クロック
//
// tests/platform/clock.test.ts と同じ流儀: 偽物の単調時計(`fakeClock`)を
// 注入し、実タイマ/`performance.now()` に一切触れずに固定する。検分観点は
// タスク指示どおりの 4 点:
//
//   1. ×1(既定)は素通し
//   2. 倍率をかけると経過が倍率倍になる
//   3. setSpeed の直前直後で now() が連続(不連続ジャンプ無し・巻き戻り無し)
//   4. 不正な speed(0 以下・非有限・NaN)は例外
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { MonotonicClock } from "../../src/platform/clock";
import { createScaledClock, TimeScaleError } from "../../src/platform/timeScale";

/** 手で進める偽物の単調時計(clock.test.ts の fakeClock と同型)。 */
function fakeClock(startMs = 0): MonotonicClock & { advance(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createScaledClock(既定 speed=1 は素通し)", () => {
  it("speed を変えない限り base.now() をそのまま返す", () => {
    const base = fakeClock(1000);
    const scaled = createScaledClock(base);
    expect(scaled.speed()).toBe(1);
    expect(scaled.now()).toBe(1000);
    base.advance(500);
    expect(scaled.now()).toBe(1500);
    base.advance(123);
    expect(scaled.now()).toBe(1623);
  });
});

describe("createScaledClock(倍率で経過が倍になる)", () => {
  it("×60 なら base の経過 1ms あたり scaled は 60ms 進む", () => {
    const base = fakeClock(0);
    const scaled = createScaledClock(base);
    scaled.setSpeed(60);
    expect(scaled.speed()).toBe(60);
    base.advance(10);
    expect(scaled.now()).toBe(600);
    base.advance(5);
    expect(scaled.now()).toBe(900);
  });

  it("×720 も同じ式(base 経過 × speed)", () => {
    const base = fakeClock(0);
    const scaled = createScaledClock(base);
    scaled.setSpeed(720);
    base.advance(2);
    expect(scaled.now()).toBe(1440);
  });
});

describe("createScaledClock(setSpeed の連続性)", () => {
  it("経過してから速度を変えても、直前直後で now() がジャンプしない", () => {
    const base = fakeClock(0);
    const scaled = createScaledClock(base);
    base.advance(100);
    expect(scaled.now()).toBe(100); // ×1 のまま100ms経過
    const justBefore = scaled.now();
    scaled.setSpeed(60);
    const justAfter = scaled.now();
    expect(justAfter).toBe(justBefore); // 引き直しの瞬間は不連続ジャンプ無し
    base.advance(10);
    expect(scaled.now()).toBe(100 + 10 * 60); // 以後は新 speed で進む
  });

  it("複数回の速度変更を経ても単調に増え続ける(巻き戻らない)", () => {
    const base = fakeClock(0);
    const scaled = createScaledClock(base);
    const samples: number[] = [scaled.now()];
    base.advance(50);
    samples.push(scaled.now());
    scaled.setSpeed(60);
    samples.push(scaled.now());
    base.advance(3);
    samples.push(scaled.now());
    scaled.setSpeed(720);
    samples.push(scaled.now());
    base.advance(1);
    samples.push(scaled.now());
    scaled.setSpeed(1);
    samples.push(scaled.now());
    base.advance(20);
    samples.push(scaled.now());
    let previous = samples[0] as number;
    for (const sample of samples.slice(1)) {
      expect(sample).toBeGreaterThanOrEqual(previous);
      previous = sample;
    }
  });

  it("×1 へ戻すと以後は base と同じ刻みで進む(往復しても素通しに復元)", () => {
    const base = fakeClock(0);
    const scaled = createScaledClock(base);
    scaled.setSpeed(720);
    base.advance(1);
    const anchor = scaled.now(); // 720
    scaled.setSpeed(1);
    base.advance(50);
    expect(scaled.now()).toBe(anchor + 50);
  });
});

describe("createScaledClock(不正な speed は拒否)", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "speed=%p は TimeScaleError",
    (bad) => {
      const scaled = createScaledClock(fakeClock(0));
      expect(() => scaled.setSpeed(bad)).toThrow(TimeScaleError);
      // 拒否されたら speed も now() も変わらない(部分的に適用されない)。
      expect(scaled.speed()).toBe(1);
    },
  );
});
