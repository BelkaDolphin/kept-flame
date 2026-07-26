// ---------------------------------------------------------------------------
// B3(ハイドレーション)の view model と B4(約240 DOM 初回マウント)の
// Preact コンポーネント — T10 / `docs/design/perf-boundaries.md` §3 B3 / B4 / §5
//
// - `buildGridViewModel` は純関数(DOM に触らない)。B3 の計測対象。
// - `PerfGrid` は 48 セル × 5 要素 = 240 要素**ちょうど**を生成する。B4 の計測対象。
//   ルートは Fragment なので container 直下に余分なラッパ要素を作らない
//   (`container.querySelectorAll("*").length === 240` が成り立つ)。
//   空セルも 5 要素を出す(実 UI でも空セルは枠と記号枠を持つため、
//   ノード数を配置依存にしない方が計測条件として安定する)。
//
// 記号(glyph)は tags-spec.md の SVG 意匠ではなく単純な文字である。#1 が測る
// のは**ノード数と描画コスト**であって意匠ではないため。実 UI の意匠は
// `docs/design/tags-spec.md` が正。色(ink/tint)だけは tags-spec の値を使う
// (light 固定・ダークモード分岐は書かない = CLAUDE.md 絶対ルール)。
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT, GRID_WIDTH, cellIdOf, type Tag } from "../src/engine/adjacency";
import { toApproxNumber } from "../src/engine/fp";
import {
  requireFacilityDef,
  type AdvanceContext,
  type EngineContent,
} from "../src/engine/rules/types";
import { entitiesOfKind, type GameState } from "../src/engine/state/state";

/** tags-spec.md §2.1 の ink / tint(light 固定)。 */
const TAG_STYLE: {
  readonly [K in Tag]: {
    readonly ink: string;
    readonly tint: string;
    readonly glyph: string;
    readonly label: string;
  };
} = {
  heat: { ink: "#8c290b", tint: "#faedea", glyph: "▲", label: "熱源" },
  clean: { ink: "#076f5a", tint: "#d9f6f0", glyph: "●", label: "清浄" },
  foul: { ink: "#35240f", tint: "#f8eee3", glyph: "■", label: "汚染" },
  noise: { ink: "#671b75", tint: "#f8edfa", glyph: "✦", label: "騒音" },
  damp: { ink: "#1942e5", tint: "#edeffa", glyph: "◆", label: "湿潤" },
  calm: { ink: "#2d333e", tint: "#eef0f4", glyph: "─", label: "静穏" },
  lore: { ink: "#975d0c", tint: "#f8efe2", glyph: "✚", label: "学芸" },
};

const EMPTY_STYLE = { ink: "#5b534b", tint: "#faf8f5", glyph: "·", label: "空き" } as const;

/** 1 セルあたりの DOM 要素数(コンテナ + 記号 + タグ名 + 数値 + バッジ)。 */
export const DOM_NODES_PER_CELL = 5;

/** 期待 DOM 要素数 = 48 × 5 = 240(ADR-012(4) の「約240 DOM」)。 */
export const EXPECTED_DOM_NODES = GRID_CELL_COUNT * DOM_NODES_PER_CELL;

export interface PerfCellViewModel {
  readonly cellIndex: number;
  readonly cellId: string;
  readonly occupied: boolean;
  readonly glyph: string;
  readonly tagLabel: string;
  readonly valueText: string;
  readonly badgeText: string;
  readonly ink: string;
  readonly tint: string;
}

export interface PerfSummaryViewModel {
  readonly tick: number;
  readonly residentCount: number;
  readonly impairedCount: number;
  readonly dispatchedCount: number;
  readonly facilityCount: number;
  readonly resourceStocks: readonly { readonly id: string; readonly approx: number }[];
  readonly researchProgress: readonly {
    readonly id: string;
    readonly approx: number;
    readonly completedTick: number | null;
  }[];
}

export interface PerfGridViewModel {
  readonly cells: readonly PerfCellViewModel[];
  readonly summary: PerfSummaryViewModel;
}

/**
 * 復元 + catch-up 済みの GameState を UI 表示用の派生値へ写す(B3 の本体)。
 *
 * DOM には一切触らない。engine の再計算もしない(隣接乗数は
 * `AdvanceContext.multiplierByFacilityId` の precompute 済みの値を読むだけ)。
 *
 * @throws {RulesError} facility の content 定義が引けない場合
 */
export function buildGridViewModel(
  state: GameState,
  content: EngineContent,
  ctx: AdvanceContext,
): PerfGridViewModel {
  const facilities = entitiesOfKind(state, "facility");
  const residents = entitiesOfKind(state, "resident");

  const cells: PerfCellViewModel[] = [];
  const byCell = new Map<number, (typeof facilities)[number]>();
  for (const facility of facilities) byCell.set(facility.cellIndex, facility);

  for (let cellIndex = 0; cellIndex < GRID_CELL_COUNT; cellIndex++) {
    const facility = byCell.get(cellIndex);
    if (facility === undefined) {
      cells.push({
        cellIndex,
        cellId: cellIdOf(cellIndex),
        occupied: false,
        glyph: EMPTY_STYLE.glyph,
        tagLabel: EMPTY_STYLE.label,
        valueText: "—",
        badgeText: "—",
        ink: EMPTY_STYLE.ink,
        tint: EMPTY_STYLE.tint,
      });
      continue;
    }
    const def = requireFacilityDef(content, facility.defId);
    const primaryTag = def.tags[0];
    const style = primaryTag === undefined ? EMPTY_STYLE : TAG_STYLE[primaryTag];
    const multiplierFix = ctx.multiplierByFacilityId.get(facility.id);
    const multiplier = multiplierFix === undefined ? 1 : toApproxNumber(multiplierFix);
    cells.push({
      cellIndex,
      cellId: cellIdOf(cellIndex),
      occupied: true,
      glyph: style.glyph,
      tagLabel: style.label,
      valueText: `×${multiplier.toFixed(3)}`,
      badgeText: `Lv${String(facility.level)}/${String(facility.workerIds.length)}人`,
      ink: style.ink,
      tint: style.tint,
    });
  }

  let impairedCount = 0;
  let dispatchedCount = 0;
  for (const resident of residents) {
    if (resident.recallImpairedUntilTick > state.tick) impairedCount++;
    if (resident.dispatched) dispatchedCount++;
  }

  return {
    cells,
    summary: {
      tick: state.tick,
      residentCount: residents.length,
      impairedCount,
      dispatchedCount,
      facilityCount: facilities.length,
      resourceStocks: entitiesOfKind(state, "resource").map((r) => ({
        id: r.id,
        approx: toApproxNumber(r.stock),
      })),
      researchProgress: entitiesOfKind(state, "research").map((r) => ({
        id: r.id,
        approx: toApproxNumber(r.progress),
        completedTick: r.completedTick,
      })),
    },
  };
}

// --- Preact コンポーネント(B4 の計測対象) --------------------------------

function PerfCell({ cell }: { readonly cell: PerfCellViewModel }) {
  return (
    <div
      class="kf-cell"
      style={`background:${cell.tint};border-color:${cell.ink};grid-column:${String((cell.cellIndex % GRID_WIDTH) + 1)}`}
      title={cell.cellId}
    >
      <span class="kf-cell__mark" style={`color:${cell.ink}`}>
        {cell.glyph}
      </span>
      <span class="kf-cell__tag">{cell.tagLabel}</span>
      <span class="kf-cell__value">{cell.valueText}</span>
      <span class="kf-cell__badge">{cell.badgeText}</span>
    </div>
  );
}

/** container 直下に 48 セル × 5 要素 = 240 要素ちょうどを出す(ラッパ無し)。 */
export function PerfGrid({ cells }: { readonly cells: readonly PerfCellViewModel[] }) {
  return (
    <>
      {cells.map((cell) => (
        <PerfCell key={cell.cellId} cell={cell} />
      ))}
    </>
  );
}
