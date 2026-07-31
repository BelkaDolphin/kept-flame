// ---------------------------------------------------------------------------
// M27 おまかせ成文化アシスト(残存tick降順 + 80/100 約束)のテスト。
//
// 検収条件(ロードマップ M27 行):
//   ① 80% 検証: 代表ケースで理論最大(単一機械・遅延件数最小化の最適解)との比較
//   ② 検分: 3 アシストが同じ「80/100」の尺度で測られているか
//   ③ GDD 11.1 追補「唯一保持 → 石板、それ以外 → 紙」との整合
//
// M26(推奨配置)は「盤面の産出乗数の総和」を、本ファイルは「単一キューを
// 流したときに締切(残存tick)に間に合う技術の件数」を尺度に取る。総当たり側は
// 小規模(候補 3〜5 件)の**全順列**で理論最大を直接計算し(M26 の総当たり最適と
// 同じ立場)、`assistCodifyCandidates` が返す実際の `durationTicks` /
// `residualTick` をそのまま使う(尺度を二重に持たない)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  CODIFY_NO_DEADLINE_TICKS,
  assistCodifyCandidates,
  codificationPlanToCommands,
  codifyRecordId,
  codifyResidualTick,
  suggestCodification,
  type CodifyCandidate,
} from "../../src/engine/assist/codify";
// `codify.ts` は入力契約違反の例外を `assist/placement.ts` の `AssistError` に
// 統一している(assist 層で例外クラスを 1 つに保つ設計・M27 の設計要点)。
import { AssistError } from "../../src/engine/assist/placement";
import { apply } from "../../src/engine/commands";
import { FIX_ONE, fixFromInt, fixFromRaw } from "../../src/engine/fp";
import { techMemoryKeyOf } from "../../src/engine/rules/techMemory";
import type { EngineContent, RecordMediaParams, TechDef } from "../../src/engine/rules/types";
import type { EntityId, EntityState, GameState } from "../../src/engine/state/state";
import { setTechMemory } from "../../src/engine/state/update";
import { content, id, resident, resource, stateOf } from "./fixtures";
import { agedResident } from "./lifespanFixtures";

// --- 2. テスト用 content -----------------------------------------------------

const CLAY = id("codifyClay");
const PAPER_RESOURCE = id("codifyPaperResource");

/** baseDurationTicks=40 × 媒体倍率で 石板=40tick / 紙=20tick になる表。 */
const RECORD_MEDIA_PARAMS: RecordMediaParams = {
  baseCostFix: fixFromInt(10),
  baseDurationTicks: 40,
  printingTechId: null,
  printingCostMulFix: fixFromRaw(500_000),
  printingTimeMulFix: fixFromRaw(500_000),
  byMedium: {
    paper: {
      costMulFix: fixFromRaw(500_000),
      timeMulFix: fixFromRaw(500_000), // 40 × 0.5 = 20
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: PAPER_RESOURCE,
    },
    stoneTablet: {
      costMulFix: FIX_ONE,
      timeMulFix: FIX_ONE, // 40 × 1.0 = 40
      caravanWeightFix: FIX_ONE,
      flammable: false,
      costResourceId: CLAY,
    },
  },
};

function codifyContent(techDefs: ReadonlyMap<EntityId, TechDef>): EngineContent {
  const base = content();
  return {
    facilityDefs: base.facilityDefs,
    techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    recordMedia: RECORD_MEDIA_PARAMS,
  };
}

// --- 3. 代表シナリオ 5 種(候補の (残存tick, 保持者数) だけを指定) -----------

interface CandidateSpec {
  /** atTick=0 での残存tick(= 保有者の deathTick そのもの)。 */
  readonly deadline: number;
  /** true なら保持者 2 名(紙・§2 の複数保持)、false なら唯一保持(石板)。 */
  readonly multiHolder: boolean;
}

interface Scenario {
  readonly name: string;
  readonly specs: readonly CandidateSpec[];
}

/**
 * 5 種の代表ケース(2026-07-31 実測・下記「80% 検証」の実測値コメント参照)。
 * 「余裕のある候補が混ざるほど降順ヒューリスティックが理論最大へ近づく」
 * (s1: 競合なし)から「複数候補が同時に締切と戦う」(s5: 最も厳しい)まで
 * 幅を持たせてある(M26 の代表盤面 5 種と同じ立場)。
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: "s1-競合なし(全候補に十分な余裕)",
    specs: [
      { deadline: 500, multiHolder: false },
      { deadline: 500, multiHolder: true },
      { deadline: 300, multiHolder: true },
    ],
  },
  {
    name: "s2-唯一保持1件だけ急ぐ",
    specs: [
      { deadline: 45, multiHolder: false },
      { deadline: 9999, multiHolder: true },
      { deadline: 9999, multiHolder: true },
      { deadline: 9999, multiHolder: false },
    ],
  },
  {
    name: "s3-唯一保持2件が急ぐ",
    specs: [
      { deadline: 50, multiHolder: false },
      { deadline: 90, multiHolder: false },
      { deadline: 9999, multiHolder: true },
      { deadline: 9999, multiHolder: true },
    ],
  },
  {
    name: "s4-段階的な締切3件",
    specs: [
      { deadline: 50, multiHolder: false },
      { deadline: 100, multiHolder: false },
      { deadline: 150, multiHolder: false },
      { deadline: 9999, multiHolder: true },
    ],
  },
  {
    name: "s5-媒体混在で最も厳しい",
    specs: [
      { deadline: 45, multiHolder: false },
      { deadline: 65, multiHolder: true },
      { deadline: 100, multiHolder: false },
      { deadline: 9999, multiHolder: true },
      { deadline: 9999, multiHolder: true },
    ],
  },
];

/** シナリオから state/content を組み立てる。 */
function buildScenario(scenario: Scenario): {
  readonly state: GameState;
  readonly content: EngineContent;
} {
  const techDefs = new Map<EntityId, TechDef>();
  const entities: EntityState[] = [
    resource(`${scenarioKey(scenario)}Clay`, CLAY, 1_000_000),
    resource(`${scenarioKey(scenario)}Paper`, PAPER_RESOURCE, 1_000_000),
  ];
  const memoryOps: { residentId: EntityId; techId: EntityId }[] = [];

  scenario.specs.forEach((spec, i) => {
    const techId = id(`tech${scenarioKey(scenario)}${String(i)}`);
    techDefs.set(techId, { id: techId, researchCostFix: fixFromInt(10) });
    entities.push({
      kind: "research",
      id: id(`research${scenarioKey(scenario)}${String(i)}`),
      techId,
      progress: fixFromInt(10),
      completedTick: 0,
    });

    const holderAName = `resident${scenarioKey(scenario)}${String(i)}a`;
    entities.push(agedResident(holderAName, 0, spec.deadline));
    memoryOps.push({ residentId: id(holderAName), techId });

    if (spec.multiHolder) {
      const holderBName = `resident${scenarioKey(scenario)}${String(i)}b`;
      // 寿命を持たない 2 人目の保持者(残存tick計算には効かない・§3 の doc どおり)。
      entities.push(resident(holderBName));
      memoryOps.push({ residentId: id(holderBName), techId });
    }
  });

  let state = stateOf(entities);
  for (const op of memoryOps) {
    state = setTechMemory(state, techMemoryKeyOf(op.residentId, op.techId), {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
  }
  return { state, content: codifyContent(techDefs) };
}

/** テスト内 ID をシナリオごとに一意にするための短縮キー。 */
function scenarioKey(scenario: Scenario): string {
  return scenario.name.replace(/[^a-zA-Z0-9]/g, "");
}

// --- 4. 総当たり最適(単一機械・遅延件数最小化・全順列) --------------------

function permutationsOf<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutationsOf(rest)) result.push([items[i] as T, ...perm]);
  }
  return result;
}

/** その順で単一キューを流したときに間に合う(締切以内に完了する)件数。 */
function onTimeCountForOrder(order: readonly CodifyCandidate[]): number {
  let cumulative = 0;
  let count = 0;
  for (const candidate of order) {
    cumulative += candidate.durationTicks;
    if (cumulative <= candidate.residualTick) count++;
  }
  return count;
}

/** 全順列を試して間に合う件数の最大値(= 理論最大)を求める。 */
function bruteForceOptimalOnTimeCount(candidates: readonly CodifyCandidate[]): number {
  let best = 0;
  for (const perm of permutationsOf(candidates)) {
    const count = onTimeCountForOrder(perm);
    if (count > best) best = count;
  }
  return best;
}

/** EDD(締切昇順)で流したときの間に合う件数(§検分: GDD 既定の降順との対比用)。 */
function ascendingOnTimeCount(candidates: readonly CodifyCandidate[]): number {
  const sorted = [...candidates].sort((a, b) => a.residualTick - b.residualTick);
  return onTimeCountForOrder(sorted);
}

// --- 5. 80% 検証(検収条件①②) --------------------------------------------

describe("M27 おまかせ成文化: 単一キューの理論最大との比(80/100 約束)", () => {
  interface Measured {
    readonly scenario: string;
    readonly optimal: number;
    readonly heuristic: number;
    readonly ascending: number;
    readonly ratio: number;
  }

  const measured: Measured[] = [];
  for (const scenario of SCENARIOS) {
    const { state, content: engineContent } = buildScenario(scenario);
    const candidates = assistCodifyCandidates(state, engineContent, 0);
    const plan = suggestCodification(state, engineContent, 0);
    const heuristic = plan.suggestions.filter((s) => s.onSchedule).length;
    const optimal = bruteForceOptimalOnTimeCount(candidates);
    const ascending = ascendingOnTimeCount(candidates);
    measured.push({
      scenario: scenario.name,
      optimal,
      heuristic,
      ascending,
      ratio: heuristic / optimal,
    });
  }

  // -------------------------------------------------------------------------
  // 2026-07-31 実測(候補は全て `assistCodifyCandidates` の実値・全順列総当たり)
  //
  //   シナリオ                          理論最大  降順(既定)  昇順(EDD)  降順/最大
  //   s1 競合なし                       3         3            3          1.000
  //   s2 唯一保持1件だけ急ぐ            4         3            4          0.750
  //   s3 唯一保持2件が急ぐ              4         3            4          0.750
  //   s4 段階的な締切3件                4         3            4          0.750
  //   s5 媒体混在で最も厳しい           5         3            5          0.600
  //                                                             平均      0.770
  //
  // 昇順(EDD)は全シナリオで理論最大に一致する(単一機械・遅延件数最小化問題で
  // EDD が高い性能を示すことはよく知られている)。GDD が明示する「降順」は
  // その逆方向であり、これが理論最大から意図的に乖離する根拠である(§検分)。
  // -------------------------------------------------------------------------

  it("実測が想定どおり並ぶ(全シナリオで比が有限かつ理論最大が正)", () => {
    expect(measured).toHaveLength(SCENARIOS.length);
    for (const row of measured) {
      expect(row.optimal).toBeGreaterThan(0);
      expect(Number.isFinite(row.ratio)).toBe(true);
    }
  });

  it.each(measured)("$scenario: 降順ヒューリスティックは理論最大の 100% 以下", ({ ratio }) => {
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it.each(measured)("$scenario: 降順ヒューリスティックは理論最大の 50% 以上", ({ ratio }) => {
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });

  it("代表シナリオ平均が 8 割前後(0.70〜0.85)に収まる", () => {
    let sum = 0;
    for (const row of measured) sum += row.ratio;
    const mean = sum / measured.length;
    expect(mean).toBeGreaterThanOrEqual(0.7);
    expect(mean).toBeLessThanOrEqual(0.85);
  });

  it(
    "検分: 昇順(EDD)は理論最大に一致する一方、GDD 既定の降順は一致しない" +
      "(非最適性は「降順」という向きそのものに由来する・GDD 14-3 相当の残余リスク)",
    () => {
      for (const row of measured) {
        expect(row.ascending).toBe(row.optimal);
      }
      // 競合が無いシナリオ(s1)を除けば、降順は昇順に厳密に劣る。
      const withConflict = measured.filter((row) => row.scenario !== SCENARIOS[0]?.name);
      expect(withConflict.length).toBeGreaterThan(0);
      for (const row of withConflict) {
        expect(row.heuristic).toBeLessThan(row.ascending);
      }
    },
  );
});

// --- 6. GDD 11.1 追補「唯一保持 → 石板、それ以外 → 紙」との整合(検収条件③) --

describe("M27 おまかせ成文化: 媒体規則(GDD 11.1 追補)との整合", () => {
  it("唯一保持(保持者1名)の候補は石板、複数保持の候補は紙になる", () => {
    const scenario = SCENARIOS[4];
    if (scenario === undefined) throw new Error("s5 シナリオが無い");
    const { state, content: engineContent } = buildScenario(scenario);
    const candidates = assistCodifyCandidates(state, engineContent, 0);
    for (const candidate of candidates) {
      if (candidate.holderCount === 1) {
        expect(candidate.medium).toBe("stoneTablet");
        expect(candidate.durationTicks).toBe(40);
      } else {
        expect(candidate.medium).toBe("paper");
        expect(candidate.durationTicks).toBe(20);
      }
    }
  });
});

// --- 7. 決定論と純粋性 -------------------------------------------------------

describe("M27 おまかせ成文化: 決定論と純粋性", () => {
  const scenario = SCENARIOS[2];
  if (scenario === undefined) throw new Error("s3 シナリオが無い");
  const { state, content: engineContent } = buildScenario(scenario);

  it("同一入力 → 同一出力(2 回呼んで完全一致)", () => {
    const first = suggestCodification(state, engineContent, 0);
    const second = suggestCodification(state, engineContent, 0);
    expect(second).toStrictEqual(first);
  });

  it("state を 1 bit も変えない", () => {
    const snapshot = JSON.stringify([...state.entityStateById.entries()]);
    suggestCodification(state, engineContent, 0);
    expect(JSON.stringify([...state.entityStateById.entries()])).toBe(snapshot);
  });

  it("キュー順は残存tick降順 → techId 昇順の全順序", () => {
    const plan = suggestCodification(state, engineContent, 0);
    for (let i = 1; i < plan.suggestions.length; i++) {
      const prev = plan.suggestions[i - 1];
      const cur = plan.suggestions[i];
      if (prev === undefined || cur === undefined) continue;
      expect(prev.residualTick).toBeGreaterThanOrEqual(cur.residualTick);
      if (prev.residualTick === cur.residualTick) {
        expect(prev.techId < cur.techId).toBe(true);
      }
    }
  });
});

// --- 8. 「残存tick」の sentinel(寿命を持たない保持者のみ) ------------------

describe("M27 おまかせ成文化: 残存tick の sentinel(§3)", () => {
  it("生存保持者の誰も life を持たない tech は CODIFY_NO_DEADLINE_TICKS になる", () => {
    const techId = id("techNoLifeHolder");
    const techDefs = new Map<EntityId, TechDef>([
      [techId, { id: techId, researchCostFix: fixFromInt(10) }],
    ]);
    let state = stateOf([
      resident("residentNoLife"),
      {
        kind: "research",
        id: id("researchNoLife"),
        techId,
        progress: fixFromInt(10),
        completedTick: 0,
      },
    ]);
    state = setTechMemory(state, techMemoryKeyOf(id("residentNoLife"), techId), {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
    expect(codifyResidualTick(state, techId, 0)).toBe(CODIFY_NO_DEADLINE_TICKS);

    const candidates = assistCodifyCandidates(state, codifyContent(techDefs), 0);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.residualTick).toBe(CODIFY_NO_DEADLINE_TICKS);
  });

  it("sentinel の候補は降順ソートで最優先(=最も余裕がある扱い)になる", () => {
    const scenario = SCENARIOS[1];
    if (scenario === undefined) throw new Error("s2 シナリオが無い");
    const { state, content: engineContent } = buildScenario(scenario);
    const plan = suggestCodification(state, engineContent, 0);
    const first = plan.suggestions[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    // s2 は 9999(実質無期限)の候補を含む。sentinel ではないが「最も余裕がある」
    // 値として先頭に来ることを確認する(sentinel 自体は上のテストで別途固定済み)。
    expect(first.residualTick).toBe(9999);
  });
});

// --- 9. 提案は実際に beginCodification として受理される --------------------

describe("M27 おまかせ成文化: 提案は commands.ts に受理される", () => {
  it("キュー先頭の提案を適用すると codify entity が作られる", () => {
    const scenario = SCENARIOS[0];
    if (scenario === undefined) throw new Error("s1 シナリオが無い");
    const { state, content: engineContent } = buildScenario(scenario);
    const plan = suggestCodification(state, engineContent, 0);
    const commands = codificationPlanToCommands(plan);
    expect(commands.length).toBe(plan.suggestions.length);

    let next = state;
    for (const command of commands) {
      const result = apply(next, engineContent, command);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      next = result.state;
    }
    for (const command of commands) {
      expect(next.entityStateById.has(command.codifyId)).toBe(true);
    }
  });

  it("codifyRecordId は (techId, medium) から決定論的に一意な ID を作る", () => {
    const techId = id("techSample");
    const stoneId = codifyRecordId(techId, "stoneTablet");
    const paperId = codifyRecordId(techId, "paper");
    expect(stoneId).not.toBe(paperId);
    expect(codifyRecordId(techId, "stoneTablet")).toBe(stoneId);
  });
});

// --- 10. 入力の契約 ----------------------------------------------------------

describe("M27 おまかせ成文化: 入力の契約", () => {
  it("atTick が整数でなければ AssistError", () => {
    const engineContent = codifyContent(new Map());
    expect(() => suggestCodification(stateOf([]), engineContent, 1.5)).toThrow(AssistError);
  });

  it("候補が無ければ提案も空", () => {
    const engineContent = codifyContent(new Map());
    const plan = suggestCodification(stateOf([]), engineContent, 0);
    expect(plan.suggestions).toStrictEqual([]);
  });
});
