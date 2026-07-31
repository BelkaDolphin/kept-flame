// ---------------------------------------------------------------------------
// ⑩大移動ナップサックUI/⑪継承点購入(M33)のテスト用フィクスチャ。
//
// vitest の include は `tests/**/*.{test,spec}.ts` なので、このファイル自体は
// テストとして収集されない共有ヘルパである(tests/ui/fixtures.ts / m32Fixtures.ts
// と同じ扱い)。
//
// `src/newGame.ts` は住民に `life` を付けない暫定実装なので、resident
// フィクスチャは常に生存扱い(`isAliveResident` は `life === undefined` を
// 生存とみなす・state.ts 参照)。数値は GDD 10.2〜10.3 の式を満たす範囲で
// 読みやすい値に決め打ちしてある(`tests/engine/exodus.test.ts` と同じ立場・
// EXODUS/RECORD_MEDIA の値も同ファイルから踏襲)。
// ---------------------------------------------------------------------------

import { fixFromInt, fixFromRaw } from "../../src/engine/fp";
import { createGameStore, type GameStore } from "../../src/ui/store";
import type {
  EngineContent,
  EraDef,
  ExodusParams,
  RecordMediaParams,
  TechDef,
} from "../../src/engine/rules/types";
import {
  entityIdFromString,
  type CodifyState,
  type EntityId,
  type EntityState,
  type GameState,
} from "../../src/engine/state/state";
import { boardContent, boardState } from "./fixtures";

const eid = entityIdFromString;

/** GDD 5「(A) 起点」テック。 */
export const M33_TECH_A1 = eid("techAlphaOne");
/** GDD 7.4「(B) 一回性喪失」テック。唯一保持者を作るのに使う。 */
export const M33_TECH_B1 = eid("techRareOne");

const TECH_DEFS = new Map<EntityId, TechDef>([
  [M33_TECH_A1, { id: M33_TECH_A1, researchCostFix: fixFromInt(30), eraId: "e1" }],
  [
    M33_TECH_B1,
    {
      id: M33_TECH_B1,
      researchCostFix: fixFromInt(60),
      eraId: "e1",
      lossClass: "rareIrreversible",
    },
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
      gateTechId: M33_TECH_A1,
      criticalPathMax: 3,
    },
  ],
]);

/** GDD 10.2 追補の媒体別重み(石板 1.0 / 紙 0.25)。content/balance.json と同値。 */
export const M33_RECORD_MEDIA: RecordMediaParams = {
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
      costResourceId: eid("clay"),
    },
    paper: {
      costMulFix: fixFromRaw(600_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: eid("paper"),
    },
  },
};

/** GDD 10.2〜10.3 の exodus ブロック。content/balance.json と同値。 */
export const M33_EXODUS: ExodusParams = {
  caravanRatioFix: fixFromRaw(350_000), // 0.35
  crewRatioFix: fixFromRaw(500_000), // 0.5
  expectedTabletsByEra: new Map([["e1", 8]]),
  eraPointsFix: fixFromInt(10),
  codifyRatePointsFix: fixFromRaw(500_000), // 0.5
  survivorPointsFix: fixFromInt(2),
  tierCosts: [50, 75, 113, 169],
  trackBonusPerTier: { caravanCapacity: 2, crewCapacity: 1, startingStock: 25 },
  startingStockResourceId: eid("wood"),
};

/** exodus/recordMedia/eraDefs/techDefs を足した content(`{...boardContent(), …}` の定型)。 */
export function exodusContent(overrides: Partial<EngineContent> = {}): EngineContent {
  return {
    ...boardContent(),
    techDefs: TECH_DEFS,
    eraDefs: ERA_DEFS,
    recordMedia: M33_RECORD_MEDIA,
    exodus: M33_EXODUS,
    ...overrides,
  };
}

/** `exodus`/`recordMedia` ブロックを持たない content(= 大移動不活性)。 */
export function exodusInactiveContent(): EngineContent {
  return { ...boardContent(), techDefs: TECH_DEFS, eraDefs: ERA_DEFS };
}

/** 完了済み research entity(GDD 10.3 の「到達エラ」入力)。 */
export function m33Research(name: string, techId: EntityId, completedTick: number): EntityState {
  return {
    kind: "research",
    id: eid(name),
    techId,
    progress: fixFromInt(0),
    completedTick,
  };
}

/** 完了済み codify entity(石版プールの 1 件)。 */
export function m33Record(
  name: string,
  techId: EntityId,
  medium: "paper" | "stoneTablet",
): CodifyState {
  return {
    kind: "codify",
    id: eid(name),
    techId,
    medium,
    requiredWork: fixFromInt(100),
    progress: fixFromInt(100),
    completedTick: 10,
  };
}

/**
 * ⑩⑪の店舗用テストストア。`tests/ui/fixtures.ts` の盤面(住民 aRui・かまど
 * 3基)に、大移動用の research/codify entity を additive で足す。
 */
export function createExodusTestStore(extra: readonly EntityState[] = []): {
  readonly store: GameStore;
  readonly state: GameState;
  readonly content: EngineContent;
} {
  const state = boardState(extra);
  const content = exodusContent();
  return { store: createGameStore({ state, content }), state, content };
}
