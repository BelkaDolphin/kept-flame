// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- タグ記号の SVG スプライト + 描画コンポーネント (M19)
//
// `docs/design/tags-spec.md` §5(作図仕様)をそのまま実装する。パス・パターンの
// 座標値は tagVisuals.ts(spec §8.3 の転記)から読む——ここには意匠の**組み立て**
// だけを置く。
//
// 構成(spec §5.1):
//   - `TagIconDefs`: 文書に1個だけ置く隠し `<svg>`(`width=0 height=0
//     aria-hidden="true"`)。7 タグ × full/mini の `<symbol>` + パターン4種の
//     `<pattern>` を `<defs>` に持つ。
//   - `TagSymbol`: `<use href="#kf-tag-<id>-<variant>">` で参照するだけの薄い
//     コンポーネント。
//
// パターンの「地に tint を敷いてからパターンを重ねる」規約(spec §5.4 末尾)は
// symbol 定義の中に**焼き込む**(呼び出し側が2層を意識しなくて済むように)。
//
// lore だけ、44px チップではパターン線幅を 1.3u→1.4u へ引き上げる特例
// (spec §6.1)があるため、lore の full 記号だけ通常用/チップ用の2バリアントを
// 持つ(他6種はチップでも通常パターンのままで 1.5px 判読要件を満たす・
// tagVisuals.ts の PATTERN_CHIP_OVERRIDE_STROKE_U のコメント参照)。
// ---------------------------------------------------------------------------

import { ADJACENCY_TAGS, type Tag } from "../../../engine/adjacency";
import {
  MINI_SYMBOL_STROKE_U,
  PATTERN_CHIP_OVERRIDE_STROKE_U,
  PATTERN_DEFS,
  TAG_VISUALS,
  type TagVisual,
} from "./tagVisuals";

/** `<use>` が参照する symbol の id(通常用)。 */
export function tagSymbolId(tag: Tag, variant: "full" | "mini"): string {
  return `kf-tag-${tag}-${variant}`;
}

/** lore の full だけが持つチップ専用 symbol の id(spec §6.1 の線幅オーバーライド)。 */
export const LORE_CHIP_SYMBOL_ID = "kf-tag-lore-full-chip";

function patternId(tag: Tag): string | null {
  return TAG_VISUALS[tag].patternId;
}

/** 1 個のパターン `<pattern>` 要素(通常線幅)。 */
function PatternDef({ id, tag }: { readonly id: string; readonly tag: Tag }) {
  const def = PATTERN_DEFS.find((p) => p.id === id);
  if (def === undefined) throw new Error(`TagIcons: パターン定義 "${id}" が無い`);
  const ink = TAG_VISUALS[tag].ink;
  return (
    <pattern id={id} patternUnits="userSpaceOnUse" width={def.tileU[0]} height={def.tileU[1]}>
      {def.circles !== undefined ? (
        def.circles.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={ink} />)
      ) : (
        <path d={def.d} stroke={ink} stroke-width={def.strokeU} fill="none" />
      )}
    </pattern>
  );
}

/** lore 専用: チップ用の線幅オーバーライド版パターン。 */
function LoreChipPatternDef() {
  const def = PATTERN_DEFS.find((p) => p.id === "kf-pat-lore");
  if (def === undefined) throw new Error("TagIcons: kf-pat-lore が無い");
  return (
    <pattern
      id="kf-pat-lore--chip"
      patternUnits="userSpaceOnUse"
      width={def.tileU[0]}
      height={def.tileU[1]}
    >
      <path
        d={def.d}
        stroke={TAG_VISUALS.lore.ink}
        stroke-width={PATTERN_CHIP_OVERRIDE_STROKE_U}
        fill="none"
      />
    </pattern>
  );
}

/**
 * 1 タグの `full`/`mini` symbol。`fill: "pattern"` のタグは
 * tint ベタ塗り(背後)+ パターン(前面)の2層を1つの symbol に焼き込む
 * (spec §5.4 末尾「パターンの背後には必ず tint のベタ塗りを敷く」)。
 *
 * @param patternOverrideId lore のチップ用 full だけ渡す(§6.1)。
 */
function TagSymbolDefs({
  visual,
  patternOverrideId,
}: {
  readonly visual: TagVisual;
  readonly patternOverrideId?: string;
}) {
  const fullPatternRef = patternOverrideId ?? visual.patternId;
  const fullSymbolId =
    patternOverrideId !== undefined ? LORE_CHIP_SYMBOL_ID : tagSymbolId(visual.id, "full");

  return (
    <>
      <symbol id={fullSymbolId} viewBox="0 0 24 24">
        {visual.full.fill === "ink" && <path d={visual.full.d} fill={visual.ink} stroke="none" />}
        {visual.full.fill === "none" && (
          <>
            {visual.circles?.full.map((c, i) => (
              <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={visual.ink} />
            ))}
            <path
              d={visual.full.d}
              fill="none"
              stroke={visual.ink}
              stroke-width={visual.full.strokeWidthU ?? undefined}
            />
          </>
        )}
        {visual.full.fill === "pattern" && fullPatternRef !== null && (
          <>
            {/* 背後: tint ベタ塗り(spec §5.4 末尾)。 */}
            <path d={visual.full.d} fill={visual.tint} stroke="none" />
            {/* 前面: パターン + ink 輪郭。 */}
            <path
              d={visual.full.d}
              fill={`url(#${fullPatternRef})`}
              stroke={visual.ink}
              stroke-width={visual.full.strokeWidthU ?? undefined}
            />
          </>
        )}
      </symbol>
      {/* mini は通常版のみ(チップ専用バリアントは無い・full のみ §6.1 の対象)。 */}
      {patternOverrideId === undefined && (
        <symbol id={tagSymbolId(visual.id, "mini")} viewBox="0 0 24 24">
          {visual.circles?.mini.map((c, i) => (
            <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={visual.ink} />
          ))}
          <path
            d={visual.mini.d}
            fill={visual.mini.fill === "ink" ? visual.ink : "none"}
            fill-rule={visual.mini.fillRule}
            stroke={visual.mini.fill === "none" ? visual.ink : "none"}
            stroke-width={visual.mini.fill === "none" ? MINI_SYMBOL_STROKE_U : undefined}
          />
        </symbol>
      )}
    </>
  );
}

// clean の mini は fill:"none"(太線のみ)なので stroke-width が要る(spec §5.3 clean mini: strokeWidthU 4.0)。
// mini バリアントは全種 4.0u 固定。

/**
 * 文書に1個だけ置く隠しスプライト(spec §5.1)。
 *
 * 複数箇所(GridBoard / LegendPanel / CellBreakdownView)が同時にマウントされる
 * 構成(M30 以降の画面合成)では、このコンポーネントは**そのうち1箇所だけ**が
 * レンダーすればよい(`<use>` は文書内の最初に一致する id を解決するため、
 * 重複してマウントされても実害は無いが冗長)。M19 時点では各コンポーネントが
 * 単体でテスト・bench できるよう、既定で自前に含める設計にしてある
 * (各コンポーネントの `includeIconDefs` prop 参照)。
 */
export function TagIconDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style="position:absolute">
      <defs>
        {PATTERN_DEFS.map((def) => {
          const tag = ADJACENCY_TAGS.find((t) => patternId(t) === def.id);
          if (tag === undefined) return null;
          return <PatternDef key={def.id} id={def.id} tag={tag} />;
        })}
        <LoreChipPatternDef />
        {ADJACENCY_TAGS.map((tag) => (
          <TagSymbolDefs key={tag} visual={TAG_VISUALS[tag]} />
        ))}
        <TagSymbolDefs visual={TAG_VISUALS.lore} patternOverrideId="kf-pat-lore--chip" />
      </defs>
    </svg>
  );
}

// --- 描画コンポーネント ------------------------------------------------------

export interface TagSymbolProps {
  readonly tag: Tag;
  readonly variant: "full" | "mini";
  /** チップ内(44px)で lore を描く場合に true(線幅オーバーライド版を参照)。 */
  readonly chipContext?: boolean;
  /** CSS px。`viewBox="0 0 24 24"` を width/height で等比拡縮する。 */
  readonly sizePx: number;
  readonly title?: string;
}

/** `<use>` でスプライトを参照するだけの薄い描画。色は `currentColor` 経由(spec §5.1)。 */
export function TagSymbol({ tag, variant, chipContext = false, sizePx, title }: TagSymbolProps) {
  const useLoreChip = tag === "lore" && variant === "full" && chipContext;
  const href = useLoreChip ? `#${LORE_CHIP_SYMBOL_ID}` : `#${tagSymbolId(tag, variant)}`;
  const ink = TAG_VISUALS[tag].ink;
  return (
    <svg
      width={sizePx}
      height={sizePx}
      viewBox="0 0 24 24"
      style={`color:${ink};flex-shrink:0;`}
      role={title !== undefined ? "img" : undefined}
      aria-label={title}
      aria-hidden={title === undefined ? "true" : undefined}
    >
      <use href={href} />
    </svg>
  );
}
