import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import {
  UNREPRESENTABLE_CONTENT_EFFECTS,
  UNREPRESENTABLE_CONTENT_TRAIT_STATS,
  loadEngineContent,
} from "../../schema/engineContent";
import { toRaw } from "../../src/engine/fp";
import { RECORD_MEDIA, isRecordMedium } from "../../src/engine/rules/types";
import type { EngineContent } from "../../src/engine/rules/types";

// ---------------------------------------------------------------------------
// M6 でローダーへ足した写像のテスト:
//   (a) tech.era / lossClass / prereqs → TechDef(GDD 5.1 / 7.4)
//   (b) balance.eras       → EraDef(GDD 5.1 のコスト表)
//   (c) balance.recordMedia → RecordMediaParams(GDD 11.1 [2026-07-27追補])
//   (d) 裁定 N7(学芸3連接)の記録が engine 側の語彙レジストリと一致していること
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function load(bundle: RawContentBundle): EngineContent {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) throw new Error(`ロードで落ちた: ${JSON.stringify(loaded.issues)}`);
  return loaded.value;
}

/** 検証 or ロードで出た issue の path 一覧(どちらで落ちても拾う)。 */
function issuePaths(bundle: RawContentBundle): readonly string[] {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) return validated.issues.map((issue) => issue.path);
  const loaded = loadEngineContent(validated.value);
  return loaded.ok ? [] : loaded.issues.map((issue) => issue.path);
}

/** balance だけを差し替えたバンドルを作る。 */
function withBalance(mutate: (balance: Record<string, unknown>) => void): RawContentBundle {
  const bundle = rawBundle();
  const balance = clone(bundle.balance) as Record<string, unknown>;
  mutate(balance);
  return { ...bundle, balance };
}

describe("loadEngineContent — tech の era / lossClass / prereqs(M6)", () => {
  it("3 フィールドが engine 内部表現へ写る", () => {
    const content = load(rawBundle());
    const storage = content.techDefs.get("techStorage" as never);
    expect(storage?.eraId).toBe("e1");
    expect(storage?.lossClass).toBe("criticalRecoverable");
    expect(storage?.prereqs).toEqual(["techPottery"]);

    const lens = content.techDefs.get("techLens" as never);
    expect(lens?.lossClass).toBe("rareIrreversible");
  });

  it("prereqs は ID 昇順へ正規化される(techTree の走査順の前提)", () => {
    const bundle = rawBundle();
    const tech = (clone(bundle.tech) as Record<string, unknown>[]).map((t) =>
      t["id"] === "techLens" ? { ...t, prereqs: ["techGlass", "techBlacksmithing"] } : t,
    );
    const content = load({ ...bundle, tech });
    expect(content.techDefs.get("techLens" as never)?.prereqs).toEqual([
      "techBlacksmithing",
      "techGlass",
    ]);
  });
});

describe("loadEngineContent — balance.eras(GDD 5.1)", () => {
  it("E1〜E3 が写り、base_era と era_multiplier が 1e6 化される", () => {
    const eras = load(rawBundle()).eraDefs;
    expect([...(eras?.keys() ?? [])]).toEqual(["e1", "e2", "e3"]);
    expect(toRaw(eras?.get("e1")?.baseEraFix ?? (0 as never))).toBe(30_000_000);
    expect(toRaw(eras?.get("e3")?.baseEraFix ?? (0 as never))).toBe(120_000_000);
    expect(toRaw(eras?.get("e3")?.multiplierFix ?? (0 as never))).toBe(4_000_000);
    expect(eras?.get("e3")?.gateTechId).toBe("techSteamEngine");
    expect(eras?.get("e3")?.criticalPathMax).toBe(4);
  });

  it("eras ブロックが無ければキーごと不在(M6 以前の content がそのまま通る)", () => {
    const bundle = withBalance((balance) => {
      delete balance["eras"];
    });
    const content = load(bundle);
    expect(content.eraDefs).toBeUndefined();
  });

  it("tech.era が eras に無ければ reject(GDD 5.1 の表との突合)", () => {
    const bundle = rawBundle();
    const tech = (clone(bundle.tech) as Record<string, unknown>[]).map((t) =>
      t["id"] === "techLens" ? { ...t, era: "e9" } : t,
    );
    expect(issuePaths({ ...bundle, tech })).toContain("tech.techLens.era");
  });

  it("壁テックが tech カテゴリに無ければ reject", () => {
    const bundle = withBalance((balance) => {
      const eras = balance["eras"] as Record<string, unknown>[];
      const first = eras[0];
      if (first !== undefined) first["gateTechId"] = "techGhost";
    });
    expect(issuePaths(bundle)).toContain("balance.eras.e1.gateTechId");
  });

  it("エラ ID / order の重複は reject", () => {
    const dupId = withBalance((balance) => {
      const eras = balance["eras"] as Record<string, unknown>[];
      const first = eras[0];
      if (first !== undefined) eras.push({ ...first });
    });
    expect(issuePaths(dupId).length).toBeGreaterThan(0);

    const dupOrder = withBalance((balance) => {
      const eras = balance["eras"] as Record<string, unknown>[];
      const second = eras[1];
      if (second !== undefined) second["order"] = 1;
    });
    expect(issuePaths(dupOrder)).toContain("balance.$.eras");
  });
});

describe("loadEngineContent — balance.recordMedia(GDD 11.1 追補)", () => {
  it("媒体 2 種が写り、GDD 追補の表どおりの値になる", () => {
    const params = load(rawBundle()).recordMedia;
    expect(params).toBeDefined();
    if (params === undefined) return;
    expect(toRaw(params.baseCostFix)).toBe(20_000_000);
    expect(params.baseDurationTicks).toBe(720);
    expect(params.printingTechId).toBe("techPrinting");
    expect(toRaw(params.printingCostMulFix)).toBe(500_000);
    expect(toRaw(params.printingTimeMulFix)).toBe(500_000);

    expect(toRaw(params.byMedium.stoneTablet.caravanWeightFix)).toBe(1_000_000);
    expect(params.byMedium.stoneTablet.flammable).toBe(false);
    expect(params.byMedium.stoneTablet.costResourceId).toBe("clay");

    expect(toRaw(params.byMedium.paper.caravanWeightFix)).toBe(250_000);
    expect(params.byMedium.paper.flammable).toBe(true);
    expect(params.byMedium.paper.costResourceId).toBe("paper");
  });

  it("engine の RECORD_MEDIA と byMedium のキーが 1 対 1", () => {
    const params = load(rawBundle()).recordMedia;
    expect(RECORD_MEDIA.every((medium) => params?.byMedium[medium] !== undefined)).toBe(true);
    expect(isRecordMedium("paper")).toBe(true);
    expect(isRecordMedium("papyrus")).toBe(false);
  });

  it("recordMedia ブロックが無ければキーごと不在(成文化不可・既存 content 互換)", () => {
    const bundle = withBalance((balance) => {
      delete balance["recordMedia"];
    });
    expect(load(bundle).recordMedia).toBeUndefined();
  });

  it("印刷テックが tech カテゴリに無ければ reject", () => {
    const bundle = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, unknown>;
      media["printingTechId"] = "techGhost";
    });
    expect(issuePaths(bundle)).toContain("balance.recordMedia.printingTechId");
  });

  it("媒体の性格が GDD 追補と逆転していたら reject(紙 = 安・速・軽・可燃)", () => {
    const heavyPaper = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, Record<string, unknown>>;
      const paper = media["paper"];
      if (paper !== undefined) paper["caravanWeight"] = 2;
    });
    expect(issuePaths(heavyPaper)).toContain("balance.$.recordMedia");

    const flammableStone = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, Record<string, unknown>>;
      const stone = media["stoneTablet"];
      if (stone !== undefined) stone["flammable"] = true;
    });
    expect(issuePaths(flammableStone)).toContain("balance.$.recordMedia");

    const slowPaper = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, Record<string, unknown>>;
      const paper = media["paper"];
      if (paper !== undefined) paper["timeMul"] = 2;
    });
    expect(issuePaths(slowPaper)).toContain("balance.$.recordMedia");
  });

  it("印刷バフの倍率が 1 を超える(= バフでない)値は reject", () => {
    const bundle = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, unknown>;
      media["printingCostMul"] = 1.5;
    });
    expect(issuePaths(bundle)).toContain("balance.$.recordMedia.printingCostMul");
  });

  it("1e6 で表現できない媒体倍率は reject(黙って丸めない・ADR-006)", () => {
    const bundle = withBalance((balance) => {
      const media = balance["recordMedia"] as Record<string, Record<string, unknown>>;
      const paper = media["paper"];
      if (paper !== undefined) paper["costMul"] = 0.123456789;
    });
    expect(issuePaths(bundle)).toContain("balance.recordMedia.paper.costMul");
  });
});

describe("裁定 N7 — 「学芸3連接 → 成文化+30%」は対象外を維持(M6 の判断)", () => {
  it("adjacency の codifySpeed は engine 未実装のまま(3 者関係ゆえ)", () => {
    expect(Object.keys(UNREPRESENTABLE_CONTENT_EFFECTS)).toContain("codifySpeed");
    expect(UNREPRESENTABLE_CONTENT_EFFECTS["codifySpeed"]).toContain("3 者関係");
    expect(UNREPRESENTABLE_CONTENT_EFFECTS["codifySpeed"]).toContain("algoVersion");
  });

  it("content が codifySpeed を使ったら reject される(黙って無視しない)", () => {
    const bundle = rawBundle();
    const adjacency = clone(bundle.adjacency) as Record<string, unknown>;
    const tagMatrix = adjacency["tagMatrix"] as Record<string, unknown>;
    tagMatrix["lore|lore"] = { effect: "codifySpeed", target: "any", valueFP: 0.3 };
    expect(issuePaths({ ...bundle, adjacency })).toContain("adjacency.tagMatrix.lore|lore.effect");
  });

  it("trait の codifySpeed は「記録して読み飛ばす」側のまま(理由文が M6 の実態と一致)", () => {
    expect(Object.keys(UNREPRESENTABLE_CONTENT_TRAIT_STATS)).toContain("codifySpeed");
    expect(UNREPRESENTABLE_CONTENT_TRAIT_STATS["codifySpeed"]).toContain("rules/codify.ts");
  });
});
