// ---------------------------------------------------------------------------
// src/platform/router.ts のテスト(M29)— ADR-027(1)
//
// ルータは `location` を直接掴まない({@link RouterHost} 経由)ので、
// jsdom 無し(`environment: "node"`)でも**実際に動くコードそのもの**を検証できる。
// ここで固定するのは:
//   1. ハッシュ ⇄ ルート ID の純関数(スラッシュ有無・語彙外・空)
//   2. 構築時に URL が正準形へ揃うこと
//   3. 外から hash が変わったとき(戻る/手打ち)の追随と、語彙外での fallback
//   4. 語彙は引数で渡す = platform が ui の語彙を知らない(architecture.md §1)
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
  RouterError,
  createHashRouter,
  parseRouteHash,
  routeHash,
  type RouterHost,
} from "../../src/platform/router";
import { DEFAULT_SCREEN_ID, SCREEN_IDS, type ScreenId } from "../../src/ui/screens";

/** `location.hash` の代わり。`setHash`/`replaceHash` は hashchange を模して通知する。 */
function fakeHost(initialHash = ""): RouterHost & {
  hash: string;
  readonly replaceCalls: string[];
  external(hash: string): void;
} {
  let hash = initialHash;
  const listeners = new Set<() => void>();
  const replaceCalls: string[] = [];
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get hash() {
      return hash;
    },
    set hash(next: string) {
      hash = next;
    },
    replaceCalls,
    getHash: () => hash,
    setHash: (next) => {
      hash = next;
      notify();
    },
    replaceHash: (next) => {
      replaceCalls.push(next);
      hash = next;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** ブラウザの「戻る」や URL 手打ち相当(ルータ経由でない変更)。 */
    external: (next: string) => {
      hash = next;
      notify();
    },
  };
}

describe("parseRouteHash / routeHash(純関数)", () => {
  it("正準形・スラッシュ無し・`#` 無しのいずれも受理する", () => {
    expect(parseRouteHash("#/grid", SCREEN_IDS)).toBe("grid");
    expect(parseRouteHash("#grid", SCREEN_IDS)).toBe("grid");
    expect(parseRouteHash("grid", SCREEN_IDS)).toBe("grid");
  });

  it("空・語彙外は null(呼び出し側が fallback へ倒す)", () => {
    expect(parseRouteHash("", SCREEN_IDS)).toBeNull();
    expect(parseRouteHash("#", SCREEN_IDS)).toBeNull();
    expect(parseRouteHash("#/", SCREEN_IDS)).toBeNull();
    expect(parseRouteHash("#/unknown", SCREEN_IDS)).toBeNull();
    expect(parseRouteHash("#/GRID", SCREEN_IDS)).toBeNull();
  });

  it("12画面 + 設定の全 ID が往復する", () => {
    for (const id of SCREEN_IDS) {
      expect(parseRouteHash(routeHash(id), SCREEN_IDS)).toBe(id);
    }
  });
});

describe("createHashRouter", () => {
  it("ハッシュが空なら fallback を開き、URL を正準形へ書き直す(履歴は汚さない)", () => {
    const host = fakeHost("");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    expect(router.current()).toBe("home");
    expect(host.getHash()).toBe("#/home");
    expect(host.replaceCalls).toEqual(["#/home"]);
  });

  it("ハッシュが既にあれば URL が勝つ(initial より優先・リロードで画面が飛ばない)", () => {
    const host = fakeHost("#/grid");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
      initial: "digest",
    });
    expect(router.current()).toBe("grid");
    expect(host.replaceCalls).toEqual([]);
  });

  it("ハッシュが無いときだけ initial が効く(復帰時の⑫帰還ダイジェスト)", () => {
    const host = fakeHost("");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
      initial: "digest",
    });
    expect(router.current()).toBe("digest");
    expect(host.getHash()).toBe("#/digest");
  });

  it("スラッシュ無しの手打ちは正準形へ書き直される", () => {
    const host = fakeHost("#codify");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    expect(router.current()).toBe("codify");
    expect(host.getHash()).toBe("#/codify");
  });

  it("navigate は URL を書き、購読者へ 1 回だけ通知する", () => {
    const host = fakeHost("#/home");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    const listener = vi.fn();
    router.subscribe(listener);

    router.navigate("residents");
    expect(router.current()).toBe("residents");
    expect(host.getHash()).toBe("#/residents");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("residents");

    // 同じ画面への navigate は何も起こさない。
    router.navigate("residents");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("外から hash が変わったら(戻る・手打ち)追随する", () => {
    const host = fakeHost("#/home");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    const seen: ScreenId[] = [];
    router.subscribe((screen) => seen.push(screen));

    host.external("#/expedition");
    expect(router.current()).toBe("expedition");
    expect(seen).toEqual(["expedition"]);
  });

  it("外から語彙外へ飛ばされたら fallback へ倒し URL も戻す", () => {
    const host = fakeHost("#/home");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    router.navigate("grid");
    host.external("#/nowhere");
    expect(router.current()).toBe("home");
    expect(host.getHash()).toBe("#/home");
  });

  it("dispose 後はホストの購読が切れ、操作は例外になる", () => {
    const host = fakeHost("#/home");
    const router = createHashRouter<ScreenId>(host, {
      routes: SCREEN_IDS,
      fallback: DEFAULT_SCREEN_ID,
    });
    router.dispose();
    host.external("#/grid");
    expect(router.current()).toBe("home");
    expect(() => router.navigate("grid")).toThrow(RouterError);
  });

  it("語彙・fallback・initial の不整合は構築時に落とす", () => {
    const host = fakeHost("");
    expect(() => createHashRouter(host, { routes: [], fallback: "home" })).toThrow(RouterError);
    expect(() => createHashRouter(host, { routes: ["home"], fallback: "grid" })).toThrow(
      RouterError,
    );
    expect(() =>
      createHashRouter(host, { routes: ["home"], fallback: "home", initial: "grid" }),
    ).toThrow(RouterError);
  });
});
