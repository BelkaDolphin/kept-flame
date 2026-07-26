// ---------------------------------------------------------------------------
// sim CLI 共通ユーティリティ — tools/genGoldenVectors.ts の isMainModule /
// JSON 書き出し(正準化 + prettier 整形)と同じ規則を sim/ 向けに薄く共有する。
// 新規 npm 依存は増やさない(prettier は既存 devDependency)。
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format } from "prettier";

import { canonicalizeJson, type JsonValue } from "../src/engine/canonicalize";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * このモジュールが `node <file>.ts` として直接実行されたか(vitest 等からの
 * import 時に main() が走らないようにするためのガード)。
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

const JSON_FORMAT_OPTIONS = { parser: "json", printWidth: 100, endOfLine: "lf" } as const;

/** JSON を正準化 + prettier 整形して `<repo root>/relativePath` へ書き出す。 */
export async function writeJsonReport(relativePath: string, value: unknown): Promise<void> {
  const fullPath = join(PROJECT_ROOT, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const canonical = canonicalizeJson(value as JsonValue);
  const text = await format(JSON.stringify(canonical), JSON_FORMAT_OPTIONS);
  writeFileSync(fullPath, text, "utf8");
}
