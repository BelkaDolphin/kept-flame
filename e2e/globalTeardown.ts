// ---------------------------------------------------------------------------
// Playwright global teardown(T8) — 3 エンジン分の結果を集計してレポートする
//
// `e2e/conformance.spec.ts` はプロジェクト(エンジン)ごとに
// `conformance/results/<project>.json` を書く(プロジェクトごとに別 worker
// プロセスで実行されるため、1 プロセス内で 3 エンジン分を集計できない)。
// この global teardown は全プロジェクトの実行が終わったあとに 1 度だけ走り、
// 各ファイルを読み込んで突合表(`conformance/results/summary.json`)を作り、
// コンソールへ人間可読な一致表を印字する。
// ---------------------------------------------------------------------------

import {
  KNOWN_PROJECT_NAMES,
  buildSummary,
  printDivergenceDetails,
  printSummary,
  readEngineReport,
  writeSummary,
} from "./report";

export default function globalTeardown(): void {
  const reports = KNOWN_PROJECT_NAMES.map((name) => readEngineReport(name)).filter(
    (report) => report !== undefined,
  );
  if (reports.length === 0) {
    console.log("conformance: no per-engine result files found (tests may not have run).");
    return;
  }
  const summary = buildSummary(reports);
  writeSummary(summary);
  printSummary(summary);
  printDivergenceDetails(reports);
}
