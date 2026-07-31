// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 衛星拠点(供給/維持費/hazard/ROI)— GDD 9.2 / 8.6 / 11.4-7 / M24
//
// ===========================================================================
// 1. スコープ: データ層(state・決定論 rules・ROI 算出)+ scheduler 段80 結線
// ===========================================================================
//   本タスク(M24)の検収は「拠点網 ROI のテスト」と「本拠と拠点で資源系の
//   二重計上が無いこと」であり、UI 画面(拠点カード・ネット収益表示・放棄推奨)は
//   M32 の担当(タスク指示)。本モジュールは
//     - 拠点 state(state.ts の OutpostState)
//     - 供給/維持費/hazard の純関数(このファイル)
//     - 拠点網 ROI の算出(このファイル)
//   を実装する。GDD 9.2「決定論tickで本拠在庫へ自動供給」を成立させる
//   {@link applyOutpostSupply} は、当初(M24)は用意のみで scheduler.ts への
//   結線を見送っていたが(rules/codify.ts が M6 で「tick ループ結線は M13 以降」
//   としたのと同じ判断)、**[M25・裁定台帳v2 必-1] scheduler.ts の段80
//   (`PIPELINE_STAGE.satellite`)へ結線済み**。生産(段30)と同じ「レート ×
//   区間長」の閉形式なので離散イベントは増やさず、`runSchedule` の (A) 区間
//   積分ブロックへ生産・研究・bond・mastery と並べて畳み込んだ
//   (scheduler.ts §6 参照)。既存 golden vector 64 本は盤面に拠点 entity が
//   1 つも無い(state.outpostsById が常に空)ため、この結線それ自体では
//   1 バイトも動かない ——`computeOutpostSupplyRates` が空 Map を返し
//   `applyOutpostSupply` が no-op で早期 return するため。
//
// ===========================================================================
// 2. 二重計上の防止(検分観点)
// ===========================================================================
//   GDD 9.2 の供給は「常駐人数」だけを読み、GDD 11.1 の生産は「facility.
//   workerIds」だけを読む——**別々の集合を数える**ので、同じ住民 ID が両方に
//   同時に載っていない限り二重計上は起きない。この前提を**構造的に強制**する
//   のが {@link assertNoDoubleStationedResidents} であり、拠点の供給レートを
//   計算する唯一の入口 {@link computeOutpostSupplyRates} が呼ぶたびに検査する
//   (rules/production.ts の `buildCellOccupancy` が施設配置のたびにセル重複を
//   検査するのと同じ層)。探索の `dispatched` フラグも同じ「busy」集合に含める
//   ——探索派遣中の住民を同時に拠点常駐させても検出できるようにするため。
//
//   供給先(resourceId)も**本拠の資源と同じ ID 空間**であり、outpostType の
//   `resourceId` が facility.output.resourceId と同じ文字列を指せば、
//   {@link applyOutpostSupply} は同一の resource entity(本拠在庫)へそのまま
//   加算する。拠点専用の別ストックを作らないことが「二重計上しようがない」
//   構造の 2 つめの根拠(state.ts に拠点専用の資源 Map は存在しない)。
//
// ===========================================================================
// 3. 幕塵後退度(GDD 9.2 の「翳り率」)は state に持たない
// ===========================================================================
//   `翳り率 = clamp(0, 幕塵後退度 × shadeSensitivity, 1)` の幕塵後退度は
//   幕塵メーター(GDD 11.7 段90・scheduler.ts の PIPELINE_STAGE.dust)が未実装
//   のため、本モジュールの関数群は**呼び出し側から引数で受け取る**(既定は
//   {@link FIX_ZERO} = 翳りなし)。幕塵メーターが実装されたら、その出力値を
//   そのままここへ渡すだけで式が完成する(このファイルの変更は不要)。
//
// ===========================================================================
// 4. ROI の式(GDD 9.2 のネット収益 + GDD 8.6 の (B) 喪失金銭化を援用)
// ===========================================================================
//   GDD 9.2 が定めるのは `ネット収益 = supply資源換算 − upkeep` という**差**
//   だけであり、GDD 11.4-7 が要求する「拠点網 ROI」の正確な式(比か差か・
//   リスク項を含むか)は GDD 本文に明記が無い(★要ユーザー判断・詳細は
//   このタスクの報告を参照)。本実装は GDD 8.6 の探索 ROI
//     `探索ROI = 期待報酬 / (逸失生産 + 期待B喪失損失)`
//   と対称な形で「拠点 ROI = 供給 / (維持費 + 期待B喪失損失)」を採用し、
//   `期待B喪失損失 = hazard強度(0〜1) × Σ((B)資産価値換算)` とする——hazard を
//   探索の「全滅確率」の拠点版として扱う解釈である。(B) 資産価値換算は
//   `rules/exploration.ts` の {@link rareAssetCountOf} / `rareAssetValueFix`
//   を**そのまま再利用**する(同じ資産を探索と拠点で別の値付けにしない)。
//   ネット収益(GDD 9.2 の文字どおりの式)と ROI(比・GDD 11.4-7 の命名に対応)の
//   **両方**を返し、どちらの読み方にも耐える形にしてある。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import {
  FIX_ONE,
  FIX_ZERO,
  addFix,
  clampFix,
  floorDivFix,
  floorDivInt,
  mulFix,
  mulFixInt,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import {
  allOutposts,
  entitiesOfKind,
  type EntityId,
  type GameState,
  type OutpostState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";
import { rareAssetCountOf } from "./exploration";
import { GAME_DAY_TICKS } from "../stochastic";
import {
  RulesError,
  requireOutpostParams,
  requireOutpostTypeDef,
  type EngineContent,
  type OutpostParams,
  type OutpostTypeDef,
} from "./types";

// --- 1. hazard(GDD 12.1 hazard{intensity,growth,min,max})-------------------

/**
 * その拠点の現在 tick における脅威強度(GDD 12.1)。設置からの経過日数
 * (`floorDivInt`・整数除算のみ)に `growthPerDay` を線形加算し、
 * `[min, max]` へクランプする。`tick < establishedTick`(state 不整合)は
 * 経過日数 0 として扱う(負の経過を許すと clamp 前の値が unclamp 域まで
 * 下振れし、テストでしか見えない挙動になるため)。
 *
 * @throws {RulesError} `hazard.minFix > hazard.maxFix`(content の構成ミス)
 */
export function outpostHazardFix(outpost: OutpostState, def: OutpostTypeDef, tick: number): Fix {
  const hazard = def.hazard;
  if (toRaw(hazard.minFix) > toRaw(hazard.maxFix)) {
    throw new RulesError(
      `outpostType "${def.id}" の hazard.min が hazard.max を超えている(GDD 12.1)`,
    );
  }
  const elapsedTicks = Math.max(0, tick - outpost.establishedTick);
  const elapsedDays = floorDivInt(elapsedTicks, GAME_DAY_TICKS);
  const grown = addFix(hazard.intensityFix, mulFixInt(hazard.growthPerDayFix, elapsedDays));
  return clampFix(grown, hazard.minFix, hazard.maxFix);
}

// --- 2. 翳り率(GDD 9.2)------------------------------------------------------

/**
 * 翳り率 = `clamp(0, 幕塵後退度 × shadeSensitivity, 1)`(GDD 9.2)。
 * 幕塵後退度は state に無いため引数で受け取る(§3)。
 */
export function outpostShadeRateFix(hazeRecessionDegreeFix: Fix, def: OutpostTypeDef): Fix {
  return clampFix(mulFix(hazeRecessionDegreeFix, def.shadeSensitivityFix), FIX_ZERO, FIX_ONE);
}

// --- 3. 供給(GDD 9.2)-------------------------------------------------------

/**
 * 拠点 1 基の 1 tick あたり供給量(GDD 9.2
 * `supply = baseSupply(type) × 常駐人数 × 拠点Lv × (1 − 翳り率)`)。
 * `baseSupply(type) × 拠点Lv` は {@link OutpostTypeDef.supplyPerResidentTickByLevel}
 * へオーサリング時展開済み(facility.outputPerTickByLevel と同型・GDD 11.7)。
 *
 * @throws {RulesError} 拠点の Lv に対応する供給定義が無い場合
 */
export function outpostSupplyRateFix(
  outpost: OutpostState,
  def: OutpostTypeDef,
  hazeRecessionDegreeFix: Fix = FIX_ZERO,
): Fix {
  const perResidentByLevel = def.supplyPerResidentTickByLevel[outpost.level - 1];
  if (perResidentByLevel === undefined) {
    throw new RulesError(
      `outpostType "${def.id}" の Lv${String(outpost.level)} の供給が定義に無い` +
        `(supplyPerResidentTickByLevel の長さ ${String(def.supplyPerResidentTickByLevel.length)})`,
    );
  }
  const shadeRateFix = outpostShadeRateFix(hazeRecessionDegreeFix, def);
  const perResidentFix = mulFix(perResidentByLevel, subFix(FIX_ONE, shadeRateFix));
  return mulFixInt(perResidentFix, outpost.residentIds.length);
}

// --- 4. 維持費(GDD 9.2)------------------------------------------------------

/**
 * 拠点 1 基の 1 tick あたり維持費(GDD 9.2
 * `upkeep = 食料baseFood × 常駐人数 + 士気ケアbaseMorale × 距離帯係数`)。
 */
export function outpostUpkeepRateFix(
  outpost: OutpostState,
  def: OutpostTypeDef,
  params: OutpostParams,
): Fix {
  const foodFix = mulFixInt(def.upkeep.baseFoodFix, outpost.residentIds.length);
  const bandMulFix = params.distanceBandUpkeepMulFix[outpost.band];
  const moraleCareFix = mulFix(def.upkeep.baseMoraleCareFix, bandMulFix);
  return addFix(foodFix, moraleCareFix);
}

/** ネット収益(GDD 9.2「ネット収益 = supply資源換算 − upkeep」の文字どおりの式)。 */
export function outpostNetRevenueFix(supplyFix: Fix, upkeepFix: Fix): Fix {
  return subFix(supplyFix, upkeepFix);
}

// --- 5. 二重計上の防止(§2)---------------------------------------------------

/**
 * 「本拠の就労/探索派遣」と「衛星拠点の常駐」が同じ住民に重複していないかを
 * 検査する(検分観点そのもの)。拠点どうしの常駐重複も同時に検査する。
 *
 * 走査は住民・拠点とも ID 昇順(state の正準順)であり、検出される違反は
 * 決定論的に同じ順で報告される。
 *
 * @throws {RulesError} 同一住民が本拠就労/探索派遣と拠点常駐を同時に持つ、
 *   または複数拠点に同時常駐している場合
 */
export function assertNoDoubleStationedResidents(state: GameState): void {
  const busyAtHome = new Set<EntityId>();
  for (const facility of entitiesOfKind(state, "facility")) {
    for (const workerId of facility.workerIds) busyAtHome.add(workerId);
  }
  for (const resident of entitiesOfKind(state, "resident")) {
    if (resident.dispatched) busyAtHome.add(resident.id);
  }

  const stationedAt = new Map<EntityId, EntityId>();
  for (const outpost of allOutposts(state)) {
    for (const residentId of outpost.residentIds) {
      if (busyAtHome.has(residentId)) {
        throw new RulesError(
          `住民 "${residentId}" は本拠の就労中または探索派遣中でありながら` +
            `衛星拠点 "${outpost.id}" にも常駐している(二重計上・GDD 9.2)`,
        );
      }
      const other = stationedAt.get(residentId);
      if (other !== undefined) {
        throw new RulesError(
          `住民 "${residentId}" が拠点 "${other}" と "${outpost.id}" の両方に` +
            "同時常駐している(二重計上)",
        );
      }
      stationedAt.set(residentId, outpost.id);
    }
  }
}

// --- 6. 供給レートの集約と適用(GDD 9.2「決定論tickで本拠在庫へ自動供給」) ---

/** {@link computeOutpostSupplyRates} の結果。`rules/production.ts` の `ProductionRates` と同型。 */
export interface OutpostSupplyRates {
  /** content の resourceId → 全拠点合算の 1 tick あたり供給量。 */
  readonly resourceRateByResourceId: ReadonlyMap<EntityId, Fix>;
}

/**
 * 全拠点の供給レートを resourceId 別に集約する(§2 の唯一の入口。呼ぶたびに
 * {@link assertNoDoubleStationedResidents} を検査する)。
 *
 * 走査順は `allOutposts` の正準順(拠点 ID 昇順)。**scheduler には結線しない**
 * (ファイル冒頭 §1)ため、呼び出しは単体テスト・sim・将来の結線タスクの担当。
 *
 * @throws {RulesError} 二重計上を検出した場合(§5)/ outpostType 定義が無い場合
 */
export function computeOutpostSupplyRates(
  state: GameState,
  content: EngineContent,
  hazeRecessionDegreeFix: Fix = FIX_ZERO,
): OutpostSupplyRates {
  assertNoDoubleStationedResidents(state);

  const resourceRateByResourceId = new Map<EntityId, Fix>();
  for (const outpost of allOutposts(state)) {
    const def = requireOutpostTypeDef(content, outpost.outpostTypeId);
    const rateFix = outpostSupplyRateFix(outpost, def, hazeRecessionDegreeFix);
    if (toRaw(rateFix) === 0) continue;
    resourceRateByResourceId.set(
      def.resourceId,
      addFix(resourceRateByResourceId.get(def.resourceId) ?? FIX_ZERO, rateFix),
    );
  }
  return { resourceRateByResourceId };
}

/**
 * 拠点供給を本拠の resource 在庫へ一括加算する((A) 区間の閉形式 = レート ×
 * 区間長。`rules/production.ts` の `applyProduction` と同型)。
 *
 * **意図的な簡略化**: 保管上限/オーバーフロー会計(GDD 6.7・rules/storage.ts)は
 * 通さない(素直に加算するだけ)。**[M25]** scheduler.ts の段80 へ結線した後も
 * この簡略化は据え置く——`applyProduction` は本拠生産ぶんの上限判定を既に
 * 単独で担っており、拠点供給ぶんにも同じ上限判定を通す設計(廃材スポンジ・
 * 3出口の会計を拠点供給分だけ経路分岐させる必要が出る)は M25 のスコープ外
 * (段80 結線そのものが目的)。**同じ resource entity(resourceId で解決)へ書く**
 * ことが二重計上しようがない構造の根拠(§2)であり、この省略はそれとは独立
 * (rules/exploration.ts の報酬が同じ理由でオーバーフロー会計を通さないのと
 * 同種の判断)。上限判定を足すタスクでは telescoping の前提(区間分割不変性)を
 * 保ったまま storage.ts と組み合わせて設計すること。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない / 供給先の resource
 *   entity が state に無い場合
 */
export function applyOutpostSupply(
  state: GameState,
  rates: OutpostSupplyRates,
  deltaTicks: number,
): GameState {
  if (rates.resourceRateByResourceId.size === 0) return state;
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyOutpostSupply: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }

  let next = state;
  let matched = 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    const rateFix = rates.resourceRateByResourceId.get(resource.resourceId);
    if (rateFix === undefined) continue;
    matched++;
    const gainFix = mulFixInt(rateFix, deltaTicks);
    if (toRaw(gainFix) === 0) continue;
    next = updateEntity(next, resource.id, "resource", (r) =>
      setField(r, "stock", addFix(r.stock, gainFix)),
    );
  }
  if (matched !== rates.resourceRateByResourceId.size) {
    throw new RulesError(
      "applyOutpostSupply: 供給先の resource entity が state に無いレートがある" +
        `(レート ${String(rates.resourceRateByResourceId.size)} 件に対し受け皿 ${String(matched)} 件)`,
    );
  }
  return next;
}

// --- 7. ROI(GDD 9.2 のネット収益 + GDD 8.6 の (B) 喪失金銭化を援用・§4) ------

/** 拠点 1 基ぶんの ROI 内訳(UI・sim・テストが同じ数値を読むための形)。 */
export interface OutpostRoiReport {
  readonly outpostId: EntityId;
  readonly outpostTypeId: EntityId;
  /** 1 tick あたり供給(GDD 9.2 の「supply資源換算」)。 */
  readonly supplyValueFix: Fix;
  /** 1 tick あたり維持費(GDD 9.2 の「upkeep」)。 */
  readonly upkeepValueFix: Fix;
  /** ネット収益 = supply − upkeep(GDD 9.2 の文字どおりの式)。 */
  readonly netRevenueFix: Fix;
  /** 現在 tick の脅威強度(0〜1・GDD 12.1)。 */
  readonly hazardFix: Fix;
  /** 常駐者が保持する (B) 資産の件数(GDD 7.4 / 8.6 と同一定義)。 */
  readonly rareAssetCount: number;
  /** 期待 (B) 喪失損失 = hazard × Σ((B)資産価値換算)(GDD 8.6 を拠点へ援用)。 */
  readonly expectedRareLossFix: Fix;
  /** ROI = supply / (upkeep + 期待B喪失損失)。分母 0 なら null。 */
  readonly roiFix: Fix | null;
}

/**
 * 拠点 1 基の ROI(§4)。
 *
 * @throws {RulesError} outpostType 定義が無い / balance.outpost ブロックが無い場合
 */
export function outpostRoi(
  state: GameState,
  content: EngineContent,
  outpost: OutpostState,
  tick: number,
  hazeRecessionDegreeFix: Fix = FIX_ZERO,
): OutpostRoiReport {
  const def = requireOutpostTypeDef(content, outpost.outpostTypeId);
  const params = requireOutpostParams(content);

  const supplyValueFix = outpostSupplyRateFix(outpost, def, hazeRecessionDegreeFix);
  const upkeepValueFix = outpostUpkeepRateFix(outpost, def, params);
  const netRevenueFix = outpostNetRevenueFix(supplyValueFix, upkeepValueFix);
  const hazardFix = outpostHazardFix(outpost, def, tick);

  // GDD 8.6 の (B) 資産価値換算をそのまま再利用(同じ資産に 2 通りの値付けを
  // 作らない・ファイル冒頭 §4)。exploration ブロックが無い content では
  // (B) 喪失リスクを 0 として扱う(拠点システム自体は動く = 段階的縮退)。
  const rareAssetCount = rareAssetCountOf(state, content, outpost.residentIds);
  const rareAssetValueFix = content.exploration?.rareAssetValueFix ?? FIX_ZERO;
  const expectedRareLossFix = mulFix(hazardFix, mulFixInt(rareAssetValueFix, rareAssetCount));

  const denominatorFix = addFix(upkeepValueFix, expectedRareLossFix);
  const roiFix = toRaw(denominatorFix) === 0 ? null : floorDivFix(supplyValueFix, denominatorFix);

  return {
    outpostId: outpost.id,
    outpostTypeId: outpost.outpostTypeId,
    supplyValueFix,
    upkeepValueFix,
    netRevenueFix,
    hazardFix,
    rareAssetCount,
    expectedRareLossFix,
    roiFix,
  };
}

/** {@link outpostNetworkRoi} の結果(GDD 11.4-7「拠点網ROI」の判定値)。 */
export interface OutpostNetworkRoiReport {
  readonly outpostCount: number;
  readonly totalSupplyValueFix: Fix;
  readonly totalUpkeepValueFix: Fix;
  readonly totalNetRevenueFix: Fix;
  readonly totalExpectedRareLossFix: Fix;
  /** 網全体の ROI = Σsupply / (Σupkeep + Σ期待B喪失損失)。分母 0 なら null。 */
  readonly roiFix: Fix | null;
  /** 拠点 ID 昇順の内訳。 */
  readonly perOutpost: readonly OutpostRoiReport[];
}

/**
 * 拠点網全体の ROI(GDD 11.4-7「拠点網ROI」)。各拠点の {@link outpostRoi} を
 * 拠点 ID 昇順(`allOutposts` の正準順)で集約する。拠点が 1 つも無い state では
 * 全フィールドが 0 / 空 / null になる(= 拠点システム不活性時の既定形)。
 *
 * @throws {RulesError} outpostType 定義が無い / balance.outpost ブロックが無い
 *   拠点が 1 つでもある場合
 */
export function outpostNetworkRoi(
  state: GameState,
  content: EngineContent,
  tick: number,
  hazeRecessionDegreeFix: Fix = FIX_ZERO,
): OutpostNetworkRoiReport {
  const perOutpost = allOutposts(state).map((outpost) =>
    outpostRoi(state, content, outpost, tick, hazeRecessionDegreeFix),
  );

  let totalSupplyValueFix = FIX_ZERO;
  let totalUpkeepValueFix = FIX_ZERO;
  let totalExpectedRareLossFix = FIX_ZERO;
  for (const report of perOutpost) {
    totalSupplyValueFix = addFix(totalSupplyValueFix, report.supplyValueFix);
    totalUpkeepValueFix = addFix(totalUpkeepValueFix, report.upkeepValueFix);
    totalExpectedRareLossFix = addFix(totalExpectedRareLossFix, report.expectedRareLossFix);
  }
  const totalNetRevenueFix = subFix(totalSupplyValueFix, totalUpkeepValueFix);
  const denominatorFix = addFix(totalUpkeepValueFix, totalExpectedRareLossFix);
  const roiFix =
    toRaw(denominatorFix) === 0 ? null : floorDivFix(totalSupplyValueFix, denominatorFix);

  return {
    outpostCount: perOutpost.length,
    totalSupplyValueFix,
    totalUpkeepValueFix,
    totalNetRevenueFix,
    totalExpectedRareLossFix,
    roiFix,
    perOutpost,
  };
}

// --- 8. 診断クエリ(UI / sim 向け・rules/exploration.ts §7 と同型) -----------

/** 拠点に常駐している住民 ID を ID 昇順で平坦化する(診断・テスト用)。 */
export function stationedResidentIds(state: GameState): readonly EntityId[] {
  const ids: EntityId[] = [];
  for (const outpost of allOutposts(state)) {
    ids.push(...outpost.residentIds);
  }
  return [...ids].sort(compareUtf16);
}
