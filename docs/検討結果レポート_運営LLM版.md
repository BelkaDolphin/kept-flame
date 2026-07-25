# 検討結果レポート(第2回): ゲーム本体はLLM不使用、運営にLLMを使う構成

作成日: 2026-07-24
前提の変更: ゲーム自体は普通の決定論的ゲーム。LLMの用途は **(1)イベント・コンテンツ追加 (2)不具合対応 (3)異常の事前検知** の運営側3点。
検討方式: 立案・改訂=Opus、調査・敵対攻撃=Sonnet(計23エージェント・約122万トークン、前回比35%減)。最終ジャッジのみFable 5(オーケストレーター本体)がインラインで実施。

---

## 1. 結論

**最推奨: 「Seedspire v2」型構成(コスト最小派・第2版)** — 敵対検証で唯一 fatal 0 に収束した。

一言でいうと: **「判定と対処は決定論、生成と解釈だけLLM。LLMは人間が起動する対話セッションに閉じ込め、財布は設定の壁で物理固定する」**

| 要素 | 内容 |
|---|---|
| ゲーム | クライアント完結・完全決定論のデッキ構築ローグライク(日替わりseed)。LLM不使用 |
| 配信 | Cloudflare Pages(無料・帯域無制限)。stable/betaの2環境、1クリックロールバック |
| 定期実行の心臓 | **Cloudflare Worker Cron(無料・自動失効なし)**。GitHub Actionsのscheduled(60日無活動で自動無効化)を心臓に使わない |
| イベント追加(LLM) | 人間が週1でClaude Code(Pro $20)対話セッションを起動→コンテンツJSONのみ生成→決定論ゲート(スキーマ検証+多方策シミュレーション1000回+変更パス強制)→人間merge→betaでソーク→stable昇格 |
| 不具合対応(LLM) | 検知はSentry無料枠+ゲーム内報告ボタン(決定論)。LLMはスタックトレース+seedから決定論リプレイで診断・修正PR作成。**P0はLLMを待たずWorkerが自動ロールバック** |
| 異常の事前検知(LLM) | 集計・閾値判定はWorker cronの決定論処理(勝率ドリフト、エラー率、TZバグ検査)。LLMは週次で「解釈と予測」のみ(生ログを投げない) |
| 現金コスト | **月$20(Claude Proのみ)**。API従量ゼロを「壁」で強制: APIキーを環境に置かない+spend limit $0+追加利用OFF+headless/Actions連携/Routines不使用 |
| 人的コスト(正直な計上) | 初期15〜30時間+月6〜10時間。「解約すれば月$0でゲーム自体は動き続ける」が、新コンテンツと恒久修正は止まる |

### なぜこの案か

1. **唯一fatalゼロに収束**(R1: fatal4 → R2: fatal0)。人間ゲート派はR2でもfatal5(課金経路の自己矛盾、架空のセカンド承認者等)、完全自動派はR1でfatal9を食らい改訂不能で脱落。
2. **調査事実と整合**: 2026/6/15以降、headless(`claude -p`)・GitHub Actions連携・Agent SDK経由の「プログラム的利用」はPro/Maxサブスク枠外の別クレジット(API料率)課金になったとの情報があり(二次情報・要公式確認)、**「CIからサブスクで無料にLLMを回す」前提の案は全て課金面のfatalを食らった**。対話セッションに閉じるこの案だけが影響を受けない。
3. **実在の事故パターンを回避**: 自律エージェントの実運用インシデント(暴走スキャナでAWS $6,531課金、無監督エージェントの数週間稼働等)は「LLMに実行権と財布を渡した」構成で起きている。本案はLLMに本番実行権も課金経路も持たせない。

---

## 2. 3案の顛末

| | 完全自動運営派 | 人間ゲート派 | **コスト最小派(推奨)** |
|---|---|---|---|
| 案 | Daily Picross Autopilot(テスト合格で自動マージ・自動デプロイ) | コトダマ・デイリー(LLMはPR提案まで、人間がスマホ承認) | Seedspire(LLMは対話セッション内のみ) |
| 検証結果 | R1で **fatal 9** 、改訂も失敗し脱落 | R2でも **fatal 5** 残存(未収束) | R1: fatal4 → **R2: fatal0**(major 22) |
| 主な死因/課題 | 無人マージの品質保証が不成立、暴走コスト、誤修正の本番直行 | 「単一課金経路」宣言の自己矛盾(Routines併用)、hard capが3つの課金主体に分散、セカンド承認者が架空 | fatalは無いがmajor多数(下記「実装時に潰すべき指摘」) |

**検討全体の教訓**: 「運営の完全無人化」は今回も敵対検証を通らなかった。通ったのは「**人間が止まっても本番は壊れない(自動ロールバック・安全モード)、ただし新規供給は止まる**」という縮退設計まで。これが2026年時点の現実的な上限と結論する。

---

## 3. 推奨構成の実現手順

### Phase 0: 課金の壁の検証(最初にやる・Pro契約のみ)
1. Claude Pro契約、Surface Pro(WSL2)にClaude Code導入。環境変数にANTHROPIC_API_KEYを**置かない**。
2. Anthropicコンソールで spend limit 最小設定+自動リロード無効、Pro追加利用(pay-per-use)トグルOFF。
3. セッション起動前に認証経路を検査するpreflightスクリプトを作成(APIキー検出で起動中止)。
4. **「対話Claude Code=サブスク枠内」の公式確認**(6/15課金変更の正確な範囲)。未確認のまま自動化系機能(headless/Actions/Routines)には手を出さない。

### Phase 1: ゲーム本体(2〜6週、Claude Codeで実装)
5. 共有 `/engine` モジュール(RNG・ルール・UTC日付→seed導出の純関数)を単一の真実として、クライアント/sim.js/replay.jsが同一コードをimportする構造にする。
6. 多方策sim(ランダム/貪欲/数手読み/敵対的探索)、TZ・うるう日のゴールデンテストをCIに組み込む。
7. Cloudflare Pagesにstable/betaの2環境でデプロイ。ゲーム内「報告」ボタン(seed+バージョン+操作列ハッシュをプリフィルしたGitHub issue URL)を設置。

### Phase 2: 運営配線(1〜2週)
8. Cloudflare Worker Cronに定期処理を集約: dead-man heartbeat(Healthchecks.io)/Sentry・Analytics集計と閾値判定/新規エラー署名のissue化/P0時のstable自動ロールバック/週次リマインダー/長期不在時の安全モード。
9. guardrail CI: コンテンツPRが `content/*.json` 以外に触れたらfail。`/engine`・sim・テスト・ワークフロー定義はCODEOWNERSで人間専用。
10. Sentry(無料枠、fingerprint dedup設定)+Healthchecks.io接続。

### 運営フェーズ(週1セッション・30〜60分)
11. 人間がClaude Codeを起動→「今週のイベント/カード3枚追加」→決定論ゲート→PR→人間merge→betaソーク→stable昇格。
12. 不具合はSentry issueをセッションで拾い、決定論リプレイで診断→修正PR。P0はWorkerが先に自動ロールバック済み。
13. 週次でreport.json(決定論集計)をLLMに解釈させ、難易度ドリフトや予兆の所見をissue化。

---

## 4. 実装時に潰すべき指摘(推奨案に残ったmajorの上位)

敵対検証がfatal 0まで認めた案だが、major 22件が残っている。実装時に設計で吸収すること:

1. **Cloudflare Workers無料枠のCron Triggerは1 Workerあたり3個まで** — 6系統の定期処理は1つのcronハンドラ内でのディスパッチ(毎時起動し内部で時刻分岐)か複数Workerに分割する。
2. **無料枠の10ms CPU制限** — 外部API集計はsubrequest待ち時間はCPU時間に入らないが、重い集計はやらない設計に(集計は最小限、判定はシンプルな閾値)。
3. **last-known-goodタグの更新規則を定義** — 「betaソークをN日通過したデプロイのみをgoodに昇格」等、自動ロールバック先の正しさを規則で担保する。
4. **Sentry無料枠の枯渇自体を監視** — クォータ消費率をWorker集計に含め、枯渇前にアラート(成功するほど監視が盲目化する穴を塞ぐ)。
5. **通知先の冗長化** — 会社メール1本に集約しない。個人メール+Push(ntfy.sh等の無料Push)の2系統。
6. **「壁」の実在確認** — Pro追加利用トグル・spend limitの挙動は設定画面で実際に確認してから運用開始(未検証の設定を金銭安全の前提にしない)。
7. **週次セッションを起動させる仕組みの限界を受容** — リマインダー以上の強制力は存在しない。止まった場合の帰結は「新コンテンツ停止・ゲームは動き続ける」であることをREADMEに明記しておく。

---

## 5. 調査ソース(今回の追加調査分・主要URL)

**Claude CodeのCI/定期実行**
- https://code.claude.com/docs/en/github-actions (claude-code-action公式。GITHUB_TOKENコミットは他ワークフローを発火しない等の制限)
- https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md (Pro/MaxのOAuthトークン認証)
- https://platform.claude.com/docs/en/managed-agents/overview (Managed Agents beta)
- https://tygartmedia.com/claude-code-billing-credit-pool-2026/ (6/15プログラム的利用の課金変更・二次情報)
- https://makerkit.dev/blog/tutorials/claude-code-routines-guide (Claude Code Routines・research preview)

**LLM運営自動化・異常検知**
- https://docs.sentry.io/ai/ (Sentry Seer=有料アドオン・人間レビュー前提)
- https://last9.io/blog/sentry-pricing/ (無料枠 月5,000イベント)
- https://www.cyera.com/research/agent-inflicted-damage-inside-the-real-world-failures-of-enterprise-ai-systems (自律エージェント実害事例の分析)
- https://www.nexgismo.com/blog/ai-agent-budget-guards-stop-runaway-api-costs (ターンバジェット・コスト遮断器)
- https://galtea.ai/blog/automated-llm-evaluation-building-a-ci-cd-quality-gate-that-actually-runs (LLM出力のCI品質ゲート設計)

前回検討分のソース(ローカルLLM/AWS無料枠/Cloudflare/Claude料金)は `検討結果レポート.md` 参照。

---

## 付録: 検証履歴

| 案 | R1 | R2 |
|---|---|---|
| 完全自動運営(Daily Picross Autopilot) | fatal 9 / major 15 | 改訂失敗・脱落 |
| 人間ゲート(コトダマ・デイリー) | fatal 5 / major 16 | fatal 5 / major 12(未収束) |
| **コスト最小(Seedspire v2)** | fatal 4 / major 19 | **fatal 0** / major 22(収束) |
