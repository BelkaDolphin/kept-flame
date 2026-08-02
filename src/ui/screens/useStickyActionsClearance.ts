// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- sticky確定バーの重なり解消(M61/FC3・R1-C03/C04・
// M62/FC3・R2-E01/R2-A03 で補正式を絶対値ベースへ改訂)
//
// ===========================================================================
// 1. なぜ CSS だけでは足りないか(実機検証で判明した追加知見)
// ===========================================================================
//   `.kf-sticky-actions`(`position:sticky; bottom: var(--kf-nav-height)`)は、
//   その画面の内容が**ビューポートより低い**場合は `display:flex;
//   flex-direction:column; min-height:100%` + `margin-top:auto`
//   (画面コンポーネント側の CSS)だけで重なりが解消する(短い内容の画面)。
//
//   しかし内容が**ビューポートより高い**場合(候補/選択肢が多い⑦探索本部・
//   ⑩大移動)は別の仕組みが働く。position:sticky は「スクロール可能な祖先の
//   スクロールポート」を基準に固定されるため、**まだ 1px もスクロールして
//   いない初期表示(scrollY=0)でも**、内容がビューポートより高いだけで
//   ボタンは `bottom` オフセットの位置へ張り付く(CSS 仕様どおりの正しい挙動
//   — 「押しっぱなしで確定操作へ届く」という sticky を選んだ本来の目的と
//   表裏一体)。この固定 Y 座標は内容の総量に依存しないため、直前のコンテンツ
//   (ROI パネル/積み込みプレビュー)の描画位置がたまたまその帯に重なると、
//   CSS の margin/padding をどこに足しても(要素自身の margin-bottom は自分の
//   位置を動かさない・後ろに足しても前の要素は動かない)解消できない。
//
//   よって「直前コンテンツの実際の描画矩形」と「sticky バーの実際の描画矩形」
//   を **実測**し、重なっていれば直前コンテンツの `margin-top` を補正する、
//   という仕組みが要る(axisCE の fixSuggestions が「ResizeObserver 等で実測」
//   と明記していた理由)。**[M62/FC3改訂]** 「重なり分だけ増やす」という当初の
//   式は、直前コンテンツが sticky 帯を完全に内包するケース(候補が非常に
//   多く画面が長い場合)で収束しないと R2-E01/R2-A03 が実測した。
//   `clearanceMarginPx` の doc(下記)に理由と正しい式を記す。
//
// ===========================================================================
// 2. テスト方針
// ===========================================================================
//   このリポジトリの vitest は jsdom を持たず(ADR-001)、実 DOM の
//   `getBoundingClientRect`/`ResizeObserver` は動かせない。よって**純粋な
//   計算部分**(`verticalOverlapPx`)だけを切り出してユニットテストし、DOM 測定
//   ↔ 補正の配線(`useStickyActionsClearance`)自体は ColonyClock/ResourceHud
//   等と同じく「hooks を持つため直接テスト不可・Playwright 実機検証で確認」
//   という既存の切り分けに従う。
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "preact/hooks";

export interface VerticalRect {
  readonly top: number;
  readonly bottom: number;
}

/** 2つの垂直範囲の重なり(px)。重ならなければ 0。純関数・直接テスト可能。 */
export function verticalOverlapPx(a: VerticalRect, b: VerticalRect): number {
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** 余裕として上乗せする px(浮動小数の丸め誤差で 0.数px 残るのを防ぐ)。 */
const CLEARANCE_SAFETY_MARGIN_PX = 4;

/**
 * [M62/FC3・R2-E01] 重なりが有る場合に `contentRect` へ足す `margin-top` の値。
 *
 * ===========================================================================
 * なぜ「重なり分を足す」旧式(`overlapPx + 4`)では収束しないケースがあるか
 * ===========================================================================
 *   `.kf-sticky-actions` は `position:sticky` で、内容がビューポートより高い
 *   (= オーバーフローする)とき、**ビューポート相対に固定された** 1 つの矩形
 *   [top, bottom] として描画される——`contentRect`(直前要素)に `margin-top`
 *   を足しても、その矩形は 1px も動かない(margin を足すたびに測り直しても
 *   不変)。これが「収束しない」の実体である。
 *
 *   `contentRect` 側は margin ぶんだけ丸ごと下へ平行移動する
 *   (`[top+margin, bottom+margin]`)。よって新しい重なりは
 *
 *     overlap(margin) = min(bottom+margin, stickyRect.bottom)
 *                      − max(top+margin, stickyRect.top)
 *
 *   直前コンテンツが sticky 帯を**完全に内包する**とき
 *   (`contentRect.top < stickyRect.top` かつ `contentRect.bottom > stickyRect.bottom`)、
 *   margin をどれだけ足しても contentRect は stickyRect を内包し続ける
 *   (margin は両側を同じだけ動かすだけで、内包関係そのものは変わらない)。
 *   内包している限り overlap(margin) = stickyRect の高さ**で不変**になる
 *   ——これが「overlapPx + 4」がこのケースで無効な理由(算出した margin を
 *   何度足しても実測の重なりが変わらない・scratchpad r2-axisCE の実測どおり)。
 *
 * ===========================================================================
 * 解:「重なり分を足す」ではなく「sticky 帯の下端まで絶対値で押し下げる」
 * ===========================================================================
 *   sticky はビューポート相対に固定されている(margin の影響を受けない)ので、
 *   重なりを 0 にする唯一の到達点は
 *
 *     contentRect.top + margin >= stickyRect.bottom
 *
 *   である(1 つの矩形である contentRect は sticky 帯の「途中に穴を開ける」
 *   ことができないため、内包を破るには contentRect 全体を sticky 帯の外側
 *   ——下端より下——へ出すしかない)。よって
 *
 *     margin = max(0, stickyRect.bottom − contentRect.top) + 余裕
 *
 *   この式は「部分的にしか重ならない」旧来のケースでも正しく解ける
 *   (旧式はそのケースでもわずかに重なりを悪化させていたことがテストで判明
 *   している——sticky が固定されている限り、margin を「重なり分」だけ足す
 *   というアプローチ自体が符号を取り違えていた)。
 */
export function clearanceMarginPx(contentRect: VerticalRect, stickyRect: VerticalRect): number {
  if (verticalOverlapPx(contentRect, stickyRect) <= 0) return 0;
  return Math.max(0, stickyRect.bottom - contentRect.top) + CLEARANCE_SAFETY_MARGIN_PX;
}

export interface StickyActionsClearanceRefs {
  /** 直前コンテンツ(ROI パネル/積み込みプレビュー等)を包む div へ付ける ref。 */
  readonly contentRef: { current: HTMLDivElement | null };
  /** `.kf-sticky-actions` の DOM ノードへ付ける ref。 */
  readonly stickyRef: { current: HTMLDivElement | null };
}

/**
 * `contentRef` の要素へ、`stickyRef`(sticky 確定バー)との実測重なりぶんの
 * `margin-top` を直接 DOM へ適用する(§1)。Preact の再描画を経由せず
 * `element.style` を直接書き換えるのは、①測定→補正の 1 往復を state 経由の
 * 再レンダーに乗せると「補正後の margin を含んだ状態」を次の測定基準にして
 * しまい際限なく増え続けかねない(measure→reset→measure の同期性が要る)ため、
 * ②この種のレイアウト補正は Preact の宣言的更新の対象にしない、という意図的な
 * 判断(★)。`recomputeDeps` が変わるたび(候補一覧の増減・確認ダイアログの
 * 開閉等)に測り直す(`useEffect` の依存配列とそのまま同じ形で渡す)。
 */
export function useStickyActionsClearance(
  recomputeDeps: readonly unknown[],
): StickyActionsClearanceRefs {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function recompute(): void {
      const content = contentRef.current;
      const sticky = stickyRef.current;
      if (content === null || sticky === null) return;
      // 自分がこれまでに足した補正を一旦戻してから測る(「重なりが無くなった
      // ので margin を減らす」方向にも追随させるため・増え続けるのを防ぐ)。
      content.style.marginTop = "";
      const contentRect = content.getBoundingClientRect();
      const stickyRect = sticky.getBoundingClientRect();
      const margin = clearanceMarginPx(contentRect, stickyRect);
      content.style.marginTop = margin > 0 ? `${String(margin)}px` : "";
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
    };
    // 依存は呼び出し側が渡す recomputeDeps だけに絞る(ref 自体は依存に入れない
    // ——ref の再代入は再描画を起こさないので依存配列に意味を持たない)。
  }, recomputeDeps);

  return { contentRef, stickyRef };
}
