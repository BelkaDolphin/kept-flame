// ---------------------------------------------------------------------------
// [M12] memoirLog(resident.memoir)/ 絆(GameState.bondByPairKey)の直列化 —
// serialize.ts §6
//
// 中心は rngState.test.ts / residentLife.test.ts と同じ観点:
//   (1) 空(未設定)ならキーが現れない(既存セーブ・golden vector が動かない根拠)
//   (2) 設定されていればバイト同一で往復する
//   (3) 壊れた直列化形(未知種別・不正な pairKey 形式)は reject する
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt, toRaw } from "../../../src/engine/fp";
import { bondPairKeyOf } from "../../../src/engine/rules/bond";
import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import {
  bondPairKeys,
  getBondValue,
  requireEntity,
  type MemoirEntry,
  type ResidentState,
} from "../../../src/engine/state/state";
import { setBondValue } from "../../../src/engine/state/update";
import { agedResident } from "../lifespanFixtures";
import { id, resident, stateOf } from "../fixtures";

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

function roundTripJson(state: ReturnType<typeof stateOf>): string {
  return JSON.stringify(
    toSerializable(fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))))),
  );
}

// --- resident.memoir ---------------------------------------------------------

describe("[M12] resident.memoir の直列化", () => {
  it("memoir を持たない住民は memoir キーが省略される(既存セーブとバイト同一)", () => {
    const json = serializedResident(resident("residentAlice"));
    expect("memoir" in json).toBe(false);
  });

  it("memoir を持つ住民はそのまま出る", () => {
    const withMemoir: ResidentState = {
      ...resident("residentAlice"),
      memoir: {
        entries: [
          { kind: "arrival", tick: 0 },
          { kind: "bioOrigin", tick: 0, variantIndex: 3 },
        ],
        foldedCount: 2,
      },
    };
    const json = serializedResident(withMemoir);
    expect(json["memoir"]).toEqual({
      entries: [
        { kind: "arrival", tick: 0 },
        { kind: "bioOrigin", tick: 0, variantIndex: 3 },
      ],
      foldedCount: 2,
    });
  });

  it("stats / life / memoir の 8 通りすべてで往復がバイト同一", () => {
    const plain = resident("residentAlice");
    const withStats: ResidentState = { ...plain, stats: STATS };
    const withLife = agedResident("residentBeta", -100, 500);
    const withMemoir: ResidentState = {
      ...plain,
      memoir: { entries: [{ kind: "arrival", tick: 0 }], foldedCount: 0 },
    };
    const withStatsLife: ResidentState = { ...withLife, stats: STATS };
    const withStatsMemoir: ResidentState = {
      ...withStats,
      memoir: { entries: [{ kind: "death", tick: 5 }], foldedCount: 1 },
    };
    const withLifeMemoir: ResidentState = {
      ...withLife,
      memoir: {
        entries: [{ kind: "bondMilestone", tick: 3, partnerId: id("residentZ"), tier: 2 }],
        foldedCount: 0,
      },
    };
    const withAll: ResidentState = {
      ...withStatsLife,
      memoir: {
        entries: [{ kind: "partnerLost", tick: 9, partnerId: id("residentZ") }],
        foldedCount: 4,
      },
    };

    for (const entity of [
      plain,
      withStats,
      withLife,
      withMemoir,
      withStatsLife,
      withStatsMemoir,
      withLifeMemoir,
      withAll,
    ]) {
      const json = toSerializable(stateOf([entity]));
      const roundTrip = toSerializable(fromSerializable(json));
      expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(json));
    }
  });

  it("全 memoir エントリ種別が往復する", () => {
    const allKinds: MemoirEntry[] = [
      { kind: "arrival", tick: 1 },
      { kind: "bioOrigin", tick: 2, variantIndex: 0 },
      { kind: "bioCatchphrase", tick: 3, variantIndex: 1 },
      { kind: "bioFear", tick: 4, variantIndex: 2 },
      { kind: "bondMilestone", tick: 5, partnerId: id("residentZ"), tier: 1 },
      { kind: "partnerLost", tick: 6, partnerId: id("residentZ") },
      { kind: "death", tick: 7 },
    ];
    const entity: ResidentState = {
      ...resident("residentAlice"),
      memoir: { entries: allKinds, foldedCount: 0 },
    };
    const state = stateOf([entity]);
    const restored = fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))));
    expect(requireEntity(restored, id("residentAlice"), "resident").memoir?.entries).toEqual(
      allKinds,
    );
  });

  it("未知の memoir エントリ種別は reject する", () => {
    const entity: ResidentState = {
      ...resident("residentAlice"),
      memoir: { entries: [{ kind: "arrival", tick: 0 }], foldedCount: 0 },
    };
    const json = JSON.parse(JSON.stringify(toSerializable(stateOf([entity])))) as {
      entityStateById: { residentAlice: { memoir: { entries: { kind: string }[] } } };
    };
    json.entityStateById.residentAlice.memoir.entries[0]!.kind = "unknownKind";
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });
});

// --- GameState.bondByPairKey -------------------------------------------------

describe("[M12] GameState.bondByPairKey の直列化(§6・rngState と同型)", () => {
  it("空なら直列化形にキーが現れない(既存セーブとバイト同一)", () => {
    const json = toSerializable(stateOf([resident("residentAlice")]));
    expect("bondByPairKey" in json).toBe(false);
  });

  it("非空ならキーが現れ、pairKey → raw 値のオブジェクトになる", () => {
    const state = setBondValue(
      stateOf([resident("residentAlice"), resident("residentBeta")]),
      bondPairKeyOf(id("residentAlice"), id("residentBeta")),
      fixFromInt(12),
    );
    const json = toSerializable(state);
    expect(json.bondByPairKey).toEqual({ "residentAlice|residentBeta": 12_000_000 });
  });

  it("state → JSON → state → JSON がバイト同一", () => {
    let state = stateOf([
      resident("residentAlice"),
      resident("residentBeta"),
      resident("residentGamma"),
    ]);
    state = setBondValue(
      state,
      bondPairKeyOf(id("residentAlice"), id("residentBeta")),
      fixFromInt(5),
    );
    state = setBondValue(
      state,
      bondPairKeyOf(id("residentBeta"), id("residentGamma")),
      fixFromInt(7),
    );
    expect(roundTripJson(state)).toBe(JSON.stringify(toSerializable(state)));
  });

  it("復元後も bondPairKeys / getBondValue が一致する", () => {
    const state = setBondValue(
      stateOf([resident("residentAlice"), resident("residentBeta")]),
      bondPairKeyOf(id("residentAlice"), id("residentBeta")),
      fixFromInt(3),
    );
    const restored = fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))));
    expect(bondPairKeys(restored)).toEqual(["residentAlice|residentBeta"]);
    expect(toRaw(getBondValue(restored, "residentAlice|residentBeta") ?? (0 as never))).toBe(
      3_000_000,
    );
  });

  it("'a|b' 形式でない pairKey は reject する", () => {
    const broken = {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 0,
      entityStateById: {},
      bondByPairKey: { residentAloneOnly: 1_000_000 },
    };
    expect(() => fromSerializable(broken)).toThrow(SerializeError);
  });

  it("辞書順が逆(b|a)の pairKey は reject する", () => {
    const broken = {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 0,
      entityStateById: {},
      bondByPairKey: { "residentBeta|residentAlice": 1_000_000 },
    };
    expect(() => fromSerializable(broken)).toThrow(SerializeError);
  });

  it("bondByPairKey キーが無い旧セーブをそのままロードできる(additive)", () => {
    const legacy = {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 0,
      entityStateById: {},
    };
    const state = fromSerializable(legacy);
    expect(state.bondByPairKey.size).toBe(0);
  });
});
