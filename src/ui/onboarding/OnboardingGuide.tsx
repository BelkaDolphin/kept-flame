// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 初回ガイド(M57)— UXレポート M-5(major)正面対応
//
// ===========================================================================
// 1. 表示条件(検収条件「初回起動でのみ出る」)
// ===========================================================================
//   このコンポーネント自身は「今表示すべきか」を一切判定しない
//   (`RejectionBanner.tsx` 等と同じ「判定を画面に書かない」規律・
//   architecture.md §6 の7箇条目)。判定は2箇所:
//     - 自動初回表示: composition root(`src/main.tsx`)が
//       `booted.source === "newGame"`(セーブ復帰でない)**かつ**
//       `PromotionPromptTracker`(既存 M34 実装をそのまま再利用・`platform/`
//       へ新規ファイルを追加しない=タスク制約)の `shouldShow`(= まだ
//       1度も表示していない)を AND した最終値を `AppShell` の
//       `OnboardingViewModel.visible` として渡す。
//     - 手動再表示: `SettingsScreen.tsx` の「初回ガイドをもう一度見る」ボタンが
//       トラッカーを介さず直接 `visible=true` にする(タスク指示「後から設定
//       画面で再表示可能に」)。
//   本コンポーネントは**hooks を持たない**(`stepIndex` は呼び出し側の状態)。
//   `ResetGameSection`/`TestplaySpeedSection`(SettingsScreen.tsx)と同じ
//   「値とコールバックだけを props で受ける」形にしてあるので、Preact の
//   render() を通さず直接呼んでテストできる(このリポジトリの vitest は
//   jsdom 無し=ADR-001。hooks を持つ画面本体が登録テストのみで済ませている
//   のと同じ理由)。
//
// ===========================================================================
// 2. スキップ可能・数ステップの軽いカード列(タスク指示のスコープそのまま)
// ===========================================================================
//   文言は `./steps.ts`(データ)に分離。GDD 該当節の出典はそちらのコメント参照。
// ---------------------------------------------------------------------------

import {
  ONBOARDING_FINISH_LABEL,
  ONBOARDING_NEXT_LABEL,
  ONBOARDING_SKIP_LABEL,
  ONBOARDING_STEPS,
} from "./steps";
import "./onboarding.css";

export interface OnboardingGuideProps {
  readonly visible: boolean;
  /** 現在のカード(0始まり)。範囲外は呼び出し側のバグなので clamp して描く。 */
  readonly stepIndex: number;
  /** 「次へ」(最終カードでは呼ばれない=呼び出し側が isLastStep を見て出し分ける)。 */
  readonly onNext: () => void;
  /** どのカードからでも押せる。 */
  readonly onSkip: () => void;
  /** 最終カードの確定ボタン。 */
  readonly onFinish: () => void;
}

/**
 * 初回ガイド。`visible: false` なら何も描かない
 * (= DOM に出さない・`InstallPromotionBanner` と同じ規律)。
 */
export function OnboardingGuide({
  visible,
  stepIndex,
  onNext,
  onSkip,
  onFinish,
}: OnboardingGuideProps) {
  if (!visible) return null;

  const lastIndex = ONBOARDING_STEPS.length - 1;
  const clampedIndex = Math.min(Math.max(stepIndex, 0), lastIndex);
  const step = ONBOARDING_STEPS[clampedIndex]!;
  const isLastStep = clampedIndex === lastIndex;

  return (
    <div class="kf-onboarding" role="dialog" aria-modal="true" aria-label="初回ガイド">
      <div class="kf-onboarding__card">
        <p class="kf-onboarding__progress">
          {clampedIndex + 1} / {ONBOARDING_STEPS.length}
        </p>
        <h2 class="kf-onboarding__title">{step.title}</h2>
        <p class="kf-onboarding__body">{step.body}</p>
        <ul class="kf-onboarding__dots" aria-hidden="true">
          {ONBOARDING_STEPS.map((entry, index) => (
            <li
              key={entry.id}
              class={
                index === clampedIndex
                  ? "kf-onboarding__dot kf-onboarding__dot--active"
                  : "kf-onboarding__dot"
              }
            />
          ))}
        </ul>
        <div class="kf-onboarding__actions">
          <button type="button" class="kf-onboarding__skip" onClick={onSkip}>
            {ONBOARDING_SKIP_LABEL}
          </button>
          {isLastStep ? (
            <button type="button" class="kf-onboarding__finish" onClick={onFinish}>
              {ONBOARDING_FINISH_LABEL}
            </button>
          ) : (
            <button type="button" class="kf-onboarding__next" onClick={onNext}>
              {ONBOARDING_NEXT_LABEL}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
