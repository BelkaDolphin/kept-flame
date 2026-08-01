// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 5戦略bot 共有の型 — M36
//   GDD 11.4(simボット検証条件)/ 11.5(想起リスク管理ロジック)/ 11.6(敵対bot、
//   本タスクは対象外)/ 2.1(アシスト)
//
// 5戦略bot(貪欲/研究優先/探索優先/配置戦略違い/成文化優先)が共有する語彙。
// bot は「state と worldSeed(+tick)だけの純関数」(絶対ルール: Math.random 等
// 不使用)であり、engine の公開 API(advance/commands/assist/derived系の rules
// 関数)だけを呼ぶ。engine 内部の再実装はしない。
// ---------------------------------------------------------------------------

import type { Command } from "../../src/engine/commands";
import type { EngineContent } from "../../src/engine/rules/types";
import type { EntityId, GameState } from "../../src/engine/state/state";

/**
 * GDD 11.5 の閾値付き想起リスク判断が**実際にブロックした** 1 件(検収条件の
 * ログ証跡)。ラベルだけの bot にしないため、判断が発生しなかった tick には
 * 何も積まない(=「素通り」はログに現れない)。
 */
export interface RecallGuardLogEntry {
  readonly tick: number;
  readonly botId: string;
  readonly residentId: EntityId;
  /** ブロックの根拠になった「未成文の唯一保持技術」(techId 昇順・1 件以上)。 */
  readonly techIds: readonly EntityId[];
  /** ブロックした行為の種別(GDD 11.5「過酷業務・派遣に回さない」の 2 つ)。 */
  readonly action: "harshAssignment" | "dispatch";
}

/** 1 回の意思決定(1 bot・1 tick ぶん)の結果。state は一切変更しない(純関数)。 */
export interface StrategyDecision {
  /** この意思決定で発行するコマンド列(適用順。列内の資源/枠の競合は bot 側で解決済み)。 */
  readonly commands: readonly Command[];
  /** この意思決定中に想起リスクガードが実際にブロックした件(GDD 11.5)。 */
  readonly recallGuardLog: readonly RecallGuardLogEntry[];
}

/** 5戦略bot 共通のインターフェース(M36)。 */
export interface StrategyBot {
  readonly id: string;
  /** 意思決定を呼ぶ間隔(tick)。sim/bots(先行計測)と同じ「日次呼び出し」を既定とする。 */
  readonly intervalTicks: number;
  /**
   * 次の一手を決める。**state と worldSeed(+tick)だけの純関数**(絶対ルール:
   * Math.random / Date.now 不使用。同一入力からは常に同一の {@link StrategyDecision})。
   */
  readonly decide: (
    state: GameState,
    content: EngineContent,
    worldSeedU32: number,
    tick: number,
  ) => StrategyDecision;
}
