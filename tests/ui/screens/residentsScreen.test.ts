// ---------------------------------------------------------------------------
// src/ui/screens/residents/ResidentsScreen.tsx のテスト(M30)。
//
// `ResidentRow` は hooks を使わない純関数コンポーネントなので、Preact の
// render() を通さず直接呼んで vnode 構造を検証する(gridBoard.test.ts と
// 同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { FacilityRosterEntry, ResidentView } from "../../../src/ui/derived";
import {
  isAutoAssignable,
  planAutoAssignments,
  ResidentRow,
} from "../../../src/ui/screens/residents/ResidentsScreen";

const id = entityIdFromString;

function residentView(overrides: Partial<ResidentView> = {}): ResidentView {
  return {
    entityId: id("aRui"),
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
    ...overrides,
  };
}

const ROSTER: readonly FacilityRosterEntry[] = [
  {
    facilityId: id("facHearth1"),
    defId: id("hearth"),
    cellIndex: 14,
    cellId: "c14",
    level: 1,
    tags: ["heat"],
    workerIds: [],
    slotsMax: null,
  },
];

/** vnode ツリーから全テキストを区切り無しで集める(facilityScreen.test.ts と同型)。 */
function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node !== "object") return "";
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return flattenText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return flattenText(vnode.props?.children);
}

/** vnode ツリーから class 名で子要素を 1 個探す(gridBoard.test.ts の findChildByClass と同型)。 */
function findByClass(
  node: unknown,
  className: string,
): { readonly props?: { readonly class?: string; readonly children?: unknown } } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown; readonly class?: string };
  };
  if (typeof vnode.type === "function") {
    return findByClass((vnode.type as (props: unknown) => unknown)(vnode.props), className);
  }
  if (vnode.props?.class === className) return vnode;
  return findByClass(vnode.props?.children, className);
}

/** バッジ列(`.kf-resident-row__badges`)だけのテキスト。無ければ空文字。 */
function badgeText(node: unknown): string {
  const badges = findByClass(node, "kf-resident-row__badges");
  return badges === undefined ? "" : flattenText(badges.props?.children);
}

/** vnode ツリーから最初に見つかった <select> を返す(assign/unassign の分岐に使う)。 */
function findSelect(
  node: unknown,
): { readonly props: { readonly onChange: (e: Event) => void } } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelect(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (node === null || node === undefined || typeof node !== "object") return null;
  const candidate = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (candidate.type === "select") {
    return candidate as { readonly props: { readonly onChange: (e: Event) => void } };
  }
  if (typeof candidate.type === "function") {
    return findSelect((candidate.type as (props: unknown) => unknown)(candidate.props));
  }
  return findSelect(candidate.props?.children);
}

function fakeChangeEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

describe("ResidentRow: ステータス5種/trait/状態表示(GDD 7.1/7.2/7.5/11.2)", () => {
  it("ステータス5種がすべて表示される", () => {
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("体力50");
    expect(text).toContain("器用50");
    expect(text).toContain("知性50");
    expect(text).toContain("頑健50");
    expect(text).toContain("意志50");
  });

  it("trait は日本語ラベルで表示される(GDD 7.2)", () => {
    const vnode = ResidentRow({
      resident: residentView({ traitIds: [id("traitScholar"), id("traitStrongArm")] }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("学者");
    expect(text).toContain("怪力");
  });

  it("平常時(在宅・無配属)はバッジが「無配属」だけになる", () => {
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    expect(badgeText(vnode)).toBe("無配属");
  });

  it("死亡tombstoneは「死亡」を表示し、「無配属」は出さない(バッジ列のみで判定)", () => {
    const vnode = ResidentRow({
      resident: residentView({ alive: false, diedTick: 500 }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const badges = badgeText(vnode);
    expect(badges).toContain("死亡");
    expect(badges).not.toContain("無配属");
  });

  it("派遣中は「派遣中」を表示し、「無配属」は出さない(就労スロットから外れているだけで無配属扱いしない)", () => {
    const vnode = ResidentRow({
      resident: residentView({ dispatched: true }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const badges = badgeText(vnode);
    expect(badges).toContain("派遣中");
    expect(badges).not.toContain("無配属");
  });

  it("想起困難は他の状態と同時表示できる", () => {
    const vnode = ResidentRow({
      resident: residentView({ recallImpaired: true, assignedFacilityId: id("facHearth1") }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const badges = badgeText(vnode);
    expect(badges).toContain("想起困難");
    expect(badges).not.toContain("無配属"); // 配属済みなので無配属ではない
  });

  it("[M70/R5-A02] techImpairments があれば recallImpaired=false でも「想起困難」バッジ+対象tech名を出す", () => {
    const vnode = ResidentRow({
      resident: residentView({
        recallImpaired: false,
        assignedFacilityId: id("facHearth1"),
        techImpairments: [{ techId: id("techFireStarting"), untilTick: 500 }],
      }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const text = flattenText(vnode);
    expect(badgeText(vnode)).toContain("想起困難");
    expect(text).toContain("想起困難の対象");
    expect(text).toContain("火起こし");
  });

  it("techImpairments 省略時(既存呼び出し互換)は対象tech行を出さない", () => {
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    expect(flattenText(vnode)).not.toContain("想起困難の対象");
  });

  it("[M70/R5-A07] 拠点常駐中は「拠点常駐」を表示し「無配属」は出さない(常駐状態が分かる)", () => {
    const vnode = ResidentRow({
      resident: residentView({ stationedOutpostId: id("outpost1") }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const badges = badgeText(vnode);
    expect(badges).toContain("拠点常駐");
    expect(badges).not.toContain("無配属");
  });

  it("stationedOutpostId 省略時(既存呼び出し互換)は平常時どおり「無配属」を出す", () => {
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    expect(badgeText(vnode)).toBe("無配属");
  });

  it("就労先セレクトに施設ロースターの選択肢が並ぶ", () => {
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    expect(flattenText(vnode)).toContain("かまど");
  });

  it("[M70/R5-A11] 就労枠0の施設は候補から除外する(選んでも必ずrejectされるだけの選択肢を出さない)", () => {
    const rosterWithZeroSlots: readonly FacilityRosterEntry[] = [
      ...ROSTER,
      {
        facilityId: id("facBed1"),
        defId: id("bed"),
        cellIndex: 20,
        cellId: "c20",
        level: 1,
        tags: [],
        workerIds: [],
        slotsMax: 0,
      },
    ];
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: rosterWithZeroSlots,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("かまど");
    // セル20(cellCoordinateLabel で「3列4行」)は slotsMax=0 の施設だけが持つ
    // 座標なので、これが出ないことで候補から除外されたことを確認できる。
    expect(text).not.toContain("3列4行");
  });
});

describe("[M73/R8-07] 士気の表示(④住民一覧・配属判断の材料)", () => {
  it("5能力と並べて士気を出す(探索本部・大移動だけに出ていた非対称の解消)", () => {
    const vnode = ResidentRow({
      resident: residentView({ moraleApprox: 68.2 }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("士気68.2");
  });
});

describe("ResidentRow: 割当/解除(assignResident/unassignResident)", () => {
  it("施設を選ぶと onAssign(residentId, facilityId) が呼ばれる", () => {
    const onAssign = vi.fn();
    const vnode = ResidentRow({
      resident: residentView(),
      facilityRoster: ROSTER,
      onAssign,
      onUnassign: () => undefined,
    });
    const select = findSelect(vnode);
    expect(select).not.toBeNull();
    select?.props.onChange(fakeChangeEvent(id("facHearth1")));
    expect(onAssign).toHaveBeenCalledWith(id("aRui"), id("facHearth1"));
  });

  it("「(無配属)」を選ぶと onUnassign(residentId) が呼ばれる", () => {
    const onUnassign = vi.fn();
    const vnode = ResidentRow({
      resident: residentView({ assignedFacilityId: id("facHearth1") }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign,
    });
    const select = findSelect(vnode);
    select?.props.onChange(fakeChangeEvent(""));
    expect(onUnassign).toHaveBeenCalledWith(id("aRui"));
  });

  it("派遣中/拠点常駐(一時的な不能)ではセレクトは活性のまま(判定は engine の reject に委ねる)", () => {
    const vnode = ResidentRow({
      resident: residentView({ dispatched: true }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const select = findSelect(vnode);
    expect(select).not.toBeNull();
    expect((select as unknown as { props: { disabled?: boolean } }).props.disabled).toBeUndefined();
  });

  it("[M73/R8-12] 死亡(恒久的に不能)はセレクタを出さず理由を文で示す", () => {
    // §3 の規律が守るのは「いまできないだけかもしれないこと」を隠さないことで、
    // 死亡は成功しうる未来の state が無い恒久状態(就労枠0の施設を候補から外す
    // のと同じ「構造的事実」)。詳細は ResidentsScreen.tsx §3 の追記参照。
    const vnode = ResidentRow({
      resident: residentView({ alive: false }),
      facilityRoster: ROSTER,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    expect(findSelect(vnode)).toBeNull();
    expect(flattenText(vnode)).toContain("亡くなった住民は就労できません");
  });
});

// ---------------------------------------------------------------------------
// [M74/R9-C01] おまかせ配属(一括)の割り当て規則。
//
// engine には新しいコマンドを足していないので、ここで固定すべきは
// 「どの住民をどの施設へ送る `assignResident` を、どの順で発行するか」だけである
// (実際に配属が成立するかは commands.ts のテストが持つ)。決定論(同じ入力→
// 同じ並び)と、必ず reject される住民を触らないことを検査する。
// ---------------------------------------------------------------------------

function facilityEntry(
  facilityId: string,
  overrides: Partial<FacilityRosterEntry> = {},
): FacilityRosterEntry {
  return {
    facilityId: id(facilityId),
    defId: id("workbench"),
    cellIndex: 0,
    cellId: "c0",
    level: 1,
    tags: [],
    workerIds: [],
    slotsMax: 2,
    ...overrides,
  };
}

describe("[M74/R9-C01] isAutoAssignable(おまかせ配属の対象住民)", () => {
  it("生存・非派遣・非常駐・未配属なら対象", () => {
    expect(isAutoAssignable(residentView())).toBe(true);
  });

  it("死亡・派遣中・拠点常駐は対象外(必ず reject される割り当てを作らない)", () => {
    expect(isAutoAssignable(residentView({ alive: false }))).toBe(false);
    expect(isAutoAssignable(residentView({ dispatched: true }))).toBe(false);
    expect(isAutoAssignable(residentView({ stationedOutpostId: id("outpostMine1") }))).toBe(false);
  });

  it("既に就労している住民は対象外(意図した配置を一括操作で崩さない)", () => {
    expect(isAutoAssignable(residentView({ assignedFacilityId: id("facHearth1") }))).toBe(false);
  });
});

describe("[M74/R9-C01] planAutoAssignments(決定論的な一括割り当て)", () => {
  it("住民は ID 昇順・施設は 1 巡ごとに 1 名ずつ(round robin)", () => {
    const residents = [
      residentView({ entityId: id("aRui") }),
      residentView({ entityId: id("bKaya") }),
      residentView({ entityId: id("cSora") }),
    ];
    const roster = [facilityEntry("facA", { slotsMax: 2 }), facilityEntry("facB", { slotsMax: 2 })];
    expect(planAutoAssignments(residents, roster)).toEqual([
      { residentId: id("aRui"), facilityId: id("facA") },
      { residentId: id("bKaya"), facilityId: id("facB") },
      { residentId: id("cSora"), facilityId: id("facA") },
    ]);
  });

  it("同じ入力からは常に同じ並びを返す(乱数を使わない)", () => {
    const residents = [
      residentView({ entityId: id("aRui") }),
      residentView({ entityId: id("bKaya") }),
    ];
    const roster = [facilityEntry("facA"), facilityEntry("facB")];
    expect(planAutoAssignments(residents, roster)).toEqual(planAutoAssignments(residents, roster));
  });

  it("就労中の人数ぶん空きを減らし、埋まっている施設は飛ばす", () => {
    const residents = [residentView({ entityId: id("aRui") })];
    const roster = [
      facilityEntry("facA", { slotsMax: 1, workerIds: [id("zOld")] }),
      facilityEntry("facB", { slotsMax: 1 }),
    ];
    expect(planAutoAssignments(residents, roster)).toEqual([
      { residentId: id("aRui"), facilityId: id("facB") },
    ]);
  });

  it("就労枠 0 の施設(寝床/保管庫等)は割り当て先にしない", () => {
    const residents = [residentView({ entityId: id("aRui") })];
    expect(planAutoAssignments(residents, [facilityEntry("facBed", { slotsMax: 0 })])).toEqual([]);
  });

  it("空きが足りなければ入り切らない住民は含めない(facilitySlotsFull を踏まない)", () => {
    const residents = [
      residentView({ entityId: id("aRui") }),
      residentView({ entityId: id("bKaya") }),
    ];
    const plan = planAutoAssignments(residents, [facilityEntry("facA", { slotsMax: 1 })]);
    expect(plan).toEqual([{ residentId: id("aRui"), facilityId: id("facA") }]);
  });

  it("上限なし(slotsMax=null)の施設でも他の施設へ人が回る(§4 の (c) の理由)", () => {
    const residents = [
      residentView({ entityId: id("aRui") }),
      residentView({ entityId: id("bKaya") }),
    ];
    const roster = [
      facilityEntry("facA", { slotsMax: null }),
      facilityEntry("facB", { slotsMax: 1 }),
    ];
    expect(planAutoAssignments(residents, roster)).toEqual([
      { residentId: id("aRui"), facilityId: id("facA") },
      { residentId: id("bKaya"), facilityId: id("facB") },
    ]);
  });

  it("対象外の住民(死亡/派遣中/常駐/就労中)は 1 件も含まない", () => {
    const residents = [
      residentView({ entityId: id("aRui"), alive: false }),
      residentView({ entityId: id("bKaya"), dispatched: true }),
      residentView({ entityId: id("cSora"), stationedOutpostId: id("outpostMine1") }),
      residentView({ entityId: id("dTaki"), assignedFacilityId: id("facA") }),
    ];
    expect(planAutoAssignments(residents, [facilityEntry("facA", { slotsMax: 4 })])).toEqual([]);
  });

  it("施設が 1 つも無ければ空(何も起きない)", () => {
    expect(planAutoAssignments([residentView()], [])).toEqual([]);
  });
});
