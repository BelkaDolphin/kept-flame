// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- テストプレイ加速モードの UI 反応系ブリッジ — M59
//
// `platform/timeScale.ts` の {@link ScaledClock} は値を保持するだけの薄い層で、
// Preact への再描画通知(reactive.ts の signal)を持たない。ここではその上に
// `Signal` を 1 個だけ被せ、設定画面(書き込み)とヘッダのインジケータ/研究チップ
// (読み取り専用)が同じ値を見られるようにする。
//
// **書き込み口は {@link TestplaySpeedController.setSpeed} 1 本だけ**であり、
// 外へは `ReadonlySignal` だけを公開する(reactive.ts §「Signal をストアの外へ
// 渡さないこと」という規約と同じ姿勢。ここでの「ストア」は本コントローラ自身)。
//
// **セッション限りで永続化しない**(タスク指示どおり)。`src/main.tsx` が起動の
// たびに 1 個だけ新しく作るので、リロードすれば必ず ×1 に戻る。localStorage 等
// への書き込みはこのファイルに 1 行も無い。
// ---------------------------------------------------------------------------

import type { ScaledClock } from "../platform/timeScale";
import { Signal, type ReadonlySignal } from "./reactive";

/** 設定画面が選べる速度の全件(既定 ×1 を含む)。 */
export const TESTPLAY_SPEEDS = [1, 60, 720] as const;
export type TestplaySpeed = (typeof TESTPLAY_SPEEDS)[number];

export interface TestplaySpeedController {
  /** 現在の倍率(読み取り専用)。ヘッダのインジケータと設定画面が購読する。 */
  readonly speed: ReadonlySignal<number>;
  /** 倍率を変える(`ScaledClock.setSpeed` を呼んでから signal を更新)。 */
  setSpeed(next: TestplaySpeed): void;
}

/**
 * `clock` を包むコントローラを作る。`clock.speed()` の初期値をそのまま
 * signal の初期値にする(既定 ×1・`createScaledClock` の初期状態と一致)。
 */
export function createTestplaySpeedController(clock: ScaledClock): TestplaySpeedController {
  const speedSignal = new Signal<number>(clock.speed(), { name: "testplaySpeed" });
  return {
    speed: speedSignal,
    setSpeed(next: TestplaySpeed): void {
      clock.setSpeed(next); // 不正値はここで例外(TimeScaleError)。signal は動かさない。
      speedSignal.set(next);
    },
  };
}
