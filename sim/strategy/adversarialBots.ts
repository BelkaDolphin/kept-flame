// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 敵対シナリオbot 6種 — M37 / GDD 11.6(a〜f) / 11.9
//
// M36(sim/strategy/{types,recallGuard,commonActions,bots,runStrategy}.ts)が
// 作った基盤の上に、GDD 11.6 の「毎晩必須ゲート」6種を追加する。5戦略bot と
// 同じ規律を踏襲する:
//   ・bot は **state と worldSeed(+tick)だけの純関数**(Math.random/Date.now 禁止)
//   ・engine の公開 API(commands の語彙・rules の derived 関数)だけを呼び、
//     engine 内部を再実装しない
//   ・commonActions.ts の部品(pickResearchTarget/buildFacilityCommand/
//     buildAssignmentCommands/firstEventIdForBand 等)をそのまま使う —
//     5戦略bot と経済の作法を分岐させないため
//
// 5戦略bot との違いは 1 点だけ: 5戦略bot は GDD 11.5 の想起リスクガード
// (`recallGuardBlocks`)を**必ず通す**設計だったのに対し、本ファイルの bot
// (a)(c) は**意図的にそのガードを迂回する**(GDD 11.6「低頻度エッジを決定論的に
// 強制発生させる」ことが目的であり、ガードが防ぐはずの事故をわざと起こす)。
// そのため {@link StrategyBot}/{@link StrategyDecision}(recallGuardLog 前提の型)
// をそのまま流用せず、本ファイル専用の {@link AdversarialBot}/
// {@link AdversarialDecision}(adversarialLog 前提)を新設する。
//
// ===========================================================================
// 1. 6種のログ証跡の出し方(M36 の判断ログと同じ流儀・タスク指示①)
// ===========================================================================
//   (a)(c)(d) は「実際に強制した瞬間」だけ {@link AdversarialLogEntry} を積む
//   (素通りはログに現れない・recallGuardLog と同じ規律)。
//   (b)(e)(f) は bot 自身の決定に特別なログを持たない(内容が「何もしない」
//   ことそのものだからログの対象が無い)。証跡は代わりに **state / run 結果の
//   観測**で出す(strategyBots.test.ts の「5戦略bot の戦略差」節が
//   bot 内部ログでなく metrics で実測するのと同じ形):
//     (b) 成文化ゼロのまま唯一保持者が死亡 → research entity の `loss` が立つ
//     (e) 派遣コマンドが 1 件も成立しない → 全 run で dispatchCount === 0 かつ
//         `resolveExpedition` の rescuedIds が 1 件も出ない
//     (f) computeTargetTick の戻り値そのもの(tick 差の系列)が証跡
//
// ===========================================================================
// 2. 各bot が対象にするエッジ(タスク指示①の要約。詳細はテストの doc を参照)
// ===========================================================================
//   (a) soleHolderExpeditionWipeBot — 唯一の生存保持者(未成文)を無条件で
//       idle のたびに単独チームで「deep」+「press」へ派遣する。GDD 11.5 の
//       ガードが本来ブロックする状況を**わざと**発生させ、GDD 7.4 の技術喪失
//       (境界イベント `applyTechLossOnDeath`)を踏む。
//   (b) codifyNeglectBot — 経済は他 bot と同じだが `codifyCommand` を一切
//       呼ばない。唯一保持者が寿命で死ぬまで放置すれば、成文化を怠った代償が
//       (A)/(B) いずれの lossClass でも実際に発生することを示す。
//   (c) rareHolderFastestLossBot — (a) と同じ強制手段だが、対象を
//       `lossClassOfTech === "rareIrreversible"`(GDD 7.4 の (B))の唯一保持者に
//       絞り、機会を検出した tick から確定喪失までの tick 差を証跡に残す
//       (「最速で失わせる」の実測)。
//   (d) traitConcentrationBot — trait を上限(3個・GDD 7.2)保持する住民を
//       1 チームへ集中させる。GDD 7.2 のカテゴリ上限クランプ([0.7, 1.3])が
//       実際に効くかを combatPower で検証する(下記§3の正直な開示を参照)。
//   (e) turtleNoExplorationBot — `buildDispatchCommands` を一度も呼ばない。
//       探索専用の獲得経路(GDD 7.7「探索での保護」)が完全に不活性のまま
//       run 全体を終えられるか(ソフトロックゼロ・GDD 11.4-2)を検証する。
//   (f) clockForwardExploitBot — ゲーム内判断としては経済 bot と同じだが、
//       本命の証跡は bot ではなく {@link simulateClockForwardExploitCycles}
//       (engine の {@link computeTargetTick} 公開 API を直接叩く時刻列ハーネス)
//       が出す。GDD 11.9 の 72h クランプ(`OFFLINE_CLAMP_TICK`)が実際に発火する
//       ことを示す。
//
// ===========================================================================
// 3. 正直な開示(実装前の踏査で判明した engine/content 側の制約)
// ===========================================================================
//   ・**trait は ID 昇順・重複なしが state の不変条件**
//     (`src/engine/state/update.ts` の `requireValidResidentTraits`)。よって
//     「同じ trait を3個」は構造的に作れない。GDD 11.6(d) の「最強trait3個持ち」
//     は**3個の"異なる" trait**と解釈する(要ユーザー判断・§6 で報告)。
//   ・現 content(`content/trait.json`)の 8 trait は、生産式に効く 5 ステータス
//     の乗算(mul)効果・yieldMul のいずれも**1 stat あたり高々 1 trait**しか
//     持たない(例: dexterity mul は traitArtisan のみ)。よって**生産式側の
//     「trait暴走」は現 content では構造的に発生し得ない**。一方 combatPower
//     (GDD 8.2・探索専用の派生値)は traitExplorer(×1.15)と traitStrongArm
//     (×1.2)の**2種が両方 mul で効く**ため、この 2 つを含む 3trait 構成だけが
//     実際にカテゴリ上限([0.7, 1.3]・`TRAIT_STAT_MUL_MAX_FIX`)を試す組合せに
//     なる。bot (d) はこの唯一の実在する組合せを「重要ポジ」= 探索チームへの
//     集中として扱う(要ユーザー判断・§6 で報告)。
//   ・**resident の trait 抽選(晴天漂着/探索保護での付与)は engine 未実装**
//     (`src/engine/rules/population.ts` 冒頭 §1「trait 抽選は未実装のまま
//     (意図的に持たせていない)」)。よって 3trait 住民は**通常プレイでは
//     絶対に出現しない**。bot (d) のテストは M36 の GDD-11.5 テストと同じ
//     「手で作った state を実装へ通す」流儀で前提を強制する(engine 変更なし)。
//   ・GDD 11.9 の「実時間ウィンドウ(実10分)あたりの累積 tick レート制限」は
//     `src/platform/persistence.ts` / `localStorageMirror.ts` が明記する通り
//     **未実装**(M4 時点で `src/engine/**` 変更禁止スコープ外として積み残し、
//     本タスクも同じ理由で `src/platform/**` を変更しない)。bot (f) が実際に
//     発火を証明できるのは **72h(4320 tick)クランプ**(`OFFLINE_CLAMP_TICK`・
//     engine 側に実装済みで `computeTargetTick` から観測可能)のみである。
// ---------------------------------------------------------------------------

import {
  CONCURRENT_DISPATCH_MAX,
  activeDispatchCount,
  apply,
  type Command,
  type DispatchExpeditionCommand,
} from "../../src/engine/commands";
import {
  advance,
  computeTargetTick,
  createAdvanceContext,
  OFFLINE_CLAMP_TICK,
  TICK_MS,
} from "../../src/engine/advance";
import { DISPATCH_TEAM_MAX } from "../../src/engine/rules/exploration";
import type { DistanceBand, EngineContent } from "../../src/engine/rules/types";
import { lossClassOfTech } from "../../src/engine/rules/types";
import {
  combatPowerFix,
  NEUTRAL_RESIDENT_STATS,
  resolveCombatTraitDefs,
  teamCombatPowerFix,
} from "../../src/engine/rules/stats";
import { toRaw } from "../../src/engine/fp";
import {
  entityIdFromString,
  livingResidents,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../../src/engine/state/state";
import { GAME_DAY_TICKS, worldSeedToUint32 } from "../../src/engine/stochastic";
import { createNewGameState } from "../../src/newGame";

import {
  buildAssignmentCommands,
  buildFacilityCommand,
  firstEventIdForBand,
  pickResearchTarget,
  researchCommand,
  type AssignmentPolicy,
  type BuildPolicy,
} from "./commonActions";
import { soleUncodifiedHeldTechIds } from "./recallGuard";
import { resolveStrategyContent } from "./runStrategy";

// --- 0. 経済の共通優先順(5戦略bot の「貪欲」と同一・GDD 11.6 の bot は経済を
//        争点にしないため、bots.ts の greedyBot と同じ並びに揃える) ----------

const HEARTH_DEF_ID = entityIdFromString("hearth");
const FORGE_DEF_ID = entityIdFromString("forge");
const WORKBENCH_DEF_ID = entityIdFromString("workbench");
const DEFAULT_ECONOMY_DEF_PRIORITY: readonly EntityId[] = [
  HEARTH_DEF_ID,
  WORKBENCH_DEF_ID,
  FORGE_DEF_ID,
];
const DEFAULT_BUILD_POLICY: BuildPolicy = {
  defPriority: DEFAULT_ECONOMY_DEF_PRIORITY,
  placement: "assist",
};
const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = { defPriority: DEFAULT_ECONOMY_DEF_PRIORITY };

/**
 * [M38] 強制系 bot(a)(c)(d) の対象プール。
 *
 * M37 実装は `livingIdleResidents`(= **無配属**の生存住民)を対象にしていたが、
 * 施設14種化(M58)+ [M38] の均等配属で「無配属の住民」は実 run ではほぼ常に
 * 0 人になり、敵対bot が新規ゲート run で 1 度も強制を行わなくなった
 * (実測: 夜間ゲートの adversarialLog が 6 本とも 0 件)。GDD 11.6 の趣旨は
 * 「低頻度エッジを**決定論的に強制発生**させる」ことなので、配属済みの住民も
 * 引き剥がす(engine の `explorationTeamCandidates` と同じ「非派遣の生存住民」)。
 */
function forcibleResidents(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const resident of livingResidents(state)) {
    if (resident.dispatched) continue;
    result.push(resident);
  }
  return result;
}

/** 経済(研究・建設)だけを進める共通部品。6種のうち、経済に手心を加えない bot が使う。 */
function economyCommands(state: GameState, content: EngineContent): Command[] {
  const commands: Command[] = [];
  const researchTechId = pickResearchTarget(state, content, false);
  if (researchTechId !== undefined) commands.push(researchCommand(researchTechId));
  const buildCmd = buildFacilityCommand(state, content, DEFAULT_BUILD_POLICY);
  if (buildCmd !== undefined) commands.push(buildCmd);
  return commands;
}

// --- 1. 共有の型(§1 の doc) -------------------------------------------------

/** GDD 11.6 の a〜f を機械可読に区別するタグ。 */
export type AdversarialEdgeKind =
  "soleHolderExpeditionWipe" | "rareHolderFastestLoss" | "traitStackConcentration";

/**
 * 敵対bot が「実際に強制した」瞬間のログ 1 件(recallGuardLog と同じ流儀:
 * 素通りはログに現れない)。
 */
export interface AdversarialLogEntry {
  readonly tick: number;
  readonly botId: string;
  readonly edge: AdversarialEdgeKind;
  readonly residentIds: readonly EntityId[];
  readonly techIds: readonly EntityId[];
  readonly note: string;
}

/** 1 回の意思決定の結果。state は一切変更しない(純関数・StrategyDecision と同型)。 */
export interface AdversarialDecision {
  readonly commands: readonly Command[];
  readonly adversarialLog: readonly AdversarialLogEntry[];
}

/** 敵対bot 共通のインターフェース(StrategyBot と同型・型だけ別)。 */
export interface AdversarialBot {
  readonly id: string;
  readonly intervalTicks: number;
  readonly decide: (
    state: GameState,
    content: EngineContent,
    worldSeedU32: number,
    tick: number,
  ) => AdversarialDecision;
}

// --- 2. 派遣コマンドの組み立て(§ soleHolder / rareHolder / traitConcentration
//        が共有する部品) --------------------------------------------------

/** 同一 tick 内で複数回呼んでも衝突しない派遣 ID(commonActions.ts と同型の採番)。 */
function nextAdversarialDispatchId(state: GameState, tag: string, salt: number): EntityId {
  for (let n = salt; ; n++) {
    const candidate = entityIdFromString(`dispatch${String(state.tick)}${tag}n${String(n)}`);
    if (isDispatchIdFree(state, candidate)) return candidate;
  }
}

function isDispatchIdFree(state: GameState, id: EntityId): boolean {
  if (state.entityStateById.has(id)) return false;
  for (const snapshot of state.dispatchSnapshots) {
    if (snapshot.id === id) return false;
  }
  return true;
}

/**
 * `memberIds` だけの単独/少数チームを、指定した距離帯・方針へ派遣するコマンドを
 * 組み立てる。空きが無い/content に exploration が無い/目的地が無ければ
 * undefined(呼び出し側は「今回は見送り」として扱う)。
 */
function buildForcedDispatch(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
  band: DistanceBand,
  stance: "press" | "cautious",
  tag: string,
): DispatchExpeditionCommand | undefined {
  if (content.exploration === undefined) return undefined;
  if (activeDispatchCount(state) >= CONCURRENT_DISPATCH_MAX) return undefined;
  const destinationId = firstEventIdForBand(content, band);
  if (destinationId === undefined) return undefined;
  return {
    kind: "dispatchExpedition",
    dispatchId: nextAdversarialDispatchId(state, tag, 0),
    destinationId,
    band,
    stance,
    teamResidentIds: memberIds,
  };
}

// --- 3. (a) 唯一保持者を意図的に探索へ送り全滅(GDD 11.6a) ------------------
//
// 対象エッジ: GDD 7.4 の「(A)/(B) 一回性喪失」— 生存保持者ゼロ かつ 記録ゼロで
// 技術が失われる境界(`applyTechLossOnDeath` / `applyTechLossIfOrphaned`)。
// 強制方法: 毎日、idle な「未成文の唯一保持者」(recallGuard.ts の
// `soleUncodifiedHeldTechIds` — GDD 11.5 のガードが本来なら過酷業務/派遣を
// 止める対象そのもの)を**単独チーム**で distance band `deep` + stance `press`
// へ無条件に派遣する。実 content(`content/balance.json` の exploration 帯)では
// 中立ステータスの単独チームの戦力(combatPower 基準 50)は `deep` 帯の
// 全ノード難度(event.json 実測 130〜170、R 40〜55)に対して**理論上限
// (50+55=105<130)でも届かない**ため、単独派遣は全ノード失敗が確定し、
// 負傷閾値(50)を必ず超えて脱落する(タスク報告④で実測を提示)。
// 証跡の出し方: 強制した瞬間に {@link AdversarialLogEntry} を積む
// (edge: "soleHolderExpeditionWipe")。実際に喪失が成立したかは
// テスト側が run 後の research entity の `loss` フィールドを検査する。

export const SOLE_HOLDER_WIPE_BOT_ID = "soleHolderExpeditionWipe";

function soleHolderWipeDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const adversarialLog: AdversarialLogEntry[] = [];
  const forcedResidentIds = new Set<EntityId>();

  for (const resident of forcibleResidents(state)) {
    const techIds = soleUncodifiedHeldTechIds(state, resident.id);
    if (techIds.length === 0) continue;
    const dispatchCmd = buildForcedDispatch(
      state,
      content,
      [resident.id],
      "deep",
      "press",
      "soleWipe",
    );
    if (dispatchCmd === undefined) break;
    commands.push(dispatchCmd);
    forcedResidentIds.add(resident.id);
    adversarialLog.push({
      tick,
      botId: SOLE_HOLDER_WIPE_BOT_ID,
      edge: "soleHolderExpeditionWipe",
      residentIds: [resident.id],
      techIds,
      note:
        `唯一の未成文保持者 ${resident.id}(技術 ${techIds.join(",")})を` +
        `deep/press 単独派遣へ強制(GDD 11.6a・GDD 11.5 のガードを意図的に迂回)`,
    });
  }

  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    SOLE_HOLDER_WIPE_BOT_ID,
  );
  for (const cmd of assignResult.commands) {
    if (!forcedResidentIds.has(cmd.residentId)) commands.push(cmd);
  }

  return { commands, adversarialLog };
}

export const soleHolderExpeditionWipeBot: AdversarialBot = {
  id: SOLE_HOLDER_WIPE_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: soleHolderWipeDecide,
};

// --- 4. (c) (B)レア保持者を最速で失わせる(GDD 11.6c) ------------------------
//
// 対象エッジ: GDD 7.4 (B) rareIrreversible の**永久喪失**
// (`research.loss.irreversible === true`)。(a) との違いは対象の絞り込みだけ
// (`lossClassOfTech(content, techId) === "rareIrreversible"`)で、強制手段は
// 完全に共有する({@link buildForcedDispatch} を同じ引数で呼ぶ)。
// 証跡の出し方: (a) と同じログ形に加え、note に「機会を検出した tick」を残す
// ことで、テスト側が「検出 tick → 確定喪失 tick」の差(=最速で失わせるまでの
// 実測 tick 数)を計算できるようにする。

export const RARE_HOLDER_FASTEST_LOSS_BOT_ID = "rareHolderFastestLoss";

function soleUncodifiedRareHeldTechIds(
  state: GameState,
  content: EngineContent,
  residentId: EntityId,
): readonly EntityId[] {
  return soleUncodifiedHeldTechIds(state, residentId).filter(
    (techId) => lossClassOfTech(content, techId) === "rareIrreversible",
  );
}

function rareHolderFastestLossDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const adversarialLog: AdversarialLogEntry[] = [];
  const forcedResidentIds = new Set<EntityId>();

  for (const resident of forcibleResidents(state)) {
    const techIds = soleUncodifiedRareHeldTechIds(state, content, resident.id);
    if (techIds.length === 0) continue;
    const dispatchCmd = buildForcedDispatch(
      state,
      content,
      [resident.id],
      "deep",
      "press",
      "rareWipe",
    );
    if (dispatchCmd === undefined) break;
    commands.push(dispatchCmd);
    forcedResidentIds.add(resident.id);
    adversarialLog.push({
      tick,
      botId: RARE_HOLDER_FASTEST_LOSS_BOT_ID,
      edge: "rareHolderFastestLoss",
      residentIds: [resident.id],
      techIds,
      note:
        `(B)rareIrreversible の唯一の未成文保持者 ${resident.id}(技術 ${techIds.join(",")})を` +
        `tick ${String(tick)} 検出直後に deep/press 単独派遣へ強制(GDD 11.6c・最速喪失)`,
    });
  }

  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    RARE_HOLDER_FASTEST_LOSS_BOT_ID,
  );
  for (const cmd of assignResult.commands) {
    if (!forcedResidentIds.has(cmd.residentId)) commands.push(cmd);
  }

  return { commands, adversarialLog };
}

export const rareHolderFastestLossBot: AdversarialBot = {
  id: RARE_HOLDER_FASTEST_LOSS_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: rareHolderFastestLossDecide,
};

// --- 5. (b) 成文化を全サボり(GDD 11.6b) ------------------------------------
//
// 対象エッジ: (a)/(c) と同じ「一回性喪失」境界だが、強制手段が違う——
// 積極的な派遣ではなく**単なる無為**(`codifyCommand` を一度も呼ばない)。
// 経済は他 bot と同一(`economyCommands` + 通常配属)。証跡は bot 内部ログでは
// なく、run 後に research entity の `loss` を検査することで出す(§1 の doc)。
// 唯一保持者が寿命(GDD 7.5)で死ぬまで**放置するだけ**で喪失が発生することを
// 示すのが目的なので、テストは「寿命が近い唯一保持者」を手で作った state に
// 対して本 bot を走らせる(M36 の GDD-11.5 テストと同じ「手で作った state」流儀)。

export const CODIFY_NEGLECT_BOT_ID = "codifyNeglect";

function codifyNeglectDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    CODIFY_NEGLECT_BOT_ID,
  );
  commands.push(...assignResult.commands);
  // GDD 11.6(b): `codifyCommand` を意図的に一度も呼ばない。
  return { commands, adversarialLog: [] };
}

export const codifyNeglectBot: AdversarialBot = {
  id: CODIFY_NEGLECT_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: codifyNeglectDecide,
};

// --- 6. (d) 最強trait3個持ちを重要ポジ集中(GDD 11.6d・trait暴走検出) --------
//
// 対象エッジ: GDD 7.2 のカテゴリ上限クランプ(`TRAIT_STAT_MUL_MAX_FIX` = 1.3)。
// §3 の正直な開示のとおり、現 content で 2 trait が同じ派生値(combatPower)を
// 乗算で押し上げるのは `traitExplorer`(×1.15)と`traitStrongArm`(×1.2)の
// 組合せだけである。本 bot は traitIds 上限(3個)を持つ住民を検出したら、
// 最大 {@link DISPATCH_TEAM_MAX} 名まで 1 チームへまとめ、探索へ「集中」させる
// (=「重要ポジ」を探索チームの意)。強制した瞬間に、そのチームの合計 combatPower
// (クランプ込みの実測値)をログへ残す。
// 証跡の出し方: ログの note に実測 raw 値を残すほか、テスト側が
// `combatPowerFix` を直接呼んで「クランプが無ければ届いたはずの値」との差分を
// 数値で固定する(タスク報告①)。

export const TRAIT_CONCENTRATION_BOT_ID = "traitConcentration";

/** GDD 7.2 の trait 保持上限(住民 1 人あたり)。 */
export const MAX_TRAITS_PER_RESIDENT_HELD = 3;

function traitConcentrationDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const adversarialLog: AdversarialLogEntry[] = [];
  const forcedResidentIds = new Set<EntityId>();

  const maxed = forcibleResidents(state).filter(
    (resident) => resident.traitIds.length === MAX_TRAITS_PER_RESIDENT_HELD,
  );
  if (maxed.length > 0) {
    const team = maxed.slice(0, DISPATCH_TEAM_MAX);
    const dispatchCmd = buildForcedDispatch(
      state,
      content,
      team.map((resident) => resident.id),
      "near",
      "cautious",
      "concentrate",
    );
    if (dispatchCmd !== undefined) {
      commands.push(dispatchCmd);
      for (const resident of team) forcedResidentIds.add(resident.id);
      const memberPowers = team.map((resident) =>
        combatPowerFix(
          resident.stats ?? NEUTRAL_RESIDENT_STATS,
          resolveCombatTraitDefs(resident.traitIds, content.traitDefs),
        ),
      );
      const totalPowerRaw = toRaw(teamCombatPowerFix(memberPowers));
      adversarialLog.push({
        tick,
        botId: TRAIT_CONCENTRATION_BOT_ID,
        edge: "traitStackConcentration",
        residentIds: team.map((resident) => resident.id),
        techIds: [],
        note:
          `3trait住民${String(team.length)}名を1チームへ集中(合計戦力raw=${String(totalPowerRaw)}・` +
          `GDD 11.6d・trait暴走検出)`,
      });
    }
  }

  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    TRAIT_CONCENTRATION_BOT_ID,
  );
  for (const cmd of assignResult.commands) {
    if (!forcedResidentIds.has(cmd.residentId)) commands.push(cmd);
  }

  return { commands, adversarialLog };
}

export const traitConcentrationBot: AdversarialBot = {
  id: TRAIT_CONCENTRATION_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: traitConcentrationDecide,
};

// --- 7. (e) 探索を一切行わない turtle bot(GDD 11.6e) -----------------------
//
// 対象エッジ: GDD 7.7「探索での保護」(`resolveExpedition` の rescuedIds)が
// 完全に不活性なまま run を終えられるか(=探索必須材の設計検証。探索由来の
// 獲得経路がゼロでもソフトロックしない設計であることの確認・GDD 11.4-2)。
// 強制方法: `buildDispatchCommands` を一度も呼ばない(経済は他 bot と同一)。
// 証跡の出し方: bot 内部ログではなく、run 後の
// `dispatchCount === 0` かつ実際に `resolveExpedition` が 1 度も走らなかった
// こと(dispatchSnapshots が常に空)をテスト側が確認する。

export const TURTLE_BOT_ID = "turtleNoExploration";

function turtleDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    TURTLE_BOT_ID,
  );
  commands.push(...assignResult.commands);
  // GDD 11.6(e): `buildDispatchCommands` を意図的に一度も呼ばない。
  return { commands, adversarialLog: [] };
}

export const turtleBot: AdversarialBot = {
  id: TURTLE_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: turtleDecide,
};

// --- 8. (f) システムクロック前進exploit再現bot(GDD 11.6f / 11.9) -----------
//
// GDD 11.6(f) が要求する「bot」としての体裁(経済判断)は他 bot と同一にしてあ
// るが、本命の証跡は decide() ではなく {@link simulateClockForwardExploitCycles}
// が担う(§3 の正直な開示のとおり、クロック前進 exploit は「時刻入力」の話で
// あって「ゲーム内の意思決定」の話ではないため)。

export const CLOCK_FORWARD_EXPLOIT_BOT_ID = "clockForwardExploit";

function clockForwardExploitDecide(
  state: GameState,
  content: EngineContent,
  _worldSeedU32: number,
  tick: number,
): AdversarialDecision {
  const commands: Command[] = economyCommands(state, content);
  const assignResult = buildAssignmentCommands(
    state,
    content,
    DEFAULT_ASSIGNMENT_POLICY,
    tick,
    CLOCK_FORWARD_EXPLOIT_BOT_ID,
  );
  commands.push(...assignResult.commands);
  return { commands, adversarialLog: [] };
}

export const clockForwardExploitBot: AdversarialBot = {
  id: CLOCK_FORWARD_EXPLOIT_BOT_ID,
  intervalTicks: GAME_DAY_TICKS,
  decide: clockForwardExploitDecide,
};

/** 1 サイクル(「時計を進めて再起動→保存→また進める」の 1 反復)ぶんの記録。 */
export interface ClockForwardExploitCycleLog {
  readonly cycle: number;
  /** このサイクルの起点 tick(= 前サイクルの `grantedTickDelta` を適用した後)。 */
  readonly startTick: number;
  /** exploit が主張する経過実時間(ms)。巨大なほど「攻撃」として悪質。 */
  readonly attemptedElapsedMs: number;
  /** クランプ前の tick 差(`floor(ms / TICK_MS)`。攻撃者が得たかった量)。 */
  readonly attemptedTickDelta: number;
  /** engine が実際に許した tick 差(`computeTargetTick` の戻り値から逆算)。 */
  readonly grantedTickDelta: number;
  /** `computeTargetTick` が返した目標 tick そのもの。 */
  readonly targetTick: number;
}

/**
 * GDD 11.9 のクロック前進 exploit(「クロックを進めて再起動→保存→また進める」)
 * を、engine の公開 API({@link computeTargetTick})だけを通して再現する。
 *
 * 1 サイクル = 「システムクロックを `forwardMsPerCycle` ぶん進める(=経過実時間
 * を巨大に主張する)→ その主張のまま advance → 結果の tick を新しい起点にして
 * 保存/再起動する」。exploit が有効なら本来無限に tick を稼げるはずだが、
 * engine 側の 72h クランプ(`OFFLINE_CLAMP_TICK` = 4320 tick・
 * `scheduler.ts` の `clampOfflineTickDelta`)が {@link computeTargetTick} の
 * 内部で必ず掛かるため、**攻撃者がどれだけ巨大な経過時間を主張しても
 * 1 サイクルあたり `OFFLINE_CLAMP_TICK` 以上は絶対に得られない**ことを
 * 実測として固定する(タスク報告④)。
 *
 * 本ハーネスは GameState を 1 つも作らない(tick 算出は state と独立な純関数・
 * `advance.ts` §1)。よって Math.random/Date.now は 1 つも使わず、
 * `computeTargetTick` 自体が engine の決定論契約(state 非依存の純関数)を
 * そのまま体現する。
 */
export function simulateClockForwardExploitCycles(
  startTick: number,
  cycles: number,
  forwardMsPerCycle: number,
): readonly ClockForwardExploitCycleLog[] {
  const log: ClockForwardExploitCycleLog[] = [];
  let tick = startTick;
  for (let cycle = 0; cycle < cycles; cycle++) {
    const targetTick = computeTargetTick(tick, forwardMsPerCycle);
    const grantedTickDelta = targetTick - tick;
    const attemptedTickDelta = Math.floor(forwardMsPerCycle / TICK_MS);
    log.push({
      cycle,
      startTick: tick,
      attemptedElapsedMs: forwardMsPerCycle,
      attemptedTickDelta,
      grantedTickDelta,
      targetTick,
    });
    // 「保存して再起動する」= 次サイクルの起点を今回の到達 tick にする。
    tick = targetTick;
  }
  return log;
}

export { OFFLINE_CLAMP_TICK, TICK_MS };

/** GDD 11.6 の a〜f 一覧(記載順)。 */
export const ADVERSARIAL_BOTS: readonly AdversarialBot[] = [
  soleHolderExpeditionWipeBot,
  codifyNeglectBot,
  rareHolderFastestLossBot,
  traitConcentrationBot,
  turtleBot,
  clockForwardExploitBot,
];

// --- 9. 実行ハーネス(runStrategy.ts の runStrategyBot と同型・GDD 11.4-5) ---

/** {@link runAdversarialBotFrom} の結果。 */
export interface AdversarialRunResult {
  readonly state: GameState;
  readonly adversarialLog: readonly AdversarialLogEntry[];
  readonly rejectedCommandCount: number;
}

/**
 * 任意の起点 state から敵対bot を走らせる(`runStrategyBot` と同じループ構造。
 * 違いは「起点 state を `createNewGameState` で作らず、呼び出し側が渡す」点
 * だけ)。GDD 11.6 の各エッジは「手で作った state」から強制するのが自然な
 * ものが多い(M36 の GDD-11.5 テストと同じ理由)ため、本関数はブートストラップ
 * を持たない汎用形にしてある。大移動(exodus)は扱わない(敵対bot の対象外)。
 */
export function runAdversarialBotFrom(
  state: GameState,
  content: EngineContent,
  bot: AdversarialBot,
  worldSeedU32: number,
  totalTicks: number,
): AdversarialRunResult {
  let s = state;
  let ctx = createAdvanceContext(s, content);
  const targetTick = s.tick + totalTicks;
  const adversarialLog: AdversarialLogEntry[] = [];
  let rejectedCommandCount = 0;
  let cursor = s.tick;

  while (cursor < targetTick) {
    const boundary = Math.min(cursor + bot.intervalTicks, targetTick);
    s = advance(s, ctx, boundary);
    cursor = s.tick;
    if (cursor >= targetTick) break;

    const decision = bot.decide(s, content, worldSeedU32, cursor);
    adversarialLog.push(...decision.adversarialLog);

    let placementChanged = false;
    for (const command of decision.commands) {
      const result = apply(s, content, command);
      if (!result.ok) {
        rejectedCommandCount++;
        continue;
      }
      s = result.state;
      if (
        command.kind === "placeFacility" ||
        command.kind === "demolishFacility" ||
        command.kind === "upgradeFacility"
      ) {
        placementChanged = true;
      }
    }
    if (placementChanged) ctx = createAdvanceContext(s, content);
  }

  return { state: s, adversarialLog, rejectedCommandCount };
}

/** [M37] sim 用の固定 algoVersion(`runStrategy.ts` の `SIM_ALGO_VERSION` と同じ理由)。 */
const SIM_ALGO_VERSION = 1;

/**
 * 実 content(`resolveStrategyContent`)で新規ゲームを起こしてから敵対bot を
 * 走らせる(turtle bot(e)のような「長い実プレイ」観測に使う。強制系(a/b/c/d)
 * は手で作った state を直接 {@link runAdversarialBotFrom} へ渡すほうが素直
 * なので、本関数は使わない)。
 */
export function runAdversarialBotAsNewGame(
  bot: AdversarialBot,
  totalTicks: number,
  worldSeed?: string,
): AdversarialRunResult & { readonly content: EngineContent } {
  const content = resolveStrategyContent();
  const state =
    worldSeed === undefined
      ? createNewGameState(content, { algoVersion: SIM_ALGO_VERSION })
      : createNewGameState(content, { algoVersion: SIM_ALGO_VERSION, worldSeed });
  const worldSeedU32 = worldSeedToUint32(state.worldSeed);
  const result = runAdversarialBotFrom(state, content, bot, worldSeedU32, totalTicks);
  return { ...result, content };
}
