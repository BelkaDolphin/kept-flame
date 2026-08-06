import { describe, expect, it } from "vitest";
import {
  DOMAIN_TAGS,
  assertUniqueDomainTags,
  type DomainTag,
} from "../../../src/engine/rng/domainTags";

// ---------------------------------------------------------------------------
// domainTags.ts: frozen レジストリの一意性強制(ADR-024(2))のテスト。
// ---------------------------------------------------------------------------

describe("DOMAIN_TAGS レジストリ本体", () => {
  it("exploration が登録されている", () => {
    expect(DOMAIN_TAGS.exploration).toBe("exploration");
  });

  it("Object.freezeで凍結されている", () => {
    expect(Object.isFrozen(DOMAIN_TAGS)).toBe(true);
  });

  it("凍結されたプロパティへの代入はstrict modeで例外になる", () => {
    expect(() => {
      // ESモジュールは常にstrict mode。frozenオブジェクトへの書き込みはTypeErrorになる。
      (DOMAIN_TAGS as { exploration: string }).exploration = "mutated";
    }).toThrow(TypeError);
  });
});

describe("assertUniqueDomainTags: ランタイムでの重複登録拒否(ADR-024(2))", () => {
  it("重複がなければ例外を投げない", () => {
    expect(() => assertUniqueDomainTags(["a", "b", "c"])).not.toThrow();
  });

  it("重複があれば例外を投げる", () => {
    expect(() => assertUniqueDomainTags(["a", "b", "a"])).toThrow(/registered more than once/);
  });

  it("隣接していない重複(先頭と末尾)も検出する", () => {
    expect(() => assertUniqueDomainTags(["exploration", "raid", "exploration"])).toThrow();
  });

  it("実際に登録されているDOMAIN_TAGSの値は重複していない(回帰)", () => {
    const values: string[] = [DOMAIN_TAGS.exploration];
    expect(() => assertUniqueDomainTags(values)).not.toThrow();
  });

  it("空配列は例外を投げない", () => {
    expect(() => assertUniqueDomainTags([])).not.toThrow();
  });
});

describe("型: レジストリ外のdomainTagは型エラーになる(ADR-024(2)、@ts-expect-error)", () => {
  it("レジストリに存在しない文字列はDomainTagへ代入できない", () => {
    // @ts-expect-error "siege" はDOMAIN_TAG_LIST(domainTags.ts)に未登録のため
    // DomainTag型へ代入できずコンパイルエラーになる。
    // [M66] 旧版はここで "raid" を未登録の例に使っていたが、M66 で襲撃の
    // seededRoll 用に "raid" が**実際に登録された**ため、未登録の例を差し替えた
    // (テストの主張「レジストリ外の文字列は代入できない」は不変)。
    const rejected: DomainTag = "siege";
    void rejected;
  });

  it("任意の生文字列(string型)もDomainTagへ代入できない", () => {
    const arbitrary: string = "exploration";
    // @ts-expect-error string型はDomainTag(リテラル型のunion)より広いため
    // 明示キャスト無しでは代入できない。
    const rejected: DomainTag = arbitrary;
    void rejected;
  });

  it("レジストリ内の値はDomainTagへ代入できる(対照テスト)", () => {
    const accepted: DomainTag = DOMAIN_TAGS.exploration;
    expect(accepted).toBe("exploration");
  });
});
