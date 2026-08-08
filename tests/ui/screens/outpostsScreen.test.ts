// ---------------------------------------------------------------------------
// src/ui/screens/outposts/OutpostsScreen.tsx のテスト(M32・M54で操作結線)。
//
// `OutpostCard`/`OutpostEstablishForm` は hooks を使わない純関数なので、
// Preact の render() を通さず直接呼んで検証する(facilityScreen.test.ts と
// 同じ方針)。`OutpostsScreen` 本体(hooks あり)は登録テスト
// (appShell.test.ts)のみ。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { fixFromInt } from "../../../src/engine/fp";
import { entityIdFromString, type EntityId } from "../../../src/engine/state/state";
import type {
  CostLineView,
  OutpostRosterEntry,
  OutpostTypeCatalogEntry,
  ResidentView,
  ResourceView,
} from "../../../src/ui/derived";
import {
  isOutpostCostInsufficient,
  OutpostCard,
  outpostCostLinesOf,
  outpostCostLinesText,
  OutpostEstablishForm,
  researchStopTargetNames,
  residentOptionLabel,
  stationCandidates,
} from "../../../src/ui/screens/outposts/OutpostsScreen";

const id = entityIdFromString;

function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return flattenText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return flattenText(vnode.props?.children);
}

interface FoundElement {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function collectByType(node: unknown, type: string, out: FoundElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const vnode = node as { readonly type?: unknown; readonly props?: Record<string, unknown> };
  if (vnode.type === type) out.push({ type, props: vnode.props ?? {} });
  collectByType(vnode.props?.children, type, out);
}

function outpost(overrides: Partial<OutpostRosterEntry> = {}): OutpostRosterEntry {
  return {
    outpostId: id("outpost1"),
    outpostTypeId: id("outpostMine"),
    resourceId: id("iron"),
    band: "near",
    level: 1,
    residentIds: [id("aRui")],
    establishedTick: 0,
    supplyApprox: 10,
    upkeepApprox: 4,
    netRevenueApprox: 6,
    hazardApprox: 0.05,
    rareAssetCount: 0,
    expectedRareLossApprox: 0,
    roiApprox: 2.5,
    ...overrides,
  };
}

function residentView(entityId = id("bKaya")): ResidentView {
  return {
    entityId,
    moraleApprox: 60,
    masteryApprox: 0,
    assignedFacilityId: null,
    dispatched: false,
    recallImpaired: false,
    recallImpairedUntilTick: 0,
    traitIds: [],
    stats: {
      vigorApprox: 50,
      dexterityApprox: 50,
      intellectApprox: 50,
      fortitudeApprox: 50,
      willApprox: 50,
    },
    alive: true,
    diedTick: null,
  };
}

/** [M76/R8-03 拠点版] 在庫チェック用の最小 ResourceView フィクスチャ。 */
function resourceView(resourceId: EntityId, stockApprox: number): ResourceView {
  return {
    entityId: resourceId,
    resourceId,
    stockFix: fixFromInt(stockApprox),
    stockApprox,
    capacityApprox: null,
    atCapacity: false,
  };
}

/** [M54・M61/FC8で拡張] 呼ばれなければ失敗させる用の no-op コールバック一式。 */
function cardHandlers() {
  return {
    residentOptions: [residentView()],
    stationSelectValue: "" as const,
    onStationSelectChange: vi.fn(),
    onStation: vi.fn(),
    onUnstation: vi.fn(),
    confirmingAbandon: false,
    onAbandonStart: vi.fn(),
    onAbandonConfirm: vi.fn(),
    onAbandonCancel: vi.fn(),
  };
}

describe("OutpostCard(⑨拠点1基・GDD 9.2・検収条件=(B)損失項が画面に出ているか)", () => {
  it("タイプ名(GDD 9.2の用語)・供給・維持費・ネット収益・危険度・採算を表示する", () => {
    const vnode = OutpostCard({ outpost: outpost(), ...cardHandlers() });
    const text = flattenText(vnode);
    expect(text).toContain("鉱山");
    expect(text).toContain("供給");
    expect(text).toContain("維持費");
    expect(text).toContain("ネット収益");
    // [束B/B-2] 英語のまま出ていた "hazard" をプレイヤー語(危険度)へ改めた。
    expect(text).toContain("危険度");
    expect(text).not.toContain("hazard");
    // [M73/R8-08] 英語の金融用語「ROI」は出さない(和語「投資効率」へ)。
    expect(text).toContain("採算(投資効率)");
    expect(text).not.toContain("ROI");
  });

  it("(B)喪失リスク項を隠さない(GDD 8.6 を援用・本タスクの検収条件)", () => {
    const vnode = OutpostCard({
      outpost: outpost({ rareAssetCount: 2, expectedRareLossApprox: 12.5 }),
      ...cardHandlers(),
    });
    const text = flattenText(vnode);
    expect(text).toContain("(B)喪失リスク");
    expect(text).toContain("12.5");
    expect(text).toContain("2 件");
  });

  it("ネット収益が負なら放棄検討の注記を出す", () => {
    const vnode = OutpostCard({ outpost: outpost({ netRevenueApprox: -3 }), ...cardHandlers() });
    expect(flattenText(vnode)).toContain("放棄を検討");
  });

  it("採算が算出できない(分母0)なら理由を添えて言う", () => {
    const vnode = OutpostCard({ outpost: outpost({ roiApprox: null }), ...cardHandlers() });
    expect(flattenText(vnode)).toContain("算出できません");
  });

  it("[M54] 常駐者ごとに解除ボタンを持ち、押すと onUnstation(residentId) が呼ばれる", () => {
    const handlers = cardHandlers();
    const vnode = OutpostCard({
      outpost: outpost({ residentIds: [id("aRui"), id("bKaya")] }),
      ...handlers,
    });
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const unstationButtons = buttons.filter(
      (b) => typeof b.props.class === "string" && b.props.class.includes("unstation-button"),
    );
    expect(unstationButtons).toHaveLength(2);
    (unstationButtons[0]?.props.onClick as () => void)();
    expect(handlers.onUnstation).toHaveBeenCalledWith(id("aRui"));
  });

  it("[M61/FC8・R1-D05] 放棄は確認1段: 初回タップは onAbandonStart のみ(まだ実行しない)", () => {
    const handlers = cardHandlers();
    const vnode = OutpostCard({ outpost: outpost(), ...handlers });
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    // confirmingAbandon=false のときは abandon-button だけが出て、
    // 確認パネル(実行する/キャンセル)は出ない。
    expect(
      buttons.some(
        (b) =>
          typeof b.props.class === "string" && b.props.class.includes("abandon-confirm-button"),
      ),
    ).toBe(false);
    const abandonButton = buttons.find(
      (b) =>
        typeof b.props.class === "string" &&
        b.props.class.includes("abandon-button") &&
        !b.props.class.includes("confirm"),
    );
    (abandonButton?.props.onClick as () => void)();
    expect(handlers.onAbandonStart).toHaveBeenCalledOnce();
    expect(handlers.onAbandonConfirm).not.toHaveBeenCalled();
  });

  it("[M61/FC8] confirmingAbandon=true: 確認パネルが出て、実行するを押すと onAbandonConfirm が呼ばれる", () => {
    const handlers = { ...cardHandlers(), confirmingAbandon: true };
    const vnode = OutpostCard({ outpost: outpost(), ...handlers });
    const text = flattenText(vnode);
    expect(text).toContain("取り消せません");
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    // 初段の「放棄する」ボタンは出ない(確認中は差し替わる)。
    expect(
      buttons.some(
        (b) =>
          typeof b.props.class === "string" &&
          b.props.class.includes("abandon-button") &&
          !b.props.class.includes("confirm"),
      ),
    ).toBe(false);
    const confirmButton = buttons.find(
      (b) => typeof b.props.class === "string" && b.props.class.includes("abandon-confirm-button"),
    );
    (confirmButton?.props.onClick as () => void)();
    expect(handlers.onAbandonConfirm).toHaveBeenCalledOnce();
  });

  it("[M61/FC8] 確認パネルのキャンセルで onAbandonCancel が呼ばれる", () => {
    const handlers = { ...cardHandlers(), confirmingAbandon: true };
    const vnode = OutpostCard({ outpost: outpost(), ...handlers });
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const cancelButton = buttons.find(
      (b) => typeof b.props.class === "string" && b.props.class.includes("abandon-cancel-button"),
    );
    (cancelButton?.props.onClick as () => void)();
    expect(handlers.onAbandonCancel).toHaveBeenCalledOnce();
  });

  it("[M54] 駐在させるセレクトの変更で onStationSelectChange、ボタンで onStation が呼ばれる", () => {
    const handlers = cardHandlers();
    const vnode = OutpostCard({ outpost: outpost(), ...handlers });
    const selects: FoundElement[] = [];
    collectByType(vnode, "select", selects);
    expect(selects).toHaveLength(1);
    const onChange = selects[0]?.props.onChange as (event: Event) => void;
    onChange({ target: { value: "bKaya" } } as unknown as Event);
    expect(handlers.onStationSelectChange).toHaveBeenCalledWith("bKaya");

    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const stationButton = buttons.find(
      (b) =>
        typeof b.props.class === "string" &&
        b.props.class.includes("station-button") &&
        !b.props.class.includes("unstation"),
    );
    (stationButton?.props.onClick as () => void)();
    expect(handlers.onStation).toHaveBeenCalledOnce();
  });

  it("[M74/⑫] 駐在セレクタで研究担当を選ぶと、押す前に研究が止まる注記を出す", () => {
    const scholar = { ...residentView(id("bKaya")), researchWorker: true };
    const withScholar = {
      ...cardHandlers(),
      residentOptions: [scholar],
      stationSelectValue: id("bKaya"),
    };
    const text = flattenText(
      OutpostCard({ outpost: outpost({ residentIds: [] }), ...withScholar }),
    );
    expect(text).toContain("研究担当");
    expect(text).toContain("研究は止まります");
    // 未選択("")のときは注記を出さない(常時警告にしない)。
    const unselected = { ...withScholar, stationSelectValue: "" as const };
    expect(
      flattenText(OutpostCard({ outpost: outpost({ residentIds: [] }), ...unselected })),
    ).not.toContain("研究は止まります");
  });

  it("常駐者が0名なら「無し」を表示し、解除ボタンを1つも持たない", () => {
    const handlers = cardHandlers();
    const vnode = OutpostCard({ outpost: outpost({ residentIds: [] }), ...handlers });
    expect(flattenText(vnode)).toContain("無し");
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    expect(
      buttons.some(
        (b) => typeof b.props.class === "string" && b.props.class.includes("unstation-button"),
      ),
    ).toBe(false);
  });
});

describe("OutpostEstablishForm(⑨新規設置・GDD 9.2)", () => {
  function baseProps() {
    return {
      outpostTypeOptions: [id("outpostFarm"), id("outpostMine")],
      selectedTypeId: id("outpostMine"),
      onTypeChange: vi.fn(),
      band: "near" as const,
      onBandChange: vi.fn(),
      residentOptions: [residentView(id("aRui")), residentView(id("bKaya"))],
      selectedResidentIds: new Set([id("aRui")]),
      onToggleResident: vi.fn(),
      onSubmit: vi.fn(),
    };
  }

  it("content に outpostType が無ければ不活性メッセージを出す(捏造しない)", () => {
    const vnode = OutpostEstablishForm({ ...baseProps(), outpostTypeOptions: [] });
    expect(flattenText(vnode)).toContain("設置できません");
  });

  it("タイプ選択肢・距離帯ボタン・住民トグル・設置ボタンを持つ", () => {
    const props = baseProps();
    const vnode = OutpostEstablishForm(props);
    const text = flattenText(vnode);
    expect(text).toContain("鉱山");
    expect(text).toContain("農園");
    expect(text).toContain("近郊");

    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const submit = buttons.find(
      (b) => typeof b.props.class === "string" && b.props.class.includes("submit-button"),
    );
    (submit?.props.onClick as () => void)();
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it("距離帯ボタンは選択中のものだけ aria-pressed=true", () => {
    const vnode = OutpostEstablishForm(baseProps());
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const bandButtons = buttons.filter(
      (b) => typeof b.props.class === "string" && b.props.class.includes("band-button"),
    );
    expect(bandButtons).toHaveLength(3);
    expect(bandButtons.filter((b) => b.props["aria-pressed"] === true)).toHaveLength(1);
  });

  it("住民トグルを押すと onToggleResident(residentId) が呼ばれる", () => {
    const props = baseProps();
    const vnode = OutpostEstablishForm(props);
    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const residentButtons = buttons.filter(
      (b) => typeof b.props.class === "string" && b.props.class.includes("resident-button"),
    );
    expect(residentButtons).toHaveLength(2);
    (residentButtons[1]?.props.onClick as () => void)();
    expect(props.onToggleResident).toHaveBeenCalledWith("bKaya");
  });

  it("[M74/⑫] 選んだ住民に研究担当が居れば、設置する前に研究が止まる注記を出す", () => {
    const props = {
      ...baseProps(),
      residentOptions: [
        residentView(id("aRui")),
        { ...residentView(id("bKaya")), researchWorker: true },
      ],
      selectedResidentIds: new Set([id("bKaya")]),
    };
    const text = flattenText(OutpostEstablishForm(props));
    expect(text).toContain("BKaya");
    expect(text).toContain("研究担当");
    expect(text).toContain("研究は止まります");
  });

  it("[M74/⑫] 研究担当を選んでいなければ注記は出さない(常時警告にしない)", () => {
    const props = {
      ...baseProps(),
      residentOptions: [
        residentView(id("aRui")),
        { ...residentView(id("bKaya")), researchWorker: true },
      ],
      selectedResidentIds: new Set([id("aRui")]),
    };
    expect(flattenText(OutpostEstablishForm(props))).not.toContain("研究は止まります");
  });
});

describe("[M74/R9-A02] stationCandidates(⑦探索本部と同じ規則で常駐者を候補から外す)", () => {
  it("既に衛星拠点へ常駐している住民は候補に残さない", () => {
    const free = residentView(id("aRui"));
    const stationed = { ...residentView(id("bKaya")), stationedOutpostId: id("outpostMine1") };
    expect(stationCandidates([free, stationed]).map((entry) => entry.entityId)).toEqual([
      id("aRui"),
    ]);
  });

  it("死亡/派遣中は落とさない(一時的な不能は engine の reject に説明させる・§2 の本則)", () => {
    const dead = { ...residentView(id("aRui")), alive: false };
    const dispatched = { ...residentView(id("bKaya")), dispatched: true };
    expect(stationCandidates([dead, dispatched])).toHaveLength(2);
  });

  it("stationedOutpostId 省略(既存フィクスチャ互換)は常駐していない扱い", () => {
    expect(stationCandidates([residentView(id("aRui"))])).toHaveLength(1);
  });

  it("入力の並び(derived の ID 昇順)を変えない", () => {
    const a = residentView(id("aRui"));
    const b = residentView(id("bKaya"));
    const c = residentView(id("cSora"));
    expect(stationCandidates([a, b, c]).map((entry) => entry.entityId)).toEqual([
      id("aRui"),
      id("bKaya"),
      id("cSora"),
    ]);
  });
});

describe("[M74/⑫] researchStopTargetNames / residentOptionLabel", () => {
  const plain = residentView(id("aRui"));
  const scholar = { ...residentView(id("bKaya")), researchWorker: true };

  it("研究担当だけを拾い、並びは residents の順(選んだ順に依存しない)", () => {
    const scholar2 = { ...residentView(id("cSora")), researchWorker: true };
    const targets = new Set([id("cSora"), id("bKaya")]);
    expect(researchStopTargetNames([plain, scholar, scholar2], targets)).toEqual([
      "BKaya",
      "CSora",
    ]);
  });

  it("対象に含まれない研究担当は拾わない", () => {
    expect(researchStopTargetNames([plain, scholar], new Set([id("aRui")]))).toEqual([]);
  });

  it("researchWorker 省略(既存フィクスチャ互換)は研究担当ではない扱い", () => {
    expect(researchStopTargetNames([plain], new Set([id("aRui")]))).toEqual([]);
  });

  it("候補ラベルは研究担当だけに印を付ける(選ぶ前から見える)", () => {
    expect(residentOptionLabel(plain)).toBe("ARui");
    expect(residentOptionLabel(scholar)).toBe("BKaya(研究担当)");
  });
});

// ---------------------------------------------------------------------------
// [M76/台帳v25必-4] 拠点設置コスト全行+在庫不足「▲」(施設②カタログ・
// R8-03 と同じ表現の拠点版)。derived.ts の CostLineView/outpostTypeCatalog を
// 結線するだけで、判定(払えるか)は再実装しない。
// ---------------------------------------------------------------------------

describe("[M76] outpostCostLinesOf / isOutpostCostInsufficient / outpostCostLinesText", () => {
  const catalog: readonly OutpostTypeCatalogEntry[] = [
    {
      outpostTypeId: id("outpostMine"),
      buildCostLines: [
        { resourceId: id("firewood"), amountApprox: 45 },
        { resourceId: id("iron"), amountApprox: 12 },
      ],
    },
    { outpostTypeId: id("outpostFarm"), buildCostLines: [] },
  ];

  it("outpostCostLinesOf: 選択中タイプのコスト全行をカタログから引く", () => {
    expect(outpostCostLinesOf(catalog, id("outpostMine"))).toEqual([
      { resourceId: id("firewood"), amountApprox: 45 },
      { resourceId: id("iron"), amountApprox: 12 },
    ]);
  });

  it("outpostCostLinesOf: 未選択(null)は空(判定しない)", () => {
    expect(outpostCostLinesOf(catalog, null)).toEqual([]);
  });

  it("outpostCostLinesOf: カタログに無い ID は空(捏造しない)", () => {
    expect(outpostCostLinesOf(catalog, id("outpostUnknown"))).toEqual([]);
  });

  it("isOutpostCostInsufficient: 全行の在庫が足りていれば false", () => {
    const lines: readonly CostLineView[] = [
      { resourceId: id("firewood"), amountApprox: 45 },
      { resourceId: id("iron"), amountApprox: 12 },
    ];
    const resources = [resourceView(id("firewood"), 100), resourceView(id("iron"), 12)];
    expect(isOutpostCostInsufficient(lines, resources)).toBe(false);
  });

  it("isOutpostCostInsufficient: 第2行以降の不足も見る(主資源だけ見ない)", () => {
    const lines: readonly CostLineView[] = [
      { resourceId: id("firewood"), amountApprox: 45 },
      { resourceId: id("iron"), amountApprox: 12 },
    ];
    // 薪は足りるが鉄が 0(未掲載 = 在庫 0 扱い)。
    const resources = [resourceView(id("firewood"), 100)];
    expect(isOutpostCostInsufficient(lines, resources)).toBe(true);
  });

  it("outpostCostLinesText: 資源名+量を「・」区切りで結合する", () => {
    const lines: readonly CostLineView[] = [
      { resourceId: id("firewood"), amountApprox: 45 },
      { resourceId: id("iron"), amountApprox: 12 },
    ];
    expect(outpostCostLinesText(lines)).toBe("薪 45・鉄 12");
  });
});

describe("[M76] OutpostEstablishForm: 設置コスト全行表示+在庫不足「▲」", () => {
  function baseProps() {
    return {
      outpostTypeOptions: [id("outpostFarm"), id("outpostMine")],
      selectedTypeId: id("outpostMine"),
      onTypeChange: vi.fn(),
      band: "near" as const,
      onBandChange: vi.fn(),
      residentOptions: [residentView(id("aRui"))],
      selectedResidentIds: new Set<EntityId>(),
      onToggleResident: vi.fn(),
      onSubmit: vi.fn(),
    };
  }

  it("costLines 省略時(既存呼び出し元互換)は「設置コストはかかりません」を出す", () => {
    const text = flattenText(OutpostEstablishForm(baseProps()));
    expect(text).toContain("設置コストはかかりません。");
  });

  it("costLines が空配列でも同様に無料表記", () => {
    const text = flattenText(OutpostEstablishForm({ ...baseProps(), costLines: [] }));
    expect(text).toContain("設置コストはかかりません。");
  });

  it("[R8-03 拠点版] コスト全行を表示する(第1行だけに丸めない)", () => {
    const text = flattenText(
      OutpostEstablishForm({
        ...baseProps(),
        costLines: [
          { resourceId: id("firewood"), amountApprox: 45 },
          { resourceId: id("iron"), amountApprox: 12 },
        ],
        insufficient: false,
      }),
    );
    expect(text).toContain("設置コスト: 薪 45・鉄 12");
    expect(text).not.toContain("▲");
  });

  it("[R8-03 拠点版] 在庫不足なら「▲」を先頭に付ける(ボタンは非活性にしない)", () => {
    const props = {
      ...baseProps(),
      costLines: [{ resourceId: id("firewood"), amountApprox: 45 }],
      insufficient: true,
    };
    const vnode = OutpostEstablishForm(props);
    expect(flattenText(vnode)).toContain("▲ 設置コスト: 薪 45");

    const buttons: FoundElement[] = [];
    collectByType(vnode, "button", buttons);
    const submit = buttons.find(
      (b) => typeof b.props.class === "string" && b.props.class.includes("submit-button"),
    );
    expect(submit).toBeDefined();
    (submit?.props.onClick as () => void)();
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });
});
