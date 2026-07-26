// ---------------------------------------------------------------------------
// #1(オフライン復帰2秒予算)ベンチ専用の Vite 設定 — T10
//
// ルート `vite.config.ts` は vitest 共有設定(`environment: "node"`)で並行
// エージェントとも共有しているため触らない。T8 の
// `conformance/vite.harness.config.ts` と同じ流儀で、独立した設定ファイルとして
// 分離する(root をこのディレクトリに置き、entry を bench/perf.html にする)。
//
// 設計判断: `vite dev` ではなく `vite build` + `vite preview` を使う。
// 理由は T8 と同じで、(a) 未バンドル ESM グラフ・HMR websocket の影響を
// 計測へ持ち込まない、(b) 本番(ADR-025 の静的アセット配信)と同じバンドル経路
// (minify 込み)で測る方が実配信に近い。#1 は性能計測なので (b) は特に重要で、
// dev サーバの非バンドル ESM で測ると module 解決コストが混ざる。
//
// 注意(T12 への引き継ぎ): `performance.measureUserAgentSpecificMemory()` は
// cross-origin isolation(COOP/COEP)を要求するので、T12 は `preview.headers` に
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
// を足す必要がある。**T10 では入れない** — 入れると副作用で
// `performance.now()` の分解能が上がり、T10 実測値と T12 実測値の比較条件が
// 変わってしまうため(docs/design/perf-boundaries.md §8-2)。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: HERE,
  build: {
    // 本体アプリの `dist/` や T8 の `dist/harness` と衝突しない別名。
    // `.gitignore` の `dist/` に含まれるので追加の除外設定は不要。
    outDir: resolve(HERE, "..", "dist", "perf"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, "perf.html"),
    },
  },
  preview: {
    // T8 のハーネス(4319)と衝突しないポート。
    port: 4320,
    strictPort: true,
  },
});
