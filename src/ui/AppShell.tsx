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
// ---------------------------------------------------------------------------

import { useEffect, useState } from "preact/hooks";

import "./appShell.css";
import { InstallPromotionBanner } from "./InstallPromotionBanner";
import { NotificationOptInBanner } from "./NotificationOptInBanner";
import { formatGameClock } from "./screens/format";
import { SCREEN_META, SCREEN_IDS, type ScreenId } from "./screens";
import { SCREEN_REGISTRY } from "./screens/registry";
import { useSignalValue } from "./screens/useStoreSignal";
import type { ShellSession } from "./shellSession";
import type { GameStore } from "./store";

// --- 1. ゲーム内時計(毎分ここだけが再描画される・§3) -----------------------

export interface ColonyClockProps {
  readonly store: GameStore;
}

export function ColonyClock({ store }: ColonyClockProps) {
  const tick = useSignalValue(store.derived.tick);
  return (
    <div class="kf-clock">
      <span class="kf-clock__label">コロニー時刻</span>
      {formatGameClock(tick)}
    </div>
  );
}

// --- 2. ナビゲーション(12画面 + 設定) --------------------------------------

export interface ScreenNavProps {
  readonly current: ScreenId;
  readonly onNavigate: (screen: ScreenId) => void;
}

export function ScreenNav({ current, onNavigate }: ScreenNavProps) {
  return (
    <nav class="kf-nav" aria-label="画面切り替え">
      <ul class="kf-nav__list">
        {SCREEN_IDS.map((id) => {
          const meta = SCREEN_META[id];
          return (
            <li key={id}>
              <button
                type="button"
                class="kf-nav__button"
                data-screen-id={id}
                aria-current={id === current ? "page" : undefined}
                onClick={() => onNavigate(id)}
              >
                {meta.order === null ? null : <span class="kf-nav__order">{meta.order}</span>}
                {meta.label}
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

  useEffect(() => {
    // 購読を張る前にルータが動いていた可能性があるので、まず現在地へ揃える。
    setScreenId(session.screen());
    return session.subscribe(setScreenId);
  }, [session]);

  const meta = SCREEN_META[screenId];

  return (
    <div class="kf-app">
      <header class="kf-app__header">
        <h1 class="kf-app__title">
          {meta.order === null ? meta.label : `${String(meta.order)}. ${meta.label}`}
          <span class="kf-app__title-sub">継ぐ火 -Kept Flame-</span>
        </h1>
        <ColonyClock store={store} />
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
      <ScreenHost
        screenId={screenId}
        store={store}
        bootTick={bootTick}
        onNavigate={session.navigate}
      />
      <ScreenNav current={screenId} onNavigate={session.navigate} />
    </div>
  );
}
