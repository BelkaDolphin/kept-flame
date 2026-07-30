// ---------------------------------------------------------------------------
// src/ui/screens/grid/gridGeometry.ts のテスト(M18)。
//
// ピンチズーム/パン/タップ判定を DOM に触れない純関数として固定する。
// jsdom は本プロジェクトの devDependencies に無い(ADR-001 依存最小)ため、
// タッチイベントの実 DOM 再現はここでは扱わない(タスク指示どおりの方針:
// ロジックを純関数へ切り出して単体テストする)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { GRID_HEIGHT, GRID_WIDTH } from "../../../src/engine/adjacency";
import {
  CELL_SIZE_PX,
  MAX_SCALE,
  MIN_SCALE,
  MIN_TAP_TARGET_PX,
  TAP_MAX_DURATION_MS,
  TAP_MOVE_THRESHOLD_PX,
} from "../../../src/ui/screens/grid/gridConstants";
import {
  GRID_CONTENT_HEIGHT,
  GRID_CONTENT_WIDTH,
  INITIAL_GESTURE_STATE,
  clampScale,
  clampTranslate,
  distanceBetween,
  hitTestCell,
  midpoint,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  pinchScale,
  zoomAroundPoint,
  type Point,
  type Viewport,
} from "../../../src/ui/screens/grid/gridGeometry";

const IDENTITY_VIEWPORT: Viewport = { scale: 1, translateX: 0, translateY: 0 };
const BOUNDS = { width: GRID_CONTENT_WIDTH, height: GRID_CONTENT_HEIGHT };

describe("定数の関係(gridConstants)", () => {
  it("最小ズームでも1セルのタップ領域が44px未満にならない(GDD 6.6)", () => {
    expect(CELL_SIZE_PX * MIN_SCALE).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
  });

  it("最小倍率は最大倍率を超えない", () => {
    expect(MIN_SCALE).toBeLessThan(MAX_SCALE);
  });
});

describe("clampScale", () => {
  it("範囲内はそのまま", () => {
    expect(clampScale(1)).toBe(1);
  });
  it("下限未満は下限に、上限超過は上限にクランプする", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
  });
});

describe("clampTranslate", () => {
  it("等倍でコンテンツがビューポートと同サイズなら translate は 0 近辺(半セル分の余白内)", () => {
    const clamped = clampTranslate(IDENTITY_VIEWPORT, BOUNDS);
    expect(Math.abs(clamped.translateX)).toBeLessThanOrEqual(CELL_SIZE_PX / 2);
    expect(Math.abs(clamped.translateY)).toBeLessThanOrEqual(CELL_SIZE_PX / 2);
  });

  it("大きくパンしても半セル分は画面内に残るようクランプされる", () => {
    const overPanned: Viewport = { scale: 1, translateX: -100_000, translateY: 100_000 };
    const clamped = clampTranslate(overPanned, BOUNDS);
    expect(clamped.translateX).toBeGreaterThan(-100_000);
    expect(clamped.translateY).toBeLessThan(100_000);
  });

  it("ズームインでコンテンツがビューポートより大きくなっても破綻しない(有限値)", () => {
    const clamped = clampTranslate({ scale: MAX_SCALE, translateX: 0, translateY: 0 }, BOUNDS);
    expect(Number.isFinite(clamped.translateX)).toBe(true);
    expect(Number.isFinite(clamped.translateY)).toBe(true);
  });
});

describe("distanceBetween / midpoint", () => {
  it("3-4-5 の直角三角形で距離5", () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
  it("中点は単純平均", () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe("pinchScale", () => {
  it("距離が2倍になれば倍率も2倍(クランプ範囲内なら)", () => {
    const scale = pinchScale(1, 100, 200);
    expect(scale).toBeCloseTo(2);
  });
  it("開始距離がほぼ0なら倍率を変えない(クランプのみ適用)", () => {
    expect(pinchScale(1.2, 0, 500)).toBe(clampScale(1.2));
  });
  it("結果はMIN/MAXにクランプされる", () => {
    expect(pinchScale(1, 1000, 1)).toBe(MIN_SCALE);
    expect(pinchScale(1, 1, 1000)).toBe(MAX_SCALE);
  });
});

describe("zoomAroundPoint", () => {
  it("anchor のスクリーン位置は倍率変更の前後で不変", () => {
    const prev: Viewport = { scale: 1, translateX: 10, translateY: -5 };
    const anchor: Point = { x: 120, y: 80 };
    const next = zoomAroundPoint(prev, 2, anchor);

    // anchor のコンテンツ座標を prev/next それぞれで screen へ逆算し、一致することを確認する。
    const screenFromPrev = {
      x: ((anchor.x - prev.translateX) / prev.scale) * prev.scale + prev.translateX,
      y: ((anchor.y - prev.translateY) / prev.scale) * prev.scale + prev.translateY,
    };
    const screenFromNext = {
      x: ((anchor.x - prev.translateX) / prev.scale) * next.scale + next.translateX,
      y: ((anchor.y - prev.translateY) / prev.scale) * next.scale + next.translateY,
    };
    expect(screenFromNext.x).toBeCloseTo(screenFromPrev.x);
    expect(screenFromNext.y).toBeCloseTo(screenFromPrev.y);
    expect(anchor.x).toBeCloseTo(screenFromPrev.x);
  });
});

describe("hitTestCell", () => {
  it("等倍・無移動で (0,0) はセル0、右下端はセル47", () => {
    expect(hitTestCell({ x: 1, y: 1 }, IDENTITY_VIEWPORT)).toBe(0);
    const lastCol = GRID_WIDTH - 1;
    const lastRow = GRID_HEIGHT - 1;
    const point = { x: lastCol * CELL_SIZE_PX + 1, y: lastRow * CELL_SIZE_PX + 1 };
    expect(hitTestCell(point, IDENTITY_VIEWPORT)).toBe(lastRow * GRID_WIDTH + lastCol);
  });

  it("格子の外は null", () => {
    expect(hitTestCell({ x: -1, y: 0 }, IDENTITY_VIEWPORT)).toBeNull();
    expect(hitTestCell({ x: GRID_WIDTH * CELL_SIZE_PX + 10, y: 0 }, IDENTITY_VIEWPORT)).toBeNull();
  });

  it("平行移動・ズームを考慮してセルを引き当てる", () => {
    const viewport: Viewport = { scale: 2, translateX: 50, translateY: 30 };
    // セル(col=1,row=2)の中心はコンテンツ座標 (1.5*size, 2.5*size)。
    const contentX = 1.5 * CELL_SIZE_PX;
    const contentY = 2.5 * CELL_SIZE_PX;
    const screenPoint = {
      x: contentX * viewport.scale + viewport.translateX,
      y: contentY * viewport.scale + viewport.translateY,
    };
    expect(hitTestCell(screenPoint, viewport)).toBe(2 * GRID_WIDTH + 1);
  });
});

describe("ジェスチャ状態遷移(1本指パン)", () => {
  it("1本指ドラッグでビューポートが平行移動する", () => {
    // ビューポートを格子コンテンツよりゆとりを持って広く取り、clampTranslate の
    // 半セル分マージン(CELL_SIZE_PX/2)に当たらない範囲で移動量を検証する。
    const wideBounds = { width: GRID_CONTENT_WIDTH + 200, height: GRID_CONTENT_HEIGHT + 200 };
    const down = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 100, y: 100 }, 0);
    const moved = onPointerMove(down.state, down.viewport, wideBounds, 1, { x: 130, y: 90 });
    expect(moved.viewport.translateX).toBeCloseTo(30);
    expect(moved.viewport.translateY).toBeCloseTo(-10);
  });

  it("移動量がしきい値以内・時間内で離すとタップと判定される", () => {
    const down = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 100, y: 100 }, 0);
    const up = onPointerUp(down.state, down.viewport, 1, { x: 101, y: 99 }, 50);
    expect(up.tapPoint).toEqual({ x: 101, y: 99 });
    // タップ後はジェスチャ状態が初期化される。
    expect(up.state).toEqual(INITIAL_GESTURE_STATE);
  });

  it("しきい値を超えて動かすとタップと判定されない(ドラッグ扱い)", () => {
    const down = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 100, y: 100 }, 0);
    const moved = onPointerMove(down.state, down.viewport, BOUNDS, 1, {
      x: 100 + TAP_MOVE_THRESHOLD_PX + 5,
      y: 100,
    });
    const up = onPointerUp(
      moved.state,
      moved.viewport,
      1,
      { x: 100 + TAP_MOVE_THRESHOLD_PX + 5, y: 100 },
      50,
    );
    expect(up.tapPoint).toBeNull();
  });

  it("保持時間がしきい値を超えるとタップと判定されない(長押し)", () => {
    const down = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 100, y: 100 }, 0);
    const up = onPointerUp(
      down.state,
      down.viewport,
      1,
      { x: 100, y: 100 },
      TAP_MAX_DURATION_MS + 1,
    );
    expect(up.tapPoint).toBeNull();
  });
});

describe("ジェスチャ状態遷移(2本指ピンチ)", () => {
  it("2本目が追加されるとピンチ扱いになり、距離の伸縮で倍率が変わる", () => {
    const down1 = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 90, y: 100 }, 0);
    const down2 = onPointerDown(down1.state, down1.viewport, 2, { x: 110, y: 100 }, 0);
    // 開始距離 = 20。距離を40へ広げると倍率2倍になるはず。
    const moved = onPointerMove(down2.state, down2.viewport, BOUNDS, 1, { x: 80, y: 100 });
    const moved2 = onPointerMove(moved.state, moved.viewport, BOUNDS, 2, { x: 120, y: 100 });
    expect(moved2.viewport.scale).toBeCloseTo(clampScale(2));
  });

  it("ピンチ中はタップ候補が成立しない(2本指なので離してもタップにならない)", () => {
    const down1 = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 90, y: 100 }, 0);
    const down2 = onPointerDown(down1.state, down1.viewport, 2, { x: 110, y: 100 }, 10);
    const up1 = onPointerUp(down2.state, down2.viewport, 1, { x: 90, y: 100 }, 60);
    expect(up1.tapPoint).toBeNull();
  });

  it("2本 → 1本に減ったら残り1本でパンを再開できる", () => {
    const down1 = onPointerDown(INITIAL_GESTURE_STATE, IDENTITY_VIEWPORT, 1, { x: 90, y: 100 }, 0);
    const down2 = onPointerDown(down1.state, down1.viewport, 2, { x: 110, y: 100 }, 0);
    const up2 = onPointerUp(down2.state, down2.viewport, 2, { x: 110, y: 100 }, 20);
    const moved = onPointerMove(up2.state, up2.viewport, BOUNDS, 1, { x: 90 + 15, y: 100 });
    expect(moved.viewport.translateX).toBeCloseTo(15);
  });
});
