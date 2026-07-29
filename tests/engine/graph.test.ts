import { describe, expect, it } from "vitest";

import adjacencyJson from "../../content/adjacency.json";
import balanceJson from "../../content/balance.json";
import facilityJson from "../../content/facility.json";
import techJson from "../../content/tech.json";
import traitJson from "../../content/trait.json";

import { type RawContentBundle, validateContentBundle } from "../../schema/contentBundle";
import {
  GraphError,
  buildRecoverabilityGraph,
  recoverabilityIssues,
  recoverableTechIds,
  rebuildableFacilityIds,
  soleKeeperRecoverabilityIssues,
  type FacilityGraphSource,
  type RecoverabilityIssue,
  type TechGraphSource,
} from "../../src/engine/graph";

// ---------------------------------------------------------------------------
// M9 の検収条件:
//   (1) ソフトロック盤面を人工的に作って**検出される**こと
//   (2) 探索順が決定論(ID 昇順)で固定されていること
// 併せて実 content(tech 24 本 / facility 3 種)が GDD 11.4-2 に合格することを
// CI ゲートとして固定する。
//
// content の件数・ID は M7 が additive に増やす可能性があるため、ここでは
// **件数を固定しない**(「(A) は全て再構成可能」「不整合 0 件」という性質だけを
// 見る = content が増えても意味が変わらない検査)。
// ---------------------------------------------------------------------------

/** 検証済みバンドル(TechContent / FacilityContent が正しい union 型を持つ)。 */
function realBundle(): {
  tech: readonly TechGraphSource[];
  facility: readonly FacilityGraphSource[];
} {
  const raw: RawContentBundle = {
    tech: techJson,
    facility: facilityJson,
    trait: traitJson,
    adjacency: adjacencyJson,
    balance: balanceJson,
  };
  const validated = validateContentBundle(raw);
  if (!validated.ok) throw new Error(`検証で落ちた: ${JSON.stringify(validated.issues)}`);
  // TechContent / FacilityContent は graph.ts の入力型へ構造的に代入可能(graph.ts §3)。
  return { tech: validated.value.tech, facility: validated.value.facility };
}

const REAL = realBundle();

// --- 人工盤面のためのファクトリ -------------------------------------------

const SLOTS_ONE = { lv1: 1, lv2: 1, lv3: 2, lv4: 2, lv5: 3 };
const SLOTS_ZERO = { lv1: 0, lv2: 0, lv3: 0, lv4: 0, lv5: 0 };
/** Lv1 では置けないが Lv3 以降で置ける施設(「全 Lv を通じた最大」の検査用)。 */
const SLOTS_LATE = { lv1: 0, lv2: 0, lv3: 1, lv4: 1, lv5: 2 };

function facility(id: string, slots = SLOTS_ONE): FacilityGraphSource {
  return { id, slots };
}

function tech(
  id: string,
  options: {
    readonly lossClass?: "criticalRecoverable" | "rareIrreversible";
    readonly prereqs?: readonly string[];
    readonly facility?: string;
    readonly unlocks?: readonly string[];
  } = {},
): TechGraphSource {
  return {
    id,
    lossClass: options.lossClass ?? "criticalRecoverable",
    prereqs: options.prereqs ?? [],
    fieldRequirement: {
      facility: options.facility ?? "workbench",
      recipe: `recipeFor_${id}`,
      count: 2,
    },
    unlocks: options.unlocks ?? [],
  };
}

/**
 * ソフトロック盤面(M9 検収条件(1))。健全な骨格 + 5 種の詰み方を 1 枚に載せる。
 *
 *   施設 workbench   : 初期解禁・就労枠あり(健全な土台)
 *   施設 lostForge   : (B) techLostArt だけが解禁する = 全喪失後は建て直せない
 *   施設 sealedVault : 就労枠が全 Lv で 0 = 誰も置けない
 *   施設 selfHall    : techSelfGate 自身だけが解禁する = 堂々巡り
 *
 *   techBase        (A) 前提なし・workbench           → 健全(唯一の起点)
 *   techLostArt     (B) 前提 techBase・lostForge を解禁 → 永久喪失(保証対象外)
 *   techArchive     (A) sealedVault                   → facilityNoWorkerSlot
 *   techGhost       (A) 実在しない施設 ghostHall       → facilityMissing
 *   techIronWork    (A) lostForge                     → facilityGateUnrecoverable
 *   techOrphan      (A) 実在しない前提 techVanished    → prereqMissing
 *   techSelfGate    (A) selfHall(自分だけが解禁)     → facilityGateUnrecoverable
 *   techToolMaking  (A) 前提 techIronWork             → prereqUnrecoverable(連鎖)
 */
const SOFTLOCK_FACILITIES: readonly FacilityGraphSource[] = [
  facility("workbench"),
  facility("lostForge"),
  facility("sealedVault", SLOTS_ZERO),
  facility("selfHall"),
];

const SOFTLOCK_TECHS: readonly TechGraphSource[] = [
  tech("techBase"),
  tech("techLostArt", {
    lossClass: "rareIrreversible",
    prereqs: ["techBase"],
    unlocks: ["lostForge"],
  }),
  tech("techArchive", { prereqs: ["techBase"], facility: "sealedVault" }),
  tech("techGhost", { prereqs: ["techBase"], facility: "ghostHall" }),
  tech("techIronWork", { prereqs: ["techBase"], facility: "lostForge" }),
  tech("techOrphan", { prereqs: ["techVanished"] }),
  tech("techSelfGate", { prereqs: ["techBase"], facility: "selfHall", unlocks: ["selfHall"] }),
  tech("techToolMaking", { prereqs: ["techIronWork"] }),
];

function kindsOf(issues: readonly RecoverabilityIssue[]): readonly [string, string][] {
  return issues.map((issue) => [issue.techId, issue.kind]);
}

describe("graph — 実 content の再取得保証(GDD 11.4-2)= M9 の CI ゲート", () => {
  it("実 content にソフトロックが 1 件も無い", () => {
    expect(soleKeeperRecoverabilityIssues(REAL.tech, REAL.facility)).toEqual([]);
  });

  it("(A) criticalRecoverable は全て全喪失盤面から再構成可能", () => {
    const recoverable = new Set(
      recoverableTechIds(buildRecoverabilityGraph(REAL.tech, REAL.facility)),
    );
    const unrecoverableA = REAL.tech
      .filter((t) => t.lossClass === "criticalRecoverable" && !recoverable.has(t.id))
      .map((t) => t.id);
    expect(unrecoverableA).toEqual([]);
  });

  it("(B) rareIrreversible は再構成可能集合に入らない(GDD 7.4 / 10.2 永久喪失)", () => {
    const graph = buildRecoverabilityGraph(REAL.tech, REAL.facility);
    const recoverable = new Set(recoverableTechIds(graph));
    const lossy = REAL.tech.filter((t) => t.lossClass === "rareIrreversible").map((t) => t.id);
    expect(lossy.length).toBeGreaterThan(0);
    for (const techId of lossy) expect(recoverable.has(techId)).toBe(false);
  });

  it("実地要件の施設は全て「建て直せて就労枠がある」側にいる", () => {
    const graph = buildRecoverabilityGraph(REAL.tech, REAL.facility);
    const rebuildable = new Set(rebuildableFacilityIds(graph));
    for (const t of REAL.tech) {
      if (t.lossClass !== "criticalRecoverable") continue;
      expect(rebuildable.has(t.fieldRequirement.facility)).toBe(true);
    }
  });

  it("現 content の unlocks[] は施設ゲートを 1 本も生やさない(施設は全て初期解禁)", () => {
    const graph = buildRecoverabilityGraph(REAL.tech, REAL.facility);
    for (const facilityId of graph.facilityIds) {
      expect(graph.facilityNodeById.get(facilityId)?.gateTechIds).toEqual([]);
    }
  });
});

describe("graph — ソフトロック盤面の検出(M9 検収条件(1))", () => {
  const ISSUES = soleKeeperRecoverabilityIssues(SOFTLOCK_TECHS, SOFTLOCK_FACILITIES);

  it("5 種の詰み方が ID 昇順で全て検出される", () => {
    expect(kindsOf(ISSUES)).toEqual([
      ["techArchive", "facilityNoWorkerSlot"],
      ["techGhost", "facilityMissing"],
      ["techIronWork", "facilityGateUnrecoverable"],
      ["techOrphan", "prereqMissing"],
      ["techSelfGate", "facilityGateUnrecoverable"],
      ["techToolMaking", "prereqUnrecoverable"],
    ]);
  });

  it("(B) 自身と健全なテックは報告されない(保証範囲は (A) のみ)", () => {
    const reported = ISSUES.map((issue) => issue.techId);
    expect(reported).not.toContain("techLostArt");
    expect(reported).not.toContain("techBase");
  });

  it("(B) だけが解禁する施設が原因のとき、原因テックが機械可読で付く", () => {
    const issue = ISSUES.find((i) => i.techId === "techIronWork");
    expect(issue?.facilityId).toBe("lostForge");
    expect(issue?.blockedByTechIds).toEqual(["techLostArt"]);
    expect(issue?.message).toContain("lostForge");
  });

  it("自分自身しか解禁しない施設は堂々巡りとして説明される", () => {
    const issue = ISSUES.find((i) => i.techId === "techSelfGate");
    expect(issue?.blockedByTechIds).toEqual(["techSelfGate"]);
    expect(issue?.message).toContain("堂々巡り");
  });

  it("連鎖して詰んだテックも別件として並ぶ(一次原因と両方出る)", () => {
    const chained = ISSUES.find((i) => i.techId === "techToolMaking");
    expect(chained?.blockedByTechIds).toEqual(["techIronWork"]);
    expect(chained?.facilityId).toBeNull();
  });

  it("再構成可能集合は健全な起点だけ(詰んだ側は 1 本も入らない)", () => {
    const graph = buildRecoverabilityGraph(SOFTLOCK_TECHS, SOFTLOCK_FACILITIES);
    expect(recoverableTechIds(graph)).toEqual(["techBase"]);
    expect(rebuildableFacilityIds(graph)).toEqual(["workbench"]);
  });

  it("ゲートを (B) から (A) に直すと、その系統だけが解消する(検査が常に落ちる訳ではない反証)", () => {
    const fixed = SOFTLOCK_TECHS.map((t) =>
      t.id === "techLostArt" ? tech(t.id, { prereqs: ["techBase"], unlocks: ["lostForge"] }) : t,
    );
    const issues = soleKeeperRecoverabilityIssues(fixed, SOFTLOCK_FACILITIES);
    expect(kindsOf(issues)).toEqual([
      ["techArchive", "facilityNoWorkerSlot"],
      ["techGhost", "facilityMissing"],
      ["techOrphan", "prereqMissing"],
      ["techSelfGate", "facilityGateUnrecoverable"],
    ]);
  });

  it("健全な盤面なら 0 件(偽陽性が出ない)", () => {
    const healthy: readonly TechGraphSource[] = [
      tech("techBase"),
      tech("techForgeWork", { prereqs: ["techBase"], unlocks: ["forge"] }),
      tech("techIronTool", { prereqs: ["techForgeWork"], facility: "forge" }),
      tech("techRelic", { lossClass: "rareIrreversible", prereqs: ["techIronTool"] }),
    ];
    const healthyFacilities = [facility("workbench"), facility("forge")];
    expect(soleKeeperRecoverabilityIssues(healthy, healthyFacilities)).toEqual([]);
  });
});

describe("graph — role の成立条件(GDD 11.4-2「role が常時 ≥1人」)", () => {
  it("就労枠は全 Lv の最大で見る(Lv1 が 0 でも上位 Lv で置けるなら合格)", () => {
    const techs = [tech("techLate", { facility: "lateHall" })];
    const graph = buildRecoverabilityGraph(techs, [facility("lateHall", SLOTS_LATE)]);
    expect(graph.facilityNodeById.get("lateHall")?.maxWorkerSlots).toBe(2);
    expect(recoverabilityIssues(graph)).toEqual([]);
  });

  it("就労枠が全 Lv で 0 なら role が立たない", () => {
    const techs = [tech("techLate", { facility: "lateHall" })];
    const graph = buildRecoverabilityGraph(techs, [facility("lateHall", SLOTS_ZERO)]);
    expect(recoverabilityIssues(graph).map((i) => i.kind)).toEqual(["facilityNoWorkerSlot"]);
  });

  it("複数のゲートは 1 本でも再構成可能なら通る(網状ツリー)", () => {
    const techs: readonly TechGraphSource[] = [
      tech("techLostRoute", { lossClass: "rareIrreversible", unlocks: ["kiln"] }),
      tech("techLiveRoute", { unlocks: ["kiln"] }),
      tech("techFiring", { facility: "kiln" }),
    ];
    const graph = buildRecoverabilityGraph(techs, [facility("kiln"), facility("workbench")]);
    expect(graph.facilityNodeById.get("kiln")?.gateTechIds).toEqual([
      "techLiveRoute",
      "techLostRoute",
    ]);
    expect(recoverabilityIssues(graph)).toEqual([]);
  });

  it("全てのゲートが (B) なら詰む", () => {
    const techs: readonly TechGraphSource[] = [
      tech("techLostRoute", { lossClass: "rareIrreversible", unlocks: ["kiln"] }),
      tech("techFiring", { facility: "kiln" }),
    ];
    const graph = buildRecoverabilityGraph(techs, [facility("kiln")]);
    expect(recoverabilityIssues(graph).map((i) => i.kind)).toEqual(["facilityGateUnrecoverable"]);
  });

  it("前提の循環は起点が無く再構成不能として出る", () => {
    const techs: readonly TechGraphSource[] = [
      tech("techLoopA", { prereqs: ["techLoopB"] }),
      tech("techLoopB", { prereqs: ["techLoopA"] }),
    ];
    const issues = soleKeeperRecoverabilityIssues(techs, [facility("workbench")]);
    expect(kindsOf(issues)).toEqual([
      ["techLoopA", "prereqUnrecoverable"],
      ["techLoopB", "prereqUnrecoverable"],
    ]);
  });
});

describe("graph — 決定論(M9 検収条件(2): 探索順が ID 昇順で固定)", () => {
  /** 入力の並びを全て逆順にする(配列の並びに依存していれば結果が変わる)。 */
  function reversed(techs: readonly TechGraphSource[]): readonly TechGraphSource[] {
    return [...techs].reverse().map((t) => ({
      id: t.id,
      lossClass: t.lossClass,
      prereqs: [...t.prereqs].reverse(),
      fieldRequirement: t.fieldRequirement,
      unlocks: [...t.unlocks].reverse(),
    }));
  }

  it("入力配列の並びを逆にしても検出結果がバイト同一", () => {
    const forward = soleKeeperRecoverabilityIssues(SOFTLOCK_TECHS, SOFTLOCK_FACILITIES);
    const backward = soleKeeperRecoverabilityIssues(
      reversed(SOFTLOCK_TECHS),
      [...SOFTLOCK_FACILITIES].reverse(),
    );
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("実 content でも並び替えに対して不変", () => {
    const graphA = buildRecoverabilityGraph(REAL.tech, REAL.facility);
    const graphB = buildRecoverabilityGraph(reversed(REAL.tech), [...REAL.facility].reverse());
    expect(recoverableTechIds(graphB)).toEqual(recoverableTechIds(graphA));
    expect(rebuildableFacilityIds(graphB)).toEqual(rebuildableFacilityIds(graphA));
    expect(graphB.techIds).toEqual(graphA.techIds);
  });

  it("グラフの ID 配列・前提・ゲートが全て UTF-16 昇順に正規化される", () => {
    const techs: readonly TechGraphSource[] = [
      tech("techZeta", {
        prereqs: ["techBeta", "techAlpha", "techBeta"],
        unlocks: ["hall", "kiln"],
      }),
      tech("techBeta"),
      tech("techAlpha"),
    ];
    const graph = buildRecoverabilityGraph(techs, [facility("kiln"), facility("hall")]);
    expect(graph.techIds).toEqual(["techAlpha", "techBeta", "techZeta"]);
    expect(graph.facilityIds).toEqual(["hall", "kiln"]);
    // 重複除去 + 昇順。
    expect(graph.techNodeById.get("techZeta")?.prereqs).toEqual(["techAlpha", "techBeta"]);
    expect(graph.facilityNodeById.get("hall")?.gateTechIds).toEqual(["techZeta"]);
  });

  it("報告は (A) テックの ID 昇順で、入力順に依存しない", () => {
    const issues = soleKeeperRecoverabilityIssues(SOFTLOCK_TECHS, SOFTLOCK_FACILITIES);
    const ids = issues.map((issue) => issue.techId);
    expect([...ids].sort((l, r) => (l < r ? -1 : l > r ? 1 : 0))).toEqual(ids);
  });
});

describe("graph — 構築時の不変条件", () => {
  it("tech ID の重複は停止する", () => {
    expect(() => buildRecoverabilityGraph([tech("techA"), tech("techA")], [])).toThrow(GraphError);
  });

  it("facility ID の重複は停止する", () => {
    expect(() => buildRecoverabilityGraph([], [facility("kiln"), facility("kiln")])).toThrow(
      GraphError,
    );
  });

  it("tech と facility の ID 衝突は停止する(ADR-024(1) グローバル一意性)", () => {
    expect(() => buildRecoverabilityGraph([tech("kiln")], [facility("kiln")])).toThrow(GraphError);
  });

  it("unlocks[] の tech ID / 未知 ID は施設ゲートにならない", () => {
    const techs: readonly TechGraphSource[] = [
      tech("techA", { unlocks: ["techB", "somethingUnknown", "kiln"] }),
      tech("techB"),
    ];
    const graph = buildRecoverabilityGraph(techs, [facility("kiln")]);
    expect(graph.facilityNodeById.get("kiln")?.gateTechIds).toEqual(["techA"]);
  });
});
