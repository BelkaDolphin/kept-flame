// ---------------------------------------------------------------------------
// GridBoard 実 DOM マウント計測 — M19(M18 申し送り★2への回答)
//
// 境界の取り方は `docs/design/perf-boundaries.md` §3 B4(mount)にそのまま従う:
//   開始点: render(rootVnode, container) の呼び出し直前
//   終了点: 生成済みサブツリーに対して同期レイアウトを強制した直後
//   下位区間: renderMs(render() が返るまで)/ layoutMs(強制同期レイアウト)
//
// B4 の予算は ADR-029 の 200ms。**このページで測るのは簡易代理モデル
// (`bench/perfGrid.tsx`)ではなく実際の `src/ui/screens/grid/GridBoard.tsx`
// (M17/M18/M19本体・4重符号化・過密バッジ込み)そのもの**——M18 完了報告が
// 「bench/変更禁止の制約で代理指標のみ」と正直に開示していた欠落を埋める
// (ロードマップ M18 行 / MEMORY.md 該当エントリ参照)。
//
// cold/warm の扱いは perf-boundaries.md §2 と同じ流儀:
// ウォームアップ1試行(cold の参考値)+ 計測10試行の中央値(warm)を両方報告する。
// ---------------------------------------------------------------------------

import { h, render } from "preact";

import { GRID_CELL_COUNT } from "../src/engine/adjacency";
import { loadPerfContent } from "./perfBoard";
import { buildGridMountBoard, gridMountFacilityCount } from "./gridMountBoard";

import { GridBoard } from "../src/ui/screens/grid/GridBoard";
import { createGameStore } from "../src/ui/store";

import { median, roundMs } from "./perfStats";

const MEASURED_TRIALS = 10;
const WARMUP_TRIALS = 1;

/** ADR-029 の B4(mount)予算。perf-boundaries.md §1 と同じ値。 */
const MOUNT_BUDGET_MS = 200;

const RESULT_SCHEMA = "kept-flame/bench/grid-mount/1";

interface TrialResult {
  readonly trial: number;
  readonly warmup: boolean;
  readonly mountMs: number;
  readonly renderMs: number;
  readonly layoutMs: number;
  readonly domNodeCount: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function emitMarks(trial: number, start: number, end: number): void {
  try {
    performance.mark(`kf:gridMount:start`, { startTime: start });
    performance.mark(`kf:gridMount:end`, { startTime: end });
    performance.measure(`kf:gridMount`, { start, end, detail: { trial } });
  } catch {
    // User Timing L3 の startTime 指定に未対応のエンジンでは諦める(計測値には影響しない)。
  }
}

/** 1試行: render() → 強制同期レイアウト → 観測 → アンマウント(区間外)。 */
function runTrial(
  trial: number,
  warmup: boolean,
  store: ReturnType<typeof createGameStore>,
  container: HTMLElement,
): TrialResult {
  const m0 = performance.now();
  render(h(GridBoard, { store }), container);
  const m1 = performance.now();
  const rect = container.getBoundingClientRect();
  const m2 = performance.now();

  if (rect.width < 0) {
    throw new Error("レイアウト強制が最適化で消えた(getBoundingClientRect が無効)");
  }
  const domNodeCount = container.querySelectorAll("*").length;

  emitMarks(trial, m0, m2);

  // アンマウントは区間外(perf-boundaries.md §2 R6)。
  render(null, container);

  return {
    trial,
    warmup,
    mountMs: m2 - m0,
    renderMs: m1 - m0,
    layoutMs: m2 - m1,
    domNodeCount,
  };
}

interface GridMountResult {
  readonly $schema: string;
  readonly meta: {
    readonly generatedAt: string;
    readonly userAgent: string;
    readonly crossOriginIsolated: boolean;
  };
  readonly workload: {
    readonly gridCells: number;
    readonly facilityCount: number;
    readonly measuredTrials: number;
    readonly warmupTrials: number;
  };
  readonly observed: {
    readonly domNodeCount: number;
  };
  readonly cold: {
    readonly mountMs: number;
    readonly renderMs: number;
    readonly layoutMs: number;
  };
  readonly warm: {
    readonly medianMountMs: number;
    readonly medianRenderMs: number;
    readonly medianLayoutMs: number;
    readonly minMountMs: number;
    readonly maxMountMs: number;
    readonly rawMountMs: readonly number[];
  };
  readonly budgetMs: number;
  readonly judgement: {
    readonly isOfficialVerdict: false;
    readonly coldVerdict: "pass" | "fail";
    readonly warmVerdict: "pass" | "fail";
    readonly note: string;
  };
}

async function runBench(
  container: HTMLElement,
  onStatus: (text: string) => void,
): Promise<GridMountResult> {
  onStatus("content をロード中…");
  const content = loadPerfContent();

  onStatus("代表盤面(48セル全部占有)を構築中…");
  const board = buildGridMountBoard(content);

  onStatus("ストアを構築中…");
  const store = createGameStore({ state: board, content });

  const trials: TrialResult[] = [];
  for (let i = -WARMUP_TRIALS; i < MEASURED_TRIALS; i++) {
    onStatus(
      i < 0
        ? "ウォームアップ試行を実行中…"
        : `計測試行 ${String(i + 1)} / ${String(MEASURED_TRIALS)} …`,
    );
    trials.push(runTrial(i, i < 0, store, container));
    // 試行間はイベントループへ返す(GC/描画を挟む・perf-boundaries.md §2)。
    await yieldToEventLoop();
  }

  const warmup = trials.find((t) => t.warmup);
  const measured = trials.filter((t) => !t.warmup);
  if (warmup === undefined || measured.length === 0) {
    throw new Error("試行が正しく実行されていない(内部不整合)");
  }

  const mountValues = measured.map((t) => t.mountMs);
  const renderValues = measured.map((t) => t.renderMs);
  const layoutValues = measured.map((t) => t.layoutMs);
  const domNodeCount = measured[measured.length - 1]?.domNodeCount ?? 0;

  const warmMedianMountMs = roundMs(median(mountValues));
  const coldMountMs = roundMs(warmup.mountMs);

  const result: GridMountResult = {
    $schema: RESULT_SCHEMA,
    meta: {
      generatedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
    },
    workload: {
      gridCells: GRID_CELL_COUNT,
      facilityCount: gridMountFacilityCount(),
      measuredTrials: MEASURED_TRIALS,
      warmupTrials: WARMUP_TRIALS,
    },
    observed: { domNodeCount },
    cold: {
      mountMs: coldMountMs,
      renderMs: roundMs(warmup.renderMs),
      layoutMs: roundMs(warmup.layoutMs),
    },
    warm: {
      medianMountMs: warmMedianMountMs,
      medianRenderMs: roundMs(median(renderValues)),
      medianLayoutMs: roundMs(median(layoutValues)),
      minMountMs: roundMs(Math.min(...mountValues)),
      maxMountMs: roundMs(Math.max(...mountValues)),
      rawMountMs: mountValues.map(roundMs),
    },
    budgetMs: MOUNT_BUDGET_MS,
    judgement: {
      isOfficialVerdict: false,
      coldVerdict: coldMountMs <= MOUNT_BUDGET_MS ? "pass" : "fail",
      warmVerdict: warmMedianMountMs <= MOUNT_BUDGET_MS ? "pass" : "fail",
      note:
        "デスクトップ実測は実機の下限見積りにしかならない(perf-boundaries.md §0と同じ注記)。" +
        "cold=ウォームアップ試行(JIT未暖機・実機の実復帰に近い上限側参考値)、" +
        "warm=計測10試行の中央値(下限側参考値)。両方を報告する(perf-boundaries.md §2の流儀)。" +
        "実際の GridBoard(4重符号化・過密バッジ込み)をマウントするため、" +
        "簡易代理モデル(bench/perfGrid.tsx・240要素固定)とは observed.domNodeCount が異なりうる。",
    },
  };

  onStatus("完了。");
  return result;
}

// --- 表示 --------------------------------------------------------------

function showStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
}

function renderResultTable(root: HTMLElement, result: GridMountResult): void {
  root.textContent = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["区分", "mount ms", "render ms", "layout ms", "予算 ms", "判定"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rows: readonly (readonly string[])[] = [
    [
      "cold(warmup)",
      String(result.cold.mountMs),
      String(result.cold.renderMs),
      String(result.cold.layoutMs),
      String(result.budgetMs),
      result.judgement.coldVerdict,
    ],
    [
      "warm(10試行中央値)",
      String(result.warm.medianMountMs),
      String(result.warm.medianRenderMs),
      String(result.warm.medianLayoutMs),
      String(result.budgetMs),
      result.judgement.warmVerdict,
    ],
  ];
  for (const cells of rows) {
    const tr = document.createElement("tr");
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);

  const notes = document.createElement("ul");
  const lines = [
    `DOM 要素数(実測): ${String(result.observed.domNodeCount)}(格子 ${String(result.workload.gridCells)} セル・施設 ${String(result.workload.facilityCount)} 基)`,
    `min ${String(result.warm.minMountMs)} ms / max ${String(result.warm.maxMountMs)} ms(計測10試行)`,
    `crossOriginIsolated=${String(result.meta.crossOriginIsolated)}`,
    "この結果はデスクトップの下限見積りであり #1 系列の合否ではない(isOfficialVerdict=false)。",
  ];
  for (const line of lines) {
    const li = document.createElement("li");
    li.textContent = line;
    notes.appendChild(li);
  }
  root.appendChild(notes);
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`要素 #${id} が見つからない`);
  return el as T;
}

function main(): void {
  const runButton = requireElement<HTMLButtonElement>("run-btn");
  const statusEl = requireElement("status");
  const resultsRoot = requireElement("results-root");
  const gridRoot = requireElement("grid-root");
  const jsonArea = requireElement<HTMLTextAreaElement>("result-json");

  runButton.addEventListener("click", () => {
    runButton.disabled = true;
    runBench(gridRoot, (text) => {
      showStatus(statusEl, text);
    })
      .then((result) => {
        renderResultTable(resultsRoot, result);
        jsonArea.value = JSON.stringify(result, null, 2);
        (window as unknown as { __GRID_MOUNT_RESULT__: unknown }).__GRID_MOUNT_RESULT__ = result;
        (window as unknown as { __GRID_MOUNT_DONE__: boolean }).__GRID_MOUNT_DONE__ = true;
        runButton.disabled = false;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(statusEl, `失敗: ${message}`);
        (window as unknown as { __GRID_MOUNT_ERROR__: string }).__GRID_MOUNT_ERROR__ = message;
        (window as unknown as { __GRID_MOUNT_DONE__: boolean }).__GRID_MOUNT_DONE__ = true;
        runButton.disabled = false;
      });
  });

  if (new URLSearchParams(window.location.search).get("autorun") === "1") {
    runButton.click();
  }
}

main();
