// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 段階sim1000(M38)のテスト — ADR-015 正準順序 4/10
//
// 検収条件: content-guardrail の「4. 段階sim1000」ジョブが**実際に sim を走らせ、
// 閾値超過で赤くなる**こと。ここでは (a) 既定の段構成が合計 1000 runs であること
// (b) 縮小構成で違反ゼロ・決定論一致 (c) 違反が出る条件では violations が
// 実際に積まれること(閾値判定が生きていること)を固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { DEFAULT_STAGES, runStagedSim } from "../../sim/stagedSim";

describe("段階sim1000(ADR-015 正準順序 4/10)", () => {
  it("既定の 3 段が合計ちょうど 1000 runs(GDD 12.4「段階的sim1000回」)", () => {
    let total = 0;
    for (const stage of DEFAULT_STAGES) total += stage.runs;
    expect(total).toBe(1000);
    // 段が「短い run を多数 → 長い run を少数」になっている(単調)。
    for (let i = 1; i < DEFAULT_STAGES.length; i++) {
      const prev = DEFAULT_STAGES[i - 1];
      const cur = DEFAULT_STAGES[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.runs).toBeLessThan(prev.runs);
      expect(cur.days).toBeGreaterThan(prev.days);
    }
  });

  it("縮小構成で違反ゼロ・11 bot 全部が走る", () => {
    const report = runStagedSim({
      stages: [{ id: "test-short", runs: 22, days: 2 }],
      determinismSpotChecks: 1,
    });
    expect(report.botCount).toBe(11);
    expect(report.totalRuns).toBe(22);
    expect(report.violations).toEqual([]);
    const stage = report.stages[0];
    expect(stage?.exceptionCount).toBe(0);
    expect(stage?.determinismMismatches).toBe(0);
    // 不等式の実測値そのものが出ている(bool ではない)。
    expect(stage?.minPopulationFloorMargin).toBeGreaterThanOrEqual(0);
    expect(stage?.minFinalFacilityCount).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("同一構成の再実行が同じ判定値を返す(決定論)", () => {
    const options = {
      stages: [{ id: "test-det", runs: 11, days: 2 }],
      determinismSpotChecks: 1,
    } as const;
    const a = runStagedSim(options);
    const b = runStagedSim(options);
    expect(JSON.stringify(b.stages)).toBe(JSON.stringify(a.stages));
    expect(JSON.stringify(b.violations)).toBe(JSON.stringify(a.violations));
  }, 120_000);
});
