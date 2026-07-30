// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 格子UI(M18)— ピンチズーム/パン/タップ判定の純関数
//
// GDD 6.6 の「ピンチズーム/パン対応」「タップ選択 → 配置先タップの2ステップ」
// 「最小タップ領域 44px 角」をすべて**DOM に触れない純関数**として実装する。
// 理由(タスク指示どおりの方針): jsdom は本プロジェクトの devDependencies に無く
// (ADR-001 依存最小・新規追加禁止)、タッチイベントの実DOM再現は vitest では
// 検証できない。よってロジックは全部ここへ切り出して単体テストし、
// `GridBoard.tsx` 側の DOM 結線(pointer イベント → ここの関数呼び出し)は
// 「座標を渡して結果を state へ反映するだけ」の薄い glue に留める。
//
// ここで扱う3つの純関数群:
//   1. 座標変換(viewport = scale + translate)とクランプ
//   2. ポインタジェスチャの状態遷移(1本指パン / 2本指ピンチ / タップ判定)
//   3. スクリーン座標 → セル番号のヒットテスト
//
// 実機の指の大きさ・環境依存の pointer 座標系には依存しない(全部スクリーン
// ローカル座標の数値として受け取る)。
// ---------------------------------------------------------------------------

import { GRID_HEIGHT, GRID_WIDTH } from "../../../engine/adjacency";
import {
  CELL_SIZE_PX,
  MAX_SCALE,
  MIN_SCALE,
  TAP_MAX_DURATION_MS,
  TAP_MOVE_THRESHOLD_PX,
} from "./gridConstants";

/** スクリーンローカル座標の点(px)。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 格子コンテンツに対する表示変換。`translate` はスクリーン座標系。 */
export interface Viewport {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

/** 格子コンテンツ全体のサイズ(倍率 1.0)。 */
export const GRID_CONTENT_WIDTH = GRID_WIDTH * CELL_SIZE_PX;
export const GRID_CONTENT_HEIGHT = GRID_HEIGHT * CELL_SIZE_PX;

/** ビューポート(表示領域)のサイズ。パンのクランプ範囲を決めるのに使う。 */
export interface ViewportBounds {
  readonly width: number;
  readonly height: number;
}

// --- 1. 座標変換とクランプ ---------------------------------------------------

function clampNumber(value: number, boundA: number, boundB: number): number {
  const lo = Math.min(boundA, boundB);
  const hi = Math.max(boundA, boundB);
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** 倍率を [{@link MIN_SCALE}, {@link MAX_SCALE}] にクランプする。 */
export function clampScale(scale: number): number {
  return clampNumber(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * パン位置をクランプする。「常に半セル分は画面内に残る」程度の緩い制約
 * (ズームインして格子の一部だけを見ることは許容する。GDD はパン対応を
 * 求めているだけで「常に全景を強制表示」までは求めていない)。
 *
 * 導出: コンテンツは画面上で `[translate, translate + contentSize]` を
 * 占める。これとビューポート `[0, viewportSize]` の重なりが `margin` px 以上
 * 残ることを要求すると
 *   `translate + contentSize >= margin`(右/下端が margin 以上残る)
 *   `translate <= viewportSize - margin`(左/上端が margin 以上残る)
 * の 2 式になり、`translate` の許容範囲は
 *   `[margin - contentSize, viewportSize - margin]`
 * と定まる。コンテンツがビューポートより大きい/小さいのどちらでも同じ式で
 * 成立する({@link clampNumber} の並べ替えは他の呼び出し元との共通化のための
 * 保険であり、この式では通常 lo <= hi が自然に成り立つ)。
 */
export function clampTranslate(viewport: Viewport, bounds: ViewportBounds): Viewport {
  const margin = CELL_SIZE_PX / 2;
  const contentW = GRID_CONTENT_WIDTH * viewport.scale;
  const contentH = GRID_CONTENT_HEIGHT * viewport.scale;
  return {
    scale: viewport.scale,
    translateX: clampNumber(viewport.translateX, margin - contentW, bounds.width - margin),
    translateY: clampNumber(viewport.translateY, margin - contentH, bounds.height - margin),
  };
}

/** 2 点間のユークリッド距離。 */
export function distanceBetween(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 2 点の中点。 */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * ピンチ操作の新しい倍率(クランプ済み)。`startDistance` が 0 に近い場合
 * (2 本指がほぼ重なった状態で開始した場合)は倍率を変えない。
 */
export function pinchScale(
  baseScale: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (startDistance <= 1e-6) return clampScale(baseScale);
  return clampScale(baseScale * (currentDistance / startDistance));
}

/**
 * `anchorScreenPoint` が指すコンテンツ座標を、倍率変更の前後で同じスクリーン
 * 位置に留める(標準的なピンチズームの数式)。パンのクランプはここでは
 * 行わない(呼び出し側が {@link clampTranslate} を続けて呼ぶ)。
 */
export function zoomAroundPoint(
  prevViewport: Viewport,
  nextScaleRaw: number,
  anchorScreenPoint: Point,
): Viewport {
  const scale = clampScale(nextScaleRaw);
  const contentX = (anchorScreenPoint.x - prevViewport.translateX) / prevViewport.scale;
  const contentY = (anchorScreenPoint.y - prevViewport.translateY) / prevViewport.scale;
  return {
    scale,
    translateX: anchorScreenPoint.x - contentX * scale,
    translateY: anchorScreenPoint.y - contentY * scale,
  };
}

// --- 2. ヒットテスト(スクリーン座標 → セル番号) ----------------------------

/**
 * スクリーン座標が指す格子セル番号(0〜47)。格子外を指していれば null。
 * `cellIndex = row * GRID_WIDTH + col` は adjacency.ts と同じ規約。
 */
export function hitTestCell(screenPoint: Point, viewport: Viewport): number | null {
  if (viewport.scale <= 0) return null;
  const contentX = (screenPoint.x - viewport.translateX) / viewport.scale;
  const contentY = (screenPoint.y - viewport.translateY) / viewport.scale;
  if (contentX < 0 || contentY < 0) return null;
  const col = Math.floor(contentX / CELL_SIZE_PX);
  const row = Math.floor(contentY / CELL_SIZE_PX);
  if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return null;
  return row * GRID_WIDTH + col;
}

// --- 3. ポインタジェスチャの状態遷移(1本指パン / 2本指ピンチ / タップ判定) ---

/** ジェスチャ開始時点の基準(パン・ピンチとも「開始時の viewport」を保持し、差分をそこから計算する)。 */
export interface GestureState {
  readonly pointers: ReadonlyMap<number, Point>;
  readonly panOrigin: { readonly viewport: Viewport; readonly point: Point } | null;
  readonly pinchOrigin: { readonly viewport: Viewport; readonly distance: number } | null;
  /** 単独ポインタがタップ候補かどうか(開始位置・時刻・そのポインタID)。 */
  readonly tapCandidate: {
    readonly pointerId: number;
    readonly point: Point;
    readonly at: number;
  } | null;
}

export const INITIAL_GESTURE_STATE: GestureState = {
  pointers: new Map(),
  panOrigin: null,
  pinchOrigin: null,
  tapCandidate: null,
};

export interface GestureUpdateResult {
  readonly state: GestureState;
  readonly viewport: Viewport;
}

/** ポインタが押された(`pointerdown`)。1 本目はパン候補 = タップ候補、2 本目でピンチへ切り替わる。 */
export function onPointerDown(
  state: GestureState,
  viewport: Viewport,
  pointerId: number,
  point: Point,
  at: number,
): GestureUpdateResult {
  const pointers = new Map(state.pointers);
  pointers.set(pointerId, point);

  if (pointers.size === 1) {
    return {
      state: {
        pointers,
        panOrigin: { viewport, point },
        pinchOrigin: null,
        tapCandidate: { pointerId, point, at },
      },
      viewport,
    };
  }
  if (pointers.size === 2) {
    const points = [...pointers.values()];
    const first = points[0];
    const second = points[1];
    if (first === undefined || second === undefined)
      return { state: { ...state, pointers }, viewport };
    return {
      state: {
        pointers,
        panOrigin: null,
        pinchOrigin: { viewport, distance: distanceBetween(first, second) },
        tapCandidate: null,
      },
      viewport,
    };
  }
  // 3本目以降は無視する(既存の2本指ジェスチャをそのまま継続)。
  return { state: { ...state, pointers }, viewport };
}

/** ポインタが動いた(`pointermove`)。1本指ならパン、2本指ならピンチとして viewport を更新する。 */
export function onPointerMove(
  state: GestureState,
  viewport: Viewport,
  bounds: ViewportBounds,
  pointerId: number,
  point: Point,
): GestureUpdateResult {
  if (!state.pointers.has(pointerId)) return { state, viewport };
  const pointers = new Map(state.pointers);
  pointers.set(pointerId, point);

  if (pointers.size >= 2 && state.pinchOrigin !== null) {
    const points = [...pointers.values()];
    const first = points[0];
    const second = points[1];
    if (first === undefined || second === undefined)
      return { state: { ...state, pointers }, viewport };
    const distance = distanceBetween(first, second);
    const mid = midpoint(first, second);
    const nextScale = pinchScale(
      state.pinchOrigin.viewport.scale,
      state.pinchOrigin.distance,
      distance,
    );
    const zoomed = zoomAroundPoint(state.pinchOrigin.viewport, nextScale, mid);
    return {
      state: { ...state, pointers, tapCandidate: null },
      viewport: clampTranslate(zoomed, bounds),
    };
  }

  if (pointers.size === 1 && state.panOrigin !== null) {
    const dx = point.x - state.panOrigin.point.x;
    const dy = point.y - state.panOrigin.point.y;
    const next = clampTranslate(
      {
        scale: state.panOrigin.viewport.scale,
        translateX: state.panOrigin.viewport.translateX + dx,
        translateY: state.panOrigin.viewport.translateY + dy,
      },
      bounds,
    );
    // 移動量がしきい値を超えたらタップ候補を取り消す(タップ/ドラッグの判別)。
    const moved = distanceBetween(point, state.panOrigin.point) > TAP_MOVE_THRESHOLD_PX;
    return {
      state: { ...state, pointers, tapCandidate: moved ? null : state.tapCandidate },
      viewport: next,
    };
  }

  return { state: { ...state, pointers }, viewport };
}

export interface PointerUpResult extends GestureUpdateResult {
  /** タップと判定された場合のスクリーン座標(そうでなければ null)。 */
  readonly tapPoint: Point | null;
}

/**
 * ポインタが離れた(`pointerup` / `pointercancel`)。
 * 最後の1本が、タップ候補のまま・移動量としきい値内・保持時間がしきい値内で
 * 離れた場合にのみ「タップ」と判定する(GDD 6.6 のタップ操作の起点)。
 */
export function onPointerUp(
  state: GestureState,
  viewport: Viewport,
  pointerId: number,
  point: Point,
  at: number,
): PointerUpResult {
  const pointers = new Map(state.pointers);
  pointers.delete(pointerId);

  let tapPoint: Point | null = null;
  if (
    state.tapCandidate !== null &&
    state.tapCandidate.pointerId === pointerId &&
    pointers.size === 0
  ) {
    const duration = at - state.tapCandidate.at;
    const moved = distanceBetween(point, state.tapCandidate.point);
    if (moved <= TAP_MOVE_THRESHOLD_PX && duration <= TAP_MAX_DURATION_MS && duration >= 0) {
      tapPoint = point;
    }
  }

  if (pointers.size === 0) {
    return { state: INITIAL_GESTURE_STATE, viewport, tapPoint };
  }

  // 2本 → 1本 に減った場合は、残った1本でパンを再開する(基準は「今の viewport」から取り直す)。
  const remainingEntry = [...pointers.entries()][0];
  if (remainingEntry === undefined) {
    return { state: INITIAL_GESTURE_STATE, viewport, tapPoint };
  }
  const [, remainingPoint] = remainingEntry;
  return {
    state: {
      pointers,
      panOrigin: { viewport, point: remainingPoint },
      pinchOrigin: null,
      tapCandidate: null,
    },
    viewport,
    tapPoint,
  };
}
