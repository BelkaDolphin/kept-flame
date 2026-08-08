// ---------------------------------------------------------------------------
// T11: `src/platform/persistence.ts` の**純関数部**のテスト。
//
// IndexedDB そのもの(open/put/get)は Node には無く、新規 npm 依存
// (fake-indexeddb 等)の追加は禁止されているため、ここでは扱わない。
// IDB 経路は `bench/perfSmoke.spec.ts`(Playwright / 実 Chromium)で
// 「実際に書いて読めて B2 の内訳が出る」ことを確認する。
//
// このファイルが固定するのは B2 の**中身**である:
//   セーブ文字列の正準性 / integrityChecksum / 破損検出 / 往復不変性。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fnv1a32 } from "../../src/engine/rng/fnv1a32";
import { toSerializable } from "../../src/engine/state/serialize";
import {
  computeIntegrityChecksum,
  decodeSaveRecord,
  encodeSaveRecord,
  LATEST_SAVE_KEY,
  PersistenceError,
  readSavedAtMs,
  SAVE_DB_NAME,
  SAVE_FORMAT_VERSION,
  SAVE_STORE_NAME,
  SaveIntegrityError,
  SaveNotFoundError,
  verifySaveRecord,
  type SaveRecord,
} from "../../src/platform/persistence";

import {
  facility,
  HEARTH,
  id,
  research,
  resident,
  resource,
  stateOf,
  WOOD,
} from "../engine/fixtures";

const STATE = stateOf([
  resident("residentA", { assignedFacilityId: id("facilityHearth") }),
  resident("residentB", { dispatched: true }),
  facility("facilityHearth", HEARTH.id, 0, [id("residentA")], 2),
  research("researchBronze", id("techBronze"), 3),
  resource("resourceWood", WOOD, 12),
]);

// --- 1. チェックサム --------------------------------------------------------

describe("computeIntegrityChecksum", () => {
  it("engine の FNV-1a-32 と同一(独自実装を持たない)", () => {
    expect(computeIntegrityChecksum("kept-flame")).toBe(fnv1a32("kept-flame"));
  });

  it("FNV 公式テストベクタと一致する", () => {
    // Landon Curt Noll の公開テストスイート(fnv1a32.ts の出典)より。
    expect(computeIntegrityChecksum("")).toBe(0x811c9dc5);
    expect(computeIntegrityChecksum("a")).toBe(0xe40c292c);
  });

  it("uint32 の範囲に収まる", () => {
    const value = computeIntegrityChecksum(JSON.stringify(toSerializable(STATE)));
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffff_ffff);
  });

  it("1 文字違えば値が変わる(破損検出の最低条件)", () => {
    expect(computeIntegrityChecksum('{"tick":0}')).not.toBe(computeIntegrityChecksum('{"tick":1}'));
  });
});

// --- 2. 符号化 --------------------------------------------------------------

describe("encodeSaveRecord", () => {
  const record = encodeSaveRecord(STATE);

  it("payload は engine の正準直列化形をそのまま stringify したもの", () => {
    expect(record.payload).toBe(JSON.stringify(toSerializable(STATE)));
  });

  it("エンベロープの版と checksum が入る", () => {
    expect(record.saveFormatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(record.integrityChecksum).toBe(computeIntegrityChecksum(record.payload));
  });

  it("同じ state からは常に同じバイト列 = 同じ checksum(決定論)", () => {
    const again = encodeSaveRecord(STATE);
    expect(again.payload).toBe(record.payload);
    expect(again.integrityChecksum).toBe(record.integrityChecksum);
  });

  it("state が変われば checksum も変わる", () => {
    const moved = encodeSaveRecord(stateOf([...STATE.entityStateById.values()], { tick: 1 }));
    expect(moved.integrityChecksum).not.toBe(record.integrityChecksum);
  });
});

// --- 3. 検証(破損は黙って直さない) ---------------------------------------

function tamper(record: SaveRecord, payload: string): SaveRecord {
  return {
    saveFormatVersion: record.saveFormatVersion,
    integrityChecksum: record.integrityChecksum,
    payload,
  };
}

describe("verifySaveRecord", () => {
  const record = encodeSaveRecord(STATE);

  it("正しいレコードは payload を返す", () => {
    expect(verifySaveRecord(record)).toBe(record.payload);
  });

  it("payload が 1 文字でも変わったら SaveIntegrityError", () => {
    const broken = tamper(record, record.payload.replace('"tick":0', '"tick":1'));
    expect(broken.payload).not.toBe(record.payload);
    expect(() => verifySaveRecord(broken)).toThrow(SaveIntegrityError);
  });

  it("SaveIntegrityError は期待値と実測値を機械可読で持つ", () => {
    const broken = tamper(record, `${record.payload} `);
    let caught: unknown = null;
    try {
      verifySaveRecord(broken);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveIntegrityError);
    const e = caught as SaveIntegrityError;
    expect(e.expectedChecksum).toBe(record.integrityChecksum);
    expect(e.actualChecksum).toBe(computeIntegrityChecksum(broken.payload));
  });

  it("エンベロープ版が違えば PersistenceError(黙って読まない)", () => {
    expect(() =>
      verifySaveRecord({
        saveFormatVersion: SAVE_FORMAT_VERSION + 1,
        integrityChecksum: record.integrityChecksum,
        payload: record.payload,
      }),
    ).toThrow(PersistenceError);
  });

  it("payload が文字列でなければ PersistenceError(オブジェクト直入れを拒む)", () => {
    expect(() =>
      verifySaveRecord({
        saveFormatVersion: SAVE_FORMAT_VERSION,
        integrityChecksum: 0,
        payload: toSerializable(STATE),
      }),
    ).toThrow(PersistenceError);
  });

  it("checksum が uint32 でなければ PersistenceError", () => {
    for (const bad of [-1, 1.5, 0x1_0000_0000, "0", null]) {
      expect(() => verifySaveRecord(tamperChecksum(record, bad))).toThrow(PersistenceError);
    }
  });

  it("オブジェクトでなければ PersistenceError", () => {
    for (const bad of [null, undefined, 42, "text", [1, 2]]) {
      expect(() => verifySaveRecord(bad)).toThrow(PersistenceError);
    }
  });

  it("SaveIntegrityError は PersistenceError の一種(呼び出し側が一括で捕まえられる)", () => {
    expect(new SaveIntegrityError("x", 1, 2)).toBeInstanceOf(PersistenceError);
  });

  it("[M54] SaveNotFoundError は PersistenceError の一種だが、名前で他の破損と区別できる", () => {
    const notFound = new SaveNotFoundError("x");
    expect(notFound).toBeInstanceOf(PersistenceError);
    expect(notFound.name).toBe("SaveNotFoundError");
    // 「セーブは無い」と「セーブはあったが読めなかった」は main.tsx の
    // loadOrCreateState が instanceof で分岐する(ロードマップ M54 行)。
    expect(new SaveIntegrityError("x", 1, 2)).not.toBeInstanceOf(SaveNotFoundError);
  });
});

function tamperChecksum(record: SaveRecord, checksum: unknown): unknown {
  return {
    saveFormatVersion: record.saveFormatVersion,
    integrityChecksum: checksum,
    payload: record.payload,
  };
}

// --- 4. 往復 ---------------------------------------------------------------

describe("decodeSaveRecord(往復)", () => {
  it("state → レコード → state でバイト同一に戻る", () => {
    const record = encodeSaveRecord(STATE);
    const restored = decodeSaveRecord(record);
    expect(JSON.stringify(toSerializable(restored))).toBe(record.payload);
    expect(encodeSaveRecord(restored).integrityChecksum).toBe(record.integrityChecksum);
  });

  it("entity の反復順(ID 昇順)が保たれる", () => {
    const restored = decodeSaveRecord(encodeSaveRecord(STATE));
    expect([...restored.entityStateById.keys()]).toEqual([...STATE.entityStateById.keys()]);
    expect([...restored.entityStateById.keys()]).toEqual(
      [...restored.entityStateById.keys()].sort(),
    );
  });

  it("meta 3 軸と tick が保たれる", () => {
    const restored = decodeSaveRecord(encodeSaveRecord(STATE));
    expect(restored.saveSchemaVersion).toBe(STATE.saveSchemaVersion);
    expect(restored.contentVersion).toBe(STATE.contentVersion);
    expect(restored.algoVersion).toBe(STATE.algoVersion);
    expect(restored.worldSeed).toBe(STATE.worldSeed);
    expect(restored.tick).toBe(STATE.tick);
  });
});

// --- 5. 定数(実アプリと bench で共有される名前) --------------------------

describe("定数", () => {
  it("DB/ストア/キーの既定名が定義されている", () => {
    expect(SAVE_DB_NAME).toBe("kept-flame");
    expect(SAVE_STORE_NAME).toBe("saves");
    expect(LATEST_SAVE_KEY).toBe("latest");
  });
});

// ---------------------------------------------------------------------------
// 6. [台帳v26 必-1] savedAtMs(起動時オフライン復帰の材料・persistence.ts §4)
//
// 起動時にブラウザを閉じていた時間を埋めるための唯一の材料が、このエンベロープ
// フィールドである。ここが固定するのは 3 点:
//   (a) 書いた壁時計時刻が往復で保存される(IDB の構造化複製でも JSON でも)
//   (b) **既存セーブが読めなくなっていない**: フィールドを持たない旧エンベロープ
//       はそのまま読め、`savedAtMs` は「不明 = null」になる(= 経過 0 =
//       台帳v26 必-1 以前と同一挙動)。読めない値でも例外にしない
//   (c) **checksum の対象は payload だけのまま**(§2/§4(b))。savedAtMs を
//       足しても払っても payload バイト列も checksum も 1 bit も動かない
//       —— golden vector / セーブ正準化 / export テキストへの波及がゼロである
//       ことの機械的な証明になる。
//
// IDB そのもの(= `saveGameState` が壁時計を 1 回読む経路)は Node に無いので
// ここでは扱わない(このファイルの冒頭方針どおり)。壁時計を読む場所が
// `saveGameState` 1 箇所に閉じていることは `encodeSaveRecord` が**純関数のまま**
// である(下の「渡さなければキーごと存在しない」)ことで担保する。
// ---------------------------------------------------------------------------

/** 固定のエポック ms(2025-08-01T00:00:00Z 付近)。実時刻に依存させない。 */
const SAVED_AT_MS = 1_754_000_000_000;

/** savedAtMs だけを差し替えた**未検証の**エンベロープを作る(`tamperChecksum` と同型)。 */
function withSavedAtMs(record: SaveRecord, savedAtMs: unknown): unknown {
  return {
    saveFormatVersion: record.saveFormatVersion,
    integrityChecksum: record.integrityChecksum,
    payload: record.payload,
    savedAtMs,
  };
}

describe("[台帳v26 必-1] savedAtMs", () => {
  it("渡さなければキーごと存在しない(encodeSaveRecord は時計に触れない純関数)", () => {
    const record = encodeSaveRecord(STATE);
    expect(record.savedAtMs).toBeUndefined();
    // export テキスト(exchange.ts)はこの形をそのまま stringify する。
    expect(JSON.stringify(record)).not.toContain("savedAtMs");
  });

  it("渡せばエンベロープに載り、往復して読み戻せる", () => {
    const record = encodeSaveRecord(STATE, { savedAtMs: SAVED_AT_MS });
    expect(record.savedAtMs).toBe(SAVED_AT_MS);
    // IDB は構造化複製・export は JSON 文字列。どちらの往復でも生き残る。
    expect(readSavedAtMs(JSON.parse(JSON.stringify(record)))).toBe(SAVED_AT_MS);
  });

  it("payload も checksum も savedAtMs の有無で 1 bit も変わらない(§4(a)(b))", () => {
    const without = encodeSaveRecord(STATE);
    const withStamp = encodeSaveRecord(STATE, { savedAtMs: SAVED_AT_MS });
    expect(withStamp.payload).toBe(without.payload);
    expect(withStamp.integrityChecksum).toBe(without.integrityChecksum);
    expect(withStamp.saveFormatVersion).toBe(SAVE_FORMAT_VERSION);
  });

  it("checksum の対象は payload のみ = savedAtMs を書き換えても検証は通る", () => {
    const record = encodeSaveRecord(STATE, { savedAtMs: SAVED_AT_MS });
    expect(verifySaveRecord(withSavedAtMs(record, SAVED_AT_MS + 999_999))).toBe(record.payload);
  });

  it("旧エンベロープ(savedAtMs 無し)はそのまま読め、経過は「不明」になる", () => {
    // 台帳v26 必-1 以前のビルドが書いたレコードと同じ形。
    const legacy = encodeSaveRecord(STATE);
    expect(verifySaveRecord(legacy)).toBe(legacy.payload);
    expect(readSavedAtMs(legacy)).toBeNull();
    expect(decodeSaveRecord(legacy).tick).toBe(STATE.tick);
  });

  it("読めない savedAtMs は例外でなく null(checksum 外の未検証値・§4(b))", () => {
    const record = encodeSaveRecord(STATE);
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
      "0",
      null,
      undefined,
      {},
    ]) {
      expect(readSavedAtMs(withSavedAtMs(record, bad))).toBeNull();
    }
    for (const bad of [null, undefined, 42, "text", [1, 2]]) {
      expect(readSavedAtMs(bad)).toBeNull();
    }
  });

  it("savedAtMs が壊れていてもセーブは失われない(1 フィールドに拒否権を与えない)", () => {
    const broken = withSavedAtMs(encodeSaveRecord(STATE), Number.NaN);
    expect(decodeSaveRecord(broken).tick).toBe(STATE.tick);
    expect(readSavedAtMs(broken)).toBeNull();
  });

  it("書込側は狭い: エポック ms(0 以上の安全整数)でなければ止める", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
      expect(() => encodeSaveRecord(STATE, { savedAtMs: bad })).toThrow(PersistenceError);
    }
    expect(() => encodeSaveRecord(STATE, { savedAtMs: 0 })).not.toThrow();
  });

  it("savedAtMs を載せても復元される state は同一(decodeSaveRecord は見ない)", () => {
    const record = encodeSaveRecord(STATE, { savedAtMs: SAVED_AT_MS });
    const restored = decodeSaveRecord(record);
    expect(JSON.stringify(toSerializable(restored))).toBe(record.payload);
    expect([...restored.entityStateById.keys()]).toEqual([...STATE.entityStateById.keys()]);
  });
});
