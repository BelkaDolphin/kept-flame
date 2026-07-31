// ---------------------------------------------------------------------------
// src/ui/screens/grid/facilityId.ts のテスト(M30・M18★4への回答)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { nextFacilityId } from "../../../src/ui/screens/grid/facilityId";
import { HEARTH, boardState, facility, id } from "../fixtures";

describe("nextFacilityId(施設 ID 採番・M18★4)", () => {
  it("盤面に同じ defId が無ければ連番 1 から始まる", () => {
    const state = boardState();
    expect(nextFacilityId(state, HEARTH.id)).toBe(id("facHearth1"));
  });

  it("同じ state から 2 回呼べば同じ結果になる(決定論・Math.random 等を使わない)", () => {
    const state = boardState();
    expect(nextFacilityId(state, HEARTH.id)).toBe(nextFacilityId(state, HEARTH.id));
  });

  it("既存 ID と衝突しない最小の連番を選ぶ", () => {
    const state = boardState([facility("facHearth1", HEARTH.id, 40)]);
    expect(nextFacilityId(state, HEARTH.id)).toBe(id("facHearth2"));
  });

  it("採番した ID はまだ state に存在しない(placeFacility の entityIdInUse を踏まない)", () => {
    const state = boardState();
    const newId = nextFacilityId(state, HEARTH.id);
    expect(state.entityStateById.has(newId)).toBe(false);
  });
});
