// ---------------------------------------------------------------------------
// M3: `src/platform/migration.ts`(セーブのマイグレーション連鎖)のテスト。
//
// このファイルが固定するのは 3 つ:
//   (1) **旧形式(エンベロープ化以前の生 payload)セーブのロード回帰** —
//       裁定 B2/B3/B4 の 3 点(checksum の移動 / eventQueueSnapshot 非保持 /
//       空 rngState の省略)が migration でも守られること。
//   (2) **checksum 改竄の検出** — migration を通した経路でも payload の 1 文字
//       改変が SaveIntegrityError になること。
//   (3) 連鎖そのものの規律(1 段 = +1 版・欠番禁止・未来版は直さない)。
//
// IndexedDB は Node に無いので、ここで扱うのは純関数部だけである
// (`tests/platform/persistence.test.ts` の方針を踏襲)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { DOMAIN_TAGS } from "../../src/engine/rng/domainTags";
import { toSerializable } from "../../src/engine/state/serialize";
import type { GameState } from "../../src/engine/state/state";
import { createGameState } from "../../src/engine/state/update";
import {
  assertMigrationChain,
  detectSaveFormatVersion,
  ENVELOPE_MIGRATIONS,
  LEGACY_ENVELOPE_VERSION,
  migrateSavePayload,
  migrateStoredSave,
  PAYLOAD_MIGRATIONS,
  SAVE_FORMAT_VERSION,
  SAVE_SCHEMA_VERSION,
  SaveMigrationError,
  type SaveMigrationStep,
} from "../../src/platform/migration";
import {
  computeIntegrityChecksum,
  decodeSaveRecord,
  encodeSaveRecord,
  PersistenceError,
  SaveIntegrityError,
} from "../../src/platform/persistence";

import {
  facility,
  HEARTH,
  id,
  META,
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

/** rngState を実際に持つ state(B4 の「空でないなら書く」側)。 */
const STATE_WITH_RNG: GameState = createGameState(
  META,
  [...STATE.entityStateById.values()],
  [[DOMAIN_TAGS.recallDuration, [1, 2, 3, 4]]],
);

/** JSON 往復でプレーン値にした直列化形(= IDB に入っていた生の値の再現)。 */
function plainSerialized(state: GameState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(toSerializable(state))) as Record<string, unknown>;
}

/**
 * エンベロープ化以前(v0)のセーブを組み立てる。
 *
 * 旧記述(ADR 改訂前)の形をそのまま作る = payload 文書と同じ階層に
 * `integrityChecksum` が居て、`eventQueueSnapshot` を持ち、RNG 未使用でも
 * `rngState: {}` を書いていた、という 3 点。
 *
 * キーは**降順**で差し込む。正準化が効いていなければ payload のバイト列が
 * 現行形式と一致しないので、これだけで正準化の有無を検出できる。
 */
function legacySave(
  state: GameState,
  extras: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const doc = plainSerialized(state);
  const merged: Record<string, unknown> = {
    ...doc,
    integrityChecksum: 123456,
    eventQueueSnapshot: [{ tick: 3, kind: "researchComplete" }],
    ...extras,
  };
  const shuffled: Record<string, unknown> = {};
  for (const key of Object.keys(merged).sort().reverse()) {
    shuffled[key] = merged[key];
  }
  return shuffled;
}

// --- 1. 版の判定 ------------------------------------------------------------

describe("detectSaveFormatVersion", () => {
  it("エンベロープは自分の版を名乗る", () => {
    expect(detectSaveFormatVersion(encodeSaveRecord(STATE))).toBe(SAVE_FORMAT_VERSION);
  });

  it("生 payload 文書(entityStateById を持つ)は v0", () => {
    expect(detectSaveFormatVersion(legacySave(STATE))).toBe(LEGACY_ENVELOPE_VERSION);
  });

  it("現行より新しい版もそのまま読む(拒否は verifySaveRecord の仕事)", () => {
    expect(
      detectSaveFormatVersion({ saveFormatVersion: SAVE_FORMAT_VERSION + 1, payload: "{}" }),
    ).toBe(SAVE_FORMAT_VERSION + 1);
  });

  it("目印が無い値は v0 と見なさず拒否する", () => {
    expect(() => detectSaveFormatVersion({})).toThrow(SaveMigrationError);
    expect(() => detectSaveFormatVersion({ someOtherApp: true })).toThrow(SaveMigrationError);
  });

  it("オブジェクトでなければ拒否する", () => {
    for (const bad of [null, undefined, 42, "text", [1, 2]]) {
      expect(() => detectSaveFormatVersion(bad)).toThrow(SaveMigrationError);
    }
  });

  it("版が 0 以上の整数でなければ拒否する", () => {
    for (const bad of [-1, 1.5, "1", null, Number.NaN]) {
      expect(() => detectSaveFormatVersion({ saveFormatVersion: bad })).toThrow(SaveMigrationError);
    }
  });
});

// --- 2. 旧形式セーブのロード回帰(検収条件) --------------------------------

describe("v0 → v1(エンベロープ化)", () => {
  it("旧形式セーブが現行形式へ移行され、現行ビルドが書いたのとバイト同一になる", () => {
    const migrated = migrateStoredSave(legacySave(STATE));
    expect(migrated.fromVersion).toBe(0);
    expect(migrated.appliedSteps).toHaveLength(1);

    const record = migrated.value as { payload: string; integrityChecksum: number };
    const current = encodeSaveRecord(STATE);
    expect(record.payload).toBe(current.payload);
    expect(record.integrityChecksum).toBe(current.integrityChecksum);
    expect(record.integrityChecksum).toBe(computeIntegrityChecksum(record.payload));
  });

  it("旧形式セーブから GameState が復元できる(ロード回帰)", () => {
    const restored = decodeSaveRecord(legacySave(STATE));
    expect([...restored.entityStateById.keys()]).toEqual([...STATE.entityStateById.keys()]);
    expect(restored.tick).toBe(STATE.tick);
    expect(restored.worldSeed).toBe(STATE.worldSeed);
    expect(restored.saveSchemaVersion).toBe(STATE.saveSchemaVersion);
    expect(JSON.stringify(toSerializable(restored))).toBe(encodeSaveRecord(STATE).payload);
  });

  it("[B2] integrityChecksum は payload から消えてエンベロープ側にだけ居る", () => {
    const record = migrateStoredSave(legacySave(STATE)).value as { payload: string };
    expect(record.payload).not.toContain("integrityChecksum");
  });

  it("[B3] eventQueueSnapshot は落とされる(state から再構成する)", () => {
    const record = migrateStoredSave(legacySave(STATE)).value as { payload: string };
    expect(record.payload).not.toContain("eventQueueSnapshot");
  });

  it("[B4] 空の rngState はキーごと落とされる", () => {
    const record = migrateStoredSave(legacySave(STATE, { rngState: {} })).value as {
      payload: string;
    };
    expect(record.payload).not.toContain("rngState");
    expect(record.payload).toBe(encodeSaveRecord(STATE).payload);
  });

  it("[B4] 空でない rngState は保たれる", () => {
    const record = migrateStoredSave(legacySave(STATE_WITH_RNG)).value as { payload: string };
    expect(record.payload).toContain("rngState");
    expect(record.payload).toBe(encodeSaveRecord(STATE_WITH_RNG).payload);
    const restored = decodeSaveRecord(legacySave(STATE_WITH_RNG));
    expect(restored.rngState.get(DOMAIN_TAGS.recallDuration)).toEqual([1, 2, 3, 4]);
  });

  it("キー順が乱れた旧セーブでも正準化されて同じバイト列になる", () => {
    // legacySave() は降順でキーを差し込む(= 現行の昇順とは逆)。
    const shuffled = legacySave(STATE);
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(shuffled).sort()[0]);
    const record = migrateStoredSave(shuffled).value as { payload: string };
    expect(record.payload).toBe(encodeSaveRecord(STATE).payload);
  });

  it("既知でない余分なキーは落とさない(意味を解釈しないという規律)", () => {
    const record = migrateStoredSave(legacySave(STATE, { futureField: 7 })).value as {
      payload: string;
    };
    expect(record.payload).toContain("futureField");
  });

  it("JSON にできない値が混ざった旧セーブは黙って通さない", () => {
    expect(() =>
      migrateStoredSave(legacySave(STATE, { broken: Number.POSITIVE_INFINITY })),
    ).toThrow();
  });

  it("v0 の integrityChecksum は検証しない(覆う範囲が定義されていなかったため)", () => {
    // 旧記述の checksum は「自分自身を含む文書」を覆うと書かれており、実際には
    // 成立していなかった(= 何を計算した値なのか定義が無い)。よって migration は
    // 旧 checksum を**信用も検証もせず捨て**、現行の定義で計算し直す。
    // その代わり「移行後の payload は必ず自分の checksum と整合する」が成り立つ。
    const record = migrateStoredSave(legacySave(STATE, { integrityChecksum: 0 })).value as {
      payload: string;
      integrityChecksum: number;
    };
    expect(record.integrityChecksum).toBe(computeIntegrityChecksum(record.payload));
  });
});

// --- 3. checksum 改竄の検出(検収条件) -------------------------------------

describe("checksum 改竄検出", () => {
  it("payload を 1 文字書き換えたエンベロープは SaveIntegrityError", () => {
    const record = encodeSaveRecord(STATE);
    const tampered = {
      saveFormatVersion: record.saveFormatVersion,
      integrityChecksum: record.integrityChecksum,
      payload: record.payload.replace('"tick":0', '"tick":1'),
    };
    expect(tampered.payload).not.toBe(record.payload);
    expect(() => decodeSaveRecord(tampered)).toThrow(SaveIntegrityError);
  });

  it("checksum だけを書き換えても SaveIntegrityError", () => {
    const record = encodeSaveRecord(STATE);
    expect(() =>
      decodeSaveRecord({
        saveFormatVersion: record.saveFormatVersion,
        integrityChecksum: (record.integrityChecksum ^ 1) >>> 0,
        payload: record.payload,
      }),
    ).toThrow(SaveIntegrityError);
  });

  it("移行を通った経路でも checksum は効く(移行後に payload を触れば検出)", () => {
    const migrated = migrateStoredSave(legacySave(STATE)).value as {
      saveFormatVersion: number;
      integrityChecksum: number;
      payload: string;
    };
    expect(() =>
      decodeSaveRecord({
        saveFormatVersion: migrated.saveFormatVersion,
        integrityChecksum: migrated.integrityChecksum,
        payload: `${migrated.payload} `,
      }),
    ).toThrow(SaveIntegrityError);
  });
});

// --- 4. 未来版は直さない ----------------------------------------------------

describe("未来版のセーブ", () => {
  it("エンベロープ版が未来なら変換せず、版不一致として拒否される", () => {
    const record = encodeSaveRecord(STATE);
    const future = {
      saveFormatVersion: SAVE_FORMAT_VERSION + 1,
      integrityChecksum: record.integrityChecksum,
      payload: record.payload,
    };
    const migrated = migrateStoredSave(future);
    expect(migrated.appliedSteps).toEqual([]);
    expect(migrated.value).toBe(future);
    expect(() => decodeSaveRecord(future)).toThrow(PersistenceError);
  });

  it("スキーマ版が未来なら migrateSavePayload が拒否する", () => {
    expect(() => migrateSavePayload({ saveSchemaVersion: SAVE_SCHEMA_VERSION + 1 })).toThrow(
      SaveMigrationError,
    );
  });
});

// --- 5. 連鎖の規律 ----------------------------------------------------------

describe("連鎖の規律", () => {
  const step = (from: number, to: number): SaveMigrationStep => ({
    from,
    to,
    summary: `${String(from)}→${String(to)}`,
    migrate: (value) => value,
  });

  it("登録済みの連鎖は終端が現行版と一致する", () => {
    expect(ENVELOPE_MIGRATIONS.at(-1)?.to).toBe(SAVE_FORMAT_VERSION);
    expect(() =>
      assertMigrationChain(ENVELOPE_MIGRATIONS, SAVE_FORMAT_VERSION, "saveFormatVersion"),
    ).not.toThrow();
    expect(() =>
      assertMigrationChain(PAYLOAD_MIGRATIONS, SAVE_SCHEMA_VERSION, "saveSchemaVersion"),
    ).not.toThrow();
  });

  it("欠番のある連鎖は登録時に拒否される", () => {
    expect(() => assertMigrationChain([step(0, 1), step(2, 3)], 3, "test")).toThrow(
      SaveMigrationError,
    );
  });

  it("1 段で 2 版跳ぶ連鎖は拒否される", () => {
    expect(() => assertMigrationChain([step(0, 2)], 2, "test")).toThrow(SaveMigrationError);
  });

  it("現行版より段が多い連鎖は拒否される", () => {
    expect(() => assertMigrationChain([step(0, 1), step(1, 2)], 1, "test")).toThrow(
      SaveMigrationError,
    );
  });
});

// --- 6. スキーマ版の軸(ADR 3軸(a)) ----------------------------------------

describe("migrateSavePayload", () => {
  it("現行版はそのまま通す(段が 1 つも走らない)", () => {
    const parsed = plainSerialized(STATE);
    const result = migrateSavePayload(parsed);
    expect(result.fromVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(result.appliedSteps).toEqual([]);
    expect(result.value).toBe(parsed);
  });

  it("版が無い / 整数でない payload は拒否する", () => {
    expect(() => migrateSavePayload({})).toThrow(SaveMigrationError);
    expect(() => migrateSavePayload({ saveSchemaVersion: "1" })).toThrow(SaveMigrationError);
    expect(() => migrateSavePayload("text")).toThrow(SaveMigrationError);
  });

  it("移行経路の無い旧版は黙って読まない", () => {
    // 現在 PAYLOAD_MIGRATIONS は空なので、v0 の payload は経路が無い = 停止する。
    expect(() => migrateSavePayload({ saveSchemaVersion: 0 })).toThrow(SaveMigrationError);
  });
});
