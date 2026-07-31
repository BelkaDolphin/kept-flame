# アーキテクチャ地図 — engine / platform / ui の依存方向とストア形状 (M8)

作成日: 2026-07-29 / 対象: `src/ui/**`(単一ストア)+ 既存レイヤとの接続
根拠文書: ADR-001(依存最小)・**ADR-002(状態管理)**・ADR-012(セーブ)・ADR-016(algoVersion)・ADR-019/**ADR-029**(Worker catch-up)・ADR-023/024(content 正準化・レジストリ)・ADR-026(tick)・**ADR-027(12画面ルーティング)**・**ADR-028(構造共有)**・ADR 「リポジトリ構成」/ GDD 6.6

**この文書の目的**: Phase 7(M29〜M33)の画面量産セッションが、M8 のコード(`src/ui/*.ts` 約 1,960 行)を読み直さずに画面を書けるようにすること。**画面から見て必要な情報だけ**を集めてあり、実装の詳細は各ファイル冒頭のコメントが正本である。

---

## 0. 位置づけと限界(先に書く)

M8 が作ったのは**ストア基盤だけ**である。以下は M8 の成果物に**含まれない**:

| 含まれないもの | 担当タスク | 現状 |
|---|---|---|
| Preact コンポーネント・12画面の実体 | M18/M19/M29〜M33 | `src/ui/screens/` は未作成 |
| 自前ハッシュルータ(`src/platform/router.ts`) | M29 | 未作成。ストアは「現在画面の写し」だけ持つ |
| ~~engine コマンド(`src/engine/commands.ts` の `apply(Command)`)~~ | ~~未割当~~ **M49** | **[2026-07-29] 実装済み**。§4 の `commandApplied` が唯一の口(`stateApplied` は撤去) |
| セーブ層・Worker の実配線(`saveScheduler` → `persistence`、`workerClient` → ストア) | M29/M33 | platform 側の部品は M3/M4/T11 で実装済み、繋いでいない |
| CSS / 意匠 / 4重符号化の実装 | M19 | 派生値は「数値とタグ」までを出す(`CellViewModel`) |

また、**ダークモード/ダークテーマは禁止**(CLAUDE.md 絶対ルール)。`prefers-color-scheme: dark` の分岐を書かないこと。ストア層に色は無いので、これは画面実装への申し送りである。

---

## 1. レイヤと依存方向(1枚地図)

```
        content/*.json          schema/                  (人間 or 運営LLM が触る)
              │  正準化+検証 ADR-023/024   │
              └──────────────►│
                                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  src/engine/    純TS・決定論バンドル・依存ゼロ            │  ← 外を一切 import しない(lint 強制)
   │    fp / rng / scheduler / stochastic / rules / adjacency │
   │    advance / canonicalize / state{state,update,serialize}│
   └──────────────────────────────────────────────────────────┘
            ▲                              ▲
            │ import(値も型も可)          │ import(値も型も可)
   ┌────────┴─────────────┐      ┌─────────┴──────────────────┐
   │ src/platform/         │◄─────┤ src/ui/                    │
   │  副作用(IDB/LS/Worker │ 純関数・型のみ                    │
   │  /時刻/DOM境界)       │      │  reactive / sources /      │
   │  persistence saveSched│      │  derived / store / screens │
   │  catchUp worker(Client)│     │  (Phase 7: screens/, grid/)│
   │  migration exchange … │      └────────────────────────────┘
   └───────────────────────┘                 ▲
                                              │ 購読(signal/computed)
                                        Preact コンポーネント
```

**規則(3 本だけ)**

1. **engine は誰も import しない**(`src/engine` 配下の相対パスのみ)。DOM・時刻・乱数・Promise・生スプレッド等の禁止 8 種は `eslint.config.js` の `ENGINE_FILES` が機械強制する。
2. **ui → platform は「純関数と型」だけ**。現在の実体は `src/platform/catchUp.ts` の `chooseCatchUpRoute` / `LIVE_ADVANCE_MAX_TICK_DELTA` / `restoreAdvanceContext` / 型 `TransferableAdvanceContext` のみ。**IDB・Worker・タイマ・`location` に ui から触らない**(繋ぐのはアプリシェル = M29 の仕事で、ストアへは §4 のイベントとして入ってくる)。
3. **platform → ui は無い**。platform がストアを知ることはない(逆向きの依存を作らない)。

---

## 2. モジュール地図(M8 が追加した 5 ファイル)

| パス | 責務 | 行数 | 根拠 |
|---|---|---|---|
| `src/ui/reactive.ts` | signal / computed / effect / batch / スコープ。**自前実装**(§9-1) | 569 | ADR-001, ADR-002, ADR-027(2) |
| `src/ui/screens.ts` | 画面 ID の語彙(①〜⑫ + 設定)。**import を持たない葉モジュール** | 87 | GDD 6.6, ADR-027 |
| `src/ui/sources.ts` | 根 signal 群 + `syncSourcesFromState`(state → 48 セルの同期) | 267 | ADR-002(2), ADR-028(1) |
| `src/ui/derived.ts` | 派生値の**全定義**(セル局所 / 全体集計 / 値) | 526 | ADR-002(2), ADR-027(4), ADR-029(2) |
| `src/ui/store.ts` | 単一ストア: イベント語彙・`dispatch`・画面マウント・診断 | 508 | ADR-002, ADR-026, ADR-027 |

テスト: `tests/ui/{reactive,store,derived,screens}.test.ts` + `fixtures.ts`(**73 件**・M49 で +4)。**fan-in 上界の検収は `tests/ui/derived.test.ts` の先頭 describe** が本体。

[M49] engine 側に 1 ファイル増えた:

| パス | 責務 | 根拠 |
|---|---|---|
| `src/engine/commands.ts` | プレイヤー操作の語彙と `apply(state, content, command)`(**判定の唯一の置き場**)+ 分岐木ノード上界の正本 | ADR-002(1), ADR-012(1)(3), GDD 6.6/6.7/7.7/8.1 |

既存レイヤで画面実装が触るもの:

| パス | 何のために |
|---|---|
| `src/engine/commands.ts` | コマンドの型(`Command` 各種)と拒否コード(`CommandRejectionCode`)。**`apply` を画面から直接呼ばない**(呼ぶのは `store.dispatch`) |
| `src/engine/adjacency.ts` | `GRID_WIDTH/HEIGHT/GRID_CELL_COUNT`, `cellIdOf`, `Tag`(7種) |
| `src/engine/fp.ts` | `toApproxNumber`(表示用の近似値化)。**表示以外で number に落とさない** |
| `src/engine/rules/types.ts` | `EngineContent`, `FacilityDef`(施設名・タグ・Lv 曲線) |
| `src/platform/exchange.ts` / `saveCapacity.ts` / `backupReminder.ts` | ⑩⑪ + セーブ/設定画面(M33) |
| `docs/design/tags-spec.md` | タグ7種の色/記号(4重符号化・M19) |

---

## 3. ストア形状

### 3.1 根 signal(`sources.ts` / 書き込むのは `store.dispatch` だけ)

| 名前 | 型 | いつ変わるか |
|---|---|---|
| `state` | `GameState` | 世界ロード / tick / catch-up / コマンド適用 |
| `content` | `EngineContent` | 世界ロードのみ(実行中は不変) |
| `advanceContext` | `AdvanceContext` | **配置が変わったときだけ**(§5-b) |
| `worldSeedU32` | `number` | 世界ロードのみ |
| `cellPlacement[0..47]` | `CellPlacement \| null` | そのセルの施設が**入れ替わったとき**(Lv・就労者では変わらない) |
| `cellFacility[0..47]` | `FacilityState \| null` | そのセルの施設 entity の参照が変わったとき(Lv・就労者を含む) |
| `selectedCellIndex` | `number \| null` | ②のタップ(UI 状態。セーブに載らない) |
| `activeScreen` | `ScreenId` | ルータからの写し(UI 状態) |

> **画面から根 signal を直接読まないこと。** 特に `state` を読むと「毎 tick その画面が丸ごと再描画される」。読んでよいのは §3.2 の派生値であり、コマンド組み立て等の一時的な読み出しは `store.peekState()`(非追跡)を使う。

### 3.2 派生値(`derived.ts` / 画面が購読してよい唯一の面)

| 名前 | 依存(fan-in) | 主な読み手 |
|---|---|---|
| `cellView[i]` | `cellAdjacency[i]` + 自セルの `cellFacility`/`cellPlacement` = **3** | ②格子ビューの 1 セル、③施設詳細 |
| `cellAdjacency[i]` | 自セル + 8 近傍の `cellPlacement` + `adjacencyMatrix` = **≤10** | 上記の内部(直接購読も可) |
| `adjacencyMatrix` | `content` + `worldSeedU32` | 内部(シード揺らぎ焼き込み・GDD 6.4-2) |
| `gridSummary` | 48 セル全部 | ②の凡例/警告総数、⑫帰還ダイジェスト。**セル表示から購読禁止**(§3.4) |
| `tick` | `state` | 時計表示 |
| `resources` / `research` / `residents` / `codify` | `state` | ④⑤⑥ 等の一覧 |
| `homeBadges` | `state`(件数のみ・tick を含まない) | ①ホームハブの緊急度バッジ(ADR-027(4)) |
| `selectedCell` | `selectedCellIndex` + `cellView[選択]` | ②の選択枠、③施設詳細 |

`cellView[i]` の中身(`CellViewModel`)は「4重符号化の材料」である: `tags`(記号/色/パターンの引き当て元)・`multiplierApprox`(数値)・`overcrowded`/`overcrowdedNeighborCount`(常時過密警告バッジ)・`level`/`workerCount`。**意匠は M19、ここは値だけ**。

### 3.3 fan-in 上界がなぜ成り立つか(ADR-002(2) の核心)

- 根を**セル単位に割ってある**ので、1 セルの編集で dirty になるのは「そのセルの配置 signal を実際に読んだ computed」= 自セル + 8 近傍の**占有セル**だけ。空きセルの `cellAdjacency` は早期 return で近傍を 1 つも読まないため、近傍が変わっても再計算されない。
- 隣接に効く素性(`CellPlacement` = 施設 ID / 定義 ID / タグ列)と、効かない素性(Lv・就労者 = `cellFacility`)を**別の signal に分けてある**ので、増築や配置換えが近傍の再計算を誘発しない。
- computed は**遅延**(読まれるまで計算しない)。よってアンマウント中の画面の派生値は「dirty の印が付くだけ」で評価されない(ADR-027(2))。
- 値が変わらなかった再計算は下流へ伝播しない(3 色伝播 + `equals`)。例: 同じタグの施設へ差し替えると、近傍の `cellAdjacency` は作り直されるが値が同じなので近傍の `cellView` は再計算されない。

検収テスト(`tests/ui/derived.test.ts`): 1 基設置で再計算されるのは `[14, 15, 21]` の 3 セルのみ・**9 個を超えない**・遠方 44 セルは 0 回・tick 進行では 0 回・Lv 変更では 0 回。

### 3.4 全体集計をセル表示の依存に置かない

`gridSummary` は 48 セル全部に依存する(=どのセルが変わっても作り直される)。これを 1 セルのコンポーネントが購読すると、**セル 1 個の再描画が盤面全体の変更に反応する**ようになり、ADR-002(2) の上界が実質無効になる。用途は②の総数表示と⑫帰還ダイジェストに限ること。

---

## 4. イベント語彙(`store.dispatch` の全て)

| イベント | 誰が出すか | 効果 | 拒否条件(例外) |
|---|---|---|---|
| `worldLoaded{state, content, source, advanceContext?}` | 起動・セーブ復元・インポート(M29/M33) | content + state 総入れ替え、選択解除、コンテキスト再構築 | content/state の不整合(施設定義欠落・1セル2施設) |
| `ticked{toTick}` | フォアグラウンド tick 駆動(M29 + `platform/clock.ts`) | `advance(state, ctx, toTick)` を適用 | 過去 tick / **600 tick 超**(= Worker 経路へ回せ) |
| `catchUpApplied{snapshot, advanceContext}` | `platform/workerClient.ts` の完了(M29) | スナップショットを据える。**メインで engine 再計算なし** | 現在より過去のスナップショット |
| `commandApplied{command}` | 画面のプレイヤー操作(M18/M29〜M33) | engine の `apply(state, content, command)` の結果を据える | **例外を投げない**。拒否は `DispatchResult.command.rejection`(下記) |
| `cellSelected{cellIndex}` | ②のタップ(M18/M30) | 選択セル更新 | 0〜47 の範囲外 |
| `screenOpened{screen}` | ルータ(M29) | 現在画面の写し更新 | 語彙外の画面 ID |

`dispatch` は `DispatchResult`(`stateChanged` / `changedPlacementCells` / `advanceContextRebuilt` / `advanceContextRestored` / **`command`**)を返す。前 4 つは UI の描画に使わず**診断・計測・テスト用**だが、**`command` だけは画面が読んでよい** — コマンドが拒否されたことを利用者へ伝える手段が他に無いためである(黙って何も起きない、を作らない)。

**dispatch は 1 回 = 再描画 1 回**(内部で `batch`)。途中経過は effect に見えない。

### 4-1. コマンド(M49)

- 語彙と判定は **`src/engine/commands.ts` が全部持つ**。ストアにも画面にも「置けるか/払えるか」の判定を書かない(§6 の 7 箇条目)。
- `command` には 1 個または**配列**(原子適用 = 1 つでも拒否したら全部捨てる)を渡せる。「解体してから同じセルへ建て直す」のように途中の state を見せたくない操作に使う。
- 実装済み: `placeFacility` / `demolishFacility` / `upgradeFacility` / `assignResident` / `unassignResident` / `beginCodification` / `convertWasteToResearch`。
- **語彙だけ予約**(呼ぶと `notImplemented` + 担当タスク名で拒否): `dispatchExpedition`(M21)/ `reclaimCell`(M18)/ `beginResearch`(担当未割当)。**[2026-08-01追記]** 3つとも実装済みになり予約は0件(dispatchExpedition=M21・reclaimCell=M52・beginResearch=M50)。
- 拒否は `{ ok:false, rejection:{ code, commandKind, commandIndex, subjectId, cellIndex, limit, actual, resourceId, requiredRaw, availableRaw, ownerTask, message } }`。**分岐は `code` で行い、`message` は表示のみ**に使うこと。
- セーブへの結線は `saveScheduler.recordCommandOutcome(result)`(拒否は 1 件も数えない・§8)。

---

## 5. データの流れ

### (a) 起動 / オフライン復帰(perf-boundaries.md の B2 → B1 → B3 → B4)

```
IDB/localStorage ──B2──► decodeSaveRecord ──► GameState
                                  │
                    (tick差 > 600) ├──B1──► Worker: runCatchUp() ─► snapshot + TransferableAdvanceContext
                                  │                                   │
                                  ▼                                   ▼
                        createGameStore({state, content})   dispatch({type:"catchUpApplied", …})
                                  │
                                  └──B3──► 根 signal 同期 + 派生値(= このストア)
                                                    │
                                                    └──B4──► Preact マウント(約240 DOM)
```

**B3 に engine の再計算を入れないこと**(perf-boundaries §3 B3)。そのために catch-up の完了メッセージに含まれる `multiplierByFacilityId` を `restoreAdvanceContext` で**据えるだけ**にしてある。`createGameStore` に `advanceContext` を渡す経路も同じ目的(`store.stats().advanceContextBuildCount` が 0 のままなら engine 再計算は起きていない)。

### (b) フォアグラウンドの tick(ADR-026)

`rAF`(または 1 秒間隔)→ `platform/clock.ts` が単調経過時刻 → `computeTargetTick()` → `dispatch({type:"ticked", toTick})`。**タイマの発火回数は結果に影響しない**。tick では配置が変わらないので `advanceContext` も 48 セルの隣接 computed も作り直されない(テストで固定済み)。

### (c) 画面操作(コマンド)

```
画面(タップ) ──► store.dispatch({type:"commandApplied", command})
                        │
                        ├─ engine: apply(state, content, command)  ← 判定はここだけ
                        │        ok  → 根 signal 同期(配置が変われば AdvanceContext 再構築)
                        │        !ok → 何も動かさず rejection を返す
                        ▼
              DispatchResult.command ──► 画面(拒否メッセージ) / saveScheduler.recordCommandOutcome
```

**コマンドは tick を進めない**。レートが変わっても新しい境界イベントを積む必要は無い —
`scheduler.buildEventQueue` が advance のたびに state から heap を作り直すため(commands.ts §2)。

---

## 6. 画面の書き方(Phase 7 の規約・6 箇条)

```ts
// 画面コンポーネントの骨格(Preact)
const mount = store.mountScreen("grid");          // 1. マウント時にスコープを作る
mount.scope.effect(() => {                        // 2. 購読は必ずスコープ経由
  render(cellView(store.derived.cellView[i].value)); //    読むのは derived だけ
});
// …アンマウント時:
mount.dispose();                                  // 3. 購読を全部切る(ADR-027(2))
```

1. **`store.mountScreen(screenId)` でマウントし、アンマウントで `dispose()`**。`scope.effect` / `scope.computed` に載せたものは全部まとめて切れる。
2. **購読してよいのは `store.derived.*` だけ**。`store.sources.*` を画面で読まない(レビュー観点: `src/ui/screens/**` に `\.sources\.` が出たら赤)。
3. **セルは `cellView[i]` を 1 個だけ購読**する。`gridSummary` をセルに繋がない(§3.4)。
4. **新しい派生値は `derived.ts` に足す**。画面ファイルの中で `computed(() => store.sources.state.value…)` と書き始めた瞬間、fan-in 設計がコードから読めなくなる。
5. **書き込みは `store.dispatch` のみ**。signal の `set` を画面から呼ばない(型的にも `ReadonlySignal` しか渡らない)。
6. **表示用の数値化は `toApproxNumber` を通す**。固定小数点(`Fix`)のまま四則演算を UI 側で書かない(決定論の外に計算を作らない)。
7. **[M49] 「できるか」の判定を画面に書かない**。設置可否・資源の足り具合・上限は engine の `apply` が返す拒否(`DispatchResult.command`)で知る。ボタンの活性/非活性のために先読みしたくなったら、判定を写経せず `src/engine/commands.ts` に述語を export して両方から呼ぶこと。

---

## 7. 拡張手順

### 7-1. 派生値を足す

1. `derived.ts` の該当節(セル局所 / 全体集計 / 値)に interface と computed を足す。
2. **依存が何本になるか**をコメントに書く。48 セル全部に依存するものは「全体集計」節へ置き、セル表示から購読しない旨を書く。
3. オブジェクトを返す派生値には `equals` を付ける(無変更時の再描画を止める)。
4. `StoreDerived` に足し、`createStoreDerived` の戻り値へ入れる。

### 7-2. ~~engine コマンドが実装されたときの置き換え~~ → **[2026-07-29 / M49] 完了**

手順どおりに実施済み: `CommandAppliedEvent` 追加 → `applyEvent` に分岐追加 → `StateAppliedEvent` /
`applyStateApplied` を削除 → テストを `commandApplied` へ置換。commandLog(ADR-002)を持つなら
`applyCommand` が唯一の追記点である。配置が変わるコマンドでは `DispatchResult.changedPlacementCells`
が非空になり `advanceContext` が自動で作り直される(手で呼ばない)。

**新しいコマンドを足す手順**(以後はこちら):

1. `src/engine/commands.ts` §1 に interface を足し、`Command` union と `IMPLEMENTED_COMMAND_KINDS`(UTF-16 昇順)へ登録する。予約だけなら `RESERVED_COMMAND_OWNER_TASK` に担当タスクを書く。
2. `applyOne` の switch に分岐を足す(`never` の網羅検査があるので足し忘れは型エラーになる)。
3. 失敗の場合分けは**必ず `rejected(...)` で値として返す**。rules 側の `RulesError` を呼び出し側へ漏らさないよう、在庫・重複・上限は呼ぶ前に検査する。
4. 新しい失敗理由が要るなら `COMMAND_REJECTION_CODES` に足す(UI の分岐はこの `code` を見る)。
5. `tests/engine/commands.test.ts` に「成功 1 本 + 拒否の全 code」を足す。**ストアや画面には何も足さない**。

### 7-3. 画面を足す

`screens.ts` の `SCREEN_IDS` と `SCREEN_META` に 1 行ずつ足す。GDD 6.6 の 12 画面を超えて増やす場合は GDD 側の改訂が先(ユーザー承認要)。

---

## 8. 未実装の接続点(アプリシェル = M29 で繋ぐもの)

**[2026-07-31 / M29] 下表のうち時計・ルータ・Worker catch-up・セーブは結線済み。** 結線の実体は composition root `src/main.tsx` にあり、テスト可能な部分は `src/platform/{router,clock}.ts` と `src/ui/shellSession.ts` へ切り出してある(画面側の対応表は `docs/design/ui-spec.md`)。

| 繋ぐもの | 材料(実装済み) | 繋ぎ方 | 状態 |
|---|---|---|---|
| セーブ | `platform/saveScheduler.ts`(4 トリガ)+ `persistence.ts` | `const r = store.dispatch({type:"commandApplied", …})` の後に **`scheduler.recordCommandOutcome(r.command)`** を呼ぶ(拒否は数えない・列は要素数ぶん数える)。ストアはセーブを知らない | **[M29] 最小結線済み**(起動時ロード + tick/catch-up 後の `recordCommands` + ライフサイクルフラッシュ)。破損時の救済・エクスポート導線は M33 |
| Worker catch-up | `platform/workerClient.ts` の `startCatchUpWorker` | 完了ハンドラで `dispatch({type:"catchUpApplied", …})` | **[M29] 結線済み**(Worker が無い環境は 600 tick ずつメインで刻む縮退つき) |
| 時計 | `platform/clock.ts`(ADR-026/GDD 11.9) | 単調時刻 → `planTick`(= `computeTargetTick`)→ `dispatch({type:"ticked"})` | **[M29] 実装済み**。`TickDriver.pump()` は**呼ばれた回数を計算に使わない** |
| ルータ | `platform/router.ts`(ADR-027) | `hashchange` → 語彙検証 → `dispatch({type:"screenOpened"})`。マウント/アンマウントは `ScreenHost` が現在画面 1 個だけを描くことで自動的に起きる | **[M29] 実装済み**。語彙(`SCREEN_IDS`)は引数で注入(platform → ui の import を作らない) |
| バックアップ導線 | `platform/backupReminder.ts` / `localStorageMirror.ts` | ⑩⑪ + 設定画面(M33) | 未着手 |

**[M29] 画面の活性宣言の規約が変わった**: 画面コンポーネントは `useScreenMount(store, id, { activate: false })` を使い、自分を現在地だと宣言しない。`screenOpened` を出すのは `src/ui/shellSession.ts` の 1 箇所だけである(M8 の §6 骨格例にある `store.mountScreen("grid")` は既定 `activate: true` なので、M30 以降はこの形で書かないこと)。

---

## 9. 要ユーザー判断 / 申し送り

1. ~~**`@preact/signals` を入れるか**~~ **[2026-07-29裁定] 自前実装を維持**(新規依存ゼロの原則優先)。不具合が出た場合のみ差し替えを再検討。API を `.value` / `.peek()` に寄せてあるので差し替えは `reactive.ts` 1 ファイルで済む。
2. **`src/ui/**` の lint 追加**。ADR リポ構成は `src/ui/` に「生 signal 直読み禁止(lint)」と注記している。M8 では **型(`ReadonlySignal` しか渡さない)+ §6 の規律**で代替し、`eslint.config.js` は触っていない(並行タスクとの競合回避)。画面が実在する M29 以降にルール化するかを要判断。
3. ~~**`stateApplied` は暫定**(§7-2 で撤去)。engine コマンドの設計は未着手であり、ロードマップ上どのタスクが `src/engine/commands.ts` を作るかが明示されていない(M8 の発見事項)。~~ **[2026-07-29裁定] ロードマップに M49(engine コマンド層)を新設**。`stateApplied` の撤去は M49 の検収条件。**[2026-07-29] M49 完了・撤去済み**。
5. **[M49] 建設/増築コストが content スキーマに無い**(GDD 12.1 の `facility(id, tags[], slots, lvCurve, overflowCapPolicy)`)。よって `placeFacility` / `upgradeFacility` は資源を 1 つも払わず、GDD 6.7 の廃材 3 出口(1)「施設増築コストの一部代替(最大20%)」は**呼び出し元が存在しない**。コスト項を facility スキーマへ足すか、balance 側に置くかは**要ユーザー判断**。
6. ~~**[M49] 研究対象の選択コマンド(`beginResearch`)の担当タスクがロードマップに無い**。engine の研究は「未完了 research entity の ID 昇順で先頭 1 本」という縮約(`rules/research.ts` §2)のままで、プレイヤーが選ぶ余地が無い。縮約の解消は golden vector が動く変更(= `algoVersion` bump)なので、担当と時期の裁定が要る。~~ **[2026-08-01 M50 で解消]** `beginResearch` 実装済み。「選択が有効ならそれ/無ければ従来の ID 昇順先頭」の2段構えにしたため既存 golden 73本は不変(bump 不発生)、新規ベクタ sc40 系で選択挙動を固定。
4. **B3 の実測値は M35 で取り直す**。perf-boundaries.md §5 末尾が「実 UI ストアが入ったら #1 を取り直す」と明記しており、`hydrateFidelity: "placeholder"` の差し替えは M35 の担当。M8 の時点で B3 の中身(state → 根 signal 同期 + 派生値)は実物になった。
