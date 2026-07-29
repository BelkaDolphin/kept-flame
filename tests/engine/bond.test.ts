// ---------------------------------------------------------------------------
// [M12] 絆(bond)— GDD 7.3
//
// 中心の検収条件は memoir.test.ts と同じ「同一 seed でバイト同一」/
// 「Map 反復順依存が無いこと」。bond は computeBondRates の内部で
// Map<string, BondRateEntry> を使うため、**施設の処理順と最終的な pairKey
// 昇順が食い違う盤面**を作って、返る配列が常に pairKey 昇順であることを
// 直接確認する(挿入順をそのまま返していたら失敗するはずのテスト)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt, toRaw } from "../../src/engine/fp";
import {
  BOND_MAX_FIX,
  BOND_MILESTONE_TIER_FIXES,
  applyBondProgress,
  applyPartnerLossEffects,
  bondPairKeyOf,
  bondPartnersOf,
  bondValueOf,
  computeBondRates,
  moralePenaltyOnPartnerLoss,
} from "../../src/engine/rules/bond";
import { memoirLogOf } from "../../src/engine/rules/memoir";
import { toSerializable } from "../../src/engine/state/serialize";
import { requireEntity } from "../../src/engine/state/state";
import { facility, HEARTH, resident, stateOf } from "./fixtures";
import { eid } from "./lifespanFixtures";

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("[M12] bondPairKeyOf(正準化)", () => {
  it("どちらを先に渡しても同じキーになる", () => {
    expect(bondPairKeyOf(eid("residentAlice"), eid("residentBeta"))).toBe(
      bondPairKeyOf(eid("residentBeta"), eid("residentAlice")),
    );
  });

  it("辞書順で前を residentAId 側に置く形式 'a|b'", () => {
    expect(bondPairKeyOf(eid("residentBeta"), eid("residentAlice"))).toBe(
      "residentAlice|residentBeta",
    );
  });

  it("同一 ID どうしは reject する", () => {
    expect(() => bondPairKeyOf(eid("residentAlice"), eid("residentAlice"))).toThrow();
  });
});

describe("[M12][検収] computeBondRates は Map 反復順に依存しない", () => {
  it("施設の処理順(ID 昇順)と pairKey の大小関係が逆でも、返る配列は常に pairKey 昇順", () => {
    // facility ID は "aFacility" < "zFacility" なので entitiesOfKind は
    // aFacility を先に処理する。しかし aFacility の住民ペアの pairKey
    // ("residentY|residentZ") は zFacility のペアの pairKey
    // ("residentA|residentB") より辞書順で**後**になる。挿入順をそのまま
    // 返す実装ならこのテストは失敗する。
    const state = stateOf([
      facility("aFacility", HEARTH.id, 0, [eid("residentY"), eid("residentZ")]),
      facility("zFacility", HEARTH.id, 1, [eid("residentA"), eid("residentB")]),
      resident("residentY"),
      resident("residentZ"),
      resident("residentA"),
      resident("residentB"),
    ]);

    const rates = computeBondRates(state, 0);
    const keys = rates.entries.map((e) => bondPairKeyOf(e.residentAId, e.residentBId));
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(sorted);
    expect(keys).toEqual(["residentA|residentB", "residentY|residentZ"]);
  });

  it("3 人以上の施設は全ペア(組合せ)ぶんのレートを持つ", () => {
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB"), eid("residentC")]),
      resident("residentA"),
      resident("residentB"),
      resident("residentC"),
    ]);
    const rates = computeBondRates(state, 0);
    expect(rates.entries).toHaveLength(3); // C(3,2) = 3
  });

  it("派遣中・想起困難中の住民は稼働とみなさず、ペアから外れる", () => {
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
      resident("residentA"),
      resident("residentB", { dispatched: true }),
    ]);
    expect(computeBondRates(state, 0).entries).toHaveLength(0);

    const impaired = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
      resident("residentA"),
      resident("residentB", { recallImpairedUntilTick: 1000 }),
    ]);
    expect(computeBondRates(impaired, 0).entries).toHaveLength(0);
  });

  it("無関係の 1 人だけの施設は 0 ペア(コンビネーションが無い)", () => {
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA")]),
      resident("residentA"),
    ]);
    expect(computeBondRates(state, 0).entries).toHaveLength(0);
  });
});

describe("[M12] applyBondProgress((A) 区間の閉形式・production.ts と同型)", () => {
  function coworkerState() {
    return stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
      resident("residentA"),
      resident("residentB"),
    ]);
  }

  it("共働ぶん bond 値が蓄積する(deltaTicks に比例)", () => {
    const state = coworkerState();
    const rates = computeBondRates(state, 0);
    const after10 = applyBondProgress(state, rates, 10, 10);
    const v10 = bondValueOf(after10, eid("residentA"), eid("residentB"));

    const after20 = applyBondProgress(state, rates, 20, 20);
    const v20 = bondValueOf(after20, eid("residentA"), eid("residentB"));

    expect(toRaw(v10)).toBeGreaterThan(0);
    expect(toRaw(v20)).toBe(toRaw(v10) * 2);
  });

  it("上限(BOND_MAX_FIX)でクランプされる", () => {
    const state = coworkerState();
    const rates = computeBondRates(state, 0);
    // 十分大きな deltaTicks で確実に上限へ張り付かせる。
    const after = applyBondProgress(state, rates, 10_000_000, 1);
    expect(toRaw(bondValueOf(after, eid("residentA"), eid("residentB")))).toBe(toRaw(BOND_MAX_FIX));
  });

  it("節目(BOND_MILESTONE_TIER_FIXES)を超えると両者の memoirLog へ bondMilestone が付く", () => {
    const state = coworkerState();
    const firstTierFix = BOND_MILESTONE_TIER_FIXES[0];
    if (firstTierFix === undefined) throw new Error("テスト前提: 節目が 1 つも無い");
    // 節目をちょうど超えるだけの deltaTicks を逆算する必要はなく、十分に大きく
    // 取って「少なくとも 1 段は超える」ことだけを確認すれば良い。
    const rates = computeBondRates(state, 0);
    const after = applyBondProgress(state, rates, 100_000, 42);

    const logA = memoirLogOf(after, eid("residentA"));
    const logB = memoirLogOf(after, eid("residentB"));
    const milestoneA = logA?.entries.find((e) => e.kind === "bondMilestone");
    const milestoneB = logB?.entries.find((e) => e.kind === "bondMilestone");
    expect(milestoneA).toBeDefined();
    expect(milestoneB).toBeDefined();
    if (milestoneA?.kind === "bondMilestone") {
      expect(milestoneA.partnerId).toBe(eid("residentB"));
      expect(milestoneA.tick).toBe(42);
      expect(milestoneA.tier).toBeGreaterThanOrEqual(1);
    }
    if (milestoneB?.kind === "bondMilestone") {
      expect(milestoneB.partnerId).toBe(eid("residentA"));
    }
  });

  it("レート 0(ペア無し)なら state をそのまま返す", () => {
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA")]),
      resident("residentA"),
    ]);
    const rates = computeBondRates(state, 0);
    expect(applyBondProgress(state, rates, 100, 100)).toBe(state);
  });

  it("deltaTicks が 1 未満なら reject する", () => {
    const state = coworkerState();
    const rates = computeBondRates(state, 0);
    expect(() => applyBondProgress(state, rates, 0, 0)).toThrow();
  });
});

describe("[M12] bondPartnersOf(partnerId 昇順)", () => {
  it("複数の相方を partnerId 昇順で返す(bondByPairKey の内部順に依存しない)", () => {
    // わざと「施設の処理順」と「partnerId の辞書順」が食い違う盤面を作る。
    const state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentM"), eid("residentZ")]),
      facility("hearthB", HEARTH.id, 1, [eid("residentA"), eid("residentM")]),
      resident("residentA"),
      resident("residentM"),
      resident("residentZ"),
    ]);
    const rates = computeBondRates(state, 0);
    const after = applyBondProgress(state, rates, 10, 10);

    const partners = bondPartnersOf(after, eid("residentM"));
    expect(partners.map((p) => p.partnerId)).toEqual([eid("residentA"), eid("residentZ")]);
  });

  it("bond を持たない住民は空配列", () => {
    const state = stateOf([resident("residentA")]);
    expect(bondPartnersOf(state, eid("residentA"))).toEqual([]);
  });
});

describe("[M12] moralePenaltyOnPartnerLoss / applyPartnerLossEffects", () => {
  it("士気ペナは bond 値に比例する", () => {
    const small = moralePenaltyOnPartnerLoss(fixFromInt(10));
    const large = moralePenaltyOnPartnerLoss(fixFromInt(20));
    expect(toRaw(large)).toBe(toRaw(small) * 2);
  });

  it("相方喪失で bond 相手に partnerLost memoirLog + 士気ペナが付く", () => {
    let state = stateOf([
      facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
      resident("residentA", { morale: fixFromInt(80) }),
      resident("residentB"),
    ]);
    const rates = computeBondRates(state, 0);
    state = applyBondProgress(state, rates, 1000, 1000);
    const bondBefore = bondValueOf(state, eid("residentA"), eid("residentB"));
    expect(toRaw(bondBefore)).toBeGreaterThan(0);

    const after = applyPartnerLossEffects(state, eid("residentB"), 2000);
    const survivor = requireEntity(after, eid("residentA"), "resident");
    expect(toRaw(survivor.morale)).toBeLessThan(toRaw(fixFromInt(80)));

    const log = memoirLogOf(after, eid("residentA"));
    const partnerLost = log?.entries.find((e) => e.kind === "partnerLost");
    expect(partnerLost).toBeDefined();
    if (partnerLost?.kind === "partnerLost") {
      expect(partnerLost.partnerId).toBe(eid("residentB"));
      expect(partnerLost.tick).toBe(2000);
    }
  });

  it("bond 値が 0 の相方には何もしない", () => {
    const state = stateOf([resident("residentA"), resident("residentB")]);
    const after = applyPartnerLossEffects(state, eid("residentB"), 100);
    expect(after).toBe(state);
  });
});

describe("[M12][検収] 同一 seed で bond 込みの state がバイト同一", () => {
  it("同じ操作列を経た 2 つの独立な state は最終的にバイト同一", () => {
    function run(): unknown {
      let state = stateOf([
        facility("hearthA", HEARTH.id, 0, [eid("residentA"), eid("residentB")]),
        resident("residentA"),
        resident("residentB"),
      ]);
      const rates = computeBondRates(state, 0);
      state = applyBondProgress(state, rates, 5000, 5000);
      state = applyPartnerLossEffects(state, eid("residentB"), 6000);
      return toSerializable(state);
    }
    expect(serialized(run())).toBe(serialized(run()));
  });

  it("bond を持たない state は bondByPairKey キー自体が省略される", () => {
    const json = toSerializable(stateOf([resident("residentA")], {}));
    expect("bondByPairKey" in json).toBe(false);
  });
});
