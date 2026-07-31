// ---------------------------------------------------------------------------
// [M52] 地形 / 瓦礫(state.ts の TerrainState / GameState.terrain)の
// 不変条件と往復のテスト(serialize.ts §10 / update.ts の requireValidTerrain)。
//
// 中心は M52 の検収条件そのもの:
//   (1) **瓦礫ゼロの state は直列化形にキーが現れない**
//       = 既存セーブ・既存 golden vector 64 本のバイト列が 1 bit も動かない
//   (2) **`terrain` キーを持たない旧セーブが「全セル開墾済み」として
//       無損失でロードされる**(migration 段は版を進めるだけ)
//   (3) 空の terrain を明示した非正準形は reject(往復のバイト同一性の維持)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import {
  EMPTY_TERRAIN,
  firstRubbleCellIn,
  isRubbleCell,
  entityIdFromString,
  type EntityState,
  type GameState,
  type GameStateMeta,
} from "../../../src/engine/state/state";
import { StateUpdateError, createGameState, setTerrain } from "../../../src/engine/state/update";
import { fixFromInt } from "../../../src/engine/fp";
import { SAVE_SCHEMA_VERSION, migrateSavePayload } from "../../../src/platform/migration";

const idOf = entityIdFromString;

const META: GameStateMeta = {
  saveSchemaVersion: SAVE_SCHEMA_VERSION,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 0,
};

const ENTITIES: readonly EntityState[] = [
  { kind: "resource", id: idOf("resourceWood"), resourceId: idOf("wood"), stock: fixFromInt(5) },
];

function stateOf(): GameState {
  return createGameState(META, [...ENTITIES]);
}

// --- 1. 既定は「瓦礫ゼロ」= キーごと省略 ------------------------------------

describe("既定の地形(縮約互換)", () => {
  it("createGameState の既定は瓦礫ゼロ(全 48 セル開墾済み)", () => {
    expect(stateOf().terrain).toEqual(EMPTY_TERRAIN);
    expect(isRubbleCell(stateOf(), 0)).toBe(false);
    expect(isRubbleCell(stateOf(), 47)).toBe(false);
  });

  it("瓦礫ゼロの state は直列化形に terrain キーを出さない(golden 不変の根拠)", () => {
    expect(Object.keys(toSerializable(stateOf()))).not.toContain("terrain");
  });

  it("terrain キーを持たない直列化形は瓦礫ゼロとして復元される(旧セーブの無損失ロード)", () => {
    const json = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    expect(json["terrain"]).toBeUndefined();
    const restored = fromSerializable(json);
    expect(restored.terrain).toEqual(EMPTY_TERRAIN);
    // 往復でバイト同一(キーが増えも減りもしない)。
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(json));
  });

  it("v4 の payload(terrain キー無し)は版だけ進み、全セル開墾済みで読める", () => {
    const v4 = { ...(toSerializable(stateOf()) as unknown as Record<string, unknown>) };
    v4["saveSchemaVersion"] = 4;
    const migrated = migrateSavePayload(v4);
    // [M28] v4→v5(地形)+ v5→v6(周回/継承点)の 2 段。
    expect(migrated.appliedSteps).toHaveLength(2);
    const restored = fromSerializable(migrated.value);
    expect(restored.saveSchemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(restored.terrain).toEqual(EMPTY_TERRAIN);
    // 現行ビルドが同じ内容を書いたセーブと 1 bit も違わない。
    expect(JSON.stringify(toSerializable(restored))).toBe(
      JSON.stringify(toSerializable(stateOf())),
    );
  });
});

// --- 2. 瓦礫を持つ state の往復 ---------------------------------------------

describe("瓦礫を持つ地形の往復", () => {
  const withRubble = (): GameState =>
    setTerrain(stateOf(), { rubbleCells: [3, 12, 47], reclaimedCount: 2 });

  it("直列化形へ terrain が載り、往復でバイト同一", () => {
    const json = toSerializable(withRubble()) as unknown as Record<string, unknown>;
    expect(json["terrain"]).toEqual({ rubbleCells: [3, 12, 47], reclaimedCount: 2 });
    const restored = fromSerializable(json);
    expect(restored.terrain).toEqual({ rubbleCells: [3, 12, 47], reclaimedCount: 2 });
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(json));
  });

  it("全部開墾し終えた盤面(瓦礫ゼロ・解放数 > 0)は正準形として残る", () => {
    const done = setTerrain(stateOf(), { rubbleCells: [], reclaimedCount: 7 });
    const json = toSerializable(done) as unknown as Record<string, unknown>;
    expect(json["terrain"]).toEqual({ rubbleCells: [], reclaimedCount: 7 });
    expect(fromSerializable(json).terrain.reclaimedCount).toBe(7);
  });

  it("isRubbleCell / firstRubbleCellIn が占有セル集合を判定できる", () => {
    const state = withRubble();
    expect(isRubbleCell(state, 12)).toBe(true);
    expect(isRubbleCell(state, 13)).toBe(false);
    // 入力の並び順に依存せず最小の瓦礫セルを返す。
    expect(firstRubbleCellIn(state, [47, 13, 12])).toBe(12);
    expect(firstRubbleCellIn(state, [13, 14])).toBeNull();
  });
});

// --- 3. 非正準形と不変条件 --------------------------------------------------

describe("非正準形・不変条件違反は境界で止まる", () => {
  it("空の terrain を明示した直列化形は reject(§10)", () => {
    const json = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    json["terrain"] = { rubbleCells: [], reclaimedCount: 0 };
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("rubbleCells が配列でない / 要素が整数でない形は reject", () => {
    const bad = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    bad["terrain"] = { rubbleCells: 12, reclaimedCount: 1 };
    expect(() => fromSerializable(bad)).toThrow(SerializeError);
    const bad2 = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    bad2["terrain"] = { rubbleCells: [1.5], reclaimedCount: 1 };
    expect(() => fromSerializable(bad2)).toThrow(SerializeError);
  });

  it("昇順・重複なしでない rubbleCells は StateUpdateError(復元時に停止)", () => {
    const json = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    json["terrain"] = { rubbleCells: [12, 3], reclaimedCount: 0 };
    expect(() => fromSerializable(json)).toThrow(StateUpdateError);
    const duplicated = toSerializable(stateOf()) as unknown as Record<string, unknown>;
    duplicated["terrain"] = { rubbleCells: [12, 12], reclaimedCount: 0 };
    expect(() => fromSerializable(duplicated)).toThrow(StateUpdateError);
  });

  it("盤外のセル番号は StateUpdateError", () => {
    expect(() => setTerrain(stateOf(), { rubbleCells: [48], reclaimedCount: 0 })).toThrow(
      StateUpdateError,
    );
  });

  it("解放数が負なら StateUpdateError", () => {
    expect(() => setTerrain(stateOf(), { rubbleCells: [], reclaimedCount: -1 })).toThrow(
      StateUpdateError,
    );
  });

  it("setTerrain は同一参照なら state を作り直さない(構造共有)", () => {
    const state = stateOf();
    expect(setTerrain(state, state.terrain)).toBe(state);
  });
});
