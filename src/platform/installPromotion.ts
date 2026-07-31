// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- Add-to-Home 誘導バナーの判定(M34)— GDD 13.3/13.4・ADR-004(1)
//
// ===========================================================================
// 1. 検収条件への直接の回答
// ===========================================================================
//   ロードマップ M34 行の検分: 「バナー判定が最終起動 monotonicTimestamp の
//   みに依存しているか」。{@link createInstallPromotionTracker} が返す
//   `PromotionPromptTracker`(promotionPrompt.ts)の `status().shouldShow` は
//   `firstSeenAt` / `lastShownAt` / `shownCount` という**ローカルに記録した
//   時刻・回数だけ**の関数であり、ITP・クッキー・`getInstalledRelatedApps()`
//   のようなインストール状態 API を 1 つも読まない。
//
//   {@link isStandaloneDisplayMode} は**この判定に混ぜていない**。既に
//   ホーム画面から起動されている(standalone)ユーザーへ「ホーム画面に追加」を
//   促すこと自体が無意味なので、呼び出し側(UI 側)がこの関数の結果で
//   バナーの描画そのものを止める——「出す意味があるか」(標準の環境検出)と
//   「出しすぎていないか」(タイムスタンプ判定)を混ぜない、という
//   promotionPrompt.ts §2 の分離をここでも保つ。
//
// ===========================================================================
// 2. 既定のしきい値は暫定値(要ユーザー判断・backupReminder.ts §1 と同じ状況)
// ===========================================================================
//   ADR-004(1) は「標準/非標準の分岐は促進強度の調整のみ」と述べるが、
//   具体的な猶予・再表示間隔・上限回数までは明文化していない。本実装は
//   3 つとも暫定値を置く:
//     - 初回起動からの猶予(`DEFAULT_INSTALL_PROMOTION_GRACE_MS`):
//       GDD 13.4「オンボーディング後半」の意図を汲み、初回起動の瞬間には
//       出さない(操作を覚える前に離脱導線を見せない)。オンボーディング画面
//       自体は未実装(newGame.ts は暫定・ui-spec §7-7)なので、実時間の
//       猶予で代替している。
//     - 再表示間隔(`DEFAULT_INSTALL_PROMOTION_RESHOW_MS`):
//       「しつこくしない」の本体。backupReminder.ts の 24h よりも長い値を
//       置く(エクスポート促進は喪失防止で急ぐ理由があるが、こちらは無くても
//       即座の実害が無い誘導のため)。
//     - 通算表示回数上限(`DEFAULT_INSTALL_PROMOTION_MAX_SHOWN`):
//       「いつかは黙る」の本体。何度出しても入れない意思のユーザーに永久に
//       出し続けない。
//
// ===========================================================================
// 3. 永続化は呼び出し側の責務(backupReminder.ts §0 と同じ設計)
// ===========================================================================
//   `PromotionPromptTracker` 自体は I/O を持たない。本ファイルが
//   localStorage との往復(`load`/`save`)を薄く提供し、実際にいつ読み書き
//   するか(起動時に読む・表示直後に書く)は composition root(`src/main.tsx`)
//   が決める。private モード等で localStorage が使えない場合、
//   `resolveLocalStorage()`(localStorageMirror.ts)が例外を投げる代わりに
//   フェイルの getter/setter を返すので、load は常に `null`、save は
//   黙って何もしない(バナーは「毎回初見扱い」に縮退するだけで、起動その
//   ものは壊れない)。
// ---------------------------------------------------------------------------

import { resolveLocalStorage, type LocalStorageLike } from "./localStorageMirror";
import {
  PromotionPromptTracker,
  loadPromotionPromptSnapshot,
  savePromotionPromptSnapshot,
  systemWallClock,
  type PromotionPromptSnapshot,
  type WallClock,
} from "./promotionPrompt";

/** localStorage キー。セーブ本体(`persistence.ts`)とは名前空間を分ける。 */
export const INSTALL_PROMOTION_STORAGE_KEY = "kept-flame:install-promotion";

/** 初回起動からの猶予(既定 24h・§2、暫定値)。 */
export const DEFAULT_INSTALL_PROMOTION_GRACE_MS = 24 * 60 * 60 * 1000;

/** 再表示間隔(既定 7 日・§2、暫定値)。 */
export const DEFAULT_INSTALL_PROMOTION_RESHOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 通算表示回数の上限(既定 5 回・§2、暫定値)。 */
export const DEFAULT_INSTALL_PROMOTION_MAX_SHOWN = 5;

// --- 1. スタンドアロン検出(強度調整/描画抑止のみ・判定には混ぜない・§1) -----

/**
 * {@link isStandaloneDisplayMode} が読む最小の環境。実体は `window`。
 * `matchMedia` を持たない環境(古い WebView 等)では常に `false` 側へ倒れる
 * (= バナーを出す側。「判定できないから出さない」という誤検出よりは、
 * 「余計に 1 回出るがユーザーは無視できる」方を安全側とみなす)。
 */
export interface StandaloneEnv {
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
  readonly navigator?: { readonly standalone?: boolean };
}

/**
 * 既にホーム画面から起動されている(standalone)かの検出。
 *
 * `navigator.standalone`(iOS Safari 独自・非標準)と
 * `matchMedia('(display-mode: standalone)')`(標準・Chromium/Firefox 系)の
 * 両方を見る。**このどちらも「無い」ことをもって喪失挙動を仮定しない**
 * (ADR-004 が撤回した旧設計の教訓): API が無ければ単に `false`(＝標準の
 * ブラウザタブ扱い)を返すだけで、バナー判定(§1)そのものは別関数に委ねる。
 */
export function isStandaloneDisplayMode(env: StandaloneEnv): boolean {
  if (env.navigator?.standalone === true) return true;
  if (typeof env.matchMedia === "function") {
    return env.matchMedia("(display-mode: standalone)").matches;
  }
  return false;
}

// --- 2. 永続化(§3・実体は promotionPrompt.ts §4 の共有ヘルパ) ---------------

/** 保存済みスナップショットを読む。無い/壊れている場合は `null`(§3)。 */
export function loadInstallPromotionSnapshot(
  storage: LocalStorageLike,
): PromotionPromptSnapshot | null {
  return loadPromotionPromptSnapshot(storage, INSTALL_PROMOTION_STORAGE_KEY);
}

/** スナップショットを保存する。書けなくても致命ではない(§3)。 */
export function saveInstallPromotionSnapshot(
  storage: LocalStorageLike,
  snapshot: PromotionPromptSnapshot,
): void {
  savePromotionPromptSnapshot(storage, INSTALL_PROMOTION_STORAGE_KEY, snapshot);
}

// --- 3. 組み立て -------------------------------------------------------------

export interface CreateInstallPromotionTrackerOptions {
  readonly storage?: LocalStorageLike;
  readonly clock?: WallClock;
}

/**
 * 本番用のトラッカーを組み立てる(§2 の既定値 + 永続化済みスナップショット)。
 * `storage`/`clock` はテスト用に差し替え可能(既定は実 localStorage・壁時計)。
 */
export function createInstallPromotionTracker(
  options: CreateInstallPromotionTrackerOptions = {},
): PromotionPromptTracker {
  const storage = options.storage ?? resolveLocalStorage();
  const clock = options.clock ?? systemWallClock;
  // `exactOptionalPropertyTypes` の下では `initialSnapshot: undefined` を明示
  // 渡すこと自体が型エラーになるため、無い場合はキーごと省略する
  // (state/serialize.ts の「省略なら undefined」正準化と同じ考え方)。
  const snapshot = loadInstallPromotionSnapshot(storage);
  return new PromotionPromptTracker({
    clock,
    minElapsedSinceFirstSeenMs: DEFAULT_INSTALL_PROMOTION_GRACE_MS,
    reshowIntervalMs: DEFAULT_INSTALL_PROMOTION_RESHOW_MS,
    maxShowCount: DEFAULT_INSTALL_PROMOTION_MAX_SHOWN,
    ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
  });
}
