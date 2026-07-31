// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ナビゲーションのグループ語彙([束A] F-5)
//
// ===========================================================================
// 1. なぜグループが要るのか
// ===========================================================================
//   M29 のナビは 13 画面を全掲していたため、375×667 では 2 段に折り返して
//   100px 超(画面高の 15%)を常時占有し、しかも本文の一番下にあるので
//   「スクロールしないと移動できない」状態だった(UX プレイテスト F-5)。
//   13 個を 5 グループへ畳めば 1 段 44px で収まり、sticky 固定に耐える。
//
// ===========================================================================
// 2. このファイルが持つもの/持たないもの
// ===========================================================================
//   持つ: 「どの画面がどのグループに属するか」という**語彙だけ**。
//   持たない: 表示名(画面名は `screens.ts` の `SCREEN_META.label` が唯一の
//   出典であり、ここで別名を作らない)・意匠・状態。
//
//   グループ分けは GDD 6.6 の 12 画面 IA の意味的なまとまりに従う:
//     拠点 = 本拠の運営(①ホームハブ/②格子/③施設/④住民)
//     研究 = 知識(⑤研究ツリー/⑥成文化キュー)
//     探索 = 外(⑦探索本部/⑧冒険記/⑨衛星拠点)
//     周回 = 周回境界(⑩大移動/⑪継承点/⑫帰還ダイジェスト)
//     設定 = ＋セーブ/設定(単独)
//
//   **仕様書番号(「1.」「⑤」等)はラベルに出さない**(UX プレイテスト F-5:
//   プレイヤーにとって意味を持たない内部順序であり、幅も食う)。順序は
//   `SCREEN_META.order` ではなくこの配列の宣言順が正本になる。
// ---------------------------------------------------------------------------

import { SCREEN_IDS, type ScreenId } from "./screens";

export const NAV_GROUP_IDS = ["base", "knowledge", "expedition", "cycle", "system"] as const;

export type NavGroupId = (typeof NAV_GROUP_IDS)[number];

export interface NavGroup {
  readonly id: NavGroupId;
  /** バーに出す短いラベル(2 文字)。画面名ではないので screens.ts とは独立。 */
  readonly label: string;
  /** このグループに属する画面(表示順)。全グループの和は SCREEN_IDS と一致する。 */
  readonly screens: readonly ScreenId[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "base", label: "拠点", screens: ["home", "grid", "facility", "residents"] },
  { id: "knowledge", label: "研究", screens: ["research", "codify"] },
  { id: "expedition", label: "探索", screens: ["expedition", "chronicle", "outposts"] },
  { id: "cycle", label: "周回", screens: ["migration", "inheritance", "digest"] },
  { id: "system", label: "設定", screens: ["settings"] },
];

/**
 * 画面 → 所属グループ。
 *
 * **見つからない場合は例外**にする(黙って先頭グループへ倒すと「新しい画面を
 * 足したのにナビから行けない」が静かに成立してしまう)。網羅性そのものは
 * `tests/ui/screens/appShell.test.ts` が SCREEN_IDS との突合せで固定する。
 */
export function navGroupOfScreen(screen: ScreenId): NavGroup {
  for (const group of NAV_GROUPS) {
    for (const id of group.screens) {
      if (id === screen) return group;
    }
  }
  throw new Error(`画面 ${screen} がどのナビゲーショングループにも属していない`);
}

/** 全グループに現れる画面 ID(宣言順)。網羅性テストと開発時の自己点検に使う。 */
export function navGroupScreenIds(): readonly ScreenId[] {
  const result: ScreenId[] = [];
  for (const group of NAV_GROUPS) result.push(...group.screens);
  return result;
}

/** `SCREEN_IDS` の全件がちょうど 1 グループに属するか(重複・漏れの検出)。 */
export function navGroupsCoverAllScreens(): boolean {
  const listed = navGroupScreenIds();
  if (listed.length !== SCREEN_IDS.length) return false;
  const seen = new Set<ScreenId>(listed);
  if (seen.size !== listed.length) return false;
  for (const id of SCREEN_IDS) {
    if (!seen.has(id)) return false;
  }
  return true;
}
