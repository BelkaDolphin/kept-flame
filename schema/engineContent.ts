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
//     (e) trait 効果(M5)  : **ここだけは reject でなく「記録して読み飛ばす」**。
//                            隣接効果と扱いを変える理由:
//                            GDD 7.2 の MVP 8 trait は健康・成文化速度・想起耐性
//                            のように engine 未実装のシステムを対象にする効果を
//                            正当に持つ(学者・病弱・記憶巧者)。これを reject に
//                            すると **GDD が定めた trait 一覧を content として
//                            書けなくなる**(隣接行列の 1 セルと違い、trait は
//                            複数効果を束ねた entity であり、1 効果の未実装で
//                            entity ごと落とすのは過剰)。
//                            ただし「黙って捨てる」は避けるため、写せなかった
//                            `stat` キーを {@link EngineContent.unrepresentedTraitEffects}
//                            へ機械可読で残し、テストで固定する。
//                            **未知(タイポ等)のキーは従来どおり reject** する
//                            ({@link UNREPRESENTABLE_CONTENT_TRAIT_STATS} に
//                            載っているものだけが読み飛ばし対象)。
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
import {
  FIX_ONE,
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  fixFromRaw,
  mulFix,
  toRaw,
  type Fix,
} from "../src/engine/fp";
import {
  RESIDENT_STAT_IDS,
  STAT_WEIGHT_SUM_FIX,
  isResidentStatId,
  type ResidentStatId,
  type StatWeights,
  type TraitDef,
} from "../src/engine/rules/stats";
import type {
  EngineContent,
  FacilityDef,
  FacilityOutput,
  FacilityStorageDef,
  RecallRiskParams,
  StorageParams,
  TechDef,
} from "../src/engine/rules/types";
import { entityIdFromString, type EntityId } from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";
import type { AdjacencyContent, AdjacencyRule } from "./adjacency";
import type { BalanceContent, StorageParamsContent } from "./balance";
import { IssueCollector, fail, ok, type ValidationResult } from "./common";
import type { ContentBundle } from "./contentBundle";
import type { FacilityContent, FacilityStatWeights } from "./facility";
import type { TechContent } from "./tech";
import type { TraitContent } from "./trait";

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

// --- 1b. trait 効果語彙のレジストリ(§1(e)・M5) ---------------------------

/**
 * `trait.effects[].stat` のうち **engine の生産式へ写せる**キー。
 *
 * ステータス 5 種は裁定 B8 の正本英字 ID(GDD 7.1)。加えて予約語 `yieldMul` を
 * GDD 11.1 の「trait 倍率」項そのものとして受け付ける(rules/stats.ts §3)。
 */
export const TRAIT_YIELD_MUL_STAT_KEY = "yieldMul";

/**
 * GDD 7.2 の trait が対象にし得るが engine が**未実装**のキーと、その理由。
 * ここに載っているキーは reject せず読み飛ばし、
 * {@link EngineContent.unrepresentedTraitEffects} に記録する(§1(e))。
 * 載っていない未知キーは reject する。
 */
export const UNREPRESENTABLE_CONTENT_TRAIT_STATS: { readonly [stat: string]: string } =
  Object.freeze({
    researchSpeed:
      "研究速度への直接倍率(GDD 7.2 学者)は未実装。研究点は施設の産出先 output.kind=research として生産式を通るため、trait 側の別倍率は生産式に写す先が無い",
    health: "住民の健康(GDD 7.2 病弱)は縮約 state に無い(src/engine/state/state.ts §3)",
    codifySpeed: "成文化(GDD 7.2)は rules 未実装(M6 の担当)",
    recallResist:
      "想起困難への耐性(GDD 11.2 記憶巧者)は balance.recallRiskParams.memoryKeeperResist 側で表現しており、trait effect 経由の一般化は未実装",
    morale: "士気への効果(GDD 7.3 楽観/悲観)は士気の更新規則そのものが未実装",
    combatPower: "戦力(GDD 7.1 の派生値・8.2)は襲撃/探索システムに属し未実装",
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

/**
 * [M5] `statWeights` → engine の {@link StatWeights}。
 *
 * **総和がちょうど 1.0 であることを強制する**。総和 1 は「基準 50 のステータスを
 * 持つ就労者 1 人の寄与が厳密に 1.0」という中立性の根拠であり(rules/stats.ts §2)、
 * ここを緩めると全施設の産出が静かにスケールする(誰も気づかない balance 変更)。
 * また rules/stats.ts の mulFixProven の値域証明も重み <= 1.0 を前提にしている。
 */
function toStatWeights(
  raw: FacilityStatWeights,
  path: string,
  issues: IssueCollector,
): StatWeights | undefined {
  const converted = new Map<ResidentStatId, Fix>();
  for (const statId of RESIDENT_STAT_IDS) {
    const fix = toFix(raw[statId], `${path}.${statId}`, issues, `ステータス重み ${statId}`);
    if (fix !== undefined) converted.set(statId, fix);
  }
  if (converted.size !== RESIDENT_STAT_IDS.length) return undefined;

  let sum = FIX_ZERO;
  for (const statId of RESIDENT_STAT_IDS) {
    sum = addFix(sum, converted.get(statId) ?? FIX_ZERO);
  }
  if (toRaw(sum) !== toRaw(STAT_WEIGHT_SUM_FIX)) {
    issues.add(
      path,
      `ステータス重みの総和は 1.0(raw ${String(toRaw(STAT_WEIGHT_SUM_FIX))})が必須` +
        `(実際: raw ${String(toRaw(sum))})。総和 1 が中立性の根拠(src/engine/rules/stats.ts §2)`,
    );
    return undefined;
  }

  return {
    vigor: converted.get("vigor") ?? FIX_ZERO,
    dexterity: converted.get("dexterity") ?? FIX_ZERO,
    intellect: converted.get("intellect") ?? FIX_ZERO,
    fortitude: converted.get("fortitude") ?? FIX_ZERO,
    will: converted.get("will") ?? FIX_ZERO,
  };
}

/** [M5] `storageCapacityCurve` / `storedResourceIds` → {@link FacilityStorageDef}。 */
function toFacilityStorage(
  content: FacilityContent,
  path: string,
  issues: IssueCollector,
): FacilityStorageDef | undefined {
  const curve = content.storageCapacityCurve;
  if (curve === null) return undefined;

  const capacityByLevel: Fix[] = [];
  for (let level = 0; level < curve.length; level++) {
    const raw = curve[level];
    if (raw === undefined) continue;
    const fix = toFix(
      raw,
      `${path}.storageCapacityCurve[${String(level)}]`,
      issues,
      "Lv 別保管容量",
    );
    if (fix !== undefined) capacityByLevel.push(fix);
  }
  if (capacityByLevel.length !== curve.length) return undefined;

  const ids = content.storedResourceIds;
  return {
    capacityByLevel,
    resourceIds:
      ids === null ? null : [...ids].sort(compareUtf16).map((id) => entityIdFromString(id)),
  };
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

  // [M5] 省略可フィールド。JSON に無ければ engine 側の中立既定値を使う
  // (statWeights = 5 種等分 / storage = 容量を提供しない)。
  const statWeights =
    content.statWeights === null
      ? null
      : (toStatWeights(content.statWeights, `${path}.statWeights`, issues) ?? undefined);
  const storage =
    content.storageCapacityCurve === null
      ? null
      : (toFacilityStorage(content, path, issues) ?? undefined);

  if (
    tags === undefined ||
    output === undefined ||
    content.harshWork === null ||
    statWeights === undefined ||
    storage === undefined ||
    outputPerTickByLevel.length !== content.lvCurve.length
  ) {
    return undefined;
  }

  // exactOptionalPropertyTypes ゆえ `x: undefined` を書けないので分岐で組み立てる
  // (キー不在 = 中立既定値、という engine 側の契約を型でも守る)。
  const base = {
    id: entityIdFromString(content.id),
    tags,
    harshWork: content.harshWork,
    outputPerTickByLevel,
    output,
  };
  if (statWeights === null && storage === null) return base;
  if (statWeights === null) return { ...base, storage: storage as FacilityStorageDef };
  if (storage === null) return { ...base, statWeights };
  return { ...base, statWeights, storage };
}

// --- 3b. trait(§1(e)・M5) -------------------------------------------------

/** 1 trait 分の変換結果。写せなかった `stat` キーは呼び出し側で集約する。 */
interface TraitConversion {
  readonly def: TraitDef;
  readonly unrepresented: readonly string[];
}

function toTraitDef(content: TraitContent, issues: IssueCollector): TraitConversion | undefined {
  const path = `trait.${content.id}`;
  const statAddFixById = new Map<ResidentStatId, Fix>();
  const statMulFixById = new Map<ResidentStatId, Fix>();
  const unrepresented: string[] = [];
  let yieldMulFix = FIX_ONE;
  let failed = false;

  for (let i = 0; i < content.effects.length; i++) {
    const effect = content.effects[i];
    if (effect === undefined) continue;
    const effectPath = `${path}.effects[${String(i)}]`;

    if (!isResidentStatId(effect.stat) && effect.stat !== TRAIT_YIELD_MUL_STAT_KEY) {
      const reason = UNREPRESENTABLE_CONTENT_TRAIT_STATS[effect.stat];
      if (reason === undefined) {
        issues.add(
          `${effectPath}.stat`,
          `trait 効果の対象 "${effect.stat}" が未知(写せる対象: ` +
            `${[...RESIDENT_STAT_IDS, TRAIT_YIELD_MUL_STAT_KEY].join(",")}、` +
            `engine 未実装として読み飛ばす対象: ` +
            `${Object.keys(UNREPRESENTABLE_CONTENT_TRAIT_STATS).sort(compareUtf16).join(",")})`,
        );
        failed = true;
        continue;
      }
      // engine 未実装。reject せず記録して読み飛ばす(§1(e))。
      unrepresented.push(effect.stat);
      continue;
    }

    const valueFix = toFix(effect.value, `${effectPath}.value`, issues, "trait 効果量");
    if (valueFix === undefined) {
      failed = true;
      continue;
    }

    if (effect.stat === TRAIT_YIELD_MUL_STAT_KEY) {
      if (effect.op !== "mul") {
        issues.add(
          `${effectPath}.op`,
          `"${TRAIT_YIELD_MUL_STAT_KEY}" は GDD 11.1 の「trait 倍率」項なので op="mul" のみ` +
            `(実際: "${effect.op}")`,
        );
        failed = true;
        continue;
      }
      // 同一 trait 内に複数あれば総乗(合成規則は rules/stats.ts §3 と同じ)。
      yieldMulFix = mulFix(yieldMulFix, valueFix);
      continue;
    }

    const statId = effect.stat;
    if (effect.op === "add") {
      statAddFixById.set(statId, addFix(statAddFixById.get(statId) ?? FIX_ZERO, valueFix));
    } else {
      const previous = statMulFixById.get(statId);
      statMulFixById.set(statId, previous === undefined ? valueFix : mulFix(previous, valueFix));
    }
  }

  if (failed) return undefined;
  return {
    def: { id: entityIdFromString(content.id), statAddFixById, statMulFixById, yieldMulFix },
    unrepresented,
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

// --- 6b. storage(GDD 6.7・M5) ---------------------------------------------

/** resource 定義 ID → Fix の Map を作る(キーは ID 昇順の正準順)。 */
function toResourceFixMap(
  raw: { readonly [resourceId: string]: number },
  path: string,
  issues: IssueCollector,
  what: string,
): ReadonlyMap<EntityId, Fix> | undefined {
  const result = new Map<EntityId, Fix>();
  const keys = Object.keys(raw).sort(compareUtf16);
  let mapped = 0;
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined) continue;
    const fix = toFix(value, `${path}.${key}`, issues, what);
    if (fix === undefined) continue;
    result.set(entityIdFromString(key), fix);
    mapped++;
  }
  return mapped === keys.length ? result : undefined;
}

function toStorageParams(
  content: StorageParamsContent,
  issues: IssueCollector,
): StorageParams | undefined {
  const path = "balance.storage";
  const baseCapacityByResourceId = toResourceFixMap(
    content.baseCapacity,
    `${path}.baseCapacity`,
    issues,
    "基礎保管容量",
  );
  const wasteConversionRatioByResourceId = toResourceFixMap(
    content.wasteConversionRatio,
    `${path}.wasteConversionRatio`,
    issues,
    "廃材変換率",
  );
  const wasteToResearchRatioFix = toFix(
    content.wasteToResearchRatio,
    `${path}.wasteToResearchRatio`,
    issues,
    "廃材→研究点の変換率",
  );
  const buildCostWasteSubstitutionMaxFix = toFix(
    content.buildCostWasteSubstitutionMax,
    `${path}.buildCostWasteSubstitutionMax`,
    issues,
    "増築コストの廃材代替上限",
  );
  const codifyWasteSubstitutionMaxFix = toFix(
    content.codifyWasteSubstitutionMax,
    `${path}.codifyWasteSubstitutionMax`,
    issues,
    "成文化の廃材代替上限",
  );

  if (
    baseCapacityByResourceId === undefined ||
    wasteConversionRatioByResourceId === undefined ||
    wasteToResearchRatioFix === undefined ||
    buildCostWasteSubstitutionMaxFix === undefined ||
    codifyWasteSubstitutionMaxFix === undefined
  ) {
    return undefined;
  }

  return {
    wasteResourceId:
      content.wasteResourceId === null ? null : entityIdFromString(content.wasteResourceId),
    baseCapacityByResourceId,
    wasteConversionRatioByResourceId,
    wasteToResearchRatioFix,
    buildCostWasteSubstitutionMaxFix,
    codifyWasteSubstitutionMaxFix,
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

  // [M5] trait は「未実装効果を記録して読み飛ばす」(§1(e))。
  const traitDefs = new Map<EntityId, TraitDef>();
  const unrepresentedSet = new Set<string>();
  for (const content of [...bundle.trait].sort((l, r) => compareUtf16(l.id, r.id))) {
    const conversion = toTraitDef(content, issues);
    if (conversion === undefined) continue;
    traitDefs.set(conversion.def.id, conversion.def);
    for (const stat of conversion.unrepresented) unrepresentedSet.add(stat);
  }
  const unrepresentedTraitEffects = [...unrepresentedSet].sort(compareUtf16);

  const facilityIds = new Set(bundle.facility.map((f) => f.id));
  const adjacency = toAdjacencyMatrix(bundle.adjacency, facilityIds, issues);
  const recallRisk = toRecallRiskParams(bundle.balance, issues);
  const storage =
    bundle.balance.storage === null
      ? null
      : (toStorageParams(bundle.balance.storage, issues) ?? undefined);

  const coarseTickMinutes = bundle.balance.coarseTickMinutes;
  if (coarseTickMinutes < 1 || coarseTickMinutes > GAME_DAY_TICKS) {
    // engine の stochastic.ts が 1〜1440 を要求する(1 = ADR-014(3) の Fallback)。
    issues.add(
      "balance.coarseTickMinutes",
      `粗粒度ステップ幅 ${String(coarseTickMinutes)} は 1〜${String(GAME_DAY_TICKS)} の整数が必須` +
        "(1 = 1 分 tick Fallback・ADR-014(3))",
    );
  }

  if (
    issues.hasIssues ||
    adjacency === undefined ||
    recallRisk === undefined ||
    storage === undefined
  ) {
    return fail(issues.list());
  }
  // exactOptionalPropertyTypes ゆえ `storage: undefined` を書けないので分岐する
  // (キー不在 = 上限なし、という engine 側の契約を型でも守る)。
  const base = {
    facilityDefs,
    techDefs,
    adjacency,
    recallRisk,
    coarseTickMinutes,
    traitDefs,
    unrepresentedTraitEffects,
  };
  return ok(storage === null ? base : { ...base, storage });
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
