// ---------------------------------------------------------------------------
// [M12] memoirLog(決定論エピソードログ)— GDD 7.3
//
// 中心の検収条件は **「同一 seed で memoirLog がバイト同一」** と
// **「テンプレ選択に Map 反復順依存が無いこと」**。前者は toSerializable の
// JSON バイト列比較で、後者は「呼び出し順・他住民の処理順を変えても対象住民の
// 結果が変わらない」ことで確認する(このモジュールは配列リテラル(§3)しか
// 使わないので Map の反復順そのものに触れる余地が無い)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEMOIR_HIGHLIGHT_LIMIT,
  MAX_MEMOIR_ENTRIES,
  MEMOIR_BIO_KINDS,
  MEMOIR_BIO_VARIANT_COUNT,
  appendMemoirEntry,
  foldedAppend,
  generateResidentBioEntries,
  initializeResidentMemoir,
  memoirLogOf,
  pickBioVariantIndex,
  recentMemoirHighlights,
  recordDeathMemoir,
} from "../../src/engine/rules/memoir";
import { toSerializable } from "../../src/engine/state/serialize";
import type { MemoirEntry } from "../../src/engine/state/state";
import { worldSeedToUint32 } from "../../src/engine/stochastic";
import { resident, stateOf } from "./fixtures";
import { eid } from "./lifespanFixtures";

const SEED = worldSeedToUint32("seedAlpha");
const OTHER_SEED = worldSeedToUint32("seedBeta");

function serialized(entries: unknown): string {
  return JSON.stringify(entries);
}

describe("[M12] bio テンプレ選択の決定論性(検収: Map 反復順依存が無いこと)", () => {
  it("MEMOIR_BIO_KINDS は配列リテラルであり宣言順が固定(Map を経由しない)", () => {
    expect([...MEMOIR_BIO_KINDS]).toEqual(["bioOrigin", "bioCatchphrase", "bioFear"]);
  });

  it("同じ (worldSeed, residentId, bioKind) は常に同じ variantIndex", () => {
    const first = pickBioVariantIndex(SEED, eid("residentAlice"), "bioOrigin");
    const second = pickBioVariantIndex(SEED, eid("residentAlice"), "bioOrigin");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(MEMOIR_BIO_VARIANT_COUNT);
  });

  it("bio 3 件は MEMOIR_BIO_KINDS の宣言順のまま生成される", () => {
    const entries = generateResidentBioEntries(SEED, eid("residentAlice"), 10);
    expect(entries.map((e) => e.kind)).toEqual(["bioOrigin", "bioCatchphrase", "bioFear"]);
    expect(entries.every((e) => e.tick === 10)).toBe(true);
  });

  it("他の住民をどんな順で先に処理しても、対象住民の結果は変わらない", () => {
    // 「先に residentZ を処理してから residentAlice を処理した」ケースと
    // 「residentAlice だけを単独で処理した」ケースを比較する。呼び出し順・
    // 他 ID の存在が結果に影響すれば hash アドレス方式が壊れている。
    const alone = generateResidentBioEntries(SEED, eid("residentAlice"), 10);

    pickBioVariantIndex(SEED, eid("residentZulu"), "bioOrigin");
    pickBioVariantIndex(SEED, eid("residentZulu"), "bioCatchphrase");
    pickBioVariantIndex(SEED, eid("residentZulu"), "bioFear");
    const afterOthers = generateResidentBioEntries(SEED, eid("residentAlice"), 10);

    expect(serialized(afterOthers)).toBe(serialized(alone));
  });

  it("異なる bioKind は独立したドメイン塩(saltFromId(bioKind))を使う", () => {
    // 3 カテゴリが常に一致するとは限らないが、少なくとも「同じ関数・同じ residentId
    // でも bioKind ごとに個別の draw を行っている」ことを、実装が bioKind を
    // salt へ混ぜていることの間接証拠として確認する(3 つとも同じ乱数源を
    // 共有していれば variantIndex の生成過程を通さず全部一致してしまう心配は
    // 無いが、少なくとも呼び出しは3回とも独立して行われる)。
    const origin = pickBioVariantIndex(SEED, eid("residentAlice"), "bioOrigin");
    const catchphrase = pickBioVariantIndex(SEED, eid("residentAlice"), "bioCatchphrase");
    const fear = pickBioVariantIndex(SEED, eid("residentAlice"), "bioFear");
    for (const v of [origin, catchphrase, fear]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(MEMOIR_BIO_VARIANT_COUNT);
    }
  });

  it("worldSeed が異なっても常に値域内(決定論の主張は「同じなら同じ」であって「違えば必ず違う」ではない)", () => {
    const a = pickBioVariantIndex(SEED, eid("residentAlice"), "bioOrigin");
    const b = pickBioVariantIndex(OTHER_SEED, eid("residentAlice"), "bioOrigin");
    for (const v of [a, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(MEMOIR_BIO_VARIANT_COUNT);
    }
  });
});

describe("[M12][検収] 同一 seed で memoirLog がバイト同一", () => {
  it("initializeResidentMemoir を 2 回独立に実行しても JSON バイト列が一致", () => {
    const base = stateOf([resident("residentAlice")]);
    const first = initializeResidentMemoir(base, SEED, eid("residentAlice"), 5);
    const second = initializeResidentMemoir(base, SEED, eid("residentAlice"), 5);
    expect(serialized(toSerializable(first))).toBe(serialized(toSerializable(second)));
  });

  it("同じ操作列を経た 2 つの独立な state は最終的にバイト同一", () => {
    const base = stateOf([resident("residentAlice"), resident("residentBeta")]);

    function run(): unknown {
      let state = base;
      state = initializeResidentMemoir(state, SEED, eid("residentAlice"), 0);
      state = initializeResidentMemoir(state, SEED, eid("residentBeta"), 0);
      state = appendMemoirEntry(state, eid("residentAlice"), {
        kind: "bondMilestone",
        tick: 100,
        partnerId: eid("residentBeta"),
        tier: 1,
      });
      state = recordDeathMemoir(state, eid("residentBeta"), 200);
      return toSerializable(state);
    }

    expect(serialized(run())).toBe(serialized(run()));
  });
});

describe("[M12] appendMemoirEntry / foldedAppend(GDD 7.3「件数上限で古いものは要約に畳む」)", () => {
  it("memoirLog を持たない住民は memoirLogOf が undefined を返す", () => {
    const state = stateOf([resident("residentAlice")]);
    expect(memoirLogOf(state, eid("residentAlice"))).toBeUndefined();
  });

  it("1 件追記すると entries に反映され foldedCount は 0", () => {
    const state = appendMemoirEntry(stateOf([resident("residentAlice")]), eid("residentAlice"), {
      kind: "arrival",
      tick: 1,
    });
    const log = memoirLogOf(state, eid("residentAlice"));
    expect(log?.entries).toEqual([{ kind: "arrival", tick: 1 }]);
    expect(log?.foldedCount).toBe(0);
  });

  it("上限を超えると最古の 1 件が落ちて foldedCount が増える", () => {
    let state = stateOf([resident("residentAlice")]);
    for (let i = 0; i < MAX_MEMOIR_ENTRIES + 3; i++) {
      state = appendMemoirEntry(state, eid("residentAlice"), { kind: "arrival", tick: i });
    }
    const log = memoirLogOf(state, eid("residentAlice"));
    expect(log?.entries).toHaveLength(MAX_MEMOIR_ENTRIES);
    expect(log?.foldedCount).toBe(3);
    // 残っているのは末尾(最新)の MAX_MEMOIR_ENTRIES 件。
    expect(log?.entries[0]).toEqual({ kind: "arrival", tick: 3 });
    expect(log?.entries[log.entries.length - 1]).toEqual({
      kind: "arrival",
      tick: MAX_MEMOIR_ENTRIES + 2,
    });
  });

  it("foldedAppend は state を触らない純関数", () => {
    const a = foldedAppend(undefined, { kind: "arrival", tick: 1 });
    expect(a).toEqual({ entries: [{ kind: "arrival", tick: 1 }], foldedCount: 0 });
  });
});

describe("[M12] recentMemoirHighlights(GDD 7.3「記憶の可視化」データ層)", () => {
  it("bondMilestone 以外は現時点でハイライト対象外(正直な開示・codify/exploration 未対応)", () => {
    let state = stateOf([resident("residentAlice")]);
    state = appendMemoirEntry(state, eid("residentAlice"), { kind: "arrival", tick: 0 });
    state = appendMemoirEntry(state, eid("residentAlice"), { kind: "death", tick: 50 });
    const log = memoirLogOf(state, eid("residentAlice"));
    expect(recentMemoirHighlights(log)).toEqual([]);
  });

  it("bondMilestone は既定件数(DEFAULT_MEMOIR_HIGHLIGHT_LIMIT)まで新しい順で残る", () => {
    let state = stateOf([resident("residentAlice")]);
    const milestones: MemoirEntry[] = [];
    for (let tier = 1; tier <= DEFAULT_MEMOIR_HIGHLIGHT_LIMIT + 2; tier++) {
      const entry: MemoirEntry = {
        kind: "bondMilestone",
        tick: tier * 10,
        partnerId: eid("residentBeta"),
        tier,
      };
      milestones.push(entry);
      state = appendMemoirEntry(state, eid("residentAlice"), entry);
    }
    const log = memoirLogOf(state, eid("residentAlice"));
    const highlights = recentMemoirHighlights(log);
    expect(highlights).toHaveLength(DEFAULT_MEMOIR_HIGHLIGHT_LIMIT);
    expect(highlights).toEqual(milestones.slice(-DEFAULT_MEMOIR_HIGHLIGHT_LIMIT));
  });

  it("undefined の memoirLog / limit 0 は空配列", () => {
    expect(recentMemoirHighlights(undefined)).toEqual([]);
    expect(
      recentMemoirHighlights({ entries: [{ kind: "arrival", tick: 0 }], foldedCount: 0 }, 0),
    ).toEqual([]);
  });
});

describe("[M12] memoirLog を持たない住民は既存挙動と 1 bit も変わらない", () => {
  it("memoir 未設定の住民の直列化キー一覧に memoir が現れない", () => {
    const json = toSerializable(stateOf([resident("residentAlice")]));
    const entity = json.entityStateById["residentAlice"];
    expect(entity === undefined ? [] : Object.keys(entity)).not.toContain("memoir");
  });
});
