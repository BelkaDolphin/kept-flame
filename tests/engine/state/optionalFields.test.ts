import { describe, expect, it } from "vitest";

import { fixFromInt, fixFromRaw, toRaw } from "../../../src/engine/fp";
import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import {
  entityIdFromString,
  requireEntity,
  type EntityState,
  type GameState,
  type GameStateMeta,
} from "../../../src/engine/state/state";
import { createGameState } from "../../../src/engine/state/update";

// ---------------------------------------------------------------------------
// M5 が entity へ足した省略可フィールド(serialize.ts §4)の往復テスト。
//
// 一番大事なのは **未設定なら直列化形にキーが現れない**こと —— これが
// 「既存セーブと既存 golden vector 37 本のバイト列が 1 bit も動かない」根拠。
// ---------------------------------------------------------------------------

const idOf = entityIdFromString;

const META: GameStateMeta = {
  saveSchemaVersion: 1,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 0,
};

function stateOf(entities: readonly EntityState[]): GameState {
  return createGameState(META, entities);
}

function plainResident(): EntityState {
  return {
    kind: "resident",
    id: idOf("aRui"),
    morale: fixFromInt(50),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
  };
}

function statfulResident(): EntityState {
  return {
    kind: "resident",
    id: idOf("bMina"),
    morale: fixFromInt(50),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
    stats: {
      vigor: fixFromInt(73),
      dexterity: fixFromInt(41),
      intellect: fixFromInt(58),
      fortitude: fixFromInt(12),
      will: fixFromRaw(99_500_000),
    },
  };
}

function plainResource(): EntityState {
  return { kind: "resource", id: idOf("wStock"), resourceId: idOf("wood"), stock: fixFromInt(3) };
}

function accountedResource(): EntityState {
  return {
    kind: "resource",
    id: idOf("xStock"),
    resourceId: idOf("stone"),
    stock: fixFromInt(50),
    cumulativeProduced: fixFromInt(200),
    cumulativeOverflow: fixFromInt(150),
  };
}

describe("未設定なら直列化形にキーが現れない(§4)", () => {
  it("ステータス未設定の resident のキー一覧は M5 以前と同一", () => {
    const json = toSerializable(stateOf([plainResident()]));
    expect(Object.keys(json.entityStateById["aRui"] ?? {})).toEqual([
      "assignedFacilityId",
      "dispatched",
      "id",
      "kind",
      "mastery",
      "morale",
      "recallImpairedUntilTick",
      "traitIds",
    ]);
  });

  it("会計していない resource のキー一覧は M5 以前と同一", () => {
    const json = toSerializable(stateOf([plainResource()]));
    expect(Object.keys(json.entityStateById["wStock"] ?? {})).toEqual([
      "id",
      "kind",
      "resourceId",
      "stock",
    ]);
  });
});

describe("設定されていれば往復する", () => {
  it("resident.stats がバイト同一で往復する", () => {
    const state = stateOf([plainResident(), statfulResident()]);
    const first = JSON.stringify(toSerializable(state));
    const restored = fromSerializable(JSON.parse(first));
    expect(JSON.stringify(toSerializable(restored))).toBe(first);

    const mina = requireEntity(restored, idOf("bMina"), "resident");
    expect(toRaw(mina.stats?.vigor ?? (0 as never))).toBe(73_000_000);
    expect(toRaw(mina.stats?.will ?? (0 as never))).toBe(99_500_000);
    expect(requireEntity(restored, idOf("aRui"), "resident").stats).toBeUndefined();
  });

  it("resource のオーバーフロー会計がバイト同一で往復する", () => {
    const state = stateOf([plainResource(), accountedResource()]);
    const first = JSON.stringify(toSerializable(state));
    const restored = fromSerializable(JSON.parse(first));
    expect(JSON.stringify(toSerializable(restored))).toBe(first);

    const stone = requireEntity(restored, idOf("xStock"), "resource");
    expect(toRaw(stone.cumulativeProduced ?? (0 as never))).toBe(200_000_000);
    expect(toRaw(stone.cumulativeOverflow ?? (0 as never))).toBe(150_000_000);
    expect(requireEntity(restored, idOf("wStock"), "resource").cumulativeProduced).toBeUndefined();
  });

  it("stats のキーも昇順に正準化される", () => {
    const json = toSerializable(stateOf([statfulResident()]));
    const entity = json.entityStateById["bMina"];
    if (entity?.kind !== "resident") throw new Error("kind が resident でない");
    expect(Object.keys(entity.stats ?? {})).toEqual([
      "dexterity",
      "fortitude",
      "intellect",
      "vigor",
      "will",
    ]);
  });
});

describe("壊れた直列化形は停止させる", () => {
  it("stats のキーが欠けていれば reject", () => {
    const json = JSON.parse(JSON.stringify(toSerializable(stateOf([statfulResident()])))) as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    const stats = json["entityStateById"]?.["bMina"]?.["stats"];
    if (stats === undefined) throw new Error("stats が無い");
    delete stats["will"];
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("会計フィールドが片方だけの直列化形は reject", () => {
    const json = JSON.parse(JSON.stringify(toSerializable(stateOf([accountedResource()])))) as {
      entityStateById: Record<string, Record<string, unknown>>;
    };
    const entity = json.entityStateById["xStock"];
    if (entity === undefined) throw new Error("entity が無い");
    delete entity["cumulativeOverflow"];
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });
});
