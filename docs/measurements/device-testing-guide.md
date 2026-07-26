# 実機計測 実施手順書(#1 / #2 / #7実iOS補完 / #8 / #9b)

作成日: 2026-07-27 / 対象: iPhone SE2・Android 中位機・8GB Surface での実機計測
根拠文書: `docs/先行計測計画_ドラフト.md` §6/§7(実機計測の区分・接続手段・iOS制約) / `docs/design/perf-boundaries.md`(計測境界の正・T14 実施記録)

**この手順書は「実機で結果 JSON を回収するまで」を担う。** 回収した JSON を golden vector と突き合わせて合否判定する作業(K 校正・#7 の bit 一致確認・工数再計算)は次フェーズ(計画書 T16)の担当であり、この手順書の対象外。

**対象読者**: 開発環境(Windows PC・Node.js)に詳しくない人でも、書かれた手順をそのまま実行すれば計測ページを開いてボタンを押し、結果を送り返せることを目指す。ただし「本格計測」節と「Cloudflare Workers デプロイ」節は多少の技術知識(USBデバッグ・コマンド実行)を要するため、エンジニアと一緒に行うことを想定する。

---

## 0. 全体像

計測したいのは次の5項目。

| # | 何を測るか | 使うページ |
|---|---|---|
| #1 | オフライン復帰2秒予算(4区間: restore/compute/hydrate/mount) | `perf.html` |
| #2 | ヒープ増分ピーク・GCポーズ | `perf.html`(ヒープのみ。GCポーズは自動収集不可・§8参照) |
| #7 補完 | golden vector が実 iOS Safari でも Chromium/Firefox/WebKit と完全一致するか | `harness.html` |
| #8 | Worker 越しの state 転送コスト | `perf.html`(#1 の結果に内訳として含まれる) |
| #9b | タグ記号がピンチ縮小でどこまで判読できるか | `tags.html` |

この3ページはすべて `npm run device:package` で **外部ファイルへの依存が一切ない単一 HTML** として `dist/device/` に書き出される(`index.html` も含めて4ファイル)。実機のブラウザで直接ファイルを開ける(インターネット接続不要)ため、「まず file:// で試す」が全デバイス・全ページ共通の第一手順になる。

ただし **#2(ヒープ増分)だけは file:// では原理的に測れない**(後述§1)。#1/#8 も file:// では「タイマの分解能が粗くなる」制約があるが、動作自体はする。

---

## 1. なぜ配信方法で結果が変わるのか(先に読む)

`performance.measureUserAgentSpecificMemory()`(#2 のヒープ計測 API)と高分解能タイマは、ブラウザの `crossOriginIsolated`(通称「隔離」)状態が `true` であることを要求する。`crossOriginIsolated` が `true` になる条件は次の**両方**:

1. **secure context**(`https://` または `http://localhost` / `http://127.0.0.1`。`file://` も secure context 扱いだが後述の理由で不十分)
2. サーバーが `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` の**2つの応答ヘッダ**を返している

`file://` で直接開いた場合、ブラウザは secure context ではあるが**応答ヘッダというもの自体が存在しない**(ローカルファイルにはHTTPヘッダが無い)ため、条件2を満たせず `crossOriginIsolated` は常に `false` になる。同様に **同一LAN上の `http://192.168.x.x`(`vite dev --host` 等)は secure context ですらない**ため、たとえヘッダを追加しても `crossOriginIsolated` は `true` にならない。

この制約を回避できる経路は3つだけ:

- **`http://localhost`(その端末自身のブラウザから見た localhost)+ ヘッダ設定済みサーバー** — Android の USB ポートフォワード経由がこれに該当(§3.2)。iOS には同等の手段が無い(Windows からは Web Inspector 接続不可のため)。
- **`https://` の実配信**(Cloudflare Workers 静的アセット等)+ ヘッダ設定 — 全デバイスで使えるが、デプロイという追加作業が要る(§6)。
- 同一 PC 上で `vite preview` を直接開く(Surface が計測用に使っている PC そのものである場合のみ)。

**iOS Safari は上記のいずれの経路でも `measureUserAgentSpecificMemory` 自体が存在しない**(Chromium 系専用 API・先行計測計画 §6.3)ため、#2 は iOS では**常に計測不可**。iOS では「計測不可」という結果 JSON が出ることそのものが正しい結果であり、エラーではない。

---

## 2. 配信手段 × 計測項目 の可否マトリクス

| 配信手段 | secure context | ヘッダ設定 | `crossOriginIsolated` | 対応デバイス | 追加作業 |
|---|---|---|---|---|---|
| (A) `file://` 直接開く(`dist/device/*.html` を端末にコピーして開く) | ○ | ✕(不可能) | 常に `false` | iPhone SE2 / Android / Surface 全て | ファイルを端末に送るだけ |
| (B) 同一LAN `http://192.168.x.x`(`vite dev --host`) | ✕ | ○(vite側で設定可) | ✕(secure contextでないため無効) | 全て | PC とスマホが同じWi-Fiにいるだけ |
| (C) USB ポートフォワード → `http://localhost:PORT` | ○(localhostは特例) | ○(`bench/vite.perf.config.ts` が既に設定済み) | **○** | **Android のみ**(`chrome://inspect`)。iOS は Windows から Web Inspector 接続不可 | USBケーブル + Chrome DevTools 操作 |
| (D) Cloudflare Workers 静的アセットへ https 配信 | ○ | ○(`_headers` ファイルで設定) | **○** | 全て | アカウント作成・`wrangler deploy`(§6) |

**計測項目ごとの推奨経路**:

| # | 推奨経路 | 理由 |
|---|---|---|
| #9b(tags.html) | **(A) file:// で十分** | IndexedDB も isolation も使わない純粋な DOM/SVG ページ。配信方法による結果の差は無い |
| #7補完(harness.html) | **(A) file:// で十分** | IndexedDB も isolation も使わない(content は埋め込み済み)。実機の JS エンジンで golden vector を計算できれば目的達成 |
| #1(compute/restore/hydrate/mount) | まず **(A)** で概算値を取り、可能なら **(C)(Android)/(D)(全機種)** で高分解能タイマの値も取る | (A) でも4区間の値自体は出る(桁が粗いのは 1ms 未満の区間だけ。実機は desktop よりずっと遅いので 1ms 未満に収まる区間は少ないはず) |
| #2(ヒープ増分) | **(C) または (D) が必須**(Android)。**iOS は経路によらず計測不可** | isolation が無いと API が使えず `unmeasured` になる(エラーではなく正しい縮退) |
| #8(Worker転送) | #1 と同じ(perf.html の結果に含まれる) | 同上 |

---

## 3. 準備(PC 側で1回だけ)

1. プロジェクトのルートで次を実行する。

   ```
   npm run device:package
   ```

2. `dist/device/` に4つのファイルができる: `index.html`(入口ページ)・`perf.html`・`tags.html`・`harness.html`。いずれも単体で完結しており、他のファイルを一緒に送る必要はない。
3. 生成物のサイズ目安: `perf.html` 約117KB、`harness.html` 約122KB、`tags.html` 約41KB、`index.html` 約3KB(いずれもメール添付・クラウドドライブで問題ないサイズ)。

### 3.1 ファイルを実機へ送る方法(どれか1つでよい)

- **クラウドドライブ**(Google Drive / OneDrive 等): PCで4ファイルをアップロード → 実機のドライブアプリでダウンロード。iPhone/Android どちらでも最も手堅い。
- **メールに添付**: 自分宛てに送り、実機のメールアプリから開く。
- **USBケーブルで直接コピー**: Android は Windows Explorer からドラッグ&ドロップで直接コピーできる。iPhone は標準では直接コピーできないため上記2つを推奨。

### 3.2 本格計測(isolation あり)が必要な場合の追加準備 — Android のみ

#2(ヒープ増分)を Android で測る場合、file:// では測れないので次を行う。

1. Android 端末の「開発者向けオプション」→「USBデバッグ」を有効化する。
2. Android 端末と PC を USB ケーブルで接続する(端末側で「このパソコンを信頼しますか」的な確認が出たら許可する)。
3. PC の Chrome で `chrome://inspect/#devices` を開き、端末が一覧に出ることを確認する。
4. 同じ画面の「Port forwarding...」設定で、`localhost:4320` → `localhost:4320` の対応を追加する(ポート番号 4320 は `bench/vite.perf.config.ts` が固定で使うポート)。
5. PC 側でプレビューサーバーを起動する。

   ```
   npm run bench:perf:build
   npm run bench:perf:preview
   ```

6. Android 端末の Chrome で `http://localhost:4320/perf.html` を開く。USB 経由で PC のサーバーへ転送され、`localhost` 扱いのため isolation が有効になる(想定。**実機での最終確認は未実施**)。
7. 終わったら USB デバッグを無効化してよい。

iOS には Windows から使える同等の手段が無い(Safari Web Inspector は macOS 必須・先行計測計画 §6.1 (c')。plan `docs/先行計測計画_ドラフト.md` の既定方針どおり)。iOS で #2 以外を本格計測したい場合、または Surface が計測対象そのものではなく別 PC で `vite preview` を直接開ける場合は §6 の Cloudflare Workers デプロイを使う。

---

## 4. 実機ごとの手順

### 4.1 iPhone SE2(Safari)

1. §3.1 の方法で `perf.html`・`tags.html`・`harness.html`(と `index.html`)をiPhoneに送る。
2. 「ファイル」アプリで受け取ったファイルを開き、共有アイコン →「Safariで開く」を選ぶ(またはファイルをタップして開いたプレビュー画面から共有 →「Safariで開く」)。**手順はiOSのバージョンによって多少異なる場合がある**。
3. Safari で開いたら §5 の操作手順に従って各ページを実行する。
4. #2(ヒープ増分)は iOS では常に「計測不可」と表示される。これは正しい結果であり、iPhone側の問題ではない(§1)。
5. #1/#8 は file:// のまま計測してよい(iOS で isolation を得る手段が無いため、これが実質的に最善)。もしどうしても isolation ありの値が必要な場合は §6 の Cloudflare Workers デプロイを使う(その場合でも #2 は計測不可のまま)。
6. **未検証の注意**: iOS Safari で file:// 起点の IndexedDB・Web Worker がどこまで正常に動くかは、本チームでは実機で確認していない(開発環境の Windows + Chromium でのみ確認済み)。`perf.html` を開いてエラー表示のまま止まる場合は、その旨を結果と一緒に報告してほしい(§7 のトラブルシューティングも参照)。`tags.html`/`harness.html` は IndexedDB も Worker も使わないため、この心配はない。

### 4.2 Android 中位機(Chrome)

1. §3.1 の方法でファイルを送る(USB 直接コピーが最も簡単)。
2. Chrome でファイルを開く(ダウンロードフォルダから、またはファイルアプリの共有メニューから「Chrome」を選ぶ)。
3. `tags.html`・`harness.html`・`perf.html`(概算値)は file:// のままでよい。
4. #2 を測りたい場合は §3.2 の USB ポートフォワード手順を行ってから `http://localhost:4320/perf.html` を開く。

### 4.3 8GB Surface(Chrome / Edge)

Surface が**計測用に個別に用意された端末**(開発機とは別のPC)である前提で書く。

1. §3.1 のいずれかの方法(クラウドドライブが簡単)でファイルを送る。ブラウザで直接ファイルを開けば file:// 計測が完了する(`tags.html`/`harness.html` はこれで十分。`perf.html` も概算値が取れる)。
2. #2 を含む本格計測をしたい場合、Surface で Node.js が使える(または USB メモリ等でリポジトリ一式をコピーできる)なら、Surface 上で直接

   ```
   npm run bench:perf:build
   npm run bench:perf:preview
   ```

   を実行し、Surface 自身のブラウザで `http://localhost:4320/perf.html` を開く(自分自身への接続なので localhost = secure context + ヘッダ設定済みで isolation が有効になる)。
3. Node.js のセットアップが難しい場合は §6 の Cloudflare Workers デプロイを使う(https 配信なので Surface はブラウザで URL を開くだけでよい)。

---

## 5. 各ページの操作手順

### 5.1 `perf.html`(#1 / #2 / #8)

1. ページを開くと「計測を開始する」ボタンが1つだけある。**これを1回押すだけ**。
2. 計測は自動で進む(ウォームアップ1回 → 計測10回 → save サイズ感度計測 → メインスレッド比較計測、の順)。ページ内のステータス表示が進捗を示す。
3. 完了すると画面上部に表 (B1〜B4 各区間の中央値・予算・判定) が出て、下に結果 JSON が表示される。
4. 「結果をコピー」でクリップボードにコピー、または「結果をダウンロード」で `.json` ファイルとして保存できる(§6 のファイル回収参照)。

### 5.2 `tags.html`(#9b)

1. ページ上部の「タグ7種 凡例」と「6×8格子デモ + ズームスライダ」は判読テストの前に一度眺めておくとよい(どの記号がどのタグかの説明)。
2. 「3. 判読テストモード」まで下にスクロールする。表示された記号1つに対し「判読できた」または「判読できない」ボタンを押す(**44px角の大きなボタン**なので指でも押しやすい)。
3. これを42回(6サイズ×7タグ)繰り返す。**画面の指示に従うだけで自動的に次の試行へ進む**。
4. 途中で間違えた/やり直したい場合は「最初からやり直す」を押す。
5. 全42試行が終わると完了メッセージが出て、下に結果 JSON が表示される。「結果をコピー」または「結果をダウンロード」で回収する。
6. **ピンチ縮小との関係**: このページの判読テストは記号のサイズを段階的に小さくして表示する形式であり、ピンチ操作そのものは不要(ズームスライダは「2. 6×8格子デモ」セクションの確認用)。もし実機で実際にピンチジェスチャーによる縮小体験も記録したい場合は、ブラウザの拡大縮小(ピンチ)操作で画面全体を縮小しながら「2. 格子デモ」がどこまで判読できるかを目視確認し、その所感を結果JSONと合わせて自由記述で報告してほしい(この自由記述部分はJSONの外)。

### 5.3 `harness.html`(#7 実 iOS Safari 補完)

1. ページを開くと**自動的に**全 golden vector(37本)が計算され、数秒以内に表とJSONが表示される。押すボタンは無い。
2. 表の `status` 列が全て `ok` になっていることを確認する(`error` があれば §7 トラブルシューティング参照)。
3. 「結果をコピー」または「結果をダウンロード」で結果 JSON を回収する。

---

## 6. 結果 JSON を PC へ送る方法

各ページの「結果をコピー」「結果をダウンロード」いずれかで結果を取得したら、次のいずれかで開発担当者(PC)へ送る。

- **コピーした場合**: メモアプリ/メール下書き/チャットアプリ(Slack・LINE等)に貼り付けて送信する。
- **ダウンロードした場合**: 端末のダウンロード先(iOSは「ファイル」アプリ、Androidは「ダウンロード」フォルダ)にある `kept-flame-perf-*.json` / `kept-flame-tags-*.json` / `kept-flame-harness-*.json` を、メール添付・クラウドドライブ・チャットアプリのファイル送信のいずれかでPCへ送る。

ファイル名には生成時刻が入っているので、複数回計測した場合も区別できる。**1端末につき最低1回ずつ、3ページ分の結果JSONを送ってもらえば十分**。

---

## 7. 期待される所要時間

| 作業 | 目安時間 | 備考 |
|---|---|---|
| ファイルを実機に送る(§3.1) | 2〜5分 | クラウドドライブ経由なら1回のセットアップで以降は速い |
| `tags.html` の判読テスト(42試行) | 5〜10分 | 1試行あたり目視+タップで数秒 |
| `harness.html` | 1〜2分 | 計算は数秒、確認とコピー操作の時間 |
| `perf.html`(file://・概算) | 1〜3分 | ウォームアップ+22試行(計測10+saveサイズ感度10+メインスレッド比較10前後)。実機はdesktopより遅いためデスクトップ実測(概算1秒未満)より数倍〜数十倍かかる可能性がある(未実測) |
| Android の USB ポートフォワード設定(§3.2、初回のみ) | 5〜10分 | 2回目以降は手順4〜6のみで数分 |
| 結果JSONの送付(3ページ分) | 3〜5分 | |
| **1端末あたり合計目安** | **20〜35分**(本格計測込みで+10分) | 複数端末は並行実施可能 |

---

## 8. 判断基準の数値表

実機の値を見るときの参考値(正本は `docs/design/perf-boundaries.md` §1・ADR-012(4)・ADR-029(1))。

| # | 指標 | 基準値 | 結果JSON内の場所 |
|---|---|---|---|
| #1 | B2 restore(IDB読出+検証+parse+復元) | ≤450ms | `intervals.restore.medianMs` |
| #1 | B1 compute(72h catch-up、Worker往復込み) | ≤1100ms | `intervals.compute.medianMs` |
| #1 | B3 hydrate(state→表示用データ) | ≤250ms | `intervals.hydrate.medianMs` |
| #1 | B4 mount(240 DOM生成+レイアウト) | ≤200ms | `intervals.mount.medianMs` |
| #1 | 合計 | ≤2000ms | `judgement.desktopRaw.totalMs` |
| #2 | ヒープ増分ピーク | ≤48MB | `memory.peakDeltaMb`(iOSは常に`null`、Androidでも isolation 無しなら`null`) |
| #2 | GCポーズ | ≤50ms/回 | perf.html には含まれない(`bench/gcTrace.spec.ts` が Chromium DevTools Protocol 専用で取得する値。**実機では自動収集できない**。この項目は実機計測の対象外とし、デスクトップ実測値(§13-4 参照)を代替とする) |
| #7 | golden vector 一致 | 完全 bit 一致(`stateDigest` 等が `conformance/vectors/*.json` の `expected` と一致) | `harness.html` の結果JSON全体。実機側では自動突合しないため、回収後に開発側で目視/ツール突合する |
| #9b | 判読可能な最小サイズ | 参考値: 種別同定下限12px・存在認識下限9px(`docs/design/tags-spec.md`の設計目標) | `tags.html` 結果JSONの `minLegibleSizePx`(全7種が判読できた最小サイズ。null なら44pxでも判読できなかった種がある) |

**`perf.html` の結果を読むときの重要な注意**: JSON内の `judgement` には `desktopRaw`(係数1倍・素の実測)と `withProvisionalK`(係数5倍・デスクトップ実測を実機相当に見積もる暫定値)の2種類があるが、**これは「デスクトップで測ってK倍して実機を推測する」ためのフィールド名であり、実機で直接測った今回は `desktopRaw`(=係数1倍=生の実測値)をそのまま実機の値として読めばよい**。`withProvisionalK` は無視してよい。また `judgement.isOfficialVerdict` は常に `false` と出るが、これは「このページ単体では合否を確定しない」という設計上の固定値であり、実機で計測した値がこの手順書の基準を満たしていれば、その旨をT16の判定担当者へ伝えれば正式な合否判断の材料になる。

---

## 9. 既知の制約(正直な一覧)

- **iOS Safari はヒープ計測が不可能**(`performance.measureUserAgentSpecificMemory` が存在しない。Chromium系専用API)。配信方法を変えても解決しない。#2 は Android の実測 + iOS 側は「クラッシュしないか」の間接指標のみ(先行計測計画 §6.3)。
- **LAN の `http://192.168.x.x` は secure context にならない**ため、`vite dev --host` のような手軽なLAN共有では isolation が有効にならない。COOP/COEPヘッダを足しても無意味(§1)。
- **`file://` では応答ヘッダという概念自体が存在しない**ため、isolation は原理的に有効にならない。#2 は file:// では常に `unmeasured`。
- **Playwright の WebKit ≠ 実 iOS Safari**(`docs/先行計測計画_ドラフト.md` §7)。3エンジン(Chromium/Firefox/WebKit)一致は Windows 上で既に確認済み(計測#7・37本すべて bit 一致)だが、これは「JavaScriptCore系統との一致」を保証するに過ぎず、実 iPhone の Safari で `harness.html` を開いて確認するまでは #7 は完了しない。
- **GCポーズ(#2後半)は実機で自動収集できない**。Chrome DevTools Protocol(CDP)経由のトレース取得はPlaywright/デスクトップChromeの機能であり、実機のブラウザ単体では同等の値が取れない。この項目はデスクトップ実測(`docs/design/perf-boundaries.md` §13-4: 最大0.429ms、予算50msに対し2桁の余裕)を代替値として扱う方針を提案する(要ユーザー承認)。
- **iOS の file:// での IndexedDB / Web Worker 動作は未検証**(§4.1参照)。Android/Windows Chromiumでは file:// でも正常動作を確認済み(本タスクで実施したスモークテスト)。
- **Android の USB ポートフォワード経由での `crossOriginIsolated` 有効化は未検証**(§3.2)。localhostがsecure context扱いになることと、ポートフォワードがHTTPヘッダをそのまま透過することの組み合わせで理論上は成立するはずだが、実機での確認は行っていない。
- **#9b の判読テストは42試行がやや長い**。回答疲れで後半が雑になる可能性があるため、複数人での実施や休憩を挟むことを推奨する(手順書としての制約というより実施上の注意)。

---

## 10. Cloudflare Workers への一時デプロイ手順(本格計測用・任意)

**この節の実行はユーザー(アカウント保有者)の作業であり、本タスクでは実行していない。** Cloudflare アカウントの作成・ログイン・課金設定(無料枠内で足りる想定だが最終確認はユーザー側)はユーザー自身が行うこと。以下はコマンド例の提示のみ。

これは ADR-025 が定める本番の stable/beta 配信パイプライン(`kept-flame-stable` / `kept-flame-beta`)とは**別物の、計測専用の一時的なデプロイ**である。`dist/device/` の4ファイルをそのまま静的アセットとしてホストするだけの最小構成でよい。

### 10.1 ヘッダ設定ファイルを追加する

`dist/device/_headers` という名前のファイル(拡張子なし)を作り、次の内容にする(Cloudflare Workers 静的アセットは `_headers` ファイルを解釈してレスポンスヘッダを設定する)。

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

### 10.2 最小構成の `wrangler.toml` を用意する(`dist/device/` とは別の作業フォルダに置く例)

```toml
name = "kept-flame-device-measure"
compatibility_date = "2026-07-24"

[assets]
directory = "./dist/device"
```

### 10.3 デプロイコマンド例(実行しない・提示のみ)

```
npx wrangler login
npx wrangler deploy
```

- `wrangler login` は初回のみ必要で、ブラウザが開きCloudflareアカウントでの認証を求められる(**ユーザー本人のアカウント操作**)。
- `wrangler deploy` を実行すると `https://kept-flame-device-measure.<アカウント固有のサブドメイン>.workers.dev` のようなURLが払い出される。このURLを実機のブラウザで開けば、全項目(#2含む)が本格計測できる。
- 計測が終わったら `npx wrangler delete` 等でこの一時プロジェクトを削除してよい(本番の stable/beta 環境には影響しない、完全に独立したプロジェクトのため)。

---

## 11. トラブルシューティング

| 症状 | 対処 |
|---|---|
| `perf.html` の「計測を開始する」を押しても進まない/エラーが出る | 結果JSONが出ていなくても、ページのステータス表示の文言(例:「Worker が例外で停止した」)をスクリーンショットして報告する。file://での実行なら §6(Cloudflare)経由で再試行してみる |
| `harness.html` の表に `error` がある行がある | その行の内容(vectorId とエラーメッセージ)をそのまま報告する。他の行が `ok` なら部分的な結果として有用 |
| コピーボタンを押しても反応が無い / 「コピー失敗」と出る | テキストエリアが自動選択された状態になるので、手動でコピー(長押し→コピー)してから送る |
| ダウンロードボタンを押しても保存先が分からない | iOSは「ファイル」アプリの「ダウンロード」フォルダ、Androidは通知欄からアクセスできる「ダウンロード」フォルダを確認する |
| `chrome://inspect` に端末が出てこない(§3.2) | USBケーブルを変える(充電専用ケーブルでないか確認)、端末側の「このパソコンを信頼」ダイアログを確認、Chromeを再起動する |
| Cloudflare デプロイでエラーが出る | アカウント設定(ログイン・支払い方法登録の要否)を確認する。**この節はユーザー作業のため、詳細なトラブル対応は都度エンジニアと相談する** |

---

## 12. 検証記録(本タスク内での確認事項)

`npm run device:package` の生成物を Playwright chromium で `file://` 直接開き(`bench/deviceSmoke.spec.ts` / `npm run device:smoke`)、次を確認済み(Windows + Chromium。実機での確認ではない点に注意):

- `tags.html`: 凡例7件・格子48セルが描画され、判読テストへの回答で結果JSONが更新される。外部ネットワークアクセスなし。
- `harness.html`: 37本の golden vector が全て `ok` で計算される。外部ネットワークアクセスなし。
- `perf.html`: `?autorun=1` で最後まで完走し、`meta.crossOriginIsolated=false` / `memory.supported=false`(`unsupportedReason: "not-cross-origin-isolated"`) / `judgement.isOfficialVerdict=false` という**想定どおりの縮退**を確認。Worker 経路(`worker-draft-snapshot`)も機能している。外部ネットワークアクセスなし。

既存の `npm run bench:perf:e2e`(webServer 経由・isolation あり)・`npm run conformance:e2e`(3エンジン)は本タスクの変更後も全件 pass することを確認済み(コピー/ダウンロードUIの追加は additive で、計測境界・digest計算には触れていない)。
