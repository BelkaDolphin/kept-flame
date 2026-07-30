import { describe, expect, it } from "vitest";

import coverageJson from "../../conformance/coverage.json";
import { checkCoverage, type CoverageRegistry } from "../../conformance/goldenVector";
import { VECTOR_PLANS } from "../../conformance/vectorPlans";
import { buildVector, diffVectors, loadStoredVector } from "../../tools/genGoldenVectors";

// ---------------------------------------------------------------------------
// golden vector の再生成一致・被覆完全性テスト(T7 後半)。
//
// `buildVector` 自体が(a) 分割実行の最終状態ダイジェストが一括実行と一致する
// こと(spec §7.2 規則8)と (b) `rng-state-nonempty-roundtrip` を申告するベクタの
// 往復不変性(規則6)を検証してから返す(破れていれば GeneratorError を投げる)。
// よってここで `buildVector(plan)` が例外なく完了すること自体が分割/往復
// 不変性の確認になる。加えて各ベクタについて「再生成した観測値が
// `conformance/vectors/*.json` に保存済みの値と一致する」ことを確認する
// (= `npm run golden:check` と同じ判定をテストスイートからも掛ける)。
// ---------------------------------------------------------------------------

const registry = coverageJson as CoverageRegistry;

describe("golden vectors(T7 後半・golden-vector-spec.md §6/§7)", () => {
  it("ベクタ計画が spec §6 + M10/M15/M20 拡張のとおり 62 本ある", () => {
    // 37 → 40: M10 で sc17-prod-full-alpha / sc18-sto-overflow-alpha /
    // sc18-sto-overflow-split-alpha の 3 本を追加(spec §9・conformance 拡張 #1)。
    // 40 → 56: M15 で住民系(sc19〜sc27・16 本)を追加(conformance 拡張 #2)。
    // 56 → 62: M20 で footprint / 過密(sc28〜sc32・6 本)を追加(conformance 拡張 #3)。
    expect(VECTOR_PLANS.length).toBe(62);
  });

  it("vectorId に重複が無い", () => {
    const ids = VECTOR_PLANS.map((p) => p.vectorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("checkCoverage が空配列(全経路が被覆され、未登録申告なし・完了条件3)", () => {
    const vectors = VECTOR_PLANS.map((p) => buildVector(p));
    expect(checkCoverage(registry, vectors)).toEqual([]);
  }, 30_000);

  for (const vectorPlan of VECTOR_PLANS) {
    it(`${vectorPlan.vectorId}: 再生成一致(分割不変性/往復不変性は buildVector 内で検証済み)`, () => {
      const fresh = buildVector(vectorPlan);
      const stored = loadStoredVector(vectorPlan.vectorId);
      expect(stored).toBeDefined();
      if (stored === undefined) return;
      expect(diffVectors(fresh, stored)).toEqual([]);
    }, 30_000);
  }
});
