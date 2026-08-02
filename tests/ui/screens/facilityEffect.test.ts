// ---------------------------------------------------------------------------
// src/ui/screens/facilityEffect.ts のテスト(M61/FC6・2026-08-02差し戻しで
// storageCapacity 種別を追加)。
//
// 確認すること: (1) 就労スロットを持つ施設は "worker" (2) 寝床
// (bedCapacityByLevel あり・就労スロットなし)は "bedCapacity" + 実効果の文言
// (3) 保管庫(storage あり・就労スロットなし)は "storageCapacity" + 実効果の
// 文言(「効果は未実装」ではない・統率者検分での差し戻し) (4) 見張り台/療養所
// 相当(どれも無し)は "none" + 固定の未実装文言。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt } from "../../../src/engine/fp";
import type { FacilityDef } from "../../../src/engine/rules/types";
import { entityIdFromString } from "../../../src/engine/state/state";
import {
  DORMANT_FACILITY_EFFECT_TEXT,
  STORAGE_CAPACITY_EXCEEDED_WARNING_TEXT,
  bedCapacityAt,
  bedCapacityEffectText,
  facilityEffectKind,
  storageCapacityAt,
  storageCapacityEffectText,
  storageCapacityWouldCapExistingStock,
  storageTargetResourceIds,
} from "../../../src/ui/screens/facilityEffect";

const id = entityIdFromString;

function baseDef(overrides: Partial<FacilityDef> = {}): FacilityDef {
  return {
    id: id("testFacility"),
    tags: [],
    harshWork: false,
    outputPerTickByLevel: [1, 1, 1, 1, 1].map(fixFromInt),
    output: { kind: "research" },
    ...overrides,
  };
}

describe("facilityEffectKind", () => {
  it("就労スロットが1以上ある(Lvどこかで)なら worker", () => {
    const def = baseDef({ workerSlotsByLevel: [0, 1, 1, 1, 1] });
    expect(facilityEffectKind(def)).toBe("worker");
  });

  it("[寝床相当] 就労スロット全Lv0だが bedCapacityByLevel を持つなら bedCapacity", () => {
    const def = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      bedCapacityByLevel: [2, 3, 4, 5, 6],
    });
    expect(facilityEffectKind(def)).toBe("bedCapacity");
  });

  it("[保管庫相当] 就労スロット全Lv0だが storage を持つなら storageCapacity", () => {
    const def = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      storage: {
        capacityByLevel: [400, 460, 529, 608, 700].map(fixFromInt),
        resourceIds: null,
      },
    });
    expect(facilityEffectKind(def)).toBe("storageCapacity");
  });

  it("[見張り台/療養所相当] bedCapacityByLevel も storage も無ければ none", () => {
    const def = baseDef({ workerSlotsByLevel: [0, 0, 0, 0, 0] });
    expect(facilityEffectKind(def)).toBe("none");
  });

  it("workerSlotsByLevel 自体が省略(undefined)でも none 側に倒れる", () => {
    expect(facilityEffectKind(baseDef())).toBe("none");
  });
});

describe("bedCapacityAt / bedCapacityEffectText", () => {
  const bed = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    bedCapacityByLevel: [2, 3, 4, 5, 6],
  });

  it("Lv別の寝床上限を返す(Lv1=2、Lv5=6)", () => {
    expect(bedCapacityAt(bed, 1)).toBe(2);
    expect(bedCapacityAt(bed, 5)).toBe(6);
  });

  it("配列より大きいLvは最後の段の値", () => {
    expect(bedCapacityAt(bed, 9)).toBe(6);
  });

  it("bedCapacityByLevel が無ければ null", () => {
    expect(bedCapacityAt(baseDef(), 1)).toBeNull();
    expect(bedCapacityEffectText(baseDef())).toBeNull();
  });

  it("効果文言は寝床上限の値と目的を明記する(GDD 7.7)", () => {
    expect(bedCapacityEffectText(bed, 1)).toBe("寝床上限 +2(住民の漂着加入の上限を増やす)");
    expect(bedCapacityEffectText(bed, 3)).toBe("寝床上限 +4(住民の漂着加入の上限を増やす)");
  });

  it("Lv省略時はLv1として扱う(カタログ=建設前の既定表示)", () => {
    expect(bedCapacityEffectText(bed)).toBe(bedCapacityEffectText(bed, 1));
  });
});

describe("[M61/FC6・2026-08-02差し戻し] storageCapacityAt / storageCapacityEffectText", () => {
  const warehouseAllResources = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    storage: {
      capacityByLevel: [400, 460, 529, 608, 700].map(fixFromInt),
      resourceIds: null,
    },
  });
  const warehouseScoped = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    storage: {
      capacityByLevel: [400, 460, 529, 608, 700].map(fixFromInt),
      resourceIds: [id("firewood")],
    },
  });

  it("Lv別の保管上限を返す(Lv1=400、Lv5=700)", () => {
    expect(storageCapacityAt(warehouseAllResources, 1)).toBe(400);
    expect(storageCapacityAt(warehouseAllResources, 5)).toBe(700);
  });

  it("配列より大きいLvは最後の段の値", () => {
    expect(storageCapacityAt(warehouseAllResources, 9)).toBe(700);
  });

  it("storage が無ければ null", () => {
    expect(storageCapacityAt(baseDef(), 1)).toBeNull();
    expect(storageCapacityEffectText(baseDef())).toBeNull();
  });

  it("resourceIds が null(content に storedResourceIds が無い)なら「全資源」と明記する", () => {
    expect(storageTargetResourceIds(warehouseAllResources)).toBeNull();
    expect(storageCapacityEffectText(warehouseAllResources, 1)).toBe(
      "全資源の保管上限を設定(Lv1: 400)。上限を超えた分の産出は失われます。",
    );
  });

  it("resourceIds が指定されていれば「対象資源」と明記する(将来の絞り込みへの備え)", () => {
    expect(storageTargetResourceIds(warehouseScoped)).toEqual([id("firewood")]);
    expect(storageCapacityEffectText(warehouseScoped, 1)).toContain("対象資源の保管上限");
  });

  it("「効果は未実装」を含まない(統率者検分での差し戻し=虚偽表示の是正)", () => {
    expect(storageCapacityEffectText(warehouseAllResources, 1)).not.toContain("効果は未実装");
  });

  it("Lv省略時はLv1として扱う", () => {
    expect(storageCapacityEffectText(warehouseAllResources)).toBe(
      storageCapacityEffectText(warehouseAllResources, 1),
    );
  });
});

describe("[M61/FC6・2026-08-02差し戻し] storageCapacityWouldCapExistingStock", () => {
  const warehouseAllResources = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    storage: { capacityByLevel: [400].map(fixFromInt), resourceIds: null },
  });
  const warehouseScoped = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    storage: { capacityByLevel: [400].map(fixFromInt), resourceIds: [id("firewood")] },
  });

  it("いずれかの資源の在庫が上限を超えていれば true", () => {
    const resources = [
      { resourceId: id("firewood"), stockApprox: 500 },
      { resourceId: id("iron"), stockApprox: 10 },
    ];
    expect(storageCapacityWouldCapExistingStock(warehouseAllResources, 1, resources)).toBe(true);
  });

  it("全資源が上限未満なら false", () => {
    const resources = [
      { resourceId: id("firewood"), stockApprox: 100 },
      { resourceId: id("iron"), stockApprox: 10 },
    ];
    expect(storageCapacityWouldCapExistingStock(warehouseAllResources, 1, resources)).toBe(false);
  });

  it("resourceIds で絞られている場合、対象外の資源が超えていても false", () => {
    const resources = [{ resourceId: id("iron"), stockApprox: 999 }];
    expect(storageCapacityWouldCapExistingStock(warehouseScoped, 1, resources)).toBe(false);
  });

  it("storage を持たない施設は常に false", () => {
    expect(
      storageCapacityWouldCapExistingStock(baseDef(), 1, [
        { resourceId: id("firewood"), stockApprox: 999_999 },
      ]),
    ).toBe(false);
  });
});

describe("[M61/FC6・2026-08-02差し戻し] STORAGE_CAPACITY_EXCEEDED_WARNING_TEXT", () => {
  it("在庫が上限超であることと産出への影響を伝える文言を持つ", () => {
    expect(STORAGE_CAPACITY_EXCEEDED_WARNING_TEXT).toContain("上限");
    expect(STORAGE_CAPACITY_EXCEEDED_WARNING_TEXT).toContain("頭打ち");
  });
});

describe("DORMANT_FACILITY_EFFECT_TEXT(見張り台/療養所の固定文言)", () => {
  it("「効果は未実装」であることと理由(資源を消費するのみ)を含む", () => {
    expect(DORMANT_FACILITY_EFFECT_TEXT).toContain("効果は未実装");
    expect(DORMANT_FACILITY_EFFECT_TEXT).toContain("資源を消費するのみ");
  });
});
