// ---------------------------------------------------------------------------
// bench/gridMount.html の実ブラウザスモーク(Chromium 1エンジン) — M19
//
// `bench/perfSmoke.spec.ts`(T11)と同じ立て付け: 性能値の合否は見ない
// (デスクトップ実測は実機の下限見積りにしかならない)。見るのは
//   - 実際の GridBoard が実 DOM としてマウントされること
//   - 結果 JSON の形が壊れていないこと
//   - mount 時間が「壊れたら気づける」程度の粗い上限に収まること
//     (200ms 予算そのものの合否判定ではなく、無限ループや異常値の検出用)
// ---------------------------------------------------------------------------

import { expect, test } from "@playwright/test";

interface GridMountResult {
  readonly $schema: string;
  readonly workload: { readonly gridCells: number; readonly facilityCount: number };
  readonly observed: { readonly domNodeCount: number };
  readonly cold: { readonly mountMs: number };
  readonly warm: {
    readonly medianMountMs: number;
    readonly minMountMs: number;
    readonly maxMountMs: number;
  };
  readonly judgement: {
    readonly isOfficialVerdict: boolean;
    readonly coldVerdict: string;
    readonly warmVerdict: string;
  };
}

test("bench/gridMount.html が実 GridBoard をマウントし結果 JSON を出す", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/gridMount.html?autorun=1");
  await page.waitForFunction(
    () => (window as unknown as { __GRID_MOUNT_DONE__?: boolean }).__GRID_MOUNT_DONE__ === true,
    undefined,
    { timeout: 60_000 },
  );

  const error = await page.evaluate(
    () => (window as unknown as { __GRID_MOUNT_ERROR__?: string }).__GRID_MOUNT_ERROR__ ?? null,
  );
  expect(error, "ベンチがエラーで終わっている").toBeNull();
  expect(consoleErrors, "ページ内で未捕捉例外が出ている").toEqual([]);

  const result = (await page.evaluate(
    () => (window as unknown as { __GRID_MOUNT_RESULT__: unknown }).__GRID_MOUNT_RESULT__,
  )) as GridMountResult;

  expect(result.$schema).toBe("kept-flame/bench/grid-mount/1");
  expect(result.workload.gridCells).toBe(48);
  expect(result.workload.facilityCount).toBeGreaterThan(0);

  // 実 DOM が実際にマウントされたことの確認(0要素で「成功」を偽装しない)。
  expect(result.observed.domNodeCount).toBeGreaterThan(0);

  // 性能値そのものの合否は見ない(isOfficialVerdict=false のまま)が、
  // 数値が有限で壊れていないことは確認する。
  expect(result.judgement.isOfficialVerdict).toBe(false);
  expect(Number.isFinite(result.cold.mountMs)).toBe(true);
  expect(Number.isFinite(result.warm.medianMountMs)).toBe(true);
  expect(result.warm.minMountMs).toBeLessThanOrEqual(result.warm.maxMountMs);

  // 壊れ方の検出用の粗い上限(デスクトップで 200ms 予算の何十倍にもなっていたら
  // 無限ループ/異常値を疑う。予算判定そのものではない)。
  expect(result.warm.medianMountMs).toBeLessThan(5000);
});
