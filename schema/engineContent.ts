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
  fixFromInt,
  fixFromRaw,
  floorDivFix,
  floorDivInt,
  mulFix,
  sqrtFix,
  toRaw,
  type Fix,
} from "../src/engine/fp";
import {
  RESIDENT_DERIVED_STAT_IDS,
  RESIDENT_STAT_IDS,
  STAT_WEIGHT_SUM_FIX,
  isResidentDerivedStatId,
  isResidentStatId,
  type ResidentDerivedStatId,
  type ResidentStatId,
  type StatWeights,
  type TraitDef,
} from "../src/engine/rules/stats";
import { DISPATCH_EVENT_NODES_MAX } from "../src/engine/commands";
import {
  COND_COMPARE_OPERATORS,
  COND_LOGICAL_OPERATORS,
  condExprType,
  isCondFunction,
  isCondVariable,
  type CondCompareOperator,
  type CondExpr,
  type CondLogicalOperator,
} from "../src/engine/rules/cond";
import { LOG_TEMPLATE_PLACEHOLDERS } from "../src/engine/rules/event";
import {
  DISTANCE_BANDS,
  isDestroyRecordsMedium,
  isDestroyRecordsScope,
  isDistanceBand,
} from "../src/engine/rules/types";
import type {
  DistanceBand,
  EngineContent,
  EraDef,
  EventBranchDef,
  EventChoiceDef,
  EventDef,
  EventNodeDef,
  EventResult,
  ExodusParams,
  ExplorationBandParams,
  ExplorationParams,
  FacilityCostDef,
  FacilityDef,
  FacilityOutput,
  FacilityStorageDef,
  OutpostHazardParams,
  OutpostParams,
  OutpostTypeDef,
  OutpostUpkeepParams,
  RecallRiskParams,
  ReclaimParams,
  RecordMediaParams,
  RecordMediumParams,
  StorageParams,
  TechDef,
  TownParams,
} from "../src/engine/rules/types";
import {
  entityIdFromString,
  type EntityId,
  type FacilityFootprint,
} from "../src/engine/state/state";
import { GAME_DAY_TICKS } from "../src/engine/stochastic";
import type { AdjacencyContent, AdjacencyRule } from "./adjacency";
import type {
  BalanceContent,
  EraContent,
  ExodusBalanceContent,
  ExplorationContent,
  OutpostBalanceContent,
  ReclaimBalanceContent,
  RecordMediaContent,
  RecordMediumContent,
  StorageParamsContent,
  TownParamsContent,
} from "./balance";
import { IssueCollector, fail, ok, type ValidationResult } from "./common";
import type { ContentBundle } from "./contentBundle";
import type { CondAst, EventChoice, EventContent, EventResultContent } from "./event";
import type { FacilityContent, FacilityStatWeights } from "./facility";
import type { OutpostTypeContent } from "./outpostType";
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
      "[M6 裁定 N7・対象外維持] 成文化そのものは M6 で実装済み(src/engine/rules/codify.ts)だが、" +
      "GDD 6.2 の「学芸 3連接 → 成文化 +30%」は**3 者関係**であり、タグ×タグ対称行列" +
      "(2 者関係)では原理的に表現できない。集合カウント型の効果モデルへ広げると" +
      "隣接解決の観測挙動が変わり algoVersion bump(ADR-016)を伴うため、MVP では対象外を維持する",
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
 * [M7] `trait.effects[].stat` が取り得るキーの全体(エラーメッセージ用・昇順)。
 * 基礎ステ 5 種 + 派生値(`combatPower`)+ 予約語 `yieldMul`。
 */
export const TRAIT_STAT_KEYS: readonly string[] = [
  ...RESIDENT_STAT_IDS,
  ...RESIDENT_DERIVED_STAT_IDS,
  TRAIT_YIELD_MUL_STAT_KEY,
].sort(compareUtf16);

/**
 * GDD 7.2 の trait が対象にし得るが engine が**未実装**のキーと、その理由。
 * ここに載っているキーは reject せず読み飛ばし、
 * {@link EngineContent.unrepresentedTraitEffects} に記録する(§1(e))。
 * 載っていない未知キーは reject する。
 *
 * **[M7] `combatPower` はこの表から外れた**。派生値の算出式が
 * `src/engine/rules/stats.ts` §5 で確定したため、写せる側
 * ({@link RESIDENT_DERIVED_STAT_IDS})へ移っている。実装が追いついたキーは
 * このように表から移すこと(表に残したまま実装すると、効いているのに
 * 「読み飛ばした」と記録される嘘が生じる)。
 */
export const UNREPRESENTABLE_CONTENT_TRAIT_STATS: { readonly [stat: string]: string } =
  Object.freeze({
    researchSpeed:
      "研究速度への直接倍率(GDD 7.2 学者)は未実装。研究点は施設の産出先 output.kind=research として生産式を通るため、trait 側の別倍率は生産式に写す先が無い",
    health: "住民の健康(GDD 7.2 病弱)は縮約 state に無い(src/engine/state/state.ts §3)",
    codifySpeed:
      "[M6] 成文化の所要 tick は rules/codify.ts で実装済みだが、trait 倍率を掛ける先" +
      "(= どの住民が何 tick その記録の作業に就いているか)が未実装。作業者割当は" +
      "成文化を tick ループへ結線する段(M13 以降)の担当なので、それまで読み飛ばす",
    recallResist:
      "想起困難への耐性(GDD 11.2 記憶巧者)は balance.recallRiskParams.memoryKeeperResist 側で表現しており、trait effect 経由の一般化は未実装",
    morale: "士気への効果(GDD 7.3 楽観/悲観)は士気の更新規則そのものが未実装",
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

/**
 * [M49] `slots.lv1〜lv5` → engine の `workerSlotsByLevel`(index 0 = Lv1)。
 *
 * schema 側で「整数・レンジ内・Lv 単調非減少」まで検証済みなので、ここは並べ替え
 * るだけである(検証を二重に持たない)。Lv 数は schema の 5 段固定。
 */
function toWorkerSlotsByLevel(slots: FacilityContent["slots"]): readonly number[] {
  return [slots.lv1, slots.lv2, slots.lv3, slots.lv4, slots.lv5];
}

/**
 * [M16] `footprint` → engine の {@link FacilityDef.footprint}(GDD 6.1)。
 *
 * schema 側で「整数・1〜2」まで検証済み(`schema/facility.ts` の
 * `FOOTPRINT_DIMENSION_RANGE`)なので写すだけである。engine 側の上限
 * `FOOTPRINT_DIM_MAX` との突き合わせは `tests/schema/engineContent*.test.ts` が
 * 固定する(ADJACENCY_TAGS と FACILITY_TAGS の突き合わせと同じ流儀)。
 *
 * 1×1 も**そのまま写す**(engine 側は `FacilityState` の直列化でのみ 1×1 を省略
 * する)。content 内部表現は直列化されないので、ここで畳む理由が無い。
 */
function toFootprint(footprint: FacilityContent["footprint"]): FacilityFootprint {
  return { width: footprint.width, height: footprint.height };
}

/**
 * [M50] `buildCost` / `upgradeCostCurve` → engine の {@link FacilityCostDef}
 * (GDD 12.1 [2026-07-30裁定])。
 *
 * **どちらか一方だけの指定は reject** する。片方だけを許すと「建てるのは有料だが
 * 増築は無料」という盤面が content の書き忘れで静かに成立してしまい、
 * GDD 6.7 の廃材 3 出口(1)(建設/増築コストの 20% 代替)が効く対象も曖昧になる。
 * 欠落そのもの(両方 null)を reject するのは呼び出し側({@link toFacilityDef})。
 */
function toFacilityCost(
  content: FacilityContent,
  path: string,
  issues: IssueCollector,
): FacilityCostDef | undefined {
  const buildCost = content.buildCost;
  const curve = content.upgradeCostCurve;
  if (buildCost === null || curve === null) return undefined;

  const buildFix = toFix(buildCost.amount, `${path}.buildCost.amount`, issues, "建設コスト");
  const upgradeByLevel: Fix[] = [];
  for (let level = 0; level < curve.length; level++) {
    const raw = curve[level];
    if (raw === undefined) continue;
    const fix = toFix(raw, `${path}.upgradeCostCurve[${String(level)}]`, issues, "Lv 別増築コスト");
    if (fix !== undefined) upgradeByLevel.push(fix);
  }
  if (buildFix === undefined || upgradeByLevel.length !== curve.length) return undefined;
  return {
    resourceId: entityIdFromString(buildCost.resourceId),
    buildFix,
    upgradeByLevel,
  };
}

function toFacilityDef(content: FacilityContent, issues: IssueCollector): FacilityDef | undefined {
  const path = `facility.${content.id}`;
  const tags = toEngineTags(content, path, issues);
  const output = toEngineOutput(content, path, issues);

  // [M50] 建設/増築コスト(GDD 12.1 [2026-07-30裁定])。harshWork / output と同じ
  // 「schema では省略可・ローダーでは必須」の二段構え。**既定値で埋めない**のは、
  // 埋めた瞬間に「無料で建つ施設」が content の書き忘れとして静かに成立し、
  // 経済側の全ての検証(sim・拠点網 ROI・廃材3出口)がその前提のまま通るため。
  if (content.buildCost === null || content.upgradeCostCurve === null) {
    issues.add(
      `${path}.buildCost`,
      "配置/増築コマンド(src/engine/commands.ts)が建設/増築コストを要求する" +
        "(GDD 12.1 [2026-07-30裁定])。`buildCost{resourceId, amount}` と " +
        "`upgradeCostCurve`(Lv1〜Lv5 の 5 個)を両方明示すること" +
        "(欠落を既定値で埋めない・schema/facility.ts 冒頭 [M50])",
    );
  }

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
  const cost = toFacilityCost(content, path, issues);

  if (
    tags === undefined ||
    output === undefined ||
    content.harshWork === null ||
    statWeights === undefined ||
    storage === undefined ||
    cost === undefined ||
    outputPerTickByLevel.length !== content.lvCurve.length
  ) {
    return undefined;
  }

  // exactOptionalPropertyTypes ゆえ `x: undefined` を書けないので分岐で組み立てる
  // (キー不在 = 中立既定値、という engine 側の契約を型でも守る)。
  // [M11] 寝床上限は整数の人数なので FP 変換を通さない(そのまま写す)。
  // [M49] 就労スロット(GDD 7.7)は content 側で必須なので条件分岐が要らない。
  // 読むのは engine の commands.ts(住民割当の上限検査)だけで、生産式は
  // 実際の workerIds を数えるため golden vector には影響しない。
  // [M16] footprint は content 側で必須なので条件分岐が要らない(slots と同じ)。
  const workerSlotsByLevel = toWorkerSlotsByLevel(content.slots);
  const footprint = toFootprint(content.footprint);
  // [M50] cost はローダー必須なので条件分岐が要らない(slots / footprint と同じ)。
  const beds = content.bedCapacityCurve;
  const base =
    beds === null
      ? {
          id: entityIdFromString(content.id),
          tags,
          harshWork: content.harshWork,
          outputPerTickByLevel,
          output,
          workerSlotsByLevel,
          footprint,
          cost,
        }
      : {
          id: entityIdFromString(content.id),
          tags,
          harshWork: content.harshWork,
          outputPerTickByLevel,
          output,
          workerSlotsByLevel,
          footprint,
          cost,
          bedCapacityByLevel: [...beds],
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

/** 同一 trait 内の同一対象への効果を合成する(add は総和 / mul は総乗)。 */
function mergeEffect<K>(
  addById: Map<K, Fix>,
  mulById: Map<K, Fix>,
  key: K,
  op: "add" | "mul",
  valueFix: Fix,
): void {
  if (op === "add") {
    addById.set(key, addFix(addById.get(key) ?? FIX_ZERO, valueFix));
    return;
  }
  const previous = mulById.get(key);
  mulById.set(key, previous === undefined ? valueFix : mulFix(previous, valueFix));
}

function toTraitDef(content: TraitContent, issues: IssueCollector): TraitConversion | undefined {
  const path = `trait.${content.id}`;
  const statAddFixById = new Map<ResidentStatId, Fix>();
  const statMulFixById = new Map<ResidentStatId, Fix>();
  // [M7] 派生値(combatPower)は基礎ステと**別名前空間**で持つ(GDD 7.1 の注記)。
  const derivedAddFixById = new Map<ResidentDerivedStatId, Fix>();
  const derivedMulFixById = new Map<ResidentDerivedStatId, Fix>();
  const unrepresented: string[] = [];
  let yieldMulFix = FIX_ONE;
  let failed = false;

  for (let i = 0; i < content.effects.length; i++) {
    const effect = content.effects[i];
    if (effect === undefined) continue;
    const effectPath = `${path}.effects[${String(i)}]`;

    const statId = isResidentStatId(effect.stat) ? effect.stat : undefined;
    const derivedId = isResidentDerivedStatId(effect.stat) ? effect.stat : undefined;
    const isYieldMul = effect.stat === TRAIT_YIELD_MUL_STAT_KEY;
    if (statId === undefined && derivedId === undefined && !isYieldMul) {
      const reason = UNREPRESENTABLE_CONTENT_TRAIT_STATS[effect.stat];
      if (reason === undefined) {
        issues.add(
          `${effectPath}.stat`,
          `trait 効果の対象 "${effect.stat}" が未知(写せる対象: ` +
            `${TRAIT_STAT_KEYS.join(",")}、` +
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

    if (isYieldMul) {
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

    if (derivedId !== undefined) {
      mergeEffect(derivedAddFixById, derivedMulFixById, derivedId, effect.op, valueFix);
      continue;
    }
    if (statId !== undefined) {
      mergeEffect(statAddFixById, statMulFixById, statId, effect.op, valueFix);
    }
  }

  if (failed) return undefined;
  return {
    def: {
      id: entityIdFromString(content.id),
      statAddFixById,
      statMulFixById,
      yieldMulFix,
      derivedAddFixById,
      derivedMulFixById,
    },
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
  // [M6] era / lossClass / prereqs を engine へ渡す(GDD 5.1 / 7.4 / 11.4-1)。
  // prereqs は ID 昇順へ正規化する(rules/techTree.ts の走査順の前提)。
  // [M13] 実地要件の施設(GDD 5 の「該当施設」)。engine は
  //   (1) masteryResist(u,t) の蓄積場所
  //   (2) 想起困難の「当該 tech 関連生産」の解決
  // に使う(rules/techMemory.ts §1)。`recipe` / `count`(N 回稼働)はレシピ系が
  // 未実装なので**写さない**(黙って捨てるのではなく、この注記が唯一の宣言)。
  // facility の実在確認は contentBundle.ts の cross-ref が済ませている。
  return {
    id: entityIdFromString(content.id),
    researchCostFix,
    eraId: content.era,
    lossClass: content.lossClass,
    prereqs: [...content.prereqs].sort(compareUtf16).map((id) => entityIdFromString(id)),
    fieldFacilityId: entityIdFromString(content.fieldRequirement.facility),
  };
}

// --- 4b. era(GDD 5.1)— M6 -------------------------------------------------

function toEraDefs(
  eras: readonly EraContent[],
  issues: IssueCollector,
): ReadonlyMap<string, EraDef> | undefined {
  const result = new Map<string, EraDef>();
  for (const era of [...eras].sort((l, r) => compareUtf16(l.id, r.id))) {
    const path = `balance.eras.${era.id}`;
    const baseEraFix = toFix(era.baseEra, `${path}.baseEra`, issues, "base_era");
    const multiplierFix = toFix(
      era.eraMultiplier,
      `${path}.eraMultiplier`,
      issues,
      "era_multiplier",
    );
    if (baseEraFix === undefined || multiplierFix === undefined) continue;
    result.set(era.id, {
      id: era.id,
      order: era.order,
      baseEraFix,
      multiplierFix,
      gateTechId: entityIdFromString(era.gateTechId),
      criticalPathMax: era.criticalPathMax,
    });
  }
  return result.size === eras.length ? result : undefined;
}

// --- 4c. recordMedia(GDD 11.1 [2026-07-27追補])— M6 -----------------------

function toRecordMediumParams(
  content: RecordMediumContent,
  path: string,
  issues: IssueCollector,
): RecordMediumParams | undefined {
  const costMulFix = toFix(content.costMul, `${path}.costMul`, issues, "媒体コスト倍率");
  const timeMulFix = toFix(content.timeMul, `${path}.timeMul`, issues, "媒体時間倍率");
  const caravanWeightFix = toFix(
    content.caravanWeight,
    `${path}.caravanWeight`,
    issues,
    "キャラバン重み",
  );
  if (costMulFix === undefined || timeMulFix === undefined || caravanWeightFix === undefined) {
    return undefined;
  }
  return {
    costMulFix,
    timeMulFix,
    caravanWeightFix,
    flammable: content.flammable,
    costResourceId: entityIdFromString(content.costResourceId),
  };
}

function toRecordMediaParams(
  content: RecordMediaContent,
  issues: IssueCollector,
): RecordMediaParams | undefined {
  const path = "balance.recordMedia";
  const baseCostFix = toFix(content.baseCost, `${path}.baseCost`, issues, "記録の基準コスト");
  const printingCostMulFix = toFix(
    content.printingCostMul,
    `${path}.printingCostMul`,
    issues,
    "印刷のコスト倍率",
  );
  const printingTimeMulFix = toFix(
    content.printingTimeMul,
    `${path}.printingTimeMul`,
    issues,
    "印刷の時間倍率",
  );
  const stoneTablet = toRecordMediumParams(content.stoneTablet, `${path}.stoneTablet`, issues);
  const paper = toRecordMediumParams(content.paper, `${path}.paper`, issues);

  if (
    baseCostFix === undefined ||
    printingCostMulFix === undefined ||
    printingTimeMulFix === undefined ||
    stoneTablet === undefined ||
    paper === undefined
  ) {
    return undefined;
  }
  return {
    baseCostFix,
    baseDurationTicks: content.baseDurationTicks,
    printingTechId:
      content.printingTechId === null ? null : entityIdFromString(content.printingTechId),
    printingCostMulFix,
    printingTimeMulFix,
    // キーは engine の RECORD_MEDIA(enum)と 1 対 1。content 側で欠落していれば
    // schema/balance.ts が既に reject している。
    byMedium: { paper, stoneTablet },
  };
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

  // [M13] 省略可(欠落 = 定着が蓄積しない)。指定されていれば 1e6 化する。
  const masteryGainFix =
    p.masteryGainPerFieldWorkDay === null
      ? undefined
      : toFix(
          p.masteryGainPerFieldWorkDay,
          `${path}.masteryGainPerFieldWorkDay`,
          issues,
          "masteryGainPerFieldWorkDay",
        );

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
    // [M13] 定着度の蓄積速度。省略時はフィールドごと出さない
    // (`masteryGainPerFieldWorkDayFix` 不在 = 蓄積しない・rules/types.ts)。
    ...(masteryGainFix === undefined ? {} : { masteryGainPerFieldWorkDayFix: masteryGainFix }),
  };
}

// --- 6c. townParams(GDD 7.5〜7.7 / 12.1)— M11 ------------------------------

/**
 * [M11] `townParams` のうち **engine へ写さない**フィールドと、その理由。
 *
 * §1 の「写せないものは黙って捨てず reject」の例外にあたるので、何を写して
 * いないかを機械可読で残す(trait 効果の
 * {@link UNREPRESENTABLE_CONTENT_TRAIT_STATS} と同じ扱い)。
 *
 * `lifespanSigma` は**捨てているのではなく、写す代わりにこの層で検証に使う**:
 * 分位表 `lifespanQuantileMul` が本当に σ の対数正規かを
 * {@link validateLifespanQuantileTable} が整数演算だけで突き合わせる。engine は
 * 検証済みの表だけを引くので σ 自体を持つ必要が無い(持つと「表と σ の
 * どちらが正か」という二重の真実になる)。
 */
export const UNMAPPED_TOWN_PARAM_FIELDS: { readonly [field: string]: string } = Object.freeze({
  lifespanSigma:
    "分位表 lifespanQuantileMul の生成パラメータ。engine へは写さず、本ローダーが" +
    "「表の変動係数 ≒ lifespanSigma」「表の平均 ≒ 1.0」を整数演算で検証する側に使う" +
    "(schema/engineContent.ts の validateLifespanQuantileTable)",
  scarcityArrivalFrequencyMul:
    "GDD 7.6 の頻度 ×1.5。engine へは**周期**へ変換して写す" +
    "(TownParams.scarcityArrivalIntervalTicks)。実行時に固定小数点の除算を" +
    "持ち込まないため、変換はロード時 1 回に閉じる",
});

/**
 * 分位表の平均が 1.0 から外れてよい幅(raw)。離散化(等確率 N 分位の代表値)に
 * よる誤差ぶんの余裕であり、0.01 = 平均寿命が 1% ずれる所まで許す。
 */
const LIFESPAN_TABLE_MEAN_TOLERANCE_RAW = 10_000;

/**
 * 表の変動係数が `lifespanSigma` から外れてよい幅(raw)。0.02。
 * 離散化誤差(N=64 で約 0.0036)より十分広く、「σ を 0.25 と書いたまま表だけ
 * 0.5 相当に差し替える」ような静かな分布変更は捕まる幅。
 */
const LIFESPAN_TABLE_SIGMA_TOLERANCE_RAW = 20_000;

/**
 * [M11] 分位表が「平均 1.0・変動係数 = lifespanSigma の分布」であることを
 * **整数演算だけで**検証する(engine 側 rules/lifespan.ts §1 の番人)。
 *
 * 対数正規かどうかそのもの(形)は超越関数なしには検証できないため、ここで
 * 見るのは 1 次・2 次モーメントと単調性(schema/balance.ts が検証済み)である。
 * 表を丸ごと別分布に差し替えれば通ってしまうが、**平均寿命と散らばりを静かに
 * ずらす**という現実的な事故は確実に捕まる。形の正しさは
 * `tests/engine/lifespan.test.ts` が正規分布 CDF の数値積分で突き合わせる
 * (テストは engine 外なので `Math.exp` を使える)。
 */
export function validateLifespanQuantileTable(
  table: readonly Fix[],
  sigmaFix: Fix,
  path: string,
  issues: IssueCollector,
): boolean {
  const count = table.length;
  if (count === 0) {
    issues.add(path, "分位表が空");
    return false;
  }

  let sumRaw = 0;
  for (const value of table) {
    sumRaw += toRaw(value);
  }
  const meanRaw = floorDivInt(sumRaw, count);
  if (Math.abs(meanRaw - FIX_SCALE) > LIFESPAN_TABLE_MEAN_TOLERANCE_RAW) {
    issues.add(
      path,
      `分位表の平均倍率は 1.0 が必須(実際: raw ${String(meanRaw)}、許容差 ` +
        `${String(LIFESPAN_TABLE_MEAN_TOLERANCE_RAW)})。平均が 1.0 でないと ` +
        "lifespanMeanTicks が実際の平均寿命と一致しない(GDD 7.5)",
    );
    return false;
  }

  // 分散 = Σ(m_i − 平均)² / N。偏差は raw で高々 1e6 オーダーなので
  // mulFix の number 経路(中間積 <= 1e12)に収まる。
  const meanFix = fixFromRaw(meanRaw);
  let varianceSumRaw = 0;
  for (const value of table) {
    const deviation = fixFromRaw(toRaw(value) - meanRaw);
    varianceSumRaw += toRaw(mulFix(deviation, deviation));
  }
  const varianceFix = fixFromRaw(floorDivInt(varianceSumRaw, count));
  const sdFix = sqrtFix(varianceFix);
  const cvFix = floorDivFix(sdFix, meanFix);

  if (Math.abs(toRaw(cvFix) - toRaw(sigmaFix)) > LIFESPAN_TABLE_SIGMA_TOLERANCE_RAW) {
    issues.add(
      path,
      `分位表の変動係数(標準偏差÷平均)は lifespanSigma と一致が必須` +
        `(表: raw ${String(toRaw(cvFix))} / σ: raw ${String(toRaw(sigmaFix))}、許容差 ` +
        `${String(LIFESPAN_TABLE_SIGMA_TOLERANCE_RAW)})。GDD 7.5「σ＝平均の0.25」は変動係数として解釈する`,
    );
    return false;
  }
  return true;
}

function toTownParams(content: TownParamsContent, issues: IssueCollector): TownParams | undefined {
  const path = "balance.townParams";

  const quantileMul: Fix[] = [];
  for (let i = 0; i < content.lifespanQuantileMul.length; i++) {
    const raw = content.lifespanQuantileMul[i];
    if (raw === undefined) continue;
    const fix = toFix(raw, `${path}.lifespanQuantileMul[${String(i)}]`, issues, "寿命の分位倍率");
    if (fix !== undefined) quantileMul.push(fix);
  }
  const sigmaFix = toFix(content.lifespanSigma, `${path}.lifespanSigma`, issues, "寿命の σ");
  const memoryDecayDelayFix = toFix(
    content.memoryDecayDelay,
    `${path}.memoryDecayDelay`,
    issues,
    "memoryDecayDelay",
  );
  const populationFloorBedRatioFix = toFix(
    content.populationFloor.bedRatio,
    `${path}.populationFloor.bedRatio`,
    issues,
    "人口下限の寝床比率",
  );
  const scarcityMulFix = toFix(
    content.scarcityArrivalFrequencyMul,
    `${path}.scarcityArrivalFrequencyMul`,
    issues,
    "不足時の漂着頻度倍率",
  );

  if (
    quantileMul.length !== content.lifespanQuantileMul.length ||
    sigmaFix === undefined ||
    memoryDecayDelayFix === undefined ||
    populationFloorBedRatioFix === undefined ||
    scarcityMulFix === undefined
  ) {
    return undefined;
  }

  if (
    !validateLifespanQuantileTable(quantileMul, sigmaFix, `${path}.lifespanQuantileMul`, issues)
  ) {
    return undefined;
  }

  // GDD 7.6 の「頻度 ×1.5」を周期へ変換する(rules/types.ts TownParams の doc)。
  // 実行時に固定小数点の除算を持ち込まないため、変換はここ 1 回に閉じる。
  const scarcityIntervalTicks = floorDivInt(
    toRaw(floorDivFix(fixFromInt(content.arrivalIntervalTicks), scarcityMulFix)),
    FIX_SCALE,
  );
  if (scarcityIntervalTicks < 1) {
    issues.add(
      `${path}.scarcityArrivalFrequencyMul`,
      `不足時の加入周期が ${String(scarcityIntervalTicks)} tick になる` +
        `(arrivalIntervalTicks ${String(content.arrivalIntervalTicks)} ÷ 頻度倍率)。1 以上が必須`,
    );
    return undefined;
  }

  return {
    lifespanMeanTicks: content.lifespanMeanTicks,
    lifespanQuantileMulFix: quantileMul,
    memoryDecayDelayFix,
    populationFloorBedRatioFix,
    populationFloorAbsolute: content.populationFloor.absolute,
    arrivalIntervalTicks: content.arrivalIntervalTicks,
    scarcityArrivalIntervalTicks: scarcityIntervalTicks,
    joinAgeMinTicks: content.joinAgeMinTicks,
    joinAgeMaxTicks: content.joinAgeMaxTicks,
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

// --- 6c. exploration(GDD 8.1〜8.6・M21)-------------------------------------

/**
 * [M21] 探索パラメータを engine 内部表現へ写す。
 *
 * 難度・R・ノード数は**整数のまま**写す(Fix にしない)。理由は engine 側
 * `rules/types.ts` の {@link ExplorationBandParams} の doc のとおりで、
 * 一様抽選のレンジ幅上限(2,097,152 raw)に掛からないようにするため。
 */
function toExplorationParams(
  content: ExplorationContent,
  issues: IssueCollector,
): ExplorationParams | undefined {
  const path = "balance.exploration";
  const withdrawRewardRatioFix = toFix(
    content.withdrawRewardRatio,
    `${path}.withdrawRewardRatio`,
    issues,
    "撤退時の報酬比率",
  );
  const pressInjuryMulFix = toFix(
    content.pressInjuryMul,
    `${path}.pressInjuryMul`,
    issues,
    "強行時の負傷倍率",
  );
  const withdrawInjuryThresholdFix = toFix(
    content.withdrawInjuryThreshold,
    `${path}.withdrawInjuryThreshold`,
    issues,
    "撤退に踏み切る負傷",
  );
  const equipmentBonusFix = toFix(
    content.equipmentBonus,
    `${path}.equipmentBonus`,
    issues,
    "装備補正",
  );
  const travelSpeedupMaxFix = toFix(
    content.travelSpeedupMax,
    `${path}.travelSpeedupMax`,
    issues,
    "移動短縮の上限",
  );
  const forgoneOutputPerWorkerTickFix = toFix(
    content.forgoneOutputPerWorkerTick,
    `${path}.forgoneOutputPerWorkerTick`,
    issues,
    "逸失生産の単価",
  );
  const rareAssetValueFix = toFix(
    content.rareAssetValue,
    `${path}.rareAssetValue`,
    issues,
    "(B)資産の価値換算",
  );
  const wipeMaxPFix = toFix(content.wipeMaxP, `${path}.wipeMaxP`, issues, "全滅確率の上限");

  const bands: { [K in DistanceBand]?: ExplorationBandParams } = {};
  for (const band of DISTANCE_BANDS) {
    const raw = content.bands[band];
    if (raw === undefined) {
      // schema 側が 3 種必須を強制しているので通常は起きない(型の穴の保険)。
      issues.add(`${path}.bands`, `距離帯 "${band}" が無い(裁定 B7)`);
      continue;
    }
    const bandPath = `${path}.bands.${band}`;
    const rewardPerNodeFix = toFix(raw.rewardPerNode, `${bandPath}.rewardPerNode`, issues, "報酬");
    const injuryPerFailureFix = toFix(
      raw.injuryPerFailure,
      `${bandPath}.injuryPerFailure`,
      issues,
      "失敗時の負傷",
    );
    const casualtyInjuryThresholdFix = toFix(
      raw.casualtyInjuryThreshold,
      `${bandPath}.casualtyInjuryThreshold`,
      issues,
      "脱落閾値",
    );
    const rescueChanceFix = toFix(raw.rescueChance, `${bandPath}.rescueChance`, issues, "保護確率");
    const wipeBasePFix = toFix(raw.wipeBaseP, `${bandPath}.wipeBaseP`, issues, "全滅確率の基準");
    if (
      rewardPerNodeFix === undefined ||
      injuryPerFailureFix === undefined ||
      casualtyInjuryThresholdFix === undefined ||
      rescueChanceFix === undefined ||
      wipeBasePFix === undefined
    ) {
      continue;
    }
    if (raw.nodeCountMax > DISPATCH_EVENT_NODES_MAX) {
      issues.add(
        `${bandPath}.nodeCountMax`,
        `ノード数の上限 ${String(raw.nodeCountMax)} が engine の上界 ` +
          `${String(DISPATCH_EVENT_NODES_MAX)} を超えている(GDD 8.2 / ADR-012(3))`,
      );
      continue;
    }
    bands[band] = {
      baseTravelTicks: raw.baseTravelTicks,
      nodeCountMin: raw.nodeCountMin,
      nodeCountMax: raw.nodeCountMax,
      difficultyMin: raw.difficultyMin,
      difficultyMax: raw.difficultyMax,
      rollRange: raw.rollRange,
      rewardPerNodeFix,
      rewardResourceId: entityIdFromString(raw.rewardResourceId),
      injuryPerFailureFix,
      casualtyInjuryThresholdFix,
      rescueChanceFix,
      wipeBasePFix,
    };
  }

  const near = bands.near;
  const far = bands.far;
  const deep = bands.deep;
  if (
    withdrawRewardRatioFix === undefined ||
    pressInjuryMulFix === undefined ||
    withdrawInjuryThresholdFix === undefined ||
    equipmentBonusFix === undefined ||
    travelSpeedupMaxFix === undefined ||
    forgoneOutputPerWorkerTickFix === undefined ||
    rareAssetValueFix === undefined ||
    wipeMaxPFix === undefined ||
    near === undefined ||
    far === undefined ||
    deep === undefined
  ) {
    return undefined;
  }
  // [M64] `rewardOverflow`(M22 の探索報酬専用の固定上限)は撤廃した。上限は
  // `balance.storage` + 保管施設の加算式 1 系統(GDD 6.7 [2026-08-02裁定])だけが
  // 出所であり、探索報酬も本拠生産と同じ `rules/storage.ts` §2b を通る。
  return {
    byBand: { near, far, deep },
    withdrawRewardRatioFix,
    pressInjuryMulFix,
    withdrawInjuryThresholdFix,
    equipmentBonusFix,
    travelSpeedupMaxFix,
    forgoneOutputPerWorkerTickFix,
    rareAssetValueFix,
    wipeMaxPFix,
  };
}

// --- 6e. event(GDD 8.2〜8.4 / 12.1 / 12.2)— M22 ------------------------------

/**
 * [M22] cond の中間表現({@link CondAst})を engine の {@link CondExpr} へ
 * コンパイルする。
 *
 * ここが「cond DSL が固定小数点で閉じる」の境界である —— 数値リテラルは
 * {@link rawFromHumanNumber}(10 進文字列経由の厳密変換・§2)で Fix になり、
 * 以後 engine 側は raw 整数の比較しか行わない(`src/engine/rules/cond.ts` §2)。
 *
 * 変数名 / 関数名の権威は **engine 側**(`isCondVariable` / `isCondFunction`)で
 * ある。`schema/event.ts` のホワイトリストと二重定義になっているが、両者を
 * 実際に突き合わせる唯一の場所がここになる(trait の語彙表と同じ形・§1(d))。
 */
function toCondExpr(ast: CondAst, path: string, issues: IssueCollector): CondExpr | undefined {
  switch (ast.kind) {
    case "numberLiteral": {
      const valueFix = toFix(ast.value, path, issues, "cond の数値リテラル");
      return valueFix === undefined
        ? undefined
        : { kind: "literal", value: { kind: "number", valueFix } };
    }
    case "stringLiteral":
      return { kind: "literal", value: { kind: "string", value: ast.value } };
    case "booleanLiteral":
      return { kind: "literal", value: { kind: "boolean", value: ast.value } };
    case "variable": {
      if (!isCondVariable(ast.name)) {
        issues.add(path, `cond の変数 "${ast.name}" を engine が解決できない(GDD 12.2)`);
        return undefined;
      }
      return { kind: "variable", name: ast.name };
    }
    case "call": {
      if (!isCondFunction(ast.fn)) {
        issues.add(path, `cond の関数 "${ast.fn}" を engine が解決できない`);
        return undefined;
      }
      if (ast.arg.kind !== "stringLiteral") {
        issues.add(
          path,
          `cond 関数 "${ast.fn}" の引数は string リテラルのみ(trait ID / stat ID を指すため)`,
        );
        return undefined;
      }
      return { kind: "call", fn: ast.fn, arg: { kind: "string", value: ast.arg.value } };
    }
    case "binary": {
      const left = toCondExpr(ast.left, path, issues);
      const right = toCondExpr(ast.right, path, issues);
      if (left === undefined || right === undefined) return undefined;
      if (isCondLogicalOperator(ast.operator)) {
        return { kind: "logical", op: ast.operator, left, right };
      }
      if (isCondCompareOperator(ast.operator)) {
        return { kind: "compare", op: ast.operator, left, right };
      }
      issues.add(path, `cond の演算子 "${ast.operator}" を engine が解決できない(GDD 12.2)`);
      return undefined;
    }
    default: {
      const unhandled: never = ast;
      issues.add(path, `未知の cond 中間表現 ${JSON.stringify(unhandled)}`);
      return undefined;
    }
  }
}

function isCondCompareOperator(op: string): op is CondCompareOperator {
  return (COND_COMPARE_OPERATORS as readonly string[]).includes(op);
}

function isCondLogicalOperator(op: string): op is CondLogicalOperator {
  return (COND_LOGICAL_OPERATORS as readonly string[]).includes(op);
}

/** cond 全体が boolean になるかを型検査する(`rules/cond.ts` §3)。 */
function requireBooleanCond(expr: CondExpr, path: string, issues: IssueCollector): boolean {
  let type: string;
  try {
    type = condExprType(expr);
  } catch (error) {
    issues.add(path, error instanceof Error ? error.message : String(error));
    return false;
  }
  if (type !== "boolean") {
    issues.add(path, `cond 全体は boolean でなければならない(実際: ${type})`);
    return false;
  }
  return true;
}

/** その cond が「無条件成立」(リテラル `true`)か。 */
function isTautologyCond(expr: CondExpr): boolean {
  return expr.kind === "literal" && expr.value.kind === "boolean" && expr.value.value;
}

/** `logTemplate` の `{placeholder}` を洗い出す正規表現(engine の語彙表と突き合わせる)。 */
const LOG_PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function checkLogTemplate(template: string, path: string, issues: IssueCollector): boolean {
  let ok_ = true;
  for (const match of template.matchAll(LOG_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name === undefined) continue;
    if (!LOG_TEMPLATE_PLACEHOLDERS.includes(name)) {
      issues.add(
        path,
        `logTemplate のプレースホルダ "{${name}}" が語彙(${LOG_TEMPLATE_PLACEHOLDERS.join(",")})に無い` +
          "(置換されないまま本番へ出る経路を塞ぐため reject する)",
      );
      ok_ = false;
    }
  }
  return ok_;
}

/** [M22] `branches[].result` を engine の {@link EventResult} へ写す。 */
function toEventResult(
  content: EventResultContent,
  path: string,
  issues: IssueCollector,
): EventResult | undefined {
  if (typeof content === "string") {
    // 説明ラベル(continue / success / failure)は状態を動かさない
    // (schema/event.ts の EVENT_RESULT_LABELS の doc)。
    return content === "withdraw" ? { kind: "withdraw" } : { kind: "continue" };
  }
  if (content.kind === "withdraw") return { kind: "withdraw" };
  if (content.kind === "continue") return { kind: "continue" };
  if (content.kind !== "destroyRecords") {
    issues.add(path, `未知の result kind "${content.kind}"`);
    return undefined;
  }
  const medium = content.medium;
  const scope = content.scope;
  if (
    medium === undefined ||
    scope === undefined ||
    !isDestroyRecordsMedium(medium) ||
    !isDestroyRecordsScope(scope)
  ) {
    // schema 側で検査済み(型の穴の保険)。
    issues.add(path, "destroyRecords の medium / scope が不正");
    return undefined;
  }
  return { kind: "destroyRecords", medium, scope };
}

/** [M22] `nodes[].statWeights` を基礎ステ 5 種 + 派生値 `combatPower` へ分解する(裁定 B8)。 */
function toEventStatWeights(
  raw: Readonly<Record<string, number>>,
  path: string,
  issues: IssueCollector,
): { readonly weights: StatWeights; readonly combatPowerWeightFix: Fix } | undefined {
  const values: { [K in ResidentStatId]?: Fix } = {};
  let combatPowerWeightFix: Fix = FIX_ZERO;
  let failed = false;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (value === undefined) continue;
    const fix = toFix(value, `${path}.${key}`, issues, "statWeights の重み");
    if (fix === undefined) {
      failed = true;
      continue;
    }
    if (isResidentStatId(key)) {
      values[key] = fix;
      continue;
    }
    if (isResidentDerivedStatId(key)) {
      // 派生値は基礎ステと別扱いで解決する(裁定 B8)。現状 combatPower の 1 種のみ。
      combatPowerWeightFix = fix;
      continue;
    }
    // schema 側(strictStatWeights)で検査済み(型の穴の保険)。
    issues.add(`${path}.${key}`, `statWeights のキー "${key}" が正本語彙に無い(裁定 B8)`);
    failed = true;
  }
  if (failed) return undefined;
  return {
    weights: {
      vigor: values.vigor ?? FIX_ZERO,
      dexterity: values.dexterity ?? FIX_ZERO,
      intellect: values.intellect ?? FIX_ZERO,
      fortitude: values.fortitude ?? FIX_ZERO,
      will: values.will ?? FIX_ZERO,
    },
    combatPowerWeightFix,
  };
}

/** [M22] `choices[].effect` を engine 内部表現へ写す(未指定の軸は中立値で埋める)。 */
function toEventChoiceDef(
  choice: EventChoice,
  path: string,
  issues: IssueCollector,
): EventChoiceDef | undefined {
  const successModFix = toModFix(choice.effect.successMod, `${path}.effect.successMod`, issues);
  const rewardModFix = toModFix(choice.effect.rewardMod, `${path}.effect.rewardMod`, issues);
  const difficultyModFix = toModFix(
    choice.effect.difficultyMod,
    `${path}.effect.difficultyMod`,
    issues,
  );
  const injuryRiskMulFix =
    choice.effect.injuryRiskMul === null
      ? FIX_ONE
      : toFix(choice.effect.injuryRiskMul, `${path}.effect.injuryRiskMul`, issues, "負傷倍率");
  if (
    successModFix === undefined ||
    rewardModFix === undefined ||
    difficultyModFix === undefined ||
    injuryRiskMulFix === undefined
  ) {
    return undefined;
  }
  return {
    label: choice.label,
    successModFix,
    rewardModFix,
    difficultyModFix,
    injuryRiskMulFix,
  };
}

/** 未指定(null)の効果軸は 0(中立)。 */
function toModFix(value: number | null, path: string, issues: IssueCollector): Fix | undefined {
  return value === null ? FIX_ZERO : toFix(value, path, issues, "効果係数");
}

/** [M22] event 1 本を engine 内部表現へ写す。 */
function toEventDef(content: EventContent, issues: IssueCollector): EventDef | undefined {
  const path = `event.${content.id}`;
  const nodes: EventNodeDef[] = [];
  let failed = false;
  for (let i = 0; i < content.nodes.length; i++) {
    const node = content.nodes[i];
    if (node === undefined) continue;
    const nodePath = `${path}.nodes[${String(i)}]`;
    const weights = toEventStatWeights(node.statWeights, `${nodePath}.statWeights`, issues);

    const choices: EventChoiceDef[] = [];
    for (let c = 0; c < node.choices.length; c++) {
      const choice = node.choices[c];
      if (choice === undefined) continue;
      const def = toEventChoiceDef(choice, `${nodePath}.choices[${String(c)}]`, issues);
      if (def === undefined) {
        failed = true;
        continue;
      }
      choices.push(def);
    }

    const branches: EventBranchDef[] = [];
    for (let b = 0; b < node.branches.length; b++) {
      const branch = node.branches[b];
      if (branch === undefined) continue;
      const branchPath = `${nodePath}.branches[${String(b)}]`;
      const cond = toCondExpr(branch.condAst, `${branchPath}.cond`, issues);
      const result = toEventResult(branch.result, `${branchPath}.result`, issues);
      const templateOk = checkLogTemplate(branch.logTemplate, `${branchPath}.logTemplate`, issues);
      if (cond === undefined || result === undefined || !templateOk) {
        failed = true;
        continue;
      }
      if (!requireBooleanCond(cond, `${branchPath}.cond`, issues)) {
        failed = true;
        continue;
      }
      branches.push({ cond, result, logTemplate: branch.logTemplate });
    }
    // **最後の branch は無条件成立(リテラル `true`)が必須**。こうしておくと
    // 「どの分岐も成立しない」= 実行時に結果が決まらない状態が構造的に起きない
    // (engine 側 `selectBranchIndex` はその不変条件の上で動く)。
    const last = branches[branches.length - 1];
    if (
      branches.length === node.branches.length &&
      (last === undefined || !isTautologyCond(last.cond))
    ) {
      issues.add(
        `${nodePath}.branches`,
        "最後の branch の cond は無条件成立(リテラル `true`)が必須" +
          "(どの分岐も成立しない = 結果が決まらない状態を構造的に禁じるため)",
      );
      failed = true;
    }

    if (weights === undefined) {
      failed = true;
      continue;
    }
    nodes.push({
      difficulty: node.difficulty,
      rollRange: node.R,
      statWeights: weights.weights,
      combatPowerWeightFix: weights.combatPowerWeightFix,
      choices,
      branches,
    });
  }
  if (failed) return undefined;
  const destTags: DistanceBand[] = [];
  for (const tag of content.destTags) {
    if (!isDistanceBand(tag)) {
      issues.add(`${path}.destTags`, `距離帯 "${tag}" が engine の正本語彙に無い(裁定 B7)`);
      return undefined;
    }
    destTags.push(tag);
  }
  return { id: entityIdFromString(content.id), destTags, nodes };
}

// --- 6f. outpostType / outpost(GDD 9.2 / 12.1)— M24 -------------------------

/**
 * [M24] `capacityCurve` → engine の {@link OutpostTypeDef.supplyPerResidentTickByLevel}。
 * schema 側で「長さ 5・狭義単調増加・[0] = baseSupply」まで検証済み
 * (`schema/outpostType.ts`)なので、ここは 1e6 化するだけである。
 */
function toOutpostSupplyByLevel(
  content: OutpostTypeContent,
  path: string,
  issues: IssueCollector,
): readonly Fix[] | undefined {
  const values: Fix[] = [];
  for (let level = 0; level < content.capacityCurve.length; level++) {
    const raw = content.capacityCurve[level];
    if (raw === undefined) continue;
    const fix = toFix(raw, `${path}.capacityCurve[${String(level)}]`, issues, "Lv 別供給量");
    if (fix !== undefined) values.push(fix);
  }
  return values.length === content.capacityCurve.length ? values : undefined;
}

function toOutpostUpkeepParams(
  content: OutpostTypeContent,
  path: string,
  issues: IssueCollector,
): OutpostUpkeepParams | undefined {
  const baseFoodFix = toFix(
    content.upkeepFormula.baseFood,
    `${path}.upkeepFormula.baseFood`,
    issues,
    "食料維持費",
  );
  const baseMoraleCareFix = toFix(
    content.upkeepFormula.baseMoraleCare,
    `${path}.upkeepFormula.baseMoraleCare`,
    issues,
    "士気ケア維持費",
  );
  if (baseFoodFix === undefined || baseMoraleCareFix === undefined) return undefined;
  return { baseFoodFix, baseMoraleCareFix };
}

function toOutpostHazardParams(
  content: OutpostTypeContent,
  path: string,
  issues: IssueCollector,
): OutpostHazardParams | undefined {
  const intensityFix = toFix(
    content.hazard.intensity,
    `${path}.hazard.intensity`,
    issues,
    "脅威強度",
  );
  const growthPerDayFix = toFix(content.hazard.growth, `${path}.hazard.growth`, issues, "脅威増分");
  const minFix = toFix(content.hazard.min, `${path}.hazard.min`, issues, "脅威下限");
  const maxFix = toFix(content.hazard.max, `${path}.hazard.max`, issues, "脅威上限");
  if (
    intensityFix === undefined ||
    growthPerDayFix === undefined ||
    minFix === undefined ||
    maxFix === undefined
  ) {
    return undefined;
  }
  return { intensityFix, growthPerDayFix, minFix, maxFix };
}

function toOutpostTypeDef(
  content: OutpostTypeContent,
  issues: IssueCollector,
): OutpostTypeDef | undefined {
  const path = `outpostType.${content.id}`;
  const supplyPerResidentTickByLevel = toOutpostSupplyByLevel(content, path, issues);
  const upkeep = toOutpostUpkeepParams(content, path, issues);
  const hazard = toOutpostHazardParams(content, path, issues);
  const shadeSensitivityFix = toFix(
    content.shadeSensitivity,
    `${path}.shadeSensitivity`,
    issues,
    "翳り感度",
  );
  if (
    supplyPerResidentTickByLevel === undefined ||
    upkeep === undefined ||
    hazard === undefined ||
    shadeSensitivityFix === undefined
  ) {
    return undefined;
  }
  return {
    id: entityIdFromString(content.id),
    // resource カテゴリ未実装のため実在確認はしない(facility.output.resourceId と
    // 同じ扱い・schema/outpostType.ts 冒頭)。本拠側と同じ ID 空間を指すことが
    // 二重計上しない構造の根拠(src/engine/rules/outpost.ts §2)。
    resourceId: entityIdFromString(content.resource),
    supplyPerResidentTickByLevel,
    upkeep,
    hazard,
    shadeSensitivityFix,
  };
}

/**
 * [M24] `balance.outpost` → engine の {@link OutpostParams}(GDD 9.2「距離帯係数」)。
 */
function toOutpostParams(
  content: OutpostBalanceContent,
  issues: IssueCollector,
): OutpostParams | undefined {
  const path = "balance.outpost";
  const bands: { [K in DistanceBand]?: Fix } = {};
  for (const band of DISTANCE_BANDS) {
    const raw = content.distanceBandUpkeepMul[band];
    if (raw === undefined) {
      issues.add(`${path}.distanceBandUpkeepMul`, `距離帯 "${band}" が無い(裁定 B7)`);
      continue;
    }
    const fix = toFix(raw, `${path}.distanceBandUpkeepMul.${band}`, issues, "距離帯維持費係数");
    if (fix !== undefined) bands[band] = fix;
  }
  const near = bands.near;
  const far = bands.far;
  const deep = bands.deep;
  if (near === undefined || far === undefined || deep === undefined) return undefined;
  return { distanceBandUpkeepMulFix: { near, far, deep } };
}

// --- 6g. reclaim(GDD 9.1)— M52 ---------------------------------------------

/**
 * [M52] `balance.reclaim` → engine の {@link ReclaimParams}(GDD 9.1 の
 * `base × 1.15^解放数 + cap`)。
 *
 * コスト曲線を**配列へ展開しない**のは意図であり(facility の lvCurve / outpostType の
 * capacityCurve と異なる)、理由は `src/engine/rules/types.ts` の
 * {@link ReclaimParams} の doc にある。ここは 1e6 化と ID 化だけを行う。
 *
 * `initialRubbleCells` は**整数のまま**写す(セル番号は量ではなく添字なので Fix に
 * しない。`ExplorationBandParams` のノード数と同じ扱い)。昇順・重複なし・値域は
 * `schema/balance.ts` の `validateInitialRubbleCells` が既に強制している。
 */
function toReclaimParams(
  content: ReclaimBalanceContent,
  issues: IssueCollector,
): ReclaimParams | undefined {
  const path = "balance.reclaim";
  const baseCostFix = toFix(content.baseCost, `${path}.baseCost`, issues, "開墾の基準コスト");
  const costGrowthFix = toFix(content.costGrowth, `${path}.costGrowth`, issues, "開墾コストの底");
  const costCapFix = toFix(content.costCap, `${path}.costCap`, issues, "開墾コストの上限");
  if (baseCostFix === undefined || costGrowthFix === undefined || costCapFix === undefined) {
    return undefined;
  }
  return {
    baseCostFix,
    costGrowthFix,
    costCapFix,
    costResourceId: entityIdFromString(content.costResourceId),
    initialRubbleCells: [...content.initialRubbleCells],
  };
}

// --- 6h. exodus(GDD 10.2〜10.5)— M28 -----------------------------------------

/**
 * [M28] `balance.exodus` → engine の {@link ExodusParams}(GDD 10.2〜10.5)。
 *
 * 比率と獲得係数だけを 1e6 化し、**継承点そのものは整数のまま**写す
 * (点は量ではなく単位のない数え上げなので、`ExplorationBandParams` のノード数や
 * `initialRubbleCells` と同じ扱い)。段階コスト列の長さ = 上限段数であり、
 * これが GDD 11.4-6「青天井にならない」の構造的な根拠になる。
 */
function toExodusParams(
  content: ExodusBalanceContent,
  issues: IssueCollector,
): ExodusParams | undefined {
  const path = "balance.exodus";
  const caravanRatioFix = toFix(
    content.caravanRatio,
    `${path}.caravanRatio`,
    issues,
    "キャラバン容量比",
  );
  const crewRatioFix = toFix(content.crewRatio, `${path}.crewRatio`, issues, "乗員定員比");
  const eraPointsFix = toFix(content.eraPoints, `${path}.eraPoints`, issues, "到達エラ係数");
  const codifyRatePointsFix = toFix(
    content.codifyRatePoints,
    `${path}.codifyRatePoints`,
    issues,
    "成文化率係数",
  );
  const survivorPointsFix = toFix(
    content.survivorPoints,
    `${path}.survivorPoints`,
    issues,
    "生存住民係数",
  );
  if (
    caravanRatioFix === undefined ||
    crewRatioFix === undefined ||
    eraPointsFix === undefined ||
    codifyRatePointsFix === undefined ||
    survivorPointsFix === undefined
  ) {
    return undefined;
  }

  const expectedTabletsByEra = new Map<string, number>();
  for (const eraId of Object.keys(content.expectedTabletsByEra).sort(compareUtf16)) {
    const value = content.expectedTabletsByEra[eraId];
    if (value !== undefined) expectedTabletsByEra.set(eraId, value);
  }

  // 3 系統は engine 既知の enum。schema 側(validateInheritBonusPerTier)が
  // 3 つとも存在することを保証しているので、ここは欠落を既定で埋めず止める。
  const caravanBonus = content.inheritBonusPerTier["caravanCapacity"];
  const crewBonus = content.inheritBonusPerTier["crewCapacity"];
  const stockBonus = content.inheritBonusPerTier["startingStock"];
  if (caravanBonus === undefined || crewBonus === undefined || stockBonus === undefined) {
    issues.add(
      `${path}.inheritBonusPerTier`,
      "継承系統 3 種(caravanCapacity / crewCapacity / startingStock)が揃っていない",
    );
    return undefined;
  }

  return {
    caravanRatioFix,
    expectedTabletsByEra,
    crewRatioFix,
    eraPointsFix,
    codifyRatePointsFix,
    survivorPointsFix,
    tierCosts: [...content.inheritTierCosts],
    trackBonusPerTier: {
      caravanCapacity: caravanBonus,
      crewCapacity: crewBonus,
      startingStock: stockBonus,
    },
    startingStockResourceId: entityIdFromString(content.startingStockResourceId),
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
  // [M6] どちらも省略可。キー不在 = engine 側の「エラ概念なし / 成文化不可」既定。
  const eraDefs =
    bundle.balance.eras === null ? null : (toEraDefs(bundle.balance.eras, issues) ?? undefined);
  const recordMedia =
    bundle.balance.recordMedia === null
      ? null
      : (toRecordMediaParams(bundle.balance.recordMedia, issues) ?? undefined);
  // [M11] 省略可。キー不在 = engine 側の「寿命も晴天漂着も走らない」既定。
  const town =
    bundle.balance.townParams === null
      ? null
      : (toTownParams(bundle.balance.townParams, issues) ?? undefined);
  // [M21] 省略可。キー不在 = engine 側の「派遣そのものができない」既定。
  const exploration =
    bundle.balance.exploration === null
      ? null
      : (toExplorationParams(bundle.balance.exploration, issues) ?? undefined);

  // [M22] event(GDD 12.1)。**空なら EngineContent へキーを足さない**
  //   (= M22 以前と 1 bit も違わない = 派遣は M21 の手続き生成へフォールバック)。
  const eventDefs = new Map<EntityId, EventDef>();
  for (const content of [...bundle.event].sort((l, r) => compareUtf16(l.id, r.id))) {
    const def = toEventDef(content, issues);
    if (def !== undefined) eventDefs.set(def.id, def);
  }

  // [M24] outpostType(GDD 9.2 / 12.1)。**空なら EngineContent へキーを足さない**
  //   (= M24 以前と 1 bit も違わない = 拠点系 rules は呼ばれると RulesError で止まる)。
  const outpostTypeDefs = new Map<EntityId, OutpostTypeDef>();
  for (const content of [...bundle.outpostType].sort((l, r) => compareUtf16(l.id, r.id))) {
    const def = toOutpostTypeDef(content, issues);
    if (def !== undefined) outpostTypeDefs.set(def.id, def);
  }
  // [M24] 省略可。キー不在 = engine 側の「拠点の維持費が求まらない」既定。
  const outpost =
    bundle.balance.outpost === null
      ? null
      : (toOutpostParams(bundle.balance.outpost, issues) ?? undefined);
  // [M52] 省略可。キー不在 = engine 側の「開墾できない」既定(瓦礫の**判定**は
  //   state 権威なのでブロック不在でも効く・src/engine/rules/reclaim.ts §1)。
  const reclaim =
    bundle.balance.reclaim === null
      ? null
      : (toReclaimParams(bundle.balance.reclaim, issues) ?? undefined);
  // [M28] 省略可。キー不在 = engine 側の「大移動も継承ボーナス購入もできない」既定。
  const exodus =
    bundle.balance.exodus === null
      ? null
      : (toExodusParams(bundle.balance.exodus, issues) ?? undefined);

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
    storage === undefined ||
    eraDefs === undefined ||
    recordMedia === undefined ||
    town === undefined ||
    exploration === undefined ||
    outpost === undefined ||
    reclaim === undefined ||
    exodus === undefined
  ) {
    return fail(issues.list());
  }
  // exactOptionalPropertyTypes ゆえ `storage: undefined` を書けないので、
  // 省略可フィールドは「値があるときだけキーを足す」形で組み立てる
  // (キー不在 = 各既定、という engine 側の契約を型でも守る)。
  const base = {
    facilityDefs,
    techDefs,
    adjacency,
    recallRisk,
    coarseTickMinutes,
    traitDefs,
    unrepresentedTraitEffects,
  };
  const withStorage = storage === null ? base : { ...base, storage };
  const withEras = eraDefs === null ? withStorage : { ...withStorage, eraDefs };
  const withMedia = recordMedia === null ? withEras : { ...withEras, recordMedia };
  const withTown = town === null ? withMedia : { ...withMedia, town };
  const withExploration = exploration === null ? withTown : { ...withTown, exploration };
  const withEvents = eventDefs.size === 0 ? withExploration : { ...withExploration, eventDefs };
  // [M24] outpostTypeDefs は空でもキーを持たせない(空 Map は「拠点タイプが
  // 1 つも無い」に相当し、requireOutpostTypeDef が常に RulesError で止まる形で
  // 十分表現できるため、event の「1 件以上あるときだけキーを持つ」規約と揃える)。
  const withOutpostTypes =
    outpostTypeDefs.size === 0 ? withEvents : { ...withEvents, outpostTypeDefs };
  const withOutpost = outpost === null ? withOutpostTypes : { ...withOutpostTypes, outpost };
  // [M52] 開墾(GDD 9.1)。ブロック不在なら EngineContent へキーを足さない。
  const withReclaim = reclaim === null ? withOutpost : { ...withOutpost, reclaim };
  // [M28] 大移動 / 継承点(GDD 10.2〜10.5)。同上。
  return ok(exodus === null ? withReclaim : { ...withReclaim, exodus });
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
