// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- event content 到達検証(M23) — GDD 8.2〜8.4/11.4-10/12.2
//
// ===========================================================================
// 1. 何を確認するか
// ===========================================================================
//   M23 の検収条件 2「全ノードが sim で到達可能」を機械確認する: `content/
//   event.json` の各イベントについて、**全ノード・全 branch** が少なくとも
//   1 つの (チーム構成, stance) の組み合わせで実際に踏まれることを、本物の
//   `buildDispatchSnapshot`(`src/engine/rules/exploration.ts`)へ実 content
//   を通して確認する(手計算やモックではなく engine の実装そのものを走らせる)。
//
// ===========================================================================
// 2. なぜ多数の乱数シードを試す必要が無いか(設計の核心)
// ===========================================================================
//   `branches[].cond` が参照する `teamPower` / `difficulty` は
//   **判定の乱数 roll を含まない値**である(`rules/event.ts` の
//   `buildCondContext` は `args.teamPowerFix`(= `effectiveTeamPowerFix` の
//   結果、roll 加算前)をそのまま渡す)。したがって cond による分岐選択は
//   **チーム構成と choice(stance)だけで決定論的に決まり、dispatchTick や
//   worldSeed の違いに依存しない**。本スクリプトはこの性質を利用し、
//   少数の「弱い/中位/強い/学者持ち/病弱持ち」チーム構成 × stance の組だけで
//   全 branch を機械的に踏破する(乱数を大量に振る総当たりは不要)。
//
//   `injuryCount` も「そのノード自身を含む判定失敗回数」であり、失敗そのものは
//   `teamPower + roll >= difficulty` で決まるため roll に依存するが、本
//   content は各ノードの `difficulty` をチーム階級から十分離して設計して
//   あるので(`content/event.json` 作成時の設計メモ)、成否も実質的に決定論的
//   になる(境界ぎりぎりの設計を避けている)。それでも本スクリプトは**実際の
//   engine 実行結果**を見て判定するため、万一この前提が外れていても(境界に
//   触れて未到達 branch が出れば)正直に reject して報告する。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateContentBundle, type RawContentBundle } from "../schema/contentBundle";
import { loadEngineContentOrThrow } from "../schema/engineContent";

import { fixFromInt } from "../src/engine/fp";
import { buildDispatchSnapshot } from "../src/engine/rules/exploration";
import type { DistanceBand, EngineContent, EventDef } from "../src/engine/rules/types";
import {
  entityIdFromString,
  type DispatchStance,
  type EntityId,
  type EntityState,
  type GameState,
} from "../src/engine/state/state";
import { createGameState } from "../src/engine/state/update";
import { worldSeedToUint32 } from "../src/engine/stochastic";

import { isMainModule, writeJsonReport } from "./cliUtil";

export class EventReachabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventReachabilityError";
  }
}

// --- 1. content の組み立て ---------------------------------------------------
//
// [Node 直実行の制約] `tools/tsLoaderRegister.mjs` 経由の raw Node ESM は
// JSON の裸 import に `type: "json"` 属性を要求する(vitest 側の変換とは別物)。
// `conformance/scenarios.ts` の `readContentJson` と同じ
// readFileSync + JSON.parse 方式に倣う(新規 npm 依存なし)。

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

function readContentJson(fileName: string): unknown {
  return JSON.parse(readFileSync(`${CONTENT_DIR}${fileName}`, "utf8")) as unknown;
}

const RAW: RawContentBundle = {
  tech: readContentJson("tech.json") as readonly unknown[],
  facility: readContentJson("facility.json") as readonly unknown[],
  trait: readContentJson("trait.json") as readonly unknown[],
  adjacency: readContentJson("adjacency.json"),
  balance: readContentJson("balance.json"),
  event: readContentJson("event.json") as readonly unknown[],
};

function loadContent(): EngineContent {
  const validated = validateContentBundle(RAW);
  if (!validated.ok) {
    const detail = validated.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    throw new EventReachabilityError(
      `content/event.json が validateContentBundle(strict) を通らない:\n${detail}`,
    );
  }
  return loadEngineContentOrThrow(validated.value);
}

// --- 2. チーム構成(§2 の「少数の階級」設計) ---------------------------------

/** 5 ステータス全てを同じ値へ揃えた住民(weightedStatSum が重み配分に依らず一定になる設計)。 */
function uniformResident(
  name: string,
  allStatsHuman: number,
  traitIds: readonly string[] = [],
): EntityState {
  const v = fixFromInt(allStatsHuman);
  return {
    kind: "resident",
    id: entityIdFromString(name),
    morale: fixFromInt(50),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: traitIds.map((t) => entityIdFromString(t)),
    recallImpairedUntilTick: 0,
    stats: { vigor: v, dexterity: v, intellect: v, fortitude: v, will: v },
  };
}

interface Roster {
  readonly label: string;
  readonly memberIds: readonly EntityId[];
}

/**
 * `content/event.json` 作成時の設計メモに対応する 5 階級。
 * 全員同一ステータスの住民で構成するため、1 人あたりの weightedStatSum は
 * `statWeights` の配分に依らず「その階級の値」に一致する(合計 1.0 の設計)。
 *   weak3    : 3人 × 20  → teamPower(重み合計1) = 60 / maxStatHolder = 20
 *   mid3     : 3人 × 50  → 150 / 50
 *   strong3  : 3人 × 80  → 240 / 80
 *   scholar2 : 2人 × 50(1人 traitScholar 保持) → 100 / 50
 *   frail2   : 2人 × 50(1人 traitFrail 保持)   → 100 / 50
 */
const RESIDENTS: readonly EntityState[] = [
  uniformResident("residentWeakA", 20),
  uniformResident("residentWeakB", 20),
  uniformResident("residentWeakC", 20),
  uniformResident("residentMidA", 50),
  uniformResident("residentMidB", 50),
  uniformResident("residentMidC", 50),
  uniformResident("residentStrongA", 80),
  uniformResident("residentStrongB", 80),
  uniformResident("residentStrongC", 80),
  uniformResident("residentScholarA", 50, ["traitScholar"]),
  uniformResident("residentScholarB", 50),
  uniformResident("residentFrailA", 50, ["traitFrail"]),
  uniformResident("residentFrailB", 50),
];

const ROSTERS: readonly Roster[] = [
  { label: "weak3", memberIds: ["residentWeakA", "residentWeakB", "residentWeakC"] },
  { label: "mid3", memberIds: ["residentMidA", "residentMidB", "residentMidC"] },
  { label: "strong3", memberIds: ["residentStrongA", "residentStrongB", "residentStrongC"] },
  { label: "scholar2", memberIds: ["residentScholarA", "residentScholarB"] },
  { label: "frail2", memberIds: ["residentFrailA", "residentFrailB"] },
].map((r) => ({ label: r.label, memberIds: r.memberIds.map((m) => entityIdFromString(m)) }));

/** (roster, stance) の組。press を主系列にし、strong3 だけ cautious も追加で走らせる(§0 の choice 選択経路も踏む)。 */
function runsFor(): readonly { readonly roster: Roster; readonly stance: DispatchStance }[] {
  const runs: { readonly roster: Roster; readonly stance: DispatchStance }[] = [];
  for (const roster of ROSTERS) runs.push({ roster, stance: "press" });
  const strong = ROSTERS.find((r) => r.label === "strong3");
  if (strong !== undefined) runs.push({ roster: strong, stance: "cautious" });
  return runs;
}

function boardStateWithSeed(worldSeed: string): GameState {
  return createGameState(
    {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed,
      tick: 0,
    },
    RESIDENTS,
  );
}

function boardState(): GameState {
  return boardStateWithSeed("eventReachability");
}

// --- 3. 到達集計 --------------------------------------------------------------

interface NodeCoverage {
  reachedBy: string[];
  branchHitBy: Record<number, string[]>;
}

interface EventCoverage {
  readonly id: string;
  readonly band: DistanceBand;
  readonly nodeCount: number;
  readonly nodes: NodeCoverage[];
  readonly runsExecuted: number;
}

function bandOf(def: EventDef): DistanceBand {
  const band = def.destTags[0];
  if (band === undefined) throw new EventReachabilityError(`event "${def.id}" に destTags が無い`);
  return band;
}

function coverEvent(state: GameState, content: EngineContent, def: EventDef): EventCoverage {
  const nodes: NodeCoverage[] = def.nodes.map(() => ({ reachedBy: [], branchHitBy: {} }));
  const band = bandOf(def);
  const worldSeedU32 = worldSeedToUint32(state.worldSeed);

  let runCount = 0;
  for (const { roster, stance } of runsFor()) {
    runCount++;
    const dispatchId = entityIdFromString(
      `dispatchProbe${String(runCount)}`.replace(/[^a-zA-Z0-9]/g, ""),
    );
    const snapshot = buildDispatchSnapshot(state, content, worldSeedU32, {
      dispatchId,
      destinationId: def.id,
      band,
      stance,
      memberIds: roster.memberIds,
      dispatchTick: 0,
    });
    const runLabel = `${roster.label}/${stance}`;
    for (let i = 0; i < snapshot.nodes.length; i++) {
      const node = snapshot.nodes[i];
      const coverage = nodes[i];
      if (node === undefined || coverage === undefined) continue;
      coverage.reachedBy.push(runLabel);
      if (node.branchIndex !== undefined) {
        const list = coverage.branchHitBy[node.branchIndex] ?? [];
        list.push(runLabel);
        coverage.branchHitBy[node.branchIndex] = list;
      }
    }
  }

  return { id: def.id, band, nodeCount: def.nodes.length, nodes, runsExecuted: runCount };
}

// --- 4. gap 判定・レポート -----------------------------------------------------

interface Gap {
  readonly eventId: string;
  readonly nodeIndex: number;
  readonly kind: "node-unreached" | "branch-unreached";
  readonly branchIndex?: number;
}

function findGaps(def: EventDef, coverage: EventCoverage): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 0; i < def.nodes.length; i++) {
    const nodeDef = def.nodes[i];
    const nodeCoverage = coverage.nodes[i];
    if (nodeDef === undefined || nodeCoverage === undefined) continue;
    if (nodeCoverage.reachedBy.length === 0) {
      gaps.push({ eventId: def.id, nodeIndex: i, kind: "node-unreached" });
      continue;
    }
    for (let b = 0; b < nodeDef.branches.length; b++) {
      if ((nodeCoverage.branchHitBy[b] ?? []).length === 0) {
        gaps.push({ eventId: def.id, nodeIndex: i, kind: "branch-unreached", branchIndex: b });
      }
    }
  }
  return gaps;
}

export interface ReachabilityReport {
  readonly generatedAtNote: string;
  readonly eventCount: number;
  readonly totalNodes: number;
  readonly totalBranches: number;
  readonly rostersUsed: readonly string[];
  readonly runsPerEvent: number;
  readonly allCovered: boolean;
  readonly gaps: readonly Gap[];
  readonly events: readonly EventReport[];
}

interface EventReport {
  readonly id: string;
  readonly band: DistanceBand;
  readonly nodeCount: number;
  readonly nodes: readonly {
    readonly nodeIndex: number;
    readonly branchCount: number;
    readonly reachedBy: readonly string[];
    readonly branchHitBy: Readonly<Record<number, readonly string[]>>;
  }[];
}

export function runEventReachability(): ReachabilityReport {
  const content = loadContent();
  const state = boardState();
  const eventDefs = content.eventDefs;
  if (eventDefs === undefined || eventDefs.size === 0) {
    throw new EventReachabilityError("content.eventDefs が空(content/event.json が読めていない)");
  }

  const allGaps: Gap[] = [];
  const eventReports: EventReport[] = [];
  let totalNodes = 0;
  let totalBranches = 0;

  for (const def of [...eventDefs.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const coverage = coverEvent(state, content, def);
    allGaps.push(...findGaps(def, coverage));
    totalNodes += def.nodes.length;
    for (const node of def.nodes) totalBranches += node.branches.length;
    eventReports.push({
      id: def.id,
      band: coverage.band,
      nodeCount: coverage.nodeCount,
      nodes: coverage.nodes.map((n, i) => ({
        nodeIndex: i,
        branchCount: def.nodes[i]?.branches.length ?? 0,
        reachedBy: n.reachedBy,
        branchHitBy: n.branchHitBy,
      })),
    });
  }

  return {
    generatedAtNote: "wall-clock 未取得(決定論 sim・タイムスタンプは §9 の4点打刻を参照)",
    eventCount: eventDefs.size,
    totalNodes,
    totalBranches,
    rostersUsed: ROSTERS.map((r) => r.label),
    runsPerEvent: runsFor().length,
    allCovered: allGaps.length === 0,
    gaps: allGaps,
    events: eventReports,
  };
}

// --- 4b. [M38] 到達**頻度**(GDD 11.4-10「1000回中最低N回」) ------------------
//
// §4 の `runEventReachability` は「1 回でも踏めるか」(M23 の検収条件)を見る。
// GDD 11.4-10 が要求するのは**頻度**「各ノード/分岐が 1000 回中最低 N 回(例
// N=20)到達」であり、稀にしか踏まれない過剰報酬枝のすり抜けを防ぐのが目的なので
// 別関数として実装する。
//
// 試行の振り方: (roster, stance) の組(§2 の 6 通り)を巡回しつつ、worldSeed と
// dispatchTick を試行番号から決定論的に変える。cond が読む `teamPower`/
// `difficulty` は roll を含まないが `injuryCount` は判定失敗回数に依存するため、
// seed/tick を振ると分岐選択が実際に散る(§2 の注記)。**Math.random は使わない**。

/** {@link measureEventCoverageFrequency} の結果。 */
export interface EventCoverageFrequencyReport {
  readonly samples: number;
  readonly eventCount: number;
  readonly totalNodes: number;
  readonly totalBranches: number;
  /** 全 (event, ノード) と全 (event, ノード, 分岐) を通した最小到達回数。 */
  readonly minHits: number;
  /** 最小到達だった対象のラベル(`eventId#node[i]` または `eventId#node[i]/branch[j]`)。 */
  readonly minHitsLabel: string;
  /** 到達回数が閾値を下回った対象の一覧(ラベル → 回数・昇順)。 */
  readonly hitsByLabel: Readonly<Record<string, number>>;
}

export function measureEventCoverageFrequency(samples: number): EventCoverageFrequencyReport {
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new EventReachabilityError(
      `measureEventCoverageFrequency: 試行数 ${String(samples)} が不正`,
    );
  }
  const content = loadContent();
  const eventDefs = content.eventDefs;
  if (eventDefs === undefined || eventDefs.size === 0) {
    throw new EventReachabilityError("content.eventDefs が空(content/event.json が読めていない)");
  }

  const runs = runsFor();
  const hits = new Map<string, number>();
  const defs = [...eventDefs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 全対象を 0 で初期化する(1 度も踏まれない対象を「キーが無い」で見落とさない)。
  let totalNodes = 0;
  let totalBranches = 0;
  for (const def of defs) {
    for (let i = 0; i < def.nodes.length; i++) {
      hits.set(`${def.id}#node[${String(i)}]`, 0);
      totalNodes++;
      const node = def.nodes[i];
      if (node === undefined) continue;
      for (let b = 0; b < node.branches.length; b++) {
        hits.set(`${def.id}#node[${String(i)}]/branch[${String(b)}]`, 0);
        totalBranches++;
      }
    }
  }

  for (let sample = 0; sample < samples; sample++) {
    const run = runs[sample % runs.length];
    if (run === undefined) continue;
    const state = boardStateWithSeed(`eventCoverage-${String(sample)}`);
    const worldSeedU32 = worldSeedToUint32(state.worldSeed);
    for (const def of defs) {
      const snapshot = buildDispatchSnapshot(state, content, worldSeedU32, {
        dispatchId: entityIdFromString(`dispatchCoverage${String(sample)}`),
        destinationId: def.id,
        band: bandOf(def),
        stance: run.stance,
        memberIds: run.roster.memberIds,
        dispatchTick: sample * 10,
      });
      for (let i = 0; i < snapshot.nodes.length; i++) {
        const node = snapshot.nodes[i];
        if (node === undefined) continue;
        const nodeKey = `${def.id}#node[${String(i)}]`;
        hits.set(nodeKey, (hits.get(nodeKey) ?? 0) + 1);
        if (node.branchIndex !== undefined) {
          const branchKey = `${nodeKey}/branch[${String(node.branchIndex)}]`;
          hits.set(branchKey, (hits.get(branchKey) ?? 0) + 1);
        }
      }
    }
  }

  let minHits = Number.POSITIVE_INFINITY;
  let minHitsLabel = "(対象なし)";
  const hitsByLabel: Record<string, number> = {};
  for (const key of [...hits.keys()].sort()) {
    const value = hits.get(key) ?? 0;
    hitsByLabel[key] = value;
    if (value < minHits) {
      minHits = value;
      minHitsLabel = key;
    }
  }

  return {
    samples,
    eventCount: eventDefs.size,
    totalNodes,
    totalBranches,
    minHits: Number.isFinite(minHits) ? minHits : 0,
    minHitsLabel,
    hitsByLabel,
  };
}

// --- 5. CLI ---------------------------------------------------------------

async function main(): Promise<void> {
  const report = runEventReachability();
  console.log(
    `[eventReachability] events=${String(report.eventCount)} nodes=${String(report.totalNodes)} branches=${String(report.totalBranches)} gaps=${String(report.gaps.length)}`,
  );
  if (!report.allCovered) {
    for (const gap of report.gaps) {
      console.error(
        `  UNCOVERED: ${gap.eventId} node[${String(gap.nodeIndex)}] ${gap.kind}` +
          (gap.branchIndex !== undefined ? ` branch[${String(gap.branchIndex)}]` : ""),
      );
    }
  }
  await writeJsonReport("docs/measurements/event-reachability-2026-07-31.json", report);
  if (!report.allCovered) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
