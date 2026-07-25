import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// engine 純粋性 lint の回帰テスト。
//
// eslint.config.js は「決定論critical の線引き」を保持する唯一の場所であり、
// その線引きが静かに崩れること(engine ルールが発火しなくなる / 免除が広がる)は
// ADR 残余リスク#10 そのものである。このテストはその検出器として、
//   (1) 禁止事項ごとに違反断片が必ずエラーになること
//   (2) 許可されている書き方(Math 許可リスト・配列スプレッド等)がエラーに
//       ならないこと
//   (3) 単一正準実装ファイルの免除が「外したルールだけ」に留まること
//   (4) engine 外では engine ルールが一切発火しないこと
// を実際の ESLint 実行で検証する。
// ---------------------------------------------------------------------------

// パスはすべてリポジトリルート相対。ESLint は cwd(= vitest のプロジェクトルート)
// を基準に解決する。node の path/url を使わないのは engine と同様に依存を増やさない
// ため(@types/node を持ち込まない)。
const eslint = new ESLint({ overrideConfigFile: "eslint.config.js" });

const ENGINE_FILE = "src/engine/rules/production.ts";

async function lint(code: string, relativePath: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: relativePath, warnIgnored: false });
  return result?.messages ?? [];
}

async function errorsOf(code: string, relativePath: string): Promise<Linter.LintMessage[]> {
  const messages = await lint(code, relativePath);
  const fatal = messages.filter((m) => m.fatal);
  // パースに失敗した断片は「エラーになった」ことにならない。先に潰す。
  expect(fatal.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  return messages.filter((m) => m.severity === 2);
}

async function ruleIdsOf(code: string, relativePath: string): Promise<(string | null)[]> {
  return (await errorsOf(code, relativePath)).map((m) => m.ruleId);
}

async function expectClean(code: string, relativePath: string): Promise<void> {
  const errors = await errorsOf(code, relativePath);
  expect(errors.map((m) => `${m.ruleId}: ${m.message}`)).toEqual([]);
}

interface Case {
  readonly name: string;
  readonly code: string;
  readonly rule: string;
}

// --- (1) 禁止事項ごとの違反断片 -------------------------------------------

const VIOLATIONS: readonly Case[] = [
  // Math.random / Date.now / new Date()
  { name: "Math.random", code: "export const r = Math.random();", rule: "no-restricted-syntax" },
  { name: "Date.now", code: "export const t = Date.now();", rule: "no-restricted-globals" },
  { name: "new Date()", code: "export const d = new Date();", rule: "no-restricted-globals" },
  {
    name: "Date.parse",
    code: 'export const d = Date.parse("2026-01-01");',
    rule: "no-restricted-globals",
  },
  // ADR-006 Math 許可リスト外
  { name: "Math.pow", code: "export const p = Math.pow(2, 3);", rule: "no-restricted-syntax" },
  { name: "Math.exp", code: "export const e = Math.exp(1);", rule: "no-restricted-syntax" },
  { name: "Math.log", code: "export const l = Math.log(2);", rule: "no-restricted-syntax" },
  { name: "Math.sin", code: "export const s = Math.sin(1);", rule: "no-restricted-syntax" },
  { name: "Math.hypot", code: "export const h = Math.hypot(3, 4);", rule: "no-restricted-syntax" },
  { name: "Math.sqrt", code: "export const q = Math.sqrt(2);", rule: "no-restricted-syntax" },
  {
    name: "Math.PI(定数も許可リスト外)",
    code: "export const c = Math.PI;",
    rule: "no-restricted-syntax",
  },
  {
    name: "Math の動的プロパティ参照",
    code: 'export const f = (k: "floor") => Math[k];',
    rule: "no-restricted-syntax",
  },
  // DOM / ホスト API
  {
    name: "window",
    code: "export const w = () => window.innerWidth;",
    rule: "no-restricted-globals",
  },
  {
    name: "document",
    code: 'export const el = () => document.querySelector("#a");',
    rule: "no-restricted-globals",
  },
  {
    name: "navigator",
    code: "export const ua = () => navigator.userAgent;",
    rule: "no-restricted-globals",
  },
  {
    name: "localStorage",
    code: 'export const g = () => localStorage.getItem("save");',
    rule: "no-restricted-globals",
  },
  { name: "indexedDB", code: "export const db = indexedDB;", rule: "no-restricted-globals" },
  { name: "fetch", code: 'export const f = () => fetch("/x");', rule: "no-restricted-globals" },
  {
    name: "performance",
    code: "export const n = () => performance.now();",
    rule: "no-restricted-globals",
  },
  {
    name: "setTimeout",
    code: "export const s = () => setTimeout(() => 0, 1);",
    rule: "no-restricted-globals",
  },
  { name: "globalThis", code: "export const g = globalThis;", rule: "no-restricted-globals" },
  { name: "process", code: "export const p = process;", rule: "no-restricted-globals" },
  {
    name: "structuredClone",
    code: "export const c = (o: object) => structuredClone(o);",
    rule: "no-restricted-globals",
  },
  {
    name: "WeakRef(GC 観測)",
    code: "export const w = (o: object) => new WeakRef(o);",
    rule: "no-restricted-globals",
  },
  { name: "crypto", code: "export const c = crypto;", rule: "no-restricted-globals" },
  // Promise / async(engine は同期純関数のみ)
  {
    name: "Promise",
    code: "export const p = new Promise(() => undefined);",
    rule: "no-restricted-globals",
  },
  {
    name: "async 関数",
    code: "export async function f() { return 1; }",
    rule: "no-restricted-syntax",
  },
  {
    name: "await",
    code: "export async function f(x: number) { return await x; }",
    rule: "no-restricted-syntax",
  },
  {
    name: "動的 import",
    code: 'export const load = () => import("./fp");',
    rule: "no-restricted-syntax",
  },
  // ADR-010 localeCompare
  {
    name: "localeCompare",
    code: "export const cmp = (a: string, b: string) => a.localeCompare(b);",
    rule: "no-restricted-syntax",
  },
  {
    name: "toLocaleString",
    code: "export const s = (n: number) => n.toLocaleString();",
    rule: "no-restricted-syntax",
  },
  { name: "Intl", code: "export const c = new Intl.Collator();", rule: "no-restricted-globals" },
  // ADR-023(2) content 直接走査
  {
    name: "Object.keys",
    code: "export const k = (o: object) => Object.keys(o);",
    rule: "no-restricted-properties",
  },
  {
    name: "Object.entries",
    code: "export const e = (o: object) => Object.entries(o);",
    rule: "no-restricted-properties",
  },
  {
    name: "Object.values",
    code: "export const v = (o: object) => Object.values(o);",
    rule: "no-restricted-properties",
  },
  {
    name: "Reflect.ownKeys",
    code: "export const k = (o: object) => Reflect.ownKeys(o);",
    rule: "no-restricted-properties",
  },
  {
    name: "for-in",
    code: "export function f(o: Record<string, number>) { for (const k in o) { void k; } }",
    rule: "no-restricted-syntax",
  },
  // ADR-028 構造共有 / Map↔JSON 単一経路
  {
    name: "オブジェクト生スプレッド",
    code: "export const c = (o: object) => ({ ...o });",
    rule: "no-restricted-syntax",
  },
  {
    name: "Object.assign",
    code: "export const c = (o: object) => Object.assign({}, o);",
    rule: "no-restricted-properties",
  },
  {
    name: "Object.fromEntries",
    code: "export const o = (m: Map<string, number>) => Object.fromEntries(m);",
    rule: "no-restricted-properties",
  },
  {
    name: "delete",
    code: "export function d(o: Record<string, number>) { delete o.a; }",
    rule: "no-restricted-syntax",
  },
  // ADR-024(2) domainTag レジストリ
  {
    name: "domainTag に生リテラル(プロパティ)",
    code: 'export const cfg = { domainTag: "exploration" };',
    rule: "no-restricted-syntax",
  },
  {
    name: "domainTag に生リテラル(変数)",
    code: 'export const domainTag = "exploration";',
    rule: "no-restricted-syntax",
  },
  {
    name: "domainTag に生リテラル(代入)",
    code: 'export function set(o: { domainTag: string }) { o.domainTag = "raid"; }',
    rule: "no-restricted-syntax",
  },
  // engine 外からの import
  {
    name: "パッケージ import",
    code: 'import { signal } from "@preact/signals";\nexport const s = signal;',
    rule: "no-restricted-syntax",
  },
  {
    name: "bare import",
    code: 'import jsep from "jsep";\nexport const j = jsep;',
    rule: "no-restricted-syntax",
  },
  {
    name: "node: import",
    code: 'import fs from "node:fs";\nexport const f = fs;',
    rule: "no-restricted-syntax",
  },
  {
    name: "非相対 re-export",
    code: 'export { signal } from "@preact/signals";',
    rule: "no-restricted-syntax",
  },
  {
    name: "外側レイヤー(platform)への相対 import",
    code: 'import { save } from "../platform/persistence";\nexport const s = save;',
    rule: "@typescript-eslint/no-restricted-imports",
  },
  {
    name: "外側レイヤー(ui)への相対 import",
    code: 'import { store } from "../../ui/store";\nexport const s = store;',
    rule: "@typescript-eslint/no-restricted-imports",
  },
  // その他の副作用 / 実行時コード生成
  {
    name: "console",
    code: "export function log(x: number) { console.log(x); }",
    rule: "no-console",
  },
  { name: "eval", code: 'export const e = eval("1");', rule: "no-eval" },
  { name: "new Function", code: 'export const f = new Function("return 1");', rule: "no-new-func" },
];

describe("engine 純粋性: 違反は必ずエラーになる", () => {
  for (const { name, code, rule } of VIOLATIONS) {
    it(`${name} → ${rule}`, async () => {
      expect(await ruleIdsOf(code, ENGINE_FILE)).toContain(rule);
    });
  }
});

// --- (2) 許可されている書き方はエラーにならない ----------------------------

const ALLOWED: readonly { readonly name: string; readonly code: string }[] = [
  {
    name: "Math 許可リスト 8 関数(ADR-006)",
    code: [
      "export const clampTick = (t: number): number => Math.max(0, Math.min(4320, Math.trunc(t)));",
      "export const norm = (a: number): number =>",
      "  Math.abs(a) + Math.sign(a) + Math.floor(a) + Math.ceil(a) + Math.round(a);",
    ].join("\n"),
  },
  {
    name: "配列スプレッド / 引数スプレッド(構造共有と無関係)",
    code: [
      "export function copy(xs: readonly number[]): number[] { return [...xs]; }",
      "export function apply(f: (...n: number[]) => number, xs: number[]): number {",
      "  return f(...xs);",
      "}",
    ].join("\n"),
  },
  {
    name: "配列の in-place 交換(離散事象ヒープ・ADR-008)",
    code: [
      "export function swap(xs: number[], i: number, j: number): void {",
      "  const t = xs[i] as number;",
      "  xs[i] = xs[j] as number;",
      "  xs[j] = t;",
      "}",
    ].join("\n"),
  },
  {
    name: "Map 経由の参照と for-of",
    code: [
      "export function total(m: Map<string, number>): number {",
      "  let sum = 0;",
      "  for (const v of m.values()) sum += v;",
      "  return sum;",
      "}",
    ].join("\n"),
  },
  {
    name: "UTF-16 コードユニット比較器(localeCompare 不使用)",
    code: [
      "export function byId(ids: readonly string[]): string[] {",
      "  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));",
      "}",
    ].join("\n"),
  },
  {
    name: "engine 内相対 import",
    code: 'import { mulFix } from "../fp";\nexport const twice = (a: number) => mulFix(a, 2);',
  },
  {
    name: "engine 外からの型のみ import",
    code: [
      'import type { Snapshot } from "../../platform/persistence";',
      "export type S = Snapshot;",
    ].join("\n"),
  },
  {
    name: "レジストリ経由の domainTag",
    code: [
      'import { DOMAIN_TAGS } from "../rng/domainTags";',
      "export const cfg = { domainTag: DOMAIN_TAGS.exploration };",
    ].join("\n"),
  },
];

describe("engine 純粋性: 許可されている書き方は通る", () => {
  for (const { name, code } of ALLOWED) {
    it(name, async () => {
      await expectClean(code, ENGINE_FILE);
    });
  }
});

// --- (3) 単一正準実装ファイルの免除 ----------------------------------------

describe("単一正準実装ファイルの免除は必要最小限", () => {
  it("canonicalize.ts では Object.keys/entries を使える(ADR-023(1))", async () => {
    await expectClean(
      [
        "export function sortedKeys(o: Record<string, unknown>): string[] {",
        "  return Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));",
        "}",
      ].join("\n"),
      "src/engine/canonicalize.ts",
    );
  });

  it("canonicalize.ts でも Math.random / for-in は禁止のまま", async () => {
    expect(
      await ruleIdsOf("export const r = Math.random();", "src/engine/canonicalize.ts"),
    ).toContain("no-restricted-syntax");
    expect(
      await ruleIdsOf(
        "export function f(o: Record<string, number>) { for (const k in o) { void k; } }",
        "src/engine/canonicalize.ts",
      ),
    ).toContain("no-restricted-syntax");
  });

  it("state/update.ts では生スプレッド / Object.assign を使える(ADR-028(1))", async () => {
    await expectClean(
      [
        "export function updateEntity<T extends object>(e: T, patch: Partial<T>): T {",
        "  return Object.assign({ ...e }, patch);",
        "}",
      ].join("\n"),
      "src/engine/state/update.ts",
    );
  });

  it("state/update.ts でも Object.keys は禁止のまま", async () => {
    expect(
      await ruleIdsOf(
        "export const k = (o: object) => Object.keys(o);",
        "src/engine/state/update.ts",
      ),
    ).toContain("no-restricted-properties");
  });

  it("state/serialize.ts では Object.fromEntries / Object.entries を使える(ADR-028(2))", async () => {
    await expectClean(
      [
        "export function toSerializable(m: Map<string, number>): Record<string, number> {",
        "  return Object.fromEntries(m);",
        "}",
        "export function fromSerializable(o: Record<string, number>): Map<string, number> {",
        "  return new Map(Object.entries(o));",
        "}",
      ].join("\n"),
      "src/engine/state/serialize.ts",
    );
  });

  it("state/serialize.ts でも生スプレッドは禁止のまま", async () => {
    expect(
      await ruleIdsOf(
        "export const c = (o: object) => ({ ...o });",
        "src/engine/state/serialize.ts",
      ),
    ).toContain("no-restricted-syntax");
  });

  it("rng/domainTags.ts では domainTag の生リテラルを書ける(ADR-024(2))", async () => {
    await expectClean('export const domainTag = "exploration";', "src/engine/rng/domainTags.ts");
  });

  it("rng/domainTags.ts でも Date は禁止のまま", async () => {
    expect(
      await ruleIdsOf("export const t = Date.now();", "src/engine/rng/domainTags.ts"),
    ).toContain("no-restricted-globals");
  });
});

// --- (4) 線引き: engine 外に engine ルールを漏らさない ----------------------

const OUTSIDE_ENGINE_FILES = [
  "src/platform/clock.ts",
  "src/ui/store.ts",
  "src/replay/replay.ts",
  "sim/runner.ts",
  "tools/manifest.ts",
  "tests/lint/sample.test.ts",
] as const;

const OUTSIDE_ENGINE_CODE = [
  'import { signal } from "@preact/signals";',
  "export const now = (): number => Date.now();",
  "export const rnd = (): number => Math.random();",
  "export const merge = (o: object): object => ({ ...o });",
  "export const keys = (o: object): string[] => Object.keys(o);",
  "export const s = signal;",
].join("\n");

describe("決定論critical の線引き", () => {
  for (const file of OUTSIDE_ENGINE_FILES) {
    it(`${file} には engine 純粋性ルールが適用されない`, async () => {
      await expectClean(OUTSIDE_ENGINE_CODE, file);
    });
  }

  it("engine では上記コードが複数の engine ルールで落ちる", async () => {
    const ruleIds = new Set(await ruleIdsOf(OUTSIDE_ENGINE_CODE, ENGINE_FILE));
    expect(ruleIds).toContain("no-restricted-globals");
    expect(ruleIds).toContain("no-restricted-syntax");
    expect(ruleIds).toContain("no-restricted-properties");
  });

  it("engine ルールは src/engine 配下でのみ有効化されている", async () => {
    const engineConfig = await eslint.calculateConfigForFile(ENGINE_FILE);
    const outsideConfig = await eslint.calculateConfigForFile("src/platform/clock.ts");
    for (const rule of [
      "no-restricted-globals",
      "no-restricted-properties",
      "no-restricted-syntax",
      "@typescript-eslint/no-restricted-imports",
      "no-console",
    ]) {
      // calculateConfigForFile は severity を数値へ正規化する(2 = error)。
      expect(engineConfig.rules[rule]?.[0], `engine: ${rule}`).toBe(2);
      expect(outsideConfig.rules[rule], `engine 外: ${rule}`).toBeUndefined();
    }
  });
});
