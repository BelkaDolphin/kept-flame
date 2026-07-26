import { describe, expect, it } from "vitest";

import { deriveShardPlan, median, runCalibration } from "../../sim/calibrate";

describe("sim/calibrate: deriveShardPlan (ADR-014(1) shard formula)", () => {
  it("caps shards at 20 when total work is far above the 30-minute goal", () => {
    // 11000 runs * 5s/run = 55000s of total work, far beyond the 1800s goal.
    const plan = deriveShardPlan(11_000, 5);
    expect(plan.shards).toBe(20);
    expect(plan.runsPerShard).toBe(Math.ceil(11_000 / 20));
  });

  it("uses only 1 shard when total work already fits within the 30-minute goal", () => {
    // 11000 runs * 0.001s/run = 11s of total work.
    const plan = deriveShardPlan(11_000, 0.001);
    expect(plan.shards).toBe(1);
    expect(plan.meetsGoal).toBe(true);
    expect(plan.withinCap).toBe(true);
  });

  it("flags a shard plan that stays under the 20-shard cap but still misses the 360-minute cap", () => {
    // A pathological measuredSecPerRun that even 20 shards cannot bring under 360 min.
    const plan = deriveShardPlan(11_000, 200);
    expect(plan.shards).toBe(20);
    expect(plan.withinCap).toBe(false);
  });
});

describe("sim/calibrate: median", () => {
  it("returns the middle value for an odd-length array", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("throws on an empty array", () => {
    expect(() => median([])).toThrow();
  });
});

describe("sim/calibrate: runCalibration (light integration)", () => {
  it("produces a shard report with a sensible shape for a small run count", () => {
    const report = runCalibration({
      label: "test-tiny",
      coarseTickMinutes: 10,
      warmupRuns: 1,
      measuredRuns: 1,
    });
    expect(report.measured.length).toBe(1);
    expect(report.warmup.length).toBe(1);
    expect(report.measuredSecPerRun).toBeGreaterThan(0);
    expect(report.weekly.shards).toBeGreaterThanOrEqual(1);
    expect(report.weekly.shards).toBeLessThanOrEqual(20);
    expect(report.weekly.runsPerShard * report.weekly.shards).toBeGreaterThanOrEqual(11_000);
  });

  it("is deterministic (excluding elapsedMs) across repeated calibration runs with fixed seeds", () => {
    const params = {
      label: "test-determinism",
      coarseTickMinutes: 10,
      warmupRuns: 1,
      measuredRuns: 1,
      seeds: ["calibrate-determinism-0", "calibrate-determinism-1"],
    } as const;
    const a = runCalibration(params);
    const b = runCalibration(params);
    // measuredSecPerRun is wall-clock and expected to vary run to run; everything
    // else describing the *shard derivation shape* should not depend on timing noise
    // enough to change the qualitative pass/fail flags for this tiny fixed workload.
    expect(a.totalTicksPerRun).toBe(b.totalTicksPerRun);
    expect(a.measured.map((s) => s.seed)).toEqual(b.measured.map((s) => s.seed));
  });
});
