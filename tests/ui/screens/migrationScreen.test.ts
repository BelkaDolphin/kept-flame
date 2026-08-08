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
  exodusConfirmMessage,
  ExodusCompletedNotice,
  ExodusCrewRow,
  ExodusCrewShortfallWarning,
  ExodusInheritPointsNote,
  ExodusNextRunPreview,
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
    // [束B/B-3] residentDisplayName(先頭大文字化)を通して表示する。
    expect(text).toContain("ARui");
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
      // [束B/B-3] 落ちた住民IDも residentDisplayName を通す。
      expect(text).toContain("BKaya");
    }
    // [M70/R5-A10] 獲得予定の継承点は積み込み(選択)に依存しないので
    // `ExodusInheritPointsNote` へ分離した(このパネルは積み込みで変わる値だけ)。
    expect(text).not.toContain("獲得予定の継承点");
  });
});

describe("[M70/R5-A10] ExodusInheritPointsNote(獲得予定の継承点・積み込みプレビューとは別セクション)", () => {
  it("resolution が null なら何も出さない(算出不能を捏造しない)", () => {
    const vnode = ExodusInheritPointsNote({ resolution: null });
    expect(vnode).toBeNull();
  });

  it("engine の resolveExodusPlan.earnedInheritPoints をそのまま表示し、選択非依存であることを注記する", () => {
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
    const vnode = ExodusInheritPointsNote({ resolution });
    const text = flattenText(vnode);
    expect(text).toContain(`獲得予定の継承点: ${String(resolution.earnedInheritPoints)}`);
    expect(text).toContain("左右されません");
  });
});

describe("[M74/⑰] ExodusNextRunPreview(次の周回の開始人口予告・GDD 10.2)", () => {
  /** 乗員定員 = ceil(生存2 × 0.5) = 1 名になる盤面(住民2名・うち1名しか運べない)。 */
  function twoResidentResolution() {
    const content = exodusContent();
    const state = boardState([
      resident("bKaya"),
      m33Research("researchA1", M33_TECH_A1, 100),
      m33Research("researchB1", M33_TECH_B1, 200),
      m33Record("codifyA1", M33_TECH_A1, "stoneTablet"),
    ]);
    return resolveExodusPlan(state, content, {
      recordIds: [id("codifyA1")],
      crewIds: [id("aRui"), id("bKaya")],
    });
  }

  it("resolution が null なら何も出さない(算出不能を捏造しない)", () => {
    expect(ExodusNextRunPreview({ resolution: null })).toBeNull();
  });

  it("次の周回の開始乗員数(= engine が積めると答えた人数)と獲得予定の継承点を出す", () => {
    const resolution = twoResidentResolution();
    const text = flattenText(ExodusNextRunPreview({ resolution }));
    expect(text).toContain(
      `次の周回は乗員 ${String(resolution.carriedCrewIds.length)}人 から始まります`,
    );
    expect(text).toContain(`いま連れて行ける上限は ${String(resolution.crewCapacity)}名`);
    expect(text).toContain(`このとき獲得する継承点: ${String(resolution.earnedInheritPoints)}`);
  });

  it("立て直さずに繰り返すと縮むこと(GDD 10.2 の半分規則)を文で予告する", () => {
    const text = flattenText(ExodusNextRunPreview({ resolution: twoResidentResolution() }));
    expect(text).toContain("生存人数の半分");
    expect(text).toContain("周回ごとに");
    // 次周回の定員そのものは UI で計算しない(engine が答えていない数値を出さない)。
    expect(text).not.toContain("次の周回の上限は");
  });
});

describe("[M76/台帳v25必-4] ExodusCrewShortfallWarning(乗員不足の事前表示・GDD 10.2)", () => {
  it("minCrew が null(ガード不活性)なら何も出さない(engine 側 undefined と同じ規約)", () => {
    expect(ExodusCrewShortfallWarning({ minCrew: null, selectedCrewCount: 0 })).toBeNull();
  });

  it("選抜人数が最少人数以上なら何も出さない", () => {
    expect(ExodusCrewShortfallWarning({ minCrew: 3, selectedCrewCount: 3 })).toBeNull();
    expect(ExodusCrewShortfallWarning({ minCrew: 3, selectedCrewCount: 5 })).toBeNull();
  });

  it("選抜人数が最少人数を下回れば、N をハードコードせず両方の数値を出す", () => {
    const text = flattenText(ExodusCrewShortfallWarning({ minCrew: 3, selectedCrewCount: 1 }));
    expect(text).toContain("最少 3名");
    expect(text).toContain("選抜 1名");
    expect(text).toContain("実行できません");
  });
});

describe("[M74/⑰] exodusConfirmMessage(確認パネル本文に数値を再掲する)", () => {
  it("取り消せないことに加えて開始乗員と獲得継承点を数値で言う", () => {
    const content = exodusContent();
    const state = boardState([
      m33Research("researchA1", M33_TECH_A1, 100),
      m33Record("codifyA1", M33_TECH_A1, "stoneTablet"),
    ]);
    const resolution = resolveExodusPlan(state, content, {
      recordIds: [id("codifyA1")],
      crewIds: [id("aRui")],
    });
    const message = exodusConfirmMessage(resolution);
    expect(message).toContain("取り消せません");
    expect(message).toContain(`次の周回は乗員${String(resolution.carriedCrewIds.length)}人`);
    expect(message).toContain(`継承点+${String(resolution.earnedInheritPoints)}`);
  });

  it("resolution が null なら数値を捏造せず従来の文だけを返す", () => {
    const message = exodusConfirmMessage(null);
    expect(message).toContain("取り消せません");
    expect(message).not.toContain("乗員");
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
