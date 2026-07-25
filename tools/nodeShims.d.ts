// ---------------------------------------------------------------------------
// 最小限の Node.js 組み込みモジュール型宣言。
//
// リポジトリは ADR-001(依存最小)に従い `@types/node` を devDependencies に
// 持たない(既存コードは engine/schema/tests のいずれも Node 組み込み API に
// 依存しないため今まで不要だった)。golden vector 生成器(`tools/`)と
// シナリオ実装(`conformance/`)は content JSON の読み書きに `node:fs` 等を
// 必要とするが、そのためだけに `@types/node` パッケージ全体を追加するのは
// 依存最小の方針に反する。よってここでは**実際に呼ぶ関数のシグネチャだけ**を
// 自前で宣言する(ambient 宣言はプロジェクト全体に効くが、engine 側の
// `process`/`node:*` 使用は eslint.config.js の no-restricted-globals
// (GLOBAL_HOST_ENV/GLOBAL_IO)が型とは独立に禁止し続ける)。
// ---------------------------------------------------------------------------

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function mkdirSync(path: string, options?: { readonly recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:module" {
  export function register(specifier: string, parentURL?: string | URL): void;
}

declare module "node:path" {
  export function join(...parts: readonly string[]): string;
  export function dirname(path: string): string;
}

declare const process: {
  readonly argv: readonly string[];
  exitCode: number | undefined;
};
