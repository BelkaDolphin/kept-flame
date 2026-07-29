// ---------------------------------------------------------------------------
// golden vector のフォーマット定義 — ADR-016 / ADR-017 / ADR 残余リスク #9
//
// `algoVersion` bump の必要十分条件は「golden vector が変化すること」(ADR-016(1))
// であり、golden vector は決定論の**権威**である。よってその「形」を先に固定して
// おく必要がある。本モジュールはその形(型 + ダイジェスト + 突合)だけを持ち、
// シナリオ本体とベクタ生成器は T7 後半(`docs/design/golden-vector-spec.md` の
// §8 指示書)で足す。
//
// ===========================================================================
// 1. 1 ベクタが持つもの
// ===========================================================================
//   (a) 最終状態のダイジェスト({@link GoldenObservation.stateDigest})
//       — ADR-016 の「N tick 後状態ハッシュ」。
//   (b) `advanceWithReport` のカウンタ({@link GoldenCounters})
//       — ADR-016 の「主要中間値」に相当し、**「観測される最終状態は同じだが
//       区間分割が変わった」を検出する**ためにある。区間分割の変化は
//       (A)(B)(C) 分類の壊れ方の典型で、状態ハッシュだけでは
//       すり抜ける(= ADR 残余リスク #9 の死角そのもの)。
//   (c) 小さなプローブ値({@link GoldenProbe})
//       — 不一致時に「どの部分系が変わったか」を人間が読める形にするため。
//       ダイジェストは変化の**有無**しか教えてくれない。
//   (d) 踏む経路の申告({@link GoldenVector.paths})
//       — `conformance/coverage.json` のレジストリと突き合わせ、
//       「登録された経路がどのベクタにも踏まれていない」を機械検出する
//       ({@link checkCoverage})。ADR-016 トレードオフの
//       「代表 seed 被覆が不十分だと死角が残る」への回答。
//
// ===========================================================================
// 2. 分割不変なのは状態だけ。カウンタは分割不変ではない
// ===========================================================================
//   `advance(0→T)` と `advance(0→T1)+advance(T1→T)` は**最終状態が一致する**
//   (advance.ts §3)。しかしカウンタは一致しない:
//     - `segmentCount` は T1 で区間が 2 つに割れるので増える。
//     - `rateChangeEventCount` は減ることがある。半開区間の規約(scheduler.ts §2)
//       により tick == toTick のイベントは処理されず、次回の advance では
//       `buildEventQueue` が `until > state.tick` でしか回復イベントを積まないため、
//       **ちょうど回復 tick で区切ると回復イベントはどちらの advance でも
//       発火しない**(状態遷移を持たない境界イベントなので最終状態は一致する)。
//   したがって golden vector は
//     `expected.counters`      = 一括実行のカウンタ
//     `expected.splitCounters` = 分割実行の合計(分割ありのベクタのみ)
//   を**別々に**持ち、状態ダイジェストだけを両者で一致させる。この非対称性を
//   フォーマットに明示しておかないと、分割不変性のテストが「カウンタも一致する
//   はず」という誤った期待で書かれ、T5 で実際に踏んだバグの再発検出が壊れる。
//
// ===========================================================================
// 3. ダイジェストの作り方と、その限界の明示
// ===========================================================================
//   `JSON.stringify(toSerializable(state))` を入力にする。この文字列は
//   serialize.ts §1 により「同じ内容の state からは必ず同じバイト列」であり、
//   ブラウザ 3 エンジン(ADR-017)でも同一になる = 突合の土台になる。
//   ハッシュは engine の FNV-1a-32(rng/fnv1a32.ts)を **4 つの異なる初期値で
//   4 回**通し、末尾に入力長を畳んで 32 桁の 16 進(128bit)にする。
//   engine の既存実装を再利用するのは、ハッシュを別実装で書くと
//   「ハッシュ実装の差」が「挙動の差」に化けるため。
//   限界(正直に明示): FNV-1a-32 は暗号学的ハッシュではなく、4 本は同じ関数族
//   ゆえ完全独立ではない。golden vector は**改変検出器ではなく変化検出器**
//   (敵対的な衝突生成は脅威モデルに含まない)なので、この強度で足りる。
//   併せて {@link GoldenObservation.canonicalJsonLength} を持たせ、長さが変わる
//   種類の変化はハッシュ以前に落ちるようにしてある。
//
// ===========================================================================
// 4. ファイル名(先行計測計画 §3.3 の Windows 260 文字制限)
// ===========================================================================
//   ベクタは 1 ファイル 1 ベクタ。名前は `<vectorId>.json` で、vectorId は
//   小文字英数とハイフンのみ・全体で {@link VECTOR_FILE_NAME_MAX_LENGTH} 文字以内
//   ({@link vectorFileName} が強制)。超える場合だけ vectorId の短縮ハッシュ
//   `v-<8桁hex>.json` へ落とす。
//   予算計算: リポジトリルートの絶対パスを 160 文字と見積もっても
//   160 + `conformance/vectors/`(20) + 40 = 220 < 260。
//   ダイジェストをファイル名に入れないのは意図的で、挙動が変わったときに
//   「ファイルのリネーム」ではなく「同じファイルの中身の差分」として git に
//   出したいため(ADR-016 の「golden 差分あり ⟺ algoVersion bump」を人間が
//   レビューできる形にする)。
// ---------------------------------------------------------------------------

import { toRaw } from "../src/engine/fp";
import { fnv1a32, fnv1a32Uint32 } from "../src/engine/rng/fnv1a32";
import type { ScheduleReport } from "../src/engine/scheduler";
import { compareUtf16 } from "../src/engine/canonicalize";
import { entitiesOfKind, rngStateDomains, type GameState } from "../src/engine/state/state";
import { toSerializable } from "../src/engine/state/serialize";

/**
 * ベクタ JSON の形の版。**フォーマット(フィールド構成)を変えたら上げる**。
 * `algoVersion`(engine の挙動の版・ADR-016)とは別物なので混同しないこと:
 * フォーマット変更では挙動は変わらず、algoVersion bump は不要。
 */
export const GOLDEN_VECTOR_FORMAT_VERSION = 1;

/** ベクタファイル名の長さ上限(§4)。 */
export const VECTOR_FILE_NAME_MAX_LENGTH = 40;

/** vectorId / scenarioId / 経路 ID に許す文字(小文字英数とハイフン)。 */
export const VECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// --- 1. ダイジェスト(§3) --------------------------------------------------

/**
 * 4 本のダイジェストパスの初期値。1 本目は FNV-1a-32 の offset basis、
 * 残りは広く使われる混合定数(黄金比 2^32/φ、MurmurHash3 の finalizer 定数)。
 * 値そのものに意味はなく「異なる初期状態から 4 本走らせる」ことだけが目的。
 */
export const DIGEST_SEEDS: readonly number[] = Object.freeze([
  0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
]);

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/**
 * 正準 JSON 文字列 → 32 桁 16 進のダイジェスト(§3)。
 * 4 本それぞれの末尾に入力長を畳むので、長さだけが違う入力は必ず別値になる。
 */
export function digestOfCanonicalJson(canonicalJson: string): string {
  let out = "";
  for (const seed of DIGEST_SEEDS) {
    out += hex8(fnv1a32Uint32(fnv1a32(canonicalJson, seed), canonicalJson.length));
  }
  return out;
}

/** state → 正準 JSON 文字列(serialize.ts §1 でバイト同一性が保証されている形)。 */
export function canonicalJsonOfState(state: GameState): string {
  return JSON.stringify(toSerializable(state));
}

// --- 2. 観測値の型 ----------------------------------------------------------

/** `advanceWithReport` が返すカウンタ(§1(b))。 */
export interface GoldenCounters {
  readonly segmentCount: number;
  readonly stochasticStepCount: number;
  readonly stochasticTrialCount: number;
  readonly rateChangeEventCount: number;
  readonly recallOccurrenceCount: number;
}

/**
 * 不一致箇所の切り分け用プローブ(§1(c))。
 * 状態全体を持たせない(ダイジェストと二重管理になる)代わりに、
 * 部分系ごとに 1 個ずつスカラを置く。
 */
export interface GoldenProbe {
  /** 最終 tick。 */
  readonly tick: number;
  /** entity 総数(構造が変わっていないかの粗い指標)。 */
  readonly entityCount: number;
  /** 全 resource entity のストック合計(raw)。(A)生産の総量。 */
  readonly resourceStockSumRaw: number;
  /** 全 research entity の進行度合計(raw)。 */
  readonly researchProgressSumRaw: number;
  /** 完了済み research の件数。(B)の発火回数に対応。 */
  readonly researchCompletedCount: number;
  /** 最終 tick 時点で想起困難中の住民数((C)の帰結)。 */
  readonly recallImpairedResidentCount: number;
  /** `recallImpairedUntilTick` の総和。持続抽選のズレを拾う。 */
  readonly recallImpairedUntilTickSum: number;
  /** rngState を保持している domainTag の数(空 / 非空の往復・0 なら未使用)。 */
  readonly rngStateDomainCount: number;
  /** rngState の全 4 語を xor で畳んだ uint32。ストリーム位置のズレを拾う。 */
  readonly rngStateWordsXor: number;
}

/** 1 回の実行から観測される全て。 */
export interface GoldenObservation {
  readonly stateDigest: string;
  readonly canonicalJsonLength: number;
  readonly counters: GoldenCounters;
  readonly probe: GoldenProbe;
}

/**
 * 1 ベクタ。`expected` は一括実行(fromTick → toTick を 1 回で進める)の観測値。
 * `splitTicks` が非空なら、その tick で区切って進めた場合の
 *   - 最終状態ダイジェストが `expected.stateDigest` と一致すること
 *   - カウンタ合計が `splitCounters` と一致すること(§2: 一括とは一致しない)
 * を生成器/検証器が確認する。
 */
export interface GoldenVector {
  readonly formatVersion: number;
  readonly vectorId: string;
  readonly scenarioId: string;
  readonly worldSeed: string;
  /** `hash(worldSeed, ...)` の入力になる uint32。seed → uint32 の写像自体も固定する。 */
  readonly worldSeedU32: number;
  /** シナリオが使う粗粒度ステップ幅(balance.coarseTickMinutes・Fallback は 1)。 */
  readonly coarseTickMinutes: number;
  readonly fromTick: number;
  readonly toTick: number;
  /**
   * null 以外なら、`toTick` を `computeTargetTick(fromTick, elapsedMonotonicMs)` で
   * 求め直して `toTick` と一致することも確認する(72h クランプ経路 ADR-026 の固定)。
   * null なら toTick を直接指定した run。
   */
  readonly elapsedMonotonicMs: number | null;
  /** 分割不変性を確認する区切り tick(昇順・fromTick < t < toTick)。空なら分割なし。 */
  readonly splitTicks: readonly number[];
  /** このベクタが踏む経路 ID(`conformance/coverage.json` に登録済みのもの)。 */
  readonly paths: readonly string[];
  readonly expected: GoldenObservation;
  /** 分割実行のカウンタ合計(`splitTicks` が空なら null)。 */
  readonly splitCounters: GoldenCounters | null;
}

/** ベクタ一覧のマニフェスト(`conformance/vectors/index.json`)。 */
export interface GoldenVectorIndex {
  readonly formatVersion: number;
  /**
   * このベクタ群を生成した engine の版(ADR-016)。**ベクタの中の状態が持つ
   * algoVersion とは別物**である(後者はシナリオの入力として固定値。理由は
   * `docs/design/golden-vector-spec.md` §3.4 の循環回避)。
   */
  readonly algoVersion: number;
  /** ベクタ ID → ファイル名(昇順)。 */
  readonly vectors: readonly { readonly vectorId: string; readonly file: string }[];
  /**
   * content/*.json を**無改変**で使うベクタの ID(昇順)。
   * ADR-017 の週次 content パイプラインゲートは、この部分集合を 3 ブラウザで
   * 突合する(content patch 付きのベクタは engine 側の境界被覆用であり、
   * 週次 content の代表 seed 群ではない)。
   */
  readonly baseContentVectorIds: readonly string[];
}

// --- 3. 観測 ---------------------------------------------------------------

function probeOfState(state: GameState): GoldenProbe {
  let resourceStockSumRaw = 0;
  for (const resource of entitiesOfKind(state, "resource")) {
    resourceStockSumRaw += toRaw(resource.stock);
  }

  let researchProgressSumRaw = 0;
  let researchCompletedCount = 0;
  for (const research of entitiesOfKind(state, "research")) {
    researchProgressSumRaw += toRaw(research.progress);
    if (research.completedTick !== null) researchCompletedCount++;
  }

  let recallImpairedResidentCount = 0;
  let recallImpairedUntilTickSum = 0;
  for (const resident of entitiesOfKind(state, "resident")) {
    // 「最終 tick 時点で想起困難中」= production.ts の isWorkerActive と同じ比較。
    if (state.tick < resident.recallImpairedUntilTick) recallImpairedResidentCount++;
    recallImpairedUntilTickSum += resident.recallImpairedUntilTick;
  }

  let rngStateWordsXor = 0;
  for (const domainTag of rngStateDomains(state)) {
    const words = state.rngState.get(domainTag);
    if (words === undefined) continue;
    for (const word of words) {
      rngStateWordsXor = (rngStateWordsXor ^ word) >>> 0;
    }
  }

  return {
    tick: state.tick,
    entityCount: state.entityStateById.size,
    resourceStockSumRaw,
    researchProgressSumRaw,
    researchCompletedCount,
    recallImpairedResidentCount,
    recallImpairedUntilTickSum,
    rngStateDomainCount: rngStateDomains(state).length,
    rngStateWordsXor,
  };
}

/** `ScheduleReport` からカウンタだけを取り出す(segments は golden に載せない)。 */
export function countersOfReport(report: ScheduleReport): GoldenCounters {
  return {
    segmentCount: report.segmentCount,
    stochasticStepCount: report.stochasticStepCount,
    stochasticTrialCount: report.stochasticTrialCount,
    rateChangeEventCount: report.rateChangeEventCount,
    recallOccurrenceCount: report.recallOccurrenceCount,
  };
}

/** カウンタ列の総和(分割実行の合計を作る・§2)。 */
export function sumCounters(list: readonly GoldenCounters[]): GoldenCounters {
  let segmentCount = 0;
  let stochasticStepCount = 0;
  let stochasticTrialCount = 0;
  let rateChangeEventCount = 0;
  let recallOccurrenceCount = 0;
  for (const counters of list) {
    segmentCount += counters.segmentCount;
    stochasticStepCount += counters.stochasticStepCount;
    stochasticTrialCount += counters.stochasticTrialCount;
    rateChangeEventCount += counters.rateChangeEventCount;
    recallOccurrenceCount += counters.recallOccurrenceCount;
  }
  return {
    segmentCount,
    stochasticStepCount,
    stochasticTrialCount,
    rateChangeEventCount,
    recallOccurrenceCount,
  };
}

/** 最終 state と実行レポートから観測値を作る(ベクタ生成と検証の共通経路)。 */
export function observe(state: GameState, report: ScheduleReport): GoldenObservation {
  const canonicalJson = canonicalJsonOfState(state);
  return {
    stateDigest: digestOfCanonicalJson(canonicalJson),
    canonicalJsonLength: canonicalJson.length,
    counters: countersOfReport(report),
    probe: probeOfState(state),
  };
}

// --- 4. 突合 ---------------------------------------------------------------

const COUNTER_KEYS: readonly (keyof GoldenCounters)[] = [
  "segmentCount",
  "stochasticStepCount",
  "stochasticTrialCount",
  "rateChangeEventCount",
  "recallOccurrenceCount",
];

const PROBE_KEYS: readonly (keyof GoldenProbe)[] = [
  "tick",
  "entityCount",
  "resourceStockSumRaw",
  "researchProgressSumRaw",
  "researchCompletedCount",
  "recallImpairedResidentCount",
  "recallImpairedUntilTickSum",
  "rngStateDomainCount",
  "rngStateWordsXor",
];

/**
 * 期待値と観測値を突き合わせ、**差分の説明を人間可読な行の配列で**返す
 * (空配列 = 一致)。最初の差分で打ち切らないのは、ブラウザ 3 エンジン
 * conformance(ADR-017)や algoVersion bump 判断で「何がどれだけずれたか」を
 * 1 回のレポートで見たいため。
 */
export function compareObservations(
  expected: GoldenObservation,
  actual: GoldenObservation,
): readonly string[] {
  const diffs: string[] = [];
  if (expected.stateDigest !== actual.stateDigest) {
    diffs.push(`stateDigest: 期待 ${expected.stateDigest} / 実際 ${actual.stateDigest}`);
  }
  if (expected.canonicalJsonLength !== actual.canonicalJsonLength) {
    diffs.push(
      `canonicalJsonLength: 期待 ${String(expected.canonicalJsonLength)} / 実際 ${String(actual.canonicalJsonLength)}`,
    );
  }
  for (const key of COUNTER_KEYS) {
    if (expected.counters[key] !== actual.counters[key]) {
      diffs.push(
        `counters.${key}: 期待 ${String(expected.counters[key])} / 実際 ${String(actual.counters[key])}` +
          "(区間分割が変わった可能性・ADR 残余リスク #9)",
      );
    }
  }
  for (const key of PROBE_KEYS) {
    if (expected.probe[key] !== actual.probe[key]) {
      diffs.push(
        `probe.${key}: 期待 ${String(expected.probe[key])} / 実際 ${String(actual.probe[key])}`,
      );
    }
  }
  return diffs;
}

/** カウンタ同士の突合(分割実行の合計を `splitCounters` と比べる・§2)。 */
export function compareCounters(
  label: string,
  expected: GoldenCounters,
  actual: GoldenCounters,
): readonly string[] {
  const diffs: string[] = [];
  for (const key of COUNTER_KEYS) {
    if (expected[key] !== actual[key]) {
      diffs.push(`${label}.${key}: 期待 ${String(expected[key])} / 実際 ${String(actual[key])}`);
    }
  }
  return diffs;
}

// --- 5. ファイル名(§4) ---------------------------------------------------

/** ベクタ ID の形式検査。 */
export function isValidVectorId(vectorId: string): boolean {
  return VECTOR_ID_PATTERN.test(vectorId);
}

/**
 * ベクタ ID → ファイル名(§4)。長すぎる場合だけ短縮ハッシュへ落とす。
 *
 * @throws {Error} vectorId が {@link VECTOR_ID_PATTERN} に一致しない場合
 */
export function vectorFileName(vectorId: string): string {
  if (!isValidVectorId(vectorId)) {
    throw new Error(
      `vectorFileName: "${vectorId}" は ${VECTOR_ID_PATTERN.source} に一致しない` +
        "(ファイル名は小文字統一・Linux runner との差異を排除・先行計測計画 §3.3)",
    );
  }
  const plain = `${vectorId}.json`;
  if (plain.length <= VECTOR_FILE_NAME_MAX_LENGTH) return plain;
  return `v-${hex8(fnv1a32(vectorId))}.json`;
}

// --- 6. 被覆レジストリ(§1(d)) --------------------------------------------

/** 経路が何によって観測されるか。golden vector で観測できないものを正直に区別する。 */
export type CoverageObservedBy =
  /** 最終状態ダイジェストの差として現れる。 */
  | "digest"
  /** `advanceWithReport` のカウンタの差として現れる。 */
  | "counters"
  /** プローブ値の差として現れる。 */
  | "probe"
  /** 分割実行と一括実行のダイジェスト一致として確認する。 */
  | "split-digest"
  /** golden vector では観測できず、engine の単体テストが担保する。 */
  | "unit-test"
  /** content ローダー(schema/engineContent.ts)の reject で担保する。 */
  | "loader-reject";

/** `conformance/coverage.json` の 1 エントリ。 */
export interface CoveragePathEntry {
  readonly id: string;
  readonly title: string;
  /** 根拠(ADR / GDD / 実装ファイルの節)。 */
  readonly refs: readonly string[];
  readonly observedBy: readonly CoverageObservedBy[];
  /** golden vector 以外で担保する経路はここに担保先を書く。 */
  readonly note: string;
}

/** `conformance/coverage.json` 全体。 */
export interface CoverageRegistry {
  readonly formatVersion: number;
  readonly paths: readonly CoveragePathEntry[];
}

/** golden vector で観測する(= ベクタからの申告が必須な)経路か。 */
export function requiresVector(entry: CoveragePathEntry): boolean {
  return entry.observedBy.some(
    (by) => by === "digest" || by === "counters" || by === "probe" || by === "split-digest",
  );
}

/**
 * レジストリとベクタ群の突合(空配列 = 問題なし)。検出するのは 3 種:
 *   (1) レジストリの形式違反(ID 重複・不正な ID・空の refs/observedBy)
 *   (2) golden vector で観測する経路なのに、申告するベクタが 1 本も無い
 *   (3) ベクタが未登録の経路 ID を申告している(タイポ・レジストリ更新漏れ)
 * これが ADR-016 トレードオフ「代表 seed 被覆が不十分だと死角が残る」に対する
 * 機械的な歯止めになる。
 */
export function checkCoverage(
  registry: CoverageRegistry,
  vectors: readonly GoldenVector[],
): readonly string[] {
  const problems: string[] = [];
  const registered = new Set<string>();

  for (const entry of registry.paths) {
    if (!isValidVectorId(entry.id)) {
      problems.push(`経路 ID "${entry.id}" が ${VECTOR_ID_PATTERN.source} に一致しない`);
    }
    if (registered.has(entry.id)) {
      problems.push(`経路 ID "${entry.id}" が重複登録されている`);
    }
    registered.add(entry.id);
    if (entry.title.length === 0) problems.push(`経路 "${entry.id}" の title が空`);
    if (entry.refs.length === 0) problems.push(`経路 "${entry.id}" の refs が空(根拠を書くこと)`);
    if (entry.observedBy.length === 0) {
      problems.push(`経路 "${entry.id}" の observedBy が空(何で観測するか書くこと)`);
    }
  }

  const claimed = new Map<string, string[]>();
  for (const vector of vectors) {
    for (const pathId of vector.paths) {
      if (!registered.has(pathId)) {
        problems.push(
          `ベクタ "${vector.vectorId}" が未登録の経路 "${pathId}" を申告している` +
            "(conformance/coverage.json へ登録するか申告を直すこと)",
        );
        continue;
      }
      const list = claimed.get(pathId);
      if (list === undefined) {
        claimed.set(pathId, [vector.vectorId]);
      } else {
        list.push(vector.vectorId);
      }
    }
  }

  for (const entry of registry.paths) {
    if (!requiresVector(entry)) continue;
    if (!claimed.has(entry.id)) {
      problems.push(
        `経路 "${entry.id}"(${entry.title})を踏む golden vector が 1 本も無い` +
          "(被覆の穴 = ADR 残余リスク #9)",
      );
    }
  }

  return problems;
}

/** 経路 ID → それを踏むベクタ ID(昇順)の対応表。生成器が JSON へ書き出す。 */
export function buildCoverageMatrix(
  registry: CoverageRegistry,
  vectors: readonly GoldenVector[],
): { readonly [pathId: string]: readonly string[] } {
  const matrix: Record<string, string[]> = {};
  for (const entry of registry.paths) {
    matrix[entry.id] = [];
  }
  for (const vector of vectors) {
    for (const pathId of vector.paths) {
      const list = matrix[pathId];
      if (list === undefined) continue;
      list.push(vector.vectorId);
    }
  }
  for (const pathId of Object.keys(matrix)) {
    matrix[pathId]?.sort(compareUtf16);
  }
  return matrix;
}

// --- 7. 単一被覆の警告(spec §9.3(5)(3)・M10) --------------------------------
//
//   `checkCoverage` が検出するのは「1 本も踏まれていない経路」だけであり、
//   「1 本だけで踏まれている経路」(そのベクタが消える/プランが変わると穴が
//   空く)は検出しない。これは fail 条件ではなく**可視化**が目的なので、
//   `checkCoverage` のシグネチャは変えず別関数として足す(spec §9.3(1) の指示)。

/** 1 つの経路を「ベクタ 1 本だけ」が守っている状態の警告 1 件。 */
export interface SingleCoverageWarning {
  readonly pathId: string;
  readonly title: string;
  /** その経路を申告している唯一のベクタ ID。 */
  readonly vectorId: string;
}

/**
 * golden vector で観測する経路(`requiresVector()` が true)のうち、
 * ちょうど 1 本のベクタだけが申告している経路を一覧する(spec §9.1 実測の
 * 「36 経路が 1 本のみ」の可視化)。**fail ではない**警告であり、
 * `checkCoverage` のシグネチャ・戻り値は変更しない。
 *
 * 未登録の経路 ID を申告するベクタ(タイポ等)は `checkCoverage` 側の責務なので
 * ここでは無視する(型の広い `buildCoverageMatrix` と同じ理由で、存在しない
 * 経路 ID は matrix に現れないため自然に除外される)。
 */
export function singleCoverageWarnings(
  registry: CoverageRegistry,
  vectors: readonly GoldenVector[],
): readonly SingleCoverageWarning[] {
  const matrix = buildCoverageMatrix(registry, vectors);
  const warnings: SingleCoverageWarning[] = [];
  for (const entry of registry.paths) {
    if (!requiresVector(entry)) continue;
    const claimedBy = matrix[entry.id] ?? [];
    if (claimedBy.length !== 1) continue;
    const vectorId = claimedBy[0];
    if (vectorId === undefined) continue;
    warnings.push({ pathId: entry.id, title: entry.title, vectorId });
  }
  return warnings.sort((a, b) => compareUtf16(a.pathId, b.pathId));
}
