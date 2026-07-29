// ---------------------------------------------------------------------------
// scripts/content-diff-gate.mjs の型宣言(TypeScript は同名 .d.mts をペアとして
// 自動解決する)。tests/scripts/content-diff-gate.test.ts から純粋関数を import
// して単体テストするためだけに用意する(@types/node 非依存方針は維持。本体の
// .mjs 自体は tsconfig.json の include 対象外で型チェックされない。この形式は
// scripts/bot-pr.d.mts / scripts/bot-token.d.mts と同じ M45 の前例に倣う)。
// ---------------------------------------------------------------------------

export interface LsFilesEntry {
  readonly mode: string;
  readonly sha: string;
  readonly stage: string;
  readonly path: string;
}

export interface ContentDiffGateViolation {
  readonly path: string;
  readonly mode: string;
  readonly reason: string;
}

export interface ContentDiffGateResult {
  readonly contentDir: string;
  readonly entries: readonly LsFilesEntry[];
  readonly violations: readonly ContentDiffGateViolation[];
}

export declare function parseLsFilesOutput(output: string): readonly LsFilesEntry[];

export declare function classifyEntries(
  entries: readonly LsFilesEntry[],
): readonly ContentDiffGateViolation[];

export declare function runGitLsFiles(repoRoot: string, contentDir: string): string;

export declare function checkContentDiffGate(
  repoRoot?: string,
  contentDir?: string,
): ContentDiffGateResult;
