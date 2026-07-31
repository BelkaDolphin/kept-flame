// ---------------------------------------------------------------------------
// src/ui/screens/contentLabels.ts のテスト(M30)。
//
// 確認すること: (1) 既知 ID は正しい日本語名を返す (2) 未登録 ID は raw ID を
// そのまま返す(捏造しない・PlaceholderScreen.tsx と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import { facilityLabel, resourceLabel, traitLabel } from "../../../src/ui/screens/contentLabels";

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
});

describe("contentLabels: 未登録 ID は捏造せず raw ID を返す", () => {
  it("facility/resource/trait いずれも未登録なら ID そのまま", () => {
    expect(facilityLabel(id("granary"))).toBe("granary");
    expect(resourceLabel(id("stone"))).toBe("stone");
    expect(traitLabel(id("traitUnknown"))).toBe("traitUnknown");
  });
});
