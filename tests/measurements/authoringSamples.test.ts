import { describe, expect, it } from "vitest";

import { loadEngineContent } from "../../schema/engineContent";
import { checkGlobalIdUniqueness } from "../../schema/idRegistry";
import { validateEvent } from "../../schema/event";
import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import eventSample from "../../docs/measurements/authoring-samples/event.sample.json";
import facilitySample from "../../docs/measurements/authoring-samples/facility.sample.json";
import techSample from "../../docs/measurements/authoring-samples/tech.sample.json";

// 先行計測 #12 再計測(2026-07-27・タイムスタンプ実測版)のサンプル。
// 既存サンプル(上記3本)とは別ファイルとして追加(上書き禁止)。
import eventSampleRetest from "../../docs/measurements/authoring-samples/event.sample.retest-2026-07-27.json";
import facilitySampleRetest from "../../docs/measurements/authoring-samples/facility.sample.retest-2026-07-27.json";
import techSampleRetest from "../../docs/measurements/authoring-samples/tech.sample.retest-2026-07-27.json";

// ---------------------------------------------------------------------------
// 先行計測 #12(エンティティ制作素工数の実測)の検証実測スクリプト兼テスト。
//
// `docs/measurements/authoring-samples/*.json` は本物の content/*.json ではない
// (content/*.json への追加は禁止・golden vector/conformance に影響させない
// ため)。ただし検証そのものは本物の検証器で行う: 既存 content とメモリ上で
// マージし、tech/facility は schema 検証 → engine 内部表現ロードまで通す。
// event は engine 未接続(schema/event.ts 冒頭コメント参照)なのでスタンド
// アロンの `validateEvent()` のみで検証する。
// ---------------------------------------------------------------------------

function mergedRawBundle(): RawContentBundle {
  return {
    tech: [...techJson, techSample],
    facility: [...facilityJson, facilitySample],
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

describe("authoring-samples — tech.sample.json", () => {
  it("既存 content とマージして validateContentBundle を通る", () => {
    const result = validateContentBundle(mergedRawBundle());
    if (!result.ok) {
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tech.some((t) => t.id === "techCordage")).toBe(true);
    }
  });

  it("既存 content とマージして loadEngineContent(engine 内部表現ロード)を通る", () => {
    const bundleResult = validateContentBundle(mergedRawBundle());
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;
    const engineResult = loadEngineContent(bundleResult.value);
    if (!engineResult.ok) {
      expect(engineResult.issues).toEqual([]);
    }
    expect(engineResult.ok).toBe(true);
    if (engineResult.ok) {
      expect(engineResult.value.techDefs.has("techCordage" as never)).toBe(true);
    }
  });
});

describe("authoring-samples — facility.sample.json", () => {
  it("既存 content とマージして validateContentBundle を通る", () => {
    const result = validateContentBundle(mergedRawBundle());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facility.some((f) => f.id === "garden")).toBe(true);
    }
  });

  it("既存 content とマージして loadEngineContent(engine 内部表現ロード)を通る", () => {
    const bundleResult = validateContentBundle(mergedRawBundle());
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;
    const engineResult = loadEngineContent(bundleResult.value);
    expect(engineResult.ok).toBe(true);
    if (engineResult.ok) {
      expect(engineResult.value.facilityDefs.has("garden" as never)).toBe(true);
    }
  });
});

describe("authoring-samples — event.sample.json", () => {
  it("validateEvent(スタンドアロン検証)を通る", () => {
    const result = validateEvent(eventSample);
    if (!result.ok) {
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("eventNearRubbleField");
      expect(result.value.nodes).toHaveLength(4);
    }
  });

  it("ID がグローバル一意性チェックにも通る(event は ContentBundle 非組込みのため手動確認)", () => {
    // event は schema/event.ts 冒頭コメントの通り ContentBundle に組み込んでいない。
    // ここでは checkGlobalIdUniqueness を直接呼び、既存カテゴリと衝突しないことを
    // 手順書(authoring-procedure.md §6)通りに再現する。
    const issues = checkGlobalIdUniqueness({
      tech: [...techJson.map((t) => t.id), techSample.id],
      facility: [...facilityJson.map((f) => f.id), facilitySample.id],
      trait: traitJson.map((t) => t.id),
      event: [eventSample.id],
    });
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 先行計測 #12 再計測(2026-07-27)分。手順書 §9 のタイムスタンプ打刻を伴う
// 別セッションでの実施(docs/measurements/authoring-times-retest-2026-07-27.md
// 参照)。既存サンプルとは独立に検証する(本物 content との2本立てマージ)。
// ---------------------------------------------------------------------------

function mergedRawBundleRetest(): RawContentBundle {
  return {
    tech: [...techJson, techSampleRetest],
    facility: [...facilityJson, facilitySampleRetest],
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

describe("authoring-samples — tech.sample.retest-2026-07-27.json", () => {
  it("既存 content とマージして validateContentBundle を通る", () => {
    const result = validateContentBundle(mergedRawBundleRetest());
    if (!result.ok) {
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tech.some((t) => t.id === "techSimpleBedding")).toBe(true);
    }
  });

  it("既存 content とマージして loadEngineContent(engine 内部表現ロード)を通る", () => {
    const bundleResult = validateContentBundle(mergedRawBundleRetest());
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;
    const engineResult = loadEngineContent(bundleResult.value);
    if (!engineResult.ok) {
      expect(engineResult.issues).toEqual([]);
    }
    expect(engineResult.ok).toBe(true);
    if (engineResult.ok) {
      expect(engineResult.value.techDefs.has("techSimpleBedding" as never)).toBe(true);
    }
  });
});

describe("authoring-samples — facility.sample.retest-2026-07-27.json", () => {
  it("既存 content とマージして validateContentBundle を通る", () => {
    const result = validateContentBundle(mergedRawBundleRetest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facility.some((f) => f.id === "reservoir")).toBe(true);
    }
  });

  it("既存 content とマージして loadEngineContent(engine 内部表現ロード)を通る", () => {
    const bundleResult = validateContentBundle(mergedRawBundleRetest());
    expect(bundleResult.ok).toBe(true);
    if (!bundleResult.ok) return;
    const engineResult = loadEngineContent(bundleResult.value);
    expect(engineResult.ok).toBe(true);
    if (engineResult.ok) {
      expect(engineResult.value.facilityDefs.has("reservoir" as never)).toBe(true);
    }
  });
});

describe("authoring-samples — event.sample.retest-2026-07-27.json", () => {
  it("validateEvent(スタンドアロン検証)を通る", () => {
    const result = validateEvent(eventSampleRetest);
    if (!result.ok) {
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("eventNearOldCistern");
      expect(result.value.nodes).toHaveLength(4);
    }
  });

  it("ID がグローバル一意性チェックにも通る(event は ContentBundle 非組込みのため手動確認)", () => {
    const issues = checkGlobalIdUniqueness({
      tech: [...techJson.map((t) => t.id), techSample.id, techSampleRetest.id],
      facility: [...facilityJson.map((f) => f.id), facilitySample.id, facilitySampleRetest.id],
      trait: traitJson.map((t) => t.id),
      event: [eventSample.id, eventSampleRetest.id],
    });
    expect(issues).toEqual([]);
  });
});

describe("authoring-samples — content/*.json 不変性の確認", () => {
  // このテストの目的は「#12 の計測サンプルが本物の content へ紛れ込んでいないこと」
  // であって content を凍結することではない。よって**正当な additive 追加が入ったら
  // 期待値を更新する**(件数固定の強度は落とさない)。
  //   T6/T7 時点: tech 3 / facility 3 / trait 2
  //   M6:         tech 24(E1〜E3・GDD 5.2)。facility / trait は据え置き。
  //   M7:         trait 8(GDD 7.2 の MVP 8 種)。facility は据え置き(14 種は別タスク)。
  it("本物の content/*.json の規模が想定どおり(計測サンプルが混入していない)", () => {
    expect(techJson).toHaveLength(24);
    expect(facilityJson).toHaveLength(3);
    expect(traitJson).toHaveLength(8);
    // 計測サンプルの ID が本物側へ混入していないこと(このテストの本来の関心事)。
    const techIds = new Set(techJson.map((t) => t.id));
    expect(techIds.has(techSample.id)).toBe(false);
    expect(techIds.has(techSampleRetest.id)).toBe(false);
  });
});
