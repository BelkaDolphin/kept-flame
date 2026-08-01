// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 起動失敗のその場通知(M54)— ADR-012 の「破損は黙って直さない」の UI 側
//
// `src/main.tsx` の `loadOrCreateState` は、セーブは**あったのに読めなかった**
// 場合(`SaveIntegrityError`/`SaveMigrationError`等・`SaveNotFoundError` は
// 除く=初回起動と区別する)、黙って新規ゲームへフォールバックしていた
// (M29 以来の申し送り・`docs/design/ui-spec.md` §7-8)。本バナーはその場で
// 「読めなかった」ことを伝え、＋設定画面の常設インポートフォーム
// (`SettingsScreen.tsx` の `ImportPanel`)へ導く——起動自体は壊さず、
// 気づきだけを足す。
//
// hooks を持たない純関数(`InstallPromotionBanner.tsx` と同じテスト可能性の方針)。
// ---------------------------------------------------------------------------

export interface LoadFailureBannerProps {
  /** 呼び出し側(main.tsx)が計算済みの表示可否(読込失敗が実際に起きたか)。 */
  readonly visible: boolean;
  /** ＋設定画面(インポート/復元フォーム)へ遷移する。 */
  readonly onGoToSettings: () => void;
  /** このセッション中は隠す(閉じるボタン)。 */
  readonly onClose: () => void;
}

/**
 * 起動失敗バナー。`visible: false` なら何も描かない
 * (= DOM に出さない・InstallPromotionBanner と同じ規律)。
 */
export function LoadFailureBanner({ visible, onGoToSettings, onClose }: LoadFailureBannerProps) {
  if (!visible) return null;

  return (
    <div class="kf-promo-banner" role="alert" aria-label="セーブの読み込みに失敗しました">
      <p class="kf-promo-banner__title">セーブを読み込めませんでした</p>
      <p class="kf-promo-banner__body">
        保存されていたデータの読み込みに失敗したため、新しいゲームとして開始しています。
        以前エクスポートしたファイルがあれば、＋設定画面のインポートから復元できます。
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
          閉じる
        </button>
      </div>
    </div>
  );
}
