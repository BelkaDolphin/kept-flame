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

import { ScreenHost, ScreenNav, researchChipDisplay } from "../../../src/ui/AppShell";
import {
  NAV_GROUPS,
  navGroupScreenIds,
  navGroupsCoverAllScreens,
  type NavGroupId,
} from "../../../src/ui/navGroups";
import { NUMBERED_SCREEN_COUNT, SCREEN_IDS, SCREEN_META } from "../../../src/ui/screens";
import { ChronicleScreen } from "../../../src/ui/screens/chronicle/ChronicleScreen";
import { CodifyScreen } from "../../../src/ui/screens/codify/CodifyScreen";
import { ExpeditionScreen } from "../../../src/ui/screens/expedition/ExpeditionScreen";
import { FacilityScreen } from "../../../src/ui/screens/facility/FacilityScreen";
import { GridScreen } from "../../../src/ui/screens/grid/GridScreen";
import { HomeHub } from "../../../src/ui/screens/home/HomeHub";
import { InheritanceScreen } from "../../../src/ui/screens/inheritance/InheritanceScreen";
import { MigrationScreen } from "../../../src/ui/screens/migration/MigrationScreen";
import { OutpostsScreen } from "../../../src/ui/screens/outposts/OutpostsScreen";
import { ResearchScreen } from "../../../src/ui/screens/research/ResearchScreen";
import { ResidentsScreen } from "../../../src/ui/screens/residents/ResidentsScreen";
import { ReturnDigest } from "../../../src/ui/screens/digest/ReturnDigest";
import { SettingsScreen } from "../../../src/ui/screens/settings/SettingsScreen";
import { SCREEN_ENTRIES, SCREEN_REGISTRY } from "../../../src/ui/screens/registry";
import { formatGameClock, formatTickSpan } from "../../../src/ui/screens/format";
import { Signal } from "../../../src/ui/reactive";
import type { GameStore } from "../../../src/ui/store";
import type { TestplaySpeedController } from "../../../src/ui/testplaySpeed";
import { createTestStore, id } from "../fixtures";

/** [M59] テスト用の最小コントローラ(実 ScaledClock には繋がない・登録テスト専用)。 */
function fakeTestplaySpeed(): TestplaySpeedController {
  return { speed: new Signal(1), setSpeed: () => undefined };
}

/** レンダリングされない props(vnode を作るだけなので store は触られない)。 */
function screenProps(store: GameStore) {
  return {
    store,
    bootTick: 0,
    onNavigate: () => undefined,
    testplaySpeed: fakeTestplaySpeed(),
  };
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

  it("[M30] ②格子ビュー/③施設詳細・増築/④住民一覧・配置は実装済み(担当タスク無し)", () => {
    expect(SCREEN_REGISTRY.grid.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.facility.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.residents.ownerTask).toBeNull();
  });

  it("[M31] ⑤研究ツリー/⑥成文化キューは実装済み(担当タスク無し)", () => {
    expect(SCREEN_REGISTRY.research.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.codify.ownerTask).toBeNull();
  });

  it("[M32] ⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理は実装済み(担当タスク無し)", () => {
    expect(SCREEN_REGISTRY.expedition.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.chronicle.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.outposts.ownerTask).toBeNull();
  });

  it("[M33] ⑩大移動/⑪継承点購入/＋設定は実装済み(担当タスク無し)", () => {
    expect(SCREEN_REGISTRY.migration.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.inheritance.ownerTask).toBeNull();
    expect(SCREEN_REGISTRY.settings.ownerTask).toBeNull();
  });

  it("全件(ownerTask)が null = プレースホルダの担当タスクがどこにも残っていない", () => {
    for (const entry of SCREEN_ENTRIES) {
      expect([entry.id, entry.ownerTask]).toEqual([entry.id, null]);
    }
  });

  it("実装済み 13 画面(全件)がそれぞれのコンポーネントを返す", () => {
    const { store } = createTestStore();
    const props = screenProps(store);
    expect(SCREEN_REGISTRY.home.render(props).type).toBe(HomeHub);
    expect(SCREEN_REGISTRY.digest.render(props).type).toBe(ReturnDigest);
    expect(SCREEN_REGISTRY.grid.render(props).type).toBe(GridScreen);
    expect(SCREEN_REGISTRY.facility.render(props).type).toBe(FacilityScreen);
    expect(SCREEN_REGISTRY.residents.render(props).type).toBe(ResidentsScreen);
    expect(SCREEN_REGISTRY.research.render(props).type).toBe(ResearchScreen);
    expect(SCREEN_REGISTRY.codify.render(props).type).toBe(CodifyScreen);
    expect(SCREEN_REGISTRY.expedition.render(props).type).toBe(ExpeditionScreen);
    expect(SCREEN_REGISTRY.chronicle.render(props).type).toBe(ChronicleScreen);
    expect(SCREEN_REGISTRY.outposts.render(props).type).toBe(OutpostsScreen);
    // [M33]
    expect(SCREEN_REGISTRY.migration.render(props).type).toBe(MigrationScreen);
    expect(SCREEN_REGISTRY.inheritance.render(props).type).toBe(InheritanceScreen);
    expect(SCREEN_REGISTRY.settings.render(props).type).toBe(SettingsScreen);
  });
});

describe("ScreenHost(非アクティブ画面は物理アンマウント・ADR-027(2))", () => {
  it("現在画面 1 個ぶんしか vnode を作らない(13画面全件が実装済みになったので実画面で確認)", () => {
    const { store } = createTestStore();
    // [M33 統合] migration も実装済みになり、プレースホルダ経路を示す画面が
    // 1 つも残っていない(前例=M30/M31/M32 が同じ理由で差し替えてきた形の最終形)。
    const vnode = ScreenHost({ screenId: "migration", ...screenProps(store) });
    const children = vnode.props.children as unknown;
    // `display:none` で 13 画面を並べる形なら配列になる。1 個だけであることを固定する。
    expect(Array.isArray(children)).toBe(false);
    expect((children as { readonly type: unknown }).type).toBe(MigrationScreen);
  });

  it("[M30] 実装済み画面(grid)でも同じく 1 個ぶんしか vnode を作らない", () => {
    const { store } = createTestStore();
    const vnode = ScreenHost({ screenId: "grid", ...screenProps(store) });
    const children = vnode.props.children as unknown;
    expect(Array.isArray(children)).toBe(false);
    expect((children as { readonly type: unknown }).type).toBe(GridScreen);
  });

  it("[M31] 実装済み画面(research/codify)でも同じく 1 個ぶんしか vnode を作らない", () => {
    const { store } = createTestStore();
    const researchVnode = ScreenHost({ screenId: "research", ...screenProps(store) });
    expect((researchVnode.props.children as { readonly type: unknown }).type).toBe(ResearchScreen);
    const codifyVnode = ScreenHost({ screenId: "codify", ...screenProps(store) });
    expect((codifyVnode.props.children as { readonly type: unknown }).type).toBe(CodifyScreen);
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

// [束A] ナビは「13 タブ全掲」から「5 グループ + 展開」へ変わった(UX プレイテスト
// F-5)。DOM 構造が変わったので、下のヘルパは vnode ツリーから button を再帰的に
// 拾う形へ書き換えてある(検証している性質——全画面へ到達できる / 現在地が
// aria-current で分かる / 表示名は screens.ts が出典——は M29 のまま)。
interface NavButton {
  readonly props: {
    readonly "data-screen-id"?: string;
    readonly "data-nav-group"?: string;
    readonly "aria-current"?: string;
    readonly "aria-expanded"?: boolean;
    readonly onClick: () => void;
  };
}

function collectButtons(node: unknown, out: NavButton[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const vnode = node as { readonly type?: unknown; readonly props?: { children?: unknown } };
  if (vnode.type === "button") out.push(node as NavButton);
  collectButtons(vnode.props?.children, out);
}

describe("ScreenNav([束A] 5グループ集約 + サブ項目展開)", () => {
  function navButtons(
    current: Parameters<typeof ScreenNav>[0]["current"],
    openGroupId: NavGroupId | null = null,
    onNavigate = vi.fn(),
  ) {
    const vnode = ScreenNav({ current, onNavigate, openGroupId, onToggleGroup: () => undefined });
    const buttons: NavButton[] = [];
    collectButtons(vnode, buttons);
    return { onNavigate, buttons };
  }

  it("畳んだ状態ではグループぶん(5個)のボタンだけが出る", () => {
    const { buttons } = navButtons("home");
    expect(buttons.map((button) => button.props["data-nav-group"])).toEqual([
      ...NAV_GROUPS.map((group) => group.id),
    ]);
  });

  it("グループの和は 12画面 + 設定の全件(漏れも重複も無い)", () => {
    expect(navGroupsCoverAllScreens()).toBe(true);
    expect([...navGroupScreenIds()].sort()).toEqual([...SCREEN_IDS].sort());
  });

  it("展開するとそのグループの画面ぶんのサブ項目が出る", () => {
    const { buttons } = navButtons("home", "expedition");
    const subScreenIds = buttons
      .filter((button) => button.props["data-nav-group"] === undefined)
      .map((button) => button.props["data-screen-id"]);
    expect(subScreenIds).toEqual(["expedition", "chronicle", "outposts"]);
  });

  it("現在地のサブ項目だけ aria-current='page'、その所属グループは 'true'", () => {
    const { buttons } = navButtons("codify", "knowledge");
    for (const button of buttons) {
      const screenId = button.props["data-screen-id"];
      const groupId = button.props["data-nav-group"];
      if (groupId === undefined) {
        expect(button.props["aria-current"]).toBe(screenId === "codify" ? "page" : undefined);
      } else {
        expect(button.props["aria-current"]).toBe(groupId === "knowledge" ? "true" : undefined);
      }
    }
  });

  it("サブ項目を押すとその画面 ID で onNavigate が呼ばれる", () => {
    const { buttons, onNavigate } = navButtons("home", "expedition");
    const target = buttons.find(
      (button) =>
        button.props["data-screen-id"] === "chronicle" &&
        button.props["data-nav-group"] === undefined,
    );
    target?.props.onClick();
    expect(onNavigate).toHaveBeenCalledWith("chronicle");
  });

  it("画面 1 個だけのグループ(設定)は展開せず直接遷移する", () => {
    const { buttons, onNavigate } = navButtons("home");
    const settings = buttons.find((button) => button.props["data-nav-group"] === "system");
    expect(settings?.props["aria-expanded"]).toBeUndefined();
    settings?.props.onClick();
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("サブ項目の表示名は screens.ts(GDD 6.6 の表記)をそのまま使う(番号は出さない)", () => {
    for (const group of NAV_GROUPS) {
      // 単独グループ(設定)はサブ項目を持たず、バー上のグループ名だけで足りる。
      if (group.screens.length === 1) continue;
      const vnode = ScreenNav({
        current: "home",
        onNavigate: () => undefined,
        openGroupId: group.id,
      });
      const text = JSON.stringify(vnode);
      for (const id of group.screens) {
        expect(text).toContain(SCREEN_META[id].label);
        // 仕様書番号(「1.」等)はラベルから外した(UX プレイテスト F-5)。
        expect(text).not.toContain(`${String(SCREEN_META[id].order ?? "")}. `);
      }
    }
  });
});

// [2026-08-02差し戻し・台帳v10 必-1] `ResearchChip`(§1-3)自体は hooks を持つため
// ColonyClock/ResourceHud と同じ理由で直接呼び出すテストができない。表示ロジック
// (class名・値の文言)は `researchChipDisplay`(hooks 不使用)へ切り出してあるので
// ここで直接固定する。`stalled` の意味論(derived.ts の `researchChip`)自体は
// tests/ui/derived.test.ts が固定済み。
describe("[2026-08-02差し戻し・台帳v10 必-1] researchChipDisplay(研究チップの停止中表示)", () => {
  it("stalled=false: 通常表示(淡色化なし・(停止中)を付けない)", () => {
    const display = researchChipDisplay({
      techId: id("techFireStarting"),
      progressPercent: 43,
      stalled: false,
    });
    expect(display.className).toBe("kf-hud__chip");
    expect(display.valueText).toBe("43%");
  });

  it("stalled=true: tech名/%を残したまま淡色化 + 「(停止中)」を付ける", () => {
    const display = researchChipDisplay({
      techId: id("techFireStarting"),
      progressPercent: 43,
      stalled: true,
    });
    expect(display.className).toBe("kf-hud__chip kf-hud__chip--muted");
    expect(display.valueText).toBe("43%(停止中)");
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
