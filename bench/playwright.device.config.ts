// ---------------------------------------------------------------------------
// dist/device(T14 単一ファイルパッケージ)の file:// スモーク用 Playwright 設定。
//
// 目的は実機配布シナリオの**下限**を確認することであって性能判定ではない:
// ネットワーク不安定/オフラインでも実機のブラウザでファイルを直接開ける、という
// 「単一 HTML 自己完結」の要件そのものを、`page.goto("file://...")` で検証する
// (webServer を起動しない。まさに配布時に COOP/COEP 等のヘッダが一切無い状態を
// 模している)。
//
// ルートの `playwright.config.ts`(#7・3エンジン)・`bench/playwright.perf.config.ts`
// (#1/#2・webServer 経由 HTTP プレビュー)とは別設定にしてある。webServer が無い
// (file:// 直開き)ことと testDir が違うことが理由で、既存 2 設定には一切触れない。
// ---------------------------------------------------------------------------

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: HERE,
  testMatch: ["deviceSmoke.spec.ts"],
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
