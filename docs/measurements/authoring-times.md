# 先行計測 #12: エンティティ制作素工数の実測 — 結果報告書

作成日: 2026-07-26 / 実施: Claude(対話 Claude Code セッション、Sonnet)/ 対応: `docs/先行計測計画_ドラフト.md` §5.2 #12・GDD §13.2「1エンティティ制作時間の実測」

参照: `docs/measurements/authoring-procedure.md`(手順書)/ `docs/measurements/authoring-samples/*.json`(実測対象サンプル)/ `schema/event.ts`(今回新設)/ `tests/schema/event.test.ts`・`tests/measurements/authoringSamples.test.ts`(検証)

---

## 0. 方法論の限界(先頭に明記・重要)

**本計測は LLM 対話セッションでの実測であり、人間単独作業の見積りではない。** 加えて以下の限界がある:

1. **絶対時間(wall-clock)を対話セッション内から直接取得する手段が無い。** 本タスクはサブエージェント(このセッション)として実行されており、実行環境のシステム時計を各工程の境界で明示的に記録していない限り、着手〜検証passまでの「経過時間」を秒/分単位で正確に自己申告することはできない(自己申告すると実測値ではなく推測値になり、CLAUDE.md「確信度が低い情報は明記せよ」に反する)。**時刻ブラケット(`date`/`Get-Date`)を各工程の境界で明示的に叩く運用を次回計測から追加すべき**(§6「手順書の改善点」に記載)。
2. 本セッションのファイル更新時刻(mtime)は工程順の参考にならない(最終段の `prettier --write` が対象ファイルの mtime を上書きするため、実際の作成順と食い違う)。
3. 代わりに以下の**実測可能な指標**を報告する: ①検証 reject 回数(正確に測定可能。全て 0 回)②各エンティティの構造的複雑度(フィールド数・決定数・JSON行数、正確に測定可能)③参照した GDD/ADR/schema 範囲(正確に列挙可能)④テスト結果(pass/fail、正確に測定可能)。
4. **本セッションは「手順書を書いた本人が直後にサンプルを書く」順で実行した**ため、reject 0回という結果には**手順書執筆による事前知識(特に §2 の6桁floor規則)を持った状態で書いた**という順序効果(survivorship bias)が乗っている。手順書だけを渡された別セッション(または人間)が同じ0回を再現する保証はない。

---

## 1. 対象サンプルと検証結果

| カテゴリ | ID | 置き場所 | 検証経路 | 結果 |
|---|---|---|---|---|
| tech | `techCordage` | `docs/measurements/authoring-samples/tech.sample.json` | 既存 `content/tech.json` とメモリ上マージ → `validateContentBundle` → `loadEngineContent` | **pass(reject 0回)** |
| facility | `garden` | `docs/measurements/authoring-samples/facility.sample.json` | 同上(`content/facility.json` とマージ) | **pass(reject 0回)** |
| event | `eventNearRubbleField` | `docs/measurements/authoring-samples/event.sample.json` | `validateEvent()` 単体(スタンドアロン) | **pass(reject 0回)** |

検証はダミー実行ではなく本物の検証器(`schema/contentBundle.ts` の `validateContentBundle` と `schema/engineContent.ts` の `loadEngineContent`)を、既存 `content/*.json`(改変禁止)とサンプルをメモリ上でマージした状態で通している(`tests/measurements/authoringSamples.test.ts`、7件全て pass)。`content/*.json` 自体は本タスクを通じて一度も変更していない(`git status` で確認済み・末尾の tech/facility/trait 件数が T6/T7 時点の 3/3/2 のまま)。

`event` は `schema/event.ts` 冒頭コメントの通り engine ローダー・`ContentBundle` のいずれにも非接続(§4 参照)なので `validateEvent()` 単体呼び出しで検証している。

---

## 2. 実施内訳

### 2.1 共有した前提調査(3カテゴリで1回のみ実施・按分対象)

以下は3エンティティに共通する前提調査であり、実際の週次運営でも(スキーマ・GDDの当該節を初回に把握すれば)毎回繰り返す必要がない部分:

- GDD: §5(テックツリー)/ §6.1〜6.2(格子・隣接行列・タグ7種)/ §6.7(オーバーフロー)/ §7.1〜7.4/ §7.7/ §8.1〜8.4(探索)/ §11.1〜11.2/ §12.1〜12.4
- ADR: 「entity スキーマ」608〜641行(tech/facility/adjacency/balance/event の sketch)、先行計測12項目表(706行)
- `docs/design/golden-vector-spec.md` §1・§8(要ユーザー判断一覧。GDD 6.2 英字ID正本欠如の既知の穴を確認)
- `schema/common.ts`・`tech.ts`・`facility.ts`・`contentBundle.ts`・`idRegistry.ts`・`adjacency.ts`・`balance.ts`・`trait.ts`・`engineContent.ts`(自前検証器8ファイル全数)
- `content/*.json` 全5ファイル(既存ダミー・命名/値のレンジ感を掴むため)
- `tests/schema/validators.test.ts`・`contentBundle.test.ts`(既存テストの書き方の踏襲元)

### 2.2 tech(`techCordage`)

- **起案**: 既存の葉テック `techBasketWeaving` 配下に追加する E1 の葉テック(縄・紐)という設定。GDD 12.4「週次LLM運営は既存壁テック配下の葉のみ・既存 entity の `prereqs`/`unlocks` 改変禁止」に従い、既存 tech は一切変更していない。
- **決定した値**: `era`(e1)/ `lossClass`(criticalRecoverable)/ `prereqs`(1個)/ `researchCost`(28、既存 e1 テックの 25〜36 レンジを参考)/ `fieldRequirement`(既存 facility `workbench` を参照、`recipe` は recipe カテゴリ非実装のため自由命名)/ `unlocks`(空)/ `leaf`(true)。
- **JSON化**: 10行。フィールド8個、既存 schema(T6実装済み)にそのまま収まる形。
- **検証**: 1回で pass(reject 0)。
- **詰まった点**: 無し。`schema/tech.ts` が researchCost の目安式(§12.3)を検証しないスコープ外仕様であることを確認済みだったため、数値の厳密さで迷う場面がなかった。

### 2.3 facility(`garden`)

- **起案**: GDD 6.1 の施設14種のうち未実装の「菜園」(食料生産)。タグは GDD 6.2「湿潤×菜園→食料+15%」の記述から `damp` を選択(この隣接ルール自体は `content/adjacency.json` に未登録・本タスクでは追加していない。§4 の既知の穴参照)。
- **決定した値**: `tags`(`["damp"]`)/ `slots`(hearth と同型の Lv別スロット)/ `lvCurve`(base=90 から `×1.15^(Lv-1)` を Lv1〜Lv5 まで手計算)/ `footprint`(1×1)/ `overflowCapPolicy`(`convertToWaste` を既存 facility から再利用)/ `harshWork`(false、GDD 11.2 の過酷業務リストに菜園作業は含まれないため)/ `output`(`resource:grain`)。
- **JSON化での最重要工程 = lvCurve の6桁floor規則の適用**(手順書 §2): `Lv5 = 136.87875 × 1.15 = 157.4105625` は小数第7位に非ゼロ桁(5)を持ち 1e6 で厳密表現できない(`content/facility.json` の forge で T7 が実際に検出したのと**全く同型のバグ**)。本タスクでは事前に floor 規則を把握していたため `157.410562` へ切り捨てて記入し、reject を1回も踏まずに済んだ。
- **検証**: 1回で pass(reject 0)。`loadEngineContent` まで通過(`facilityDefs.get("garden")` を確認)。
- **詰まった点**: GDD 6.2 の「湿潤×菜園」ルールがタグ×タグ行列のどちらのタグペアに対応するのか(菜園自体のタグか、target側の facility ID 指定か)は `content/adjacency.json` の実データだけからは一意に確定できず、本タスクのスコープ(adjacency.json 変更禁止)外として深追いしなかった。実際の週次追加では、新施設が「隣接効果の受け手」になる場合に adjacency.json 側の変更(人間専用 CODEOWNERS)が別途必要になる可能性がある点は認識しておく必要がある。

### 2.4 event(`eventNearRubbleField`)— 2種類のコストの分離が必要

event は tech/facility と異なり **(a) スキーマの新規構築コスト**(`schema/event.ts` 本体・テスト22件)と **(b) content 1本の起案・JSON化コスト**が両方発生した。この2つを混ぜて報告すると GDD 13.2 の「event 1.5h→2〜4h」(= 定常運用時の1本あたり単価)との比較を誤らせるため、明確に分離する。

#### (a) スキーマ構築(1回限りの基盤投資。定常運用では発生しない)

- GDD 8.1〜8.4/12.1/12.2 と ADR entity スキーマ sketch(633行)から最小スキーマを設計。
- **cond DSL ホワイトリスト(GDD 12.2)の実装が最大のコスト**: jsep(既存 devDependency・ADR-011 で採用確定済み)の AST 形状を裸のまま信用せず、実際に Node で `jsep("teamPower >= difficulty")` 等5パターンを試し、`&&`/`||` も `BinaryExpression` として表現される(専用の `LogicalExpression` 型は無い)ことを一次資料(`node_modules/jsep/dist/jsep.js` 本体)で確認してから許可ノード種を確定した。GDD が列挙する許可演算子に単項否定(`!`)が含まれない点に気づき、`hasTrait('x') == false` という否定の書き方を手順書に明記した。
- `schema/event.ts`(487行)+ `tests/schema/event.test.ts`(229行・22テスト、合格系3+構造不合格系9+cond DSL不合格系9+1件の長さ超過)。
- **設計判断としてスタンドアロンに留めた**(§4 参照)。

#### (b) content 1本(`eventNearRubbleField`)の起案・JSON化

- **起案**: 近郊(near)距離帯、GDD 8.2 の4判定種別(踏破/遭遇/遺構解読/罠)に対応する4ノード構成。
- **決定した値**: ノードごとに `difficulty`/`R`/`statWeights`(stat名は自由文字列、GDD 7.1 に英字ID正本が無いため `vigor`/`fortitude`/`combatPower`/`intellect`/`dexterity` を暫定命名)/ `choices`(GDD 8.3「慎重/大胆」「撤退/強行」を `successMod`/`rewardMod`/`injuryRiskMul` の3軸で表現)/ `branches`(cond は許可識別子・関数のみで構成、`hasTrait('traitScholar')` は既存 `content/trait.json` の実在traitを参照)。
- **JSON化**: 84行(4ノード×2〜3分岐)。tech/facility よりも1桁多い行数・意思決定数(destTags 1個・ノード4個×各5フィールド=20決定+分岐8本のcond設計)。
- **検証**: 1回で pass(reject 0)。
- **詰まった点**: cond の否定表現(`!`不可)、`statWeights`のオブジェクト参照(MemberExpression不可)など、スキーマ自作時に自分で決めた制約に自分で従う形になったため、実質的な「詰まり」は(a)の設計段階に前倒しされている。もし手順書だけを渡された別セッションがゼロから event を書けば、cond の許可構文をスキーマのエラーメッセージから学ぶ「reject→修正」往復が発生する可能性が高い(本セッションでは reject 0だが、これは手順書に §5 として否定表現の注意を明記したのが自分自身だったため)。

---

## 3. 56〜150h レンジへの外挿(定性的判断・時間の実測値ではない)

§0 の通り絶対時間を測定していないため、レンジ内の特定の時間数を主張することはできない。代わりに、**相対的な複雑度シグナル**から判断できることを述べる:

- **tech/facility は「既存スキーマに対する content 1本」であり、決定数・JSON行数・reject回数のいずれで見ても event より明確に軽い**(tech: 8決定・10行、facility: 8決定+lvCurve計算・10行、event content分のみ: 約28決定・84行)。GDD 13.2 が event を「choices追加で複雑化」として tech/facility 相当より重く見積もっている(1.5h→2〜4h への上方修正)方向性と、本セッションで観測した相対的な作業量の大小関係は**整合する**。
- **event の総コストは (a)スキーマ構築 + (b)content1本に分解でき、(a)は週次運営が一度きり払う基盤投資、(b)のみが「1エンティティ単価」として GDD 13.2 の反復コストに対応する。** (a)を(b)に混ぜて計上すると、event の見かけの単価を実態より過大に見積もることになる(=「なぜ event だけ極端に高いのか」を精査せず単純平均すると56〜150hレンジの上振れ要因を誤って event 個別の複雑さだけに帰属させてしまう)。**MVPの10本のevent(GDD 8.7)は全て同一スキーマを使い回すため、(a)は1回のみ発生し10本には分割されない**。
- reject回数が3カテゴリとも0だったことは、**「schema/手順書が正しく機能すれば1回で通る」という設計の再現性**を示す一次データではあるが、§0-4 の順序効果(手順書執筆者自身がサンプルも書いた)により、reject 0回を「週次LLM運営セッション一般でも再現される」と一般化することはできない。**先行計測#11(reject再試行コスト)の一次データとしては「今回は0件」とのみ報告し、複数の異なるセッション・異なる担当(人間レビュー含む)での再測定が必要**と記録する。
- 以上から、本計測は **56〜150h レンジの絶対値を確定させる情報を提供しない**(方法論上不可能)。ただし「event が tech/facility より重い」という GDD 13.2 の想定方向とは矛盾しない相対データが得られた。**次回計測では `date`/`Get-Date` によるフェーズ境界の明示的タイムスタンプ取得を必須にすること**(§6)。

---

## 4. event スキーマの設計判断(何を削ったか)

`schema/event.ts` 冒頭コメントに全て明記済みだが、要点を再掲する:

1. **engine 非接続・`ContentBundle` 非組込み(スタンドアロン)**: T5 の縮約 rules(production/research/recall の3本のみ、`state.ts` §3)は探索を消費しないため、engine 側の対応が無い状態で `ContentBundle` に組み込むと既存5カテゴリの検証結果に無関係な複雑度を持ち込むリスクがあった。「迷ったらスタンドアロンに留める」の指示に従いこちらを選択。
2. **`destTags` の英字ID(`near`/`far`/`deep`)はオーサリング側の暫定採用**(GDD 8.1 に英字ID正本が無い。§5 既知の穴)。
3. **`statWeights` のキーは自由文字列**(`trait.ts` の `stat` フィールドと同じ判断。GDD 7.1 のステータス名に英字ID正本が無いため)。
4. **`choices[].effect` は `successMod`/`rewardMod`/`difficultyMod`/`injuryRiskMul` の4軸フラット構造**。各軸の相互作用式(強行時の負傷リスク計算式そのもの等)は engine 実装時に確定するものとし、本スキーマは形式検証のみ。
5. **cond DSL は MemberExpression・UnaryExpression・ConditionalExpression・ArrayExpression 等を全面 reject**。GDD 12.2 が明記する演算子(`==`/`!=`/`<`/`<=`/`>`/`>=`/`&&`/`||`)のみで表現できる式に限定し、関数呼び出しは `hasTrait`/`maxStatHolder` の引数1個のみ許可。
6. **`result`/`logTemplate` は自由文字列**。値の意味論(結果種別の語彙、テンプレート変数構文)は正本が無いため検証していない。

---

## 5. 既知の穴に実際に当たったか

`docs/design/golden-vector-spec.md` §8-3 が報告している「GDD 6.2 の隣接効果表に英字ID正本が無い」という既知の穴は、本タスクでも**同型の穴を2箇所で新たに踏んだ**:

1. **GDD 8.1 の距離帯(近郊/遠隔/深部)に英字ID正本が無い** → `near`/`far`/`deep` を本タスクで暫定採用(`schema/event.ts` 冒頭コメント・本書§4-2)。
2. **GDD 7.1 のステータス名(体力/器用/知性/頑健/意志)に英字ID正本が無い** → `event.statWeights` のキーを自由文字列とする既存 `trait.ts` の判断を踏襲。

いずれもブロッキングではなく(自由文字列 or 暫定enum で回避可能)、GDD側に英字ID対応表を追記すべきという既存の要ユーザー判断リストに2件追加すべき事項として記録する。

facility.tags の選定時にも「湿潤×菜園」ルールの技術的対応関係(タグペア vs facility ID ターゲット)が `content/adjacency.json` の現存データだけでは一意に読み取れない、という新しい曖昧さに当たった(§2.3)。これは英字ID欠如とは別種の「隣接ルールのGDD記述→tagMatrix実装への変換規則が明文化されていない」という穴であり、adjacency.json 側の作業(人間専用 CODEOWNERS)が別途生じる可能性がある点として記録する。

---

## 6. 手順書の改善点

1. **フェーズ境界での明示的タイムスタンプ取得を手順に追加すべき**(§0)。`date`(bash)/`Get-Date`(PowerShell)を「参照読了時」「JSON化開始時」「初回検証実行時」「pass確定時」の4点で叩き、ログに残す。これにより次回以降は本物の経過時間が測れる。
2. **adjacency.json との関係(§2.3 の穴)を facility 手順(§4)に追記すべき**: 新 facility が既存 GDD 隣接ルールの受け手になる場合、`content/adjacency.json`(CODEOWNERS人間専用)側の対応要否を確認するチェック項目を追加する。
3. **event の cond DSL は「許可構文のサンプル集」を手順書に貼るとreject往復を減らせる**: 本タスクでは手順書執筆者自身がサンプルも書いたため reject 0 だったが、否定表現(`!`不可→`== false`で代替)や `&&`/`||` が同一 `BinaryExpression` として扱われる点は初見では気づきにくい。手順書 §5 に簡潔な合格例/不合格例の対比表を足すとよい(現状は文章のみ)。
4. **reject 回数の測定は「手順書を読むだけの別セッション」で再実施しないと先行計測#11の一次データとして弱い**。本報告の reject 0 は「手順書執筆者自身によるバイアスがかかった最良ケース」である旨を毎回明記すること。

---

## 7. テスト結果サマリ

- `npx vitest run tests/schema/event.test.ts`: **22 tests passed**
- `npx vitest run tests/measurements/authoringSamples.test.ts`: **7 tests passed**
- `npm test`(全体): **757 tests passed**(既存707件 + 本タスク追加50件、既存テストの回帰無し)
- `npm run typecheck`: pass(エラー無し)
- `npm run lint`: pass(エラー無し)
- `npm run format`: 本タスクが触った範囲は pass(未関係の並行作業ファイル `bench/perfBoard.ts`/`bench/perfGrid.tsx` に既存の未整形警告があるが、`bench/**` は本タスクの変更禁止範囲であり関与していない)
- `npm run golden:check`: **golden vector 37本、差分なし**(`content/*.json`・`src/engine/**` を一切変更していないため当然の結果だが、意図せぬ副作用が無いことの確認として実施)
