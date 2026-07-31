import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ESLint flat config
//
// このファイルは「決定論critical の線引き」を保持する唯一の場所である。
// engine 純粋性(ADR 冒頭 31行 / リポ構成 524行)の禁止事項を ESLint ルールへ
// 落とし込み、対象を ENGINE_FILES の 1 定数へ集約する(先行計測計画 §3.2、
// ADR 残余リスク#10「線引きと lint ルール網羅の人力維持」への回答)。
//
// 線引きを変える(= engine 相当のディレクトリを増やす/減らす)場合は
// ENGINE_FILES と EXEMPT_* のみを編集すること。ルール本体は下の定数群にあり、
// 免除ブロックはそれらの差分として組み立てているため、免除の範囲が
// 「どのルールを外したか」としてそのまま読める。
//
// 対応する回帰テスト: tests/lint/purity.test.ts
//   禁止事項ごとに違反断片が必ずエラーになること、許可断片がエラーにならないこと、
//   engine 外では engine ルールが発火しないことを検証する = 線引き崩壊の検出器。
//
// ---------------------------------------------------------------------------
// lint で機械強制できない(= 対象外)もの: 決定論ゲート / CI / レビューで担保する
//
//  (a) 「content 由来オブジェクト」かどうかの判定 — lint は Object.keys/for-in を
//      構文で一律禁止できるだけで、値の出自は追えない。正準化パス(canonicalize.ts)
//      を通したか否かは ADR-023(1) の設計 + レビューで担保。
//  (b) domainTag のレジストリ整合 — 第一の強制は `src/engine/rng/domainTags.ts` の
//      frozen union 型(ADR-024(2))。lint は「生文字列リテラルを domainTag に
//      与える」構文パターンしか捕まえられない。
//  (c) 全カテゴリ横断のグローバル ID 一意性(ADR-024(1)) — schema 検証器の担当。
//  (d) content ファイル削除禁止 / tombstone(ADR-023) — content-diff-gate の担当。
//  (e) mulFix の値域証明と BigInt 中間積の要否(ADR-006) — 式ごとの spec + テスト。
//  (f) algoVersion と golden vector の整合(ADR-016/017) — CI ゲートの担当。
//  (g) 状態の直接代入(ミューテーション)の禁止 — ADR-028(1) は「生スプレッドに
//      よるサブツリーコピー」を対象としており、`arr[i] = x` 一般の禁止は
//      離散事象ヒープ(ADR-008)の in-place swap 等を巻き込む過剰禁止になる。
//      よって lint では生スプレッド/Object.assign/delete のみを禁止し、
//      不変性は state 型の readonly 化とレビューで担保する。
//  (h) engine 内相対 import が src/engine の外へ出ていないかの完全判定 —
//      no-restricted-imports の group は gitignore 意味論で `./` `../` を
//      正規化してしまい「相対のみ許可」を表現できない(実測済み)。よって
//      「非相対 import の禁止」を no-restricted-syntax の正規表現で、
//      「外側レイヤー名を含むパスの禁止」を no-restricted-imports の group で
//      二重に表現している。深さ計算を伴う脱出(例: src/engine/advance.ts から
//      `../fp`)は型解決が要るため lint 対象外 = レビュー担保。
// ---------------------------------------------------------------------------

/** 決定論critical の線引き。ここだけが engine 純粋性ルールの適用範囲を決める。 */
const ENGINE_FILES = ["src/engine/**/*.ts"];

/** 正準化パスの単一実装。content の生走査が許される唯一の場所(ADR-023(1))。 */
const EXEMPT_CANONICALIZE = ["src/engine/canonicalize.ts"];

/** 構造共有の単一更新経路。生スプレッド/Object.assign が許される唯一の場所(ADR-028(1))。 */
const EXEMPT_STATE_UPDATE = ["src/engine/state/update.ts"];

/** Map↔JSON 往復の単一正準実装(ADR-028(2))。 */
const EXEMPT_STATE_SERIALIZE = ["src/engine/state/serialize.ts"];

/** domainTag レジストリの定義ファイル。文字列リテラルはここでのみ書ける(ADR-024(2))。 */
const EXEMPT_DOMAIN_TAGS = ["src/engine/rng/domainTags.ts"];

/** ADR-006 Math 許可リスト(ECMA-262 が exact を規定する 9 関数のみ)。 */
const MATH_ALLOWLIST = ["abs", "sign", "floor", "ceil", "round", "trunc", "max", "min", "imul"];
const MATH_ALLOWLIST_RE = `/^(${MATH_ALLOWLIST.join("|")})$/`;

const restrict = (names, message) => names.map((name) => ({ name, message }));

// --- no-restricted-globals -------------------------------------------------

const GLOBAL_TIME = restrict(
  ["Date", "performance"],
  "engine で時刻を読まない(ADR-026)。tick は platform/clock.ts が渡す単調経過時刻の純関数。Date.now()/new Date() を含め Date 参照は全面禁止。",
);

const GLOBAL_DOM = restrict(
  [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "screen",
    "matchMedia",
    "getComputedStyle",
    "alert",
    "confirm",
    "prompt",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "requestIdleCallback",
    "postMessage",
    "addEventListener",
    "removeEventListener",
  ],
  "engine は DOM に触れない(依存ゼロ純TS)。ブラウザ境界は src/platform/ と src/ui/ に隔離する。",
);

const GLOBAL_IO = restrict(
  [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "FileReader",
    "Blob",
    "URL",
    "URLSearchParams",
  ],
  "engine は I/O を持たない。永続化/通信は src/platform/(persistence.ts / worker.ts 等)の担当。",
);

const GLOBAL_TIMER = restrict(
  ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "queueMicrotask"],
  "タイマー発火回数に依存する進行は禁止(ADR-026: tick は単調経過時刻の純関数)。",
);

const GLOBAL_ASYNC = restrict(
  ["Promise"],
  "engine は同期純関数のみ(ADR 冒頭 31行)。非同期境界は platform 層に置く。",
);

const GLOBAL_LOCALE = restrict(
  ["Intl"],
  "ロケール依存の比較/整形は環境差で bit 不一致になる(ADR-010)。UTF-16 コードユニット比較器を使う。",
);

const GLOBAL_NONDET_RUNTIME = restrict(
  ["crypto", "WeakRef", "FinalizationRegistry", "structuredClone"],
  "実行環境/GC 観測に依存する API は非決定。乱数は rng/xoshiro128.ts、複製は state/update.ts を使う。",
);

const GLOBAL_HOST_ENV = restrict(
  [
    "process",
    "global",
    "globalThis",
    "self",
    "top",
    "parent",
    "frames",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    "Buffer",
    "atob",
    "btoa",
  ],
  "engine は実行環境(Node/ブラウザ/Worker)を判別しない。ホスト API 参照は platform 層の担当。",
);

// --- no-restricted-properties ----------------------------------------------

const MSG_OBJECT_TRAVERSAL =
  "content 由来オブジェクトの直接走査を禁止(ADR-023(2))。正準化済み内部表現(Map / 明示ソート配列)経由にすること。正準化そのものは canonicalize.ts が単一実装。";

const PROP_OBJECT_TRAVERSAL = [
  ...["keys", "entries", "values", "getOwnPropertyNames"].map((property) => ({
    object: "Object",
    property,
    message: MSG_OBJECT_TRAVERSAL,
  })),
  { object: "Reflect", property: "ownKeys", message: MSG_OBJECT_TRAVERSAL },
];

const PROP_MAP_JSON = [
  {
    object: "Object",
    property: "fromEntries",
    message:
      "Map↔JSON 往復は state/serialize.ts の toSerializable/fromSerializable 単一実装のみ(ADR-028(2))。",
  },
];

const PROP_STATE_COPY = [
  {
    object: "Object",
    property: "assign",
    message:
      "サブツリーの複製は state/update.ts の updateEntity/updateIn 単一経路のみ(ADR-028(1))。",
  },
];

// --- no-restricted-syntax --------------------------------------------------

const SYNTAX_MATH = [
  {
    selector: `MemberExpression[object.name='Math'][computed=false][property.name!=${MATH_ALLOWLIST_RE}]`,
    message: `Math は許可リスト(${MATH_ALLOWLIST.join("/")})のみ(ADR-006)。Math.random は rng/xoshiro128.ts、pow/exp/log/sin/cos 等は implementation-approximated でエンジン間 bit 不一致、sqrt は整数ニュートン法 isqrt を自前実装する。定数(PI/E 等)も許可リスト外として禁止。`,
  },
  {
    selector: "MemberExpression[object.name='Math'][computed=true]",
    message: "Math の動的プロパティ参照は許可リスト検査を迂回するため禁止(ADR-006)。",
  },
];

const SYNTAX_LOCALE = [
  {
    selector: "MemberExpression[property.name=/^(localeCompare|toLocale[A-Z][A-Za-z]*)$/]",
    message:
      "localeCompare / toLocale* はロケール・ICU 版依存で決定論を壊す(ADR-010)。UTF-16 コードユニット比較器を使う。",
  },
];

const SYNTAX_OBJECT_TRAVERSAL = [
  {
    selector: "ForInStatement",
    message: `for-in は列挙順とプロトタイプ鎖に依存する。${MSG_OBJECT_TRAVERSAL}`,
  },
];

const SYNTAX_STATE_COPY = [
  {
    selector: "ObjectExpression > SpreadElement",
    message:
      "オブジェクトの生スプレッドによるサブツリーコピーを禁止(ADR-028(1))。不変更新は state/update.ts の updateEntity/updateIn 単一経路を通す。配列スプレッド/引数スプレッドは構造共有と無関係なため対象外。",
  },
  {
    selector: "UnaryExpression[operator='delete']",
    message:
      "delete による state の破壊的変更を禁止(ADR-028(1))。エントリ削除も state/update.ts 経由にする。",
  },
];

const SYNTAX_ASYNC = [
  {
    selector:
      ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[async=true]",
    message: "engine は同期純関数のみ(ADR 冒頭 31行)。非同期境界は platform 層に置く。",
  },
  {
    selector: "AwaitExpression",
    message: "engine は同期純関数のみ(ADR 冒頭 31行)。非同期境界は platform 層に置く。",
  },
  {
    selector: "ImportExpression",
    message:
      "動的 import は非同期かつ実行環境依存。engine の依存は静的 import のみ(ADR-001/016 決定論バンドル)。",
  },
];

const SYNTAX_DOMAIN_TAG = [
  {
    selector: "Property[key.name='domainTag'] > Literal",
    message:
      "domainTag に生文字列リテラルを渡さない(ADR-024(2))。rng/domainTags.ts の frozen レジストリの値を使う。",
  },
  {
    selector: "VariableDeclarator[id.name=/^(domainTag|DOMAIN_TAG)$/] > Literal",
    message:
      "domainTag に生文字列リテラルを渡さない(ADR-024(2))。rng/domainTags.ts の frozen レジストリの値を使う。",
  },
  {
    selector: "AssignmentExpression[left.property.name='domainTag'] > Literal",
    message:
      "domainTag に生文字列リテラルを渡さない(ADR-024(2))。rng/domainTags.ts の frozen レジストリの値を使う。",
  },
];

const MSG_NON_RELATIVE_IMPORT =
  "engine が import してよいのは src/engine 配下の相対パスと型のみ(ADR-001 依存ゼロ / 依存は内向き一方向)。パッケージ・絶対パス・エイリアスは禁止。型だけなら `import type` を使う。";

const SYNTAX_IMPORT = [
  {
    selector: "ImportDeclaration[importKind!='type'] > Literal[value!=/^[.][.]?[/]/]",
    message: MSG_NON_RELATIVE_IMPORT,
  },
  {
    selector:
      ":matches(ExportNamedDeclaration, ExportAllDeclaration)[exportKind!='type'] > Literal[value!=/^[.][.]?[/]/]",
    message: MSG_NON_RELATIVE_IMPORT,
  },
];

/** 外側レイヤーのディレクトリ名を含む import(相対パスでの脱出)を塞ぐ。 */
const OUTER_LAYER_GROUPS = [
  "**/platform/**",
  "**/ui/**",
  "**/replay/**",
  "**/sim/**",
  "**/tools/**",
  "**/schema/**",
  "**/content/**",
  "**/conformance/**",
  "**/tests/**",
  "**/bench/**",
];

/** engine 純粋性ルール一式。免除ブロックはこれを差分で組み替える。 */
const enginePurityRules = ({
  propObjectTraversal = PROP_OBJECT_TRAVERSAL,
  propMapJson = PROP_MAP_JSON,
  propStateCopy = PROP_STATE_COPY,
  syntaxObjectTraversal = SYNTAX_OBJECT_TRAVERSAL,
  syntaxStateCopy = SYNTAX_STATE_COPY,
  syntaxDomainTag = SYNTAX_DOMAIN_TAG,
} = {}) => ({
  "no-restricted-globals": [
    "error",
    ...GLOBAL_TIME,
    ...GLOBAL_DOM,
    ...GLOBAL_IO,
    ...GLOBAL_TIMER,
    ...GLOBAL_ASYNC,
    ...GLOBAL_LOCALE,
    ...GLOBAL_NONDET_RUNTIME,
    ...GLOBAL_HOST_ENV,
  ],
  "no-restricted-properties": ["error", ...propObjectTraversal, ...propMapJson, ...propStateCopy],
  "no-restricted-syntax": [
    "error",
    ...SYNTAX_MATH,
    ...SYNTAX_LOCALE,
    ...syntaxObjectTraversal,
    ...syntaxStateCopy,
    ...SYNTAX_ASYNC,
    ...syntaxDomainTag,
    ...SYNTAX_IMPORT,
  ],
  // 基底ルールは off にし、allowTypeImports を持つ typescript-eslint 版を使う。
  "no-restricted-imports": "off",
  "@typescript-eslint/no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: OUTER_LAYER_GROUPS,
          allowTypeImports: true,
          message:
            "依存は内向き一方向。engine から platform/ui/replay/sim/tools/schema/content/conformance/tests/bench への import は禁止(全体アーキテクチャ)。型のみなら import type を使う。",
        },
      ],
    },
  ],
  // 副作用(ログ出力)を engine に持ち込まない。
  "no-console": "error",
  // 実行時コード生成は決定論バンドルの hash/golden vector と整合しない。
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
});

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-ssr/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "blob-report/**",
      "lancedb/**",
      // 並行エージェントの worktree(gitignore 済み)。中の dist ビルド成果物が
      // フルリポ lint に混入してノイズになるため除外(2026-07-31・engine 規則とは無関係)。
      ".claude/**",
    ],
  },

  // 1. 全ファイル共通(engine 外 = platform / ui / replay / sim / bench / tests / 設定):
  //    通常の推奨ルールのみ。決定論 critical の制約はここには入れない。
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  // Node で直接実行する計測/ツールスクリプト(例: bench/tags-contrast.mjs)。
  // console/process 等の Node グローバルを許可するだけで、決定論制約とは無関係。
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },

  // 2. engine 純粋性(決定論critical)。線引きはこの files 指定 1 箇所に集約。
  {
    files: ENGINE_FILES,
    rules: enginePurityRules(),
  },

  // 3. 単一正準実装ファイルの免除。免除は「外したルール」だけが差分として読める。
  {
    // canonicalize.ts は content バンドルを再帰安定ソートする単一実装であり、
    // 生オブジェクト走査が許される唯一の場所(ADR-023(1))。
    files: EXEMPT_CANONICALIZE,
    rules: enginePurityRules({ propObjectTraversal: [] }),
  },
  {
    // update.ts は構造共有の単一更新経路。ここでのみ生スプレッド/Object.assign を使う(ADR-028(1))。
    files: EXEMPT_STATE_UPDATE,
    rules: enginePurityRules({ propStateCopy: [], syntaxStateCopy: [] }),
  },
  {
    // serialize.ts は Map↔JSON 往復の単一正準実装(ADR-028(2))。
    files: EXEMPT_STATE_SERIALIZE,
    rules: enginePurityRules({ propObjectTraversal: [], propMapJson: [] }),
  },
  {
    // domainTags.ts は frozen レジストリの定義ファイル(ADR-024(2))。
    files: EXEMPT_DOMAIN_TAGS,
    rules: enginePurityRules({ syntaxDomainTag: [] }),
  },
);
