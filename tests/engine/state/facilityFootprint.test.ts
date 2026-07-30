// ---------------------------------------------------------------------------
// M16: 施設 footprint の state / 直列化(serialize.ts §7・update.ts)のテスト。
//
// 固定するのは 4 点:
//   (1) **1×1 は直列化形に現れない**(省略 ⇔ 1×1 の正準形)= 既存セーブと
//       golden vector のバイト列が 1 bit も動かないことの根拠
//   (2) 大型施設の footprint が往復でバイト同一に保たれること
//   (3) 非正準形(1×1 の明示)・値域外(3×3 等)を**黙って受け入れない**こと
//   (4) `cellIndex` と footprint の**関係**(盤面へ収まるか)を createGameState が
//       強制すること。ただし footprint を持たない施設の cellIndex は
//       M16 以前と同じく無検査(層分けの維持)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  fromSerializable,
  toSerializable,
  SerializeError,
} from "../../../src/engine/state/serialize";
import type { FacilityFootprint, GameStateMeta } from "../../../src/engine/state/state";
import { StateUpdateError, putEntity } from "../../../src/engine/state/update";

import { HEARTH, META, facility, id, resident, stateOf } from "../fixtures";

const FP_1X1: FacilityFootprint = { width: 1, height: 1 };
const FP_2X1: FacilityFootprint = { width: 2, height: 1 };
const FP_2X2: FacilityFootprint = { width: 2, height: 2 };

/** 直列化形を JSON 往復してプレーン値にする(セーブに入っていた生の値の再現)。 */
function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** 施設 1 基だけの直列化形を組み立てる(footprint を手で差し込むため)。 */
function facilityDoc(cellIndex: number, footprint?: FacilityFootprint): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    kind: "facility",
    id: "fHearth",
    defId: "hearth",
    level: 1,
    cellIndex,
    workerIds: [],
  };
  if (footprint !== undefined) doc["footprint"] = footprint;
  return doc;
}

function saveDoc(entity: Record<string, unknown>, meta: GameStateMeta = META): unknown {
  return {
    saveSchemaVersion: meta.saveSchemaVersion,
    contentVersion: meta.contentVersion,
    algoVersion: meta.algoVersion,
    worldSeed: meta.worldSeed,
    tick: meta.tick,
    entityStateById: { fHearth: entity },
  };
}

// --- 1. 1×1 は直列化形に現れない -------------------------------------------

describe("直列化: 1×1 は省略が正準形(§7)", () => {
  it("footprint 省略の施設は footprint キーを持たない", () => {
    const state = stateOf([facility("fHearth", HEARTH.id, 3)]);
    const serialized = plain(toSerializable(state));
    const entities = serialized["entityStateById"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(entities["fHearth"] ?? {})).toEqual([
      "cellIndex",
      "defId",
      "id",
      "kind",
      "level",
      "workerIds",
    ]);
    expect(JSON.stringify(serialized)).not.toContain("footprint");
  });

  it("明示された 1×1 も書き出されない(= 省略形へ畳まれる)", () => {
    const explicit = stateOf([facility("fHearth", HEARTH.id, 3, [], 1, FP_1X1)]);
    const omitted = stateOf([facility("fHearth", HEARTH.id, 3)]);
    expect(JSON.stringify(toSerializable(explicit))).toBe(JSON.stringify(toSerializable(omitted)));
  });

  it("値域外の footprint は書き出さずに停止する(読めない形を書かない)", () => {
    // createGameState を迂回して壊れた entity を state へ入れる(engine のバグの再現)。
    const broken = putEntity(
      stateOf([]),
      facility("fBroken", HEARTH.id, 0, [], 1, { width: 3, height: 3 }),
    );
    expect(() => toSerializable(broken)).toThrow(SerializeError);
  });
});

// --- 2. 大型施設の往復 ------------------------------------------------------

describe("直列化: 大型施設", () => {
  it("footprint が書き出され、往復でバイト同一", () => {
    const state = stateOf([
      resident("aRui"),
      facility("fForge", HEARTH.id, 0, [], 1, FP_2X1),
      facility("fSmelter", HEARTH.id, 14, [], 2, FP_2X2),
    ]);
    const first = JSON.stringify(toSerializable(state));
    expect(first).toContain('"footprint":{"height":1,"width":2}');
    expect(first).toContain('"footprint":{"height":2,"width":2}');

    const restored = fromSerializable(plain(toSerializable(state)));
    expect(JSON.stringify(toSerializable(restored))).toBe(first);
  });

  it("復元された state が footprint を保つ", () => {
    const state = stateOf([facility("fForge", HEARTH.id, 40, [], 1, FP_2X2)]);
    const restored = fromSerializable(plain(toSerializable(state)));
    const entity = restored.entityStateById.get(id("fForge"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.footprint).toEqual(FP_2X2);
    expect(entity.cellIndex).toBe(40);
  });
});

// --- 3. 非正準形・値域外の reject ------------------------------------------

describe("復元: 黙って受け入れない形", () => {
  it("1×1 の明示は非正準形として reject(往復バイト同一性の維持)", () => {
    expect(() => fromSerializable(saveDoc(facilityDoc(3, FP_1X1)))).toThrow(SerializeError);
  });

  it("値域外(3×3 / 0 / 小数)は reject", () => {
    for (const footprint of [
      { width: 3, height: 1 },
      { width: 1, height: 3 },
      { width: 0, height: 2 },
      { width: 2, height: 0 },
      { width: 1.5, height: 2 },
    ]) {
      expect(() => fromSerializable(saveDoc(facilityDoc(0, footprint)))).toThrow(SerializeError);
    }
  });

  it("footprint がオブジェクトでない / キーが欠けていれば reject", () => {
    expect(() =>
      fromSerializable(saveDoc(facilityDoc(0, 2 as unknown as FacilityFootprint))),
    ).toThrow(SerializeError);
    expect(() =>
      fromSerializable(saveDoc(facilityDoc(0, { width: 2 } as unknown as FacilityFootprint))),
    ).toThrow(SerializeError);
  });

  it("footprint を持たない旧セーブはそのまま読める(マイグレーション不要の既定値)", () => {
    const restored = fromSerializable(saveDoc(facilityDoc(3)));
    const entity = restored.entityStateById.get(id("fHearth"));
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.footprint).toBeUndefined();
  });
});

// --- 4. createGameState の不変条件 ------------------------------------------

describe("createGameState: footprint と cellIndex の関係", () => {
  it("盤面へ収まる大型施設は通る", () => {
    expect(() => stateOf([facility("fA", HEARTH.id, 40, [], 1, FP_2X2)])).not.toThrow();
    expect(() => stateOf([facility("fA", HEARTH.id, 46, [], 1, FP_2X1)])).not.toThrow();
  });

  it("右端の 2×1 ・下端の 2×2 は盤外はみ出しで停止する", () => {
    expect(() => stateOf([facility("fA", HEARTH.id, 5, [], 1, FP_2X1)])).toThrow(StateUpdateError);
    expect(() => stateOf([facility("fA", HEARTH.id, 47, [], 1, FP_2X2)])).toThrow(StateUpdateError);
  });

  it("値域外の footprint は停止する", () => {
    expect(() => stateOf([facility("fA", HEARTH.id, 0, [], 1, { width: 3, height: 1 })])).toThrow(
      StateUpdateError,
    );
  });

  it("footprint を持たない施設の cellIndex は M16 以前と同じく無検査", () => {
    // cellIndex 単独の値域は schema 検証器の担当(serialize.ts §2)。ここを変えると
    // 「既存の全施設 1×1 セーブの読み込み挙動が 1 bit も変わらない」が崩れる。
    expect(() => stateOf([facility("fA", HEARTH.id, 999)])).not.toThrow();
  });

  it("壊れた大型施設のセーブは復元時点で停止する(実行時のどこかで落ちない)", () => {
    expect(() => fromSerializable(saveDoc(facilityDoc(5, FP_2X1)))).toThrow(StateUpdateError);
  });
});
