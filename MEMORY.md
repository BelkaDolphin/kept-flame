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
- ~~ユーザー判断待ち: 配信基盤をPagesのままにするか、最初からWorkers静的アセットにするか~~ **[2026-07-25解消]** Workers静的アセットに確定・ADR/ONBOARDING/計画書改訂済み(下記参照)。
- 実機計測の制約: 現環境はWindows 11デスクトップ。iPhone SE2/Android中位機/8GB Surface実機での計測(#1,#2,#9,#10)は実機入手・接続方法が未定。

- [2026-07-25] ユーザーがextra usage(usage credits)OFFを実地確認 → 課金の壁は完成。
- [2026-07-25] Pages vs Workers静的アセットの比較調査完了(Sonnet・公式ソースのみ)。公式ブログが「新規はWorkers推奨・Pagesは機能投資終了」と明言。Fable5の推奨=Workers静的アセット。ユーザー判断待ち。
- [2026-07-25] **先行計測フェーズ計画書ドラフト完成**(Opus立案・Fable5検分済み) → `docs/先行計測計画_ドラフト.md`。仕分け: ①ローカル完結6項目 / ②実機待ち5項目 / ③先送り3項目。タスクT0〜T16、概算1.8〜3.0Mトークン、期間①0.8週+②準備2〜3日。**ユーザー承認待ち**。
- [2026-07-25] **【至急】git config --global user.email にGitHub PAT(ghp_形式40文字)が混入**していることを発見・実機確認済み。コミット前に (a)GitHub側でトークンrevoke (b)user.email再設定 が必須。ユーザー対応待ち。

- [2026-07-25] **ユーザー決定4件**: ①先行計測計画を承認(細目は計画書推奨どおり) ②GitHubリポ=public「kept-flame」作成OK ③commitメール=GitHub noreply(81347031+BelkaDolphin@users.noreply.github.com、設定済み) ④**配信基盤=Workers静的アセットに確定**(Pagesから変更、ADR側の改訂が必要)。
- [2026-07-25] PAT混入したuser.emailはnoreplyアドレスに修理済み。**解決済み**: ユーザー確認の結果、GitHub上のclassicトークンは2026-03-04期限切れの1個のみ=混入していたのは失効済みトークンで悪用不能。削除のみ推奨(急ぎ不要)。

- [2026-07-25] **配信基盤改訂 + T0(リポジトリ初期化)完了**(Sonnet実行):
  - ADR(ADR-025/ADR-021/ADR-031 + バージョニング節)・ONBOARDING.md §3・`docs/先行計測計画_ドラフト.md` §6.1(b)/§8-3 のCloudflare Pages言及を計6箇所、[2026-07-25改訂]注記付きでWorkers静的アセットへ改訂。stable/betaは`wrangler.toml`の`[env.stable]`/`[env.beta]`で別Workerとして表現する方針に統一。ADR-025の凍結アーカイブ方式は「退役版ごとに個別Worker(固定サブドメイン)」へ変更(Workersのバージョンプレビュー URLがPages同様に無期限保持される保証が未確認のため、確実な方式を採用)。
  - `git init`(main・`.gitattributes` eol=lf・`.editorconfig`・`core.autocrlf false`)、`.gitignore`(node_modules/dist/.claude/lancedb等)、6設計文書を`docs/`へ移動しCLAUDE.md/MEMORY.md/ONBOARDING.mdのパス参照を更新。
  - `npm view`実在確認: vite 8.1.5(ADR記載8.1と一致)・vitest 4.1.10・preact 10.29.7・@playwright/test 1.62.0・jsep 1.4.0・**typescript 7.0.2**(native/Go実装ベースのメジャーバージョン。ADR側はバージョン未指定のため矛盾はないが、strict系オプションの互換は今後の実装タスクで要確認)・prettier 3.9.6。
  - `package.json`(devDependencies 7点のみ・追加依存なし)・`tsconfig.json`(strict全部)・`vite.config.ts`(vitest共有設定・JSXはtsconfig側のjsxImportSource=preactに委譲し`esbuild`型への追加依存を回避)・`.prettierrc`/`.prettierignore`。`npm install`成功・`npm run typecheck`/`npm run format`ともにパス。
  - コミット2件(`docs:` → `chore:`)、author/committer=`81347031+BelkaDolphin@users.noreply.github.com`を確認、全履歴に実際のシークレット文字列なしを確認してから push。
  - **リポジトリ**: https://github.com/BelkaDolphin/kept-flame (public, default branch main)。

## 未解決・保留

- ADR本文中、Cloudflare Pages言及のうち文意変更が必要な箇所(ADR-025の凍結アーカイブ方式)はWorkers静的アセット版へ改訂したが、「退役版ごとの個別Worker」運用は設計上の選択であり実装時に再検討の余地あり。
- TypeScript 7.0.2(native/Go port)採用によるstrict tsconfigオプション群の完全互換は、実コード(T2以降)を書くまで未検証。
- `.claude/`は現状空ディレクトリ、`.claude_sessions`は0バイトファイル(いずれも.gitignore対象・実害なし)。

- [2026-07-25] **T1完了**(Opus・コミットcaa2e38): engine純粋性ESLint(flat config)。禁止8種を`src/engine/**`のoverrides 1箇所に集約、免除はcanonicalize.ts/state・serialize系/domainTags.tsのみ。回帰テスト77件(違反53・許可8・免除8・線引き7)全pass。**注意点2つ**: ①typescript-eslint 8.65がTS7のJS API非対応→公式の側置き構成に変更(`typescript`=6系alias、`@typescript/native`=7.0.2、tscは7が走る) ②npm auditがeslint9系の推移依存でhigh 5件報告(修正はeslint10待ち、実行時影響なし)。lintで強制不能な項目はconfig冒頭に明記(content出自判定・domainTagレジストリ整合等はTS型/決定論ゲート/レビュー担保)。
- [2026-07-25] GDD確認: ビットマップ画像素材は設計上不要(アイコン/バッジはSVG/CSS自己完結)。ユーザーに回答済み。

- [2026-07-25] **T13前半完了**(Opus・コミット62dd02c): `docs/design/tags-spec.md`(653行)。7タグの色/記号/パターン/数値の4重符号化、全49 ink×面ペアがWCAG 4.5:1合格(最小4.62)、色覚3型を混同色線+CIEDE2000で検討(最小ΔE00: 1型10.4/2型10.4/3型8.2)。末尾に実装用の機械可読JSON(検証済み)。**未確定点8件**(spec§9): 主要は①格子全景時の実ズーム倍率が#9b実機計測待ち ②damp色`#1942E5`の彩度が浮いてる問題(彩度を落とすと3型のclean/damp分離が悪化、ユーザー判断事項・非ブロッキング) ③数値チャネル桁数はadjacency実装後に確定。

- [2026-07-25] **T13後半完了**(Sonnet・コミットed192f1): `bench/tags.html`(判読テスト42試行・決定論的提示・結果JSONコピー)+`bench/tags-contrast.mjs`(spec突合、全68行合格・不一致ゼロ)+`npm run measure:contrast`。eslint.config.jsに.mjs用Nodeグローバル許可を追加(engine規則は無変更、Fable5がvitest 257件全passで確認済み)。#9aのツールは揃った(計測実行はT16)。

- [2026-07-25] **T2完了**(Opus・コミット8cedb94): `src/engine/fp.ts`+テスト120件(手計算ベクタ23本・BigIntオラクル差分、アサーション約7〜8万件)。mulFixは**除算前**2^53ガード+BigInt自動フォールバック(常に厳密値)、証明済みホットパスのみmulFixProven(境界超過で即例外=証明破れ検出)。線引きと補題L1〜L4をファイル冒頭に明文化、早見表の数値はテストでBigInt検算。使用MathはfloorのみでMath.sqrt不使用(isqrt=整数ニュートン法)。設計上の結論: 資源ストック×係数は証明不能=BigInt経路、係数×係数・率×率は証明可能=number経路。propertyテスト量産はSonnet委譲(Opusが全文レビュー済み)。

- [2026-07-25] **T3完了**(Sonnet・コミット69409ea): rng/3ファイル(xoshiro128\*\* v1.1+splitmix32同梱=ADRリポ構成に従う、fnv1a32+hashRngDomain、domainTagsレジストリ=ランタイムassert)。参照ベクタ出典: 公式C実装(prng.di.unimi.it)+rand_xoshiroクレート公開テスト+FNV公式テストスイート。Apache Commons RNGは旧v1.0(バグ版)と判明し不採用。テスト51件、全248件pass(Fable5再確認済み)。**要ユーザー判断**: ADR-007はMath.imul使用を明記だがADR-006許可リストに無くlint禁止→等価な`imul32`(16bit分割乗算、Math.imul相手に10万件一致確認)を自前実装で回避。ADR-006にMath.imul追加すればimul32を置換可能。
- domainTagsレジストリは現状`exploration`のみ。production/raid等はT5以降で追加。

- [2026-07-25] **セッション終了(ユーザー都合・時間とセッション上限)**。RAGに作業記録ingest済み(source: chat://2026-07-25/kept-flame-implementation-start)。**T4(state層=Opus)は実行中のまま中断** → src/engine/state/・canonicalize.ts・テストのuntrackedファイルがディスクに残っている可能性。次セッションはまず `git status` で残存物を確認し、T4を再投入(残存ファイルは新エージェントにレビューさせて活用or作り直し判断)。

## 次のステップ
1. **次セッション最初**: git statusでT4残存ファイル確認 → T4再投入(計画書§4.2の指示内容で。eslint免除パスとの整合必須)。
2. T4完了後: T5(最小tickエンジン=Opus、単一ボトルネック)。並行可: T6(schema+ダミーcontent=Sonnet)。
3. **ADR-006改訂+imul置換 完全完了**(コミットbee9045/4c741d1/68a70c6): Math.imul許可リスト追加、xoshiro128.ts+fnv1a32.tsの両imul32をMath.imul直接使用に置換。**教訓として記録**: 単純置換は不可だった — 自前imul32は`>>>0`でunsigned返しだったがMath.imulはsigned int32を返す(ECMA-262)。fnv1a32のfoldByteはunsigned前提だったため公式ベクタ8件が失敗→`>>>0`追加で修正(xoshiro側は既存の`>>>0`があり無事)。**参照実装ベクタのテストが仕様差を即検出した実例** — 決定論プロジェクトで既知ベクタ突合を先に整備する方針の正しさの証拠。全248件pass。
4. ユーザー判断待ち(非ブロッキング): ②damp色の彩度 ③期限切れPAT削除。
