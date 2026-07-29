// ---------------------------------------------------------------------------
// [M11] 住民寿命モデル — GDD 7.5 / 7.7 / 11.4-4
//
// 3 つの層を分けて検証する:
//   §1 生涯の純関数(残存想定tick / GDD 11.4-4 の判定)— state も content も不要
//   §2 抽選(分位テーブル引き)の決定論と値域
//   §3 **本番 content の分位テーブルが本当に対数正規か**
//       = 標準正規 CDF の数値積分で Φ(z_i) ≒ (i+0.5)/N を突き合わせる。
//       テストは engine の外なので Math.exp / Math.log を使える(lint 対象外)。
//       engine 側は超越関数を 1 度も通らない(rules/lifespan.ts §1)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { FIX_ONE, fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import {
  ageTicksAt,
  codifyDeadlineMarginTicks,
  createResidentLife,
  deathTickOf,
  meetsCodifyDeadline,
  memoryDecayDelayFor,
  remainingLifeTicks,
  remainingLifeTicksOfResident,
  rollJoinAgeTicks,
  rollLifespanTicks,
} from "../../src/engine/rules/lifespan";
import type { ResidentLife } from "../../src/engine/state/state";
import { worldSeedToUint32 } from "../../src/engine/stochastic";
import { IssueCollector } from "../../schema/common";
import { validateLifespanQuantileTable } from "../../schema/engineContent";
import balanceJson from "../../content/balance.json";
import { agedResident, eid, TEST_TOWN, townContent } from "./lifespanFixtures";
import { resident } from "./fixtures";

const SEED = worldSeedToUint32("seedAlpha");

const LIFE: ResidentLife = { bornTick: 100, lifespanTick: 1000, diedTick: null };

// --- §1 生涯の純関数 -------------------------------------------------------

describe("[M11] 生涯の純関数(GDD 7.5 / 11.4-4)", () => {
  it("deathTick = bornTick + lifespanTick", () => {
    expect(deathTickOf(LIFE)).toBe(1100);
  });

  it("ageTick = t − bornTick(誕生前は負)", () => {
    expect(ageTicksAt(LIFE, 100)).toBe(0);
    expect(ageTicksAt(LIFE, 600)).toBe(500);
    expect(ageTicksAt(LIFE, 50)).toBe(-50);
  });

  it("残存想定tick = lifespanTick − ageTick = deathTick − t", () => {
    expect(remainingLifeTicks(LIFE, 100)).toBe(1000);
    expect(remainingLifeTicks(LIFE, 600)).toBe(500);
    expect(remainingLifeTicks(LIFE, 1100)).toBe(0);
  });

  it("寿命を過ぎている住民の残存想定tick は負のまま(0 でクランプしない)", () => {
    // 人口下限の保持で死亡が延期されている住民はこの状態を取り得る。
    expect(remainingLifeTicks(LIFE, 1500)).toBe(-400);
  });

  it("bornTick が負(ゲーム開始前に生まれた住民)でも成り立つ", () => {
    const old: ResidentLife = { bornTick: -900, lifespanTick: 1000, diedTick: null };
    expect(deathTickOf(old)).toBe(100);
    expect(remainingLifeTicks(old, 0)).toBe(100);
  });

  it("寿命を持たない住民の残存想定tick は null(余命 0 ではない)", () => {
    expect(remainingLifeTicksOfResident(resident("residentA"), 0)).toBeNull();
    expect(remainingLifeTicksOfResident(agedResident("residentB", 0, 500), 100)).toBe(400);
  });
});

describe("[M11] GDD 11.4-4「唯一保持者残存想定tick >= 成文化所要tick × 安全係数」", () => {
  const safetyFactorFix = fixFromRaw(1_500_000); // GDD 11.3

  function marginAt(atTick: number, requiredCodifyTicks: number, delayFix: Fix): number {
    return codifyDeadlineMarginTicks({
      life: LIFE,
      atTick,
      requiredCodifyTicks,
      safetyFactorFix,
      memoryDecayDelayFix: delayFix,
    });
  }

  it("余裕 = 残存想定tick − 所要tick × 1.5(通常の住民)", () => {
    // 残存 500、所要 200 → 500 − 300 = 200
    expect(marginAt(600, 200, FIX_ONE)).toBe(200);
    expect(
      meetsCodifyDeadline({
        life: LIFE,
        atTick: 600,
        requiredCodifyTicks: 200,
        safetyFactorFix,
        memoryDecayDelayFix: FIX_ONE,
      }),
    ).toBe(true);
  });

  it("所要が残存を上回れば assert が落ちる", () => {
    // 残存 500、所要 400 → 500 − 600 = −100
    expect(marginAt(600, 400, FIX_ONE)).toBe(-100);
    expect(
      meetsCodifyDeadline({
        life: LIFE,
        atTick: 600,
        requiredCodifyTicks: 400,
        safetyFactorFix,
        memoryDecayDelayFix: FIX_ONE,
      }),
    ).toBe(false);
  });

  it("記憶巧者の memoryDecayDelay = 1.5 が猶予を伸ばす(GDD 7.5)", () => {
    // 残存 500 × 1.5 = 750、所要 400 × 1.5 = 600 → 150 の余裕で通る
    const delay = memoryDecayDelayFor(TEST_TOWN, true);
    expect(toRaw(delay)).toBe(1_500_000);
    expect(marginAt(600, 400, delay)).toBe(150);
    expect(
      meetsCodifyDeadline({
        life: LIFE,
        atTick: 600,
        requiredCodifyTicks: 400,
        safetyFactorFix,
        memoryDecayDelayFix: delay,
      }),
    ).toBe(true);
  });

  it("記憶巧者でなければ delay は 1.0", () => {
    expect(toRaw(memoryDecayDelayFor(TEST_TOWN, false))).toBe(toRaw(FIX_ONE));
  });
});

// --- §2 抽選 ---------------------------------------------------------------

describe("[M11] 寿命・加入時年齢の抽選(hash アドレス方式)", () => {
  it("同じ (worldSeed, residentId) なら常に同じ寿命", () => {
    const first = rollLifespanTicks(SEED, eid("residentA"), TEST_TOWN);
    const second = rollLifespanTicks(SEED, eid("residentA"), TEST_TOWN);
    expect(second).toBe(first);
  });

  it("worldSeed が違えば別のストリームになる", () => {
    const values = new Set<number>();
    for (const seed of ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]) {
      values.add(rollLifespanTicks(worldSeedToUint32(seed), eid("residentA"), TEST_TOWN));
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it("寿命は分位テーブルの値そのもの(平均 1000 × 0.5/1.0/1.5/2.0)", () => {
    const allowed = new Set([500, 1000, 1500, 2000]);
    for (let i = 0; i < 200; i++) {
      const value = rollLifespanTicks(SEED, eid(`residentGen${String(i)}`), TEST_TOWN);
      expect(allowed.has(value)).toBe(true);
    }
  });

  it("4 分位すべてが実際に引かれる(添字の写像が偏っていない)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(rollLifespanTicks(SEED, eid(`residentGen${String(i)}`), TEST_TOWN));
    }
    expect(seen.size).toBe(4);
  });

  it("加入時年齢は [joinAgeMin, joinAgeMax] に収まる", () => {
    for (let i = 0; i < 200; i++) {
      const age = rollJoinAgeTicks(SEED, eid(`residentGen${String(i)}`), TEST_TOWN);
      expect(age).toBeGreaterThanOrEqual(TEST_TOWN.joinAgeMinTicks);
      expect(age).toBeLessThanOrEqual(TEST_TOWN.joinAgeMaxTicks);
    }
  });

  it("寿命と加入時年齢は別ドメイン = 同じ salt でも同じ値にならない", () => {
    // 同一ドメインを共有していると両者が完全相関する。ドメイン分離の検出器。
    let differing = 0;
    for (let i = 0; i < 50; i++) {
      const rid = eid(`residentGen${String(i)}`);
      const lifespanIndex = rollLifespanTicks(SEED, rid, TEST_TOWN) / 500;
      const ageBucket = Math.floor(rollJoinAgeTicks(SEED, rid, TEST_TOWN) / 100) + 1;
      if (lifespanIndex !== ageBucket) differing++;
    }
    expect(differing).toBeGreaterThan(10);
  });
});

describe("[M11] createResidentLife(GDD 7.7「人物・寿命は seed 決定論生成」)", () => {
  it("bornTick = 加入tick − 加入時年齢、必ず 1 tick 以上生きる", () => {
    for (let i = 0; i < 300; i++) {
      const rid = eid(`residentGen${String(i)}`);
      const life = createResidentLife(SEED, rid, 7, TEST_TOWN);
      const age = 7 - life.bornTick;
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(life.lifespanTick);
      expect(deathTickOf(life)).toBeGreaterThan(7);
      expect(life.diedTick).toBeNull();
    }
  });

  it("同じ入力なら同じ生涯(分割不変・再現性の前提)", () => {
    const a = createResidentLife(SEED, eid("residentDrift100"), 100, TEST_TOWN);
    const b = createResidentLife(SEED, eid("residentDrift100"), 100, TEST_TOWN);
    expect(b).toEqual(a);
  });

  it("加入 tick が違えば bornTick がその分ずれる(年齢は同じ)", () => {
    const rid = eid("residentDrift100");
    const early = createResidentLife(SEED, rid, 0, TEST_TOWN);
    const late = createResidentLife(SEED, rid, 500, TEST_TOWN);
    expect(late.lifespanTick).toBe(early.lifespanTick);
    expect(late.bornTick - early.bornTick).toBe(500);
  });
});

// --- §3 本番 content の分位テーブルが対数正規であることの突合 ---------------

/**
 * 標準正規分布の CDF を Simpson 法で数値積分する(誤差 ~1e-12)。
 * **engine の外**なので `Math.exp` / `Math.sqrt` を使ってよい。engine 側は
 * この値を実行時に一切計算せず、オーサリング時に展開した表を引くだけである
 * (src/engine/rules/lifespan.ts §1 / GDD 11.7 / ADR-006)。
 */
function normalCdf(z: number): number {
  if (z < 0) return 1 - normalCdf(-z);
  const steps = 4000;
  const h = z / steps;
  const pdf = (t: number): number => Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);
  let sum = pdf(0) + pdf(z);
  for (let i = 1; i < steps; i++) {
    sum += pdf(i * h) * (i % 2 === 1 ? 4 : 2);
  }
  return 0.5 + (sum * h) / 3;
}

describe("[M11] content/balance.json の寿命分位テーブル(GDD 7.5 の離散対数正規)", () => {
  const town = balanceJson.townParams;

  it("GDD 7.5 の平均 432,000 tick と σ = 0.25 が入っている", () => {
    expect(town.lifespanMeanTicks).toBe(432_000);
    expect(town.lifespanSigma).toBe(0.25);
    expect(town.memoryDecayDelay).toBe(1.5);
  });

  it("GDD 7.6 の人口下限 min(寝床 × 0.5, 6) がそのまま入っている", () => {
    expect(town.populationFloor.bedRatio).toBe(0.5);
    expect(town.populationFloor.absolute).toBe(6);
    expect(town.scarcityArrivalFrequencyMul).toBe(1.5);
  });

  it("分位表は昇順・全て正・小数第6位まで(1e6 で厳密表現できる)", () => {
    const table = town.lifespanQuantileMul;
    expect(table.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < table.length; i++) {
      const value = table[i] ?? 0;
      expect(value).toBeGreaterThan(0);
      if (i > 0) expect(value).toBeGreaterThan(table[i - 1] ?? 0);
      // 1e6 倍が整数 = ADR-006 の 1e6 固定小数点で厳密表現できる。
      expect(Math.abs(Math.round(value * 1e6) - value * 1e6)).toBeLessThan(1e-6);
    }
  });

  it("各分位が対数正規の逆CDF と一致する(Φ(z_i) ≒ (i+0.5)/N)", () => {
    // CV = σ の対数正規の shape は s = sqrt(ln(1 + σ²))、
    // 平均を 1.0 に正規化した分位は m = exp(s·z − s²/2)。よって
    //   z_i = (ln m_i + s²/2) / s   であり、Φ(z_i) が (i+0.5)/N になるはず。
    const table = town.lifespanQuantileMul;
    const n = table.length;
    const s = Math.sqrt(Math.log(1 + town.lifespanSigma * town.lifespanSigma));
    for (let i = 0; i < n; i++) {
      const m = table[i] ?? 0;
      const z = (Math.log(m) + (s * s) / 2) / s;
      expect(normalCdf(z)).toBeCloseTo((i + 0.5) / n, 4);
    }
  });

  it("表の平均倍率が 1.0 = 実際の平均寿命が lifespanMeanTicks に一致する", () => {
    const table = town.lifespanQuantileMul;
    const mean = table.reduce((a, b) => a + b, 0) / table.length;
    expect(mean).toBeCloseTo(1, 2);
  });
});

describe("[M11] ローダーの分布検証(整数演算のみ・schema/engineContent.ts)", () => {
  const sigma = fixFromRaw(250_000); // 0.25

  function tableFrom(values: readonly number[]): readonly Fix[] {
    return values.map((v) => fixFromRaw(Math.round(v * 1e6)));
  }

  const realTable = tableFrom(balanceJson.townParams.lifespanQuantileMul);

  it("本番テーブルは合格する", () => {
    const issues = new IssueCollector();
    expect(validateLifespanQuantileTable(realTable, sigma, "$.t", issues)).toBe(true);
    expect(issues.list()).toEqual([]);
  });

  it("平均を静かにずらしたテーブルは reject される(平均寿命が化ける)", () => {
    const shifted = realTable.map((v) => fixFromRaw(toRaw(v) + 50_000));
    const issues = new IssueCollector();
    expect(validateLifespanQuantileTable(shifted, sigma, "$.t", issues)).toBe(false);
    expect(issues.list()[0]?.message).toContain("平均倍率");
  });

  it("散らばりだけ倍にしたテーブルは reject される(σ と食い違う)", () => {
    // 平均 1.0 を保ったまま偏差を 2 倍にする = 変動係数が約 0.5 になる。
    const widened = realTable.map((v) => fixFromRaw(1_000_000 + (toRaw(v) - 1_000_000) * 2));
    const issues = new IssueCollector();
    expect(validateLifespanQuantileTable(widened, sigma, "$.t", issues)).toBe(false);
    expect(issues.list()[0]?.message).toContain("変動係数");
  });

  it("空のテーブルは reject される", () => {
    const issues = new IssueCollector();
    expect(validateLifespanQuantileTable([], sigma, "$.t", issues)).toBe(false);
  });
});

describe("[M11] 本番 content が engine 内部表現へ写る", () => {
  it("townContent フィクスチャの town が読める(型の疎通)", () => {
    const town = townContent().town;
    expect(town?.lifespanMeanTicks).toBe(1000);
    expect(town?.scarcityArrivalIntervalTicks).toBe(66);
  });
});
