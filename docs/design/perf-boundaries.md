# オフライン復帰2秒予算 — 4サブ予算の計測境界設計 (T10)

対象: `bench/perf.html` / 計測項目 **#1**(先行計測計画 §5.2)
後続: **#2**(GC/メモリ・T12)、**#8**(Worker 越し転送・T11)の土台
根拠文書: ADR-012(4)(2s 予算の ms 配分)・ADR-019/ADR-029(Worker catch-up・可変ドラフト)・ADR-026(tick は経過時刻の純関数)・ADR-027(非アクティブ画面アンマウント)・先行計測計画 §2.1 P2 / §5.1 / §5.2 #1

この文書は**境界の定義**が本体である。「どこで `performance.now()` を取るか」「どの処理がどの区間に属するか」「後続タスクで何が差し替わるか」を先に確定し、実装(`bench/perfMain.ts` ほか)はこの定義に従うだけにする。実装を先に書いて後から辻褄を合わせると、T11/T12 で境界が静かにずれて #1 の数値が比較不能になるため。

---

## 0. 位置づけと限界(先に書く)

- 計測 #1 は先行計測計画 §1 の仕分けで **区分②(デスクトップ予備 + 実機本計測)**である。本ページをデスクトップ(Windows / Ryzen 7 5700X 等)で走らせて得られる数値は、**ターゲット実機(iPhone SE2 / Android 中位機 / 8GB Surface)の下限見積りにしかならない**。
- したがって本ページのデスクトップ実行結果をもって **#1 を「合格」と宣言してはならない**(計画 §5.1 の明文規定)。合否は `K_device = t_device / t_desktop` を `bench/kernel.html` 相当の校正カーネルで実測してから「デスクトップ実測 × K ≤ ADR 基準」で判定する。K の暫定値 **5 には根拠が無い**(計画 §5.1 が明記)。
- 本ページはデスクトップでも「**どの区間が支配的か**」「**save サイズ・DOM 数に対してどう伸びるか**」という**形**を先に取るためのものであり、絶対値の合否判定器ではない。

---

## 1. 4サブ予算(ADR-012(4))

| ID | 区間名 | ADR の呼称 | 予算 |
|---|---|---|---|
| **B1** | `compute` | compute(tick catch-up) | ≤1100ms |
| **B2** | `restore` | IDB 読出 + JSON.parse + deserialize | ≤450ms |
| **B3** | `hydrate` | Preact ハイドレーション | ≤250ms |
| **B4** | `mount` | 約240 DOM 初回マウント | ≤200ms |
| — | `total` | 合計 | ≤2000ms |

ADR の列挙順は**予算表の順**であって実行順ではない。実際の復帰経路の実行順は **B2 → B1 → B3 → B4**(セーブを読む → 不在ぶんを進める → UI 状態を作る → DOM を出す)であり、本ページはこの順で計測する。順序は区間の排他性(§2 R2)に影響しない。

---

## 2. 共通規約

### R1 単一タイムライン
4 区間はすべて**同一ドキュメントのメインスレッド**の `performance.now()` 上で取る。`Date.now()` は使わない(単調でない)。T11 で B1 が Worker へ移る際の例外は §7 に規定する。

### R2 逐次・排他(オーバーラップ禁止)
1 試行の中で 4 区間は上記の固定順に**逐次**実行し、区間は互いに素な半開区間 `[start, end)` とする。ある区間の `end` を採ってから次の区間の `start` を採る。並行実行・入れ子・再入は禁止。

### R3 1 演算 1 所有者
復帰経路上のすべての演算は「ちょうど 1 つの区間に属する」か「**予算外**として §4 に名前付きで明示列挙される」かのいずれかでなければならない。どちらでもない演算を実装に置いてはならない。境界が曖昧な演算(§4 の各項)は、この文書を先に改訂してから実装を変える。

### R4 隠れ非同期の禁止
区間の内側で `await` してよいのは、**その区間が計測対象としている I/O そのもの**だけである(B2 の IDB `get` のみが該当)。それ以外の `await`(マイクロタスク待ち・`setTimeout(0)`・`requestAnimationFrame`)を区間内に置いてはならない。イベントループへ制御を返すと無関係な作業が挟まりうるため。

### R5 計測器自身を区間に入れない
タイムスタンプは素の `performance.now()` で先に変数へ取る。`performance.mark()` / `performance.measure()`(T12 の CDP トレース切り出し用)は、**取得済みのタイムスタンプを `{ startTime }` 指定で後から**発行する。mark 呼び出しのコストが計測窓の内側に入らないようにするため。User Timing L3 の `startTime` 指定に未対応のエンジンでは mark をまるごと諦める(try/catch で握り潰す。計測値そのものには影響しない)。

### R6 段取りは外
content ロード・代表盤面の構築・セーブの**書込**・IndexedDB の `open`・前試行の DOM アンマウント・試行間のイベントループ譲渡は、すべて 4 区間の**外**で行う(§4 に補助メトリクスとして記録)。

### R7 下位区間は親を厳密分割
各区間の内訳(例 B2 の `idbGet` / `parse` / `deserialize`)は、親区間を**過不足なく分割**する。下位区間の合計が親を超えたり、親の外へはみ出したりしてはならない。下位区間は情報であって予算ではない。

### R8 新しいコストは文書を先に直す
T11/T12 以降で新しいコスト(Worker 転送・integrityChecksum 検証・実ストアの水和など)が現れたら、**まず本文書の §3/§4 に所属を書いてから**実装する。ベンチ側の都合で黙って区間に足し引きしない。

### タイマ分解能(重要な落とし穴・実測で確認済み)
`performance.now()` の分解能はエンジンとクロスオリジン隔離状態に依存する。cross-origin isolated でない場合、Firefox と WebKit は 1ms 前後へ丸める。

**Chromium も丸める。** T10 の実測(HeadlessChrome 151・`crossOriginIsolated: false`)では**全区間の値が 0.1ms(100µs)刻み**になり、B3 `hydrate` の中央値は **0ms**(= 分解能の下)になった。つまり `crossOriginIsolated: false` の環境では **B3/B4 のような 1ms 未満の区間は事実上測れない**。

したがって:

- **#1 の計測は Chromium 系で行う**ことを既定とする(Firefox/WebKit の 1ms 丸めよりは 10 倍細かいため)。
- 1ms 未満に落ちた区間は「予算に対して 3 桁以上小さい」以上のことを言っていない。**pass の根拠として使ってよいが、実機で伸びる余地の見積りには使えない。**
- T12 が COOP/COEP(cross-origin isolation)を `bench/vite.perf.config.ts` の `preview.headers` に入れると、副作用として高分解能タイマ(5µs)が有効になる。**T12 以降は B3/B4 の実数値が初めて取れる**。
- 結果 JSON の `meta.crossOriginIsolated` に状態を必ず載せる(後から読む人が丸めの有無を判断できるように)。

### 試行回数と中央値
- 計測 **10 試行**の**中央値**を代表値とする(計画 §5.2 #1)。中央値の定義は「昇順ソート後、奇数個なら中央、偶数個なら中央 2 値の平均」。生値も全部出す。
- 10 試行の**前に 1 回のウォームアップ試行**を走らせ、その値は中央値に入れず `warmupMs` として別に出す。理由: 実機の実復帰は **JIT が温まっていない状態**で起きるので、ウォームアップ値の方が cold start に近い。中央値(温まり済み)は下限、ウォームアップ値は上限寄りの参考値として**両方**報告する。
- 試行間には `await`(`setTimeout(0)`)を挟んでイベントループへ返す。GC・描画をここで起こさせ、区間内へ落とし込まないため(R6)。

---

## 3. 区間定義

### B1 `compute` — tick catch-up(≤1100ms)

| | |
|---|---|
| **開始点** | `createAdvanceContext(state, content)` の呼び出し**直前** |
| **終了点** | `advanceWithReport(state, ctx, targetTick)` が返り、その `state` をローカルへ束縛した**直後** |
| **下位区間** | `contextBuildMs`(隣接行列のシード揺らぎ焼込 + 施設別産出乗数の precompute) / `advanceMs`(離散事象ループ本体) |

**ワークロード**: `startTick = 0` → `targetTick = 4320`(= 72h・ADR-026 の 72h クランプ値そのもの)。`content/balance.json` の `coarseTickMinutes = 10` により (C) 粗粒度ステップは **432 回**、ベルヌーイ判定は 20 住民 × 3 tech × 432 = **25,920 回**。この 3 つの数は `ScheduleReport` のカウンタで**実測して結果 JSON に載せる**(ワークロードが設計どおりであることを毎回自己検証する)。

**`createAdvanceContext` を内側に入れる理由**: 隣接乗数は施設配置に依存するのでセーブごとに作り直す必要があり、catch-up の前に必ず 1 回走る。復帰経路の一部なので B1 に属する(R3)。

**含まないもの**: content のロード(§4)・セーブの読出(B2)・Worker への転送(§7)・スナップショットの構造化複製(§7)。

**メインスレッド版でよい根拠**: ADR-026(3) は「差分が小さい通常操作はメインスレッド同期 advance、長期不在復帰は Worker へ委譲」と定めており、**engine 側は同じ純関数**である(`src/engine/advance.ts` §1 のコメント)。したがって T10 のメインスレッド計測は「engine の計算量そのもの」を測っており、T11 で Worker へ移した際に増えるのは**転送コストとスレッド起動コストだけ**である。§7 でその差分の所属を先に決めてある。

---

### B2 `restore` — IDB 読出 + JSON.parse + deserialize(≤450ms)

| | |
|---|---|
| **開始点** | セーブ読出の入口関数(T10: `getSaveText` / T11: `persistence.loadLatestSave`)を**呼ぶ直前**。読出トランザクションの生成と `objectStore.get(key)` はどちらもこの内側 |
| **終了点** | `fromSerializable(parsed)` が `GameState` を返した**直後** |
| **下位区間** | `idbGetMs`(リクエスト発行 → `onsuccess` で値を得るまで) / `parseMs`(`JSON.parse`) / `deserializeMs`(`fromSerializable`) |

**セーブは JSON 文字列として保存する**(構造化複製可能なオブジェクトとして入れない)。ADR-012(4) が予算項目に `JSON.parse` を明記しており、ADR-012(2) の `integrityChecksum` も JSON blob に対して掛ける設計であるため。この選択は T11 の `persistence.ts` がそのまま引き継ぐ。

**書込は計測外**(R6)。#1 は「オフライン復帰」シナリオであり、予算の対象は**読出側**だけである。書込コスト(2秒デバウンス・15秒/25コマンド絶対フラッシュ・ADR-012(1))は別問題で、復帰時のクリティカルパスに乗らない。ベンチでは `idbPutMs` を補助メトリクスとして 1 回だけ記録する。

**`indexedDB.open()` は区間外**(補助メトリクス `idbOpenMs`)。ADR-012(4) の予算項目が「読出 + parse + deserialize」の 3 演算を名指ししているのに合わせる。ただし**実際の cold restore では open も必ず払う**ので、結果 JSON では `restoreWithOpenMs = idbOpenMs + restoreMs` を派生値として併記し、T11 が「open を予算内へ入れるか」を数値を見て決められるようにする(§11-(1))。

**save サイズ依存性**: B2 のコストは save のバイト数にほぼ比例する。縮約代表盤面(entity 37 個)の save は数 KB に過ぎず、ADR-012(2) の**容量目標 ≤512KB とは 2 桁違う**。デスクトップで 450ms を余裕で満たしても、それは「小さいセーブなら速い」以上のことを言っていない。よって本ページは **B2 だけを容量目標付近(既定 ≈512KB)の合成セーブでも計測**し、`sensitivity.restoreAtTargetSaveBytes` として報告する(予算判定には使わない参考値)。合成セーブは住民 entity を ID を変えて複製して膨らませたもので、engine の正規経路(`toSerializable` / `fromSerializable`)をそのまま通す。

---

### B3 `hydrate` — Preact ハイドレーション(≤250ms)

**この区間の解釈は本タスクの設計判断そのものなので §5 に独立して書く。** 定義だけ先に:

| | |
|---|---|
| **開始点** | B1 が返した `GameState` を入力に、UI 側の派生値(view model)の構築を**始める直前** |
| **終了点** | ルート vnode(`<PerfGrid …/>`)を組み終えた**直後**。`render()` は**呼ばない** |
| **下位区間** | `viewModelMs`(GameState + EngineContent + AdvanceContext → 48 セル分の表示用データ) / `vnodeMs`(ルート vnode の生成) |

**含まないもの**: DOM の生成(B4)・レイアウト(B4)・engine の再計算(B1 で終わっている)。

**Preact 固有の注意(境界の位置が言語仕様で決まる箇所)**: Preact ではコンポーネント関数の本体は `render()` 中の diff で初めて実行される。したがって `h(PerfGrid, { cells })`(= JSX `<PerfGrid cells={…}/>`)は**ルート vnode を 1 個作るだけ**であり、48 セル分の vnode 生成は**構造的に B4 側に入る**。これは実装の都合ではなく Preact の評価順そのものなので、B3 に vnode ツリー構築を含めることはできない。結果として B3 に入るのは「engine state → 派生値」だけであり、下位区間 `vnodeMs` はほぼ 0 になる。この非対称性は結果 JSON を読む側が知っている必要がある。

---

### B4 `mount` — 約240 DOM 初回マウント(≤200ms)

| | |
|---|---|
| **開始点** | `render(rootVnode, container)` の呼び出し**直前** |
| **終了点** | 生成済みサブツリーに対して**同期レイアウトを強制**(`container.getBoundingClientRect()` を読む)した**直後** |
| **下位区間** | `renderMs`(`render()` が返るまで = vdom diff + DOM 生成 + 挿入) / `layoutMs`(強制同期レイアウト) |

**レイアウトを区間に入れる理由**: `render()` の同期部分だけでは「DOM ノードが作られた」までしか測れず、利用者から見た「格子が出た」に届かない。Fallback が「DOM 仮想化で render 削減」(ADR 692行)である以上、削減対象はスタイル計算・レイアウトを含む描画コストであり、これを予算外に置くと数値が実態より小さく出る。**paint / composite は同期的に測れないので含まない**(この分だけ B4 は依然として過小評価である旨を明記する)。

**DOM 規模**: 6×8 = 48 セル × 5 要素 = **240 要素**。1 セルの内訳は 4重符号化(`docs/design/tags-spec.md`)に対応させ、コンテナ 1 + 記号 1 + タグ名 1 + 数値 1 + バッジ 1 の計 5 要素とする。実際にマウントされた要素数は `container.querySelectorAll("*").length` で**実測して結果 JSON に載せる**(240 からズレたらワークロードが壊れている)。

**試行間のアンマウント**は区間外(R6)。`render(null, container)` で毎試行きれいに落としてから次へ進む(ADR-027 の「非アクティブ画面は物理アンマウント」に対応)。

---

## 4. 予算外だが必ず記録する補助メトリクス

R3 により、復帰経路上で 4 区間に属さない演算はここに全部並べる。

| メトリクス | 何を測るか | なぜ予算外か | 将来の扱い |
|---|---|---|---|
| `contentLoadMs` | `validateContentBundle` → `loadEngineContentOrThrow` | ADR-012(4) の 4 項目に content ロードは無い。content はアプリ起動時に 1 回で、セーブ復帰ごとには走らない | T11 で Worker へ 1 回転送する対象になる(ADR-029(1))。転送側は §7 |
| `contentJsonParseMs` | **計測しない**(0 として明示) | Vite が `content/*.json` をビルド時に JS リテラルへ畳むため、ブラウザでは JSON.parse が発生しない。実アプリも同じバンドル方式(ADR-025 静的アセット)なので実態と一致 | 実配信で content を fetch する方式に変えたら測る |
| `boardBuildMs` | 代表盤面の構築 + `toSerializable` + `JSON.stringify` | 計測の**段取り**。実アプリに対応物が無い | 変更なし |
| `idbOpenMs` | `indexedDB.open()` の完了まで | ADR の予算項目が 3 演算を名指ししているため(§3 B2) | T11 で「予算内へ入れるか」を判断(§11-(1)) |
| `idbPutMs` | セーブの書込 1 回 | 復帰シナリオのクリティカルパス外(§3 B2) | ADR-012(1) の書込側予算として別途 |
| `unmountMs` | `render(null, container)` | 試行間の後始末 | 変更なし |
| `layoutFlushMs` | — | B4 の内側(`layoutMs`)に含めたので独立項目は持たない | — |
| `idbFirstTouchMs` **[T11]** | ページで**最初の IndexedDB 呼び出し**(ベンチでは前回 DB の `deleteDatabase`) | IndexedDB サブシステム自体の起動コスト。アプリ起動時に 1 回で、復帰のたびには払わない | §12-4。T16 の判定では「2秒予算の外で先に払われる固定費」として別枠で見る |
| `idbOpenWarmMs` **[T11]** | 既存 DB を開き直す `open` | 同上(`idbOpenMs` は cold = 新規作成込み) | §12-4 |
| `saveEncodeMs` **[T11]** | `toSerializable` + `JSON.stringify` + `integrityChecksum` | **書込側**。復帰経路に無い | ADR-012(1) の書込側予算として別途 |
| `workerBootMs` **[T11]** | `new Worker()` + モジュール評価 | §7-4(`workerLifecycle: "preboot"`) | onDemand 実装にしたら B1 算入 |
| `contentTransferMs` **[T11]** | content 1回転送の往復(ADR-029(1)) | §7-2。アプリ起動時であって復帰経路ではない | 変更なし |

**結果 JSON では `budgets` / `intervals` と `supplementary` を別オブジェクトに分ける。** 補助メトリクスが 4 予算の合計に混ざらないようにするため。

---

## 5. 設計判断: SSR が無い構成で「Preact ハイドレーション」をどう解釈するか

### 事実確認

- ADR-025/ADR-031: 配信は **Cloudflare Workers 静的アセット(SPA モード)**。サーバ側レンダリングは存在しない。
- ADR-027: ルーティングは `location.hash` + `popstate` の**自前極小ルータ**。プリレンダも無い。
- ADR-001: 依存最小(`preact` のみ。`preact-render-to-string` も `preact-iso` も無い)。実際 `package.json` の devDependencies に SSR/prerender 系は 1 つも無い。

したがって **Preact の `hydrate()` API を呼ぶ対象(サーバが吐いた既存 DOM)がそもそも存在しない**。ADR-012(4) の「Preact ハイドレーション」を文字どおり `hydrate()` と読むと、この構成では計測対象が空になる。

### 判断

**「ハイドレーション」= 復元済み `GameState`(engine の内部表現)から、UI が描画できる状態(ストア + 派生値 + ルート vnode)を組み立てるまで**、と解釈する。DOM は 1 つも作らない。

根拠:

1. **ADR の 4 分割は復帰経路を重複なく覆う意図**である(合計が 2000ms = 2秒予算そのもの)。`hydrate()` と読むと B3 と B4 が同じ DOM 生成を二重に数えることになり、合計が予算の意味を失う。
2. ADR-027 が「非アクティブ画面は**物理アンマウント**し、その画面の **computed 購読を解除**」と書いている。つまり ADR の世界観では「engine state から computed(派生値)を作る層」が UI 側に独立して存在し、そこが性能予算の懸念対象として名指しされている。B3 をこの層に割り当てるのが ADR の記述と最も整合する。
3. ADR-012(4) の**列挙順**が `IDB+parse+deserialize` → `ハイドレーション` → `DOM 初回マウント` であり、「状態を得る → 状態を UI 用に整える → DOM を出す」の順に読める。

### この解釈が外れたときの復帰手順(明記)

将来プリレンダ(ビルド時に格子の静的 HTML を吐く等)を導入した場合、**B3 は本物の `hydrate()` に置き換わり、B4 は「新規 DOM 生成」ではなく「既存 DOM への付着」になる**。そのときは本文書 §3 の B3/B4 を書き換え、それ以前の #1 実測値は比較不能として破棄する(algoVersion の bump と同じ扱い)。ADR-012(4) の項目名は変えなくてよい(名前は同じで中身が変わる)。

### T10 実装での B3 の中身(暫定であることの明示)

現時点で UI ストアは存在しない(P1/P2 スコープ外・計画 §2.2「12画面UI は作らない」)。よって B3 は**代替物**として次を測る:

- 48 セル分の view model 構築: セルごとに「建っている施設 / タグ列 / Lv / 就労者数 / 隣接乗数(`AdvanceContext.multiplierByFacilityId` 由来) / 表示用の数値」を引く
- 上部サマリの集計: 住民数・想起困難中の人数・資源ストック・研究進捗

**4 区間の中で、実装が本番と最も乖離しているのが B3 である。** 実 UI ストア(signals / computed)が入ると B3 は確実に重くなるので、T10 の B3 実測値は「下限のさらに下限」として扱う。この点は結果 JSON の `intervals.hydrate.fidelity` フィールドに `"placeholder"` と機械可読で書き出す。

---

## 6. 代表盤面とワークロード

### `sim/board.ts`(T9)を再利用するか — 判断: **しない**(2 つの独立した理由)

**理由1(技術的・決定的)**: `sim/board.ts` は先頭で `conformance/scenarios.ts` の `loadBaseRawContentBundle` を import している。`conformance/scenarios.ts` はモジュール評価時に `fileURLToPath(new URL("../content/", import.meta.url))` を**即時実行**する。T8 がこれをブラウザへ持ち込んで実測した結果、Chromium/Firefox/WebKit いずれも `fileURLToPath is not a function` でページ全体がクラッシュした(`tools/genHarnessData.ts` 冒頭に実測記録あり)。`sim/board.ts` を bench から import すると同じ経路を踏む。

**理由2(設計的・こちらが本質)**: T9 の代表盤面は **施設インスタンスを意図的に 2 個へ潰してある**(`sim/board.ts` の `buildPatternBoard` コメント: 「recallRiskPerDay は assignedFacilityId 先の harshWork だけを見るため、インスタンス数を増やしても判定は変わらない」)。計測 #5(想起困難の頻度)にはそれが正しい。しかし #1 は

- **隣接/過密の実コスト**(ADR-002(2) の O(8) 近傍集計・ADR-029(2))
- **48 セル格子 → 240 DOM** の対応(B3/B4 のワークロードそのもの)

を含む必要があり、施設 2 個の盤面ではどちらも測れない。よって #1 は**別の代表盤面**を持つのが正しい。T9 の盤面を無理に流用すると、B1 の隣接コストと B3/B4 の格子が実態から外れる。

**採る方針**: `bench/perfBoard.ts` に **#1 専用の代表盤面**を新設する。ただし住民側の軸(過酷/通常 × 士気 50/29/14 × 定着度 0/0.20 × 派遣有無 の代表10パターン × 2 人 = 20 人)は **T9 と同じ軸を踏襲**し、施設だけ 12 基へ展開する。両者の関係は `bench/perfBoard.ts` の冒頭に明記する。

### 盤面の内容

| | 値 | 根拠 |
|---|---|---|
| 住民 | 20 人(代表10パターン × 2) | ADR-014 の「20人」・T9 と同じ軸 |
| 施設 | 12 基(hearth×4 / forge×4 / workbench×4) | T5 の実測条件「住民20/施設12/tech3」と一致させる |
| 配置 | cell 0〜3(hearth) / 6〜9(forge) / 12〜15(workbench) | heat タグが密集し過密閾値(3)を超える近傍が生じる = 隣接/過密の計算が実際に走る |
| 研究 | 3 本(content の tech 3 本に 1:1) | content/tech.json |
| 資源 | firewood / iron の 2 種 | content/facility.json の output |
| entity 合計 | 37 | |
| catch-up | tick 0 → 4320(72h) | ADR-026 の 72h クランプ |
| 粗粒度 | 10 分(432 step) | content/balance.json `coarseTickMinutes` |

---

## 7. T11(実 persistence / worker)で差し替わる境界

### B2 → `src/platform/persistence.ts`

| 変更 | 扱い |
|---|---|
| `bench/perfIdb.ts` の暫定実装が `persistence.ts` に置き換わる | **区間の定義は不変**(get → parse → deserialize の 3 演算)。計測点だけが `persistence.loadLatestSave()` の内側へ移る |
| `integrityChecksum` 検証(ADR-012(2))が追加される | **B2 の内側**。同じ blob を舐める処理であり、復帰のクリティカルパスに乗るため。T11 はこれを B2 の 4 つ目の下位区間 `checksumMs` として出すこと |
| localStorage ミラー読出 / 巻戻し検知(ADR-012 / GDD 11.9) | **B2 の外**(補助メトリクス `mirrorCheckMs`)。IDB が生きている happy path では分岐しないため |
| 容量検査・QuotaExceeded 前のサイズ検査 | **書込側**。復帰経路に無いので B2 と無関係 |
| `indexedDB.open()` | 引き続き補助(`idbOpenMs`)。T11 が「予算内に入れる」と決めたら本文書 §3 B2 を改訂すること(§11-(1)) |

### B1 → `src/platform/worker.ts`(ADR-019 / ADR-029)

ここが**最も大きく差し替わる**。先に規則を固定しておく:

1. **タイムオリジンが変わる**。Worker の `performance.now()` は**そのワーカ固有の `timeOrigin`** を基準にする。したがって
   - ワーカ内で取った時刻とメインで取った時刻を**引き算してはならない**。
   - 比較してよいのは**継続時間**だけ。絶対時刻を突き合わせたい場合は `performance.timeOrigin + performance.now()` に揃える。
   - T11 は `computeWorkerMs`(ワーカ内 B1)と `computeWallMs`(メイン側で見た `postMessage` → 完了メッセージ受信までの往復)の**両方**を出すこと。
2. **新しいコスト `transferMs` の所属**:
   - `content` の 1 回転送(ADR-029(1))は**アプリ起動時**であり復帰経路ではない → **予算外**(補助メトリクス `contentTransferMs`)。
   - catch-up 完了時のスナップショット 1 回転送(構造化複製)は**復帰経路の内側** → **B1 の予算に算入**する。理由: ADR-019 が Worker オフロードを長期不在復帰の**正規経路**と定めており、計測 #8 の判断基準も「転送込みで2秒予算内」だから。
   - よって T11 での判定式は **`computeWallMs ≤ 1100ms`**(= ワーカ計算 + 往復転送 + スレッド起動)。`computeWorkerMs` と `snapshotTransferMs` は内訳として出す。
3. **可変ドラフト(ADR-029(1))の所属**: ドラフトの初期化(不変 state → 可変ドラフト)と完了時のスナップショット化(可変ドラフト → 不変 state)は**どちらも B1 の内側**。ADR-029 が数える「ドラフト1個 + 完了時1スナップショット」のアロケーションはここで発生する。
4. **Worker の起動コスト**(`new Worker(...)` とモジュール評価)は、実アプリではアプリ起動時に済ませられる → **予算外**(補助 `workerBootMs`)。ただし「復帰時に初めて Worker を作る」実装にした場合は B1 に算入すること。T11 はどちらの実装かを結果 JSON に `workerLifecycle: "preboot" | "onDemand"` として書くこと。
5. `createAdvanceContext` は引き続き **B1 の内側**(ワーカ側で実行)。

### B3 / B4

T11 では**変わらない**。B3 が変わるのは実 UI ストアが入るとき(§5 末尾)、B4 が変わるのはプリレンダを導入するとき(§5)。

---

## 8. T12(GC/メモリ)で差し替わる境界

**結論: 4 区間の内側の境界は 1 つも変わらない。** T12 は区間の**外側**にサンプリング点を足すだけである。

1. `performance.measureUserAgentSpecificMemory()` は **async であり、それ自身が GC を誘発しうる**。したがって 4 区間のどれかの内側や、区間と区間の間に置いてはならない(R2/R4 違反)。置いてよいのは**試行の境界**だけ:
   - 試行開始前(`before`)
   - B4 終了 + アンマウント後(`after`)
   これで ADR-029(1) の「catch-up 中の JS ヒープ増分ピーク ≤48MB」は「試行前後の差分」として得られる。**「ピーク」を取りたい場合は区間内でサンプルできないため、CDP 側のトレース(下記 3)から取ること**。この制約は T12 が回避できない性質のものなので先に書いておく。
2. `measureUserAgentSpecificMemory()` は **cross-origin isolated(COOP/COEP)を要求する**。`bench/vite.perf.config.ts` に `preview.headers` で `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` を足すのは **T12 の担当**(T10 では入れない。入れると §2 のタイマ分解能の条件が T10/T12 で変わり、過去実測との比較が壊れるため)。T10 は `meta.crossOriginIsolated` を報告するだけにする。
3. **CDP 経由の GC ポーズ抽出**(計画 §5.2 #2)はページ内の境界を変えない。ただしトレースから「どの区間で起きた GC か」を切り出すために、T10 の時点で各区間に **User Timing の mark/measure を発行しておく**(R5 の方式で、計測窓の外から)。名前は固定:
   - mark: `kf:<interval>:start` / `kf:<interval>:end`(`interval` ∈ `compute` `restore` `hydrate` `mount`)
   - measure: `kf:<interval>`(trial 番号は `detail` に入れる)
   T12 はこの名前でトレースを切る。**名前を変えてはならない。**

---

## 9. 結果 JSON と非決定値の隔離

- ルート直下に `meta` オブジェクトを置き、**非決定値(実行時刻・userAgent・ハードウェア情報・タイマ分解能状態)は全部そこへ隔離**する。`workload` / `budgets` / `intervals` / `supplementary` / `judgement` には非決定値を入れない。
- 由来: `bench/tags.html`(T13)の結果 JSON も同じ方針で `generatedAt` / `userAgent` を持つ。ただし tags 側はフラットなので、こちらは `meta` に括る方を採る(#1 の結果は T16 で機械突合するため、決定論的な部分だけを差分できると都合がよい)。
- `$schema` は `kept-flame/bench/perf-boundaries/1`。本文書の境界定義を変えたら**必ずこの版を上げる**(過去の実測 JSON と混ざらないように)。
- 判定は 2 種類を併記する:
  - `judgement.desktopRaw`: デスクトップ実測中央値 vs ADR 予算。**参考値**。
  - `judgement.withProvisionalK`: 中央値 × K(既定 5)vs ADR 予算。計画 §5.1 の暫定運用。**K=5 に根拠は無い**旨を `judgement.note` に必ず載せる。
  - どちらも `"pass"` と出ても **#1 は合格ではない**(§0)。`judgement.isOfficialVerdict: false` を固定で入れる。

---

## 10. 実装ファイルと責務

| ファイル | 責務 |
|---|---|
| `bench/perf.html` | エントリ HTML。light 固定(`color-scheme: light`・`prefers-color-scheme` 分岐を書かない) |
| `bench/perfMain.ts` | 試行ループ。**本文書 §3 の境界だけを実装する**。表示とコピー |
| `bench/perfBoard.ts` | §6 の代表盤面 + 合成大容量セーブ。content の in-browser ロード |
| `bench/perfGrid.tsx` | B3 の view model 構築(純関数) + B4 の Preact コンポーネント |
| ~~`bench/perfIdb.ts`~~ | B2 の暫定 IndexedDB。**T11 で削除**し `src/platform/persistence.ts` に置き換えた(§12) |
| `bench/perfStats.ts` | 中央値・要約・判定・結果 JSON 組立(純関数・vitest 対象) |
| `bench/vite.perf.config.ts` | 隔離 vite 設定(`conformance/vite.harness.config.ts` と同じ流儀。ルートの `vite.config.ts` は触らない) |

---

## 11. 未確定点(要判断・非ブロッキング)

1. **`indexedDB.open()` を 450ms 予算に入れるか**。ADR-012(4) の文言は 3 演算しか名指ししていないが、実 cold restore では必ず払う。T10 は両方の数値を出す。T11 が実測を見て決め、決めたら本文書 §3 B2 と ADR-012(4) の文言を同時に直す(ADR 改訂はユーザー承認事項)。→ **[T11] 前提が崩れたので §12-4 を参照**(44.6ms は open のコストではなく IndexedDB サブシステムの初回起動コストだった)。
2. **B4 に paint を含められない**。同期的に測れないため。実機で「見えるまで」を測るなら `requestAnimationFrame` 2 回待ち等の別手法が要るが、それは R4(区間内での非同期禁止)に反するので**別メトリクス**として T14 で足すのが筋。
3. **B3 の忠実度**。実 UI ストアが無い間、B3 は代替物である(§5 末尾)。UI 実装が入ったら #1 を取り直す必要がある。
4. **save サイズ**。代表盤面の save は数 KB、ADR-012(2) の容量目標は ≤512KB。B2 の予算 450ms がどちらを想定した数字なのかは ADR に書かれていない。T10 は両方測る(§3 B2)。どちらを正とするかは T16 の判定時にユーザー判断。
5. **タイマ分解能**。cross-origin isolated でない環境では `performance.now()` が丸められ、B3/B4 が測れない(Chromium で 0.1ms 刻み・実測確認済み。Firefox/WebKit は 1ms)。T12 が COOP/COEP を入れるまで #1 は Chromium 系のみで取り、B3/B4 は「予算より 3 桁小さい」以上の主張をしない。
6. **B1 のウォームアップ差**。実測では compute の warmup が中央値の約 2.5 倍だった(16.2ms vs 6.55ms)。実機の実復帰は cold なので、実機計測では中央値だけでなくウォームアップ値も必ず併記すること。ADR-012(4) の 1100ms がどちらを想定した数字なのかは ADR に書かれていない(T16 の判定時にユーザー判断)。

---

## 12. T11 差し替えの実施記録(2026-07-26)

§7 で先に決めた差し替えを実装した記録である。**境界の定義(§3 の開始点/終了点、§4 の予算外リスト、§2 の R1〜R8)は 1 つも変えていない。** 変わったのは「その境界の内側で何が走るか」であり、その結果として実測値が §1 の T10 値と比較不能になった(結果 JSON の `$schema` を `.../1` → `.../2` へ上げた理由)。

### 12-1. 実装ファイル

| ファイル | 役割 | 境界との関係 |
|---|---|---|
| `src/platform/persistence.ts` | IDB open/put/get・正準化 JSON 文字列・`integrityChecksum` | **B2 の本体**。`loadLatestSave()` が §3 B2 の 3 演算 + checksum を内包する |
| `src/platform/catchUp.ts` | 二系統の切替点・経路選択・catch-up 本体・Worker メッセージ規約 | **B1 の中身**(Worker 非依存の純粋部。vitest 対象) |
| `src/platform/worker.ts` | Worker エントリ(グローバルへの配線のみ) | B1 の実行場所 |
| `src/platform/workerClient.ts` | メイン側ハンドル(`new Worker` / 往復 / 内訳の組立) | **B1 の計測点**(`computeWallMs`) |
| `bench/perfMain.ts` | 上記 2 経路を差し込み。旧 `bench/perfIdb.ts` は削除 | §10 の表を更新済み |
| `bench/perfSmoke.spec.ts` + `bench/playwright.perf.config.ts` | 実 Chromium 1 エンジンのスモーク | 計測値の判定はしない(§0) |

### 12-2. B2(restore)で決めたこと

- **`integrityChecksum` は B2 の内側**(§7 のとおり)。下位区間 `checksum` として出す。実装は engine の FNV-1a-32(`src/engine/rng/fnv1a32.ts`)の再利用で、独自ハッシュを増やしていない。ADR-012(2) が求めているのは破損検出であって改竄耐性ではないため 32bit で足りる(SubtleCrypto は非同期で §2 R4 に反するので不採用)。
- **ADR-012 のセーブフォーマットとの差(要ユーザー判断)**: ADR は `integrityChecksum` を `entityStateById` と同階層のキーとして列挙しているが、**チェックサムは自分自身を含む文書を覆えない**。実装では 1 段のエンベロープ `{ saveFormatVersion, integrityChecksum, payload }` に分離し、`payload` が ADR のセーブフォーマットそのもの(正準化 JSON 文字列)である。検証は payload 文字列を 1 回舐めるだけで済み、復帰経路に `JSON.stringify` を増やさない。
- **`payload` は文字列**のまま IDB に入れる(§3 B2 の「構造化複製可能なオブジェクトとして入れない」を維持)。エンベロープは薄いヘッダ 2 フィールドのみで、`JSON.parse` のコストは B2 に残る。
- **下位区間が親を過不足なく分割する規則(§2 R7)を守るための追加**: `loadLatestSave` は自分の内側で取った**生の `performance.now()` 値**を返し、bench は関数呼び出し前後との残差を `restore.callOverhead` として明示計上する。これで `idbGet + checksum + parse + deserialize + callOverhead = restore` が恒等に成り立つ。
- **未実装のまま(計画 §2.2)**: 2秒デバウンス / 15秒・25コマンド絶対フラッシュ / 書込前サイズ検査 / localStorage ミラー・巻戻し検知。差し込み位置は `persistence.ts` §5 にコメントで固定した。**`mirrorCheckMs` は機能が無いので結果 JSON に出さない**(常に null のフィールドを作らない)。

### 12-3. B1(compute)で決めたこと

- **判定式は §7-2 のとおり `computeWallMs ≤ 1100ms`**(メイン側で見た「postMessage 直前 → 完了メッセージ受信」)。Worker 内時間では判定しない。
- **§7-1 の timeOrigin 規則を守る実装**: Worker が外へ出すのは**継続時間だけ**で、絶対時刻は 1 つも渡さない。メイン側で 1 点だけ引き算するのは同一コンテキストの `receivedAt − startedAt` である。
- **B1 の下位区間(親を過不足なく分割する)**:
  `requestPost`(メイン `postMessage` 呼び出し = 入力 state のシリアライズ込み)/ `workerContextBuild` / `workerAdvance` / `workerSnapshot` / `workerOther`(Worker 側ハンドラの残り)/ `transport`(**残差**として定義 = `computeWallMs − requestPost − workerHandlerMs`)。
- **§7-2 に無かったコストの所属を追加(R8 に従いここで宣言する)**: **入力 state のメイン→ワーカ転送**。§7-2 は content 転送と完了スナップショット転送しか名指ししていなかったが、Worker 経路では復元済み state を必ずワーカへ渡す。これは復帰経路の内側なので **B1 に算入**し、`requestPost` と `transport` に現れる。
- **完了スナップショットに `AdvanceContext` の一部を同梱する(同じく R8 の宣言)**: 隣接乗数 `multiplierByFacilityId` は UI の表示値でもあるため、Worker から返さないとメイン側が B3 で `createAdvanceContext` を呼び直すことになり、**§3 B3 の「含まないもの: engine の再計算」に反する**。よって完了メッセージに `{ worldSeedU32, multiplierByFacilityId }`(`TransferableAdvanceContext`)を同梱し、B3 は `restoreAdvanceContext()` で繋ぎ直すだけにした(施設 12 基 = Map 12 エントリ、`content` は積まない)。この転送コストは **B1 の内側**(`transport`)。
- **`workerLifecycle: "preboot"`**(§7-4)。`workerBootMs` と `contentTransferMs` は予算外の補助メトリクスとして出し、onDemand 実装での換算値 `computeWallWithBootMs = computeWallMs + bootMs + contentTransferMs` を派生値として併記する。
- **二系統の切替点(ADR-029(1))は `src/platform/catchUp.ts` の `CATCH_UP_UPDATE_MODES` ただ 1 箇所**。現状 `"mutable-draft"` は**未実装で必ず例外**になる(黙って構造共有へフォールバックしない)。理由は engine 側に「ドラフト表現 + in-place 更新 API」が要り、T11 は `src/engine/**` を変更しないタスクだから。したがって **B1 の実測値は構造共有系のもの = 上限側の見積り**であり、可変ドラフト導入後は下がる。この事実は結果 JSON の `intervals.computeFidelity`(`"worker-structural-sharing"`)に機械可読で載せた。
- **経路選択のしきい値は ADR-026(3) の 600 tick**(`chooseCatchUpRoute`)。72h catch-up(4320 tick)は Worker 経路になる。
- **メインスレッド同期 advance は消していない**。ADR-026(3) が「差分 ≤600 tick はメインスレッド」と定めている以上これは実アプリの別経路であり、`sensitivity.computeOnMainThread` として同条件で併走計測する。**両者の差が計測 #8(Worker 越し転送コスト)そのもの**になる。

### 12-4. §11-(1)(`indexedDB.open()` を予算に入れるか)への回答

T10 が §11-(1) に登録した **`idbOpenMs` = 44.6ms** は、**`open()` のコストではなく IndexedDB サブシステムのページ内初回起動コスト**だった。T11 は前回 DB の `deleteDatabase()` を計測前に置いた(毎回クリーンな状態から測るため)ので、初回接触コストがそちらへ移り、内訳が分離できた:

| メトリクス | 実測(HeadlessChrome 151 / Ryzen 7 5700X) | 意味 |
|---|---|---|
| `idbFirstTouchMs` | **43.6 ms** | ページで最初の IndexedDB 呼び出し(ここでは `deleteDatabase`)。サブシステム起動 |
| `idbOpenMs`(cold) | **1.8 ms** | 同一ページ内で DB を新規作成する `open`(`onupgradeneeded` 込み) |
| `idbOpenWarmMs` | **0.2 ms** | 既存 DB を開き直す `open` |

**結論(提案)**: `open()` を 450ms 予算へ入れる/入れないの議論は**入れても入れなくても結論が変わらない**(1.8ms は 450ms の 0.4%)。実際に効くのは「アプリ起動時に IndexedDB へ 1 回触るまでの ~44ms」であり、これは B2 の予算ではなく **アプリ起動シーケンス側の問題**である(復帰のたびに払うものではない)。よって:

- **§3 B2 と ADR-012(4) の文言は変えない**(open は引き続き補助メトリクス)。
- 代わりに **`idbFirstTouchMs` を必ず記録する**ことにした(§4 の補助メトリクスへ追加)。実機では桁が変わりうるので、T16 の判定時にはこの値を「2秒予算の外で先に払われる固定費」として別枠で見ること。
- **これは T11 の提案であって決定ではない**。ADR 文言の改訂はユーザー承認事項なので、確定は T16 のユーザー判断に委ねる。

### 12-5. デスクトップ実測(参考値・#1 の合否ではない)

HeadlessChrome 151 / Ryzen 7 5700X / `crossOriginIsolated: false`(= **0.1ms 刻みへ丸め**)。ウォームアップ 1 + 計測 10 試行の中央値。

| 区間 | T10(版1) | T11(版2) | warmup | 予算 | 内訳(T11 中央値) |
|---|---|---|---|---|---|
| B2 restore | 0.3 ms | **0.3 ms** | 1.1 ms | 450 | idbGet 0.2 / checksum 0.0 / parse 0.0 / deserialize 0.1 / callOverhead 0.0 |
| B1 compute | 6.65 ms(メインスレッド) | **7.4 ms**(Worker 往復込み) | 16.8 ms | 1100 | workerAdvance 7.2 / workerContextBuild 0.1 / transport 0.1 / requestPost 0.0 / workerOther 0.0 |
| B3 hydrate | 0 ms | **0 ms** | 0.2 ms | 250 | viewModel 0.0 / vnode 0.0 |
| B4 mount | — | **1.8 ms** | 6.1 ms | 200 | render 0.7 / layout 1.2 |
| 合計 | — | **9.7 ms** | — | 2000 | — |

補助: `workerBootMs` **7.6 ms** / `contentTransferMs` **0.3 ms** / `idbFirstTouchMs` **43.6 ms** / `idbOpenMs`(cold)2.0 ms / `idbOpenWarmMs` 0.1 ms / `idbPutMs` 2.1 ms / `saveEncodeMs` 1.1 ms / `contentLoadMs` 2.0 ms。セーブ 6,160 B(entity 37・`integrityChecksum` 3493417291)。onDemand 実装での換算 `computeWallWithBootMs` = **15.3 ms**。

**計測 #8(Worker 越し転送コスト)**: 同一実行内で測ったメインスレッド同期 advance = **6.5 ms** に対し、Worker 経路 = **7.4 ms**。**上乗せは約 0.9 ms(+14%)**。その内訳を見ると `requestPost + transport` = **0.1 ms 以下**であり、上乗せの大半は**構造化複製ではなく Worker 側の実行環境差**(`workerAdvance` 7.2 vs メインの `advance` 6.4)である。#8 の判断基準「転送込みで2秒予算内」に対してデスクトップでは 3 桁の余裕がある。**ただし §0 のとおりこれは実機の下限見積りであり、#8 も #1 も合格ではない**(structured clone のコストは実機のメモリ帯域/GC に強く依存する = 計画 §1 が #8 を区分②に置いた理由そのもの)。

**save サイズ感度**(524,314 B の合成セーブ): restore 中央値 **3.75 ms**(idbGet 0.4 / checksum 0.5 / parse 0.95 / deserialize 1.25 / callOverhead 0.5)。**checksum は容量目標いっぱいでも 0.5 ms** であり、B2 へ入れたことによる予算圧迫は 0.2% 未満。

**分解能の注意**: `requestPost` / `transport` / `checksum` / `parse` / B3 全体は 0.1ms 刻みの下に落ちており、「0」は「0.1ms 未満」以上のことを言っていない(§2「タイマ分解能」)。T12 が COOP/COEP を入れれば実数値が取れる。

**B3 が 0 になった理由(T10 との差)**: T10 は B1 で作った `AdvanceContext` を B3 で使い回していた。T11 では B1 が Worker へ移ったため、Worker が計算済みの隣接乗数を完了メッセージで返し、B3 は `restoreAdvanceContext()` で繋ぎ直すだけにしてある(§12-3)。B3 に engine の再計算を入れないための措置であり、§3 B3 の定義どおり。

---

## 13. T12(GC/メモリ)実施記録(2026-07-27)

§8 で先に決めた「4 区間の内側は変えない・区間の外側にサンプリング点を足すだけ」をそのまま実装した記録である。**§3 の区間定義・§2 の R1〜R8 は 1 つも変えていない。**

### 13-1. COOP/COEP とタイマ分解能(§8-2 の実施)

`bench/vite.perf.config.ts` の `preview.headers` に `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` を追加した(build には headers の概念が無いので preview のみ)。全リソースが同一オリジンから配信されるため、COEP が要求する `Cross-Origin-Resource-Policy` を個別リソースへ追加する必要は無かった(CORP は異なるオリジンからの `no-cors` 読込にのみ効く)。

**副作用の実測**: `crossOriginIsolated: true` になり、§2「タイマ分解能」で予告したとおり `performance.now()` の分解能が 0.1ms 丸め(T10/T11)から高分解能(実測で 1µs 未満まで見える桁)へ上がった。B3 `hydrate` の中央値が T11 の `0ms`(=分解能未満)から **`0.033ms`** という実数値として初めて観測できた(§13-4)。これは T12 が本タスクとして狙っていた副産物そのものである。

**`$schema` は版を上げない(`.../2` のまま)**。理由: (a) §8 のとおり 4 区間の境界定義そのものは変えていない(T11 のように「B1/B2 の中身が Worker/persistence 経路へ差し替わった」ような構造変更ではなく、単にタイマの精度が上がっただけ)。(b) 本タスクの指示が `bench/perfSmoke.spec.ts`(既存テスト)を無改変で通すことを要求しており、同テストは `$schema` の完全一致を断言している。版を上げるとこの既存断言が機械的に壊れる。(c) 判別に必要な情報は既存の `meta.crossOriginIsolated` フィールドがそのまま担える(T10/T11 の `false` → T12 以降の `true`)。よって「$schema 更新」と「`crossOriginIsolated` フィールドでの機械可読な区別」のうち**後者を採った**。`bench/perfStats.ts` の `PERF_RESULT_SCHEMA` 定義コメントと `JUDGEMENT_NOTE` にこの判断根拠を明記した。

### 13-2. ヒープ増分計測(計測 #2 前半)の実装(§8-1 の実施)

`bench/perfMain.ts` の試行ループへ、`runTrial()`(B2→B1→B3→B4→アンマウント)の**呼び出し前後**だけで `performance.measureUserAgentSpecificMemory()` を前後取得するコードを追加した。区間の内側・区間間には一切置いていない(R2/R4 遵守)。`breakdown` は `attribution[0].scope` で `windowBytes` / `workerBytes` / `otherBytes` に仕分けて全試行ぶんを結果 JSON の `memory.samples` に残す(§8 冒頭の指示どおり window/worker 別)。

**実測で判明した想定外の分岐(重要)**: API の有無を `typeof === "function"` で判定するだけでは不十分だった。**Playwright の headless Chromium(151・new headless 含む)は `crossOriginIsolated: true` かつ関数が存在していても、実際に呼ぶと `SecurityError`(`"...is not available"`)を投げる**。同一ページを `headless: false` で開くと成功する(`bytes` 実測値が返る)ことを最小再現(COOP/COEP のみを立てた素の HTML)と実際の `bench/perf.html` の両方で確認した。これは Puppeteer 側でも既知の報告がある headless 自動化固有の制約であり(参照: puppeteer/puppeteer#8258)、実ブラウザの手動操作や実機では発生しない想定である。

対処として `sampleMemoryScopeSafe()` で呼び出しを try/catch し、失敗してもベンチ全体を継続させたうえで `memory.supported=false` / `memory.unsupportedReason="measurement-error"` / `memory.errorMessage=<生メッセージ>` を機械可読に残す(計画 §6.3 の「null + 理由」方式を「呼び出し失敗」のケースにも拡張)。`unsupportedReason` は次の 4 値: `"not-cross-origin-isolated"` / `"unsupported-api"`(計画 §6.3 の Firefox/WebKit 等)/ `"measurement-error"`(今回実測で追加)/ `"not-measured"`(`PerfResultInput.memory` 省略時のテストフィクスチャ用デフォルト。`bench/perfMain.ts` は返さない)。

### 13-3. CDP 経由の GC ポーズ抽出(計測 #2 後半)の実装(§8-3 の実施)

新規 `bench/gcTrace.spec.ts`(Playwright chromium 限定・`bench/playwright.perf.config.ts` の `testMatch` に追加)。Playwright の `CDPSession`(`context.newCDPSession(page)`)経由で生の CDP `Tracing` ドメインを直接叩く(新規 npm 依存なし・`chrome-devtools-protocol` パッケージは追加していない)。カテゴリ `disabled-by-default-v8.gc` / `disabled-by-default-v8.gc_stats` / `disabled-by-default-devtools.timeline` / `blink.user_timing` を `Tracing.start` の `traceConfig.includedCategories` に指定し、`Tracing.dataCollected` イベントでチャンクを蓄積する。

**mark/measure を使った区間切り出し(§8-3 の設計どおり)**: `bench/perfMain.ts` が T10 の時点から発行している `kf:compute` measure(名前は固定・変更禁止)が `blink.user_timing` カテゴリのトレースイベントとして記録されることを実測で確認した。`performance.mark(name, { startTime })` に渡した `startTime` がそのままトレースイベントの `ts` として使われる(呼び出し時刻ではなく指定した仮想時刻)ことも実測で確認済み。試行は逐次実行なので `kf:compute` の窓は互いに素であり、時系列に並べた先頭がウォームアップ試行になる(トレースの `args.detail` に実際は `{"trial":-1}` 等の trial 番号が載ることも確認したが、実装は時系列の事実だけに依拠していて `detail` の中身には依存しない)。

**実測で発見した罠(GC 候補イベントの選別)**: 当初は「`disabled-by-default-v8.gc` / `gc_stats` カテゴリのイベントは名前を問わず全部 GC」という設計で実装したが、実トレースを検分した結果 **`UserBlocking` という名前のイベントが begin 3 件 / end 2 件と対応が壊れており**、単純な LIFO begin/end 対応付けにかけると実在しない 308ms 相当の偽ポーズを生むことを実測で発見した(`IsLoading` も同様に GC フェーズとは考えにくい名前で、対応関係の性質が他の正規 GC フェーズ名と異なる)。他の全名前(`Scavenge` / `Marking` / `IncrementalMarking` / `Incremental Mark-Compact` / `Sweeping` / `Atomic` / `ObservablePause` / `MarkCompactCollector::EvacuatePagesInParallel` / `Evacuator::EvacuatePage` / `FullEvacuator::RawEvacuatePage` / `LiveObjectVisitor::VisitMarkedObjects[NoFail]` / `RememberedSetUpdatingItem::Process` / `V8.GCMarkTransitiveClosureFixpoint` / `V8.GCReachTransitiveClosureWithEmbedder`)は begin/end(または complete)の対応が正しく取れており、名前も V8 の GC 内部用語と一致する。よって `UserBlocking` / `IsLoading` の 2 つだけを名指しで除外する方針にした(`bench/gcTrace.spec.ts` の `V8_GC_NON_PAUSE_NAMES`)。**推測で決め打ちにせず、実測(begin/end 件数の不一致)で確認してから除外した**(CLAUDE.md「幻覚防止」への対応)。`disabled-by-default-devtools.timeline` カテゴリの `MajorGC`/`MinorGC` は今回のワークロードでは 1 度も観測されなかった(Chromium 151 はこのワークロードでは v8.gc 側の低レベルフェーズ名だけを流す)。

**ウォームアップと計測試行の分離**: GC ポーズも B1〜B4 の中央値方式(§2)に倣い、ウォームアップ試行(cold start・JIT 未暖機)の GC ポーズを判定から除外し、`gc.maxPauseWarmupMs` として参考値で別掲した。判定(`judgement.gcPauseVerdict`)は**計測試行(ウォームアップ除く)の最大値**で行う。

**正直な限界(コード冒頭コメント §3 に明記)**:
- トレース区間は B1 の 11 試行(ウォームアップ含む)全体であり、1 回の catch-up の「ピーク」ではなく全試行を通した最大値。
- `Incremental Mark-Compact` のような「サイクル全体」を表す名前の duration は非停止(並行/インクリメンタル)区間を含みうるため、真の stop-the-world 時間より大きく出る可能性がある。ネストされた `Atomic`/`ObservablePause` の方が実態に近い可能性があるが、どちらが正しいかは判定せず両方とも `observedEventNames` 付きの参考値として残す。
- 0 件観測は「合格の強い根拠」にはならない(ワークロードが軽すぎて GC 自体が誘発されていない可能性)。

### 13-4. デスクトップ実測(参考値・#2 の合否ではない)

HeadlessChrome 151 / Ryzen 7 5700X / `crossOriginIsolated: true`(§13-1 の副作用で高分解能タイマ)。`npm run bench:perf:e2e` で 3 回連続実行し値の桁が安定していることを確認した(以下は代表 1 回分)。

**#2 前半・ヒープ増分**: `memory.supported=false`, `unsupportedReason="measurement-error"`(§13-2 のとおり headless Chromium 自動化の既知の制約)。**この環境では数値を取得できなかった**。切り分けのため素の COOP/COEP ページで `headless:false` を試したところ成功する(`bytes` 実測値が返る)ことを確認したが、`bench/perf.html` 自体を `headless:false` で実行しようとすると、本エージェント実行環境(対話的デスクトップセッションを持たないサンドボックス疑い)では警告なしに `page.waitForFunction` が 150 秒でタイムアウトし、ウォームアップ試行から一切進まなかった(20 秒刻みで `status` を追跡し `"ウォームアップ試行を実行中…"` のまま停止していることを確認済み。visibilityState は `"visible"` で document 非表示によるスロットリングではない)。原因は catch-up Worker からの応答が返っていないことまでは切り分けたが、それ以上の深掘り(ヘッドフル自動化特有の Worker スケジューリング問題の特定)は本タスクのスコープ外と判断し停止した(CLAUDE.md「同じアプローチを3回試して失敗したら停止」)。**コード自体は正しく動作を分岐させることを確認済み**(headless では `measurement-error` を検出してベンチ全体を継続、素のページでは `headless:false` で実際に `bytes` が返ることを最小再現で確認)。実機/実ブラウザでの手動実行(T14)では通常のユーザー操作なので、この制約自体は発生しない見込み。**ヒープ増分ピークの実数値取得は T14/実機での宿題として持ち越す。**

**#2 後半・GC ポーズ**(`bench/gcTrace.spec.ts` 実測・B1 の 11 試行を通した CDP トレース):

| 指標 | 値 |
|---|---|
| 観測された GC 候補イベント名 | `Atomic` / `Evacuator::EvacuatePage` / `FullEvacuator::RawEvacuatePage` / `Incremental Mark-Compact` / `IncrementalMarking` / `LiveObjectVisitor::VisitMarkedObjects[NoFail]` / `MarkCompactCollector::EvacuatePagesInParallel` / `Marking` / `ObservablePause` / `RememberedSetUpdatingItem::Process` / `Scavenge` / `Sweeping` / `V8.GCMarkTransitiveClosureFixpoint` / `V8.GCReachTransitiveClosureWithEmbedder` |
| GC 候補イベント総数(全 11 試行) | 1,072 件(ウォームアップ 114 / 計測 10 試行 683) |
| 最大ポーズ(ウォームアップ) | **0.333 ms**(参考値) |
| **最大ポーズ(計測10試行・判定値)** | **0.429 ms** |
| 中央値(計測10試行) | 0.057 ms |
| 最大ポーズ(ページ全体・B1 外含む) | 43.389 ms(参考。初期ロード等 B1 外での 1 回) |
| 判定 | `pass`(≤50ms/回に対し **2 桁の余裕**) |

**計測 #1 の副産物(crossOriginIsolated=true 下での B1〜B4 再計測)**:

| 区間 | T11(`crossOriginIsolated:false`) | T12(`crossOriginIsolated:true`) | 差の性質 |
|---|---|---|---|
| B2 restore | 0.3 ms | **0.28 ms** | 実質同じ(内訳が 0.1ms 未満まで見えるように: idbGet 0.162 / deserialize 0.065 / parse 0.02 / checksum 0.01 / callOverhead 0.01) |
| B1 compute | 7.4 ms | **7.365 ms** | 実質同じ(内訳: workerAdvance 7.117 / workerContextBuild 0.072 / transport 0.1 / requestPost 0.027) |
| B3 hydrate | **0 ms**(分解能未満) | **0.033 ms** | **T12 で初めて実数値が見えた**(§13-1 の狙いどおり。viewModel 0.03 / vnode 0) |
| B4 mount | 1.8 ms | **1.747 ms** | 実質同じ(render 0.605 / layout 1.112) |
| 合計(試行ごと4区間和の中央値) | 9.7 ms | **9.403 ms** | 誤差の範囲 |

補助: `workerBootMs` 8.03 ms / `contentTransferMs` 0.245 ms / `idbFirstTouchMs` 2.59 ms / `idbOpenMs`(cold)0.745 ms / `idbOpenWarmMs` 0.125 ms / `idbPutMs` 8.68 ms / `saveEncodeMs` 0.925 ms / `contentLoadMs` 1.905 ms。セーブ 6,160 B(entity 37・`integrityChecksum` 3493417291・T11 と同一 = 決定論に影響なし)。

**解釈**: B1/B2/B4 の中央値そのものは T11(0.1ms 丸め)とほぼ変わらない(丸めの前後で誤差の範囲)。**B3 だけが「0.1ms 未満」から「0.033ms」という実数値になった**のが COOP/COEP 導入の直接的な観測効果であり、§2 が予告していた「T12 以降は B3/B4 の実数値が初めて取れる」を実証した形になる。`idbFirstTouchMs` が T11(43.6ms)から今回(2.59ms)へ大きく下がっているのは crossOriginIsolated 化の影響ではなく、実行環境(初回 DB 作成コストは OS/ディスクキャッシュ状態に依存)の揺らぎであり、既知の非決定要因として §11-(1)/§12-4 の議論を変えるものではない。

### 13-5. Firefox/WebKit での縮退挙動

`bench/perf.html` は Chromium 系専用のベンチではなく素の Web ページなので、理論上は Firefox/WebKit でも開ける。ただし:

- **`bench:perf:e2e` は Chromium 限定のまま**(`bench/playwright.perf.config.ts` の `projects` は変更していない)。理由は元から §2「タイマ分解能」/T11 コメントに書かれているとおり、Firefox/WebKit は非 cross-origin-isolated 環境で `performance.now()` を 1ms へ丸めるため #1 の対象外という既定方針を継続するだけであり、T12 が新たに変えた点ではない。
- `performance.measureUserAgentSpecificMemory` は Chromium 系 API であり(計画 §6.3)、Firefox/WebKit では `typeof !== "function"` になる。この場合 `memoryUnsupportedReason()` は `globalThis.crossOriginIsolated` を見て `"not-cross-origin-isolated"` か `"unsupported-api"` を返す(COOP/COEP を Firefox/WebKit で有効にしても API 自体が無いので後者になる)。**未実行だが、コードパスとしては `bench/perfMain.ts` の `getMeasureMemoryFn()` が `null` を返すだけで、ベンチ全体は正常に完走する**(該当分岐は `tests` 側で直接は踏んでいないが、`measureMemoryFn === null` の分岐は headless Chromium 実行でも `unsupported-api`/`not-cross-origin-isolated` ではなく `measurement-error` 経路を通っているため、`null` 分岐自体は実行されていない。**この点は未検証のまま**であり、Firefox/WebKit 実機での確認は T14/T16 へ持ち越す)。
- CDP の `Tracing`/`CDPSession` は Chromium 専用機能なので、`bench/gcTrace.spec.ts` は最初から Chromium 限定として設計している(§13-3)。Firefox/WebKit で GC ポーズを取る手段は本タスクの範囲外(計画書にも代替手段の記載はない)。

### 13-6. 迷った点・未確定点

1. **§13-4 の「headless では動くが headed で止まる」現象の根本原因は未特定**。Worker からの応答が返っていないところまでは切り分けたが、それ以上は本タスクのスコープ外と判断して打ち切った。T14(実機パッケージング)または実際のユーザー操作(常に headed)では発生しない可能性が高いが、断定はしない。
2. **`$schema` を上げない判断(§13-1)は「既存テスト無改変」の制約を優先した結果**であり、境界文書の一般原則(§9「境界定義を変えたら必ず版を上げる」)とは矛盾しない(境界定義自体は不変)ものの、「観測条件が変わって過去値と比較不能になった」という意味では T11 の schema bump 理由と同種の事象である。`meta.crossOriginIsolated` を見ずに `$schema` だけで比較可能性を判断するコードを将来書くと誤る恐れがあるため、ここに明記した。
3. **GC ポーズ判定の対象範囲**: 判定は B1(compute)の 11 試行全体に重なる GC 候補イベントを見ており、実際の「1 回の catch-up あたりのポーズ」ではなく「11 回のどれか 1 回ぶんの最大値」である。これは§8-1 が明記する構造的制約(区間内でサンプリングできない)の帰結であり、より厳密にしたい場合は 1 試行だけをトレースする専用モードが要るが、本タスクの判断基準(≤50ms/回)に対して 2 桁の余裕がある現状ではその追加実装の必要性は低いと判断した。
4. **ヒープ増分ピークの「ピーク」の定義**: §8-1 の設計どおり「試行境界(前後)の差分」であって、真の意味でのヒープ使用量ピーク(試行中の最大瞬間値)ではない。真のピークは Chrome DevTools のヒーププロファイラ等、別ツールでの補完が必要(本タスクのスコープ外)。

---

## 14. T14(実機計測ページのパッケージング)実施記録(2026-07-27)

対象: 計測 #1/#2/#8(`bench/perf.html`)・#9b(`bench/tags.html`)・#7 実 iOS Safari 補完(`conformance/harness.html`)を実機で開ける形にする。ユーザー向け実施手順は `docs/measurements/device-testing-guide.md`。**本節は §1〜§13 の境界定義を 1 つも変えていない**(4 区間の開始点/終了点・R1〜R8 は不変)。変わったのは配布形態(複数ファイルのビルド出力 → 単一 HTML)と、結果 JSON の画面表示/回収手段(コピーに加えダウンロードを追加)だけである。

### 14-1. 単一ファイル化の方式(新規 npm 依存なし)

`npm run bench:perf:build` / `npm run conformance:build` の出力(`dist/perf/` / `dist/harness/`)は、HTML + 別チャンクの JS という複数ファイル構成であり、`bench/perf.html` はさらに catch-up Worker 用の別チャンク(`assets/worker-*.js`)を持つ。これを `tools/packageDevice.ts`(post-build スクリプト・純関数を切り出して `tests/tools/packageDevice.test.ts` で固定)がテキスト操作でインライン化し、`dist/device/` に4ファイル(`perf.html`/`tags.html`/`harness.html`/`index.html`)を書き出す。新規 npm パッケージは追加していない(`vite-plugin-singlefile` 相当を自前実装)。

- `<link rel="stylesheet">` → `<style>` へインライン化、`<link rel="modulepreload">` は削除、`<script src="...">` → インライン `<script>` へ本文を埋め込む(`</script` は `<\/script` へエスケープし HTML パーサの誤認を防ぐ)。
- `bench/tags.html` は T13 時点で既に外部依存ゼロの単一 HTML だったため、ビルドを経由せずソースをそのまま検査つきでコピーするだけで足りた。
- `conformance/harness.html` は `harnessData.json` を `import harnessDataJson from "./harnessData.json"` で静的 import しているため、Vite が JSON をバンドル本体へ JS オブジェクトとしてインライン化済みであり、**別ファイルの同梱は不要**だった(T14 依頼が想定していた「harnessData.json は埋め込みか同梱の2ファイル構成」のうち、埋め込み側がビルドの標準動作として既に実現していた)。
- 生成物には `dist/device/index.html`(`tools/deviceIndex.template.html` をそのままコピー)を追加した。3ページへの入口リンクのみを持つ静的ページで、light 固定・外部参照ゼロ。
- 自己完結の自己検査として `assertSelfContained()` を実装し、`<script src=...>` の残存・外部 `<link rel="stylesheet"|"modulepreload">` の残存・`http(s)://` を指す `src=`/`href=` 属性の残存の3点を検査してから書き出す(検査対象はビルド出力全体。JS 文字列内の `.src=` のようなプロパティ代入は「属性の直前は必ず空白」という HTML 構文上の性質を使って誤検出を避けている)。

生成物サイズ(実測): `perf.html` 約117KB / `harness.html` 約122KB / `tags.html` 約42KB / `index.html` 約3KB。

### 14-2. catch-up Worker の埋め込みで実測した file:// 特有の制約(重要)

`src/platform/workerClient.ts`(変更禁止)は `new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "kept-flame-catchup" })` で Worker を起動する。Vite ビルド後、この `new URL(...)` は `/assets/worker-<hash>.js` という絶対パスを指すが、`file://` で開いた場合はこの絶対パスを解決できない。

対処として、ビルド後の worker チャンク(実測: import/export を一切含まない完全に自己完結した平坦スクリプトであることを確認済み)をテキストとして読み込み、`new Blob([code], { type: "text/javascript" })` + `URL.createObjectURL` で作った Blob URL に差し替えた(`tools/packageDevice.ts` の `inlineWorkerReferences`)。

**この過程で実機配布に直結する挙動を1つ発見した**: Chromium で `new Worker(blobUrl, { type: "module" })` を `file://` 起点のページから呼ぶと、`onerror` がメッセージ無しで無言に失敗する(`new Worker(blobUrl)`(type 省略 = classic)は同じ `file://` 起点で成功する)最小再現で確認した。埋め込み対象の worker チャンクは import/export を含まないため、`type: "module"` を落としても意味的に同一に動く。よって `tools/packageDevice.ts` は `new Worker(...)` の呼び出しから Blob URL への置換と同時に、オプション引数中の `type: "module"` だけを取り除く(`name` 等の他オプションは残す)。`worker.ts`/`workerClient.ts` のソース自体は無改変。

この発見が無ければ `dist/device/perf.html` は `file://` で開いた瞬間に Worker が無言で失敗し、#1/#2/#8 のいずれも実機で測れなくなっていた。

### 14-3. 結果 JSON の表示/コピー/ダウンロード(additive)

T14 依頼の「3ページとも表示+コピー+ダウンロード」を確認した結果:

| ページ | 対応状況(T14着手前) | 追加した内容 |
|---|---|---|
| `bench/perf.html` | 表示・コピーは T10 で実装済み | 「結果をダウンロード」ボタンを追加(`bench/perfMain.ts` の `downloadResultJson`)。計測境界・digest計算には触れていない |
| `bench/tags.html` | 表示・コピーは T13 で実装済み | 「結果をダウンロード」ボタンを追加。判読テストのロジック(`TRIALS`/`renderJudgeStage`)は無改変 |
| `conformance/harness.html` | `<pre>` での JSON 表示のみ(コピー/ダウンロード無し) | `<textarea id="result-json">` + 「結果をコピー」「結果をダウンロード」ボタンを追加(`conformance/harnessMain.ts`)。`runOnePlan`/`runAll`(digest 計算・突合ロジック)は無改変。`e2e/conformance.spec.ts` は `window.__CONFORMANCE_RESULTS__` のみを読むため無影響(全111件 pass 確認済み) |

3ページとも `button { min-height: 44px }` をボタンへ適用(GDD §6.6 の最小タップ領域。`bench/tags.html` の判読ボタンは T13 時点で既に対応済みだったが、コピー/リセットボタンは対応漏れがあったため同時に揃えた)。3ページとも light 固定を維持(新規CSSでも `prefers-color-scheme` 分岐は書いていない)。

### 14-4. 配信手段 × 計測項目の可否マトリクス(結論)

詳細と実施手順は `docs/measurements/device-testing-guide.md` §1/§2 参照。要点のみ:

- `measureUserAgentSpecificMemory()` と高分解能タイマは `crossOriginIsolated` を要求し、これは「secure context」+「COOP/COEPヘッダ」の両方が要る。`file://` はヘッダという概念自体が無いため常に `false`、LAN の `http://192.168.x.x` は secure context ですらないため常に `false`。
- **isolation を得られる経路は3つ**: (a) Android の USB ポートフォワード経由 `http://localhost:PORT`(`bench/vite.perf.config.ts` が既に COOP/COEP を設定済み。iOS には Windows から使える同等手段が無い)、(b) Cloudflare Workers 静的アセットへの https 配信(`_headers` ファイルでヘッダ設定。全デバイス対応だがデプロイ作業が要る)、(c) 計測対象PC自身で `vite preview` を開く(Surfaceが計測用PCそのものの場合のみ)。
- iOS Safari は経路によらず `measureUserAgentSpecificMemory` が存在しないため #2 は常に計測不可(先行計測計画 §6.3 の既定方針どおり)。
- #9b(`tags.html`)と #7 補完(`harness.html`)は IndexedDB も isolation も使わないため、`file://` 直接オープンで要件を満たす。#1/#8(`perf.html`)は `file://` でも動作するが、1ms未満の区間はタイマ分解能の粗さで正確に測れない(実機は desktop よりずっと遅いため、実際に1ms未満に収まる区間は少ないと想定される)。

### 14-5. スモークテスト

新規 `bench/deviceSmoke.spec.ts` + `bench/playwright.device.config.ts`(Chromium・`page.goto("file://...")`、webServer を起動しない。既存の `playwright.config.ts`(#7・3エンジン)/`bench/playwright.perf.config.ts`(#1/#2・webServer経由)には一切触れていない)。`npm run device:smoke` で実行し、3件とも pass:

1. `tags.html`: 凡例7件・格子48セル描画、判読テスト1件回答で結果JSON更新、外部ネットワークアクセスなし。
2. `harness.html`: 37本の golden vector が全て `ok`、外部ネットワークアクセスなし。
3. `perf.html`: `?autorun=1` で完走し `meta.crossOriginIsolated=false` / `memory.supported=false`(`unsupportedReason: "not-cross-origin-isolated"`) / `judgement.isOfficialVerdict=false` という想定どおりの縮退を確認、`worker.route="worker-draft-snapshot"` で Blob URL 化した Worker 経路も機能、外部ネットワークアクセスなし。

既存の `npm run bench:perf:e2e`(2件)・`npm run conformance:e2e`(111件)は本タスクの変更後も全件 pass を確認済み。`npm test`(vitest、`tests/tools/packageDevice.test.ts` の新規14件を含む)は850件全pass。`npm run typecheck`/`npm run lint`/`npm run format` も全クリーン。

### 14-6. 迷った点・未検証のまま持ち越した点

1. **Android の USB ポートフォワード経由での `crossOriginIsolated` 有効化は未検証**(理論上は localhost の secure context 特例 + ヘッダ透過で成立するはずだが、実機での確認は行っていない)。
2. **iOS Safari の `file://` での IndexedDB / Web Worker 挙動は未検証**。デスクトップ Chromium(headless/headed とも)では正常動作を確認済みだが、iOS 実機の挙動は本タスクのスコープ外(実機入手後に確認)。
3. **GCポーズ(#2後半)は実機で自動収集する手段が無い**(CDP は Chromium かつ Playwright/DevTools 経由が前提)。実機計測ガイドはデスクトップ実測値(§13-4: 最大0.429ms、予算50msに対し2桁の余裕)を代替値として扱う方針を提案するに留めた(ADR側の判断基準変更を伴うため確定はユーザー承認事項・T16判断)。
4. **Cloudflare Workers への一時デプロイは実行していない**(アカウント作業のためユーザー側。`docs/measurements/device-testing-guide.md` §10 にコマンド例のみ記載。`_headers` ファイル構文と `wrangler.toml` の `[assets]` 構成は Cloudflare 公式ドキュメント(`developers.cloudflare.com/workers/static-assets/headers/` 等)で確認済み)。
