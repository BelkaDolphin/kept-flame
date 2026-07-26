// ---------------------------------------------------------------------------
// #1 ベンチ(bench/perf.html)のスモーク用 Playwright 設定 — T11
//
// ルートの `playwright.config.ts`(計測 #7 の 3 エンジン conformance)とは
// **別設定**にしてある。理由:
//   (a) webServer が違う(あちらは conformance ハーネス:4319、こちらは
//       perf ベンチ:4320)
//   (b) エンジンが違う(#1 は Chromium 系のみ。Firefox/WebKit は
//       cross-origin isolated でない環境で performance.now を 1ms へ丸めるため
//       — docs/design/perf-boundaries.md §2「タイマ分解能」)
//   (c) `playwright.config.ts` の testDir は `./e2e` なので、spec をこの
//       ディレクトリに置くだけで #7 の実行対象から自動的に外れる
//       (= 既存 conformance の設定に一切触らずに済む)
//
// 目的は**性能値の判定ではなくスモーク**である: Worker 経路と persistence 経路が
// 実ブラウザで実際に走り、結果 JSON が出ることを確かめるだけ。数値の合否は
// 計測 #1 の本計測(T16・実機)の担当。
//
// [T12] `gcTrace.spec.ts` を追加(計測 #2 後半・CDP トレース)。webServer は
// perfSmoke と共有する(同じ preview サーバに対して 2 spec が順に走るだけ)。
// こちらも Chromium 限定(CDPSession が使えるのは Chromium のみ)。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const PERF_PORT = 4320;
const BASE_URL = `http://localhost:${String(PERF_PORT)}`;

export default defineConfig({
  testDir: HERE,
  testMatch: ["perfSmoke.spec.ts", "gcTrace.spec.ts"],
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 180_000,
  use: { baseURL: BASE_URL },
  webServer: {
    command: "npm run bench:perf:build && npm run bench:perf:preview",
    url: `${BASE_URL}/perf.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: resolve(HERE, ".."),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
