// ---------------------------------------------------------------------------
// src/ui/screens/rejectionMessages.ts のテスト(束B/B-1・最重要)。
//
// 確認すること:
//   (1) 網羅性: commands.ts の `COMMAND_REJECTION_CODES`(正本)と
//       rejectionMessages.ts がカバーする code 集合が完全一致する
//       (片方だけに追加された code を検出する)。
//   (2) 主要 code の文言スポットチェック: 1e6 raw 値が人間可読へ変換される・
//       研究/成文化の entity ID から techId が正しく逆算される・
//       未知 code は engine の元 message へフォールバックする。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { COMMAND_REJECTION_CODES, type CommandRejection } from "../../../src/engine/commands";
import { entityIdFromString } from "../../../src/engine/state/state";
import {
  playerRejectionMessage,
  REJECTION_MESSAGE_CODES,
} from "../../../src/ui/screens/rejectionMessages";

const id = entityIdFromString;

/** テスト内で足りないフィールドを null 埋めする最小コンストラクタ。 */
function rejection(
  partial: Partial<CommandRejection> & { readonly code: CommandRejection["code"] },
): CommandRejection {
  return {
    commandKind: null,
    commandIndex: 0,
    subjectId: null,
    cellIndex: null,
    limit: null,
    actual: null,
    resourceId: null,
    requiredRaw: null,
    availableRaw: null,
    ownerTask: null,
    message: "(テスト用の元メッセージ)",
    ...partial,
  };
}

describe("rejectionMessages: 網羅性(commands.ts の COMMAND_REJECTION_CODES と完全一致)", () => {
  it("REJECTION_MESSAGE_CODES がカバーする code は COMMAND_REJECTION_CODES と過不足なく一致する", () => {
    const engineCodes = [...COMMAND_REJECTION_CODES].sort();
    const uiCodes = [...REJECTION_MESSAGE_CODES].sort();
    expect(uiCodes).toEqual(engineCodes);
  });

  it("全 code が実際に元メッセージと異なる(=素通ししていない)独自文言を返す", () => {
    for (const code of COMMAND_REJECTION_CODES) {
      const original = "(素通し検出用のダミー元メッセージ・実際には出ない想定)";
      const message = playerRejectionMessage(rejection({ code, message: original }));
      expect(message, `code=${code} が原文を素通ししている`).not.toBe(original);
    }
  });
});

describe("rejectionMessages: 主要 code のスポットチェック", () => {
  it("insufficientResource: 1e6 raw 値を人間可読の量へ変換する(タスク例に一致)", () => {
    const message = playerRejectionMessage(
      rejection({
        code: "insufficientResource",
        resourceId: id("firewood"),
        requiredRaw: 30_000_000,
        availableRaw: 0,
      }),
    );
    expect(message).toBe("薪が足りません(必要 30 / 所持 0)。");
  });

  it("facilitySlotsFull: limit/actual をそのまま人数として表示する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "facilitySlotsFull", subjectId: id("facHearth1"), limit: 1, actual: 1 }),
    );
    expect(message).toBe("この施設の就労枠は 1 人までです(現在 1 人)。");
  });

  it("cellIsRubble / cellNotRubble: 開墾の要否を明示する", () => {
    expect(playerRejectionMessage(rejection({ code: "cellIsRubble" }))).toBe(
      "そのマスはまだ瓦礫です。先に開墾してください。",
    );
    expect(playerRejectionMessage(rejection({ code: "cellNotRubble" }))).toBe(
      "そのマスは既に開墾済みです。開墾の必要はありません。",
    );
  });

  it("researchAlreadyCompleted: research entity ID(research_<techId>)から techId を逆算して和名化する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "researchAlreadyCompleted", subjectId: id("research_techFireStarting") }),
    );
    expect(message).toBe("「火起こし」は既に解禁済みです。研究の必要はありません。");
  });

  it("researchIrreversiblyLost: 同じ ID 規則で techId を逆算する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "researchIrreversiblyLost", subjectId: id("research_techLens") }),
    );
    expect(message).toBe(
      "「研磨レンズ」は取り返しのつかない喪失で永久に失われました。この周回では再研究できません。",
    );
  });

  it("researchAlreadyCompleted: ID 規則に合わない subjectId は汎用文へ倒す(捏造しない)", () => {
    const message = playerRejectionMessage(
      rejection({ code: "researchAlreadyCompleted", subjectId: id("unexpectedId") }),
    );
    expect(message).toBe("その技術は既に解禁済みです。研究の必要はありません。");
  });

  it("prereqNotMet: subjectId が直接 techId(前提テック自身)", () => {
    const message = playerRejectionMessage(
      rejection({ code: "prereqNotMet", subjectId: id("techStorage") }),
    );
    expect(message).toBe("前提の技術 「貯蔵」 がまだ解禁されていません。");
  });

  it("duplicateRecord: codify record ID(<techId>RecordStone)から techId + 媒体を逆算する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "duplicateRecord", subjectId: id("techFireStartingRecordStone") }),
    );
    expect(message).toBe("「火起こし」の記録(石板)は既にあります。");
  });

  it("codifyAlreadyCompleted: Paper 側も同様に逆算する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "codifyAlreadyCompleted", subjectId: id("techFireStartingRecordPaper") }),
    );
    expect(message).toBe("「火起こし」の記録(紙)は既に完成しているので取り消せません。");
  });

  it("residentUnavailable/notStationed 等: 住民 ID を residentDisplayName で整形する", () => {
    const message = playerRejectionMessage(
      rejection({ code: "notStationed", subjectId: id("reshazu") }),
    );
    expect(message).toBe("Hazuはどの衛星拠点にも駐在していません。");
  });

  it("inheritTierAtMax / insufficientInheritPoints: 継承点は Fix 変換をしない(素の整数のまま)", () => {
    expect(playerRejectionMessage(rejection({ code: "inheritTierAtMax", limit: 4 }))).toBe(
      "この系統は既に上限(段4)に達しています。",
    );
    expect(
      playerRejectionMessage(
        rejection({ code: "insufficientInheritPoints", limit: 50, actual: 10 }),
      ),
    ).toBe("継承点が足りません(必要 50 点 / 残高 10 点)。");
  });

  it("[M62/FC5b・R2-A05] entityIdInUse: codify record ID から techId+媒体を逆算し「既にキューにあります」を返す(開発者向け誤診断文言を出さない)", () => {
    const message = playerRejectionMessage(
      rejection({ code: "entityIdInUse", subjectId: id("techFireStartingRecordStone") }),
    );
    expect(message).toBe("「火起こし」の記録(石板)は既にキューにあります。");
    expect(message).not.toContain("識別子");
  });

  it("entityIdInUse: research entity ID から techId を逆算し「既に研究中か解禁済み」を返す", () => {
    const message = playerRejectionMessage(
      rejection({ code: "entityIdInUse", subjectId: id("research_techFireStarting") }),
    );
    expect(message).toBe("「火起こし」は既に研究中か解禁済みです。");
  });

  it("entityIdInUse: どちらの ID 規則にも合わなければ汎用文へ倒す(捏造しない・識別子という語も出さない)", () => {
    const message = playerRejectionMessage(
      rejection({ code: "entityIdInUse", subjectId: id("dispatchNear1") }),
    );
    expect(message).toBe("この操作は既に行われています。もう一度操作をやり直してください。");
    expect(message).not.toContain("識別子");
  });

  it("notImplemented: ownerTask(タスクID等の開発語彙)を文言に含めない", () => {
    const message = playerRejectionMessage(rejection({ code: "notImplemented", ownerTask: "M99" }));
    expect(message).not.toContain("M99");
    expect(message).toBe("この機能は今後のアップデートで対応予定です。");
  });
});

describe("rejectionMessages: 未知 code は engine の元 message へフォールバックする", () => {
  it("COMMAND_REJECTION_CODES に無い code(型をすり抜けた異常系)", () => {
    const original = "未知コードの元メッセージ";
    const bogus = rejection({
      // @ts-expect-error 意図的に語彙外の code を渡す
      code: "somethingNew",
      message: original,
    });
    expect(playerRejectionMessage(bogus)).toBe(original);
  });
});
