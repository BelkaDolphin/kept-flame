// ---------------------------------------------------------------------------
// T14: dist/device(単一 HTML パッケージ)の file:// スモーク。
// `docs/先行計測計画_ドラフト.md` §2.1 T14 行 / `docs/measurements/device-testing-guide.md`
//
// 実機はブラウザで直接ファイルを開く(file://)か、COOP/COEP の無い単純な HTTP
// 配信で開かれる想定である(§6 の接続手段のうち、単一 HTML そのものが要求するのは
// この最低条件)。本スペックは **性能値を判定しない**(#1/#2 の合否は実機/T16)。
// 確認するのは:
//   (a) #9b 相当(tags.html)と #7 補完(harness.html)が file:// でも最後まで動く
//   (b) perf.html は isolation が無い環境(file://・crossOriginIsolated=false)で
//       クラッシュせず完走し、#2(メモリ計測)が `unmeasured` へ正しく縮退する
//   (c) 3ページとも外部ネットワークアクセスを一切発生させない(自己完結の実証)
//
// 事前に `npm run device:package` を実行しておくこと(このスペック自体は
// ビルドを起動しない — CI 向けの他 2 設定と違い、`dist/device/` の実体を対象に
// するテストなので、パッケージングの再現性はここでは問わない)。
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEVICE_DIST_DIR = resolve(HERE, "..", "dist", "device");

function fileUrlFor(name: string): string {
  const path = join(DEVICE_DIST_DIR, name);
  if (!existsSync(path)) {
    throw new Error(`${path} が無い。先に "npm run device:package" を実行すること。`);
  }
  return pathToFileURL(path).href;
}

/** 3ページ共通: 外部ネットワークへ一切出ないこと(自己完結の実証)。 */
function trackNetworkRequests(page: import("@playwright/test").Page): string[] {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("file://") && !url.startsWith("blob:") && !url.startsWith("data:")) {
      externalRequests.push(url);
    }
  });
  return externalRequests;
}

test.describe("dist/device の file:// スモーク(T14)", () => {
  test("tags.html(#9b相当)が file:// で凡例と格子を描画する", async ({ page }) => {
    const externalRequests = trackNetworkRequests(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(fileUrlFor("tags.html"));
    await expect(page.locator("#legend-grid .legend-card")).toHaveCount(7);
    await expect(page.locator("#grid-demo .kf-cell")).toHaveCount(48);

    // 判読テストを1件回答して結果 JSON が更新されることを確認する(コピー/DL の前提)。
    await page.getByRole("button", { name: "判読できた" }).click();
    const json = await page.locator("#result-json").inputValue();
    const parsed = JSON.parse(json) as { readonly trials: readonly unknown[] };
    expect(parsed.trials.length).toBeGreaterThan(0);

    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });

  test("harness.html(#7 実iOS Safari補完)が file:// で全ベクタを計算する", async ({ page }) => {
    const externalRequests = trackNetworkRequests(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(fileUrlFor("harness.html"));
    await page.waitForFunction(
      () => (window as unknown as { __CONFORMANCE_DONE__?: boolean }).__CONFORMANCE_DONE__ === true,
      undefined,
      { timeout: 30_000 },
    );

    const results = await page.evaluate(
      () =>
        (
          window as unknown as {
            __CONFORMANCE_RESULTS__: Record<string, { readonly ok: boolean }>;
          }
        ).__CONFORMANCE_RESULTS__,
    );
    const vectorIds = Object.keys(results);
    expect(vectorIds.length).toBeGreaterThan(0);
    expect(vectorIds.every((id) => results[id]?.ok === true)).toBe(true);

    // 結果 JSON のコピー/ダウンロード UI が data 入りで存在する。
    const jsonArea = await page.locator("#result-json").inputValue();
    expect(JSON.parse(jsonArea)).toBeTruthy();

    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });

  test("perf.html は isolation が無い file:// でも完走し、#2 が unmeasured に縮退する", async ({
    page,
  }) => {
    const externalRequests = trackNetworkRequests(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(`${fileUrlFor("perf.html")}?autorun=1`);
    await page.waitForFunction(
      () => (window as unknown as { __PERF_DONE__?: boolean }).__PERF_DONE__ === true,
      undefined,
      { timeout: 90_000 },
    );

    const perfError = await page.evaluate(
      () => (window as unknown as { __PERF_ERROR__?: string }).__PERF_ERROR__ ?? null,
    );
    expect(perfError, "perf.html がエラーで終わっている(file:// での Worker/IDB 経路)").toBeNull();

    interface SmokeResult {
      readonly meta: { readonly crossOriginIsolated: boolean };
      readonly memory: { readonly supported: boolean; readonly unsupportedReason: string | null };
      readonly judgement: { readonly isOfficialVerdict: boolean };
      readonly worker: { readonly route: string } | null;
    }
    const result = (await page.evaluate(
      () => (window as unknown as { __PERF_RESULT__: unknown }).__PERF_RESULT__,
    )) as SmokeResult;

    // isolation 前提(perf-boundaries.md §8-2)が file:// には無いことの機械確認。
    expect(result.meta.crossOriginIsolated).toBe(false);
    // #2(ヒープ増分)は「不可」であって「クラッシュ」ではない、という縮退の確認。
    expect(result.memory.supported).toBe(false);
    expect(result.memory.unsupportedReason).toBe("not-cross-origin-isolated");
    // #1/#8 は合否を主張しない(perf-boundaries.md §0 の恒常方針)。
    expect(result.judgement.isOfficialVerdict).toBe(false);
    // Worker 経路(Blob URL 埋め込み)自体は最後まで機能している。
    expect(result.worker?.route).toBe("worker-draft-snapshot");

    const jsonArea = await page.locator("#result-json").inputValue();
    expect(JSON.parse(jsonArea)).toBeTruthy();

    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
});
