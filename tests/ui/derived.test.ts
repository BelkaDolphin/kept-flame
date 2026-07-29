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
import { toRaw } from "../../src/engine/fp";
import { entitiesOfKind, requireEntity } from "../../src/engine/state/state";
import { putEntity, removeEntity, setField, updateEntity } from "../../src/engine/state/update";
import {
  CELL_CENTER,
  CELL_EAST,
  CELL_FAR,
  CELL_SOUTHEAST,
  CELL_WEST,
  HEARTH,
  STUDY_DESK,
  at,
  changedCells,
  createTestStore,
  facility,
  id,
  neighborhoodOf,
  primeAllCells,
  recomputeCounts,
} from "./fixtures";

describe("fan-in 上界: 1 セル編集の再計算は自セル + 8 近傍に限定される(ADR-002(2))", () => {
  it("施設を 1 基置くと、隣接 computed が再計算されるのは近傍の占有セルだけ", () => {
    const { store, state } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 施設設置" });
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
    const { store, state } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 施設設置" });
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
    const { store, state } = createTestStore();
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellView);

    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 施設設置" });
    primeAllCells(store);

    expect(changedCells(before, recomputeCounts(store.derived.cellView))).toEqual([
      CELL_CENTER,
      CELL_EAST,
      CELL_SOUTHEAST,
    ]);
  });

  it("施設の撤去も同じ上界に収まる", () => {
    const { store, state } = createTestStore([facility("fSouth", HEARTH.id, CELL_SOUTHEAST)]);
    primeAllCells(store);
    const before = recomputeCounts(store.derived.cellAdjacency);

    const next = removeEntity(state, id("fSouth"));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 施設撤去" });
    primeAllCells(store);

    expect(changedCells(before, recomputeCounts(store.derived.cellAdjacency))).toEqual([
      CELL_CENTER,
      CELL_EAST,
      CELL_SOUTHEAST,
    ]);
  });

  it("Lv 変更(配置は不変)では近傍の隣接 computed が 1 個も再計算されない", () => {
    const { store, state } = createTestStore();
    primeAllCells(store);
    const beforeAdjacency = recomputeCounts(store.derived.cellAdjacency);
    const beforeView = recomputeCounts(store.derived.cellView);

    const next = updateEntity(state, id("fHearth"), "facility", (f) => setField(f, "level", 2));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 増築" });
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
    const { store, state } = createTestStore([facility("fSouth", HEARTH.id, CELL_SOUTHEAST)]);
    primeAllCells(store);
    const beforeAdjacency = recomputeCounts(store.derived.cellAdjacency);
    const beforeView = recomputeCounts(store.derived.cellView);

    const next = putEntity(
      removeEntity(state, id("fSouth")),
      facility("fSouth2", HEARTH.id, CELL_SOUTHEAST),
    );
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 同タグ施設へ差し替え" });
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
    // 表示モデルは「隣接結果 + 自セルの施設 + 自セルの配置」の 3 本。
    expect(at(store.derived.cellView, CELL_CENTER).dependencyCount).toBe(3);
  });
});

describe("隣接値そのもの(engine と同じ 1 実装であること)", () => {
  it("熱源が隣り合うと +20%、3 つ目からは過密ペナルティ(GDD 6.2/6.3)", () => {
    const { store, state } = createTestStore();
    // 初期状態: セル 14 の熱源近傍は 15 の 1 基だけ。
    expect(toRaw(at(store.derived.cellView, CELL_CENTER).value.multiplierFix)).toBe(1_200_000);

    // 近傍を 2 基へ: まだ threshold(3)未満なので加算のみ。
    const two = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: two, reason: "test: 近傍 2 基" });
    expect(toRaw(at(store.derived.cellView, CELL_CENTER).value.multiplierFix)).toBe(1_400_000);
    expect(at(store.derived.cellView, CELL_CENTER).value.overcrowded).toBe(false);

    // 3 基目で過密: ボーナスは先頭 2 件のみ有効、超過 1 件につき -10%。
    const three = putEntity(two, facility("fWest", HEARTH.id, CELL_WEST));
    store.dispatch({ type: "stateApplied", state: three, reason: "test: 近傍 3 基" });
    const view = at(store.derived.cellView, CELL_CENTER).value;
    expect(toRaw(view.multiplierFix)).toBe(1_300_000);
    expect(view.overcrowdedNeighborCount).toBe(1);
    expect(view.overcrowded).toBe(true);
  });

  it("UI の乗数と engine の multiplierByFacilityId が一致する(単一正準実装)", () => {
    const { store, state } = createTestStore([
      facility("fSouth", HEARTH.id, CELL_SOUTHEAST),
      facility("fWest", STUDY_DESK.id, CELL_WEST),
    ]);
    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 盤面確定" });

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
    expect(summary.overcrowdedCellCount).toBeGreaterThan(0);
  });

  it("全体集計を購読してもセル表示の再計算回数は増えない", () => {
    const { store, state } = createTestStore();
    primeAllCells(store);
    void store.derived.gridSummary.value;
    const beforeView = recomputeCounts(store.derived.cellView);
    const summaryBefore = store.derived.gridSummary.recomputeCount;

    // 遠方セルの近傍(41)へ 1 基置く。
    const next = putEntity(state, facility("fFarEast", HEARTH.id, 41));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 遠方へ設置" });
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
    const { store, state } = createTestStore();
    const next = updateEntity(state, id("aRui"), "resident", (r) =>
      setField(r, "recallImpairedUntilTick", 100),
    );
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 想起困難" });
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
    const { store, state } = createTestStore();
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
    const next = putEntity(state, facility("fSouth", HEARTH.id, CELL_SOUTHEAST));
    store.dispatch({ type: "stateApplied", state: next, reason: "test: 施設設置" });

    expect(at(store.derived.cellView, CELL_CENTER).recomputeCount).toBe(before + 1);
    expect(gridRenders).toBe(2);
    expect(detailRenders).toBe(2);

    gridMount.dispose();
    detailMount.dispose();
  });
});
