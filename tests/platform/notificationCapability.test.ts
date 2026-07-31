// ---------------------------------------------------------------------------
// M34: `src/platform/notificationCapability.ts`(通知の条件分岐)のテスト。
//
// ロードマップ M34 検収「通知不可経路でも起動・復帰が壊れないテスト」への
// 直接の回答: 能力検出が UA 判定を一切行わず(機能検出のみ)、"使えない"
// 環境でも例外を投げずに `viable: false` / `shouldOfferNotificationOptIn:
// false` へ落ち着くことを固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { LocalStorageLike } from "../../src/platform/localStorageMirror";
import {
  DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS,
  DEFAULT_NOTIFICATION_OPT_IN_MAX_SHOWN,
  DEFAULT_NOTIFICATION_OPT_IN_RESHOW_MS,
  assessNotificationCapability,
  createNotificationOptInTracker,
  detectNotificationCapabilityEnv,
  loadNotificationOptInSnapshot,
  requestNotificationPermission,
  saveNotificationOptInSnapshot,
  shouldOfferNotificationOptIn,
} from "../../src/platform/notificationCapability";
import type { WallClock } from "../../src/platform/promotionPrompt";

class FakeClock implements WallClock {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

function fakeLocalStorage(): LocalStorageLike {
  const map = new Map<string, string>();
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

describe("detectNotificationCapabilityEnv(機能検出のみ・UA 判定なし)", () => {
  it("Notification/ServiceWorker とも無い環境(iOS Safari 非 standalone 相当)", () => {
    const env = detectNotificationCapabilityEnv({});
    expect(env).toEqual({
      hasNotificationApi: false,
      hasServiceWorker: false,
      permission: "unsupported",
    });
  });

  it("Notification はあるが ServiceWorker が無い環境", () => {
    const env = detectNotificationCapabilityEnv({
      Notification: { permission: "default" },
      navigator: {},
    });
    expect(env.hasNotificationApi).toBe(true);
    expect(env.hasServiceWorker).toBe(false);
    expect(env.permission).toBe("default");
  });

  it("両方揃っている環境", () => {
    const env = detectNotificationCapabilityEnv({
      Notification: { permission: "granted" },
      navigator: { serviceWorker: {} },
    });
    expect(env).toEqual({
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: "granted",
    });
  });
});

describe("assessNotificationCapability(GDD 13.3 の条件分岐)", () => {
  it("両 API が揃い permission が拒否済みでなければ viable: true", () => {
    const capability = assessNotificationCapability({
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: "default",
    });
    expect(capability).toEqual({ viable: true, reasons: [] });
  });

  it("Notification API 非対応なら viable: false(理由つき)", () => {
    const capability = assessNotificationCapability({
      hasNotificationApi: false,
      hasServiceWorker: true,
      permission: "unsupported",
    });
    expect(capability.viable).toBe(false);
    expect(capability.reasons.length).toBeGreaterThan(0);
  });

  it("ServiceWorker 非対応なら viable: false", () => {
    const capability = assessNotificationCapability({
      hasNotificationApi: true,
      hasServiceWorker: false,
      permission: "default",
    });
    expect(capability.viable).toBe(false);
  });

  it("permission が denied 済みなら viable: false", () => {
    const capability = assessNotificationCapability({
      hasNotificationApi: true,
      hasServiceWorker: true,
      permission: "denied",
    });
    expect(capability.viable).toBe(false);
  });

  it("複数条件が同時に不成立なら理由も複数積まれる", () => {
    const capability = assessNotificationCapability({
      hasNotificationApi: false,
      hasServiceWorker: false,
      permission: "unsupported",
    });
    expect(capability.reasons.length).toBe(2);
  });
});

describe("requestNotificationPermission(副作用・非対応環境で壊れない)", () => {
  it("Notification 非対応環境では要求せず unsupported を返す(投げない)", async () => {
    await expect(requestNotificationPermission({})).resolves.toBe("unsupported");
  });

  it("対応環境では requestPermission の結果をそのまま返す", async () => {
    const result = await requestNotificationPermission({
      Notification: { requestPermission: () => Promise.resolve("granted") },
    });
    expect(result).toBe("granted");
  });
});

describe("shouldOfferNotificationOptIn(3 条件の AND)", () => {
  const viable = { viable: true, reasons: [] as const };
  const notViable = { viable: false, reasons: ["x"] as const };
  const showableStatus = {
    shouldShow: true,
    elapsedSinceFirstSeenMs: 0,
    elapsedSinceLastShownMs: null,
    shownCount: 0,
    capped: false,
  };
  const notShowableStatus = { ...showableStatus, shouldShow: false };

  it("viable かつ permission=default かつ trackerが shouldShow なら true", () => {
    expect(shouldOfferNotificationOptIn(viable, "default", showableStatus)).toBe(true);
  });

  it("viable でなければ false(permission/tracker が良くても)", () => {
    expect(shouldOfferNotificationOptIn(notViable, "default", showableStatus)).toBe(false);
  });

  it("permission が default でなければ false(granted/denied/unsupported)", () => {
    expect(shouldOfferNotificationOptIn(viable, "granted", showableStatus)).toBe(false);
    expect(shouldOfferNotificationOptIn(viable, "denied", showableStatus)).toBe(false);
    expect(shouldOfferNotificationOptIn(viable, "unsupported", showableStatus)).toBe(false);
  });

  it("トラッカーの判定が false なら false(表示頻度抑制)", () => {
    expect(shouldOfferNotificationOptIn(viable, "default", notShowableStatus)).toBe(false);
  });
});

describe("createNotificationOptInTracker(既定値・永続化)", () => {
  it("既定のしきい値", () => {
    expect(DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_NOTIFICATION_OPT_IN_RESHOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_NOTIFICATION_OPT_IN_MAX_SHOWN).toBe(5);
  });

  it("永続化済みスナップショットから復元できる", () => {
    const storage = fakeLocalStorage();
    const clock = new FakeClock();
    const first = createNotificationOptInTracker({ storage, clock });
    clock.advance(DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS);
    first.recordShown();
    saveNotificationOptInSnapshot(storage, first.snapshot());

    const second = createNotificationOptInTracker({ storage, clock });
    expect(second.status()).toEqual(first.status());
  });

  it("何も保存されていなければ null(load)", () => {
    expect(loadNotificationOptInSnapshot(fakeLocalStorage())).toBeNull();
  });
});

describe("起動・復帰が壊れない経路(ロードマップ M34 検収)", () => {
  it("Notification/ServiceWorker とも無い環境の一連の呼び出しが 1 つも投げない", async () => {
    const storage = fakeLocalStorage();
    const clock = new FakeClock();
    clock.advance(DEFAULT_NOTIFICATION_OPT_IN_GRACE_MS);

    const env = detectNotificationCapabilityEnv({});
    const capability = assessNotificationCapability(env);
    const tracker = createNotificationOptInTracker({ storage, clock });
    const visible = shouldOfferNotificationOptIn(capability, env.permission, tracker.status());

    expect(capability.viable).toBe(false);
    expect(visible).toBe(false);
    // 万一 UI 側の配線ミスで呼ばれても壊れない(視認できないボタンなので
    // 通常は呼ばれないが、防御的に確認する)。
    await expect(requestNotificationPermission({})).resolves.toBe("unsupported");
  });
});
