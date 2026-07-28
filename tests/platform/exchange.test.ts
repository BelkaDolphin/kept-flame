// ---------------------------------------------------------------------------
// M4: `src/platform/exchange.ts`(エクスポート/インポート・ADR-012)のテスト。
//
// 検収条件(タスク定義): 「export→import 往復でバイト同一」「破損 import を
// 黙って通さないこと」の 2 点を直接固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { exportSaveText, importSaveText } from "../../src/platform/exchange";
import { SaveMigrationError } from "../../src/platform/migration";
import {
  computeIntegrityChecksum,
  encodeSaveRecord,
  PersistenceError,
  SaveBoundsError,
  SaveIntegrityError,
} from "../../src/platform/persistence";
import { toSerializable } from "../../src/engine/state/serialize";

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

// --- 1. エクスポート ---------------------------------------------------------

describe("exportSaveText", () => {
  it("エンベロープをそのまま JSON 化したもの(独自整形なし)", () => {
    const text = exportSaveText(STATE);
    expect(text).toBe(JSON.stringify(encodeSaveRecord(STATE)));
  });

  it("同じ state からは常に同じテキスト(決定論)", () => {
    expect(exportSaveText(STATE)).toBe(exportSaveText(STATE));
  });
});

// --- 2. 往復(バイト同一) ---------------------------------------------------

describe("export → import 往復", () => {
  it("state → テキスト → state → テキストでバイト同一", () => {
    const first = exportSaveText(STATE);
    const restored = importSaveText(first);
    const second = exportSaveText(restored);
    expect(second).toBe(first);
  });

  it("復元した state の内容(entity・meta・tick)が一致する", () => {
    const restored = importSaveText(exportSaveText(STATE));
    expect(JSON.stringify(toSerializable(restored))).toBe(JSON.stringify(toSerializable(STATE)));
    expect([...restored.entityStateById.keys()]).toEqual([...STATE.entityStateById.keys()]);
  });
});

// --- 3. 破損 import は黙って通さない ----------------------------------------

describe("importSaveText(破損は reject)", () => {
  it("JSON として読めないテキストは PersistenceError", () => {
    expect(() => importSaveText("これは json ではない")).toThrow(PersistenceError);
  });

  it("payload が改竄されていれば SaveIntegrityError(黙って直さない)", () => {
    const record = JSON.parse(exportSaveText(STATE)) as {
      saveFormatVersion: number;
      integrityChecksum: number;
      payload: string;
    };
    const tampered = { ...record, payload: `${record.payload} ` };
    expect(() => importSaveText(JSON.stringify(tampered))).toThrow(SaveIntegrityError);
  });

  it("整数のような無関係な JSON はエンベロープとして拒否される", () => {
    // decodeSaveRecord の最初の関門はエンベロープ版 migration(migrateStoredSave)
    // であり、オブジェクトでない値は PersistenceError ではなく
    // SaveMigrationError で止まる(migration.ts §0(i))。
    expect(() => importSaveText("42")).toThrow(SaveMigrationError);
  });

  it("空文字列は JSON parse エラーとして拒否される", () => {
    expect(() => importSaveText("")).toThrow(PersistenceError);
  });

  it("エンベロープの版が未来版なら拒否される(部分的に読める経路を塞ぐ)", () => {
    const record = JSON.parse(exportSaveText(STATE)) as {
      saveFormatVersion: number;
      integrityChecksum: number;
      payload: string;
    };
    const future = { ...record, saveFormatVersion: record.saveFormatVersion + 1 };
    expect(() => importSaveText(JSON.stringify(future))).toThrow(PersistenceError);
  });

  it("分岐木ノード上界を超えた import は SaveBoundsError(黙って通さない)", () => {
    // GameState は M21〜M23 まで dispatchSnapshots を持てない(state.ts §3)ため
    // exportSaveText 側では組み立てられない。ここでは「外部から来た改竄済み
    // テキスト」を模して payload に直接 dispatchSnapshots を注入し、
    // decodeSaveRecord(= importSaveText の検証経路)が saveBounds.test.ts と
    // 同じ上界検査を通ることを確認する(import は書込側と同じ検査を通る・
    // persistence.ts の設計どおり)。
    const envelope = JSON.parse(exportSaveText(STATE)) as {
      saveFormatVersion: number;
      payload: string;
    };
    const payloadObject = JSON.parse(envelope.payload) as Record<string, unknown>;
    const chain = (count: number): unknown => {
      let node: unknown = { nodeIndex: count - 1 };
      for (let i = count - 2; i >= 0; i--) node = { nodeIndex: i, choices: [node] };
      return node;
    };
    payloadObject["dispatchSnapshots"] = [
      { dispatchId: "d0", seed: "seedAlpha", resolvedTree: chain(17) },
    ];
    const tamperedPayload = JSON.stringify(payloadObject);
    const tamperedText = JSON.stringify({
      saveFormatVersion: envelope.saveFormatVersion,
      integrityChecksum: computeIntegrityChecksum(tamperedPayload),
      payload: tamperedPayload,
    });
    expect(() => importSaveText(tamperedText)).toThrow(SaveBoundsError);
  });
});
