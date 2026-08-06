// ---------------------------------------------------------------------------
// facility content スキーマ — GDD §6.1/§6.2/§12.1、ADR「共通規約」602行以降
//
// 施設は「上限値管理のみに役割限定」(GDD 12.1)。隣接効果の実体は
// adjacency.json のタグ×タグ行列側にあり、facility は自身が持つタグ集合
// (FACILITY_TAGS の部分集合)だけを申告する。この FACILITY_TAGS が
// adjacency.ts のタグ全域(TAG_UNIVERSE)としても再利用される単一ソース。
//
// タグ7種の英字IDは docs/design/tags-spec.md 末尾の機械可読 JSON(T13後半)を
// 出典とする: heat/clean/foul/noise/damp/calm/lore。
//
// ---------------------------------------------------------------------------
// [T7] 縮約 rules 向け追加フィールド `harshWork` / `output`(いずれも省略可)
// ---------------------------------------------------------------------------
// engine の縮約 rules(`src/engine/rules/types.ts` の FacilityDef)は
//   harshWork : GDD 11.2 の loadW を ×2.0(過酷業務)/ ×0.5(通常)に振り分ける
//   output    : GDD 11.1 の産出先(resource ストック / 研究点)
// を要求するが、ADR「entity スキーマ」616行の facility スケッチにはどちらも無い
// (最終形では産出先は recipe entity 側に載る想定であり、recipe カテゴリは
// T6/T7 のロード対象外)。そこで本スキーマでは **省略可**(欠落は null)として
// additive に受け付け、「engine へ写すのに必須」の強制は content ローダー
// (schema/engineContent.ts)側で行う:
//   - schema 段: 形式のみ検証(既存 content・既存テストを壊さない)
//   - loader 段: 欠落を reject(縮約 rules が読む値を黙って既定値で埋めない)
// recipe カテゴリを追加する際に `output` の出所をそちらへ移すこと。
//
// ---------------------------------------------------------------------------
// [M5] 追加フィールド `statWeights` / `storageCapacityCurve` / `storedResourceIds`
// ---------------------------------------------------------------------------
// いずれも **省略可**。同じく「schema 段は形式のみ・省略を許す」「loader 段が
// engine への写し方を決める」の二段構えで、既存 content と既存テストを壊さない。
//   statWeights          : GDD 11.1「Σ担当者**関連**ステータス寄与」の「関連」。
//                          ステータス 5 種(裁定 B8)への重みで、**総和 1.0** を
//                          要求する(中立性の根拠 = src/engine/rules/stats.ts §2)。
//                          省略時は engine 側の等分既定(各 0.2)。
//   storageCapacityCurve : GDD 6.7 / 12.1「施設側は上限値管理のみに役割限定」。
//                          Lv 別の保管容量。省略時は容量を提供しない。
//   storedResourceIds    : 容量の対象資源。省略/null は全資源(汎用倉庫)。
//
// ---------------------------------------------------------------------------
// [M50] 追加フィールド `buildCost` / `upgradeCostCurve`(GDD 12.1 [2026-07-30裁定])
// ---------------------------------------------------------------------------
// 裁定本文: 「コスト項は **facility スキーマ側**に置く(施設ごとの値であり
// `lvCurve` と同居が自然。`buildCost` と増築コストカーブを追加)。既存 content/
// テストを壊さないため『schema では省略可・ローダーでは必須』の二段構え(T7 方式)」。
// よって本ファイルは形式だけを見る(省略は null)。**欠落の reject は
// `schema/engineContent.ts` の `toFacilityDef` が行う**(harshWork / output と同じ)。
//
//   buildCost        : Lv1 で建てるときに払う資源(1 種)と量。
//   upgradeCostCurve : Lv 別の増築コスト。**index i = Lv(i+1) → Lv(i+2)** の費用で
//                      あり、支払う資源は `buildCost.resourceId` と同じ(施設 1 基に
//                      つきコスト資源は 1 種)。他の Lv 別カーブ(lvCurve /
//                      storageCapacityCurve / bedCapacityCurve)と長さを揃えて
//                      5 個にしてあるので、**最後の要素(Lv5 → Lv6)は読まれない**
//                      (Lv5 が上限のため)。長さを 4 にしない理由は、Lv 別カーブが
//                      1 本だけ別の長さになるとオーサリング側の検算(6桁 floor の
//                      表計算・docs/measurements/authoring-procedure.md)が
//                      施設ごとに 2 種類の列数を持つことになるためである。
//
// ---------------------------------------------------------------------------
// [M65] `buildCost` の複数資源化(2026-08-06裁定・台帳v20 必-5 / ロードマップ M65)
// ---------------------------------------------------------------------------
// M40 が「消費先の無い資源6種(木炭/銅ほか)の消費先接続は content の additive
// 規約では実行不能」と機械証明した(`buildCost.resourceId` の張り替えは
// content-semantics-gate が意味変更として全件 reject する・
// docs/measurements/balance-m40-e2-recalibration-2026-08-03.json の
// `structuralFinding_consumptionSinks`)。その案A(推奨)がここで入る。
//
//   `buildCost` は **単一オブジェクト形(M50)と配列形(M65)の union** になった。
//     単一形: { "resourceId": "clay", "amount": 25 }             ← 既存 content
//     配列形: [ { "resourceId": "clay", "amount": 25 },          ← 第1行 = 主資源
//               { "resourceId": "charcoal", "amount": 8,
//                 "upgradeCostCurve": [9,11,13,16,19] } ]        ← 第2行以降
//
//   規約(1 つの (資源, Lv) に対する費用の出所を必ず 1 箇所にするための非対称):
//     - **第1行(index 0)は `upgradeCostCurve` を持てない**。その行の増築費は
//       トップレベルの `upgradeCostCurve` である(= 単一形と同じ意味)。
//     - **第2行以降(index >= 1)は `upgradeCostCurve` が必須**。省略を許すと
//       「建てるのは有料だが増築はこの資源だけ無料」が書き忘れで静かに成立する
//       (ローダーが `harshWork` / `output` の欠落を reject するのと同じ立場)。
//       建設のみの出口にしたいときは `[0,0,0,0,0]` を明示する。
//     - 行の資源 ID は重複禁止(同じ資源を 2 行に分けて書く意味が無く、
//       どちらが正かの解釈が生まれる)。
//   単一形は**そのまま読み続ける**(既存 content は 1 バイトも変えずに通る)。
//   engine 側の写し方は `schema/engineContent.ts` の `toFacilityCost` を参照。
// ---------------------------------------------------------------------------

import {
  IssueCollector,
  expectArray,
  expectBoolean,
  expectEnum,
  expectInteger,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  validateId,
  type ValidationResult,
} from "./common";

/** タグ7種(GDD 6.2: 熱源/清浄/汚染/騒音/湿潤/静穏/学芸)。adjacency.ts と共有する唯一のソース。 */
export const FACILITY_TAGS = ["heat", "clean", "foul", "noise", "damp", "calm", "lore"] as const;
export type FacilityTag = (typeof FACILITY_TAGS)[number];

function isFacilityTag(value: string): value is FacilityTag {
  return (FACILITY_TAGS as readonly string[]).includes(value);
}

/** GDD 6.1: 1セル=1施設(大型は2×1/2×2占有)。width/height はセル数。 */
const FOOTPRINT_DIMENSION_RANGE = { min: 1, max: 2 };

/** GDD 7.7: 就労スロットは施設ごと・Lvで増加。負値は無効、上限は保守的な目安値。 */
const SLOT_RANGE = { min: 0, max: 20 };

/** ADR「entity スキーマ」616行: lvCurve = base × 1.15^(Lv-1) の個別FP展開値。正の値のみ。 */
const LV_CURVE_LENGTH = 5;
const LV_CURVE_VALUE_RANGE = { min: 0.000001, max: 1_000_000_000 };

export interface FacilitySlots {
  readonly lv1: number;
  readonly lv2: number;
  readonly lv3: number;
  readonly lv4: number;
  readonly lv5: number;
}

export interface FacilityFootprint {
  readonly width: number;
  readonly height: number;
}

/** GDD 11.1 の産出先。研究点は resource ストックではなく研究進行度へ入る。 */
export const FACILITY_OUTPUT_KINDS = ["resource", "research"] as const;
export type FacilityOutputKind = (typeof FACILITY_OUTPUT_KINDS)[number];

/** `output`(省略可)。resource の場合のみ産出先 ID を持つ。 */
export type FacilityOutputContent =
  { readonly kind: "resource"; readonly resourceId: string } | { readonly kind: "research" };

/** [M5] ステータス 5 種(裁定 B8)への重み。総和 1.0(検証はローダー側)。 */
export const RESIDENT_STAT_KEYS = ["vigor", "dexterity", "intellect", "fortitude", "will"] as const;
export type ResidentStatKey = (typeof RESIDENT_STAT_KEYS)[number];

/** [M5] 重みは 0〜1(総和 1.0 の突き合わせは engineContent.ts が行う)。 */
const STAT_WEIGHT_RANGE = { min: 0, max: 1 };

/** [M5] 保管容量の Lv 別カーブ。lvCurve と同じ長さ・非負。 */
const CAPACITY_VALUE_RANGE = { min: 0, max: 1_000_000_000 };

export type FacilityStatWeights = { readonly [K in ResidentStatKey]: number };

/**
 * [M50] 建設コスト(GDD 12.1 [2026-07-30裁定])。資源は施設 1 基につき 1 種で
 * あり、増築コスト({@link FacilityContent.upgradeCostCurve})も同じ資源で払う。
 */
export interface FacilityBuildCost {
  readonly resourceId: string;
  readonly amount: number;
}

/**
 * [M65] 複数資源形({@link FacilityBuildCostContent})の 1 行(ファイル冒頭 [M65])。
 *
 * `upgradeCostCurve` は **第2行以降でのみ非 null**。第1行は常に null であり、
 * その行の増築費はトップレベルの `upgradeCostCurve` が持つ。
 */
export interface FacilityBuildCostLine {
  readonly resourceId: string;
  readonly amount: number;
  readonly upgradeCostCurve: readonly number[] | null;
}

/**
 * [M65] `buildCost` が取りうる形。単一オブジェクト形(M50・後方互換)か、
 * 1 行以上の配列形(M65)。ファイル冒頭 [M65] の節が規約の正本。
 */
export type FacilityBuildCostContent = FacilityBuildCost | readonly FacilityBuildCostLine[];

/** [M50] 建設/増築コストの値域。0(無料)も許す(バランス調整段の自由度)。 */
const COST_VALUE_RANGE = { min: 0, max: 1_000_000_000 };

export interface FacilityContent {
  readonly id: string;
  readonly tags: readonly FacilityTag[];
  readonly slots: FacilitySlots;
  readonly lvCurve: readonly number[];
  readonly overflowCapPolicy: string;
  readonly footprint: FacilityFootprint;
  /** [M5] ステータス重み。JSON に無ければ null(engine 側が等分既定を使う)。 */
  readonly statWeights: FacilityStatWeights | null;
  /** [M5] Lv 別の保管容量。JSON に無ければ null(容量を提供しない)。 */
  readonly storageCapacityCurve: readonly number[] | null;
  /** [M5] 容量の対象資源 ID。JSON に無ければ null(= 全資源)。 */
  readonly storedResourceIds: readonly string[] | null;
  /**
   * [M11] Lv 別の寝床上限(人数・整数)。GDD 7.7「寝床上限内の決定論的定期加入」と
   * GDD 7.6 の人口下限 `min(寝床×0.5, 6)` の「寝床」。
   * JSON に無ければ null(= この施設は寝床を提供しない)。
   */
  readonly bedCapacityCurve: readonly number[] | null;
  /**
   * GDD 11.2 の過酷業務(製錬/鍛冶/高炉等)か。JSON に無ければ null
   * (= engine へ写す段で reject。ファイル冒頭 [T7] の節を参照)。
   */
  readonly harshWork: boolean | null;
  /** GDD 11.1 の産出先。JSON に無ければ null(同上)。 */
  readonly output: FacilityOutputContent | null;
  /**
   * [M50] Lv1 で建てるときのコスト(GDD 12.1 [2026-07-30裁定])。
   * JSON に無ければ null(= engine へ写す段で reject。ファイル冒頭 [M50] の節)。
   *
   * [M65] 複数資源の配列形も受け付ける(ファイル冒頭 [M65] の節)。
   */
  readonly buildCost: FacilityBuildCostContent | null;
  /**
   * [M50] Lv 別の増築コスト。**index i = Lv(i+1) → Lv(i+2)**(ファイル冒頭 [M50])。
   * JSON に無ければ null(同上)。
   */
  readonly upgradeCostCurve: readonly number[] | null;
}

const SLOT_LEVEL_KEYS = ["lv1", "lv2", "lv3", "lv4", "lv5"] as const;

function validateTags(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly FacilityTag[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length === 0) {
    issues.add(path, "tags は1個以上必須");
    return undefined;
  }
  const issuesBefore = issues.list().length;
  const tags: FacilityTag[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (typeof entry !== "string" || !isFacilityTag(entry)) {
      issues.add(
        `${path}[${String(i)}]`,
        `タグは ${FACILITY_TAGS.join(" | ")} のいずれかが必須(実際: ${JSON.stringify(entry)})`,
      );
      continue;
    }
    if (seen.has(entry)) {
      issues.add(`${path}[${String(i)}]`, `タグ "${entry}" が重複`);
      continue;
    }
    seen.add(entry);
    tags.push(entry);
  }
  // 個別タグの欠陥は continue で集約しつつ全件走査するが(1回で全欠陥を報告)、
  // 1件でも欠陥があれば呼び出し元には undefined を返し reject させる。
  return issues.list().length === issuesBefore ? tags : undefined;
}

function validateSlots(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilitySlots | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const values: number[] = [];
  for (const key of SLOT_LEVEL_KEYS) {
    const n = expectInteger(obj[key], `${path}.${key}`, issues, SLOT_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    if (cur < prev) {
      issues.add(
        path,
        `slots は Lv が上がるにつれ単調非減少が必須(GDD 7.7「Lvで増加」): ${values.join(",")}`,
      );
      return undefined;
    }
  }
  const [lv1, lv2, lv3, lv4, lv5] = values;
  return {
    lv1: lv1 ?? 0,
    lv2: lv2 ?? 0,
    lv3: lv3 ?? 0,
    lv4: lv4 ?? 0,
    lv5: lv5 ?? 0,
  };
}

function validateLvCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `lvCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, LV_CURVE_VALUE_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] ?? 0;
    const cur = values[i] ?? 0;
    if (cur <= prev) {
      issues.add(
        path,
        `lvCurve は Lv が上がるにつれ狭義単調増加が必須(base × 1.15^(Lv-1)): ${values.join(",")}`,
      );
      return undefined;
    }
  }
  return values;
}

function validateFootprint(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityFootprint | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const width = expectInteger(obj["width"], `${path}.width`, issues, FOOTPRINT_DIMENSION_RANGE);
  const height = expectInteger(obj["height"], `${path}.height`, issues, FOOTPRINT_DIMENSION_RANGE);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

/**
 * `output`(省略可)の検証。`kind` が resource のときだけ `resourceId` を要求する。
 * resource カテゴリは T6/T7 のロード対象外なので**実在確認は行わない**
 * (産出先 entity の不在は engine 側の applyProduction が実行時に reject する)。
 */
function validateOutput(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityOutputContent | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const kind = expectEnum(obj["kind"], FACILITY_OUTPUT_KINDS, `${path}.kind`, issues);
  if (kind === undefined) return undefined;
  if (kind === "research") return { kind: "research" };
  const resourceId = validateId(obj["resourceId"], `${path}.resourceId`, issues);
  if (resourceId === undefined) return undefined;
  return { kind: "resource", resourceId };
}

/** [M5] `statWeights`(省略可)の検証。5 種すべてを要求する(部分指定は曖昧)。 */
function validateStatWeights(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityStatWeights | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const values: number[] = [];
  for (const key of RESIDENT_STAT_KEYS) {
    const n = expectNumber(obj[key], `${path}.${key}`, issues, STAT_WEIGHT_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  const [vigor, dexterity, intellect, fortitude, will] = values;
  return {
    vigor: vigor ?? 0,
    dexterity: dexterity ?? 0,
    intellect: intellect ?? 0,
    fortitude: fortitude ?? 0,
    will: will ?? 0,
  };
}

/** [M5] `storageCapacityCurve`(省略可)の検証。Lv1〜Lv5 の 5 個・非負。 */
function validateCapacityCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `storageCapacityCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, CAPACITY_VALUE_RANGE);
    if (n === undefined) return undefined;
    values.push(n);
  }
  return values;
}

/** [M11] 寝床上限の Lv 別カーブ。人数なので**非負整数**(容量カーブと違い小数不可)。 */
const BED_CAPACITY_VALUE_RANGE = { min: 0, max: 1_000 };

/** [M11] `bedCapacityCurve`(省略可)の検証。Lv1〜Lv5 の 5 個・非負整数・単調非減少。 */
function validateBedCapacityCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `bedCapacityCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectInteger(arr[i], `${path}[${String(i)}]`, issues, BED_CAPACITY_VALUE_RANGE);
    if (n === undefined) return undefined;
    // 増築で寝床が減ると人口下限(GDD 7.6)が跳ね下がり、下限保証の議論が
    // 「増築するほど守られる人数が減る」形になる。設定ミスとして止める。
    const previous = values[i - 1];
    if (previous !== undefined && n < previous) {
      issues.add(
        `${path}[${String(i)}]`,
        `bedCapacityCurve は単調非減少が必須(Lv を上げて寝床が減らない)。${String(previous)} の次が ${String(n)}`,
      );
      return undefined;
    }
    values.push(n);
  }
  return values;
}

/** [M5] `storedResourceIds`(省略可)の検証。ID 規則に一致する文字列の配列。 */
function validateStoredResourceIds(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly string[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  const ids: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const value = validateId(arr[i], `${path}[${String(i)}]`, issues);
    if (value === undefined) return undefined;
    ids.push(value);
  }
  return ids;
}

/** [M50] `buildCost`(省略可)の検証。資源 ID + 非負の量。 */
function validateBuildCost(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityBuildCost | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const resourceId = validateId(obj["resourceId"], `${path}.resourceId`, issues);
  const amount = expectNumber(obj["amount"], `${path}.amount`, issues, COST_VALUE_RANGE);
  if (resourceId === undefined || amount === undefined) return undefined;
  return { resourceId, amount };
}

/**
 * [M65] 配列形 `buildCost` の検証(ファイル冒頭 [M65] の規約)。
 *
 * 第1行は `upgradeCostCurve` を持てず、第2行以降は必須。資源 ID の重複も止める。
 * 空配列は reject する(「コストを書いたのに 1 行も無い」= 書き忘れ)。
 */
function validateBuildCostLines(
  raw: readonly unknown[],
  path: string,
  issues: IssueCollector,
): readonly FacilityBuildCostLine[] | undefined {
  if (raw.length === 0) {
    issues.add(path, "buildCost の配列形は 1 行以上が必須(空配列は無料と区別できない)");
    return undefined;
  }
  const lines: FacilityBuildCostLine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const linePath = `${path}[${String(i)}]`;
    const obj = expectRecord(raw[i], linePath, issues);
    if (obj === undefined) return undefined;
    const resourceId = validateId(obj["resourceId"], `${linePath}.resourceId`, issues);
    const amount = expectNumber(obj["amount"], `${linePath}.amount`, issues, COST_VALUE_RANGE);
    if (resourceId === undefined || amount === undefined) return undefined;
    if (seen.has(resourceId)) {
      issues.add(linePath, `資源 "${resourceId}" が buildCost に 2 行ある(1 資源 1 行)`);
      return undefined;
    }
    seen.add(resourceId);

    const rawCurve = obj["upgradeCostCurve"];
    if (i === 0) {
      if (rawCurve !== undefined) {
        issues.add(
          `${linePath}.upgradeCostCurve`,
          "buildCost の第1行は増築コストを持てない" +
            "(第1行の増築費はトップレベルの upgradeCostCurve・schema/facility.ts 冒頭 [M65])",
        );
        return undefined;
      }
      lines.push({ resourceId, amount, upgradeCostCurve: null });
      continue;
    }
    if (rawCurve === undefined) {
      issues.add(
        `${linePath}.upgradeCostCurve`,
        "buildCost の第2行以降は増築コストの明示が必須" +
          "(建設のみの出口なら [0,0,0,0,0] と書く・schema/facility.ts 冒頭 [M65])",
      );
      return undefined;
    }
    const curve = validateUpgradeCostCurve(rawCurve, `${linePath}.upgradeCostCurve`, issues);
    if (curve === undefined) return undefined;
    lines.push({ resourceId, amount, upgradeCostCurve: curve });
  }
  return lines;
}

/**
 * [M65] `buildCost`(省略可)の検証。単一オブジェクト形(M50)と配列形(M65)の
 * どちらも受ける(ファイル冒頭 [M65])。
 */
function validateBuildCostContent(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): FacilityBuildCostContent | undefined {
  if (Array.isArray(raw)) return validateBuildCostLines(raw, path, issues);
  return validateBuildCost(raw, path, issues);
}

/**
 * [M50] `upgradeCostCurve`(省略可)の検証。Lv1〜Lv5 の 5 個・非負・**単調非減少**。
 *
 * 単調非減少を強制するのは「Lv を上げるほど増築が安くなる」設定ミスを止めるため
 * ({@link validateBedCapacityCurve} が「Lv を上げて寝床が減らない」を強制するのと
 * 同じ立場)。狭義増加にしないのは、無料段(0 が連続する)を許すため。
 */
function validateUpgradeCostCurve(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): readonly number[] | undefined {
  const arr = expectArray(raw, path, issues);
  if (arr === undefined) return undefined;
  if (arr.length !== LV_CURVE_LENGTH) {
    issues.add(
      path,
      `upgradeCostCurve は長さ ${String(LV_CURVE_LENGTH)}(Lv1〜Lv5)が必須(実際: ${String(arr.length)})`,
    );
    return undefined;
  }
  const values: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = expectNumber(arr[i], `${path}[${String(i)}]`, issues, COST_VALUE_RANGE);
    if (n === undefined) return undefined;
    const previous = values[i - 1];
    if (previous !== undefined && n < previous) {
      issues.add(
        `${path}[${String(i)}]`,
        `upgradeCostCurve は単調非減少が必須(Lv を上げて増築が安くならない)。${String(previous)} の次が ${String(n)}`,
      );
      return undefined;
    }
    values.push(n);
  }
  return values;
}

export function validateFacility(raw: unknown): ValidationResult<FacilityContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const id = validateId(obj["id"], "$.id", issues);
  const tags = validateTags(obj["tags"], "$.tags", issues);
  const slots = validateSlots(obj["slots"], "$.slots", issues);
  const lvCurve = validateLvCurve(obj["lvCurve"], "$.lvCurve", issues);
  const overflowCapPolicy = expectString(obj["overflowCapPolicy"], "$.overflowCapPolicy", issues);
  const footprint = validateFootprint(obj["footprint"], "$.footprint", issues);

  // 省略可フィールド: キーが無ければ null、あれば形式を検証する。
  const rawHarshWork = obj["harshWork"];
  const harshWork =
    rawHarshWork === undefined
      ? null
      : (expectBoolean(rawHarshWork, "$.harshWork", issues) ?? undefined);
  const rawOutput = obj["output"];
  const output =
    rawOutput === undefined ? null : (validateOutput(rawOutput, "$.output", issues) ?? undefined);

  // [M5] 追加の省略可フィールド。
  const rawStatWeights = obj["statWeights"];
  const statWeights =
    rawStatWeights === undefined
      ? null
      : (validateStatWeights(rawStatWeights, "$.statWeights", issues) ?? undefined);
  const rawCapacityCurve = obj["storageCapacityCurve"];
  const storageCapacityCurve =
    rawCapacityCurve === undefined
      ? null
      : (validateCapacityCurve(rawCapacityCurve, "$.storageCapacityCurve", issues) ?? undefined);
  const rawStoredResourceIds = obj["storedResourceIds"];
  const storedResourceIds =
    rawStoredResourceIds === undefined
      ? null
      : (validateStoredResourceIds(rawStoredResourceIds, "$.storedResourceIds", issues) ??
        undefined);

  // [M11] 追加の省略可フィールド。
  const rawBedCapacityCurve = obj["bedCapacityCurve"];
  const bedCapacityCurve =
    rawBedCapacityCurve === undefined
      ? null
      : (validateBedCapacityCurve(rawBedCapacityCurve, "$.bedCapacityCurve", issues) ?? undefined);

  // [M50] 追加の省略可フィールド(GDD 12.1 [2026-07-30裁定]・ファイル冒頭 [M50])。
  const rawBuildCost = obj["buildCost"];
  const buildCost =
    rawBuildCost === undefined
      ? null
      : (validateBuildCostContent(rawBuildCost, "$.buildCost", issues) ?? undefined);
  const rawUpgradeCostCurve = obj["upgradeCostCurve"];
  const upgradeCostCurve =
    rawUpgradeCostCurve === undefined
      ? null
      : (validateUpgradeCostCurve(rawUpgradeCostCurve, "$.upgradeCostCurve", issues) ?? undefined);

  if (
    id === undefined ||
    tags === undefined ||
    slots === undefined ||
    lvCurve === undefined ||
    overflowCapPolicy === undefined ||
    footprint === undefined ||
    harshWork === undefined ||
    output === undefined ||
    statWeights === undefined ||
    storageCapacityCurve === undefined ||
    storedResourceIds === undefined ||
    bedCapacityCurve === undefined ||
    buildCost === undefined ||
    upgradeCostCurve === undefined
  ) {
    return fail(issues.list());
  }

  return ok({
    id,
    tags,
    slots,
    lvCurve,
    overflowCapPolicy,
    footprint,
    harshWork,
    output,
    statWeights,
    storageCapacityCurve,
    storedResourceIds,
    bedCapacityCurve,
    buildCost,
    upgradeCostCurve,
  });
}
