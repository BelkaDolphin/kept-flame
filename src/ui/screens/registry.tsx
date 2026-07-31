// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面レジストリ(M29)— GDD 6.6 / ADR-027
//
// 「画面 ID → 実際に描くコンポーネント」の対応表。**12画面 + 設定の全件を
// 型で強制**({@link ScreenId} を鍵にしたマップ型)しているので、`screens.ts` に
// 画面を足したらここが型エラーになる = 登録漏れが起きない。
//
// M29 の時点で中身があるのは①ホームハブと⑫帰還ダイジェストだけだった。
// **[M30]** ②格子ビュー/③施設詳細・増築/④住民一覧・配置を実装済みに追加。
// **[M31]** ⑤研究ツリー/⑥成文化キューを実装済みに追加。
// **[M32]** ⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理を実装済みに追加。
// **[M33]** ⑩大移動ナップサックUI/⑪継承点購入/＋セーブ・設定を実装済みに追加。
// これで 12画面 + 設定の全件が {@link PlaceholderScreen} を経由しなくなった。
// ---------------------------------------------------------------------------

import type { VNode } from "preact";

import { SCREEN_IDS, type ScreenId } from "../screens";
import { ChronicleScreen } from "./chronicle/ChronicleScreen";
import { CodifyScreen } from "./codify/CodifyScreen";
import { ExpeditionScreen } from "./expedition/ExpeditionScreen";
import { FacilityScreen } from "./facility/FacilityScreen";
import { GridScreen } from "./grid/GridScreen";
import { HomeHub } from "./home/HomeHub";
import { InheritanceScreen } from "./inheritance/InheritanceScreen";
import { MigrationScreen } from "./migration/MigrationScreen";
import { OutpostsScreen } from "./outposts/OutpostsScreen";
import { ResearchScreen } from "./research/ResearchScreen";
import { ResidentsScreen } from "./residents/ResidentsScreen";
import { ReturnDigest } from "./digest/ReturnDigest";
import { SettingsScreen } from "./settings/SettingsScreen";
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
  expedition: {
    id: "expedition",
    ownerTask: null,
    render: (props) => <ExpeditionScreen {...props} />,
  },
  chronicle: {
    id: "chronicle",
    ownerTask: null,
    render: (props) => <ChronicleScreen {...props} />,
  },
  outposts: {
    id: "outposts",
    ownerTask: null,
    render: (props) => <OutpostsScreen {...props} />,
  },
  migration: {
    id: "migration",
    ownerTask: null,
    render: (props) => <MigrationScreen {...props} />,
  },
  inheritance: {
    id: "inheritance",
    ownerTask: null,
    render: (props) => <InheritanceScreen {...props} />,
  },
  digest: { id: "digest", ownerTask: null, render: (props) => <ReturnDigest {...props} /> },
  settings: { id: "settings", ownerTask: null, render: (props) => <SettingsScreen {...props} /> },
};

/** 反復用(宣言順 = GDD 6.6 の表順)。 */
export const SCREEN_ENTRIES: readonly ScreenEntry[] = SCREEN_IDS.map((id) => SCREEN_REGISTRY[id]);
