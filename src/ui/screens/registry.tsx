// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面レジストリ(M29)— GDD 6.6 / ADR-027
//
// 「画面 ID → 実際に描くコンポーネント」の対応表。**12画面 + 設定の全件を
// 型で強制**({@link ScreenId} を鍵にしたマップ型)しているので、`screens.ts` に
// 画面を足したらここが型エラーになる = 登録漏れが起きない。
//
// M29 の時点で中身があるのは①ホームハブと⑫帰還ダイジェストだけだった。
// **[M30]** ②格子ビュー/③施設詳細・増築/④住民一覧・配置を実装済みに追加。
// **[M31]** ⑤研究ツリー/⑥成文化キューを実装済みに追加(2 行の置き換えのみ・
// M32 並行作業のため他画面の行/import 順は変更していない)。
// 残り(⑦〜⑪・設定)は {@link PlaceholderScreen}(画面名 + 「未実装(Mxx)」)
// である。**ルート自体は 12画面ぶん登録する**(タスク指示)ので、①のバッジ
// からのワンタップ遷移も、URL 直打ちも、いま全部通る。
// ---------------------------------------------------------------------------

import type { VNode } from "preact";

import { SCREEN_IDS, type ScreenId } from "../screens";
import { CodifyScreen } from "./codify/CodifyScreen";
import { FacilityScreen } from "./facility/FacilityScreen";
import { GridScreen } from "./grid/GridScreen";
import { HomeHub } from "./home/HomeHub";
import { PlaceholderScreen } from "./PlaceholderScreen";
import { ResearchScreen } from "./research/ResearchScreen";
import { ResidentsScreen } from "./residents/ResidentsScreen";
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
  grid: { id: "grid", ownerTask: null, render: (props) => <GridScreen {...props} /> },
  facility: { id: "facility", ownerTask: null, render: (props) => <FacilityScreen {...props} /> },
  residents: {
    id: "residents",
    ownerTask: null,
    render: (props) => <ResidentsScreen {...props} />,
  },
  research: { id: "research", ownerTask: null, render: (props) => <ResearchScreen {...props} /> },
  codify: { id: "codify", ownerTask: null, render: (props) => <CodifyScreen {...props} /> },
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
