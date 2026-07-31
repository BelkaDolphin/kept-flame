// ---------------------------------------------------------------------------
// T11: `src/platform/catchUp.ts`(Worker catch-up の Worker 非依存な純粋部)の
// テスト。ここが固定するのは ADR-029(1) / ADR-026(3) の核である:
//
//   (1) 二系統(可変ドラフト / 構造共有)の切替点が 1 箇所にあり、未実装側は
//       黙って構造共有へフォールバックせず**必ず落ちる**
//   (2) 経路選択のしきい値(ADR-026(3) の 600 tick)
//   (3) Worker 越しに出る state は engine の advance と**完全に同一**
//   (4) 1 リクエストにつき完了メッセージは**ちょうど 1 通**
//       (= 途中経過の state を投げない・「完了時に一度だけスナップショット」)
//   (5) スナップショットの不変条件(ID 昇順 / キーと id の一致)の検査
//
// Worker 実体(`worker.ts` / `workerClient.ts`)はブラウザ API に依存するので
// ここでは回さず、`bench/perfSmoke.spec.ts`(Playwright / 実 Chromium)で
// 「実際に往復して B1 が出る」ことを確認する。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { advanceWithReport, createAdvanceContext } from "../../src/engine/advance";
import { toSerializable } from "../../src/engine/state/serialize";
import type { EntityId, EntityState, GameState } from "../../src/engine/state/state";
import {
  ACTIVE_CATCH_UP_STRATEGY,
  assertCanonicalSnapshot,
  CATCH_UP_PROTOCOL_VERSION,
  CATCH_UP_UPDATE_MODES,
  CatchUpError,
  chooseCatchUpRoute,
  createWorkerSession,
  LIVE_ADVANCE_MAX_TICK_DELTA,
  restoreAdvanceContext,
  runCatchUp,
  type WorkerToMainMessage,
} from "../../src/platform/catchUp";

import {
  content,
  facility,
  FORGE,
  HEARTH,
  id,
  research,
  resident,
  resource,
  stateOf,
  TECH_BRONZE,
  WOOD,
} from "../engine/fixtures";

const CONTENT = content();

const BOARD: GameState = stateOf([
  resident("residentA", { assignedFacilityId: id("facilityForge") }),
  resident("residentB", { assignedFacilityId: id("facilityHearth") }),
  facility("facilityForge", FORGE.id, 6, [id("residentA")], 2),
  facility("facilityHearth", HEARTH.id, 0, [id("residentB")], 1),
  research("researchBronze", TECH_BRONZE.id),
  resource("resourceWood", WOOD),
]);

const TARGET_TICK = 4320;

// --- 1. 経路選択(ADR-026(3)) ---------------------------------------------

describe("chooseCatchUpRoute", () => {
  it("しきい値は ADR-026(3) の 600 tick", () => {
    expect(LIVE_ADVANCE_MAX_TICK_DELTA).toBe(600);
  });

  it("600 tick まではメインスレッド同期 advance", () => {
    expect(chooseCatchUpRoute(0)).toBe("main-structural-sharing");
    expect(chooseCatchUpRoute(599)).toBe("main-structural-sharing");
    expect(chooseCatchUpRoute(600)).toBe("main-structural-sharing");
  });

  it("600 tick を超えたら Worker オフロード", () => {
    expect(chooseCatchUpRoute(601)).toBe("worker-draft-snapshot");
    expect(chooseCatchUpRoute(4320)).toBe("worker-draft-snapshot");
  });

  it("負値・非整数は CatchUpError(巻戻しは別責務)", () => {
    expect(() => chooseCatchUpRoute(-1)).toThrow(CatchUpError);
    expect(() => chooseCatchUpRoute(1.5)).toThrow(CatchUpError);
    expect(() => chooseCatchUpRoute(Number.NaN)).toThrow(CatchUpError);
  });
});

// --- 2. 二系統の切替点(ADR-029(1)) ---------------------------------------

describe("CATCH_UP_UPDATE_MODES(二系統の切替点)", () => {
  it("系統はちょうど 2 つ(構造共有 / 可変ドラフト)", () => {
    expect(Object.keys(CATCH_UP_UPDATE_MODES).sort()).toEqual([
      "mutable-draft",
      "structural-sharing",
    ]);
  });

  it("各モードの id は自分のキーと一致する(取り違え検出)", () => {
    expect(CATCH_UP_UPDATE_MODES["structural-sharing"].id).toBe("structural-sharing");
    expect(CATCH_UP_UPDATE_MODES["mutable-draft"].id).toBe("mutable-draft");
  });

  it("現在有効な系統は構造共有(可変ドラフトは engine 側 API 待ち)", () => {
    expect(ACTIVE_CATCH_UP_STRATEGY).toBe("structural-sharing");
  });

  it("可変ドラフト系は黙って構造共有へ落ちず必ず失敗する", () => {
    expect(() => runCatchUp(BOARD, CONTENT, TARGET_TICK, "mutable-draft")).toThrow(CatchUpError);
    expect(() => runCatchUp(BOARD, CONTENT, TARGET_TICK, "mutable-draft")).toThrow(/ADR-029/);
  });
});

// --- 3. Worker 経路の結果は engine と完全に同一 ------------------------------

describe("runCatchUp", () => {
  const outcome = runCatchUp(BOARD, CONTENT, TARGET_TICK);
  const direct = advanceWithReport(BOARD, createAdvanceContext(BOARD, CONTENT), TARGET_TICK);

  it("engine の advance とバイト同一の state を返す", () => {
    expect(JSON.stringify(toSerializable(outcome.snapshot))).toBe(
      JSON.stringify(toSerializable(direct.state)),
    );
  });

  it("カウンタも engine の report と一致する", () => {
    expect(outcome.counters).toEqual({
      segmentCount: direct.segmentCount,
      stochasticStepCount: direct.stochasticStepCount,
      stochasticTrialCount: direct.stochasticTrialCount,
      rateChangeEventCount: direct.rateChangeEventCount,
      recallOccurrenceCount: direct.recallOccurrenceCount,
    });
  });

  it("目標 tick へ到達する", () => {
    expect(outcome.snapshot.tick).toBe(TARGET_TICK);
  });

  it("既定の系統は ACTIVE_CATCH_UP_STRATEGY", () => {
    expect(outcome.strategy).toBe(ACTIVE_CATCH_UP_STRATEGY);
  });

  it("隣接乗数を返すのでメイン側は createAdvanceContext を呼び直さなくてよい", () => {
    const ctx = createAdvanceContext(BOARD, CONTENT);
    expect(outcome.advanceContext.worldSeedU32).toBe(ctx.worldSeedU32);
    expect([...outcome.advanceContext.multiplierByFacilityId.entries()]).toEqual([
      ...ctx.multiplierByFacilityId.entries(),
    ]);
  });

  it("restoreAdvanceContext は計算せず content と繋ぎ直すだけ", () => {
    const restored = restoreAdvanceContext(CONTENT, outcome.advanceContext);
    expect(restored.content).toBe(CONTENT);
    expect(restored.worldSeedU32).toBe(outcome.advanceContext.worldSeedU32);
    expect(restored.multiplierByFacilityId).toBe(outcome.advanceContext.multiplierByFacilityId);
  });

  it("内訳は 3 段(コンテキスト構築 / advance / スナップショット化)で非負", () => {
    expect(Object.keys(outcome.phaseMs).sort()).toEqual([
      "advanceMs",
      "contextBuildMs",
      "snapshotMs",
    ]);
    for (const value of Object.values(outcome.phaseMs)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});

// --- 4. スナップショットの不変条件 ------------------------------------------

/** entityStateById の反復順を壊した GameState を作る(不正な state の合成)。 */
function withEntityOrder(state: GameState, ids: readonly EntityId[]): GameState {
  const entries: (readonly [EntityId, EntityState])[] = ids.map((entityId) => {
    const entity = state.entityStateById.get(entityId);
    if (entity === undefined) throw new Error(`テスト前提の entity ${entityId} が無い`);
    return [entityId, entity] as const;
  });
  return {
    saveSchemaVersion: state.saveSchemaVersion,
    contentVersion: state.contentVersion,
    algoVersion: state.algoVersion,
    worldSeed: state.worldSeed,
    tick: state.tick,
    entityStateById: new Map(entries),
    rngState: state.rngState,
    bondByPairKey: state.bondByPairKey,
    techMemoryByKey: state.techMemoryByKey,
    dispatchSnapshots: state.dispatchSnapshots,
    renderedLogs: state.renderedLogs,
    // [M24] 新規必須フィールド。既存の合成テストが直接 GameState リテラルを
    // 組み立てているため typecheck 上不可避の追随(state.ts 不変条件 (h))。
    outpostsById: state.outpostsById,
    // [M52] 同上(state.ts 不変条件 (i))。地形は瓦礫ゼロのまま引き継ぐ。
    terrain: state.terrain,
    // [M28] 同上(state.ts 不変条件 (j))。周回進行は既定のまま引き継ぐ。
    progression: state.progression,
    // [M50] 同上(state.ts 不変条件 (k))。研究対象の選択は引き継ぐ。
    selectedResearchId: state.selectedResearchId,
  };
}

describe("assertCanonicalSnapshot", () => {
  it("engine が作った state は通る", () => {
    expect(() => {
      assertCanonicalSnapshot(BOARD);
    }).not.toThrow();
  });

  it("ID 昇順が壊れていたら CatchUpError(可変ドラフトの in-place 事故の検出器)", () => {
    const reversed = withEntityOrder(BOARD, [...BOARD.entityStateById.keys()].reverse());
    expect(() => {
      assertCanonicalSnapshot(reversed);
    }).toThrow(CatchUpError);
  });

  it("キーと entity.id の食い違いは CatchUpError", () => {
    const first = [...BOARD.entityStateById.values()][0];
    if (first === undefined) throw new Error("テスト前提が崩れている");
    const broken: GameState = {
      saveSchemaVersion: BOARD.saveSchemaVersion,
      contentVersion: BOARD.contentVersion,
      algoVersion: BOARD.algoVersion,
      worldSeed: BOARD.worldSeed,
      tick: BOARD.tick,
      entityStateById: new Map([[id("residentZzz"), first]]),
      rngState: BOARD.rngState,
      bondByPairKey: BOARD.bondByPairKey,
      techMemoryByKey: BOARD.techMemoryByKey,
      dispatchSnapshots: BOARD.dispatchSnapshots,
      renderedLogs: BOARD.renderedLogs,
      // [M24] 新規必須フィールド(state.ts 不変条件 (h))。理由は上記 withEntityOrder と同じ。
      outpostsById: BOARD.outpostsById,
      // [M52] 同上(state.ts 不変条件 (i))。
      terrain: BOARD.terrain,
      // [M28] 同上(state.ts 不変条件 (j))。
      progression: BOARD.progression,
      // [M50] 同上(state.ts 不変条件 (k))。
      selectedResearchId: BOARD.selectedResearchId,
    };
    expect(() => {
      assertCanonicalSnapshot(broken);
    }).toThrow(CatchUpError);
  });

  it("構造共有系の snapshot はコピーせず同一参照を返す(余分なアロケーションを作らない)", () => {
    expect(CATCH_UP_UPDATE_MODES["structural-sharing"].snapshot(BOARD)).toBe(BOARD);
  });
});

// --- 5. Worker セッション(1 リクエスト = 完了メッセージ 1 通) -------------

function collect(): {
  readonly posted: WorkerToMainMessage[];
  readonly post: (message: WorkerToMainMessage) => void;
} {
  const posted: WorkerToMainMessage[] = [];
  return {
    posted,
    post: (message) => {
      posted.push(message);
    },
  };
}

describe("createWorkerSession", () => {
  it("init で content を受け取り ready を 1 通返す(content 1回転送)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    expect(session.isInitialized()).toBe(false);
    session.handle({ kind: "init", content: CONTENT });
    expect(session.isInitialized()).toBe(true);
    expect(sink.posted).toEqual([{ kind: "ready" }]);
  });

  it("catch-up 1 回につき完了メッセージはちょうど 1 通(途中経過を投げない)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    session.handle({ kind: "init", content: CONTENT });
    session.handle({
      kind: "catchUp",
      requestId: 7,
      state: BOARD,
      targetTick: TARGET_TICK,
      strategy: ACTIVE_CATCH_UP_STRATEGY,
    });
    const done = sink.posted.filter((m) => m.kind === "done");
    expect(done.length).toBe(1);
    expect(sink.posted.length).toBe(2); // ready + done のみ
    const message = done[0];
    if (message?.kind !== "done") throw new Error("done メッセージが無い");
    expect(message.requestId).toBe(7);
    expect(message.snapshot.tick).toBe(TARGET_TICK);
    expect(message.counters.stochasticStepCount).toBeGreaterThan(0);
    expect(message.handlerMs).toBeGreaterThanOrEqual(0);
  });

  it("Worker が返す state は engine の advance とバイト同一", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    session.handle({ kind: "init", content: CONTENT });
    session.handle({
      kind: "catchUp",
      requestId: 1,
      state: BOARD,
      targetTick: TARGET_TICK,
      strategy: ACTIVE_CATCH_UP_STRATEGY,
    });
    const message = sink.posted[1];
    if (message?.kind !== "done") throw new Error("done メッセージが無い");
    const direct = advanceWithReport(BOARD, createAdvanceContext(BOARD, CONTENT), TARGET_TICK);
    expect(JSON.stringify(toSerializable(message.snapshot))).toBe(
      JSON.stringify(toSerializable(direct.state)),
    );
  });

  it("init より先に catchUp が来たら failed(黙って content 無しで走らない)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    session.handle({
      kind: "catchUp",
      requestId: 3,
      state: BOARD,
      targetTick: TARGET_TICK,
      strategy: ACTIVE_CATCH_UP_STRATEGY,
    });
    expect(sink.posted.length).toBe(1);
    const message = sink.posted[0];
    if (message?.kind !== "failed") throw new Error("failed メッセージが無い");
    expect(message.requestId).toBe(3);
  });

  it("未知のメッセージは failed(例外を Worker 外へ漏らさない)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    expect(() => {
      session.handle({ kind: "nope" });
    }).not.toThrow();
    session.handle(42);
    session.handle(null);
    expect(sink.posted.every((m) => m.kind === "failed")).toBe(true);
    expect(sink.posted.length).toBe(3);
  });

  it("content の形が違う init は failed(構造化複製の破損検出)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    session.handle({ kind: "init", content: { facilityDefs: {}, techDefs: {} } });
    expect(session.isInitialized()).toBe(false);
    expect(sink.posted[0]?.kind).toBe("failed");
  });

  it("可変ドラフトを要求されたら failed(未実装を隠さない)", () => {
    const sink = collect();
    const session = createWorkerSession(sink.post);
    session.handle({ kind: "init", content: CONTENT });
    session.handle({
      kind: "catchUp",
      requestId: 9,
      state: BOARD,
      targetTick: TARGET_TICK,
      strategy: "mutable-draft",
    });
    const message = sink.posted[1];
    if (message?.kind !== "failed") throw new Error("failed メッセージが無い");
    expect(message.message).toContain("ADR-029");
  });
});

describe("プロトコル版", () => {
  it("正の整数で固定されている", () => {
    expect(Number.isSafeInteger(CATCH_UP_PROTOCOL_VERSION)).toBe(true);
    expect(CATCH_UP_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
