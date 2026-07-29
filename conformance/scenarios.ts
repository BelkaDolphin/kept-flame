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
import type { ResidentStats } from "../src/engine/rules/stats";
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

/**
 * sc09: 記憶巧者 trait を追加し、balance 側の対応付けを張る。
 *
 * **[2026-07-29 M10] 冪等化**: base content の trait ID 統一(裁定③)により
 * `content/trait.json` は既に `traitMemoryKeeper`(旧 `traitLivingLibrary`)を持つ。
 * このパッチは元々「base に無い trait を patch で足す」T7 時点の設計だったため、
 * ID が既に存在する場合に素朴に追加すると ADR-024(1) のグローバル ID 一意性
 * 違反で `validateContentBundle` が reject する。したがって **ID が base に
 * 既にあれば追加しない**(base の定義をそのまま使う)。`balance.recallRiskParams.
 * memoryKeeperTraitId` の設定は無条件に行う(base に既に同値が設定されていれば
 * 単なる上書き = 冪等)。
 */
function patchAddMemoryKeeperTrait(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const existingTrait = clone(raw.trait) as unknown[];
    const alreadyPresent = existingTrait.some(
      (entry) => (entry as Record<string, unknown>)["id"] === "traitMemoryKeeper",
    );
    const trait = alreadyPresent
      ? existingTrait
      : [
          ...existingTrait,
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

/** {@link patchOvercrowdFixtures} の可変部(sc11 と sc16 で値だけが違う)。 */
interface OvercrowdPatchOptions {
  /** `heat|heat`(target=any)の係数。 */
  readonly heatHeatValueFP: number;
  /** `noise|noise`(target=any)の係数。 */
  readonly noiseNoiseValueFP: number;
  /** 指定時のみ `adjacency.overcrowd.penaltyPerExcessFP` を差し替える。 */
  readonly penaltyPerExcessFP?: number;
}

/**
 * sc11 / sc16: 過密判定用の facility 定義(smelter/cistern)を追加し、
 * heat|heat を target=any へ差し替え、noise|noise を新規に足す(spec §4.3)。
 * sc16 は加えて過密ペナルティを強め、ペナ側クランプが実際に発動する値にする。
 */
function patchOvercrowdFixtures(
  options: OvercrowdPatchOptions,
): (raw: RawContentBundle) => RawContentBundle {
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
      "heat|heat": { effect: "forgeYield", target: "any", valueFP: options.heatHeatValueFP },
      "noise|noise": { effect: "efficiency", target: "any", valueFP: options.noiseNoiseValueFP },
    };
    const patched: Record<string, unknown> = { ...adjacency, tagMatrix };
    if (options.penaltyPerExcessFP !== undefined) {
      patched["overcrowd"] = {
        ...(adjacency["overcrowd"] as Record<string, unknown>),
        penaltyPerExcessFP: options.penaltyPerExcessFP,
      };
    }
    return { ...raw, facility, adjacency: patched };
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

/**
 * [M10] sc18: 保管庫オーバーフロー(GDD 6.7)を発動させるため
 * `balance.storage.baseCapacity` へ firewood/iron の上限を追加する。
 * `wasteConversionRatio`(firewood=0.5)は base content に既にあるので触らない
 * (firewood はスポンジ変換・iron は変換率未登録のため破棄のみ、の対比を作る)。
 */
function patchStorageCapacity(
  capacityByResourceId: Record<string, number>,
): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const balance = clone(raw.balance) as Record<string, unknown>;
    const storage = clone(balance["storage"]) as Record<string, unknown>;
    return {
      ...raw,
      balance: {
        ...balance,
        storage: {
          ...storage,
          baseCapacity: {
            ...(storage["baseCapacity"] as Record<string, unknown>),
            ...capacityByResourceId,
          },
        },
      },
    };
  };
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
  /**
   * [M10] ステータス 5 種(裁定 B8)を明示指定する。省略時は
   * {@link ResidentState.stats} が undefined のままで、rules/stats.ts の
   * `NEUTRAL_RESIDENT_STATS` 既定(全て基準 50)が使われる。
   */
  readonly stats?: ResidentStats;
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
    ...(overrides.stats === undefined ? {} : { stats: overrides.stats }),
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
 * そのため実際の heat 近傍は **5 件**(0,1,2,6,8)= 有効 2 件 + 超過 3 件になる。
 *
 * **[2026-07-26 Fable5 裁定]** シナリオはこのまま維持し、誤っていた spec §4.3/§4.4
 * の記述(「同一タグ 4 件 / 超過 2 件」)を実態へ修正した。加えて、この盤面で
 * 「辞書順で選抜された個体」は原理的に観測できない(ボーナスは (selfTag, tag)
 * ペアのみで決まり近傍の個体に非依存 = `computeCellAdjacency` の `ordered[i]` は
 * 読まれない)ことも裁定済みで、詳細は `conformance/coverage.json` の
 * `adj-overcrowd-effective-limit` の note と spec §4.4 / §8-9 にある。
 * sc11 で実際に digest へ出るのは超過ペナ(3 × -0.10 = -0.30)とボーナス側の
 * ±60% クランプであり、**本数制限そのものとペナ側クランプは sc16 が観測する**。
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

// --- sc16-overcrowd-fine ----------------------------------------------------------

/**
 * 中心 cell 7 の 8 近傍を**全て**埋める(spec §4.5)。方向順 N,NE,E,SE,S,SW,W,NW =
 * `[1, 2, 8, 14, 13, 12, 6, 0]` の昇順表記。cell 8 だけ 2 基目の smelter
 * (heat+noise)にし、残り 7 セルは hearth(heat)。
 *
 * これで中心 smelter から見て
 *   - heat バケツ 8 件 → 有効 2 件 + 超過 6 件(6 × -0.15 = -0.90 → clamp -0.60)
 *   - noise バケツ 1 件(cell 8 の smelter)→ noise|noise が**効果レベルで発火**
 * となり、sc11 では観測できなかった「本数制限そのもの」「ペナ側クランプの発動」
 * 「複数タグ施設の同時参加」の 3 つが digest に出る(spec §4.5)。
 */
const SC16_NEIGHBOR_CELLS = [0, 1, 2, 6, 8, 12, 13, 14] as const;
const SC16_SECOND_SMELTER_CELL = 8;

function sc16BuildState(worldSeed: string): GameState {
  const entities: EntityState[] = [
    mkFacility("facilitySmelterA", "smelter", 7, ["residentSmelterA"], 1),
    mkResident("residentSmelterA", { assignedFacilityId: "facilitySmelterA" }),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ];
  for (const cell of SC16_NEIGHBOR_CELLS) {
    const isSecondSmelter = cell === SC16_SECOND_SMELTER_CELL;
    const facilityName = isSecondSmelter ? "facilitySmelterB" : `facilityHearth${String(cell)}`;
    const residentName = isSecondSmelter ? "residentSmelterB" : `residentHearth${String(cell)}`;
    entities.push(
      mkFacility(facilityName, isSecondSmelter ? "smelter" : "hearth", cell, [residentName], 1),
    );
    entities.push(mkResident(residentName, { assignedFacilityId: facilityName }));
  }
  return createGameState(baseMeta(worldSeed), entities);
}

// --- sc17-prod-full(M5→M10: 生産式の実 content 被覆) -------------------------

/**
 * [M10] 実 content の facility.statWeights(forge: vigor0.4/dex0.3/intellect0/
 * fortitude0.3/will0)+ trait(traitArtisan: dexterity ×1.2 mul + yieldMul ×1.1)
 * が生産式の重み付き和(GDD 11.1)まで実際に届くことを固定する。
 *
 * 住民のステータス(80,60,10,70,20)と trait の組合せは
 * `tests/engine/rulesStatsContent.test.ts`(「職人: 器用 ×1.2 と yieldMul ×1.1
 * が別項として掛かる」)で手検算済みの値をそのまま流用する
 * (`residentContribution` = raw 1,641,200)。forge 1 基のみを孤立配置し隣接効果を
 * 発生させない(worldSeed 依存性を持ち込まず生産式だけを見るため)。
 */
function sc17BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentArtisan", {
      assignedFacilityId: "facilityForgeA",
      stats: {
        vigor: fixFromInt(80),
        dexterity: fixFromInt(60),
        intellect: fixFromInt(10),
        fortitude: fixFromInt(70),
        will: fixFromInt(20),
      },
      traitIds: ["traitArtisan"],
    }),
    mkFacility("facilityForgeA", "forge", 0, ["residentArtisan"], 1),
    mkResource("resourceIron", "iron", 0),
  ]);
}

// --- sc18-sto-overflow(M5→M10: 保管庫オーバーフロー全系統) --------------------

/**
 * [M10] GDD 6.7 の保管庫オーバーフロー・廃材スポンジ・資源ごと独立判定を
 * golden vector で固定する。hearth(firewood 産出・cell 0)と forge(iron 産出・
 * cell 47)は 8 近傍が重ならない配置にして隣接効果を無効化する(= worldSeed に
 * 依存しない、production/storage だけを見るシナリオ)。research entity を
 * 置かないため recall の試行が 0 件になり((C) 判定ペアは全 resident × 全
 * research entity の techId・recall.ts §3(a))、想起困難による稼働停止も
 * 発生しない = 全 1440 tick が単一の (A) 区間(rate-change イベントが 1 件も
 * 無い)。よってオーバーフロー会計は「区間全体の産出を一括で容量へ通す」
 * 純粋な形になる。
 *
 * firewood は base content が既に持つ `wasteConversionRatio.firewood = 0.5`
 * によりスポンジ変換(超過分の一部が廃材化)、iron は変換率未登録のため
 * 超過分が単純破棄される対比を作る。
 */
function sc18BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentHearthKeeper", { assignedFacilityId: "facilityHearthA" }),
    mkResident("residentSmith", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentHearthKeeper"], 1),
    mkFacility("facilityForgeA", "forge", 47, ["residentSmith"], 1),
    mkResource("resourceFirewood", "firewood", 0),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceWaste", "waste", 0),
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
  {
    id: "sc11-overcrowd",
    contentPatch: patchOvercrowdFixtures({ heatHeatValueFP: 0.4, noiseNoiseValueFP: 0.1 }),
    buildState: sc11BuildState,
  },
  { id: "sc12-bigstock", contentPatch: patchHearthBigLvCurve(), buildState: sc12BuildState },
  { id: "sc13-onemin", contentPatch: patchOneMinuteCoarseTick(), buildState: sc06BoardDefault },
  { id: "sc14-offset-zero", contentPatch: patchZeroSeedOffset(), buildState: sc01BuildState },
  {
    id: "sc15-tie",
    contentPatch: patchTechResearchCost("techFireStarting", 80_000),
    buildState: sc15BuildState,
  },
  {
    id: "sc16-overcrowd-fine",
    contentPatch: patchOvercrowdFixtures({
      heatHeatValueFP: 0.1,
      noiseNoiseValueFP: 0.1,
      penaltyPerExcessFP: -0.15,
    }),
    buildState: sc16BuildState,
  },
  { id: "sc17-prod-full", contentPatch: null, buildState: sc17BuildState },
  {
    id: "sc18-sto-overflow",
    contentPatch: patchStorageCapacity({ firewood: 500, iron: 2000 }),
    buildState: sc18BuildState,
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
