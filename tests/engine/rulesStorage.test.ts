import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";
import { FIX_ZERO, fixFromInt, fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import { applyProduction, computeProductionRates } from "../../src/engine/rules/production";
import {
  applyCappedIntake,
  applyCappedLumpIntake,
  colonyOverflowLossRate,
  convertWasteToResearchPoints,
  creditWasteGain,
  overflowLossRate,
  resolveCapacityByResourceId,
  spendResources,
  substituteCostWithWaste,
  wasteStockOf,
  wasteToResearchPoints,
} from "../../src/engine/rules/storage";
import type { TraitDef } from "../../src/engine/rules/stats";
import { RulesError, type EngineContent, type StorageParams } from "../../src/engine/rules/types";
import { toSerializable } from "../../src/engine/state/serialize";
import {
  requireEntity,
  type EntityId,
  type GameState,
  type ResourceState,
} from "../../src/engine/state/state";

import {
  HEARTH,
  RECALL_RISK,
  STUDY_DESK,
  TECH_BRONZE,
  WOOD,
  facility,
  id,
  matrix,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// ---------------------------------------------------------------------------
// M5: 保管庫オーバーフロー + 廃材スポンジ + 廃材 3 出口(GDD 6.7)のテスト。
//
// 検収条件の 2 本がここにある:
//   - 分割不変性 `advance(0→T2) == advance(0→T1)+advance(T1→T2)`(オーバーフローと
//     廃材変換を有効にした盤面で)
//   - オーバーフロー損失率の算出(GDD 11.4-7「損失率 < 15%」の判定値)
// ---------------------------------------------------------------------------

const WASTE = id("waste");

function storageParams(options: {
  readonly capacity?: readonly (readonly [EntityId, number])[];
  readonly ratio?: readonly (readonly [EntityId, number])[];
  readonly wasteResourceId?: EntityId | null;
  readonly wasteToResearchRatioRaw?: number;
}): StorageParams {
  return {
    wasteResourceId: options.wasteResourceId === undefined ? WASTE : options.wasteResourceId,
    baseCapacityByResourceId: new Map(
      (options.capacity ?? []).map(([rid, v]) => [rid, fixFromInt(v)] as const),
    ),
    wasteConversionRatioByResourceId: new Map(
      (options.ratio ?? []).map(([rid, v]) => [rid, fixFromRaw(v)] as const),
    ),
    wasteToResearchRatioFix: fixFromRaw(options.wasteToResearchRatioRaw ?? 100_000),
    buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
    codifyWasteSubstitutionMaxFix: fixFromRaw(50_000),
  };
}

function contentOf(
  options: {
    readonly storage?: StorageParams;
    readonly traitDefs?: readonly TraitDef[];
  } = {},
): EngineContent {
  const base = {
    facilityDefs: new Map([
      [HEARTH.id, HEARTH],
      [STUDY_DESK.id, STUDY_DESK],
    ]),
    techDefs: new Map([[TECH_BRONZE.id, TECH_BRONZE]]),
    adjacency: matrix(),
    recallRisk: RECALL_RISK,
    coarseTickMinutes: 10,
    traitDefs: new Map((options.traitDefs ?? []).map((def) => [def.id, def] as const)),
  };
  return options.storage === undefined ? base : { ...base, storage: options.storage };
}

/** hearth 1 基 + 就労者 1 人 + 薪/廃材のストック。 */
function board(): GameState {
  return stateOf([
    resident("aRui"),
    facility("fHearth", HEARTH.id, 0, [id("aRui")]),
    resource("rWaste", WASTE, 0),
    resource("rWood", WOOD, 0),
  ]);
}

function stockOf(state: GameState, entityId: string): number {
  return toRaw(requireEntity(state, id(entityId), "resource").stock);
}

function resourceOf(state: GameState, entityId: string): ResourceState {
  return requireEntity(state, id(entityId), "resource");
}

/** 区間 [0, ticks) の産出を 1 回で入れる。 */
function produce(state: GameState, content: EngineContent, ticks: number): GameState {
  const rates = computeProductionRates(state, createAdvanceContext(state, content));
  return applyProduction(state, rates, ticks);
}

describe("上限が無い資源は T5 と同一経路(既定の不活性)", () => {
  it("storage 未設定なら会計フィールドが付かず在庫だけ増える", () => {
    const content = contentOf();
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWood")).toBe(100_000_000);
    const wood = resourceOf(next, "rWood");
    expect(wood.cumulativeProduced).toBeUndefined();
    expect(wood.cumulativeOverflow).toBeUndefined();
  });

  it("storage はあるが当該資源に上限が無ければ同じく不活性", () => {
    const content = contentOf({ storage: storageParams({ ratio: [[WOOD, 500_000]] }) });
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWood")).toBe(100_000_000);
    expect(resourceOf(next, "rWood").cumulativeOverflow).toBeUndefined();
    expect(stockOf(next, "rWaste")).toBe(0);
  });
});

describe("保管庫オーバーフロー(GDD 6.7)", () => {
  it("上限で在庫が頭打ちになり、超過は破棄される(変換率 0)", () => {
    const content = contentOf({ storage: storageParams({ capacity: [[WOOD, 50]] }) });
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWood")).toBe(50_000_000);
    const wood = resourceOf(next, "rWood");
    expect(toRaw(wood.cumulativeProduced ?? FIX_ZERO)).toBe(100_000_000);
    expect(toRaw(wood.cumulativeOverflow ?? FIX_ZERO)).toBe(50_000_000);
    expect(stockOf(next, "rWaste")).toBe(0);
  });

  it("低次資源の超過は一定比率で廃材へ変換される(スポンジ機構)", () => {
    const content = contentOf({
      storage: storageParams({ capacity: [[WOOD, 50]], ratio: [[WOOD, 500_000]] }),
    });
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWood")).toBe(50_000_000);
    // 超過 50 × 0.5 = 25
    expect(stockOf(next, "rWaste")).toBe(25_000_000);
  });

  it("資源ごとに上限判定が独立する(GDD 6.7「連鎖停止を防ぐ」)", () => {
    // 薪だけ上限 10、廃材は上限なし。薪が満杯でも廃材は積み上がり続ける。
    const content = contentOf({
      storage: storageParams({ capacity: [[WOOD, 10]], ratio: [[WOOD, 1_000_000]] }),
    });
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWood")).toBe(10_000_000);
    expect(stockOf(next, "rWaste")).toBe(90_000_000);
  });

  it("廃材自身は再変換されない(自己ループを作らない)", () => {
    const content = contentOf({
      storage: storageParams({
        capacity: [
          [WOOD, 10],
          [WASTE, 20],
        ],
        ratio: [
          [WOOD, 1_000_000],
          [WASTE, 1_000_000],
        ],
      }),
    });
    const next = produce(board(), content, 100);
    expect(stockOf(next, "rWaste")).toBe(20_000_000);
    // 廃材の超過は破棄され、二次的な廃材にならない。
    expect(toRaw(resourceOf(next, "rWaste").cumulativeOverflow ?? FIX_ZERO)).toBe(70_000_000);
  });

  it("廃材の受け皿が state に無ければ黙って捨てず停止する", () => {
    const content = contentOf({
      storage: storageParams({ capacity: [[WOOD, 10]], ratio: [[WOOD, 500_000]] }),
    });
    const noWaste = stateOf([
      resident("aRui"),
      facility("fHearth", HEARTH.id, 0, [id("aRui")]),
      resource("rWood", WOOD, 0),
    ]);
    expect(() => produce(noWaste, content, 100)).toThrow(RulesError);
  });

  it("保管施設の Lv 別容量が基礎容量へ加算される(GDD 12.1)", () => {
    const storehouse = {
      ...HEARTH,
      id: id("storehouse"),
      storage: { capacityByLevel: [fixFromInt(30), fixFromInt(60)], resourceIds: [WOOD] },
    };
    const content: EngineContent = {
      ...contentOf({ storage: storageParams({ capacity: [[WOOD, 10]] }) }),
      facilityDefs: new Map([
        [HEARTH.id, HEARTH],
        [storehouse.id, storehouse],
      ]),
    };
    const state = stateOf([
      resident("aRui"),
      facility("fHearth", HEARTH.id, 0, [id("aRui")]),
      facility("fStore", storehouse.id, 20, [], 2),
      resource("rWaste", WASTE, 0),
      resource("rWood", WOOD, 0),
    ]);
    const capacities = resolveCapacityByResourceId(state, content);
    // 基礎 10 + Lv2 の 60 = 70
    expect(toRaw(capacities.get(WOOD) ?? FIX_ZERO)).toBe(70_000_000);
    expect(capacities.get(WASTE)).toBeUndefined();
  });
});

describe("オーバーフロー損失率(GDD 11.4-7)", () => {
  it("資源単位の損失率 = 累計超過 / 累計産出", () => {
    const content = contentOf({ storage: storageParams({ capacity: [[WOOD, 20]] }) });
    const next = produce(board(), content, 100);
    // 産出 100 / 超過 80 → 0.8
    expect(toRaw(overflowLossRate(resourceOf(next, "rWood")))).toBe(800_000);
  });

  it("盤面全体の損失率は分子・分母をそれぞれ合計してから割る", () => {
    const content = contentOf({
      storage: storageParams({ capacity: [[WOOD, 90]], ratio: [[WOOD, 1_000_000]] }),
    });
    const next = produce(board(), content, 100);
    // 薪: 産出 100 / 超過 10、廃材: 産出 10 / 超過 0(上限なしなので会計されない)
    // → 会計対象は薪のみ = 0.1
    expect(toRaw(colonyOverflowLossRate(next))).toBe(100_000);
    expect(toRaw(colonyOverflowLossRate(board()))).toBe(0);
  });

  it("上限が無い資源は損失率 0(会計していない = 構造的に損失なし)", () => {
    const content = contentOf();
    const next = produce(board(), content, 100);
    expect(toRaw(overflowLossRate(resourceOf(next, "rWood")))).toBe(0);
  });
});

describe("分割不変性(advance.ts §3・検収条件)", () => {
  const SPLIT_CASES: readonly (readonly [number, number])[] = [
    [30, 100],
    [37, 100],
    [1440, 4320],
    [2000, 4320],
  ];

  /** オーバーフロー・廃材変換・ステータス・trait をすべて有効にした盤面。 */
  function richBoard(): { readonly state: GameState; readonly content: EngineContent } {
    const craftsman: TraitDef = {
      id: id("traitCraftsman"),
      statAddFixById: new Map([["vigor", fixFromInt(7)]]),
      statMulFixById: new Map([["vigor", fixFromRaw(1_100_000)]]),
      yieldMulFix: fixFromRaw(1_170_000),
    };
    const content = contentOf({
      storage: storageParams({
        capacity: [
          [WOOD, 137],
          [WASTE, 41],
        ],
        // 端数が出る比率(素朴な区間ごとの floor では分割不変性が壊れる値)
        ratio: [[WOOD, 333_333]],
      }),
      traitDefs: [craftsman],
    });
    const state = stateOf([
      {
        ...resident("aRui", { traitIds: [craftsman.id] }),
        stats: {
          vigor: fixFromInt(73),
          dexterity: fixFromInt(41),
          intellect: fixFromInt(58),
          fortitude: fixFromInt(12),
          will: fixFromInt(99),
        },
      },
      resident("bMina", { morale: fixFromInt(20) }),
      facility("fHearth", HEARTH.id, 0, [id("aRui"), id("bMina")]),
      research("rBronze", TECH_BRONZE.id, 0),
      resource("rWaste", WASTE, 0),
      resource("rWood", WOOD, 0),
    ]);
    return { state, content };
  }

  for (const [splitTick, toTick] of SPLIT_CASES) {
    it(`advance(0→${String(toTick)}) == advance(0→${String(splitTick)})+advance(${String(splitTick)}→${String(toTick)})`, () => {
      const { state, content } = richBoard();
      const ctx = createAdvanceContext(state, content);
      const oneShot = advance(state, ctx, toTick);
      const split = advance(advance(state, ctx, splitTick), ctx, toTick);
      expect(JSON.stringify(toSerializable(split))).toBe(JSON.stringify(toSerializable(oneShot)));
    });
  }

  it("3 分割でも一致する(境界を増やしても畳み込みが変わらない)", () => {
    const { state, content } = richBoard();
    const ctx = createAdvanceContext(state, content);
    const oneShot = advance(state, ctx, 4320);
    let split = state;
    for (const boundary of [713, 1440, 2887, 4320]) {
      split = advance(split, ctx, boundary);
    }
    expect(JSON.stringify(toSerializable(split))).toBe(JSON.stringify(toSerializable(oneShot)));
  });

  it("オーバーフローが実際に起きている盤面であること(反証義務)", () => {
    const { state, content } = richBoard();
    const ctx = createAdvanceContext(state, content);
    const done = advance(state, ctx, 4320);
    expect(toRaw(resourceOf(done, "rWood").cumulativeOverflow ?? FIX_ZERO)).toBeGreaterThan(0);
    expect(stockOf(done, "rWaste")).toBeGreaterThan(0);
  });
});

describe("廃材の 3 出口(GDD 6.7)", () => {
  it("(1) 増築コストは上限比率までしか代替できない", () => {
    const cost = fixFromInt(100);
    const result = substituteCostWithWaste(cost, fixFromInt(1000), fixFromRaw(200_000));
    expect(toRaw(result.wasteSpentFix)).toBe(20_000_000);
    expect(toRaw(result.remainingCostFix)).toBe(80_000_000);
  });

  it("(1) 廃材在庫が足りなければ在庫ぶんだけ代替する", () => {
    const result = substituteCostWithWaste(fixFromInt(100), fixFromInt(5), fixFromRaw(200_000));
    expect(toRaw(result.wasteSpentFix)).toBe(5_000_000);
    expect(toRaw(result.remainingCostFix)).toBe(95_000_000);
  });

  it("(2) 成文化の粘土代替は低比率(同じ関数で比率だけ違う)", () => {
    const result = substituteCostWithWaste(fixFromInt(100), fixFromInt(1000), fixFromRaw(50_000));
    expect(toRaw(result.wasteSpentFix)).toBe(5_000_000);
  });

  it("(3) 廃材 N → RP 1 の低率変換", () => {
    expect(toRaw(wasteToResearchPoints(fixFromInt(100), fixFromRaw(100_000)))).toBe(10_000_000);
    expect(toRaw(wasteToResearchPoints(FIX_ZERO, fixFromRaw(100_000)))).toBe(0);
  });

  it("(3) 変換は廃材在庫を引いて現在の研究へ加算する", () => {
    const content = contentOf({ storage: storageParams({}) });
    const state = stateOf([research("rBronze", TECH_BRONZE.id, 0), resource("rWaste", WASTE, 50)]);
    const next = convertWasteToResearchPoints(state, content, fixFromInt(30));
    expect(stockOf(next, "rWaste")).toBe(20_000_000);
    expect(toRaw(requireEntity(next, id("rBronze"), "research").progress)).toBe(3_000_000);
  });

  it("(3) 廃材が未定義の content では停止する(黙って無変換にしない)", () => {
    const content = contentOf();
    const state = stateOf([research("rBronze", TECH_BRONZE.id, 0)]);
    expect(() => convertWasteToResearchPoints(state, content, fixFromInt(1))).toThrow(RulesError);
  });

  it("廃材在庫の参照は content の wasteResourceId を辿る", () => {
    const content = contentOf({ storage: storageParams({}) });
    const state = stateOf([resource("rWaste", WASTE, 12)]);
    expect(toRaw(wasteStockOf(state, content))).toBe(12_000_000);
    expect(toRaw(wasteStockOf(state, contentOf()))).toBe(0);
  });
});

describe("資源消費(spendResources)", () => {
  it("在庫から引く", () => {
    const state = stateOf([resource("rWood", WOOD, 100)]);
    const costs = new Map<EntityId, Fix>([[WOOD, fixFromInt(30)]]);
    expect(stockOf(spendResources(state, costs), "rWood")).toBe(70_000_000);
  });

  it("在庫不足は黙って 0 で止めず停止する", () => {
    const state = stateOf([resource("rWood", WOOD, 10)]);
    const costs = new Map<EntityId, Fix>([[WOOD, fixFromInt(30)]]);
    expect(() => spendResources(state, costs)).toThrow(RulesError);
  });

  it("受け皿が無いコストは停止する", () => {
    const state = stateOf([resource("rWood", WOOD, 10)]);
    const costs = new Map<EntityId, Fix>([[id("iron"), fixFromInt(1)]]);
    expect(() => spendResources(state, costs)).toThrow(RulesError);
  });
});

// ---------------------------------------------------------------------------
// [Phase B・2026-08-06裁定・台帳v20 必-3(2)] 廃材の会計は由来で分かれる(§2c)。
// 施設産出 / 拠点供給((A) 区間の連続流)由来は従来どおり生産会計へ算入し、
// 一括入荷(探索報酬)由来は在庫だけ動かして会計へ算入しない。
// ---------------------------------------------------------------------------

describe("[Phase B] 廃材の会計は由来で分岐する(GDD 11.4-7c の分子/分母)", () => {
  /** 薪は上限 10・超過の 50% が廃材へ。廃材自身は上限 3(= あふれる)。 */
  const SPONGE_STORAGE = storageParams({
    capacity: [
      [WOOD, 10],
      [WASTE, 3],
    ],
    ratio: [[WOOD, 500_000]],
  });

  function wasteBoard(): GameState {
    return stateOf([
      resource("rWaste", WASTE, 0),
      resource("rWood", WOOD, 0),
      resource("rGrain", id("grain"), 0),
    ]);
  }

  it("施設産出由来(連続流)の廃材は従来どおり生産会計へ算入する", () => {
    const content = contentOf({ storage: SPONGE_STORAGE });
    const capacity = resolveCapacityByResourceId(wasteBoard(), content);
    const intake = applyCappedIntake(
      wasteBoard(),
      content.storage,
      capacity,
      resourceOf(wasteBoard(), "rWood"),
      fixFromInt(30),
    );
    const next = creditWasteGain(
      intake.state,
      content.storage,
      capacity,
      intake.wasteGainFix,
      "test",
    );
    // 超過 20 の 50% = 10 が廃材。上限 3 なので在庫 3・超過 7。
    const waste = resourceOf(next, "rWaste");
    expect(toRaw(waste.stock)).toBe(3_000_000);
    expect(toRaw(waste.cumulativeProduced ?? FIX_ZERO)).toBe(10_000_000);
    expect(toRaw(waste.cumulativeOverflow ?? FIX_ZERO)).toBe(7_000_000);
  });

  it("一括入荷由来の廃材は在庫だけ動かし、生産会計を動かさない", () => {
    const content = contentOf({ storage: SPONGE_STORAGE });
    const capacity = resolveCapacityByResourceId(wasteBoard(), content);
    const intake = applyCappedLumpIntake(
      wasteBoard(),
      content.storage,
      capacity,
      resourceOf(wasteBoard(), "rWood"),
      fixFromInt(30),
    );
    const next = creditWasteGain(
      intake.state,
      content.storage,
      capacity,
      intake.wasteGainFix,
      "test",
      "excluded",
    );
    const waste = resourceOf(next, "rWaste");
    // 在庫・上限クランプは施設産出とまったく同じ。
    expect(toRaw(waste.stock)).toBe(3_000_000);
    // 会計だけが動かない(報酬本体と同じ扱い・GDD 8.1⑥)。
    expect(waste.cumulativeProduced).toBeUndefined();
    expect(waste.cumulativeOverflow).toBeUndefined();
  });

  it("除外した廃材は GDD 11.4-7c の分子にも分母にも入らない", () => {
    const content = contentOf({ storage: SPONGE_STORAGE });
    const capacity = resolveCapacityByResourceId(wasteBoard(), content);
    const lump = applyCappedLumpIntake(
      wasteBoard(),
      content.storage,
      capacity,
      resourceOf(wasteBoard(), "rWood"),
      fixFromInt(30),
    );
    const excluded = creditWasteGain(
      lump.state,
      content.storage,
      capacity,
      lump.wasteGainFix,
      "test",
      "excluded",
    );
    // 報酬本体も廃材も会計に触れていないので、盤面の損失率は 0 のまま。
    expect(toRaw(colonyOverflowLossRate(excluded))).toBe(0);
  });

  it("探索報酬の帰還経路が excluded を通る(applyExpeditionReward 相当の往復)", () => {
    // `rules/exploration.ts` の applyExpeditionReward は creditWasteGain へ
    // "excluded" を渡す。ここでは同じ入口を直接踏んで、既定("produced")との
    // 差が会計フィールドの有無として現れることを固定する。
    const content = contentOf({ storage: SPONGE_STORAGE });
    const capacity = resolveCapacityByResourceId(wasteBoard(), content);
    const produced = creditWasteGain(
      wasteBoard(),
      content.storage,
      capacity,
      fixFromInt(10),
      "test",
    );
    const excluded = creditWasteGain(
      wasteBoard(),
      content.storage,
      capacity,
      fixFromInt(10),
      "test",
      "excluded",
    );
    expect(stockOf(produced, "rWaste")).toBe(stockOf(excluded, "rWaste"));
    expect(resourceOf(produced, "rWaste").cumulativeProduced).not.toBeUndefined();
    expect(resourceOf(excluded, "rWaste").cumulativeProduced).toBeUndefined();
  });
});
