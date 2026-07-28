// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- テックツリーの静的解析 — GDD 5.1 / 7.4 / 11.4-1 / 12.3
//
// ===========================================================================
// 1. このモジュールが答える 4 つの問い
// ===========================================================================
//   (a) どのテックが**クリティカルパス**か(GDD 5.1)
//       = 各エラの壁テック(`era.gateTechId`)とその前提の閉包のうち、
//         **同じエラに属するもの**。エラ跨ぎの前提は当該エラの n に算入しない
//         (GDD 5.1「エラ内リセット式」の意味)。
//   (b) あるテックを研究する瞬間に取り得る **n の範囲**(GDD 12.3 の動的 n 問題)
//   (c) `researchCost` 個別値がその全域で `base_era × 1.2^n` の ±25% に
//       収まっているか(GDD 12.3)
//   (d) 全クリティカルパステックが**到達可能**か(GDD 11.4-1)。加えて
//       (A) テックが (B) テックに依存していないか(GDD 7.4 の再取得保証)
//
// ===========================================================================
// 2. n の範囲の導出(GDD 12.3「到達可能 n の全域チェック」の実体)
// ===========================================================================
//   n = 「そのテックを研究する時点で**解禁済み**の、同一エラのクリティカルパス
//   テック数」。プレイヤーの研究順で変わるので、範囲で押さえる:
//
//     nMin(T) = |ancestors(T) ∩ critical(era)|
//               T より先に必ず解禁されているクリティカル数(前提の閉包)
//     nMax(T) = |critical(era)| − |{c ∈ critical(era) : c = T または T ∈ ancestors(c)}|
//               T 自身と「T を前提に持つクリティカル」は T より先に解禁できない
//
//   鎖状のクリティカルパス(MVP の E1〜E3 はこれ)では、位置 k のクリティカル
//   テックについて nMin = nMax = k になり n が一意に定まる。葉テックは
//   nMin = 前提側のクリティカル数、nMax = そのエラの全クリティカル数になる。
//
//   **オーサリング規則(この式から導かれる帰結)**: ±25% の帯を n の全域で
//   満たすには `1.2^(nMax−nMin) <= 1.25/0.75 = 1.666…` が必要 = **nMax−nMin <= 2**
//   (1.2² = 1.44 は可、1.2³ = 1.728 は不可)。つまり「クリティカル 4 本のエラで、
//   1 本目のクリティカルにだけぶら下がる葉」は原理的に帯へ入らない。葉は
//   十分深い前提を持たせること。
//
// ===========================================================================
// 3. なぜ content ロード経路(`loadEngineContent`)で強制しないのか
// ===========================================================================
//   golden vector のシナリオは `researchCost` を 8000 / 80000 のような
//   **意図的に帯の外の値**へ patch して (B) 完了 tick の境界を観測している
//   (conformance/scenarios.ts の sc03 / sc04 / sc15)。レンジ検査をロード経路に
//   入れるとこれらのシナリオが content 検証で落ち、golden vector が作れなくなる。
//   よって本モジュールは**独立した検査関数**として提供し、実 content に対して
//   テスト(= CI ゲート)から回す。GDD 12.4 の運営パイプラインでも、
//   スキーマ検証段の 1 ステップとしてここを呼ぶ想定。
//
// ===========================================================================
// 4. 決定論
// ===========================================================================
//   返す配列は全て **ID の UTF-16 昇順**。グラフ探索も昇順の反復で行うので、
//   同じ content からは必ず同じ順序の結果が出る(GDD 11.7)。
//   1.2^n は**整数 n の反復乗算**で作る(ADR-006: 非整数べき乗禁止)。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import { FIX_ONE, addFix, fixFromRaw, mulFix, subFix, toRaw, type Fix } from "../fp";
import type { EntityId } from "../state/state";
import {
  RulesError,
  lossClassOfTech,
  prereqsOfTech,
  type EngineContent,
  type EraDef,
  type TechDef,
} from "./types";

// --- 1. 定数 ---------------------------------------------------------------

/** GDD 5.1 のエラ内逓増率 1.2。 */
export const RESEARCH_COST_GROWTH_FIX: Fix = fixFromRaw(1_200_000);

/**
 * GDD 12.3 の許容幅 X の既定値 = 25%(GDD の例示値)。
 * §2 のとおり、この値は「葉テックの n 範囲は 2 以内」というオーサリング規則と
 * 対で意味を持つ。緩めると葉を浅くぶら下げられるようになる代わりに、
 * コストの実効レンジが広がる。
 */
export const RESEARCH_COST_TOLERANCE_FIX: Fix = fixFromRaw(250_000);

// --- 2. 検査結果 -----------------------------------------------------------

/** 検査で見つかった不整合 1 件。 */
export interface TechTreeIssue {
  /** 対象テック(エラ単位の問題なら null)。 */
  readonly techId: EntityId | null;
  /** 対象エラ(テック単位の問題でも所属エラが分かれば入る)。 */
  readonly eraId: string | null;
  readonly message: string;
}

// --- 3. エラとクリティカルパス(§1(a)) -------------------------------------

/** エラ定義を order 昇順(同 order は ID 昇順)で返す。 */
export function erasInOrder(content: EngineContent): readonly EraDef[] {
  const eras = content.eraDefs;
  if (eras === undefined) return [];
  return [...eras.values()].sort((l, r) =>
    l.order === r.order ? compareUtf16(l.id, r.id) : l.order - r.order,
  );
}

/** 指定エラに属する tech 定義を ID 昇順で返す。 */
export function techsOfEra(content: EngineContent, eraId: string): readonly TechDef[] {
  const result: TechDef[] = [];
  for (const def of content.techDefs.values()) {
    if (def.eraId === eraId) result.push(def);
  }
  return result.sort((l, r) => compareUtf16(l.id, r.id));
}

/**
 * `techId` の前提の閉包(自身を含まない・ID 昇順)。content に無い前提 ID は
 * 結果に含めない(実在確認は {@link reachabilityIssues} の担当)。
 */
export function prereqClosure(content: EngineContent, techId: EntityId): readonly EntityId[] {
  const seen = new Set<EntityId>();
  const stack: EntityId[] = [techId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (!content.techDefs.has(current)) continue;
    for (const prereq of prereqsOfTech(content, current)) {
      if (seen.has(prereq)) continue;
      seen.add(prereq);
      stack.push(prereq);
    }
  }
  seen.delete(techId);
  return [...seen].sort(compareUtf16);
}

/**
 * エラのクリティカルパス(§1(a))= 壁テック + その前提の閉包 ∩ 同一エラ。ID 昇順。
 *
 * 壁テックが content に無い場合は空を返す(欠落の報告は
 * {@link reachabilityIssues} が行う。ここで例外にすると検査が 1 件目で止まる)。
 */
export function criticalPathTechIds(content: EngineContent, eraId: string): readonly EntityId[] {
  const era = content.eraDefs?.get(eraId);
  if (era === undefined) return [];
  if (!content.techDefs.has(era.gateTechId)) return [];

  const inEra = (id: EntityId): boolean => content.techDefs.get(id)?.eraId === eraId;
  const result: EntityId[] = [];
  if (inEra(era.gateTechId)) result.push(era.gateTechId);
  for (const id of prereqClosure(content, era.gateTechId)) {
    if (inEra(id)) result.push(id);
  }
  return [...new Set(result)].sort(compareUtf16);
}

/** そのテックがクリティカルパス上か。 */
export function isCriticalPathTech(content: EngineContent, techId: EntityId): boolean {
  const eraId = content.techDefs.get(techId)?.eraId;
  if (eraId === undefined) return false;
  return criticalPathTechIds(content, eraId).includes(techId);
}

// --- 4. n の範囲(§2) -----------------------------------------------------

/** 到達可能な n の範囲(両端含む)。 */
export interface NRange {
  readonly min: number;
  readonly max: number;
}

/**
 * `techId` を研究する時点で取り得る n の範囲(§2)。エラ不明なら null。
 *
 * @throws {RulesError} 範囲が反転した場合(グラフ構築のバグ検出)
 */
export function reachableNRange(content: EngineContent, techId: EntityId): NRange | null {
  const eraId = content.techDefs.get(techId)?.eraId;
  if (eraId === undefined || content.eraDefs?.get(eraId) === undefined) return null;

  const critical = criticalPathTechIds(content, eraId);
  const ancestors = new Set(prereqClosure(content, techId));

  let min = 0;
  for (const id of critical) {
    if (ancestors.has(id)) min++;
  }

  // T 自身と「T を前提に持つクリティカル」は T より先に解禁できない。
  let blocked = 0;
  for (const id of critical) {
    if (id === techId || prereqClosure(content, id).includes(techId)) blocked++;
  }
  const max = critical.length - blocked;

  if (min > max) {
    throw new RulesError(
      `reachableNRange: tech "${techId}" の n 範囲が反転している(min ${String(min)} > max ${String(max)})`,
    );
  }
  return { min, max };
}

/**
 * `base_era × 1.2^n`(GDD 5.1)。**整数 n の反復乗算**で作る(ADR-006 の
 * 非整数べき乗禁止)。n は 0 以上の安全整数であること。
 *
 * @throws {RulesError} n が 0 以上の整数でない場合
 */
export function idealResearchCost(baseEraFix: Fix, n: number): Fix {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RulesError(`idealResearchCost: n ${String(n)} は 0 以上の整数`);
  }
  let value = baseEraFix;
  for (let i = 0; i < n; i++) {
    value = mulFix(value, RESEARCH_COST_GROWTH_FIX);
  }
  return value;
}

// --- 5. 検査(§1(c)(d)) --------------------------------------------------

/**
 * GDD 12.3: `researchCost` 個別値が、到達可能な n の**全域**で
 * `base_era × 1.2^n` の ±tolerance に収まっているか。
 *
 * エラ不明のテックは対象外(エラ表が無い content では検査そのものが空になる)。
 */
export function researchCostBandIssues(
  content: EngineContent,
  toleranceFix: Fix = RESEARCH_COST_TOLERANCE_FIX,
): readonly TechTreeIssue[] {
  const issues: TechTreeIssue[] = [];
  const lowRatio = subFix(FIX_ONE, toleranceFix);
  const highRatio = addFix(FIX_ONE, toleranceFix);

  for (const techId of sortedTechIds(content)) {
    const def = content.techDefs.get(techId);
    if (def === undefined) continue;
    const eraId = def.eraId;
    if (eraId === undefined) continue;
    const era = content.eraDefs?.get(eraId);
    if (era === undefined) continue;
    const range = reachableNRange(content, techId);
    if (range === null) continue;

    for (let n = range.min; n <= range.max; n++) {
      const ideal = idealResearchCost(era.baseEraFix, n);
      const low = mulFix(ideal, lowRatio);
      const high = mulFix(ideal, highRatio);
      const cost = toRaw(def.researchCostFix);
      if (cost < toRaw(low) || cost > toRaw(high)) {
        issues.push({
          techId,
          eraId,
          message:
            `researchCost raw ${String(cost)} が n=${String(n)} の帯 ` +
            `[${String(toRaw(low))}, ${String(toRaw(high))}](base_era raw ${String(toRaw(era.baseEraFix))} × 1.2^${String(n)})` +
            ` から外れている(到達可能 n = ${String(range.min)}〜${String(range.max)}・GDD 12.3)`,
        });
        break; // 1 テックにつき 1 件(最初に外れた n)だけ報告する。
      }
    }
  }
  return issues;
}

/**
 * GDD 11.4-1「全クリティカルパステックが到達可能」の静的版 + GDD 7.4 の
 * 再取得保証。以下を検査する:
 *
 *   (1) 各エラの壁テック(`gateTechId`)が content にあり、そのエラに属する
 *   (2) クリティカルパステックの前提が全て content に実在する(到達可能)
 *   (3) クリティカルパステックが 1 本も (B) rareIrreversible でない
 *       ((A) の再取得保証が (B) の永久喪失で壊れないこと・GDD 7.4)
 *   (4) (A) テックの前提の閉包に (B) テックが混ざっていない((3) の一般形)
 *   (5) 導出したクリティカルパス本数が `era.criticalPathMax` 以内(GDD 5.1 の
 *       「n がエラ別上限を超えないこと」の機械強制)
 */
export function reachabilityIssues(content: EngineContent): readonly TechTreeIssue[] {
  const issues: TechTreeIssue[] = [];

  for (const era of erasInOrder(content)) {
    const gate = content.techDefs.get(era.gateTechId);
    if (gate === undefined) {
      issues.push({
        techId: era.gateTechId,
        eraId: era.id,
        message: `壁テック "${era.gateTechId}" が content に無い(GDD 12.1 era.gateTechId)`,
      });
      continue;
    }
    if (gate.eraId !== era.id) {
      issues.push({
        techId: era.gateTechId,
        eraId: era.id,
        message: `壁テック "${era.gateTechId}" の era は "${String(gate.eraId)}" でエラ "${era.id}" と食い違う`,
      });
    }

    const critical = criticalPathTechIds(content, era.id);
    if (critical.length > era.criticalPathMax) {
      issues.push({
        techId: null,
        eraId: era.id,
        message:
          `クリティカルパスが ${String(critical.length)} 本で criticalPathMax ` +
          `${String(era.criticalPathMax)} を超えている(GDD 5.1「n がエラ別上限を超えないこと」)`,
      });
    }
    for (const techId of critical) {
      if (lossClassOfTech(content, techId) !== "criticalRecoverable") {
        issues.push({
          techId,
          eraId: era.id,
          message:
            "クリティカルパステックが (B) rareIrreversible になっている" +
            "(GDD 7.4: 取り返しのつかない喪失は (B) のみ・(A) には使わない)",
        });
      }
    }
  }

  for (const techId of sortedTechIds(content)) {
    for (const prereq of prereqsOfTech(content, techId)) {
      if (!content.techDefs.has(prereq)) {
        issues.push({
          techId,
          eraId: content.techDefs.get(techId)?.eraId ?? null,
          message: `前提 "${prereq}" が content に無い(到達不能・GDD 11.4-1)`,
        });
      }
    }
    if (lossClassOfTech(content, techId) !== "criticalRecoverable") continue;
    for (const ancestor of prereqClosure(content, techId)) {
      if (lossClassOfTech(content, ancestor) !== "criticalRecoverable") {
        issues.push({
          techId,
          eraId: content.techDefs.get(techId)?.eraId ?? null,
          message:
            `(A) criticalRecoverable なのに前提 "${ancestor}" が (B) rareIrreversible` +
            "(前者の再取得保証が後者の永久喪失で壊れる・GDD 7.4 / 11.4-2)",
        });
      }
    }
  }

  return issues;
}

/** {@link researchCostBandIssues} と {@link reachabilityIssues} をまとめて回す。 */
export function techTreeIssues(content: EngineContent): readonly TechTreeIssue[] {
  return [...reachabilityIssues(content), ...researchCostBandIssues(content)];
}

/** tech 定義の ID を昇順で返す(走査順を 1 箇所に固定するための私設ヘルパ)。 */
function sortedTechIds(content: EngineContent): readonly EntityId[] {
  return [...content.techDefs.keys()].sort(compareUtf16);
}
