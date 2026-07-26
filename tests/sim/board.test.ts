import { describe, expect, it } from "vitest";

import {
  PATTERNS,
  RESIDENT_COUNT,
  buildPatternBoard,
  patchCoarseTickMinutes,
  patternIdOfResidentId,
  resolveSimContent,
} from "../../sim/board";
import { entitiesOfKind, entityIdFromString } from "../../src/engine/state/state";

describe("sim/board", () => {
  it("has exactly 10 representative patterns totaling 20 residents", () => {
    expect(PATTERNS.length).toBe(10);
    expect(RESIDENT_COUNT).toBe(20);
  });

  it("builds a 20-resident / tech3 / 2-facility board", () => {
    const content = resolveSimContent();
    const state = buildPatternBoard("board-test-seed", content);
    expect(entitiesOfKind(state, "resident").length).toBe(RESIDENT_COUNT);
    expect(entitiesOfKind(state, "research").length).toBe(3);
    expect(entitiesOfKind(state, "facility").length).toBe(2);
    expect(entitiesOfKind(state, "resource").length).toBe(2);
  });

  it("maps every resident id back to a valid pattern (round-trip)", () => {
    const content = resolveSimContent();
    const state = buildPatternBoard("board-test-seed-2", content);
    for (const resident of entitiesOfKind(state, "resident")) {
      const patternId = patternIdOfResidentId(resident.id);
      expect(PATTERNS.some((p) => p.id === patternId)).toBe(true);
    }
  });

  it("is deterministic across repeated builds with the same seed", () => {
    const content = resolveSimContent();
    const a = buildPatternBoard("determinism-seed", content);
    const b = buildPatternBoard("determinism-seed", content);
    expect(JSON.stringify([...a.entityStateById.entries()])).toBe(
      JSON.stringify([...b.entityStateById.entries()]),
    );
  });

  it("resolves a coarseTickMinutes=1 fallback content patch", () => {
    const content = resolveSimContent(patchCoarseTickMinutes(1));
    expect(content.coarseTickMinutes).toBe(1);
  });

  it("rejects patterns whose resident id does not belong to the board", () => {
    expect(() => patternIdOfResidentId(entityIdFromString("residentUnknown"))).toThrow();
  });
});
