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
  type CellOccupant,
} from "../adjacency";
import { adjacencyBasisCellsOfFacility, occupiedCellsOfFacility } from "../footprint";
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
import {
  NEUTRAL_RESIDENT_STATS,
  UNIFORM_STAT_WEIGHTS,
  resolveTraitDefs,
  workerContribution,
} from "./stats";
import { applyCappedIntake, creditWasteGain, resolveCapacityByResourceId } from "./storage";
import {
  buildImpairmentIndex,
  computeMasteryGains,
  indexStopsFacility,
  isTechRelatedImpaired,
  type ImpairmentIndex,
  type MasteryGains,
} from "./techMemory";
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
 * state + content から {@link CellOccupancy}(セル番号 → 占有者)を作る。
 * adjacency.ts は state を知らないので、その橋渡しがここになる。
 *
 * **[M17] 占有形状の権威は state の `FacilityState.footprint`** である
 * (GDD 6.1 [2026-07-30裁定])。content の `FacilityDef.footprint` は**見ない**
 * —— 見てしまうと content 側の footprint 変更が既存盤面の占有形状を遡って
 * 書き換え、同じセーブから別の隣接乗数が出る(= 決定論バンドルの外で観測挙動が
 * 変わる)。content → state への焼き込みは配置時に 1 度だけ行われ、その単一経路は
 * commands.ts の `placeFacility` である(footprint.ts §1)。
 *
 * 大型施設は**全占有セル**に同一の {@link CellOccupant} を載せる。同じセルを
 * 2 施設が占有している state は配置バグなので reject する
 * (1 セル = 1 施設・GDD 6.1)。
 *
 * @throws {RulesError} 占有セルが重複している場合 / facility 定義が無い場合
 * @throws {FootprintError} footprint が盤外へはみ出す場合(state 不変条件違反・
 *   通常は update.ts が配置時に止めている)
 */
export function buildCellOccupancy(state: GameState, content: EngineContent): CellOccupancy {
  const occupancy = new Map<number, CellOccupant>();
  for (const facility of entitiesOfKind(state, "facility")) {
    const occupant: CellOccupant = {
      anchorCellIndex: facility.cellIndex,
      tags: requireFacilityDef(content, facility.defId).tags,
    };
    for (const cellIndex of occupiedCellsOfFacility(facility)) {
      const existing = occupancy.get(cellIndex);
      if (existing !== undefined) {
        throw new RulesError(
          `セル ${String(cellIndex)} に複数の施設が建っている(1 セル = 1 施設・GDD 6.1)。` +
            `アンカー ${String(existing.anchorCellIndex)} の施設と ` +
            `アンカー ${String(facility.cellIndex)} の施設が占有を取り合っている`,
        );
      }
      occupancy.set(cellIndex, occupant);
    }
  }
  return occupancy;
}

/**
 * state + content から隣接計算の subject(施設 entity ID → 素性)を作る。
 *
 * **[M17] `basisCells`(GDD 6.3 の判定基準セル集合)を必ず埋める**。1×1 でも
 * 埋めるのは分岐を作らないためであり、1×1 では `neighborCellIndices` と同じ集合
 * (順序だけ違う)になるので結果は変わらない(adjacency.ts §3(a)(e))。
 */
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
      basisCells: adjacencyBasisCellsOfFacility(facility),
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
   * [M50] 1 tick あたりの成文化作業量 = **稼働している「学者」の寄与の総和**
   * ((B)成文化完了の予測に使う・GDD 11.1「記録1枚 = 媒体別コスト + **学者作業
   * 時間** × 媒体別倍率」)。
   *
   * 「学者」= **産出先が研究点の施設(`output.kind === "research"`)で稼働して
   * いる就労者**である。GDD は学者という職業 entity を持たないので、
   * 「研究点を生む場所で働いている人 = 学者」と読むのが content の語彙で表せる
   * 唯一の解釈になる(GDD 6.2 の学芸タグは施設の属性であって就労者ではない)。
   *
   * 値は `activeLaborFix`(生産式の第 4・第 5 項)をそのまま流用する = 中立既定値
   * では**稼働人数そのもの**になり、`CodifyPlan.durationTicks`(rules/codify.ts
   * §2 の「学者 1 人が働いたときの tick 数」)の定義と厳密に噛み合う。
   * 隣接乗数(GDD 6.2 の `codifySpeed`)を掛けないのは、その効果が engine 未実装
   * である(裁定 N7・GDD 6.2 [2026-07-28・M6])ことと整合させるためである。
   *
   * **研究点の産出と就労者を共有する**(同じ人が研究も成文化も進める)。GDD は
   * 成文化専用の就労スロットを定義しておらず、専用スロットを新設すると
   * facility スキーマの拡張(= 別裁定)を伴うため M50 では採らない(★報告)。
   */
  readonly codifyLaborFix: Fix;
  /**
   * [M5] content の resourceId → 保管上限(§3)。
   * **この Map に無い資源は上限なし**であり、オーバーフロー機構に入らない。
   */
  readonly capacityByResourceId: ReadonlyMap<EntityId, Fix>;
  /** [M5] 保管庫パラメータ(GDD 6.7)。content に無ければ undefined。 */
  readonly storage: StorageParams | undefined;
  /**
   * [M13] (住民, 技術) ごとの定着度蓄積レート(GDD 11.2 の `masteryResist` を
   * 「実地稼働で蓄積する」ぶん・キー昇順)。生産と同じ (A) 区間の閉形式で
   * 積分されるレートなのでここに載せる(rules/techMemory.ts §4)。
   *
   * **就労者の走査を生産と共有する**ことが目的でもある: 「稼働している就労者」の
   * 判定が生産式と定着で分岐しないよう、同じ 1 パスで両方を作る。
   */
  readonly masteryGains: MasteryGains;
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
 * [M13] その住民がこの**施設**で稼働しているか(GDD 11.2「当該住民の当該 tech
 * 関連生産のみ停止」の本式)。
 *
 * {@link isWorkerActive}(住民単位の可否)に加えて、(住民, tech) 別の想起困難が
 * この施設定義での寄与を止めていないかを見る(rules/techMemory.ts §2)。
 *
 * `state.techMemoryByKey` が空なら後段は O(1) で false を返すので、既存セーブ・
 * 既存 conformance シナリオでは {@link isWorkerActive} と厳密に同値である。
 */
export function isWorkerActiveAtFacility(
  state: GameState,
  content: EngineContent,
  resident: ResidentState,
  facilityDefId: EntityId,
  tick: number,
  impairment?: ImpairmentIndex,
): boolean {
  if (!isWorkerActive(resident, tick)) return false;
  // `impairment` は (A) 区間の入口で 1 回だけ作った索引(rules/techMemory.ts)。
  // 省略時はその場で全件走査する(単体テスト・低頻度の問い合わせ向け)。
  if (impairment !== undefined) return !indexStopsFacility(impairment, resident.id, facilityDefId);
  return !isTechRelatedImpaired(state, content, resident.id, facilityDefId, tick);
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

/**
 * 稼働している就労者の人数(state の workerIds は ID 昇順)。
 *
 * [M13] `content` を渡すと施設別の想起困難({@link isWorkerActiveAtFacility})を
 * 考慮する。省略時は住民単位の可否だけを見る(診断・テスト用の縮約経路)。
 */
export function activeWorkerCount(
  state: GameState,
  facility: FacilityState,
  tick: number,
  content?: EngineContent,
): number {
  let count = 0;
  for (const workerId of facility.workerIds) {
    const resident = requireEntity(state, workerId, "resident");
    const active =
      content === undefined
        ? isWorkerActive(resident, tick)
        : isWorkerActiveAtFacility(state, content, resident, facility.defId, tick);
    if (active) count++;
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
  impairment?: ImpairmentIndex,
): Fix {
  let total = FIX_ZERO;
  for (const workerId of facility.workerIds) {
    const resident = requireEntity(state, workerId, "resident");
    // [M13] 施設別の想起困難まで見る(GDD 11.2 の「当該 tech 関連生産のみ停止」)。
    if (!isWorkerActiveAtFacility(state, content, resident, facility.defId, tick, impairment)) {
      continue;
    }
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
  let codifyLaborFix = FIX_ZERO;
  // [M13] 「誰のどの施設が想起困難で止まっているか」を 1 パスで索引化する
  // (就労者ごとに全件走査すると区間あたり二乗になる・rules/techMemory.ts)。
  const impairment = buildImpairmentIndex(state, ctx.content, state.tick);

  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(ctx.content, facility.defId);
    const base = facilityOutputPerTick(def, facility.level);
    if (toRaw(base) === 0) continue;

    const labor = activeLaborFix(state, ctx.content, facility, def, state.tick, impairment);
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
      // [M50] 成文化の「学者作業時間」は産出量ではなく**人の寄与**で数える
      // (ProductionRates.codifyLaborFix の doc)。`labor` は既にこの区間の
      // 稼働者ぶんだけを合算した値なので、走査を 1 パス共有できる。
      codifyLaborFix = addFix(codifyLaborFix, labor);
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
    codifyLaborFix,
    capacityByResourceId: resolveCapacityByResourceId(state, ctx.content),
    storage: ctx.content.storage,
    // [M13] 定着度の蓄積レート。「稼働している就労者」の判定は生産式と同一の
    // 述語({@link isWorkerActiveAtFacility})を渡して共有する。
    masteryGains: computeMasteryGains(state, ctx.content, (resident, facilityDefId) =>
      isWorkerActiveAtFacility(state, ctx.content, resident, facilityDefId, state.tick, impairment),
    ),
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

    // [M64] 上限なし(既定)= T5 と同一経路(会計フィールドも足さない・§3)も
    // 含めて `applyCappedIntake`(rules/storage.ts §2b)へ一本化した。
    const intake = applyCappedIntake(
      next,
      rates.storage,
      rates.capacityByResourceId,
      resource,
      gain,
    );
    next = intake.state;
    wasteGainTotal = addFix(wasteGainTotal, intake.wasteGainFix);
  }

  if (consumed !== rates.resourceRateByResourceId.size) {
    throw new RulesError(
      `applyProduction: 産出先の resource entity が state に無いレートがある` +
        `(レート ${String(rates.resourceRateByResourceId.size)} 件に対し受け皿 ${String(consumed)} 件)`,
    );
  }
  // [M64] 廃材の受け皿も rules/storage.ts §2b の単一入口へ寄せた。
  return creditWasteGain(
    next,
    rates.storage,
    rates.capacityByResourceId,
    wasteGainTotal,
    "applyProduction",
  );
}
