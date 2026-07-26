// ---------------------------------------------------------------------------
// #1(オフライン復帰2秒予算)の代表盤面 — T10 / `docs/design/perf-boundaries.md` §6
//
// ===========================================================================
// 1. なぜ sim/board.ts(T9)を再利用しないのか
// ===========================================================================
//   理由は 2 つあり、どちらか一方だけでも再利用は成立しない(設計文書 §6)。
//
//   (a) 技術的: `sim/board.ts` は `conformance/scenarios.ts` の
//       `loadBaseRawContentBundle` を import しており、そのモジュールは評価時に
//       `fileURLToPath(new URL("../content/", import.meta.url))` を即時実行する。
//       T8 がこれをブラウザへ持ち込んで実測した結果、3 エンジンすべてで
//       "fileURLToPath is not a function" によりページ全体がクラッシュした
//       (`tools/genHarnessData.ts` 冒頭の実測記録)。bench から import すると
//       同じ経路を踏む。
//
//   (b) 設計的(こちらが本質): T9 の盤面は施設インスタンスを意図的に 2 個へ
//       潰してある(recallRisk は assignedFacilityId 先の harshWork しか見ない
//       ため、#5 の頻度計測にはそれが正しい)。しかし #1 は隣接/過密の実コスト
//       (ADR-002(2) の O(8) 近傍集計)と 48 セル格子 → 240 DOM の対応を含む
//       必要があり、施設 2 個ではどちらも測れない。
//
//   住民側の軸(過酷/通常 × 士気 50/29/14 × 定着度 0/0.20 × 派遣有無 の
//   代表10パターン × 2 人 = 20 人)は T9 と**同じ軸を踏襲**し、施設だけ 12 基へ
//   展開する。両者は「同じ軸・違う規模」の関係にある。
//
// ===========================================================================
// 2. content はブラウザ内で正規経路を通す
// ===========================================================================
//   `content/*.json` を静的 import し、validateContentBundle →
//   loadEngineContentOrThrow という**本番と同じ入口**をブラウザ内で通す
//   (T8 の harnessData.json のような事前計算マニフェストを挟まない)。
//   Vite は JSON をビルド時に JS リテラルへ畳むので、ブラウザ側では
//   `JSON.parse` が発生しない = 実アプリ(ADR-025 の静的アセット同梱)と同じ。
//   この事実は設計文書 §4 の `contentJsonParseMs` に明記してある。
// ---------------------------------------------------------------------------

import adjacencyJson from "../content/adjacency.json";
import balanceJson from "../content/balance.json";
import facilityJson from "../content/facility.json";
import techJson from "../content/tech.json";
import traitJson from "../content/trait.json";

import { validateContentBundle, type RawContentBundle } from "../schema/contentBundle";
import { loadEngineContentOrThrow } from "../schema/engineContent";

import { GRID_CELL_COUNT } from "../src/engine/adjacency";
import { fixFromInt, fixFromRaw, type Fix } from "../src/engine/fp";
import { requireFacilityDef, type EngineContent } from "../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityId,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "../src/engine/state/state";
import { createGameState } from "../src/engine/state/update";

export class PerfBoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfBoardError";
  }
}

// --- 1. content ------------------------------------------------------------

const RAW_BUNDLE: RawContentBundle = {
  tech: techJson as readonly unknown[],
  facility: facilityJson as readonly unknown[],
  trait: traitJson as readonly unknown[],
  adjacency: adjacencyJson as unknown,
  balance: balanceJson as unknown,
};

/**
 * content を正規経路(validateContentBundle → loadEngineContentOrThrow)で解決する。
 *
 * @throws {PerfBoardError} 検証に失敗した場合(content 側の欠陥)
 */
export function loadPerfContent(): EngineContent {
  const validated = validateContentBundle(RAW_BUNDLE);
  if (!validated.ok) {
    const detail = validated.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    throw new PerfBoardError(`content/*.json が validateContentBundle を通らない:\n${detail}`);
  }
  return loadEngineContentOrThrow(validated.value);
}

// --- 2. 代表10パターン(T9 と同じ軸) ---------------------------------------

export interface PerfPattern {
  readonly id: string;
  /** true = 過酷業務(forge)/ false = 通常業務(hearth)。GDD 11.2 loadW。 */
  readonly harsh: boolean;
  /** 士気(人間単位 0〜100)。GDD 11.2 の閾値 30/15 の内外を代表させる。 */
  readonly moraleHuman: number;
  /** 定着度 masteryResist(Fix・0〜0.20)。 */
  readonly masteryFix: Fix;
  readonly dispatched: boolean;
}

const NO_MASTERY = fixFromInt(0);
const MAX_MASTERY = fixFromRaw(200_000); // 0.20

export const PERF_PATTERNS: readonly PerfPattern[] = [
  {
    id: "normal-morale-high",
    harsh: false,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-morale-mid",
    harsh: false,
    moraleHuman: 29,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-morale-low",
    harsh: false,
    moraleHuman: 14,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-high",
    harsh: true,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-mid",
    harsh: true,
    moraleHuman: 29,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-low",
    harsh: true,
    moraleHuman: 14,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-dispatched",
    harsh: false,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: true,
  },
  {
    id: "harsh-dispatched",
    harsh: true,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: true,
  },
  {
    id: "harsh-high-mastery",
    harsh: true,
    moraleHuman: 50,
    masteryFix: MAX_MASTERY,
    dispatched: false,
  },
  { id: "worst-case", harsh: true, moraleHuman: 14, masteryFix: NO_MASTERY, dispatched: true },
];

/** パターンあたりの住民数。 */
export const RESIDENTS_PER_PATTERN = 2;
/** 住民総数 = 20(ADR-014 の「20人」)。 */
export const PERF_RESIDENT_COUNT = PERF_PATTERNS.length * RESIDENTS_PER_PATTERN;

// --- 3. 施設 12 基の配置 ----------------------------------------------------

const eid = entityIdFromString;

const HEARTH_DEF_ID = eid("hearth");
const FORGE_DEF_ID = eid("forge");
const WORKBENCH_DEF_ID = eid("workbench");

/**
 * 施設 12 基の配置(設計文書 §6)。
 *
 * heat タグ(hearth / forge)を cell 0〜3 と 6〜9 に密集させることで、
 * `adjacency.json` の overcrowd.threshold=3 を超える近傍が実際に生じ、
 * 過密ペナルティと ±60% クランプの経路が catch-up 中に走る。
 * lore(workbench)は 12〜15 に置く(現 content には lore|lore 規則が無いので
 * ボーナスは付かないが、セル占有と施設数のコストは掛かる)。
 */
export const PERF_FACILITY_PLACEMENT: readonly {
  readonly id: string;
  readonly defId: EntityId;
  readonly cellIndex: number;
  readonly level: number;
}[] = [
  { id: "facilityHearth0", defId: HEARTH_DEF_ID, cellIndex: 0, level: 3 },
  { id: "facilityHearth1", defId: HEARTH_DEF_ID, cellIndex: 1, level: 2 },
  { id: "facilityHearth2", defId: HEARTH_DEF_ID, cellIndex: 2, level: 5 },
  { id: "facilityHearth3", defId: HEARTH_DEF_ID, cellIndex: 3, level: 1 },
  { id: "facilityForge0", defId: FORGE_DEF_ID, cellIndex: 6, level: 4 },
  { id: "facilityForge1", defId: FORGE_DEF_ID, cellIndex: 7, level: 2 },
  { id: "facilityForge2", defId: FORGE_DEF_ID, cellIndex: 8, level: 3 },
  { id: "facilityForge3", defId: FORGE_DEF_ID, cellIndex: 9, level: 1 },
  { id: "facilityWorkbench0", defId: WORKBENCH_DEF_ID, cellIndex: 12, level: 2 },
  { id: "facilityWorkbench1", defId: WORKBENCH_DEF_ID, cellIndex: 13, level: 3 },
  { id: "facilityWorkbench2", defId: WORKBENCH_DEF_ID, cellIndex: 14, level: 1 },
  { id: "facilityWorkbench3", defId: WORKBENCH_DEF_ID, cellIndex: 15, level: 4 },
];

export const PERF_FACILITY_COUNT = PERF_FACILITY_PLACEMENT.length;

/** 既定の世界シード(決定論的な計測条件の一部)。 */
export const PERF_WORLD_SEED = "perf-bench-2026-07-26";

/** catch-up の目標 tick = 72h(ADR-026 の 72h クランプ値)。 */
export const PERF_TARGET_TICK = 4320;

function baseMeta(worldSeed: string): GameStateMeta {
  return { saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1, worldSeed, tick: 0 };
}

/** pattern index + slot → resident id。 */
export function perfResidentId(patternIndex: number, slot: 0 | 1): EntityId {
  return eid(`residentPat${String(patternIndex)}${slot === 0 ? "a" : "b"}`);
}

/**
 * #1 の代表盤面を組み立てる(住民20 / 施設12 / tech3 / 資源2 = entity 37)。
 *
 * @throws {PerfBoardError} content の前提(hearth/forge/workbench が在り tech が
 *   ちょうど 3 本)が崩れている場合
 */
export function buildPerfBoard(content: EngineContent, worldSeed = PERF_WORLD_SEED): GameState {
  const techIds = [...content.techDefs.keys()];
  if (techIds.length !== 3) {
    throw new PerfBoardError(
      `#1 の代表盤面は content.tech がちょうど 3 本(tech3・ADR-014)である前提` +
        `(実際 ${String(techIds.length)} 本)`,
    );
  }
  const hearthDef = requireFacilityDef(content, HEARTH_DEF_ID);
  const forgeDef = requireFacilityDef(content, FORGE_DEF_ID);
  requireFacilityDef(content, WORKBENCH_DEF_ID);
  if (!forgeDef.harshWork || hearthDef.harshWork) {
    throw new PerfBoardError(
      "#1 の代表盤面は forge=過酷業務 / hearth=通常業務 である前提が崩れている",
    );
  }
  if (hearthDef.output.kind !== "resource" || forgeDef.output.kind !== "resource") {
    throw new PerfBoardError("#1 の代表盤面は hearth/forge の output が resource である前提");
  }

  const harshFacilityIds: EntityId[] = [];
  const normalFacilityIds: EntityId[] = [];
  for (const placement of PERF_FACILITY_PLACEMENT) {
    if (placement.cellIndex < 0 || placement.cellIndex >= GRID_CELL_COUNT) {
      throw new PerfBoardError(
        `施設配置 ${placement.id} の cellIndex ${String(placement.cellIndex)} が格子外`,
      );
    }
    const def = requireFacilityDef(content, placement.defId);
    (def.harshWork ? harshFacilityIds : normalFacilityIds).push(eid(placement.id));
  }

  const residents: ResidentState[] = [];
  const workerIdsByFacilityId = new Map<EntityId, EntityId[]>();
  for (let patternIndex = 0; patternIndex < PERF_PATTERNS.length; patternIndex++) {
    const pattern = PERF_PATTERNS[patternIndex];
    if (pattern === undefined) continue;
    const pool = pattern.harsh ? harshFacilityIds : normalFacilityIds;
    for (const slot of [0, 1] as const) {
      const residentId = perfResidentId(patternIndex, slot);
      // 同種施設へ均等に散らす(1 施設に固まらせない = 就労者数が実態に近い)。
      const facilityId = pool[(patternIndex * RESIDENTS_PER_PATTERN + slot) % pool.length];
      if (facilityId === undefined) {
        throw new PerfBoardError("施設プールが空(配置表と content の harshWork が不整合)");
      }
      residents.push({
        kind: "resident",
        id: residentId,
        morale: fixFromInt(pattern.moraleHuman),
        mastery: pattern.masteryFix,
        assignedFacilityId: facilityId,
        dispatched: pattern.dispatched,
        traitIds: [],
        recallImpairedUntilTick: 0,
      });
      const list = workerIdsByFacilityId.get(facilityId);
      if (list === undefined) workerIdsByFacilityId.set(facilityId, [residentId]);
      else list.push(residentId);
    }
  }

  const facilities: FacilityState[] = PERF_FACILITY_PLACEMENT.map((placement) => {
    const id = eid(placement.id);
    const workers = [...(workerIdsByFacilityId.get(id) ?? [])].sort();
    return {
      kind: "facility",
      id,
      defId: placement.defId,
      level: placement.level,
      cellIndex: placement.cellIndex,
      workerIds: workers,
    };
  });

  const resources: ResourceState[] = [
    {
      kind: "resource",
      id: eid("resourcePerfFirewood"),
      resourceId: hearthDef.output.resourceId,
      stock: fixFromInt(0),
    },
    {
      kind: "resource",
      id: eid("resourcePerfIron"),
      resourceId: forgeDef.output.resourceId,
      stock: fixFromInt(0),
    },
  ];

  const researchIds = ["researchPerfA", "researchPerfB", "researchPerfC"] as const;
  const research: ResearchState[] = [];
  for (let i = 0; i < techIds.length; i++) {
    const techId = techIds[i];
    const researchId = researchIds[i];
    if (techId === undefined || researchId === undefined) {
      throw new PerfBoardError("buildPerfBoard: 内部不整合(techIds/researchIds の長さ不一致)");
    }
    research.push({
      kind: "research",
      id: eid(researchId),
      techId,
      progress: fixFromInt(0),
      completedTick: null,
    });
  }

  const entities: EntityState[] = [...residents, ...facilities, ...resources, ...research];
  return createGameState(baseMeta(worldSeed), entities);
}

// --- 4. save サイズ感度用の合成盤面(設計文書 §3 B2) ------------------------

/** ADR-012(2) の容量目標(典型セーブ ≤512KB)。B2 の感度計測の目標サイズ。 */
export const TARGET_SAVE_BYTES = 512 * 1024;

/**
 * 代表盤面へ「無配属の住民」を継ぎ足して save を指定バイト数まで膨らませる。
 *
 * 予算判定には使わない参考計測(設計文書 §3 B2「save サイズ依存性」)。
 * 増やすのは resident だけ(施設・研究を増やすと catch-up の計算量まで変わり、
 * B2 単独の感度計測にならなくなるため)。無配属なので production にも
 * recallRisk にも寄与しない。
 *
 * @throws {PerfBoardError} 目標バイト数が非現実的で住民上限に達した場合
 */
export function buildPaddedPerfBoard(
  content: EngineContent,
  targetBytes: number,
  measureBytes: (state: GameState) => number,
  worldSeed = PERF_WORLD_SEED,
): GameState {
  const base = buildPerfBoard(content, worldSeed);
  const baseBytes = measureBytes(base);
  if (baseBytes >= targetBytes) return base;

  const probe: EntityState = {
    kind: "resident",
    id: eid("residentPad000000"),
    morale: fixFromInt(50),
    mastery: NO_MASTERY,
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
  };
  const perResidentBytes =
    measureBytes(createGameState(baseMeta(worldSeed), [...base.entityStateById.values(), probe])) -
    baseBytes;
  if (perResidentBytes <= 0) {
    throw new PerfBoardError("buildPaddedPerfBoard: 1 住民あたりのバイト増分を測れなかった");
  }
  const padCount = Math.ceil((targetBytes - baseBytes) / perResidentBytes);
  const MAX_PAD = 200_000;
  if (padCount > MAX_PAD) {
    throw new PerfBoardError(
      `buildPaddedPerfBoard: 目標 ${String(targetBytes)} バイトには住民 ${String(padCount)} 人が必要で上限 ${String(MAX_PAD)} を超える`,
    );
  }

  const padded: EntityState[] = [...base.entityStateById.values()];
  for (let i = 0; i < padCount; i++) {
    padded.push({
      kind: "resident",
      id: eid(`residentPad${String(i).padStart(6, "0")}`),
      morale: fixFromInt(50),
      mastery: NO_MASTERY,
      assignedFacilityId: null,
      dispatched: false,
      traitIds: [],
      recallImpairedUntilTick: 0,
    });
  }
  return createGameState(baseMeta(worldSeed), padded);
}
