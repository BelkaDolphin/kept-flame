#!/usr/bin/env node
/**
 * scripts/content-diff-gate.mjs
 *
 * ADR-015(1)(改訂)「symlink すり抜け対策」: content/** への変更パス強制が
 * 単純文字列一致だと、content/ 配下に置いた symlink(実体が .github/workflows/
 * や schema/ を指す)が文字列上通過しうる欠陥を修正する guardrail。
 *
 * 判定原理(Windows でも OS レベルの symlink 作成権限なしにテスト可能な設計 —
 * タスク指示の要求どおり):
 *   symlink かどうかを OS のファイルシステム API(fs.lstatSync 等)ではなく
 *   **git の index/tree の mode**(`git ls-files -s`)で判定する。
 *   git は symlink を常に blob + mode 120000 として記録し、この mode は
 *   `core.symlinks=false`(Windows で開発者モード/管理者権限が無い環境の既定)
 *   でチェックアウトされた場合でも変わらない(working tree 上はただのテキスト
 *   ファイルになるが、index/tree の mode は 120000 のまま)。したがって本
 *   スクリプトは実際の OS symlink を1つも作らずに「symlink が仕込まれた
 *   content/ 配下のエントリ」を検出できる。実際に
 *   `git update-index --add --cacheinfo 120000,<blob-sha>,content/x` で
 *   symlink エントリを作る手順は tests/scripts/content-diff-gate.test.ts が
 *   Windows 上でも実行して確認している(根拠は同テストファイル冒頭コメント)。
 *
 * 「checkout 時の symlink follow 禁止」について: actions/checkout 自体は
 * symlink を作るだけで中身を辿らない(follow しない)。真のリスクは
 * *その後* のツール(JSON.parse 目的の readFileSync、cp -rL 等)が symlink を
 * 辿って content/ 配下のファイルだと思い込んで .github/workflows/ 等を読み書き
 * してしまうことにある。本ゲートは「content の内容を1バイトも読む前」に
 * git mode だけで reject するため、後続のどのツールも symlink の実体へ
 * 到達する前に処理が止まる(＝ fs 経路で symlink を辿る箇所を本スクリプトは
 * 一切持たない=lstat 相当の「辿らない」判定のみで完結する)。
 *
 * 通常ファイル型限定チェック: content/ は JSON データ専用領域(ADR-015/023)
 * のため、許可する git mode は **100644(通常ファイル・非実行)のみ**。
 * 以下は全面 reject する:
 *   - 120000 (symlink)
 *   - 100755 (実行可能ファイル — data 専用領域に実行ビットは不要)
 *   - 160000 (gitlink/submodule)
 *   - 上記以外の未知 mode
 *
 * 使い方: node scripts/content-diff-gate.mjs (または npm run content:diff-gate)
 * 終了コード: 0 = content/ 配下は全件 通常ファイル(pass) / 非0 = 非通常ファイルを検出
 *
 * テスト用に CONTENT_DIFF_GATE_ROOT でスキャン対象リポジトリのルートを、
 * CONTENT_DIFF_GATE_DIR で対象ディレクトリ名(既定 "content")を上書きできる
 * (通常の利用では設定しない。tests/scripts/content-diff-gate.test.ts が
 * 一時 git リポジトリのフィクスチャ検証に使用)。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CONTENT_DIFF_GATE_ROOT
  ? path.resolve(process.env.CONTENT_DIFF_GATE_ROOT)
  : path.resolve(__dirname, "..");
const CONTENT_DIR = process.env.CONTENT_DIFF_GATE_DIR || "content";

// git ls-files -s の mode 列。100644(通常ファイル・非実行)のみ許可。
const ALLOWED_MODE = "100644";

const MODE_REASONS = {
  120000:
    "symlink(ADR-015(1): content/ 配下の symlink は実体が .github/workflows/ 等の" +
    "リポジトリ外領域を指すすり抜け経路になりうるため全面 reject)",
  100755: "実行可能ファイル(content/ は JSON データ専用領域のため非実行の通常ファイルのみ許可)",
  160000: "gitlink/submodule(content/ 配下に submodule を混入させることはできない)",
};

function reasonForMode(mode) {
  return MODE_REASONS[mode] ?? `未知の git mode "${mode}"(非通常ファイルとして全面 reject)`;
}

/**
 * `git ls-files -s` の1行を { mode, sha, stage, path } へ分解する(純関数・
 * テスト容易性のため export)。形式: "<mode> <sha> <stage>\t<path>"。
 */
export function parseLsFilesOutput(output) {
  const entries = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    const tabIndex = rawLine.indexOf("\t");
    if (tabIndex === -1) continue; // 想定外行(壊れた出力)は無視して安全側に倒す
    const head = rawLine.slice(0, tabIndex);
    const filePath = rawLine.slice(tabIndex + 1);
    const parts = head.split(" ");
    if (parts.length < 3) continue;
    const [mode, sha, stage] = parts;
    entries.push({ mode, sha, stage, path: filePath });
  }
  return entries;
}

/**
 * エントリ一覧を許可 mode と突き合わせ、違反を報告する(純関数・export)。
 */
export function classifyEntries(entries) {
  const violations = [];
  for (const entry of entries) {
    if (entry.mode !== ALLOWED_MODE) {
      violations.push({ path: entry.path, mode: entry.mode, reason: reasonForMode(entry.mode) });
    }
  }
  return violations;
}

/**
 * `git ls-files -s -- <contentDir>` を実行し生出力を返す(export: テストが
 * 一時リポジトリの cwd を指定して呼べるようにする)。
 */
export function runGitLsFiles(repoRoot, contentDir) {
  const result = spawnSync("git", ["ls-files", "-s", "--", contentDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    throw new Error(
      `git ls-files -s -- ${contentDir} に失敗しました(status=${String(result.status)}): ${stderr}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * ゲート本体(export: CLI からも単体テストからも同じ経路を通す)。
 */
export function checkContentDiffGate(repoRoot = REPO_ROOT, contentDir = CONTENT_DIR) {
  const output = runGitLsFiles(repoRoot, contentDir);
  const entries = parseLsFilesOutput(output);
  const violations = classifyEntries(entries);
  return { contentDir, entries, violations };
}

function main() {
  let result;
  try {
    result = checkContentDiffGate();
  } catch (err) {
    console.error(
      `[content-diff-gate] NG: 検査自体が失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  if (result.violations.length === 0) {
    console.log(
      `[content-diff-gate] OK: ${result.contentDir}/ 配下 ${String(result.entries.length)} 件、` +
        `すべて通常ファイル(git mode ${ALLOWED_MODE})。`,
    );
    process.exit(0);
    return;
  }

  console.error(
    `[content-diff-gate] NG: ${String(result.violations.length)} 件の非通常ファイルを ${result.contentDir}/ 配下に検出しました(ADR-015(1))。`,
  );
  for (const v of result.violations) {
    console.error(`  - ${v.path} (mode ${v.mode}): ${v.reason}`);
  }
  console.error("");
  console.error("対処: 該当パスを通常ファイル(git mode 100644)へ置き換えてください。");
  console.error(
    "symlink 経由で content/ 以外の場所(.github/workflows/ 等)を参照することはできません。",
  );
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
