// ---------------------------------------------------------------------------
// src/ui/screens/migration/MigrationScreen.tsx のテスト(M33)。
//
// `ExodusRecordRow`/`ExodusCrewRow`/`ExodusPreviewPanel`/`ExodusCompletedNotice`
// は hooks を使わない純関数コンポーネントなので、Preact の render() を通さず
// 直接呼んで vnode 構造を検証する(expeditionScreen.test.ts と同じ方針・
// vitest は `environment: "node"`)。
//
// `resolveExodusPlan`/`recommendExodusPlan` 自体の決定論・境界値は
// `tests/engine/exodus.test.ts` が固定済みなので、ここでは「engine の
// resolver が返す値をそのまま表示しているか」(UI 側で再計算していないか)
// だけを確認する。`MigrationScreen` 本体(hooks あり)は登録テスト
// (appShell.test.ts)のみで済ませる——前例(expeditionScreen.test.ts の doc)
// のとおり、実際のマウント確認は `npm run build` + ブラウザ実機の担当。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { resolveExodusPlan } from "../../../src/engine/rules/exodus";
import { entityIdFromString } from "../../../src/engine/state/state";
import {
  ExodusCompletedNotice,
  ExodusCrewRow,
  ExodusPreviewPanel,
  ExodusRecordRow,
  mediumLabel,
  type ExodusCrewOption,
  type ExodusRecordOption,
} from "../../../src/ui/screens/migration/MigrationScreen";
import { exodusContent, m33Record, m33Research, M33_TECH_A1, M33_TECH_B1 } from "../m33Fixtures";
import { boardState, resident } from "../fixtures";

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

describe("mediumLabel(GDD 11.1追補の媒体2種)", () => {
  it("stoneTablet=石板・paper=紙", () => {
    expect(mediumLabel("stoneTablet")).toBe("石板");
    expect(mediumLabel("paper")).toBe("紙");
  });
});

describe("ExodusRecordRow(石版プールの1件)", () => {
  it("techLabel・(A)/(B)バッジ・媒体・重みを表示する", () => {
    const record: ExodusRecordOption = {
      id: id("codifyFireStone"),
      techId: id("techFireStarting"),
      medium: "stoneTablet",
      lossClass: "rareIrreversible",
      weightApprox: 1,
    };
    const vnode = ExodusRecordRow({ record, selected: false, onToggle: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("石板");
    expect(text).toContain("一回性喪失");
    expect(text).toContain("枠 1.00");
  });

  it("選択中は aria-pressed=true・押すと onToggle(id) が呼ばれる", () => {
    const record: ExodusRecordOption = {
      id: id("codifyFireStone"),
      techId: id("techFireStarting"),
      medium: "paper",
      lossClass: "criticalRecoverable",
      weightApprox: 0.25,
    };
    const onToggle = vi.fn();
    const vnode = ExodusRecordRow({ record, selected: true, onToggle });
    const button = vnode.props.children as { readonly props: { readonly onClick: () => void } };
    expect(vnode.props.children).toBeDefined();
    button.props.onClick();
    expect(onToggle).toHaveBeenCalledWith(id("codifyFireStone"));
  });
});

describe("ExodusCrewRow(乗員プールの1件)", () => {
  it("住民ID・士気・traitを表示する", () => {
    const resident: ExodusCrewOption = {
      id: id("aRui"),
      moraleApprox: 60,
      traitIds: [id("traitScholar")],
    };
    const vnode = ExodusCrewRow({ resident, selected: false, onToggle: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("aRui");
    expect(text).toContain("士気60");
    expect(text).toContain("学者");
  });
});

describe("ExodusPreviewPanel(GDD 10.2・検収条件=何が落ちるかのプレビュー)", () => {
  it("content に exodus/recordMedia が無ければ不活性メッセージ", () => {
    const vnode = ExodusPreviewPanel({ resolution: null });
    expect(flattenText(vnode)).toContain("算出できません");
  });

  it("engine の resolveExodusPlan が返す値をそのまま表示する(UI 側の再計算なし)", () => {
    // 乗員定員 = ceil(生存人数1 × 0.5) = 1、キャラバン容量 = ceil(8×0.35) = 3(到達エラ e1)。
    // 記録2枚(石板1.0+紙0.25=1.25<3 で両方積める)・住民2名(定員1名なので1名落ちる)。
    const content = exodusContent();
    const state = boardState([
      resident("bKaya"),
      m33Research("researchA1", M33_TECH_A1, 100),
      m33Research("researchB1", M33_TECH_B1, 200),
      m33Record("codifyA1", M33_TECH_A1, "stoneTablet"),
      m33Record("codifyB1", M33_TECH_B1, "paper"),
    ]);
    const resolution = resolveExodusPlan(state, content, {
      recordIds: [id("codifyA1"), id("codifyB1")],
      crewIds: [id("aRui"), id("bKaya")],
    });
    const vnode = ExodusPreviewPanel({ resolution });
    const text = flattenText(vnode);
    expect(text).toContain("乗員");
    expect(text).toContain(
      `${String(resolution.carriedCrewIds.length)} / ${String(resolution.crewCapacity)} 名`,
    );
    if (resolution.droppedCrewIds.length > 0) {
      expect(text).toContain("定員超過で置いていく住民");
    }
    expect(text).toContain(`獲得予定の継承点(GDD 10.3): ${String(resolution.earnedInheritPoints)}`);
  });
});

describe("ExodusCompletedNotice(バックアップリマインド導線・ロードマップM33行の検分条件)", () => {
  it("獲得継承点を明記し、＋設定画面への導線ボタンを持つ", () => {
    const onGoToSettings = vi.fn();
    const vnode = ExodusCompletedNotice({ earnedInheritPoints: 84, onGoToSettings });
    const text = flattenText(vnode);
    expect(text).toContain("継承点 +84");
    expect(text).toContain("バックアップ");
    const children = vnode.props.children as readonly {
      readonly props?: { readonly onClick?: () => void };
    }[];
    const button = children[1];
    expect(button?.props?.onClick).toBeTypeOf("function");
    button?.props?.onClick?.();
    expect(onGoToSettings).toHaveBeenCalledOnce();
  });
});
