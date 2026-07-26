// ---------------------------------------------------------------------------
// 4サブ予算(#1)の統計処理と結果 JSON 組立 — T10
// 境界定義の正は `docs/design/perf-boundaries.md`。このファイルはそこで決めた
// 「10試行の中央値」「予算との突合」「非決定値を meta へ隔離」だけを実装する。
//
// DOM にも engine にも依存しない純関数だけを置く(vitest から直接叩けるように)。
// 計測そのもの(performance.now を取る場所)は bench/perfMain.ts の責務。
// ---------------------------------------------------------------------------

/** ADR-012(4) の 2s 予算 ms 配分。 */
export const BUDGET_MS = {
  compute: 1100,
  restore: 450,
  hydrate: 250,
  mount: 200,
  total: 2000,
} as const;

/** 区間 ID。実行順(復帰経路の順)に並べる — 設計文書 §1。 */
export const INTERVAL_IDS = ["restore", "compute", "hydrate", "mount"] as const;

export type IntervalId = (typeof INTERVAL_IDS)[number];

/** 予算判定の結果。`"pass"` でも #1 の合格ではない(設計文書 §0)。 */
export type Verdict = "pass" | "fail";

/**
 * 結果 JSON のフォーマット版。境界定義を変えたら必ず上げる(設計文書 §9)。
 *
 * 版 **2 = T11**: B1 が Worker 経路(往復転送込みの `computeWallMs`)に、
 * B2 が `src/platform/persistence.ts` 経路(integrityChecksum 検証を内側に含む)に
 * 差し替わった。版 1(T10)の B1/B2 と**数値は比較できない**ため版を上げる。
 * 境界の定義そのものは T10 が設計文書 §7 で先に決めたとおりで変えていない。
 */
export const PERF_RESULT_SCHEMA = "kept-flame/bench/perf-boundaries/2";

/** 設計文書の版(この実装が従っている境界定義の日付)。 */
export const BOUNDARY_SPEC_VERSION = "2026-07-26+t11";

/** 計画 §5.1 の暫定 K。**根拠は無い**(実機校正で置換するまでの仮置き)。 */
export const PROVISIONAL_DEVICE_K = 5;

export class PerfStatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfStatsError";
  }
}

// --- 1. 基本統計 -----------------------------------------------------------

/**
 * 中央値(設計文書 §2): 昇順ソート後、奇数個なら中央、偶数個なら中央 2 値の平均。
 *
 * @throws {PerfStatsError} 空配列 / 非有限値を含む場合
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new PerfStatsError("median: 空配列の中央値は定義できない");
  }
  const sorted = [...values].sort((a, b) => a - b);
  for (const v of sorted) {
    if (!Number.isFinite(v)) {
      throw new PerfStatsError(`median: 非有限値 ${String(v)} が含まれている`);
    }
  }
  const mid = sorted.length >> 1;
  const hi = sorted[mid];
  if (hi === undefined) {
    throw new PerfStatsError("median: 内部不整合(索引が範囲外)");
  }
  if (sorted.length % 2 === 1) return hi;
  const lo = sorted[mid - 1];
  if (lo === undefined) {
    throw new PerfStatsError("median: 内部不整合(索引が範囲外)");
  }
  return (lo + hi) / 2;
}

/** 表示・JSON 用に ms を 3 桁へ丸める(生の倍精度を JSON へ垂れ流さない)。 */
export function roundMs(value: number): number {
  if (!Number.isFinite(value)) {
    throw new PerfStatsError(`roundMs: 非有限値 ${String(value)}`);
  }
  return Math.round(value * 1000) / 1000;
}

// --- 2. 試行サンプル -------------------------------------------------------

/** 1 試行ぶんの計測値。`subIntervalMs` のキーは `"<区間>.<下位区間>"`。 */
export interface TrialSample {
  /** 0 起点の試行番号(ウォームアップは -1)。 */
  readonly trial: number;
  readonly warmup: boolean;
  readonly intervalMs: { readonly [K in IntervalId]: number };
  readonly subIntervalMs: { readonly [key: string]: number };
}

/** 1 区間ぶんの要約。 */
export interface IntervalSummary {
  readonly medianMs: number;
  /** ウォームアップ試行の値(中央値には入れない・設計文書 §2)。 */
  readonly warmupMs: number | null;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly rawMs: readonly number[];
  /** 下位区間の中央値(親を厳密分割する・設計文書 §2 R7)。 */
  readonly subIntervalMedianMs: { readonly [name: string]: number };
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * ウォームアップを除いた計測試行だけを取り出す。
 *
 * @throws {PerfStatsError} 計測試行が 1 つも無い場合
 */
export function measuredSamples(samples: readonly TrialSample[]): readonly TrialSample[] {
  const measured = samples.filter((s) => !s.warmup);
  if (measured.length === 0) {
    throw new PerfStatsError("measuredSamples: ウォームアップ以外の試行が無い");
  }
  return measured;
}

/**
 * 区間 1 本を要約する。
 *
 * @throws {PerfStatsError} 計測試行が無い場合
 */
export function summarizeInterval(
  samples: readonly TrialSample[],
  intervalId: IntervalId,
): IntervalSummary {
  const measured = measuredSamples(samples);
  const raw = measured.map((s) => s.intervalMs[intervalId]);
  const warmup = samples.find((s) => s.warmup);

  const subNames = new Set<string>();
  const prefix = `${intervalId}.`;
  for (const sample of measured) {
    for (const key of Object.keys(sample.subIntervalMs)) {
      if (key.startsWith(prefix)) subNames.add(key.slice(prefix.length));
    }
  }
  const subIntervalMedianMs: { [name: string]: number } = {};
  for (const name of [...subNames].sort()) {
    const values = measured.map((s) => s.subIntervalMs[`${prefix}${name}`] ?? 0);
    subIntervalMedianMs[name] = roundMs(median(values));
  }

  return {
    medianMs: roundMs(median(raw)),
    warmupMs: warmup === undefined ? null : roundMs(warmup.intervalMs[intervalId]),
    minMs: roundMs(Math.min(...raw)),
    maxMs: roundMs(Math.max(...raw)),
    meanMs: roundMs(meanOf(raw)),
    rawMs: raw.map(roundMs),
    subIntervalMedianMs,
  };
}

/** 全 4 区間の要約。 */
export function summarizeAllIntervals(samples: readonly TrialSample[]): {
  readonly [K in IntervalId]: IntervalSummary;
} {
  return {
    restore: summarizeInterval(samples, "restore"),
    compute: summarizeInterval(samples, "compute"),
    hydrate: summarizeInterval(samples, "hydrate"),
    mount: summarizeInterval(samples, "mount"),
  };
}

/** 試行ごとの 4 区間合計。 */
export function trialTotalsMs(samples: readonly TrialSample[]): readonly number[] {
  return measuredSamples(samples).map((s) =>
    INTERVAL_IDS.reduce((acc, id) => acc + s.intervalMs[id], 0),
  );
}

// --- 3. 予算との突合 -------------------------------------------------------

export interface IntervalJudgement {
  readonly observedMs: number;
  readonly budgetMs: number;
  readonly verdict: Verdict;
  /** 予算に対する使用率(1 を超えたら超過)。 */
  readonly ratio: number;
}

export interface Judgement {
  /** 実測へ掛けた係数。1 = 素のデスクトップ実測、5 = 計画 §5.1 の暫定 K。 */
  readonly factor: number;
  readonly perInterval: { readonly [K in IntervalId]: IntervalJudgement };
  /** 試行ごとの 4 区間合計の中央値(× factor)。 */
  readonly totalMs: number;
  /** 4 区間の中央値の単純和(× factor)。参考。 */
  readonly sumOfMediansMs: number;
  readonly totalBudgetMs: number;
  readonly totalVerdict: Verdict;
}

/** 予算 ≥ 実測 なら pass(等号は pass)。 */
export function verdictOf(observedMs: number, budgetMs: number): Verdict {
  return observedMs <= budgetMs ? "pass" : "fail";
}

/**
 * 4 区間の中央値と合計を予算へ突き合わせる。
 *
 * @param factor 実測へ掛ける係数(デスクトップ素値なら 1、暫定 K 判定なら 5)
 * @throws {PerfStatsError} factor が非有限 / 0 以下の場合
 */
export function judgeIntervals(
  summaries: { readonly [K in IntervalId]: IntervalSummary },
  totalMedianMs: number,
  factor: number,
): Judgement {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new PerfStatsError(`judgeIntervals: factor ${String(factor)} が正の有限値でない`);
  }
  const perInterval = {} as { [K in IntervalId]: IntervalJudgement };
  let sumOfMedians = 0;
  for (const id of INTERVAL_IDS) {
    const observed = roundMs(summaries[id].medianMs * factor);
    const budget = BUDGET_MS[id];
    sumOfMedians += observed;
    perInterval[id] = {
      observedMs: observed,
      budgetMs: budget,
      verdict: verdictOf(observed, budget),
      ratio: roundMs(observed / budget),
    };
  }
  const total = roundMs(totalMedianMs * factor);
  return {
    factor,
    perInterval,
    totalMs: total,
    sumOfMediansMs: roundMs(sumOfMedians),
    totalBudgetMs: BUDGET_MS.total,
    totalVerdict: verdictOf(total, BUDGET_MS.total),
  };
}

// --- 4. 結果 JSON ----------------------------------------------------------

/** 非決定値の隔離先(設計文書 §9)。ここ以外に実行時刻/UA を置かない。 */
export interface PerfMeta {
  readonly generatedAt: string;
  readonly userAgent: string;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGb: number | null;
  readonly devicePixelRatio: number | null;
  readonly viewportCss: { readonly widthPx: number; readonly heightPx: number } | null;
  /** true なら高分解能タイマ(設計文書 §2 のタイマ分解能)。 */
  readonly crossOriginIsolated: boolean;
  readonly timeOriginMs: number | null;
}

/** 決定論的な計測条件。ここに非決定値を入れてはならない。 */
export interface PerfWorkload {
  readonly worldSeed: string;
  readonly startTick: number;
  readonly targetTick: number;
  readonly coarseTickMinutes: number;
  readonly residentCount: number;
  readonly facilityCount: number;
  readonly researchCount: number;
  readonly entityCount: number;
  readonly gridCells: number;
  readonly domNodesPerCell: number;
  readonly expectedDomNodes: number;
  readonly saveBytes: number;
  readonly measuredTrials: number;
  readonly warmupTrials: number;
  /**
   * 代表盤面セーブの integrityChecksum(T11・ADR-012(2))。決定論の自己検査に
   * 使う値であり、同じ盤面なら環境に依らず同じになる。
   */
  readonly integrityChecksum?: number;
}

/** engine の自己申告カウンタ(ワークロードが設計どおりかの検証)。 */
export interface PerfEngineCounters {
  readonly segmentCount: number;
  readonly stochasticStepCount: number;
  readonly stochasticTrialCount: number;
  readonly rateChangeEventCount: number;
  readonly recallOccurrenceCount: number;
}

export interface PerfSupplementary {
  readonly contentLoadMs: number;
  readonly contentJsonParseMs: number;
  readonly boardBuildMs: number;
  /**
   * `indexedDB.open()`。T11 以降は**初回作成を含む cold open**
   * (`onupgradeneeded` 込み)を入れる。設計文書 §11-(1) の判断材料。
   */
  readonly idbOpenMs: number;
  readonly idbPutMs: number;
  readonly unmountMedianMs: number;
  /** `idbOpenMs + restore 中央値`(設計文書 §3 B2 の派生値)。 */
  readonly restoreWithOpenMs: number;
  /**
   * 既存 DB を開き直したときの `indexedDB.open()`(T11 で追加)。
   * cold(初回作成)との差が「44.6ms が DB 作成コストなのか毎回のコストなのか」の
   * 答えになる(設計文書 §11-(1))。
   */
  readonly idbOpenWarmMs?: number;
  /**
   * そのページで**最初に IndexedDB へ触った**呼び出しの所要時間(T11 で追加。
   * ベンチでは前回 DB の `deleteDatabase`)。IndexedDB サブシステム自体の
   * 起動コストがここに落ちるため、`idbOpenMs` から分離して読める。
   * T10 が §11-(1) に登録した「idbOpen 44.6ms」の正体を切り分けるための値。
   */
  readonly idbFirstTouchMs?: number;
  /** `encodeSaveRecord`(toSerializable + stringify + checksum)。書込側・予算外。 */
  readonly saveEncodeMs?: number;
}

/** save サイズ感度(予算判定に使わない参考値・設計文書 §3 B2)。 */
export interface PerfSensitivity {
  readonly restoreAtTargetSaveBytes: {
    readonly saveBytes: number;
    readonly entityCount: number;
    readonly summary: IntervalSummary;
  } | null;
  /**
   * 同じ catch-up をメインスレッド同期 advance で回したときの参考値(T11)。
   * ADR-026(3) は tick 差 ≤600 をメインスレッド経路と定めているので、これは
   * 「旧実装の名残」ではなく**実アプリの別経路**である。B1(Worker 経路)との
   * 差が Worker 越しの往復コスト(計測 #8)そのものになる。
   */
  readonly computeOnMainThread?: {
    readonly summary: IntervalSummary;
    readonly route: string;
  };
}

/** Worker 経路の補助情報(T11・設計文書 §7)。 */
export interface PerfWorkerReport {
  /**
   * `"preboot"` = アプリ起動時に Worker を作る(起動コストは予算外)。
   * `"onDemand"` = 復帰時に作る(その場合 bootMs/contentTransferMs は B1 算入)。
   * 設計文書 §7-4 が「どちらの実装かを結果 JSON に書くこと」と規定している。
   */
  readonly lifecycle: "onDemand" | "preboot";
  readonly protocolVersion: number;
  /** ADR-029(1) の二系統のうち実際に走った方。 */
  readonly updateStrategy: string;
  /** ADR-026(3) の tick 差しきい値で選ばれた経路。 */
  readonly route: string;
  /** `new Worker()` + モジュール評価(予算外)。 */
  readonly bootMs: number;
  /** content 1回転送の往復(予算外・ADR-029(1))。 */
  readonly contentTransferMs: number;
  /** Worker 内の計算時間(受領〜完了 post 直前)の中央値。B1 の内訳。 */
  readonly computeWorkerMedianMs: number;
  /** 完了スナップショット転送 + スケジューリングの残差の中央値。B1 の内訳。 */
  readonly snapshotTransferMedianMs: number;
  /** 入力 state の postMessage(構造化複製シリアライズ込み)の中央値。B1 の内訳。 */
  readonly requestPostMedianMs: number;
  /** `computeWallMs 中央値 + bootMs + contentTransferMs`(onDemand 実装での換算値)。 */
  readonly computeWallWithBootMs: number;
  /** 転送されたスナップショットの entity 数(転送が壊れていないことの確認)。 */
  readonly snapshotEntityCount: number;
}

export interface PerfResultInput {
  readonly meta: PerfMeta;
  readonly workload: PerfWorkload;
  readonly engineCounters: PerfEngineCounters;
  readonly samples: readonly TrialSample[];
  readonly supplementary: PerfSupplementary;
  readonly sensitivity: PerfSensitivity;
  readonly observedDomNodeCount: number;
  readonly worker?: PerfWorkerReport;
}

export interface PerfResult {
  readonly $schema: string;
  readonly boundarySpecVersion: string;
  readonly meta: PerfMeta;
  readonly workload: PerfWorkload;
  readonly engineCounters: PerfEngineCounters;
  readonly budgets: typeof BUDGET_MS;
  readonly intervals: { readonly [K in IntervalId]: IntervalSummary } & {
    /** B3 の忠実度(設計文書 §5 末尾)。実 UI ストア導入まで placeholder。 */
    readonly hydrateFidelity: "placeholder" | "real-store";
    /**
     * B1 の忠実度(T11)。ADR-029(1) の可変ドラフトは engine 側 API 待ちで
     * 未実装なので、現状は構造共有系での実測 = **上限側の見積り**である
     * (`src/platform/catchUp.ts` §1)。
     */
    readonly computeFidelity: "worker-mutable-draft" | "worker-structural-sharing";
    /**
     * B2 の忠実度(T11)。`persistence` = 実 persistence.ts 経路
     * (integrityChecksum 検証を内側に含む)。
     */
    readonly restoreFidelity: "bench-idb" | "persistence";
  };
  readonly supplementary: PerfSupplementary;
  readonly sensitivity: PerfSensitivity;
  readonly worker: PerfWorkerReport | null;
  readonly observed: {
    readonly domNodeCount: number;
    readonly domNodeCountMatchesExpected: boolean;
  };
  readonly judgement: {
    readonly isOfficialVerdict: false;
    readonly desktopRaw: Judgement;
    readonly withProvisionalK: Judgement;
    readonly provisionalDeviceK: number;
    readonly note: string;
  };
}

const JUDGEMENT_NOTE =
  "デスクトップ実測は実機の下限見積りにしかならない(先行計測計画 §1 の区分②)。" +
  "K=5 は計画 §5.1 の暫定値で根拠は無く、bench/kernel.html 相当の校正カーネルで " +
  "K_device を実測して置き換えるまで #1 を合格と宣言してはならない。" +
  "totalMs は試行ごとの 4 区間合計の中央値、sumOfMediansMs は区間別中央値の和(別物)。" +
  "T11 以降 B1(compute)は Worker 往復込みの computeWallMs、B2(restore)は " +
  "integrityChecksum 検証込みであり、T10($schema .../1)の値とは比較できない。";

/**
 * 結果 JSON を組み立てる(純関数)。
 *
 * @throws {PerfStatsError} 計測試行が無い場合
 */
export function buildPerfResult(input: PerfResultInput): PerfResult {
  const summaries = summarizeAllIntervals(input.samples);
  const totalMedian = median(trialTotalsMs(input.samples));
  return {
    $schema: PERF_RESULT_SCHEMA,
    boundarySpecVersion: BOUNDARY_SPEC_VERSION,
    meta: input.meta,
    workload: input.workload,
    engineCounters: input.engineCounters,
    budgets: BUDGET_MS,
    intervals: {
      ...summaries,
      hydrateFidelity: "placeholder",
      computeFidelity:
        input.worker?.updateStrategy === "mutable-draft"
          ? "worker-mutable-draft"
          : "worker-structural-sharing",
      restoreFidelity: "persistence",
    },
    supplementary: input.supplementary,
    sensitivity: input.sensitivity,
    worker: input.worker ?? null,
    observed: {
      domNodeCount: input.observedDomNodeCount,
      domNodeCountMatchesExpected: input.observedDomNodeCount === input.workload.expectedDomNodes,
    },
    judgement: {
      isOfficialVerdict: false,
      desktopRaw: judgeIntervals(summaries, totalMedian, 1),
      withProvisionalK: judgeIntervals(summaries, totalMedian, PROVISIONAL_DEVICE_K),
      provisionalDeviceK: PROVISIONAL_DEVICE_K,
      note: JUDGEMENT_NOTE,
    },
  };
}
