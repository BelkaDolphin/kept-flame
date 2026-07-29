// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 派生値 combatPower の state 結線 — GDD 7.1 / 8.2(裁定 B8)
//
// ===========================================================================
// 1. このモジュールの位置づけ(M7)
// ===========================================================================
//   算出式そのものは `rules/stats.ts` §5 が持つ(content 内部表現だけを見る
//   純関数)。ここはその式を **state(住民 entity)へ結線する層**であり、
//     - 住民の `stats` 省略 = 中立既定値(全ステ 50)
//     - 住民の `traitIds` → content の trait 定義(未知 ID は読み飛ばし)
//   という 2 つの既定の解決だけを担う。`rules/production.ts` の
//   `residentContribution` と同じ役割分担(そちらは生産式側)。
//
// ===========================================================================
// 2. ここで**やらない**こと
// ===========================================================================
//   GDD 8.2 の判定式
//     成否 = (関連チーム総合力 + 装備補正 + seededRoll(0..R)) >= difficulty
//   のうち、装備補正・seededRoll・difficulty 比較・イベント種別ごとの
//   `statWeights` 解決は**探索解決(M21)の担当**である。MVP の縮約 rules は
//   探索を持たない(rules/types.ts §2)ので、本モジュールは「素の戦力」を出す
//   ところで止める。装備を combatPower 側へ混ぜないのは二重計上を避けるため
//   (rules/stats.ts §5(1))。
// ---------------------------------------------------------------------------

import { type Fix } from "../fp";
import { requireEntity, type EntityId, type GameState, type ResidentState } from "../state/state";
import {
  NEUTRAL_RESIDENT_STATS,
  combatPowerFix,
  resolveCombatTraitDefs,
  teamCombatPowerFix,
} from "./stats";
import type { EngineContent } from "./types";

/**
 * 住民 1 人の戦力(GDD 8.2 の派生値 `combatPower`)。基礎ステと同じ 0〜100
 * スケールで、全ステ 50・trait 無しの住民はちょうど 50 になる。
 *
 * ステータス未設定の住民は {@link NEUTRAL_RESIDENT_STATS} として扱う
 * (state.ts の `stats` が省略可である契約。M5 と同じ既定)。
 */
export function residentCombatPower(resident: ResidentState, content: EngineContent): Fix {
  const traits = resolveCombatTraitDefs(resident.traitIds, content.traitDefs);
  return combatPowerFix(resident.stats ?? NEUTRAL_RESIDENT_STATS, traits);
}

/**
 * チームの戦力合計(GDD 8.2「関連チーム総合力」の戦力ぶん)。
 *
 * `memberIds` の並びは呼び出し側の責任で ID 昇順にすること(GDD 11.7)。
 * 現状の加算は順序非依存だが、順序を前提にした項を将来足したときに
 * ここが静かに壊れないための規律。
 *
 * @throws {EntityLookupError} `memberIds` に住民でない ID / 存在しない ID が
 *   含まれる場合(派遣チームの取り違えを黙って 0 にしないため)
 */
export function teamCombatPower(
  state: GameState,
  memberIds: readonly EntityId[],
  content: EngineContent,
): Fix {
  const powers: Fix[] = [];
  for (const memberId of memberIds) {
    powers.push(residentCombatPower(requireEntity(state, memberId, "resident"), content));
  }
  return teamCombatPowerFix(powers);
}
