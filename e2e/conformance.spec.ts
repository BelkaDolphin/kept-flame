// ---------------------------------------------------------------------------
// クロスブラウザ golden vector conformance テスト(T8) — 計測 #7
// `docs/先行計測計画_ドラフト.md` §5.2 #7 / `docs/design/golden-vector-spec.md`
//
// `conformance/harness.html` を(このプロジェクトが表す)1 エンジンで開き、
// ブラウザが計算した観測値(stateDigest/counters/probe/splitCounters)を
// `conformance/vectors/*.json` の期待値と**完全一致**で突合する。
//
// ベクタ一覧は `conformance/vectors/index.json` から動的に列挙する
// (本数をハードコードしない。並行エージェント(T7)がベクタを追加し得るため)。
//
// 突合ロジック(`diffVectors`)は `tools/genGoldenVectors.ts` の既存実装を
// そのまま再利用する(Node 側の生成器・検証器と全く同じ突合基準を使うことで、
// 「golden:check の判定」と「3 エンジン conformance の判定」が食い違わないように
// する)。
//
// `fullyParallel: false`(playwright.config.ts)により、1 プロジェクト内の
// テストは同一 worker で直列実行される。これを前提に、`beforeAll` でハーネスを
// 1 回だけロードして結果を module スコープにキャッシュし、vectorId ごとに
// 動的生成した `test()` から参照する(ページ再読み込みのコストを避ける)。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { diffVectors, loadStoredVector } from "../tools/genGoldenVectors";
import type { GoldenVector } from "../conformance/goldenVector";

import { writeEngineReport, type EngineVectorResult } from "./report";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, "..", "conformance", "vectors", "index.json");

interface VectorIndex {
  readonly vectors: readonly { readonly vectorId: string; readonly file: string }[];
}

function loadVectorIds(): readonly string[] {
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as VectorIndex;
  return [...index.vectors.map((v) => v.vectorId)].sort();
}

/** 実行時に動的列挙する(ハードコードしない・T8 依頼の要請)。 */
const VECTOR_IDS = loadVectorIds();

/** ブラウザ側 `conformance/harnessMain.ts` が公開する 1 vectorId ぶんの結果。 */
type BrowserVectorRunResult =
  | { readonly ok: true; readonly vector: GoldenVector; readonly elapsedMs: number }
  | { readonly ok: false; readonly errorMessage: string; readonly elapsedMs: number };

type BrowserResults = { readonly [vectorId: string]: BrowserVectorRunResult };

async function loadHarnessResults(page: Page): Promise<BrowserResults> {
  await page.goto("/harness.html");
  await page.waitForFunction(
    () => (window as unknown as { __CONFORMANCE_DONE__?: boolean }).__CONFORMANCE_DONE__ === true,
    { timeout: 60_000 },
  );
  return page.evaluate(
    () =>
      (window as unknown as { __CONFORMANCE_RESULTS__: BrowserResults }).__CONFORMANCE_RESULTS__,
  );
}

test.describe("golden vector cross-browser conformance (measurement #7)", () => {
  let browserResults: BrowserResults | undefined;
  let harnessLoadError: string | undefined;
  const collectedResults: EngineVectorResult[] = [];

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      browserResults = await loadHarnessResults(page);
    } catch (error) {
      harnessLoadError = error instanceof Error ? error.message : String(error);
    } finally {
      await page.close();
    }
  });

  // Playwright requires the first hook argument to be an object destructuring
  // pattern (even when no fixture is needed), which no-empty-pattern flags.
  // eslint-disable-next-line no-empty-pattern
  test.afterAll(async ({}, testInfo) => {
    writeEngineReport(testInfo.project.name, collectedResults);
  });

  if (VECTOR_IDS.length === 0) {
    test("conformance/vectors/index.json に少なくとも1本のベクタがある", () => {
      expect(VECTOR_IDS.length).toBeGreaterThan(0);
    });
  }

  for (const vectorId of VECTOR_IDS) {
    test(vectorId, () => {
      if (harnessLoadError !== undefined) {
        collectedResults.push({
          vectorId,
          status: "error",
          elapsedMs: 0,
          diffs: [],
          errorMessage: `harness page failed to load: ${harnessLoadError}`,
        });
        throw new Error(`harness page failed to load: ${harnessLoadError}`);
      }

      const entry = browserResults?.[vectorId];
      if (entry === undefined) {
        collectedResults.push({
          vectorId,
          status: "error",
          elapsedMs: 0,
          diffs: [],
          errorMessage: "harness produced no result for this vectorId",
        });
        throw new Error(
          `harness produced no result for "${vectorId}"` +
            "(conformance/vectorPlans.ts にこの vectorId のプランが無い可能性)",
        );
      }

      if (!entry.ok) {
        collectedResults.push({
          vectorId,
          status: "error",
          elapsedMs: entry.elapsedMs,
          diffs: [],
          errorMessage: entry.errorMessage,
        });
        throw new Error(`harness threw while building "${vectorId}": ${entry.errorMessage}`);
      }

      const stored = loadStoredVector(vectorId);
      if (stored === undefined) {
        collectedResults.push({
          vectorId,
          status: "error",
          elapsedMs: entry.elapsedMs,
          diffs: [],
          errorMessage: "no stored vector file (run npm run golden:write)",
        });
        throw new Error(`no stored vector file for "${vectorId}" (run npm run golden:write)`);
      }

      // Math 許可リスト違反・Map 順序依存が第一容疑(先行計測計画 §5.2 #7)。
      // diffVectors はどのフィールドがどう違うかを人間可読な行で返す。
      const diffs = diffVectors(entry.vector, stored);
      collectedResults.push({
        vectorId,
        status: diffs.length === 0 ? "match" : "mismatch",
        elapsedMs: entry.elapsedMs,
        diffs,
        errorMessage: null,
      });

      expect(
        diffs,
        `"${vectorId}" diverged from the stored golden vector:\n${diffs.join("\n")}`,
      ).toEqual([]);
    });
  }
});
