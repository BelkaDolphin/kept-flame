// ---------------------------------------------------------------------------
// [M61/FC5] GDD画面番号(①〜⑬)のUI露出掃討・機械検証(束Bの前例に倣う)。
//
// プレイテスト R1-A18 が「大移動ナップサックUI」「①ホームハブへ」等、GDD 6.6
// の丸数字・内部設計名がナビ/本文へ生露出していることを指摘した(束B掃討からの
// 退行)。手作業の grep だけでは今後また混入しうるので、`src/ui/**/*.tsx` の
// **コメントを除いた実レンダリング対象部分**に丸数字が 1 つも残っていないことを
// 機械的に固定する。
//
// コメント(`// ...` / `/* ... */`。JSX の `{/* ... */}` も通常の block comment
// なので同じ正規表現で落ちる)は対象外——設計文書としての `M32 ⑧冒険記ビューア`
// 等の履歴コメントは残してよい(このタスク自身の doc も含む)。丸数字は日本語の
// 通常の文中には現れない記号なので、単純な正規表現除去で誤検出/見逃しの実害は
// 無い(このリポジトリの規約上、丸数字はコメントか画面文言にしか出ない)。
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_ROOT = "src/ui";
const CIRCLED_NUMBER_PATTERN = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬]/;
// [R5-A03/D1] 「GDD 6.7」等の内部文書番号がプレイヤー文言へ露出した実例
// (M63 の R4-A01 修正が作り込んだリグレッション・Round 5 実測)。丸数字と同じく
// コメント外の実文字列に「GDD+数字」が現れることは正当な理由が無いので機械固定する。
const GDD_DOC_NUMBER_PATTERN = /GDD\s?\d/;

function collectUiSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectUiSourceFiles(full));
    } else if (entry.isFile() && (full.endsWith(".tsx") || full.endsWith(".ts"))) {
      // [R5-A03] .tsx 限定だと facilityEffect.ts(文言ヘルパの .ts)が走査から
      // 漏れる——GDD 6.7 露出を見逃した実際の穴。文言は .ts ヘルパにも置かれる
      // ため両拡張子を対象にする。
      out.push(full);
    }
  }
  return out;
}

/** 行コメント/ブロックコメント(JSX の `{/* *\/}` を含む)を落とす。 */
function stripComments(source: string): string {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlock.replace(/\/\/[^\n]*/g, "");
}

describe("GDD画面番号(①〜⑬)・内部文書番号のUI露出掃討", () => {
  it("src/ui/**/*.{ts,tsx} のコメント外に丸数字が1つも残っていない", () => {
    const offenders: { readonly file: string; readonly snippet: string }[] = [];
    for (const file of collectUiSourceFiles(UI_ROOT)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      const match = CIRCLED_NUMBER_PATTERN.exec(stripped);
      if (match !== null) {
        offenders.push({
          file,
          snippet: stripped.slice(Math.max(0, match.index - 20), match.index + 20),
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[R5-A03/D1] src/ui/**/*.{ts,tsx} のコメント外に「GDD+数字」が1つも残っていない", () => {
    const offenders: { readonly file: string; readonly snippet: string }[] = [];
    for (const file of collectUiSourceFiles(UI_ROOT)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      const match = GDD_DOC_NUMBER_PATTERN.exec(stripped);
      if (match !== null) {
        offenders.push({
          file,
          snippet: stripped.slice(Math.max(0, match.index - 20), match.index + 20),
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("走査対象が空でないこと(誤ってUI_ROOTが空/存在しないディレクトリになっていないかの自己点検)", () => {
    expect(collectUiSourceFiles(UI_ROOT).length).toBeGreaterThan(20);
  });
});
