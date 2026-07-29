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
// 2. 生産式(GDD 11.1 の全系統形・M5)
// ===========================================================================
//   GDD 11.1 の完全形は
//     yield = baseYield × facilityLv係数 × (1 + Σ隣接補正)
//             × (Σ担当者関連ステータス寄与 / 50) × trait倍率
//   であり、本モジュールはこれを次の形で実装する:
//
//     ratePerTick = outputPerTickByLevel[Lv-1] × 隣接乗数 × Σ_稼働就労者 寄与
//     寄与(住民) = (Σ_s 重み_s × 実効ステータス_s / 50) × trait倍率
//
//   `outputPerTickByLevel` は `base × 1.15^(Lv-1)` をオーサリング時に個別 FP 展開
//   したものなので、facilityLv 係数は既にこの配列に織り込まれている(GDD 11.7)。
//   ステータス・trait の合成は rules/stats.ts(正本 ID は裁定 B8)。
//
//   **T5 縮約形との互換**: T5 は上式の最後の 2 項を 1.0 に固定した
//     ratePerTick = 出力(Lv) × 隣接乗数 × 稼働就労者数
//   だった。ステータス未設定(= 全て基準 50)・生産へ効く trait 無し・重み未指定
//   (= 5 種等分)という中立既定値のもとで 1 人あたりの寄与は**厳密に 1.0**に
//   なるので(rules/stats.ts §1)、Σ寄与 = 稼働就労者数 となり
//     mulFix(x, N × 1e6) = floor(x × N × 1e6 / 1e6) = x × N = mulFixInt(x, N)
//   が厳密に成り立つ。よって縮約時代に採った golden vector は 1 bit も動かない。
//
//   「稼働」の定義: 探索派遣中でなく(GDD 11.2 dispatchW の対象)、想起困難中でも
//   ない就労者。GDD 11.2 は想起困難で「当該住民の当該 tech 関連生産のみ停止」と
//   するが、現 state は tech 別の停止を表現しない(state.ts §3)ため、住民単位で
//   その住民の寄与を 0 にする。
//
// ===========================================================================
// 3. 保管庫オーバーフロー(GDD 6.7)との関係
// ===========================================================================
//   産出の**受け取り側**の上限・廃材変換は rules/storage.ts が持つ。本モジュールは
//   (A) 区間の閉形式で求めた産出量をそこへ渡すだけであり、
//   **上限が設定されていない資源では storage 側の分岐に一切入らない**
//   (= T5 と同一の更新経路)。上限の解決は区間ごとに 1 回、
//   {@link computeProductionRates} の中で行い {@link ProductionRates} に載せる
//   (施設配置は advance 中に変わらないので区間内で不変)。
// ---------------------------------------------------------------------------

import {
  computeFacilityMultipliers,
  type AdjacencyMatrix,
  type AdjacencySubject,
  type CellOccupancy,
  type Tag,
} from "../adjacency";
import { FIX_ONE, FIX_ZERO, addFix, mulFix, mulFixInt, toRaw, type Fix } from "../fp";
import {
  entitiesOfKind,
  isAliveResident,
  requireEntity,
  type EntityId,
  type FacilityState,
  type GameState,
  type ResidentState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";
import {
  NEUTRAL_RESIDENT_STATS,
  UNIFORM_STAT_WEIGHTS,
  resolveTraitDefs,
  workerContribution,
} from "./stats";
import {
  applyGainWithCapacity,
  resolveCapacityByResourceId,
  writeCapacityOutcome,
} from "./storage";
import {
  RulesError,
  requireFacilityDef,
  type AdvanceContext,
  type EngineContent,
  type FacilityDef,
  type StorageParams,
} from "./types";

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
  /**
   * [M5] content の resourceId → 保管上限(§3)。
   * **この Map に無い資源は上限なし**であり、オーバーフロー機構に入らない。
   */
  readonly capacityByResourceId: ReadonlyMap<EntityId, Fix>;
  /** [M5] 保管庫パラメータ(GDD 6.7)。content に無ければ undefined。 */
  readonly storage: StorageParams | undefined;
}

/**
 * その住民が今この tick に稼働しているか(§2 の「稼働」の定義)。
 * 想起困難は `tick < recallImpairedUntilTick` の間だけ有効
 * (回復イベントが until に来て 0 へ戻すが、イベントが無くても比較で正しく判定
 * できるようにしてある = 二重防御)。
 */
export function isWorkerActive(resident: ResidentState, tick: number): boolean {
  // [M11] 死亡した住民は稼働しない。死亡処理(rules/population.ts §3)は
  // facility.workerIds からも取り除くのでここへ来ないのが正常だが、掃除漏れを
  // 「静かに死者が働き続ける」形で通さないための二重防御。
  if (!isAliveResident(resident)) return false;
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
 * [M5] 住民 1 人の生産寄与(GDD 11.1 の第 4・第 5 項)。
 *
 * **中立の近道**: ステータス未設定 かつ 施設に重み指定なし かつ 生産へ効く trait
 * 無し、という既定の組合せでは寄与が厳密に 1.0 になる(rules/stats.ts §1)ので、
 * 計算を省いて {@link FIX_ONE} を返す。省略しても一般経路と同値であることは
 * テストで固定してある(近道は最適化であって仕様ではない)。
 */
export function residentContribution(
  resident: ResidentState,
  def: FacilityDef,
  content: EngineContent,
): Fix {
  const traits = resolveTraitDefs(resident.traitIds, content.traitDefs);
  const stats = resident.stats;
  const weights = def.statWeights;
  if (traits.length === 0 && stats === undefined && weights === undefined) return FIX_ONE;
  return workerContribution(
    stats ?? NEUTRAL_RESIDENT_STATS,
    weights ?? UNIFORM_STAT_WEIGHTS,
    traits,
  );
}

/**
 * [M5] 稼働している就労者の寄与の総和 = GDD 11.1 の
 * 「Σ担当者関連ステータス寄与 / 50 × trait倍率」。
 *
 * 中立既定値では **稼働就労者数 × 1.0** に一致する(§2)。加算順序は
 * `workerIds` の順(state の不変条件により ID 昇順・GDD 11.7)。
 */
export function activeLaborFix(
  state: GameState,
  content: EngineContent,
  facility: FacilityState,
  def: FacilityDef,
  tick: number,
): Fix {
  let total = FIX_ZERO;
  for (const workerId of facility.workerIds) {
    const resident = requireEntity(state, workerId, "resident");
    if (!isWorkerActive(resident, tick)) continue;
    total = addFix(total, residentContribution(resident, def, content));
  }
  return total;
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

    const labor = activeLaborFix(state, ctx.content, facility, def, state.tick);
    if (toRaw(labor) === 0) continue;

    const multiplier = ctx.multiplierByFacilityId.get(facility.id);
    if (multiplier === undefined) {
      throw new RulesError(
        `施設 "${facility.id}" の隣接乗数が未計算(配置を変えたらコンテキストを作り直すこと)`,
      );
    }

    // base はストック規模になり得る(人間単位で数千)ので値域証明が書けない
    // = mulFix(必要時 BigInt 中間積・fp.ts §4)。労働寄与も trait 次第で
    // 人数 × 1.5 まで伸びるため証明できず mulFix を使う。
    // 中立既定値では labor = 人数 × 1e6 なので
    // mulFix(x, 人数 × 1e6) = x × 人数 = mulFixInt(x, 人数) と厳密一致する(§2)。
    const rate = mulFix(mulFix(base, multiplier), labor);
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

  return {
    resourceRateByResourceId,
    researchRateFix,
    capacityByResourceId: resolveCapacityByResourceId(state, ctx.content),
    storage: ctx.content.storage,
  };
}

// --- 3. (A) の閉形式適用 ---------------------------------------------------

/**
 * (A) 区間の産出をストックへ一括加算する(区分求積 = レート × 区間長)。
 *
 * `deltaTicks` は 1 以上。resource entity の走査は ID 昇順(正準順)で行い、
 * レートに対応する resource entity が state に無い場合は**黙って捨てず**
 * 例外にする(産出先の取り違えを静かに損失にしない)。
 *
 * 保管庫の上限・オーバーフローの廃材変換(GDD 6.7)は
 * {@link ProductionRates.capacityByResourceId} に上限がある資源にのみ適用される。
 * 上限が無い資源は T5 と同一の更新経路(在庫へ加算するだけ)を通る(§3)。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない / 産出先の resource
 *   entity が state に無い / 廃材の受け皿が state に無い場合
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
  let wasteGainTotal = FIX_ZERO;
  for (const resource of entitiesOfKind(state, "resource")) {
    const rate = rates.resourceRateByResourceId.get(resource.resourceId);
    if (rate === undefined) continue;
    consumed++;
    const gain = mulFixInt(rate, deltaTicks);

    const capacity = rates.capacityByResourceId.get(resource.resourceId);
    if (capacity === undefined) {
      // 上限なし(既定)= T5 と同一経路。会計フィールドも足さない(§3)。
      if (toRaw(gain) === 0) continue;
      next = updateEntity(next, resource.id, "resource", (r) =>
        setField(r, "stock", addFix(r.stock, gain)),
      );
      continue;
    }

    const outcome = applyGainWithCapacity(
      resource,
      gain,
      capacity,
      wasteConversionRatio(rates, resource.resourceId),
    );
    next = writeCapacityOutcome(next, resource.id, outcome);
    wasteGainTotal = addFix(wasteGainTotal, outcome.wasteGain);
  }

  if (consumed !== rates.resourceRateByResourceId.size) {
    throw new RulesError(
      `applyProduction: 産出先の resource entity が state に無いレートがある` +
        `(レート ${String(rates.resourceRateByResourceId.size)} 件に対し受け皿 ${String(consumed)} 件)`,
    );
  }
  if (toRaw(wasteGainTotal) > 0) {
    next = creditWaste(next, rates, wasteGainTotal);
  }
  return next;
}

/**
 * 資源 1 種の廃材変換率(GDD 6.7 のスポンジ機構)。
 * **廃材そのものは再変換しない**(自己参照ループを作らない)。
 */
function wasteConversionRatio(rates: ProductionRates, resourceId: EntityId): Fix {
  const storage = rates.storage;
  if (storage === undefined || storage.wasteResourceId === resourceId) return FIX_ZERO;
  return storage.wasteConversionRatioByResourceId.get(resourceId) ?? FIX_ZERO;
}

/**
 * スポンジで生じた廃材を廃材資源の在庫へ入れる。
 * 廃材自身にも上限があれば適用するが、その超過は破棄する(変換率 0 で渡す)。
 *
 * @throws {RulesError} 廃材の resource entity が state に無い場合
 *   (生成した廃材を黙って捨てないため)
 */
function creditWaste(state: GameState, rates: ProductionRates, wasteGain: Fix): GameState {
  const wasteResourceId = rates.storage?.wasteResourceId;
  if (wasteResourceId === undefined || wasteResourceId === null) return state;

  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId !== wasteResourceId) continue;
    const capacity = rates.capacityByResourceId.get(wasteResourceId);
    if (capacity === undefined) {
      return updateEntity(state, resource.id, "resource", (r) =>
        setField(r, "stock", addFix(r.stock, wasteGain)),
      );
    }
    return writeCapacityOutcome(
      state,
      resource.id,
      applyGainWithCapacity(resource, wasteGain, capacity, FIX_ZERO),
    );
  }
  throw new RulesError(
    `applyProduction: 廃材 "${wasteResourceId}" の resource entity が state に無い` +
      `(スポンジ機構が生んだ ${String(toRaw(wasteGain))} を黙って捨てないため停止)`,
  );
}
