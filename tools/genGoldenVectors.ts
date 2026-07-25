// ---------------------------------------------------------------------------
// golden vector 生成器 + 検証器(T7 後半) — `docs/design/golden-vector-spec.md` §7
//
// `--write` で `conformance/vectors/*.json` + `index.json` +
// `coverage-matrix.json` を書き出し、`--check` で既存ファイルと突合して
// 差分を stderr へ出す(差分または `checkCoverage` 失敗があれば exit code 1)。
//
// 実行方法(Node 24・新規パッケージ依存なし・spec §7.1):
//   node --experimental-strip-types --import ./tools/tsLoaderRegister.mjs \
//     tools/genGoldenVectors.ts --check|--write
// tsconfig の `moduleResolution: "Bundler"` により engine/schema 側の相対
// import は拡張子を書かないため、Node の素の ESM ローダーでは解決できない。
// `tools/tsLoaderRegister.mjs`(→ `tools/tsLoaderHook.mjs`)がその解決だけを
// 行うカスタムフックで、npm 依存は増やしていない。
//
// 生成器は engine を**改変しない**(spec §7.2 規則8)。分割不変性や往復不変性の
// 検証(下記 §2)が失敗した場合は、シナリオ/プランの設計ミスを疑い、それでも
// 食い違うなら engine 側の挙動が仕様と食い違っている可能性として例外を投げて
// 停止する(自動修正しない)。
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { format } from "prettier";

import {
  GOLDEN_VECTOR_FORMAT_VERSION,
  buildCoverageMatrix,
  canonicalJsonOfState,
  checkCoverage,
  compareCounters,
  compareObservations,
  countersOfReport,
  digestOfCanonicalJson,
  observe,
  sumCounters,
  vectorFileName,
  type CoverageRegistry,
  type GoldenCounters,
  type GoldenVector,
  type GoldenVectorIndex,
} from "../conformance/goldenVector";
import { resolveScenarioContent, SCENARIOS, type Scenario } from "../conformance/scenarios";
import { VECTOR_PLANS, type VectorPlan } from "../conformance/vectorPlans";

import { advanceWithReport, computeTargetTick, createAdvanceContext } from "../src/engine/advance";
import { canonicalizeJson, compareUtf16, type JsonValue } from "../src/engine/canonicalize";
import type { SegmentRecord } from "../src/engine/scheduler";
import { fromSerializable, toSerializable } from "../src/engine/state/serialize";
import { worldSeedToUint32 } from "../src/engine/stochastic";

/** 生成器の使い方の誤り、または engine の分割/往復不変性が壊れている場合。 */
export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorError";
  }
}

// --- 0. パス ----------------------------------------------------------------

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(TOOLS_DIR);
const VECTORS_DIR = join(PROJECT_ROOT, "conformance", "vectors");
const COVERAGE_PATH = join(PROJECT_ROOT, "conformance", "coverage.json");
const BALANCE_JSON_PATH = join(PROJECT_ROOT, "content", "balance.json");
const INDEX_PATH = join(VECTORS_DIR, "index.json");
const MATRIX_PATH = join(VECTORS_DIR, "coverage-matrix.json");

// --- 1. シナリオ解決 ----------------------------------------------------------

function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((s) => s.id === id);
  if (found === undefined) {
    throw new GeneratorError(
      `未知の scenarioId "${id}"(conformance/scenarios.ts の SCENARIOS に無い)`,
    );
  }
  return found;
}

// --- 2. 1 プラン → 1 ベクタ(spec §7.2) --------------------------------------

function resolveToTick(plan: VectorPlan): number {
  if (plan.elapsedMonotonicMs !== null) {
    const computed = computeTargetTick(plan.fromTick, plan.elapsedMonotonicMs);
    if (plan.toTick !== null && plan.toTick !== computed) {
      throw new GeneratorError(
        `vector "${plan.vectorId}": toTick(${String(plan.toTick)}) と computeTargetTick の結果` +
          `(${String(computed)})が食い違う(spec §7.2 規則3)`,
      );
    }
    return computed;
  }
  if (plan.toTick === null) {
    throw new GeneratorError(`vector "${plan.vectorId}": toTick も elapsedMonotonicMs も無い`);
  }
  return plan.toTick;
}

/** `splitTicks` の記号値を具体的な tick 配列へ解決する(spec §7.2 規則2)。 */
function resolveSplitTicks(
  spec: VectorPlan["splitTicks"],
  fromTick: number,
  toTick: number,
  coarseTickMinutes: number,
  oneShotSegments: readonly SegmentRecord[],
): readonly number[] {
  if (Array.isArray(spec)) return spec;

  if (spec === "every-coarse-step") {
    const ticks: number[] = [];
    for (let t = fromTick + coarseTickMinutes; t < toTick; t += coarseTickMinutes) {
      ticks.push(t);
    }
    return ticks;
  }

  // "first-recall-recovery"
  const segment = oneShotSegments.find((s) => s.endEventKinds.includes("recallRecover"));
  if (segment === undefined) {
    throw new GeneratorError(
      'splitTicks "first-recall-recovery": recallRecover イベントが一括実行の区間記録に1件も無い' +
        "(空の splitTicks へ黙って落とさない・spec §7.2 規則2)",
    );
  }
  return [segment.toTick];
}

/**
 * 1 プランから 1 golden vector を作る(生成器の本体)。一括実行で `expected` を、
 * 必要なら分割実行で `splitCounters` を作り、**状態ダイジェストのみ**一括 ==
 * 分割を要求する(spec §3.3・カウンタは一致を要求しない)。
 *
 * @throws {GeneratorError} 分割不変性・rngState 往復不変性が破れている場合
 *   (engine を改変せず報告する・spec §7.2 規則8)
 */
export function buildVector(plan: VectorPlan): GoldenVector {
  const scenario = scenarioById(plan.scenarioId);
  const content = resolveScenarioContent(scenario);
  const initialState = scenario.buildState(plan.worldSeed);
  // AdvanceContext は run ごとに作り直さない(一括・分割の全 leg で共有・spec §7.2 規則4)。
  const ctx = createAdvanceContext(initialState, content);

  const toTick = resolveToTick(plan);
  const needSegments = plan.splitTicks === "first-recall-recovery";
  const oneShotReport = advanceWithReport(initialState, ctx, toTick, {
    collectSegments: needSegments,
  });
  const expected = observe(oneShotReport.state, oneShotReport);

  const splitTicks = resolveSplitTicks(
    plan.splitTicks,
    plan.fromTick,
    toTick,
    content.coarseTickMinutes,
    oneShotReport.segments,
  );

  let splitCounters: GoldenCounters | null = null;
  if (splitTicks.length > 0) {
    let cursorState = initialState;
    const counterList: GoldenCounters[] = [];
    for (const boundary of [...splitTicks, toTick]) {
      const legReport = advanceWithReport(cursorState, ctx, boundary);
      counterList.push(countersOfReport(legReport));
      cursorState = legReport.state;
    }
    splitCounters = sumCounters(counterList);

    const splitDigest = digestOfCanonicalJson(canonicalJsonOfState(cursorState));
    if (splitDigest !== expected.stateDigest) {
      throw new GeneratorError(
        `vector "${plan.vectorId}": 分割実行の最終状態ダイジェスト(${splitDigest})が` +
          `一括実行(${expected.stateDigest})と食い違う。engine の分割不変性が壊れている可能性が` +
          "あり、生成器は engine を改変しないので報告すること(spec §7.2 規則8)。",
      );
    }
  }

  if (plan.paths.includes("rng-state-nonempty-roundtrip")) {
    const roundTripped = fromSerializable(
      JSON.parse(JSON.stringify(toSerializable(oneShotReport.state))),
    );
    const roundTripDigest = digestOfCanonicalJson(canonicalJsonOfState(roundTripped));
    if (roundTripDigest !== expected.stateDigest) {
      throw new GeneratorError(
        `vector "${plan.vectorId}": rngState 往復後の digest(${roundTripDigest})が` +
          `一括実行(${expected.stateDigest})と一致しない(spec §7.2 規則6)。`,
      );
    }
  }

  return {
    formatVersion: GOLDEN_VECTOR_FORMAT_VERSION,
    vectorId: plan.vectorId,
    scenarioId: plan.scenarioId,
    worldSeed: plan.worldSeed,
    worldSeedU32: worldSeedToUint32(plan.worldSeed),
    coarseTickMinutes: content.coarseTickMinutes,
    fromTick: plan.fromTick,
    toTick,
    elapsedMonotonicMs: plan.elapsedMonotonicMs,
    splitTicks,
    paths: plan.paths,
    expected,
    splitCounters,
  };
}

// --- 3. coverage.json / balance.json の読み込み ------------------------------

function loadCoverageRegistry(): CoverageRegistry {
  return JSON.parse(readFileSync(COVERAGE_PATH, "utf8")) as CoverageRegistry;
}

function currentAlgoVersion(): number {
  const raw = JSON.parse(readFileSync(BALANCE_JSON_PATH, "utf8")) as {
    readonly algoVersion: number;
  };
  return raw.algoVersion;
}

// --- 4. 既存ファイルの読み込み(--check 用) -----------------------------------

function loadStoredJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadStoredVector(vectorId: string): GoldenVector | undefined {
  const stored = loadStoredJson(join(VECTORS_DIR, vectorFileName(vectorId)));
  return stored === undefined ? undefined : (stored as GoldenVector);
}

function sameJson(fresh: JsonValue, storedRaw: unknown): boolean {
  if (storedRaw === undefined) return false;
  return (
    JSON.stringify(canonicalizeJson(fresh)) ===
    JSON.stringify(canonicalizeJson(storedRaw as JsonValue))
  );
}

const VECTOR_SCALAR_KEYS = [
  "formatVersion",
  "vectorId",
  "scenarioId",
  "worldSeed",
  "worldSeedU32",
  "coarseTickMinutes",
  "fromTick",
  "toTick",
  "elapsedMonotonicMs",
] as const;

/** 生成した(fresh)ベクタと既存ファイル(stored)の差分を人間可読な行の配列で返す。 */
export function diffVectors(fresh: GoldenVector, stored: GoldenVector): readonly string[] {
  const diffs: string[] = [];
  for (const key of VECTOR_SCALAR_KEYS) {
    if (fresh[key] !== stored[key]) {
      diffs.push(
        `${key}: 期待 ${JSON.stringify(fresh[key])} / 実際 ${JSON.stringify(stored[key])}`,
      );
    }
  }
  if (JSON.stringify(fresh.splitTicks) !== JSON.stringify(stored.splitTicks)) {
    diffs.push(
      `splitTicks: 期待 ${JSON.stringify(fresh.splitTicks)} / 実際 ${JSON.stringify(stored.splitTicks)}`,
    );
  }
  if (JSON.stringify(fresh.paths) !== JSON.stringify(stored.paths)) {
    diffs.push(`paths: 期待 ${JSON.stringify(fresh.paths)} / 実際 ${JSON.stringify(stored.paths)}`);
  }
  diffs.push(...compareObservations(fresh.expected, stored.expected));
  if (fresh.splitCounters === null || stored.splitCounters === null) {
    if (fresh.splitCounters !== stored.splitCounters) {
      diffs.push(
        `splitCounters: 期待 ${JSON.stringify(fresh.splitCounters)} / ` +
          `実際 ${JSON.stringify(stored.splitCounters)}`,
      );
    }
  } else {
    diffs.push(...compareCounters("splitCounters", fresh.splitCounters, stored.splitCounters));
  }
  return diffs;
}

// --- 5. JSON 書き出し(prettier で整形・spec §7.2 規則7) ----------------------

const PRETTIER_JSON_OPTIONS = { parser: "json", printWidth: 100, endOfLine: "lf" } as const;

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const canonical = canonicalizeJson(value as JsonValue);
  const text = await format(JSON.stringify(canonical), PRETTIER_JSON_OPTIONS);
  writeFileSync(path, text, "utf8");
}

// --- 6. 本体(--check / --write) ----------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--write")
    ? "write"
    : process.argv.includes("--check")
      ? "check"
      : undefined;
  if (mode === undefined) {
    console.error("usage: genGoldenVectors.ts --check|--write");
    process.exitCode = 1;
    return;
  }

  const registry = loadCoverageRegistry();
  const built: GoldenVector[] = [];
  const bigRunTimings: { readonly vectorId: string; readonly ms: number }[] = [];

  for (const planEntry of VECTOR_PLANS) {
    const start = Date.now();
    const vector = buildVector(planEntry);
    const elapsedMs = Date.now() - start;
    if (vector.toTick - vector.fromTick >= 4320) {
      bigRunTimings.push({ vectorId: vector.vectorId, ms: elapsedMs });
    }
    built.push(vector);
  }

  const coverageProblems = checkCoverage(registry, built);
  if (coverageProblems.length > 0) {
    console.error(`checkCoverage が ${String(coverageProblems.length)} 件の問題を検出した:`);
    for (const problem of coverageProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const sortedVectors = [...built].sort((a, b) => compareUtf16(a.vectorId, b.vectorId));
  const index: GoldenVectorIndex = {
    formatVersion: GOLDEN_VECTOR_FORMAT_VERSION,
    algoVersion: currentAlgoVersion(),
    vectors: sortedVectors.map((v) => ({ vectorId: v.vectorId, file: vectorFileName(v.vectorId) })),
    baseContentVectorIds: sortedVectors
      .filter((v) => scenarioById(v.scenarioId).contentPatch === null)
      .map((v) => v.vectorId),
  };
  const matrix = buildCoverageMatrix(registry, built);

  if (mode === "write") {
    mkdirSync(VECTORS_DIR, { recursive: true });
    for (const vector of built) {
      await writeJsonFile(join(VECTORS_DIR, vectorFileName(vector.vectorId)), vector);
    }
    await writeJsonFile(INDEX_PATH, index);
    await writeJsonFile(MATRIX_PATH, matrix);
    console.log(`golden vector ${String(built.length)} 本を書き出した。`);
  } else {
    let hasDiff = false;
    for (const vector of built) {
      const stored = loadStoredVector(vector.vectorId);
      if (stored === undefined) {
        console.error(`[新規] ${vector.vectorId}: 既存ファイルが無い(npm run golden:write が必要)`);
        hasDiff = true;
        continue;
      }
      const diffs = diffVectors(vector, stored);
      if (diffs.length > 0) {
        console.error(`[差分] ${vector.vectorId}:`);
        for (const d of diffs) console.error(`  - ${d}`);
        hasDiff = true;
      }
    }
    if (!sameJson(index as unknown as JsonValue, loadStoredJson(INDEX_PATH))) {
      console.error(
        "[差分] conformance/vectors/index.json が一致しない(npm run golden:write が必要)",
      );
      hasDiff = true;
    }
    if (!sameJson(matrix as unknown as JsonValue, loadStoredJson(MATRIX_PATH))) {
      console.error(
        "[差分] conformance/vectors/coverage-matrix.json が一致しない(npm run golden:write が必要)",
      );
      hasDiff = true;
    }
    if (hasDiff) {
      process.exitCode = 1;
    } else {
      console.log(`golden vector ${String(built.length)} 本、差分なし。`);
    }
  }

  if (bigRunTimings.length > 0) {
    console.log("72h(4320 tick)以上のベクタの生成時間(計測 #3 の一次データ):");
    for (const t of bigRunTimings) console.log(`  ${t.vectorId}: ${String(t.ms)} ms`);
  }
}

if (isMainModule()) {
  await main();
}
