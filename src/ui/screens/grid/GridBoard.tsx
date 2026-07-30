// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 格子UIコンポーネント(M18)— GDD 6.6 / ADR-002(2) / ADR-027
//
// 6×8 格子の表示・タップ選択・ピンチズーム/パンを持つ再利用可能な Preact
// コンポーネント。②格子ビュー(M30)がこれをそのまま画面に据える想定であり、
// 施設カタログ(何を建てるかの選択 UI)や凡例・内訳ビュー(M19)はここに含めない
// ——本ファイルは「格子そのもの」だけを持つ。
//
// ===========================================================================
// 1. アンカーのみ装飾する(M17 申し送り・[2026-07-30追記])
// ===========================================================================
//   `cellPlacement[]` は大型施設の全占有セルに載る(非アンカーからも施設が引ける
//   ・sources.ts §1)。描画は `cell.anchorCellIndex === cell.cellIndex` の
//   セルにのみ枠/バッジ/数値を出し、残りの占有セルは「連結表示」(タグ色の
//   塗りのみ・枠なし・バッジなし)にする。空きセルは第3のケース。
//   このルールは {@link GridCell} 単体でテストできるように分離してある。
//
// ===========================================================================
// 2. `cellSelected` のアンカー正規化(★ 裁定・store.ts 側で実施)
// ===========================================================================
//   大型施設のどのセルをタップしても、ストア側(`store.ts` の `cellSelected`
//   ハンドラ)が選択セルをアンカーへ正規化する。これにより「非アンカーをタップ
//   したのに選択枠が出ない(枠はアンカーにしか描かないため)」という矛盾が
//   起きない。詳細な理由・代替案は store.ts 冒頭コメントと本タスクの最終報告を
//   参照。
//
// ===========================================================================
// 3. 2ステップ操作(GDD 6.6)と「瓦礫開墾」の扱い
// ===========================================================================
//   タップ選択 → 配置先タップの2ステップのうち、「何を建てるか」の選択(施設
//   カタログ)は M30 の担当。本コンポーネントは `pendingPlacement`(defId +
//   facilityId。ID は呼び出し側が用意する——engine の `placeFacility` は
//   呼び出し側が生成した ID を要求する契約であり、ここで ID を発行しない)を
//   受け取り、空きセルへのタップをその場で `placeFacility` コマンドへ変換する
//   「配置先タップ」だけを持つ。
//
//   **瓦礫開墾(GDD 9.1)は実装していない**。engine の `GameState` に地形/瓦礫の
//   概念が一切無く(`commands.ts` の `reclaimCell` は型のみ予約・M18 が担当と
//   注記されているが、実体は state 拡張を要する = engine 変更)、本タスクの
//   絶対制約(`src/engine/` 変更禁止)により実装できない。したがって現状は
//   **全 48 セルが「開墾済み」として扱われる**(既存 engine の実際の挙動と一致
//   させてあるだけで、UI 側で情報を捏造してはいない)。詳細は最終報告を参照。
//
// ===========================================================================
// 4. ピンチズーム/パンはロジックを純関数へ分離(タスク指示どおりの方針)
// ===========================================================================
//   `gridGeometry.ts` が座標変換・ジェスチャ状態遷移・ヒットテストを持ち、
//   ここでの DOM 結線は「pointer イベントの座標を渡して結果を state へ反映する」
//   だけの薄い glue にしてある(jsdom 非依存のため実 DOM でのタッチ再現は
//   vitest では検証できない・タスク指示の方針どおり)。
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "preact/hooks";

import { GRID_WIDTH, type Tag } from "../../../engine/adjacency";
import type { CommandResult, PlaceFacilityCommand } from "../../../engine/commands";
import { toApproxNumber } from "../../../engine/fp";
import type { EntityId } from "../../../engine/state/state";
import {
  computePlacementPreview,
  type CellViewModel,
  type PlacementPreviewCell,
} from "../../derived";
import type { GameStore } from "../../store";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./gridBoard.css";
import { CELL_SIZE_PX, DEFAULT_SCALE, MIN_TAP_TARGET_PX } from "./gridConstants";
import {
  GRID_CONTENT_HEIGHT,
  GRID_CONTENT_WIDTH,
  INITIAL_GESTURE_STATE,
  hitTestCell,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  type GestureState,
  type Viewport,
  type ViewportBounds,
} from "./gridGeometry";
import { TagIconDefs, TagSymbol } from "./TagIcons";
import {
  MARKER_GUTTER_PX,
  MAX_INLINE_MARKERS,
  NON_SCALING_MIN_PX,
  SURFACE_COLORS,
  TAG_VISUALS,
  computeDisplayMarkerPx,
  computeLodTier,
  computeRawMarkerPx,
  formatBonusPercent,
  formatOvercrowdCount,
} from "./tagVisuals";

// --- 1. 施設配置の待機(施設カタログは M30 の担当・ここは受け取るだけ) --------

/** 「配置先タップ」を待っている施設(defId + 呼び出し側が発行済みの facilityId)。 */
export interface PendingPlacement {
  readonly facilityId: EntityId;
  readonly defId: EntityId;
}

// --- 2. タグ 4 重符号化(色+記号+パターン+数値) + 配置プレビュー (M19) --------
//
// `docs/design/tags-spec.md` §7(LOD)・§6.4(セル内マーカー配置)・
// GDD 6.5(配置プレビュー・常時過密警告バッジ)の実装。
// M18 の `tagGlyph` 差し替え口(文字列を返すだけの仮実装)はここで本実装に
// 置き換わる——4重符号化は色+記号(SVG)+パターン(SVG内蔵)+数値の4チャネルを
// 要求するため、差し替え口の型を「文字列を返す関数」のままには維持できない
// (置き換えの経緯は最終報告に記載)。

/** 配置プレビュー(空きセルのみ)の表示種別。GDD 6.5 の「色+記号(+/−)+パターン+数値」。 */
export interface CellPreviewView {
  readonly kind: "add" | "sub";
  readonly percentLabel: string;
}

/**
 * `computePlacementPreview` の1セルぶんの結果を表示用に変換する。
 * `fits=false`(盤外/衝突)のセルはプレビューを出さない(`null`)。
 */
export function buildPreviewView(preview: PlacementPreviewCell): CellPreviewView | null {
  if (!preview.fits) return null;
  const netApprox = toApproxNumber(preview.bonusFix) + toApproxNumber(preview.overcrowdPenaltyFix);
  return {
    kind: netApprox >= 0 ? "add" : "sub",
    percentLabel: formatBonusPercent(netApprox),
  };
}

// --- 3. セル 1 個のレンダリング(純関数・hooks を使わないので直接テスト可能) --

export interface GridCellProps {
  readonly cell: CellViewModel;
  /** このセルの施設が選択中か(アンカー正規化済みの selectedCellIndex との一致)。 */
  readonly selected: boolean;
  /** 現在の表示倍率(viewport.scale)。LOD 判定(spec §7.1/§7.2)に使う。 */
  readonly zoom: number;
  /** [M19] 配置プレビュー(空きセルのみ有効。pendingPlacement 無し/対象外なら null)。 */
  readonly preview?: CellPreviewView | null;
}

/**
 * セルの絶対配置(left/top/width/height)。実寸は {@link CELL_SIZE_PX}
 * (gridConstants.ts が単一の出典)から computed し、gridBoard.css 側には
 * 数値を持たせない(定数1箇所に隔離する規律の延長)。
 */
function cellPositionStyle(cellIndex: number): string {
  const col = cellIndex % GRID_WIDTH;
  const row = (cellIndex - col) / GRID_WIDTH;
  return (
    `left:${String(col * CELL_SIZE_PX)}px;top:${String(row * CELL_SIZE_PX)}px;` +
    `width:${String(CELL_SIZE_PX)}px;height:${String(CELL_SIZE_PX)}px;`
  );
}

/**
 * 常時過密警告バッジの色に使う代表タグ。
 *
 * **[M19 設計判断・★非ブロッキング]** engine の `overcrowdedNeighborCount` は
 * 「近傍タグ側」の超過であって自施設のタグとは限らない(adjacencyBreakdown.ts
 * 冒頭コメント参照)。厳密な代表タグを得るには内訳(内訳ビューが使う
 * `computeAdjacencyBreakdown`)を全セルぶん計算する必要があり、それは
 * `selectedCellBreakdown`(選択セル1個だけ)の設計と非対称な重い経路になる。
 * 現状の content(hearth/forge/workbench)はすべて単一タグ施設のため実害が無く、
 * ここでは**自施設の先頭タグ**で代用する(最終報告の ★ 項目)。
 */
function overcrowdBadgeTag(cell: CellViewModel): Tag | undefined {
  return cell.tags[0];
}

/**
 * セル 1 個ぶんの vnode を作る(hooks 不使用・DOM 非依存)。
 *
 * 3 通りの描画(§1)+ 配置プレビュー(空きセルの第4のケース・GDD 6.5):
 *   - 空きセル: プレースホルダのみ(タップ可能領域は 44px を確保)。
 *     `preview` があれば半透明オーバーレイ(色+記号+数値)を重ねる。
 *   - アンカーセル(占有 かつ `anchorCellIndex === cellIndex`): 枠・タグ
 *     マーカー(色+記号+パターン+数値の4重符号化・LOD 劣化あり)・
 *     Lv/就労者バッジ・常時過密警告バッジまで全部出す
 *   - 連結セル(占有 かつ 非アンカー): タグ色の塗りのみ(枠・バッジ・数値なし)
 */
export function GridCell({ cell, selected, zoom, preview = null }: GridCellProps) {
  const positionStyle = cellPositionStyle(cell.cellIndex);

  if (!cell.occupied) {
    if (preview !== null) {
      const previewBg =
        preview.kind === "add" ? SURFACE_COLORS.previewAdd : SURFACE_COLORS.previewSub;
      return (
        <div
          class={`kf-cell kf-cell--empty kf-cell--preview kf-cell--preview-${preview.kind}`}
          style={`${positionStyle}background:${previewBg};`}
          data-cell-id={cell.cellId}
          data-cell-index={cell.cellIndex}
        >
          <span class="kf-cell__preview-symbol" aria-hidden="true">
            {preview.kind === "add" ? "+" : "−"}
          </span>
          <span class="kf-cell__preview-value">{preview.percentLabel}</span>
        </div>
      );
    }
    return (
      <div
        class="kf-cell kf-cell--empty"
        style={positionStyle}
        data-cell-id={cell.cellId}
        data-cell-index={cell.cellIndex}
      >
        <span class="kf-cell__placeholder" aria-hidden="true">
          ・
        </span>
      </div>
    );
  }

  const isAnchor = cell.anchorCellIndex === cell.cellIndex;
  if (!isAnchor) {
    // [M17] 連結表示: 枠/バッジ/数値を持たない(1 施設 1 回のみ装飾する規約)。
    // タグ色の塗りのみ(M17 申し送り)。
    const connectedTag = cell.tags[0];
    const connectedStyle =
      connectedTag === undefined
        ? positionStyle
        : `${positionStyle}background:${TAG_VISUALS[connectedTag].tint};`;
    return (
      <div
        class="kf-cell kf-cell--connected"
        style={connectedStyle}
        data-cell-id={cell.cellId}
        data-cell-index={cell.cellIndex}
        data-anchor-cell-index={cell.anchorCellIndex}
      />
    );
  }

  const classes = ["kf-cell", "kf-cell--occupied"];
  if (selected) classes.push("kf-cell--selected");
  if (cell.overcrowded) classes.push("kf-cell--overcrowded");

  const rawMarkerPx = computeRawMarkerPx(zoom);
  const lod = computeLodTier(rawMarkerPx);
  const markerPx = computeDisplayMarkerPx(rawMarkerPx);
  const counterScale = zoom > 0 ? 1 / zoom : 1;
  const visibleTags = cell.tags.slice(0, MAX_INLINE_MARKERS);
  const overflowCount = cell.tags.length - visibleTags.length;
  const bonusApprox = toApproxNumber(cell.bonusFix);
  const badgeTag = overcrowdBadgeTag(cell);

  return (
    <div
      class={classes.join(" ")}
      style={positionStyle}
      data-cell-id={cell.cellId}
      data-cell-index={cell.cellIndex}
      data-facility-id={cell.facilityId ?? undefined}
      data-lod={lod.id}
    >
      <span class="kf-cell__markers">
        {visibleTags.map((tag) => (
          <span
            key={tag}
            class="kf-cell__marker"
            style={`width:${String(markerPx)}px;height:${String(markerPx)}px;margin-right:${String(MARKER_GUTTER_PX)}px;`}
          >
            {lod.symbol === "none" ? (
              <span
                class="kf-cell__marker-dot"
                style={`background:${TAG_VISUALS[tag].ink};`}
                aria-hidden="true"
              />
            ) : (
              <TagSymbol
                tag={tag}
                variant={lod.symbol}
                sizePx={markerPx}
                title={TAG_VISUALS[tag].ja}
              />
            )}
          </span>
        ))}
        {overflowCount > 0 && (
          <span class="kf-cell__marker-overflow" aria-hidden="true">
            +{overflowCount}
          </span>
        )}
      </span>
      {lod.numeral && (
        <span class="kf-cell__value">
          {formatBonusPercent(bonusApprox)}
          {cell.overcrowded ? ` ${formatOvercrowdCount(cell.overcrowdedNeighborCount)}` : ""}
        </span>
      )}
      <span class="kf-cell__badge">
        Lv{cell.level}/{cell.workerCount}人
      </span>
      {cell.overcrowded && badgeTag !== undefined && (
        <span
          class="kf-cell__overcrowd-badge"
          style={`width:${String(NON_SCALING_MIN_PX.overcrowdBadge)}px;height:${String(NON_SCALING_MIN_PX.overcrowdBadge)}px;transform:scale(${String(counterScale)});color:${TAG_VISUALS[badgeTag].ink};`}
          title="過密警告(常時表示・GDD 6.5)"
          aria-label="過密警告"
        >
          !
        </span>
      )}
    </div>
  );
}

// --- 4. タップの意味づけ(純関数・hooks を使わないので直接テスト可能) --------

export type TapAction =
  | { readonly kind: "select"; readonly cellIndex: number }
  | { readonly kind: "place"; readonly command: PlaceFacilityCommand }
  | { readonly kind: "none" };

/**
 * タップされたセルが「選択」か「配置先」かを決める。
 *
 * **判定(置けるか)はここでは行わない**(architecture.md §6 の7箇条目)。
 * 空きセルかどうかだけを見て `placeFacility` を組み立て、実際に置けるかは
 * engine の `apply` が返す拒否(`CommandResult`)に委ねる。
 */
export function resolveTapAction(
  cells: readonly CellViewModel[],
  pendingPlacement: PendingPlacement | null,
  cellIndex: number,
): TapAction {
  const cell = cells[cellIndex];
  if (cell === undefined) return { kind: "none" };

  if (pendingPlacement !== null && !cell.occupied) {
    return {
      kind: "place",
      command: {
        kind: "placeFacility",
        facilityId: pendingPlacement.facilityId,
        defId: pendingPlacement.defId,
        cellIndex,
      },
    };
  }
  return { kind: "select", cellIndex };
}

// --- 5. 格子全体の表示変換(純関数) ------------------------------------------

/** `.kf-grid-surface` へ渡す style 文字列。サイズは倍率 1.0 のコンテンツサイズで固定し、拡縮は transform だけで行う(セル側の再レイアウトを起こさない)。 */
function surfaceStyle(viewport: Viewport): string {
  return (
    `width:${String(GRID_CONTENT_WIDTH)}px;height:${String(GRID_CONTENT_HEIGHT)}px;` +
    `transform:translate(${String(viewport.translateX)}px, ${String(viewport.translateY)}px) scale(${String(viewport.scale)});`
  );
}

// --- 6. Preact コンポーネント本体(hooks を持つのはここだけ) ----------------

export interface GridBoardProps {
  readonly store: GameStore;
  /** 配置待ちの施設(未指定ならタップは常に「選択」)。M30(施設カタログ)が渡す。 */
  readonly pendingPlacement?: PendingPlacement | null;
  /** `placeFacility` を dispatch した結果(拒否も含む)を親へ知らせる。 */
  readonly onPlacementResult?: (result: CommandResult) => void;
  /**
   * タグ記号 SVG スプライト(`TagIconDefs`)をこのコンポーネントが自前で
   * マウントするか(既定 true)。凡例パネル/内訳ビューと同一画面に組む場合
   * (M30)は、いずれか1つだけ true にして重複挿入を避けられる。
   */
  readonly includeIconDefs?: boolean;
}

/**
 * 48 セルぶんの `cellView` を購読する。1 セル = 1 個の `scope.effect`
 * (architecture.md §6 の規約どおり `store.derived.*` のみを購読・M8 の
 * fan-in 設計を再利用するだけで再実装しない)。
 */
function useGridCells(store: GameStore): readonly CellViewModel[] {
  const cellCount = store.derived.cellView.length;
  const [cells, setCells] = useState<readonly CellViewModel[]>(() =>
    store.derived.cellView.map((node) => node.peek()),
  );
  const mount = useScreenMount(store, "grid");

  useEffect(() => {
    if (mount === null) return;
    // マウント直後の値でまず揃え直す(mountScreen 前に読んだ初期値が
    // 古くなっている可能性があるため)。
    setCells(store.derived.cellView.map((node) => node.peek()));
    for (let i = 0; i < cellCount; i++) {
      const index = i;
      mount.scope.effect(() => {
        const next = store.derived.cellView[index]?.value;
        if (next === undefined) return;
        setCells((prev) => {
          if (prev[index] === next) return prev;
          const copy = prev.slice();
          copy[index] = next;
          return copy;
        });
      });
    }
    // mount.dispose は useScreenMount 側の unmount 処理が担う(二重に切らない)。
  }, [store, mount, cellCount]);

  return cells;
}

/** ビューポート(表示領域)の実測サイズ。初回描画では未計測なので既定値を使う。 */
const FALLBACK_BOUNDS: ViewportBounds = {
  width: GRID_CONTENT_WIDTH * DEFAULT_SCALE,
  height: GRID_CONTENT_HEIGHT * DEFAULT_SCALE,
};

export function GridBoard({
  store,
  pendingPlacement = null,
  onPlacementResult,
  includeIconDefs = true,
}: GridBoardProps) {
  const cells = useGridCells(store);
  const selectedCellIndex = useSignalValue(store.sources.selectedCellIndex);

  // [M19] 配置プレビュー(GDD 6.5 MVP必須)。pendingPlacement が変わるか盤面が
  // 変わるたびに 48 セルぶんを再計算する(既存施設の判定と同じ
  // computeCellAdjacency を呼ぶだけなので O(48×近傍) で軽い・derived.ts 末尾
  // 参照)。architecture.md §6 の規律どおり、この重い計算自体は derived.ts に
  // 置いてあり、ここは呼ぶだけ。
  const previewByCellIndex = useMemo(() => {
    if (pendingPlacement === null) return null;
    const previews = computePlacementPreview(
      store.sources,
      store.peekContent(),
      store.sources.worldSeedU32.peek(),
      pendingPlacement.defId,
    );
    const map = new Map<number, CellPreviewView | null>();
    for (const preview of previews) map.set(preview.cellIndex, buildPreviewView(preview));
    return map;
  }, [store, pendingPlacement, cells]);

  const [viewport, setViewport] = useState<Viewport>({
    scale: DEFAULT_SCALE,
    translateX: 0,
    translateY: 0,
  });
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const gestureRef = useRef<GestureState>(INITIAL_GESTURE_STATE);
  const containerRef = useRef<HTMLDivElement | null>(null);

  function currentBounds(): ViewportBounds {
    const el = containerRef.current;
    if (el === null) return FALLBACK_BOUNDS;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return FALLBACK_BOUNDS;
    return { width: rect.width, height: rect.height };
  }

  function pointFromEvent(e: PointerEvent): { readonly x: number; readonly y: number } {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: e.clientX, y: e.clientY };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handleTap(cellIndex: number): void {
    const action = resolveTapAction(cells, pendingPlacement, cellIndex);
    switch (action.kind) {
      case "select":
        store.dispatch({ type: "cellSelected", cellIndex: action.cellIndex });
        return;
      case "place": {
        const result = store.dispatch({ type: "commandApplied", command: action.command });
        // commandApplied を dispatch した直後は DispatchResult.command が
        // 必ず非 null になる(store.ts の applyCommand)。
        if (result.command !== null) onPlacementResult?.(result.command);
        return;
      }
      case "none":
        return;
      default: {
        const unhandled: never = action;
        throw new Error(`未知の TapAction ${JSON.stringify(unhandled)}`);
      }
    }
  }

  function handlePointerDown(e: PointerEvent): void {
    containerRef.current?.setPointerCapture(e.pointerId);
    const result = onPointerDown(
      gestureRef.current,
      viewportRef.current,
      e.pointerId,
      pointFromEvent(e),
      e.timeStamp,
    );
    gestureRef.current = result.state;
    setViewport(result.viewport);
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!gestureRef.current.pointers.has(e.pointerId)) return;
    const result = onPointerMove(
      gestureRef.current,
      viewportRef.current,
      currentBounds(),
      e.pointerId,
      pointFromEvent(e),
    );
    gestureRef.current = result.state;
    setViewport(result.viewport);
  }

  function handlePointerUp(e: PointerEvent): void {
    const result = onPointerUp(
      gestureRef.current,
      viewportRef.current,
      e.pointerId,
      pointFromEvent(e),
      e.timeStamp,
    );
    gestureRef.current = result.state;
    setViewport(result.viewport);
    if (result.tapPoint !== null) {
      const cellIndex = hitTestCell(result.tapPoint, viewportRef.current);
      if (cellIndex !== null) handleTap(cellIndex);
    }
  }

  const surfaceStyleValue = useMemo(() => surfaceStyle(viewport), [viewport]);

  return (
    <div
      class="kf-grid-viewport"
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {includeIconDefs && <TagIconDefs />}
      <div class="kf-grid-surface" style={surfaceStyleValue}>
        {cells.map((cell) => (
          <GridCell
            key={cell.cellId}
            cell={cell}
            selected={selectedCellIndex !== null && cell.cellIndex === selectedCellIndex}
            zoom={viewport.scale}
            preview={previewByCellIndex?.get(cell.cellIndex) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

// 44px 最小タップ領域(GDD 6.6)は CSS 側の責務だが、コンポーネントを読む側が
// 数値の出典を追えるようにここでも re-export しておく。
export { MIN_TAP_TARGET_PX, CELL_SIZE_PX };
