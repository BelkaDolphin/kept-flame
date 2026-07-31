// ---------------------------------------------------------------------------
// src/ui/screens/expedition/ExpeditionScreen.tsx のテスト(M32)。
//
// `BandPicker`/`DestinationPicker`/`StancePicker`/`CandidateRow`/`RoiPanel`/
// `DispatchRow` は hooks を使わない純関数コンポーネントなので、Preact の
// render() を通さず直接呼んで vnode 構造を検証する(gridScreen.test.ts /
// facilityScreen.test.ts と同じ方針・vitest は `environment: "node"`)。
//
// `ExpeditionScreen` 本体(hooks あり)は登録テスト(appShell.test.ts の
// render 経由の型検査)のみで済ませる——実際のマウント確認は `npm run build` +
// ブラウザ実機の担当(gridScreen.test.ts の doc と同じ切り分け)。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { entityIdFromString } from "../../../src/engine/state/state";
import type { ExpeditionCandidateView, ExpeditionDispatchView } from "../../../src/ui/derived";
import {
  BandPicker,
  CandidateRow,
  DestinationPicker,
  DispatchRow,
  RoiPanel,
  StancePicker,
} from "../../../src/ui/screens/expedition/ExpeditionScreen";
import { previewExplorationRoi } from "../../../src/ui/derived";
import { candidateResident, m32Content } from "../m32Fixtures";
import { createGameState } from "../../../src/engine/state/update";
import { META, resource } from "../../engine/fixtures";

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

function candidate(overrides: Partial<ExpeditionCandidateView> = {}): ExpeditionCandidateView {
  return {
    entityId: id("aRui"),
    combatPowerApprox: 50,
    moraleApprox: 60,
    traitIds: [],
    ...overrides,
  };
}

describe("BandPicker(⑦目的地=距離帯)", () => {
  it("near/far/deep の3ボタンを出し、選択中に aria-pressed=true を付ける", () => {
    const vnode = BandPicker({ band: "far", onPick: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("近郊");
    expect(text).toContain("遠隔");
    expect(text).toContain("深部");
  });
});

describe("DestinationPicker(⑦目的地=具体的な行き先)", () => {
  it("procedural=true なら「この距離帯(手続き生成)」の1択を出す", () => {
    const vnode = DestinationPicker({
      options: [id("expeditionNearProcedural")],
      destinationId: id("expeditionNearProcedural"),
      onPick: () => undefined,
      procedural: true,
    });
    expect(flattenText(vnode)).toContain("この距離帯(手続き生成)");
  });

  it("procedural=false なら raw ID をそのまま表示する(捏造しない)", () => {
    const vnode = DestinationPicker({
      options: [id("eventNearRubbleSweep")],
      destinationId: id("eventNearRubbleSweep"),
      onPick: () => undefined,
      procedural: false,
    });
    expect(flattenText(vnode)).toContain("eventNearRubbleSweep");
  });
});

describe("StancePicker(GDD 8.3 撤退/強行)", () => {
  it("cautious/press の2ボタンを出す", () => {
    const vnode = StancePicker({ stance: "cautious", onPick: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("撤退重視");
    expect(text).toContain("強行");
  });
});

describe("CandidateRow(⑦派遣候補1名)", () => {
  it("戦力・士気・traitを表示する", () => {
    const vnode = CandidateRow({
      candidate: candidate({ traitIds: [id("traitScholar")] }),
      selected: false,
      disabled: false,
      onToggle: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("戦力50");
    expect(text).toContain("士気60");
    expect(text).toContain("学者");
  });
});

describe("RoiPanel(GDD 8.6・検収条件=(B)損失リスク項が画面に出ているか)", () => {
  it("content に exploration が無ければ不活性メッセージ", () => {
    const vnode = RoiPanel({ report: null, rewardResourceId: null });
    expect(flattenText(vnode)).toContain("算出できません");
  });

  it("(B)喪失リスクの期待損失・対象件数・全滅確率・ROIをすべて表示する", () => {
    const member = candidateResident("aMember");
    const state = createGameState(META, [member, resource("wStock", id("wood"))]);
    const content = m32Content();
    const report = previewExplorationRoi(state, content, "near", [member.id]);
    if (report === null) throw new Error("report が null(フィクスチャの exploration ブロック欠落)");
    const vnode = RoiPanel({ report, rewardResourceId: id("wood") });
    const text = flattenText(vnode);
    expect(text).toContain("期待報酬");
    expect(text).toContain("逸失生産");
    expect(text).toContain("(B)喪失リスク");
    expect(text).toContain("期待損失");
    expect(text).toContain("全滅確率");
    expect(text).toContain("ROI");
  });
});

describe("DispatchRow(⑦/⑧未帰還派遣1件)", () => {
  it("目的地・方針・隊員・帰還予定を表示する", () => {
    const dispatch: ExpeditionDispatchView = {
      dispatchId: id("dispatchNear1"),
      destinationId: id("eventNearRubbleSweep"),
      band: "near",
      stance: "press",
      memberIds: [id("aRui"), id("aKaya")],
      dispatchTick: 0,
      returnTick: 60,
      rewardResourceId: id("wood"),
      rewardApprox: 30,
      withdrawn: false,
      casualtyMemberIds: [],
    };
    const vnode = DispatchRow({ dispatch });
    const text = flattenText(vnode);
    expect(text).toContain("近郊");
    expect(text).toContain("eventNearRubbleSweep");
    expect(text).toContain("強行");
    expect(text).toContain("aRui");
    expect(text).toContain("aKaya");
  });

  it("脱落見込みがあれば表示する", () => {
    const dispatch: ExpeditionDispatchView = {
      dispatchId: id("dispatchNear1"),
      destinationId: id("eventNearRubbleSweep"),
      band: "near",
      stance: "cautious",
      memberIds: [id("aRui")],
      dispatchTick: 0,
      returnTick: 60,
      rewardResourceId: id("wood"),
      rewardApprox: 15,
      withdrawn: true,
      casualtyMemberIds: [id("aRui")],
    };
    const vnode = DispatchRow({ dispatch });
    expect(flattenText(vnode)).toContain("脱落見込み");
  });
});
