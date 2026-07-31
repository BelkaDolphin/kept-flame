// ---------------------------------------------------------------------------
// src/ui/shellSession.ts のテスト(M29)
//
// **M29 の検収条件「画面遷移でストアが再生成されないテスト」の本体**である。
//
// アプリシェルの結線(ルータ ⇄ ストア)は Preact に一切依存しないので、
// jsdom 無しでも**本番と同じコード**を走らせて検証できる。ここで固定するのは:
//
//   1. 12画面 + 設定を何周しても **ストアの同一性が保たれる**(参照も、内部の
//      GameState / content / AdvanceContext も、engine の再計算回数も動かない)
//   2. 現在地の権威はルータであり、ストアの `activeScreen` はその写しであること
//   3. 画面のマウント/アンマウント(ADR-027(2))で購読が確実に切れること
//   4. 画面側が `{ activate: false }` でマウントしても現在地が壊れないこと
//      (M18★5 への回答 = 権威をルータ 1 箇所へ寄せた形)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { createHashRouter, type RouterHost } from "../../src/platform/router";
import { SCREEN_IDS, type ScreenId } from "../../src/ui/screens";
import { createShellSession } from "../../src/ui/shellSession";
import type { GameStore } from "../../src/ui/store";
import { createTestStore, primeAllCells, recomputeCounts } from "./fixtures";

function fakeHost(initialHash = ""): RouterHost {
  let hash = initialHash;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getHash: () => hash,
    setHash: (next) => {
      hash = next;
      notify();
    },
    replaceHash: (next) => {
      hash = next;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function setup(initialHash = ""): {
  readonly store: GameStore;
  readonly session: ReturnType<typeof createShellSession>;
} {
  const { store } = createTestStore();
  const router = createHashRouter<ScreenId>(fakeHost(initialHash), {
    routes: SCREEN_IDS,
    fallback: "home",
  });
  return { store, session: createShellSession({ store, router }) };
}

describe("createShellSession(画面遷移でストアが再生成されない)", () => {
  it("12画面 + 設定を 2 周しても GameState / content / AdvanceContext の参照が動かない", () => {
    const { store, session } = setup();
    const stateBefore = store.peekState();
    const contentBefore = store.peekContent();
    const contextBefore = store.peekAdvanceContext();
    const statsBefore = store.stats();

    for (let round = 0; round < 2; round++) {
      for (const screenId of SCREEN_IDS) {
        session.navigate(screenId);
        expect(session.screen()).toBe(screenId);
      }
    }

    // ストアそのものが同一(そもそも session は createGameStore を呼ばない)。
    expect(store.peekState()).toBe(stateBefore);
    expect(store.peekContent()).toBe(contentBefore);
    expect(store.peekAdvanceContext()).toBe(contextBefore);

    const statsAfter = store.stats();
    // engine の precompute(createAdvanceContext)は 1 度も再実行されない。
    expect(statsAfter.advanceContextBuildCount).toBe(statsBefore.advanceContextBuildCount);
    expect(statsAfter.advanceContextRestoreCount).toBe(statsBefore.advanceContextRestoreCount);
    // state signal の差し替えも 1 度も起きない。
    expect(statsAfter.stateInstallCount).toBe(statsBefore.stateInstallCount);
    expect(statsAfter.placementChangeCount).toBe(statsBefore.placementChangeCount);
  });

  it("画面遷移では 48 セルの派生値が 1 個も再計算されない", () => {
    const { store, session } = setup();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellView);
    const adjacencyBefore = recomputeCounts(store.derived.cellAdjacency);

    for (const screenId of SCREEN_IDS) session.navigate(screenId);

    expect(recomputeCounts(store.derived.cellView)).toEqual(before);
    expect(recomputeCounts(store.derived.cellAdjacency)).toEqual(adjacencyBefore);
  });

  it("現在地の権威はルータで、ストアの activeScreen はその写し", () => {
    const { store, session } = setup("#/grid");
    // 構築時点で 1 回だけ写される(初回描画の前に正しくなる)。
    expect(store.sources.activeScreen.peek()).toBe("grid");

    session.navigate("codify");
    expect(store.sources.activeScreen.peek()).toBe("codify");

    session.navigate("digest");
    expect(store.sources.activeScreen.peek()).toBe("digest");
  });

  it("購読者は遷移のたびに 1 回だけ通知される(同じ画面への遷移は通知しない)", () => {
    const { session } = setup("#/home");
    const seen: ScreenId[] = [];
    const unsubscribe = session.subscribe((screen) => seen.push(screen));

    session.navigate("grid");
    session.navigate("grid");
    session.navigate("home");
    expect(seen).toEqual(["grid", "home"]);

    unsubscribe();
    session.navigate("research");
    expect(seen).toEqual(["grid", "home"]);
  });

  it("dispose 後はルータが動いてもストアへ写さない", () => {
    const { store, session } = setup("#/home");
    session.dispose();
    session.navigate("grid");
    expect(store.sources.activeScreen.peek()).toBe("home");
  });
});

describe("画面のマウント(ADR-027(2))とシェルの権威分離(M18★5)", () => {
  it("`activate: false` でマウントしても現在地は動かない(権威はシェル)", () => {
    const { store } = setup("#/home");
    const mount = store.mountScreen("grid", { activate: false });
    expect(store.sources.activeScreen.peek()).toBe("home");
    expect(store.mountedScreenIds()).toContain("grid");
    mount.dispose();
  });

  it("アンマウントでその画面の購読が全部切れる(裏で評価され続けない)", () => {
    const { store } = setup();
    const mount = store.mountScreen("home", { activate: false });
    let runs = 0;
    mount.scope.effect(() => {
      void store.derived.homeAlerts.value;
      runs++;
    });
    expect(runs).toBe(1);

    // マウント中は state 変化に追随する。
    store.dispatch({ type: "ticked", toTick: store.peekState().tick + 1 });
    const runsWhileMounted = runs;

    mount.dispose();
    expect(mount.scope.isDisposed).toBe(true);
    store.dispatch({ type: "ticked", toTick: store.peekState().tick + 1 });
    expect(runs).toBe(runsWhileMounted);
    expect(store.mountedScreenIds()).not.toContain("home");
  });
});
