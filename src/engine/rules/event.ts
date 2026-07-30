// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- event ランタイム — GDD 8.2〜8.4 / 11.1追補 / 12.1 / 12.2 / M22
//
// ===========================================================================
// 1. 位置づけ: 「ノードの中身」を決める層(派遣の器は exploration.ts)
// ===========================================================================
//   M21 の `rules/exploration.ts` は派遣の器(スナップショット生成・帰還解決・
//   ROI)を持ち、ノードの難度/R は距離帯パラメータから**手続き的に**引いていた。
//   M22 は同じ器の中身を **content の event 定義**({@link EventDef})へ差し替える。
//   差し替え点は指示どおり `buildDispatchSnapshot` **1 箇所**であり、
//   本モジュールはそこから呼ばれる純関数群を提供する:
//
//     選択(GDD 8.3)   : {@link selectChoiceIndex}
//     判定値(GDD 8.2) : {@link effectiveDifficultyFix} / {@link effectiveTeamPowerFix}
//                        / {@link nodeRewardFix} / {@link nodeInjuryGainFix}
//     分岐(GDD 12.2)  : {@link buildCondContext} / {@link selectBranchIndex}
//     ログ(GDD 8.4)   : {@link renderLogTemplate}
//     効果(GDD 11.1)  : {@link destroyRecords} / {@link applyDispatchEffect}
//
//   **content に event が 1 本も無ければ、この層は 1 度も呼ばれない**
//   (`EngineContent.eventDefs` が空 = M21 の手続き生成へフォールバック)。
//   現 content には `event.json` が無いので、M22 の導入で既存 golden vector は
//   1 bit も動かない。
//
// ===========================================================================
// 2. 「判定前」に決まるものと「判定後」に決まるものの線引き
// ===========================================================================
//   GDD 8.3 は選択を**判定前**に置く。したがって順序は必ず
//
//     (a) choice を選ぶ          → 難度 / 成功率 / 報酬 / 負傷倍率が確定
//     (b) 乱数 roll を引く       → 成否が確定
//     (c) branch の cond を評価  → 結果(result)とログが確定
//
//   である。cond から見える `teamPower` / `difficulty` は **(a) 適用後の値**で
//   あり、判定式で実際に比べた値そのものになる(rules/cond.ts §4)。
//   `injuryCount` は**そのノードを含めた**失敗回数(= (b) の結果を反映)である
//   ことに注意 —— GDD 8.3 の文面分岐「負傷有無」は判定の結果を語るものなので、
//   分岐が自分のノードの負傷を見られないと「負傷した」と書けない。
//
// ===========================================================================
// 3. 記録の破壊(GDD 11.1 [2026-07-27追補])
// ===========================================================================
//   `destroyRecords{medium, scope}` は「燃えるのは記録であって知識ではない」を
//   そのまま実装する:
//     - 対象の codify entity(完成済み記録)を state から取り除く
//     - その tech の記録が 0 枚になったら **未成文状態へ戻る**(`isCodified` が
//       false になるだけで、追加の状態は持たない)
//     - **生存保持者ゼロ かつ 記録ゼロ**になった tech だけが周回内喪失になる
//       (判定は `rules/techMemory.ts` の `applyTechLossIfOrphaned` = 死亡起因の
//       喪失と**同一の 1 箇所**)
//   MVP の content は火災イベントを 1 本も持たない(GDD 11.1 追補)。engine 側に
//   プリミティブだけを置き、conformance と単体テストで挙動を固定しておくことで、
//   MVP 後に event JSON の additive 追加だけで解禁できる。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import {
  FIX_ONE,
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  fixFromInt,
  floorDivInt,
  maxFix,
  mulFix,
  mulFixInt,
  toRaw,
  type Fix,
} from "../fp";
import {
  entitiesOfKind,
  requireEntity,
  type CodifyState,
  type DispatchEffect,
  type EntityId,
  type GameState,
} from "../state/state";
import { removeEntity } from "../state/update";
import { residentCombatPower } from "./combat";
import { EQUIP_TYPE_NONE, evaluateCond, type CondContext } from "./cond";
import {
  NEUTRAL_RESIDENT_STATS,
  RESIDENT_STAT_IDS,
  effectiveStats,
  resolveCombatTraitDefs,
  weightedStatSum,
} from "./stats";
import { applyTechLossIfOrphaned } from "./techMemory";
import {
  RulesError,
  isDestroyRecordsMedium,
  isDestroyRecordsScope,
  type DestroyRecordsMedium,
  type DestroyRecordsScope,
  type DistanceBand,
  type EngineContent,
  type EventChoiceDef,
  type EventDef,
  type EventNodeDef,
  type RecordMedium,
} from "./types";

// --- 1. event の選択(目的地 = event content の ID) --------------------------

/**
 * 目的地 ID に対応する event 定義を引く。
 *
 * **無ければ undefined**(= M21 の手続き生成へフォールバック)。距離帯が
 * `destTags` に含まれない event は「その距離帯では出ない」ので、これも
 * undefined を返さず**例外**にする —— 派遣コマンドの引数の取り違えであり、
 * 黙って手続き生成へ落とすと content の穴が見えなくなるためである。
 *
 * @throws {RulesError} event はあるが距離帯が `destTags` に無い場合
 */
export function eventDefForDestination(
  content: EngineContent,
  destinationId: EntityId,
  band: DistanceBand,
): EventDef | undefined {
  const def = content.eventDefs?.get(destinationId);
  if (def === undefined) return undefined;
  for (const tag of def.destTags) {
    if (tag === band) return def;
  }
  throw new RulesError(
    `event "${destinationId}" は距離帯 ${band} に出ない(destTags: ${def.destTags.join(",")}・裁定 B7)`,
  );
}

// --- 2. choice の選択(GDD 8.3・§2(a)) --------------------------------------

/**
 * そのノードで選ばれる choice の添字。**MVP は派遣確定時の方針から機械的に
 * 決める**(GDD 8.1 の [2026-07-30裁定]① 「ノードごとの直前選択は派遣確定時
 * 1 回の方針へ縮約」)。規則は 1 行で書ける:
 *
 *   cautious : `successMod` が最大の choice(同値は添字の小さい方)
 *   press    : `rewardMod`  が最大の choice(同値は添字の小さい方)
 *
 * 「慎重 = 成功率+ / 大胆 = 報酬+」(GDD 8.3)をそのまま尺度にしているので、
 * content 側は選択肢に意味のある mod を付けるだけでよく、engine が特定の
 * ラベル文字列を知る必要がない(= 日本語ラベルに依存しない)。
 *
 * choices が空なら undefined(選択という概念が無いノード)。
 *
 * **M32(探索本部 UI)がプレイヤーの回答を受け取るようになったら、この関数の
 * 戻り値を回答で置き換えるだけでよい**(呼び出し側は添字しか見ない)。
 */
export function selectChoiceIndex(
  node: EventNodeDef,
  stance: "cautious" | "press",
): number | undefined {
  if (node.choices.length === 0) return undefined;
  let bestIndex = 0;
  let bestScore = scoreOfChoice(node.choices[0], stance);
  for (let i = 1; i < node.choices.length; i++) {
    const score = scoreOfChoice(node.choices[i], stance);
    if (score > bestScore) {
      bestIndex = i;
      bestScore = score;
    }
  }
  return bestIndex;
}

function scoreOfChoice(choice: EventChoiceDef | undefined, stance: "cautious" | "press"): number {
  if (choice === undefined) return 0;
  return toRaw(stance === "cautious" ? choice.successModFix : choice.rewardModFix);
}

/** 選ばれた choice(添字が範囲外 / undefined なら undefined)。 */
export function choiceAt(
  node: EventNodeDef,
  index: number | undefined,
): EventChoiceDef | undefined {
  return index === undefined ? undefined : node.choices[index];
}

// --- 3. 判定値(GDD 8.2・§2(a)) --------------------------------------------

/**
 * choice 適用後のノード難度(GDD 8.3「大胆 = 難度+」)。
 *
 * `difficulty × (1 + difficultyMod)`。`difficultyMod` は schema で ±1 に
 * クランプ済みなので係数は 0〜2、難度は 1〜1,000,000 → 中間積は最大
 * 1e6(raw 難度 1e12)× 2e6 で BigInt 経路へ落ちうる。よって {@link mulFix}
 * (自動 BigInt フォールバック)を使う。**負の難度は作らない**(0 でクランプ)。
 */
export function effectiveDifficultyFix(
  node: EventNodeDef,
  choice: EventChoiceDef | undefined,
): Fix {
  const baseFix = fixFromInt(node.difficulty);
  if (choice === undefined || toRaw(choice.difficultyModFix) === 0) return baseFix;
  const scaled = mulFix(baseFix, addFix(FIX_ONE, choice.difficultyModFix));
  return maxFix(scaled, FIX_ZERO);
}

/**
 * 判定式の左辺のうち乱数を除いた部分(GDD 8.2「関連チーム総合力 + 装備補正」)に
 * choice の「成功率+」を織り込んだ値。
 *
 * `successMod` は**成功確率の増分**として定義する。roll が 0..R の一様分布で
 * あることから、確率を `p` だけ上げることは左辺へ `p × R` を足すことと厳密に
 * 同値である。こうすると schema の `successMod`(±1 = ±100%)がそのまま
 * 「成功率が何割上がるか」として読め、距離帯ごとに R が違っても意味がぶれない。
 */
export function effectiveTeamPowerFix(
  relatedTeamPowerFix: Fix,
  equipmentBonusFix: Fix,
  node: EventNodeDef,
  choice: EventChoiceDef | undefined,
): Fix {
  const base = addFix(relatedTeamPowerFix, equipmentBonusFix);
  if (choice === undefined || toRaw(choice.successModFix) === 0) return base;
  // successMod(|raw| <= 1e6)× R(<= 1e6)。mulFixInt は raw × 整数なので
  // 中間積 <= 1e12 < 2^53-1 で厳密(fp.ts §6)。
  return addFix(base, mulFixInt(choice.successModFix, node.rollRange));
}

/** choice 適用後のノード報酬(GDD 8.3「慎重 = 報酬- / 大胆 = 報酬+」)。 */
export function nodeRewardFix(baseRewardFix: Fix, choice: EventChoiceDef | undefined): Fix {
  if (choice === undefined || toRaw(choice.rewardModFix) === 0) return baseRewardFix;
  return maxFix(mulFix(baseRewardFix, addFix(FIX_ONE, choice.rewardModFix)), FIX_ZERO);
}

/**
 * 判定失敗 1 回ぶんの負傷(GDD 8.3「強行 = 負傷リスク ×1.5」)。
 *
 * 掛かる倍率は 2 つで、順序は **choice → stance** に固定する(乗算は可換だが
 * 固定小数点の floor 丸めは可換でないため、順序を決めておかないと同じ入力から
 * 違う値が出る)。
 */
export function nodeInjuryGainFix(
  baseInjuryFix: Fix,
  choice: EventChoiceDef | undefined,
  stanceMulFix: Fix,
): Fix {
  const withChoice =
    choice === undefined || toRaw(choice.injuryRiskMulFix) === toRaw(FIX_ONE)
      ? baseInjuryFix
      : mulFix(baseInjuryFix, choice.injuryRiskMulFix);
  return toRaw(stanceMulFix) === toRaw(FIX_ONE) ? withChoice : mulFix(withChoice, stanceMulFix);
}

/**
 * そのノードの `statWeights` で重み付けしたチーム総合力
 * (GDD 8.2「関連ステータスはイベント種別で変わる」)。
 *
 * 基礎ステ 5 種は trait 適用後の実効値へ重みを掛けて総和し、派生値
 * `combatPower` は**別扱いで**解決する(裁定 B8: 「`statWeights` に
 * `combatPower` を書く場合、ローダーは基礎ステと別扱いで解決する」)。
 * 装備補正はここに含めない(GDD 8.2 裁定の二重計上回避)。
 *
 * 走査は `memberIds` の順(呼び出し側が ID 昇順へ正規化済み)。
 *
 * @throws {EntityLookupError} `memberIds` に住民でない ID が含まれる場合
 */
export function relatedTeamPowerFix(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
  node: EventNodeDef,
): Fix {
  let total = FIX_ZERO;
  for (const memberId of memberIds) {
    const resident = requireEntity(state, memberId, "resident");
    const traits = resolveCombatTraitDefs(resident.traitIds, content.traitDefs);
    const stats = effectiveStats(resident.stats ?? NEUTRAL_RESIDENT_STATS, traits);
    total = addFix(total, weightedStatSum(stats, node.statWeights));
    if (toRaw(node.combatPowerWeightFix) !== 0) {
      total = addFix(
        total,
        mulFix(node.combatPowerWeightFix, residentCombatPower(resident, content)),
      );
    }
  }
  return total;
}

// --- 4. cond の評価コンテキスト(GDD 12.2・§2(c)) --------------------------

/**
 * そのノードの cond を評価するためのコンテキストを組み立てる。
 *
 * `maxStatHolder(stat)` の母集合には基礎ステ 5 種(trait 適用後)と派生値
 * `combatPower` を入れる。`hasTrait(traitId)` は**チームの誰か 1 人でも
 * 持っていれば true**(GDD 8.3 の文面分岐「名前/装備種別」と同じ粒度)。
 *
 * @throws {EntityLookupError} `memberIds` に住民でない ID が含まれる場合
 */
export function buildCondContext(
  state: GameState,
  content: EngineContent,
  memberIds: readonly EntityId[],
  node: EventNodeDef,
  args: {
    readonly teamPowerFix: Fix;
    readonly difficultyFix: Fix;
    readonly injuryCount: number;
  },
): CondContext {
  const teamTraitIds = new Set<string>();
  const maxStatFixByStatId = new Map<string, Fix>();
  for (const memberId of memberIds) {
    const resident = requireEntity(state, memberId, "resident");
    for (const traitId of resident.traitIds) teamTraitIds.add(traitId);
    const traits = resolveCombatTraitDefs(resident.traitIds, content.traitDefs);
    const stats = effectiveStats(resident.stats ?? NEUTRAL_RESIDENT_STATS, traits);
    for (const statId of RESIDENT_STAT_IDS) {
      const current = maxStatFixByStatId.get(statId);
      const value = stats[statId];
      if (current === undefined || toRaw(value) > toRaw(current)) {
        maxStatFixByStatId.set(statId, value);
      }
    }
    const power = residentCombatPower(resident, content);
    const currentPower = maxStatFixByStatId.get(COMBAT_POWER_STAT_KEY);
    if (currentPower === undefined || toRaw(power) > toRaw(currentPower)) {
      maxStatFixByStatId.set(COMBAT_POWER_STAT_KEY, power);
    }
  }
  let weightTotal = FIX_ZERO;
  for (const statId of RESIDENT_STAT_IDS) {
    weightTotal = addFix(weightTotal, node.statWeights[statId]);
  }
  weightTotal = addFix(weightTotal, node.combatPowerWeightFix);
  return {
    teamPowerFix: args.teamPowerFix,
    difficultyFix: args.difficultyFix,
    statWeightsTotalFix: weightTotal,
    injuryCount: args.injuryCount,
    equipType: EQUIP_TYPE_NONE,
    teamTraitIds,
    maxStatFixByStatId,
  };
}

/** `maxStatHolder("combatPower")` のキー(裁定 B8 の派生値 ID)。 */
const COMBAT_POWER_STAT_KEY = "combatPower";

/**
 * 成立する branch の添字。**先頭から順に評価し最初に真になったもの**を採る
 * (GDD 12.1 が並び順を持つ配列で定義しているため)。
 *
 * ロード側が「最後の branch の cond は無条件成立(リテラル `true`)」を強制して
 * いるので、**必ずどれか 1 本が成立する**。それでも成立しなかった場合は
 * ロード側の不変条件が破れているので黙って既定へ落とさず例外にする。
 *
 * @throws {RulesError} どの branch も成立しなかった場合(ロードの不変条件違反)
 */
export function selectBranchIndex(node: EventNodeDef, ctx: CondContext): number {
  for (let i = 0; i < node.branches.length; i++) {
    const branch = node.branches[i];
    if (branch === undefined) continue;
    if (evaluateCond(branch.cond, ctx)) return i;
  }
  throw new RulesError(
    "event ノードのどの branch も成立しなかった" +
      "(最後の branch は無条件成立でなければならない = ローダーの不変条件違反)",
  );
}

// --- 5. 帰還ログのテンプレ(GDD 8.4) ----------------------------------------

/**
 * `logTemplate` で使えるプレースホルダの正本(UTF-16 昇順)。
 * **ここに無い `{...}` はロード時 reject**(`schema/engineContent.ts`)であり、
 * 「書いたのに置換されない」テンプレが本番へ出る経路を塞ぐ。
 */
export const LOG_TEMPLATE_PLACEHOLDERS: readonly string[] = [
  "band",
  "difficulty",
  "event",
  "injuryCount",
  "members",
  "node",
  "roll",
  "teamPower",
];

/** {@link renderLogTemplate} の差し込み値(全て確定済みの決定論値)。 */
export interface LogTemplateParams {
  /** 距離帯の表示名(exploration.ts の `BAND_LABEL`)。 */
  readonly band: string;
  /** event content の ID。 */
  readonly event: string;
  /** ノード番号(1 始まり)。 */
  readonly node: number;
  /** チーム人数。 */
  readonly members: number;
  /** 判定に使った総合力(整数部)。 */
  readonly teamPowerFix: Fix;
  /** 判定難度(整数部)。 */
  readonly difficultyFix: Fix;
  /** 引いた roll(整数部)。 */
  readonly rollFix: Fix;
  /** そのノードまでの判定失敗回数。 */
  readonly injuryCount: number;
}

/**
 * `logTemplate` をレンダリングして**完成文字列**にする(GDD 8.4 / 12.5-7)。
 *
 * 置換は {@link LOG_TEMPLATE_PLACEHOLDERS} の宣言順に `split`/`join` で行う
 * (正規表現の置換コールバックを使わないのは、置換順・後方参照の解釈を
 * 実装依存にしないため)。数値は**整数部だけ**を出す —— 固定小数の小数第 6 位
 * までをログ本文に出しても読めないうえ、丸め規約がログの見た目に漏れる。
 */
export function renderLogTemplate(template: string, params: LogTemplateParams): string {
  let text = template;
  for (const name of LOG_TEMPLATE_PLACEHOLDERS) {
    text = text.split(`{${name}}`).join(logValueOf(name, params));
  }
  return text;
}

function logValueOf(name: string, params: LogTemplateParams): string {
  switch (name) {
    case "band":
      return params.band;
    case "event":
      return params.event;
    case "node":
      return String(params.node);
    case "members":
      return String(params.members);
    case "teamPower":
      return formatFixInt(params.teamPowerFix);
    case "difficulty":
      return formatFixInt(params.difficultyFix);
    case "roll":
      return formatFixInt(params.rollFix);
    case "injuryCount":
      return String(params.injuryCount);
    default:
      throw new RulesError(`未知のログテンプレ プレースホルダ "${name}"`);
  }
}

/** Fix を整数部だけの文字列にする(`rules/exploration.ts` の同名関数と同じ規約)。 */
function formatFixInt(value: Fix): string {
  return String(floorDivInt(toRaw(value), FIX_SCALE));
}

// --- 6. 効果プリミティブ(GDD 11.1 [2026-07-27追補]・§3) --------------------

/** {@link destroyRecords} の指定(GDD 12.1 追補の `destroyRecords{medium, scope}`)。 */
export interface DestroyRecordsSpec {
  readonly medium: DestroyRecordsMedium;
  readonly scope: DestroyRecordsScope;
}

/** {@link destroyRecords} の結果(全て ID 昇順)。 */
export interface DestroyRecordsResult {
  readonly state: GameState;
  /** 取り除いた codify entity の ID。 */
  readonly destroyedRecordIds: readonly EntityId[];
  /** 記録が 0 枚になった tech(= 未成文状態へ戻った)。 */
  readonly uncodifiedTechIds: readonly EntityId[];
  /** 生存保持者ゼロ かつ 記録ゼロ で周回内喪失した tech。 */
  readonly lostTechIds: readonly EntityId[];
}

/**
 * 記録を破壊する(GDD 11.1 [2026-07-27追補] の焼失セマンティクス・§3)。
 *
 * 対象は**完成済みの記録だけ**(作業中の codify entity は「記録」ではないので
 * 燃えない。GDD 11.1 追補が「記録1枚」を成果物として定義している)。
 *
 * 手順は固定順(state のバイト列を決めるため):
 *   (1) 対象を選ぶ(codify entity の ID 昇順 → scope で絞る)
 *   (2) ID 昇順に取り除く
 *   (3) 影響を受けた tech を ID 昇順に見て、未成文化 / 喪失を判定する
 *
 * @throws {RulesError} scope が `flammable` なのに content に `recordMedia` が無い場合
 */
export function destroyRecords(
  state: GameState,
  content: EngineContent,
  spec: DestroyRecordsSpec,
  tick: number,
): DestroyRecordsResult {
  const targets = selectRecordsToDestroy(state, content, spec);
  let next = state;
  const destroyedRecordIds: EntityId[] = [];
  const affectedTechIds = new Set<EntityId>();
  for (const record of targets) {
    next = removeEntity(next, record.id);
    destroyedRecordIds.push(record.id);
    affectedTechIds.add(record.techId);
  }

  const uncodifiedTechIds: EntityId[] = [];
  const lostTechIds: EntityId[] = [];
  for (const techId of [...affectedTechIds].sort(compareUtf16)) {
    if (isStillCodified(next, techId)) continue;
    uncodifiedTechIds.push(techId);
    // 「生存保持者ゼロ かつ 記録ゼロ」の判定は死亡起因の喪失と同一実装(§3)。
    const applied = applyTechLossIfOrphaned(next, content, techId, tick, null);
    next = applied.state;
    if (applied.outcome !== undefined) lostTechIds.push(techId);
  }
  return { state: next, destroyedRecordIds, uncodifiedTechIds, lostTechIds };
}

/** その tech の完成済み記録がまだ 1 枚以上あるか(`rules/codify.ts` の `isCodified` と同義)。 */
function isStillCodified(state: GameState, techId: EntityId): boolean {
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.techId === techId && codify.completedTick !== null) return true;
  }
  return false;
}

/**
 * 破壊対象の記録(codify entity の ID 昇順)。
 *
 * `flammable` は balance の `recordMedia.byMedium[*].flammable` を見る。
 * **content に `recordMedia` が無い盤面で `flammable` を指定するのは reject**
 * である(可燃かどうかが決まらないのに「可燃なものを燃やす」は解釈不能で、
 * 黙って 0 件にすると火災が静かに不発になる)。
 */
function selectRecordsToDestroy(
  state: GameState,
  content: EngineContent,
  spec: DestroyRecordsSpec,
): readonly CodifyState[] {
  const media = content.recordMedia;
  if (spec.scope === "flammable" && media === undefined) {
    throw new RulesError(
      "destroyRecords(scope=flammable)には balance の recordMedia ブロックが必要" +
        "(可燃かどうかが決まらない・GDD 11.1 [2026-07-27追補])",
    );
  }
  const matched: CodifyState[] = [];
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.completedTick === null) continue;
    if (spec.medium !== "any" && codify.medium !== spec.medium) continue;
    if (spec.scope === "flammable" && !isFlammable(content, codify.medium)) continue;
    matched.push(codify);
  }
  if (spec.scope !== "oldest") return matched;
  // 最も古い 1 枚 = 完成 tick 昇順 → ID 昇順(matched は既に ID 昇順)。
  let oldest: CodifyState | undefined;
  for (const codify of matched) {
    if (oldest === undefined) {
      oldest = codify;
      continue;
    }
    const oldestTick = oldest.completedTick ?? 0;
    const candidateTick = codify.completedTick ?? 0;
    if (candidateTick < oldestTick) oldest = codify;
  }
  return oldest === undefined ? [] : [oldest];
}

function isFlammable(content: EngineContent, medium: RecordMedium): boolean {
  const media = content.recordMedia;
  return media !== undefined && media.byMedium[medium].flammable;
}

/**
 * スナップショットへ焼き込まれた効果を 1 件適用する(帰還 tick・段60)。
 *
 * **content を引き直さない**のが原則だが、`destroyRecords` の可燃判定だけは
 * balance の `recordMedia` を読む。これは「イベントが起きたかどうか」ではなく
 * 「いま盤面にある記録のどれが可燃か」という**現在の盤面の性質**なので、
 * GDD 12.5-7 の再参照禁止(= 派遣時の判定結果を content 変更で動かさない)
 * の対象外である(保護加入で `townParams` を読むのと同じ線引き・
 * rules/exploration.ts §1)。
 *
 * @throws {RulesError} 未知の効果種別 / 未知の medium・scope の場合
 */
export function applyDispatchEffect(
  state: GameState,
  content: EngineContent,
  effect: DispatchEffect,
  tick: number,
): GameState {
  if (effect.kind !== "destroyRecords") {
    throw new RulesError(`未知の派遣効果 "${String(effect.kind)}"`);
  }
  if (!isDestroyRecordsMedium(effect.medium)) {
    throw new RulesError(`destroyRecords の medium "${effect.medium}" が未知(GDD 11.1 追補)`);
  }
  if (!isDestroyRecordsScope(effect.scope)) {
    throw new RulesError(`destroyRecords の scope "${effect.scope}" が未知(GDD 11.1 追補)`);
  }
  return destroyRecords(state, content, { medium: effect.medium, scope: effect.scope }, tick).state;
}
