// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- おまかせ成文化アシスト(残存tick降順 + 80/100 約束) — M27
//   GDD 2.1(アシストは理論最大の 80% 止まり)/ 11.1 [2026-07-27追補](媒体規則・
//   おまかせ整合)/ 13.1(アシストアルゴリズム3種)/ ADR-020
//
// ===========================================================================
// 1. このモジュールの位置づけ(state を変更しない)
// ===========================================================================
//   「どの未成文技術から成文化キューへ入れるべきか」を提案するだけの**純関数**で
//   ある。`src/engine/assist/placement.ts`(M26)と同じ構え —— GameState は読む
//   だけで一切書き換えず、戻り値は {@link CodificationPlan}(提案)であり、実際に
//   記録を作るのはプレイヤーが {@link codificationPlanToCommands} で得た
//   `beginCodification` コマンド列を `commands.ts` の `apply` へ渡したときだけ。
//
//   媒体選択(石板/紙)は M6 が既に実装した {@link ../rules/codify.assistPreferredMedium}
//   をそのまま呼ぶ(GDD 11.1 追補「アシスト整合: 唯一保持 tech は石板、それ以外は
//   紙」)。本モジュールは**その規則を再実装しない**。
//
// ===========================================================================
// 2. 「理論最大」の定義(★要ユーザー判断として報告)
// ===========================================================================
//   GDD 2.1 は「おまかせ成文化 ＝ 残存tick降順の単純ヒューリスティックで8割」と
//   書くのみで、比較対象(理論最大)の定義は明記していない。M26(推奨配置)が
//   「盤面の産出乗数の総和」を尺度に定めたのと同じ立場で、本タスクは次のように
//   定める:
//
//   **候補** = 「解禁済み(research 完了)・未成文(記録 0 枚)・生存保持者 1 名以上」
//   の tech(GDD 4「解禁 → 実地稼働で記憶定着 → 成文化」の最後の段にいる tech)。
//   保持者がまだ 0 名(解禁済みだが誰も実地稼働していない)の tech は「まだ失う
//   記憶が無い」ので候補に含めない。
//
//   各候補は 1 本の**単一キュー**(`rules/codify.ts` 冒頭コメント「research.ts と
//   意図的に同じ形」= 先頭 1 件だけが進む規約)を順番に流れる、という前提を置く。
//   このとき「その技術が **間に合うか**(記録完成 tick ≤ 保持者の残存想定tick)」は
//   **1 台の機械で締切のある仕事を並べ、期限に間に合う件数を最大化する**という
//   古典的なスケジューリング問題(単一機械・遅延件数最小化)に一致する。
//
//   **理論最大 = その最大化問題の最適解**(= 間に合う件数の最大値)。これは
//   Moore–Hodgson のアルゴリズム(EDD 順に並べ、期限超過が起きたら並べた中で
//   最長の作業を 1 件取り除く)で厳密に求まることが知られている古典的な結果で
//   あり、`tests/engine/assistCodify.test.ts` は小規模ケースで**全順列の総当たり**
//   により理論最大を直接検証する(M26 の総当たりテストと同じ立場)。
//
//   **GDD 指定のヒューリスティック(残存tick降順)は、この問題の「最も素朴だが
//   意図的に逆方向」の並べ方である。** 締切に間に合わせたいなら残存tickが
//   少ない(= 締切が近い)ものから処理するのが自然だが、GDD が明示する
//   「降順」はその逆(締切が遠い = 余裕があるものを先に処理する)である。
//   本モジュールは GDD の字面どおりに**降順**を実装する。これにより
//   「余裕のある tech に先に手を付け、本当に急ぐ tech が間に合わなくなる」
//   という現象が構造的に起こり、パラメータ(M26 の qualityRatio 相当)を
//   一切持たなくても理論最大からの意図的な乖離が生まれる。
//
//   **80% の測り方 = 単一キューを流したときに間に合う技術の件数の比**
//   (ヒューリスティックの間に合い件数 ÷ 理論最大の間に合い件数)。
//
// ===========================================================================
// 3. 決定論(RNG 不使用・全順序タイブレーク)
// ===========================================================================
//   乱数は一切引かない。並び順は
//     ① 残存tick 降順 → ② techId(UTF-16)昇順
//   の全順序で、tech は content 内で一意なので同点は残らない。
//
//   「残存tick」は住民の寿命モデル(`rules/lifespan.ts` の
//   {@link ../rules/lifespan.remainingLifeTicksOfResident})をそのまま使い、
//   独自の余命計算はしない。複数保持者がいる tech は**最も早く死亡する保持者**の
//   値を採る(その保持者を失っても他の保持者が残る限り知識は失われないが、
//   単純ヒューリスティックとしては「最初の喪失リスク」を tech の代表値とする)。
//   `life` を持たない保持者しかいない tech(寿命モデル不活性)は
//   {@link CODIFY_NO_DEADLINE_TICKS} という sentinel を持ち、降順ソートでは
//   「締切が無い(=最も余裕がある)」ものとして最優先に処理される —— これは
//   §2 で述べた「余裕がある方を先に処理する」という heuristics の意図的な弱さと
//   矛盾なく一致する。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import type { BeginCodificationCommand } from "../commands";
import type { Fix } from "../fp";
import {
  assistPreferredMedium,
  isCodified,
  isPrintingUnlocked,
  planCodification,
} from "../rules/codify";
import { remainingLifeTicksOfResident } from "../rules/lifespan";
import { isTechUnlocked, techHoldersOf } from "../rules/techMemory";
import type { EngineContent, RecordMedium } from "../rules/types";
import { entityIdFromString, requireEntity, type EntityId, type GameState } from "../state/state";
import { AssistError } from "./placement";

// --- 1. 定数 -----------------------------------------------------------------

/**
 * 「締切が無い」ことを表す sentinel(§3)。生存保持者の誰も `life` を持たない
 * tech に割り当てる。実 tick 値と衝突しない(寿命は tick の絶対値として
 * ここまで大きくならない)よう、安全な最大整数を使う。
 */
export const CODIFY_NO_DEADLINE_TICKS = Number.MAX_SAFE_INTEGER;

// --- 2. 候補の列挙(§2) ------------------------------------------------------

/** おまかせ成文化 1 件ぶんの候補。 */
export interface CodifyCandidate {
  readonly techId: EntityId;
  /** GDD 11.1 追補「唯一保持 → 石板、他 → 紙」(`assistPreferredMedium` そのまま)。 */
  readonly medium: RecordMedium;
  /** 生存保持者の人数(1 = 唯一保持)。 */
  readonly holderCount: number;
  /** 最も早く死亡する保持者の残存想定tick(§3)。 */
  readonly residualTick: number;
  /** 記録 1 枚の所要 tick(`planCodification` そのまま)。 */
  readonly durationTicks: number;
  /** 記録 1 枚のコスト(`planCodification` そのまま。診断用・アシストは検査しない)。 */
  readonly costFix: Fix;
}

/**
 * その tech の「残存tick」(§3)。生存保持者のうち `life` を持つ者の
 * {@link ../rules/lifespan.remainingLifeTicksOfResident} の最小値。
 * 該当者が 1 人も居なければ {@link CODIFY_NO_DEADLINE_TICKS}。
 */
export function codifyResidualTick(state: GameState, techId: EntityId, atTick: number): number {
  let min: number | null = null;
  for (const holderId of techHoldersOf(state, techId)) {
    const holder = requireEntity(state, holderId, "resident");
    const remaining = remainingLifeTicksOfResident(holder, atTick);
    if (remaining === null) continue;
    if (min === null || remaining < min) min = remaining;
  }
  return min ?? CODIFY_NO_DEADLINE_TICKS;
}

/**
 * おまかせ成文化の候補一覧(§2 の「解禁済み・未成文・生存保持者あり」)。
 * 返す順序は techId 昇順(候補そのものの正準順。キュー順は
 * {@link suggestCodification} が別途決める)。
 */
export function assistCodifyCandidates(
  state: GameState,
  content: EngineContent,
  atTick: number,
): readonly CodifyCandidate[] {
  const printingUnlocked = isPrintingUnlocked(state, content);
  const techIds = [...content.techDefs.keys()].sort(compareUtf16);
  const result: CodifyCandidate[] = [];
  for (const techId of techIds) {
    if (!isTechUnlocked(state, techId)) continue;
    if (isCodified(state, techId)) continue;
    const holders = techHoldersOf(state, techId);
    if (holders.length === 0) continue;

    const medium = assistPreferredMedium(holders.length === 1);
    const plan = planCodification(content, techId, medium, printingUnlocked);
    result.push({
      techId,
      medium,
      holderCount: holders.length,
      residualTick: codifyResidualTick(state, techId, atTick),
      durationTicks: plan.durationTicks,
      costFix: plan.costFix,
    });
  }
  return result;
}

// --- 3. キュー順(§2/§3)と提案 -----------------------------------------------

/** {@link suggestCodification} 1 件ぶんの提案。 */
export interface CodificationSuggestion {
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  /** `beginCodification` コマンドへそのまま渡す新規 entity ID(§4)。 */
  readonly codifyId: EntityId;
  readonly residualTick: number;
  readonly durationTicks: number;
  /**
   * 単一キューでこの手まで流したときの累積所要 tick
   * (= このキュー順で先頭からこの手までの durationTicks の総和)。
   */
  readonly cumulativeTicks: number;
  /** `cumulativeTicks <= residualTick`(この手までに間に合うか・§2 の診断)。 */
  readonly onSchedule: boolean;
}

/** {@link suggestCodification} の結果。state は一切動いていない(§1)。 */
export interface CodificationPlan {
  /** 残存tick降順(§3)のキュー順。 */
  readonly suggestions: readonly CodificationSuggestion[];
}

/** 残存tick降順 → techId 昇順の全順序(§3)。 */
function compareCandidatesForQueue(a: CodifyCandidate, b: CodifyCandidate): number {
  if (a.residualTick !== b.residualTick) return b.residualTick - a.residualTick;
  return compareUtf16(a.techId, b.techId);
}

/**
 * おまかせ成文化を提案する(GDD 2.1「おまかせ成文化」)。**state は動かない**(§1)。
 *
 * 候補(§2)を「残存tick降順」(§3)へ並べ替え、単一キューで先頭から順に流した
 * ときの累積所要 tick と間に合うかどうかを添えて返す。並べ替えそのものが
 * ヒューリスティックの全てであり、M26 のような明示パラメータ(qualityRatio)は
 * 持たない —— GDD がヒューリスティックの向きそのものを指定しているため。
 *
 * @throws {AssistError} atTick が整数でない場合
 */
export function suggestCodification(
  state: GameState,
  content: EngineContent,
  atTick: number,
): CodificationPlan {
  if (!Number.isSafeInteger(atTick)) {
    throw new AssistError(`suggestCodification: atTick ${String(atTick)} は整数で指定する`);
  }
  const candidates = [...assistCodifyCandidates(state, content, atTick)].sort(
    compareCandidatesForQueue,
  );

  const suggestions: CodificationSuggestion[] = [];
  let cumulativeTicks = 0;
  for (const candidate of candidates) {
    cumulativeTicks += candidate.durationTicks;
    suggestions.push({
      techId: candidate.techId,
      medium: candidate.medium,
      codifyId: codifyRecordId(candidate.techId, candidate.medium),
      residualTick: candidate.residualTick,
      durationTicks: candidate.durationTicks,
      cumulativeTicks,
      onSchedule: cumulativeTicks <= candidate.residualTick,
    });
  }
  return { suggestions };
}

// --- 4. entity ID とコマンド変換 --------------------------------------------

/**
 * 提案する codify entity の ID を (techId, medium) から決定論的に作る。
 * `beginCodification` は同一 (techId, medium) の記録を重複させないので
 * (`rules/codify.ts` §3)、この 2 つから作る ID は本モジュールの提案の中で
 * 自然に一意になる —— 呼び出し側に ID 採番を要求しない(A-7 の瓦礫ヘルパと
 * 同じ「呼び忘れ防止」の思想)。
 */
export function codifyRecordId(techId: EntityId, medium: RecordMedium): EntityId {
  const suffix = medium === "stoneTablet" ? "Stone" : "Paper";
  return entityIdFromString(`${techId}Record${suffix}`);
}

/**
 * 提案を `beginCodification` コマンド列(キュー順)へ落とす(ADR-020)。
 * 適用するかどうかはプレイヤーの判断であり、この関数は state を触らない。
 */
export function codificationPlanToCommands(
  plan: CodificationPlan,
): readonly BeginCodificationCommand[] {
  const commands: BeginCodificationCommand[] = [];
  for (const suggestion of plan.suggestions) {
    commands.push({
      kind: "beginCodification",
      codifyId: suggestion.codifyId,
      techId: suggestion.techId,
      medium: suggestion.medium,
    });
  }
  return commands;
}
