// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 凡例パネル(GDD 6.5 MVP要件) (M19)
//
// 「タグ7種×過密閾値×加算/クランプを初見が読み取れるようにする」(GDD 6.5)。
// tags-spec.md §8.1-1「7種のタグチップ(44px)を全チャネル込みで並べ、タグ名・
// 数値・パターンを表示」の実装。
//
// 過密閾値/ペナルティは content(`adjacency.json`)由来の実数値であり、ここに
// 決め打ちしない(±60%クランプだけは GDD 6.3 裁定N2で engine 定数と確定済み
// なので文言に含めてよい)。呼び出し側(将来の M30 画面合成)が実際の
// `AdjacencyMatrix.overcrowd` を渡せるよう props 経由にし、渡されなければ
// 汎用文言に留める(実値を捏造しない)。
// ---------------------------------------------------------------------------

import { ADJACENCY_TAGS } from "../../../engine/adjacency";
import { TagChip } from "./TagChip";
import { TagIconDefs } from "./TagIcons";
import { ADJACENCY_BONUS_CLAMP_PCT_NOTE, TAG_VISUALS, TYPOGRAPHY } from "./tagVisuals";
import "./gridBoard.css";

export interface LegendOvercrowdInfo {
  readonly threshold: number;
  readonly penaltyPerExcessPercent: number;
}

export interface LegendPanelProps {
  /** content(`adjacency.json`)由来の実値。省略時は汎用文言のみ表示する。 */
  readonly overcrowd?: LegendOvercrowdInfo;
  /** 文書に既に `TagIconDefs` がある場合は false にして二重挿入を避ける(M30 の画面合成用)。 */
  readonly includeIconDefs?: boolean;
}

export function LegendPanel({ overcrowd, includeIconDefs = true }: LegendPanelProps) {
  return (
    <section class="kf-legend" aria-label="タグ凡例" style={`font-family:${TYPOGRAPHY.stack};`}>
      {includeIconDefs && <TagIconDefs />}
      <h2 class="kf-legend__title">タグ凡例</h2>
      <ul class="kf-legend__list">
        {ADJACENCY_TAGS.map((tag) => {
          const visual = TAG_VISUALS[tag];
          return (
            <li class="kf-legend__row" key={tag}>
              <TagChip tag={tag} />
              <span class="kf-legend__label">{visual.ja}</span>
            </li>
          );
        })}
      </ul>
      <p class="kf-legend__note">数値の単位 = %(セル/チップの数値チャネル)。</p>
      <p class="kf-legend__note">
        全ボーナスは加算後に単一係数 {ADJACENCY_BONUS_CLAMP_PCT_NOTE} クランプ。
      </p>
      {overcrowd !== undefined && (
        <p class="kf-legend__note">
          同一タグが8近傍(大型施設は占有矩形の外周)に {overcrowd.threshold}
          個以上密集すると {overcrowd.threshold} 個目以降のボーナスが無効化され、超過1件につき
          {overcrowd.penaltyPerExcessPercent > 0 ? "+" : ""}
          {overcrowd.penaltyPerExcessPercent}% のペナルティが加わる(常時過密警告バッジで表示)。
        </p>
      )}
    </section>
  );
}
