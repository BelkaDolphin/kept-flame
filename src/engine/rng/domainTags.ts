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
 * **並び順は UTF-16 コードユニット昇順に保つこと。** GameState.rngState
 * (`ReadonlyMap<DomainTag, Xoshiro128State>`)の反復順は
 * `entityStateById` と同じくタグ昇順を正準順とするため、レジストリ側も同じ
 * 並びにしておくと「宣言順 = 正準順」で読めて対応が追いやすい(順序そのものの
 * 維持責務は state/update.ts の setRngState 側にある)。
 *
 * --- 各タグの用途(1 タグ = 1 確率系。ADR-024(2)) ---
 *   adjacency      : 隣接行列のタグペア係数に掛ける ±20% シード揺らぎ
 *                    (GDD 6.4-2 単調解回避 / `adjacency.json` の seedOffsetRange)。
 *                    salt = (fnv1a32(tagPairKey))。worldSeed から決まる周回固定値で、
 *                    ストリーム状態を持たない(hash アドレス方式)。
 *   exploration    : 探索の分岐 RNG。salt = (dispatchId, nodeIndex, branchId, choiceKey)、
 *                    撤退枝/強行枝・慎重/大胆が各々独立の counter 起点を持つ(ADR-007)。
 *   recall         : 想起困難の発生ベルヌーイ試行(GDD 11.2 / 段階1・ADR-009/018(1))。
 *                    salt = (fnv1a32(residentId), fnv1a32(techId), coarseStepIndex)。
 *                    per-step 全再評価が順序非依存であることを構造で保証するため
 *                    ストリームを進めない hash アドレス方式を採る。
 *   recallDuration : 想起困難の持続日数(1〜2日)の抽選。発生時にだけ引く低頻度の
 *                    逐次ストリーム(rngState を前進させる)。発生ベルヌーイと
 *                    同一ストリームを共有しないよう別タグに分けている(ADR-024(2))。
 *
 * production / research にタグが無いのは、T5 の縮約 rules における (A)生産 と
 * (B)研究完了 が**決定論的で確率要素を持たない**ため(生産揺らぎ・研究イベントを
 * 入れる段階でこのファイルへ追加する)。使われないタグを先に登録すると
 * 「どの確率系がどのストリームを使うか」の対応が曇るので置かない。
 */
const DOMAIN_TAG_LIST = ["adjacency", "exploration", "recall", "recallDuration"] as const;

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

/**
 * 未知の文字列がレジストリ登録済みの domainTag かを判定する(型ガード)。
 * engine の**外**から来た文字列(セーブの rngState のキー等)をレジストリへ
 * 突き合わせる唯一の口。engine 内部のコードは union 型で弾かれるのでこれを
 * 使う必要はない。
 */
export function isDomainTag(value: string): value is DomainTag {
  for (const tag of DOMAIN_TAG_LIST) {
    if (tag === value) return true;
  }
  return false;
}
