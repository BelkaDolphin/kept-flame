// ---------------------------------------------------------------------------
// 実機計測ページのパッケージング(T14) — `docs/先行計測計画_ドラフト.md` §2.1 T14 行
// 実施記録は `docs/design/perf-boundaries.md` の「T14 実施記録」節。
//
// `npm run bench:perf:build`(vite build, dist/perf/)・`npm run conformance:build`
// (vite build, dist/harness/)が出す**複数ファイル構成**(HTML + 別チャンクの JS、
// bench/perf.html はさらに catch-up Worker の別チャンクを持つ)を、
// **外部依存ゼロの単一 HTML ファイル**へインライン化して `dist/device/` に書き出す。
//
// なぜ post-build スクリプトか(vite plugin を足さない理由):
//   新規 npm 依存の追加が禁止(T14 依頼)されており、`vite-plugin-singlefile`
//   相当のインライン化を依存追加なしで行うには、ビルド後の出力(HTML + JS)を
//   テキスト操作で組み立て直すのが最短経路。ビルド設定自体
//   (`bench/vite.perf.config.ts` / `conformance/vite.harness.config.ts`)は
//   T10/T8 が計測境界に合わせて調整済みのため触らない。
//
// 対応が要る非自明な点(catch-up Worker の別チャンク):
//   `bench/perf.html` は `src/platform/workerClient.ts`
//   (このファイルは変更禁止)が `new Worker(new URL("./worker.ts", import.meta.url),
//   { type: "module" })` で Worker を起動する。Vite はこれを別チャンク
//   (`assets/worker-<hash>.js`)へ分離し、メインバンドル中に
//   `new URL("/assets/worker-<hash>.js", import.meta.url)` という**絶対パス**の
//   参照を残す。この絶対パスは file:// で開いた場合(実機でこのファイルを
//   タップして開く運用を想定)に解決できない。実測(dist/perf/assets/worker-*.js)
//   では worker チャンクは import/export を含まない完全に自己完結した平坦スクリプト
//   だったため、`new Blob([workerSourceCode], { type: "text/javascript" })` +
//   `URL.createObjectURL` で作った Blob URL に差し替えれば意味的に同一に動く。
//   ソースコード側(workerClient.ts/worker.ts)は一切変更せず、ビルド後の
//   テキストだけを書き換える。
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(TOOLS_DIR);

const DIST_PERF_DIR = join(PROJECT_ROOT, "dist", "perf");
const DIST_HARNESS_DIR = join(PROJECT_ROOT, "dist", "harness");
const BENCH_DIR = join(PROJECT_ROOT, "bench");
const OUT_DIR = join(PROJECT_ROOT, "dist", "device");

export class PackageDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageDeviceError";
  }
}

/** ビルド出力からアセットを読む関数の型(`href`/`src` の値 → ファイル内容)。 */
export type AssetReader = (assetHrefOrSrc: string) => string;

/**
 * `new Worker(new URL("/assets/xxx.js", import.meta.url), opts?)` 全体を検出する
 * (Vite/Rolldown の worker チャンク参照パターン)。実測(dist/perf/assets/perf-*.js):
 *   `new Worker(new URL(\`/assets/worker-XXXX.js\`,\`\`+import.meta.url),{type:\`module\`,name:\`kept-flame-catchup\`})`
 * バッククォート/ダブルクォート/シングルクォートいずれでも検出できるようにする。
 * オプション引数は(このリポジトリの用途では)ネストしたオブジェクトを含まない
 * ことを前提に `[^{}]*` で素朴に切り出す。
 */
const WORKER_CONSTRUCTOR_PATTERN =
  /new Worker\(\s*new URL\(\s*(`|"|')(\/assets\/[^`"']+\.[cm]?js)\1\s*,\s*(?:``\s*\+\s*)?import\.meta\.url\s*\)\s*(,\s*\{[^{}]*\})?\s*\)/g;

/**
 * バンドル済み JS の中の `new Worker(new URL("/assets/worker-*.js", import.meta.url), opts)` を
 * 埋め込み Blob URL 生成へ置き換える。マッチが 1 件も無ければ入力をそのまま返す
 * (harness バンドルのように Worker を持たないケース)。
 *
 * **`type: "module"` は落とす**(実測で判明した file:// 特有の制約への対処):
 * Chromium で `new Worker(blobUrl, { type: "module" })` を file:// 起点のページから
 * 呼ぶと、`onerror` が message 無しで無言に失敗することを最小再現で確認した
 * (`new Worker(blobUrl)`(type 省略 = classic)は同じ file:// 起点で成功する)。
 * 埋め込み対象の worker チャンクは import/export を一切含まない完全に自己完結した
 * 平坦スクリプトであることを実測で確認済み(`worker.ts`/`workerClient.ts` は
 * このパッケージングタスクの変更禁止対象だが、ビルド後のチャンク自体に
 * ESM 構文が残っていないため type 指定を落としても意味的に同一に動く)。
 */
export function inlineWorkerReferences(
  jsSource: string,
  readAsset: AssetReader,
): { readonly code: string; readonly inlinedAssetPaths: readonly string[] } {
  const inlinedAssetPaths: string[] = [];
  const rewritten = jsSource.replace(
    WORKER_CONSTRUCTOR_PATTERN,
    (_whole, _quote: string, assetPath: string, optionsText: string | undefined) => {
      inlinedAssetPaths.push(assetPath);
      const workerSource = readAsset(assetPath);
      // JSON.stringify は JS 文字列リテラルとして安全にエスケープしてくれる
      // (バッククォート/`${}`/改行/サロゲートペアを含め、素朴な手書きエスケープより頑健)。
      const blobUrlExpr = `__kfWorkerBlobUrl(${JSON.stringify(workerSource)})`;
      if (optionsText === undefined) return `new Worker(${blobUrlExpr})`;
      const strippedOptions = optionsText.replace(
        /\btype\s*:\s*(?:`module`|"module"|'module')\s*,?\s*/,
        "",
      );
      return `new Worker(${blobUrlExpr}${strippedOptions})`;
    },
  );
  if (inlinedAssetPaths.length === 0) {
    return { code: jsSource, inlinedAssetPaths };
  }
  const helper =
    "function __kfWorkerBlobUrl(code){" +
    'return URL.createObjectURL(new Blob([code],{type:"text/javascript"}));' +
    "}\n";
  return { code: helper + rewritten, inlinedAssetPaths };
}

const LINK_TAG = /<link\b([^>]*)>\s*/g;
const BUNDLED_SCRIPT_TAG = /<script\b([^>]*)><\/script>/g;

/**
 * Vite ビルド出力の HTML(`<link rel="stylesheet" href="...">` /
 * `<link rel="modulepreload" href="...">` / `<script ... src="...">`)を、
 * 対応するビルド成果物ディレクトリ内のファイル内容で置き換えて単一 HTML にする。
 * `readAsset` はテスト時にメモリ上のフィクスチャへ差し替えられるよう注入する。
 */
export function inlineBuiltHtml(html: string, readAsset: AssetReader): string {
  let out = html;

  out = out.replace(LINK_TAG, (whole, attrs: string) => {
    if (!/\brel="stylesheet"/.test(attrs)) return whole;
    const hrefMatch = /\bhref="([^"]+)"/.exec(attrs);
    if (hrefMatch?.[1] === undefined) return whole;
    const css = readAsset(hrefMatch[1]);
    return `<style>\n${css}\n</style>\n`;
  });

  // modulepreload はプリロードのヒントに過ぎず、対象は下の <script> インライン化で
  // 既に埋め込まれるので単純に削除する。
  out = out.replace(LINK_TAG, (whole, attrs: string) => {
    if (!/\brel="modulepreload"/.test(attrs)) return whole;
    return "";
  });

  out = out.replace(BUNDLED_SCRIPT_TAG, (whole, attrs: string) => {
    const srcMatch = /\bsrc="([^"]+)"/.exec(attrs);
    if (srcMatch?.[1] === undefined) return whole; // src の無いインラインスクリプトはそのまま
    const isModule = /\btype="module"/.test(attrs);
    const js = readAsset(srcMatch[1]);
    const { code } = inlineWorkerReferences(js, readAsset);
    // JS コード中に `</script` という文字列が(コメントや文字列リテラルとして)
    // 含まれていた場合に HTML パーサがタグ終了と誤認しないようにする。
    const safe = code.replace(/<\/script/gi, "<\\/script");
    return `<script${isModule ? ' type="module"' : ""}>\n${safe}\n</script>`;
  });

  return out;
}

/**
 * インライン化後に外部参照が残っていないことを検査する(自己完結の自己検査)。
 * 実機はネットワーク不安定/オフラインでも開けることが要件(先行計測計画 §6)。
 *
 * @throws {PackageDeviceError} 外部参照が 1 つでも残っている場合
 */
export function assertSelfContained(html: string, label: string): void {
  if (/<script\b[^>]*\ssrc="/i.test(html)) {
    throw new PackageDeviceError(`${label}: <script src="..."> のインライン化漏れが残っている`);
  }
  if (/<link\b[^>]*\brel="(?:stylesheet|modulepreload)"/i.test(html)) {
    throw new PackageDeviceError(
      `${label}: 外部 <link rel="stylesheet"|"modulepreload"> が残っている`,
    );
  }
  // HTML 属性は必ず直前に空白を伴う(`<tag attr="...">`)。JS の中の `a.src="http://x"`
  // のようなプロパティ代入は直前が `.` や `,` であり空白ではないため誤検出しない。
  if (/\s(?:src|href)="https?:\/\//i.test(html)) {
    throw new PackageDeviceError(`${label}: 外部 URL(http/https)への参照が残っている`);
  }
}

function readAssetFrom(distDir: string): AssetReader {
  return (hrefOrSrc: string): string => {
    const rel = hrefOrSrc.replace(/^\//, "");
    const path = join(distDir, rel);
    if (!existsSync(path)) {
      throw new PackageDeviceError(
        `${path} が無い(ビルド成果物が古い可能性。対応する build script を再実行すること)`,
      );
    }
    return readFileSync(path, "utf8");
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function requireBuiltHtml(distDir: string, htmlFileName: string): string {
  const path = join(distDir, htmlFileName);
  if (!existsSync(path)) {
    throw new PackageDeviceError(
      `${path} が無い。先に対応する npm run build script を実行すること` +
        `(dist/perf → "npm run bench:perf:build" / dist/harness → "npm run conformance:build")。`,
    );
  }
  return readFileSync(path, "utf8");
}

function packageBuiltHtml(distDir: string, htmlFileName: string, outFileName: string): number {
  const html = requireBuiltHtml(distDir, htmlFileName);
  const inlined = inlineBuiltHtml(html, readAssetFrom(distDir));
  assertSelfContained(inlined, outFileName);
  writeFileSync(join(OUT_DIR, outFileName), inlined, "utf8");
  return byteLength(inlined);
}

function packageStaticHtml(sourcePath: string, outFileName: string): number {
  if (!existsSync(sourcePath)) {
    throw new PackageDeviceError(`${sourcePath} が無い。`);
  }
  const html = readFileSync(sourcePath, "utf8");
  assertSelfContained(html, outFileName);
  writeFileSync(join(OUT_DIR, outFileName), html, "utf8");
  return byteLength(html);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const sizes: [name: string, bytes: number][] = [];
  sizes.push(["perf.html", packageBuiltHtml(DIST_PERF_DIR, "perf.html", "perf.html")]);
  sizes.push(["harness.html", packageBuiltHtml(DIST_HARNESS_DIR, "harness.html", "harness.html")]);
  // tags.html は T13 の時点で既に単一 HTML 自己完結(外部 script/CSS 無し)なので、
  // ビルドを経由せずソースをそのまま検査つきでコピーする。
  sizes.push(["tags.html", packageStaticHtml(join(BENCH_DIR, "tags.html"), "tags.html")]);

  const indexHtml = readFileSync(join(TOOLS_DIR, "deviceIndex.template.html"), "utf8");
  assertSelfContained(indexHtml, "index.html");
  writeFileSync(join(OUT_DIR, "index.html"), indexHtml, "utf8");
  sizes.push(["index.html", byteLength(indexHtml)]);

  console.log(`dist/device/ を書き出した(${String(sizes.length)} ファイル):`);
  for (const [name, bytes] of sizes) {
    console.log(`  ${name}: ${String(bytes)} B`);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
