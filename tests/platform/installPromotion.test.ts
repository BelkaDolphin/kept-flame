// ---------------------------------------------------------------------------
// M34: `src/platform/installPromotion.ts`(Add-to-Home 誘導バナーの判定)のテスト。
//
// ロードマップ M34 行の検分「バナー判定が最終起動 monotonicTimestamp のみに
// 依存しているか」への直接の回答として、以下を固定する:
//   1. `createInstallPromotionTracker` が返すトラッカーの `shouldShow` は
//      壁時計(注入した偽時計)だけで決まり、standalone 判定を混ぜていない
//      (`isStandaloneDisplayMode` は完全に別関数として独立にテストする)
//   2. 既定のしきい値(猶予24h・再表示7日・上限5回)
//   3. `isStandaloneDisplayMode` は API 欠如時に安全側(false = バナーを出す側)
//      へ倒れる
//   4. localStorage 往復(壊れたストレージでも起動を壊さない)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { LocalStorageLike } from "../../src/platform/localStorageMirror";
import {
  DEFAULT_INSTALL_PROMOTION_GRACE_MS,
  DEFAULT_INSTALL_PROMOTION_MAX_SHOWN,
  DEFAULT_INSTALL_PROMOTION_RESHOW_MS,
  createInstallPromotionTracker,
  isStandaloneDisplayMode,
  loadInstallPromotionSnapshot,
  saveInstallPromotionSnapshot,
} from "../../src/platform/installPromotion";
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

function fakeLocalStorage(initial: Record<string, string> = {}): LocalStorageLike {
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

describe("既定のしきい値(ADR/GDD に数値の明記なし・暫定値)", () => {
  it("猶予24h・再表示7日・上限5回", () => {
    expect(DEFAULT_INSTALL_PROMOTION_GRACE_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_INSTALL_PROMOTION_RESHOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_INSTALL_PROMOTION_MAX_SHOWN).toBe(5);
  });
});

describe("createInstallPromotionTracker(判定は壁時計だけに依存)", () => {
  it("初回は猶予未満で shouldShow: false、猶予を過ぎると true", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const tracker = createInstallPromotionTracker({ storage, clock });
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(DEFAULT_INSTALL_PROMOTION_GRACE_MS);
    expect(tracker.status().shouldShow).toBe(true);
  });

  it("表示記録後は再表示間隔が経つまで false、経てば再び true", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const tracker = createInstallPromotionTracker({ storage, clock });
    clock.advance(DEFAULT_INSTALL_PROMOTION_GRACE_MS);
    tracker.recordShown();
    saveInstallPromotionSnapshot(storage, tracker.snapshot());
    expect(tracker.status().shouldShow).toBe(false);

    clock.advance(DEFAULT_INSTALL_PROMOTION_RESHOW_MS - 1);
    expect(tracker.status().shouldShow).toBe(false);
    clock.advance(1);
    expect(tracker.status().shouldShow).toBe(true);
  });

  it("永続化済みスナップショットから復元し、別インスタンスでも同じ判定になる", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const first = createInstallPromotionTracker({ storage, clock });
    clock.advance(DEFAULT_INSTALL_PROMOTION_GRACE_MS);
    first.recordShown();
    saveInstallPromotionSnapshot(storage, first.snapshot());

    const second = createInstallPromotionTracker({ storage, clock });
    expect(second.status()).toEqual(first.status());
  });

  it("上限(5回)まで表示すると以後 shouldShow は恒久的に false", () => {
    const clock = new FakeClock();
    const storage = fakeLocalStorage();
    const tracker = createInstallPromotionTracker({ storage, clock });
    clock.advance(DEFAULT_INSTALL_PROMOTION_GRACE_MS);
    for (let i = 0; i < DEFAULT_INSTALL_PROMOTION_MAX_SHOWN; i++) {
      expect(tracker.status().shouldShow).toBe(true);
      tracker.recordShown();
      clock.advance(DEFAULT_INSTALL_PROMOTION_RESHOW_MS);
    }
    expect(tracker.status().capped).toBe(true);
    expect(tracker.status().shouldShow).toBe(false);
  });
});

describe("isStandaloneDisplayMode(判定には混ぜない・描画抑止のみ)", () => {
  it("navigator.standalone が true なら standalone", () => {
    expect(isStandaloneDisplayMode({ navigator: { standalone: true } })).toBe(true);
  });

  it("matchMedia('(display-mode: standalone)') が true なら standalone", () => {
    expect(
      isStandaloneDisplayMode({
        matchMedia: (query) => ({ matches: query === "(display-mode: standalone)" }),
      }),
    ).toBe(true);
  });

  it("matchMedia が false・navigator.standalone 無しなら false", () => {
    expect(isStandaloneDisplayMode({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it("どちらの API も無い環境では安全側(false = バナーを出す側)へ倒れる", () => {
    expect(isStandaloneDisplayMode({})).toBe(false);
  });
});

describe("永続化(localStorage 往復・M4 の localStorageMirror.ts と同じ規約)", () => {
  it("保存 → 読出の往復が一致する", () => {
    const storage = fakeLocalStorage();
    const snapshot = { firstSeenAt: 1, lastShownAt: 2, shownCount: 3 };
    saveInstallPromotionSnapshot(storage, snapshot);
    expect(loadInstallPromotionSnapshot(storage)).toEqual(snapshot);
  });

  it("何も保存されていなければ null", () => {
    expect(loadInstallPromotionSnapshot(fakeLocalStorage())).toBeNull();
  });

  it("getItem/setItem が例外を投げても起動を止めない(load は null・save は無視)", () => {
    const brokenStorage: LocalStorageLike = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    };
    expect(loadInstallPromotionSnapshot(brokenStorage)).toBeNull();
    expect(() =>
      saveInstallPromotionSnapshot(brokenStorage, {
        firstSeenAt: 0,
        lastShownAt: null,
        shownCount: 0,
      }),
    ).not.toThrow();

    // ストレージが全損でもトラッカー自体は普通に構築でき、動作する(起動を壊さない)。
    const clock = new FakeClock();
    const tracker = createInstallPromotionTracker({ storage: brokenStorage, clock });
    expect(() => tracker.status()).not.toThrow();
  });
});
