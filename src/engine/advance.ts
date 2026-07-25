// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- tick 前進の入口 — ADR-026 / ADR-012 / GDD 11.1 / 11.9
//
// ===========================================================================
// 1. tick は「単調経過時刻の純関数」(ADR-026)
// ===========================================================================
//   ゲーム内時計はタイマーの**発火回数**でなく、単調時刻の経過だけで決まる:
//
//     targetTick = startTick + clamp(0, floor(elapsedMonotonicMs / 60000), 4320)
//                              // 1 tick = 1 分、72h クランプ(GDD 11.1 / 11.9)
//
//   これにより、バックグラウンドタブで rAF / setInterval が間引かれても、
//   復帰時に何回発火したかに関わらず結果が一意に決まる。engine は時刻を**読まない**
//   (Date / performance は lint で禁止)ので、経過 ms は platform/clock.ts から
//   引数として渡される。ここが「時刻という非決定な入力」を engine の外に押し出す
//   境界である。
//
//   ADR-026(3) の「差分が小さいならメインスレッド、長期不在は Worker へ委譲」は
//   呼び出し側(platform)の判断であり、engine 側は同じ純関数を提供するだけ。
//
// ===========================================================================
// 2. コンテキストを 1 回作って使い回す
// ===========================================================================
//   隣接乗数(施設配置に依存)とシード揺らぎ(worldSeed に依存)は advance の
//   途中で変わらないので、{@link createAdvanceContext} で一度だけ計算して
//   {@link AdvanceContext} に載せる(rules/types.ts §5)。配置変更コマンドを
//   適用したらコンテキストを作り直すこと。
//
// ===========================================================================
// 3. 分割不変(catch-up の正しさの根拠)
// ===========================================================================
//   `advance(s, ctx, T2)` と `advance(advance(s, ctx, T1), ctx, T2)`(T1 は途中)は
//   完全に一致する。理由は scheduler.ts §2(半開区間の規約)と
//   stochastic.ts の粗粒度グリッドが tick の絶対値に固定されていること。
//   この性質があるので「オフライン 72h ぶんを一括で計算する」ことと
//   「フォアグラウンドで小刻みに進める」ことが同じ結果になる = 計測 #1 の
//   catch-up 計算をフォアグラウンドの実装と別扱いにしなくてよい。
// ---------------------------------------------------------------------------

import { applySeedOffsets } from "./adjacency";
import { floorDivInt } from "./fp";
import { computeMultiplierByFacilityId } from "./rules/production";
import type { AdvanceContext, EngineContent } from "./rules/types";
import {
  OFFLINE_CLAMP_TICK,
  TICK_MS,
  clampOfflineTickDelta,
  runSchedule,
  type ScheduleOptions,
  type ScheduleReport,
} from "./scheduler";
import type { GameState } from "./state/state";
import { worldSeedToUint32 } from "./stochastic";

/** advance の入力の誤り(経過 ms が非有限・目標 tick が過去など)。 */
export class AdvanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvanceError";
  }
}

export { OFFLINE_CLAMP_TICK, TICK_MS };

/**
 * 経過実時間(ms)を tick 差へ変換する(§1)。
 *
 * 小数 ms(`performance.now()` 由来)は先に floor で整数化する。整数化してから
 * 安全整数どうしの floor 除算にすることで、倍精度の割り算が整数境界付近で
 * 1 ずれる可能性を排除する(fp.ts の補題 L2)。負値は 0 に落とす
 * (巻き戻しの検知は platform 側・GDD 11.9)。
 *
 * @throws {AdvanceError} 非有限、または |ms| が 2^53 を超える場合
 */
export function elapsedMsToTickDelta(elapsedMonotonicMs: number): number {
  if (!Number.isFinite(elapsedMonotonicMs)) {
    throw new AdvanceError(
      `elapsedMsToTickDelta: 経過 ms ${String(elapsedMonotonicMs)} が有限でない(単調時刻ソースの異常)`,
    );
  }
  const floored = Math.floor(elapsedMonotonicMs);
  if (!Number.isSafeInteger(floored)) {
    throw new AdvanceError(
      `elapsedMsToTickDelta: 経過 ms ${String(elapsedMonotonicMs)} が安全整数の範囲を超えている`,
    );
  }
  if (floored <= 0) return 0;
  return clampOfflineTickDelta(floorDivInt(floored, TICK_MS));
}

/**
 * ADR-026 の targetTick 式(§1)。
 *
 * @throws {AdvanceError} startTick が 0 以上の整数でない場合
 */
export function computeTargetTick(startTick: number, elapsedMonotonicMs: number): number {
  if (!Number.isSafeInteger(startTick) || startTick < 0) {
    throw new AdvanceError(
      `computeTargetTick: startTick ${String(startTick)} が 0 以上の整数でない`,
    );
  }
  return startTick + elapsedMsToTickDelta(elapsedMonotonicMs);
}

/**
 * advance のコンテキストを作る(§2)。
 *
 * やることは 2 つだけ:
 *   (1) worldSeed(文字列)→ uint32(hash アドレス方式 RNG の入力)
 *   (2) 隣接行列へ周回固定のシード揺らぎを焼き込み、施設ごとの産出乗数を precompute
 *
 * @throws {RulesError} content の facility 定義が欠けている / セル重複がある場合
 */
export function createAdvanceContext(state: GameState, content: EngineContent): AdvanceContext {
  const worldSeedU32 = worldSeedToUint32(state.worldSeed);
  const adjacency = applySeedOffsets(content.adjacency, worldSeedU32);
  return {
    content,
    worldSeedU32,
    multiplierByFacilityId: computeMultiplierByFacilityId(state, content, adjacency),
  };
}

/**
 * 目標 tick まで進める(§3 の分割不変が成り立つ唯一の入口)。
 *
 * @throws {SchedulerError} toTick が現在 tick より小さい場合
 */
export function advance(state: GameState, ctx: AdvanceContext, toTick: number): GameState {
  return runSchedule(state, ctx, toTick).state;
}

/**
 * 目標 tick まで進め、区間分類のカウンタ付きで返す(計測ハーネス用)。
 * 中身は {@link advance} と同一で、返す情報だけが多い。
 */
export function advanceWithReport(
  state: GameState,
  ctx: AdvanceContext,
  toTick: number,
  options?: ScheduleOptions,
): ScheduleReport {
  return runSchedule(state, ctx, toTick, options ?? {});
}

/**
 * 経過実時間から目標 tick を求めて進める(ADR-026 の実際の呼び出し形)。
 * 72h クランプはこの経路で掛かる(scheduler.ts §4)。
 */
export function advanceByElapsedMs(
  state: GameState,
  ctx: AdvanceContext,
  elapsedMonotonicMs: number,
): GameState {
  return advance(state, ctx, computeTargetTick(state.tick, elapsedMonotonicMs));
}
