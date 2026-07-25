// ---------------------------------------------------------------------------
// content(検証済み JSON)→ engine 内部表現(EngineContent)への写像 — T7 前半
// ADR-023(1) / ADR-006 / ADR-024 / GDD 6.2 / 11.1 / 11.2 / 11.7
//
// ===========================================================================
// 0. なぜ engine の外に置くのか(配置の根拠)
// ===========================================================================
//   `src/engine/rules/types.ts` §1 が「JSON → 内部表現への変換(値の 1e6 化・
//   ID の検証・effect/target 語彙の写像)は content ロード側の責務」と定めている。
//   加えて **lint が機械的にこの配置を強制している**:
//     - 内部表現化には `adjacency.json` の tagMatrix のような「キーが意味を持つ
//       オブジェクト」の走査が要る = `Object.keys`。engine 内で `Object.keys` を
//       書けるのは canonicalize.ts のみ(eslint.config.js EXEMPT_CANONICALIZE)。
//     - engine から `schema/` への import は非型のものが全面禁止
//       (OUTER_LAYER_GROUPS)。よって engine 内に置くと ContentBundle 型の値を
//       受け取れない。
//   ⇒ ローダーは engine の外、かつ「検証済み content を作る層」= `schema/` に置く。
//   `schema/` は CODEOWNERS 人間専用(ADR リポ構成591行)であり、
//   「どの content 語彙を engine が受け付けるか」という決定論 critical な判断を
//   週次 LLM 運営セッションが勝手に広げられないという性質も同時に得られる。
//
//   逆向きの依存(schema → src/engine)は既に common.ts / contentBundle.ts が
//   持っており(ID 正規表現・canonicalizeJson の単一実装を再利用するため)、
//   依存は内向き一方向のまま。
//
// ===========================================================================
// 1. このモジュールの中心方針: 「写せないものは黙って捨てず reject」
// ===========================================================================
//   engine の縮約 rules が表現できる語彙は content の語彙より**狭い**。
//   狭い側へ写せない content を黙って無視すると、
//     「効いていない content が schema も sim も通過して本番へ出る」
//   という最悪の壊れ方(誰も気づかない balance 変更)になる。よって:
//     (a) 効果種(effect)  : 写せる語彙のレジストリ({@link ENGINE_EFFECT_BY_CONTENT_EFFECT})
//                            に無ければ reject。GDD 6.2 の表にある効果でも
//                            engine が未実装なら「未実装ゆえ reject」と明示する
//                            ({@link UNREPRESENTABLE_CONTENT_EFFECTS})。
//     (b) 適用先(target)  : `any` / タグ7種 / facility 実在 ID の 3 形のみ。
//                            どれでもなければ reject。タグ名と facility ID が
//                            衝突する場合は曖昧なので reject。
//     (c) 縮約 rules 必須フィールド(facility.harshWork / facility.output /
//         balance.durationTicks*): 欠落は既定値で埋めず reject。
//     (d) タグ集合          : engine の ADJACENCY_TAGS(権威)に無いタグは reject。
//                            schema 側 FACILITY_TAGS と二重定義になっている
//                            (engine が schema を import できないため構造上不可避)
//                            2 つのレジストリを**実際に突き合わせる唯一の場所**が
//                            ここである(T5/T6 統合の残作業に対する回答)。
//   例外は投げず {@link ValidationResult} に issues を集める(schema 層の流儀。
//   1 往復で全欠陥を報告 = 先行計測 #11 の reject 再試行コスト削減)。
//   fail-fast したい呼び出し側には {@link loadEngineContentOrThrow} を用意する。
//
// ===========================================================================
// 2. 人間可読値 → 1e6 固定小数点(FP)の変換は 10 進文字列経由で厳密に行う
// ===========================================================================
//   content の数値は人間可読値(0.2 / 174.900625)で書かれ、ADR「共通規約」603行が
//   「ビルド時に 1e6 化」と定める。素朴に `value * 1e6` と書くと倍精度の丸めが
//   混入し得る(例: 0.2 * 1e6 は厳密に 200000 にならない環境依存の余地を残す)。
//   本モジュールは `String(value)`(ECMA-262 Number::toString = 最短往復可能な
//   10 進表記・実装非依存)を 10 進の桁列へ分解し、**小数点位置を 6 桁ずらす
//   整数演算だけ**で raw 値を作る({@link rawFromHumanNumber})。浮動小数の乗算を
//   1 度も通さないので、丸めの余地が構造的に存在しない。
//   小数第 7 位以降に有効桁がある値は 1e6 スケールで厳密表現できないため
//   **reject する**(黙って丸めない)。
// ---------------------------------------------------------------------------

import {
  ADJACENCY_TAGS,
  AdjacencyError,
  createAdjacencyMatrix,
  isTag,
  type AdjacencyEffectKind,
  type AdjacencyMatrix,
  type AdjacencyPairEntry,
  type AdjacencyTarget,
  type Tag,
} from "../src/engine/adjacency";
import { compareUtf16 } from "../src/engine/canonicalize";
import { FIX_SCALE, fixFromRaw, type Fix } from "../src/engine/fp";
import type {
  EngineContent,
  FacilityDef,
  FacilityOutput,
  RecallRiskParams,
  TechDef,
} from "../src/engine/rules/types";
import { entityIdFromString, type EntityId } from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";
import type { AdjacencyContent, AdjacencyRule } from "./adjacency";
import type { BalanceContent } from "./balance";
import { IssueCollector, fail, ok, type ValidationResult } from "./common";
import type { ContentBundle } from "./contentBundle";
import type { FacilityContent } from "./facility";
import type { TechContent } from "./tech";

/** ローダーが reject したときに {@link loadEngineContentOrThrow} が投げる例外。 */
export class EngineContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineContentError";
  }
}

// --- 1. 効果語彙のレジストリ(§1(a)) --------------------------------------

/**
 * content の `effect` 文字列 → engine の効果種({@link AdjacencyEffectKind})。
 *
 * 出典は GDD 6.2 の隣接ルール表。engine の縮約(T5)が持つ効果種は
 * `yieldMul`(産出乗数への加算)だけなので、**産出量に掛かる効果だけ**がここに
 * 載る。新しい効果種を engine に足したら、この表にも 1 行足すこと
 * (表を広げずに engine 側だけ増やすと content から到達できない)。
 */
export const ENGINE_EFFECT_BY_CONTENT_EFFECT: {
  readonly [contentEffect: string]: AdjacencyEffectKind;
} = Object.freeze({
  /** GDD 6.2「熱源 × 熱源 → 鍛冶加工 +20%」。 */
  forgeYield: "yieldMul",
  /** GDD 6.2「湿潤 × 熱源 → 効率 -10%」。産出効率 = 産出乗数。 */
  efficiency: "yieldMul",
  /** GDD 6.2「湿潤 × 菜園 → 食料 +15%」。 */
  foodYield: "yieldMul",
});

/**
 * GDD 6.2 の表にあるが engine の縮約では**表現できない**効果と、その理由。
 *
 * 未知語彙(タイポ等)と「既知だが engine 未実装」を区別してメッセージを出すため
 * に持つ。engine が該当システムを実装したら、この表から
 * {@link ENGINE_EFFECT_BY_CONTENT_EFFECT} へ移す。
 */
export const UNREPRESENTABLE_CONTENT_EFFECTS: { readonly [contentEffect: string]: string } =
  Object.freeze({
    health:
      "住民の健康(GDD 6.2「汚染 × 寝床・療養所 → 健康 -15%/tick」)は縮約 state に無い(state.ts §3)",
    codifySpeed:
      "成文化(GDD 6.2「学芸 3連接 → 成文化 +30%」)は縮約 rules の対象外(rules/types.ts §2)。加えて「3 連接」はタグペア行列では表現できない",
    defense:
      "防衛係数(GDD 6.2「見張り台」)は襲撃システムに属し縮約 rules の対象外(rules/types.ts §2)",
  });

// --- 2. 人間可読値 → FP raw(§2) -----------------------------------------

/** 1e6 スケール = 小数第 6 位まで。{@link FIX_SCALE} と対で維持する。 */
const FIX_DECIMAL_PLACES = 6;

if (FIX_SCALE !== 1_000_000) {
  // ADR-006 は 1e6 固定。ここが変わったら FIX_DECIMAL_PLACES も直す必要がある。
  throw new EngineContentError(
    `engineContent: FIX_SCALE が ${String(FIX_SCALE)} に変わっている(FIX_DECIMAL_PLACES と不整合)`,
  );
}

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

type RawResult =
  { readonly ok: true; readonly raw: number } | { readonly ok: false; readonly message: string };

/**
 * 人間可読値(content の数値)を 1e6 スケールの raw 整数へ厳密変換する(§2)。
 *
 * `String(value)` の 10 進表記を桁列へ分解し、小数点位置を
 * {@link FIX_DECIMAL_PLACES} 桁ずらすだけなので浮動小数の乗算を一切通らない。
 * 小数第 7 位以降に有効桁がある場合と、1e6 倍が安全整数を超える場合は reject。
 */
export function rawFromHumanNumber(value: number): RawResult {
  if (!Number.isFinite(value)) {
    return { ok: false, message: `有限の数値が必須(実際: ${String(value)})` };
  }
  const text = String(value);
  const parts = DECIMAL_PATTERN.exec(text);
  if (parts === null) {
    return { ok: false, message: `10 進表記へ分解できない数値表現 "${text}"` };
  }
  const negative = parts[1] === "-";
  const integerDigits = parts[2] ?? "";
  const fractionDigits = parts[3] ?? "";
  const exponentText = parts[4];
  const exponent = exponentText === undefined ? 0 : Number.parseInt(exponentText, 10);

  // digits を 10^shift 倍した整数が求める raw 値。
  let digits = `${integerDigits}${fractionDigits}`;
  const shift = exponent - fractionDigits.length + FIX_DECIMAL_PLACES;

  if (shift >= 0) {
    digits = `${digits}${"0".repeat(shift)}`;
  } else {
    const dropCount = -shift;
    const dropped = dropCount >= digits.length ? digits : digits.slice(digits.length - dropCount);
    if (/[1-9]/.test(dropped)) {
      return {
        ok: false,
        message:
          `${text} は小数第 ${String(FIX_DECIMAL_PLACES + 1)} 位以降に有効桁があり ` +
          `1e6 固定小数点で厳密表現できない(黙って丸めない・ADR-006)`,
      };
    }
    digits = dropCount >= digits.length ? "0" : digits.slice(0, digits.length - dropCount);
  }

  const magnitude = Number(digits.length === 0 ? "0" : digits);
  if (!Number.isSafeInteger(magnitude)) {
    return {
      ok: false,
      message: `${text} を 1e6 倍した値が安全整数(±(2^53-1))の範囲を超える`,
    };
  }
  const raw = negative ? -magnitude : magnitude;
  return { ok: true, raw: raw === 0 ? 0 : raw };
}

function toFix(value: number, path: string, issues: IssueCollector, what: string): Fix | undefined {
  const result = rawFromHumanNumber(value);
  if (!result.ok) {
    issues.add(path, `${what}: ${result.message}`);
    return undefined;
  }
  return fixFromRaw(result.raw);
}

// --- 3. facility ------------------------------------------------------------

function toEngineTags(
  content: FacilityContent,
  path: string,
  issues: IssueCollector,
): readonly Tag[] | undefined {
  const tags: Tag[] = [];
  for (let i = 0; i < content.tags.length; i++) {
    const tag = content.tags[i];
    if (tag === undefined) continue;
    if (!isTag(tag)) {
      // schema 側 FACILITY_TAGS と engine 側 ADJACENCY_TAGS の食い違い(§1(d))。
      issues.add(
        `${path}.tags[${String(i)}]`,
        `タグ "${tag}" が engine のタグレジストリ(${ADJACENCY_TAGS.join(",")})に無い` +
          `(src/engine/adjacency.ts の ADJACENCY_TAGS が engine 側の権威)`,
      );
      continue;
    }
    tags.push(tag);
  }
  return tags.length === content.tags.length ? tags : undefined;
}

function toEngineOutput(
  content: FacilityContent,
  path: string,
  issues: IssueCollector,
): FacilityOutput | undefined {
  if (content.output === null) {
    issues.add(
      `${path}.output`,
      "縮約 rules の (A)生産 が産出先を要求する(GDD 11.1)。" +
        '`{"kind":"research"}` または `{"kind":"resource","resourceId":"..."}` を指定すること' +
        "(欠落を既定値で埋めない・schema/facility.ts 冒頭 [T7])",
    );
    return undefined;
  }
  if (content.output.kind === "research") return { kind: "research" };
  return { kind: "resource", resourceId: entityIdFromString(content.output.resourceId) };
}

function toFacilityDef(content: FacilityContent, issues: IssueCollector): FacilityDef | undefined {
  const path = `facility.${content.id}`;
  const tags = toEngineTags(content, path, issues);
  const output = toEngineOutput(content, path, issues);

  if (content.harshWork === null) {
    issues.add(
      `${path}.harshWork`,
      "縮約 rules の (C)想起困難 が loadW(過酷業務 ×2.0 / 通常 ×0.5・GDD 11.2)を要求する。" +
        "true / false を明示すること(欠落を既定値で埋めない・schema/facility.ts 冒頭 [T7])",
    );
  }

  const outputPerTickByLevel: Fix[] = [];
  for (let level = 0; level < content.lvCurve.length; level++) {
    const raw = content.lvCurve[level];
    if (raw === undefined) continue;
    const fix = toFix(raw, `${path}.lvCurve[${String(level)}]`, issues, "Lv 別産出");
    if (fix !== undefined) outputPerTickByLevel.push(fix);
  }

  if (
    tags === undefined ||
    output === undefined ||
    content.harshWork === null ||
    outputPerTickByLevel.length !== content.lvCurve.length
  ) {
    return undefined;
  }
  return {
    id: entityIdFromString(content.id),
    tags,
    harshWork: content.harshWork,
    outputPerTickByLevel,
    output,
  };
}

// --- 4. tech ----------------------------------------------------------------

function toTechDef(content: TechContent, issues: IssueCollector): TechDef | undefined {
  const researchCostFix = toFix(
    content.researchCost,
    `tech.${content.id}.researchCost`,
    issues,
    "研究コスト",
  );
  if (researchCostFix === undefined) return undefined;
  return { id: entityIdFromString(content.id), researchCostFix };
}

// --- 5. adjacency -----------------------------------------------------------

function toEngineEffectKind(
  rule: AdjacencyRule,
  path: string,
  issues: IssueCollector,
): AdjacencyEffectKind | undefined {
  const mapped = ENGINE_EFFECT_BY_CONTENT_EFFECT[rule.effect];
  if (mapped !== undefined) return mapped;

  const reason = UNREPRESENTABLE_CONTENT_EFFECTS[rule.effect];
  if (reason !== undefined) {
    issues.add(
      `${path}.effect`,
      `効果 "${rule.effect}" は engine が未実装のため写せない: ${reason}。` +
        "engine 側で実装したうえで schema/engineContent.ts の ENGINE_EFFECT_BY_CONTENT_EFFECT へ移すこと",
    );
    return undefined;
  }
  issues.add(
    `${path}.effect`,
    `効果 "${rule.effect}" が schema/engineContent.ts の ENGINE_EFFECT_BY_CONTENT_EFFECT に無い` +
      `(写せる効果: ${Object.keys(ENGINE_EFFECT_BY_CONTENT_EFFECT).sort(compareUtf16).join(",")})。` +
      "engine へ写せない効果は黙って無視せず reject する(効いていない content を sim に通さないため)",
  );
  return undefined;
}

/** `target` 文字列が `any` を意味する予約語。GDD 6.2 の「全施設に効く」表現。 */
export const ADJACENCY_TARGET_ANY = "any";

function toEngineTarget(
  rule: AdjacencyRule,
  facilityIds: ReadonlySet<string>,
  path: string,
  issues: IssueCollector,
): AdjacencyTarget | undefined {
  if (rule.target === ADJACENCY_TARGET_ANY) return { kind: "any" };

  const asTag = isTag(rule.target);
  const asFacility = facilityIds.has(rule.target);
  if (asTag && asFacility) {
    issues.add(
      `${path}.target`,
      `"${rule.target}" はタグ名と facility ID の両方に一致するため適用先が曖昧` +
        "(facility ID をタグ7種と同じ綴りにしないこと)",
    );
    return undefined;
  }
  if (asTag) return { kind: "tag", tag: rule.target as Tag };
  if (asFacility) return { kind: "facilityDef", defId: rule.target };

  issues.add(
    `${path}.target`,
    `適用先 "${rule.target}" が解決できない。"${ADJACENCY_TARGET_ANY}" / タグ7種` +
      `(${ADJACENCY_TAGS.join(",")}) / facility カテゴリの実在 ID のいずれかが必須`,
  );
  return undefined;
}

function toAdjacencyMatrix(
  content: AdjacencyContent,
  facilityIds: ReadonlySet<string>,
  issues: IssueCollector,
): AdjacencyMatrix | undefined {
  const pairs: AdjacencyPairEntry[] = [];
  // キーの並び順に依存しないよう昇順に固定して走る(ADR-023(1) の正準順)。
  const keys = Object.keys(content.tagMatrix).sort(compareUtf16);
  let mapped = 0;

  for (const key of keys) {
    const path = `adjacency.tagMatrix.${key}`;
    const rule = content.tagMatrix[key];
    if (rule === undefined) continue;

    // キーの形(tagA|tagB・正準形)は schema/adjacency.ts が検証済み。ここでは
    // engine のタグレジストリへ突き合わせる(§1(d))。
    const [rawA, rawB] = key.split("|");
    if (rawA === undefined || rawB === undefined || !isTag(rawA) || !isTag(rawB)) {
      issues.add(
        path,
        `タグペアキー "${key}" が engine のタグレジストリ(${ADJACENCY_TAGS.join(",")})で解決できない`,
      );
      continue;
    }

    const effect = toEngineEffectKind(rule, path, issues);
    const target = toEngineTarget(rule, facilityIds, path, issues);
    const valueFix = toFix(rule.valueFP, `${path}.valueFP`, issues, "タグペア係数");
    if (effect === undefined || target === undefined || valueFix === undefined) continue;

    pairs.push({ tagA: rawA, tagB: rawB, effect: { effect, target, valueFix } });
    mapped++;
  }

  const overcrowdPenalty = toFix(
    content.overcrowd.penaltyPerExcessFP,
    "adjacency.overcrowd.penaltyPerExcessFP",
    issues,
    "過密ペナルティ",
  );
  const overcrowdClamp = toFix(
    content.overcrowd.clampFP,
    "adjacency.overcrowd.clampFP",
    issues,
    "過密クランプ幅",
  );
  const seedOffsetMin = toFix(
    content.seedOffsetRange.min,
    "adjacency.seedOffsetRange.min",
    issues,
    "シード揺らぎ下限",
  );
  const seedOffsetMax = toFix(
    content.seedOffsetRange.max,
    "adjacency.seedOffsetRange.max",
    issues,
    "シード揺らぎ上限",
  );

  if (
    mapped !== keys.length ||
    overcrowdPenalty === undefined ||
    overcrowdClamp === undefined ||
    seedOffsetMin === undefined ||
    seedOffsetMax === undefined
  ) {
    return undefined;
  }

  try {
    return createAdjacencyMatrix({
      pairs,
      overcrowd: {
        threshold: content.overcrowd.threshold,
        penaltyPerExcessFix: overcrowdPenalty,
        clampFix: overcrowdClamp,
      },
      seedOffset: { minFix: seedOffsetMin, maxFix: seedOffsetMax },
    });
  } catch (error) {
    // engine 側の構成時 assert(重複ペア・係数の上界・threshold 等)を
    // 例外のまま外へ出さず issues へ畳む(呼び出し側の扱いを1本化するため)。
    if (error instanceof AdjacencyError) {
      issues.add("adjacency", error.message);
      return undefined;
    }
    throw error;
  }
}

// --- 6. balance -------------------------------------------------------------

function toRecallRiskParams(
  content: BalanceContent,
  issues: IssueCollector,
): RecallRiskParams | undefined {
  const p = content.recallRiskParams;
  const path = "balance.recallRiskParams";
  const fields: readonly (readonly [keyof typeof p & string, number])[] = [
    ["base_p", p.base_p],
    ["p_max", p.p_max],
    ["loadWHarsh", p.loadWHarsh],
    ["loadWNormal", p.loadWNormal],
    ["moraleThresholdMid", p.moraleThresholdMid],
    ["moraleBonusMid", p.moraleBonusMid],
    ["moraleThresholdLow", p.moraleThresholdLow],
    ["moraleBonusLow", p.moraleBonusLow],
    ["dispatchW", p.dispatchW],
    ["masteryResistMax", p.masteryResistMax],
    ["memoryKeeperResist", p.memoryKeeperResist],
  ];
  const converted = new Map<string, Fix>();
  for (const [name, value] of fields) {
    const fix = toFix(value, `${path}.${name}`, issues, name);
    if (fix !== undefined) converted.set(name, fix);
  }

  if (p.durationTicksMin === null || p.durationTicksMax === null) {
    issues.add(
      `${path}.durationTicksMin`,
      "縮約 rules の (C)想起困難 が持続 tick(GDD 11.2「d = 1〜2日」= 1440〜2880)を要求する。" +
        "durationTicksMin / durationTicksMax を指定すること" +
        "(欠落を既定値で埋めない・schema/balance.ts 冒頭 [T7])",
    );
  }

  if (
    converted.size !== fields.length ||
    p.durationTicksMin === null ||
    p.durationTicksMax === null
  ) {
    return undefined;
  }
  const get = (name: string): Fix => {
    const fix = converted.get(name);
    if (fix === undefined) {
      throw new EngineContentError(`engineContent: ${name} の変換結果が無い(実装バグ)`);
    }
    return fix;
  };

  return {
    basePFix: get("base_p"),
    pMaxFix: get("p_max"),
    loadWHarshFix: get("loadWHarsh"),
    loadWNormalFix: get("loadWNormal"),
    moraleThresholdMidFix: get("moraleThresholdMid"),
    moraleBonusMidFix: get("moraleBonusMid"),
    moraleThresholdLowFix: get("moraleThresholdLow"),
    moraleBonusLowFix: get("moraleBonusLow"),
    dispatchWFix: get("dispatchW"),
    masteryResistMaxFix: get("masteryResistMax"),
    memoryKeeperResistFix: get("memoryKeeperResist"),
    memoryKeeperTraitId:
      p.memoryKeeperTraitId === null ? null : entityIdFromString(p.memoryKeeperTraitId),
    durationMinTicks: p.durationTicksMin,
    durationMaxTicks: p.durationTicksMax,
  };
}

// --- 7. 入口 ----------------------------------------------------------------

/**
 * 検証済み content バンドル → engine 内部表現。
 *
 * 前提: 引数は {@link ContentBundle}(= `validateContentBundle` を通ったもの)。
 * 形式・レンジ・グローバル ID 一意性・カテゴリ間参照は済んでいるものとし、
 * ここは **engine の語彙へ写せるか**だけを見る(§1)。
 *
 * Map の反復順は ID の UTF-16 コードユニット昇順に固定する
 * (rules/types.ts §4 が前提にしている正準順。content は配列で来るので
 * canonicalizeJson のキーソートでは並ばず、ここで明示ソートする必要がある)。
 */
export function loadEngineContent(bundle: ContentBundle): ValidationResult<EngineContent> {
  const issues = new IssueCollector();

  const facilityDefs = new Map<EntityId, FacilityDef>();
  for (const content of [...bundle.facility].sort((l, r) => compareUtf16(l.id, r.id))) {
    const def = toFacilityDef(content, issues);
    if (def !== undefined) facilityDefs.set(def.id, def);
  }

  const techDefs = new Map<EntityId, TechDef>();
  for (const content of [...bundle.tech].sort((l, r) => compareUtf16(l.id, r.id))) {
    const def = toTechDef(content, issues);
    if (def !== undefined) techDefs.set(def.id, def);
  }

  const facilityIds = new Set(bundle.facility.map((f) => f.id));
  const adjacency = toAdjacencyMatrix(bundle.adjacency, facilityIds, issues);
  const recallRisk = toRecallRiskParams(bundle.balance, issues);

  const coarseTickMinutes = bundle.balance.coarseTickMinutes;
  if (coarseTickMinutes < 1 || coarseTickMinutes > GAME_DAY_TICKS) {
    // engine の stochastic.ts が 1〜1440 を要求する(1 = ADR-014(3) の Fallback)。
    issues.add(
      "balance.coarseTickMinutes",
      `粗粒度ステップ幅 ${String(coarseTickMinutes)} は 1〜${String(GAME_DAY_TICKS)} の整数が必須` +
        "(1 = 1 分 tick Fallback・ADR-014(3))",
    );
  }

  if (issues.hasIssues || adjacency === undefined || recallRisk === undefined) {
    return fail(issues.list());
  }
  return ok({ facilityDefs, techDefs, adjacency, recallRisk, coarseTickMinutes });
}

/**
 * {@link loadEngineContent} の fail-fast 版。golden vector ハーネスや sim の
 * ように「壊れた content では起動しない」呼び出し側が使う。
 *
 * @throws {EngineContentError} 写せない語彙・欠落フィールドがある場合
 */
export function loadEngineContentOrThrow(bundle: ContentBundle): EngineContent {
  const result = loadEngineContent(bundle);
  if (!result.ok) {
    const detail = result.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
    throw new EngineContentError(
      `content を engine 内部表現へ写せない(${String(result.issues.length)} 件):\n${detail}`,
    );
  }
  return result.value;
}
