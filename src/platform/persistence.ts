// ---------------------------------------------------------------------------
// セーブ永続化(IndexedDB)の**最小**実装 — T11 / ADR-012
// 境界定義の正は `docs/design/perf-boundaries.md` §3 B2 / §7。
//
// ===========================================================================
// 0. スコープ(先行計測計画 §2.1 P2 / §2.2 の線引き)
// ===========================================================================
//   作る    : IDB open / put / get、正準化 JSON 文字列、integrityChecksum、
//             B2 区間(読出 tx 生成 〜 fromSerializable 完了)の内訳計測。
//   作らない: 2秒デバウンス / 15秒・25コマンド絶対フラッシュ(ADR-012(1))、
//             容量検査 1.5MB 警告・4MB 中止(ADR-012(2))、localStorage ミラーと
//             巻戻し検知(GDD 11.9)、マイグレーション連鎖(migration.ts)。
//   いずれも **本実装スコープ**であり、入る場所だけを §5 にコメントで残す。
//
// ===========================================================================
// 1. なぜ「エンベロープ + payload 文字列」なのか(ADR-012 の記述との差)
// ===========================================================================
//   ADR「セーブフォーマット」(ADR 649行)は `integrityChecksum` を
//   `entityStateById` 等と同じ階層のキーとして列挙している。しかし
//   **チェックサムは自分自身を含む文書を覆えない**(検証時に「チェックサムを
//   除いた正準形」を作り直す必要があり、復帰経路で JSON.stringify を 1 回
//   余計に払う)。よって本実装は 1 段のエンベロープに分離する:
//
//     IDB に入る値 = { saveFormatVersion, integrityChecksum, payload }
//                     payload = JSON.stringify(toSerializable(state))(正準)
//
//   - `payload` は **文字列**として持つ(構造化複製可能なオブジェクトとして
//     入れない)。ADR-012(4) が予算項目に `JSON.parse` を明記しており、
//     `perf-boundaries.md` §3 B2 もこの選択を前提に境界を切っているため。
//   - checksum は payload 文字列だけを舐めればよく、読出側で再直列化しない。
//   - ADR 側の「save の中に integrityChecksum がある」という記述との差異は
//     **要ユーザー判断**(報告事項)。エンベロープ 1 段を被せただけで、
//     payload の中身は ADR のセーブフォーマットそのものである。
//
// ===========================================================================
// 2. integrityChecksum は「破損検出専用・改竄耐性なし」(ADR-012 明記)
// ===========================================================================
//   engine の FNV-1a-32(`src/engine/rng/fnv1a32.ts`)をそのまま再利用する。
//   32bit なので偶然衝突は約 2^-32。ADR が求めているのは *破損検出* であって
//   改竄検出ではない(署名鍵をクライアントに置けない以上、改竄耐性は原理的に
//   達成不能)ため、この強度で要件を満たす。暗号学的ハッシュ(SubtleCrypto)は
//   (a) 非同期で B2 の内側に await を増やす(perf-boundaries §2 R4 違反)
//   (b) 改竄耐性を与えたと**誤解させる**、の 2 点で採らない。
//
//   engine の関数を使うのは決定論のためでもある: 同じセーブ文字列からは
//   どの環境でも同じ checksum が出る(charCodeAt + Math.imul のみ)。
//
// ===========================================================================
// 3. B2 の境界(perf-boundaries.md §3 B2 / §7)
// ===========================================================================
//   内側: 読出トランザクションの生成 → `objectStore.get` → checksum 検証 →
//         `JSON.parse` → `fromSerializable`
//   外側: `indexedDB.open`(補助メトリクス idbOpenMs)、書込(idbPutMs)、
//         localStorage ミラー読出 / 巻戻し検知(未実装・§5)。
//
//   {@link loadLatestSave} は自分の内訳を `marks`(生の performance.now 値)で
//   返す。呼び出し側(bench/perfMain.ts)は関数呼び出しの**直前直後**でも
//   時刻を取り、`marks` との差を `callOverhead` として明示的に計上することで
//   「下位区間は親を過不足なく分割する」(perf-boundaries §2 R7)を保つ。
// ---------------------------------------------------------------------------

import { fnv1a32 } from "../engine/rng/fnv1a32";
import { fromSerializable, toSerializable } from "../engine/state/serialize";
import type { GameState } from "../engine/state/state";

// --- 1. 定数とエラー -------------------------------------------------------

/** 既定の DB 名。ベンチ等は別名を渡して本番セーブと混ざらないようにする。 */
export const SAVE_DB_NAME = "kept-flame";
export const SAVE_DB_VERSION = 1;
export const SAVE_STORE_NAME = "saves";
/** 単一スロットの最新セーブのキー(スロット多重化は本実装スコープ)。 */
export const LATEST_SAVE_KEY = "latest";

/**
 * エンベロープ(§1)の版。**payload の中身の版ではない**。
 * payload 側の 3 バージョン軸(saveSchemaVersion / contentVersion /
 * algoVersion)は GameState が持っており、この値とは独立に動く。
 */
export const SAVE_FORMAT_VERSION = 1;

/** 永続化層の失敗(IDB エラー・エンベロープの構造違反など)。 */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/** integrityChecksum 不一致 = セーブ破損(ADR-012(2))。 */
export class SaveIntegrityError extends PersistenceError {
  constructor(
    message: string,
    readonly expectedChecksum: number,
    readonly actualChecksum: number,
  ) {
    super(message);
    this.name = "SaveIntegrityError";
  }
}

// --- 2. 純関数部(IDB に依存しない = vitest で直接叩ける) -----------------

/** IDB に入るレコード(§1 のエンベロープ)。 */
export interface SaveRecord {
  readonly saveFormatVersion: number;
  /** payload 文字列の FNV-1a-32(uint32)。 */
  readonly integrityChecksum: number;
  /** 正準化済み JSON 文字列(= JSON.stringify(toSerializable(state)))。 */
  readonly payload: string;
}

/**
 * 破損検出用チェックサム(§2)。engine の FNV-1a-32 をそのまま使う。
 * 入力文字列が 1 文字でも変われば値が変わる(テストで固定)。
 */
export function computeIntegrityChecksum(payload: string): number {
  return fnv1a32(payload);
}

/**
 * GameState を保存レコードへ符号化する。
 *
 * `toSerializable` が正準化(キー順を UTF-16 昇順へ固定)まで済ませているので、
 * 同じ内容の state からは必ず同じ payload バイト列 = 同じ checksum が出る。
 *
 * @throws {SerializeError} state が直列化できない場合(engine 側の契約違反)
 */
export function encodeSaveRecord(state: GameState): SaveRecord {
  const payload = JSON.stringify(toSerializable(state));
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    integrityChecksum: computeIntegrityChecksum(payload),
    payload,
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * IDB から出てきた未知の値をエンベロープとして検証し、payload を返す。
 * **破損は黙って直さない**(既定値で埋めたり checksum を無視したりしない)。
 *
 * @throws {PersistenceError} 構造・版が不正な場合
 * @throws {SaveIntegrityError} checksum が一致しない場合
 */
export function verifySaveRecord(value: unknown): string {
  if (!isRecordObject(value)) {
    throw new PersistenceError(
      `セーブレコードがオブジェクトでない(実際: ${value === null ? "null" : typeof value})`,
    );
  }
  const version = value["saveFormatVersion"];
  if (version !== SAVE_FORMAT_VERSION) {
    throw new PersistenceError(
      `セーブエンベロープの版が違う(期待 ${String(SAVE_FORMAT_VERSION)} / 実際 ${String(version)})。` +
        `エンベロープ版のマイグレーションは本実装スコープ(migration.ts)。`,
    );
  }
  const payload = value["payload"];
  if (typeof payload !== "string") {
    throw new PersistenceError(
      `payload が文字列でない(実際: ${typeof payload})。セーブは JSON 文字列として保存する`,
    );
  }
  const stored = value["integrityChecksum"];
  if (
    typeof stored !== "number" ||
    !Number.isInteger(stored) ||
    stored < 0 ||
    stored > 0xffff_ffff
  ) {
    throw new PersistenceError(
      `integrityChecksum が uint32 でない(実際: ${typeof stored === "number" ? String(stored) : typeof stored})`,
    );
  }
  const actual = computeIntegrityChecksum(payload);
  if (actual !== stored) {
    throw new SaveIntegrityError(
      `integrityChecksum 不一致 = セーブ破損(期待 ${String(stored)} / 実際 ${String(actual)})`,
      stored,
      actual,
    );
  }
  return payload;
}

/**
 * 保存レコードから GameState を復元する(検証 → parse → deserialize)。
 * B2 の内訳を取らない用途(テスト・インポート)向けの合成版。
 *
 * @throws {PersistenceError | SaveIntegrityError | SerializeError}
 */
export function decodeSaveRecord(value: unknown): GameState {
  return fromSerializable(JSON.parse(verifySaveRecord(value)));
}

// --- 3. IndexedDB ----------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new PersistenceError(`${what} が失敗した: ${String(request.error?.message ?? "unknown")}`),
      );
    };
  });
}

/**
 * セーブ DB を開く(スキーマが無ければ作る)。
 *
 * **B2 の外側**(補助メトリクス `idbOpenMs`・perf-boundaries §3 B2 / §11-(1))。
 * 実アプリではアプリ起動時に 1 回で、セーブ復帰のたびには払わない。
 */
export function openSaveDb(dbName: string = SAVE_DB_NAME): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, SAVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
        db.createObjectStore(SAVE_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new PersistenceError(
          `indexedDB.open が失敗した: ${String(request.error?.message ?? "unknown")}`,
        ),
      );
    };
    request.onblocked = () => {
      reject(new PersistenceError("indexedDB.open がブロックされた(別タブが古い版を開いている)"));
    };
  });
}

/** ベンチ/テスト用に DB を丸ごと消す(実アプリの導線ではない)。 */
export function deleteSaveDb(dbName: string = SAVE_DB_NAME): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new PersistenceError("indexedDB.deleteDatabase が失敗した"));
    };
    request.onblocked = () => {
      reject(new PersistenceError("indexedDB.deleteDatabase がブロックされた(接続が開いたまま)"));
    };
  });
}

function awaitTransaction(tx: IDBTransaction, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(new PersistenceError(`${what} が失敗した: ${String(tx.error?.message ?? "unknown")}`));
    };
    tx.onabort = () => {
      reject(
        new PersistenceError(`${what} が中断された: ${String(tx.error?.message ?? "unknown")}`),
      );
    };
  });
}

/** {@link saveGameState} の結果(書込は復帰経路の外なので予算対象外)。 */
export interface SavePutResult {
  readonly integrityChecksum: number;
  /** payload の UTF-16 コードユニット長。バイト数は呼び出し側で測る。 */
  readonly payloadLength: number;
  readonly encodeMs: number;
  readonly putMs: number;
}

/**
 * GameState を書き込む。**復帰シナリオのクリティカルパス外**
 * (perf-boundaries §3 B2「書込は計測外」)。
 *
 * ここには **2秒デバウンス / 15秒・25コマンド絶対フラッシュ(ADR-012(1))**
 * と **書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2))** が入る予定で
 * あり、いずれも本実装スコープ(§0 / §5)。
 */
export async function saveGameState(
  db: IDBDatabase,
  state: GameState,
  key: string = LATEST_SAVE_KEY,
): Promise<SavePutResult> {
  const e0 = performance.now();
  const record = encodeSaveRecord(state);
  const e1 = performance.now();
  // ここに「書込前サイズ検査」が入る(本実装スコープ・ADR-012(2))。
  const tx = db.transaction(SAVE_STORE_NAME, "readwrite");
  await requestToPromise(tx.objectStore(SAVE_STORE_NAME).put(record, key), `put("${key}")`);
  await awaitTransaction(tx, "書込トランザクション");
  const e2 = performance.now();
  return {
    integrityChecksum: record.integrityChecksum,
    payloadLength: record.payload.length,
    encodeMs: e1 - e0,
    putMs: e2 - e1,
  };
}

// --- 4. B2 の入口 ----------------------------------------------------------

/**
 * B2 の内側で取った生の `performance.now()` 値(perf-boundaries §3 B2 / §7)。
 * 差ではなく生値を返すのは、呼び出し側が「関数呼び出しの直前直後」との残差を
 * `callOverhead` として明示計上し、下位区間で親を過不足なく分割できるように
 * するため(§2 R7)。
 */
export interface SaveRestoreMarks {
  /** 読出トランザクション生成の直前。 */
  readonly enter: number;
  /** `objectStore.get` の値を得た直後。 */
  readonly afterIdbGet: number;
  /** integrityChecksum 検証の直後。 */
  readonly afterChecksum: number;
  /** `JSON.parse` の直後。 */
  readonly afterParse: number;
  /** `fromSerializable` の直後(= B2 の終了点)。 */
  readonly afterDeserialize: number;
}

export interface SaveRestoreResult {
  readonly state: GameState;
  readonly integrityChecksum: number;
  readonly payloadLength: number;
  readonly marks: SaveRestoreMarks;
}

/**
 * 最新セーブを読み出して GameState を復元する。**B2 区間の本体**。
 *
 * 内側にある await は `objectStore.get` の 1 つだけである
 * (perf-boundaries §2 R4「区間内で待ってよいのは計測対象の I/O そのものだけ」)。
 * localStorage ミラー読出・巻戻し検知は**この関数の外**に置くこと(§5)。
 *
 * @throws {PersistenceError} キーが無い / エンベロープが壊れている場合
 * @throws {SaveIntegrityError} checksum 不一致(セーブ破損)
 * @throws {SerializeError} payload が現行のセーブ形と合わない場合
 */
export async function loadLatestSave(
  db: IDBDatabase,
  key: string = LATEST_SAVE_KEY,
): Promise<SaveRestoreResult> {
  const enter = performance.now();
  const tx = db.transaction(SAVE_STORE_NAME, "readonly");
  const value: unknown = await requestToPromise(
    tx.objectStore(SAVE_STORE_NAME).get(key),
    `get("${key}")`,
  );
  const afterIdbGet = performance.now();
  if (value === undefined) {
    throw new PersistenceError(`キー "${key}" のセーブが存在しない`);
  }
  const payload = verifySaveRecord(value);
  const afterChecksum = performance.now();
  const parsed: unknown = JSON.parse(payload);
  const afterParse = performance.now();
  const state = fromSerializable(parsed);
  const afterDeserialize = performance.now();

  return {
    state,
    integrityChecksum: computeIntegrityChecksum(payload),
    payloadLength: payload.length,
    marks: { enter, afterIdbGet, afterChecksum, afterParse, afterDeserialize },
  };
}

// --- 5. 本実装スコープの差し込み位置(作らないものの置き場所) --------------
//
//  (a) 2秒デバウンス + 15秒/25コマンド絶対フラッシュ(ADR-012(1))
//      → `saveGameState` を包むスケジューラとして platform 層に置く。
//        engine の tick とは独立(実時刻ベース)なので engine には入れない。
//  (b) 書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2))
//      → `saveGameState` の `encodeSaveRecord` 直後、`put` の直前。
//        **復帰経路には無い**ので B2 とは無関係(perf-boundaries §7)。
//  (c) localStorage ミラー読出 / 巻戻し検知(GDD 11.9)
//      → `loadLatestSave` の **呼び出し側**。IDB が生きている happy path では
//        分岐しないため B2 の外(補助メトリクス `mirrorCheckMs`)。
//        T11 では作っていないので `mirrorCheckMs` は結果 JSON に出さない。
//  (d) saveSchemaVersion 差のマイグレーション連鎖(ADR 3軸(a))
//      → `verifySaveRecord` と `fromSerializable` の**間**。payload を parse した
//        プレーン値に対して version 順に純関数を適用する(migration.ts)。
// ---------------------------------------------------------------------------
