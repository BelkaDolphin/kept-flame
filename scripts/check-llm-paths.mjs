#!/usr/bin/env node
/**
 * scripts/check-llm-paths.mjs
 *
 * guardrail: リポジトリに「LLM の自動実行経路」(headless実行 / GitHub Actions
 * への Claude 連携 / Claude Agent SDK 使用 / Routines)が存在しないことを検査する
 * (ADR-021(2)、CLAUDE.md 絶対ルール「LLM の自動実行経路を追加しない」)。
 *
 * 検査内容:
 *   1. .github/workflows/*.yml(*.yaml) を走査し、コメント行を除いた各行から
 *      以下を検出:
 *        a. `uses:` が anthropics/ 系 action を参照している
 *        b. `claude` / `claude-code` CLI らしき呼び出し(語境界一致。
 *           "anthropics/claude-code-action" のようなフォーク名も
 *           "/" "-" が非単語文字であるため同一パターンで拾われる)
 *        c. `ANTHROPIC_API_KEY` という文字列への参照(secrets 経由の
 *           API キー配線)
 *        d. `@anthropic-ai/` 系パッケージ名への参照(ワークフロー内で
 *           直接 npx/npm install する Agent SDK 等を含む)
 *   2. package.json の dependencies / devDependencies / optionalDependencies /
 *      peerDependencies に `@anthropic-ai/*` 系パッケージが入っていないか
 *
 * 誤検知対策: YAML のコメント行(行頭が # のみの行)は上記 a〜d の走査対象から
 * 除外する。既存の .github/workflows/calibrate.yml はヘッダコメント中に
 * "CLAUDE.md 絶対ルール" という記述を持つが、(i) コメント行除外と (ii) 大文字小文字を
 * 区別する小文字 "claude" のみを対象にする(b)の2重の理由で誤検出しない
 * (CLAUDE.md は大文字表記のため (b) には元々マッチしない)。
 *
 * 検査対象外(このスクリプトの検出原理では判定不能なもの。ADR-021 の残余
 * リスク「課金経路は git diff から原理的に判定不能」と同種の限界):
 *   - YAML の構文解析はせず正規表現による文字列走査のみ。アンカー/エイリアス、
 *     複合アクション(別リポジトリの composite action)の中身までは追えない
 *   - 別リポジトリを参照する reusable workflow
 *     (`uses: owner/repo/.github/workflows/x.yml@ref`)が呼び先で LLM 連携を
 *     行っていても、その中身はこの検査の対象外
 *   - 文字列連結・環境変数展開・base64 等で難読化された参照は検出できない
 *   - "ANTHROPIC" を含まない名前へリネームされた secrets 経由の API キー配線
 *     (例: `MY_KEY: ${{ secrets.RENAMED }}` が実質 Anthropic API キーを運ぶ場合)
 *   - ワークフロー実行時に `npm install -g` 等で動的インストールされる、
 *     package.json 未記載の CLI(ワークフロー内の記述は (1)-d で部分的に
 *     カバーするが、外部スクリプト経由の間接インストールまでは追えない)
 *   - どの課金経路(Pro/Max 対話枠 か API キー従量か)で生成されたかの判定
 *     そのもの(ADR-021 のとおり原理的にコード/設定からは判定不能。
 *     このスクリプトが検出するのはあくまで「経路が存在するリスク」であり、
 *     ローカル起動前チェックは scripts/preflight.mjs が別途担う)
 *
 * テスト用に CHECK_LLM_PATHS_ROOT 環境変数でスキャン対象ルートを上書きできる
 * (通常の利用では設定しない。tests/scripts/check-llm-paths.test.ts がフィクス
 * チャ検証に使用)。
 *
 * 使い方: node scripts/check-llm-paths.mjs (または npm run check:llm-paths)
 * 終了コード: 0 = 検出項目なし(pass)/ 非0 = 疑わしい経路を検出(該当行を報告)
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CHECK_LLM_PATHS_ROOT
  ? path.resolve(process.env.CHECK_LLM_PATHS_ROOT)
  : path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

const COMMENT_LINE_RE = /^\s*#/;
const USES_ANTHROPICS_RE = /uses:\s*["']?anthropics\//;
const CLAUDE_CLI_RE = /\bclaude(-code)?\b/; // 大文字小文字を区別(CLAUDE.md 等の誤検知を避ける)
const ANTHROPIC_API_KEY_STR = "ANTHROPIC_API_KEY";
const ANTHROPIC_AI_PKG_STR = "@anthropic-ai/";

const violations = [];

function listWorkflowFiles() {
  let entries;
  try {
    entries = readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => path.join(WORKFLOWS_DIR, entry.name))
    .sort();
}

function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function scanWorkflowFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const file = relPath(filePath);

  lines.forEach((line, index) => {
    if (COMMENT_LINE_RE.test(line)) return; // コメント行は対象外
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (trimmed === "") return;

    if (USES_ANTHROPICS_RE.test(line)) {
      violations.push({
        file,
        line: lineNo,
        reason: "anthropics/ 系 action の uses",
        text: trimmed,
      });
    }
    if (CLAUDE_CLI_RE.test(line)) {
      violations.push({
        file,
        line: lineNo,
        reason: "claude CLI らしき呼び出し",
        text: trimmed,
      });
    }
    if (line.includes(ANTHROPIC_API_KEY_STR)) {
      violations.push({
        file,
        line: lineNo,
        reason: "ANTHROPIC_API_KEY への参照",
        text: trimmed,
      });
    }
    if (line.includes(ANTHROPIC_AI_PKG_STR)) {
      violations.push({
        file,
        line: lineNo,
        reason: "@anthropic-ai/ 系パッケージへの参照(Agent SDK 等)",
        text: trimmed,
      });
    }
  });
}

for (const file of listWorkflowFiles()) {
  scanWorkflowFile(file);
}

// package.json の全 dependencies 系フィールドを検査。
const pkgPath = path.join(REPO_ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
for (const field of DEPENDENCY_FIELDS) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const name of Object.keys(deps)) {
    if (name.startsWith(ANTHROPIC_AI_PKG_STR)) {
      violations.push({
        file: "package.json",
        line: null,
        reason: `${field} に @anthropic-ai/* 系パッケージ`,
        text: `"${name}": "${deps[name]}"`,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("[check:llm-paths] OK: LLM の自動実行経路は検出されませんでした。");
  process.exit(0);
}

console.error(`[check:llm-paths] NG: ${violations.length} 件の疑わしい経路を検出しました。`);
for (const v of violations) {
  const loc = v.line === null ? v.file : `${v.file}:${v.line}`;
  console.error(`  - [${v.reason}] ${loc}`);
  console.error(`      ${v.text}`);
}
console.error("");
console.error("CLAUDE.md 絶対ルール: LLM の自動実行経路(headless、GitHub Actions 連携、");
console.error("Agent SDK、Routines)を追加しないこと。誤検知の場合は本スクリプトの検査ロジック");
console.error("側を直すこと(既存の .github/workflows/calibrate.yml のような LLM 要素ゼロの");
console.error("workflow は変更しない)。");

process.exit(1);
