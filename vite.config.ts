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
    include: ["tests/**/*.spec.ts", "src/**/*.spec.ts"],
  },
});
