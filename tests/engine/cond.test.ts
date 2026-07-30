// ---------------------------------------------------------------------------
// [M22] event cond DSL — GDD 12.2 / ADR-006 / ADR-011
//
// 検収条件の 2 本をここで固定する:
//   (1) **ホワイトリスト外演算子の reject**(GDD 12.2 の許可演算子 8 種の外)
//   (2) **DSL 評価が固定小数点(1e6)で閉じ、浮動小数を 1 度も通らない**
//
// (2) は「浮動小数を使っていない」を直接観測できないので、次の 3 つを組み合わせて
// 反証可能にする:
//   (a) 評価に使う数値は Fix(raw 整数)であり、raw 1 刻みの境界で判定が切り替わる
//       (浮動小数の丸めが混ざると 1 刻みの境界が再現しない)
//   (b) 倍精度では区別できない大きさの値(2^53 近傍の raw)でも比較が厳密に効く
//   (c) content の 10 進リテラル(0.1 / 0.3 等)が誤差なく raw へ落ちる
//       (`0.1 + 0.2 !== 0.3` 型の誤差が cond の等値判定に出ない)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { validateEvent } from "../../schema/event";
import { validateContentBundle, type RawContentBundle } from "../../schema/contentBundle";
import { loadEngineContent } from "../../schema/engineContent";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { FIX_SCALE, fixFromInt, fixFromRaw, type Fix } from "../../src/engine/fp";
import {
  COND_COMPARE_OPERATORS,
  COND_LOGICAL_OPERATORS,
  COND_VARIABLES,
  CondError,
  EQUIP_TYPE_NONE,
  condExprType,
  evaluateCond,
  isCondFunction,
  isCondVariable,
  type CondContext,
  type CondExpr,
} from "../../src/engine/rules/cond";
import type { EventBranchDef, EventDef, EventNodeDef } from "../../src/engine/rules/types";

// --- 共通ヘルパ --------------------------------------------------------------

function ctxOf(overrides: Partial<CondContext> = {}): CondContext {
  return {
    teamPowerFix: overrides.teamPowerFix ?? fixFromInt(100),
    difficultyFix: overrides.difficultyFix ?? fixFromInt(50),
    statWeightsTotalFix: overrides.statWeightsTotalFix ?? fixFromInt(1),
    injuryCount: overrides.injuryCount ?? 0,
    equipType: overrides.equipType ?? EQUIP_TYPE_NONE,
    teamTraitIds: overrides.teamTraitIds ?? new Set<string>(),
    maxStatFixByStatId: overrides.maxStatFixByStatId ?? new Map<string, Fix>(),
  };
}

const num = (valueFix: Fix): CondExpr => ({ kind: "literal", value: { kind: "number", valueFix } });
const str = (value: string): CondExpr => ({ kind: "literal", value: { kind: "string", value } });
const bool = (value: boolean): CondExpr => ({ kind: "literal", value: { kind: "boolean", value } });

/**
 * cond 文字列 → engine の {@link CondExpr}。**正規経路**(schema/event.ts の
 * jsep ホワイトリスト → schema/engineContent.ts のコンパイル)を丸ごと通すので、
 * ここで得た式は本番と同じ経路で作られている。
 */
function compile(cond: string): CondExpr {
  const loaded = loadEvents([eventWithCond(cond)]);
  if (!loaded.ok) {
    throw new Error(`cond "${cond}" のロードに失敗: ${JSON.stringify(loaded.issues)}`);
  }
  const branch = firstBranch(loaded.def);
  return branch.cond;
}

/** cond が正規経路で reject されることを確かめる(理由の文字列つき)。 */
function rejectionOf(cond: string): readonly string[] {
  const loaded = loadEvents([eventWithCond(cond)]);
  if (loaded.ok) throw new Error(`cond "${cond}" が reject されなかった`);
  return loaded.issues;
}

function firstBranch(def: EventDef): EventBranchDef {
  const node: EventNodeDef | undefined = def.nodes[0];
  const branch = node?.branches[0];
  if (branch === undefined) throw new Error("branch が無い");
  return branch;
}

function eventWithCond(cond: string): Record<string, unknown> {
  return {
    id: "eventCondProbe",
    destTags: ["near"],
    nodes: [condNode(cond), condNode("true"), condNode("true")],
  };
}

function condNode(cond: string): Record<string, unknown> {
  return {
    difficulty: 40,
    R: 20,
    statWeights: { vigor: 1 },
    choices: [],
    branches: [
      { cond, result: "continue", logTemplate: "分岐 A。" },
      { cond: "true", result: "continue", logTemplate: "既定分岐。" },
    ],
  };
}

type LoadResult =
  | { readonly ok: true; readonly def: EventDef }
  | { readonly ok: false; readonly issues: readonly string[] };

function loadEvents(events: readonly Record<string, unknown>[]): LoadResult {
  const bundle: RawContentBundle = {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
    event: events,
  };
  const validated = validateContentBundle(bundle);
  if (!validated.ok) {
    return { ok: false, issues: validated.issues.map((i) => `${i.path}: ${i.message}`) };
  }
  const loaded = loadEngineContent(validated.value);
  if (!loaded.ok) {
    return { ok: false, issues: loaded.issues.map((i) => `${i.path}: ${i.message}`) };
  }
  const def = loaded.value.eventDefs?.get("eventCondProbe" as never);
  if (def === undefined) return { ok: false, issues: ["eventDefs に載らなかった"] };
  return { ok: true, def };
}

// --- 1. ホワイトリスト(検収条件 (1)) ---------------------------------------

describe("cond DSL — ホワイトリスト(GDD 12.2)", () => {
  it("**検収条件**: ホワイトリスト外の演算子は reject される", () => {
    // GDD 12.2 の許可演算子は == != < <= > >= && || の 8 種のみ。
    // 算術・ビット・代入・累乗はどれも「許可リストに無い」で落ちる。
    for (const cond of [
      "teamPower + 1 > difficulty",
      "teamPower - 1 > difficulty",
      "teamPower * 2 > difficulty",
      "teamPower / 2 > difficulty",
      "teamPower % 2 > difficulty",
      "teamPower & 1 > difficulty",
      "teamPower | 1 > difficulty",
      "teamPower ^ 1 > difficulty",
      "teamPower >> 1 > difficulty",
      "teamPower << 1 > difficulty",
      "teamPower === difficulty",
      "teamPower !== difficulty",
    ]) {
      const issues = rejectionOf(cond);
      expect(issues.join("\n"), cond).toMatch(/許可リスト|解決できない|構文解析/);
    }
  });

  it("**検収条件**: ホワイトリスト外の構文(単項否定・三項・プロパティ・配列)も reject される", () => {
    for (const cond of [
      "!hasTrait('traitScholar')",
      "teamPower > difficulty ? true : false",
      "statWeights.vigor > 0",
      "teamPower > difficulty, injuryCount == 0",
    ]) {
      expect(rejectionOf(cond).join("\n"), cond).toMatch(/許可されない構文|許可リスト|構文解析/);
    }
  });

  it("未知の識別子・未知の関数は reject される", () => {
    expect(rejectionOf("morale > 30").join("\n")).toMatch(/識別子 "morale"/);
    expect(rejectionOf("hasFacility('hearth') == true").join("\n")).toMatch(/関数呼び出しは/);
  });

  it("許可された 8 演算子はすべて通る", () => {
    for (const op of COND_COMPARE_OPERATORS) {
      expect(() => compile(`teamPower ${op} difficulty`)).not.toThrow();
    }
    for (const op of COND_LOGICAL_OPERATORS) {
      expect(() => compile(`teamPower > difficulty ${op} injuryCount == 0`)).not.toThrow();
    }
  });

  it("GDD 12.2 の変数 5 種と関数 2 種がすべて engine 側の語彙と一致する", () => {
    // schema 側ホワイトリストと engine 側レジストリの二重定義を突き合わせる。
    for (const name of ["teamPower", "difficulty", "statWeights", "injuryCount", "equipType"]) {
      expect(isCondVariable(name), name).toBe(true);
    }
    expect([...COND_VARIABLES].sort()).toEqual([
      "difficulty",
      "equipType",
      "injuryCount",
      "statWeights",
      "teamPower",
    ]);
    expect(isCondFunction("hasTrait")).toBe(true);
    expect(isCondFunction("maxStatHolder")).toBe(true);
    expect(isCondFunction("hasFacility")).toBe(false);
  });

  it("cond 全体が boolean にならない式はロード時に reject される(§3 の静的型)", () => {
    expect(rejectionOf("teamPower").join("\n")).toMatch(/boolean/);
    expect(rejectionOf("equipType").join("\n")).toMatch(/boolean/);
  });

  it("型の合わない比較はロード時に reject される(暗黙変換をしない)", () => {
    expect(rejectionOf("equipType > 'heavy'").join("\n")).toMatch(/大小比較/);
    expect(rejectionOf("teamPower && injuryCount").join("\n")).toMatch(/被演算子は boolean/);
  });

  it("スタンドアロン検証器(validateEvent)も同じホワイトリストで reject する", () => {
    const result = validateEvent({
      id: "eventCondProbe",
      destTags: ["near"],
      nodes: [condNode("teamPower + 1 > difficulty"), condNode("true"), condNode("true")],
    });
    expect(result.ok).toBe(false);
  });
});

// --- 2. 評価(検収条件 (2): 固定小数点で閉じる) ------------------------------

describe("cond DSL — 評価が固定小数点で閉じる(検収条件)", () => {
  it("(a) 判定の切り替わりが raw 1 刻みの境界ちょうどで起きる", () => {
    const expr = compile("teamPower >= difficulty");
    const difficultyFix = fixFromRaw(50_000_000); // 50.000000
    // raw で 1 だけ下 → false、ちょうど → true。浮動小数を経由すると
    // 1e-6 の差は倍精度の丸めに埋もれて境界が再現しない。
    expect(evaluateCond(expr, ctxOf({ teamPowerFix: fixFromRaw(49_999_999), difficultyFix }))).toBe(
      false,
    );
    expect(evaluateCond(expr, ctxOf({ teamPowerFix: fixFromRaw(50_000_000), difficultyFix }))).toBe(
      true,
    );
  });

  it("(b) 倍精度では区別できない大きさでも比較が厳密に効く", () => {
    // 2^53 = 9007199254740992。raw で隣り合う 2 値は double の整数表現の
    // 分解能ぎりぎりだが、Fix は raw 整数のまま比較するので区別できる。
    const big = 9_007_199_254_740_990;
    const expr = compile("teamPower > difficulty");
    expect(
      evaluateCond(
        expr,
        ctxOf({ teamPowerFix: fixFromRaw(big), difficultyFix: fixFromRaw(big - 1) }),
      ),
    ).toBe(true);
    expect(
      evaluateCond(expr, ctxOf({ teamPowerFix: fixFromRaw(big), difficultyFix: fixFromRaw(big) })),
    ).toBe(false);
  });

  it("(c) content の 10 進リテラルが誤差なく raw へ落ちる(0.1/0.2/0.3 の罠)", () => {
    // `0.1 + 0.2 !== 0.3` の型の誤差が cond の等値判定に出ないこと。
    // 0.3 のリテラルは raw 300000 に厳密一致する。
    const expr = compile("statWeights == 0.3");
    expect(evaluateCond(expr, ctxOf({ statWeightsTotalFix: fixFromRaw(300_000) }))).toBe(true);
    expect(evaluateCond(expr, ctxOf({ statWeightsTotalFix: fixFromRaw(300_001) }))).toBe(false);
    expect(evaluateCond(expr, ctxOf({ statWeightsTotalFix: fixFromRaw(299_999) }))).toBe(false);
  });

  it("(c') 小数第 7 位以降に有効桁のあるリテラルは reject(黙って丸めない)", () => {
    expect(rejectionOf("statWeights == 0.0000001").join("\n")).toMatch(/厳密表現できない/);
  });

  it("injuryCount のような整数量も Fix にしてから比較する", () => {
    const expr = compile("injuryCount >= 2");
    expect(evaluateCond(expr, ctxOf({ injuryCount: 1 }))).toBe(false);
    expect(evaluateCond(expr, ctxOf({ injuryCount: 2 }))).toBe(true);
    expect(evaluateCond(expr, ctxOf({ injuryCount: 3 }))).toBe(true);
  });
});

// --- 3. 語彙の意味(GDD 12.2 の各変数) --------------------------------------

describe("cond DSL — 変数と関数の意味", () => {
  it("hasTrait はチームの誰か 1 人でも持っていれば true", () => {
    const expr = compile("hasTrait('traitScholar') == true");
    expect(evaluateCond(expr, ctxOf({ teamTraitIds: new Set(["traitScholar"]) }))).toBe(true);
    expect(evaluateCond(expr, ctxOf({ teamTraitIds: new Set(["traitTough"]) }))).toBe(false);
    expect(evaluateCond(expr, ctxOf())).toBe(false);
  });

  it("maxStatHolder はチーム内のその stat の最大値を返す(未登録は 0)", () => {
    const expr = compile("maxStatHolder('dexterity') >= 70");
    const high = new Map<string, Fix>([["dexterity", fixFromInt(70)]]);
    const low = new Map<string, Fix>([["dexterity", fixFromInt(69)]]);
    expect(evaluateCond(expr, ctxOf({ maxStatFixByStatId: high }))).toBe(true);
    expect(evaluateCond(expr, ctxOf({ maxStatFixByStatId: low }))).toBe(false);
    expect(evaluateCond(expr, ctxOf())).toBe(false);
  });

  it("equipType は item 未実装のあいだ常に 'none'", () => {
    const expr = compile("equipType == 'none'");
    expect(evaluateCond(expr, ctxOf())).toBe(true);
    expect(EQUIP_TYPE_NONE).toBe("none");
  });

  it("&& / || の真理値表が期待どおり", () => {
    const and = compile("teamPower >= difficulty && injuryCount == 0");
    const or = compile("teamPower >= difficulty || injuryCount == 0");
    const cases: readonly (readonly [number, number, boolean, boolean])[] = [
      [100, 0, true, true],
      [100, 1, false, true],
      [10, 0, false, true],
      [10, 1, false, false],
    ];
    for (const [power, injury, expectedAnd, expectedOr] of cases) {
      const ctx = ctxOf({ teamPowerFix: fixFromInt(power), injuryCount: injury });
      expect(evaluateCond(and, ctx), `and ${String(power)}/${String(injury)}`).toBe(expectedAnd);
      expect(evaluateCond(or, ctx), `or ${String(power)}/${String(injury)}`).toBe(expectedOr);
    }
  });

  it("文字列比較は UTF-16 コードユニット順(ロケール非依存)", () => {
    const expr: CondExpr = { kind: "compare", op: "<", left: str("A"), right: str("a") };
    // ロケール依存の比較(localeCompare)では "a" < "A" になる環境があるが、
    // UTF-16 では常に "A"(0x41)< "a"(0x61)。
    expect(evaluateCond(expr, ctxOf())).toBe(true);
  });
});

// --- 4. 防御(ロードで落ちるはずの経路を engine が黙って通さない) -----------

describe("cond DSL — engine 側の防御(ロードの不変条件が破れた場合)", () => {
  it("boolean を返さない式は CondError", () => {
    expect(() => evaluateCond(num(fixFromInt(1)), ctxOf())).toThrow(CondError);
  });

  it("型の違う大小比較は CondError(== / != は false / true)", () => {
    const bad: CondExpr = { kind: "compare", op: "<", left: str("a"), right: num(fixFromInt(1)) };
    expect(() => evaluateCond(bad, ctxOf())).toThrow(CondError);
    const eq: CondExpr = { kind: "compare", op: "==", left: str("a"), right: num(fixFromInt(1)) };
    expect(evaluateCond(eq, ctxOf())).toBe(false);
    const ne: CondExpr = { kind: "compare", op: "!=", left: str("a"), right: num(fixFromInt(1)) };
    expect(evaluateCond(ne, ctxOf())).toBe(true);
  });

  it("boolean どうしの大小比較は CondError、等値は通る", () => {
    const lt: CondExpr = { kind: "compare", op: "<", left: bool(true), right: bool(false) };
    expect(() => evaluateCond(lt, ctxOf())).toThrow(CondError);
    const eq: CondExpr = { kind: "compare", op: "==", left: bool(true), right: bool(true) };
    expect(evaluateCond(eq, ctxOf())).toBe(true);
  });

  it("condExprType は型不一致を例外で示す(ロード側の reject の材料)", () => {
    const mismatched: CondExpr = {
      kind: "compare",
      op: "==",
      left: num(fixFromInt(1)),
      right: str("x"),
    };
    expect(() => condExprType(mismatched)).toThrow(CondError);
  });

  it("FIX_SCALE は 1e6(cond の数値表現の前提)", () => {
    expect(FIX_SCALE).toBe(1_000_000);
  });
});
