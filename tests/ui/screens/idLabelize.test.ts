// ---------------------------------------------------------------------------
// src/ui/screens/idLabelize.ts のテスト(M61/FC4)。
//
// 確認すること: (1) 既知の event/資源/施設/tech ID が地の文の中でも和名へ
// 置換される (2) 手続き生成の目的地IDは「この距離帯のどこか」になる
// (3) 未登録IDは捏造せず raw のまま残る (4) 日本語の地の文自体は一切壊れない。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { fixFromRaw, FIX_ZERO } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import type { StorageParams } from "../../../src/engine/rules/types";
import { labelizeLogText, returnLogOverflowNote } from "../../../src/ui/screens/idLabelize";

const id = entityIdFromString;

function storageParams(
  wasteConversionRatioByResourceId: ReadonlyMap<
    ReturnType<typeof id>,
    ReturnType<typeof fixFromRaw>
  >,
): StorageParams {
  return {
    wasteResourceId: id("waste"),
    baseCapacityByResourceId: new Map(),
    wasteConversionRatioByResourceId,
    wasteToResearchRatioFix: FIX_ZERO,
    buildCostWasteSubstitutionMaxFix: FIX_ZERO,
    codifyWasteSubstitutionMaxFix: FIX_ZERO,
  };
}

describe("labelizeLogText(帰還ログの表示時ID変換)", () => {
  it("R1-A06の実例: event ID と資源 ID を地の文の中で和名化する", () => {
    const raw =
      "近郊探索「eventNearAshOrchard」より2名が帰還。3ノード中2成功。報酬 firewood 5850。";
    const out = labelizeLogText(raw);
    expect(out).toContain("灰かぶりの果樹園");
    expect(out).toContain("薪");
    expect(out).not.toContain("eventNearAshOrchard");
    expect(out).not.toContain("firewood");
    // 日本語の地の文はそのまま残る。
    expect(out).toContain("近郊探索");
    expect(out).toContain("2名が帰還");
    expect(out).toContain("3ノード中2成功");
  });

  it("手続き生成フォールバックの目的地ID(...Procedural)は「この距離帯のどこか」になる", () => {
    const out = labelizeLogText("近郊探索「expeditionNearProcedural」より1名が帰還。");
    expect(out).toContain("この距離帯のどこか");
    expect(out).not.toContain("Procedural");
  });

  it("facility ID / tech ID も和名化する(将来のlogTemplate拡張への備え)", () => {
    expect(labelizeLogText("hearthの火が消えた。")).toContain("かまど");
    expect(labelizeLogText("techFireStartingを閃いた。")).toContain("火起こし");
  });

  it("未登録IDは捏造せずraw ID のまま残す", () => {
    const out = labelizeLogText("resourceUnknownXyz が見つかった。");
    expect(out).toContain("resourceUnknownXyz");
  });

  it("日本語のみの文字列は無変化", () => {
    const raw = "隊は全滅した。誰も傷付くことなく核心部に達した。";
    expect(labelizeLogText(raw)).toBe(raw);
  });

  it("空文字列は空文字列のまま", () => {
    expect(labelizeLogText("")).toBe("");
  });
});

describe("[M71/R6-A03] returnLogOverflowNote(あふれた分の廃材転換注記)", () => {
  const overflowText = "報酬 firewood 63。保管上限のため 112 は持ち帰れなかった。";

  it("あふれた資源の廃材変換率が 0 より大きければ注記を付ける", () => {
    const storage = storageParams(new Map([[id("firewood"), fixFromRaw(500_000)]])); // 0.5
    expect(returnLogOverflowNote(overflowText, storage)).toBe(
      "あふれた分の一部は廃材として回収されます。",
    );
  });

  it("あふれた資源の廃材変換率が 0(未登録)なら注記を付けない(付けると逆に嘘になる)", () => {
    const storage = storageParams(new Map());
    expect(returnLogOverflowNote(overflowText, storage)).toBe("");
  });

  it("「持ち帰れなかった」の句が無ければ注記を付けない(あふれが無いログ)", () => {
    const storage = storageParams(new Map([[id("firewood"), fixFromRaw(500_000)]]));
    expect(returnLogOverflowNote("報酬 firewood 175。", storage)).toBe("");
  });

  it("storage 定義自体が無い盤面(廃材機構が不活性)では注記を付けない", () => {
    expect(returnLogOverflowNote(overflowText, undefined)).toBe("");
  });
});
