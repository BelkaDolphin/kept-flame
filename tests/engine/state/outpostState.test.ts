import { describe, expect, it } from "vitest";

import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import {
  EMPTY_RENDERED_LOGS,
  allOutposts,
  entityIdFromString,
  getOutpost,
  type EntityState,
  type GameState,
  type GameStateMeta,
  type OutpostState,
} from "../../../src/engine/state/state";
import {
  StateUpdateError,
  createGameState,
  removeOutpost,
  setOutpost,
} from "../../../src/engine/state/update";

// ---------------------------------------------------------------------------
// [M24] 衛星拠点(state.ts の OutpostState / GameState.outpostsById)の
// 往復テスト。中心は既存の rngState/bondByPairKey/techMemoryByKey と同じ
// 「空なら直列化形からキーごと省略される」規約(= 既存 golden vector 64 本の
// バイト列が 1 bit も動かない根拠)。
// ---------------------------------------------------------------------------

const idOf = entityIdFromString;

const META: GameStateMeta = {
  saveSchemaVersion: 4,
  contentVersion: 1,
  algoVersion: 2,
  worldSeed: "seedAlpha",
  tick: 0,
};

function stateOf(
  entities: readonly EntityState[] = [],
  outposts: readonly OutpostState[] = [],
): GameState {
  return createGameState(META, entities, [], [], [], [], EMPTY_RENDERED_LOGS, outposts);
}

function outpostOf(name: string, overrides: Partial<OutpostState> = {}): OutpostState {
  return {
    id: idOf(name),
    outpostTypeId: idOf("outpostMineTest"),
    level: 1,
    band: "near",
    residentIds: [idOf("residentAlpha")],
    establishedTick: 0,
    ...overrides,
  };
}

describe("空なら直列化形にキーが現れない", () => {
  it("拠点が 1 つも無い state のトップレベルキー一覧は M24 以前と同一", () => {
    const json = toSerializable(stateOf());
    expect(Object.keys(json)).not.toContain("outpostsById");
    // canonicalizeJson がキーを UTF-16 昇順に揃える(serialize.ts §1(a))。
    expect(Object.keys(json)).toEqual([
      "algoVersion",
      "contentVersion",
      "entityStateById",
      "saveSchemaVersion",
      "tick",
      "worldSeed",
    ]);
  });
});

describe("設定されていれば往復する", () => {
  it("拠点がバイト同一で往復する", () => {
    const state = stateOf([], [outpostOf("outpostAlpha")]);
    const first = JSON.stringify(toSerializable(state));
    const restored = fromSerializable(JSON.parse(first));
    expect(JSON.stringify(toSerializable(restored))).toBe(first);

    const outpost = getOutpost(restored, idOf("outpostAlpha"));
    expect(outpost).toBeDefined();
    expect(outpost?.outpostTypeId).toBe("outpostMineTest");
    expect(outpost?.level).toBe(1);
    expect(outpost?.band).toBe("near");
    expect(outpost?.residentIds).toEqual(["residentAlpha"]);
    expect(outpost?.establishedTick).toBe(0);
  });

  it("複数拠点は ID 昇順で反復される(不変条件 (h))", () => {
    const state = stateOf(
      [],
      [
        outpostOf("outpostZulu", { residentIds: [idOf("residentZ")] }),
        outpostOf("outpostAlpha", { residentIds: [idOf("residentA")] }),
      ],
    );
    expect(allOutposts(state).map((o) => o.id)).toEqual(["outpostAlpha", "outpostZulu"]);
  });
});

describe("拠点の不変条件(GDD 9.2)", () => {
  it("Lv が 1 未満だと reject", () => {
    expect(() => stateOf([], [outpostOf("outpostBad", { level: 0 })])).toThrow(StateUpdateError);
  });

  it("常駐人数が 0 だと reject(GDD 9.2「住民1〜4名常駐」)", () => {
    expect(() => stateOf([], [outpostOf("outpostBad", { residentIds: [] })])).toThrow(
      StateUpdateError,
    );
  });

  it("常駐人数が 5 以上だと reject", () => {
    expect(() =>
      stateOf(
        [],
        [
          outpostOf("outpostBad", {
            residentIds: [idOf("r1"), idOf("r2"), idOf("r3"), idOf("r4"), idOf("r5")],
          }),
        ],
      ),
    ).toThrow(StateUpdateError);
  });

  it("residentIds が ID 昇順でないと reject", () => {
    expect(() =>
      stateOf(
        [],
        [outpostOf("outpostBad", { residentIds: [idOf("residentZ"), idOf("residentA")] })],
      ),
    ).toThrow(StateUpdateError);
  });

  it("residentIds に重複があると reject", () => {
    expect(() =>
      stateOf(
        [],
        [outpostOf("outpostBad", { residentIds: [idOf("residentA"), idOf("residentA")] })],
      ),
    ).toThrow(StateUpdateError);
  });

  it("拠点 ID が重複していると reject", () => {
    expect(() => stateOf([], [outpostOf("outpostDup"), outpostOf("outpostDup")])).toThrow(
      StateUpdateError,
    );
  });
});

describe("setOutpost / removeOutpost", () => {
  it("setOutpost は新規拠点を追加する", () => {
    const state = stateOf();
    const next = setOutpost(state, outpostOf("outpostNew"));
    expect(getOutpost(next, idOf("outpostNew"))).toBeDefined();
    expect(getOutpost(state, idOf("outpostNew"))).toBeUndefined();
  });

  it("setOutpost は不変条件違反を reject する", () => {
    const state = stateOf();
    expect(() => setOutpost(state, outpostOf("outpostBad", { level: 0 }))).toThrow(
      StateUpdateError,
    );
  });

  it("removeOutpost は既存拠点を取り除く", () => {
    const state = stateOf([], [outpostOf("outpostGone")]);
    const next = removeOutpost(state, idOf("outpostGone"));
    expect(getOutpost(next, idOf("outpostGone"))).toBeUndefined();
  });

  it("removeOutpost は不在の ID で例外", () => {
    const state = stateOf();
    expect(() => removeOutpost(state, idOf("outpostGone"))).toThrow();
  });
});

describe("壊れた直列化形は停止させる", () => {
  it("キーと id フィールドが食い違えば reject", () => {
    const state = stateOf([], [outpostOf("outpostAlpha")]);
    const json = JSON.parse(JSON.stringify(toSerializable(state))) as {
      outpostsById: Record<string, Record<string, unknown>>;
    };
    const entry = json.outpostsById["outpostAlpha"];
    if (entry === undefined) throw new Error("outpostsById.outpostAlpha が無い");
    entry["id"] = "outpostMismatch";
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });

  it("未知の距離帯は reject", () => {
    const state = stateOf([], [outpostOf("outpostAlpha")]);
    const json = JSON.parse(JSON.stringify(toSerializable(state))) as {
      outpostsById: Record<string, Record<string, unknown>>;
    };
    const entry = json.outpostsById["outpostAlpha"];
    if (entry === undefined) throw new Error("outpostsById.outpostAlpha が無い");
    entry["band"] = "middle";
    expect(() => fromSerializable(json)).toThrow(SerializeError);
  });
});
