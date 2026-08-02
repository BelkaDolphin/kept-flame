// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 用語ミニ辞典(M57)— UXレポート M-5(major)正面対応
//
// (A)/(B)技術・成文化・想起困難・習熟・大移動・継承点・晴天漂着・保管上限と
// 廃材・探索の3つの距離帯、の10語を1画面で平易に解説する(タスク指示の
// スコープそのまま)。定義文とGDD出典の対応は `./glossaryTerms.ts` を参照
// (検収条件「用語説明がGDDの定義と矛盾しないこと」)。
//
// `OnboardingGuide.tsx` と同じく hooks を持たない(`visible`/`onClose` だけを
// 受け取る)。既存ナビ(設定グループ)からは `SettingsScreen.tsx` がボタン1つで
// 開閉を制御する形で到達させる — 新しい `ScreenId` は追加しない
// (`docs/design/architecture.md` §7-3「GDD 6.6 の 12 画面を超えて増やす場合は
// GDD 側の改訂が先」を踏まえ、ルーティング語彙を増やさずに済ませる設計)。
// ---------------------------------------------------------------------------

import { GLOSSARY_TERMS } from "./glossaryTerms";
import "./onboarding.css";

export interface TermsGlossaryProps {
  readonly visible: boolean;
  readonly onClose: () => void;
}

/** 用語ミニ辞典。`visible: false` なら何も描かない(`OnboardingGuide` と同じ規律)。 */
export function TermsGlossary({ visible, onClose }: TermsGlossaryProps) {
  if (!visible) return null;

  return (
    <div class="kf-glossary" role="dialog" aria-modal="true" aria-label="用語ミニ辞典">
      <div class="kf-glossary__card">
        <h2 class="kf-glossary__title">用語ミニ辞典</h2>
        <p class="kf-glossary__intro">「継ぐ火」でよく出てくる言葉を、簡単な言葉で説明します。</p>
        <dl class="kf-glossary__list">
          {GLOSSARY_TERMS.map((entry) => (
            <div key={entry.id} class="kf-glossary__entry">
              <dt class="kf-glossary__term">{entry.term}</dt>
              <dd class="kf-glossary__definition">{entry.definition}</dd>
            </div>
          ))}
        </dl>
        <button type="button" class="kf-glossary__close" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
