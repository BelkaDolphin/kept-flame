// ---------------------------------------------------------------------------
// catch-up オフロード Worker のエントリ — T11 / ADR-019 / ADR-029
//
// このファイルは **Worker グローバルへの配線だけ**を持つ。判断・計算・不変条件は
// すべて `catchUp.ts`(Worker 非依存の純粋部)にあり、そちらは vitest で直接
// テストできる。ここに条件分岐を足さないこと(足すと Playwright スモークでしか
// 検証できない領域が増える)。
//
// ===========================================================================
// 1. 型付け(WebWorker lib を使わない理由)
// ===========================================================================
//   tsconfig.json の `lib` は `["ES2022","DOM","DOM.Iterable"]` で、DOM と
//   WebWorker のグローバル宣言は同居できない(`self` / `postMessage` の型が
//   衝突する)。lib を分けるには tsconfig を分割するしかなく、それは
//   リポジトリ全体の設定変更になるため、ここでは**必要な 2 メソッドだけ**を
//   局所インタフェースで宣言して `globalThis` に被せる。
//
// ===========================================================================
// 2. ライフサイクル(perf-boundaries §7-4)
// ===========================================================================
//   起動直後に `booted` を post する。メイン側(`workerClient.ts`)はこれを
//   待って `workerBootMs`(= `new Worker()` + モジュール評価)を測り、続けて
//   `init`(content 1回転送・ADR-029(1))を送る。この 2 つは**アプリ起動時**に
//   済ませる想定なので**予算外**であり、結果 JSON では
//   `workerLifecycle: "preboot"` と明記する。復帰時に初めて Worker を作る実装に
//   した場合は B1 へ算入すること(その場合の値は
//   `computeWallMs + workerBootMs + contentTransferMs` として別途出している)。
// ---------------------------------------------------------------------------

import {
  CATCH_UP_PROTOCOL_VERSION,
  createWorkerSession,
  type WorkerToMainMessage,
} from "./catchUp";

/** DedicatedWorkerGlobalScope のうち本 Worker が使う部分だけ(§1)。 */
interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: WorkerToMainMessage): void;
}

const scope = globalThis as unknown as WorkerScope;

const session = createWorkerSession((message) => {
  scope.postMessage(message);
});

scope.addEventListener("message", (event) => {
  session.handle(event.data);
});

scope.postMessage({ kind: "booted", protocolVersion: CATCH_UP_PROTOCOL_VERSION });
