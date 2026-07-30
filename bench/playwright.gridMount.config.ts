// ---------------------------------------------------------------------------
// GridBoard 実DOMマウント計測(bench/gridMount.html)の Playwright 設定 — M19
//
// `bench/playwright.perf.config.ts`(T11)と同じ流儀。webServer が違う
// (あちらは perf ベンチ:4320、こちらは gridMount:4521)ため別設定にしてある。
// Chromium 限定(#1 系列と同じ理由: cross-origin isolated でない Firefox/WebKit は
// performance.now を 1ms へ丸める。docs/design/perf-boundaries.md §2)。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRID_MOUNT_PORT = 4521;
const BASE_URL = `http://localhost:${String(GRID_MOUNT_PORT)}`;

export default defineConfig({
  testDir: HERE,
  testMatch: ["gridMountSmoke.spec.ts"],
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  use: { baseURL: BASE_URL },
  webServer: {
    command: "npm run bench:gridmount:build && npm run bench:gridmount:preview",
    url: `${BASE_URL}/gridMount.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: resolve(HERE, ".."),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
