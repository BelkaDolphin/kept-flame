// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- アプリシェル(M29)— ADR-027 / ADR-026 / GDD 6.6
//
// ===========================================================================
// 1. シェルがやること / やらないこと
// ===========================================================================
//   やること: ヘッダ(現在画面名 + ゲーム内時計)・ナビ(12画面 + 設定)・
//   **現在画面 1 個だけ**の描画。
//
//   やらないこと: ストアを作ること / tick を進めること / セーブ / Worker 起動。
//   これらは composition root(`src/main.tsx`)の担当であり、シェルは
//   「作られたもの」を受け取るだけである。**画面遷移でストアが再生成されない**
//   という M29 の検収条件は、シェルが `createGameStore` を 1 度も呼ばない
//   ことによって構造的に満たされる(結線の本体は `src/ui/shellSession.ts`)。
//
// ===========================================================================
// 2. 非アクティブ画面は物理アンマウント(ADR-027(2))
// ===========================================================================
//   `ScreenHost` は現在画面の vnode を 1 個しか作らない。`display:none` で
//   隠して残す形は採らないので、画面が切り替わった瞬間に前の画面の
//   `useScreenMount` の cleanup が走り、その画面が張った購読
//   (`ReactiveScope`)が全部切れる = 裏で computed が評価され続けない。
//
//   `key={screenId}` を付けてあるのは、プレースホルダのように**同じコンポーネント
//   型**を共有する画面どうしの遷移でも Preact に確実に作り直させるためである。
//
// ===========================================================================
// 3. 時計の再描画を隔離する(ADR-027(4))
// ===========================================================================
//   tick は毎分変わるので、`ColonyClock` という**それだけを購読する小さな
//   コンポーネント**に隔離する。ヘッダやバッジ列を巻き込んで再描画しない。
//   資源HUD(`ResourceHud`・§4)も同じ理由で別コンポーネントにしてある——
//   在庫は毎 tick 動くが、シェルの他の部分(タイトル・ナビ)を巻き込まない。
//
// ===========================================================================
// 4. [束A] sticky ヘッダ(資源HUD 常設)+ sticky グループナビ
// ===========================================================================
//   UX プレイテストで出た構造問題 F-3(資源が①ホームハブでしか見えない)と
//   F-5(ナビが本文末尾・13 タブ全掲)への対応:
//     - ヘッダを `position:sticky; top:0` にし、資源チップ列を常設する
//       (どの画面でも「今いくつあるか」を見ながら操作できる)。
//     - ナビを `position:sticky; bottom:0` の 1 段バーにし、13 画面を
//       5 グループ(`navGroups.ts`)へ畳む。グループをタップするとバーの上に
//       サブ項目が開く。
//   どちらも意匠は CSS 側(appShell.css)にあり、ここが持つのは構造と状態だけ。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "preact/hooks";

import "./appShell.css";
import { InstallPromotionBanner } from "./InstallPromotionBanner";
import { NAV_GROUPS, navGroupOfScreen, type NavGroupId } from "./navGroups";
import { NotificationOptInBanner } from "./NotificationOptInBanner";
import { resourceLabel } from "./screens/contentLabels";
import { formatGameClock, formatResourceAmount } from "./screens/format";
import { SCREEN_META, type ScreenId } from "./screens";
import { SCREEN_REGISTRY } from "./screens/registry";
import { useSignalValue } from "./screens/useStoreSignal";
import type { ResourceView } from "./derived";
import type { ShellSession } from "./shellSession";
import type { GameStore } from "./store";

// --- 1. ゲーム内時計(毎分ここだけが再描画される・§3) -----------------------

export interface ColonyClockProps {
  readonly store: GameStore;
}

export function ColonyClock({ store }: ColonyClockProps) {
  const tick = useSignalValue(store.derived.tick);
  return (
    <div class="kf-hud__chip kf-clock">
      <span class="kf-hud__chip-label">時刻</span>
      <span class="kf-hud__chip-value">{formatGameClock(tick)}</span>
    </div>
  );
}

// --- 1-2. 資源HUD(ヘッダ常設・[束A] F-3) -----------------------------------

/**
 * チップの並び順(GDD 6.7 / 9.1 / 11.1 が資源を挙げる順 = 薪/鉄/粘土/紙/廃材)。
 * `store.derived.resources` は state の entity 順であり、その順序は engine の
 * 都合(生成順)なので、**表示順だけ**をここで決める。表に無い資源(content 追加
 * で増えたもの)は末尾へ ID 昇順で回し、捨てない。
 */
export const HUD_RESOURCE_ORDER: readonly string[] = ["firewood", "iron", "clay", "paper", "waste"];

/** 表示順の解決(hooks 不使用の純関数なので直接テストできる)。 */
export function orderHudResources(resources: readonly ResourceView[]): readonly ResourceView[] {
  const rank = (view: ResourceView): number => {
    const index = HUD_RESOURCE_ORDER.indexOf(view.resourceId);
    return index === -1 ? HUD_RESOURCE_ORDER.length : index;
  };
  return [...resources].sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
  });
}

export interface ResourceHudProps {
  readonly store: GameStore;
}

/**
 * 全資源の在庫チップ。1e6 固定小数点 → 人間可読値の換算は
 * `derived.ts` が `toApproxNumber`(engine の fp.ts)で済ませた `stockApprox`
 * を使う(UI 側で固定小数点の割り算を発明しない)。桁の整形だけ
 * `formatResourceAmount`(screens/format.ts)が持つ。
 */
export function ResourceHud({ store }: ResourceHudProps) {
  const resources = useSignalValue(store.derived.resources);
  if (resources.length === 0) return null;
  return (
    <ul class="kf-app__hud-list" aria-label="資源在庫">
      {orderHudResources(resources).map((resource) => (
        <li key={resource.entityId} class="kf-hud__chip" data-resource-id={resource.resourceId}>
          <span class="kf-hud__chip-label">{resourceLabel(resource.resourceId)}</span>
          <span class="kf-hud__chip-value">{formatResourceAmount(resource.stockApprox)}</span>
        </li>
      ))}
    </ul>
  );
}

// --- 2. ナビゲーション(5グループ・[束A] F-5) -------------------------------

export interface ScreenNavProps {
  readonly current: ScreenId;
  readonly onNavigate: (screen: ScreenId) => void;
  /** 展開中のグループ(未指定 / null なら全部畳んだ状態)。状態はシェルが持つ。 */
  readonly openGroupId?: NavGroupId | null;
  /** グループ見出しのタップ(展開/折り畳みのトグル)。 */
  readonly onToggleGroup?: (groupId: NavGroupId) => void;
}

/**
 * グループバー + 展開中グループのサブ項目。
 *
 * **hooks を持たない**(展開状態は `AppShell` が持って props で渡す)ので、
 * M29 から続く「ナビは vnode を直接呼んでテストできる」性質を保つ。
 * 画面 1 個だけのグループ(設定)は展開せず直接遷移する——1 タップで済むものを
 * 2 タップにしない。
 */
export function ScreenNav({
  current,
  onNavigate,
  openGroupId = null,
  onToggleGroup,
}: ScreenNavProps) {
  const currentGroup = navGroupOfScreen(current);
  // 単独グループ(設定)は展開の概念を持たない(タップ = 直接遷移)。
  const openGroup =
    NAV_GROUPS.find((group) => group.id === openGroupId && group.screens.length > 1) ?? null;
  return (
    <nav class="kf-nav" aria-label="画面切り替え">
      {openGroup !== null && (
        <ul class="kf-nav__submenu" aria-label={`${openGroup.label}の画面`}>
          {openGroup.screens.map((id) => (
            <li key={id}>
              <button
                type="button"
                class="kf-nav__sub-button"
                data-screen-id={id}
                aria-current={id === current ? "page" : undefined}
                onClick={() => onNavigate(id)}
              >
                {SCREEN_META[id].label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul class="kf-nav__list">
        {NAV_GROUPS.map((group) => {
          const soleScreen = group.screens.length === 1 ? group.screens[0] : undefined;
          const isCurrentGroup = group.id === currentGroup.id;
          const expanded = group.id === openGroupId;
          return (
            <li key={group.id}>
              <button
                type="button"
                class="kf-nav__button"
                data-nav-group={group.id}
                data-screen-id={soleScreen}
                aria-current={
                  soleScreen !== undefined && soleScreen === current
                    ? "page"
                    : isCurrentGroup
                      ? "true"
                      : undefined
                }
                aria-expanded={soleScreen === undefined ? expanded : undefined}
                onClick={() => {
                  if (soleScreen !== undefined) {
                    onNavigate(soleScreen);
                    return;
                  }
                  onToggleGroup?.(group.id);
                }}
              >
                {group.label}
                {soleScreen === undefined && (
                  <span class="kf-nav__caret" aria-hidden="true">
                    {expanded ? "▾" : "▴"}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// --- 3. 現在画面 1 個だけを描く(§2) ----------------------------------------

export interface ScreenHostProps {
  readonly screenId: ScreenId;
  readonly store: GameStore;
  readonly bootTick: number;
  readonly onNavigate: (screen: ScreenId) => void;
}

export function ScreenHost({ screenId, store, bootTick, onNavigate }: ScreenHostProps) {
  const entry = SCREEN_REGISTRY[screenId];
  return (
    <main class="kf-app__screen" key={screenId}>
      {entry.render({ store, bootTick, onNavigate })}
    </main>
  );
}

// --- 4. 誘導バナーの view model(M34)----------------------------------------
//
//   composition root(`src/main.tsx`)が「出す意味があるか」(環境検出)と
//   「出すべきか」(`platform/{installPromotion,notificationCapability}.ts` の
//   タイムスタンプ判定)を先に AND 済みにした最終値だけをここへ渡す。シェルが
//   追加で持つのは「このセッション中に閉じたか」という**揮発性の UI 状態
//   だけ**(`installBannerClosed`/`notificationBannerClosed`。次回起動時は
//   このセッション内の閉鎖は引き継がない——永続的な頻度抑制は
//   `PromotionPromptTracker` 側の責務であり、二重に持たない)。

export interface InstallPromotionViewModel {
  readonly visible: boolean;
  readonly canPromptDirectly: boolean;
  readonly onInstall: () => void;
}

export interface NotificationOptInViewModel {
  readonly visible: boolean;
  readonly onRequestPermission: () => void;
}

// --- 5. シェル本体 -----------------------------------------------------------

export interface AppShellProps {
  readonly store: GameStore;
  /** ルータ ⇄ ストアの結線(`createShellSession`)。シェルは作らず受け取る。 */
  readonly session: ShellSession;
  /** 起動直後(catch-up 前)の tick。⑫が「不在中」の起点に使う。 */
  readonly bootTick: number;
  /** Add-to-Home 誘導バナー(M34)。省略時は描かない(既存呼び出し元との互換)。 */
  readonly installPromotion?: InstallPromotionViewModel;
  /** 通知オプトイン誘導バナー(M34)。省略時は描かない。 */
  readonly notificationOptIn?: NotificationOptInViewModel;
}

export function AppShell({
  store,
  session,
  bootTick,
  installPromotion,
  notificationOptIn,
}: AppShellProps) {
  const [screenId, setScreenId] = useState<ScreenId>(() => session.screen());
  const [installBannerClosed, setInstallBannerClosed] = useState(false);
  const [notificationBannerClosed, setNotificationBannerClosed] = useState(false);
  // ナビの展開状態は**セーブにも URL にも載らない揮発 UI 状態**(バナーの
  // 閉鎖状態と同じ扱い)。現在地の権威はあくまでルータ側にある。
  const [openGroupId, setOpenGroupId] = useState<NavGroupId | null>(null);

  useEffect(() => {
    // 購読を張る前にルータが動いていた可能性があるので、まず現在地へ揃える。
    setScreenId(session.screen());
    // 現在地が変わったらナビのポップオーバーは畳む。**ブラウザの戻る/進むや
    // 外部からのハッシュ変更でも畳む**必要があるので、`navigate()` 側だけでなく
    // ここ(現在地の唯一の権威であるルータの購読)でも閉じる。
    return session.subscribe((screen) => {
      setScreenId(screen);
      setOpenGroupId(null);
    });
  }, [session]);

  const meta = SCREEN_META[screenId];

  function navigate(screen: ScreenId): void {
    // 遷移したらポップオーバーは畳む(開きっぱなしだと本文の下端を隠す)。
    setOpenGroupId(null);
    session.navigate(screen);
  }

  return (
    <div class="kf-app">
      <header class="kf-app__header">
        <h1 class="kf-app__title">
          {meta.label}
          <span class="kf-app__title-sub">継ぐ火 -Kept Flame-</span>
        </h1>
        <div class="kf-app__hud">
          <ColonyClock store={store} />
          <ResourceHud store={store} />
        </div>
      </header>
      {installPromotion && (
        <InstallPromotionBanner
          visible={installPromotion.visible && !installBannerClosed}
          canPromptDirectly={installPromotion.canPromptDirectly}
          onInstall={installPromotion.onInstall}
          onClose={() => setInstallBannerClosed(true)}
        />
      )}
      {notificationOptIn && (
        <NotificationOptInBanner
          visible={notificationOptIn.visible && !notificationBannerClosed}
          onRequestPermission={notificationOptIn.onRequestPermission}
          onClose={() => setNotificationBannerClosed(true)}
        />
      )}
      <ScreenHost screenId={screenId} store={store} bootTick={bootTick} onNavigate={navigate} />
      <ScreenNav
        current={screenId}
        onNavigate={navigate}
        openGroupId={openGroupId}
        onToggleGroup={(groupId) => {
          setOpenGroupId((open) => (open === groupId ? null : groupId));
        }}
      />
    </div>
  );
}
