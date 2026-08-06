// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 5戦略bot 共有の想起リスクガード — M36 / GDD 11.5
//
// GDD 11.5:「未成文の唯一保持技術を持つ住民は士気 <40 では過酷業務・派遣に
// 回さない」を、5戦略bot 全てが共有する **1 個の純関数**として実装する
// (5本が同じ判断を別々に再実装すると、どれか 1 本が閾値をずらして「ラベルだけの
// bot」になる余地が生まれるため)。
//
// 「未成文の唯一保持技術」の定義(engine の既存語彙をそのまま組み合わせる。
// 新しい判定を発明しない):
//   ・保持   = `techMemory.heldTechIdsOf`(定着度 > 0・GDD 4)
//   ・未成文 = `codify.isCodified` が false(完了済み記録が 1 枚も無い)
//   ・唯一   = `techMemory.techHoldersOf` の**生存**保持者が本人 1 人だけ
//
// 「実際にブロックした」ときだけログを積む(§ types.ts の doc と同じ理由)。
// 士気が閾値以上、または該当技術が無い住民は素通り(ブロックもログも無し)。
// ---------------------------------------------------------------------------

import { fixFromInt, toRaw, type Fix } from "../../src/engine/fp";
import { isCodified } from "../../src/engine/rules/codify";
import { effectiveMoraleFix } from "../../src/engine/rules/morale";
import { heldTechIdsOf, techHoldersOf } from "../../src/engine/rules/techMemory";
import type { EngineContent } from "../../src/engine/rules/types";
import type { EntityId, GameState, ResidentState } from "../../src/engine/state/state";
import type { RecallGuardLogEntry } from "./types";

/**
 * GDD 11.5 の閾値(士気 <40・人間単位)の**フォールバック**。
 *
 * [M72・台帳v20 必-4] 閾値の正本は content(`balance.morale.recallGuardThreshold`)へ
 * 移した。この定数は「content に `morale` ブロックが無い(= 士気モデルが不活性な)
 * content で bot を回す」ときの既定値としてだけ残る —— sim は content が欠けても
 * 走り切れなければならず(縮約 content の回帰テストがある)、かつ GDD 11.5 の
 * 40 という値そのものは engine/sim いずれかに必ず書いてある必要があるため。
 */
export const RECALL_GUARD_MORALE_THRESHOLD_HUMAN = 40;

/**
 * [M72] その盤面で使う想起ガード閾値(Fix)。content の
 * `balance.morale.recallGuardThreshold` が正本で、無ければ
 * {@link RECALL_GUARD_MORALE_THRESHOLD_HUMAN}。
 */
export function recallGuardThresholdFix(content: EngineContent): Fix {
  return content.morale?.recallGuardThresholdFix ?? fixFromInt(RECALL_GUARD_MORALE_THRESHOLD_HUMAN);
}

/**
 * その住民が保持する「未成文の唯一保持技術」(techId 昇順・`heldTechIdsOf` の
 * 順序をそのまま保つ)。GDD 11.5 の判断対象そのもの。
 */
export function soleUncodifiedHeldTechIds(
  state: GameState,
  residentId: EntityId,
): readonly EntityId[] {
  const result: EntityId[] = [];
  for (const techId of heldTechIdsOf(state, residentId)) {
    if (isCodified(state, techId)) continue;
    const holders = techHoldersOf(state, techId);
    if (holders.length === 1 && holders[0] === residentId) result.push(techId);
  }
  return result;
}

/** {@link recallGuardBlocks} の結果。 */
export interface RecallGuardCheck {
  /** true ならその行為(過酷業務配属 / 探索派遣)を採用しないこと。 */
  readonly blocked: boolean;
  /** blocked のときだけ非 null。呼び出し側はこれをそのままログへ積む。 */
  readonly logEntry: RecallGuardLogEntry | null;
}

/**
 * GDD 11.5 の閾値付き判断(5戦略bot 共有)。
 *
 * 士気が閾値(40)以上なら常に false(素通り)。士気 <40 でも「未成文の唯一保持
 * 技術」を 1 つも持たなければ false。両方成り立つときだけ true を返し、
 * {@link RecallGuardLogEntry} を添える(「実際に踏まれた」ことの証跡)。
 *
 * [M72] `content` を実際に読むようになった: 閾値は content 側
 * ({@link recallGuardThresholdFix})、判定する士気は **実効士気**
 * (trait 楽観/悲観 ±10 込み・`src/engine/rules/morale.ts`)である。engine の
 * (C) 抽選(GDD 11.2 の moraleW)と bot の判断(GDD 11.5)が**同じ値**を見る
 * ようにするための変更で、片方だけ trait を無視すると「engine では危機なのに
 * bot は平気」という食い違いが静かに生まれる。
 */
export function recallGuardBlocks(
  state: GameState,
  content: EngineContent,
  resident: ResidentState,
  action: "harshAssignment" | "dispatch",
  tick: number,
  botId: string,
): RecallGuardCheck {
  const thresholdFix = recallGuardThresholdFix(content);
  if (toRaw(effectiveMoraleFix(resident, content)) >= toRaw(thresholdFix)) {
    return { blocked: false, logEntry: null };
  }

  const techIds = soleUncodifiedHeldTechIds(state, resident.id);
  if (techIds.length === 0) return { blocked: false, logEntry: null };

  return {
    blocked: true,
    logEntry: { tick, botId, residentId: resident.id, techIds, action },
  };
}
