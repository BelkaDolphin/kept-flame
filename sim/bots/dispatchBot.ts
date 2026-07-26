// ---------------------------------------------------------------------------
// 派遣 bot(計測用ダミー・1〜2本のうちの1本) — 先行計測計画 §2.1 P2
//
// 探索/派遣システムは縮約 rules の対象外(src/engine/rules/types.ts §2)だが、
// GDD 11.2 の dispatchW(+0.15)は `resident.dispatched` の値だけを見るので、
// 探索そのものを実装せず「一定周期で派遣中フラグが入れ替わる」ことだけを
// 代表させれば dispatchW 項が乗る代表負荷を再現できる(T9 指示書「配属替え・
// 研究キュー選択相当の状態操作」の派遣版)。
//
// 毎ゲーム日、住民ごとに hash(worldSeedU32, tick, "dispatch:<residentId>") から
// dispatched を再計算する(前回の値を引き継がず、その日の抽選だけで決める =
// 状態を持たない代表モデル。純関数なので decision の再現性が担保される)。
// ---------------------------------------------------------------------------

import { entitiesOfKind } from "../../src/engine/state/state";
import { setField, updateEntity } from "../../src/engine/state/update";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";
import { botDecisionHash, hashPercent } from "../detHash";
import type { SimBot } from "../runner";

const LABEL = "dispatch";
/** 派遣中になる住民の割合(%)。GDD 8.1 相当の代表値として小さめに固定する。 */
const DISPATCH_PERCENT = 15;

export const dispatchBot: SimBot = {
  id: "dispatchBot",
  intervalTicks: GAME_DAY_TICKS,
  apply: (state, _content, worldSeedU32, tick) => {
    let next = state;
    for (const resident of entitiesOfKind(state, "resident")) {
      const hash = botDecisionHash(worldSeedU32, tick, `${LABEL}:${resident.id}`);
      const dispatched = hashPercent(hash) < DISPATCH_PERCENT;
      if (dispatched === resident.dispatched) continue;
      next = updateEntity(next, resident.id, "resident", (r) =>
        setField(r, "dispatched", dispatched),
      );
    }
    return next;
  },
};
