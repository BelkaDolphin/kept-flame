#!/usr/bin/env node
/**
 * scripts/preflight.mjs
 *
 * 継ぐ火 -Kept Flame- 週次セッション起動前の課金ガード(ADR-021(1))。
 *
 * 「LLM の自動実行経路(headless / Actions連携 / Agent SDK / Routines)を
 * 追加しない」という運営方針は、課金を Claude Pro/Max の週次インタラクティブ枠
 * のみに固定する前提の上に成り立っている。ところが Claude Code / Anthropic SDK
 * の資格情報解決は「環境変数が存在するかどうか」で優先順位が決まり、
 * ANTHROPIC_API_KEY または ANTHROPIC_AUTH_TOKEN が環境にあると
 * Pro/Max の OAuth セッションより先にそちらが使われ、その場で
 * API 従量課金(x-api-key / Bearer token 経由)へ物理的に切り替わってしまう
 * (優先順位: ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_PROFILE
 * で選択された/アクティブな OAuth プロファイル → …)。
 *
 * このスクリプトは週次セッションを開始する前に実行し、その切り替わりを
 * 機械的に検出して起動を止める「物理的な財布固定」(ADR-021(1))を担う。
 * CI 側の guardrail(scripts/check-llm-paths.mjs)が見るのは git diff/設定
 * ファイルのみで「どの課金経路で生成されたか」は原理的に判定不能なため
 * (ADR-021 の残余リスク)、ローカルでの起動前チェックが唯一の機械的な壁になる。
 *
 * 判定は値の中身を見ず「環境変数キーが存在するかどうか」だけで行う。
 * 空文字列を代入した ANTHROPIC_API_KEY="" であっても資格情報解決の優先枠を
 * 奪う(空キーとして認証を試みてしまう)ため、値の truthiness では判定しない。
 *
 * 対象外(このスクリプトの検出原理では判定不能なもの):
 *   - ANTHROPIC_BASE_URL 等、キーそのものではないが接続先を差し替える変数
 *     (課金経路そのものの切替ではないため対象外)
 *   - このプロセス起動後にシェルで対話的に export される将来の設定
 *     (起動時点の process.env スナップショットしか見えない)
 *   - OS 標準の環境変数以外の経路で SDK に資格情報を注入するケース
 *     (例: OS キーチェーン連携、他プロセスからの動的注入)
 *   - 「どの課金経路で生成されたか」そのものの判定
 *     (ADR-021 の残余リスクどおり、コード/設定から原理的に判定不能。
 *      本スクリプトは「切り替わる可能性がある変数の存在」のみを検出する)
 *
 * 使い方: node scripts/preflight.mjs (または npm run preflight)
 * 終了コード: 0 = 課金の壁は健全(対象変数なし)/ 非0 = 危険な変数を検出
 */

// ADR-021 が名指しする ANTHROPIC_API_KEY に加え、同じ資格情報解決チェーンで
// API 従量課金側へ切り替わりうる ANTHROPIC_AUTH_TOKEN も対象にする(タスク指示
// および Anthropic の資格情報解決順序: ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN
// → OAuth プロファイル、のとおり後者もキー相当として同格に扱う)。
const RISKY_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

const found = RISKY_ENV_VARS.filter((name) => name in process.env);

if (found.length === 0) {
  console.log(
    "[preflight] OK: " +
      RISKY_ENV_VARS.join(" / ") +
      " は未設定。Pro/Max 週次インタラクティブ枠のセッションとして起動してよい。",
  );
  process.exit(0);
}

console.error("[preflight] NG: API従量課金へ切り替わりうる環境変数が設定されています:");
for (const name of found) {
  console.error(`  - ${name}`);
}
console.error("");
console.error("理由(ADR-021(1)):");
console.error("  Claude Code / Anthropic SDK はこれらの環境変数を Pro/Max の OAuth セッションより");
console.error("  優先して資格情報解決する(優先順位: ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN →");
console.error("  OAuth プロファイル)。このまま起動すると週次インタラクティブ枠ではなく");
console.error("  API 従量課金でセッションが走ってしまう(=課金の壁が破られる)。");
console.error("");
console.error("対処: 該当の環境変数を unset してから再実行してください。");
console.error("");
console.error("  bash / zsh:");
console.error("    unset " + found.join(" "));
console.error("");
console.error("  PowerShell:");
for (const name of found) {
  console.error(`    Remove-Item Env:${name} -ErrorAction SilentlyContinue`);
}
console.error("");
console.error("  cmd.exe (値を空にする代入で変数自体を削除する):");
for (const name of found) {
  console.error(`    set ${name}=`);
}
console.error("");
console.error(
  "恒久的に設定している場合は、シェルの起動ファイル(.bashrc/.zshrc/PowerShell profile 等)",
);
console.error("や OS のユーザー環境変数設定からも削除してください。");

process.exit(1);
