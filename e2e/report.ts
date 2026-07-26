// ---------------------------------------------------------------------------
// 突合レポータ(T8) — エンジン×ベクタの一致表と実行時間を出力する
// `docs/先行計測計画_ドラフト.md` §5.2 #7 / 報告事項
//
// `e2e/conformance.spec.ts` が各エンジンごとに `conformance/results/<project>.json`
// を書き出し、`e2e/globalTeardown.ts` が全エンジン分を読み込んでコンソール表 +
// `conformance/results/summary.json` を作る。2 段に分けているのは、Playwright は
// プロジェクト(エンジン)ごとに別 worker で実行するため、1 つの JS プロセス内で
// 3 エンジン分を集計できないため。
//
// 完全決定論ルールの遵守: `generatedAtIso`(書き出し時刻)は**この JSON ファイル
// 自体が golden vector の比較対象ではない**(人間向けレポートであり、
// `conformance/vectors/*.json` の期待値と突き合わされる対象は
// `EngineVectorResult.diffs` 等であって書き出し時刻ではない)ため、
// 「計測メタデータ」として明示のうえ含めている。
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(HERE);
export const RESULTS_DIR = join(PROJECT_ROOT, "conformance", "results");

/** 実 iOS Safari の代替にならない旨(先行計測計画 §7)。レポート出力に明記する。 */
export const WEBKIT_CAVEAT =
  "注意: Playwright の WebKit は Apple が iOS/macOS に出荷する Safari / WKWebView とは" +
  "ビルドが異なる独自ビルドであり、実 iOS Safari の代替にはならない" +
  "(先行計測計画_ドラフト.md §7)。ここで保証できるのは V8/SpiderMonkey/JavaScriptCore " +
  "系統をまたいで同一結果であることまで。実 iOS Safari との一致は実機で " +
  "conformance/harness.html を開いて別途補完すること。";

/** 1 ベクタ 1 エンジンぶんの突合結果。 */
export interface EngineVectorResult {
  readonly vectorId: string;
  readonly status: "match" | "mismatch" | "error";
  readonly elapsedMs: number;
  /** `diffVectors` 相当の詳細(空配列 = 一致)。 */
  readonly diffs: readonly string[];
  readonly errorMessage: string | null;
}

/** 1 エンジンぶんの結果ファイル(`conformance/results/<project>.json`)。 */
export interface EngineReport {
  readonly formatVersion: number;
  readonly projectName: string;
  /** 計測メタデータ(比較対象ではない)。 */
  readonly generatedAtIso: string;
  readonly results: readonly EngineVectorResult[];
}

export const REPORT_FORMAT_VERSION = 1;

export function engineReportPath(projectName: string): string {
  return join(RESULTS_DIR, `${projectName}.json`);
}

export function writeEngineReport(
  projectName: string,
  results: readonly EngineVectorResult[],
): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const report: EngineReport = {
    formatVersion: REPORT_FORMAT_VERSION,
    projectName,
    generatedAtIso: new Date().toISOString(),
    results: [...results].sort((a, b) =>
      a.vectorId < b.vectorId ? -1 : a.vectorId > b.vectorId ? 1 : 0,
    ),
  };
  writeFileSync(engineReportPath(projectName), JSON.stringify(report, null, 2) + "\n", "utf8");
}

export function readEngineReport(projectName: string): EngineReport | undefined {
  const path = engineReportPath(projectName);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as EngineReport;
}

/** 既知の 3 プロジェクト名(playwright.config.ts の projects と対応)。 */
export const KNOWN_PROJECT_NAMES = ["chromium", "firefox", "webkit"] as const;

export interface SummaryCell {
  readonly status: "match" | "mismatch" | "error" | "missing";
  readonly elapsedMs: number | null;
}

export interface Summary {
  readonly formatVersion: number;
  readonly generatedAtIso: string;
  readonly webkitCaveat: string;
  readonly projectNames: readonly string[];
  readonly vectorIds: readonly string[];
  /** `matrix[vectorId][projectName]`。 */
  readonly matrix: { readonly [vectorId: string]: { readonly [projectName: string]: SummaryCell } };
  readonly totalsByProject: {
    readonly [projectName: string]: {
      readonly match: number;
      readonly mismatch: number;
      readonly error: number;
    };
  };
  readonly allMatch: boolean;
}

/** 全プロジェクトの `EngineReport` から突合表(summary)を組み立てる。 */
export function buildSummary(reports: readonly EngineReport[]): Summary {
  const projectNames = reports.map((r) => r.projectName).sort();
  const vectorIdSet = new Set<string>();
  for (const report of reports) {
    for (const result of report.results) vectorIdSet.add(result.vectorId);
  }
  const vectorIds = [...vectorIdSet].sort();

  const matrix: Record<string, Record<string, SummaryCell>> = {};
  const totalsByProject: Record<string, { match: number; mismatch: number; error: number }> = {};
  for (const projectName of projectNames) {
    totalsByProject[projectName] = { match: 0, mismatch: 0, error: 0 };
  }

  for (const vectorId of vectorIds) {
    matrix[vectorId] = {};
    for (const report of reports) {
      const result = report.results.find((r) => r.vectorId === vectorId);
      const cell: SummaryCell =
        result === undefined
          ? { status: "missing", elapsedMs: null }
          : { status: result.status, elapsedMs: result.elapsedMs };
      const row = matrix[vectorId];
      if (row !== undefined) row[report.projectName] = cell;
      if (result !== undefined) {
        const totals = totalsByProject[report.projectName];
        if (totals !== undefined) totals[result.status]++;
      }
    }
  }

  const allMatch = reports.every(
    (r) => r.results.length > 0 && r.results.every((result) => result.status === "match"),
  );

  return {
    formatVersion: REPORT_FORMAT_VERSION,
    generatedAtIso: new Date().toISOString(),
    webkitCaveat: WEBKIT_CAVEAT,
    projectNames,
    vectorIds,
    matrix,
    totalsByProject,
    allMatch,
  };
}

export function writeSummary(summary: Summary): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

function statusSymbol(status: SummaryCell["status"]): string {
  switch (status) {
    case "match":
      return "OK";
    case "mismatch":
      return "DIFF";
    case "error":
      return "ERR";
    case "missing":
      return "-";
  }
}

/** コンソールへ人間可読な一致表を印字する。 */
export function printSummary(summary: Summary): void {
  console.log("");
  console.log("=== golden vector conformance: engine x vector match table (measurement #7) ===");
  const header = ["vectorId", ...summary.projectNames].join(" | ");
  console.log(header);
  for (const vectorId of summary.vectorIds) {
    const row = summary.matrix[vectorId];
    const cells = summary.projectNames.map((p) => {
      const cell = row?.[p];
      if (cell === undefined) return "-";
      const ms = cell.elapsedMs === null ? "" : ` (${cell.elapsedMs.toFixed(1)}ms)`;
      return `${statusSymbol(cell.status)}${ms}`;
    });
    console.log([vectorId, ...cells].join(" | "));
  }
  console.log("");
  for (const projectName of summary.projectNames) {
    const totals = summary.totalsByProject[projectName];
    if (totals === undefined) continue;
    console.log(
      `${projectName}: match=${String(totals.match)} mismatch=${String(totals.mismatch)} ` +
        `error=${String(totals.error)}`,
    );
  }
  console.log("");
  console.log(
    summary.allMatch
      ? "RESULT: all vectors bit-identical across all engines."
      : "RESULT: divergence detected (see mismatch/error rows above).",
  );
  console.log("");
  console.log(summary.webkitCaveat);
  console.log("");
}

/**
 * 乖離(mismatch/error)があったベクタについて `diffVectors` 相当の詳細
 * (どのフィールドがどう違うか)をコンソールへ印字する(先行計測計画 §5.2 #7)。
 * 乖離がゼロなら何も出さない。
 */
export function printDivergenceDetails(reports: readonly EngineReport[]): void {
  const divergent = reports.flatMap((report) =>
    report.results
      .filter((r) => r.status !== "match")
      .map((r) => ({ projectName: report.projectName, result: r })),
  );
  if (divergent.length === 0) return;

  console.log(
    "=== divergence details (first suspect: Math allowlist violation or Map ordering) ===",
  );
  for (const { projectName, result } of divergent) {
    console.log(`[${projectName}] ${result.vectorId}: ${result.status}`);
    if (result.errorMessage !== null) {
      console.log(`  error: ${result.errorMessage}`);
    }
    for (const diff of result.diffs) {
      console.log(`  - ${diff}`);
    }
  }
  console.log("");
}
