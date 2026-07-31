// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面共通の表示整形(M29)
//
// **ゲーム内時刻を実時刻へ換算しない**。1 tick = 1 分(GDD 11.1 / ADR-026)で
// あり、ここでやるのは整数演算だけである。`Date` / `Intl` / ロケール依存の
// 書式化は 1 つも使わない —— 表示が実行環境の設定で変わると、スクリーン
// ショット由来の不具合報告が読めなくなるため(engine の決定論とは別の理由だが
// 方針は同じ)。
// ---------------------------------------------------------------------------

/** 1 ゲーム日 = 1440 tick(GDD 11.1: 1 tick = 1 分)。 */
export const TICKS_PER_GAME_DAY = 1440;
/** 1 ゲーム時間 = 60 tick。 */
export const TICKS_PER_GAME_HOUR = 60;

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/**
 * ゲーム内時計(`第N日 HH:MM`)。tick は 0 以上の整数、初日は「第1日」。
 *
 * @throws {RangeError} tick が 0 以上の整数でない場合
 */
export function formatGameClock(tick: number): string {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`tick ${String(tick)} が 0 以上の整数でない`);
  }
  const day = Math.floor(tick / TICKS_PER_GAME_DAY) + 1;
  const minuteOfDay = tick - (day - 1) * TICKS_PER_GAME_DAY;
  const hour = Math.floor(minuteOfDay / TICKS_PER_GAME_HOUR);
  const minute = minuteOfDay - hour * TICKS_PER_GAME_HOUR;
  return `第${String(day)}日 ${pad2(hour)}:${pad2(minute)}`;
}

/**
 * [束A] 資源在庫の桁整形(ヘッダの資源HUD)。
 *
 * **1e6 固定小数点からの換算はここでやらない**。引数は `derived.ts` が
 * `toApproxNumber`(engine の `fp.ts`)で人間可読値へ直した `stockApprox` で
 * あり、ここが持つのは「チップに入る桁数へ丸める」表示上の都合だけである。
 * 小数第 1 位まで(整数なら小数点を出さない)。
 *
 * @throws {RangeError} 有限数でない場合
 */
export function formatResourceAmount(approx: number): string {
  if (!Number.isFinite(approx)) {
    throw new RangeError(`資源量 ${String(approx)} が有限数でない`);
  }
  const rounded = Math.round(approx * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 経過 tick を「○日○時間」形式にする(⑫帰還ダイジェストの不在時間)。
 * 1 時間未満は「○分」。
 *
 * @throws {RangeError} ticks が 0 以上の整数でない場合
 */
export function formatTickSpan(ticks: number): string {
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new RangeError(`ticks ${String(ticks)} が 0 以上の整数でない`);
  }
  const days = Math.floor(ticks / TICKS_PER_GAME_DAY);
  const hours = Math.floor((ticks - days * TICKS_PER_GAME_DAY) / TICKS_PER_GAME_HOUR);
  const minutes = ticks - days * TICKS_PER_GAME_DAY - hours * TICKS_PER_GAME_HOUR;
  if (days > 0) return `${String(days)}日${String(hours)}時間`;
  if (hours > 0) return `${String(hours)}時間${String(minutes)}分`;
  return `${String(minutes)}分`;
}
