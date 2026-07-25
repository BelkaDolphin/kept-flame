import { describe, expect, it } from "vitest";
import {
  ENTITY_ID_PATTERN,
  EntityIdError,
  EntityLookupError,
  entitiesOfKind,
  entityIdFromString,
  entityIds,
  getEntity,
  isEntityId,
  requireEntity,
  type EntityId,
  type FacilityState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "../../../src/engine/state/state";
import { createGameState } from "../../../src/engine/state/update";
import { fixFromInt } from "../../../src/engine/fp";

// ---------------------------------------------------------------------------
// state.ts の公開APIのテスト。
//   1. ENTITY_ID_PATTERN / isEntityId / entityIdFromString (ADR-011)
//   2. getEntity
//   3. requireEntity (narrowing含む)
//   4. entityIds (正準順)
//   5. entitiesOfKind (正準順・種別フィルタ)
//
// GameStateは手でliteral生成せず、必ずcreateGameState(state/update.ts)経由で
// 作る(state.tsのドキュメントコメント: 不変条件はupdate.ts側が維持する)。
// ---------------------------------------------------------------------------

const META: GameStateMeta = {
  saveSchemaVersion: 1,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "test-seed",
  tick: 0,
};

function makeResident(id: EntityId): ResidentState {
  return {
    kind: "resident",
    id,
    morale: fixFromInt(50),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
  };
}

function makeFacility(id: EntityId, defId: EntityId, cellIndex: number): FacilityState {
  return {
    kind: "facility",
    id,
    defId,
    level: 1,
    cellIndex,
    workerIds: [],
  };
}

function makeResearch(id: EntityId, techId: EntityId): ResearchState {
  return {
    kind: "research",
    id,
    techId,
    progress: fixFromInt(0),
    completedTick: null,
  };
}

function makeResource(id: EntityId, resourceId: EntityId): ResourceState {
  return {
    kind: "resource",
    id,
    resourceId,
    stock: fixFromInt(0),
  };
}

// ---------------------------------------------------------------------------
// 1. ENTITY_ID_PATTERN / isEntityId / entityIdFromString
// ---------------------------------------------------------------------------

describe("ENTITY_ID_PATTERN / isEntityId / entityIdFromString: ID命名規則(ADR-011)", () => {
  const VALID_IDS = ["a", "residentA", "facility_01", "x9_z"];
  const INVALID_IDS = ["", "A", "_x", "9x", "a-b", "a.b", "a b", "住民", "0", "12", "__proto__"];

  for (const value of VALID_IDS) {
    it(`受理: ${JSON.stringify(value)} は isEntityId で true、entityIdFromString は例外を投げない`, () => {
      expect(isEntityId(value)).toBe(true);
      expect(() => entityIdFromString(value)).not.toThrow();
    });
  }

  for (const value of INVALID_IDS) {
    it(`拒否: ${JSON.stringify(value)} は isEntityId で false、entityIdFromString は EntityIdError を投げる`, () => {
      expect(isEntityId(value)).toBe(false);
      expect(() => entityIdFromString(value)).toThrow(EntityIdError);
    });
  }

  it('整数風キー("0","12")の拒否は往復不変性の根拠そのもの(state.ts: ID先頭が英小文字なので正準整数インデックスになり得ない)', () => {
    // ID が数字始まりだと正準数値文字列とみなされ、プレーンオブジェクト化したときに
    // 数値キーとして先頭へ繰り上がり、挿入順(= ID昇順)が保存されなくなる。
    // ADR-011 が先頭を英小文字に限定しているのはこれを防ぐため。
    expect(isEntityId("0")).toBe(false);
    expect(isEntityId("12")).toBe(false);
  });

  it("同じ文字列を2回連続で検査しても同じ結果になる(ENTITY_ID_PATTERNはgフラグを持たずlastIndex状態を持ち越さない)", () => {
    expect(ENTITY_ID_PATTERN.global).toBe(false);
    expect(isEntityId("residentA")).toBe(true);
    expect(isEntityId("residentA")).toBe(true);
    expect(isEntityId("9x")).toBe(false);
    expect(isEntityId("9x")).toBe(false);
  });

  it('改行を含む文字列は拒否される("$"が改行前にマッチするJS仕様に対する回帰テスト)', () => {
    // JSの $ は(mフラグ無しの場合)入力の真の末尾にのみマッチし、末尾直前の改行の
    // 前にはマッチしない(この点はPythonのreの挙動と異なる)。よって末尾に改行を
    // 持つ文字列("a\n")も、改行を挟んだ文字列("a\nb")も拒否されるのが正しい仕様。
    expect(isEntityId("a\nb")).toBe(false);
    expect(isEntityId("a\n")).toBe(false);
    expect(() => entityIdFromString("a\nb")).toThrow(EntityIdError);
    expect(() => entityIdFromString("a\n")).toThrow(EntityIdError);
  });

  it("entityIdFromStringが返す値はEntityIdとして代入できる(型レベルの確認)", () => {
    const id: EntityId = entityIdFromString("residentA");
    expect(id).toBe("residentA");
  });
});

// ---------------------------------------------------------------------------
// 2. getEntity
// ---------------------------------------------------------------------------

describe("getEntity: entityを引く(無ければundefined)", () => {
  const residentId = entityIdFromString("residentA");
  const state = createGameState(META, [makeResident(residentId)]);

  it("存在するentityを返す", () => {
    const entity = getEntity(state, residentId);
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe("resident");
    expect(entity?.id).toBe(residentId);
  });

  it("存在しないentityはundefinedを返す", () => {
    expect(getEntity(state, entityIdFromString("missing"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. requireEntity
// ---------------------------------------------------------------------------

describe("requireEntity: 種別付きで引く / narrowing", () => {
  const residentId = entityIdFromString("residentA");
  const facilityId = entityIdFromString("facilityA");
  const state = createGameState(META, [
    makeResident(residentId),
    makeFacility(facilityId, entityIdFromString("facilityDef"), 0),
  ]);

  it("存在し種別が一致すればentityを返し、narrowingにより種別固有フィールドへアクセスできる(resident)", () => {
    const resident = requireEntity(state, residentId, "resident");
    // 戻り値はResidentStateへnarrowingされているので、union型のままでは
    // アクセスできない .morale / .assignedFacilityId にそのままアクセスできる
    // (これがコンパイルを通ること自体がこのテストの主眼)。
    expect(resident.morale).toBe(fixFromInt(50));
    expect(resident.assignedFacilityId).toBeNull();
  });

  it("存在し種別が一致すればentityを返し、narrowingが効く(facility)", () => {
    const facility = requireEntity(state, facilityId, "facility");
    expect(facility.workerIds).toEqual([]);
    expect(facility.cellIndex).toBe(0);
  });

  it("存在しないIDはEntityLookupErrorを投げる", () => {
    expect(() => requireEntity(state, entityIdFromString("missing"), "resident")).toThrow(
      EntityLookupError,
    );
  });

  it("種別が食い違えばEntityLookupErrorを投げる", () => {
    expect(() => requireEntity(state, residentId, "facility")).toThrow(EntityLookupError);
  });
});

// ---------------------------------------------------------------------------
// 4. entityIds
// ---------------------------------------------------------------------------

describe("entityIds: IDのUTF-16コードユニット昇順(正準順)で返る", () => {
  it("createGameStateに渡す順序を変えても同じ並びになる", () => {
    const idA = entityIdFromString("a");
    const idB = entityIdFromString("b");
    const idC = entityIdFromString("c");
    const resourceDefId = entityIdFromString("resourceDef");

    const resourceA = makeResource(idA, resourceDefId);
    const resourceB = makeResource(idB, resourceDefId);
    const resourceC = makeResource(idC, resourceDefId);

    const stateInsertedAsc = createGameState(META, [resourceA, resourceB, resourceC]);
    const stateInsertedShuffled = createGameState(META, [resourceC, resourceA, resourceB]);

    expect(entityIds(stateInsertedAsc)).toEqual([idA, idB, idC]);
    expect(entityIds(stateInsertedShuffled)).toEqual([idA, idB, idC]);
  });

  it("大文字小文字混在のIDはコードユニット順で並ぶ(ロケール依存の辞書順ではない): 'Z'(0x5A) < 'a'(0x61)", () => {
    const idAZ = entityIdFromString("aZ");
    const idAa = entityIdFromString("aa");
    const resourceDefId = entityIdFromString("resourceDef");

    // 挿入順は "aa" → "aZ" だが、コードユニット順なら "aZ" が先に来るはず。
    // ロケール依存の辞書順(Intl.Collator等)だと大文字小文字を同一視して
    // "aa" が先に来ることがあり、その違いをここで固定する。
    const state = createGameState(META, [
      makeResource(idAa, resourceDefId),
      makeResource(idAZ, resourceDefId),
    ]);

    expect(entityIds(state)).toEqual([idAZ, idAa]);
  });
});

// ---------------------------------------------------------------------------
// 5. entitiesOfKind
// ---------------------------------------------------------------------------

describe("entitiesOfKind: 指定種別だけを正準順で返す", () => {
  const residentB = makeResident(entityIdFromString("residentB"));
  const residentA = makeResident(entityIdFromString("residentA"));
  const facilityDefId = entityIdFromString("facilityDef");
  const facilityA = makeFacility(entityIdFromString("facilityA"), facilityDefId, 0);
  const techId = entityIdFromString("techA");
  const researchA = makeResearch(entityIdFromString("researchA"), techId);
  const resourceDefId = entityIdFromString("resourceDef");
  const resourceA = makeResource(entityIdFromString("resourceA"), resourceDefId);

  const state = createGameState(META, [residentB, residentA, facilityA, researchA, resourceA]);

  it("residentのみを正準順(ID昇順)で返す", () => {
    expect(entitiesOfKind(state, "resident")).toEqual([residentA, residentB]);
  });

  it("facilityのみを返す", () => {
    expect(entitiesOfKind(state, "facility")).toEqual([facilityA]);
  });

  it("researchのみを返す", () => {
    expect(entitiesOfKind(state, "research")).toEqual([researchA]);
  });

  it("resourceのみを返す", () => {
    expect(entitiesOfKind(state, "resource")).toEqual([resourceA]);
  });

  it("該当する種別が無ければ空配列を返す", () => {
    const emptyOfFacilityState = createGameState(META, [residentA]);
    expect(entitiesOfKind(emptyOfFacilityState, "facility")).toEqual([]);
  });
});
