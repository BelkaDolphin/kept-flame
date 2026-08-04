// ---------------------------------------------------------------------------
// M28: 大移動(Exodus)+ 2 プールナップサック + 周回シード導出 + 継承点。
//   `src/engine/rules/exodus.ts` と `commands.ts` の executeExodus /
//   purchaseInheritBonus。
//
// ロードマップ M28 の検収条件そのものを固定する:
//   (1) 周回シード導出が**同一入力でバイト同一**(GDD 10.5)
//   (2) 継承点の**上限クランプで青天井にならない**(GDD 11.4-6)
//   (3) **検分**: 2 プール競合の解決順が決定論か(rules/exodus.ts §1 の段1〜段4)
// 併せて縮約互換(exodus ブロックを持たない content で M28 以前と同一挙動)も固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { apply, type Command, type CommandRejectionCode } from "../../src/engine/commands";
import { fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import { DOMAIN_TAGS } from "../../src/engine/rng/domainTags";
import {
  availableInheritPoints,
  caravanCapacityFix,
  codifiedRatePercentFix,
  crewCapacity,
  deriveNextWorldSeed,
  earnedInheritPoints,
  executeExodus,
  inheritTierCost,
  inheritTierMax,
  purchaseInheritTier,
  reachedEraOrder,
  recommendExodusPlan,
  resolveExodusPlan,
  spentInheritPoints,
  type ExodusPlan,
} from "../../src/engine/rules/exodus";
import {
  RulesError,
  type EngineContent,
  type EraDef,
  type ExodusParams,
  type FacilityDef,
  type ReclaimParams,
  type RecordMediaParams,
  type TechDef,
} from "../../src/engine/rules/types";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import {
  EMPTY_PROGRESSION,
  entitiesOfKind,
  entityIdFromString,
  inheritTierOf,
  requireEntity,
  type CodifyState,
  type EntityId,
  type EntityState,
  type GameState,
  type ProgressionState,
} from "../../src/engine/state/state";
import { setProgression, setRngState, setTechMemories } from "../../src/engine/state/update";

import { HEARTH, WOOD, content as baseContent, id, resident, resource, stateOf } from "./fixtures";

// --- フィクスチャ -----------------------------------------------------------

const TECH_A1 = id("techAlphaOne"); // e1 / (A) criticalRecoverable
const TECH_A2 = id("techAlphaTwo"); // e2 / (A)
const TECH_B1 = id("techRareOne"); // e2 / (B) rareIrreversible
const TECH_B2 = id("techRareTwo"); // e3 / (B)

const TECH_DEFS = new Map<EntityId, TechDef>([
  [TECH_A1, { id: TECH_A1, researchCostFix: fixFromInt(30), eraId: "e1" }],
  [TECH_A2, { id: TECH_A2, researchCostFix: fixFromInt(60), eraId: "e2" }],
  [
    TECH_B1,
    { id: TECH_B1, researchCostFix: fixFromInt(60), eraId: "e2", lossClass: "rareIrreversible" },
  ],
  [
    TECH_B2,
    { id: TECH_B2, researchCostFix: fixFromInt(120), eraId: "e3", lossClass: "rareIrreversible" },
  ],
]);

const ERA_DEFS = new Map<string, EraDef>([
  [
    "e1",
    {
      id: "e1",
      order: 1,
      baseEraFix: fixFromInt(30),
      multiplierFix: fixFromInt(1),
      gateTechId: TECH_A1,
      criticalPathMax: 3,
    },
  ],
  [
    "e2",
    {
      id: "e2",
      order: 2,
      baseEraFix: fixFromInt(60),
      multiplierFix: fixFromInt(2),
      gateTechId: TECH_A2,
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
      gateTechId: TECH_B2,
      criticalPathMax: 4,
    },
  ],
]);

/** GDD 10.2 追補の媒体別重み(石板 1.0 / 紙 0.25)。 */
const RECORD_MEDIA: RecordMediaParams = {
  baseCostFix: fixFromInt(20),
  baseDurationTicks: 720,
  printingTechId: null,
  printingCostMulFix: fixFromRaw(500_000),
  printingTimeMulFix: fixFromRaw(500_000),
  byMedium: {
    stoneTablet: {
      costMulFix: fixFromInt(1),
      timeMulFix: fixFromInt(1),
      caravanWeightFix: fixFromInt(1),
      flammable: false,
      costResourceId: id("clay"),
    },
    paper: {
      costMulFix: fixFromRaw(600_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: id("paper"),
    },
  },
};

/** content/balance.json の `exodus` ブロックと同値(GDD 10.2〜10.3)。 */
const EXODUS: ExodusParams = {
  caravanRatioFix: fixFromRaw(350_000), // 0.35
  crewRatioFix: fixFromRaw(500_000), // 0.5
  expectedTabletsByEra: new Map([
    ["e1", 8],
    ["e2", 15],
    ["e3", 24],
  ]),
  eraPointsFix: fixFromInt(10),
  codifyRatePointsFix: fixFromRaw(500_000), // 0.5
  survivorPointsFix: fixFromInt(2),
  tierCosts: [50, 75, 113, 169],
  trackBonusPerTier: { caravanCapacity: 2, crewCapacity: 1, startingStock: 25 },
  startingStockResourceId: WOOD,
};

const CONTENT: EngineContent = {
  ...baseContent({ facilityDefs: new Map([[HEARTH.id, HEARTH]]), techDefs: TECH_DEFS }),
  eraDefs: ERA_DEFS,
  recordMedia: RECORD_MEDIA,
  exodus: EXODUS,
};

/** `exodus` ブロックを持たない content(= 周回システム不活性)。 */
const CONTENT_NO_EXODUS: EngineContent = {
  ...baseContent({ facilityDefs: new Map([[HEARTH.id, HEARTH]]), techDefs: TECH_DEFS }),
  eraDefs: ERA_DEFS,
  recordMedia: RECORD_MEDIA,
};

/**
 * [M53] `hearth`/`workbench` が揃い `reclaim` も持つ content(CONTENT の
 * facilityDefs は hearth のみなので、新周回の詰み防止(worldGen.ts)を確かめる
 * ためだけの別 content として作る)。
 */
const WORKBENCH: FacilityDef = {
  id: id("workbench"),
  tags: ["lore"],
  harshWork: false,
  outputPerTickByLevel: [fixFromInt(1), fixFromInt(1), fixFromInt(1), fixFromInt(1), fixFromInt(1)],
  output: { kind: "research" },
};

const RECLAIM: ReclaimParams = {
  baseCostFix: fixFromInt(40),
  costGrowthFix: fixFromRaw(1_150_000),
  costCapFix: fixFromInt(2000),
  costResourceId: WOOD,
  initialRubbleCells: [12, 13, 14],
};

const CONTENT_WITH_STARTER_FACILITIES: EngineContent = {
  ...CONTENT,
  facilityDefs: new Map([
    [HEARTH.id, HEARTH],
    [WORKBENCH.id, WORKBENCH],
  ]),
  reclaim: RECLAIM,
};

/** [M68] 寝床(GDD 6.2「寝床」)。content/facility.json の `bed` と同じ形。 */
const BED: FacilityDef = {
  id: id("bed"),
  tags: ["calm"],
  harshWork: false,
  outputPerTickByLevel: [fixFromInt(0), fixFromInt(0), fixFromInt(0), fixFromInt(0), fixFromInt(0)],
  output: { kind: "research" },
  bedCapacityByLevel: [3, 4, 5, 6, 7],
};

/** [M68] `CONTENT_WITH_STARTER_FACILITIES` + 寝床定義(R4-A15 の新周回検証用)。 */
const CONTENT_WITH_STARTER_FACILITIES_AND_BEDS: EngineContent = {
  ...CONTENT_WITH_STARTER_FACILITIES,
  facilityDefs: new Map([
    [HEARTH.id, HEARTH],
    [WORKBENCH.id, WORKBENCH],
    [BED.id, BED],
  ]),
};

function research(name: string, techId: EntityId, completedTick: number | null): EntityState {
  return {
    kind: "research",
    id: id(name),
    techId,
    progress: fixFromInt(0),
    completedTick,
  };
}

function record(name: string, techId: EntityId, medium: "paper" | "stoneTablet"): CodifyState {
  return {
    kind: "codify",
    id: id(name),
    techId,
    medium,
    requiredWork: fixFromInt(100),
    progress: fixFromInt(100),
    completedTick: 10,
  };
}

/**
 * 代表盤面。住民 4 名 / 研究 4 本すべて完了 / 記録 3 枚(石板 2・紙 1)/
 * 到達エラ = e3。`techMemoryByKey` で (B) の保持者を作ってある。
 */
function board(): GameState {
  const base = stateOf(
    [
      resident("residentAlpha"),
      resident("residentBravo"),
      resident("residentCharlie"),
      resident("residentDelta"),
      resource("stockWood", WOOD, 500),
      research("researchA1", TECH_A1, 100),
      research("researchA2", TECH_A2, 200),
      research("researchB1", TECH_B1, 300),
      research("researchB2", TECH_B2, 400),
      record("codifyA1Tablet", TECH_A1, "stoneTablet"),
      record("codifyA2Paper", TECH_A2, "paper"),
      record("codifyB1Tablet", TECH_B1, "stoneTablet"),
    ],
    { tick: 1000 },
  );
  // (B) の保持者: B1 = alpha / B2 = bravo(bravo だけが B2 を覚えている)。
  return setTechMemories(base, [
    [`residentAlpha|${TECH_B1}`, { masteryFix: fixFromRaw(100_000), impairedUntilTick: 2000 }],
    [`residentBravo|${TECH_B2}`, { masteryFix: fixFromRaw(150_000), impairedUntilTick: 0 }],
  ]);
}

const ALL_RECORDS: readonly EntityId[] = [
  id("codifyA1Tablet"),
  id("codifyA2Paper"),
  id("codifyB1Tablet"),
];

function rejectionCode(state: GameState, content: EngineContent, command: Command): string {
  const result = apply(state, content, command);
  if (result.ok) throw new Error("reject を期待したが成功した");
  return result.rejection.code;
}

// --- 1. 周回シード導出(検収条件 1・GDD 10.5)-------------------------------

describe("周回シード導出(GDD 10.5)", () => {
  it("同一入力からは常にバイト同一の文字列が出る(検収条件)", () => {
    const a = deriveNextWorldSeed("seedAlpha", 1, 84);
    const b = deriveNextWorldSeed("seedAlpha", 1, 84);
    expect(a).toBe(b);
    // 書式は `r<周回回数>-<16進8桁小文字>`(rules/exodus.ts §2)。
    expect(a).toMatch(/^r1-[0-9a-f]{8}$/);
  });

  it("3 入力のいずれか 1 つでも違えば **hash 部分が** 別になる", () => {
    // 出力は `r<周回回数>-<hash>` なので、周回回数だけを変えると接頭辞の差で
    // 文字列は必ず変わってしまう。**salt に実際に混ざっているか**を見るために
    // hash 部分だけを取り出して比較する(接頭辞の差で通る空テストにしない)。
    const hashOf = (seed: string): string => seed.slice(seed.indexOf("-") + 1);
    const base = deriveNextWorldSeed("seedAlpha", 1, 84);
    expect(deriveNextWorldSeed("seedBravo", 1, 84)).not.toBe(base);
    expect(hashOf(deriveNextWorldSeed("seedBravo", 1, 84))).not.toBe(hashOf(base));
    expect(hashOf(deriveNextWorldSeed("seedAlpha", 2, 84))).not.toBe(hashOf(base));
    expect(hashOf(deriveNextWorldSeed("seedAlpha", 1, 85))).not.toBe(hashOf(base));
    // 周回回数と累計継承点を入れ替えても別の hash になる(salt の順序が効く)。
    expect(hashOf(deriveNextWorldSeed("seedAlpha", 84, 1))).not.toBe(hashOf(base));
  });

  it("空文字列 / 非 ASCII の worldSeed でも決定論(fnv1a32 は UTF-16 単位)", () => {
    expect(deriveNextWorldSeed("", 0, 0)).toBe(deriveNextWorldSeed("", 0, 0));
    expect(deriveNextWorldSeed("種", 3, 7)).toBe(deriveNextWorldSeed("種", 3, 7));
    expect(deriveNextWorldSeed("", 0, 0)).not.toBe(deriveNextWorldSeed("種", 0, 0));
  });

  it("周回回数 / 累計継承点が uint32 の外なら RulesError(黙って折り返さない)", () => {
    expect(() => deriveNextWorldSeed("seedAlpha", -1, 0)).toThrow(RulesError);
    expect(() => deriveNextWorldSeed("seedAlpha", 0, 4_294_967_296)).toThrow(RulesError);
    expect(() => deriveNextWorldSeed("seedAlpha", 1.5, 0)).toThrow(RulesError);
  });

  it("16 進 8 桁は前置ゼロを落とさない(書式が実装依存にならない)", () => {
    // 全 salt を舐めて 8 桁でない出力が出ないことを固定する(書式の網羅検査)。
    for (let n = 0; n < 200; n++) {
      expect(deriveNextWorldSeed("seedAlpha", n, n * 7)).toMatch(/^r\d+-[0-9a-f]{8}$/);
    }
  });
});

// --- 2. 継承点の獲得と上限クランプ(検収条件 2・GDD 10.3 / 11.4-6)-----------

describe("継承点(GDD 10.3)", () => {
  it("到達エラ = 完了研究の属するエラの order の最大値", () => {
    expect(reachedEraOrder(board(), CONTENT)).toBe(3);
    const onlyE1 = stateOf([research("researchA1", TECH_A1, 100)]);
    expect(reachedEraOrder(onlyE1, CONTENT)).toBe(1);
    expect(reachedEraOrder(stateOf([research("researchA1", TECH_A1, null)]), CONTENT)).toBe(0);
  });

  it("成文化率は「完了研究のうち記録を持つ本数」の % ", () => {
    // 完了 4 本 / 記録あり 3 本 = 75%。
    expect(toRaw(codifiedRatePercentFix(board()))).toBe(75_000_000);
    expect(toRaw(codifiedRatePercentFix(stateOf([])))).toBe(0);
  });

  it("GDD 10.3 の代表周回(到達E3 + 成文化率60% + 生存12人)が 84 点になる", () => {
    const residents: EntityState[] = [];
    for (let i = 0; i < 12; i++) {
      residents.push(resident(`residentP${String(i).padStart(2, "0")}`));
    }
    // 完了 5 本 / 記録 3 本 = 60%。
    const state = stateOf([
      ...residents,
      research("researchA1", TECH_A1, 1),
      research("researchA2", TECH_A2, 1),
      research("researchB1", TECH_B1, 1),
      research("researchB2", TECH_B2, 1),
      research("researchExtra", TECH_B2, 1),
      record("codifyA1Tablet", TECH_A1, "stoneTablet"),
      record("codifyA2Paper", TECH_A2, "paper"),
      record("codifyB1Tablet", TECH_B1, "stoneTablet"),
    ]);
    // 研究 5 本のうち 3 tech に記録 → 完了本数 5・記録あり本数 3(B2 は 2 本とも記録なし)。
    expect(toRaw(codifiedRatePercentFix(state))).toBe(60_000_000);
    // 3×10 + 60×0.5 + 12×2 = 84
    expect(earnedInheritPoints(state, CONTENT)).toBe(84);
  });

  it("獲得点は四捨五入(round)であって切り捨てではない(GDD 10.3 の round)", () => {
    // 完了 3 本 / 記録 1 本 → 成文化率 33.333333%、×0.5 = 16.666666。
    // 到達 e1(10)+ 生存 1 人(2)と合わせて 28.666666 → round=29 / floor=28。
    const state = stateOf([
      resident("residentSolo"),
      research("researchA1", TECH_A1, 1),
      research("researchA2", TECH_A2, 1),
      research("researchB1", TECH_B1, 1),
      record("codifyA1Tablet", TECH_A1, "stoneTablet"),
    ]);
    expect(toRaw(codifiedRatePercentFix(state))).toBe(33_333_333);
    const eraOnlyContent: EngineContent = {
      ...CONTENT,
      // 到達エラを e1 に固定するため e2/e3 の tech を持たない研究だけにしてある。
    };
    expect(reachedEraOrder(state, eraOnlyContent)).toBe(2);
    // e2 到達(20)+ 16.666666 + 2 = 38.666666 → round = 39。
    expect(earnedInheritPoints(state, eraOnlyContent)).toBe(39);
  });

  it("段階コストは GDD 10.3 の 50/75/113/169 で、上限段で null(青天井にならない)", () => {
    expect(inheritTierMax(EXODUS)).toBe(4);
    expect(inheritTierCost(EXODUS, 0)).toBe(50);
    expect(inheritTierCost(EXODUS, 1)).toBe(75);
    expect(inheritTierCost(EXODUS, 2)).toBe(113);
    expect(inheritTierCost(EXODUS, 3)).toBe(169);
    expect(inheritTierCost(EXODUS, 4)).toBeNull();
    expect(inheritTierCost(EXODUS, 99)).toBeNull();
  });

  it("残高 = 累計 − 購入済み段のコスト総和(累計は購入で減らない)", () => {
    const progression: ProgressionState = {
      runCount: 3,
      cumulativeInheritPoints: 300,
      inheritTiers: [{ track: "caravanCapacity", tier: 2 }],
    };
    expect(spentInheritPoints(progression, EXODUS)).toBe(125); // 50 + 75
    const state = setProgression(board(), progression);
    expect(availableInheritPoints(state, CONTENT)).toBe(175);
    expect(state.progression.cumulativeInheritPoints).toBe(300);
  });

  it("上限段まで買うと累計 407 点で、5 段目は RulesError(検収条件: 青天井禁止)", () => {
    let state = setProgression(board(), {
      runCount: 9,
      cumulativeInheritPoints: 10_000,
      inheritTiers: [],
    });
    for (let n = 0; n < 4; n++) {
      state = purchaseInheritTier(state, CONTENT, "crewCapacity");
    }
    expect(inheritTierOf(state, "crewCapacity")).toBe(4);
    // GDD 10.3「4段(50/75/113/169、累計407点)」。
    expect(spentInheritPoints(state.progression, EXODUS)).toBe(407);
    expect(() => purchaseInheritTier(state, CONTENT, "crewCapacity")).toThrow(RulesError);
    // 上限に張り付いた後は定員も増えなくなる(効果側の青天井も止まる)。
    const capAtMax = crewCapacity(state, CONTENT);
    expect(() => purchaseInheritTier(state, CONTENT, "crewCapacity")).toThrow(RulesError);
    expect(crewCapacity(state, CONTENT)).toBe(capAtMax);
  });

  it("残高が足りなければ購入できない", () => {
    const state = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 49,
      inheritTiers: [],
    });
    expect(() => purchaseInheritTier(state, CONTENT, "caravanCapacity")).toThrow(RulesError);
  });

  it("購入済み段は track 昇順の正準形を保つ(不変条件 (j))", () => {
    let state = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 10_000,
      inheritTiers: [],
    });
    state = purchaseInheritTier(state, CONTENT, "startingStock");
    state = purchaseInheritTier(state, CONTENT, "caravanCapacity");
    state = purchaseInheritTier(state, CONTENT, "crewCapacity");
    expect(state.progression.inheritTiers.map((entry) => entry.track)).toEqual([
      "caravanCapacity",
      "crewCapacity",
      "startingStock",
    ]);
  });
});

// --- 3. 2 プールの容量(GDD 10.2)-------------------------------------------

describe("2 プールの容量(GDD 10.2)", () => {
  it("キャラバン容量 = ceil(想定石版総数(到達エラ) × 0.35) + 継承ボーナス", () => {
    // 到達 e3 → 想定 24 本 → ceil(8.4) = 9。
    expect(toRaw(caravanCapacityFix(board(), CONTENT))).toBe(9_000_000);
    const boosted = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "caravanCapacity", tier: 2 }],
    });
    // 9 + 2 段 × 2 = 13。
    expect(toRaw(caravanCapacityFix(boosted, CONTENT))).toBe(13_000_000);
  });

  it("未到達(完了研究ゼロ)なら容量は継承ボーナスだけ", () => {
    expect(toRaw(caravanCapacityFix(stateOf([]), CONTENT))).toBe(0);
  });

  it("乗員定員 = ceil(生存人数 × 0.5) + 継承ボーナス", () => {
    expect(crewCapacity(board(), CONTENT)).toBe(2); // ceil(4 × 0.5)
    const boosted = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "crewCapacity", tier: 3 }],
    });
    expect(crewCapacity(boosted, CONTENT)).toBe(5);
  });

  it("奇数人数は切り上げ(ceil)", () => {
    const odd = stateOf([resident("residentA"), resident("residentB"), resident("residentC")]);
    expect(crewCapacity(odd, CONTENT)).toBe(2);
  });
});

// --- 4. 検分: 2 プール競合の解決順が決定論か(rules/exodus.ts §1)-------------

describe("2 プールナップサックの解決(検分: 解決順の決定論)", () => {
  it("入力の並び順・重複に依存しない(段1 の正準化)", () => {
    const forward: ExodusPlan = {
      recordIds: [...ALL_RECORDS],
      crewIds: [id("residentAlpha"), id("residentBravo")],
    };
    const shuffled: ExodusPlan = {
      recordIds: [
        ALL_RECORDS[2] as EntityId,
        ALL_RECORDS[0] as EntityId,
        ALL_RECORDS[1] as EntityId,
        ALL_RECORDS[0] as EntityId,
      ],
      crewIds: [id("residentBravo"), id("residentAlpha"), id("residentBravo")],
    };
    const a = resolveExodusPlan(board(), CONTENT, forward);
    const b = resolveExodusPlan(board(), CONTENT, shuffled);
    expect(b).toEqual(a);
    expect(a.carriedRecordIds).toEqual([...ALL_RECORDS].sort());
  });

  it("乗員は定員まで ID 昇順で採用し、超過分を落とす(段2)", () => {
    const plan: ExodusPlan = {
      recordIds: [],
      crewIds: [
        id("residentDelta"),
        id("residentCharlie"),
        id("residentBravo"),
        id("residentAlpha"),
      ],
    };
    const resolution = resolveExodusPlan(board(), CONTENT, plan);
    expect(resolution.crewCapacity).toBe(2);
    expect(resolution.carriedCrewIds).toEqual([id("residentAlpha"), id("residentBravo")]);
    expect(resolution.droppedCrewIds).toEqual([id("residentCharlie"), id("residentDelta")]);
  });

  it("記録は ID 昇順の first-fit(重い石板で打ち切らず軽い紙を拾う・段3)", () => {
    // 容量 1.0 枠だけの盤面を作る(到達 e1 = 想定 8 本 → ceil(2.8) = 3 では
    // 全部入ってしまうので、想定 0 本 + 継承ボーナス 1 段 = 2 枠にする)。
    const narrowContent: EngineContent = {
      ...CONTENT,
      exodus: {
        ...EXODUS,
        expectedTabletsByEra: new Map(),
        trackBonusPerTier: {
          caravanCapacity: 1,
          crewCapacity: 1,
          startingStock: 25,
        },
      },
    };
    const state = setProgression(board(), {
      runCount: 0,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "caravanCapacity", tier: 1 }],
    });
    expect(toRaw(caravanCapacityFix(state, narrowContent))).toBe(1_000_000);
    const resolution = resolveExodusPlan(state, narrowContent, {
      recordIds: [...ALL_RECORDS],
      crewIds: [],
    });
    // 昇順: codifyA1Tablet(1.0) → 枠ぴったり採用。
    //       codifyA2Paper(0.25) → 残 0 で入らない = **飛ばす**。
    //       codifyB1Tablet(1.0) → 同上。
    expect(resolution.carriedRecordIds).toEqual([id("codifyA1Tablet")]);
    expect(resolution.droppedRecordIds).toEqual([id("codifyA2Paper"), id("codifyB1Tablet")]);
    expect(toRaw(resolution.usedCaravanWeightFix)).toBe(1_000_000);
  });

  it("first-fit は溢れた記録を**飛ばして**後続の軽い記録を拾う(前詰め打ち切りではない)", () => {
    // 容量 1.0 枠 / 昇順に 紙(0.25) → 石板(1.0) → 紙(0.25)。
    //   前詰め打ち切りなら 3 枚目も落ちる。first-fit なら 3 枚目は入る。
    //   この 1 本だけが「打ち切り」と「飛ばし」を判別する(§1 段3 の正本)。
    const narrowContent: EngineContent = {
      ...CONTENT,
      exodus: {
        ...EXODUS,
        caravanRatioFix: fixFromRaw(20_000),
        expectedTabletsByEra: new Map([["e3", 24]]),
      },
    };
    const state = stateOf(
      [
        research("researchB2", TECH_B2, 400), // 到達エラ e3 を作る
        record("codifyA1Paper", TECH_A1, "paper"),
        record("codifyA2Tablet", TECH_A2, "stoneTablet"),
        record("codifyA3Paper", TECH_B1, "paper"),
      ],
      { tick: 1000 },
    );
    // ceil(24 × 0.02) = ceil(0.48) = 1 枠。
    expect(toRaw(caravanCapacityFix(state, narrowContent))).toBe(1_000_000);
    const resolution = resolveExodusPlan(state, narrowContent, {
      recordIds: [id("codifyA3Paper"), id("codifyA1Paper"), id("codifyA2Tablet")],
      crewIds: [],
    });
    // A1Paper(0.25) 採用 → A2Tablet(1.0) は残 0.75 に入らず**飛ばす** →
    // A3Paper(0.25) は 0.50 で収まるので採用される。
    expect(resolution.carriedRecordIds).toEqual([id("codifyA1Paper"), id("codifyA3Paper")]);
    expect(resolution.droppedRecordIds).toEqual([id("codifyA2Tablet")]);
    expect(toRaw(resolution.usedCaravanWeightFix)).toBe(500_000);
  });

  it("(B) 喪失 = 記録も保持者も持ち出さなかった rareIrreversible(段4)", () => {
    // 何も持ち出さない → B1 / B2 の両方が永久喪失。
    const none = resolveExodusPlan(board(), CONTENT, { recordIds: [], crewIds: [] });
    expect(none.lostRareTechIds).toEqual([TECH_B1, TECH_B2]);

    // B1 の石板を積む → B1 は救われる。
    const withTablet = resolveExodusPlan(board(), CONTENT, {
      recordIds: [id("codifyB1Tablet")],
      crewIds: [],
    });
    expect(withTablet.lostRareTechIds).toEqual([TECH_B2]);

    // B2 の保持者(bravo)を連れて行く → B2 も救われる(石版でなく人で救う側)。
    const withCrew = resolveExodusPlan(board(), CONTENT, {
      recordIds: [id("codifyB1Tablet")],
      crewIds: [id("residentBravo")],
    });
    expect(withCrew.lostRareTechIds).toEqual([]);
  });

  it("定員から溢れた保持者は「連れて行った」に数えない(段2 → 段4 の順序が効く)", () => {
    // 定員 1 名の盤面で bravo(B2 保持者)を 2 番目に置くと落ちる。
    const narrowContent: EngineContent = {
      ...CONTENT,
      exodus: { ...EXODUS, crewRatioFix: fixFromRaw(200_000) }, // ceil(4 × 0.2) = 1
    };
    expect(crewCapacity(board(), narrowContent)).toBe(1);
    const resolution = resolveExodusPlan(board(), narrowContent, {
      recordIds: [],
      crewIds: [id("residentAlpha"), id("residentBravo")],
    });
    expect(resolution.carriedCrewIds).toEqual([id("residentAlpha")]);
    // alpha は B1 保持者なので B1 は救われるが、落ちた bravo の B2 は失われる。
    expect(resolution.lostRareTechIds).toEqual([TECH_B2]);
  });

  it("未完了の記録 / 死亡した住民 / 種別違いは RulesError(黙って読み飛ばさない)", () => {
    const withPending = stateOf([
      research("researchB1", TECH_B1, 100),
      { ...record("codifyPending", TECH_B1, "paper"), completedTick: null },
    ]);
    expect(() =>
      resolveExodusPlan(withPending, CONTENT, { recordIds: [id("codifyPending")], crewIds: [] }),
    ).toThrow(RulesError);

    const withDead = stateOf([
      { ...resident("residentGhost"), life: { bornTick: 0, lifespanTick: 10, diedTick: 5 } },
    ]);
    expect(() =>
      resolveExodusPlan(withDead, CONTENT, { recordIds: [], crewIds: [id("residentGhost")] }),
    ).toThrow(RulesError);

    expect(() =>
      resolveExodusPlan(board(), CONTENT, { recordIds: [id("residentAlpha")], crewIds: [] }),
    ).toThrow(RulesError);
  });

  it("おまかせ選択は決定論で、容量/定員を超えない", () => {
    const a = recommendExodusPlan(board(), CONTENT);
    const b = recommendExodusPlan(board(), CONTENT);
    expect(b).toEqual(a);
    const resolution = resolveExodusPlan(board(), CONTENT, a);
    expect(resolution.droppedRecordIds).toEqual([]);
    expect(resolution.droppedCrewIds).toEqual([]);
    // 唯一保持者(alpha=B1 / bravo=B2)が定員 2 に優先して入る。
    expect(resolution.carriedCrewIds).toEqual([id("residentAlpha"), id("residentBravo")]);
  });
});

// --- 5. 大移動の実行(GDD 10.2 / 10.5 / §3)---------------------------------

describe("大移動の実行(GDD 10.2)", () => {
  it("次周 state のシードは導出値で、周回回数と累計継承点が進む", () => {
    const before = board();
    const earned = earnedInheritPoints(before, CONTENT);
    const after = executeExodus(before, CONTENT, { recordIds: [], crewIds: [] });
    expect(after.progression.runCount).toBe(1);
    expect(after.progression.cumulativeInheritPoints).toBe(earned);
    expect(after.worldSeed).toBe(deriveNextWorldSeed(before.worldSeed, 1, earned));
  });

  it("RNG カウンタが全ドメイン 0 リセットされる(GDD 10.5)", () => {
    // 空の state で size 0 を見ても「もともと空」なので何も検出できない。
    // **進んだストリームを持つ state** から始めて、次周で消えることを確かめる。
    const advanced = setRngState(board(), DOMAIN_TAGS.recallDuration, [1, 2, 3, 4]);
    expect(advanced.rngState.size).toBe(1);
    const after = executeExodus(advanced, CONTENT, { recordIds: [], crewIds: [] });
    expect(after.rngState.size).toBe(0);
  });

  it("worldSeedOverride を渡すと導出せずその値になる(GDD 10.5 の任意シード入力)", () => {
    const after = executeExodus(
      board(),
      CONTENT,
      { recordIds: [], crewIds: [] },
      { worldSeedOverride: "myOwnSeed" },
    );
    expect(after.worldSeed).toBe("myOwnSeed");
  });

  it("同じ入力なら次周 state の直列化バイト列まで一致する(純関数)", () => {
    const plan: ExodusPlan = {
      recordIds: [id("codifyB1Tablet")],
      crewIds: [id("residentAlpha")],
    };
    const a = executeExodus(board(), CONTENT, plan);
    const b = executeExodus(board(), CONTENT, plan);
    expect(JSON.stringify(toSerializable(a))).toBe(JSON.stringify(toSerializable(b)));
  });

  it("積んだ記録の tech は完了のまま(初期解禁)・積まなかった (A) は未完了へ戻る", () => {
    const after = executeExodus(board(), CONTENT, {
      recordIds: [id("codifyA1Tablet")],
      crewIds: [],
    });
    expect(requireEntity(after, id("researchA1"), "research").completedTick).toBe(100);
    const a2 = requireEntity(after, id("researchA2"), "research");
    expect(a2.completedTick).toBeNull();
    expect(toRaw(a2.progress)).toBe(0);
    expect(a2.loss).toBeUndefined();
    // 積んだ記録だけが次周へ載る。
    expect(after.entityStateById.has(id("codifyA1Tablet"))).toBe(true);
    expect(after.entityStateById.has(id("codifyA2Paper"))).toBe(false);
  });

  it("持ち出せなかった (B) は loss{irreversible} が立ち、周回をまたいで残る", () => {
    const after = executeExodus(board(), CONTENT, { recordIds: [], crewIds: [] });
    const b1 = requireEntity(after, id("researchB1"), "research");
    expect(b1.completedTick).toBeNull();
    expect(b1.loss).toEqual({ tick: 1000, irreversible: true });
    // 次の周回でも「今回失った」に数え直されず、記録は保持される。
    const again = executeExodus(after, CONTENT, { recordIds: [], crewIds: [] });
    expect(requireEntity(again, id("researchB1"), "research").loss).toEqual({
      tick: 1000,
      irreversible: true,
    });
    expect(
      resolveExodusPlan(after, CONTENT, { recordIds: [], crewIds: [] }).lostRareTechIds,
    ).toEqual([]);
  });

  it("連れて行った住民だけが載り、techMemory / bond が絞り込まれる", () => {
    const after = executeExodus(board(), CONTENT, {
      recordIds: [],
      crewIds: [id("residentAlpha")],
    });
    expect([...after.entityStateById.keys()].filter((key) => key.startsWith("resident"))).toEqual([
      id("residentAlpha"),
    ]);
    expect([...after.techMemoryByKey.keys()]).toEqual([`residentAlpha|${TECH_B1}`]);
    // 想起困難は旅で解ける。
    expect(after.techMemoryByKey.get(`residentAlpha|${TECH_B1}`)?.impairedUntilTick).toBe(0);
    const alpha = requireEntity(after, id("residentAlpha"), "resident");
    expect(alpha.assignedFacilityId).toBeNull();
    expect(alpha.dispatched).toBe(false);
  });

  it("資源は在庫 0 へ戻り、startingStock 系統のボーナスだけが積まれる", () => {
    const plain = executeExodus(board(), CONTENT, { recordIds: [], crewIds: [] });
    expect(toRaw(requireEntity(plain, id("stockWood"), "resource").stock)).toBe(0);

    const boosted = setProgression(board(), {
      runCount: 0,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "startingStock", tier: 2 }],
    });
    const after = executeExodus(boosted, CONTENT, { recordIds: [], crewIds: [] });
    expect(toRaw(requireEntity(after, id("stockWood"), "resource").stock)).toBe(50_000_000);
  });

  it("tick は継続し、購入済みの継承段は引き継がれる", () => {
    const state = setProgression(board(), {
      runCount: 2,
      cumulativeInheritPoints: 500,
      inheritTiers: [{ track: "crewCapacity", tier: 1 }],
    });
    const after = executeExodus(state, CONTENT, { recordIds: [], crewIds: [] });
    expect(after.tick).toBe(1000);
    expect(after.progression.runCount).toBe(3);
    expect(after.progression.inheritTiers).toEqual([{ track: "crewCapacity", tier: 1 }]);
  });

  it("未帰還の派遣が残っていたら RulesError", () => {
    const withDispatch: GameState = {
      ...board(),
      dispatchSnapshots: [
        {
          id: id("dispatchOne"),
          destinationId: id("destNear"),
          band: "near",
          stance: "cautious",
          memberIds: [id("residentAlpha")],
          dispatchTick: 900,
          returnTick: 1200,
          teamPowerFix: fixFromInt(10),
          nodes: [],
          withdrawn: false,
          rewardFix: fixFromInt(0),
          rewardResourceId: WOOD,
          casualtyMemberIds: [],
        },
      ],
    };
    expect(() => executeExodus(withDispatch, CONTENT, { recordIds: [], crewIds: [] })).toThrow(
      RulesError,
    );
  });
});

// --- 5b. 新周回の開始状態(M53・詰み防止・[2026-08-01裁定] 台帳v7 必-2)-------

describe("新周回の開始状態(M53)", () => {
  it("hearth/workbench が揃った content では、次周に開始施設が置かれ就労者が付く", () => {
    const after = executeExodus(board(), CONTENT_WITH_STARTER_FACILITIES, {
      recordIds: [],
      crewIds: [id("residentAlpha"), id("residentBravo")],
    });
    const facilities = entitiesOfKind(after, "facility");
    expect(facilities.length).toBe(2);
    for (const f of facilities) {
      expect(f.workerIds.length).toBe(1);
    }
  });

  it("開墾コスト(解放数0の1回ぶん)未満に薪在庫を落とさない(詰み防止・GDD9.1)", () => {
    // board() の薪在庫は 500(RECLAIM.baseCostFix=40 を大きく上回る)ので、
    // 「上書きしない」側を固定するにはあえて在庫 0 の盤面で確かめる。
    const empty = stateOf([resident("residentAlpha"), resource("stockWood", WOOD, 0)], {
      tick: 1000,
    });
    const after = executeExodus(empty, CONTENT_WITH_STARTER_FACILITIES, {
      recordIds: [],
      crewIds: [id("residentAlpha")],
    });
    const wood = [...entitiesOfKind(after, "resource")].find((r) => r.resourceId === WOOD);
    expect(wood).toBeDefined();
    expect(toRaw(wood!.stock)).toBeGreaterThanOrEqual(toRaw(RECLAIM.baseCostFix));
  });

  it("[R2-A01] storage を宣言した content では、次周の開始状態にも廃材の受け皿がある", () => {
    // 大移動後の新周回も `placeStartingFacilities`(worldGen.ts)を通るので、
    // 新規ゲームと同じ受け皿が作られる(= 2 周目以降でも保管庫で凍結しない)。
    const withStorage: EngineContent = {
      ...CONTENT_WITH_STARTER_FACILITIES,
      storage: {
        wasteResourceId: id("waste"),
        baseCapacityByResourceId: new Map([[WOOD, fixFromInt(100)]]),
        wasteConversionRatioByResourceId: new Map([[WOOD, fixFromRaw(500_000)]]),
        wasteToResearchRatioFix: fixFromRaw(100_000),
        buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
        codifyWasteSubstitutionMaxFix: fixFromRaw(50_000),
      },
    };
    const after = executeExodus(board(), withStorage, {
      recordIds: [],
      crewIds: [id("residentAlpha")],
    });
    const waste = entitiesOfKind(after, "resource").find((r) => r.resourceId === id("waste"));
    expect(waste).toBeDefined();
    expect(waste?.id).toBe(id("stockWaste"));
    expect(toRaw(waste!.stock)).toBe(0);
  });

  it("hearth のみ(workbench 定義なし)の CONTENT では新周回でも施設は増えない(既存互換)", () => {
    // CONTENT(既存フィクスチャ)は workbench を持たないので、M53 追加後も
    // 施設ゼロの盤面のままである(このファイルの他の全テストの前提が動かない
    // ことの直接固定)。
    const after = executeExodus(board(), CONTENT, { recordIds: [], crewIds: [] });
    expect(entitiesOfKind(after, "facility").length).toBe(0);
  });

  // --- [M68・台帳v17 必-5] 新周回でも粘土+寝床が生成される --------------------

  it("[R4-A11] 新周回でも石板1枚ぶんの粘土が下限保証される(旧実装は newGame.ts 限定)", () => {
    // CONTENT は recordMedia(RECORD_MEDIA: baseCostFix=20 / stoneTablet.costMulFix=1)
    // を持つが、大移動前の board() は粘土在庫を一切持たない。修正前は
    // executeExodus が worldGen.ts の placeStartingFacilities しか通さず、
    // 粘土の下限保証は newGame.ts 側にしか無かったため次周も粘土 0 のままだった。
    const after = executeExodus(board(), CONTENT_WITH_STARTER_FACILITIES, {
      recordIds: [],
      crewIds: [id("residentAlpha")],
    });
    const clay = entitiesOfKind(after, "resource").find((r) => r.resourceId === id("clay"));
    expect(clay).toBeDefined();
    expect(toRaw(clay!.stock)).toBe(toRaw(fixFromInt(20)));
  });

  it("[R4-A11] 大移動の継承資産で粘土が既に floor 以上ならそのまま(重複計上しない)", () => {
    // startingStock 系統のボーナスで粘土在庫が既に floor(20)を上回っている場合、
    // ensureClayFloor は max のみで上書きしない(継承資産の重複計上を作らない)。
    // `carryResource` は大移動「前」に既に存在する resource entity にしか
    // ボーナスを適用しない(rules/exodus.ts §3)ので、あらかじめ粘土 entity を
    // 持つ盤面から始める。
    const withClayStartingStock: EngineContent = {
      ...CONTENT_WITH_STARTER_FACILITIES,
      exodus: { ...EXODUS, startingStockResourceId: id("clay") },
    };
    const before = stateOf([resident("residentAlpha"), resource("stockClay", id("clay"), 5)], {
      tick: 1000,
    });
    const boosted = setProgression(before, {
      runCount: 0,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "startingStock", tier: 2 }], // 25 × 2 = 50 > floor(20)。
    });
    const after = executeExodus(boosted, withClayStartingStock, {
      recordIds: [],
      crewIds: [id("residentAlpha")],
    });
    const clay = entitiesOfKind(after, "resource").find((r) => r.resourceId === id("clay"));
    expect(toRaw(clay!.stock)).toBe(toRaw(fixFromInt(50)));
  });

  it("[R4-A15] bed 定義があれば新周回にも寝床2基が置かれる(晴天漂着の発生条件を開く)", () => {
    const after = executeExodus(board(), CONTENT_WITH_STARTER_FACILITIES_AND_BEDS, {
      recordIds: [],
      crewIds: [id("residentAlpha"), id("residentBravo")],
    });
    const facilities = entitiesOfKind(after, "facility");
    // hearth + workbench + 寝床2基。
    expect(facilities.length).toBe(4);
    const beds = facilities.filter((f) => f.defId === BED.id);
    expect(beds.length).toBe(2);
    for (const bed of beds) {
      expect(bed.level).toBe(1);
      expect(bed.workerIds).toEqual([]);
    }
  });

  it("[R4-A15] bed 定義が無い CONTENT_WITH_STARTER_FACILITIES では新周回でも寝床は増えない(既存互換)", () => {
    const after = executeExodus(board(), CONTENT_WITH_STARTER_FACILITIES, {
      recordIds: [],
      crewIds: [id("residentAlpha"), id("residentBravo")],
    });
    expect(entitiesOfKind(after, "facility").length).toBe(2);
  });
});

// --- 6. コマンド層(commands.ts)----------------------------------------------

describe("executeExodus / purchaseInheritBonus コマンド", () => {
  it("exodus ブロックが無い content では contentUnsupported", () => {
    expect(
      rejectionCode(board(), CONTENT_NO_EXODUS, {
        kind: "executeExodus",
        recordIds: [],
        crewIds: [],
      }),
    ).toBe<CommandRejectionCode>("contentUnsupported");
    expect(
      rejectionCode(board(), CONTENT_NO_EXODUS, {
        kind: "purchaseInheritBonus",
        track: "crewCapacity",
      }),
    ).toBe<CommandRejectionCode>("contentUnsupported");
  });

  it("容量 / 定員の超過は clamp せず exodusCapacityExceeded で拒否する", () => {
    expect(
      rejectionCode(board(), CONTENT, {
        kind: "executeExodus",
        recordIds: [],
        crewIds: [id("residentAlpha"), id("residentBravo"), id("residentCharlie")],
      }),
    ).toBe<CommandRejectionCode>("exodusCapacityExceeded");
  });

  it("未帰還の派遣 / 未完了記録 / 死亡住民 / 空シードは値で拒否する", () => {
    expect(
      rejectionCode(board(), CONTENT, {
        kind: "executeExodus",
        recordIds: [],
        crewIds: [],
        worldSeedOverride: "",
      }),
    ).toBe<CommandRejectionCode>("invalidArgument");
    expect(
      rejectionCode(board(), CONTENT, {
        kind: "executeExodus",
        recordIds: [id("codifyMissing")],
        crewIds: [],
      }),
    ).toBe<CommandRejectionCode>("entityNotFound");
  });

  it("[M53] 乗員 0 名は exodusNoCrew で拒否する(誰も連れて行かないと詰む)", () => {
    expect(
      rejectionCode(board(), CONTENT, {
        kind: "executeExodus",
        recordIds: [],
        crewIds: [],
      }),
    ).toBe<CommandRejectionCode>("exodusNoCrew");
  });

  it("[M53] 乗員 0 名以外の値検査(recordIds の実在)は exodusNoCrew より先に通る", () => {
    // crewIds:[] と同時に recordIds が不正なら、既存の entityNotFound が先に出る
    // (commands.ts の検査順: 参照の妥当性 → 乗員0名)。
    expect(
      rejectionCode(board(), CONTENT, {
        kind: "executeExodus",
        recordIds: [id("codifyMissing")],
        crewIds: [],
      }),
    ).toBe<CommandRejectionCode>("entityNotFound");
  });

  it("成功すると state が次周のものへ差し替わる", () => {
    const result = apply(board(), CONTENT, {
      kind: "executeExodus",
      recordIds: [id("codifyB1Tablet")],
      crewIds: [id("residentAlpha")],
    });
    if (!result.ok) throw new Error(`成功を期待したが ${result.rejection.code}`);
    expect(result.state.progression.runCount).toBe(1);
    expect(result.commandCount).toBe(1);
  });

  it("継承ボーナスの購入は残高不足 / 上限段を機械可読に拒否する", () => {
    const poor = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 10,
      inheritTiers: [],
    });
    expect(
      rejectionCode(poor, CONTENT, { kind: "purchaseInheritBonus", track: "caravanCapacity" }),
    ).toBe<CommandRejectionCode>("insufficientInheritPoints");

    const maxed = setProgression(board(), {
      runCount: 9,
      cumulativeInheritPoints: 10_000,
      inheritTiers: [{ track: "caravanCapacity", tier: 4 }],
    });
    expect(
      rejectionCode(maxed, CONTENT, { kind: "purchaseInheritBonus", track: "caravanCapacity" }),
    ).toBe<CommandRejectionCode>("inheritTierAtMax");
  });

  it("購入が成功すると段数とボーナスが 1 段ぶん増える", () => {
    const rich = setProgression(board(), {
      runCount: 1,
      cumulativeInheritPoints: 200,
      inheritTiers: [],
    });
    const before = crewCapacity(rich, CONTENT);
    const result = apply(rich, CONTENT, {
      kind: "purchaseInheritBonus",
      track: "crewCapacity",
    });
    if (!result.ok) throw new Error(`成功を期待したが ${result.rejection.code}`);
    expect(inheritTierOf(result.state, "crewCapacity")).toBe(1);
    expect(crewCapacity(result.state, CONTENT)).toBe(before + 1);
    expect(availableInheritPoints(result.state, CONTENT)).toBe(150);
  });
});

// --- 7. 縮約互換(M28 以前と 1 bit も違わないこと)---------------------------

describe("縮約互換(golden 不変の根拠)", () => {
  it("既定の progression を持つ state は直列化形に progression キーを出さない", () => {
    expect(stateOf([]).progression).toEqual(EMPTY_PROGRESSION);
    expect(Object.keys(toSerializable(stateOf([])))).not.toContain("progression");
  });

  it("progression キーを持たない直列化形は既定として復元される(旧セーブの無損失ロード)", () => {
    const json = toSerializable(board()) as unknown as Record<string, unknown>;
    expect(json["progression"]).toBeUndefined();
    const restored = fromSerializable(json);
    expect(restored.progression).toEqual(EMPTY_PROGRESSION);
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(json));
  });

  it("既定値を明示した progression は非正準形として reject(往復バイト同一の維持)", () => {
    const json = toSerializable(board()) as unknown as Record<string, unknown>;
    json["progression"] = { runCount: 0, cumulativeInheritPoints: 0, inheritTiers: [] };
    expect(() => fromSerializable(json)).toThrow();
  });

  it("progression を持つ state は往復でバイト同一", () => {
    const state = setProgression(board(), {
      runCount: 4,
      cumulativeInheritPoints: 407,
      inheritTiers: [
        { track: "caravanCapacity", tier: 2 },
        { track: "startingStock", tier: 1 },
      ],
    });
    const json = toSerializable(state) as unknown as Record<string, unknown>;
    expect(json["progression"]).toEqual({
      runCount: 4,
      cumulativeInheritPoints: 407,
      inheritTiers: [
        { track: "caravanCapacity", tier: 2 },
        { track: "startingStock", tier: 1 },
      ],
    });
    const restored = fromSerializable(json);
    expect(restored.progression).toEqual(state.progression);
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(json));
  });

  it("未登録の継承系統を含む直列化形は reject(レジストリ整合)", () => {
    const json = toSerializable(board()) as unknown as Record<string, unknown>;
    json["progression"] = {
      runCount: 1,
      cumulativeInheritPoints: 0,
      inheritTiers: [{ track: "researchSpeed", tier: 1 }],
    };
    expect(() => fromSerializable(json)).toThrow();
  });

  it("track 昇順が崩れた progression は state 構築時に停止する(不変条件 (j))", () => {
    expect(() =>
      setProgression(board(), {
        runCount: 1,
        cumulativeInheritPoints: 0,
        inheritTiers: [
          { track: "crewCapacity", tier: 1 },
          { track: "caravanCapacity", tier: 1 },
        ],
      }),
    ).toThrow();
    expect(() =>
      setProgression(board(), {
        runCount: 1,
        cumulativeInheritPoints: 0,
        inheritTiers: [{ track: "crewCapacity", tier: 0 }],
      }),
    ).toThrow();
  });

  it("entityIdFromString 経由の ID しか受け付けない(ADR-011)", () => {
    expect(() => entityIdFromString("Resident")).toThrow();
  });
});
