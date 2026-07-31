// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 探索編成テンプレアシスト(戦力充足 + 80/100 約束) — M27
//   GDD 2.1(アシストは理論最大の 80% 止まり)/ 8.1〜8.2(派遣・combatPower)/
//   13.1(アシストアルゴリズム3種)/ ADR-020
//
// ===========================================================================
// 1. このモジュールの位置づけ(state を変更しない)
// ===========================================================================
//   「この距離帯へ何人でどのチームを送るか迷ったときに、そこそこ良い編成を
//   提案する」だけの**純関数**である。`assist/placement.ts`(M26)・
//   `assist/codify.ts`(本タスク)と同じ構え —— GameState は読むだけで一切
//   書き換えず、戻り値は {@link TeamPlan}(提案)であり、実際にチームを送るのは
//   プレイヤーが {@link teamPlanToCommands} で得た `dispatchExpedition`
//   コマンド列を `commands.ts` の `apply` へ渡したときだけ。
//
//   戦力の評価は `rules/exploration.ts` の {@link ../rules/exploration.teamPowerWithEquipment}
//   をそのまま呼ぶ(GDD 8.2 の判定式が実際に読む値と同じ関数)。本モジュールは
//   combatPower や装備補正を独自に再計算しない。
//
// ===========================================================================
// 2. 評価尺度と「理論最大」(★要ユーザー判断として報告)
// ===========================================================================
//   GDD 2.1 は「探索編成テンプレ ＝ 平均戦力充足の8割」と書くのみで、比較対象
//   (理論最大)の定義は明記していない。M26(推奨配置)が「盤面の産出乗数の
//   総和」を、本タスクの成文化アシストが「単一キューで間に合う件数」を尺度に
//   定めたのと同じ立場で、本モジュールは次のように定める:
//
//   **評価尺度 = 提案したチームの戦力({@link ../rules/exploration.teamPowerWithEquipment})**。
//   **理論最大 = 候補住民プールから編成できる、同じ人数のチームの戦力の最大値**
//   (= combatPower 降順に並べた上位 teamSize 名。装備補正はチーム一律の定数
//   加算なので、どの組でも同じだけ足されて構成の最適性には影響しない)。
//
//   派遣枠は同時に複数(GDD 8.1「派遣枠上限＝同時2枠」)あるため、本モジュールは
//   **複数のチーム要求を 1 回のバッチで処理する**({@link TeamRequest} の配列)。
//   要求は**渡された順で** 1 件ずつ処理し、既に他の要求へ割り当てた住民は
//   後続の要求のプールから除く(M26 の `blockedCells` と同じ「共有資源の占有」
//   構造)。**要求の並べ替えはしない**(M26 §3 と同じ理由: 手の順序はアシスト
//   対象外とし、+20% の上澄みをそこに残す)。
//
//   「戦力の合計を最大化する」という目的だけなら、要求の処理順やどの要求へ
//   誰を割り当てるかは結果の総和に影響しない(=総和は「上位 N 名を使い切る」
//   ことでしか動かない)。よって M26 の貪欲と同様、**単純に上位者から詰める
//   だけでは理論最大に一致してしまい 8 割にならない**。本モジュールは M26 と
//   全く同じ仕掛け(明示パラメータ + 中立床 + 目標最近傍選択)で意図的に
//   落とす:
//
//     (1) その要求で到達しうる最大戦力 maxPower(プール上位 teamSize 名)
//     (2) 目標戦力 target = maxPower × qualityRatio
//         (既定 {@link ASSIST_TEAM_TARGET_RATIO} = 0.75)
//     (3) 中立床: target は「プール全体の平均戦力 × teamSize
//         (+ 装備補正)」を下回らない(= ランダムに teamSize 名を選ぶより
//         悪くはしない、という M26 の Δ=1.0 床と同じ発想)
//     (4) プールの teamSize 人組の中から、戦力が target に最も近いものを選ぶ
//         (同値なら戦力が低い方 = 控えめな方、さらに同値なら住民 ID 昇順の
//         組を選ぶ全順序)
//
//   qualityRatio = 1.0 にすると (4) は「戦力最大の組」を選ぶことになり、上の
//   「総和不変」の理由により**どの要求順で処理しても達成できる総和の理論最大に
//   一致する**(= 素の貪欲へ厳密退化。M26 の qualityRatio=1.0 と同じ性質)。
//
// ===========================================================================
// 3. 決定論(RNG 不使用・全順序タイブレーク)
// ===========================================================================
//   乱数は一切引かない。候補プールは `rules/exploration.ts` の
//   {@link ../rules/exploration.dispatchCandidates}(住民 ID 昇順)を土台にし、
//   GDD 8.1 [2026-07-30裁定]②「寿命を持たない住民は派遣拒否」をそのまま適用する
//   (`life` 省略の住民は候補にしない。含めると `dispatchExpedition` コマンドが
//   reject する提案を出すことになる)。
//
//   チーム候補(teamSize 人の組)の列挙は住民 ID 昇順に固定した配列への
//   組合せ探索であり、Map の反復順には一切依存しない。GDD 7.7 の常時規模
//   (8〜20人)なら `C(20,4) = 4,845` 通りに収まり、ボタン 1 回の呼び出しとして
//   十分高速(tick ループには乗らない)。
// ---------------------------------------------------------------------------

import {
  FIX_ZERO,
  absFix,
  addFix,
  fixFromRaw,
  floorDivFix,
  fixFromInt,
  mulFix,
  mulFixInt,
  subFix,
  sumFix,
  toRaw,
  type Fix,
} from "../fp";
import { residentCombatPower } from "../rules/combat";
import {
  DISPATCH_TEAM_MAX,
  DISPATCH_TEAM_MIN,
  dispatchCandidates,
  teamPowerWithEquipment,
} from "../rules/exploration";
import type { DistanceBand, EngineContent } from "../rules/types";
import {
  getDispatch,
  type DispatchStance,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../state/state";
import { compareUtf16 } from "../canonicalize";
import type { DispatchExpeditionCommand } from "../commands";
import { AssistError } from "./placement";

// --- 1. パラメータ -----------------------------------------------------------

/**
 * 準最適化の目標比(§2 の qualityRatio)。既定 **0.75**。
 *
 * M26(`ASSIST_STEP_TARGET_RATIO` = 0.65)と同じ立場の engine 定数(裁定 N2 と
 * 同型の判断: アシストの強さは運営 LLM の additive 追加で動かせてはならない)。
 *
 * 校正は代表プール 5 種(戦力が均一に近いプール・二極化したプール・小規模
 * プール・戦力の開きが大きいプール・単独 1 名編成)× qualityRatio の掃引で行い、
 * 「達成戦力 / そのプールでの理論最大」の平均は
 *   0.60〜0.65 → 0.713 / 0.70 → 0.764 / **0.75 → 0.796** / 0.80 → 0.813 /
 *   0.85 → 0.836 / 0.90 → 0.904
 * であった(2026-07-31 実測・`tests/engine/assistExploration.test.ts`)。
 * 0.75 は M26 の実測平均(0.796)と偶然ほぼ一致する値であり、個別プールの比も
 * 0.74〜0.87 のレンジに収まって GDD 2.1 の「8 割前後」に最も近い。
 */
export const ASSIST_TEAM_TARGET_RATIO: Fix = fixFromRaw(750_000);

// --- 2. 入出力の型 -----------------------------------------------------------

/** 「この距離帯へ teamSize 名を送りたい」という要求。 */
export interface TeamRequest {
  /** 新しく作る派遣の ID(`dispatchExpedition` へそのまま渡る)。 */
  readonly dispatchId: EntityId;
  readonly destinationId: EntityId;
  readonly band: DistanceBand;
  readonly stance: DispatchStance;
  /** 希望人数(GDD 8.1「チーム1〜4名」)。 */
  readonly teamSize: number;
}

/** 1 チームぶんの提案。 */
export interface TeamSuggestion {
  readonly dispatchId: EntityId;
  readonly destinationId: EntityId;
  readonly band: DistanceBand;
  readonly stance: DispatchStance;
  /** 選んだ住民(ID 昇順)。 */
  readonly memberIds: readonly EntityId[];
  /** 実際に達成した戦力(`teamPowerWithEquipment`・§2)。 */
  readonly teamPowerFix: Fix;
  /** その時点のプールから到達しうる最大戦力(§2 の maxPower)。 */
  readonly bestTeamPowerFix: Fix;
  /** 準最適化の目標戦力(§2)。 */
  readonly targetTeamPowerFix: Fix;
}

/** {@link suggestExpeditionTeams} の結果。state は一切動いていない(§1)。 */
export interface TeamPlan {
  /** 要求順の提案列。編成できなかった要求はここに現れない。 */
  readonly suggestions: readonly TeamSuggestion[];
  /** プールが尽きて編成できなかった要求(要求順)。 */
  readonly unfulfilledRequests: readonly TeamRequest[];
}

/** 任意パラメータ。 */
export interface TeamAssistOptions {
  /**
   * §2 の qualityRatio。既定 {@link ASSIST_TEAM_TARGET_RATIO}。
   * 1.0 を渡すと戦力最大の組(素の貪欲)に厳密に退化する。
   */
  readonly qualityRatioFix?: Fix;
  /**
   * 編成に使ってはならない住民(唯一保持者を本拠に残す等・呼び出し側の判断)。
   * M26 の `blockedCells` と同じ位置づけの除外リスト。
   */
  readonly excludeResidentIds?: readonly EntityId[];
}

// --- 3. 候補プール -----------------------------------------------------------

/**
 * 探索編成の候補住民(ID 昇順)。`dispatchCandidates`(生存・非派遣中)に
 * GDD 8.1 [2026-07-30裁定]②「寿命を持たない住民は派遣拒否」を重ねる —— この
 * フィルタを外すと、`life` 省略の住民を含む提案が `dispatchExpedition` に
 * reject される(rules/exploration.ts の doc 参照)。
 */
export function explorationTeamCandidates(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const resident of dispatchCandidates(state)) {
    if (resident.life !== undefined) result.push(resident);
  }
  return result;
}

function excludeSetOf(residentIds: readonly EntityId[] | undefined): ReadonlySet<EntityId> {
  return new Set(residentIds ?? []);
}

// --- 4. 戦力の順位付けと組合せ探索(§2/§3) ----------------------------------

interface RankedMember {
  readonly resident: ResidentState;
  readonly powerFix: Fix;
}

/** 個々の combatPower 降順・同値は ID 昇順(§3)。 */
function rankByCombatPower(
  pool: readonly ResidentState[],
  content: EngineContent,
): readonly RankedMember[] {
  const ranked = pool.map((resident) => ({
    resident,
    powerFix: residentCombatPower(resident, content),
  }));
  ranked.sort((a, b) => {
    const diff = toRaw(b.powerFix) - toRaw(a.powerFix);
    return diff !== 0 ? diff : compareUtf16(a.resident.id, b.resident.id);
  });
  return ranked;
}

/** teamSize 人組(住民 ID の昇順配列)を全列挙する(§3・辞書順)。 */
function enumerateTeamsOfSize(
  poolIds: readonly EntityId[],
  teamSize: number,
): readonly (readonly EntityId[])[] {
  const result: EntityId[][] = [];
  const combo: EntityId[] = [];
  const walk = (start: number): void => {
    if (combo.length === teamSize) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < poolIds.length; i++) {
      combo.push(poolIds[i] as EntityId);
      walk(i + 1);
      combo.pop();
    }
  };
  walk(0);
  return result;
}

/** その要求で到達しうる最大戦力(§2 の maxPower・プール上位 teamSize 名)。 */
function bestAchievableTeam(
  state: GameState,
  content: EngineContent,
  ranked: readonly RankedMember[],
  teamSize: number,
): { readonly memberIds: readonly EntityId[]; readonly powerFix: Fix } {
  const memberIds = ranked
    .slice(0, teamSize)
    .map((entry) => entry.resident.id)
    .sort(compareUtf16);
  return { memberIds, powerFix: teamPowerWithEquipment(state, content, memberIds) };
}

/**
 * 中立床(§2(3)) = プール全体の平均戦力 × teamSize + 装備補正。
 * 「ランダムに teamSize 名を選ぶより悪くはしない」という M26 の Δ=1.0 床と
 * 同じ発想であり、`teamPowerWithEquipment` を平均値で直接呼べないため
 * (実在する住民 ID の組でしか評価できない)、装備補正は content の値を
 * そのまま 1 度だけ足す(独自の判定式ではなく content フィールドの参照)。
 */
function neutralFloorFix(
  content: EngineContent,
  ranked: readonly RankedMember[],
  teamSize: number,
): Fix {
  const powers = ranked.map((entry) => entry.powerFix);
  const averageFix = floorDivFix(sumFix(powers), fixFromInt(powers.length));
  const equipmentBonusFix = content.exploration?.equipmentBonusFix ?? FIX_ZERO;
  return addFix(mulFixInt(averageFix, teamSize), equipmentBonusFix);
}

/** その手の目標戦力を求める(§2(1)〜(3))。 */
function assistTargetPower(bestPowerFix: Fix, floorFix: Fix, qualityRatioFix: Fix): Fix {
  const scaled = mulFix(bestPowerFix, qualityRatioFix);
  return toRaw(scaled) < toRaw(floorFix) ? floorFix : scaled;
}

/**
 * 目標戦力に最も近い teamSize 人組を選ぶ(§2(4))。比較は
 * ① |戦力 − target| 昇順 → ② 戦力 昇順 → ③ 住民 ID 組の辞書順 の全順序。
 * 列挙が辞書順(§3)なので、同点は「先に見つかったもの」を保てば③を満たす。
 */
function selectClosestTeam(
  state: GameState,
  content: EngineContent,
  teams: readonly (readonly EntityId[])[],
  targetFix: Fix,
): { readonly memberIds: readonly EntityId[]; readonly powerFix: Fix } {
  let bestTeam: readonly EntityId[] | undefined;
  let bestPowerFix = FIX_ZERO;
  let bestDistanceFix = FIX_ZERO;
  for (const team of teams) {
    const powerFix = teamPowerWithEquipment(state, content, team);
    const distanceFix = absFix(subFix(powerFix, targetFix));
    if (bestTeam === undefined) {
      bestTeam = team;
      bestPowerFix = powerFix;
      bestDistanceFix = distanceFix;
      continue;
    }
    const distanceDiff = toRaw(distanceFix) - toRaw(bestDistanceFix);
    if (distanceDiff > 0) continue;
    if (distanceDiff === 0 && toRaw(powerFix) >= toRaw(bestPowerFix)) continue;
    bestTeam = team;
    bestPowerFix = powerFix;
    bestDistanceFix = distanceFix;
  }
  if (bestTeam === undefined) {
    throw new AssistError(
      "selectClosestTeam: 候補チームが空の状態で選択しようとした(呼び出し側の不変条件違反)",
    );
  }
  return { memberIds: bestTeam, powerFix: bestPowerFix };
}

// --- 5. 入口 -----------------------------------------------------------------

/**
 * 探索編成テンプレを提案する(GDD 2.1「探索編成テンプレ」)。**state は動かない**
 * (§1)。要求は配列の順に 1 件ずつ処理し、各要求で
 *   候補プール(前の要求で使った住民を除く) → 最大戦力・中立床・目標戦力(§2)
 *   → 目標に最も近い teamSize 人組を採用(§2(4))
 * を行う。後戻り(既に採った提案の撤回)も要求の並べ替えもしない。
 *
 * プールが teamSize 未満で編成できなかった要求は例外にせず
 * {@link TeamPlan.unfulfilledRequests} へ載せる。
 *
 * @throws {AssistError} teamSize が 1〜4(`DISPATCH_TEAM_MIN`〜`DISPATCH_TEAM_MAX`)
 *   の範囲外 / 要求内で dispatchId が重複 / 既存の派遣 ID と衝突する場合
 */
export function suggestExpeditionTeams(
  state: GameState,
  content: EngineContent,
  requests: readonly TeamRequest[],
  options: TeamAssistOptions = {},
): TeamPlan {
  const qualityRatioFix = options.qualityRatioFix ?? ASSIST_TEAM_TARGET_RATIO;
  if (toRaw(qualityRatioFix) < 0) {
    throw new AssistError(`qualityRatioFix ${String(toRaw(qualityRatioFix))} は 0 以上で指定する`);
  }
  const excluded = excludeSetOf(options.excludeResidentIds);
  const basePool = explorationTeamCandidates(state).filter((r) => !excluded.has(r.id));

  const seenDispatchIds = new Set<EntityId>();
  const used = new Set<EntityId>();
  const suggestions: TeamSuggestion[] = [];
  const unfulfilledRequests: TeamRequest[] = [];

  for (const request of requests) {
    if (
      !Number.isSafeInteger(request.teamSize) ||
      request.teamSize < DISPATCH_TEAM_MIN ||
      request.teamSize > DISPATCH_TEAM_MAX
    ) {
      throw new AssistError(
        `suggestExpeditionTeams: teamSize ${String(request.teamSize)} は ` +
          `${String(DISPATCH_TEAM_MIN)}〜${String(DISPATCH_TEAM_MAX)}(GDD 8.1)で指定する`,
      );
    }
    if (seenDispatchIds.has(request.dispatchId)) {
      throw new AssistError(`要求内で派遣 ID "${request.dispatchId}" が重複している`);
    }
    seenDispatchIds.add(request.dispatchId);
    if (getDispatch(state, request.dispatchId) !== undefined) {
      throw new AssistError(`派遣 ID "${request.dispatchId}" は既存の未帰還派遣と衝突している`);
    }

    const pool = basePool.filter((r) => !used.has(r.id));
    if (pool.length < request.teamSize) {
      unfulfilledRequests.push(request);
      continue;
    }

    const ranked = rankByCombatPower(pool, content);
    const best = bestAchievableTeam(state, content, ranked, request.teamSize);
    const floorFix = neutralFloorFix(content, ranked, request.teamSize);
    const targetFix = assistTargetPower(best.powerFix, floorFix, qualityRatioFix);

    const poolIds = pool.map((r) => r.id).sort(compareUtf16);
    const teams = enumerateTeamsOfSize(poolIds, request.teamSize);
    const chosen = selectClosestTeam(state, content, teams, targetFix);

    for (const memberId of chosen.memberIds) used.add(memberId);
    suggestions.push({
      dispatchId: request.dispatchId,
      destinationId: request.destinationId,
      band: request.band,
      stance: request.stance,
      memberIds: chosen.memberIds,
      teamPowerFix: chosen.powerFix,
      bestTeamPowerFix: best.powerFix,
      targetTeamPowerFix: targetFix,
    });
  }

  return { suggestions, unfulfilledRequests };
}

/**
 * 提案を `dispatchExpedition` コマンド列へ落とす(ADR-020)。適用するかどうかは
 * プレイヤーの判断であり、この関数は state を触らない。
 */
export function teamPlanToCommands(plan: TeamPlan): readonly DispatchExpeditionCommand[] {
  const commands: DispatchExpeditionCommand[] = [];
  for (const suggestion of plan.suggestions) {
    commands.push({
      kind: "dispatchExpedition",
      dispatchId: suggestion.dispatchId,
      destinationId: suggestion.destinationId,
      band: suggestion.band,
      stance: suggestion.stance,
      teamResidentIds: suggestion.memberIds,
    });
  }
  return commands;
}
