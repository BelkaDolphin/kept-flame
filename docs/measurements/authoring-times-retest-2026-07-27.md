# エンティティ制作素工数 再計測(#12 retest) — 2026-07-27

**実施条件: 手順書のみを渡された別セッション・過去計測結果は未読。**
`docs/measurements/authoring-procedure.md` の全文のみを唯一の作業指示として読み、`docs/measurements/authoring-times.md` / `docs/measurements/summary.md` / `MEMORY.md` / 既存 `docs/measurements/authoring-samples/*.json` の中身は本タスク開始時点で未読(汚染防止指示に従う)。既存サンプルの ID(`techCordage` / `garden` / `eventNearRubbleField`)は ID衝突回避のため `tests/measurements/authoringSamples.test.ts` の既存アサーションから間接的に把握したが、内容・所要時間・reject 履歴は未読のまま作業した。

制作物: tech 1本(`techSimpleBedding`)/ facility 1本(`reservoir`)/ event 1本(`eventNearOldCistern`)。いずれも `content/*.json` は無編集、`docs/measurements/authoring-samples/` に新規ファイルとして追加(既存ファイルの上書きなし)。

---

## 0. 開始前チェック(手順書 §0)

- `content/tech.json`(3件)/`content/facility.json`(3件)/`content/trait.json`(2件)/`content/adjacency.json` を全文読み、ID衝突がないことを目視確認。
- `npm run typecheck` → pass。
- `npm test -- tests/schema` → 5 test files / 119 tests pass。
- 上記を確認してから着手(壊れた状態からの開始ではない)。

---

## 1. tech — `techSimpleBedding`

### (a) 4点の生タイムスタンプ(PowerShell `Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"` の標準出力そのまま)

| # | 工程境界 | 生出力 |
|---|---|---|
| 1 | 参照読了時 | `2026-07-27 22:54:45.869` |
| 2 | JSON化開始時 | `2026-07-27 22:54:49.524` |
| 3 | 初回検証実行時 | `2026-07-27 22:55:35.317` |
| 4 | pass確定時 | `2026-07-27 22:55:42.031` |

打刻漏れなし(4点すべて実測)。

### (b) 工程別所要時間

| 区間 | 秒 |
|---|---|
| 参照読了 → JSON化開始 | 3.655 |
| JSON化開始 → 初回検証実行 | 45.793 |
| 初回検証実行 → pass確定 | 6.714 |
| **合計(参照読了 → pass確定)** | **56.162** |

### (c) 意思決定数と行数

手順書 §3 の7ステップ(era/prereqs/lossClass/researchCost/fieldRequirement/leaf/unlocks)+ ID命名の計8意思決定。ファイル行数 10行(pretty-printed JSON)。

決定内容: `era: "e1"` / `prereqs: ["techFireStarting"]`(既存葉テック `techBasketWeaving` の前提と同じ横展開元を採用) / `lossClass: "criticalRecoverable"`(通常葉テックのため) / `researchCost: 28`(既存 e1 実測値 25/30/36 の近傍) / `fieldRequirement: { facility: "workbench", recipe: "recipeSimpleBedding", count: 2 }` / `leaf: true` / `unlocks: []`。

### (d) reject回数と内容

**reject 0回。** `validateTech()` 単体、既存 content とマージした `validateContentBundle()`、`loadEngineContent()` のいずれも初回実行で `ok: true`。

### (e) 参照ファイルと行範囲

- `docs/企画書_継ぐ火_GDD.md` §5(108–151行、特に §5.1 コスト設計 112–135行・§5.2 時代骨格 137–149行)/ §7.4 技術喪失の二層(289–296行)/ §12.1(576–589行)/ §12.3(595–597行)/ §12.4(599–605行)
- `docs/技術設計書_継ぐ火_ADR.md`「entity スキーマ」(615–673行、tech sketch 625–632行、prereqs 0–3裁定注記628–629行)
- `schema/tech.ts`(全文 1–152行)
- `schema/common.ts`(全文 1–201行)/ `schema/contentBundle.ts`(全文 1–202行)/ `schema/idRegistry.ts`(全文 1–48行)— cross-ref・グローバルID一意性の実装確認(tech/facility共通の基盤として最初のカテゴリでまとめて読み、facility/event作業時は再読していない)
- `content/tech.json`(全文)/ `content/facility.json`(全文、`fieldRequirement.facility` 実在確認用)

---

## 2. facility — `reservoir`

### (a) 4点の生タイムスタンプ

| # | 工程境界 | 生出力 |
|---|---|---|
| 1 | 参照読了時 | `2026-07-27 22:56:00.170` |
| 2 | JSON化開始時 | `2026-07-27 22:56:02.939` |
| 3 | 初回検証実行時 | `2026-07-27 22:56:25.064` |
| 4 | pass確定時 | `2026-07-27 22:56:33.885` |

打刻漏れなし。

### (b) 工程別所要時間

| 区間 | 秒 |
|---|---|
| 参照読了 → JSON化開始 | 2.769 |
| JSON化開始 → 初回検証実行 | 22.125 |
| 初回検証実行 → pass確定 | 8.821 |
| **合計(参照読了 → pass確定)** | **33.715** |

### (c) 意思決定数と行数

手順書 §4 の8ステップ(tags/slots/lvCurve/footprint/overflowCapPolicy/harshWork/output + §4-9 隣接受け手チェック)+ ID命名 = 実質9意思決定。ファイル行数 10行。

決定内容: `tags: ["damp"]`(貯水槽=湿潤) / `slots`(lv1..lv5 = 1,1,2,2,3 の単調非減少) / `lvCurve`(base=45 × 1.15^(Lv-1)、後述の6桁floor規則を1箇所で適用) / `footprint: 1×1` / `overflowCapPolicy: "discardExcess"` / `harshWork: false` / `output: { kind: "resource", resourceId: "water" }`。

**§2 の6桁floor規則の適用箇所:** `lvCurve` の厳密値(1.15^(Lv-1) の正確な分数展開、1.15=23/20 のため有限小数)は `[45, 51.75, 59.5125, 68.439375, 78.70528125]`。Lv5 の `78.70528125` は小数第7位以降(`25`)に有効桁を持つため、floor して `78.705281` を採用。他の Lv1–4 は6桁以内に収まるため無加工。`validateFacility()` はこの値で初回から pass(=floor 計算自体は誤らなかった)。

**手順書 §4-9(2026-07-27追記)隣接ルール受け手チェックの判定:** GDD 6.2 の隣接ルール表を確認した。`reservoir` のタグは `damp` のみ。
- `damp|heat`(効果 `efficiency`、target `"heat"`)は `content/adjacency.json` に**既に登録済み**。GDD 6.2「実装はタグペアで解決(施設ペア非依存)」の原則により、このルールは `damp` タグを持つ施設が `heat` タグ施設に隣接すれば施設IDに関わらず自動的に適用される。よって `reservoir` を新設しても `adjacency.json` への追加対応は不要。
- GDD 6.2 表にある未登録の「湿潤 × 菜園 → 食料+15%」(engine効果ID `foodYield`、`schema/engineContent.ts` の `ENGINE_EFFECT_BY_CONTENT_EFFECT` に定義済みだが `content/adjacency.json` には未登録)は、このルールの受け手(target)が食料を産出する「菜園」側であり、`reservoir`(湿潤を持ち込む側)はこのルールの target には該当しない。したがって `reservoir` 追加に伴う人間への依頼事項はない。
- 「汚染×寝床・療養所」「学芸3連接」「見張り台」の各ルールは `reservoir` のタグ集合(`damp` のみ)と無関係(`foul`/`lore` タグを持たないため)。

結論: **対応不要、人間への依頼事項なし。**

### (d) reject回数と内容

**reject 0回。** `validateFacility()` 単体、既存 content とマージした `validateContentBundle()`、`loadEngineContent()` のいずれも初回実行で `ok: true`(lvCurve floor 計算も初回で正しかった)。

### (e) 参照ファイルと行範囲

- `docs/企画書_継ぐ火_GDD.md` §6.1(155–159行)/ §6.2(161–196行、隣接ルール表169–176行・裁定N8 191–194行)/ §6.7(242–247行)/ §7.7(306–311行)/ §11.1(455–465行)/ §12.1(576–589行)
- `docs/技術設計書_継ぐ火_ADR.md`「entity スキーマ」facility 部(634–638行)/ 裁定N5(660–673行、`harshWork`/`output` の二段構え)
- `schema/facility.ts`(全文 1–274行)
- `schema/adjacency.ts`(全文 1–198行)
- `docs/design/tags-spec.md`(全文。特にタグ7種一覧32–44行・機械可読JSON507–640行の `tags` 配列で英字ID正本を確認)
- `schema/engineContent.ts`(112–138行 `ENGINE_EFFECT_BY_CONTENT_EFFECT`/`UNREPRESENTABLE_CONTENT_EFFECTS`、140–217行 1e6 変換規則、219–338行 facility→engine写像・target解決)
- `content/facility.json`(全文)/ `content/adjacency.json`(全文、§4-9 受け手チェックの根拠)

---

## 3. event — `eventNearOldCistern`

### (a) 4点の生タイムスタンプ

| # | 工程境界 | 生出力 |
|---|---|---|
| 1 | 参照読了時 | `2026-07-27 22:56:38.217` |
| 2 | JSON化開始時 | `2026-07-27 22:56:40.644` |
| 3 | 初回検証実行時 | `2026-07-27 22:57:26.688` |
| 4 | pass確定時 | `2026-07-27 22:57:34.986` |

打刻漏れなし。

### (b) 工程別所要時間

| 区間 | 秒 |
|---|---|
| 参照読了 → JSON化開始 | 2.427 |
| JSON化開始 → 初回検証実行 | 46.044 |
| 初回検証実行 → pass確定 | 8.298 |
| **合計(参照読了 → pass確定)** | **56.769** |

### (c) 意思決定数と行数

`destTags: ["near"]` + ID命名 + ノード4個(踏破/遭遇/遺構解読/罠を想定、GDD 8.2 の判定種別対応目安に沿う)。ノードあたり `difficulty`/`R`/`statWeights`/`choices`/`branches` の5フィールド×4ノード=20フィールド決定。`choices` 合計7個(node1:2, node2:2, node3:0, node4:3)、`branches` 合計12個(node1:3, node2:4, node3:2, node4:3)。ファイル行数 108行(4カテゴリ中もっとも構造的複雑度が高い)。

cond DSL 使用実績: `teamPower`/`difficulty`/`injuryCount` の比較(`>=`/`<`/`==`/`>`)、`&&`/`||` 併用、`hasTrait('traitScholar') == true`/`== false`(単項否定`!`が使えないため `== false` で表現)、`maxStatHolder('power') >= difficulty`。手順書 §10 の合格例パターンと一致する形のみ使用し、reject パターン(MemberExpression/UnaryExpression/ConditionalExpression/未許可演算子等)は用いていない。

`hasTrait('traitScholar')` の trait 実在確認: `content/trait.json` を手動確認し `traitScholar` が実在することを確認済み(event は `ContentBundle` 非組込みのため自動 cross-ref なし、手順書 §6 の指示通り手動確認)。

### (d) reject回数と内容

**reject 0回。** `validateEvent()` が初回実行で `ok: true`。`checkGlobalIdUniqueness()` を手動再現(tech/facility/trait の実在ID + 新規3IDを渡す)しても衝突なし(`issues: []`)。

### (e) 参照ファイルと行範囲

- `docs/企画書_継ぐ火_GDD.md` §8(314–365行、§8.1 派遣316–321行・§8.2 決定論解決322–333行・§8.3 質的分岐334–342行・§8.4 帰還報酬とログ343–348行)/ §12.1(576–589行、event sketch 583行)/ §12.2(591–593行)
- `docs/技術設計書_継ぐ火_ADR.md`「entity スキーマ」event 部(649–657行)
- `schema/event.ts`(全文 1–488行)
- `docs/measurements/authoring-procedure.md` §10 cond DSL 合格例/不合格例対照表(114–132行、procedure本文の一部として既読)
- `content/trait.json`(全文、`hasTrait('traitScholar')` の実在確認)

---

## 4. 手順書に従えなかった箇所・特記事項(正直な開示)

1. **§9 の4点計測が捕捉するのは「参照読了後」の作業時間のみ。** 4点のうち最初の「参照読了時」より前(=実際に GDD/ADR/schema を読み始めてから読み終わるまで)の所要時間を計測する打刻点は手順書に定義されていない。そのため本報告の「合計」はいずれも**参照読了後の正味作業時間**であり、参照読解そのものにかかった時間は含まれない(手順書の設計上そうなっているのであり、本セッションが打刻を怠ったわけではない)。
2. **共通基盤(`schema/common.ts`/`schema/contentBundle.ts`/`schema/idRegistry.ts`)は tech カテゴリの参照読了フェーズでまとめて読み、facility/event の各参照読了フェーズでは再読していない。** これらはカテゴリ非依存の共通基盤(cross-ref・グローバルID一意性の実装)であり、各カテゴリの「§3〜§5冒頭の参照」には直接含まれないため、最初のカテゴリ(tech)の一部として1回だけ読み、以降は前提知識として扱った。
3. **手順書 §7 の1(`npm run typecheck`)・2(`npm run lint`)は、カテゴリごとに逐次実行せず、3カテゴリ全部のJSON作成+テストファイル追記が終わった後に1回ずつ実行した。** 各カテゴリの「初回検証実行時」打刻は §7-3(`validateTech`/`validateFacility`/`validateEvent` 直接呼び出し・最速フィードバック)と §7-4/5(`validateContentBundle`→`loadEngineContent`または`validateEvent`単体)を指している。typecheck/lint はJSON単体には型情報がなく無意味なため、最終ゲート(§7-6 `npm test`)の直前にまとめて実行する運用とした。結果はいずれも異常なし(下記§5)。
4. 検証には一時スクリプト(`tmp-validate-tech.ts`/`tmp-validate-facility.ts`/`tmp-validate-event.ts`、いずれもリポジトリ直下に作成)を使用し、§7-3 が指す「一時スクリプト」方式を採った。3カテゴリとも検証後に削除済みで、コミット対象には含まれない。
5. `docs/measurements/authoring-samples/*.json` を拾う vitest テスト(`tests/measurements/authoringSamples.test.ts`)は列挙(明示import)方式だったため、手順書の許可(「明示登録が必要な場合のみテストファイルへ追記可」)に従い、新規3ファイル分の import と `describe` ブロックを追記した(既存の記述は無変更)。

## 5. 最終ゲート結果

- `npm run typecheck` → エラーなし。
- `npm run lint` → エラーなし。
- `npm test` → 32 test files / 856 tests、すべて pass。
