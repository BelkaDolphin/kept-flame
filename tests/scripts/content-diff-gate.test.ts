// ---------------------------------------------------------------------------
// M46: scripts/content-diff-gate.mjs(ADR-015(1) guardrail)のテスト。
//
// 判定は OS の symlink 作成権限に依存させず、git index/tree の mode
// (`git ls-files -s`)だけを見る設計にしてある(タスク指示: 「Windows 上で
// symlink 作成権限が無い場合がある」への対応)。そのため本テストは
// 一時ディレクトリに `git init` した使い捨てリポジトリへ
// `git update-index --add --cacheinfo 120000,<blob-sha>,<path>` で
// symlink エントリを**実際の OS symlink を1つも作らずに**仕込み、それが
// reject されることを確認する(根拠: git は `core.symlinks=false` の環境
// (Windows で開発者モード/管理者権限が無い既定)でチェックアウトされても
// index/tree 上の mode は 120000 のまま保持する — 事前に手元の Windows 環境で
// `git init` + `git hash-object -w --stdin` + `git update-index --cacheinfo` +
// `git ls-files -s` を実行し、symlink 特権なしで mode 120000 の行が得られる
// ことを確認済み)。
//
// 1. parseLsFilesOutput / classifyEntries: 純関数の単体テスト(git 不要)。
// 2. checkContentDiffGate: 一時 git リポジトリのフィクスチャで symlink /
//    実行可能ファイル / 通常ファイルを判別できることを確認。
// 3. 現行リポジトリ(このプロジェクト自身)に対して実行し、既存 content/*.json
//    5ファイルがすべて通常ファイルとして pass することを確認(回帰テスト)。
// 4. CLI(spawn)レベルでも同じ判定になることを確認(check-llm-paths.test.ts と
//    同じ CONTENT_DIFF_GATE_ROOT 環境変数によるルート差し替えパターン)。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkContentDiffGate,
  classifyEntries,
  parseLsFilesOutput,
} from "../../scripts/content-diff-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "content-diff-gate.mjs");

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[], input?: string) {
  // exactOptionalPropertyTypes: true のため、input 未指定時はプロパティ自体を
  // 省略する(input: undefined を明示的に持たせない)。
  const options =
    input === undefined
      ? { cwd, encoding: "utf8" as const }
      : { cwd, encoding: "utf8" as const, input };
  const result = spawnSync("git", args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} が失敗しました: ${result.stderr}`);
  }
  return result;
}

/** 空配列でないことを型的にも保証しつつ先頭要素を取り出す小ヘルパー。 */
function firstEntry<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error("要素が1件もありません(テストの前提が崩れています)");
  }
  return first;
}

/** 使い捨て git リポジトリを作る(コミットは不要、index 操作のみで完結)。 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "content-diff-gate-fixture-"));
  tempDirs.push(dir);
  runGit(dir, ["init", "-q"]);
  return dir;
}

/** 通常ファイルを作業ツリーに書いて `git add`(mode 100644 として index 化)。 */
function addRegularFile(dir: string, relPath: string, text: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  runGit(dir, ["add", "--", relPath]);
}

/**
 * 作業ツリーに実ファイルを一切作らず、blob を書き込んで任意の mode で
 * index へ直接登録する(symlink/実行可能ファイルを OS 特権なしで再現)。
 */
function addCacheEntry(dir: string, mode: string, relPath: string, blobText: string): void {
  const hashResult = runGit(dir, ["hash-object", "-w", "--stdin"], blobText);
  const sha = hashResult.stdout.trim();
  runGit(dir, ["update-index", "--add", "--cacheinfo", `${mode},${sha},${relPath}`]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseLsFilesOutput", () => {
  it("mode/sha/stage/path へ分解する(複数行・末尾改行あり)", () => {
    const output =
      "100644 daa5053ecf5f9a37b2de733d0751cc1ab53ac010 0\tcontent/real.json\n" +
      "120000 0092126 0\tcontent/evil.json\n";
    expect(parseLsFilesOutput(output)).toEqual([
      {
        mode: "100644",
        sha: "daa5053ecf5f9a37b2de733d0751cc1ab53ac010",
        stage: "0",
        path: "content/real.json",
      },
      { mode: "120000", sha: "0092126", stage: "0", path: "content/evil.json" },
    ]);
  });

  it("空文字列は空配列になる", () => {
    expect(parseLsFilesOutput("")).toEqual([]);
  });
});

describe("classifyEntries", () => {
  it("mode 100644 は違反にしない", () => {
    const violations = classifyEntries([
      { mode: "100644", sha: "x", stage: "0", path: "content/a.json" },
    ]);
    expect(violations).toEqual([]);
  });

  it("mode 120000(symlink)は違反として reject し理由に symlink を含む", () => {
    const violations = classifyEntries([
      { mode: "120000", sha: "x", stage: "0", path: "content/evil.json" },
    ]);
    expect(violations).toHaveLength(1);
    expect(firstEntry(violations).path).toBe("content/evil.json");
    expect(firstEntry(violations).reason).toContain("symlink");
  });

  it("mode 100755(実行可能ファイル)は違反として reject する", () => {
    const violations = classifyEntries([
      { mode: "100755", sha: "x", stage: "0", path: "content/exec.sh" },
    ]);
    expect(violations).toHaveLength(1);
    expect(firstEntry(violations).reason).toContain("実行可能ファイル");
  });

  it("mode 160000(gitlink/submodule)は違反として reject する", () => {
    const violations = classifyEntries([
      { mode: "160000", sha: "x", stage: "0", path: "content/sub" },
    ]);
    expect(violations).toHaveLength(1);
    expect(firstEntry(violations).reason).toContain("submodule");
  });
});

describe("checkContentDiffGate — 一時 git リポジトリのフィクスチャ", () => {
  it("通常ファイルのみなら違反ゼロ", () => {
    const dir = makeFixtureRepo();
    addRegularFile(dir, "content/real.json", '{"a":1}\n');
    const result = checkContentDiffGate(dir, "content");
    expect(result.violations).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it("content/ 配下に .github/workflows/ を指す symlink を仕込むと reject される(検収条件)", () => {
    const dir = makeFixtureRepo();
    addRegularFile(dir, "content/real.json", '{"a":1}\n');
    // 実際の OS symlink は作らず、symlink の実体テキスト(相対パス)を持つ
    // blob を mode 120000 で index に直接登録する。
    addCacheEntry(dir, "120000", "content/evil.json", "../.github/workflows/calibrate.yml");
    const result = checkContentDiffGate(dir, "content");
    expect(result.violations).toHaveLength(1);
    const violation = firstEntry(result.violations);
    expect(violation.path).toBe("content/evil.json");
    expect(violation.mode).toBe("120000");
    expect(violation.reason).toContain("symlink");
    // 正常ファイルは巻き込まれず素通りする(誤検知しない)ことも確認。
    expect(result.entries.map((e) => e.path)).toContain("content/real.json");
  });

  it("content/ 配下の実行可能ファイル(mode 100755)も reject される", () => {
    const dir = makeFixtureRepo();
    addCacheEntry(dir, "100755", "content/exec.sh", "#!/bin/sh\necho hi\n");
    const result = checkContentDiffGate(dir, "content");
    expect(result.violations).toHaveLength(1);
    expect(firstEntry(result.violations).path).toBe("content/exec.sh");
  });

  it("content/ ディレクトリが存在しないリポジトリは違反ゼロ(ENOENT相当を安全側で扱う)", () => {
    const dir = makeFixtureRepo();
    // content/ を一切作らない。
    const result = checkContentDiffGate(dir, "content");
    expect(result.violations).toEqual([]);
    expect(result.entries).toEqual([]);
  });
});

describe("checkContentDiffGate — 現行リポジトリでの回帰確認", () => {
  it("実際の content/*.json 5ファイルはすべて通常ファイルとして pass する", () => {
    const result = checkContentDiffGate(REPO_ROOT, "content");
    expect(result.violations).toEqual([]);
    expect(result.entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of result.entries) {
      expect(entry.mode).toBe("100644");
    }
  });
});

describe("CLI(spawn) — node scripts/content-diff-gate.mjs", () => {
  it("現行リポジトリでは 0 終了し OK を出力する", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("symlink を仕込んだフィクスチャは非ゼロ終了し reject 理由を stderr へ出す", () => {
    const dir = makeFixtureRepo();
    addRegularFile(dir, "content/real.json", '{"a":1}\n');
    addCacheEntry(dir, "120000", "content/evil.json", "../.github/workflows/calibrate.yml");

    const env = { ...process.env, CONTENT_DIFF_GATE_ROOT: dir };
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("content/evil.json");
    expect(result.stderr).toContain("symlink");
  });

  it("通常ファイルのみのフィクスチャは 0 終了する", () => {
    const dir = makeFixtureRepo();
    addRegularFile(dir, "content/real.json", '{"a":1}\n');

    const env = { ...process.env, CONTENT_DIFF_GATE_ROOT: dir };
    const result = spawnSync(process.execPath, [SCRIPT_PATH], { env, encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
