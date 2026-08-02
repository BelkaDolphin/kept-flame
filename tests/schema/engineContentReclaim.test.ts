import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { validateBalance } from "../../schema/balance";
import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";
import { toRaw } from "../../src/engine/fp";
import { initialTerrain, reclaimCostFix } from "../../src/engine/rules/reclaim";
import { requireReclaimParams, type EngineContent } from "../../src/engine/rules/types";

// ---------------------------------------------------------------------------
// [M52] balance.reclaim(GDD 9.1)の content ローダー配線のテスト
// (schema/balance.ts の validateReclaim + schema/engineContent.ts §6g)。
//
// 固定するのは 3 つ:
//   (1) 実 content(content/balance.json の reclaim ブロック)が engine 内部
//       表現へ正しく写り、初期瓦礫が `initialTerrain` から取り出せる
//   (2) **ブロック省略時は M52 以前と 1 bit も違わない**(EngineContent に
//       キーが生えず、開墾コマンドだけが不活性になる)
//   (3) 壊れた値(昇順違反 / 盤外 / 底 < 1.0 / cap < base)は検証で止まる
// ---------------------------------------------------------------------------

function rawBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

function load(bundle: RawContentBundle): EngineContent {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  }
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) {
    throw new Error(`ロードで落ちた: ${JSON.stringify(loaded.issues)}`);
  }
  return loaded.value;
}

/** balance.json の一部を差し替えた生バンドル(reclaim ブロックの実験用)。 */
function balanceWith(reclaim: unknown): Record<string, unknown> {
  const base = { ...(balanceJson as unknown as Record<string, unknown>) };
  if (reclaim === undefined) {
    delete base["reclaim"];
    return base;
  }
  base["reclaim"] = reclaim;
  return base;
}

function issuePaths(reclaim: unknown): readonly string[] {
  const result = validateBalance(balanceWith(reclaim));
  if (result.ok) return [];
  return result.issues.map((issue) => issue.path);
}

describe("balance.reclaim が engine 内部表現へ写る", () => {
  it("実 content の値が 1e6 化されて写る", () => {
    const params = requireReclaimParams(load(rawBundle()));
    // [M39] 開始薪の下限 = baseCost なので 40 → 60(ロードマップ M39 ①)。
    // cap は保管上限 400 の下で到達可能な 300 へ(2000 は在庫に載らず開墾が止まる)。
    expect(toRaw(params.baseCostFix)).toBe(60_000_000);
    expect(toRaw(params.costGrowthFix)).toBe(1_150_000);
    expect(toRaw(params.costCapFix)).toBe(300_000_000);
    expect(params.costResourceId).toBe("firewood");
  });

  it("初期瓦礫は 6×8 の下 6 行(セル 12〜47 の 36 枚)= 上 2 行 12 セルが利用可", () => {
    const terrain = initialTerrain(load(rawBundle()));
    expect(terrain.reclaimedCount).toBe(0);
    expect(terrain.rubbleCells).toHaveLength(36);
    expect(terrain.rubbleCells[0]).toBe(12);
    expect(terrain.rubbleCells[35]).toBe(47);
  });

  it("実 content のコスト曲線は 1.15 冪で増え、最後の 1 枚までに cap へ達する", () => {
    const params = requireReclaimParams(load(rawBundle()));
    expect(toRaw(reclaimCostFix(params, 0))).toBe(60_000_000);
    expect(toRaw(reclaimCostFix(params, 1))).toBe(69_000_000);
    // 36 枚目(解放数 35)は cap 300 に張り付いている(GDD 9.1 の到達可能な上限)。
    expect(toRaw(reclaimCostFix(params, 35))).toBe(300_000_000);
  });

  it("ブロックを省略した content には reclaim キーが生えない(M52 以前と同一)", () => {
    const withoutReclaim = load({ ...rawBundle(), balance: balanceWith(undefined) });
    expect(withoutReclaim.reclaim).toBeUndefined();
    expect(initialTerrain(withoutReclaim)).toEqual({ rubbleCells: [], reclaimedCount: 0 });
  });
});

describe("壊れた reclaim ブロックは検証で止まる", () => {
  const valid = {
    baseCost: 40,
    costGrowth: 1.15,
    costCap: 2000,
    costResourceId: "firewood",
    initialRubbleCells: [12, 13],
  };

  it("そのままなら issue ゼロ", () => {
    expect(issuePaths(valid)).toEqual([]);
  });

  it("初期瓦礫が昇順・重複なしでなければ reject", () => {
    expect(issuePaths({ ...valid, initialRubbleCells: [13, 12] })).toEqual([
      "$.reclaim.initialRubbleCells[1]",
    ]);
    expect(issuePaths({ ...valid, initialRubbleCells: [12, 12] })).toEqual([
      "$.reclaim.initialRubbleCells[1]",
    ]);
  });

  it("盤外のセル番号は reject(6×8 = 0〜47)", () => {
    expect(issuePaths({ ...valid, initialRubbleCells: [48] })).toEqual([
      "$.reclaim.initialRubbleCells[0]",
    ]);
  });

  it("底が 1.0 未満(コスト逓減)は reject", () => {
    expect(issuePaths({ ...valid, costGrowth: 0.9 })).toEqual(["$.reclaim.costGrowth"]);
  });

  it("cap が base を下回る(最初から頭打ち)は reject", () => {
    expect(issuePaths({ ...valid, costCap: 10 })).toEqual(["$.reclaim.costCap"]);
  });

  it("costResourceId が ID 規則に反すれば reject", () => {
    expect(issuePaths({ ...valid, costResourceId: "Firewood" })).toEqual([
      "$.reclaim.costResourceId",
    ]);
  });
});
