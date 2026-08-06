import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";
import { validateFacility } from "../../schema/facility";
import { toRaw } from "../../src/engine/fp";
import { entityIdFromString } from "../../src/engine/state/state";
import type { EngineContent } from "../../src/engine/rules/types";

// ---------------------------------------------------------------------------
// M50: facility の建設 / 増築コスト(GDD 12.1 [2026-07-30裁定])の
// 「**schema では省略可・ローダーでは必須**」二段構え(T7 方式)の検証。
//
// 二段であること自体がテストの主題である:
//   - `validateFacility`(schema 段)は buildCost / upgradeCostCurve が無くても通る
//     → 既存 content・既存テスト(#12 の計測サンプルを含む)を壊さない
//   - `loadEngineContent`(ローダー段)は欠落を reject する
//     → 「無料で建つ施設」が content の書き忘れとして静かに成立しない
// ---------------------------------------------------------------------------

function rawBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function load(bundle: RawContentBundle): EngineContent {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  }
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) {
    throw new Error(`ロードで落ちた: ${JSON.stringify(loaded.issues)}`);
  }
  return loaded.value;
}

/** 検証 or ロードで出た issue の path 一覧(どちらで落ちても拾う)。 */
function issuePaths(bundle: RawContentBundle): readonly string[] {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) return validated.issues.map((issue) => issue.path);
  const loaded = loadEngineContent(validated.value);
  return loaded.ok ? [] : loaded.issues.map((issue) => issue.path);
}

/** facility content の 1 件を書き換えたバンドル。 */
function withFacility(
  facilityId: string,
  update: (entry: Record<string, unknown>) => Record<string, unknown>,
): RawContentBundle {
  const bundle = rawBundle();
  const facilities = clone(bundle.facility) as Record<string, unknown>[];
  const next = facilities.map((entry) => (entry["id"] === facilityId ? update(entry) : entry));
  return { ...bundle, facility: next };
}

function withoutKey(entry: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const name of Object.keys(entry)) {
    if (name !== key) copy[name] = entry[name];
  }
  return copy;
}

const VALID_FACILITY = {
  id: "shed",
  tags: ["calm"],
  slots: { lv1: 1, lv2: 1, lv3: 2, lv4: 2, lv5: 3 },
  lvCurve: [10, 11.5, 13.225, 15.20875, 17.4900625],
  overflowCapPolicy: "discardExcess",
  footprint: { width: 1, height: 1 },
  harshWork: false,
  output: { kind: "resource", resourceId: "firewood" },
};

describe("[M50] facility の建設/増築コスト — schema 段(省略可)", () => {
  it("buildCost / upgradeCostCurve が無くても validateFacility は通る(二段構えの前段)", () => {
    const result = validateFacility(VALID_FACILITY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toBeNull();
    expect(result.value.upgradeCostCurve).toBeNull();
  });

  it("指定すればそのまま写る", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "clay", amount: 25 },
      upgradeCostCurve: [30, 36, 43.2, 51.84, 62.208],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toEqual({ resourceId: "clay", amount: 25 });
    expect(result.value.upgradeCostCurve).toEqual([30, 36, 43.2, 51.84, 62.208]);
  });

  it("upgradeCostCurve の長さが 5 でなければ reject", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "clay", amount: 25 },
      upgradeCostCurve: [30, 36],
    });
    expect(result.ok).toBe(false);
  });

  it("upgradeCostCurve が単調非減少でなければ reject(Lv を上げて安くならない)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "clay", amount: 25 },
      upgradeCostCurve: [30, 20, 43.2, 51.84, 62.208],
    });
    expect(result.ok).toBe(false);
  });

  it("buildCost.amount が負なら reject", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "clay", amount: -1 },
      upgradeCostCurve: [30, 36, 43.2, 51.84, 62.208],
    });
    expect(result.ok).toBe(false);
  });

  it("buildCost.resourceId が ID 規則に反すれば reject", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "9bad id", amount: 1 },
      upgradeCostCurve: [30, 36, 43.2, 51.84, 62.208],
    });
    expect(result.ok).toBe(false);
  });
});

describe("[M50] facility の建設/増築コスト — ローダー段(必須)", () => {
  it("実 content は 3 施設すべてがコストを持ち、1e6 固定小数点へ厳密変換される", () => {
    const content = load(rawBundle());
    for (const def of content.facilityDefs.values()) {
      expect(def.cost).toBeDefined();
      expect(def.cost?.upgradeByLevel).toHaveLength(5);
    }
    const cost = content.facilityDefs.get(entityIdFromString("hearth"))?.cost;
    if (cost === undefined) throw new Error("hearth のコスト定義が写っていない");
    expect(cost.resourceId).toBe(entityIdFromString("firewood"));
    expect(toRaw(cost.buildFix)).toBe(30_000_000);
    // upgradeCostCurve[0] = 36(Lv1 → Lv2)。小数を含む段も厳密に写る。
    const lv1to2 = cost.upgradeByLevel[0];
    const lv5 = cost.upgradeByLevel[4];
    if (lv1to2 === undefined || lv5 === undefined) throw new Error("Lv 別増築コストが欠けている");
    expect(toRaw(lv1to2)).toBe(36_000_000);
    expect(toRaw(lv5)).toBe(75_000_000); // [M39] 端数を整数へ丸めた(ロードマップ M39 ⑬)
  });

  it("buildCost 欠落を reject する(欠落を既定値で埋めない)", () => {
    const paths = issuePaths(withFacility("hearth", (f) => withoutKey(f, "buildCost")));
    expect(paths).toContain("facility.hearth.buildCost");
  });

  it("upgradeCostCurve 欠落を reject する", () => {
    const paths = issuePaths(withFacility("hearth", (f) => withoutKey(f, "upgradeCostCurve")));
    expect(paths).toContain("facility.hearth.buildCost");
  });

  it("片方だけの指定も reject する(建設は有料だが増築は無料、を静かに作らせない)", () => {
    const validated = validateContentBundle(
      withFacility("forge", (f) => withoutKey(f, "upgradeCostCurve")),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const loaded = loadEngineContent(validated.value);
    expect(loaded.ok).toBe(false);
  });

  it("1e6 で表現できない値(小数第7位)は reject する(T7 の 6 桁規律)", () => {
    const paths = issuePaths(
      withFacility("hearth", (f) => ({
        ...f,
        buildCost: { resourceId: "firewood", amount: 1.0000001 },
      })),
    );
    expect(paths).toContain("facility.hearth.buildCost.amount");
  });
});

// ---------------------------------------------------------------------------
// [M65] buildCost の複数資源化(2026-08-06裁定・ロードマップ M65)。
// schema/facility.ts 冒頭 [M65] の規約 —— 第1行は増築カーブを持てず、
// 第2行以降は必須、資源 ID は重複禁止 —— と、単一形の後方互換を固定する。
// ---------------------------------------------------------------------------

describe("[M65] buildCost の複数資源化 — schema 段", () => {
  it("単一形は M50 と同じ形のまま写る(後方互換)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: { resourceId: "clay", amount: 25 },
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toEqual({ resourceId: "clay", amount: 25 });
  });

  it("配列形は行ごとに写る(第1行は upgradeCostCurve が null)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: [
        { resourceId: "clay", amount: 25 },
        { resourceId: "charcoal", amount: 6, upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buildCost).toEqual([
      { resourceId: "clay", amount: 25, upgradeCostCurve: null },
      { resourceId: "charcoal", amount: 6, upgradeCostCurve: [7, 8, 10, 12, 14] },
    ]);
  });

  it("第1行が upgradeCostCurve を持つと reject(費用の出所が 2 箇所になる)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: [{ resourceId: "clay", amount: 25, upgradeCostCurve: [30, 36, 43, 52, 62] }],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(false);
  });

  it("第2行に upgradeCostCurve が無いと reject(増築だけ無料の書き忘れを止める)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: [
        { resourceId: "clay", amount: 25 },
        { resourceId: "charcoal", amount: 6 },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(false);
  });

  it("同じ資源が 2 行あると reject", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: [
        { resourceId: "clay", amount: 25 },
        { resourceId: "clay", amount: 6, upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(false);
  });

  it("空配列は reject(無料と区別できない)", () => {
    const result = validateFacility({
      ...VALID_FACILITY,
      buildCost: [],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(result.ok).toBe(false);
  });
});

describe("[M65] buildCost の複数資源化 — ローダー段", () => {
  it("実 content の forge が第2行(木炭)を持ち、engine 表現へ写る", () => {
    const content = load(rawBundle());
    const cost = content.facilityDefs.get(entityIdFromString("forge"))?.cost;
    if (cost === undefined) throw new Error("forge のコスト定義が無い");
    // 第1行(主資源)は M50 のまま平置き。
    expect(cost.resourceId).toBe(entityIdFromString("clay"));
    expect(toRaw(cost.buildFix)).toBe(25_000_000);
    const extra = cost.extraLines?.[0];
    if (extra === undefined) throw new Error("forge の追加コスト行が無い");
    expect(extra.resourceId).toBe(entityIdFromString("charcoal"));
    expect(toRaw(extra.buildFix)).toBe(6_000_000);
    expect(extra.upgradeByLevel.map((fix) => toRaw(fix))).toEqual([
      7_000_000, 8_000_000, 10_000_000, 12_000_000, 14_000_000,
    ]);
  });

  it("単一資源の施設は extraLines を持たない(M50 と同一表現)", () => {
    const content = load(rawBundle());
    const cost = content.facilityDefs.get(entityIdFromString("hearth"))?.cost;
    if (cost === undefined) throw new Error("hearth のコスト定義が無い");
    expect(cost.extraLines).toBeUndefined();
  });

  it("配列形でも 1e6 で表現できない値は reject する", () => {
    const paths = issuePaths(
      withFacility("hearth", (f) => ({
        ...f,
        buildCost: [
          { resourceId: "firewood", amount: 30 },
          { resourceId: "charcoal", amount: 1.0000001, upgradeCostCurve: [1, 1, 1, 1, 1] },
        ],
      })),
    );
    expect(paths).toContain("facility.hearth.buildCost[1].amount");
  });
});
