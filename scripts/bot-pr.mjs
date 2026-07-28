#!/usr/bin/env node
/**
 * scripts/bot-pr.mjs
 *
 * コミット済みのローカルブランチを GitHub App `kept-flame-bot` のインストール
 * トークンで push し、Pull Requests API で PR を作成する(ADR-030(2)(3)
 * [2026-07-28改訂]・M45)。PR の作成者が `kept-flame-bot[bot]` になる
 * (= 運営者本人 = CODEOWNERS レビュアーと別 identity になり、self-approve
 * デッドロックを解消する)。
 *
 * 使い方(npm run bot:pr -- ... でも同じ):
 *   KEPT_FLAME_BOT_TOKEN=<bot-token.mjs の出力> node scripts/bot-pr.mjs \
 *     --branch <ローカルブランチ名> --title "<PRタイトル>" --body "<PR本文>"
 *
 * 典型的な連携(PowerShell):
 *   $env:KEPT_FLAME_BOT_TOKEN = node scripts/bot-token.mjs
 *   node scripts/bot-pr.mjs --branch bot/demo --title "docs: ..." --body "..."
 *
 * 引数:
 *   --branch <name>         (必須) push するローカルブランチ名(既にコミット済みである前提)。
 *   --title <text>          (必須) PR タイトル。
 *   --body <text>           (省略可) PR 本文。既定は空文字列。
 *   --body-file <path>      (省略可) PR 本文をファイルから読む(複数行本文向け)。
 *                           --body と両方指定された場合は --body-file を優先する。
 *   --base <branch>         (省略可) マージ先ブランチ。既定 "main"。
 *   --remote-branch <name>  (省略可) push 先のリモートブランチ名。既定は --branch と同じ。
 *
 * 環境変数:
 *   KEPT_FLAME_BOT_TOKEN  (必須) scripts/bot-token.mjs が発行したインストールトークン。
 *   KEPT_FLAME_BOT_OWNER  (省略可) 対象リポジトリの owner。既定 "BelkaDolphin"。
 *   KEPT_FLAME_BOT_REPO   (省略可) 対象リポジトリ名。既定 "kept-flame"。
 *
 * 🔒 トークンの取り扱い: push 用のリモート URL にはトークンを埋め込むが、
 * 標準出力・標準エラーには一切そのまま出さない(git の出力にたまたま URL が
 * 混ざった場合に備え、出力前にトークン文字列を "***" へ置換して redact する)。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const DEFAULT_OWNER = "BelkaDolphin";
const DEFAULT_REPO = "kept-flame";
const DEFAULT_BASE = "main";
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "kept-flame-bot-pr-script";

/** CLI引数の解析(純関数・テスト容易性のため export)。 */
export function parseArgs(argv) {
  const args = { base: DEFAULT_BASE };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--branch":
        args.branch = argv[++i];
        break;
      case "--title":
        args.title = argv[++i];
        break;
      case "--body":
        args.body = argv[++i];
        break;
      case "--body-file":
        args.bodyFile = argv[++i];
        break;
      case "--base":
        args.base = argv[++i];
        break;
      case "--remote-branch":
        args.remoteBranch = argv[++i];
        break;
      default:
        throw new Error(`未知の引数です: ${token}`);
    }
  }
  if (!args.branch) throw new Error("--branch は必須です");
  if (!args.title) throw new Error("--title は必須です");
  if (!args.remoteBranch) args.remoteBranch = args.branch;
  return args;
}

/** ログ出力前にトークン文字列を隠す(純関数・テスト容易性のため export)。 */
export function redact(text, token) {
  if (!token) return text;
  return text.split(token).join("***");
}

function runGit(gitArgs, { token } = {}) {
  const result = spawnSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  const safeStdout = redact(result.stdout ?? "", token);
  const safeStderr = redact(result.stderr ?? "", token);
  return { status: result.status, stdout: safeStdout, stderr: safeStderr };
}

function resolveBody(args) {
  if (args.bodyFile) {
    return readFileSync(args.bodyFile, "utf8");
  }
  return args.body ?? "";
}

async function githubRequest(method, apiPath, token, body) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function findExistingPr(owner, repo, token, headBranch, base) {
  const result = await githubRequest(
    "GET",
    `/repos/${owner}/${repo}/pulls?head=${owner}:${headBranch}&base=${base}&state=open`,
    token,
  );
  if (result.ok && Array.isArray(result.json) && result.json.length > 0) {
    const [existing] = result.json;
    return existing;
  }
  return undefined;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[bot-pr] NG: ${err.message}`);
    console.error(
      '使い方: node scripts/bot-pr.mjs --branch <name> --title "<title>" --body "<body>" [--base main] [--body-file <path>]',
    );
    process.exitCode = 1;
    return;
  }

  const token = process.env.KEPT_FLAME_BOT_TOKEN;
  if (!token) {
    console.error("[bot-pr] NG: 環境変数 KEPT_FLAME_BOT_TOKEN が未設定です。");
    console.error("  例 (PowerShell): $env:KEPT_FLAME_BOT_TOKEN = node scripts/bot-token.mjs");
    process.exitCode = 1;
    return;
  }

  const owner = process.env.KEPT_FLAME_BOT_OWNER || DEFAULT_OWNER;
  const repo = process.env.KEPT_FLAME_BOT_REPO || DEFAULT_REPO;

  let body;
  try {
    body = resolveBody(args);
  } catch (err) {
    console.error(`[bot-pr] NG: --body-file の読み込みに失敗しました: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  // ローカルブランチが実在するか事前確認(存在しないブランチを push しようとして
  // わかりにくいエラーになるのを避ける)。
  const verify = runGit(["rev-parse", "--verify", args.branch]);
  if (verify.status !== 0) {
    console.error(`[bot-pr] NG: ローカルブランチ "${args.branch}" が見つかりません。`);
    console.error(verify.stderr);
    process.exitCode = 1;
    return;
  }

  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  console.error(`[bot-pr] push中: ${args.branch} -> ${owner}/${repo}#${args.remoteBranch}`);
  const push = runGit(["push", remoteUrl, `${args.branch}:${args.remoteBranch}`], { token });
  if (push.status !== 0) {
    console.error("[bot-pr] NG: git push に失敗しました。");
    console.error(push.stdout);
    console.error(push.stderr);
    process.exitCode = 1;
    return;
  }
  console.error("[bot-pr] push成功。");

  try {
    const createResult = await githubRequest("POST", `/repos/${owner}/${repo}/pulls`, token, {
      title: args.title,
      head: args.remoteBranch,
      base: args.base,
      body,
    });

    if (!createResult.ok) {
      const message =
        createResult.json && typeof createResult.json.message === "string"
          ? createResult.json.message
          : createResult.text;
      if (createResult.status === 422 && /already exists/i.test(message)) {
        console.error("[bot-pr] 既存 PR を検出(再実行のため新規作成をスキップ)。");
        const existing = await findExistingPr(owner, repo, token, args.remoteBranch, args.base);
        if (existing) {
          console.error(`[bot-pr] 作成者: ${existing.user?.login ?? "?"}`);
          process.stdout.write(`${existing.html_url}\n`);
          return;
        }
      }
      console.error(`[bot-pr] NG: PR 作成に失敗しました(HTTP ${createResult.status}): ${message}`);
      process.exitCode = 1;
      return;
    }

    const pr = createResult.json;
    console.error(`[bot-pr] PR作成成功。作成者: ${pr.user?.login ?? "?"}`);
    process.stdout.write(`${pr.html_url}\n`);
  } catch (err) {
    console.error(`[bot-pr] NG: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
