// ---------------------------------------------------------------------------
// scripts/bot-token.mjs の型宣言(TypeScript は同名 .d.mts をペアとして自動解決
// する)。tests/scripts/bot-token.test.ts から純粋関数を import して単体テスト
// するためだけに用意する(@types/node 非依存方針は維持。本体の .mjs 自体は
// tsconfig.json の include 対象外で型チェックされない)。
// ---------------------------------------------------------------------------

export interface GitHubAppInstallation {
  readonly id: number;
  readonly account?: {
    readonly login?: string;
  };
}

export declare function buildAppJwt(
  appId: string | number,
  privateKeyPem: string,
  nowSeconds?: number,
): string;

export declare function pickInstallation(
  installations: readonly GitHubAppInstallation[],
  owner: string,
): GitHubAppInstallation;
