// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 推奨配置アシスト(貪欲 + 80/100 約束) — M26
//   GDD 2.1(アシストは理論最大の 80% 止まり)/ 13.1(アシストアルゴリズム3種)/
//   6.3(隣接判定の確定事項)/ 14-3(残余リスク: 貪欲が理論最大に近づきすぎる)/
//   ADR-020(assist は engine 配置の純関数・sim bot が共有)
//
// ===========================================================================
// 1. このモジュールの位置づけ(state を変更しない)
// ===========================================================================
//   「施設をどこへ置くか迷ったときに、そこそこ良い配置を提案する」だけの
//   **純関数**である。GameState は読むだけで一切書き換えず、戻り値は
//   {@link PlacementPlan}(提案)であり、実際に盤面を動かすのはプレイヤーが
//   {@link placementPlanToCommands} で得た `placeFacility` コマンドを
//   `commands.ts` の `apply` へ渡したときだけである。
//
//   この分離は次の 2 つのために要る:
//     (a) アシストは「押さない自由」があってはじめて 80/100 約束が成立する
//         (GDD 2.1: コア層は使わない)。提案と適用が同じ関数だと、
//         UI がプレビューを出す途中で state が動いてしまう。
//     (b) sim bot(§11.5・M36)が同じ関数を共有する(ADR-020)。bot は
//         提案をそのままコマンド列へ流すが、閾値だけ差し替えたい。
//
//   **アシストは決定論バンドルの観測挙動ではない。** advance / scheduler から
//   呼ばれないので golden vector には一切現れず、ここの定数を変えても
//   `algoVersion` bump は要らない(ADR-016 の対象外)。ただし同一入力 →
//   同一出力(全順序タイブレーク・RNG 不使用)は engine の他と同じく必須である
//   —— リプレイ(commandLog)や bot の再現性がここに依存するため。
//
// ===========================================================================
// 2. 評価関数 = 盤面の産出乗数の総和(「配置効率」)
// ===========================================================================
//   GDD 2.1 の約束は「**アシスト出力効率** ≤ 手動理論最大 × 0.85」であり、
//   比較対象は出力そのものである。本モジュールが最大化する量は
//
//       boardScore = Σ_{盤上の全施設} computeCellAdjacency(...).multiplierFix
//
//   = 隣接ボーナス・過密ペナ込みの産出乗数の総和({@link boardOutputScore})。
//   施設ごとの基礎産出(`outputPerTickByLevel`)で重み付けしないのは、施設が
//   産出する資源が別物(薪 / 研究点 / …)で足し合わせに意味が無いためである。
//   乗数の総和は「同じ施設群を別の場所へ置いたら産出が何倍になるか」を
//   資源横断で表す唯一の無次元量であり、**理論最大との比を取るための尺度**として
//   これを採る(★ユーザー判断: 基礎産出重み付けを将来採るかは GDD 2.1 の
//   「出力効率」の定義次第)。
//
//   1 手ごとの評価は**盤面総和の増分** Δ である:
//
//       Δ(c) = (置いた施設自身の乗数) + Σ_{近傍施設} (置いた後の乗数 − 置く前の乗数)
//
//   自分の乗数だけを見る近視眼型にしないのは、隣接効果が対称(相手の乗数も動く)
//   だからで、片側しか数えないと「相手を過密で潰してでも自分が得をする」提案が
//   出てしまう。Δ は「その 1 手で盤面の産出効率がいくら増えたか」そのものであり、
//   施設 1 基を空きセルへ置く中立手の Δ は厳密に 1.0 になる(乗数 1.0・近傍不変)。
//
// ===========================================================================
// 3. 80/100 約束の実装(「狙って」80% に落とす仕掛け)
// ===========================================================================
//   GDD 14-3 は「実装で貪欲法の局所最適が理論最大に近づきすぎると +20% 上澄みが
//   縮む」を残余リスクに挙げている。実測すると素の貪欲(各手で Δ 最大)は
//   小盤面でしばしば理論最大に**一致**する(tests/engine/assistPlacement.test.ts
//   の「素の貪欲は理論最大に近い」ケース)ので、貪欲であること自体は 80% を
//   与えない。よって準最適化は**明示のパラメータ**で行う:
//
//     (1) その手で到達しうる最大増分 maxΔ を求める(素の貪欲が採る値)
//     (2) 目標増分 target = maxΔ × qualityRatio
//         (既定 {@link ASSIST_STEP_TARGET_RATIO} = 0.65。**1 手あたり**の比であり
//          盤面比の 0.80 とは別物 —— 対応関係は同定数の doc に校正表がある)
//     (3) target を**下回らない中立手の水準**へ床を入れる:
//           target ← max(target, min(1.0, maxΔ))
//         (アシストが「進んで損をする手」を狙わないための床。中立手 Δ=1.0 が
//          選べる限り、過密ペナで盤面を悪くする候補は目標にしない)
//     (4) |Δ(c) − target| が最小の候補を採る。同値なら Δ が小さい方(控えめな方)、
//         さらに同値ならセル番号昇順(§4)
//
//   qualityRatio = 1.0 にすると target = maxΔ となり (4) は「Δ 最大・セル番号
//   昇順」= **素の貪欲**に厳密に退化する。つまりこのパラメータ 1 個が
//   「理論貪欲」と「アシスト」を連続に繋いでおり、テストは同じ関数を
//   ratio=1.0 と 既定 の 2 通りで走らせて
//   「素の貪欲 ≈ 理論最大(0.95〜1.00)」「アシスト ≈ 理論最大 × 0.8」を同時に示す。
//
//   (4) が「target 以上で最小」ではなく「target に最も近い(同値なら下)」なのは、
//   効果値が離散なので「target 以上で最小」だと切り上がって理論最大へ張り付く
//   ためである。切り下げ側に倒すことで GDD 2.1 の
//   `アシスト ≤ 理論最大 × 0.85` を**上から**満たす。
//
//   **手の順序はアシストしない。** 施設をどの順に置くかは呼び出し側(プレイヤー /
//   bot)が決めた順のまま処理し、並べ替えも後戻りもしない。順序の最適化は手動
//   最適化に残す +20% 上澄み(GDD 2.1)の一部である。
//
// ===========================================================================
// 4. 決定論(RNG 不使用・全順序タイブレーク)
// ===========================================================================
//   乱数は一切引かない。候補の比較は
//     ① |Δ − target| 昇順 → ② Δ 昇順 → ③ アンカーセル番号昇順
//   の全順序で、③ が一意(1 セル = 1 施設)なので同点は残らない。集合の反復は
//   すべてセル番号昇順に固定してあり(近傍施設の集計も昇順ソート)、
//   Map の反復順が結果へ漏れない(GDD 11.7)。
//
//   隣接の評価は **M17 の本実装をそのまま呼ぶ**(`computeCellAdjacency` /
//   `adjacencyBasisCells` / `buildCellOccupancy` / `buildAdjacencySubjects`)。
//   独自の隣接計算は持たない —— UI プレビュー(M19)と同じ「単一の判定実装」の
//   要件(GDD 6.3)であり、アシストの提案とプレイヤーが実際に置いたときの数値が
//   食い違わないことの構造的な保証でもある。
//
// ===========================================================================
// 5. O(近傍) 増分評価(ADR-002(2) / ADR-029(2))
// ===========================================================================
//   候補セルごとに 48 セル全部の乗数を計算し直すのは無駄である。ある施設の乗数は
//   自分の判定基準セルの占有にしか依存しない(adjacency.ts §2)ので、施設を 1 基
//   置いたときに乗数が動くのは **その施設の判定基準セルを占有している施設だけ**
//   である(隣接関係の対称性: f の基準セルが候補の占有セルに触れる ⇔ f の占有セルが
//   候補の基準セルに触れる)。よって Δ の計算は
//     1 + (基準セル上の施設数 ≤ 12) 回の `computeCellAdjacency` で済む。
//   全再計算との一致は congruence テストで固定する
//   (tests/engine/assistPlacement.test.ts)。
// ---------------------------------------------------------------------------

import {
  GRID_CELL_COUNT,
  applySeedOffsets,
  computeCellAdjacency,
  type AdjacencyMatrix,
  type AdjacencySubject,
  type CellOccupancy,
  type CellOccupant,
  type Tag,
} from "../adjacency";
import type { PlaceFacilityCommand } from "../commands";
import {
  UNIT_FOOTPRINT,
  adjacencyBasisCells,
  footprintFitsGrid,
  isValidFootprintDims,
  occupiedCells,
} from "../footprint";
import {
  FIX_ONE,
  FIX_ZERO,
  addFix,
  absFix,
  fixFromRaw,
  mulFix,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import { buildAdjacencySubjects, buildCellOccupancy } from "../rules/production";
import { requireFacilityDef, type EngineContent } from "../rules/types";
import type { EntityId, FacilityFootprint, GameState } from "../state/state";
import { worldSeedToUint32 } from "../stochastic";

/** アシストの入力の契約違反(ID 重複・値域外の除外セルなど)。 */
export class AssistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistError";
  }
}

// --- 1. パラメータ ---------------------------------------------------------

/**
 * 準最適化の目標比(§3 の qualityRatio)。既定 **0.65**。
 *
 * **これは「1 手あたり」の目標比であって、GDD 2.1 の「8 割」そのものではない。**
 * GDD 2.1 が約束するのは**盤面出力効率**(理論最大との比)が 8 割であり、
 * 両者が一致しないのは §3 の 2 つの仕掛けのせいである:
 *
 *   ・中立手の床(§3(3)): 目標が Δ=1.0 を下回らないので、比を下げても
 *     「何も損しない配置」より悪くはならない = 盤面比には下限がある
 *   ・効果値の離散性: 候補の Δ は行列の係数の和なので飛び飛びで、目標に
 *     最も近い候補は目標そのものではない
 *
 * よって値は**盤面比が 0.80 前後に来るよう校正して決める**。校正は
 * tests/engine/assistPlacement.test.ts の代表盤面 5 種 × 総当たり最適で行い、
 * 0.60〜0.72 の掃引に対する盤面比の平均は
 *   0.60〜0.63 → 0.782 / **0.64〜0.66 → 0.796** / 0.67〜0.72 → 0.829
 * であった(2026-07-31 実測)。0.67 以上では単一タグ盤で 0.857 となり
 * GDD 2.1 の上限 0.85 を超えるため、中央値の **0.65** を採る。
 *
 * **engine 定数として持つ**(content 化しない)。理由は隣接クランプ ±60% を
 * engine 定数に留めた裁定 N2 と同じで、アシストの強さは運営 LLM の additive 追加で
 * 動いてよい量ではないため。ADR の balance スキーマ例には `assistEfficiencyCap`
 * が載っているが、そちらは**検収の上限**(下記 {@link ASSIST_EFFICIENCY_CAP})で
 * あって 1 手あたりの目標値ではない。
 *
 * 実 content(施設 14 種・タグ 7 種)での再校正はバランス調整段(M39〜M41)の
 * 対象である。校正盤面が縮約 content である点は正直な限界として開示しておく。
 */
export const ASSIST_STEP_TARGET_RATIO: Fix = fixFromRaw(650_000);

/**
 * GDD 2.1 の設計不変条件 `アシスト出力効率 ≤ 手動理論最大 × 0.85` の 0.85。
 *
 * ここに置いてあるのは**テストが読む上限**であり、アシスト本体はこの値を
 * 参照しない(0.85 は「守れているか検査する線」であって「狙う線」ではない。
 * 狙うのは {@link ASSIST_STEP_TARGET_RATIO})。
 */
export const ASSIST_EFFICIENCY_CAP: Fix = fixFromRaw(850_000);

// --- 2. 入出力の型 ---------------------------------------------------------

/** 「この施設を 1 基置きたい」という要求。置く順序は配列の順のまま(§3)。 */
export interface PlacementRequest {
  /** 新しく作る施設 entity の ID(`placeFacility` へそのまま渡る)。 */
  readonly facilityId: EntityId;
  /** content の facility 定義 ID。 */
  readonly defId: EntityId;
}

/** 1 基分の提案。 */
export interface PlacementSuggestion {
  readonly facilityId: EntityId;
  readonly defId: EntityId;
  /** 提案する占有矩形のアンカー(左上)セル番号。 */
  readonly cellIndex: number;
  /** その施設の占有形状(content から解決済み。1×1 なら {@link UNIT_FOOTPRINT})。 */
  readonly footprint: FacilityFootprint;
  /** この手で実際に得た盤面効率の増分 Δ(§2)。 */
  readonly deltaScoreFix: Fix;
  /** その手で到達しうる最大増分 maxΔ(= 素の貪欲が採る値・§3(1))。 */
  readonly bestDeltaScoreFix: Fix;
  /** 準最適化の目標増分 target(§3(2)(3))。内訳の説明表示に使える。 */
  readonly targetDeltaScoreFix: Fix;
}

/** {@link suggestPlacements} の結果。state は一切動いていない(§1)。 */
export interface PlacementPlan {
  /** 要求順の提案列。置けなかった施設はここに現れない。 */
  readonly suggestions: readonly PlacementSuggestion[];
  /** 空きセルが尽きて置けなかった施設の ID(要求順)。 */
  readonly unplacedFacilityIds: readonly EntityId[];
  /** 提案前の盤面効率({@link boardOutputScore})。 */
  readonly boardScoreBeforeFix: Fix;
  /** 提案を全部適用した後の盤面効率。 */
  readonly boardScoreAfterFix: Fix;
}

/** 任意パラメータ。 */
export interface PlacementAssistOptions {
  /**
   * §3 の qualityRatio。既定 {@link ASSIST_STEP_TARGET_RATIO}。
   * 1.0 を渡すと素の貪欲(各手で Δ 最大)に厳密に退化する。
   */
  readonly qualityRatioFix?: Fix;
  /**
   * 使ってはならないセル(瓦礫セル等)。**M52(瓦礫の state 化)の結線点**であり、
   * 現時点では state に瓦礫が無いので呼び出し側は渡さなくてよい。
   * 渡す場合は 0〜47 の整数であること。
   */
  readonly blockedCells?: readonly number[];
}

// --- 3. 盤面効率 -----------------------------------------------------------

/**
 * その state の隣接行列(周回シード揺らぎ焼き込み済み)。
 * `advance.ts` の `createAdvanceContext` と同じ 1 行であり、アシストが
 * advance と違う行列を見ないための単一の口。
 */
export function assistAdjacencyMatrix(state: GameState, content: EngineContent): AdjacencyMatrix {
  return applySeedOffsets(content.adjacency, worldSeedToUint32(state.worldSeed));
}

/**
 * 盤面効率 = 盤上の全施設の産出乗数の総和(§2)。
 *
 * 加算順は**アンカーセル番号の昇順**に固定する(Map の反復順が結果に漏れない・
 * GDD 11.7)。固定小数点の加算は厳密整数演算なので順序で値は変わらないが、
 * 将来クランプ等が入ったときに順序依存が静かに混入するのを防ぐ。
 */
export function boardOutputScore(state: GameState, content: EngineContent): Fix {
  const matrix = assistAdjacencyMatrix(state, content);
  const occupancy = buildCellOccupancy(state, content);
  const subjects = buildAdjacencySubjects(state, content);
  const byAnchor = new Map<number, AdjacencySubject>();
  for (const subject of subjects.values()) byAnchor.set(subject.cellIndex, subject);
  return sumMultipliers(matrix, occupancy, byAnchor);
}

function sumMultipliers(
  matrix: AdjacencyMatrix,
  occupancy: CellOccupancy,
  subjectByAnchor: ReadonlyMap<number, AdjacencySubject>,
): Fix {
  let total = FIX_ZERO;
  for (const anchor of ascendingKeys(subjectByAnchor)) {
    const subject = subjectByAnchor.get(anchor);
    if (subject === undefined) continue;
    total = addFix(total, computeCellAdjacency(matrix, occupancy, subject).multiplierFix);
  }
  return total;
}

/** Map のキーをセル番号昇順で書き出す(反復順の固定・§4)。 */
function ascendingKeys(map: ReadonlyMap<number, unknown>): readonly number[] {
  const keys: number[] = [];
  for (const key of map.keys()) keys.push(key);
  keys.sort((l, r) => l - r);
  return keys;
}

// --- 4. 作業盤面(提案の途中経過) ------------------------------------------

/**
 * 提案を積み上げる途中の盤面。**GameState の複製ではない**(entity を作らない)。
 * 施設の同一性キーはアンカーセル番号で、これは adjacency.ts §3(f) と同じ根拠
 * (1 セル = 1 施設ゆえアンカー一致 ⇔ 同一施設)による。
 */
interface WorkingBoard {
  readonly occupancy: Map<number, CellOccupant>;
  readonly subjectByAnchor: Map<number, AdjacencySubject>;
  /** 現時点の乗数キャッシュ(増分評価の「置く前」の値・§5)。 */
  readonly multiplierByAnchor: Map<number, Fix>;
  /** 使用禁止セル(添字 = セル番号)。 */
  readonly blocked: readonly boolean[];
}

function createWorkingBoard(
  state: GameState,
  content: EngineContent,
  matrix: AdjacencyMatrix,
  blockedCells: readonly number[],
): WorkingBoard {
  const blocked: boolean[] = [];
  for (const cell of blockedCells) {
    if (!Number.isSafeInteger(cell) || cell < 0 || cell >= GRID_CELL_COUNT) {
      throw new AssistError(
        `blockedCells のセル番号 ${String(cell)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})の外`,
      );
    }
    blocked[cell] = true;
  }

  const occupancy = new Map<number, CellOccupant>(buildCellOccupancy(state, content));
  const subjectByAnchor = new Map<number, AdjacencySubject>();
  for (const subject of buildAdjacencySubjects(state, content).values()) {
    subjectByAnchor.set(subject.cellIndex, subject);
  }
  const multiplierByAnchor = new Map<number, Fix>();
  for (const anchor of ascendingKeys(subjectByAnchor)) {
    const subject = subjectByAnchor.get(anchor);
    if (subject === undefined) continue;
    multiplierByAnchor.set(anchor, computeCellAdjacency(matrix, occupancy, subject).multiplierFix);
  }
  return { occupancy, subjectByAnchor, multiplierByAnchor, blocked };
}

/** 判定基準セル上に居る施設のアンカー(昇順・重複なし)。§5 の「動きうる施設」。 */
function neighborAnchors(board: WorkingBoard, basisCells: readonly number[]): readonly number[] {
  const seen: boolean[] = [];
  const anchors: number[] = [];
  for (const cell of basisCells) {
    const occupant = board.occupancy.get(cell);
    if (occupant === undefined) continue;
    if (seen[occupant.anchorCellIndex] === true) continue;
    seen[occupant.anchorCellIndex] = true;
    anchors.push(occupant.anchorCellIndex);
  }
  anchors.sort((l, r) => l - r);
  return anchors;
}

function requireSubject(board: WorkingBoard, anchor: number): AdjacencySubject {
  const subject = board.subjectByAnchor.get(anchor);
  if (subject === undefined) {
    throw new AssistError(
      `アンカー ${String(anchor)} の施設が占有だけあって素性が無い(作業盤面の不変条件違反)`,
    );
  }
  return subject;
}

function requireMultiplier(board: WorkingBoard, anchor: number): Fix {
  const value = board.multiplierByAnchor.get(anchor);
  if (value === undefined) {
    throw new AssistError(
      `アンカー ${String(anchor)} の乗数キャッシュが無い(作業盤面の不変条件違反)`,
    );
  }
  return value;
}

// --- 5. 候補の列挙と評価 ---------------------------------------------------

interface Candidate {
  readonly anchorCellIndex: number;
  readonly cells: readonly number[];
  readonly subject: AdjacencySubject;
  readonly deltaFix: Fix;
}

/** その候補セル群が空いているか(占有 / 使用禁止のどちらでも不可)。 */
function cellsAreFree(board: WorkingBoard, cells: readonly number[]): boolean {
  for (const cell of cells) {
    if (board.blocked[cell] === true) return false;
    if (board.occupancy.has(cell)) return false;
  }
  return true;
}

/**
 * 候補を仮置きしたときの盤面効率の増分 Δ(§2)。
 * 仮置きは同じ Map の上で行い、評価後に必ず取り除く(呼び出し前後で occupancy は
 * 同一の内容に戻る)。
 */
function evaluateDelta(
  matrix: AdjacencyMatrix,
  board: WorkingBoard,
  subject: AdjacencySubject,
  cells: readonly number[],
): Fix {
  const anchors = neighborAnchors(board, subject.basisCells ?? []);
  const occupant: CellOccupant = { anchorCellIndex: subject.cellIndex, tags: subject.tags };
  for (const cell of cells) board.occupancy.set(cell, occupant);

  let delta = computeCellAdjacency(matrix, board.occupancy, subject).multiplierFix;
  for (const anchor of anchors) {
    const after = computeCellAdjacency(
      matrix,
      board.occupancy,
      requireSubject(board, anchor),
    ).multiplierFix;
    delta = addFix(delta, subFix(after, requireMultiplier(board, anchor)));
  }

  for (const cell of cells) board.occupancy.delete(cell);
  return delta;
}

/** 提案を作業盤面へ確定する(乗数キャッシュも近傍ごと更新する)。 */
function commitCandidate(matrix: AdjacencyMatrix, board: WorkingBoard, candidate: Candidate): void {
  const occupant: CellOccupant = {
    anchorCellIndex: candidate.anchorCellIndex,
    tags: candidate.subject.tags,
  };
  for (const cell of candidate.cells) board.occupancy.set(cell, occupant);
  board.subjectByAnchor.set(candidate.anchorCellIndex, candidate.subject);

  const anchors = neighborAnchors(board, candidate.subject.basisCells ?? []);
  board.multiplierByAnchor.set(
    candidate.anchorCellIndex,
    computeCellAdjacency(matrix, board.occupancy, candidate.subject).multiplierFix,
  );
  for (const anchor of anchors) {
    board.multiplierByAnchor.set(
      anchor,
      computeCellAdjacency(matrix, board.occupancy, requireSubject(board, anchor)).multiplierFix,
    );
  }
}

function enumerateCandidates(
  matrix: AdjacencyMatrix,
  board: WorkingBoard,
  defId: EntityId,
  tags: readonly Tag[],
  footprint: FacilityFootprint,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (let anchor = 0; anchor < GRID_CELL_COUNT; anchor++) {
    if (!footprintFitsGrid(anchor, footprint)) continue;
    const cells = occupiedCells(anchor, footprint);
    if (!cellsAreFree(board, cells)) continue;
    const subject: AdjacencySubject = {
      cellIndex: anchor,
      defId,
      tags,
      basisCells: adjacencyBasisCells(cells),
    };
    candidates.push({
      anchorCellIndex: anchor,
      cells,
      subject,
      deltaFix: evaluateDelta(matrix, board, subject, cells),
    });
  }
  return candidates;
}

// --- 6. 準最適選択(80/100 約束・§3) --------------------------------------

/** その手の目標増分 target を求める(§3(1)〜(3))。 */
export function assistTargetDelta(bestDeltaFix: Fix, qualityRatioFix: Fix): Fix {
  // 到達しうる最大増分が 0 以下 = どこへ置いても盤面効率が増えない状況。
  // 比を掛けると符号の都合で「より悪い方」が目標になるので、素直に最良を狙う。
  if (toRaw(bestDeltaFix) <= 0) return bestDeltaFix;
  const scaled = mulFix(bestDeltaFix, qualityRatioFix);
  // 床: 中立手(空きセルへ置くだけ = Δ 1.0)を下回る目標にはしない。
  // 「進んで過密ペナを踏む提案」を避けるための下限であり、maxΔ 自体が 1.0 未満
  // (どこへ置いても近傍を悪くする盤面)ならその maxΔ が床になる。
  const floor = toRaw(bestDeltaFix) < toRaw(FIX_ONE) ? bestDeltaFix : FIX_ONE;
  return toRaw(scaled) < toRaw(floor) ? floor : scaled;
}

/**
 * 目標増分に最も近い候補を選ぶ(§3(4))。比較は
 * ① |Δ − target| 昇順 → ② Δ 昇順 → ③ アンカーセル番号昇順 の全順序。
 */
function selectCandidate(candidates: readonly Candidate[], targetFix: Fix): Candidate {
  let best = candidates[0];
  if (best === undefined) {
    throw new AssistError("候補が空の状態で選択しようとした(呼び出し側の不変条件違反)");
  }
  let bestDistance = absFix(subFix(best.deltaFix, targetFix));
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const distance = absFix(subFix(candidate.deltaFix, targetFix));
    const distanceDiff = toRaw(distance) - toRaw(bestDistance);
    if (distanceDiff > 0) continue;
    if (distanceDiff === 0) {
      const deltaDiff = toRaw(candidate.deltaFix) - toRaw(best.deltaFix);
      if (deltaDiff > 0) continue;
      // Δ も同値なら、列挙がセル番号昇順なので先着(= 番号が小さい方)を保つ。
      if (deltaDiff === 0) continue;
    }
    best = candidate;
    bestDistance = distance;
  }
  return best;
}

// --- 7. 入口 ---------------------------------------------------------------

/**
 * 推奨配置を提案する(GDD 2.1 の「推奨配置ワンタップ」)。**state は動かない**(§1)。
 *
 * 要求は配列の順に 1 基ずつ処理し、各手で
 *   候補列挙(盤内・空き・使用禁止でない全アンカー) → Δ 評価(§2・§5)
 *   → 目標増分の算出(§3) → 目標に最も近い候補を採用(§3(4))
 * を行う。後戻り(既に採った提案の撤回)も要求の並べ替えもしない。
 *
 * 空きが無くて置けなかった施設は例外にせず {@link PlacementPlan.unplacedFacilityIds}
 * へ載せる(盤面が埋まっているのはプレイヤー操作の結果であって異常ではない)。
 *
 * @throws {AssistError} 要求内で施設 ID が重複 / 既存 entity ID と衝突 /
 *   content の footprint が engine の表現外 / 使用禁止セルが値域外の場合
 * @throws {RulesError} content に facility 定義が無い場合
 */
export function suggestPlacements(
  state: GameState,
  content: EngineContent,
  requests: readonly PlacementRequest[],
  options: PlacementAssistOptions = {},
): PlacementPlan {
  const qualityRatioFix = options.qualityRatioFix ?? ASSIST_STEP_TARGET_RATIO;
  if (toRaw(qualityRatioFix) < 0) {
    throw new AssistError(`qualityRatioFix ${String(toRaw(qualityRatioFix))} は 0 以上で指定する`);
  }
  const matrix = assistAdjacencyMatrix(state, content);
  const board = createWorkingBoard(state, content, matrix, options.blockedCells ?? []);
  const boardScoreBeforeFix = sumMultipliers(matrix, board.occupancy, board.subjectByAnchor);

  const requestedIds = new Set<EntityId>();
  const suggestions: PlacementSuggestion[] = [];
  const unplacedFacilityIds: EntityId[] = [];

  for (const request of requests) {
    if (requestedIds.has(request.facilityId)) {
      throw new AssistError(`要求内で施設 ID "${request.facilityId}" が重複している`);
    }
    requestedIds.add(request.facilityId);
    if (state.entityStateById.has(request.facilityId)) {
      throw new AssistError(
        `施設 ID "${request.facilityId}" は既に使われている(提案しても placeFacility が reject される)`,
      );
    }

    const def = requireFacilityDef(content, request.defId);
    const footprint = def.footprint ?? UNIT_FOOTPRINT;
    if (!isValidFootprintDims(footprint)) {
      throw new AssistError(
        `facility 定義 "${request.defId}" の footprint ` +
          `${String(footprint.width)}×${String(footprint.height)} は engine が表現できない(GDD 6.1)`,
      );
    }

    const candidates = enumerateCandidates(matrix, board, def.id, def.tags, footprint);
    if (candidates.length === 0) {
      unplacedFacilityIds.push(request.facilityId);
      continue;
    }

    let bestDeltaFix = candidates[0]?.deltaFix ?? FIX_ZERO;
    for (const candidate of candidates) {
      if (toRaw(candidate.deltaFix) > toRaw(bestDeltaFix)) bestDeltaFix = candidate.deltaFix;
    }
    const targetDeltaScoreFix = assistTargetDelta(bestDeltaFix, qualityRatioFix);
    const chosen = selectCandidate(candidates, targetDeltaScoreFix);
    commitCandidate(matrix, board, chosen);

    suggestions.push({
      facilityId: request.facilityId,
      defId: request.defId,
      cellIndex: chosen.anchorCellIndex,
      footprint,
      deltaScoreFix: chosen.deltaFix,
      bestDeltaScoreFix: bestDeltaFix,
      targetDeltaScoreFix,
    });
  }

  return {
    suggestions,
    unplacedFacilityIds,
    boardScoreBeforeFix,
    boardScoreAfterFix: sumMultipliers(matrix, board.occupancy, board.subjectByAnchor),
  };
}

/**
 * 提案を `placeFacility` コマンド列へ落とす(ADR-020 の `(state, content) => Command[]`)。
 * 適用するかどうかはプレイヤー / bot の判断であり、この関数は state を触らない。
 */
export function placementPlanToCommands(plan: PlacementPlan): readonly PlaceFacilityCommand[] {
  const commands: PlaceFacilityCommand[] = [];
  for (const suggestion of plan.suggestions) {
    commands.push({
      kind: "placeFacility",
      facilityId: suggestion.facilityId,
      defId: suggestion.defId,
      cellIndex: suggestion.cellIndex,
    });
  }
  return commands;
}
