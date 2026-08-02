// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- セルIDの人間可読座標表示(M61/FC5)
//
// `engine/adjacency.ts` の `cellIdOf` が作る内部セルID(`c00`〜`c47`。GDD 6.3(c)
// の辞書順基準)がプレイテストで生露出していた(R1-A17:「かまど(c01)」
// 「c12を開墾した」等)。engine 側のセルID自体は多くのUI内部処理(データ属性
// `data-cell-id`・ソート基準)が依存しているため変更しない——このファイルは
// **表示専用**の座標整形を 1 箇所へ集約する。
//
// `cellIndex = row * GRID_WIDTH + col`(adjacency.ts の規約)を、そのまま
// 1始まりの「N列M行」へ変換するだけの純関数。GRID_WIDTH/HEIGHT は
// engine から値をそのまま import する(architecture.md: ui→engine は値も
// 型もimport可)ので、盤面サイズが変わっても二重管理にならない。
// ---------------------------------------------------------------------------

import { GRID_HEIGHT, GRID_WIDTH } from "../../engine/adjacency";

const CELL_ID_PATTERN = /^c(\d+)$/;

/**
 * セルID(`c00`〜`c47`)またはセル番号(0〜47)を「N列M行」の人間可読座標へ。
 * セルID規則に合わない・範囲外の入力は例外にせず raw をそのまま返す
 * (表示専用ヘルパが盤面の妥当性検査を肩代わりしない・呼び出し側は既に
 * `cellIdOf`/`FacilityRosterEntry.cellId` 等の正しい値しか渡さない)。
 */
export function cellCoordinateLabel(cellIdOrIndex: string | number): string {
  const cellIndex =
    typeof cellIdOrIndex === "number" ? cellIdOrIndex : parseCellIndex(cellIdOrIndex);
  if (cellIndex === null || !Number.isInteger(cellIndex) || cellIndex < 0) {
    return String(cellIdOrIndex);
  }
  const col = cellIndex % GRID_WIDTH;
  const row = (cellIndex - col) / GRID_WIDTH;
  if (row < 0 || row >= GRID_HEIGHT) return String(cellIdOrIndex);
  return `${String(col + 1)}列${String(row + 1)}行`;
}

function parseCellIndex(cellId: string): number | null {
  const match = CELL_ID_PATTERN.exec(cellId);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  return Number.parseInt(digits, 10);
}
