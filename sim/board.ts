// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- sim 用の代表盤面(縮約) — 先行計測計画 §2.1 P2 / ADR-014
//
// ===========================================================================
// 1. golden vector シナリオ(conformance/scenarios.ts)との違い
// ===========================================================================
//   あちらは「経路被覆」が目的の最小盤面群(シナリオ15本・被覆58経路)。
//   こちらは ADR-014 の「20人×3tech×2,304step = 138,240 ベルヌーイ判定/run」を
//   そのまま体現する**単一の代表盤面**であり、計測 #3/#4/#5 が共有する
//   (先行計測計画 §2.1 P2「sim/runner.ts sim/calibrate.ts」の行)。
//
//   content の読み込みは conformance/scenarios.ts が既に持つ
//   `loadBaseRawContentBundle`(content/*.json を raw JSON として読むだけの
//   汎用関数・シナリオ固有ロジックを含まない)を再利用し、正規経路
//   (validateContentBundle → loadEngineContentOrThrow)だけをここで組み立てる
//   (conformance 側ファイルの変更は禁止のため、Scenario 型は使わず薄く自前で書く)。
//
// ===========================================================================
// 2. 代表10パターン(GDD 11.2 の recallRisk 変数を軸にする)
// ===========================================================================
//   計画書 §5.2 #5 が指定する「施設/士気/派遣の代表10パターン」を、
//   recallRisk の各項(loadW/moraleW/dispatchW/masteryResist)の代表値の
//   組合せとして定義する。全軸の総当り(2×3×2×2=24通り)ではなく、GDD 11.2 の
//   閾値(士気30/15)を跨ぐ代表点 + 定着度による軽減の効き + 最悪ケースの
//   10点に絞ってある(「代表」であり全数ではないことを明示)。
// ---------------------------------------------------------------------------

import { loadBaseRawContentBundle } from "../conformance/scenarios";
import { validateContentBundle, type RawContentBundle } from "../schema/contentBundle";
import { loadEngineContentOrThrow } from "../schema/engineContent";

import { fixFromInt, fixFromRaw, type Fix } from "../src/engine/fp";
import {
  requireFacilityDef,
  type EngineContent,
  type FacilityDef,
} from "../src/engine/rules/types";
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

export class SimBoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimBoardError";
  }
}

// --- 1. content(base + patch) ----------------------------------------------

/** content patch: raw JSON バンドルへの差分(sc13-onemin と同種のやり方)。 */
export type ContentPatch = (raw: RawContentBundle) => RawContentBundle;

/** `balance.coarseTickMinutes` を差し替える(計測 #4 の 1分tick Fallback・ADR-014(3))。 */
export function patchCoarseTickMinutes(coarseTickMinutes: number): ContentPatch {
  return (raw) => ({
    ...raw,
    balance: { ...(raw.balance as Record<string, unknown>), coarseTickMinutes },
  });
}

/**
 * sim 用 content を正規経路(validateContentBundle → loadEngineContentOrThrow)で
 * 解決する。`patch` が null なら content/*.json のままの EngineContent を返す。
 *
 * @throws {SimBoardError} 検証/ロードに失敗した場合
 */
export function resolveSimContent(patch: ContentPatch | null = null): EngineContent {
  const raw = loadBaseRawContentBundle();
  const patched = patch === null ? raw : patch(raw);
  const validated = validateContentBundle(patched);
  if (!validated.ok) {
    const detail = validated.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
    throw new SimBoardError(`sim content patch が validateContentBundle を通らない:\n${detail}`);
  }
  return loadEngineContentOrThrow(validated.value);
}

// --- 2. 代表10パターン -------------------------------------------------------

export interface SimPattern {
  readonly id: string;
  readonly title: string;
  /** true = 過酷業務(forge 相当) / false = 通常業務(hearth 相当)。GDD 11.2 loadW。 */
  readonly harsh: boolean;
  /** 士気(人間単位 0〜100)。GDD 11.2 moraleW の閾値(30/15)の内外を代表させる。 */
  readonly moraleHuman: number;
  /** 定着度 masteryResist(Fix・人間単位 0〜0.20)。GDD 11.2。 */
  readonly masteryFix: Fix;
  /** 探索派遣中か。GDD 11.2 dispatchW。 */
  readonly dispatched: boolean;
}

const NO_MASTERY = fixFromInt(0);
const MAX_MASTERY = fixFromRaw(200_000); // 0.20(GDD 11.2 masteryResist 上限)

export const PATTERNS: readonly SimPattern[] = [
  {
    id: "normal-morale-high",
    title: "通常業務/士気高(50)/非派遣",
    harsh: false,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-morale-mid",
    title: "通常業務/士気中閾値未満(29)/非派遣",
    harsh: false,
    moraleHuman: 29,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-morale-low",
    title: "通常業務/士気低閾値未満(14)/非派遣",
    harsh: false,
    moraleHuman: 14,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-high",
    title: "過酷業務/士気高(50)/非派遣",
    harsh: true,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-mid",
    title: "過酷業務/士気中閾値未満(29)/非派遣",
    harsh: true,
    moraleHuman: 29,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "harsh-morale-low",
    title: "過酷業務/士気低閾値未満(14)/非派遣",
    harsh: true,
    moraleHuman: 14,
    masteryFix: NO_MASTERY,
    dispatched: false,
  },
  {
    id: "normal-dispatched",
    title: "通常業務/士気高(50)/派遣中",
    harsh: false,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: true,
  },
  {
    id: "harsh-dispatched",
    title: "過酷業務/士気高(50)/派遣中",
    harsh: true,
    moraleHuman: 50,
    masteryFix: NO_MASTERY,
    dispatched: true,
  },
  {
    id: "harsh-high-mastery",
    title: "過酷業務/士気高(50)/定着度上限(0.20)/非派遣",
    harsh: true,
    moraleHuman: 50,
    masteryFix: MAX_MASTERY,
    dispatched: false,
  },
  {
    id: "worst-case",
    title: "過酷業務/士気低閾値未満(14)/派遣中(最悪ケース)",
    harsh: true,
    moraleHuman: 14,
    masteryFix: NO_MASTERY,
    dispatched: true,
  },
];

/** パターンあたりの住民数。 */
export const RESIDENTS_PER_PATTERN = 2;
/** 住民総数(= PATTERNS.length × RESIDENTS_PER_PATTERN = 20・ADR-014 の「20人」)。 */
export const RESIDENT_COUNT = PATTERNS.length * RESIDENTS_PER_PATTERN;

const eid = entityIdFromString;
const HARSH_FACILITY_DEF_ID = eid("forge");
const NORMAL_FACILITY_DEF_ID = eid("hearth");
const HEARTH_FACILITY_ID = eid("facilityHearthSim");
const FORGE_FACILITY_ID = eid("facilityForgeSim");

const RESIDENT_ID_PATTERN = /^residentPat(\d+)[ab]$/;

/** pattern index(0起点) + slot(0=a/1=b) → resident id。 */
export function residentIdForPattern(patternIndex: number, slot: 0 | 1): EntityId {
  const pattern = PATTERNS[patternIndex];
  if (pattern === undefined) {
    throw new SimBoardError(`residentIdForPattern: pattern index ${String(patternIndex)} が範囲外`);
  }
  return eid(`residentPat${String(patternIndex)}${slot === 0 ? "a" : "b"}`);
}

/**
 * resident id → 所属パターンの id(逆引き。計測 #5 のパターン別集計に使う)。
 *
 * @throws {SimBoardError} sim board が生成した resident id でない場合
 */
export function patternIdOfResidentId(residentId: EntityId): string {
  const match = RESIDENT_ID_PATTERN.exec(residentId);
  if (match === null) {
    throw new SimBoardError(
      `patternIdOfResidentId: "${residentId}" は sim board が生成した resident id でない`,
    );
  }
  const indexText = match[1];
  if (indexText === undefined) {
    throw new SimBoardError("patternIdOfResidentId: 内部不整合(正規表現キャプチャが無い)");
  }
  const index = Number(indexText);
  const pattern = PATTERNS[index];
  if (pattern === undefined) {
    throw new SimBoardError(`patternIdOfResidentId: pattern index ${String(index)} が範囲外`);
  }
  return pattern.id;
}

function requireResourceOutputId(def: FacilityDef): EntityId {
  if (def.output.kind !== "resource") {
    throw new SimBoardError(
      `sim board は facility "${def.id}" の output が resource である前提(実際: ${def.output.kind})`,
    );
  }
  return def.output.resourceId;
}

function baseMeta(worldSeed: string): GameStateMeta {
  return { saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1, worldSeed, tick: 0 };
}

/**
 * 代表盤面を組み立てる(住民20・tech3・施設2種(過酷/通常)・代表10パターン)。
 *
 * facility は過酷(forge 相当)/通常(hearth 相当)の各 1 インスタンスに集約する
 * (recallRiskPerDay は assignedFacilityId 先の harshWork だけを見るため、
 * インスタンス数を増やしても判定は変わらない。隣接ボーナス/過密は
 * recallRisk に影響しないので配置(cellIndex)も任意でよい)。
 *
 * @throws {SimBoardError} content に forge/hearth 定義または tech がちょうど
 *   3 本無い場合(sim board の前提が content と食い違っている)
 */
export function buildPatternBoard(worldSeed: string, content: EngineContent): GameState {
  const techIds = [...content.techDefs.keys()];
  if (techIds.length !== 3) {
    throw new SimBoardError(
      `sim board は content.tech がちょうど3本(tech3・ADR-014)である前提` +
        `(実際 ${String(techIds.length)} 本)。content/tech.json を確認するか sim/board.ts の代表盤面を見直すこと`,
    );
  }
  const hearthDef = requireFacilityDef(content, NORMAL_FACILITY_DEF_ID);
  const forgeDef = requireFacilityDef(content, HARSH_FACILITY_DEF_ID);
  if (forgeDef.harshWork === hearthDef.harshWork) {
    throw new SimBoardError(
      "sim board は forge=過酷業務 / hearth=通常業務(harshWork が異なる)である前提が崩れている",
    );
  }
  const firewoodResourceId = requireResourceOutputId(hearthDef);
  const ironResourceId = requireResourceOutputId(forgeDef);

  const residents: ResidentState[] = [];
  const hearthWorkerIds: EntityId[] = [];
  const forgeWorkerIds: EntityId[] = [];

  for (let patternIndex = 0; patternIndex < PATTERNS.length; patternIndex++) {
    const pattern = PATTERNS[patternIndex];
    if (pattern === undefined) continue; // 到達しない(ループ境界が PATTERNS.length と一致)
    const facilityId = pattern.harsh ? FORGE_FACILITY_ID : HEARTH_FACILITY_ID;
    const workerIds = pattern.harsh ? forgeWorkerIds : hearthWorkerIds;
    for (const slot of [0, 1] as const) {
      const residentId = residentIdForPattern(patternIndex, slot);
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
      workerIds.push(residentId);
    }
  }

  const hearthFacility: FacilityState = {
    kind: "facility",
    id: HEARTH_FACILITY_ID,
    defId: NORMAL_FACILITY_DEF_ID,
    level: 1,
    cellIndex: 0,
    workerIds: hearthWorkerIds,
  };
  const forgeFacility: FacilityState = {
    kind: "facility",
    id: FORGE_FACILITY_ID,
    defId: HARSH_FACILITY_DEF_ID,
    level: 1,
    cellIndex: 1,
    workerIds: forgeWorkerIds,
  };

  const resources: ResourceState[] = [
    {
      kind: "resource",
      id: eid("resourceFirewoodSim"),
      resourceId: firewoodResourceId,
      stock: fixFromInt(0),
    },
    {
      kind: "resource",
      id: eid("resourceIronSim"),
      resourceId: ironResourceId,
      stock: fixFromInt(0),
    },
  ];

  const researchIds = ["researchSimA", "researchSimB", "researchSimC"] as const;
  const research: ResearchState[] = [];
  for (let i = 0; i < techIds.length; i++) {
    const techId = techIds[i];
    const researchId = researchIds[i];
    if (techId === undefined || researchId === undefined) {
      throw new SimBoardError("buildPatternBoard: 内部不整合(techIds/researchIds の長さ不一致)");
    }
    research.push({
      kind: "research",
      id: eid(researchId),
      techId,
      progress: fixFromInt(0),
      completedTick: null,
    });
  }

  const entities: EntityState[] = [
    ...residents,
    hearthFacility,
    forgeFacility,
    ...resources,
    ...research,
  ];
  return createGameState(baseMeta(worldSeed), entities);
}
