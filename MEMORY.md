# プロジェクト進捗メモ

## 完了タスク
- [2026-07-24 第1回検討] LLMをゲーム本体に使う前提の検討(44エージェント・Fable5)。結論: Cloudflare完結「日替わりAIミステリー」案。→ `docs/検討結果レポート.md`
- [2026-07-24 第2回検討] 前提変更(ゲーム本体はLLM不使用、運営=イベント追加/不具合対応/異常事前検知にLLM)で再検討(23エージェント・Opus/Sonnet、Fable5は最終ジャッジのみ)。
- **最終結論: 「Seedspire v2」型構成を推奨**(唯一fatal 0に収束)。決定論ローグライク+Cloudflare Pages配信、定期処理はCloudflare Worker Cron、LLMはPro $20の対話Claude Codeセッションのみ(APIキー不在+spend limit+追加利用OFFの「壁」で月$20固定)。→ `docs/検討結果レポート_運営LLM版.md`
- 確定した設計原則: ①判定と対処は決定論、LLMは生成と解釈のみ ②2026/6/15以降headless/Actions連携/Agent SDKはサブスク枠外の別課金(二次情報・要公式確認)のためCI内LLMは課金fatal ③完全無人運営は不成立、「人間が止まっても本番は壊れないが新規供給は止まる」縮退設計が上限。

- [2026-07-24 第3回検討] Seedspire v2構成の上に載せるゲーム企画を3視点(深さ/習慣化/運営)×敵対検証2ラウンドで検討(18エージェント・Opus/Sonnet約67万トークン、Fable5は最終ジャッジのみ)。
- **結論: 「詰めタクティクス」(完全情報・固定デッキの日替わり詰将棋型カードパズル)を推奨**(唯一fatal 0/major 0に収束)。他2案の対策(condition語彙先行実装、snapshot/manifest、整数演算固定、simシード固定、累積ドリフト監視等)をグラフト済み。→ `docs/ゲーム企画書_詰めタクティクス.md`

- [2026-07-24 第4回検討] ユーザー指定の方向性(コロニー運営×資源×テックツリー×派遣探索、Fallout Shelter×Dr.STONE感覚)で企画立案。リード起案=Opus、6観点レビュー(敵対2+経済/UX/運営適合/決定論の専門4)=Sonnet、2ラウンド(R1: fatal10/major42 → R2: fatal3/major54、R2指摘は改訂+残余リスクに統合)。計16エージェント・約30万トークン、Fable5はジャッジ・取りまとめのみ。
- **成果物: 「継ぐ火 -Kept Flame-」企画書** → `docs/企画書_継ぐ火_GDD.md`。中核フック=「知識は人の記憶に宿る一時資産。成文化(書き残す)しないと想起困難/喪失する」文明再建コロニー。E1〜E3テック24・施設14種・タグ7種隣接行列・非同期探索・周回(大移動)。MVP工数15〜17週(暫定)。

- [2026-07-24 第5回検討] 「継ぐ火」技術設計(ADR)を作成。アーキテクト起案=Opus、6観点レビュー(決定論数値/性能/セーブ互換/複雑度懐疑/フロントエンド/CI運営配線)=Sonnet×2ラウンド(R1: fatal10/major38 → R2: fatal4/major28、最終改訂で統合)。計16エージェント・約155万トークン。
- **成果物: `docs/技術設計書_継ぐ火_ADR.md`(第3版・ADR31本)**。主要決定: PRNG=xoshiro128**(uint32のみ)、固定小数点1e6+BigInt中間積ガード+Math許可リスト、algoVersionはgolden vector(観測挙動)を権威に、contentロード時正準化パス、決定論レジストリ(ID/domainTag一意性の機械強制)、Preact+自前ハッシュルータ+Worker catch-up、stable/beta昇格をMVP前倒し、先行計測12項目(判断基準付き)。

- [2026-07-24] 別環境への引き継ぎ資料を作成: `ONBOARDING.md`(引き継ぎ本体・読み順と確定事項) + `CLAUDE.md`(新環境で自動読込される絶対ルール)。

- [2026-07-25] **ユーザーがADR承認、実装フェーズへ進行を指示**(Windows環境に引き継ぎ完了)。モデル運用指示を再確認: Fable5は統率・指示出し・最終確認のみ、量産作業はOpus/Sonnet。
- [2026-07-25] **Phase 0(課金の壁の公式確認)完了・合格**(Sonnet 2体で公式ソースのみ調査、Fable5判定):
  - 対話Claude Code=Pro/Maxサブスク枠内を公式確認(support.claude.com/articles/11145838、code.claude.com/docs/en/costs.md)
  - 「2026/6/15にheadless/Actions/Agent SDKが別クレジット課金化」は**計画されたが同日付で一時停止(pause)**が真相。現状はheadless/`claude -p`/Agent SDK/Routinesもサブスク枠内(support.claude.com/articles/15036540)。ただし再開リスクがあるため「自動実行経路を追加しない」絶対ルールは維持
  - Managed AgentsはAPIキー必須=サブスク対象外(公式確認)。GitHub Actions連携はANTHROPIC_API_KEYシークレット方式が基本=API従量経路(認証方式により差がある可能性、断定不能)
  - ANTHROPIC_API_KEY環境変数設定→API従量課金に切替は公式明記。本機は全スコープ未設定を確認済み
  - extra usage(usage credits)はオプトイン機能で、OFFなら枠切れ時に単に停止(自動でAPI課金に切替わらない)。デフォルト状態の公式明記なし→ユーザーの実地確認待ち
  - Cloudflare側も合格: Pages無料枠(ビルド500/月、静的配信無制限、preview無制限)、Workers Cron無料5個/アカウント。KV/D1/R2無料枠も確認。**注意**: Pages非推奨の公式事実はないが、公式のPages→Workers静的アセット移行ガイドが存在し新機能はWorkers優先。最初からWorkers静的アセットで組むかはユーザー判断待ち(ADR変更事項)

## 未解決の問題
- 構成側: major指摘22件が残存(運営LLM版レポート§4)。
- 「継ぐ火」側: 先行プロトタイプ計測(ADR記載の12項目)が未実施。企画書R2残存fatal 3件・ADR R2残存fatal 4件は改訂で対応したが再攻撃は未実施。
- ユーザー実地作業が未完: claude.ai Settings > Usage で extra usage(usage credits)がOFF/未入金であることの確認。
- ユーザー判断待ち: 配信基盤をPagesのままにするか、最初からWorkers静的アセットにするか(ADR変更事項)。
- 実機計測の制約: 現環境はWindows 11デスクトップ。iPhone SE2/Android中位機/8GB Surface実機での計測(#1,#2,#9,#10)は実機入手・接続方法が未定。

- [2026-07-25] ユーザーがextra usage(usage credits)OFFを実地確認 → 課金の壁は完成。
- [2026-07-25] Pages vs Workers静的アセットの比較調査完了(Sonnet・公式ソースのみ)。公式ブログが「新規はWorkers推奨・Pagesは機能投資終了」と明言。Fable5の推奨=Workers静的アセット。ユーザー判断待ち。
- [2026-07-25] **先行計測フェーズ計画書ドラフト完成**(Opus立案・Fable5検分済み) → `docs/先行計測計画_ドラフト.md`。仕分け: ①ローカル完結6項目 / ②実機待ち5項目 / ③先送り3項目。タスクT0〜T16、概算1.8〜3.0Mトークン、期間①0.8週+②準備2〜3日。**ユーザー承認待ち**。
- [2026-07-25] **【至急】git config --global user.email にGitHub PAT(ghp_形式40文字)が混入**していることを発見・実機確認済み。コミット前に (a)GitHub側でトークンrevoke (b)user.email再設定 が必須。ユーザー対応待ち。

- [2026-07-25] **ユーザー決定4件**: ①先行計測計画を承認(細目は計画書推奨どおり) ②GitHubリポ=public「kept-flame」作成OK ③commitメール=GitHub noreply(81347031+BelkaDolphin@users.noreply.github.com、設定済み) ④**配信基盤=Workers静的アセットに確定**(Pagesから変更、ADR側の改訂が必要)。
- [2026-07-25] PAT混入したuser.emailはnoreplyアドレスに修理済み。**解決済み**: ユーザー確認の結果、GitHub上のclassicトークンは2026-03-04期限切れの1個のみ=混入していたのは失効済みトークンで悪用不能。削除のみ推奨(急ぎ不要)。

## 次のステップ
1. Sonnetで実行中: ADR/ONBOARDINGのWorkers静的アセット改訂 + T0(リポ初期化・文書をdocs/へ移動・初回コミット・public「kept-flame」作成&push)。
2. T0完了後: T1(lint規約設計=Opus)→T2以降、計画書§4.2の割当てと依存関係(§4.3)に従って進行。Fable5は統率と最終確認のみ。
