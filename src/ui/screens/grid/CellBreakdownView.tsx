// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- セル内訳ビュー(GDD 6.5 MVP要件) (M19)
//
// 「セルタップで『このセルの数値内訳(どの隣接が+何%、過密で−何%)』を表示」。
// `adjacencyBreakdown.ts` が組み立てた `CellAdjacencyBreakdown` をそのまま描く。
//
// spec §9-7 解消済み: このビューは44pxチップの桁数制約を受けない
// (`formatRawPercent` = クランプ前の生係数を小数第1位まで表示)。
//
// **[2026-07-30裁定]** 過密バッジの engine 値 `overcrowdedNeighborCount` は
// 「(タグ,施設)の超過ペア数」であって施設数ではない——本ビューはタグ別に
// `excessAnchors.length` を分解して表示することで、この裁定を満たす
// (ロードマップ M19 行の申し送り)。
// ---------------------------------------------------------------------------

import { cellIdOf } from "../../../engine/adjacency";
import { toApproxNumber } from "../../../engine/fp";
import { cellCoordinateLabel } from "../cellCoordinate";
import type { CellAdjacencyBreakdown } from "./adjacencyBreakdown";
import { TagChip } from "./TagChip";
import { TagIconDefs } from "./TagIcons";
import { TAG_VISUALS, formatRawPercent, TYPOGRAPHY } from "./tagVisuals";

export interface CellBreakdownViewProps {
  readonly cellId: string | null;
  readonly breakdown: CellAdjacencyBreakdown | null;
  readonly includeIconDefs?: boolean;
}

export function CellBreakdownView({
  cellId,
  breakdown,
  includeIconDefs = true,
}: CellBreakdownViewProps) {
  return (
    <section
      class="kf-breakdown"
      aria-label="セル内訳ビュー"
      style={`font-family:${TYPOGRAPHY.stack};`}
    >
      {includeIconDefs && <TagIconDefs />}
      <h2 class="kf-breakdown__title">
        内訳{cellId !== null ? `(${cellCoordinateLabel(cellId)})` : ""}
      </h2>
      {breakdown === null ? (
        <p class="kf-breakdown__empty">施設を選択すると内訳が表示されます。</p>
      ) : (
        <>
          <p class="kf-breakdown__summary">
            最終乗数 ×{toApproxNumber(breakdown.multiplierFix).toFixed(2)}(ボーナス合計{" "}
            {formatRawPercent(toApproxNumber(breakdown.bonusFix))} / 過密ペナ{" "}
            {formatRawPercent(toApproxNumber(breakdown.overcrowdPenaltyFix))})
          </p>
          {breakdown.buckets.length === 0 ? (
            <p class="kf-breakdown__empty">隣接する施設がありません。</p>
          ) : (
            <ul class="kf-breakdown__list">
              {breakdown.buckets.map((bucket) => (
                <li class="kf-breakdown__bucket" key={bucket.tag}>
                  <div class="kf-breakdown__bucket-head">
                    <TagChip tag={bucket.tag} />
                    <span>
                      {TAG_VISUALS[bucket.tag].ja} — 近傍{bucket.neighborAnchors.length}件
                      {bucket.excessAnchors.length > 0 &&
                        `(超過${String(bucket.excessAnchors.length)}件 → ペナ${formatRawPercent(
                          toApproxNumber(bucket.rawPenaltyFix),
                        )})`}
                    </span>
                  </div>
                  <ul class="kf-breakdown__contributions">
                    {bucket.contributions.map((c, i) => (
                      <li key={i} class="kf-breakdown__contribution">
                        {/* [M61/FC5・R1-A17] 内部セルID("c00")と実装寄りの語("ルール無し"
                            "target不一致")を人間可読な座標/文言へ。 */}
                        {cellCoordinateLabel(cellIdOf(c.neighborAnchorCellIndex))} × 自タグ
                        {TAG_VISUALS[c.selfTag].ja}
                        {" → "}
                        {c.effect === null
                          ? "この隣接は影響しません"
                          : c.applied
                            ? formatRawPercent(toApproxNumber(c.effect.valueFix))
                            : "対象外(タグが合わない)"}
                      </li>
                    ))}
                    {bucket.excessAnchors.map((anchor) => (
                      <li
                        key={`excess-${String(anchor)}`}
                        class="kf-breakdown__contribution kf-breakdown__contribution--excess"
                      >
                        {cellCoordinateLabel(cellIdOf(anchor))} — 超過(ボーナス無効化)
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
