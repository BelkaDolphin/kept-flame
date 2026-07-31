// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- `beforeinstallprompt` の薄いラッパ(M34)— GDD 13.4
//
// ===========================================================================
// 1. このファイルが解く問題
// ===========================================================================
//   Chromium 系(Chrome/Edge/Android)は `beforeinstallprompt` イベントを
//   発火し、`event.prompt()` でネイティブのインストールダイアログを
//   ワンタップで出せる。**iOS Safari はこのイベントを一切発火しない**
//   (GDD 13.3 が言う「iOS の制約」の 1 つ)。本ファイルはこの非対称を
//   「イベントが来るかどうか」という**実行時の観測**だけで扱い、UA 判定は
//   1 行も書かない——`installPromotion.ts` の「判定を環境検出 API に依存
//   させない」方針と同じ理由(ブラウザ実装の変化に対して壊れにくい)。
//
//   イベントが来なかった環境では {@link InstallPromptController.promptInstall}
//   が `"unavailable"` を返すだけで、呼び出し側(UI)はそれを「ネイティブの
//   ワンタップ導線が無い」= 手順テキストで誘導する分岐として扱う
//   (`src/ui/InstallPromotionBanner.tsx`)。
//
// ===========================================================================
// 2. DOM を直接掴まない(テスト可能性・router.ts §4 と同じ方針)
// ===========================================================================
//   `window.addEventListener` を直に書くと vitest(`environment: "node"`・
//   jsdom 無し)で 1 行もテストできない。{@link InstallPromptWindowLike} という
//   最小の口を切り、本番は `window` をそのまま渡し、テストは
//   イベントリスナーを保持するだけの偽物を渡す。
//
// ===========================================================================
// 3. `preventDefault()` する理由
// ===========================================================================
//   既定動作(Chrome の自動ミニインフォバー)を許すと、本アプリの誘導バナー
//   (`InstallPromotionBanner`)と表示頻度の制御が二重になり、
//   `platform/installPromotion.ts` の「しつこくしない」設計が意味を失う。
//   `preventDefault()` して唯一の入口をこちらの誘導バナーへ揃える。
// ---------------------------------------------------------------------------

/**
 * `beforeinstallprompt` イベント(非標準・Chromium 系のみ)。DOM 標準の
 * `lib.dom.d.ts` に型定義が無いため、実際に読む部分だけ最小に宣言する。
 */
export interface BeforeInstallPromptEvent {
  preventDefault(): void;
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/** 本ファイルが `window` に要求する最小の口(§2)。 */
export interface InstallPromptWindowLike {
  addEventListener(
    type: "beforeinstallprompt",
    listener: (event: BeforeInstallPromptEvent) => void,
  ): void;
  addEventListener(type: "appinstalled", listener: () => void): void;
  removeEventListener(
    type: "beforeinstallprompt",
    listener: (event: BeforeInstallPromptEvent) => void,
  ): void;
  removeEventListener(type: "appinstalled", listener: () => void): void;
}

export type InstallPromptState =
  /** イベント未受信(iOS 等・または未だ来ていない)。 */
  | "unavailable"
  /** イベント受信済み。`promptInstall()` を呼べる。 */
  | "available"
  /** ユーザーがネイティブダイアログで「インストール」を選んだ。 */
  | "accepted"
  /** ユーザーがネイティブダイアログを閉じた/キャンセルした。 */
  | "dismissed"
  /** `appinstalled` イベントで確定(既にインストール済み)。 */
  | "installed";

export interface InstallPromptController {
  getState(): InstallPromptState;
  /**
   * ネイティブのインストールダイアログを出す。
   * イベント未受信なら何もせず `"unavailable"` を返す(呼び出し側はテキスト
   * 誘導へフォールバックする・§1)。
   */
  promptInstall(): Promise<"accepted" | "dismissed" | "unavailable">;
  /** イベント購読を解除する。 */
  dispose(): void;
}

/** 本番/テスト共通の組み立て。`win` は本番なら `window` をそのまま渡す。 */
export function createInstallPromptController(
  win: InstallPromptWindowLike,
): InstallPromptController {
  let deferred: BeforeInstallPromptEvent | null = null;
  let state: InstallPromptState = "unavailable";

  const onBeforeInstallPrompt = (event: BeforeInstallPromptEvent): void => {
    event.preventDefault(); // §3
    deferred = event;
    state = "available";
  };

  const onAppInstalled = (): void => {
    deferred = null;
    state = "installed";
  };

  win.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  win.addEventListener("appinstalled", onAppInstalled);

  return {
    getState: () => state,

    async promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
      if (deferred === null) return "unavailable";
      const event = deferred;
      deferred = null;
      await event.prompt();
      const choice = await event.userChoice;
      state = choice.outcome;
      return choice.outcome;
    },

    dispose(): void {
      win.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      win.removeEventListener("appinstalled", onAppInstalled);
    },
  };
}
