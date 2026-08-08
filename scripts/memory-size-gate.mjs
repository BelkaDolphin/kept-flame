// ---------------------------------------------------------------------------
// MEMORY.md サイズゲート — 軽量スナップショット方式の機械判定(2026-08-08導入)
//
// 目的: MEMORY.md は毎セッション冒頭で必ず読まれる(CLAUDE.md 必読ルール)ため、
// 追記で肥大するとセッションごとの固定トークン費が増え続ける。本ゲートは
// 「スナップショットの書き換えで運用し、詳細経緯は docs/memory-archive/ へ
// 移す」という運用が守られているかをバイトサイズで機械判定する。
//
//   警告閾値 15KB : 整理を検討(exit 0・警告表示のみ)
//   違反閾値 30KB : アーカイブへの退避が必要(exit 1)
//
// 実行: npm run memory:gate (MEMORY.md 更新後に必ず回す)
// 依存: なし(node:fs のみ・preflight.mjs と同じ方針)
// ---------------------------------------------------------------------------
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WARN_BYTES = 15 * 1024;
const FAIL_BYTES = 30 * 1024;

const memoryPath = fileURLToPath(new URL("../MEMORY.md", import.meta.url));

let size;
try {
  size = statSync(memoryPath).size;
} catch (error) {
  console.error(`[memory:gate] MEMORY.md が読めない: ${String(error)}`);
  process.exit(1);
}

const kb = (size / 1024).toFixed(1);

if (size > FAIL_BYTES) {
  console.error(
    `[memory:gate] 違反: MEMORY.md が ${kb}KB(上限 ${String(FAIL_BYTES / 1024)}KB 超過)。` +
      "完了タスクの詳細経緯を docs/memory-archive/ へ移し、スナップショットの書き換えで運用すること。",
  );
  process.exit(1);
}

if (size > WARN_BYTES) {
  console.warn(
    `[memory:gate] 警告: MEMORY.md が ${kb}KB(警告閾値 ${String(WARN_BYTES / 1024)}KB 超過)。` +
      "次の節目でアーカイブへの退避を検討すること。",
  );
  process.exit(0);
}

console.log(`[memory:gate] pass: MEMORY.md は ${kb}KB(警告 ${String(WARN_BYTES / 1024)}KB / 上限 ${String(FAIL_BYTES / 1024)}KB)`);
