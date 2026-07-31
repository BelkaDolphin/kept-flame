// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 未実装画面のプレースホルダ(M29)
//
// M29 は「12画面ぶんのルーティングを登録する」ところまでを担当し、②〜⑪ + 設定の
// 中身は M30〜M33 が作る。ルートだけ先に通しておくと:
//   - ①ホームハブのワンタップ遷移(GDD 6.6)を今すぐ全部踏める
//   - URL 直打ち・ブックマークが後から壊れない(語彙は screens.ts で確定済み)
//   - 「押したのに何も起きない」を作らない(architecture.md の設計方針)
//
// 画面名 + 担当タスク名を出すだけの最小実装であり、**存在しない情報を捏造しない**
// (ダミーの数値やグラフを置かない)。
// ---------------------------------------------------------------------------

import { SCREEN_META, type ScreenId } from "../screens";
import { useScreenMount } from "./useStoreSignal";
import type { ScreenProps } from "./screenProps";

export interface PlaceholderScreenProps extends ScreenProps {
  readonly screenId: ScreenId;
  /** 実装担当のロードマップタスク ID(例 `"M30"`)。 */
  readonly ownerTask: string;
}

export function PlaceholderScreen({
  store,
  screenId,
  ownerTask,
  onNavigate,
}: PlaceholderScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, screenId, { activate: false });
  const meta = SCREEN_META[screenId];

  return (
    <section class="kf-placeholder" aria-labelledby={`kf-placeholder-${screenId}`}>
      <h2 class="kf-placeholder__title" id={`kf-placeholder-${screenId}`}>
        {meta.order === null ? "" : `${String(meta.order)}. `}
        {meta.label}
      </h2>
      <p class="kf-placeholder__task">未実装({ownerTask})</p>
      <button type="button" class="kf-placeholder__back" onClick={() => onNavigate("home")}>
        ホームハブへ戻る
      </button>
    </section>
  );
}
