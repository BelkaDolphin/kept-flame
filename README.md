# 継ぐ火 -Kept Flame-

コロニー運営 × テックツリー × 派遣探索の完全決定論ブラウザゲーム。ゲーム本体に LLM は使わず、運営(コンテンツ追加・不具合対応・異常検知)に Claude Code を使う。

技術的な決定は `docs/技術設計書_継ぐ火_ADR.md`、ゲーム仕様は `docs/企画書_継ぐ火_GDD.md` が正。作業を始める前に `ONBOARDING.md` と `MEMORY.md` を読むこと。

このファイルは運営基盤(課金の壁・LLM 自動実行経路 guardrail)まわりの手順のみを扱う。

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
