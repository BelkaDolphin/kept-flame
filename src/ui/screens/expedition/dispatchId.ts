// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 新規派遣 ID の採番(M32)
//
// `dispatchExpedition` コマンド(engine/commands.ts)は呼び出し側が発行した
// 派遣 ID を要求する契約であり、engine 側は 1 つも ID を作らない
// (`placeFacility` が施設 ID を要求するのと同じ形・M18★4 への回答=M30 の
// `facilityId.ts` を踏襲)。
//
// **決定論を壊さない**(CLAUDE.md 絶対ルール): Math.random も Date.now も
// 使わず、現在の state だけを入力にした純関数で「まだ使われていない最小の
// 連番」を選ぶ。派遣は entity ではない(state.dispatchSnapshots に載る値
// オブジェクト)ので、衝突検査は `entityStateById` と `getDispatch` の両方を
// 見る必要がある(commands.ts の `activeDispatchIdInUse` と同じ判定)。
// ---------------------------------------------------------------------------

import type { DistanceBand } from "../../../engine/rules/types";
import {
  entityIdFromString,
  getDispatch,
  type EntityId,
  type GameState,
} from "../../../engine/state/state";

function capitalize(value: string): string {
  const head = value.charAt(0);
  return head.toUpperCase() + value.slice(1);
}

/**
 * `band` の派遣を新しく確定するための、まだ使われていない派遣 ID を返す。
 *
 * `dispatch<Band大文字化><連番>` の形で n=1 から順に試し、entity にも
 * 未帰還の派遣一覧にも無い最初の値を返す(既存 ID との衝突は
 * `dispatchExpedition` が `entityIdInUse` で reject するので、ここでの重複が
 * 起きても安全側に壊れる)。
 */
export function nextDispatchId(state: GameState, band: DistanceBand): EntityId {
  const stem = `dispatch${capitalize(band)}`;
  for (let n = 1; n < 100_000; n++) {
    const candidate = entityIdFromString(`${stem}${String(n)}`);
    if (!state.entityStateById.has(candidate) && getDispatch(state, candidate) === undefined) {
      return candidate;
    }
  }
  throw new RangeError(`nextDispatchId: "${band}" の空き ID が 100000 連番以内に見つからない`);
}
