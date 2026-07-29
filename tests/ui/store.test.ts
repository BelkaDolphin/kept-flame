// ---------------------------------------------------------------------------
// 単一ストア(src/ui/store.ts)のテスト。
//
// 固定するのは 4 点:
//   (1) イベント語彙どおりに state が入れ替わること
//   (2) **ストアが state を複製しないこと**(ADR-028 の単一正準実装から外れた
//       複製経路を増やさない = M8 の検分条件)
//   (3) 長い catch-up をメインスレッドで走らせない(ADR-026(3)/ADR-019)
//   (4) AdvanceContext(engine の precompute)を配置変更時にしか作り直さない
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "../../src/platform/catchUp";
import { toSerializable } from "../../src/engine/state/serialize";
import { getEntity, requireEntity } from "../../src/engine/state/state";
import { putEntity, setField, updateEntity } from "../../src/engine/state/update";
import { StoreError, createGameStore } from "../../src/ui/store";
import { StoreSourceError } from "../../src/ui/sources";
import {
  CELL_CENTER,
  CELL_EAST,
  CELL_FAR,
  CELL_SOUTHEAST,
  HEARTH,
  at,
  boardContent,
  boardState,
  createTestStore,
  facility,
  id,
} from "./fixtures";

describe("ストアの初期化", () => {
  it("48 セルの根 signal が state から埋まる", () => {
    const { store } = createTestStore();
    expect(at(store.derived.cellView, CELL_CENTER).value.facilityId).toBe(id("fHearth"));
    expect(at(store.derived.cellView, CELL_EAST).value.occupied).toBe(true);
    expect(at(store.derived.cellView, CELL_FAR).value.occupied).toBe(true);
    expect(at(store.derived.cellView, CELL_SOUTHEAST).value.occupied).toBe(false);
    expect(store.derived.gridSummary.value.occupiedCellCount).toBe(3);
  });

  it("AdvanceContext は生成時に 1 回だけ作られる", () => {
    const { store } = createTestStore();
    expect(store.stats().advanceContextBuildCount).toBe(1);
    expect(store.stats().advanceContextRestoreCount).toBe(0);
  });

  it("転送済みコンテキストを渡すと engine の precompute を走らせない(復帰経路)", () => {
    const state = boardState();
    const content = boardContent();
    const ctx = createAdvanceContext(state, content);
    const store = createGameStore({
      state,
      content,
      advanceContext: {
        worldSeedU32: ctx.worldSeedU32,
        multiplierByFacilityId: ctx.multiplierByFacilityId,
      },
    });
    expect(store.stats().advanceContextBuildCount).toBe(0);
    expect(store.stats().advanceContextRestoreCount).toBe(1);
    expect(store.peekAdvanceContext().multiplierByFacilityId).toBe(ctx.multiplierByFacilityId);
  });

  it("1 セルに 2 施設ある state は据えずに止める(GDD 6.1)", () => {
    const broken = boardState([facility("fDup", HEARTH.id, CELL_CENTER)]);
    const content = boardContent();
    expect(() =>
      createGameStore({
        state: broken,
        content,
        // engine の precompute を迂回して同期の検査だけを踏ませる。
        advanceContext: { worldSeedU32: 1, multiplierByFacilityId: new Map() },
      }),
    ).toThrow(StoreSourceError);
  });
});

describe("ticked(フォアグラウンド tick 駆動・ADR-026)", () => {
  it("engine の advance と同じ結果になる", () => {
    const { store, state, content } = createTestStore();
    const expected = advance(state, createAdvanceContext(state, content), 60);

    store.dispatch({ type: "ticked", toTick: 60 });

    expect(store.peekState().tick).toBe(60);
    expect(JSON.stringify(toSerializable(store.peekState()))).toBe(
      JSON.stringify(toSerializable(expected)),
    );
  });

  it("同じ tick への dispatch は何もしない", () => {
    const { store } = createTestStore();
    const before = store.peekState();
    const result = store.dispatch({ type: "ticked", toTick: 0 });
    expect(result.stateChanged).toBe(false);
    expect(store.peekState()).toBe(before);
  });

  it("過去の tick は拒否する(巻き戻しは platform/clock.ts の担当)", () => {
    const { store } = createTestStore();
    store.dispatch({ type: "ticked", toTick: 10 });
    expect(() => store.dispatch({ type: "ticked", toTick: 9 })).toThrow(StoreError);
  });

  it("前景経路の上限を超える tick 差は Worker へ回すよう例外で促す(ADR-019/029)", () => {
    const { store } = createTestStore();
    expect(() =>
      store.dispatch({ type: "ticked", toTick: LIVE_ADVANCE_MAX_TICK_DELTA + 1 }),
    ).toThrow(/Worker/);
    // 上限ちょうどは通る。
    expect(() =>
      store.dispatch({ type: "ticked", toTick: LIVE_ADVANCE_MAX_TICK_DELTA }),
    ).not.toThrow();
  });

  it("構造共有が保たれる(変わっていない entity は参照同一・ADR-028)", () => {
    const { store } = createTestStore();
    const before = store.peekState();
    const facilityBefore = getEntity(before, id("fHearth"));
    store.dispatch({ type: "ticked", toTick: 30 });
    const after = store.peekState();

    expect(after).not.toBe(before);
    expect(getEntity(after, id("fHearth"))).toBe(facilityBefore);
    expect(requireEntity(after, id("wStock"), "resource")).not.toBe(
      requireEntity(before, id("wStock"), "resource"),
    );
  });
});

describe("catchUpApplied(Worker catch-up の完了・ADR-019/029)", () => {
  it("スナップショットを据え、メインでは engine を再計算しない", () => {
    const { store, state, content } = createTestStore();
    const ctx = createAdvanceContext(state, content);
    const snapshot = advance(state, ctx, 4320);
    const buildsBefore = store.stats().advanceContextBuildCount;

    const result = store.dispatch({
      type: "catchUpApplied",
      snapshot,
      advanceContext: {
        worldSeedU32: ctx.worldSeedU32,
        multiplierByFacilityId: ctx.multiplierByFacilityId,
      },
    });

    expect(result.advanceContextRestored).toBe(true);
    expect(result.advanceContextRebuilt).toBe(false);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore);
    expect(store.peekState()).toBe(snapshot);
    expect(store.derived.tick.value).toBe(4320);
  });

  it("現在より過去のスナップショットは拒否する(巻き戻し防止)", () => {
    const { store, state, content } = createTestStore();
    const ctx = createAdvanceContext(state, content);
    const snapshot = advance(state, ctx, 100);
    store.dispatch({
      type: "catchUpApplied",
      snapshot,
      advanceContext: {
        worldSeedU32: ctx.worldSeedU32,
        multiplierByFacilityId: ctx.multiplierByFacilityId,
      },
    });
    expect(() =>
      store.dispatch({
        type: "catchUpApplied",
        snapshot: state,
        advanceContext: {
          worldSeedU32: ctx.worldSeedU32,
          multiplierByFacilityId: ctx.multiplierByFacilityId,
        },
      }),
    ).toThrow(StoreError);
  });
});

describe("stateApplied(コマンド適用の暫定口)", () => {
  it("state を複製せずそのまま据える(ADR-028 の複製経路を増やさない)", () => {
    const { store, state } = createTestStore();
    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test" });
    // 参照同一 = ストア側にコピーが 1 箇所も無いことの直接証拠。
    expect(store.peekState()).toBe(next);
  });

  it("配置が変わったときだけ AdvanceContext を作り直す", () => {
    const { store, state } = createTestStore();
    const buildsBefore = store.stats().advanceContextBuildCount;

    const levelUp = updateEntity(state, id("fHearth"), "facility", (f) => setField(f, "level", 2));
    const noPlacementChange = store.dispatch({
      type: "stateApplied",
      state: levelUp,
      reason: "test: 増築",
    });
    expect(noPlacementChange.changedPlacementCells).toEqual([]);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore);

    const placed = putEntity(levelUp, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    const placementChange = store.dispatch({
      type: "stateApplied",
      state: placed,
      reason: "test: 設置",
    });
    expect(placementChange.changedPlacementCells).toEqual([CELL_SOUTHEAST]);
    expect(placementChange.advanceContextRebuilt).toBe(true);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore + 1);
  });

  it("別の世界(worldSeed / algoVersion 違い)は拒否する", () => {
    const { store } = createTestStore();
    expect(() =>
      store.dispatch({
        type: "stateApplied",
        state: boardState([], { worldSeed: "seedBeta" }),
        reason: "test",
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.dispatch({
        type: "stateApplied",
        state: boardState([], { algoVersion: 99 }),
        reason: "test",
      }),
    ).toThrow(StoreError);
  });

  it("過去の tick は拒否する", () => {
    const { store, state } = createTestStore();
    store.dispatch({ type: "ticked", toTick: 10 });
    expect(() => store.dispatch({ type: "stateApplied", state, reason: "test" })).toThrow(
      StoreError,
    );
  });
});

describe("worldLoaded / UI 状態のイベント", () => {
  it("世界を入れ替えると選択が解除され、コンテキストが作り直される", () => {
    const { store } = createTestStore();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_CENTER });
    const buildsBefore = store.stats().advanceContextBuildCount;

    const nextState = boardState([facility("fSouth", HEARTH.id, CELL_SOUTHEAST)]);
    const result = store.dispatch({
      type: "worldLoaded",
      state: nextState,
      content: boardContent(),
      source: "save",
    });

    expect(result.advanceContextRebuilt).toBe(true);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore + 1);
    expect(store.sources.selectedCellIndex.peek()).toBeNull();
    expect(at(store.derived.cellView, CELL_SOUTHEAST).value.occupied).toBe(true);
  });

  it("セル選択は格子の範囲を検査する", () => {
    const { store } = createTestStore();
    expect(() => store.dispatch({ type: "cellSelected", cellIndex: 48 })).toThrow(StoreError);
    expect(() => store.dispatch({ type: "cellSelected", cellIndex: -1 })).toThrow(StoreError);
    store.dispatch({ type: "cellSelected", cellIndex: 47 });
    expect(store.sources.selectedCellIndex.peek()).toBe(47);
  });

  it("画面遷移イベントは現在画面の写しを更新する(権威はルータ・ADR-027)", () => {
    const { store } = createTestStore();
    expect(store.sources.activeScreen.peek()).toBe("home");
    store.dispatch({ type: "screenOpened", screen: "digest" });
    expect(store.sources.activeScreen.peek()).toBe("digest");
  });
});

describe("診断カウンタ", () => {
  it("dispatch と配置変更の回数を数える", () => {
    const { store } = createTestStore();
    const before = store.stats();
    store.dispatch({ type: "ticked", toTick: 5 });
    store.dispatch({
      type: "stateApplied",
      state: putEntity(store.peekState(), facility("fSouth", HEARTH.id, CELL_SOUTHEAST)),
      reason: "test",
    });
    const after = store.stats();
    expect(after.dispatchCount).toBe(before.dispatchCount + 2);
    expect(after.placementChangeCount).toBe(before.placementChangeCount + 1);
    expect(after.stateInstallCount).toBe(before.stateInstallCount + 2);
  });
});
