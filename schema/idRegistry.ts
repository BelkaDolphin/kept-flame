// ---------------------------------------------------------------------------
// グローバル ID 一意性検証器 — ADR-024(1)
//
// tech/facility/trait(将来 recipe/event/raid/outpost/era 追加時も同様)横断で
// content ID のグローバル一意性を強制する。T4 の entityStateById が単一
// namespace であること(state.ts §1)の裏付けとして、schema 検証段階で
// カテゴリ間衝突(シャドーイング)を reject する。
//
// 先行計測計画 T6「検証器は計測可能な形(関数として分離)に」の要求に応じ、
// 他の検証と独立に呼び出せる純関数として分離してある(引数はカテゴリ別 ID
// 配列、副作用なし)。contentBundle.ts から呼ぶほか、T16 の計測ハーネスが
// この関数単体の実行コストを計測できる。
// ---------------------------------------------------------------------------

import type { ValidationIssue } from "./common";

/** カテゴリ名 → そのカテゴリが持つ ID の配列。 */
export type IdsByCategory = Readonly<Record<string, readonly string[]>>;

/**
 * 全カテゴリを横断して ID の重複を検出する。同一カテゴリ内の重複も
 * (additive diff をすり抜けた場合の保険として)対象に含む。
 *
 * カテゴリの走査順は ID の宣言順に依存しない結果を作るため、カテゴリ名を
 * 一度ソートしてから処理する(先に見つかった方を「正」とする以外の順序
 * 依存を作らない)。
 */
export function checkGlobalIdUniqueness(idsByCategory: IdsByCategory): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstSeenIn = new Map<string, string>();

  const categories = [...Object.keys(idsByCategory)].sort();
  for (const category of categories) {
    const ids = idsByCategory[category] ?? [];
    for (const id of ids) {
      const owner = firstSeenIn.get(id);
      if (owner !== undefined) {
        issues.push({
          path: `${category}.${id}`,
          message: `id "${id}" は既に category "${owner}" で使用済み(ADR-024(1): 全カテゴリ横断でグローバル一意)`,
        });
      } else {
        firstSeenIn.set(id, category);
      }
    }
  }
  return issues;
}
