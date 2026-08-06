// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 療養所の休養(care)— GDD 11.2 / 6.1 / M66
//
// ===========================================================================
// 1. GDD のどこを実装しているか
// ===========================================================================
//   GDD 11.2(想起困難)の回復条件は 2 枝ある:
//     (i)  通常業務就労かつ士気 ≥40 を持続
//     (ii) **療養所で休養1日**
//   T5〜M13 はどちらも縮約(持続 d の満了のみ)だったが、M66 は (ii) を実装する。
//   療養所は GDD 6.1 の施設14種のひとつであり、就労スロットを持たない
//   (`slots.lv1〜lv5 = 0`)「Lv 別カーブ 1 本で効果を表す設備」= 寝床
//   (`bedCapacityCurve`)・保管庫(`storageCapacityCurve`)と同じ形である。
//   よって休養枠も content 側の `facility.careCapacityCurve` に置き、
//   回復までの tick だけを `balance.care.restRecoveryTicks` に置いた。
//
//   **[解釈] GDD が書いていない点と、その最小解釈**:
//     (a) 「誰が休養するか」を GDD は書いていない。療養所は就労スロットを
//         持たない = 配属コマンドで人を入れる設計ではないので、**その tick に
//         想起困難中の住民が枠の空いている限り自動で休養する**と読む
//         (「療養所がある町では、倒れた者から順に手当てを受ける」)。
//         枠が足りないときの優先順は住民 ID 昇順(engine の全集合演算と同じ
//         正準順・GDD 11.7)。
//     (b) 「休養1日」の 1 日は**発生からの経過**と読む(回復 tick =
//         発生 tick + restRecoveryTicks)。抽選された持続(1〜2日)が
//         これより長いときだけ短縮し、短いときは**延ばさない**
//         (療養所があると回復が遅くなる、という逆転を作らない)。
//
// ===========================================================================
// 2. 決定論と (A) 区間の関係
// ===========================================================================
//   {@link careRecipientsAt} は「その tick に想起困難中の生存住民を ID 昇順に
//   枠数まで」返す純関数であり、Map の反復順に依存しない
//   (`entitiesOfKind` は ID 昇順・`techMemoryKeys` はキー昇順)。
//
//   休養している顔ぶれが変わるのは**想起困難の発生**((C) 粗粒度ステップ境界)と
//   **回復**((B) recallRecover 境界)のときだけで、どちらも既に scheduler の
//   区間境界である。よって「休養中かどうか」に依存するレート(M72 の士気回復)を
//   (A) 区間の閉形式に載せても、区間内でレートが変わることはない
//   = 新しい境界イベントを増やさずに済む(scheduler.ts §1 の不変条件)。
// ---------------------------------------------------------------------------

import {
  entitiesOfKind,
  getTechMemory,
  isAliveResident,
  techMemoryKeys,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../state/state";
import { requireFacilityDef, RulesError, type EngineContent } from "./types";

/**
 * 盤面の同時休養枠(GDD 6.1 の療養所)。`careCapacityByLevel` を持つ施設の
 * Lv 別値の総和で、`rules/population.ts` の `bedCapacityOf` と同型。
 *
 * @throws {RulesError} facility 定義が無い / Lv が休養枠カーブの範囲外の場合
 */
export function careCapacityOf(state: GameState, content: EngineContent): number {
  let total = 0;
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(content, facility.defId);
    const curve = def.careCapacityByLevel;
    if (curve === undefined) continue;
    const value = curve[facility.level - 1];
    if (value === undefined) {
      throw new RulesError(
        `facility "${def.id}" の Lv${String(facility.level)} の休養枠が定義に無い` +
          `(careCapacityByLevel の長さ ${String(curve.length)})`,
      );
    }
    total += value;
  }
  return total;
}

/**
 * その住民がこの tick に想起困難中か(住民単位スカラ or (住民, tech) 別のどれか
 * 1 つでも有効なら true)。**休養の対象判定にだけ使う**述語であり、生産側の
 * 「この施設で稼働しているか」(`rules/production.ts`)とは層が違う。
 */
export function isResidentImpairedAt(
  state: GameState,
  resident: ResidentState,
  tick: number,
): boolean {
  if (tick < resident.recallImpairedUntilTick) return true;
  for (const key of techMemoryKeys(state)) {
    const separator = key.indexOf("|");
    if (separator <= 0) continue;
    if (key.slice(0, separator) !== resident.id) continue;
    const memory = getTechMemory(state, key);
    if (memory !== undefined && tick < memory.impairedUntilTick) return true;
  }
  return false;
}

/**
 * その tick に療養所で休養している住民(ID 昇順・枠数まで・§1(a))。
 *
 * `content.care` が無い(= 休養機構が不活性)か盤面に休養枠が 1 つも無ければ
 * **常に空配列**を返す —— これが「M66 以前と 1 bit も違わない」ことの根拠。
 */
export function careRecipientsAt(
  state: GameState,
  content: EngineContent,
  tick: number,
): readonly EntityId[] {
  if (content.care === undefined) return [];
  const capacity = careCapacityOf(state, content);
  if (capacity <= 0) return [];

  const result: EntityId[] = [];
  // entitiesOfKind は ID 昇順(state.ts の不変条件 (a))なので、この走査だけで
  // 「ID 昇順に枠数まで」が満たされる(別途ソートしない)。
  for (const resident of entitiesOfKind(state, "resident")) {
    if (result.length >= capacity) break;
    if (!isAliveResident(resident)) continue;
    if (!isResidentImpairedAt(state, resident, tick)) continue;
    result.push(resident.id);
  }
  return result;
}

/**
 * 休養を織り込んだ想起困難の回復 tick(§1(b))。
 *
 * `underCare` が false、または `content.care` が無ければ抽選値をそのまま返す。
 * 休養中なら「発生 tick + restRecoveryTicks」と抽選値の**早い方**を採る。
 */
export function recoveryTickWithCare(
  content: EngineContent,
  occurredTick: number,
  drawnUntilTick: number,
  underCare: boolean,
): number {
  const care = content.care;
  if (!underCare || care === undefined) return drawnUntilTick;
  const restUntil = occurredTick + care.restRecoveryTicks;
  return Math.min(drawnUntilTick, restUntil);
}
