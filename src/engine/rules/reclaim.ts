// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 瓦礫の開墾 — M52 / GDD 9.1(本拠格子拡張)/ GDD 6.1 / GDD 11.1
//
// GDD 9.1 は「初期は 48 セル中一部のみ利用可、残りは瓦礫」「開墾コストは
// `base × 1.15^解放数` + 最終セルでも到達可能な明示上限 cap」と定める。
// このモジュールはその**コスト式と state 遷移だけ**を持ち、「置けるか」の判定や
// reject の語彙は持たない(そちらは commands.ts §4 の担当)。
//
// ===========================================================================
// 1. 瓦礫は state 権威(content は「コスト」と「初期配置」しか持たない)
// ===========================================================================
//   どのセルが瓦礫かは `GameState.terrain.rubbleCells` が権威であり、content の
//   `balance.reclaim.initialRubbleCells` は**新規ゲームの生成パラメータ**として
//   {@link initialTerrain} からのみ読まれる。M16 が footprint について確立した
//   規律(content は配置時にだけ読み、既存盤面を遡って書き換えない・footprint.ts
//   §1)と同じ形である。content 側の初期配置を後から動かしても、既に開墾された
//   盤面が瓦礫に戻ることは無い。
//
//   帰結として、**`reclaim` ブロックを持たない content でも瓦礫の判定は効く**
//   (瓦礫セルへの配置は拒否される)。効かなくなるのは「開墾」だけであり、
//   これは `commands.ts` が `contentUnsupported` で拒否する。
//
// ===========================================================================
// 2. `base × 1.15^解放数` を engine 側の式で持つ(pow 禁止下での実装)
// ===========================================================================
//   Math.pow は implementation-approximated でエンジン間 bit 不一致になるため
//   engine では禁止(ADR-006 / fp.ts §5)。よって冪は
//   **`mulFix` の反復**(1e6 固定小数点・各段 floor)で作る:
//
//       cost(0) = base
//       cost(n) = min(cap, floor(cost(n-1) × growth / 1e6))
//
//   各段で cap を掛けるのと「最後にまとめて min(cap, ...)」が同値であることの
//   証明: growth >= 1.0 かつ cost >= 0 なら
//   `floor(cost × growth / 1e6) >= floor(cost × 1e6 / 1e6) = cost` なので
//   数列は単調非減少である。単調列に対する「途中で上限へ張り付いたら以降も
//   上限」は自明に成り立つ。よって cap に達した時点で打ち切ってよく、
//   打ち切りによって**中間積が cap を大きく超えることが無い**
//   (= 解放数が増えても FixRangeError が出ない)。
//
//   反復回数は解放数(現行盤面では高々 48・外周拡張後でも 80)であり、開墾コマンド
//   1 回につき 1 度しか呼ばれない = tick ループには乗らない。
//
// ===========================================================================
// 3. GDD の「エラ内リセット」との関係(実装は**リセットしない**)
// ===========================================================================
//   研究コストの逓増は「エラ内クリティカルパス数リセット式」(GDD 11.1)だが、
//   開墾はそう書かれていない —— GDD 9.1 / 11.1 のどちらも
//   `base × 1.15^解放数 + cap` であり、解放数はエラを跨いで累積する読みが自然。
//   本実装は GDD の字面どおり**通算の解放数**を指数に使う(★要ユーザー判断として
//   報告済み)。エラ内リセットにする場合は `TerrainState.reclaimedCount` を
//   エラ跨ぎでゼロに戻す処理が要り、それは golden vector が動く変更になる。
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT } from "../adjacency";
import { FIX_ONE, minFix, mulFix, toRaw, type Fix } from "../fp";
import {
  EMPTY_TERRAIN,
  isRubbleCell,
  type EntityId,
  type GameState,
  type TerrainState,
} from "../state/state";
import { setTerrain } from "../state/update";
import { spendResources } from "./storage";
import { RulesError, requireReclaimParams, type EngineContent, type ReclaimParams } from "./types";

// --- 1. コスト式(GDD 9.1)--------------------------------------------------

/**
 * 解放数 n のときの開墾コスト = `min(cap, base × growth^n)`(§2)。
 *
 * @param params content の `balance.reclaim`
 * @param reclaimedCount これまでに開墾したセル数(`TerrainState.reclaimedCount`)
 * @throws {RulesError} 解放数が 0 以上の整数でない場合
 */
export function reclaimCostFix(params: ReclaimParams, reclaimedCount: number): Fix {
  if (!Number.isSafeInteger(reclaimedCount) || reclaimedCount < 0) {
    throw new RulesError(
      `reclaimCostFix: 解放数 ${String(reclaimedCount)} が 0 以上の整数でない(GDD 9.1)`,
    );
  }
  if (toRaw(params.costGrowthFix) < toRaw(FIX_ONE)) {
    // §2 の単調性(= cap 打ち切りの正当性)が破れる。schema 側も 1.0 未満を
    // 弾くが(schema/balance.ts の COST_GROWTH_RANGE)、engine 単体で式の前提が
    // 破れた state を黙って計算しないためここでも止める。
    throw new RulesError(
      `reclaimCostFix: 逓増の底 ${String(toRaw(params.costGrowthFix))} が 1.0 未満` +
        "(開墾コストが逓減する content は GDD 9.1 の指数爆発是正の趣旨に反する)",
    );
  }
  const cap = params.costCapFix;
  let cost = minFix(params.baseCostFix, cap);
  for (let n = 0; n < reclaimedCount; n++) {
    // 単調非減少ゆえ cap 到達で打ち切ってよい(§2 の証明)。
    if (toRaw(cost) >= toRaw(cap)) return cap;
    cost = minFix(mulFix(cost, params.costGrowthFix), cap);
  }
  return cost;
}

/**
 * いまこの state で次の 1 枚を開墾するのに要るコスト(GDD 9.1)。
 *
 * @throws {RulesError} content に reclaim ブロックが無い場合
 */
export function nextReclaimCostFix(state: GameState, content: EngineContent): Fix {
  return reclaimCostFix(requireReclaimParams(content), state.terrain.reclaimedCount);
}

// --- 2. 初期盤面の生成(新規ゲーム専用)-------------------------------------

/**
 * content の `balance.reclaim.initialRubbleCells` から新規ゲームの地形を作る
 * (GDD 6.1「初期利用可は一部、残りは瓦礫」)。
 *
 * **既存 state には一切触れない**(§1)。`reclaim` ブロックを持たない content
 * では {@link EMPTY_TERRAIN}(瓦礫ゼロ)を返す —— 瓦礫という概念を持たない
 * content で新規ゲームを始めたときの盤面は M52 以前と 1 bit も違わない。
 *
 * 呼ぶのは新規ゲームの bootstrap(未実装・M30 以降)だけであり、現時点で
 * engine 内から呼ぶ経路は無い。これが「既存 conformance シナリオ 64 本が
 * 影響を受けない」ことの構造的な根拠である。
 *
 * @throws {RulesError} 初期配置が昇順・重複なし・値域(0〜47)を満たさない場合
 */
export function initialTerrain(content: EngineContent): TerrainState {
  const params = content.reclaim;
  if (params === undefined) return EMPTY_TERRAIN;
  const cells = params.initialRubbleCells;
  if (cells.length === 0) return EMPTY_TERRAIN;

  let previous = -1;
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= GRID_CELL_COUNT) {
      throw new RulesError(
        `initialTerrain: 初期瓦礫セル ${String(cell)} が格子の範囲` +
          `(0〜${String(GRID_CELL_COUNT - 1)})の外(GDD 6.1)`,
      );
    }
    if (cell <= previous) {
      throw new RulesError(
        `initialTerrain: 初期瓦礫セルが昇順・重複なしでない(${String(previous)} → ${String(cell)})`,
      );
    }
    previous = cell;
  }
  return { rubbleCells: [...cells], reclaimedCount: 0 };
}

// --- 3. 開墾の state 遷移 ---------------------------------------------------

/** 瓦礫一覧から 1 セルを取り除く(昇順は保たれる)。 */
function withRubbleRemoved(rubbleCells: readonly number[], cellIndex: number): readonly number[] {
  const next: number[] = [];
  for (const cell of rubbleCells) {
    if (cell === cellIndex) continue;
    next.push(cell);
  }
  return next;
}

/**
 * 瓦礫セルを 1 枚開墾する(GDD 9.1)。**コストの支払いと地形の更新を 1 つの
 * 純関数で行う**(片方だけ済んだ state を誰にも見せない)。
 *
 * 事前検査(セルが瓦礫か・資源が足りるか)は呼び出し側 = `commands.ts` の
 * 責務であり(コマンド層の規約 §3: プレイヤーが普通に起こす失敗は例外ではなく
 * reject)、ここへ来た時点で不整合なら **RulesError で止める**。
 *
 * @throws {RulesError} content に reclaim ブロックが無い / そのセルが瓦礫でない場合
 * @throws {RulesError} 在庫不足(`spendResources` 経由。事前検査の漏れ)
 */
export function reclaimCell(
  state: GameState,
  content: EngineContent,
  cellIndex: number,
): GameState {
  const params = requireReclaimParams(content);
  if (!isRubbleCell(state, cellIndex)) {
    throw new RulesError(
      `reclaimCell: セル ${String(cellIndex)} は瓦礫ではない(開墾する対象が無い・GDD 9.1)`,
    );
  }
  const cost = reclaimCostFix(params, state.terrain.reclaimedCount);
  const costs = new Map<EntityId, Fix>([[params.costResourceId, cost]]);
  // コスト 0 の content でも `spendResources` は 0 を引くだけで済む(在庫不変)。
  const paid = toRaw(cost) > 0 ? spendResources(state, costs) : state;
  return setTerrain(paid, {
    rubbleCells: withRubbleRemoved(state.terrain.rubbleCells, cellIndex),
    reclaimedCount: state.terrain.reclaimedCount + 1,
  });
}
