// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- コマンド拒否の表示(M30・束B/B-1で語化)
// — architecture.md §4-1 / §6
//
// ②③④⑤⑥⑦⑨⑩⑪のいずれも「置けるか/払えるか」を先読みせず、engine の
// `apply` が返す拒否(`DispatchResult.command.rejection`)をそのまま見せる
// (黙って何も起きない、を作らない・commands.ts §3)。全画面が同じ見せ方を
// するので、ここへ 1 箇所へ集約する。
//
// [束B/B-1] engine の `rejection.message` は開発者向けの機械可読寄りの文言
// (1e6 raw 値・英字 ID を含む)なので、**そのまま表示せず**
// `rejectionMessages.ts` の `playerRejectionMessage`(`code` → 日本語文の
// マッピング)を通す。engine 側の `message` 文字列自体は 1 文字も変更しない
// (このファイルも rejectionMessages.ts も commands.ts を読むだけ)。
//
// 元の `message`(デバッグ用)は `title` 属性と `data-original-message` 属性の
// 両方に残す。
// ---------------------------------------------------------------------------

import type { CommandRejection } from "../../engine/commands";
import { playerRejectionMessage } from "./rejectionMessages";

export interface RejectionBannerProps {
  readonly rejection: CommandRejection;
}

/** 分岐は `code` 側でのみ行う規約(commands.ts §2)。表示文言は上記参照。 */
export function RejectionBanner({ rejection }: RejectionBannerProps) {
  return (
    <p
      class="kf-rejection-banner"
      role="alert"
      data-rejection-code={rejection.code}
      data-original-message={rejection.message}
      title={rejection.message}
    >
      {playerRejectionMessage(rejection)}
    </p>
  );
}
