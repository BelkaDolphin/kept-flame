import { describe, expect, it } from "vitest";

import { fixFromInt, fixFromRaw } from "../../../src/engine/fp";
import {
  entityIdFromString,
  entityIds,
  requireEntity,
  type EntityId,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "../../../src/engine/state/state";
import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import { StateUpdateError, createGameState } from "../../../src/engine/state/update";

// ---------------------------------------------------------------------------
// Map ↔ JSON 往復の単一正準実装(ADR-028(2))のテスト。
//
// 中心にあるのは往復のバイト同一性:
//   state → toSerializable → JSON → fromSerializable → toSerializable
// の 2 つの直列化形が、キー順まで含めて同一バイト列になること。これが崩れると
// 「同じセーブなのに別の hash」= golden vector / integrityChecksum が信用できなく
// なるため、toEqual(順序を見ない)ではなく JSON.stringify の一致で検証する。
// ---------------------------------------------------------------------------

const META: GameStateMeta = {
  saveSchemaVersion: 3,
  contentVersion: 12,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 4321,
};

const idOf = (value: string): EntityId => entityIdFromString(value);

function resident(id: string): ResidentState {
  return {
    kind: "resident",
    id: idOf(id),
    morale: fixFromInt(42),
    mastery: fixFromRaw(150_000),
    assignedFacilityId: idOf("dHall"),
    dispatched: true,
    traitIds: [idOf("traitCalm"), idOf("traitKeen")],
    recallImpairedUntilTick: 5000,
  };
}

function facility(id: string): FacilityState {
  return {
    kind: "facility",
    id: idOf(id),
    defId: idOf("smeltery"),
    level: 3,
    cellIndex: 17,
    workerIds: [idOf("aRui"), idOf("bMina")],
  };
}

function research(id: string): ResearchState {
  return {
    kind: "research",
    id: idOf(id),
    techId: idOf("techBronze"),
    progress: fixFromInt(120),
    completedTick: null,
  };
}

function resourceStock(id: string): ResourceState {
  return {
    kind: "resource",
    id: idOf(id),
    resourceId: idOf("wood"),
    stock: fixFromRaw(-2_500_000),
  };
}

/** 4 種別すべてを含むサンプル state。 */
function sampleState(): GameState {
  const entities: readonly EntityState[] = [
    facility("dHall"),
    resident("aRui"),
    resourceStock("wStock"),
    resident("bMina"),
    research("rBronze"),
  ];
  return createGameState(META, entities);
}

/** 直列化形の可変コピー(異常系の入力を組み立てるため)。 */
function mutableJson(state: GameState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toSerializable(state))) as Record<string, unknown>;
}

function entityJson(json: Record<string, unknown>, id: string): Record<string, unknown> {
  const map = json["entityStateById"] as Record<string, unknown>;
  return map[id] as Record<string, unknown>;
}

describe("往復不変性", () => {
  it("state → JSON → state → JSON がバイト同一", () => {
    const state = sampleState();
    const first = JSON.stringify(toSerializable(state));
    const restored = fromSerializable(JSON.parse(first));
    const second = JSON.stringify(toSerializable(restored));
    expect(second).toBe(first);
  });

  it("復元した state は元の state と等価(値・型とも)", () => {
    const state = sampleState();
    const restored = fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))));
    expect(restored).toEqual(state);
  });

  it("復元した state の Map 反復順が元と一致する", () => {
    const state = sampleState();
    const restored = fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))));
    expect(entityIds(restored)).toEqual(entityIds(state));
    expect(entityIds(restored)).toEqual(["aRui", "bMina", "dHall", "rBronze", "wStock"]);
  });

  it("負値・0・null・空配列を含む状態でも往復する", () => {
    const edge = createGameState({ ...META, tick: 0 }, [
      {
        kind: "resident",
        id: idOf("aRui"),
        morale: fixFromInt(0),
        mastery: fixFromRaw(-1),
        assignedFacilityId: null,
        dispatched: false,
        traitIds: [],
        recallImpairedUntilTick: 0,
      },
      {
        kind: "research",
        id: idOf("rBronze"),
        techId: idOf("techBronze"),
        progress: fixFromInt(0),
        completedTick: 0,
      },
    ]);
    const first = JSON.stringify(toSerializable(edge));
    const second = JSON.stringify(toSerializable(fromSerializable(JSON.parse(first))));
    expect(second).toBe(first);
    expect(fromSerializable(JSON.parse(first))).toEqual(edge);
  });

  it("entity を追加した順序が違っても直列化形は同一", () => {
    const forward = createGameState(META, [resident("aRui"), facility("dHall")]);
    const reversed = createGameState(META, [facility("dHall"), resident("aRui")]);
    expect(JSON.stringify(toSerializable(reversed))).toBe(JSON.stringify(toSerializable(forward)));
  });
});

describe("直列化形の正準性", () => {
  it("トップレベルのキーが UTF-16 コードユニット昇順に並ぶ", () => {
    const json = toSerializable(sampleState());
    expect(Object.keys(json)).toEqual([
      "algoVersion",
      "contentVersion",
      "entityStateById",
      "saveSchemaVersion",
      "tick",
      "worldSeed",
    ]);
  });

  it("entity は ID 昇順で、各 entity のフィールドもキー昇順に並ぶ", () => {
    const json = toSerializable(sampleState());
    expect(Object.keys(json.entityStateById)).toEqual([
      "aRui",
      "bMina",
      "dHall",
      "rBronze",
      "wStock",
    ]);
    const first = json.entityStateById["aRui"];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).toEqual([
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

  it("Fix は raw 整数として載る(1e6 スケールのまま)", () => {
    const json = toSerializable(sampleState());
    const entity = json.entityStateById["aRui"];
    expect(entity?.kind).toBe("resident");
    if (entity?.kind !== "resident") throw new Error("kind が resident でない");
    expect(entity.morale).toBe(42_000_000);
    expect(entity.mastery).toBe(150_000);
  });

  it("Map は残さず JSON 化できる値だけを返す", () => {
    const json = toSerializable(sampleState());
    expect(json.entityStateById instanceof Map).toBe(false);
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it("配列は entity のものをコピーして返す(state と参照を共有しない)", () => {
    const state = sampleState();
    const json = toSerializable(state);
    const entity = json.entityStateById["dHall"];
    if (entity?.kind !== "facility") throw new Error("kind が facility でない");
    expect(entity.workerIds).toEqual(["aRui", "bMina"]);
    expect(entity.workerIds).not.toBe(requireEntity(state, idOf("dHall"), "facility").workerIds);
  });
});

describe("整数風キーが往復を壊さない根拠(ADR-028(2))", () => {
  it("JS オブジェクトは整数風キーを列挙順で繰り上げる", () => {
    // ID 規則(先頭英小文字)が無ければ、この繰り上げで挿入順=昇順が崩れる。
    const withNumericKeys = JSON.parse('{"b":1,"2":2,"a":3,"1":4}') as Record<string, unknown>;
    expect(Object.keys(withNumericKeys)).toEqual(["1", "2", "b", "a"]);
  });

  it("整数風の entity ID は ID 規則で reject される", () => {
    const json = mutableJson(sampleState());
    const map = json["entityStateById"] as Record<string, unknown>;
    const moved = entityJson(json, "aRui");
    moved["id"] = "0";
    map["0"] = moved;
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });
});

describe("fromSerializable: キー順非依存", () => {
  it("入力のキー順を変えても同じ state を復元する", () => {
    const state = sampleState();
    const json = mutableJson(state);
    // トップレベルのキー順を逆にした等価な入力を作る。
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(json).reverse()) {
      shuffled[key] = json[key];
    }
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(json));
    expect(JSON.stringify(toSerializable(fromSerializable(shuffled)))).toBe(
      JSON.stringify(toSerializable(state)),
    );
  });

  it("entity の未知フィールドは読み飛ばす(往復は保たれる)", () => {
    const state = sampleState();
    const json = mutableJson(state);
    entityJson(json, "aRui")["unknownField"] = { nested: 1 };
    expect(JSON.stringify(toSerializable(fromSerializable(json)))).toBe(
      JSON.stringify(toSerializable(state)),
    );
  });

  it("-0 は +0 に正規化される", () => {
    const json = mutableJson(sampleState());
    entityJson(json, "aRui")["morale"] = -0;
    const restored = fromSerializable(json);
    expect(Object.is(requireEntity(restored, idOf("aRui"), "resident").morale, 0)).toBe(true);
  });
});

describe("fromSerializable: 壊れた入力の拒否", () => {
  it("オブジェクトでない入力", () => {
    expect(() => fromSerializable(null)).toThrow(SerializeError);
    expect(() => fromSerializable(42)).toThrow(SerializeError);
    expect(() => fromSerializable([])).toThrow(SerializeError);
    expect(() => fromSerializable("{}")).toThrow(SerializeError);
  });

  it("メタ情報の欠落・型違い・負値", () => {
    for (const broken of [
      (j: Record<string, unknown>) => delete j["worldSeed"],
      (j: Record<string, unknown>) => (j["worldSeed"] = 1),
      (j: Record<string, unknown>) => (j["tick"] = -1),
      (j: Record<string, unknown>) => (j["tick"] = 1.5),
      (j: Record<string, unknown>) => (j["tick"] = Number.NaN),
      (j: Record<string, unknown>) => (j["algoVersion"] = "1"),
      (j: Record<string, unknown>) => delete j["entityStateById"],
      (j: Record<string, unknown>) => (j["entityStateById"] = []),
    ]) {
      const json = mutableJson(sampleState());
      broken(json);
      expect(() => fromSerializable(json)).toThrow(SerializeError);
    }
  });

  it("entity のフィールド型違い", () => {
    for (const broken of [
      (e: Record<string, unknown>) => (e["morale"] = "42"),
      (e: Record<string, unknown>) => (e["morale"] = 1.5),
      (e: Record<string, unknown>) => (e["dispatched"] = 1),
      (e: Record<string, unknown>) => (e["traitIds"] = "traitCalm"),
      (e: Record<string, unknown>) => (e["traitIds"] = ["Bad-Id"]),
      (e: Record<string, unknown>) => (e["assignedFacilityId"] = 0),
      (e: Record<string, unknown>) => (e["recallImpairedUntilTick"] = -1),
      (e: Record<string, unknown>) => delete e["mastery"],
    ]) {
      const json = mutableJson(sampleState());
      broken(entityJson(json, "aRui"));
      expect(() => fromSerializable(json)).toThrow(SerializeError);
    }
  });

  it("未知の entity 種別", () => {
    const json = mutableJson(sampleState());
    entityJson(json, "aRui")["kind"] = "outpost";
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("キーと id フィールドの食い違い", () => {
    const json = mutableJson(sampleState());
    entityJson(json, "aRui")["id"] = "bMina";
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("ID 規則違反のキー", () => {
    const json = mutableJson(sampleState());
    const map = json["entityStateById"] as Record<string, unknown>;
    const moved = entityJson(json, "aRui");
    delete map["aRui"];
    moved["id"] = "Bad-Id";
    map["Bad-Id"] = moved;
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("entity がオブジェクトでない", () => {
    const json = mutableJson(sampleState());
    (json["entityStateById"] as Record<string, unknown>)["aRui"] = 1;
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("エラーメッセージに JSON path が入る", () => {
    const json = mutableJson(sampleState());
    entityJson(json, "aRui")["morale"] = "x";
    expect(() => fromSerializable(json)).toThrow(/\$\.entityStateById\.aRui\.morale/);
  });

  it("ID 重複は createGameState 側で止まる", () => {
    // JSON オブジェクトのキーは重複し得ないので、重複 ID は id フィールドの
    // 改変では作れない(= キー/id 不一致で先に落ちる)。ここでは update.ts の
    // 重複検出が生きていることを createGameState 直呼びで固定しておく。
    expect(() => createGameState(META, [resident("aRui"), facility("aRui")])).toThrow(
      StateUpdateError,
    );
  });
});
