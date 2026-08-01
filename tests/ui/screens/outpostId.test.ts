// ---------------------------------------------------------------------------
// src/ui/screens/outposts/outpostId.ts のテスト(M54・facilityId.test.ts と同型)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { setOutpost } from "../../../src/engine/state/update";
import { nextOutpostId } from "../../../src/ui/screens/outposts/outpostId";
import { boardState, facility, id, HEARTH } from "../fixtures";
import { outpostOf } from "../m32Fixtures";

const OUTPOST_TYPE_ID = id("outpostMine");

describe("nextOutpostId(拠点 ID 採番・M54)", () => {
  it("盤面に拠点が無ければ連番 1 から始まる", () => {
    const state = boardState();
    expect(nextOutpostId(state, OUTPOST_TYPE_ID)).toBe(id("outpostMine1"));
  });

  it("同じ state から 2 回呼べば同じ結果になる(決定論・Math.random 等を使わない)", () => {
    const state = boardState();
    expect(nextOutpostId(state, OUTPOST_TYPE_ID)).toBe(nextOutpostId(state, OUTPOST_TYPE_ID));
  });

  it("既存の拠点(outpostsById)と衝突しない最小の連番を選ぶ", () => {
    const state = setOutpost(
      boardState(),
      outpostOf("outpostMine1", "near", [id("aRui")], { outpostTypeId: OUTPOST_TYPE_ID }),
    );
    expect(nextOutpostId(state, OUTPOST_TYPE_ID)).toBe(id("outpostMine2"));
  });

  it("既存の entity(施設等)と同名でも衝突を避ける(entityStateById 側の検査)", () => {
    const state = boardState([facility("outpostMine1", HEARTH.id, 40)]);
    expect(nextOutpostId(state, OUTPOST_TYPE_ID)).toBe(id("outpostMine2"));
  });

  it("採番した ID はまだ拠点にも entity にも存在しない(establishOutpost の entityIdInUse を踏まない)", () => {
    const state = boardState();
    const newId = nextOutpostId(state, OUTPOST_TYPE_ID);
    expect(state.entityStateById.has(newId)).toBe(false);
  });
});
