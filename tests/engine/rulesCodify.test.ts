import { describe, expect, it } from "vitest";

import { FIX_ONE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  applyCodifyProgress,
  assistPreferredMedium,
  beginCodification,
  caravanWeightOfRecords,
  codifyRemaining,
  codifyWasteSubstitution,
  codificationQueue,
  completeCodification,
  completedRecords,
  currentCodification,
  flammableRecords,
  isCodified,
  isPrintingUnlocked,
  planCodification,
  recordMediaOfTech,
  requireRecordMedia,
  ticksUntilCodifyComplete,
} from "../../src/engine/rules/codify";
import {
  RulesError,
  type EngineContent,
  type RecordMediaParams,
} from "../../src/engine/rules/types";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import type { CodifyState, EntityState, GameState } from "../../src/engine/state/state";
import { putEntity } from "../../src/engine/state/update";
import { RECALL_RISK, id, matrix, research, resource, stateOf } from "./fixtures";

// ---------------------------------------------------------------------------
// M6: 成文化キューと記録媒体2種(石板/紙)— GDD 11.1 [2026-07-27追補] / 10.2 / 6.7
// ---------------------------------------------------------------------------

const TECH_E1 = id("techEarly");
const TECH_E3 = id("techLate");
const TECH_PRINTING = id("techPrinting");
const CLAY = id("clay");
const PAPER = id("paper");
const WASTE = id("waste");

/** GDD 11.1 追補の表(石板 = 基準 ×1.0 / 紙 = 安・速・軽・可燃)。 */
const RECORD_MEDIA_PARAMS: RecordMediaParams = {
  baseCostFix: fixFromInt(20),
  baseDurationTicks: 720,
  printingTechId: TECH_PRINTING,
  printingCostMulFix: fixFromRaw(500_000), // -50%
  printingTimeMulFix: fixFromRaw(500_000), // 速度 ×2
  byMedium: {
    paper: {
      costMulFix: fixFromRaw(600_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: PAPER,
    },
    stoneTablet: {
      costMulFix: FIX_ONE,
      timeMulFix: FIX_ONE,
      caravanWeightFix: FIX_ONE,
      flammable: false,
      costResourceId: CLAY,
    },
  },
};

function contentWith(overrides: Partial<EngineContent> = {}): EngineContent {
  const base: EngineContent = {
    facilityDefs: new Map(),
    techDefs: new Map([
      [TECH_E1, { id: TECH_E1, researchCostFix: fixFromInt(30), eraId: "e1" }],
      [TECH_E3, { id: TECH_E3, researchCostFix: fixFromInt(120), eraId: "e3" }],
      [TECH_PRINTING, { id: TECH_PRINTING, researchCostFix: fixFromInt(220), eraId: "e3" }],
    ]),
    adjacency: matrix(),
    recallRisk: RECALL_RISK,
    coarseTickMinutes: 10,
    eraDefs: new Map([
      [
        "e1",
        {
          id: "e1",
          order: 1,
          baseEraFix: fixFromInt(30),
          multiplierFix: fixFromInt(1),
          gateTechId: TECH_E1,
          criticalPathMax: 3,
        },
      ],
      [
        "e3",
        {
          id: "e3",
          order: 3,
          baseEraFix: fixFromInt(120),
          multiplierFix: fixFromInt(4),
          gateTechId: TECH_E3,
          criticalPathMax: 4,
        },
      ],
    ]),
    recordMedia: RECORD_MEDIA_PARAMS,
  };
  return { ...base, ...overrides };
}

const CONTENT = contentWith();

function codify(
  name: string,
  techId: typeof TECH_E1,
  medium: "paper" | "stoneTablet",
  overrides: Partial<Omit<CodifyState, "kind" | "id" | "techId" | "medium">> = {},
): CodifyState {
  return {
    kind: "codify",
    id: id(name),
    techId,
    medium,
    requiredWork: overrides.requiredWork ?? fixFromInt(720),
    progress: overrides.progress ?? FIX_ZERO,
    completedTick: overrides.completedTick ?? null,
  };
}

function boardWith(entities: readonly EntityState[]): GameState {
  return stateOf(entities);
}

// --- 1. コストと所要時間(GDD 11.1) ---------------------------------------

describe("codify — 媒体別コスト/時間(GDD 11.1 追補)", () => {
  it("石板は基準 ×1.0(E1: コスト 20 / 720 tick)", () => {
    const plan = planCodification(CONTENT, TECH_E1, "stoneTablet", false);
    expect(toRaw(plan.costFix)).toBe(20_000_000);
    expect(plan.durationTicks).toBe(720);
    expect(plan.costResourceId).toBe("clay");
    expect(plan.flammable).toBe(false);
  });

  it("紙は安く速く軽い(E1: コスト 12 / 360 tick / 重み 0.25)", () => {
    const plan = planCodification(CONTENT, TECH_E1, "paper", false);
    expect(toRaw(plan.costFix)).toBe(12_000_000);
    expect(plan.durationTicks).toBe(360);
    expect(toRaw(plan.caravanWeightFix)).toBe(250_000);
    expect(plan.flammable).toBe(true);
  });

  it("時代係数(era_multiplier)が掛かる(E3 = ×4)", () => {
    expect(toRaw(planCodification(CONTENT, TECH_E3, "stoneTablet", false).costFix)).toBe(
      80_000_000,
    );
    expect(toRaw(planCodification(CONTENT, TECH_E3, "paper", false).costFix)).toBe(48_000_000);
  });

  it("エラ不明の tech は時代係数 1.0", () => {
    const noEra = contentWith({
      techDefs: new Map([[TECH_E1, { id: TECH_E1, researchCostFix: fixFromInt(30) }]]),
    });
    expect(toRaw(planCodification(noEra, TECH_E1, "stoneTablet", false).costFix)).toBe(20_000_000);
  });

  it("E3 印刷のコスト -50% / 速度 ×2 は**紙のみ**(GDD 5.2 / 11.1 追補)", () => {
    const paper = planCodification(CONTENT, TECH_E3, "paper", true);
    expect(paper.printingApplied).toBe(true);
    expect(toRaw(paper.costFix)).toBe(24_000_000); // 48 → 24
    expect(paper.durationTicks).toBe(180); // 360 → 180

    const stone = planCodification(CONTENT, TECH_E3, "stoneTablet", true);
    expect(stone.printingApplied).toBe(false);
    expect(toRaw(stone.costFix)).toBe(80_000_000);
    expect(stone.durationTicks).toBe(720);
  });

  it("所要 tick は切り上げ、最低 1 tick(0 tick の記録を作らない)", () => {
    const tiny = contentWith({
      recordMedia: {
        ...RECORD_MEDIA_PARAMS,
        baseDurationTicks: 1,
        byMedium: {
          paper: { ...RECORD_MEDIA_PARAMS.byMedium.paper, timeMulFix: fixFromRaw(1) },
          stoneTablet: RECORD_MEDIA_PARAMS.byMedium.stoneTablet,
        },
      },
    });
    expect(planCodification(tiny, TECH_E1, "paper", false).durationTicks).toBe(1);
  });

  it("印刷の解禁は research entity の完了で決まる", () => {
    const notDone = boardWith([research("researchPrinting", TECH_PRINTING)]);
    expect(isPrintingUnlocked(notDone, CONTENT)).toBe(false);

    const done = boardWith([
      { ...research("researchPrinting", TECH_PRINTING), completedTick: 100 },
    ]);
    expect(isPrintingUnlocked(done, CONTENT)).toBe(true);
  });

  it("printingTechId が無い content では常に未解禁", () => {
    const noPrinting = contentWith({
      recordMedia: { ...RECORD_MEDIA_PARAMS, printingTechId: null },
    });
    const done = boardWith([
      { ...research("researchPrinting", TECH_PRINTING), completedTick: 100 },
    ]);
    expect(isPrintingUnlocked(done, noPrinting)).toBe(false);
  });

  it("recordMedia が無い content では成文化できない(黙って既定値を作らない)", () => {
    const bare = contentWith({});
    const without: EngineContent = {
      facilityDefs: bare.facilityDefs,
      techDefs: bare.techDefs,
      adjacency: bare.adjacency,
      recallRisk: bare.recallRisk,
      coarseTickMinutes: bare.coarseTickMinutes,
    };
    expect(() => requireRecordMedia(without)).toThrow(RulesError);
    expect(() => planCodification(without, TECH_E1, "paper", false)).toThrow(RulesError);
  });

  it("content に無い tech の記録は作れない", () => {
    expect(() => planCodification(CONTENT, id("techGhost"), "paper", false)).toThrow(RulesError);
  });
});

// --- 2. 廃材代替は石板のみ(GDD 6.7 3出口(2) / 11.1 追補) -------------------

describe("codify — 粘土コストの廃材代替は石板のみ", () => {
  const withStorage = contentWith({
    storage: {
      wasteResourceId: WASTE,
      baseCapacityByResourceId: new Map(),
      wasteConversionRatioByResourceId: new Map(),
      wasteToResearchRatioFix: fixFromRaw(100_000),
      buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
      codifyWasteSubstitutionMaxFix: fixFromRaw(50_000), // 5%
    },
  });

  it("石板は最大 5% まで廃材で代替する", () => {
    const state = boardWith([resource("resourceWaste", WASTE, 100)]);
    const plan = planCodification(withStorage, TECH_E1, "stoneTablet", false);
    const result = codifyWasteSubstitution(state, withStorage, plan);
    expect(toRaw(result.wasteSpentFix)).toBe(1_000_000); // 20 × 5%
    expect(toRaw(result.remainingCostFix)).toBe(19_000_000);
  });

  it("紙は代替しない(GDD 11.1 追補: 廃材代替は石板のみ)", () => {
    const state = boardWith([resource("resourceWaste", WASTE, 100)]);
    const plan = planCodification(withStorage, TECH_E1, "paper", false);
    const result = codifyWasteSubstitution(state, withStorage, plan);
    expect(toRaw(result.wasteSpentFix)).toBe(0);
    expect(toRaw(result.remainingCostFix)).toBe(toRaw(plan.costFix));
  });

  it("廃材在庫が足りなければ在庫ぶんだけ代替する", () => {
    const state = boardWith([resource("resourceWaste", WASTE, 0)]);
    const plan = planCodification(withStorage, TECH_E1, "stoneTablet", false);
    const result = codifyWasteSubstitution(state, withStorage, plan);
    expect(toRaw(result.wasteSpentFix)).toBe(0);
    expect(toRaw(result.remainingCostFix)).toBe(20_000_000);
  });

  it("storage ブロックが無ければ代替 0(成文化そのものは可能)", () => {
    const state = boardWith([]);
    const plan = planCodification(CONTENT, TECH_E1, "stoneTablet", false);
    const result = codifyWasteSubstitution(state, CONTENT, plan);
    expect(toRaw(result.wasteSpentFix)).toBe(0);
  });
});

// --- 3. キュー操作 ---------------------------------------------------------

describe("codify — 成文化キュー", () => {
  it("beginCodification がコストを引き、所要作業量をスナップショットする", () => {
    const state = boardWith([resource("resourceClay", CLAY, 50)]);
    const next = beginCodification(state, CONTENT, {
      codifyId: id("codifyEarlyStone"),
      techId: TECH_E1,
      medium: "stoneTablet",
    });

    const entity = next.entityStateById.get(id("codifyEarlyStone"));
    expect(entity?.kind).toBe("codify");
    if (entity?.kind !== "codify") return;
    expect(toRaw(entity.requiredWork)).toBe(720_000_000);
    expect(toRaw(entity.progress)).toBe(0);
    expect(entity.completedTick).toBeNull();

    const clay = [...next.entityStateById.values()].find(
      (e) => e.kind === "resource" && e.resourceId === CLAY,
    );
    expect(clay?.kind === "resource" ? toRaw(clay.stock) : null).toBe(30_000_000);
  });

  it("在庫不足なら停止する(黙って部分適用しない)", () => {
    const state = boardWith([resource("resourceClay", CLAY, 1)]);
    expect(() =>
      beginCodification(state, CONTENT, {
        codifyId: id("codifyEarlyStone"),
        techId: TECH_E1,
        medium: "stoneTablet",
      }),
    ).toThrow(RulesError);
  });

  it("同一 tech の別媒体は並存できる(GDD 11.1 追補の副本動線)", () => {
    let state = boardWith([
      resource("resourceClay", CLAY, 50),
      resource("resourcePaper", PAPER, 50),
    ]);
    state = beginCodification(state, CONTENT, {
      codifyId: id("codifyEarlyPaper"),
      techId: TECH_E1,
      medium: "paper",
    });
    state = beginCodification(state, CONTENT, {
      codifyId: id("codifyEarlyStone"),
      techId: TECH_E1,
      medium: "stoneTablet",
    });
    expect(codificationQueue(state).map((c) => c.id)).toEqual([
      "codifyEarlyPaper",
      "codifyEarlyStone",
    ]);
  });

  it("既存 entity と ID が衝突したら拒否する(putEntity の黙った差し替えを防ぐ)", () => {
    const state = boardWith([resource("resourceClay", CLAY, 50)]);
    expect(() =>
      beginCodification(state, CONTENT, {
        codifyId: id("resourceClay"),
        techId: TECH_E1,
        medium: "stoneTablet",
      }),
    ).toThrow(RulesError);
  });

  it("同一 (tech, 媒体) の重複は拒否する", () => {
    let state = boardWith([resource("resourcePaper", PAPER, 50)]);
    state = beginCodification(state, CONTENT, {
      codifyId: id("codifyEarlyPaper"),
      techId: TECH_E1,
      medium: "paper",
    });
    expect(() =>
      beginCodification(state, CONTENT, {
        codifyId: id("codifyEarlyPaperDup"),
        techId: TECH_E1,
        medium: "paper",
      }),
    ).toThrow(RulesError);
  });

  it("currentCodification は未完了の ID 昇順先頭(research.ts §2 と同じ縮約)", () => {
    const state = boardWith([
      codify("codifyAlpha", TECH_E1, "paper", { completedTick: 10 }),
      codify("codifyBeta", TECH_E1, "stoneTablet"),
      codify("codifyGamma", TECH_E3, "paper"),
    ]);
    expect(currentCodification(state)?.id).toBe("codifyBeta");
    expect(completedRecords(state).map((c) => c.id)).toEqual(["codifyAlpha"]);
  });

  it("全て完成済みなら currentCodification は undefined", () => {
    const state = boardWith([codify("codifyAlpha", TECH_E1, "paper", { completedTick: 10 })]);
    expect(currentCodification(state)).toBeUndefined();
  });
});

// --- 4. (B) 完了予測と状態遷移(research.ts と同型) ------------------------

describe("codify — (B) 完了予測と完成", () => {
  it("残り作業量 = requiredWork − progress", () => {
    const entity = codify("codifyAlpha", TECH_E1, "paper", {
      requiredWork: fixFromInt(360),
      progress: fixFromInt(100),
    });
    expect(toRaw(codifyRemaining(entity))).toBe(260_000_000);
  });

  it("完了 tick 予測は切り上げ・レート 0 以下は null・残り 0 以下は 0", () => {
    expect(ticksUntilCodifyComplete(fixFromInt(10), FIX_ZERO)).toBeNull();
    expect(ticksUntilCodifyComplete(fixFromInt(10), fixFromInt(-1))).toBeNull();
    expect(ticksUntilCodifyComplete(FIX_ZERO, FIX_ONE)).toBe(0);
    expect(ticksUntilCodifyComplete(fixFromInt(-5), FIX_ONE)).toBe(0);
    expect(ticksUntilCodifyComplete(fixFromInt(10), fixFromInt(3))).toBe(4); // ceil(10/3)
  });

  it("予測は安定している(区間を進めても同じ完了 tick を指す)", () => {
    const rate = fixFromInt(3);
    const before = ticksUntilCodifyComplete(fixFromInt(30), rate);
    const after = ticksUntilCodifyComplete(fixFromInt(30 - 3 * 4), rate);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect((before ?? 0) - (after ?? 0)).toBe(4);
  });

  it("applyCodifyProgress は区間長ぶんを一括加算し、分割しても一致する", () => {
    const state = boardWith([codify("codifyAlpha", TECH_E1, "paper")]);
    const rate = fixFromInt(2);
    const once = applyCodifyProgress(state, id("codifyAlpha"), rate, 10);
    const split = applyCodifyProgress(
      applyCodifyProgress(state, id("codifyAlpha"), rate, 4),
      id("codifyAlpha"),
      rate,
      6,
    );
    expect(toSerializable(once)).toEqual(toSerializable(split));
  });

  it("レート 0 は state を変えない / deltaTicks が不正なら停止する", () => {
    const state = boardWith([codify("codifyAlpha", TECH_E1, "paper")]);
    expect(applyCodifyProgress(state, id("codifyAlpha"), FIX_ZERO, 5)).toBe(state);
    expect(() => applyCodifyProgress(state, id("codifyAlpha"), FIX_ONE, 0)).toThrow(RulesError);
    expect(() => applyCodifyProgress(state, id("codifyAlpha"), FIX_ONE, 1.5)).toThrow(RulesError);
  });

  it("completeCodification は所要に届いたときだけ通る", () => {
    const notYet = boardWith([
      codify("codifyAlpha", TECH_E1, "paper", {
        requiredWork: fixFromInt(10),
        progress: fixFromInt(9),
      }),
    ]);
    expect(() => completeCodification(notYet, id("codifyAlpha"), 50)).toThrow(RulesError);

    const ready = boardWith([
      codify("codifyAlpha", TECH_E1, "paper", {
        requiredWork: fixFromInt(10),
        progress: fixFromInt(12),
      }),
    ]);
    const done = completeCodification(ready, id("codifyAlpha"), 50);
    const entity = done.entityStateById.get(id("codifyAlpha"));
    expect(entity?.kind === "codify" ? entity.completedTick : null).toBe(50);
    // 進行度は減らさない(切り上げ由来の余剰を残す = research.ts と同じ規約)。
    expect(entity?.kind === "codify" ? toRaw(entity.progress) : null).toBe(12_000_000);
  });

  it("二重完了は停止する", () => {
    const state = boardWith([
      codify("codifyAlpha", TECH_E1, "paper", {
        requiredWork: fixFromInt(10),
        progress: fixFromInt(10),
        completedTick: 5,
      }),
    ]);
    expect(() => completeCodification(state, id("codifyAlpha"), 50)).toThrow(RulesError);
  });
});

// --- 5. 「成文化済み」と媒体の並存(GDD 11.1 追補 §3) ----------------------

describe("codify — 成文化済み判定と記録の並存", () => {
  it("完了済み記録が 1 件でもあれば成文化済み", () => {
    const inProgress = boardWith([codify("codifyAlpha", TECH_E1, "paper")]);
    expect(isCodified(inProgress, TECH_E1)).toBe(false);

    const done = boardWith([codify("codifyAlpha", TECH_E1, "paper", { completedTick: 10 })]);
    expect(isCodified(done, TECH_E1)).toBe(true);
    expect(isCodified(done, TECH_E3)).toBe(false);
  });

  it("媒体一覧は RECORD_MEDIA の宣言順(paper, stoneTablet)", () => {
    const state = boardWith([
      codify("codifyAlphaStone", TECH_E1, "stoneTablet", { completedTick: 20 }),
      codify("codifyAlphaPaper", TECH_E1, "paper", { completedTick: 10 }),
      codify("codifyLatePaper", TECH_E3, "paper"),
    ]);
    expect(recordMediaOfTech(state, TECH_E1)).toEqual(["paper", "stoneTablet"]);
    expect(recordMediaOfTech(state, TECH_E3)).toEqual([]);
  });

  it("可燃記録は紙のみ(焼失の母集合・破壊自体は M22)", () => {
    const state = boardWith([
      codify("codifyAlphaPaper", TECH_E1, "paper", { completedTick: 10 }),
      codify("codifyAlphaStone", TECH_E1, "stoneTablet", { completedTick: 20 }),
      codify("codifyLatePaper", TECH_E3, "paper"),
    ]);
    expect(flammableRecords(state, CONTENT).map((c) => c.id)).toEqual(["codifyAlphaPaper"]);
  });

  it("キャラバン重みは媒体別(石板 1.0 / 紙 0.25・GDD 10.2 追補)", () => {
    const state = boardWith([
      codify("codifyAlphaPaper", TECH_E1, "paper", { completedTick: 10 }),
      codify("codifyAlphaStone", TECH_E1, "stoneTablet", { completedTick: 20 }),
      codify("codifyLatePaper", TECH_E3, "paper"), // 未完成は数えない
    ]);
    expect(toRaw(caravanWeightOfRecords(state, CONTENT))).toBe(1_250_000);
  });

  it("おまかせ成文化の媒体規則: 唯一保持 → 石板 / それ以外 → 紙(GDD 11.1 追補)", () => {
    expect(assistPreferredMedium(true)).toBe("stoneTablet");
    expect(assistPreferredMedium(false)).toBe("paper");
  });
});

// --- 6. 直列化(serialize.ts §4 の規約) -----------------------------------

describe("codify — 直列化の往復", () => {
  it("codify entity が往復してバイト同一になる", () => {
    const state = boardWith([
      codify("codifyAlpha", TECH_E1, "paper", { progress: fixFromInt(120) }),
      codify("codifyBeta", TECH_E3, "stoneTablet", {
        requiredWork: fixFromInt(720),
        progress: fixFromInt(720),
        completedTick: 4321,
      }),
    ]);
    const json = toSerializable(state);
    expect(JSON.stringify(toSerializable(fromSerializable(json)))).toBe(JSON.stringify(json));
  });

  it("未知の媒体は reject する(engine 既知の 2 種のみ)", () => {
    const state = boardWith([codify("codifyAlpha", TECH_E1, "paper")]);
    const json = JSON.parse(JSON.stringify(toSerializable(state))) as Record<string, unknown>;
    const entities = json["entityStateById"] as Record<string, Record<string, unknown>>;
    const alpha = entities["codifyAlpha"];
    if (alpha !== undefined) alpha["medium"] = "papyrus";
    expect(() => fromSerializable(json)).toThrow(/papyrus/);
  });

  it("codify entity を持たない state の直列化形は M6 以前と同一", () => {
    const before = stateOf([resource("resourceClay", CLAY, 1)]);
    const withCodify = putEntity(before, codify("codifyAlpha", TECH_E1, "paper"));
    const beforeJson = toSerializable(before) as unknown as Record<string, unknown>;
    const entities = beforeJson["entityStateById"] as Record<string, unknown>;
    expect(Object.keys(entities)).toEqual(["resourceClay"]);
    expect(
      Object.keys(
        (toSerializable(withCodify) as unknown as Record<string, Record<string, unknown>>)[
          "entityStateById"
        ] ?? {},
      ),
    ).toEqual(["codifyAlpha", "resourceClay"]);
  });
});
