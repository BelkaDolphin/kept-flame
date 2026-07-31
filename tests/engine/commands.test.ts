// ---------------------------------------------------------------------------
// M49: engine コマンド層(`src/engine/commands.ts`)のテスト。
//
// 固定するのは 5 点:
//   (1) **プレイヤー操作による state 変更はすべて `apply` を通る**(語彙の全数と、
//       予約語彙が黙って何もしないコマンドになっていないこと)
//   (2) 無効なコマンドは黙って無視されず、機械可読の reject が返る
//       (silent failure 禁止・commands.ts §3)。**state は 1 bit も動かない**
//   (3) 純関数であること(入力 state 不変・構造共有・2 回適用でバイト同一)
//   (4) ADR-012(3) の分岐木ノード上界が積の形で、セーブ層と同一の定数であること
//   (5) 判定ロジックが UI 側へ漏れていないこと(検分条件の自動化)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { advance, createAdvanceContext } from "../../src/engine/advance";

import {
  CONCURRENT_DISPATCH_MAX,
  DISPATCH_BRANCH_FACTOR,
  DISPATCH_EVENT_NODES_MAX,
  DISPATCH_TREE_NODES_MAX,
  DISPATCH_TREE_NODES_TOTAL_MAX,
  IMPLEMENTED_COMMAND_KINDS,
  RESERVED_COMMAND_OWNER_TASK,
  apply,
  dispatchSlotsAvailable,
  facilityMaxLevel,
  facilityWorkerSlots,
  isImplementedCommandKind,
  type Command,
  type CommandKind,
  type CommandRejectionCode,
} from "../../src/engine/commands";
import { FIX_ONE, FIX_ZERO, fixFromInt, fixFromRaw, toRaw } from "../../src/engine/fp";
import { currentCodification, isCodified } from "../../src/engine/rules/codify";
import type {
  EngineContent,
  FacilityDef,
  RecordMediaParams,
  StorageParams,
} from "../../src/engine/rules/types";
import * as persistence from "../../src/platform/persistence";
import { toSerializable } from "../../src/engine/state/serialize";
import {
  entitiesOfKind,
  requireEntity,
  type EntityState,
  type GameState,
} from "../../src/engine/state/state";
import { putEntity, setField, updateEntity } from "../../src/engine/state/update";
import {
  HEARTH,
  STUDY_DESK,
  TECH_BRONZE,
  WOOD,
  content as baseContent,
  facility,
  id,
  research,
  resident,
  resource,
  stateOf,
} from "./fixtures";

// --- フィクスチャ -----------------------------------------------------------

const CLAY = id("clay");
const PAPER = id("paper");
const WASTE = id("waste");

/** Lv 別 1/1/2/2/3 人の就労スロット(GDD 7.7「Lvで増加」)。 */
const HEARTH_WITH_SLOTS: FacilityDef = {
  id: HEARTH.id,
  tags: HEARTH.tags,
  harshWork: HEARTH.harshWork,
  outputPerTickByLevel: HEARTH.outputPerTickByLevel,
  output: HEARTH.output,
  workerSlotsByLevel: [1, 1, 2, 2, 3],
};

const RECORD_MEDIA: RecordMediaParams = {
  baseCostFix: fixFromInt(20),
  baseDurationTicks: 720,
  printingTechId: null,
  printingCostMulFix: fixFromRaw(500_000),
  printingTimeMulFix: fixFromRaw(500_000),
  byMedium: {
    paper: {
      costMulFix: fixFromRaw(600_000),
      timeMulFix: fixFromRaw(500_000),
      caravanWeightFix: fixFromRaw(250_000),
      flammable: true,
      costResourceId: PAPER,
    },
    stoneTablet: {
      costMulFix: FIX_ONE,
      timeMulFix: FIX_ONE,
      caravanWeightFix: FIX_ONE,
      flammable: false,
      costResourceId: CLAY,
    },
  },
};

const STORAGE: StorageParams = {
  wasteResourceId: WASTE,
  baseCapacityByResourceId: new Map(),
  wasteConversionRatioByResourceId: new Map(),
  wasteToResearchRatioFix: fixFromRaw(100_000), // 廃材 10 → RP 1(GDD 6.7)
  buildCostWasteSubstitutionMaxFix: fixFromRaw(200_000),
  codifyWasteSubstitutionMaxFix: FIX_ZERO, // 代替を切って本コストだけを見る
};

function contentWith(overrides: Partial<EngineContent> = {}): EngineContent {
  return { ...baseContent(), ...overrides };
}

const CONTENT = contentWith();

/** 就労スロット付きの content(住民割当の上限検査用)。 */
const CONTENT_SLOTS = contentWith({
  facilityDefs: new Map([
    [HEARTH_WITH_SLOTS.id, HEARTH_WITH_SLOTS],
    [STUDY_DESK.id, STUDY_DESK],
  ]),
});

/** 成文化 + 廃材 3 出口が使える content。 */
const CONTENT_CODIFY = contentWith({ recordMedia: RECORD_MEDIA, storage: STORAGE });

const CELL_A = 14;
const CELL_B = 15;
const CELL_FREE = 21;

function board(extra: readonly EntityState[] = []): GameState {
  return stateOf([
    resident("aRui", { assignedFacilityId: id("fHearth") }),
    resident("bSora"),
    facility("fHearth", HEARTH.id, CELL_A, [id("aRui")]),
    facility("fEast", HEARTH.id, CELL_B),
    research("rBronze", TECH_BRONZE.id, 0),
    resource("wStock", WOOD, 100),
    ...extra,
  ]);
}

/** 成功を期待して次の state を取り出す(reject なら理由を出して落とす)。 */
function accept(state: GameState, content: EngineContent, command: Command | Command[]): GameState {
  const result = apply(state, content, command);
  if (!result.ok) {
    throw new Error(`予期しない reject: ${result.rejection.code} / ${result.rejection.message}`);
  }
  return result.state;
}

/** reject を期待して code を取り出す。 */
function rejectCodeOf(
  state: GameState,
  content: EngineContent,
  command: Command | Command[],
): CommandRejectionCode {
  const result = apply(state, content, command);
  if (result.ok) throw new Error("reject されるはずのコマンドが通った");
  return result.rejection.code;
}

const PLACE_FREE: Command = {
  kind: "placeFacility",
  facilityId: id("fNew"),
  defId: HEARTH.id,
  cellIndex: CELL_FREE,
};

// --- 1. 語彙(§4) ---------------------------------------------------------

describe("コマンド語彙のレジストリ", () => {
  it("実装済みと予約が全語彙を過不足なく覆う(重複なし)", () => {
    // [M21] dispatchExpedition は実装済みへ移った。
    // [M52] reclaimCell も実装済みへ移った(予約は beginResearch の 1 種のみ)。
    const reserved = ["beginResearch"] as const;
    const all: CommandKind[] = [...IMPLEMENTED_COMMAND_KINDS, ...reserved];
    expect([...all].sort()).toEqual([...all].sort()); // 型の網羅は下の switch で担保
    for (const kind of reserved) {
      expect(isImplementedCommandKind(kind)).toBe(false);
      expect(RESERVED_COMMAND_OWNER_TASK[kind]).toBeTypeOf("string");
    }
    for (const kind of IMPLEMENTED_COMMAND_KINDS) {
      expect(isImplementedCommandKind(kind)).toBe(true);
      expect(RESERVED_COMMAND_OWNER_TASK[kind]).toBeUndefined();
    }
    expect(IMPLEMENTED_COMMAND_KINDS).toHaveLength(9);
  });

  it("実装済みの一覧は UTF-16 昇順(正準順)", () => {
    expect([...IMPLEMENTED_COMMAND_KINDS].sort()).toEqual([...IMPLEMENTED_COMMAND_KINDS]);
  });

  it("予約語彙は黙って何もせず、担当タスク付きで reject する", () => {
    const state = board();
    const cases: readonly Command[] = [
      { kind: "beginResearch", researchId: id("rNew"), techId: TECH_BRONZE.id },
    ];
    for (const command of cases) {
      const result = apply(state, CONTENT, command);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code).toBe("notImplemented");
      expect(result.rejection.ownerTask).not.toBeNull();
      expect(result.rejection.commandKind).toBe(command.kind);
    }
  });
});

// --- 2. 配置 / 解体 / 増築(GDD 6.1 / 6.6) --------------------------------

describe("placeFacility(配置)", () => {
  it("空きセルへ Lv1 の施設が建つ", () => {
    const next = accept(board(), CONTENT, PLACE_FREE);
    const placed = requireEntity(next, id("fNew"), "facility");
    expect(placed.cellIndex).toBe(CELL_FREE);
    expect(placed.level).toBe(1);
    expect(placed.workerIds).toEqual([]);
    expect(placed.defId).toBe(HEARTH.id);
  });

  it("占有セルは cellOccupied で拒否する(GDD 6.1: 1 セル = 1 施設)", () => {
    const result = apply(board(), CONTENT, {
      kind: "placeFacility",
      facilityId: id("fNew"),
      defId: HEARTH.id,
      cellIndex: CELL_A,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("cellOccupied");
    expect(result.rejection.cellIndex).toBe(CELL_A);
    expect(result.rejection.subjectId).toBe(id("fHearth"));
  });

  it("格子の外・小数・NaN は cellOutOfRange", () => {
    for (const cellIndex of [-1, 48, 1.5, Number.NaN]) {
      expect(
        rejectCodeOf(board(), CONTENT, {
          kind: "placeFacility",
          facilityId: id("fNew"),
          defId: HEARTH.id,
          cellIndex,
        }),
      ).toBe("cellOutOfRange");
    }
  });

  it("content に無い定義 / 使用済み ID は個別の code で拒否する", () => {
    expect(
      rejectCodeOf(board(), CONTENT, {
        kind: "placeFacility",
        facilityId: id("fNew"),
        defId: id("noSuchDef"),
        cellIndex: CELL_FREE,
      }),
    ).toBe("unknownContentDef");
    expect(
      rejectCodeOf(board(), CONTENT, {
        kind: "placeFacility",
        facilityId: id("fHearth"),
        defId: HEARTH.id,
        cellIndex: CELL_FREE,
      }),
    ).toBe("entityIdInUse");
  });
});

describe("demolishFacility(解体)", () => {
  it("就労者の配属参照も engine 側で外れる(ぶら下がり参照を作らない)", () => {
    const next = accept(board(), CONTENT, {
      kind: "demolishFacility",
      facilityId: id("fHearth"),
    });
    expect(next.entityStateById.has(id("fHearth"))).toBe(false);
    expect(requireEntity(next, id("aRui"), "resident").assignedFacilityId).toBeNull();
  });

  it("居ない施設は entityNotFound(黙って成功にしない)", () => {
    expect(
      rejectCodeOf(board(), CONTENT, { kind: "demolishFacility", facilityId: id("fGhost") }),
    ).toBe("entityNotFound");
  });

  it("住民 entity を施設として解体しようとしても種別で弾く", () => {
    expect(
      rejectCodeOf(board(), CONTENT, { kind: "demolishFacility", facilityId: id("aRui") }),
    ).toBe("entityNotFound");
  });
});

describe("upgradeFacility(増築)", () => {
  it("Lv が 1 段上がる", () => {
    const next = accept(board(), CONTENT, {
      kind: "upgradeFacility",
      facilityId: id("fHearth"),
    });
    expect(requireEntity(next, id("fHearth"), "facility").level).toBe(2);
  });

  it("Lv 上限で levelAtMax(上限と実測が機械可読で載る)", () => {
    const maxLevel = facilityMaxLevel(HEARTH);
    const state = accept(
      board(),
      CONTENT,
      Array.from({ length: maxLevel - 1 }, () => ({
        kind: "upgradeFacility" as const,
        facilityId: id("fHearth"),
      })),
    );
    expect(requireEntity(state, id("fHearth"), "facility").level).toBe(maxLevel);

    const result = apply(state, CONTENT, { kind: "upgradeFacility", facilityId: id("fHearth") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("levelAtMax");
    expect(result.rejection.limit).toBe(maxLevel);
    expect(result.rejection.actual).toBe(maxLevel);
  });

  it("Lv1 の値を持たない定義は建てさせない(壊れた content を state へ入れない)", () => {
    const emptyDef: FacilityDef = {
      id: id("emptyDef"),
      tags: HEARTH.tags,
      harshWork: false,
      outputPerTickByLevel: [],
      output: HEARTH.output,
    };
    const content = contentWith({ facilityDefs: new Map([[emptyDef.id, emptyDef]]) });
    expect(facilityMaxLevel(emptyDef)).toBe(0);
    expect(
      rejectCodeOf(board(), content, {
        kind: "placeFacility",
        facilityId: id("fNew"),
        defId: emptyDef.id,
        cellIndex: CELL_FREE,
      }),
    ).toBe("unknownContentDef");
  });

  it("Lv 上限は Lv 別配列の最短で決まる(定義に無い Lv を作らない)", () => {
    const shortStorage: FacilityDef = {
      id: HEARTH.id,
      tags: HEARTH.tags,
      harshWork: HEARTH.harshWork,
      outputPerTickByLevel: HEARTH.outputPerTickByLevel, // 5 段
      output: HEARTH.output,
      storage: { capacityByLevel: [FIX_ONE, FIX_ONE], resourceIds: null }, // 2 段
    };
    expect(facilityMaxLevel(HEARTH)).toBe(5);
    expect(facilityMaxLevel(shortStorage)).toBe(2);
  });
});

// --- 3. 住民割当(GDD 7.7) ------------------------------------------------

describe("assignResident / unassignResident(住民割当)", () => {
  it("workerIds は ID 昇順を保って挿入され、旧配属からは外れる", () => {
    const next = accept(board(), CONTENT, {
      kind: "assignResident",
      residentId: id("bSora"),
      facilityId: id("fHearth"),
    });
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([
      id("aRui"),
      id("bSora"),
    ]);

    const moved = accept(next, CONTENT, {
      kind: "assignResident",
      residentId: id("bSora"),
      facilityId: id("fEast"),
    });
    expect(requireEntity(moved, id("fHearth"), "facility").workerIds).toEqual([id("aRui")]);
    expect(requireEntity(moved, id("fEast"), "facility").workerIds).toEqual([id("bSora")]);
    expect(requireEntity(moved, id("bSora"), "resident").assignedFacilityId).toBe(id("fEast"));
  });

  it("同じ施設への二重割当は alreadyAssigned", () => {
    expect(
      rejectCodeOf(board(), CONTENT, {
        kind: "assignResident",
        residentId: id("aRui"),
        facilityId: id("fHearth"),
      }),
    ).toBe("alreadyAssigned");
  });

  it("就労スロットが埋まっていたら facilitySlotsFull(GDD 7.7)", () => {
    expect(facilityWorkerSlots(HEARTH_WITH_SLOTS, 1)).toBe(1);
    expect(facilityWorkerSlots(HEARTH, 1)).toBeUndefined(); // slots 無し = 上限なし
    // 配列より大きい Lv は最後の段へ丸める(欠落を「上限なし」へ緩めない)。
    expect(facilityWorkerSlots(HEARTH_WITH_SLOTS, 99)).toBe(3);

    const result = apply(board(), CONTENT_SLOTS, {
      kind: "assignResident",
      residentId: id("bSora"),
      facilityId: id("fHearth"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("facilitySlotsFull");
    expect(result.rejection.limit).toBe(1);
    expect(result.rejection.actual).toBe(1);

    // Lv3 まで増築するとスロットが 2 になり通る(Lvで増加)。
    const upgraded = accept(board(), CONTENT_SLOTS, [
      { kind: "upgradeFacility", facilityId: id("fHearth") },
      { kind: "upgradeFacility", facilityId: id("fHearth") },
    ]);
    const assigned = accept(upgraded, CONTENT_SLOTS, {
      kind: "assignResident",
      residentId: id("bSora"),
      facilityId: id("fHearth"),
    });
    expect(requireEntity(assigned, id("fHearth"), "facility").workerIds).toHaveLength(2);
  });

  it("派遣中 / 死亡した住民は residentUnavailable", () => {
    const dispatched = updateEntity(board(), id("bSora"), "resident", (r) =>
      setField(r, "dispatched", true),
    );
    expect(
      rejectCodeOf(dispatched, CONTENT, {
        kind: "assignResident",
        residentId: id("bSora"),
        facilityId: id("fEast"),
      }),
    ).toBe("residentUnavailable");

    const dead = updateEntity(board(), id("bSora"), "resident", (r) =>
      setField(r, "life", { bornTick: -100, lifespanTick: 50, diedTick: 10 }),
    );
    expect(
      rejectCodeOf(dead, CONTENT, {
        kind: "assignResident",
        residentId: id("bSora"),
        facilityId: id("fEast"),
      }),
    ).toBe("residentUnavailable");
  });

  it("割当解除は両側を掃除し、未就労の解除は notAssigned", () => {
    const next = accept(board(), CONTENT, {
      kind: "unassignResident",
      residentId: id("aRui"),
    });
    expect(requireEntity(next, id("aRui"), "resident").assignedFacilityId).toBeNull();
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([]);

    expect(rejectCodeOf(next, CONTENT, { kind: "unassignResident", residentId: id("aRui") })).toBe(
      "notAssigned",
    );
  });

  it("片側だけ壊れた state(workerIds に残っているのに未配属)も解除できる", () => {
    const broken = updateEntity(board(), id("aRui"), "resident", (r) =>
      setField(r, "assignedFacilityId", null),
    );
    const next = accept(broken, CONTENT, { kind: "unassignResident", residentId: id("aRui") });
    expect(requireEntity(next, id("fHearth"), "facility").workerIds).toEqual([]);
  });
});

// --- 4. 成文化指示(GDD 11.1 追補) ----------------------------------------

describe("beginCodification(成文化指示)", () => {
  const codifyBoard = (clayStock: number): GameState =>
    board([resource("clayStock", CLAY, clayStock), resource("wasteStock", WASTE, 100)]);

  it("記録 1 枚が作業中で作られ、コストが引かれる", () => {
    const next = accept(codifyBoard(100), CONTENT_CODIFY, {
      kind: "beginCodification",
      codifyId: id("cdBronzeTablet"),
      techId: TECH_BRONZE.id,
      medium: "stoneTablet",
    });
    const job = currentCodification(next);
    expect(job?.id).toBe(id("cdBronzeTablet"));
    expect(job?.completedTick).toBeNull();
    expect(isCodified(next, TECH_BRONZE.id)).toBe(false);
    // 基準コスト 20 × 時代係数 1.0(エラ不明)× 石板 1.0 = 20
    expect(toRaw(requireEntity(next, id("clayStock"), "resource").stock)).toBe(80_000_000);
  });

  it("在庫不足は insufficientResource(必要量と在庫が機械可読で載る)", () => {
    const result = apply(codifyBoard(5), CONTENT_CODIFY, {
      kind: "beginCodification",
      codifyId: id("cdBronzeTablet"),
      techId: TECH_BRONZE.id,
      medium: "stoneTablet",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("insufficientResource");
    expect(result.rejection.resourceId).toBe(CLAY);
    expect(result.rejection.requiredRaw).toBe(20_000_000);
    expect(result.rejection.availableRaw).toBe(5_000_000);
  });

  it("同一 (tech, 媒体) は duplicateRecord・別媒体は並存できる", () => {
    const first = accept(codifyBoard(100), CONTENT_CODIFY, {
      kind: "beginCodification",
      codifyId: id("cdBronzeTablet"),
      techId: TECH_BRONZE.id,
      medium: "stoneTablet",
    });
    expect(
      rejectCodeOf(first, CONTENT_CODIFY, {
        kind: "beginCodification",
        codifyId: id("cdBronzeTablet2"),
        techId: TECH_BRONZE.id,
        medium: "stoneTablet",
      }),
    ).toBe("duplicateRecord");

    // 紙は別媒体なので並存可(コスト資源が state に無い形で払えるかを確かめる)。
    const withPaper = putEntity(first, resource("paperStock", PAPER, 100));
    const second = accept(withPaper, CONTENT_CODIFY, {
      kind: "beginCodification",
      codifyId: id("cdBronzePaper"),
      techId: TECH_BRONZE.id,
      medium: "paper",
    });
    expect(entitiesOfKind(second, "codify")).toHaveLength(2);
  });

  it("recordMedia が無い content は contentUnsupported、未知 tech は unknownContentDef", () => {
    expect(
      rejectCodeOf(codifyBoard(100), CONTENT, {
        kind: "beginCodification",
        codifyId: id("cdX"),
        techId: TECH_BRONZE.id,
        medium: "paper",
      }),
    ).toBe("contentUnsupported");
    expect(
      rejectCodeOf(codifyBoard(100), CONTENT_CODIFY, {
        kind: "beginCodification",
        codifyId: id("cdX"),
        techId: id("techNope"),
        medium: "paper",
      }),
    ).toBe("unknownContentDef");
  });
});

// --- 5. 廃材 3 出口(3)(GDD 6.7) -----------------------------------------

describe("convertWasteToResearch(廃材 → 研究点)", () => {
  const wasteBoard = (stock: number): GameState => board([resource("wasteStock", WASTE, stock)]);

  it("廃材 10 → RP 1 で研究が進み、廃材が減る", () => {
    const next = accept(wasteBoard(50), CONTENT_CODIFY, {
      kind: "convertWasteToResearch",
      wasteAmountFix: fixFromInt(30),
    });
    expect(toRaw(requireEntity(next, id("wasteStock"), "resource").stock)).toBe(20_000_000);
    expect(toRaw(requireEntity(next, id("rBronze"), "research").progress)).toBe(3_000_000);
  });

  it("在庫不足・0 以下・研究の受け皿なし・storage 未定義をそれぞれ別の code で弾く", () => {
    expect(
      rejectCodeOf(wasteBoard(5), CONTENT_CODIFY, {
        kind: "convertWasteToResearch",
        wasteAmountFix: fixFromInt(30),
      }),
    ).toBe("insufficientResource");
    expect(
      rejectCodeOf(wasteBoard(50), CONTENT_CODIFY, {
        kind: "convertWasteToResearch",
        wasteAmountFix: FIX_ZERO,
      }),
    ).toBe("invalidArgument");
    expect(
      rejectCodeOf(wasteBoard(50), CONTENT, {
        kind: "convertWasteToResearch",
        wasteAmountFix: fixFromInt(30),
      }),
    ).toBe("contentUnsupported");

    const done = updateEntity(wasteBoard(50), id("rBronze"), "research", (r) =>
      setField(r, "completedTick", 1),
    );
    expect(
      rejectCodeOf(done, CONTENT_CODIFY, {
        kind: "convertWasteToResearch",
        wasteAmountFix: fixFromInt(30),
      }),
    ).toBe("noResearchTarget");
  });

  it("研究点が 0 になる端数は黙って廃材を消さずに拒否する", () => {
    expect(
      rejectCodeOf(wasteBoard(50), CONTENT_CODIFY, {
        kind: "convertWasteToResearch",
        wasteAmountFix: fixFromRaw(5), // × 0.1 → floor で 0
      }),
    ).toBe("invalidArgument");
  });
});

// --- 6. 列(原子適用)と純粋性 ---------------------------------------------

describe("列コマンドの原子適用", () => {
  it("全部通れば 1 回の結果にまとまる", () => {
    const result = apply(board(), CONTENT, [
      PLACE_FREE,
      { kind: "assignResident", residentId: id("bSora"), facilityId: id("fNew") },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commandCount).toBe(2);
    expect(requireEntity(result.state, id("fNew"), "facility").workerIds).toEqual([id("bSora")]);
  });

  it("途中で 1 つでも reject したら全部捨てる(部分適用しない)", () => {
    const state = board();
    const result = apply(state, CONTENT, [
      PLACE_FREE,
      { kind: "demolishFacility", facilityId: id("fGhost") },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.commandIndex).toBe(1);
    expect(result.rejection.code).toBe("entityNotFound");
    // 1 個目が通っていても state には残らない。
    expect(state.entityStateById.has(id("fNew"))).toBe(false);
  });

  it("空の列は invalidArgument(何もしない操作を成功にしない)", () => {
    const result = apply(board(), CONTENT, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalidArgument");
    expect(result.rejection.commandKind).toBeNull();
  });
});

describe("純関数であること(ADR-028 / ADR-006)", () => {
  it("入力 state は変更されず、無関係な entity は参照を共有する", () => {
    const state = board();
    const before = JSON.stringify(toSerializable(state));
    const next = accept(state, CONTENT, PLACE_FREE);

    expect(JSON.stringify(toSerializable(state))).toBe(before);
    expect(next).not.toBe(state);
    // 触っていない entity は同一参照(構造共有)。
    expect(next.entityStateById.get(id("aRui"))).toBe(state.entityStateById.get(id("aRui")));
    expect(next.entityStateById.get(id("fEast"))).toBe(state.entityStateById.get(id("fEast")));
  });

  it("同じ入力からは常に同じ state が出る(直列化バイト同一)", () => {
    const commands: Command[] = [
      PLACE_FREE,
      { kind: "assignResident", residentId: id("bSora"), facilityId: id("fNew") },
      { kind: "upgradeFacility", facilityId: id("fNew") },
      { kind: "unassignResident", residentId: id("aRui") },
    ];
    const first = accept(board(), CONTENT, commands);
    const second = accept(board(), CONTENT, commands);
    expect(JSON.stringify(toSerializable(first))).toBe(JSON.stringify(toSerializable(second)));
  });

  it("tick はコマンドで動かない(コマンドは現在 tick の状態遷移)", () => {
    const state = stateOf([facility("fHearth", HEARTH.id, CELL_A)], { tick: 500 });
    const next = accept(state, CONTENT, {
      kind: "upgradeFacility",
      facilityId: id("fHearth"),
    });
    expect(next.tick).toBe(500);
  });

  it("reject のときは state をそのまま返さず、そもそも新しい state を作らない", () => {
    const state = board();
    const result = apply(state, CONTENT, {
      kind: "placeFacility",
      facilityId: id("fNew"),
      defId: HEARTH.id,
      cellIndex: CELL_A,
    });
    expect(result.ok).toBe(false);
    expect("state" in result).toBe(false);
  });
});

// --- 6b. scheduler の中心不変条件との噛み合わせ(commands.ts §2) -----------

describe("コマンドは advance の区間と区間のあいだで効く", () => {
  /** (C)想起困難が発火しない盤面(mastery 0.20 で p が 0 にクランプされる)。 */
  function steadyBoard(): GameState {
    return stateOf([
      resident("aRui", {
        assignedFacilityId: id("fHearth"),
        mastery: fixFromRaw(200_000),
      }),
      facility("fHearth", HEARTH.id, CELL_A, [id("aRui")]),
      resource("wStock", WOOD, 0),
    ]);
  }

  const stockOf = (state: GameState): number =>
    toRaw(requireEntity(state, id("wStock"), "resource").stock);

  it("就労解除の後の区間は新しいレートで積分される(境界イベントを積まずに済む)", () => {
    const state = steadyBoard();
    const ctx = createAdvanceContext(state, CONTENT);

    const at100 = advance(state, ctx, 100);
    const produced100 = stockOf(at100);
    expect(produced100).toBeGreaterThan(0);

    // コマンドを挟まずに 200 まで進めると倍になる(レート一定の確認)。
    expect(stockOf(advance(at100, ctx, 200))).toBe(produced100 * 2);

    // 就労を解除すると、次の advance の最初の区間から産出が止まる。
    const idle = accept(at100, CONTENT, { kind: "unassignResident", residentId: id("aRui") });
    expect(stockOf(advance(idle, ctx, 200))).toBe(produced100);
  });

  it("コマンド適用後の advance も分割不変(区間の切り方に依存しない)", () => {
    const state = accept(steadyBoard(), CONTENT, [
      PLACE_FREE,
      { kind: "assignResident", residentId: id("aRui"), facilityId: id("fNew") },
    ]);
    const ctx = createAdvanceContext(state, CONTENT);

    const whole = advance(state, ctx, 300);
    const split = advance(advance(advance(state, ctx, 37), ctx, 150), ctx, 300);
    expect(JSON.stringify(toSerializable(whole))).toBe(JSON.stringify(toSerializable(split)));
  });
});

// --- 7. 分岐木ノード上界(ADR-012(3)) -------------------------------------

describe("分岐木ノード上界(ADR-012(3))", () => {
  it("上界は積の形で、素の定数から導かれる", () => {
    expect(DISPATCH_TREE_NODES_MAX).toBe(DISPATCH_BRANCH_FACTOR * DISPATCH_EVENT_NODES_MAX);
    expect(DISPATCH_TREE_NODES_TOTAL_MAX).toBe(DISPATCH_TREE_NODES_MAX * CONCURRENT_DISPATCH_MAX);
    // ADR-012(3) の数値(2×8=16 / 16×2=32)。
    expect(DISPATCH_TREE_NODES_MAX).toBe(16);
    expect(DISPATCH_TREE_NODES_TOTAL_MAX).toBe(32);
  });

  it("セーブ層は engine の定数をそのまま使う(2 箇所に数値を持たない)", () => {
    expect(persistence.DISPATCH_EVENT_NODES_MAX).toBe(DISPATCH_EVENT_NODES_MAX);
    expect(persistence.DISPATCH_BRANCH_FACTOR).toBe(DISPATCH_BRANCH_FACTOR);
    expect(persistence.CONCURRENT_DISPATCH_MAX).toBe(CONCURRENT_DISPATCH_MAX);
    expect(persistence.DISPATCH_TREE_NODES_MAX).toBe(DISPATCH_TREE_NODES_MAX);
    expect(persistence.DISPATCH_TREE_NODES_TOTAL_MAX).toBe(DISPATCH_TREE_NODES_TOTAL_MAX);
  });

  it("派遣枠は空いている(派遣 state が入る M21 まで常に 0 件)", () => {
    expect(dispatchSlotsAvailable(board())).toBe(true);
  });
});

// --- 8. 検分: 判定ロジックが UI 側へ漏れていないこと ------------------------

describe("検分: 判定は engine にあり UI に無い", () => {
  // 新しい src/ui/*.ts を足したらここへ 1 行足すこと(readdir を使わないのは
  // @types/node 非依存の方針・tools/nodeShims.d.ts)。
  const UI_FILES = [
    "src/ui/store.ts",
    "src/ui/sources.ts",
    "src/ui/derived.ts",
    "src/ui/reactive.ts",
    "src/ui/screens.ts",
  ];

  /** 巨大な差分を吐かせないため、含有判定は真偽値へ落としてから比較する。 */
  function contains(path: string, needle: string): boolean {
    return readFileSync(path, "utf8").includes(needle);
  }

  it("UI は state を作り替える経路(state/update)を import しない", () => {
    for (const path of UI_FILES) {
      expect([path, contains(path, "engine/state/update")]).toEqual([path, false]);
    }
  });

  it("暫定口 stateApplied は消えている(M49 検収条件)", () => {
    // 撤去の経緯を書いた散文は残ってよいので、イベント型リテラルの形で探す。
    // `tests/ui/store.test.ts` は「語彙外として弾かれること」を確かめるために
    // 意図的にこのリテラルを持っているので、この一覧には入れない。
    for (const path of [...UI_FILES, "tests/ui/derived.test.ts", "tests/ui/screens.test.ts"]) {
      expect([path, contains(path, '"stateApplied"')]).toEqual([path, false]);
    }
  });

  it("engine コマンドを呼ぶ ui ファイルは store.ts だけ(単一入口)", () => {
    for (const path of UI_FILES) {
      const expected = path === "src/ui/store.ts";
      expect([path, contains(path, 'from "../engine/commands"')]).toEqual([path, expected]);
    }
  });
});
