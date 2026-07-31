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
import { techMemoryKeyOf } from "../src/engine/rules/techMemory";
import type { DistanceBand, EngineContent } from "../src/engine/rules/types";
import {
  entityIdFromString,
  type CodifyState,
  type DispatchNode,
  type DispatchSnapshot,
  type DispatchStance,
  type EntityState,
  type FacilityFootprint,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type OutpostState,
  type ResearchState,
  type ResidentLife,
  type ResidentState,
  type ResourceState,
  type TechMemoryState,
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

/**
 * [M50] patch が新設する facility へ付ける建設/増築コスト(GDD 12.1
 * [2026-07-30裁定]。`schema/engineContent.ts` の `toFacilityDef` が欠落を
 * reject する = 「schema では省略可・ローダーでは必須」の二段構え)。
 *
 * **値は golden vector に一切影響しない**。コストを読むのは `commands.ts` の
 * 配置/増築コマンドだけで、golden シナリオはコマンドを 1 つも実行せず
 * `advance` だけを回すためである(rules/types.ts の `FacilityDef.cost` の doc)。
 * よってここは「ローダーを通すための最小の埋め草」であり、盤面の意味を持たない。
 */
const PATCH_FACILITY_COST = {
  buildCost: { resourceId: "firewood", amount: 1 },
  upgradeCostCurve: [1, 1, 1, 1, 1],
} as const;

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
      ...PATCH_FACILITY_COST,
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
      ...PATCH_FACILITY_COST,
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

/**
 * [M15] 寝床のみを提供する施設(GDD 7.7)を追加する。産出は持たない
 * (`lvCurve` を全 Lv 0 にする)ので、人口下限/晴天漂着だけを起動し、
 * 隣接効果・生産式へ余計な項を持ち込まない。`content/balance.json` の
 * `townParams` は base content に既に存在する(M11)ため、この patch を
 * 単独で足すだけで晴天漂着/人口下限が起動する(rules/population.ts §1)。
 */
function patchAddBunkhouse(bedCapacityLv1: number): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const bunkhouse = {
      id: "bunkhouse",
      tags: ["calm"],
      slots: { lv1: 0, lv2: 0, lv3: 0, lv4: 0, lv5: 0 },
      // lvCurve は schema 上「正の値・狭義単調増加」が必須(0 は不可)なので
      // 表現できる最小値を刻む。workerSlotsByLevel が全 Lv 0(就労不可)なので
      // activeLaborFix は常に 0 になり、この値自体は産出に一切効かない。
      lvCurve: [0.000001, 0.000002, 0.000003, 0.000004, 0.000005],
      overflowCapPolicy: "discardExcess",
      footprint: { width: 1, height: 1 },
      harshWork: false,
      output: { kind: "resource", resourceId: "firewood" },
      ...PATCH_FACILITY_COST,
      bedCapacityCurve: [
        bedCapacityLv1,
        bedCapacityLv1,
        bedCapacityLv1,
        bedCapacityLv1,
        bedCapacityLv1,
      ],
    };
    return { ...raw, facility: [...(clone(raw.facility) as unknown[]), bunkhouse] };
  };
}

/**
 * [M15] `balance.townParams.arrivalIntervalTicks` を差し替える(晴天漂着の
 * 判定 tick を短縮し、golden vector の run 長を短く保つため)。
 * `scarcityArrivalFrequencyMul` は base content のまま(ローダーが
 * `scarcityArrivalIntervalTicks = floor(arrivalIntervalTicks / 頻度倍率)` を導出する)。
 */
function patchArrivalIntervalTicks(
  arrivalIntervalTicks: number,
): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const balance = clone(raw.balance) as Record<string, unknown>;
    const townParams = clone(balance["townParams"]) as Record<string, unknown>;
    return {
      ...raw,
      balance: { ...balance, townParams: { ...townParams, arrivalIntervalTicks } },
    };
  };
}

/**
 * [M15] `balance.recallRiskParams.masteryGainPerFieldWorkDay`(GDD 11.2 の
 * 実地稼働定着蓄積速度・M13)を差し替える。base content の値(0.00288/日)は
 * 上限 0.20 へ届くまで約 69 日(約 10 万 tick)を要し golden vector の run が
 * 長くなりすぎるため、蓄積速度を上げて短い run で上限クランプへ届かせる。
 */
function patchMasteryGainRate(
  masteryGainPerFieldWorkDay: number,
): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const balance = clone(raw.balance) as Record<string, unknown>;
    const recallRiskParams = clone(balance["recallRiskParams"]) as Record<string, unknown>;
    return {
      ...raw,
      balance: {
        ...balance,
        recallRiskParams: { ...recallRiskParams, masteryGainPerFieldWorkDay },
      },
    };
  };
}

/** [M15] 複数の content patch を左から順に適用する合成ヘルパ。 */
function composePatches(
  ...patches: readonly ((raw: RawContentBundle) => RawContentBundle)[]
): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => patches.reduce((acc, patch) => patch(acc), raw);
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
  /**
   * [M15] 生涯(GDD 7.5・M11)を直接指定する。**RNG(lifespan/joinAge ドメイン)を
   * 一切引かずに**「tick T ちょうどに死ぬ住民」を組み立てるための口 —
   * `rules/lifespan.ts` の抽選を経由しないので、死亡そのものの検証シナリオは
   * worldSeed に依存しない(C7 の対象外・sc10 の morale 直接指定と同じ考え方)。
   * 省略時は {@link ResidentState.life} が undefined のまま(= 寿命で死なない)。
   */
  readonly life?: ResidentLife;
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
    ...(overrides.life === undefined ? {} : { life: overrides.life }),
  };
}

/**
 * [M15] `residentDyingAt` と同じ考え方(`tests/engine/lifespanFixtures.ts` の
 * 前例)を conformance 側へ持ち込む: 「tick T ちょうどに死ぬ」`ResidentLife` を
 * `deathTick` から逆算する(`bornTick = deathTick - lifespanTick`)。
 */
function lifeDyingAt(deathTick: number, lifespanTick = 500): ResidentLife {
  return { bornTick: deathTick - lifespanTick, lifespanTick, diedTick: null };
}

/**
 * [M20] `footprint` は省略可の第 6 引数(既定 undefined = 1×1・footprint.ts §2)。
 * 既存呼び出し(footprint 省略)は従来どおり `footprint` キーを持たない
 * `FacilityState` を返すので、既存 56 本の golden vector は 1 bit も動かない。
 *
 * content 側の footprint 定義(例: `forge` の 2×1)とは無関係に、ここで渡した
 * 値が state 側の footprint として焼き込まれる(GDD 6.1 [2026-07-30裁定]:
 * 隣接判定の権威は state であり content ではない)。
 */
function mkFacility(
  name: string,
  defId: string,
  cellIndex: number,
  workerIds: readonly string[] = [],
  level = 1,
  footprint?: FacilityFootprint,
): FacilityState {
  return {
    kind: "facility",
    id: eid(name),
    defId: eid(defId),
    level,
    cellIndex,
    workerIds: workerIds.map(eid),
    ...(footprint === undefined ? {} : { footprint }),
  };
}

function mkResearch(
  name: string,
  techId: string,
  progressHuman = 0,
  completedTick: number | null = null,
): ResearchState {
  return {
    kind: "research",
    id: eid(name),
    techId: eid(techId),
    progress: fixFromInt(progressHuman),
    completedTick,
  };
}

/**
 * [M15] `GameState.techMemoryByKey` の 1 エントリを直接組み立てる
 * (`src/engine/rules/techMemory.ts` の `techMemoryKeyOf` を通す)。
 * RNG を一切引かず「実地稼働で定着済み」「想起困難で停止中」の (住民, 技術) 対を
 * 直接構築するための口(sc08 が `resident.mastery` を直接置くのと同じ考え方)。
 */
function mkTechMemory(
  residentName: string,
  techId: string,
  masteryHuman = 0,
  impairedUntilTick = 0,
): readonly [string, TechMemoryState] {
  return [
    techMemoryKeyOf(eid(residentName), eid(techId)),
    { masteryFix: fixFromInt(masteryHuman), impairedUntilTick },
  ];
}

function mkResource(name: string, resourceId: string, stockHuman = 0): ResourceState {
  return {
    kind: "resource",
    id: eid(name),
    resourceId: eid(resourceId),
    stock: fixFromInt(stockHuman),
  };
}

/**
 * [M22] 記録(完成済み codify entity)を直接組み立てる。RNG も成文化コマンドも
 * 通さずに「記録が n 枚ある盤面」を作るための口(mkTechMemory と同じ考え方)。
 */
function mkCodify(
  name: string,
  techId: string,
  medium: "paper" | "stoneTablet",
  completedTick: number,
): CodifyState {
  return {
    kind: "codify",
    id: eid(name),
    techId: eid(techId),
    medium,
    requiredWork: fixFromInt(1),
    progress: fixFromInt(1),
    completedTick,
  };
}

/**
 * [M50] **作業中**の成文化ジョブ(未完了 codify entity)を直接組み立てる。
 *
 * {@link mkCodify}(完成済み)と対で、こちらは scheduler 段50 の結線
 * (`applyCodifyProgress` / `completeCodification`)が実際に動くことを観測する
 * ための口である。`beginCodification` コマンドを通さないのは golden シナリオが
 * コマンドを持たない(= `advance` だけを回す)ためで、`requiredWork` は
 * `planCodification` が着手時にスナップショットする値そのもの(rules/codify.ts
 * §4(b))なので、確定値を直接置くことは「コマンドが作ったのと同じもの」を
 * 置くことに等しい(`mkDispatchSnapshot` と同じ考え方)。
 */
function mkCodifyJob(
  name: string,
  techId: string,
  medium: "paper" | "stoneTablet",
  requiredWorkTicks: number,
  progressHuman = 0,
): CodifyState {
  return {
    kind: "codify",
    id: eid(name),
    techId: eid(techId),
    medium,
    requiredWork: fixFromInt(requiredWorkTicks),
    progress: fixFromInt(progressHuman),
    completedTick: null,
  };
}

/**
 * [M22] 未帰還の派遣スナップショットを直接組み立てる。
 *
 * `buildDispatchSnapshot`(= 派遣確定コマンド)を通さないのは、golden シナリオが
 * コマンドを持たない(= `advance` だけを回す)形だからである。**スナップショットは
 * 帰還時に content を再参照しない確定値の塊**(GDD 12.5-7)なので、確定値を直接
 * 置くことは「派遣確定コマンドが作ったのと同じもの」を置くことに等しい。
 */
function mkDispatchSnapshot(args: {
  readonly id: string;
  readonly destinationId: string;
  readonly memberIds: readonly string[];
  readonly returnTick: number;
  readonly nodes: readonly DispatchNode[];
  readonly eventId?: string;
  /** [M25] 距離帯(既定 "near")。GDD 8.1 の 3 帯(near/far/deep)を golden で踏むための口。 */
  readonly band?: DistanceBand;
  /** [M25] 派遣方針(既定 "cautious")。 */
  readonly stance?: DispatchStance;
  /** [M25] 派遣を確定した tick(既定 0)。 */
  readonly dispatchTick?: number;
  /** [M25] 帰還時の総報酬(人間単位・既定 0)。 */
  readonly rewardHuman?: number;
  /** [M25] 報酬を受け取る resource 定義 ID(既定 "firewood")。 */
  readonly rewardResourceId?: string;
  /** [M25] 段70 の死亡ゲートへ渡す脱落者(ID 昇順であること・既定なし)。 */
  readonly casualtyMemberIds?: readonly string[];
}): DispatchSnapshot {
  const base: DispatchSnapshot = {
    id: eid(args.id),
    destinationId: eid(args.destinationId),
    band: args.band ?? "near",
    stance: args.stance ?? "cautious",
    memberIds: args.memberIds.map(eid),
    dispatchTick: args.dispatchTick ?? 0,
    returnTick: args.returnTick,
    teamPowerFix: fixFromInt(150),
    nodes: args.nodes,
    withdrawn: false,
    rewardFix: fixFromInt(args.rewardHuman ?? 0),
    rewardResourceId: eid(args.rewardResourceId ?? "firewood"),
    casualtyMemberIds: (args.casualtyMemberIds ?? []).map(eid),
  };
  return args.eventId === undefined ? base : { ...base, eventId: eid(args.eventId) };
}

/**
 * [M25] 衛星拠点 1 基を直接組み立てる(`createGameState` の `outposts` 引数へ渡す)。
 * `mkDispatchSnapshot` と同じ考え方 —— コマンド層(拠点設置)を持たない golden
 * シナリオが、コマンドが作ったのと同じ確定値を直接置くための口。
 */
function mkOutpost(
  name: string,
  outpostTypeId: string,
  band: DistanceBand,
  residentIds: readonly string[],
  overrides: { readonly level?: number; readonly establishedTick?: number } = {},
): OutpostState {
  return {
    id: eid(name),
    outpostTypeId: eid(outpostTypeId),
    level: overrides.level ?? 1,
    band,
    residentIds: residentIds.map(eid),
    establishedTick: overrides.establishedTick ?? 0,
  };
}

/**
 * [M25] `content/outpostType.json`(M24 の実 content・鉱山/農園/林の3タイプ)を
 * そのまま raw バンドルへ足す。base content には未投入(M24 完了時点の申し送り
 * どおり)なので、拠点系シナリオは全て本 patch を要する。`balance.outpost`
 * (distanceBandUpkeepMul)は base content に既にあるので触らない。
 */
function patchAddOutpostType(): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => ({
    ...raw,
    outpostType: readContentJson("outpostType.json") as readonly unknown[],
  });
}

/**
 * [M25] 探索報酬のオーバーフロー方策(GDD 12.1 `item.overflow`・M22)を
 * `balance.exploration.rewardOverflow` へ追加する。base content には無い
 * (M22 完了時点で「ブロックが無ければ上限なし」のまま・schema/balance.ts の doc)。
 */
function patchExplorationRewardOverflow(options: {
  readonly capacity: number;
  readonly policy: "discard" | "convert";
  readonly convertTo?: string;
  readonly ratio?: number;
}): (raw: RawContentBundle) => RawContentBundle {
  return (raw) => {
    const balance = clone(raw.balance) as Record<string, unknown>;
    const exploration = clone(balance["exploration"]) as Record<string, unknown>;
    return {
      ...raw,
      balance: {
        ...balance,
        exploration: {
          ...exploration,
          rewardOverflow: {
            policy: options.policy,
            capacity: options.capacity,
            convertTo: options.convertTo ?? null,
            ratio: options.ratio ?? 0,
          },
        },
      },
    };
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

// --- sc19-tech-field-stop(M13→M15: tech別停止の実地要件施設のみへの適用) -----

/**
 * [M15] M13 検収の持ち越し(sc06 が「想起困難で生産が止まる」経路を観測しなく
 * なった件・MEMORY.md 2026-07-30)への対応。想起困難の tech 別停止
 * (GDD 11.2「当該住民の当該 tech 関連生産のみ停止」)が**実際に生産を 0 へ
 * 止める**ことを、実地要件施設(hearth = techFireStarting の fieldFacilityId)
 * に就労者を置いた盤面で固定する。`techMemoryByKey` を直接構築するので RNG は
 * 一切引かない(sc08 が `resident.mastery` を直接置くのと同じ考え方。
 * worldSeed に依存しないので C7 の対象外)。
 *
 * 2 人を**別々の hearth**(8 近傍が重ならない cell 0 / cell 10)に置くことで、
 *   - `residentPermanent` は run 全体(0→2000)で想起困難が解けない(停止のまま。
 *     `impairedUntilTick = toTick` は「回復 tick が地平線に届かない」ことの
 *     慣用表現・buildEventQueue の `until < toTick` 判定と整合)
 *   - `residentRecovering` は tick 1000 で回復し、以後は稼働へ戻る
 * という「停止したまま」と「停止 → 復帰」の両方を、**同一 vector・同一資源
 * (firewood)の合計**として観測する。
 *
 * **反証(spec §9.2(3)・実施記録は報告書参照)**: 2 基とも Lv1 出力
 * 100 human/tick。停止が無ければ 2000 tick 分 × 2 基 = 400,000,000,000 raw に
 * なるはずだが、実際の期待値は `residentRecovering` が tick 1000〜2000 の
 * 1000 tick だけ稼働する 100,000,000 raw/tick × 1000 = 100,000,000,000 raw
 * (`residentPermanent` は 0 のまま)。両方の `impairedUntilTick` を 0 に変えて
 * 生成し直すと `resourceStockSumRaw` が実際に 400,000,000,000 raw へ動くことを
 * 確認した(engine 無変更・一時的なシナリオ改変のみ)。
 */
function sc19BuildState(worldSeed: string): GameState {
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentPermanent", { assignedFacilityId: "facilityHearthA" }),
      mkFacility("facilityHearthA", "hearth", 0, ["residentPermanent"], 1),
      mkResident("residentRecovering", { assignedFacilityId: "facilityHearthB" }),
      mkFacility("facilityHearthB", "hearth", 10, ["residentRecovering"], 1),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [
      mkTechMemory("residentPermanent", "techFireStarting", 0, 2000),
      mkTechMemory("residentRecovering", "techFireStarting", 0, 1000),
    ],
  );
}

// --- sc20-tech-loss(M13→M15: (B) 一回性喪失・保持者ゼロの判定) ----------------

/**
 * [M15] GDD 7.4 の (B) 一回性喪失(生存保持者ゼロ かつ 記録ゼロ で喪失)を、
 * 3 つの対比が同一 tick(=100)で同時に起きる盤面で固定する:
 *   - `residentSoleFire` は techFireStarting(criticalRecoverable)の唯一の保持者
 *     → 死亡で喪失し (A) 側(`loss.irreversible = false` = 再研究可能)として
 *     reset される
 *   - `residentSoleLens` は techLens(rareIrreversible)の唯一の保持者
 *     → 死亡で喪失し (B) 側(`loss.irreversible = true`)として reset される
 *   - `residentPairPotteryB` は techPottery の保持者だが `residentPairPotteryC`
 *     も同じ tech を保持したまま生存し続ける → **喪失しない**
 *     (反証: `researchPottery` だけ `completedTick`/`progress` が変わらず残る
 *     ことが `probe.researchCompletedCount`(3→1)の差として直接出る。
 *     生存保持者ゼロの条件が壊れて無条件喪失になれば 3→0 になるはずの数値)
 * 3 人とも配属なし(loadW=0)なので (C) 抽選は確率 0 のまま試行だけ引く
 * (sc02 と同型・RNG の結果に依存しないので seed 変化は不要)。
 */
function sc20BuildState(worldSeed: string): GameState {
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentSoleFire", { life: lifeDyingAt(100, 50) }),
      mkResident("residentSoleLens", { life: lifeDyingAt(100, 50) }),
      mkResident("residentPairPotteryB", { life: lifeDyingAt(100, 50) }),
      mkResident("residentPairPotteryC"),
      mkResearch("researchFire", "techFireStarting", 30, 0),
      mkResearch("researchLens", "techLens", 214, 0),
      mkResearch("researchPottery", "techPottery", 36, 0),
    ],
    [],
    [],
    [
      mkTechMemory("residentSoleFire", "techFireStarting", 1),
      mkTechMemory("residentSoleLens", "techLens", 1),
      mkTechMemory("residentPairPotteryB", "techPottery", 1),
      mkTechMemory("residentPairPotteryC", "techPottery", 1),
    ],
  );
}

// --- sc21-tech-mastery-cap(M13→M15: 実地稼働の定着度蓄積 + 上限 0.20 clamp) ---

/**
 * [M15] GDD 11.2 の `masteryResist(u,t)` の実地稼働蓄積(GDD 4「解禁 → 実地稼働で
 * 記憶定着」)と上限 0.20 clamp を固定する。`masteryGainPerFieldWorkDay` を
 * 0.72(patch)へ上げ、1 tick あたりの蓄積を floor(720,000/1440) = **正確に
 * 500 raw**(1440 の約数)にすることで、上限 200,000 raw へ**ちょうど tick 400**
 * で到達する閉形式の値を作る(base content の 0.00288/日だと上限到達に
 * 約 10 万 tick 要り run が長すぎる)。
 *
 * **反証**: 400 tick 分の蓄積(500 raw/tick)で 200,000 raw(= GDD 上限)に届くが、
 * clamp が無ければ tick 1000 到達時点で 500,000 raw(0.5)になっているはずである。
 * `golden:write` 後の `techMemoryByKey` の値が 200,000 raw で頭打ちになって
 * いることを実際の JSON で確認した(報告書参照)。
 */
function sc21BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentMasteryWorker", { assignedFacilityId: "facilityHearthA" }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentMasteryWorker"], 1),
    mkResource("resourceFirewood", "firewood", 0),
    mkResearch("researchFire", "techFireStarting", 30, 0),
  ]);
}

// --- sc22/sc23/sc24-population-floor(M11→M15: 死亡ゲート + 晴天漂着) ---------

/**
 * [M15] GDD 7.6 の人口下限保証(下限割れの死亡は延期)を、寝床上限 10
 * (floor = min(ceil(10×0.5),6) = 5)の盤面で固定する。sc22(生存 5 人 = 下限
 * ちょうど)と sc23(生存 6 人 = 下限+1)は `residentFrail`(tick 47 に死ぬ・
 * 粗粒度グリッド外)以外は完全に同一の盤面であり、**「あと 1 人多いだけ」の差で
 * 死亡が即座に成立するか延期されるかが変わる**ことを反証として直接示す
 * (spec §9.2(3))。
 *
 * `residentFrail` は hearth に配属して産出させておくので、死亡が成立した瞬間
 * (sc23)と延期され続ける間(sc22)の `resourceStockSumRaw` が数値で変わる:
 *   - sc22(延期): tick 100 まで稼働し続ける → 100,000,000 raw/tick × 100 tick
 *     = 10,000,000,000 raw
 *   - sc23(即時死亡): 稼働は tick 47 分のみ → 100,000,000 raw/tick × 47 tick
 *     = 4,700,000,000 raw
 * townParams.arrivalIntervalTicks は base content のまま(4320)なので、
 * run(0→100)の中で晴天漂着は一切発火しない(死亡ゲート単体を見るため)。
 * 晴天漂着との組合せは sc24(同じ盤面 + arrivalIntervalTicks を短縮する patch)
 * が担当する。
 */
/** [M15] sc22〜sc24 共通の寝床上限(Lv1)。floor = min(ceil(10×0.5),6) = 5。 */
const POPULATION_FLOOR_BED_CAPACITY = 10;

function sc22PopulationFloorDeferredBuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentFiller1"),
    mkResident("residentFiller2"),
    mkResident("residentFiller3"),
    mkResident("residentFiller4"),
    mkResident("residentFrail", {
      assignedFacilityId: "facilityHearthA",
      life: lifeDyingAt(47, 47),
    }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentFrail"], 1),
    // [M15] 寝床上限は「content 定義」だけでなく「実際に置かれた施設 entity」の
    // Lv 別値を合計する(rules/population.ts の bedCapacityOf は
    // entitiesOfKind(state,"facility") を走査する)。定義を patch するだけでは
    // 不活性のまま(bedCapacity=0)なので、必ず 1 基置く。
    mkFacility("facilityBunkhouseA", "bunkhouse", 20, [], 1),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

function sc23PopulationFloorActiveBuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentFiller1"),
    mkResident("residentFiller2"),
    mkResident("residentFiller3"),
    mkResident("residentFiller4"),
    mkResident("residentFiller5"),
    mkResident("residentFrail", {
      assignedFacilityId: "facilityHearthA",
      life: lifeDyingAt(47, 47),
    }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentFrail"], 1),
    mkFacility("facilityBunkhouseA", "bunkhouse", 20, [], 1),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

/**
 * [M15] sc22 と同じ盤面(生存 5 人 = 下限ちょうど・`residentFrail` が tick 47 に
 * 死亡延期)に、`townParams.arrivalIntervalTicks` を 200 へ短縮する patch を
 * 重ねたもの。tick 200(粗粒度グリッド上)で
 *   (1) 晴天漂着(段65)が先に走り、寝床(上限 10)に空きがあるので 1 人加入
 *       (生存 5→6)
 *   (2) 直後に死亡(段70)の再判定が走り、6−1=5 ≥ floor(5) で**今度こそ成立**
 * という「延期された死亡が晴天漂着で解消される」全体像と、GDD 11.7 に無い
 * 加入(段65)/死亡(段70)の並び(scheduler.ts §3 の裁定)を同一 tick の実挙動として
 * 固定する。`createResidentLife` が `lifespan`/`joinAge` ドメインを新規に引く
 * ため(base content の 40 本はどの vector も晴天漂着を発火させていない)、
 * C7 に従い alpha/beta の 2 本を用意する。
 */
function sc24PopulationFloorResolvedBuildState(worldSeed: string): GameState {
  return sc22PopulationFloorDeferredBuildState(worldSeed);
}

// --- sc25-life-opt-in(M11→M15: life は住民ごとの opt-in・population floor 不活性) ---

/**
 * [M15] townParams は base content に既に存在するが、**寝床施設が無い盤面では
 * 人口下限/晴天漂着が完全に不活性**であること(rules/population.ts §1)を保ち
 * ながら、`resident.life` を持つ住民だけが寿命で死ぬ(住民ごとの opt-in)ことを
 * 最小盤面で固定する。`residentImmortalAnn`(life 省略)は run 全体で稼働し
 * 続け、`residentMortalBen`(tick 53 に死ぬ・粗粒度グリッド外)は死亡後に稼働
 * から外れる。M11 が「population floor 系の patch を一切足さなくても単独で
 * 動く」ことの最小証明。
 */
function sc25BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentImmortalAnn", { assignedFacilityId: "facilityHearthA" }),
    mkResident("residentMortalBen", {
      assignedFacilityId: "facilityHearthB",
      life: lifeDyingAt(53, 53),
    }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentImmortalAnn"], 1),
    mkFacility("facilityHearthB", "hearth", 10, ["residentMortalBen"], 1),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc26-bond-milestone(M12→M15: 節目の全段記録 + 分割不変性) ----------------

/**
 * [M15] 2 人が同一施設で run 全体(0→75000)を共働し続け、bond 節目
 * (10/25/50・`BOND_MILESTONE_TIER_FIXES`)を**全段**踏む。蓄積レートは
 * engine 定数(694 raw/tick = floor(1e6/1440)・content 非依存)なので、
 * 到達 tick は解析的に **14410 / 36024 / 72047** で固定できる
 * (`rules/bond.ts` の `crossingsInInterval` と同じ式
 * `tick = ceil(threshold/rate)` で手検算済み)。research entity を置かないので
 * (C) 抽選は 0 試行(sc16-overcrowd-fine と同じ理由)= worldSeed に依存しない。
 */
function sc26BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentBondA", { assignedFacilityId: "facilityHearthA" }),
    mkResident("residentBondB", { assignedFacilityId: "facilityHearthA" }),
    mkFacility("facilityHearthA", "hearth", 0, ["residentBondA", "residentBondB"], 1),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc27-partner-loss(M12/M13→M15: 相方喪失の士気ペナ + 死亡時 3処理固定順) ---

/**
 * [M15] GDD 7.3「相方の喪失で bond 相手に一時的士気ペナ」と、死亡時の 3 処理
 * 固定順(①本人の死亡記録 ②相方の記録+士気ペナ ③技術喪失・scheduler.ts §6)を
 * 同一の死亡イベントで同時に固定する。`residentBondX` は techPottery の唯一の
 * 保持者でもあるので、死亡(tick 1000)の瞬間に 3 つの帰結(死亡 memoir /
 * partnerLost + 士気ペナ / 技術喪失)が全て観測できる。bond 値は節目(10)に
 * 届く前(0.694・694 raw/tick × 1000 tick)にしてあり、sc26 の節目テストとは
 * 独立に切り分けてある。
 *
 * **techPottery を選んだ理由(実装時に発見した罠)**: 2 人とも hearth に配属して
 * いるため、hearth の実地要件を持つ tech(techFireStarting 等)を解禁してしまうと
 * `computeMasteryGains` が「その施設で稼働している**全員**」へ定着度を蓄積し、
 * `residentBondY` まで意図せず「保持者」(mastery > 0)になって喪失が起きなく
 * なる(techHoldersOf は生存保持者が 1 人でも残れば対象から外す)。techPottery
 * (fieldFacilityId = workbench)は hearth 勤務と無関係なので、この汚染を避けられる。
 */
function sc27BuildState(worldSeed: string): GameState {
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentBondX", {
        assignedFacilityId: "facilityHearthA",
        life: lifeDyingAt(1000, 1000),
      }),
      mkResident("residentBondY", { assignedFacilityId: "facilityHearthA" }),
      mkFacility("facilityHearthA", "hearth", 0, ["residentBondX", "residentBondY"], 1),
      mkResource("resourceFirewood", "firewood", 0),
      mkResearch("researchPottery", "techPottery", 36, 0),
    ],
    [],
    [],
    [mkTechMemory("residentBondX", "techPottery", 1)],
  );
}

// ===========================================================================
// 6. footprint / 過密シナリオ(M20: conformance 拡張 #3・GDD 6.1/6.3・M16/M17 正本化)
// ===========================================================================
//
// [2026-07-30追記・M17申し送り] 既存 golden 56 本には大型施設が1基も無かった
// (forge の content 定義は 2×1 だが、state 側に footprint を焼き込んだ盤面が
// 一度も無かったため常に 1×1 相当で動いていた)。以下 5 本は
// tests/engine/adjacencyFootprint.test.ts の配置・数値をそのまま流用し、
// 同じ反証(壊すと動く)を full engine pipeline(production → advance →
// golden digest/probe)側でも固定する。反証確認の実測値は
// `docs/MVP実装ロードマップ.md` M20 タスクの完了報告に記録する。

/** 2×1(横長)。W2H1 = width2 height1。 */
const FOOT_2X1: FacilityFootprint = { width: 2, height: 1 };
/** 2×2。 */
const FOOT_2X2: FacilityFootprint = { width: 2, height: 2 };

// --- sc28-foot-basis-2x1(2×1施設の判定基準セルは1×1の8近傍と異なる) -----------

/**
 * [M20] GDD 6.3 の判定基準セル集合(全占有セルの外周8近傍の和集合 − 自セル群)は
 * 1×1 の8近傍と異なる集合になる。base content(no patch)の `heat|heat`
 * (target=forge・+0.2)を使い、forge(content上も2×1定義)を anchor 8 へ
 * state footprint 2×1 で置く。
 *
 * `adjacencyBasisCells(occupiedCells(8, 2×1))` は実測 `[1,2,3,4,7,10,13,14,15,16]`
 * (10 セル)。一方 `neighborCellIndices(8)`(1×1 の8近傍)は実測
 * `[1,2,3,7,9,13,14,15]`。差分の cell 4 は 2×1 の基準セルには入るが 1×1 の
 * 8近傍には入らない ―― cell 4 へ hearth(heat)を置くことで両者の差が
 * `forge` の隣接乗数(1.2 vs 1.0)として観測できる(footprint を外すと
 * multiplier が動く反証は adjacencyFootprint.test.ts の同一配置が数値で
 * 固定済み・conformance 側の反証確認は M20 完了報告に記録)。
 */
function sc28BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentForge", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityForgeA", "forge", 8, ["residentForge"], 1, FOOT_2X1),
    mkFacility("facilityHeatFar", "hearth", 4),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc29-foot-basis-2x2(2×2施設の判定基準セル) -------------------------------

/**
 * [M20] 2×2 の基準セルは 2×1 よりさらに外周が広がる。実測
 * `adjacencyBasisCells(occupiedCells(8, 2×2))` = `[1,2,3,4,7,10,13,16,19,20,21,22]`
 * (12セル)。cell 19/22 は 2×1@8 の基準にも 1×1@8 の8近傍にも含まれない
 * 2×2 固有の下辺外周であり、そこへ hearth を置くことで 2×2 の基準セルが
 * 正しく使われていることが観測できる。
 *
 * content 上 forge は 2×1 定義のままだが GDD 6.1 [2026-07-30裁定]により
 * 隣接判定は state の footprint が権威なので、ここでは state 側だけ 2×2 へ
 * 焼き込む(content 側は無改変 = 配置時焼き込みと隣接判定の分離そのものの
 * 反証を兼ねる)。
 */
function sc29BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentForge", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityForgeA", "forge", 8, ["residentForge"], 1, FOOT_2X2),
    mkFacility("facilityHeatSouthA", "hearth", 19),
    mkFacility("facilityHeatSouthB", "hearth", 22),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc30-foot-neighbor-dedup(近傍側の大型施設も1施設1回) ----------------------

/**
 * [M20] forge(1×1)@8 の8近傍のうち cell 1 と cell 2 の**両方**を、1 基の
 * 2×1 hearth(anchor 1)が占有する。adjacency.ts §3(f)「近傍側の大型施設も
 * 1施設1回」により forge のボーナスは1件分(+0.2)にしかならない ――
 * 施設単位の重複除去が壊れて占有セルごとに数えると2件分(+0.4)になる
 * (反証は adjacencyFootprint.test.ts「2セルで接する2×1の近傍はボーナスも
 * 過密カウントも1件」と同一配置・数値は raw 200,000 vs 400,000)。
 */
function sc30BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentForge", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityForgeA", "forge", 8, ["residentForge"], 1),
    mkFacility("facilityHeatWide", "hearth", 1, [], 1, FOOT_2X1),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// --- sc31-foot-overcrowd-clamp(過密+大型・クランプはタグ横断で1回) -------------

/** 2×1@8 の判定基準セル(実測・昇順)。sc31 は基準セル全部を smelter で埋める。 */
const SC31_BASIS_2X1_AT_8 = [1, 2, 3, 4, 7, 10, 13, 14, 15, 16] as const;

/**
 * [M20] sc16-overcrowd-fine と同じ content patch(`patchOvercrowdFixtures`:
 * heat|heat target=any +0.1・noise|noise target=any +0.1・threshold 3・
 * penaltyPerExcess -0.15・clamp ±0.6)を流用し、中心の smelter(heat+noise)を
 * 2×1 にして基準セル 10 個全部を smelter(heat+noise・1×1)で埋める。
 * tests/engine/adjacencyFootprint.test.ts「タグごとに独立集計し、ペナは
 * **タグ横断の合計**を1回だけクランプする」と同一設定 ―― heat/noise 各10件
 * → 有効2件+超過8件、ペナ生値 2タグ×8×-0.15=-2.40 が clampFix(±0.6)で
 * -0.60 に丸まり乗数 0.8 になる。**タグごとに別々クランプしていたら**
 * 各タグ -1.20→クランプ-0.60ずつで合計-1.20、乗数0.2になる ――
 * この「0.8 vs 0.2」がロードマップ M20 追記の反証素材そのもの
 * (実際の golden 値はシード揺らぎ±20%を含むため素の 0.1 とは僅かに異なるが、
 * 「タグ横断1回 vs タグ別」の相対差はシード非依存で残る)。
 */
function sc31BuildState(worldSeed: string): GameState {
  const entities: EntityState[] = [
    mkResident("residentSmelterCenter", { assignedFacilityId: "facilitySmelterCenter" }),
    mkFacility("facilitySmelterCenter", "smelter", 8, ["residentSmelterCenter"], 1, FOOT_2X1),
    mkResource("resourceIron", "iron", 0),
  ];
  for (const cell of SC31_BASIS_2X1_AT_8) {
    entities.push(mkFacility(`facilitySmelterN${String(cell)}`, "smelter", cell));
  }
  return createGameState(baseMeta(worldSeed), entities);
}

// --- sc32-foot-board-edge(大型施設の盤端配置・回り込み無し) --------------------

/**
 * [M20] forge(2×1)を盤端(anchor 4・x=4,width2 で x+2=6 ちょうど = 右端)へ置く。
 * 基準セルは盤外がクリップされて実測 `[3,9,10,11]`(4セルのみ・8近傍満杯の
 * 10セルより少ない)。cell 3(基準セル内)の hearth は効き、cell 6(次行の
 * 先頭・横方向の回り込みでのみヒットする位置)の hearth は効かない ――
 * 回り込みが起きればここが動く(反証は adjacencyFootprint.test.ts「盤端の
 * 大型施設は回り込まない」と同一配置・数値は raw 0 vs 200,000)。
 */
function sc32BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentForge", { assignedFacilityId: "facilityForgeA" }),
    mkFacility("facilityForgeA", "forge", 4, ["residentForge"], 1, FOOT_2X1),
    mkFacility("facilityHeatBasis", "hearth", 3),
    mkFacility("facilityHeatWrap", "hearth", 6),
    mkResource("resourceIron", "iron", 0),
    mkResource("resourceFirewood", "firewood", 0),
  ]);
}

// ===========================================================================
// 7. SCENARIOS(spec §4.3 の表)
// ===========================================================================

const sc06BoardDefault = sc06Board();

// --- sc33-ev-destroy-records(M22: event 効果プリミティブ destroyRecords) --------

/**
 * [M22] `destroyRecords{medium:"any", scope:"flammable"}` の挙動を固定する
 * (GDD 11.1 [2026-07-27追補] の焼失セマンティクス)。
 *
 * 盤面(entity 7 件 + 未帰還派遣 1 本):
 *   - 記録 3 枚: `techFireStarting` の紙 + 石板、`techPottery` の紙
 *   - `techPottery` は research 完了済み・**保持者ゼロ**(techMemoryByKey が空)
 *   - 派遣 1 本(tick 100 帰還)。1 ノードだけを踏み、その分岐の result が
 *     `destroyRecords{any, flammable}`
 *
 * tick 100 の帰還で紙 2 枚だけが焼け、
 *   - `techFireStarting` : 石板が残るので**成文化済みのまま**(喪失しない)
 *   - `techPottery`      : 記録ゼロ かつ 保持者ゼロ → **周回内喪失**
 *     (research が `completedTick: null` / `progress: 0` / `loss` 付きへ戻る)
 * となる。
 *
 * **反証(spec §9.2(3)):**
 *   - destroyRecords が何もしなければ `probe.entityCount` は 7 のまま(期待 5)
 *   - 可燃フィルタが壊れて石板も燃えれば 4 になる
 *   - 喪失判定が走らなければ research が完了のままで `stateDigest` が動く
 *     (`entityCount` は同じなのでダイジェスト側だけが反証になる)
 *   - 効果がスナップショットから読まれなければ帰還ログの本文も変わる
 */
function sc33BuildState(worldSeed: string): GameState {
  const node: DispatchNode = {
    difficultyFix: fixFromInt(100),
    rollFix: fixFromInt(10),
    success: true,
    rewardFix: fixFromInt(0),
    injuryFix: fixFromInt(0),
    rescue: false,
    choiceIndex: 0,
    branchIndex: 0,
    logText: "火は書架を舐め、紙の記録だけが灰になった。",
    effects: [{ kind: "destroyRecords", medium: "any", scope: "flammable" }],
  };
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentScoutAda", { dispatched: true }),
      mkResident("residentScoutBen", { dispatched: true }),
      mkCodify("codifyFirePaper", "techFireStarting", "paper", 10),
      mkCodify("codifyFireTablet", "techFireStarting", "stoneTablet", 20),
      mkCodify("codifyPotteryPaper", "techPottery", "paper", 30),
      mkResearch("researchPottery", "techPottery", 0, 30),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [],
    [
      mkDispatchSnapshot({
        id: "dispatchEmber",
        destinationId: "eventNearEmber",
        memberIds: ["residentScoutAda", "residentScoutBen"],
        returnTick: 100,
        nodes: [node],
        eventId: "eventNearEmber",
      }),
    ],
  );
}

// ===========================================================================
// 8. M25: conformance 拡張 #4(探索 / event / outpost ぶん)
// ===========================================================================
//   探索(M21)・衛星拠点(M24 + 今回の段80結線)の系統には golden vector が
//   1本も無かった(coverage.json に `exp-`/`out-` 経路がゼロ)。sc33 と同じ
//   考え方(`buildDispatchSnapshot`/`buildState` はコマンド層を経由しないため、
//   派遣は `mkDispatchSnapshot` で確定値を直接置く)を踏襲する。

// --- sc34-exp-two-slot-order(派遣枠2の同時解決順 + 距離帯ラベル) -----------------

/**
 * [M25] 同一 tick(50)に帰還する 2 本の派遣(`dispatchAaa`/`dispatchZzz`)。
 * どちらも成功・報酬ありで、帰還ログ(`renderedLogs.entries`)へ追記される。
 * tie-break(scheduler.ts §3: tick → パイプライン段 → entityId)の entityId は
 * **派遣 ID**(`buildEventQueue` が `entityId: snapshot.id` で積むため)なので、
 * "dispatchAaa" < "dispatchZzz"(UTF-16 昇順)で Aaa が必ず先に解決される
 * = renderedLogs は [Aaa の文, Zzz の文] の順で固定される。
 * band は near(Aaa)/deep(Zzz)を使い、GDD 8.1 の距離帯ラベル(BAND_LABEL)が
 * 帰還ログの文言へ実際に反映されることも同時に固定する(far は sc36 で踏む)。
 * RNG を一切引かない(節点は確定値・rescue なし)ので worldSeed 非依存
 * = C7 対象外(sc33 と同じ理由)。
 */
function sc34BuildState(worldSeed: string): GameState {
  const nodeNear: DispatchNode = {
    difficultyFix: fixFromInt(100),
    rollFix: fixFromInt(50),
    success: true,
    rewardFix: fixFromInt(500),
    injuryFix: fixFromInt(0),
    rescue: false,
    logText: "近郊で薪をいくらか集めた。",
  };
  const nodeDeep: DispatchNode = {
    difficultyFix: fixFromInt(100),
    rollFix: fixFromInt(50),
    success: true,
    rewardFix: fixFromInt(300),
    injuryFix: fixFromInt(0),
    rescue: false,
    logText: "深部の遺構で書物を見つけた。",
  };
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentEve", { dispatched: true }),
      mkResident("residentFin", { dispatched: true }),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [],
    [
      mkDispatchSnapshot({
        id: "dispatchAaa",
        destinationId: "destNear",
        band: "near",
        memberIds: ["residentEve"],
        returnTick: 50,
        nodes: [nodeNear],
        rewardHuman: 500,
      }),
      mkDispatchSnapshot({
        id: "dispatchZzz",
        destinationId: "destDeep",
        band: "deep",
        memberIds: ["residentFin"],
        returnTick: 50,
        nodes: [nodeDeep],
        rewardHuman: 300,
      }),
    ],
  );
}

// --- sc35-exp-rescue(GDD 7.7 探索での保護 + memoir explorationRescue) -----------

/**
 * [M25] 1 本の派遣(far域)が保護(rescue)を伴って帰還する。
 * `joinRescuedResident`(rules/exploration.ts §5)が呼ぶ `createResidentLife`
 * は worldSeedU32 を読む(lifespan 分位表の hash draw)ので、この経路は
 * **seed 依存(C7 対象)** —— sc24 と同じ理由で alpha/beta の 2 本を用意する
 * (vectorPlans.ts 側)。`content.town`(townParams)は base content に既にある
 * ので contentPatch は不要(寝床上限は探索での保護に無関係・rules/exploration.ts
 * §5 の doc)。
 */
function sc35BuildState(worldSeed: string): GameState {
  const node: DispatchNode = {
    difficultyFix: fixFromInt(100),
    rollFix: fixFromInt(60),
    success: true,
    rewardFix: fixFromInt(0),
    injuryFix: fixFromInt(0),
    rescue: true,
    logText: "遠隔地で行き倒れの一人を助け起こした。",
  };
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentGus", { dispatched: true }),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [],
    [
      mkDispatchSnapshot({
        id: "dispatchRescue",
        destinationId: "destFar",
        band: "far",
        memberIds: ["residentGus"],
        returnTick: 40,
        nodes: [node],
      }),
    ],
  );
}

// --- sc36-exp-all-lost(GDD 8.5 全滅・段70死亡ゲートへの委譲) --------------------

/**
 * [M25] 2 名チームの派遣が far域で全滅する(`casualtyMemberIds` に両名)。
 * `resolveExpedition` は脱落者を自分で殺さず**段70(死亡/全滅判定)へ渡す**
 * (rules/exploration.ts §4)ので、実際に人口下限ゲート(rules/population.ts)
 * を通って死亡することを固定する。`life` は `lifeDyingAt` で寿命死が run の
 * 地平線内に来ないよう遠い未来へ固定してある(寿命死と探索脱落の死を混同しない
 * ため・sc27 の作り方と同じ設計判断)。townParams はあるが寝床(bunkhouse)を
 * 足していないので人口下限は 0(floor 不活性・rules/population.ts §1)= 両名とも
 * 即座に死亡が成立する。RNG を引かない(casualtyMemberIds は確定値)ので
 * worldSeed 非依存 = C7 対象外。
 */
function sc36BuildState(worldSeed: string): GameState {
  const node: DispatchNode = {
    difficultyFix: fixFromInt(200),
    rollFix: fixFromInt(10),
    success: false,
    rewardFix: fixFromInt(0),
    injuryFix: fixFromInt(999),
    rescue: false,
    logText: "深部より遠い地で壊滅的な被害を受けた。",
  };
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentGigi", { dispatched: true, life: lifeDyingAt(999_999, 999_999) }),
      mkResident("residentHugo", { dispatched: true, life: lifeDyingAt(999_999, 999_999) }),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [],
    [
      mkDispatchSnapshot({
        id: "dispatchWipe",
        destinationId: "destFarWipe",
        band: "far",
        memberIds: ["residentGigi", "residentHugo"],
        returnTick: 50,
        nodes: [node],
        casualtyMemberIds: ["residentGigi", "residentHugo"],
      }),
    ],
  );
}

// --- sc37-exp-reward-overflow(GDD 12.1 item overflow・探索報酬の上限クランプ) --

/**
 * [M25] `balance.exploration.rewardOverflow`(policy=discard・capacity=1000)を
 * 足し、初期在庫200 + 報酬2000 が上限1000で頭打ちになることを固定する
 * (`applyExpeditionReward` の overflow 分岐・rules/exploration.ts)。
 * RNG を引かない(節点は確定値)ので worldSeed 非依存 = C7 対象外。
 */
function sc37BuildState(worldSeed: string): GameState {
  const node: DispatchNode = {
    difficultyFix: fixFromInt(100),
    rollFix: fixFromInt(80),
    success: true,
    rewardFix: fixFromInt(2000),
    injuryFix: fixFromInt(0),
    rescue: false,
    logText: "近郊で薪を大量に持ち帰った。",
  };
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentIvy", { dispatched: true }),
      mkResource("resourceFirewood", "firewood", 200),
    ],
    [],
    [],
    [],
    [
      mkDispatchSnapshot({
        id: "dispatchHaul",
        destinationId: "destNearHaul",
        band: "near",
        memberIds: ["residentIvy"],
        returnTick: 30,
        nodes: [node],
        rewardHuman: 2000,
      }),
    ],
  );
}

// --- sc38-out-supply(GDD 9.2 衛星供給・scheduler段80結線・二重計上なし) --------

/**
 * [M25] 本拠 hearth(WOOD=firewood 産出)+ 衛星拠点1基(outpostForest・
 * resourceId=firewood・near・常駐2名)が同一 resource entity へ供給する盤面。
 * `assertNoDoubleStationedResidents`(rules/outpost.ts §5)が「本拠就労」と
 * 「拠点常駐」を別集合として検査するので、本拠と拠点の二重計上が無いことも
 * 構造的に固定される。供給レートは常駐人数/拠点Lvのみに依存し RNG を一切
 * 引かない(rules/outpost.ts §1)ので worldSeed 非依存 = C7 対象外
 * (footprint 系・sc28〜32 と同じ理由)。
 *
 * **C1(不発)は本シナリオ内には作らない**: `OutpostState.residentIds` は
 * GDD 9.2「住民1〜4名常駐」により state 層(`update.ts` の
 * `requireValidOutpost`)が 0 名の拠点そのものを reject する(実地検証済み)。
 * つまり「拠点はあるが供給ゼロ」という state は構造的に作れず、不発側は
 * 「拠点が 1 つも無い」でしか表現できない —— それは既存 61 本の golden vector
 * すべてが既に示している(spec §9.2(2) の「該当しない軸は note に理由」に該当。
 * `out-supply-zero-rate-idle` は登録しない)。
 */
function sc38BuildState(worldSeed: string): GameState {
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentHome", { assignedFacilityId: "facilityHearthHome" }),
      mkResident("residentOutpostA"),
      mkResident("residentOutpostB"),
      mkFacility("facilityHearthHome", "hearth", 0, ["residentHome"], 1),
      mkResource("resourceFirewood", "firewood", 0),
    ],
    [],
    [],
    [],
    [],
    undefined,
    [
      mkOutpost("outpostForestActive", "outpostForest", "near", [
        "residentOutpostA",
        "residentOutpostB",
      ]),
    ],
  );
}

// --- sc39-codify-queue(M50: 成文化の scheduler 段50 結線・GDD 11.7 段50) ------

/**
 * [M50] 学者 1 人(workbench = 産出先が研究点の施設)が成文化キューを 2 本
 * 順に片付ける盤面。
 *
 * 数値の設計(1 本の run で 3 つの壊れ方を同時に押さえる):
 *   - 学者の寄与 = 1.0/tick(中立ステータス・trait なし = `activeLaborFix` が
 *     厳密に 1 人 = 1.0 になる・rules/production.ts §2)。よって
 *     `requiredWork` の値がそのまま完了 tick になる。
 *   - `codifyAlpha`(requiredWork 30)は **tick 30 = 粗粒度ステップ境界の上**で
 *     完了する → 同一 tick に (C) 抽選(段24)と成文化完了(段50)が並び、
 *     tie-break の全順序が効く。
 *   - `codifyBravo`(requiredWork 45)は tick 30 + 45 = **tick 75 = グリッド外**
 *     で完了する → 区間が余分に 1 本切れる(`b-research-off-grid` の成文化版)。
 *   - toTick 100 まで回すので、キューが空になった後の区間(完了予測が積まれない)
 *     も同じ run で踏む。
 *
 * research entity を**置かない**のは、研究完了 (B) と成文化完了 (B) を同じ
 * ベクタへ重ねると「どちらの結線が壊れたのか」が digest から切り分けられなく
 * なるためである(spec §9.2(4): 診断可能性はシナリオを小さく保って担保する)。
 * その副作用として (C) の判定ペアが 0 件になる = 抽選は走るが試行 0 になる。
 */
function sc39BuildState(worldSeed: string): GameState {
  return createGameState(baseMeta(worldSeed), [
    mkResident("residentSage", { assignedFacilityId: "facilityDeskA" }),
    mkFacility("facilityDeskA", "workbench", 20, ["residentSage"], 1),
    mkCodifyJob("codifyAlpha", "techFireStarting", "stoneTablet", 30),
    mkCodifyJob("codifyBravo", "techPottery", "paper", 45),
  ]);
}

// --- sc40-research-select(M50: 研究対象の選択・GDD 5) -------------------------

/**
 * [M50] **ID 昇順で先頭ではない**研究が選ばれている盤面。
 *
 * `researchAlpha`(techBasketWeaving)が ID 昇順の先頭で、`researchBravo`
 * (techFireStarting)が選択されている。よって
 *   - 選択が効いていれば: Bravo(コスト 8000 / レート 80 = 100 tick)が **tick 100**
 *     で完了し、その瞬間に選択が失効(完了済み)して先頭の Alpha
 *     (コスト 24000)へ点が向き直る。toTick 250 では Alpha は未完了。
 *   - 選択を無視して従来の縮約(ID 昇順先頭)のままなら: Alpha だけが進み、
 *     toTick 250 まで 1 本も完了しない(`researchCompletedCount` 0 / 1 の差)。
 * という**符号の違う 2 つの結果**になるので、選択が実際に効いていることと
 * 「失効したら従来経路へ落ちる」ことが 1 本の run で同時に固定される。
 *
 * `selectedResearchId` は `createGameState` の第 11 引数で直接置く
 * (コマンドを通さないのは他のシナリオと同じ理由)。この state を
 * `toSerializable` → JSON → `fromSerializable` で往復しても digest が変わらない
 * ことは、`research-select-serialize-roundtrip` を申告したベクタについて
 * `tools/goldenVectorBuilder.ts` が実際に確認する(= 検収条件「研究選択が
 * セーブ往復で保持される」の golden 側の担保)。
 */
function sc40BuildState(worldSeed: string): GameState {
  return createGameState(
    baseMeta(worldSeed),
    [
      mkResident("residentAnn", { assignedFacilityId: "facilityDeskA" }),
      mkFacility("facilityDeskA", "workbench", 20, ["residentAnn"], 1),
      mkResearch("researchAlpha", "techBasketWeaving", 0),
      mkResearch("researchBravo", "techFireStarting", 0),
    ],
    [],
    [],
    [],
    [],
    undefined,
    [],
    undefined,
    undefined,
    eid("researchBravo"),
  );
}

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
  { id: "sc19-tech-field-stop", contentPatch: null, buildState: sc19BuildState },
  { id: "sc20-tech-loss", contentPatch: null, buildState: sc20BuildState },
  {
    id: "sc21-tech-mastery-cap",
    contentPatch: patchMasteryGainRate(0.72),
    buildState: sc21BuildState,
  },
  {
    id: "sc22-pop-floor-deferred",
    contentPatch: patchAddBunkhouse(POPULATION_FLOOR_BED_CAPACITY),
    buildState: sc22PopulationFloorDeferredBuildState,
  },
  {
    id: "sc23-pop-floor-active",
    contentPatch: patchAddBunkhouse(POPULATION_FLOOR_BED_CAPACITY),
    buildState: sc23PopulationFloorActiveBuildState,
  },
  {
    id: "sc24-pop-floor-resolved",
    contentPatch: composePatches(
      patchAddBunkhouse(POPULATION_FLOOR_BED_CAPACITY),
      patchArrivalIntervalTicks(200),
    ),
    buildState: sc24PopulationFloorResolvedBuildState,
  },
  { id: "sc25-life-opt-in", contentPatch: null, buildState: sc25BuildState },
  { id: "sc26-bond-milestone", contentPatch: null, buildState: sc26BuildState },
  { id: "sc27-partner-loss", contentPatch: null, buildState: sc27BuildState },
  { id: "sc28-foot-basis-2x1", contentPatch: null, buildState: sc28BuildState },
  { id: "sc29-foot-basis-2x2", contentPatch: null, buildState: sc29BuildState },
  { id: "sc30-foot-neighbor-dedup", contentPatch: null, buildState: sc30BuildState },
  {
    id: "sc31-foot-overcrowd-clamp",
    contentPatch: patchOvercrowdFixtures({
      heatHeatValueFP: 0.1,
      noiseNoiseValueFP: 0.1,
      penaltyPerExcessFP: -0.15,
    }),
    buildState: sc31BuildState,
  },
  { id: "sc32-foot-board-edge", contentPatch: null, buildState: sc32BuildState },
  { id: "sc33-ev-destroy-records", contentPatch: null, buildState: sc33BuildState },
  { id: "sc34-exp-two-slot-order", contentPatch: null, buildState: sc34BuildState },
  { id: "sc35-exp-rescue", contentPatch: null, buildState: sc35BuildState },
  { id: "sc36-exp-all-lost", contentPatch: null, buildState: sc36BuildState },
  {
    id: "sc37-exp-reward-overflow",
    contentPatch: patchExplorationRewardOverflow({ capacity: 1000, policy: "discard" }),
    buildState: sc37BuildState,
  },
  { id: "sc38-out-supply", contentPatch: patchAddOutpostType(), buildState: sc38BuildState },
  { id: "sc39-codify-queue", contentPatch: null, buildState: sc39BuildState },
  {
    id: "sc40-research-select",
    contentPatch: composePatches(
      patchTechResearchCost("techFireStarting", 8000),
      patchTechResearchCost("techBasketWeaving", 24_000),
    ),
    buildState: sc40BuildState,
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
