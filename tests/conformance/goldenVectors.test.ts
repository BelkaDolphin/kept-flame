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
  it("ベクタ計画が spec §6 + M10/M15/M20/M22/M25/M50/M64 拡張のとおり 79 本ある", () => {
    // 37 → 40: M10 で sc17-prod-full-alpha / sc18-sto-overflow-alpha /
    // sc18-sto-overflow-split-alpha の 3 本を追加(spec §9・conformance 拡張 #1)。
    // 40 → 56: M15 で住民系(sc19〜sc27・16 本)を追加(conformance 拡張 #2)。
    // 56 → 62: M20 で footprint / 過密(sc28〜sc32・6 本)を追加(conformance 拡張 #3)。
    // 62 → 64: M22 で event 効果プリミティブ(sc33・2 本)を追加(拡張 #4 の先取りではなく
    //   ロードマップ M22 行の「destroyRecords を conformance ベクタで挙動固定」を満たす
    //   ための最小追加)。
    // 64 → 73: M25 で探索/event/outpost 系統(conformance 拡張 #4・spec §9.2(5))を
    //   追加(sc34-exp-two-slot-order ×2 / sc35-exp-rescue ×2 / sc36-exp-all-lost ×2 /
    //   sc37-exp-reward-overflow ×1 / sc38-out-supply ×2 = 9 本)。既存ベクタの
    //   expected/splitCounters は 1 バイトも変えていない(このコミットで動いたのは
    //   algoVersion 2→3 bump に伴う sc24 系 3 本のみ・別コミット扱いの理由は
    //   MEMORY.md の bump 束ね裁定を参照)。
    // 73 → 77: M50 で成文化の scheduler 段50 結線(sc39-codify-queue ×2)と
    //   研究対象の選択(sc40-research-select ×2)を追加。**既存 73 本の
    //   expected/splitCounters は 1 バイトも動いていない**(実測・M50 報告)ので
    //   algoVersion の bump は伴わない(spec §9.4(1) の表「新ベクタの追加のみ →
    //   bump 不要」・M25 の段80 結線と同じ結論)。
    // 77 → 79: M64(上限会計の統一・台帳v17 必-1 案1)で sc41-out-supply-cap ×2 を
    //   追加。**既存 77 本のうち動いたのは sc37-exp-reward-overflow-alpha 1 本だけ**
    //   (探索報酬の上限の出所が `exploration.rewardOverflow` から `storage` の
    //   加算式へ移ったため。シナリオの contentPatch 自体も差し替えた)。ほかの
    //   76 本は凍結 content の `storage.baseCapacity` が空 = 上限機構に入らない
    //   ため 1 バイトも動いていない(実測)。engine の観測挙動が変わったので
    //   ADR-016(1) に従い `content/balance.json` の algoVersion を 3 → 4 へ bump した。
    expect(VECTOR_PLANS.length).toBe(79);
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
