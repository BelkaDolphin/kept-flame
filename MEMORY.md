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

- [2026-07-25] **T4完了**(Opus・コミットc5358b8、Fable5検分済み: 360件全pass・ツリークリーン): state層4ファイル+テスト112件。設計要点: `entityStateById`は単一namespace+**Map反復順をID昇順の正準順に固定**(維持責務はcreateGameState/putEntity/fromSerializableの3箇所のみ)、toSerializableは最後にcanonicalizeJsonを通すので往復バイト同一性はcanonicalize側の性質として保証。entity=resident/facility/research/resourceの4種(計測rules3本が読む変数のみ)。**rngStateはT5送り**(domainTagsのproduction/研究ドメイン追加が先、理由はstate.ts§3)。eslint免除の拡張は不要だった(免除パスと完全一致)。
- [2026-07-25] `.gitignore`に`models/`追加(eba846c)。RAG ingest時にlocal-ragが埋め込みモデル(Xenova)をプロジェクト直下にDLするため。
- [2026-07-25] **セッション終了**。RAG記録: chat://2026-07-25/kept-flame-implementation-start(T4完了版に更新済み)。P0/P1のうちT0〜T4+T13完了、進捗は計画書§4.3のクリティカルパス上でT5直前まで。

- [2026-07-25] **T5完了**(Opus・コミット0b15b74、Fable5検分済み: 583件全pass・typecheck/lint/formatクリーン・実消費約400k=見積り200kの2倍、主因はADR/GDD全読+分割不変性デバッグ): 最小tickエンジン。新規8ファイル(advance/scheduler/stochastic/adjacency/rules{types,production,research,recall})+ state層4ファイル改修(rngState組込み)。テスト182件追加(既存360件は無改変で全pass)。設計要点:
  - **(A)(B)(C)は「区間は常に(A)、境界に(B)(C)がある」形で実装**。中心不変条件=「レートを変える全状態変化がheapのイベントとして境界化されている」。想起困難の回復は(C)が生んだ(B)境界。
  - tie-break=(tick, パイプライン段, entityId)の**全順序**+同一キーpush禁止 → heap内部配置が処理順に影響しない。パイプライン段はGDD 11.7の9段を10刻みで予約し、想起困難の回復(22)/抽選(24)を「負傷反映→生産」の間に配置(**GDD 11.7に想起困難の記載が無いための解釈 = 要ユーザー判断**)。
  - **eventQueueSnapshotはセーブに持たない**(全イベントがstateから再構成可能。scheduler.buildEventQueueが単一の真実)。
  - **rngStateは空なら直列化形から省略** → 既存360件のserializeテスト(トップレベルキー一覧)を壊さず、旧セーブもマイグレーション不要でロード可。
  - domainTagsは`adjacency`/`recall`/`recallDuration`を追加(production/researchは縮約rulesが決定論的でRNG不要のため**登録しない**)。recall=hashアドレス方式(順序非依存=段階1の全再評価が構造的に成立)、recallDuration=逐次ストリーム(rngStateの唯一の実利用者)。
  - `p_step = p_day × coarse/1440` の**線形按分**(1-(1-p)^(Δ/1440)は非整数べき乗=ADR-006禁止のため)。誤差の妥当性は計測#5で判定。
  - 分割不変性(advance(0→T2) == advance(0→T1)+advance(T1→T2))をテストで固定。この過程で**2件の分割不変性バグを発見・修正**: ①回復イベントでフラグを0に戻すと回復tickちょうどで区切ったとき不一致→回復は比較のみで表現(状態遷移を持たない境界イベント)②完了tickちょうどで区切ると「進行度がコスト到達済みだが未完了」stateになる→残り0以下なら現在tickで完了(ticksUntilResearchCompleteが0を返す)。
  - mulFixProvenは1箇所のみ(adjacencyの係数×(1+offset))。根拠=構成時に|係数|<=2e6を強制(`ADJACENCY_PAIR_VALUE_ABS_MAX`)。他は全てmulFix(自動BigInt)。
  - 実測(Ryzen 7 5700X・住民20/施設12/tech3): 72h catch-up(4320tick)=**28ms**・432ステップ・25,920判定。sim 1run(2304粗粒度ステップ)=**59ms**・**138,240判定**(ADR-014の見積り判定数と一致)。ADR-014の「2s/run仮置き」に対し大幅に余裕がある可能性(botロジック込みの本計測はT9)。
  - 縮約の明示: 生産式は`出力(Lv) × 隣接乗数 × 稼働就労者数`(ステータス5種・trait倍率は縮約対象外)、研究は単一キュー(未完了のID昇順先頭)、(C)判定ペアは「全住民 × 全research entityのtechId」(=ADR-014の20人×3techと同じ判定数)、想起困難は住民単位で停止(tech別停止は縮約外)。

- [2026-07-25] **T6完了**(Sonnet実装・Fable5検分ののちコミットe95948f): `schema/`8ファイル(自前検証器・npm追加依存なし・throwでなくValidationIssue[]収集方式=計測#11のreject再試行コスト計測向け)+`content/`ダミーJSON5ファイル(GDD 11.1〜11.3準拠)+テスト41件。contentBundle.tsが正準化→検証→ID一意性→相互参照/循環検出の単一入口。規模は16ファイル/約1914行(目安12/400超過はエージェント自己申告あり、5カテゴリの実レンジ検証+循環検出のためでFable5妥当と判断)。実消費約228k。
- [2026-07-25] **T5/T6の要ユーザー判断(未処理・文書追記が必要な差異)**: ①GDD11.7同一tick優先順位に想起困難の項なし(T5解釈: 回復22/抽選24を負傷反映→生産の間) ②p_step線形按分の式をGDD11.2/11.8(C)に明記すべき ③eventQueueSnapshot非セーブ方針(ADR-012と差異) ④rngState空なら直列化省略(ADR-012にない正準化) ⑤adjacency effect語彙: engineは`yieldMul`のみ、写せないeffectはcontentロードでreject方針(T7実装要。T6 schemaは自由文字列で広い) ⑥footprint 2×1/2×2未実装=全施設1×1扱い(MVPでstate拡張要) ⑦adjacencyクランプ±60%はengine定数(content化判断余地) ⑧contentはカテゴリごと1ファイル方式(ADR図はエンティティ個別とも読める) ⑨tech.prereqs長さ0許可(エラ起点用、ADRコメント「1-3」と差異)。
- [2026-07-25] **T5/T6統合の残作業**: `schema/facility.ts`のFACILITY_TAGSとT5 adjacencyのタグレジストリが別物=突き合わせ要。T6 JSON→`src/engine/rules/types.ts`内部表現へのローダー未実装(**T7の前提**)。

- [2026-07-25] **T7前半完了**(Opus・コミット8817426、Fable5検分済み: 668件全pass・typecheck/lint/formatクリーン・ツリークリーン。実消費約390k=見積り140kの約2.8倍): golden vector の被覆設計 + content ローダー。
  - **ローダー配置=`schema/engineContent.ts`**(engine外)。根拠は lint が機械的に強制している: ①内部表現化に必要な `Object.keys` は engine 内で canonicalize.ts のみ免除 ②engine→schema の非型 import は全面禁止。加えて `schema/` は CODEOWNERS 人間専用なので「engine が受け付ける content 語彙」を運営LLMが勝手に広げられない。
  - **reject 方針の実装**: 効果語彙レジストリ `ENGINE_EFFECT_BY_CONTENT_EFFECT`(forgeYield/efficiency/foodYield→yieldMul)と `UNREPRESENTABLE_CONTENT_EFFECTS`(health/codifySpeed/defense = GDD 6.2 にあるが engine 未実装)を分けて持ち、未知語彙と未実装語彙で別メッセージ。適用先は any/タグ7種/facility実在ID の3形のみ(タグ名と facility ID の衝突は曖昧として reject)。縮約必須フィールド欠落(harshWork/output/durationTicks*)も既定値で埋めず reject。engine の ADJACENCY_TAGS と schema の FACILITY_TAGS を**実際に突き合わせる唯一の場所**(T5/T6統合の残作業に対する回答)。
  - **人間可読値→1e6 は 10 進文字列経由で厳密変換**(`String(value)` の桁列を 6 桁ずらす整数演算のみ。浮動小数の乗算を 1 度も通らない)。小数第7位以降に有効桁がある値は reject。**この実装が実際にダミー content の欠陥を検出**: `content/facility.json` の `forge.lvCurve[4] = 262.3509375`(1.15⁴ の倍精度展開そのまま)は 1e6 で表現不能 → `262.350937`(floor)へ修正。オーサリングツール(T後続)は 6 桁 floor を組み込む必要あり。
  - **schema の additive 拡張**(既存テストを壊さないため「schema では省略可・ローダーでは必須」の二段構え): `facility.harshWork` / `facility.output` / `balance.recallRiskParams.{memoryKeeperTraitId,durationTicksMin,durationTicksMax}`。contentBundle.ts に memoryKeeperTraitId→trait の cross-ref を追加。
  - **被覆設計**: `docs/design/golden-vector-spec.md`(経路58件・シナリオ15件・seed 6本・ベクタ36本の表 + Sonnet 向け実装指示書 §7)。機械可読レジストリ = `conformance/coverage.json`。フォーマット定義 = `conformance/goldenVector.ts`(128bit ダイジェスト・カウンタ・プローブ・ファイル名規則・被覆突合)。
  - **設計上の要点2つ**: ①**状態は分割不変だがカウンタは分割不変ではない**(回復tickちょうどで区切ると rateChangeEventCount が減る。テストで固定済み)。「カウンタも一致するはず」と書くとT5バグの検出器が壊れる ②**ダイジェストに algoVersion を入れない**。入れると bump で全 golden が変わり ADR-016 の「golden 変化 ⟺ bump」が恒真化して無意味になる → シナリオのメタ3軸は固定リテラル。
  - `observedBy` で「golden で観測できる経路」と「単体テスト/ローダー reject が担保する経路」を正直に分離(残余リスク#9 に対する honest な被覆宣言)。

- [2026-07-25] **セッション終了(第2実装セッション)**。ユーザーの5時間制限残40%(セッション消費50%)のためT7前半で区切り。本セッション完了: T5(0b15b74)+T6(e95948f)+T7前半(8817426)。実消費合計約1.03M(T5=407k/T6=228k/T7前半=390k、いずれもエージェント分。見積り比2〜2.8倍で推移=計測#11の一次データ)。RAG記録: chat://2026-07-25/kept-flame-implementation-start を更新。

- [2026-07-26] **T7後半完了**(Sonnet・コミット431bef1、Fable5検分済み: 707件全pass+`golden:check`36本差分なしを統率側でも実行確認・ツリークリーン。実消費約451k=見積り60kの約7.5倍、実行方式の詰め=カスタムESMローダー自作が主因): golden vector 生成器。`conformance/scenarios.ts`(15シナリオ)+ `conformance/vectorPlans.ts`(36プラン・spec §6 表そのまま)+ `tools/genGoldenVectors.ts`(生成器/検証器・`buildVector`/`diffVectors`/`loadStoredVector`をexport)+ `conformance/vectors/*.json`(36ベクタ+index.json+coverage-matrix.json)+ `tests/conformance/goldenVectors.test.ts`(39件: 再生成一致36+checkCoverage+重複なし+本数)+ npm script `golden:check`/`golden:write`。テスト707件(668+39)全pass・typecheck/lint/format全クリーン・`checkCoverage`空配列(49経路すべて被覆)。
  - **実行方式の詰め**(spec 7.1 の「着手時にNode24で確認」指示への回答): `node --experimental-strip-types` だけでは tsconfig の `moduleResolution:"Bundler"` 前提の拡張子省略 import(engine/schema 全体で使われている)を解決できない(`ERR_MODULE_NOT_FOUND`)。`node:module` の `register()` フックで拡張子省略→`.ts`/`.js` を試すカスタムローダー(`tools/tsLoaderHook.mjs`+`tools/tsLoaderRegister.mjs`、`--import` で読み込む)を自作して解決。新規npm依存なし(tsx等は不使用、指示どおり)。
  - **`@types/node` 非依存**: リポジトリに Node 型定義が無かった(ADR-001 依存最小の帰結)ため、`tools/nodeShims.d.ts` に実使用分のみの ambient 宣言(`node:fs`/`node:url`/`node:module`/`node:path`/`process`)を自前で書いた(新規パッケージではなく型宣言のみ)。
  - **JSON整形は `JSON.stringify(...,null,2)` ではなく `prettier.format(text,{parser:"json",...})` を使用**(spec 7.2 規則7は素の `JSON.stringify` を指示していたが、実際に prettier で確認したところ短い配列を1行に畳む等 `JSON.stringify(...,null,2)` とは出力が異なり `npm run format` が失敗することを検証で確認したための調整。prettier は既存devDependencyで新規依存ではない)。
  - **`algoVersion`(index.json)** は `content/balance.json` の値(=1)を読む(state 側のメタ3軸=固定リテラル1とは別物・spec §3.4落とし穴(1)は state 側だけの制約)。
  - **要Opus/ユーザー判断として報告**: spec §4.3/§4.4 の sc11-overcrowd に内部不整合を発見。中心 cell 7 の8近傍リストに cell 0 が含まれる(§4.4 で明記済み)にもかかわらず、同じ行の「四隅(0/5/42/47)に hearth を配置」も cell 0 を使うため、smelter@7 の heat タグ近傍が §4.4 の例示(cell1,2,6,8の4件・先頭2件=cell1,2・超過2件)ではなく実際は5件(0,1,2,6,8・先頭2件=cell0,1・超過3件)になる。spec を勝手に修正せず**表の記述どおり文字どおりに実装**した(コード中に注記あり: `conformance/scenarios.ts` の `SC11_HEAT_NEIGHBOR_CELLS` 直前コメント)。golden vector 自体は実際の engine 実行結果を記録するので技術的には壊れていないが、§4.4 の説明文とは数値が合わない。
  - **spec に無かった具体値の補完**(設計変更ではなく実装での穴埋め、要判断ではない): sc06 の研究entity名(researchFire/Pottery/BasketWeaving)、sc10 の4住民ID・facility/resource ID、sc11 の facility/resident ID 命名、sc12 の resident ID。いずれも spec 本文が個体名を明示していなかった箇所。

- [2026-07-26] **セッション最終区切り**: T7完全完了(前半8817426+後半431bef1)で先行計測のconformance土台が完成。次セッション冒頭の推奨: ①sc11-overcrowdのspec§4.4不整合をOpusかFable5で裁定(spec説明文の修正 or シナリオ配置の修正+ベクタ再生成。ベクタは`golden:write`で再生成可能なので軽い) ②T8(Playwright)とT9(sim校正)を並行投入。

- [2026-07-26] **sc11裁定完了**(Fable5裁定・Opus反映・コミット532616a)。裁定過程で報告済み不整合(A)より深い問題を発見:
  - **(A)** cell 0 は四隅かつ cell 7 の NW 近傍 → heat近傍は実際5件(spec§4.4の「4件・先頭2件=1,2・超過2」は誤り)。シナリオと既存36ベクタは不変、spec側を実態へ修正。
  - **(B)重要**: adjacency.ts computeCellAdjacency で辞書順ソート結果`ordered[i]`は一度も読まれない。ボーナスは(selfTag,tag)ペアのみ依存 → **GDD 6.3(c)「辞書順先頭(threshold-1)件選抜」はタグ×タグ効果モデルでは恒久的に観測不能(挙動上無意味)**。engineはGDD忠実なので無変更。spec§8-9に要ユーザー判断として登録。パス改名 `adj-overcrowd-lexical-top2`→`adj-overcrowd-effective-limit`。
  - **(C)** sc11では±60%クランプがマスクし本数制限のボーナス減も観測不能(0.8→0.6 vs 2.0→0.6で同一digest)。ペナclamp(−0.6)も最大−0.3で未発動。**(D)** patchのnoise|noiseは一度も発火せず。
  - 対処: **sc16-overcrowd-fine追加**(heat|heat 0.1=clamp非発動域で本数制限可視化、penaltyPerExcess −0.15×超過6=−0.9→clamp −0.6実発動、smelter2基目でnoise|noise発火=multi-tag効果観測)。壊し方3通り全てでdigestが動くことを数値確認済み。ベクタ36→37本。既存36本のexpectedは1バイト不変を確認。
- [2026-07-26] **T8完了**(Sonnet・コミット9f8ffc9、Fable5検分: conformance:e2e 111件を統率側でも実行し全pass確認): Playwright 3エンジンconformance。**計測#7 = 37ベクタ×Chromium/Firefox/WebKit 完全bit一致・合格**(実iOS Safari非代替の注記付き=計画書§7)。設計要点: digest計算は`tools/goldenVectorBuilder.ts`へ純粋部抽出(単一の真実、golden:check出力不変)、scenarios.tsはnode束縛(fileURLToPath)のため`tools/genHarnessData.ts`でbundle/初期stateを事前計算しgitignored manifest経由でブラウザへ(実load/deserialize経路を通す)、vite build+preview方式(dev server非依存)、ベクタ一覧はindex.jsonから動的列挙(sc16追加を無変更で自動追随した実績あり)。
- [2026-07-26] **T9完了**(Sonnet・コミット79bacf8、Fable5検分: sim テスト20件pass確認): sim校正ハーネス。**計測結果(ローカルRyzen=Actions runnerより上振れ注意)**: **#3** measuredSecPerRun=0.0351s → 週次11000runsでshards=1・約6.4分(目標30分に大幅余裕)。**#4** 1分tick=0.3277s/run(ほぼ10倍) → shards=3・約20分でキャップ内。**#5** 想起困難1.875回/住民/週=**GDD目標1〜3回に適合**(パターン別0〜2.875、mastery0.20が過酷base_pを完全相殺するclamp挙動も検証)。決定論チェック(別プロセス2回でバイト同一)、粒度別評価×フルスケジューラ突合8seed全一致。bot2本のみ(計画§2.2遵守)。エージェント判断3点承認済み: shards除数=30分目標、RUN_TOTAL_TICKS固定で10倍化表現、#5はbot停止でパターン純度優先。
- [2026-07-26] 3並行(裁定Opus+T8/T9 Sonnet)の実消費: 176k+356k+356k=約888k。package.json共有はEdit限定+直前再読の指示で衝突なし。全コミットpush済み(origin/main=9f8ffc9)。

- [2026-07-26] **T15完了+#3/#4実runner合格**(Sonnet作成・Fable5検分・コミット4b74092、計測記録1e34871): `.github/workflows/calibrate.yml`(workflow_dispatch限定・contents:read・LLM要素ゼロ)。**実ubuntu-latest計測: #3=0.0487s/run→週次11000runsでshards=1・約8.9分、#4(1分tick)=0.4083s/run→shards=3・約25.0分。両方とも目標<30分・360分キャップ内で正式合格**。結果JSONは`docs/measurements/actions-*-2026-07-26.json`。
  - **npm教訓(3コミット消費)**: Windows生成のpackage-lock.jsonはLinux側optional依存(@emnapi系=rolldownのwasm32-wasiフォールバック経由)を取りこぼし、npm ci が runner で失敗する。ゼロから再生成しても npm 11 arborist が@emnapi/runtimeを落とす再現性バグ。**根治=@emnapi 3点(core/runtime/wasi-threads)をdevDependenciesに直接ピン留め**(ce0e5e1)。`npm ci --dry-run`はWindows上では壊れたロックでも通ることがあり検出器として不完全。
- [2026-07-26] **計測#12完了**(Sonnet・コミット80d20d5): オーサリング素工数。**reject 0回**(3カテゴリとも一発pass、手順書の6桁floor規則がlvCurve精度バグの再発を未然防止=手順書の有効性実証)。相対工数: event(28決定/84行)>>tech・facility(各8決定/10行)=GDD 13.2の上方修正方向と整合。**wall-clock未取得**(エージェントが打刻せず・報告書§0に開示、次回は打刻必須)→56〜150hの数値判定はT16へ。schema/event.ts=engine非接続スタンドアロン検証器(jsep ASTホワイトリストでGDD 12.2演算子を強制)。**新規GDD穴2件**: 距離帯(近郊/遠隔/深部)とステータス名の英字ID正本欠如(要ユーザー判断リストへ)。
- [2026-07-26] **T10完了**(Opus・コミットdd32ab5、Fable5検分: 789件全pass): `docs/design/perf-boundaries.md`(4区間B1〜B4の境界定義・重複禁止R1〜R8・T11/T12差し替え点)+bench/perf.html一式。**B3=hydrate()やなくstate→ストア/派生値+ルートvnodeと定義**(SSR/prerender不在のため。hydrateFidelity:"placeholder"を機械可読で出力)。デスクトップ参考値: B2 0.3ms/B1 6.65ms/B3 ~0/B4 1.9ms(計9.55ms vs 2000ms、isOfficialVerdict:false=#1の合格ではない)。**T16持ち越し4件**: ①idbOpen 44.6msがADR-012(4)文言外 ②saveサイズ想定の曖昧(6KB vs 512KB目標、512KBでもrestore 2.6ms) ③compute warmupが中央値2.5倍(coldとwarmの併記必須) ④タイマ分解能0.1ms(COOP/COEPはT12担当)。sim/board.ts非再利用の判断(node束縛+施設2基では隣接コスト測れず)は妥当。

## 次のステップ
1. ~~sc11裁定~~/~~T8~~/~~T9~~/~~T10~~/~~T15~~/~~#12~~ **[2026-07-26完了]**。①ローカル完結6項目の現況: **#3/#4=実runner正式合格、#5(予備)/#7(3エンジン)=合格、#12=相対データ取得(絶対時間はT16で再測)、#9a=ツール済み・計測実行のみ残**。
2. **T11(persistence+worker最小=Opus)実行中** → T12(GC/メモリ計測=Sonnet) → T14(実機パッケージング=Sonnet)(計測#1/#2/#8の実機準備)。
3. **T16(計測実行+判断基準突合+合否判定+Fallback提案+工数再計算=Opus)**: T12/T14後。持ち越し: T10の4件(idbOpen/saveサイズ/cold-warm/タイマ分解能)、#12絶対時間、#9aコントラスト計測実行。
4. ユーザー保留(非ブロッキング): T5/T6の⑨件判断、T7の5件(spec§8)、GDD 6.3(c)恒久観測不能性(spec§8-9)、**#12新規2件(距離帯・ステータス名の英字ID正本欠如)**、damp色の彩度、期限切れPAT削除。実機計測(#1/#2/#8/#9b/#7 iOS補完)は実機入手・接続手段の確定待ち。
3. **ADR-006改訂+imul置換 完全完了**(コミットbee9045/4c741d1/68a70c6): Math.imul許可リスト追加、xoshiro128.ts+fnv1a32.tsの両imul32をMath.imul直接使用に置換。**教訓として記録**: 単純置換は不可だった — 自前imul32は`>>>0`でunsigned返しだったがMath.imulはsigned int32を返す(ECMA-262)。fnv1a32のfoldByteはunsigned前提だったため公式ベクタ8件が失敗→`>>>0`追加で修正(xoshiro側は既存の`>>>0`があり無事)。**参照実装ベクタのテストが仕様差を即検出した実例** — 決定論プロジェクトで既知ベクタ突合を先に整備する方針の正しさの証拠。全248件pass。
4. ユーザー判断待ち(非ブロッキング): ②damp色の彩度 ③期限切れPAT削除。
