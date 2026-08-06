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
//     (`pickResearchTargets` の `preferCriticalPath=true` が
//     分岐 tech への寄り道を避けて選択を CP tech へ向ける。[Phase A] 以降は
//     バックログの積み方は他 bot と共通で、選択の向け方だけが差になる)
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
import { fieldBlockedResearches } from "../../src/engine/rules/research";
import type { EngineContent } from "../../src/engine/rules/types";
import { entityIdFromString, type EntityId, type GameState } from "../../src/engine/state/state";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";
import {
  anyResourceNearingCapacity,
  buildAssignmentCommands,
  buildBedCommand,
  buildDispatchCommands,
  buildFacilityCommand,
  canPlaceFacilityDef,
  buildFieldRequirementStaffingCommand,
  buildReclaimCommand,
  buildReclaimCommandForFacility,
  buildWarehouseCommand,
  codifyCommand,
  currentResearchTechId,
  fieldFacilityIdsNeedingConstruction,
  fieldFacilityIdsNeedingStaffing,
  unstaffedCriticalProducerDefIds,
  pickResearchTargets,
  researchCommand,
  stateWithCellReclaimed,
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

  // [Phase A] 1 日 1 本固定をやめ、その日 reachable な tech を全部バックログへ
  // 積む(§0 冒頭の doc・commonActions.ts `pickResearchTargets`)。研究点を
  // 実際に受け取る対象(選択)は従来と同じ規則で決まる 1 本のまま。
  const researchTechIds = pickResearchTargets(state, content, policies.preferCriticalPathResearch);
  for (const techId of researchTechIds) commands.push(researchCommand(techId));

  // [Phase A] 「研究予定 tech」= 今日新たに選択された主対象、無ければ現在
  // 選択中の 1 本(`currentResearchTechId`)。その fieldRequirement が要求する
  // 施設(commonActions.ts §4b)を先回りで建設・配属する。M67(engine 側の
  // fieldRequirement 実効化)が入っても explorationFirst の forge 回避
  // (§3 冒頭の doc)で bot が恒久停止しないための先回り(台帳v20 必-5)。
  // 対象は常に高々 1 本(§4b の doc の教訓)。まだ何も研究していない run では
  // undefined で建設側の優先順は素通り(= 従来の policies.build と 1 bit も
  // 違わない)。
  const primaryResearchTechId =
    researchTechIds.length > 0
      ? researchTechIds[researchTechIds.length - 1]
      : currentResearchTechId(state);
  // [Phase D] **実地要件で実際に止まっている研究**を最優先の対象に足す。
  // Phase B までは「今日バックログへ積んだ tech(researchTechIds)」が空でない
  // 限りそちらしか見なかったため、いったん `beginResearch` された tech は
  // 「未着手 tech の一覧」から外れ、その要求施設が建設・配属の対象から
  // 落ちていた。結果、techSmelting を着手した当日に forge を建てそこねると
  // (費用不足 / 2×1 の空きなし)、他の reachable tech が尽きるまで forge が
  // 建たない ——実測 explorationFirst/nightly-b は day 8 で techSmelting を
  // 着手しながら forge の建設が day 36 まで遅れ、E3 到達が 37 日になっていた。
  const fieldBlockedTechIds = fieldBlockedResearches(state, content).map(
    (research) => research.techId,
  );
  const fieldRequirementTechIds =
    primaryResearchTechId === undefined
      ? fieldBlockedTechIds
      : [...fieldBlockedTechIds, primaryResearchTechId];
  // [Phase B / M67] **建設側だけ**は「今日バックログへ積んだ tech 全部」を見る
  // (配属側は Phase A のとおり主対象 1 本 + [Phase D] 実地要件で止まっている本数)。
  // M67 で実地要件が実効化すると、主対象になってから慌てて建て始める bot
  // (研究優先)は forge の建設が数日遅れ、壁テック到達が貪欲より遅くなる
  // (実測: E2/E3 で逆転)。建設側の差し込みは既存就労者を奪わない
  // (Phase A §4b の doc)ので、対象を広げても Phase A が踏んだ構造ソフトロックは
  // 起きない。
  const fieldFacilityIdsToBuild = fieldFacilityIdsNeedingConstruction(
    [...fieldRequirementTechIds, ...researchTechIds],
    state,
    content,
  );
  const buildPolicy: BuildPolicy =
    fieldFacilityIdsToBuild.length === 0
      ? policies.build
      : {
          ...policies.build,
          defPriority: [...fieldFacilityIdsToBuild, ...policies.build.defPriority],
        };

  // 開墾は建設より先に積む(同一 tick で「開けた枠へ建てる」が成立するように)。
  // [Phase D] 実地要件が要求する施設が**幾何的に置けない**なら、しきい値
  // (`reclaimMinFreeCells`)を無視して 1 枚開墾する(commonActions.ts の
  // `canPlaceFacilityDef` の doc)。2×1 の forge は「空きセル 2 枚」でも横に
  // 隣接していなければ置けず、しきい値だけを見る開墾は走らないため、
  // 研究が実地要件で止まったまま盤面が動かない状態が何日も続く。
  // [Phase D] **倉庫(2×2)にも同じ手当てをする**。Phase A の白眉「盤面に
  // 2×2 の空きが 1 基ぶんしか無いのであふれ検知をいくら鋭くしても 2 棟目が
  // 建たない」は、開墾のしきい値が 1×1 の空き枚数しか見ないことの帰結である。
  // あふれが接近しているのに倉庫を置けないなら、そこを開けるための開墾を
  // 1 枚走らせる(GDD 6.7 の「あふれたら倉庫を建てる」の実行可能化)。
  // 実地要件(研究の恒久停止)より優先度は下。
  const unplaceableRoomFacilityId =
    fieldFacilityIdsToBuild.find((defId) => !canPlaceFacilityDef(state, content, defId)) ??
    (anyResourceNearingCapacity(state, content) &&
    !canPlaceFacilityDef(state, content, WAREHOUSE_DEF_ID)
      ? WAREHOUSE_DEF_ID
      : undefined);
  const roomReclaimCmd =
    unplaceableRoomFacilityId === undefined
      ? undefined
      : buildReclaimCommandForFacility(state, content, unplaceableRoomFacilityId);
  const reclaimCmd =
    roomReclaimCmd ?? buildReclaimCommand(state, content, policies.reclaimMinFreeCells);
  if (reclaimCmd !== undefined) commands.push(reclaimCmd);

  // [Phase A] あふれの接近を検知したら、通常の建設候補選定より倉庫を優先する
  // (§0 冒頭の doc・commonActions.ts §3a)。1 tick 1 建設の既定は維持するため、
  // 倉庫が要らない tick だけ従来どおりの `buildFacilityCommand` を使う。
  // [Phase D] 同じ枠に寝床(commonActions.ts §3a2)を足す。順序は
  // 倉庫 → 実地要件で未着工の施設 → 寝床 → 通常。あふれは「今日作った物が
  // 消える」即時の損失、実地要件の未着工は研究の**恒久停止**、寝床は
  // 「明日以降の加入が止まる」機会損失であり、損失の重い順に並べる。
  // (寝床を実地要件より先に置くと、保護加入で人口が寝床上限に張り付き続ける
  // 探索優先 bot が毎日寝床を建て続け、forge を 1 基も建てないまま E3 未到達に
  // なる実測結果になった。)
  // [Phase D] 枠を空けるための開墾を積んだ tick は、**建設側の判断をその開墾
  // 後の盤面で行う**(commonActions.ts `stateWithCellReclaimed`)。bot の提案は
  // すべて「その tick の開始時点の state」から組み立てられ適用だけが逐次なので、
  // 素直に書くと「今あけた枠を別の 1×1 が埋めてしまう」= 開墾しても目的の
  // 施設が永遠に置けない(実測の真因)。かといって建設を 1 日休ませると、
  // 同じ経済方針の bot 同士(貪欲 / 配置戦略違い)で建設回数が食い違い、
  // GDD 11.4-1 の戦略差テストが壊れる。開墾後の盤面で建設を選べば
  // **どちらも起きない**(同じ tick に「開けて建てる」が成立する)。
  const buildState =
    roomReclaimCmd === undefined ? state : stateWithCellReclaimed(state, roomReclaimCmd.cellIndex);
  const warehouseCmd = buildWarehouseCommand(buildState, content, WAREHOUSE_DEF_ID);
  const bedCmd =
    warehouseCmd === undefined && fieldFacilityIdsToBuild.length === 0
      ? buildBedCommand(buildState, content, BED_DEF_ID)
      : undefined;
  const specialCmd = warehouseCmd ?? bedCmd;
  if (specialCmd !== undefined) {
    commands.push(specialCmd);
  } else {
    const buildCmd = buildFacilityCommand(buildState, content, buildPolicy);
    if (buildCmd !== undefined) commands.push(buildCmd);
  }

  // [Phase A] 実地要件施設は、通常配属が使わなかった**余りの住民**だけで補う
  // (commonActions.ts §4b `buildFieldRequirementStaffingCommand`)。
  const fieldFacilityIdsToStaff = fieldFacilityIdsNeedingStaffing(
    fieldRequirementTechIds,
    state,
    content,
  );
  // [Phase B / M67] 実地要件の対象が満ちていても、クリティカル資源の産出施設が
  // 無人になっていれば同じ部品で埋め直す(commonActions.ts の
  // `unstaffedCriticalProducerDefIds` の doc)。
  const staffTargets =
    fieldFacilityIdsToStaff.length > 0
      ? fieldFacilityIdsToStaff
      : unstaffedCriticalProducerDefIds(state, content);
  const fieldFacilityIdToStaff = staffTargets[0];
  // [Phase D] **研究が実地要件で実際に止まっている間だけ**、その作業場への
  // 配属を通常の均等配属より先に 1 人だけ確保する。Phase A/B は必ず均等配属を
  // 先に走らせていたため、無配属の住民がその日ぜんぶ均等配属に吸われる盤面
  // (探索優先: 保護加入で毎日 3〜4 人湧き、施設も毎日増える)では
  // **余りが構造的に 0 人**になり、forge が何日も無人のまま残った
  // (実測 explorationFirst/nightly-b: 研究が techSmelting で 6 日停止)。
  // 先に取るのは高々 1 人で、しかも研究が止まっている間だけなので、Phase A が
  // 踏んだ「均等配属の住民を恒久的に奪う」構造(hearth の永久無人化)には
  // ならない —— 要件が満ちれば翌 tick から通常の均等配属だけに戻る。
  const staffFirst = fieldBlockedTechIds.length > 0 && fieldFacilityIdsToStaff.length > 0;
  const priorityStaffing =
    staffFirst && fieldFacilityIdToStaff !== undefined
      ? buildFieldRequirementStaffingCommand(
          state,
          content,
          fieldFacilityIdToStaff,
          new Set(),
          tick,
          botId,
          true,
        )
      : undefined;
  if (priorityStaffing?.command !== undefined) {
    commands.push(priorityStaffing.command);
    recallGuardLog.push(...priorityStaffing.recallGuardLog);
  }

  // 通常の均等配属は無改変のポリシーで行う(§4b 冒頭の doc:実地要件側が
  // 優先度を割り込ませると既存施設の就労者を奪う)。
  const reservedResidentIds = new Set<EntityId>();
  if (priorityStaffing?.command !== undefined) {
    reservedResidentIds.add(priorityStaffing.command.residentId);
  }
  const assignResult = buildAssignmentCommands(
    state,
    content,
    policies.assignment,
    tick,
    botId,
    reservedResidentIds,
  );
  commands.push(...assignResult.commands);
  recallGuardLog.push(...assignResult.recallGuardLog);

  const alreadyAssignedResidentIds = new Set([
    ...reservedResidentIds,
    ...assignResult.commands.map((command) => command.residentId),
  ]);
  if (priorityStaffing === undefined && fieldFacilityIdToStaff !== undefined) {
    // [Phase B / M67] 実地要件が**実際に研究を止めている**ときだけ、無配属が
    // 居なくても配置替えで 1 人回す(commonActions.ts §4b `staffingCandidates`)。
    // 「対象施設が無人」だけを条件にすると盤面の配属が毎日入れ替わり、資源産出も
    // 研究点産出も run 後半で 0 に張り付く(実測・§4b の doc)。
    const staffing = buildFieldRequirementStaffingCommand(
      state,
      content,
      fieldFacilityIdToStaff,
      alreadyAssignedResidentIds,
      tick,
      botId,
      fieldBlockedTechIds.length > 0 || fieldFacilityIdsToStaff.length === 0,
    );
    if (staffing.command !== undefined) commands.push(staffing.command);
    recallGuardLog.push(...staffing.recallGuardLog);
  }

  if (policies.codifyActively) {
    const codifyCmd = codifyCommand(state, content, tick);
    if (codifyCmd !== undefined) commands.push(codifyCmd);
  }

  if (tick % policies.dispatchEveryTicks === 0) {
    // [Phase D] 同じ tick に配属したばかりの住民は派遣候補から外す
    // (commonActions.ts `buildDispatchCommands` の doc (b))。
    const justAssignedResidentIds = new Set(alreadyAssignedResidentIds);
    for (const command of commands) {
      if (command.kind === "assignResident") justAssignedResidentIds.add(command.residentId);
    }
    const dispatchResult = buildDispatchCommands(
      state,
      content,
      tick,
      policies.dispatch,
      botId,
      justAssignedResidentIds,
    );
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
    teamSize: 3,
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
    teamSize: 3,
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
  // [Phase A] この既定の回避は変更しない(ユーザー承認済みだが「過酷業務を
  // 避ける」という bot の戦略差自体には意味がある・台帳v20 必-5)。ただし
  // 研究予定 tech が forge/foundry を fieldRequirement で要求する tick だけ、
  // decideGeneric 側で defPriority の先頭へ一時的に差し込む(この配列自体は
  // 素通しのまま)。回避を恒久的に外すのではなく「要件時のみ建てる」を選んだ
  // 理由 = 本 bot の観測対象(GDD 11.4-1「過酷業務を避ける戦略」)を Phase A で
  // 潰さないため。
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
    teamSize: 3,
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
    teamSize: 3,
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
    teamSize: 3,
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
