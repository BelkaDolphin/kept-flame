// ---------------------------------------------------------------------------
// Node ESM カスタムローダーフック — 拡張子省略の相対 import を解決する。
//
// tsconfig.json は `moduleResolution: "Bundler"` であり、リポジトリ全体
// (src/engine・schema 等)の相対 import は拡張子を書かない(Vite/vitest 側は
// これを解決できる)。一方 Node の素の ESM ローダーは拡張子省略の相対 specifier
// を解決できない(`import "./adjacency"` は失敗する)。
//
// `tools/genGoldenVectors.ts` は `node --experimental-strip-types` で直接
// 実行する必要があり(新規パッケージ依存を増やさない方針・golden-vector-spec.md
// §7.1)、かつ engine/schema 側のファイルは編集しない(import 文に拡張子を
// 足すような改変もしない)。よってこのファイルが「相対 specifier が拡張子無しで
// 見つからなければ .ts → .js の順に試す」フォールバックだけを行う、最小限の
// resolve フックになる。
//
// 使い方: `node --experimental-strip-types --import ./tools/tsLoaderRegister.mjs <entry>.ts`
// (`tools/tsLoaderRegister.mjs` がこのファイルを `node:module` の `register()` で登録する)
// ---------------------------------------------------------------------------

const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;
const FALLBACK_EXTENSIONS = [".ts", ".js"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
    for (const ext of FALLBACK_EXTENSIONS) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
