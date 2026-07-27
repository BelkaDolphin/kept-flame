# エンティティ・オーサリング手順書(先行計測 #12 向け)

作成日: 2026-07-26 / 用途: 週次 LLM 運営セッションが tech/facility/event を1本追加するときに従う命令形手順。先行計測 #12(制作素工数の実測)のためにも使う。

根拠文書: `docs/企画書_継ぐ火_GDD.md` §5(テックツリー) / §6(コロニーと配置) / §7.7(獲得と規模) / §8(探索) / §11.1(経済数式) / §12.1〜12.2(コンテンツスキーマ・cond DSL) / `docs/技術設計書_継ぐ火_ADR.md` 「entity スキーマ」608〜641行 / ADR-011(ID正規表現・jsep) / ADR-024(グローバルID一意性) / `schema/*.ts`(自前検証器の実体・正本)

**この手順書はスキーマの日本語版ドキュメントではない。** 各フィールドの正確な型・レンジは `schema/tech.ts` / `schema/facility.ts` / `schema/event.ts` を都度確認すること(スキーマ側が正本、本書はそれをどう埋めるかの手順)。

---

## 0. 開始前チェック

1. `content/*.json` を読み、ID衝突が起きないことを目視確認する(**`content/*.json` は直接編集禁止**。新規エンティティは別ファイルに置き、正式追加はレビュー・別タスクで行う)。
2. 追加する対象が GDD 12.4「週次LLM運営」の許可範囲内か確認する: tech は既存壁テック配下の**葉のみ**(`leaf: true`、既存 entity の `prereqs`/`unlocks` 改変禁止)、facility は既存タグ組合せ範囲内、event は新規探索イベント。新メカニクス追加はスコープ外。
3. `npm run typecheck` と `npm test -- tests/schema` が現状 pass することを確認してから着手する(壊れた状態から始めない)。

## 1. ID 命名規則(全カテゴリ共通)

- 正規表現 `^[a-z][a-zA-Z0-9_]*$`(`src/engine/state/state.ts` の `ENTITY_ID_PATTERN` が唯一の正本。ADR-011)。小文字始まり、英数字と `_` のみ、ハイフン/日本語/大文字始まり不可。
- **全カテゴリ横断でグローバル一意**(ADR-024(1))。`tech`/`facility`/`trait` を横断して同一IDは reject される(`schema/idRegistry.ts` の `checkGlobalIdUniqueness`)。`event` は現状 `ContentBundle` に非組込み(§5参照)なのでこの自動チェックの対象外 — **手動で** `content/*.json` の全ID一覧と突き合わせて重複がないか確認すること。
- 慣例: カテゴリ接頭辞 + キャメルケース(`techFireStarting` / `traitScholar`)。facility は接頭辞なし(`hearth` / `forge`)。event は `event` + 距離帯 + 内容(`eventNearRubbleField`)を推奨。

## 2. 1e6 固定小数点の6桁 floor 規則(**最重要・T7で実際に既存contentのバグを検出した教訓**)

ADR-006 は全数値を 1e6 スケールの固定小数点で扱うと定める。`schema/engineContent.ts` の `rawFromHumanNumber` は人間可読値を **10進文字列経由で厳密変換**し、**小数第7位以降に有効桁がある値は reject**(黙って丸めない)。

- `lvCurve` は `base × 1.15^(Lv-1)` で機械的に計算するが、**倍精度の展開値をそのまま書くと高確率で小数第7位以降に有効桁が残る**。実例: `forge.lvCurve[4]`(Lv5)は `150 × 1.15^4 = 262.3509375` だが、小数第7位が `5`(非ゼロ)のため 1e6 で表現不能。正しい値は **切り捨て(floor)** した `262.350937`。
- **手順**: `lvCurve` を計算したら、各値の小数点以下を数え、7桁目以降に非ゼロがあれば6桁で切り捨てる(四捨五入ではなく floor。ADR-006「除算は切り捨て方向に統一」と整合)。
- **確認**: 迷ったら値をそのまま JSON に書いて `schema/engineContent.ts` の `loadEngineContent`(または後述 §6 のスクリプト)に通す。7桁目以降に有効桁が残っていれば `rawFromHumanNumber` が reject して教えてくれる(このために存在するガードなので、迷ったら通して確認するのが最速)。
- 同じ注意が `researchCost` の逓増式(`base_era × 1.2^n`、目安レンジのみ・§12.3)や `balance` の各種係数にも当てはまるが、tech/facility の schema は entity 個別値を直接書くので影響が大きいのは主に `facility.lvCurve` である。

## 3. tech の作成手順

参照: GDD §5.1(コスト設計)/ §5.2(時代骨格)/ §7.4(技術喪失の二層)/ §12.1/ §12.4。スキーマ正本: `schema/tech.ts`。

1. **era を決める**(`e1`/`e2`/`e3` のいずれか。MVP範囲。文字列は自由形式だが GDD 5.2 の表記に合わせる)。
2. **prereqs を決める**(0〜3個。既存 tech の実在ID。**既存 tech の `prereqs`/`unlocks` は書き換えない** — GDD 12.4「leaf限定」。自己参照は reject される)。壁テック配下の横展開なら prereqs は既存の葉直前の tech、またはその葉自身。
3. **lossClass を決める**: 通常の葉テックは `criticalRecoverable`(GDD 7.4 (A))。`rareIrreversible`(B)は「希少特性・銘設計図・習熟ボーナス・探索一点物」向けであり、通常の生産/研究テックには使わない。
4. **researchCost を決める**: 正の整数。§12.3 の目安式 `base_era × 1.2^n`(n=クリティカルパスのみ算入・葉テックはnに算入されない)の近傍に置く。`schema/tech.ts` は形式チェック(正の整数)のみで式の突合は行わない(スコープ外、ファイル冒頭コメント参照)ので、既存 era 内の値(例: e1 は 25〜36)を目分量で参考にする。
5. **fieldRequirement を決める**: `{ facility, recipe, count }`。`facility` は既存 facility の実在ID(**cross-ref で実在確認される** — `contentBundle.ts` の `checkCrossReferences`)。`recipe` は recipe カテゴリが T6/T7 のロード対象外のため実在確認されない自由形式IDだが、命名規則(§1)には従うこと。`count` は 1〜1000 の整数。
6. **leaf を決める**: 週次追加テックは基本 `leaf: true`(GDD 12.4)。壁テックや中間ノードは `false` だが、それらは人間レビュー案件でありLLM運営の通常追加範囲外。
7. **unlocks を決める**: 葉テックは通常 `[]`(GDD 12.4「既存entityのprereqs/unlocks改変禁止」の裏側で、新規葉テックが他の葉を unlocks することは想定されていない)。

## 4. facility の作成手順

参照: GDD §6.1(格子・施設14種)/ §6.2(隣接行列・タグ7種)/ §6.7(オーバーフロー)/ §7.7 / §11.1(経済数式)/ §12.1。スキーマ正本: `schema/facility.ts`。タグの正本は `FACILITY_TAGS`(`docs/design/tags-spec.md` 末尾の機械可読JSONが出典)。

1. **tags を決める**(1個以上、`heat`/`clean`/`foul`/`noise`/`damp`/`calm`/`lore` の部分集合、重複不可)。GDD 6.2 の隣接ルール表(例: 「湿潤×菜園→食料+15%」)を見て、施設の実態に合うタグを選ぶ。**GDD はタグ名を日本語(熱源/清浄/汚染/騒音/湿潤/静穏/学芸)でしか書いておらず、英字IDとの対応は `tags-spec.md` が正本**(GDD 本文に対応表がない場合は tags-spec.md を確認すること)。
2. **slots を決める**: `lv1`〜`lv5` の整数(0〜20)。**Lv が上がるにつれ単調非減少が必須**(GDD 7.7)。
4. **lvCurve を決める**: `base × 1.15^(Lv-1)` を Lv1〜Lv5 の5値、**狭義単調増加**が必須。§2 の6桁floor規則を必ず適用すること(このステップが最も事故りやすい)。
5. **footprint を決める**: `width`/`height` はそれぞれ1〜2(GDD 6.1「1セル=1施設、大型は2×1/2×2占有」)。
6. **overflowCapPolicy を決める**: 自由文字列(enum強制なし)。既存値(`convertToWaste`/`discardExcess`)の意味に合わせて再利用するか、GDD 6.7 の3出口(増築コスト代替/成文化代替/研究点変換)に合う新しい policy 名を与える。
7. **harshWork を決める**(必須。省略不可): GDD 11.2 の過酷業務(製錬/鍛冶/高炉等)なら `true`、通常業務なら `false`。**この値は engine の想起困難(C)判定の loadW(×2.0 or ×0.5)に直結する**ため、欠落は `schema/engineContent.ts` が reject する。
8. **output を決める**(必須。省略不可): `{ "kind": "research" }` または `{ "kind": "resource", "resourceId": "..." }`。resource の実在確認は行われない(resource カテゴリが T6/T7 のロード対象外のため)。
9. **adjacency.json 隣接ルールの受け手チェック**[2026-07-27追記]: GDD 6.2 の隣接ルール表(タグ×タグ効果、例:「湿潤×菜園→食料+15%」)を確認し、新facilityがいずれかのルールの「受け手」(target側)に該当するかを判定する。該当する場合、`content/adjacency.json` は CODEOWNERS 指定の人間専用ファイルのため LLM は編集できない(§0-1 の `content/*.json` 直接編集禁止と同じ制約)。対応要否を次の手順で判定すること: (a) 該当タグペアが既に `content/adjacency.json` に登録済みなら追加対応不要、(b) 未登録ならタグペアと効果値を報告書に「人間への依頼事項」として明記し、実装は本タスクのスコープ外として持ち出さない。対応不要と判断した場合もその判断根拠(どのルールを確認し、なぜ受け手に該当しないと結論したか)を報告書に残すこと。**このチェックの必要性は先行計測#12 実施時に実際に当たった曖昧さ(`docs/measurements/authoring-times.md` §2.3・§5 — 「湿潤×菜園」ルールがタグペアかfacility ID指定かが `adjacency.json` の現存データだけでは一意に読み取れなかった事例)に基づく。**

## 5. event の作成手順

参照: GDD §8.1(派遣)/ §8.2(決定論解決)/ §8.3(質的分岐)/ §8.4(帰還報酬とログ)/ §12.1/ §12.2(cond DSL)。スキーマ正本: `schema/event.ts`(**スタンドアロン検証器。engine には非接続**、詳細は §6参照)。

1. **destTags を決める**: `near`(近郊)/`far`(遠隔)/`deep`(深部)の1〜3個。**この英字IDは `schema/event.ts` がオーサリング側で暫定採用したもので、GDD本文に対応する英字ID正本は無い**(facility タグの `tags-spec.md` に相当する文書が距離帯には存在しない。要ユーザー判断・既知の穴)。
2. **nodes を3〜8個作る**(GDD 8.2「イベント列(3〜8ノード)」)。各ノードは踏破/遭遇/遺構解読/罠のいずれかの判定種別を想定するとよい(GDD 8.2「関連ステータスはイベント種別で変わる」)。
3. 各ノードの **difficulty** と **R**(ロール上限。`成否 = 総合力 + 装備補正 + seededRoll(0..R) ≥ difficulty`)を正の数で決める。
4. 各ノードの **statWeights** を決める(stat名→重み[0,1]、1個以上)。**stat名の英字IDにも正本が無い**(GDD 7.1 は体力/器用/知性/頑健/意志を日本語でのみ列挙。`trait.ts` の `stat` フィールドと同じ「自由文字列」の扱い — 既知の穴、§7参照)。踏破=体力/頑健、遭遇=戦力、遺構解読=知性、罠=器用(GDD 8.2)の対応を目安にする。
5. 各ノードの **choices** を0〜4個作る(GDD 8.3「二択」想定。全ノードに必須ではない)。各 choice は `{ label, effect }`。`effect` は `successMod`/`rewardMod`/`difficultyMod`(いずれも -1〜1)/`injuryRiskMul`(0〜5)のうち**最低1個を指定**(全省略は無効果choiceとして reject)。GDD 8.3 の「慎重=成功率+/報酬-」は `successMod>0, rewardMod<0`、「大胆=報酬+/難度+」は `rewardMod>0, difficultyMod>0`、「強行=負傷リスク×1.5」は `injuryRiskMul` で表す。
6. 各ノードの **branches** を1〜8個作る。各 branch は `{ cond, result, logTemplate }`:
   - **cond**: GDD 12.2 のホワイトリストに従う。使える識別子は `teamPower`/`difficulty`/`statWeights`/`injuryCount`/`equipType` のみ、関数は `hasTrait(<literal>)`/`maxStatHolder(<literal>)` のみ(引数は必ず1個・リテラル)、演算子は `==`/`!=`/`<`/`<=`/`>`/`>=`/`&&`/`||` のみ。**プロパティアクセス(`statWeights.vigor` 等)・単項否定(`!`)・三項演算子は使えない**(`schema/event.ts` が reject する。GDD 12.2 が列挙する演算子に単項否定が含まれていないため)。否定が必要な場合は `hasTrait('x') == false` のように書く。
   - **result** / **logTemplate**: 自由文字列(意味論の正本なし。GDD 8.4 のログスナップショット思想に合わせ、`logTemplate` は帰還ログにそのまま埋め込まれる完成文相当の文面にする)。
7. 迷ったら小さく作って都度検証器に通す(§6)。cond の構文が通るかは机上で判断せず必ずスクリプトで確認すること(jsep のパーサ挙動は直感と違う場合がある — 例: `&&`/`||` も内部的には `BinaryExpression` 扱い)。

## 6. 相互参照の確認

- **tech**: `fieldRequirement.facility` は既存 facility の実在ID必須(`contentBundle.ts` の `checkCrossReferences` が検証)。`prereqs` は既存 tech の実在ID必須、かつ循環参照は reject(DFS検出)。
- **facility**: 現状 facility 側から他カテゴリへの必須cross-refはない(`resourceId` は実在確認なし)。
- **event**: **`ContentBundle` に非組込み**(スキーマ検証は `validateEvent()` 単体呼び出しのみ)。他カテゴリとの相互参照(例: cond 内の trait ID)は自動検証されない — 手動で `content/trait.json` を見て存在確認すること。
- **ID一意性**: tech/facility/trait は `checkGlobalIdUniqueness`(`schema/idRegistry.ts`)が自動検証。event は前述の通り手動確認。

## 7. 検証器の回し方

1. 型チェック: `npm run typecheck`
2. lint: `npm run lint`
3. 単体検証(最速フィードバック): 一時スクリプトまたは `node --experimental-strip-types --import ./tools/tsLoaderRegister.mjs` 経由で `validateTech`/`validateFacility`/`validateEvent` を直接呼び、`result.ok` と `result.issues` を確認する。issues は**1回の呼び出しで全欠陥を報告する**設計(`schema/common.ts` の `IssueCollector`)なので、reject されたら表示された issues を全部読んでから直す(1件ずつ直して再実行を繰り返さない)。
4. tech/facility は最終的に **本物の content とマージして** `validateContentBundle` → `loadEngineContent` まで通すこと(cross-ref・engine 語彙写像まで確認する。`docs/measurements/authoring-samples/` のサンプルはこの形でテスト化されている)。
5. event はスタンドアロンなので `validateEvent()` の `ok:true` 確認のみでよい。
6. `npm test` で既存テスト(golden vector 含む)に影響がないことを最終確認する。

## 8. 既知の落とし穴(要ユーザー判断・毎回当たりうる)

1. **GDD 6.2 の隣接効果に英字ID正本が無い**(`golden-vector-spec.md` §8-3)。`ENGINE_EFFECT_BY_CONTENT_EFFECT`(`schema/engineContent.ts`)が暫定の対応表を持つが、新しい効果を足す場合は engine 側の対応も要る。
2. **GDD 8.1 の距離帯(近郊/遠隔/深部)に英字ID正本が無い**(本書 §5 で `near`/`far`/`deep` を暫定採用。今回の event オーサリングで実際に踏んだ)。
3. **GDD 7.1 のステータス名(体力/器用/知性/頑健/意志)に英字ID正本が無い**(`trait.effects[].stat` および `event.nodes[].statWeights` のキーが自由文字列なのはこのため。今回の event/tech オーサリングで実際に踏んだ)。
4. **1e6 固定小数点の6桁floor**(§2)。`lvCurve` を計算するたび必ず確認する。

## 9. 工程境界タイムスタンプ打刻(必須)[2026-07-27追記]

先行計測#12 の初回実施(`docs/measurements/authoring-times.md` §0-1・§6-1)では、対話セッション内から絶対時間(wall-clock)を取得する手段が無く、着手〜検証passまでの経過時間を実測できなかった(自己申告すると推測値になり、CLAUDE.md「確信度が低い情報は明記せよ」に反する)。次回以降の計測では以下を**必須**とする。

1. tech/facility/event いずれのカテゴリを作成する場合も、以下4点の工程境界で必ず PowerShell の

   ```
   Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
   ```

   を実行し、**その生の標準出力をそのまま**報告書に転記すること(要約・丸め・後からの推測での穴埋めは禁止)。

   1. **参照読了時**: §0 の許可範囲確認、および対象カテゴリの GDD/ADR/schema 該当節(§3〜§5 冒頭の「参照」記載範囲)を読み終えた時点。
   2. **JSON化開始時**: §3/§4/§5 の該当手順に沿ってフィールド値を実際に書き始める直前。
   3. **初回検証実行時**: §7 の検証器(typecheck/lint/`validateTech`等/`validateContentBundle`)を最初に実行する直前。
   4. **pass確定時**: §7 の検証器が `ok:true`(または該当テストが全て pass)であることを確認した直後。

2. **mtime(ファイル更新時刻)による代替は不可**。`prettier --write` 等の後工程がファイルの mtime を実際の作成順と無関係に上書きするため、参考にならない(`authoring-times.md` §0-2 で実際に確認された制約)。
3. 4点いずれかの打刻を忘れた場合は、経過時間を推測で埋め合わせず、報告書に**「打刻漏れ」と正直に明記**すること。打刻漏れがあっても、実測できた他の指標(reject回数・構造的複雑度・参照範囲・テスト結果)の報告は妨げられない。

## 10. cond DSL 合格例/不合格例対照表(GDD 12.2)[2026-07-27追記]

`schema/event.ts` の cond DSL ホワイトリスト(§5 手順6・冒頭コメント「2. cond DSL ホワイトリスト」)は文章だけでは初見で誤りやすい(`authoring-times.md` §6-3 の指摘)。以下は実際の検証器(`walkCondNode`)の挙動と一致することを確認済みの合格例/不合格例である。合格例・大半の不合格例は `tests/schema/event.test.ts` の既存テストケースで裏取りしている(該当テスト名を「裏取り」列に記載)。ArrayExpression の行のみ既存テストに直接のケースが無いため、`validateEvent()` を直接呼び出して実行確認した(MemberExpression/UnaryExpression/ConditionalExpression と同じ `walkCondNode` の `default` reject 経路であることを出力メッセージで確認済み)。

| cond 式 | 判定 | 理由 | 裏取り(`tests/schema/event.test.ts`) |
|---|---|---|---|
| `teamPower >= difficulty` | 合格 | 許可識別子2個 + 許可演算子 `>=` のみの `BinaryExpression` | 「有効な event を受理する」 |
| `teamPower >= difficulty && injuryCount == 0` | 合格 | `&&`/`\|\|` も jsep 内部では専用ノード種を持たず `BinaryExpression` 扱い(GDD 12.2 許可演算子内) | 「&& / \|\| を含む cond を受理する」 |
| `hasTrait('traitScholar') == false` | 合格 | 許可関数 `hasTrait`、引数はリテラル1個。単項否定 `!` が使えないため否定は `== false` で表現する | 「hasTrait / maxStatHolder 関数呼び出しの cond を受理する」 |
| `maxStatHolder('dexterity') >= difficulty` | 合格 | 許可関数 `maxStatHolder`、引数はリテラル1個 | 同上 |
| `statWeights.vigor >= difficulty` | reject | `MemberExpression`(プロパティアクセス)は許可ノード種に無い | 「MemberExpression(プロパティアクセス)を reject する」 |
| `!hasTrait('traitScholar')` | reject | `UnaryExpression`(単項否定)は GDD 12.2 の許可演算子に含まれない | 「単項否定(!)を reject する」 |
| `teamPower >= difficulty ? true : false` | reject | `ConditionalExpression`(三項演算子)は許可ノード種に無い | 「三項演算子を reject する」 |
| `teamPower >= [1, 2]` | reject | `ArrayExpression` は許可ノード種に無い(`walkCondNode` の `default` 分岐で reject) | 既存テスト無し・`validateEvent()` 直接実行で確認(本追記時点) |
| `evalArbitrary('x') == true` | reject | 許可関数リスト(`hasTrait`/`maxStatHolder`)に無い関数呼び出し | 「未許可の関数呼び出しを reject する」 |
| `unknownVar >= difficulty` | reject | 識別子が許可リスト(`teamPower`/`difficulty`/`statWeights`/`injuryCount`/`equipType`)に無い | 「未知識別子を reject する」 |
| `teamPower + 1 >= difficulty` | reject | 演算子 `+` が許可リスト(`==`/`!=`/`<`/`<=`/`>`/`>=`/`&&`/`\|\|`)に無い | 「許可リスト外の演算子(+)を reject する」 |
| `hasTrait('a', 'b') == true` | reject | 許可関数の引数は1個のみ許可(実際は2個) | 「許可関数の引数が2個以上だと reject する」 |
