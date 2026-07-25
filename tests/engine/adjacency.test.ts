import { describe, expect, it } from "vitest";

import {
  ADJACENCY_BONUS_CLAMP_FIX,
  ADJACENCY_PAIR_VALUE_ABS_MAX,
  ADJACENCY_TAGS,
  AdjacencyError,
  GRID_CELL_COUNT,
  GRID_HEIGHT,
  GRID_WIDTH,
  NEIGHBOR_DIRECTION_NAMES,
  NEIGHBOR_OFFSETS,
  applySeedOffsets,
  cellIdOf,
  computeCellAdjacency,
  computeFacilityMultipliers,
  createAdjacencyMatrix,
  isTag,
  neighborCellIndices,
  tagPairKey,
  type AdjacencyPairEntry,
  type AdjacencySubject,
  type Tag,
} from "../../src/engine/adjacency";
import { fixFromRaw, toRaw, type Fix } from "../../src/engine/fp";
import { HEAT_PAIR, matrix, occupancyOf } from "./fixtures";

// ---------------------------------------------------------------------------
// 隣接ボーナス(GDD 6.2/6.3/6.4)のテスト。
//
// 主眼は 3 つ:
//   (1) タグ×タグ**対称**行列であること(施設ペア非依存・GDD 6.2)
//   (2) GDD 6.3 の確定事項(方向順列挙 → セルID 辞書順再ソート → 先頭 2 件のみ
//       ボーナス → 超過ペナ / ±60% クランプ)を数値で固定すること
//   (3) 依存が自セル + 8 近傍に限られること(O(8) 上界・ADR-002(2))
// ---------------------------------------------------------------------------

const pair = (
  tagA: Tag,
  tagB: Tag,
  raw: number,
  target: AdjacencyPairEntry["effect"]["target"] = { kind: "any" },
): AdjacencyPairEntry => ({
  tagA,
  tagB,
  effect: { effect: "yieldMul", target, valueFix: fixFromRaw(raw) },
});

const subject = (cellIndex: number, tags: readonly Tag[], defId = "hearth"): AdjacencySubject => ({
  cellIndex,
  defId,
  tags,
});

describe("タグとグリッドの定義", () => {
  it("タグは 7 種(GDD 6.1・tags-spec.md の英字 ID)", () => {
    expect([...ADJACENCY_TAGS]).toEqual(["heat", "clean", "foul", "noise", "damp", "calm", "lore"]);
  });

  it("isTag はレジストリ外を弾く", () => {
    expect(isTag("heat")).toBe(true);
    expect(isTag("Heat")).toBe(false);
    expect(isTag("warm")).toBe(false);
  });

  it("格子は 6×8 = 48 セル(GDD 6.1)", () => {
    expect(GRID_WIDTH).toBe(6);
    expect(GRID_HEIGHT).toBe(8);
    expect(GRID_CELL_COUNT).toBe(48);
  });

  it("近傍オフセットは方向順 N,NE,E,SE,S,SW,W,NW に固定(GDD 6.3)", () => {
    expect([...NEIGHBOR_DIRECTION_NAMES]).toEqual(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
    expect(NEIGHBOR_OFFSETS.map((o) => `${String(o[0])},${String(o[1])}`)).toEqual([
      "0,-1",
      "1,-1",
      "1,0",
      "1,1",
      "0,1",
      "-1,1",
      "-1,0",
      "-1,-1",
    ]);
  });

  it("セルID は 2 桁ゼロ埋めで辞書順 = 数値順", () => {
    expect(cellIdOf(0)).toBe("c00");
    expect(cellIdOf(7)).toBe("c07");
    expect(cellIdOf(47)).toBe("c47");
    const ids = [];
    for (let i = 0; i < GRID_CELL_COUNT; i++) ids.push(cellIdOf(i));
    expect([...ids].sort()).toEqual(ids);
  });

  it("範囲外のセル番号は例外", () => {
    expect(() => cellIdOf(-1)).toThrow(AdjacencyError);
    expect(() => cellIdOf(48)).toThrow(AdjacencyError);
    expect(() => neighborCellIndices(1.5)).toThrow(AdjacencyError);
  });
});

describe("近傍の列挙(盤外の扱い)", () => {
  it("左上隅は E, SE, S の 3 つ(方向順)", () => {
    expect(neighborCellIndices(0)).toEqual([1, 7, 6]);
  });

  it("右端セルは E 方向へ回り込まない", () => {
    // cell 5 = (x=5, y=0)。E(x=6)は盤外、W(x=4)は同じ行。
    expect(neighborCellIndices(5)).toEqual([11, 10, 4]);
  });

  it("中央は 8 つで方向順に並ぶ", () => {
    // cell 8 = (x=2, y=1)。
    expect(neighborCellIndices(8)).toEqual([2, 3, 9, 15, 14, 13, 7, 1]);
  });

  it("右下隅は 3 つ", () => {
    expect(neighborCellIndices(47)).toEqual([41, 46, 40]);
  });
});

describe("タグペアキーの対称性(GDD 6.2: 施設ペア非依存の対称行列)", () => {
  it("全 49 組で tagPairKey(a,b) === tagPairKey(b,a)", () => {
    for (const a of ADJACENCY_TAGS) {
      for (const b of ADJACENCY_TAGS) {
        expect(tagPairKey(a, b)).toBe(tagPairKey(b, a));
      }
    }
  });

  it("キーは昇順の正準形(content 側 schema と同じ規約)", () => {
    expect(tagPairKey("heat", "clean")).toBe("clean|heat");
    expect(tagPairKey("clean", "heat")).toBe("clean|heat");
    expect(tagPairKey("damp", "heat")).toBe("damp|heat");
  });

  it("逆順で登録しても同一エントリとして重複検出される", () => {
    expect(() => matrix([pair("heat", "clean", 100_000), pair("clean", "heat", 200_000)])).toThrow(
      AdjacencyError,
    );
  });

  it("行列の反復順は登録順に依らずキー昇順", () => {
    const forward = matrix([
      pair("heat", "heat", 1),
      pair("clean", "damp", 2),
      pair("calm", "calm", 3),
    ]);
    const reversed = matrix([
      pair("calm", "calm", 3),
      pair("clean", "damp", 2),
      pair("heat", "heat", 1),
    ]);
    expect([...forward.pairEffects.keys()]).toEqual(["calm|calm", "clean|damp", "heat|heat"]);
    expect([...reversed.pairEffects.keys()]).toEqual([...forward.pairEffects.keys()]);
  });
});

describe("行列の構成時検証", () => {
  it("係数の上限(値域証明の前提)を超えると例外", () => {
    expect(() => matrix([pair("heat", "heat", ADJACENCY_PAIR_VALUE_ABS_MAX)])).not.toThrow();
    expect(() => matrix([pair("heat", "heat", ADJACENCY_PAIR_VALUE_ABS_MAX + 1)])).toThrow(
      AdjacencyError,
    );
    expect(() => matrix([pair("heat", "heat", -ADJACENCY_PAIR_VALUE_ABS_MAX - 1)])).toThrow(
      AdjacencyError,
    );
  });

  it("threshold / ペナ符号 / clamp 符号の不正を弾く", () => {
    const base = {
      pairs: [HEAT_PAIR],
      seedOffset: null,
    };
    expect(() =>
      createAdjacencyMatrix({
        ...base,
        overcrowd: { threshold: 0, penaltyPerExcessFix: fixFromRaw(-1), clampFix: fixFromRaw(1) },
      }),
    ).toThrow(AdjacencyError);
    expect(() =>
      createAdjacencyMatrix({
        ...base,
        overcrowd: { threshold: 3, penaltyPerExcessFix: fixFromRaw(1), clampFix: fixFromRaw(1) },
      }),
    ).toThrow(AdjacencyError);
    expect(() =>
      createAdjacencyMatrix({
        ...base,
        overcrowd: { threshold: 3, penaltyPerExcessFix: fixFromRaw(-1), clampFix: fixFromRaw(-1) },
      }),
    ).toThrow(AdjacencyError);
  });

  it("seedOffsetRange の min > max を弾く", () => {
    expect(() =>
      matrix([HEAT_PAIR], { minFix: fixFromRaw(200_000), maxFix: fixFromRaw(-200_000) }),
    ).toThrow(AdjacencyError);
  });
});

describe("ボーナスの計算(GDD 6.2)", () => {
  const m = matrix();

  it("熱源が 1 つ隣接すると +20%", () => {
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["heat"]],
    ]);
    const result = computeCellAdjacency(m, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(200_000);
    expect(toRaw(result.multiplierFix)).toBe(1_200_000);
    expect(result.overcrowdedNeighborCount).toBe(0);
  });

  it("効果は対称: 自セルと近傍を入れ替えても同じ", () => {
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["heat"]],
    ]);
    const a = computeCellAdjacency(m, occupancy, subject(8, ["heat"]));
    const b = computeCellAdjacency(m, occupancy, subject(9, ["heat"]));
    expect(toRaw(b.multiplierFix)).toBe(toRaw(a.multiplierFix));
  });

  it("隣接が無ければ乗数 1.0", () => {
    const occupancy = occupancyOf([[8, ["heat"]]]);
    const result = computeCellAdjacency(m, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.multiplierFix)).toBe(1_000_000);
  });

  it("行列に無いタグペアは効果なし", () => {
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["lore"]],
    ]);
    const result = computeCellAdjacency(m, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(0);
  });

  it("ボーナス合計は ±60% にクランプされる(GDD 6.3(d))", () => {
    // 熱源×熱源 +0.5 を 2 件(過密閾値 3 の直前まで)= +1.0 → +0.6 にクランプ。
    const strong = matrix([pair("heat", "heat", 500_000)]);
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [7, ["heat"]],
      [9, ["heat"]],
    ]);
    const result = computeCellAdjacency(strong, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(toRaw(ADJACENCY_BONUS_CLAMP_FIX));
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(0);
    expect(toRaw(result.multiplierFix)).toBe(1_600_000);
  });

  it("負の係数でも下側 -60% にクランプされ、乗数は 0 未満にならない", () => {
    const harsh = matrix([pair("heat", "heat", -900_000)]);
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["heat"]],
    ]);
    const result = computeCellAdjacency(harsh, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(-600_000);
    expect(toRaw(result.multiplierFix)).toBe(400_000);
  });
});

describe("過密(GDD 6.3(b)(c))", () => {
  const m = matrix();

  it("同一タグ 3 件で 3 件目のボーナスが無効化され超過ペナが付く", () => {
    // 自セル 8 の近傍に heat を 3 つ(7, 9, 2)置く。
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [7, ["heat"]],
      [9, ["heat"]],
      [2, ["heat"]],
    ]);
    const result = computeCellAdjacency(m, occupancy, subject(8, ["heat"]));
    // 先頭 2 件(セルID 昇順で c02, c07)のみボーナス = +0.4、超過 1 件で -0.10。
    expect(toRaw(result.bonusFix)).toBe(400_000);
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-100_000);
    expect(toRaw(result.multiplierFix)).toBe(1_300_000);
    expect(result.overcrowdedNeighborCount).toBe(1);
  });

  it("超過が増えるほどペナが線形に増え、clampFP で止まる", () => {
    const cells: (readonly [number, readonly Tag[]])[] = [[8, ["heat"]]];
    for (const neighbor of neighborCellIndices(8)) cells.push([neighbor, ["heat"]]);
    const result = computeCellAdjacency(m, occupancyOf(cells), subject(8, ["heat"]));
    // 近傍 8 件中 2 件のみ有効 → 超過 6 件 → -0.60(clampFP と一致)。
    expect(result.overcrowdedNeighborCount).toBe(6);
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-600_000);
    expect(toRaw(result.bonusFix)).toBe(400_000);
    expect(toRaw(result.multiplierFix)).toBe(800_000);
  });

  it("複数タグ施設は各タグの過密カウントに同時参加する(GDD 6.3)", () => {
    const both = matrix([pair("heat", "heat", 100_000), pair("noise", "noise", 100_000)]);
    const occupancy = occupancyOf([
      [8, ["heat", "noise"]],
      [7, ["heat", "noise"]],
      [9, ["heat", "noise"]],
      [2, ["heat", "noise"]],
    ]);
    const result = computeCellAdjacency(both, occupancy, subject(8, ["heat", "noise"]));
    // heat と noise の各々で 3 件 → 各々超過 1 件 → ペナ -0.20。
    expect(result.overcrowdedNeighborCount).toBe(2);
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-200_000);
    // 有効 2 件 × 2 タグ = +0.4。
    expect(toRaw(result.bonusFix)).toBe(400_000);
  });

  it("ボーナスが有効になるのはセルID 辞書順の先頭 2 件(順序基準の固定)", () => {
    // heat|heat のみ target=facilityDef("forge") にすると、
    // 有効化された近傍がどれかによって結果が変わる。
    const targeted = matrix([
      pair("heat", "heat", 300_000, { kind: "facilityDef", defId: "hearth" }),
    ]);
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [2, ["heat"]],
      [7, ["heat"]],
      [9, ["heat"]],
    ]);
    const asHearth = computeCellAdjacency(targeted, occupancy, subject(8, ["heat"], "hearth"));
    const asForge = computeCellAdjacency(targeted, occupancy, subject(8, ["heat"], "forge"));
    expect(toRaw(asHearth.bonusFix)).toBe(600_000);
    expect(toRaw(asForge.bonusFix)).toBe(0);
    // ペナは target に依らず掛かる(過密は配置の性質)。
    expect(toRaw(asForge.overcrowdPenaltyFix)).toBe(-100_000);
  });

  it("threshold=1 なら 1 件目から無効化される", () => {
    const strict = createAdjacencyMatrix({
      pairs: [HEAT_PAIR],
      overcrowd: {
        threshold: 1,
        penaltyPerExcessFix: fixFromRaw(-100_000),
        clampFix: fixFromRaw(600_000),
      },
      seedOffset: null,
    });
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["heat"]],
    ]);
    const result = computeCellAdjacency(strict, occupancy, subject(8, ["heat"]));
    expect(toRaw(result.bonusFix)).toBe(0);
    expect(toRaw(result.overcrowdPenaltyFix)).toBe(-100_000);
  });
});

describe("target の解決", () => {
  it("tag ターゲットはそのタグを持つ施設にだけ効く", () => {
    const tagged = matrix([pair("damp", "heat", -100_000, { kind: "tag", tag: "heat" })]);
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["damp"]],
      [14, ["damp"]],
    ]);
    // 近傍の damp は 2 件(cell 9, 14)なので加算で -0.20。
    const heatCell = computeCellAdjacency(tagged, occupancy, subject(8, ["heat"]));
    expect(toRaw(heatCell.bonusFix)).toBe(-200_000);
    // damp 側のセルから見ると target=heat に当たらないので効果なし。
    const dampCell = computeCellAdjacency(tagged, occupancy, subject(9, ["damp"]));
    expect(toRaw(dampCell.bonusFix)).toBe(0);
  });
});

describe("シード揺らぎ(GDD 6.4-2)", () => {
  const range = { minFix: fixFromRaw(-200_000), maxFix: fixFromRaw(200_000) };

  it("seedOffset が null なら恒等(同一参照)", () => {
    const m = matrix();
    expect(applySeedOffsets(m, 12345)).toBe(m);
  });

  it("同じ worldSeed なら同じ係数(決定論)", () => {
    const m = matrix([HEAT_PAIR], range);
    const a = applySeedOffsets(m, 0xdeadbeef);
    const b = applySeedOffsets(m, 0xdeadbeef);
    expect(toRaw(effectValue(a, "heat|heat"))).toBe(toRaw(effectValue(b, "heat|heat")));
  });

  it("worldSeed が変わると係数が変わる(周回で最適レイアウトが動く)", () => {
    const m = matrix([HEAT_PAIR], range);
    const values = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      values.add(toRaw(effectValue(applySeedOffsets(m, seed), "heat|heat")));
    }
    expect(values.size).toBeGreaterThan(10);
  });

  it("揺らぎは ±20% のレンジ内に収まる", () => {
    const m = matrix([HEAT_PAIR], range);
    const base = 200_000;
    for (let seed = 1; seed <= 200; seed++) {
      const value = toRaw(effectValue(applySeedOffsets(m, seed), "heat|heat"));
      expect(value).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(value).toBeLessThanOrEqual(Math.ceil(base * 1.2));
    }
  });

  it("target / effect は揺らぎで変わらない(骨格不変)", () => {
    const m = matrix([pair("heat", "heat", 200_000, { kind: "tag", tag: "heat" })], range);
    const shaken = applySeedOffsets(m, 7);
    const effect = shaken.pairEffects.get("heat|heat");
    expect(effect?.effect).toBe("yieldMul");
    expect(effect?.target).toEqual({ kind: "tag", tag: "heat" });
  });
});

describe("computeFacilityMultipliers", () => {
  it("渡した識別子で乗数を引ける", () => {
    const occupancy = occupancyOf([
      [8, ["heat"]],
      [9, ["heat"]],
    ]);
    const subjects = new Map([
      ["facA", subject(8, ["heat"])],
      ["facB", subject(9, ["heat"])],
    ]);
    const result = computeFacilityMultipliers(matrix(), occupancy, subjects);
    expect([...result.keys()]).toEqual(["facA", "facB"]);
    expect(toRaw(result.get("facA") ?? fixFromRaw(0))).toBe(1_200_000);
  });
});

function effectValue(m: ReturnType<typeof matrix>, key: string): Fix {
  const effect = m.pairEffects.get(key);
  if (effect === undefined) throw new Error(`ペア ${key} が無い`);
  return effect.valueFix;
}
