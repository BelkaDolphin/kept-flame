// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 大移動(Exodus)/ 周回シード / 継承点 — M28
//   GDD 10.2(2 プール)/ 10.3(継承点)/ 10.4(死蔵回避)/ 10.5(周回シード)/
//   11.4-6(青天井禁止)/ 11.1 追補(媒体別重み)
//
// ===========================================================================
// 0. このモジュールは tick ループに**乗らない**
// ===========================================================================
//   大移動も継承ボーナスの購入も**明示コマンド起点**であり、`advance.ts` /
//   `scheduler.ts` からは 1 度も呼ばれない。よって既存 conformance シナリオは
//   本モジュールを踏みようがなく、golden vector 73 本のバイト列は構造的に
//   動かない(`rules/reclaim.ts` §1 が「開墾は state 権威」で得たのと同じ性質を、
//   こちらは「呼ばれる経路が commands.ts しか無い」という形で得ている)。
//
// ===========================================================================
// 1. 2 プールの「競合」とは何か、そして解決順(**本節が仕様の正本**)
// ===========================================================================
//   GDD 10.2 の 2 プールは容量式どうしが結合していない:
//     石版プール容量 = ceil(想定石版総数(到達エラ) × 0.35) + 継承点ボーナス
//     乗員定員       = ceil(生存人数 × 0.5)               + 継承ボーナス
//   前者は到達エラ(静的テーブル)だけ、後者は生存人数だけで決まる。
//   では何が「競合」なのかというと、**同じ (B) 知識を石版で救うか人で救うか**で
//   ある(GDD 10.2「石版を多く積むか、腕利きを多く連れるか、どのBを諦めるか」)。
//   したがって決定論の要点は「容量の取り合い」ではなく **(B) 喪失判定の
//   入力集合を作る順序**にある。本モジュールは次の 4 段を仕様として固定する:
//
//     段1: 入力を正準化する — 両プールとも ID の UTF-16 昇順・重複除去。
//          (呼び出し側が渡す並びに結果を依存させない)
//     段2: **乗員プールを先に解決する** — 生存住民のうち先頭 `crewCap` 名を
//          採用し、超過分を落とす。先に解く理由は段4 が「採用済みの乗員集合」を
//          必要とするからで、逆順にしても容量は変わらないが、
//          「どちらを先に確定したか」を仕様として片方に固定しないと
//          報告(何が落ちたか)の解釈が 2 通りになる。
//     段3: 石版プールを解決する — ID 昇順に走査し、**残容量に収まる記録だけを
//          採用する(first-fit)**。収まらない記録は飛ばして次を試す。
//          「最初に溢れた時点で以降を全部落とす(前詰め打ち切り)」にしないのは、
//          石板 1 枚(重み 1.0)で打ち切られると後ろの紙(0.25)が全部落ちる =
//          媒体別重み(GDD 10.2 追補)を導入した意味が消えるため。
//          first-fit は走査順が ID 昇順に固定されているので一意 = 決定論。
//     段4: (B) 喪失を判定する — 「carried な記録がある」か「carried な乗員が
//          保持している」のどちらも成り立たない (B) tech が**永久喪失**。
//
//   段2/段3 の**超過分は落とす(clamp)**が、`commands.ts` は落ちたものが
//   1 つでもあれば `exodusCapacityExceeded` で**拒否する**。理由は commands.ts §3
//   の「黙って無視しない」で、UI のプレビューは本モジュールの
//   {@link resolveExodusPlan} を直接呼んで「何が落ちるか」を先に見せられる。
//
// ===========================================================================
// 2. 周回シードの導出(GDD 10.5)と「バイト同一」の意味
// ===========================================================================
//   GDD 10.5: `新worldSeed = hash(前worldSeed, 周回回数, 累計継承点)` の純粋関数
//   導出(`Date.now`/`Math.random` 不使用)。実装は ADR-007 のドメイン分離 hash
//   `hash(worldSeed, domainTag, salt...)` をそのまま使い、domainTag は
//   レジストリ登録済みの `exodus`、salt = (周回回数, 累計継承点) とする。
//
//   出力は**文字列**である(`GameState.worldSeed` が文字列だから)。
//   16 進 8 桁への変換は `Number.prototype.toString(16)` を使わず
//   {@link HEX_DIGITS} の表引きで組む —— 桁数・大小文字・前置ゼロが実装依存に
//   ならないことを目で確認できる形にしておくためで、これが検収条件
//   「同一入力でバイト同一」を**書式の側からも**保証する部分である。
//
//   GDD 10.5「周回時 RNG カウンタを全ドメイン 0 リセット」は
//   {@link executeExodus} が次周 state の `rngState` を空にすることで満たす
//   (空 = まだ 1 度も引いていない = 遅延初期化・state.ts §4)。
//
// ===========================================================================
// 3. 次周 state に何が載り、何が載らないか
// ===========================================================================
//   載る  : 連れて行った住民(bond / memoir / techMemory ごと)・積んだ記録
//           (codify entity)とその tech の研究完了(GDD 5「持ち出し石版分の
//           テックが初期解禁」)・資源 entity(**在庫は 0 + startingStock
//           ボーナス**)・過去に永久喪失した (B) の記録・地形(content から新規)
//   載らない: 施設(本拠を捨てて出るので置いていく)・衛星拠点・帰還ログ・
//           未帰還の派遣(`commands.ts` が派遣中の大移動を拒否する)・
//           置き去りにした住民・積まなかった記録
//
//   **`tick` はリセットしない。** GDD 10.5 が明示的にリセットを求めているのは
//   RNG カウンタだけであり、tick を 0 に戻すと `ResidentLife.bornTick` /
//   memoirLog の tick / `CodifyState.completedTick` を全て rebase する必要が
//   出る(直列化は負の tick を受け付けない)。周回をまたいで単調な時間軸を保つ
//   方が、オフライン差分(ADR-026 の単調時刻)とも整合する。
//
//   **施設を載せない**帰結として、次周 state は施設ゼロの盤面になる。開始施設を
//   どう置くかは新規ゲーム生成の担当(`src/newGame.ts` §0 が「ロードマップに
//   担当タスクが無い」と明示している未割当領域)であり、engine はそこへ踏み込ま
//   ない —— 踏み込むと「初期盤面の定義」が engine と composition root の 2 箇所に
//   できてしまう。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import {
  FIX_ZERO,
  addFix,
  fixFromInt,
  floorDivFix,
  floorDivInt,
  mulFix,
  mulFixInt,
  toRaw,
  type Fix,
} from "../fp";
import { DOMAIN_TAGS } from "../rng/domainTags";
import { fnv1a32, hashRngDomain } from "../rng/fnv1a32";
import {
  EMPTY_RENDERED_LOGS,
  entitiesOfKind,
  inheritTierOf,
  isAliveResident,
  livingResidents,
  type CodifyState,
  type EntityId,
  type EntityState,
  type GameState,
  type GameStateMeta,
  type InheritTierEntry,
  type InheritTrack,
  type ProgressionState,
  type ResearchState,
  type ResidentState,
  type ResourceState,
  type TechMemoryState,
} from "../state/state";
import { createGameState, setField, setProgression } from "../state/update";
import { completedRecords } from "./codify";
import { initialTerrain } from "./reclaim";
import { heldTechIdsOf, techMasteryOf } from "./techMemory";
import { erasInOrder } from "./techTree";
import {
  RulesError,
  lossClassOfTech,
  requireExodusParams,
  type EngineContent,
  type ExodusParams,
} from "./types";

// --- 0. 周回シードの導出(GDD 10.5・§2)------------------------------------

/** 16 進 1 桁の表(小文字固定)。桁の書式を実装依存にしないための表引き(§2)。 */
const HEX_DIGITS = "0123456789abcdef";

/** salt 要素に載せられる上界(uint32)。超える値は黙って折り返させない(§2)。 */
const SALT_UINT32_MAX = 4_294_967_295;

/** uint32 を 16 進 8 桁(小文字・前置ゼロあり)の文字列にする(§2)。 */
function toHex8(value: number): string {
  let out = "";
  for (let shift = 28; shift >= 0; shift -= 4) {
    out += HEX_DIGITS.charAt((value >>> shift) & 0xf);
  }
  return out;
}

function requireSaltUint32(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > SALT_UINT32_MAX) {
    throw new RulesError(
      `deriveNextWorldSeed: ${what} ${String(value)} が uint32 の範囲` +
        `(0〜${String(SALT_UINT32_MAX)})の外。salt へ載せる際に黙って折り返すと` +
        "別入力が同じシードへ潰れる(GDD 10.5)",
    );
  }
}

/**
 * 次周の worldSeed を導出する(GDD 10.5
 * `新worldSeed = hash(前worldSeed, 周回回数, 累計継承点)`)。
 *
 * **同じ 3 入力からは常に同じ文字列**(= バイト同一)であり、時刻も乱数も読まない。
 * 出力形式は `"r" + 周回回数(10進) + "-" + hash の 16 進 8 桁`。周回回数を
 * 平文で残すのは、シードを共有(GDD 10.7「シード共有で擬似競争」)したときに
 * 「何周目の世界か」が人間に読めるようにするためで、hash の材料には既に入って
 * いるので一意性には影響しない。
 *
 * @param previousWorldSeed 現行周回の worldSeed
 * @param runCount 完了した大移動の回数(次周の値 = 現行 + 1)
 * @param cumulativeInheritPoints 累計獲得した継承点(**購入で減らない値**)
 * @throws {RulesError} 周回回数 / 累計継承点が uint32 の範囲外の場合
 */
export function deriveNextWorldSeed(
  previousWorldSeed: string,
  runCount: number,
  cumulativeInheritPoints: number,
): string {
  requireSaltUint32(runCount, "周回回数");
  requireSaltUint32(cumulativeInheritPoints, "累計継承点");
  const hashed = hashRngDomain(fnv1a32(previousWorldSeed), DOMAIN_TAGS.exodus, [
    runCount,
    cumulativeInheritPoints,
  ]);
  return `r${String(runCount)}-${toHex8(hashed)}`;
}

// --- 1. 到達エラと成文化率(GDD 10.3 の獲得式の入力)-------------------------

/**
 * 到達エラの `order`(GDD 10.3 の「到達エラ」)。**完了した研究の tech が属する
 * エラの order の最大値**であり、1 本も完了していなければ 0。
 *
 * GDD は「到達エラ」を機械可読には定義していない(代表周回対比表に
 * 「到達E3(30)」とあるだけ)。壁テック(`era.gateTechId`)の完了を基準にすると
 * 「E3 の壁を越えた = E4 へ到達」となり MVP に E4 が無い(GDD 13.4)ため
 * 表と食い違うので、**そのエラの tech を 1 本でも完了していれば到達**と読む。
 * 単調(研究が進めば下がらない)であり GDD 11.4-6「登攀が単調改善」と整合する。
 */
export function reachedEraOrder(state: GameState, content: EngineContent): number {
  let best = 0;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick === null) continue;
    const order = eraOrderOfTech(content, research.techId);
    if (order > best) best = order;
  }
  return best;
}

/** その tech が属するエラの order(不明なら 0)。 */
function eraOrderOfTech(content: EngineContent, techId: EntityId): number {
  const eraId = content.techDefs.get(techId)?.eraId;
  if (eraId === undefined) return 0;
  return content.eraDefs?.get(eraId)?.order ?? 0;
}

/** 到達エラの eraId(未到達なら null)。容量式の静的テーブル引きに使う。 */
function reachedEraId(state: GameState, content: EngineContent): string | null {
  const order = reachedEraOrder(state, content);
  if (order === 0) return null;
  for (const era of erasInOrder(content)) {
    if (era.order === order) return era.id;
  }
  return null;
}

/**
 * 成文化率(**パーセント**の Fix・GDD 10.3 の `成文化率(%)`)。
 *
 * 分母 = **研究が完了した tech の本数**、分子 = そのうち完了済み記録を 1 枚以上
 * 持つ本数。1 本も完了していなければ 0。
 *
 * 分母を「content の全 tech 本数」にしない理由は GDD 10.2 が容量式について
 * 述べているのと同じ —— 週次の additive な葉テック追加(GDD 12.4)で分母が動くと、
 * 同じセーブの継承点が content 版で変わる。「知っていることのうちどれだけ書き
 * 残したか」という中核フック(GDD 2)の読みとも一致する。
 */
export function codifiedRatePercentFix(state: GameState): Fix {
  const codifiedTechIds = new Set<EntityId>();
  for (const record of completedRecords(state)) {
    codifiedTechIds.add(record.techId);
  }
  let completed = 0;
  let codified = 0;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick === null) continue;
    completed++;
    if (codifiedTechIds.has(research.techId)) codified++;
  }
  if (completed === 0) return FIX_ZERO;
  return floorDivFix(fixFromInt(codified * 100), fixFromInt(completed));
}

// --- 2. 継承点(GDD 10.3 / 10.4 / 11.4-6)-----------------------------------

/** `round(x)`(四捨五入・非負の Fix 前提)。`floor(x + 0.5)` を整数演算で。 */
function roundFixToInt(value: Fix): number {
  return floorDivInt(toRaw(value) + 500_000, 1_000_000);
}

/** `ceil(x)`(非負の Fix 前提)を整数で。 */
function ceilFixToInt(value: Fix): number {
  return floorDivInt(toRaw(value) + 999_999, 1_000_000);
}

/** 生存している住民の数(GDD 10.3 の「生存住民数」)。 */
function livingPopulation(state: GameState): number {
  return livingResidents(state).length;
}

/**
 * この周回を終えたときに獲得する継承点(GDD 10.3
 * `継承点 = round(到達エラ × 10 + 成文化率(%) × 0.5 + 生存住民数 × 2)`)。
 *
 * 代表周回(GDD 10.3 の表): 到達E3 + 成文化率60% + 生存12人
 *   = 3×10 + 60×0.5 + 12×2 = 30 + 30 + 24 = **84 点**。
 *
 * 中間積の値域: 成文化率は高々 100(raw 1e8)、係数は 1 未満(raw < 1e6)なので
 * `mulFix` の中間積は 1e14 未満 = 2^53 未満で厳密(fp.ts 補題 L1)。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function earnedInheritPoints(state: GameState, content: EngineContent): number {
  return earnedInheritPointsWith(state, content, requireExodusParams(content));
}

function earnedInheritPointsWith(
  state: GameState,
  content: EngineContent,
  params: ExodusParams,
): number {
  const eraTermFix = mulFixInt(params.eraPointsFix, reachedEraOrder(state, content));
  const codifyTermFix = mulFix(codifiedRatePercentFix(state), params.codifyRatePointsFix);
  const survivorTermFix = mulFixInt(params.survivorPointsFix, livingPopulation(state));
  return roundFixToInt(addFix(addFix(eraTermFix, codifyTermFix), survivorTermFix));
}

/**
 * 各系統の上限段数(GDD 10.3「各ボーナスに上限段階」= 段階コスト列の長さ)。
 * **これが「青天井にならない」(GDD 11.4-6)の構造的な根拠**である。
 */
export function inheritTierMax(params: ExodusParams): number {
  return params.tierCosts.length;
}

/**
 * 購入済み n 段の状態で**次の 1 段**を買うコスト(GDD 10.3
 * `cost(n) = 50 × 1.5^n` をオーサリング時展開した {@link ExodusParams.tierCosts})。
 * 上限段に達していれば null。
 *
 * @throws {RulesError} 購入済み段数が 0 以上の整数でない場合
 */
export function inheritTierCost(params: ExodusParams, purchasedTier: number): number | null {
  if (!Number.isSafeInteger(purchasedTier) || purchasedTier < 0) {
    throw new RulesError(
      `inheritTierCost: 購入済み段数 ${String(purchasedTier)} が 0 以上の整数でない`,
    );
  }
  return params.tierCosts[purchasedTier] ?? null;
}

/** これまでに継承ボーナスへ費やした点(= 購入済み全段のコストの総和)。 */
export function spentInheritPoints(progression: ProgressionState, params: ExodusParams): number {
  let spent = 0;
  for (const entry of progression.inheritTiers) {
    for (let n = 0; n < entry.tier; n++) {
      spent += params.tierCosts[n] ?? 0;
    }
  }
  return spent;
}

/**
 * いま使える継承点の残高 = `累計獲得 − Σ購入済み段のコスト`(GDD 10.3 / 10.4)。
 * 累計を減らさないのは GDD 10.5 のシード材料を巻き戻さないため(state.ts の
 * [M28] 節)。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function availableInheritPoints(state: GameState, content: EngineContent): number {
  const params = requireExodusParams(content);
  return state.progression.cumulativeInheritPoints - spentInheritPoints(state.progression, params);
}

/**
 * その系統の現在のボーナス量 = `購入済み段数 × 1 段あたり`(GDD 10.3)。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function inheritBonusOf(
  state: GameState,
  content: EngineContent,
  track: InheritTrack,
): number {
  const params = requireExodusParams(content);
  return inheritTierOf(state, track) * params.trackBonusPerTier[track];
}

/**
 * 継承ボーナスを 1 段購入する(GDD 10.3)。
 *
 * 事前検査(content の有無・上限段・残高)は呼び出し側 = `commands.ts` の責務で
 * あり、ここへ来た時点で不整合なら **RulesError で止める**(rules/reclaim.ts の
 * `reclaimCell` と同じ層分け)。
 *
 * @throws {RulesError} content に exodus ブロックが無い / 上限段 / 残高不足
 */
export function purchaseInheritTier(
  state: GameState,
  content: EngineContent,
  track: InheritTrack,
): GameState {
  const params = requireExodusParams(content);
  const current = inheritTierOf(state, track);
  const cost = inheritTierCost(params, current);
  if (cost === null) {
    throw new RulesError(
      `purchaseInheritTier: 系統 "${track}" は既に上限段(${String(inheritTierMax(params))} 段)` +
        "に達している(GDD 10.3 の上限クランプ)",
    );
  }
  const available = availableInheritPoints(state, content);
  if (available < cost) {
    throw new RulesError(
      `purchaseInheritTier: 継承点が足りない(必要 ${String(cost)} / 残高 ${String(available)})`,
    );
  }
  return setProgression(state, {
    runCount: state.progression.runCount,
    cumulativeInheritPoints: state.progression.cumulativeInheritPoints,
    inheritTiers: withTierIncremented(state.progression.inheritTiers, track),
  });
}

/** 系統の段数を +1 した一覧を返す(track 昇順・重複なしを保つ)。 */
function withTierIncremented(
  tiers: readonly InheritTierEntry[],
  track: InheritTrack,
): readonly InheritTierEntry[] {
  const next: InheritTierEntry[] = [];
  let inserted = false;
  for (const entry of tiers) {
    if (entry.track === track) {
      next.push({ track, tier: entry.tier + 1 });
      inserted = true;
      continue;
    }
    if (!inserted && compareUtf16(track, entry.track) < 0) {
      next.push({ track, tier: 1 });
      inserted = true;
    }
    next.push(entry);
  }
  if (!inserted) next.push({ track, tier: 1 });
  return next;
}

// --- 3. 2 プールの容量(GDD 10.2)-------------------------------------------

/**
 * キャラバン容量 = `ceil(想定石版総数(到達エラ) × 0.35) + 継承点ボーナス`
 * (GDD 10.2)。単位は**石版換算枠**(石板 1.0 / 紙 0.25・GDD 10.2 追補)なので
 * Fix で返す(値そのものは整数)。
 *
 * 「想定石版総数」は content の静的テーブル(`ExodusParams.expectedTabletsByEra`)
 * であり、実プレイの記録枚数も content の tech 本数も数えない(types.ts の
 * {@link ExodusParams} の doc 参照)。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function caravanCapacityFix(state: GameState, content: EngineContent): Fix {
  const params = requireExodusParams(content);
  const eraId = reachedEraId(state, content);
  const expected = eraId === null ? 0 : (params.expectedTabletsByEra.get(eraId) ?? 0);
  const base = ceilFixToInt(mulFixInt(params.caravanRatioFix, expected));
  return fixFromInt(
    base + inheritTierOf(state, "caravanCapacity") * params.trackBonusPerTier.caravanCapacity,
  );
}

/**
 * 乗員定員 = `ceil(生存人数 × 0.5) + 継承ボーナス`(GDD 10.2)。
 * 生存人数には**置き去りにする側も含む**(定員の分母は移動前の人口)。
 *
 * @throws {RulesError} content に exodus ブロックが無い場合
 */
export function crewCapacity(state: GameState, content: EngineContent): number {
  const params = requireExodusParams(content);
  const base = ceilFixToInt(mulFixInt(params.crewRatioFix, livingPopulation(state)));
  return base + inheritTierOf(state, "crewCapacity") * params.trackBonusPerTier.crewCapacity;
}

// --- 4. ナップサックの解決(§1)---------------------------------------------

/** プレイヤーの持ち出し選択(GDD 10.2 の 2 プール)。並び順は問わない。 */
export interface ExodusPlan {
  /** 積む記録 = **完了済みの codify entity** の ID(石版プール)。 */
  readonly recordIds: readonly EntityId[];
  /** 連れて行く住民の ID(乗員プール)。 */
  readonly crewIds: readonly EntityId[];
}

/** 空の選択(何も積まず誰も連れて行かない)。 */
export const EMPTY_EXODUS_PLAN: ExodusPlan = { recordIds: [], crewIds: [] };

/** {@link resolveExodusPlan} の結果。UI のプレビューと commands.ts が同じ値を読む。 */
export interface ExodusResolution {
  /** 積めた記録(ID 昇順)。 */
  readonly carriedRecordIds: readonly EntityId[];
  /** 容量に入らず落ちた記録(ID 昇順・GDD 10.2「長夜に還る」)。 */
  readonly droppedRecordIds: readonly EntityId[];
  /** 連れて行けた住民(ID 昇順)。 */
  readonly carriedCrewIds: readonly EntityId[];
  /** 定員に入らず落ちた住民(ID 昇順・置き去り)。 */
  readonly droppedCrewIds: readonly EntityId[];
  /** 積んだ記録が消費した石版換算枠の合計。 */
  readonly usedCaravanWeightFix: Fix;
  /** キャラバン容量(GDD 10.2)。 */
  readonly caravanCapacityFix: Fix;
  /** 乗員定員(GDD 10.2)。 */
  readonly crewCapacity: number;
  /**
   * この大移動で**永久喪失**する (B) tech(ID 昇順・GDD 10.2 / 7.4)。
   * 「積んだ記録にも無く、連れて行く住民の誰も保持していない」(B) 技術。
   */
  readonly lostRareTechIds: readonly EntityId[];
  /** この大移動で獲得する継承点(GDD 10.3)。 */
  readonly earnedInheritPoints: number;
}

/** ID 列を昇順・重複なしへ正準化する(段1)。 */
function normalizeIds(ids: readonly EntityId[]): readonly EntityId[] {
  const sorted = [...ids].sort(compareUtf16);
  const out: EntityId[] = [];
  for (const id of sorted) {
    if (out.length > 0 && out[out.length - 1] === id) continue;
    out.push(id);
  }
  return out;
}

/**
 * 完了済み記録(codify entity)を引く。
 *
 * @throws {RulesError} codify entity でない / まだ作業中の場合
 */
function requireCompletedRecord(state: GameState, recordId: EntityId): CodifyState {
  const entity = state.entityStateById.get(recordId);
  if (entity === undefined || entity.kind !== "codify") {
    throw new RulesError(`resolveExodusPlan: "${recordId}" は codify entity(記録)ではない`);
  }
  if (entity.completedTick === null) {
    throw new RulesError(
      `resolveExodusPlan: 記録 "${recordId}" はまだ作業中なので積めない(GDD 10.2 は完成した記録のみ)`,
    );
  }
  return entity;
}

/**
 * 連れて行ける住民を引く(生存していること)。
 *
 * @throws {RulesError} resident entity でない / 死亡している場合
 */
function requireCrewResident(state: GameState, residentId: EntityId): ResidentState {
  const entity = state.entityStateById.get(residentId);
  if (entity === undefined || entity.kind !== "resident") {
    throw new RulesError(`resolveExodusPlan: "${residentId}" は resident entity ではない`);
  }
  if (!isAliveResident(entity)) {
    throw new RulesError(`resolveExodusPlan: 住民 "${residentId}" は死亡している(連れて行けない)`);
  }
  return entity;
}

/** 記録 1 枚が消費する石版換算枠(GDD 10.2 追補の媒体別重み)。 */
function caravanWeightOfRecord(content: EngineContent, record: CodifyState): Fix {
  const media = content.recordMedia;
  if (media === undefined) {
    throw new RulesError(
      "content に recordMedia ブロックが無いので記録の媒体別重みが求まらない" +
        "(GDD 10.2 [2026-07-27追補])",
    );
  }
  return media.byMedium[record.medium].caravanWeightFix;
}

/**
 * 持ち出し選択を決定論で解決する(§1 の段1〜段4)。**state は変更しない**。
 *
 * 容量/定員の超過分は落とす(clamp)。「落とす」ことを黙って行わないために、
 * 何が落ちたかは {@link ExodusResolution.droppedRecordIds} /
 * {@link ExodusResolution.droppedCrewIds} に必ず載る。
 *
 * @throws {RulesError} content に exodus / recordMedia ブロックが無い場合
 * @throws {RulesError} 参照が壊れている(未完了の記録・死亡した住民・種別違い)場合
 */
export function resolveExodusPlan(
  state: GameState,
  content: EngineContent,
  plan: ExodusPlan,
): ExodusResolution {
  const params = requireExodusParams(content);

  // 段1: 正準化。
  const recordIds = normalizeIds(plan.recordIds);
  const crewIds = normalizeIds(plan.crewIds);

  // 段2: 乗員プール(先に解決する・§1)。
  const cap = crewCapacity(state, content);
  const carriedCrewIds: EntityId[] = [];
  const droppedCrewIds: EntityId[] = [];
  for (const residentId of crewIds) {
    requireCrewResident(state, residentId);
    if (carriedCrewIds.length < cap) carriedCrewIds.push(residentId);
    else droppedCrewIds.push(residentId);
  }

  // 段3: 石版プール(ID 昇順の first-fit・§1)。
  const capacityFix = caravanCapacityFix(state, content);
  const carriedRecordIds: EntityId[] = [];
  const droppedRecordIds: EntityId[] = [];
  const carriedTechIds = new Set<EntityId>();
  let usedFix = FIX_ZERO;
  for (const recordId of recordIds) {
    const record = requireCompletedRecord(state, recordId);
    const nextUsedFix = addFix(usedFix, caravanWeightOfRecord(content, record));
    if (toRaw(nextUsedFix) <= toRaw(capacityFix)) {
      carriedRecordIds.push(recordId);
      carriedTechIds.add(record.techId);
      usedFix = nextUsedFix;
    } else {
      droppedRecordIds.push(recordId);
    }
  }

  // 段4: (B) 喪失判定。
  const crewHeldTechIds = new Set<EntityId>();
  for (const residentId of carriedCrewIds) {
    for (const techId of heldTechIdsOf(state, residentId)) {
      crewHeldTechIds.add(techId);
    }
  }

  return {
    carriedRecordIds,
    droppedRecordIds,
    carriedCrewIds,
    droppedCrewIds,
    usedCaravanWeightFix: usedFix,
    caravanCapacityFix: capacityFix,
    crewCapacity: cap,
    lostRareTechIds: collectLostRareTechIds(state, content, carriedTechIds, crewHeldTechIds),
    earnedInheritPoints: earnedInheritPointsWith(state, content, params),
  };
}

/**
 * 永久喪失する (B) tech(ID 昇順)。「この周回で知っていた (B)」= 研究が完了して
 * いる か 生存保持者が居る tech のうち、記録も保持者も持ち出せなかったもの。
 */
function collectLostRareTechIds(
  state: GameState,
  content: EngineContent,
  carriedTechIds: ReadonlySet<EntityId>,
  crewHeldTechIds: ReadonlySet<EntityId>,
): readonly EntityId[] {
  const known = new Set<EntityId>();
  for (const research of entitiesOfKind(state, "research")) {
    // 既に永久喪失している tech を再度「今回失った」と数えない。
    if (research.loss?.irreversible === true) continue;
    if (research.completedTick !== null) known.add(research.techId);
  }
  for (const resident of livingResidents(state)) {
    for (const techId of heldTechIdsOf(state, resident.id)) {
      known.add(techId);
    }
  }
  const lost: EntityId[] = [];
  for (const techId of [...known].sort(compareUtf16)) {
    if (lossClassOfTech(content, techId) !== "rareIrreversible") continue;
    if (carriedTechIds.has(techId) || crewHeldTechIds.has(techId)) continue;
    lost.push(techId);
  }
  return lost;
}

// --- 5. おまかせ選択(決定論ヒューリスティック)-------------------------------

/**
 * 決定論の「おまかせ」持ち出し選択。**最適解ではない**(0-1 ナップサックの最適化は
 * しない)貪欲であり、`assist/` の 80% 基準(GDD 2.1)を課される正式なアシストとは
 * 別物である —— 大移動は 1 周に 1 度の意思決定なので、UI(M33)と sim ボット
 * (M36)が「とりあえず妥当な初期選択」を得るための出発点として置いてある。
 *
 * 規則(いずれも決定論・同点は ID 昇順):
 *   乗員 : 「その人しか持っていない (B)」の本数が多い順に定員まで。
 *   記録 : (B) を優先し、同クラス内では**軽い媒体**(紙 0.25)を先に見て
 *          first-fit で詰める(枠あたりの救出本数が最大化される方向)。
 *
 * @throws {RulesError} content に exodus / recordMedia ブロックが無い場合
 */
export function recommendExodusPlan(state: GameState, content: EngineContent): ExodusPlan {
  requireExodusParams(content);

  const crewCandidates = livingResidents(state)
    .map((resident) => ({
      id: resident.id,
      uniqueRareCount: uniqueRareCountOf(state, content, resident.id),
    }))
    .sort((a, b) =>
      a.uniqueRareCount === b.uniqueRareCount
        ? compareUtf16(a.id, b.id)
        : b.uniqueRareCount - a.uniqueRareCount,
    );
  const cap = crewCapacity(state, content);
  const crewIds: EntityId[] = [];
  for (const candidate of crewCandidates) {
    if (crewIds.length >= cap) break;
    crewIds.push(candidate.id);
  }

  const recordCandidates = completedRecords(state)
    .map((record) => ({
      id: record.id,
      rareRank: lossClassOfTech(content, record.techId) === "rareIrreversible" ? 0 : 1,
      weightRaw: toRaw(caravanWeightOfRecord(content, record)),
    }))
    .sort((a, b) => {
      if (a.rareRank !== b.rareRank) return a.rareRank - b.rareRank;
      if (a.weightRaw !== b.weightRaw) return a.weightRaw - b.weightRaw;
      return compareUtf16(a.id, b.id);
    });
  const capacityRaw = toRaw(caravanCapacityFix(state, content));
  const recordIds: EntityId[] = [];
  let usedRaw = 0;
  for (const candidate of recordCandidates) {
    if (usedRaw + candidate.weightRaw > capacityRaw) continue;
    recordIds.push(candidate.id);
    usedRaw += candidate.weightRaw;
  }

  return { recordIds: normalizeIds(recordIds), crewIds: normalizeIds(crewIds) };
}

/** その住民だけが保持している (B) tech の本数(`rareAssetCountOf` と同じ着想)。 */
function uniqueRareCountOf(state: GameState, content: EngineContent, residentId: EntityId): number {
  let count = 0;
  for (const techId of heldTechIdsOf(state, residentId)) {
    if (lossClassOfTech(content, techId) !== "rareIrreversible") continue;
    let otherHolder = false;
    for (const other of livingResidents(state)) {
      if (other.id === residentId) continue;
      if (toRaw(techMasteryOf(state, other.id, techId)) > 0) otherHolder = true;
    }
    if (!otherHolder) count++;
  }
  return count;
}

// --- 6. 大移動の実行(§3)----------------------------------------------------

/** {@link executeExodus} の追加入力。 */
export interface ExodusOptions {
  /**
   * 次周の worldSeed を明示指定する(GDD 10.5「UIで任意シード文字列入力も併設」)。
   * 省略時は {@link deriveNextWorldSeed} が導出する。
   */
  readonly worldSeedOverride?: string;
}

/**
 * 大移動を実行し、**次周の GameState を新しく組み立てて返す**(§3)。純関数。
 *
 * 事前検査(content の有無・容量超過・未帰還の派遣)は呼び出し側 =
 * `commands.ts` の責務であり、ここへ来た時点で不整合なら RulesError で止める。
 *
 * @throws {RulesError} content に exodus / recordMedia ブロックが無い場合
 * @throws {RulesError} 未帰還の派遣が残っている場合(帰還先の盤面が存在しない)
 * @throws {RulesError} 参照が壊れている場合({@link resolveExodusPlan} 経由)
 */
export function executeExodus(
  state: GameState,
  content: EngineContent,
  plan: ExodusPlan,
  options: ExodusOptions = {},
): GameState {
  if (state.dispatchSnapshots.length > 0) {
    throw new RulesError(
      "executeExodus: 未帰還の探索派遣が残っている(GDD 8.2 のスナップショットを次周へ" +
        "持ち越すと帰還先の盤面が存在しない)。帰還を待つこと",
    );
  }
  const resolution = resolveExodusPlan(state, content, plan);
  const params = requireExodusParams(content);

  const carriedCrew = new Set<EntityId>(resolution.carriedCrewIds);
  const carriedRecordIds = new Set<EntityId>(resolution.carriedRecordIds);
  const carriedTechIds = new Set<EntityId>();
  for (const recordId of resolution.carriedRecordIds) {
    carriedTechIds.add(requireCompletedRecord(state, recordId).techId);
  }
  const lostRareTechIds = new Set<EntityId>(resolution.lostRareTechIds);
  const startingStockBonus =
    inheritTierOf(state, "startingStock") * params.trackBonusPerTier.startingStock;

  const entities: EntityState[] = [];
  for (const entity of state.entityStateById.values()) {
    switch (entity.kind) {
      case "resident":
        if (carriedCrew.has(entity.id)) entities.push(carryResident(entity));
        continue;
      case "codify":
        if (carriedRecordIds.has(entity.id)) entities.push(entity);
        continue;
      case "research":
        entities.push(carryResearch(entity, state.tick, carriedTechIds, lostRareTechIds));
        continue;
      case "resource":
        entities.push(carryResource(entity, params, startingStockBonus));
        continue;
      case "facility":
        // 本拠は捨てて出る(§3)。次周の開始施設は composition root の担当。
        continue;
      default: {
        const unhandled: never = entity;
        throw new RulesError(`executeExodus: 未知の entity 種別 ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const nextProgression: ProgressionState = {
    runCount: state.progression.runCount + 1,
    cumulativeInheritPoints:
      state.progression.cumulativeInheritPoints + resolution.earnedInheritPoints,
    inheritTiers: state.progression.inheritTiers,
  };
  const meta: GameStateMeta = {
    saveSchemaVersion: state.saveSchemaVersion,
    contentVersion: state.contentVersion,
    algoVersion: state.algoVersion,
    worldSeed:
      options.worldSeedOverride ??
      deriveNextWorldSeed(
        state.worldSeed,
        nextProgression.runCount,
        nextProgression.cumulativeInheritPoints,
      ),
    tick: state.tick,
  };

  return createGameState(
    meta,
    entities,
    // GDD 10.5「周回時 RNG カウンタを全ドメイン 0 リセット」。
    [],
    carriedBondEntries(state, carriedCrew),
    carriedTechMemoryEntries(state, carriedCrew),
    // 未帰還の派遣は上で拒否済み。帰還ログ・衛星拠点は本拠と一緒に置いていく。
    [],
    EMPTY_RENDERED_LOGS,
    [],
    initialTerrain(content),
    nextProgression,
  );
}

/** 連れて行く住民を「新天地に着いた直後」の形へ整える(§3)。 */
function carryResident(resident: ResidentState): ResidentState {
  const detached = setField(resident, "assignedFacilityId", null);
  const undispatched = setField(detached, "dispatched", false);
  // 想起困難は旅の間に解ける。tick 軸は連続なので放置すると旅の分だけ残る。
  return setField(undispatched, "recallImpairedUntilTick", 0);
}

/**
 * 研究 entity を次周の形へ整える(GDD 10.2 / 5)。
 *
 *   持ち出した記録がある tech → **完了のまま**(GDD 5「持ち出し石版分のテックが
 *     初期解禁＋実地要件免除」)
 *   永久喪失した (B)          → 完了取り消し + `loss{irreversible:true}`
 *     (`rules/research.ts` の `currentResearch` が対象から外す = 二度と研究できない)
 *   それ以外                  → 進行度 0・未完了へ戻す((A) は再取得可・GDD 7.4)
 *
 * 既に `loss.irreversible` が立っている entity は**そのまま持ち越す**
 * (永久喪失は周回をまたいで永久である)。
 */
function carryResearch(
  research: ResearchState,
  tick: number,
  carriedTechIds: ReadonlySet<EntityId>,
  lostRareTechIds: ReadonlySet<EntityId>,
): ResearchState {
  if (research.loss?.irreversible === true) return research;
  if (research.completedTick !== null && carriedTechIds.has(research.techId)) return research;
  const reset = setField(setField(research, "completedTick", null), "progress", FIX_ZERO);
  if (!lostRareTechIds.has(research.techId)) return reset;
  return setField(reset, "loss", { tick, irreversible: true });
}

/**
 * 資源 entity を次周の形へ整える(§3)。**在庫は 0 へ戻し**、`startingStock`
 * 系統のボーナスだけを対象資源へ積む。オーバーフロー会計(累計)は周回ごとの
 * 統計なので落とす(GDD 11.4-7 の分母は周回内の値)。
 */
function carryResource(
  resource: ResourceState,
  params: ExodusParams,
  startingStockBonus: number,
): ResourceState {
  const stock =
    resource.resourceId === params.startingStockResourceId && startingStockBonus > 0
      ? fixFromInt(startingStockBonus)
      : FIX_ZERO;
  return { kind: "resource", id: resource.id, resourceId: resource.resourceId, stock };
}

/** 両端とも連れて行くペアの bond だけを持ち越す(GDD 7.3)。 */
function carriedBondEntries(
  state: GameState,
  carriedCrew: ReadonlySet<string>,
): readonly (readonly [string, Fix])[] {
  const entries: (readonly [string, Fix])[] = [];
  for (const [pairKey, value] of state.bondByPairKey) {
    const separator = pairKey.indexOf("|");
    if (separator < 0) continue;
    if (!carriedCrew.has(pairKey.slice(0, separator))) continue;
    if (!carriedCrew.has(pairKey.slice(separator + 1))) continue;
    entries.push([pairKey, value]);
  }
  return entries;
}

/**
 * 連れて行く住民の (住民 × 技術) 記憶だけを持ち越す(GDD 10.2「連れて行けば
 * 習熟保持」)。想起困難の残りは {@link carryResident} と同じ理由でゼロへ戻す。
 */
function carriedTechMemoryEntries(
  state: GameState,
  carriedCrew: ReadonlySet<string>,
): readonly (readonly [string, TechMemoryState])[] {
  const entries: (readonly [string, TechMemoryState])[] = [];
  for (const [key, value] of state.techMemoryByKey) {
    const separator = key.indexOf("|");
    if (separator < 0) continue;
    if (!carriedCrew.has(key.slice(0, separator))) continue;
    entries.push([key, { masteryFix: value.masteryFix, impairedUntilTick: 0 }]);
  }
  return entries;
}
