// ---------------------------------------------------------------------------
// M4: `src/platform/saveCapacity.ts`(書込前サイズ検査・ADR-012(2))のテスト。
//
// 境界はすべて「閾値**以上**で次段」(ちょうど 1.5MB は warning、ちょうど
// 4MB は abort)。ASCII 文字は UTF-8 で 1 バイト固定なので `"a".repeat(n)` で
// 狙ったバイト数の payload を作れる(多バイト文字での差は別テストで確認)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  checkSaveCapacity,
  payloadByteLength,
  SAVE_SIZE_ABORT_BYTES,
  SAVE_SIZE_TARGET_BYTES,
  SAVE_SIZE_WARNING_BYTES,
} from "../../src/platform/saveCapacity";
import { PersistenceError, SaveCapacityError } from "../../src/platform/persistence";

describe("定数", () => {
  it("ADR-012(2) の数値どおり", () => {
    expect(SAVE_SIZE_TARGET_BYTES).toBe(512 * 1024);
    expect(SAVE_SIZE_WARNING_BYTES).toBe(1.5 * 1024 * 1024);
    expect(SAVE_SIZE_ABORT_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("payloadByteLength", () => {
  it("ASCII は string.length と一致する(1 バイト/文字)", () => {
    expect(payloadByteLength("abc")).toBe(3);
  });

  it("多バイト文字は UTF-16 コードユニット数ではなく実バイト数で数える", () => {
    // "あ" は UTF-8 で 3 バイトだが string.length は 1。
    expect("あ".length).toBe(1);
    expect(payloadByteLength("あ")).toBe(3);
  });

  it("空文字は 0 バイト", () => {
    expect(payloadByteLength("")).toBe(0);
  });
});

describe("checkSaveCapacity", () => {
  it("十分小さい payload は ok・目標内", () => {
    const result = checkSaveCapacity("a".repeat(100));
    expect(result.byteLength).toBe(100);
    expect(result.level).toBe("ok");
    expect(result.exceedsTarget).toBe(false);
    expect(result.forceExportRecommended).toBe(false);
  });

  it("512KB ちょうどは目標内(exceedsTarget=false)", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_TARGET_BYTES));
    expect(result.exceedsTarget).toBe(false);
    expect(result.level).toBe("ok");
  });

  it("512KB を 1 バイト超えると exceedsTarget=true だが level はまだ ok", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_TARGET_BYTES + 1));
    expect(result.exceedsTarget).toBe(true);
    expect(result.level).toBe("ok");
  });

  it("1.5MB 未満は ok", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_WARNING_BYTES - 1));
    expect(result.level).toBe("ok");
  });

  it("1.5MB ちょうどで warning に切り替わる", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_WARNING_BYTES));
    expect(result.level).toBe("warning");
    expect(result.forceExportRecommended).toBe(false);
  });

  it("4MB 未満は warning のまま(abort にならない)", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_ABORT_BYTES - 1));
    expect(result.level).toBe("warning");
  });

  it("4MB ちょうどで abort に切り替わり、forceExportRecommended が立つ", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_ABORT_BYTES));
    expect(result.level).toBe("abort");
    expect(result.forceExportRecommended).toBe(true);
    expect(result.byteLength).toBe(SAVE_SIZE_ABORT_BYTES);
  });

  it("4MB を超えても abort のまま", () => {
    const result = checkSaveCapacity("a".repeat(SAVE_SIZE_ABORT_BYTES + 10));
    expect(result.level).toBe("abort");
  });
});

describe("SaveCapacityError", () => {
  it("PersistenceError の一種(呼び出し側が一括で捕まえられる)", () => {
    const capacity = checkSaveCapacity("a".repeat(SAVE_SIZE_ABORT_BYTES));
    expect(new SaveCapacityError("x", capacity)).toBeInstanceOf(PersistenceError);
  });

  it("投げた判定を capacity プロパティで保持する", () => {
    const capacity = checkSaveCapacity("a".repeat(SAVE_SIZE_ABORT_BYTES));
    const error = new SaveCapacityError("x", capacity);
    expect(error.name).toBe("SaveCapacityError");
    expect(error.capacity).toBe(capacity);
    expect(error.capacity.level).toBe("abort");
  });
});
