// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 襲撃(raid)と防衛係数 — GDD 11.1 / 11.7 段10 / 6.2 / M66
//
// ===========================================================================
// 1. GDD のどこを実装しているか
// ===========================================================================
//   GDD 11.1(経済数式)の最後の行:
//     戦闘: `勝敗 = (Σ防衛戦力 × 配置ボーナス + seededRoll) vs 襲撃強度(時代逓増)`、
//           全滅回避フェイルセーフ有。
//   GDD 11.7 の同一 tick 内優先順位の**段10「襲撃判定」**(scheduler.ts の
//   `PIPELINE_STAGE.raid` として番号だけ予約されていた段)。
//   GDD 6.2 の隣接ルール表の最終行「見張り台 → **外周ほど防衛係数上昇**」。
//
//   M66 以前、`defense`(防衛係数)は `schema/engineContent.ts` の
//   `UNREPRESENTABLE_CONTENT_EFFECTS` に「襲撃システムに属し縮約 rules の
//   対象外」と登録されていた。本モジュールがその襲撃システムであり、見張り台に
//   「効果ゼロのままでは偽の需要」(ロードマップ M66)を解消する実体を与える。
//
//   **[解釈] GDD が書いていない点と、その最小解釈**:
//     (a) 「Σ防衛戦力」の出所を GDD は書いていない。見張り台が防衛係数を上げる
//         (6.2)以上、**防衛係数を持つ施設の Lv 別カーブの総和**と読む
//         (`facility.defenseCurve`。寝床/保管庫と同じ「カーブ1本の設備」形)。
//     (b) 「配置ボーナス」= 6.2 の「外周ほど」。格子 6×8 の**外周セル**
//         (x=0 / x=5 / y=0 / y=7)に置かれた防衛施設へ倍率を掛ける 2 段の
//         最小解釈を採る(「ほど」の連続勾配は採らない —— 連続勾配は
//         中心からの距離の定義を engine が発明することになるため)。
//         大型施設の代表セルは**アンカーセル**(GDD 6.3 [2026-07-30裁定]③ と
//         同じ規約)。
//     (c) 「襲撃強度(時代逓増)」= `baseStrength + growthPerEra × (到達エラ − 1)`。
//         到達エラは `rules/exodus.ts` の {@link reachedEraOrder} を**再利用**する
//         (engine が 2 つめの「到達エラ」定義を持たない)。
//     (d) 「全滅回避フェイルセーフ」= **襲撃では住民が死なない・施設も壊れない**。
//         負けたときの損害は在庫の一部略奪(`lootRatio`)だけに限る。GDD 2.2 /
//         7.6 の「コロニー全滅 END は起きない設計」「人口下限の絶対保証」と
//         衝突しないことが構造的に保証される(死亡経路を増やさない)。
//     (e) 襲撃の**周期**は GDD に無い。晴天漂着(GDD 7.7)と同じ
//         「tick の絶対グリッド」方式(`n × intervalTicks`)にした。state に
//         カウンタを持たずに済み、分割不変性が構造的に保たれる。
//
// ===========================================================================
// 2. 決定論(ADR-006 / 007)
// ===========================================================================
//   seededRoll は **hash アドレス方式**(`hashedDrawUint32` + 新ドメインタグ
//   `raid`)で引く: salt = 襲撃の連番(tick / intervalTicks)。逐次ストリームを
//   進めないので、襲撃を実装しても既存の確率系(recallDuration / exploration)の
//   乱数列は 1 bit も動かない。
//
//   略奪は `rules/storage.ts` の {@link spendResources}(消費の単一経路)へ
//   寄せる。**生産会計(cumulativeProduced / cumulativeOverflow)は動かさない**
//   —— 略奪は産出でも保管上限あふれでもないため(GDD 11.4-7c の分母/分子を
//   襲撃が動かさないことの根拠。Phase B の一括入荷廃材の会計除外と同じ立場)。
//
//   走査順は施設 entity・resource entity とも ID 昇順(正準順・GDD 11.7)。
// ---------------------------------------------------------------------------

import { FIX_ONE, FIX_ZERO, addFix, fixFromInt, mulFix, mulFixInt, toRaw, type Fix } from "../fp";
import { GRID_HEIGHT, GRID_WIDTH, GRID_CELL_COUNT } from "../adjacency";
import { DOMAIN_TAGS } from "../rng/domainTags";
import { entitiesOfKind, type EntityId, type GameState } from "../state/state";
import { floorDivInt } from "../fp";
import { hashedDrawUint32, uniformIntFromDraw } from "../stochastic";
import { reachedEraOrder } from "./exodus";
import { spendResources } from "./storage";
import { requireFacilityDef, RulesError, type AdvanceContext, type EngineContent } from "./types";

/**
 * そのセルが格子の外周か(GDD 6.2「外周ほど防衛係数上昇」の §1(b) 解釈)。
 *
 * @throws {RulesError} セル番号が格子の範囲外の場合
 */
export function isPerimeterCell(cellIndex: number): boolean {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= GRID_CELL_COUNT) {
    throw new RulesError(
      `isPerimeterCell: セル番号 ${String(cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})を外れている`,
    );
  }
  const x = cellIndex % GRID_WIDTH;
  const y = (cellIndex - x) / GRID_WIDTH;
  return x === 0 || x === GRID_WIDTH - 1 || y === 0 || y === GRID_HEIGHT - 1;
}

/**
 * 盤面の防衛戦力 = Σ(防衛係数(Lv) × 配置ボーナス)(GDD 11.1 の左辺第1項・§1(a)(b))。
 *
 * `perimeterMulFix` は外周セルの施設に掛ける倍率(`balance.raid.perimeterDefenseMul`)。
 * 防衛係数を持つ施設が 1 つも無ければ 0。
 *
 * @throws {RulesError} facility 定義が無い / Lv が防衛カーブの範囲外の場合
 */
export function colonyDefenseFix(
  state: GameState,
  content: EngineContent,
  perimeterMulFix: Fix,
): Fix {
  let total = FIX_ZERO;
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(content, facility.defId);
    const curve = def.defenseByLevel;
    if (curve === undefined) continue;
    const value = curve[facility.level - 1];
    if (value === undefined) {
      throw new RulesError(
        `facility "${def.id}" の Lv${String(facility.level)} の防衛係数が定義に無い` +
          `(defenseByLevel の長さ ${String(curve.length)})`,
      );
    }
    // 配置ボーナスは施設 1 基につき 1 回(GDD 6.3「1施設1回のみ計上」と同じ立場)。
    const contribution = isPerimeterCell(facility.cellIndex)
      ? mulFix(value, perimeterMulFix)
      : value;
    total = addFix(total, contribution);
  }
  return total;
}

/**
 * その時点の襲撃強度(GDD 11.1「襲撃強度(時代逓増)」・§1(c))。
 * 到達エラ 0(まだ 1 本も研究が完了していない)は 1 と同じ扱い = 基準強度。
 */
export function raidStrengthFix(state: GameState, content: EngineContent): Fix {
  const raid = content.raid;
  if (raid === undefined) return FIX_ZERO;
  const era = Math.max(1, reachedEraOrder(state, content));
  return addFix(raid.baseStrengthFix, mulFixInt(raid.strengthGrowthPerEraFix, era - 1));
}

/**
 * 次の襲撃判定 tick(絶対グリッド・§1(e))。襲撃機構が不活性なら null。
 * `rules/population.ts` の `nextArrivalTickAtOrAfter` と同型。
 */
export function nextRaidTick(content: EngineContent, fromTick: number): number | null {
  const raid = content.raid;
  if (raid === undefined) return null;
  const interval = raid.intervalTicks;
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new RulesError(`襲撃周期 ${String(interval)} が 1 以上の整数でない`);
  }
  const index = floorDivInt(fromTick + interval - 1, interval);
  return Math.max(index, 1) * interval;
}

/** {@link resolveRaid} の結果(観測・テスト用の内訳つき)。 */
export interface RaidResult {
  readonly state: GameState;
  /** 撃退できたか(GDD 11.1 の「勝敗」)。 */
  readonly repelled: boolean;
  /** Σ防衛戦力 × 配置ボーナス。 */
  readonly defenseFix: Fix;
  /** seededRoll(0〜`rollRange` の一様整数)。 */
  readonly rollFix: Fix;
  /** 襲撃強度。 */
  readonly strengthFix: Fix;
  /** 略奪された総量(全資源の合計・撃退できたら 0)。 */
  readonly lootTotalFix: Fix;
}

/**
 * 襲撃 1 回を解決する(GDD 11.7 段10)。
 *
 * 撃退できなければ**全資源の在庫から `lootRatio` を略奪**する(§1(d) の
 * フェイルセーフ: 住民は死なず施設も壊れない)。略奪量は在庫 × 比率の floor
 * なので、在庫が 0 の資源は 0 のまま = 負在庫は構造的に起きない。
 *
 * @throws {RulesError} 襲撃機構が不活性(`content.raid` が無い)なのに呼ばれた場合
 */
export function resolveRaid(state: GameState, ctx: AdvanceContext, tick: number): RaidResult {
  const raid = ctx.content.raid;
  if (raid === undefined) {
    throw new RulesError("resolveRaid: content に raid ブロックが無い(襲撃機構が不活性)");
  }

  const defenseFix = colonyDefenseFix(state, ctx.content, raid.perimeterDefenseMulFix);
  const raidIndex = floorDivInt(tick, raid.intervalTicks);
  const draw = hashedDrawUint32(ctx.worldSeedU32, DOMAIN_TAGS.raid, [raidIndex]);
  const rollFix = fixFromInt(uniformIntFromDraw(draw, 0, raid.rollRange));
  const strengthFix = raidStrengthFix(state, ctx.content);
  const repelled = toRaw(addFix(defenseFix, rollFix)) >= toRaw(strengthFix);

  if (repelled) {
    return { state, repelled, defenseFix, rollFix, strengthFix, lootTotalFix: FIX_ZERO };
  }

  const losses = new Map<EntityId, Fix>();
  let lootTotalFix = FIX_ZERO;
  for (const resource of entitiesOfKind(state, "resource")) {
    const loss = mulFix(resource.stock, raid.lootRatioFix);
    if (toRaw(loss) <= 0) continue;
    losses.set(resource.resourceId, loss);
    lootTotalFix = addFix(lootTotalFix, loss);
  }
  return {
    state: spendResources(state, losses),
    repelled,
    defenseFix,
    rollFix,
    strengthFix,
    lootTotalFix,
  };
}

/** 防衛係数を 1 も持たない盤面かどうか(UI/診断用の縮約クエリ)。 */
export function hasDefense(state: GameState, content: EngineContent): boolean {
  return toRaw(colonyDefenseFix(state, content, FIX_ONE)) > 0;
}
