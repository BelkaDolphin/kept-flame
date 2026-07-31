// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- (A)/(B) 二層バッジ(M31)— GDD 7.4
//
// ⑤研究ツリー/⑥成文化キューの両方が「常時判別可能」(GDD 7.4・ロードマップ
// M31 行の検収条件)にする必要がある表示なので、RejectionBanner.tsx と同じ
// 理由で 1 箇所へ共通化する(2 画面が同じ見せ方をする・architecture.md §6)。
//
// 配色は tags-spec.md のタグ ink/tint を再利用しない(タグとは別軸の概念)。
// 代わりに①⑫の緊急度バッジ(`--kf-urgency-*`・docs/design/ui-spec.md §3.3)を
// 転用する: (B) rareIrreversible は「実際に喪失へ近づく」ことこそ赤バッジの
// 点灯条件そのもの(derived.ts の `bLossImminentTechIds`)なので critical と
// 同じ配色、(A) criticalRecoverable は「失っても停滞コストのみ」なので info
// と同じ配色。**新しい色は 1 つも作らない**(意匠の最終確認はユーザー目視を
// 推奨・M19★4/§3.3 末尾と同じ扱い=★報告)。
// ---------------------------------------------------------------------------

import type { TechLossClass } from "../../engine/rules/types";
import "./lossClassBadge.css";

export interface LossClassBadgeProps {
  readonly lossClass: TechLossClass;
}

/**
 * (A)/(B) の二層バッジ。**色だけに頼らない**(記号 "A"/"B" + 日本語ラベルを
 * 必ず併記・ui-spec §0-6 の「色だけで意味を運ばない」規約)。(B) のラベルは
 * 「取り返しがつかない」ことがテキストそのもので読み取れる文言にしてある
 * (GDD 7.4 の検収条件を色ではなく文章で満たす)。
 */
export function LossClassBadge({ lossClass }: LossClassBadgeProps) {
  const irreversible = lossClass === "rareIrreversible";
  return (
    <span
      class={`kf-lossclass-badge kf-lossclass-badge--${irreversible ? "b" : "a"}`}
      data-loss-class={lossClass}
    >
      <span aria-hidden="true">{irreversible ? "B" : "A"}</span>
      {irreversible ? "一回性喪失(取り返し不可)" : "再取得可能"}
    </span>
  );
}
