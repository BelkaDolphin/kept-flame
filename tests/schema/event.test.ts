import { describe, expect, it } from "vitest";

import { validateEvent } from "../../schema/event";

// ---------------------------------------------------------------------------
// schema/event.ts の合格/不合格ケース(先行計測 #12 向け最小スキーマ)。
//
// validators.test.ts と同じ流儀(代表的な不合格パターンを複数試す)に加え、
// この検証器固有の cond DSL ホワイトリスト(GDD 12.2)の合格/不合格を重点的に
// 確認する(未知識別子・不許可演算子・不許可構文・引数超過・関数外呼び出し)。
// ---------------------------------------------------------------------------

function validNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    difficulty: 40,
    R: 20,
    statWeights: { vigor: 0.6, fortitude: 0.4 },
    choices: [{ label: "慎重", effect: { successMod: 0.1, rewardMod: -0.05 } }],
    branches: [
      { cond: "teamPower >= difficulty", result: "success", logTemplate: "踏破に成功した。" },
      { cond: "teamPower < difficulty", result: "failure", logTemplate: "踏破に失敗した。" },
    ],
    ...overrides,
  };
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "eventNearRubbleField",
    destTags: ["near"],
    nodes: [validNode(), validNode(), validNode()],
    ...overrides,
  };
}

describe("validateEvent — 合格ケース", () => {
  it("有効な event を受理する", () => {
    const result = validateEvent(validEvent());
    if (!result.ok) {
      expect(result.issues).toEqual([]);
    }
    expect(result.ok).toBe(true);
  });

  it("hasTrait / maxStatHolder 関数呼び出しの cond を受理する", () => {
    const result = validateEvent(
      validEvent({
        nodes: [
          validNode({
            branches: [
              {
                cond: "hasTrait('traitScholar') == false",
                result: "failure",
                logTemplate: "学者不在で解読に失敗した。",
              },
              {
                cond: "maxStatHolder('dexterity') >= difficulty",
                result: "success",
                logTemplate: "器用な者が罠を回避した。",
              },
            ],
          }),
          validNode(),
          validNode(),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("&& / || を含む cond を受理する", () => {
    const result = validateEvent(
      validEvent({
        nodes: [
          validNode({
            branches: [
              {
                cond: "teamPower >= difficulty && injuryCount == 0",
                result: "success",
                logTemplate: "無傷で踏破した。",
              },
              {
                cond: "teamPower < difficulty || injuryCount > 0",
                result: "failure",
                logTemplate: "負傷者を出した。",
              },
            ],
          }),
          validNode(),
          validNode(),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateEvent — 不合格ケース(構造)", () => {
  it("id が ADR-011 の正規表現に違反すると reject する", () => {
    const result = validateEvent(validEvent({ id: "Event_Near" }));
    expect(result.ok).toBe(false);
  });

  it("destTags が未知タグだと reject する", () => {
    const result = validateEvent(validEvent({ destTags: ["medium"] }));
    expect(result.ok).toBe(false);
  });

  it("destTags が空だと reject する", () => {
    const result = validateEvent(validEvent({ destTags: [] }));
    expect(result.ok).toBe(false);
  });

  it("destTags の重複を reject する", () => {
    const result = validateEvent(validEvent({ destTags: ["near", "near"] }));
    expect(result.ok).toBe(false);
  });

  it("nodes が2個以下だと reject する(GDD 8.2: 3〜8ノード)", () => {
    const result = validateEvent(validEvent({ nodes: [validNode(), validNode()] }));
    expect(result.ok).toBe(false);
  });

  it("nodes が9個以上だと reject する", () => {
    const result = validateEvent(
      validEvent({ nodes: Array.from({ length: 9 }, () => validNode()) }),
    );
    expect(result.ok).toBe(false);
  });

  it("statWeights が空だと reject する", () => {
    const result = validateEvent(
      validEvent({ nodes: [validNode({ statWeights: {} }), validNode(), validNode()] }),
    );
    expect(result.ok).toBe(false);
  });

  it("choices が5個以上だと reject する(GDD 8.3: 二択想定)", () => {
    const choice = { label: "x", effect: { successMod: 0.1 } };
    const result = validateEvent(
      validEvent({
        nodes: [
          validNode({ choices: Array.from({ length: 5 }, () => choice) }),
          validNode(),
          validNode(),
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("choices[].effect が全フィールド欠落だと reject する(無効果の choice を防ぐ)", () => {
    const result = validateEvent(
      validEvent({
        nodes: [
          validNode({ choices: [{ label: "何もしない", effect: {} }] }),
          validNode(),
          validNode(),
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("branches が0個だと reject する", () => {
    const result = validateEvent(
      validEvent({ nodes: [validNode({ branches: [] }), validNode(), validNode()] }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateEvent — 不合格ケース(cond DSL ホワイトリスト・GDD 12.2)", () => {
  function withCond(cond: string): Record<string, unknown> {
    return validEvent({
      nodes: [
        validNode({ branches: [{ cond, result: "success", logTemplate: "x" }] }),
        validNode(),
        validNode(),
      ],
    });
  }

  it("未知識別子を reject する", () => {
    const result = validateEvent(withCond("unknownVar >= difficulty"));
    expect(result.ok).toBe(false);
  });

  it("許可リスト外の演算子(+)を reject する", () => {
    const result = validateEvent(withCond("teamPower + 1 >= difficulty"));
    expect(result.ok).toBe(false);
  });

  it("未許可の関数呼び出しを reject する", () => {
    const result = validateEvent(withCond("evalArbitrary('x') == true"));
    expect(result.ok).toBe(false);
  });

  it("許可関数の引数が2個以上だと reject する", () => {
    const result = validateEvent(withCond("hasTrait('a', 'b') == true"));
    expect(result.ok).toBe(false);
  });

  it("MemberExpression(プロパティアクセス)を reject する", () => {
    const result = validateEvent(withCond("statWeights.vigor >= difficulty"));
    expect(result.ok).toBe(false);
  });

  it("単項否定(!)を reject する(GDD 12.2 の許可演算子に無い)", () => {
    const result = validateEvent(withCond("!hasTrait('traitScholar')"));
    expect(result.ok).toBe(false);
  });

  it("三項演算子を reject する", () => {
    const result = validateEvent(withCond("teamPower >= difficulty ? true : false"));
    expect(result.ok).toBe(false);
  });

  it("構文エラーの cond を reject する", () => {
    const result = validateEvent(withCond("teamPower >="));
    expect(result.ok).toBe(false);
  });

  it("長すぎる cond を reject する", () => {
    const longCond = `teamPower >= difficulty ${"&& injuryCount == 0 ".repeat(30)}`;
    const result = validateEvent(withCond(longCond));
    expect(result.ok).toBe(false);
  });
});
