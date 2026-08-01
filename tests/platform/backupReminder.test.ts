// ---------------------------------------------------------------------------
// M4: `src/platform/backupReminder.ts`(バックアップリマインドのデータ側)
// のテスト。
//
// `saveScheduler.test.ts` の FakeClock と同じ方針で、実時間を一切使わずに
// 24h 相当の経過を検証する(手で時刻を進める偽時計を注入)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  BACKUP_REMINDER_PROMPT_STORAGE_KEY,
  BACKUP_REMINDER_STORAGE_KEY,
  BackupReminderTracker,
  DEFAULT_BACKUP_REMINDER_COMMAND_COUNT,
  DEFAULT_BACKUP_REMINDER_ELAPSED_MS,
  DEFAULT_BACKUP_REMINDER_PROMPT_MAX_SHOWN,
  DEFAULT_BACKUP_REMINDER_PROMPT_RESHOW_MS,
  createBackupReminderPromptTracker,
  createBackupReminderTracker,
  loadBackupReminderPromptSnapshot,
  loadBackupReminderSnapshot,
  recordBackupExported,
  saveBackupReminderPromptSnapshot,
  saveBackupReminderSnapshot,
  type ReminderClock,
} from "../../src/platform/backupReminder";

/** 手で進める時計(`now()` だけを持つ最小実装)。 */
class FakeClock implements ReminderClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: number): void {
    this.current = at;
  }
}

describe("既定値", () => {
  it("暫定値(ADR/GDD に数値の明記なし・要ユーザー判断)", () => {
    expect(DEFAULT_BACKUP_REMINDER_ELAPSED_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_BACKUP_REMINDER_COMMAND_COUNT).toBe(500);
  });
});

describe("経過実時間しきい値", () => {
  it("一度もエクスポートしていなければトラッカー生成時刻からの経過を測る", () => {
    const clock = new FakeClock();
    clock.set(1_000);
    const tracker = new BackupReminderTracker({ clock, elapsedMsThreshold: 10_000 });
    expect(tracker.status().elapsedMs).toBe(0);
    clock.advance(5_000);
    expect(tracker.status().elapsedMs).toBe(5_000);
    expect(tracker.status().shouldRemind).toBe(false);
  });

  it("しきい値に達すると shouldRemind = true・triggeredBy に elapsed", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, elapsedMsThreshold: 10_000 });
    clock.advance(10_000);
    const status = tracker.status();
    expect(status.shouldRemind).toBe(true);
    expect(status.triggeredBy).toEqual(["elapsed"]);
  });

  it("しきい値未満は shouldRemind = false", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, elapsedMsThreshold: 10_000 });
    clock.advance(9_999);
    expect(tracker.status().shouldRemind).toBe(false);
  });
});

describe("コマンド数しきい値", () => {
  it("しきい値に達すると shouldRemind = true・triggeredBy に command-count", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, commandCountThreshold: 5 });
    tracker.recordCommands(4);
    expect(tracker.status().shouldRemind).toBe(false);
    tracker.recordCommands(1);
    const status = tracker.status();
    expect(status.shouldRemind).toBe(true);
    expect(status.triggeredBy).toEqual(["command-count"]);
    expect(status.commandsSinceExport).toBe(5);
  });

  it("複数回に分けて積み上げても合計で判定する", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, commandCountThreshold: 3 });
    tracker.recordCommands();
    tracker.recordCommands();
    tracker.recordCommands();
    expect(tracker.status().shouldRemind).toBe(true);
  });

  it("両方の閾値が同時に成立すれば triggeredBy に両方入る", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({
      clock,
      elapsedMsThreshold: 1_000,
      commandCountThreshold: 2,
    });
    tracker.recordCommands(2);
    clock.advance(1_000);
    const status = tracker.status();
    expect(status.triggeredBy).toEqual(["elapsed", "command-count"]);
  });
});

describe("recordExport", () => {
  it("エクスポート後は経過時間・コマンド数がリセットされる", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({
      clock,
      elapsedMsThreshold: 1_000,
      commandCountThreshold: 2,
    });
    tracker.recordCommands(2);
    clock.advance(1_000);
    expect(tracker.status().shouldRemind).toBe(true);

    tracker.recordExport();
    const status = tracker.status();
    expect(status.shouldRemind).toBe(false);
    expect(status.commandsSinceExport).toBe(0);
    expect(status.elapsedMs).toBe(0);
    expect(status.lastExportAt).toBe(clock.now());
  });

  it("エクスポート後の経過時間は最終エクスポート時刻から測り直される", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, elapsedMsThreshold: 1_000 });
    clock.advance(500);
    tracker.recordExport();
    clock.advance(999);
    expect(tracker.status().shouldRemind).toBe(false);
    clock.advance(1);
    expect(tracker.status().shouldRemind).toBe(true);
  });
});

describe("snapshot / initialSnapshot(永続化の復元)", () => {
  it("snapshot から別トラッカーを復元すると同じ判定になる", () => {
    const clock = new FakeClock();
    const tracker = new BackupReminderTracker({ clock, commandCountThreshold: 10 });
    tracker.recordCommands(4);
    clock.advance(200);
    tracker.recordExport();
    tracker.recordCommands(3);

    const snapshot = tracker.snapshot();
    expect(snapshot).toEqual({ lastExportAt: 200, commandsSinceExport: 3 });

    const restored = new BackupReminderTracker({
      clock,
      commandCountThreshold: 10,
      initialSnapshot: snapshot,
    });
    expect(restored.status()).toEqual(tracker.status());
  });

  it("initialSnapshot 省略時は未エクスポート扱い", () => {
    const tracker = new BackupReminderTracker();
    expect(tracker.snapshot()).toEqual({ lastExportAt: null, commandsSinceExport: 0 });
  });
});

// ---------------------------------------------------------------------------
// [M54] §3: 周期表示への配線(installPromotion.ts と同型の 2 層構成)。
// ---------------------------------------------------------------------------

interface FakeLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function fakeLocalStorage(initial: Record<string, string> = {}): FakeLocalStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("[M54] 既定値(表示頻度)", () => {
  it("再表示は24h・上限回数は無制限(Add-to-Homeと違い恒久的に黙らない)", () => {
    expect(DEFAULT_BACKUP_REMINDER_PROMPT_RESHOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_BACKUP_REMINDER_PROMPT_MAX_SHOWN).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("[M54] データ条件の永続化(loadBackupReminderSnapshot/saveBackupReminderSnapshot)", () => {
  it("保存 → 読出の往復が一致する", () => {
    const storage = fakeLocalStorage();
    const snapshot = { lastExportAt: 1234, commandsSinceExport: 5 };
    saveBackupReminderSnapshot(storage, snapshot);
    expect(loadBackupReminderSnapshot(storage)).toEqual(snapshot);
    expect(storage.getItem(BACKUP_REMINDER_STORAGE_KEY)).not.toBeNull();
  });

  it("何も保存されていない/壊れていれば null", () => {
    expect(loadBackupReminderSnapshot(fakeLocalStorage())).toBeNull();
    expect(
      loadBackupReminderSnapshot(fakeLocalStorage({ [BACKUP_REMINDER_STORAGE_KEY]: "{" })),
    ).toBeNull();
  });

  it("createBackupReminderTracker は永続化済みスナップショットを復元する", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const first = createBackupReminderTracker({ storage, clock });
    clock.advance(500);
    first.recordExport();
    saveBackupReminderSnapshot(storage, first.snapshot());

    const second = createBackupReminderTracker({ storage, clock });
    expect(second.status()).toEqual(first.status());
  });
});

describe("[M54] 表示頻度の永続化(loadBackupReminderPromptSnapshot/saveBackupReminderPromptSnapshot)", () => {
  it("保存 → 読出の往復が一致する(promotionPrompt.ts §4 のヘルパをそのまま使う)", () => {
    const storage = fakeLocalStorage();
    const snapshot = { firstSeenAt: 1, lastShownAt: 2, shownCount: 3 };
    saveBackupReminderPromptSnapshot(storage, snapshot);
    expect(loadBackupReminderPromptSnapshot(storage)).toEqual(snapshot);
    expect(storage.getItem(BACKUP_REMINDER_PROMPT_STORAGE_KEY)).not.toBeNull();
  });

  it("データ条件とはキーが分かれている(片方の永続化がもう片方に影響しない)", () => {
    expect(BACKUP_REMINDER_STORAGE_KEY).not.toBe(BACKUP_REMINDER_PROMPT_STORAGE_KEY);
  });

  it("createBackupReminderPromptTracker は上限回数が無制限(何度リマインドしても黙らない)", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const tracker = createBackupReminderPromptTracker({ storage, clock });
    for (let i = 0; i < 20; i++) {
      expect(tracker.status().capped).toBe(false);
      tracker.recordShown();
      clock.advance(DEFAULT_BACKUP_REMINDER_PROMPT_RESHOW_MS);
    }
    expect(tracker.status().shouldShow).toBe(true);
  });
});

describe("[M54] recordBackupExported(SettingsScreen のエクスポート成功直後から呼ぶ)", () => {
  it("データ条件トラッカーの lastExportAt/commandsSinceExport をリセットして永続化する", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    // エクスポート前: 既定の経過しきい値(24h)を超え、しきい値に達している状態を作る。
    const before = new BackupReminderTracker({ clock });
    clock.advance(DEFAULT_BACKUP_REMINDER_ELAPSED_MS);
    saveBackupReminderSnapshot(storage, before.snapshot());
    expect(before.status().shouldRemind).toBe(true);

    recordBackupExported(storage, clock);

    const after = createBackupReminderTracker({ storage, clock });
    expect(after.status().shouldRemind).toBe(false);
    expect(after.status().lastExportAt).toBe(clock.now());
    expect(after.status().commandsSinceExport).toBe(0);
  });
});

describe("設定の検証", () => {
  it("elapsedMsThreshold が 0 以下なら拒否する", () => {
    expect(() => new BackupReminderTracker({ elapsedMsThreshold: 0 })).toThrow();
    expect(() => new BackupReminderTracker({ elapsedMsThreshold: -1 })).toThrow();
  });

  it("commandCountThreshold が 1 未満/非整数なら拒否する", () => {
    expect(() => new BackupReminderTracker({ commandCountThreshold: 0 })).toThrow();
    expect(() => new BackupReminderTracker({ commandCountThreshold: 1.5 })).toThrow();
  });

  it("recordCommands の count は 1 以上の整数のみ", () => {
    const tracker = new BackupReminderTracker();
    expect(() => tracker.recordCommands(0)).toThrow();
    expect(() => tracker.recordCommands(-1)).toThrow();
    expect(() => tracker.recordCommands(1.5)).toThrow();
  });
});
