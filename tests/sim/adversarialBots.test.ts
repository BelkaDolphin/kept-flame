// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 敵対シナリオbot 6種(M37)のテスト — GDD 11.6 / 11.9
//
// 検収条件(ロードマップ M37 行 / タスク指示):
//   ① 6種それぞれが対象の低頻度エッジを決定論的に強制発生させ、ログ証跡
//      (または run 結果の観測)が残る
//   ② (f) はオフライン復帰 72h クランプ(GDD 11.9)が実際に発火することを
//      engine 公開 API(`computeTargetTick`)経由で証明する
//   ③ 同一 seed の再実行が完全一致する(GDD 11.4-5 と同じ流儀)
//
// (a)/(b)/(c)/(d) は M36 の GDD-11.5 テストと同じ「手で作った state を
// 実装へ通す」流儀を使う。理由は sim/strategy/adversarialBots.ts 冒頭 §3 の
// 正直な開示のとおり: 3trait 住民は engine の trait 抽選が未実装のため通常
// プレイでは絶対に出現せず、rareIrreversible(techLens)も era e3 相当の
// 前提研究チェーンを踏まないと解禁されないため、いずれも自然な長時間 run
// では現実的な時間内に踏めない。(e)/(f) は実 content の通常 run / 純関数
// ハーネスで検証する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { canonicalJsonOfState, digestOfCanonicalJson } from "../../conformance/goldenVector";

import {
  ADVERSARIAL_BOTS,
  MAX_TRAITS_PER_RESIDENT_HELD,
  OFFLINE_CLAMP_TICK,
  TICK_MS,
  codifyNeglectBot,
  rareHolderFastestLossBot,
  runAdversarialBotAsNewGame,
  runAdversarialBotFrom,
  simulateClockForwardExploitCycles,
  soleHolderExpeditionWipeBot,
  traitConcentrationBot,
  turtleBot,
} from "../../sim/strategy/adversarialBots";
import { resolveStrategyContent } from "../../sim/strategy/runStrategy";

import { fixFromInt, toRaw } from "../../src/engine/fp";
import {
  combatPowerFix,
  NEUTRAL_RESIDENT_STATS,
  resolveCombatTraitDefs,
} from "../../src/engine/rules/stats";
import { researchEntityOfTech, techMemoryKeyOf } from "../../src/engine/rules/techMemory";
import type { EngineContent } from "../../src/engine/rules/types";
import {
  entityIdFromString,
  livingResidents,
  requireEntity,
  type EntityId,
  type EntityState,
  type ResearchState,
  type ResidentState,
} from "../../src/engine/state/state";
import { createGameState } from "../../src/engine/state/update";
import { worldSeedToUint32 } from "../../src/engine/stochastic";

const eid = entityIdFromString;

/**
 * 探索の報酬は帰還時に resource entity(在庫)へ加算されるため、entity が
 * 無いと `dispatchExpedition` コマンドが `entityNotFound` で reject される
 * (`src/engine/commands.ts` の `applyDispatchExpedition` §「報酬の受け皿」)。
 * 実 content の全距離帯の報酬資源は "firewood"(`content/balance.json`)なので、
 * 手で作る最小 state にも在庫 0 の firewood を必ず 1 件用意する。
 */
function firewoodStockEntity(): EntityState {
  return {
    kind: "resource",
    id: eid("stockFirewood"),
    resourceId: eid("firewood"),
    stock: fixFromInt(0),
  };
}

/** M36 の recallGuard テストと同じ「手で作った state」の共通部品。 */
function soleHolderScenario(
  residentName: string,
  techId: EntityId,
  lifespanTick: number,
): {
  readonly resident: ResidentState;
  readonly research: ResearchState;
  readonly state: ReturnType<typeof createGameState>;
} {
  const resident: ResidentState = {
    kind: "resident",
    id: eid(residentName),
    morale: fixFromInt(60),
    mastery: fixFromInt(0),
    assignedFacilityId: null,
    dispatched: false,
    traitIds: [],
    recallImpairedUntilTick: 0,
    life: { bornTick: 0, lifespanTick, diedTick: null },
  };
  const research: ResearchState = {
    kind: "research",
    id: eid(`res${techId}`),
    techId,
    progress: fixFromInt(0),
    completedTick: 0,
  };
  const entities: EntityState[] = [resident, research, firewoodStockEntity()];
  const state = createGameState(
    {
      saveSchemaVersion: 1,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: `m37-${residentName}`,
      tick: 0,
    },
    entities,
    [],
    [],
    [[techMemoryKeyOf(resident.id, techId), { masteryFix: fixFromInt(1), impairedUntilTick: 0 }]],
  );
  return { resident, research, state };
}

describe("GDD 11.6: 敵対シナリオbot 6種が揃っている", () => {
  it("a〜f の 6 種", () => {
    expect(ADVERSARIAL_BOTS).toHaveLength(6);
  });
});

// --- (a) 唯一保持者を意図的に探索へ送り全滅 --------------------------------
//
// 対象エッジ: GDD 7.4 の (A) 一回性喪失(生存保持者ゼロ・記録ゼロで研究が
// 未完了へ差し戻る)。強制方法: 未成文の唯一保持者(techFireStarting・
// criticalRecoverable)を単独チームで deep/press へ無条件派遣する
// (adversarialBots.ts の soleHolderExpeditionWipeBot)。deep 帯の実 content
// (event.json)ノード難度(130〜170・R 40〜55)は中立ステータス単独チームの
// 理論上限(50+55=105)を常に上回るため、全ノード失敗 → 負傷閾値超過 →
// 単独チームの全滅が確定する。
describe("(a) 唯一保持者を意図的に探索へ送り全滅(GDD 11.6a)", () => {
  const content: EngineContent = resolveStrategyContent();
  const TECH_ID = eid("techFireStarting");
  const RUN_TICKS = 1440 * 8;

  it("単独deep/press派遣を強制し、全滅により(A)一回性喪失(進行度差し戻り)が成立する", () => {
    const { resident, state } = soleHolderScenario("residentSoleFireA", TECH_ID, 1_000_000);
    const result = runAdversarialBotFrom(
      state,
      content,
      soleHolderExpeditionWipeBot,
      worldSeedToUint32(state.worldSeed),
      RUN_TICKS,
    );

    // 証跡①: 強制した瞬間のログ(GDD 11.5 のガードが本来ブロックする対象を
    // わざと派遣したことの機械可読な記録)。
    const forced = result.adversarialLog.filter((e) => e.edge === "soleHolderExpeditionWipe");
    expect(forced.length).toBeGreaterThanOrEqual(1);
    expect(forced[0]?.residentIds).toEqual([resident.id]);
    expect(forced[0]?.techIds).toEqual([TECH_ID]);

    // 証跡②: 単独チームが実際に全滅(死亡)した。
    const finalResident = requireEntity(result.state, resident.id, "resident");
    expect(finalResident.life?.diedTick).not.toBeNull();

    // 証跡③: 唯一保持者の死亡により (A) 一回性喪失が成立(GDD 7.4・
    // `applyTechLossOnDeath` が research entity を未完了へ差し戻す)。
    const research = researchEntityOfTech(result.state, TECH_ID);
    expect(research?.loss).toBeDefined();
    expect(research?.loss?.irreversible).toBe(false);
    expect(research?.completedTick).toBeNull();
  });

  it("同一seedで100回実行しても完全一致する(GDD 11.4-5の流儀)", () => {
    let firstDigest: string | null = null;
    for (let i = 0; i < 100; i++) {
      const { state } = soleHolderScenario("residentSoleFireA", TECH_ID, 1_000_000);
      const result = runAdversarialBotFrom(
        state,
        content,
        soleHolderExpeditionWipeBot,
        worldSeedToUint32(state.worldSeed),
        RUN_TICKS,
      );
      const digest = digestOfCanonicalJson(canonicalJsonOfState(result.state));
      if (firstDigest === null) firstDigest = digest;
      else expect(digest).toBe(firstDigest);
    }
    expect(firstDigest).not.toBeNull();
  }, 60_000);
});

// --- (c) (B)レア保持者を最速で失わせる -------------------------------------
//
// 対象エッジ: GDD 7.4 (B) rareIrreversible の**永久喪失**。強制手段は (a) と
// 完全共有(buildForcedDispatch)、対象を techLens(現 content で唯一の
// rareIrreversible)の唯一保持者に絞る。techLens は era e3 相当(prereq 20本
// 超)なので自然な研究チェーンでは現実的run長で到達できない
// (adversarialBots.ts §3 の正直な開示) → 研究済み(completedTick=0)を
// 手で作った state で前提化する。
describe("(c) (B)レア保持者を最速で失わせる(GDD 11.6c)", () => {
  const content: EngineContent = resolveStrategyContent();
  const TECH_ID = eid("techLens");
  const RUN_TICKS = 1440 * 8;

  it("単独deep/press派遣を強制し、(B)rareIrreversibleが永久に失われる", () => {
    const { resident, state } = soleHolderScenario("residentSoleLensC", TECH_ID, 1_000_000);
    const result = runAdversarialBotFrom(
      state,
      content,
      rareHolderFastestLossBot,
      worldSeedToUint32(state.worldSeed),
      RUN_TICKS,
    );

    const forced = result.adversarialLog.filter((e) => e.edge === "rareHolderFastestLoss");
    expect(forced.length).toBeGreaterThanOrEqual(1);
    const detectedTick = forced[0]?.tick;
    expect(detectedTick).toBeDefined();

    const finalResident = requireEntity(result.state, resident.id, "resident");
    const deathTick = finalResident.life?.diedTick ?? null;
    expect(deathTick).not.toBeNull();

    const research = researchEntityOfTech(result.state, TECH_ID);
    expect(research?.loss).toBeDefined();
    expect(research?.loss?.irreversible).toBe(true);

    // 「最速で失わせる」の実測: 機会を検出した tick から確定喪失(=死亡 tick)
    // までの差。単独 deep 派遣は 1 回の往復(travel + 数ノード)で完結するので、
    // deep 帯の基礎往復 tick(balance.json baseTravelTicks=4320)を大きく超えない。
    if (detectedTick !== undefined && deathTick !== null) {
      const ticksToLoss = deathTick - detectedTick;
      expect(ticksToLoss).toBeGreaterThan(0);
      expect(ticksToLoss).toBeLessThanOrEqual(4320 + 1440);
    }
  });

  it("同一seedで100回実行しても完全一致する(GDD 11.4-5の流儀)", () => {
    let firstDigest: string | null = null;
    for (let i = 0; i < 100; i++) {
      const { state } = soleHolderScenario("residentSoleLensC", TECH_ID, 1_000_000);
      const result = runAdversarialBotFrom(
        state,
        content,
        rareHolderFastestLossBot,
        worldSeedToUint32(state.worldSeed),
        RUN_TICKS,
      );
      const digest = digestOfCanonicalJson(canonicalJsonOfState(result.state));
      if (firstDigest === null) firstDigest = digest;
      else expect(digest).toBe(firstDigest);
    }
    expect(firstDigest).not.toBeNull();
  }, 60_000);
});

// --- (b) 成文化を全サボり ---------------------------------------------------
//
// 対象エッジ: (a)/(c) と同じ「一回性喪失」境界だが、強制手段が違う——
// 積極的な派遣ではなく**単なる無為**(codifyCommand を一度も呼ばない)。
// 寿命が近い(lifespanTick=2000)唯一保持者を手で作り、寿命死だけで喪失が
// 成立することを示す。
describe("(b) 成文化を全サボり(GDD 11.6b)", () => {
  const content: EngineContent = resolveStrategyContent();
  const TECH_ID = eid("techFireStarting");
  const LIFESPAN_TICK = 2000;
  const RUN_TICKS = 1440 * 3;

  it("codifyCommandを一度も呼ばず、寿命死だけで(A)一回性喪失が成立する", () => {
    const { resident, state } = soleHolderScenario("residentSoleFireB", TECH_ID, LIFESPAN_TICK);
    const result = runAdversarialBotFrom(
      state,
      content,
      codifyNeglectBot,
      worldSeedToUint32(state.worldSeed),
      RUN_TICKS,
    );

    // 証跡: bot 内部ログではなく、run 後の state を観測する(§ doc 参照)。
    const finalResident = requireEntity(result.state, resident.id, "resident");
    expect(finalResident.life?.diedTick).toBe(LIFESPAN_TICK);

    const research = researchEntityOfTech(result.state, TECH_ID);
    expect(research?.loss).toBeDefined();
    expect(research?.loss?.irreversible).toBe(false);
    expect(research?.loss?.tick).toBe(LIFESPAN_TICK);
  });

  it("同一seedで100回実行しても完全一致する(GDD 11.4-5の流儀)", () => {
    let firstDigest: string | null = null;
    for (let i = 0; i < 100; i++) {
      const { state } = soleHolderScenario("residentSoleFireB", TECH_ID, LIFESPAN_TICK);
      const result = runAdversarialBotFrom(
        state,
        content,
        codifyNeglectBot,
        worldSeedToUint32(state.worldSeed),
        RUN_TICKS,
      );
      const digest = digestOfCanonicalJson(canonicalJsonOfState(result.state));
      if (firstDigest === null) firstDigest = digest;
      else expect(digest).toBe(firstDigest);
    }
    expect(firstDigest).not.toBeNull();
  }, 30_000);
});

// --- (d) 最強trait3個持ちを重要ポジ集中(trait暴走検出) ----------------------
//
// 対象エッジ: GDD 7.2 のカテゴリ上限クランプ(TRAIT_STAT_MUL_MAX_FIX = 1.3)。
// state.ts の不変条件(traitIds は ID 昇順・重複なし)により「同じ trait を
// 3個」は構造的に作れないため、3個の**異なる** trait とする(要ユーザー判断・
// タスク報告⑤)。現 content で combatPower を mul で押し上げる trait は
// traitExplorer(×1.15)と traitStrongArm(×1.2)の 2 種のみ(他 6 種はどれも
// combatPower に mul で効かない)なので、この 2 つを含む 3trait 構成だけが
// 実際にクランプへ届く組合せになる。
describe("(d) 最強trait3個持ちを重要ポジ集中(GDD 11.6d・trait暴走検出)", () => {
  const content: EngineContent = resolveStrategyContent();
  // ID 昇順(E < M < S): [traitExplorer, traitMemoryKeeper, traitStrongArm]
  const TRAIT_IDS: readonly EntityId[] = [
    eid("traitExplorer"),
    eid("traitMemoryKeeper"),
    eid("traitStrongArm"),
  ];

  function maxedResident(name: string): ResidentState {
    return {
      kind: "resident",
      id: eid(name),
      morale: fixFromInt(60),
      mastery: fixFromInt(0),
      assignedFacilityId: null,
      dispatched: false,
      traitIds: TRAIT_IDS,
      recallImpairedUntilTick: 0,
    };
  }

  it("3trait(異なる3種・重複不可)住民を1チームへ集中させ、ログ証跡を残す", () => {
    expect(TRAIT_IDS).toHaveLength(MAX_TRAITS_PER_RESIDENT_HELD);
    const resident = maxedResident("residentMaxedD");
    const state = createGameState(
      { saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1, worldSeed: "m37-trait", tick: 0 },
      [resident],
    );

    const decision = traitConcentrationBot.decide(state, content, 0, 0);
    const forced = decision.adversarialLog.filter((e) => e.edge === "traitStackConcentration");
    expect(forced).toHaveLength(1);
    expect(forced[0]?.residentIds).toEqual([resident.id]);

    const dispatchCmd = decision.commands.find((c) => c.kind === "dispatchExpedition");
    expect(dispatchCmd).toBeDefined();
    if (dispatchCmd?.kind === "dispatchExpedition") {
      expect(dispatchCmd.teamResidentIds).toEqual([resident.id]);
    }
  });

  it("trait暴走検出: combatPowerのカテゴリ上限クランプ(1.3)が実際に効いている", () => {
    const traits = resolveCombatTraitDefs(TRAIT_IDS, content.traitDefs);
    const actualRaw = toRaw(combatPowerFix(NEUTRAL_RESIDENT_STATS, traits));

    // 手計算(engineと同じfloor演算・T2の「手計算ベクタ」流儀):
    //   vigor: 50 + (traitExplorer +5) + (traitStrongArm +15) = 70(mul無し)
    //   weightedStatSum = 70×0.35 + 50×0.20 + 55×0 + 50×0.30 + 50×0.15
    //                    = 24.5 + 10 + 0 + 15 + 7.5 = 57.0
    //   derivedMul(combatPower) = traitExplorer(1.15) × traitStrongArm(1.2)
    //                            = 1.38 だが都度クランプ([0.7,1.3])で 1.3 に頭打ち
    //   combatPower = clamp(57.0 × 1.3, 0, 100) = 74.1
    const weightedStatSumRaw = 57_000_000;
    const clampedMulRaw = 1_300_000;
    const expectedClampedRaw = Math.floor((weightedStatSumRaw * clampedMulRaw) / 1_000_000);
    expect(actualRaw).toBe(expectedClampedRaw);
    expect(actualRaw).toBe(74_100_000);

    // クランプが無ければ 1.15 × 1.2 = 1.38 のまま複合されていたはず。
    const naiveMulRaw = Math.floor((1_150_000 * 1_200_000) / 1_000_000);
    expect(naiveMulRaw).toBe(1_380_000);
    expect(naiveMulRaw).toBeGreaterThan(clampedMulRaw); // 暴走の芽そのもの
    const naiveCombatPowerRaw = Math.floor((weightedStatSumRaw * naiveMulRaw) / 1_000_000);
    expect(naiveCombatPowerRaw).toBe(78_660_000);

    // 実測 = クランプ後の値 < クランプが無かった場合の値(クランプが実際に発火した証拠)。
    expect(actualRaw).toBeLessThan(naiveCombatPowerRaw);
  });

  it("同一入力で100回呼んでも意思決定が完全一致する(GDD 11.4-5の流儀)", () => {
    const resident = maxedResident("residentMaxedD");
    const state = createGameState(
      { saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1, worldSeed: "m37-trait", tick: 0 },
      [resident],
    );
    let firstJson: string | null = null;
    for (let i = 0; i < 100; i++) {
      const decision = traitConcentrationBot.decide(state, content, 0, 0);
      const json = JSON.stringify(decision);
      if (firstJson === null) firstJson = json;
      else expect(json).toBe(firstJson);
    }
    expect(firstJson).not.toBeNull();
  });
});

// --- (e) 探索を一切行わないturtle bot ---------------------------------------
//
// 対象エッジ: GDD 7.7「探索での保護」が完全に不活性なまま run 全体を終えられ
// るか(探索必須材の設計検証・ソフトロックゼロ GDD 11.4-2)。強制方法:
// buildDispatchCommands を一度も呼ばない。証跡: run 後の dispatchSnapshots /
// dispatchCount が常にゼロ(=「探索での保護」が 1 度も発生し得ない)。
describe("(e) 探索を一切行わないturtle bot(GDD 11.6e)", () => {
  it("長期runでも派遣を一度も発行せず、探索由来の保護加入(rescue)が皆無のまま完走する", () => {
    const result = runAdversarialBotAsNewGame(turtleBot, 1440 * 30, "m37-turtle-seed");
    // 派遣が1件も成立していない(=「探索での保護」が発生しうる余地が皆無)。
    expect(result.state.dispatchSnapshots).toHaveLength(0);
    // ソフトロックしていない(GDD 11.4-2): 生存人口が0にならず完走できている。
    expect(livingResidents(result.state).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("同一seedで100回実行しても完全一致する(GDD 11.4-5の流儀)", () => {
    let firstDigest: string | null = null;
    for (let i = 0; i < 100; i++) {
      const result = runAdversarialBotAsNewGame(turtleBot, 1440 * 4, "m37-turtle-det-seed");
      const digest = digestOfCanonicalJson(canonicalJsonOfState(result.state));
      if (firstDigest === null) firstDigest = digest;
      else expect(digest).toBe(firstDigest);
    }
    expect(firstDigest).not.toBeNull();
  }, 60_000);
});

// --- (f) システムクロック前進exploit再現 ------------------------------------
//
// 対象エッジ: GDD 11.9 のオフライン復帰クランプ(0〜72h = 0〜4320 tick)。
// 強制方法: engine の公開 API(computeTargetTick)へ、システムクロックを
// 巨大に前進させたと主張する経過実時間(ms)を渡すサイクルを繰り返す
// (「クロックを進めて再起動→保存→また進める」の再現)。
describe("(f) システムクロック前進exploit再現(GDD 11.6f / 11.9)", () => {
  it("実10万時間ぶんの経過を主張しても、1サイクルあたりOFFLINE_CLAMP_TICKまでしか許されない", () => {
    const HUGE_MS = 100_000 * 60 * 60 * 1000; // 10万時間(exploit が主張する経過時間)
    const cycles = simulateClockForwardExploitCycles(0, 5, HUGE_MS);
    expect(cycles).toHaveLength(5);
    for (const cycle of cycles) {
      // exploit が稼ごうとした量(attemptedTickDelta)はクランプを大きく超えている。
      expect(cycle.attemptedTickDelta).toBeGreaterThan(OFFLINE_CLAMP_TICK);
      // engine が実際に許した量(grantedTickDelta)はクランプちょうどで頭打ち
      // (= GDD 11.9 のレート制限が実際に発火した証拠)。
      expect(cycle.grantedTickDelta).toBe(OFFLINE_CLAMP_TICK);
    }
    // 「時計を進めて再起動→保存→また進める」をN回繰り返しても、
    // 稼げる tick の総量は cycles × OFFLINE_CLAMP_TICK に留まる(反復による
    // 実質無限消化にはならない・GDD 11.9 後段)。
    const totalGranted = cycles.reduce((sum, c) => sum + c.grantedTickDelta, 0);
    const totalAttempted = cycles.reduce((sum, c) => sum + c.attemptedTickDelta, 0);
    expect(totalGranted).toBe(5 * OFFLINE_CLAMP_TICK);
    expect(totalGranted).toBeLessThan(totalAttempted);
  });

  it("経過時間がクランプ未満なら、主張どおりの tick 差がそのまま通る(過剰検知でないことの確認)", () => {
    const SMALL_MS = 1000 * TICK_MS;
    const cycles = simulateClockForwardExploitCycles(0, 1, SMALL_MS);
    expect(cycles[0]?.grantedTickDelta).toBe(cycles[0]?.attemptedTickDelta);
    expect(cycles[0]?.grantedTickDelta).toBeLessThan(OFFLINE_CLAMP_TICK);
  });

  it("同一入力を100回実行しても完全一致する(純関数・GDD 11.4-5の流儀)", () => {
    const HUGE_MS = 9_000_000_000;
    let firstJson: string | null = null;
    for (let i = 0; i < 100; i++) {
      const cycles = simulateClockForwardExploitCycles(1000, 8, HUGE_MS);
      const json = JSON.stringify(cycles);
      if (firstJson === null) firstJson = json;
      else expect(json).toBe(firstJson);
    }
    expect(firstJson).not.toBeNull();
  });
});
