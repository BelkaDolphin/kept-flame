// ---------------------------------------------------------------------------
// golden vector 用ベクタ計画(T7 後半) — `docs/design/golden-vector-spec.md` §5/§6
//
// 37 本の計画(vectorId / scenarioId / worldSeed / plan / 申告する paths)を
// spec §6 の表そのまま列挙する。`splitTicks` の解決(数値配列への展開)は
// `tools/genGoldenVectors.ts` が spec §7.2 の規則に従って行う
// (`"first-recall-recovery"` / `"every-coarse-step"` の 2 つの記号値はここでは
// 解決しない = 生成器が実行結果から求めて JSON へ焼く)。
// ---------------------------------------------------------------------------

/** seed slug → worldSeed 文字列(spec §5)。 */
export const SEEDS = {
  alpha: "seedAlpha",
  beta: "seedBeta",
  empty: "",
  longz: "zzzzzzzzzzzzzzzz",
  kanji: "種火",
  emoji: "🔥火",
} as const;

/**
 * 1 ベクタの計画。`toTick` は `elapsedMonotonicMs` から求める場合でも
 * (確認のため)明示できる — 両方指定した場合、生成器は
 * `computeTargetTick(fromTick, elapsedMonotonicMs) === toTick` を確認する
 * (spec §7.2 規則 3)。
 */
export interface VectorPlan {
  readonly vectorId: string;
  readonly scenarioId: string;
  readonly worldSeed: string;
  readonly fromTick: number;
  readonly toTick: number | null;
  readonly elapsedMonotonicMs: number | null;
  readonly splitTicks: readonly number[] | "first-recall-recovery" | "every-coarse-step";
  readonly paths: readonly string[];
}

function plan(
  vectorId: string,
  scenarioId: string,
  worldSeed: string,
  toTick: number,
  paths: readonly string[],
  options: {
    readonly elapsedMonotonicMs?: number;
    readonly splitTicks?: readonly number[] | "first-recall-recovery" | "every-coarse-step";
  } = {},
): VectorPlan {
  return {
    vectorId,
    scenarioId,
    worldSeed,
    fromTick: 0,
    toTick,
    elapsedMonotonicMs: options.elapsedMonotonicMs ?? null,
    splitTicks: options.splitTicks ?? [],
    paths,
  };
}

export const VECTOR_PLANS: readonly VectorPlan[] = [
  // --- sc01-steady -----------------------------------------------------------
  plan("sc01-steady-alpha", "sc01-steady", SEEDS.alpha, 4320, [
    "a-closed-form",
    "a-worker-scaling",
    "a-level-curve",
    "adj-seed-offset-applied",
    "adj-target-resolution",
    "c-step-grid",
    "rng-state-empty-roundtrip",
  ]),
  plan("sc01-steady-beta", "sc01-steady", SEEDS.beta, 4320, ["rng-worldseed-variation"]),
  plan("sc01-steady-empty", "sc01-steady", SEEDS.empty, 4320, ["rng-worldseed-empty"]),
  plan("sc01-steady-kanji", "sc01-steady", SEEDS.kanji, 4320, ["rng-worldseed-nonascii"]),
  plan("sc01-steady-emoji", "sc01-steady", SEEDS.emoji, 4320, ["rng-worldseed-surrogate"]),
  plan("sc01-steady-longz", "sc01-steady", SEEDS.longz, 4320, ["fp-imul-wrap"]),
  plan("sc01-clamp-under", "sc01-steady", SEEDS.alpha, 4319, ["clock-clamp-72h"], {
    elapsedMonotonicMs: 4319 * 60_000 + 59_999,
  }),
  plan("sc01-clamp-exact", "sc01-steady", SEEDS.alpha, 4320, ["clock-clamp-72h"], {
    elapsedMonotonicMs: 4320 * 60_000,
  }),
  plan("sc01-clamp-over", "sc01-steady", SEEDS.alpha, 4320, ["clock-clamp-72h"], {
    elapsedMonotonicMs: 10_000 * 60_000,
  }),
  plan("sc01-split-offgrid", "sc01-steady", SEEDS.alpha, 4320, ["split-off-grid"], {
    splitTicks: [1237],
  }),
  plan("sc01-split-step", "sc01-steady", SEEDS.alpha, 4320, ["split-at-step-tick"], {
    splitTicks: [1240],
  }),

  // --- sc02-idle ---------------------------------------------------------------
  plan("sc02-idle-alpha", "sc02-idle", SEEDS.alpha, 4320, [
    "a-zero-rate",
    "b-research-zero-rate",
    "c-p-zero",
    "c-trial-count",
    "rng-state-empty-roundtrip",
  ]),

  // --- sc03-research -------------------------------------------------------------
  plan("sc03-research-alpha", "sc03-research", SEEDS.alpha, 300, [
    "b-research-on-grid",
    "b-research-queue-advance",
    "tie-multi-event-same-tick",
    "c-trial-count",
  ]),
  plan("sc03-horizon-alpha", "sc03-research", SEEDS.alpha, 100, ["b-research-at-horizon"]),
  plan("sc03-split-done-alpha", "sc03-research", SEEDS.alpha, 300, ["split-at-completion-tick"], {
    splitTicks: [100],
  }),

  // --- sc04-offgrid --------------------------------------------------------------
  plan("sc04-offgrid-alpha", "sc04-offgrid", SEEDS.alpha, 300, [
    "b-research-off-grid",
    "b-research-ceil",
    "fp-floor-negative",
  ]),
  plan("sc04-split-done-alpha", "sc04-offgrid", SEEDS.alpha, 300, ["split-at-completion-tick"], {
    splitTicks: [101],
  }),

  // --- sc05-preloaded --------------------------------------------------------------
  plan("sc05-preloaded-alpha", "sc05-preloaded", SEEDS.alpha, 50, ["b-research-preloaded"]),

  // --- sc06-recall -----------------------------------------------------------------
  plan("sc06-recall-alpha", "sc06-recall", SEEDS.alpha, 4320, [
    "b-recall-recovery-boundary",
    "c-duration-draw",
    "c-linear-proration",
    "c-no-reroll-while-impaired",
    "c-trial-count",
    "rng-state-nonempty-roundtrip",
  ]),
  plan("sc06-recall-beta", "sc06-recall", SEEDS.beta, 4320, ["rng-worldseed-variation"]),
  plan("sc06-recall-empty", "sc06-recall", SEEDS.empty, 4320, ["rng-worldseed-empty"]),
  plan("sc06-recall-kanji", "sc06-recall", SEEDS.kanji, 4320, ["rng-worldseed-nonascii"]),
  plan("sc06-recall-emoji", "sc06-recall", SEEDS.emoji, 4320, ["rng-worldseed-surrogate"]),
  plan("sc06-split-recover-a", "sc06-recall", SEEDS.alpha, 4320, ["split-at-recovery-tick"], {
    splitTicks: "first-recall-recovery",
  }),
  plan("sc06-split-many-alpha", "sc06-recall", SEEDS.alpha, 720, ["split-many"], {
    splitTicks: "every-coarse-step",
  }),

  // --- sc07-clamp-p ------------------------------------------------------------------
  plan("sc07-clamp-p-alpha", "sc07-clamp-p", SEEDS.alpha, 4320, [
    "c-p-clamp-max",
    "c-dispatch-weight",
  ]),

  // --- sc08-mastery --------------------------------------------------------------------
  plan("sc08-mastery-alpha", "sc08-mastery", SEEDS.alpha, 4320, ["c-mastery-cap"]),

  // --- sc09-memkeeper ------------------------------------------------------------------
  plan("sc09-memkeeper-alpha", "sc09-memkeeper", SEEDS.alpha, 4320, ["c-memory-keeper"]),

  // --- sc10-morale-edge ----------------------------------------------------------------
  plan("sc10-morale-edge-alpha", "sc10-morale-edge", SEEDS.alpha, 4320, ["c-morale-thresholds"]),

  // --- sc11-overcrowd ------------------------------------------------------------------
  // 過密の「本数制限そのもの」「ペナ側クランプの発動」「複数タグ施設の同時参加」は
  // sc11 では観測できない(spec §4.4 の [2026-07-26 裁定])ので sc16 へ移した。
  // sc11 に残るのは超過ペナ(3 × -0.10)・ボーナス側 ±60% クランプ・盤端・target 解決。
  plan("sc11-overcrowd-alpha", "sc11-overcrowd", SEEDS.alpha, 1440, [
    "adj-overcrowd-effective-limit",
    "adj-bonus-clamp",
    "adj-neighbor-edge",
    "adj-target-resolution",
  ]),
  plan("sc11-overcrowd-beta", "sc11-overcrowd", SEEDS.beta, 1440, ["rng-worldseed-variation"]),

  // --- sc12-bigstock -------------------------------------------------------------------
  plan("sc12-bigstock-alpha", "sc12-bigstock", SEEDS.alpha, 100, ["fp-mulfix-bigint-fallback"]),

  // --- sc13-onemin ---------------------------------------------------------------------
  plan("sc13-onemin-alpha", "sc13-onemin", SEEDS.alpha, 4320, [
    "clock-fallback-one-minute",
    "c-step-grid",
    "c-trial-count",
  ]),

  // --- sc14-offset-zero ----------------------------------------------------------------
  plan("sc14-offset-zero-alpha", "sc14-offset-zero", SEEDS.alpha, 4320, [
    "adj-seed-offset-identity",
  ]),

  // --- sc15-tie ------------------------------------------------------------------------
  plan("sc15-tie-alpha", "sc15-tie", SEEDS.alpha, 2000, [
    "tie-multi-event-same-tick",
    "tie-same-stage-entity-order",
  ]),
  plan(
    "sc15-tie-split-alpha",
    "sc15-tie",
    SEEDS.alpha,
    2000,
    ["split-at-recovery-tick", "split-at-completion-tick"],
    { splitTicks: [1000] },
  ),

  // --- sc16-overcrowd-fine ---------------------------------------------------------------
  plan("sc16-overcrowd-fine-alpha", "sc16-overcrowd-fine", SEEDS.alpha, 1440, [
    "adj-overcrowd-effective-limit",
    "adj-overcrowd-multi-tag",
    "adj-penalty-clamp",
  ]),
];
