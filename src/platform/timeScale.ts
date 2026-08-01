// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- テストプレイ加速モードの倍速クロック — ロードマップ M59
// ([2026-08-02ユーザー要望] docs/design/ui-spec.md 参照)
//
// ===========================================================================
// 1. 何を保証するか(§「speed 変更で tick が飛ばない・巻き戻らない」)
// ===========================================================================
//   `clock.ts` の {@link MonotonicClock} をラップし、`now()` の戻り値を
//   `speed` 倍で加速する。式は 1 本だけ:
//
//     scaledNow = scaledAnchorMs + (base.now() - baseAnchorMs) * speed
//
//   {@link ScaledClock.setSpeed} は**両アンカーを呼び出し時点の値へ引き直す**
//   ことで連続性を保つ: 引き直しの瞬間の `scaledNow`(旧 speed で計算した値)を
//   そのまま新しい `scaledAnchorMs` にし、`baseAnchorMs` を引き直しの瞬間の
//   `base.now()` にする。よって「引き直しの直前に読んだ scaledNow」と
//   「引き直しの直後に読む scaledNow」は完全に一致し(不連続なジャンプが無い)、
//   以後は新しい speed で単調に増え続ける(base 自体が単調である限り)。
//
//   これは `planTick`(clock.ts §1/§2)が満たす等式とちょうど同じ形の保証で
//   あり、`createTickDriver` は「注入された {@link MonotonicClock} の `now()`
//   が何であるか」を一切知らないので、このラッパを `clock` オプションへ渡す
//   だけで tick 駆動が加速される(engine は tick 番号しか見ないため決定論に
//   影響しない・タスク指示どおり)。
//
// ===========================================================================
// 2. 何に使ってはいけないか
// ===========================================================================
//   セーブの `saveScheduler`(`systemSaveClock`)・定期バックアップ推奨
//   (`backupReminder` の壁時計)・PWA 誘導(`installPromotion`/
//   `notificationCapability` の壁時計)・起動時オフライン復帰の経過計算
//   (`src/main.tsx` の `bootPlan`)は、いずれもこのモジュールを import しない
//   (`src/main.tsx` は `clock: scaledClock` を `createTickDriver` **にだけ**
//   渡す)。これらは実時間そのものを扱う責務であり、ゲーム内 tick の進み方を
//   速める本機能とは無関係でなければならない。
// ---------------------------------------------------------------------------

import type { MonotonicClock } from "./clock";

/** 倍速クロックの使い方の誤り(非正・非有限の speed)。 */
export class TimeScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeScaleError";
  }
}

/** {@link MonotonicClock} に速度の読み書きを足したもの。 */
export interface ScaledClock extends MonotonicClock {
  /** 現在の倍率(既定 1)。 */
  speed(): number;
  /**
   * 倍率を変える。**両アンカーを現在値へ引き直す**ので、直前直後で `now()` は
   * 連続(不連続ジャンプ無し・巻き戻り無し・§1)。
   *
   * @throws {TimeScaleError} `next` が正の有限数でない場合
   */
  setSpeed(next: number): void;
}

function requirePositiveFiniteSpeed(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TimeScaleError(`speed ${String(value)} は正の有限数でなければならない`);
  }
}

/**
 * `base` を包む倍速クロックを作る(既定 speed = 1 = 素通し)。
 *
 * `base` 自身には一切書き込まない(`base.now()` を読むだけ)ので、既存の
 * {@link MonotonicClock} 実装(`performanceClock` / テスト用の偽物時計)を
 * そのまま渡せる。
 */
export function createScaledClock(base: MonotonicClock): ScaledClock {
  let speedValue = 1;
  let baseAnchorMs = base.now();
  let scaledAnchorMs = baseAnchorMs;

  function now(): number {
    return scaledAnchorMs + (base.now() - baseAnchorMs) * speedValue;
  }

  return {
    now,
    speed: () => speedValue,
    setSpeed(next: number): void {
      requirePositiveFiniteSpeed(next);
      // 引き直しの瞬間を 1 回の base.now() 読み出しに固定する(§1 の連続性の根拠。
      // 2 回読むと読み出し間の実経過ぶんだけ僅かな不整合が起きうる)。
      const nowBaseMs = base.now();
      const currentScaledMs = scaledAnchorMs + (nowBaseMs - baseAnchorMs) * speedValue;
      baseAnchorMs = nowBaseMs;
      scaledAnchorMs = currentScaledMs;
      speedValue = next;
    },
  };
}
