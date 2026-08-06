// ---------------------------------------------------------------------------
// [M21] 探索エンジン — GDD 8.1〜8.6 / 12.5-7 / ADR-018(1)
//
// 中心の検収条件は 2 つ:
//   (1) **ROI が距離帯ごと 1.2〜2.0 レンジ(GDD 8.6)に収まる**(実 content で判定)
//   (2) 逆 CDF が段階1(独立サンプリング)に留まり ADR-018(3) の段階2へ
//       踏み込んでいない(= 逐次ストリーム rngState を 1 bit も進めない)
// に加えて、GDD 12.5-7 の「派遣時スナップショット固定・再参照禁止」を
// **content を実際に書き換えて結果が動かないこと**で固定する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import { loadEngineContentOrThrow } from "../../schema/engineContent";
import { advance, advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import {
  CONCURRENT_DISPATCH_MAX,
  DISPATCH_TREE_NODES_MAX,
  activeDispatchCount,
  apply,
  type Command,
} from "../../src/engine/commands";
import { FIX_SCALE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import {
  DISPATCH_TEAM_MAX,
  MAX_RENDERED_LOGS,
  appendRenderedLog,
  buildDispatchSnapshot,
  explorationRoi,
  rareAssetCountOf,
  renderReturnLog,
  travelTicksFor,
} from "../../src/engine/rules/exploration";
import { recallRiskPerDay } from "../../src/engine/rules/recall";
import { recentMemoirHighlights } from "../../src/engine/rules/memoir";
import type { DistanceBand, EngineContent, ExplorationParams } from "../../src/engine/rules/types";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import {
  getDispatch,
  requireEntity,
  type DispatchSnapshot,
  type EntityId,
  type GameState,
} from "../../src/engine/state/state";
import { setTechMemory } from "../../src/engine/state/update";
import { assertDispatchTreeBounds } from "../../src/platform/persistence";
import { worldSeedToUint32 } from "../../src/engine/stochastic";

import { content, facility, HEARTH, id, resource, stateOf, WOOD } from "./fixtures";
import { agedResident, BUNKS, TEST_TOWN } from "./lifespanFixtures";

// --- 実 content(ROI 判定は必ずこちらで行う) --------------------------------

const REAL_CONTENT: EngineContent = loadEngineContentOrThrow(
  (() => {
    const bundle: RawContentBundle = {
      tech: techJson,
      facility: facilityJson,
      trait: traitJson,
      adjacency: adjacencyJson,
      balance: balanceJson,
    };
    const validated = validateContentBundle(bundle);
    if (!validated.ok) throw new Error(`content 検証で落ちた: ${JSON.stringify(validated.issues)}`);
    return validated.value;
  })(),
);

const BANDS: readonly DistanceBand[] = ["near", "far", "deep"];

function requireExploration(engineContent: EngineContent): ExplorationParams {
  const params = engineContent.exploration;
  if (params === undefined) throw new Error("content に exploration ブロックが無い");
  return params;
}

/** 新人(全ステ中立 50・trait なし)を n 人だけ持つ盤面。 */
function newcomerBoard(count: number, engineContent: EngineContent = REAL_CONTENT): GameState {
  const residents = [];
  for (let i = 0; i < count; i++) {
    residents.push(agedResident(`residentRookie${String(i)}`, 0, 400_000));
  }
  void engineContent;
  return stateOf([...residents, resource("resFirewood", id("firewood"))]);
}

const approx = (value: Fix): number => toRaw(value) / FIX_SCALE;

// --- 1. ROI(検収条件・GDD 8.6) ---------------------------------------------

describe("探索 ROI(GDD 8.6)", () => {
  it("**検収条件**: 新人のみの派遣で ROI が距離帯ごと 1.2〜2.0 レンジに収まる", () => {
    // GDD 8.6「ROI は距離帯ごと 1.2〜2.0 のレンジ(新人のみ派遣時)に収める」。
    // 総合力はチーム総和(GDD 8.2)なので ROI は人数に依存する。バランスは
    // **3〜4 名の新人チーム**を校正点にしてあり、その範囲でレンジへ収める。
    for (const band of BANDS) {
      for (const teamSize of [3, 4]) {
        const state = newcomerBoard(teamSize);
        const memberIds = memberIdsOf(state, teamSize);
        const report = explorationRoi(state, REAL_CONTENT, band, memberIds);
        expect(report.roiFix).not.toBeNull();
        const roi = approx(report.roiFix as Fix);
        expect(roi, `${band} / ${String(teamSize)}名`).toBeGreaterThanOrEqual(1.2);
        expect(roi, `${band} / ${String(teamSize)}名`).toBeLessThanOrEqual(2.0);
      }
    }
  });

  it("(B)保持者を混ぜると損失項で ROI が下がる(GDD 8.6 の核心)", () => {
    const teamSize = 3;
    const base = newcomerBoard(teamSize);
    const memberIds = memberIdsOf(base, teamSize);
    const plain = explorationRoi(base, REAL_CONTENT, "near", memberIds);
    expect(plain.rareAssetCount).toBe(0);

    // 先頭メンバーに (B) rareIrreversible の未成文 tech を保持させる。
    const rareTechId = rareIrreversibleTechId();
    const holder = memberIds[0] as EntityId;
    const withRare = setTechMemory(base, `${holder}|${rareTechId}`, {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
    const loaded = explorationRoi(withRare, REAL_CONTENT, "near", memberIds);

    expect(loaded.rareAssetCount).toBe(1);
    expect(toRaw(loaded.expectedRareLossFix)).toBeGreaterThan(0);
    expect(toRaw(loaded.roiFix as Fix)).toBeLessThan(toRaw(plain.roiFix as Fix));
  });

  it("全滅確率は安全曲線の上限で頭打ちになる(GDD 8.5 の理不尽全滅の否定)", () => {
    const params = requireExploration(REAL_CONTENT);
    // 1 名だけの新人チームは全帯で成功確率 0 = 最悪ケース。
    const state = newcomerBoard(1);
    const memberIds = memberIdsOf(state, 1);
    for (const band of BANDS) {
      const report = explorationRoi(state, REAL_CONTENT, band, memberIds);
      expect(toRaw(report.successProbabilityFix)).toBe(0);
      expect(toRaw(report.wipeProbabilityFix)).toBeLessThanOrEqual(toRaw(params.wipeMaxPFix));
    }
  });

  it("(B) 資産の数え方は「未成文 かつ 他に生存保持者が居ない」だけを数える", () => {
    const state = newcomerBoard(2);
    const memberIds = memberIdsOf(state, 2);
    const rareTechId = rareIrreversibleTechId();
    const first = memberIds[0] as EntityId;
    const second = memberIds[1] as EntityId;
    const one = setTechMemory(state, `${first}|${rareTechId}`, {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
    expect(rareAssetCountOf(one, REAL_CONTENT, [first])).toBe(1);
    // 2 人目も保持していれば、1 人を失っても知識は残る = 損失ではない。
    const two = setTechMemory(one, `${second}|${rareTechId}`, {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
    expect(rareAssetCountOf(two, REAL_CONTENT, [first])).toBe(0);
  });
});

function memberIdsOf(state: GameState, count: number): readonly EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) ids.push(id(`residentRookie${String(i)}`));
  void state;
  return ids;
}

// --- 1b. [Phase D] ROI は event 実体を参照する(台帳v20 必-2・R6-A02) --------

/** ROI 検証用の event content(難度 / R / ノード数を狙って作れる最小形)。 */
function contentWithEvents(events: readonly unknown[]): EngineContent {
  const bundle: RawContentBundle = {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
    event: events,
  };
  const validated = validateContentBundle(bundle);
  if (!validated.ok) throw new Error(`content 検証で落ちた: ${JSON.stringify(validated.issues)}`);
  return loadEngineContentOrThrow(validated.value);
}

function roiNodeJson(difficulty: number, rollRange: number): Record<string, unknown> {
  return {
    difficulty,
    R: rollRange,
    statWeights: { vigor: 1 },
    choices: [],
    branches: [{ cond: "true", result: "success", logTemplate: "進んだ。" }],
  };
}

function roiEventJson(
  eventId: string,
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { id: eventId, destTags: ["near"], nodes };
}

describe("[Phase D] 探索 ROI は event 実体(ノード数・難度・R)から出す(台帳v20 必-2)", () => {
  // 新人 = 全ステ中立 50 なので `statWeights {vigor: 1}` の関連総合力は 50 × 人数。
  // 難度 160 / R 60 なら P(3名) = (150 + 60 − 160)/60 = 5/6、P(2名) = 0。
  const singleEvent = [
    roiEventJson("eventNearProbe", [
      roiNodeJson(160, 60),
      roiNodeJson(160, 60),
      roiNodeJson(160, 60),
      roiNodeJson(160, 60),
      roiNodeJson(160, 60),
    ]),
  ];

  it("ノード数・成功確率・期待報酬が event 定義から決まる(距離帯レンジではない)", () => {
    const engineContent = contentWithEvents(singleEvent);
    const state = newcomerBoard(3);
    const memberIds = memberIdsOf(state, 3);
    const report = explorationRoi(state, engineContent, "near", memberIds);

    // 距離帯の nodeCountMin/Max は 3/4(中点 3.5)。event は 5 ノードなので 5。
    expect(approx(report.expectedNodesFix)).toBe(5);
    expect(report.sourceEventIds).toEqual([id("eventNearProbe")]);
    // P = (150 + 60 − 160)/60 = 0.833333(floor 丸め)。
    expect(toRaw(report.successProbabilityFix)).toBe(833333);
    // 期待報酬 = Σ_node P × rewardPerNode(near = 45)。
    expect(approx(report.expectedRewardFix)).toBeCloseTo(5 * 0.833333 * 45, 3);
  });

  it("同じ盤面でも距離帯パラメータのモデルとは別の値になる(R6-A02 の乖離そのもの)", () => {
    const withEvents = contentWithEvents(singleEvent);
    const state = newcomerBoard(3);
    const memberIds = memberIdsOf(state, 3);
    const eventBased = explorationRoi(state, withEvents, "near", memberIds);
    const procedural = explorationRoi(state, REAL_CONTENT, "near", memberIds);
    expect(procedural.sourceEventIds).toEqual([]);
    expect(toRaw(eventBased.successProbabilityFix)).not.toBe(
      toRaw(procedural.successProbabilityFix),
    );
  });

  it("event が 1 本も無い距離帯は M21 の手続きモデルへ 1 bit も変えずに落ちる", () => {
    // near だけに event を置いた content で far / deep を見ると、event 抜きの
    // 実 content と完全に一致する(既存 golden / 縮約 content の互換の根拠)。
    const withEvents = contentWithEvents(singleEvent);
    const state = newcomerBoard(3);
    const memberIds = memberIdsOf(state, 3);
    for (const band of ["far", "deep"] as const) {
      const a = explorationRoi(state, withEvents, band, memberIds);
      const b = explorationRoi(state, REAL_CONTENT, band, memberIds);
      expect(a.sourceEventIds).toEqual([]);
      expect(toRaw(a.successProbabilityFix)).toBe(toRaw(b.successProbabilityFix));
      expect(toRaw(a.expectedRewardFix)).toBe(toRaw(b.expectedRewardFix));
      expect(toRaw(a.expectedNodesFix)).toBe(toRaw(b.expectedNodesFix));
    }
  });

  it("目的地を指定するとその event だけ・省略すると帯の全 event の平均を見る", () => {
    const engineContent = contentWithEvents([
      roiEventJson("eventNearEasy", [
        roiNodeJson(150, 60),
        roiNodeJson(150, 60),
        roiNodeJson(150, 60),
      ]),
      roiEventJson("eventNearHard", [
        roiNodeJson(210, 60),
        roiNodeJson(210, 60),
        roiNodeJson(210, 60),
        roiNodeJson(210, 60),
      ]),
    ]);
    const state = newcomerBoard(3);
    const memberIds = memberIdsOf(state, 3);

    const easy = explorationRoi(state, engineContent, "near", memberIds, {
      destinationId: id("eventNearEasy"),
    });
    const hard = explorationRoi(state, engineContent, "near", memberIds, {
      destinationId: id("eventNearHard"),
    });
    const average = explorationRoi(state, engineContent, "near", memberIds);

    expect(easy.sourceEventIds).toEqual([id("eventNearEasy")]);
    expect(hard.sourceEventIds).toEqual([id("eventNearHard")]);
    expect(average.sourceEventIds).toEqual([id("eventNearEasy"), id("eventNearHard")]);
    // easy: P = 1(150 + 60 >= 150 が roll 0 でも成立)/ hard: P = 0(150 + 60 < 210)。
    expect(toRaw(easy.successProbabilityFix)).toBe(toRaw(fixFromInt(1)));
    expect(toRaw(hard.successProbabilityFix)).toBe(0);
    expect(toRaw(average.successProbabilityFix)).toBe(500000);
    // ノード数の平均 = (3 + 4)/2 = 3.5。
    expect(approx(average.expectedNodesFix)).toBe(3.5);
  });

  it("**GDD 8.1⑤の回復**: 2名は成功確率 0・3名は約 0.75(event 実体で判定)", () => {
    // 難度 167 / R 66 は台帳v20 必-2 の両立条件(R <= 66.7)の設計点。
    const engineContent = contentWithEvents([
      roiEventJson("eventNearCalibrated", [
        roiNodeJson(167, 66),
        roiNodeJson(167, 66),
        roiNodeJson(167, 66),
      ]),
    ]);
    const two = newcomerBoard(2);
    expect(
      toRaw(explorationRoi(two, engineContent, "near", memberIdsOf(two, 2)).successProbabilityFix),
    ).toBe(0);
    const three = newcomerBoard(3);
    const p3 = approx(
      explorationRoi(three, engineContent, "near", memberIdsOf(three, 3)).successProbabilityFix,
    );
    expect(p3).toBeGreaterThan(0.7);
    expect(p3).toBeLessThan(0.8);
  });

  it("choices は方針(stance)ごとに実解決と同じ関数で選ばれ、難度と報酬に効く", () => {
    // 慎重 = successMod(左辺 + successMod × R)、大胆 = rewardMod(報酬 ×(1+mod))。
    const choiceNode = {
      difficulty: 180,
      R: 60,
      statWeights: { vigor: 1 },
      choices: [
        { label: "慎重", effect: { successMod: 0.5 } },
        { label: "大胆", effect: { rewardMod: 0.5 } },
      ],
      branches: [{ cond: "true", result: "success", logTemplate: "進んだ。" }],
    };
    const engineContent = contentWithEvents([
      { id: "eventNearChoice", destTags: ["near"], nodes: [choiceNode, choiceNode, choiceNode] },
    ]);
    const state = newcomerBoard(3);
    const memberIds = memberIdsOf(state, 3);
    const cautious = explorationRoi(state, engineContent, "near", memberIds, {
      stance: "cautious",
    });
    const press = explorationRoi(state, engineContent, "near", memberIds, { stance: "press" });
    // 慎重: P = (150 + 0.5×60 + 60 − 180)/60 = 1.0 / 大胆: P = (150 + 60 − 180)/60 = 0.5
    expect(toRaw(cautious.successProbabilityFix)).toBe(toRaw(fixFromInt(1)));
    expect(toRaw(press.successProbabilityFix)).toBe(500000);
    // 期待報酬: 慎重 = 3 × 1.0 × 45 / 大胆 = 3 × 0.5 × 45 × 1.5 = 101.25
    expect(approx(cautious.expectedRewardFix)).toBe(135);
    expect(approx(press.expectedRewardFix)).toBe(101.25);
  });
});

function rareIrreversibleTechId(): EntityId {
  for (const [techId, def] of REAL_CONTENT.techDefs) {
    if (def.lossClass === "rareIrreversible") return techId;
  }
  throw new Error("実 content に rareIrreversible の tech が無い(テスト前提が崩れている)");
}

// --- 2. テスト用の縮約盤面(派遣〜帰還の全経路) -----------------------------

const EXPLORE_TOWN = { ...TEST_TOWN, arrivalIntervalTicks: 100_000 };

/** 縮約 content + townParams + exploration(数値は読みやすい桁に固定)。 */
function exploreContent(overrides: Partial<ExplorationParams> = {}): EngineContent {
  const base = content();
  const facilityDefs = new Map(base.facilityDefs);
  facilityDefs.set(BUNKS.id, BUNKS);
  const bandBase = {
    baseTravelTicks: 100,
    nodeCountMin: 4,
    nodeCountMax: 4,
    // 難度 200 固定・R=0 → 「チーム総合力 >= 200 なら必ず成功」の決定的な盤面。
    difficultyMin: 200,
    difficultyMax: 200,
    rollRange: 1,
    rewardPerNodeFix: fixFromInt(10),
    rewardResourceId: WOOD,
    injuryPerFailureFix: fixFromInt(20),
    casualtyInjuryThresholdFix: fixFromInt(40),
    rescueChanceFix: fixFromInt(0),
    wipeBasePFix: fixFromInt(0),
  };
  const exploration: ExplorationParams = {
    byBand: { near: bandBase, far: bandBase, deep: bandBase },
    withdrawRewardRatioFix: fixFromInt(0),
    pressInjuryMulFix: fixFromInt(1),
    withdrawInjuryThresholdFix: fixFromInt(1000),
    equipmentBonusFix: fixFromInt(0),
    travelSpeedupMaxFix: fixFromInt(0),
    forgoneOutputPerWorkerTickFix: fixFromInt(1),
    rareAssetValueFix: fixFromInt(100),
    wipeMaxPFix: fixFromInt(1),
    ...overrides,
  };
  return {
    facilityDefs,
    techDefs: base.techDefs,
    adjacency: base.adjacency,
    recallRisk: base.recallRisk,
    coarseTickMinutes: base.coarseTickMinutes,
    town: EXPLORE_TOWN,
    exploration,
  };
}

/** 住民 `count` 名 + 寝床 + 薪在庫の盤面(全員が寿命を持つ)。 */
function exploreBoard(count = 4, lifespanTick = 1_000_000): GameState {
  const residents = [];
  for (let i = 0; i < count; i++) {
    residents.push(agedResident(`residentTeam${String(i)}`, 0, lifespanTick));
  }
  return stateOf([
    ...residents,
    facility("facilityBunks", BUNKS.id, 0, [], 5),
    facility("facilityHearth", HEARTH.id, 10, []),
    resource("resWood", WOOD),
  ]);
}

function dispatchCommand(memberCount: number, overrides: Partial<Command> = {}): Command {
  const teamResidentIds: EntityId[] = [];
  for (let i = 0; i < memberCount; i++) teamResidentIds.push(id(`residentTeam${String(i)}`));
  return {
    kind: "dispatchExpedition",
    dispatchId: id("dispatchAlpha"),
    destinationId: id("destRuins"),
    band: "near",
    stance: "press",
    teamResidentIds,
    ...overrides,
  } as Command;
}

function dispatched(state: GameState, engineContent: EngineContent, memberCount = 4): GameState {
  const result = apply(state, engineContent, dispatchCommand(memberCount));
  if (!result.ok) throw new Error(`派遣が拒否された: ${result.rejection.code}`);
  return result.state;
}

// --- 3. 派遣確定コマンド(GDD 8.1) ------------------------------------------

describe("派遣確定コマンド(GDD 8.1)", () => {
  it("編成と距離帯を受けてスナップショットを 1 本作り、メンバーを派遣中にする", () => {
    const engineContent = exploreContent();
    const state = dispatched(exploreBoard(), engineContent);
    expect(activeDispatchCount(state)).toBe(1);
    const snapshot = getDispatch(state, id("dispatchAlpha"));
    expect(snapshot).toBeDefined();
    expect((snapshot as DispatchSnapshot).band).toBe("near");
    expect((snapshot as DispatchSnapshot).memberIds).toHaveLength(4);
    for (const memberId of (snapshot as DispatchSnapshot).memberIds) {
      const member = requireEntity(state, memberId, "resident");
      expect(member.dispatched).toBe(true);
      // GDD 8.1「派遣中の住民は本拠就労スロットから外れ生産寄与ゼロ」。
      expect(member.assignedFacilityId).toBeNull();
    }
  });

  it("同時派遣枠は 2 本(GDD 8.1)で、3 本目は dispatchSlotsFull", () => {
    const engineContent = exploreContent();
    let state = exploreBoard(6);
    for (let i = 0; i < CONCURRENT_DISPATCH_MAX; i++) {
      const result = apply(
        state,
        engineContent,
        dispatchCommand(2, {
          dispatchId: id(`dispatchSlot${String(i)}`),
          teamResidentIds: [
            id(`residentTeam${String(i * 2)}`),
            id(`residentTeam${String(i * 2 + 1)}`),
          ],
        } as Partial<Command>),
      );
      expect(result.ok).toBe(true);
      if (result.ok) state = result.state;
    }
    const third = apply(
      state,
      engineContent,
      dispatchCommand(2, {
        dispatchId: id("dispatchSlotOver"),
        teamResidentIds: [id("residentTeam4"), id("residentTeam5")],
      } as Partial<Command>),
    );
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.rejection.code).toBe("dispatchSlotsFull");
  });

  it("チーム人数・重複・派遣中・寿命なし・content 不在をそれぞれ別コードで拒否する", () => {
    const engineContent = exploreContent();
    const board = exploreBoard(5);

    const tooMany = apply(board, engineContent, dispatchCommand(DISPATCH_TEAM_MAX + 1) as Command);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.rejection.code).toBe("invalidArgument");

    const duplicated = apply(
      board,
      engineContent,
      dispatchCommand(2, {
        teamResidentIds: [id("residentTeam0"), id("residentTeam0")],
      } as Partial<Command>),
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.rejection.code).toBe("invalidArgument");

    const already = dispatched(board, engineContent, 2);
    const again = apply(
      already,
      engineContent,
      dispatchCommand(2, { dispatchId: id("dispatchBeta") } as Partial<Command>),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.rejection.code).toBe("residentUnavailable");

    // 寿命(life)を持たない住民は全滅リスクを表現できないので拒否する。
    const noLife = stateOf([
      ...[...board.entityStateById.values()].filter((entity) => entity.kind !== "resident"),
      ...[0, 1].map((i) => ({
        kind: "resident" as const,
        id: id(`residentTeam${String(i)}`),
        morale: fixFromInt(50),
        mastery: fixFromInt(0),
        assignedFacilityId: null,
        dispatched: false,
        traitIds: [],
        recallImpairedUntilTick: 0,
      })),
    ]);
    const mortalOnly = apply(noLife, engineContent, dispatchCommand(2));
    expect(mortalOnly.ok).toBe(false);
    if (!mortalOnly.ok) expect(mortalOnly.rejection.code).toBe("residentUnavailable");

    const withoutBlock = apply(board, content(), dispatchCommand(2));
    expect(withoutBlock.ok).toBe(false);
    if (!withoutBlock.ok) expect(withoutBlock.rejection.code).toBe("contentUnsupported");
  });

  it("拒否されたとき state は 1 bit も動かない(§3 の原子適用)", () => {
    const engineContent = exploreContent();
    const board = exploreBoard(2);
    const before = JSON.stringify(toSerializable(board));
    const result = apply(board, engineContent, dispatchCommand(DISPATCH_TEAM_MAX + 1));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(toSerializable(board))).toBe(before);
  });
});

// --- 4. 決定論とスナップショット固定(GDD 8.2 / 12.5-7) ---------------------

describe("スナップショット固定(GDD 12.5-7)", () => {
  it("同じ (worldSeed, 目的地, チーム, tick) なら常に同じイベント列になる", () => {
    const engineContent = exploreContent();
    const board = exploreBoard();
    const seedU32 = worldSeedToUint32(board.worldSeed);
    const input = {
      dispatchId: id("dispatchAlpha"),
      destinationId: id("destRuins"),
      band: "near" as const,
      stance: "press" as const,
      memberIds: [id("residentTeam0"), id("residentTeam1")],
      dispatchTick: 0,
    };
    const first = buildDispatchSnapshot(board, engineContent, seedU32, input);
    const second = buildDispatchSnapshot(board, engineContent, seedU32, input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("チームが違えば別の乱数列になる(seed 材料に teamIds が入っている)", () => {
    const engineContent = exploreContent();
    const board = exploreBoard();
    const seedU32 = worldSeedToUint32(board.worldSeed);
    const make = (memberIds: readonly EntityId[]): DispatchSnapshot =>
      buildDispatchSnapshot(board, engineContent, seedU32, {
        dispatchId: id("dispatchAlpha"),
        destinationId: id("destRuins"),
        band: "near",
        stance: "press",
        memberIds,
        dispatchTick: 0,
      });
    const a = make([id("residentTeam0"), id("residentTeam1")]);
    const b = make([id("residentTeam2"), id("residentTeam3")]);
    // 難度・R は固定でも roll の抽選そのものは別列になる。
    expect(a.nodes.map((n) => toRaw(n.rollFix)).join()).not.toBe(
      b.nodes.map((n) => toRaw(n.rollFix)).join(),
    );
  });

  it("**派遣後に content を書き換えても帰還結果は 1 bit も動かない**(再参照禁止)", () => {
    const engineContent = exploreContent();
    const board = exploreBoard();
    const afterDispatch = dispatched(board, engineContent);
    const returnTick = (getDispatch(afterDispatch, id("dispatchAlpha")) as DispatchSnapshot)
      .returnTick;

    const withOriginal = advance(
      afterDispatch,
      createAdvanceContext(afterDispatch, engineContent),
      returnTick + 1,
    );
    // 週次 content 追加を模して距離帯パラメータを丸ごと差し替える。
    const mutated = exploreContent({
      byBand: (() => {
        const band = {
          baseTravelTicks: 999,
          nodeCountMin: 8,
          nodeCountMax: 8,
          difficultyMin: 999,
          difficultyMax: 999,
          rollRange: 1,
          rewardPerNodeFix: fixFromInt(9999),
          rewardResourceId: WOOD,
          injuryPerFailureFix: fixFromInt(99),
          casualtyInjuryThresholdFix: fixFromInt(10),
          rescueChanceFix: fixFromInt(1),
          wipeBasePFix: fixFromInt(1),
        };
        return { near: band, far: band, deep: band };
      })(),
    });
    const withMutated = advance(
      afterDispatch,
      createAdvanceContext(afterDispatch, mutated),
      returnTick + 1,
    );
    expect(JSON.stringify(toSerializable(withMutated))).toBe(
      JSON.stringify(toSerializable(withOriginal)),
    );
  });

  it("ADR-018(1) 段階1: 派遣は逐次ストリーム(rngState)を 1 bit も進めない", () => {
    const engineContent = exploreContent();
    const board = exploreBoard();
    const afterDispatch = dispatched(board, engineContent);
    expect(afterDispatch.rngState.size).toBe(board.rngState.size);
    const returnTick = (getDispatch(afterDispatch, id("dispatchAlpha")) as DispatchSnapshot)
      .returnTick;
    const resolved = advance(
      afterDispatch,
      createAdvanceContext(afterDispatch, engineContent),
      returnTick + 1,
    );
    // 想起困難の持続(recallDuration)以外のドメインは現れない。
    for (const domain of resolved.rngState.keys()) {
      expect(domain).toBe("recallDuration");
    }
  });

  it("ADR-012(3) の分岐木ノード上界を実スナップショットが守る", () => {
    const engineContent = exploreContent();
    let state = exploreBoard(4);
    state = dispatched(state, engineContent, 2);
    const second = apply(
      state,
      engineContent,
      dispatchCommand(2, {
        dispatchId: id("dispatchBeta"),
        teamResidentIds: [id("residentTeam2"), id("residentTeam3")],
      } as Partial<Command>),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(() => {
      assertDispatchTreeBounds(toSerializable(second.state));
    }).not.toThrow();
    for (const snapshot of second.state.dispatchSnapshots) {
      expect(snapshot.nodes.length).toBeLessThanOrEqual(DISPATCH_TREE_NODES_MAX);
    }
  });
});

// --- 5. 帰還解決(GDD 11.7 段60) --------------------------------------------

describe("帰還解決(段60)", () => {
  it("帰還 tick で報酬が入り、派遣が外れ、レンダリング済みログが積まれる", () => {
    const engineContent = exploreContent();
    const board = exploreBoard();
    const state = dispatched(board, engineContent);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    const ctx = createAdvanceContext(state, engineContent);

    const beforeReturn = advance(state, ctx, snapshot.returnTick);
    expect(activeDispatchCount(beforeReturn)).toBe(1);

    const afterReturn = advance(state, ctx, snapshot.returnTick + 1);
    expect(activeDispatchCount(afterReturn)).toBe(0);
    for (const memberId of snapshot.memberIds) {
      expect(requireEntity(afterReturn, memberId, "resident").dispatched).toBe(false);
    }
    const stock = requireEntity(afterReturn, id("resWood"), "resource").stock;
    expect(toRaw(stock)).toBeGreaterThanOrEqual(toRaw(snapshot.rewardFix));
    expect(afterReturn.renderedLogs.entries).toHaveLength(1);
    const logged = afterReturn.renderedLogs.entries[0];
    expect(logged?.tick).toBe(snapshot.returnTick);
    expect(logged?.text).toBe(
      renderReturnLog(snapshot, 0, { acceptedFix: snapshot.rewardFix, excessFix: FIX_ZERO }),
    );
    expect(typeof logged?.text).toBe("string");
  });

  it("報告カウンタに帰還本数が乗る", () => {
    const engineContent = exploreContent();
    const state = dispatched(exploreBoard(), engineContent);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    const report = advanceWithReport(
      state,
      createAdvanceContext(state, engineContent),
      snapshot.returnTick + 1,
    );
    expect(report.expeditionReturnCount).toBe(1);
  });

  it("分割不変: 帰還 tick ちょうどで区切っても一括と一致する", () => {
    const engineContent = exploreContent();
    const state = dispatched(exploreBoard(), engineContent);
    const ctx = createAdvanceContext(state, engineContent);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    const target = snapshot.returnTick + 37;

    const whole = advance(state, ctx, target);
    for (const cut of [snapshot.returnTick - 1, snapshot.returnTick, snapshot.returnTick + 1]) {
      const split = advance(advance(state, ctx, cut), ctx, target);
      expect(JSON.stringify(toSerializable(split)), `cut=${String(cut)}`).toBe(
        JSON.stringify(toSerializable(whole)),
      );
    }
  });

  it("往復所要 tick はチーム平均 vigor で最大 -30% 短縮される(GDD 8.1)", () => {
    const engineContent = exploreContent({ travelSpeedupMaxFix: fixFromRaw(300_000) });
    const board = exploreBoard(2);
    const ticks = travelTicksFor(board, engineContent, "near", [
      id("residentTeam0"),
      id("residentTeam1"),
    ]);
    // base 100 × (1 − 0.30 × 50/100) = 85。
    expect(ticks).toBe(85);
  });
});

// --- 6. 全滅リスクと人口下限(GDD 8.5 / 7.6 / 11.4-9) ------------------------

describe("全滅リスクと人口下限の絶対保証", () => {
  /** 必ず全ノードで失敗する(難度が総合力より高い)距離帯パラメータ。 */
  function deadlyContent(): EngineContent {
    const base = exploreContent();
    const params = requireExploration(base);
    const band = {
      ...params.byBand.near,
      difficultyMin: 9_999,
      difficultyMax: 9_999,
      injuryPerFailureFix: fixFromInt(50),
      casualtyInjuryThresholdFix: fixFromInt(50),
    };
    return {
      ...base,
      exploration: { ...params, byBand: { near: band, far: band, deep: band } },
    };
  }

  it("負傷が閾値を跨ぐと脱落し、段70 の死亡処理へ回る(全滅もありうる)", () => {
    const engineContent = deadlyContent();
    // 寝床上限 10 → 人口下限 = min(ceil(10×0.5), 6) = 5。8 人居れば 2 名の死は通る。
    const state = dispatched(exploreBoard(8), engineContent, 2);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    expect(snapshot.casualtyMemberIds.length).toBeGreaterThan(0);

    const report = advanceWithReport(
      state,
      createAdvanceContext(state, engineContent),
      snapshot.returnTick + 1,
    );
    expect(report.explorationCasualtyCount).toBe(snapshot.casualtyMemberIds.length);
    expect(report.residentDeathCount).toBe(snapshot.casualtyMemberIds.length);
    for (const casualtyId of snapshot.casualtyMemberIds) {
      const member = requireEntity(report.state, casualtyId, "resident");
      expect(member.life?.diedTick).toBe(snapshot.returnTick);
    }
  });

  it("**人口下限を割る脱落は死亡ゲートで延期される**(GDD 7.6 の絶対保証)", () => {
    const engineContent = deadlyContent();
    // 生存 5 人 = 下限ちょうど。誰が脱落しても死なせられない。
    const state = dispatched(exploreBoard(5), engineContent, 2);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    expect(snapshot.casualtyMemberIds.length).toBeGreaterThan(0);

    const report = advanceWithReport(
      state,
      createAdvanceContext(state, engineContent),
      snapshot.returnTick + 1,
    );
    expect(report.explorationCasualtyCount).toBe(snapshot.casualtyMemberIds.length);
    expect(report.residentDeathCount).toBe(0);
    expect(report.deferredDeathCount).toBeGreaterThan(0);
    // 帰還そのものは成立する(生存者は本拠へ戻る)。
    expect(activeDispatchCount(report.state)).toBe(0);
    for (const memberId of snapshot.memberIds) {
      expect(requireEntity(report.state, memberId, "resident").dispatched).toBe(false);
    }
    // 人口は下限を割っていない。
    let living = 0;
    for (const entity of report.state.entityStateById.values()) {
      if (entity.kind === "resident" && entity.life?.diedTick === null) living++;
    }
    expect(living).toBeGreaterThanOrEqual(5);
  });

  it("撤退(cautious)は負傷の累積を止め、報酬を半減させる(GDD 8.3)", () => {
    const base = exploreContent();
    const params = requireExploration(base);
    const band = {
      ...params.byBand.near,
      difficultyMin: 9_999,
      difficultyMax: 9_999,
      injuryPerFailureFix: fixFromInt(20),
    };
    const engineContent: EngineContent = {
      ...base,
      exploration: {
        ...params,
        withdrawInjuryThresholdFix: fixFromInt(20),
        withdrawRewardRatioFix: fixFromRaw(500_000),
        byBand: { near: band, far: band, deep: band },
      },
    };
    const board = exploreBoard(4);
    const seedU32 = worldSeedToUint32(board.worldSeed);
    const plan = {
      dispatchId: id("dispatchAlpha"),
      destinationId: id("destRuins"),
      band: "near" as const,
      memberIds: [id("residentTeam0"), id("residentTeam1")],
      dispatchTick: 0,
    };
    const cautious = buildDispatchSnapshot(board, engineContent, seedU32, {
      ...plan,
      stance: "cautious",
    });
    const press = buildDispatchSnapshot(board, engineContent, seedU32, {
      ...plan,
      stance: "press",
    });
    expect(cautious.withdrawn).toBe(true);
    expect(cautious.nodes.length).toBeLessThan(press.nodes.length);
    const lastCautious = cautious.nodes[cautious.nodes.length - 1];
    const lastPress = press.nodes[press.nodes.length - 1];
    expect(toRaw(lastCautious?.injuryFix ?? fixFromInt(0))).toBeLessThan(
      toRaw(lastPress?.injuryFix ?? fixFromInt(0)),
    );
  });
});

// --- 7. 保護加入と memoirLog(GDD 7.7 / 7.3) --------------------------------

describe("探索での保護(GDD 7.7)と memoirLog(GDD 7.3)", () => {
  /** 必ず全ノードで成功し、必ず保護が起きる距離帯パラメータ。 */
  function rescueContent(): EngineContent {
    const base = exploreContent();
    const params = requireExploration(base);
    const band = {
      ...params.byBand.near,
      difficultyMin: 1,
      difficultyMax: 1,
      rescueChanceFix: fixFromInt(1),
      nodeCountMin: 2,
      nodeCountMax: 2,
    };
    return {
      ...base,
      exploration: { ...params, byBand: { near: band, far: band, deep: band } },
    };
  }

  it("保護された住民が加入し、保護した側に memoirLog が積まれる", () => {
    const engineContent = rescueContent();
    const state = dispatched(exploreBoard(2), engineContent, 2);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    expect(snapshot.nodes.every((node) => node.rescue)).toBe(true);

    const report = advanceWithReport(
      state,
      createAdvanceContext(state, engineContent),
      snapshot.returnTick + 1,
    );
    expect(report.explorationRescueCount).toBe(snapshot.nodes.length);

    const rescuedId = id("dispatchAlphaRescue0n0");
    const rescued = requireEntity(report.state, rescuedId, "resident");
    // 晴天漂着と別口だが、生成規則(中立値 + seed 決定論の生涯)は同じ。
    expect(rescued.life).toBeDefined();
    expect(rescued.dispatched).toBe(false);
    expect(rescued.memoir?.entries.some((entry) => entry.kind === "arrival")).toBe(true);

    for (const memberId of snapshot.memberIds) {
      const member = requireEntity(report.state, memberId, "resident");
      const rescues = (member.memoir?.entries ?? []).filter(
        (entry) => entry.kind === "explorationRescue",
      );
      expect(rescues).toHaveLength(snapshot.nodes.length);
      const first = rescues[0];
      expect(first?.kind).toBe("explorationRescue");
      if (first?.kind === "explorationRescue") {
        expect(first.rescuedId).toBe(rescuedId);
        expect(first.band).toBe("near");
      }
      // GDD 7.3「記憶の可視化」のハイライトに探索の保護が乗る。
      expect(
        recentMemoirHighlights(member.memoir, 5).some(
          (entry) => entry.kind === "explorationRescue",
        ),
      ).toBe(true);
    }
  });

  it("同じ盤面を刻んで進めても保護の結果が一致する(分割不変)", () => {
    const engineContent = rescueContent();
    const state = dispatched(exploreBoard(2), engineContent, 2);
    const ctx = createAdvanceContext(state, engineContent);
    const snapshot = getDispatch(state, id("dispatchAlpha")) as DispatchSnapshot;
    const target = snapshot.returnTick + 5;
    const whole = advance(state, ctx, target);
    const split = advance(advance(state, ctx, snapshot.returnTick), ctx, target);
    expect(JSON.stringify(toSerializable(split))).toBe(JSON.stringify(toSerializable(whole)));
  });
});

// --- 8. dispatchW の結線(GDD 11.2) ----------------------------------------

describe("dispatchW +0.15 の結線(GDD 11.2)", () => {
  it("派遣中の住民は想起困難の発生確率が dispatchW ぶん上がる", () => {
    const engineContent = exploreContent();
    const board = exploreBoard(2);
    const memberId = id("residentTeam0");
    const before = recallRiskPerDay(
      board,
      engineContent,
      requireEntity(board, memberId, "resident"),
    );
    const after = dispatched(board, engineContent, 2);
    const during = recallRiskPerDay(
      after,
      engineContent,
      requireEntity(after, memberId, "resident"),
    );
    expect(toRaw(during) - toRaw(before)).toBe(toRaw(engineContent.recallRisk.dispatchWFix));
  });
});

// --- 9. セーブ往復(GDD 12.5 / serialize.ts §9) ------------------------------

describe("セーブ往復", () => {
  it("派遣を持つ state の往復がバイト同一(dispatchSnapshots / renderedLogs)", () => {
    const engineContent = exploreContent();
    let state = dispatched(exploreBoard(), engineContent);
    state = appendRenderedLog(state, { tick: 5, text: "テスト用の帰還ログ" });
    const first = JSON.stringify(toSerializable(state));
    const restored = fromSerializable(JSON.parse(first) as unknown);
    expect(JSON.stringify(toSerializable(restored))).toBe(first);
    expect(restored.dispatchSnapshots).toHaveLength(1);
    expect(restored.renderedLogs.entries).toHaveLength(1);
  });

  it("派遣もログも無い state では両キーごと省略される(既存セーブと同一)", () => {
    const serialized = toSerializable(exploreBoard()) as unknown as Record<string, unknown>;
    expect("dispatchSnapshots" in serialized).toBe(false);
    expect("renderedLogs" in serialized).toBe(false);
  });

  it("帰還ログは 50 件で頭打ちになり、超過分は件数へ畳まれる(GDD 8.4)", () => {
    let state = exploreBoard(1);
    for (let i = 0; i < MAX_RENDERED_LOGS + 3; i++) {
      state = appendRenderedLog(state, { tick: i, text: `log${String(i)}` });
    }
    expect(state.renderedLogs.entries).toHaveLength(MAX_RENDERED_LOGS);
    expect(state.renderedLogs.foldedCount).toBe(3);
    expect(state.renderedLogs.entries[0]?.text).toBe("log3");
  });
});
