// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 通知の条件分岐(M34)— GDD 13.3
//
// ===========================================================================
// 1. GDD 13.3 の要求をそのまま実装する
// ===========================================================================
//   GDD 13.3: 「通知が実機で機能する条件が満たせれば本命として実装、満たせ
//   なければ代替リテンション(日次演出・再訪ボーナス)のみで MVP を組む条件
//   分岐」。本ファイルは**その条件を実行時に判定する**部分だけを担う
//   (ロードマップ M34 行「通知の実送信ロジックは本タスク外(条件分岐と誘導の
//   み)」)。実送信(Worker cron・購読管理)は別タスクであり、ここは
//   「そもそも通知に意味があるか」を判定し、無ければ**何も追加で描画しない**
//   ——つまり代替リテンション側は「新しく作る」のではなく「①ホームハブの
//   緊急度バッジ・⑫帰還ダイジェスト・`backupReminder.ts` が既に代替リテン
//   ションそのものである」ことをもって満たす(GDD 13.3 が言う「日次演出・
//   再訪ボーナス」は M29/M31 で実装済みの既存導線と重なる)。
//
// ===========================================================================
// 2. UA 判定を書かない、機能検出だけで分岐する
// ===========================================================================
//   GDD 13.3 が挙げる制約(iOS の Push API は standalone 必須・EU DMA 制約・
//   ITP 7日ルール)はどれも「特定 OS/地域/ブラウザでは通知が使えない」という
//   **事実**だが、それを機械判定するのに `navigator.userAgent` を読む必要は
//   ない。`Notification` グローバルが無い環境・`navigator.serviceWorker` が
//   無い環境は、まさにそれらの制約が働いている環境と一致するので、素直に
//   「使える API があるか」だけを見れば同じ結論に自動的に落ちる。
//   EU DMA で将来 Safari の挙動が変わっても、UA 文字列に手を入れずに
//   追随できるのはこの設計のため。
//
// ===========================================================================
// 3. 権限取得バナー自体も「しつこくしない」(promotionPrompt.ts の再利用)
// ===========================================================================
//   ブラウザのネイティブ許可ダイアログは `Notification.permission` が
//   `"default"` の間しか意味を持たない(`"denied"` 後の再要求は多くの実装で
//   無言の即時拒否になる)。よって「もう一度出してよいか」の判定は
//   `PromotionPromptTracker` を Add-to-Home 誘導と同じ形で流用し、
//   **加えて** `permission !== "default"` なら無条件に出さない
//   ({@link shouldOfferNotificationOptIn})。
// ---------------------------------------------------------------------------

import { resolveLocalStorage, type LocalStorageLike } from "./localStorageMirror";
import {
  PromotionPromptTracker,
  loadPromotionPromptSnapshot,
  savePromotionPromptSnapshot,
  systemWallClock,
  type PromotionPromptSnapshot,
  type PromotionPromptStatus,
  type WallClock,
} from "./promotionPrompt";

/** localStorage キー(Add-to-Home 誘導とは別バナー種)。 */
export const NOTIFICATION_OPT_IN_STORAGE_KEY = "kept-flame:notification-opt-in";

/** 初回起動からの猶予(既定 24h・installPromotion.ts と同じ暫定値)。 */
export const DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS = 24 * 60 * 60 * 1000;

/** 再表示間隔(既定 7 日)。 */
export const DEFAULT_NOTIFICATION_OPT_IN_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 通算表示回数の上限(既定 5 回)。 */
export const DEFAULT_NOTIFICATION_OPT_IN_MAX_SHOWN = 5;

// --- 1. 能力検出(§2) --------------------------------------------------------

/** ブラウザの許可状態。`Notification` 非対応環境では `"unsupported"` を使う。 */
export type NotificationPermissionState = "default" | "denied" | "granted" | "unsupported";

/** {@link assessNotificationCapability} が読む最小の環境情報。 */
export interface NotificationCapabilityEnv {
  readonly hasNotificationApi: boolean;
  readonly hasServiceWorker: boolean;
  readonly permission: NotificationPermissionState;
}

/** 実行環境から {@link NotificationCapabilityEnv} を作る(本番用)。 */
export function detectNotificationCapabilityEnv(env: {
  readonly Notification?: { readonly permission: string };
  readonly navigator?: { readonly serviceWorker?: unknown };
}): NotificationCapabilityEnv {
  const hasNotificationApi = typeof env.Notification !== "undefined";
  return {
    hasNotificationApi,
    hasServiceWorker: typeof env.navigator?.serviceWorker !== "undefined",
    permission: hasNotificationApi
      ? (env.Notification!.permission as NotificationPermissionState)
      : "unsupported",
  };
}

export interface NotificationCapability {
  /** 通知を本命として使ってよいか(GDD 13.3 の分岐そのもの)。 */
  readonly viable: boolean;
  /** `viable: false` の理由(診断・テスト用。UI 文言には使わない)。 */
  readonly reasons: readonly string[];
}

/**
 * GDD 13.3 の条件分岐を評価する(§1・純関数)。
 *
 * `permission === "denied"` は「一時的に使えない」ではなく「ユーザーが
 * 明示的に拒否した」なので、`viable: false` として代替リテンション側へ倒す
 * (§3 の再要求抑制とは独立に、そもそも本命側の対象外として扱う)。
 */
export function assessNotificationCapability(
  env: NotificationCapabilityEnv,
): NotificationCapability {
  const reasons: string[] = [];
  if (!env.hasNotificationApi)
    reasons.push("Notification API 非対応(GDD 13.3: iOS 非 standalone 等)");
  if (!env.hasServiceWorker) reasons.push("ServiceWorker 非対応(バックグラウンド配送不可)");
  if (env.permission === "denied") reasons.push("通知権限が拒否済み");
  return { viable: reasons.length === 0, reasons };
}

// --- 2. 権限取得(副作用・ブラウザ専用) --------------------------------------

/** `requestNotificationPermission` が要求する最小の口。 */
export interface NotificationPermissionRequester {
  readonly Notification?: {
    requestPermission(): Promise<string>;
  };
}

/**
 * ネイティブの許可ダイアログを出す。**ユーザー操作(クリック等)のハンドラ内
 * から呼ぶこと**(多くの実装が非ユーザー操作起因の呼び出しを無視/拒否する)。
 * API 非対応環境では要求せず `"unsupported"` を返す(呼ばれても壊れない)。
 */
export async function requestNotificationPermission(
  env: NotificationPermissionRequester,
): Promise<NotificationPermissionState> {
  if (typeof env.Notification === "undefined") return "unsupported";
  const result = await env.Notification.requestPermission();
  return result as NotificationPermissionState;
}

// --- 3. 表示頻度(§3・promotionPrompt.ts の再利用) --------------------------

export function loadNotificationOptInSnapshot(
  storage: LocalStorageLike,
): PromotionPromptSnapshot | null {
  return loadPromotionPromptSnapshot(storage, NOTIFICATION_OPT_IN_STORAGE_KEY);
}

export function saveNotificationOptInSnapshot(
  storage: LocalStorageLike,
  snapshot: PromotionPromptSnapshot,
): void {
  savePromotionPromptSnapshot(storage, NOTIFICATION_OPT_IN_STORAGE_KEY, snapshot);
}

export interface CreateNotificationOptInTrackerOptions {
  readonly storage?: LocalStorageLike;
  readonly clock?: WallClock;
}

export function createNotificationOptInTracker(
  options: CreateNotificationOptInTrackerOptions = {},
): PromotionPromptTracker {
  const storage = options.storage ?? resolveLocalStorage();
  const clock = options.clock ?? systemWallClock;
  // installPromotion.ts と同じ理由で、無い場合はキーごと省略する
  // (`exactOptionalPropertyTypes`)。
  const snapshot = loadNotificationOptInSnapshot(storage);
  return new PromotionPromptTracker({
    clock,
    minElapsedSinceFirstSeenMs: DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS,
    reshowIntervalMs: DEFAULT_NOTIFICATION_OPT_IN_RESHOW_MS,
    maxShowCount: DEFAULT_NOTIFICATION_OPT_IN_MAX_SHOWN,
    ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
  });
}

/**
 * 「通知オプトイン誘導を今出すべきか」の最終判定(§3)。
 * 能力判定(§1・環境検出) AND 許可状態が未決(`"default"`) AND
 * 表示頻度トラッカーの判定、の 3 つの AND。
 */
export function shouldOfferNotificationOptIn(
  capability: NotificationCapability,
  permission: NotificationPermissionState,
  trackerStatus: PromotionPromptStatus,
): boolean {
  return capability.viable && permission === "default" && trackerStatus.shouldShow;
}
