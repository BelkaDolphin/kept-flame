// ---------------------------------------------------------------------------
// M57: `src/ui/onboarding/glossaryTerms.ts` の内容テスト。
//
// 検収条件「用語説明がGDDの定義と矛盾しないこと」を完全に自動判定はできない
// (自然文の意味比較は機械検証の範囲外)が、機械で担保できる部分——
//   (a) タスク指示の10語が過不足なく揃っている
//   (b) 内部ID・GDD番号・丸数字・tick生値を出していない(束B/E/Fの掃討基準)
//   (c) 既存画面(ResidentsScreen/LossClassBadge/CodifyScreen)の言い回しと
//       矛盾しない(重要語の重なりで下支えする軽量チェック)
// は固定する。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GLOSSARY_TERMS } from "../../src/ui/onboarding/glossaryTerms";

const CIRCLED_NUMBER_PATTERN = /[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬]/;
const GDD_NUMBER_PATTERN = /GDD\s*\d/i;
/** 内部ID/英字enum値の生露出(タグ・距離帯・資源ID等)。 */
const INTERNAL_ID_PATTERN =
  /\b(criticalRecoverable|rareIrreversible|near|far|deep|firewood|clay|paper|waste|iron)\b/;
/** tick 生値らしき raw 数値(GDD 11.2/7.5 等で使われる大きな整数)。 */
const RAW_TICK_PATTERN = /\b(1440|4320|432000|60000)\b/;

describe("GLOSSARY_TERMS", () => {
  // [M73/R8-07] M57 の 10 語 + 「士気」= 11 語。士気(M72 で実際に動くように
  // なった値)は④住民一覧に出していなかったうえ辞典にも項目が無かった。
  it("M57 の10語 + 士気(計11語)が過不足なく揃っている", () => {
    expect(GLOSSARY_TERMS).toHaveLength(11);
    const ids = new Set(GLOSSARY_TERMS.map((entry) => entry.id));
    expect(ids.size).toBe(11);
  });

  it("(A)/(B)技術・成文化・想起困難・習熟・大移動・継承点・晴天漂着・保管上限/廃材・探索の距離帯を収録", () => {
    const terms = GLOSSARY_TERMS.map((entry) => entry.term).join("\n");
    expect(terms).toContain("(A)");
    expect(terms).toContain("(B)");
    expect(terms).toContain("成文化");
    expect(terms).toContain("想起困難");
    expect(terms).toContain("習熟");
    expect(terms).toContain("大移動");
    expect(terms).toContain("継承点");
    expect(terms).toContain("晴天漂着");
    expect(terms).toContain("保管上限");
    expect(terms).toContain("廃材");
    expect(terms).toContain("距離帯");
    expect(terms).toContain("士気");
  });

  it("プレイヤー語彙のみ(丸数字・GDD番号・内部ID・tick生値を出さない)", () => {
    for (const entry of GLOSSARY_TERMS) {
      const text = `${entry.term}${entry.definition}`;
      expect(CIRCLED_NUMBER_PATTERN.test(text)).toBe(false);
      expect(GDD_NUMBER_PATTERN.test(text)).toBe(false);
      expect(INTERNAL_ID_PATTERN.test(text)).toBe(false);
      expect(RAW_TICK_PATTERN.test(text)).toBe(false);
    }
  });

  it("各定義が空でなく、複数文になる程度の説明量を持つ", () => {
    for (const entry of GLOSSARY_TERMS) {
      expect(entry.definition.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("想起困難の説明が ResidentsScreen.tsx の既存文言と矛盾しない(重なりで下支え)", () => {
    const entry = GLOSSARY_TERMS.find((e) => e.id === "recallImpairment")!;
    const residentsScreenSource = readFileSync(
      "src/ui/screens/residents/ResidentsScreen.tsx",
      "utf8",
    );
    expect(residentsScreenSource).toContain("想起困難");
    expect(residentsScreenSource).toContain("時間が経てば回復");
    expect(entry.definition).toContain("時間が経つ");
    expect(entry.definition).toContain("回復");
  });

  it("(A)/(B)の説明が LossClassBadge.tsx のツールチップと矛盾しない(重なりで下支え)", () => {
    const techA = GLOSSARY_TERMS.find((e) => e.id === "techClassA")!;
    const techB = GLOSSARY_TERMS.find((e) => e.id === "techClassB")!;
    const badgeSource = readFileSync("src/ui/screens/LossClassBadge.tsx", "utf8");
    expect(badgeSource).toContain("条件が整えばもう一度取得できます");
    expect(badgeSource).toContain("二度と取り戻せません");
    expect(techA.definition).toContain("条件が整えば");
    expect(techA.definition).toContain("取得し直せる");
    expect(techB.definition).toContain("二度と取り戻せません");
  });
});
