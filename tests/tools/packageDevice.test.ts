// ---------------------------------------------------------------------------
// T14: 実機計測ページのパッケージング(tools/packageDevice.ts)のロジック部テスト。
// 実ファイルシステム(dist/perf・dist/harness)には依存せず、`readAsset` を
// メモリ上のフィクスチャへ差し替えて純関数だけを固定する。
// (dist/device/*.html が実際に file:// で動くことの確認は
//  bench/deviceSmoke.spec.ts が Playwright chromium で行う。)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  assertSelfContained,
  inlineBuiltHtml,
  inlineWorkerReferences,
  PackageDeviceError,
  type AssetReader,
} from "../../tools/packageDevice";

// 実測(dist/perf/assets/perf-*.js)の形をそのまま模した最小フィクスチャ。
const WORKER_CTOR_WITH_OPTIONS =
  "const w=new Worker(new URL(`/assets/worker-ABC123.js`,``+import.meta.url)," +
  "{type:`module`,name:`kept-flame-catchup`});";

describe("inlineWorkerReferences", () => {
  it("Worker(new URL(...)) を Blob URL 生成へ置き換え、type: module を落とす", () => {
    const readAsset: AssetReader = (path) => {
      expect(path).toBe("/assets/worker-ABC123.js");
      return "postMessage('hi');";
    };
    const { code, inlinedAssetPaths } = inlineWorkerReferences(WORKER_CTOR_WITH_OPTIONS, readAsset);
    expect(inlinedAssetPaths).toEqual(["/assets/worker-ABC123.js"]);
    expect(code).toContain("function __kfWorkerBlobUrl(code)");
    expect(code).toContain("URL.createObjectURL(new Blob([code]");
    expect(code).toContain(JSON.stringify("postMessage('hi');"));
    // 埋め込み後は元の /assets/ 参照も type:"module" も残っていない。
    expect(code).not.toContain("/assets/worker-ABC123.js");
    expect(code).not.toContain("type:`module`");
    // name オプションは残す。
    expect(code).toContain("name:`kept-flame-catchup`");
    expect(code).toContain("new Worker(__kfWorkerBlobUrl(");
  });

  it("オプション引数が無い new Worker(new URL(...)) も置き換えられる", () => {
    const src = "new Worker(new URL(`/assets/w.js`,``+import.meta.url));";
    const { code, inlinedAssetPaths } = inlineWorkerReferences(src, () => "1;");
    expect(inlinedAssetPaths).toEqual(["/assets/w.js"]);
    expect(code).toContain("new Worker(__kfWorkerBlobUrl(");
  });

  it("Worker 参照が無い入力はそのまま返し、ヘルパー関数を足さない", () => {
    const src = "const x = 1 + 1;";
    const { code, inlinedAssetPaths } = inlineWorkerReferences(src, () => {
      throw new Error("readAsset は呼ばれてはならない");
    });
    expect(code).toBe(src);
    expect(inlinedAssetPaths).toEqual([]);
  });

  it("ダブルクォート/シングルクォートの URL リテラルも検出する", () => {
    const src = 'new Worker(new URL("/assets/w2.js", import.meta.url));';
    const { inlinedAssetPaths } = inlineWorkerReferences(src, () => "2;");
    expect(inlinedAssetPaths).toEqual(["/assets/w2.js"]);
  });
});

describe("inlineBuiltHtml", () => {
  const fixtures: Record<string, string> = {
    "/assets/main-XYZ.js": "console.log('main');",
    "/assets/style-XYZ.css": "body{color:red}",
  };
  const readAsset: AssetReader = (path) => {
    const content = fixtures[path];
    if (content === undefined) throw new Error(`no fixture for ${path}`);
    return content;
  };

  it("<link rel=stylesheet> を <style> へ、<script src> を inline <script> へ置き換える", () => {
    const html =
      "<html><head>" +
      '<link rel="stylesheet" href="/assets/style-XYZ.css">' +
      '<script type="module" crossorigin src="/assets/main-XYZ.js"></script>' +
      "</head><body></body></html>";
    const out = inlineBuiltHtml(html, readAsset);
    expect(out).toContain("<style>\nbody{color:red}\n</style>");
    expect(out).toContain("<script type=\"module\">\nconsole.log('main');\n</script>");
    expect(out).not.toContain("/assets/");
    expect(out).not.toContain("<link");
  });

  it("<link rel=modulepreload> は単純に削除する", () => {
    const html =
      '<link rel="modulepreload" href="/assets/other.js">' +
      '<script type="module" src="/assets/main-XYZ.js"></script>';
    const out = inlineBuiltHtml(html, readAsset);
    expect(out).not.toContain("modulepreload");
  });

  it("src の無いインラインスクリプトはそのまま残す", () => {
    const html = "<script>var x = 1;</script>";
    const out = inlineBuiltHtml(html, readAsset);
    expect(out).toBe(html);
  });

  it("JS コード中の </script> をエスケープして HTML パーサの誤認を防ぐ", () => {
    fixtures["/assets/danger.js"] = 'var s = "</script><script>alert(1)</script>";';
    const html = '<script type="module" src="/assets/danger.js"></script>';
    const out = inlineBuiltHtml(html, readAsset);
    expect(out).toContain("<\\/script>");
    // パーサが本物のタグ終端と誤認する生の "</script>" を残していない。
    const bodyOnly = out.replace(/^<script type="module">\n/, "").replace(/\n<\/script>$/, "");
    expect(bodyOnly.includes("</script>")).toBe(false);
  });
});

describe("assertSelfContained", () => {
  it("外部参照が無ければ何も起きない", () => {
    expect(() => assertSelfContained("<html><body>ok</body></html>", "test")).not.toThrow();
  });

  it("<script src=...> が残っていたら例外を投げる", () => {
    expect(() => assertSelfContained('<script src="/assets/x.js"></script>', "test")).toThrow(
      PackageDeviceError,
    );
  });

  it("外部 <link rel=stylesheet> が残っていたら例外を投げる", () => {
    expect(() =>
      assertSelfContained('<link rel="stylesheet" href="/assets/x.css">', "test"),
    ).toThrow(PackageDeviceError);
  });

  it("http(s) の href/src 属性が残っていたら例外を投げる", () => {
    expect(() =>
      assertSelfContained('<link rel="icon" href="https://cdn.example.com/x.png">', "test"),
    ).toThrow(PackageDeviceError);
  });

  it('SVG の <use href="#..."> のようなフラグメント参照は誤検出しない', () => {
    expect(() =>
      assertSelfContained('<svg><use href="#kf-tag-heat-full"></use></svg>', "test"),
    ).not.toThrow();
  });

  it("JS 文字列内の href/src らしき部分文字列は誤検出しない(直前が空白でないため)", () => {
    // ミニファイされた JS では `.src=`/`.href=` の直前は `.` であり空白にならない。
    const html = '<script type="module">a.src="https://example.com/x";</script>';
    expect(() => assertSelfContained(html, "test")).not.toThrow();
  });
});
