// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 内訳ビュー(GDD 6.5 MVP要件)の per-タグ分解 (M19)
//
// ===========================================================================
// 設計上の制約と対処(必ず読むこと)
// ===========================================================================
// `src/engine/adjacency.ts` の `computeCellAdjacency` は「このセルの最終乗数」
// (`bonusFix` / `overcrowdPenaltyFix` / `multiplierFix` / `overcrowdedNeighborCount`)
// しか返さない。内訳ビュー(GDD 6.5「このセルの数値内訳(どの隣接が+何%、過密で
// −何%)」)にはタグ別・近傍別の生係数が要るが、engine 側にその分解を追加する API
// は無く、**本タスクは `src/engine/` を変更禁止**(M22 が並行作業中のため)。
//
// そこで本モジュールは以下の方針を取る:
//   1. **最終的にゲームプレイへ効く数値(bonusFix/overcrowdPenaltyFix/
//      multiplierFix/overcrowdedNeighborCount)は必ず `computeCellAdjacency` を
//      呼んで得る**(このファイルが独自に再計算した値をそれらのフィールドへ
//      入れることはしない)。
//   2. 内訳(どのタグ・どの近傍が寄与したか)を作るためだけに、
//      `computeCellAdjacency` の手順1〜3(GDD 6.3 の基準セル収集・タグ別バケツ・
//      辞書順での有効/超過分割)を**表示専用として複製**する。複製対象は
//      `effectApplies`(3分岐の小さな述語・`AdjacencyTarget` は公開型)のみで、
//      乗数の算術(加算・クランプ)そのものは複製しない。
//   3. `tests/ui/screens/adjacencyBreakdown.test.ts` が「この複製から積み上げた
//      値」と「`computeCellAdjacency` が返す値」の一致を反証テストとして固定する
//      (乖離したら即座にテストが落ちる)。
//
// **★要ユーザー判断(最終報告に転記)**: 本来は `computeCellAdjacency` 自体が
// 内訳を返す(またはタグ別ヘルパーを公開する)方が「単一実装」の原則に忠実だが、
// それは engine 側の変更であり本タスクのスコープ外。将来 engine へ触れるタスクで
// 内訳を engine 側へ export する形に寄せることを推奨する。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../../../engine/canonicalize";
import {
  ADJACENCY_TAGS,
  cellIdOf,
  neighborCellIndices,
  tagPairKey,
  type AdjacencyMatrix,
  type AdjacencySubject,
  type CellOccupancy,
  type CellAdjacencyResult,
  type AdjacencyTarget,
  type Tag,
  type TagPairEffect,
  computeCellAdjacency,
} from "../../../engine/adjacency";
import { toRaw, type Fix, fixFromRaw } from "../../../engine/fp";

/** `computeCellAdjacency` 内部の private `effectApplies` と同一の3分岐(§設計上の制約 2)。 */
function effectAppliesForBreakdown(
  target: AdjacencyTarget,
  subject: Pick<AdjacencySubject, "defId" | "tags">,
): boolean {
  switch (target.kind) {
    case "any":
      return true;
    case "facilityDef":
      return target.defId === subject.defId;
    case "tag":
      return subject.tags.includes(target.tag);
    default: {
      const unhandled: never = target;
      throw new Error(`adjacencyBreakdown: 未知の target 種別 ${JSON.stringify(unhandled)}`);
    }
  }
}

/** 1 個の (近傍タグ, 自施設タグ) ペアの寄与。`effect` が無ければルール自体が未定義。 */
export interface TagPairContribution {
  readonly neighborAnchorCellIndex: number;
  readonly selfTag: Tag;
  readonly neighborTag: Tag;
  readonly effect: TagPairEffect | null;
  /** ルールが存在し、かつ `target` が自施設に当たる(= 実際にボーナスへ積まれた)。 */
  readonly applied: boolean;
}

/** 1 タグぶんのバケツ(GDD 6.3(c) の辞書順選抜の単位)。 */
export interface TagBreakdownBucket {
  readonly tag: Tag;
  /** セルID辞書順(GDD 6.3(c))。 */
  readonly neighborAnchors: readonly number[];
  /** 先頭 (threshold-1) 件(通常ボーナス対象)。 */
  readonly effectiveAnchors: readonly number[];
  /** 超過分(ボーナス無効化 + ペナ対象)。 */
  readonly excessAnchors: readonly number[];
  /** 有効な近傍 × 自施設タグの全組合せ(§設計上の制約2の複製部分)。 */
  readonly contributions: readonly TagPairContribution[];
  /** このタグの超過が生む生ペナルティ(タグ横断クランプ前・参考値)。 */
  readonly rawPenaltyFix: Fix;
}

/** 内訳ビュー(GDD 6.5)が表示する1セルぶんの全データ。 */
export interface CellAdjacencyBreakdown {
  readonly buckets: readonly TagBreakdownBucket[];
  /** 以下4フィールドは `computeCellAdjacency` の戻り値そのまま(§設計上の制約1)。 */
  readonly bonusFix: Fix;
  readonly overcrowdPenaltyFix: Fix;
  readonly multiplierFix: Fix;
  readonly overcrowdedNeighborCount: number;
}

/**
 * 内訳ビュー用のデータを組み立てる。
 *
 * @throws {AdjacencyError} `computeCellAdjacency` 自体が例外を投げる場合
 *   (セル番号が範囲外など)。
 */
export function computeAdjacencyBreakdown(
  matrix: AdjacencyMatrix,
  occupancy: CellOccupancy,
  subject: AdjacencySubject,
): CellAdjacencyBreakdown {
  // §設計上の制約1: 最終値は engine を直接呼ぶ(独自再計算にしない)。
  const official: CellAdjacencyResult = computeCellAdjacency(matrix, occupancy, subject);

  // §設計上の制約2: 内訳だけを複製する(手順1〜3・adjacency.ts §3 と同一のロジック)。
  const basisCells = subject.basisCells ?? neighborCellIndices(subject.cellIndex);
  const seenAnchor = new Set<number>();
  const neighborTagsByAnchor = new Map<number, readonly Tag[]>();
  for (const basisCell of basisCells) {
    const occupant = occupancy.get(basisCell);
    if (occupant === undefined) continue;
    if (occupant.anchorCellIndex === subject.cellIndex) continue;
    if (seenAnchor.has(occupant.anchorCellIndex)) continue;
    seenAnchor.add(occupant.anchorCellIndex);
    neighborTagsByAnchor.set(occupant.anchorCellIndex, occupant.tags);
  }

  const anchorsByTag = new Map<Tag, number[]>();
  for (const [anchor, tags] of neighborTagsByAnchor) {
    for (const tag of tags) {
      const bucket = anchorsByTag.get(tag);
      if (bucket === undefined) anchorsByTag.set(tag, [anchor]);
      else bucket.push(anchor);
    }
  }

  const buckets: TagBreakdownBucket[] = [];
  const effectiveLimit = matrix.overcrowd.threshold - 1;
  for (const tag of ADJACENCY_TAGS) {
    const bucket = anchorsByTag.get(tag);
    if (bucket === undefined) continue;

    const ordered = [...bucket].sort((l, r) => compareUtf16(cellIdOf(l), cellIdOf(r)));
    const effectiveCount = ordered.length < effectiveLimit ? ordered.length : effectiveLimit;
    const effectiveAnchors = ordered.slice(0, effectiveCount);
    const excessAnchors = ordered.slice(effectiveCount);
    const rawPenaltyFix = fixFromRaw(
      toRaw(matrix.overcrowd.penaltyPerExcessFix) * excessAnchors.length,
    );

    const contributions: TagPairContribution[] = [];
    for (const anchor of effectiveAnchors) {
      for (const selfTag of subject.tags) {
        const effect = matrix.pairEffects.get(tagPairKey(selfTag, tag)) ?? null;
        const applied = effect !== null && effectAppliesForBreakdown(effect.target, subject);
        contributions.push({
          neighborAnchorCellIndex: anchor,
          selfTag,
          neighborTag: tag,
          effect,
          applied,
        });
      }
    }

    buckets.push({
      tag,
      neighborAnchors: ordered,
      effectiveAnchors,
      excessAnchors,
      contributions,
      rawPenaltyFix,
    });
  }

  return {
    buckets,
    bonusFix: official.bonusFix,
    overcrowdPenaltyFix: official.overcrowdPenaltyFix,
    multiplierFix: official.multiplierFix,
    overcrowdedNeighborCount: official.overcrowdedNeighborCount,
  };
}

/**
 * 過密警告バッジ(GDD 6.5・常時表示)の色に使う代表タグを選ぶ。
 *
 * **[M19 設計判断・非ブロッキング]** 複数タグが同時に過密超過している場合、
 * どのタグの ink 色をバッジへ使うかは spec に明記が無い。`ADJACENCY_TAGS`
 * の宣言順(= GDD 11.7 の安定順序)で最初に超過があるタグを採用する
 * (決定論を保つための機械的な選び方。最終報告の ★ 項目として報告する)。
 */
export function representativeOvercrowdedTag(breakdown: CellAdjacencyBreakdown): Tag | null {
  for (const bucket of breakdown.buckets) {
    if (bucket.excessAnchors.length > 0) return bucket.tag;
  }
  return null;
}
