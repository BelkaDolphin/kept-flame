// ---------------------------------------------------------------------------
// CDP 経由の GC ポーズ抽出(計測 #2 後半)— T12
// 境界定義の正は `docs/design/perf-boundaries.md` §8-3。
//
// `performance.measureUserAgentSpecificMemory()`(bench/perfMain.ts)はヒープの
// 「増分」しか取れず、「ポーズ」(GC が主スレッドを止めた時間)は測れない。
// ポーズは Chrome DevTools Protocol の Tracing ドメインでしか取れないため、
// ここだけ Playwright の CDPSession を直接使う(新規 npm 依存禁止・計画書の
// 指示どおり `chrome-devtools-protocol` パッケージは追加しない)。
//
// ===========================================================================
// 1. どの GC イベントを「ポーズ」として数えるか
// ===========================================================================
//   カテゴリを 2 段に分けて信頼する:
//     - `disabled-by-default-v8.gc` / `disabled-by-default-v8.gc_stats`:
//       この 2 カテゴリは定義上 GC 専用だが、**実測で確認したところ**
//       `UserBlocking` / `IsLoading` という 2 つの名前だけは GC のフェーズではない
//       (タスク優先度/読み込み状態の注釈スコープと見られる)。根拠: 実際の
//       トレースで `UserBlocking` は begin 3 件 / end 2 件と**対応が壊れており**
//       (真に入れ子のフェーズなら一致するはず)、単純な LIFO 対応付けをすると
//       308ms もの偽の継続時間を生む。他の全名前(Scavenge/Marking/
//       IncrementalMarking/Incremental Mark-Compact/Sweeping/Atomic/
//       ObservablePause/MarkCompactCollector::*/Evacuator::*/
//       LiveObjectVisitor::*/RememberedSetUpdatingItem::Process/V8.GC*)は
//       begin/end(または complete)の対応が正しく取れており、名前も V8 の GC
//       内部フェーズ用語と一致する。よってこの 2 つだけを名指しで除外する
//       (推測で決め打ちにせず実測で確認済み・CLAUDE.md「幻覚防止」)。
//     - `disabled-by-default-devtools.timeline`: DevTools Performance パネルの
//       「GC」トラックの元データだが、Layout/Paint 等 GC と無関係なイベントも
//       大量に含む広いカテゴリなので、名前が `MajorGC`/`MinorGC` のものだけを拾う
//       (実測ではこの 2 つは 1 度も観測されなかった。Chromium 151 のこの
//       ワークロードでは v8.gc 側の低レベルフェーズ名だけが飛んでくる)。
//   実際にどの名前が観測されたかは結果 JSON の `observedEventNames` に
//   機械可読で残す。
//
// ===========================================================================
// 2. どの区間で起きた GC かを mark/measure で切り出す
// ===========================================================================
//   `bench/perfMain.ts` は T10 の時点から `kf:compute:start` / `kf:compute:end`
//   / `kf:compute`(User Timing measure)を**固定名**で発行している
//   (perf-boundaries.md §8-3「名前を変えてはならない」)。`performance.mark()`
//   に `{ startTime }` を渡すと、Chromium の trace イベントはその startTime を
//   タイムスタンプとして使う(呼び出し時刻ではない)ため、trace 上の
//   `blink.user_timing` カテゴリの `kf:compute` イベントは B1 の実際の
//   `[開始, 終了)` 区間を指す。この窓と重なる GC イベントだけを
//   「catch-up 中の GC ポーズ」として抽出する。
//
// ===========================================================================
// 3. 正直な限界
// ===========================================================================
//   - トレース区間は「B1(compute)の 11 試行(ウォームアップ含む)全部」であり、
//     1 回の catch-up の「ピーク」ではなく全試行を通した最大値である。
//   - デスクトップ実測は実機の下限見積りにしかならない(計画 §1 の区分②)。
//     0 件観測は「GC が全く走らなかった」以上のことを言わず、
//     「予算に余裕がある」の強い根拠にはならない(ワークロードが軽すぎて
//     GC 自体が誘発されていない可能性がある)。
//   - `Incremental Mark-Compact` 等の「サイクル全体」を表す名前の duration は
//     並行/インクリメンタル GC のうち主スレッドを実際に止めていない区間を
//     含みうる(名前どおり「incremental」は非停止のはず)。真の
//     「stop-the-world 時間」に近いのはネストされた `Atomic` /
//     `ObservablePause`(実測で確認済みの対になる名前)の方だが、
//     どちらが実態に近いかは判定せず**両方とも observedEventNames 付きの
//     参考値として結果に残す**(過大/過小のどちらの方向にも断定しない)。
// ---------------------------------------------------------------------------

import { expect, test } from "@playwright/test";

import { median, roundMs, type PerfResult } from "./perfStats";

/** Chrome トレースイベント形式(必要なフィールドだけ)。 */
interface RawTraceEvent {
  readonly cat?: string;
  readonly name?: string;
  readonly ph?: string;
  readonly ts?: number;
  readonly dur?: number;
  readonly pid?: number;
  readonly tid?: number;
}

interface DurationEvent {
  readonly name: string;
  readonly cat: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly durationMs: number;
}

/**
 * トレースイベントから「継続時間つきイベント」を組み立てる。
 * complete イベント(ph "X")はそのまま、begin/end ペア(ph "B"/"b" と "E"/"e")は
 * 同一 (name, cat, pid, tid) キーの LIFO で対応付ける。
 *
 * kf:* の measure も GC イベントも同時多重発生しない(単一メインスレッドで
 * 逐次実行される)ため、LIFO 対応付けで十分正しくペアになる。
 */
function toDurationEvents(events: readonly RawTraceEvent[]): DurationEvent[] {
  const result: DurationEvent[] = [];

  for (const e of events) {
    if (
      e.ph === "X" &&
      typeof e.ts === "number" &&
      typeof e.dur === "number" &&
      e.name !== undefined
    ) {
      result.push({
        name: e.name,
        cat: e.cat ?? "",
        startUs: e.ts,
        endUs: e.ts + e.dur,
        durationMs: e.dur / 1000,
      });
    }
  }

  const openByKey = new Map<string, RawTraceEvent[]>();
  const sorted = [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  for (const e of sorted) {
    if (e.name === undefined || typeof e.ts !== "number") continue;
    const key = `${e.name}|${e.cat ?? ""}|${String(e.pid ?? "")}|${String(e.tid ?? "")}`;
    if (e.ph === "B" || e.ph === "b") {
      const list = openByKey.get(key) ?? [];
      list.push(e);
      openByKey.set(key, list);
    } else if (e.ph === "E" || e.ph === "e") {
      const list = openByKey.get(key);
      const begin = list?.pop();
      if (begin !== undefined && typeof begin.ts === "number") {
        result.push({
          name: e.name,
          cat: e.cat ?? "",
          startUs: begin.ts,
          endUs: e.ts,
          durationMs: (e.ts - begin.ts) / 1000,
        });
      }
    }
  }
  return result;
}

const V8_GC_CATEGORIES = new Set(["disabled-by-default-v8.gc", "disabled-by-default-v8.gc_stats"]);
const TIMELINE_CATEGORY = "disabled-by-default-devtools.timeline";
const TIMELINE_GC_NAMES = new Set(["MajorGC", "MinorGC"]);
/**
 * v8.gc カテゴリに同居するが GC フェーズではないと実測で確認済みの名前(§1)。
 * begin/end の対応が壊れている(= 単純ネストされたスコープではない)ため、
 * LIFO 対応付けにかけると意味のない継続時間を生む。
 */
const V8_GC_NON_PAUSE_NAMES = new Set(["UserBlocking", "IsLoading"]);

/** §1 の 2 段判定(v8.gc カテゴリは名指し除外つきで採用・devtools.timeline は名前を絞る)。 */
function isGcCandidate(e: DurationEvent): boolean {
  if (V8_GC_CATEGORIES.has(e.cat)) return !V8_GC_NON_PAUSE_NAMES.has(e.name);
  if (e.cat === TIMELINE_CATEGORY) return TIMELINE_GC_NAMES.has(e.name);
  return false;
}

function overlaps(
  window: { readonly start: number; readonly end: number },
  e: DurationEvent,
): boolean {
  return e.startUs < window.end && e.endUs > window.start;
}

interface PageResult {
  readonly meta: { readonly crossOriginIsolated: boolean };
  readonly memory: PerfResult["memory"];
}

test("bench/perf.html: CDP トレースから catch-up(B1)中の GC ポーズを抽出する", async ({
  page,
  context,
}, testInfo) => {
  await page.goto("about:blank");

  const client = await context.newCDPSession(page);
  const rawEvents: RawTraceEvent[] = [];
  client.on("Tracing.dataCollected", (payload) => {
    const chunk = (payload as { readonly value?: readonly unknown[] }).value ?? [];
    rawEvents.push(...(chunk as readonly RawTraceEvent[]));
  });
  const tracingComplete = new Promise<void>((resolve) => {
    client.once("Tracing.tracingComplete", () => {
      resolve();
    });
  });

  await client.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      includedCategories: [
        "disabled-by-default-v8.gc",
        "disabled-by-default-v8.gc_stats",
        "disabled-by-default-devtools.timeline",
        "blink.user_timing",
      ],
    },
  });

  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/perf.html?autorun=1");
  await page.waitForFunction(
    () => (window as unknown as { __PERF_DONE__?: boolean }).__PERF_DONE__ === true,
    undefined,
    { timeout: 150_000 },
  );

  const pageError = await page.evaluate(
    () => (window as unknown as { __PERF_ERROR__?: string }).__PERF_ERROR__ ?? null,
  );
  expect(pageError, "ベンチがエラーで終わっている").toBeNull();
  expect(consoleErrors, "ページ内で未捕捉例外が出ている").toEqual([]);

  await client.send("Tracing.end");
  await tracingComplete;

  const result = (await page.evaluate(
    () => (window as unknown as { __PERF_RESULT__: unknown }).__PERF_RESULT__,
  )) as PageResult;

  // T12 の前提(bench/vite.perf.config.ts の COOP/COEP)が効いているかの確認。
  expect(result.meta.crossOriginIsolated, "cross-origin isolation が効いていない").toBe(true);

  const durationEvents = toDurationEvents(rawEvents);
  // 試行は逐次実行なので kf:compute の窓は互いに素(重ならない)。時系列に並べれば
  // 先頭 = ウォームアップ試行(perf-boundaries.md §2「試行回数と中央値」: ループの
  // 最初に必ず 1 回だけ走る)。trial 番号を trace の args から読むのではなく、
  // この時系列の事実だけに依拠する(User Timing measure の detail が trace event
  // へどう載るかは実装依存で確認が取れていないため)。
  const computeWindows = durationEvents
    .filter((d) => d.name === "kf:compute")
    .map((d) => ({ start: d.startUs, end: d.endUs }))
    .sort((a, b) => a.start - b.start);
  // これが 0 だと mark/measure が trace に載っていない(名前を変えた等)ので、
  // GC ポーズを B1 に絞り込めていない可能性が高い = 構造的な健全性チェック。
  expect(computeWindows.length, "kf:compute の measure が trace から見つからない").toBeGreaterThan(
    0,
  );

  const warmupWindow = computeWindows[0];
  const measuredWindows = computeWindows.slice(1);

  const gcEvents = durationEvents.filter(isGcCandidate);
  const toMs = (list: readonly DurationEvent[]): number[] => list.map((g) => roundMs(g.durationMs));
  const maxOf = (xs: readonly number[]): number => (xs.length > 0 ? Math.max(...xs) : 0);

  const warmupDurationsMs =
    warmupWindow === undefined ? [] : toMs(gcEvents.filter((gc) => overlaps(warmupWindow, gc)));
  const measuredDurationsMs = toMs(
    gcEvents.filter((gc) => measuredWindows.some((w) => overlaps(w, gc))),
  );
  const allComputeDurationsMs = toMs(
    gcEvents.filter((gc) => computeWindows.some((w) => overlaps(w, gc))),
  );
  const allRunDurationsMs = toMs(gcEvents);

  // 判定は**計測試行(ウォームアップ除く)の最大値**で行う(perf-boundaries.md §2
  // の「10 試行の中央値・warmup は別枠」と同じ扱い方 — GC ポーズは中央値でなく
  // 最大値で見るのが ADR-029(1) の趣旨だが、ウォームアップは cold start の
  // 一過性コスト(JIT 未暖機・初回モジュール評価)であって「catch-up 1 回あたりの
  // 定常ポーズ」を表さないため、判定からは除外し参考値として別出しする)。
  const GC_PAUSE_BUDGET_MS = 50;

  const summary = {
    $schema: "kept-flame/bench/gc-trace/1",
    generatedAt: new Date().toISOString(),
    meta: {
      crossOriginIsolated: result.meta.crossOriginIsolated,
      rawTraceEventCount: rawEvents.length,
      computeWindowCount: computeWindows.length,
    },
    gc: {
      eventsTotal: gcEvents.length,
      eventsDuringComputeAll: allComputeDurationsMs.length,
      eventsDuringWarmup: warmupDurationsMs.length,
      eventsDuringMeasured: measuredDurationsMs.length,
      observedEventNames: [...new Set(gcEvents.map((g) => g.name))].sort(),
      maxPauseWarmupMs: maxOf(warmupDurationsMs),
      maxPauseMeasuredMs: maxOf(measuredDurationsMs),
      maxPauseDuringComputeAllMs: maxOf(allComputeDurationsMs),
      maxPauseAllRunMs: maxOf(allRunDurationsMs),
      medianPauseMeasuredMs:
        measuredDurationsMs.length > 0 ? roundMs(median(measuredDurationsMs)) : null,
      pauseDurationsMeasuredMs: [...measuredDurationsMs].sort((a, b) => b - a),
      pauseDurationsWarmupMs: [...warmupDurationsMs].sort((a, b) => b - a),
    },
    memory: result.memory,
    judgement: {
      isOfficialVerdict: false,
      gcPauseBudgetMs: GC_PAUSE_BUDGET_MS,
      // 判定は計測試行(ウォームアップ除く)基準。ウォームアップの実測は
      // gc.maxPauseWarmupMs に別掲(cold start の参考値・合否には使わない)。
      gcPauseVerdict: maxOf(measuredDurationsMs) <= GC_PAUSE_BUDGET_MS ? "pass" : "fail",
      heapIncrementBudgetMb: 48,
      heapIncrementVerdict: !result.memory.supported
        ? "unmeasured"
        : result.memory.peakDeltaMb !== null && result.memory.peakDeltaMb <= 48
          ? "pass"
          : "fail",
      note:
        "デスクトップ実測は実機の下限見積りにしかならない(先行計測計画 §1 の区分②)。" +
        "gcPauseVerdict は計測試行(ウォームアップ除く)の最大値で判定する" +
        "(perf-boundaries.md §2 の warmup 別枠方針を GC ポーズにも適用)。" +
        "0 件観測は『GC が誘発されなかった』以上のことを言わず、合格の強い根拠にはならない" +
        "(perf-boundaries.md §8-1/§8-3)。MajorGC/MinorGC の duration は DevTools" +
        "タイムライン上の区間長であり、並行/インクリメンタル GC の非停止区間を含みうるため" +
        "真の stop-the-world 時間とは一致しない可能性がある(observedEventNames を参照)。",
    },
  };

  // bench 系ファイルは engine 純粋性ルール対象外なので console は禁止されていない
  // (eslint.config.js の no-console は ENGINE_FILES 限定)。
  console.log(`[T12 gcTrace] ${JSON.stringify(summary)}`);
  await testInfo.attach("gc-trace-result.json", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });

  // 性能値の合否は見ない(perfSmoke.spec.ts と同じ方針・§0)。見るのは
  // 「トレースが実際に取れて GC 候補イベントを分類できたか」の構造的健全性だけ。
  expect(summary.meta.rawTraceEventCount).toBeGreaterThan(0);
});
