// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 開始盤面の共通生成器 — M53 / M68
//   GDD 6.1(初期利用可は上2行) / 7.7(寝床上限・晴天漂着) / 9.1(開墾コスト) /
//   10.2([2026-08-01裁定] 大移動後の新周回開始状態) / [2026-08-01裁定・台帳v7
//   必-2] / [2026-08-04裁定・台帳v17 必-5](M68・経緯は§2(d)/(e))
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
//   (a') **廃材の受け皿の存在**(同じ安全網の廃材版・[2026-08-02 / R2-A01]):
//       (a) は「facility が産出する資源」しか作らない。廃材(GDD 6.7 のスポンジ
//       機構が生む資源)は**どの facility も産出しない**ので (a) の網から漏れる。
//       漏れたまま保管庫が建って在庫が上限を超えると、`rules/production.ts` の
//       `creditWaste` が「生んだ廃材を黙って捨てない」ために毎 tick 例外で止まり、
//       時計・産出・オートセーブが停止する(プレイテスト評価 Round 2 の fatal
//       R2-A01。M5 のスポンジ導入時から潜伏し、保管庫 content が揃った M58 以降に
//       初めて到達可能になった)。よって `content.storage.wasteResourceId` が
//       宣言されていれば、その resource entity を**在庫 0 で先に作っておく**。
//       engine 側の例外(黙って捨てない防御)は正しいので変更しない —— 直すのは
//       「受け皿を作り忘れている生成器」の側である。
//   (b) **開始施設(かまど・作業台)の設置**: `content.facilityDefs` に両方の定義
//       (`hearth`/`workbench`)が**揃っているときだけ**行う(§3 参照)。生存住民を
//       ID 昇順に先頭から割り当てる(先頭 = かまど、次 = 作業台)。
//   (c) **開墾資源の最低保証**(GDD 9.1 の詰み防止・ロードマップ M53 検収条件
//       「詰み(資源0かつ産出手段0)にならない」): `content.reclaim` があれば、
//       その `costResourceId` の在庫を「解放数 0 の開墾 1 回ぶん」
//       (`reclaimCostFix(reclaim, 0)`)未満にしない。**上書きではなく
//       max**(既存在庫・大移動の継承ボーナスを潰さない)。
//   (d) **[M68] 初期寝床の設置**(R4-A15): `content.facilityDefs` に `bed` の
//       定義があるときだけ、Lv1 の寝床を 2 基置く(§3' 参照)。修正前は寝床上限が
//       常に 0 で、(ア) home 画面の「生存人口/寝床上限」が常に人口超過の壊れた
//       見た目になる (イ) `rules/population.ts` の晴天漂着が
//       `bedCapacity < 1` で毎回不活性化し、「寝床上限 > 人口」という発生条件
//       (GDD 7.7)そのものが**構造的に**成立しえない、の 2 つが起きていた。
//       2 基という数の根拠は §3' のコメントを参照(★要ユーザー判断・暫定)。
//   (e) **[M68] 石板 1 枚ぶんの粘土の最低保証**(R4-A11): `content.recordMedia`
//       があれば、その `byMedium.stoneTablet` の 1 回ぶん
//       (`baseCostFix × costMulFix`)を costResourceId の在庫が下回らないよう
//       にする。(c) と同じ **max(上書きしない)**。旧実装はこれを
//       `src/newGame.ts` にしか持たず、`executeExodus` は本モジュールしか
//       通らないため新周回では粘土 0 のまま石板成文化が構造的に不可能だった。
//       ここへ引き上げることで新規ゲーム・新周回のどちらでも満たされる。
//
// ===========================================================================
// 3. content にどちらかの定義しか無い場合(既存 conformance との整合)
// ===========================================================================
//   `hearth`/`workbench` の**どちらか一方でも欠けていれば施設は 1 つも置かない**
//   (全か無か)。既存の M28 conformance 縮約 content(`hearth` のみ・`workbench`
//   無し)が本関数を経由しても盤面を変えないようにするための意図的な選択であり、
//   「揃っていない content では新機構が完全に不活性」という本リポジトリ全体の
//   規約(storage/exploration/outpost 等と同じ「省略時は不活性」)に倣う。
//
//   **[M68] 寝床(`bed`)の活性条件は独立**である(hearth/workbench の有無に
//   連動しない)。既存の「全か無か」は hearth と workbench という**2 つの定義が
//   組で 1 つの機能**を成すことの反映であり、寝床は単独の定義 1 つで機能が
//   完結するため、同じ理由がそのまま当てはまらない。conformance 縮約 content が
//   `bed` を持たないことは変わらないので、既存 golden vector への影響はやはり無い
//   (conformance/scenarios.ts は本モジュールを一度も呼ばない・conformance
//   content-snapshot に `bed` があってもここには効かない)。
//
// ===========================================================================
// 3'. 初期寝床の数(★要ユーザー判断・[2026-08-04裁定・台帳v17 必-5] M68)
// ===========================================================================
//   **2 基(いずれも Lv1)固定**。根拠:
//     - 現行 content(`content/facility.json`)の `bed.bedCapacityCurve[0]` = 3。
//       2 基 = 寝床上限 6 は、現行の初期人口 6(`src/newGame.ts` の
//       `STARTING_RESIDENT_NAMES`)と**ちょうど一致**する。
//     - 1 基(上限 3)では「生存人口/寝床上限」が今までどおり人口超過に見えたまま
//       残り、R4-A15 の見た目の壊れ方(§2(d))が直らない。3 基(上限 9)は
//       現在の初期人口に対して過剰——というのが「最小限」の判断基準。
//     - 晴天漂着(GDD 7.7)は「寝床上限 > 生存人口」が発生条件なので、新規ゲーム
//       開始直後(人口 6 = 上限 6)には即座には動かない。ここで直しているのは
//       「寝床上限 0 だと死亡が起きても永久に発生しない」という**構造的な閉塞**
//       であって、開始 tick から実際に漂着させることではない —— 寝床上限が
//       1 以上になった時点で `rules/population.ts` §1 の不活性条件が外れ、
//       死亡で人口が下限(3 = 上限6×0.5)まで落ちれば漂着が実際に起こるように
//       なる。R4-A15 の指摘する「発生条件が閉じたまま」の解消はこれで足りる。
//     - 新周回(`executeExodus`)の乗員は多くの場合 6 未満(GDD 10.2 の乗員定員
//       `ceil(生存人数×0.5)+ボーナス`)なので、固定 2 基は新周回でも同じ理屈で
//       足りる側に振れる。継承ボーナスの蓄積で乗員が 6 を超える極端なセーブでは
//       再び人口超過の見た目が戻りうるが、**本校正は M41 帯のバランス再評価まで
//       の暫定**でよい(タスク仕様どおり)。
//
//   セルは初期利用可能領域(GDD 9.1 の上2行・§2(b) の hearth/workbench と同じ
//   `content.reclaim.initialRubbleCells` が空けている領域)のうち、hearth
//   (セル0)/workbench(セル{@link STARTER_WORKBENCH_CELL})と重ならない 2 行目
//   先頭 2 マスを使う(§2' 実装)。
// ---------------------------------------------------------------------------

import { GRID_WIDTH } from "../adjacency";
import { facilityOccupyingCell } from "../footprint";
import { fixFromInt, maxFix, mulFix, toRaw, type Fix } from "../fp";
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

/** [M68] content 側の「寝床」定義 ID(GDD 6.2「寝床」・contentLabels.ts)。 */
const BED_DEF_ID = entityIdFromString("bed");

/** [M68] 置く entity ID(hearth/workbench と同じ命名規約)。 */
const BED_ENTITY_ID_1 = entityIdFromString("facBed1");
const BED_ENTITY_ID_2 = entityIdFromString("facBed2");

/** [M68] 寝床を置くセル(2行目の先頭2マス・§3' の数の根拠を参照)。 */
export const STARTER_BED_CELL_1 = GRID_WIDTH;
export const STARTER_BED_CELL_2 = GRID_WIDTH + 1;

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

/**
 * [R2-A01] 廃材(`content.storage.wasteResourceId`)の resource entity を
 * **在庫 0 で無ければ作る**(既存の在庫は一切変更しない)。
 *
 * {@link ensureProducibleResourceEntities} と同じ「受け皿を先回りで用意する」
 * 安全網だが、廃材はどの facility 定義の産出先にも現れないため別建てになる
 * (§2(a'))。`content.storage` が無い / `wasteResourceId` が null の content では
 * 何もしない(本リポジトリ共通の「省略時は不活性」規約 = 縮約 content や既存
 * conformance シナリオの盤面を 1 bit も変えない)。
 */
function ensureWasteResourceEntity(state: GameState, content: EngineContent): GameState {
  const wasteResourceId = content.storage?.wasteResourceId;
  if (wasteResourceId === undefined || wasteResourceId === null) return state;
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === wasteResourceId) return state;
  }
  const entity: ResourceState = {
    kind: "resource",
    id: stockEntityIdFor(wasteResourceId),
    resourceId: wasteResourceId,
    stock: fixFromInt(0),
  };
  return putEntity(state, entity);
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

// --- 2'. 初期寝床の設置(§2(d) / §3') -----------------------------------------

/**
 * [M68] 初期配置に寝床(Lv1)を 2 基含める(R4-A15 / [2026-08-04裁定・台帳v17
 * 必-5])。数と根拠は§3' 参照。`content.facilityDefs` に `bed` の定義が無ければ
 * 何もしない(hearth/workbench の有無とは独立の「省略時は不活性」・§3)。
 *
 * hearth/workbench の**後**に呼ぶ前提(`placeStartingFacilities` §4 の順序)。
 * hearth/workbench 側は「施設ゼロの盤面にだけ行う」を前提にしているため、寝床は
 * 自分の対象セルだけを衝突検査する(全体がゼロであることは要求しない)。
 *
 * @throws {RulesError} 対象セルが瓦礫、または既に施設が置かれている場合
 */
function placeStartingBeds(state: GameState, content: EngineContent): GameState {
  const bedDef = content.facilityDefs.get(BED_DEF_ID);
  if (bedDef === undefined) return state;
  const capacityLv1 = bedDef.bedCapacityByLevel?.[0];
  if (capacityLv1 === undefined || capacityLv1 <= 0) return state;

  for (const cellIndex of [STARTER_BED_CELL_1, STARTER_BED_CELL_2]) {
    if (isRubbleCell(state, cellIndex)) {
      throw new RulesError(
        `placeStartingBeds: 開始寝床のセル(${String(cellIndex)})が瓦礫になっている` +
          "(content の reclaim.initialRubbleCells が上2行を含んでいないか確認)",
      );
    }
    if (facilityOccupyingCell(state, cellIndex) !== undefined) {
      throw new RulesError(
        `placeStartingBeds: 開始寝床のセル(${String(cellIndex)})に既に施設がある` +
          "(worldGen.ts §2' の前提=そのセルが空の盤面にだけ行う)",
      );
    }
  }

  const bed1: FacilityState = {
    kind: "facility",
    id: BED_ENTITY_ID_1,
    defId: BED_DEF_ID,
    level: 1,
    cellIndex: STARTER_BED_CELL_1,
    workerIds: [],
  };
  const bed2: FacilityState = {
    kind: "facility",
    id: BED_ENTITY_ID_2,
    defId: BED_DEF_ID,
    level: 1,
    cellIndex: STARTER_BED_CELL_2,
    workerIds: [],
  };
  return putEntity(putEntity(state, bed1), bed2);
}

// --- 3. 資源の最低保証(§2(c) / §2(e))----------------------------------------

/**
 * 資源 entity の在庫を「少なくとも floor」にする(既存在庫は max で保つ・
 * §2(c)/(e) の共通実装)。対象 resourceId の entity が state に無ければ floor
 * で新規作成する。
 */
function ensureResourceStockFloor(
  state: GameState,
  resourceId: EntityId,
  floorFix: Fix,
): GameState {
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId !== resourceId) continue;
    if (toRaw(resource.stock) >= toRaw(floorFix)) return state;
    return updateEntity(state, resource.id, "resource", (r) =>
      setField(r, "stock", maxFix(r.stock, floorFix)),
    );
  }
  const entity: ResourceState = {
    kind: "resource",
    id: stockEntityIdFor(resourceId),
    resourceId,
    stock: floorFix,
  };
  return putEntity(state, entity);
}

/**
 * `content.reclaim.costResourceId` の在庫を「解放数 0 の開墾 1 回ぶん」未満に
 * しない(GDD 9.1 の詰み防止)。既存在庫(大移動の継承ボーナス等)は max で
 * 保つので**減らすことはない**。
 */
function ensureReclaimFloor(state: GameState, content: EngineContent): GameState {
  const params = content.reclaim;
  if (params === undefined) return state;
  return ensureResourceStockFloor(state, params.costResourceId, reclaimCostFix(params, 0));
}

/**
 * [M68] 石板 1 枚ぶんの粘土(`baseCostFix × byMedium.stoneTablet.costMulFix`)を
 * 下限保証する(R4-A11 / §2(e))。`content.recordMedia` が無い content(成文化
 * そのものが不活性)では何もしない。`ensureReclaimFloor` と同じ max 方式なので
 * 既存在庫(大移動の継承ボーナス等)を減らすことはない。
 */
function ensureClayFloor(state: GameState, content: EngineContent): GameState {
  const recordMedia = content.recordMedia;
  if (recordMedia === undefined) return state;
  const stoneTablet = recordMedia.byMedium.stoneTablet;
  const floorFix = mulFix(recordMedia.baseCostFix, stoneTablet.costMulFix);
  return ensureResourceStockFloor(state, stoneTablet.costResourceId, floorFix);
}

// --- 4. 公開口 ---------------------------------------------------------------

/**
 * 開始盤面の共通生成器(§0)。**新規ゲームと大移動後の新周回の両方が通る**。
 *
 * 呼び出し前提: 施設を 1 つも持たない state(新規ゲームの素の盤面、または
 * `executeExodus` が施設を捨てた直後の次周 state)。既に hearth/workbench や
 * 寝床セルに施設がある state へ呼ぶと {@link RulesError} で止まる(§2(b)/(d))。
 *
 * 何もしない場合があることに注意(§3): `hearth`/`workbench` の定義が
 * どちらか欠けていれば施設は置かない。`bed` の定義が無ければ寝床も置かない
 * (§2(d)・hearth/workbench とは独立の判定)。`content.reclaim` が無ければ
 * 開墾資源の最低保証も行わず、`content.recordMedia` が無ければ粘土の最低保証も
 * 行わず、`content.storage.wasteResourceId` が無ければ廃材の受け皿も作らない
 * (= それぞれ既存の「省略時は不活性」規約どおり)。
 *
 * 呼び出し順は固定: 産出先/廃材の受け皿確保 → hearth/workbench → 寝床 → 開墾
 * 資源floor → 粘土floor。寝床が hearth/workbench の**後**なのは、
 * {@link placeHearthAndWorkbench} が「施設ゼロの盤面」を前提にしているため
 * (§2' 冒頭)。
 *
 * @throws {RulesError} 既に facility entity がある / 開始セルが瓦礫の場合
 */
export function placeStartingFacilities(state: GameState, content: EngineContent): GameState {
  let next = ensureProducibleResourceEntities(state, content);
  next = ensureWasteResourceEntity(next, content);
  next = placeHearthAndWorkbench(next, content);
  next = placeStartingBeds(next, content);
  next = ensureReclaimFloor(next, content);
  next = ensureClayFloor(next, content);
  return next;
}
