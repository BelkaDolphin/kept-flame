// ---------------------------------------------------------------------------
// #1 ベンチの実ブラウザスモーク(Chromium 1 エンジン)— T11
//
// vitest では回せない部分だけを確かめる:
//   - `src/platform/worker.ts` が実 Worker として起動し、catch-up が往復する
//   - `src/platform/persistence.ts` が実 IndexedDB へ書いて読み戻せる
//     (integrityChecksum 検証込み)
//   - 結果 JSON に B1/B2 の新しい内訳と `workerLifecycle` が載る
//
// **性能値の合否は見ない**(デスクトップ実測は実機の下限見積りにしかならない
// = docs/design/perf-boundaries.md §0)。見るのは「経路が通ったか」と
// 「境界の下位区間が親を過不足なく分割しているか(§2 R7)」だけ。
// ---------------------------------------------------------------------------

import { expect, test } from "@playwright/test";

/** 結果 JSON のうち本スモークが読む部分(bench/perfStats.ts の PerfResult 部分形)。 */
interface SmokeResult {
  readonly $schema: string;
  readonly workload: {
    readonly targetTick: number;
    readonly expectedDomNodes: number;
    readonly integrityChecksum?: number;
  };
  readonly engineCounters: {
    readonly stochasticStepCount: number;
    readonly stochasticTrialCount: number;
  };
  readonly intervals: {
    readonly [key: string]: unknown;
    readonly hydrateFidelity: string;
    readonly computeFidelity: string;
    readonly restoreFidelity: string;
  };
  readonly supplementary: { readonly idbOpenMs: number; readonly idbOpenWarmMs?: number };
  readonly sensitivity: {
    readonly computeOnMainThread?: { readonly summary: { readonly medianMs: number } };
  };
  readonly observed: {
    readonly domNodeCount: number;
    readonly domNodeCountMatchesExpected: boolean;
  };
  readonly worker: {
    readonly lifecycle: string;
    readonly updateStrategy: string;
    readonly route: string;
    readonly bootMs: number;
    readonly contentTransferMs: number;
    readonly computeWorkerMedianMs: number;
    readonly snapshotEntityCount: number;
  } | null;
}

interface IntervalSummaryLike {
  readonly medianMs: number;
  readonly subIntervalMedianMs: { readonly [name: string]: number };
}

function summaryOf(result: SmokeResult, id: string): IntervalSummaryLike {
  return result.intervals[id] as IntervalSummaryLike;
}

test("bench/perf.html が Worker + persistence 経路で最後まで走り結果 JSON を出す", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/perf.html?autorun=1");
  await page.waitForFunction(
    () => (window as unknown as { __PERF_DONE__?: boolean }).__PERF_DONE__ === true,
    undefined,
    {
      timeout: 150_000,
    },
  );

  const error = await page.evaluate(
    () => (window as unknown as { __PERF_ERROR__?: string }).__PERF_ERROR__ ?? null,
  );
  expect(error, "ベンチがエラーで終わっている").toBeNull();
  expect(consoleErrors, "ページ内で未捕捉例外が出ている").toEqual([]);

  const result = (await page.evaluate(
    () => (window as unknown as { __PERF_RESULT__: unknown }).__PERF_RESULT__,
  )) as SmokeResult;

  // --- 結果フォーマット ---
  expect(result.$schema).toBe("kept-flame/bench/perf-boundaries/2");
  expect(result.intervals.hydrateFidelity).toBe("placeholder");
  expect(result.intervals.restoreFidelity).toBe("persistence");
  expect(result.intervals.computeFidelity).toBe("worker-structural-sharing");

  // --- ワークロードが設計どおりか(engine の自己申告カウンタ) ---
  expect(result.workload.targetTick).toBe(4320);
  expect(result.engineCounters.stochasticStepCount).toBe(432);
  expect(result.engineCounters.stochasticTrialCount).toBe(25_920);
  expect(result.observed.domNodeCountMatchesExpected).toBe(true);
  expect(result.observed.domNodeCount).toBe(result.workload.expectedDomNodes);

  // --- B2: persistence 経路(checksum が実際に検証されている) ---
  const restore = summaryOf(result, "restore");
  expect(typeof result.workload.integrityChecksum).toBe("number");
  expect(Object.keys(restore.subIntervalMedianMs).sort()).toEqual([
    "callOverhead",
    "checksum",
    "deserialize",
    "idbGet",
    "parse",
  ]);
  expect(restore.medianMs).toBeGreaterThan(0);
  expect(result.supplementary.idbOpenMs).toBeGreaterThan(0);
  expect(typeof result.supplementary.idbOpenWarmMs).toBe("number");

  // --- B1: Worker 経路(往復込み) ---
  const worker = result.worker;
  expect(worker, "Worker レポートが出ていない").not.toBeNull();
  if (worker === null) return;
  expect(worker.lifecycle).toBe("preboot");
  expect(worker.updateStrategy).toBe("structural-sharing");
  expect(worker.route).toBe("worker-draft-snapshot");
  expect(worker.bootMs).toBeGreaterThan(0);
  expect(worker.contentTransferMs).toBeGreaterThan(0);
  expect(worker.computeWorkerMedianMs).toBeGreaterThan(0);
  // スナップショットが壊れずに転送されている(代表盤面の entity 37 個)。
  expect(worker.snapshotEntityCount).toBe(37);

  const compute = summaryOf(result, "compute");
  expect(Object.keys(compute.subIntervalMedianMs).sort()).toEqual([
    "requestPost",
    "transport",
    "workerAdvance",
    "workerContextBuild",
    "workerOther",
    "workerSnapshot",
  ]);
  expect(compute.medianMs).toBeGreaterThan(0);
  // Worker 内の計算だけで往復全体を説明できてはいけない(転送コストが存在する)。
  expect(compute.medianMs).toBeGreaterThanOrEqual(worker.computeWorkerMedianMs);

  // --- 比較用のメインスレッド経路(ADR-026(3))も出ている ---
  expect(result.sensitivity.computeOnMainThread?.summary.medianMs).toBeGreaterThan(0);
});
