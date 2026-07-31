// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 人口下限保証と獲得/規模 — GDD 7.6 / 7.7 / 11.4-9 / 11.7
//
// ===========================================================================
// 1. 既定は「完全に不活性」(golden vector 不変の根拠)
// ===========================================================================
//   本モジュールが動くのは次の 2 条件がともに成り立つときだけである:
//     (a) content に `townParams` ブロックがある(= `EngineContent.town` が存在)
//     (b) 盤面の**寝床上限が 1 以上**(= `bedCapacityByLevel` を持つ施設が建っている)
//   どちらかが欠ければ人口下限は 0、晴天漂着のイベントは 1 件も積まれない。
//   現 content には寝床施設が無いので (b) が成り立たず、既存 conformance
//   シナリオでは離散事象の本数もカウンタも 1 も動かない。
//   加えて**死亡イベントは `resident.life` を持つ住民にしか積まれない**
//   (state.ts の `ResidentLife` は省略可)ため、既存シナリオの住民は寿命で
//   死なない。これが golden vector 37 本が不変であることの根拠である。
//
// ===========================================================================
// 2. 人口下限の式(GDD 7.6 / 11.4-9)
// ===========================================================================
//     下限 = min(寝床上限 × 0.5, 6)
//   人口は整数なので「人口 ≥ 寝床上限 × 0.5」は「人口 ≥ ceil(寝床上限 × 0.5)」と
//   同値である。よって **ceil で整数化する**(floor にすると寝床 5 のとき
//   「人口 ≥ 2.5」を「人口 ≥ 2」に緩めてしまい、GDD の不等式より弱くなる)。
//
// ===========================================================================
// 3. 「全 tick で人口 ≥ 下限」が構造的に成り立つ仕組み
// ===========================================================================
//   人口が減る経路は**死亡だけ**であり、その死亡は {@link applyResidentDeath}
//   の 1 箇所しかない。そこに次のゲートを置く:
//
//     生存人口 − 1 < 下限 なら、その死亡は**起こさず延期する**
//
//   これだけで次の 2 つが帰納的に従う(テスト tests/engine/population.test.ts):
//     T1: 開始時に 人口 >= 下限 なら、以後**全 tick**で 人口 >= 下限
//         (人口を減らす唯一の遷移がゲートを通るため)
//     T2: 開始時に 人口 < 下限 でも人口は**減らない**(全ての死亡が延期される)。
//         下限へは加入(晴天漂着)によって単調に回復する。
//   T2 が要るのは、下限が盤面依存だからである — 寝床を増築した瞬間に下限が
//   跳ね上がり、既存人口がそれを下回る状態が正当に発生する(GDD 7.6 が
//   「下回ると漂着頻度 ×1.5」と書いているのはまさにこの状況)。
//
//   GDD 7.6 の「6未満なら次回加入イベントを前倒し確定」は**回復の加速**として
//   実装する(周期を `scarcityArrivalIntervalTicks` に切り替える)。それだけでは
//   「全 tick で下限以上」は保証できない — 加入は寝床上限に縛られ(GDD 7.7)、
//   寝床が埋まっていれば同一 tick の救済が成立しないからである。したがって
//   **絶対保証の担い手は死亡ゲートの側**であり、頻度 ×1.5 はその上に乗る
//   回復速度の調整である。GDD 7.6 の「最低6人を絶対保証」という語を
//   文字どおり成り立たせるための実装判断(要ユーザー判断として報告済み)。
//
//   延期された死亡は捨てない: scheduler が次の加入 tick へ再予約し、加入で
//   人口が増えていればそこで死亡が成立する(scheduler.ts §6)。加入が地平線内に
//   無ければ次回 advance の `buildEventQueue` が state から積み直す。
//
// ===========================================================================
// 4. 加入 tick は「絶対グリッド」(分割不変の根拠)
// ===========================================================================
//   加入 tick は state に「前回加入 tick」を持たせるのではなく、粗粒度ステップ
//   (stochastic.ts)と同じく **tick の絶対グリッド**(周期の倍数)に固定する。
//   これにより advance をどこで区切っても踏む加入 tick の集合が変わらない
//   = 分割不変。周期は人口が下限を下回っているかで 2 本のグリッドを切り替えるが、
//   切り替えの入力(人口・寝床上限)は state の関数なので、区切り位置に依らず
//   同じ判断になる。
//
//   周期が advance の途中で「不足 → 充足」へ変わることはあっても逆は無い:
//   人口は死亡ゲート(§3)により下限を下回れず、寝床上限が増えるのは
//   Command 経路(= イベントキューを作り直す)だけだからである。
// ---------------------------------------------------------------------------

import { FIX_SCALE, FIX_ZERO, fixFromInt, floorDivInt, mulFixInt, toRaw } from "../fp";
import {
  entitiesOfKind,
  entityIdFromString,
  isAliveResident,
  livingResidents,
  requireEntity,
  type EntityId,
  type GameState,
  type ResidentState,
} from "../state/state";
import { putEntity, setField, updateEntity } from "../state/update";
import { createResidentLife } from "./lifespan";
import { initializeResidentMemoir } from "./memoir";
import { RulesError, requireFacilityDef, type AdvanceContext, type EngineContent } from "./types";

/**
 * 晴天漂着で加入した住民の ID 接頭辞。ID は `residentDrift<加入tick>` で、
 * **1 tick に高々 1 人しか加入しない**(§4 の絶対グリッド)ので一意になる。
 * 状態にカウンタを持たずに一意な ID を作れることが、この命名の理由である。
 */
export const ARRIVAL_RESIDENT_ID_PREFIX = "residentDrift";

/**
 * 加入した住民の初期士気。GDD 11.2 の閾値(<30 / <15 / >=40)に対する中立値として
 * 50 を採る。**GDD に明示が無い engine 定数**であり、士気の更新規則が入る段
 * (M12 以降)で見直すこと。
 */
export const ARRIVAL_INITIAL_MORALE_FIX = fixFromInt(50);

/** 晴天漂着で加入する住民の ID(§4)。 */
export function arrivalResidentIdOf(tick: number): EntityId {
  return entityIdFromString(`${ARRIVAL_RESIDENT_ID_PREFIX}${String(tick)}`);
}

// --- 1. 盤面の人口ビュー ---------------------------------------------------

/** 人口まわりの一括算出結果(同じ量を何度も数え直さないため)。 */
export interface PopulationView {
  /** 生存している住民の人数。 */
  readonly living: number;
  /** 盤面の寝床上限(GDD 7.7)。寝床施設が無ければ 0。 */
  readonly bedCapacity: number;
  /** GDD 7.6 の人口下限 `min(寝床上限 × 0.5, 6)`(§2 の ceil 整数化済み)。 */
  readonly floor: number;
  /** 人口が下限を下回っているか(GDD 7.6 の漂着頻度 ×1.5 の条件)。 */
  readonly scarce: boolean;
}

/**
 * 盤面の寝床上限(GDD 7.7)。`bedCapacityByLevel` を持つ施設の Lv 別値の総和。
 *
 * @throws {RulesError} facility 定義が無い / Lv が寝床カーブの範囲外の場合
 */
export function bedCapacityOf(state: GameState, content: EngineContent): number {
  let total = 0;
  for (const facility of entitiesOfKind(state, "facility")) {
    const def = requireFacilityDef(content, facility.defId);
    const curve = def.bedCapacityByLevel;
    if (curve === undefined) continue;
    const value = curve[facility.level - 1];
    if (value === undefined) {
      throw new RulesError(
        `facility "${def.id}" の Lv${String(facility.level)} の寝床上限が定義に無い` +
          `(bedCapacityByLevel の長さ ${String(curve.length)})`,
      );
    }
    total += value;
  }
  return total;
}

/** 生存している住民の人数(GDD 7.6 / 11.4-9 の「人口」)。 */
export function livingPopulationOf(state: GameState): number {
  return livingResidents(state).length;
}

/**
 * GDD 7.6 の人口下限 `min(寝床上限 × 0.5, 6)`(§2)。
 * content に `townParams` が無ければ **0**(= 下限という概念が無い・§1)。
 */
export function populationFloorOf(bedCapacity: number, content: EngineContent): number {
  const town = content.town;
  if (town === undefined) return 0;
  // 人口は整数なので「>= 寝床 × 0.5」は「>= ceil(寝床 × 0.5)」と同値(§2)。
  const scaled = mulFixInt(town.populationFloorBedRatioFix, bedCapacity);
  const ceiled = floorDivInt(toRaw(scaled) + FIX_SCALE - 1, FIX_SCALE);
  return Math.min(ceiled, town.populationFloorAbsolute);
}

/** 盤面の人口ビューを一括算出する。 */
export function populationViewOf(state: GameState, content: EngineContent): PopulationView {
  const living = livingPopulationOf(state);
  const bedCapacity = bedCapacityOf(state, content);
  const floor = populationFloorOf(bedCapacity, content);
  return { living, bedCapacity, floor, scarce: living < floor };
}

// --- 2. 晴天漂着(GDD 7.7)-------------------------------------------------

/**
 * `fromTick` 以降(同 tick を含む)で最初の加入グリッド tick(§4)。
 * tick 0 は「ゲーム開始と同時に漂着」になってしまうので必ず 1 周期目以降を返す。
 *
 * @throws {RulesError} 周期が 1 以上の整数でない場合
 */
export function nextArrivalTickAtOrAfter(fromTick: number, intervalTicks: number): number {
  if (!Number.isSafeInteger(intervalTicks) || intervalTicks < 1) {
    throw new RulesError(`加入周期 ${String(intervalTicks)} が 1 以上の整数でない`);
  }
  const index = floorDivInt(fromTick + intervalTicks - 1, intervalTicks);
  return Math.max(index, 1) * intervalTicks;
}

/**
 * 現在の盤面で適用される加入周期(GDD 7.6 の頻度 ×1.5 を周期側で表現・§4)。
 * 加入機構が不活性(§1)なら null。
 */
export function arrivalIntervalTicksOf(state: GameState, content: EngineContent): number | null {
  const town = content.town;
  if (town === undefined) return null;
  const view = populationViewOf(state, content);
  if (view.bedCapacity < 1) return null;
  return view.scarce ? town.scarcityArrivalIntervalTicks : town.arrivalIntervalTicks;
}

/**
 * 次の加入判定 tick。加入機構が不活性(§1)なら null。
 *
 * 「加入判定 tick」であって「必ず人が増える tick」ではない — 寝床が埋まって
 * いれば判定だけ行って誰も増えない(GDD 7.7「寝床上限内の…定期加入」)。
 */
export function nextArrivalTick(
  state: GameState,
  content: EngineContent,
  fromTick: number,
): number | null {
  const interval = arrivalIntervalTicksOf(state, content);
  return interval === null ? null : nextArrivalTickAtOrAfter(fromTick, interval);
}

/** {@link applyArrival} の結果。誰も増えなかった場合 `arrivedId` は null。 */
export interface ArrivalResult {
  readonly state: GameState;
  readonly arrivedId: EntityId | null;
}

/**
 * 晴天漂着を 1 回判定する(GDD 7.7)。寝床上限に空きがあるときだけ 1 人増える。
 *
 * 生成される住民は**中立値**(士気 50 / mastery 0 / trait なし / ステータス未設定
 * = 全て基準 50)で、生涯だけが seed 決定論生成される。ステータスの振り分け・
 * trait 抽選は未実装のまま(意図的に持たせていない)だが、**[M25] memoirLog の
 * bio 3 件(出自/口癖/恐れ)+加入記録は `initializeResidentMemoir` で結線済み**
 * (裁定 v1必-2 / coverage.json `mem-bio-arrival-unwired` の解消。探索での保護
 * (`rules/exploration.ts` の `joinRescuedResident`)が既に同じ関数を呼んでいたのと
 * 同じ生成規則を晴天漂着へも揃えた。「生成規則が二重に存在する」ことにはならない
 * ——bio の実際の文言(日本語プロース)は今も未実装で、持つのはテンプレ ID +
 * 決定論パラメータだけである・memoir.ts §1)。
 *
 * @throws {RulesError} 生成 ID が既に state にある場合(1 tick 1 人の不変条件違反)
 */
export function applyArrival(state: GameState, ctx: AdvanceContext, tick: number): ArrivalResult {
  const town = ctx.content.town;
  if (town === undefined) return { state, arrivedId: null };

  const view = populationViewOf(state, ctx.content);
  if (view.bedCapacity < 1 || view.living >= view.bedCapacity) {
    return { state, arrivedId: null };
  }

  const id = arrivalResidentIdOf(tick);
  if (state.entityStateById.has(id)) {
    throw new RulesError(
      `晴天漂着の生成 ID "${id}" が既に存在する(1 tick に 1 人までの不変条件違反・rules/population.ts §4)`,
    );
  }

  const resident: ResidentState = {
    kind: "resident",
    id,
    morale: ARRIVAL_INITIAL_MORALE_FIX,
    mastery: FIX_ZERO,
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
    life: createResidentLife(ctx.worldSeedU32, id, tick, town),
  };
  return {
    state: initializeResidentMemoir(putEntity(state, resident), ctx.worldSeedU32, id, tick),
    arrivedId: id,
  };
}

// --- 3. 死亡と人口下限ゲート(GDD 7.6 / 11.7 段70)-------------------------

/** {@link applyResidentDeath} の結果。 */
export interface DeathResult {
  readonly state: GameState;
  /** 実際に死亡したか。false は「人口下限の保持で延期された」か「既に死亡済み」。 */
  readonly died: boolean;
  /** 人口下限の保持で延期されたか(scheduler が再予約するかの判断に使う)。 */
  readonly deferredByFloor: boolean;
}

/**
 * 住民 1 人の寿命死を適用する(§3)。**人口を減らす唯一の関数**。
 *
 * 人口下限を割る死は起こさず延期する(GDD 7.6「最低6人を絶対保証」)。延期は
 * 取り消しではない — 寿命は `life.lifespanTick` に残り続け、人口が下限を上回った
 * 時点で死亡が成立する。{@link remainingLifeTicks} は延期中に負値を返し、
 * 「寿命を超えて踏みとどまっている」状態が観測できる。
 *
 * 死亡時は tombstone(`life.diedTick` を立てる)にしたうえで、就労参照を掃除する:
 * 配属を外し、全 facility の `workerIds` から取り除く。掃除しないと生産式が
 * 死者を数え続ける(state.ts の {@link isAliveResident} で二重に防いではいる)。
 *
 * @throws {RulesError} 寿命を持たない住民に対して呼ばれた場合(呼び出し側のバグ)
 */
export function applyResidentDeath(
  state: GameState,
  ctx: AdvanceContext,
  residentId: EntityId,
  tick: number,
): DeathResult {
  const resident = requireEntity(state, residentId, "resident");
  if (!isAliveResident(resident)) return { state, died: false, deferredByFloor: false };

  const life = resident.life;
  if (life === undefined) {
    throw new RulesError(
      `住民 "${residentId}" は寿命(life)を持たないのに死亡処理が呼ばれた` +
        "(寿命の無い住民には死亡イベントを積まない・rules/population.ts §1)",
    );
  }

  const view = populationViewOf(state, ctx.content);
  if (view.living - 1 < view.floor) {
    // 人口下限の保持。ここが「全 tick で人口 >= 下限」の構造的な根拠(§3)。
    return { state, died: false, deferredByFloor: true };
  }

  let next = updateEntity(state, residentId, "resident", (r) =>
    setField(
      setField(r, "life", {
        bornTick: life.bornTick,
        lifespanTick: life.lifespanTick,
        diedTick: tick,
      }),
      "assignedFacilityId",
      null,
    ),
  );

  // 就労参照の掃除。facility 側は entitiesOfKind のスナップショットを走るので、
  // ループ中に next を差し替えても走査対象はぶれない。
  for (const facility of entitiesOfKind(next, "facility")) {
    if (!facility.workerIds.includes(residentId)) continue;
    const remaining = facility.workerIds.filter((workerId) => workerId !== residentId);
    next = updateEntity(next, facility.id, "facility", (f) => setField(f, "workerIds", remaining));
  }

  return { state: next, died: true, deferredByFloor: false };
}
