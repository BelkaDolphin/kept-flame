import { describe, expect, it } from "vitest";

import { fixFromInt, type Fix } from "../../../src/engine/fp";
import {
  EntityLookupError,
  entityIdFromString,
  entityIds,
  requireEntity,
  type EntityId,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResidentState,
} from "../../../src/engine/state/state";
import {
  StateUpdateError,
  createGameState,
  putEntity,
  removeEntity,
  setField,
  updateEntity,
  updateIn,
} from "../../../src/engine/state/update";

// ---------------------------------------------------------------------------
// 構造共有の単一更新経路(ADR-028(1))のテスト。
//
// 主眼は「値が正しいか」ではなく **参照がどう共有されるか** にある:
//   (1) 変更パス上だけが新しい参照になる(それ以外は === で同一)
//   (2) 値が変わらない更新は参照も変えない
//   (3) entity Map の反復順が ID 昇順の正準順に保たれる(到達経路非依存)
// ---------------------------------------------------------------------------

const META: GameStateMeta = {
  saveSchemaVersion: 1,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 0,
};

const idOf = (value: string): EntityId => entityIdFromString(value);

function resident(id: string, morale = 50, traitIds: readonly string[] = []): ResidentState {
  return {
    kind: "resident",
    id: idOf(id),
    morale: fixFromInt(morale),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: traitIds.map(idOf),
    recallImpairedUntilTick: 0,
  };
}

function facility(id: string, workerIds: readonly string[] = []): FacilityState {
  return {
    kind: "facility",
    id: idOf(id),
    defId: idOf("smeltery"),
    level: 1,
    cellIndex: 0,
    workerIds: workerIds.map(idOf),
  };
}

describe("createGameState", () => {
  it("entity を ID 昇順(正準順)で Map 化する", () => {
    const state = createGameState(META, [facility("dHall"), resident("bMina"), resident("aRui")]);
    expect(entityIds(state)).toEqual(["aRui", "bMina", "dHall"]);
  });

  it("渡す順序を変えても同じ反復順になる(到達経路非依存)", () => {
    const entities = [resident("aRui"), facility("dHall"), resident("bMina")];
    const forward = createGameState(META, entities);
    const reversed = createGameState(META, [...entities].reverse());
    expect(entityIds(reversed)).toEqual(entityIds(forward));
  });

  it("ID は大文字小文字を含めて UTF-16 コードユニット順に並ぶ", () => {
    // "Z" = 0x5A < "a" = 0x61 なので、ロケール依存の辞書順とは並びが違う。
    const state = createGameState(META, [resident("aa"), resident("aZ")]);
    expect(entityIds(state)).toEqual(["aZ", "aa"]);
  });

  it("メタ情報をそのまま持つ", () => {
    const state = createGameState(META, []);
    expect(state.saveSchemaVersion).toBe(1);
    expect(state.worldSeed).toBe("seedAlpha");
    expect(state.tick).toBe(0);
    expect(state.entityStateById.size).toBe(0);
  });

  it("ID 重複を reject する", () => {
    expect(() => createGameState(META, [resident("aRui"), facility("aRui")])).toThrow(
      StateUpdateError,
    );
  });

  it("ID 規則違反(brand を偽造した ID)を reject する", () => {
    const forged: ResidentState = { ...resident("aRui"), id: "Bad-Id" as unknown as EntityId };
    expect(() => createGameState(META, [forged])).toThrow(StateUpdateError);
  });

  // [M7] 住民 trait の不変条件(GDD 7.2 の上限 3 個 / ID 昇順 / 重複なし)。
  // 上限は rules/stats.ts の mulFixProven 値域証明の前提でもあるので、
  // state を作る唯一の入口で機械強制する。
  it("trait 上限 3 個ちょうどは受理する(GDD 7.2)", () => {
    const holder = resident("aRui", 50, ["traitArtisan", "traitExplorer", "traitStrongArm"]);
    expect(() => createGameState(META, [holder])).not.toThrow();
  });

  it("trait 4 個は reject する(GDD 7.2 の上限 3)", () => {
    const over = resident("aRui", 50, [
      "traitArtisan",
      "traitExplorer",
      "traitFrail",
      "traitStrongArm",
    ]);
    expect(() => createGameState(META, [over])).toThrow(StateUpdateError);
  });

  it("trait の重複を reject する(効果が静かに二重合成されるため)", () => {
    const dup = resident("aRui", 50, ["traitArtisan", "traitArtisan"]);
    expect(() => createGameState(META, [dup])).toThrow(StateUpdateError);
  });

  it("trait が ID 昇順でなければ reject する(合成は順序依存)", () => {
    const unsorted = resident("aRui", 50, ["traitStrongArm", "traitArtisan"]);
    expect(() => createGameState(META, [unsorted])).toThrow(StateUpdateError);
  });

  it("住民以外の entity は trait 検査の対象外", () => {
    expect(() => createGameState(META, [facility("dHall", ["a", "b", "c", "d"])])).not.toThrow();
  });
});

describe("setField", () => {
  it("1 フィールドだけ差し替えた新しいオブジェクトを返す", () => {
    const source = resident("aRui", 50, ["traitCalm"]);
    const next = setField(source, "morale", fixFromInt(60));
    expect(next).not.toBe(source);
    expect(next.morale).toBe(fixFromInt(60));
    expect(next.id).toBe(source.id);
    // 触っていないサブツリー(配列)は参照を共有する。
    expect(next.traitIds).toBe(source.traitIds);
  });

  it("同じ値ならコピーせず入力をそのまま返す", () => {
    const source = resident("aRui", 50);
    expect(setField(source, "morale", source.morale)).toBe(source);
  });

  it("GameState のスカラにも使える(Map は共有される)", () => {
    const state = createGameState(META, [resident("aRui")]);
    const next = setField(state, "tick", 7);
    expect(next.tick).toBe(7);
    expect(next).not.toBe(state);
    expect(next.entityStateById).toBe(state.entityStateById);
  });
});

describe("updateIn", () => {
  const tree = { a: { b: { c: 1, d: 2 }, e: 3 }, f: 4 };

  it("深さ 1 の更新", () => {
    const state = createGameState(META, []);
    const next = updateIn(state, ["tick"], (t) => t + 1);
    expect(next.tick).toBe(1);
    expect(next.entityStateById).toBe(state.entityStateById);
  });

  it("深さ 3 の更新で path 上だけが新しい参照になる", () => {
    const next = updateIn(tree, ["a", "b", "c"], (c) => c + 1);
    expect(next.a.b.c).toBe(2);
    expect(next).not.toBe(tree);
    expect(next.a).not.toBe(tree.a);
    expect(next.a.b).not.toBe(tree.a.b);
    // path から外れた枝は参照そのまま。
    expect(next.a.e).toBe(tree.a.e);
    expect(next.f).toBe(tree.f);
    expect(next.a.b.d).toBe(tree.a.b.d);
  });

  it("値が変わらなければ全階層でコピーしない", () => {
    const next = updateIn(tree, ["a", "b", "c"], (c) => c);
    expect(next).toBe(tree);
  });

  it("配列要素も更新できる(配列は slice コピー)", () => {
    const source = facility("dHall", ["aRui", "bMina"]);
    const next = updateIn(source, ["workerIds", 1], () => idOf("cSora"));
    expect(next.workerIds).toEqual(["aRui", "cSora"]);
    expect(source.workerIds).toEqual(["aRui", "bMina"]);
    expect(Array.isArray(next.workerIds)).toBe(true);
  });

  // 型では書けない誤用(空 path・プリミティブを掘る)の実行時ガード。
  const updateInLoose = updateIn as unknown as (
    target: object,
    path: readonly PropertyKey[],
    updater: (value: unknown) => unknown,
  ) => object;

  it("空の path を reject する", () => {
    expect(() => updateInLoose(tree, [], (v) => v)).toThrow(StateUpdateError);
  });

  it("path 途中がオブジェクトでなければ reject する", () => {
    expect(() => updateInLoose(tree, ["f", "x"], (v) => v)).toThrow(StateUpdateError);
    expect(() => updateInLoose({ a: null }, ["a", "x"], (v) => v)).toThrow(StateUpdateError);
  });
});

describe("updateEntity: 構造共有", () => {
  const idA = idOf("aRui");
  const idB = idOf("bMina");
  const idD = idOf("dHall");

  function baseState(): GameState {
    return createGameState(META, [
      resident("aRui", 50, ["traitCalm"]),
      resident("bMina", 40),
      facility("dHall", ["aRui"]),
    ]);
  }

  it("変更パス上だけが新しい参照になり、他の entity は同一参照のまま", () => {
    const state = baseState();
    const next = updateEntity(state, idA, "resident", (r) => setField(r, "morale", fixFromInt(60)));

    expect(next).not.toBe(state);
    expect(next.entityStateById).not.toBe(state.entityStateById);
    expect(next.entityStateById.get(idA)).not.toBe(state.entityStateById.get(idA));

    // 無関係な entity は参照同一。
    expect(next.entityStateById.get(idB)).toBe(state.entityStateById.get(idB));
    expect(next.entityStateById.get(idD)).toBe(state.entityStateById.get(idD));

    // 対象 entity の中でも、触っていないサブツリーは共有される。
    expect(requireEntity(next, idA, "resident").traitIds).toBe(
      requireEntity(state, idA, "resident").traitIds,
    );

    // スカラは同値のまま。
    expect(next.worldSeed).toBe(state.worldSeed);
    expect(next.tick).toBe(state.tick);
  });

  it("元の state は書き換わらない(不変)", () => {
    const state = baseState();
    updateEntity(state, idA, "resident", (r) => setField(r, "morale", fixFromInt(60)));
    expect(requireEntity(state, idA, "resident").morale).toBe(fixFromInt(50));
  });

  it("updater が同じ参照を返したら state もそのまま", () => {
    const state = baseState();
    expect(updateEntity(state, idA, "resident", (r) => r)).toBe(state);
  });

  it("値が変わらない更新でも state はそのまま(setField 経由の no-op)", () => {
    const state = baseState();
    const next = updateEntity(state, idA, "resident", (r) => setField(r, "morale", r.morale));
    expect(next).toBe(state);
  });

  it("反復順は更新後も正準順のまま", () => {
    const state = baseState();
    const next = updateEntity(state, idA, "resident", (r) => setField(r, "morale", fixFromInt(60)));
    expect(entityIds(next)).toEqual(entityIds(state));
  });

  it("存在しない ID / 種別違いは EntityLookupError", () => {
    const state = baseState();
    expect(() => updateEntity(state, idOf("zNone"), "resident", (r) => r)).toThrow(
      EntityLookupError,
    );
    expect(() => updateEntity(state, idD, "resident", (r) => r)).toThrow(EntityLookupError);
  });

  it("updater が別 ID の entity を返したら StateUpdateError", () => {
    const state = baseState();
    expect(() => updateEntity(state, idA, "resident", (r) => setField(r, "id", idB))).toThrow(
      StateUpdateError,
    );
  });

  it("updater が別種別の entity を返したら StateUpdateError", () => {
    const state = baseState();
    const swapKind = (r: ResidentState): ResidentState =>
      setField(r, "kind", "facility" as unknown as "resident");
    expect(() => updateEntity(state, idA, "resident", swapKind)).toThrow(StateUpdateError);
  });
});

describe("putEntity / removeEntity", () => {
  it("既存 ID の差し替えは反復順を変えない", () => {
    const state = createGameState(META, [resident("aRui"), resident("bMina"), resident("cSora")]);
    const next = putEntity(state, resident("bMina", 99));
    expect(entityIds(next)).toEqual(["aRui", "bMina", "cSora"]);
    expect(requireEntity(next, idOf("bMina"), "resident").morale).toBe(fixFromInt(99));
  });

  it("新規 ID は正準順の位置に入る(末尾追加にならない)", () => {
    const state = createGameState(META, [resident("bMina"), resident("dHall")]);
    const withC = putEntity(state, resident("cSora"));
    expect(entityIds(withC)).toEqual(["bMina", "cSora", "dHall"]);
    const withA = putEntity(withC, resident("aRui"));
    expect(entityIds(withA)).toEqual(["aRui", "bMina", "cSora", "dHall"]);
  });

  it("追加順が違っても同じ反復順に落ち着く", () => {
    const empty = createGameState(META, []);
    const order1 = putEntity(putEntity(empty, resident("cSora")), resident("aRui"));
    const order2 = putEntity(putEntity(empty, resident("aRui")), resident("cSora"));
    expect(entityIds(order1)).toEqual(entityIds(order2));
  });

  it("同一参照の put は state を変えない", () => {
    const existing: EntityState = resident("aRui");
    const state = createGameState(META, [existing]);
    expect(putEntity(state, existing)).toBe(state);
  });

  it("ID 規則違反の新規 entity を reject する", () => {
    const state = createGameState(META, []);
    const forged: ResidentState = { ...resident("aRui"), id: "9bad" as unknown as EntityId };
    expect(() => putEntity(state, forged)).toThrow(StateUpdateError);
  });

  it("removeEntity は残りの順序を保つ", () => {
    const state = createGameState(META, [resident("aRui"), resident("bMina"), resident("cSora")]);
    const next = removeEntity(state, idOf("bMina"));
    expect(entityIds(next)).toEqual(["aRui", "cSora"]);
    // 残った entity は参照同一。
    expect(next.entityStateById.get(idOf("aRui"))).toBe(state.entityStateById.get(idOf("aRui")));
  });

  it("不在 ID の removeEntity は EntityLookupError", () => {
    const state = createGameState(META, [resident("aRui")]);
    expect(() => removeEntity(state, idOf("zNone"))).toThrow(EntityLookupError);
  });
});

describe("Fix 値の更新が fp.ts の不変条件を保つ", () => {
  it("morale の更新結果が Fix のまま扱える", () => {
    const state = createGameState(META, [resident("aRui", 50)]);
    const next = updateEntity(state, idOf("aRui"), "resident", (r) =>
      setField(r, "morale", fixFromInt(75)),
    );
    const morale: Fix = requireEntity(next, idOf("aRui"), "resident").morale;
    expect(morale).toBe(75_000_000);
  });
});
