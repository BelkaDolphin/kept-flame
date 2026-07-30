// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- タグ7種の4重符号化データ (M19)
//
// `docs/design/tags-spec.md` §8.3 の機械可読 JSON を TypeScript へ**そのまま
// 転記**したものである。数値・パス・パターン定義は spec の値を1文字も変えていない
// (CLAUDE.md 絶対ルール「tags-spec の色値を勝手に変えない」)。spec を変える必要を
// 感じた場合はここを直さず、まず spec 側の改訂とユーザー承認を得ること。
//
// このファイルは**データだけ**を持つ(描画は TagIcons.tsx / TagChip.tsx /
// GridBoard.tsx)。gridConstants.ts と同じ「実機待ちの値を1箇所に隔離する」規律を
// 踏襲し、LOD(段階的劣化)の閾値・マーカーサイズ計算式もここへ集約する。
// ---------------------------------------------------------------------------

import { ADJACENCY_TAGS, type Tag } from "../../../engine/adjacency";
import { CELL_SIZE_PX } from "./gridConstants";

// --- 1. 色(spec §2.1 / §8.3 surfaces・neutrals・tags[].ink/tint) -------------

export interface TagVisual {
  readonly id: Tag;
  readonly ja: string;
  readonly ink: string;
  readonly tint: string;
  /** 相対輝度 Y(spec §1・参考値。描画には使わない)。 */
  readonly relLuminance: number;
  /** 輪郭クラス名(spec §4.5)。色を除去しても弁別できる形の名前。 */
  readonly silhouette: string;
  /** full/mini 共通のパス(`M...Z` 等)。noise のみ複数パーツを持つため個別に持つ。 */
  readonly full: {
    readonly d: string;
    readonly fill: "ink" | "pattern" | "none";
    readonly strokeWidthU: number | null;
  };
  readonly mini: {
    readonly d: string;
    readonly fill: "ink" | "none";
    readonly fillRule?: "evenodd";
  };
  /** noise だけが持つ中心点(円)。spec §5.3 noise 参照。 */
  readonly circles?: {
    readonly full: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
    readonly mini: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
  };
  /** パターン ID(`kf-pat-*`)。`null` = パターン無し(heat=ベタ塗り・clean/noise=無地)。 */
  readonly patternId: string | null;
}

/** spec §8.3 `surfaces`。 */
export const SURFACE_COLORS = {
  page: "#FFFFFF",
  cell: "#FAF8F5",
  cellSelected: "#FCEFD0",
  previewAdd: "#EDF3EA",
  previewSub: "#F7ECEB",
  rubble: "#F0EDE7",
} as const;

/** spec §8.3 `neutrals`。 */
export const NEUTRAL_COLORS = {
  inkBody: "#24201C",
  inkMuted: "#5B534B",
  lineGrid: "#8A857D",
  lineRubble: "#7E796F",
} as const;

/** spec §8.3 `tags[]`(色/記号/パターンの正本)。宣言順は `ADJACENCY_TAGS` と揃える。 */
export const TAG_VISUALS: { readonly [K in Tag]: TagVisual } = {
  heat: {
    id: "heat",
    ja: "熱源",
    ink: "#8C290B",
    tint: "#FAEDEA",
    relLuminance: 0.07185,
    silhouette: "triangleUp",
    full: { d: "M12 2.8 L21.2 20.4 L2.8 20.4 Z", fill: "ink", strokeWidthU: null },
    mini: { d: "M12 2.8 L21.2 20.4 L2.8 20.4 Z", fill: "ink" },
    patternId: null,
  },
  clean: {
    id: "clean",
    ja: "清浄",
    ink: "#076F5A",
    tint: "#D9F6F0",
    relLuminance: 0.12152,
    silhouette: "doubleRing",
    full: {
      d: "M3.8 12a8.2 8.2 0 1 0 16.4 0a8.2 8.2 0 1 0 -16.4 0 M8.8 12a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0",
      fill: "none",
      strokeWidthU: 2.5,
    },
    mini: { d: "M4.5 12a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0 -15 0", fill: "none" },
    patternId: null,
  },
  foul: {
    id: "foul",
    ja: "汚染",
    ink: "#35240F",
    tint: "#F8EEE3",
    relLuminance: 0.02053,
    silhouette: "triangleDown",
    full: { d: "M3.6 4.4 L20.4 4.4 L12 20.4 Z", fill: "pattern", strokeWidthU: 2.5 },
    mini: { d: "M2.8 4.4 L21.2 4.4 L12 21.2 Z", fill: "ink" },
    patternId: "kf-pat-foul",
  },
  noise: {
    id: "noise",
    ja: "騒音",
    ink: "#671B75",
    tint: "#F8EDFA",
    relLuminance: 0.04952,
    silhouette: "arcFan",
    full: {
      d: "M8.33 9.17 A4 4 0 0 1 8.33 14.83 M11.16 6.34 A8 8 0 0 1 11.16 17.66 M13.99 3.51 A12 12 0 0 1 13.99 20.49",
      fill: "none",
      strokeWidthU: 2.5,
    },
    mini: { d: "M12.36 5.64 A9 9 0 0 1 12.36 18.36", fill: "none" },
    circles: {
      full: [{ cx: 5.5, cy: 12, r: 2 }],
      mini: [{ cx: 6, cy: 12, r: 2.8 }],
    },
    patternId: null,
  },
  damp: {
    id: "damp",
    ja: "湿潤",
    ink: "#1942E5",
    tint: "#EDEFFA",
    relLuminance: 0.0976,
    silhouette: "droplet",
    full: {
      d: "M12 2.6 C15.4 7.8 19.4 11.2 19.4 13.6 A7.4 7.4 0 1 1 4.6 13.6 C4.6 11.2 8.6 7.8 12 2.6 Z",
      fill: "pattern",
      strokeWidthU: 2.2,
    },
    mini: {
      d: "M12 2.6 C15.4 7.8 19.4 11.2 19.4 13.6 A7.4 7.4 0 1 1 4.6 13.6 C4.6 11.2 8.6 7.8 12 2.6 Z",
      fill: "ink",
    },
    patternId: "kf-pat-damp",
  },
  calm: {
    id: "calm",
    ja: "静穏",
    ink: "#2D333E",
    tint: "#EEF0F4",
    relLuminance: 0.03273,
    silhouette: "stadiumH",
    full: {
      d: "M7.8 7.6 H16.2 A4.4 4.4 0 0 1 16.2 16.4 H7.8 A4.4 4.4 0 0 1 7.8 7.6 Z",
      fill: "pattern",
      strokeWidthU: 2.4,
    },
    mini: {
      d: "M7.8 7.6 H16.2 A4.4 4.4 0 0 1 16.2 16.4 H7.8 A4.4 4.4 0 0 1 7.8 7.6 Z",
      fill: "ink",
    },
    patternId: "kf-pat-calm",
  },
  lore: {
    id: "lore",
    ja: "学芸",
    ink: "#975D0C",
    tint: "#F8EFE2",
    relLuminance: 0.14435,
    silhouette: "diamond",
    full: { d: "M12 2.8 L21.2 12 L12 21.2 L2.8 12 Z", fill: "pattern", strokeWidthU: 2.5 },
    mini: {
      d: "M12 2.8 L21.2 12 L12 21.2 L2.8 12 Z M12 8.6 L15.4 12 L12 15.4 L8.6 12 Z",
      fill: "ink",
      fillRule: "evenodd",
    },
    patternId: "kf-pat-lore",
  },
};

/** 宣言順で並んだタグ一覧(engine の `ADJACENCY_TAGS` と同一順序・GDD 11.7)。 */
export const TAG_VISUAL_LIST: readonly TagVisual[] = ADJACENCY_TAGS.map((tag) => TAG_VISUALS[tag]);

// --- 2. パターン定義(spec §5.4 / §8.3 patterns) ------------------------------

export interface PatternDef {
  readonly id: string;
  readonly tileU: readonly [number, number];
  readonly strokeU: number;
  readonly d: string;
  /** foul だけ千鳥ドット(パスでなく円2個)。 */
  readonly circles?: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
}

export const PATTERN_DEFS: readonly PatternDef[] = [
  {
    id: "kf-pat-foul",
    tileU: [3.6, 3.6],
    strokeU: 0, // ドットは stroke でなく fill(circle)。
    d: "",
    circles: [
      { cx: 0.9, cy: 0.9, r: 1.05 },
      { cx: 2.7, cy: 2.7, r: 1.05 },
    ],
  },
  { id: "kf-pat-damp", tileU: [6.0, 5.5], strokeU: 1.6, d: "M0 2.75 q1.5 -1.9 3 0 t3 0" },
  { id: "kf-pat-calm", tileU: [6.5, 6.5], strokeU: 1.6, d: "M3.25 0 V6.5" },
  {
    id: "kf-pat-lore",
    tileU: [8.0, 8.0],
    strokeU: 1.3,
    d: "M0 8 L8 0 M-1 1 L1 -1 M7 9 L9 7 M0 0 L8 8 M-1 7 L1 9 M7 -1 L9 1",
  },
];

/** spec §6.1: チップ(44px)ではパターン線幅を 1.3u → 1.4u へ引き上げる。 */
export const PATTERN_MIN_STROKE_U = 1.3;
export const PATTERN_CHIP_OVERRIDE_STROKE_U = 1.4;

// --- 3. 記号ストローク幅(spec §5.2) -----------------------------------------

export const FULL_SYMBOL_STROKE_U = 2.5;
export const MINI_SYMBOL_STROKE_U = 4.0;

// --- 4. LOD(ピンチ縮小時の劣化戦略・spec §7) ---------------------------------

export type LodTierId = "L1" | "L2" | "L3" | "L4" | "L5";

export interface LodTier {
  readonly id: LodTierId;
  readonly minPx: number;
  readonly maxPx: number;
  readonly symbol: "full" | "mini" | "none";
  readonly pattern: boolean;
  readonly numeral: boolean;
  readonly channels: number;
}

/** spec §7.2 / §8.3 `lod.tiers`。降順(大きい方から)で並べ、`computeLodTier` が上から順に当てる。 */
export const LOD_TIERS: readonly LodTier[] = [
  { id: "L1", minPx: 24, maxPx: 26, symbol: "full", pattern: true, numeral: true, channels: 4 },
  { id: "L2", minPx: 20, maxPx: 23, symbol: "full", pattern: true, numeral: false, channels: 3 },
  { id: "L3", minPx: 15, maxPx: 19, symbol: "full", pattern: false, numeral: false, channels: 2 },
  { id: "L4", minPx: 9, maxPx: 14, symbol: "mini", pattern: false, numeral: false, channels: 2 },
  { id: "L5", minPx: 0, maxPx: 8, symbol: "none", pattern: false, numeral: false, channels: 1 },
];

/** マーカーの最小/最大 CSS px(spec §7.1 の clamp 境界。**表示サイズ**の境界)。 */
export const MARKER_MIN_PX = 9;
export const MARKER_MAX_PX = 26;

/**
 * spec §7.1: `markerPx = clamp(round(0.273 * cellPx), 9, 26)`、`cellPx = 44 * zoom`。
 *
 * **[M19 設計判断・重要]** spec の式をそのまま「クランプ後の値で LOD 段も決める」
 * 実装にすると **L5(§7.2: markerPx 0〜8・記号撤去)が構造的に到達不能になる**
 * ——クランプの下限が 9 なので、クランプ後の値は絶対に 9 を下回らない。
 * spec §7.4 の「S<9px ではマーカーを撤去し中央下に5pxドットを置く」という
 * 記述と、§7.3 の「zoom<0.708 で L5」という記述は、**クランプ前の値**で
 * 判定しているとしか整合しない(§7.1 の clamp はあくまで「実際に記号を描画する
 * ときの表示サイズ」の境界であり、LOD 段の判定式ではない、と読む)。
 * そのため本実装は次の2関数に分離する:
 *   - {@link computeRawMarkerPx}: クランプ前(LOD 段の判定に使う)
 *   - {@link computeDisplayMarkerPx}: クランプ後(実際に `<svg>` へ渡すサイズ)
 *
 * また、spec はセル基準サイズ 44px を前提にしているが、M18 の
 * `gridConstants.ts` は `CELL_SIZE_PX = 56`(実機 #9b 待ちの暫定値)を採用済みで
 * ある。ここでは 44 を固定リテラルで使わず **`CELL_SIZE_PX` を基準にして同じ比率
 * (0.273 = 12/44)を保つ**(マーカーがセルに占める面積比を一定にする設計意図の
 * 一般化)。`CELL_SIZE_PX` を実機計測で差し替えれば、この関数も追随する
 * (gridConstants.ts の「定数1箇所」規律をそのまま踏襲)。
 *
 * ★要ユーザー判断(最終報告に転記): 上記は spec の字面から読み取れる唯一の
 * 無矛盾な解釈だと考えるが、spec 自体は「クランプ前/後どちらで LOD を判定
 * するか」を明記していない。実機計測(#9b)後に spec 側へこの解釈を明文化する
 * ことを推奨する。
 */
export function computeRawMarkerPx(scale: number): number {
  const cellPx = CELL_SIZE_PX * scale;
  return Math.round(0.273 * cellPx);
}

/** クランプ後の表示サイズ(実際に `<svg width/height>` へ渡す値)。 */
export function computeDisplayMarkerPx(rawMarkerPx: number): number {
  if (rawMarkerPx < MARKER_MIN_PX) return MARKER_MIN_PX;
  if (rawMarkerPx > MARKER_MAX_PX) return MARKER_MAX_PX;
  return rawMarkerPx;
}

/**
 * クランプ**前**の raw markerPx から LOD 段を引く(§ の設計判断参照)。
 * L1/L5 は表の上端/下端を超えて延長する(zoom がさらに動いても段が変わらない
 * ことを保証する。spec §7.3「zoom≥2.123で26pxに張り付く」に対応)。
 */
export function computeLodTier(rawMarkerPx: number): LodTier {
  if (rawMarkerPx >= 24) return requireTier("L1");
  if (rawMarkerPx >= 20) return requireTier("L2");
  if (rawMarkerPx >= 15) return requireTier("L3");
  if (rawMarkerPx >= 9) return requireTier("L4");
  return requireTier("L5");
}

function requireTier(id: LodTierId): LodTier {
  const tier = LOD_TIERS.find((t) => t.id === id);
  if (tier === undefined) throw new Error(`tagVisuals: LOD tier "${id}" が無い(内部不整合)`);
  return tier;
}

// --- 5. 非スケーリング要素(spec §7.4 / §8.3 `lod.nonScalingMinPx`) -----------

export const NON_SCALING_MIN_PX = {
  overcrowdBadge: 12,
  focusRing: 3,
  selectedBorder: 2,
} as const;

/** マーカー間ガター(spec §3.3 / §8.3 `lod.markerGutterPx`)。 */
export const MARKER_GUTTER_PX = 2;

/** 1 セルに個別マーカーを描く上限(spec §6.4: 先頭2個 + `+n` バッジ)。 */
export const MAX_INLINE_MARKERS = 2;

// --- 6. タイポグラフィ(spec §6.3 / §8.3 typography) --------------------------

export const TYPOGRAPHY = {
  stack:
    'system-ui, -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif',
  chipNumeralPx: 13,
  chipNumeralWeight: 700,
  cellNumeralPx: 11,
  cellNumeralWeight: 700,
  legendLabelPx: 13,
  legendLabelWeight: 500,
  legendNotePx: 12,
  legendNoteWeight: 400,
} as const;

// --- 7. 数値チャネル(spec §6.2 / §9-7 W4裁定) --------------------------------

/** チップ/セル内マーカーは常に ±60(engine の ADJACENCY_BONUS_CLAMP_FIX)クランプ後。 */
export const CHIP_DISPLAY_CLAMP_PCT = 60;

/** 凡例パネルの文言用(GDD 6.3 裁定N2: ±60%は engine 定数)。 */
export const ADJACENCY_BONUS_CLAMP_PCT_NOTE = `±${String(CHIP_DISPLAY_CLAMP_PCT)}%`;

/**
 * bonus 係数(Fix の近似値・-1〜1 レンジの小数)を「符号+2桁」の表示文字列にする。
 * 値が 0 でも `"0"` を表示する(spec §6.2「空欄はチャネル欠落を意味する」)。
 */
export function formatBonusPercent(bonusApprox: number): string {
  const pct = Math.round(bonusApprox * 100);
  const clamped =
    pct > CHIP_DISPLAY_CLAMP_PCT
      ? CHIP_DISPLAY_CLAMP_PCT
      : pct < -CHIP_DISPLAY_CLAMP_PCT
        ? -CHIP_DISPLAY_CLAMP_PCT
        : pct;
  if (clamped === 0) return "0";
  return clamped > 0 ? `+${String(clamped)}` : String(clamped);
}

/** 過密表示(spec §6.2: `x3` 形式・非負整数)。 */
export function formatOvercrowdCount(count: number): string {
  return `x${String(count)}`;
}

/**
 * 内訳ビュー専用の数値表示(spec §9-7 解消済み: 内訳ビューは44pxチップの
 * 桁数制約を受けない)。クランプ前の生係数を小数第1位まで表示する。
 * 0 でも `"0.0%"` を表示する(チップと同じ「空欄禁止」規約)。
 */
export function formatRawPercent(approx: number): string {
  const pct = Math.round(approx * 1000) / 10;
  if (pct === 0) return "0.0%";
  return pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}
