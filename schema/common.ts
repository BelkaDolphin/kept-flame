// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- content schema 共通基盤 — ADR「共通規約」602行 / ADR-011
//
// tech/facility/trait/adjacency/balance の各スキーマ検証器が共有する最小限の
// 検証ユーティリティ。JSON Schema ライブラリは追加しない: ADR に採用根拠と
// なる依存追加の記述が無いため、T6 指示書の方針(「追加npm依存を入れる場合は
// ADRに根拠があるものだけ。無ければ自前検証」)に従い自前実装で組む。
//
// 検証器はここで定義する ValidationResult を返す純関数として書く。例外を
// 投げず issues を集めて返すのは、1 entity が複数欠陥を持つ場合でも一度の
// 呼び出しで全欠陥を報告できるようにするため(週次 LLM 運営セッションが
// schema reject の原因を1往復で把握できる = 先行計測#11「schema reject
// 再試行」コストの削減に資する)。
//
// この層は src/engine の外(schema/)にあり ENGINE_FILES(eslint.config.js)の
// 対象外なので、engine 純粋性ルール(Object.keys 禁止等)は適用されない。
// 一方で ID フォーマットの検証だけは state.ts の唯一実装
// (entityIdFromString/ENTITY_ID_PATTERN)に委譲し、正規表現を二重管理しない。
// ---------------------------------------------------------------------------

import { EntityIdError, entityIdFromString } from "../src/engine/state/state";

/** 検証エラー1件。path は entity 内の位置を人間可読に表す(例: "effects[0].value")。 */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** 検証結果。成功時のみ value を持つ判別ユニオン。 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail<T>(issues: readonly ValidationIssue[]): ValidationResult<T> {
  return { ok: false, issues };
}

/** 検証器本体が使う可変バッファ。外へ渡す戻り値は必ず readonly 配列に変換する。 */
export class IssueCollector {
  private readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get hasIssues(): boolean {
    return this.issues.length > 0;
  }

  list(): readonly ValidationIssue[] {
    return this.issues;
  }
}

/** 数値レンジ(閉区間)。 */
export interface NumericRange {
  readonly min: number;
  readonly max: number;
}

/**
 * id フィールドの検証。正規表現の唯一実装は state.ts の ENTITY_ID_PATTERN
 * (ADR-011)であり、ここでは重複定義せず entityIdFromString に委譲する。
 */
export function validateId(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, `id は string が必須(実際の型: ${typeof value})`);
    return undefined;
  }
  try {
    entityIdFromString(value);
  } catch (error) {
    if (error instanceof EntityIdError) {
      issues.add(path, error.message);
      return undefined;
    }
    throw error;
  }
  return value;
}

export function expectString(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.add(path, `空でない string が必須(実際: ${JSON.stringify(value)})`);
    return undefined;
  }
  return value;
}

export function expectNumber(
  value: unknown,
  path: string,
  issues: IssueCollector,
  range?: NumericRange,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(path, `有限の number が必須(実際: ${JSON.stringify(value)})`);
    return undefined;
  }
  if (range !== undefined && (value < range.min || value > range.max)) {
    issues.add(
      path,
      `値 ${String(value)} が許容レンジ [${String(range.min)}, ${String(range.max)}] の外`,
    );
    return undefined;
  }
  return value;
}

export function expectInteger(
  value: unknown,
  path: string,
  issues: IssueCollector,
  range?: NumericRange,
): number | undefined {
  const n = expectNumber(value, path, issues, range);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) {
    issues.add(path, `整数が必須(実際: ${String(n)})`);
    return undefined;
  }
  return n;
}

/** 値がちょうど expected と等しいことを要求する(ADR/GDD が固定値と定めるフィールド用)。 */
export function expectExactNumber(
  value: unknown,
  expected: number,
  path: string,
  issues: IssueCollector,
): number | undefined {
  const n = expectNumber(value, path, issues);
  if (n === undefined) return undefined;
  if (n !== expected) {
    issues.add(path, `値は ${String(expected)} 固定が必須(実際: ${String(n)})`);
    return undefined;
  }
  return n;
}

export function expectBoolean(
  value: unknown,
  path: string,
  issues: IssueCollector,
): boolean | undefined {
  if (typeof value !== "boolean") {
    issues.add(path, `boolean が必須(実際: ${JSON.stringify(value)})`);
    return undefined;
  }
  return value;
}

export function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: IssueCollector,
): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.add(path, `${allowed.join(" | ")} のいずれかが必須(実際: ${JSON.stringify(value)})`);
    return undefined;
  }
  return value as T;
}

export function expectArray(
  value: unknown,
  path: string,
  issues: IssueCollector,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, `array が必須(実際: ${typeof value})`);
    return undefined;
  }
  return value as readonly unknown[];
}

export function expectRecord(
  value: unknown,
  path: string,
  issues: IssueCollector,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.add(path, `object が必須(実際: ${typeof value})`);
    return undefined;
  }
  return value as Record<string, unknown>;
}
