// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 難度シード「穏」— M53 / GDD 2.2
//
// ===========================================================================
// 1. GDD 2.2 の 2 語をどう機械可読にしたか(★要ユーザー判断・報告事項)
// ===========================================================================
//   GDD 2.2「ライト層は難度シード『穏』(想起困難頻度0.5倍・(B)出現頻度低)を
//   選べる」は語彙(2 つの効果)のみを与えており、対応する content 係数を
//   明記していない。本モジュールは以下を機械可読の定義として採用する:
//
//   (a) 想起困難頻度0.5倍
//     = `recallRisk` 式(GDD 11.2)の**加算項をすべて** ×0.5:
//       `basePFix` / `moraleBonusMidFix` / `moraleBonusLowFix` / `dispatchWFix`。
//       `basePFix` だけを半分にすると、士気危機や派遣中の加算項が支配的な
//       状況では実際の発生頻度が 0.5 倍にならない(GDD の「頻度」＝最終確率の
//       語感と食い違う)。**上限 `pMaxFix` も ×0.5** にして、クランプの天井が
//       相対的に上がって「頻度0.5倍」の効果を薄めないようにする。
//
//   (b) (B)出現頻度低
//     = (B) 資産が実際に失われる主経路である**探索の負傷蓄積を緩める**:
//       `exploration.byBand[*].injuryPerFailureFix` を ×0.5。(B) の一回性喪失
//       (GDD 7.4)は「保持者の死亡 かつ 記録ゼロ」で発生し、探索中の脱落
//       (GDD 8.5 の負傷累積 → 脱落 → 死亡ゲート)がその主要な引き金の 1 つ
//       である。tech の `lossClass`(rareIrreversible/criticalRecoverable)を
//       穏シードで書き換える案(= (B) の絶対数を減らす)は content の意味を
//       周回設定で動かす変更になり、大移動の獲得式(GDD 10.3)の解釈にも
//       影響するため採らなかった。
//
//   どちらも **content の係数を差し替えるだけ**であり、engine の rules
//   (recall.ts / exploration.ts)は一切変更しない。したがって呼び出し口
//   (`src/newGame.ts`)を経由しない既存 conformance シナリオ・golden vector
//   77 本は構造的に無影響である。
//
// ===========================================================================
// 2. なぜ composition root(engine 外)にあるのか
// ===========================================================================
//   `EngineContent` は 12 個の省略可フィールドを持ち(`schema/engineContent.ts`
//   が正準化して組み立てる形そのまま)、`tsconfig.json` の
//   `exactOptionalPropertyTypes: true` の下では「値を 1 つずつ明示的に書き下す
//   object literal」は `prop: content.prop`(型が `T | undefined`)を
//   `prop?: T` へは代入できない(スプレッドと違い「キーごと省略」が表現できない)。
//   一方 raw な object spread(`{...content, recallRisk: x}`)はこの問題を
//   構造的に持たないが、engine 全域で禁止されている(ADR-028(1) /
//   eslint.config.js の `SYNTAX_STATE_COPY`)。
//
//   本モジュールは EngineContent を**新しい形へ作り替えない**(recallRisk /
//   exploration という中身を差し替えるだけ)ので、`schema/engineContent.ts`
//   (content の内部表現化・engine 外)と同じ層に置くのが自然であり、
//   `src/newGame.ts` と同じ composition root 側に置く。
// ---------------------------------------------------------------------------

import { floorDivInt, fixFromRaw, toRaw, type Fix } from "./engine/fp";
import type {
  EngineContent,
  ExplorationBandParams,
  ExplorationParams,
  RecallRiskParams,
} from "./engine/rules/types";

/** 難度シードの ID(GDD 2.2)。並びは UTF-16 昇順(engine 側 enum と同じ規約)。 */
export const DIFFICULTY_SEED_IDS = ["calm", "standard"] as const;

/** {@link DIFFICULTY_SEED_IDS} のいずれか。 */
export type DifficultySeedId = (typeof DIFFICULTY_SEED_IDS)[number];

/** 未知の文字列が難度シードのいずれかか(型ガード)。 */
export function isDifficultySeedId(value: string): value is DifficultySeedId {
  for (const seedId of DIFFICULTY_SEED_IDS) {
    if (seedId === value) return true;
  }
  return false;
}

/** 既定の難度(GDD が「穏」を明示的に選ぶ層向けと書いているので既定は通常側)。 */
export const DEFAULT_DIFFICULTY_SEED_ID: DifficultySeedId = "standard";

/** `floor(x / 2)`(Fix の半減。中間積を経ないので mulFix のガードは不要)。 */
function halfFix(value: Fix): Fix {
  return fixFromRaw(floorDivInt(toRaw(value), 2));
}

function halvedRecallRisk(params: RecallRiskParams): RecallRiskParams {
  return {
    ...params,
    basePFix: halfFix(params.basePFix),
    pMaxFix: halfFix(params.pMaxFix),
    moraleBonusMidFix: halfFix(params.moraleBonusMidFix),
    moraleBonusLowFix: halfFix(params.moraleBonusLowFix),
    dispatchWFix: halfFix(params.dispatchWFix),
  };
}

function halvedInjuryBand(params: ExplorationBandParams): ExplorationBandParams {
  return { ...params, injuryPerFailureFix: halfFix(params.injuryPerFailureFix) };
}

function halvedInjuryExploration(params: ExplorationParams): ExplorationParams {
  return {
    ...params,
    byBand: {
      deep: halvedInjuryBand(params.byBand.deep),
      far: halvedInjuryBand(params.byBand.far),
      near: halvedInjuryBand(params.byBand.near),
    },
  };
}

/**
 * 難度シードを content へ適用する(GDD 2.2)。**呼び出し口は新規ゲーム生成
 * (`src/newGame.ts`)だけ**であり、tick ループ・大移動からは呼ばれない(§1)。
 *
 * `"standard"` は入力をそのまま返す(参照同一・無変更)。
 */
export function applyDifficultySeed(
  content: EngineContent,
  seedId: DifficultySeedId,
): EngineContent {
  if (seedId === "standard") return content;

  const recallRisk = halvedRecallRisk(content.recallRisk);
  // `exploration` は省略可(exactOptionalPropertyTypes)。undefined を明示的に
  // 代入すると「キー自体は常にある(値が undefined になりうる)」型になり
  // `exploration?: ExplorationParams` へ代入できないため、2 分岐でキーの
  // 有無そのものを分ける(content.reclaim 等の他の省略可フィールドは
  // `...content` のスプレッドがそのまま正しく引き継ぐ)。
  if (content.exploration === undefined) {
    return { ...content, recallRisk };
  }
  return { ...content, recallRisk, exploration: halvedInjuryExploration(content.exploration) };
}
