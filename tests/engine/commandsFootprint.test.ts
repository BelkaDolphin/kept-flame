// ---------------------------------------------------------------------------
// M16: 配置コマンドの footprint 対応(`src/engine/commands.ts` の placeFacility /
// demolishFacility)のテスト。
//
// 固定するのは 5 点:
//   (1) content の footprint が **配置時に state へ焼き込まれる**(1×1 は省略)
//   (2) 衝突検査が**全占有セル**に効き、`cellIndex` には衝突セルのうち最小が載る
//   (3) 盤外はみ出しが `footprintOutOfGrid`(= `cellOutOfRange` とは別語彙)
//   (4) 解体で**全占有セルが同時に空く**(同じ場所へ建て直せる)
//   (5) reject 時に state が 1 bit も動かず、成功時は 2 回適用でバイト同一
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { apply, type Command, type CommandRejectionCode } from "../../src/engine/commands";
import { occupiedCellsOfFacility } from "../../src/engine/footprint";
import type { EngineContent, FacilityDef } from "../../src/engine/rules/types";
import { toSerializable } from "../../src/engine/state/serialize";
import type { FacilityFootprint, GameState } from "../../src/engine/state/state";

import { HEARTH, content as baseContent, facility, id, stateOf } from "./fixtures";

const FP_1X1: FacilityFootprint = { width: 1, height: 1 };
const FP_2X1: FacilityFootprint = { width: 2, height: 1 };
const FP_2X2: FacilityFootprint = { width: 2, height: 2 };

const withFootprint = (def: FacilityDef, footprint: FacilityFootprint): FacilityDef => ({
  ...def,
  footprint,
});

/** 1×1 / 2×1 / 2×2 / 不正(3×3)の 4 定義を持つ content。 */
const HALL_2X1 = withFootprint({ ...HEARTH, id: id("hall") }, FP_2X1);
const YARD_2X2 = withFootprint({ ...HEARTH, id: id("yard") }, FP_2X2);
const UNIT_EXPLICIT = withFootprint({ ...HEARTH, id: id("shed") }, FP_1X1);
const BROKEN_3X3 = withFootprint({ ...HEARTH, id: id("keep") }, { width: 3, height: 3 });

const CONTENT: EngineContent = baseContent({
  facilityDefs: new Map([
    [HEARTH.id, HEARTH],
    [HALL_2X1.id, HALL_2X1],
    [YARD_2X2.id, YARD_2X2],
    [UNIT_EXPLICIT.id, UNIT_EXPLICIT],
    [BROKEN_3X3.id, BROKEN_3X3],
  ]),
});

const place = (facilityId: string, defId: string, cellIndex: number): Command => ({
  kind: "placeFacility",
  facilityId: id(facilityId),
  defId: id(defId),
  cellIndex,
});

function accepted(state: GameState, command: Command | readonly Command[]): GameState {
  const result = apply(state, CONTENT, command);
  if (!result.ok) throw new Error(`想定外の reject: ${result.rejection.code}`);
  return result.state;
}

function rejectionOf(
  state: GameState,
  command: Command | readonly Command[],
): CommandRejectionCode {
  const result = apply(state, CONTENT, command);
  if (result.ok) throw new Error("reject されるはずが accept された");
  return result.rejection.code;
}

// --- 1. 配置時の焼き込み ----------------------------------------------------

describe("placeFacility: footprint の焼き込み", () => {
  it("2×1 の定義は state に footprint を持ち、2 セルを占有する", () => {
    const next = accepted(stateOf([]), place("fHall", "hall", 0));
    const entity = next.entityStateById.get(id("fHall"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.footprint).toEqual(FP_2X1);
    expect(entity.cellIndex).toBe(0);
    expect(occupiedCellsOfFacility(entity)).toEqual([0, 1]);
  });

  it("2×2 の定義は 4 セルを占有する", () => {
    const next = accepted(stateOf([]), place("fYard", "yard", 7));
    const entity = next.entityStateById.get(id("fYard"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(occupiedCellsOfFacility(entity)).toEqual([7, 8, 13, 14]);
  });

  it("1×1 の定義は footprint キーを持たない(省略が正準形)", () => {
    const next = accepted(stateOf([]), place("fHearth", "hearth", 3));
    const entity = next.entityStateById.get(id("fHearth"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.footprint).toBeUndefined();
    expect(JSON.stringify(toSerializable(next))).not.toContain("footprint");
  });

  it("content が 1×1 を明示していても state では省略される", () => {
    const next = accepted(stateOf([]), place("fShed", "shed", 3));
    const entity = next.entityStateById.get(id("fShed"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.footprint).toBeUndefined();
  });

  it("engine が表現できない footprint の定義は contentUnsupported", () => {
    expect(rejectionOf(stateOf([]), place("fKeep", "keep", 0))).toBe("contentUnsupported");
  });

  it("配置は state を書き換えない(純関数)", () => {
    const before = stateOf([]);
    const snapshot = JSON.stringify(toSerializable(before));
    accepted(before, place("fHall", "hall", 0));
    expect(JSON.stringify(toSerializable(before))).toBe(snapshot);
  });

  it("同じ配置を 2 回別々に適用するとバイト同一(決定論)", () => {
    const base = stateOf([]);
    const first = accepted(base, place("fYard", "yard", 20));
    const second = accepted(base, place("fYard", "yard", 20));
    expect(JSON.stringify(toSerializable(first))).toBe(JSON.stringify(toSerializable(second)));
  });
});

// --- 2. 盤外はみ出し --------------------------------------------------------

describe("placeFacility: footprintOutOfGrid", () => {
  it("右端の 2×1 は footprintOutOfGrid(cellOutOfRange とは別語彙)", () => {
    const result = apply(stateOf([]), CONTENT, place("fHall", "hall", 5));
    if (result.ok) throw new Error("reject されるはず");
    expect(result.rejection.code).toBe("footprintOutOfGrid");
    expect(result.rejection.cellIndex).toBe(5);
  });

  it("下端の 2×2 は footprintOutOfGrid", () => {
    expect(rejectionOf(stateOf([]), place("fYard", "yard", 42))).toBe("footprintOutOfGrid");
    expect(rejectionOf(stateOf([]), place("fYard", "yard", 47))).toBe("footprintOutOfGrid");
  });

  it("格子外のセル番号は従来どおり cellOutOfRange(語彙が入れ替わっていない)", () => {
    expect(rejectionOf(stateOf([]), place("fHall", "hall", 48))).toBe("cellOutOfRange");
    expect(rejectionOf(stateOf([]), place("fHall", "hall", -1))).toBe("cellOutOfRange");
    expect(rejectionOf(stateOf([]), place("fHearth", "hearth", 48))).toBe("cellOutOfRange");
  });

  it("ちょうど収まる位置は通る(右下角の 2×2)", () => {
    expect(() => accepted(stateOf([]), place("fYard", "yard", 40))).not.toThrow();
  });

  it("1×1 は右端・下端でも置ける(既存挙動の維持)", () => {
    expect(() => accepted(stateOf([]), place("fHearth", "hearth", 47))).not.toThrow();
  });
});

// --- 3. 占有衝突 ------------------------------------------------------------

describe("placeFacility: 占有衝突(全占有セル)", () => {
  it("大型施設の非アンカーセルへ 1×1 を置くと cellOccupied", () => {
    const withHall = accepted(stateOf([]), place("fHall", "hall", 0)); // 0, 1
    const result = apply(withHall, CONTENT, place("fHearth", "hearth", 1));
    if (result.ok) throw new Error("reject されるはず");
    expect(result.rejection.code).toBe("cellOccupied");
    expect(result.rejection.cellIndex).toBe(1);
    expect(result.rejection.subjectId).toBe(id("fHall"));
  });

  it("既存 1×1 の上へ大型施設を重ねると cellOccupied", () => {
    const base = stateOf([facility("fHearth", HEARTH.id, 1)]);
    const result = apply(base, CONTENT, place("fHall", "hall", 0)); // 0, 1
    if (result.ok) throw new Error("reject されるはず");
    expect(result.rejection.code).toBe("cellOccupied");
    expect(result.rejection.cellIndex).toBe(1);
    expect(result.rejection.subjectId).toBe(id("fHearth"));
  });

  it("衝突セルが複数あるとき載るのは最小のセル番号(決定論)", () => {
    // 2×2 を cell 0 に置くと [0,1,6,7]。既存が cell 6 と cell 7 にある。
    const base = stateOf([facility("fA", HEARTH.id, 7), facility("fB", HEARTH.id, 6)]);
    const result = apply(base, CONTENT, place("fYard", "yard", 0));
    if (result.ok) throw new Error("reject されるはず");
    expect(result.rejection.cellIndex).toBe(6);
    expect(result.rejection.subjectId).toBe(id("fB"));
  });

  it("大型施設どうしの部分的な重なりも検出する", () => {
    const withYard = accepted(stateOf([]), place("fYard", "yard", 7)); // 7,8,13,14
    // 2×1 を cell 13 に置くと [13,14] = 完全に内側。
    expect(rejectionOf(withYard, place("fHall", "hall", 13))).toBe("cellOccupied");
    // 2×1 を cell 12 に置くと [12,13] = 片側だけ重なる。
    expect(rejectionOf(withYard, place("fHall", "hall", 12))).toBe("cellOccupied");
    // 2×1 を cell 9 に置くと [9,10] = 重ならない。
    expect(() => accepted(withYard, place("fHall", "hall", 9))).not.toThrow();
  });

  it("reject 時に state は 1 bit も動かない", () => {
    const withHall = accepted(stateOf([]), place("fHall", "hall", 0));
    const snapshot = JSON.stringify(toSerializable(withHall));
    const result = apply(withHall, CONTENT, place("fHearth", "hearth", 1));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(toSerializable(withHall))).toBe(snapshot);
  });
});

// --- 4. 解体と増築 ----------------------------------------------------------

describe("demolishFacility / upgradeFacility と footprint", () => {
  it("解体で全占有セルが同時に空く(同じ場所へ建て直せる)", () => {
    const withYard = accepted(stateOf([]), place("fYard", "yard", 7));
    const demolished = accepted(withYard, { kind: "demolishFacility", facilityId: id("fYard") });
    // 4 セルすべてが空いている = 1×1 をどこへでも置ける。
    for (const cell of [7, 8, 13, 14]) {
      expect(() => accepted(demolished, place("fHearth", "hearth", cell))).not.toThrow();
    }
    // 同じ大型施設を同じ場所へ建て直せる。
    expect(() => accepted(demolished, place("fYard2", "yard", 7))).not.toThrow();
  });

  it("解体前は占有セルへ置けない(上のテストが空振りでないことの反証)", () => {
    const withYard = accepted(stateOf([]), place("fYard", "yard", 7));
    for (const cell of [7, 8, 13, 14]) {
      expect(rejectionOf(withYard, place("fHearth", "hearth", cell))).toBe("cellOccupied");
    }
  });

  it("増築は footprint を変えない(占有形状は Lv に依らない)", () => {
    const withYard = accepted(stateOf([]), place("fYard", "yard", 7));
    const upgraded = accepted(withYard, { kind: "upgradeFacility", facilityId: id("fYard") });
    const entity = upgraded.entityStateById.get(id("fYard"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.level).toBe(2);
    expect(entity.footprint).toEqual(FP_2X2);
  });

  it("列コマンド(解体 → 同じ場所へ別の大型施設)が原子適用される", () => {
    const withYard = accepted(stateOf([]), place("fYard", "yard", 7));
    const next = accepted(withYard, [
      { kind: "demolishFacility", facilityId: id("fYard") },
      place("fHall", "hall", 7),
    ]);
    expect(next.entityStateById.has(id("fYard"))).toBe(false);
    const entity = next.entityStateById.get(id("fHall"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(occupiedCellsOfFacility(entity)).toEqual([7, 8]);
  });
});
