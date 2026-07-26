// ---------------------------------------------------------------------------
// conformance ハーネス専用の Vite 設定(T8)。
//
// ルート `vite.config.ts` は vitest 共有設定(`environment: "node"`)であり、
// T7 側の並行エージェントとも共有しているため触らない。ハーネスは
// ブラウザ向けビルド(`client` 環境・`conformance/harness.html` を entry)を
// 必要とするので、独立した設定ファイルとして分離する。
//
// 設計判断: `vite dev` ではなく `vite build` + `vite preview` を使う。
// 理由は (a) 3 エンジンでの bit 一致計測は dev サーバ特有の未バンドル ESM
// グラフ・HMR websocket 等の複雑さを持ち込まない方が再現性が高い、
// (b) Playwright + Vite の一般的な推奨は「本番相当ビルドに対して E2E を回す」
// ことである、(c) `npm run build`(本番)と同じコード経路(esbuild/rolldown の
// バンドル・minify)を通すことで、実運用に近い形で決定論を確認できる。
// ---------------------------------------------------------------------------

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: HERE,
  // 本体アプリの `dist/` と衝突しないよう別名にする(.gitignore の `dist/` に
  // 既に含まれるので追加のトラッキング除外設定は不要)。
  build: {
    outDir: resolve(HERE, "..", "dist", "harness"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(HERE, "harness.html"),
    },
  },
  preview: {
    port: 4319,
    strictPort: true,
  },
});
