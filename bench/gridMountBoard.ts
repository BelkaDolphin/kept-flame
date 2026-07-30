// ---------------------------------------------------------------------------
// GridBoard 実 DOM マウント計測(M19・M18 の申し送り★2)の代表盤面
//
// M18 完了報告は `bench/perf.html` の B4 計測が`bench/perfGrid.tsx`(簡易な
// 代理 DOM モデル・5要素/セル固定)だったため、実際の `GridBoard.tsx`
// (M17/M18/M19 の本体・4重符号化込み)の mount 時間が未計測のままだった
// (ロードマップ M18 行・MEMORY.md [2026-07-27] T14 直前の申し送り参照)。
//
// 本盤面は「48 セル全部を埋めた繁忙な盤面」を作る。目的は2つ:
//   1. 実際に `GridBoard` がマウントする DOM 要素数を実測する(4重符号化・
//      過密バッジ込みで、簡易モデルの「240」からどれだけ変わるかを正直に見る)
//   2. 過密ペナルティ(常時過密警告バッジ)・連結セル(2×1 の forge)を
//      両方とも盤面に含め、実際の意匠がフルに描かれる状態で計測する
//
// content は `bench/perfBoard.ts` の `loadPerfContent`(validateContentBundle →
// loadEngineContentOrThrow という本番と同じ入口)をそのまま再利用する
// (T10 が固めた「content ロードの正規経路」を再実装しない)。
//
// 配置規則(GRID_WIDTH=6 の1行ぶん・8行くり返し):
//   列 0-1: forge(2×1・熱源+過酷業務)  … アンカー+連結セルの両方を作る
//   列 2  : hearth(1×1・熱源)
//   列 3  : workbench(1×1・学芸)
//   列 4  : hearth(1×1・熱源)
//   列 5  : workbench(1×1・学芸)
// 1 行に熱源施設が 3 基(forge+hearth×2)集まるため、8近傍の熱源密度が
// overcrowd.threshold(content既定3)を超え、常時過密警告バッジが実際に
// 描画される盤面になる。
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT, GRID_WIDTH } from "../src/engine/adjacency";
import { requireFacilityDef, type EngineContent } from "../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityId,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
} from "../src/engine/state/state";
import { createGameState } from "../src/engine/state/update";

const eid = entityIdFromString;

export const GRID_MOUNT_WORLD_SEED = "grid-mount-bench-2026-07-31";

const HEARTH_DEF_ID = eid("hearth");
const FORGE_DEF_ID = eid("forge");
const WORKBENCH_DEF_ID = eid("workbench");

function baseMeta(): GameStateMeta {
  return {
    saveSchemaVersion: 2,
    contentVersion: 1,
    algoVersion: 1,
    worldSeed: GRID_MOUNT_WORLD_SEED,
    tick: 0,
  };
}

/**
 * 48 セル全部を占有する代表盤面(entity 48 施設ぶん・住民なし=就労者0人表示)。
 *
 * @throws {RulesError} content に hearth/forge/workbench が無い場合
 */
export function buildGridMountBoard(content: EngineContent): GameState {
  requireFacilityDef(content, HEARTH_DEF_ID);
  requireFacilityDef(content, FORGE_DEF_ID);
  requireFacilityDef(content, WORKBENCH_DEF_ID);

  const facilities: FacilityState[] = [];
  const rows = GRID_CELL_COUNT / GRID_WIDTH;
  let facilityIndex = 0;

  for (let row = 0; row < rows; row++) {
    const rowBase = row * GRID_WIDTH;
    // 列 0-1: forge(2×1)。
    facilities.push({
      kind: "facility",
      id: eid(`facilityForge${String(facilityIndex++)}`),
      defId: FORGE_DEF_ID,
      level: 1 + (row % 5),
      cellIndex: rowBase,
      workerIds: [],
      footprint: { width: 2, height: 1 },
    });
    // 列 2: hearth。
    facilities.push({
      kind: "facility",
      id: eid(`facilityHearth${String(facilityIndex++)}`),
      defId: HEARTH_DEF_ID,
      level: 1 + (row % 5),
      cellIndex: rowBase + 2,
      workerIds: [],
    });
    // 列 3: workbench。
    facilities.push({
      kind: "facility",
      id: eid(`facilityWorkbench${String(facilityIndex++)}`),
      defId: WORKBENCH_DEF_ID,
      level: 1 + (row % 5),
      cellIndex: rowBase + 3,
      workerIds: [],
    });
    // 列 4: hearth。
    facilities.push({
      kind: "facility",
      id: eid(`facilityHearth${String(facilityIndex++)}`),
      defId: HEARTH_DEF_ID,
      level: 1 + (row % 5),
      cellIndex: rowBase + 4,
      workerIds: [],
    });
    // 列 5: workbench。
    facilities.push({
      kind: "facility",
      id: eid(`facilityWorkbench${String(facilityIndex++)}`),
      defId: WORKBENCH_DEF_ID,
      level: 1 + (row % 5),
      cellIndex: rowBase + 5,
      workerIds: [],
    });
  }

  const entities: EntityState[] = [...facilities];
  return createGameState(baseMeta(), entities);
}

/** 施設数(=占有セル数。forge が 2×1 なので facility 数は 48 より少ない)。 */
export function gridMountFacilityCount(): number {
  const rows = GRID_CELL_COUNT / GRID_WIDTH;
  return rows * 5; // forge 1 + hearth 2 + workbench 2 = 5施設/行。
}

// EntityId は型のみの利用(将来の呼び出し側の型注釈用に re-export)。
export type { EntityId };
