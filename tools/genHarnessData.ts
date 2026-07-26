// ---------------------------------------------------------------------------
// conformance ハーネス用データ生成器(T8) — `docs/先行計測計画_ドラフト.md` §2.1 P2
//
// `conformance/harnessMain.ts`(ブラウザで実行される conformance ハーネス)は
// `conformance/scenarios.ts` を直接 import できない(冒頭で理由を書く)。この
// スクリプトは Node 側で `conformance/scenarios.ts` の**既存の export をそのまま
// 呼び**、その結果(content bundle・初期 state)を JSON として
// `conformance/harnessData.json` へ書き出す。ブラウザ側はこの JSON を
// 静的 import し、`schema/engineContent.ts`(loadEngineContentOrThrow)と
// `src/engine/state/serialize.ts`(fromSerializable)という**既存の実装**へ
// そのまま渡す。ロジックの複製ではなく、I/O 境界(node:fs で読むか、ビルド時に
// 埋め込まれた JSON を読むか)を分けているだけである。
//
// なぜ conformance/scenarios.ts を直接ブラウザへ持ち込めないか:
//   scenarios.ts は content/*.json を `node:fs`(`readFileSync`)で読み、
//   モジュール冒頭で `fileURLToPath(new URL("../content/", import.meta.url))`
//   を**即時実行**している。ブラウザ向けに Vite でバンドルすると
//   `node:fs`/`node:url` は externalize されて空オブジェクトになり、
//   この即時実行文がモジュール評価時に例外を投げる(実測: Chromium/Firefox/
//   WebKit いずれも "fileURLToPath is not a function" でページ全体がクラッシュ)。
//   scenarios.ts 自体は T7 が所有し編集禁止のため、ここで「Node 側で 1 度
//   だけ解決してデータ化する」ことで境界を越える。
//
// 生成する内容(spec の生成ロジックには一切触れない。ここは調達のみ):
//   - `contentBundleByScenarioId`: 各シナリオの `resolveScenarioContentBundle`
//     (content patch 適用 + `validateContentBundle` 済み・**engine 内部表現化
//     (loadEngineContentOrThrow)前**の ContentBundle)。ブラウザ側で
//     `loadEngineContentOrThrow` を呼ぶことで「content → engine 内部表現」の
//     ロジック自体はブラウザ内で実行される(reject 判定等も本物)。
//   - `initialStateByScenarioId[scenarioId][worldSeed]`: 各 (scenario, worldSeed)
//     組の初期 state を `toSerializable` で JSON 化したもの。ブラウザ側で
//     `fromSerializable` を呼んで GameState を復元する。
//
// `VECTOR_PLANS` が実際に使う (scenarioId, worldSeed) の組だけを列挙する
// (全直積を張らない・golden-vector-spec.md §5 と同じ考え方)。
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format } from "prettier";

import { resolveScenarioContentBundle, SCENARIOS } from "../conformance/scenarios";
import { VECTOR_PLANS } from "../conformance/vectorPlans";

import { canonicalizeJson, type JsonValue } from "../src/engine/canonicalize";
import type { ContentBundle } from "../schema/contentBundle";
import { toSerializable, type SerializedGameState } from "../src/engine/state/serialize";

/** `conformance/harnessData.json` の形の版。フォーマットを変えたら上げる。 */
export const HARNESS_DATA_FORMAT_VERSION = 1;

export interface HarnessDataManifest {
  readonly formatVersion: number;
  readonly contentBundleByScenarioId: { readonly [scenarioId: string]: ContentBundle };
  readonly initialStateByScenarioId: {
    readonly [scenarioId: string]: { readonly [worldSeed: string]: SerializedGameState };
  };
}

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(TOOLS_DIR);
const OUTPUT_PATH = join(PROJECT_ROOT, "conformance", "harnessData.json");

function scenarioById(id: string) {
  const found = SCENARIOS.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(`genHarnessData: 未知の scenarioId "${id}"(conformance/scenarios.ts に無い)`);
  }
  return found;
}

/** ハーネス用マニフェストを構築する(生成ロジックには触れず、調達のみ)。 */
export function buildHarnessDataManifest(): HarnessDataManifest {
  const contentBundleByScenarioId: Record<string, ContentBundle> = {};
  for (const scenario of SCENARIOS) {
    contentBundleByScenarioId[scenario.id] = resolveScenarioContentBundle(scenario);
  }

  const initialStateByScenarioId: Record<string, Record<string, SerializedGameState>> = {};
  for (const plan of VECTOR_PLANS) {
    const byWorldSeed = (initialStateByScenarioId[plan.scenarioId] ??= {});
    if (plan.worldSeed in byWorldSeed) continue;
    const scenario = scenarioById(plan.scenarioId);
    const initialState = scenario.buildState(plan.worldSeed);
    byWorldSeed[plan.worldSeed] = toSerializable(initialState);
  }

  return {
    formatVersion: HARNESS_DATA_FORMAT_VERSION,
    contentBundleByScenarioId,
    initialStateByScenarioId,
  };
}

async function main(): Promise<void> {
  const manifest = buildHarnessDataManifest();
  const canonical = canonicalizeJson(manifest as unknown as JsonValue);
  const text = await format(JSON.stringify(canonical), {
    parser: "json",
    printWidth: 100,
    endOfLine: "lf",
  });
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, text, "utf8");
  console.log(
    `conformance/harnessData.json を書き出した(${String(SCENARIOS.length)} シナリオ・` +
      `${String(VECTOR_PLANS.length)} プラン由来)。`,
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
