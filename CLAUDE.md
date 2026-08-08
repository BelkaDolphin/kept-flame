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
- 作業の節目で `MEMORY.md` を更新する。方式は**スナップショットの書き換え**(追記で伸ばさない): 完了タスクの詳細経緯は `docs/memory-archive/` へ移し、更新後に `npm run memory:gate` でサイズ判定(警告15KB/違反30KB)。過去の経緯はアーカイブをgrepで部分読み(全読み禁止)

## 現在地

`MEMORY.md` の「現在地」節が正(このファイルには書かない。二重管理で腐るため — 2026-08-08改訂)。
