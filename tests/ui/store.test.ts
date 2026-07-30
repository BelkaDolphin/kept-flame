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
import { apply } from "../../src/engine/commands";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "../../src/platform/catchUp";
import { toSerializable } from "../../src/engine/state/serialize";
import { getEntity, requireEntity } from "../../src/engine/state/state";
import { StoreError, createGameStore, type StoreEvent } from "../../src/ui/store";
import { StoreSourceError } from "../../src/ui/sources";
import {
  CELL_CENTER,
  CELL_EAST,
  CELL_FAR,
  CELL_SOUTHEAST,
  HEARTH,
  SMELTER,
  at,
  boardContent,
  boardState,
  createTestStore,
  facility,
  id,
  placeHearth,
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

describe("commandApplied(engine コマンド層の単一入口・M49)", () => {
  it("engine が作った state を複製せずそのまま据える(ADR-028 の複製経路を増やさない)", () => {
    const { store } = createTestStore();
    const result = store.dispatch({
      type: "commandApplied",
      command: placeHearth("fSouth", CELL_SOUTHEAST),
    });
    expect(result.command?.ok).toBe(true);
    // 参照同一 = ストア側にコピーが 1 箇所も無いことの直接証拠。
    if (result.command?.ok === true) expect(store.peekState()).toBe(result.command.state);
  });

  it("配置が変わったときだけ AdvanceContext を作り直す", () => {
    const { store } = createTestStore();
    const buildsBefore = store.stats().advanceContextBuildCount;

    const noPlacementChange = store.dispatch({
      type: "commandApplied",
      command: { kind: "upgradeFacility", facilityId: id("fHearth") },
    });
    expect(noPlacementChange.changedPlacementCells).toEqual([]);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore);

    const placementChange = store.dispatch({
      type: "commandApplied",
      command: placeHearth("fSouth", CELL_SOUTHEAST),
    });
    expect(placementChange.changedPlacementCells).toEqual([CELL_SOUTHEAST]);
    expect(placementChange.advanceContextRebuilt).toBe(true);
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore + 1);
  });

  it("拒否されたコマンドは例外にならず、state も signal も 1 つも動かない", () => {
    const { store } = createTestStore();
    const before = store.peekState();
    const stateInstallsBefore = store.stats().stateInstallCount;

    // セル 14 は fHearth が建っている(GDD 6.1: 1 セル = 1 施設)。
    const result = store.dispatch({
      type: "commandApplied",
      command: placeHearth("fBlocked", CELL_CENTER),
    });

    expect(result.command?.ok).toBe(false);
    if (result.command?.ok === false) {
      expect(result.command.rejection.code).toBe("cellOccupied");
      expect(result.command.rejection.cellIndex).toBe(CELL_CENTER);
    }
    expect(result.stateChanged).toBe(false);
    expect(store.peekState()).toBe(before);
    expect(store.stats().stateInstallCount).toBe(stateInstallsBefore);
  });

  it("列コマンドは 1 dispatch で原子適用される(途中の state を誰にも見せない)", () => {
    const { store } = createTestStore();
    const seen: number[] = [];
    const mount = store.mountScreen("grid");
    mount.scope.effect(() => {
      seen.push(store.derived.gridSummary.value.occupiedCellCount);
    });

    const result = store.dispatch({
      type: "commandApplied",
      command: [placeHearth("fSouth", CELL_SOUTHEAST), placeHearth("fWest", 13)],
    });

    expect(result.command?.ok).toBe(true);
    if (result.command?.ok === true) expect(result.command.commandCount).toBe(2);
    // 初回 + 1 回の再評価だけ(3 → 5 に 1 手で飛ぶ)。
    expect(seen).toEqual([3, 5]);
    mount.dispose();
  });

  it("列の途中で拒否されたら全部捨てる(部分適用しない)", () => {
    const { store } = createTestStore();
    const before = store.peekState();

    const result = store.dispatch({
      type: "commandApplied",
      command: [placeHearth("fSouth", CELL_SOUTHEAST), placeHearth("fBad", CELL_CENTER)],
    });

    expect(result.command?.ok).toBe(false);
    if (result.command?.ok === false) expect(result.command.rejection.commandIndex).toBe(1);
    expect(store.peekState()).toBe(before);
    expect(getEntity(store.peekState(), id("fSouth"))).toBeUndefined();
  });

  it("tick は動かさない(コマンドは現在 tick の状態遷移)", () => {
    const { store } = createTestStore();
    store.dispatch({ type: "ticked", toTick: 10 });
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    expect(store.peekState().tick).toBe(10);
  });

  it("撤去した stateApplied は語彙外として弾かれる(暫定口が復活していない)", () => {
    const { store, state } = createTestStore();
    expect(() =>
      store.dispatch({ type: "stateApplied", state, reason: "test" } as unknown as StoreEvent),
    ).toThrow(StoreError);
  });

  it("ストアは判定を持たない(dispatch の結果が engine の apply と同一)", () => {
    const { store, state, content } = createTestStore();
    const command = placeHearth("fBlocked", CELL_CENTER);
    const direct = apply(state, content, command);
    const viaStore = store.dispatch({ type: "commandApplied", command });
    expect(viaStore.command).toEqual(direct);
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

  it("[M18・★裁定] 大型施設の非アンカーセルを選択するとアンカーへ正規化される", () => {
    // セル 30(x0,y5)にアンカーを置いた 2×1(横長)の製錬炉。占有は 30 と 31。
    const { store } = createTestStore([
      facility("fBig", SMELTER.id, 30, [], 1, { width: 2, height: 1 }),
    ]);

    store.dispatch({ type: "cellSelected", cellIndex: 31 });
    expect(store.sources.selectedCellIndex.peek()).toBe(30);

    // アンカー自身を選択しても当然そのまま。
    store.dispatch({ type: "cellSelected", cellIndex: 30 });
    expect(store.sources.selectedCellIndex.peek()).toBe(30);

    // 空きセルの選択は正規化されず、そのまま。
    store.dispatch({ type: "cellSelected", cellIndex: CELL_FAR });
    expect(store.sources.selectedCellIndex.peek()).toBe(CELL_FAR);
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
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    const after = store.stats();
    expect(after.dispatchCount).toBe(before.dispatchCount + 2);
    expect(after.placementChangeCount).toBe(before.placementChangeCount + 1);
    expect(after.stateInstallCount).toBe(before.stateInstallCount + 2);
  });
});
