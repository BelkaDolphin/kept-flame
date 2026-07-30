// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- タグチップ(44×44px) — 4重符号化の完全形 (M19)
//
// `docs/design/tags-spec.md` §6.1 のレイアウトそのまま。凡例パネル
// (LegendPanel)とセル内訳ビュー(CellBreakdownView)の両方から使う共通部品。
//
// spec §0.2 設計契約2:「4重符号化の完全形はタグチップ(44px角)で常に保証される」
// ——このコンポーネントが色+記号+パターン+数値の4チャネルを**常に全部**描く
// (格子セル内マーカーは LOD で劣化しうるが、このチップは劣化しない)。
// ---------------------------------------------------------------------------

import type { Tag } from "../../../engine/adjacency";
import { TagSymbol } from "./TagIcons";
import { TAG_VISUALS, TYPOGRAPHY } from "./tagVisuals";

export interface TagChipProps {
  readonly tag: Tag;
  /** 数値プレートに出す文字列。`null`/`undefined` ならプレート自体を出さない。 */
  readonly valueText?: string | null;
  readonly title?: string;
}

/** 44×44px の完全形チップ(spec §6.1)。 */
export function TagChip({ tag, valueText, title }: TagChipProps) {
  const visual = TAG_VISUALS[tag];
  const label = title ?? visual.ja;
  return (
    <div
      class="kf-tag-chip"
      style={`border-color:${visual.ink};background:${visual.tint};`}
      title={label}
      data-tag={tag}
    >
      <TagSymbol tag={tag} variant="full" chipContext sizePx={26} title={label} />
      {valueText !== null && valueText !== undefined && (
        <span
          class="kf-tag-chip__value"
          style={`color:${visual.ink};background:${visual.tint};font-family:${TYPOGRAPHY.stack};`}
        >
          {valueText}
        </span>
      )}
    </div>
  );
}
