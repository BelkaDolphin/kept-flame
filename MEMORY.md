# プロジェクト進捗メモ(軽量スナップショット方式)

**運用ルール(2026-08-08導入・ユーザー指示「毎セッションのトークン肥大を止める」)**

- 本ファイルは「現在地・裁定待ち・次のステップ・運用の約束・アーカイブ索引」だけを持つ**スナップショット**。節目の更新は追記ではなく**該当行の書き換え**で行い、履歴を溜めない
- 完了タスクの詳細経緯は `docs/memory-archive/` へ移す(削除禁止・原文のまま)。過去の経緯が要るときだけ該当アーカイブを**grepで部分読み**する(全読み禁止)
- サイズ上限: 警告15KB/違反30KB。更新後に `npm run memory:gate` で機械判定(違反=exit 1)
- 各タスクの実消費トークンは該当スナップショット行に併記して継続記録する

## 現在地(2026-08-08時点)

- 実装フェーズ進行中。main = `ef42a90`(**v26必-1オフライン復帰修正を統合・push済み** 2026-08-08)。test 3315全pass(+22)・golden 89本差分なし・夜間ゲート基線 pass20/fail0/unverifiable5(正本 `sim/output/nightly-gate-report.m75.json`)
- **台帳v26は全件裁定済み(2026-08-08ユーザーOK)**: https://claude.ai/code/artifact/60ab9620-9cea-4799-b618-05efff1b1b9d — 真因=起動時オフライン復帰の未実装(セーブに壁時計なし→起動時アンカー差分0=閉じてた時間が消滅。engine単体は設計どおり薪2.1本/h)。**必-1実装完了**(Opus 207k・コミット `ef42a90`): エンベロープ `savedAtMs`+`createTickDriver({startElapsedMs})`+`computeOfflineElapsedMs`+boot結線。旧セーブ=経過0の寛容読み・export/importテキストに非搭載・`worldLoaded`は従来どおりsyncToのみ・72h超は初回pump→Worker経路→syncToで残余破棄をテスト固定。**逸脱1件=`SAVE_FORMAT_VERSION` bump非実施**(この軸の版差は前後両向きハード拒否→bumpするとstable/beta往復で進行喪失。savedAtMsは省略可・checksum外・欠けても旧挙動でADR-012「黙って壊れる」に非該当。根拠は `migration.ts` §0(i) に記録)→ 統率者承認・台帳v27必-1でユーザー追認済み(2026-08-08)。**必-2**(序盤レート再調整)=ユーザー再プレイの体感確認待ち。注意: 修正の効き目は「修正版で一度遊んで保存された後の次回起動から」(旧セーブの初回起動は経過0スタート)
- **台帳v25/v27も全件裁定済み**(2026-08-08ユーザー「両方推奨でOK」): v25=M74/M75追認+M75解釈4点追認・algoVersion7維持(実content込みで観測挙動を読む保守運用の前例)・夜間ゲート新基線採用(以後の悪化判定はこの基線から)・M76編成確定・休眠2件登録(①士気→想起増幅の構造不発=post-MVP再校正 ②1人拠点の他拠点移動導線=将来UI束候補)。v27=bump非実施追認・メモリ軽量化コミット確定。台帳: v25 https://claude.ai/code/artifact/508504f7-4cf8-4dd1-a4da-2088869d8d7e / v27 https://claude.ai/code/artifact/2ff1d70b-b918-4719-ba61-25d85252f42a
- **M76「拠点UI小束」投入中**(Sonnet・目安150k・src/ui+testsのみ・v25必-4): (a)拠点設置パネルに buildCost 全行+在庫不足▲(derived の CostLineView 拠点版・R8-03同型の予防) (b)`exodusNoCrew` 文言を rejection の limit/actual を使った「最少N人」表示へ+大移動画面に乗員不足の事前表示 (c)任意=`minEarnedPointsWarn`(継承点ほぼゼロ警告・余力があれば)
- ロードマップ残: M76統合 → 部分ラウンド検収(M74+75+76+v26修正束ね: 軸A該当台本+軸C該当セル+D文言スイープ・**ブラウザ再起動跨ぎ復帰シナリオを台本に常設**)→ **M42(実機計測・実機準備=ユーザー作業)**→ M43(最終検分)
- 保留(ユーザー作業待ち): M45(ADR-030レビュー分離=bot用GitHubアカウント+PAT作成)
- 休眠登録(post-MVP・台帳v25必-5): ①士気→想起リスク増幅の構造不発(routineFloor 35 > moraleThresholdMid 30・発火0) ②1人拠点の住民が他拠点へ移動不能(`outpostWouldBeEmpty` reject・「別拠点への移動」導線が将来UI束候補)

## 運用の約束(恒久ルール・ユーザー指示)

- ★裁定は**推奨案つきHTML台帳(Artifact)**で提示。台帳番号は連番(次は **v28**)
- 報告は「**何に・何のために・何を変えたか**」の因果構造で書く
- 自律作業ターンの終わりに**作業まとめHTML(Artifact)**を提示
- 量産系エージェントは **Opus/Sonnet を明示指定**(機械的処理はHaiku)、最上位モデルは検分・統合のみ。攻撃はseverity分類・収束条件 fatal 0
- 課金の壁: LLMは**人間起動の対話Claude Codeのみ**。headless/`claude -p`/GitHub Actions LLM連携/Agent SDK/Routines/Managed Agents 禁止(詳細 ONBOARDING §3)
- 完全決定論(engine内 Math.random/Date.now/new Date()/許可外Math禁止)・content削除禁止(tombstone)・ダークテーマ禁止(詳細 CLAUDE.md)
- セッション終了時(「終わり」「また明日」等)は作業内容をRAGへingest

## 次のステップ

1. M76の統合検分 → 部分ラウンド検収(復帰シナリオ常設込み)
2. **ユーザー再プレイ**で序盤体感を確認(v26必-2の判断材料。薄ければ序盤レートを M41帯続きとして裁定に上げる)。注意: オフライン復帰の効き目は修正版で一度保存された後の次回起動から
3. M42用実機(iPhone SE2/Android中位機/8GB Surface)の準備・接続方法 — ユーザー作業

## アーカイブ索引

- `docs/memory-archive/MEMORY-2026-07-24_2026-08-08.md`(約279KB・旧MEMORY.md全文) — 企画検討第1〜5回・課金/配信基盤の確定経緯・先行計測T0〜T16・Phase0〜M75の実装ログ(実消費トークン記録含む)・評価Round1〜9・裁定台帳v1〜v25の詳細経緯・各タスクの設計要点と教訓
