// ---------------------------------------------------------------------------
// src/ui/screens/facility/FacilityScreen.tsx のテスト(M30)。
//
// `FacilityWorkerRow`/`FacilityDetailPanel` は hooks を使わない純関数
// コンポーネントなので、Preact の render() を通さず直接呼んで vnode 構造を
// 検証する(gridBoard.test.ts と同じ方針)。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { fixFromInt } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import type { FacilityDetailView, FacilityWorkerView } from "../../../src/ui/derived";
import {
  FacilityDetailPanel,
  FacilityWorkerRow,
  isUpgradeCostInsufficient,
} from "../../../src/ui/screens/facility/FacilityScreen";

const id = entityIdFromString;

function workerView(overrides: Partial<FacilityWorkerView> = {}): FacilityWorkerView {
  return {
    residentId: id("aRui"),
    moraleApprox: 60,
    alive: true,
    dispatched: false,
    recallImpaired: false,
    ...overrides,
  };
}

function detailView(overrides: Partial<FacilityDetailView> = {}): FacilityDetailView {
  return {
    facilityId: id("facHearth1"),
    defId: id("hearth"),
    cellIndex: 14,
    cellId: "c14",
    tags: ["heat"],
    level: 2,
    maxLevel: 5,
    slotsMax: null,
    workers: [workerView()],
    outputKind: "resource",
    outputResourceId: id("firewood"),
    outputPerTickApprox: 1.5,
    multiplierApprox: 1.2,
    // [束B/B-4] 増築コスト欄の追加(derived.ts)に追随。既定は「無料」に揃え、
    // コスト表示を確認するテストだけ overrides で足す。
    upgradeCostApprox: null,
    upgradeCostResourceId: null,
    ...overrides,
  };
}

/**
 * vnode ツリーから全テキストを集める(検索用の緩い走査)。
 *
 * 区切り無しで連結する——`Lv{level}` のような JSX は `["Lv", level]` という
 * 隣接した子の配列になり、実際の DOM でも区切り無しで連続して描画される
 * (gridScreen.test.ts の `flattenText` は要素間の区切りに使うため "|" を
 * 挟むが、こちらは「1 つの文としてそのまま読めるか」を確認したいのであえて
 * 区切らない)。
 */
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

describe("FacilityWorkerRow(想起困難/派遣中/死亡tombstoneの状態表示・GDD 7.1/7.5/11.2)", () => {
  it("平常時はステータス badge を 1 つも出さない", () => {
    const vnode = FacilityWorkerRow({ worker: workerView() });
    const text = flattenText(vnode);
    // [束B/B-3] 住民IDは residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
    expect(text).toContain("士気60");
    expect(text).not.toContain("死亡");
    expect(text).not.toContain("派遣中");
    expect(text).not.toContain("想起困難");
  });

  it("死亡tombstone(alive=false)は「死亡」を出す", () => {
    const vnode = FacilityWorkerRow({ worker: workerView({ alive: false }) });
    expect(flattenText(vnode)).toContain("死亡");
  });

  it("派遣中と想起困難は同時に出せる", () => {
    const vnode = FacilityWorkerRow({
      worker: workerView({ dispatched: true, recallImpaired: true }),
    });
    const text = flattenText(vnode);
    expect(text).toContain("派遣中");
    expect(text).toContain("想起困難");
  });

  it("[M70/R5-A02] impairedTechIds があれば recallImpaired=false でも「想起困難」バッジ+対象tech名を出す", () => {
    const vnode = FacilityWorkerRow({
      worker: workerView({ recallImpaired: false, impairedTechIds: [id("techFireStarting")] }),
    });
    const text = flattenText(vnode);
    expect(text).toContain("想起困難");
    expect(text).toContain("火起こし");
    // [M73/R8-14] 見出しは「この施設に関わる想起困難」(④住民一覧の住民単位表示と
    // 規則が違うことを画面上で明示する)。
    expect(text).toContain("この施設に関わる想起困難");
  });

  it("[M73/R8-14] この施設に関わらない想起困難がある場合は件数と行き先を明示する", () => {
    const vnode = FacilityWorkerRow({
      worker: workerView({
        recallImpaired: false,
        impairedTechIds: [],
        otherImpairedTechCount: 2,
      }),
    });
    const text = flattenText(vnode);
    // 住民一覧と食い違って見えないよう、バッジ自体は出す。
    expect(text).toContain("想起困難");
    expect(text).toContain("この施設と関わらない想起困難が2件");
    expect(text).toContain("住民一覧");
  });

  it("impairedTechIds 省略時(既存呼び出し互換)は対象tech行を出さない", () => {
    const vnode = FacilityWorkerRow({ worker: workerView() });
    expect(flattenText(vnode)).not.toContain("想起困難の対象");
  });
});

describe("FacilityDetailPanel(選択施設の Lv/産出/就労者/増築)", () => {
  it("Lv・上限Lv・産出・就労者数を表示する", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("Lv2");
    expect(text).toContain("Lv5");
    // [M62/FC4] formatResourceAmount 経由(整数部3桁区切り+小数第1位のみ表示)。
    expect(text).toContain("1.5");
    expect(text).toContain("薪");
    // [M62/FC4・R2-D01] 内部語「/tick」ではなく「/分」(tick=1分)。
    expect(text).toContain("/分");
    expect(text).not.toContain("/tick");
    // [束B/B-3] 住民IDは residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
  });

  it("[M61/FC11・R1-A14] nextLevelOutputApprox があれば「現在 → 増築後」を実行前に見せる", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ outputPerTickApprox: 100 }),
      onUpgrade: () => undefined,
      nextLevelOutputApprox: 115,
    });
    const text = flattenText(vnode);
    // [M62/FC4] formatResourceAmount は整数値の末尾 ".00" を出さない。
    expect(text).toContain("100");
    expect(text).toContain("→ 115");
    expect(text).not.toContain("100.00");
  });

  it("nextLevelOutputApprox 省略時は矢印を出さない(後方互換)", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    expect(flattenText(vnode)).not.toContain("→");
  });

  it("[M61/FC6] effectKind='none' は産出/就労を出さず「効果は未実装」を出す", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView(),
      onUpgrade: () => undefined,
      effectKind: "none",
    });
    const text = flattenText(vnode);
    expect(text).toContain("効果は未実装");
    expect(text).not.toContain("就労");
  });

  it("[M61/FC6] effectKind='bedCapacity' は bedEffectText をそのまま出す", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView(),
      onUpgrade: () => undefined,
      effectKind: "bedCapacity",
      bedEffectText: "寝床上限 +2(住民の漂着加入の上限を増やす)",
    });
    expect(flattenText(vnode)).toContain("寝床上限 +2");
  });

  it("[M61/FC6・2026-08-02差し戻し] effectKind='storageCapacity' は storageEffectText を出し「効果は未実装」を出さない", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView(),
      onUpgrade: () => undefined,
      effectKind: "storageCapacity",
      storageEffectText:
        "全資源の保管上限に加算(GDD 6.7: 基礎400 + 建っている保管庫のLv合計×400)。このLv1の寄与は +400。上限を超えた産出は原則失われます(薪など一部の低次資源は超過分の一定比率が廃材になります)。",
    });
    const text = flattenText(vnode);
    expect(text).toContain("保管上限に加算");
    expect(text).not.toContain("効果は未実装");
    expect(text).not.toContain("就労");
  });

  it("[M73/R8-02] effectKind='defense' は effectText を出し「効果は未実装」も虚偽の増築警告も出さない", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ level: 1, maxLevel: 5 }),
      onUpgrade: () => undefined,
      effectKind: "defense",
      effectText: "襲撃に対する防衛戦力に加算(このLv1の寄与は +20)。",
    });
    const text = flattenText(vnode);
    expect(text).toContain("防衛戦力に加算");
    expect(text).not.toContain("効果は未実装");
    expect(text).not.toContain("増築しても効果は変わりません");
    expect(text).not.toContain("就労");
  });

  it("[M73/R8-02] effectKind='careCapacity' は effectText を出し「効果は未実装」も虚偽の増築警告も出さない", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ level: 1, maxLevel: 5 }),
      onUpgrade: () => undefined,
      effectKind: "careCapacity",
      effectText: "同時に休養できる枠(このLv1の枠は 1人)。",
    });
    const text = flattenText(vnode);
    expect(text).toContain("休養できる枠");
    expect(text).not.toContain("効果は未実装");
    expect(text).not.toContain("増築しても効果は変わりません");
  });

  it("研究点産出(resourceId=null)は「研究点」と表示する", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ outputKind: "research", outputResourceId: null }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("研究点");
  });

  it("就労者0人は「就労者がいません」と表示する(捏造しない)", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ workers: [] }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("就労者がいません");
  });

  it("[M70/R5-A02] 就労者に想起困難があれば産出行の上に注記を出す(「就労1/1なのに産出0」の理由明示)", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({
        outputPerTickApprox: 0,
        workers: [workerView({ impairedTechIds: [id("techFireStarting")] })],
      }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("想起困難のため一部の就労者の生産が止まっています");
  });

  it("想起困難な就労者がいなければ注記を出さない", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    expect(flattenText(vnode)).not.toContain("一部の就労者の生産が止まっています");
  });

  it("[束B/B-2] 増築コストが無い(def.cost 省略)場合は「コストはかかりません」と正直に表示する", () => {
    const vnode = FacilityDetailPanel({ detail: detailView(), onUpgrade: () => undefined });
    expect(flattenText(vnode)).toContain("増築コストはかかりません。");
  });

  it("[束B/B-2/B-4] 増築コストがある場合は資源名+量を実額表示する(M50結線済み)", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({ upgradeCostApprox: 45, upgradeCostResourceId: id("firewood") }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("増築コスト: 薪 45");
  });

  it("[M73/R8-03 fatal] 増築コストの複数資源(M65 の extraLines)を全行表示する", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({
        upgradeCostApprox: 17,
        upgradeCostResourceId: id("firewood"),
        upgradeCostLines: [
          { resourceId: id("firewood"), amountApprox: 17 },
          { resourceId: id("clay"), amountApprox: 7 },
        ],
      }),
      onUpgrade: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("薪 17");
    expect(text).toContain("粘土 7");
  });

  it("[M73/R8-03] 在庫不足(どれか1行)は「▲」で示すが増築ボタンは非活性にしない", () => {
    const detail = detailView({
      upgradeCostApprox: 17,
      upgradeCostResourceId: id("firewood"),
      upgradeCostLines: [
        { resourceId: id("firewood"), amountApprox: 17 },
        { resourceId: id("clay"), amountApprox: 7 },
      ],
    });
    expect(
      isUpgradeCostInsufficient(detail, [
        {
          entityId: id("resFirewood"),
          resourceId: id("firewood"),
          stockFix: fixFromInt(100),
          stockApprox: 100,
          capacityApprox: null,
          atCapacity: false,
        },
      ]),
    ).toBe(true);
    const vnode = FacilityDetailPanel({
      detail,
      onUpgrade: () => undefined,
      upgradeInsufficient: true,
    });
    expect(flattenText(vnode)).toContain("▲");
  });

  it("[束B/B-2] 既に上限Lvなら「既に上限Lvです」と表示する", () => {
    const vnode = FacilityDetailPanel({
      detail: detailView({
        level: 5,
        maxLevel: 5,
        upgradeCostApprox: null,
        upgradeCostResourceId: null,
      }),
      onUpgrade: () => undefined,
    });
    expect(flattenText(vnode)).toContain("既に上限Lvです。");
  });

  it("増築ボタンは Lv 上限でも非活性にせず、押すと onUpgrade が呼ばれる(判定は engine に委ねる)", () => {
    const onUpgrade = vi.fn();
    const atMax = detailView({ level: 5, maxLevel: 5 });
    const vnode = FacilityDetailPanel({ detail: atMax, onUpgrade });
    expect(flattenText(vnode)).toContain("Lv6");

    // 最後の div(増築ブロック)内の button を辿る。
    function findButton(
      node: unknown,
    ): { readonly props: { readonly onClick: () => void } } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findButton(child);
          if (found !== null) return found;
        }
        return null;
      }
      if (node === null || node === undefined || typeof node !== "object") return null;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly children?: unknown; readonly onClick?: unknown };
      };
      if (typeof candidate.type === "function") {
        return findButton((candidate.type as (props: unknown) => unknown)(candidate.props));
      }
      if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
        return candidate as { readonly props: { readonly onClick: () => void } };
      }
      return findButton(candidate.props?.children);
    }

    const button = findButton(vnode);
    expect(button).not.toBeNull();
    button?.props.onClick();
    expect(onUpgrade).toHaveBeenCalledOnce();
  });
});
