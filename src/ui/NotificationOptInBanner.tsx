// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 通知オプトイン誘導バナー(M34)— GDD 13.3
//
// `InstallPromotionBanner.tsx` §1/§2 と同じ方針: hooks を持たない純関数
// (テスト可能性)、「出す意味があるか」(`platform/notificationCapability.ts`
// の `shouldOfferNotificationOptIn`)は呼び出し側で計算済みの `visible` として
// 受け取る。**通知が使えない環境では `visible` が常に `false` になり、この
// コンポーネントは何も描かない**——GDD 13.3 の「満たせなければ代替リテン
// ションのみで組む」を、"通知 UI を一切足さない" という形でそのまま体現する
// (代替リテンションは①ホームハブの緊急度バッジ・⑫帰還ダイジェスト・
// バックアップ促進が既に担っており、本コンポーネントはそこに何も追加しない)。
// ---------------------------------------------------------------------------

export interface NotificationOptInBannerProps {
  /** 呼び出し側が計算済みの最終表示可否(`shouldOfferNotificationOptIn`)。 */
  readonly visible: boolean;
  /** ネイティブの許可ダイアログを要求する(**ユーザー操作起因で呼ぶこと**)。 */
  readonly onRequestPermission: () => void;
  /** このセッション中は隠す。 */
  readonly onClose: () => void;
}

export function NotificationOptInBanner({
  visible,
  onRequestPermission,
  onClose,
}: NotificationOptInBannerProps) {
  if (!visible) return null;

  return (
    <div class="kf-promo-banner" role="region" aria-label="通知の許可">
      <p class="kf-promo-banner__title">通知を有効にしますか</p>
      <p class="kf-promo-banner__body">
        危機や探索の帰還を通知でお知らせします。許可しなくても、ホームハブのバッジや帰還ダイジェスト
        でいつでも確認できます。
      </p>
      <div class="kf-promo-banner__actions">
        <button
          type="button"
          class="kf-promo-banner__button kf-promo-banner__button--primary"
          onClick={onRequestPermission}
        >
          通知を有効にする
        </button>
        <button type="button" class="kf-promo-banner__button" onClick={onClose}>
          後で
        </button>
      </div>
    </div>
  );
}
