// ---------------------------------------------------------------------------
// src/ui/testplaySpeed.ts のテスト(M59)
//
// ここで固定するのは「ブリッジが薄いこと」だけ: `setSpeed` が
// `ScaledClock.setSpeed` を呼んでから signal を更新すること、拒否されたら
// signal を動かさないこと、`speed` は読み取り専用として振る舞うこと。
// `ScaledClock` 自体の連続性/バリデーションは tests/platform/timeScale.test.ts
// が既に固定しているので、ここでは重複させない。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { createScaledClock, TimeScaleError, type ScaledClock } from "../../src/platform/timeScale";
import { createTestplaySpeedController } from "../../src/ui/testplaySpeed";

function fakeScaledClockAt(startMs: number): ScaledClock {
  return createScaledClock({ now: () => startMs });
}

describe("createTestplaySpeedController", () => {
  it("初期値は clock.speed()(既定 ×1)", () => {
    const controller = createTestplaySpeedController(fakeScaledClockAt(0));
    expect(controller.speed.peek()).toBe(1);
  });

  it("setSpeed は clock 側にも signal 側にも同じ値を反映する", () => {
    const clock = fakeScaledClockAt(0);
    const controller = createTestplaySpeedController(clock);
    controller.setSpeed(60);
    expect(controller.speed.peek()).toBe(60);
    expect(clock.speed()).toBe(60);
  });

  it("不正値は TimeScaleError で拒否し、signal は動かさない(部分適用しない)", () => {
    const clock = fakeScaledClockAt(0);
    const controller = createTestplaySpeedController(clock);
    controller.setSpeed(60);
    // TESTPLAY_SPEEDS の型は正の値のみだが、setSpeed 自体は ScaledClock の
    // バリデーションへ委譲しているので、不正値(0)を渡すと例外が伝播する。
    expect(() => controller.setSpeed(0 as never)).toThrow(TimeScaleError);
    expect(controller.speed.peek()).toBe(60);
    expect(clock.speed()).toBe(60);
  });

  it("購読すると speed 変化を通知される", () => {
    const controller = createTestplaySpeedController(fakeScaledClockAt(0));
    const seen: number[] = [];
    const dispose = controller.speed.subscribe((value) => seen.push(value));
    controller.setSpeed(720);
    dispose();
    expect(seen).toEqual([1, 720]);
  });
});
