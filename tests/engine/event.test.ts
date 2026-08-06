// ---------------------------------------------------------------------------
// [M22] event ランタイム — GDD 8.2〜8.4 / 11.1 追補 / 12.1 / 12.2
//
// 固定する点:
//   1. content に event が無い盤面では M21 と**バイト同一**(縮約互換の根拠)
//   2. ノード列が content 由来へ差し替わる(差し替え点は buildDispatchSnapshot 1 箇所)
//   3. choices の質的分岐(GDD 8.3)が判定の**前**に効く + choiceKey が salt へ入る
//   4. branches の cond 評価 → result / logTemplate(GDD 8.4 の完成文字列)
//   5. 効果プリミティブ `destroyRecords{medium, scope}`(GDD 11.1 追補)
//   6. [M64] 探索報酬の保管上限会計(GDD 6.7 の加算式上限 + スポンジ + 実受領額ログ)
//   7. ローダーの reject(未知プレースホルダ / 無条件成立でない末尾 branch /
//      正本語彙でない statWeights / 距離帯不一致)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { validateContentBundle, type RawContentBundle } from "../../schema/contentBundle";
import { loadEngineContent, loadEngineContentOrThrow } from "../../schema/engineContent";
import { validateEvent } from "../../schema/event";

import { FIX_ONE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import {
  destroyRecords,
  effectiveDifficultyFix,
  effectiveTeamPowerFix,
  eventDefForDestination,
  nodeInjuryGainFix,
  nodeRewardFix,
  renderLogTemplate,
  selectChoiceIndex,
  LOG_TEMPLATE_PLACEHOLDERS,
} from "../../src/engine/rules/event";
import {
  buildDispatchSnapshot,
  renderReturnLog,
  resolveExpedition,
  type RewardIntake,
} from "../../src/engine/rules/exploration";
import { isCodified } from "../../src/engine/rules/codify";
import { RulesError, type EngineContent, type EventNodeDef } from "../../src/engine/rules/types";
import { createAdvanceContext } from "../../src/engine/advance";
import { apply } from "../../src/engine/commands";
import { fromSerializable, toSerializable } from "../../src/engine/state/serialize";
import {
  entityIdFromString,
  requireEntity,
  type CodifyState,
  type DispatchSnapshot,
  type EntityId,
  type EntityState,
  type GameState,
  type ResearchState,
} from "../../src/engine/state/state";
import { createGameState, setTechMemory } from "../../src/engine/state/update";
import { worldSeedToUint32 } from "../../src/engine/stochastic";

import { agedResident } from "./lifespanFixtures";
import { id, resource } from "./fixtures";

// --- 0. content の組み立て ---------------------------------------------------

const BASE_RAW: RawContentBundle = {
  tech: techJson,
  facility: facilityJson,
  trait: traitJson,
  adjacency: adjacencyJson,
  balance: balanceJson,
};

function loadWith(
  events: readonly unknown[],
  balancePatch?: (balance: Record<string, unknown>) => Record<string, unknown>,
): EngineContent {
  const balance =
    balancePatch === undefined
      ? balanceJson
      : balancePatch(JSON.parse(JSON.stringify(balanceJson)) as Record<string, unknown>);
  const validated = validateContentBundle({ ...BASE_RAW, balance, event: events });
  if (!validated.ok) throw new Error(`content 検証で落ちた: ${JSON.stringify(validated.issues)}`);
  return loadEngineContentOrThrow(validated.value);
}

function loadIssues(events: readonly unknown[]): readonly string[] {
  const validated = validateContentBundle({ ...BASE_RAW, event: events });
  if (!validated.ok) return validated.issues.map((i) => `${i.path}: ${i.message}`);
  const loaded = loadEngineContent(validated.value);
  if (loaded.ok) return [];
  return loaded.issues.map((i) => `${i.path}: ${i.message}`);
}

const NO_EVENT_CONTENT: EngineContent = loadWith([]);

/**
 * 近郊 3 ノードの最小 event。難度は content の距離帯レンジ(near = 135〜225)と
 * 独立に指定できるので、成功/失敗を意図どおりに作れる。
 */
function eventJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "eventNearProbe",
    destTags: ["near"],
    nodes: [nodeJson(), nodeJson(), nodeJson()],
    ...overrides,
  };
}

function nodeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    difficulty: 100,
    R: 20,
    statWeights: { vigor: 1 },
    choices: [],
    branches: [
      {
        cond: "teamPower >= difficulty",
        result: "success",
        logTemplate: "{band}の{node}番目を踏破した(力{teamPower}/難度{difficulty})。",
      },
      { cond: "true", result: "failure", logTemplate: "{node}番目で足を止めた。" },
    ],
    ...overrides,
  };
}

// --- 1. 盤面 -----------------------------------------------------------------

const DISPATCH_ID = id("dispatchProbe");
const EVENT_ID = id("eventNearProbe");

function boardOf(extra: readonly EntityState[] = [], count = 3): GameState {
  const residents: EntityState[] = [];
  for (let i = 0; i < count; i++) {
    residents.push(agedResident(`residentRookie${String(i)}`, 0, 400_000));
  }
  return createGameState(
    {
      saveSchemaVersion: 4,
      contentVersion: 1,
      algoVersion: 1,
      worldSeed: "seedAlpha",
      tick: 0,
    },
    [...residents, resource("resFirewood", id("firewood")), ...extra],
  );
}

function memberIds(count = 3): readonly EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < count; i++) ids.push(id(`residentRookie${String(i)}`));
  return ids;
}

function snapshotOf(
  content: EngineContent,
  destinationId: EntityId,
  stance: "cautious" | "press" = "cautious",
  state: GameState = boardOf(),
): DispatchSnapshot {
  return buildDispatchSnapshot(state, content, worldSeedToUint32(state.worldSeed), {
    dispatchId: DISPATCH_ID,
    destinationId,
    band: "near",
    stance,
    memberIds: memberIds(),
    dispatchTick: 0,
  });
}

/** [M64] 保管上限が無い盤面の受入結果(= 粗報酬が満額入る)。 */
function fullIntake(snapshot: DispatchSnapshot): RewardIntake {
  return { acceptedFix: snapshot.rewardFix, excessFix: FIX_ZERO };
}

// --- 2. 縮約互換(検収の根幹) -----------------------------------------------

describe("event ランタイム — content に event が無ければ M21 と同一", () => {
  it("eventDefs がキーごと存在しない(空 Map も作らない)", () => {
    expect(NO_EVENT_CONTENT.eventDefs).toBeUndefined();
  });

  it("目的地に対応する event が無ければノードは手続き生成のまま", () => {
    const withEvents = loadWith([eventJson()]);
    const plain = snapshotOf(NO_EVENT_CONTENT, id("destUnknown"));
    // event を持つ content でも、目的地 ID が event を指していなければ同じ結果。
    const same = snapshotOf(withEvents, id("destUnknown"));
    expect(JSON.stringify(same)).toBe(JSON.stringify(plain));
    expect(plain.eventId).toBeUndefined();
    for (const node of plain.nodes) {
      expect(node.choiceIndex).toBeUndefined();
      expect(node.branchIndex).toBeUndefined();
      expect(node.logText).toBeUndefined();
      expect(node.effects).toBeUndefined();
    }
  });

  it("手続き生成の帰還ログは M21 の形のまま(分岐ログを足さない)", () => {
    const plain = snapshotOf(NO_EVENT_CONTENT, id("destUnknown"));
    const text = renderReturnLog(plain, 0, fullIntake(plain));
    expect(text).toMatch(/^近郊探索「destUnknown」より3名が帰還。/);
    expect(text.endsWith("。")).toBe(true);
  });

  it("手続き生成のスナップショットは直列化しても M21 のキー集合のまま", () => {
    const plain = snapshotOf(NO_EVENT_CONTENT, id("destUnknown"));
    const state = createGameState(
      {
        saveSchemaVersion: 4,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "seedAlpha",
        tick: 0,
      },
      [...boardOf().entityStateById.values()],
      [],
      [],
      [],
      [plain],
    );
    const json = JSON.stringify(toSerializable(state));
    expect(json).not.toContain("eventId");
    expect(json).not.toContain("choiceIndex");
    expect(json).not.toContain("logText");
    expect(json).not.toContain("effects");
  });
});

// --- 3. ノード列の差し替え(GDD 8.2) ----------------------------------------

describe("event ランタイム — ノード列が content 由来になる", () => {
  const content = loadWith([eventJson()]);

  it("ノード数と難度が event 定義そのものになる", () => {
    const snapshot = snapshotOf(content, EVENT_ID);
    expect(snapshot.eventId).toBe(EVENT_ID);
    expect(snapshot.nodes).toHaveLength(3);
    for (const node of snapshot.nodes) {
      expect(toRaw(node.difficultyFix)).toBe(toRaw(fixFromInt(100)));
      // R = 20 なので roll は 0..20。
      expect(toRaw(node.rollFix)).toBeGreaterThanOrEqual(0);
      expect(toRaw(node.rollFix)).toBeLessThanOrEqual(toRaw(fixFromInt(20)));
    }
  });

  it("関連ステータスはノードの statWeights で決まる(GDD 8.2)", () => {
    // vigor 1.0 の 3 人(中立 50)= 150 >= 難度 100 なので全ノード成功。
    const vigor = snapshotOf(content, EVENT_ID);
    for (const node of vigor.nodes) expect(node.success).toBe(true);

    // intellect 1.0 に振り替えても中立住民は同じ 50 なので結果は変わらないが、
    // 重みを 0.5 にすると 75 < 100 で全ノード失敗になる = 重みが効いている証拠。
    const halved = loadWith([
      eventJson({ nodes: [halfWeightNode(), halfWeightNode(), halfWeightNode()] }),
    ]);
    const weak = snapshotOf(halved, EVENT_ID);
    for (const node of weak.nodes) expect(node.success).toBe(false);
  });

  it("destTags に無い距離帯へ派遣すると RulesError(黙って手続き生成へ落ちない)", () => {
    expect(() => eventDefForDestination(content, EVENT_ID, "deep")).toThrow(RulesError);
  });

  it("combatPower の重みは基礎ステと別扱いで解決される(裁定 B8)", () => {
    const combat = loadWith([
      eventJson({
        nodes: [combatNode(), combatNode(), combatNode()],
      }),
    ]);
    const def = eventDefForDestination(combat, EVENT_ID, "near");
    const node = def?.nodes[0] as EventNodeDef;
    expect(toRaw(node.combatPowerWeightFix)).toBe(toRaw(FIX_ONE));
    expect(toRaw(node.statWeights.vigor)).toBe(0);
  });
});

function halfWeightNode(): Record<string, unknown> {
  return nodeJson({ statWeights: { vigor: 0.5 } });
}

function combatNode(): Record<string, unknown> {
  return nodeJson({ statWeights: { combatPower: 1 } });
}

// --- 4. choices(GDD 8.3 の判定前の質的分岐) --------------------------------

describe("event ランタイム — choices(GDD 8.3)", () => {
  const choiceEvent = eventJson({
    nodes: [choiceNode(), choiceNode(), choiceNode()],
  });
  const content = loadWith([choiceEvent]);

  it("cautious は successMod 最大 / press は rewardMod 最大を選ぶ", () => {
    const def = eventDefForDestination(content, EVENT_ID, "near");
    const node = def?.nodes[0] as EventNodeDef;
    expect(selectChoiceIndex(node, "cautious")).toBe(0);
    expect(selectChoiceIndex(node, "press")).toBe(1);
    expect(selectChoiceIndex({ ...node, choices: [] }, "cautious")).toBeUndefined();
  });

  it("選ばれた choice の添字がスナップショットへ焼かれる", () => {
    expect(snapshotOf(content, EVENT_ID, "cautious").nodes[0]?.choiceIndex).toBe(0);
    expect(snapshotOf(content, EVENT_ID, "press").nodes[0]?.choiceIndex).toBe(1);
  });

  it("choiceKey が salt へ入る(選択が違えば roll が独立・ADR-007)", () => {
    // 同じ (worldSeed, 派遣, ノード) でも choice が違えば別の乱数列になる。
    const cautious = snapshotOf(content, EVENT_ID, "cautious");
    const press = snapshotOf(content, EVENT_ID, "press");
    const rolls = (s: DispatchSnapshot): readonly number[] => s.nodes.map((n) => toRaw(n.rollFix));
    expect(rolls(cautious)).not.toEqual(rolls(press));
  });

  it("難度・報酬・負傷の各係数が仕様どおりに掛かる", () => {
    const def = eventDefForDestination(content, EVENT_ID, "near");
    const node = def?.nodes[0] as EventNodeDef;
    const cautiousChoice = node.choices[0];
    const pressChoice = node.choices[1];

    // difficulty × (1 + difficultyMod)。cautious の difficultyMod は 0。
    expect(toRaw(effectiveDifficultyFix(node, cautiousChoice))).toBe(toRaw(fixFromInt(100)));
    // press は difficultyMod +0.2 → 120。
    expect(toRaw(effectiveDifficultyFix(node, pressChoice))).toBe(toRaw(fixFromInt(120)));
    // successMod × R を左辺へ足す(cautious: +0.25 × 20 = +5)。
    expect(toRaw(effectiveTeamPowerFix(fixFromInt(100), FIX_ZERO, node, cautiousChoice))).toBe(
      toRaw(fixFromInt(105)),
    );
    // rewardMod(cautious: -0.5)→ 報酬半分。
    expect(toRaw(nodeRewardFix(fixFromInt(100), cautiousChoice))).toBe(toRaw(fixFromInt(50)));
    // injuryRiskMul(press: 1.5)× stance 倍率(press: 1.5)= 2.25。
    expect(toRaw(nodeInjuryGainFix(fixFromInt(10), pressChoice, fixFromRaw(1_500_000)))).toBe(
      toRaw(fixFromRaw(22_500_000)),
    );
  });

  it("choice が無いノードでは choiceIndex を持たない", () => {
    const plain = loadWith([eventJson()]);
    expect(snapshotOf(plain, EVENT_ID).nodes[0]?.choiceIndex).toBeUndefined();
  });
});

function choiceNode(): Record<string, unknown> {
  return nodeJson({
    choices: [
      { label: "慎重に進む", effect: { successMod: 0.25, rewardMod: -0.5 } },
      {
        label: "大胆に踏み込む",
        effect: { rewardMod: 0.4, difficultyMod: 0.2, injuryRiskMul: 1.5 },
      },
    ],
  });
}

// --- 5. branches と logTemplate(GDD 8.4 / 12.2) ----------------------------

describe("event ランタイム — branches と帰還ログ", () => {
  const content = loadWith([eventJson()]);

  it("cond が真の branch が選ばれ、logTemplate がレンダリング済みで焼かれる", () => {
    const snapshot = snapshotOf(content, EVENT_ID);
    const node = snapshot.nodes[0];
    expect(node?.branchIndex).toBe(0);
    expect(node?.logText).toBe("近郊の1番目を踏破した(力150/難度100)。");
  });

  it("失敗側は末尾の無条件成立 branch へ落ちる", () => {
    const weak = loadWith([
      eventJson({ nodes: [halfWeightNode(), halfWeightNode(), halfWeightNode()] }),
    ]);
    const snapshot = snapshotOf(weak, EVENT_ID);
    expect(snapshot.nodes[0]?.branchIndex).toBe(1);
    expect(snapshot.nodes[0]?.logText).toBe("1番目で足を止めた。");
  });

  it("帰還ログは要約行 + ノード順の分岐ログの連結(完成文字列)", () => {
    const snapshot = snapshotOf(content, EVENT_ID);
    const text = renderReturnLog(snapshot, 0, fullIntake(snapshot));
    expect(text).toContain("近郊探索「eventNearProbe」より3名が帰還");
    expect(text).toContain("近郊の1番目を踏破した");
    expect(text).toContain("近郊の3番目を踏破した");
    // 分岐ログはノード順(1 → 2 → 3)。
    expect(text.indexOf("1番目")).toBeLessThan(text.indexOf("2番目"));
  });

  it("logTemplate の全プレースホルダが置換される(未置換の {…} が残らない)", () => {
    const allPlaceholders = LOG_TEMPLATE_PLACEHOLDERS.map((n) => `{${n}}`).join("/");
    const withAll = loadWith([
      eventJson({
        nodes: [
          nodeJson({
            branches: [{ cond: "true", result: "continue", logTemplate: allPlaceholders }],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    const logText = snapshotOf(withAll, EVENT_ID).nodes[0]?.logText ?? "";
    expect(logText).not.toMatch(/[{}]/);
    expect(logText.split("/")).toHaveLength(LOG_TEMPLATE_PLACEHOLDERS.length);
  });

  it("renderLogTemplate は整数部だけを出す(丸め規約がログへ漏れない)", () => {
    const text = renderLogTemplate("{teamPower}/{difficulty}/{roll}", {
      band: "近郊",
      event: "eventX",
      node: 1,
      members: 3,
      teamPowerFix: fixFromRaw(150_999_999),
      difficultyFix: fixFromRaw(99_000_001),
      rollFix: fixFromRaw(20_500_000),
      injuryCount: 0,
    });
    expect(text).toBe("150/99/20");
  });

  it("result: withdraw はそのノードで探索を打ち切り報酬を半分にする(GDD 8.3)", () => {
    const withdrawEvent = loadWith([
      eventJson({
        nodes: [
          nodeJson({
            branches: [{ cond: "true", result: "withdraw", logTemplate: "引き返した。" }],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    const snapshot = snapshotOf(withdrawEvent, EVENT_ID);
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.withdrawn).toBe(true);
    // [M39] 1 ノード成功ぶんの報酬の半分。
    // [Phase D / M41] near の `rewardPerNode` を 45 → 33 へ再校正したので 16.5。
    expect(toRaw(snapshot.rewardFix)).toBe(16_500_000);
  });
});

// --- 6. destroyRecords(GDD 11.1 [2026-07-27追補]) ---------------------------

function codify(
  name: string,
  techId: string,
  medium: "paper" | "stoneTablet",
  completedTick: number | null = 1,
): CodifyState {
  return {
    kind: "codify",
    id: id(name),
    techId: entityIdFromString(techId),
    medium,
    requiredWork: fixFromInt(1),
    progress: fixFromInt(1),
    completedTick,
  };
}

function research(name: string, techId: string, completedTick: number | null): ResearchState {
  return {
    kind: "research",
    id: id(name),
    techId: entityIdFromString(techId),
    progress: FIX_ZERO,
    completedTick,
  };
}

describe("destroyRecords(GDD 11.1 追補の効果プリミティブ)", () => {
  const content = loadWith([]);
  const TECH = "techFireStarting";

  it("scope=all は medium に一致する完成済み記録をすべて消す", () => {
    const state = boardOf([
      codify("codifyPaper", TECH, "paper"),
      codify("codifyTablet", TECH, "stoneTablet"),
    ]);
    const result = destroyRecords(state, content, { medium: "paper", scope: "all" }, 10);
    expect(result.destroyedRecordIds).toEqual([id("codifyPaper")]);
    expect(result.state.entityStateById.has(id("codifyTablet"))).toBe(true);
    // 石板が残っているので成文化済みのまま(= 未成文化されない)。
    expect(isCodified(result.state, entityIdFromString(TECH))).toBe(true);
    expect(result.uncodifiedTechIds).toEqual([]);
  });

  it("scope=flammable は可燃(紙)だけを消す = 火災の既定形", () => {
    const state = boardOf([
      codify("codifyPaper", TECH, "paper"),
      codify("codifyTablet", TECH, "stoneTablet"),
    ]);
    const result = destroyRecords(state, content, { medium: "any", scope: "flammable" }, 10);
    expect(result.destroyedRecordIds).toEqual([id("codifyPaper")]);
    expect(result.state.entityStateById.has(id("codifyTablet"))).toBe(true);
  });

  it("記録が 0 枚になった tech は未成文状態へ戻る(知識は焼けない)", () => {
    const state = boardOf([codify("codifyPaper", TECH, "paper")]);
    const result = destroyRecords(state, content, { medium: "any", scope: "flammable" }, 10);
    expect(isCodified(result.state, entityIdFromString(TECH))).toBe(false);
    expect(result.uncodifiedTechIds).toEqual([entityIdFromString(TECH)]);
    // 生存保持者が居なくても research entity が無ければ失うものは無い。
    expect(result.lostTechIds).toEqual([]);
  });

  it("生存保持者が居れば喪失しない(再成文化できる)", () => {
    const base = boardOf([codify("codifyPaper", TECH, "paper"), research("researchFire", TECH, 5)]);
    const withHolder = setTechMemory(base, `residentRookie0|${TECH}`, {
      masteryFix: fixFromInt(1),
      impairedUntilTick: 0,
    });
    const result = destroyRecords(withHolder, content, { medium: "any", scope: "all" }, 10);
    expect(result.lostTechIds).toEqual([]);
    const research0 = requireEntity(result.state, id("researchFire"), "research");
    expect(research0.completedTick).toBe(5);
    expect(research0.loss).toBeUndefined();
  });

  it("生存保持者ゼロ かつ 記録ゼロ で周回内喪失(lastHolderId はキーごと省略)", () => {
    const state = boardOf([
      codify("codifyPaper", TECH, "paper"),
      research("researchFire", TECH, 5),
    ]);
    const result = destroyRecords(state, content, { medium: "any", scope: "all" }, 10);
    expect(result.lostTechIds).toEqual([entityIdFromString(TECH)]);
    const research0 = requireEntity(result.state, id("researchFire"), "research");
    expect(research0.completedTick).toBeNull();
    expect(research0.loss?.tick).toBe(10);
    expect(research0.loss?.lastHolderId).toBeUndefined();
    // 往復してもキーが生えない(バイト同一性)。
    const json = JSON.stringify(toSerializable(result.state));
    expect(json).not.toContain("lastHolderId");
    expect(JSON.stringify(toSerializable(fromSerializable(JSON.parse(json))))).toBe(json);
  });

  it("scope=oldest は完成 tick が最も古い 1 枚だけを消す", () => {
    const state = boardOf([
      codify("codifyA", TECH, "paper", 30),
      codify("codifyB", TECH, "paper", 10),
      codify("codifyC", TECH, "paper", 20),
    ]);
    const result = destroyRecords(state, content, { medium: "paper", scope: "oldest" }, 40);
    expect(result.destroyedRecordIds).toEqual([id("codifyB")]);
  });

  it("作業中(未完成)の記録は燃えない", () => {
    const state = boardOf([codify("codifyWip", TECH, "paper", null)]);
    const result = destroyRecords(state, content, { medium: "any", scope: "all" }, 10);
    expect(result.destroyedRecordIds).toEqual([]);
  });

  it("recordMedia が無い content で scope=flammable は RulesError(黙って 0 件にしない)", () => {
    const noMedia = loadWith([], (balance) => {
      const next = { ...balance };
      delete next["recordMedia"];
      return next;
    });
    const state = boardOf([codify("codifyPaper", TECH, "paper")]);
    expect(() => destroyRecords(state, noMedia, { medium: "any", scope: "flammable" }, 1)).toThrow(
      RulesError,
    );
  });

  it("帰還 tick に効果が適用される(スナップショット → state)", () => {
    const fireEvent = loadWith([
      eventJson({
        nodes: [
          nodeJson({
            branches: [
              {
                cond: "true",
                result: { kind: "destroyRecords", medium: "any", scope: "flammable" },
                logTemplate: "火が記録を舐めた。",
              },
            ],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    const state = boardOf([
      codify("codifyPaper", TECH, "paper"),
      codify("codifyTablet", TECH, "stoneTablet"),
    ]);
    const snapshot = buildDispatchSnapshot(state, fireEvent, worldSeedToUint32(state.worldSeed), {
      dispatchId: DISPATCH_ID,
      destinationId: EVENT_ID,
      band: "near",
      stance: "cautious",
      memberIds: memberIds(),
      dispatchTick: 0,
    });
    // 効果は 3 ノードぶん焼かれている(全ノードが同じ branch を踏む)。
    expect(snapshot.nodes[0]?.effects).toEqual([
      { kind: "destroyRecords", medium: "any", scope: "flammable" },
    ]);

    const withDispatch = createGameState(
      {
        saveSchemaVersion: 4,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "seedAlpha",
        tick: 0,
      },
      [...state.entityStateById.values()],
      [],
      [],
      [],
      [snapshot],
    );
    const ctx = createAdvanceContext(withDispatch, fireEvent);
    const resolved = resolveExpedition(withDispatch, ctx, DISPATCH_ID, snapshot.returnTick);
    expect(resolved.state.entityStateById.has(id("codifyPaper"))).toBe(false);
    expect(resolved.state.entityStateById.has(id("codifyTablet"))).toBe(true);
  });
});

// --- 7. 探索報酬の保管上限会計(GDD 6.7・M64 上限会計の統一) ----------------
//
// **[2026-08-04裁定・台帳v17 必-1(案1)]** M22 の
// `balance.exploration.rewardOverflow`(探索報酬だけに掛かる独自の固定上限)は
// 撤廃され、探索報酬は本拠の施設産出とまったく同じ加算式保管上限
// (`balance.storage.baseCapacity` + 保管施設の寄与)を通る。ここで固定するのは
//   (a) 上限がある資源では上限までしか受け取らない(R5-A01 の再発防止)
//   (b) 超過分は本拠と同じスポンジ機構(`wasteConversionRatio`)で廃材化される
//   (c) **帰還ログの報酬欄が実受領額**である(粗報酬の満額表示をしない)
//   (d) 上限が無い資源では M21 と 1 bit も変わらない

describe("探索報酬の保管上限会計(GDD 6.7 / M64)", () => {
  /** `balance.storage.baseCapacity` を差し替える patch。 */
  function withCapacity(capacityByResourceId: Record<string, number>) {
    return (balance: Record<string, unknown>): Record<string, unknown> => {
      const storage = { ...(balance["storage"] as Record<string, unknown>) };
      storage["baseCapacity"] = capacityByResourceId;
      return { ...balance, storage };
    };
  }

  /** 上限機構そのものを不活性にする patch(`storage` ブロックごと落とす)。 */
  function withoutStorage(balance: Record<string, unknown>): Record<string, unknown> {
    const next = { ...balance };
    delete next["storage"];
    return next;
  }

  function resolveWith(
    engineContent: EngineContent,
    state: GameState,
  ): ReturnType<typeof resolveExpedition> {
    const snapshot = snapshotOf(engineContent, id("destUnknown"), "cautious", state);
    const withDispatch = createGameState(
      {
        saveSchemaVersion: 4,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "seedAlpha",
        tick: 0,
      },
      [...state.entityStateById.values()],
      [],
      [],
      [],
      [snapshot],
    );
    const ctx = createAdvanceContext(withDispatch, engineContent);
    return resolveExpedition(withDispatch, ctx, DISPATCH_ID, snapshot.returnTick);
  }

  // [Phase D / M41] 上限のテスト用フィクスチャを 100 → 60 へ。near の
  // `rewardPerNode` を 45 → 33 へ再校正した結果、3 ノード全成功の報酬が
  // 135 → 99 になり「報酬が上限を超える」というシナリオの前提が上限 100 では
  // 成立しなくなったため(assert の形と強さは 1 つも変えていない)。
  it("保管上限がある資源では上限までしか受け取らない(R5-A01 の根治)", () => {
    const capped = loadWith([], withCapacity({ firewood: 60, waste: 400 }));
    const board = boardOf([resource("resWaste", id("waste"))]);
    const resolved = resolveWith(capped, board);
    expect(toRaw(resolved.snapshot.rewardFix)).toBeGreaterThan(toRaw(fixFromInt(60)));

    const stock = requireEntity(resolved.state, id("resFirewood"), "resource").stock;
    expect(toRaw(stock)).toBe(toRaw(fixFromInt(60)));
    expect(toRaw(resolved.rewardIntake.acceptedFix)).toBe(toRaw(fixFromInt(60)));
    expect(toRaw(resolved.rewardIntake.excessFix)).toBe(
      toRaw(resolved.snapshot.rewardFix) - toRaw(fixFromInt(60)),
    );
  });

  it("超過分は本拠と同じスポンジ機構で廃材になる(GDD 6.7)", () => {
    // 実 content の wasteConversionRatio.firewood = 0.5。
    const capped = loadWith([], withCapacity({ firewood: 60, waste: 400 }));
    const resolved = resolveWith(capped, boardOf([resource("resWaste", id("waste"))]));
    const waste = requireEntity(resolved.state, id("resWaste"), "resource").stock;
    expect(toRaw(waste)).toBe(Math.floor(toRaw(resolved.rewardIntake.excessFix) / 2));
  });

  it("**帰還ログの報酬欄は実受領額**であり、あふれた量も黙殺しない(R5-A01)", () => {
    const capped = loadWith([], withCapacity({ firewood: 60, waste: 400 }));
    const resolved = resolveWith(capped, boardOf([resource("resWaste", id("waste"))]));
    const logged = resolved.state.renderedLogs.entries[0];
    expect(logged?.text).toContain("報酬 firewood 60");
    expect(logged?.text).not.toContain(
      `報酬 firewood ${String(Math.floor(toRaw(resolved.snapshot.rewardFix) / 1_000_000))}`,
    );
    expect(logged?.text).toContain("保管上限のため");
    // 在庫へ入った量とログの表示額が一致する(= 受領額 = 表示額)。
    const stock = requireEntity(resolved.state, id("resFirewood"), "resource").stock;
    expect(logged?.text).toContain(`報酬 firewood ${String(Math.floor(toRaw(stock) / 1_000_000))}`);
  });

  it("**R5-A01 の再現**: 実 content(薪上限400)で在庫が上限近くでも受領額 = 表示額", () => {
    // R5-A01(fatal・評価Round 5)の再現手順そのもの:
    //   薪の在庫が上限近く → 探索から帰還 → 報酬の大半が受け取れない
    // 旧実装(`exploration.rewardOverflow={policy:'discard',capacity:200}`)では
    //   (a) 上限が保管施設と無関係な固定 200 だったので薪 200 以上で報酬が全損し
    //   (b) 帰還ログは受入前の粗報酬を満額表示した(IndexedDB 実測: 受領 11.3 /
    //       破棄 163.7 に対しログは「薪 175」)
    // M64 後は (a) 上限が実 content の加算式(基礎 400)になり
    //          (b) ログの報酬欄が実受領額になる。
    const real = loadWith([]); // 実 content(patch なし)。
    const stockBefore = 390;
    const board = boardOf([resource("resWaste", id("waste"))]);
    const withStock = createGameState(
      {
        saveSchemaVersion: 4,
        contentVersion: 1,
        algoVersion: 1,
        worldSeed: "seedAlpha",
        tick: 0,
      },
      [...board.entityStateById.values()].map((entity) =>
        entity.kind === "resource" && entity.resourceId === id("firewood")
          ? { ...entity, stock: fixFromInt(stockBefore) }
          : entity,
      ),
    );
    const resolved = resolveWith(real, withStock);

    // 粗報酬は上限の残り(400 − 390 = 10)より十分大きい = R5-A01 と同じ状況。
    expect(toRaw(resolved.snapshot.rewardFix)).toBeGreaterThan(toRaw(fixFromInt(10)));
    // 受領額は「上限までの残り」ちょうど。
    expect(toRaw(resolved.rewardIntake.acceptedFix)).toBe(toRaw(fixFromInt(400 - stockBefore)));
    const stockAfter = requireEntity(resolved.state, id("resFirewood"), "resource").stock;
    expect(toRaw(stockAfter)).toBe(toRaw(fixFromInt(400)));

    // **検収条件: 受領額 = 表示額。** ログの報酬欄が在庫増分と一致する。
    const logText = resolved.state.renderedLogs.entries[0]?.text ?? "";
    const acceptedInt = Math.floor(toRaw(resolved.rewardIntake.acceptedFix) / 1_000_000);
    const grossInt = Math.floor(toRaw(resolved.snapshot.rewardFix) / 1_000_000);
    expect(logText).toContain(`報酬 firewood ${String(acceptedInt)}`);
    expect(acceptedInt).toBeLessThan(grossInt);
    expect(logText).not.toContain(`報酬 firewood ${String(grossInt)}`);
    // 破棄も黙殺しない(旧実装は「黙って破棄」だった)。
    expect(logText).toContain("保管上限のため");
  });

  it("保管上限が無ければ全量が入り、ログも M21 の形のまま(縮約互換)", () => {
    const plain = loadWith([], withoutStorage);
    const resolved = resolveWith(plain, boardOf());
    const stock = requireEntity(resolved.state, id("resFirewood"), "resource").stock;
    expect(toRaw(stock)).toBe(toRaw(resolved.snapshot.rewardFix));
    expect(toRaw(resolved.rewardIntake.excessFix)).toBe(0);
    expect(resolved.state.renderedLogs.entries[0]?.text).not.toContain("保管上限のため");
  });

  it("上限に届かない報酬では在庫もログも上限が無いときと一致する", () => {
    const roomy = loadWith([], withCapacity({ firewood: 100_000, waste: 400 }));
    const plain = loadWith([], withoutStorage);
    const cappedResolved = resolveWith(roomy, boardOf([resource("resWaste", id("waste"))]));
    const plainResolved = resolveWith(plain, boardOf());
    expect(toRaw(cappedResolved.rewardIntake.acceptedFix)).toBe(
      toRaw(plainResolved.rewardIntake.acceptedFix),
    );
    expect(cappedResolved.state.renderedLogs.entries[0]?.text).toBe(
      plainResolved.state.renderedLogs.entries[0]?.text,
    );
  });
});

// --- 8. ローダーの reject(「写せないものは黙って捨てない」) ------------------

describe("event ローダー — reject", () => {
  it("未知の logTemplate プレースホルダは reject", () => {
    const issues = loadIssues([
      eventJson({
        nodes: [
          nodeJson({
            branches: [{ cond: "true", result: "continue", logTemplate: "{unknownParam}" }],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    expect(issues.join("\n")).toMatch(/プレースホルダ "\{unknownParam\}"/);
  });

  it("末尾の branch が無条件成立でなければ reject", () => {
    const issues = loadIssues([
      eventJson({
        nodes: [
          nodeJson({
            branches: [
              { cond: "teamPower >= difficulty", result: "continue", logTemplate: "A。" },
              { cond: "teamPower < difficulty", result: "continue", logTemplate: "B。" },
            ],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    expect(issues.join("\n")).toMatch(/無条件成立/);
  });

  it("statWeights の正本語彙外キーは ContentBundle 経由で reject(裁定 B8)", () => {
    const issues = loadIssues([
      eventJson({
        nodes: [nodeJson({ statWeights: { resilience: 1 } }), nodeJson(), nodeJson()],
      }),
    ]);
    expect(issues.join("\n")).toMatch(/正本語彙/);
  });

  it("同じ event をスタンドアロン検証すると通る(#12 計測サンプル互換の既定)", () => {
    const result = validateEvent(
      eventJson({
        nodes: [nodeJson({ statWeights: { resilience: 1 } }), nodeJson(), nodeJson()],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("destroyRecords の未知 medium / scope は reject", () => {
    const bad = loadIssues([
      eventJson({
        nodes: [
          nodeJson({
            branches: [
              {
                cond: "true",
                result: { kind: "destroyRecords", medium: "papyrus", scope: "all" },
                logTemplate: "A。",
              },
            ],
          }),
          nodeJson(),
          nodeJson(),
        ],
      }),
    ]);
    expect(bad.join("\n")).toMatch(/medium/);
  });

  it("event の ID もグローバル一意性検査の対象になる(ADR-024(1))", () => {
    const issues = loadIssues([eventJson({ id: "techFireStarting" })]);
    expect(issues.join("\n")).toMatch(/一意|重複|duplicate/i);
  });
});

// --- 9. コマンド層(引数の誤りは例外でなく reject) --------------------------

describe("dispatchExpedition — event との整合", () => {
  const content = loadWith([eventJson()]);

  it("destTags に無い距離帯を指すと invalidArgument で reject(例外にしない)", () => {
    const state = boardOf();
    const result = apply(state, content, {
      kind: "dispatchExpedition",
      dispatchId: DISPATCH_ID,
      destinationId: EVENT_ID,
      band: "deep",
      stance: "cautious",
      teamResidentIds: memberIds(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalidArgument");
  });

  it("正しい距離帯なら受理され、スナップショットが event 由来になる", () => {
    const state = boardOf();
    const result = apply(state, content, {
      kind: "dispatchExpedition",
      dispatchId: DISPATCH_ID,
      destinationId: EVENT_ID,
      band: "near",
      stance: "cautious",
      teamResidentIds: memberIds(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshot = result.state.dispatchSnapshots[0];
    expect(snapshot?.eventId).toBe(EVENT_ID);
    expect(snapshot?.nodes).toHaveLength(3);
  });
});
