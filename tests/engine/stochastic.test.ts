import { describe, expect, it } from "vitest";

import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import { DOMAIN_TAGS } from "../../src/engine/rng/domainTags";
import { seedXoshiro128, xoshiro128Next } from "../../src/engine/rng/xoshiro128";
import { hashRngDomain } from "../../src/engine/rng/fnv1a32";
import {
  GAME_DAY_TICKS,
  STOCHASTIC_STAGE,
  StochasticError,
  UINT32_SPAN,
  UNIFORM_SPAN_MAX,
  bernoulliHit,
  coarseStepIndexOf,
  drawFromStream,
  hashedDrawUint32,
  isCoarseStepTick,
  nextCoarseStepTickAtOrAfter,
  perCoarseStepProbability,
  saltFromId,
  uniformFixFromDraw,
  uniformIntFromDraw,
  worldSeedToUint32,
} from "../../src/engine/stochastic";
import { getRngState, rngStateDomains } from "../../src/engine/state/state";
import { resident, stateOf } from "./fixtures";

// ---------------------------------------------------------------------------
// 確率系 段階1(ADR-009/018(1))のテスト。
//
// 主眼:
//   (1) 段階1 であることの明示(段階2 の API を足していない)
//   (2) hash アドレス方式の draw が**順序非依存で完全再現**すること
//   (3) uint32 → 確率/範囲 の写像が整数演算で厳密であること(境界値を固定)
//   (4) 逐次ストリーム(rngState)が state を通して前進すること
// ---------------------------------------------------------------------------

describe("段階の宣言", () => {
  it("実装しているのは段階1 のみ", () => {
    expect(STOCHASTIC_STAGE).toBe(1);
  });

  it("1 ゲーム日 = 1440 tick(GDD 11.2)", () => {
    expect(GAME_DAY_TICKS).toBe(1440);
  });
});

describe("hash アドレス方式の draw", () => {
  it("同じ (worldSeed, domainTag, salt) なら常に同じ値(再現性)", () => {
    const a = hashedDrawUint32(123, DOMAIN_TAGS.recall, [1, 2, 3]);
    const b = hashedDrawUint32(123, DOMAIN_TAGS.recall, [1, 2, 3]);
    expect(b).toBe(a);
  });

  it("salt / domainTag / worldSeed のどれが変わっても値が変わる", () => {
    const base = hashedDrawUint32(123, DOMAIN_TAGS.recall, [1, 2, 3]);
    expect(hashedDrawUint32(123, DOMAIN_TAGS.recall, [1, 2, 4])).not.toBe(base);
    expect(hashedDrawUint32(123, DOMAIN_TAGS.adjacency, [1, 2, 3])).not.toBe(base);
    expect(hashedDrawUint32(124, DOMAIN_TAGS.recall, [1, 2, 3])).not.toBe(base);
  });

  it("hash 値をそのまま返さず xoshiro128** を 1 ステップ通す(ADR-007)", () => {
    const hash = hashRngDomain(123, DOMAIN_TAGS.recall, [1, 2, 3]);
    const expected = xoshiro128Next(seedXoshiro128(hash)).value;
    expect(hashedDrawUint32(123, DOMAIN_TAGS.recall, [1, 2, 3])).toBe(expected);
  });

  it("戻り値は常に uint32 の範囲", () => {
    for (let i = 0; i < 500; i++) {
      const value = hashedDrawUint32(i, DOMAIN_TAGS.recall, [i, i * 7]);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(UINT32_SPAN);
    }
  });

  it("worldSeed 文字列 / ID の uint32 化は FNV-1a-32 経由で決定論", () => {
    expect(worldSeedToUint32("seedAlpha")).toBe(worldSeedToUint32("seedAlpha"));
    expect(worldSeedToUint32("seedAlpha")).not.toBe(worldSeedToUint32("seedBeta"));
    expect(saltFromId("aRui")).toBe(saltFromId("aRui"));
    expect(saltFromId("aRui")).not.toBe(saltFromId("bMina"));
  });
});

describe("ベルヌーイ試行", () => {
  it("p=0 は常に false、p=1 は常に true", () => {
    for (const draw of [0, 1, 12345, UINT32_SPAN - 1]) {
      expect(bernoulliHit(fixFromRaw(0), draw)).toBe(false);
      expect(bernoulliHit(fixFromInt(1), draw)).toBe(true);
    }
  });

  it("しきい値 = floor(p * 2^32 / 1e6) の境界が厳密", () => {
    const p = fixFromRaw(2_430); // 0.00243
    const threshold = Math.floor((2_430 * UINT32_SPAN) / 1_000_000);
    expect(bernoulliHit(p, threshold - 1)).toBe(true);
    expect(bernoulliHit(p, threshold)).toBe(false);
  });

  it("p=0.5 は uint32 の中央で切り替わる", () => {
    const half = fixFromRaw(500_000);
    expect(bernoulliHit(half, UINT32_SPAN / 2 - 1)).toBe(true);
    expect(bernoulliHit(half, UINT32_SPAN / 2)).toBe(false);
  });

  it("[0,1] を外れた確率は例外(clamp 漏れの検出)", () => {
    expect(() => bernoulliHit(fixFromRaw(-1), 0)).toThrow(StochasticError);
    expect(() => bernoulliHit(fixFromRaw(1_000_001), 0)).toThrow(StochasticError);
  });

  it("大量試行の的中率が確率に近い(hash の偏りが極端でないことの確認)", () => {
    const p = fixFromRaw(250_000); // 0.25
    let hits = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      if (bernoulliHit(p, hashedDrawUint32(99, DOMAIN_TAGS.recall, [i]))) hits++;
    }
    expect(hits / trials).toBeGreaterThan(0.235);
    expect(hits / trials).toBeLessThan(0.265);
  });
});

describe("一様分布", () => {
  it("draw=0 で下限、draw=2^32-1 で上限", () => {
    expect(uniformIntFromDraw(0, 1440, 2880)).toBe(1440);
    expect(uniformIntFromDraw(UINT32_SPAN - 1, 1440, 2880)).toBe(2880);
  });

  it("下限=上限なら常にその値", () => {
    for (const draw of [0, 7, UINT32_SPAN - 1]) {
      expect(uniformIntFromDraw(draw, 5, 5)).toBe(5);
    }
  });

  it("全 draw で範囲内(両端含む)", () => {
    for (let i = 0; i < 300; i++) {
      const value = uniformIntFromDraw(hashedDrawUint32(5, DOMAIN_TAGS.recallDuration, [i]), 1, 2);
      expect(value === 1 || value === 2).toBe(true);
    }
  });

  it("レンジ幅の上限を超えると例外(中間積の厳密性の境界)", () => {
    expect(() => uniformIntFromDraw(0, 0, UNIFORM_SPAN_MAX - 1)).not.toThrow();
    expect(() => uniformIntFromDraw(0, 0, UNIFORM_SPAN_MAX)).toThrow(StochasticError);
    expect(() => uniformIntFromDraw(0, 5, 4)).toThrow(StochasticError);
  });

  it("Fix 版も両端に届く", () => {
    const lo = fixFromRaw(-200_000);
    const hi = fixFromRaw(200_000);
    expect(toRaw(uniformFixFromDraw(0, lo, hi))).toBe(-200_000);
    expect(toRaw(uniformFixFromDraw(UINT32_SPAN - 1, lo, hi))).toBe(200_000);
  });
});

describe("粗粒度ステップのグリッド", () => {
  it("ステップ番号は tick の絶対グリッド(分割不変の前提)", () => {
    expect(coarseStepIndexOf(0, 10)).toBe(0);
    expect(coarseStepIndexOf(9, 10)).toBe(0);
    expect(coarseStepIndexOf(10, 10)).toBe(1);
    expect(coarseStepIndexOf(4320, 10)).toBe(432);
  });

  it("境界 tick の判定", () => {
    expect(isCoarseStepTick(0, 10)).toBe(true);
    expect(isCoarseStepTick(9, 10)).toBe(false);
    expect(isCoarseStepTick(10, 10)).toBe(true);
    // Fallback の 1 分 tick(ADR-014(3))では全 tick が境界。
    expect(isCoarseStepTick(7, 1)).toBe(true);
  });

  it("次の境界(同 tick を含む)", () => {
    expect(nextCoarseStepTickAtOrAfter(0, 10)).toBe(0);
    expect(nextCoarseStepTickAtOrAfter(1, 10)).toBe(10);
    expect(nextCoarseStepTickAtOrAfter(10, 10)).toBe(10);
    expect(nextCoarseStepTickAtOrAfter(11, 10)).toBe(20);
  });

  it("coarseTickMinutes が 1〜1440 の外なら例外", () => {
    expect(() => coarseStepIndexOf(0, 0)).toThrow(StochasticError);
    expect(() => coarseStepIndexOf(0, 1441)).toThrow(StochasticError);
    expect(() => coarseStepIndexOf(0, 1.5)).toThrow(StochasticError);
  });
});

describe("1 日あたり確率 → 1 ステップあたり確率(線形按分)", () => {
  it("p_max=0.35 / 10 分ステップ の値を固定", () => {
    // floor(350000 * 10 / 1440) = floor(2430.55...) = 2430
    expect(toRaw(perCoarseStepProbability(fixFromRaw(350_000), 10))).toBe(2_430);
  });

  it("ステップ幅 = 1 日なら元の確率に戻る", () => {
    expect(toRaw(perCoarseStepProbability(fixFromRaw(350_000), 1440))).toBe(350_000);
  });

  it("1 分ステップ(Fallback)は 1/1440", () => {
    expect(toRaw(perCoarseStepProbability(fixFromRaw(350_000), 1))).toBe(243);
  });

  it("確率 0 は 0 のまま", () => {
    expect(toRaw(perCoarseStepProbability(fixFromRaw(0), 10))).toBe(0);
  });
});

describe("逐次ストリーム(rngState)", () => {
  const base = stateOf([resident("aRui")]);

  it("初回 draw は hash(worldSeed, tag, []) から遅延初期化される", () => {
    const expectedSeed = seedXoshiro128(
      hashRngDomain(worldSeedToUint32(base.worldSeed), DOMAIN_TAGS.recallDuration, []),
    );
    const expected = xoshiro128Next(expectedSeed);
    const result = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    expect(result.value).toBe(expected.value);
    expect(getRngState(result.state, DOMAIN_TAGS.recallDuration)).toEqual(expected.state);
  });

  it("draw のたびにストリームが前進し、値が変わる", () => {
    const first = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    const second = drawFromStream(first.state, DOMAIN_TAGS.recallDuration);
    expect(second.value).not.toBe(first.value);
    expect(getRngState(second.state, DOMAIN_TAGS.recallDuration)).not.toEqual(
      getRngState(first.state, DOMAIN_TAGS.recallDuration),
    );
  });

  it("同じ state から引けば同じ値(純関数)", () => {
    const a = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    const b = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    expect(b.value).toBe(a.value);
  });

  it("worldSeed が違えば初回 draw も違う", () => {
    const other = stateOf([resident("aRui")], { worldSeed: "seedBeta" });
    expect(drawFromStream(other, DOMAIN_TAGS.recallDuration).value).not.toBe(
      drawFromStream(base, DOMAIN_TAGS.recallDuration).value,
    );
  });

  it("hash アドレス方式のドメインは rngState に現れない", () => {
    const result = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    hashedDrawUint32(worldSeedToUint32(base.worldSeed), DOMAIN_TAGS.recall, [1]);
    expect(rngStateDomains(result.state)).toEqual([DOMAIN_TAGS.recallDuration]);
  });

  it("ストリームを進めても entity は参照共有される(構造共有)", () => {
    const result = drawFromStream(base, DOMAIN_TAGS.recallDuration);
    expect(result.state.entityStateById).toBe(base.entityStateById);
  });
});
