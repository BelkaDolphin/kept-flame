// ---------------------------------------------------------------------------
// バックアップリマインド(データ側)— M4 / GDD 11.9・ADR-004 の精神を踏襲
//
// ===========================================================================
// 0. スコープ: 閾値判定のみ。UI 導線(バナー等)は後続タスク
// ===========================================================================
//   保持するのは「最終エクスポートからの経過実時間」と「同コマンド数」の
//   2 軸で、どちらかが閾値を超えたら `shouldRemind: true` を返す(ADR-012(1)
//   の書込 4 トリガが OR で束ねられているのと同じ考え方)。実際にバナーを
//   出す/出さないの UI 判断・promotion strength(ADR-004(1) の
//   standalone/非 standalone 分岐)はこのモジュールの責務外。
//
// ===========================================================================
// 1. 閾値の数値は ADR/GDD に明文が無い(要ユーザー判断・報告事項)
// ===========================================================================
//   ADR-004(1) は「バナーロジックを ITP 挙動の仮定から切り離し、実測可能な
//   事実(最終起動 monotonicTimestamp)のみをトリガに再定義」と述べるが、
//   具体的な経過時間のしきい値までは明文化していない(standalone/非
//   standalone 分岐は「促進強度の調整のみ」であり、これも数値は非規定)。
//   本実装は暫定値として下記 2 定数を置く。UI 導線タスクで見直すこと。
//
// ===========================================================================
// 2. 時計は壁時計(Date.now())を使う([2026-08-01 M54 で修正])
// ===========================================================================
//   当初(M4)は `saveScheduler.ts` の `SaveClock`(`now()` だけの部分型)を
//   そのまま流用していたが、`SaveClock` の既定実装 `systemSaveClock` は
//   **単調時計**(`performance.now()`)であり、ページを再読込するたびに原点が
//   0 へ戻る。M54 で「前回エクスポートからの経過実時間」を localStorage 越しに
//   複数セッションへまたがせようとすると、旧セッションの `lastExportAt`
//   (例: 500,000ms)が新セッションの `now()`(0 付近から再出発)より未来の値に
//   なってしまい、`elapsedMs` が恒常的に負になって二度と閾値へ届かない
//   (= リマインダが永久に沈黙する)という壊れ方をする。よって
//   `promotionPrompt.ts` と同じ壁時計(`Date.now()`)へ切り替えた——`Date.now()`
//   はページ再読込を跨いでも意味を保つので、この用途に必要なのは元々
//   こちらだった。テストは引き続き「時刻を進める」偽時計を注入することで
//   実時間を 1ms も待たずに 24h 閾値等を検証できる(saveScheduler.test.ts の
//   FakeClock と同じ方針・型が構造的に同じなので偽物の実装は変えていない)。
// ---------------------------------------------------------------------------

import { resolveLocalStorage, type LocalStorageLike } from "./localStorageMirror";
import {
  PromotionPromptTracker,
  loadPromotionPromptSnapshot,
  savePromotionPromptSnapshot,
  systemWallClock,
  type PromotionPromptSnapshot,
  type WallClock,
} from "./promotionPrompt";

/** リマインダが使う時計機能は `now()` だけ(§2)。`WallClock` はこれを満たす。 */
export type ReminderClock = Pick<WallClock, "now">;

/**
 * 前回エクスポートからの経過実時間しきい値(既定値・ms)。
 * **ADR/GDD に具体数値の指定なし**(§1・要ユーザー判断)。1 日 1 回相当の
 * 頻度感を暫定値として置く。
 */
export const DEFAULT_BACKUP_REMINDER_ELAPSED_MS = 24 * 60 * 60 * 1000;

/**
 * 前回エクスポートからのコマンド数しきい値(既定値)。同じく暫定値(§1)。
 * `SaveScheduler` の絶対件数フラッシュ(25 コマンド)より 1 桁大きい値を置く
 * (セーブは細粒度、エクスポート促進はもっと粗い頻度でよいという判断)。
 */
export const DEFAULT_BACKUP_REMINDER_COMMAND_COUNT = 500;

export type BackupReminderTrigger = "elapsed" | "command-count";

export interface BackupReminderStatus {
  readonly shouldRemind: boolean;
  /** 経過実時間(ms)。一度もエクスポートしていなければトラッカー生成時からの経過。 */
  readonly elapsedMs: number;
  readonly commandsSinceExport: number;
  /** 発火した条件(複数同時に真ならどちらも入る)。 */
  readonly triggeredBy: readonly BackupReminderTrigger[];
  /** `null` = 一度もエクスポートしていない。 */
  readonly lastExportAt: number | null;
}

/** {@link BackupReminderTracker} の内部状態(永続化・復元用)。 */
export interface BackupReminderSnapshot {
  readonly lastExportAt: number | null;
  readonly commandsSinceExport: number;
}

export interface BackupReminderOptions {
  readonly clock?: ReminderClock;
  readonly elapsedMsThreshold?: number;
  readonly commandCountThreshold?: number;
  /** 前セッションから復元する場合に渡す(localStorage 等への永続化は呼び出し側の責務)。 */
  readonly initialSnapshot?: BackupReminderSnapshot;
}

/**
 * 「最終エクスポートからの経過実時間/コマンド数」を保持し、閾値判定を返す。
 * `SaveScheduler` と同じく「何を(エクスポートする内容)」は知らず、
 * 「いつリマインドすべきか」だけを持つ。
 */
export class BackupReminderTracker {
  private readonly clock: ReminderClock;
  private readonly elapsedMsThreshold: number;
  private readonly commandCountThreshold: number;
  private readonly trackingStartedAt: number;
  private lastExportAt: number | null;
  private commandsSinceExport: number;

  constructor(options: BackupReminderOptions = {}) {
    this.clock = options.clock ?? systemWallClock;
    this.elapsedMsThreshold = options.elapsedMsThreshold ?? DEFAULT_BACKUP_REMINDER_ELAPSED_MS;
    this.commandCountThreshold =
      options.commandCountThreshold ?? DEFAULT_BACKUP_REMINDER_COMMAND_COUNT;
    if (!(this.elapsedMsThreshold > 0) || !Number.isFinite(this.elapsedMsThreshold)) {
      throw new Error("BackupReminderTracker: elapsedMsThreshold は正の有限数であること");
    }
    if (!Number.isSafeInteger(this.commandCountThreshold) || this.commandCountThreshold <= 0) {
      throw new Error("BackupReminderTracker: commandCountThreshold は 1 以上の整数であること");
    }
    this.trackingStartedAt = this.clock.now();
    this.lastExportAt = options.initialSnapshot?.lastExportAt ?? null;
    this.commandsSinceExport = options.initialSnapshot?.commandsSinceExport ?? 0;
  }

  /** コマンド適用のたびに呼ぶ(`SaveScheduler.recordCommands` と同じ粒度でよい)。 */
  recordCommands(count = 1): void {
    if (count <= 0 || !Number.isSafeInteger(count)) {
      throw new Error("BackupReminderTracker: count は 1 以上の整数であること");
    }
    this.commandsSinceExport += count;
  }

  /** エクスポートが実際に行われたことを記録する(両カウンタをリセット)。 */
  recordExport(): void {
    this.lastExportAt = this.clock.now();
    this.commandsSinceExport = 0;
  }

  /** 現在の閾値判定。呼ぶだけでは状態を変えない(副作用なし)。 */
  status(): BackupReminderStatus {
    const now = this.clock.now();
    const referenceAt = this.lastExportAt ?? this.trackingStartedAt;
    const elapsedMs = now - referenceAt;
    const triggeredBy: BackupReminderTrigger[] = [];
    if (elapsedMs >= this.elapsedMsThreshold) triggeredBy.push("elapsed");
    if (this.commandsSinceExport >= this.commandCountThreshold) triggeredBy.push("command-count");
    return {
      shouldRemind: triggeredBy.length > 0,
      elapsedMs,
      commandsSinceExport: this.commandsSinceExport,
      triggeredBy,
      lastExportAt: this.lastExportAt,
    };
  }

  /** 永続化用のスナップショット(`initialSnapshot` で復元できる形)。 */
  snapshot(): BackupReminderSnapshot {
    return { lastExportAt: this.lastExportAt, commandsSinceExport: this.commandsSinceExport };
  }
}

// ===========================================================================
// 3. [M54] 周期表示への配線 — installPromotion.ts と同型の 2 層構成
// ===========================================================================
//   ロードマップ M54 行「定期バックアップ推奨バナーの配線」。既存(§0〜2)は
//   「今リマインドすべきデータ条件」(= `BackupReminderTracker.status().
//   shouldRemind`)しか持たず、これだけを画面に直結すると「条件が真の間ずっと
//   出続ける」(=しつこい)バナーになる。`installPromotion.ts`/
//   `notificationCapability.ts` が Add-to-Home/通知オプトインで採用した
//   「データ条件」と「表示頻度(`PromotionPromptTracker`)」の 2 層構成を
//   ここでも踏襲する:
//     - データ条件 = 本ファイルの `BackupReminderTracker`(§0〜2・エクスポートで
//       リセット)
//     - 表示頻度   = `promotionPrompt.ts` の `PromotionPromptTracker` をそのまま
//       再利用(バナーを見せたこと自体が「バックアップした」を意味しないので
//       `recordShown` はデータ条件をリセットしない——2 つの永続化キーを分ける
//       理由もここにある)
//   両方の永続化は呼び出し側(`src/main.tsx`)の責務(§3 と同じ設計)。
// ---------------------------------------------------------------------------

/** localStorage キー(データ条件側)。セーブ本体(persistence.ts)とは名前空間を分ける。 */
export const BACKUP_REMINDER_STORAGE_KEY = "kept-flame:backup-reminder";

/** localStorage キー(表示頻度側)。データ条件とは別バナー種として扱う(§3)。 */
export const BACKUP_REMINDER_PROMPT_STORAGE_KEY = "kept-flame:backup-reminder-prompt";

/**
 * 表示頻度の暫定値(§3・installPromotion.ts §2 と同じ状況=要ユーザー判断)。
 * 「しつこくしない」の間隔は 24h(データ条件の既定閾値と同じ桁)、猶予は 0
 * (データ条件そのものが既に 24h/500 コマンドの敷居を持つため二重に待たせない)、
 * 上限回数は**無制限**(Add-to-Home と違い、バックアップ未実施のリスクは
 * 「何度断られても平気」という性質のものではないため=ロードマップ M39 再評価対象)。
 */
export const DEFAULT_BACKUP_REMINDER_PROMPT_GRACE_MS = 0;
export const DEFAULT_BACKUP_REMINDER_PROMPT_RESHOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BACKUP_REMINDER_PROMPT_MAX_SHOWN = Number.POSITIVE_INFINITY;

function isValidBackupReminderSnapshot(value: unknown): value is BackupReminderSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<BackupReminderSnapshot>;
  return (
    (v.lastExportAt === null || typeof v.lastExportAt === "number") &&
    typeof v.commandsSinceExport === "number"
  );
}

/** 保存済みのデータ条件スナップショットを読む。無い/壊れていれば `null`。 */
export function loadBackupReminderSnapshot(
  storage: LocalStorageLike,
): BackupReminderSnapshot | null {
  let raw: string | null;
  try {
    raw = storage.getItem(BACKUP_REMINDER_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidBackupReminderSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** データ条件スナップショットを保存する。書けなくても致命ではない。 */
export function saveBackupReminderSnapshot(
  storage: LocalStorageLike,
  snapshot: BackupReminderSnapshot,
): void {
  try {
    storage.setItem(BACKUP_REMINDER_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // 保存できなくても致命ではない(次回セッション起点で測り直すだけ)。
  }
}

export interface CreateBackupReminderTrackerOptions {
  readonly storage?: LocalStorageLike;
  readonly clock?: ReminderClock;
}

/** 本番用のデータ条件トラッカーを組み立てる(永続化済みスナップショットを復元)。 */
export function createBackupReminderTracker(
  options: CreateBackupReminderTrackerOptions = {},
): BackupReminderTracker {
  const storage = options.storage ?? resolveLocalStorage();
  const snapshot = loadBackupReminderSnapshot(storage);
  return new BackupReminderTracker({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
  });
}

/** 保存済みの表示頻度スナップショットを読む(`promotionPrompt.ts` §4 のヘルパそのもの)。 */
export function loadBackupReminderPromptSnapshot(
  storage: LocalStorageLike,
): PromotionPromptSnapshot | null {
  return loadPromotionPromptSnapshot(storage, BACKUP_REMINDER_PROMPT_STORAGE_KEY);
}

/** 表示頻度スナップショットを保存する。 */
export function saveBackupReminderPromptSnapshot(
  storage: LocalStorageLike,
  snapshot: PromotionPromptSnapshot,
): void {
  savePromotionPromptSnapshot(storage, BACKUP_REMINDER_PROMPT_STORAGE_KEY, snapshot);
}

export interface CreateBackupReminderPromptTrackerOptions {
  readonly storage?: LocalStorageLike;
  readonly clock?: ReminderClock;
}

/** 本番用の表示頻度トラッカーを組み立てる(§3 の既定値 + 永続化済みスナップショット)。 */
export function createBackupReminderPromptTracker(
  options: CreateBackupReminderPromptTrackerOptions = {},
): PromotionPromptTracker {
  const storage = options.storage ?? resolveLocalStorage();
  const snapshot = loadBackupReminderPromptSnapshot(storage);
  return new PromotionPromptTracker({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    minElapsedSinceFirstSeenMs: DEFAULT_BACKUP_REMINDER_PROMPT_GRACE_MS,
    reshowIntervalMs: DEFAULT_BACKUP_REMINDER_PROMPT_RESHOW_MS,
    maxShowCount: DEFAULT_BACKUP_REMINDER_PROMPT_MAX_SHOWN,
    ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
  });
}

/**
 * エクスポートが実際に行われたことをデータ条件トラッカーへ記録し、永続化する。
 * `src/ui/screens/settings/SettingsScreen.tsx` の「エクスポートしてダウンロード」
 * 成功直後から呼ぶ(呼び出しは 1 箇所・load→record→save の往復を畳んである)。
 */
export function recordBackupExported(
  storage: LocalStorageLike = resolveLocalStorage(),
  clock?: ReminderClock,
): void {
  const snapshot = loadBackupReminderSnapshot(storage);
  const tracker = new BackupReminderTracker({
    ...(clock === undefined ? {} : { clock }),
    ...(snapshot === null ? {} : { initialSnapshot: snapshot }),
  });
  tracker.recordExport();
  saveBackupReminderSnapshot(storage, tracker.snapshot());
}
