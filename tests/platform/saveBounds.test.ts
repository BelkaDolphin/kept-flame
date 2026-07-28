// ---------------------------------------------------------------------------
// M3: 分岐木ノード上界(ADR-012(3))の強制のテスト。
//
// ADR-012(3) の主張は「各派遣の resolvedTree は撤退枝が以降ノードを打ち切る
// 性質 + choices が各ノード最大2分岐ゆえ、総ノード ≤2×maxNodes(8)=16/派遣、
// 同時派遣 ≤2 で ≤32 ノード = 定数倍に有界(指数爆発しない)」である。
//
// 探索(`dispatchSnapshots`)の実装は M21〜M23 なので、ここで固定できるのは
//   (1) 上界の値が ADR の積のとおりであること
//   (2) 上界を破ったセーブが**黙って通らない**こと
//   (3) `dispatchSnapshots` を持たない現行のセーブが影響を受けないこと
// の 3 点である。木の内部表現が確定したら
// `persistence.ts` の DISPATCH_TREE_CHILD_KEYS を直す(そこ 1 箇所に集約済み)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  assertDispatchTreeBounds,
  CONCURRENT_DISPATCH_MAX,
  DISPATCH_BRANCH_FACTOR,
  DISPATCH_EVENT_NODES_MAX,
  DISPATCH_TREE_NODES_MAX,
  DISPATCH_TREE_NODES_TOTAL_MAX,
  encodeSaveRecord,
  SaveBoundsError,
} from "../../src/platform/persistence";

import { facility, HEARTH, id, resident, stateOf } from "../engine/fixtures";

const STATE = stateOf([
  resident("residentA", { assignedFacilityId: id("facilityHearth") }),
  facility("facilityHearth", HEARTH.id, 0, [id("residentA")], 2),
]);

/** `count` ノードの鎖(各ノードが子を 1 つ持つ最長の木)。 */
function chainTree(count: number): unknown {
  let node: unknown = { nodeIndex: count - 1 };
  for (let i = count - 2; i >= 0; i--) {
    node = { nodeIndex: i, choices: [node] };
  }
  return node;
}

/** `count` ノードの二分木(撤退 / 強行の 2 分岐が全ノードにある形)。 */
function binaryTree(count: number): unknown {
  const nodes: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) nodes.push({ nodeIndex: i });
  for (let i = count - 1; i >= 1; i--) {
    const parent = nodes[(i - 1) >> 1];
    const child = nodes[i];
    if (parent === undefined || child === undefined) continue;
    const children = (parent["choices"] as unknown[] | undefined) ?? [];
    children.push(child);
    parent["choices"] = children;
  }
  return nodes[0];
}

function saveWith(trees: readonly unknown[]): Record<string, unknown> {
  return {
    saveSchemaVersion: 1,
    dispatchSnapshots: trees.map((resolvedTree, index) => ({
      dispatchId: `dispatch${String(index)}`,
      seed: "seedAlpha",
      resolvedTree,
    })),
  };
}

// --- 1. 上界の値(ADR-012(3) の積) ----------------------------------------

describe("上界の値", () => {
  it("ADR-012(3) の積そのものになっている", () => {
    expect(DISPATCH_EVENT_NODES_MAX).toBe(8);
    expect(DISPATCH_BRANCH_FACTOR).toBe(2);
    expect(CONCURRENT_DISPATCH_MAX).toBe(2);
    expect(DISPATCH_TREE_NODES_MAX).toBe(16);
    expect(DISPATCH_TREE_NODES_TOTAL_MAX).toBe(32);
  });
});

// --- 2. 上界内は通る --------------------------------------------------------

describe("上界内のセーブ", () => {
  it("dispatchSnapshots を持たない現行のセーブは無条件で通る", () => {
    expect(() => assertDispatchTreeBounds({ saveSchemaVersion: 1 })).not.toThrow();
    expect(() => encodeSaveRecord(STATE)).not.toThrow();
  });

  it("派遣 2 本 × 16 ノード(= 上界ちょうど 32)は通る", () => {
    const save = saveWith([
      chainTree(DISPATCH_TREE_NODES_MAX),
      binaryTree(DISPATCH_TREE_NODES_MAX),
    ]);
    expect(() => assertDispatchTreeBounds(save)).not.toThrow();
  });

  it("空の dispatchSnapshots も通る", () => {
    expect(() => assertDispatchTreeBounds(saveWith([]))).not.toThrow();
  });

  it("resolvedTree がまだ無いスナップショットは 0 ノードとして数える", () => {
    expect(() =>
      assertDispatchTreeBounds({ dispatchSnapshots: [{ dispatchId: "d0" }, { dispatchId: "d1" }] }),
    ).not.toThrow();
  });
});

// --- 3. 上界超過は止まる ----------------------------------------------------

describe("上界超過", () => {
  it("同時派遣が 3 本あれば SaveBoundsError", () => {
    const save = saveWith([chainTree(1), chainTree(1), chainTree(1)]);
    expect(() => assertDispatchTreeBounds(save)).toThrow(SaveBoundsError);
  });

  it("1 派遣 17 ノード(鎖)で SaveBoundsError", () => {
    expect(() =>
      assertDispatchTreeBounds(saveWith([chainTree(DISPATCH_TREE_NODES_MAX + 1)])),
    ).toThrow(SaveBoundsError);
  });

  it("1 派遣 17 ノード(二分木)で SaveBoundsError", () => {
    expect(() =>
      assertDispatchTreeBounds(saveWith([binaryTree(DISPATCH_TREE_NODES_MAX + 1)])),
    ).toThrow(SaveBoundsError);
  });

  it("エラーは破った上界の名前と数値を機械可読で持つ", () => {
    let caught: unknown = null;
    try {
      assertDispatchTreeBounds(saveWith([chainTree(DISPATCH_TREE_NODES_MAX + 1)]));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SaveBoundsError);
    const e = caught as SaveBoundsError;
    expect(e.bound).toBe("DISPATCH_TREE_NODES_MAX");
    expect(e.limit).toBe(DISPATCH_TREE_NODES_MAX);
    expect(e.actual).toBeGreaterThan(DISPATCH_TREE_NODES_MAX);
  });

  it("dispatchSnapshots が配列でなければ SaveBoundsError", () => {
    expect(() => assertDispatchTreeBounds({ dispatchSnapshots: { d0: {} } })).toThrow(
      SaveBoundsError,
    );
  });

  it("`children` キーの木でも数えられる(表現が変わっても数え漏らさない)", () => {
    let node: unknown = { nodeIndex: 0 };
    for (let i = 0; i < DISPATCH_TREE_NODES_MAX; i++) node = { nodeIndex: i, children: [node] };
    expect(() => assertDispatchTreeBounds(saveWith([node]))).toThrow(SaveBoundsError);
  });
});
