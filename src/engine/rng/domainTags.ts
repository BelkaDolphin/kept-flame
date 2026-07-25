// ---------------------------------------------------------------------------
// RNG ドメインタグの frozen レジストリ(ADR-024(2))。
//
// domainTag は自由文字列ではなく、このファイルが定義する union 型
// `DomainTag` の値のみを許可する。engine 内で `domainTag` プロパティ/変数へ
// 生文字列リテラルを書くことは eslint.config.js の no-restricted-syntax
// (SYNTAX_DOMAIN_TAG)で禁止されており、このファイルだけが例外
// (EXEMPT_DOMAIN_TAGS)として文字列リテラルを直接書ける。
//
// 新しい domainTag を追加する場合は、このファイル(人間専用・CODEOWNERS)を
// 直接編集して DOMAIN_TAG_LIST に1エントリ追加すること。重複登録はモジュール
// 読み込み時のランタイム assert(下記 assertUniqueDomainTags)で即座に拒否
// される(ADR-024(2)「重複は型/テストで即 reject」)。
// ---------------------------------------------------------------------------

/**
 * 登録済み domainTag の一覧(唯一のソース)。
 *
 * 現時点で ADR-007 本文が具体的に定めているのは 'exploration'
 * (探索の分岐 RNG。salt = (dispatchId, nodeIndex, branchId, choiceKey)、
 * 撤退枝/強行枝・慎重/大胆が各々独立の counter 起点を持つ)のみ。
 * production/raid/研究等の他ドメインは、各システムの RNG 設計時(T5 以降)に
 * 人間がこのファイルへ個別追加する。
 */
const DOMAIN_TAG_LIST = ["exploration"] as const;

type DomainTagList = typeof DOMAIN_TAG_LIST;

// --- 重複登録の検出 ----------------------------------------------------------
// モジュール読み込み時に一度だけ走り、重複があれば即座に例外を投げる
// (T3 指示書「重複タグを型かランタイム assert で拒否」の assert 側を採用。
// レジストリが現状1エントリのみであることも踏まえ、コンパイル時の再帰型
// 重複検出は導入せずランタイム assert 一本化でシンプルに保つ)。
export function assertUniqueDomainTags(tags: readonly string[]): void {
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag)) {
      throw new Error(
        `domainTags: domainTag "${tag}" is registered more than once (ADR-024(2) violation)`,
      );
    }
    seen.add(tag);
  }
}
assertUniqueDomainTags(DOMAIN_TAG_LIST);

/** 登録済み domainTag の union 型。レジストリ外の文字列はここに代入できない。 */
export type DomainTag = DomainTagList[number];

function buildDomainTagRegistry<const T extends readonly string[]>(
  tags: T,
): { readonly [K in T[number]]: K } {
  const registry = {} as { [K in T[number]]: K };
  for (const tag of tags) {
    registry[tag as T[number]] = tag as T[number];
  }
  return registry;
}

/**
 * キー名でアクセスする frozen レジストリ本体。
 * 使用例: `{ domainTag: DOMAIN_TAGS.exploration }`(生リテラル禁止の回避経路)。
 */
export const DOMAIN_TAGS: { readonly [K in DomainTag]: K } = Object.freeze(
  buildDomainTagRegistry(DOMAIN_TAG_LIST),
);
