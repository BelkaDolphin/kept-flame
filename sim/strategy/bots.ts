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
// 各 bot の戦略差(観測可能な不等式。詳細は M36 / M38 タスク報告を参照):
//   ・研究優先 は貪欲よりクリティカルパス(GDD 5.1)の到達が速い
//     (`pickResearchTarget` の `preferCriticalPathResearch=true` が
//     分岐 tech への寄り道を避ける)
//   ・探索優先 は貪欲より派遣本数が多い(探索本部を最優先で建て、3 距離帯を
//     巡回し、**毎日**派遣枠上限まで狙う(`dispatchEveryTicks` = 1 日)・
//     stance も press)
//   ・配置戦略違い は貪欲と経済方針は同一だが、施設配置だけ M26 アシスト
//     ではなく素朴な first-fit(`naivePlacementCell`)を使うため
//     `boardOutputScore` が貪欲より低くなる
//   ・成文化優先 は貪欲と同じ経済方針だが、貪欲が一切行わない成文化
//     (`codify: false`)を毎 tick 能動的に行う
//
// ===========================================================================
// [M38] M58(施設content 14種化)後の再検証で入れた 3 点の変更
// ===========================================================================
//   (1) **建設候補を 14 種すべてへ**(§0)。M36 は 3 種しか候補に持たず、実 run
//       の盤面は `hearth×11 + workbench×1` で固定していた(台帳v11 追-8)。
//   (2) **開墾を bot の手に入れた**(`reclaimMinFreeCells`)。`initialRubbleCells`
//       により初期の空きは 12 セルしかなく、開墾しないと 14 種を建て分けられない。
//   (3) **派遣の頻度を bot 方針にした**(`dispatchEveryTicks`)。engine の
//       `explorationTeamCandidates`(GDD 8.1)は**配属済みの住民も候補に含む**
//       ため、(1)(2) を入れた盤面では「毎日、最良の 2 名が施設から引き剥がされ、
//       翌日また同じ 2 名が同じ施設へ戻され、また引き剥がされる」定常状態に
//       なり、研究点産出が恒常的に 0 へ落ちた(実測: 貪欲が 30 ゲーム日で
//       研究 1 本・era 1 止まり / 修正後は 24 本・era 3)。探索優先だけを毎日、
//       他 4 本を 5 日おきにすることで「探索優先は派遣が多い」という M36 の
//       戦略差を保ったまま、施設労働力が枯れない。
//
//   なお `RECLAIM_MIN_FREE_CELLS` / `DISPATCH_EVERY_TICKS_*` は **bot 側の
//   ヒューリスティック定数**であり content でも engine 定数でもない(バランス
//   調整 M39〜M41 の対象ではない)。
// ---------------------------------------------------------------------------

import type { Command } from "../../src/engine/commands";
import type { EngineContent } from "../../src/engine/rules/types";
import { entityIdFromString, type EntityId, type GameState } from "../../src/engine/state/state";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";
import {
  buildAssignmentCommands,
  buildDispatchCommands,
  buildFacilityCommand,
  buildReclaimCommand,
  buildWarehouseCommand,
  codifyCommand,
  pickResearchTarget,
  researchCommand,
  type AssignmentPolicy,
  type BuildPolicy,
  type DispatchPolicy,
} from "./commonActions";
import type { RecallGuardLogEntry, StrategyBot, StrategyDecision } from "./types";

// --- 0. [M38] 施設14種の定義 ID(GDD 6.1・content/facility.json の全件) --------
//
// M36 実装は `hearth`/`workbench`/`forge` の 3 種しか候補に持たず、M58 が
// additive 追加した 11 種を実 run で一度も建てられなかった(台帳v11 追-8 の
// 申し送り)。ここで 14 種すべてを候補に載せ、**bot 差は「同数のときどれを
// 先に建てるか」= 優先順**として表現する(commonActions.ts の
// `buildFacilityCommand` は現基数が最小の候補を選ぶ)。
const HEARTH_DEF_ID = entityIdFromString("hearth");
const FORGE_DEF_ID = entityIdFromString("forge");
const WORKBENCH_DEF_ID = entityIdFromString("workbench");
const WATER_TANK_DEF_ID = entityIdFromString("waterTank");
const KITCHEN_GARDEN_DEF_ID = entityIdFromString("kitchenGarden");
const CHARCOAL_KILN_DEF_ID = entityIdFromString("charcoalKiln");
const FOUNDRY_DEF_ID = entityIdFromString("foundry");
const RESEARCH_DESK_DEF_ID = entityIdFromString("researchDesk");
const SCRIPTORIUM_DEF_ID = entityIdFromString("scriptorium");
const EXPLORATION_HQ_DEF_ID = entityIdFromString("explorationHq");
const BED_DEF_ID = entityIdFromString("bed");
const WAREHOUSE_DEF_ID = entityIdFromString("warehouse");
const WATCHTOWER_DEF_ID = entityIdFromString("watchtower");
const INFIRMARY_DEF_ID = entityIdFromString("infirmary");

/** GDD 6.1 の施設14種(content/facility.json の全 ID)。順序は各 bot が並べ替える。 */
export const ALL_FACILITY_DEF_IDS: readonly EntityId[] = [
  HEARTH_DEF_ID,
  WORKBENCH_DEF_ID,
  WATER_TANK_DEF_ID,
  KITCHEN_GARDEN_DEF_ID,
  BED_DEF_ID,
  CHARCOAL_KILN_DEF_ID,
  SCRIPTORIUM_DEF_ID,
  RESEARCH_DESK_DEF_ID,
  WAREHOUSE_DEF_ID,
  FORGE_DEF_ID,
  EXPLORATION_HQ_DEF_ID,
  WATCHTOWER_DEF_ID,
  INFIRMARY_DEF_ID,
  FOUNDRY_DEF_ID,
];

/** `head` を先頭へ引き上げた 14 種の並び(残りは {@link ALL_FACILITY_DEF_IDS} の順)。 */
function prioritized(head: readonly EntityId[]): readonly EntityId[] {
  const rest = ALL_FACILITY_DEF_IDS.filter((id) => !head.includes(id));
  return [...head, ...rest];
}

/**
 * 就労枠を持つ施設だけの配属優先順(`slots.lv1 = 0` の 4 種 —— 寝床/保管庫/
 * 見張り台/療養所 —— は配属できないので配属順には載せない)。
 */
function workablePriority(head: readonly EntityId[]): readonly EntityId[] {
  const nonWorkable = [BED_DEF_ID, WAREHOUSE_DEF_ID, WATCHTOWER_DEF_ID, INFIRMARY_DEF_ID];
  return prioritized(head).filter((id) => !nonWorkable.includes(id));
}

/**
 * [M38] 開墾のしきい値: 1×1 が置ける空きセルがこれを下回ったら瓦礫を 1 枚
 * 開墾する。`content/balance.json` の `initialRubbleCells` はセル 12〜47 が
 * 瓦礫なので、開墾しない bot は**盤面 12 セル固定**のまま終わる(= 14 種を
 * 建て分ける余地が構造的に無い)。
 */
const RECLAIM_MIN_FREE_CELLS = 3;

/** [M38] 探索優先 bot の派遣頻度(毎日)。 */
const DISPATCH_EVERY_TICKS_AGGRESSIVE = GAME_DAY_TICKS;
/** [M38] 他 4 本の派遣頻度(5 日おき)。tick の絶対グリッドで判定するので決定論。 */
const DISPATCH_EVERY_TICKS_CONSERVATIVE = GAME_DAY_TICKS * 5;

/** 5戦略bot 共通の方針の束。bot 間の差はこのオブジェクトの中身だけに閉じる。 */
interface BotPolicies {
  readonly preferCriticalPathResearch: boolean;
  readonly build: BuildPolicy;
  readonly assignment: AssignmentPolicy;
  readonly codifyActively: boolean;
  readonly dispatch: DispatchPolicy;
  /** 空きセルがこれを下回ったら開墾する(0 で開墾しない)。 */
  readonly reclaimMinFreeCells: number;
  /** 派遣を検討する tick 間隔([M38]・絶対グリッド `tick % n === 0` で判定)。 */
  readonly dispatchEveryTicks: number;
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

  // 開墾は建設より先に積む(同一 tick で「開けた枠へ建てる」が成立するように)。
  const reclaimCmd = buildReclaimCommand(state, content, policies.reclaimMinFreeCells);
  if (reclaimCmd !== undefined) commands.push(reclaimCmd);

  // [Phase A] あふれの接近を検知したら、通常の建設候補選定より倉庫を優先する
  // (§0 冒頭の doc・commonActions.ts §3a)。1 tick 1 建設の既定は維持するため、
  // 倉庫が要らない tick だけ従来どおりの `buildFacilityCommand` を使う。
  const warehouseCmd = buildWarehouseCommand(state, content, WAREHOUSE_DEF_ID);
  if (warehouseCmd !== undefined) {
    commands.push(warehouseCmd);
  } else {
    const buildCmd = buildFacilityCommand(state, content, policies.build);
    if (buildCmd !== undefined) commands.push(buildCmd);
  }

  const assignResult = buildAssignmentCommands(state, content, policies.assignment, tick, botId);
  commands.push(...assignResult.commands);
  recallGuardLog.push(...assignResult.recallGuardLog);

  if (policies.codifyActively) {
    const codifyCmd = codifyCommand(state, content, tick);
    if (codifyCmd !== undefined) commands.push(codifyCmd);
  }

  if (tick % policies.dispatchEveryTicks === 0) {
    const dispatchResult = buildDispatchCommands(state, content, tick, policies.dispatch, botId);
    commands.push(...dispatchResult.commands);
    recallGuardLog.push(...dispatchResult.recallGuardLog);
  }

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
  build: {
    defPriority: prioritized([HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID]),
    placement: "assist",
  },
  assignment: { defPriority: workablePriority([HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID]) },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
  reclaimMinFreeCells: RECLAIM_MIN_FREE_CELLS,
  dispatchEveryTicks: DISPATCH_EVERY_TICKS_CONSERVATIVE,
});

// --- 2. 研究優先(GDD 11.4-1「研究優先」) ------------------------------------
//
// `pickResearchTarget(..., preferCriticalPath=true)` がクリティカルパス
// (GDD 5.1)上の未着手 tech を最優先で選ぶ(`beginResearch` は選択を常に
// 上書きするので、分岐 tech が進行中でも割り込む)。建設・配属も workbench
// (研究産出)を最優先にし、研究点の供給そのものを厚くする。

export const researchFirstBot: StrategyBot = makeStrategyBot("researchFirst", {
  preferCriticalPathResearch: true,
  build: {
    defPriority: prioritized([
      WORKBENCH_DEF_ID,
      RESEARCH_DESK_DEF_ID,
      HEARTH_DEF_ID,
      EXPLORATION_HQ_DEF_ID,
    ]),
    placement: "assist",
  },
  assignment: {
    defPriority: workablePriority([
      WORKBENCH_DEF_ID,
      RESEARCH_DESK_DEF_ID,
      EXPLORATION_HQ_DEF_ID,
      HEARTH_DEF_ID,
    ]),
  },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
  reclaimMinFreeCells: RECLAIM_MIN_FREE_CELLS,
  dispatchEveryTicks: DISPATCH_EVERY_TICKS_CONSERVATIVE,
});

// --- 3. 探索優先(GDD 11.4-1「探索優先」) ------------------------------------
//
// 建設・配属は forge(過酷業務)を外した hearth/workbench の 2 種に絞る
// (最低限の薪維持と研究の芽は残すが過酷業務は避ける)。差の本体は探索側:
// 派遣を**毎日**検討し(他 4 本は 5 日おき)、
// 3 距離帯を巡回(`bands`)、待機プールの温存もしない(`minIdlePoolSlack: 0`)、
// 方針も強行(`press`)側に倒す(GDD 8.3)。**探索の候補プールは配属済みの住民も
// 含む**(`dispatchCandidates` は「非派遣」だけを見る・GDD 8.1)ので、本 bot は
// 施設で働いている住民も気にせず引き剥がして送り出す — これが貪欲より
// 派遣本数が明確に多くなる理由(タスク報告の実測値を参照)。

export const explorationFirstBot: StrategyBot = makeStrategyBot("explorationFirst", {
  preferCriticalPathResearch: false,
  // 過酷業務(forge/foundry)は建てない = 候補から外す(M36 と同じ思想を 14 種版へ)。
  build: {
    defPriority: prioritized([EXPLORATION_HQ_DEF_ID, HEARTH_DEF_ID, WORKBENCH_DEF_ID]).filter(
      (id) => id !== FORGE_DEF_ID && id !== FOUNDRY_DEF_ID,
    ),
    placement: "assist",
  },
  assignment: {
    defPriority: workablePriority([EXPLORATION_HQ_DEF_ID, HEARTH_DEF_ID, WORKBENCH_DEF_ID]).filter(
      (id) => id !== FORGE_DEF_ID && id !== FOUNDRY_DEF_ID,
    ),
  },
  codifyActively: false,
  dispatch: {
    bands: ["near", "far", "deep"],
    teamSize: 2,
    // [M38] M36 は `CONCURRENT_DISPATCH_MAX` + `minIdlePoolSlack: 0` で「毎日
    // 盤面から取れるだけ取る」だったが、施設14種化後の実 run ではそれが
    // **薪の産出レートを run 全域で 0 にする**(全員が毎日引き剥がされ、
    // 帰還した翌日また引き剥がされるため誰も定着しない)。ソフトロック assert
    // (GDD 11.4-2)が落ちる degenerate な盤面になるので、1 日 1 本 +
    // 待機プール 2 名温存へ緩める。それでも他 4 本(5 日おき・near のみ・
    // cautious)より派遣は明確に多い。
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "press",
  },
  reclaimMinFreeCells: RECLAIM_MIN_FREE_CELLS,
  dispatchEveryTicks: DISPATCH_EVERY_TICKS_AGGRESSIVE,
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
  build: {
    defPriority: prioritized([HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID]),
    placement: "naive",
  },
  assignment: { defPriority: workablePriority([HEARTH_DEF_ID, WORKBENCH_DEF_ID, FORGE_DEF_ID]) },
  codifyActively: false,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
  reclaimMinFreeCells: RECLAIM_MIN_FREE_CELLS,
  dispatchEveryTicks: DISPATCH_EVERY_TICKS_CONSERVATIVE,
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
  // 成文化の媒体を自前で作る: 紙 = 写字室(scriptorium)・粘土(石板)= 貯水槽(waterTank)。
  build: {
    defPriority: prioritized([
      SCRIPTORIUM_DEF_ID,
      WATER_TANK_DEF_ID,
      HEARTH_DEF_ID,
      WORKBENCH_DEF_ID,
    ]),
    placement: "assist",
  },
  assignment: {
    defPriority: workablePriority([
      SCRIPTORIUM_DEF_ID,
      WATER_TANK_DEF_ID,
      WORKBENCH_DEF_ID,
      HEARTH_DEF_ID,
    ]),
  },
  codifyActively: true,
  dispatch: {
    bands: ["near"],
    teamSize: 2,
    maxNewDispatchesPerTick: 1,
    minIdlePoolSlack: 2,
    stance: "cautious",
  },
  reclaimMinFreeCells: RECLAIM_MIN_FREE_CELLS,
  dispatchEveryTicks: DISPATCH_EVERY_TICKS_CONSERVATIVE,
});

/** 5戦略bot 一覧(ID 昇順ではなく GDD 11.4-1 の記載順)。 */
export const STRATEGY_BOTS: readonly StrategyBot[] = [
  greedyBot,
  researchFirstBot,
  explorationFirstBot,
  placementVariantBot,
  codifyFirstBot,
];
