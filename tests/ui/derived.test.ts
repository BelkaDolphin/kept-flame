// ---------------------------------------------------------------------------
// 派生値(src/ui/derived.ts)のテスト。**M8 の検収条件の本体**。
//
//   検収条件: 「派生値の再計算回数が更新セル近傍に限定されることのテスト」
//             (docs/MVP実装ロードマップ.md M8 行 / ADR-002(2) / ADR-029(2))
//
// 数え方は src/ui/reactive.ts の `recomputeCount`(computed 本体を実行した回数)。
// 手順はどのケースも同じ:
//   (1) 48 セル全部を 1 度読んでカウンタの起点を作る(primeAllCells)
//   (2) state を 1 手だけ動かして dispatch する
//   (3) 48 セル全部を読み直し、カウンタが増えたセル番号を集める
// これで「読まれたのに再計算されなかった」セルと「再計算されたセル」が
// 区別できる(遅延評価なので、読まなければ何も起きないのは当たり前だから)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { GRID_CELL_COUNT } from "../../src/engine/adjacency";
import {
  FIX_ONE,
  fixFromInt,
  fixFromRaw,
  mulFix,
  toApproxNumber,
  toRaw,
} from "../../src/engine/fp";
import { CODIFY_NO_DEADLINE_TICKS, suggestCodification } from "../../src/engine/assist/codify";
import { explorationRoi } from "../../src/engine/rules/exploration";
import { outpostNetworkRoi, outpostRoi } from "../../src/engine/rules/outpost";
import { activeLaborFix, facilityOutputPerTick } from "../../src/engine/rules/production";
import { recallRiskPerDay } from "../../src/engine/rules/recall";
import { reclaimCostFix } from "../../src/engine/rules/reclaim";
import { residentCombatPower } from "../../src/engine/rules/combat";
import { techMemoryKeyOf } from "../../src/engine/rules/techMemory";
import type { TraitDef } from "../../src/engine/rules/stats";
import type {
  EngineContent,
  EraDef,
  EventDef,
  ReclaimParams,
  RecordMediaParams,
  TechDef,
} from "../../src/engine/rules/types";
import {
  entitiesOfKind,
  requireEntity,
  type DispatchSnapshot,
  type EntityId,
  type EntityState,
  type ResearchState,
  type ResidentState,
  type TechMemoryState,
} from "../../src/engine/state/state";
import {
  createGameState,
  setField,
  setTechMemories,
  updateEntity,
} from "../../src/engine/state/update";
import {
  computePlacementPreview,
  explorationDestinationsForBand,
  previewExplorationRoi,
} from "../../src/ui/derived";
import { createGameStore } from "../../src/ui/store";
import {
  candidateResident,
  m32Content,
  M32_OUTPOST_TYPE,
  M32_REWARD_RESOURCE,
  outpostOf,
} from "./m32Fixtures";
import { FORGE, META, research, stateOf } from "../engine/fixtures";
import {
  CELL_CENTER,
  CELL_EAST,
  CELL_FAR,
  CELL_SOUTHEAST,
  CELL_WEST,
  HEARTH,
  SMELTER,
  STUDY_DESK,
  WOOD,
  WORKER_ID,
  at,
  boardContent,
  boardState,
  changedCells,
  createTestStore,
  facility,
  id,
  neighborhoodOf,
  placeHearth,
  primeAllCells,
  recomputeCounts,
  resident,
  resource,
} from "./fixtures";

describe("fan-in 上界: 1 セル編集の再計算は自セル + 8 近傍に限定される(ADR-002(2))", () => {
  it("施設を 1 基置くと、隣接 computed が再計算されるのは近傍の占有セルだけ", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    primeAllCells(store);

    const recomputed = changedCells(before, recomputeCounts(store.derived.cellAdjacency));
    // 置いたセルと、その 8 近傍のうち施設が建っているセル(14 / 15)だけ。
    expect(recomputed).toEqual([CELL_CENTER, CELL_EAST, CELL_SOUTHEAST]);
    // 上界そのもの: 自セル + 8 近傍 = 9 個を超えない。
    expect(recomputed.length).toBeLessThanOrEqual(9);
    for (const cellIndex of recomputed) {
      expect(neighborhoodOf(CELL_SOUTHEAST)).toContain(cellIndex);
    }
  });

  it("遠方セル(近傍でない 44 セル)は 1 度も再計算されない", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    primeAllCells(store);

    const after = recomputeCounts(store.derived.cellAdjacency);
    const neighborhood = new Set(neighborhoodOf(CELL_SOUTHEAST));
    let untouched = 0;
    for (let i = 0; i < GRID_CELL_COUNT; i++) {
      if (neighborhood.has(i)) continue;
      expect(at(after, i)).toBe(at(before, i));
      untouched++;
    }
    expect(untouched).toBe(GRID_CELL_COUNT - 9);
    expect(at(after, CELL_FAR)).toBe(at(before, CELL_FAR));
  });

  it("セルの表示モデル(cellView)も近傍に限定される", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellView);

    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    primeAllCells(store);

    expect(changedCells(before, recomputeCounts(store.derived.cellView))).toEqual([
      CELL_CENTER,
      CELL_EAST,
      CELL_SOUTHEAST,
    ]);
  });

  it("施設の撤去も同じ上界に収まる", () => {
    const { store } = createTestStore([facility("fSouth", HEARTH.id, CELL_SOUTHEAST)]);
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    store.dispatch({
      type: "commandApplied",
      command: { kind: "demolishFacility", facilityId: id("fSouth") },
    });
    primeAllCells(store);

    expect(changedCells(before, recomputeCounts(store.derived.cellAdjacency))).toEqual([
      CELL_CENTER,
      CELL_EAST,
      CELL_SOUTHEAST,
    ]);
  });

  it("Lv 変更(配置は不変)では近傍の隣接 computed が 1 個も再計算されない", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    const beforeAdjacency = recomputeCounts(store.derived.cellAdjacency);
    const beforeView = recomputeCounts(store.derived.cellView);

    store.dispatch({
      type: "commandApplied",
      command: { kind: "upgradeFacility", facilityId: id("fHearth") },
    });
    primeAllCells(store);

    // 隣接ボーナスは Lv に依存しない = 近傍は無関係。
    expect(changedCells(beforeAdjacency, recomputeCounts(store.derived.cellAdjacency))).toEqual([]);
    // 表示モデルは自セルだけ作り直す(fan-in 1)。
    expect(changedCells(beforeView, recomputeCounts(store.derived.cellView))).toEqual([
      CELL_CENTER,
    ]);
    expect(at(store.derived.cellView, CELL_CENTER).value.level).toBe(2);
  });

  it("tick を進めても隣接 computed は 1 個も再計算されない(配置は advance 中に変わらない)", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);
    const buildsBefore = store.stats().advanceContextBuildCount;

    store.dispatch({ type: "ticked", toTick: 5 });
    primeAllCells(store);

    expect(changedCells(before, recomputeCounts(store.derived.cellAdjacency))).toEqual([]);
    // AdvanceContext(隣接乗数の precompute)も作り直さない。
    expect(store.stats().advanceContextBuildCount).toBe(buildsBefore);
  });

  it("同じタグの施設へ差し替えると、近傍の隣接値は変わらないので表示は再計算されない", () => {
    const { store } = createTestStore([facility("fSouth", HEARTH.id, CELL_SOUTHEAST)]);
    primeAllCells(store);
    const beforeAdjacency = recomputeCounts(store.derived.cellAdjacency);
    const beforeView = recomputeCounts(store.derived.cellView);

    // 解体 → 建て直しを 1 dispatch で原子適用する(途中の state を誰にも見せない)。
    store.dispatch({
      type: "commandApplied",
      command: [
        { kind: "demolishFacility", facilityId: id("fSouth") },
        placeHearth("fSouth2", CELL_SOUTHEAST),
      ],
    });
    primeAllCells(store);

    // 配置素性(施設 ID)が変わったので近傍の隣接は再計算される…
    expect(changedCells(beforeAdjacency, recomputeCounts(store.derived.cellAdjacency))).toEqual([
      CELL_CENTER,
      CELL_EAST,
      CELL_SOUTHEAST,
    ]);
    // …が、値が同じなので下流(表示モデル)は自セル以外まで伝播しない。
    expect(changedCells(beforeView, recomputeCounts(store.derived.cellView))).toEqual([
      CELL_SOUTHEAST,
    ]);
  });

  it("依存の本数そのものが O(近傍) に収まっている", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    // 内陸セル: 自セル + 8 近傍 + 隣接行列 = 10。
    expect(at(store.derived.cellAdjacency, CELL_CENTER).dependencyCount).toBe(10);
    // 空きセルは近傍を 1 つも読まない(自セルの配置だけ)。
    expect(at(store.derived.cellAdjacency, 0).dependencyCount).toBe(1);
    // 表示モデルは「隣接結果 + 自セルの施設 + 自セルの配置 + 自セルの瓦礫」の
    // 4 本([M30] cellRubble[i] を追加。自セルのみへの依存なので近傍越しの
    // O(近傍) 上界そのものは変わらない・sources.ts の doc 参照)。
    expect(at(store.derived.cellView, CELL_CENTER).dependencyCount).toBe(4);
  });
});

describe("隣接値そのもの(engine と同じ 1 実装であること)", () => {
  it("熱源が隣り合うと +20%、3 つ目からは過密ペナルティ(GDD 6.2/6.3)", () => {
    const { store } = createTestStore();
    // 初期状態: セル 14 の熱源近傍は 15 の 1 基だけ。
    expect(toRaw(at(store.derived.cellView, CELL_CENTER).value.multiplierFix)).toBe(1_200_000);

    // 近傍を 2 基へ: まだ threshold(3)未満なので加算のみ。
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });
    expect(toRaw(at(store.derived.cellView, CELL_CENTER).value.multiplierFix)).toBe(1_400_000);
    expect(at(store.derived.cellView, CELL_CENTER).value.overcrowded).toBe(false);

    // 3 基目で過密: ボーナスは先頭 2 件のみ有効、超過 1 件につき -10%。
    store.dispatch({ type: "commandApplied", command: placeHearth("fWest", CELL_WEST) });
    const view = at(store.derived.cellView, CELL_CENTER).value;
    expect(toRaw(view.multiplierFix)).toBe(1_300_000);
    expect(view.overcrowdedNeighborCount).toBe(1);
    expect(view.overcrowded).toBe(true);
  });

  it("UI の乗数と engine の multiplierByFacilityId が一致する(単一正準実装)", () => {
    const { store } = createTestStore([
      facility("fSouth", HEARTH.id, CELL_SOUTHEAST),
      facility("fWest", STUDY_DESK.id, CELL_WEST),
    ]);
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth2", 22) });

    const multipliers = store.peekAdvanceContext().multiplierByFacilityId;
    let checked = 0;
    for (const entity of entitiesOfKind(store.peekState(), "facility")) {
      const expected = multipliers.get(entity.id);
      expect(expected).toBeDefined();
      if (expected === undefined) continue;
      const view = at(store.derived.cellView, entity.cellIndex).value;
      expect(view.facilityId).toBe(entity.id);
      expect(toRaw(view.multiplierFix)).toBe(toRaw(expected));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("空きセルの表示モデルは乗数 1.0 の既定形", () => {
    const { store } = createTestStore();
    const view = at(store.derived.cellView, 0).value;
    expect(view.occupied).toBe(false);
    expect(view.facilityId).toBeNull();
    expect(view.tags).toEqual([]);
    expect(toRaw(view.multiplierFix)).toBe(1_000_000);
    expect(view.cellId).toBe("c00");
  });
});

describe("全体集計はセル表示の依存に置かない(ADR-002(2))", () => {
  it("gridSummary が過密を数える", () => {
    const { store } = createTestStore([
      facility("fSouth", HEARTH.id, CELL_SOUTHEAST),
      facility("fWest", HEARTH.id, CELL_WEST),
    ]);
    const summary = store.derived.gridSummary.value;
    expect(summary.occupiedCellCount).toBe(5);
    expect(summary.emptyCellCount).toBe(GRID_CELL_COUNT - 5);
    expect(summary.overcrowdedFacilityCount).toBeGreaterThan(0);
  });

  it("全体集計を購読してもセル表示の再計算回数は増えない", () => {
    const { store } = createTestStore();
    primeAllCells(store);
    void store.derived.gridSummary.value;
    const beforeView = recomputeCounts(store.derived.cellView);
    const summaryBefore = store.derived.gridSummary.recomputeCount;

    // 遠方セルの近傍(41)へ 1 基置く。
    store.dispatch({ type: "commandApplied", command: placeHearth("fFarEast", 41) });
    void store.derived.gridSummary.value;

    // 全体集計は作り直されるが、基準セル(14)の表示は無関係のまま。
    expect(store.derived.gridSummary.recomputeCount).toBe(summaryBefore + 1);
    expect(at(recomputeCounts(store.derived.cellView), CELL_CENTER)).toBe(
      at(beforeView, CELL_CENTER),
    );
  });
});

describe("値の派生(資源・研究・住民・ホームハブ)", () => {
  it("資源・研究・住民の一覧が ID 昇順で出る", () => {
    const { store } = createTestStore();
    expect(store.derived.resources.value.map((r) => r.entityId)).toEqual([id("wStock")]);
    expect(store.derived.research.value.map((r) => r.techId)).toEqual([id("techBronze")]);
    expect(store.derived.residents.value.map((r) => r.entityId)).toEqual([id("aRui")]);
    expect(store.derived.codify.value).toEqual([]);
  });

  it("tick が進むと資源の在庫が増える(engine の結果がそのまま出る)", () => {
    const { store } = createTestStore();
    const before = at(store.derived.resources.value, 0).stockApprox;
    store.dispatch({ type: "ticked", toTick: 30 });
    const after = at(store.derived.resources.value, 0).stockApprox;
    expect(after).toBeGreaterThan(before);
    expect(toRaw(at(store.derived.resources.value, 0).stockFix)).toBe(
      toRaw(requireEntity(store.peekState(), id("wStock"), "resource").stock),
    );
  });

  it("想起困難は現在 tick との比較で表示される", () => {
    const { store, state, content } = createTestStore();
    // 想起困難は advance が作る state であってコマンドでは作れない。engine の外で
    // 組み立てた state を据えられる口は worldLoaded だけ(store.ts §1・M49)。
    const next = updateEntity(state, id("aRui"), "resident", (r) =>
      setField(r, "recallImpairedUntilTick", 100),
    );
    store.dispatch({ type: "worldLoaded", state: next, content, source: "save" });
    expect(at(store.derived.residents.value, 0).recallImpaired).toBe(true);
    expect(store.derived.homeBadges.value.impairedResidentCount).toBe(1);
  });

  it("ホームハブのバッジは件数が動かない限り再描画を起こさない(ADR-027(4))", () => {
    const { store } = createTestStore();
    const mount = store.mountScreen("home");
    let renders = 0;
    mount.scope.effect(() => {
      void store.derived.homeBadges.value;
      renders++;
    });
    expect(renders).toBe(1);

    const recomputesBefore = store.derived.homeBadges.recomputeCount;
    store.dispatch({ type: "ticked", toTick: 3 });

    // state が変わったので computed 自体は作り直される…
    expect(store.derived.homeBadges.recomputeCount).toBe(recomputesBefore + 1);
    // …が、件数が同じなのでバッジ行の再描画は起きない。
    expect(renders).toBe(1);
    mount.dispose();
  });

  it("選択セルの派生値が選択に追従する", () => {
    const { store } = createTestStore();
    expect(store.derived.selectedCell.value).toBeNull();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_CENTER });
    expect(store.derived.selectedCell.value?.facilityId).toBe(id("fHearth"));
    store.dispatch({ type: "cellSelected", cellIndex: null });
    expect(store.derived.selectedCell.value).toBeNull();
  });
});

describe("12画面が同一状態をリアルタイム共有する", () => {
  it("2 画面が同じセルを購読しても再計算は 1 回だけ(派生値は共有インスタンス)", () => {
    const { store } = createTestStore();
    const gridMount = store.mountScreen("grid");
    const detailMount = store.mountScreen("facility", { activate: false });

    let gridRenders = 0;
    let detailRenders = 0;
    gridMount.scope.effect(() => {
      void at(store.derived.cellView, CELL_CENTER).value;
      gridRenders++;
    });
    detailMount.scope.effect(() => {
      void at(store.derived.cellView, CELL_CENTER).value;
      detailRenders++;
    });

    const before = at(store.derived.cellView, CELL_CENTER).recomputeCount;
    store.dispatch({ type: "commandApplied", command: placeHearth("fSouth", CELL_SOUTHEAST) });

    expect(at(store.derived.cellView, CELL_CENTER).recomputeCount).toBe(before + 1);
    expect(gridRenders).toBe(2);
    expect(detailRenders).toBe(2);

    gridMount.dispose();
    detailMount.dispose();
  });
});

// ---------------------------------------------------------------------------
// [M17] 大型施設(GDD 6.1 の 2×1 / 1×2 / 2×2)を UI 派生値が正しく扱えること。
//
// 盤面は fixtures の 3 基(cell 14 / 15 / 40 のかまど)に、**2×1 のかまど**を
// アンカー cell 12(cell 12 と 13 を占有)へ足したもの。
//   - cell 13 は cell 14(熱源)の西隣なので、2×1 として見たときだけ熱源が効く
//     (アンカー cell 12 の 8 近傍に cell 14 は入らない)
//   - cell 12 / 13 のどちらのセルからも同じ施設・同じ乗数が引ける(1 施設 1 回)
//
// footprint は **state 側**に持たせる(content の HEARTH は 1×1 定義のままで、
// state が権威であることがそのままテストになっている・GDD 6.1 [2026-07-30裁定])。
// ---------------------------------------------------------------------------

const BIG_ANCHOR = 12;
const BIG_TAIL = 13;
const WIDE_2X1 = { width: 2, height: 1 } as const;

function bigHearth(name = "fBig", anchor = BIG_ANCHOR) {
  return facility(name, HEARTH.id, anchor, [], 1, WIDE_2X1);
}

describe("[M17] 大型施設の隣接判定(GDD 6.3 の判定基準セル)", () => {
  it("アンカーの 8 近傍に無い基準セルの熱源が効く(占有矩形の外周が基準)", () => {
    // アンカー cell 12 の 8 近傍に cell 14 は含まれない = 1×1 なら効かない。
    expect(neighborhoodOf(BIG_ANCHOR)).not.toContain(CELL_CENTER);

    const unit = createTestStore([facility("fUnit", HEARTH.id, BIG_ANCHOR)]);
    expect(toRaw(at(unit.store.derived.cellView, BIG_ANCHOR).value.multiplierFix)).toBe(1_000_000);

    const large = createTestStore([bigHearth()]);
    expect(toRaw(at(large.store.derived.cellView, BIG_ANCHOR).value.multiplierFix)).toBe(1_200_000);
  });

  it("全占有セルが同じ施設・同じ乗数を返し、アンカーが分かる", () => {
    const { store } = createTestStore([bigHearth()]);
    const anchorView = at(store.derived.cellView, BIG_ANCHOR).value;
    const tailView = at(store.derived.cellView, BIG_TAIL).value;

    for (const view of [anchorView, tailView]) {
      expect(view.occupied).toBe(true);
      expect(view.facilityId).toBe(id("fBig"));
      expect(view.anchorCellIndex).toBe(BIG_ANCHOR);
      expect(toRaw(view.multiplierFix)).toBe(1_200_000);
    }
    // 空きセルはアンカーを持たない。
    expect(at(store.derived.cellView, 0).value.anchorCellIndex).toBeNull();
  });

  it("UI の乗数と engine の multiplierByFacilityId が大型施設でも一致する", () => {
    const { store } = createTestStore([bigHearth()]);
    const engineMultiplier = store.peekAdvanceContext().multiplierByFacilityId.get(id("fBig"));
    expect(engineMultiplier).toBeDefined();
    if (engineMultiplier === undefined) return;
    for (const cellIndex of [BIG_ANCHOR, BIG_TAIL]) {
      expect(toRaw(at(store.derived.cellView, cellIndex).value.multiplierFix)).toBe(
        toRaw(engineMultiplier),
      );
    }
  });

  it("大型施設の近傍は 1 施設 1 回しか数えない(過密の重複計上がない)", () => {
    // 2×1(cell 12,13)+ かまど cell 6 / cell 7 を足す。
    const { store } = createTestStore([
      bigHearth(),
      facility("fH6", HEARTH.id, 6),
      facility("fH7", HEARTH.id, 7),
    ]);

    // cell 6 から見ると近傍の熱源は「cell 7 の 1 基」と「2×1(cell 12+13)の 1 基」の
    // 2 施設。セル単位で数えると 3 件 = 過密になってしまう。
    const view6 = at(store.derived.cellView, 6).value;
    expect(view6.overcrowded).toBe(false);
    expect(toRaw(view6.multiplierFix)).toBe(1_400_000);

    // cell 7 から見ると 3 施設(cell 14 / 2×1 / cell 6)= 超過 1 件。
    const view7 = at(store.derived.cellView, 7).value;
    expect(view7.overcrowdedNeighborCount).toBe(1);
    expect(toRaw(view7.multiplierFix)).toBe(1_300_000);
  });

  it("gridSummary は占有セル数はセル単位・過密は施設単位(アンカー)で数える", () => {
    const { store } = createTestStore([
      bigHearth(),
      facility("fH6", HEARTH.id, 6),
      facility("fH7", HEARTH.id, 7),
    ]);
    const summary = store.derived.gridSummary.value;
    // 3(fixtures)+ 2(2×1)+ 2(cell 6/7)= 7 セル。
    expect(summary.occupiedCellCount).toBe(7);
    expect(summary.emptyCellCount).toBe(GRID_CELL_COUNT - 7);
    // 過密は 2×1(アンカー 12)/ cell 7 / cell 14 の 3 施設。アンカー限定でなければ
    // 2×1 が cell 12 と 13 で二重に数えられて 4 になる。
    expect(summary.overcrowdedFacilityCount).toBe(3);
    expect(summary.overcrowdedNeighborTotal).toBe(3);
  });

  it("大型施設でも fan-in は近傍に限られる(依存は自セル + 基準セル + 行列)", () => {
    const { store } = createTestStore([bigHearth()]);
    primeAllCells(store);
    // 2×1 の基準セルは 7 個(cell 6,7,8,14,18,19,20)+ 自セル + 隣接行列 = 9。
    expect(at(store.derived.cellAdjacency, BIG_ANCHOR).dependencyCount).toBe(9);
    expect(at(store.derived.cellAdjacency, BIG_TAIL).dependencyCount).toBe(9);

    const before = recomputeCounts(store.derived.cellAdjacency);
    // 遠方セル(どの基準セルでもない cell 41)へ 1 基置く。
    store.dispatch({ type: "commandApplied", command: placeHearth("fFarEast", 41) });
    primeAllCells(store);
    const recomputed = changedCells(before, recomputeCounts(store.derived.cellAdjacency));
    expect(recomputed).not.toContain(BIG_ANCHOR);
    expect(recomputed).not.toContain(BIG_TAIL);
  });

  it("占有セルが重なる state は 1 セル = 1 施設として reject する", () => {
    // ストア生成は engine の precompute(createAdvanceContext → buildCellOccupancy)を
    // 先に通るので RulesError が先着する。UI の根 signal 側(syncSourcesFromState)にも
    // 同じ検査があり、engine を経由しない経路でも黙って通らない(二重防御)。
    expect(() => createTestStore([bigHearth(), facility("fClash", HEARTH.id, BIG_TAIL)])).toThrow(
      /1 セル = 1 施設/,
    );
  });
});

describe("[M19] selectedCellBreakdown(GDD 6.5 内訳ビュー)", () => {
  it("未選択なら null", () => {
    const { store } = createTestStore();
    expect(store.derived.selectedCellBreakdown.value).toBeNull();
  });

  it("空きセルを選択しても null", () => {
    const { store } = createTestStore();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_SOUTHEAST });
    expect(store.derived.selectedCellBreakdown.value).toBeNull();
  });

  it("占有セルを選択すると cellView と同じ multiplierFix/bonusFix を返す", () => {
    const { store } = createTestStore();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_CENTER });
    const breakdown = store.derived.selectedCellBreakdown.value;
    expect(breakdown).not.toBeNull();
    if (breakdown === null) return;
    const view = at(store.derived.cellView, CELL_CENTER).value;
    expect(toRaw(breakdown.multiplierFix)).toBe(toRaw(view.multiplierFix));
    expect(toRaw(breakdown.bonusFix)).toBe(toRaw(view.bonusFix));
    expect(toRaw(breakdown.overcrowdPenaltyFix)).toBe(toRaw(view.overcrowdPenaltyFix));
    expect(breakdown.overcrowdedNeighborCount).toBe(view.overcrowdedNeighborCount);

    const heatBucket = breakdown.buckets.find((b) => b.tag === "heat");
    expect(heatBucket?.neighborAnchors).toEqual([CELL_EAST]);
    expect(heatBucket?.effectiveAnchors).toEqual([CELL_EAST]);
    expect(heatBucket?.excessAnchors).toEqual([]);
  });
});

describe("[M19] computePlacementPreview(GDD 6.5 配置プレビュー)", () => {
  it("既存施設に隣接する空きセルはボーナスが付き、遠方セルは付かない", () => {
    const { store } = createTestStore();
    const previews = computePlacementPreview(
      store.sources,
      store.peekContent(),
      store.sources.worldSeedU32.peek(),
      HEARTH.id,
    );
    expect(previews).toHaveLength(GRID_CELL_COUNT);

    // CELL_WEST(13) は CELL_CENTER(14)の8近傍 = heat|heat +0.2 が付く。
    const west = previews.find((p) => p.cellIndex === CELL_WEST);
    expect(west?.fits).toBe(true);
    expect(toRaw(west?.bonusFix ?? at(previews, 0).bonusFix)).toBe(200_000);

    // cell 0(x0,y0)はどの既存施設(14/15/40)の8近傍でもない孤立セル。ボーナス無し。
    const isolated = previews.find((p) => p.cellIndex === 0);
    expect(isolated?.fits).toBe(true);
    expect(toRaw(isolated?.bonusFix ?? at(previews, 0).bonusFix)).toBe(0);
  });

  it("既存施設が占有しているセルは fits=false", () => {
    const { store } = createTestStore();
    const previews = computePlacementPreview(
      store.sources,
      store.peekContent(),
      store.sources.worldSeedU32.peek(),
      HEARTH.id,
    );
    const occupied = previews.find((p) => p.cellIndex === CELL_CENTER);
    expect(occupied?.fits).toBe(false);
  });

  it("[M30] 瓦礫セル(GDD 9.1)は fits=false(engine の cellIsRubble reject と食い違わせない)", () => {
    const RUBBLE_CELL = 30;
    const state = createGameState(META, [resource("wStock", WOOD)], [], [], [], [], undefined, [], {
      rubbleCells: [RUBBLE_CELL],
      reclaimedCount: 0,
    });
    const store = createGameStore({ state, content: boardContent() });
    const previews = computePlacementPreview(
      store.sources,
      store.peekContent(),
      store.sources.worldSeedU32.peek(),
      HEARTH.id,
    );
    expect(previews.find((p) => p.cellIndex === RUBBLE_CELL)?.fits).toBe(false);
    // 瓦礫でない空きセルは引き続き fits=true。
    expect(previews.find((p) => p.cellIndex === CELL_WEST)?.fits).toBe(true);
  });

  it("大型施設(2×1)は盤外へはみ出すアンカーで fits=false になる", () => {
    const wideDef = { ...HEARTH, id: id("wideHearth"), footprint: { width: 2, height: 1 } };
    const { store } = createTestStore();
    const contentWithWide = boardContent();
    const previews = computePlacementPreview(
      store.sources,
      {
        ...contentWithWide,
        facilityDefs: new Map([...contentWithWide.facilityDefs, [wideDef.id, wideDef]]),
      },
      store.sources.worldSeedU32.peek(),
      wideDef.id,
    );
    // GRID_WIDTH=6 の右端列(x=5)をアンカーにすると 2×1 が盤外へはみ出す。
    const rightEdgeAnchor = 5; // (x=5, y=0)
    expect(previews.find((p) => p.cellIndex === rightEdgeAnchor)?.fits).toBe(false);
    // 1 列左(x=4)なら収まる(近傍に施設が無いので空きセルとして fits=true)。
    const fitsAnchor = 4;
    expect(previews.find((p) => p.cellIndex === fitsAnchor)?.fits).toBe(true);
  });
});

// --- M30: 格子/施設詳細/住民配置 ---------------------------------------------

describe("[M30] CellViewModel.isRubble(GDD 9.1)", () => {
  const RUBBLE_CELL = 30;

  function terrainState(rubbleCells: readonly number[], firewoodStockHuman = 0) {
    return createGameState(
      META,
      [resident("rSolo"), resource("wStock", WOOD, firewoodStockHuman)],
      [],
      [],
      [],
      [],
      undefined,
      [],
      { rubbleCells, reclaimedCount: 0 },
    );
  }

  it("terrain.rubbleCells に載っているセルは isRubble=true・非占有として表示される", () => {
    const store = createGameStore({ state: terrainState([RUBBLE_CELL]), content: boardContent() });
    const cell = at(store.derived.cellView, RUBBLE_CELL).value;
    expect(cell.isRubble).toBe(true);
    expect(cell.occupied).toBe(false);
  });

  it("瓦礫リストに無いセルは isRubble=false", () => {
    const store = createGameStore({ state: terrainState([RUBBLE_CELL]), content: boardContent() });
    expect(at(store.derived.cellView, CELL_WEST).value.isRubble).toBe(false);
  });

  it("開墾(reclaimCell)で isRubble が反転し、変わるのは自セルだけ(近傍の隣接には無関係・fan-in)", () => {
    const reclaimParams: ReclaimParams = {
      baseCostFix: fixFromInt(10),
      costGrowthFix: FIX_ONE,
      costCapFix: fixFromInt(10),
      costResourceId: WOOD,
      initialRubbleCells: [],
    };
    const withReclaim: EngineContent = { ...boardContent(), reclaim: reclaimParams };
    const store = createGameStore({
      state: terrainState([RUBBLE_CELL], 100),
      content: withReclaim,
    });
    primeAllCells(store);
    const beforeAdjacency = recomputeCounts(store.derived.cellAdjacency);
    const beforeView = recomputeCounts(store.derived.cellView);

    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "reclaimCell", cellIndex: RUBBLE_CELL },
    });
    expect(result.command?.ok).toBe(true);
    primeAllCells(store);

    expect(at(store.derived.cellView, RUBBLE_CELL).value.isRubble).toBe(false);
    expect(changedCells(beforeAdjacency, recomputeCounts(store.derived.cellAdjacency))).toEqual([]);
    expect(changedCells(beforeView, recomputeCounts(store.derived.cellView))).toEqual([
      RUBBLE_CELL,
    ]);
  });
});

describe("[M30] residents: ステータス5種/生存/死亡tombstone(GDD 7.1/7.5)", () => {
  it("ステータス未設定の住民は中立既定値(基準50)が5種とも出る", () => {
    const { store } = createTestStore();
    const view = at(store.derived.residents.value, 0);
    expect(view.stats).toEqual({
      vigorApprox: 50,
      dexterityApprox: 50,
      intellectApprox: 50,
      fortitudeApprox: 50,
      willApprox: 50,
    });
    expect(view.alive).toBe(true);
    expect(view.diedTick).toBeNull();
  });

  it("trait の加算効果が反映される(生産式と同じ合成経路 = residentContribution)", () => {
    const vigorTrait: TraitDef = {
      id: id("traitVigorTest"),
      statAddFixById: new Map([["vigor", fixFromInt(5)]]),
      statMulFixById: new Map(),
      yieldMulFix: FIX_ONE,
    };
    const state = createGameState(META, [resident("rTrait", { traitIds: [vigorTrait.id] })]);
    const withTrait: EngineContent = {
      ...boardContent(),
      traitDefs: new Map([[vigorTrait.id, vigorTrait]]),
    };
    const store = createGameStore({ state, content: withTrait });
    expect(at(store.derived.residents.value, 0).stats.vigorApprox).toBe(55);
    // 他の 4 種は無変更のまま中立既定値。
    expect(at(store.derived.residents.value, 0).stats.willApprox).toBe(50);
  });

  it("life.diedTick が立っている住民は alive=false・diedTick が表示される(GDD 7.5 tombstone)", () => {
    const state = createGameState(META, [
      { ...resident("rDead"), life: { bornTick: -1000, lifespanTick: 2000, diedTick: 500 } },
    ]);
    const store = createGameStore({ state, content: boardContent() });
    const view = at(store.derived.residents.value, 0);
    expect(view.alive).toBe(false);
    expect(view.diedTick).toBe(500);
  });

  it("寿命(life)を持たない住民は alive=true・diedTick=null(死なない仕様のまま)", () => {
    const { store } = createTestStore();
    expect(at(store.derived.residents.value, 0).alive).toBe(true);
    expect(at(store.derived.residents.value, 0).diedTick).toBeNull();
  });
});

describe("[M30] facilityCatalog(②施設カタログ・content のみに依存)", () => {
  it("content の facilityDefs が ID 昇順で並び、産出種別が正しく写る", () => {
    const { store } = createTestStore();
    const catalog = store.derived.facilityCatalog.value;
    const ids = catalog.map((entry) => entry.defId);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids)).toEqual(new Set([FORGE.id, HEARTH.id, SMELTER.id, STUDY_DESK.id]));

    const hearthEntry = catalog.find((entry) => entry.defId === HEARTH.id);
    expect(hearthEntry?.tags).toEqual(["heat"]);
    expect(hearthEntry?.outputKind).toBe("resource");
    expect(hearthEntry?.outputResourceId).toBe(WOOD);

    const studyDeskEntry = catalog.find((entry) => entry.defId === STUDY_DESK.id);
    expect(studyDeskEntry?.outputKind).toBe("research");
    expect(studyDeskEntry?.outputResourceId).toBeNull();
  });

  it("盤面(state)が変わってもカタログの参照は変わらない(content のみ依存・再計算なし)", () => {
    const { store } = createTestStore();
    const before = store.derived.facilityCatalog.value;
    store.dispatch({ type: "ticked", toTick: 30 });
    expect(store.derived.facilityCatalog.value).toBe(before);
  });
});

describe("[M30] facilityRoster(④住民配置の就労先選択)", () => {
  it("盤面の施設が ID 昇順・タグ/Lv/就労者つきで並ぶ", () => {
    const { store } = createTestStore();
    const roster = store.derived.facilityRoster.value;
    expect(roster.map((entry) => entry.facilityId)).toEqual([
      id("fEast"),
      id("fFar"),
      id("fHearth"),
    ]);
    const hearthEntry = roster.find((entry) => entry.facilityId === id("fHearth"));
    expect(hearthEntry?.tags).toEqual(["heat"]);
    expect(hearthEntry?.level).toBe(1);
    expect(hearthEntry?.workerIds).toEqual([WORKER_ID]);
    // HEARTH フィクスチャは workerSlotsByLevel を持たないので上限なし(null)。
    expect(hearthEntry?.slotsMax).toBeNull();
  });
});

describe("[M30] selectedFacilityDetail(③施設詳細/増築)", () => {
  it("未選択・空きセルは null", () => {
    const { store } = createTestStore();
    expect(store.derived.selectedFacilityDetail.value).toBeNull();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_SOUTHEAST });
    expect(store.derived.selectedFacilityDetail.value).toBeNull();
  });

  it("占有セルは Lv/就労者/産出レートを返し、産出レートは engine の式と一致する(congruence)", () => {
    const { store, state, content } = createTestStore();
    store.dispatch({ type: "cellSelected", cellIndex: CELL_CENTER });
    const detail = store.derived.selectedFacilityDetail.value;
    expect(detail).not.toBeNull();
    expect(detail?.facilityId).toBe(id("fHearth"));
    expect(detail?.defId).toBe(HEARTH.id);
    expect(detail?.level).toBe(1);
    expect(detail?.maxLevel).toBe(HEARTH.outputPerTickByLevel.length);
    expect(detail?.workers).toHaveLength(1);
    expect(detail?.workers[0]?.residentId).toBe(WORKER_ID);
    expect(detail?.outputKind).toBe("resource");
    expect(detail?.outputResourceId).toBe(WOOD);

    const facilityEntity = requireEntity(state, id("fHearth"), "facility");
    const def = content.facilityDefs.get(HEARTH.id);
    if (def === undefined) throw new Error("HEARTH 定義がフィクスチャに無い");
    const cell = at(store.derived.cellView, CELL_CENTER).value;
    const expectedRateFix = mulFix(
      mulFix(facilityOutputPerTick(def, facilityEntity.level), cell.multiplierFix),
      activeLaborFix(state, content, facilityEntity, def, state.tick),
    );
    expect(detail?.outputPerTickApprox).toBe(toApproxNumber(expectedRateFix));
    expect(detail?.multiplierApprox).toBe(cell.multiplierApprox);
  });
});

describe("[M30] reclaimInfo(②瓦礫開墾の現況・GDD 9.1)", () => {
  it("content に reclaim ブロックが無ければ不活性", () => {
    const { store } = createTestStore();
    const info = store.derived.reclaimInfo.value;
    expect(info.available).toBe(false);
    expect(info.nextCostApprox).toBeNull();
    expect(info.costResourceId).toBeNull();
  });

  it("reclaim ブロックがあれば次のコストが engine の式と一致する(congruence)", () => {
    const reclaimParams: ReclaimParams = {
      baseCostFix: fixFromInt(40),
      costGrowthFix: fixFromRaw(1_150_000), // 1.15(GDD 9.1)
      costCapFix: fixFromInt(2000),
      costResourceId: WOOD,
      initialRubbleCells: [],
    };
    const withReclaim: EngineContent = { ...boardContent(), reclaim: reclaimParams };
    const state = boardState();
    const store = createGameStore({ state, content: withReclaim });
    const info = store.derived.reclaimInfo.value;
    expect(info.available).toBe(true);
    const expectedCostFix = reclaimCostFix(reclaimParams, state.terrain.reclaimedCount);
    expect(info.nextCostApprox).toBe(toApproxNumber(expectedCostFix));
    expect(info.costResourceId).toBe(WOOD);
    expect(info.availableStockApprox).toBe(
      toApproxNumber(requireEntity(state, id("wStock"), "resource").stock),
    );
  });
});

// --- [M31] ⑤研究ツリー / ⑥成文化キュー -------------------------------------
//
// `boardState()`(tests/ui/fixtures.ts)の既定 research entity "rBronze" は
// techBronze(基底 content 由来)を指しており、本節の tech とは無関係なうえ、
// ID 昇順で `currentResearch` の対象を奪いうる。よって本節は `boardState` を
// 使わず `stateOf` で entity を最初から自分で組む(§0 のとおり)。

const TECH_ALPHA: TechDef = {
  id: id("techAlpha"),
  researchCostFix: fixFromInt(30),
  eraId: "e1",
  lossClass: "criticalRecoverable",
  prereqs: [],
  fieldFacilityId: HEARTH.id,
};
const TECH_BETA: TechDef = {
  id: id("techBeta"),
  researchCostFix: fixFromInt(50),
  eraId: "e1",
  lossClass: "criticalRecoverable",
  prereqs: [TECH_ALPHA.id],
};
const TECH_GAMMA: TechDef = {
  id: id("techGamma"),
  researchCostFix: fixFromInt(20),
  eraId: "e1",
  lossClass: "criticalRecoverable",
};
const TECH_RARE: TechDef = {
  id: id("techRare"),
  researchCostFix: fixFromInt(60),
  eraId: "e1",
  lossClass: "rareIrreversible",
};

const ERA_E1: EraDef = {
  id: "e1",
  order: 1,
  baseEraFix: fixFromInt(30),
  multiplierFix: FIX_ONE,
  gateTechId: TECH_BETA.id,
  criticalPathMax: 4,
};

/** assistCodify.test.ts と同型の縮約 recordMedia(石板=×1.0/40tick・紙=×0.5/20tick)。 */
const CODIFY_CLAY = id("codifyClay");
const CODIFY_PAPER_RESOURCE = id("codifyPaperResource");
const RECORD_MEDIA_PARAMS: RecordMediaParams = {
  baseCostFix: fixFromInt(10),
  baseDurationTicks: 40,
  printingTechId: null,
  printingCostMulFix: fixFromRaw(500_000),
  printingTimeMulFix: fixFromRaw(500_000),
  byMedium: {
    paper: {
      costMulFix: fixFromRaw(500_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: CODIFY_PAPER_RESOURCE,
    },
    stoneTablet: {
      costMulFix: FIX_ONE,
      timeMulFix: FIX_ONE,
      caravanWeightFix: FIX_ONE,
      flammable: false,
      costResourceId: CODIFY_CLAY,
    },
  },
};

function researchTreeContent(overrides: Partial<EngineContent> = {}): EngineContent {
  const base = boardContent();
  return {
    facilityDefs: base.facilityDefs,
    techDefs: new Map([
      [TECH_ALPHA.id, TECH_ALPHA],
      [TECH_BETA.id, TECH_BETA],
      [TECH_GAMMA.id, TECH_GAMMA],
      [TECH_RARE.id, TECH_RARE],
    ]),
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    eraDefs: new Map([[ERA_E1.id, ERA_E1]]),
    recordMedia: RECORD_MEDIA_PARAMS,
    ...overrides,
  };
}

describe("[M31] researchTree(⑤研究ツリー・GDD 5/7.4)", () => {
  it("(A)/(B) を状態に関わらず常に持ち、未着手/研究中/解禁済み/停滞喪失/一回性喪失を反映する", () => {
    const testContent = researchTreeContent();
    const entities: EntityState[] = [
      resident("aTest"),
      // techAlpha: 未着手(research entity 無し)
      // techBeta: 研究中(進行度 10/50)。prereq(techAlpha)は未解禁 = prereqsMet false。
      research("rBeta", TECH_BETA.id, 10),
      // techGamma: 停滞喪失(A) — completedTick は null へ戻り loss.irreversible=false。
      {
        kind: "research",
        id: id("rGamma"),
        techId: TECH_GAMMA.id,
        progress: fixFromInt(0),
        completedTick: null,
        loss: { tick: 20, irreversible: false },
      } satisfies ResearchState,
      // techRare: 一回性喪失(B) — currentResearch の対象からも外れる。
      {
        kind: "research",
        id: id("rRare"),
        techId: TECH_RARE.id,
        progress: fixFromInt(0),
        completedTick: null,
        loss: { tick: 30, irreversible: true },
      } satisfies ResearchState,
    ];
    const state = stateOf(entities, META);
    const store = createGameStore({ state, content: testContent });
    const tree = store.derived.researchTree.value;

    const alpha = tree.find((e) => e.techId === TECH_ALPHA.id);
    expect(alpha?.status).toBe("notStarted");
    expect(alpha?.lossClass).toBe("criticalRecoverable");
    expect(alpha?.progressApprox).toBeNull();

    const beta = tree.find((e) => e.techId === TECH_BETA.id);
    expect(beta?.status).toBe("researching");
    expect(beta?.progressApprox).toBe(10);
    expect(beta?.prereqTechIds).toEqual([TECH_ALPHA.id]);
    expect(beta?.prereqsMet).toBe(false); // techAlpha はまだ解禁されていない
    // 単一キュー(research.ts §2)の先頭はID昇順の rBeta 1 本だけなので対象。
    expect(beta?.isCurrentResearchTarget).toBe(true);

    const gamma = tree.find((e) => e.techId === TECH_GAMMA.id);
    expect(gamma?.status).toBe("lostRecoverable");
    expect(gamma?.lossClass).toBe("criticalRecoverable");

    const rare = tree.find((e) => e.techId === TECH_RARE.id);
    expect(rare?.status).toBe("lostIrreversible");
    expect(rare?.lossClass).toBe("rareIrreversible");
    // (B) は currentResearch の対象から外れる(rules/research.ts の isIrreversiblyLost)。
    expect(rare?.isCurrentResearchTarget).toBe(false);
  });

  it("解禁済みは completed、前提を満たすと prereqsMet が true になる", () => {
    const testContent = researchTreeContent();
    const entities: EntityState[] = [
      resident("aTest"),
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
      research("rBeta", TECH_BETA.id, 0),
    ];
    const state = stateOf(entities, META);
    const store = createGameStore({ state, content: testContent });
    const tree = store.derived.researchTree.value;

    expect(tree.find((e) => e.techId === TECH_ALPHA.id)?.status).toBe("completed");
    expect(tree.find((e) => e.techId === TECH_BETA.id)?.prereqsMet).toBe(true);
  });

  it("表示順はエラ順×エラ内ID昇順(ID の辞書順そのままではない)", () => {
    const earlyIdButLateEra: TechDef = {
      id: id("techAAAEarlyIdButEra2"),
      researchCostFix: fixFromInt(10),
      eraId: "e2",
    };
    const lateIdButEarlyEra: TechDef = {
      id: id("techZZZLateIdButEra1"),
      researchCostFix: fixFromInt(10),
      eraId: "e1",
    };
    const eraE2: EraDef = {
      id: "e2",
      order: 2,
      baseEraFix: fixFromInt(60),
      multiplierFix: fixFromInt(2),
      gateTechId: earlyIdButLateEra.id,
      criticalPathMax: 1,
    };
    const testContent: EngineContent = {
      ...researchTreeContent(),
      techDefs: new Map([
        [earlyIdButLateEra.id, earlyIdButLateEra],
        [lateIdButEarlyEra.id, lateIdButEarlyEra],
      ]),
      eraDefs: new Map([
        [ERA_E1.id, { ...ERA_E1, gateTechId: lateIdButEarlyEra.id }],
        [eraE2.id, eraE2],
      ]),
    };
    const state = stateOf([resident("aTest")], META);
    const store = createGameStore({ state, content: testContent });
    const ids = store.derived.researchTree.value.map((e) => e.techId);
    // ID の辞書順なら techAAA... が先だが、エラ順(e1=order1 → e2=order2)が勝つ。
    expect(ids).toEqual([lateIdButEarlyEra.id, earlyIdButLateEra.id]);
  });
});

describe("[2026-08-02裁定・台帳v10 必-1] researchChip(ヘッダ研究チップ)", () => {
  it("研究中だが研究点産出施設が盤面に無ければ stalled=true(レートが流れていない)", () => {
    const testContent = researchTreeContent();
    const state = stateOf(
      [resident("aTest"), research("rBeta", TECH_BETA.id, 10)], // 10/50 → 20%
      META,
    );
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toEqual({
      techId: TECH_BETA.id,
      progressPercent: 20,
      stalled: true,
    });
  });

  // [2026-08-02差し戻し・台帳v10 必-1] 本命のケース: 台帳の眼目は
  // 「作業台(ここでは研究机)から人を外して研究が止まっていても気づけない」
  // ことなので、`currentResearch` は生きたまま(選択は失効していない)研究点
  // レートだけが 0 に落ちる状況を区別できることを固定する。
  it("研究机(研究点産出施設)に稼働就労者がいれば stalled=false", () => {
    const testContent = researchTreeContent();
    const state = stateOf(
      [
        resident("aScholar"),
        facility("fDesk", STUDY_DESK.id, 0, [id("aScholar")]),
        research("rBeta", TECH_BETA.id, 10),
      ],
      META,
    );
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toEqual({
      techId: TECH_BETA.id,
      progressPercent: 20,
      stalled: false,
    });
  });

  it("研究机はあるが稼働就労者が0人(作業台から人を外した)なら stalled=true", () => {
    const testContent = researchTreeContent();
    const state = stateOf(
      [
        facility("fDesk", STUDY_DESK.id, 0), // workerIds 省略 = 空(誰も配置していない)
        research("rBeta", TECH_BETA.id, 10),
      ],
      META,
    );
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toEqual({
      techId: TECH_BETA.id,
      progressPercent: 20,
      stalled: true,
    });
  });

  it("研究机の就労者が想起困難/派遣中で稼働していなければ stalled=true", () => {
    const testContent = researchTreeContent();
    const state = stateOf(
      [
        resident("aScholar", { dispatched: true }), // 稼働の定義(isWorkerActive)から外れる
        facility("fDesk", STUDY_DESK.id, 0, [id("aScholar")]),
        research("rBeta", TECH_BETA.id, 10),
      ],
      META,
    );
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value?.stalled).toBe(true);
  });

  it("floor であって四捨五入ではない(cost が 100 を割り切らない値で確認)", () => {
    const testContent = researchTreeContent(); // techAlpha: cost 30
    const state = stateOf([resident("aTest"), research("rAlpha", TECH_ALPHA.id, 29)], META);
    const store = createGameStore({ state, content: testContent });
    // 29/30 * 100 = 96.6666...。floor なら 96、四捨五入なら 97 になる。
    expect(store.derived.researchChip.value?.progressPercent).toBe(96);
  });

  it("完了 tick ちょうどの余剰進捗は 100% にクランプする(素の値は変えない)", () => {
    const testContent = researchTreeContent(); // techAlpha: cost 30
    const entities: EntityState[] = [
      resident("aTest"),
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(31), // 切り上げ由来の 1 tick 超過(research.ts の規約)
        completedTick: null,
      } satisfies ResearchState,
    ];
    const state = stateOf(entities, META);
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value?.progressPercent).toBe(100);
  });

  it("停止中: 未完了の research entity が 1 つも無ければ null", () => {
    const testContent = researchTreeContent();
    const state = stateOf([resident("aTest")], META);
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toBeNull();
  });

  it("停止中: 残っているのが完了済みだけでも null", () => {
    const testContent = researchTreeContent();
    const entities: EntityState[] = [
      resident("aTest"),
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
    ];
    const state = stateOf(entities, META);
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toBeNull();
  });

  it("停止中: (B) 一回性喪失した tech しか無ければ currentResearch の対象から外れて null", () => {
    const testContent = researchTreeContent();
    const entities: EntityState[] = [
      resident("aTest"),
      {
        kind: "research",
        id: id("rRare"),
        techId: TECH_RARE.id,
        progress: fixFromInt(0),
        completedTick: null,
        loss: { tick: 30, irreversible: true },
      } satisfies ResearchState,
    ];
    const state = stateOf(entities, META);
    const store = createGameStore({ state, content: testContent });
    expect(store.derived.researchChip.value).toBeNull();
  });
});

describe("[M31] codifyTechs(⑥成文化キュー対象・GDD 7.4/7.5/11.1追補)", () => {
  const HOLDER_A = id("holderA");
  const HOLDER_B = id("holderB");

  function codifyState(
    entities: readonly EntityState[],
    techMemory: readonly (readonly [string, TechMemoryState])[],
  ) {
    const base = stateOf(entities, META);
    return setTechMemories(base, techMemory);
  }

  it("解禁済みの tech だけを並べる(未解禁は対象外)", () => {
    const testContent = researchTreeContent();
    const state = stateOf(
      [
        resident("aTest"),
        research("rAlpha", TECH_ALPHA.id, 0), // 未解禁(completedTick null)
        {
          kind: "research",
          id: id("rBeta"),
          techId: TECH_BETA.id,
          progress: fixFromInt(50),
          completedTick: 10,
        } satisfies ResearchState,
      ],
      META,
    );
    const store = createGameStore({ state, content: testContent });
    const techIds = store.derived.codifyTechs.value.map((e) => e.techId);
    expect(techIds).toEqual([TECH_BETA.id]);
  });

  it("保持者数・唯一保持・記録済み媒体・作業中の記録を反映する", () => {
    const testContent = researchTreeContent();
    const entities: EntityState[] = [
      resident(HOLDER_A, { assignedFacilityId: null }),
      resident(HOLDER_B, { assignedFacilityId: null }),
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
      {
        kind: "research",
        id: id("rBeta"),
        techId: TECH_BETA.id,
        progress: fixFromInt(50),
        completedTick: 10,
      } satisfies ResearchState,
      // techBeta は完成済み記録(紙)+作業中の記録(石板)を両方持つ。
      {
        kind: "codify",
        id: id("cBetaPaper"),
        techId: TECH_BETA.id,
        medium: "paper",
        requiredWork: fixFromInt(20),
        progress: fixFromInt(20),
        completedTick: 8,
      },
      {
        kind: "codify",
        id: id("cBetaStone"),
        techId: TECH_BETA.id,
        medium: "stoneTablet",
        requiredWork: fixFromInt(40),
        progress: fixFromInt(0),
        completedTick: null,
      },
    ];
    const state = codifyState(entities, [
      [
        techMemoryKeyOf(HOLDER_A, TECH_ALPHA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
      [
        techMemoryKeyOf(HOLDER_A, TECH_BETA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
      [
        techMemoryKeyOf(HOLDER_B, TECH_BETA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
    ]);
    const store = createGameStore({ state, content: testContent });
    const techs = store.derived.codifyTechs.value;

    const alpha = techs.find((e) => e.techId === TECH_ALPHA.id);
    expect(alpha?.holderIds).toEqual([HOLDER_A]);
    expect(alpha?.uniqueHolder).toBe(true);
    expect(alpha?.isCodified).toBe(false);
    expect(alpha?.recordedMedia).toEqual([]);
    expect(alpha?.pendingRecords).toEqual([]);

    const beta = techs.find((e) => e.techId === TECH_BETA.id);
    expect(beta?.holderIds.slice().sort()).toEqual([HOLDER_A, HOLDER_B].sort());
    expect(beta?.uniqueHolder).toBe(false);
    expect(beta?.isCodified).toBe(true);
    expect(beta?.recordedMedia).toEqual(["paper"]);
    expect(beta?.pendingRecords).toHaveLength(1);
    expect(beta?.pendingRecords[0]?.medium).toBe("stoneTablet");
    expect(beta?.pendingRecords[0]?.progressApprox).toBe(0);
    expect(beta?.pendingRecords[0]?.requiredWorkApprox).toBe(40);
  });

  it("残存想定tick(GDD 7.5)は life を持つ保持者だけが対象。持たなければ無期限", () => {
    const testContent = researchTreeContent();
    const withLife: ResidentState = {
      ...resident(HOLDER_A),
      life: { bornTick: 0, lifespanTick: 500, diedTick: null },
    };
    const entities: EntityState[] = [
      withLife,
      resident(HOLDER_B), // life 無し
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
      {
        kind: "research",
        id: id("rGamma"),
        techId: TECH_GAMMA.id,
        progress: fixFromInt(20),
        completedTick: 3,
      } satisfies ResearchState,
    ];
    const state = codifyState(entities, [
      [
        techMemoryKeyOf(HOLDER_A, TECH_ALPHA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
      [
        techMemoryKeyOf(HOLDER_B, TECH_GAMMA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
    ]);
    const store = createGameStore({ state, content: testContent });
    const techs = store.derived.codifyTechs.value;

    const alpha = techs.find((e) => e.techId === TECH_ALPHA.id);
    expect(alpha?.hasDeadline).toBe(true);
    expect(alpha?.residualTick).toBe(500); // lifespanTick(500) - ageTick(0) at tick 0

    const gamma = techs.find((e) => e.techId === TECH_GAMMA.id);
    expect(gamma?.hasDeadline).toBe(false);
    expect(gamma?.residualTick).toBe(CODIFY_NO_DEADLINE_TICKS);
  });

  it("想起リスク(%)は engine の recallRiskPerDay と一致する(congruence)", () => {
    const testContent = researchTreeContent();
    const holder = resident(HOLDER_A, { morale: fixFromInt(50) });
    const entities: EntityState[] = [
      holder,
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
    ];
    const state = codifyState(entities, [
      [
        techMemoryKeyOf(HOLDER_A, TECH_ALPHA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
    ]);
    const store = createGameStore({ state, content: testContent });
    const alpha = store.derived.codifyTechs.value.find((e) => e.techId === TECH_ALPHA.id);
    const storedHolder = requireEntity(state, HOLDER_A, "resident");
    const expectedRiskPercent =
      toApproxNumber(recallRiskPerDay(state, testContent, storedHolder, TECH_ALPHA.id)) * 100;
    expect(alpha?.maxRecallRiskPercentApprox).toBe(expectedRiskPercent);
  });
});

const HOLDER_FOR_SUGGESTION = id("holderForSuggestion");

describe("[M31] codifySuggestions(おまかせ成文化の提案・GDD 2.1)", () => {
  it("content に recordMedia が無ければ空(例外を投げずに不活性・reclaimInfo と同じ作法)", () => {
    // 既定の boardContent() は recordMedia を持たない(tests/engine/fixtures.ts)。
    const { store } = createTestStore();
    expect(store.derived.codifySuggestions.value).toEqual([]);
  });

  it("engine の suggestCodification と一致する(congruence)", () => {
    const testContent = researchTreeContent();
    const holder = resident(HOLDER_FOR_SUGGESTION);
    const entities: EntityState[] = [
      holder,
      {
        kind: "research",
        id: id("rAlpha"),
        techId: TECH_ALPHA.id,
        progress: fixFromInt(30),
        completedTick: 5,
      } satisfies ResearchState,
      {
        kind: "research",
        id: id("rGamma"),
        techId: TECH_GAMMA.id,
        progress: fixFromInt(20),
        completedTick: 3,
      } satisfies ResearchState,
    ];
    const state = setTechMemories(stateOf(entities, META), [
      [
        techMemoryKeyOf(HOLDER_FOR_SUGGESTION, TECH_ALPHA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
      [
        techMemoryKeyOf(HOLDER_FOR_SUGGESTION, TECH_GAMMA.id),
        { masteryFix: fixFromInt(5), impairedUntilTick: 0 },
      ],
    ]);
    const store = createGameStore({ state, content: testContent });
    const viewSuggestions = store.derived.codifySuggestions.value;
    const expected = suggestCodification(state, testContent, state.tick);

    expect(viewSuggestions).toHaveLength(expected.suggestions.length);
    expect(viewSuggestions.length).toBeGreaterThan(0);
    for (let i = 0; i < expected.suggestions.length; i++) {
      const view = viewSuggestions[i];
      const suggestion = expected.suggestions[i];
      expect(view?.techId).toBe(suggestion?.techId);
      expect(view?.medium).toBe(suggestion?.medium);
      expect(view?.codifyId).toBe(suggestion?.codifyId);
      expect(view?.residualTick).toBe(suggestion?.residualTick);
      expect(view?.hasDeadline).toBe(suggestion?.residualTick !== CODIFY_NO_DEADLINE_TICKS);
      expect(view?.durationTicks).toBe(suggestion?.durationTicks);
      expect(view?.cumulativeTicks).toBe(suggestion?.cumulativeTicks);
      expect(view?.onSchedule).toBe(suggestion?.onSchedule);
    }
  });
});

// --- M32: ⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理 --------------------------

describe("[M32] expeditionCandidates(GDD 8.1 [2026-07-30裁定]②の事前除外)", () => {
  it("寿命あり・生存・非派遣中の住民だけが候補になる", () => {
    const alive = candidateResident("aAlive");
    const dispatchedResident = candidateResident("aDispatched", { dispatched: true });
    const noLife = resident("aNoLife");
    const dead = {
      ...candidateResident("aDead"),
      life: { bornTick: 0, lifespanTick: 100, diedTick: 50 },
    };
    const state = createGameState(META, [alive, dispatchedResident, noLife, dead]);
    const content = m32Content();
    const store = createGameStore({ state, content });
    const candidates = store.derived.expeditionCandidates.value;
    expect(candidates.map((c) => c.entityId)).toEqual([alive.id]);
    expect(candidates[0]?.combatPowerApprox).toBe(
      toApproxNumber(residentCombatPower(alive, content)),
    );
    expect(candidates[0]?.moraleApprox).toBe(toApproxNumber(alive.morale));
  });
});

describe("[M32] expeditionDispatches / expeditionSlots(GDD 8.1「派遣枠上限＝同時2枠」)", () => {
  function snapshotOf(
    name: string,
    band: "near" | "far" | "deep",
    memberIds: readonly EntityId[],
  ): DispatchSnapshot {
    return {
      id: id(name),
      destinationId: id(`${name}Dest`),
      band,
      stance: "cautious",
      memberIds,
      dispatchTick: 0,
      returnTick: 60,
      teamPowerFix: fixFromInt(100),
      nodes: [],
      withdrawn: false,
      rewardFix: fixFromInt(30),
      rewardResourceId: M32_REWARD_RESOURCE,
      casualtyMemberIds: [],
    };
  }

  it("state.dispatchSnapshots をそのまま写す・派遣枠は使用数/上限2", () => {
    const alive = candidateResident("aTeam", { dispatched: true });
    const state = createGameState(
      META,
      [alive],
      [],
      [],
      [],
      [snapshotOf("dispatchNear1", "near", [alive.id]), snapshotOf("dispatchFar1", "far", [])],
    );
    const store = createGameStore({ state, content: m32Content() });
    const dispatches = store.derived.expeditionDispatches.value;
    expect(dispatches.map((d) => d.dispatchId)).toEqual([id("dispatchFar1"), id("dispatchNear1")]);
    expect(dispatches[1]?.memberIds).toEqual([alive.id]);
    expect(dispatches[1]?.rewardApprox).toBe(30);

    const slots = store.derived.expeditionSlots.value;
    expect(slots).toEqual({ used: 2, max: 2 });
  });

  it("未帰還派遣が無ければ 0/2", () => {
    const { store } = createTestStore();
    expect(store.derived.expeditionSlots.value).toEqual({ used: 0, max: 2 });
  });
});

describe("[M32] memoirFeed(GDD 7.3・tick 昇順に平坦化)", () => {
  it("複数住民の memoir を tick 昇順(同値は住民ID昇順)へ並べる", () => {
    const first: ReturnType<typeof resident> = {
      ...resident("aFirst"),
      memoir: {
        entries: [
          { kind: "arrival", tick: 10 },
          { kind: "bondMilestone", tick: 30, partnerId: id("aSecond"), tier: 1 },
        ],
        foldedCount: 0,
      },
    };
    const second: ReturnType<typeof resident> = {
      ...resident("aSecond"),
      memoir: {
        entries: [
          { kind: "explorationRescue", tick: 20, rescuedId: id("aRescued"), band: "near" },
          { kind: "arrival", tick: 10 },
        ],
        foldedCount: 0,
      },
    };
    const state = createGameState(META, [first, second]);
    const store = createGameStore({ state, content: m32Content() });
    const feed = store.derived.memoirFeed.value;
    expect(feed.map((entry) => [entry.residentId, entry.entry.tick, entry.entry.kind])).toEqual([
      [id("aFirst"), 10, "arrival"],
      [id("aSecond"), 10, "arrival"],
      [id("aSecond"), 20, "explorationRescue"],
      [id("aFirst"), 30, "bondMilestone"],
    ]);
  });
});

describe("[M32] renderedLog(GDD 8.4・帰還ログのそのままの写し)", () => {
  it("state.renderedLogs を 1 バイトも変えずに公開する", () => {
    const state = createGameState(META, [], [], [], [], [], {
      entries: [{ tick: 5, text: "近郊探索「x」より1名が帰還。" }],
      foldedCount: 3,
    });
    const store = createGameStore({ state, content: m32Content() });
    expect(store.derived.renderedLog.value).toEqual(state.renderedLogs);
  });
});

describe("[M32] outpostOverview(GDD 9.2 / 11.4-7・outpostNetworkRoi をそのまま呼ぶ)", () => {
  it("engine の outpostRoi/outpostNetworkRoi と 1 対 1 で一致する(congruence)", () => {
    const stationed = candidateResident("aStation");
    const outpost = outpostOf("outpost1", "near", [stationed.id]);
    const state = createGameState(META, [stationed], [], [], [], [], undefined, [outpost]);
    const content = m32Content();
    const store = createGameStore({ state, content });

    const expectedReport = outpostRoi(state, content, outpost, state.tick);
    const overview = store.derived.outpostOverview.value;
    const view = overview.roster.find((entry) => entry.outpostId === outpost.id);
    expect(view).toBeDefined();
    expect(view?.resourceId).toBe(M32_OUTPOST_TYPE.resourceId);
    expect(view?.supplyApprox).toBe(toApproxNumber(expectedReport.supplyValueFix));
    expect(view?.upkeepApprox).toBe(toApproxNumber(expectedReport.upkeepValueFix));
    expect(view?.hazardApprox).toBe(toApproxNumber(expectedReport.hazardFix));
    expect(view?.rareAssetCount).toBe(expectedReport.rareAssetCount);
    expect(view?.expectedRareLossApprox).toBe(toApproxNumber(expectedReport.expectedRareLossFix));
    expect(view?.roiApprox).toBe(
      expectedReport.roiFix === null ? null : toApproxNumber(expectedReport.roiFix),
    );

    const expectedNetwork = outpostNetworkRoi(state, content, state.tick);
    expect(overview.network.outpostCount).toBe(expectedNetwork.outpostCount);
    expect(overview.network.totalSupplyApprox).toBe(
      toApproxNumber(expectedNetwork.totalSupplyValueFix),
    );
    expect(overview.network.roiApprox).toBe(
      expectedNetwork.roiFix === null ? null : toApproxNumber(expectedNetwork.roiFix),
    );
  });

  it("拠点が無ければ全フィールドが 0/null(content に拠点ブロックが無い盤面でも落ちない)", () => {
    const { store } = createTestStore();
    const overview = store.derived.outpostOverview.value;
    expect(overview.network).toEqual({
      outpostCount: 0,
      totalSupplyApprox: 0,
      totalUpkeepApprox: 0,
      totalNetRevenueApprox: 0,
      totalExpectedRareLossApprox: 0,
      roiApprox: null,
    });
    expect(overview.roster).toEqual([]);
  });
});

describe("[M32] explorationDestinationsForBand(GDD 8.1「目的地」+ M22 event content)", () => {
  it("destTags がその距離帯を含む event だけを ID 昇順で返す", () => {
    const nearEvent: EventDef = { id: id("eventNearA"), destTags: ["near"], nodes: [] };
    const bothEvent: EventDef = { id: id("eventBothB"), destTags: ["near", "far"], nodes: [] };
    const farOnlyEvent: EventDef = { id: id("eventFarOnly"), destTags: ["far"], nodes: [] };
    const content: EngineContent = {
      ...m32Content(),
      eventDefs: new Map([
        [nearEvent.id, nearEvent],
        [bothEvent.id, bothEvent],
        [farOnlyEvent.id, farOnlyEvent],
      ]),
    };
    expect(explorationDestinationsForBand(content, "near")).toEqual([bothEvent.id, nearEvent.id]);
    expect(explorationDestinationsForBand(content, "deep")).toEqual([]);
  });

  it("content に eventDefs が無ければ空(= 手続き生成フォールバック)", () => {
    expect(explorationDestinationsForBand(m32Content(), "near")).toEqual([]);
  });
});

describe("[M32] previewExplorationRoi(GDD 8.6・explorationRoi をそのまま呼ぶ)", () => {
  it("content に exploration ブロックが無ければ null", () => {
    const { store } = createTestStore();
    expect(previewExplorationRoi(store.peekState(), boardContent(), "near", [])).toBeNull();
  });

  it("engine の explorationRoi と 1 対 1 で一致する(congruence・(B)損失項を含む)", () => {
    const member = candidateResident("aMember");
    const state = createGameState(META, [member, resource("wStock", M32_REWARD_RESOURCE)]);
    const content = m32Content();
    const expected = explorationRoi(state, content, "near", [member.id]);
    const actual = previewExplorationRoi(state, content, "near", [member.id]);
    expect(actual).toEqual(expected);
    expect(toRaw(expected.expectedRareLossFix)).toBeGreaterThanOrEqual(0);
  });
});
