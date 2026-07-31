// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 新規ゲームの初期盤面(M29・**暫定**)
//
// ===========================================================================
// 0. これは仮置きである(★ 要ユーザー判断)
// ===========================================================================
//   **ロードマップに「ニューゲーム生成」を担当するタスクが存在しない**
//   (M1〜M52 を検索しても初期盤面の定義はどのタスクにも割り当てられていない)。
//   一方でアプリシェル(M29)は「起動したら遊べる状態」が無いと 1 画面も出せない
//   ため、ここに**起動に必要な最小の盤面**を置く。
//
//   暫定である点を隠さないために、以下を明示しておく:
//     (a) worldSeed は固定文字列。周回ごとのシード導出は M28(大移動)の担当で
//         あり、初回シードの決め方(難度「穏」の選択・GDD 2.2)は未割当。
//     (b) 住民は `life` を持たない = **寿命で死なない**。寿命の抽選
//         (`rules/lifespan.ts` の `createResidentLife`)は RNG ストリームを
//         要求し、それを「新規ゲーム生成」としてどう回すかが未設計である。
//     (c) 初期資源・初期施設・人数はバランス調整(M39〜M41)の対象であり、
//         ここの数値に根拠は無い(人口 6 だけは GDD 7.6 の人口下限に合わせた)。
//
//   engine / content / schema は 1 行も変えていない。ここは composition root
//   (`src/main.tsx`)側の組み立てであり、engine から見れば「外から渡された
//   ただの GameState」である。
// ---------------------------------------------------------------------------

import { GRID_WIDTH } from "./engine/adjacency";
import { fixFromInt } from "./engine/fp";
import { initialTerrain } from "./engine/rules/reclaim";
import { requireFacilityDef, type EngineContent } from "./engine/rules/types";
import {
  entityIdFromString,
  type EntityId,
  type EntityState,
  type GameState,
  type GameStateMeta,
} from "./engine/state/state";
import { createGameState } from "./engine/state/update";
import { SAVE_SCHEMA_VERSION } from "./platform/migration";

const eid = entityIdFromString;

/** 【暫定】固定の世界シード(§0(a))。 */
export const NEW_GAME_WORLD_SEED = "kept-flame-mvp-2026";

/** 【暫定】開始時の住民(GDD 7.6 の人口下限 6 に合わせた 6 名)。 */
const STARTING_RESIDENT_NAMES = ["rui", "kaya", "seri", "tou", "mio", "hazu"] as const;

/** 【暫定】開始時の薪(firewood)。開墾 1 回ぶん(baseCost 40)を少し超える量。 */
const STARTING_FIREWOOD = 60;

/** 【暫定】開始時の粘土(石板 1 枚 = baseCost 20 相当)。 */
const STARTING_CLAY = 20;

/** かまど(1×1・熱源・薪産出)を置くセル。上 2 行(瓦礫でない領域)の左上。 */
const HEARTH_CELL = 0;
/** 作業台(1×1・学芸・研究点産出)を置くセル。かまどの 8 近傍を避けた同じ行。 */
const WORKBENCH_CELL = GRID_WIDTH - 1;

export interface NewGameOptions {
  /**
   * 決定論バンドルの版(ADR-016 の 3 軸(c))。**content の `balance.algoVersion`
   * をそのまま渡す**。`EngineContent` はこの値を持たない(engine が読む必要が
   * 無い値なので `schema/engineContent.ts` が写していない)ため、composition
   * root が content JSON から渡す。
   */
  readonly algoVersion: number;
  /** content の版(ADR 3 軸(b))。既定 1。 */
  readonly contentVersion?: number;
  /** 世界シード。既定は {@link NEW_GAME_WORLD_SEED}(§0(a) の暫定固定値)。 */
  readonly worldSeed?: string;
}

/**
 * 新規ゲームの初期 state を組み立てる(§0 の暫定条件つき)。
 *
 * 地形(瓦礫)は content(`balance.reclaim.initialRubbleCells`)から
 * engine の {@link initialTerrain} が作る = UI 側で瓦礫配置を決め打ちしない。
 *
 * @throws {RulesError} content に hearth / workbench の定義が無い場合
 */
export function createNewGameState(content: EngineContent, options: NewGameOptions): GameState {
  const hearthDefId = eid("hearth");
  const workbenchDefId = eid("workbench");
  requireFacilityDef(content, hearthDefId);
  requireFacilityDef(content, workbenchDefId);

  const hearthId = eid("facHearth1");
  const workbenchId = eid("facWorkbench1");

  const residentIds: EntityId[] = STARTING_RESIDENT_NAMES.map((name) => eid(`res${name}`));
  const hearthWorkerId = residentIds[0];
  const workbenchWorkerId = residentIds[1];
  if (hearthWorkerId === undefined || workbenchWorkerId === undefined) {
    throw new RangeError("開始住民が 2 名未満(STARTING_RESIDENT_NAMES の設定ミス)");
  }

  const entities: EntityState[] = [];
  for (const residentId of residentIds) {
    const assigned =
      residentId === hearthWorkerId
        ? hearthId
        : residentId === workbenchWorkerId
          ? workbenchId
          : null;
    entities.push({
      kind: "resident",
      id: residentId,
      morale: fixFromInt(60),
      mastery: fixFromInt(0),
      assignedFacilityId: assigned,
      dispatched: false,
      traitIds: [],
      recallImpairedUntilTick: 0,
    });
  }

  entities.push({
    kind: "facility",
    id: hearthId,
    defId: hearthDefId,
    level: 1,
    cellIndex: HEARTH_CELL,
    workerIds: [hearthWorkerId],
  });
  entities.push({
    kind: "facility",
    id: workbenchId,
    defId: workbenchDefId,
    level: 1,
    cellIndex: WORKBENCH_CELL,
    workerIds: [workbenchWorkerId],
  });

  // 産出先の resource entity が state に無いレートがあると engine が止まる
  // (rules/production.ts の `applyProduction`)。content の facility が産出する
  // 資源(firewood / iron)と、成文化・保管の受け皿(clay / paper / waste)を
  // 最初から置いておく。
  const startingStock: readonly (readonly [string, string, number])[] = [
    ["stockFirewood", "firewood", STARTING_FIREWOOD],
    ["stockClay", "clay", STARTING_CLAY],
    ["stockIron", "iron", 0],
    ["stockPaper", "paper", 0],
    ["stockWaste", "waste", 0],
  ];
  for (const [entityName, resourceName, stock] of startingStock) {
    entities.push({
      kind: "resource",
      id: eid(entityName),
      resourceId: eid(resourceName),
      stock: fixFromInt(stock),
    });
  }

  // 最初の研究は「火起こし」= 拠点の全ての起点(GDD 5.2)。engine の研究は
  // 「未完了 research entity の ID 昇順で先頭 1 本」という縮約なので
  // (rules/research.ts §2 / architecture.md §9-6)、開始時は 1 本だけ積む。
  entities.push({
    kind: "research",
    id: eid("resFireStarting"),
    techId: eid("techFireStarting"),
    progress: fixFromInt(0),
    completedTick: null,
  });

  const meta: GameStateMeta = {
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    contentVersion: options.contentVersion ?? 1,
    algoVersion: options.algoVersion,
    worldSeed: options.worldSeed ?? NEW_GAME_WORLD_SEED,
    tick: 0,
  };

  return createGameState(meta, entities, [], [], [], [], undefined, [], initialTerrain(content));
}
