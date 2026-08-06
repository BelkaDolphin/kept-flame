// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 探索(派遣・決定論解決・ROI)— GDD 8.1〜8.6 / 12.5-7 / M21
//
// ===========================================================================
// 1. 「派遣確定時にイベント列を丸ごとスナップショット」(GDD 8.2 / 12.5-7)
// ===========================================================================
//   GDD 12.5-7 は「探索イベント列は**派遣時点スナップショット固定(再参照
//   禁止)**」と定める。週次で content にイベントが additive 追加されても、
//   未帰還のセーブの結果は 1 bit も動いてはならない。本モジュールはこれを
//   もっとも強い形で満たす:
//
//     派遣確定コマンドが**結果まで全部**決めて `DispatchSnapshot` に焼き込み、
//     帰還 tick(GDD 11.7 段60)は「保存された結果を state へ適用するだけ」。
//
//   つまり帰還処理は content を 1 度も読まない。難度・roll・判定結果・報酬額・
//   負傷・脱落者・保護の有無まで確定値でスナップショットに載っている
//   (state.ts の {@link DispatchSnapshot})。「帰還時に再計算する」形にすると
//   content 変更の影響が未帰還セーブへ漏れる経路が必ず残るので採らない。
//
// ===========================================================================
// 2. RNG は hash アドレス方式のみ(ADR-018(1) 段階1)
// ===========================================================================
//   引くのは `hashedDrawUint32(worldSeed, "exploration", salt)` だけであり、
//   逐次ストリーム(rngState)を 1 度も進めない。salt は
//     (目的地 ID, チーム ID 列, 派遣 tick, 用途コード, ノード番号)
//   で、GDD 8.2 の `seed = hash(worldSeed, "exploration", dispatchTick,
//   teamIds, destId)` をそのまま salt 側に展開したものである。
//
//   **ADR-018(3) の段階2(逆 CDF 合成 / next-reaction)へは踏み込まない**:
//   ここで引く乱数はすべて「独立な一様サンプリング」であり、他の確率系の
//   状態(想起困難のクロック等)に依存する再サンプリングは 1 つも無い。
//   ノードごとの draw が互いに独立=順序非依存なので、生成を途中で止めても
//   残りのノードの値が変わらない(= Map 反復順にも呼び出し順にも依存しない)。
//
// ===========================================================================
// 3. 質的分岐(GDD 8.3)の MVP 縮約
// ===========================================================================
//   GDD 8.3 は各判定ノードの**直前**にプレイヤーの「撤退 / 強行」選択を置く。
//   MVP(M21)はこれを**派遣確定時に 1 度だけ選ぶ方針**({@link DispatchStance})へ
//   縮約する:
//     cautious : 累積負傷が閾値へ達した時点のノードで撤退(報酬は
//                `withdrawRewardRatio` = 半分・以降のノードは踏まない)
//     press    : 撤退しない。失敗時の負傷が `pressInjuryMul`(×1.5)
//   **[M22] ノード生成を content のイベントテーブル由来へ差し替えた。**
//   目的地 ID が `EngineContent.eventDefs` の event を指していれば、難度 / R /
//   statWeights / choices / branches はすべて content から来る({@link
//   buildDispatchSnapshot} の中の 1 分岐 = 指示された「差し替え点 1 箇所」)。
//   指していなければ M21 の手続き生成のままで、**1 bit も挙動が変わらない**。
//   choices の選択そのものは引き続き `stance` から機械的に決める(GDD 8.1
//   [2026-07-30裁定]①)—— プレイヤーへ問い返す口は探索本部 UI(M32)が要るため。
//   差し替え点は `rules/event.ts` の `selectChoiceIndex` 1 関数に閉じてある。
//   ADR-012(3) の分岐木上界(16 ノード/派遣)は、歩いた道だけを保存する現在の
//   形では高々 8 ノードで、両枝を材料化する段まで余裕がある。
//
// ===========================================================================
// 4. 全滅リスクと安全曲線(GDD 8.5)と人口下限(GDD 7.6 / 11.4-9)
// ===========================================================================
//   実際の脱落は**負傷の累積という決定論経路**で起きる:
//     判定失敗ごとに負傷が積まれ、`casualtyInjuryThreshold` を跨ぐごとに 1 名が
//     脱落する(戦力の低い順)。チーム全員が脱落すれば全滅。
//   難度は装備・編成で管理できるので「無謀を咎めるが理不尽全滅はしない曲線」
//   (GDD 8.5)になる。
//
//   **人口下限 6 の絶対保証(GDD 7.6 / 11.4-9)は探索でも破らない。** 本モジュールは
//   脱落者を自分で殺さず、scheduler へ「段70 の死亡イベント」として渡す
//   (scheduler.ts §6 の `expeditionReturn`)。段70 は既に
//   `rules/population.ts` の**死亡ゲート**(生存人口 − 1 < 下限なら死亡を次の
//   加入 tick へ延期)を通っており、memoirLog・bond 士気ペナ・技術喪失
//   (GDD 7.4)の 3 処理も同じ固定順で走る。
//   → 帰還そのものは成立し(生存者は本拠へ戻り就労できる)、下限に触れる死だけが
//     延期される。「帰還延期」ではなく「死亡延期」を選んだのは、既存の死亡
//     ゲート機構へ接続するのが唯一の絶対保証の担い手だからである(§3 of
//     rules/population.ts)。
//
// ===========================================================================
// 5. 探索での保護は晴天漂着とは別口(GDD 7.7 / 7.3)
// ===========================================================================
//   GDD 7.7 は住民の獲得経路を「初期数名 / 寝床上限内の定期加入(晴天漂着)/
//   **探索での保護** / 衛星拠点次世代」と並べる。晴天漂着(段65・絶対グリッド・
//   寝床上限内)とは別の経路であり、本モジュールは帰還 tick(段60)で加入させる。
//   保護した側の memoirLog には `explorationRescue`(GDD 7.3 の例
//   「近郊探索で△を保護した」)が積まれる。
// ---------------------------------------------------------------------------

import {
  FIX_ONE,
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromInt,
  floorDivFix,
  floorDivInt,
  mulFix,
  mulFixInt,
  subFix,
  sumFix,
  toRaw,
  type Fix,
} from "../fp";
import { DOMAIN_TAGS } from "../rng/domainTags";
import { bernoulliHit, hashedDrawUint32, saltFromId, uniformIntFromDraw } from "../stochastic";
import {
  entitiesOfKind,
  entityIdFromString,
  getDispatch,
  isAliveResident,
  livingResidents,
  requireEntity,
  type DispatchEffect,
  type DispatchNode,
  type DispatchSnapshot,
  type DispatchStance,
  type EntityId,
  type GameState,
  type RenderedLogEntry,
  type ResidentState,
} from "../state/state";
import {
  putEntity,
  setDispatchSnapshots,
  setField,
  setRenderedLogs,
  updateEntity,
} from "../state/update";
import { compareUtf16 } from "../canonicalize";
import { isCodified } from "./codify";
import { residentCombatPower } from "./combat";
import {
  applyDispatchEffect,
  buildCondContext,
  choiceAt,
  effectiveDifficultyFix,
  effectiveTeamPowerFix,
  eventDefForDestination,
  nodeInjuryGainFix,
  nodeRewardFix,
  relatedTeamPowerFix,
  renderLogTemplate,
  selectBranchIndex,
  selectChoiceIndex,
} from "./event";
import { createResidentLife } from "./lifespan";
import { appendMemoirEntry, initializeResidentMemoir } from "./memoir";
import { ARRIVAL_INITIAL_MORALE_FIX } from "./population";
import { NEUTRAL_RESIDENT_STATS } from "./stats";
import { applyCappedLumpIntake, creditWasteGain, resolveCapacityByResourceId } from "./storage";
import { heldTechIdsOf, techHoldersOf } from "./techMemory";
import {
  RulesError,
  lossClassOfTech,
  type AdvanceContext,
  type DistanceBand,
  type EngineContent,
  type EventDef,
  type EventNodeDef,
  type ExplorationBandParams,
  type ExplorationParams,
} from "./types";

// --- 0. engine 定数 ---------------------------------------------------------

/** GDD 8.1「チーム1〜4名」の下限。 */
export const DISPATCH_TEAM_MIN = 1;

/** GDD 8.1「チーム1〜4名」の上限。 */
export const DISPATCH_TEAM_MAX = 4;

/**
 * 帰還ログの保持上限(GDD 8.4「ログ保持上限 50 件、超過分は要約統計に畳む」/
 * 12.5-9)。memoirLog(`MAX_MEMOIR_ENTRIES`)と同じ折り畳み方式。
 */
export const MAX_RENDERED_LOGS = 50;

/**
 * salt の用途コード(§2)。**同じ (派遣, ノード) でも用途が違えば別の draw** に
 * なるようにするための定数であり、値そのものに意味は無い(変えると乱数列が
 * 変わる = golden vector が動く)。
 */
const SALT_PURPOSE = {
  nodeCount: 1,
  difficulty: 2,
  roll: 3,
  rescue: 4,
} as const;

/** 距離帯の表示名(帰還ログのレンダリング用・GDD 8.1)。 */
const BAND_LABEL: { readonly [K in DistanceBand]: string } = {
  near: "近郊",
  far: "遠隔",
  deep: "深部",
};

// --- 1. content パラメータの取り出し ----------------------------------------

/**
 * 探索パラメータ。content に `exploration` ブロックが無ければ undefined
 * (= 探索機構が完全に不活性・rules/types.ts の doc)。
 */
export function explorationParamsOf(content: EngineContent): ExplorationParams | undefined {
  return content.exploration;
}

/**
 * 距離帯 1 本ぶんのパラメータ。
 *
 * @throws {RulesError} content に exploration ブロックが無い場合
 */
export function bandParamsOf(content: EngineContent, band: DistanceBand): ExplorationBandParams {
  const params = content.exploration;
  if (params === undefined) {
    throw new RulesError(
      "content に balance の exploration ブロックが無いので探索できない(GDD 8.1〜8.6)",
    );
  }
  return params.byBand[band];
}

/** 探索の報酬を受け取る resource entity(state 側)。無ければ undefined。 */
export function rewardResourceEntityIdOf(
  state: GameState,
  resourceDefId: EntityId,
): EntityId | undefined {
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === resourceDefId) return resource.id;
  }
  return undefined;
}

// --- 2. チームの派生値(GDD 8.1 / 8.2) --------------------------------------

/**
 * 判定に使う「関連チーム総合力 + 装備補正」(GDD 8.2)。
 *
 * `combatPower` に装備を含めないのは二重計上を避けるため(GDD 8.2 の
 * [2026-07-29裁定])。装備補正はチーム一律の 1 段(item 未実装・rules/types.ts の
 * `equipmentBonusFix` の doc)。
 *
 * @throws {EntityLookupError} `memberIds` に住民でない ID が含まれる場合
 */
export function teamPowerWithEquipment(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
): Fix {
  const params = content.exploration;
  const equipment = params === undefined ? FIX_ZERO : params.equipmentBonusFix;
  const powers: Fix[] = [];
  for (const memberId of memberIds) {
    powers.push(residentCombatPower(requireEntity(state, memberId, "resident"), content));
  }
  return addFix(sumFix(powers), equipment);
}

/**
 * 往復所要 tick(GDD 8.1「`base_time`(距離)消費、チーム平均体力＋装備で
 * 最大 -30% 短縮」)。
 *
 * 短縮率 = `travelSpeedupMax × (チーム平均 vigor / 100)`。中立住民(vigor 50)で
 * 上限の半分、vigor 100 で上限ちょうどになる。**必ず 1 tick 以上**を返す
 * (0 にすると派遣した同 tick に帰還し、`pushAfter` の前提が崩れる)。
 *
 * @throws {RulesError} content に exploration ブロックが無い場合
 */
export function travelTicksFor(
  state: GameState,
  content: EngineContent,
  band: DistanceBand,
  memberIds: readonly EntityId[],
): number {
  const params = content.exploration;
  if (params === undefined) {
    throw new RulesError("content に exploration ブロックが無いので所要時間を出せない");
  }
  const base = bandParamsOf(content, band).baseTravelTicks;
  if (memberIds.length === 0) return Math.max(1, base);

  const vigors: Fix[] = [];
  for (const memberId of memberIds) {
    const resident = requireEntity(state, memberId, "resident");
    vigors.push((resident.stats ?? NEUTRAL_RESIDENT_STATS).vigor);
  }
  const averageVigor = floorDivFix(sumFix(vigors), fixFromInt(memberIds.length));
  // vigor は 0〜100 スケール。100 で割って 0〜1 の比率にしてから上限を掛ける。
  const ratio = clampFix(floorDivFix(averageVigor, fixFromInt(100)), FIX_ZERO, FIX_ONE);
  const speedup = mulFix(params.travelSpeedupMaxFix, ratio);
  // 中間積 = base(<= 1e6) × speedup_raw(<= 1e6) <= 1e12 < 2^53 で厳密(fp.ts L1)。
  const cut = floorDivInt(base * toRaw(speedup), FIX_SCALE);
  return Math.max(1, base - cut);
}

// --- 3. スナップショット生成(§1・派遣確定コマンドから呼ばれる) -------------

/** {@link buildDispatchSnapshot} の入力。 */
export interface DispatchPlanInput {
  /** 新しく作る派遣の ID。 */
  readonly dispatchId: EntityId;
  /** 目的地 content の ID(M21 は不透明なラベル・§3)。 */
  readonly destinationId: EntityId;
  readonly band: DistanceBand;
  readonly stance: DispatchStance;
  /** チーム(ID 昇順・重複なし)。 */
  readonly memberIds: readonly EntityId[];
  /** 派遣を確定した tick。 */
  readonly dispatchTick: number;
}

/**
 * hash アドレス方式の draw(§2)。同じ (worldSeed, 派遣, 用途, ノード, choiceKey)
 * なら常に同じ値で、ストリーム状態を持たない。
 *
 * **[M22] `choiceKey` を salt へ足した**(ADR-007「salt=(dispatchId, nodeIndex,
 * branchId, choiceKey)」)。選択肢が違えば同じノードでも独立な乱数列になり、
 * 「慎重を選んだ場合と大胆を選んだ場合の roll が相関する」欠陥を構造的に消す。
 *
 * `choiceKey` を渡さない(= 選択肢の無い手続き生成)経路では salt 列の長さが
 * M21 と同一になるので、**既存の探索テストの数値は 1 bit も動かない**。
 * ADR-007 が併記する `branchId` は M22 では salt に入らない —— 分岐は判定の
 * **後**に cond で決まり、分岐が決まった後に引く乱数が 1 つも無いためである
 * (分岐ごとの追加抽選が入る段で足すこと。★要ユーザー判断として報告)。
 */
function drawFor(
  worldSeedU32: number,
  input: DispatchPlanInput,
  purpose: number,
  nodeIndex: number,
  choiceKey?: number,
): number {
  const salt: number[] = [
    saltFromId(input.destinationId),
    // GDD 8.2 の seed 材料 `teamIds`。ID 規則(ADR-011)は `|` を含まないので
    // 連結は曖昧にならず、並びは ID 昇順(呼び出し側が正規化済み)。
    saltFromId(input.memberIds.join("|")),
    input.dispatchTick,
    purpose,
    nodeIndex,
  ];
  if (choiceKey !== undefined) salt.push(choiceKey);
  return hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.exploration, salt);
}

/**
 * 脱落順(戦力の低い順・同値は ID 昇順)。GDD 8.5「総合力が難度を大きく下回り
 * 続けると…一部脱落」の「誰が」を決める規則であり、決定論のため全順序にする。
 */
function casualtyOrderOf(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
): readonly EntityId[] {
  const scored = memberIds.map((memberId) => ({
    id: memberId,
    power: toRaw(residentCombatPower(requireEntity(state, memberId, "resident"), content)),
  }));
  scored.sort((a, b) => (a.power !== b.power ? a.power - b.power : compareUtf16(a.id, b.id)));
  return scored.map((entry) => entry.id);
}

/**
 * 派遣確定時にイベント列と結果を丸ごと決定論生成する(§1)。**この関数の外で
 * 乱数を引かない**ことが「以後 content を再参照しない」の根拠である。
 *
 * @throws {RulesError} content に exploration ブロックが無い / パラメータが不正な場合
 * @throws {EntityLookupError} `memberIds` に住民でない ID が含まれる場合
 */
export function buildDispatchSnapshot(
  state: GameState,
  content: EngineContent,
  worldSeedU32: number,
  input: DispatchPlanInput,
): DispatchSnapshot {
  const params = content.exploration;
  if (params === undefined) {
    throw new RulesError("content に exploration ブロックが無いので派遣できない(GDD 8.1)");
  }
  const band = params.byBand[input.band];
  requireBandParams(band, input.band);

  const teamPowerFix = teamPowerWithEquipment(state, content, input.memberIds);
  // [M22] 目的地 ID が event content を指していれば、ノード列はそこから来る
  // (§3 の差し替え点はこの 1 行)。無ければ M21 の手続き生成のまま。
  const eventDef = eventDefForDestination(content, input.destinationId, input.band);
  const nodeCount =
    eventDef === undefined
      ? uniformIntFromDraw(
          drawFor(worldSeedU32, input, SALT_PURPOSE.nodeCount, 0),
          band.nodeCountMin,
          band.nodeCountMax,
        )
      : eventDef.nodes.length;
  const stanceInjuryMulFix = input.stance === "press" ? params.pressInjuryMulFix : FIX_ONE;

  const nodes: DispatchNode[] = [];
  let injuryFix = FIX_ZERO;
  let grossRewardFix = FIX_ZERO;
  let withdrawn = false;
  let failureCount = 0;

  for (let i = 0; i < nodeCount; i++) {
    // GDD 8.3 の「直前選択」。cautious は負傷が閾値へ達した時点で以降を打ち切る。
    if (
      input.stance === "cautious" &&
      toRaw(injuryFix) >= toRaw(params.withdrawInjuryThresholdFix)
    ) {
      withdrawn = true;
      break;
    }
    const nodeDef = eventDef?.nodes[i];
    // [M22] choice は判定の**前**に決まる(event.ts §2(a))。salt の choiceKey にも使う。
    const choiceIndex =
      nodeDef === undefined ? undefined : selectChoiceIndex(nodeDef, input.stance);
    const choice = nodeDef === undefined ? undefined : choiceAt(nodeDef, choiceIndex);

    const difficultyFix =
      nodeDef === undefined
        ? fixFromInt(
            uniformIntFromDraw(
              drawFor(worldSeedU32, input, SALT_PURPOSE.difficulty, i),
              band.difficultyMin,
              band.difficultyMax,
            ),
          )
        : effectiveDifficultyFix(nodeDef, choice);
    const rollRange = nodeDef === undefined ? band.rollRange : nodeDef.rollRange;
    const rollFix = fixFromInt(
      uniformIntFromDraw(
        drawFor(worldSeedU32, input, SALT_PURPOSE.roll, i, choiceIndex),
        0,
        rollRange,
      ),
    );
    // GDD 8.2: 成否 = (関連チーム総合力 + 装備補正 + seededRoll(0..R)) >= difficulty
    // event 経路の「関連チーム総合力」はノードの statWeights で重み付けした値
    // (GDD 8.2「関連ステータスはイベント種別で変わる」)。
    const nodeTeamPowerFix =
      nodeDef === undefined
        ? teamPowerFix
        : effectiveTeamPowerFix(
            relatedTeamPowerFix(state, content, input.memberIds, nodeDef),
            params.equipmentBonusFix,
            nodeDef,
            choice,
          );
    const success = toRaw(addFix(nodeTeamPowerFix, rollFix)) >= toRaw(difficultyFix);
    const rewardFix = success ? nodeRewardFix(band.rewardPerNodeFix, choice) : FIX_ZERO;
    if (!success) {
      failureCount++;
      injuryFix = addFix(
        injuryFix,
        nodeInjuryGainFix(band.injuryPerFailureFix, choice, stanceInjuryMulFix),
      );
    }
    const rescue =
      success &&
      bernoulliHit(
        band.rescueChanceFix,
        drawFor(worldSeedU32, input, SALT_PURPOSE.rescue, i, choiceIndex),
      );
    grossRewardFix = addFix(grossRewardFix, rewardFix);

    const base: DispatchNode = { difficultyFix, rollFix, success, rewardFix, injuryFix, rescue };
    if (nodeDef === undefined || eventDef === undefined) {
      nodes.push(base);
      continue;
    }
    // [M22] 判定の**後**に cond を評価して分岐・ログ・効果を確定する(event.ts §2(c))。
    const outcome = resolveEventBranch(state, content, input, {
      eventId: eventDef.id,
      nodeDef,
      nodeIndex: i,
      teamPowerFix: nodeTeamPowerFix,
      difficultyFix,
      rollFix,
      failureCount,
    });
    nodes.push(withBranchOutcome(base, choiceIndex, outcome));
    if (outcome.withdraw) {
      withdrawn = true;
      break;
    }
  }

  // GDD 8.3「撤退 = 資源半分確保」。
  const rewardFix = withdrawn
    ? mulFix(grossRewardFix, params.withdrawRewardRatioFix)
    : grossRewardFix;

  // GDD 8.5: 累積負傷が閾値を跨ぐごとに 1 名脱落(全員なら全滅)。
  const casualtyCount = Math.min(
    input.memberIds.length,
    floorDivInt(toRaw(injuryFix), toRaw(band.casualtyInjuryThresholdFix)),
  );
  const order = casualtyOrderOf(state, content, input.memberIds);
  const casualtyMemberIds = [...order.slice(0, casualtyCount)].sort(compareUtf16);

  const snapshot: DispatchSnapshot = {
    id: input.dispatchId,
    destinationId: input.destinationId,
    band: input.band,
    stance: input.stance,
    memberIds: [...input.memberIds],
    dispatchTick: input.dispatchTick,
    returnTick: input.dispatchTick + travelTicksFor(state, content, input.band, input.memberIds),
    teamPowerFix,
    nodes,
    withdrawn,
    rewardFix,
    rewardResourceId: band.rewardResourceId,
    casualtyMemberIds,
  };
  return eventDef === undefined ? snapshot : setField(snapshot, "eventId", eventDef.id);
}

/** {@link resolveEventBranch} の結果(そのノードの分岐で確定したもの)。 */
interface EventBranchOutcome {
  readonly branchIndex: number;
  readonly logText: string;
  readonly effects: readonly DispatchEffect[];
  /** GDD 8.3 の撤退(以降のノードを踏まない)。 */
  readonly withdraw: boolean;
}

/**
 * [M22] 判定後の分岐を解決する(cond 評価 → result → logTemplate のレンダリング)。
 *
 * ここが「content を再参照しない」の境界である —— **この関数の中で content から
 * 読んだものはすべて確定値としてスナップショットへ焼かれ**、帰還時には
 * `DispatchNode.effects` / `logText` しか見ない(§1)。
 */
function resolveEventBranch(
  state: GameState,
  content: EngineContent,
  input: DispatchPlanInput,
  args: {
    readonly eventId: EntityId;
    readonly nodeDef: EventNodeDef;
    readonly nodeIndex: number;
    readonly teamPowerFix: Fix;
    readonly difficultyFix: Fix;
    readonly rollFix: Fix;
    readonly failureCount: number;
  },
): EventBranchOutcome {
  const ctx = buildCondContext(state, content, input.memberIds, args.nodeDef, {
    teamPowerFix: args.teamPowerFix,
    difficultyFix: args.difficultyFix,
    injuryCount: args.failureCount,
  });
  const branchIndex = selectBranchIndex(args.nodeDef, ctx);
  const branch = args.nodeDef.branches[branchIndex];
  if (branch === undefined) {
    throw new RulesError(
      `event "${args.eventId}" のノード ${String(args.nodeIndex)} の分岐 ${String(branchIndex)} が無い(実装バグ)`,
    );
  }
  const logText = renderLogTemplate(branch.logTemplate, {
    band: BAND_LABEL[input.band],
    event: args.eventId,
    node: args.nodeIndex + 1,
    members: input.memberIds.length,
    teamPowerFix: args.teamPowerFix,
    difficultyFix: args.difficultyFix,
    rollFix: args.rollFix,
    injuryCount: args.failureCount,
  });
  const result = branch.result;
  const effects: DispatchEffect[] =
    result.kind === "destroyRecords"
      ? [{ kind: "destroyRecords", medium: result.medium, scope: result.scope }]
      : [];
  return { branchIndex, logText, effects, withdraw: result.kind === "withdraw" };
}

/**
 * 分岐の結果をノードへ載せる。省略可フィールドの追加は生スプレッド禁止
 * (ADR-028(1))なので `setField`(update.ts の単一コピー経路)を通す。
 */
function withBranchOutcome(
  base: DispatchNode,
  choiceIndex: number | undefined,
  outcome: EventBranchOutcome,
): DispatchNode {
  let node = base;
  if (choiceIndex !== undefined) node = setField(node, "choiceIndex", choiceIndex);
  node = setField(node, "branchIndex", outcome.branchIndex);
  node = setField(node, "logText", outcome.logText);
  if (outcome.effects.length > 0) node = setField(node, "effects", outcome.effects);
  return node;
}

/**
 * 距離帯パラメータの前提(値域)を実行時に確かめる。schema 側でも検査するが、
 * engine のテストフィクスチャ経由で壊れた値が来たときに**静かに変な乱数を
 * 引かない**ようにここでも止める。
 *
 * @throws {RulesError} ノード数 / 難度 / R / 脱落閾値が不正な場合
 */
function requireBandParams(band: ExplorationBandParams, bandId: DistanceBand): void {
  if (
    !Number.isSafeInteger(band.nodeCountMin) ||
    !Number.isSafeInteger(band.nodeCountMax) ||
    band.nodeCountMin < 1 ||
    band.nodeCountMax < band.nodeCountMin
  ) {
    throw new RulesError(
      `距離帯 ${bandId} のノード数 ${String(band.nodeCountMin)}〜${String(band.nodeCountMax)} が不正`,
    );
  }
  if (
    !Number.isSafeInteger(band.difficultyMin) ||
    !Number.isSafeInteger(band.difficultyMax) ||
    band.difficultyMax < band.difficultyMin
  ) {
    throw new RulesError(
      `距離帯 ${bandId} の難度 ${String(band.difficultyMin)}〜${String(band.difficultyMax)} が不正`,
    );
  }
  if (!Number.isSafeInteger(band.rollRange) || band.rollRange < 1) {
    throw new RulesError(`距離帯 ${bandId} の R ${String(band.rollRange)} が 1 以上の整数でない`);
  }
  if (toRaw(band.casualtyInjuryThresholdFix) <= 0) {
    throw new RulesError(
      `距離帯 ${bandId} の脱落閾値 ${String(toRaw(band.casualtyInjuryThresholdFix))} が正でない`,
    );
  }
  if (!Number.isSafeInteger(band.baseTravelTicks) || band.baseTravelTicks < 1) {
    throw new RulesError(
      `距離帯 ${bandId} の baseTravelTicks ${String(band.baseTravelTicks)} が 1 以上の整数でない`,
    );
  }
}

// --- 4. 帰還解決(§1・scheduler 段60 から呼ばれる) --------------------------

/** {@link resolveExpedition} の結果。 */
export interface ExpeditionResolution {
  readonly state: GameState;
  /** 脱落者(ID 昇順)。scheduler が**段70 の死亡イベント**として積む(§4)。 */
  readonly casualtyIds: readonly EntityId[];
  /** 保護されて加入した住民(生成順)。 */
  readonly rescuedIds: readonly EntityId[];
  /** 適用したスナップショット(帰還ログの材料)。 */
  readonly snapshot: DispatchSnapshot;
  /** [M64] 報酬の実受領額と、保管上限であふれた量(帰還ログ/検証用)。 */
  readonly rewardIntake: RewardIntake;
}

/**
 * [M64] 探索報酬の受入結果(GDD 6.7 の保管上限を通した後の実額)。
 *
 * `acceptedFix` が**実際に在庫へ入った量**であり、帰還ログ(GDD 8.4)に焼くのは
 * こちらである。粗報酬(`DispatchSnapshot.rewardFix`)を表示していたのが
 * R5-A01(fatal)の「受領 11.3 に対しログは 175」の正体だった。
 */
export interface RewardIntake {
  /** 実際に在庫へ入った量。 */
  readonly acceptedFix: Fix;
  /** 保管上限に阻まれて在庫へ入らなかった量(廃材化ぶんを含む)。 */
  readonly excessFix: Fix;
}

/**
 * 保護されて加入する住民の ID。
 *
 * **(派遣 ID, 派遣 tick, ノード番号) で一意**である。派遣 ID だけだと、同じ ID を
 * 帰還後にもう一度使い回したときに前回の保護者と衝突する(派遣 ID は entity で
 * ないので `entityIdInUse` の検査に掛からない)。tick は単調増加なので、同じ
 * 派遣 ID を再利用しても衝突しない。
 */
export function rescueResidentIdOf(
  dispatchId: EntityId,
  dispatchTick: number,
  nodeIndex: number,
): EntityId {
  return entityIdFromString(`${dispatchId}Rescue${String(dispatchTick)}n${String(nodeIndex)}`);
}

/**
 * 帰還 tick の解決(GDD 11.7 段60)。**content を 1 度も読まない**(§1)—— 唯一の
 * 例外は保護加入で使う `townParams`(寿命の抽選)であり、これは「保護が起きたか
 * どうか」の判定ではなく**新しく生まれる住民の属性**なので再参照禁止の対象外
 * である(晴天漂着と同じ生成規則を使うほうが二重の真実を作らない)。
 *
 * 手順は固定順(memoirLog のバイト列を決めるため):
 *   (1) スナップショットを外し、生存メンバーの `dispatched` を下ろす
 *   (2) 報酬を資源在庫へ入れる
 *   (3) 保護加入(ノード番号順)→ 保護した側の memoirLog(メンバー ID 昇順)
 *   (4) 帰還ログ(レンダリング済み文字列)を積む
 * 脱落者の死亡は**ここでは行わない**(段70 の死亡ゲートへ回す・§4)。
 *
 * @throws {RulesError} その派遣が state に無い / 報酬資源の受け皿が無い場合
 */
export function resolveExpedition(
  state: GameState,
  ctx: AdvanceContext,
  dispatchId: EntityId,
  tick: number,
): ExpeditionResolution {
  const snapshot = getDispatch(state, dispatchId);
  if (snapshot === undefined) {
    throw new RulesError(`派遣 "${dispatchId}" が state に無い(帰還解決の対象が不在)`);
  }

  // (1) スナップショットを外す(未帰還一覧から消える = 派遣枠が空く)。
  let next = setDispatchSnapshots(
    state,
    state.dispatchSnapshots.filter((entry) => entry.id !== dispatchId),
  );
  for (const memberId of snapshot.memberIds) {
    next = updateEntity(next, memberId, "resident", (r) => setField(r, "dispatched", false));
  }

  // (2) 報酬。**[M64・台帳v17 必-1(案1系)] 本拠の施設産出と同じ加算式保管上限
  //     とスポンジを通す**(rules/storage.ts §2b)。生産側の会計
  //     (`cumulativeProduced` / `cumulativeOverflow`)は GDD 8.1
  //     [2026-07-30裁定]⑥ どおり触らない(理由は storage.ts §2b 冒頭)。
  let rewardIntake: RewardIntake = { acceptedFix: snapshot.rewardFix, excessFix: FIX_ZERO };
  if (toRaw(snapshot.rewardFix) > 0) {
    const credited = applyExpeditionReward(
      next,
      ctx.content,
      snapshot.rewardResourceId,
      snapshot.rewardFix,
    );
    next = credited.state;
    rewardIntake = credited.intake;
  }

  // (2b) [M22] スナップショットへ焼かれた効果(`destroyRecords` 等)。
  //      ノード順 → 効果順の固定順で適用する(state のバイト列を決めるため)。
  for (const node of snapshot.nodes) {
    const effects = node.effects;
    if (effects === undefined) continue;
    for (const effect of effects) {
      next = applyDispatchEffect(next, ctx.content, effect, tick);
    }
  }

  // (3) 保護加入(GDD 7.7)+ 保護した側の memoirLog(GDD 7.3)。
  //     **加入が実際に成立したときだけ** memoirLog を積む(不在の住民を名指しする
  //     記録を残さない)。成立しないのは content に townParams が無いときだけで、
  //     そのときは探索での保護という機構ごと不活性になる(§5)。
  const rescuedIds: EntityId[] = [];
  for (let i = 0; i < snapshot.nodes.length; i++) {
    const node = snapshot.nodes[i];
    if (node === undefined || !node.rescue) continue;
    const rescuedId = rescueResidentIdOf(dispatchId, snapshot.dispatchTick, i);
    if (next.entityStateById.has(rescuedId)) {
      throw new RulesError(
        `保護加入の生成 ID "${rescuedId}" が既に存在する` +
          "(派遣 ID × 派遣 tick × ノード番号の一意性違反 = 実装バグ)",
      );
    }
    const joined = joinRescuedResident(next, ctx, rescuedId, tick);
    if (joined === next) continue;
    next = joined;
    rescuedIds.push(rescuedId);
    for (const memberId of snapshot.memberIds) {
      next = appendMemoirEntry(next, memberId, {
        kind: "explorationRescue",
        tick,
        rescuedId,
        band: snapshot.band,
      });
    }
  }

  // (4) 帰還ログ(GDD 8.4・レンダリング済み文字列)。**[M64] 実受領額を焼く**
  //     (ログはセーブ確定方式 = 後から直せないので、保存する前に正しい値にする)。
  next = appendRenderedLog(next, {
    tick,
    text: renderReturnLog(snapshot, rescuedIds.length, rewardIntake),
  });

  return {
    state: next,
    casualtyIds: snapshot.casualtyMemberIds,
    rescuedIds,
    snapshot,
    rewardIntake,
  };
}

/**
 * [M64] 探索報酬を在庫へ入れる(GDD 6.7 / 8.4)。
 *
 * **[2026-08-04裁定・台帳v17 必-1(案1系)]** 上限とあふれ処理は本拠の施設産出と
 * **まったく同じ実装**(`rules/storage.ts` §2b の `applyCappedLumpIntake`)を通す。
 * 上限が無い資源なら全量が入る(= M21 と 1 bit も違わない)。上限がある資源では
 * 加算式保管上限(基礎 400 + 保管施設の Lv 合計 × 400・GDD 6.7 [2026-08-02裁定])
 * までを在庫へ入れ、あふれた分は本拠と同じ扱い(`wasteConversionRatio` が
 * 登録されていればその比率で廃材化・無ければ破棄)にする。
 *
 * M22 の `balance.exploration.rewardOverflow`(独自の固定上限)は撤廃した。
 * 400 スケール再校正(M39/M40)から取り残された `capacity: 200` が薪 200 以上で
 * 報酬を黙殺していた(R5-A01・fatal)ことが直接の契機であり、根治は
 * 「上限の出所を保管施設 1 系統に統一する」ことである。
 *
 * **`cumulativeProduced` / `cumulativeOverflow` は動かさない**(GDD 8.1
 * [2026-07-30裁定]⑥ は撤回されていない)。理由と実測は storage.ts §2b 冒頭。
 *
 * 受け取った量・あふれた量を返すのは、帰還ログ(GDD 8.4)へ**実受領額**を
 * 焼くためである(粗報酬を満額表示していたのが R5-A01 のもう半分)。
 *
 * @throws {RulesError} 報酬資源 / 廃材の受け皿 entity が state に無い場合
 */
function applyExpeditionReward(
  state: GameState,
  content: EngineContent,
  rewardResourceId: EntityId,
  rewardFix: Fix,
): { readonly state: GameState; readonly intake: RewardIntake } {
  const resourceEntityId = rewardResourceEntityIdOf(state, rewardResourceId);
  if (resourceEntityId === undefined) {
    throw new RulesError(
      `探索報酬の資源 "${rewardResourceId}" の在庫 entity が state に無い` +
        "(派遣確定時に検査済みのはず = 実装バグ)",
    );
  }
  const capacityByResourceId = resolveCapacityByResourceId(state, content);
  const outcome = applyCappedLumpIntake(
    state,
    content.storage,
    capacityByResourceId,
    requireEntity(state, resourceEntityId, "resource"),
    rewardFix,
  );
  return {
    // [Phase B・台帳v20 必-3(2)] あふれ救済で生まれた廃材も**報酬本体と同じく
    // 生産会計へ入れない**(rules/storage.ts §2c)。M64 は本体だけを外していた
    // ため、外部収入の副産物が GDD 11.4-7c の分子を押し上げる逆進性が残っていた。
    state: creditWasteGain(
      outcome.state,
      content.storage,
      capacityByResourceId,
      outcome.wasteGainFix,
      "applyExpeditionReward",
      "excluded",
    ),
    intake: { acceptedFix: outcome.acceptedFix, excessFix: outcome.excessFix },
  };
}

/**
 * 保護された住民を加入させる(§5)。生成規則は晴天漂着
 * (`rules/population.ts` の `applyArrival`)と同じ中立値 + seed 決定論の生涯で
 * あり、違いは **寝床上限に縛られない**ことだけである(GDD 7.7 が寝床上限を
 * 「定期加入」にだけ付けているため。要ユーザー判断として報告)。
 *
 * `townParams` が無い content では生涯を作れないので、**加入そのものを行わない**
 * (寿命を持たない住民を増やすと、以後その住民は探索で脱落しても死ねない =
 * 全滅リスクが静かに消える)。
 */
function joinRescuedResident(
  state: GameState,
  ctx: AdvanceContext,
  rescuedId: EntityId,
  tick: number,
): GameState {
  const town = ctx.content.town;
  if (town === undefined) return state;
  const resident: ResidentState = {
    kind: "resident",
    id: rescuedId,
    morale: ARRIVAL_INITIAL_MORALE_FIX,
    mastery: FIX_ZERO,
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
    life: createResidentLife(ctx.worldSeedU32, rescuedId, tick, town),
  };
  return initializeResidentMemoir(putEntity(state, resident), ctx.worldSeedU32, rescuedId, tick);
}

// --- 5. 帰還ログのレンダリング(GDD 8.4) ------------------------------------

/** Fix を「整数部だけ」の文字列にする(ログ本文の決定論性のため)。 */
function formatFixInt(value: Fix): string {
  return String(floorDivInt(toRaw(value), FIX_SCALE));
}

/**
 * 帰還ログの本文を作る純関数(GDD 8.4)。**スナップショットだけから決まる**ので、
 * 同じセーブからは常に同じ文字列になる(content を 1 度も読まない)。
 *
 * **[M22] content 側の `logTemplate`(GDD 12.1 の `branches[].logTemplate`)を
 * 結線した。** ただし結線先は「テンプレを帰還時に展開する」ではなく
 * 「**派遣確定時にレンダリング済みにした完成文字列**(`DispatchNode.logText`)を
 * ここで連結する」である —— GDD 12.5-7 が帰還ログについて「レンダリング済み
 * 完成文字列保存(再参照禁止)」と定めているため、テンプレ参照を帰還側に残すと
 * 後日のテンプレ修正・tombstone 化で過去ログが壊れる。
 *
 * ノードに `logText` が 1 つも無い(= M21 の手続き生成)場合、出力は M21 と
 * 完全に同一の文字列になる。
 *
 * **[M64] 報酬欄は `intake.acceptedFix`(実受領額)である。** 保管上限で
 * あふれた分があれば、黙殺せず「あふれた量」を 1 句足す(R5-A01 の
 * 「黙って破棄され、ログは粗報酬を満額表示」の両方に対する回答)。
 * あふれが 0 のとき(= 上限が無い/届いていない大多数の盤面)は M22 までと
 * 1 バイトも変わらない文字列になる。
 */
export function renderReturnLog(
  snapshot: DispatchSnapshot,
  rescuedCount: number,
  intake: RewardIntake,
): string {
  let successCount = 0;
  const nodeTexts: string[] = [];
  for (const node of snapshot.nodes) {
    if (node.success) successCount++;
    if (node.logText !== undefined && node.logText.length > 0) nodeTexts.push(node.logText);
  }
  const parts: string[] = [
    `${BAND_LABEL[snapshot.band]}探索「${snapshot.destinationId}」より${String(snapshot.memberIds.length)}名が帰還`,
    `${String(snapshot.nodes.length)}ノード中${String(successCount)}成功`,
    `報酬 ${snapshot.rewardResourceId} ${formatFixInt(intake.acceptedFix)}`,
  ];
  if (toRaw(intake.excessFix) > 0) {
    parts.push(`保管上限のため ${formatFixInt(intake.excessFix)} は持ち帰れなかった`);
  }
  if (snapshot.withdrawn) parts.push("撤退により報酬は半分");
  if (rescuedCount > 0) parts.push(`${String(rescuedCount)}名を保護`);
  if (snapshot.casualtyMemberIds.length > 0) {
    parts.push(
      snapshot.casualtyMemberIds.length >= snapshot.memberIds.length
        ? "隊は全滅した"
        : `${String(snapshot.casualtyMemberIds.length)}名が還らなかった`,
    );
  }
  const summary = `${parts.join("。")}。`;
  // content 由来の分岐ログはノード順に summary の後ろへ足す(既存の 1 行目の
  // バイト列を動かさないため、前置きではなく後置きにする)。
  return nodeTexts.length === 0 ? summary : `${summary}${nodeTexts.join("")}`;
}

/**
 * 帰還ログを 1 件積む。上限({@link MAX_RENDERED_LOGS})超過分は最古から落として
 * `foldedCount` へ繰り込む(GDD 8.4「超過分は要約統計に畳む」)。
 */
export function appendRenderedLog(state: GameState, entry: RenderedLogEntry): GameState {
  const current = state.renderedLogs;
  const merged = [...current.entries, entry];
  const overflow = merged.length - MAX_RENDERED_LOGS;
  return setRenderedLogs(state, {
    entries: overflow > 0 ? merged.slice(overflow) : merged,
    foldedCount: overflow > 0 ? current.foldedCount + overflow : current.foldedCount,
  });
}

// --- 6. ROI と (B)喪失の金銭化(GDD 8.6) ------------------------------------

/**
 * その住民を失うと**永久に消える** (B) 資産の件数(GDD 7.4 / 8.6)。
 *
 * 条件は 3 つとも必要:
 *   (a) その住民が実地で保持している(`techMemory.mastery > 0`)
 *   (b) `tech.lossClass` が `rareIrreversible`(= (A) は再取得可能なので
 *       「一回性喪失」の金銭化対象ではない・GDD 7.4)
 *   (c) 成文化された記録が 1 枚も無く、かつ**他に生存保持者が居ない**
 *       (どちらかがあれば知識は残る = 失われない)
 */
export function rareAssetCountOf(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
): number {
  let count = 0;
  for (const memberId of memberIds) {
    for (const techId of heldTechIdsOf(state, memberId)) {
      if (lossClassOfTech(content, techId) !== "rareIrreversible") continue;
      if (isCodified(state, techId)) continue;
      const holders = techHoldersOf(state, techId);
      let otherHolder = false;
      for (const holderId of holders) {
        if (holderId !== memberId) otherHolder = true;
      }
      if (otherHolder) continue;
      count++;
    }
  }
  return count;
}

/** {@link explorationRoi} の内訳(UI・sim・テストが同じ数値を読むための形)。 */
export interface ExplorationRoiReport {
  readonly band: DistanceBand;
  /**
   * 期待ノード数。
   * event 実体を参照できたときは**その event のノード数**(候補が複数なら平均)、
   * 参照できなければ距離帯のノード数レンジの中点(§8)。
   */
  readonly expectedNodesFix: Fix;
  /** 1 ノードの期待成功確率(安全曲線の入力)。 */
  readonly successProbabilityFix: Fix;
  /** 全滅確率(GDD 8.5 の安全曲線・**解析モデル**であり実解決とは別物)。 */
  readonly wipeProbabilityFix: Fix;
  /** 期待報酬(GDD 8.6 の分子)。 */
  readonly expectedRewardFix: Fix;
  /** 逸失生産(GDD 8.6 の分母の第1項)。 */
  readonly forgoneOutputFix: Fix;
  /** 期待 (B) 喪失損失(同第2項)。 */
  readonly expectedRareLossFix: Fix;
  /** 失うと消える (B) 資産の件数。 */
  readonly rareAssetCount: number;
  /** 往復所要 tick。 */
  readonly travelTicks: number;
  /** ROI = 分子 / 分母。分母が 0 なら null(逸失も損失も無い = 比が定義できない)。 */
  readonly roiFix: Fix | null;
  /**
   * [Phase D] この見積りが **event 実体**(ノード数・難度・R・statWeights・choices)を
   * 参照して出されたなら、その根拠になった event の ID(昇順)。距離帯パラメータ
   * だけの手続きモデルで出したときは空配列(§8)。
   */
  readonly sourceEventIds: readonly EntityId[];
}

/** {@link explorationRoi} の任意入力([Phase D]・省略時の既定は doc を参照)。 */
export interface ExplorationRoiOptions {
  /**
   * 目的地(event content の ID)。指定するとその event **1 本だけ**を見る。
   * 省略時はその距離帯へ出せる event 全部の平均(= 目的地を選ぶ前の帯の見積り)。
   */
  readonly destinationId?: EntityId;
  /**
   * 派遣方針(GDD 8.3)。choices の選ばれ方が変わるので難度も報酬も動く。
   * 省略時は `"cautious"`(UI の既定と同じ・安全側)。
   */
  readonly stance?: DispatchStance;
}

/**
 * 探索 ROI(GDD 8.6)。
 *
 * ```
 *   ROI = 期待報酬 / (逸失生産 + 期待B喪失損失)
 *   期待B喪失損失 = Σ(全滅確率 × 派遣者が保持する(B)資産価値換算)
 * ```
 *
 * **ここは事前期待値(プレイヤーが派遣前に見る指標)であって、実際の解決
 * (§1 のスナップショット)とは別の計算である。** 実解決は決定論で結果が 1 つに
 * 決まるので「確率」を持たないから、ROI 側だけが安全曲線という解析モデルを持つ。
 * 両者を混同しないよう、モデルの入力(難度・R 一様・成功確率の線形式)を
 * すべてこの関数に閉じてある。
 *
 * **[Phase D・台帳v20 必-2] 成功確率と期待報酬は event 実体から出す(§8)。**
 * `content.eventDefs` にその距離帯の event があれば、ノード数・難度・R・
 * statWeights・choices は**実解決 {@link buildDispatchSnapshot} と同じ関数**
 * (`rules/event.ts`)を通して読む。event が 1 本も無い距離帯だけが従来どおり
 * 距離帯パラメータの手続きモデル(難度 = レンジ中点・R = 帯の R)へ落ちる。
 *
 * どちらの経路でも 1 ノードの成功確率は
 * `P = clamp((関連チーム総合力 + 装備補正 + R − 難度) / R, 0, 1)`(整数演算のみ)。
 *
 * @throws {RulesError} content に exploration ブロックが無い場合
 */
export function explorationRoi(
  state: GameState,
  content: EngineContent,
  band: DistanceBand,
  memberIds: readonly EntityId[],
  options: ExplorationRoiOptions = {},
): ExplorationRoiReport {
  const params = content.exploration;
  if (params === undefined) {
    throw new RulesError("content に exploration ブロックが無いので ROI を出せない(GDD 8.6)");
  }
  const bandParams = params.byBand[band];
  requireBandParams(bandParams, band);

  const model = eventRoiModel(state, content, params, bandParams, band, memberIds, options);
  const { successProbabilityFix, expectedNodesFix, expectedRewardFix, sourceEventIds } = model;

  const travelTicks = travelTicksFor(state, content, band, memberIds);
  const forgoneOutputFix = mulFixInt(
    params.forgoneOutputPerWorkerTickFix,
    memberIds.length * travelTicks,
  );

  // 安全曲線(GDD 8.5): 成功確率が下がるほど全滅確率が上がり、上限で頭打ち。
  const wipeProbabilityFix = clampFix(
    mulFix(bandParams.wipeBasePFix, subFix(FIX_ONE, successProbabilityFix)),
    FIX_ZERO,
    params.wipeMaxPFix,
  );
  const rareAssetCount = rareAssetCountOf(state, content, memberIds);
  const expectedRareLossFix = mulFix(
    wipeProbabilityFix,
    mulFixInt(params.rareAssetValueFix, rareAssetCount),
  );

  const denominatorFix = addFix(forgoneOutputFix, expectedRareLossFix);
  const roiFix =
    toRaw(denominatorFix) === 0 ? null : floorDivFix(expectedRewardFix, denominatorFix);

  return {
    band,
    expectedNodesFix,
    successProbabilityFix,
    wipeProbabilityFix,
    expectedRewardFix,
    forgoneOutputFix,
    expectedRareLossFix,
    rareAssetCount,
    travelTicks,
    roiFix,
    sourceEventIds,
  };
}

/** `(a + b) / 2` を Fix で(整数演算のみ・floor 丸め)。 */
function fixFromRawHalfSum(a: number, b: number): Fix {
  return floorDivFix(fixFromInt(a + b), fixFromInt(2));
}

// --- 6b. [Phase D] ROI の期待値を event 実体から出す(台帳v20 必-2・§8) ------
//
// ===========================================================================
// 8. なぜ距離帯パラメータではなく event 実体を見るのか
// ===========================================================================
//   M21 の ROI は距離帯パラメータ(`difficultyMin/Max` の中点・帯の `rollRange`・
//   `nodeCountMin/Max` の中点)だけで期待値を出していた。ところが M22 以降、
//   実際の解決 {@link buildDispatchSnapshot} は **event 実体**(ノードごとの
//   `difficulty` / `rollRange` / `statWeights` / `choices`)で判定する。
//   両者はまったく別の数値を使うので、同じ盤面・同じチームでも予測と実績が
//   桁で食い違う(実測 R6-A02: 表示 ROI と実受領額が約 5 倍乖離)。
//
//   本節は「予測に使う入力を実解決と同じ場所から取る」ことでこの乖離を根から
//   断つ。判定値の組み立ては `rules/event.ts` の
//   {@link selectChoiceIndex} / {@link effectiveDifficultyFix} /
//   {@link effectiveTeamPowerFix} / {@link nodeRewardFix} / {@link relatedTeamPowerFix}
//   を**そのまま**呼ぶ(ROI 側に第二の判定式を作らない)。
//
//   予測と実解決の違いとして意図的に残すのは 2 つだけである:
//     (1) roll は引かず「0..R 一様」の解析分布として扱う(= 確率になる)。
//         実解決は決定論なので確率を持たない(§6 冒頭の doc)。
//     (2) 分岐(cond)と撤退は見ない。分岐は判定の**後**に決まり、報酬額を
//         変えるのは choice の `rewardMod` だけなので期待報酬には効かない。
//
//   目的地未選択(UI の帯プレビュー)では、その帯へ出せる event 全部の平均を
//   採る —— 「どれを選ぶか決める前の帯の期待値」という表示の意味に一致し、
//   かつ event が 1 本しか無い帯では選択時と同じ値になる。

/** {@link eventRoiModel} が返す期待値の束。 */
interface ExplorationRoiModel {
  readonly successProbabilityFix: Fix;
  readonly expectedNodesFix: Fix;
  readonly expectedRewardFix: Fix;
  readonly sourceEventIds: readonly EntityId[];
}

/** ROI 用の候補 event(destinationId 指定ならその 1 本・省略なら帯の全 event を ID 昇順)。 */
function roiCandidateEvents(
  content: EngineContent,
  band: DistanceBand,
  destinationId: EntityId | undefined,
): readonly EventDef[] {
  if (destinationId !== undefined) {
    const def = eventDefForDestination(content, destinationId, band);
    return def === undefined ? [] : [def];
  }
  const defs = content.eventDefs;
  if (defs === undefined) return [];
  const result: EventDef[] = [];
  for (const def of defs.values()) {
    if (def.destTags.includes(band)) result.push(def);
  }
  return result.sort((a, b) => compareUtf16(a.id, b.id));
}

/**
 * 1 ノードの成功確率(0..R 一様の roll に対する解析値)。
 *
 * `R = 0` は「乱数の幅が無い = 決定論的に総合力と難度を比べるだけ」なので
 * 0/1 のどちらかになる(ゼロ除算を作らない)。
 */
function nodeSuccessProbabilityFix(teamPowerFix: Fix, difficultyFix: Fix, rollRange: number): Fix {
  if (rollRange <= 0) {
    return toRaw(teamPowerFix) >= toRaw(difficultyFix) ? FIX_ONE : FIX_ZERO;
  }
  const rollRangeFix = fixFromInt(rollRange);
  return clampFix(
    floorDivFix(addFix(subFix(teamPowerFix, difficultyFix), rollRangeFix), rollRangeFix),
    FIX_ZERO,
    FIX_ONE,
  );
}

/**
 * 期待値の本体(§8)。event 実体を参照できなければ M21 の手続きモデルへ
 * **1 bit も変えずに**落ちる(event を 1 本も持たない content の golden/テストを
 * 動かさないため)。
 */
function eventRoiModel(
  state: GameState,
  content: EngineContent,
  params: ExplorationParams,
  bandParams: ExplorationBandParams,
  band: DistanceBand,
  memberIds: readonly EntityId[],
  options: ExplorationRoiOptions,
): ExplorationRoiModel {
  const candidates = roiCandidateEvents(content, band, options.destinationId);
  if (candidates.length === 0) {
    // --- 手続きモデル(M21 と同一) ---
    const teamPowerFix = teamPowerWithEquipment(state, content, memberIds);
    const difficultyMidFix = fixFromRawHalfSum(bandParams.difficultyMin, bandParams.difficultyMax);
    const successProbabilityFix = nodeSuccessProbabilityFix(
      teamPowerFix,
      difficultyMidFix,
      bandParams.rollRange,
    );
    const expectedNodesFix = fixFromRawHalfSum(bandParams.nodeCountMin, bandParams.nodeCountMax);
    return {
      successProbabilityFix,
      expectedNodesFix,
      expectedRewardFix: mulFix(
        mulFix(expectedNodesFix, successProbabilityFix),
        bandParams.rewardPerNodeFix,
      ),
      sourceEventIds: [],
    };
  }

  const stance = options.stance ?? "cautious";
  const countFix = fixFromInt(candidates.length);
  let nodeCountSumFix = FIX_ZERO;
  let probabilitySumFix = FIX_ZERO;
  let rewardSumFix = FIX_ZERO;
  const sourceEventIds: EntityId[] = [];

  for (const def of candidates) {
    sourceEventIds.push(def.id);
    nodeCountSumFix = addFix(nodeCountSumFix, fixFromInt(def.nodes.length));
    let eventProbabilitySumFix = FIX_ZERO;
    let eventRewardFix = FIX_ZERO;
    for (const node of def.nodes) {
      const choiceIndex = selectChoiceIndex(node, stance);
      const choice = choiceAt(node, choiceIndex);
      const difficultyFix = effectiveDifficultyFix(node, choice);
      const teamPowerFix = effectiveTeamPowerFix(
        relatedTeamPowerFix(state, content, memberIds, node),
        params.equipmentBonusFix,
        node,
        choice,
      );
      const probabilityFix = nodeSuccessProbabilityFix(teamPowerFix, difficultyFix, node.rollRange);
      eventProbabilitySumFix = addFix(eventProbabilitySumFix, probabilityFix);
      eventRewardFix = addFix(
        eventRewardFix,
        mulFix(probabilityFix, nodeRewardFix(bandParams.rewardPerNodeFix, choice)),
      );
    }
    // ノード数 0 の event は schema が弾く(1 本以上)。念のため 0 除算を作らない。
    if (def.nodes.length > 0) {
      probabilitySumFix = addFix(
        probabilitySumFix,
        floorDivFix(eventProbabilitySumFix, fixFromInt(def.nodes.length)),
      );
    }
    rewardSumFix = addFix(rewardSumFix, eventRewardFix);
  }

  return {
    successProbabilityFix: floorDivFix(probabilitySumFix, countFix),
    expectedNodesFix: floorDivFix(nodeCountSumFix, countFix),
    expectedRewardFix: floorDivFix(rewardSumFix, countFix),
    sourceEventIds,
  };
}

// --- 7. 診断クエリ(UI / sim 向け) -----------------------------------------

/** いま派遣中の住民(ID 昇順)。GDD 11.2 の dispatchW の対象。 */
export function dispatchedResidents(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const resident of livingResidents(state)) {
    if (resident.dispatched) result.push(resident);
  }
  return result;
}

/** 生存している派遣候補(死亡・派遣中を除く・ID 昇順)。 */
export function dispatchCandidates(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const resident of entitiesOfKind(state, "resident")) {
    if (!isAliveResident(resident) || resident.dispatched) continue;
    result.push(resident);
  }
  return result;
}
