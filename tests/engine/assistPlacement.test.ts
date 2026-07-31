// ---------------------------------------------------------------------------
// M26 推奨配置アシスト(貪欲 + 80/100 約束)のテスト。
//
// 検収条件(ロードマップ M26 行):
//   ① 代表盤面で**総当たり最適**と比較し 80% 前後に収まること
//   ② 検分: 貪欲の局所最適が理論最大に近づきすぎていないこと(GDD 14-3)
//
// ①②を同じ関数で同時に示すために、`suggestPlacements` を
//   qualityRatio = 1.0 → 素の貪欲(各手で増分最大)
//   qualityRatio = 既定(ASSIST_STEP_TARGET_RATIO) → アシスト
// の 2 通りで走らせ、両方を総当たり最適と比べる(§80% 検証)。
// 素の貪欲が理論最大へ張り付くこと自体が GDD 14-3 の残余リスクの実測であり、
// 「貪欲だから 80% になる」わけではない = 準最適化パラメータが要る、という
// 設計判断の根拠をテストとして固定する。
//
// 総当たり側は本テスト内実装(小盤面 = 使用可セルを絞る)。計算量は
// 使用可セル数 P 施設数 で、最大でも 12P4 = 11,880 通りに抑えてある。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  GRID_CELL_COUNT,
  createAdjacencyMatrix,
  type AdjacencyPairEntry,
  type Tag,
} from "../../src/engine/adjacency";
import {
  ASSIST_EFFICIENCY_CAP,
  ASSIST_STEP_TARGET_RATIO,
  AssistError,
  boardOutputScore,
  placementPlanToCommands,
  rubbleBlockedCells,
  suggestPlacements,
  suggestPlacementsAvoidingRubble,
  type PlacementPlan,
  type PlacementRequest,
} from "../../src/engine/assist/placement";
import { apply } from "../../src/engine/commands";
import { setTerrain } from "../../src/engine/state/update";

import { footprintFitsGrid, occupiedCells } from "../../src/engine/footprint";
import { FIX_ONE, fixFromRaw, toApproxNumber, toRaw, type Fix } from "../../src/engine/fp";
import type { EngineContent, FacilityDef } from "../../src/engine/rules/types";
import type {
  EntityId,
  EntityState,
  FacilityFootprint,
  FacilityState,
  GameState,
} from "../../src/engine/state/state";
import { content, facility, id, lvCurve, stateOf, WOOD } from "./fixtures";

// --- 1. テスト用 content ---------------------------------------------------

function def(name: string, tags: readonly Tag[], footprint?: FacilityFootprint): FacilityDef {
  const base = {
    id: id(name),
    tags,
    harshWork: false,
    outputPerTickByLevel: lvCurve(1),
    output: { kind: "resource", resourceId: WOOD } as const,
  };
  return footprint === undefined ? base : { ...base, footprint };
}

/** 熱源(かまど相当)。 */
const HEAT = def("assistHeat", ["heat"]);
/** 湿潤(貯水槽相当)。熱源と相性が悪い(GDD 6.2「湿潤 × 熱源 効率 -10%」)。 */
const DAMP = def("assistDamp", ["damp"]);
/** 学芸(写字室相当)。 */
const LORE = def("assistLore", ["lore"]);
/** 熱源の 2×2 大型施設(製錬炉相当)。 */
const BIG_HEAT = def("assistBigHeat", ["heat"], { width: 2, height: 2 });

function pair(tagA: Tag, tagB: Tag, human: number): AdjacencyPairEntry {
  return {
    tagA,
    tagB,
    effect: {
      effect: "yieldMul",
      target: { kind: "any" },
      valueFix: fixFromRaw(Math.round(human * 1_000_000)),
    },
  };
}

/** GDD 6.2 の代表行(熱源×熱源 +20% / 湿潤×熱源 -10% / 学芸×学芸 +30%)。 */
const PAIRS: readonly AdjacencyPairEntry[] = [
  pair("heat", "heat", 0.2),
  pair("damp", "heat", -0.1),
  pair("lore", "lore", 0.3),
  pair("damp", "damp", 0.15),
];

function testContent(pairs: readonly AdjacencyPairEntry[] = PAIRS): EngineContent {
  return content({
    facilityDefs: new Map([
      [HEAT.id, HEAT],
      [DAMP.id, DAMP],
      [LORE.id, LORE],
      [BIG_HEAT.id, BIG_HEAT],
    ]),
    adjacency: createAdjacencyMatrix({
      pairs,
      overcrowd: {
        threshold: 3,
        penaltyPerExcessFix: fixFromRaw(-100_000),
        clampFix: fixFromRaw(600_000),
      },
      seedOffset: null,
    }),
  });
}

// --- 2. 小盤面の定義 -------------------------------------------------------

/** 6×8 格子のうち使ってよいセルだけを列挙した「小盤面」。 */
interface SmallBoard {
  readonly name: string;
  /** 使用可セル(昇順)。これ以外は blockedCells として塞ぐ。 */
  readonly allowedCells: readonly number[];
  /** 最初から建っている施設。 */
  readonly existing: readonly FacilityState[];
  /** 置きたい施設(この順で貪欲に処理される)。 */
  readonly requests: readonly PlacementRequest[];
}

/** 左上を原点とした w×h の矩形領域のセル番号(昇順)。 */
function rect(x0: number, y0: number, w: number, h: number): readonly number[] {
  const cells: number[] = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) cells.push((y0 + dy) * 6 + (x0 + dx));
  }
  return cells;
}

function req(name: string, defId: EntityId): PlacementRequest {
  return { facilityId: id(name), defId };
}

function blockedOutside(allowed: readonly number[]): readonly number[] {
  const isAllowed: boolean[] = [];
  for (const cell of allowed) isAllowed[cell] = true;
  const blocked: number[] = [];
  for (let cell = 0; cell < GRID_CELL_COUNT; cell++) {
    if (isAllowed[cell] !== true) blocked.push(cell);
  }
  return blocked;
}

/**
 * 代表盤面 5 種。「単一タグ」「相性の悪いタグ混在」「既存施設あり」「大型施設」
 * 「過密が避けられない密集盤」を 1 本ずつ持つ。
 */
const BOARDS: readonly SmallBoard[] = [
  {
    // (a) 3×3・熱源 4 基。素の貪欲が 2×2 クラスタを作って理論最大に一致する盤面。
    name: "a-単一タグ 3x3 に熱源4基",
    allowedCells: rect(0, 0, 3, 3),
    existing: [],
    requests: [req("aF1", HEAT.id), req("aF2", HEAT.id), req("aF3", HEAT.id), req("aF4", HEAT.id)],
  },
  {
    // (b) 4×3・熱源 2 + 学芸 2。同タグ同士を寄せ、系統を分けるのが最適。
    // 要求順が交互なので、後戻りしない貪欲には並べ替えの利得が残る。
    name: "b-複数系統 4x3 に熱源2+学芸2",
    allowedCells: rect(0, 0, 4, 3),
    existing: [],
    requests: [req("bF1", HEAT.id), req("bF2", LORE.id), req("bF3", HEAT.id), req("bF4", LORE.id)],
  },
  {
    // (c) 4×3・既存の学芸 1 基あり。学芸を寄せると +30% が 2 方向へ効く。
    name: "c-既存施設あり 4x3 に学芸3基",
    allowedCells: rect(0, 0, 4, 3),
    existing: [facility("cE1", LORE.id, 0)],
    requests: [req("cF1", LORE.id), req("cF2", LORE.id), req("cF3", LORE.id)],
  },
  {
    // (d) 4×3・2×2 の大型熱源 1 基 + 1×1 熱源 2 基(footprint 経路)。
    name: "d-大型施設 4x3 に 2x2 熱源1+1x1 熱源2",
    allowedCells: rect(0, 0, 4, 3),
    existing: [],
    requests: [req("dF1", BIG_HEAT.id), req("dF2", HEAT.id), req("dF3", HEAT.id)],
  },
  {
    // (e) 3×2 = 6 セルに 4 基。空きが少なく過密が避けられない密集盤。
    name: "e-密集盤 3x2 に熱源3+湿潤1",
    allowedCells: rect(0, 0, 3, 2),
    existing: [],
    requests: [req("eF1", HEAT.id), req("eF2", HEAT.id), req("eF3", HEAT.id), req("eF4", DAMP.id)],
  },
];

// --- 3. 総当たり最適(テスト内実装) ---------------------------------------

interface BruteForceResult {
  readonly scoreFix: Fix;
  readonly cellIndices: readonly number[];
}

/**
 * 使用可セルの中で要求施設の全配置を総当たりし、盤面効率が最大のものを返す。
 * 評価は engine と**同じ** {@link boardOutputScore} を使う(尺度を二重に持たない)。
 */
function bruteForceOptimal(board: SmallBoard, engineContent: EngineContent): BruteForceResult {
  const isAllowed: boolean[] = [];
  for (const cell of board.allowedCells) isAllowed[cell] = true;

  const occupied: boolean[] = [];
  for (const existing of board.existing) {
    for (const cell of occupiedCells(
      existing.cellIndex,
      existing.footprint ?? { width: 1, height: 1 },
    )) {
      occupied[cell] = true;
    }
  }

  let best: BruteForceResult | null = null;
  const chosen: number[] = [];
  const placed: FacilityState[] = [];

  const walk = (index: number): void => {
    if (index === board.requests.length) {
      const state = stateOf([...board.existing, ...placed] as readonly EntityState[]);
      const scoreFix = boardOutputScore(state, engineContent);
      if (best === null || toRaw(scoreFix) > toRaw(best.scoreFix)) {
        best = { scoreFix, cellIndices: [...chosen] };
      }
      return;
    }
    const request = board.requests[index];
    if (request === undefined) return;
    const facilityDef = engineContent.facilityDefs.get(request.defId);
    if (facilityDef === undefined) throw new Error(`未知の facility 定義 ${request.defId}`);
    const footprint = facilityDef.footprint ?? { width: 1, height: 1 };

    for (let anchor = 0; anchor < GRID_CELL_COUNT; anchor++) {
      if (!footprintFitsGrid(anchor, footprint)) continue;
      const cells = occupiedCells(anchor, footprint);
      let usable = true;
      for (const cell of cells) {
        if (isAllowed[cell] !== true || occupied[cell] === true) {
          usable = false;
          break;
        }
      }
      if (!usable) continue;
      for (const cell of cells) occupied[cell] = true;
      chosen.push(anchor);
      placed.push(
        facility(
          request.facilityId,
          request.defId,
          anchor,
          [],
          1,
          footprint.width === 1 && footprint.height === 1 ? undefined : footprint,
        ),
      );
      walk(index + 1);
      placed.pop();
      chosen.pop();
      for (const cell of cells) occupied[cell] = false;
    }
  };
  walk(0);

  if (best === null) throw new Error(`盤面 "${board.name}" に総当たりの解が 1 つも無い`);
  return best;
}

// --- 4. 共通ヘルパ ---------------------------------------------------------

function stateOfBoard(board: SmallBoard): GameState {
  return stateOf(board.existing as readonly EntityState[]);
}

function planFor(board: SmallBoard, engineContent: EngineContent, ratioFix?: Fix): PlacementPlan {
  const blockedCells = blockedOutside(board.allowedCells);
  return suggestPlacements(
    stateOfBoard(board),
    engineContent,
    board.requests,
    ratioFix === undefined ? { blockedCells } : { blockedCells, qualityRatioFix: ratioFix },
  );
}

/** 提案を実際に `placeFacility` で適用した state(提案が本当に置けることの確認込み)。 */
function applyPlan(state: GameState, engineContent: EngineContent, plan: PlacementPlan): GameState {
  let next = state;
  for (const command of placementPlanToCommands(plan)) {
    const result = apply(next, engineContent, command);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    next = result.state;
  }
  return next;
}

function ratioOf(numerator: Fix, denominator: Fix): number {
  return toApproxNumber(numerator) / toApproxNumber(denominator);
}

// --- 5. 80% 検証(検収条件①②) --------------------------------------------

describe("M26 推奨配置: 総当たり最適との比(80/100 約束)", () => {
  const engineContent = testContent();

  interface Measured {
    readonly board: string;
    readonly optimal: number;
    readonly greedy: number;
    readonly assist: number;
    readonly greedyRatio: number;
    readonly assistRatio: number;
  }

  const measured: Measured[] = [];
  for (const board of BOARDS) {
    const optimal = bruteForceOptimal(board, engineContent);
    const greedy = planFor(board, engineContent, FIX_ONE);
    const assist = planFor(board, engineContent);
    measured.push({
      board: board.name,
      optimal: toApproxNumber(optimal.scoreFix),
      greedy: toApproxNumber(greedy.boardScoreAfterFix),
      assist: toApproxNumber(assist.boardScoreAfterFix),
      greedyRatio: ratioOf(greedy.boardScoreAfterFix, optimal.scoreFix),
      assistRatio: ratioOf(assist.boardScoreAfterFix, optimal.scoreFix),
    });
  }

  // -------------------------------------------------------------------------
  // 2026-07-31 実測(ASSIST_STEP_TARGET_RATIO = 0.65)
  //
  //   盤面                          最適  貪欲  アシスト  貪欲/最適  アシスト/最適
  //   a 単一タグ 3x3 熱源4          5.6   5.3   4.4       0.946      0.786
  //   b 複数系統 4x3 熱源2+学芸2    5.0   5.0   4.0       1.000      0.800
  //   c 既存あり 4x3 学芸3          6.2   6.0   5.2       0.968      0.839
  //   d 大型 4x3 2x2熱源1+熱源2     4.2   4.2   3.0       1.000      0.714
  //   e 密集 3x2 熱源3+湿潤1        5.0   5.0   4.2       1.000      0.840
  //                                             平均      0.983      0.796
  //
  // 校正の掃引(1手あたり目標比 → 盤面比の平均):
  //   0.60〜0.63 → 0.782 / 0.64〜0.66 → 0.796 / 0.67〜0.72 → 0.829 /
  //   0.85 → 0.872 / 1.00(素の貪欲) → 0.983
  // 0.67 以上では盤面 a が 0.857 となり GDD 2.1 の 0.85 上限を超えるため 0.65 を採用。
  // 掃引を再現するには planFor の第3引数へ fixFromRaw(pct * 10_000) を渡して回す。
  // -------------------------------------------------------------------------

  it("実測が想定どおり並ぶ(盤面ごとの比が有限で、最適が正)", () => {
    expect(measured).toHaveLength(BOARDS.length);
    for (const row of measured) {
      expect(Number.isFinite(row.assistRatio)).toBe(true);
      expect(row.optimal).toBeGreaterThan(0);
    }
  });

  it.each(measured)(
    "$board: アシストは理論最大の 85% 以下(GDD 2.1 の設計不変条件)",
    ({ assistRatio }) => {
      expect(assistRatio).toBeLessThanOrEqual(toApproxNumber(ASSIST_EFFICIENCY_CAP));
    },
  );

  it.each(measured)(
    "$board: アシストは理論最大の 70% 以上(使い物になる下限)",
    ({ assistRatio }) => {
      expect(assistRatio).toBeGreaterThanOrEqual(0.7);
    },
  );

  it("代表盤面平均が 80% 前後(0.75〜0.85)に収まる", () => {
    let sum = 0;
    for (const row of measured) sum += row.assistRatio;
    const mean = sum / measured.length;
    expect(mean).toBeGreaterThanOrEqual(0.75);
    expect(mean).toBeLessThanOrEqual(0.85);
  });

  it("検分: 素の貪欲(ratio=1.0)は理論最大へ近づきすぎる = 貪欲だけでは 80% にならない(GDD 14-3)", () => {
    // 空きに余裕のある盤面(a〜d)でも素の貪欲は理論最大にほぼ一致する。
    // これが GDD 14-3「貪欲の局所最適が理論最大に近づきすぎる」の実測であり、
    // 準最適化パラメータ(qualityRatio)が必要である根拠。
    const spacious = measured.filter((row) => !row.board.startsWith("e-"));
    for (const row of spacious) {
      expect(row.greedyRatio).toBeGreaterThanOrEqual(0.94);
    }
    // かつ、素の貪欲は必ずアシスト以上(パラメータが効いている)。
    for (const row of measured) {
      expect(row.greedyRatio).toBeGreaterThanOrEqual(row.assistRatio);
    }
    // 少なくとも 1 盤面で貪欲が理論最大に完全一致する(近づきすぎの直接証拠)。
    expect(spacious.some((row) => row.greedyRatio === 1)).toBe(true);
    // 全盤面平均でも貪欲は 95% 超 = 「貪欲だから 8 割」は成り立たない。
    let greedySum = 0;
    for (const row of measured) greedySum += row.greedyRatio;
    expect(greedySum / measured.length).toBeGreaterThan(0.95);
  });

  it("密集盤では準最適化の余地が狭く、アシストも理論最大寄りになる(手の余地が無いだけ)", () => {
    const crowded = measured.find((row) => row.board.startsWith("e-"));
    expect(crowded).toBeDefined();
    if (crowded === undefined) return;
    expect(crowded.assistRatio).toBeGreaterThanOrEqual(0.8);
  });
});

// --- 6. アルゴリズムの性質 -------------------------------------------------

describe("M26 推奨配置: 決定論と純粋性", () => {
  const engineContent = testContent();
  const board = BOARDS[1];
  if (board === undefined) throw new Error("盤面 b が無い");

  it("同一入力 → 同一出力(2 回呼んで完全一致)", () => {
    const first = planFor(board, engineContent);
    const second = planFor(board, engineContent);
    expect(second).toStrictEqual(first);
  });

  it("state を 1 bit も変えない(参照も内容も同一)", () => {
    const state = stateOfBoard(board);
    const snapshot = JSON.stringify([...state.entityStateById.entries()]);
    suggestPlacements(state, engineContent, board.requests, {
      blockedCells: blockedOutside(board.allowedCells),
    });
    expect(JSON.stringify([...state.entityStateById.entries()])).toBe(snapshot);
  });

  it("要求の並び順を変えても、同じ並びなら常に同じ提案になる(順序は入力の一部)", () => {
    const reversed: SmallBoard = {
      name: board.name,
      allowedCells: board.allowedCells,
      existing: board.existing,
      requests: [...board.requests].reverse(),
    };
    const a = planFor(reversed, engineContent);
    const b = planFor(reversed, engineContent);
    expect(a.suggestions.map((s) => s.cellIndex)).toStrictEqual(
      b.suggestions.map((s) => s.cellIndex),
    );
  });

  it("提案は全て placeFacility として受理される(そのまま適用できる)", () => {
    const state = stateOfBoard(board);
    const plan = planFor(board, engineContent);
    const applied = applyPlan(state, engineContent, plan);
    expect(plan.suggestions).toHaveLength(board.requests.length);
    expect(plan.unplacedFacilityIds).toStrictEqual([]);
    // 適用後の盤面効率が plan の予告値と一致する(提案 = 実際の数値)。
    expect(toRaw(boardOutputScore(applied, engineContent))).toBe(toRaw(plan.boardScoreAfterFix));
  });
});

describe("M26 推奨配置: 増分評価と全再計算の一致(congruence)", () => {
  const engineContent = testContent();

  it.each(BOARDS.map((board) => ({ name: board.name, board })))(
    "$name: 各手の Δ = 全再計算した盤面効率の差",
    ({ board }) => {
      const plan = planFor(board, engineContent);
      let state = stateOfBoard(board);
      let previous = boardOutputScore(state, engineContent);
      expect(toRaw(previous)).toBe(toRaw(plan.boardScoreBeforeFix));

      for (const suggestion of plan.suggestions) {
        const result = apply(state, engineContent, {
          kind: "placeFacility",
          facilityId: suggestion.facilityId,
          defId: suggestion.defId,
          cellIndex: suggestion.cellIndex,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        state = result.state;
        const current = boardOutputScore(state, engineContent);
        expect(toRaw(current) - toRaw(previous)).toBe(toRaw(suggestion.deltaScoreFix));
        previous = current;
      }
    },
  );
});

describe("M26 推奨配置: 準最適化パラメータの意味", () => {
  const engineContent = testContent();

  it("qualityRatio = 1.0 なら各手が増分最大(素の貪欲へ厳密に退化)", () => {
    for (const board of BOARDS) {
      const plan = planFor(board, engineContent, FIX_ONE);
      for (const suggestion of plan.suggestions) {
        expect(toRaw(suggestion.deltaScoreFix)).toBe(toRaw(suggestion.bestDeltaScoreFix));
      }
    }
  });

  it("既定 ratio では、増分に幅がある手で最大を採らない(狙って落としている)", () => {
    const board = BOARDS[0];
    if (board === undefined) return;
    const plan = planFor(board, engineContent);
    const loweredSteps = plan.suggestions.filter(
      (s) => toRaw(s.deltaScoreFix) < toRaw(s.bestDeltaScoreFix),
    );
    expect(loweredSteps.length).toBeGreaterThan(0);
  });

  it("目標増分は中立手(Δ = 1.0)を下回らない = 進んで損をする提案をしない", () => {
    for (const board of BOARDS) {
      const plan = planFor(board, engineContent);
      for (const suggestion of plan.suggestions) {
        if (toRaw(suggestion.bestDeltaScoreFix) >= toRaw(FIX_ONE)) {
          expect(toRaw(suggestion.targetDeltaScoreFix)).toBeGreaterThanOrEqual(toRaw(FIX_ONE));
        }
      }
    }
  });

  it("既定の 1 手あたり目標比は 0.65(盤面比 0.80 へ校正した値)/ 上限は 0.85", () => {
    expect(toRaw(ASSIST_STEP_TARGET_RATIO)).toBe(650_000);
    expect(toRaw(ASSIST_EFFICIENCY_CAP)).toBe(850_000);
    // 1 手あたり比 < 上限 であることは設計の向き(狙う線 < 検査する線)。
    expect(toRaw(ASSIST_STEP_TARGET_RATIO)).toBeLessThan(toRaw(ASSIST_EFFICIENCY_CAP));
  });
});

describe("M26 推奨配置: 盤面制約", () => {
  const engineContent = testContent();

  it("blockedCells(瓦礫セルの結線点)には提案しない", () => {
    const allowed = rect(0, 0, 3, 3);
    const board: SmallBoard = {
      name: "blocked",
      allowedCells: allowed,
      existing: [],
      requests: [req("bkF1", HEAT.id), req("bkF2", HEAT.id)],
    };
    const plan = planFor(board, engineContent);
    for (const suggestion of plan.suggestions) {
      expect(allowed).toContain(suggestion.cellIndex);
    }
  });

  it("空きが尽きたら例外にせず unplacedFacilityIds へ載せる", () => {
    const board: SmallBoard = {
      name: "full",
      allowedCells: rect(0, 0, 2, 1),
      existing: [],
      requests: [req("fuF1", HEAT.id), req("fuF2", HEAT.id), req("fuF3", HEAT.id)],
    };
    const plan = planFor(board, engineContent);
    expect(plan.suggestions).toHaveLength(2);
    expect(plan.unplacedFacilityIds).toStrictEqual([id("fuF3")]);
  });

  it("2×2 が入らない幅の盤面では大型施設だけが置けない", () => {
    const board: SmallBoard = {
      name: "narrow",
      allowedCells: rect(0, 0, 1, 3),
      existing: [],
      requests: [req("nwF1", BIG_HEAT.id), req("nwF2", HEAT.id)],
    };
    const plan = planFor(board, engineContent);
    expect(plan.unplacedFacilityIds).toStrictEqual([id("nwF1")]);
    expect(plan.suggestions).toHaveLength(1);
  });

  it("既存施設の占有セル(大型の非アンカーセル含む)へは提案しない", () => {
    const big = facility("exBig", BIG_HEAT.id, 0, [], 1, { width: 2, height: 2 });
    const state = stateOf([big]);
    const plan = suggestPlacements(state, engineContent, [req("exF1", HEAT.id)], {
      blockedCells: blockedOutside(rect(0, 0, 3, 3)),
    });
    const suggestion = plan.suggestions[0];
    expect(suggestion).toBeDefined();
    if (suggestion === undefined) return;
    expect([0, 1, 6, 7]).not.toContain(suggestion.cellIndex);
  });
});

describe("M26 推奨配置: 入力の契約", () => {
  const engineContent = testContent();

  it("要求内で施設 ID が重複したら AssistError", () => {
    expect(() =>
      suggestPlacements(stateOf([]), engineContent, [req("dupF", HEAT.id), req("dupF", HEAT.id)]),
    ).toThrow(AssistError);
  });

  it("既存 entity ID と衝突したら AssistError", () => {
    const state = stateOf([facility("clashF", HEAT.id, 0)]);
    expect(() => suggestPlacements(state, engineContent, [req("clashF", HEAT.id)])).toThrow(
      AssistError,
    );
  });

  it("値域外の blockedCells は AssistError", () => {
    expect(() =>
      suggestPlacements(stateOf([]), engineContent, [req("oobF", HEAT.id)], {
        blockedCells: [GRID_CELL_COUNT],
      }),
    ).toThrow(AssistError);
  });

  it("content に無い defId は RulesError(engine の既存語彙)", () => {
    expect(() =>
      suggestPlacements(stateOf([]), engineContent, [
        { facilityId: id("noDefF"), defId: id("noSuchDef") },
      ]),
    ).toThrow(/content に無い/);
  });

  it("要求が空なら提案も空(盤面効率は前後で同じ)", () => {
    const state = stateOf([facility("emptyF", HEAT.id, 0)]);
    const plan = suggestPlacements(state, engineContent, []);
    expect(plan.suggestions).toStrictEqual([]);
    expect(toRaw(plan.boardScoreBeforeFix)).toBe(toRaw(plan.boardScoreAfterFix));
  });
});

// ---------------------------------------------------------------------------
// [2026-07-31裁定 A-7] 瓦礫ヘルパ: M52 の `state.terrain.rubbleCells` を
// `blockedCells` へ自動で流し込む薄いラッパ(呼び出し側の呼び忘れ防止)。
// ---------------------------------------------------------------------------

describe("M27(A-7) 瓦礫ヘルパ: rubbleBlockedCells / suggestPlacementsAvoidingRubble", () => {
  const engineContent = testContent();

  function stateWithRubble(rubbleCells: readonly number[]): ReturnType<typeof stateOf> {
    return setTerrain(stateOf([]), { rubbleCells, reclaimedCount: 0 });
  }

  it("rubbleBlockedCells は state.terrain.rubbleCells をそのまま返す", () => {
    const state = stateWithRubble([2, 5, 9]);
    expect(rubbleBlockedCells(state)).toStrictEqual([2, 5, 9]);
  });

  it("瓦礫セルが無い state では空配列(既存 conformance シナリオと同じ既定)", () => {
    expect(rubbleBlockedCells(stateOf([]))).toStrictEqual([]);
  });

  it("瓦礫セルには提案しない(呼び出し側が blockedCells を渡さなくても効く)", () => {
    const allowed = rect(0, 0, 3, 3);
    const rubble = blockedOutside(allowed); // 3x3 の外側全部を瓦礫扱いにする
    const state = stateWithRubble(rubble);
    const plan = suggestPlacementsAvoidingRubble(state, engineContent, [
      req("rbF1", HEAT.id),
      req("rbF2", HEAT.id),
    ]);
    for (const suggestion of plan.suggestions) {
      expect(allowed).toContain(suggestion.cellIndex);
    }
  });

  it("呼び出し側指定の blockedCells と瓦礫セルは和集合になる(どちらも避ける)", () => {
    // 瓦礫 = 0〜2、呼び出し側指定 = 3〜5。空きは 6 以降だけ。
    const state = stateWithRubble([0, 1, 2]);
    const plan = suggestPlacementsAvoidingRubble(state, engineContent, [req("mergeF1", HEAT.id)], {
      blockedCells: [3, 4, 5],
    });
    const suggestion = plan.suggestions[0];
    expect(suggestion).toBeDefined();
    if (suggestion === undefined) return;
    expect([0, 1, 2, 3, 4, 5]).not.toContain(suggestion.cellIndex);
  });

  it("qualityRatioFix を渡しても瓦礫は避けたまま(素の貪欲 = ratio 1.0)", () => {
    const allowed = rect(0, 0, 3, 3);
    const rubble = blockedOutside(allowed);
    const state = stateWithRubble(rubble);
    const plan = suggestPlacementsAvoidingRubble(state, engineContent, [req("ratioF1", HEAT.id)], {
      qualityRatioFix: FIX_ONE,
    });
    const suggestion = plan.suggestions[0];
    expect(suggestion).toBeDefined();
    if (suggestion === undefined) return;
    expect(allowed).toContain(suggestion.cellIndex);
  });

  it("瓦礫を避けたラッパは、瓦礫を明示的に blockedCells へ渡した suggestPlacements と同じ提案を返す", () => {
    const rubble = [10, 11, 12, 13];
    const state = stateWithRubble(rubble);
    const viaHelper = suggestPlacementsAvoidingRubble(state, engineContent, [req("eqF1", HEAT.id)]);
    const viaExplicit = suggestPlacements(state, engineContent, [req("eqF1", HEAT.id)], {
      blockedCells: rubble,
    });
    expect(viaHelper).toStrictEqual(viaExplicit);
  });

  it("state を 1 bit も変えない(瓦礫ヘルパも純関数)", () => {
    const state = stateWithRubble([4, 6, 8]);
    const snapshot = JSON.stringify(state.terrain);
    suggestPlacementsAvoidingRubble(state, engineContent, [req("pureF1", HEAT.id)]);
    expect(JSON.stringify(state.terrain)).toBe(snapshot);
  });
});
