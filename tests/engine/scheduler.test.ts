import { describe, expect, it } from "vitest";

import {
  EventQueue,
  OFFLINE_CLAMP_TICK,
  PIPELINE_STAGE,
  SchedulerError,
  TICK_MS,
  clampOfflineTickDelta,
  classifyEventBoundary,
  compareScheduledEvents,
  type ScheduledEvent,
  type SchedulerEventKind,
} from "../../src/engine/scheduler";
import { id } from "./fixtures";

// ---------------------------------------------------------------------------
// 離散事象スケジューラ(ADR-008)のうち、state を要さない部分のテスト:
// tie-break の全順序 / ヒープの取り出し順 / 72h クランプ / 境界の分類。
//
// ヒープのテストの狙いは「内部配置に依存しないこと」である。比較器が全順序
// (tick, パイプライン段, entityId)であることと、push 順を変えても取り出し順が
// 同じであることをセットで固定すると、決定論がヒープ実装の詳細から独立する
// (scheduler.ts §3)。
// ---------------------------------------------------------------------------

const event = (
  tick: number,
  kind: SchedulerEventKind,
  entityId: string | null = null,
): ScheduledEvent => ({ tick, kind, entityId: entityId === null ? null : id(entityId) });

const label = (e: ScheduledEvent): string => `${String(e.tick)}:${e.kind}:${e.entityId ?? "-"}`;

describe("72h クランプ(GDD 11.1 / 11.9)", () => {
  it("1 tick = 1 分、上限 = 4320 tick", () => {
    expect(TICK_MS).toBe(60_000);
    expect(OFFLINE_CLAMP_TICK).toBe(4320);
  });

  it("境界値", () => {
    expect(clampOfflineTickDelta(0)).toBe(0);
    expect(clampOfflineTickDelta(1)).toBe(1);
    expect(clampOfflineTickDelta(4319)).toBe(4319);
    expect(clampOfflineTickDelta(4320)).toBe(4320);
    expect(clampOfflineTickDelta(4321)).toBe(4320);
    expect(clampOfflineTickDelta(1_000_000_000)).toBe(4320);
  });

  it("負値(巻き戻し)は 0 に落ちる", () => {
    expect(clampOfflineTickDelta(-1)).toBe(0);
    expect(clampOfflineTickDelta(-999_999)).toBe(0);
  });

  it("整数でない tick 差は例外", () => {
    expect(() => clampOfflineTickDelta(1.5)).toThrow(SchedulerError);
    expect(() => clampOfflineTickDelta(Number.NaN)).toThrow(SchedulerError);
    expect(() => clampOfflineTickDelta(Number.POSITIVE_INFINITY)).toThrow(SchedulerError);
  });
});

describe("パイプライン段(GDD 11.7 の同一tick内優先順位)", () => {
  it("GDD の 9 段が 10 刻みで予約されている", () => {
    expect(PIPELINE_STAGE.raid).toBeLessThan(PIPELINE_STAGE.injury);
    expect(PIPELINE_STAGE.injury).toBeLessThan(PIPELINE_STAGE.production);
    expect(PIPELINE_STAGE.production).toBeLessThan(PIPELINE_STAGE.research);
    expect(PIPELINE_STAGE.research).toBeLessThan(PIPELINE_STAGE.codify);
    expect(PIPELINE_STAGE.codify).toBeLessThan(PIPELINE_STAGE.exploration);
    expect(PIPELINE_STAGE.exploration).toBeLessThan(PIPELINE_STAGE.death);
    expect(PIPELINE_STAGE.death).toBeLessThan(PIPELINE_STAGE.satellite);
    expect(PIPELINE_STAGE.satellite).toBeLessThan(PIPELINE_STAGE.dust);
  });

  it("想起困難の 2 段は「負傷反映 → 生産」の間にあり、回復が抽選より先", () => {
    expect(PIPELINE_STAGE.injury).toBeLessThan(PIPELINE_STAGE.recallRecover);
    expect(PIPELINE_STAGE.recallRecover).toBeLessThan(PIPELINE_STAGE.recallRoll);
    expect(PIPELINE_STAGE.recallRoll).toBeLessThan(PIPELINE_STAGE.production);
  });
});

describe("tie-break の全順序(scheduler.ts §3)", () => {
  it("第 1 キーは tick", () => {
    expect(
      compareScheduledEvents(event(1, "researchComplete", "r"), event(2, "recallRecover", "a")),
    ).toBeLessThan(0);
  });

  it("同 tick ならパイプライン段: 回復 → 抽選 → 研究完了", () => {
    const recover = event(10, "recallRecover", "aRui");
    const roll = event(10, "stochasticStep");
    const research = event(10, "researchComplete", "rBronze");
    expect(compareScheduledEvents(recover, roll)).toBeLessThan(0);
    expect(compareScheduledEvents(roll, research)).toBeLessThan(0);
    expect(compareScheduledEvents(research, recover)).toBeGreaterThan(0);
  });

  it("同 tick・同段なら entityId の UTF-16 昇順(GDD 11.7)", () => {
    expect(
      compareScheduledEvents(
        event(10, "recallRecover", "aRui"),
        event(10, "recallRecover", "bMina"),
      ),
    ).toBeLessThan(0);
    expect(
      compareScheduledEvents(
        event(10, "recallRecover", "bMina"),
        event(10, "recallRecover", "aRui"),
      ),
    ).toBeGreaterThan(0);
  });

  it("3 つ組が同じときだけ 0(= 全順序)", () => {
    expect(compareScheduledEvents(event(10, "stochasticStep"), event(10, "stochasticStep"))).toBe(
      0,
    );
  });

  it("反対称性: compare(a,b) と compare(b,a) の符号が逆", () => {
    const events = [
      event(10, "recallRecover", "aRui"),
      event(10, "recallRecover", "bMina"),
      event(10, "stochasticStep"),
      event(11, "researchComplete", "rBronze"),
      event(9, "stochasticStep"),
    ];
    for (const a of events) {
      for (const b of events) {
        const forward = compareScheduledEvents(a, b);
        const backward = compareScheduledEvents(b, a);
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
      }
    }
  });
});

describe("イベント境界の分類((A)(B)(C)・GDD 11.8)", () => {
  it("研究完了と想起困難の回復は (B) レート変化", () => {
    expect(classifyEventBoundary("researchComplete")).toBe("rateChange");
    expect(classifyEventBoundary("recallRecover")).toBe("rateChange");
  });

  it("粗粒度ステップは (C) 確率イベント境界", () => {
    expect(classifyEventBoundary("stochasticStep")).toBe("stochastic");
  });
});

describe("離散事象ヒープ", () => {
  const sample: readonly ScheduledEvent[] = [
    event(30, "stochasticStep"),
    event(10, "recallRecover", "bMina"),
    event(10, "recallRecover", "aRui"),
    event(10, "stochasticStep"),
    event(10, "researchComplete", "rBronze"),
    event(20, "stochasticStep"),
    event(5, "recallRecover", "cSora"),
    event(25, "recallRecover", "dTaki"),
    event(15, "recallRecover", "eYuki"),
  ];

  const expectedOrder = [
    "5:recallRecover:cSora",
    "10:recallRecover:aRui",
    "10:recallRecover:bMina",
    "10:stochasticStep:-",
    "10:researchComplete:rBronze",
    "15:recallRecover:eYuki",
    "20:stochasticStep:-",
    "25:recallRecover:dTaki",
    "30:stochasticStep:-",
  ];

  function drain(events: readonly ScheduledEvent[]): readonly string[] {
    const queue = new EventQueue();
    for (const e of events) queue.push(e);
    return queue.drainSorted().map(label);
  }

  it("取り出し順が全順序に一致する", () => {
    expect(drain(sample)).toEqual(expectedOrder);
  });

  it("push 順を変えても取り出し順が同じ(内部配置に依存しない)", () => {
    expect(drain([...sample].reverse())).toEqual(expectedOrder);
    // 決定論的な別順序(添字の巡回シフト)でも同じ。
    for (let shift = 1; shift < sample.length; shift++) {
      const rotated = [...sample.slice(shift), ...sample.slice(0, shift)];
      expect(drain(rotated)).toEqual(expectedOrder);
    }
  });

  it("peekTick / size / peek", () => {
    const queue = new EventQueue();
    expect(queue.peekTick()).toBe(null);
    expect(queue.peek()).toBe(undefined);
    expect(queue.size).toBe(0);
    for (const e of sample) queue.push(e);
    expect(queue.size).toBe(sample.length);
    expect(queue.peekTick()).toBe(5);
    expect(label(queue.peek() ?? event(0, "stochasticStep"))).toBe("5:recallRecover:cSora");
  });

  it("同一キー(tick, 段, entityId)の重複 push は例外", () => {
    const queue = new EventQueue();
    queue.push(event(10, "stochasticStep"));
    expect(() => queue.push(event(10, "stochasticStep"))).toThrow(SchedulerError);
    queue.push(event(10, "recallRecover", "aRui"));
    expect(() => queue.push(event(10, "recallRecover", "aRui"))).toThrow(SchedulerError);
    // tick か entityId が違えば通る。
    expect(() => queue.push(event(11, "recallRecover", "aRui"))).not.toThrow();
    expect(() => queue.push(event(10, "recallRecover", "bMina"))).not.toThrow();
  });

  it("pop したキーは再 push できる", () => {
    const queue = new EventQueue();
    queue.push(event(10, "stochasticStep"));
    queue.pop();
    expect(() => queue.push(event(10, "stochasticStep"))).not.toThrow();
  });

  it("空 pop は例外", () => {
    expect(() => new EventQueue().pop()).toThrow(SchedulerError);
  });

  it("pushAfter は現在 tick 以前への再予約を拒否する(進行保証)", () => {
    const queue = new EventQueue();
    expect(() => queue.pushAfter(event(10, "stochasticStep"), 10)).toThrow(SchedulerError);
    expect(() => queue.pushAfter(event(9, "stochasticStep"), 10)).toThrow(SchedulerError);
    expect(() => queue.pushAfter(event(11, "stochasticStep"), 10)).not.toThrow();
  });

  it("tick が負や非整数のイベントは例外", () => {
    const queue = new EventQueue();
    expect(() => queue.push(event(-1, "stochasticStep"))).toThrow(SchedulerError);
    expect(() => queue.push(event(1.5, "stochasticStep"))).toThrow(SchedulerError);
  });

  it("remove 後も取り出し順が保たれる", () => {
    const queue = new EventQueue();
    for (const e of sample) queue.push(e);
    queue.remove("recallRecover", id("bMina"));
    queue.remove("researchComplete", id("rBronze"));
    expect(queue.drainSorted().map(label)).toEqual(
      expectedOrder.filter((l) => !l.includes("bMina") && !l.includes("rBronze")),
    );
  });

  it("remove は同キーの再 push を許す(予測の作り直し)", () => {
    const queue = new EventQueue();
    queue.push(event(50, "researchComplete", "rBronze"));
    queue.remove("researchComplete", id("rBronze"));
    expect(queue.size).toBe(0);
    expect(() => queue.push(event(50, "researchComplete", "rBronze"))).not.toThrow();
  });

  it("remove は該当なしでも安全", () => {
    const queue = new EventQueue();
    queue.push(event(10, "stochasticStep"));
    queue.remove("researchComplete", id("rBronze"));
    expect(queue.size).toBe(1);
  });

  it("findByKind は単一前提を検査する", () => {
    const queue = new EventQueue();
    expect(queue.findByKind("researchComplete")).toBe(undefined);
    queue.push(event(50, "researchComplete", "rBronze"));
    expect(queue.findByKind("researchComplete")?.tick).toBe(50);
    queue.push(event(60, "researchComplete", "rIron"));
    expect(() => queue.findByKind("researchComplete")).toThrow(SchedulerError);
  });

  it("100 件でもヒープ順序が壊れない(sift の回帰)", () => {
    const queue = new EventQueue();
    const ticks: number[] = [];
    // 決定論的な擬似シャッフル(素数ステップで巡回)。
    for (let i = 0; i < 100; i++) {
      const tick = ((i * 37) % 100) + 1;
      ticks.push(tick);
      queue.push(event(tick, "stochasticStep"));
    }
    expect(queue.drainSorted().map((e) => e.tick)).toEqual([...ticks].sort((a, b) => a - b));
  });
});
