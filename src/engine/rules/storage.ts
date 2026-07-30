// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 保管庫オーバーフロー・廃材スポンジ・廃材3出口 — GDD 6.7 / 11.4-7
//
// ===========================================================================
// 1. GDD 6.7 の 4 項目と実装の対応
// ===========================================================================
//   (1) 上限到達時は原則超過分破棄          → {@link applyGainWithCapacity}
//   (2) 低次資源は超過分を一定比率で廃材へ  → 同上(スポンジ機構・§3)
//   (3) 副産物の上限判定は独立              → 上限は **resource 定義 ID ごと**に
//       持ち、資源間で連鎖しない。ある資源が満杯でも他資源の産出は止まらない
//       (施設単位で止める実装にすると「連鎖停止」が起きる)
//   (4) 廃材の消費先(3出口)                → §4
//
//   **上限が無い資源はオーバーフローしない。** 上限は
//     balance の `storage.baseCapacityByResourceId` + 建っている保管施設の寄与
//   の総和であり、**どちらも無ければ「上限なし」**として扱う({@link
//   resolveCapacityByResourceId} が返す Map に現れない)。この既定のおかげで、
//   上限を一切設定していない既存 conformance シナリオでは本モジュールの分岐が
//   1 つも実行されず、golden vector 37 本が 1 bit も動かない。
//
// ===========================================================================
// 2. 分割不変性(advance.ts §3)を壊さない形
// ===========================================================================
//   区間 [t0,t1) の産出を一括で入れるのと、途中で切って 2 回に分けて入れるのとで
//   結果が完全一致しなければならない。オーバーフローは非線形(min)なので、
//   素直に書くと壊れる。本実装は次の 2 つの規約で成立させている:
//
//   (a) **クランプは産出が正のときだけ掛ける。**
//       `gain > 0` のとき `stock' = min(stock + gain, cap)`、`gain <= 0` のときは
//       クランプせずそのまま加算する。
//       正の場合: x <= cap なら min(min(x+a,cap)+b,cap) = min(x+a+b,cap)(a,b>=0)。
//       x > cap(上限を下げたセーブ等)でも両辺 cap になり一致する。
//       負の場合: クランプが掛からないので加算は素直に結合する。
//       **1 つの (A) 区間の中ではレートが一定**なので、区間を分割しても各片の
//       産出は同符号になる。よって上の 2 場合のどちらかに必ず収まる。
//
//   (b) **廃材の生成量は「累計超過の差分」から出す(§3)。**
//
// ===========================================================================
// 3. 廃材スポンジの telescoping
// ===========================================================================
//   素朴に「この区間の超過 × 比率」を足すと、floor 丸めが区間ごとに入るため
//   `floor(e1*r) + floor(e2*r) != floor((e1+e2)*r)` となり分割不変性が壊れる。
//   そこで **累計超過 {@link ResourceState.cumulativeOverflow} を state に持ち**、
//   その区間の廃材生成量を
//       waste = floor(累計超過_新 × r) − floor(累計超過_旧 × r)
//   で求める。総和は telescoping で `floor(累計超過_最終 × r)` に畳まれるので、
//   どこで区間を切っても総生成量が一致する。
//
//   累計は**上限が有限な資源についてのみ**記録する(会計が意味を持つのは上限が
//   ある資源だけであり、無い資源にキーを増やすと既存セーブのバイト列が動く)。
//
// ===========================================================================
// 4. 廃材の 3 出口は「コマンド時の純関数」であって tick 流量ではない
// ===========================================================================
//   GDD 6.7 の 3 出口(増築コストの一部代替 / 成文化の粘土代替 / 研究点への低率
//   変換)は、いずれも**プレイヤー操作の瞬間に 1 回だけ起きる変換**である。
//   毎 tick 流れる連続量として実装すると
//     - 在庫枯渇でレートが変わる = 新しい境界イベントが要る(scheduler.ts §1 の
//       中心不変条件)
//     - 変換の floor 丸めが区間ごとに入る(§3 と同じ問題)
//   の 2 つを抱え込む。GDD の記述は連続流を要求していないので、本実装は
//   **純関数 + コマンド適用**として置き、離散事象を増やさない。
// ---------------------------------------------------------------------------

import { FIX_ZERO, addFix, fixFromRaw, floorDivFix, mulFix, subFix, toRaw, type Fix } from "../fp";
import { compareUtf16 } from "../canonicalize";
import { entitiesOfKind, type EntityId, type GameState, type ResourceState } from "../state/state";
import { setField, updateEntity } from "../state/update";
import { currentResearch } from "./research";
import { RulesError, requireFacilityDef, type EngineContent, type OverflowPolicy } from "./types";

// --- 1. 容量の解決 ---------------------------------------------------------

/** 「上限を持つ資源が 1 つも無い」を表す共有の空 Map(§1 の既定)。 */
const NO_CAPACITIES: ReadonlyMap<EntityId, Fix> = new Map();

/**
 * resource 定義 ID → 容量。**Map に現れない資源は上限なし**(§1)。
 *
 * 容量は「balance の基礎容量 + 建っている保管施設の Lv 別寄与」の総和。
 * 施設の走査は entity ID 昇順(`entitiesOfKind` の正準順)で、加算順序が
 * 結果に影響する固定小数点の総和を決定論に保つ(GDD 11.7)。
 *
 * @throws {RulesError} 保管施設の Lv が `capacityByLevel` の範囲外の場合
 */
export function resolveCapacityByResourceId(
  state: GameState,
  content: EngineContent,
): ReadonlyMap<EntityId, Fix> {
  const storage = content.storage;
  // 上限が 1 つも無い盤面(= 既定)ではここが (A) 区間ごとに呼ばれても
  // アロケーションゼロで抜ける(ADR-029(1) のアロケーション有界化)。
  if (storage === undefined || storage.baseCapacityByResourceId.size === 0) {
    let hasFacilityStorage = false;
    for (const facility of entitiesOfKind(state, "facility")) {
      if (requireFacilityDef(content, facility.defId).storage !== undefined) {
        hasFacilityStorage = true;
        break;
      }
    }
    if (!hasFacilityStorage) return NO_CAPACITIES;
  }

  const capacities = new Map<EntityId, Fix>();
  if (storage !== undefined) {
    for (const [resourceId, capacity] of storage.baseCapacityByResourceId) {
      capacities.set(resourceId, capacity);
    }
  }

  let allResourceIds: readonly EntityId[] | null = null;
  for (const facility of entitiesOfKind(state, "facility")) {
    const facilityStorage = requireFacilityDef(content, facility.defId).storage;
    if (facilityStorage === undefined) continue;

    const capacity = facilityStorage.capacityByLevel[facility.level - 1];
    if (capacity === undefined) {
      throw new RulesError(
        `保管施設 "${facility.id}" の Lv${String(facility.level)} の容量が定義に無い` +
          `(capacityByLevel の長さ ${String(facilityStorage.capacityByLevel.length)})`,
      );
    }

    let targets = facilityStorage.resourceIds;
    if (targets === null) {
      // 汎用倉庫は「state に居る全 resource entity の資源」を対象にする。
      // 一度作れば advance 中は不変なので使い回す(順序は ID 昇順で決定論)。
      allResourceIds ??= distinctResourceIds(state);
      targets = allResourceIds;
    }
    for (const resourceId of targets) {
      capacities.set(resourceId, addFix(capacities.get(resourceId) ?? FIX_ZERO, capacity));
    }
  }
  return capacities;
}

/** state に居る resource entity の資源 ID を重複なく ID 昇順で返す。 */
function distinctResourceIds(state: GameState): readonly EntityId[] {
  const seen = new Set<EntityId>();
  for (const resource of entitiesOfKind(state, "resource")) {
    seen.add(resource.resourceId);
  }
  return [...seen].sort(compareUtf16);
}

// --- 2. オーバーフローの適用 -----------------------------------------------

/** 1 資源ぶんの産出反映結果(§2)。 */
export interface CapacityOutcome {
  /** 反映後の在庫。 */
  readonly stock: Fix;
  /** 反映後の累計産出(正の産出のみ加算)。 */
  readonly cumulativeProduced: Fix;
  /** 反映後の累計超過。 */
  readonly cumulativeOverflow: Fix;
  /** この反映で新たに生じた廃材(§3 の telescoping 差分)。 */
  readonly wasteGain: Fix;
}

/**
 * 上限つきで産出を在庫へ反映する(§2 の (a)、§3 の telescoping)。
 *
 * `wasteRatioFix` が 0 のとき超過分は単純破棄(GDD 6.7「原則超過分破棄」)、
 * 正のときは超過 × 比率が廃材になる(スポンジ機構)。廃材そのものは
 * 再変換しない(呼び出し側が比率 0 で渡すこと)。
 */
export function applyGainWithCapacity(
  resource: ResourceState,
  gainFix: Fix,
  capacityFix: Fix,
  wasteRatioFix: Fix,
): CapacityOutcome {
  const previousProduced = resource.cumulativeProduced ?? FIX_ZERO;
  const previousOverflow = resource.cumulativeOverflow ?? FIX_ZERO;

  const raw = addFix(resource.stock, gainFix);
  // §2(a): クランプは産出が正のときだけ。負の産出(隣接ペナで乗数が負など)は
  // 素通しし、分割しても加算が素直に結合するようにする。
  const overflowing = toRaw(gainFix) > 0 && toRaw(raw) > toRaw(capacityFix);
  const stock = overflowing ? capacityFix : raw;
  const excess = overflowing ? subFix(raw, capacityFix) : FIX_ZERO;

  const cumulativeProduced =
    toRaw(gainFix) > 0 ? addFix(previousProduced, gainFix) : previousProduced;
  const cumulativeOverflow = addFix(previousOverflow, excess);

  // §3: 差分で出すので floor 丸めが区間分割に依存しない。
  const wasteGain =
    toRaw(wasteRatioFix) === 0
      ? FIX_ZERO
      : subFix(mulFix(cumulativeOverflow, wasteRatioFix), mulFix(previousOverflow, wasteRatioFix));

  return { stock, cumulativeProduced, cumulativeOverflow, wasteGain };
}

/** {@link CapacityOutcome} を resource entity へ書き戻す。 */
export function writeCapacityOutcome(
  state: GameState,
  resourceEntityId: EntityId,
  outcome: CapacityOutcome,
): GameState {
  return updateEntity(state, resourceEntityId, "resource", (r) => {
    const withStock = setField(r, "stock", outcome.stock);
    const withProduced = setField(withStock, "cumulativeProduced", outcome.cumulativeProduced);
    return setField(withProduced, "cumulativeOverflow", outcome.cumulativeOverflow);
  });
}

// --- 2b. 方策つきオーバーフロー(GDD 12.1 `item.overflow`)— M22 -------------
//
//   §2 の {@link applyGainWithCapacity} は「毎 tick の連続生産」用であり、
//   `cumulativeProduced` / `cumulativeOverflow`(GDD 11.4-7 の損失率会計)を
//   必ず動かす。一方 GDD 12.1 の `item(… overflow{policy, convertTo, ratio})` は
//   **一括入荷(探索報酬・イベント報酬)にだけ掛かる方策**であり、
//   GDD 8.1 の [2026-07-30裁定]⑥「探索報酬は保管上限/オーバーフロー会計を
//   通さない(`cumulativeProduced` を膨らませない)」と両立させる必要がある。
//
//   そこで本節は **会計を一切触らない純関数**として上限とあふれ処理だけを行う。
//   「上限を掛ける」ことと「損失率の分母を増やす」ことを別の関数に分けたのが
//   ⑥ への回答である(⑥ が禁じているのは後者)。

/** [M22] 方策つきオーバーフローの結果({@link applyOverflowPolicy})。 */
export interface OverflowOutcome {
  /** 実際に在庫へ入る量(上限までのぶん)。 */
  readonly acceptedFix: Fix;
  /** 入りきらなかった量。 */
  readonly excessFix: Fix;
  /** 変換で得られた量(`discard` なら 0)。 */
  readonly convertedFix: Fix;
  /** 変換先の resource 定義 ID(変換が起きなければ null)。 */
  readonly convertToResourceId: EntityId | null;
}

/**
 * [M22] 一括入荷に方策つきオーバーフローを適用する(GDD 12.1 / 6.7)。
 *
 * 会計(`cumulativeProduced` / `cumulativeOverflow`)は**動かさない**(§2b)。
 * 減少(gain <= 0)は上限判定を通さない —— §2(a) と同じ理由で、
 * クランプを非負のときだけ掛けることで加算の結合性を壊さないため。
 *
 * 値域: `excess × ratio` は content 由来の上限が緩い経路なので
 * {@link mulFix}(自動 BigInt フォールバック)を使う(fp.ts §4 の線引き)。
 */
export function applyOverflowPolicy(
  currentStockFix: Fix,
  gainFix: Fix,
  policy: OverflowPolicy,
): OverflowOutcome {
  if (toRaw(gainFix) <= 0) {
    return {
      acceptedFix: gainFix,
      excessFix: FIX_ZERO,
      convertedFix: FIX_ZERO,
      convertToResourceId: null,
    };
  }
  const roomRaw = toRaw(policy.capacityFix) - toRaw(currentStockFix);
  const gainRaw = toRaw(gainFix);
  const acceptedRaw = roomRaw <= 0 ? 0 : roomRaw < gainRaw ? roomRaw : gainRaw;
  const acceptedFix = fixFromRaw(acceptedRaw);
  const excessFix = fixFromRaw(gainRaw - acceptedRaw);
  if (
    policy.policy !== "convert" ||
    policy.convertToResourceId === null ||
    toRaw(excessFix) === 0
  ) {
    return { acceptedFix, excessFix, convertedFix: FIX_ZERO, convertToResourceId: null };
  }
  return {
    acceptedFix,
    excessFix,
    convertedFix: mulFix(excessFix, policy.ratioFix),
    convertToResourceId: policy.convertToResourceId,
  };
}

// --- 3. オーバーフロー損失率(GDD 11.4-7) ---------------------------------

/**
 * 1 資源のオーバーフロー損失率 = 累計超過 / 累計産出。
 * 累計産出が 0(まだ何も作っていない / 上限が無く会計していない)なら 0 を返す。
 */
export function overflowLossRate(resource: ResourceState): Fix {
  const produced = resource.cumulativeProduced ?? FIX_ZERO;
  if (toRaw(produced) <= 0) return FIX_ZERO;
  return floorDivFix(resource.cumulativeOverflow ?? FIX_ZERO, produced);
}

/**
 * 盤面全体のオーバーフロー損失率(GDD 11.4-7「オーバーフロー損失率 < 15%」の
 * 判定値)。分子・分母をそれぞれ全資源で合計してから割る(資源ごとの率の平均
 * ではない — 産出量の大小を重みとして反映させるため)。
 *
 * 総和は resource entity の ID 昇順(正準順・GDD 11.7)。
 */
export function colonyOverflowLossRate(state: GameState): Fix {
  let produced = FIX_ZERO;
  let overflow = FIX_ZERO;
  for (const resource of entitiesOfKind(state, "resource")) {
    produced = addFix(produced, resource.cumulativeProduced ?? FIX_ZERO);
    overflow = addFix(overflow, resource.cumulativeOverflow ?? FIX_ZERO);
  }
  if (toRaw(produced) <= 0) return FIX_ZERO;
  return floorDivFix(overflow, produced);
}

// --- 4. 廃材の 3 出口(§4) ------------------------------------------------

/** 廃材によるコスト代替の結果。 */
export interface WasteSubstitution {
  /** 代替に使った廃材(在庫から引く量)。 */
  readonly wasteSpentFix: Fix;
  /** 代替後に本来の資源で払う残りコスト。 */
  readonly remainingCostFix: Fix;
}

/**
 * コストの一部を廃材で代替する(GDD 6.7 の 3 出口(1)(2))。
 *
 * 代替できるのは `costFix × maxRatioFix` まで(増築は最大 20%、成文化の粘土は
 * 低比率)。廃材在庫が足りなければ在庫ぶんだけ代替する。廃材 1 単位はコスト
 * 1 単位と等価に扱う(GDD に交換比の記述が無いための解釈)。
 *
 * @throws {RulesError} コストが負の場合(呼び出し側の組み立てバグ)
 */
export function substituteCostWithWaste(
  costFix: Fix,
  wasteStockFix: Fix,
  maxRatioFix: Fix,
): WasteSubstitution {
  if (toRaw(costFix) < 0) {
    throw new RulesError(`substituteCostWithWaste: コスト ${String(toRaw(costFix))} が負`);
  }
  const available = toRaw(wasteStockFix) > 0 ? wasteStockFix : FIX_ZERO;
  const substitutable = mulFix(costFix, maxRatioFix);
  const spent = toRaw(substitutable) < toRaw(available) ? substitutable : available;
  return { wasteSpentFix: spent, remainingCostFix: subFix(costFix, spent) };
}

/**
 * 廃材 → 研究点の変換量(GDD 6.7 の 3 出口(3)「廃材 N → RP 1」)。
 * `ratioFix` は 1/N(例: N=10 なら 0.1)。
 */
export function wasteToResearchPoints(wasteFix: Fix, ratioFix: Fix): Fix {
  if (toRaw(wasteFix) <= 0) return FIX_ZERO;
  return mulFix(wasteFix, ratioFix);
}

/**
 * 資源コストを在庫から引く(消費の単一経路)。`costs` は resource 定義 ID →
 * 消費量。走査は resource entity の ID 昇順(正準順)。
 *
 * 在庫不足は**黙って 0 で止めず例外**にする(払えないコマンドは呼び出し側で
 * 弾くべきものであり、静かに部分適用すると state が壊れる)。
 *
 * @throws {RulesError} 在庫不足 / 受け皿の resource entity が無い場合
 */
export function spendResources(state: GameState, costs: ReadonlyMap<EntityId, Fix>): GameState {
  if (costs.size === 0) return state;
  let next = state;
  let matched = 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    const cost = costs.get(resource.resourceId);
    if (cost === undefined) continue;
    matched++;
    if (toRaw(cost) < 0) {
      throw new RulesError(
        `spendResources: 資源 "${resource.resourceId}" のコスト ${String(toRaw(cost))} が負`,
      );
    }
    if (toRaw(cost) > toRaw(resource.stock)) {
      throw new RulesError(
        `spendResources: 資源 "${resource.resourceId}" の在庫不足` +
          `(必要 ${String(toRaw(cost))} / 在庫 ${String(toRaw(resource.stock))})`,
      );
    }
    next = updateEntity(next, resource.id, "resource", (r) =>
      setField(r, "stock", subFix(r.stock, cost)),
    );
  }
  if (matched !== costs.size) {
    throw new RulesError(
      `spendResources: コストに対応する resource entity が state に無い` +
        `(コスト ${String(costs.size)} 件に対し受け皿 ${String(matched)} 件)`,
    );
  }
  return next;
}

/**
 * 廃材を研究点へ変換する(3 出口(3)のコマンド適用形・§4)。
 *
 * 変換先は「現在の研究」(research.ts §2 の単一キュー)。研究が全て完了して
 * いる場合は変換しない(廃材を消費してから捨てることになるため)。
 *
 * @throws {RulesError} storage 未設定 / 廃材資源が未設定 / 在庫不足の場合
 */
export function convertWasteToResearchPoints(
  state: GameState,
  content: EngineContent,
  wasteAmountFix: Fix,
): GameState {
  const storage = content.storage;
  if (storage === undefined || storage.wasteResourceId === null) {
    throw new RulesError(
      "convertWasteToResearchPoints: content に storage.wasteResourceId が無い(廃材が定義されていない)",
    );
  }
  if (toRaw(wasteAmountFix) <= 0) return state;

  const research = currentResearch(state);
  if (research === undefined) return state;

  const gain = wasteToResearchPoints(wasteAmountFix, storage.wasteToResearchRatioFix);
  if (toRaw(gain) === 0) return state;

  const spent = spendResources(state, new Map([[storage.wasteResourceId, wasteAmountFix]]));
  return updateEntity(spent, research.id, "research", (r) =>
    setField(r, "progress", addFix(r.progress, gain)),
  );
}

/**
 * 廃材の在庫(resource entity が無ければ 0)。3 出口の呼び出し側が
 * 「いくらまで代替できるか」を知るために使う。
 */
export function wasteStockOf(state: GameState, content: EngineContent): Fix {
  const wasteResourceId = content.storage?.wasteResourceId;
  if (wasteResourceId === undefined || wasteResourceId === null) return FIX_ZERO;
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === wasteResourceId) return resource.stock;
  }
  return FIX_ZERO;
}
