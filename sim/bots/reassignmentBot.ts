// ---------------------------------------------------------------------------
// 配属替え bot(計測用ダミー・1〜2本のうちの1本) — 先行計測計画 §2.1 P2
//
// engine に Command 経路が無いため(T5 は縮約 rules のみで配属変更コマンドを
// 持たない)、bot は「advance セグメント間に state 層 API で決定論的に状態を
// 変える」形の代表負荷として実装する(T9 指示書)。この bot は毎ゲーム日、
// hash(worldSeedU32, tick, "reassignment") で選んだ 1 名を過酷業務(forge 相当)
// ⇔ 通常業務(hearth 相当)の間で配属替えする(「配属戦略」判断の代表負荷)。
//
// 施設の配置(cellIndex/defId)は変えず workerIds/assignedFacilityId だけを
// 書き換えるので、advance context(隣接乗数の precompute)は作り直し不要
// (multiplierByFacilityId は occupancy = セル×タグにのみ依存し、就労者の
// 出入りには依存しない・rules/production.ts §2)。
// ---------------------------------------------------------------------------

import {
  entitiesOfKind,
  requireEntity,
  type EntityId,
  type FacilityState,
  type GameState,
} from "../../src/engine/state/state";
import { setField, updateEntity } from "../../src/engine/state/update";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";
import { botDecisionHash } from "../detHash";
import type { SimBot } from "../runner";

const LABEL = "reassignment";

function moveWorker(
  state: GameState,
  residentId: EntityId,
  fromFacilityId: EntityId,
  toFacilityId: EntityId,
): GameState {
  let next = updateEntity(state, fromFacilityId, "facility", (f) =>
    setField(
      f,
      "workerIds",
      f.workerIds.filter((id) => id !== residentId),
    ),
  );
  next = updateEntity(next, toFacilityId, "facility", (f) =>
    setField(f, "workerIds", [...f.workerIds, residentId]),
  );
  next = updateEntity(next, residentId, "resident", (r) =>
    setField(r, "assignedFacilityId", toFacilityId),
  );
  return next;
}

export const reassignmentBot: SimBot = {
  id: "reassignmentBot",
  intervalTicks: GAME_DAY_TICKS,
  apply: (state, content, worldSeedU32, tick) => {
    const harshFacilities: FacilityState[] = [];
    const normalFacilities: FacilityState[] = [];
    for (const facility of entitiesOfKind(state, "facility")) {
      const def = content.facilityDefs.get(facility.defId);
      if (def === undefined) continue;
      (def.harshWork ? harshFacilities : normalFacilities).push(facility);
    }
    const harshTarget = harshFacilities[0];
    const normalTarget = normalFacilities[0];
    if (harshTarget === undefined || normalTarget === undefined) return state;

    const residents = entitiesOfKind(state, "resident"); // ID 昇順(GDD 11.7)
    if (residents.length === 0) return state;
    const hash = botDecisionHash(worldSeedU32, tick, LABEL);
    const chosen = residents[hash % residents.length];
    if (chosen === undefined || chosen.assignedFacilityId === null) return state;

    const currentFacility = requireEntity(state, chosen.assignedFacilityId, "facility");
    const currentDef = content.facilityDefs.get(currentFacility.defId);
    if (currentDef === undefined) return state;

    const destination = currentDef.harshWork ? normalTarget : harshTarget;
    if (destination.id === currentFacility.id) return state;
    return moveWorker(state, chosen.id, currentFacility.id, destination.id);
  },
};
