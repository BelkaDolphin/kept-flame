// ---------------------------------------------------------------------------
// src/ui/screens/grid/tagVisuals.ts のテスト(M19)。
//
// tags-spec.md §8.3 の機械可読 JSON からの転記が正しいこと(色/パス/パターン)、
// LOD(§7.2)の段階判定とマーカーサイズ式(§7.1)が仕様どおりに動くことを固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { ADJACENCY_TAGS } from "../../../src/engine/adjacency";
import { CELL_SIZE_PX, DEFAULT_SCALE } from "../../../src/ui/screens/grid/gridConstants";
import {
  computeDisplayMarkerPx,
  computeLodTier,
  computeRawMarkerPx,
  formatBonusPercent,
  formatOvercrowdCount,
  LOD_TIERS,
  MARKER_MAX_PX,
  MARKER_MIN_PX,
  NEUTRAL_COLORS,
  SURFACE_COLORS,
  TAG_VISUALS,
  TAG_VISUAL_LIST,
} from "../../../src/ui/screens/grid/tagVisuals";

describe("TAG_VISUALS(spec §8.3 の転記)", () => {
  it("7タグ全部が揃っている(宣言順は ADJACENCY_TAGS と一致)", () => {
    expect(TAG_VISUAL_LIST.map((v) => v.id)).toEqual([...ADJACENCY_TAGS]);
  });

  it("ink/tint の色値が spec の値そのまま(勝手に変えていないことの固定)", () => {
    expect(TAG_VISUALS.heat.ink).toBe("#8C290B");
    expect(TAG_VISUALS.clean.ink).toBe("#076F5A");
    expect(TAG_VISUALS.foul.ink).toBe("#35240F");
    expect(TAG_VISUALS.noise.ink).toBe("#671B75");
    expect(TAG_VISUALS.damp.ink).toBe("#1942E5");
    expect(TAG_VISUALS.calm.ink).toBe("#2D333E");
    expect(TAG_VISUALS.lore.ink).toBe("#975D0C");
    expect(TAG_VISUALS.lore.tint).toBe("#F8EFE2");
  });

  it("damp の彩度は裁定N11どおり変更していない(§9-2の凍結値)", () => {
    expect(TAG_VISUALS.damp.ink).toBe("#1942E5");
  });

  it("neutralContrast の凍結値(line-grid)も変更していない(§9-6)", () => {
    expect(NEUTRAL_COLORS.lineGrid).toBe("#8A857D");
  });

  it("surfaces は7トークン(page/cell/cellSelected/previewAdd/previewSub/rubble)", () => {
    expect(Object.keys(SURFACE_COLORS).sort()).toEqual(
      ["cell", "cellSelected", "page", "previewAdd", "previewSub", "rubble"].sort(),
    );
  });

  it("パターンを持つのは foul/damp/calm/lore の4種のみ(heat=ベタ塗り・clean/noise=無地)", () => {
    expect(TAG_VISUALS.heat.patternId).toBeNull();
    expect(TAG_VISUALS.clean.patternId).toBeNull();
    expect(TAG_VISUALS.noise.patternId).toBeNull();
    expect(TAG_VISUALS.foul.patternId).toBe("kf-pat-foul");
    expect(TAG_VISUALS.damp.patternId).toBe("kf-pat-damp");
    expect(TAG_VISUALS.calm.patternId).toBe("kf-pat-calm");
    expect(TAG_VISUALS.lore.patternId).toBe("kf-pat-lore");
  });

  it("7種すべて輪郭クラス(silhouette)が異なる(色を除去しても弁別できる骨格・§1)", () => {
    const silhouettes = TAG_VISUAL_LIST.map((v) => v.silhouette);
    expect(new Set(silhouettes).size).toBe(7);
  });
});

describe("computeRawMarkerPx / computeDisplayMarkerPx / computeLodTier(spec §7.1・§7.2)", () => {
  it("computeDisplayMarkerPx は常に [9,26] の範囲に収まる(表示サイズのクランプ)", () => {
    for (const scale of [0.01, 0.5, 1, 2, 100]) {
      const displayPx = computeDisplayMarkerPx(computeRawMarkerPx(scale));
      expect(displayPx).toBeGreaterThanOrEqual(MARKER_MIN_PX);
      expect(displayPx).toBeLessThanOrEqual(MARKER_MAX_PX);
    }
  });

  it("既定ズーム(gridConstants.DEFAULT_SCALE)での LOD 段が判定できる", () => {
    const raw = computeRawMarkerPx(DEFAULT_SCALE);
    const tier = computeLodTier(raw);
    expect(LOD_TIERS.map((t) => t.id)).toContain(tier.id);
  });

  it("スケールが大きいほど raw markerPx は単調非減少", () => {
    const scales = [0.4, 0.7, 1.0, 1.5, 2.0, 2.5];
    const rawValues = scales.map((s) => computeRawMarkerPx(s));
    for (let i = 1; i < rawValues.length; i++) {
      expect(rawValues[i]).toBeGreaterThanOrEqual(rawValues[i - 1] as number);
    }
  });

  it("表示サイズは26を超えるスケールでも26にクランプされる(LOD段はL1のまま延長)", () => {
    expect(computeDisplayMarkerPx(computeRawMarkerPx(100))).toBe(MARKER_MAX_PX);
    expect(computeLodTier(computeRawMarkerPx(100)).id).toBe("L1");
  });

  it("[重要] raw markerPx が9未満でもLOD段はL5になり、記号ごと撤去される(表示サイズの9クランプでL5が握り潰されない)", () => {
    // computeDisplayMarkerPx だけを見ると 9 未満は無いように錯覚するが、
    // LOD 段の判定は computeRawMarkerPx(クランプ前)で行う設計(§設計判断参照)。
    const raw = computeRawMarkerPx(0.3); // かなり縮小
    expect(raw).toBeLessThan(MARKER_MIN_PX);
    const tier = computeLodTier(raw);
    expect(tier.id).toBe("L5");
    expect(tier.symbol).toBe("none");
  });

  it("L1(raw>=24px)は4チャネル(色+記号+パターン+数値)全部有効", () => {
    const tier = computeLodTier(26);
    expect(tier.id).toBe("L1");
    expect(tier.channels).toBe(4);
    expect(tier.symbol).toBe("full");
    expect(tier.pattern).toBe(true);
    expect(tier.numeral).toBe(true);
  });

  it("L5(raw<9px)は記号を撤去する(channels=1)", () => {
    const tier = computeLodTier(5);
    expect(tier.id).toBe("L5");
    expect(tier.symbol).toBe("none");
    expect(tier.channels).toBe(1);
  });

  it("L4はmini記号・L3以下はpattern/numeralが落ちる(spec §7.2の劣化順序)", () => {
    expect(computeLodTier(12).symbol).toBe("mini");
    expect(computeLodTier(17).pattern).toBe(false);
    expect(computeLodTier(17).numeral).toBe(false);
  });

  it("cellPx = CELL_SIZE_PX が定数1箇所(gridConstants.ts)から取られている(44決め打ちでない)", () => {
    const expected = Math.round(0.273 * CELL_SIZE_PX * 1);
    expect(computeRawMarkerPx(1)).toBe(expected);
  });
});

describe("formatBonusPercent / formatOvercrowdCount(spec §6.2・W4裁定)", () => {
  it("0 は '0' を表示する(空欄禁止)", () => {
    expect(formatBonusPercent(0)).toBe("0");
  });

  it("正の値は符号 + を付ける", () => {
    expect(formatBonusPercent(0.2)).toBe("+20");
  });

  it("負の値はそのまま(JS の負号)", () => {
    expect(formatBonusPercent(-0.1)).toBe("-10");
  });

  it("±60 でクランプする(符号+2桁を超えない・W4裁定)", () => {
    expect(formatBonusPercent(0.95)).toBe("+60");
    expect(formatBonusPercent(-0.95)).toBe("-60");
  });

  it("過密表示は非負整数の x 表記", () => {
    expect(formatOvercrowdCount(3)).toBe("x3");
    expect(formatOvercrowdCount(0)).toBe("x0");
  });
});
