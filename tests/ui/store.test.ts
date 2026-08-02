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

import { TICK_MS, advance, createAdvanceContext } from "../../src/engine/advance";
import { apply } from "../../src/engine/commands";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "../../src/platform/catchUp";
import { createTickDriver, type MonotonicClock } from "../../src/platform/clock";
import { SaveScheduler } from "../../src/platform/saveScheduler";
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

// ---------------------------------------------------------------------------
// [M62/FC2] onCommandApplied: セーブの操作トリガ結線(R2-FC2)
//
// プレイテスト Round 2 で発見: `SaveScheduler.recordCommandOutcome` が
// どこからも呼ばれておらず(main.tsx のコメントが自認していた既知ギャップ・
// M54 発見)、×1 では最大 15 秒(絶対フラッシュの締切)ぶんの操作が黙って
// 失われうる窓があった。`onWorldLoaded`(R1 fatal の修正で導入済み)と同じ
// 「唯一の書き込み口 dispatch の中で 1 本通知する」設計を踏襲する
// (画面ごとの呼び忘れが構造的に起きない)。ここではストア単体で
// 「コマンド成功 → 通知が発火する」を固定する(main.tsx 自体は composition
// root でブラウザでしか動かないためテスト対象外・ファイル冒頭コメントどおり)。
// ---------------------------------------------------------------------------
describe("[M62/FC2] onCommandApplied 通知(セーブの操作トリガ結線・R2-FC2)", () => {
  it("コマンド成功で 1 回だけ通知され、engine の CommandResult がそのまま渡る", () => {
    const state = boardState();
    const content = boardContent();
    const notified: unknown[] = [];
    const store = createGameStore({
      state,
      content,
      onCommandApplied: (result) => {
        notified.push(result);
      },
    });

    const command = placeHearth("fSouth", CELL_SOUTHEAST);
    const result = store.dispatch({ type: "commandApplied", command });

    expect(notified).toHaveLength(1);
    expect(notified[0]).toEqual(result.command);
    expect((notified[0] as { readonly ok: boolean }).ok).toBe(true);
  });

  it("拒否されたコマンドでも通知は発火する(recordCommandOutcome 側で弾く設計・§ doc)", () => {
    const state = boardState();
    const content = boardContent();
    const notified: unknown[] = [];
    const store = createGameStore({
      state,
      content,
      onCommandApplied: (result) => {
        notified.push(result);
      },
    });

    // セル 14 は既に fHearth が建っている(GDD 6.1: 1 セル = 1 施設)。
    store.dispatch({ type: "commandApplied", command: placeHearth("fBlocked", CELL_CENTER) });

    expect(notified).toHaveLength(1);
    expect((notified[0] as { readonly ok: boolean }).ok).toBe(false);
  });

  it("commandApplied 以外のイベントでは呼ばれない", () => {
    const state = boardState();
    const content = boardContent();
    let calls = 0;
    const store = createGameStore({
      state,
      content,
      onCommandApplied: () => {
        calls++;
      },
    });

    store.dispatch({ type: "ticked", toTick: 10 });
    store.dispatch({ type: "cellSelected", cellIndex: CELL_CENTER });
    expect(calls).toBe(0);
  });

  it("列コマンド(原子適用)でも 1 dispatch = 1 回の通知(commandCount は engine 側が持つ)", () => {
    const state = boardState();
    const content = boardContent();
    const notified: unknown[] = [];
    const store = createGameStore({
      state,
      content,
      onCommandApplied: (result) => {
        notified.push(result);
      },
    });

    store.dispatch({
      type: "commandApplied",
      command: [placeHearth("fSouth", CELL_SOUTHEAST), placeHearth("fWest", 13)],
    });

    expect(notified).toHaveLength(1);
    expect((notified[0] as { readonly ok: boolean; readonly commandCount?: number }).ok).toBe(true);
    expect(
      (notified[0] as { readonly ok: boolean; readonly commandCount?: number }).commandCount,
    ).toBe(2);
  });

  it("onCommandApplied を渡さなくても動く(既存呼び出し互換)", () => {
    const { store } = createTestStore();
    expect(() =>
      store.dispatch({
        type: "commandApplied",
        command: placeHearth("fSouth", CELL_SOUTHEAST),
      }),
    ).not.toThrow();
  });

  it("main.tsx と同じ配線(scheduler.recordCommandOutcome)でコマンド成功が実際にセーブを dirty にする", () => {
    // `src/main.tsx` の `onCommandApplied: (result) => scheduler?.recordCommandOutcome(result)`
    // を実物の SaveScheduler で再現する(composition root 自体はブラウザでしか
    // 動かないため、ここが「トリガ発火」を固定する実質的なテストになる)。
    const state = boardState();
    const content = boardContent();
    let writeCount = 0;
    const scheduler = new SaveScheduler({
      write: () => {
        writeCount++;
        return Promise.resolve();
      },
    });
    const store = createGameStore({
      state,
      content,
      onCommandApplied: (result) => {
        scheduler.recordCommandOutcome(result);
      },
    });

    expect(scheduler.isDirty).toBe(false);
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    expect(scheduler.isDirty).toBe(true);
    expect(scheduler.pendingCommandCount).toBe(1);
    expect(writeCount).toBe(0); // デバウンス前(まだ書いていない)。

    // 拒否は数えない(§ recordCommandOutcome の契約どおり・pendingCommands 不変)。
    store.dispatch({ type: "commandApplied", command: placeHearth("fBlocked", CELL_CENTER) });
    expect(scheduler.pendingCommandCount).toBe(1);

    scheduler.dispose();
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

// ---------------------------------------------------------------------------
// [R1-A01/A02] 世界の入れ替え(worldLoaded)の外部通知と tick 駆動の結線
//
// AIプレイテスト Round 1 の fatal 2 件:
//   A01 ×720 で長く進めた後に過去のセーブをインポートすると、以後ゲーム内時刻が
//       永久に止まる(StoreError「tick 差 698 は前景経路の上限 600 を超える」)。
//   A02 「最初からやり直す」でも同じ(tick 差 4901)。
// 原因は「state を丸ごと差し替えたのに tick 駆動のアンカーを引き直していない」
// ことだった(store.ts §5 / clock.ts §6)。ここでは `src/main.tsx` と同じ形に
// 結線したうえで、入れ替え後も前景 tick が進み続けることを固定する。
// ---------------------------------------------------------------------------

describe("[R1-A01/A02] worldLoaded の通知と tick 駆動の再アンカー", () => {
  function fakeClock(): MonotonicClock & { advance(ms: number): void } {
    let now = 0;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  /**
   * `src/main.tsx` と同じ形にストアと tick driver を繋ぐ。
   *
   * `reanchor: false` は**修正前の結線**(通知を受けても `syncTo` を呼ばない)の
   * 再現であり、世界を入れ替えると次の pump がストア例外で落ちる = 何が壊れて
   * いたのかをテストの中に残しておくために使う。
   */
  function wireLikeMain(reanchor: boolean) {
    const clock = fakeClock();
    const swaps: number[] = [];
    const store = createGameStore({
      state: boardState([], { tick: 0 }),
      content: boardContent(),
      onWorldLoaded: (next) => {
        swaps.push(next.tick);
        if (reanchor) driver.syncTo(next.tick);
      },
    });
    const driver = createTickDriver({
      startTick: store.peekState().tick,
      clock,
      onAdvance: (toTick) => {
        store.dispatch({ type: "ticked", toTick });
      },
      // 駆動源は自前で回す(このテストは実タイマを 1 つも使わない)。
      schedule: () => () => undefined,
    });
    return { clock, store, driver, swaps };
  }

  /** 前景経路の上限(600 tick)を超えないように刻んで `toTick` まで進める。 */
  function playForward(
    wiring: ReturnType<typeof wireLikeMain>,
    tickCount: number,
    stepTicks = LIVE_ADVANCE_MAX_TICK_DELTA / 2,
  ): void {
    for (let done = 0; done < tickCount; done += stepTicks) {
      wiring.clock.advance(Math.min(stepTicks, tickCount - done) * TICK_MS);
      wiring.driver.pump();
    }
  }

  it("worldLoaded は「据えた後の state」で 1 回だけ通知する", () => {
    const { store, swaps } = wireLikeMain(true);
    store.dispatch({
      type: "worldLoaded",
      state: boardState([], { tick: 123 }),
      content: boardContent(),
      source: "import",
    });
    expect(swaps).toEqual([123]);
    expect(store.peekState().tick).toBe(123);
  });

  it("世界を入れ替えない他のイベントでは通知しない", () => {
    const wiring = wireLikeMain(true);
    playForward(wiring, 3);
    wiring.store.dispatch({
      type: "commandApplied",
      command: placeHearth("fSouth", CELL_SOUTHEAST),
    });
    wiring.store.dispatch({ type: "cellSelected", cellIndex: 1 });
    wiring.store.dispatch({ type: "screenOpened", screen: "settings" });
    expect(wiring.swaps).toEqual([]);
  });

  it("11 ゲーム時間前のセーブをインポートしても、以後の tick が進み続ける(A01)", () => {
    const wiring = wireLikeMain(true);
    playForward(wiring, 700);
    expect(wiring.store.peekState().tick).toBe(700);

    // 660 tick(11 ゲーム時間)前のセーブ = 修正前に 698 差で凍結した状況。
    wiring.store.dispatch({
      type: "worldLoaded",
      state: boardState([], { tick: 40 }),
      content: boardContent(),
      source: "import",
    });
    expect(wiring.store.peekState().tick).toBe(40);

    // 以後の前景 advance は**新しい世界の tick 基準**で進む。
    wiring.clock.advance(2 * TICK_MS);
    expect(() => wiring.driver.pump()).not.toThrow();
    expect(wiring.store.peekState().tick).toBe(42);
    expect(wiring.driver.anchor().anchorTick).toBe(42);
  });

  it("「最初からやり直す」(tick 0 の新規世界)でも時刻が進む(A02)", () => {
    const wiring = wireLikeMain(true);
    playForward(wiring, 4901);
    expect(wiring.store.peekState().tick).toBe(4901);

    wiring.store.dispatch({
      type: "worldLoaded",
      state: boardState([], { tick: 0 }),
      content: boardContent(),
      source: "newGame",
    });
    wiring.clock.advance(5 * TICK_MS);
    expect(() => wiring.driver.pump()).not.toThrow();
    expect(wiring.store.peekState().tick).toBe(5);
  });

  it("再アンカーしないと次の pump がストア例外で落ちる(修正前の挙動の固定)", () => {
    const wiring = wireLikeMain(false);
    playForward(wiring, 700);
    wiring.store.dispatch({
      type: "worldLoaded",
      state: boardState([], { tick: 40 }),
      content: boardContent(),
      source: "import",
    });
    wiring.clock.advance(2 * TICK_MS);
    expect(() => wiring.driver.pump()).toThrow(StoreError);
  });
});
