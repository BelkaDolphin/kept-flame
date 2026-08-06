import { describe, expect, it } from "vitest";

import { DOMAIN_TAGS, isDomainTag } from "../../../src/engine/rng/domainTags";
import type { Xoshiro128State } from "../../../src/engine/rng/xoshiro128";
import {
  SerializeError,
  fromSerializable,
  toSerializable,
} from "../../../src/engine/state/serialize";
import {
  getRngState,
  rngStateDomains,
  type GameState,
  type GameStateMeta,
} from "../../../src/engine/state/state";
import { StateUpdateError, createGameState, setRngState } from "../../../src/engine/state/update";
import { fixFromInt } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";

// ---------------------------------------------------------------------------
// rngState(セーブフォーマット 658行 / state.ts §4)の往復と正準順のテスト。
//
// T4 で T5 送りにした「Map<DomainTag, Xoshiro128State> の往復」がここ。
// 押さえる点:
//   (1) 反復順が domainTag 昇順の正準順であること(到達経路非依存)
//   (2) 往復でバイト同一(キー順まで)
//   (3) **空なら省略**(= rngState 導入前のセーブと同じバイト列/旧セーブをそのまま
//       ロードできる。serialize.ts §3)
//   (4) 未登録 domainTag・uint32 外・長さ違いを reject(レジストリ整合)
// ---------------------------------------------------------------------------

const META: GameStateMeta = {
  saveSchemaVersion: 1,
  contentVersion: 1,
  algoVersion: 1,
  worldSeed: "seedAlpha",
  tick: 7,
};

const idOf = (value: string) => entityIdFromString(value);

const S1: Xoshiro128State = [1, 2, 3, 4];
const S2: Xoshiro128State = [0, 0xffff_ffff, 0x8000_0000, 42];

function baseState(): GameState {
  return createGameState(META, [
    {
      kind: "resource",
      id: idOf("wStock"),
      resourceId: idOf("wood"),
      stock: fixFromInt(3),
    },
  ]);
}

function roundTrip(state: GameState): GameState {
  return fromSerializable(JSON.parse(JSON.stringify(toSerializable(state))));
}

describe("createGameState の rngState 初期化", () => {
  it("省略すると空(まだ 1 度も引いていない)", () => {
    const state = baseState();
    expect(state.rngState.size).toBe(0);
    expect(rngStateDomains(state)).toEqual([]);
    expect(getRngState(state, DOMAIN_TAGS.recallDuration)).toBe(undefined);
  });

  it("渡した順に依らず domainTag 昇順で Map 化される", () => {
    const forward = createGameState(
      META,
      [],
      [
        [DOMAIN_TAGS.recallDuration, S1],
        [DOMAIN_TAGS.adjacency, S2],
        [DOMAIN_TAGS.exploration, S1],
      ],
    );
    const reversed = createGameState(
      META,
      [],
      [
        [DOMAIN_TAGS.exploration, S1],
        [DOMAIN_TAGS.adjacency, S2],
        [DOMAIN_TAGS.recallDuration, S1],
      ],
    );
    expect(rngStateDomains(forward)).toEqual(["adjacency", "exploration", "recallDuration"]);
    expect(rngStateDomains(reversed)).toEqual(rngStateDomains(forward));
  });

  it("同じ domainTag を 2 度渡すと例外", () => {
    expect(() =>
      createGameState(
        META,
        [],
        [
          [DOMAIN_TAGS.adjacency, S1],
          [DOMAIN_TAGS.adjacency, S2],
        ],
      ),
    ).toThrow(StateUpdateError);
  });
});

describe("setRngState(単一更新経路)", () => {
  it("新規ドメインを追加しても昇順が保たれる", () => {
    let state = baseState();
    state = setRngState(state, DOMAIN_TAGS.recallDuration, S1);
    state = setRngState(state, DOMAIN_TAGS.adjacency, S2);
    expect(rngStateDomains(state)).toEqual(["adjacency", "recallDuration"]);
  });

  it("既存ドメインの差し替えは順序を変えない", () => {
    let state = baseState();
    state = setRngState(state, DOMAIN_TAGS.adjacency, S1);
    state = setRngState(state, DOMAIN_TAGS.recallDuration, S1);
    const before = rngStateDomains(state);
    state = setRngState(state, DOMAIN_TAGS.adjacency, S2);
    expect(rngStateDomains(state)).toEqual(before);
    expect(getRngState(state, DOMAIN_TAGS.adjacency)).toEqual(S2);
  });

  it("同一参照を渡したら state をそのまま返す(構造共有)", () => {
    const state = setRngState(baseState(), DOMAIN_TAGS.adjacency, S1);
    expect(setRngState(state, DOMAIN_TAGS.adjacency, S1)).toBe(state);
  });

  it("entity Map は共有される(変更パス外は参照同一)", () => {
    const state = baseState();
    const next = setRngState(state, DOMAIN_TAGS.adjacency, S1);
    expect(next).not.toBe(state);
    expect(next.entityStateById).toBe(state.entityStateById);
  });
});

describe("往復", () => {
  it("空なら直列化形にキーが現れない(旧セーブとバイト同一・serialize.ts §3)", () => {
    const json = toSerializable(baseState());
    expect(Object.keys(json)).toEqual([
      "algoVersion",
      "contentVersion",
      "entityStateById",
      "saveSchemaVersion",
      "tick",
      "worldSeed",
    ]);
    expect("rngState" in json).toBe(false);
  });

  it("空の往復は空のまま", () => {
    const restored = roundTrip(baseState());
    expect(restored.rngState.size).toBe(0);
    expect(JSON.stringify(toSerializable(restored))).toBe(
      JSON.stringify(toSerializable(baseState())),
    );
  });

  it("非空ならキーが現れ、トップレベルも昇順に並ぶ", () => {
    const state = setRngState(baseState(), DOMAIN_TAGS.recallDuration, S1);
    const json = toSerializable(state);
    expect(Object.keys(json)).toEqual([
      "algoVersion",
      "contentVersion",
      "entityStateById",
      "rngState",
      "saveSchemaVersion",
      "tick",
      "worldSeed",
    ]);
    expect(json.rngState).toEqual({ recallDuration: [1, 2, 3, 4] });
  });

  it("state → JSON → state → JSON がバイト同一", () => {
    let state = baseState();
    state = setRngState(state, DOMAIN_TAGS.recallDuration, S1);
    state = setRngState(state, DOMAIN_TAGS.adjacency, S2);
    const first = JSON.stringify(toSerializable(state));
    const second = JSON.stringify(toSerializable(fromSerializable(JSON.parse(first))));
    expect(second).toBe(first);
  });

  it("復元した state は元と等価(4 語の値・順序とも)", () => {
    let state = baseState();
    state = setRngState(state, DOMAIN_TAGS.exploration, S2);
    const restored = roundTrip(state);
    expect(restored).toEqual(state);
    expect(getRngState(restored, DOMAIN_TAGS.exploration)).toEqual([0, 4294967295, 2147483648, 42]);
  });

  it("入力の rngState のキー順が違っても同じ state になる", () => {
    let state = baseState();
    state = setRngState(state, DOMAIN_TAGS.adjacency, S1);
    state = setRngState(state, DOMAIN_TAGS.recallDuration, S2);
    const canonical = JSON.stringify(toSerializable(state));
    const shuffled = {
      ...(JSON.parse(canonical) as Record<string, unknown>),
      rngState: { recallDuration: [...S2], adjacency: [...S1] },
    };
    expect(JSON.stringify(toSerializable(fromSerializable(shuffled)))).toBe(canonical);
  });

  it("rngState キーが無い旧セーブをそのままロードできる(ADR 3軸(b) additive)", () => {
    const legacy = {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 7,
      entityStateById: {
        wStock: { kind: "resource", id: "wStock", resourceId: "wood", stock: 3_000_000 },
      },
    };
    const state = fromSerializable(legacy);
    expect(state.rngState.size).toBe(0);
    expect(state.tick).toBe(7);
  });
});

describe("壊れた rngState の拒否", () => {
  function withRngState(value: unknown): unknown {
    return {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 0,
      entityStateById: {},
      rngState: value,
    };
  }

  // [M66] 旧版はここで "raid" を未登録タグの例に使っていたが、M66 で襲撃の
  // seededRoll 用に "raid" が**実際に登録された**ため未登録の例を差し替えた
  // (主張「レジストリ外の domainTag はセーブから復元できない」は不変)。
  it("レジストリ外の domainTag", () => {
    expect(() => fromSerializable(withRngState({ siege: [1, 2, 3, 4] }))).toThrow(SerializeError);
    expect(isDomainTag("siege")).toBe(false);
  });

  it("4 語でない配列", () => {
    expect(() => fromSerializable(withRngState({ adjacency: [1, 2, 3] }))).toThrow(SerializeError);
    expect(() => fromSerializable(withRngState({ adjacency: [1, 2, 3, 4, 5] }))).toThrow(
      SerializeError,
    );
    expect(() => fromSerializable(withRngState({ adjacency: 1 }))).toThrow(SerializeError);
  });

  it("uint32 の範囲外・非整数", () => {
    expect(() => fromSerializable(withRngState({ adjacency: [-1, 0, 0, 0] }))).toThrow(
      SerializeError,
    );
    expect(() => fromSerializable(withRngState({ adjacency: [4294967296, 0, 0, 0] }))).toThrow(
      SerializeError,
    );
    expect(() => fromSerializable(withRngState({ adjacency: [1.5, 0, 0, 0] }))).toThrow(
      SerializeError,
    );
    expect(() => fromSerializable(withRngState({ adjacency: ["1", 0, 0, 0] }))).toThrow(
      SerializeError,
    );
  });

  it("オブジェクトでない rngState", () => {
    expect(() => fromSerializable(withRngState([]))).toThrow(SerializeError);
    expect(() => fromSerializable(withRngState(null))).toThrow(SerializeError);
  });

  it("エラーメッセージに JSON path が入る", () => {
    expect(() => fromSerializable(withRngState({ adjacency: [-1, 0, 0, 0] }))).toThrow(
      /\$\.rngState\.adjacency\[0\]/,
    );
  });
});

describe("domainTags レジストリ(T5 で追加した分)", () => {
  it("T5 が使う 3 タグ + exploration が登録されている", () => {
    expect(DOMAIN_TAGS.adjacency).toBe("adjacency");
    expect(DOMAIN_TAGS.exploration).toBe("exploration");
    expect(DOMAIN_TAGS.recall).toBe("recall");
    expect(DOMAIN_TAGS.recallDuration).toBe("recallDuration");
  });

  it("isDomainTag は登録済みのみ true", () => {
    for (const tag of ["adjacency", "exploration", "recall", "recallDuration"]) {
      expect(isDomainTag(tag)).toBe(true);
    }
    // [M66] "raid" は登録済みになったので未登録側の例から外す(上記と同じ理由)。
    for (const tag of ["production", "research", "siege", "Recall", ""]) {
      expect(isDomainTag(tag)).toBe(false);
    }
  });
});
