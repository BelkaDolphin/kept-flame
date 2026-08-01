// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 新規衛星拠点 ID の採番(M54)
//
// `establishOutpost` コマンド(engine/commands.ts)は呼び出し側が発行した拠点 ID
// を要求する契約であり、engine 側は 1 つも ID を作らない(`placeFacility` が
// 施設 ID を要求するのと同じ形・`grid/facilityId.ts`/`expedition/dispatchId.ts`
// を踏襲)。
//
// **決定論を壊さない**(CLAUDE.md 絶対ルール): Math.random も Date.now も
// 使わず、現在の state だけを入力にした純関数で「まだ使われていない最小の
// 連番」を選ぶ。拠点は entity ではない(`state.outpostsById` に載る値
// オブジェクト)ので、衝突検査は `entityStateById` と `getOutpost` の両方を
// 見る必要がある(commands.ts の `applyEstablishOutpost` の `entityIdInUse`
// 判定と同じ)。
//
// facilityId.ts/dispatchId.ts と違い `capitalize` で再プレフィックスしない:
// outpostTypeId 自体が既に読める語(`outpostMine`/`outpostFarm`/`outpostForest`)
// なので、そのまま連番の語幹として使う(`outpostOutpostMine1` のような二重
// プレフィックスを避けるための意図的な逸脱)。
// ---------------------------------------------------------------------------

import {
  entityIdFromString,
  getOutpost,
  type EntityId,
  type GameState,
} from "../../../engine/state/state";

/**
 * `outpostTypeId` の拠点を新しく設置するための、まだ使われていない拠点 ID を返す。
 *
 * `<outpostTypeId><連番>` の形で n=1 から順に試し、entity にも既存の拠点にも
 * 無い最初の値を返す(既存 ID との衝突は `establishOutpost` が
 * `entityIdInUse` で reject するので、ここでの重複が起きても安全側に壊れる)。
 */
export function nextOutpostId(state: GameState, outpostTypeId: EntityId): EntityId {
  for (let n = 1; n < 100_000; n++) {
    const candidate = entityIdFromString(`${outpostTypeId}${String(n)}`);
    if (!state.entityStateById.has(candidate) && getOutpost(state, candidate) === undefined) {
      return candidate;
    }
  }
  throw new RangeError(
    `nextOutpostId: "${outpostTypeId}" の空き ID が 100000 連番以内に見つからない`,
  );
}
