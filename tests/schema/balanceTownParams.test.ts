// ---------------------------------------------------------------------------
// [M11] balance.townParams のスキーマ検証と engine への写し — GDD 7.5〜7.7 / 12.1
//
// 「ブロックごと省略可・省略時は当該システムが不活性」という additive 追加の形
// (M5 storage / M6 eras・recordMedia と同じ)を機械で固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { FIX_ZERO, toRaw } from "../../src/engine/fp";
import { validateBalance } from "../../schema/balance";
import { validateContentBundle, type RawContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

type MutableBalance = Record<string, unknown>;

function balanceWith(mutate: (balance: MutableBalance) => void): MutableBalance {
  const clone = JSON.parse(JSON.stringify(balanceJson)) as MutableBalance;
  mutate(clone);
  return clone;
}

function townOf(balance: MutableBalance): Record<string, unknown> {
  return balance["townParams"] as Record<string, unknown>;
}

describe("[M11] validateBalance — townParams", () => {
  it("本番 content の townParams が検証を通る", () => {
    const result = validateBalance(balanceJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.townParams?.lifespanMeanTicks).toBe(432_000);
      expect(result.value.townParams?.populationFloor).toEqual({ bedRatio: 0.5, absolute: 6 });
    }
  });

  it("townParams ブロックごと省略できる(省略時は null = M11 不活性)", () => {
    const withoutTown = balanceWith((balance) => {
      delete balance["townParams"];
    });
    const result = validateBalance(withoutTown);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.townParams).toBeNull();
  });

  it("分位表が降順に崩れていれば reject(逆CDF の単調性)", () => {
    const broken = balanceWith((balance) => {
      const town = townOf(balance);
      const table = [...(town["lifespanQuantileMul"] as number[])];
      table[3] = 0.1;
      town["lifespanQuantileMul"] = table;
    });
    const result = validateBalance(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("昇順"))).toBe(true);
    }
  });

  it("分位表が短すぎれば reject(分布が粗すぎる)", () => {
    const broken = balanceWith((balance) => {
      townOf(balance)["lifespanQuantileMul"] = [0.5, 1.0, 1.5];
    });
    expect(validateBalance(broken).ok).toBe(false);
  });

  it("加入時年齢の下限 > 上限は reject", () => {
    const broken = balanceWith((balance) => {
      const town = townOf(balance);
      town["joinAgeMinTicks"] = 400_000;
      town["joinAgeMaxTicks"] = 1_000;
    });
    const result = validateBalance(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("joinAgeMinTicks"))).toBe(true);
    }
  });

  it("加入時年齢のレンジ幅が一様抽選の上限を超えれば reject", () => {
    const broken = balanceWith((balance) => {
      const town = townOf(balance);
      town["joinAgeMinTicks"] = 0;
      town["joinAgeMaxTicks"] = 50_000_000;
    });
    const result = validateBalance(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("レンジ幅"))).toBe(true);
    }
  });

  it("不足時の漂着頻度倍率が 1 未満は reject(不足時に遅くなってはいけない)", () => {
    const broken = balanceWith((balance) => {
      townOf(balance)["scarcityArrivalFrequencyMul"] = 0.5;
    });
    expect(validateBalance(broken).ok).toBe(false);
  });
});

describe("[M11] loadEngineContent — townParams → TownParams", () => {
  function bundleWith(balance: unknown): RawContentBundle {
    return {
      tech: techJson,
      facility: facilityJson,
      trait: traitJson,
      adjacency: adjacencyJson,
      balance,
    };
  }

  function loadWith(balance: unknown): ReturnType<typeof loadEngineContent> {
    const validated = validateContentBundle(bundleWith(balance));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("bundle 検証に失敗");
    return loadEngineContent(validated.value);
  }

  it("本番 content が engine 内部表現へ写る", () => {
    const result = loadWith(balanceJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const town = result.value.town;
    expect(town).not.toBeUndefined();
    expect(town?.lifespanMeanTicks).toBe(432_000);
    expect(town?.lifespanQuantileMulFix).toHaveLength(64);
    expect(toRaw(town?.memoryDecayDelayFix ?? FIX_ZERO)).toBe(1_500_000);
    expect(toRaw(town?.populationFloorBedRatioFix ?? FIX_ZERO)).toBe(500_000);
    expect(town?.populationFloorAbsolute).toBe(6);
  });

  it("GDD 7.6 の頻度 ×1.5 が周期側へ変換される(4320 / 1.5 = 2880)", () => {
    const result = loadWith(balanceJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.town?.arrivalIntervalTicks).toBe(4320);
    expect(result.value.town?.scarcityArrivalIntervalTicks).toBe(2880);
  });

  it("townParams が無ければ EngineContent.town はキーごと不在(不活性)", () => {
    const withoutTown = balanceWith((balance) => {
      delete balance["townParams"];
    });
    const result = loadWith(withoutTown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("town" in result.value).toBe(false);
  });

  it("分位表の平均が 1.0 から外れていれば reject(平均寿命が化ける)", () => {
    const broken = balanceWith((balance) => {
      const town = townOf(balance);
      town["lifespanQuantileMul"] = (town["lifespanQuantileMul"] as number[]).map(
        (v) => Math.round((v + 0.2) * 1e6) / 1e6,
      );
    });
    const result = loadWith(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("平均倍率"))).toBe(true);
    }
  });

  it("σ を書き換えただけで表を直さなければ reject(静かな分布変更の検出)", () => {
    const broken = balanceWith((balance) => {
      townOf(balance)["lifespanSigma"] = 0.6;
    });
    const result = loadWith(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.message.includes("変動係数"))).toBe(true);
    }
  });
});

describe("[M11] facility.bedCapacityCurve", () => {
  // [M58] 施設14種投入により「bed」(寝床)が寝床上限を持つようになった
  // (M11 時点の「既存 content は寝床を持たない」は解消・GDD 6.1)。
  // それ以外の施設は引き続き寝床を提供しない(= M11 不活性のまま)ことを
  // 併せて固定する。
  it("bed だけが寝床上限を持ち、他の施設は寝床を持たない", () => {
    const validated = validateContentBundle({
      tech: techJson,
      facility: facilityJson,
      trait: traitJson,
      adjacency: adjacencyJson,
      balance: balanceJson,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    for (const facility of validated.value.facility) {
      if (facility.id === "bed") {
        expect(facility.bedCapacityCurve).not.toBeNull();
        continue;
      }
      expect(facility.bedCapacityCurve).toBeNull();
    }
    const loaded = loadEngineContent(validated.value);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    for (const [defId, def] of loaded.value.facilityDefs) {
      if (defId === "bed") {
        // [M39] 寝床上限 = 就労可能人口の上限。2 だと nightly-b seed で
        // 人口 4 に張り付き粘土の就労枠が埋まらず GDD 11.4-2a が落ちるため 3 へ。
        expect(def.bedCapacityByLevel).toEqual([3, 4, 5, 6, 7]);
        continue;
      }
      expect(def.bedCapacityByLevel).toBeUndefined();
    }
  });
});
