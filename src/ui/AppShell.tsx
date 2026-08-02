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

import { useEffect, useRef, useState } from "preact/hooks";

import { ARRIVAL_RESIDENT_ID_PREFIX } from "../engine/rules/population";
import type { EntityId } from "../engine/state/state";
import "./appShell.css";
import { BackupReminderBanner } from "./BackupReminderBanner";
import { InstallPromotionBanner } from "./InstallPromotionBanner";
import { LoadFailureBanner } from "./LoadFailureBanner";
import { NAV_GROUPS, navGroupOfScreen, type NavGroupId } from "./navGroups";
import { NotificationOptInBanner } from "./NotificationOptInBanner";
import { OnboardingGuide } from "./onboarding/OnboardingGuide";
import { ONBOARDING_STEPS } from "./onboarding/steps";
import { residentDisplayName, resourceLabel, techLabel } from "./screens/contentLabels";
import { formatGameClock, formatResourceAmount } from "./screens/format";
import { labelizeLogText } from "./screens/idLabelize";
import { SCREEN_META, type ScreenId } from "./screens";
import { SCREEN_REGISTRY } from "./screens/registry";
import { ToastStackView, useToastStack, type ToastStackApi } from "./screens/Toast";
import { useSignalValue } from "./screens/useStoreSignal";
import type { ResearchChipView, ResourceView } from "./derived";
import type { ShellSession } from "./shellSession";
import type { GameStore } from "./store";
import type { TestplaySpeedController } from "./testplaySpeed";

// --- 1. ゲーム内時計(毎分ここだけが再描画される・§3) -----------------------

export interface ColonyClockProps {
  readonly store: GameStore;
}

export function ColonyClock({ store }: ColonyClockProps) {
  const tick = useSignalValue(store.derived.tick);
  const runCount = useSignalValue(store.derived.runCount);
  return (
    <div class="kf-hud__chip kf-clock">
      {/* [M61/FC11・R1-A26] tick は大移動を跨いでリセットしない(仕様どおり)。
          「周回N」を常に添えて、新周回なのに日数がゼロへ戻らないことの誤解を
          表記だけで解く(仕様変更ではない・runCount=0 が1周目)。 */}
      <span class="kf-hud__chip-label">周回{runCount + 1}・時刻</span>
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

// --- 1-3. 研究チップ(ヘッダ常設・[2026-08-02裁定・台帳v10 必-1]) --------------
//
//   資源HUDの隣に「いま研究点が流れ込んでいる tech + 進捗%」を 1 個だけ出す。
//   研究点はストックではなくレート(`production.ts` の `researchRateFix`)で
//   あり、選択中の tech(`currentResearch`・engine/rules/research.ts §2)へ
//   直接流れる設計なので、資源のように在庫を持つ画面が無い——ここがヘッダで
//   唯一の可視化点になる。ロジック(どの tech か・floor 済み%・`stalled`)は
//   `derived.ts` の `researchChip` computed に集約済みで、ここでは表示専用
//   (`orderHudResources` と同じ「純ロジックは derived 側」の分担)。
//
//   **[2026-08-02差し戻し] `stalled` の表示**: 台帳v10 必-1 の眼目は「作業台
//   から人を外して研究が止まっていても気づけない」ことなので、`chip` 自体が
//   null(対象なし)の場合と、対象はあるがレートが 0 の場合(`stalled: true`)を
//   混同しない。後者は tech 名と%を**残したまま**淡色化 + 「(停止中)」を添える
//   (「何が」「どこまで」進んで凍っているかが見えたままであることが重要)。
//   この分岐(class 名・値の文言)は `researchChipDisplay` という**hooks 不使用の
//   純関数**へ切り出してある(`orderHudResources` と同じ「表示ロジックは直接
//   テストできる形にする」作法。コンポーネント自体は hooks を持つため直接
//   呼び出すテストができない=既存の ColonyClock/ResourceHud と同じ制約)。

export interface ResearchChipDisplay {
  readonly className: string;
  readonly valueText: string;
}

/** `chip !== null` の場合の class 名 / 値表示テキストを決める(hooks 不使用)。 */
export function researchChipDisplay(chip: ResearchChipView): ResearchChipDisplay {
  return {
    className: chip.stalled ? "kf-hud__chip kf-hud__chip--muted" : "kf-hud__chip",
    valueText: chip.stalled ? `${chip.progressPercent}%(停止中)` : `${chip.progressPercent}%`,
  };
}

export interface ResearchChipProps {
  readonly store: GameStore;
}

export function ResearchChip({ store }: ResearchChipProps) {
  const chip = useSignalValue(store.derived.researchChip);
  if (chip === null) {
    return (
      <div class="kf-hud__chip kf-hud__chip--muted" data-testid="research-chip">
        <span class="kf-hud__chip-label">🔬</span>
        <span class="kf-hud__chip-value">停止中</span>
      </div>
    );
  }
  const display = researchChipDisplay(chip);
  return (
    <div
      class={display.className}
      data-testid="research-chip"
      data-tech-id={chip.techId}
      data-stalled={chip.stalled}
    >
      <span class="kf-hud__chip-label">🔬 {techLabel(chip.techId)}</span>
      <span class="kf-hud__chip-value">{display.valueText}</span>
    </div>
  );
}

// --- 1-4. テストプレイ加速モードのインジケータ(ロードマップ M59) -------------
//
//   ×1(既定)のときは何も出さない(戻し忘れの心配が無い平常時にヘッダを
//   汚さない)。×1 以外のときだけ常時表示し、「倍速のまま放置」に気づける
//   ようにする(タスク指示「戻し忘れ防止」)。書き込み(速度切替)は＋設定画面
//   「テストプレイ支援」節の担当で、ここは読み取り専用。

export interface TestplaySpeedIndicatorProps {
  readonly controller: TestplaySpeedController;
}

export function TestplaySpeedIndicator({ controller }: TestplaySpeedIndicatorProps) {
  const speed = useSignalValue(controller.speed);
  if (speed === 1) return null;
  return (
    <div class="kf-hud__chip kf-hud__chip--testplay" data-testid="testplay-speed-indicator">
      <span class="kf-hud__chip-value">⏩×{speed}</span>
    </div>
  );
}

// --- 1-5. 帰還・研究完了の通知トースト(M61/FC7) -----------------------------
//
//   R1-A05「探索隊の帰還が一切通知されない」/ R1-A16「研究完了時のフィードバック
//   が皆無」への対応。どちらも**プレイヤー操作の結果ではなく tick 進行の結果**
//   (帰還・研究完了は scheduler が advance 中に決める)なので、個々の画面の
//   成功トースト(Toast.tsx・コマンド成功時にその画面が push する形)には乗らない
//   ——どの画面を見ていても、あるいは Worker catch-up で一気に進んだ直後でも
//   気づけるよう、常時マウントされているシェル(AppShell)側に置く。
//
//   検知方式は「前回の描画時点の集合」と「今の集合」を比較する差分検知
//   (`useRef` で前回値を保持)。dispatch/commandApplied のような明示イベントが
//   無い(帰還・完了は state の受動的な結果でしかない)ため、この形が最小実装。
//   初回マウント時(前回値が無い時)は基準を取るだけで通知しない——起動直後に
//   「もう解禁済みの tech」まで完了扱いで鳴らさないため。

/**
 * [M61/FC7] 探索帰還の通知。`store.derived.renderedLog`(GDD 8.4 のレンダリング
 * 済み帰還ログ)の総件数(表示中 + 畳んだ件数)が増えるたびに、新しく増えた
 * ぶんの本文を通知する。表示直前に `labelizeLogText` を通す(FC4 と同じ表示時
 * 変換・ChronicleScreen.tsx と同じ扱い)。
 *
 * 長期不在からの復帰で一気に何件も積まれることがある(Worker catch-up)ため、
 * 4 件を超える分は個別に出さず「ほかN件」の要約1本にまとめる(通知の洪水を
 * 避ける・★判断)。
 */
export interface ExpeditionReturnWatcherProps {
  readonly store: GameStore;
  readonly onReturn: (text: string) => void;
}

const MAX_INDIVIDUAL_RETURN_TOASTS = 3;

export function ExpeditionReturnWatcher({ store, onReturn }: ExpeditionReturnWatcherProps) {
  const renderedLog = useSignalValue(store.derived.renderedLog);
  const previousTotalRef = useRef<number | null>(null);

  useEffect(() => {
    const total = renderedLog.entries.length + renderedLog.foldedCount;
    const previous = previousTotalRef.current;
    if (previous !== null) {
      const newCount = total - previous;
      if (newCount > 0) {
        const newest = renderedLog.entries.slice(-newCount);
        if (newCount <= MAX_INDIVIDUAL_RETURN_TOASTS) {
          for (const entry of newest) onReturn(labelizeLogText(entry.text));
        } else {
          const shown = newest.slice(-MAX_INDIVIDUAL_RETURN_TOASTS);
          for (const entry of shown) onReturn(labelizeLogText(entry.text));
          onReturn(`ほか${String(newCount - MAX_INDIVIDUAL_RETURN_TOASTS)}件の探索が帰還した`);
        }
      }
    }
    previousTotalRef.current = total;
    // 依存配列は意図的に `renderedLog` だけ(`onReturn` は毎レンダー新しい
    // 関数参照になり得るが、比較の基準は renderedLog の値そのものだけでよい)。
  }, [renderedLog]);

  return null;
}

/**
 * [M61/FC7] 研究完了の通知。`store.derived.researchTree` を監視し、
 * 各行の `status` が新たに `"completed"` になった techId を通知する。
 */
export interface ResearchCompletionWatcherProps {
  readonly store: GameStore;
  readonly onComplete: (text: string) => void;
}

export function ResearchCompletionWatcher({ store, onComplete }: ResearchCompletionWatcherProps) {
  const tree = useSignalValue(store.derived.researchTree);
  const previousCompletedRef = useRef<ReadonlySet<EntityId> | null>(null);

  useEffect(() => {
    const completedNow = new Set(
      tree.filter((entry) => entry.status === "completed").map((entry) => entry.techId),
    );
    const previous = previousCompletedRef.current;
    if (previous !== null) {
      for (const techId of completedNow) {
        if (!previous.has(techId)) onComplete(`「${techLabel(techId)}」の研究が完了した`);
      }
    }
    previousCompletedRef.current = completedNow;
    // 依存配列は意図的に `tree` だけ(上の ExpeditionReturnWatcher と同じ理由)。
  }, [tree]);

  return null;
}

/**
 * [M62/FC6a・R2-A06] 晴天漂着(GDD 7.7)の通知。上の 2 つ(帰還/研究完了)と
 * 同じ差分検知方式(前回の描画時点の集合 ↔ 今の集合・M61/FC7 の前例)。
 *
 * 「新しく増えた住民」の判定に memoir 等の解釈を持ち込まず、
 * `ARRIVAL_RESIDENT_ID_PREFIX`(`residentDrift<tick>`・晴天漂着で加入した住民
 * だけがこの接頭辞を持つ・`rules/population.ts` §4)の ID 規則だけで判定する
 * ——探索での保護加入(`rescueResidentIdOf` が別の ID 規則を発行・GDD 7.6
 * [2026-07-30裁定]③)と混同しない。探索での保護は
 * `ExpeditionReturnWatcher` の帰還ログ本文が既に伝えている(GDD 8.4「Xを
 * 保護した」)ため、ここで重複して通知しない。
 */
/** `rejectionMessages.ts` の `techIdFromResearchEntityId` と同じ書き方
 * (ID 規則の判定は `string` へ明示的に幅を広げてから行う・ブランド型への cast
 * を書かない)。 */
function isArrivalResidentId(entityId: EntityId): boolean {
  const raw: string = entityId;
  return raw.startsWith(ARRIVAL_RESIDENT_ID_PREFIX);
}

export interface ArrivalWatcherProps {
  readonly store: GameStore;
  readonly onArrival: (text: string) => void;
}

export function ArrivalWatcher({ store, onArrival }: ArrivalWatcherProps) {
  const residents = useSignalValue(store.derived.residents);
  const previousArrivalIdsRef = useRef<ReadonlySet<EntityId> | null>(null);

  useEffect(() => {
    const arrivalIdsNow = new Set(
      residents.map((entry) => entry.entityId).filter((entityId) => isArrivalResidentId(entityId)),
    );
    const previous = previousArrivalIdsRef.current;
    if (previous !== null) {
      for (const entityId of arrivalIdsNow) {
        if (!previous.has(entityId)) {
          onArrival(`${residentDisplayName(entityId)}が晴天漂着で加入した`);
        }
      }
    }
    previousArrivalIdsRef.current = arrivalIdsNow;
    // 依存配列は意図的に `residents` だけ(上の 2 つの Watcher と同じ理由)。
  }, [residents]);

  return null;
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
  /** [M59] ＋設定画面の「テストプレイ支援」節が読み書きする。 */
  readonly testplaySpeed: TestplaySpeedController;
}

export function ScreenHost({
  screenId,
  store,
  bootTick,
  onNavigate,
  testplaySpeed,
}: ScreenHostProps) {
  const entry = SCREEN_REGISTRY[screenId];
  return (
    <main class="kf-app__screen" key={screenId}>
      {entry.render({ store, bootTick, onNavigate, testplaySpeed })}
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

/**
 * [M54] 定期バックアップ推奨バナー。M34 の 2 種と同じ形(`visible` は
 * composition root がデータ条件 AND 表示頻度を先に AND 済みにした最終値)。
 * ＋設定画面への遷移はシェル自身の `navigate` を使うので、ここには載せない
 * (`onGoToSettings` は M33 の `ExodusCompletedNotice` と違い画面ローカルの
 * コールバックではなく、シェルが直接 `navigate("settings")` を渡す)。
 */
export interface BackupReminderViewModel {
  readonly visible: boolean;
}

/** [M54] 起動失敗のその場通知。`visible` は `main.tsx` の `loadOrCreateState` が判定済み。 */
export interface LoadFailureViewModel {
  readonly visible: boolean;
}

/**
 * [M57] 初回ガイドの自動表示。`visible` は composition root(`main.tsx`)が
 * 「初回起動か(`booted.source === "newGame"`。セーブ復帰では出さない=検収
 * 条件)」**かつ**「まだ1度も表示していないか」(既存 `PromotionPromptTracker`
 * を再利用・`platform/` へ新規ファイルを追加しない)を AND した最終値。
 * カード送り自体の状態(`stepIndex`)はシェルが持つ揮発 UI 状態(セーブに載らない・
 * ナビ展開状態と同じ扱い)。
 */
export interface OnboardingViewModel {
  readonly visible: boolean;
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
  /** 定期バックアップ推奨バナー(M54)。省略時は描かない。 */
  readonly backupReminder?: BackupReminderViewModel;
  /** 起動失敗のその場通知(M54)。省略時は描かない。 */
  readonly loadFailure?: LoadFailureViewModel;
  /** [M57] 初回ガイドの自動表示。省略時は描かない。 */
  readonly onboarding?: OnboardingViewModel;
  /** [M59] テストプレイ加速モード。ヘッダのインジケータと＋設定画面の両方が使う。 */
  readonly testplaySpeed: TestplaySpeedController;
}

export function AppShell({
  store,
  session,
  bootTick,
  installPromotion,
  notificationOptIn,
  testplaySpeed,
  backupReminder,
  loadFailure,
  onboarding,
}: AppShellProps) {
  const [screenId, setScreenId] = useState<ScreenId>(() => session.screen());
  const [installBannerClosed, setInstallBannerClosed] = useState(false);
  const [notificationBannerClosed, setNotificationBannerClosed] = useState(false);
  const [backupReminderClosed, setBackupReminderClosed] = useState(false);
  const [loadFailureClosed, setLoadFailureClosed] = useState(false);
  // [M57] 初回ガイドのカード送り(揮発 UI 状態)。スキップ/最終カード確定の
  // どちらでも「このセッション中は隠す」(表示すべきかの永続判定は composition
  // root 側で済み・§4 と同じ「セッション中の閉鎖だけをシェルが持つ」規律)。
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingStepIndex, setOnboardingStepIndex] = useState(0);
  // ナビの展開状態は**セーブにも URL にも載らない揮発 UI 状態**(バナーの
  // 閉鎖状態と同じ扱い)。現在地の権威はあくまでルータ側にある。
  const [openGroupId, setOpenGroupId] = useState<NavGroupId | null>(null);
  // [M61/FC7] 帰還・研究完了の通知トースト(どの画面にいても届く・§1-5)。
  const globalToasts: ToastStackApi = useToastStack();

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
          {/* [2026-08-02裁定・台帳v12 必-1・FC2] 390px でチップ列が全体で
              横スクロールしていたため、時刻/研究チップ/加速インジケータが
              画面外へ押し出されていた(研究チップは台帳v10 必-1 で「作業台から
              人を外して研究が止まっていても気づけない」ことへの対策として
              入れたばかりで、見えなくては意味が無い)。この3つは**常時可視の
              固定枠**に置き、資源チップだけを横スクロール領域(下の
              kf-app__hud-scroll)へ切り出す★判断(2択案のうちの「研究チップ+⏩
              固定+資源のみスクロール」を採用)。 */}
          <ColonyClock store={store} />
          <ResearchChip store={store} />
          <TestplaySpeedIndicator controller={testplaySpeed} />
          <div class="kf-app__hud-scroll">
            <ResourceHud store={store} />
          </div>
        </div>
      </header>
      {/* [M61/FC7] 監視だけを行い何も描かない(§1-5)。トースト自体はこの下の
          ToastStackView が表示する——画面遷移しても張り直る心配が無いよう、
          ScreenHost の外(シェル直下)に置く。 */}
      <ExpeditionReturnWatcher store={store} onReturn={globalToasts.push} />
      <ResearchCompletionWatcher store={store} onComplete={globalToasts.push} />
      <ArrivalWatcher store={store} onArrival={globalToasts.push} />
      <ToastStackView toasts={globalToasts.toasts} />
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
      {loadFailure && (
        <LoadFailureBanner
          visible={loadFailure.visible && !loadFailureClosed}
          onGoToSettings={() => navigate("settings")}
          onClose={() => setLoadFailureClosed(true)}
        />
      )}
      {backupReminder && (
        <BackupReminderBanner
          visible={backupReminder.visible && !backupReminderClosed}
          onGoToSettings={() => navigate("settings")}
          onClose={() => setBackupReminderClosed(true)}
        />
      )}
      {onboarding && (
        <OnboardingGuide
          visible={onboarding.visible && !onboardingDismissed}
          stepIndex={onboardingStepIndex}
          onNext={() =>
            setOnboardingStepIndex((index) => Math.min(index + 1, ONBOARDING_STEPS.length - 1))
          }
          onSkip={() => setOnboardingDismissed(true)}
          onFinish={() => setOnboardingDismissed(true)}
        />
      )}
      <ScreenHost
        screenId={screenId}
        store={store}
        bootTick={bootTick}
        onNavigate={navigate}
        testplaySpeed={testplaySpeed}
      />
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
