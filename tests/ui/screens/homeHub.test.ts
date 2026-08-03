// ---------------------------------------------------------------------------
// ①ホームハブ(M29)のテスト — GDD 6.6 / 4.1(a) / 2.2 / ADR-027(4)
//
// 2 層に分けて検証する:
//   A. **判定**(`src/ui/derived.ts` の `homeAlerts`): 赤が GDD 2.2 の
//      「限定点灯」になっているか。(A) 分類では絶対に赤くならないこと、
//      唯一保持 × 危険(派遣中 / 士気危機)の**重なり**でしか点かないことを、
//      条件を 1 つずつ外して確認する(= 反証つき)。
//   B. **表示**(`HomeHub.tsx`): バッジが色だけに頼らず記号 + ラベル + 件数を
//      持ち、押すと遷移先が呼ばれること。`UrgencyBadge` は hooks を使わない
//      純関数コンポーネントなので、Preact の render() を通さず直接呼べる
//      (gridBoard.test.ts と同じ方針・vitest は `environment: "node"`)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { fixFromInt, fixFromRaw } from "../../../src/engine/fp";
import { techMemoryKeyOf } from "../../../src/engine/rules/techMemory";
import type { EngineContent, TechDef } from "../../../src/engine/rules/types";
import type {
  CodifyState,
  EntityState,
  GameState,
  ResearchState,
} from "../../../src/engine/state/state";
import { createGameState } from "../../../src/engine/state/update";
import { HOME_ALERT_IDS, type HomeAlert } from "../../../src/ui/derived";
import {
  HOME_ALERT_TEXT,
  URGENCY_PRESENTATION,
  UrgencyBadge,
} from "../../../src/ui/screens/home/HomeHub";
import { createGameStore, type GameStore } from "../../../src/ui/store";
import { content } from "../../engine/fixtures";
import { HEARTH, TECH_BRONZE, WOOD, facility, id, resident, resource } from "../fixtures";

// --- 盤面組み立て ------------------------------------------------------------

const HOLDER_ID = id("rHolder");
const BACKUP_ID = id("rBackup");
const RARE_TECH: TechDef = { ...TECH_BRONZE, lossClass: "rareIrreversible" };
const RECOVERABLE_TECH: TechDef = { ...TECH_BRONZE, lossClass: "criticalRecoverable" };

function contentWith(tech: TechDef, overrides: Partial<EngineContent> = {}): EngineContent {
  return content({ techDefs: new Map([[tech.id, tech]]), ...overrides });
}

function completedResearch(): ResearchState {
  return {
    kind: "research",
    id: id("resBronze"),
    techId: TECH_BRONZE.id,
    progress: fixFromInt(100),
    completedTick: 10,
  };
}

function completedRecord(): CodifyState {
  return {
    kind: "codify",
    id: id("codBronze"),
    techId: TECH_BRONZE.id,
    medium: "stoneTablet",
    requiredWork: fixFromInt(10),
    progress: fixFromInt(10),
    completedTick: 20,
  };
}

interface BoardOptions {
  readonly dispatched?: boolean;
  readonly moraleHuman?: number;
  readonly holders?: readonly string[];
  readonly codified?: boolean;
  readonly extraEntities?: readonly EntityState[];
}

/** 「唯一保持者が危ない」盤面(既定)と、その条件を 1 つずつ外した盤面を作る。 */
function board(options: BoardOptions = {}): GameState {
  const holders = options.holders ?? [HOLDER_ID];
  const entities: EntityState[] = [
    resident("rHolder", {
      dispatched: options.dispatched ?? true,
      morale: fixFromInt(options.moraleHuman ?? 50),
    }),
    resident("rBackup"),
    facility("fHearth", HEARTH.id, 14),
    resource("wStock", WOOD),
    completedResearch(),
    ...(options.codified === true ? [completedRecord()] : []),
    ...(options.extraEntities ?? []),
  ];
  const memory = holders.map(
    (holderId) =>
      [
        techMemoryKeyOf(holderId as typeof HOLDER_ID, TECH_BRONZE.id),
        { masteryFix: fixFromRaw(100_000), impairedUntilTick: 0 },
      ] as const,
  );
  return createGameState(
    {
      saveSchemaVersion: 5,
      contentVersion: 1,
      algoVersion: 3,
      worldSeed: "home-hub-test",
      tick: 100,
    },
    entities,
    [],
    [],
    memory,
  );
}

function storeWith(state: GameState, engineContent: EngineContent): GameStore {
  return createGameStore({ state, content: engineContent });
}

function alertOf(store: GameStore, alertId: HomeAlert["id"]): HomeAlert | undefined {
  return store.derived.homeAlerts.value.alerts.find((alert) => alert.id === alertId);
}

// --- A. 判定(赤の限定点灯・GDD 2.2) ----------------------------------------

describe("homeAlerts: 赤バッジ(B喪失接近)は限定点灯である", () => {
  it("(B) × 未成文 × 唯一保持 × 派遣中 が全部そろうと点く", () => {
    const store = storeWith(board(), contentWith(RARE_TECH));
    const alert = alertOf(store, "bLossImminent");
    expect(alert).toBeDefined();
    expect(alert?.level).toBe("critical");
    expect(alert?.count).toBe(1);
    // GDD 6.6 のワンタップ遷移先は⑥成文化キュー(= 手を打てる画面)。
    expect(alert?.screen).toBe("codify");
  });

  it("(A) 分類なら同じ危険度でも点かない(GDD 7.4「取り返しのつかない喪失は (B) のみ」)", () => {
    const store = storeWith(board(), contentWith(RECOVERABLE_TECH));
    expect(alertOf(store, "bLossImminent")).toBeUndefined();
  });

  it("保持者が 2 人いれば点かない(唯一保持でない)", () => {
    const store = storeWith(board({ holders: [HOLDER_ID, BACKUP_ID] }), contentWith(RARE_TECH));
    expect(alertOf(store, "bLossImminent")).toBeUndefined();
  });

  it("成文化済みなら点かない(記録が 1 枚でもあれば失われない)", () => {
    const store = storeWith(board({ codified: true }), contentWith(RARE_TECH));
    expect(alertOf(store, "bLossImminent")).toBeUndefined();
  });

  it("唯一保持でも安全(在宅 × 士気十分)なら点かない = 常態化しない", () => {
    const store = storeWith(board({ dispatched: false, moraleHuman: 50 }), contentWith(RARE_TECH));
    expect(alertOf(store, "bLossImminent")).toBeUndefined();
  });

  it("士気が content の下位閾値(既定15)を割ると、派遣していなくても点く", () => {
    const safe = storeWith(board({ dispatched: false, moraleHuman: 15 }), contentWith(RARE_TECH));
    expect(alertOf(safe, "bLossImminent")).toBeUndefined();

    const crisis = storeWith(board({ dispatched: false, moraleHuman: 14 }), contentWith(RARE_TECH));
    expect(alertOf(crisis, "bLossImminent")?.count).toBe(1);
  });

  it("未解禁(研究未完了)の技術は失いようがないので点かない", () => {
    const pending: ResearchState = { ...completedResearch(), completedTick: null };
    const state = createGameState(
      {
        saveSchemaVersion: 5,
        contentVersion: 1,
        algoVersion: 3,
        worldSeed: "home-hub-test",
        tick: 100,
      },
      [
        resident("rHolder", { dispatched: true }),
        facility("fHearth", HEARTH.id, 14),
        resource("wStock", WOOD),
        pending,
      ],
      [],
      [],
      [
        [
          techMemoryKeyOf(HOLDER_ID, TECH_BRONZE.id),
          { masteryFix: fixFromRaw(100_000), impairedUntilTick: 0 },
        ],
      ],
    );
    const store = storeWith(state, contentWith(RARE_TECH));
    expect(alertOf(store, "bLossImminent")).toBeUndefined();
  });
});

describe("homeAlerts: 黄/灰と並び順", () => {
  it("未成文の解禁済み技術は黄(先延ばしコスト)として点く", () => {
    const store = storeWith(board({ dispatched: false }), contentWith(RECOVERABLE_TECH));
    const alert = alertOf(store, "codifyPending");
    expect(alert?.level).toBe("warn");
    expect(alert?.count).toBe(1);
    expect(alert?.screen).toBe("codify");
  });

  it("派遣中の住民は灰(任意)として点く", () => {
    const store = storeWith(board(), contentWith(RECOVERABLE_TECH));
    const alert = alertOf(store, "idleResidents");
    expect(alert?.level).toBe("info");
    expect(alert?.screen).toBe("residents");
  });

  it("点灯しているバッジは重い順(HOME_ALERT_IDS の宣言順)に並ぶ", () => {
    const store = storeWith(board(), contentWith(RARE_TECH));
    const order = store.derived.homeAlerts.value.alerts.map((alert) => alert.id);
    const expected = HOME_ALERT_IDS.filter((alertId) => order.includes(alertId));
    expect(order).toEqual([...expected]);
    expect(order[0]).toBe("bLossImminent");
  });

  it("件数 0 のバッジは並ばない(点いていないものを出さない)", () => {
    const store = storeWith(board(), contentWith(RARE_TECH));
    for (const alert of store.derived.homeAlerts.value.alerts) {
      expect(alert.count).toBeGreaterThan(0);
    }
  });

  it("tick を進めても(件数が変わらなければ)再計算結果は同値で伝播しない", () => {
    const store = storeWith(board({ dispatched: false }), contentWith(RECOVERABLE_TECH));
    const before = store.derived.homeAlerts.value;
    store.dispatch({ type: "ticked", toTick: store.peekState().tick + 5 });
    // equals で止まるので参照が変わらない = バッジ行は再描画されない(ADR-027(4))。
    expect(store.derived.homeAlerts.value).toBe(before);
  });
});

// --- [M63/R4-A04] 保管上限到達の黄警告(GDD 6.7) ----------------------------

describe("homeAlerts: storageAtCapacity(保管上限に達している資源の黄警告)", () => {
  const storageContent = (): EngineContent =>
    contentWith(RECOVERABLE_TECH, {
      storage: {
        wasteResourceId: null,
        baseCapacityByResourceId: new Map([[WOOD, fixFromInt(400)]]),
        wasteConversionRatioByResourceId: new Map(),
        wasteToResearchRatioFix: fixFromInt(0),
        buildCostWasteSubstitutionMaxFix: fixFromInt(0),
        codifyWasteSubstitutionMaxFix: fixFromInt(0),
      },
    });

  it("上限を持つ content で在庫が上限以上なら黄で点く(グリッド画面へ遷移)", () => {
    const state = board({ dispatched: false, extraEntities: [resource("wStock2", WOOD, 400)] });
    const store = storeWith(state, storageContent());
    const alert = alertOf(store, "storageAtCapacity");
    expect(alert?.level).toBe("warn");
    expect(alert?.screen).toBe("grid");
    expect(alert?.count).toBeGreaterThan(0);
  });

  it("在庫が上限未満なら点かない", () => {
    // board() 既定の wStock(WOOD)は 0 なので上限(400)未満。
    const store = storeWith(board({ dispatched: false }), storageContent());
    expect(alertOf(store, "storageAtCapacity")).toBeUndefined();
  });

  it("content に storage ブロックが無い(上限という概念自体が無い)盤面では点かない", () => {
    const state = board({ dispatched: false, extraEntities: [resource("wStock2", WOOD, 999_999)] });
    const store = storeWith(state, contentWith(RECOVERABLE_TECH));
    expect(alertOf(store, "storageAtCapacity")).toBeUndefined();
  });
});

// --- B. 表示(色だけに頼らない・ワンタップ遷移) ------------------------------

describe("UrgencyBadge(表示・GDD 6.6 のワンタップ遷移)", () => {
  const alert: HomeAlert = {
    id: "bLossImminent",
    level: "critical",
    screen: "codify",
    count: 2,
  };

  it("記号 + 日本語ラベル + 件数を必ず持つ(色だけで意味を運ばない)", () => {
    const vnode = UrgencyBadge({ alert, onNavigate: () => undefined });
    const text = JSON.stringify(vnode);
    expect(text).toContain(URGENCY_PRESENTATION.critical.mark);
    expect(text).toContain(URGENCY_PRESENTATION.critical.name);
    expect(text).toContain(HOME_ALERT_TEXT.bLossImminent.label);
    expect(text).toContain(HOME_ALERT_TEXT.bLossImminent.hint);
  });

  it("押すと遷移先の画面 ID で onNavigate が呼ばれる", () => {
    const onNavigate = vi.fn();
    const vnode = UrgencyBadge({ alert, onNavigate });
    const button = vnode.props.children as {
      readonly props: { readonly onClick: () => void; readonly "data-target-screen": string };
    };
    expect(button.props["data-target-screen"]).toBe("codify");
    button.props.onClick();
    expect(onNavigate).toHaveBeenCalledWith("codify");
  });

  it("段ごとに class が分かれる(意匠は CSS 側・値は ui-spec §3.3 が正本)", () => {
    for (const level of ["critical", "warn", "info"] as const) {
      const vnode = UrgencyBadge({ alert: { ...alert, level }, onNavigate: () => undefined });
      const button = vnode.props.children as { readonly props: { readonly class: string } };
      expect(button.props.class).toContain(`kf-badge--${level}`);
    }
  });

  it("文言テーブルは全バッジ種別を埋めている(登録漏れの検出)", () => {
    for (const alertId of HOME_ALERT_IDS) {
      const text = HOME_ALERT_TEXT[alertId];
      expect(text.label.length).toBeGreaterThan(0);
      expect(text.hint.length).toBeGreaterThan(0);
      expect(text.unit.length).toBeGreaterThan(0);
    }
  });
});
