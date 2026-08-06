// ---------------------------------------------------------------------------
// M51: scripts/content-semantics-gate.ts(additive 意味論 diff の機械強制)のテスト。
//
// content-diff-gate.mjs(M46)が git index の**構文**(symlink/非通常ファイル
// mode)だけを見るのに対し、本スクリプトは content/*.json の**値**を
// canonicalize 後の JSON 構造で比較する。git の base ref を必要とするため、
// 一時ディレクトリに実際の `git init` + `git commit` でフィクスチャリポジトリ
// を作り(content-diff-gate.test.ts と同じ流儀の一時リポジトリパターンを
// 踏襲しつつ、今回は base/head の2状態が要るため base 側だけコミットし、
// head 側は作業ツリーへ直接書く = 本スクリプトの設計そのもの)。
//
// 検収条件(ロードマップ M51 行)に対応する4本柱:
//   1. 既存IDの削除 reject
//   2. 既存IDのリネーム reject(削除+新規追加として検出されることを確認)
//   3. 既存IDの意味変更(型変更・構造変更)reject / 数値のみの変更(バランス
//      調整)は pass
//   4. tombstone逆参照チェック reject / 正当な tombstone・additive追加は pass
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../../src/engine/canonicalize";
import {
  collapseAdditiveBuildCostWidening,
  collectReferenceEdges,
  collectTombstonedIds,
  diffCategory,
  diffEntity,
  diffValueNonNumeric,
  findTombstoneReferenceViolations,
  hasViolations,
  ID_NAMESPACED_CATEGORIES,
  runContentSemanticsGate,
  TOMBSTONE_FIELD,
  type IdNamespacedCategory,
} from "../../scripts/content-semantics-gate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "content-semantics-gate.ts");
const TS_LOADER_ARGS = ["--experimental-strip-types", "--import", "./tools/tsLoaderRegister.mjs"];

const tempDirs: string[] = [];

function runGit(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} が失敗しました: ${result.stderr}`);
  }
  return result;
}

function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "content-semantics-gate-fixture-"));
  tempDirs.push(dir);
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

const ALL_CATEGORIES = ["tech", "facility", "trait", "event", "outpostType"] as const;

interface CategoryFixtures {
  readonly tech?: readonly unknown[];
  readonly facility?: readonly unknown[];
  readonly trait?: readonly unknown[];
  readonly event?: readonly unknown[];
  readonly outpostType?: readonly unknown[];
  readonly balance?: unknown;
  /** このカテゴリのファイル自体を書かない(「base に未実装カテゴリ」の再現用)。 */
  readonly omit?: readonly (typeof ALL_CATEGORIES)[number][];
}

/** content/ 配下のフィクスチャファイルを書く(作業ツリーへの直書き)。 */
function writeFixtures(dir: string, fixtures: CategoryFixtures): void {
  const contentDir = path.join(dir, "content");
  mkdirSync(contentDir, { recursive: true });
  for (const category of ALL_CATEGORIES) {
    if (fixtures.omit?.includes(category)) continue;
    const entities = fixtures[category] ?? [];
    writeFileSync(
      path.join(contentDir, `${category}.json`),
      `${JSON.stringify(entities, null, 2)}\n`,
      "utf8",
    );
  }
  if (fixtures.balance !== undefined) {
    writeFileSync(
      path.join(contentDir, "balance.json"),
      `${JSON.stringify(fixtures.balance, null, 2)}\n`,
      "utf8",
    );
  }
}

function commitAll(dir: string, message: string): string {
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", message]);
  return runGit(dir, ["rev-parse", "HEAD"]).stdout.trim();
}

/** base をコミットしてから head を作業ツリーへ直書きする、本スクリプト向けの標準セットアップ。 */
function setupBaseAndHead(
  baseFixtures: CategoryFixtures,
  headFixtures: CategoryFixtures,
): { readonly dir: string; readonly baseRef: string } {
  const dir = makeFixtureRepo();
  writeFixtures(dir, baseFixtures);
  const baseRef = commitAll(dir, "base");
  writeFixtures(dir, headFixtures);
  return { dir, baseRef };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 純関数の単体テスト(git 不要)
// ---------------------------------------------------------------------------

describe("diffValueNonNumeric", () => {
  it("数値 vs 数値はどれだけ違っても差分パスを出さない", () => {
    const out: string[] = [];
    diffValueNonNumeric(100, 999999, "$.researchCost", out);
    expect(out).toEqual([]);
  });

  it("文字列の変化は差分として報告する", () => {
    const out: string[] = [];
    diffValueNonNumeric("a", "b", "$.era", out);
    expect(out).toEqual(["$.era"]);
  });

  it("型が変わる(number → string)と差分として報告する", () => {
    const out: string[] = [];
    diffValueNonNumeric(100, "100", "$.researchCost", out);
    expect(out).toEqual(["$.researchCost"]);
  });

  it("配列長が変わると差分として報告する(要素ごとの再帰はしない)", () => {
    const out: string[] = [];
    diffValueNonNumeric([1, 2], [1, 2, 3], "$.prereqs", out);
    expect(out).toEqual(["$.prereqs"]);
  });

  it("配列は要素ごとに再帰し、数値要素の変化だけなら差分を出さない", () => {
    const out: string[] = [];
    diffValueNonNumeric([1, 2, 3], [10, 20, 30], "$.lvCurve", out);
    expect(out).toEqual([]);
  });

  it("オブジェクトのキー集合が変わると差分として報告する", () => {
    const out: string[] = [];
    diffValueNonNumeric({ a: 1 }, { a: 1, b: 2 }, "$", out);
    expect(out).toEqual(["$"]);
  });

  it("ネストしたオブジェクトの数値だけの変化は差分を出さない", () => {
    const out: string[] = [];
    diffValueNonNumeric(
      { fieldRequirement: { facility: "forge", count: 1 } },
      { fieldRequirement: { facility: "forge", count: 5 } },
      "$",
      out,
    );
    expect(out).toEqual([]);
  });
});

describe("diffEntity", () => {
  it("完全に同一なら unchanged", () => {
    const e = { id: "techA", researchCost: 100 };
    expect(diffEntity("techA", e, e).status).toBe("unchanged");
  });

  it("数値のみの変更は numericTuning", () => {
    const diff = diffEntity(
      "techA",
      { id: "techA", researchCost: 100 },
      { id: "techA", researchCost: 150 },
    );
    expect(diff.status).toBe("numericTuning");
  });

  it("非数値フィールドの変更は semanticChange", () => {
    const diff = diffEntity("techA", { id: "techA", era: "e1" }, { id: "techA", era: "e2" });
    expect(diff.status).toBe("semanticChange");
    expect(diff.changedPaths).toContain("$.era");
  });

  it("tombstoned: false→true(単独)は newlyTombstoned", () => {
    const diff = diffEntity(
      "techA",
      { id: "techA", researchCost: 100 },
      { id: "techA", researchCost: 100, [TOMBSTONE_FIELD]: true },
    );
    expect(diff.status).toBe("newlyTombstoned");
  });

  it("tombstoned化と同時の非数値変更は semanticChange(抱き合わせ密輸の禁止)", () => {
    const diff = diffEntity(
      "techA",
      { id: "techA", era: "e1" },
      { id: "techA", era: "e2", [TOMBSTONE_FIELD]: true },
    );
    expect(diff.status).toBe("semanticChange");
  });

  it("tombstoned: true→false(復活)は resurrected", () => {
    const diff = diffEntity(
      "techA",
      { id: "techA", [TOMBSTONE_FIELD]: true },
      { id: "techA", [TOMBSTONE_FIELD]: false },
    );
    expect(diff.status).toBe("resurrected");
  });
});

// ---------------------------------------------------------------------------
// [M65] §3b: buildCost の単一形 → 複数資源形の拡幅を additive として認識する。
// 「新形式の認識」であって判定基準の緩和ではないこと(既存行が保存されている
// ときだけ通り、書き換え/削除は従来どおり reject されること)を固定する。
// ---------------------------------------------------------------------------

describe("[M65] buildCost 拡幅の additive 認識(§3b)", () => {
  const singleForm = {
    id: "forge",
    buildCost: { amount: 25, resourceId: "clay" },
    upgradeCostCurve: [30, 36, 43, 52, 62],
  };

  it("第1行を保存したままコスト行を足すのは additive(unchanged 扱い)", () => {
    const diff = diffEntity("forge", singleForm, {
      id: "forge",
      buildCost: [
        { amount: 25, resourceId: "clay" },
        { amount: 6, resourceId: "charcoal", upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(diff.status).toBe("unchanged");
    expect(diff.changedPaths).toEqual([]);
  });

  it("拡幅と同時の数値調整は numericTuning(GDD 12.5-8 の範囲内)", () => {
    const diff = diffEntity("forge", singleForm, {
      id: "forge",
      buildCost: [
        { amount: 20, resourceId: "clay" },
        { amount: 6, resourceId: "charcoal", upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(diff.status).toBe("numericTuning");
  });

  it("第1行の資源を書き換える拡幅は従来どおり semanticChange", () => {
    const diff = diffEntity("forge", singleForm, {
      id: "forge",
      buildCost: [
        { amount: 25, resourceId: "charcoal" },
        { amount: 6, resourceId: "clay", upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    });
    expect(diff.status).toBe("semanticChange");
    expect(diff.changedPaths).toContain("$.buildCost");
  });

  it("配列形 → 単一形(行の削除)は semanticChange", () => {
    const arrayForm = {
      id: "forge",
      buildCost: [
        { amount: 25, resourceId: "clay" },
        { amount: 6, resourceId: "charcoal", upgradeCostCurve: [7, 8, 10, 12, 14] },
      ],
      upgradeCostCurve: [30, 36, 43, 52, 62],
    };
    expect(diffEntity("forge", arrayForm, singleForm).status).toBe("semanticChange");
  });

  it("buildCost 以外のフィールドの object → array 変化は畳まない", () => {
    const diff = diffEntity(
      "forge",
      { id: "forge", output: { kind: "resource" } },
      { id: "forge", output: [{ kind: "resource" }] },
    );
    expect(diff.status).toBe("semanticChange");
  });

  it("collapseAdditiveBuildCostWidening は畳めない入力を素通しする(純関数)", () => {
    const head = { id: "forge", buildCost: [{ amount: 25, resourceId: "charcoal" }] };
    expect(collapseAdditiveBuildCostWidening(singleForm, head)).toBe(head);
  });
});

describe("diffCategory", () => {
  it("新規ID追加のみは addedIds に載り違反系配列は空", () => {
    const result = diffCategory(
      "tech",
      [{ id: "techA", researchCost: 100 }],
      [
        { id: "techA", researchCost: 100 },
        { id: "techB", researchCost: 50 },
      ],
    );
    expect(result.addedIds).toEqual(["techB"]);
    expect(result.deletedIds).toEqual([]);
    expect(result.semanticChangeViolations).toEqual([]);
  });

  it("既存IDが head から消えると deletedIds に載る", () => {
    const result = diffCategory("tech", [{ id: "techA" }, { id: "techB" }], [{ id: "techB" }]);
    expect(result.deletedIds).toEqual(["techA"]);
  });
});

describe("collectReferenceEdges / collectTombstonedIds / findTombstoneReferenceViolations", () => {
  function emptyHeadByCategory(): Map<IdNamespacedCategory, readonly JsonValue[]> {
    const map = new Map<IdNamespacedCategory, readonly JsonValue[]>();
    for (const category of ID_NAMESPACED_CATEGORIES) map.set(category, []);
    return map;
  }

  it("tech.prereqs / unlocks / fieldRequirement.facility を参照エッジとして拾う", () => {
    const headByCategory = emptyHeadByCategory();
    headByCategory.set("tech", [
      {
        id: "techB",
        prereqs: ["techA"],
        unlocks: ["techC"],
        fieldRequirement: { facility: "forge" },
      },
    ]);
    const edges = collectReferenceEdges(headByCategory, null);
    expect(edges).toContainEqual({ from: "tech.techB.prereqs[0]", targetId: "techA" });
    expect(edges).toContainEqual({ from: "tech.techB.unlocks[0]", targetId: "techC" });
    expect(edges).toContainEqual({
      from: "tech.techB.fieldRequirement.facility",
      targetId: "forge",
    });
  });

  it("balance の memoryKeeperTraitId / eras.gateTechId / recordMedia.printingTechId を拾う", () => {
    const headByCategory = emptyHeadByCategory();
    const balance: JsonValue = {
      recallRiskParams: { memoryKeeperTraitId: "traitX" },
      eras: [{ id: "e1", gateTechId: "techStorage" }],
      recordMedia: { printingTechId: "techPrinting" },
    };
    const edges = collectReferenceEdges(headByCategory, balance);
    expect(edges).toContainEqual({
      from: "balance.recallRiskParams.memoryKeeperTraitId",
      targetId: "traitX",
    });
    expect(edges).toContainEqual({ from: "balance.eras[0].gateTechId", targetId: "techStorage" });
    expect(edges).toContainEqual({
      from: "balance.recordMedia.printingTechId",
      targetId: "techPrinting",
    });
  });

  it("tombstoned:true の ID を全カテゴリ横断で集める", () => {
    const headByCategory = emptyHeadByCategory();
    headByCategory.set("tech", [{ id: "techA", tombstoned: true }, { id: "techB" }]);
    headByCategory.set("trait", [{ id: "traitX", tombstoned: true }]);
    const ids = collectTombstonedIds(headByCategory);
    expect([...ids].sort()).toEqual(["techA", "traitX"]);
  });

  it("tombstone化されたIDへの参照は violation として検出、無関係な参照は無視する", () => {
    const violations = findTombstoneReferenceViolations(
      [
        { from: "tech.techB.prereqs[0]", targetId: "techA" },
        { from: "tech.techC.prereqs[0]", targetId: "techZ" },
      ],
      new Set(["techA"]),
    );
    expect(violations).toEqual([{ from: "tech.techB.prereqs[0]", tombstonedId: "techA" }]);
  });
});

// ---------------------------------------------------------------------------
// runContentSemanticsGate — 一時 git リポジトリのフィクスチャによる統合テスト
// ---------------------------------------------------------------------------

describe("runContentSemanticsGate — additive のみ(pass)", () => {
  it("新規IDの追加だけなら違反ゼロ", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", researchCost: 100 }] },
      {
        tech: [
          { id: "techA", researchCost: 100 },
          { id: "techB", researchCost: 50 },
        ],
      },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(false);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.addedIds).toEqual(["techB"]);
  });

  it("既存IDの数値のみの変更(バランス調整)は違反ゼロ", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", researchCost: 100, lvCurve: [1, 2, 3] }] },
      { tech: [{ id: "techA", researchCost: 150, lvCurve: [10, 20, 30] }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(false);
  });

  it("base に無いカテゴリファイル(新規カテゴリ追加)は全件 addedIds として通る", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { omit: ["outpostType"] },
      { outpostType: [{ id: "outpostA", resource: "clay" }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(false);
    const outpostDiff = result.categories.find((c) => c.category === "outpostType");
    expect(outpostDiff?.addedIds).toEqual(["outpostA"]);
  });

  it("正当な tombstone 化(単独)+ 無関係な参照は違反ゼロ", () => {
    const { dir, baseRef } = setupBaseAndHead(
      {
        tech: [
          { id: "techA", researchCost: 100 },
          { id: "techB", researchCost: 50 },
        ],
      },
      {
        tech: [
          { id: "techA", researchCost: 100, [TOMBSTONE_FIELD]: true },
          { id: "techB", researchCost: 50 },
        ],
      },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(false);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.newlyTombstonedIds).toEqual(["techA"]);
  });
});

describe("runContentSemanticsGate — 検収条件1: 既存IDの削除 reject", () => {
  it("既存IDが配列ごと消えると reject される", () => {
    const { dir, baseRef } = setupBaseAndHead(
      {
        tech: [
          { id: "techA", researchCost: 100 },
          { id: "techB", researchCost: 50 },
        ],
      },
      { tech: [{ id: "techB", researchCost: 50 }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.deletedIds).toEqual(["techA"]);
  });

  it("カテゴリファイルが丸ごと削除されると全既存IDが削除として reject される", () => {
    const { dir, baseRef } = setupBaseAndHead({ trait: [{ id: "traitX" }, { id: "traitY" }] }, {});
    // `omit` はフィクスチャを「書かない」だけで、base コミット由来の既存ファイルを
    // 消しはしない。ここは「head で丸ごと削除された」実態を再現するため、
    // base コミット後の作業ツリーから実際にファイルを消す。
    rmSync(path.join(dir, "content", "trait.json"));
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const traitDiff = result.categories.find((c) => c.category === "trait");
    expect([...(traitDiff?.deletedIds ?? [])].sort()).toEqual(["traitX", "traitY"]);
  });
});

describe("runContentSemanticsGate — 検収条件2: リネーム reject(削除+新規追加として検出)", () => {
  it("旧IDを消して類似の新IDを足しても、旧IDの消失自体が reject される", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techForge", researchCost: 100, era: "e1" }] },
      { tech: [{ id: "techForgeV2", researchCost: 100, era: "e1" }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.deletedIds).toEqual(["techForge"]);
    expect(techDiff?.addedIds).toEqual(["techForgeV2"]);
  });
});

describe("runContentSemanticsGate — 検収条件3: 意味変更(型/構造)reject", () => {
  it("既存IDのフィールド型変更は reject される", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", researchCost: 100 }] },
      { tech: [{ id: "techA", researchCost: "100" }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.semanticChangeViolations.map((v) => v.id)).toEqual(["techA"]);
  });

  it("既存IDの配列長変化(構造変更)は reject される(GDD 12.4: 既存entityのprereqs改変禁止)", () => {
    const { dir, baseRef } = setupBaseAndHead(
      {
        tech: [
          { id: "techA", prereqs: [] },
          { id: "techB", prereqs: [] },
        ],
      },
      {
        tech: [
          { id: "techA", prereqs: ["techB"] },
          { id: "techB", prereqs: [] },
        ],
      },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.semanticChangeViolations.map((v) => v.id)).toEqual(["techA"]);
  });

  it("tombstone化と同時の非数値フィールド変更は reject される(抱き合わせ密輸の禁止)", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", era: "e1" }] },
      { tech: [{ id: "techA", era: "e2", [TOMBSTONE_FIELD]: true }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
  });

  it("tombstone の復活(true→false)は reject される", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", [TOMBSTONE_FIELD]: true }] },
      { tech: [{ id: "techA", [TOMBSTONE_FIELD]: false }] },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    const techDiff = result.categories.find((c) => c.category === "tech");
    expect(techDiff?.resurrectedIds).toEqual(["techA"]);
  });
});

describe("runContentSemanticsGate — 検収条件4: tombstone逆参照チェック", () => {
  it("tombstone化されたtechをprereqsで参照し続けるtechがあればrejectされる", () => {
    const { dir, baseRef } = setupBaseAndHead(
      {
        tech: [
          { id: "techA", researchCost: 100 },
          { id: "techB", researchCost: 100, prereqs: ["techA"] },
        ],
      },
      {
        tech: [
          { id: "techA", researchCost: 100, [TOMBSTONE_FIELD]: true },
          { id: "techB", researchCost: 100, prereqs: ["techA"] },
        ],
      },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    expect(result.tombstoneReferenceViolations).toContainEqual({
      from: "tech.techB.prereqs[0]",
      tombstonedId: "techA",
    });
  });

  it("tombstone化されたtechをunlocksで参照し続けるtechがあればrejectされる(GDD 12.5-3)", () => {
    const { dir, baseRef } = setupBaseAndHead(
      {
        tech: [
          { id: "techA", researchCost: 100 },
          { id: "techB", researchCost: 100, unlocks: ["techA"] },
        ],
      },
      {
        tech: [
          { id: "techA", researchCost: 100, [TOMBSTONE_FIELD]: true },
          { id: "techB", researchCost: 100, unlocks: ["techA"] },
        ],
      },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    expect(result.tombstoneReferenceViolations).toContainEqual({
      from: "tech.techB.unlocks[0]",
      tombstonedId: "techA",
    });
  });

  it("tombstone化されたtraitをbalance.recallRiskParams.memoryKeeperTraitIdが参照し続ければrejectされる", () => {
    const balance = { recallRiskParams: { memoryKeeperTraitId: "traitX" } };
    const { dir, baseRef } = setupBaseAndHead(
      { trait: [{ id: "traitX" }], balance },
      { trait: [{ id: "traitX", [TOMBSTONE_FIELD]: true }], balance },
    );
    const result = runContentSemanticsGate(dir, "content", baseRef);
    expect(hasViolations(result)).toBe(true);
    expect(result.tombstoneReferenceViolations).toContainEqual({
      from: "balance.recallRiskParams.memoryKeeperTraitId",
      tombstonedId: "traitX",
    });
  });
});

// ---------------------------------------------------------------------------
// 現行リポジトリでの回帰確認(content-diff-gate.test.ts と同じ流儀)
// ---------------------------------------------------------------------------

describe("runContentSemanticsGate — 現行リポジトリでの回帰確認", () => {
  it("実content(現行 content/*.json)を base=HEAD で比較すると偽陽性ゼロ", () => {
    const result = runContentSemanticsGate(REPO_ROOT, "content", "HEAD");
    expect(hasViolations(result)).toBe(false);
    expect(result.categories).toHaveLength(ID_NAMESPACED_CATEGORIES.length);
  });
});

// ---------------------------------------------------------------------------
// CLI(spawn) — node --experimental-strip-types scripts/content-semantics-gate.ts
// ---------------------------------------------------------------------------

describe("CLI(spawn) — node scripts/content-semantics-gate.ts", () => {
  it("CONTENT_SEMANTICS_GATE_BASE 未設定なら非ゼロ終了しエラーを出す", () => {
    const env = { ...process.env };
    delete env.CONTENT_SEMANTICS_GATE_BASE;
    const result = spawnSync(process.execPath, [...TS_LOADER_ARGS, SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CONTENT_SEMANTICS_GATE_BASE");
  });

  it("現行リポジトリを base=HEAD で比較すると0終了しOKを出す", () => {
    const env = { ...process.env, CONTENT_SEMANTICS_GATE_BASE: "HEAD" };
    const result = spawnSync(process.execPath, [...TS_LOADER_ARGS, SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("既存IDを削除したフィクスチャは非ゼロ終了し理由をstderrへ出す", () => {
    const { dir, baseRef } = setupBaseAndHead(
      { tech: [{ id: "techA", researchCost: 100 }] },
      { tech: [] },
    );
    const env = {
      ...process.env,
      CONTENT_SEMANTICS_GATE_ROOT: dir,
      CONTENT_SEMANTICS_GATE_BASE: baseRef,
    };
    const result = spawnSync(process.execPath, [...TS_LOADER_ARGS, SCRIPT_PATH], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("techA");
    expect(result.stderr).toContain("削除");
  });
});
