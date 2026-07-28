// ---------------------------------------------------------------------------
// セーブ永続化(IndexedDB)— T11(最小実装)→ M3(本実装)/ ADR-012
// 境界定義の正は `docs/design/perf-boundaries.md` §3 B2 / §7。
//
// ===========================================================================
// 0. スコープ
// ===========================================================================
//   T11 で作った : IDB open / put / get、正準化 JSON 文字列、integrityChecksum、
//                  B2 区間(読出 tx 生成 〜 fromSerializable 完了)の内訳計測。
//   M3 で足した  : マイグレーション連鎖(`migration.ts`・エンベロープ版 /
//                  セーブスキーマ版の 2 軸)の読出経路への結線、
//                  分岐木ノード上界の強制(ADR-012(3)・`assertDispatchTreeBounds`)。
//                  2秒デバウンス / 15秒・25コマンド絶対フラッシュ(ADR-012(1))は
//                  **書込を包むスケジューラ**なので `saveScheduler.ts` に分けた
//                  (この層は「1 回の書込」、あちらは「いつ書くか」)。
//   まだ無い     : 容量検査 1.5MB 警告・4MB 中止(ADR-012(2)= M4)、
//                  localStorage ミラーと巻戻し検知(GDD 11.9 = M4)。
//                  入る場所だけを §5 にコメントで残す。
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
import { migrateSavePayload, migrateStoredSave, SAVE_FORMAT_VERSION } from "./migration";

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
 *
 * 実体は `migration.ts` が**連鎖の終端として**定義している(現行版と
 * マイグレーション連鎖の終端がずれないよう、定義を 1 箇所に寄せてある)。
 * 従来どおりこのモジュールからも輸入できるよう再輸出する。
 */
export { SAVE_FORMAT_VERSION };

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

/** セーブに載せてよい量の上界(ADR-012(3) 分岐木ノード上界)を超えた(§6)。 */
export class SaveBoundsError extends PersistenceError {
  constructor(
    message: string,
    /** 破った上界の名前(定数名)。 */
    readonly bound: string,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(message);
    this.name = "SaveBoundsError";
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
 * @throws {SaveBoundsError} 分岐木ノード上界を破っている場合
 */
export function encodeSaveRecord(state: GameState): SaveRecord {
  const serialized = toSerializable(state);
  // 上界検査は**書込側**に置く。書込は復帰経路の外なので B2 の予算に
  // 影響せず、かつ「有界でないものを永続化させない」という一番早い停止点になる。
  assertDispatchTreeBounds(serialized);
  const payload = JSON.stringify(serialized);
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
        `旧版は migrateStoredSave() が現行版へ引き上げてからここへ来る。` +
        `現行版より新しいセーブは引き上げられない = このエラーで停止するのが正しい挙動。`,
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
 * 保存レコードから GameState を復元する
 * (エンベロープ migration → 検証 → parse → スキーマ migration → 上界検査 →
 * deserialize)。B2 の内訳を取らない用途(テスト・インポート)向けの合成版。
 *
 * `loadLatestSave` との違いは**上界検査を行うこと**だけである
 * (`assertDispatchTreeBounds` の JSDoc に線引きの理由)。インポートは
 * 「自分が書いたとは限らないセーブ」の入口なので、書込側の検査を通っていない
 * 可能性がある。
 *
 * @throws {PersistenceError | SaveIntegrityError | SaveBoundsError |
 *          SaveMigrationError | SerializeError}
 */
export function decodeSaveRecord(value: unknown): GameState {
  const migrated = migrateStoredSave(value);
  const parsed: unknown = JSON.parse(verifySaveRecord(migrated.value));
  const payload = migrateSavePayload(parsed);
  assertDispatchTreeBounds(payload.value);
  return fromSerializable(payload.value);
}

// --- 2b. 分岐木ノード上界(ADR-012(3)) -------------------------------------
//
//   ADR-012(3) は「各派遣の resolvedTree は撤退枝が以降ノードを打ち切る性質 +
//   choices が各ノード最大2分岐ゆえ、総ノード ≤2×maxNodes(8)=16/派遣、
//   同時派遣 ≤2 で ≤32 ノード」と述べる。上界は**設計値の積**なので、
//   マジックナンバーではなく積の形で書き下す(ADR「拡張時は再算定」に対応:
//   派遣枠やイベントノード数が動いたら下の 2 定数だけを直す)。
//
//   **超過時の挙動は ADR に明文が無い**。本実装は「破損は黙って直さない」
//   (T11 からの一貫方針)に揃えて **SaveBoundsError で停止**する。上界は
//   engine 側の生成規則から**構造的に**満たされるはずのものなので、破れて
//   いれば探索の分岐木生成にバグがあるか、セーブが手で改変されている。
//   黙って切り詰めると、次の周回で「切れた木」を正だと思い込んでしまう。
//
//   `dispatchSnapshots` はまだ GameState に無い(探索は M21〜M23)。よって
//   本検査は「あれば検める」形で書いてある。分岐木の**内部表現**が確定するのは
//   M21〜M23 なので、子ノードの辿り方は下の DISPATCH_TREE_CHILD_KEYS 1 箇所に
//   集約してある(木の形が決まったらここだけを直す)。

/** 1 派遣で生成されるイベントノードの最大数(GDD 探索: イベント列 3〜8 ノード)。 */
export const DISPATCH_EVENT_NODES_MAX = 8;

/** choices の分岐数(撤退 / 強行の 2 分岐・GDD)。 */
export const DISPATCH_BRANCH_FACTOR = 2;

/** 同時派遣枠(GDD: 派遣枠上限 = 同時2枠)。 */
export const CONCURRENT_DISPATCH_MAX = 2;

/** 1 派遣の resolvedTree の総ノード上界 = 2 × maxNodes(8) = 16。 */
export const DISPATCH_TREE_NODES_MAX = DISPATCH_BRANCH_FACTOR * DISPATCH_EVENT_NODES_MAX;

/** セーブ 1 本が持ちうる分岐木ノードの総数上界 = 16 × 2 = 32。 */
export const DISPATCH_TREE_NODES_TOTAL_MAX = DISPATCH_TREE_NODES_MAX * CONCURRENT_DISPATCH_MAX;

/**
 * 分岐木の子ノードが載るキー。**木の形の唯一の仮定**であり、M21〜M23 で
 * resolvedTree の内部表現が確定したらここだけを直す。値は「ノードの配列」で
 * あることを期待し、配列でなければ子なしとして扱う(誤検出で止めない)。
 */
const DISPATCH_TREE_CHILD_KEYS: readonly string[] = ["choices", "children"];

/**
 * 木のノード数を数える。`limit` を超えた時点で数えるのをやめて `limit + 1` を
 * 返す(上界違反の報告にはそれで足りるし、壊れたセーブで走査が発散しない)。
 */
function countTreeNodes(root: unknown, limit: number): number {
  if (!isRecordObject(root)) return 0;
  let count = 0;
  const stack: Record<string, unknown>[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    count += 1;
    if (count > limit) return count;
    for (const key of DISPATCH_TREE_CHILD_KEYS) {
      const children: unknown = node[key];
      if (!Array.isArray(children)) continue;
      for (const child of children as readonly unknown[]) {
        if (isRecordObject(child)) stack.push(child);
      }
    }
  }
  return count;
}

/**
 * 直列化形が分岐木ノード上界(ADR-012(3))を守っていることを確かめる。
 *
 * 呼ぶのは **書込側(`encodeSaveRecord`)と インポート側(`decodeSaveRecord`)
 * だけ**で、`loadLatestSave` からは呼ばない。理由は 2 つ:
 *   (a) 自分が書いたセーブは書込時に検査済みで、読出のたびに再検査しても
 *       新しい情報は出ない。
 *   (b) `loadLatestSave` は B2 の計測区間そのもの(perf-boundaries §3 B2)で
 *       あり、予算に無関係な検査を内側へ足すと区間の意味が変わる。
 *
 * @throws {SaveBoundsError} 同時派遣数・1 派遣あたり / 総ノード数のいずれかが上界超過
 */
export function assertDispatchTreeBounds(serialized: unknown): void {
  if (!isRecordObject(serialized)) return;
  const snapshots: unknown = serialized["dispatchSnapshots"];
  if (snapshots === undefined) return;
  if (!Array.isArray(snapshots)) {
    throw new SaveBoundsError(
      `dispatchSnapshots が配列でない(実際: ${typeof snapshots})`,
      "dispatchSnapshots",
      CONCURRENT_DISPATCH_MAX,
      -1,
    );
  }
  const list = snapshots as readonly unknown[];
  if (list.length > CONCURRENT_DISPATCH_MAX) {
    throw new SaveBoundsError(
      `同時派遣が上界を超えた(上界 ${String(CONCURRENT_DISPATCH_MAX)} / 実際 ${String(list.length)}・ADR-012(3))`,
      "CONCURRENT_DISPATCH_MAX",
      CONCURRENT_DISPATCH_MAX,
      list.length,
    );
  }
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const snapshot = list[i];
    if (!isRecordObject(snapshot)) continue;
    const nodes = countTreeNodes(snapshot["resolvedTree"], DISPATCH_TREE_NODES_MAX);
    if (nodes > DISPATCH_TREE_NODES_MAX) {
      throw new SaveBoundsError(
        `dispatchSnapshots[${String(i)}].resolvedTree のノード数が上界を超えた` +
          `(上界 ${String(DISPATCH_TREE_NODES_MAX)} / 実際 ${String(nodes)} 以上・ADR-012(3))`,
        "DISPATCH_TREE_NODES_MAX",
        DISPATCH_TREE_NODES_MAX,
        nodes,
      );
    }
    total += nodes;
  }
  if (total > DISPATCH_TREE_NODES_TOTAL_MAX) {
    throw new SaveBoundsError(
      `分岐木の総ノード数が上界を超えた(上界 ${String(DISPATCH_TREE_NODES_TOTAL_MAX)} / 実際 ${String(total)}・ADR-012(3))`,
      "DISPATCH_TREE_NODES_TOTAL_MAX",
      DISPATCH_TREE_NODES_TOTAL_MAX,
      total,
    );
  }
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
 * GameState を**1 回**書き込む。**復帰シナリオのクリティカルパス外**
 * (perf-boundaries §3 B2「書込は計測外」)。
 *
 * 「いつ書くか」(2秒デバウンス / 15秒・25コマンド絶対フラッシュ・ADR-012(1))は
 * この関数の仕事ではなく `saveScheduler.ts` が担う。ここへ書込ポリシーを入れると
 * 「1 回書く」を単体で叩けなくなる(= スケジューラのテストが IDB を要求する)。
 *
 * **書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2))は M4 の担当**で、
 * `encodeSaveRecord` の直後・`put` の直前に入る(§5(b))。
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
  /**
   * 読み出したセーブが名乗っていたエンベロープ版。現行版なら
   * `SAVE_FORMAT_VERSION` と等しい。**これより小さければ古いセーブを
   * マイグレーションして復元した**ということなので、呼び出し側は次の書込を
   * 待たずに現行形式で保存し直すとよい(`saveScheduler.flush` の出番)。
   */
  readonly saveFormatVersion: number;
  /** 適用したマイグレーション段の説明(現行版なら空配列)。 */
  readonly appliedMigrations: readonly string[];
}

/**
 * 最新セーブを読み出して GameState を復元する。**B2 区間の本体**。
 *
 * 内側にある await は `objectStore.get` の 1 つだけである
 * (perf-boundaries §2 R4「区間内で待ってよいのは計測対象の I/O そのものだけ」)。
 * localStorage ミラー読出・巻戻し検知は**この関数の外**に置くこと(§5)。
 *
 * マイグレーション連鎖は 2 箇所に入る(`migration.ts` §0):
 *   - エンベロープ版 = `get` の直後・checksum 検証の**前**
 *   - セーブスキーマ版 = `JSON.parse` の直後・`fromSerializable` の**前**
 * どちらも現行版のセーブに対しては「版を 1 回読んで比べる」だけで、割付も
 * 走査も起こさない。よって B2 の内訳(`marks`)の意味は T11 から変えていない
 * (古いセーブを読んだときだけ `afterChecksum - afterIdbGet` に変換 1 回分が
 * 乗る = 一度きりの経路であり、予算判定に使う定常値ではない)。
 *
 * @throws {PersistenceError} キーが無い / エンベロープが壊れている場合
 * @throws {SaveIntegrityError} checksum 不一致(セーブ破損)
 * @throws {SaveMigrationError} 形が判別できない / 移行経路が無い場合
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
  const migrated = migrateStoredSave(value);
  const payload = verifySaveRecord(migrated.value);
  const afterChecksum = performance.now();
  const parsed: unknown = JSON.parse(payload);
  const afterParse = performance.now();
  const state = fromSerializable(migrateSavePayload(parsed).value);
  const afterDeserialize = performance.now();

  return {
    state,
    integrityChecksum: computeIntegrityChecksum(payload),
    payloadLength: payload.length,
    marks: { enter, afterIdbGet, afterChecksum, afterParse, afterDeserialize },
    saveFormatVersion: migrated.fromVersion,
    appliedMigrations: migrated.appliedSteps,
  };
}

// --- 5. 差し込み位置の一覧(どこへ何が入るか / 入ったか) --------------------
//
//  (a) 2秒デバウンス + 15秒/25コマンド絶対フラッシュ(ADR-012(1))
//      → **[M3 済]** `saveScheduler.ts`。`saveGameState` を包むスケジューラ
//        として platform 層に置いた。engine の tick とは独立(実時刻ベース)
//        なので engine には入れない。
//  (b) 書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2))
//      → **[M4 の担当]** `saveGameState` の `encodeSaveRecord` 直後、`put` の直前。
//        **復帰経路には無い**ので B2 とは無関係(perf-boundaries §7)。
//  (c) localStorage ミラー読出 / 巻戻し検知(GDD 11.9)
//      → **[M4 の担当]** `loadLatestSave` の **呼び出し側**。IDB が生きている
//        happy path では分岐しないため B2 の外(補助メトリクス `mirrorCheckMs`)。
//        まだ作っていないので `mirrorCheckMs` は結果 JSON に出さない。
//  (d) saveSchemaVersion 差のマイグレーション連鎖(ADR 3軸(a))
//      → **[M3 済]** `verifySaveRecord` と `fromSerializable` の**間**。payload を
//        parse したプレーン値に対して version 順に純関数を適用する
//        (`migration.ts` の `migrateSavePayload`)。エンベロープ版の連鎖は
//        checksum 検証より前(`migrateStoredSave`)。
// ---------------------------------------------------------------------------
