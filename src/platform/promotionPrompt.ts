// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 誘導バナー汎用トラッカー(M34)— ADR-004(1) の設計を一般化
//
// ===========================================================================
// 1. なぜ汎用化するか
// ===========================================================================
//   `platform/backupReminder.ts`(M4)は「エクスポート促進バナー」1 種類専用
//   だった。M34 は Add-to-Home 誘導と通知オプトイン誘導という**2 種類目**の
//   「誘導バナー」を必要とするため、判定ロジックそのものを 1 箇所へ括り出す
//   (バナー種ごとに同じ判定を書き写すと、しきい値の意味がバナーごとに
//   ズレていく)。
//
// ===========================================================================
// 2. 判定は「ローカルに記録した時刻」だけに依存する(ADR-004(1) の核)
// ===========================================================================
//   ADR-004(1) はエクスポート促進バナーについて「バナーロジックを ITP 挙動の
//   仮定から切り離し、実測可能な事実(最終起動 monotonicTimestamp)のみを
//   トリガに再定義」と決定している。本トラッカーはこの設計をそのまま一般化した
//   ものであり、{@link PromotionPromptTracker.status} が読むのは
//     - `firstSeenAt`(このバナー種を最初に観測した時刻)
//     - `lastShownAt`(直近に表示した時刻)
//     - `shownCount`(通算表示回数)
//   の 3 値と `clock.now()` だけである。**ブラウザの実装状態を問い合わせる
//   API(インストール状態 API・通知許可の詳細・ITP の実挙動等)を一切読まない**
//   — これらは仕様がブラウザ間で割れており(GDD 13.3)、判定の入力にすると
//   「未検証の一次挙動の上に UI 仕様を先に確定する」という ADR-004 が撤回した
//   旧欠陥を再現してしまう。
//
//   呼び出し側(`installPromotion.ts` / `notificationCapability.ts`)が
//   「そもそも出す意味があるか」(スタンドアロン済み・API 非対応等)を**この
//   トラッカーの外側**で先に判定し、"出す意味があるときに、しつこすぎないか"
//   だけをここへ問う。2 つの判定を 1 つの関数に混ぜない。
//
// ===========================================================================
// 3. 壁時計(Date.now())を使う理由(clock.ts の単調時刻とは別物)
// ===========================================================================
//   `platform/clock.ts` の `performance.now()` はページ単位で原点がリセット
//   される(ADR-026 の tick 駆動はページ生存中だけ意味を持てばよいため、それで
//   問題ない)。しかし本トラッカーは**再訪(ページの再読み込み・別セッション)を
//   跨いで**「初めて見てから何日経ったか」「前回表示から何日経ったか」を
//   測る必要があり、`performance.now()` の値はそもそも別セッションと比較不能
//   (原点が毎回変わる)。よって壁時計(`Date.now()`)を使う。壁時計は巻き戻り
//   得る(システム時刻変更)が、経過を負にしない({@link elapsedSince} の
//   `Math.max(0, …)`)ことで「しつこくなる」方向にだけ倒す(誤って永久に
//   出なくなる方向の壊れ方はしない)。GDD 11.9 の tick 消費 exploit 対策ほど
//   厳密な巻戻り検知はここでは要らない(実害が「表示頻度がわずかに狂う」
//   程度の UI 不具合であり、決定論やセーブ整合には無関係なため)。
// ---------------------------------------------------------------------------

/** 壁時計(ms・エポック基準)。本番は {@link systemWallClock}、テストは偽物を注入。 */
export interface WallClock {
  now(): number;
}

/** 実行環境の壁時計。`Date.now()` は engine 禁止(ADR-026)だが platform/ui では可(§3)。 */
export const systemWallClock: WallClock = {
  now: () => Date.now(),
};

/** トラッカーの使い方の誤り(しきい値が不正など)。 */
export class PromotionPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionPromptError";
  }
}

/** 永続化用のスナップショット(`initialSnapshot` で復元できる形)。 */
export interface PromotionPromptSnapshot {
  /** このバナー種を最初に観測した時刻(壁時計 ms)。 */
  readonly firstSeenAt: number;
  /** 直近に表示した時刻。`null` = まだ 1 度も表示していない。 */
  readonly lastShownAt: number | null;
  /** 通算表示回数。 */
  readonly shownCount: number;
}

export interface PromotionPromptStatus {
  readonly shouldShow: boolean;
  readonly elapsedSinceFirstSeenMs: number;
  /** `null` = まだ 1 度も表示していない。 */
  readonly elapsedSinceLastShownMs: number | null;
  readonly shownCount: number;
  /** `shownCount` が上限に達し、以後 `shouldShow` が恒久的に `false` になる状態。 */
  readonly capped: boolean;
}

export interface PromotionPromptOptions {
  readonly clock?: WallClock;
  /** 初回観測からの猶予(この時間が経つまでは 1 度も出さない)。既定 0(猶予なし)。 */
  readonly minElapsedSinceFirstSeenMs?: number;
  /** 再表示までの間隔(「しつこくしない」の本体)。既定は事実上無制限(1 度出したら出さない)。 */
  readonly reshowIntervalMs?: number;
  /** 通算表示回数の上限。既定は無制限。 */
  readonly maxShowCount?: number;
  /** 前セッションから復元する場合に渡す(永続化は呼び出し側の責務・backupReminder.ts と同じ方針)。 */
  readonly initialSnapshot?: PromotionPromptSnapshot;
}

function requireNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PromotionPromptError(`${label} は 0 以上の有限数であること(実際: ${String(value)})`);
  }
}

function requirePositiveCount(value: number, label: string): void {
  if (value === Number.POSITIVE_INFINITY) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PromotionPromptError(
      `${label} は 1 以上の整数、または Number.POSITIVE_INFINITY であること(実際: ${String(value)})`,
    );
  }
}

/**
 * 誘導バナー 1 種類ぶんの「しつこくしすぎない」判定(§1/§2)。
 *
 * `BackupReminderTracker`(platform/backupReminder.ts)と対の存在だが、
 * あちらは「経過実時間 OR コマンド数」の 2 軸 OR 判定、こちらは
 * 「初回からの猶予 AND 再表示間隔 AND 表示回数上限」の 3 条件 AND 判定という
 * 違いがある(誘導バナーは "早すぎない・しつこくない・いつかは黙る" の
 * 3 つを同時に満たしたいため)。
 */
export class PromotionPromptTracker {
  private readonly clock: WallClock;
  private readonly minElapsedSinceFirstSeenMs: number;
  private readonly reshowIntervalMs: number;
  private readonly maxShowCount: number;
  private readonly firstSeenAt: number;
  private lastShownAt: number | null;
  private shownCount: number;

  constructor(options: PromotionPromptOptions = {}) {
    this.clock = options.clock ?? systemWallClock;
    this.minElapsedSinceFirstSeenMs = options.minElapsedSinceFirstSeenMs ?? 0;
    this.reshowIntervalMs = options.reshowIntervalMs ?? Number.POSITIVE_INFINITY;
    this.maxShowCount = options.maxShowCount ?? Number.POSITIVE_INFINITY;
    requireNonNegativeFinite(this.minElapsedSinceFirstSeenMs, "minElapsedSinceFirstSeenMs");
    if (this.reshowIntervalMs !== Number.POSITIVE_INFINITY) {
      requireNonNegativeFinite(this.reshowIntervalMs, "reshowIntervalMs");
    }
    requirePositiveCount(this.maxShowCount, "maxShowCount");

    this.firstSeenAt = options.initialSnapshot?.firstSeenAt ?? this.clock.now();
    this.lastShownAt = options.initialSnapshot?.lastShownAt ?? null;
    this.shownCount = options.initialSnapshot?.shownCount ?? 0;
  }

  /** 経過を負にしない(§3)。壁時計の巻き戻りで判定が壊れる方向を潰す。 */
  private elapsedSince(at: number, now: number): number {
    return Math.max(0, now - at);
  }

  /** 現在の判定。呼ぶだけでは状態を変えない(副作用なし・backupReminder.ts と同じ規約)。 */
  status(): PromotionPromptStatus {
    const now = this.clock.now();
    const elapsedSinceFirstSeenMs = this.elapsedSince(this.firstSeenAt, now);
    const elapsedSinceLastShownMs =
      this.lastShownAt === null ? null : this.elapsedSince(this.lastShownAt, now);
    const capped = this.shownCount >= this.maxShowCount;
    const pastGrace = elapsedSinceFirstSeenMs >= this.minElapsedSinceFirstSeenMs;
    const pastCooldown =
      elapsedSinceLastShownMs === null || elapsedSinceLastShownMs >= this.reshowIntervalMs;

    return {
      shouldShow: !capped && pastGrace && pastCooldown,
      elapsedSinceFirstSeenMs,
      elapsedSinceLastShownMs,
      shownCount: this.shownCount,
      capped,
    };
  }

  /** 実際に表示したことを記録する(呼び出し側が表示を決めた直後に 1 回呼ぶ)。 */
  recordShown(): void {
    this.lastShownAt = this.clock.now();
    this.shownCount += 1;
  }

  /** 永続化用のスナップショット(`initialSnapshot` で復元できる形)。 */
  snapshot(): PromotionPromptSnapshot {
    return {
      firstSeenAt: this.firstSeenAt,
      lastShownAt: this.lastShownAt,
      shownCount: this.shownCount,
    };
  }
}

// ===========================================================================
// 4. 永続化ヘルパ(キー1本ぶん・複数バナー種で共有する実装)
// ===========================================================================
//   `installPromotion.ts`(Add-to-Home)と `notificationCapability.ts`
//   (通知オプトイン)の 2 種類がどちらもこの形をそのまま使う。
//   `localStorageMirror.ts` の `LocalStorageLike` と同じ最小契約を要求する
//   ことで、そちらのモジュールへ依存を作らずに済ませてある(このモジュールは
//   誘導バナー全般の土台であり、セーブ機構固有の型に結び付けない)。
// ---------------------------------------------------------------------------

/** 本モジュールが要求する最小のストレージ契約(`localStorageMirror.LocalStorageLike` 互換)。 */
export interface PromptStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isValidPromotionPromptSnapshot(value: unknown): value is PromotionPromptSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PromotionPromptSnapshot>;
  return (
    typeof v.firstSeenAt === "number" &&
    (v.lastShownAt === null || typeof v.lastShownAt === "number") &&
    typeof v.shownCount === "number"
  );
}

/** 保存済みスナップショットを読む。無い/壊れている/読めない場合は `null`。 */
export function loadPromotionPromptSnapshot(
  storage: PromptStorageLike,
  key: string,
): PromotionPromptSnapshot | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidPromotionPromptSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** スナップショットを保存する。書けなくても致命ではない(次回また出るだけ)。 */
export function savePromotionPromptSnapshot(
  storage: PromptStorageLike,
  key: string,
  snapshot: PromotionPromptSnapshot,
): void {
  try {
    storage.setItem(key, JSON.stringify(snapshot));
  } catch {
    // 保存に失敗しても致命ではない(バナーの永続化は保険であり必須ではない)。
  }
}
