# 継ぐ火 -Kept Flame- プロジェクト

コロニー運営×テックツリー×派遣探索の完全決定論ブラウザゲーム。ゲーム本体にLLMは使わず、運営(コンテンツ追加・不具合対応・異常検知)にClaude Codeを使う。

## 必読

- 新しいセッションで作業を始める前に、まず `ONBOARDING.md` と `MEMORY.md` を読むこと(他の文書はONBOARDING.mdの表に従い必要時のみ読む)
- 技術的な決定は `docs/技術設計書_継ぐ火_ADR.md`、ゲーム仕様は `docs/企画書_継ぐ火_GDD.md` が正。これらと矛盾する実装・提案をしない。変更したい場合はユーザー承認を得てから文書側も更新する

## 絶対ルール

- 完全決定論を壊さない: Math.random / Date.now / new Date() / 許可リスト外のMath関数を engine 内で使わない(詳細はADR-006/007)
- LLMの自動実行経路(headless、GitHub Actions連携、Agent SDK、Routines)を追加しない(課金の壁。詳細はONBOARDING.md §3)
- コンテンツはJSONのみでadditive追加。既存contentファイルの削除禁止(tombstone方式)
- ダークモード/ダークテーマの使用禁止
- 作業の節目で `MEMORY.md` を更新(完了/未解決/次のステップ)

## 現在地

企画書・技術設計書(ADR)完成、ユーザー承認待ち。実装未着手。次の作業 = ADR承認 → Phase 0(課金確認) → 先行プロトタイプ計測12項目(ADR末尾) → 実装。
