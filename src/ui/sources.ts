// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 単一ストアの根 signal 群 — ADR-002 / ADR-028
//
// 反応系グラフの「入力」だけを定義する。派生値は derived.ts、書き込みは
// store.ts の dispatch 1 本(本ファイルの `set` を直接呼ぶのは store.ts のみ)。
//
// ===========================================================================
// 1. なぜ GameState signal 1 本ではないのか(fan-in 上界の設計・ADR-002(2))
// ===========================================================================
//   GameState を 1 本の signal で持ち、全 computed がそれを読む形にすると、
//   「どの entity が変わったか」に関係なく全派生値が dirty になる。48 セルの
//   隣接 computed も全部 dirty になるので、ADR-002(2) の
//   「1 セル編集の再描画上界 O(8)」が成立しない。
//
//   そこで根を**セル単位に割る**:
//
//     cellPlacement[i] : セル i の「隣接計算に効く素性」= 施設 ID / 定義 ID / タグ列
//                        + [M17] アンカーセル / footprint(大型施設のため)
//     cellFacility[i]  : セル i の施設 entity そのもの(Lv・就労者を表示するため)
//
//   [M17] **大型施設は全占有セルに載る**(2×1 なら 2 セル)。1 施設 1 セルだった
//   M16 以前との差は「載るセル数」だけで、fan-in の上界の形は変わらない
//   (依存は自セル + 判定基準セル = 定数上界・adjacency.ts §2)。
//
//   隣接 computed が読むのは cellPlacement だけなので、
//     - Lv 変更・就労者変更 → cellFacility[i] だけが変わる → 近傍の隣接は再計算されない
//     - 施設の設置/撤去    → cellPlacement[i] が変わる → 近傍 ≤8 + 自セルのみ再計算
//   となり、上界が構造として出る(テスト: tests/ui/derived.test.ts)。
//
// ===========================================================================
// 2. 同期は「構造共有の差分」を利用した O(48) の参照比較(ADR-028(1))
// ===========================================================================
//   {@link syncSourcesFromState} は state から 48 セルを引き直すが、
//   セルごとに**前回の施設 entity と参照が同じなら即 continue** する。
//   構造共有(update.ts)により変わっていない entity は参照同一なので、
//   通常の tick 進行では 48 回の `Object.is` だけで終わり、
//   オブジェクト生成も signal 書き込みも 0 になる。
//
//   ここで「どのセルが変わったかを呼び出し側(イベント)に申告させる」方式は
//   採らない。申告が実態とずれた瞬間に派生値が黙って古くなる(壊れ方が
//   検出不能になる)ためで、常に state を単一の真実として引き直す。
//
// ===========================================================================
// 3. state signal の位置づけ(生読み禁止・ADR リポ構成 src/ui/ の注記)
// ===========================================================================
//   `state` signal は「セル以外の値(資源・研究・住民・tick)」の派生元として
//   必要なので残すが、**UI コンポーネントがこれを直接読むと画面全体が
//   毎 tick 再描画される**。画面が読むのは derived.ts の派生値だけとし、
//   コマンド組み立てのような一時的な読み出しは store.peekState()(非追跡)を
//   使う。この規律は architecture.md §6 に明文化してある。
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT, type Tag } from "../engine/adjacency";
import { footprintOfFacility, occupiedCellsOfFacility } from "../engine/footprint";
import { requireFacilityDef, type AdvanceContext, type EngineContent } from "../engine/rules/types";
import {
  entitiesOfKind,
  type EntityId,
  type FacilityFootprint,
  type FacilityState,
  type GameState,
} from "../engine/state/state";
import { Signal, batch, type ReadonlySignal } from "./reactive";
import { DEFAULT_SCREEN_ID, type ScreenId } from "./screens";

/** ストアの入力の誤り(セル番号の範囲外・1 セル 2 施設など)。 */
export class StoreSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreSourceError";
  }
}

/**
 * セル 1 個の「隣接計算に効く素性」。**Lv と就労者を含めない**のが要点で、
 * これらは近傍の隣接ボーナスに影響しないから(§1)。
 *
 * **[M17] 大型施設(GDD 6.1 の 2×1 / 1×2 / 2×2)は全占有セルに同じ素性が載る**。
 * どのセルからでも「この施設は何か」が引けるので、格子UI(M18)のセルタップ解決と
 * 隣接プレビューが同じ根 signal を読める。非アンカーセルと区別したいときは
 * `anchorCellIndex === cellIndex` を見る。
 */
export interface CellPlacement {
  readonly facilityId: EntityId;
  readonly defId: EntityId;
  /** content の facility 定義から引いたタグ列(宣言順・engine 側と同一参照)。 */
  readonly tags: readonly Tag[];
  /**
   * [M17] 占有矩形のアンカーセル(= `FacilityState.cellIndex`)。
   * 隣接計算の同一性キー(adjacency.ts の `CellOccupant.anchorCellIndex`)。
   */
  readonly anchorCellIndex: number;
  /**
   * [M17] **state から**解決した占有形状(省略 = 1×1 は解決済みなので常に非 undefined)。
   * content の `FacilityDef.footprint` ではない —— 権威は state
   * (GDD 6.1 [2026-07-30裁定]・engine 側と同じ規律)。
   */
  readonly footprint: FacilityFootprint;
}

/** タグ列の等価判定。content 由来の同一配列なら参照比較で即決する。 */
function tagsEqual(a: readonly Tag[], b: readonly Tag[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 配置素性の等価判定(値の意味で比較する)。 */
export function cellPlacementEquals(a: CellPlacement | null, b: CellPlacement | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.facilityId === b.facilityId &&
    a.defId === b.defId &&
    tagsEqual(a.tags, b.tags) &&
    a.anchorCellIndex === b.anchorCellIndex &&
    a.footprint.width === b.footprint.width &&
    a.footprint.height === b.footprint.height
  );
}

/**
 * 根 signal 群の**読み取り専用ビュー**。`GameStore.sources` はこの型で公開され、
 * 画面から `set` を呼べない(§3 の規律を型で裏打ちする)。
 */
export interface ReadonlyStoreSources {
  readonly state: ReadonlySignal<GameState>;
  readonly content: ReadonlySignal<EngineContent>;
  readonly advanceContext: ReadonlySignal<AdvanceContext>;
  readonly worldSeedU32: ReadonlySignal<number>;
  readonly cellPlacement: readonly ReadonlySignal<CellPlacement | null>[];
  readonly cellFacility: readonly ReadonlySignal<FacilityState | null>[];
  readonly selectedCellIndex: ReadonlySignal<number | null>;
  readonly activeScreen: ReadonlySignal<ScreenId>;
}

/**
 * 単一ストアの根 signal 群(書き込み可能な内側の形)。
 * `set` を呼ぶのは store.ts の dispatch と本ファイルの同期関数だけ。
 */
export interface StoreSources extends ReadonlyStoreSources {
  // --- ゲーム状態 ---
  /** 正規化 GameState(構造共有・ADR-028)。生読み禁止(§3)。 */
  readonly state: Signal<GameState>;
  /** ロード済み content(実行中に差し替わらない)。 */
  readonly content: Signal<EngineContent>;
  /**
   * advance のコンテキスト(隣接乗数の precompute)。**配置が変わったときだけ**
   * 作り直す(advance.ts §2)。Worker catch-up の完了時は転送されてきたものを
   * そのまま入れる = メイン側で engine の再計算をしない(perf-boundaries §3 B3)。
   */
  readonly advanceContext: Signal<AdvanceContext>;
  /** worldSeed の uint32 展開。tick では変わらないので隣接行列の依存に置ける。 */
  readonly worldSeedU32: Signal<number>;

  // --- 格子(セル単位に割った根・§1) ---
  /** 長さ 48。index = cellIndex。 */
  readonly cellPlacement: readonly Signal<CellPlacement | null>[];
  /** 長さ 48。index = cellIndex。 */
  readonly cellFacility: readonly Signal<FacilityState | null>[];

  // --- UI 状態(engine の外・セーブに載らない) ---
  /** タップ選択→配置先タップの 2 ステップ(GDD 6.6)の選択中セル。 */
  readonly selectedCellIndex: Signal<number | null>;
  /** 現在の画面。権威は platform/router.ts(M29)で、ここはその写し。 */
  readonly activeScreen: Signal<ScreenId>;
}

export interface CreateStoreSourcesInput {
  readonly state: GameState;
  readonly content: EngineContent;
  readonly advanceContext: AdvanceContext;
}

function cellIndexInRange(cellIndex: number): boolean {
  return Number.isSafeInteger(cellIndex) && cellIndex >= 0 && cellIndex < GRID_CELL_COUNT;
}

/** 根 signal 群を作る。中身の初期化({@link syncSourcesFromState})は store.ts が行う。 */
export function createStoreSources(input: CreateStoreSourcesInput): StoreSources {
  const cellPlacement: Signal<CellPlacement | null>[] = [];
  const cellFacility: Signal<FacilityState | null>[] = [];
  for (let i = 0; i < GRID_CELL_COUNT; i++) {
    cellPlacement.push(
      new Signal<CellPlacement | null>(null, {
        equals: cellPlacementEquals,
        name: `cellPlacement[${String(i)}]`,
      }),
    );
    cellFacility.push(
      new Signal<FacilityState | null>(null, { name: `cellFacility[${String(i)}]` }),
    );
  }

  return {
    state: new Signal(input.state, { name: "state" }),
    content: new Signal(input.content, { name: "content" }),
    advanceContext: new Signal(input.advanceContext, { name: "advanceContext" }),
    worldSeedU32: new Signal(input.advanceContext.worldSeedU32, { name: "worldSeedU32" }),
    cellPlacement,
    cellFacility,
    selectedCellIndex: new Signal<number | null>(null, { name: "selectedCellIndex" }),
    activeScreen: new Signal<ScreenId>(DEFAULT_SCREEN_ID, { name: "activeScreen" }),
  };
}

/** {@link syncSourcesFromState} の結果。dispatch の戻り値と診断に使う。 */
export interface SourceSyncReport {
  /** 配置素性が変わったセル(昇順)。ここが空なら隣接 computed は 1 個も汚れない。 */
  readonly changedPlacementCells: readonly number[];
  /** 施設 entity の参照が変わったセル(昇順)。配置変更はこちらにも必ず現れる。 */
  readonly changedFacilityCells: readonly number[];
  /** GameState signal が実際に差し替わったか。 */
  readonly stateChanged: boolean;
  /** 参照比較で早期 continue したセル数(§2 の効き具合の可視化)。 */
  readonly unchangedCellCount: number;
}

/**
 * state を単一の真実として根 signal を同期する(§2)。
 *
 * セルごとの手順:
 *   (1) 前回の施設 entity と参照が同じなら何もしない(構造共有の恩恵)
 *   (2) 変わっていたら配置素性を組み直し、値が実際に違う signal だけ書く
 *
 * @throws {StoreSourceError} セル番号が範囲外 / 1 セルに 2 施設ある場合
 * @throws {RulesError} 施設定義が content に無い場合
 */
export function syncSourcesFromState(
  sources: StoreSources,
  state: GameState,
  content: EngineContent,
): SourceSyncReport {
  const facilityByCell: (FacilityState | null)[] = new Array<FacilityState | null>(
    GRID_CELL_COUNT,
  ).fill(null);

  for (const facility of entitiesOfKind(state, "facility")) {
    if (!cellIndexInRange(facility.cellIndex)) {
      throw new StoreSourceError(
        `施設 "${facility.id}" のセル番号 ${String(facility.cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})を外れている`,
      );
    }
    // [M17] 大型施設は全占有セルへ載せる(GDD 6.1・footprint.ts §1)。1×1 では
    // `occupiedCellsOfFacility` が `[cellIndex]` を返すので M16 以前と同一。
    for (const cellIndex of occupiedCellsOfFacility(facility)) {
      if (!cellIndexInRange(cellIndex)) {
        throw new StoreSourceError(
          `施設 "${facility.id}" の占有セル ${String(cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})を外れている`,
        );
      }
      if (facilityByCell[cellIndex] !== null) {
        throw new StoreSourceError(
          `セル ${String(cellIndex)} に複数の施設が建っている(1 セル = 1 施設・GDD 6.1)`,
        );
      }
      facilityByCell[cellIndex] = facility;
    }
  }

  const changedPlacementCells: number[] = [];
  const changedFacilityCells: number[] = [];
  let unchangedCellCount = 0;
  let stateChanged = false;

  batch(() => {
    for (let i = 0; i < GRID_CELL_COUNT; i++) {
      const facility = facilityByCell[i] ?? null;
      const facilitySignal = sources.cellFacility[i];
      const placementSignal = sources.cellPlacement[i];
      if (facilitySignal === undefined || placementSignal === undefined) {
        throw new StoreSourceError(`根 signal の配列長が ${String(GRID_CELL_COUNT)} でない`);
      }

      // (1) 構造共有の早期打ち切り: entity の参照が同じならセルは何も変わっていない。
      if (Object.is(facilitySignal.peek(), facility)) {
        unchangedCellCount++;
        continue;
      }

      // (2) 参照が変わったので、配置素性を組み直して値で比較する。
      const placement: CellPlacement | null =
        facility === null
          ? null
          : {
              facilityId: facility.id,
              defId: facility.defId,
              tags: requireFacilityDef(content, facility.defId).tags,
              anchorCellIndex: facility.cellIndex,
              footprint: footprintOfFacility(facility),
            };

      if (placementSignal.set(placement)) changedPlacementCells.push(i);
      if (facilitySignal.set(facility)) changedFacilityCells.push(i);
    }

    stateChanged = sources.state.set(state);
  });

  return { changedPlacementCells, changedFacilityCells, stateChanged, unchangedCellCount };
}
