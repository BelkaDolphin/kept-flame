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

import { FIX_ZERO } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import type {
  ExpeditionCandidateView,
  ExpeditionDispatchView,
  ResourceView,
} from "../../../src/ui/derived";
import {
  BandPicker,
  CandidateRow,
  DestinationPicker,
  DispatchRow,
  RoiPanel,
  rewardMayOverflow,
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

describe("DestinationPicker(⑦目的地=具体的な行き先・束B/B-3で和名化)", () => {
  it("手続き生成フォールバック(ID末尾がProcedural)は「この距離帯のどこか」と表示する", () => {
    const vnode = DestinationPicker({
      options: [id("expeditionNearProcedural")],
      destinationId: id("expeditionNearProcedural"),
      onPick: () => undefined,
    });
    expect(flattenText(vnode)).toContain("この距離帯のどこか");
  });

  it("named event は raw ID ではなく和名(eventLabel)を表示する", () => {
    const vnode = DestinationPicker({
      options: [id("eventNearRubbleSweep")],
      destinationId: id("eventNearRubbleSweep"),
      onPick: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("瓦礫原の捜索");
    expect(text).not.toContain("eventNearRubbleSweep");
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
  it("[束B/m-8] チーム0人なら「住民を選ぶと予測を表示します」に差し替える", () => {
    const vnode = RoiPanel({ report: null, rewardResourceId: null, teamSize: 0 });
    expect(flattenText(vnode)).toContain("住民を選ぶと予測を表示します");
  });

  it("content に exploration が無ければ不活性メッセージ", () => {
    const vnode = RoiPanel({ report: null, rewardResourceId: null, teamSize: 1 });
    expect(flattenText(vnode)).toContain("算出できません");
  });

  it("(B)喪失リスクの期待損失・対象件数・全滅確率・投資効率をすべて表示する", () => {
    const member = candidateResident("aMember");
    const state = createGameState(META, [member, resource("wStock", id("wood"))]);
    const content = m32Content();
    const report = previewExplorationRoi(state, content, "near", [member.id]);
    if (report === null) throw new Error("report が null(フィクスチャの exploration ブロック欠落)");
    const vnode = RoiPanel({ report, rewardResourceId: id("wood"), teamSize: 1 });
    const text = flattenText(vnode);
    expect(text).toContain("期待報酬");
    expect(text).toContain("逸失生産");
    expect(text).toContain("(B)喪失リスク");
    expect(text).toContain("期待損失");
    expect(text).toContain("全滅確率");
    // [M73/R8-08] 「ROI」は和語「投資効率」へ(軸D規約=英語生値を露出しない)。
    expect(text).toContain("投資効率");
    expect(text).not.toContain("ROI");
    // 近似であることの注記(実際の成否は出発後に決まる)。
    expect(text).toContain("目安");
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
    // [束B/B-3] 目的地は raw event ID ではなく和名(eventLabel)で表示する。
    expect(text).toContain("瓦礫原の捜索");
    expect(text).not.toContain("eventNearRubbleSweep");
    expect(text).toContain("強行");
    // [束B/B-3] 隊員も residentDisplayName(先頭大文字化)を通す。
    expect(text).toContain("ARui");
    expect(text).toContain("AKaya");
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

  it("[台帳v18 必-1] 「持ち帰り予定」(粗報酬の見込み)を表示する", () => {
    const dispatch: ExpeditionDispatchView = {
      dispatchId: id("dispatchNear1"),
      destinationId: id("eventNearRubbleSweep"),
      band: "near",
      stance: "cautious",
      memberIds: [id("aRui")],
      dispatchTick: 0,
      returnTick: 60,
      rewardResourceId: id("wood"),
      rewardApprox: 30,
      withdrawn: false,
      casualtyMemberIds: [],
    };
    const vnode = DispatchRow({ dispatch });
    const text = flattenText(vnode);
    expect(text).toContain("持ち帰り予定");
    expect(text).toContain("30");
    expect(text).not.toContain("倉庫がこの資源の保管上限");
  });

  it("[台帳v18 必-1] mayOverflow=true なら倉庫満杯の注記を添える(満額表示だけにしない)", () => {
    const dispatch: ExpeditionDispatchView = {
      dispatchId: id("dispatchNear1"),
      destinationId: id("eventNearRubbleSweep"),
      band: "near",
      stance: "cautious",
      memberIds: [id("aRui")],
      dispatchTick: 0,
      returnTick: 60,
      rewardResourceId: id("wood"),
      rewardApprox: 30,
      withdrawn: false,
      casualtyMemberIds: [],
    };
    const vnode = DispatchRow({ dispatch, mayOverflow: true });
    expect(flattenText(vnode)).toContain("倉庫がこの資源の保管上限");
  });
});

describe("[台帳v18 必-1] rewardMayOverflow(倉庫満杯の見込み判定・engine再計算はしない)", () => {
  function resourceView(overrides: Partial<ResourceView> = {}): ResourceView {
    return {
      entityId: id("rWood"),
      resourceId: id("wood"),
      stockFix: FIX_ZERO,
      stockApprox: 0,
      capacityApprox: null,
      atCapacity: false,
      ...overrides,
    };
  }

  it("上限が無い資源(capacityApprox=null)は常に false", () => {
    expect(rewardMayOverflow([resourceView({ capacityApprox: null })], id("wood"), 100)).toBe(
      false,
    );
  });

  it("在庫+報酬が上限を超えるなら true", () => {
    const resources = [resourceView({ stockApprox: 780, capacityApprox: 800 })];
    expect(rewardMayOverflow(resources, id("wood"), 30)).toBe(true);
  });

  it("在庫+報酬が上限以内なら false", () => {
    const resources = [resourceView({ stockApprox: 100, capacityApprox: 800 })];
    expect(rewardMayOverflow(resources, id("wood"), 30)).toBe(false);
  });

  it("既に上限(atCapacity=true)なら報酬額に関わらず true", () => {
    const resources = [resourceView({ stockApprox: 800, capacityApprox: 800, atCapacity: true })];
    expect(rewardMayOverflow(resources, id("wood"), 0)).toBe(true);
  });

  it("対象資源の ResourceView が無ければ false(捏造しない)", () => {
    expect(rewardMayOverflow([], id("wood"), 100)).toBe(false);
  });
});

describe("[M73/R8-08] 見込みの根拠と近似の注記", () => {
  const member = candidateResident("aMember");
  const state = createGameState(META, [member, resource("wStock", id("wood"))]);

  /** `sourceEventIds` だけを差し替えた表示用レポート(注記の出し分けは本数だけで決まる)。 */
  function reportWithSources(sourceEventIds: readonly ReturnType<typeof id>[]) {
    const base = previewExplorationRoi(state, m32Content(), "near", [member.id]);
    if (base === null) throw new Error("report が null(フィクスチャの exploration ブロック欠落)");
    return { ...base, sourceEventIds };
  }

  function textOf(report: ReturnType<typeof reportWithSources>): string {
    return flattenText(RoiPanel({ report, rewardResourceId: id("wood"), teamSize: 1 }));
  }

  it("目的地1本(engine が destinationId で絞った場合)は「選んでいる行き先の内容から」", () => {
    expect(textOf(reportWithSources([id("eventNearA")]))).toContain("選んでいる行き先の内容から");
  });

  it("複数本(帯平均)は「行ける先すべての平均から」", () => {
    expect(textOf(reportWithSources([id("eventNearA"), id("eventNearB")]))).toContain(
      "行ける先すべての平均から",
    );
  });

  it("行き先の記録が無い距離帯は手続きモデルであることを明かす", () => {
    expect(textOf(reportWithSources([]))).toContain("具体的な行き先の記録がないため");
  });

  it("どの場合も確率モデルの目安であることを言う(実際の成否は出発後に決まる)", () => {
    expect(textOf(reportWithSources([id("eventNearA")]))).toContain("目安");
  });
});
