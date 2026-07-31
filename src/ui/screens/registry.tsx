// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面レジストリ(M29)— GDD 6.6 / ADR-027
//
// 「画面 ID → 実際に描くコンポーネント」の対応表。**12画面 + 設定の全件を
// 型で強制**({@link ScreenId} を鍵にしたマップ型)しているので、`screens.ts` に
// 画面を足したらここが型エラーになる = 登録漏れが起きない。
//
// M29 の時点で中身があるのは①ホームハブと⑫帰還ダイジェストだけで、残りは
// {@link PlaceholderScreen}(画面名 + 「未実装(Mxx)」)である。**ルート自体は
// 12画面ぶん登録する**(タスク指示)ので、①のバッジからのワンタップ遷移も、
// URL 直打ちも、いま全部通る。
// ---------------------------------------------------------------------------

import type { VNode } from "preact";

import { SCREEN_IDS, type ScreenId } from "../screens";
import { HomeHub } from "./home/HomeHub";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { ReturnDigest } from "./digest/ReturnDigest";
import type { ScreenProps } from "./screenProps";

export interface ScreenEntry {
  readonly id: ScreenId;
  /**
   * 実装担当のロードマップタスク(`null` = M29 で実装済み)。
   * プレースホルダの表示文言に出るので、ロードマップと食い違わせないこと。
   */
  readonly ownerTask: string | null;
  readonly render: (props: ScreenProps) => VNode;
}

function placeholder(id: ScreenId, ownerTask: string): ScreenEntry {
  return {
    id,
    ownerTask,
    render: (props) => <PlaceholderScreen {...props} screenId={id} ownerTask={ownerTask} />,
  };
}

/** 画面 ID → 実装。**全件必須**(欠けると型エラー)。 */
export const SCREEN_REGISTRY: { readonly [K in ScreenId]: ScreenEntry } = {
  home: { id: "home", ownerTask: null, render: (props) => <HomeHub {...props} /> },
  grid: placeholder("grid", "M30"),
  facility: placeholder("facility", "M30"),
  residents: placeholder("residents", "M30"),
  research: placeholder("research", "M31"),
  codify: placeholder("codify", "M31"),
  expedition: placeholder("expedition", "M32"),
  chronicle: placeholder("chronicle", "M32"),
  outposts: placeholder("outposts", "M32"),
  migration: placeholder("migration", "M33"),
  inheritance: placeholder("inheritance", "M33"),
  digest: { id: "digest", ownerTask: null, render: (props) => <ReturnDigest {...props} /> },
  settings: placeholder("settings", "M33"),
};

/** 反復用(宣言順 = GDD 6.6 の表順)。 */
export const SCREEN_ENTRIES: readonly ScreenEntry[] = SCREEN_IDS.map((id) => SCREEN_REGISTRY[id]);
