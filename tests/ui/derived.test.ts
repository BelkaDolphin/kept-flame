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
import { setField, updateEntity } from "../../src/engine/state/update";
import { computePlacementPreview } from "../../src/ui/derived";
import {
  CELL_CENTER,
  CELL_EAST,
  CELL_FAR,
  CELL_SOUTHEAST,
  CELL_WEST,
  HEARTH,
  STUDY_DESK,
  at,
  boardContent,
  changedCells,
  createTestStore,
  facility,
  id,
  neighborhoodOf,
  placeHearth,
  primeAllCells,
  recomputeCounts,
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
    // 表示モデルは「隣接結果 + 自セルの施設 + 自セルの配置」の 3 本。
    expect(at(store.derived.cellView, CELL_CENTER).dependencyCount).toBe(3);
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
    expect(summary.overcrowdedCellCount).toBeGreaterThan(0);
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
    expect(summary.overcrowdedCellCount).toBe(3);
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
