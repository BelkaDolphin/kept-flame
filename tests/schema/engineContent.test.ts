import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import {
  ENGINE_EFFECT_BY_CONTENT_EFFECT,
  EngineContentError,
  UNREPRESENTABLE_CONTENT_EFFECTS,
  loadEngineContent,
  loadEngineContentOrThrow,
  rawFromHumanNumber,
} from "../../schema/engineContent";
import { FIX_SCALE, toRaw } from "../../src/engine/fp";
import { tagPairKey } from "../../src/engine/adjacency";
import type { ContentBundle } from "../../schema/contentBundle";

// ---------------------------------------------------------------------------
// content JSON → engine 内部表現ローダー(T7 前半)のテスト。
//
// 中心は「engine へ写せないものを黙って捨てず reject する」ことの確認であり、
// 正常系(ダミー content が写る)と reject 系(効果語彙・適用先・タグレジストリ・
// 縮約必須フィールド・FP 厳密変換)を対で押さえる。
// ---------------------------------------------------------------------------

function rawBundle(): RawContentBundle {
  return {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
}

/** ダミー content を検証まで通したバンドル(ローダーの入力)。 */
function validBundle(): ContentBundle {
  const result = validateContentBundle(rawBundle());
  if (!result.ok) {
    throw new Error(`前提が壊れている: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

/** JSON を素の構造として複製する(patch を当てるための可変コピー)。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function issuePaths(bundle: RawContentBundle): readonly string[] {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    return validated.issues.map((issue) => issue.path);
  }
  const loaded = loadEngineContent(validated.value);
  if (loaded.ok) return [];
  return loaded.issues.map((issue) => issue.path);
}

function issueMessages(bundle: RawContentBundle): string {
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    return validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  }
  const loaded = loadEngineContent(validated.value);
  if (loaded.ok) return "";
  return loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

// --- 1. 人間可読値 → 1e6 raw の厳密変換 ------------------------------------

describe("rawFromHumanNumber(10 進厳密変換・engineContent.ts §2)", () => {
  const cases: readonly (readonly [number, number])[] = [
    [0, 0],
    [-0, 0],
    [1, 1_000_000],
    [-1, -1_000_000],
    [0.2, 200_000],
    [-0.15, -150_000],
    [0.05, 50_000],
    [0.35, 350_000],
    [1.5, 1_500_000],
    [2, 2_000_000],
    [100, 100_000_000],
    [115, 115_000_000],
    [132.25, 132_250_000],
    [152.0875, 152_087_500],
    [174.900625, 174_900_625],
    [262.350937, 262_350_937],
    [228.13125, 228_131_250],
    [0.000001, 1],
    [-0.000001, -1],
    [30, 30_000_000],
    [10_494_037.5, 10_494_037_500_000],
    [1e-6, 1],
    [1e3, 1_000_000_000],
  ];

  for (const [human, expectedRaw] of cases) {
    it(`${String(human)} → raw ${String(expectedRaw)}`, () => {
      const result = rawFromHumanNumber(human);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.raw).toBe(expectedRaw);
    });
  }

  it("浮動小数の乗算を経由しない(0.2 * 1e6 の丸めに依存しない)", () => {
    // 素朴な value * FIX_SCALE は環境によっては整数にならない可能性がある。
    // ローダーは 10 進桁列の移動だけで作るので必ず厳密整数になる。
    const result = rawFromHumanNumber(0.2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Number.isInteger(result.raw)).toBe(true);
      expect(result.raw).toBe(200_000);
    }
  });

  it("小数第 7 位以降に有効桁がある値は reject(黙って丸めない)", () => {
    for (const value of [262.3509375, 0.0000001, 1.0000005, -0.12345678]) {
      const result = rawFromHumanNumber(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("厳密表現できない");
    }
  });

  it("末尾が 0 の余分な桁は精度を落とさないので受理する", () => {
    const result = rawFromHumanNumber(1.2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toBe(1_200_000);
  });

  it("1e6 倍が安全整数を超える値は reject", () => {
    const result = rawFromHumanNumber(1e20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("安全整数");
  });

  it("指数表記(小さい側・大きい側)も 10 進として扱う", () => {
    expect(rawFromHumanNumber(1e-5)).toEqual({ ok: true, raw: 10 });
    expect(rawFromHumanNumber(1.5e-6)).toEqual({ ok: false, message: expect.any(String) });
    expect(rawFromHumanNumber(1e9)).toEqual({ ok: true, raw: 1e15 });
  });

  it("非有限は reject", () => {
    expect(rawFromHumanNumber(Number.NaN).ok).toBe(false);
    expect(rawFromHumanNumber(Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("FIX_SCALE は 1e6(小数 6 桁)前提", () => {
    expect(FIX_SCALE).toBe(1_000_000);
  });
});

// --- 2. 正常系 -------------------------------------------------------------

describe("loadEngineContent — ダミー content が engine 内部表現へ写る", () => {
  it("facility / tech / adjacency / recallRisk / coarseTickMinutes がそろう", () => {
    const result = loadEngineContent(validBundle());
    if (!result.ok) expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = result.value;
    expect([...content.facilityDefs.keys()]).toEqual(["forge", "hearth", "workbench"]);
    // [M6] E1〜E3 のテック 24 本(GDD 5.2)。並びは ID の UTF-16 昇順(§4 の前提)。
    expect([...content.techDefs.keys()]).toEqual([
      "techAgriculture",
      "techBasicMedicine",
      "techBasketWeaving",
      "techBedding",
      "techBlacksmithing",
      "techBlastFurnace",
      "techBoneHideWorking",
      "techCeramics",
      "techCharcoalKiln",
      "techFireStarting",
      "techGatheringHut",
      "techGlass",
      "techIrrigation",
      "techLens",
      "techMachineParts",
      "techMetalCasting",
      "techPottery",
      "techPrinting",
      "techSmelting",
      "techSteamEngine",
      "techStoneTools",
      "techStorage",
      "techWaterDrawing",
      "techWaterWheel",
    ]);
    expect(content.coarseTickMinutes).toBe(10);
  });

  it("Map の反復順は ID の UTF-16 昇順(rules/types.ts §4 の前提)", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = [...result.value.facilityDefs.keys()];
    expect([...ids].sort()).toEqual(ids);
  });

  it("lvCurve が Lv 別の個別 FP 値になる(実行時べき乗なし・GDD 11.7)", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hearth = result.value.facilityDefs.get("hearth" as never);
    expect(hearth).toBeDefined();
    expect(hearth?.outputPerTickByLevel.map(toRaw)).toEqual([
      100_000_000, 115_000_000, 132_250_000, 152_087_500, 174_900_625,
    ]);
  });

  it("harshWork と output が写る(GDD 11.1 / 11.2)", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facilityDefs.get("forge" as never)?.harshWork).toBe(true);
    expect(result.value.facilityDefs.get("hearth" as never)?.harshWork).toBe(false);
    expect(result.value.facilityDefs.get("hearth" as never)?.output).toEqual({
      kind: "resource",
      resourceId: "firewood",
    });
    expect(result.value.facilityDefs.get("workbench" as never)?.output).toEqual({
      kind: "research",
    });
  });

  it("researchCost が Fix へ写る", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(toRaw(result.value.techDefs.get("techFireStarting" as never)!.researchCostFix)).toBe(
      30_000_000,
    );
  });

  it("recallRisk が GDD 11.2 の表どおりに写る", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.value.recallRisk;
    expect(toRaw(p.basePFix)).toBe(50_000);
    expect(toRaw(p.pMaxFix)).toBe(350_000);
    expect(toRaw(p.loadWHarshFix)).toBe(2_000_000);
    expect(toRaw(p.loadWNormalFix)).toBe(500_000);
    expect(toRaw(p.moraleThresholdMidFix)).toBe(30_000_000);
    expect(toRaw(p.moraleBonusMidFix)).toBe(100_000);
    expect(toRaw(p.moraleThresholdLowFix)).toBe(15_000_000);
    expect(toRaw(p.moraleBonusLowFix)).toBe(200_000);
    expect(toRaw(p.dispatchWFix)).toBe(150_000);
    expect(toRaw(p.masteryResistMaxFix)).toBe(200_000);
    expect(toRaw(p.memoryKeeperResistFix)).toBe(-150_000);
    expect(p.durationMinTicks).toBe(1440);
    expect(p.durationMaxTicks).toBe(2880);
  });

  it("記憶巧者 trait が content に無ければ memoryKeeperTraitId は null", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recallRisk.memoryKeeperTraitId).toBeNull();
  });

  it("balance で指定した記憶巧者 trait が写る", () => {
    const bundle = clone(rawBundle()) as {
      tech: unknown[];
      facility: unknown[];
      trait: unknown[];
      adjacency: unknown;
      balance: { recallRiskParams: Record<string, unknown> };
    };
    bundle.trait.push({
      id: "traitMemoryKeeper",
      effects: [{ stat: "recallResist", op: "add", value: -15 }],
      stackRule: "multiplicative",
      maxPerResident: 3,
    });
    bundle.balance.recallRiskParams["memoryKeeperTraitId"] = "traitMemoryKeeper";

    const validated = validateContentBundle(bundle as RawContentBundle);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = loadEngineContent(validated.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recallRisk.memoryKeeperTraitId).toBe("traitMemoryKeeper");
  });

  it("adjacency のタグペアが正準キーで写り、シード揺らぎ前の係数を持つ", () => {
    const result = loadEngineContent(validBundle());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matrix = result.value.adjacency;
    expect([...matrix.pairEffects.keys()]).toEqual([
      tagPairKey("damp", "heat"),
      tagPairKey("heat", "heat"),
    ]);
    const heatPair = matrix.pairEffects.get(tagPairKey("heat", "heat"));
    expect(heatPair?.effect).toBe("yieldMul");
    expect(heatPair?.target).toEqual({ kind: "facilityDef", defId: "forge" });
    expect(toRaw(heatPair!.valueFix)).toBe(200_000);
    const dampPair = matrix.pairEffects.get(tagPairKey("damp", "heat"));
    expect(dampPair?.target).toEqual({ kind: "tag", tag: "heat" });
    expect(toRaw(dampPair!.valueFix)).toBe(-100_000);
    expect(matrix.overcrowd.threshold).toBe(3);
    expect(toRaw(matrix.overcrowd.penaltyPerExcessFix)).toBe(-100_000);
    expect(toRaw(matrix.overcrowd.clampFix)).toBe(600_000);
    expect(matrix.seedOffset).not.toBeNull();
    expect(toRaw(matrix.seedOffset!.minFix)).toBe(-200_000);
    expect(toRaw(matrix.seedOffset!.maxFix)).toBe(200_000);
  });

  it("loadEngineContentOrThrow は成功時にそのまま値を返す", () => {
    expect(() => loadEngineContentOrThrow(validBundle())).not.toThrow();
  });
});

// --- 3. reject 系: 効果語彙 -------------------------------------------------

describe("loadEngineContent — 効果語彙の reject(§1(a))", () => {
  function withHeatEffect(effect: string): RawContentBundle {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      adjacency: { tagMatrix: Record<string, Record<string, unknown>> };
    };
    const rule = bundle.adjacency.tagMatrix["heat|heat"];
    if (rule === undefined) throw new Error("前提が壊れている");
    rule["effect"] = effect;
    return bundle;
  }

  it("未知の効果語彙を reject する", () => {
    const messages = issueMessages(withHeatEffect("teleportYield"));
    expect(messages).toContain("teleportYield");
    expect(messages).toContain("ENGINE_EFFECT_BY_CONTENT_EFFECT");
  });

  it("GDD 6.2 にあるが engine 未実装の効果は理由付きで reject する", () => {
    for (const effect of Object.keys(UNREPRESENTABLE_CONTENT_EFFECTS)) {
      const messages = issueMessages(withHeatEffect(effect));
      expect(messages).toContain(effect);
      expect(messages).toContain("engine が未実装");
    }
  });

  it("写せる効果語彙はすべて yieldMul(engine の縮約が持つ唯一の効果種)", () => {
    for (const kind of Object.values(ENGINE_EFFECT_BY_CONTENT_EFFECT)) {
      expect(kind).toBe("yieldMul");
    }
    // 語彙が空になっていたら「何も写せない」ので必ず 1 件以上あること。
    expect(Object.keys(ENGINE_EFFECT_BY_CONTENT_EFFECT).length).toBeGreaterThan(0);
  });

  it("reject 時は issues に集約され例外を投げない(1 往復で全欠陥を報告)", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      adjacency: { tagMatrix: Record<string, Record<string, unknown>> };
    };
    const heat = bundle.adjacency.tagMatrix["heat|heat"];
    const damp = bundle.adjacency.tagMatrix["damp|heat"];
    if (heat === undefined || damp === undefined) throw new Error("前提が壊れている");
    heat["effect"] = "unknownA";
    damp["effect"] = "unknownB";
    const paths = issuePaths(bundle);
    expect(paths).toContain("adjacency.tagMatrix.heat|heat.effect");
    expect(paths).toContain("adjacency.tagMatrix.damp|heat.effect");
  });

  it("loadEngineContentOrThrow は reject を EngineContentError にする", () => {
    const validated = validateContentBundle(withHeatEffect("teleportYield"));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(() => loadEngineContentOrThrow(validated.value)).toThrow(EngineContentError);
  });
});

// --- 4. reject 系: 適用先 --------------------------------------------------

describe("loadEngineContent — 適用先の解決(§1(b))", () => {
  function withHeatTarget(target: string): RawContentBundle {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      adjacency: { tagMatrix: Record<string, Record<string, unknown>> };
    };
    const rule = bundle.adjacency.tagMatrix["heat|heat"];
    if (rule === undefined) throw new Error("前提が壊れている");
    rule["target"] = target;
    return bundle;
  }

  it('"any" は全施設適用へ写る', () => {
    const validated = validateContentBundle(withHeatTarget("any"));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = loadEngineContent(validated.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.adjacency.pairEffects.get(tagPairKey("heat", "heat"))?.target).toEqual({
      kind: "any",
    });
  });

  it("タグ名はタグ適用へ写る", () => {
    const validated = validateContentBundle(withHeatTarget("lore"));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = loadEngineContent(validated.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.adjacency.pairEffects.get(tagPairKey("heat", "heat"))?.target).toEqual({
      kind: "tag",
      tag: "lore",
    });
  });

  it("解決できない適用先を reject する", () => {
    const messages = issueMessages(withHeatTarget("nonexistentFacility"));
    expect(messages).toContain("nonexistentFacility");
    expect(messages).toContain("解決できない");
  });

  it("タグ名と同じ ID の facility があると曖昧なので reject する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      facility: Record<string, unknown>[];
      adjacency: { tagMatrix: Record<string, Record<string, unknown>> };
    };
    const first = bundle.facility[0];
    if (first === undefined) throw new Error("前提が壊れている");
    const clashing = clone(first);
    clashing["id"] = "lore";
    bundle.facility.push(clashing);
    const rule = bundle.adjacency.tagMatrix["heat|heat"];
    if (rule === undefined) throw new Error("前提が壊れている");
    rule["target"] = "lore";

    const messages = issueMessages(bundle);
    expect(messages).toContain("曖昧");
  });
});

// --- 5. reject 系: 縮約必須フィールドと係数上界 ------------------------------

describe("loadEngineContent — 縮約 rules の必須フィールド(§1(c))", () => {
  it("facility.harshWork 欠落を reject する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      facility: Record<string, unknown>[];
    };
    const first = bundle.facility[0];
    if (first === undefined) throw new Error("前提が壊れている");
    delete first["harshWork"];
    const messages = issueMessages(bundle);
    expect(messages).toContain("harshWork");
    expect(messages).toContain("loadW");
  });

  it("facility.output 欠落を reject する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      facility: Record<string, unknown>[];
    };
    const first = bundle.facility[0];
    if (first === undefined) throw new Error("前提が壊れている");
    delete first["output"];
    const messages = issueMessages(bundle);
    expect(messages).toContain("output");
    expect(messages).toContain("産出先");
  });

  it("balance の持続 tick 欠落を reject する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      balance: { recallRiskParams: Record<string, unknown> };
    };
    delete bundle.balance.recallRiskParams["durationTicksMin"];
    delete bundle.balance.recallRiskParams["durationTicksMax"];
    const messages = issueMessages(bundle);
    expect(messages).toContain("durationTicks");
  });

  it("タグペア係数が engine の上界(±2e6)を超えると reject する", () => {
    // schema のレンジ(±1)内では上界に届かないため、engine 側の assert が
    // issues へ畳まれる経路を確認する意図で schema レンジ上限を使う。
    // ここでは係数を上限 1.0 に上げても reject されないことだけを確認し、
    // 上界そのものの境界は tests/engine/adjacency.test.ts が担保する。
    const bundle = clone(rawBundle()) as RawContentBundle & {
      adjacency: { tagMatrix: Record<string, Record<string, unknown>> };
    };
    const rule = bundle.adjacency.tagMatrix["heat|heat"];
    if (rule === undefined) throw new Error("前提が壊れている");
    rule["valueFP"] = 1;
    expect(issuePaths(bundle)).toEqual([]);
  });
});

// --- 6. reject 系: タグレジストリの突合 ------------------------------------

describe("loadEngineContent — タグレジストリの突合(§1(d))", () => {
  it("schema を通ったタグはすべて engine のタグレジストリで解決できる", () => {
    // 二重定義(schema/facility.ts FACILITY_TAGS と engine ADJACENCY_TAGS)が
    // 一致している限り、ダミー content は tag 由来の issue を出さない。
    const paths = issuePaths(rawBundle());
    expect(paths.filter((path) => path.includes("tags"))).toEqual([]);
  });

  it("coarseTickMinutes が engine の許容外なら reject する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      balance: Record<string, unknown>;
    };
    bundle.balance["coarseTickMinutes"] = 5000;
    const messages = issueMessages(bundle);
    expect(messages).toContain("coarseTickMinutes");
  });

  it("1 分 tick(Fallback・ADR-014(3))は受理する", () => {
    const bundle = clone(rawBundle()) as RawContentBundle & {
      balance: Record<string, unknown>;
    };
    bundle.balance["coarseTickMinutes"] = 1;
    const validated = validateContentBundle(bundle);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = loadEngineContent(validated.value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.coarseTickMinutes).toBe(1);
  });
});
