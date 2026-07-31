// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ストア(signal/computed)を Preact コンポーネントへ橋渡しする
// 最小の結線 — M18 が最初に確立する(Phase 7 の他画面が M29 以降ここを再利用する)。
//
// `src/ui/reactive.ts`(M8)の signal/computed は Preact を一切知らない自前実装
// であり、Preact 側にも `@preact/signals` は入っていない(ADR-001 依存最小・
// architecture.md §9-1 の裁定「自前実装を維持」)。よって「値が変わったら
// コンポーネントを再描画する」という最後の一歩は、どこかで一度だけ書く必要が
// あり、それがこのファイルである。
//
// 中身は薄い(hooks 2 個)。ロジックの大部分(fan-in の上界・遅延評価・3色伝播)
// は reactive.ts 側に既にあるので、ここでは「Preact の再描画をトリガーする」
// 以外のことをしない。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "preact/hooks";

import type { ReadonlySignal } from "../reactive";
import type { ScreenId } from "../screens";
import type { GameStore, MountScreenOptions, ScreenMount } from "../store";

/**
 * signal / computed の値を Preact の state へ写し、変化のたびに再描画する。
 *
 * `signal.subscribe` は購読作成時に 1 回実行される(reactive.ts の
 * {@link createEffect} の仕様)ため、初期値は `peek()`(依存追跡なし)で取り、
 * 実際の購読は `useEffect` 側(マウント後)で張る。これにより「render 中に
 * 依存を記録する」という Preact の評価順と衝突しない。
 */
export function useSignalValue<T>(signal: ReadonlySignal<T>): T {
  const [value, setValue] = useState<T>(() => signal.peek());
  useEffect(() => signal.subscribe(setValue), [signal]);
  return value;
}

/**
 * 画面のマウント/アンマウントを ADR-027(2)「非アクティブ画面は物理アンマウント
 * し購読を解除」の規約どおり Preact のライフサイクルへ結びつける。
 *
 * `mount` は初回描画時点では未確定(`useEffect` はマウント後にしか走らないため)
 * なので `null` を返しうる。呼び出し側は `mount === null` の間は
 * `store.derived.*.peek()` の初期値で描いておけばよい(1 フレーム後に
 * 購読が付いて追随する)。
 *
 * **[M29] `activate` は呼び出し側が明示すること(M18★5 への回答)。**
 * M18 の時点では既定(= `true`)のまま使っていたため「マウント = 現在地」に
 * なっており、現在地の権威がルータと画面の 2 箇所に割れていた。M29 以降、
 * 現在地を決めるのは `src/platform/router.ts` だけであり、それをストアへ写す
 * のは `src/ui/shellSession.ts` の 1 行だけである。よって**画面コンポーネントは
 * `{ activate: false }` でマウントする**(自分を現在地だと宣言しない)。
 *
 * シェルの外で単体利用する場合(bench/gridMount のような計測ページ)も、
 * ルータが居ない = 現在地の概念が無いので `false` でよい。
 */
export function useScreenMount(
  store: GameStore,
  screenId: ScreenId,
  options?: MountScreenOptions,
): ScreenMount | null {
  const [mount, setMount] = useState<ScreenMount | null>(null);
  useEffect(() => {
    const created = store.mountScreen(screenId, options);
    setMount(created);
    return () => {
      created.dispose();
    };
    // screenId の変化で張り直すことは想定していない
    // (1 コンポーネントは 1 画面に固定・architecture.md §6)。`options` は
    // マウント時にしか意味を持たない(activate は初回のみの挙動・store.ts 参照)
    // ので依存配列には意図的に含めない。
  }, [store, screenId]);
  return mount;
}
