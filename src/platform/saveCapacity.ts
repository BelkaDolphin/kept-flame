// ---------------------------------------------------------------------------
// セーブ容量検査(書込前サイズ検査)— M4 / ADR-012(2)
//
// ===========================================================================
// 0. ADR-012(2) の数値と、本実装が測る対象
// ===========================================================================
//   「典型セーブ ≤512KB(目標)、QuotaExceededError 前の書込前サイズ検査を
//   1.5MB で警告・4MB で書込中止しエクスポート強制導線」。
//   測る対象は **payload 文字列**(persistence.ts のエンベロープの中身。
//   ADR「セーブフォーマット」節末尾「容量: 測る対象は payload 文字列」)。
//   エンベロープの残り 2 フィールド(saveFormatVersion / integrityChecksum)は
//   定数長でノイズにしかならないため含めない。
//
//   バイト数は UTF-16 の `string.length`(コードユニット数)ではなく実際の
//   UTF-8 バイト数で測る(`bench/perfMain.ts` の `byteLengthOf` と同じ
//   `TextEncoder` 方式。IDB/localStorage が実際に消費する容量に対応するのは
//   バイト数の方であり、日本語文字列(3 バイト/文字)を含む content 名等が
//   あるとコードユニット数は過小評価になる)。
//
// ===========================================================================
// 1. 512KB の扱い: 「目標」であって強制ゲートではない
// ===========================================================================
//   ADR 本文が数値として明言している強制ゲートは 1.5MB(警告)と 4MB(書込
//   中止)の 2 段だけであり、512KB は「典型 ≤512KB(目標)」という達成目標
//   (D1 裁定では性能予算の前提サイズとしても使われる)である。
//   よって本実装は 512KB を**独立した第 3 の強制ゲート**にはしない
//   (512KB 超 1.5MB 未満のセーブを警告扱いにすると ADR に無い挙動を追加
//   することになる)。代わりに `exceedsTarget` という**情報フィールド**として
//   別枠で返し、512KB 超過の事実そのものは呼び出し側(将来の UI)が読める
//   ようにする。**この整理は要ユーザー判断**(タスク指示文の「512KB=目標
//   検査値(超過は警告扱い)」という記述と、ADR 本文の「512KB=目標・1.5MB=
//   警告」という記述の間に読み方の幅があるため。報告事項)。
// ---------------------------------------------------------------------------

/** ADR-012(2) 「典型セーブ ≤512KB(目標)」。強制ゲートではない(§1)。 */
export const SAVE_SIZE_TARGET_BYTES = 512 * 1024;

/** ADR-012(2) 「1.5MB で警告」。書込は止めないが `level` に反映する。 */
export const SAVE_SIZE_WARNING_BYTES = 1.5 * 1024 * 1024;

/** ADR-012(2) 「4MB で書込中止」。書込側(persistence.ts)が例外で止める。 */
export const SAVE_SIZE_ABORT_BYTES = 4 * 1024 * 1024;

export type SaveCapacityLevel = "ok" | "warning" | "abort";

/** 容量判定の結果(UI 表示は後続タスク。ここは判定フラグのみ)。 */
export interface SaveCapacityCheck {
  /** payload 文字列の実バイト数(UTF-8)。 */
  readonly byteLength: number;
  readonly level: SaveCapacityLevel;
  /** ADR-012(2) の 512KB 目標を超えているか(情報フィールド・§1)。 */
  readonly exceedsTarget: boolean;
  /** `level === "abort"` のエイリアス(呼び出し側が理由を辿らず判定できるように)。 */
  readonly forceExportRecommended: boolean;
}

let sharedEncoder: TextEncoder | null = null;

function encoder(): TextEncoder {
  // モジュール読込のたびに TextEncoder を作らない(bench/perfMain.ts の
  // `const encoder = new TextEncoder()` と同じ意図をレイジー初期化で得る)。
  sharedEncoder ??= new TextEncoder();
  return sharedEncoder;
}

/** 文字列の実バイト数(UTF-8)。`string.length`(UTF-16 コードユニット数)とは異なる。 */
export function payloadByteLength(payload: string): number {
  return encoder().encode(payload).length;
}

/**
 * payload 文字列の容量を判定する(ADR-012(2))。純関数・I/O なし。
 *
 * 境界はすべて閾値**以上**で次段へ入る(例: ちょうど 4MB は "abort")。
 * ADR の「N で警告/中止」を閉区間の下限として読む(超過ではなく到達で発火)。
 */
export function checkSaveCapacity(payload: string): SaveCapacityCheck {
  const byteLength = payloadByteLength(payload);
  const level: SaveCapacityLevel =
    byteLength >= SAVE_SIZE_ABORT_BYTES
      ? "abort"
      : byteLength >= SAVE_SIZE_WARNING_BYTES
        ? "warning"
        : "ok";
  return {
    byteLength,
    level,
    exceedsTarget: byteLength > SAVE_SIZE_TARGET_BYTES,
    forceExportRecommended: level === "abort",
  };
}
