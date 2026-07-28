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
// 2. 時計は注入する(saveScheduler.ts の SaveClock と同じ理由・同じ形)
// ===========================================================================
//   `ReminderClock` は `SaveClock` の `now()` だけを使う部分型にしてあるので、
//   `systemSaveClock` をそのまま既定値に流用できる(タイマは不要なので
//   `setTimer` は使わない)。テストは「時刻を進める」偽時計を注入することで
//   実時間を 1ms も待たずに 24h 閾値等を検証できる(saveScheduler.test.ts の
//   FakeClock と同じ方針)。
// ---------------------------------------------------------------------------

import { systemSaveClock, type SaveClock } from "./saveScheduler";

/** リマインダが使う時計機能は `now()` だけ(§2)。`SaveClock` はこれを満たす。 */
export type ReminderClock = Pick<SaveClock, "now">;

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
    this.clock = options.clock ?? systemSaveClock;
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
