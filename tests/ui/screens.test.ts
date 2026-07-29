// ---------------------------------------------------------------------------
// 画面 ID の語彙(src/ui/screens.ts)と画面マウント(store.mountScreen)のテスト。
//
// ADR-027 の要点を固定する:
//   (2) 非アクティブ画面は物理アンマウントし、その画面の computed 購読を解除する
//   (3) 単一 GameState signal は常駐し、購読するのはマウント中画面だけ
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { ReactiveError } from "../../src/ui/reactive";
import {
  DEFAULT_SCREEN_ID,
  NUMBERED_SCREEN_COUNT,
  RETURN_DIGEST_SCREEN_ID,
  SCREEN_IDS,
  SCREEN_META,
  isScreenId,
} from "../../src/ui/screens";
import { CELL_CENTER, CELL_SOUTHEAST, at, createTestStore, placeHearth } from "./fixtures";

describe("画面 ID の語彙(GDD 6.6)", () => {
  it("①〜⑫ + セーブ/設定 の 13 マウント単位を持つ", () => {
    expect(SCREEN_IDS).toHaveLength(NUMBERED_SCREEN_COUNT + 1);
    const numbered = SCREEN_IDS.filter((id) => SCREEN_META[id].order !== null);
    expect(numbered).toHaveLength(NUMBERED_SCREEN_COUNT);
  });

  it("丸数字の順番が 1〜12 で重複なく並ぶ", () => {
    const orders = SCREEN_IDS.map((id) => SCREEN_META[id].order).filter(
      (order): order is number => order !== null,
    );
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("メタ情報の id が自分自身のキーと一致する", () => {
    for (const id of SCREEN_IDS) {
      expect(SCREEN_META[id].id).toBe(id);
      expect(SCREEN_META[id].label.length).toBeGreaterThan(0);
    }
  });

  it("未知の文字列は画面 ID として弾く(ハッシュ文字列の検証に使う)", () => {
    expect(isScreenId("home")).toBe(true);
    expect(isScreenId("digest")).toBe(true);
    expect(isScreenId("nope")).toBe(false);
    expect(isScreenId("")).toBe(false);
  });

  it("既定の現在地はホームハブ、復帰専用は帰還ダイジェスト", () => {
    expect(DEFAULT_SCREEN_ID).toBe("home");
    expect(RETURN_DIGEST_SCREEN_ID).toBe("digest");
    expect(SCREEN_META[RETURN_DIGEST_SCREEN_ID].order).toBe(12);
  });
});

describe("画面のマウント/アンマウント(ADR-027)", () => {
  it("マウントで現在画面が切り替わる(activate:false なら切り替えない)", () => {
    const { store } = createTestStore();
    const grid = store.mountScreen("grid");
    expect(store.sources.activeScreen.peek()).toBe("grid");

    const shell = store.mountScreen("settings", { activate: false });
    expect(store.sources.activeScreen.peek()).toBe("grid");
    expect(store.mountedScreenIds()).toEqual(["grid", "settings"]);

    grid.dispose();
    shell.dispose();
    expect(store.mountedScreenIds()).toEqual([]);
  });

  it("アンマウントすると、その画面の購読は二度と走らない", () => {
    const { store } = createTestStore();
    const mount = store.mountScreen("grid");
    let renders = 0;
    mount.scope.effect(() => {
      void at(store.derived.cellView, CELL_CENTER).value;
      renders++;
    });
    expect(renders).toBe(1);

    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    expect(renders).toBe(2);

    mount.dispose();
    store.dispatch({ type: "ticked", toTick: 10 });
    store.dispatch({ type: "commandApplied", command: placeHearth("fWest", 13) });
    expect(renders).toBe(2);
  });

  it("画面ローカル computed は dispose で無効になる(寿命を隠さない)", () => {
    const { store } = createTestStore();
    const mount = store.mountScreen("residents");
    const localView = mount.scope.computed(() => store.derived.residents.value.length);
    expect(localView.value).toBe(1);
    mount.dispose();
    expect(() => localView.value).toThrow(ReactiveError);
  });

  it("画面遷移でストアも共有派生値も作り直されない(ADR-027(3))", () => {
    const { store } = createTestStore();
    const sharedCell = at(store.derived.cellView, CELL_CENTER);
    const first = store.mountScreen("grid");
    void sharedCell.value;
    const recomputesAfterFirstRead = sharedCell.recomputeCount;
    first.dispose();

    const second = store.mountScreen("facility");
    // 同じインスタンスが生き残っており、再マウントで再計算も起きない。
    expect(at(store.derived.cellView, CELL_CENTER)).toBe(sharedCell);
    expect(sharedCell.value.facilityId).not.toBeNull();
    expect(sharedCell.recomputeCount).toBe(recomputesAfterFirstRead);
    second.dispose();
  });

  it("12画面 + 設定を順に開いて閉じてもストアは 1 個のまま", () => {
    const { store } = createTestStore();
    const stateBefore = store.peekState();
    for (const screenId of SCREEN_IDS) {
      const mount = store.mountScreen(screenId);
      expect(store.sources.activeScreen.peek()).toBe(screenId);
      mount.scope.effect(() => {
        void store.derived.homeBadges.value;
      });
      mount.dispose();
    }
    expect(store.mountedScreenIds()).toEqual([]);
    expect(store.peekState()).toBe(stateBefore);
    expect(store.stats().mountedScreenCount).toBe(0);
  });

  it("二重 dispose は無害", () => {
    const { store } = createTestStore();
    const mount = store.mountScreen("home");
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
    expect(store.mountedScreenIds()).toEqual([]);
  });
});
