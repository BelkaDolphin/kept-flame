// ---------------------------------------------------------------------------
// M44: scripts/check-llm-paths.mjs(ADR-021(2) guardrail)のテスト。
//
// 1. 現行リポジトリに対して実行し pass すること(検収条件の回帰テスト)。
// 2. CHECK_LLM_PATHS_ROOT でスキャン対象ルートを一時ディレクトリへ差し替え、
//    (a) 疑わしい経路を仕込んだフィクスチャで非ゼロ終了すること
//    (b) コメント行やクリーンな内容では誤検知せず 0 終了すること
//    を検証する。子プロセス経由にしているのは、このスクリプトが
//    「ファイル走査 → process.exit」までを1本のCLIとして完結させており、
//    import して呼べる純関数を外に出していないため。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-llm-paths.mjs");

type EnvRecord = Record<string, string | undefined>;

const tempDirs: string[] = [];

function makeFixtureRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-llm-paths-fixture-"));
  tempDirs.push(dir);
  return dir;
}

function writeCleanPackageJson(root: string) {
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: {}, devDependencies: {} }, null, 2),
    "utf8",
  );
}

function runCheck(root?: string) {
  const env: EnvRecord = { ...process.env };
  if (root) {
    env.CHECK_LLM_PATHS_ROOT = root;
  } else {
    delete env.CHECK_LLM_PATHS_ROOT;
  }
  return spawnSync(process.execPath, [SCRIPT_PATH], { env, encoding: "utf8" });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/check-llm-paths.mjs", () => {
  it("現行リポジトリでは LLM の自動実行経路を検出せず 0 終了する", () => {
    const result = runCheck();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("workflows ディレクトリが無いフィクスチャは 0 終了する", () => {
    const root = makeFixtureRoot();
    writeCleanPackageJson(root);
    const result = runCheck(root);
    expect(result.status).toBe(0);
  });

  it("anthropics/ 系 action の uses を仕込んだ workflow は非ゼロ終了する", () => {
    const root = makeFixtureRoot();
    writeCleanPackageJson(root);
    const workflowsDir = path.join(root, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      path.join(workflowsDir, "bad.yml"),
      [
        "name: Bad",
        "on: { workflow_dispatch: {} }",
        "jobs:",
        "  bad:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: anthropics/claude-code-action@v1",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = runCheck(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("anthropics/");
    expect(result.stderr).toContain("bad.yml:7");
  });

  it("ANTHROPIC_API_KEY への参照を仕込んだ workflow は非ゼロ終了する", () => {
    const root = makeFixtureRoot();
    writeCleanPackageJson(root);
    const workflowsDir = path.join(root, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      path.join(workflowsDir, "bad-secret.yml"),
      [
        "name: Bad",
        "on: { workflow_dispatch: {} }",
        "jobs:",
        "  bad:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
        "    steps:",
        "      - run: echo hi",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = runCheck(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("package.json の devDependencies に @anthropic-ai 系があれば非ゼロ終了する", () => {
    const root = makeFixtureRoot();
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        { name: "fixture", devDependencies: { "@anthropic-ai/sdk": "^1.0.0" } },
        null,
        2,
      ),
      "utf8",
    );
    const result = runCheck(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("@anthropic-ai/sdk");
  });

  it("コメント行のみに claude 系の記述がある workflow は誤検知せず 0 終了する", () => {
    const root = makeFixtureRoot();
    writeCleanPackageJson(root);
    const workflowsDir = path.join(root, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    // calibrate.yml と同じ形: ヘッダコメントに "CLAUDE.md" 等の記述があるが
    // 実行経路には一切現れないケース。誤検知しないことの回帰テスト。
    writeFileSync(
      path.join(workflowsDir, "clean.yml"),
      [
        "# このジョブは LLM/AIサービス連携は一切含まない(CLAUDE.md 絶対ルール)。",
        "# claude という単語もコメント中にしか出てこない。",
        "name: Clean",
        "on: { workflow_dispatch: {} }",
        "permissions:",
        "  contents: read",
        "jobs:",
        "  clean:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm ci",
        "      - run: npm test",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = runCheck(root);
    expect(result.status).toBe(0);
  });
});
