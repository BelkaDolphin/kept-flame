// ---------------------------------------------------------------------------
// golden vector 構築の純粋部(T8 で `tools/genGoldenVectors.ts` から抽出)
//
// `docs/design/golden-vector-spec.md` §7.2 のベクタ構築ロジックそのもの
// (resolveToTick / resolveSplitTicks / 1 プラン→1 ベクタ)を、
// **content/state の調達方法から独立させて**ここへ切り出したもの。
//
// なぜ切り出すか(T8 conformance ハーネスの要請):
//   `conformance/scenarios.ts` はシナリオごとの content/state を
//   `node:fs`(content/*.json の読み込み)経由で調達する。Node の CLI/テストでは
//   問題ないが、ブラウザ実行(`conformance/harnessMain.ts`)には持ち込めない
//   ——`node:fs`/`node:url` はブラウザに存在せず、Vite が client 向けに
//   externalize すると、scenarios.ts 冒頭の `fileURLToPath(new URL(...))` が
//   モジュール評価時に即例外を投げてページ全体がロード不能になる(実測済み:
//   Chromium/Firefox/WebKit いずれも "fileURLToPath is not a function" で
//   即クラッシュ)。
//
//   一方このファイルが持つ「1 プラン + 解決済み content + 解決済み state →
//   1 golden vector」という計算そのもの(digest 計算・分割/往復不変性の検証)は
//   content/state の調達方法に依存しない純粋なロジックであり、
//   `src/engine/**` と `conformance/goldenVector.ts` だけを import すれば
//   ブラウザでもそのまま動く。
//
//   よって:
//     - `tools/genGoldenVectors.ts`(Node CLI)は
//       `resolveScenarioContent`(node:fs 経由)で content/state を調達し、
//       ここの `buildVectorFromResolvedInputs` へ渡す(既存の `buildVector(plan)`
//       という外部シグネチャ・挙動は完全に維持=既存テスト・`golden:check` は
//       無変更で pass する)。
//     - `conformance/harnessMain.ts`(ブラウザ)は
//       ビルド時に precompute した content/state(`tools/genHarnessData.ts` が
//       生成する `conformance/harnessData.json`)を調達し、同じ
//       `buildVectorFromResolvedInputs` へ渡す。
//
//   digest 計算・分割/往復不変性検証のロジックはこの 1 箇所にしか無い
//   (Node 側とブラウザ側で 2 系統に分岐すると conformance の意味が壊れる、
//   という T8 依頼の要請そのものへの回答)。生成ロジック自体は一切変更していない
//   (spec §7.2 の規則はそのまま・値も一切変えていない、単なる関数分割)。
// ---------------------------------------------------------------------------

import {
  GOLDEN_VECTOR_FORMAT_VERSION,
  canonicalJsonOfState,
  countersOfReport,
  digestOfCanonicalJson,
  observe,
  sumCounters,
  type GoldenCounters,
  type GoldenVector,
} from "../conformance/goldenVector";
import type { VectorPlan } from "../conformance/vectorPlans";

import { advanceWithReport, computeTargetTick, createAdvanceContext } from "../src/engine/advance";
import type { EngineContent } from "../src/engine/rules/types";
import type { SegmentRecord } from "../src/engine/scheduler";
import type { GameState } from "../src/engine/state/state";
import { fromSerializable, toSerializable } from "../src/engine/state/serialize";
import { worldSeedToUint32 } from "../src/engine/stochastic";

/** 生成器の使い方の誤り、または engine の分割/往復不変性が壊れている場合。 */
export class GeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorError";
  }
}

/** `plan.toTick` / `plan.elapsedMonotonicMs` を実際の toTick へ解決する(spec §7.2 規則3)。 */
export function resolveToTick(plan: VectorPlan): number {
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
export function resolveSplitTicks(
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
 * 1 プラン + 解決済み content/初期 state から 1 golden vector を作る(生成器の本体)。
 * 一括実行で `expected` を、必要なら分割実行で `splitCounters` を作り、
 * **状態ダイジェストのみ**一括 == 分割を要求する(spec §3.3・カウンタは一致を
 * 要求しない)。content/state の調達方法(node:fs 経由か precompute 経由か)には
 * 一切関与しない(呼び出し側の責務)。
 *
 * @throws {GeneratorError} 分割不変性・rngState 往復不変性が破れている場合
 *   (呼び出し側は engine を改変せず報告する・spec §7.2 規則8)
 */
export function buildVectorFromResolvedInputs(
  plan: VectorPlan,
  content: EngineContent,
  initialState: GameState,
): GoldenVector {
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

  // [M20] "rng-state-nonempty-roundtrip" と "foot-serialize-roundtrip" は
  // どちらも同じ検証(toSerializable → JSON 往復 → fromSerializable → digest 再計算)
  // を要求する。前者は rngState、後者は facility.footprint(GDD 6.1
  // [2026-07-30裁定]・§7 の 1×1 省略正準形)の往復不変性を主張する経路であり、
  // 対象フィールドが違うだけで検証ロジックは共通なので 1 箇所にまとめる。
  // [M50] `research-select-serialize-roundtrip` も同じ検証を要求する
  // (`selectedResearchId` は未選択ならキーごと省略される正準形・serialize.ts §12)。
  if (
    plan.paths.includes("rng-state-nonempty-roundtrip") ||
    plan.paths.includes("foot-serialize-roundtrip") ||
    plan.paths.includes("research-select-serialize-roundtrip")
  ) {
    const roundTripped = fromSerializable(
      JSON.parse(JSON.stringify(toSerializable(oneShotReport.state))),
    );
    const roundTripDigest = digestOfCanonicalJson(canonicalJsonOfState(roundTripped));
    if (roundTripDigest !== expected.stateDigest) {
      throw new GeneratorError(
        `vector "${plan.vectorId}": 状態往復後の digest(${roundTripDigest})が` +
          `一括実行(${expected.stateDigest})と一致しない(spec §7.2 規則6 / footprint.ts §2)。`,
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
