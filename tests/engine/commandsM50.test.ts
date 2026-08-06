// ---------------------------------------------------------------------------
// M50: engine 配線・コマンド補完の束ね(`src/engine/commands.ts` の追加分)。
//
// 固定するのは 5 件:
//   (1) 建設 / 増築コストの支払い(GDD 12.1 [2026-07-30裁定])と、不足時の
//       **機械可読 reject**(検収条件そのもの)+ 廃材 3 出口(1) の 20% 代替
//   (2) `beginResearch`(研究対象の選択)。**セーブ往復で保持される**(検収条件)
//   (3) 成文化の scheduler 段50 結線(単体側。golden は sc39 が担当)
//   (4) 成文化キューの取消(additive)
//   (5) 衛星拠点の設置 / 放棄 / 駐在割当 / 駐在解除(additive)と、
//       二重配置検査(`assertNoDoubleStationedResidents`)との整合
//
// golden vector で観測できるもの(成文化完了・研究選択の効き方)は
// `conformance/vectors/sc39-*` / `sc40-*` が担当し、本ファイルは
// **コマンド層(= advance を通らない経路)**を担当する分担にしてある。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";
import {
  apply,
  facilityBuildCostFix,
  facilityBuildCostLines,
  facilityUpgradeCostFix,
  facilityUpgradeCostLines,
  type Command,
  type CommandRejectionCode,
} from "../../src/engine/commands";
import { FIX_ONE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import { currentCodification } from "../../src/engine/rules/codify";
import { computeProductionRates } from "../../src/engine/rules/production";
import { currentResearch, selectedResearch } from "../../src/engine/rules/research";
import { assertNoDoubleStationedResidents } from "../../src/engine/rules/outpost";
import type {
  EngineContent,
  FacilityDef,
  OutpostParams,
  OutpostTypeDef,
  StorageParams,
  TechDef,
} from "../../src/engine/rules/types";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import {
  OUTPOST_RESIDENTS_MAX,
  allOutposts,
  getEntity,
  getOutpost,
  requireEntity,
  type CodifyState,
  type EntityState,
  type GameState,
} from "../../src/engine/state/state";
import {
  createGameState,
  putEntity,
  removeEntity,
  setField,
  updateEntity,
} from "../../src/engine/state/update";
import {
  HEARTH,
  META,
  STUDY_DESK,
  TECH_BRONZE,
  TECH_IRON,
  WOOD,
  content as baseContent,
  facility,
  id,
  lvCurve,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// --- フィクスチャ -----------------------------------------------------------

const WASTE = id("waste");
/** [M65] 追加コスト行の資源(木炭)。 */
const CHARCOAL = id("charcoal");

/** [M50] コスト付きのかまど。Lv1 建設 10 / 増築は Lv1→2 が 20、以降 30/40/50。 */
const HEARTH_WITH_COST: FacilityDef = {
  id: HEARTH.id,
  tags: HEARTH.tags,
  harshWork: HEARTH.harshWork,
  outputPerTickByLevel: HEARTH.outputPerTickByLevel,
  output: HEARTH.output,
  cost: {
    resourceId: WOOD,
    buildFix: fixFromInt(10),
    upgradeByLevel: [
      fixFromInt(20),
      fixFromInt(30),
      fixFromInt(40),
      fixFromInt(50),
      fixFromInt(60),
    ],
  },
};

const STORAGE_WITH_WASTE: StorageParams = {
  wasteResourceId: WASTE,
  baseCapacityByResourceId: new Map(),
  wasteConversionRatioByResourceId: new Map(),
  wasteToResearchRatioFix: fixFromRaw(100_000),
  // GDD 6.7 [2026-07-28追補] の建設代替上限 20%。
  buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
  codifyWasteSubstitutionMaxFix: FIX_ZERO,
};

/** 前提テック 1 本を持つ tech(prereqNotMet の検証用)。 */
const TECH_STEEL: TechDef = {
  id: id("techSteel"),
  researchCostFix: fixFromInt(200),
  prereqs: [TECH_BRONZE.id],
};

const OUTPOST_FOREST: OutpostTypeDef = {
  id: id("outpostForest"),
  resourceId: WOOD,
  supplyPerResidentTickByLevel: lvCurve(1),
  upkeep: { baseFoodFix: fixFromRaw(100_000), baseMoraleCareFix: fixFromRaw(50_000) },
  hazard: {
    intensityFix: fixFromRaw(100_000),
    growthPerDayFix: FIX_ZERO,
    minFix: FIX_ZERO,
    maxFix: FIX_ONE,
  },
  shadeSensitivityFix: FIX_ZERO,
};

const OUTPOST_PARAMS: OutpostParams = {
  distanceBandUpkeepMulFix: {
    near: FIX_ONE,
    far: fixFromRaw(1_400_000),
    deep: fixFromRaw(1_800_000),
  },
};

function contentWith(overrides: Partial<EngineContent> = {}): EngineContent {
  return { ...baseContent(), ...overrides };
}

/** コストを持つ content(建設/増築の支払い経路)。 */
const CONTENT_COST = contentWith({
  facilityDefs: new Map([
    [HEARTH_WITH_COST.id, HEARTH_WITH_COST],
    [STUDY_DESK.id, STUDY_DESK],
  ]),
});

/** 上に加えて廃材 3 出口(1) が効く content。 */
const CONTENT_COST_WASTE = contentWith({
  facilityDefs: CONTENT_COST.facilityDefs,
  storage: STORAGE_WITH_WASTE,
});

/** 研究の前提関係を持つ content(beginResearch の prereq 検査)。 */
const CONTENT_TECH = contentWith({
  techDefs: new Map([
    [TECH_BRONZE.id, TECH_BRONZE],
    [TECH_IRON.id, TECH_IRON],
    [TECH_STEEL.id, TECH_STEEL],
  ]),
});

/** 衛星拠点が使える content。 */
const CONTENT_OUTPOST = contentWith({
  outpostTypeDefs: new Map([[OUTPOST_FOREST.id, OUTPOST_FOREST]]),
  outpost: OUTPOST_PARAMS,
});

const CELL_A = 14;
const CELL_FREE = 21;

function accept(state: GameState, content: EngineContent, command: Command | Command[]): GameState {
  const result = apply(state, content, command);
  if (!result.ok) {
    throw new Error(`予期しない reject: ${result.rejection.code} / ${result.rejection.message}`);
  }
  return result.state;
}

function rejectCodeOf(
  state: GameState,
  content: EngineContent,
  command: Command | Command[],
): CommandRejectionCode {
  const result = apply(state, content, command);
  if (result.ok) throw new Error("reject されるはずのコマンドが通った");
  return result.rejection.code;
}

function stockOf(state: GameState, entityName: string): number {
  return toRaw(requireEntity(state, id(entityName), "resource").stock);
}

// --- 1. 建設 / 増築コストの支払い(GDD 12.1 [2026-07-30裁定]) ----------------

function costBoard(woodHuman = 100, extra: readonly EntityState[] = []): GameState {
  return stateOf([
    facility("fHearth", HEARTH.id, CELL_A),
    resource("wStock", WOOD, woodHuman),
    ...extra,
  ]);
}

const PLACE: Command = {
  kind: "placeFacility",
  facilityId: id("fNew"),
  defId: HEARTH.id,
  cellIndex: CELL_FREE,
};

const UPGRADE: Command = { kind: "upgradeFacility", facilityId: id("fHearth") };

describe("[M50] 建設 / 増築コストの支払い", () => {
  it("配置は buildCost ぶんの資源を引く", () => {
    const next = accept(costBoard(), CONTENT_COST, PLACE);
    expect(stockOf(next, "wStock")).toBe(90_000_000); // 100 - 10
    expect(requireEntity(next, id("fNew"), "facility").level).toBe(1);
  });

  it("増築は Lv 別カーブ(index = Lv-1)ぶんの資源を引く", () => {
    // Lv1 → Lv2 は upgradeByLevel[0] = 20。
    const lv2 = accept(costBoard(), CONTENT_COST, UPGRADE);
    expect(stockOf(lv2, "wStock")).toBe(80_000_000);
    expect(requireEntity(lv2, id("fHearth"), "facility").level).toBe(2);
    // Lv2 → Lv3 は upgradeByLevel[1] = 30(同じコマンドを続けて 2 回目)。
    const lv3 = accept(lv2, CONTENT_COST, UPGRADE);
    expect(stockOf(lv3, "wStock")).toBe(50_000_000);
    expect(requireEntity(lv3, id("fHearth"), "facility").level).toBe(3);
  });

  it("コスト定義を持たない facility 定義では無料(engine フィクスチャの縮約経路)", () => {
    expect(facilityBuildCostFix(HEARTH)).toBeUndefined();
    expect(facilityUpgradeCostFix(HEARTH, 1)).toBeUndefined();
    const next = accept(costBoard(0), contentWith(), PLACE);
    expect(stockOf(next, "wStock")).toBe(0);
  });

  it("在庫不足は insufficientResource で reject し、必要量 / 在庫が機械可読で載る(検収条件)", () => {
    const result = apply(costBoard(5), CONTENT_COST, PLACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("insufficientResource");
    expect(result.rejection.resourceId).toBe(WOOD);
    expect(result.rejection.requiredRaw).toBe(10_000_000);
    expect(result.rejection.availableRaw).toBe(5_000_000);
    expect(result.rejection.subjectId).toBe(HEARTH.id);
  });

  it("reject されたら state は 1 bit も動かない(部分適用しない)", () => {
    const before = costBoard(5);
    const result = apply(before, CONTENT_COST, PLACE);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(toSerializable(before))).toBe(
      JSON.stringify(toSerializable(costBoard(5))),
    );
  });

  it("増築の在庫不足も reject し、Lv は上がらない", () => {
    const board = costBoard(5);
    expect(rejectCodeOf(board, CONTENT_COST, UPGRADE)).toBe("insufficientResource");
    expect(requireEntity(board, id("fHearth"), "facility").level).toBe(1);
  });

  it("構造的に不可能な配置は資源不足より先に、その理由で reject する", () => {
    // 在庫 0 でも「占有セル」の方が先に報告される(commands.ts の検査順)。
    const occupied: Command = { ...PLACE, cellIndex: CELL_A } as Command;
    expect(rejectCodeOf(costBoard(0), CONTENT_COST, occupied)).toBe("cellOccupied");
  });

  it("上限 Lv でも資源不足より先に levelAtMax(構造的な不可能が優先)", () => {
    let board = costBoard(1000);
    for (let level = 1; level < 5; level++) board = accept(board, CONTENT_COST, UPGRADE);
    expect(requireEntity(board, id("fHearth"), "facility").level).toBe(5);
    const drained = updateEntity(board, id("wStock"), "resource", (r) =>
      setField(r, "stock", FIX_ZERO),
    );
    expect(rejectCodeOf(drained, CONTENT_COST, UPGRADE)).toBe("levelAtMax");
  });
});

describe("[M50] 廃材 3 出口(1): 建設 / 増築コストの 20% 代替(GDD 6.7)", () => {
  it("廃材が十分にあれば 20% ぶんが廃材で払われる", () => {
    const board = costBoard(100, [resource("wasteStock", WASTE, 50)]);
    const next = accept(board, CONTENT_COST_WASTE, PLACE);
    // コスト 10 のうち 20% = 2 が廃材、残り 8 が本命資源。
    expect(stockOf(next, "wStock")).toBe(92_000_000);
    expect(stockOf(next, "wasteStock")).toBe(48_000_000);
  });

  it("廃材が上限に満たなければ在庫ぶんだけ代替する(残りは本命資源)", () => {
    const board = costBoard(100, [resource("wasteStock", WASTE, 1)]);
    const next = accept(board, CONTENT_COST_WASTE, PLACE);
    expect(stockOf(next, "wStock")).toBe(91_000_000); // 10 - 1
    expect(stockOf(next, "wasteStock")).toBe(0);
  });

  it("増築にも同じ代替が効く(GDD 6.7 の文言は増築側)", () => {
    const board = costBoard(100, [resource("wasteStock", WASTE, 50)]);
    const next = accept(board, CONTENT_COST_WASTE, UPGRADE);
    // コスト 20 のうち 20% = 4 が廃材。
    expect(stockOf(next, "wStock")).toBe(84_000_000);
    expect(stockOf(next, "wasteStock")).toBe(46_000_000);
  });

  it("storage ブロックが無い content では代替 0(建設そのものは可能)", () => {
    const board = costBoard(100, [resource("wasteStock", WASTE, 50)]);
    const next = accept(board, CONTENT_COST, PLACE);
    expect(stockOf(next, "wStock")).toBe(90_000_000);
    expect(stockOf(next, "wasteStock")).toBe(50_000_000);
  });

  it("代替を数えても足りなければ reject する(黙って半端に払わない)", () => {
    const board = costBoard(5, [resource("wasteStock", WASTE, 50)]);
    // 代替上限は 2 なので本命資源が 8 要る。在庫 5 では足りない。
    expect(rejectCodeOf(board, CONTENT_COST_WASTE, PLACE)).toBe("insufficientResource");
  });
});

// --- 1b. [M65] 複数資源の建設 / 増築コスト -----------------------------------
//
//   2026-08-06裁定(ロードマップ M65)。`FacilityCostDef.extraLines` が入った
//   経路を固定する。**単一資源(extraLines なし)の挙動は §1 が M50 のまま
//   固定しており、そちらが 1 件も変わらないことが後方互換の証拠**である。

/** [M65] 主資源 = 薪 10 + 追加行 = 木炭 4(増築は 8/12/16/20/24)のかまど。 */
const HEARTH_MULTI_COST: FacilityDef = {
  id: HEARTH.id,
  tags: HEARTH.tags,
  harshWork: HEARTH.harshWork,
  outputPerTickByLevel: HEARTH.outputPerTickByLevel,
  output: HEARTH.output,
  cost: {
    resourceId: WOOD,
    buildFix: fixFromInt(10),
    upgradeByLevel: [
      fixFromInt(20),
      fixFromInt(30),
      fixFromInt(40),
      fixFromInt(50),
      fixFromInt(60),
    ],
    extraLines: [
      {
        resourceId: CHARCOAL,
        buildFix: fixFromInt(4),
        upgradeByLevel: [
          fixFromInt(8),
          fixFromInt(12),
          fixFromInt(16),
          fixFromInt(20),
          fixFromInt(24),
        ],
      },
    ],
  },
};

const CONTENT_MULTI_COST = contentWith({
  facilityDefs: new Map([
    [HEARTH_MULTI_COST.id, HEARTH_MULTI_COST],
    [STUDY_DESK.id, STUDY_DESK],
  ]),
});

const CONTENT_MULTI_COST_WASTE = contentWith({
  facilityDefs: CONTENT_MULTI_COST.facilityDefs,
  storage: STORAGE_WITH_WASTE,
});

function multiCostBoard(woodHuman = 100, charcoalHuman = 100): GameState {
  return stateOf([
    facility("fHearth", HEARTH.id, CELL_A),
    resource("wStock", WOOD, woodHuman),
    resource("cStock", CHARCOAL, charcoalHuman),
  ]);
}

describe("[M65] 複数資源の建設 / 増築コスト", () => {
  it("配置は全行ぶんを引く(主資源 + 追加行)", () => {
    const next = accept(multiCostBoard(), CONTENT_MULTI_COST, PLACE);
    expect(stockOf(next, "wStock")).toBe(90_000_000); // 100 - 10
    expect(stockOf(next, "cStock")).toBe(96_000_000); // 100 - 4
    expect(requireEntity(next, id("fNew"), "facility").level).toBe(1);
  });

  it("増築も全行ぶんを Lv 別カーブで引く", () => {
    const lv2 = accept(multiCostBoard(), CONTENT_MULTI_COST, UPGRADE);
    expect(stockOf(lv2, "wStock")).toBe(80_000_000); // 100 - 20
    expect(stockOf(lv2, "cStock")).toBe(92_000_000); // 100 - 8
    expect(requireEntity(lv2, id("fHearth"), "facility").level).toBe(2);
  });

  it("追加行の資源が足りなければ reject し、state は 1 bit も動かない", () => {
    const before = multiCostBoard(100, 3);
    const result = apply(before, CONTENT_MULTI_COST, PLACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("insufficientResource");
    expect(result.rejection.resourceId).toBe(CHARCOAL);
    expect(result.rejection.requiredRaw).toBe(4_000_000);
    expect(result.rejection.availableRaw).toBe(3_000_000);
    expect(JSON.stringify(toSerializable(before))).toBe(
      JSON.stringify(toSerializable(multiCostBoard(100, 3))),
    );
  });

  it("不足の報告順は「主資源 → 追加行」(決定論)", () => {
    const result = apply(multiCostBoard(1, 1), CONTENT_MULTI_COST, PLACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.resourceId).toBe(WOOD);
  });

  it("廃材代替は第1行(主資源)にだけ掛かる(廃材在庫の二重コミットを避ける)", () => {
    const board = stateOf([
      facility("fHearth", HEARTH.id, CELL_A),
      resource("wStock", WOOD, 100),
      resource("cStock", CHARCOAL, 100),
      resource("wasteStock", WASTE, 50),
    ]);
    const next = accept(board, CONTENT_MULTI_COST_WASTE, PLACE);
    // 主資源 10 のうち 20% = 2 が廃材。追加行の木炭 4 は満額。
    expect(stockOf(next, "wStock")).toBe(92_000_000);
    expect(stockOf(next, "cStock")).toBe(96_000_000);
    expect(stockOf(next, "wasteStock")).toBe(48_000_000);
  });

  it("facilityBuildCostLines / facilityUpgradeCostLines が全行を返す", () => {
    const buildLines = facilityBuildCostLines(HEARTH_MULTI_COST);
    expect(buildLines.map((line) => line.resourceId)).toEqual([WOOD, CHARCOAL]);
    expect(buildLines.map((line) => toRaw(line.costFix))).toEqual([10_000_000, 4_000_000]);
    const upgradeLines = facilityUpgradeCostLines(HEARTH_MULTI_COST, 2);
    expect(upgradeLines.map((line) => toRaw(line.costFix))).toEqual([30_000_000, 12_000_000]);
    // 単一資源の定義は 1 行だけ(M50 と同じ経路)。
    expect(facilityBuildCostLines(HEARTH_WITH_COST).map((line) => line.resourceId)).toEqual([WOOD]);
    // コスト定義そのものが無ければ空 = 無料。
    expect(facilityBuildCostLines(HEARTH)).toEqual([]);
    expect(facilityUpgradeCostLines(HEARTH, 1)).toEqual([]);
  });
});

// --- 2. beginResearch(研究対象の選択・GDD 5) -------------------------------

function researchBoard(extra: readonly EntityState[] = []): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fDesk") }),
    facility("fDesk", STUDY_DESK.id, CELL_A, [id("aRui")]),
    ...extra,
  ]);
}

describe("[M50] beginResearch(研究対象の選択)", () => {
  it("新しい research entity を作って選択する", () => {
    const next = accept(researchBoard(), CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rBronze"),
      techId: TECH_BRONZE.id,
    });
    expect(next.selectedResearchId).toBe(id("rBronze"));
    expect(requireEntity(next, id("rBronze"), "research").techId).toBe(TECH_BRONZE.id);
    expect(currentResearch(next)?.id).toBe(id("rBronze"));
  });

  it("ID 昇順で先頭でない研究を選ぶと、そちらへ研究点が入る(縮約の解消)", () => {
    const board = researchBoard([
      research("rAlpha", TECH_BRONZE.id, 0),
      research("rBravo", TECH_IRON.id, 0),
    ]);
    expect(currentResearch(board)?.id).toBe(id("rAlpha")); // 選択なし = 従来の縮約
    const next = accept(board, CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rUnused"),
      techId: TECH_IRON.id,
    });
    expect(next.selectedResearchId).toBe(id("rBravo"));
    expect(currentResearch(next)?.id).toBe(id("rBravo"));
    // 既存 entity を選び直しただけなので、渡した researchId の entity は作らない。
    expect(getEntity(next, id("rUnused"))).toBeUndefined();
  });

  it("選択がセーブ往復で保持される(検収条件)", () => {
    const next = accept(researchBoard(), CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rBronze"),
      techId: TECH_BRONZE.id,
    });
    const roundTripped = fromSerializable(JSON.parse(JSON.stringify(toSerializable(next))));
    expect(roundTripped.selectedResearchId).toBe(id("rBronze"));
    expect(currentResearch(roundTripped)?.id).toBe(id("rBronze"));
    expect(JSON.stringify(toSerializable(roundTripped))).toBe(JSON.stringify(toSerializable(next)));
  });

  it("未選択なら直列化形にキーが現れない(M50 以前のセーブとバイト同一の根拠)", () => {
    const raw = toSerializable(researchBoard()) as Record<string, unknown>;
    expect("selectedResearchId" in raw).toBe(false);
  });

  it("advance が選択された研究へ研究点を入れる(scheduler との結線)", () => {
    const board = researchBoard([
      research("rAlpha", TECH_BRONZE.id, 0),
      research("rBravo", TECH_IRON.id, 0),
    ]);
    const selected = accept(board, CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rUnused"),
      techId: TECH_IRON.id,
    });
    const advanced = advance(selected, createAdvanceContext(selected, CONTENT_TECH), 10);
    expect(toRaw(requireEntity(advanced, id("rAlpha"), "research").progress)).toBe(0);
    expect(toRaw(requireEntity(advanced, id("rBravo"), "research").progress)).toBeGreaterThan(0);
  });

  it("content に無い tech は unknownContentDef", () => {
    expect(
      rejectCodeOf(researchBoard(), CONTENT_TECH, {
        kind: "beginResearch",
        researchId: id("rGhost"),
        techId: id("techGhost"),
      }),
    ).toBe("unknownContentDef");
  });

  it("前提テックが未解禁なら prereqNotMet(GDD 5 / 12.1)", () => {
    const result = apply(researchBoard(), CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rSteel"),
      techId: TECH_STEEL.id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("prereqNotMet");
    expect(result.rejection.subjectId).toBe(TECH_BRONZE.id);
  });

  it("前提が解禁済みなら通る", () => {
    const unlocked = putEntity(researchBoard(), {
      kind: "research",
      id: id("rBronze"),
      techId: TECH_BRONZE.id,
      progress: fixFromInt(100),
      completedTick: 5,
    });
    const next = accept(unlocked, CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rSteel"),
      techId: TECH_STEEL.id,
    });
    expect(next.selectedResearchId).toBe(id("rSteel"));
  });

  it("解禁済みの tech は researchAlreadyCompleted", () => {
    const unlocked = putEntity(researchBoard(), {
      kind: "research",
      id: id("rBronze"),
      techId: TECH_BRONZE.id,
      progress: fixFromInt(100),
      completedTick: 5,
    });
    expect(
      rejectCodeOf(unlocked, CONTENT_TECH, {
        kind: "beginResearch",
        researchId: id("rBronze2"),
        techId: TECH_BRONZE.id,
      }),
    ).toBe("researchAlreadyCompleted");
  });

  it("(B) 一回性喪失した tech は researchIrreversiblyLost", () => {
    const lost = putEntity(researchBoard(), {
      kind: "research",
      id: id("rBronze"),
      techId: TECH_BRONZE.id,
      progress: FIX_ZERO,
      completedTick: null,
      loss: { tick: 7, irreversible: true },
    });
    expect(
      rejectCodeOf(lost, CONTENT_TECH, {
        kind: "beginResearch",
        researchId: id("rBronze2"),
        techId: TECH_BRONZE.id,
      }),
    ).toBe("researchIrreversiblyLost");
  });

  it("新規 ID が既存 entity と衝突したら entityIdInUse", () => {
    const board = researchBoard([resource("rBronze", WOOD, 0)]);
    expect(
      rejectCodeOf(board, CONTENT_TECH, {
        kind: "beginResearch",
        researchId: id("rBronze"),
        techId: TECH_BRONZE.id,
      }),
    ).toBe("entityIdInUse");
  });

  it("選択した研究が完了すると選択は失効し、ID 昇順先頭へ落ちる(state は書き換えない)", () => {
    const board = researchBoard([
      research("rAlpha", TECH_BRONZE.id, 0),
      research("rBravo", TECH_IRON.id, 0),
    ]);
    const selected = accept(board, CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rUnused"),
      techId: TECH_IRON.id,
    });
    const completed = updateEntity(selected, id("rBravo"), "research", (r) =>
      setField(r, "completedTick", 3),
    );
    // 選択そのものは残っているが、有効な対象ではなくなる。
    expect(completed.selectedResearchId).toBe(id("rBravo"));
    expect(selectedResearch(completed)).toBeUndefined();
    expect(currentResearch(completed)?.id).toBe(id("rAlpha"));
  });

  it("選択中の research entity を取り除くと選択も外れる(ぶら下がり参照を作らない)", () => {
    const next = accept(researchBoard(), CONTENT_TECH, {
      kind: "beginResearch",
      researchId: id("rBronze"),
      techId: TECH_BRONZE.id,
    });
    expect(next.selectedResearchId).toBe(id("rBronze"));
    // 大移動(rules/exodus.ts)や記録の焼失など、research entity を取り除く経路は
    // コマンド以外にもある。update.ts の removeEntity が選択の後始末まで持つ。
    const removed = removeEntity(next, id("rBronze"));
    expect(removed.selectedResearchId).toBeNull();
    expect(currentResearch(removed)).toBeUndefined();
  });
});

// --- 3. 成文化の scheduler 段50 結線 ----------------------------------------

function codifyJob(name: string, techId: string, requiredWorkTicks: number): CodifyState {
  return {
    kind: "codify",
    id: id(name),
    techId: id(techId),
    medium: "stoneTablet",
    requiredWork: fixFromInt(requiredWorkTicks),
    progress: FIX_ZERO,
    completedTick: null,
  };
}

function codifyBoard(extra: readonly EntityState[] = []): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fDesk") }),
    facility("fDesk", STUDY_DESK.id, CELL_A, [id("aRui")]),
    ...extra,
  ]);
}

describe("[M50] 成文化の scheduler 段50 結線", () => {
  it("学者(研究点産出施設の稼働就労者)の寄与が codifyLaborFix になる", () => {
    const board = codifyBoard();
    const rates = computeProductionRates(board, createAdvanceContext(board, CONTENT_TECH));
    // 中立ステータス・trait なし = 1 人あたり厳密に 1.0(rules/stats.ts §1)。
    expect(toRaw(rates.codifyLaborFix)).toBe(1_000_000);
  });

  it("学者が居なければレート 0(記録は進まない)", () => {
    const board = stateOf([facility("fDesk", STUDY_DESK.id, CELL_A)]);
    const rates = computeProductionRates(board, createAdvanceContext(board, CONTENT_TECH));
    expect(toRaw(rates.codifyLaborFix)).toBe(0);
  });

  it("advance だけで記録が完成する(M6 以来の積み残しの解消)", () => {
    const board = codifyBoard([codifyJob("cAlpha", "techBronze", 30)]);
    const advanced = advance(board, createAdvanceContext(board, CONTENT_TECH), 100);
    expect(requireEntity(advanced, id("cAlpha"), "codify").completedTick).toBe(30);
    expect(currentCodification(advanced)).toBeUndefined();
  });

  it("キューは 1 本ずつ進み、先頭が完成したら次へ移る", () => {
    const board = codifyBoard([
      codifyJob("cAlpha", "techBronze", 30),
      codifyJob("cBravo", "techIron", 45),
    ]);
    const advanced = advance(board, createAdvanceContext(board, CONTENT_TECH), 100);
    expect(requireEntity(advanced, id("cAlpha"), "codify").completedTick).toBe(30);
    expect(requireEntity(advanced, id("cBravo"), "codify").completedTick).toBe(75);
  });

  it("分割不変性: 完了 tick ちょうどで区切っても一括実行と一致する", () => {
    const board = codifyBoard([
      codifyJob("cAlpha", "techBronze", 30),
      codifyJob("cBravo", "techIron", 45),
    ]);
    const oneShot = advance(board, createAdvanceContext(board, CONTENT_TECH), 100);
    const half = advance(board, createAdvanceContext(board, CONTENT_TECH), 30);
    const split = advance(half, createAdvanceContext(half, CONTENT_TECH), 100);
    expect(JSON.stringify(toSerializable(split))).toBe(JSON.stringify(toSerializable(oneShot)));
  });

  it("分割不変性: 任意 tick(完了点でない)で区切っても一致する", () => {
    const board = codifyBoard([codifyJob("cAlpha", "techBronze", 30)]);
    const oneShot = advance(board, createAdvanceContext(board, CONTENT_TECH), 100);
    const half = advance(board, createAdvanceContext(board, CONTENT_TECH), 17);
    const split = advance(half, createAdvanceContext(half, CONTENT_TECH), 100);
    expect(JSON.stringify(toSerializable(split))).toBe(JSON.stringify(toSerializable(oneShot)));
  });

  it("学者が居ない盤面では完了イベントが積まれない(レート 0 の予測は null)", () => {
    const board = stateOf([
      facility("fDesk", STUDY_DESK.id, CELL_A),
      codifyJob("cAlpha", "techBronze", 30),
    ]);
    const advanced = advance(board, createAdvanceContext(board, CONTENT_TECH), 100);
    expect(requireEntity(advanced, id("cAlpha"), "codify").completedTick).toBeNull();
    expect(toRaw(requireEntity(advanced, id("cAlpha"), "codify").progress)).toBe(0);
  });
});

// --- 4. cancelCodification(成文化キューの取消) ------------------------------

describe("[M50] cancelCodification(成文化キューの取消)", () => {
  it("作業中のジョブを取り消すと entity ごと消える", () => {
    const board = codifyBoard([codifyJob("cAlpha", "techBronze", 30)]);
    const next = accept(board, CONTENT_TECH, {
      kind: "cancelCodification",
      codifyId: id("cAlpha"),
    });
    expect(getEntity(next, id("cAlpha"))).toBeUndefined();
    expect(currentCodification(next)).toBeUndefined();
  });

  it("取り消してもコストは戻らない(解体と同じ扱い)", () => {
    const board = codifyBoard([codifyJob("cAlpha", "techBronze", 30), resource("wStock", WOOD, 7)]);
    const next = accept(board, CONTENT_TECH, {
      kind: "cancelCodification",
      codifyId: id("cAlpha"),
    });
    expect(stockOf(next, "wStock")).toBe(7_000_000);
  });

  it("完成済みの記録は codifyAlreadyCompleted で拒否する", () => {
    const done = updateEntity(
      codifyBoard([codifyJob("cAlpha", "techBronze", 30)]),
      id("cAlpha"),
      "codify",
      (c) => setField(c, "completedTick", 12),
    );
    expect(
      rejectCodeOf(done, CONTENT_TECH, { kind: "cancelCodification", codifyId: id("cAlpha") }),
    ).toBe("codifyAlreadyCompleted");
  });

  it("存在しない / 種別違いは entityNotFound", () => {
    const board = codifyBoard([resource("wStock", WOOD, 1)]);
    expect(
      rejectCodeOf(board, CONTENT_TECH, { kind: "cancelCodification", codifyId: id("cGhost") }),
    ).toBe("entityNotFound");
    expect(
      rejectCodeOf(board, CONTENT_TECH, { kind: "cancelCodification", codifyId: id("wStock") }),
    ).toBe("entityNotFound");
  });

  it("取り消した後は次のジョブへ学者の作業が向く", () => {
    const board = codifyBoard([
      codifyJob("cAlpha", "techBronze", 30),
      codifyJob("cBravo", "techIron", 20),
    ]);
    const cancelled = accept(board, CONTENT_TECH, {
      kind: "cancelCodification",
      codifyId: id("cAlpha"),
    });
    const advanced = advance(cancelled, createAdvanceContext(cancelled, CONTENT_TECH), 100);
    expect(requireEntity(advanced, id("cBravo"), "codify").completedTick).toBe(20);
  });
});

// --- 5. 衛星拠点の操作(GDD 9.2) --------------------------------------------

function outpostBoard(extra: readonly EntityState[] = []): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    resident("bSora"),
    resident("cToki"),
    resident("dNagi"),
    resident("eMizu"),
    facility("fHearth", HEARTH.id, CELL_A, [id("aRui")]),
    resource("wStock", WOOD, 100),
    ...extra,
  ]);
}

const ESTABLISH: Command = {
  kind: "establishOutpost",
  outpostId: id("oForest"),
  outpostTypeId: OUTPOST_FOREST.id,
  band: "near",
  residentIds: [id("bSora")],
};

describe("[M50] 衛星拠点の設置 / 放棄", () => {
  it("設置すると拠点が生え、設置 tick が記録される", () => {
    const board = stateOf(
      [resident("bSora"), facility("fHearth", HEARTH.id, CELL_A), resource("wStock", WOOD, 100)],
      { tick: 42 },
    );
    const next = accept(board, CONTENT_OUTPOST, ESTABLISH);
    const outpost = getOutpost(next, id("oForest"));
    expect(outpost?.residentIds).toEqual([id("bSora")]);
    expect(outpost?.level).toBe(1);
    expect(outpost?.band).toBe("near");
    expect(outpost?.establishedTick).toBe(42);
  });

  it("常駐者は本拠の就労から外れる(二重計上の検査が通る)", () => {
    const next = accept(outpostBoard(), CONTENT_OUTPOST, {
      ...ESTABLISH,
      residentIds: [id("aRui")],
    } as Command);
    expect(requireEntity(next, id("aRui"), "resident").assignedFacilityId).toBeNull();
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([]);
    expect(() => {
      assertNoDoubleStationedResidents(next);
    }).not.toThrow();
  });

  it("常駐者は ID 昇順へ正規化される(順不同で渡してよい)", () => {
    const next = accept(outpostBoard(), CONTENT_OUTPOST, {
      ...ESTABLISH,
      residentIds: [id("dNagi"), id("bSora"), id("cToki")],
    } as Command);
    expect(getOutpost(next, id("oForest"))?.residentIds).toEqual([
      id("bSora"),
      id("cToki"),
      id("dNagi"),
    ]);
  });

  it("0 名 / 5 名は invalidArgument(GDD 9.2 の 1〜4 名)", () => {
    expect(
      rejectCodeOf(outpostBoard(), CONTENT_OUTPOST, {
        ...ESTABLISH,
        residentIds: [],
      } as Command),
    ).toBe("invalidArgument");
    expect(
      rejectCodeOf(outpostBoard(), CONTENT_OUTPOST, {
        ...ESTABLISH,
        residentIds: [id("aRui"), id("bSora"), id("cToki"), id("dNagi"), id("eMizu")],
      } as Command),
    ).toBe("invalidArgument");
  });

  it("重複した常駐者は invalidArgument", () => {
    expect(
      rejectCodeOf(outpostBoard(), CONTENT_OUTPOST, {
        ...ESTABLISH,
        residentIds: [id("bSora"), id("bSora")],
      } as Command),
    ).toBe("invalidArgument");
  });

  it("content に outpostType が無ければ unknownContentDef", () => {
    expect(rejectCodeOf(outpostBoard(), contentWith(), ESTABLISH)).toBe("unknownContentDef");
  });

  it("探索派遣中の住民は駐在できない(排他)", () => {
    const dispatched = updateEntity(outpostBoard(), id("bSora"), "resident", (r) =>
      setField(r, "dispatched", true),
    );
    expect(rejectCodeOf(dispatched, CONTENT_OUTPOST, ESTABLISH)).toBe("residentUnavailable");
  });

  it("ID 衝突は entityIdInUse", () => {
    const clash = outpostBoard([resource("oForest", WOOD, 0)]);
    expect(rejectCodeOf(clash, CONTENT_OUTPOST, ESTABLISH)).toBe("entityIdInUse");
    const established = accept(outpostBoard(), CONTENT_OUTPOST, ESTABLISH);
    expect(rejectCodeOf(established, CONTENT_OUTPOST, ESTABLISH)).toBe("entityIdInUse");
  });

  it("放棄すると拠点が消え、常駐者は本拠へ戻る(無配属)", () => {
    const established = accept(outpostBoard(), CONTENT_OUTPOST, ESTABLISH);
    const abandoned = accept(established, CONTENT_OUTPOST, {
      kind: "abandonOutpost",
      outpostId: id("oForest"),
    });
    expect(allOutposts(abandoned)).toEqual([]);
    expect(requireEntity(abandoned, id("bSora"), "resident").assignedFacilityId).toBeNull();
  });

  it("存在しない拠点の放棄は entityNotFound", () => {
    expect(
      rejectCodeOf(outpostBoard(), CONTENT_OUTPOST, {
        kind: "abandonOutpost",
        outpostId: id("oGhost"),
      }),
    ).toBe("entityNotFound");
  });
});

describe("[M50] 駐在割当 / 解除", () => {
  const STATION: Command = {
    kind: "stationResident",
    residentId: id("cToki"),
    outpostId: id("oForest"),
  };

  function established(): GameState {
    return accept(outpostBoard(), CONTENT_OUTPOST, ESTABLISH);
  }

  it("駐在させると residentIds が ID 昇順のまま増える", () => {
    const next = accept(established(), CONTENT_OUTPOST, STATION);
    expect(getOutpost(next, id("oForest"))?.residentIds).toEqual([id("bSora"), id("cToki")]);
  });

  it("本拠で就労中の住民は同じコマンドの中で外れる(途中の二重計上を見せない)", () => {
    const next = accept(established(), CONTENT_OUTPOST, {
      ...STATION,
      residentId: id("aRui"),
    } as Command);
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([]);
    expect(requireEntity(next, id("aRui"), "resident").assignedFacilityId).toBeNull();
    expect(() => {
      assertNoDoubleStationedResidents(next);
    }).not.toThrow();
  });

  it("別拠点から移すと元の拠点から外れる(1 人拠点なら元の拠点は放棄される)", () => {
    const two = accept(established(), CONTENT_OUTPOST, {
      kind: "establishOutpost",
      outpostId: id("oMine"),
      outpostTypeId: OUTPOST_FOREST.id,
      band: "far",
      residentIds: [id("cToki")],
    });
    const moved = accept(two, CONTENT_OUTPOST, STATION);
    expect(getOutpost(moved, id("oForest"))?.residentIds).toEqual([id("bSora"), id("cToki")]);
    expect(getOutpost(moved, id("oMine"))).toBeUndefined();
    expect(() => {
      assertNoDoubleStationedResidents(moved);
    }).not.toThrow();
  });

  it("同じ拠点への二重駐在は alreadyStationed", () => {
    const next = accept(established(), CONTENT_OUTPOST, STATION);
    expect(rejectCodeOf(next, CONTENT_OUTPOST, STATION)).toBe("alreadyStationed");
  });

  it("常駐枠が埋まっていれば outpostSlotsFull", () => {
    const board = accept(outpostBoard(), CONTENT_OUTPOST, {
      ...ESTABLISH,
      residentIds: [id("aRui"), id("bSora"), id("cToki"), id("dNagi")],
    } as Command);
    const result = apply(board, CONTENT_OUTPOST, {
      kind: "stationResident",
      residentId: id("eMizu"),
      outpostId: id("oForest"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("outpostSlotsFull");
    expect(result.rejection.limit).toBe(OUTPOST_RESIDENTS_MAX);
  });

  it("探索派遣中 / 死亡の住民は residentUnavailable", () => {
    const dispatched = updateEntity(established(), id("cToki"), "resident", (r) =>
      setField(r, "dispatched", true),
    );
    expect(rejectCodeOf(dispatched, CONTENT_OUTPOST, STATION)).toBe("residentUnavailable");
  });

  it("存在しない拠点 / 住民は entityNotFound", () => {
    expect(
      rejectCodeOf(established(), CONTENT_OUTPOST, {
        ...STATION,
        outpostId: id("oGhost"),
      } as Command),
    ).toBe("entityNotFound");
    expect(
      rejectCodeOf(established(), CONTENT_OUTPOST, {
        ...STATION,
        residentId: id("zGhost"),
      } as Command),
    ).toBe("entityNotFound");
  });

  it("解除すると拠点から外れ、本拠で無配属になる", () => {
    const two = accept(established(), CONTENT_OUTPOST, STATION);
    const next = accept(two, CONTENT_OUTPOST, {
      kind: "unstationResident",
      residentId: id("cToki"),
    });
    expect(getOutpost(next, id("oForest"))?.residentIds).toEqual([id("bSora")]);
    expect(requireEntity(next, id("cToki"), "resident").assignedFacilityId).toBeNull();
  });

  it("最後の 1 人は outpostWouldBeEmpty で拒否する(0 名の拠点は表現できない)", () => {
    const result = apply(established(), CONTENT_OUTPOST, {
      kind: "unstationResident",
      residentId: id("bSora"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("outpostWouldBeEmpty");
    expect(result.rejection.message).toContain("abandonOutpost");
  });

  it("どこにも駐在していない住民の解除は notStationed", () => {
    expect(
      rejectCodeOf(established(), CONTENT_OUTPOST, {
        kind: "unstationResident",
        residentId: id("cToki"),
      }),
    ).toBe("notStationed");
  });

  // [R8-01] 「駐在 → 就労」は「駐在 → 派遣」と同じ二重計上の穴だった
  //   (`assignResident` は拠点常駐を見ていなかった)。実測では就労させた
  //   次の advance から毎 tick RulesError になり、⑦の派遣と同じ進行不能
  //   ソフトロックになる。派遣側と同じ検査で閉じてあることを固定する。
  it("[R8-01] 拠点常駐中の住民は本拠の就労に割り当てられない(residentUnavailable)", () => {
    const board = accept(outpostBoard(), CONTENT_OUTPOST, ESTABLISH);
    const result = apply(board, CONTENT_OUTPOST, {
      kind: "assignResident",
      residentId: id("bSora"),
      facilityId: id("fHearth"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("residentUnavailable");
    expect(result.rejection.subjectId).toBe(id("bSora"));
    expect(result.rejection.message).toContain("常駐中");
    // reject 後は二重計上検査が通る state のまま(1 bit も動いていない)。
    expect(() => {
      assertNoDoubleStationedResidents(board);
    }).not.toThrow();
    // 就労者は元の 1 名(aRui)のまま = bSora は入っていない。
    expect(requireEntity(board, id("fHearth"), "facility").workerIds).toEqual([id("aRui")]);
  });

  it("[R8-01] 常駐していない住民の就労は従来どおり通る(既存挙動を壊さない)", () => {
    const board = accept(outpostBoard(), CONTENT_OUTPOST, ESTABLISH);
    const next = accept(board, CONTENT_OUTPOST, {
      kind: "assignResident",
      residentId: id("cToki"),
      facilityId: id("fHearth"),
    });
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([
      id("aRui"),
      id("cToki"),
    ]);
    expect(() => {
      assertNoDoubleStationedResidents(next);
    }).not.toThrow();
  });

  it("駐在した住民は本拠の生産に寄与しない(GDD 9.2 の別集合)", () => {
    const before = outpostBoard();
    const after = accept(before, CONTENT_OUTPOST, {
      ...ESTABLISH,
      residentIds: [id("aRui")],
    } as Command);
    const ratesBefore = computeProductionRates(
      before,
      createAdvanceContext(before, CONTENT_OUTPOST),
    );
    const ratesAfter = computeProductionRates(after, createAdvanceContext(after, CONTENT_OUTPOST));
    expect(toRaw(ratesBefore.resourceRateByResourceId.get(WOOD) ?? FIX_ZERO)).toBeGreaterThan(0);
    expect(toRaw(ratesAfter.resourceRateByResourceId.get(WOOD) ?? FIX_ZERO)).toBe(0);
  });
});

// --- 6. state 不変条件 (k) --------------------------------------------------

describe("[M50] selectedResearchId の不変条件 (k)", () => {
  it("実在しない research を指す state は作れない", () => {
    expect(() =>
      createGameState(
        META,
        [resident("aRui")],
        [],
        [],
        [],
        [],
        undefined,
        [],
        undefined,
        undefined,
        id("rGhost"),
      ),
    ).toThrow();
  });

  it("research でない entity を指す state も作れない", () => {
    expect(() =>
      createGameState(
        META,
        [resource("wStock", WOOD, 0)],
        [],
        [],
        [],
        [],
        undefined,
        [],
        undefined,
        undefined,
        id("wStock"),
      ),
    ).toThrow();
  });

  it("直列化形で null を明示した形は reject する(非正準形)", () => {
    const raw = toSerializable(researchBoard()) as Record<string, unknown>;
    expect(() => fromSerializable({ ...raw, selectedResearchId: null })).toThrow();
  });
});
