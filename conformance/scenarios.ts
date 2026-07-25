// ---------------------------------------------------------------------------
// golden vector 用シナリオ実装(T7 後半) — `docs/design/golden-vector-spec.md` §4
//
// 1 シナリオ = (content patch, 初期 state) の組(spec §4.1)。乱数は使わず、
// コードで一意に構築する。patch は raw JSON 段で当て(検証を迂回しない)、
// 必ず `validateContentBundle` → `loadEngineContent`(`schema/engineContent.ts`)
// の正規経路を通してから engine 内部表現にする。
//
// メタ 3 軸(saveSchemaVersion/contentVersion/algoVersion)は全シナリオ共通で
// 固定リテラル 1(spec §3.4 落とし穴(1) / §4.2)。`fromTick` は全シナリオ 0。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AdjacencyRule } from "../schema/adjacency";
import type { BalanceContent } from "../schema/balance";
import {
  type ContentBundle,
  type RawContentBundle,
  validateContentBundle,
} from "../schema/contentBundle";
import { loadEngineContentOrThrow } from "../schema/engineContent";
import type { FacilityContent } from "../schema/facility";
import type { TechContent } from "../schema/tech";

import { fixFromInt, fixFromRaw, type Fix } from "../src/engine/fp";
import type { EngineContent } from "../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "../src/engine/state/state";
import { createGameState } from "../src/engine/state/update";

/** シナリオ構築の誤り(content 検証/ロード失敗など)。 */
export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

// ===========================================================================
// 1. 型
// ===========================================================================

/**
 * 1 シナリオ。`contentPatch` は raw JSON への差分(null なら base content の
 * まま)。`buildState` は worldSeed を受け取り初期 state を返す(spec §4.1)。
 */
export interface Scenario {
  readonly id: string;
  readonly contentPatch: ((raw: RawContentBundle) => RawContentBundle) | null;
  readonly buildState: (worldSeed: string) => GameState;
}

// ===========================================================================
// 2. base content の読み込み(呼ぶたびに disk から新規に読む = 呼び出し間で
//    可変参照を共有しない)
// ===========================================================================

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

function readContentJson(fileName: string): unknown {
  return JSON.parse(readFileSync(`${CONTENT_DIR}${fileName}`, "utf8")) as unknown;
}

/** `content/*.json` を素の JSON として読む(patch 前の入力)。呼ぶたびに新規オブジェクト。 */
export function loadBaseRawContentBundle(): RawContentBundle {
  return {
    tech: readContentJson("tech.json") as readonly unknown[],
    facility: readContentJson("facility.json") as readonly unknown[],
    trait: readContentJson("trait.json") as readonly unknown[],
    adjacency: readContentJson("adjacency.json"),
    balance: readContentJson("balance.json"),
  };
}

/**
 * シナリオの content patch を適用し、正規経路(validateContentBundle →
 * loadEngineContent)を通して engine 内部表現へ写す。
 *
 * @throws {ScenarioError} 検証/ロードに失敗した場合(シナリオ構築のバグ)
 */
export function resolveScenarioContent(scenario: Scenario): EngineContent {
  const raw = loadBaseRawContentBundle();
  const patched = scenario.contentPatch === null ? raw : scenario.contentPatch(raw);

  const validated = validateContentBundle(patched);
  if (!validated.ok) {
    const detail = validated.issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new ScenarioError(
      `シナリオ "${scenario.id}" の content patch が validateContentBundle を通らない:\n${detail}`,
    );
  }
  return loadEngineContentOrThrow(validated.value);
}

/** 検証済み content バンドルをそのまま欲しい呼び出し側向け(coverage-matrix 生成等では不要)。 */
export function resolveScenarioContentBundle(scenario: Scenario): ContentBundle {
  const raw = loadBaseRawContentBundle();
  const patched = scenario.contentPatch === null ? raw : scenario.contentPatch(raw);
  const validated = validateContentBundle(patched);
  if (!validated.ok) {
    const detail = validated.issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new ScenarioError(
      `シナリオ "${scenario.id}" の content patch が validateContentBundle を通らない:\n${detail}`,
    );
  }
  return validated.value;
}

// ===========================================================================
// 3. content patch ヘルパ(§4.3 の「content patch」列を raw JSON 段で当てる)
// ===========================================================================

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mapById(
  entries: readonly unknown[],
  targetId: string,
  update: (entry: Record<string, unknown>) => Record<string, unknown>,
): unknown[] {
  return entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return record["id"] === targetId ? update(record) : record;
  });
}

/** sc03/sc04: `tech.<techId>.researchCost` を書き換える。 */
function patchTechResearchCost(
  techId: string,
  researchCost: number,
): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => ({
    ...raw,
    tech: mapById(clone(raw.tech), techId, (t) => ({ ...t, researchCost })),
  });
}

/** sc09: 記憶巧者 trait を追加し、balance 側の対応付けを張る。 */
function patchAddMemoryKeeperTrait(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const trait = [
      ...(clone(raw.trait) as unknown[]),
      {
        id: "traitMemoryKeeper",
        effects: [{ stat: "recallResist", op: "add", value: -15 }],
        stackRule: "multiplicative",
        maxPerResident: 3,
      },
    ];
    const balance = clone(raw.balance) as Record<string, unknown>;
    const recallRiskParams = {
      ...(balance["recallRiskParams"] as Record<string, unknown>),
      memoryKeeperTraitId: "traitMemoryKeeper",
    };
    return { ...raw, trait, balance: { ...balance, recallRiskParams } };
  };
}

/**
 * sc11: 過密判定用の facility 定義(smelter/cistern)を追加し、
 * heat|heat を target=any へ差し替え、noise|noise を新規に足す(spec §4.3)。
 */
function patchOvercrowdFixtures(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const smelter = {
      id: "smelter",
      tags: ["heat", "noise"],
      slots: { lv1: 1, lv2: 1, lv3: 2, lv4: 2, lv5: 3 },
      lvCurve: [100, 115, 132.25, 152.0875, 174.900625],
      overflowCapPolicy: "discardExcess",
      footprint: { width: 1, height: 1 },
      harshWork: true,
      output: { kind: "resource", resourceId: "iron" },
    };
    const cistern = {
      id: "cistern",
      tags: ["damp"],
      slots: { lv1: 1, lv2: 1, lv3: 2, lv4: 2, lv5: 3 },
      lvCurve: [150, 172.5, 198.375, 228.13125, 262.350937],
      overflowCapPolicy: "discardExcess",
      footprint: { width: 1, height: 1 },
      harshWork: false,
      output: { kind: "resource", resourceId: "firewood" },
    };
    const facility = [...(clone(raw.facility) as unknown[]), smelter, cistern];

    const adjacency = clone(raw.adjacency) as Record<string, unknown>;
    const tagMatrix: Record<string, AdjacencyRule> = {
      ...(adjacency["tagMatrix"] as Record<string, AdjacencyRule>),
      "heat|heat": { effect: "forgeYield", target: "any", valueFP: 0.4 },
      "noise|noise": { effect: "efficiency", target: "any", valueFP: 0.1 },
    };
    return { ...raw, facility, adjacency: { ...adjacency, tagMatrix } };
  };
}

/** sc12: `facility.hearth.lvCurve` を BigInt フォールバックが起きる巨大値へ差し替える。 */
function patchHearthBigLvCurve(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => ({
    ...raw,
    facility: mapById(clone(raw.facility), "hearth", (f) => ({
      ...f,
      lvCurve: [6_000_000, 6_900_000, 7_935_000, 9_125_250, 10_494_037.5],
    })),
  });
}

/** sc13: 1 分 tick Fallback(ADR-014(3))。 */
function patchOneMinuteCoarseTick(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => ({
    ...raw,
    balance: { ...(clone(raw.balance) as Record<string, unknown>), coarseTickMinutes: 1 },
  });
}

/** sc14: シード揺らぎ無し({0,0} = engine の恒等表現。schema §7 参照)。 */
function patchZeroSeedOffset(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => ({
    ...raw,
    adjacency: {
      ...(clone(raw.adjacency) as Record<string, unknown>),
      seedOffsetRange: { min: 0, max: 0 },
    },
  });
}

// ===========================================================================
// 4. state 構築ヘルパ(spec §4.2: entity ID は ADR-011、fromTick は 0)
// ===========================================================================

const eid = entityIdFromString;

function baseMeta(worldSeed: string): GameStateMeta {
  return { saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1, worldSeed, tick: 0 };
}

interface ResidentOverrides {
  readonly morale?: Fix;
  readonly mastery?: Fix;
  readonly assignedFacilityId?: string | null;
  readonly dispatched?: boolean;
  readonly traitIds?: readonly string[];
  readonly recallImpairedUntilTick?: number;
}

function mkResident(name: string, overrides: ResidentOverrides = {}): ResidentState {
  const assignedFacilityId = overrides.assignedFacilityId;
  return {
    kind: "resident",
    id: eid(name),
    morale: overrides.morale ?? fixFromInt(50),
    mastery: overrides.mastery ?? fixFromInt(0),
    assignedFacilityId:
      assignedFacilityId === undefined || assignedFacilityId === null
        ? null
        : eid(assignedFacilityId),
    dispatched: overrides.dispatched ?? false,
    traitIds: (overrides.traitIds ?? []).map(eid),
    recallImpairedUntilTick: overrides.recallImpairedUntilTick ?? 0,
  };
}

function mkFacility(
  name: string,
  defId: string,
  cellIndex: number,
  workerIds: readonly string[] = [],
  level = 1,
): FacilityState {
  return {
    kind: "facility",
    id: eid(name),
    defId: eid(defId),
    level,
    cellIndex,
    workerIds: workerIds.map(eid),
  };
}

function mkResearch(name: string, techId: string, progressHuman = 0): ResearchState {
  return {
    kind: "research",
    id: eid(name),
    techId: eid(techId),
    progress: fixFromInt(progressHuman),
    completedTick: null,
  };
}

function mkResource(name: string, resourceId: string, stockHuman = 0): ResourceState {
  return {
    kind: "resource",
    id: eid(name),
    resourceId: eid(resourceId),
    stock: fixFromInt(stockHuman),
  };
}

// ===========================================================================
// 5. シナリオごとの盤面(spec §4.3 の表そのもの)
// ===========================================================================

// --- sc01-steady -------------------------------------------------------------

function sc01BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentAnn", { assignedFacilityId: "facilityHearthA" }),
    mkResident("residentBen", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityHearthA", "hearth", 7, ["residentAnn"], 1),
    mkFacility("facilityForgeA", "forge", 8, ["residentBen"], 2),
    mkResource("resourceFirewood", "firewood", 0),
    mkResource("resourceIron", "iron", 0),
  ]);
}

// --- sc02-idle -----------------------------------------------------------------

function sc02BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentAnn"),
    mkFacility("facilityHearthA", "hearth", 0, [], 1),
    mkResource("resourceFirewood", "firewood", 0),
    mkResearch("researchFire", "techFireStarting", 0),
  ]);
}

// --- sc03-research / sc04-offgrid / sc05-preloaded(同じ盤面の骨格) -----------

function sc03Board(researchFireProgressHuman = 0): (worldSeed: string) => GameState {
  return (worldSeed) =>
    createGameState(baseMeta(worldSeed), [
      mkResident("residentAnn", { assignedFacilityId: "facilityDeskA" }),
      mkFacility("facilityDeskA", "workbench", 20, ["residentAnn"], 1),
      mkResearch("researchFire", "techFireStarting", researchFireProgressHuman),
      mkResearch("researchPottery", "techPottery", 0),
    ]);
}

// --- sc06-recall(sc07/sc08/sc09/sc13 の共通骨格) ------------------------------

function sc06Board(adaOverrides: ResidentOverrides = {}): (worldSeed: string) => GameState {
  return (worldSeed) =>
    createGameState(baseMeta(worldSeed), [
      mkResident("residentAda", {
        assignedFacilityId: "facilityForgeA",
        morale: fixFromInt(10),
        ...adaOverrides,
      }),
      mkResident("residentBea", { assignedFacilityId: "facilityForgeA", morale: fixFromInt(10) }),
      mkResident("residentCal", { assignedFacilityId: "facilityForgeA", morale: fixFromInt(10) }),
      mkFacility("facilityForgeA", "forge", 8, ["residentAda", "residentBea", "residentCal"], 1),
      mkResource("resourceIron", "iron", 0),
      mkResearch("researchFire", "techFireStarting", 0),
      mkResearch("researchPottery", "techPottery", 0),
      mkResearch("researchBasketWeaving", "techBasketWeaving", 0),
    ]);
}

// --- sc10-morale-edge ----------------------------------------------------------

function sc10BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentMoraleLowExact", {
      assignedFacilityId: "facilityForgeA",
      morale: fixFromInt(15),
    }),
    mkResident("residentMoraleLowUnder", {
      assignedFacilityId: "facilityForgeA",
      morale: fixFromRaw(14_999_999),
    }),
    mkResident("residentMoraleMidExact", {
      assignedFacilityId: "facilityForgeA",
      morale: fixFromInt(30),
    }),
    mkResident("residentMoraleMidUnder", {
      assignedFacilityId: "facilityForgeA",
      morale: fixFromRaw(29_999_999),
    }),
    mkFacility(
      "facilityForgeA",
      "forge",
      8,
      [
        "residentMoraleLowExact",
        "residentMoraleLowUnder",
        "residentMoraleMidExact",
        "residentMoraleMidUnder",
      ],
      1,
    ),
    mkResource("resourceIron", "iron", 0),
    mkResearch("researchFire", "techFireStarting", 0),
  ]);
}

// --- sc11-overcrowd --------------------------------------------------------------

/**
 * 中心 cell 7 の smelter に対する heat タグ近傍(spec §4.4)。cell 1/2/6/8 の 4 基。
 * 四隅(0/5/42/47)は盤端の回り込み検査用だが、**cell 0 は cell 7 の NW 近傍
 * でもある**(§4.4 の近傍列挙 `[1, 2, 8, 14, 13, 12, 6, 0]` に cell 0 が含まれる)。
 * そのため実際の heat 近傍は 5 件(0,1,2,6,8)になり、§4.4 の「先頭 2 件 = cell1,2 /
 * 超過 2 件」という例示の数値とは一致しない。これは spec 自身の記述内の不整合
 * であり、生成器はシナリオを勝手に変更せず spec §4.3 の表(cell 1/2/6/8 と
 * 四隅 0/5/42/47)をそのまま実装する(要 Opus/ユーザー判断として報告)。
 */
const SC11_HEAT_NEIGHBOR_CELLS = [1, 2, 6, 8] as const;
const SC11_CORNER_CELLS = [0, 5, 42, 47] as const;

function sc11BuildState(worldSeed: string): GameState {
  const entities: EntityState[] = [
    mkFacility("facilitySmelterA", "smelter", 7, ["residentSmelter"], 1),
    mkResident("residentSmelter", { assignedFacilityId: "facilitySmelterA" }),
    mkFacility("facilityCisternA", "cistern", 13, ["residentCistern"], 1),
    mkResident("residentCistern", { assignedFacilityId: "facilityCisternA" }),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ];
  for (const cell of SC11_HEAT_NEIGHBOR_CELLS) {
    const facilityName = `facilityHeat${String(cell)}`;
    const residentName = `residentHeat${String(cell)}`;
    entities.push(mkFacility(facilityName, "hearth", cell, [residentName], 1));
    entities.push(mkResident(residentName, { assignedFacilityId: facilityName }));
  }
  for (const cell of SC11_CORNER_CELLS) {
    const facilityName = `facilityCorner${String(cell)}`;
    const residentName = `residentCorner${String(cell)}`;
    entities.push(mkFacility(facilityName, "hearth", cell, [residentName], 1));
    entities.push(mkResident(residentName, { assignedFacilityId: facilityName }));
  }
  return createGameState(baseMeta(worldSeed), entities);
}

// --- sc12-bigstock -----------------------------------------------------------------

function sc12BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentAnn", { assignedFacilityId: "facilityHearthA" }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentAnn"], 1),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc15-tie ------------------------------------------------------------------

function sc15BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentAda", { recallImpairedUntilTick: 1000 }),
    mkResident("residentBea", { recallImpairedUntilTick: 1000 }),
    mkResident("residentCal", { assignedFacilityId: "facilityDeskA" }),
    mkFacility("facilityDeskA", "workbench", 20, ["residentCal"], 1),
    mkResearch("researchFire", "techFireStarting", 0),
    mkResearch("researchPottery", "techPottery", 0),
  ]);
}

// ===========================================================================
// 6. SCENARIOS(spec §4.3 の表)
// ===========================================================================

const sc06BoardDefault = sc06Board();

export const SCENARIOS: readonly Scenario[] = [
  { id: "sc01-steady", contentPatch: null, buildState: sc01BuildState },
  { id: "sc02-idle", contentPatch: null, buildState: sc02BuildState },
  {
    id: "sc03-research",
    contentPatch: patchTechResearchCost("techFireStarting", 8000),
    buildState: sc03Board(0),
  },
  {
    id: "sc04-offgrid",
    contentPatch: patchTechResearchCost("techFireStarting", 8010),
    buildState: sc03Board(0),
  },
  { id: "sc05-preloaded", contentPatch: null, buildState: sc03Board(30) },
  { id: "sc06-recall", contentPatch: null, buildState: sc06BoardDefault },
  { id: "sc07-clamp-p", contentPatch: null, buildState: sc06Board({ dispatched: true }) },
  {
    id: "sc08-mastery",
    contentPatch: null,
    buildState: sc06Board({ mastery: fixFromRaw(500_000) }),
  },
  {
    id: "sc09-memkeeper",
    contentPatch: patchAddMemoryKeeperTrait(),
    buildState: sc06Board({ traitIds: ["traitMemoryKeeper"] }),
  },
  { id: "sc10-morale-edge", contentPatch: null, buildState: sc10BuildState },
  { id: "sc11-overcrowd", contentPatch: patchOvercrowdFixtures(), buildState: sc11BuildState },
  { id: "sc12-bigstock", contentPatch: patchHearthBigLvCurve(), buildState: sc12BuildState },
  { id: "sc13-onemin", contentPatch: patchOneMinuteCoarseTick(), buildState: sc06BoardDefault },
  { id: "sc14-offset-zero", contentPatch: patchZeroSeedOffset(), buildState: sc01BuildState },
  {
    id: "sc15-tie",
    contentPatch: patchTechResearchCost("techFireStarting", 80_000),
    buildState: sc15BuildState,
  },
];

// re-export しておくと content patch の単体テスト・診断に使える。
export type {
  AdjacencyRule,
  BalanceContent,
  ContentBundle,
  FacilityContent,
  RawContentBundle,
  TechContent,
};
