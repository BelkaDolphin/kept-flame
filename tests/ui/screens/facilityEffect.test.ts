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

import { fixFromInt, fixFromRaw } from "../../../src/engine/fp";
import type { FacilityDef } from "../../../src/engine/rules/types";
import { entityIdFromString } from "../../../src/engine/state/state";
import {
  DORMANT_FACILITY_EFFECT_TEXT,
  bedCapacityAt,
  bedCapacityEffectText,
  careCapacityAt,
  careCapacityEffectText,
  defenseAt,
  defenseEffectText,
  facilityEffectKind,
  facilityEffectTextOf,
  storageCapacityAt,
  storageCapacityEffectText,
  storageTargetResourceIds,
  workerBaseOutputAt,
  workerEffectHintText,
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

  it("[M73/R8-02・見張り台相当] 就労スロット全Lv0だが defenseByLevel を持つなら defense", () => {
    const def = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      defenseByLevel: [20, 23, 26, 30, 35].map(fixFromInt),
    });
    expect(facilityEffectKind(def)).toBe("defense");
  });

  it("[M73/R8-02・療養所相当] 就労スロット全Lv0だが careCapacityByLevel を持つなら careCapacity", () => {
    const def = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      careCapacityByLevel: [1, 1, 2, 2, 3],
    });
    expect(facilityEffectKind(def)).toBe("careCapacity");
  });

  it("効果フィールドを1つも持たなければ none(現行 content には該当なし)", () => {
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

  it("[M63/R4-A01 fatal] resourceIds が null(全資源)なら加算方式の式+このLvの寄与を明記する", () => {
    expect(storageTargetResourceIds(warehouseAllResources)).toBeNull();
    expect(storageCapacityEffectText(warehouseAllResources, 1)).toBe(
      "全資源の保管上限に加算(基礎400 + 建っている保管庫のLv合計×400)。" +
        "このLv1の寄与は +400。" +
        "上限を超えた産出は原則失われます(薪など一部の低次資源は超過分の一定比率が廃材になります)。",
    );
  });

  it("resourceIds が指定されていれば「対象資源」と明記する(将来の絞り込みへの備え)", () => {
    expect(storageTargetResourceIds(warehouseScoped)).toEqual([id("firewood")]);
    expect(storageCapacityEffectText(warehouseScoped, 1)).toContain("対象資源の保管上限");
  });

  it("「効果は未実装」を含まない(統率者検分での差し戻し=虚偽表示の是正)", () => {
    expect(storageCapacityEffectText(warehouseAllResources, 1)).not.toContain("効果は未実装");
  });

  it("[M63/R4-A01 fatal] 旧「上限を設定(Lv1: 400)」の虚偽表現を含まない(この倉庫単体が絶対上限であるかのような誤読を防ぐ)", () => {
    expect(storageCapacityEffectText(warehouseAllResources, 1)).not.toContain("上限を設定");
  });

  it("[M63/R4-A01 fatal] Lv が上がるほど「このLvの寄与」の数値も増える(加算対象がこの倉庫の寄与ぶんだけ増えることを表す)", () => {
    expect(storageCapacityEffectText(warehouseAllResources, 5)).toContain("このLv5の寄与は +700");
  });

  it("Lv省略時はLv1として扱う", () => {
    expect(storageCapacityEffectText(warehouseAllResources)).toBe(
      storageCapacityEffectText(warehouseAllResources, 1),
    );
  });
});

describe("[M62/FC9・R2-C01] workerBaseOutputAt / workerEffectHintText(カタログ効果ヒントの対称化)", () => {
  const worker = baseDef({
    workerSlotsByLevel: [1, 1, 1, 1, 1],
    outputPerTickByLevel: [1_000_000, 1_150_000, 1_322_500, 1_520_875, 1_749_006].map(fixFromRaw),
    output: { kind: "resource", resourceId: id("firewood") },
  });

  it("Lv別の基礎産出を返す(Lv1=1、配列より大きいLvは最後の段)", () => {
    expect(workerBaseOutputAt(worker, 1)).toBe(1);
    expect(workerBaseOutputAt(worker, 9)).toBeCloseTo(1.749006, 6);
  });

  it("outputPerTickByLevel が空なら null", () => {
    expect(workerBaseOutputAt(baseDef({ outputPerTickByLevel: [] }), 1)).toBeNull();
  });

  it("worker系(資源産出)は「Lv1基礎産出 X/分 資源名」の文言を返す", () => {
    const text = workerEffectHintText(worker, 1);
    expect(text).toContain("Lv1基礎産出");
    expect(text).toContain("/分");
    expect(text).toContain("薪");
    expect(text).toContain("就労者が必要");
  });

  it("研究点産出(output.kind='research')は「研究点」と表示する", () => {
    const researchWorker = baseDef({
      workerSlotsByLevel: [1, 1, 1, 1, 1],
      outputPerTickByLevel: [2, 2, 2, 2, 2].map(fixFromInt),
      output: { kind: "research" },
    });
    expect(workerEffectHintText(researchWorker, 1)).toContain("研究点");
  });

  it("基礎産出が0(または無い)なら null(捏造しない)", () => {
    const zeroOutput = baseDef({
      workerSlotsByLevel: [1, 1, 1, 1, 1],
      outputPerTickByLevel: [0, 0, 0, 0, 0].map(fixFromInt),
      output: { kind: "resource", resourceId: id("firewood") },
    });
    expect(workerEffectHintText(zeroOutput, 1)).toBeNull();
    expect(workerEffectHintText(baseDef({ outputPerTickByLevel: [] }), 1)).toBeNull();
  });

  it("Lv省略時はLv1として扱う(カタログ=建設前の既定表示)", () => {
    expect(workerEffectHintText(worker)).toBe(workerEffectHintText(worker, 1));
  });

  it("寝床/保管庫/非稼働の3種と同じ「効果ヒント」の枠に収まる文言(短すぎない・空文字でない)", () => {
    const text = workerEffectHintText(worker, 1);
    expect(text).not.toBeNull();
    expect(text?.length).toBeGreaterThan(0);
  });
});

describe("DORMANT_FACILITY_EFFECT_TEXT(効果フィールドを持たない施設の固定文言)", () => {
  it("「効果は未実装」であることと理由(資源を消費するのみ)を含む", () => {
    expect(DORMANT_FACILITY_EFFECT_TEXT).toContain("効果は未実装");
    expect(DORMANT_FACILITY_EFFECT_TEXT).toContain("資源を消費するのみ");
  });
});

// --- [M73/R8-02 fatal] 見張り台 / 療養所の実効果(M66 実装済み)------------------

describe("[M73/R8-02] defenseAt / defenseEffectText(見張り台)", () => {
  const watchtower = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    defenseByLevel: [20, 23, 26, 30, 35].map(fixFromInt),
  });

  it("Lv別の防衛係数を返す(Lv1=20・Lv5=35・配列超えは最後の段)", () => {
    expect(defenseAt(watchtower, 1)).toBe(20);
    expect(defenseAt(watchtower, 5)).toBe(35);
    expect(defenseAt(watchtower, 9)).toBe(35);
  });

  it("defenseByLevel が無ければ null(捏造しない)", () => {
    expect(defenseAt(baseDef(), 1)).toBeNull();
    expect(defenseEffectText(baseDef())).toBeNull();
  });

  it("実効果(防衛戦力への加算・撃退/略奪・増築で増える)を明記し「効果は未実装」と言わない", () => {
    const text = defenseEffectText(watchtower, 1, 1.5) ?? "";
    expect(text).toContain("防衛戦力");
    expect(text).toContain("+20");
    expect(text).toContain("1.5倍");
    expect(text).toContain("撃退");
    expect(text).toContain("増築すると寄与が増えます");
    expect(text).not.toContain("効果は未実装");
  });

  it("配置ボーナス倍率が渡されなければ倍率の数値を出さない(content 由来の値を捏造しない)", () => {
    const text = defenseEffectText(watchtower, 1) ?? "";
    expect(text).toContain("外周");
    expect(text).not.toContain("倍になります");
  });
});

describe("[M73/R8-02] careCapacityAt / careCapacityEffectText(療養所)", () => {
  const infirmary = baseDef({
    workerSlotsByLevel: [0, 0, 0, 0, 0],
    careCapacityByLevel: [1, 1, 2, 2, 3],
  });

  it("Lv別の休養枠を返す(Lv1=1・Lv5=3・配列超えは最後の段)", () => {
    expect(careCapacityAt(infirmary, 1)).toBe(1);
    expect(careCapacityAt(infirmary, 5)).toBe(3);
    expect(careCapacityAt(infirmary, 9)).toBe(3);
  });

  it("careCapacityByLevel が無ければ null(捏造しない)", () => {
    expect(careCapacityAt(baseDef(), 1)).toBeNull();
    expect(careCapacityEffectText(baseDef())).toBeNull();
  });

  it("実効果(休養枠・想起困難の住民が自動で休養・増築で枠増)を明記し「効果は未実装」と言わない", () => {
    const text = careCapacityEffectText(infirmary, 3, "約1日") ?? "";
    expect(text).toContain("休養");
    expect(text).toContain("2人");
    expect(text).toContain("想起困難");
    expect(text).toContain("約1日");
    expect(text).toContain("増築すると枠が増えます");
    expect(text).not.toContain("効果は未実装");
  });

  it("回復時間が渡されなければ時間の数値を出さない(content 由来の値を捏造しない)", () => {
    const text = careCapacityEffectText(infirmary, 1) ?? "";
    expect(text).toContain("回復までの時間が短くなります");
  });
});

describe("[M73/R8-02] facilityEffectTextOf(②カタログと③施設詳細の単一入口)", () => {
  it("種別ごとに対応する文言を返す(見張り台/療養所は未実装文言に落ちない)", () => {
    const watchtower = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      defenseByLevel: [20, 23, 26, 30, 35].map(fixFromInt),
    });
    const infirmary = baseDef({
      workerSlotsByLevel: [0, 0, 0, 0, 0],
      careCapacityByLevel: [1, 1, 2, 2, 3],
    });
    expect(facilityEffectTextOf(watchtower, 1)).toBe(defenseEffectText(watchtower, 1, null));
    expect(facilityEffectTextOf(infirmary, 1)).toBe(careCapacityEffectText(infirmary, 1, null));
    expect(facilityEffectTextOf(watchtower, 1)).not.toBe(DORMANT_FACILITY_EFFECT_TEXT);
    expect(facilityEffectTextOf(infirmary, 1)).not.toBe(DORMANT_FACILITY_EFFECT_TEXT);
  });

  it("効果フィールドを1つも持たない施設だけが未実装文言になる", () => {
    const dormant = baseDef({ workerSlotsByLevel: [0, 0, 0, 0, 0] });
    expect(facilityEffectTextOf(dormant, 1)).toBe(DORMANT_FACILITY_EFFECT_TEXT);
  });
});
