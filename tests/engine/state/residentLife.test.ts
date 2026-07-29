// ---------------------------------------------------------------------------
// [M11] 住民の `life`(生涯)の直列化 — serialize.ts §5
//
// 中心は「**省略された住民の直列化形が M11 以前と 1 bit も違わない**」こと。
// これが既存セーブと golden vector 37 本(M10 で 40 本)が動かない根拠である。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt } from "../../../src/engine/fp";
import {
  fromSerializable,
  toSerializable,
  SerializeError,
} from "../../../src/engine/state/serialize";
import {
  isAliveResident,
  livingResidents,
  type ResidentState,
} from "../../../src/engine/state/state";
import { id, resident, stateOf } from "../fixtures";
import { agedResident } from "../lifespanFixtures";

const STATS = {
  vigor: fixFromInt(60),
  dexterity: fixFromInt(40),
  intellect: fixFromInt(50),
  fortitude: fixFromInt(55),
  will: fixFromInt(45),
};

function serializedResident(entity: ResidentState): Record<string, unknown> {
  const json = toSerializable(stateOf([entity]));
  return json.entityStateById[entity.id] as unknown as Record<string, unknown>;
}

describe("[M11] resident.life の直列化", () => {
  it("life を持たない住民は `life` キーごと省略される(既存セーブとバイト同一)", () => {
    const json = serializedResident(resident("residentA"));
    expect(Object.keys(json).sort()).toEqual([
      "assignedFacilityId",
      "dispatched",
      "id",
      "kind",
      "mastery",
      "morale",
      "recallImpairedUntilTick",
      "traitIds",
    ]);
    expect("life" in json).toBe(false);
  });

  it("life を持つ住民は 3 値まとめて出る(diedTick は生存中も明示 null)", () => {
    const json = serializedResident(agedResident("residentA", -100, 500));
    expect(json["life"]).toEqual({ bornTick: -100, lifespanTick: 500, diedTick: null });
  });

  it("stats と life の 4 通りの組合せすべてで往復がバイト同一", () => {
    const plain = resident("residentA");
    const withStats: ResidentState = { ...plain, stats: STATS };
    const withLife = agedResident("residentB", -100, 500);
    const withBoth: ResidentState = { ...withLife, stats: STATS };

    for (const entity of [plain, withStats, withLife, withBoth]) {
      const json = toSerializable(stateOf([entity]));
      const roundTrip = toSerializable(fromSerializable(json));
      expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(json));
    }
  });

  it("死亡した住民(tombstone)も往復する", () => {
    const dead: ResidentState = {
      ...agedResident("residentA", -600, 500),
      life: { bornTick: -600, lifespanTick: 500, diedTick: 42 },
    };
    const json = toSerializable(stateOf([dead]));
    const restored = fromSerializable(json);
    expect(isAliveResident(restored.entityStateById.get(id("residentA")) as ResidentState)).toBe(
      false,
    );
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(json));
  });

  it("bornTick は負値を許す(ゲーム開始前に生まれた住民)", () => {
    const restored = fromSerializable(
      toSerializable(stateOf([agedResident("residentA", -900, 1000)])),
    );
    const entity = restored.entityStateById.get(id("residentA")) as ResidentState;
    expect(entity.life?.bornTick).toBe(-900);
  });

  it("lifespanTick が 0 以下の直列化形は reject する", () => {
    const json = toSerializable(stateOf([agedResident("residentA", 0, 500)]));
    const broken = JSON.parse(JSON.stringify(json)) as {
      entityStateById: { residentA: { life: { lifespanTick: number } } };
    };
    broken.entityStateById.residentA.life.lifespanTick = 0;
    expect(() => fromSerializable(broken)).toThrow(SerializeError);
  });

  it("diedTick が負の直列化形は reject する", () => {
    const json = toSerializable(stateOf([agedResident("residentA", 0, 500)]));
    const broken = JSON.parse(JSON.stringify(json)) as {
      entityStateById: { residentA: { life: { diedTick: number } } };
    };
    broken.entityStateById.residentA.life.diedTick = -1;
    expect(() => fromSerializable(broken)).toThrow(SerializeError);
  });
});

describe("[M11] livingResidents / isAliveResident", () => {
  it("life を持たない住民は生存扱い(M11 以前の住民をそのまま数える)", () => {
    expect(isAliveResident(resident("residentA"))).toBe(true);
  });

  it("tombstone された住民だけが除かれ、順序は ID 昇順のまま", () => {
    const dead: ResidentState = {
      ...agedResident("residentB", -600, 500),
      life: { bornTick: -600, lifespanTick: 500, diedTick: 42 },
    };
    const state = stateOf([resident("residentA"), dead, agedResident("residentC", 0, 500)]);
    expect(livingResidents(state).map((r) => r.id)).toEqual([id("residentA"), id("residentC")]);
  });
});
