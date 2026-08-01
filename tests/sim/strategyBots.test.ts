// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 5戦略bot(M36)のテスト — GDD 11.4 / 11.5
//
// 検収条件(ロードマップ M36 行 / タスク指示):
//   ① 同一 seed で 1000 回実行が完全一致(GDD 11.4-5)
//   ② 5戦略bot の戦略差が実測できる(数百〜数千tick run)
//   ③ 複数周回(大移動をまたぐ)実行が可能な構造になっている
//   ④ 「未成文の唯一保持技術を持つ住民は士気<40 で過酷業務・派遣に回さない」
//      (GDD 11.5)判断が実際に踏まれたログ証跡が最低 1 件ある
//
// ①②③は `sim/strategy/runStrategy.ts` の `runStrategyBot`(実 content・
// `createNewGameState` 起点)を直接呼ぶ「実 run」で検証する。④は
// `sim/strategy/commonActions.ts` の判断関数(`buildAssignmentCommands` /
// `buildDispatchCommands`)を、GDD 11.5 の条件を満たすよう手で組み立てた
// 実在しうる state に対して**実際に呼び出し**、ブロック + ログ証跡を確認する
// (conformance の sc テスト群と同じ「手で作った state を実装へ通す」流儀)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { canonicalJsonOfState, digestOfCanonicalJson } from "../../conformance/goldenVector";

import {
  codifyFirstBot,
  explorationFirstBot,
  greedyBot,
  placementVariantBot,
  researchFirstBot,
  STRATEGY_BOTS,
} from "../../sim/strategy/bots";
import {
  boardOutputScore,
  buildAssignmentCommands,
  buildDispatchCommands,
  buildFacilityCommand,
} from "../../sim/strategy/commonActions";
import { RECALL_GUARD_MORALE_THRESHOLD_HUMAN } from "../../sim/strategy/recallGuard";
import { resolveStrategyContent, runStrategyBot } from "../../sim/strategy/runStrategy";

import { fixFromInt, toRaw } from "../../src/engine/fp";
import { techMemoryKeyOf } from "../../src/engine/rules/techMemory";
import type { EngineContent } from "../../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityState,
  type FacilityState,
  type ResearchState,
  type ResidentState,
} from "../../src/engine/state/state";
import { createGameState } from "../../src/engine/state/update";

import {
  content as fixtureContent,
  facility as fixtureFacility,
  stateOf,
  HEARTH,
  FORGE,
} from "../engine/fixtures";

const eid = entityIdFromString;

// --- 1. 決定論(GDD 11.4-5「同一 seed で 1000 回実行が完全一致」) --------------
//
// **run 長は縮めてある**: 1 run(28,800 tick・20 日)は代表比較(§2)には十分だが
// 1000 回まわすと 5 bot 合計で分単位になる。ここでは「bot の意思決定が最低 1 回
// 発火する最小の run」(2,880 tick = 2 日。1 日目に advance→decide→apply が
// 1 回走り、2 日目まで進めた state を比較する)で 1000 回の完全一致を確認する。
// 実測(この開発機・Ryzen 系): 5 bot × 1000 回 ≒ 22 秒(1 run 平均 4.3ms)。
// bot は commonActions.ts の共有部品しか呼ばない純関数なので、この 1 本が
// 5 bot 全部の決定論の根拠になる(個別に別ロジックを持たない)。
describe("決定論(GDD 11.4-5): 同一 seed で 1000 回実行が完全一致", () => {
  const DETERMINISM_RUNS = 1000;
  const DETERMINISM_TOTAL_TICKS = 1440 * 2;

  it.each(STRATEGY_BOTS.map((bot) => [bot.id, bot] as const))(
    "%s: 1000 回とも同一 state(canonical digest 一致)",
    (_id, bot) => {
      let firstDigest: string | null = null;
      for (let i = 0; i < DETERMINISM_RUNS; i++) {
        const result = runStrategyBot({
          bot,
          totalTicks: DETERMINISM_TOTAL_TICKS,
          worldSeed: "m36-determinism-seed",
        });
        const digest = digestOfCanonicalJson(canonicalJsonOfState(result.state));
        if (firstDigest === null) {
          firstDigest = digest;
        } else {
          expect(digest).toBe(firstDigest);
        }
      }
      expect(firstDigest).not.toBeNull();
    },
    90_000,
  );
});

// --- 2. 5戦略bot の戦略差(GDD 11.4-1) ---------------------------------------
//
// 同一 seed・同一 run 長(20 日 = 28,800 tick)で 5 bot を走らせ、各 bot の
// 存在理由になっている不等式を実測する(bots.ts 冒頭の doc と対応)。
describe("5戦略bot の戦略差(GDD 11.4-1)が実測できる", () => {
  const REPRESENTATIVE_SEED = "strategy-representative-seed";
  const REPRESENTATIVE_TOTAL_TICKS = 1440 * 20;

  function run(bot: (typeof STRATEGY_BOTS)[number]) {
    return runStrategyBot({
      bot,
      totalTicks: REPRESENTATIVE_TOTAL_TICKS,
      worldSeed: REPRESENTATIVE_SEED,
    });
  }

  it("研究優先 は貪欲より研究完了数で劣後しない(クリティカルパス優先の効果)", () => {
    const greedy = run(greedyBot);
    const researchFirst = run(researchFirstBot);
    expect(researchFirst.metrics.finalCompletedResearchCount).toBeGreaterThanOrEqual(
      greedy.metrics.finalCompletedResearchCount,
    );
    // 代表 seed では実際に上回ることを固定(実測値はタスク報告に記載)。
    expect(researchFirst.metrics.finalCompletedResearchCount).toBeGreaterThan(
      greedy.metrics.finalCompletedResearchCount,
    );
  });

  it("探索優先 は貪欲より派遣本数が多い", () => {
    const greedy = run(greedyBot);
    const explorationFirst = run(explorationFirstBot);
    expect(explorationFirst.metrics.dispatchCount).toBeGreaterThan(greedy.metrics.dispatchCount);
  });

  it("成文化優先 は貪欲より完成記録数が多い(貪欲は能動的に成文化しない)", () => {
    const greedy = run(greedyBot);
    const codifyFirst = run(codifyFirstBot);
    expect(greedy.metrics.finalCodifiedRecordCount).toBe(0);
    expect(codifyFirst.metrics.finalCodifiedRecordCount).toBeGreaterThan(
      greedy.metrics.finalCodifiedRecordCount,
    );
  });

  it("配置戦略違い は貪欲(素の貪欲配置)の盤面効率を上回らない", () => {
    const greedy = run(greedyBot);
    const placementVariant = run(placementVariantBot);
    // [正直な開示] 現行 content(施設3種・forge は clay 不足で本質的に建設不能)
    // では隣接ボーナスの唯一の受益者(adjacency.json の target=forge)が到達
    // できず、素の貪欲(qualityRatioFix=1.0)と naive(セル番号昇順 first-fit)の
    // 盤面効率が同値になる。それでも「naive は貪欲が評価した候補の 1 つでしか
    // ない以上、貪欲の選択(最大増分)を上回ることは無い」という不等式は
    // 構造的に成立する(§ 配置戦略の機構テストで adjacency が効く場合に固定)。
    expect(placementVariant.metrics.finalBoardOutputScoreRaw).toBeLessThanOrEqual(
      greedy.metrics.finalBoardOutputScoreRaw,
    );
  });
});

// --- 3. 複数周回(大移動をまたぐ実行)が可能な構造(GDD 10.2〜10.5) -----------
describe("複数周回(大移動をまたぐ)実行が可能な構造", () => {
  it("exodusIntervalTicks を指定すると実際に大移動が複数回成立する", () => {
    const result = runStrategyBot({
      bot: greedyBot,
      totalTicks: 1440 * 45,
      worldSeed: "m36-exodus-cycle-seed",
      exodusIntervalTicks: 1440 * 15,
    });
    expect(result.metrics.exodusCount).toBeGreaterThanOrEqual(1);
    // 大移動後も人口下限を割らずに周回できていること(詰み防止の生存確認)。
    expect(result.metrics.finalLivingPopulation).toBeGreaterThanOrEqual(1);
    // worldSeed が周回のたびに導出し直されている(state.worldSeed が初期値と
    // 異なる = 少なくとも 1 回は実際に `executeExodus` を通ったことの傍証)。
    expect(result.state.worldSeed).not.toBe("m36-exodus-cycle-seed");
  }, 30_000);
});

// --- 4. GDD 11.5 想起リスクガードの証跡 -------------------------------------
//
// 「未成文の唯一保持技術を持つ住民は士気<40 で過酷業務・派遣に回さない」を、
// 実在しうる state(実 content・実 entity 形状)に対して buildAssignmentCommands /
// buildDispatchCommands を実際に呼び、①ブロックされたこと ②ログ証跡が
// 残ることの両方を確認する。
describe("GDD 11.5: 想起リスクガードが実際にブロックしたログ証跡", () => {
  const content: EngineContent = resolveStrategyContent();
  const HEARTH_DEF_ID = eid("hearth");
  const FORGE_DEF_ID = eid("forge");
  const TECH_ID = eid("techFireStarting");

  function residentOf(name: string, moraleHuman: number, withLife: boolean): ResidentState {
    const base: ResidentState = {
      kind: "resident",
      id: eid(name),
      morale: fixFromInt(moraleHuman),
      mastery: fixFromInt(0),
      assignedFacilityId: null,
      dispatched: false,
      traitIds: [],
      recallImpairedUntilTick: 0,
    };
    if (!withLife) return base;
    return { ...base, life: { bornTick: 0, lifespanTick: 1_000_000, diedTick: null } };
  }

  it("過酷業務(forge)への配属をブロックし、他の住民の配属は妨げない", () => {
    // residentSole: 士気 30(<40)・techFireStarting の唯一の生存保持者(未成文)。
    const residentSole = residentOf(
      "residentBSole",
      RECALL_GUARD_MORALE_THRESHOLD_HUMAN - 10,
      false,
    );
    // residentOk: 士気 60(閾値以上)・保持技術なし。forge が空いていれば普通に就く。
    const residentOk = residentOf("residentAOk", 60, false);

    const research: ResearchState = {
      kind: "research",
      id: eid("resFireStarting"),
      techId: TECH_ID,
      progress: fixFromInt(0),
      completedTick: 100,
    };
    const forge1: FacilityState = {
      kind: "facility",
      id: eid("facForge1"),
      defId: FORGE_DEF_ID,
      level: 1,
      cellIndex: 0,
      workerIds: [],
      footprint: { width: 2, height: 1 },
    };
    const forge2: FacilityState = {
      kind: "facility",
      id: eid("facForge2"),
      defId: FORGE_DEF_ID,
      level: 1,
      cellIndex: 20,
      workerIds: [],
      footprint: { width: 2, height: 1 },
    };

    const entities: EntityState[] = [residentOk, residentSole, research, forge1, forge2];
    const state = createGameState(
      {
        saveSchemaVersion: 1,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "recallGuardTest",
        tick: 200,
      },
      entities,
      [],
      [],
      [
        [
          techMemoryKeyOf(residentSole.id, TECH_ID),
          { masteryFix: fixFromInt(1), impairedUntilTick: 0 },
        ],
      ],
    );

    const result = buildAssignmentCommands(
      state,
      content,
      { defPriority: [HEARTH_DEF_ID, FORGE_DEF_ID] },
      state.tick,
      "testBot",
    );

    // residentOk だけが forge へ配属される(assignResident コマンドは 1 件だけ)。
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ kind: "assignResident", residentId: residentOk.id });

    // ブロックのログ証跡が実際に残っている(検収条件④)。
    expect(result.recallGuardLog).toHaveLength(1);
    expect(result.recallGuardLog[0]).toMatchObject({
      botId: "testBot",
      residentId: residentSole.id,
      action: "harshAssignment",
      techIds: [TECH_ID],
    });
  });

  it("探索派遣の候補プールからも同じ住民が除外され、ログが残る", () => {
    const residentSole = residentOf(
      "residentBSole",
      RECALL_GUARD_MORALE_THRESHOLD_HUMAN - 10,
      true,
    );
    const residentOk1 = residentOf("residentAOk1", 60, true);
    const residentOk2 = residentOf("residentAOk2", 60, true);
    const residentOk3 = residentOf("residentAOk3", 60, true);

    const research: ResearchState = {
      kind: "research",
      id: eid("resFireStarting"),
      techId: TECH_ID,
      progress: fixFromInt(0),
      completedTick: 100,
    };

    const entities: EntityState[] = [residentOk1, residentOk2, residentOk3, residentSole, research];
    const state = createGameState(
      {
        saveSchemaVersion: 1,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "recallGuardDispatch",
        tick: 200,
      },
      entities,
      [],
      [],
      [
        [
          techMemoryKeyOf(residentSole.id, TECH_ID),
          { masteryFix: fixFromInt(1), impairedUntilTick: 0 },
        ],
      ],
    );

    const result = buildDispatchCommands(
      state,
      content,
      state.tick,
      {
        bands: ["near"],
        teamSize: 2,
        maxNewDispatchesPerTick: 1,
        minIdlePoolSlack: 0,
        stance: "cautious",
      },
      "testBot",
    );

    expect(result.recallGuardLog).toHaveLength(1);
    expect(result.recallGuardLog[0]).toMatchObject({
      botId: "testBot",
      residentId: residentSole.id,
      action: "dispatch",
      techIds: [TECH_ID],
    });

    // 派遣が成立していれば、residentSole はメンバーに含まれていないこと。
    for (const command of result.commands) {
      expect(command.teamResidentIds).not.toContain(residentSole.id);
    }
  });
});

// --- 5. 配置戦略(assist=素の貪欲 vs naive)の機構(GDD 11.4-1「配置戦略違い」) --
//
// 実 content(forge が clay 不足で建設不能・§2 の正直な開示)では隣接ボーナスの
// 差が観測できないため、隣接が実際に効く縮約 content(tests/engine/fixtures.ts
// の heat|heat +20%・target=any)で `buildFacilityCommand` の 2 方針を直接比較し、
// 「assist(素の貪欲)は naive(セル番号昇順 first-fit)以上の盤面効率になる」
// という構造的な不等式そのものを固定する。
describe("配置戦略(assist vs naive)の機構(隣接ボーナスが効く縮約 content)", () => {
  it("assist は naive を上回る盤面効率になる(同一候補集合からの最大選択)", () => {
    const testContent = fixtureContent();
    const existingHearth = fixtureFacility("hearthExisting", HEARTH.id, 0);
    // 貪欲(qualityRatioFix=1.0)は全セルを評価して最大増分の場所(= 既存 hearth
    // に隣接する cellIndex 6・行方向の隣)を選ぶ。naive はセル番号昇順の
    // first-fit なので、cellIndex 1 を埋めて「既存 hearth の直右」を塞いでおくと
    // 次の空きは cellIndex 2(既存 hearth と非隣接)になり、両者が実際に異なる
    // セルを選ぶ(下記で実測・固定)。
    const blocker = fixtureFacility("blocker1", HEARTH.id, 1);
    const state = stateOf([existingHearth, blocker]);

    const assistCommand = buildFacilityCommand(state, testContent, {
      defPriority: [FORGE.id],
      placement: "assist",
    });
    const naiveCommand = buildFacilityCommand(state, testContent, {
      defPriority: [FORGE.id],
      placement: "naive",
    });
    expect(assistCommand).toBeDefined();
    expect(naiveCommand).toBeDefined();
    // 実際に異なるセルを選んでいること(戦略が違うことそのものの確認)。
    expect(assistCommand?.cellIndex).toBe(6);
    expect(naiveCommand?.cellIndex).toBe(2);

    // 別々の提案なので、それぞれを同じ元 state へ適用してから比較する。
    const scoreAfter = (command: NonNullable<typeof assistCommand>): number => {
      const entities: EntityState[] = [
        existingHearth,
        blocker,
        {
          kind: "facility",
          id: command.facilityId,
          defId: command.defId,
          level: 1,
          cellIndex: command.cellIndex,
          workerIds: [],
        },
      ];
      const nextState = stateOf(entities);
      return toRaw(boardOutputScore(nextState, testContent));
    };

    const assistScore = scoreAfter(assistCommand!);
    const naiveScore = scoreAfter(naiveCommand!);
    // 実測(2026-08 時点): assist=4,200,000 raw(3.5 相当。隣接ボーナス込み) /
    // naive=3,800,000 raw(3.17 相当。隣接ボーナス無し)。
    expect(assistScore).toBe(4_200_000);
    expect(naiveScore).toBe(3_800_000);
    expect(assistScore).toBeGreaterThan(naiveScore);
  });
});
