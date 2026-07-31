# 継ぐ火 技術設計書(第3版)

## 検討履歴

6観点(決定論・正確性 / 性能・メモリ / セキュリティ・運営 / UI・アクセシビリティ / アーキテクチャ / CI・運用)× 2ラウンドのレビューを実施。ラウンド1(第2版レビュー)で fatal 4件・major 多数を、ラウンド2(最終レビュー)で fatal 4件・major 28件を検出し、いずれも曖昧化せず決定・数値・構造の変更で回答して本第3版に統合した(最終ラウンドで構造的にゼロ化不能と判明した限界は「残余リスク」へ正式統合)。

---

## 全体アーキテクチャ概要

「継ぐ火」の技術基盤は、**決定論エンジンを唯一の真実(single source of truth)とし、UI・sim・replay・運営ゲートが同一エンジンを import する**ヘキサゴナル志向の4レイヤー構成を採る。依存は内向き一方向。

```
ui  ─┐
sim ─┼─▶ platform-adapters ─▶ engine ◀── content(JSON)
replay ┘                         ▲
                            (依存は内向き一方向のみ)
```

第2版レビューの fatal・major に対する核となる構造改訂:

1. **決定論の権威をソーステキスト hash から観測挙動(golden vector)へ移す** — `algoVersion` bump の必要十分条件を「golden vector が変化すること」と定義し、manifest hash は正準化後の助言的 tripwire へ格下げ(ADR-016)。
2. **週次 content が実際に踏む CI 本線にクロスブラウザ conformance(Chromium/Firefox/WebKit)を beta ソーク前ゲートとして結線** — Node sim = ブラウザ bit 一致を content 単位で毎週機械検証(ADR-017)。
3. **content ロード時に全 JSON を再帰安定ソートする単一正準化パスを強制** — キー順序依存を構造的に無効化し、ファイル削除/ID 抹消をグローバル ID 集合比較で reject(ADR-023)。
4. **`mulFix` の中間積オーバーフローを除算前にガードし、Math 許可リストを ECMA-262 精度対照表で確定**(ADR-006)。
5. **PRNG を 64bit carry を持つ SplitMix64 int32 ペアから純 uint32 の xoshiro128\*\* へ変更**して carry バグ階級を消去。RNG ドメインタグをレジストリ + lint で一意強制、探索分岐は `branchId`/`choiceKey` を salt へ必須化(ADR-007/024)。
6. **ソロ運営の CODEOWNERS 自己承認デッドロックを bot 作成 PR + human 承認の二役分離で解消**(ADR-030)。
7. **性能を数値確定** — 2秒復帰予算の ms 配分、GC/ヒープ/ポーズ予算、IDB 絶対フラッシュ、adjacency computed の O(近傍)上界、catch-up の可変ドラフトによるアロケーション有界化、夜間 sim シャード数の実測校正導出と同時実行20上限整合(ADR-012/014/029)。
8. **未規定だった実装方式を各々単一正準実装/数値/構造で確定** — 構造共有・Map↔JSON 往復・foreground tick 駆動・ルーティング・タグ色覚対応・sunset 旧版退役・stable/beta 昇格・ヘルスビーコン認証(ADR-002/026/027/028/003/025/031/022)。

**engine 純粋性**(DOM / Date / Math.random / Promise / Math 非許可関数 / localeCompare / 生スプレッド / レジストリ外 domainTag / content 直接走査 の禁止)は、lint と決定論ゲートで機械強制する不変条件として維持する。

---

## ADR 一覧

### ADR-006(改訂) 固定小数点1e6:中間積オーバーフローを除算前にガード + Math 許可リストを ECMA-262 精度表で確定

**決定**
`mulFix` の事後 `2^53` assert では中間積 `a*b` の丸めを検出できない欠陥を修正する。`mulFix(a,b)` は、(1) 中間積 `a*b` が `2^53` を超えうる値域(dev/test で `|a*b| >= 2^53` を**除算前に**別途 assert、本番は累算器で saturating 検知)、または (2) 値域証明で `a*b < 2^53` が保証できない全経路、について **BigInt 中間積を必須**とする。`number` 直演算は「`a*b` が double 整数精度限界 `2^53` 未満」と ADR 不変条件レビューで静的に証明できた式のみに限定し、証明対象を各式の spec に明記する。`floorDivFix` は従来通り符号 floor 補正。
Math 超越関数の許可リストを具体名で確定し、engine 内で許可リスト外の Math 呼び出しを lint 禁止する。`1.2^n`/`1.15^Lv` はオーサリング時個別 FP 値展開(GDD 11.7)を維持し実行時べき乗を根絶する。許可リスト表:

| 関数 | ECMA-262 精度規定 | 採否 |
|---|---|---|
| `Math.abs` / `sign` / `floor` / `ceil` / `round` / `trunc` / `max` / `min` | exact(正確結果を規定) | 採用 |
| `Math.imul` | exact(ToInt32 変換後の32bit整数乗算を厳密規定、丸め誤差なし) | 採用。**[2026-07-25改訂]** Math.imulを許可リストへ追加(ユーザー承認済み)。根拠: ECMA-262で厳密規定の整数演算。ADR-007との矛盾解消 |
| `Math.sqrt` | correctly-rounded | 原則不使用。整数演算で代替可能な限り避け、必要時は整数ニュートン法(`isqrt`)を自前実装 |
| `Math.pow`(非整数指数) / `exp` / `log` / `log2` / `sin` / `cos` / `tan` / `atan2` / `cbrt` / `hypot` | implementation-approximated(エンジン間 ULP 差が仕様上許容・bit 不一致) | 禁止 |

**選択肢**
(a) 全 BigInt:遅い、却下。(b) 事後 `2^53` assert のみ(旧設計):中間積丸めを素通しする fatal で撤回。(c) 中間積(除算前)assert + 値域未証明経路は BigInt + Math 許可リスト精度表:**採用**。

**理由**
「事後 assert は壊れているケースの一部を通過させる(`a=1e9, b=1e12` スケールで `a*b~1e21` が ÷1e6 後も `<2^53` を満たし assert 通過)」および「許可リストの具体関数と ECMA-262 精度根拠が不在=運任せ検出」の2点に、除算前ガードと精度対照表で直接回答する。

**トレードオフ**
BigInt 中間積を要する式は速度低下(先行計測でホットパス該当式のみ値域証明して `number` 化)。許可リスト表の保守。`isqrt` 自前実装のテスト負担。

---

### ADR-007(改訂) PRNG を xoshiro128\*\*(純 uint32)へ変更し carry 桁上げバグ階級を構造的に消去 + RNG ドメイン構成の明示

**決定**
SplitMix64 の int32 ペア実装は 64bit 桁上げ(carry propagation)を伴い、差分テストが `2^64` 空間を網羅できず特定ビット境界の潜在バグが全確率系へ波及する欠陥があった。これを構造的に排除するため PRNG を **xoshiro128\*\*(Blackman/Vigna・パブリックドメイン参照実装)**へ変更する。全演算が uint32(`Math.imul` + `>>>0` + 回転)で完結し 64bit 加算の carry を一切持たない=carry 桁上げバグ階級そのものが存在しない。seed は splitmix32(32bit 版)で `worldSeed` から 4 語 state 展開。ドメイン分離 hash は FNV-1a-32(32bit)を維持。差分オラクル(参照実装との突合)は継続しつつ carry 境界テストは不要化し、代わりに「splitmix32 seed 展開の全 32bit 境界(`0x00000000`/`0xFFFFFFFF`/carry 無し)」の構造化テストを追加する。
RNG ドメイン構成を厳密定義: `hash(worldSeed, domainTag, salt...)`。探索は `domainTag='exploration'` かつ `salt=(dispatchId, nodeIndex, branchId, choiceKey)` を必須要素とし、撤退枝/強行枝・慎重/大胆が各々独立の counter 起点を持つ(ADR-012 連動)。分岐識別子を欠くと両枝が相関する欠陥を、`branchId`/`choiceKey` の salt 必須化で排除する。

**選択肢**
(a) Math.random/crypto:非決定、却下。(b) SplitMix64 int32 ペア:64bit carry バグ階級が残り差分テストで網羅不能、撤回。(c) xoshiro128\*\* 純 uint32 + splitmix32 seed:carry バグ階級を消去、**採用**。

**理由**
「int32 ペアの carry 境界バグがサンプリング網羅不能で全 seed に波及」に、64bit 演算を持たない生成器へ変更して問題の前提そのものを消去する形で回答。分岐 RNG 構成明示は「両分岐事前サンプリングのドメイン構成未定義で意図せぬ相関」への回答。

**トレードオフ**
xoshiro128\*\* は SplitMix64 と統計特性が異なる(ゲーム用途では十分)。`algoVersion=1` をこの生成器で確定(本実装前ゆえ移行不要)。splitmix32 seed 展開実装の参照一致確認が必要。

---

### ADR-024(新設) 決定論レジストリ:全カテゴリ横断 ID 一意性 + RNG ドメインタグ一意性を機械強制

**決定**
二つの一意性穴を単一のレジストリ機構で閉じる。
(1) **グローバル ID 一意性** — tech/trait/event/facility/recipe/raid/outpost/era 横断で全 content ID のグローバル一意を schema 検証段階で強制する。全 JSON をロードし ID 集合を構築、重複 ID は(同カテゴリ内 additive diff をすり抜けても)reject。`entityStateById` は単一 namespace ゆえカテゴリ間衝突がシャドーイングを起こす欠陥を排除。
(2) **RNG ドメインタグ一意性** — `domainTag` を自由文字列でなく `src/engine/rng/domainTags.ts` の frozen レジストリ(TS string-literal union 型 + 凍結配列)で集中管理する。engine 内でレジストリ外の文字列リテラルを RNG 入力に渡すことを lint 禁止(型でも弾く)。新タグ追加はこの人間専用ファイル改変を要し、重複は型/テストで即 reject。コピペ再利用で2確率系が同一ストリームを共有する欠陥(bit 再現性は保つが統計異常でしか間接検出されない)を発生源から排除。

**選択肢**
(a) 自由文字列 domainTag + 暗黙一意性期待(旧):再利用検知不能、却下。(b) カテゴリ内 ID 一意のみ:クロスカテゴリ衝突すり抜け、却下。(c) グローバル ID 集合検証 + domainTag レジストリ + lint/型強制:**採用**。

**理由**
「カテゴリ跨ぎ ID 一意性未規定でシャドーイング」「domainTag 一意性のレジストリ/lint/schema が不在で統計独立性が静かに崩れる」の2 major に、単一レジストリ設計で機械強制回答。

**トレードオフ**
新 domainTag/新カテゴリ追加時にレジストリファイル(人間専用・CODEOWNERS)更新が必要。グローバル ID 空間ゆえ命名衝突回避の運用規律(接頭辞規約 `tech_`/`trait_` 等)が要る。

---

### ADR-023(新設) content ロード時の再帰的正準化パス:JSON キー順序依存とファイル削除/リネームを構造的に無効化

**決定**
content-diff-gate はパース済みオブジェクト比較ゆえ原理的にキー順序に盲目で、整形ツールがキー順のみ変えた差分を「値不変」承認し、キー順に暗黙依存するコードがあれば sim 結果が誰にも検知されず変化する欠陥を修正する。対策を二重化:
(1) **正準化パス** — ビルド/ロード時に content バンドル全体を再帰的に安定キーソート(UTF-16 コードユニット順・ADR-010 準拠比較器)してから内部表現化する単一の `canonicalize.ts` を通すことを強制。キー順は入力 JSON の順に依存せず常に正準順=キー順序依存コードが存在しても結果不変。
(2) **lint 併用** — content 由来オブジェクトを `Object.keys()` / `for-in` / `Object.entries()` で直接走査する engine コードを全面 lint 禁止し、必ず正準化済み内部表現(Map / 明示ソート配列)経由に強制。ADR-008(2) の選択テーブルはこの正準化パスで網羅規則へ格上げ。
さらに content-diff-gate にグローバル ID 集合スナップショット比較(ADR-024)を追加し、**ファイル削除自体を独立チェック項目として全面 reject**(tombstone soft-delete のみ許可)。既存ファイル削除 + 別 ID 新ファイル追加による実質 ID 抹消/差替え、および ID 跨ぎリネームを旧 ID 消失として捕捉する。

**選択肢**
(a) content-diff-gate のみ(旧):キー順盲目・削除すり抜けで fatal、撤回。(b) 正準化パス + 走査 lint 禁止 + ID 集合削除検知:**採用**。

**理由**
「パース済み比較はキー順に原理盲目」「manifest hash は engine ファイル限定で反応せず」「ファイル削除 + 別 ID 追加が新規追加として通過」に、ロード時正準化で依存を無効化 + ID 集合比較で削除捕捉の二段で回答。

**トレードオフ**
正準化パスの実行コスト(ロード時一回・content 規模で軽微)。全 content 走査を内部表現経由に矯正する初期リファクタ。ID 集合スナップショットを base との比較用にリポジトリ保持。

---

### ADR-016(改訂) algoVersion を観測挙動(golden vector)にアンカーし、manifest hash は正準化後の助言的 tripwire に格下げ

**決定**
manifest source-text ハッシュはコメント/リネーム/空白でも無差別 bump 強制する一方、意味的に危険な変更を保証できず「安全なつもりの変更が旧セーブ未来 tick を変える」fatal が形を変えて残る欠陥を修正する。決定論の権威ゲートをソーステキストでなく観測挙動へ移す:
(1) `algoVersion` bump の必要十分条件を「**golden vector(代表 seed 群の N tick 後状態ハッシュ + 主要中間値)が変化すること**」と定義。CI で「golden vector が変化 ⟺ algoVersion bump」を機械強制(golden 差分あり + bump 無しは fail、逆も監査)。挙動を変えない編集は golden 不変ゆえ bump 不要=偽陽性 bump を排除。
(2) manifest hash は正準化後(TS コンパイラでコメント/空白除去・変数名は保持)のソースを hash する**助言的 tripwire に格下げ** — 決定論 critical ファイルが変更されたのに golden vector を再生成し忘れた事故を検知する二次警告に用途限定。権威は golden vector。

**選択肢**
(a) 生ソーステキスト hash を権威(旧):偽陽性 bump と「安全なつもり」の見逃しが両立、撤回。(b) golden vector 権威 + 正準化 manifest tripwire:**採用**。

**理由**
「テキスト hash は意味論的安全/危険を区別できず人間目視に委ねられ、解決したはずの fatal が残存」に、権威を観測可能な挙動へ移し、テキスト hash を補助に降格して回答。

**トレードオフ**
golden vector の代表 seed 被覆が不十分だと「golden 不変だが挙動変化」の死角が残る(seed 群を確率系・区間分類を踏むよう設計・拡充=open question)。golden 再生成コストは algoVersion 更新時のみ。

---

### ADR-025(新設) algoVersion sunset:旧版実装を凍結アーカイブビルドへ退役させライブレジストリを3世代にハード上限

**決定**
[2026-07-25改訂] 配信基盤はCloudflare Workers静的アセット(assets binding・SPAモード)に変更(ユーザー承認済み)。理由: 公式ブログが新規プロジェクトにWorkersを推奨しPagesへの機能投資終了を明言(https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/)。静的アセット配信はWorkersでも無料・無制限でWorkers無料枠10万req/日にカウントされない。これに伴い以下(2)の凍結アーカイブ方式は、退役版ごとに固定サブドメインを持つ個別Workerとしてデプロイする方式へ改める(Workersのバージョンプレビュー URL がPages同様に無期限保持されるかは未確認のため、確実な方式を採る)。
sunset(直近3世代のみ新規生成可)は新規セーブ生成を止めるだけで、非同意プレイヤーが居る限り旧 algoVersion の決定論バンドル全体実装をライブレジストリから退役できず無期限保守が残る欠陥を修正する。クライアント完結・バックエンド無しの特性を逆用:
(1) sunset 到達版の実装は HEAD のライブバンドルから**物理削除**しライブレジストリを最新3世代にハード上限。
(2) 退役版は Cloudflare Workers 静的アセットの個別 Worker(退役版ごとに固定サブドメインを割当て以後デプロイしない)として凍結保持 — 削除せず更新もしない静的資産。
(3) sunset 版セーブをロードした場合、現行ビルドは計算を拒否し「この周回は凍結ビルド(URL)で継続/エクスポートするか、同意して再シード移行するか」を提示。非同意プレイヤーは凍結ビルドで従来通り遊べる(現行コードは一切旧実装を抱えない)。強制でなく分離。

**選択肢**
(a) 同意ベース再シードのみ(旧):非同意者ゆえ旧実装を無期限ライブ保守、撤回。(b) 凍結アーカイブビルドへ退役 + ライブ3世代ハード上限:**採用**。

**理由**
「再シードは同意ベースで強制でなく、非同意者が居る限り旧バンドル全体を退役不能=sunset の実効性に疑義」に、ライブコードから旧実装を削除し静的凍結ビルドへ分離してライブ保守を3世代で厳密有界化する構造で回答。

**トレードオフ**
凍結アーカイブビルド群を無期限ホスト(Workers静的アセット無料・無制限ゆえ現金コストは実質ゼロだが、退役版ごとに個別Workerを作成・命名する運用が加わり、URL 管理と「どの版がどのアーカイブか」の対応表保守が残る)。非同意者はゲーム改善(新 content/新算法)を受けられない分岐に留まる。

---

### ADR-030(新設) ソロ運営のレビュー分離構成:bot 作成 PR + 本人レビューで CODEOWNERS デッドロックを解消

**決定**
GitHub 仕様上 PR 作成者の自己承認は必須レビュー数に加算されず、1人 + AI 運営で PR 作成者 = Code Owner が同一人物だと必須レビューを永久に満たせずブロック、逆に admin bypass を許すと人間レビュー機能が実質無効化する欠陥を修正する。二役分離を導入:
(1) **[2026-07-28改訂・ユーザー承認済み] bot identity は運営者本人アカウント配下の GitHub App(`kept-flame-bot`)とする**(専用 bot アカウント+PAT 方式から変更)。変更理由: ①fine-grained PAT は「リソースオーナー」方式のため、別アカウントの bot からは他人所有リポジトリ(`kept-flame`)に対して発行できない(GitHub 公式の既知ギャップ。classic PAT への格下げしか回避策がない) ②新規アカウント作成・メール・2FA・90日ローテーションの運用が丸ごと不要になる ③インストールトークンは寿命1時間の短命資格情報で、権限を Contents / Pull requests の Read-write 2種+`kept-flame` 単一リポジトリに絞れる=ADR-021 の最小権限方針とより整合する。
(2) 週次 content の PR は GitHub App(`kept-flame-bot[bot]`)が作成し、運営者本人(human)がその PR の CODEOWNERS レビュアーとして承認する — 作成者(bot)≠ 承認者(human)ゆえ必須レビュー1件が正当に成立し、admin bypass を使わずブランチ保護を維持。
(3) 週次セッションの Claude Code はローカルで content を生成し、**ローカル保管の App 秘密鍵(.pem・リポジトリ外・Actions secrets に置かない)から Node 組込み crypto で JWT を署名 → インストールトークンを取得 → push/PR 化**するスクリプト経路を用意(Anthropic API キーは一切使わない=課金の壁 ADR-021 を侵さない。GitHub API の呼出しはトークン発行と PR 作成のみで LLM 要素ゼロ)。
(4) 必須ステータスチェック(lint/tsc/Vitest/schema/canonicalize/content-diff-gate/id-registry/sim gate/conformance)+ force-push 禁止 + 直 push 禁止 + Include administrators 有効を維持。ブランチ保護・rulesets は public リポジトリのため GitHub Free で全機能利用可。
(5) **[2026-07-28追記・正直な開示] 本構成は技術的強制ではなく手続き的規律である。** personal アカウント所有リポジトリでは運営者本人が admin であり、保護設定自体を本人が無効化できる(バイパス不能な強制は Organization 所有でのみ成立)。二役分離の価値は「習慣的・偶発的な無審査マージを構造的に防ぐ」ことにあり、意図的な運用逸脱への防壁ではない(その防壁は決定論ゲート側=schema/sim/conformance が担う)。

**選択肢**
(a) CODEOWNERS 必須レビュー + 同一人物(旧):自己承認不可でデッドロック、撤回。(b) admin bypass 許可:レビュー無効化、却下。(c) bot 作成 PR + human 承認の二役分離:**採用**。

**理由**
「ソロ運営で自己承認デッドロック、bypass すれば無審査マージ、回避策の言及が皆無」に、作成者と承認者を別 identity へ物理分離してレビュー機能を保ったまま成立させる具体構成で回答。

**トレードオフ**
bot identity(GitHub App 秘密鍵 .pem)のシークレット管理が増える(ADR-021 最小権限対象に追加。ただし PAT と違い定期ローテーション必須ではない)。トークン発行スクリプト(JWT 署名)の実装が PAT 直用より一段複雑。運営者本人がレビューを形骸化させ機械承認する運用逸脱は依然可能(残余リスク・上記(5))。ADR-004 の 60 日 heartbeat は運営者本人の資格情報による自己 push であり、bot の App 資格情報とは**共有しない**(2026-07-28 改訂で分離)。

---

### ADR-017(改訂) クロスブラウザ conformance を週次 content パイプラインの beta ソーク前ゲートに結線

**決定**
golden vector / in-browser conformance harness / 起動時 self-check が algoVersion・engine コード変更にしか結線されず、週次 content が実際に踏む唯一の CI パス(schema → Node sim1000 → content-diff-gate → クリープ → merge → beta ソーク → 本番)に conformance 層が一度も現れないため「sim で通したものが本番と1 tick 違わない」主張が週次 content に対して不成立だった欠陥を修正する。パイプラインを改訂:content-diff-gate/canonicalize 通過後、beta ソーク前の必須ゲートとして「**in-browser conformance(Chromium/Firefox/WebKit)を、その週の新規/変更 entity を実際に踏む代表 seed 群で実行し golden vector と bit 一致**」を追加結線。新 content 用 golden vector は自動生成(Node)し、3ブラウザ実行がそれと一致することを検証=Node sim1000 の結果がブラウザでも bit 一致することを毎週 content 単位で機械確認。不一致はマージブロック。許可リスト外 Math(ADR-006)を踏む content もここで顕在化する。

**選択肢**
(a) conformance を engine 変更時のみ結線(旧):週次 content が素通りする fatal、撤回。(b) content-diff-gate 後・beta ソーク前に conformance 必須ゲート追加:**採用**。

**理由**
「週次 content が唯一踏む CI パスに conformance が存在せず、新 trait/新 adjacency 組合せが初めて踏むブラウザ実装差やキー順依存を検出する層が設計上どこにもない」に、conformance を content パイプライン本線へ結線して回答。

**トレードオフ**
週次 CI にブラウザ3エンジン実行が加わり所要時間増(新規/変更 entity を踏む seed に限定して抑制)。content 用 golden vector の自動生成/保持コスト。実 iOS Safari 完全一致は BrowserStack 相当で定期補完(open question)。

---

### ADR-002(改訂) 状態管理:構造共有の単一正準実装 + adjacency computed の fan-in 上界 O(近傍) + Worker catch-up は可変ドラフト

**決定**
概要主張「構造共有で非再描画」の実装方式・blast radius・foreground/背景の未規定を確定する。
(1) **構造共有の単一実装**(詳細 ADR-028) — 追加ライブラリ(immer 等)は入れず、GameState を正規化(entity は `Map<id,plain>` 保持)し、更新は `src/engine/state/update.ts` の `updateEntity`/`updateIn` ヘルパ単一経路のみを通す。生スプレッドによるサブツリーコピーを lint 禁止。
(2) **adjacency computed の fan-in 上界** — 過密集計(overcrowd threshold=3 同タグ隣接・GDD 6.6)はセル局所判定であり、各セルの表示 computed は自セルの近傍(最大8セル + 大型施設基準セル)の状態にのみ依存する O(近傍)。グリッド全体を跨ぐ単一集計 signal を表示層の依存に置かない(全体統計は別 signal として帰還ダイジェスト等専用画面のみ購読)。**1セル編集の再描画上界を O(8) と明記**。
(3) foreground tick 駆動は ADR-026、catch-up の GC 対策は Worker 内可変ドラフト(ADR-028/029)。commandLog/computed 明示定義は維持。

**選択肢**
(a) 生 signal 直読み + 全体集計依存:全48再描画経路が残り、却下。(b) 正規化 Map + 単一 update ヘルパ + 近傍限定 computed:**採用**。

**理由**
「構造共有の実装方式未規定」「adjacency 集約の blast radius 上界未明記で O(48) 再描画経路が排除されていない」に、単一更新経路 + 近傍限定 computed の O(8) 上界で回答。

**トレードオフ**
正規化 state と更新ヘルパの設計コスト。局所過密判定の前提(GDD threshold=3 が局所)が将来グローバル効果に拡張されると上界が崩れる(その時は computed 再設計)。

---

### ADR-028(新設) 構造共有の単一正準実装 + Map↔JSON 往復の単一正準ユーティリティ

**決定**
二つの「各所で個別実装される前提」の穴を単一ユーティリティ強制で閉じる。
(1) **構造共有** — GameState は正規化(entity を `Map<id,plain>`)保持し、全不変更新を `state/update.ts` の `updateEntity`/`updateIn`(変更パスのみ新参照・他サブツリーは参照保持)経由に一本化。生スプレッド/直接代入を engine で lint 禁止。immer 等の新規依存は入れない(ADR-001 依存最小)。
(2) **Map↔JSON 往復** — JSON に Map 型は無くセーブ時にプレーンオブジェクト/配列へ変換要。この双方向変換を `state/serialize.ts` の `toSerializable`/`fromSerializable` 単一実装に強制し、`Object.fromEntries` / `new Map(Object.entries())` 相当をこの2関数の外で engine 使用することを lint 禁止。非数値文字列キーは往復で挿入順保存されるが、「順序を保証しない中間処理(別 Map/Set 経由・filter)を挟む書き方」の将来混入を lint で検知。ID 正規表現(ADR-011)が先頭英字必須ゆえ整数風キー繰上げは発生しない前提も往復不変性の根拠として明記。

**選択肢**
(a) 各所で個別に spread/Object.fromEntries(旧暗黙前提):順序保証しない中間処理の混入を検知不能、却下。(b) update/serialize 各単一実装 + lint 強制:**採用**。

**理由**
「構造共有の実装方式が全く定まらず手書きスプレッドの罠を再導入しうる」「Map↔JSON 往復の正準ユーティリティが機械強制されていない」の2 major に、更新経路と直列化経路を各1関数へ集約し lint 強制して回答。

**トレードオフ**
更新/直列化の全経路を単一関数へ通す規律と lint ルール保守。正規化 state のボイラープレート。

---

### ADR-026(新設) フォアグラウンド tick 駆動モデル:tick を単調時刻の純関数とし、タイマー発火回数に依存させない

**決定**
オンライン中(1セッション5〜15分)のゲーム内時計進行機構が未規定で、実装者独自解釈が決定論バンドルとの整合を崩すリスクを修正する。tick 進行を「タイマー発火回数」でなく「clamp された単調経過時刻の純関数」として定義:

```
targetTick = startTick + clamp(0, elapsedMonotonicMs / 60000, 4320)
             // 1 tick = 1 分、72h クランプ (GDD 11.1 / 11.9)
```

(2) メインスレッドは rAF(または1秒間隔)ごとに現在の単調時刻から `targetTick` を算出し `advance(toTick)` を呼ぶが、tick の値は経過時刻のみで決まり rAF/setInterval の発火回数・間隔には一切依存しない=バックグラウンドタブのタイマー間引きが起きても tick 結果は不変。
(3) 差分が小さい通常操作(目安 ≤600 tick=粗粒度60 step 以下)はメインスレッド同期 advance、それを超える長期不在復帰は Worker オフロード(ADR-019)へ委譲。
(4) 可視復帰(`visibilitychange`)時は経過時刻ベースで一括 catch-up。
(5) advance/tick 算出は engine 純関数であり algoVersion 管理対象(ADR-016)。

**選択肢**
(a) setInterval 発火回数で tick 加算:背景間引きで非決定・環境依存、却下。(b) tick = 単調経過時刻の純関数(発火回数非依存):**採用**。

**理由**
「オンライン中の tick 駆動ループが ADR-002/019 のどちらにも無く、背景タブ間引き等の落とし穴も未検討で決定論バンドルとの整合が崩れうる」に、tick を時刻の純関数へ定義して発火回数依存を排除して回答。

**トレードオフ**
rAF 毎の `targetTick` 再計算コスト(軽微)。低頻度更新のため UI 上のカウントダウン表示は補間描画が必要。単調時刻ソース(`performance.now` 基準 + 巻戻し検知・ADR-012)の信頼性に依存。

---

### ADR-027(新設) 12画面ルーティング:自前ハッシュルータ + 非アクティブ画面はアンマウント

**決定**
画面遷移方式・非表示画面の computed 購読解除が未規定で、12画面分の computed が裏で評価され続けターゲット実機の性能予算を侵すリスクを修正する。
(1) ルーティングは追加ライブラリ(preact-router 等)を入れず、`location.hash` + `popstate` 監視の自前極小ルータ(数十行)で実装(ADR-001 依存最小)。
(2) 非アクティブ画面は `display:none` で隠さず**物理アンマウント**し、その画面の computed 購読を解除=裏で評価され続けない。格子ビュー/帰還ダイジェスト等の重い画面が非表示中に再描画コストを消費する経路を排除。
(3) 単一 GameState signal は常駐し apply で更新されるが、購読するのはマウント中画面の computed のみ。
(4) 緊急度バッジ等の常時表示要素はホームハブの軽量 computed に限定。

**選択肢**
(a) ライブラリルータ:依存増、却下。(b) `display:none` で全画面常駐:非表示画面の computed 評価が残り、却下。(c) 自前ハッシュルータ + 非アクティブアンマウント:**採用**。

**理由**
「画面遷移方式・非表示画面のサブスクリプション解除設計が無く、12画面分 computed が裏で評価され続け性能予算に直結」に、アンマウントによる購読解除で回答。

**トレードオフ**
画面再訪時の再マウント/再購読コスト(computed は構造共有で再計算は差分のみ)。ルータ自前実装の分岐/戻る挙動テスト。

---

### ADR-003(改訂) 格子UI:施設タグ7種に記号/パターンを併用し色覚多様性のタグ識別を担保

**決定**
従来の a11y/キーボード/可読性/ズーム競合の4仕様(維持)に加え、色分けのみに依存していたタグ7種識別の色覚対応穴を修正する。GDD 6.5 の4重符号化(色+記号+パターン+数値)は従来ボーナス/ペナのポジ/ネガ表現をカバーしていたが、施設タグ7種(熱源/清浄/汚染/騒音/湿潤/静穏/学芸)自体の識別・凡例パネル・内訳ビューが色のみだと色覚多様性ユーザーが区別できない欠陥を修正:
(1) タグ7種の各々に固有の記号(アイコングリフ)を割当て、セル上・凡例・内訳ビューの全箇所で色と記号を必ず併記(色単独表示を禁止)。
(2) 記号は 44px 角・最小表示スケール(ピンチ縮小時)でも判読可能な線幅/密度をプロト計測で確定し UI スタイルガイドへ数値記載。
(3) 記号セットは非テキストコントラスト ≥3:1(WCAG 1.4.11)を満たす。

**選択肢**
(a) タグを色のみで識別(旧・暗黙):色覚多様性で区別不能、撤回。(b) 7種各々に固有記号を色と常時併記:**採用**。

**理由**
「4重符号化はポジ/ネガのみカバーし、タグ7種自体への記号/パターン併用の言及が GDD/ADR のどこにも無く色覚対応にカバレッジの穴」に、タグ単位の記号割当てを全表示箇所で強制して回答。

**トレードオフ**
7種記号のデザインと最小スケール判読の計測(先行フェーズに1項目追加)。セル情報密度が上がり 44px 角のレイアウト設計制約が増える。

---

### ADR-004(改訂) PWA:ITP 前提を防御的タイムスタンプ設計へ格下げ + 60日失効を自動 heartbeat ワークフローで解消

**決定**
(1) **ITP 前提の防御的格下げ** — ADR-004(3) が ITP 7日免除の「継続利用条件」という未検証の一次挙動の上にバナー表示条件まで先に具体化していた欠陥を修正。バナーロジックを ITP 挙動の仮定から切り離し、実測可能な事実(最終起動 monotonicTimestamp)のみをトリガに再定義:「ローカルに記録した最終起動からの経過」で無条件にエクスポート促進バナーを出す防御実装とし、ITP 特有の免除挙動は「未検証の仮定・実機再確認対象」と ADR 本文に明記。standalone/非 standalone 分岐は促進強度の調整のみに用い、削除挙動そのものへの依存を排除。
(2) **60日失効の自動化** — 対策「月1回空コミット」が手動か自己永続かが未規定で、手動だと運営者長期離脱時にまさに同時停止する欠陥を修正。scheduled workflow 自身が PAT で heartbeat コミットを push する自己永続ワークフロー(月次)として自動化し、運営者のセッション有無から独立させる。ただしリポジトリが真に無活動なら最終的に失効しうる点は残余(運営完全停止時=ゲーム本体は動作継続・content 停止は受容済み)。

**選択肢**
(a) ITP 免除挙動の上に UI 確定(旧):未検証前提に設計が依存、撤回。(b) 手動空コミット(旧・曖昧):離脱時同時停止で撤回。(c) 防御的タイムスタンプ + 自動 PAT heartbeat:**採用**。

**理由**
「ITP 7日免除の一次ソースが ADR 内に無いまま挙動仮定の上に UI 仕様を先に確定」「月次コミットの自動化が不明で防ぎたいリスク(人間離脱)と対策の実行条件が同一に帰着」の2 major に回答。

**トレードオフ**
PAT heartbeat のシークレット管理(ADR-021 の最小権限対象。ADR-030 の bot identity は 2026-07-28 改訂で GitHub App となり本 PAT とは共有しない)。ITP 実機挙動が仮定と乖離した場合の促進タイミング再調整(open question)。真の完全無活動時は失効しうる(受容)。

---

### ADR-012(改訂) セーブ:絶対時間/件数の強制フラッシュ + 容量数値目標 + 分岐木ノード上界 + 2s 予算の ms 配分

**決定**
既存(tombstone soft-delete / 着手時スナップ / 分岐木 / 整合ハッシュ非改竄)に加え数値・フォールバックを確定する。
(1) **IDB 書込の絶対フォールバック** — `visibilitychange`/`pagehide` 依存のみだと iOS のイベント未発火終了パスで直近進行が丸ごと消える欠陥を修正。2秒デバウンス + ライフサイクルイベントに加え「**経過15秒 または 25コマンドごと**」の絶対時間/絶対件数の強制フラッシュを追加(catch-up 中は末尾1回)。
(2) **容量数値目標** — 典型セーブ ≤512KB(目標)、QuotaExceededError 前の書込前サイズ検査を **1.5MB で警告・4MB で書込中止**しエクスポート強制導線。commandLog はリングバッファ2000件、renderedLogs 50件、dispatchSnapshots 分岐木は下記上界で有界。
(3) **分岐木ノード上界** — 各派遣の resolvedTree は撤退枝が以降ノードを打ち切る性質 + choices が各ノード最大2分岐ゆえ、総ノード ≤2×maxNodes(8)=16/派遣、同時派遣 ≤2 で **≤32 ノード**=定数倍に有界(指数爆発しない)。**[2026-07-28追補・M3実装裁定]** ①上界超過時の挙動は **`SaveBoundsError` で停止**(「破損は黙って直さない」方針に整合。切り詰め・警告への緩和はしない)。検査位置は**書込とインポートのみ**で、`loadLatestSave` では検査しない(復帰2秒予算の B2 計測区間に予算無関係の検査を足さないため。自分が書いたセーブは書込時に検査済み)。②書込ポリシー(4トリガ: 2秒デバウンス/経過15秒/25コマンド/ライフサイクル)は `src/platform/saveScheduler.ts` として persistence.ts から**ファイル分離**する(「1回書く」と「いつ書くか」の分離。catchUp.ts/workerClient.ts と同じ前例。リポ構成図の読み替え)。③マイグレーションは**2軸の純関数連鎖**: エンベロープ版 `saveFormatVersion`(checksum 検証**前**に適用。v0 は正当なエンベロープ checksum を持たないため)と、payload 側 `saveSchemaVersion`(下記(a)、`JSON.parse` 直後に適用)。v0(エンベロープ化以前)の旧 `integrityChecksum` は定義が成立していなかった(B2 裁定の根拠)ため検証せず破棄し、移行後に現行定義で再計算する。未来版はどちらの軸も変換せず reject(部分的に読める経路を塞ぐ)。
(4) **2s 予算の ms 配分**(合計 2000ms・目標値):

| サブ予算 | 目標 |
|---|---|
| compute(tick catch-up) | ≤1100ms |
| IDB 読出 + JSON.parse + deserialize | ≤450ms |
| Preact ハイドレーション | ≤250ms |
| 約240 DOM 初回マウント | ≤200ms |

各サブ予算をターゲット実機で個別計測(超過時の対処は ADR-019/029)。

**[2026-07-27裁定] (5) セーブのエンベロープ化(裁定B2/B3/B4)** — IDB に入る値を `{saveFormatVersion, integrityChecksum, payload}` の2層構造とする。理由は**チェックサムが自分自身を含む文書を覆えない**ため(旧記述は `integrityChecksum` を `entityStateById` と同階層に列挙しており成立していなかった)。あわせて (i) `eventQueueSnapshot` はセーブに持たない(state から全再構成可能・`scheduler.buildEventQueue` が単一の真実)、(ii) `rngState` が空なら直列化形からキーごと省略する、を正準形として確定する。詳細は下記「セーブフォーマット(ADR-012)」節。

**[2026-07-27裁定] (6) 上表 ms 配分の前提(裁定D1/D2/D3)**

- **`IDB 読出 + JSON.parse + deserialize ≤450ms` が想定するセーブサイズ = 上記(2)の容量目標 512KB(上限側)**とする(裁定D1)。代表盤面(数KB)ではなく容量目標側を前提に置くことで、実機の合否解釈が盤面規模で揺れないようにする。参考: デスクトップでは 512KB でも restore 3.75ms。
- **`compute(tick catch-up) ≤1100ms` は cold(ウォームアップ)側に適用する**(裁定D2)。実機の実復帰は必ず cold であり、JIT が温まった中央値で判定すると本番より甘くなる(デスクトップ実測でウォームアップは中央値の約2.5倍: 16.8ms vs 7.4ms)。**実機計測では cold / warm の両方を必ず併記すること**。
- **`indexedDB.open()` は 450ms 予算に含めない**(裁定D3)。ADR-012(4) の文言は変更せず、「ページで最初に IndexedDB へ触るまでのサブシステム起動固定費」を `idbFirstTouchMs` という**補助メトリクス**として別枠で計上・報告する。実測ではこの固定費が 43.6ms → 2.59ms と 16 倍変動する(OS/ディスクキャッシュ依存の非決定要因)一方、実 cold open 自体は 2.0ms であり結論を左右しない。

**選択肢**
(a) ライフサイクルイベント依存のみ(旧):未発火終了で全損経路が数値的に開いたまま、却下。(b) 絶対フラッシュ + 容量数値 + ノード上界 + ms 配分:**採用**。

**理由**
「visibilitychange/pagehide 未発火パスに絶対時間/件数フォールバックが無い」「容量見積り数値が皆無・分岐木サイズ増加要因が有界化されていない」「2s 予算4分割に ms 目標が一つも無い」の3 major に、具体数値と上界で回答。

**トレードオフ**
15秒/25コマンド強制フラッシュの IDB 書込頻度増(差分書込で緩和)。分岐木上界はイベントノード数8・派遣枠2の設計値に依存(拡張時は再算定)。ms 配分は計測で再調整前提の目標値。

---

### ADR-029(新設) 性能/メモリ予算の数値確定 + catch-up の可変ドラフトでアロケーション有界化

**決定**
ターゲット実機(iPhone SE2=3GB / Android 中位機=4GB)基準の GC/メモリ数値と、adjacency 含む再計算コストの上界を確定する。
(1) **GC/メモリ数値目標** — catch-up 中の JS ヒープ増分ピーク **≤48MB**、GC ポーズ **≤50ms/回**、1回の catch-up で生成する短命オブジェクト数を「可変ドラフト方式」で有界化。Worker 内 catch-up(ADR-019)は毎 tick 構造共有で新オブジェクトを生成せず、Worker-local の可変ドラフト GameState を in-place 更新し、完了時に一度だけ不変スナップショット化してメインへ転送=432〜4320 tick のループでもアロケーションは**ドラフト1個 + 完了時1スナップショット**に圧縮。foreground live play(短い差分)のみ構造共有(ADR-028)を使い分ける。
(2) **adjacency 再計算コスト** — 1セル編集時の過密再集計は近傍(≤8セル + 基準セル)局所ゆえ O(8) で、全48セル再走査を要しない(ADR-002(2))。

**選択肢**
(a) GC/メモリを暗黙に compute 計測へ内包(旧):数値目標ゼロで検証不能、却下。(b) ヒープ/ポーズ数値 + 可変ドラフトでアロケ有界化:**採用**。

**理由**
「3GB/4GB 基準のアロケーション数・ヒープ上限・GC ポーズ予算が一つも数値化されず、structural sharing で毎 tick 新規オブジェクト生成する設計は短命オブジェクトが無視できない規模」に、数値目標と catch-up 可変ドラフトへの方式切替で回答。

**トレードオフ**
catch-up(可変ドラフト)と live play(構造共有)で更新方式が二系統になる複雑さ(ドラフトは Worker-local に隔離し engine 純粋性・決定論は維持)。ヒープ/ポーズ数値は実機計測で再調整前提。

**[2026-07-27裁定] 可変ドラフトの MVP 除外判断は保留(裁定N13)。** 先行計測の B1(compute)実測 7.4ms は**構造共有系(=上限側)の値**であり、これだけを見れば「可変ドラフトを MVP から外しても予算 1100ms に対し十分」と読める(実機の K が 100 倍でも 740ms)。しかし**可変ドラフトの本来の目的は速度ではなくヒープ圧の削減**であり、その根拠となる計測 #2 のヒープ増分は**デスクトップでも実機でも未取得**(headless Chromium が `measureUserAgentSpecificMemory()` を `SecurityError` で拒否)。よって**除外判断は #2 の実機ヒープ実測後まで保留**とし、現状の実装状態(`catchUp.ts` は構造共有系のみ実装・可変ドラフト経路は呼ぶと例外を投げて黙って落ちない・`computeFidelity: "worker-structural-sharing"` として機械可読に宣言)を維持する。

---

### ADR-014(改訂) 夜間ゲート:2s/run を計測校正値化しシャード数を導出 + 同時実行20上限に整合 + Fallback で再校正

**決定**
(1) **2s/run を校正値化** — 「4分/9分で余裕」の結論が未計測の 2s/run 仮定に依存する欠陥を修正。粗粒度10分 tick の (C) 評価だけで最大 20人×3tech×2,304step=**138,240 ベルヌーイ判定/run**(+離散事象8段パイプライン + adjacency + V8 ウォームアップ + GC)であり、2s は仮置きに過ぎないことを明記。校正 run(代表 seed 数本)で実測 sec/run を毎回計測し、シャード数を導出:

```
shards = min(20, ceil(totalRuns × measuredSecPerRun / targetWallClock))
```

(2) **同時実行20上限に整合** — GitHub Actions Free/Pro の同時実行ジョブ上限20(2026時点)に対し週次40ジョブは2波直列で実 wall-clock が約2倍になる矛盾を修正。シャードを最大20に制限し、週次 11000 runs は 20シャード×550 runs/shard、measured 2s/run なら1シャード約18分(1波20並列で完結)と正直に記載。夜間 2200 runs は 20シャード×110 runs=約4分。
(3) **Fallback で再校正** — 1分 tick へ戻すと (C) step 数が10倍化しベルヌーイ回数も10倍化するのにシャード数が10分 tick 前提の固定値だった欠陥を修正。Fallback 発動(11→5 bot / 毎晩→週次 / 1000→層化200 / 10分→1分 tick)のたびに `measuredSecPerRun` を再校正し shards を再導出する手順を必須化。MVP 期は Actions scheduled のみ(Worker Cron/Sentry/ntfy 後回し・ADR-004)。

**選択肢**
(a) 固定シャード数 + 2s 仮定で余裕結論(旧):同時実行上限と Fallback コストを無視、撤回。(b) 校正実測でシャード導出 + 20上限厳守 + Fallback 再校正:**採用**。

**理由**
「2s/run は未計測仮置きで逆算だけで予算を食い切りうる」「40ジョブは同時実行20上限超で約9分見積りが直列化を反映せず矛盾」「Fallback 発動時にシャード再計算の記述が無く360分接近が再発しうる」の3 major に、実測校正・上限厳守・再校正で回答。

**トレードオフ**
毎回の校正 run オーバーヘッド(数本・軽微)。20上限ゆえ総 run 数増大時は wall-clock 線形増(360分キャップ内は維持)。measured 値が悪い週は Fallback 段階が早期発動し sim 密度低下(受容)。

---

### ADR-015(改訂) guardrail:symlink/非通常ファイル reject + パイプライン整合(conformance/canonicalize/id-registry 結線)

**決定**
既存(additive 意味論 diff・ブランチ保護)に加え2点確定する。
(1) **symlink すり抜け対策** — content/** への変更パス強制が単純文字列一致だと、content/ 配下に置いた symlink(実体が `.github/workflows/` や `schema/` を指す)が文字列上通過しうる欠陥を修正。content-diff-gate に checkout 時の symlink follow 禁止 + 通常ファイル型限定チェック(非通常ファイルは全面 reject)を追加。
(2) **正準パイプライン整合** — §12.4 の正準順序を CI 記述と一致させる:

```
schema検証
 → canonicalize (ADR-023)
 → id-registry検証 (ADR-024)
 → 段階 sim1000
 → content-diff-gate (キー順盲目を正準化で無効化・削除reject)
 → conformance 3ブラウザ (ADR-017)
 → 統計クリープ検出
 → bot作成PRをhuman承認merge (ADR-030)
 → betaソーク (ADR-031)
 → 本番
```

content-only PR の tsc/Vitest は engine 変更なしゆえ goldenVector 検証のみにスコープ。CODEOWNERS デッドロックは ADR-030、beta ソーク実体は ADR-031 で解消。

**選択肢**
(a) 文字列パス一致のみ(旧):symlink すり抜け、却下。(b) 非通常ファイル reject + 全ゲート結線:**採用**。

**理由**
「symlink/非通常ファイル経由すり抜けが未対策」およびパイプライン各ゲート(conformance/canonicalize/id-registry)の結線を正準順序へ統合して回答。

**トレードオフ**
symlink/ファイル型チェックの実装。パイプライン段数増で週次 CI 所要時間増(content-only スコープ限定で緩和)。

---

### ADR-031(新設) stable/beta 昇格機構を MVP へ前倒し実装(soak N=3日・手動 promotion)

**決定**
[2026-07-25改訂] 配信基盤はCloudflare Workers静的アセット(assets binding・SPAモード)に変更(ユーザー承認済み)。理由: 公式ブログが新規プロジェクトにWorkersを推奨しPagesへの機能投資終了を明言(https://blog.cloudflare.com/full-stack-development-on-cloudflare-workers/)。静的アセット配信はWorkersでも無料・無制限でWorkers無料枠10万req/日にカウントされない。stable/beta 2環境は `wrangler.toml` の `[env.stable]` / `[env.beta]` で別Workerとして実現する(下記(1)を改訂)。
ADR-015 が「human merge → beta ソーク → 本番」を今すぐ有効な正準パイプラインと宣言する一方、その実体(soak 期間/last-known-good/promotion 判定)を定義する ADR-022 が「リリース後」へ先送りされ、beta ソーク機構が存在せず stable 直行しかない矛盾を修正する。最小 promotion 機構を MVP へ前倒し確定:
(1) stable/beta は `wrangler.toml` の `[env.stable]` / `[env.beta]` で表現される別 Worker(`kept-flame-stable` / `kept-flame-beta`・別サブドメイン)として表現。
(2) 週次 content はまず beta へデプロイ。
(3) soak **N=3日**(初期値・データで再調整)を beta 稼働の最小期間とし、CI の promotion ジョブが「beta デプロイ日時 +3日経過」かつ「beta で P0/エラー閾値超なし」を日付/署名チェックで機械判定してから stable 昇格を許可(それ未満は promotion を block)。
(4) 最終 promotion は MVP 期は人間の手動操作(beta の git ref を stable へ merge/promote)。
(5) 自動ロールバック・Workers KV last-known-good・独立ヘルスビーコン等の重い監視基盤は ADR-022(リリース後)のまま — MVP 前倒しは promotion ゲートの最小実装に限定し YAGNI との整合を保つ。

**選択肢**
(a) beta ソーク実体を全て ADR-022 へ先送り(旧):正準パイプライン宣言と実装状況が矛盾、撤回。(b) 最小 promotion ゲート(soak N=3日・手動 promote)を MVP 前倒し:**採用**。

**理由**
「beta ソーク実体がリリース後送りで、宣言した正準パイプラインと実装が食い違い、stable/beta 表現や最終 promotion 主体が一度も具体化されていない」に、最小機構の MVP 前倒しと具体表現で回答。

**トレードオフ**
MVP に beta 環境 + promotion ゲート実装工数(監視自動化は後回しゆえ最小)。手動 promotion は運営者の作業で、忘れれば beta 滞留(週次リマインダで緩和)。soak N=3日は経験則で実データ調整前提。

---

### ADR-021(改訂) シークレット/課金の壁:preflight で機械強制可能な部分を固め、CI 強制不能部分は残余として明示

**決定**
「API 自動化不採用」が全体前提だが CI/guardrail は git diff しか見ず PR 生成の課金経路(Pro 対話枠か API キー従量か)を判定・拒否できず運営者裁量のみに依存する欠陥に正直に回答する。強制可能な部分は固める:
(1) 週次セッション起動前の preflight スクリプト(検討レポート Phase 0)で環境に `ANTHROPIC_API_KEY` が存在すれば起動中止=ローカルの物理的財布固定を機械化。
(2) PR 作成はローカル git + GitHub App インストールトークン経路のみ(ADR-030 [2026-07-28改訂])で API 連携(headless/Actions claude 連携/Routines)を運用上不使用と明記、これらの workflow をリポジトリに置かないことを guardrail で確認。
(3) 週次インタラクティブ消費量の見積り — bisection 最大約5フルゲート再実行 + schema reject 再試行を含むセッションのトークン/時間概算を README に記載し、Pro/Max 週次上限に対する余裕を運用前に確認する手順を追加。
ただし「どの課金経路で生成されたか」は git diff から原理的に判定不能で、上限超過時に運営者がとっさに API キー課金へ切替える人的逸脱は CI で防げない=残余リスクとして明示。MVP 期シークレットは CF Workers デプロイトークン([2026-07-25改訂] 旧 CF Pages デプロイトークンから変更。wrangler deploy 用 API トークン)+ bot PAT + heartbeat PAT に最小化、stable/beta 分離・GitHub 暗号化 secrets・`pull_request_target` への secrets 受渡し禁止を維持。

**選択肢**
(a) 課金の壁を運営者裁量に暗黙依存(旧):強制機構皆無、不十分。(b) preflight 機械化 + API 連携排除確認 + 消費見積り、CI 不能部分は残余明示:**採用**。

**理由**
「課金経路を CI/guardrail で判定・拒否する手段が原理的になく、週次消費量の見積りも ADR 中に皆無で、上限超過時の API 切替(避けたい fatal)を防ぐ機構が設計上存在しない」に、機械強制可能部分の実装と不能部分の正直な残余化で回答。

**トレードオフ**
preflight/README 手順は運営者が回避可能(自己規律依存)。消費見積りは実セッションで振れる。課金経路の CI 強制不能は原理的限界(残余リスク)。

---

### ADR-022(改訂) リリース後監視:独立ヘルスビーコンを署名付き・助言的に限定し自動ロールバックは2信号照合必須

**決定**(リリース後フェーズ)
独立ヘルスビーコンが公開 monorepo ゆえ未認証書込み API となり、匿名偽装で失敗カウントを押し上げ閾値ベース自動ロールバックを外部誘発できる DoS ベクタとなる欠陥を修正する。
(1) ビーコンは未認証の生カウンタ送信をやめ、クライアント配布時に埋めた回転鍵で HMAC 署名 + Cloudflare 側でレート制限 + 送信元(同一 origin/リファラ)検証を課す。
(2) それでも公開クライアントゆえ鍵抽出は原理的に可能なため、ビーコン単独では自動ロールバックを起動させない — ロールバックトリガは「ビーコンのエラーレート閾値超」かつ「Sentry の新規エラー署名 または ゲーム内報告(決定論)」の**2独立信号照合を必須**とし、ビーコンは助言的アラート(人間通知)止まりとする。
(3) beta もロールバック対象(beta 破損放置しない)。
(4) last-known-good は Workers KV に明示記録。soak N=3日は ADR-031 で前倒し済み。

**選択肢**
(a) 未認証ビーコン単独をロールバックトリガ(旧):偽装 DoS で外部誘発可能、撤回。(b) HMAC 署名 + レート制限 + 2信号照合(ビーコンは助言的):**採用**。

**理由**
「独立ヘルスビーコンが未認証公開エンドポイントで、偽装リクエストによる自動ロールバック誘発 DoS ベクタ、認証/レート制限/送信元検証が設計に含まれない」に、署名 + レート制限 + 単独起動禁止(2信号照合)で回答。

**トレードオフ**
HMAC 鍵は公開クライアントゆえ抽出可能(単独トリガ禁止で影響を限定するが完全防止不可=残余)。2信号照合はロールバック発動を遅らせうる。リリース後の実装工数(MVP 後回し)。

---

### ADR-001/005/008/009/010/011/013/019/020(維持・軽微整合) 変更なしの核と参照整合

**決定**
以下は第2版から核を維持し、上記改訂への参照のみ整合させる:

- **ADR-001**: engine 依存ゼロ純 TS / Preact + signals / ターゲット実機 iPhone SE2・Android 中位機固定。
- **ADR-005**: Vitest + Playwright、conformance 層は ADR-017 へ。
- **ADR-008**: 離散事象ヒープ + 区間分類 + tie-break/ロード順の決定論、選択テーブル網羅規則は ADR-023 正準化で強化。
- **ADR-009**: MVP 粗粒度ベルヌーイ・オラクル / 段階2 next-reaction は計測後、段階2限界は ADR-018 で明記。
- **ADR-010**: 不変条件、localeCompare 禁止/逐次カスケード順序/Map 根拠是正・content 走査 lint 禁止は ADR-023 へ拡張。
- **ADR-011**: jsep 採用 cond DSL + ID 正規表現、グローバル ID 一意性は ADR-024 へ。
- **ADR-013**: 11 bot 定量化 + prestige-chain 分離 + bisection コスト計上、シャード導出は ADR-014 へ。
- **ADR-019**: catch-up Worker オフロード、可変ドラフトによる GC 対策は ADR-029 へ。
- **ADR-020**: assist engine 配置 + bot 共有。

**選択肢**
これらは6観点レビューで構造的 fatal/major を受けていない、または上記改訂 ADR で実質回答済みのため、核を維持し重複改訂しない。

**理由**
指摘への回答は上記改訂/新設 ADR に集約済み。ここでの再掲は参照整合とスコープ確定のため。

**トレードオフ**
ADR 番号の分散(ADR-001〜031)で全体把握コストは上がるが、各指摘への回答トレーサビリティを優先。

---

### ADR-018(改訂) 段階2 逆CDF 依存カスケード:安全網がテストのみである限界を正式に明記(構造保証は MVP 段階1に限る)

**決定**(正直な残余化)
段階2 next-reaction 実装の依存カスケード正当性が差分オラクル(テスト)のみに依存し構造保証でない点を、曖昧化せず正式 ADR に明記する。
(1) **MVP 段階1**(粗粒度 per-step 全再評価)は依存グラフ列挙が原理的に不要=構造的に見落とし不能であり、これを恒久のグラウンドトゥルース・オラクルとして保持=高速版導入までは依存グラフバグは発生しない(**構造保証**)。
(2) 段階2で next-reaction + fpLog を導入する場合、recallRisk の moraleW/dispatchW が住民個人状態変化・派遣という他確率系イベントで非連続に変わり「どの状態変化がどのクロック再サンプリングを要求するか」はレジストリの人力保守項目であり、レジストリ漏れは (a) bit 再現性は保つ(決定論的に誤値を再現)(b) golden/manifest に掛からず (c) 差分オラクルが該当カスケードを踏む seed/bot 組合せを実際にトリガーしない限り検出されない、という**テスト依存の安全網**でありゼロにできないことを ADR と risks の両方に明記。
(3) 緩和 — カスケードレジストリの各エントリにオラクル一致テストを紐付け、敵対 bot 6種が跨ぎ依存を強制トリガーするよう設計、段階2移行は該当カスケードの seed 被覆を open question で先行確認。段階2は MVP 後の追加投資ゆえ直近破綻ではない。

**選択肢**
(a) 差分オラクルを構造保証と主張(旧・過大表現):テスト依存を隠す、撤回。(b) 段階1のみ構造保証・段階2はテスト依存と正式明記 + 緩和策 + 残余化:**採用**。

**理由**
「安全網はテストのみを ADR が正式に明記して終わっている点自体が指摘対象・レジストリ漏れは3経路で検出されない」に、限界を隠さず正式明記し、段階1構造保証との切り分けと緩和策・残余化で回答。

**トレードオフ**
段階2の依存正当性はテスト網羅度に依存する限界が残る(受容・risks)。オラクル自体のバグは共通原因になりうる(仕様手計算ベクタで別途検証するが原理的にゼロ化不可)。

---

## リポジトリ構成

単一公開 monorepo。engine(純粋・決定論バンドル)/ content(JSON)/ 検証(sim)/ 設計(docs)を物理分離し、guardrail CI(正準化 + 意味論 diff + ID/domainTag レジストリ + symlink 拒否)と bot 作成 PR + human 承認の二役分離(ADR-030)で運営 LLM の触れる範囲を `content/**.json` の additive 追加に限定する。

```
kept-flame/
├─ src/
│  ├─ engine/                  # 依存ゼロ純TS。DOM/Date/Math.random/Promise/非許可Math/
│  │  │                        #   localeCompare/生スプレッド/レジストリ外domainTag/content直接走査を禁止
│  │  │                        #   (lint強制)。決定論バンドル=golden vectorアンカー(ADR-016)
│  │  ├─ fp.ts                 # 1e6固定小数点。mulFix(中間積は除算前2^53ガード/値域未証明はBigInt)
│  │  │                        #   floorDivFix・Math許可リスト(ECMA-262精度表) ADR-006
│  │  ├─ rng/
│  │  │  ├─ xoshiro128.ts      # 純uint32 xoshiro128**(carryバグ階級を消去)+splitmix32 seed展開 ADR-007
│  │  │  ├─ fnv1a32.ts         # ドメイン分離hash(32bit) ADR-007
│  │  │  └─ domainTags.ts      # frozen domainTagレジストリ(union型)・lint/型で一意強制 ADR-024
│  │  ├─ scheduler.ts          # 離散事象ヒープ・(A)(B)(C)区間分類・tie-break・72hクランプ ADR-008
│  │  ├─ stochastic.ts         # MVP=粗粒度ベルヌーイ・オラクル / 段階2 next-reaction+fpLog
│  │  │                        #   ・カスケードレジストリ ADR-009/018
│  │  ├─ pipeline.ts           # 同tick固定順序 + 同ステージ内逐次カスケードのID辞書順 ADR-010
│  │  ├─ rules/                # 生産・研究・成文化・想起困難・探索解決・襲撃・衛星・幕塵
│  │  │                        #   (各式spec正準形の単一実装)
│  │  ├─ adjacency.ts          # タグ×タグ行列・過密は近傍局所集計(O(8)上界・全体集計は別signal) ADR-002/029
│  │  ├─ graph.ts              # (A)再取得保証の静的グラフ解析 §11.4-2
│  │  ├─ assist/               # 推奨配置/おまかせ成文化/探索テンプレ=(state,content)=>Command[]
│  │  │                        #   純関数 ADR-020(sim botが共有)
│  │  ├─ advance.ts            # tick=clamp(単調経過時刻)の純関数駆動(発火回数非依存) ADR-026
│  │  ├─ canonicalize.ts       # contentバンドル再帰安定ソート正準化(キー順依存を無効化) ADR-023
│  │  ├─ state/
│  │  │  ├─ update.ts          # 構造共有の単一更新経路(updateEntity/updateIn・生スプレッド禁止) ADR-028
│  │  │  ├─ serialize.ts       # Map↔JSON往復の単一正準実装(Object.fromEntries等を外で禁止) ADR-028
│  │  │  └─ state.ts           # GameState型(正規化Map保持)・apply(Command) ADR-002
│  │  └─ commands.ts           # Command判別ユニオン
│  ├─ platform/                # 副作用隔離(ブラウザ境界)
│  │  ├─ persistence.ts        # IDB主+localStorageミラー・巻戻し検知・2sデバウンス
│  │  │                        #   +15s/25cmd絶対フラッシュ・容量検査(1.5MB警告/4MB中止) ADR-012
│  │  ├─ worker.ts             # catch-upオフロード・可変ドラフトでアロケ有界化・content1回転送 ADR-019/029
│  │  ├─ migration.ts          # 純関数チェーン・tombstoneソフト削除救済・着手時スナップ ADR-012
│  │  ├─ clock.ts              # 単調タイムスタンプ・0〜72hクランプ・レート制限 §11.9/ADR-026
│  │  ├─ conformance.ts        # 起動時golden vector self-check+セーフモード ADR-017
│  │  ├─ router.ts             # 自前ハッシュルータ・非アクティブ画面アンマウント ADR-027
│  │  └─ exchange.ts           # エクスポート/インポート(破損検出チェックサム・非改竄耐性) ADR-012
│  ├─ ui/                      # Preact+signals薄い投影層。生signal直読み禁止(lint)
│  │  ├─ store.ts              # GameState signal・画面別/近傍セル別computed()明示定義 ADR-002
│  │  ├─ grid/                 # CSS Grid+SVG・ARIA(role=grid/gridcell/aria-live)・キーボードnav
│  │  │                        #   ・タグ7種記号併記(色覚対応)・ズームレイヤー分離 ADR-003
│  │  └─ screens/              # 12画面(非アクティブはアンマウント) §6.6/ADR-027
│  ├─ replay/                  # commandLog+seedから状態再構築 ADR-002
├─ content/                    # 運営LLMのadditive追加領域(正準化+意味論diffで隔離) ADR-015/023
│  ├─ tech/ recipe/ facility/ item/ trait/ event/ raid/ outpost/ era/
│  │                           # [2026-07-27裁定・N3] 正本はカテゴリごと1ファイル
│  │                           #   (tech.json / facility.json / event.json …)。
│  │                           #   エンティティ個別ファイル方式は採らない
│  ├─ adjacency.json townParams.json balance.json  # balanceは人間専用(CODEOWNERS)
│  └─ CHANGELOG.md
├─ schema/                     # JSON Schema+cond DSL(jsep AST)+ID命名正規表現
│  │                           #   +グローバルID一意性検証器 ADR-011/024(人間専用)
│  └─ engineContent.ts         # [2026-07-27裁定・N6] contentローダー(JSON→engine内部表現)。
│                              #   engine内に置けない: Object.keysはcanonicalize.tsのみ免除、
│                              #   engine→schemaの非型importは全面禁止(lint強制)。加えて
│                              #   schema/はCODEOWNERS人間専用ゆえ「engineが受け付ける
│                              #   content語彙」を運営LLMが勝手に広げられない ADR-024/030
├─ sim/                        # engine共有検証ハーネス ADR-013(人間専用)
│  ├─ bots/strategy/           # 5戦略bot(assist共有+閾値差替え) §11.5
│  ├─ bots/adversary/          # 6敵対bot(a〜f) §11.6(跨ぎ依存を強制トリガー ADR-018)
│  ├─ oracle.ts                # per-step全再評価グラウンドトゥルース ADR-018
│  ├─ assertions.ts            # §11.4 11判定+カバレッジ+頻度の不等式化
│  ├─ creep.ts                 # 統計クリープ検出(Z-score) §12.4
│  ├─ calibrate.ts             # 校正run→measuredSecPerRun→shards導出 ADR-014
│  └─ bisection.ts             # content相互作用の二分探索 §12.4
├─ conformance/                # golden vectors(engine+content両用)+ in-browserハーネスページ ADR-017
├─ tools/                      # オーサリング(1.2^n/1.15^Lv個別FP展開)
│  │                           #   +content-diff-gate(正準化diff/削除reject/symlink拒否) ADR-015/023
│  └─ determinism-manifest.ts  # 正準化後source hash(助言的tripwire) ADR-016
├─ tests/                      # Vitest単体+FP spec手計算ベクタ+オラクル一致
│                              #   +xoshiro参照差分+carry無し確認+正準化 ADR-005/007
├─ docs/adr/                   # 設計ADR(本書)
├─ docs/sim-history/           # 夜間ゲート検証履歴
├─ .github/workflows/          # guardrail・正準化・conformance・夜間sim(≤20シャード)
│                              #   ・月次heartbeat(PAT自己push)・promotion(soak3日判定)
│                              #   ADR-014/030/031(人間専用)
├─ CODEOWNERS                  # engine/sim/schema/workflows/balance/conformance/tools/domainTagsを
│                              #   人間専用(bot作成PR+human承認・ADR-030)
├─ vite.config.ts              # Vite 8.1・vite-plugin-pwa(injectManifest)・Vitest共有 ADR-004
└─ tsconfig.json               # strict全部
```

---

## スキーマとセーブフォーマット

### 共通規約

全 entity に `id`(正規表現 `^[a-z][a-zA-Z0-9_]*$` = 正準整数インデックス化不能・ADR-011)、`schemaVersion`、`contentVersion` を持つ。ID は**全カテゴリ横断でグローバル一意**を schema 検証段階で強制(ID 集合を構築し重複 reject・ADR-024)=単一 namespace `entityStateById` のシャドーイングを排除。数値は FP 前(人間可読)で記述しビルド時に 1e6 化 + べき乗個別値展開。全 JSON はロード/ビルド時に `canonicalize.ts`(再帰安定キーソート・UTF-16 コードユニット比較器)を通してから内部表現化=キー順序依存を構造的に無効化(ADR-023)。min/max レンジ制約は trait 係数・成文化速度/コスト・研究点係数・探索 difficulty/R・item.stats・outpost hazard・recipe 入出力比・recallRiskParams 全カテゴリに必須。

### entity スキーマ

```jsonc
// tech
{ "id", "era", "lossClass": "criticalRecoverable" | "rareIrreversible",
  "prereqs": ["techId"],   // 0-3 [2026-07-27裁定・N4] 旧「1-3」を改訂。
                           //   長さ0 = era の起点テック(前提なし)を表現するため許可する。
  "researchCost": "int", "fieldRequirement": { "facility", "recipe", "count" },
  "unlocks": ["id"], "leaf": "bool" }
// leaf=true(週次追加)は n リセット式の n に算入しない (§5.1)

// facility
{ "id", "tags": ["7種"], "slots": { "lv1..lv5" },
  "lvCurve": ["base × 1.15^(Lv-1) 個別FP"], "overflowCapPolicy", "footprint",
  "harshWork": "bool",     // [2026-07-27裁定・N5] schemaでは省略可・ローダーでは必須
  "output": { /* 資源ID→量 */ } }  // 同上。最終形は recipe entity 側へ移す想定
// UI表示はタグ7種各々に固有記号を色と常時併記(色覚対応・ADR-003)

// adjacency
{ "schemaVersion",
  "tagMatrix": { "熱源|熱源": { "effect", "target", "valueFP" }, /* 対称・タグ7種 */ },
  "overcrowd": { "threshold": 3,  // 局所判定=近傍集計 O(8)・ADR-002
                 "penaltyPerExcessFP", "clampFP": "±0.6" },
  "seedOffsetRange": { "min": -0.2, "max": 0.2 } }
// 既存 tagMatrix エントリ値の書換は content-diff-gate が reject(ADR-015)

// event
{ "id", "destTags",
  "nodes": [ { "difficulty", "R", "statWeights",
               "choices": [ { "label", "effect" } ],
               "branches": [ { "cond", "result", "logTemplate" } ] } ] }
// cond は jsep AST(hasTrait(traitId)/maxStatHolder(stat)等の引数付き関数・
//   括弧グルーピング・優先順位 || < && < 比較、ADR-011)
// 分岐のRNGは domainTag='exploration' + salt(dispatchId,nodeIndex,branchId,choiceKey)
//   で各枝独立counter起点(ADR-007)
```

`raid`/`trait`/`outpostType`/`era`/`townParams`/`recipe`/`item` は §12.1 準拠。`balance`(人間専用)は:

```jsonc
{ "fpScale": 1000000, "offlineClampTick": 4320, "safetyFactor": 1.5,
  "assistEfficiencyCap": 0.85,
  "recallRiskParams": { "base_p": 0.05, "p_max": 0.35, "moraleW": "住民個人変数",
    // [2026-07-27裁定・N5] 以下3つは schemaでは省略可・ローダーでは必須
    "memoryKeeperTraitId": "traitId", "durationTicksMin": "int", "durationTicksMax": "int" },
  "lifespan", "populationFloor", "eraTable", "caravanRatio": 0.35, "roiRange",
  "algoVersion": 1,          // =決定論バンドル全体版・xoshiro128** でアンカー
  "coarseTickMinutes": 10 }  // MVP 粗粒度
```

**[2026-07-27裁定] 省略可フィールド3種の二段構え(裁定N5)。** `facility.harshWork` / `facility.output` / `balance.recallRiskParams.{memoryKeeperTraitId,durationTicksMin,durationTicksMax}` は **schema 検証では省略可・content ローダー(`schema/engineContent.ts`)では必須**という二段構えを正式化する。既存 content と既存テストを壊さずに additive 拡張するための措置であり、ローダーは欠落を既定値で埋めず **reject** する(縮約必須フィールドの黙示補完は決定論の穴になるため)。`output` は最終形では recipe entity 側へ移す想定。

**[2026-07-27裁定] content はカテゴリごと1ファイル方式(裁定N3)。** 上記リポ構成図の `content/tech/ recipe/ facility/ ...` はエンティティ個別ファイルとも読めるが、**正本はカテゴリごとに1 JSON ファイル**(`content/tech.json` / `content/facility.json` / `content/event.json` …)とする。正準化 diff・ID グローバル一意性検証・content-diff-gate はいずれもカテゴリ単位のロードを前提としており、個別ファイル方式にすると差分ゲートの粒度がファイル追加/削除の検出に依存して脆くなる。

### セーブフォーマット(ADR-012)

**[2026-07-27裁定] エンベロープ化を採用(裁定B2)。** 旧記述は `integrityChecksum` を `entityStateById` と同階層のフィールドとして列挙していたが、**チェックサムは自分自身を含む文書を覆えない**(checksum を書き込んだ時点で対象バイト列が変わる)ため成立しない。IDB に入る値を「薄いエンベロープ + payload 文字列」の2層とし、checksum は payload 文字列のみを対象とする。

```jsonc
// (1) IDB に入る値 = エンベロープ [2026-07-27裁定・B2]
{
  "saveFormatVersion": "int",       // エンベロープ自身の版。payload内の3軸(下記)とは別物
  "integrityChecksum": "uint32",    // payload文字列のFNV-1a-32・破損検出専用/改竄耐性なし
  "payload": "string"               // 下記(2)を canonicalize 済み JSON 文字列にしたもの
}
// payload は**文字列**のまま保持する(構造化複製可能なオブジェクトとして入れない)。
//   → checksum は payload 文字列を舐めるだけでよく、読出側で再直列化しなくてよい。
```

```jsonc
// (2) payload の中身 = 従来「セーブフォーマット」と呼んでいたもの
{
  "saveSchemaVersion": "int",
  "contentVersion": "int",
  "algoVersion": "int",            // =golden vectorアンカー版(ADR-016)
  "worldSeed": "string",
  "rngState": { "domainTag": "xoshiro 4×uint32語" },
  // [2026-07-27裁定・B4] rngState が空(=RNGを一度も消費していない)なら
  //   直列化形から**キーごと省略**する正準化を行う。往復でバイト同一を保つため
  //   「空オブジェクトを書く」ではなく「書かない」を正準形とする。
  //   旧セーブもマイグレーション不要でロード可(欠落=空として解釈)。
  "tick": "int",
  "monotonicTimestamp": "int",
  "runCount": "int",
  "cumulativeInheritPoints": "int",
  "entityStateById": { /* ...ID参照プレーンデータ・serialize.ts単一経路で往復(ADR-028) */ },
  "inProgressOrders": [
    { "orderId", "entityId",
      "snapshottedParams": { /* 着手時点複製(tombstone救済) */ } }
  ],
  // [2026-07-27裁定・B3] "eventQueueSnapshot" は**セーブに持たない**(旧記述を撤回)。
  //   全イベントは state から再構成可能であり、`scheduler.buildEventQueue` が
  //   イベントキューの単一の真実(single source of truth)。スナップショットを併記すると
  //   state と queue が二重の真実になり、不整合セーブが原理的に作れてしまう。
  "dispatchSnapshots": [
    { "dispatchId", "seed",
      "resolvedTree": { /* 分岐木・総ノード≤16/派遣・同時≤2で≤32ノードに有界(ADR-012) */ } }
  ],
  "renderedLogs": [ /* 完成文字列・上限50 */ ],
  "commandLog": [ { "tick", "cmdHash", "cmd" } ]  // リングバッファ2000件・replay入力
  // integrityChecksum は(1)のエンベロープ側へ移動 [2026-07-27裁定・B2]
}
```

容量:典型 **≤512KB 目標 / 1.5MB 警告 / 4MB 書込中止**(測る対象は payload 文字列)。

### バージョニング / マイグレーション(3軸)

- **(a) saveSchemaVersion 差** → 純関数マイグレーション version 順連鎖。**[2026-07-30追記]** payload 軸の最初の実段 = M16 の v1→v2（facility footprint 追加。省略可フィールドでも「旧ビルドが新セーブを読むと盤面幾何が黙って潰れる」類の変更は版差で塞ぐ、が線引きの実例）。v2→v3 = M21（派遣スナップショット追加。旧ビルドは未帰還派遣を黙って捨て派遣中住民が永久拘束されるため同じ線引きで bump）。**[2026-07-31追記]** v3→v4 = M22（派遣スナップショットへの event 効果 `effects`/choice・branch 記録の追加。旧ビルドは効果を黙って落とし「燃えるはずの記録が燃えない」ため同じ線引きで bump）。v4→v5 = M52（地形 `terrain{rubbleCells, reclaimedCount}` 追加。旧ビルドの往復で瓦礫配置と解放数が不可逆に消え、開墾コスト指数 `1.15^n` がリセットされる経済 exploit が成立するため bump。判断の両論は `migration.ts` の `migratePayloadV4ToV5` doc に記録）。
- **(b) contentVersion 差** → additive-only・未知 ID グレースフル無視・tombstone=ソフト削除ゆえ逆参照/救済が機械実行可能・着手済みは `snapshottedParams` で完了継続/未着手はコスト返還。
- **(c) algoVersion 差** → 旧セーブは生成時 algoVersion の決定論バンドル全体実装 registry で未来 tick 計算(ライブは直近3世代ハード上限・ADR-025)。sunset 到達版の実装はライブ HEAD から物理削除し Cloudflare Workers 静的アセットの個別 Worker(固定サブドメイン・[2026-07-25改訂] 旧 Cloudflare Pages イミュータブル凍結アーカイブデプロイから変更、詳細は ADR-025)へ退役、sunset 版セーブは現行ビルドが計算拒否し「凍結ビルドで継続/エクスポート or 同意して再シード移行」を提示(ADR-025)。

`algoVersion` bump の必要十分条件は golden vector 変化(ADR-016)。探索は dispatch 時点で分岐木スナップショット固定、帰還ログはレンダリング済み文字列で再参照禁止。エクスポート/インポートは破損検出チェックサム付き JSON blob・QuotaExceededError 前サイズ検査。

---

## 先行プロトタイプ計測項目

| # | 計測項目 | 計測方法 | 判断基準 |
|---|---|---|---|
| 1 | オフライン復帰2秒予算(ADR-012) | iPhone SE2/Android 中位機で compute / IDB 読出+parse+deserialize / Preact ハイドレーション / 約240 DOM 初回マウント の4サブ予算を個別計測 | compute ≤1100ms / IDB+parse+deserialize ≤450ms / ハイドレーション ≤250ms / DOM ≤200ms(合計 ≤2000ms)。超過時は catch-up 可変ドラフト + 粗粒度で compute 削減、DOM 仮想化で render 削減 |
| 2 | GC/メモリ予算(ADR-029) | catch-up 中の JS ヒープ増分ピークと GC ポーズを Worker 可変ドラフト方式で計測 | ヒープ増分ピーク ≤48MB・GC ポーズ ≤50ms/回。超過ならドラフト更新粒度をさらに粗く |
| 3 | 夜間 sim の実測 sec/run 校正(ADR-014) | 校正 run(代表 seed 数本)で `measuredSecPerRun` を計測し `shards=min(20, ceil(totalRuns×measuredSecPerRun/targetWallClock))` を導出。粗粒度10分 tick で最大 138,240 ベルヌーイ判定/run の実コストを実測 | 同時実行20上限内で週次 11000 runs(20シャード×550)が 360分キャップに十分余裕(目標 <30分) |
| 4 | Fallback 発動時の再校正(ADR-014) | 1分 tick へ戻すと (C) step 数10倍化ゆえ `measuredSecPerRun` を再計測し shards 再導出 | 再導出後も20上限内で 360分キャップ余裕 |
| 5 | MVP 粗粒度10分 tick の体感両立(ADR-009) | 代表10盤面で想起困難発生頻度を計測 | §11.4-8「週1〜3回/住民」レンジ内かつ夜間 batch 枠内。不成立なら該当系のみ1分 tick へ戻す or 段階2前倒し(いずれも shards 再校正) |
| 6 | 段階2高速実装のカスケード被覆(ADR-018) | next-reaction + fpLog 導入時、カスケードレジストリの各跨ぎ依存(例:襲撃死→bond 士気ペナ→recallRisk 再サンプリング)を実トリガーする seed/bot 組合せをオラクル一致テストが踏むか確認 | 全レジストリエントリが敵対 bot 6種で強制トリガーされオラクル一致維持。踏まない依存はレジストリ/bot 設計に追加 |
| 7 | クロスブラウザ golden vector 一致(content 本線ゲート・ADR-017) | Chromium/Firefox/WebKit で、その週の新規/変更 entity を踏む代表 seed の状態ハッシュを突合 | 3エンジン完全 bit 一致。実 iOS Safari(BrowserStack 相当)で定期補完。乖離時は engine 当該演算を fp/整数へ矯正 |
| 8 | Worker 越し state 転送コスト(ADR-019/029) | catch-up 時の content 1回転送 + 完了スナップショット1回の structured clone オーバーヘッドを実機計測 | 転送込みで2秒予算内 |
| 9 | 44px 角での4重符号化 + タグ7種記号の可読性(ADR-003) | 色+記号+パターン+数値およびタグ固有記号を最小表示スケール(ピンチ縮小)で判読可否計測 | WCAG(非テキスト 3:1・テキスト 4.5:1)充足かつ縮小時判読可。最小線幅/密度を UI スタイルガイドへ記載 |
| 10 | ITP 7日免除の一次挙動(設計は非依存化済み・ADR-004) | standalone/非 standalone での IDB/localStorage 削除挙動を実機再検証 | 設計はバナーを最終起動 monotonicTimestamp のみでトリガーする防御実装ゆえ ITP 挙動仮定に依存しないが、免除条件を確認し促進強度を調整 |
| 11 | 週次インタラクティブセッションの消費量(ADR-021) | bisection 最大約5フルゲート + schema reject 再試行を含むトークン/時間概算を実セッションで計測 | Pro/Max 週次上限に余裕。超過傾向なら content 投入単位を分割 |
| 12 | 1エンティティ制作素工数 | event(choices 分岐で 1.5→2〜4h)含む実測で 56〜150h レンジのどこに収まるか計測 | 15〜17週を再計算。段階1(粗粒度・fpLog なし・xoshiro)完成をデータ層 + tick エンジン 13.1 目標に再設定した妥当性を確認 |

#### [2026-07-27裁定] 計測項目への注記(裁定D1〜D6)

**#1 オフライン復帰2秒予算**

- 450ms(IDB+parse+deserialize)が想定するセーブサイズは **ADR-012(2) の容量目標 512KB**(上限側)とする(**D1**)。
- 1100ms(compute)は **cold(ウォームアップ)側に適用**する(**D2**)。実機の実復帰は cold であるため。**実機計測では cold / warm を必ず両方併記**すること。
- `indexedDB.open()` は 450ms 予算に**入れない**。「ページで最初に IDB へ触るまでの固定費」は `idbFirstTouchMs` という**補助メトリクス**として別枠で報告する(**D3**・ADR-012(4) の文言は不変)。

**#2 GC/メモリ予算**

- **GC ポーズは実機で自動収集する手段が無い**(CDP は Chromium + Playwright/DevTools 前提であり、実機ブラウザ上のページからは取得できない)。したがって**デスクトップ実測値を代替値として判定に用いる**(**D4**)。採用値は保守側の **最大 0.83ms**(3回連続実行のレンジ上端。代表1回分は 0.429ms)であり、予算 50ms に対し 2 桁の余裕がある。実機では GC ポーズを未計測のまま閉じる。
- **ヒープ増分は iOS Safari では原理的に計測不可**(`performance.measureUserAgentSpecificMemory()` は Chromium 系 API であり、配信方法を変えても iOS では解決しない)。よって #2 のヒープ判定は **Android 実機の実測値 + iOS は間接指標(catch-up 実行時のクラッシュ/タブ強制リロードの有無)**の組合せで行う(**D5**)。iOS で数値が出ないことを不合格とは扱わない。

**#7 クロスブラウザ golden vector 一致**

- 判断基準欄の「実 iOS Safari(BrowserStack 相当)で定期補完」について: **Playwright の WebKit は Apple が出荷する Safari / WKWebView とはビルドが異なる独自ビルドであり、実 iOS Safari の代替にはならない**(**D6**)。3エンジン一致は「Chromium/Firefox/WebKit(Playwright ビルド)の範囲での合格」であって iOS Safari の一致を含意しない。定期補完は実機で `dist/device/harness.html` を開いて結果 JSON を回収する経路で行う(`docs/measurements/device-testing-guide.md` §5.3)。結果 JSON 側にも `webkitCaveat` フィールドで同旨を機械可読に持たせてある。

---

## 残余リスク

以下は最終レビュー後も構造的にゼロ化できず、正式に受容・明示する残余。

1. **段階2 逆CDF カスケードの安全網はテストのみ(構造保証は MVP 段階1に限る)** — 段階1の per-step 全再評価オラクルは依存グラフ列挙不要で構造的に見落とし不能だが、段階2 next-reaction 導入時はカスケードレジストリの人力保守が正当性の要で、レジストリ漏れは(bit 再現性は保つ / golden・manifest に掛からない / 差分オラクルが該当 seed を踏まない限り検出されない)3経路で見逃されうる。オラクル自体のバグは共通原因になりうる(仕様手計算ベクタで別途検証するが原理的にゼロ化不可)。ADR-018 で正式明記した限界。

2. **Anthropic 課金の壁は CI/guardrail で強制不能** — PR 生成の課金経路(Pro 対話枠か API キー従量か)は git diff から原理的に判定できず、preflight(API キー検出で起動中止)と API 連携 workflow 排除と README 消費見積りで機械強制可能な部分は固めたが、上限超過時に運営者がとっさに API キー課金へ切替える人的逸脱は CI で防げない。避けたい fatal シナリオへの最終防波堤は運営者の自己規律のみ(ADR-021)。

3. **独立ヘルスビーコンの偽装は完全防止不可** — 公開クライアント配布ゆえ HMAC 鍵は原理的に抽出可能で、署名 + レート制限 + 送信元検証 + 2信号照合(ビーコン単独ではロールバック起動させない)で影響を限定するが、鍵抽出 + Sentry/報告の同時偽装が成立すれば誤ロールバック誘発の残余が残る(ADR-022・リリース後)。

4. **iOS Safari ストレージ揮発の離脱層全損** — ITP 免除挙動への依存は防御的タイムスタンプ設計で切り離したが、ホーム追加後7日以上未起動の離脱層(継続率リスク層そのもの)にはエクスポート促進バナーが届かず全損リスクが残る。バックエンド無しゆえアーキテクチャで緩和できる上限に達している。

5. **sunset 旧版退役は凍結ビルドのホスト継続に依存** — ライブレジストリは3世代ハード上限化し HEAD から旧実装を物理削除したが(ADR-025)、非同意プレイヤー向けの凍結アーカイブビルド(固定 URL)を無期限ホストし続ける必要があり(Cloudflare 無料ゆえ現金コストは実質ゼロだが)、URL と版対応表の保守が残る。非同意者はゲーム改善を受けられない分岐に留まる。sunset 時の再シード移行は周回進行に一度だけ非連続を持ち込む。

6. **(B) 一回性喪失の情緒的手触りはプレイテスト依存(§14-1)** — memoirLog/bond/記憶可視化を MVP 実装しても決定論テンプレが有機的物語の厚みに届くかは未検証で、届かなければ「名前付きレアドロップ損失」に留まる。設計では解消不能。

7. **配置パズルの固定化(§14-2)** — タグ7種 × 施設14種 × 8近傍の組合せ空間は本質的に小さく、過密ペナ + シード揺らぎでも周回で別の単一準最適に再収束しうる。static 判定・完全情報公開ゆえ初回攻略でほぼ解ける構造は残る。

8. **静的グラフ解析の網羅限界(§14-10)** — (A) 再取得保証は住民の生死・記憶状態・実地要件の動的条件モデル化精度に依存し、全状態空間網羅は原理的に不可能。敵対 bot 6種で漏れを減らすが稀なエッジの本番顕在化は残る。

9. **golden vector アンカーの死角** — algoVersion bump を golden vector 変化にアンカーしたが(ADR-016)、代表 seed 群が確率系・区間分類・許可リスト Math 境界を踏むよう十分被覆できていないと「golden 不変だが実挙動変化」の死角が残る。seed 群の被覆設計は open question。

10. **engine 純粋性・決定論 critical の線引き維持コスト** — DOM/Date/Math.random/非許可 Math/localeCompare/生スプレッド/レジストリ外 domainTag/content 直接走査 の禁止を lint と決定論ゲートで機械強制するが、決定論 critical ファイルの線引きと lint ルール網羅自体を人間が正確に維持する必要があり、漏れたファイルへの混入は起動時 self-check(ADR-017)が最後の砦でも本番顕在化まで気づかない経路が残る。

11. **クロック前進 exploit とシード共有の公平性(§14-7)** — worldSeed 導出・bot 戦略・レート制限が公開リポで可視、エクスポート整合ハッシュは破損検出用で改竄耐性ゼロ(セーブ直接編集→ハッシュ再計算→再インポート可能)。クロック前進と合わせ疑似競争の公平性は自己申告依存。バックエンド無しゆえ原理的に完全防止不可。

12. **MVP 運用基盤後回しとソロ運営の人間依存** — 自動ロールバック・多系統通知・Worker Cron/Sentry/ntfy はリリース後(ADR-022)ゆえリリース直後の初動が人間依存。60日失効は自動 PAT heartbeat(ADR-004)で運営者セッションから独立化したが、リポジトリ完全無活動時は最終的に失効しうる(=ゲーム本体は動作継続・content 供給停止は縮退設計として受容)。CODEOWNERS 二役分離(ADR-030)も運営者が human 承認を形骸化させる運用逸脱は防げない。

13. **工数の暫定性(§14-12)** — 15〜17週は計測前の暫定逆算。段階2追加・コンテンツ単価の振れ・1エンティティ sim 通過イテレーション超過・1人 + AI で UI 12画面/アシスト/バランス/クロスブラウザ検証を並行できるかがスケジュール残余リスク。
