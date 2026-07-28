// ---------------------------------------------------------------------------
// エクスポート/インポート — M4 / ADR-012「エクスポート/インポートは破損検出
// チェックサム付き JSON blob」
//
// ===========================================================================
// 0. 設計: エンベロープをそのまま JSON テキスト化する(独自整形なし)
// ===========================================================================
//   `persistence.ts` の {@link SaveRecord}(`{saveFormatVersion,
//   integrityChecksum, payload}`)は IDB に入れる値そのものであり、
//   `payload` は既に `toSerializable` の正準化を経た JSON 文字列である。
//   エクスポートはこのエンベロープを**そのまま** `JSON.stringify` するだけで、
//   pretty-print 等の独自整形は挟まない(タスク指示: 「既存の serialize 経路が
//   作るバイト列をそのまま使い、独自整形を挟まない」)。
//
//   これにより export → import は次の経路を通る:
//     encodeSaveRecord(state) → JSON.stringify(record) = テキスト
//     テキスト → JSON.parse → decodeSaveRecord(...) = state
//   両端に `encodeSaveRecord`/`decodeSaveRecord`(migration + checksum 検証の
//   単一経路)をそのまま使うので、**インポートは必ず破損検出を通る**。
//
// ===========================================================================
// 1. 「バイト同一往復」の意味
// ===========================================================================
//   `encodeSaveRecord` は決定論(同じ state から常に同じバイト列・
//   persistence.test.ts で固定済み)であり、`decodeSaveRecord` は
//   `encodeSaveRecord` の逆(往復不変性も同ファイルで固定済み)。よって
//   `exportSaveText(state)` を `importSaveText` で読み戻し、再度
//   `exportSaveText` した結果は**最初のテキストとバイト同一**になる
//   (`tests/platform/exchange.test.ts` で検証)。
// ---------------------------------------------------------------------------

import { decodeSaveRecord, encodeSaveRecord, PersistenceError } from "./persistence";
import type { GameState } from "../engine/state/state";

/**
 * GameState をエクスポート用テキスト(エンベロープの JSON blob)にする。
 *
 * @throws {SaveBoundsError} 分岐木ノード上界超過(`encodeSaveRecord` 内・ADR-012(3))
 */
export function exportSaveText(state: GameState): string {
  return JSON.stringify(encodeSaveRecord(state));
}

/**
 * エクスポート用テキストから GameState を復元する。
 *
 * 「破損 import を黙って通さない」の実体はここではなく `decodeSaveRecord`
 * (migration → checksum 検証 → 上界検査 → deserialize の単一経路)にある。
 * このモジュールが追加で検査するのは「テキストがそもそも JSON として
 * 読めるか」だけ(ファイル選択ダイアログ等から来る任意バイト列の入口)。
 *
 * @throws {PersistenceError} テキストが JSON として parse できない
 * @throws {PersistenceError | SaveIntegrityError | SaveBoundsError |
 *          SaveMigrationError | SerializeError} `decodeSaveRecord` 由来
 */
export function importSaveText(text: string): GameState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PersistenceError(
      `インポートしたテキストが正しい JSON でない: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return decodeSaveRecord(value);
}
