// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 定期バックアップ推奨バナー(M54)— GDD 13.4 / ADR-004 の精神
//
// `InstallPromotionBanner.tsx`/`NotificationOptInBanner.tsx` §1/§2 と同じ方針:
// hooks を持たない純関数(テスト可能性)、「出すべきか」は呼び出し側
// (composition root = `src/main.tsx`)が `platform/backupReminder.ts` の
// 2 層判定(データ条件 `BackupReminderTracker` AND 表示頻度
// `PromotionPromptTracker`)を先に済ませた `visible` として渡す。
//
// 大移動直後の `ExodusCompletedNotice`(migration/MigrationScreen.tsx)とは
// 別の導線である——あちらは「継承点を獲得した直後」という**イベント駆動**、
// 本バナーは「最後にエクスポートしてから時間/操作が経った」という**周期駆動**
// (ロードマップ M54 行の検分条件そのもの)。
// ---------------------------------------------------------------------------

export interface BackupReminderBannerProps {
  /** 呼び出し側が計算済みの最終表示可否(§2)。 */
  readonly visible: boolean;
  /** ＋設定画面(エクスポート)へ遷移する。 */
  readonly onGoToSettings: () => void;
  /** このセッション中は隠す(閉じるボタン)。 */
  readonly onClose: () => void;
}

/**
 * 定期バックアップ推奨バナー。`visible: false` なら何も描かない
 * (= DOM に出さない・InstallPromotionBanner と同じ規律)。
 */
export function BackupReminderBanner({
  visible,
  onGoToSettings,
  onClose,
}: BackupReminderBannerProps) {
  if (!visible) return null;

  return (
    <div class="kf-promo-banner" role="region" aria-label="バックアップのお願い">
      <p class="kf-promo-banner__title">セーブのバックアップをお願いします</p>
      <p class="kf-promo-banner__body">
        しばらくエクスポートしていません。進行状況はこの端末にしか無いので、＋設定画面から
        エクスポートしておくと、うっかり消えても復元できます。
      </p>
      <div class="kf-promo-banner__actions">
        <button
          type="button"
          class="kf-promo-banner__button kf-promo-banner__button--primary"
          onClick={onGoToSettings}
        >
          ＋設定画面へ
        </button>
        <button type="button" class="kf-promo-banner__button" onClick={onClose}>
          後で
        </button>
      </div>
    </div>
  );
}
