import { describe, expect, it } from "vitest";

import coverageJson from "../../conformance/coverage.json";
import {
  DIGEST_SEEDS,
  GOLDEN_VECTOR_FORMAT_VERSION,
  VECTOR_FILE_NAME_MAX_LENGTH,
  buildCoverageMatrix,
  canonicalJsonOfState,
  checkCoverage,
  compareCounters,
  compareObservations,
  countersOfReport,
  digestOfCanonicalJson,
  isValidVectorId,
  observe,
  requiresVector,
  sumCounters,
  vectorFileName,
  type CoverageRegistry,
  type GoldenCounters,
  type GoldenVector,
} from "../../conformance/goldenVector";
import { advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import {
  content,
  facility,
  resident,
  resource,
  stateOf,
  WOOD,
  HEARTH,
  id,
} from "../engine/fixtures";

// ---------------------------------------------------------------------------
// golden vector フォーマット(T7 前半)のテスト。
//
// ベクタ実体は T7 後半で生成するので、ここで固定するのは
//   (1) ダイジェスト/観測/突合/ファイル名の性質
//   (2) 経路レジストリ(conformance/coverage.json)の形式が正しいこと
//   (3) **状態は分割不変だがカウンタは分割不変でない**という spec §3.3 の主張
// の 3 点。(3) は T5 でバグが出た区切り位置の検出器が壊れていないことの根拠。
// ---------------------------------------------------------------------------

const registry = coverageJson as CoverageRegistry;

// --- 1. ダイジェスト --------------------------------------------------------

describe("digestOfCanonicalJson", () => {
  it("32 桁の小文字 16 進を返す", () => {
    const digest = digestOfCanonicalJson('{"a":1}');
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(DIGEST_SEEDS).toHaveLength(4);
  });

  it("同じ入力なら同じ値(決定論)", () => {
    expect(digestOfCanonicalJson('{"a":1}')).toBe(digestOfCanonicalJson('{"a":1}'));
  });

  it("1 文字違えば変わる", () => {
    expect(digestOfCanonicalJson('{"a":1}')).not.toBe(digestOfCanonicalJson('{"a":2}'));
  });

  it("キー順が違えば変わる(正準化前の入力を渡していないかの検出)", () => {
    expect(digestOfCanonicalJson('{"a":1,"b":2}')).not.toBe(digestOfCanonicalJson('{"b":2,"a":1}'));
  });

  it("長さが違えば必ず変わる(各パスの末尾に長さを畳んでいる)", () => {
    expect(digestOfCanonicalJson("")).not.toBe(digestOfCanonicalJson("0"));
  });

  it("4 本のパスが同じ値になっていない(初期値が実際に効いている)", () => {
    const digest = digestOfCanonicalJson('{"kept":"flame"}');
    const parts = [
      digest.slice(0, 8),
      digest.slice(8, 16),
      digest.slice(16, 24),
      digest.slice(24, 32),
    ];
    expect(new Set(parts).size).toBe(4);
  });
});

// --- 2. 観測 ---------------------------------------------------------------

/** 住民 1 名が tick 100 に想起困難から回復する最小盤面(spec §3.3 の例)。 */
function recoveryBoard() {
  const state = stateOf([
    resident("residentAnn", {
      assignedFacilityId: id("facilityA"),
      recallImpairedUntilTick: 100,
    }),
    facility("facilityA", HEARTH.id, 0, [id("residentAnn")]),
    resource("resourceWood", WOOD, 0),
  ]);
  return { state, ctx: createAdvanceContext(state, content()) };
}

describe("observe", () => {
  it("同じ run から同じ観測値が得られる", () => {
    const board = recoveryBoard();
    const first = advanceWithReport(board.state, board.ctx, 200);
    const second = advanceWithReport(board.state, board.ctx, 200);
    expect(compareObservations(observe(first.state, first), observe(second.state, second))).toEqual(
      [],
    );
  });

  it("プローブが state の各部分系を写している", () => {
    const board = recoveryBoard();
    const report = advanceWithReport(board.state, board.ctx, 200);
    const observation = observe(report.state, report);
    expect(observation.probe.tick).toBe(200);
    expect(observation.probe.entityCount).toBe(3);
    // tick 0〜99 は想起困難で稼働ゼロ、100〜199 は Lv1 = 1.0/tick × 1 名。
    expect(observation.probe.resourceStockSumRaw).toBe(100_000_000);
    expect(observation.probe.researchCompletedCount).toBe(0);
    expect(observation.probe.recallImpairedResidentCount).toBe(0);
    expect(observation.probe.recallImpairedUntilTickSum).toBe(100);
    // 研究 entity が無いので (C) の試行はゼロ = 逐次ストリームは未使用。
    expect(observation.probe.rngStateDomainCount).toBe(0);
    expect(observation.probe.rngStateWordsXor).toBe(0);
  });

  it("canonicalJsonLength が正準 JSON の長さと一致する", () => {
    const board = recoveryBoard();
    const report = advanceWithReport(board.state, board.ctx, 200);
    const observation = observe(report.state, report);
    expect(observation.canonicalJsonLength).toBe(canonicalJsonOfState(report.state).length);
  });
});

// --- 3. 分割不変性の非対称性(spec §3.3) -----------------------------------

describe("状態は分割不変だがカウンタは分割不変ではない(spec §3.3)", () => {
  it("回復 tick ちょうどで区切ると状態は一致し rateChangeEventCount は減る", () => {
    const board = recoveryBoard();

    const oneShot = advanceWithReport(board.state, board.ctx, 200);
    const firstHalf = advanceWithReport(board.state, board.ctx, 100);
    const secondHalf = advanceWithReport(firstHalf.state, board.ctx, 200);

    // (1) 状態は完全一致(= golden vector が要求するのはこれだけ)。
    expect(digestOfCanonicalJson(canonicalJsonOfState(secondHalf.state))).toBe(
      digestOfCanonicalJson(canonicalJsonOfState(oneShot.state)),
    );

    // (2) 一括では回復イベントが (B) 境界として処理される。
    expect(oneShot.rateChangeEventCount).toBe(1);

    // (3) 分割では tick == toTick が処理されず、次回も until > tick で積まれないので 0。
    //     「カウンタも一致するはず」と書くと、この検出器が壊れる。
    const splitTotal = sumCounters([countersOfReport(firstHalf), countersOfReport(secondHalf)]);
    expect(splitTotal.rateChangeEventCount).toBe(0);
    expect(compareCounters("split", countersOfReport(oneShot), splitTotal).length).toBeGreaterThan(
      0,
    );
  });
});

// --- 4. カウンタの合成と突合 ------------------------------------------------

describe("カウンタのユーティリティ", () => {
  const zero: GoldenCounters = {
    segmentCount: 0,
    stochasticStepCount: 0,
    stochasticTrialCount: 0,
    rateChangeEventCount: 0,
    recallOccurrenceCount: 0,
  };

  it("sumCounters は全フィールドを合算する", () => {
    const a: GoldenCounters = {
      segmentCount: 1,
      stochasticStepCount: 2,
      stochasticTrialCount: 3,
      rateChangeEventCount: 4,
      recallOccurrenceCount: 5,
    };
    expect(sumCounters([a, a])).toEqual({
      segmentCount: 2,
      stochasticStepCount: 4,
      stochasticTrialCount: 6,
      rateChangeEventCount: 8,
      recallOccurrenceCount: 10,
    });
    expect(sumCounters([])).toEqual(zero);
  });

  it("compareCounters は差分のあるフィールドだけを列挙する", () => {
    const diffs = compareCounters("c", zero, { ...zero, segmentCount: 3 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("c.segmentCount");
  });

  it("compareObservations は差分をすべて列挙する(最初で打ち切らない)", () => {
    const board = recoveryBoard();
    const report = advanceWithReport(board.state, board.ctx, 200);
    const observation = observe(report.state, report);
    const broken = {
      stateDigest: "0".repeat(32),
      canonicalJsonLength: observation.canonicalJsonLength + 1,
      counters: { ...observation.counters, segmentCount: observation.counters.segmentCount + 1 },
      probe: { ...observation.probe, tick: observation.probe.tick + 1 },
    };
    const diffs = compareObservations(observation, broken);
    expect(diffs.length).toBeGreaterThanOrEqual(4);
    expect(diffs.join("\n")).toContain("stateDigest");
    expect(diffs.join("\n")).toContain("canonicalJsonLength");
    expect(diffs.join("\n")).toContain("counters.segmentCount");
    expect(diffs.join("\n")).toContain("probe.tick");
  });
});

// --- 5. ファイル名(spec §3.6) ---------------------------------------------

describe("vectorFileName", () => {
  it("短い ID はそのまま(小文字統一・Windows 260 文字対策)", () => {
    expect(vectorFileName("sc15-tie-split-alpha")).toBe("sc15-tie-split-alpha.json");
  });

  it("上限を超える ID は短縮ハッシュへ落ちる", () => {
    const long = "sc99-a-very-long-scenario-name-with-many-segments-alpha";
    const name = vectorFileName(long);
    expect(name.length).toBeLessThanOrEqual(VECTOR_FILE_NAME_MAX_LENGTH);
    expect(name).toMatch(/^v-[0-9a-f]{8}\.json$/);
    // 短縮も決定論(同じ ID なら同じファイル名)。
    expect(vectorFileName(long)).toBe(name);
  });

  it("どの ID でも上限以内に収まる", () => {
    for (const vectorId of ["a", "sc01-steady-alpha", "x".repeat(200)]) {
      expect(vectorFileName(vectorId).length).toBeLessThanOrEqual(VECTOR_FILE_NAME_MAX_LENGTH);
    }
  });

  it("大文字・アンダースコア・空白・先頭ハイフンは拒否する", () => {
    for (const bad of ["SC01", "sc_01", "sc 01", "-sc01", "sc01-", "sc01--a", ""]) {
      expect(isValidVectorId(bad)).toBe(false);
      expect(() => vectorFileName(bad)).toThrow();
    }
  });
});

// --- 6. 経路レジストリ ------------------------------------------------------

function vectorOf(vectorId: string, paths: readonly string[]): GoldenVector {
  const counters: GoldenCounters = {
    segmentCount: 0,
    stochasticStepCount: 0,
    stochasticTrialCount: 0,
    rateChangeEventCount: 0,
    recallOccurrenceCount: 0,
  };
  return {
    formatVersion: GOLDEN_VECTOR_FORMAT_VERSION,
    vectorId,
    scenarioId: "sc00-dummy",
    worldSeed: "seedAlpha",
    worldSeedU32: 0,
    coarseTickMinutes: 10,
    fromTick: 0,
    toTick: 1,
    elapsedMonotonicMs: null,
    splitTicks: [],
    paths,
    expected: {
      stateDigest: "0".repeat(32),
      canonicalJsonLength: 0,
      counters,
      probe: {
        tick: 0,
        entityCount: 0,
        resourceStockSumRaw: 0,
        researchProgressSumRaw: 0,
        researchCompletedCount: 0,
        recallImpairedResidentCount: 0,
        recallImpairedUntilTickSum: 0,
        rngStateDomainCount: 0,
        rngStateWordsXor: 0,
      },
    },
    splitCounters: null,
  };
}

describe("conformance/coverage.json の形式", () => {
  it("formatVersion が現在のフォーマット版と一致する", () => {
    expect(registry.formatVersion).toBe(GOLDEN_VECTOR_FORMAT_VERSION);
  });

  it("経路が 1 件以上あり、ID/ title / refs / observedBy がそろっている", () => {
    expect(registry.paths.length).toBeGreaterThan(0);
    // 形式違反(ID 重複・不正 ID・空 refs/observedBy)は 0 件であること。
    // ベクタ未実装ゆえ「ベクタが無い」問題だけが残る想定。
    const problems = checkCoverage(registry, []);
    const formatProblems = problems.filter(
      (problem) => !problem.includes("を踏む golden vector が 1 本も無い"),
    );
    expect(formatProblems).toEqual([]);
  });

  it("golden vector で観測する経路と、単体テスト/ローダーで担保する経路が分かれている", () => {
    const needVector = registry.paths.filter(requiresVector);
    const others = registry.paths.filter((entry) => !requiresVector(entry));
    expect(needVector.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    // golden で観測しない経路は必ず担保先を note に書く(spec §2.2)。
    for (const entry of others) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it("spec §2.3 の接頭辞グループがすべて存在する", () => {
    const prefixes = ["a-", "b-", "c-", "tie-", "split-", "rng-", "adj-", "fp-", "clock-", "load-"];
    for (const prefix of prefixes) {
      expect(registry.paths.some((entry) => entry.id.startsWith(prefix))).toBe(true);
    }
  });

  it("T5 引き継ぎの必須経路が登録済み(MEMORY.md 次のステップ 1 項)", () => {
    const required = [
      "a-closed-form",
      "b-research-on-grid",
      "b-research-off-grid",
      "b-recall-recovery-boundary",
      "c-step-grid",
      "tie-multi-event-same-tick",
      "split-at-recovery-tick",
      "split-at-completion-tick",
      "rng-state-empty-roundtrip",
      "rng-state-nonempty-roundtrip",
      "rng-worldseed-variation",
      "clock-clamp-72h",
      "clock-fallback-one-minute",
      // 2026-07-26 裁定で adj-overcrowd-lexical-top2 から改名(spec §4.4 / §8-9)。
      "adj-overcrowd-effective-limit",
      "fp-mulfix-bigint-fallback",
    ];
    const ids = new Set(registry.paths.map((entry) => entry.id));
    for (const pathId of required) {
      expect(ids.has(pathId)).toBe(true);
    }
  });
});

describe("checkCoverage", () => {
  const smallRegistry: CoverageRegistry = {
    formatVersion: GOLDEN_VECTOR_FORMAT_VERSION,
    paths: [
      {
        id: "p-one",
        title: "one",
        refs: ["ref"],
        observedBy: ["digest"],
        note: "",
      },
      {
        id: "p-two",
        title: "two",
        refs: ["ref"],
        observedBy: ["unit-test"],
        note: "単体テストで担保",
      },
    ],
  };

  it("golden 観測の経路が全部踏まれていれば問題なし", () => {
    expect(checkCoverage(smallRegistry, [vectorOf("v-a", ["p-one"])])).toEqual([]);
  });

  it("unit-test だけの経路はベクタ申告を要求しない", () => {
    const problems = checkCoverage(smallRegistry, [vectorOf("v-a", ["p-one"])]);
    expect(problems.join("\n")).not.toContain("p-two");
  });

  it("踏まれていない golden 観測の経路を検出する", () => {
    const problems = checkCoverage(smallRegistry, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("p-one");
  });

  it("未登録の経路を申告するベクタを検出する", () => {
    const problems = checkCoverage(smallRegistry, [vectorOf("v-a", ["p-one", "p-typo"])]);
    expect(problems.join("\n")).toContain("p-typo");
  });

  it("ID 重複・不正 ID・空 refs / observedBy を検出する", () => {
    const broken: CoverageRegistry = {
      formatVersion: GOLDEN_VECTOR_FORMAT_VERSION,
      paths: [
        { id: "p-one", title: "one", refs: ["r"], observedBy: ["digest"], note: "" },
        { id: "p-one", title: "dup", refs: [], observedBy: [], note: "" },
        { id: "P_BAD", title: "", refs: ["r"], observedBy: ["digest"], note: "" },
      ],
    };
    const problems = checkCoverage(broken, [vectorOf("v-a", ["p-one"])]).join("\n");
    expect(problems).toContain("重複登録");
    expect(problems).toContain("refs が空");
    expect(problems).toContain("observedBy が空");
    expect(problems).toContain("title が空");
    expect(problems).toContain("P_BAD");
  });
});

describe("buildCoverageMatrix", () => {
  it("経路 ID → ベクタ ID(昇順)の対応表を作る", () => {
    const matrix = buildCoverageMatrix(registry, [
      vectorOf("v-b", ["a-closed-form"]),
      vectorOf("v-a", ["a-closed-form", "a-zero-rate"]),
    ]);
    expect(matrix["a-closed-form"]).toEqual(["v-a", "v-b"]);
    expect(matrix["a-zero-rate"]).toEqual(["v-a"]);
    // 未被覆の経路もキーとして現れる(空配列 = 穴が見える)。
    expect(matrix["split-many"]).toEqual([]);
  });

  it("全経路がキーとして現れる", () => {
    const matrix = buildCoverageMatrix(registry, []);
    expect(Object.keys(matrix).length).toBe(registry.paths.length);
  });
});
