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
// [T12] COOP/COEP を追加(担当は T12・docs/design/perf-boundaries.md §8-2 の
// 引き継ぎどおり)。`performance.measureUserAgentSpecificMemory()` は
// cross-origin isolation を要求するため、これが無いと計測 #2(ヒープ増分)が
// 恒久的に null になる。**副作用**: `crossOriginIsolated: true` になると
// `performance.now()` の分解能が 0.1ms(T10/T11 実測)から高分解能(5µs 級)へ
// 上がる。したがって本 config を境に **`meta.crossOriginIsolated` が `false` の
// 過去実測(T10/T11)の B3/B4(0ms 丸め)と、`true` の実測(T12 以降)は比較不能**
// になる(docs/design/perf-boundaries.md §13-1 に記録)。`$schema` は据え置き
// (境界定義そのもの§3/§8 を 1 つも変えていないため・bench/perfStats.ts 冒頭参照)
// — 判別は既存の `meta.crossOriginIsolated` フィールドで行う。
// build には headers の概念が無い(HTTP サーバではない)ので preview のみ。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: HERE,
  // T11: `src/platform/workerClient.ts` が
  // `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` で
  // catch-up Worker を起動する。Vite の `worker.format` は既定 `"iife"` なので、
  // module worker として出させるために明示的に `"es"` にする(既定のままだと
  // ブラウザ側の `type: "module"` 指定と出力形式が食い違う)。
  worker: { format: "es" },
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
    // [T12] cross-origin isolation を有効化する(measureUserAgentSpecificMemory
    // の前提条件)。全リソースが同一オリジン(このプレビューサーバ自身)から
    // 配信されるので、COEP: require-corp が要求する Cross-Origin-Resource-Policy
    // ヘッダを個別リソースへ追加する必要は無い(CORP は異なるオリジンから
    // 読み込む no-cors リソースにのみ効く。同一オリジンは対象外)。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
