// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 新規施設 entity ID の採番(M30)
//
// M18★4「施設 ID 発行は GridBoard 責務外(M30で ID 採番方式の決定要)」への
// 回答。`placeFacility` コマンド(engine/commands.ts)は呼び出し側が発行した ID
// を要求する契約であり、engine 側は 1 つも ID を作らない。
//
// **決定論を壊さない**(CLAUDE.md 絶対ルール): Math.random も Date.now も
// 使わず、現在の state(`entityStateById`)だけを入力にした純関数で「まだ使われ
// ていない最小の連番」を選ぶ。`src/newGame.ts` の `facHearth1`/`facWorkbench1`
// と同じ命名規約(`fac` + defId の先頭大文字化 + 連番)に揃えてある。
// ---------------------------------------------------------------------------

import { entityIdFromString, type EntityId, type GameState } from "../../../engine/state/state";

function capitalize(value: string): string {
  const head = value.charAt(0);
  return head.toUpperCase() + value.slice(1);
}

/**
 * `defId` の施設を新しく置くための、まだ使われていない entity ID を返す。
 *
 * `fac<DefId大文字化><連番>` の形で n=1 から順に試し、`state.entityStateById`
 * に無い最初の値を返す(既存 ID との衝突は `placeFacility` が
 * `entityIdInUse` で reject するので、ここでの重複が起きても安全側に壊れる)。
 */
export function nextFacilityId(state: GameState, defId: EntityId): EntityId {
  const stem = `fac${capitalize(defId)}`;
  for (let n = 1; n < 100_000; n++) {
    const candidate = `${stem}${String(n)}`;
    if (!state.entityStateById.has(entityIdFromString(candidate))) {
      return entityIdFromString(candidate);
    }
  }
  throw new RangeError(`nextFacilityId: "${defId}" の空き ID が 100000 連番以内に見つからない`);
}
