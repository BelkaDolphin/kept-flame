// ---------------------------------------------------------------------------
// GridBoard 実DOMマウント計測(M19)専用の Vite 設定
//
// `bench/vite.perf.config.ts`(T10)と同じ流儀: ルート `vite.config.ts`
// (vitest 共有設定・並行エージェントとも共有)は触らず、独立した設定ファイルに
// 分離する。`vite build` + `vite preview` を使う理由も同じ(本番と同じ
// バンドル経路で測る・HMR websocket の影響を排除する)。
//
// ポートは 4321(bench:perf の 4320 / conformance harness の 4319 と別)。
// **Windows 予約域(4237-4336・netsh show excludedportrange で確認)を避けるため
// 4521 を使う**(タスク指示: 「port を使うなら回避」)。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: HERE,
  build: {
    outDir: resolve(HERE, "..", "dist", "gridMount"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, "gridMount.html"),
    },
  },
  preview: {
    port: 4521,
    strictPort: true,
  },
});
