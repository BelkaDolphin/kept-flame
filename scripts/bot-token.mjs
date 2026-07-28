#!/usr/bin/env node
/**
 * scripts/bot-token.mjs
 *
 * GitHub App `kept-flame-bot` のインストールトークン(寿命1h)を取得する
 * (ADR-030(1)(3) [2026-07-28改訂]・M45)。
 *
 * 手順: App ID + ローカル保管の .pem 秘密鍵から Node 組込み crypto のみで
 * JWT(RS256)を自前署名 → `GET /app/installations` でインストール ID を自動発見
 * → `POST /app/installations/{id}/access_tokens` でインストールトークンを取得する。
 * 新規 npm 依存は追加しない(scripts/preflight.mjs・scripts/check-llm-paths.mjs と
 * 同じ「@types/node 非依存・追加パッケージなし」の流儀を踏襲)。
 *
 * 使い方(単独実行。npm run bot:token でも同じ):
 *   KEPT_FLAME_BOT_PEM=<.pemの絶対パス> node scripts/bot-token.mjs
 *
 * 出力: 成功時はインストールトークンの文字列**のみ**を stdout に書く(改行1個で終端)。
 * 呼び出し側は `$env:TOKEN = node scripts/bot-token.mjs`(PowerShell)や
 * `TOKEN=$(node scripts/bot-token.mjs)`(bash)のように stdout を捕捉して使う想定。
 * 進行状況・エラーメッセージは全て stderr に書く(stdout を汚さない)。
 *
 * 環境変数:
 *   KEPT_FLAME_BOT_PEM      (必須) .pem 秘密鍵の絶対パス。リポジトリ外に保管する
 *                           (絶対パス自体もコミット対象ファイルにハードコードしない)。
 *   KEPT_FLAME_BOT_APP_ID   (省略可) GitHub App ID。既定値 4415558(kept-flame-bot。
 *                           App ID 自体は秘密情報ではないためスクリプト内既定値にしてよい)。
 *   KEPT_FLAME_BOT_OWNER    (省略可) installation 検索で複数ヒットした場合の絞り込みに
 *                           使う GitHub アカウント名。既定値 "BelkaDolphin"。
 *
 * 🔒 秘密鍵の取り扱い: このスクリプトは .pem の中身を一切ログに出さない
 * (readFileSync で読むのみ・console 出力の対象にしない)。生成した JWT やトークン文字列も
 * stderr には出さない(JWT はネットワーク呼出にのみ使い、トークンは stdout にのみ出す)。
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// App ID 自体は秘密ではない(ADR-030(1)注記)。kept-flame-bot の実在 App ID。
const DEFAULT_APP_ID = "4415558";
const DEFAULT_OWNER = "BelkaDolphin";
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "kept-flame-bot-token-script";

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

/**
 * GitHub App JWT(RS256)を組み立てる純関数(テスト容易性のため export)。
 * GitHub 公式手順どおり iat はクロックドリフト分 60 秒過去、exp は現在時刻から
 * 最大10分以内(ここでは安全側に9分)に設定する。
 */
export function buildAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: Number(appId),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/** 複数 installation がヒットした場合の絞り込みを含む純関数(テスト容易性のため export)。 */
export function pickInstallation(installations, owner) {
  if (!Array.isArray(installations) || installations.length === 0) {
    throw new Error(
      "GitHub App のインストールが1件も見つかりません。kept-flame リポジトリへ App を" +
        "インストール済みか確認してください(docs/ユーザー作業リスト.md §1)。",
    );
  }
  if (installations.length === 1) {
    const [only] = installations;
    return only;
  }
  const matched = installations.filter(
    (inst) =>
      inst.account &&
      typeof inst.account.login === "string" &&
      inst.account.login.toLowerCase() === owner.toLowerCase(),
  );
  if (matched.length === 1) {
    const [only] = matched;
    return only;
  }
  throw new Error(
    `installation が複数見つかりましたが owner="${owner}" で一意に絞り込めません` +
      "(環境変数 KEPT_FLAME_BOT_OWNER で対象アカウント名を指定してください)。",
  );
}

async function githubRequest(method, apiPath, jwt, body) {
  const res = await fetch(`${GITHUB_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
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
  if (!res.ok) {
    const detail = json && typeof json.message === "string" ? json.message : text;
    throw new Error(
      `GitHub API ${method} ${apiPath} が失敗しました(HTTP ${res.status}): ${detail}`,
    );
  }
  return json;
}

async function main() {
  const pemPath = process.env.KEPT_FLAME_BOT_PEM;
  if (!pemPath) {
    console.error("[bot-token] NG: 環境変数 KEPT_FLAME_BOT_PEM が未設定です(.pem の絶対パス)。");
    console.error(
      "  例 (PowerShell): $env:KEPT_FLAME_BOT_PEM = 'C:\\path\\to\\kept-flame-bot....pem'",
    );
    console.error("  例 (bash):       export KEPT_FLAME_BOT_PEM=/c/path/to/kept-flame-bot....pem");
    process.exitCode = 1;
    return;
  }

  const appId = process.env.KEPT_FLAME_BOT_APP_ID || DEFAULT_APP_ID;
  const owner = process.env.KEPT_FLAME_BOT_OWNER || DEFAULT_OWNER;

  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(pemPath, "utf8");
  } catch (err) {
    console.error(`[bot-token] NG: .pem の読み込みに失敗しました(${pemPath}): ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const jwt = buildAppJwt(appId, privateKeyPem);

  try {
    const installations = await githubRequest("GET", "/app/installations", jwt);
    const installation = pickInstallation(installations, owner);
    console.error(
      `[bot-token] installation発見: id=${installation.id} account=${installation.account?.login ?? "?"}`,
    );

    const tokenResponse = await githubRequest(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
      {},
    );
    console.error(`[bot-token] トークン発行成功(expires_at=${tokenResponse.expires_at})`);

    // トークン本体は stdout のみへ(ログ的な装飾は一切混ぜない・末尾改行1個のみ)。
    process.stdout.write(`${tokenResponse.token}\n`);
  } catch (err) {
    console.error(`[bot-token] NG: ${err.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
