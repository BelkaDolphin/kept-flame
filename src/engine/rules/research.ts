// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- (B)研究完了 = レート変化イベント — GDD 11.8(B) / ADR-008
//
// ===========================================================================
// 1. (B) 区間の定義(GDD 11.8(B))
// ===========================================================================
//   (B) レート変化イベント(研究完了 / 成文化完了 / era 昇格)は
//   「イベント発生時刻で積分区間を分割し、各区間別レートで閉形式 → 次イベントへ
//   ジャンプする」ハイブリッドで扱う。研究完了はその代表例であり、本モジュールは
//   (B) の 2 つの半分を提供する:
//
//     (i)  {@link ticksUntilResearchComplete} — 現在のレートから**完了 tick を
//          解析的に予測**する。scheduler がこれを離散事象として heap に積み、
//          積分区間の分割点にする。レートが変わったら予測を作り直す。
//     (ii) {@link completeResearch} — その tick に到達したときの状態遷移。
//          以降は次の研究へレートが向くので、ここが次の (A) 区間の始点になる。
//
//   予測は「残り / レート」の切り上げなので、完了 tick では必ず
//   進行度 >= コスト が成り立つ(過小評価しない)。切り上げによって 1 tick 分だけ
//   余分に進むことはあるが、その余剰はそのまま progress に残す(捨てない)。
//
// ===========================================================================
// 2. 研究は 1 本ずつ(単一キュー)+ [M50] プレイヤーの選択
// ===========================================================================
//   研究点が入るのは常に **1 本**である(複数本へ同時に按分/複製する仕様は GDD に
//   無く、(B) の予測も 1 件で済む = heap のイベントも 1 件)。その 1 本の決め方が
//   M50 で 2 段になった:
//
//     (1) `state.selectedResearchId`(GDD 5・`commands.ts` の `beginResearch`)が
//         **有効な対象を指していれば、それ**。
//     (2) 指していなければ従来どおり「未完了の research entity のうち ID 昇順で
//         最初の 1 本」。
//
//   **(2) を残すことが「既存セーブ・既存 golden vector が 1 bit も動かない」
//   ことの根拠**である(選択を持たない state では (1) が必ず素通りする)。
//   「未選択なら研究点をどこにも入れない」という設計も採れるが、それは既存の
//   全シナリオの観測挙動を変え(= algoVersion bump)、かつ「何も選んでいない
//   72h 放置で研究点が丸ごと消える」という GDD 2.2(放置しても (A) は失われない)
//   と噛み合わない挙動になるため採らない(M50 の★報告)。
//
//   選択が「有効」でなくなる条件(= (2) へ落ちる条件)は 3 つで、いずれも
//   **state を書き換えずに判定できる**ようにしてある(選択の失効を state 遷移に
//   すると (B) 完了イベントが「レート境界」から「状態遷移を持つ境界」へ変わり、
//   分割不変性の再検証が要る・state.ts 不変条件 (k)):
//     (a) 指す entity が無い(removeEntity が同時に選択も外すので通常起きない)
//     (b) 完了済み(`completedTick !== null`)
//     (c) (B) 一回性喪失(`isIrreversiblyLost`)
// ---------------------------------------------------------------------------

import {
  FIX_ZERO,
  addFix,
  fixFromInt,
  floorDivInt,
  mulFixInt,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import {
  entitiesOfKind,
  getEntity,
  getFieldRunTicks,
  requireEntity,
  type EntityId,
  type GameState,
  type ResearchState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";
import { isIrreversiblyLost } from "./techMemory";
import { RulesError, requireTechDef, type EngineContent } from "./types";

/**
 * 研究点が入る「現在の研究」(§2)。
 * [M50] プレイヤーの選択が有効ならそれ、無ければ未完了の research entity のうち
 * ID 昇順で最初の 1 件。どちらも無ければ undefined。
 *
 * [M13] (B) 一回性喪失した技術(GDD 7.4 `rareIrreversible`)は**対象から外す**。
 * 喪失時に `completedTick` は null へ戻る(= 解禁の取り消し)ので、外さないと
 * 「永久に失ったはずの技術へ研究点が吸われ続ける」状態になる。(A)
 * `criticalRecoverable` は `loss` が付いていても対象に残る = 再研究できる
 * (GDD 7.4「失っても必ず再取得可能」)。
 */
export function currentResearch(
  state: GameState,
  content?: EngineContent,
): ResearchState | undefined {
  const selected = selectedResearch(state);
  if (selected !== undefined && !isPointsSaturated(state, content, selected)) return selected;
  let fallback: ResearchState | undefined;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick !== null) continue;
    if (isIrreversiblyLost(research)) continue;
    fallback ??= research;
    if (isPointsSaturated(state, content, research)) continue;
    return research;
  }
  // 全ての未完了研究が「点は満了・実地要件待ち」なら、従来どおり先頭へ入れる
  // (点の行き先が無い state を作らない = M67 以前と同じ縮退)。
  return fallback;
}

/**
 * [M67] その研究が「研究点は満了しているが実地要件が未達」= **もう点を受け取れない**
 * か(§3)。`content` 省略時 / `content.research` 不在では常に false なので、
 * 引数 1 つの既存呼び出し(UI・テスト)は M67 以前と 1 bit も違わない。
 *
 * この判定が要るのは、点が入り続けても完了しない研究へ研究点を注ぎ続けると
 * **その run の研究がまるごと止まる**ためである(実地要件が第2ゲートとして
 * 「完了を保留する」ことの帰結は待ち時間であって、研究点の消滅ではない)。
 */
function isPointsSaturated(
  state: GameState,
  content: EngineContent | undefined,
  research: ResearchState,
): boolean {
  if (content === undefined) return false;
  if (toRaw(researchRemaining(content, research)) > 0) return false;
  return !isFieldRequirementMet(state, content, research);
}

/**
 * [M50] `state.selectedResearchId` が指す**有効な**研究(§2 の (1))。
 * 未選択・失効(不在 / 完了済み / (B) 永久喪失)なら undefined。
 *
 * `currentResearch` と分けてあるのは UI(⑤研究ツリー)が「選択そのもの」と
 * 「いま点が入っている対象」を別々に見せられるようにするため。
 */
export function selectedResearch(state: GameState): ResearchState | undefined {
  const selectedId = state.selectedResearchId;
  if (selectedId === null) return undefined;
  const entity = getEntity(state, selectedId);
  if (entity === undefined || entity.kind !== "research") return undefined;
  if (entity.completedTick !== null) return undefined;
  if (isIrreversiblyLost(entity)) return undefined;
  return entity;
}

/**
 * 完了まで残っている研究点。0 以下ならもう完了条件を満たしている。
 *
 * @throws {RulesError} tech 定義が content に無い場合
 */
export function researchRemaining(content: EngineContent, research: ResearchState): Fix {
  return subFix(requireTechDef(content, research.techId).researchCostFix, research.progress);
}

/**
 * 完了までに要する tick 数。レートが 0 以下なら null(到達しない)。
 *
 * `ceil(remaining / rate)` を `-floor(-remaining / rate)` で計算する
 * (`floor((remaining + rate - 1) / rate)` は分子が 2^53 を超え得るので使わない)。
 * remaining / rate はどちらも Fix の raw(同じスケール)なので比は無次元の tick 数。
 *
 * **残りが 0 以下なら 0 を返す**(= 現在 tick で完了させる)。これは 2 つの経路で
 * 起きる:
 *   (i)  半開区間の規約(scheduler.ts §2)により、完了 tick ちょうどで advance を
 *        区切ると完了イベントが発火せず「進行度がコストに達したまま未完了」の
 *        state が保存される。次回の advance は現在 tick で完了させなければ
 *        一括で進めた場合と結果が食い違う(分割不変性・advance.ts §3)。
 *   (ii) content 側でコストを引き下げた等で、ロード時点で既に条件を満たしている。
 * 0 を返すと scheduler は現在カーソルと同 tick へ完了イベントを積むが、処理すると
 * その研究は完了して次の研究へ移るので、同 tick への再予約は有限回で止まる
 * (進行保証・scheduler.ts §2)。
 *
 * この関数の戻り値が安定していること(区間を積分して remaining が減っても
 * `cursor + ticks` が同じ tick を指し続ける)が (B) 予測が振動しない根拠:
 * remaining が rate×Δ だけ減ると ceil(remaining/rate) はちょうど Δ 減る。
 */
export function ticksUntilResearchComplete(remainingFix: Fix, ratePerTickFix: Fix): number | null {
  const rate = toRaw(ratePerTickFix);
  if (rate <= 0) return null;
  const remaining = toRaw(remainingFix);
  if (remaining <= 0) return 0;
  return -floorDivInt(-remaining, rate);
}

/**
 * (A) 区間ぶんの研究進行を一括加算する(区分求積 = レート × 区間長)。
 * レートが 0 なら state をそのまま返す。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない場合
 */
export function applyResearchProgress(
  state: GameState,
  researchId: EntityId,
  ratePerTickFix: Fix,
  deltaTicks: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyResearchProgress: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  if (toRaw(ratePerTickFix) === 0) return state;
  const gain = mulFixInt(ratePerTickFix, deltaTicks);
  return updateEntity(state, researchId, "research", (r) =>
    setField(r, "progress", addFix(r.progress, gain)),
  );
}

// --- 3. [M67] 実地要件 = 研究完了の第2ゲート(GDD 5 / 5.2) ------------------
//
//   2026-08-06裁定・台帳v20 必-1。**完了ゲート方式**である: 研究点が満了しても
//   実地要件(該当施設での稼働時間)が未達なら完了しない。start-gate(要件を
//   満たすまで研究点を入れない)にしなかったのは、研究点の行き先を変えると
//   `currentResearch` の意味(GDD 2.2「放置しても (A) は失われない」)まで
//   動くためで、完了だけを保留する方が既存の (B) 予測と同型に収まる。
//
//   完了 tick の予測は **max(研究点満了 tick, 実地要件充足 tick)** の閉形式で
//   あり、どちらの項も「残り / レート」の切り上げ(= 既存の研究完了予測と同型)
//   なので分割不変性が保たれる: 区間を刻んで remaining が rate×Δ だけ減れば
//   ceil(remaining/rate) はちょうど Δ 減り、max も同じだけ減る。
//
//   蓄積側((A) 区間の閉形式)は `rules/techMemory.ts` §4b。

/**
 * [M67] その tech の実地要件 tick 数(= `fieldRequirementCount × recipeRunTicks`)。
 * content に `research` ブロックが無い / tech に `fieldRequirementCount` が無い
 * 場合は **0**(= 要件なし。M67 以前と同一挙動)。
 */
export function fieldRequirementTicks(content: EngineContent, techId: EntityId): number {
  const recipeRunTicks = content.research?.recipeRunTicks;
  if (recipeRunTicks === undefined) return 0;
  const count = content.techDefs.get(techId)?.fieldRequirementCount;
  if (count === undefined || count <= 0) return 0;
  return count * recipeRunTicks;
}

/**
 * [M67] 実地要件の残り(Fix・0 以下なら充足済み)。
 * 蓄積は `GameState.fieldRunTicksByTechId`(tech 別の累積稼働 tick)。
 */
export function fieldRequirementRemaining(
  state: GameState,
  content: EngineContent,
  research: ResearchState,
): Fix {
  const requiredTicks = fieldRequirementTicks(content, research.techId);
  if (requiredTicks <= 0) return FIX_ZERO;
  const accumulated = getFieldRunTicks(state, research.techId) ?? FIX_ZERO;
  return subFix(fixFromInt(requiredTicks), accumulated);
}

/**
 * [M67] 実地要件が充足しているか(= 残り 0 以下)。
 * 要件が無い content / tech では常に true。
 */
export function isFieldRequirementMet(
  state: GameState,
  content: EngineContent,
  research: ResearchState,
): boolean {
  return toRaw(fieldRequirementRemaining(state, content, research)) <= 0;
}

/**
 * [M67] 実地要件が充足するまでの tick 数。レートが 0 以下なら null(到達しない
 * = 該当施設が 1 基も稼働していない)。式は {@link ticksUntilResearchComplete} と
 * **完全に同型**(切り上げ・残り 0 以下なら 0)。
 */
export function ticksUntilFieldRequirement(remainingFix: Fix, ratePerTickFix: Fix): number | null {
  return ticksUntilResearchComplete(remainingFix, ratePerTickFix);
}

/**
 * [M67] 「点は満了しているが実地要件待ち」の研究を tick 順・ID 順で列挙する
 * (§3)。研究点の行き先({@link currentResearch})から外れた研究も**完了だけは
 * するべき**なので、scheduler はこの一覧ぶんの完了イベントも同期する。
 *
 * `content.research` が無い content では常に空(= M67 以前と同一)。
 */
export function fieldBlockedResearches(
  state: GameState,
  content: EngineContent,
): readonly ResearchState[] {
  if (content.research === undefined) return NO_RESEARCHES;
  const result: ResearchState[] = [];
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick !== null) continue;
    if (isIrreversiblyLost(research)) continue;
    if (toRaw(researchRemaining(content, research)) > 0) continue;
    if (isFieldRequirementMet(state, content, research)) continue;
    result.push(research);
  }
  return result;
}

/** 空の研究一覧(アロケーションを避けるための共有値)。 */
const NO_RESEARCHES: readonly ResearchState[] = [];

/**
 * [M67] 研究完了までの tick 数(**第2ゲート込み**)。
 * 「研究点満了 tick」と「実地要件充足 tick」の **max**。どちらか一方でも
 * 到達しない(null)なら完了しない = null。
 */
export function ticksUntilResearchCompleteGated(
  remainingResearchFix: Fix,
  researchRatePerTickFix: Fix,
  remainingFieldFix: Fix,
  fieldRatePerTickFix: Fix,
): number | null {
  const byPoints = ticksUntilResearchComplete(remainingResearchFix, researchRatePerTickFix);
  if (byPoints === null) return null;
  if (toRaw(remainingFieldFix) <= 0) return byPoints;
  const byField = ticksUntilFieldRequirement(remainingFieldFix, fieldRatePerTickFix);
  if (byField === null) return null;
  return byPoints > byField ? byPoints : byField;
}

/**
 * 研究を完了させる((B) イベントの状態遷移)。進行度は減らさない(切り上げ由来の
 * 余剰をそのまま残す)。
 *
 * @throws {RulesError} 既に完了している / 進行度がコストに届いていない /
 *   [M67] 実地要件が未達の場合
 */
export function completeResearch(
  state: GameState,
  content: EngineContent,
  researchId: EntityId,
  tick: number,
): GameState {
  const research = requireEntity(state, researchId, "research");
  if (research.completedTick !== null) {
    throw new RulesError(
      `completeResearch: research "${researchId}" は既に tick ${String(research.completedTick)} で完了している`,
    );
  }
  if (toRaw(researchRemaining(content, research)) > 0) {
    throw new RulesError(
      `completeResearch: research "${researchId}" の進行度がコストに届いていない` +
        `((B) の完了 tick 予測と実際の進行が食い違っている)`,
    );
  }
  // [M67] 第2ゲート(§3)。scheduler は max(...) の tick にしか完了イベントを
  // 積まないので、ここへ未達で来るのは予測と蓄積が食い違っている実装バグである。
  if (!isFieldRequirementMet(state, content, research)) {
    throw new RulesError(
      `completeResearch: research "${researchId}" の実地要件が未達` +
        `(残り ${String(toRaw(fieldRequirementRemaining(state, content, research)))} raw tick・GDD 5.2)`,
    );
  }
  return updateEntity(state, researchId, "research", (r) => setField(r, "completedTick", tick));
}
