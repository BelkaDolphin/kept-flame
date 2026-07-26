// ---------------------------------------------------------------------------
// catch-up Worker のメイン側ハンドル — T11 / ADR-019 / ADR-029
// 境界定義の正は `docs/design/perf-boundaries.md` §3 B1 / §7。
//
// ===========================================================================
// 1. B1(compute)の計測点(perf-boundaries §7-1 / §7-2)
// ===========================================================================
//   Worker の `performance.now()` は**そのワーカ固有の timeOrigin** を基準に
//   するので、メイン側の時刻と引き算してはならない。したがって:
//
//     computeWallMs   = メイン側で見た「postMessage → 完了メッセージ受信」
//                       (= スレッド往復 + 入力 state 転送 + 計算 + スナップ転送)
//     workerHandlerMs = Worker 側で測った「受領 → 完了 post 直前」(継続時間)
//     requestPostMs   = メイン側 `postMessage()` 呼び出しそのものの所要時間
//                       (構造化複製のシリアライズを含む)
//     transportMs     = computeWallMs − requestPostMs − workerHandlerMs
//                       (= 受信側デシリアライズ 2 回 + スケジューリング +
//                          Worker 側 postMessage のシリアライズ)
//
//   `transportMs` を**残差として定義する**ことで、下位区間の合計が
//   `computeWallMs` を過不足なく分割する(perf-boundaries §2 R7)。
//   **判定式は `computeWallMs ≤ 1100ms`**(§7-2)であって Worker 内時間ではない。
//
// ===========================================================================
// 2. content は 1 回だけ転送する(ADR-029(1))
// ===========================================================================
//   `startCatchUpWorker` の初期化で 1 回送るだけで、catch-up 要求には積まない。
//   この転送は**アプリ起動時**の作業なので**予算外**(補助メトリクス
//   `contentTransferMs`・perf-boundaries §7-2)。
// ---------------------------------------------------------------------------

import type { EngineContent } from "../engine/rules/types";
import type { GameState } from "../engine/state/state";
import {
  ACTIVE_CATCH_UP_STRATEGY,
  CatchUpError,
  type CatchUpCounters,
  type CatchUpPhaseMs,
  type MainToWorkerMessage,
  type StateUpdateStrategy,
  type TransferableAdvanceContext,
  type WorkerToMainMessage,
} from "./catchUp";

/** 1 回の catch-up 往復の結果と内訳(§1)。 */
export interface WorkerCatchUpResult {
  readonly snapshot: GameState;
  /**
   * Worker が計算済みの隣接乗数など(`restoreAdvanceContext` で AdvanceContext へ
   * 組み直す)。B3 が engine の再計算を含まないようにするために返す
   * (perf-boundaries §3 B3 / §12-3)。
   */
  readonly advanceContext: TransferableAdvanceContext;
  readonly strategy: StateUpdateStrategy;
  readonly counters: CatchUpCounters;
  /** B1 の本体。判定はこの値で行う(§1)。 */
  readonly computeWallMs: number;
  readonly requestPostMs: number;
  readonly workerHandlerMs: number;
  readonly phaseMs: CatchUpPhaseMs;
  /** 残差(§1)。完了スナップショット転送のコストはここに現れる。 */
  readonly transportMs: number;
}

export interface CatchUpWorkerHandle {
  /** `new Worker()` + モジュール評価(予算外・perf-boundaries §7-4)。 */
  readonly bootMs: number;
  /** content 1回転送の往復(予算外・§2)。 */
  readonly contentTransferMs: number;
  readonly catchUp: (
    state: GameState,
    targetTick: number,
    strategy?: StateUpdateStrategy,
  ) => Promise<WorkerCatchUpResult>;
  readonly terminate: () => void;
}

interface PendingRequest {
  readonly resolve: (result: WorkerCatchUpResult) => void;
  readonly reject: (error: Error) => void;
  readonly startedAt: number;
  readonly requestPostMs: number;
}

function asWorkerMessage(data: unknown): WorkerToMainMessage {
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { kind?: unknown }).kind !== "string"
  ) {
    throw new CatchUpError("Worker から種別不明のメッセージが来た");
  }
  return data as WorkerToMainMessage;
}

/**
 * catch-up Worker を起動し、content を 1 回転送して使える状態にする。
 *
 * 実アプリではアプリ起動時に 1 回呼ぶ(= `workerLifecycle: "preboot"`)。
 * 復帰のたびに呼ぶ実装にした場合、`bootMs + contentTransferMs` は B1 へ
 * 算入しなければならない(perf-boundaries §7-4)。
 *
 * @throws {CatchUpError} Worker が使えない環境 / 起動に失敗した場合
 */
export async function startCatchUpWorker(content: EngineContent): Promise<CatchUpWorkerHandle> {
  if (typeof Worker === "undefined") {
    throw new CatchUpError("この実行環境には Worker が無い(ブラウザ以外で呼ばれた)");
  }

  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let bootedResolve: (() => void) | null = null;
  let readyResolve: (() => void) | null = null;
  let fatal: ((error: Error) => void) | null = null;

  const t0 = performance.now();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "kept-flame-catchup",
  });

  worker.addEventListener("message", (event: MessageEvent) => {
    // 受信直後に時刻を取る(Promise の解決を挟むとマイクロタスク分ずれる)。
    const receivedAt = performance.now();
    const message = asWorkerMessage(event.data);
    switch (message.kind) {
      case "booted":
        bootedResolve?.();
        return;
      case "ready":
        readyResolve?.();
        return;
      case "done": {
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (request === undefined) return;
        const computeWallMs = receivedAt - request.startedAt;
        request.resolve({
          snapshot: message.snapshot,
          advanceContext: message.advanceContext,
          strategy: message.strategy,
          counters: message.counters,
          computeWallMs,
          requestPostMs: request.requestPostMs,
          workerHandlerMs: message.handlerMs,
          phaseMs: message.phaseMs,
          transportMs: computeWallMs - request.requestPostMs - message.handlerMs,
        });
        return;
      }
      case "failed": {
        const error = new CatchUpError(`Worker が失敗を返した: ${message.message}`);
        if (message.requestId === null) {
          fatal?.(error);
          return;
        }
        const request = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (request === undefined) fatal?.(error);
        else request.reject(error);
        return;
      }
      default: {
        const unhandled: never = message;
        fatal?.(new CatchUpError(`未知の Worker メッセージ ${JSON.stringify(unhandled)}`));
      }
    }
  });

  worker.addEventListener("error", (event: ErrorEvent) => {
    const error = new CatchUpError(`Worker が例外で停止した: ${event.message}`);
    fatal?.(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  await new Promise<void>((resolve, reject) => {
    bootedResolve = resolve;
    fatal = reject;
  });
  const t1 = performance.now();

  const initMessage: MainToWorkerMessage = { kind: "init", content };
  worker.postMessage(initMessage);
  await new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    fatal = reject;
  });
  const t2 = performance.now();

  return {
    bootMs: t1 - t0,
    contentTransferMs: t2 - t1,
    terminate: () => {
      worker.terminate();
    },
    catchUp: (state, targetTick, strategy = ACTIVE_CATCH_UP_STRATEGY) =>
      new Promise<WorkerCatchUpResult>((resolve, reject) => {
        const requestId = nextRequestId++;
        // --- B1 開始点(perf-boundaries §3 B1 / §7-2) ---
        const requestMessage: MainToWorkerMessage = {
          kind: "catchUp",
          requestId,
          state,
          targetTick,
          strategy,
        };
        const startedAt = performance.now();
        worker.postMessage(requestMessage);
        const afterPost = performance.now();
        pending.set(requestId, {
          resolve,
          reject,
          startedAt,
          requestPostMs: afterPost - startedAt,
        });
        fatal = reject;
      }),
  };
}
