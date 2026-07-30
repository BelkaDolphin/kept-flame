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

  // --- sc17-prod-full(M10: 生産式の実 content 被覆) --------------------------------------
  // 隣接効果を発生させない孤立配置(scenarios.ts のコメント参照)のため worldSeed は
  // 結果に一切影響しない(rng 消費も無い)。C7 の alpha/beta 2 本義務はこの理由で
  // alpha 1 本のみとする(2 本目は byte-identical になり情報を増やさない)。
  plan("sc17-prod-full-alpha", "sc17-prod-full", SEEDS.alpha, 100, [
    "prod-trait-stat-mul",
    "prod-trait-yield-mul",
    "stat-facility-weights-content",
  ]),

  // --- sc18-sto-overflow(M10: 保管庫オーバーフロー全系統) --------------------------------
  // sc17 と同じ理由で worldSeed 非依存(隣接効果なし・research entity なしで
  // recall 試行も 0 件)なので alpha 1 本のみ。
  plan("sc18-sto-overflow-alpha", "sc18-sto-overflow", SEEDS.alpha, 1440, [
    "sto-capacity-overflow-discard",
    "sto-waste-sponge-convert",
    "sto-capacity-independent",
  ]),
  plan(
    "sc18-sto-overflow-split-alpha",
    "sc18-sto-overflow",
    SEEDS.alpha,
    1440,
    ["sto-capacity-split-invariant"],
    { splitTicks: [500] },
  ),

  // --- sc19-tech-field-stop(M15: tech 別停止が実地要件施設の産出を止める) --------------
  // RNG を一切引かない(techMemoryByKey を直接構築)ので seed 変化は不要
  // (sc17/sc18 と同じ理由・scenarios.ts のコメント参照)。
  plan("sc19-tech-field-stop-alpha", "sc19-tech-field-stop", SEEDS.alpha, 2000, [
    "c-tech-field-stop-production",
  ]),
  plan(
    "sc19-tech-field-stop-split-alpha",
    "sc19-tech-field-stop",
    SEEDS.alpha,
    2000,
    ["split-at-tech-recall-recovery-tick"],
    { splitTicks: [1000] },
  ),

  // --- sc20-tech-loss(M15: (B) 一回性喪失・保持者ゼロの判定) --------------------------
  plan("sc20-tech-loss-alpha", "sc20-tech-loss", SEEDS.alpha, 150, [
    "c-tech-loss-recoverable",
    "c-tech-loss-irreversible",
    "c-tech-loss-holder-survives-no-loss",
  ]),
  plan(
    "sc20-tech-loss-split-alpha",
    "sc20-tech-loss",
    SEEDS.alpha,
    150,
    ["split-at-tech-loss-tick"],
    { splitTicks: [100] },
  ),

  // --- sc21-tech-mastery-cap(M15: 実地稼働の定着度蓄積 + 上限 0.20 clamp) --------------
  plan("sc21-tech-mastery-cap-alpha", "sc21-tech-mastery-cap", SEEDS.alpha, 1000, [
    "c-tech-mastery-accumulate",
    "c-tech-mastery-cap",
  ]),
  plan(
    "sc21-tech-mastery-cap-split-alpha",
    "sc21-tech-mastery-cap",
    SEEDS.alpha,
    1000,
    ["split-at-tech-mastery-progress"],
    { splitTicks: [400] },
  ),

  // --- sc22/sc23-pop-floor(M15: 死亡ゲート・下限ちょうど vs 下限+1) -------------------
  plan("sc22-pop-floor-deferred-alpha", "sc22-pop-floor-deferred", SEEDS.alpha, 100, [
    "life-population-floor-death-gate",
  ]),
  plan("sc23-pop-floor-active-alpha", "sc23-pop-floor-active", SEEDS.alpha, 100, [
    "life-population-floor-death-gate",
  ]),
  plan(
    "sc23-pop-floor-active-split-alpha",
    "sc23-pop-floor-active",
    SEEDS.alpha,
    100,
    ["split-at-death-tick"],
    { splitTicks: [47] },
  ),

  // --- sc24-pop-floor-resolved(M15: 死亡延期 → 晴天漂着で解消) ----------------------
  // createResidentLife が lifespan/joinAge ドメインを新規に引く(base content の
  // 40 本はどれも晴天漂着を発火させていない)ので、C7 に従い alpha/beta を用意する。
  plan("sc24-pop-floor-resolved-alpha", "sc24-pop-floor-resolved", SEEDS.alpha, 250, [
    "life-population-floor-death-gate",
    "life-sunny-drift-arrival",
    "tie-arrival-before-death",
  ]),
  plan("sc24-pop-floor-resolved-beta", "sc24-pop-floor-resolved", SEEDS.beta, 250, [
    "rng-worldseed-variation",
  ]),
  plan(
    "sc24-pop-floor-resolved-split-alpha",
    "sc24-pop-floor-resolved",
    SEEDS.alpha,
    250,
    ["split-at-arrival-retry-tick"],
    { splitTicks: [200] },
  ),

  // --- sc25-life-opt-in(M15: life は住民ごとの opt-in・population floor 不活性) --------
  plan("sc25-life-opt-in-alpha", "sc25-life-opt-in", SEEDS.alpha, 100, ["life-death-basic-opt-in"]),

  // --- sc26-bond-milestone(M15: 節目の全段記録 + 分割不変性) --------------------------
  // research entity なし = (C) 抽選 0 試行(sc16-overcrowd-fine と同じ理由)なので
  // worldSeed に依存しない。
  plan("sc26-bond-milestone-alpha", "sc26-bond-milestone", SEEDS.alpha, 75_000, [
    "mem-bond-milestone-all-tiers",
  ]),
  plan(
    "sc26-bond-milestone-split-alpha",
    "sc26-bond-milestone",
    SEEDS.alpha,
    75_000,
    ["split-at-bond-milestone-tick"],
    { splitTicks: [14_410, 36_024, 72_047] },
  ),

  // --- sc27-partner-loss(M15: 相方喪失の士気ペナ + 死亡時 3処理固定順) ----------------
  plan("sc27-partner-loss-alpha", "sc27-partner-loss", SEEDS.alpha, 1050, [
    "mem-partner-loss-morale-penalty",
    "mem-death-consequence-order",
  ]),
];
