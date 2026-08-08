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
//   M4 で足した  : 書込前サイズ検査 1.5MB 警告・4MB 中止(ADR-012(2)。
//                  判定ロジック本体は `saveCapacity.ts`、ここは `saveGameState`
//                  への最小結線のみ)。export/import(`exchange.ts`)・
//                  localStorage ミラー(`localStorageMirror.ts`)・バックアップ
//                  リマインド(`backupReminder.ts`)は同じ M4 だが**別ファイル**
//                  (この層に「1 回の書込」以上の責務を足さないため)。
//   台帳v26 必-1 : エンベロープの `savedAtMs`(最後に書いた壁時計時刻)。
//                  起動時オフライン復帰の**唯一の材料**である(§4)。
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
//         localStorage ミラー読出(§5(c)・実装済み) / 巻戻し検知
//         (GDD 11.9 の一部・未実装・§5(c) に理由あり)。
//
//   {@link loadLatestSave} は自分の内訳を `marks`(生の performance.now 値)で
//   返す。呼び出し側(bench/perfMain.ts)は関数呼び出しの**直前直後**でも
//   時刻を取り、`marks` との差を `callOverhead` として明示的に計上することで
//   「下位区間は親を過不足なく分割する」(perf-boundaries §2 R7)を保つ。
//
// ===========================================================================
// 4. [台帳v26 必-1] savedAtMs — 「最後に遊んだ実時刻」をエンベロープに持つ
// ===========================================================================
//   ADR-026 の tick 駆動(`clock.ts`)は `performance.now()` 基準であり、
//   その原点は**ページを読み込むたびに 0 へ戻る**。よってセーブに壁時計の
//   時刻が 1 つも無いと、起動直後のアンカーは「今 = セーブ時の tick」となり、
//   ブラウザを閉じていた時間がゲーム内から丸ごと消える(オフライン復帰の
//   受け皿 —— 72h クランプ・Worker catch-up・⑫帰還ダイジェスト —— は全て
//   実装済みなのに、**入口の材料だけが無かった**)。その材料がこの 1 フィールド
//   である。同型の問題と同型の解は M54 の `backupReminder.ts`(`performance.now()`
//   → 壁時計への切り替え)に前例がある。
//
//   (a) **payload には入れない**。payload は engine の直列化形そのもの(決定論
//       バイト列)であり、時刻を混ぜた瞬間に「同じ state から同じ payload」が
//       壊れて golden vector / checksum / セーブ正準化の全てが揺れる。
//       よって置き場所はエンベロープ側だけである。
//   (b) **checksum の対象外**(checksum は payload 文字列のみ・§2 のまま)。
//       つまり savedAtMs は**検証されていない値**である。読めない値(数でない・
//       非有限・負)が入っていても復帰そのものは止めず「不明」として扱う
//       ({@link readSavedAtMs} が `null` を返し、呼び出し側は経過 0 =
//       台帳v26 必-1 以前と同じ挙動へ落ちる)。検証できない 1 フィールドに
//       「セーブ全体を読めなくする」権限を与えないための線引きである。
//   (c) **省略可**。台帳v26 必-1 以前に書かれたエンベロープは持っていないので、
//       「無ければ経過 0」で読む(下の {@link readSavedAtMs})。
//   (d) **エンベロープ版(`saveFormatVersion`)は上げない**。判断の根拠は
//       `migration.ts` §0(i) の「[台帳v26 必-1] savedAtMs は版を上げない」節に
//       書いた(この軸の版差は前後どちらの向きにも**ハード拒否**になるため、
//       省略可・checksum 外・欠けても旧挙動に落ちるだけのフィールドに対しては
//       代償が釣り合わない)。
//   (e) **書込の瞬間に読む**。壁時計を読むのは {@link saveGameState} だけで、
//       {@link encodeSaveRecord} は渡された値を載せるだけの純関数のままにする
//       (これを崩すと export テキスト `exchange.ts` が呼ぶたびに違うバイト列に
//       なり、「同じ state からは常に同じバイト列」という T11 以来の性質が
//       失われる)。export/import に savedAtMs は載らない —— インポートは
//       「昔の状態へ戻す」操作であって不在時間の catch-up ではないため
//       (`src/main.tsx` の `handleWorldLoaded` が catch-up しないのと同じ理由)。
// ---------------------------------------------------------------------------

import {
  CONCURRENT_DISPATCH_MAX,
  DISPATCH_BRANCH_FACTOR,
  DISPATCH_EVENT_NODES_MAX,
  DISPATCH_TREE_NODES_MAX,
  DISPATCH_TREE_NODES_TOTAL_MAX,
} from "../engine/commands";
import { fnv1a32 } from "../engine/rng/fnv1a32";
import { fromSerializable, toSerializable } from "../engine/state/serialize";
import type { GameState } from "../engine/state/state";
import { migrateSavePayload, migrateStoredSave, SAVE_FORMAT_VERSION } from "./migration";
import { systemWallClock, type WallClock } from "./promotionPrompt";
import { checkSaveCapacity, SAVE_SIZE_ABORT_BYTES, type SaveCapacityCheck } from "./saveCapacity";

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

/**
 * [M54] キーにセーブが**一度も存在しない**(初回起動)。他の `PersistenceError`
 * (checksum 不一致・版違反・migration 失敗等 = 何かが実際に壊れている)と
 * 区別するための専用型。`loadLatestSave` が `value === undefined` のときだけ
 * 投げる。呼び出し側(`src/main.tsx` の `loadOrCreateState`)はこれを捕まえた
 * 場合だけ「セーブが無いだけ」として黙って新規開始し、それ以外の
 * `PersistenceError`(セーブはあったが読めなかった)はその場でユーザーへ知らせる
 * (ロードマップ M54 行「起動失敗のその場通知」)。
 */
export class SaveNotFoundError extends PersistenceError {
  constructor(message: string) {
    super(message);
    this.name = "SaveNotFoundError";
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

/**
 * 書込前サイズ検査(ADR-012(2))で 4MB 中止しきい値を超えた。
 * 判定ロジック本体は `saveCapacity.ts`(純関数・I/O なし)、ここは書込を
 * 実際に止める境界(`saveGameState`)でのみ投げる。
 */
export class SaveCapacityError extends PersistenceError {
  constructor(
    message: string,
    /** 判定の全内訳(`level` は常に `"abort"`)。 */
    readonly capacity: SaveCapacityCheck,
  ) {
    super(message);
    this.name = "SaveCapacityError";
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
  /**
   * [台帳v26 必-1] このレコードを書いた壁時計時刻(エポック ms・§4)。
   *
   * **省略可**である: 台帳v26 必-1 以前に書かれたセーブは持たず、export
   * テキスト(`exchange.ts`)にも載らない(§4(e))。読出側は
   * {@link readSavedAtMs} を通し、無ければ「不明 = 経過 0」として扱う。
   */
  readonly savedAtMs?: number;
}

/** {@link encodeSaveRecord} の任意入力。 */
export interface EncodeSaveOptions {
  /**
   * [台帳v26 必-1] エンベロープへ載せる壁時計時刻(§4(e))。**呼び出し側が
   * 読んだ値を渡す**(この関数は時計に触れない = 純関数のまま)。
   */
  readonly savedAtMs?: number;
}

/**
 * [台帳v26 必-1] savedAtMs として書ける値(エポック ms = 0 以上の安全整数)か。
 * `Date.now()` は常にこれを満たす。満たさない値は**書込側で**止める
 * (読出側は §4(b) のとおり止めずに「不明」へ倒す —— 書けるものを狭く、
 * 読めるものを広く、が破損検出の基本形である)。
 */
function isWritableSavedAtMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * [台帳v26 必-1] エンベロープから `savedAtMs` を読む。**検証されていない値**
 * (checksum の対象外・§4(b))なので、読めなければ例外ではなく `null` を返す。
 *
 * `null` の意味は「最後に遊んだ実時刻が分からない」であり、呼び出し側
 * (`src/main.tsx`)はそれを**経過 0**、すなわち台帳v26 必-1 以前とまったく
 * 同じ起動挙動へ落とす。ここで投げると、遊べるはずのセーブが「時刻が壊れて
 * いる」だけの理由で読めなくなる。
 */
export function readSavedAtMs(value: unknown): number | null {
  if (!isRecordObject(value)) return null;
  const savedAtMs = value["savedAtMs"];
  if (typeof savedAtMs !== "number" || !isWritableSavedAtMs(savedAtMs)) return null;
  return savedAtMs;
}

/**
 * 破損検出用チェックサム(§2)。engine の FNV-1a-32 をそのまま使う。
 * 入力文字列が 1 文字でも変われば値が変わる(テストで固定)。
 */
export function computeIntegrityChecksum(payload: string): number {
  return fnv1a32(payload);
}

/**
 * GameState を保存レコードへ符号化する。**時計に触れない純関数**である
 * (壁時計を読むのは {@link saveGameState} だけ・§4(e))。
 *
 * `toSerializable` が正準化(キー順を UTF-16 昇順へ固定)まで済ませているので、
 * 同じ内容の state からは必ず同じ payload バイト列 = 同じ checksum が出る。
 * `savedAtMs` を渡してもこの性質は変わらない —— checksum の対象は payload
 * 文字列だけであり(§2/§4(b))、載る場所はエンベロープ側だからである。
 *
 * @throws {SerializeError} state が直列化できない場合(engine 側の契約違反)
 * @throws {SaveBoundsError} 分岐木ノード上界を破っている場合
 * @throws {PersistenceError} `savedAtMs` がエポック ms(0 以上の安全整数)でない場合
 */
export function encodeSaveRecord(state: GameState, options?: EncodeSaveOptions): SaveRecord {
  const serialized = toSerializable(state);
  // 上界検査は**書込側**に置く。書込は復帰経路の外なので B2 の予算に
  // 影響せず、かつ「有界でないものを永続化させない」という一番早い停止点になる。
  assertDispatchTreeBounds(serialized);
  const payload = JSON.stringify(serialized);
  const record: SaveRecord = {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    integrityChecksum: computeIntegrityChecksum(payload),
    payload,
  };
  const savedAtMs = options?.savedAtMs;
  if (savedAtMs === undefined) return record;
  if (!isWritableSavedAtMs(savedAtMs)) {
    // 壊れた時計をそのまま焼き付けない(次回起動の経過計算が狂う)。
    throw new PersistenceError(
      `savedAtMs ${String(savedAtMs)} がエポック ms(0 以上の安全整数)でない`,
    );
  }
  return { ...record, savedAtMs };
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
//   派遣枠やイベントノード数が動いたら素の 3 定数だけを直す)。
//
//   **[M49] 定数の正本は engine の `commands.ts` へ移した**(ここは再輸出)。
//   上界を実際に満たすのは「派遣確定コマンドが何本の木を何ノード作るか」という
//   engine 側の生成規則であって、セーブ層はそれを検算しているだけである。
//   2 箇所に数値があると、片方だけ直したときに「セーブは通るが生成が上界を破る」
//   /「生成は正しいのにセーブが弾く」という食い違いが起きる。
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

/**
 * 分岐木ノード上界(ADR-012(3))。**正本は `src/engine/commands.ts` §5**であり、
 * ここは従来どおりこのモジュールから輸入できるようにするための再輸出である。
 */
export {
  CONCURRENT_DISPATCH_MAX,
  DISPATCH_BRANCH_FACTOR,
  DISPATCH_EVENT_NODES_MAX,
  DISPATCH_TREE_NODES_MAX,
  DISPATCH_TREE_NODES_TOTAL_MAX,
};

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
  /** payload の UTF-16 コードユニット長。バイト数は `capacity.byteLength` を見る。 */
  readonly payloadLength: number;
  /** 書込前サイズ検査の結果(ADR-012(2)・M4)。`level` が `"warning"` でも書込は行う。 */
  readonly capacity: SaveCapacityCheck;
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
 * **書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2)・M4)**: `encodeSaveRecord`
 * の直後・`put` の直前で判定する。警告は `capacity` に載せて書込を続行し、
 * 中止しきい値(4MB)は {@link SaveCapacityError} を投げて **`put` を呼ばない**
 * (QuotaExceededError を待たず自前で止める・ADR-012(2)「書込中止」)。
 *
 * **[台帳v26 必-1] 壁時計を読む唯一の場所**(§4(e))。ここで読んだ時刻が
 * エンベロープの `savedAtMs` になり、次回起動の不在時間の材料になる。
 * `clock` を差し替えられるのは他の platform モジュール(`backupReminder.ts` /
 * `promotionPrompt.ts`)と同じ流儀であり、時計抽象も `WallClock` を再利用する
 * (新しい時計の型を作らない)。
 *
 * **(tick, 壁時計) の対**が同じレコードに入ることが重要である: 次回起動の
 * 経過は「このレコードの tick から、この壁時計時刻からの不在ぶん」として
 * 計算される。`saveScheduler.ts` のデバウンス(2秒 / 絶対フラッシュ 15秒)で
 * `state` が最大 15 秒古いことはあるが、savedAtMs は**書いた瞬間**なので
 * ずれは常に「経過を少なく見積もる」方向(≤15秒 < 1 tick = 60秒)であり、
 * 不在時間を水増しする方向には決してぶれない。
 *
 * @throws {SaveBoundsError} 分岐木ノード上界超過(`encodeSaveRecord` 内)
 * @throws {SaveCapacityError} payload が 4MB 中止しきい値以上
 */
export async function saveGameState(
  db: IDBDatabase,
  state: GameState,
  key: string = LATEST_SAVE_KEY,
  clock: WallClock = systemWallClock,
): Promise<SavePutResult> {
  const e0 = performance.now();
  const record = encodeSaveRecord(state, { savedAtMs: clock.now() });
  const e1 = performance.now();
  const capacity = checkSaveCapacity(record.payload);
  if (capacity.level === "abort") {
    throw new SaveCapacityError(
      `セーブサイズが書込中止しきい値を超えた(${String(capacity.byteLength)} bytes ≥ ` +
        `${String(SAVE_SIZE_ABORT_BYTES)} bytes・ADR-012(2))。エクスポートで退避してください。`,
      capacity,
    );
  }
  const tx = db.transaction(SAVE_STORE_NAME, "readwrite");
  await requestToPromise(tx.objectStore(SAVE_STORE_NAME).put(record, key), `put("${key}")`);
  await awaitTransaction(tx, "書込トランザクション");
  const e2 = performance.now();
  return {
    integrityChecksum: record.integrityChecksum,
    payloadLength: record.payload.length,
    capacity,
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
  /**
   * [台帳v26 必-1] このセーブを書いた壁時計時刻(§4)。`null` = **不明**
   * (台帳v26 必-1 以前に書かれたセーブ / 値が読めなかった場合)。
   *
   * 呼び出し側(`src/main.tsx`)はこれと現在の壁時計の差を
   * `createTickDriver` の `startElapsedMs` へ渡す。`null` のときは経過 0 =
   * 台帳v26 必-1 以前とまったく同じ起動挙動になる。
   */
  readonly savedAtMs: number | null;
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
    // [M54] 「初回起動でまだ何も保存していない」を他の壊れ方と区別する専用型。
    throw new SaveNotFoundError(`キー "${key}" のセーブが存在しない`);
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
    // [台帳v26 必-1] **最後のマーク(afterDeserialize)より後**で読む。
    // savedAtMs は復帰の計算に使う値だが B2 の 3 演算(get/parse/deserialize)
    // ではないので、区間の意味を変えないよう内側へ入れない(§3・
    // perf-boundaries §2 R7)。実体は型判定 1 回で、bench 側の `callOverhead`
    // に定数として乗る。
    savedAtMs: readSavedAtMs(migrated.value),
  };
}

// --- 5. 差し込み位置の一覧(どこへ何が入るか / 入ったか) --------------------
//
//  (a) 2秒デバウンス + 15秒/25コマンド絶対フラッシュ(ADR-012(1))
//      → **[M3 済]** `saveScheduler.ts`。`saveGameState` を包むスケジューラ
//        として platform 層に置いた。engine の tick とは独立(実時刻ベース)
//        なので engine には入れない。
//  (b) 書込前サイズ検査(1.5MB 警告 / 4MB 中止・ADR-012(2))
//      → **[M4 済]** `saveGameState` の `encodeSaveRecord` 直後、`put` の直前
//        (判定本体は `saveCapacity.ts`)。**復帰経路には無い**ので B2 とは
//        無関係(perf-boundaries §7)。
//  (c) localStorage ミラー(IDB 冗長化)/ バックアップリマインド(GDD 11.9 の一部)
//      → **[M4 済]** `localStorageMirror.ts`(ミラー書込/読出・容量超過時の
//        縮退記録・`loadLatestSave` **呼び出し側**でのフォールバック合成)+
//        `backupReminder.ts`(最終エクスポートからの経過実時間/コマンド数の
//        閾値判定・データ側のみ)。IDB が生きている happy path では分岐しない
//        ため B2 の外(補助メトリクス `mirrorCheckMs` は結果 JSON に出していない。
//        フォールバックは失敗経路であり予算判定の対象外のため)。
//        **GDD 11.9 の残り**(単調タイムスタンプの巻戻し検知 + 実時間ウィンドウ
//        あたりの累積 tick レート制限)は catch-up の tick 進行(`clock.ts`・
//        ADR-026(3)・未実装)と結合する話であり、`src/engine/**` 不可の M4
//        スコープ外(積み残し・後続タスクへ)。
//  (d) saveSchemaVersion 差のマイグレーション連鎖(ADR 3軸(a))
//      → **[M3 済]** `verifySaveRecord` と `fromSerializable` の**間**。payload を
//        parse したプレーン値に対して version 順に純関数を適用する
//        (`migration.ts` の `migrateSavePayload`)。エンベロープ版の連鎖は
//        checksum 検証より前(`migrateStoredSave`)。
//  (e) 起動時オフライン復帰の材料(壁時計・ADR-026 / GDD 11.9)
//      → **[台帳v26 必-1 済]** 書込側は `saveGameState`(`WallClock` を 1 回
//        読んで `encodeSaveRecord` へ渡す)、読出側は `loadLatestSave` の
//        戻り値 `savedAtMs`(§4)。**経過をどう使うかはこの層の責務ではない**:
//        tick への変換は `clock.ts` の `createTickDriver({startElapsedMs})`、
//        起動時の結線は `src/main.tsx` が持つ(この層は「1 回の書込 / 1 回の
//        読出」以上を知らない、という T11 以来の線引きを保つ)。
// ---------------------------------------------------------------------------
