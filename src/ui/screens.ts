// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面 ID の語彙 — GDD 6.6 / ADR-027
//
// **このファイルは import を持たない**(語彙だけの葉モジュール)。ストア側
// (store.ts)と根 signal(sources.ts)の双方から参照されるため、依存を持つと
// 循環になる。画面の実体(Preact コンポーネント)は Phase 7(M29〜M33)で
// `src/ui/screens/` 配下に作る。
//
// ===========================================================================
// 1. 12画面 +(セーブ/設定)
// ===========================================================================
//   GDD 6.6 の表は①〜⑫の 12 画面 + 「＋ セーブ/設定」であり、**合計 13 の
//   マウント単位**になる。「12画面」という呼び方は①〜⑫を指す(`SCREEN_ORDER`
//   の 1〜12 がそれ)。設定は番号を持たない(`order` が null)。
//
// ===========================================================================
// 2. ルーティングとの関係(ADR-027)
// ===========================================================================
//   URL ハッシュの権威は `src/platform/router.ts`(M29 で実装・自前ハッシュ
//   ルータ)である。ストアが持つ `activeScreen` は**ルータが決めた現在地の
//   写し**であり、ストア側から URL を書き換えることはしない。
//   ここに置くのは「どの画面が存在するか」の語彙と表示名だけ。
// ---------------------------------------------------------------------------

/**
 * 画面 ID(GDD 6.6)。値は URL ハッシュにもそのまま使える英字 ID にしてある
 * (ルータの実装は M29)。
 */
export const SCREEN_IDS = [
  "home", // ① ホームハブ
  "grid", // ② 格子ビュー
  "facility", // ③ 施設詳細/増築
  "residents", // ④ 住民一覧・配置
  "research", // ⑤ 研究ツリー
  "codify", // ⑥ 成文化キュー
  "expedition", // ⑦ 探索本部
  "chronicle", // ⑧ 冒険記
  "outposts", // ⑨ 衛星拠点管理
  "migration", // ⑩ 大移動
  "inheritance", // ⑪ 継承点購入
  "digest", // ⑫ 帰還ダイジェスト(復帰専用)
  "settings", // ＋ セーブ/設定(番号なし)
] as const;

export type ScreenId = (typeof SCREEN_IDS)[number];

/** 復帰時に最初に出るのは⑫(GDD 6.6 / §4.2)だが、既定の現在地は①。 */
export const DEFAULT_SCREEN_ID: ScreenId = "home";

/** 復帰専用画面(オフライン差分がある起動でルータが最初に出す・GDD 6.6)。 */
export const RETURN_DIGEST_SCREEN_ID: ScreenId = "digest";

export interface ScreenMeta {
  readonly id: ScreenId;
  /** GDD 6.6 の丸数字。設定画面は番号を持たない。 */
  readonly order: number | null;
  /**
   * プレイヤー向け表示名。原則 GDD 6.6 の表記のままだが、[M61/FC5]
   * chronicle("冒険記ビューア"→"冒険記")/migration("大移動ナップサックUI"→
   * "大移動")の2件は R1-A18(内部設計名の露出)への対応でプレイヤー向けに
   * 短縮した——GDD 6.6 の表はスクリーンカタログとしての設計上の呼称であり、
   * "ビューア"/"ナップサックUI" はゲームUI実装の内部用語(GDD自体は変更しない・
   * 表示専用の言い換え)。各画面の見出し(h2)側もこの表記に揃えてある。
   */
  readonly label: string;
}

/** 画面 ID → メタ情報。反復順は {@link SCREEN_IDS} の宣言順(= GDD の表順)。 */
export const SCREEN_META: { readonly [K in ScreenId]: ScreenMeta } = {
  home: { id: "home", order: 1, label: "ホームハブ" },
  grid: { id: "grid", order: 2, label: "格子ビュー" },
  facility: { id: "facility", order: 3, label: "施設詳細/増築" },
  residents: { id: "residents", order: 4, label: "住民一覧・配置" },
  research: { id: "research", order: 5, label: "研究ツリー" },
  codify: { id: "codify", order: 6, label: "成文化キュー" },
  expedition: { id: "expedition", order: 7, label: "探索本部" },
  chronicle: { id: "chronicle", order: 8, label: "冒険記" },
  outposts: { id: "outposts", order: 9, label: "衛星拠点管理" },
  migration: { id: "migration", order: 10, label: "大移動" },
  inheritance: { id: "inheritance", order: 11, label: "継承点購入" },
  digest: { id: "digest", order: 12, label: "帰還ダイジェスト" },
  settings: { id: "settings", order: null, label: "セーブ/設定" },
};

/** GDD 6.6 が「12画面」と数える①〜⑫の件数。 */
export const NUMBERED_SCREEN_COUNT = 12;

/** 未知の文字列が画面 ID かを判定する(ハッシュ文字列の検証に使う)。 */
export function isScreenId(value: string): value is ScreenId {
  for (const id of SCREEN_IDS) {
    if (id === value) return true;
  }
  return false;
}
