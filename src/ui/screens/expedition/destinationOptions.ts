// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑦探索本部の目的地選択肢(M32)— GDD 8.1 / 8.2 / M22
//
// GDD 8.1 の原文は「目的地（近郊/遠隔/深部の3距離帯）」であり、距離帯そのもの
// が目的地の単位である。M22 で content(`content/event.json`)が距離帯の中に
// 複数の named event を持てるようになったが、これは content が無い盤面でも
// 1 bit も挙動が変わらない**フォールバック付きの拡張**(rules/exploration.ts
// `eventDefForDestination` の doc)。
//
// この画面もそれに合わせ:
//   content にその距離帯の event があれば → 選べる(店/廃線トンネル等)
//   無ければ                             → 「この距離帯」1 択(手続き生成)
// という 2 段構えにする。手続き生成の destinationId は**表示に使わない生の
// ラベル**であり(GDD 8.2 の seed 材料になるだけ)、捏造した固有名詞を画面に
// 出さないためにも band 由来の合成 ID をそのまま使う。
// ---------------------------------------------------------------------------

import type { DistanceBand } from "../../../engine/rules/types";
import { entityIdFromString, type EntityId } from "../../../engine/state/state";

function capitalize(value: string): string {
  const head = value.charAt(0);
  return head.toUpperCase() + value.slice(1);
}

/**
 * content にその距離帯の named event が 1 つも無いときに使う、手続き生成
 * フォールバックの destinationId。band ごとに固定(呼ぶたびに同じ値)。
 */
export function proceduralDestinationId(band: DistanceBand): EntityId {
  return entityIdFromString(`expedition${capitalize(band)}Procedural`);
}
