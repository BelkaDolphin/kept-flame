// ---------------------------------------------------------------------------
// ⑫帰還ダイジェスト(M29)のテスト — GDD 4.2 / 8.4
//
// 検証するのは 3 段構成(ネガティブ先頭単独表示 → ダイジェスト → ドリルダウン)と、
// **engine の既存データしか読んでいない**ことの帰結:
//   1. 先頭は必ず 1 件だけ、優先順は (B)喪失 > 死亡 > (A)喪失 > 相方喪失
//   2. 「不在中」は `sinceTick` より後の出来事に限る(以前のものを混ぜない)
//   3. **未帰還の派遣スナップショットから結果を読まない**(ネタバレ防止)
//   4. 帰還ログはレンダリング済み文字列をそのまま新しい順に出す(50件上限の
//      畳み件数も併記)
//   5. 行は必ず遷移先の画面 ID を持つ(ドリルダウン = 3 段目)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromInt } from "../../../src/engine/fp";
import type {
  DispatchSnapshot,
  EntityState,
  GameState,
  MemoirEntry,
  RenderedLogState,
  ResearchState,
} from "../../../src/engine/state/state";
import { createGameState } from "../../../src/engine/state/update";
import {
  DIGEST_ROW_IDS,
  buildReturnDigest,
  type DigestRowId,
  type GridSummary,
} from "../../../src/ui/derived";
import { DIGEST_LEAD_TEXT, DIGEST_ROW_TEXT } from "../../../src/ui/screens/digest/ReturnDigest";
import { HEARTH, TECH_BRONZE, WOOD, facility, id, resident, resource } from "../fixtures";

const SINCE_TICK = 100;
const NOW_TICK = 1_600;

const EMPTY_GRID_SUMMARY: GridSummary = {
  occupiedCellCount: 1,
  emptyCellCount: 47,
  overcrowdedFacilityCount: 0,
  overcrowdedNeighborTotal: 0,
};

interface BoardOptions {
  readonly entities?: readonly EntityState[];
  readonly renderedLogs?: RenderedLogState;
  readonly dispatchSnapshots?: readonly DispatchSnapshot[];
}

function board(options: BoardOptions = {}): GameState {
  return createGameState(
    {
      saveSchemaVersion: 5,
      contentVersion: 1,
      algoVersion: 3,
      worldSeed: "return-digest-test",
      tick: NOW_TICK,
    },
    [facility("fHearth", HEARTH.id, 14), resource("wStock", WOOD), ...(options.entities ?? [])],
    [],
    [],
    [],
    options.dispatchSnapshots ?? [],
    options.renderedLogs,
  );
}

function digestOf(state: GameState, gridSummary: GridSummary = EMPTY_GRID_SUMMARY) {
  return buildReturnDigest(state, { sinceTick: SINCE_TICK, gridSummary });
}

function lostResearch(name: string, tick: number, irreversible: boolean): ResearchState {
  return {
    kind: "research",
    id: id(name),
    techId: TECH_BRONZE.id,
    progress: fixFromInt(0),
    completedTick: null,
    loss: { tick, irreversible },
  };
}

function deadResident(name: string, diedTick: number): EntityState {
  return {
    ...resident(name),
    life: { bornTick: -1000, lifespanTick: 5000, diedTick },
  };
}

function withMemoir(name: string, entries: readonly MemoirEntry[]): EntityState {
  return { ...resident(name), memoir: { entries, foldedCount: 0 } };
}

// --- 1 段目: ネガティブ先頭単独表示 -----------------------------------------

describe("buildReturnDigest: 1 段目(ネガティブ先頭単独表示)", () => {
  it("何も起きていなければ kind='none'(悪い知らせは無い)", () => {
    const digest = digestOf(board());
    expect(digest.lead.kind).toBe("none");
    expect(digest.lead.count).toBe(0);
    expect(digest.hasNews).toBe(false);
  });

  it("(B) 一回性喪失が最優先(死亡や (A) 喪失より先に出る)", () => {
    const digest = digestOf(
      board({
        entities: [lostResearch("resRare", 900, true), deadResident("rDead", 500)],
      }),
    );
    expect(digest.lead.kind).toBe("rareTechLost");
    expect(digest.lead.screen).toBe("research");
    expect(digest.lead.tick).toBe(900);
  });

  it("(B) が無ければ死亡 > (A) 喪失の順", () => {
    const withDeath = digestOf(
      board({ entities: [lostResearch("resSlow", 900, false), deadResident("rDead", 950)] }),
    );
    expect(withDeath.lead.kind).toBe("residentDeath");

    const onlyRecoverable = digestOf(board({ entities: [lostResearch("resSlow", 900, false)] }));
    expect(onlyRecoverable.lead.kind).toBe("recoverableTechLost");
  });

  it("同種が複数あっても先頭は 1 件だけで、件数は count に畳む", () => {
    const digest = digestOf(
      board({ entities: [deadResident("rA", 300), deadResident("rB", 200)] }),
    );
    expect(digest.lead.kind).toBe("residentDeath");
    expect(digest.lead.count).toBe(2);
    // 代表は「先に起きた方」(tick 昇順 → ID 昇順の全順序)。
    expect(digest.lead.tick).toBe(200);
    expect(digest.lead.subjectId).toBe(id("rB"));
  });

  it("sinceTick 以前の出来事は「不在中」に含めない", () => {
    const digest = digestOf(
      board({ entities: [deadResident("rOld", SINCE_TICK), lostResearch("resOld", 50, true)] }),
    );
    expect(digest.lead.kind).toBe("none");
    expect(digest.rows).toEqual([]);
  });
});

// --- 2 段目 / 3 段目: 要約行とドリルダウン ------------------------------------

describe("buildReturnDigest: 2 段目(要約)と 3 段目(ドリルダウン)", () => {
  it("行は必ず遷移先の画面 ID を持つ(ワンタップ遷移の材料)", () => {
    const digest = digestOf(
      board({
        entities: [
          deadResident("rDead", 500),
          withMemoir("rNew", [{ kind: "arrival", tick: 600 }]),
        ],
        renderedLogs: { entries: [{ tick: 700, text: "近郊から隊が戻った。" }], foldedCount: 0 },
      }),
    );
    expect(digest.rows.length).toBeGreaterThan(0);
    for (const row of digest.rows) {
      expect(row.count).toBeGreaterThan(0);
      expect(row.screen.length).toBeGreaterThan(0);
    }
    const byId = new Map(digest.rows.map((row) => [row.id, row]));
    expect(byId.get("residentDeaths")?.screen).toBe("residents");
    expect(byId.get("returnLogs")?.screen).toBe("chronicle");
    expect(byId.get("arrivals")?.screen).toBe("residents");
  });

  it("行の並びは DIGEST_ROW_IDS の宣言順(悪い知らせが先)", () => {
    const digest = digestOf(
      board({
        entities: [
          deadResident("rDead", 500),
          withMemoir("rNew", [
            { kind: "arrival", tick: 600 },
            { kind: "bondMilestone", tick: 610, partnerId: id("rDead"), tier: 1 },
          ]),
        ],
      }),
      { ...EMPTY_GRID_SUMMARY, overcrowdedFacilityCount: 2 },
    );
    const order = digest.rows.map((row) => row.id);
    const expected: DigestRowId[] = DIGEST_ROW_IDS.filter((rowId) => order.includes(rowId));
    expect(order).toEqual(expected);
    expect(order[0]).toBe("residentDeaths");
  });

  it("過密施設は gridSummary から取る(⑫は gridSummary を読んでよい画面)", () => {
    const digest = digestOf(board(), {
      ...EMPTY_GRID_SUMMARY,
      overcrowdedFacilityCount: 3,
      overcrowdedNeighborTotal: 5,
    });
    const row = digest.rows.find((candidate) => candidate.id === "overcrowdedFacilities");
    expect(row?.count).toBe(3);
    expect(row?.negative).toBe(true);
    expect(row?.screen).toBe("grid");
  });

  it("保護・加入・絆節目は memoir の tick で「不在中」に絞られる", () => {
    const digest = digestOf(
      board({
        entities: [
          withMemoir("rHero", [
            { kind: "explorationRescue", tick: 50, rescuedId: id("rOld"), band: "near" },
            { kind: "explorationRescue", tick: 500, rescuedId: id("rNew"), band: "far" },
            { kind: "arrival", tick: 700 },
            { kind: "bondMilestone", tick: 90, partnerId: id("rOld"), tier: 1 },
          ]),
        ],
      }),
    );
    const counts = new Map(digest.rows.map((row) => [row.id, row.count]));
    expect(counts.get("rescues")).toBe(1); // tick 50 は不在前なので数えない
    expect(counts.get("arrivals")).toBe(1);
    expect(counts.has("bondMilestones")).toBe(false); // tick 90 も不在前
  });
});

// --- 帰還ログ ----------------------------------------------------------------

describe("buildReturnDigest: 帰還ログ(GDD 8.4)", () => {
  it("レンダリング済み文字列を新しい順に出し、不在前のものは出さない", () => {
    const digest = digestOf(
      board({
        renderedLogs: {
          entries: [
            { tick: 50, text: "むかしの帰還" },
            { tick: 400, text: "近郊から戻った" },
            { tick: 900, text: "遠隔から戻った" },
          ],
          foldedCount: 7,
        },
      }),
    );
    expect(digest.logEntries.map((entry) => entry.text)).toEqual([
      "遠隔から戻った",
      "近郊から戻った",
    ]);
    expect(digest.foldedLogCount).toBe(7);
  });
});

// --- ネタバレ防止 ------------------------------------------------------------

describe("buildReturnDigest: 未帰還の派遣から結果を読まない(ネタバレ防止)", () => {
  it("脱落者・全滅が確定しているスナップショットでも件数しか出さない", () => {
    const snapshot: DispatchSnapshot = {
      id: id("dspA"),
      destinationId: id("destFar"),
      band: "far",
      stance: "cautious",
      memberIds: [id("rGo1"), id("rGo2")],
      dispatchTick: 200,
      returnTick: NOW_TICK + 500,
      teamPowerFix: fixFromInt(120),
      nodes: [],
      withdrawn: false,
      rewardFix: fixFromInt(0),
      rewardResourceId: WOOD,
      // 帰還時に**全員**脱落することが既に確定している(GDD 12.5-7)。
      casualtyMemberIds: [id("rGo1"), id("rGo2")],
    };
    const digest = digestOf(board({ dispatchSnapshots: [snapshot] }));

    // 悪い知らせとしては扱わない(まだ起きていないので)。
    expect(digest.lead.kind).toBe("none");
    const row = digest.rows.find((candidate) => candidate.id === "expeditionsInFlight");
    expect(row?.count).toBe(1);
    expect(row?.negative).toBe(false);
    // 脱落者の ID がダイジェストのどこにも現れない。
    expect(JSON.stringify(digest)).not.toContain("rGo1");
  });
});

// --- 入力検査 ----------------------------------------------------------------

describe("buildReturnDigest: 入力検査", () => {
  it("sinceTick が現在 tick より未来なら例外(起点の取り違えを黙って通さない)", () => {
    expect(() =>
      buildReturnDigest(board(), {
        sinceTick: NOW_TICK + 1,
        gridSummary: EMPTY_GRID_SUMMARY,
      }),
    ).toThrow(RangeError);
  });

  it("経過 tick は now - since", () => {
    const digest = digestOf(board());
    expect(digest.elapsedTicks).toBe(NOW_TICK - SINCE_TICK);
  });
});

// --- 文言テーブル ------------------------------------------------------------

describe("ReturnDigest の文言テーブル(登録漏れの検出)", () => {
  it("全行種別に記号 + ラベル + 単位がある", () => {
    for (const rowId of DIGEST_ROW_IDS) {
      const text = DIGEST_ROW_TEXT[rowId];
      expect(text.mark.length).toBeGreaterThan(0);
      expect(text.label.length).toBeGreaterThan(0);
      expect(text.unit.length).toBeGreaterThan(0);
    }
  });

  it("全先頭種別に記号 + 見出し + 本文 + ボタン文言がある", () => {
    for (const kind of [
      "rareTechLost",
      "residentDeath",
      "recoverableTechLost",
      "partnerLost",
      "none",
    ] as const) {
      const text = DIGEST_LEAD_TEXT[kind];
      expect(text.mark.length).toBeGreaterThan(0);
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.body.length).toBeGreaterThan(0);
      expect(text.action.length).toBeGreaterThan(0);
    }
  });
});
