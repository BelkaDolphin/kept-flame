// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- Add-to-Home 誘導バナー(M34)— GDD 13.4 / ADR-004(1)
//
// ===========================================================================
// 1. hooks を持たない(テスト可能性・RejectionBanner.tsx と同じ方針)
// ===========================================================================
//   vitest は jsdom 無し(`environment: "node"`)なので、hooks を使う
//   コンポーネントは Preact の render() を経由しないと実行できず、直接呼ぶ
//   単体テストが書けない(`tests/ui/screens/appShell.test.ts` 冒頭コメント)。
//   本コンポーネントは「出すか出さないか」も「もう表示済みとして記録する
//   タイミング」も呼び出し側(composition root = `src/main.tsx` / シェル =
//   `AppShell.tsx`)に前倒しして計算させ、自身は props をそのまま描くだけの
//   純関数にしてある。これにより `UrgencyBadge` と同じやり方で直接呼び出して
//   検証できる。
//
// ===========================================================================
// 2. 「出す意味があるか」と「今出すべきか」を混ぜない(architecture.md §1 規則2)
// ===========================================================================
//   `visible` は呼び出し側で以下を先に AND 済みにした最終値:
//     - `platform/installPromotion.ts` の `PromotionPromptTracker.status().shouldShow`
//       (最終起動 monotonicTimestamp のみに基づく判定・ロードマップ M34 検分)
//     - `!isStandaloneDisplayMode(...)`(既にホーム画面から起動済みなら無意味)
//   本コンポーネントはこの 2 つの計算式を知らない(= 二重実装しない)。
// ---------------------------------------------------------------------------

export interface InstallPromotionBannerProps {
  /** 呼び出し側が計算済みの最終表示可否(§2)。 */
  readonly visible: boolean;
  /**
   * `beforeinstallprompt` を受信済みでネイティブダイアログを出せるか
   * (`platform/installPromptEvent.ts`)。`false` ならテキスト誘導のみ表示する
   * (iOS Safari 等・GDD 13.3/13.4)。
   */
  readonly canPromptDirectly: boolean;
  /** ネイティブダイアログを出す(`canPromptDirectly` のときだけ呼ばれる)。 */
  readonly onInstall: () => void;
  /** このセッション中は隠す(閉じるボタン)。 */
  readonly onClose: () => void;
}

/**
 * Add-to-Home 誘導バナー。`visible: false` なら何も描かない
 * (= マウントしたまま何も見えない、ではなく DOM に出さない)。
 */
export function InstallPromotionBanner({
  visible,
  canPromptDirectly,
  onInstall,
  onClose,
}: InstallPromotionBannerProps) {
  if (!visible) return null;

  return (
    <div class="kf-promo-banner" role="region" aria-label="ホーム画面への追加">
      <p class="kf-promo-banner__title">ホーム画面に追加しませんか</p>
      <p class="kf-promo-banner__body">
        {canPromptDirectly ? (
          <>アプリのように起動でき、遊びに戻る導線が分かりやすくなります。</>
        ) : (
          <>
            共有メニュー(またはブラウザメニュー)から「ホーム画面に追加」を選ぶと、アプリのように
            起動できます。
          </>
        )}
      </p>
      <div class="kf-promo-banner__actions">
        {canPromptDirectly && (
          <button
            type="button"
            class="kf-promo-banner__button kf-promo-banner__button--primary"
            onClick={onInstall}
          >
            ホーム画面に追加
          </button>
        )}
        <button type="button" class="kf-promo-banner__button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
