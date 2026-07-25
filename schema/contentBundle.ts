// ---------------------------------------------------------------------------
// content バンドル検証の単一入口 — ADR-023(1)「content ロード時の正準化パス」
// / ADR-024(1)「グローバル ID 一意性」
//
// raw JSON(カテゴリ別)を受け取り、(1) canonicalizeJson(engine の単一実装)
// でロード時正準化を通し、(2) カテゴリ別スキーマ検証器を適用し、(3) 全
// カテゴリ横断のグローバル ID 一意性を検証し、(4) カテゴリを跨ぐ参照整合性
// (tech.prereqs / tech.fieldRequirement.facility / prereq 循環)を検証する。
// この4段が「content はロード時に正準化パスを通す」配線の実体。
//
// 各段は個別に呼び出せる純関数として分離済み(collect/checkGlobalIdUniqueness
// /checkCrossReferences)なので、T16 の計測ハーネスはどの段が計測コストの
// 支配項かを切り分けて計測できる(先行計測計画 T6 の「検証器は計測可能な形」)。
//
// スコープ外(意図的に未実装。統合ポイントとして残す):
//   - era/recipe カテゴリは T6 のロード対象外のため、tech.era /
//     tech.fieldRequirement.recipe はフォーマットのみ検証し実在確認しない。
//     era/recipe カテゴリを追加するタスクでここに cross-ref を足すこと。
// ---------------------------------------------------------------------------

import { canonicalizeJson } from "../src/engine/canonicalize";
import { type AdjacencyContent, validateAdjacency } from "./adjacency";
import { type BalanceContent, validateBalance } from "./balance";
import type { ValidationIssue, ValidationResult } from "./common";
import { type FacilityContent, validateFacility } from "./facility";
import { checkGlobalIdUniqueness } from "./idRegistry";
import { type TechContent, validateTech } from "./tech";
import { type TraitContent, validateTrait } from "./trait";

export interface RawContentBundle {
  readonly tech: readonly unknown[];
  readonly facility: readonly unknown[];
  readonly trait: readonly unknown[];
  readonly adjacency: unknown;
  readonly balance: unknown;
}

export interface ContentBundle {
  readonly tech: readonly TechContent[];
  readonly facility: readonly FacilityContent[];
  readonly trait: readonly TraitContent[];
  readonly adjacency: AdjacencyContent;
  readonly balance: BalanceContent;
}

/**
 * カテゴリ1本分: raw 配列の各要素を canonicalizeJson → validate に通し、
 * issues をまとめて呼び出し元へ追記する。
 */
function collect<T>(
  entries: readonly unknown[],
  validate: (raw: unknown) => ValidationResult<T>,
  pathPrefix: string,
  issues: ValidationIssue[],
): readonly T[] {
  const values: T[] = [];
  for (let i = 0; i < entries.length; i++) {
    const canonical = canonicalizeJson(entries[i]);
    const result = validate(canonical);
    if (result.ok) {
      values.push(result.value);
    } else {
      for (const issue of result.issues) {
        issues.push({ path: `${pathPrefix}[${String(i)}].${issue.path}`, message: issue.message });
      }
    }
  }
  return values;
}

function checkCrossReferences(
  tech: readonly TechContent[],
  facility: readonly FacilityContent[],
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const facilityIds = new Set(facility.map((f) => f.id));

  for (const t of tech) {
    if (!facilityIds.has(t.fieldRequirement.facility)) {
      issues.push({
        path: `tech.${t.id}.fieldRequirement.facility`,
        message: `facility "${t.fieldRequirement.facility}" が facility カテゴリに存在しない`,
      });
    }
  }

  const techIds = new Set(tech.map((t) => t.id));
  for (const t of tech) {
    for (const prereq of t.prereqs) {
      if (!techIds.has(prereq)) {
        issues.push({
          path: `tech.${t.id}.prereqs`,
          message: `prereq "${prereq}" が tech カテゴリに存在しない`,
        });
      }
    }
  }

  issues.push(...detectPrereqCycles(tech));
  return issues;
}

/** tech.prereqs の循環参照を DFS で検出する(白/灰/黒の3色訪問)。 */
function detectPrereqCycles(tech: readonly TechContent[]): readonly ValidationIssue[] {
  const byId = new Map(tech.map((t) => [t.id, t] as const));
  const state = new Map<string, "visiting" | "done">();
  const issues: ValidationIssue[] = [];

  function visit(id: string, trail: readonly string[]): void {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      issues.push({
        path: `tech.${id}.prereqs`,
        message: `循環参照を検出: ${[...trail, id].join(" -> ")}`,
      });
      return;
    }
    state.set(id, "visiting");
    const entity = byId.get(id);
    if (entity !== undefined) {
      for (const prereq of entity.prereqs) {
        if (byId.has(prereq)) visit(prereq, [...trail, id]);
      }
    }
    state.set(id, "done");
  }

  for (const t of tech) visit(t.id, []);
  return issues;
}

/** content バンドル全体を正準化 + 検証する単一入口(ADR-023(1)/ADR-024(1))。 */
export function validateContentBundle(raw: RawContentBundle): ValidationResult<ContentBundle> {
  const issues: ValidationIssue[] = [];

  const tech = collect(raw.tech, validateTech, "tech", issues);
  const facility = collect(raw.facility, validateFacility, "facility", issues);
  const trait = collect(raw.trait, validateTrait, "trait", issues);

  const adjacencyCanonical = canonicalizeJson(raw.adjacency);
  const adjacencyResult = validateAdjacency(adjacencyCanonical);
  if (!adjacencyResult.ok) {
    for (const issue of adjacencyResult.issues) {
      issues.push({ path: `adjacency.${issue.path}`, message: issue.message });
    }
  }

  const balanceCanonical = canonicalizeJson(raw.balance);
  const balanceResult = validateBalance(balanceCanonical);
  if (!balanceResult.ok) {
    for (const issue of balanceResult.issues) {
      issues.push({ path: `balance.${issue.path}`, message: issue.message });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  if (!adjacencyResult.ok || !balanceResult.ok) {
    // 直前の issues.length===0 ガードにより到達しない(型ナローイング用の防御)。
    throw new Error(
      "validateContentBundle: unreachable state (adjacency/balance ok flag mismatch)",
    );
  }

  const idIssues = checkGlobalIdUniqueness({
    tech: tech.map((t) => t.id),
    facility: facility.map((f) => f.id),
    trait: trait.map((t) => t.id),
  });
  if (idIssues.length > 0) return { ok: false, issues: idIssues };

  const crossRefIssues = checkCrossReferences(tech, facility);
  if (crossRefIssues.length > 0) return { ok: false, issues: crossRefIssues };

  return {
    ok: true,
    value: {
      tech,
      facility,
      trait,
      adjacency: adjacencyResult.value,
      balance: balanceResult.value,
    },
  };
}
