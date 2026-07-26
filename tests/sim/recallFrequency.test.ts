import { describe, expect, it } from "vitest";

import { PATTERNS } from "../../sim/board";
import { measureRecallFrequency } from "../../sim/recallFrequency";

describe("sim/recallFrequency", () => {
  it("produces a per-pattern breakdown that cross-checks against the scheduler (1 seed, fast)", () => {
    const report = measureRecallFrequency({ seeds: ["recall-freq-test-seed"] });
    expect(report.byPattern.length).toBe(PATTERNS.length);
    expect(report.totalResidentWeeks).toBe(PATTERNS.length * 2 * 1);
    expect(Number.isFinite(report.overallOccurrencesPerResidentPerWeek)).toBe(true);
    for (const entry of report.byPattern) {
      expect(entry.residentCount).toBe(2);
      expect(entry.occurrenceCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("is deterministic across repeated measurements with the same seed", () => {
    const a = measureRecallFrequency({ seeds: ["recall-freq-determinism-seed"] });
    const b = measureRecallFrequency({ seeds: ["recall-freq-determinism-seed"] });
    expect(a.byPattern).toEqual(b.byPattern);
    expect(a.totalOccurrences).toBe(b.totalOccurrences);
    expect(a.overallOccurrencesPerResidentPerWeek).toBe(b.overallOccurrencesPerResidentPerWeek);
  });

  it("the worst-case pattern is never less risky than the calmest pattern", () => {
    // Sanity check on the representative-pattern design itself (not a strict
    // frequency assertion, since a single seed/week sample is noisy): across
    // enough seeds the worst-case (harsh/low-morale/dispatched) pattern's
    // average should not fall meaningfully below the calmest (normal/high-morale)
    // pattern's average.
    const report = measureRecallFrequency({
      seeds: Array.from({ length: 6 }, (_, i) => `recall-freq-sanity-${String(i)}`),
    });
    const calmest = report.byPattern.find((p) => p.patternId === "normal-morale-high");
    const worst = report.byPattern.find((p) => p.patternId === "worst-case");
    expect(calmest).toBeDefined();
    expect(worst).toBeDefined();
    if (calmest !== undefined && worst !== undefined) {
      expect(worst.occurrencesPerResidentPerWeek).toBeGreaterThanOrEqual(
        calmest.occurrencesPerResidentPerWeek,
      );
    }
  });
});
