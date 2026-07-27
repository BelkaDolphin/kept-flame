// ---------------------------------------------------------------------------
// M44: scripts/preflight.mjs(ADR-021(1) 課金の壁)のテスト。
// 子プロセスで実際に node scripts/preflight.mjs を実行し、環境変数
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN の有無で終了コードが切り替わることを
// 検証する(スクリプト自体が「環境変数のみを見て判定する」薄いプロセスであり、
// 関数として import して単体テストする対象を持たないため child_process 経由の
// 統合テストのみで固定する)。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "preflight.mjs");

type EnvRecord = Record<string, string | undefined>;

function runPreflight(envOverrides: EnvRecord) {
  const env: EnvRecord = { ...process.env };
  // 実行環境がたまたま汚染されていても常に「未設定」から出発できるよう、
  // まず両方を明示的に削除してから上書きを適用する。
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  for (const key of Object.keys(envOverrides)) {
    const value = envOverrides[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync(process.execPath, [SCRIPT_PATH], { env, encoding: "utf8" });
}

describe("scripts/preflight.mjs", () => {
  it("ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN が未設定なら 0 終了する", () => {
    const result = runPreflight({});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("ANTHROPIC_API_KEY が設定されていれば非ゼロ終了する", () => {
    const result = runPreflight({ ANTHROPIC_API_KEY: "sk-ant-dummy-for-test" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("ANTHROPIC_AUTH_TOKEN が設定されていれば非ゼロ終了する", () => {
    const result = runPreflight({ ANTHROPIC_AUTH_TOKEN: "dummy-token-for-test" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("空文字列で設定されていても(キーが存在するだけで)非ゼロ終了する", () => {
    // ant CLI のドキュメントどおり ANTHROPIC_API_KEY="" も資格情報解決の優先枠を
    // 奪うため、値の truthiness ではなくキーの存在だけで判定すべき(スクリプト
    // 本体のコメント参照)。
    const result = runPreflight({ ANTHROPIC_API_KEY: "" });
    expect(result.status).not.toBe(0);
  });

  it("両方設定されていれば両方を報告したうえで非ゼロ終了する", () => {
    const result = runPreflight({
      ANTHROPIC_API_KEY: "sk-ant-dummy",
      ANTHROPIC_AUTH_TOKEN: "dummy-token",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY");
    expect(result.stderr).toContain("ANTHROPIC_AUTH_TOKEN");
  });
});
