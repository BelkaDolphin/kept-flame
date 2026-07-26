// ---------------------------------------------------------------------------
// T10: 4区間ベンチのロジック部テスト。
// 計測そのもの(performance.now を取る場所)はブラウザ実行なのでここでは扱わず、
// 純関数(中央値・要約・判定・結果JSON組立)と代表盤面/view model を固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  buildPaddedPerfBoard,
  buildPerfBoard,
  loadPerfContent,
  PERF_FACILITY_COUNT,
  PERF_FACILITY_PLACEMENT,
  PERF_RESIDENT_COUNT,
  PERF_WORLD_SEED,
} from "../../bench/perfBoard";
import { buildGridViewModel, DOM_NODES_PER_CELL, EXPECTED_DOM_NODES } from "../../bench/perfGrid";
import {
  BUDGET_MS,
  buildPerfResult,
  INTERVAL_IDS,
  judgeIntervals,
  median,
  PerfStatsError,
  PROVISIONAL_DEVICE_K,
  roundMs,
  summarizeAllIntervals,
  summarizeInterval,
  trialTotalsMs,
  verdictOf,
  type PerfMeta,
  type TrialSample,
} from "../../bench/perfStats";

import { createAdvanceContext } from "../../src/engine/advance";
import { GRID_CELL_COUNT } from "../../src/engine/adjacency";
import { toSerializable } from "../../src/engine/state/serialize";

// --- 1. 中央値・丸め --------------------------------------------------------

describe("median", () => {
  it("奇数個は中央の値", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("偶数個は中央2値の平均", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("1 個なら自分自身", () => {
    expect(median([7.5])).toBe(7.5);
  });

  it("入力配列を破壊しない", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("空配列は PerfStatsError", () => {
    expect(() => median([])).toThrow(PerfStatsError);
  });

  it("非有限値は PerfStatsError", () => {
    expect(() => median([1, Number.NaN, 3])).toThrow(PerfStatsError);
  });
});

describe("roundMs", () => {
  it("小数第3位へ丸める", () => {
    expect(roundMs(1.23456)).toBe(1.235);
    expect(roundMs(0.0004)).toBe(0);
  });

  it("非有限値は PerfStatsError", () => {
    expect(() => roundMs(Number.POSITIVE_INFINITY)).toThrow(PerfStatsError);
  });
});

// --- 2. 試行の要約 ----------------------------------------------------------

function sample(trial: number, warmup: boolean, base: number): TrialSample {
  return {
    trial,
    warmup,
    intervalMs: {
      restore: base,
      compute: base * 10,
      hydrate: base / 2,
      mount: base / 4,
    },
    subIntervalMs: {
      "restore.idbGet": base * 0.5,
      "restore.parse": base * 0.3,
      "restore.deserialize": base * 0.2,
      "compute.advance": base * 10,
    },
  };
}

const SAMPLES: readonly TrialSample[] = [
  sample(-1, true, 100), // ウォームアップ(中央値に入らない)
  sample(0, false, 1),
  sample(1, false, 2),
  sample(2, false, 3),
];

describe("summarizeInterval", () => {
  it("ウォームアップを中央値から除き warmupMs へ分離する", () => {
    const summary = summarizeInterval(SAMPLES, "restore");
    expect(summary.medianMs).toBe(2);
    expect(summary.warmupMs).toBe(100);
    expect(summary.minMs).toBe(1);
    expect(summary.maxMs).toBe(3);
    expect(summary.meanMs).toBe(2);
    expect(summary.rawMs).toEqual([1, 2, 3]);
  });

  it("下位区間は自分の区間の prefix のものだけを拾う", () => {
    const summary = summarizeInterval(SAMPLES, "restore");
    expect(Object.keys(summary.subIntervalMedianMs).sort()).toEqual([
      "deserialize",
      "idbGet",
      "parse",
    ]);
    // 下位区間の中央値の和は親の中央値と一致する(R7: 親を厳密分割)。
    const sum = Object.values(summary.subIntervalMedianMs).reduce((a, b) => a + b, 0);
    expect(roundMs(sum)).toBe(summary.medianMs);
  });

  it("計測試行が無ければ PerfStatsError", () => {
    expect(() => summarizeInterval([sample(-1, true, 1)], "restore")).toThrow(PerfStatsError);
  });
});

describe("summarizeAllIntervals / trialTotalsMs", () => {
  it("4区間すべてを返す", () => {
    const all = summarizeAllIntervals(SAMPLES);
    expect(Object.keys(all).sort()).toEqual(["compute", "hydrate", "mount", "restore"]);
  });

  it("試行ごとの合計はウォームアップを含まない", () => {
    expect(trialTotalsMs(SAMPLES)).toEqual([11.75, 23.5, 35.25]);
  });
});

// --- 3. 予算判定 ------------------------------------------------------------

describe("verdictOf", () => {
  it("等号は pass", () => {
    expect(verdictOf(1100, 1100)).toBe("pass");
  });

  it("超過は fail", () => {
    expect(verdictOf(1100.001, 1100)).toBe("fail");
  });
});

describe("judgeIntervals", () => {
  const summaries = summarizeAllIntervals(SAMPLES);

  it("factor=1 は素値判定", () => {
    const judged = judgeIntervals(summaries, 23.5, 1);
    expect(judged.perInterval.compute.observedMs).toBe(20);
    expect(judged.perInterval.compute.budgetMs).toBe(BUDGET_MS.compute);
    expect(judged.perInterval.compute.verdict).toBe("pass");
    expect(judged.totalMs).toBe(23.5);
    expect(judged.totalVerdict).toBe("pass");
  });

  it("factor を掛けると超過しうる", () => {
    const judged = judgeIntervals(summaries, 23.5, 200);
    expect(judged.perInterval.compute.observedMs).toBe(4000);
    expect(judged.perInterval.compute.verdict).toBe("fail");
    expect(judged.totalVerdict).toBe("fail");
  });

  it("sumOfMediansMs(区間別中央値の和)と totalMs(合計の中央値)は別定義", () => {
    // 区間ごとに遅い試行がずれていると両者は一致しない。
    const skewed: readonly TrialSample[] = [
      { ...sample(0, false, 1), intervalMs: { restore: 10, compute: 1, hydrate: 1, mount: 1 } },
      { ...sample(1, false, 1), intervalMs: { restore: 1, compute: 10, hydrate: 1, mount: 1 } },
      { ...sample(2, false, 1), intervalMs: { restore: 1, compute: 1, hydrate: 1, mount: 1 } },
    ];
    const skewedSummaries = summarizeAllIntervals(skewed);
    const totalMedian = median(trialTotalsMs(skewed));
    expect(trialTotalsMs(skewed)).toEqual([13, 13, 4]);
    expect(totalMedian).toBe(13);

    const judged = judgeIntervals(skewedSummaries, totalMedian, 1);
    expect(judged.sumOfMediansMs).toBe(4);
    expect(judged.totalMs).toBe(13);
    expect(judged.sumOfMediansMs).not.toBe(judged.totalMs);
  });

  it("factor が正の有限値でなければ PerfStatsError", () => {
    expect(() => judgeIntervals(summaries, 1, 0)).toThrow(PerfStatsError);
    expect(() => judgeIntervals(summaries, 1, Number.NaN)).toThrow(PerfStatsError);
  });
});

// --- 4. 結果 JSON -----------------------------------------------------------

const META: PerfMeta = {
  generatedAt: "2026-07-26T00:00:00.000Z",
  userAgent: "test",
  hardwareConcurrency: 8,
  deviceMemoryGb: null,
  devicePixelRatio: 1,
  viewportCss: { widthPx: 1280, heightPx: 800 },
  crossOriginIsolated: false,
  timeOriginMs: 0,
};

function buildResult(observedDomNodeCount = EXPECTED_DOM_NODES) {
  return buildPerfResult({
    meta: META,
    workload: {
      worldSeed: PERF_WORLD_SEED,
      startTick: 0,
      targetTick: 4320,
      coarseTickMinutes: 10,
      residentCount: PERF_RESIDENT_COUNT,
      facilityCount: PERF_FACILITY_COUNT,
      researchCount: 3,
      entityCount: 37,
      gridCells: GRID_CELL_COUNT,
      domNodesPerCell: DOM_NODES_PER_CELL,
      expectedDomNodes: EXPECTED_DOM_NODES,
      saveBytes: 1234,
      measuredTrials: 3,
      warmupTrials: 1,
    },
    engineCounters: {
      segmentCount: 1,
      stochasticStepCount: 432,
      stochasticTrialCount: 25_920,
      rateChangeEventCount: 0,
      recallOccurrenceCount: 0,
    },
    samples: SAMPLES,
    supplementary: {
      contentLoadMs: 1,
      contentJsonParseMs: 0,
      boardBuildMs: 1,
      idbOpenMs: 1,
      idbPutMs: 1,
      unmountMedianMs: 1,
      restoreWithOpenMs: 3,
    },
    sensitivity: { restoreAtTargetSaveBytes: null },
    observedDomNodeCount,
  });
}

describe("buildPerfResult", () => {
  it("非決定値は meta だけに置かれる(決定論部と混ざらない)", () => {
    const result = buildResult();
    const withoutMeta = JSON.stringify({
      workload: result.workload,
      budgets: result.budgets,
      intervals: result.intervals,
      supplementary: result.supplementary,
      sensitivity: result.sensitivity,
      observed: result.observed,
      judgement: result.judgement,
      engineCounters: result.engineCounters,
    });
    expect(withoutMeta).not.toContain(META.generatedAt);
    expect(withoutMeta).not.toContain(META.userAgent);
    expect(result.meta.generatedAt).toBe(META.generatedAt);
  });

  it("公式判定ではないことを機械可読で残す", () => {
    const result = buildResult();
    expect(result.judgement.isOfficialVerdict).toBe(false);
    expect(result.judgement.provisionalDeviceK).toBe(PROVISIONAL_DEVICE_K);
    expect(result.judgement.note).toContain("K=5");
  });

  it("DOM 実測数が期待とズレたら機械可読で落ちる", () => {
    expect(buildResult().observed.domNodeCountMatchesExpected).toBe(true);
    expect(buildResult(239).observed.domNodeCountMatchesExpected).toBe(false);
  });

  it("B3 の忠実度を placeholder と明示する", () => {
    expect(buildResult().intervals.hydrateFidelity).toBe("placeholder");
  });

  it("4区間の予算の和が ADR-012(4) の合計と一致する", () => {
    const sum = INTERVAL_IDS.reduce((acc, id) => acc + BUDGET_MS[id], 0);
    expect(sum).toBe(BUDGET_MS.total);
  });
});

// --- 5. 代表盤面と view model ----------------------------------------------

describe("代表盤面 (bench/perfBoard.ts)", () => {
  const content = loadPerfContent();
  const board = buildPerfBoard(content);

  it("住民20 / 施設12 / 研究3 / 資源2 = entity 37", () => {
    const kinds = [...board.entityStateById.values()].reduce<Record<string, number>>(
      (acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }),
      {},
    );
    expect(kinds["resident"]).toBe(PERF_RESIDENT_COUNT);
    expect(kinds["facility"]).toBe(PERF_FACILITY_COUNT);
    expect(kinds["research"]).toBe(3);
    expect(kinds["resource"]).toBe(2);
    expect(board.entityStateById.size).toBe(37);
  });

  it("施設のセルは重複せず格子内に収まる", () => {
    const cells = PERF_FACILITY_PLACEMENT.map((p) => p.cellIndex);
    expect(new Set(cells).size).toBe(cells.length);
    for (const cell of cells) {
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(GRID_CELL_COUNT);
    }
  });

  it("全住民が施設へ配属され workerIds は ID 昇順", () => {
    let assigned = 0;
    for (const entity of board.entityStateById.values()) {
      if (entity.kind === "resident") {
        expect(entity.assignedFacilityId).not.toBeNull();
        assigned++;
      }
      if (entity.kind === "facility") {
        expect([...entity.workerIds]).toEqual([...entity.workerIds].sort());
      }
    }
    expect(assigned).toBe(PERF_RESIDENT_COUNT);
  });

  it("合成セーブは目標バイト数に達する", () => {
    const measure = (state: Parameters<typeof toSerializable>[0]): number =>
      JSON.stringify(toSerializable(state)).length;
    const target = 64 * 1024;
    const padded = buildPaddedPerfBoard(content, target, measure);
    expect(measure(padded)).toBeGreaterThanOrEqual(target);
    expect(padded.entityStateById.size).toBeGreaterThan(board.entityStateById.size);
  });
});

describe("buildGridViewModel (B3 の本体)", () => {
  const content = loadPerfContent();
  const board = buildPerfBoard(content);
  const ctx = createAdvanceContext(board, content);
  const vm = buildGridViewModel(board, content, ctx);

  it("48 セルぶんの view model を返す", () => {
    expect(vm.cells.length).toBe(GRID_CELL_COUNT);
    expect(GRID_CELL_COUNT * DOM_NODES_PER_CELL).toBe(EXPECTED_DOM_NODES);
    expect(EXPECTED_DOM_NODES).toBe(240);
  });

  it("施設が建っているセルだけ occupied", () => {
    expect(vm.cells.filter((c) => c.occupied).length).toBe(PERF_FACILITY_COUNT);
  });

  it("空セルも 5 要素ぶんのテキストを持つ(ノード数を配置非依存にする)", () => {
    for (const cell of vm.cells) {
      expect(cell.glyph.length).toBeGreaterThan(0);
      expect(cell.tagLabel.length).toBeGreaterThan(0);
      expect(cell.valueText.length).toBeGreaterThan(0);
      expect(cell.badgeText.length).toBeGreaterThan(0);
    }
  });

  it("サマリは state から導出される", () => {
    expect(vm.summary.residentCount).toBe(PERF_RESIDENT_COUNT);
    expect(vm.summary.facilityCount).toBe(PERF_FACILITY_COUNT);
    expect(vm.summary.dispatchedCount).toBe(6); // 派遣中パターン 3 種 × 2 人
    expect(vm.summary.tick).toBe(0);
  });
});
