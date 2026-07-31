// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- コマンド拒否の表示(M30)— architecture.md §4-1 / §6
//
// ②③④のいずれも「置けるか/払えるか」を先読みせず、engine の `apply` が返す
// 拒否(`DispatchResult.command.rejection`)をそのまま見せる(黙って何も
// 起きない、を作らない・commands.ts §3)。3 画面が同じ見せ方をするので
// ここへ 1 箇所へ集約する。
// ---------------------------------------------------------------------------

import type { CommandRejection } from "../../engine/commands";

export interface RejectionBannerProps {
  readonly rejection: CommandRejection;
}

/** `message` は表示専用(分岐は `code` 側でのみ行う・commands.ts §2)。 */
export function RejectionBanner({ rejection }: RejectionBannerProps) {
  return (
    <p class="kf-rejection-banner" role="alert" data-rejection-code={rejection.code}>
      {rejection.message}
    </p>
  );
}
