// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面コンポーネントの共通 props(M29)
//
// 12画面 + 設定は**同じ形の props**を受け取る。シェル(AppShell)は画面 ID から
// レジストリ(screens/registry.tsx)を引いて、この形で 1 個だけ描画する。
// 画面ごとに違う入力が要るようになったら、それは「画面ローカルの状態」であって
// シェルから渡すものではない(architecture.md §6 の規律)。
// ---------------------------------------------------------------------------

import type { ScreenId } from "../screens";
import type { GameStore } from "../store";

export interface ScreenProps {
  /** アプリ 1 起動につき 1 個のストア。**画面遷移で作り直さない**。 */
  readonly store: GameStore;
  /** ワンタップ遷移(GDD 6.6)。実体はルータの `navigate`。 */
  readonly onNavigate: (screen: ScreenId) => void;
  /**
   * 起動直後(catch-up 前)の tick。⑫帰還ダイジェストが「不在中」の起点として
   * 使う(`docs/design/ui-spec.md` §4)。**セーブに載らない UI 状態**。
   */
  readonly bootTick: number;
}
