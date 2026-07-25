// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 隣接ボーナス(タグ×タグ対称行列) — GDD 6.2/6.3/6.4 / ADR-002(2)
//
// 隣接効果は**施設ペアではなくタグペアで解決する**(GDD 6.2)。施設は
// `facility.tags[]` を持ち、行列は「タグ7種 × タグ7種」の対称行列なので、
// 施設をいくら増やしても記述量は O(タグ種数²) = 49 セル以下で固定される。
// 判定は 8 近傍の静的判定のみ(パスファインディング不使用)。
//
// ===========================================================================
// 1. このモジュールが持たないもの
// ===========================================================================
//   ここは「セル配置(タグの分布)から乗数を出す」純粋な幾何 + 行列演算だけを
//   持ち、GameState も content の施設定義も知らない。入力は
//   {@link CellOccupancy}(セル番号 → そのセルのタグ列)であり、これを state と
//   content から組み立てるのは rules/production.ts の責務である。
//   こうしておくと、UI の配置プレビュー(GDD 6.5)が「仮に置いたらどうなるか」を
//   同じ関数で計算できる(state を作らずに occupancy だけ差し替えればよい)。
//
// ===========================================================================
// 2. O(近傍) の上界(ADR-002(2) / ADR-029(2))
// ===========================================================================
//   過密判定はセル局所であり、あるセルの乗数は「自セル + 8 近傍」のタグにしか
//   依存しない。よって 1 セル編集時の再計算上界は O(8) で、48 セル全走査は不要。
//   {@link computeFacilityMultipliers} が全施設分をまとめて計算するのは
//   「1 回の advance の開始時に一度だけ」であり(配置は advance 中に変わらない)、
//   毎 tick / 毎セグメントの再計算ではない。
//
// ===========================================================================
// 3. 判定規則(GDD 6.3 の確定事項をそのまま実装)
// ===========================================================================
//   (a) 近傍の列挙順は方向順 N, NE, E, SE, S, SW, W, NW に固定。
//   (b) 過密はタグ単位で独立集計する。1 施設が複数タグを持つ場合、各タグの
//       過密カウントに同時参加する(熱源かつ騒音の施設は両タグに別々に数える)。
//   (c) 「3 つ目」判定は、方向順で列挙した後に**安定文字列(セルID)辞書順へ
//       再ソート**し、先頭 (threshold-1) 件のみ通常ボーナス、それ以降を
//       ボーナス無効化 + 超過 1 件につきペナルティ。
//   (d) 全ボーナスは加算 → 単一係数 ±60% クランプ。過密ペナはクランプ外で
//       別途 ±clampFP でクランプしてから減算する。
//   (e) 大型施設(2×1 / 2×2)は「全占有セルの外周 8 近傍の和集合から自セル群を
//       除外」した集合を基準とし、ボーナスは 1 施設 1 回のみ計上する。T5 の
//       縮約 state は施設を基準セル 1 個で表す(FacilityState.cellIndex)ため、
//       占有セルの和集合は表現できない = **T5 では全施設を 1×1 として扱う**。
//       footprint を state に入れる段階で (e) を実装すること(GDD 6.3 は
//       `adjacency.json` スキーマと UI プレビュー共通ロジックとして規定)。
//
// ===========================================================================
// 4. シード揺らぎ(GDD 6.4-2)
// ===========================================================================
//   タグペア係数に周回ごとの ±20%(`seedOffsetRange`)の揺らぎを乗せる。
//   行列の骨格は不変だが係数が周回で変わるので最適レイアウトが状況依存になる。
//   揺らぎは worldSeed とタグペアキーだけから決まる**周回固定値**なので、
//   {@link applySeedOffsets} で行列に焼き込んでから使う(毎セル計算で hash を
//   引き直さない)。RNG は domainTag 'adjacency' の hash アドレス方式で、
//   逐次ストリーム(rngState)を消費しない。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "./canonicalize";
import {
  FIX_ONE,
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromRaw,
  maxFix,
  mulFixProven,
  negFix,
  sumFix,
  toRaw,
  type Fix,
} from "./fp";
import { fnv1a32 } from "./rng/fnv1a32";
import { DOMAIN_TAGS } from "./rng/domainTags";
import { hashedDrawUint32, uniformFixFromDraw } from "./stochastic";

/** 隣接行列の入力・構成の誤り(未知タグ・重複ペア・値域外など)。 */
export class AdjacencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdjacencyError";
  }
}

// --- 1. タグとグリッド -----------------------------------------------------

/**
 * 施設タグ 7 種(GDD 6.1: 熱源 / 清浄 / 汚染 / 騒音 / 湿潤 / 静穏 / 学芸)。
 * 英字 ID の出典は `docs/design/tags-spec.md` 末尾の機械可読 JSON(T13)。
 *
 * content 側の検証器(`schema/facility.ts` の FACILITY_TAGS)にも同じ集合が
 * あるが、engine は schema/ を import できない(依存は内向き一方向)ため
 * 定義が 2 箇所になるのは構造上避けられない。**engine コードにとってはこの
 * 配列が権威**であり、content 由来の文字列をここへ突き合わせるのは
 * content ロード側(内部表現への変換)の責務である。
 *
 * 宣言順は集合演算の反復順(= 加算順序)として使われる固定順序でもある
 * (GDD 11.7「全集合演算は安定順序で計算」)。
 */
export const ADJACENCY_TAGS = ["heat", "clean", "foul", "noise", "damp", "calm", "lore"] as const;

/** 施設タグ。{@link ADJACENCY_TAGS} の値のみ。 */
export type Tag = (typeof ADJACENCY_TAGS)[number];

/** 未知の文字列がタグ 7 種のいずれかかを判定する(型ガード)。 */
export function isTag(value: string): value is Tag {
  for (const tag of ADJACENCY_TAGS) {
    if (tag === value) return true;
  }
  return false;
}

/** 格子の幅(列数)。GDD 6.1: 初期 6×8 = 48 セル。 */
export const GRID_WIDTH = 6;
/** 格子の高さ(行数)。 */
export const GRID_HEIGHT = 8;
/** セル総数 = 48。`FacilityState.cellIndex` の値域は 0〜47。 */
export const GRID_CELL_COUNT = GRID_WIDTH * GRID_HEIGHT;

/**
 * 8 近傍のオフセット。**方向順 N, NE, E, SE, S, SW, W, NW に固定**(GDD 6.3)。
 * y は下方向が正(cellIndex = y * GRID_WIDTH + x)。
 */
export const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0], // E
  [1, 1], // SE
  [0, 1], // S
  [-1, 1], // SW
  [-1, 0], // W
  [-1, -1], // NW
];

/** {@link NEIGHBOR_OFFSETS} と同じ並びの方向名(ログ・テストの可読性のため)。 */
export const NEIGHBOR_DIRECTION_NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function requireCellIndex(cellIndex: number): void {
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= GRID_CELL_COUNT) {
    throw new AdjacencyError(
      `セル番号 ${String(cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})を外れている`,
    );
  }
}

/**
 * セルの安定文字列 ID。GDD 6.3(c) の「セルID 辞書順」の基準になる。
 *
 * 2 桁ゼロ埋め(`c00`〜`c47`)にしてあるので**辞書順 = セル番号の昇順**であり、
 * 「方向順に列挙 → セルID 辞書順へ再ソート」が数値昇順ソートと一致する。
 * 格子が 100 セル以上になると桁数が増えて辞書順 ≠ 数値順になるため、
 * その時は桁数を上げる(下の assert が破れて気づける)。
 */
export function cellIdOf(cellIndex: number): string {
  requireCellIndex(cellIndex);
  return `c${String(cellIndex).padStart(2, "0")}`;
}

/**
 * 8 近傍のセル番号を**方向順**(N..NW)で返す。盤外は除外する。
 * 横方向の回り込み(x が 0 の W が前行末尾になる等)は起こらない。
 */
export function neighborCellIndices(cellIndex: number): readonly number[] {
  requireCellIndex(cellIndex);
  const x = cellIndex % GRID_WIDTH;
  const y = (cellIndex - x) / GRID_WIDTH;
  const result: number[] = [];
  for (const offset of NEIGHBOR_OFFSETS) {
    const nx = x + offset[0];
    const ny = y + offset[1];
    if (nx < 0 || nx >= GRID_WIDTH || ny < 0 || ny >= GRID_HEIGHT) continue;
    result.push(ny * GRID_WIDTH + nx);
  }
  return result;
}

// --- 2. 行列 ---------------------------------------------------------------

/**
 * 効果の種類。T5 の縮約では**乗算の産出補正のみ**を実装する。
 *
 * content 側(`adjacency.json`)の `effect` は自由文字列(`forgeYield` /
 * `efficiency` 等・GDD 6.2 の効果表に対応)であり、そこから engine の効果種へ
 * 写すのは content ロード側の責務。写せない効果(健康 -15%/tick 等)は
 * 黙って無視せず**ロード時に reject** すること(engine 側で受け取ってから
 * 捨てると、効いていない content が sim を通ってしまう)。
 */
export type AdjacencyEffectKind = "yieldMul";

/**
 * 効果の適用先。content の `target`(GDD 6.2 では「鍛冶加工」「食料」等)を
 * engine で解決可能な 3 形へ縮約したもの。
 *   any        : 全施設に適用
 *   facilityDef: 特定の施設定義にのみ適用(例 target="forge")
 *   tag        : そのタグを持つ施設に適用(例 target="heat" = 熱源施設の効率)
 */
export type AdjacencyTarget =
  | { readonly kind: "any" }
  | { readonly kind: "facilityDef"; readonly defId: string }
  | { readonly kind: "tag"; readonly tag: Tag };

/** タグペア 1 組の効果。`valueFix` は乗数への**加算**分(+0.2 = +20%)。 */
export interface TagPairEffect {
  readonly effect: AdjacencyEffectKind;
  readonly target: AdjacencyTarget;
  readonly valueFix: Fix;
}

/** 過密パラメータ(`adjacency.json` の overcrowd)。 */
export interface OvercrowdParams {
  /** 同一タグが 8 近傍にこの数以上でボーナス無効化 + ペナ(GDD 6.3: 3)。 */
  readonly threshold: number;
  /** 超過 1 施設あたりのペナルティ。負値(GDD 6.3: -0.10)。 */
  readonly penaltyPerExcessFix: Fix;
  /** ペナルティの対称クランプ幅(絶対値。`adjacency.json` clampFP: 0.6)。 */
  readonly clampFix: Fix;
}

/** シード揺らぎのレンジ(`adjacency.json` seedOffsetRange)。 */
export interface SeedOffsetRange {
  readonly minFix: Fix;
  readonly maxFix: Fix;
}

/**
 * タグペア 1 エントリ。`tagA`/`tagB` の順序は問わない(対称行列なので
 * {@link tagPairKey} が正準形へ畳む)。
 */
export interface AdjacencyPairEntry {
  readonly tagA: Tag;
  readonly tagB: Tag;
  readonly effect: TagPairEffect;
}

/**
 * 正準化済みの隣接行列(engine の内部表現)。キーは {@link tagPairKey}。
 * Map の反復順はキーの UTF-16 コードユニット昇順(正準順)。
 */
export interface AdjacencyMatrix {
  readonly pairEffects: ReadonlyMap<string, TagPairEffect>;
  readonly overcrowd: OvercrowdParams;
  /** null なら揺らぎ無し(`applySeedOffsets` は恒等になる)。 */
  readonly seedOffset: SeedOffsetRange | null;
}

/** セル番号 → そのセルに建っている施設のタグ列(タグは宣言順)。 */
export type CellOccupancy = ReadonlyMap<number, readonly Tag[]>;

/**
 * GDD 6.3(d): 全ボーナス加算後の単一係数クランプ幅 ±60%。
 * content 側(`adjacency.json`)には過密ペナ用の clampFP しか無いため、
 * ボーナス側のクランプ幅は engine 定数として持つ。
 */
export const ADJACENCY_BONUS_CLAMP_FIX = fixFromRaw(600_000);

/**
 * 1 タグペアの係数の絶対値上限(人間単位 2.0)。
 *
 * ボーナス合計が ±60% でクランプされる以上、単一ペアが 2.0 を超える意味は無い。
 * この上限を**構成時に強制**することで、{@link applySeedOffsets} と
 * {@link computeCellAdjacency} 内の乗算に対する値域証明の根拠(fp.ts §4 の
 * 「clamp / 型不変条件」)が成立する:
 *   |valueFix| <= 2e6 かつ |1 + offset| <= 2e6 ⇒ 中間積 <= 4e12 < 2^53-1
 * ゆえ {@link mulFixProven}(number 固定・BigInt へ落ちない)が使える。
 */
export const ADJACENCY_PAIR_VALUE_ABS_MAX = 2_000_000;

/**
 * タグペアの正準キー。対称行列なのでタグ 2 つを**昇順に並べて** `"a|b"` にする。
 * content 側(`schema/adjacency.ts`)も同じ正準形(tagA <= tagB)のキーだけを
 * 受け付けるので、JSON のキーと engine のキーは一致する。
 */
export function tagPairKey(a: Tag, b: Tag): string {
  return compareUtf16(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
}

function requirePairValue(effect: TagPairEffect, key: string): void {
  const raw = toRaw(effect.valueFix);
  if (raw > ADJACENCY_PAIR_VALUE_ABS_MAX || raw < -ADJACENCY_PAIR_VALUE_ABS_MAX) {
    throw new AdjacencyError(
      `タグペア "${key}" の係数 ${String(raw)} が上限 ±${String(ADJACENCY_PAIR_VALUE_ABS_MAX)} を超えている` +
        `(fp.ts §4 の値域証明の前提。緩めるなら mulFixProven を mulFix へ戻すこと)`,
    );
  }
}

/**
 * 隣接行列を作る唯一の入口。エントリの並び順に依らずキー昇順の Map になる。
 *
 * @throws {AdjacencyError} 同じタグペアが 2 度出てくる場合(逆順表記の重複も
 *   正準キーで検出する)、係数が上限超過、threshold / ペナ / クランプが不正な場合
 */
export function createAdjacencyMatrix(input: {
  readonly pairs: readonly AdjacencyPairEntry[];
  readonly overcrowd: OvercrowdParams;
  readonly seedOffset: SeedOffsetRange | null;
}): AdjacencyMatrix {
  const { overcrowd, seedOffset } = input;
  if (!Number.isSafeInteger(overcrowd.threshold) || overcrowd.threshold < 1) {
    throw new AdjacencyError(`overcrowd.threshold ${String(overcrowd.threshold)} は 1 以上の整数`);
  }
  if (toRaw(overcrowd.penaltyPerExcessFix) > 0) {
    throw new AdjacencyError(
      `overcrowd.penaltyPerExcessFix ${String(toRaw(overcrowd.penaltyPerExcessFix))} はペナルティ(0 以下)`,
    );
  }
  if (toRaw(overcrowd.clampFix) < 0) {
    throw new AdjacencyError(`overcrowd.clampFix は絶対値(0 以上)で指定する`);
  }
  if (seedOffset !== null && toRaw(seedOffset.minFix) > toRaw(seedOffset.maxFix)) {
    throw new AdjacencyError(`seedOffsetRange の min が max を超えている`);
  }

  const sorted = [...input.pairs].sort((l, r) =>
    compareUtf16(tagPairKey(l.tagA, l.tagB), tagPairKey(r.tagA, r.tagB)),
  );
  const pairEffects = new Map<string, TagPairEffect>();
  for (const entry of sorted) {
    const key = tagPairKey(entry.tagA, entry.tagB);
    if (pairEffects.has(key)) {
      throw new AdjacencyError(
        `タグペア "${key}" が重複している(対称行列なので "a|b" と "b|a" は同一エントリ)`,
      );
    }
    requirePairValue(entry.effect, key);
    pairEffects.set(key, entry.effect);
  }
  return { pairEffects, overcrowd, seedOffset };
}

/**
 * タグペア係数へ周回固定のシード揺らぎ(§4)を焼き込んだ行列を返す。
 * `seedOffset` が null の場合は入力をそのまま返す(参照同一)。
 *
 * 揺らぎ後の係数も ±{@link ADJACENCY_PAIR_VALUE_ABS_MAX} を超えない
 * (|value| <= 2e6 かつ (1+offset) <= 1 + max であり、max <= 1 を schema が
 * 保証する = 高々 2 倍だが、超過時は下の requirePairValue が止める)。
 */
export function applySeedOffsets(matrix: AdjacencyMatrix, worldSeedU32: number): AdjacencyMatrix {
  const range = matrix.seedOffset;
  if (range === null) return matrix;

  const next = new Map<string, TagPairEffect>();
  for (const [key, effect] of matrix.pairEffects) {
    const draw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.adjacency, [fnv1a32(key)]);
    const offset = uniformFixFromDraw(draw, range.minFix, range.maxFix);
    // 値域証明: |valueFix| <= 2e6(構成時に強制)、|1 + offset| <= 2e6
    // (offset は seedOffsetRange 内 = schema が ±1 に制限)ゆえ中間積 <= 4e12。
    const scaled: TagPairEffect = {
      effect: effect.effect,
      target: effect.target,
      valueFix: mulFixProven(effect.valueFix, addFix(FIX_ONE, offset)),
    };
    requirePairValue(scaled, key);
    next.set(key, scaled);
  }
  return { pairEffects: next, overcrowd: matrix.overcrowd, seedOffset: range };
}

// --- 3. セル単位の計算 -----------------------------------------------------

/** 乗数の計算対象になる施設の素性(rules 側から渡す最小の情報)。 */
export interface AdjacencySubject {
  readonly cellIndex: number;
  readonly defId: string;
  readonly tags: readonly Tag[];
}

/** {@link computeCellAdjacency} の結果。内訳ビュー(GDD 6.5)にそのまま使える。 */
export interface CellAdjacencyResult {
  /** ボーナス加算合計を ±60% にクランプした値。 */
  readonly bonusFix: Fix;
  /** 過密ペナルティ(clampFP でクランプ済み・0 以下)。 */
  readonly overcrowdPenaltyFix: Fix;
  /** 産出に掛ける乗数 = max(0, 1 + bonus + penalty)。 */
  readonly multiplierFix: Fix;
  /** 過密でボーナスが無効化された近傍の件数(タグ横断の合計・可視化用)。 */
  readonly overcrowdedNeighborCount: number;
}

function effectApplies(target: AdjacencyTarget, subject: AdjacencySubject): boolean {
  switch (target.kind) {
    case "any":
      return true;
    case "facilityDef":
      return target.defId === subject.defId;
    case "tag":
      return subject.tags.includes(target.tag);
    default: {
      const unhandled: never = target;
      throw new AdjacencyError(`未知の target 種別 ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * 1 施設(= 1 セル)の隣接ボーナス・過密ペナルティ・最終乗数を計算する。
 * 依存は自セルと 8 近傍のみ(§2 の O(8) 上界)。
 *
 * 手順は GDD 6.3 のとおり:
 *   1. 8 近傍を方向順で列挙し、タグ単位に「そのタグを持つ近傍セル」を集める
 *   2. 各タグについてセルID 辞書順へ再ソートし、先頭 (threshold-1) 件のみ
 *      ボーナス有効、残りは無効化して超過数 × penaltyPerExcess を積む
 *   3. 有効な近傍 × 自セルのタグの全組合せでタグペア効果を引き、
 *      target が自施設に当たるものだけ加算する
 *   4. ボーナス合計を ±60% にクランプ、ペナは別途 ±clampFP にクランプして加算
 */
export function computeCellAdjacency(
  matrix: AdjacencyMatrix,
  occupancy: CellOccupancy,
  subject: AdjacencySubject,
): CellAdjacencyResult {
  const neighbors = neighborCellIndices(subject.cellIndex);

  // 1. タグ単位の独立集計(GDD 6.3(b))。方向順のまま積む。
  const cellsByTag = new Map<Tag, number[]>();
  for (const neighborIndex of neighbors) {
    const tags = occupancy.get(neighborIndex);
    if (tags === undefined) continue;
    for (const tag of tags) {
      const bucket = cellsByTag.get(tag);
      if (bucket === undefined) {
        cellsByTag.set(tag, [neighborIndex]);
      } else {
        bucket.push(neighborIndex);
      }
    }
  }

  const bonusTerms: Fix[] = [];
  let penaltyRaw = 0;
  let overcrowdedNeighborCount = 0;
  const effectiveLimit = matrix.overcrowd.threshold - 1;

  // ADJACENCY_TAGS の宣言順に走ることで、加算順序が occupancy の反復順に
  // 依存しない(GDD 11.7)。
  for (const tag of ADJACENCY_TAGS) {
    const bucket = cellsByTag.get(tag);
    if (bucket === undefined) continue;

    // GDD 6.3(c): 方向順に列挙した後、セルID 辞書順へ再ソートして先頭のみ有効。
    const ordered = [...bucket].sort((l, r) => compareUtf16(cellIdOf(l), cellIdOf(r)));
    const effectiveCount = ordered.length < effectiveLimit ? ordered.length : effectiveLimit;
    const excess = ordered.length - effectiveCount;
    overcrowdedNeighborCount += excess;
    penaltyRaw += toRaw(matrix.overcrowd.penaltyPerExcessFix) * excess;

    for (let i = 0; i < effectiveCount; i++) {
      for (const selfTag of subject.tags) {
        const effect = matrix.pairEffects.get(tagPairKey(selfTag, tag));
        if (effect === undefined) continue;
        if (!effectApplies(effect.target, subject)) continue;
        bonusTerms.push(effect.valueFix);
      }
    }
  }

  const bonusFix = clampFix(
    sumFix(bonusTerms),
    negFix(ADJACENCY_BONUS_CLAMP_FIX),
    ADJACENCY_BONUS_CLAMP_FIX,
  );
  const clampRaw = toRaw(matrix.overcrowd.clampFix);
  const overcrowdPenaltyFix = clampFix(fixFromRaw(penaltyRaw), fixFromRaw(-clampRaw), FIX_ZERO);
  const multiplierFix = maxFix(FIX_ZERO, addFix(addFix(FIX_ONE, bonusFix), overcrowdPenaltyFix));

  return { bonusFix, overcrowdPenaltyFix, multiplierFix, overcrowdedNeighborCount };
}

/**
 * 複数施設分の乗数をまとめて計算する(1 回の advance の開始時に一度だけ・§2)。
 * 戻り値のキーは呼び出し側が渡した識別子(施設 entity の ID)。
 *
 * 配置(occupancy)が変わったら作り直すこと。advance の途中で配置は変わらない
 * (配置変更は Command 経路であり T5 のスコープ外)という前提に立っている。
 */
export function computeFacilityMultipliers<K>(
  matrix: AdjacencyMatrix,
  occupancy: CellOccupancy,
  subjects: ReadonlyMap<K, AdjacencySubject>,
): ReadonlyMap<K, Fix> {
  const result = new Map<K, Fix>();
  for (const [id, subject] of subjects) {
    result.set(id, computeCellAdjacency(matrix, occupancy, subject).multiplierFix);
  }
  return result;
}
