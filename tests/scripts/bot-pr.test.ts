// ---------------------------------------------------------------------------
// M45: scripts/bot-pr.mjs(ADR-030(2)(3) [2026-07-28改訂])の純粋部分
// (CLI引数解析・トークンredact)のテスト。git push / GitHub API 呼出しは
// モックせず対象外とする(タスク指示: 「APIモックの重装備は不要」)。CLI 全体の
// ネットワーク込み動作確認は M45 の実演(bot作成PR)で行う。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { parseArgs, redact } from "../../scripts/bot-pr.mjs";

describe("parseArgs", () => {
  it("--branch と --title のみで base=main / remoteBranch=branch が既定になる", () => {
    const args = parseArgs(["--branch", "bot/demo", "--title", "docs: x"]);
    expect(args).toEqual({
      branch: "bot/demo",
      title: "docs: x",
      base: "main",
      remoteBranch: "bot/demo",
    });
  });

  it("--body / --base / --remote-branch を明示指定できる", () => {
    const args = parseArgs([
      "--branch",
      "bot/demo",
      "--title",
      "docs: x",
      "--body",
      "body text",
      "--base",
      "beta",
      "--remote-branch",
      "bot/demo-remote",
    ]);
    expect(args.body).toBe("body text");
    expect(args.base).toBe("beta");
    expect(args.remoteBranch).toBe("bot/demo-remote");
  });

  it("--body-file を保持する(読込自体はCLI本体の責務)", () => {
    const args = parseArgs(["--branch", "b", "--title", "t", "--body-file", "/tmp/x.md"]);
    expect(args.bodyFile).toBe("/tmp/x.md");
  });

  it("--branch が無ければ例外を投げる", () => {
    expect(() => parseArgs(["--title", "t"])).toThrow(/--branch は必須/);
  });

  it("--title が無ければ例外を投げる", () => {
    expect(() => parseArgs(["--branch", "b"])).toThrow(/--title は必須/);
  });

  it("未知の引数は例外を投げる", () => {
    expect(() => parseArgs(["--branch", "b", "--title", "t", "--wat", "x"])).toThrow(/未知の引数/);
  });
});

describe("redact", () => {
  it("トークン文字列を全て *** に置換する", () => {
    const text = "before ghs_abc123 middle ghs_abc123 after";
    expect(redact(text, "ghs_abc123")).toBe("before *** middle *** after");
  });

  it("token が未指定なら元の文字列をそのまま返す", () => {
    expect(redact("no secret here", undefined)).toBe("no secret here");
  });

  it("token が空文字列でも元の文字列をそのまま返す(空文字列splitで壊れる事故を回避)", () => {
    expect(redact("abc", "")).toBe("abc");
  });
});
