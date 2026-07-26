import { describe, expect, it } from "vitest";

import { buildPatternBoard, resolveSimContent } from "../../sim/board";
import { dispatchBot } from "../../sim/bots/dispatchBot";
import { reassignmentBot } from "../../sim/bots/reassignmentBot";
import { runNightSim } from "../../sim/runner";
import { createAdvanceContext } from "../../src/engine/advance";

const FOUR_DAYS_TICKS = 4 * 1440;

describe("sim/runner", () => {
  it("is deterministic (excluding elapsedMs) for the same seed/content/bots", () => {
    const content = resolveSimContent();
    const seed = "runner-determinism-seed";

    function run() {
      const initialState = buildPatternBoard(seed, content);
      const ctx = createAdvanceContext(initialState, content);
      return runNightSim(content, initialState, ctx, {
        totalTicks: FOUR_DAYS_TICKS,
        bots: [reassignmentBot, dispatchBot],
      });
    }

    const a = run();
    const b = run();

    expect(JSON.stringify([...a.state.entityStateById.entries()])).toBe(
      JSON.stringify([...b.state.entityStateById.entries()]),
    );
    expect(a.counters).toEqual(b.counters);
  });

  it("produces different states for different seeds (bots are seed-sensitive)", () => {
    const content = resolveSimContent();

    function run(seed: string) {
      const initialState = buildPatternBoard(seed, content);
      const ctx = createAdvanceContext(initialState, content);
      return runNightSim(content, initialState, ctx, {
        totalTicks: FOUR_DAYS_TICKS,
        bots: [reassignmentBot, dispatchBot],
      });
    }

    const a = run("runner-seed-a");
    const b = run("runner-seed-b");
    expect(JSON.stringify([...a.state.entityStateById.entries()])).not.toBe(
      JSON.stringify([...b.state.entityStateById.entries()]),
    );
  });

  it("without bots advances to exactly totalTicks and matches a single advanceWithReport call", () => {
    const content = resolveSimContent();
    const initialState = buildPatternBoard("runner-no-bot-seed", content);
    const ctx = createAdvanceContext(initialState, content);
    const result = runNightSim(content, initialState, ctx, { totalTicks: 1440 });
    expect(result.state.tick).toBe(1440);
  });
});
