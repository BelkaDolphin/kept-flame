import { defineConfig } from "vitest/config";

// Vite build config and Vitest test config, shared in a single file
// (kept-flame has no separate vitest.config.ts by design).
//
// JSX is intentionally NOT configured here: Vite reads `jsx` /
// `jsxImportSource` straight from tsconfig.json's compilerOptions, which
// already point at Preact. That keeps devDependencies minimal (no
// @preact/preset-vite) without adding an explicit `esbuild` dependency
// just for its TransformOptions type.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
    // [M71 ついで処置・台帳v19 記録-2] purity.test.ts(ESLint 実行×多数)/
    // calibrate.test.ts・recallFrequency.test.ts(sim 実行込み)は単体では
    // 6〜16秒級で常に全 pass するが、フル実行(全ファイル並列)時は他ファイルとの
    // CPU 競合でこの所要時間が伸び、既定の 5000ms を超えて
    // "Test timed out in 5000ms" で確率的に fail する(assertion 破れではなく
    // 実行時間不足=フレーク)。テスト本体のassertionは一切変更せず、既定の
    // testTimeout を引き上げて解消する(vitest 設定のみの変更で対応可能な
    // ため、重いテストの逐次化は行わない)。
    testTimeout: 60_000,
  },
});
