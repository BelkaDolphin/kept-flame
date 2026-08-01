// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 画面コンポーネントの共通 props(M29)
//
// 12画面 + 設定は**同じ形の props**を受け取る。シェル(AppShell)は画面 ID から
// レジストリ(screens/registry.tsx)を引いて、この形で 1 個だけ描画する。
// 画面ごとに違う入力が要るようになったら、それは「画面ローカルの状態」であって
// シェルから渡すものではない(architecture.md §6 の規律)。
// ---------------------------------------------------------------------------

import type { TestplaySpeedController } from "../testplaySpeed";
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
  /**
   * [M59] テストプレイ加速モードの倍率コントローラ。`bootTick` と同じく
   * **セッション限りの UI 状態**(セーブに載らない・リロードで消える)。
   * 唯一の書き込み先は設定画面「テストプレイ支援」節だが、`bootTick` が
   * 全画面に配られているのと同じ理由(composition root が 1 個だけ作り、
   * シェル経由で配る形を画面 props の枠組みに揃える)でここへ置く。
   */
  readonly testplaySpeed: TestplaySpeedController;
}
