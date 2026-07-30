// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 施設 footprint の幾何 — M16(裁定 B5)/ GDD 6.1・6.3 / ADR-002(2)
//
// GDD 6.1 は「1 セル = 1 施設(大型は 2×1 / 2×2 占有)」と定め、GDD 6.3 は大型施設の
// 判定基準セルを「全占有セルの外周 8 近傍の和集合から自セル群を除外し重複除去した
// 集合」と定めている。このモジュールはその 2 つの導出だけを持つ**純粋な幾何**であり、
// 隣接効果の意味論(タグペア行列・過密集計)には一切触れない(そちらは adjacency.ts
// = M17 の担当)。
//
// ===========================================================================
// 1. state 側の表現 = 「基準セル 1 個 + footprint」(占有セル集合は導出する)
// ===========================================================================
//   `FacilityState` は占有セルの配列を持たず、`cellIndex`(基準セル = 占有矩形の
//   最小セル番号 = 左上)と省略可の `footprint`(state.ts)だけを持ち、占有セル集合は
//   {@link occupiedCells} で毎回導出する。占有セル配列を state に持たせない理由:
//
//     (a) 矩形であるという不変条件を型で守れる。配列を持つと「L 字に並んだ占有
//         セル」「基準セルを含まない占有セル集合」といった、GDD に存在しない状態が
//         セーブとして表現可能になる(= 検証コードと壊れ方が増える)。
//     (b) 同じ情報が 2 箇所(cellIndex と配列)に載らない。二重に持つと
//         「基準セルだけ動いて配列が古い」セーブが作れてしまう。
//     (c) 直列化の正準形が 1 通りに決まる(§2)。
//
//   逆に **footprint を state に持つ**(content の facility 定義から毎回引かない)
//   のは、content 側の footprint 変更が既存セーブの占有形状を遡って書き換えるのを
//   防ぐためである。ADR 3軸(b) の contentVersion 差は additive-only で吸収する
//   建前だが、footprint の変更は additive ではない —— 1×1 だった施設が 2×2 に
//   なった瞬間、既存盤面で占有が重なる/盤外へ出る施設が発生する。着手時の値を
//   state へ焼き込む方式(codify の `requiredWork` スナップショット・GDD 12.5-8 と
//   同じ考え方)にしておけば、content が動いても既存セーブの盤面は動かない。
//
// ===========================================================================
// 2. 1×1 は「キーごと省略」が正準形(serialize.ts §7)
// ===========================================================================
//   `FacilityState.footprint` は**省略可**であり、省略 ⇔ 1×1 の 1 対 1 対応とする。
//   1×1 を明示した直列化形は非正準形として reject する(serialize.ts)。ねらいは
//   rngState 空省略(裁定 B4)・resident.stats(M5)と全く同じで、
//     (a) M16 以前に採った golden vector 40 本と既存セーブのバイト列が 1 bit も
//         動かないこと(現 content は全施設 1×1 相当の state しか作らない)
//     (b) footprint を持たない旧セーブが既定値でそのままロードできること
//   の 2 つを同時に満たす。
//
// ===========================================================================
// 3. 「基準セル」という語の 2 つの意味(GDD の用語に合わせる)
// ===========================================================================
//   GDD 6.3 の「大型施設の判定基準セル」は**隣接判定に使う近傍セルの集合**を指す
//   (自セル群ではない)。一方 state の `cellIndex` は占有矩形のアンカーであり、
//   本モジュールではこれを「基準セル(アンカー)」と呼び分ける:
//
//     {@link anchorCellOfOccupied}  占有セル集合 → アンカー(最小セル番号)
//     {@link adjacencyBasisCells}   占有セル集合 → GDD 6.3 の判定基準セル集合
//
//   {@link adjacencyBasisCells} の結果は**入力の並び順に依存しない**(セル番号を
//   添字にした真偽配列で集合を作り、最後に昇順で書き出す)。1×1 の場合は
//   `neighborCellIndices(cellIndex)` と**同じ集合**になるが、こちらは昇順
//   (= `cellIdOf` の 2 桁ゼロ埋めゆえ GDD 6.3(c) の「セルID 辞書順」と一致)、
//   `neighborCellIndices` は方向順(N..NW)である。順序が違っても
//   `computeCellAdjacency` の結果は変わらない —— 過密集計はタグ別バケットを
//   cellId 辞書順へ**再ソート**してから使い(adjacency.ts §3(c))、cellId は
//   一意なのでソートは全順序である = バケットへ積む順序は結果に影響しない。
//
//   **[M17 完了] 結線先は 2 箇所**(いずれも本モジュールを呼ぶだけで、基準セルの
//   導出を自前で書かない):
//     - engine: `rules/production.ts` の `buildAdjacencySubjects` が
//       {@link adjacencyBasisCellsOfFacility} を `AdjacencySubject.basisCells` へ、
//       `buildCellOccupancy` が {@link occupiedCellsOfFacility} を占有展開へ
//     - UI:     `src/ui/sources.ts` が占有セル全部へ配置素性を載せ、
//       `src/ui/derived.ts` が同じ基準セル集合で `computeCellAdjacency` を呼ぶ
//       (GDD 6.3 の「`adjacency.json` スキーマと UI プレビュー共通ロジック」)
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT, GRID_HEIGHT, GRID_WIDTH, NEIGHBOR_OFFSETS } from "./adjacency";
import {
  entitiesOfKind,
  type EntityId,
  type FacilityFootprint,
  type FacilityState,
  type GameState,
} from "./state/state";

/** footprint の幾何の契約違反(盤外・値域外・占有セル集合が空など)。 */
export class FootprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootprintError";
  }
}

// --- 1. 値域 ---------------------------------------------------------------

/**
 * footprint の 1 辺の最大値。GDD 6.1 が認める大型施設は 2×1 / 2×2 だけなので 2。
 *
 * **engine 側の正本**であり、content 側の強制は `schema/facility.ts` の
 * `FOOTPRINT_DIMENSION_RANGE`(min 1 / max 2)が持つ。engine が schema を import
 * できない(依存は内向き一方向)ため定義が 2 箇所になるのは
 * `ADJACENCY_TAGS` / `FACILITY_TAGS` と同じ構造上の制約であり、突き合わせは
 * content ローダー(`schema/engineContent.ts`)が行う。
 *
 * この値を上げるとセーブの表現能力が変わる(= 旧ビルドが読めない形が増える)ため、
 * `SAVE_SCHEMA_VERSION` の扱いを併せて検討すること。
 */
export const FOOTPRINT_DIM_MAX = 2;

/** 1×1(既定)。`FacilityState.footprint` 省略時の意味そのもの。 */
export const UNIT_FOOTPRINT: FacilityFootprint = { width: 1, height: 1 };

/** 幅・高さがともに 1〜{@link FOOTPRINT_DIM_MAX} の整数か。 */
export function isValidFootprintDims(footprint: FacilityFootprint): boolean {
  return (
    Number.isSafeInteger(footprint.width) &&
    Number.isSafeInteger(footprint.height) &&
    footprint.width >= 1 &&
    footprint.height >= 1 &&
    footprint.width <= FOOTPRINT_DIM_MAX &&
    footprint.height <= FOOTPRINT_DIM_MAX
  );
}

/** 1×1(= 省略と同義)か。 */
export function isUnitFootprint(footprint: FacilityFootprint): boolean {
  return footprint.width === 1 && footprint.height === 1;
}

/**
 * 施設の footprint を解決する(省略 = 1×1・§2)。
 * 戻り値は常に非 undefined なので、呼び出し側は分岐を書かなくてよい。
 */
export function footprintOfFacility(facility: FacilityState): FacilityFootprint {
  return facility.footprint ?? UNIT_FOOTPRINT;
}

function requireDims(footprint: FacilityFootprint, what: string): void {
  if (!isValidFootprintDims(footprint)) {
    throw new FootprintError(
      `${what}: footprint ${String(footprint.width)}×${String(footprint.height)} は` +
        `1〜${String(FOOTPRINT_DIM_MAX)} の整数でない(GDD 6.1 の大型施設は 2×1 / 2×2)`,
    );
  }
}

// --- 2. 占有セル集合 -------------------------------------------------------

/** セル番号 → (x, y)。回り込みが起きないよう除算ではなく減算で求める。 */
function cellToXy(cellIndex: number): readonly [number, number] {
  const x = cellIndex % GRID_WIDTH;
  return [x, (cellIndex - x) / GRID_WIDTH];
}

/**
 * 基準セル(アンカー)にその footprint の矩形を置いたとき、格子(6×8)に収まるか。
 *
 * **例外を投げない述語**である。配置コマンドは「置けない」をプレイヤー操作の
 * 失敗として値で返す必要があるため(commands.ts §3)、盤外判定はここで真偽を
 * 得てから {@link occupiedCells} を呼ぶ。
 */
export function footprintFitsGrid(cellIndex: number, footprint: FacilityFootprint): boolean {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= GRID_CELL_COUNT) {
    return false;
  }
  if (!isValidFootprintDims(footprint)) return false;
  const [x, y] = cellToXy(cellIndex);
  return x + footprint.width <= GRID_WIDTH && y + footprint.height <= GRID_HEIGHT;
}

/**
 * 占有セル集合を**セル番号の昇順**で返す(§1)。アンカーは常に先頭 = 最小である。
 *
 * 盤外へはみ出す組み合わせは切り詰めず**例外**にする。切り詰めると「2×2 を置いた
 * つもりが右端で 2×1 になっていた」という静かな縮退が起きるためで、置けるかどうかは
 * 呼び出し側が {@link footprintFitsGrid} で先に確かめる契約にしてある。
 *
 * @throws {FootprintError} 値域外の footprint / 盤外へはみ出す配置
 */
export function occupiedCells(cellIndex: number, footprint: FacilityFootprint): readonly number[] {
  requireDims(footprint, `セル ${String(cellIndex)}`);
  if (!footprintFitsGrid(cellIndex, footprint)) {
    throw new FootprintError(
      `セル ${String(cellIndex)} に footprint ${String(footprint.width)}×${String(footprint.height)} は` +
        `格子(${String(GRID_WIDTH)}×${String(GRID_HEIGHT)})へ収まらない`,
    );
  }
  const [x0, y0] = cellToXy(cellIndex);
  const result: number[] = [];
  // dy を外側にすると行ストライドの都合で自然に昇順になる(並べ替え不要)。
  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      result.push((y0 + dy) * GRID_WIDTH + (x0 + dx));
    }
  }
  return result;
}

/** 施設 entity の占有セル集合(昇順)。省略された footprint は 1×1(§2)。 */
export function occupiedCellsOfFacility(facility: FacilityState): readonly number[] {
  const footprint = facility.footprint;
  // 1×1 は幾何計算を通さない。`cellIndex` の値域検査は state 層の担当ではない
  // (serialize.ts §2: Lv <= 5 / cellIndex < 48 は schema 検証器の担当)ため、
  // 範囲外の cellIndex を持つ既存 state でも M16 以前と同じく黙って通す
  // = footprint を足したことで既存の壊れたセーブの壊れ方が変わらない。
  if (footprint === undefined || isUnitFootprint(footprint)) return [facility.cellIndex];
  return occupiedCells(facility.cellIndex, footprint);
}

/**
 * 占有セル集合 → 基準セル(アンカー)= 最小セル番号(§3)。
 *
 * `FacilityState.cellIndex` と一致することが不変条件であり、この関数は
 * その不変条件をテストで固定するため(と、UI が占有セル集合だけを持っている
 * 場面のため)に置いてある。
 *
 * @throws {FootprintError} 占有セル集合が空の場合
 */
export function anchorCellOfOccupied(occupied: readonly number[]): number {
  let min: number | undefined = undefined;
  for (const cell of occupied) {
    if (min === undefined || cell < min) min = cell;
  }
  if (min === undefined) {
    throw new FootprintError("占有セル集合が空(施設は必ず 1 セル以上を占有する)");
  }
  return min;
}

// --- 3. GDD 6.3 の判定基準セル ---------------------------------------------

/**
 * GDD 6.3「大型施設の判定基準セル」= 全占有セルの外周 8 近傍の和集合から自セル群を
 * 除外し重複除去した集合。**セル番号の昇順**で返す(§3)。
 *
 * 実装は「セル番号を添字にした真偽配列」で集合を作るので、**入力の並び順に一切
 * 依存しない**(決定論の要点)。近傍の列挙自体は `NEIGHBOR_OFFSETS` の方向順
 * (N..NW・GDD 6.3(a))で行うが、和集合を取ってから昇順で書き出すため方向順は
 * 結果に残らない。
 *
 * GDD 6.3 の「ボーナスは占有面積に依らず 1 施設 1 回のみ計上」は**この集合を
 * 1 施設 1 回だけ評価する**ことで満たされる(集合が重複を持たないので、同じ近傍
 * セルが 2 度数えられることもない)。実際の乗数計算への結線は M17 の担当。
 *
 * @throws {FootprintError} 占有セル集合が空 / 盤外のセル番号を含む場合
 */
export function adjacencyBasisCells(occupied: readonly number[]): readonly number[] {
  if (occupied.length === 0) {
    throw new FootprintError("占有セル集合が空(判定基準セルを導出できない)");
  }
  const isOwn: boolean[] = [];
  for (const cell of occupied) {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= GRID_CELL_COUNT) {
      throw new FootprintError(
        `占有セル ${String(cell)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})の外`,
      );
    }
    isOwn[cell] = true;
  }

  const isBasis: boolean[] = [];
  for (const cell of occupied) {
    const [x, y] = cellToXy(cell);
    for (const offset of NEIGHBOR_OFFSETS) {
      const nx = x + offset[0];
      const ny = y + offset[1];
      if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
      const neighbor = ny * GRID_WIDTH + nx;
      if (isOwn[neighbor] === true) continue; // 自セル群は除外(GDD 6.3)
      isBasis[neighbor] = true;
    }
  }

  const result: number[] = [];
  for (let cell = 0; cell < GRID_CELL_COUNT; cell++) {
    if (isBasis[cell] === true) result.push(cell);
  }
  return result;
}

/** 施設 entity の判定基準セル集合(昇順)。{@link adjacencyBasisCells} の薄い口。 */
export function adjacencyBasisCellsOfFacility(facility: FacilityState): readonly number[] {
  return adjacencyBasisCells(occupiedCellsOfFacility(facility));
}

// --- 4. 盤面の占有 ---------------------------------------------------------

/**
 * そのセルを占有している施設(無ければ undefined)。**大型施設の非アンカーセルも
 * ヒットする**のが M16 の要点であり、配置の衝突検査(commands.ts)と UI の
 * セルタップ解決(M18)が同じ述語を使うための単一実装である。
 *
 * 走査は施設 entity の ID 昇順(`entitiesOfKind` の正準順)なので、仮に占有が
 * 重なった state を渡されても返る施設は一意に決まる(決定論)。
 */
export function facilityOccupyingCell(
  state: GameState,
  cellIndex: number,
): FacilityState | undefined {
  for (const facility of entitiesOfKind(state, "facility")) {
    for (const occupied of occupiedCellsOfFacility(facility)) {
      if (occupied === cellIndex) return facility;
    }
  }
  return undefined;
}

/**
 * 指定した占有セル集合と衝突する施設を、**衝突したセル番号が最小のもの 1 件**返す
 * (無ければ null)。配置コマンドの `cellOccupied` 判定の本体。
 *
 * `excludeFacilityId` を渡すと、その施設自身との衝突を無視する(同じ施設を
 * 置き直す / 動かす操作のため。M16 時点の呼び出し元は使っていないが、
 * 「解体してから同じセルへ建て直す」列コマンド(commands.ts §6)で自分自身を
 * 除外したくなるのは時間の問題なので口を開けてある)。
 */
export function findOccupancyConflict(
  state: GameState,
  cells: readonly number[],
  excludeFacilityId: EntityId | null = null,
): { readonly cellIndex: number; readonly facility: FacilityState } | null {
  // cells は昇順で渡される契約(occupiedCells の戻り値)だが、ここでは
  // 「最小の衝突セル」を明示的に選ぶので入力の順序に依存しない。
  let best: { readonly cellIndex: number; readonly facility: FacilityState } | null = null;
  for (const cell of cells) {
    const occupant = facilityOccupyingCell(state, cell);
    if (occupant === undefined) continue;
    if (occupant.id === excludeFacilityId) continue;
    if (best === null || cell < best.cellIndex) best = { cellIndex: cell, facility: occupant };
  }
  return best;
}
