// ---------------------------------------------------------------------------
// M52: 瓦礫の開墾(`src/engine/rules/reclaim.ts` と `commands.ts` の reclaimCell)。
//
// ロードマップ M52 の検収条件そのものを固定する:
//   (1) 瓦礫セルへの**配置 / 増築**が reject される(大型施設は全占有セル)
//   (2) 開墾コストが `base × 1.15^解放数` で増え、cap で頭打ちになる(GDD 9.1)
//   (3) 瓦礫を持たない state の挙動が M52 以前と 1 bit も変わらない
// 旧セーブの無損失ロード(検収条件の 3 つめ)は state/terrainState.test.ts が持つ。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { apply, type Command, type CommandRejectionCode } from "../../src/engine/commands";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  initialTerrain,
  nextReclaimCostFix,
  reclaimCell,
  reclaimCostFix,
} from "../../src/engine/rules/reclaim";
import { RulesError, type EngineContent, type ReclaimParams } from "../../src/engine/rules/types";
import { toSerializable } from "../../src/engine/state/serialize";
import {
  requireEntity,
  type FacilityFootprint,
  type GameState,
} from "../../src/engine/state/state";
import { setTerrain } from "../../src/engine/state/update";

import { HEARTH, WOOD, content as baseContent, facility, id, resource, stateOf } from "./fixtures";

// --- フィクスチャ -----------------------------------------------------------

/** GDD 9.1 の既定形: base 40 / 底 1.15 / cap 2000(content/balance.json と同値)。 */
const PARAMS: ReclaimParams = {
  baseCostFix: fixFromInt(40),
  costGrowthFix: fixFromRaw(1_150_000),
  costCapFix: fixFromInt(2000),
  costResourceId: WOOD,
  initialRubbleCells: [12, 13, 14],
};

const FP_2X2: FacilityFootprint = { width: 2, height: 2 };
const YARD_2X2 = { ...HEARTH, id: id("yard"), footprint: FP_2X2 };

const CONTENT: EngineContent = {
  ...baseContent({
    facilityDefs: new Map([
      [HEARTH.id, HEARTH],
      [YARD_2X2.id, YARD_2X2],
    ]),
  }),
  reclaim: PARAMS,
};

/** `reclaim` ブロックを持たない content(= 開墾システム不活性)。 */
const CONTENT_NO_RECLAIM: EngineContent = baseContent({
  facilityDefs: new Map([
    [HEARTH.id, HEARTH],
    [YARD_2X2.id, YARD_2X2],
  ]),
});

/** 薪 1000 を持ち、セル 12〜14 が瓦礫の盤面。 */
function board(rubbleCells: readonly number[] = [12, 13, 14], reclaimedCount = 0): GameState {
  const base = stateOf([resource("resourceWood", WOOD, 1000)]);
  if (rubbleCells.length === 0 && reclaimedCount === 0) return base;
  return setTerrain(base, { rubbleCells: [...rubbleCells], reclaimedCount });
}

const reclaimAt = (cellIndex: number): Command => ({ kind: "reclaimCell", cellIndex });

const place = (facilityId: string, defId: string, cellIndex: number): Command => ({
  kind: "placeFacility",
  facilityId: id(facilityId),
  defId: id(defId),
  cellIndex,
});

function accepted(
  state: GameState,
  command: Command | readonly Command[],
  content: EngineContent = CONTENT,
): GameState {
  const result = apply(state, content, command);
  if (!result.ok) throw new Error(`想定外の reject: ${result.rejection.code}`);
  return result.state;
}

function rejectionOf(
  state: GameState,
  command: Command | readonly Command[],
  content: EngineContent = CONTENT,
): CommandRejectionCode {
  const result = apply(state, content, command);
  if (result.ok) throw new Error("reject されるはずが accept された");
  return result.rejection.code;
}

function woodRaw(state: GameState): number {
  return toRaw(requireEntity(state, id("resourceWood"), "resource").stock);
}

// --- 1. コスト式(GDD 9.1 `base × 1.15^解放数` + cap)------------------------

describe("reclaimCostFix(GDD 9.1)", () => {
  it("解放数 0 は base そのもの", () => {
    expect(toRaw(reclaimCostFix(PARAMS, 0))).toBe(40_000_000);
  });

  it("解放数が増えるごとに 1.15 倍(各段 floor)される", () => {
    // 40 → 46 → 52.9 → 60.835 → 69.96025 → 80.454287(1e6 固定小数点の floor 累積)
    const expected = [40_000_000, 46_000_000, 52_900_000, 60_835_000, 69_960_250, 80_454_287];
    expect(expected.map((_, n) => toRaw(reclaimCostFix(PARAMS, n)))).toEqual(expected);
  });

  it("1 段ごとの比が必ず 1.15 倍(cap 到達前は単調増加)", () => {
    for (let n = 1; n < 20; n++) {
      const previous = toRaw(reclaimCostFix(PARAMS, n - 1));
      const current = toRaw(reclaimCostFix(PARAMS, n));
      expect(current).toBe(Math.floor((previous * 1_150_000) / 1_000_000));
      expect(current).toBeGreaterThan(previous);
    }
  });

  it("cap に達したら以降は cap で頭打ち(GDD 9.1「最終セルでも到達可能な明示上限」)", () => {
    const capped: ReclaimParams = { ...PARAMS, costCapFix: fixFromInt(60) };
    expect(toRaw(reclaimCostFix(capped, 2))).toBe(52_900_000);
    // 3 段目の素の値 60.835 は cap 60 を超えるので張り付く。
    expect(toRaw(reclaimCostFix(capped, 3))).toBe(60_000_000);
    expect(toRaw(reclaimCostFix(capped, 47))).toBe(60_000_000);
  });

  it("解放数 47(6×8 の全セル)でも FixRangeError にならない", () => {
    expect(toRaw(reclaimCostFix(PARAMS, 47))).toBe(2_000_000_000);
  });

  it("底が 1.0 未満の content は RulesError(cap 打ち切りの単調性の前提が破れる)", () => {
    const shrinking: ReclaimParams = { ...PARAMS, costGrowthFix: fixFromRaw(900_000) };
    expect(() => reclaimCostFix(shrinking, 3)).toThrow(RulesError);
  });

  it("解放数が負 / 非整数なら RulesError", () => {
    expect(() => reclaimCostFix(PARAMS, -1)).toThrow(RulesError);
    expect(() => reclaimCostFix(PARAMS, 1.5)).toThrow(RulesError);
  });

  it("nextReclaimCostFix は state の解放数を読む", () => {
    expect(toRaw(nextReclaimCostFix(board([12], 2), CONTENT))).toBe(52_900_000);
    expect(() => nextReclaimCostFix(board(), CONTENT_NO_RECLAIM)).toThrow(RulesError);
  });
});

// --- 2. 初期盤面の生成(content → state。既存 state には触れない)------------

describe("initialTerrain(GDD 6.1「初期利用可は一部」)", () => {
  it("content の初期瓦礫がそのまま写る", () => {
    expect(initialTerrain(CONTENT)).toEqual({ rubbleCells: [12, 13, 14], reclaimedCount: 0 });
  });

  it("reclaim ブロックが無い content は瓦礫ゼロ(= M52 以前の盤面)", () => {
    expect(initialTerrain(CONTENT_NO_RECLAIM)).toEqual({ rubbleCells: [], reclaimedCount: 0 });
  });

  it("初期瓦礫が空でも瓦礫ゼロ(正準形の空 terrain)", () => {
    const empty: EngineContent = { ...CONTENT, reclaim: { ...PARAMS, initialRubbleCells: [] } };
    expect(initialTerrain(empty)).toEqual({ rubbleCells: [], reclaimedCount: 0 });
  });

  it("昇順・重複なしでない初期配置は RulesError", () => {
    const unsorted: EngineContent = {
      ...CONTENT,
      reclaim: { ...PARAMS, initialRubbleCells: [14, 12] },
    };
    expect(() => initialTerrain(unsorted)).toThrow(RulesError);
    const duplicated: EngineContent = {
      ...CONTENT,
      reclaim: { ...PARAMS, initialRubbleCells: [12, 12] },
    };
    expect(() => initialTerrain(duplicated)).toThrow(RulesError);
  });

  it("盤外のセル番号を含む初期配置は RulesError", () => {
    const outside: EngineContent = {
      ...CONTENT,
      reclaim: { ...PARAMS, initialRubbleCells: [48] },
    };
    expect(() => initialTerrain(outside)).toThrow(RulesError);
  });
});

// --- 3. reclaimCell コマンド ------------------------------------------------

describe("reclaimCell(開墾)", () => {
  it("瓦礫が 1 枚剥がれ、解放数が増え、コストが引かれる", () => {
    const before = board();
    const next = accepted(before, reclaimAt(13));
    expect(next.terrain.rubbleCells).toEqual([12, 14]);
    expect(next.terrain.reclaimedCount).toBe(1);
    expect(woodRaw(before) - woodRaw(next)).toBe(40_000_000);
  });

  it("2 枚目のコストが 1.15 倍になる(検収条件)", () => {
    const first = accepted(board(), reclaimAt(12));
    const second = accepted(first, reclaimAt(13));
    expect(woodRaw(first) - woodRaw(second)).toBe(46_000_000);
    const third = accepted(second, reclaimAt(14));
    expect(woodRaw(second) - woodRaw(third)).toBe(52_900_000);
    expect(third.terrain).toEqual({ rubbleCells: [], reclaimedCount: 3 });
  });

  it("瓦礫でないセルは cellNotRubble(既に開墾済み)", () => {
    expect(rejectionOf(board(), reclaimAt(0))).toBe("cellNotRubble");
    // 瓦礫を 1 枚も持たない盤面では全セルが対象外。
    expect(rejectionOf(board([]), reclaimAt(13))).toBe("cellNotRubble");
  });

  it("盤外は cellOutOfRange", () => {
    expect(rejectionOf(board(), reclaimAt(48))).toBe("cellOutOfRange");
    expect(rejectionOf(board(), reclaimAt(-1))).toBe("cellOutOfRange");
    expect(rejectionOf(board(), reclaimAt(1.5))).toBe("cellOutOfRange");
  });

  it("reclaim ブロックの無い content では contentUnsupported", () => {
    expect(rejectionOf(board(), reclaimAt(13), CONTENT_NO_RECLAIM)).toBe("contentUnsupported");
  });

  it("在庫不足は insufficientResource で、state は 1 bit も動かない", () => {
    const poor = setTerrain(stateOf([resource("resourceWood", WOOD, 10)]), {
      rubbleCells: [13],
      reclaimedCount: 0,
    });
    const snapshot = JSON.stringify(toSerializable(poor));
    const result = apply(poor, CONTENT, reclaimAt(13));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("insufficientResource");
    expect(result.rejection.resourceId).toBe(WOOD);
    expect(result.rejection.requiredRaw).toBe(40_000_000);
    expect(result.rejection.availableRaw).toBe(10_000_000);
    expect(JSON.stringify(toSerializable(poor))).toBe(snapshot);
  });

  it("rules 層を直接叩いて瓦礫でないセルを渡すと RulesError(事前検査はコマンド層の責務)", () => {
    expect(() => reclaimCell(board(), CONTENT, 0)).toThrow(RulesError);
    expect(() => reclaimCell(board(), CONTENT_NO_RECLAIM, 13)).toThrow(RulesError);
  });

  it("コストの受け皿になる resource entity が無ければ insufficientResource", () => {
    const noStock = setTerrain(stateOf([]), { rubbleCells: [13], reclaimedCount: 0 });
    const result = apply(noStock, CONTENT, reclaimAt(13));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("insufficientResource");
    expect(result.rejection.availableRaw).toBe(0);
  });

  it("同じ列を 2 回適用すると同じバイト列になる(純関数)", () => {
    const a = accepted(board(), [reclaimAt(12), reclaimAt(13)]);
    const b = accepted(board(), [reclaimAt(12), reclaimAt(13)]);
    expect(JSON.stringify(toSerializable(a))).toBe(JSON.stringify(toSerializable(b)));
  });

  it("列の途中で落ちれば全部捨てる(原子適用)", () => {
    const before = board();
    const result = apply(before, CONTENT, [reclaimAt(12), reclaimAt(0)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.commandIndex).toBe(1);
    expect(result.rejection.code).toBe("cellNotRubble");
  });
});

// --- 4. 瓦礫セルへの配置 / 増築(検収条件)-----------------------------------

describe("瓦礫セルは施設を受け付けない(GDD 9.1)", () => {
  it("瓦礫セルへの配置は cellIsRubble", () => {
    const result = apply(board(), CONTENT, place("fNew", "hearth", 13));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("cellIsRubble");
    expect(result.rejection.cellIndex).toBe(13);
  });

  it("大型施設は**占有セルのどれか**が瓦礫なら拒否し、最小の瓦礫セルを載せる", () => {
    // 2×2 をセル 6(x=0,y=1)へ置くと占有は 6,7,12,13。うち 12 と 13 が瓦礫。
    const result = apply(board(), CONTENT, place("fYard", "yard", 6));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("cellIsRubble");
    expect(result.rejection.cellIndex).toBe(12);
  });

  it("開墾してから置けば通る(列コマンドで 1 手にできる)", () => {
    const next = accepted(board(), [reclaimAt(13), place("fNew", "hearth", 13)]);
    expect(requireEntity(next, id("fNew"), "facility").cellIndex).toBe(13);
    expect(next.terrain.rubbleCells).toEqual([12, 14]);
  });

  it("瓦礫の上に建っている施設の増築は cellIsRubble(手編集セーブの検出器)", () => {
    // 通常経路では作れない盤面(placeFacility が拒否する)を直接組む。
    const broken = setTerrain(
      stateOf([resource("resourceWood", WOOD, 1000), facility("fOld", HEARTH.id, 13)]),
      { rubbleCells: [13], reclaimedCount: 0 },
    );
    const result = apply(broken, CONTENT, { kind: "upgradeFacility", facilityId: id("fOld") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("cellIsRubble");
    expect(result.rejection.cellIndex).toBe(13);
  });

  it("瓦礫を持たない盤面では配置も増築も M52 以前と同じく通る", () => {
    const clean = stateOf([facility("fOld", HEARTH.id, 13)]);
    expect(apply(clean, CONTENT, place("fNew", "hearth", 20)).ok).toBe(true);
    expect(apply(clean, CONTENT, { kind: "upgradeFacility", facilityId: id("fOld") }).ok).toBe(
      true,
    );
  });
});
