// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- (A)定常生産 — GDD 11.1 / 11.8(A) / ADR-008
//
// ===========================================================================
// 1. (A) 区間の定義と閉形式(GDD 11.8(A))
// ===========================================================================
//   (A) 定常生産区間 = 「レート一定・確率イベントなし」の区間。この区間の産出は
//   区分求積(レート × 区間長)の閉形式で一発計算でき、毎 tick ループを回す必要が
//   ない。本モジュールは
//     computeProductionRates(state) → 1 tick あたりレート(区間中は定数)
//     applyProduction(state, rates, Δtick) → ストックへ レート × Δtick を加算
//   の 2 段に分かれており、前者を**セグメント境界でだけ**呼ぶことで (A) が成立する。
//
//   この「レートが区間中に変わらない」という前提を守るのは scheduler.ts の責務で
//   あり、レートを変える状態変化(研究完了・想起困難の発生/回復)はすべて離散事象
//   として境界化されている。新しい rule を足すときはその不変条件を必ず維持する
//   こと(破ると (A) の閉形式が静かに誤差を持つ = golden vector にしか現れない)。
//
// ===========================================================================
// 2. GDD 11.1 に対する縮約
// ===========================================================================
//   GDD 11.1 の完全形は
//     yield = baseYield × facilityLv係数 × (1 + Σ隣接補正)
//             × (Σ担当者関連ステータス寄与 / 50) × trait倍率
//   であり、T5 の縮約 state(state.ts §3)には住民のステータス 5 種と trait 定義が
//   無い。よって計測用の縮約形は:
//     ratePerTick = outputPerTickByLevel[Lv-1] × 隣接乗数 × 稼働就労者数
//   とする。差分は 2 点:
//     (a) 「Σ担当者ステータス寄与 / 50」→「稼働就労者数」(基準 50 のステータスを
//         全員が持つ = 寄与 1.0/人 と等価。人数依存の線形性は保つ)
//     (b) trait 倍率は掛けない(trait 定義本体は content 側で、生産系 trait 効果は
//         MVP 実装事項)
//   `outputPerTickByLevel` は `base × 1.15^(Lv-1)` をオーサリング時に個別 FP 展開
//   したものなので、facilityLv 係数は既にこの配列に織り込まれている(GDD 11.7)。
//
//   「稼働」の定義: 探索派遣中でなく(GDD 11.2 dispatchW の対象)、想起困難中でも
//   ない就労者。GDD 11.2 は想起困難で「当該住民の当該 tech 関連生産のみ停止」と
//   するが、縮約 state は tech 別の停止を表現しない(§3 参照)ため、住民単位で
//   その住民の寄与を 0 にする。
// ---------------------------------------------------------------------------

import {
  computeFacilityMultipliers,
  type AdjacencyMatrix,
  type AdjacencySubject,
  type CellOccupancy,
  type Tag,
} from "../adjacency";
import { FIX_ZERO, addFix, mulFix, mulFixInt, toRaw, type Fix } from "../fp";
import {
  entitiesOfKind,
  requireEntity,
  type EntityId,
  type FacilityState,
  type GameState,
  type ResidentState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";
import { RulesError, requireFacilityDef, type AdvanceContext, type EngineContent } from "./types";

// --- 1. 配置(occupancy)の組み立て ---------------------------------------

/**
 * state + content から {@link CellOccupancy}(セル番号 → タグ列)を作る。
 * adjacency.ts は state を知らないので、その橋渡しがここになる。
 *
 * 同じセルに 2 施設が建っている state は配置バグなので reject する
 * (1 セル = 1 施設・GDD 6.1)。
 *
 * @throws {RulesError} セルが重複している場合 / facility 定義が無い場合
 */
export function buildCellOccupancy(state: GameState, content: EngineContent): CellOccupancy {
  const occupancy = new Map<number, readonly Tag[]>();
  for (const facility of entitiesOfKind(state, "facility")) {
    if (occupancy.has(facility.cellIndex)) {
      throw new RulesError(
        `セル ${String(facility.cellIndex)} に複数の施設が建っている(1 セル = 1 施設・GDD 6.1)`,
      );
    }
    occupancy.set(facility.cellIndex, requireFacilityDef(content, facility.defId).tags);
  }
  return occupancy;
}

/** state + content から隣接計算の subject(施設 entity ID → 素性)を作る。 */
export function buildAdjacencySubjects(
  state: GameState,
  content: EngineContent,
): ReadonlyMap<EntityId, AdjacencySubject> {
  const subjects = new Map<EntityId, AdjacencySubject>();
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(content, facility.defId);
    subjects.set(facility.id, {
      cellIndex: facility.cellIndex,
      defId: def.id,
      tags: def.tags,
    });
  }
  return subjects;
}

/**
 * 施設 entity ID → 産出乗数(隣接ボーナス + 過密ペナ)を計算する。
 * advance のコンテキスト構築から 1 回だけ呼ばれる(rules/types.ts §5)。
 */
export function computeMultiplierByFacilityId(
  state: GameState,
  content: EngineContent,
  adjacency: AdjacencyMatrix,
): ReadonlyMap<EntityId, Fix> {
  const occupancy = buildCellOccupancy(state, content);
  const subjects = buildAdjacencySubjects(state, content);
  return computeFacilityMultipliers(adjacency, occupancy, subjects);
}

// --- 2. レート計算 ---------------------------------------------------------

/** 1 tick あたりの産出レート。(A) 区間中は定数(§1)。 */
export interface ProductionRates {
  /** content の resourceId → 1 tick あたり産出。 */
  readonly resourceRateByResourceId: ReadonlyMap<EntityId, Fix>;
  /** 1 tick あたりの研究点産出((B)研究完了の予測に使う)。 */
  readonly researchRateFix: Fix;
}

/**
 * その住民が今この tick に稼働しているか(§2 の「稼働」の定義)。
 * 想起困難は `tick < recallImpairedUntilTick` の間だけ有効
 * (回復イベントが until に来て 0 へ戻すが、イベントが無くても比較で正しく判定
 * できるようにしてある = 二重防御)。
 */
export function isWorkerActive(resident: ResidentState, tick: number): boolean {
  if (resident.dispatched) return false;
  return tick >= resident.recallImpairedUntilTick;
}

/**
 * Lv 別の基礎産出を引く。Lv は 1 起点。
 *
 * @throws {RulesError} Lv が定義の配列長を外れている場合
 */
export function facilityOutputPerTick(
  def: { readonly id: EntityId; readonly outputPerTickByLevel: readonly Fix[] },
  level: number,
): Fix {
  const value = def.outputPerTickByLevel[level - 1];
  if (value === undefined) {
    throw new RulesError(
      `facility "${def.id}" の Lv${String(level)} の産出が定義に無い` +
        `(outputPerTickByLevel の長さ ${String(def.outputPerTickByLevel.length)})`,
    );
  }
  return value;
}

/** 稼働している就労者の人数(state の workerIds は ID 昇順)。 */
export function activeWorkerCount(state: GameState, facility: FacilityState, tick: number): number {
  let count = 0;
  for (const workerId of facility.workerIds) {
    if (isWorkerActive(requireEntity(state, workerId, "resident"), tick)) count++;
  }
  return count;
}

/**
 * 現在の state から 1 tick あたりのレートを計算する((A) 区間の入口)。
 *
 * 集合演算の順序は施設 entity の ID 昇順(`entitiesOfKind` が返す正準順)に固定
 * してある(GDD 11.7「全集合演算は安定文字列 ID の辞書順」)。
 *
 * @throws {RulesError} facility 定義が無い / 乗数が未計算の場合
 */
export function computeProductionRates(state: GameState, ctx: AdvanceContext): ProductionRates {
  const resourceRateByResourceId = new Map<EntityId, Fix>();
  let researchRateFix = FIX_ZERO;

  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(ctx.content, facility.defId);
    const base = facilityOutputPerTick(def, facility.level);
    if (toRaw(base) === 0) continue;

    const workers = activeWorkerCount(state, facility, state.tick);
    if (workers === 0) continue;

    const multiplier = ctx.multiplierByFacilityId.get(facility.id);
    if (multiplier === undefined) {
      throw new RulesError(
        `施設 "${facility.id}" の隣接乗数が未計算(配置を変えたらコンテキストを作り直すこと)`,
      );
    }

    // base はストック規模になり得る(人間単位で数千)ので値域証明が書けない
    // = mulFix(必要時 BigInt 中間積・fp.ts §4)。人数の掛け算はスケール補正が
    // 入らない mulFixInt を使う。
    const rate = mulFixInt(mulFix(base, multiplier), workers);
    if (toRaw(rate) === 0) continue;

    if (def.output.kind === "research") {
      researchRateFix = addFix(researchRateFix, rate);
      continue;
    }
    const resourceId = def.output.resourceId;
    resourceRateByResourceId.set(
      resourceId,
      addFix(resourceRateByResourceId.get(resourceId) ?? FIX_ZERO, rate),
    );
  }

  return { resourceRateByResourceId, researchRateFix };
}

// --- 3. (A) の閉形式適用 ---------------------------------------------------

/**
 * (A) 区間の産出をストックへ一括加算する(区分求積 = レート × 区間長)。
 *
 * `deltaTicks` は 1 以上。resource entity の走査は ID 昇順(正準順)で行い、
 * レートに対応する resource entity が state に無い場合は**黙って捨てず**
 * 例外にする(産出先の取り違えを静かに損失にしない)。
 *
 * 保管庫の上限・オーバーフローの廃材変換(GDD 6.7)は縮約の対象外。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない / 産出先の resource
 *   entity が state に無い場合
 */
export function applyProduction(
  state: GameState,
  rates: ProductionRates,
  deltaTicks: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyProduction: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  if (rates.resourceRateByResourceId.size === 0) return state;

  let next = state;
  let consumed = 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    const rate = rates.resourceRateByResourceId.get(resource.resourceId);
    if (rate === undefined) continue;
    consumed++;
    const gain = mulFixInt(rate, deltaTicks);
    if (toRaw(gain) === 0) continue;
    next = updateEntity(next, resource.id, "resource", (r) =>
      setField(r, "stock", addFix(r.stock, gain)),
    );
  }

  if (consumed !== rates.resourceRateByResourceId.size) {
    throw new RulesError(
      `applyProduction: 産出先の resource entity が state に無いレートがある` +
        `(レート ${String(rates.resourceRateByResourceId.size)} 件に対し受け皿 ${String(consumed)} 件)`,
    );
  }
  return next;
}
