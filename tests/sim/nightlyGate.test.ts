// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 夜間ゲート(M38)のテスト — GDD 11.4 / 11.6
//
// 検収条件(ロードマップ M38 行 / タスク指示):
//   ① GDD 11.4 の 11 条件がすべて assert として存在する
//   ② **全て不等式**である(bool 判定に化けていない = measured/threshold/
//      comparator の 3 点が必ず揃い、status がその 3 点から機械的に導かれる)
//   ③ 各 assert が実測値と閾値の**両方**をログ(JSON)に出す
//   ④ 検証不能なものは捏造せず理由 + 解消条件を持つ
//   ⑤ 同一 options でバイト同一(決定論・elapsed 系を持たない)
//
// run 長は縮めてある(quick プロファイルよりさらに小さい明示指定)。夜間ゲート
// 本体の値は `npm run sim:nightly-gate` の出力(sim/output/nightly-gate-report.json)
// を正とし、ここでは**構造**を固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  evaluateComparator,
  runNightlyGate,
  type NightlyAssert,
  type NightlyGateOptions,
} from "../../sim/nightlyGate";
import { GAME_DAY_TICKS } from "../../src/engine/stochastic";

/** テスト用の最小プロファイル(構造の確認が目的なので run は短く)。 */
const TINY: NightlyGateOptions = {
  profile: "quick",
  strategySeeds: ["nightly-test"],
  runTicks: GAME_DAY_TICKS * 12,
  determinismRuns: 3,
  eventCoverageSamples: 24,
  recallSeedCount: 1,
};

const report = runNightlyGate(TINY);

function assertById(id: string): NightlyAssert {
  const found = report.asserts.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`assert "${id}" が無い`);
  return found;
}

describe("GDD 11.4 の 11 条件が assert として存在する", () => {
  // GDD 11.4-N ごとに、その条件を担当する assert が最低 1 本あること。
  const requiredPrefixes = [
    "gdd-11.4-1",
    "gdd-11.4-2",
    "gdd-11.4-3",
    "gdd-11.4-4",
    "gdd-11.4-5",
    "gdd-11.4-6",
    "gdd-11.4-7",
    "gdd-11.4-8",
    "gdd-11.4-9",
    "gdd-11.4-10",
    "gdd-11.4-11",
  ] as const;

  it.each(requiredPrefixes.map((prefix) => [prefix] as const))(
    "%s を担当する assert が存在する",
    (prefix) => {
      // 枝つき ID(`gdd-11.4-2a` / `gdd-11.4-3-era3-lower` など)も同じ条件の担当。
      // 番号の取り違え(11.4-1 が 11.4-11 に一致する等)を避けるため、番号の直後が
      // 数字でないことを要求する。
      const matched = report.asserts.filter((entry) =>
        new RegExp(`^${prefix.replace(/\./g, "\\.")}(?![0-9])`).test(entry.id),
      );
      expect(matched.length).toBeGreaterThanOrEqual(1);
    },
  );

  it("GDD 11.6(敵対bot 6種が毎晩ゲート)も assert として存在する", () => {
    const adversarial = assertById("gdd-11.6");
    expect(adversarial.threshold).toBe(6);
    expect(adversarial.measured).toBeGreaterThanOrEqual(6);
  });

  it("11.4-N の全番号(1〜11)が漏れなく被覆されている", () => {
    const covered = new Set<string>();
    for (const entry of report.asserts) {
      const match = /^gdd-11\.4-(\d+)/.exec(entry.id);
      if (match?.[1] !== undefined) covered.add(match[1]);
    }
    expect([...covered].sort((l, r) => Number(l) - Number(r))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
  });
});

describe("全 assert が不等式である(bool 判定に化けていない)", () => {
  it("measured / threshold / comparator / unit がすべての assert に揃っている", () => {
    for (const entry of report.asserts) {
      expect(Number.isFinite(entry.measured), `${entry.id}: measured`).toBe(true);
      expect(Number.isFinite(entry.threshold), `${entry.id}: threshold`).toBe(true);
      expect([">=", ">", "<=", "<", "in-range"]).toContain(entry.comparator);
      expect(entry.unit.length, `${entry.id}: unit`).toBeGreaterThan(0);
      // 不等式の文字列にも比較記号(または in-range の <=)が現れること。
      expect(/[<>≤≥]/.test(entry.inequality), `${entry.id}: inequality=${entry.inequality}`).toBe(
        true,
      );
      if (entry.comparator === "in-range") {
        expect(entry.thresholdUpper, `${entry.id}: thresholdUpper`).not.toBeNull();
      }
    }
  });

  it("status が measured/threshold/comparator から機械的に導かれている", () => {
    for (const entry of report.asserts) {
      if (entry.status === "unverifiable") {
        expect(entry.unverifiableReason, `${entry.id}`).not.toBeNull();
        expect(entry.unblockCondition, `${entry.id}`).not.toBeNull();
        continue;
      }
      const expected = evaluateComparator(
        entry.comparator,
        entry.measured,
        entry.threshold,
        entry.thresholdUpper,
      );
      expect(entry.status, `${entry.id}`).toBe(expected ? "pass" : "fail");
      expect(entry.unverifiableReason, `${entry.id}`).toBeNull();
    }
  });

  it("evaluateComparator の 5 形すべてが境界で正しい", () => {
    expect(evaluateComparator(">=", 1, 1, null)).toBe(true);
    expect(evaluateComparator(">", 1, 1, null)).toBe(false);
    expect(evaluateComparator("<=", 1, 1, null)).toBe(true);
    expect(evaluateComparator("<", 1, 1, null)).toBe(false);
    expect(evaluateComparator("in-range", 1, 1, 3)).toBe(true);
    expect(evaluateComparator("in-range", 3, 1, 3)).toBe(true);
    expect(evaluateComparator("in-range", 4, 1, 3)).toBe(false);
    expect(evaluateComparator("in-range", 2, 1, null)).toBe(false);
  });
});

describe("検証不能は捏造せず理由と解消条件を持つ", () => {
  it("unverifiable の assert は理由と解消条件が空でない", () => {
    const unverifiable = report.asserts.filter((entry) => entry.status === "unverifiable");
    // M38 時点では 0 件ではない(GDD が閾値を持たない項が実在する)。
    expect(unverifiable.length).toBeGreaterThan(0);
    for (const entry of unverifiable) {
      expect((entry.unverifiableReason ?? "").length, entry.id).toBeGreaterThan(10);
      expect((entry.unblockCondition ?? "").length, entry.id).toBeGreaterThan(10);
    }
  });
});

describe("構造(structural)側の assert が pass する", () => {
  it("owner=structural の fail が 0 件(バランス側の fail は M39〜M41 の担当)", () => {
    const structuralFails = report.asserts.filter(
      (entry) => entry.owner === "structural" && entry.status === "fail",
    );
    expect(structuralFails.map((entry) => `${entry.id}: ${String(entry.measured)}`)).toEqual([]);
  });
});

describe("決定論: 同一 options の再実行で assert がバイト同一", () => {
  it("2 回目の runNightlyGate が同じ assert 列を返す", () => {
    const again = runNightlyGate(TINY);
    expect(JSON.stringify(again.asserts)).toBe(JSON.stringify(report.asserts));
  }, 300_000);
});
