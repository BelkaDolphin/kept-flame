import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  RESEARCH_COST_GROWTH_FIX,
  criticalPathTechIds,
  erasInOrder,
  idealResearchCost,
  isCriticalPathTech,
  prereqClosure,
  reachabilityIssues,
  reachableNRange,
  researchCostBandIssues,
  techTreeIssues,
  techsOfEra,
} from "../../src/engine/rules/techTree";
import type { EngineContent } from "../../src/engine/rules/types";
import { entityIdFromString, type EntityId } from "../../src/engine/state/state";

// ---------------------------------------------------------------------------
// M6 の検収条件:「全クリティカルパステックが到達可能(GDD 11.4-1)」の単体テスト。
// 併せて GDD 5.1(エラ内リセット式・n の上限)と GDD 12.3(researchCost の
// 到達可能 n 全域チェック)、GDD 7.4((A)(B) 二層)を実 content に対して固定する。
// ---------------------------------------------------------------------------

const eid = entityIdFromString;

function realContent(): EngineContent {
  const raw: RawContentBundle = {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
  const validated = validateContentBundle(raw);
  if (!validated.ok) throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) throw new Error(`ロードで落ちた: ${JSON.stringify(loaded.issues)}`);
  return loaded.value;
}

const CONTENT = realContent();

/**
 * **既知の未解決欠陥(要裁定)** — **[2026-07-29 M10 で解消]**。
 *
 * `techBasketWeaving` の researchCost は T6 のダミー content 由来の 25 で、
 * GDD 12.3 の ±25% 帯(到達可能 n = 1〜3 → raw 38_880_000〜45_000_000)へ入らな
 * かった。M10 の裁定(fixture/content の値修正は engine 挙動変更ではないので
 * algoVersion bump ではない・golden-vector-spec.md §9.4(2) 明確化)により、
 * 帯内の 40 へ修正した(spec §9.4(2) [2026-07-29] 追記参照)。**この修正は
 * sc06 系列の golden vector を動かさない**: sc06Board は workbench(研究産出)を
 * 持たず researchRateFix が常に 0 のため、researchCost の値そのものは
 * どの golden vector の観測値にも現れない(`npm run golden:check` で実測確認
 * 済み・差分ゼロ)。この配列が再び伸びたらオーサリングが GDD 12.3 を破った合図。
 */
const KNOWN_RESEARCH_COST_BAND_VIOLATIONS: readonly string[] = [];

describe("techTree — エラとクリティカルパス(GDD 5.1 / 5.2)", () => {
  it("E1〜E3 の 3 エラが order 昇順で読める", () => {
    expect(erasInOrder(CONTENT).map((era) => era.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("E1〜E3 のテックは合計 24 本(GDD 5.2)", () => {
    const counts = erasInOrder(CONTENT).map((era) => techsOfEra(CONTENT, era.id).length);
    expect(counts).toEqual([8, 7, 9]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(24);
    expect(CONTENT.techDefs.size).toBe(24);
  });

  it("クリティカルパスは壁テック + その前提の閉包 ∩ 同一エラ", () => {
    expect(criticalPathTechIds(CONTENT, "e1")).toEqual([
      "techFireStarting",
      "techPottery",
      "techStorage",
    ]);
    expect(criticalPathTechIds(CONTENT, "e2")).toEqual([
      "techCeramics",
      "techCharcoalKiln",
      "techSmelting",
    ]);
    expect(criticalPathTechIds(CONTENT, "e3")).toEqual([
      "techBlacksmithing",
      "techBlastFurnace",
      "techMachineParts",
      "techSteamEngine",
    ]);
  });

  it("エラ跨ぎの前提は当該エラの n に算入しない(エラ内リセット式・GDD 5.1)", () => {
    // techCharcoalKiln の前提 techStorage は E1 のクリティカルだが E2 の n は 0。
    expect(prereqClosure(CONTENT, eid("techCharcoalKiln"))).toContain("techStorage");
    expect(reachableNRange(CONTENT, eid("techCharcoalKiln"))).toEqual({ min: 0, max: 0 });
  });

  it("クリティカルパス本数が criticalPathMax 以内(GDD 5.1 の n 上限の機械強制)", () => {
    for (const era of erasInOrder(CONTENT)) {
      expect(criticalPathTechIds(CONTENT, era.id).length).toBeLessThanOrEqual(era.criticalPathMax);
    }
  });

  it("葉テックはクリティカルパスに入らない", () => {
    expect(isCriticalPathTech(CONTENT, eid("techBasketWeaving"))).toBe(false);
    expect(isCriticalPathTech(CONTENT, eid("techLens"))).toBe(false);
    expect(isCriticalPathTech(CONTENT, eid("techSteamEngine"))).toBe(true);
  });
});

describe("techTree — 到達可能 n の範囲(GDD 12.3 の動的 n 問題)", () => {
  it("鎖状のクリティカルパスでは n が一意に定まる(min = max = 位置)", () => {
    expect(reachableNRange(CONTENT, eid("techFireStarting"))).toEqual({ min: 0, max: 0 });
    expect(reachableNRange(CONTENT, eid("techPottery"))).toEqual({ min: 1, max: 1 });
    expect(reachableNRange(CONTENT, eid("techStorage"))).toEqual({ min: 2, max: 2 });
    expect(reachableNRange(CONTENT, eid("techSteamEngine"))).toEqual({ min: 3, max: 3 });
  });

  it("葉テックは「前提側のクリティカル数 〜 エラの全クリティカル数」", () => {
    // E1 の葉(前提 = techFireStarting のみ)。
    expect(reachableNRange(CONTENT, eid("techStoneTools"))).toEqual({ min: 1, max: 3 });
    // E3 の葉(前提の閉包に E3 クリティカルが 3 本)。
    expect(reachableNRange(CONTENT, eid("techWaterWheel"))).toEqual({ min: 3, max: 4 });
  });

  it("エラ不明のテックは範囲が求まらない(null)", () => {
    const noEra: EngineContent = {
      ...CONTENT,
      techDefs: new Map([[eid("techX"), { id: eid("techX"), researchCostFix: fixFromInt(10) }]]),
    };
    expect(reachableNRange(noEra, eid("techX"))).toBeNull();
  });
});

describe("techTree — 1.2^n は整数 n の反復乗算(ADR-006: 非整数べき乗禁止)", () => {
  it("base_era × 1.2^n が手計算値と一致する", () => {
    const base = fixFromInt(30);
    expect(toRaw(idealResearchCost(base, 0))).toBe(30_000_000);
    expect(toRaw(idealResearchCost(base, 1))).toBe(36_000_000);
    expect(toRaw(idealResearchCost(base, 2))).toBe(43_200_000);
    expect(toRaw(idealResearchCost(base, 3))).toBe(51_840_000);
    expect(toRaw(idealResearchCost(fixFromInt(120), 4))).toBe(248_832_000);
  });

  it("逓増率は 1.2(GDD 5.1)", () => {
    expect(toRaw(RESEARCH_COST_GROWTH_FIX)).toBe(1_200_000);
  });

  it("n が負 / 非整数なら停止する", () => {
    expect(() => idealResearchCost(fixFromInt(30), -1)).toThrow();
    expect(() => idealResearchCost(fixFromInt(30), 1.5)).toThrow();
  });
});

describe("techTree — researchCost レンジ(GDD 12.3)", () => {
  it("全 24 tech が到達可能 n の全域で ±25% 帯に収まる(M10 で techBasketWeaving 修正済み)", () => {
    const offenders = researchCostBandIssues(CONTENT).map((issue) => issue.techId);
    expect(offenders).toEqual(KNOWN_RESEARCH_COST_BAND_VIOLATIONS);
  });

  it("帯を外した値は検出される(検査が効いていることの反証)", () => {
    const broken = withTechCost(CONTENT, "techStorage", fixFromInt(999));
    const offenders = researchCostBandIssues(broken).map((issue) => issue.techId);
    expect(offenders).toContain("techStorage");
  });

  it("帯の境界値ちょうどは合格(base_era 30 × 1.2^2 の ±25% = 32.4〜54)", () => {
    for (const rawCost of [32_400_000, 54_000_000]) {
      const edge = withTechCost(CONTENT, "techStorage", fixFromRaw(rawCost));
      const offenders = researchCostBandIssues(edge).map((issue) => issue.techId);
      expect(offenders).not.toContain("techStorage");
    }
    for (const rawCost of [32_399_999, 54_000_001]) {
      const outside = withTechCost(CONTENT, "techStorage", fixFromRaw(rawCost));
      const offenders = researchCostBandIssues(outside).map((issue) => issue.techId);
      expect(offenders).toContain("techStorage");
    }
  });

  it("許容幅を広げれば既定の帯で落ちる値も通る(tolerance 引数が効いている)", () => {
    // techStorage(n=2)の理想 43.2 から見て raw 60_000_000 は +38.9%。既定 ±25% では
    // 外れるが、tolerance を ±40% へ広げると帯 [25.92, 60.48] に収まる。
    const broken = withTechCost(CONTENT, "techStorage", fixFromRaw(60_000_000));
    expect(researchCostBandIssues(broken).map((i) => i.techId)).toContain("techStorage");
    expect(researchCostBandIssues(broken, fixFromRaw(400_000)).map((i) => i.techId)).not.toContain(
      "techStorage",
    );
  });
});

describe("techTree — 到達可能性と (A)(B) 二層(GDD 11.4-1 / 7.4)= M6 検収条件", () => {
  it("実 content に到達可能性の不整合が 1 件も無い", () => {
    expect(reachabilityIssues(CONTENT)).toEqual([]);
  });

  it("全クリティカルパステックの前提が content に実在する(= 静的に到達可能)", () => {
    for (const era of erasInOrder(CONTENT)) {
      for (const techId of criticalPathTechIds(CONTENT, era.id)) {
        for (const ancestor of [techId, ...prereqClosure(CONTENT, techId)]) {
          expect(CONTENT.techDefs.has(ancestor)).toBe(true);
        }
      }
    }
  });

  it("クリティカルパステックは全て (A) criticalRecoverable(GDD 7.4)", () => {
    for (const era of erasInOrder(CONTENT)) {
      for (const techId of criticalPathTechIds(CONTENT, era.id)) {
        expect(CONTENT.techDefs.get(techId)?.lossClass).toBe("criticalRecoverable");
      }
    }
  });

  it("(B) rareIrreversible は葉に限られ、他テックの前提になっていない", () => {
    const lossy: EntityId[] = [];
    for (const [techId, def] of CONTENT.techDefs) {
      if (def.lossClass === "rareIrreversible") lossy.push(techId);
    }
    expect(lossy).toEqual(["techLens"]);
    for (const [techId] of CONTENT.techDefs) {
      expect(prereqClosure(CONTENT, techId)).not.toContain("techLens");
    }
  });

  it("(A) が (B) に依存する content は検出される(反証)", () => {
    // techAgriculture は非クリティカルの (A) で、(A) techIrrigation の前提。
    // ここを (B) にすると「(A) の再取得保証が (B) の永久喪失で壊れる」形になる。
    const broken: EngineContent = {
      ...CONTENT,
      techDefs: new Map(
        [...CONTENT.techDefs].map(([techId, def]) =>
          techId === eid("techAgriculture")
            ? [techId, { ...def, lossClass: "rareIrreversible" as const }]
            : [techId, def],
        ),
      ),
    };
    const issues = reachabilityIssues(broken);
    expect(issues.map((issue) => issue.techId)).toEqual(["techIrrigation"]);
    expect(issues[0]?.message).toContain("rareIrreversible");
  });

  it("壁テックが content に無い content は検出される(反証)", () => {
    const withoutGate: EngineContent = {
      ...CONTENT,
      techDefs: new Map([...CONTENT.techDefs].filter(([techId]) => techId !== "techSteamEngine")),
    };
    const issues = reachabilityIssues(withoutGate);
    expect(issues.some((issue) => issue.techId === "techSteamEngine")).toBe(true);
  });

  it("techTreeIssues は両方をまとめて返す", () => {
    const all = techTreeIssues(CONTENT).map((issue) => issue.techId);
    expect(all).toEqual(KNOWN_RESEARCH_COST_BAND_VIOLATIONS);
  });
});

/** 1 テックの researchCost だけを差し替えた content を作る(反証テスト用)。 */
function withTechCost(
  content: EngineContent,
  techId: string,
  costFix: ReturnType<typeof fixFromInt>,
): EngineContent {
  const target = eid(techId);
  const def = content.techDefs.get(target);
  if (def === undefined) throw new Error(`tech "${techId}" が無い`);
  return {
    ...content,
    techDefs: new Map([...content.techDefs, [target, { ...def, researchCostFix: costFix }]]),
  };
}
