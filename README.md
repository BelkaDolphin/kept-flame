# 継ぐ火 -Kept Flame-

コロニー運営 × テックツリー × 派遣探索の完全決定論ブラウザゲーム。ゲーム本体に LLM は使わず、運営(コンテンツ追加・不具合対応・異常検知)に Claude Code を使う。

技術的な決定は `docs/技術設計書_継ぐ火_ADR.md`、ゲーム仕様は `docs/企画書_継ぐ火_GDD.md` が正。作業を始める前に `ONBOARDING.md` と `MEMORY.md` を読むこと。

このファイルは運営基盤(課金の壁・LLM 自動実行経路 guardrail・ソロ運営のレビュー分離)まわりの手順のみを扱う。

## 課金の壁(ADR-021)

「LLM の自動実行経路(headless、GitHub Actions への Claude 連携、Claude Agent SDK、Routines)を追加しない」という絶対ルールは、課金を Claude Pro/Max の**週次インタラクティブ枠のみ**に固定する前提の上に成り立っている。この節の2スクリプトは、その前提を機械的に保つための最小限の guardrail(ADR-021 が「機械強制可能」と整理した部分)。

### `npm run preflight` — 週次セッション起動前に実行する

環境変数 `ANTHROPIC_API_KEY` または `ANTHROPIC_AUTH_TOKEN` が存在するかどうかだけを見る。どちらも Claude Code / Anthropic SDK の資格情報解決で Pro/Max の OAuth セッションより優先されるため、存在するとそのセッションは意図せず API 従量課金に切り替わる。

```sh
npm run preflight
```

- 対象変数が **未設定** → 終了コード `0`。そのまま週次セッションを開始してよい。
- 対象変数が **存在する**(空文字列でも) → 終了コード非 `0`。理由と `unset` 手順(bash/zsh・PowerShell・cmd.exe)を標準エラー出力へ表示して停止する。

Windows/Linux/macOS のどの環境でも Node 標準モジュールのみで動作する(追加依存なし)。実装は `scripts/preflight.mjs`。

### `npm run check:llm-paths` — LLM 自動実行経路が紛れ込んでいないかの guardrail

```sh
npm run check:llm-paths
```

以下を検査し、1件でも見つかれば終了コード非 `0` で該当行を報告する。

1. `.github/workflows/*.yml`(`*.yaml`)の非コメント行に
   - `anthropics/` 系 GitHub Action の `uses:`
   - `claude` / `claude-code` CLI らしき呼び出し
   - `ANTHROPIC_API_KEY` という文字列(secrets 経由の API キー配線)
   - `@anthropic-ai/` 系パッケージ名(ワークフロー内での直接インストール)

   のいずれかがある。
2. `package.json` の `dependencies` / `devDependencies` / `optionalDependencies` / `peerDependencies` のいずれかに `@anthropic-ai/*` 系パッケージが入っている。

検査対象外にしたもの(検出原理的に不能なもの)は `scripts/check-llm-paths.mjs` 冒頭のコメントに明記してある。要点だけ書くと、YAML を構文解析せず正規表現で文字列走査するだけなので、別リポジトリを参照する reusable workflow の中身・難読化された参照・`ANTHROPIC` を含まない名前にリネームされた secrets までは追えない。

現状のリポジトリ(`.github/workflows/calibrate.yml` のみ・LLM 要素ゼロ)はこの検査を pass する。**もし既存の LLM 要素ゼロの workflow が誤って引っかかったら、それは誤検知なので `scripts/check-llm-paths.mjs` の検査ロジック側を直すこと。ワークフロー自体は変更しない。**

## 週次インタラクティブ消費量の概算(ADR-021(3))

週次の content パイプラインは以下の正準順序で走る(`docs/技術設計書_継ぐ火_ADR.md` §12.4 / ADR-015(2))。

```
schema検証 → canonicalize → id-registry検証 → 段階 sim1000 → content-diff-gate
  → conformance(3ブラウザ) → 統計クリープ検出 → bot作成PRをhuman承認merge → betaソーク
```

ADR-021(3) が指す「セッションのトークン/時間概算」は、この正準パイプラインを1回通す**フルゲート実行**を単位として、以下の2種類の再試行を含む最悪ケースで見積もる。

- **bisection 再実行(最大約5回)** — content 間の相互作用起因の不具合(想起判定・カスケード等)を `sim/bisection.ts`(§12.4)で二分探索する際、疑わしい範囲を絞り込むためにフルゲートを繰り返し通す回数の上限目安。
- **schema reject 再試行** — オーサリングした content が schema 検証(先頭段)で reject され、修正して再投入するループ。1回の reject 再試行は概ねパイプライン先頭(schema検証・canonicalize・id-registry)のみの再実行で済み、フルゲート1回よりコストは小さい。

**現時点でこの概算は実測値ではない**(先行プロトタイプ計測項目 #11「週次インタラクティブセッションの消費量」は `docs/技術設計書_継ぐ火_ADR.md` の先行プロトタイプ計測項目表で「実セッションで計測」と明記された未計測項目であり、根拠のない数値を書かない方針(同文書 §0)により、ここでも架空のトークン数は書かない)。参考にできる実測値は、同種の CI/GitHub 設定タスク(T15: `calibrate.yml` 実装)が想定より重く「3コミットを消費した」という記録(MEMORY 2026-07-26)のみで、**「CI / wrangler / GitHub 設定は1発で通らない」性質がある**ことを示唆する。フルゲート1回のコストも同様に上振れしやすいと見て運用すること。

運用前に確認する手順:

1. 実際に週次 content セッションを1回通し、bisection・schema reject が実際に何回発生したかと、Claude Code のセッション内トークン使用量(Claude Code のセッション内表示、または Anthropic Console の使用量ページ)を記録する。
2. その実測値 ×(最大5回 + reject 再試行回数)を Pro/Max の週次上限に対する比率として確認する。
3. 上限に対する余裕が乏しければ、content 投入単位(週あたりの entity 数)を分割する(先行プロトタイプ計測項目表の判断基準どおり)。
4. 実測が取れ次第この節を実測値で更新すること。

## 残余リスク(ADR-021)

ADR-021 は「機械強制できる部分」と「できない部分」を切り分けており、本リポジトリの guardrail は前者しかカバーしない。

> ただし「どの課金経路で生成されたか」は git diff から原理的に判定不能で、上限超過時に運営者がとっさに API キー課金へ切替える人的逸脱は CI で防げない = 残余リスクとして明示。

つまり:

- `npm run preflight` はセッション**起動前**にしか効かない。起動後に運営者が別シェルで `ANTHROPIC_API_KEY` を設定してそのセッションへ横流しするような逸脱までは防げない。
- `npm run check:llm-paths` はリポジトリの静的な設定(workflow・`package.json`)しか見ない。生成された PR の diff だけを見て「これが Pro/Max 対話枠で書かれたか API キー従量で書かれたか」を判定する手段は存在しない。
- これらは自己規律に依存する残余リスクであり、CI では検出できないことを前提に運用すること(週次消費量の見積りが振れた場合に API キーへ安易に切り替えない、という運営者本人の判断が最後の防波堤になる)。

## ソロ運営のレビュー分離(ADR-030)

1人 + AI 運営では「PR 作成者 = CODEOWNERS レビュアー」が同一人物になり、GitHub 仕様上 PR 作成者の自己承認は必須レビュー数に加算されないため、必須レビューを永久に満たせずブロックする(逆に admin bypass を許すと人間レビュー機能が実質無効化する)。この節の2スクリプトは、bot identity(GitHub App `kept-flame-bot`)が PR を作成し、運営者本人が CODEOWNERS レビュアーとして承認する、という**作成者 ≠ 承認者の二役分離**を成立させるための最小限の道具である(ADR-030(1)(2))。

### 前提: GitHub App のセットアップ(ユーザー作業・済んでいなければ先にこちら)

`kept-flame-bot` という名前の GitHub App を運営者本人のアカウント配下(新規アカウント不要)に作成し、Contents / Pull requests を Read-write で `kept-flame` リポジトリのみにインストールする。手順は `docs/ユーザー作業リスト.md` §1(9ステップ・所要5分)を参照。**インストールが完了していないと `npm run bot:token` は `GitHub App のインストールが1件も見つかりません` で失敗する**(`GET /app/installations` が空配列を返す。App の作成だけでは不十分で、Install App の操作まで完了させる必要がある)。

### 🔒 秘密鍵(.pem)の取り扱い

- .pem の中身は絶対にコミット・ログ出力・画面表示しない。
- .pem の**絶対パス**もコミット対象ファイルにハードコードしない。下記の環境変数 `KEPT_FLAME_BOT_PEM` で毎回指定する。
- .pem は GitHub Actions の secrets にも登録しない(この節のスクリプトはローカル実行専用で、workflow 化しない=CLAUDE.md 絶対ルール「LLM の自動実行経路を追加しない」を侵さないことの一部)。
- App ID(既定値 `4415558`)自体は秘密情報ではないため、スクリプト内の既定値として埋め込んである。

### `npm run bot:token` — インストールトークン(寿命1h)を取得する

Node 組込み `crypto`(`createSign("RSA-SHA256")` + base64url)のみで JWT(RS256)を自前署名し、新規 npm 依存を追加しない(`scripts/preflight.mjs` 等と同じ流儀)。`GET /app/installations` でインストール ID を自動発見し、`POST /app/installations/{id}/access_tokens` でインストールトークンを取得する。

```powershell
$env:KEPT_FLAME_BOT_PEM = "C:\path\to\kept-flame-bot....pem"
$token = npm run --silent bot:token
```

```sh
export KEPT_FLAME_BOT_PEM=/c/path/to/kept-flame-bot....pem
token=$(npm run --silent bot:token)
```

環境変数:

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `KEPT_FLAME_BOT_PEM` | ✅ | なし | .pem 秘密鍵の絶対パス |
| `KEPT_FLAME_BOT_APP_ID` | — | `4415558` | GitHub App ID(kept-flame-bot。秘密ではない) |
| `KEPT_FLAME_BOT_OWNER` | — | `BelkaDolphin` | installation が複数ヒットした場合の絞り込み先アカウント名 |

**出力はトークン文字列のみを stdout に書く**(進行状況・エラーは全て stderr)。呼び出し側が上記のように stdout を捕捉して次のステップへ渡す前提。

### `npm run bot:pr` — ブランチを push して PR を作成する

指定したローカルブランチ(コミット済み前提)をインストールトークンで `https://x-access-token:<token>@github.com/...` 経由で push し、Pull Requests API で PR を作成する。**作成者が `kept-flame-bot[bot]` になる**(= human 承認と別 identity)。

```powershell
$env:KEPT_FLAME_BOT_TOKEN = $token
npm run bot:pr -- --branch bot/some-branch --title "content: ..." --body "..."
```

引数:

| 引数 | 必須 | 説明 |
|---|---|---|
| `--branch <name>` | ✅ | push するローカルブランチ名 |
| `--title <text>` | ✅ | PR タイトル |
| `--body <text>` | — | PR 本文(既定は空文字列) |
| `--body-file <path>` | — | PR 本文をファイルから読む(複数行本文向け。`--body` より優先) |
| `--base <branch>` | — | マージ先ブランチ(既定 `main`) |
| `--remote-branch <name>` | — | push 先のリモートブランチ名(既定は `--branch` と同じ) |

環境変数 `KEPT_FLAME_BOT_TOKEN`(必須・`bot:token` の出力)、`KEPT_FLAME_BOT_OWNER` / `KEPT_FLAME_BOT_REPO`(省略可・既定 `BelkaDolphin` / `kept-flame`)。**トークンは push 用リモート URL に埋め込むが、標準出力・標準エラーには一切そのまま出さない**(git の出力に URL が混ざった場合に備え、出力前にトークン文字列を `***` へ置換して redact する)。

### ブランチ保護(main)

必須レビュー1件 + force-push 禁止 + 直 push 禁止 + Include administrators を設定する。**必須ステータスチェックは今は指定しない**(guardrail CI 自体は M46 で実装されるため、指定できるチェック名がまだ存在しない。M46 完了後に `required_status_checks` を追加すること)。

**ON にするコマンド**(`gh` は `repo` スコープで認証済みであること):

```sh
gh api --method PUT repos/BelkaDolphin/kept-flame/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

設定内容の確認: `gh api repos/BelkaDolphin/kept-flame/branches/main/protection`

**⚠️ OFF に戻すコマンド(開発期は必ずこちらを使う)**:

```sh
gh api --method DELETE repos/BelkaDolphin/kept-flame/branches/main/protection
```

**開発期の運用方針**: MVP 実装フェーズは複数タスクが `main` へ直接コミット/push する運用が前提になっている(`MEMORY.md` 参照)。bot 経由の PR 運用が常時機能する保証がない開発期にブランチ保護を恒久 ON にすると、直 push 運用そのものが止まる。**恒久 ON は運用開始タスク(M47・stable/beta 昇格)まで待ち、それまでは上記 DELETE コマンドで OFF に戻して直 push 運用を継続すること。**

### 技術的強制ではなく手続き的規律である(ADR-030(5))

ADR-030(5) の該当箇所をそのまま転記する:

> **[2026-07-28追記・正直な開示] 本構成は技術的強制ではなく手続き的規律である。** personal アカウント所有リポジトリでは運営者本人が admin であり、保護設定自体を本人が無効化できる(バイパス不能な強制は Organization 所有でのみ成立)。二役分離の価値は「習慣的・偶発的な無審査マージを構造的に防ぐ」ことにあり、意図的な運用逸脱への防壁ではない(その防壁は決定論ゲート側=schema/sim/conformance が担う)。

つまり、このリポジトリは public な personal リポジトリであり、運営者本人(admin)は `gh api --method DELETE .../protection` を自分で実行してブランチ保護を無効化できる。二役分離(bot 作成 PR + human 承認)が防ぐのは「うっかり自己承認してしまう」「レビューを飛ばしてマージしてしまう」といった**習慣的・偶発的な無審査マージ**であり、運営者本人が意図的にブランチ保護を外して直 push する運用逸脱そのものは防げない(そのための防壁は decision-theoretic には schema 検証 / sim1000 / conformance 等の決定論ゲート側が担う)。上記の「開発期の運用方針」で意図的に保護を OFF にする手順を明記しているのも、この性質(強制でなく規律)を前提にした運用として正直に扱うためである。
