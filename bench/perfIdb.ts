// ---------------------------------------------------------------------------
// B2(IDB 読出 + JSON.parse + deserialize)の**暫定** IndexedDB 実装 — T10
// `docs/design/perf-boundaries.md` §3 B2 / §7
//
// ここは T11 で `src/platform/persistence.ts` に置き換わる場所である。
// 置き換え時に何が B2 の内側/外側になるかは設計文書 §7 に先に書いてある
// (integrityChecksum は内側 / localStorage ミラーと巻戻し検知は外側 /
//  indexedDB.open は引き続き補助メトリクス)。
//
// セーブは **JSON 文字列**として格納する(構造化複製可能なオブジェクトとして
// 入れない)。ADR-012(4) が予算項目に `JSON.parse` を明記しており、
// ADR-012(2) の integrityChecksum も JSON blob に掛ける設計であるため。
// ---------------------------------------------------------------------------

export const PERF_DB_NAME = "kept-flame-perf-bench";
export const PERF_DB_VERSION = 1;
export const PERF_STORE_NAME = "saves";
export const PERF_SAVE_KEY = "perfMain";
export const PERF_PADDED_SAVE_KEY = "perfPadded";

export class PerfIdbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfIdbError";
  }
}

function requestToPromise<T>(request: IDBRequest<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new PerfIdbError(`${what} が失敗した: ${String(request.error?.message ?? "unknown")}`),
      );
    };
  });
}

/** DB を開く(スキーマが無ければ作る)。計測は補助メトリクス `idbOpenMs`。 */
export function openPerfDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PERF_DB_NAME, PERF_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PERF_STORE_NAME)) {
        db.createObjectStore(PERF_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new PerfIdbError(
          `indexedDB.open が失敗した: ${String(request.error?.message ?? "unknown")}`,
        ),
      );
    };
    request.onblocked = () => {
      reject(new PerfIdbError("indexedDB.open がブロックされた(別タブが古い版を開いている)"));
    };
  });
}

/** セーブ文字列を書き込む。**復帰シナリオの計測対象外**(設計文書 §3 B2)。 */
export async function putSaveText(db: IDBDatabase, key: string, text: string): Promise<void> {
  const tx = db.transaction(PERF_STORE_NAME, "readwrite");
  const store = tx.objectStore(PERF_STORE_NAME);
  await requestToPromise(store.put(text, key), `objectStore.put("${key}")`);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(new PerfIdbError(`書込トランザクションが失敗した: ${String(tx.error?.message)}`));
    };
  });
}

/**
 * セーブ文字列を読み出す。**B2 の開始点はこの関数の呼び出し直前**であり、
 * 読出トランザクションの生成もこの内側 = 区間の内側にある(設計文書 §3 B2)。
 *
 * @throws {PerfIdbError} キーが存在しない / 文字列でない場合
 */
export async function getSaveText(db: IDBDatabase, key: string): Promise<string> {
  const tx = db.transaction(PERF_STORE_NAME, "readonly");
  const store = tx.objectStore(PERF_STORE_NAME);
  const value = await requestToPromise(store.get(key), `objectStore.get("${key}")`);
  if (typeof value !== "string") {
    throw new PerfIdbError(`キー "${key}" のセーブが文字列でない(実際: ${typeof value})`);
  }
  return value;
}

/** ベンチ用 DB を消す(再実行のたびにクリーンな状態から始めたいとき用)。 */
export function deletePerfDb(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(PERF_DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new PerfIdbError("indexedDB.deleteDatabase が失敗した"));
    };
    request.onblocked = () => {
      reject(new PerfIdbError("indexedDB.deleteDatabase がブロックされた"));
    };
  });
}
