import { describe, expect, it } from "vitest";

import {
  CanonicalizeError,
  canonicalizeJson,
  compareUtf16,
  type JsonValue,
} from "../../src/engine/canonicalize";

// ---------------------------------------------------------------------------
// content 正準化パス(ADR-023(1))の仕様固定テスト。
//
// 正準化の目的は「キー順序に暗黙依存するコードがあっても sim 結果が変わらない」
// 状態を作ることなので、検証の軸は次の 3 つになる:
//   (1) 順序独立性 — 同じ内容なら挿入順が違っても出力バイト列が同一
//   (2) 冪等性     — 2 回通しても 1 回と同じ
//   (3) 決定論的な拒否 — JSON で表現できない値を黙って通さない
//
// 「同じ出力か」の判定には JSON.stringify を使う。toEqual はキー順を見ないので
// 正準化の検証には使えない(順序が壊れても通ってしまう)。
// ---------------------------------------------------------------------------

/** キー順まで含めた同一性の判定。toEqual では順序差を検出できない。 */
function bytes(value: unknown): string {
  return JSON.stringify(value);
}

describe("compareUtf16", () => {
  it("UTF-16 コードユニット順で比較する(大文字が小文字より前)", () => {
    // "Z" = 0x5A < "a" = 0x61。ロケール依存の比較器(localeCompare)では
    // 言語によって "a" < "Z" になりうるので、ここを固定しておく。
    expect(compareUtf16("Z", "a")).toBeLessThan(0);
    expect(compareUtf16("a", "Z")).toBeGreaterThan(0);
  });

  it("等しい文字列では 0 を返す", () => {
    expect(compareUtf16("abc", "abc")).toBe(0);
    expect(compareUtf16("", "")).toBe(0);
  });

  it("空文字列は任意の非空文字列より前(接頭辞は本体より前)", () => {
    expect(compareUtf16("", "a")).toBeLessThan(0);
    expect(compareUtf16("ab", "abc")).toBeLessThan(0);
  });

  it("サロゲートペアはコードポイント順ではなくコードユニット順で並ぶ", () => {
    // U+1F600 は UTF-16 で 0xD83D 0xDE00。先頭コードユニット 0xD83D は
    // U+FFFD(0xFFFD)より小さいので、コードポイント値(0x1F600 > 0xFFFD)とは
    // 逆順になる。canonicalize.ts §2 が仕様として受け入れている性質。
    const emoji = "\u{1F600}";
    const replacement = "�";
    expect(emoji.charCodeAt(0)).toBe(0xd83d);
    expect(compareUtf16(emoji, replacement)).toBeLessThan(0);
    expect(emoji.codePointAt(0)).toBeGreaterThan(replacement.codePointAt(0) ?? 0);
  });

  it("非 ASCII でもコードユニット値の大小に一致する", () => {
    // "b" = 0x62 < "熱" = 0x71B1
    expect(compareUtf16("b", "熱")).toBeLessThan(0);
    // "熱" = 0x71B1 < "清" = 0x6E05 ではない(逆)。数値の大小そのもの。
    expect(compareUtf16("熱", "清")).toBeGreaterThan(0);
  });

  it("ソートの結果が JS 既定の文字列ソートと一致する(いずれもコードユニット順)", () => {
    const input = ["b", "Z", "a", "熱", "_x", "A1", "\u{1F600}", "�"];
    expect([...input].sort(compareUtf16)).toEqual([...input].sort());
  });
});

describe("canonicalizeJson: キー順の正準化", () => {
  it("オブジェクトのキーを UTF-16 コードユニット昇順に並べ替える", () => {
    const canonical = canonicalizeJson({ b: 1, a: 2, Z: 3, _x: 4 });
    expect(Object.keys(canonical)).toEqual(["Z", "_x", "a", "b"]);
  });

  it("挿入順の違う同一内容が同一バイト列になる(順序独立性)", () => {
    const first: JsonValue = {
      beta: { y: [1, { q: 1, p: 2 }], x: "s" },
      alpha: 1,
    };
    const second: JsonValue = {
      alpha: 1,
      beta: { x: "s", y: [1, { p: 2, q: 1 }] },
    };
    // 正準化前は違うバイト列(= テストが自明に通っていないことの確認)。
    expect(bytes(first)).not.toBe(bytes(second));
    expect(bytes(canonicalizeJson(first))).toBe(bytes(canonicalizeJson(second)));
  });

  it("入れ子のオブジェクト・配列内のオブジェクトも再帰的に並べ替える", () => {
    const canonical = canonicalizeJson({
      outer: { b: 1, a: { d: 1, c: 2 } },
      list: [{ n: 1, m: 2 }],
    });
    expect(bytes(canonical)).toBe('{"list":[{"m":2,"n":1}],"outer":{"a":{"c":2,"d":1},"b":1}}');
  });

  it("配列の順序は保持する(ソートしない)", () => {
    const canonical = canonicalizeJson({ xs: [3, 1, 2, "b", "a"] });
    expect(bytes(canonical)).toBe('{"xs":[3,1,2,"b","a"]}');
  });

  it("冪等: 2 回通しても 1 回通したものとバイト同一", () => {
    const source: JsonValue = { b: [{ z: 1, a: [{ n: 0, m: 1 }] }], a: { c: 1, b: 2 } };
    const once = canonicalizeJson(source);
    expect(bytes(canonicalizeJson(once))).toBe(bytes(once));
  });

  it("入力を破壊しない(元オブジェクトのキー順は変わらない)", () => {
    const source = { b: 1, a: 2 };
    const canonical = canonicalizeJson(source);
    expect(Object.keys(source)).toEqual(["b", "a"]);
    expect(canonical).not.toBe(source);
  });

  it("配列も新しい配列として返す", () => {
    const inner = [1, 2];
    const source = { xs: inner };
    const canonical = canonicalizeJson(source);
    expect(canonical.xs).not.toBe(inner);
    expect(canonical.xs).toEqual([1, 2]);
  });
});

describe("canonicalizeJson: 値の正規化", () => {
  it("-0 を +0 へ畳む(JSON 往復で符号が消えるため)", () => {
    const canonical = canonicalizeJson({ a: -0, nested: { b: [-0] } });
    expect(Object.is(canonical.a, 0)).toBe(true);
    expect(Object.is(canonical.a, -0)).toBe(false);
    const nested = canonical.nested as { readonly b: readonly number[] };
    expect(Object.is(nested.b[0], 0)).toBe(true);
  });

  it("通常の数値・文字列・真偽値・null はそのまま通す", () => {
    const source: JsonValue = { n: -1.5, s: "x", t: true, f: false, z: null };
    expect(bytes(canonicalizeJson(source))).toBe('{"f":false,"n":-1.5,"s":"x","t":true,"z":null}');
  });

  it("トップレベルのプリミティブもそのまま返す", () => {
    expect(canonicalizeJson(1)).toBe(1);
    expect(canonicalizeJson("a")).toBe("a");
    expect(canonicalizeJson(null)).toBe(null);
    expect(canonicalizeJson(true)).toBe(true);
  });

  it("プロトタイプ無しオブジェクト(Object.create(null))も受け付ける", () => {
    const source = Object.create(null) as Record<string, unknown>;
    source["b"] = 1;
    source["a"] = 2;
    expect(bytes(canonicalizeJson(source))).toBe('{"a":2,"b":1}');
  });

  it("シンボルキーは JSON.stringify と同様に無視する", () => {
    const source: Record<string | symbol, unknown> = { a: 1 };
    source[Symbol("hidden")] = 2;
    expect(bytes(canonicalizeJson(source))).toBe('{"a":1}');
  });
});

describe("canonicalizeJson: 拒否する入力", () => {
  it("NaN / ±Infinity を reject する(JSON.stringify が null へ潰すため)", () => {
    expect(() => canonicalizeJson({ a: Number.NaN })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: Number.NEGATIVE_INFINITY })).toThrow(CanonicalizeError);
  });

  it("undefined / function / symbol / bigint を reject する", () => {
    expect(() => canonicalizeJson(undefined)).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: undefined })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: () => 1 })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: Symbol("s") })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ a: 1n })).toThrow(CanonicalizeError);
  });

  it("Map / Set / Date / クラスインスタンスを reject する", () => {
    class Sample {
      readonly a = 1;
    }
    expect(() => canonicalizeJson({ m: new Map() })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ s: new Set() })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ d: new Date(0) })).toThrow(CanonicalizeError);
    expect(() => canonicalizeJson({ c: new Sample() })).toThrow(CanonicalizeError);
  });

  it("own property としての __proto__ キーを reject する", () => {
    // オブジェクトリテラルの __proto__ は prototype 指定として解釈され own
    // property にならないので、JSON.parse で own property を持つ値を作る。
    const source: unknown = JSON.parse('{"__proto__": 1, "a": 2}');
    expect(Object.keys(source as object)).toContain("__proto__");
    expect(() => canonicalizeJson(source)).toThrow(CanonicalizeError);
  });

  it("循環参照を(深さ上限で)止める", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(CanonicalizeError);
  });

  it("深すぎる入れ子を reject し、実用的な深さは通す", () => {
    const nest = (depth: number): JsonValue => {
      let value: JsonValue = 1;
      for (let i = 0; i < depth; i++) {
        value = { a: value };
      }
      return value;
    };
    expect(() => canonicalizeJson(nest(32))).not.toThrow();
    expect(() => canonicalizeJson(nest(200))).toThrow(CanonicalizeError);
  });

  it("エラーメッセージに違反箇所の path が入る", () => {
    expect(() => canonicalizeJson({ outer: { list: [1, Number.NaN] } })).toThrow(
      /\$\.outer\.list\[1\]/,
    );
  });
});
