// ---------------------------------------------------------------------------
// M4: `src/platform/localStorageMirror.ts`(localStorage ミラー・IDB 冗長化)
// のテスト。
//
// 実 `localStorage` は Node(vitest environment: "node")に無い/信頼できない
// ため、`LocalStorageLike` の偽物を注入する(`saveScheduler.test.ts` の
// FakeClock と同じ方針)。IDB 本体も同じ理由で `loadPrimary` を差し替え可能に
// してあるので、ここでは実 IDB を一切使わない。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  clearMirror,
  loadWithMirrorFallback,
  readMirror,
  resolveLocalStorage,
  SAVE_MIRROR_KEY,
  writeMirror,
  type LocalStorageLike,
} from "../../src/platform/localStorageMirror";
import {
  encodeSaveRecord,
  PersistenceError,
  SaveIntegrityError,
  type SaveRecord,
} from "../../src/platform/persistence";

import { facility, HEARTH, id, resident, stateOf } from "../engine/fixtures";

const STATE = stateOf([
  resident("residentA", { assignedFacilityId: id("facilityHearth") }),
  facility("facilityHearth", HEARTH.id, 0, [id("residentA")], 2),
]);

/** メモリ上に置いた `LocalStorageLike`(正常系)。 */
class FakeLocalStorage implements LocalStorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** `setItem` が容量超過(QuotaExceededError 相当)で必ず失敗する偽物。 */
class QuotaExceededLocalStorage implements LocalStorageLike {
  getItem(): string | null {
    return null;
  }

  setItem(): never {
    const error = new Error("Quota exceeded");
    error.name = "QuotaExceededError";
    throw error;
  }

  removeItem(): void {
    // 何もしない。
  }
}

/** 読み書きどちらも例外を投げる偽物(private mode 等)。 */
class UnavailableLocalStorage implements LocalStorageLike {
  getItem(): never {
    throw new Error("SecurityError");
  }

  setItem(): never {
    throw new Error("SecurityError");
  }

  removeItem(): never {
    throw new Error("SecurityError");
  }
}

// --- 1. 書込(縮退の記録) ----------------------------------------------------

describe("writeMirror", () => {
  it("正常系は ok を返し、同じキーで読み戻せる", () => {
    const storage = new FakeLocalStorage();
    const record = encodeSaveRecord(STATE);
    const outcome = writeMirror(storage, record);
    expect(outcome).toEqual({ status: "ok" });
    expect(storage.getItem(SAVE_MIRROR_KEY)).toBe(JSON.stringify(record));
  });

  it("容量超過は例外を投げず degraded として記録する", () => {
    const storage = new QuotaExceededLocalStorage();
    const record = encodeSaveRecord(STATE);
    const outcome = writeMirror(storage, record);
    expect(outcome.status).toBe("degraded");
    if (outcome.status === "degraded") {
      expect(outcome.reason).toMatch(/quota/i);
    }
  });

  it("読み書き不可の環境でも degraded として記録する(黙って握りつぶさない)", () => {
    const storage = new UnavailableLocalStorage();
    const outcome = writeMirror(storage, encodeSaveRecord(STATE));
    expect(outcome.status).toBe("degraded");
  });
});

// --- 2. 読出 -----------------------------------------------------------------

describe("readMirror", () => {
  it("何も書いていなければ absent", () => {
    expect(readMirror(new FakeLocalStorage())).toEqual({ status: "absent" });
  });

  it("書いたものをそのまま present で返す(検証はしない)", () => {
    const storage = new FakeLocalStorage();
    const record = encodeSaveRecord(STATE);
    writeMirror(storage, record);
    const result = readMirror(storage);
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.value).toEqual(record);
    }
  });

  it("JSON として読めない値は corrupt", () => {
    const storage = new FakeLocalStorage();
    storage.setItem(SAVE_MIRROR_KEY, "{ 壊れた json");
    const result = readMirror(storage);
    expect(result.status).toBe("corrupt");
  });

  it("getItem が例外を投げる環境は unavailable", () => {
    const result = readMirror(new UnavailableLocalStorage());
    expect(result.status).toBe("unavailable");
  });
});

describe("clearMirror", () => {
  it("書いたミラーを消す", () => {
    const storage = new FakeLocalStorage();
    writeMirror(storage, encodeSaveRecord(STATE));
    clearMirror(storage);
    expect(readMirror(storage)).toEqual({ status: "absent" });
  });

  it("removeItem が例外を投げても致命にしない", () => {
    expect(() => clearMirror(new UnavailableLocalStorage())).not.toThrow();
  });
});

describe("resolveLocalStorage", () => {
  it("Node(vitest)環境では unavailable な実装を返す(呼ぶと例外)", () => {
    const storage = resolveLocalStorage();
    expect(() => storage.getItem(SAVE_MIRROR_KEY)).toThrow();
  });
});

// --- 3. フォールバック合成 ---------------------------------------------------

describe("loadWithMirrorFallback", () => {
  it("主(IDB)が成功すればミラーを見ない", async () => {
    const storage = new FakeLocalStorage();
    const result = await loadWithMirrorFallback(() => Promise.resolve(STATE), storage);
    expect(result.source).toBe("primary");
    expect(result.state).toBe(STATE);
  });

  it("主が失敗してもミラーが正常なら復元できる", async () => {
    const storage = new FakeLocalStorage();
    writeMirror(storage, encodeSaveRecord(STATE));
    const result = await loadWithMirrorFallback(
      () => Promise.reject(new PersistenceError("IDB が開けない")),
      storage,
    );
    expect(result.source).toBe("mirror");
    expect(result.state.tick).toBe(STATE.tick);
  });

  it("主もミラーも無ければ主の失敗理由を含む PersistenceError を投げる", async () => {
    const storage = new FakeLocalStorage();
    await expect(
      loadWithMirrorFallback(() => Promise.reject(new PersistenceError("IDB が開けない")), storage),
    ).rejects.toThrow(/IDB が開けない/);
  });

  it("ミラーが破損(checksum 不一致)していれば黙って通さず SaveIntegrityError", async () => {
    const storage = new FakeLocalStorage();
    const record = encodeSaveRecord(STATE);
    const tampered: SaveRecord = { ...record, payload: `${record.payload} ` };
    storage.setItem(SAVE_MIRROR_KEY, JSON.stringify(tampered));
    await expect(
      loadWithMirrorFallback(() => Promise.reject(new PersistenceError("IDB が開けない")), storage),
    ).rejects.toThrow(SaveIntegrityError);
  });

  it("ミラーが JSON として壊れていれば主の失敗理由を含むエラーになる(黙って通さない)", async () => {
    const storage = new FakeLocalStorage();
    storage.setItem(SAVE_MIRROR_KEY, "{ 壊れた json");
    await expect(
      loadWithMirrorFallback(() => Promise.reject(new PersistenceError("IDB が開けない")), storage),
    ).rejects.toThrow(PersistenceError);
  });
});
