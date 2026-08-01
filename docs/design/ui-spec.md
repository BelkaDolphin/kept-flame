# UI 仕様(軽量)— 12画面の表示要素・遷移・GDD 対応表 (M29)

作成日: 2026-07-31 / 対象: `src/ui/**` + `src/platform/{router,clock}.ts`
根拠文書: **GDD 6.6**(ホームハブと 12 画面 IA)・GDD 2.2 / 4.1(バッジ設計)・GDD 4.2(帰還ダイジェスト)・**ADR-026**(tick)・**ADR-027**(ルーティング)・ADR-029(性能予算)・`docs/design/architecture.md`(ストア形状と画面の書き方)・`docs/design/tags-spec.md`(タグ 4 重符号化のパレット)

**この文書の目的**(ロードマップ M29 行 [2026-07-28追記]): Phase 7 の画面量産(M30〜M33)が「何を出すか」を毎回 GDD から読み直さずに済むようにすること。**ワイヤーフレームは作らない**。表示要素・遷移・GDD 該当節の対応表と、全画面に共通する規約だけを書く。意匠の詳細は各タスクの担当とする。

**この文書は仕様の正本ではない。** ゲーム仕様の正本は GDD、技術決定の正本は ADR である。ここに書いてあるのは「その 2 つを画面という単位へ割り付けた表」であり、矛盾があれば GDD/ADR が勝つ。

---

## 0. 全画面に共通する規約(先に書く)

1. **ライトテーマ固定**。`prefers-color-scheme: dark` の分岐を書かない(CLAUDE.md 絶対ルール / GDD 3.1「暖色トーン・ダークテーマUI不使用」)。
2. **最小タップ領域 44px 角**(GDD 6.6)。ボタン・バッジ・ナビ項目すべてに適用する。
3. **購読してよいのは `store.derived.*` だけ**。`store.sources.*` を画面から読まない(architecture.md §6)。
4. **判定を画面に書かない**。「置けるか/払えるか」は engine の `apply` が返す拒否(`DispatchResult.command.rejection`)で知る(architecture.md §6-7)。
5. **非アクティブ画面は物理アンマウント**(ADR-027(2))。`display:none` で残さない。実装は `AppShell` の `ScreenHost` が 1 画面ぶんしか vnode を作らないことで構造的に保証する。
6. **色だけで意味を運ばない**。タグ 7 種は色+記号+パターン+数値(ADR-003 / tags-spec)、緊急度バッジは色+ラベル文言+件数(§3)。

---

## 1. 12画面 + 設定の対応表

`#` は GDD 6.6 の丸数字、`id` は `src/ui/screens.ts` の `ScreenId`(= URL ハッシュ `#/<id>`)。
「状態」の **実装済** は M29 で中身まで作った画面、**予定(Mxx)** は M29 でルート登録とプレースホルダのみ用意した画面。

| # | id | 画面 | 主な表示要素 | ここから行ける先(遷移) | GDD 該当節 | 状態 |
|---|---|---|---|---|---|---|
| ① | `home` | ホームハブ | 緊急度バッジ列(赤/黄/灰・§3)、コロニー概況(住民数・施設数・研究/成文化の進行件数)、ゲーム内時計(tick)、全画面へのナビ | **バッジ 1 タップで該当画面へ**(§3 の表)、ナビから 12 画面すべて | **6.6**, 4.1(a), 2.2 | 実装済 (M29) |
| ② | `grid` | 格子ビュー | 6×8 格子、タグ 4 重符号化、配置プレビュー、常時過密警告バッジ、凡例パネル、セル内訳ビュー、ピンチズーム/パン | セル選択 → ③施設詳細、施設カタログ → 配置、瓦礫セル → 開墾 | 6.1〜6.5, 9.1 | 予定 (M30)。部品は M18/M19 で実装済(`src/ui/screens/grid/`) |
| ③ | `facility` | 施設詳細/増築 | 選択施設の Lv・産出・就労者・隣接内訳(どの隣接が +何%、過密で −何%)、増築コストと実行 | ②へ戻る、④住民配置 | 6.1, 6.5, 6.7 | 予定 (M30) |
| ④ | `residents` | 住民一覧・配置 | 住民の士気/定着度/特性/担当施設/派遣中フラグ/想起困難の残り、配置変更 | ③施設詳細、⑦探索本部(編成)、⑥成文化キュー | 7.1〜7.6, 11.2 | 予定 (M30) |
| ⑤ | `research` | 研究ツリー | エラ別テック一覧、前提関係、researchCost と進捗、解禁済み/未解禁、**(A)/(B) の区別** | ⑥成文化キュー | 5.1, 5.2, 7.4, 11.4-1 | 予定 (M31) |
| ⑥ | `codify` | 成文化キュー | 未成文の解禁済み技術、保持者数(唯一保持の強調)、想起リスク%、残存tick(猶予)、媒体(石板/紙)、おまかせ成文化の提案 | ④住民一覧、⑤研究ツリー | 4.1(b), 7.4, 7.5, 11.1追補, 2.1 | 予定 (M31) |
| ⑦ | `expedition` | 探索本部 | 目的地と距離帯(near/far/deep)、編成候補と総合戦力、方針(撤退/強行)、**ROI の (B) 損失項**、帰還予定 tick | ④住民一覧、⑧冒険記、⑨衛星拠点 | 8.1〜8.3, **8.6** | 予定 (M32) |
| ⑧ | `chronicle` | 冒険記ビューア | 帰還ログ(レンダリング済み文字列・50件上限+畳んだ件数)、住民 memoir(加入/死亡/絆節目/保護) | ④住民一覧 | 7.3, 8.4, 12.5-9 | 予定 (M32) |
| ⑨ | `outposts` | 衛星拠点管理 | 拠点タイプ(鉱山/農園/林)・Lv・距離帯・常駐住民・供給レート・維持費・hazard・拠点網 ROI | ④住民一覧、⑦探索本部 | 9.2 | 予定 (M32) |
| ⑩ | `migration` | 大移動ナップサックUI | 2 プール(記録/資材)の選択、重量上限、置いていくものの確認、周回シード | ⑪継承点購入、＋設定(バックアップ促進) | 10.2, 10.4, 10.5 | 予定 (M33) |
| ⑪ | `inheritance` | 継承点購入 | 継承点残高、購入可能な恒久強化、上限クランプ | ⑩大移動 | 10.3, 11.4-6 | 予定 (M33) |
| ⑫ | `digest` | 帰還ダイジェスト(復帰専用) | **ネガティブ先頭単独表示 → ダイジェスト → ドリルダウン**の 3 段(§4) | ダイジェスト各行から該当画面へワンタップ | **4.2**, 6.6, 8.4 | 実装済 (M29) |
| ＋ | `settings` | セーブ/設定 | エクスポート/インポート、容量、バックアップリマインド、難度シード表示 | ①ホームハブ | 12.5, 13.3, 2.2 | 予定 (M33) |

> **12画面の数え方**: GDD 6.6 の表は①〜⑫ + 「＋ セーブ/設定」であり、マウント単位は **13** ある(`src/ui/screens.ts` §1 が正本)。「12画面」は①〜⑫を指す。

> **[2026-08-01裁定・台帳v9 追-3] ナビゲーションの集約(束A)**: ナビは 13 タブを並べる方式をやめ、**5 グループ(拠点/研究/探索/周回/設定)+タップで開くポップオーバー**に集約した(正本 = `src/ui/navGroups.ts`)。設定のみ 1 タップ直遷移。丸数字(①②…)のナビ表示は全廃(本文書の丸数字は GDD 対応の識別子として残す)。ヘッダは sticky で、資源 HUD(薪/鉄/粘土/紙/廃材・`derived.resources` 購読)を常時表示する。

---

## 2. ルーティング(ADR-027)

| 項目 | 決定 |
|---|---|
| 方式 | **自前ハッシュルータ**(`src/platform/router.ts`)。npm 依存を足さない(ADR-001 / ADR-027(1)) |
| 語彙の持ち方 | ルータは `ScreenId` を **import しない**(「platform → ui は無い」= architecture.md §1 の 3 規則の 1 つ)。ルート語彙は `createHashRouter(host, { routes: SCREEN_IDS, fallback: DEFAULT_SCREEN_ID })` の形で composition root が注入する |
| DOM の掴み方 | `location` / `addEventListener` は `RouterHost` の 3 メソッド(`getHash` / `setHash` / `replaceHash` / `subscribe`)に隔離。ブラウザ実装は `createBrowserRouterHost()`。**この分離があるので jsdom 無し(`environment: "node"`)でもルータ本体をテストできる** |
| URL 形 | `#/<screenId>`(例 `#/home`, `#/grid`)。`#<screenId>`(スラッシュ無し)も受理する |
| 未知のハッシュ | `DEFAULT_SCREEN_ID`(= `home`)へフォールバックし、URL を正準形へ書き直す |
| 権威 | **ルータが現在地の唯一の権威**。ストアの `activeScreen` は写しであり、ストアから URL を書き換えない(`src/ui/screens.ts` §2) |
| 非アクティブ画面 | **物理アンマウント**。`ScreenHost` が現在画面 1 個ぶんしか vnode を作らないので、購読(`ReactiveScope`)は `useScreenMount` の cleanup で必ず切れる(ADR-027(2)) |
| 画面の活性宣言 | 画面コンポーネントは `useScreenMount(store, id, { activate: false })` で**自分を活性だと宣言しない**。`screenOpened` を dispatch するのはシェル 1 箇所だけ(M18★5 への回答) |
| 戻る操作 | ブラウザの戻る = `hashchange`。ルータは履歴を自前で持たない(`location.hash` が唯一の状態) |
| 復帰時 | オフライン差分があれば起動時に⑫`digest` を出す(GDD 4.2「復帰時に必ず最初に表示」)。判断は composition root(`src/main.tsx`)が行い、ルータは指示された初期画面を開くだけ |

---

## 3. 緊急度バッジ(GDD 2.2 / 4.1(a))

### 3.1 意味論(GDD が定めている部分・変更不可)

| 段 | 意味(GDD 4.1(a) / 2.2) | 点灯条件の性質 |
|---|---|---|
| **赤** | **(B) レア資産が実際に喪失へ近づく**特定状況 | **限定点灯**。「唯一保持者を派遣中 × 士気危機の重なり等」。常態化させない(GDD 2.2 が数値で抑制すると明記) |
| **黄** | 先延ばしコスト(通常の想起困難など) | 常態化してよい。損失ではなく**緩衝**(生産一時停止・回復可能) |
| **灰** | 任意 | 見なくても損しない。72h 放置でクリティカルパス (A) は一切失われない(GDD 2.2 の基準線) |

### 3.2 M29 で実装したバッジ(`src/ui/derived.ts` の `homeAlerts`)

| id | 段 | 点灯条件 | 遷移先 | 根拠 |
|---|---|---|---|---|
| `bLossImminent` | 赤 | `lossClass = rareIrreversible` かつ 解禁済み かつ 未成文 かつ **生存保持者が 1 人**、かつその 1 人が **派遣中** または **士気 < `recallRisk.moraleThresholdLow`**(content 値・既定 15) | ⑥`codify` | GDD 2.2, 7.4, 11.2 |
| `recallImpaired` | 黄 | 想起困難で稼働が止まっている住民が 1 人以上 | ④`residents` | GDD 4.1(a), 11.2 |
| `codifyPending` | 黄 | 未成文の解禁済み技術(生存保持者あり)が 1 件以上 | ⑥`codify` | GDD 4.1(b), 7.4 |
| `researchIdle` | 黄 | 進行中の研究が 0 件 | ⑤`research` | GDD 5.1(研究が止まると停滞コスト) |
| `expeditionActive` | 灰 | 未帰還の派遣が 1 件以上(帰還予定 tick を併記) | ⑦`expedition` | GDD 8.1, 8.4 |
| `idleResidents` | 灰 | どの施設にも就いていない住民が 1 人以上 | ④`residents` | GDD 7.1 |

- **赤の限定性の実装上の担保**: 赤は「(B) 分類の tech」に限る。(A)(`criticalRecoverable`)はどれだけ危なくても赤にしない(GDD 7.4「『取り返しのつかない喪失』は (B) のみ」)。
- **判定は engine の既存述語を呼ぶだけ**: `isTechUnlocked` / `isCodified` / `techHoldersOf` / `lossClassOfTech`。UI 側に喪失判定を書き写さない。
- **tick を出力に含めない**(ADR-027(4) / `derived.ts` §2)。バッジは件数と ID の集合だけを持ち、毎分オブジェクトが変わらないよう `equals` で伝播を止める。
- `gridSummary`(48 セル依存)を①ホームハブから購読しない(`derived.ts` §1(b) の用途制限どおり②と⑫に限る)。過密は②の警告総数と⑫のダイジェストで見せる。

### 3.3 バッジの配色(`docs/design/tags-spec.md` と衝突しない値)

タグ 7 種のパレット(ink/tint)とは**別の名前空間**(`--kf-urgency-*`)にし、tags-spec に出てくる値を 1 つも再利用しない。共有するのは中立トークン(`--kf-ink-body` / `--kf-ink-muted` / `--kf-line-grid`)だけである。

| 段 | 面(fill) | 文字 | 枠線 | 記号+文言 | 面 Y | 文字コントラスト | 枠線 対 白 |
|---|---|---|---|---|---|---|---|
| 赤 | `#A11334` | `#FFFFFF` | 同色 | `!` +「危機」 | 0.0829 | **7.90:1** | 7.90:1 |
| 黄 | `#FFD34D` | `#24201C` | `#7A5A00` | `▲` +「要対応」 | 0.6838 | **11.30:1** | 6.38:1 |
| 灰 | `#EEECE8` | `#5B534B` | `#8A857D` | `・` +「任意」 | 0.8399 | **6.39:1** | 3.66:1 |

- 3 段の面の相対輝度が 0.08 / 0.68 / 0.84 と大きく離れているので、**グレースケールでも 3 段が判別できる**(色覚多様性対応の骨)。
- 黄と灰は面自体が白に近く境界が消えるため、非テキストコントラスト ≥3:1(WCAG 1.4.11)を満たす枠線を必須とする。
- 色だけに頼らないよう、**各バッジは必ず記号と日本語ラベルと件数を持つ**。
- タグ ink(`#8C290B` 熱源 / `#975D0C` 学芸)と色相が近いのは赤/黄という指定が GDD 側の要求(4.1(a))だからであり、**同一画面に共存しない**ことで実運用の衝突を避ける(タグ ink が出るのは②③、緊急度バッジが出るのは①⑫)。意匠の最終確認はユーザー目視を推奨する(★項目)。

---

## 4. ⑫帰還ダイジェストの 3 段(GDD 4.2)

「復帰時に必ず最初に表示」「**ネガティブ先頭単独表示 → ダイジェスト → ドリルダウン**」の 3 段をそのまま構造にする。

| 段 | 中身 | データ源(すべて **engine の既存データを読むだけ**) |
|---|---|---|
| 1. ネガティブ先頭 | 最も重い悪い知らせ **1 件だけ**を単独で出す。優先順は (B) 一回性喪失 > 派遣全滅 > 住民死亡 > (A) 停滞喪失 > 脱落者あり帰還 | `ResearchState.loss`(`irreversible`)、`ResidentLife.diedTick`、`MemoirEntry`(death/partnerLost/explorationRescue)、`DispatchSnapshot.casualtyMemberIds` |
| 2. ダイジェスト | 不在中に起きたことの要約行(件数+1 行文言)。帰還ログ・出来事・盤面・拠点 | `GameState.renderedLogs`(レンダリング済み文字列・50 件上限 + `foldedCount`)、`memoir`、`gridSummary`、`outpostsById`、`dispatchSnapshots` |
| 3. ドリルダウン | 各行から該当画面へワンタップ遷移 | 行ごとに `ScreenId` を持たせる(⑧冒険記 / ④住民 / ②格子 / ⑨拠点 / ⑦探索本部) |

- **「不在中」の起点**は engine の state に無い(`lastSeenTick` のようなフィールドを足すと engine 変更 = 禁止)。よって composition root(`src/main.tsx`)が **catch-up 前の tick** を `bootTick` として画面へ渡し、`tick > bootTick` の出来事を「不在中」と定義する。これは**セーブに載らない UI 状態**である。
- **新しい engine 計算を足さない**。ダイジェストは `buildReturnDigest(state, bootTick)`(`src/ui/derived.ts` §6)という純関数で、既存フィールドを読んで並べ替えるだけである。
- 緊急成文化フェーズ(GDD 4.2 の「復帰後の緊急成文化フェーズ」= 実時間制限なしで喪失トリガーをまとめて保留する機構)は **engine 側の機構が未実装**であり、M29 の担当外。ダイジェストは⑥成文化キューへの導線を出すところまでを持つ(申し送り)。

---

## 5. tick 駆動(ADR-026)— 画面から見た規約

- **tick はタイマーの発火回数に依存しない**。`src/platform/clock.ts` の `planTick(anchor, nowMs)` が
  `targetTick = anchorTick + clamp(0, floor((nowMs - anchorMs)/60000), 4320)` を返す **純関数**であり、
  `pump()` を 1 回呼んでも 600 回呼んでも同じ時刻なら同じ結果になる。
- 画面は tick を**表示するだけ**で、進める側にはならない。進めるのは composition root が持つ `TickDriver` 1 個だけ。
- 差分が `LIVE_ADVANCE_MAX_TICK_DELTA`(600)を超えたらメインスレッドで進めない。`onCatchUpRequired` で Worker 経路へ回す(ADR-019 / ADR-029)。ストア側も 600 超は例外にして黙って走らせない。

---

## 6. [2026-07-30裁定] `GridSummary.overcrowdedCellCount` の命名整理

**裁定内容**(ロードマップ M29 行): 実態は「過密している**施設**の数」(大型施設はアンカーセルでのみ 1 回数える・M17)であり、`Cell` を名乗っているのが誤解を招く。`overcrowdedFacilityCount` へ改名する。

**M29 での実施結果**: **実施した**。

| 項目 | 内容 |
|---|---|
| 定義箇所 | `src/ui/derived.ts` の `GridSummary`(UI 層の派生値の型) |
| 影響範囲 | `src/ui/derived.ts`(型 + 集計ループのローカル変数)と `tests/ui/derived.test.ts` の 2 アサーションのみ |
| engine への影響 | **なし**。`GridSummary` は engine にも schema にも content にも conformance にも現れない(golden vector は engine の観測挙動であり、UI 派生値の名前は 1 バイトも関係しない) |
| セーブへの影響 | **なし**。`GridSummary` は state ではなく派生値であり直列化されない |

`occupiedCellCount`(セル単位)と `overcrowdedFacilityCount`(施設単位)が**同じ型の中で単位が違う**ことが名前から読めるようになった、というのがこの改名の全部である。`overcrowdedNeighborTotal` は「無効化された近傍の総数(タグ横断・施設単位の合計)」であり単位は近傍なので据え置く。

---

## 6-2. アプリシェルのファイル構成(M29 で作ったもの)

| パス | 責務 | テスト |
|---|---|---|
| `src/platform/router.ts` | 自前ハッシュルータ + `RouterHost`(DOM 境界) | `tests/platform/router.test.ts` |
| `src/platform/clock.ts` | `planTick`(ADR-026 の純関数)+ `TickDriver` | `tests/platform/clock.test.ts` |
| `src/ui/shellSession.ts` | ルータ ⇄ ストアの結線(`screenOpened` の唯一の発行点) | `tests/ui/shellSession.test.ts` |
| `src/ui/AppShell.tsx` | ヘッダ(sticky・資源 HUD) / `ColonyClock` / `ScreenNav` / `ScreenHost` | `tests/ui/screens/appShell.test.ts` |
| `src/ui/navGroups.ts` | **[束A]** ナビ 5 グループ(拠点/研究/探索/周回/設定)の正本 | 同上(ナビ構造追随) |
| `src/ui/screens/registry.tsx` | 画面 ID → コンポーネント(**全件必須**を型で強制) | 同上 |
| `src/ui/screens/home/HomeHub.tsx` | ①ホームハブ + `UrgencyBadge` | `tests/ui/screens/homeHub.test.ts` |
| `src/ui/screens/digest/ReturnDigest.tsx` | ⑫帰還ダイジェスト | `tests/ui/screens/returnDigest.test.ts` |
| `src/ui/screens/PlaceholderScreen.tsx` | 未実装画面(画面名 + 担当タスク) | `tests/ui/screens/appShell.test.ts` |
| `src/ui/screens/format.ts` | ゲーム内時計の整形(ロケール非依存) | 同上 |
| `src/ui/appShell.css` | シェル + バッジ + ①⑫ の意匠(ライト固定) | — |
| `src/newGame.ts` | 新規ゲームの初期盤面(**暫定**・§7-7) | — |
| `src/platform/timeScale.ts` | **[M59]** `createScaledClock`(倍速ラッパ・§10.2) | `tests/platform/timeScale.test.ts` |
| `src/ui/testplaySpeed.ts` | **[M59]** `createTestplaySpeedController`(UI 反応系ブリッジ・§10.2) | `tests/ui/testplaySpeed.test.ts` |
| `src/main.tsx` / `index.html` | composition root(副作用の組み立て) | ブラウザ実機のみ(§7-8) |

---

## 7. 申し送り(M30〜M33 が拾うもの)

1. **③施設詳細/⑥成文化キュー等の派生値は `derived.ts` に足す**(architecture.md §7-1)。画面ファイルの中で `computed(() => store.sources.state.value…)` と書き始めない。
2. **施設 ID の採番方式が未決**(M18★4)。`placeFacility` は呼び出し側が発行した ID を要求するため、②の施設カタログを作る M30 で決める必要がある。
3. **建設/増築コストが content スキーマに無い**(architecture.md §9-5)。③の増築 UI はコスト表示の材料が無い状態なので、スキーマ拡張(要ユーザー判断)が先。
4. ~~**`beginResearch` が未実装**(architecture.md §9-6)。⑤研究ツリーは「選ぶ」操作が engine 側に無く、現状は ID 昇順の自動選択である。M31 着手前に裁定が要る。~~ **[2026-08-01 M50 で解消]** `beginResearch` 実装済み(選択が有効ならそれ/無ければ ID 昇順先頭の2段)。⑤は画面無変更で動作。あわせて成文化 tick 結線・`cancelCodification`・拠点操作4コマンドも M50 で実装済み。~~⑥の取消ボタンと⑨の操作 UI の接続は次の UI タスク~~ **[2026-08-02 M54 で解消]** ⑥に取消ボタン(返金なし明記)、⑨に設置/放棄/駐在割当/解除の操作 UI を接続した(§8 の★2 も参照)。
5. **緊急成文化フェーズ(GDD 4.2)が engine 未実装**。⑫は導線だけを持つ(§4)。
6. **バッジ意匠のユーザー目視確認**(§3.3)。M19★4 と同じ扱い。
7. **新規ゲーム生成(`src/newGame.ts`)は暫定であり、ロードマップに担当タスクが無い。** 固定 worldSeed / 住民に `life` を付けない(= 寿命で死なない)/ 初期資源に根拠なし、の 3 点が仮置きである。難度シード「穏」(GDD 2.2)も未実装。
8. **セーブの結線は最小構成**(architecture.md §8 のとおり `SaveScheduler` + `attachLifecycleFlush`)。セーブ破損時の救済 UI・localStorage ミラーへの縮退・エクスポート/インポート導線は＋設定画面(M33)の担当であり、M29 は「読めなければ新規開始」で通している。
9. **⑫を出す条件は「セーブ復帰 かつ 経過 60 tick 以上」**(`src/main.tsx` の `DIGEST_MIN_ELAPSED_TICKS`)。GDD 4.2 は「復帰時に必ず最初に表示」と書いているが、5 分前に閉じただけの再訪でもダイジェストを挟むのは煩わしいため、しきい値を置いた。数値はバランス調整(M39〜M41)の対象。判定は **catch-up 適用後の tick ではなく `planTick` の `targetTick`** で行う(長期不在ほど Worker 経路が非同期なので、適用後を見ると「不在が長いほど⑫が出ない」逆転が起きる)。
10. **セッション終端の合図(GDD 4.2「今日のタスク完了。次の危機は最短でも約X時間後」= MVP 必須)は未実装。** X は「次の想起困難最短予定・保管庫充填予定・探索帰還予定の最小値」と定義されているが、**想起困難は粗粒度ステップごとのベルヌーイ抽選であって「予定 tick」が存在しない**(GDD 11.2 / `rules/recall.ts`)ため、engine 側に「次の危機までの最短 tick」を返す関数が無い。M29 はバッジが 1 つも点いていないときに「急ぎの用はありません。72時間放置しても失われるものはありません」(GDD 2.2 の基準線)を出すところまでを実装した。X の定義(確率事象をどう「予定」に写すか)は要裁定。

---

## 8. M32 で実装した範囲(⑦探索本部/⑧冒険記ビューア/⑨衛星拠点管理)

- ⑦⑧⑨とも `src/ui/derived.ts` の派生値(`expeditionCandidates`/`expeditionDispatches`/`expeditionSlots`/`memoirFeed`/`renderedLog`/`outpostOverview`)と、GDD 8.6 / 11.4-7 の ROI 式(`rules/exploration.ts` の `explorationRoi`・`rules/outpost.ts` の `outpostNetworkRoi`)をそのまま呼ぶ 2 つの純関数(`explorationDestinationsForBand`/`previewExplorationRoi`)だけを土台にしている(新規 engine 計算なし)。
- **目的地選択の 2 段構え**: GDD 8.1 原文の「目的地(近郊/遠隔/深部)」を距離帯そのものとして選ばせたうえで、M22 の named event content(`content/event.json`)がその距離帯にあれば具体的な行き先も選べる。content に無ければ「この距離帯(手続き生成)」の 1 択(band 由来の合成 ID)へ自動フォールバックする——M21 以前と 1 bit も挙動が変わらないフォールバック規約(`rules/event.ts`)を UI 側でも踏襲した。
- **編成テンプレワンタップ(★1 として下記に記載)**: 本文書(§1 の⑦行)は列挙していなかったが、GDD 2.1「探索編成テンプレ」の定義と `assist/exploration.ts`(M27)の実装意図(呼び出し側 UI からの利用を前提としたコメント)に基づき実装した。提案(`suggestExpeditionTeams`)→確認表示(戦力/目標/理論最大の内訳)→適用(選択チームへ反映)の3段。
- ~~**⑨衛星拠点管理は表示専用**: 駐在割当/解除・拠点設置/放棄のコマンドが engine(`src/engine/commands.ts`)に 1 つも実装されていない(語彙予約すらない)ため、GDD 9.2 が言う「駐在割当/解除」の操作 UI は作らず、一覧・供給・維持費・hazard・(B)喪失リスク・拠点網 ROI の表示のみに留めた(★2 として下記に記載)。~~ **[2026-08-02 M54 で解消]** engine 側のコマンド 4 種は M50 で実装済みだったものを本画面へ結線した。設置(タイプ/距離帯/常駐 1〜4 名選択)・放棄・駐在割当(住民セレクト+ボタン)・駐在解除(住民ごとのボタン)を追加。住民の絞り込み(寿命/派遣中)は行わず、engine の reject に委ねる(architecture.md §6 の7箇条目どおり)。
- **★1**: 上記の編成テンプレワンタップは ui-spec 側の記載漏れであり、実装後に本節へ追記する形で埋めた(手戻りなしと判断)。
- ~~**★2**: 拠点コマンド不在は M24(データ層のみ実装)の時点からの既知のスコープ外であり、M32 は UI 側で新設せず表示専用とした。駐在割当/解除・拠点設置/放棄のコマンドを新設するかどうかは要ユーザー判断(新規 engine タスクの要否を含む)。~~ **[2026-08-02 M54で解消]** 上記のとおり接続済み。

---

## 9. M54 で実装した範囲(UI 残件束ね・⑥⑨の操作結線 + バナー2種 + 設定リセット)

engine/schema/content/conformance は無改変(M50 で完成済みのコマンド4種+`cancelCodification`を UI へ結線しただけ)。5件:

1. **⑥成文化キューの取消ボタン**: `CodifyTechRow` の `pendingRecords` 各行へ「取消(返金なし)」ボタンを追加。`cancelCodification` を dispatch し、成功トースト・失敗は `RejectionBanner`。返金が無いことをボタン文言・画面注記・トーストの3箇所で明記。
2. **⑨衛星拠点の操作 UI**: `OutpostCard` に常駐者ごとの解除ボタン・駐在させる住民セレクト+ボタン・放棄ボタンを追加。新規設置は `OutpostEstablishForm`(タイプ/距離帯/常駐 1〜4 名トグル)。拠点 ID 採番は `src/ui/screens/outposts/outpostId.ts`(`grid/facilityId.ts` と同型、`<outpostTypeId><連番>` の形。二重プレフィックスを避けるため capitalize 再プレフィックスはしない意図的な逸脱)。
3. **定期バックアップ推奨バナー**: `platform/backupReminder.ts` に M34 の `PromotionPromptTracker` と同型の2層(データ条件=既存 `BackupReminderTracker` / 表示頻度=`PromotionPromptTracker` 流用)を追加し、`AppShell` へグローバル配線。**時計をこの変更で `systemSaveClock`(単調・`performance.now()`)から `systemWallClock`(`Date.now()`)へ修正した**(単調時計はページ再読込で原点が0へ戻るため、複数セッションを跨ぐ「経過実時間」を測れなかった=実装前から潜在していた不具合)。`commandsSinceExport` 軸は今回未結線(★下記)。
4. **起動失敗のその場通知**: `platform/persistence.ts` に `SaveNotFoundError`(初回起動=セーブ無し)を新設し、`loadLatestSave` の「セーブが無い」と「セーブはあったが読めなかった」を型で区別。後者だけ `main.tsx` の `loadOrCreateState` が `loadFailed: true` を返し、`AppShell` が `LoadFailureBanner` を表示して＋設定画面のインポート導線へ誘導する(boot 自体は継続)。
5. **設定画面の「最初からやり直す」導線**: `ResetGameSection`(hooks 不使用・段0/1/2)で確認2段(大移動の1段確認より重大度が高いと判断)。`createNewGameState(content, { algoVersion: state.algoVersion })` を再実行し `worldLoaded(source:"newGame")` で上書き。難度シード/worldSeed は既定のまま(`newGame.ts` の既定値を変えない)。

**★(要ユーザー判断・非ブロッキング)**:
- ①`commandsSinceExport`(バックアップ推奨のコマンド数軸)を未結線。`store.dispatch({type:"commandApplied"})` は画面から直接呼ばれるため、composition root(`main.tsx`)がコマンド発行の粒度で介入する経路が無い(`SaveScheduler.recordCommandOutcome` も同じ制約で現状どこからも呼ばれていない=architecture.md §4-1 の記述と実装の食い違いは別途申し送り)。経過実時間(既定24h)軸のみで周期表示は成立する。
- ②衛星拠点の常駐者候補は寿命/派遣中で絞り込まない(ResidentsScreen.tsx §3 と同じ立場の踏襲)。
- ③「最初からやり直す」の確認は2段(大移動は1段)。誤タップ防止の強度をタスク指示どおり引き上げた設計判断であり、GDD/ADR に段数の明文規定はない。

---

## 10. ヘッダ研究チップ + テストプレイ加速モード([2026-08-02裁定・台帳v10 必-1] / [2026-08-02ユーザー要望] M59)

### 10.1 ヘッダ研究チップ(台帳v10 必-1)

UX プレイテストの指摘(資源以外の「いま何が進んでいるか」がヘッダから見えない)への対応。**研究点はストックではなくレート**(`rules/production.ts` の `researchRateFix`)であり、選択中の 1 本(`currentResearch`・`rules/research.ts` §2。[M50] 選択が有効ならそれ/無ければ ID 昇順先頭)へ直接流れ込む設計なので、資源HUDのような在庫チップが無かった。

- **表示**: 資源HUD(`ResourceHud`)の隣に 1 個だけ追加(`AppShell.tsx` の `ResearchChip`)。研究中は「🔬 `<tech和名>` `<floor(進捗/コスト×100)>`%」、`currentResearch` が undefined(未選択かつ未完了 research が皆無、または残り全てが (B) 一回性喪失で対象外)のときは「🔬 停止中」を `--kf-ink-muted` で淡色表示する。
- **ロジックの置き場**: `derived.ts` の `researchChip`(`ResearchChipView | null`)computed に集約(`orderHudResources` と同じ「純ロジックは derived/純関数、コンポーネントは表示専用」の分担)。研究コストが 0 以下の tech は 100% 固定、進捗がコストを僅かに超える(切り上げ由来・研究完了直前の 1 tick)場合は表示のみ 100 にクランプする(研究ツリー画面の既存クランプと同じ考え方)。
- **[2026-08-02差し戻し] `stalled`(研究点レート0=停止中)**: 台帳v10 必-1 の眼目は「作業台(研究机等)から人を外して研究が止まっていても気づけない」ことであり、`currentResearch` の**選択の有無**だけでは検出できない(選択は生きたまま研究点レートだけが 0 に落ちるケースが本命)。`ResearchChipView.stalled` は「研究点産出施設(`output.kind === "research"`)のうち基礎産出(`facilityOutputPerTick`)と稼働労働(`activeLaborFix`)の両方が正のものが 1 つでもあるか」の軽量判定(`hasActiveResearchProduction`・derived.ts)で決める。隣接乗数は掛けない(タグ横断 ±60% クランプで常に正なので符号に影響しない・doc コメント参照)。**精度の限界**: 想起困難の判定は毎回その場で行い(区間索引 `buildImpairmentIndex` は渡さない)、③施設詳細と同じ精度に揃えてある。`stalled: true` のときは tech名/%を**残したまま**淡色化し、値の末尾に「(停止中)」を付ける(`chip === null` の「🔬 停止中」とは区別する)。
- **タイポ**: 既存 HUD チップと同型(`.kf-hud__chip`)・12px 床(`--kf-fs-micro`)を継承。停止中(`chip === null` または `stalled: true`)は `.kf-hud__chip--muted` 修飾。

### 10.2 テストプレイ加速モード(ロードマップ M59)

プレイテストで深部探索・72h オフライン復帰等を待てない問題への対応。**セッション限り**(localStorage 等へ一切永続化しない。リロードで必ず ×1 に戻る)。

- **`src/platform/timeScale.ts`**: `createScaledClock(base: MonotonicClock)` が `ScaledClock`(`now()`/`speed()`/`setSpeed(n)`)を返す。式は `scaledNow = scaledAnchorMs + (base.now() - baseAnchorMs) * speed`。`setSpeed` は両アンカーを呼び出し時点の値へ引き直すので、直前直後で `now()` は連続(ジャンプ無し・巻き戻り無し)。`speed` は正の有限数のみ受理し、それ以外は `TimeScaleError`。
- **結線は 1 点のみ**: `src/main.tsx` が `createTickDriver` へ渡す `clock` オプションだけを `createScaledClock(performanceClock)` の結果に差し替える。**`saveScheduler`(`systemSaveClock`)・`backupReminder`/`installPromotion`/`notificationCapability`(いずれも壁時計 `Date.now()`)・起動時オフライン復帰の経過計算(`main.tsx` の `bootPlan`)には触れない**——これらは実時間そのものを扱う責務であり、速度変更は物理的に main.tsx 起動後(UI 操作後)にしか起こり得ないため、起動直後の catch-up 判定は構造的に影響を受けない。
- **UI 反応系ブリッジ**: `src/ui/testplaySpeed.ts` の `createTestplaySpeedController(clock)` が `ScaledClock` の上に `reactive.ts` の `Signal` を 1 個だけ被せ、＋設定画面(書き込み)とヘッダのインジケータ(読み取り専用)の両方が同じ値を見られるようにする。書き込み口は `setSpeed` 1 本(`Signal` 自体は外へ出さない・reactive.ts の規約どおり)。
- **設定画面**: ＋設定「テストプレイ支援」節(`TestplaySpeedSection`・hooks 不使用の部品)に ×1/×60/×720 の3択ボタン。現在値は本文(「現在の速度: ×N」)と `aria-pressed` の両方で明示する(色だけに頼らない・全画面共通規約§0-6)。
- **ヘッダインジケータ**: ×1 のときは何も描かない(平常時にヘッダを汚さない)。×1 以外のときだけ `TestplaySpeedIndicator`(`AppShell.tsx`)が「⏩×N」を常時表示し、戻し忘れに気づけるようにする。
- **`ScreenProps`/`AppShellProps` への追加**: `testplaySpeed: TestplaySpeedController` を `bootTick` と同じ扱い(composition root が 1 個だけ作り、セーブに載らない UI 状態として全画面 props に配る)で追加した。
- **engine/schema/content/conformance は無改変**。engine は tick 番号しか見ないため、速度変更は決定論に影響しない(ゲーム内 tick の刻み方自体は変わらず、実時間との対応だけが変わる)。
