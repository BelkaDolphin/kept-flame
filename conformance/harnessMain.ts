// ---------------------------------------------------------------------------
// クロスブラウザ conformance ハーネス(T8) — 計測 #7「クロスブラウザ完全bit一致」
// `docs/先行計測計画_ドラフト.md` §2.1 P2 / §5.2 #7 / `docs/design/golden-vector-spec.md`
//
// このファイルは `conformance/harness.html` から type="module" で読み込まれ、
// Chromium/Firefox/WebKit(Playwright)の**実ブラウザ内**で全 golden vector 計画
// (`conformance/vectorPlans.ts`)を実行する。digest 計算・分割/往復不変性の検証
// ロジックは `tools/goldenVectorBuilder.ts`(node:fs 非依存の純粋部)をそのまま
// import して使う — Node 側の生成器(`tools/genGoldenVectors.ts`)と**全く同じ
// 関数**であり、ここで別実装を書くと「digest 計算経路が2系統になる」(T8 依頼の
// 禁止事項)。
//
// content/初期 state の調達だけがブラウザ向けに違う: `conformance/scenarios.ts`
// は node:fs で content/*.json を読むため直接 import できない(goldenVectorBuilder.ts
// 冒頭のコメント参照)。代わりに `tools/genHarnessData.ts` が Node 側で事前計算した
// `conformance/harnessData.json`(content bundle と初期 state の precompute 結果)を
// 静的 import し、`schema/engineContent.ts` / `src/engine/state/serialize.ts` の
// **本物の実装**へそのまま渡す。
//
// 結果は `window.__CONFORMANCE_RESULTS__` に vectorId → 実行結果(GoldenVector
// または エラーメッセージ)として公開し、Playwright(e2e/conformance.spec.ts)が
// `conformance/vectors/*.json` の期待値と突合する。実行時刻(performance.now()差)は
// 「計測メタデータ」として結果オブジェクトの兄弟フィールド(elapsedMs)に置き、
// 比較対象の GoldenVector 構造には混ぜない(完全決定論ルール)。
// ---------------------------------------------------------------------------

import harnessDataJson from "./harnessData.json";
import { VECTOR_PLANS, type VectorPlan } from "./vectorPlans";

import { buildVectorFromResolvedInputs } from "../tools/goldenVectorBuilder";
import type { HarnessDataManifest } from "../tools/genHarnessData";

import { loadEngineContentOrThrow } from "../schema/engineContent";
import { fromSerializable } from "../src/engine/state/serialize";

import type { GoldenVector } from "./goldenVector";

const harnessData = harnessDataJson as unknown as HarnessDataManifest;

/** 1 vectorId ぶんの実行結果。ok=false は buildVectorFromResolvedInputs が例外を投げた場合。 */
export type VectorRunResult =
  | { readonly ok: true; readonly vector: GoldenVector; readonly elapsedMs: number }
  | { readonly ok: false; readonly errorMessage: string; readonly elapsedMs: number };

function runOnePlan(plan: VectorPlan): VectorRunResult {
  const start = performance.now();
  try {
    const contentBundle = harnessData.contentBundleByScenarioId[plan.scenarioId];
    if (contentBundle === undefined) {
      throw new Error(
        `harnessData.json に scenarioId "${plan.scenarioId}" の content bundle が無い` +
          "(tools/genHarnessData.ts の再実行が必要)",
      );
    }
    const content = loadEngineContentOrThrow(contentBundle);

    const stateByWorldSeed = harnessData.initialStateByScenarioId[plan.scenarioId];
    const serializedState = stateByWorldSeed?.[plan.worldSeed];
    if (serializedState === undefined) {
      throw new Error(
        `harnessData.json に (scenarioId="${plan.scenarioId}", worldSeed="${plan.worldSeed}") の` +
          "初期 state が無い(tools/genHarnessData.ts の再実行が必要)",
      );
    }
    const initialState = fromSerializable(serializedState);

    const vector = buildVectorFromResolvedInputs(plan, content, initialState);
    return { ok: true, vector, elapsedMs: performance.now() - start };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      elapsedMs: performance.now() - start,
    };
  }
}

function runAll(): { readonly [vectorId: string]: VectorRunResult } {
  const results: Record<string, VectorRunResult> = {};
  for (const plan of VECTOR_PLANS) {
    results[plan.vectorId] = runOnePlan(plan);
  }
  return results;
}

/** `<tr>` を安全に組み立てる(innerHTML を使わず textContent のみでセルを作る)。 */
function appendRow(
  parent: HTMLTableSectionElement,
  cellTexts: readonly string[],
  tag: "td" | "th",
): void {
  const tr = document.createElement("tr");
  for (const text of cellTexts) {
    const cell = document.createElement(tag);
    cell.textContent = text;
    tr.appendChild(cell);
  }
  parent.appendChild(tr);
}

function renderTable(results: { readonly [vectorId: string]: VectorRunResult }): void {
  const root = document.getElementById("results-root");
  if (root === null) return;

  const vectorIds = Object.keys(results).sort();
  const okCount = vectorIds.filter((id) => results[id]?.ok === true).length;

  const summary = document.createElement("p");
  summary.textContent =
    `computed ${String(vectorIds.length)} vector(s), ` +
    `${String(okCount)} ok / ${String(vectorIds.length - okCount)} threw`;
  root.appendChild(summary);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  appendRow(thead, ["vectorId", "status", "elapsedMs", "stateDigest"], "th");
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const vectorId of vectorIds) {
    const result = results[vectorId];
    if (result === undefined) continue;
    const status = result.ok ? "ok" : "error";
    const digest = result.ok ? result.vector.expected.stateDigest : result.errorMessage;
    appendRow(tbody, [vectorId, status, result.elapsedMs.toFixed(2), digest], "td");
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// ---------------------------------------------------------------------------
// T14: 結果 JSON の画面表示/コピー/ダウンロード(先行計測計画 §7 の実 iOS Safari
// 補完向け)。digest 計算・突合ロジック(runOnePlan/runAll、上)には一切触れない。
// perf.html(bench/perfMain.ts)/tags.html と同じ「コピー + ダウンロード」の
// 2 手段を用意する。
// ---------------------------------------------------------------------------

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`要素 #${id} が見つからない`);
  return el as T;
}

function flashStatus(statusEl: HTMLElement, text: string): void {
  statusEl.textContent = text;
  setTimeout(() => {
    statusEl.textContent = "";
  }, 3000);
}

function copyResultJson(textarea: HTMLTextAreaElement, statusEl: HTMLElement): void {
  const text = textarea.value;
  if (navigator.clipboard as unknown) {
    navigator.clipboard.writeText(text).then(
      () => {
        flashStatus(statusEl, "コピーしました");
      },
      () => {
        textarea.focus();
        textarea.select();
        flashStatus(statusEl, "コピー失敗: テキストエリアを手動で選択してください");
      },
    );
    return;
  }
  textarea.focus();
  textarea.select();
  flashStatus(statusEl, "コピー失敗: テキストエリアを手動で選択してください");
}

function downloadResultJson(textarea: HTMLTextAreaElement, statusEl: HTMLElement): void {
  const text = textarea.value;
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = url;
  link.download = `kept-flame-harness-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 3000);
  flashStatus(statusEl, "ダウンロードしました");
}

function main(): void {
  const results = runAll();
  // window へ公開(Playwright の e2e/conformance.spec.ts がここを読む)。
  (window as unknown as { __CONFORMANCE_RESULTS__: unknown }).__CONFORMANCE_RESULTS__ = results;
  renderTable(results);

  const jsonArea = requireElement<HTMLTextAreaElement>("result-json");
  const copyStatus = requireElement("copy-status");
  jsonArea.value = JSON.stringify(results, null, 2);
  requireElement<HTMLButtonElement>("copy-json-btn").addEventListener("click", () => {
    copyResultJson(jsonArea, copyStatus);
  });
  requireElement<HTMLButtonElement>("download-json-btn").addEventListener("click", () => {
    downloadResultJson(jsonArea, copyStatus);
  });

  (window as unknown as { __CONFORMANCE_DONE__: boolean }).__CONFORMANCE_DONE__ = true;
}

main();
