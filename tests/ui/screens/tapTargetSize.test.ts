// ---------------------------------------------------------------------------
// 44px 最小タップ領域の自動検査(M30 検収条件・GDD 6.6)。
//
// ===========================================================================
// なぜ CSS 静的解析なのか(jsdom / 実 DOM 計測ではなく)
// ===========================================================================
//   vitest は `environment: "node"` で jsdom を持たない(vite.config.ts・
//   ADR-001 依存最小)。jsdom は devDependencies に無く、CLAUDE.md の絶対
//   ルール(新規 npm 依存の追加禁止)によりここで追加もできない。M19 の
//   実 DOM マウント計測(`bench/gridMount.html`)は Playwright 経由の別ゲート
//   (`npm run bench:gridmount:e2e`)であり、`npm test`(このゲート)には
//   含まれない。
//
//   そこでこのテストは **CSS の静的解析 + 実際にレンダーした vnode の突合せ**
//   という構造的な代理検査を行う: (1) 対話可能要素(`<button>`/`<select>`)を
//   実際に GridCell/GridScreen/FacilityScreen/ResidentsScreen 等のコンポーネント
//   関数を直接呼んで vnode ツリーから収集し、(2) その要素の class に対応する
//   CSS 宣言(min-width/min-height、または width/height)を該当 .css ファイルから
//   正規表現でパースして、44px 以上であることを数値で確認する。
//   `gridConstants.ts` の `CELL_SIZE_PX * MIN_SCALE >= MIN_TAP_TARGET_PX` と
//   同じ「実測ではなく構造的保証」の系譜にある(M18 の設計判断を踏襲)。
//
// ===========================================================================
// 除外(根拠明記・CLAUDE.md「幻覚防止」への配慮)
// ===========================================================================
//   `width: 100%` / `height: 100%` の宣言は「親要素いっぱいに広がる」ことの
//   静的保証であり、実寸は親のレイアウトに依存するため px 数値では検証でき
//   ない。この場合は「その軸だけ」満たしているとみなす——M29 の
//   `.kf-badge`/`.kf-digest__row` が既にこの形(width:100%+min-height:44px)を
//   使っており、本テストが新しく持ち込む例外ではない(前例の追認)。
//   `.kf-tag-chip`(TagChip)は装飾用途(タップ不可・onClick を持たない)なので
//   対象に含めない——44px は「読み取りやすさ」の意匠であり GDD 6.6 の
//   「最小タップ領域」の対象ではないため。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FIX_ONE, FIX_ZERO } from "../../../src/engine/fp";
import { entityIdFromString } from "../../../src/engine/state/state";
import type {
  CellViewModel,
  FacilityCatalogEntry,
  FacilityDetailView,
  ReclaimInfo,
} from "../../../src/ui/derived";
import { GridCell } from "../../../src/ui/screens/grid/GridBoard";
import {
  FacilityCatalogButton,
  FacilityCatalogPanel,
  ReclaimPanel,
} from "../../../src/ui/screens/grid/GridScreen";
import {
  FacilityDetailPanel,
  FacilityPicker,
  FacilityWorkerRow,
} from "../../../src/ui/screens/facility/FacilityScreen";
import { ResidentRow } from "../../../src/ui/screens/residents/ResidentsScreen";
import type {
  CodifySuggestionView,
  CodifyTechEntry,
  ExpeditionCandidateView,
  FacilityRosterEntry,
  ResearchTreeEntry,
  ResidentView,
} from "../../../src/ui/derived";
import { UrgencyBadge } from "../../../src/ui/screens/home/HomeHub";
import { RejectionBanner } from "../../../src/ui/screens/RejectionBanner";
import { ScreenNav } from "../../../src/ui/AppShell";
import { NAV_GROUPS } from "../../../src/ui/navGroups";
import { ResearchTechRow } from "../../../src/ui/screens/research/ResearchScreen";
import { CodifySuggestionPanel, CodifyTechRow } from "../../../src/ui/screens/codify/CodifyScreen";
import {
  BandPicker,
  CandidateRow,
  DestinationPicker,
  StancePicker,
} from "../../../src/ui/screens/expedition/ExpeditionScreen";
import {
  ExodusCompletedNotice,
  ExodusCrewRow,
  ExodusRecordRow,
  type ExodusCrewOption,
  type ExodusRecordOption,
} from "../../../src/ui/screens/migration/MigrationScreen";
import { InheritTrackRow } from "../../../src/ui/screens/inheritance/InheritanceScreen";
import {
  ExportPanel,
  ImportPanel,
  ResetGameSection,
} from "../../../src/ui/screens/settings/SettingsScreen";
import { OutpostCard, OutpostEstablishForm } from "../../../src/ui/screens/outposts/OutpostsScreen";
import type { OutpostRosterEntry } from "../../../src/ui/derived";
import { BackupReminderBanner } from "../../../src/ui/BackupReminderBanner";
import { LoadFailureBanner } from "../../../src/ui/LoadFailureBanner";

const id = entityIdFromString;

// --- 1. CSS の静的パース(正規表現ベース・新規依存なし) ----------------------

interface CssDeclarations {
  readonly [property: string]: string;
}

/**
 * 単純な `セレクタ { プロパティ: 値; ... }` の並びだけを想定した最小パーサ。
 * 同じセレクタが複数回出てくる場合は**後勝ち**(実際の CSS のカスケードと同じ)。
 *
 * **[束A 追記]** レスポンシブ化(F-4 の 2 カラム / F-5 のヘッダ)で `@media` が
 * 入ったので前提が 1 つ変わった: ネストした `@media { .foo { … } }` に対しては、
 * 外側の `@media` 行はセレクタとして解釈されず(閉じ括弧が合わないため
 * マッチしない)、**内側の `.foo` だけが後勝ちで取り込まれる**。したがって
 * 「メディアクエリの中で 44px を下回る上書きをしたら検出される」側に倒れる
 * (見逃しではなく過検出側)ので、この検査器の保証は弱くならない。
 * `@supports`/CSS ネストは今も 1 つも無い。
 */
function parseCss(cssText: string): ReadonlyMap<string, CssDeclarations> {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const bySelector = new Map<string, CssDeclarations>();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(withoutComments)) !== null) {
    const selectorList = match[1] ?? "";
    const body = match[2] ?? "";
    const decls: Record<string, string> = {};
    for (const part of body.split(";")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      decls[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
    }
    for (const rawSelector of selectorList.split(",")) {
      const selector = rawSelector.trim();
      if (selector.length === 0) continue;
      const existing = bySelector.get(selector);
      bySelector.set(selector, existing === undefined ? decls : { ...existing, ...decls });
    }
  }
  return bySelector;
}

function readCss(relativePath: string): ReadonlyMap<string, CssDeclarations> {
  return parseCss(readFileSync(relativePath, "utf8"));
}

/** stylesheet 一式を 1 枚のセレクタ表へ統合する(このプロジェクトの CSS 全量)。 */
const ALL_RULES: ReadonlyMap<string, CssDeclarations> = new Map([
  ...readCss("src/ui/appShell.css"),
  ...readCss("src/ui/screens/grid/gridBoard.css"),
  ...readCss("src/ui/screens/facility/facilityScreen.css"),
  ...readCss("src/ui/screens/residents/residentsScreen.css"),
  // [M31]
  ...readCss("src/ui/screens/research/researchScreen.css"),
  ...readCss("src/ui/screens/codify/codifyScreen.css"),
  // [M32]
  ...readCss("src/ui/screens/expedition/expeditionScreen.css"),
  ...readCss("src/ui/screens/chronicle/chronicleScreen.css"),
  ...readCss("src/ui/screens/outposts/outpostsScreen.css"),
  // [M33]
  ...readCss("src/ui/screens/migration/migrationScreen.css"),
  ...readCss("src/ui/screens/inheritance/inheritanceScreen.css"),
  ...readCss("src/ui/screens/settings/settingsScreen.css"),
]);

function pxValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(raw.trim());
  if (match === null) return null;
  const digits = match[1];
  return digits === undefined ? null : Number(digits);
}

interface AxisCheck {
  readonly satisfied: boolean;
  readonly detail: string;
}

/** min-<axis>(無ければ <axis>)を見る。`100%` は「親いっぱい」として満たす扱い(前例あり・§ 除外)。 */
function checkAxis(decls: CssDeclarations, minProp: string, prop: string): AxisCheck {
  const min = pxValue(decls[minProp]);
  if (min !== null) {
    return { satisfied: min >= 44, detail: `${minProp}=${String(min)}px` };
  }
  const direct = decls[prop];
  if (direct !== undefined && direct.trim() === "100%") {
    return { satisfied: true, detail: `${prop}=100%(親いっぱい・前例あり)` };
  }
  const directPx = pxValue(direct);
  if (directPx !== null) {
    return { satisfied: directPx >= 44, detail: `${prop}=${String(directPx)}px` };
  }
  return { satisfied: false, detail: `${minProp}/${prop} とも px/100% で見つからない` };
}

/**
 * 1 個以上の class 名を実際の CSS カスケードと同じに**合成**してから
 * width/height を確認する。
 *
 * 実 DOM では `class="kf-catalog__button kf-catalog__button--active"` の
 * ような要素は両方のルールが同時に効く(修飾子クラスは色/枠だけを上書きし、
 * サイズは基底クラスが持つ、という設計がこのプロジェクト全体の規約)。
 * class を 1 個ずつ独立にチェックすると、修飾子クラス単体には
 * min-width/min-height が無い(意図的にそう書いていない)ため誤検出になる。
 */
function mergeDeclarations(classes: readonly string[]): CssDeclarations {
  let merged: Record<string, string> = {};
  for (const cls of classes) {
    const decls = ALL_RULES.get(`.${cls}`);
    if (decls !== undefined) merged = { ...merged, ...decls };
  }
  return merged;
}

/** class 名の集合(実際に 1 要素へ同時に付く class 一式)の 44px 保証を確認する。 */
function assertMinTapTargetForClasses(classes: readonly string[], label: string): void {
  expect(
    classes.length,
    `${label}: class が 1 つも無い(44px 検査の対象を特定できない)`,
  ).toBeGreaterThan(0);
  const knownClasses = classes.filter((cls) => ALL_RULES.has(`.${cls}`));
  expect(
    knownClasses.length,
    `${label}: class [${classes.join(", ")}] のいずれも CSS に無い`,
  ).toBeGreaterThan(0);
  const decls = mergeDeclarations(classes);
  const width = checkAxis(decls, "min-width", "width");
  const height = checkAxis(decls, "min-height", "height");
  expect(width.satisfied, `${label} の幅: ${width.detail}`).toBe(true);
  expect(height.satisfied, `${label} の高さ: ${height.detail}`).toBe(true);
}

/** 単一セレクタ(`.foo` の形)の 44px 保証を確認する薄いラッパ。 */
function assertMinTapTarget(selector: string): void {
  expect(selector.startsWith("."), `"${selector}" はクラスセレクタ("." 始まり)で渡すこと`).toBe(
    true,
  );
  assertMinTapTargetForClasses([selector.slice(1)], selector);
}

// --- 2. vnode ツリーから対話可能要素(button/select)の class を集める --------

interface InteractiveElement {
  readonly tag: string;
  readonly class: string;
}

function collectInteractive(node: unknown, out: InteractiveElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectInteractive(child, out);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown; readonly class?: string };
  };
  if (typeof vnode.type === "function") {
    collectInteractive((vnode.type as (props: unknown) => unknown)(vnode.props), out);
    return;
  }
  if (vnode.type === "button" || vnode.type === "select") {
    out.push({ tag: vnode.type, class: vnode.props?.class ?? "" });
  }
  collectInteractive(vnode.props?.children, out);
}

/**
 * 実際にレンダーした vnode から対話可能要素を集め、各要素が持つ class 一式
 * (= 実 DOM で同時に効くカスケード)に対して 44px を確認する。
 */
function assertAllInteractiveElementsMeetMinTapTarget(
  vnode: unknown,
): readonly InteractiveElement[] {
  const found: InteractiveElement[] = [];
  collectInteractive(vnode, found);
  expect(found.length).toBeGreaterThan(0);
  for (const element of found) {
    const classes = element.class.split(/\s+/).filter((c) => c.length > 0);
    assertMinTapTargetForClasses(classes, `<${element.tag} class="${element.class}">`);
  }
  return found;
}

// --- 3. セレクタ単体の検査(このプロジェクト全体の対話可能要素の一覧) --------

describe("44px 最小タップ領域(GDD 6.6)— CSS 静的検査", () => {
  const INTERACTIVE_SELECTORS = [
    // M29(既存・前例)
    ".kf-nav__button",
    // [束A] グループ展開時のサブ項目(5グループ集約・F-5)
    ".kf-nav__sub-button",
    ".kf-badge",
    ".kf-digest__row",
    ".kf-placeholder__back",
    // M18(既存・アルゴリズム的保証は gridGeometry.test.ts が別途固定。
    // ここでは CSS 側の下限フォールバックだけを確認する)。
    ".kf-cell",
    // [M30] 新規
    ".kf-catalog__button",
    ".kf-catalog__cancel",
    ".kf-reclaim__button",
    ".kf-grid-screen__to-facility",
    ".kf-facility-detail__upgrade-button",
    ".kf-facility-screen__nav-button",
    ".kf-residents-screen__nav-button",
    ".kf-resident-row__select",
    // [M31] 新規
    ".kf-research-row__start-button",
    ".kf-research-screen__nav-button",
    ".kf-codify-row__medium-select",
    ".kf-codify-row__enqueue-button",
    ".kf-codify-assist__apply-button",
    ".kf-codify-screen__nav-button",
    // [M32] 新規(⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理)
    ".kf-expedition__band-button",
    ".kf-expedition__destination-button",
    ".kf-expedition__stance-button",
    ".kf-expedition__candidate-button",
    ".kf-expedition__team-size-button",
    ".kf-expedition__suggest-button",
    ".kf-expedition__apply-button",
    ".kf-expedition__dispatch-button",
    ".kf-expedition-screen__nav-button",
    ".kf-chronicle-screen__nav-button",
    ".kf-outposts-screen__nav-button",
    // [M33] 新規(⑩大移動ナップサックUI/⑪継承点購入/＋セーブ・設定)
    ".kf-migration-screen__recommend-button",
    ".kf-migration-screen__execute-button",
    ".kf-migration__confirm-execute-button",
    ".kf-migration__confirm-cancel-button",
    ".kf-migration-screen__nav-button",
    ".kf-exodus__record-button",
    ".kf-exodus__crew-button",
    ".kf-exodus__completed-button",
    ".kf-inherit-row__button",
    ".kf-inheritance-screen__nav-button",
    ".kf-settings__export-button",
    ".kf-settings__import-button",
    ".kf-settings-screen__nav-button",
    // [束B/m-6] <label> はボタン/select ではないため collectInteractive の
    // 自動収集対象外(§2)。ここで明示的に静的検査へ加える。
    ".kf-settings__import-file-button",
    // [M54] 新規(⑥成文化キューの取消/⑨拠点操作/定期バックアップ・起動失敗
    // バナー/設定の最初からやり直す)
    ".kf-codify-row__cancel-button",
    ".kf-outpost-card__unstation-button",
    ".kf-outpost-card__station-select",
    ".kf-outpost-card__station-button",
    ".kf-outpost-card__abandon-button",
    ".kf-outposts-establish__type-select",
    ".kf-outposts-establish__band-button",
    ".kf-outposts-establish__resident-button",
    ".kf-outposts-establish__submit-button",
    ".kf-settings__reset-start-button",
    ".kf-settings__reset-proceed-button",
    ".kf-settings__reset-confirm-button",
    ".kf-settings__reset-cancel-button",
    // M34 由来だが本タスクで min-width を足し、44px 検査の対象へ加えた
    // (誘導バナー3種=Add-to-Home/通知/バックアップ・起動失敗の共有クラス)。
    ".kf-promo-banner__button",
  ] as const;

  it.each(INTERACTIVE_SELECTORS)("%s は 44px 角を満たす", (selector) => {
    assertMinTapTarget(selector);
  });
});

// --- 4. 実レンダーとの突合せ([M30] 新規画面の対話可能要素を実際に集める) ----

describe("44px 最小タップ領域 — 実際にレンダーした vnode との突合せ([M30])", () => {
  const catalogEntry: FacilityCatalogEntry = {
    defId: id("hearth"),
    tags: ["heat"],
    footprint: { width: 1, height: 1 },
    harshWork: false,
    outputKind: "resource",
    outputResourceId: id("firewood"),
    // [束B/B-4] derived.ts の建設コスト欄の追加に追随。
    buildCostApprox: null,
    buildCostResourceId: null,
  };

  it("FacilityCatalogPanel(カタログボタン+キャンセルボタン)", () => {
    const vnode = FacilityCatalogPanel({
      catalog: [catalogEntry],
      pendingDefId: catalogEntry.defId,
      resources: [],
      onPick: () => undefined,
      onCancel: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-catalog__button"))).toBe(true);
    expect(found.some((e) => e.class.includes("kf-catalog__cancel"))).toBe(true);
  });

  it("FacilityCatalogButton 単体", () => {
    const vnode = FacilityCatalogButton({
      entry: catalogEntry,
      active: false,
      insufficient: false,
      onPick: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });

  it("ReclaimPanel(開墾ボタン)", () => {
    const rubbleCell: CellViewModel = {
      cellIndex: 30,
      cellId: "c30",
      occupied: false,
      facilityId: null,
      defId: null,
      anchorCellIndex: null,
      tags: [],
      level: 0,
      workerCount: 0,
      multiplierFix: FIX_ONE,
      multiplierApprox: 1,
      bonusFix: FIX_ZERO,
      overcrowdPenaltyFix: FIX_ZERO,
      overcrowdedNeighborCount: 0,
      overcrowded: false,
      isRubble: true,
    };
    const info: ReclaimInfo = {
      available: true,
      nextCostApprox: 40,
      costResourceId: id("firewood"),
      availableStockApprox: 60,
      reclaimedCount: 0,
    };
    const vnode = ReclaimPanel({ cell: rubbleCell, info, onReclaim: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-reclaim__button"))).toBe(true);
  });

  it("FacilityDetailPanel(増築ボタン)", () => {
    const detail: FacilityDetailView = {
      facilityId: id("facHearth1"),
      defId: id("hearth"),
      cellIndex: 14,
      cellId: "c14",
      tags: ["heat"],
      level: 2,
      maxLevel: 5,
      slotsMax: null,
      workers: [],
      outputKind: "resource",
      outputResourceId: id("firewood"),
      outputPerTickApprox: 1.2,
      multiplierApprox: 1.2,
      // [束B/B-4] derived.ts の増築コスト欄の追加に追随。
      upgradeCostApprox: null,
      upgradeCostResourceId: null,
    };
    const vnode = FacilityDetailPanel({ detail, onUpgrade: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-facility-detail__upgrade-button"))).toBe(true);
  });

  it("[束B/m-1] FacilityPicker(未選択時の施設一覧ボタン)", () => {
    const roster: readonly FacilityRosterEntry[] = [
      {
        facilityId: id("facHearth1"),
        defId: id("hearth"),
        cellIndex: 14,
        cellId: "c14",
        level: 2,
        tags: ["heat"],
        workerIds: [],
        slotsMax: null,
      },
    ];
    const vnode = FacilityPicker({ roster, onPick: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-facility-picker__button"))).toBe(true);
  });

  it("FacilityWorkerRow は対話可能要素を持たない(表示専用)", () => {
    const found: InteractiveElement[] = [];
    collectInteractive(
      FacilityWorkerRow({
        worker: {
          residentId: id("aRui"),
          moraleApprox: 50,
          alive: true,
          dispatched: false,
          recallImpaired: false,
        },
      }),
      found,
    );
    expect(found).toHaveLength(0);
  });

  it("ResidentRow(就労先セレクト)", () => {
    const resident: ResidentView = {
      entityId: id("aRui"),
      moraleApprox: 60,
      masteryApprox: 0,
      assignedFacilityId: null,
      dispatched: false,
      recallImpaired: false,
      recallImpairedUntilTick: 0,
      traitIds: [],
      stats: {
        vigorApprox: 50,
        dexterityApprox: 50,
        intellectApprox: 50,
        fortitudeApprox: 50,
        willApprox: 50,
      },
      alive: true,
      diedTick: null,
    };
    const roster: readonly FacilityRosterEntry[] = [
      {
        facilityId: id("facHearth1"),
        defId: id("hearth"),
        cellIndex: 14,
        cellId: "c14",
        level: 1,
        tags: ["heat"],
        workerIds: [],
        slotsMax: null,
      },
    ];
    const vnode = ResidentRow({
      resident,
      facilityRoster: roster,
      onAssign: () => undefined,
      onUnassign: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.tag === "select")).toBe(true);
  });

  it("RejectionBanner は対話可能要素を持たない(role=alert の文章のみ)", () => {
    const found: InteractiveElement[] = [];
    collectInteractive(
      RejectionBanner({
        rejection: {
          code: "insufficientResource",
          commandKind: "reclaimCell",
          commandIndex: 0,
          subjectId: null,
          cellIndex: null,
          limit: null,
          actual: null,
          resourceId: null,
          requiredRaw: null,
          availableRaw: null,
          ownerTask: null,
          message: "テスト",
        },
      }),
      found,
    );
    expect(found).toHaveLength(0);
  });
});

// --- 4-2. [M31] ⑤研究ツリー/⑥成文化キューの新規対話可能要素 ------------------

describe("44px 最小タップ領域 — 実際にレンダーした vnode との突合せ([M31])", () => {
  const researchEntry: ResearchTreeEntry = {
    techId: id("techFireStarting"),
    eraId: "e1",
    lossClass: "criticalRecoverable",
    prereqTechIds: [],
    prereqsMet: true,
    researchCostApprox: 30,
    status: "notStarted",
    progressApprox: null,
    isCurrentResearchTarget: false,
  };

  it("ResearchTechRow(研究開始ボタン)", () => {
    const vnode = ResearchTechRow({ entry: researchEntry, onBeginResearch: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-research-row__start-button"))).toBe(true);
  });

  const codifyEntry: CodifyTechEntry = {
    techId: id("techFireStarting"),
    lossClass: "criticalRecoverable",
    holderIds: [id("aRui")],
    uniqueHolder: true,
    isCodified: false,
    recordedMedia: [],
    pendingRecords: [],
    residualTick: 1000,
    hasDeadline: true,
    maxRecallRiskPercentApprox: 5,
  };

  it("CodifyTechRow(媒体セレクト+キュー投入ボタン)", () => {
    const vnode = CodifyTechRow({
      entry: codifyEntry,
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.tag === "select")).toBe(true);
    expect(found.some((e) => e.class.includes("kf-codify-row__enqueue-button"))).toBe(true);
  });

  it("CodifySuggestionPanel(おまかせ成文化の適用ボタン)", () => {
    const suggestion: CodifySuggestionView = {
      techId: id("techFireStarting"),
      medium: "stoneTablet",
      codifyId: id("techFireStartingRecordStone"),
      residualTick: 1000,
      hasDeadline: true,
      durationTicks: 40,
      cumulativeTicks: 40,
      onSchedule: true,
    };
    const vnode = CodifySuggestionPanel({
      suggestions: [suggestion],
      outcome: null,
      onApply: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-codify-assist__apply-button"))).toBe(true);
  });

  it("CodifySuggestionPanel(提案 0 件は適用ボタンを出さない・捏造しない)", () => {
    const found: InteractiveElement[] = [];
    collectInteractive(
      CodifySuggestionPanel({ suggestions: [], outcome: null, onApply: () => undefined }),
      found,
    );
    expect(found).toHaveLength(0);
  });
});

// --- 4-3. [M32] ⑦探索本部の hooks 不使用コンポーネントの実レンダー突合せ ----

describe("44px 最小タップ領域 — ⑦探索本部(M32)の実レンダー突合せ", () => {
  it("BandPicker(距離帯3ボタン)", () => {
    const vnode = BandPicker({ band: "near", onPick: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.length).toBe(3);
  });

  it("DestinationPicker(目的地ボタン)", () => {
    const vnode = DestinationPicker({
      options: [id("eventNearRubbleSweep")],
      destinationId: id("eventNearRubbleSweep"),
      onPick: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });

  it("StancePicker(方針2ボタン)", () => {
    const vnode = StancePicker({ stance: "cautious", onPick: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.length).toBe(2);
  });

  it("CandidateRow(派遣候補トグルボタン)", () => {
    const candidate: ExpeditionCandidateView = {
      entityId: id("aRui"),
      combatPowerApprox: 50,
      moraleApprox: 60,
      traitIds: [],
    };
    const vnode = CandidateRow({
      candidate,
      selected: false,
      disabled: false,
      onToggle: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });
});

// --- 4-4. [M33] ⑩大移動ナップサックUI/⑪継承点購入/＋セーブ・設定の実レンダー突合せ

describe("44px 最小タップ領域 — ⑩大移動(M33)の実レンダー突合せ", () => {
  const recordOption: ExodusRecordOption = {
    id: id("codifyFireStone"),
    techId: id("techFireStarting"),
    medium: "stoneTablet",
    lossClass: "criticalRecoverable",
    weightApprox: 1,
  };

  it("ExodusRecordRow(記録の選択トグルボタン)", () => {
    const vnode = ExodusRecordRow({
      record: recordOption,
      selected: false,
      onToggle: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-exodus__record-button"))).toBe(true);
  });

  const crewOption: ExodusCrewOption = {
    id: id("aRui"),
    moraleApprox: 60,
    traitIds: [id("traitScholar")],
  };

  it("ExodusCrewRow(住民の選択トグルボタン)", () => {
    const vnode = ExodusCrewRow({
      resident: crewOption,
      selected: true,
      onToggle: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-exodus__crew-button"))).toBe(true);
  });

  it("ExodusCompletedNotice(＋設定画面への導線ボタン)", () => {
    const vnode = ExodusCompletedNotice({
      earnedInheritPoints: 84,
      onGoToSettings: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-exodus__completed-button"))).toBe(true);
  });
});

describe("44px 最小タップ領域 — ⑪継承点購入(M33)の実レンダー突合せ", () => {
  it("InheritTrackRow(購入ボタン)", () => {
    const vnode = InheritTrackRow({
      track: "caravanCapacity",
      currentTier: 1,
      maxTier: 4,
      currentBonus: 2,
      bonusPerTier: 2,
      nextCost: 75,
      insufficientBalance: false,
      onPurchase: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-inherit-row__button"))).toBe(true);
  });

  it("InheritTrackRow(上限段は非活性でも 44px を満たす)", () => {
    const vnode = InheritTrackRow({
      track: "startingStock",
      currentTier: 4,
      maxTier: 4,
      currentBonus: 100,
      bonusPerTier: 25,
      nextCost: null,
      insufficientBalance: false,
      onPurchase: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });
});

describe("44px 最小タップ領域 — ＋セーブ・設定(M33)の実レンダー突合せ", () => {
  it("ExportPanel(エクスポートボタン)", () => {
    const vnode = ExportPanel({ exportedText: null, onExport: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-settings__export-button"))).toBe(true);
  });

  it("ImportPanel(インポート実行ボタン)", () => {
    const vnode = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: null,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-settings__import-button"))).toBe(true);
  });
});

// --- 4-5. [M54] 新規UI(⑥取消/⑨拠点操作/バナー2種/設定リセット)の実レンダー突合せ

describe("44px 最小タップ領域 — [M54] ⑥成文化キューの取消ボタン", () => {
  it("CodifyTechRow(作業中の記録の取消ボタン)", () => {
    const entry: CodifyTechEntry = {
      techId: id("techFireStarting"),
      lossClass: "criticalRecoverable",
      holderIds: [id("aRui")],
      uniqueHolder: true,
      isCodified: false,
      recordedMedia: [],
      pendingRecords: [
        { entityId: id("cJob1"), medium: "paper", progressApprox: 5, requiredWorkApprox: 20 },
      ],
      residualTick: 1000,
      hasDeadline: true,
      maxRecallRiskPercentApprox: 5,
    };
    const vnode = CodifyTechRow({
      entry,
      selectedMedium: "stoneTablet",
      onMediumChange: () => undefined,
      onEnqueue: () => undefined,
      onCancel: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-codify-row__cancel-button"))).toBe(true);
  });
});

describe("44px 最小タップ領域 — [M54] ⑨衛星拠点の操作 UI", () => {
  const residentA: ResidentView = {
    entityId: id("aRui"),
    moraleApprox: 60,
    masteryApprox: 0,
    assignedFacilityId: null,
    dispatched: false,
    recallImpaired: false,
    recallImpairedUntilTick: 0,
    traitIds: [],
    stats: {
      vigorApprox: 50,
      dexterityApprox: 50,
      intellectApprox: 50,
      fortitudeApprox: 50,
      willApprox: 50,
    },
    alive: true,
    diedTick: null,
  };

  const outpostEntry: OutpostRosterEntry = {
    outpostId: id("outpostMine1"),
    outpostTypeId: id("outpostMine"),
    resourceId: id("iron"),
    band: "near",
    level: 1,
    residentIds: [id("aRui")],
    establishedTick: 0,
    supplyApprox: 10,
    upkeepApprox: 4,
    netRevenueApprox: 6,
    hazardApprox: 0.05,
    rareAssetCount: 0,
    expectedRareLossApprox: 0,
    roiApprox: 2.5,
  };

  it("OutpostCard(解除/駐在セレクト+ボタン/放棄ボタン)", () => {
    const vnode = OutpostCard({
      outpost: outpostEntry,
      residentOptions: [residentA],
      stationSelectValue: "",
      onStationSelectChange: () => undefined,
      onStation: () => undefined,
      onUnstation: () => undefined,
      confirmingAbandon: false,
      onAbandonStart: () => undefined,
      onAbandonConfirm: () => undefined,
      onAbandonCancel: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-outpost-card__unstation-button"))).toBe(true);
    expect(found.some((e) => e.class.includes("kf-outpost-card__station-button"))).toBe(true);
    expect(found.some((e) => e.tag === "select")).toBe(true);
    expect(found.some((e) => e.class.includes("kf-outpost-card__abandon-button"))).toBe(true);
  });

  it("[M61/FC8] OutpostCard(放棄確認パネル=実行する/キャンセルも44px)", () => {
    const vnode = OutpostCard({
      outpost: outpostEntry,
      residentOptions: [residentA],
      stationSelectValue: "",
      onStationSelectChange: () => undefined,
      onStation: () => undefined,
      onUnstation: () => undefined,
      confirmingAbandon: true,
      onAbandonStart: () => undefined,
      onAbandonConfirm: () => undefined,
      onAbandonCancel: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.class.includes("kf-outpost-card__abandon-confirm-button"))).toBe(
      true,
    );
    expect(found.some((e) => e.class.includes("kf-outpost-card__abandon-cancel-button"))).toBe(
      true,
    );
  });

  it("OutpostEstablishForm(タイプ選択/距離帯/住民トグル/設置ボタン)", () => {
    const vnode = OutpostEstablishForm({
      outpostTypeOptions: [id("outpostMine")],
      selectedTypeId: id("outpostMine"),
      onTypeChange: () => undefined,
      band: "near",
      onBandChange: () => undefined,
      residentOptions: [residentA],
      selectedResidentIds: new Set(),
      onToggleResident: () => undefined,
      onSubmit: () => undefined,
    });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.some((e) => e.tag === "select")).toBe(true);
    expect(found.some((e) => e.class.includes("kf-outposts-establish__submit-button"))).toBe(true);
  });
});

describe("44px 最小タップ領域 — [M54] 定期バックアップ/起動失敗バナー", () => {
  it("BackupReminderBanner", () => {
    const vnode = BackupReminderBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });

  it("LoadFailureBanner", () => {
    const vnode = LoadFailureBanner({
      visible: true,
      onGoToSettings: () => undefined,
      onClose: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });
});

describe("44px 最小タップ領域 — [M54] ＋設定「最初からやり直す」", () => {
  it("ResetGameSection(段0/段1/段2それぞれのボタン)", () => {
    for (const step of [0, 1, 2] as const) {
      const vnode = ResetGameSection({
        step,
        onStart: () => undefined,
        onProceed: () => undefined,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      });
      assertAllInteractiveElementsMeetMinTapTarget(vnode);
    }
  });
});

// --- 5. 既存 M18/M29 コンポーネントも同じ検査器で確認(回帰保護) -------------

describe("44px 最小タップ領域 — 既存コンポーネント(M18/M29)の回帰保護", () => {
  it("UrgencyBadge(①ホームハブ)", () => {
    const vnode = UrgencyBadge({
      alert: { id: "idleResidents", level: "info", screen: "residents", count: 1 },
      onNavigate: () => undefined,
    });
    assertAllInteractiveElementsMeetMinTapTarget(vnode);
  });

  it("PlaceholderScreen(戻るボタン)", () => {
    // PlaceholderScreen は hooks(useScreenMount)を使うので直接呼べない。
    // 戻るボタンの class 名だけを CSS 側で確認する(実装は appShell.css 参照)。
    assertMinTapTarget(".kf-placeholder__back");
  });

  // [束A] 13 タブ全掲 → 5 グループ + 展開(F-5)。ボタンの総数は減ったが
  // 「ナビから到達できる全ボタンが 44px を満たす」という検査の意味は同じなので、
  // 畳んだ状態(グループ 5 個)と全グループ展開状態の両方を通す。
  it("ScreenNav(グループバー)", () => {
    const vnode = ScreenNav({ current: "home", onNavigate: () => undefined });
    const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
    expect(found.length).toBe(NAV_GROUPS.length);
  });

  it("ScreenNav(展開したサブ項目も 44px を満たす・全グループ)", () => {
    let subButtonCount = 0;
    for (const group of NAV_GROUPS) {
      const vnode = ScreenNav({
        current: "home",
        onNavigate: () => undefined,
        openGroupId: group.id,
      });
      const found = assertAllInteractiveElementsMeetMinTapTarget(vnode);
      subButtonCount += found.filter((e) => e.class.includes("kf-nav__sub-button")).length;
    }
    // 単独グループ(設定)はサブ項目を持たない = 12画面ぶんが展開対象。
    expect(subButtonCount).toBe(12);
  });

  it("GridCell(占有セル)の CSS 下限フォールバックが 44px", () => {
    const cell: CellViewModel = {
      cellIndex: 10,
      cellId: "c10",
      occupied: true,
      facilityId: id("fTest"),
      defId: id("hearth"),
      anchorCellIndex: 10,
      tags: ["heat"],
      level: 1,
      workerCount: 1,
      multiplierFix: FIX_ONE,
      multiplierApprox: 1,
      bonusFix: FIX_ZERO,
      overcrowdPenaltyFix: FIX_ZERO,
      overcrowdedNeighborCount: 0,
      overcrowded: false,
      isRubble: false,
    };
    // GridCell 自身はタップの対象(親の onPointerUp が hitTest する)なので
    // ボタン/セレクトを持たない。実寸保証は gridConstants.ts の
    // `CELL_SIZE_PX * MIN_SCALE >= MIN_TAP_TARGET_PX`(gridGeometry.test.ts)。
    // ここでは CSS 側の `.kf-cell` 下限フォールバックだけを確認する。
    void GridCell({ cell, selected: false, zoom: 1 });
    assertMinTapTarget(".kf-cell");
  });
});
