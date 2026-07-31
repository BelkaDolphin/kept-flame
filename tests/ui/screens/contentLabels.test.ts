// ---------------------------------------------------------------------------
// src/ui/screens/contentLabels.ts のテスト(M30)。
//
// 確認すること: (1) 既知 ID は正しい日本語名を返す (2) 未登録 ID は raw ID を
// そのまま返す(捏造しない・PlaceholderScreen.tsx と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import {
  distanceBandLabel,
  eraLabel,
  facilityLabel,
  outpostTypeLabel,
  resourceLabel,
  techLabel,
  traitLabel,
} from "../../../src/ui/screens/contentLabels";

const id = entityIdFromString;

describe("contentLabels: 既知 ID の日本語名", () => {
  it("facility: 現行 content の 3 種(hearth/forge/workbench)", () => {
    expect(facilityLabel(id("hearth"))).toBe("かまど");
    expect(facilityLabel(id("forge"))).toBe("鍛冶場");
    expect(facilityLabel(id("workbench"))).toBe("作業台");
  });

  it("resource: GDD 6.7/9.1/11.1 の 5 資源", () => {
    expect(resourceLabel(id("firewood"))).toBe("薪");
    expect(resourceLabel(id("iron"))).toBe("鉄");
    expect(resourceLabel(id("clay"))).toBe("粘土");
    expect(resourceLabel(id("paper"))).toBe("紙");
    expect(resourceLabel(id("waste"))).toBe("廃材");
  });

  it("trait: GDD 7.2 の 8 種", () => {
    expect(traitLabel(id("traitScholar"))).toBe("学者");
    expect(traitLabel(id("traitFrail"))).toBe("病弱");
    expect(traitLabel(id("traitArtisan"))).toBe("職人");
    expect(traitLabel(id("traitExplorer"))).toBe("探索者");
    expect(traitLabel(id("traitMemoryKeeper"))).toBe("記憶巧者");
    expect(traitLabel(id("traitOptimist"))).toBe("楽観");
    expect(traitLabel(id("traitPessimist"))).toBe("悲観");
    expect(traitLabel(id("traitStrongArm"))).toBe("怪力");
  });

  it("[M31] tech: content/tech.json の 24 本すべてが登録済み", () => {
    const allTechIds = [
      "techFireStarting",
      "techPottery",
      "techBasketWeaving",
      "techStorage",
      "techStoneTools",
      "techWaterDrawing",
      "techGatheringHut",
      "techBedding",
      "techCharcoalKiln",
      "techCeramics",
      "techSmelting",
      "techAgriculture",
      "techBoneHideWorking",
      "techBasicMedicine",
      "techIrrigation",
      "techBlastFurnace",
      "techBlacksmithing",
      "techMachineParts",
      "techSteamEngine",
      "techGlass",
      "techMetalCasting",
      "techWaterWheel",
      "techPrinting",
      "techLens",
    ] as const;
    for (const techId of allTechIds) {
      expect(techLabel(id(techId))).not.toBe(techId);
    }
    // GDD 5.2 が直接名指しする代表テック/壁テックの一部を実値まで固定する。
    expect(techLabel(id("techFireStarting"))).toBe("火起こし");
    expect(techLabel(id("techStorage"))).toBe("貯蔵"); // era e1 の gateTechId
    expect(techLabel(id("techSmelting"))).toBe("製錬"); // era e2 の gateTechId
    expect(techLabel(id("techSteamEngine"))).toBe("蒸気機関"); // era e3 の gateTechId
  });

  it("[M31] era: GDD 5.2 の 3 段(E1〜E3)", () => {
    expect(eraLabel("e1")).toBe("灰の時代");
    expect(eraLabel("e2")).toBe("窯と畑の時代");
    expect(eraLabel("e3")).toBe("鉄と歯車の時代");
  });

  it("[M32] outpostType: GDD 9.2 [2026-07-31裁定] の 3 種", () => {
    expect(outpostTypeLabel(id("outpostMine"))).toBe("鉱山");
    expect(outpostTypeLabel(id("outpostFarm"))).toBe("農園");
    expect(outpostTypeLabel(id("outpostForest"))).toBe("林");
  });

  it("[M32] resource: 農園が産出する grain(GDD 9.2)", () => {
    expect(resourceLabel(id("grain"))).toBe("穀物");
  });

  it("[M32] distanceBand: 裁定 B7(近郊/遠隔/深部)", () => {
    expect(distanceBandLabel("near")).toBe("近郊");
    expect(distanceBandLabel("far")).toBe("遠隔");
    expect(distanceBandLabel("deep")).toBe("深部");
  });
});

describe("contentLabels: [M32] outpostType の未登録 ID も捏造せず raw ID を返す", () => {
  it("outpostTypeLabel", () => {
    expect(outpostTypeLabel(id("outpostQuarry"))).toBe("outpostQuarry");
  });
});

describe("contentLabels: 未登録 ID は捏造せず raw ID を返す", () => {
  it("facility/resource/trait いずれも未登録なら ID そのまま", () => {
    expect(facilityLabel(id("granary"))).toBe("granary");
    expect(resourceLabel(id("stone"))).toBe("stone");
    expect(traitLabel(id("traitUnknown"))).toBe("traitUnknown");
  });

  it("[M31] tech/era も未登録なら ID そのまま(era は null なら '?')", () => {
    expect(techLabel(id("techUnknown"))).toBe("techUnknown");
    expect(eraLabel("e9")).toBe("e9");
    expect(eraLabel(null)).toBe("?");
  });
});
