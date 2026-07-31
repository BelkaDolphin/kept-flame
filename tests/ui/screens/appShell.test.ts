// ---------------------------------------------------------------------------
// アプリシェル(M29)の表示側テスト — ADR-027 / GDD 6.6
//
// `ScreenNav` / `ScreenHost` / レジストリは hooks を持たない純関数なので、
// Preact の render() を通さず直接呼んで vnode 構造を検証できる
// (vitest は `environment: "node"`・jsdom 無し = ADR-001。gridBoard.test.ts と同じ方針)。
//
// ここで固定するのは:
//   1. **12画面 + 設定の全件がルート登録されている**(タスク指示)
//   2. 未実装画面はプレースホルダで、担当タスク名がロードマップと一致する
//   3. `ScreenHost` が**現在画面 1 個ぶんしか vnode を作らない**
//      (= 非アクティブ画面は物理アンマウント・ADR-027(2))
//   4. ナビは全画面ぶんのボタンを出し、現在地に `aria-current="page"` を付ける
//   5. ゲーム内時計の整形が実時刻・ロケールに依存しない
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { ScreenHost, ScreenNav } from "../../../src/ui/AppShell";
import { NUMBERED_SCREEN_COUNT, SCREEN_IDS, SCREEN_META } from "../../../src/ui/screens";
import { HomeHub } from "../../../src/ui/screens/home/HomeHub";
import { PlaceholderScreen } from "../../../src/ui/screens/PlaceholderScreen";
import { ReturnDigest } from "../../../src/ui/screens/digest/ReturnDigest";
import { SCREEN_ENTRIES, SCREEN_REGISTRY } from "../../../src/ui/screens/registry";
import { formatGameClock, formatTickSpan } from "../../../src/ui/screens/format";
import type { GameStore } from "../../../src/ui/store";
import { createTestStore } from "../fixtures";

/** レンダリングされない props(vnode を作るだけなので store は触られない)。 */
function screenProps(store: GameStore) {
  return { store, bootTick: 0, onNavigate: () => undefined };
}

describe("画面レジストリ(12画面 + 設定の全件登録)", () => {
  it("SCREEN_IDS の全件が登録されており、順序は GDD 6.6 の表順", () => {
    expect(SCREEN_ENTRIES.map((entry) => entry.id)).toEqual([...SCREEN_IDS]);
    expect(SCREEN_IDS.length).toBe(NUMBERED_SCREEN_COUNT + 1); // ①〜⑫ + 設定
  });

  it("①ホームハブと⑫帰還ダイジェストは M29 実装(担当タスク無し)", () => {
    expect(SCREEN_REGISTRY.home.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.digest.ownerTask).toBeNull();
  });

  it("未実装画面の担当タスクはロードマップ(M30〜M33)と一致する", () => {
    const expected: Record<string, string> = {
      grid: "M30",
      facility: "M30",
      residents: "M30",
      research: "M31",
      codify: "M31",
      expedition: "M32",
      chronicle: "M32",
      outposts: "M32",
      migration: "M33",
      inheritance: "M33",
      settings: "M33",
    };
    for (const [screenId, task] of Object.entries(expected)) {
      const entry = SCREEN_ENTRIES.find((candidate) => candidate.id === screenId);
      expect(entry?.ownerTask).toBe(task);
    }
  });

  it("実装済み 2 画面はそれぞれのコンポーネントを、残りはプレースホルダを返す", () => {
    const { store } = createTestStore();
    const props = screenProps(store);
    expect(SCREEN_REGISTRY.home.render(props).type).toBe(HomeHub);
    expect(SCREEN_REGISTRY.digest.render(props).type).toBe(ReturnDigest);
    for (const entry of SCREEN_ENTRIES) {
      if (entry.ownerTask === null) continue;
      const vnode = entry.render(props);
      expect(vnode.type).toBe(PlaceholderScreen);
      const props2 = vnode.props as unknown as {
        readonly ownerTask: string;
        readonly screenId: string;
      };
      expect(props2.ownerTask).toBe(entry.ownerTask);
      expect(props2.screenId).toBe(entry.id);
    }
  });
});

describe("ScreenHost(非アクティブ画面は物理アンマウント・ADR-027(2))", () => {
  it("現在画面 1 個ぶんしか vnode を作らない", () => {
    const { store } = createTestStore();
    const vnode = ScreenHost({ screenId: "grid", ...screenProps(store) });
    const children = vnode.props.children as unknown;
    // `display:none` で 13 画面を並べる形なら配列になる。1 個だけであることを固定する。
    expect(Array.isArray(children)).toBe(false);
    expect((children as { readonly type: unknown }).type).toBe(PlaceholderScreen);
  });

  it("画面 ID を key にしてあるので、同じコンポーネント型どうしでも作り直される", () => {
    const { store } = createTestStore();
    const first = ScreenHost({ screenId: "grid", ...screenProps(store) });
    const second = ScreenHost({ screenId: "facility", ...screenProps(store) });
    expect(first.key).toBe("grid");
    expect(second.key).toBe("facility");
    expect(first.key).not.toBe(second.key);
  });
});

describe("ScreenNav(12画面 + 設定へのワンタップ遷移)", () => {
  function navButtons(current: Parameters<typeof ScreenNav>[0]["current"], onNavigate = vi.fn()) {
    const vnode = ScreenNav({ current, onNavigate });
    const list = vnode.props.children as { readonly props: { readonly children: unknown[] } };
    const items = list.props.children;
    return {
      onNavigate,
      buttons: items.map(
        (item) =>
          (item as { readonly props: { readonly children: unknown } }).props.children as {
            readonly props: {
              readonly "data-screen-id": string;
              readonly "aria-current"?: string;
              readonly onClick: () => void;
            };
          },
      ),
    };
  }

  it("全画面ぶんのボタンが出る", () => {
    const { buttons } = navButtons("home");
    expect(buttons.map((button) => button.props["data-screen-id"])).toEqual([...SCREEN_IDS]);
  });

  it("現在地だけ aria-current='page'", () => {
    const { buttons } = navButtons("codify");
    for (const button of buttons) {
      const expected = button.props["data-screen-id"] === "codify" ? "page" : undefined;
      expect(button.props["aria-current"]).toBe(expected);
    }
  });

  it("押すとその画面 ID で onNavigate が呼ばれる", () => {
    const { buttons, onNavigate } = navButtons("home");
    const target = buttons.find((button) => button.props["data-screen-id"] === "expedition");
    target?.props.onClick();
    expect(onNavigate).toHaveBeenCalledWith("expedition");
  });

  it("表示名は screens.ts(GDD 6.6 の表記)をそのまま使う", () => {
    const vnode = ScreenNav({ current: "home", onNavigate: () => undefined });
    const text = JSON.stringify(vnode);
    for (const id of SCREEN_IDS) {
      expect(text).toContain(SCREEN_META[id].label);
    }
  });
});

describe("表示整形(実時刻・ロケールに依存しない)", () => {
  it("ゲーム内時計は `第N日 HH:MM`(1 tick = 1 分・初日は第1日)", () => {
    expect(formatGameClock(0)).toBe("第1日 00:00");
    expect(formatGameClock(61)).toBe("第1日 01:01");
    expect(formatGameClock(1439)).toBe("第1日 23:59");
    expect(formatGameClock(1440)).toBe("第2日 00:00");
    expect(formatGameClock(4320)).toBe("第4日 00:00");
  });

  it("経過は日/時間/分の 3 段で丸める", () => {
    expect(formatTickSpan(0)).toBe("0分");
    expect(formatTickSpan(59)).toBe("59分");
    expect(formatTickSpan(60)).toBe("1時間0分");
    expect(formatTickSpan(1440)).toBe("1日0時間");
    expect(formatTickSpan(4320 + 90)).toBe("3日1時間");
  });

  it("負値・非整数は例外(黙って 0 にしない)", () => {
    expect(() => formatGameClock(-1)).toThrow(RangeError);
    expect(() => formatTickSpan(1.5)).toThrow(RangeError);
  });
});
