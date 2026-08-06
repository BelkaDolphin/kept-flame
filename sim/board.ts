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
//   `loadLiveRawContentBundle`(content/*.json を raw JSON として読むだけの
//   汎用関数・シナリオ固有ロジックを含まない)を再利用し、正規経路
//   (validateContentBundle → loadEngineContentOrThrow)だけをここで組み立てる
//   (Scenario 型は使わず薄く自前で書く)。
//   **[2026-08-02・台帳v15 必-1]** golden 側は `conformance/content-snapshot/` の
//   凍結 content(`loadBaseRawContentBundle`)へ切り離されたが、sim は運営が実際に
//   配る `content/*.json` を測る側なので `loadLiveRawContentBundle` を使う。
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

import { loadLiveRawContentBundle } from "../conformance/scenarios";
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

/**
 * [M72] `balance.morale` ブロックを**外す** content patch(計測 #5 専用)。
 *
 * 計測 #5(想起困難頻度・GDD 11.4-8a)は「施設/士気/派遣の代表10パターン」を
 * 固定点として recallRisk 式を測る計測であり、パターンの定義そのものが
 * 「士気 10 / 25 / 60 …」という**その士気に留まっている住民**である。M72 の
 * 士気モデルを効かせると、通常業務パターンの士気が週のあいだに上がり続けて
 * 「士気低パターン」が士気低でなくなる = 計測器が測っている対象が変質する。
 * よって #5 の盤面だけは士気を凍結する(実 run 側の 11.4-8b は content の
 * ままなので、士気モデルの影響はそちらで観測される)。
 *
 * 副次的な効能として、(C) 単独評価と scheduler 経由の突合
 * (`sim/recallFrequency.ts` の `crossCheckAgainstScheduler`)が
 * 「(A) 区間の積分が (C) の入力を動かさない」という前提のまま成立し続ける。
 */
export function patchWithoutMorale(): ContentPatch {
  return (raw) => {
    const balance = { ...(raw.balance as Record<string, unknown>) };
    delete balance["morale"];
    return { ...raw, balance };
  };
}

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
 * **[2026-08-02・台帳v15 必-1] 入力は必ず実 content(`loadLiveRawContentBundle`)。**
 * golden vector 側は `conformance/content-snapshot/` の凍結 content を使うように
 * 切り離されたが、sim は運営が実際に配る content を検証する側なので凍結側を
 * 読んではならない。
 *
 * @throws {SimBoardError} 検証/ロードに失敗した場合
 */
export function resolveSimContent(patch: ContentPatch | null = null): EngineContent {
  const raw = loadLiveRawContentBundle();
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
 * [M6] sim 代表盤面が使う tech(ADR-014 の tech3)。
 *
 * 以前は「content の tech がちょうど 3 本」を前提に `techDefs` の先頭 3 件を
 * 使っていたが、M6 で E1〜E3 のテック 24 本を投入したのでその前提は成立しない。
 * **本数に依存せず、当時と同じ 3 本を同じ順序で明示指定**する
 * (= researchSimA/B/C の割り当てが M6 前後で 1 bit も変わらない)。
 * recallRisk は tech の中身を読まない(判定数 = 住民 × research entity 数)ので、
 * 3 本という**個数**だけが計測 #3/#4/#5 の前提であり、どの 3 本かは効かない。
 */
export const SIM_BOARD_TECH_IDS = ["techBasketWeaving", "techFireStarting", "techPottery"] as const;

/**
 * 代表盤面を組み立てる(住民20・tech3・施設2種(過酷/通常)・代表10パターン)。
 *
 * facility は過酷(forge 相当)/通常(hearth 相当)の各 1 インスタンスに集約する
 * (recallRiskPerDay は assignedFacilityId 先の harshWork だけを見るため、
 * インスタンス数を増やしても判定は変わらない。隣接ボーナス/過密は
 * recallRisk に影響しないので配置(cellIndex)も任意でよい)。
 *
 * @throws {SimBoardError} content に forge/hearth 定義または
 *   {@link SIM_BOARD_TECH_IDS} が無い場合(sim board の前提が content と食い違っている)
 */
export function buildPatternBoard(worldSeed: string, content: EngineContent): GameState {
  const techIds = SIM_BOARD_TECH_IDS.map((techId) => eid(techId));
  for (const techId of techIds) {
    if (!content.techDefs.has(techId)) {
      throw new SimBoardError(
        `sim board が前提にする tech "${techId}" が content に無い` +
          `(content/tech.json を確認するか sim/board.ts の SIM_BOARD_TECH_IDS を見直すこと)`,
      );
    }
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

  // [2026-08-02・台帳v15 必-3] 廃材の受け皿。`balance.storage.baseCapacity` が
  // 入った content(M39 の保管上限 400)では、上限に当たった資源が毎 tick
  // 廃材スポンジ(GDD 6.7)を回すため、waste の resource entity が state に
  // 無いと `rules/production.ts` の creditWaste が「生んだ廃材を黙って捨てない」
  // ガードで RulesError を投げる(実ゲーム経路は R2-A01 の
  // `worldGen.ensureWasteResourceEntity` で既に手当て済み。ここはその
  // sim fixture 側の横展開)。content が廃材を持たない(`wasteResourceId` が
  // null / storage ブロックごと不在)なら 1 entity も足さない = 従来と 1 bit も
  // 変わらない。
  const wasteResourceId = content.storage?.wasteResourceId;
  if (wasteResourceId !== undefined && wasteResourceId !== null) {
    resources.push({
      kind: "resource",
      id: eid("resourceWasteSim"),
      resourceId: wasteResourceId,
      stock: fixFromInt(0),
    });
  }

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
