// ---------------------------------------------------------------------------
// Playwright 3エンジン conformance 設定(T8) — 計測 #7「クロスブラウザ完全bit一致」
// `docs/先行計測計画_ドラフト.md` §2.1 P2 / §5.2 #7 / §7
//
// `conformance/harness.html` を 3 エンジン(Chromium/Firefox/WebKit)で開き、
// 各エンジンが計算した golden vector の観測値を `conformance/vectors/*.json`
// (Node 側の生成器が作った期待値)と突合する(`e2e/conformance.spec.ts`)。
//
// 設計判断: webServer は `vite build`(conformance/vite.harness.config.ts)+
// `vite preview` を使う(dev サーバではない)。理由は
// `conformance/vite.harness.config.ts` 冒頭のコメントを参照(本番ビルドと
// 同じバンドル経路を通した方が bit 一致計測の再現性が高い)。
//
// 重要な注意(先行計測計画 §7): Playwright の WebKit は Apple が iOS/macOS に
// 出荷する Safari / WKWebView とはビルドが異なる**独自ビルド**であり、
// 実 iOS Safari の代替にはならない。ここで保証できるのは
// 「V8 / SpiderMonkey / JavaScriptCore 系統をまたいで同一結果」までである。
// 実 iOS Safari との一致は別途実機で `conformance/harness.html` を開いて
// 補完すること(計画書 §7 (i))。この注記は `e2e/report.ts` のレポータ出力にも
// 明記する。
// ---------------------------------------------------------------------------

import { defineConfig, devices } from "@playwright/test";

const HARNESS_PORT = 4319;
const BASE_URL = `http://localhost:${String(HARNESS_PORT)}`;

export default defineConfig({
  testDir: "./e2e",
  // 各プロジェクト(エンジン)内で 1 ファイルのテストを直列実行する。
  // beforeAll でハーネスページを 1 回だけロードし、生成された全ベクタの結果を
  // module スコープへキャッシュしたうえで vectorId ごとに 1 test を生成する
  // 設計(e2e/conformance.spec.ts)のため、同一ファイル内のテストが複数
  // worker へ分割されないことが前提。
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalTeardown: "./e2e/globalTeardown.ts",
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: "npm run conformance:build && npm run conformance:preview",
    url: `${BASE_URL}/harness.html`,
    // 常に最新の content/シナリオでビルドし直す(並行エージェントが
    // vectors/scenarios を更新し得るため、古いビルドの使い回しを避ける)。
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
