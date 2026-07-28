// ---------------------------------------------------------------------------
// scripts/bot-pr.mjs の型宣言(TypeScript は同名 .d.mts をペアとして自動解決
// する)。tests/scripts/bot-pr.test.ts から純粋関数を import して単体テストする
// ためだけに用意する(@types/node 非依存方針は維持。本体の .mjs 自体は
// tsconfig.json の include 対象外で型チェックされない)。
// ---------------------------------------------------------------------------

export interface BotPrArgs {
  readonly branch: string;
  readonly title: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly base: string;
  readonly remoteBranch: string;
}

export declare function parseArgs(argv: readonly string[]): BotPrArgs;

export declare function redact(text: string, token: string | undefined): string;
