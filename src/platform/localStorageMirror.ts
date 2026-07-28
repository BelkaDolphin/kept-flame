// ---------------------------------------------------------------------------
// localStorage ミラー(IDB の冗長化)— M4 / ADR「セーブ:IDB主+localStorageミラー」
//
// ===========================================================================
// 0. このモジュールが解く問題・解かない問題
// ===========================================================================
//   解く: IDB が主ストレージ、localStorage を**冗長化(バックアップ)先**として
//   同じエンベロープ(`persistence.ts` の {@link SaveRecord})を書く。IDB の
//   `open`/`get` が失敗したとき(ブラウザのプライベートモード等で IDB 自体が
//   使えない・一時的な例外)に localStorage 側から復元できるようにする。
//
//   解かない: GDD 11.9 の「単調増加タイムスタンプの二重保存による巻戻し検知」
//   と「実時間ウィンドウあたりの累積 tick レート制限」。これは catch-up の
//   tick 進行(`clock.ts`・ADR-026(3))と結合する話で、値そのものが
//   engine 側の tick 消化ロジックに使われる。本タスク(M4)は
//   `src/engine/**` 変更禁止のスコープであり、`clock.ts` 自体も未実装
//   (eslint.config.js のコメントが指すのみ)なので、ここでは手を出さない
//   (persistence.ts §5(c) に積み残しとして明記)。
//
// ===========================================================================
// 1. localStorage は容量(~5MB)超過を「黙って失敗」させない
// ===========================================================================
//   `localStorage.setItem` は容量超過で `QuotaExceededError` を投げる(実装に
//   よって DOMException の name/message は揺れる)。ここで例外を握りつぶすと
//   「ミラーが書けていないのに書けたと思い込む」事故になるため、
//   {@link writeMirror} は例外を **返り値の `"degraded"` 状態**として明示的に
//   呼び出し側へ伝える(投げ直さない。ミラーはあくまで保険であり、失敗しても
//   IDB 主系の書込を止める理由にはならないため)。
// ---------------------------------------------------------------------------

import { decodeSaveRecord, PersistenceError, type SaveRecord } from "./persistence";
import type { GameState } from "../engine/state/state";

/** localStorage が持つ操作のうち本モジュールが使う 3 つだけ(テストは偽物を注入)。 */
export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 既定のミラーキー。IDB 側のキー(`LATEST_SAVE_KEY`)とは名前空間を分ける。 */
export const SAVE_MIRROR_KEY = "kept-flame:save-mirror";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- 1. 書込(縮退を記録) ----------------------------------------------------

export type MirrorWriteOutcome =
  | { readonly status: "ok" }
  /** 容量超過・private mode 拒否など。**投げずに記録**する(§1)。 */
  | { readonly status: "degraded"; readonly reason: string };

/**
 * ミラーへ 1 回書く。IDB 側と同じ {@link SaveRecord}(エンベロープそのもの)を
 * そのまま `JSON.stringify` するだけで、独自の圧縮/整形はしない
 * (`decodeSaveRecord` がそのまま読める形を保つため)。
 */
export function writeMirror(
  storage: LocalStorageLike,
  record: SaveRecord,
  key: string = SAVE_MIRROR_KEY,
): MirrorWriteOutcome {
  try {
    storage.setItem(key, JSON.stringify(record));
    return { status: "ok" };
  } catch (error) {
    return { status: "degraded", reason: describeError(error) };
  }
}

/** ミラーを消す(呼び出し側の明示操作用。消せなくても致命ではない)。 */
export function clearMirror(storage: LocalStorageLike, key: string = SAVE_MIRROR_KEY): void {
  try {
    storage.removeItem(key);
  } catch {
    // 次回の writeMirror が上書きを試みるので、消去失敗は無視してよい。
  }
}

// --- 2. 読出 -----------------------------------------------------------------

export type MirrorReadOutcome =
  | { readonly status: "absent" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "corrupt"; readonly reason: string }
  | { readonly status: "present"; readonly value: unknown };

/**
 * ミラーの生値を読む。**ここでは checksum 検証をしない**(それは
 * `decodeSaveRecord` の仕事・単一経路の原則)。`JSON.parse` すら失敗する場合は
 * `"corrupt"` として区別し、「ミラーが無い」と「ミラーが壊れている」を
 * 呼び出し側が判別できるようにする。
 */
export function readMirror(
  storage: LocalStorageLike,
  key: string = SAVE_MIRROR_KEY,
): MirrorReadOutcome {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return { status: "unavailable", reason: describeError(error) };
  }
  if (raw === null) return { status: "absent" };
  try {
    return { status: "present", value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { status: "corrupt", reason: `mirror JSON.parse 失敗: ${describeError(error)}` };
  }
}

function unavailableLocalStorage(reason: string): LocalStorageLike {
  const fail = (): never => {
    throw new Error(reason);
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

/**
 * 実行環境の `localStorage`(既定の {@link LocalStorageLike})。
 * vitest(Node 環境)では `localStorage` が無いか信頼できないため、テストは
 * 必ず偽物を注入する(`saveScheduler.ts` の `SaveClock` 注入と同じ方針)。
 * 実環境での動作は Playwright スモークの対象(このモジュールの vitest テストは
 * 純関数部のみ)。
 */
export function resolveLocalStorage(): LocalStorageLike {
  try {
    if (typeof localStorage === "undefined") {
      return unavailableLocalStorage("localStorage が存在しない環境");
    }
    return localStorage;
  } catch (error) {
    // Safari プライベートモード等、参照自体が例外を投げる環境がある。
    return unavailableLocalStorage(describeError(error));
  }
}

// --- 3. フォールバック合成(persistence.ts §5(c) の「呼び出し側」) --------

/** 主(IDB)読出を差し替え可能にした形。`() => loadLatestSave(db).then((r) => r.state)` を渡す想定。 */
export type PrimarySaveLoader = () => Promise<GameState>;

export interface MirrorFallbackResult {
  readonly state: GameState;
  readonly source: "primary" | "mirror";
}

/**
 * 主(IDB)を読み、失敗したら localStorage ミラーへフォールバックする。
 *
 * `loadPrimary` を注入にしてあるのは、実 IDB を使わずに「主が失敗したときの
 * 分岐」を vitest で直接検証できるようにするため(IDB 自体は Node に無い・
 * `persistence.test.ts` 冒頭の方針を踏襲)。
 *
 * ミラーが破損している(checksum 不一致・形が違う)場合は
 * {@link decodeSaveRecord} がそのまま例外を投げる(**黙って通さない**)。
 * ミラーも使えない場合は主側の失敗理由を握りつぶさず、両方の状態を含めた
 * {@link PersistenceError} を投げる。
 */
export async function loadWithMirrorFallback(
  loadPrimary: PrimarySaveLoader,
  storage: LocalStorageLike,
  key: string = SAVE_MIRROR_KEY,
): Promise<MirrorFallbackResult> {
  try {
    const state = await loadPrimary();
    return { state, source: "primary" };
  } catch (primaryError) {
    const mirrored = readMirror(storage, key);
    if (mirrored.status === "present") {
      // 壊れていれば decodeSaveRecord が SaveIntegrityError 等を投げる(伝播させる)。
      return { state: decodeSaveRecord(mirrored.value), source: "mirror" };
    }
    const mirrorReason = "reason" in mirrored ? `: ${mirrored.reason}` : "";
    throw new PersistenceError(
      `主セーブ(IDB)の読出に失敗し、localStorage ミラーも利用できない` +
        `(ミラー状態: ${mirrored.status}${mirrorReason})。主側の失敗理由: ${describeError(primaryError)}`,
    );
  }
}
