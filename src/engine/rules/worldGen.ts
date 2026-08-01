// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 開始盤面の共通生成器 — M53
//   GDD 6.1(初期利用可は上2行) / 9.1(開墾コスト) / 10.2([2026-08-01裁定]
//   大移動後の新周回開始状態) / [2026-08-01裁定・台帳v7 必-2]
//
// ===========================================================================
// 1. なぜこれが engine 側にあるのか(rules/exodus.ts §3 からの方針転換)
// ===========================================================================
//   rules/exodus.ts は元々「開始施設をどう置くかは新規ゲーム生成(composition
//   root)の担当であり、engine はそこへ踏み込まない」としていた(初期盤面の定義が
//   engine と composition root の 2 箇所にできるのを避けるため)。
//
//   [2026-08-01裁定・台帳v7 必-2] はこれを上書きする: 「大移動後の新周回の開始
//   状態(初期施設配置・持ち込んだ資産の展開)の生成も M53 の担当」であり、
//   「初回起動と同じ生成器を通す」ことを求める。`executeExodus`
//   (rules/exodus.ts)は commands.ts からしか呼べず composition root には
//   フックする場所が無い(`MigrationScreen.tsx` が直接 `commandApplied` を
//   dispatch する)。よって「初期盤面の定義を 1 箇所に保つ」という元の動機を
//   保ったまま裁定を満たす方法は、**その 1 箇所を composition root ではなく
//   engine 側に置く**ことである。本モジュールが {@link placeStartingFacilities}
//   としてそれを持ち、`src/newGame.ts`(新規ゲーム)と `rules/exodus.ts`
//   (`executeExodus`)の両方から呼ばれる。
//
// ===========================================================================
// 2. 何を保証するか(詰み防止・ロードマップ M53 検収条件)
// ===========================================================================
//   (a) **産出先 resource entity の存在**(構造的な安全網): facility 定義が
//       resourceId を産出先に持つのに対応する resource entity が state に無いと
//       `rules/production.ts` の `applyProduction` が RulesError で止まる
//       (「産出先の resource entity が state に無いレートがある」)。新規ゲームは
//       元々どの resource entity も持たないため、content の全 facility 定義が
//       産出しうる resourceId ぶんを**在庫 0 で先に作っておく**(旧 `newGame.ts`
//       が個別にやっていたことの一般化)。
//   (b) **開始施設(かまど・作業台)の設置**: `content.facilityDefs` に両方の定義
//       (`hearth`/`workbench`)が**揃っているときだけ**行う(§3 参照)。生存住民を
//       ID 昇順に先頭から割り当てる(先頭 = かまど、次 = 作業台)。
//   (c) **開墾資源の最低保証**(GDD 9.1 の詰み防止・ロードマップ M53 検収条件
//       「詰み(資源0かつ産出手段0)にならない」): `content.reclaim` があれば、
//       その `costResourceId` の在庫を「解放数 0 の開墾 1 回ぶん」
//       (`reclaimCostFix(reclaim, 0)`)未満にしない。**上書きではなく
//       max**(既存在庫・大移動の継承ボーナスを潰さない)。
//
// ===========================================================================
// 3. content にどちらかの定義しか無い場合(既存 conformance との整合)
// ===========================================================================
//   `hearth`/`workbench` の**どちらか一方でも欠けていれば施設は 1 つも置かない**
//   (全か無か)。既存の M28 conformance 縮約 content(`hearth` のみ・`workbench`
//   無し)が本関数を経由しても盤面を変えないようにするための意図的な選択であり、
//   「揃っていない content では新機構が完全に不活性」という本リポジトリ全体の
//   規約(storage/exploration/outpost 等と同じ「省略時は不活性」)に倣う。
// ---------------------------------------------------------------------------

import { GRID_WIDTH } from "../adjacency";
import { fixFromInt, maxFix, toRaw } from "../fp";
import {
  entitiesOfKind,
  entityIdFromString,
  isRubbleCell,
  livingResidents,
  type EntityId,
  type FacilityState,
  type GameState,
  type ResourceState,
} from "../state/state";
import { putEntity, setField, updateEntity } from "../state/update";
import { reclaimCostFix } from "./reclaim";
import { RulesError, type EngineContent } from "./types";

/** content 側の定義 ID(GDD 6.2「かまど」/「作業台」)。両方揃って初めて置く(§3)。 */
const HEARTH_DEF_ID = entityIdFromString("hearth");
const WORKBENCH_DEF_ID = entityIdFromString("workbench");

/** 置く entity ID(旧 `newGame.ts` と同じ命名規約・`ui/screens/grid/facilityId.ts` 参照)。 */
const HEARTH_ENTITY_ID = entityIdFromString("facHearth1");
const WORKBENCH_ENTITY_ID = entityIdFromString("facWorkbench1");

/** かまどを置くセル(上2行のうち左上・GDD 6.1)。 */
export const STARTER_HEARTH_CELL = 0;
/** 作業台を置くセル(かまどと同じ行・8近傍が重ならない列・GDD 6.1)。 */
export const STARTER_WORKBENCH_CELL = GRID_WIDTH - 1;

/** `stem` + ID 先頭大文字化(`ui/screens/grid/facilityId.ts` の採番規約と同型)。 */
function capitalize(value: string): string {
  const head = value.charAt(0);
  return head.toUpperCase() + value.slice(1);
}

function stockEntityIdFor(resourceId: EntityId): EntityId {
  return entityIdFromString(`stock${capitalize(resourceId)}`);
}

// --- 1. 産出先 resource entity の存在保証(§2(a)) ---------------------------

/**
 * content の全 facility 定義が産出しうる resourceId ぶん、resource entity を
 * **在庫 0 で無ければ作る**(既存の在庫は一切変更しない)。
 *
 * `rules/production.ts` の `applyProduction` が構造的に要求する不変条件
 * (産出先の resourceId には対応する resource entity が要る)を、新規ゲーム
 * 生成の時点で先回りして満たす。
 */
function ensureProducibleResourceEntities(state: GameState, content: EngineContent): GameState {
  const known = new Set<EntityId>();
  for (const resource of entitiesOfKind(state, "resource")) {
    known.add(resource.resourceId);
  }
  let next = state;
  const producedIds: EntityId[] = [];
  for (const def of content.facilityDefs.values()) {
    if (def.output.kind !== "resource") continue;
    producedIds.push(def.output.resourceId);
  }
  // ID 昇順で走査する(施設定義 Map の反復順は content ロード側が正準化済みだが、
  // 新規作成する entity の順序を content の宣言順に依存させないため明示ソート)。
  producedIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const resourceId of producedIds) {
    if (known.has(resourceId)) continue;
    known.add(resourceId);
    const entity: ResourceState = {
      kind: "resource",
      id: stockEntityIdFor(resourceId),
      resourceId,
      stock: fixFromInt(0),
    };
    next = putEntity(next, entity);
  }
  return next;
}

// --- 2. 開始施設の設置(§2(b)) -----------------------------------------------

/**
 * 生存住民を ID 昇順に先頭から割り当てる(かまど→作業台の順)。
 * どちらも定員 1(content の `slots.lv1`)なので 1 人ずつでよい。
 */
function placeHearthAndWorkbench(state: GameState, content: EngineContent): GameState {
  const hearthDef = content.facilityDefs.get(HEARTH_DEF_ID);
  const workbenchDef = content.facilityDefs.get(WORKBENCH_DEF_ID);
  if (hearthDef === undefined || workbenchDef === undefined) return state;

  if (entitiesOfKind(state, "facility").length > 0) {
    throw new RulesError(
      "placeStartingFacilities: state に既に facility entity がある" +
        "(開始施設の設置は施設ゼロの盤面にだけ行う前提・worldGen.ts §1)",
    );
  }
  if (isRubbleCell(state, STARTER_HEARTH_CELL) || isRubbleCell(state, STARTER_WORKBENCH_CELL)) {
    throw new RulesError(
      `placeStartingFacilities: 開始施設のセル(${String(STARTER_HEARTH_CELL)}/` +
        `${String(STARTER_WORKBENCH_CELL)})が瓦礫になっている(content の` +
        "reclaim.initialRubbleCells が上2行を含んでいないか確認)",
    );
  }

  const crew = livingResidents(state); // ID 昇順(state.ts §2)。
  const hearthWorkerId = crew[0]?.id ?? null;
  const workbenchWorkerId = crew[1]?.id ?? null;

  const hearth: FacilityState = {
    kind: "facility",
    id: HEARTH_ENTITY_ID,
    defId: HEARTH_DEF_ID,
    level: 1,
    cellIndex: STARTER_HEARTH_CELL,
    workerIds: hearthWorkerId === null ? [] : [hearthWorkerId],
  };
  const workbench: FacilityState = {
    kind: "facility",
    id: WORKBENCH_ENTITY_ID,
    defId: WORKBENCH_DEF_ID,
    level: 1,
    cellIndex: STARTER_WORKBENCH_CELL,
    workerIds: workbenchWorkerId === null ? [] : [workbenchWorkerId],
  };

  let next = putEntity(state, hearth);
  next = putEntity(next, workbench);
  if (hearthWorkerId !== null) {
    next = updateEntity(next, hearthWorkerId, "resident", (r) =>
      setField(r, "assignedFacilityId", HEARTH_ENTITY_ID),
    );
  }
  if (workbenchWorkerId !== null) {
    next = updateEntity(next, workbenchWorkerId, "resident", (r) =>
      setField(r, "assignedFacilityId", WORKBENCH_ENTITY_ID),
    );
  }
  return next;
}

// --- 3. 開墾資源の最低保証(§2(c)) -------------------------------------------

/**
 * `content.reclaim.costResourceId` の在庫を「解放数 0 の開墾 1 回ぶん」未満に
 * しない(GDD 9.1 の詰み防止)。既存在庫(大移動の継承ボーナス等)は max で
 * 保つので**減らすことはない**。
 */
function ensureReclaimFloor(state: GameState, content: EngineContent): GameState {
  const params = content.reclaim;
  if (params === undefined) return state;
  const floorFix = reclaimCostFix(params, 0);

  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId !== params.costResourceId) continue;
    if (toRaw(resource.stock) >= toRaw(floorFix)) return state;
    return updateEntity(state, resource.id, "resource", (r) =>
      setField(r, "stock", maxFix(r.stock, floorFix)),
    );
  }
  const entity: ResourceState = {
    kind: "resource",
    id: stockEntityIdFor(params.costResourceId),
    resourceId: params.costResourceId,
    stock: floorFix,
  };
  return putEntity(state, entity);
}

// --- 4. 公開口 ---------------------------------------------------------------

/**
 * 開始盤面の共通生成器(§0)。**新規ゲームと大移動後の新周回の両方が通る**。
 *
 * 呼び出し前提: 施設を 1 つも持たない state(新規ゲームの素の盤面、または
 * `executeExodus` が施設を捨てた直後の次周 state)。既に施設がある state へ
 * 呼ぶと {@link RulesError} で止まる(§2(b))。
 *
 * 何もしない場合があることに注意(§3): `hearth`/`workbench` の定義が
 * どちらか欠けていれば施設は置かない。`content.reclaim` が無ければ開墾資源の
 * 最低保証も行わない(= それぞれ既存の「省略時は不活性」規約どおり)。
 *
 * @throws {RulesError} 既に facility entity がある / 開始セルが瓦礫の場合
 */
export function placeStartingFacilities(state: GameState, content: EngineContent): GameState {
  let next = ensureProducibleResourceEntities(state, content);
  next = placeHearthAndWorkbench(next, content);
  next = ensureReclaimFloor(next, content);
  return next;
}
