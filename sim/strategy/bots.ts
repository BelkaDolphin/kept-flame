// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 5戦略bot — M36 / GDD 11.4-1 / 11.5 / 13.1
//
// 5本(貪欲/研究優先/探索優先/配置戦略違い/成文化優先)は全て
// {@link sim/strategy/commonActions.ts} の同じ部品を組み合わせるだけで書かれて
// おり、bot 固有のロジックは「どの施設定義を優先するか」「研究をクリティカル
// パス優先にするか」「成文化を能動的に行うか」「探索をどれだけ積極的に行うか」
// という**方針(policy)の差**に閉じ込めてある(assist モジュールの qualityRatio
// と同じ「1 個のパラメータで戦略を連続的に変える」設計思想)。
//
// **全 bot が {@link recallGuardBlocks}(GDD 11.5)を共有する**(commonActions.ts
// の `buildAssignmentCommands` / `buildDispatchCommands` 経由)。よって
// 「貪欲だから何も気にしない」ような bot でも、士気<40 の唯一保持者は過酷業務
// にも派遣にも回らない — GDD 11.5 が要求する「ラベルだけの bot にしない」の
// 実装上の担保はここにある。
//
// 各 bot の戦略差(観測可能な不等式。詳細は M36 タスク報告を参照):
//   ・研究優先 は貪欲よりクリティカルパス(GDD 5.1)の到達が速い
//     (`pickResearchTarget` の `preferCriticalPathResearch=true` が
//     分岐 tech への寄り道を避ける)
//   ・探索優先 は貪欲より派遣本数が多い(build/assignment を hearth 1 種に
//     絞り、住民を待機させて探索へ回す・stance も press で積極策)
//   ・配置戦略違い は貪欲と経済方針は同一だが、施設配置だけ M26 アシスト
//     ではなく素朴な first-fit(`naivePlacementCell`)を使うため
//     `boardOutputScore` が貪欲より低くなる
//   ・成文化優先 は貪欲と同じ経済方針だが、貪欲が一切行わない成文化
//     (`codify: false`)を毎 tick 能動的に行う
// ---------------------------------------------------------------------------

import { CONCURRENT_DISPATCH_MAX, type Command } from "../../src/engine/commands";
import type { EngineContent } from "../../src/engine/rules/types";
import { entityIdFromString, type GameState } from "../../src/engine/state/state";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";
import {
  buildAssignmentCommands,
  buildDispatchCommands,
  buildFacilityCommand,
  codifyCommand,
  pickResearchTarget,
  researchCommand,
  type AssignmentPolicy,
  type BuildPolicy,
  type DispatchPolicy,
} from "./commonActions";
import type { RecallGuardLogEntry, StrategyBot, StrategyDecision } from "./types";

const HEARTH_DEF_ID = entityIdFromString("hearth");
const FORGE_DEF_ID = entityIdFromString("forge");
const WORKBENCH_DEF_ID = entityIdFromString("workbench");

/** 5戦略bot 共通の方針の束。bot 間の差はこのオブジェクトの中身だけに閉じる。 */
interface BotPolicies {
  readonly preferCriticalPathResearch: boolean;
  readonly build: BuildPolicy;
  readonly assignment: AssignmentPolicy;
  readonly codifyActively: boolean;
  readonly dispatch: DispatchPolicy;
}

/** 共通の意思決定手順(§ 冒頭の doc)。全 bot がこの 1 関数を通る。 */
function decideGeneric(
  botId: string,
  policies: BotPolicies,
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): StrategyDecision {
  const commands: Command[] = [];
  const recallGuardLog: RecallGuardLogEntry[] = [];

  const researchTechId = pickResearchTarget(state, content, policies.preferCriticalPathResearch);
  if (researchTechId !== undefined) commands.push(researchCommand(researchTechId));

  const buildCmd = buildFacilityCommand(state, content, policies.build);
  if (buildCmd !== undefined) commands.push(buildCmd);

  const assignResult = buildAssignmentCommands(state, content, policies.assignment, tick, botId);
  commands.push(...assignResult.commands);
  recallGuardLog.push(...assignResult.recallGuardLog);

  if (policies.codifyActively) {
    const codifyCmd = codifyCommand(state, content, tick);
    if (codifyCmd !== undefined) commands.push(codifyCmd);
  }

  const dispatchResult = buildDispatchCommands(state, content, tick, policies.dispatch, botId);
  commands.push(...dispatchResult.commands);
  recallGuardLog.push(...dispatchResult.recallGuardLog);

  return { commands, recallGuardLog };
}

function makeStrategyBot(id: string, policies: BotPolicies): StrategyBot {
  return {
    id,
    intervalTicks: GAME_DAY_TICKS,
    decide: (state, content, worldSeedU32, tick) =>
      decideGeneric(id, policies, state, content, worldSeedU32, tick),
  };
}

// --- 1. 貪欲(GDD 11.4-1 「貪欲」) -------------------------------------------
//
// 建設・配属は「暖(hearth)→研究(workbench)→過酷(forge)」の優先順で空きを
// 埋めるだけの素朴な貪欲。研究対象は ID 昇順(= 何も考えず着手できるものから
// 着手する)。成文化は一切能動的に行わない(=「貪欲で目先の産出だけを追い、
// 知識保全を顧みない」bot。GDD 11.4-11「貪欲bot が唯一/レア保持者を派遣する
// 頻度」の観測対象として最も緩い設定であり、それでも GDD 11.5 のガードだけは
// 効く、という構図を担う)。

export const greedyBot: StrategyBot = makeStrategyBot("greedy", {
  preferCriticalPathResearch: false,
  build: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID], placement: "assist" },
  assignment: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID] },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
});

// --- 2. 研究優先(GDD 11.4-1「研究優先」) ------------------------------------
//
// `pickResearchTarget(..., preferCriticalPath=true)` がクリティカルパス
// (GDD 5.1)上の未着手 tech を最優先で選ぶ(`beginResearch` は選択を常に
// 上書きするので、分岐 tech が進行中でも割り込む)。建設・配属も workbench
// (研究産出)を最優先にし、研究点の供給そのものを厚くする。

export const researchFirstBot: StrategyBot = makeStrategyBot("researchFirst", {
  preferCriticalPathResearch: true,
  build: { defPriority: [WORKBENCH_DEF_ID, HEARTH_DEF_ID, FORGE_DEF_ID], placement: "assist" },
  assignment: { defPriority: [WORKBENCH_DEF_ID, HEARTH_DEF_ID, FORGE_DEF_ID] },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
});

// --- 3. 探索優先(GDD 11.4-1「探索優先」) ------------------------------------
//
// 建設・配属は forge(過酷業務)を外した hearth/workbench の 2 種に絞る
// (最低限の薪維持と研究の芽は残すが過酷業務は避ける)。差の本体は探索側:
// 派遣枠を毎 tick 上限まで狙い(`maxNewDispatchesPerTick = CONCURRENT_DISPATCH_MAX`)、
// 3 距離帯を巡回(`bands`)、待機プールの温存もしない(`minIdlePoolSlack: 0`)、
// 方針も強行(`press`)側に倒す(GDD 8.3)。**探索の候補プールは配属済みの住民も
// 含む**(`dispatchCandidates` は「非派遣」だけを見る・GDD 8.1)ので、本 bot は
// 施設で働いている住民も気にせず引き剥がして送り出す — これが貪欲より
// 派遣本数が明確に多くなる理由(タスク報告の実測値を参照)。

export const explorationFirstBot: StrategyBot = makeStrategyBot("explorationFirst", {
  preferCriticalPathResearch: false,
  build: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID], placement: "assist" },
  assignment: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID] },
  codifyActively: false,
  dispatch: {
    bands: ["near", "far", "deep"],
    teamSize: 2,
    maxNewDispatchesPerTick: CONCURRENT_DISPATCH_MAX,
    minIdlePoolSlack: 0,
    stance: "press",
  },
});

// --- 4. 配置戦略違い(GDD 11.4-1「配置戦略違い」) ----------------------------
//
// 経済方針(建設順・配属順・研究順・探索方針)は貪欲と完全に同一。**唯一の差は
// 建設時の配置ヒューリスティック**: M26 推奨配置アシスト
// (`suggestPlacementsAvoidingRubble`)を使わず、素朴な first-fit
// (`naivePlacementCell` = セル番号昇順で最初に置ける場所)を使う。同じ施設数を
// 建てても隣接乗数を考慮しない分だけ `boardOutputScore` が貪欲より低くなる
// はず、という比較が本 bot の存在理由(タスク報告の実測値を参照)。

export const placementVariantBot: StrategyBot = makeStrategyBot("placementVariant", {
  preferCriticalPathResearch: false,
  build: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID], placement: "naive" },
  assignment: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID] },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
});

// --- 5. 成文化優先(GDD 11.4-1「成文化優先」) --------------------------------
//
// 経済方針は貪欲と完全に同一。**唯一の差は `codifyActively: true`** —
// 候補(解禁済み・未成文・生存保持者あり)が 1 件でもあれば、単一キューが
// 空き次第すぐに M27 アシスト(`suggestCodification`)の先頭を着手する。
// 貪欲が 0 件のまま推移しうるのに対し、本 bot は記録の完成本数
// (`completedRecords`)が明確に増える、という比較が存在理由。

export const codifyFirstBot: StrategyBot = makeStrategyBot("codifyFirst", {
  preferCriticalPathResearch: false,
  build: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID], placement: "assist" },
  assignment: { defPriority: [HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID] },
  codifyActively: true,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
});

/** 5戦略bot 一覧(ID 昇順ではなく GDD 11.4-1 の記載順)。 */
export const STRATEGY_BOTS: readonly StrategyBot[] = [
  greedyBot,
  researchFirstBot,
  explorationFirstBot,
  placementVariantBot,
  codifyFirstBot,
];
