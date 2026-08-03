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
 * [M61/FC11] 整数部へ3桁区切りのカンマを入れる(符号维持)。
 *
 * `toLocaleString` は実行環境のロケールに依存する(CLAUDE.md
 * 「ロケール依存の書式化は使わない」の精神をゲーム内時計だけでなく数値表示にも
 * 適用する・書式が実行環境で変わるとスクリーンショット由来の不具合報告が読め
 * なくなる)ため、桁区切りは自前の文字列処理で行う。小数部・符号はここでは
 * 触らない(呼び出し側が既に分離した整数部の文字列を渡す)。
 */
function withThousandsSeparator(integerPart: string): string {
  const negative = integerPart.startsWith("-");
  const digits = negative ? integerPart.slice(1) : integerPart;
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return (negative ? "-" : "") + groups.join(",");
}

/**
 * [束A][M61/FC11で3桁区切り追加] 資源在庫の桁整形(ヘッダの資源HUD等)。
 *
 * **1e6 固定小数点からの換算はここでやらない**。引数は `derived.ts` が
 * `toApproxNumber`(engine の `fp.ts`)で人間可読値へ直した `stockApprox` で
 * あり、ここが持つのは「チップに入る桁数へ丸める」表示上の都合だけである。
 * 小数第 1 位まで(整数なら小数点を出さない)+ 整数部は3桁区切り(プレイテスト
 * R1-A22「戦力59.5125」「firewood 1,620,004.7 に桁区切りなし」への対応)。
 *
 * @throws {RangeError} 有限数でない場合
 */
export function formatResourceAmount(approx: number): string {
  if (!Number.isFinite(approx)) {
    throw new RangeError(`資源量 ${String(approx)} が有限数でない`);
  }
  const rounded = Math.round(approx * 10) / 10;
  const [integerPart, decimalPart] = rounded.toFixed(1).split(".");
  const groupedInteger = withThousandsSeparator(integerPart ?? "0");
  return decimalPart === "0" ? groupedInteger : `${groupedInteger}.${decimalPart ?? "0"}`;
}

/**
 * [2026-08-02 実プレイ報告] 資源「在庫」専用の整数整形(切り捨て+3桁区切り)。
 *
 * 内部経済は 1e6 固定小数点で、産出レートが非整数(lvCurve 9.2/分 等)のため
 * 在庫は本当に端数を持つ。しかし在庫表示の端数はプレイヤーには意味のない
 * ノイズである(×720 実プレイでの報告「資材数は整数だと思うが小数点が出る」)
 * ため、在庫系の表示(HUD チップ・トーストの増減句)だけ整数へ切り捨てる。
 *
 * **切り捨て(floor)であって四捨五入ではない** —— 「足りて見えるのに払えない」
 * 偽りを作らないため、所持量は決して多く見せない。逆にコスト・レート表示は
 * 実際に請求/産出される端数をそのまま出す(`formatResourceAmount`)——
 * 「43 払ったのに 43.2 減る」不信を作らないため。端数の根本解消(コスト曲線の
 * 整数化等)は M39 バランス調整の領分。
 *
 * @throws {RangeError} 有限数でない場合
 */
export function formatResourceStock(approx: number): string {
  if (!Number.isFinite(approx)) {
    throw new RangeError(`資源量 ${String(approx)} が有限数でない`);
  }
  return withThousandsSeparator(Math.floor(approx).toFixed(0));
}

/**
 * [M61/FC11] 小数第 1 位までの汎用整形(戦力・士気など資源以外の近似値)。
 * `formatResourceAmount` と違い3桁区切りは付けない(戦力・士気は3桁を超えない
 * 値域のため過剰装飾になる)。常に小数第1位まで出す(整数でも ".0" を出す —
 * 「近似値である」ことを一貫して示すため。桁の丸め自体は `toApproxNumber` 側)。
 *
 * @throws {RangeError} 有限数でない場合
 */
export function formatApproxDecimal1(approx: number): string {
  if (!Number.isFinite(approx)) {
    throw new RangeError(`数値 ${String(approx)} が有限数でない`);
  }
  return approx.toFixed(1);
}

/**
 * [M63/R4-A02] 1 未満のレートに要る小数桁数(有効数字方式)。
 *
 * 資材施設 7 種の産出は 1/3000 再校正後 0.004〜0.035/分のように 1 未満に
 * 収まり、`formatResourceAmount` の小数第 1 位丸め(0.0)へ全て埋もれて
 * 「0/分」の虚偽表示になっていた(R4-A02)。「<0.1/分」の固定文言も検討したが、
 * hearth 等は Lv1〜5 の全レートが 0.1 未満に収まる曲線(GDD の 1.15^n カーブ)
 * があり、それだと増築の全 Lv が同じ文言になって「増築画面で Lv 間のレート差が
 * 判別できる」という検収条件(playtest-protocol.md 台本T7)を満たせない。
 * そこで値が小さいほど小数桁を増やす有効数字方式を採る(理由の詳細は
 * `formatRatePerMinute` の doc)。
 *
 * 最低 2 桁の有効数字を確保する(0.035→3桁/0.004→4桁、のように先頭の 0 の
 * 個数ぶん桁を足す)。上限は 6(1e6 固定小数点の精度上限=小数第6位より細かい
 * 桁を出しても意味が無いため)。
 */
function decimalPlacesForSmallRate(absApprox: number): number {
  if (absApprox <= 0) return 1;
  // 1e6 固定小数点より小さい値は表現上存在しないはずだが、防御的に丸める。
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(absApprox)) - 1);
  return Math.min(6, leadingZeros + 2);
}

/**
 * [M62/FC4] tick 単位のレート表記(産出/供給/維持費等)を「/分」へ変換する
 * 表示ヘルパ。1 tick = 1 分(GDD 11.1)なので数値の再計算は不要——単位表記の
 * 日本語化だけを行う。
 *
 * 絶対値が 1 以上(または 0)は `formatResourceAmount` へ委譲する(独自の
 * `toFixed(2)` を持たない)——プレイテスト R2-FC9 が指摘した「薪だけ小数第1位が
 * 付いて他のレート表示と体裁が揃わない」不統一は、レート表示(旧: 素の
 * `toFixed(2)`)と資源在庫表示(HUD 等・`formatResourceAmount`)とで整形ヘルパが
 * 分かれていたことが原因だった。ここで一本化することで、桁区切り・小数の
 * 出し分けルールが資源在庫と常に一致する(FacilityScreen.tsx/OutpostsScreen.tsx
 * の /tick 表記 7 箇所を本ヘルパ経由へ置換)。
 *
 * **[M63/R4-A02] 絶対値が 1 未満は小数桁を可変にする**(`decimalPlacesForSmallRate`)。
 * `formatResourceAmount` の固定 1 桁のままだと 0.004〜0.035/分 が軒並み
 * 「0.0」→「0/分」に丸まり、稼働中でも「何も生産していない」ように見える
 * 虚偽表示になっていた(R4-A02)。3 桁区切りは付けない(1 未満の値に桁区切りは
 * 意味を持たないため)。
 *
 * @throws {RangeError} 有限数でない場合
 */
export function formatRatePerMinute(approx: number): string {
  if (!Number.isFinite(approx)) {
    throw new RangeError(`資源量 ${String(approx)} が有限数でない`);
  }
  const abs = Math.abs(approx);
  if (abs === 0 || abs >= 1) {
    return `${formatResourceAmount(approx)}/分`;
  }
  return `${approx.toFixed(decimalPlacesForSmallRate(abs))}/分`;
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
