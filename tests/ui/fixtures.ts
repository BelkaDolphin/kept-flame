// ---------------------------------------------------------------------------
// UI ストア(src/ui/**)のテスト用フィクスチャ。
//
// vitest の include は `tests/**/*.{test,spec}.ts` なので、このファイル自体は
// テストとして収集されない共有ヘルパである。
//
// 盤面は engine 側のフィクスチャ(tests/engine/fixtures.ts)をそのまま使い、
// **施設の配置だけ**を fan-in 上界(ADR-002(2))が測れる形に組む:
//
//   6×8 格子(cellIndex = y*6 + x)
//     セル 14 (x2,y2) : かまど fHearth(就労者あり)
//     セル 15 (x3,y2) : かまど fEast   … 14 の東隣 = 互いに 8 近傍
//     セル 40 (x4,y6) : かまど fFar    … 14/15 のどちらの近傍でもない遠方セル
//
//   セル 21 (x3,y3) は 14 と 15 の**両方の近傍**であり、かつ 40 の近傍ではない。
//   ここに施設を置くと「近傍だけが再計算される」ことを 1 手で検証できる。
// ---------------------------------------------------------------------------

import { neighborCellIndices } from "../../src/engine/adjacency";
import type { EngineContent } from "../../src/engine/rules/types";
import type { EntityState, GameState, GameStateMeta } from "../../src/engine/state/state";
import { createGameStore, type GameStore } from "../../src/ui/store";
import {
  HEARTH,
  SMELTER,
  STUDY_DESK,
  TECH_BRONZE,
  WOOD,
  content,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
} from "../engine/fixtures";

/** 基準セル(かまど・就労者あり)。 */
export const CELL_CENTER = 14;
/** 基準セルの東隣(8 近傍)。 */
export const CELL_EAST = 15;
/** 基準セルの南東(8 近傍)。空きセルとして開けてある。 */
export const CELL_SOUTHEAST = 21;
/** 基準セルの西隣(8 近傍)。空きセルとして開けてある。 */
export const CELL_WEST = 13;
/** どのセルの近傍でもない遠方セル。 */
export const CELL_FAR = 40;

export const WORKER_ID = id("aRui");

/** 盤面の基本 entity。追加分は `boardState` の引数で足す。 */
export function baseEntities(): EntityState[] {
  return [
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    facility("fHearth", HEARTH.id, CELL_CENTER, [WORKER_ID]),
    facility("fEast", HEARTH.id, CELL_EAST),
    facility("fFar", HEARTH.id, CELL_FAR),
    research("rBronze", TECH_BRONZE.id, 0),
    resource("wStock", WOOD),
  ];
}

export function boardState(
  extra: readonly EntityState[] = [],
  meta: Partial<GameStateMeta> = {},
): GameState {
  return stateOf([...baseEntities(), ...extra], meta);
}

export function boardContent(): EngineContent {
  return content();
}

export interface TestStoreSetup {
  readonly store: GameStore;
  readonly state: GameState;
  readonly content: EngineContent;
}

export function createTestStore(extra: readonly EntityState[] = []): TestStoreSetup {
  const state = boardState(extra);
  const engineContent = boardContent();
  return {
    store: createGameStore({ state, content: engineContent }),
    state,
    content: engineContent,
  };
}

/** 全 48 セルの派生値を 1 度読んで、再計算カウンタの起点を作る。 */
export function primeAllCells(store: GameStore): void {
  for (const node of store.derived.cellAdjacency) void node.value;
  for (const node of store.derived.cellView) void node.value;
}

/** 48 セルぶんの再計算回数のスナップショット。 */
export function recomputeCounts(nodes: readonly { readonly recomputeCount: number }[]): number[] {
  return nodes.map((node) => node.recomputeCount);
}

/** 再計算回数が増えたセル番号(昇順)。 */
export function changedCells(before: readonly number[], after: readonly number[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < after.length; i++) {
    const previous = before[i] ?? 0;
    const current = after[i] ?? 0;
    if (current > previous) result.push(i);
  }
  return result;
}

/** 配列の要素を取り出す(noUncheckedIndexedAccess 対策。無ければ即例外)。 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`index ${String(index)} が範囲外(length ${String(items.length)})`);
  }
  return item;
}

/** 自セル + 8 近傍(ADR-002(2) の fan-in 上界の集合)。昇順。 */
export function neighborhoodOf(cellIndex: number): number[] {
  return [cellIndex, ...neighborCellIndices(cellIndex)].sort((a, b) => a - b);
}

export { HEARTH, SMELTER, STUDY_DESK, TECH_BRONZE, WOOD, facility, id, resident, resource };
