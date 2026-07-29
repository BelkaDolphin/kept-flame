# golden vector 被覆設計 spec(T7 前半)

作成日: 2026-07-25 / 担当: Opus / 状態: **後半(生成器実装・Sonnet)への指示書を含む**

追記: 2026-07-28(M2) — **§9「MVP 期間の conformance 拡張規律」を追加**した。§1〜§8(T7・縮約盤面前提)の記述は一切変更していない。§9 は MVP で entity 数が十数倍になる局面でのシナリオ/ベクタの成長規則・`conformance/coverage.json` の成長規則・`algoVersion` bump 判定フローを定める延長規則であり、実行は M10 / M15 / M20 / M25 / M43。**既存 37 ベクタは 1 バイトも変更していない**(`npm run golden:check` 差分なしを実測)。

改訂: 2026-07-26(Fable5 裁定) — sc11 の過密判定に関する §4.3 / §4.4 の記述が実態と食い違っていたため全面改訂し(近傍 4 件 → 5 件・超過 2 件 → 3 件)、「辞書順選抜が観測できる配置」という主張を撤回した。併せて観測が成立していなかった 2 経路を新シナリオ sc16(§4.5)へ移し、経路 ID `adj-overcrowd-lexical-top2` を `adj-overcrowd-effective-limit` へ改名した。詳細は §4.4 / §4.5 / §8-9。**既存 36 ベクタの `expected` は不変**(§6 改訂履歴)。

根拠文書: `docs/技術設計書_継ぐ火_ADR.md`(ADR-016 / ADR-017 / ADR-006 / ADR-007 / ADR-008 / ADR-012 / ADR-014 / ADR-018 / ADR-023 / ADR-024 / ADR-026 / ADR-029 / 残余リスク #9) / `docs/企画書_継ぐ火_GDD.md` §6.2〜6.4 / §11.1〜11.9 / `docs/先行計測計画_ドラフト.md` §3.3 / §4.2 T7 / 計測項目 #7 / `MEMORY.md`(T5 引き継ぎ経路一覧)

実装物の対応:

| 成果物 | 役割 |
| --- | --- |
| `conformance/goldenVector.ts` | フォーマット定義(型・ダイジェスト・突合・ファイル名・被覆突合)。T7 前半で実装済み |
| `conformance/coverage.json` | 経路レジストリ(機械可読)。T7 前半で実装済み |
| `schema/engineContent.ts` | content JSON → engine 内部表現ローダー(golden vector の入力を作る)。T7 前半で実装済み |
| `conformance/scenarios.ts` | シナリオ実装(§4 の表)。**T7 後半** |
| `conformance/vectors/*.json` + `index.json` | ベクタ実体。**T7 後半**(生成器の出力) |
| `tools/genGoldenVectors.ts` | 生成器 + 検証器。**T7 後半** |
| `tests/conformance/*.test.ts` | 再生成一致・被覆完全性のテスト。**T7 後半** |

---

## 1. なぜ被覆設計を先に固定するのか

ADR-016(1) は `algoVersion` bump の必要十分条件を「**golden vector が変化すること**」と定義した。つまり golden vector は決定論の権威であり、**被覆が薄い分だけ「golden 不変だが実挙動変化」の死角が生まれる**。ADR はこれを残余リスク #9 として正式に受容し、「seed 群の被覆設計は open question」と明記している。本 spec はその open question を閉じるためのものであり、以下の 3 つを分けて確定する。

1. **何を観測するか**(§3 フォーマット) — 状態ハッシュだけでは「挙動同一だが区間分割が変わった」を検出できない。`advanceWithReport` のカウンタを併記して検出面を広げる。
2. **どの経路を踏むか**(§2 経路レジストリ / `conformance/coverage.json`) — 経路を機械可読に列挙し、「登録された経路を 1 本も踏んでいない」を CI で落とす。被覆の穴を人間の記憶に頼らない。
3. **golden vector では観測できないものを正直に分ける**(§2.2) — Math 許可リスト違反・hash アドレス方式の順序非依存性・経過 ms の floor などは golden では観測不能で、engine の単体テストか content ローダーの reject が担保する。「全部 golden で見ている」という嘘をつかないことが被覆設計の一部である。

---

## 2. 経路レジストリ

### 2.1 構造

`conformance/coverage.json` が唯一のレジストリ。1 エントリ = 1 経路:

```jsonc
{
  "id": "split-at-recovery-tick",      // 小文字英数 + ハイフン(VECTOR_ID_PATTERN)
  "title": "分割不変性: 想起困難の回復 tick ちょうどで advance を区切る",
  "refs": ["src/engine/advance.ts §3", "src/engine/rules/recall.ts 末尾"],
  "observedBy": ["split-digest", "counters"],
  "note": "T5 で実際にバグが出た区切り位置"
}
```

各ベクタは自分が踏む経路を `paths: ["split-at-recovery-tick", ...]` として**申告する**。対応表は「ベクタ側の申告が権威、レジストリは完全性の管理表」という向きで、`checkCoverage()`(`conformance/goldenVector.ts`)が次の 3 種を検出する。

1. レジストリの形式違反(ID 重複・不正 ID・`refs` / `observedBy` 空)
2. golden vector で観測する経路(`observedBy` に `digest` / `counters` / `probe` / `split-digest` を含む)なのに、申告するベクタが 1 本も無い
3. ベクタが未登録の経路 ID を申告している(タイポ・レジストリ更新漏れ)

経路 ID → ベクタ ID の対応表そのものは `buildCoverageMatrix()` が生成し、生成器が `conformance/vectors/coverage-matrix.json` へ書き出す(= 人間が「この経路は誰が守っているか」を引ける機械可読の表)。

### 2.2 `observedBy` の意味(何で観測するか)

| 値 | 意味 |
| --- | --- |
| `digest` | 最終状態のダイジェストの差として現れる |
| `counters` | `advanceWithReport` のカウンタの差として現れる |
| `probe` | プローブ値の差として現れる |
| `split-digest` | 分割実行と一括実行のダイジェスト一致として確認する |
| `unit-test` | **golden vector では観測できない**。engine の単体テストが担保する |
| `loader-reject` | **golden vector では観測できない**。content ローダーの reject が担保する |

`unit-test` / `loader-reject` のみの経路は `requiresVector()` が false を返すのでベクタ申告を要求しない。現在 **9 件**(**[2026-07-29 M10] 修正**: 旧「5 + 3 件」は数え間違いだった。内訳は `rng-hash-address-order-free` / `fp-mulfixproven-bound` / `fp-decimal-exact` / `clock-elapsed-floor` の 4 件 + `load-*` 5 件 = 9 件)がこれに該当する(§9.1 実測と一致)。

### 2.3 経路の内訳(全 58 件)

`conformance/coverage.json` が正。分類だけ示す。

| 接頭辞 | 件数 | 対象 |
| --- | --- | --- |
| `a-` | 4 | (A) 定常生産区間の閉形式・レート 0・就労者比例・Lv 別個別 FP |
| `b-` | 8 | (B) 研究完了(グリッド上/外・地平線・切り上げ・進行度先行・キュー前進・レート 0)+ 回復境界 |
| `c-` | 11 | (C) 粗粒度ステップ・試行数・p クランプ・士気/定着度/trait/派遣・発生中の再抽選抑止・線形按分・持続抽選 |
| `tie-` | 2 | 同一 tick 複数イベントの全順序(段の順 / 同段の entityId 順) |
| `split-` | 5 | 分割不変性(回復 tick・完了 tick・ステップ境界・グリッド外・1 ステップ刻み) |
| `rng-` | 7 | worldSeed の変化・空文字列・非 ASCII・サロゲート・rngState 空/非空の往復・順序非依存 |
| `adj-` | 8 | シード揺らぎ・恒等・過密の有効件数制限 + 超過ペナ・複数タグ・両クランプ・target 3 形・盤端 |
| `fp-` | 5 | mulFix の BigInt フォールバック・mulFixProven 上界・負の floor・10 進厳密変換・Math.imul ラップ |
| `clock-` | 3 | 72h クランプ境界・1 分 tick Fallback・経過 ms の floor |
| `load-` | 5 | ローダーの reject(未知 effect / 未実装 effect / 未解決 target / タグ不整合 / 縮約必須フィールド欠落) |

---

## 3. ベクタフォーマット

型定義は `conformance/goldenVector.ts`(`GOLDEN_VECTOR_FORMAT_VERSION = 1`)。

### 3.1 1 ベクタの中身

```jsonc
{
  "formatVersion": 1,
  "vectorId": "sc15-tie-split-alpha",
  "scenarioId": "sc15-tie",
  "worldSeed": "seedAlpha",
  "worldSeedU32": 123456789,        // fnv1a32(worldSeed)。seed→uint32 の写像も固定する
  "coarseTickMinutes": 10,
  "fromTick": 0,
  "toTick": 4320,
  "elapsedMonotonicMs": null,       // 非 null なら computeTargetTick(from, ms) == toTick も検証
  "splitTicks": [1000],             // 分割不変性を確認する区切り(空なら分割なし)
  "paths": ["split-at-recovery-tick", "split-at-completion-tick", "tie-multi-event-same-tick"],
  "expected": {
    "stateDigest": "……32桁hex……",
    "canonicalJsonLength": 1234,
    "counters": {
      "segmentCount": 0, "stochasticStepCount": 0, "stochasticTrialCount": 0,
      "rateChangeEventCount": 0, "recallOccurrenceCount": 0
    },
    "probe": {
      "tick": 0, "entityCount": 0,
      "resourceStockSumRaw": 0, "researchProgressSumRaw": 0, "researchCompletedCount": 0,
      "recallImpairedResidentCount": 0, "recallImpairedUntilTickSum": 0,
      "rngStateDomainCount": 0, "rngStateWordsXor": 0
    }
  },
  "splitCounters": { /* 分割実行の合計。splitTicks が空なら null */ }
}
```

### 3.2 カウンタを持つ理由(残余リスク #9 への直接の回答)

`advanceWithReport` の 5 カウンタ(`segmentCount` / `stochasticStepCount` / `stochasticTrialCount` / `rateChangeEventCount` / `recallOccurrenceCount`)は、**最終状態が同じでも区間分割が変わったら動く**。(A)(B)(C) 区間分類の壊れ方はまずここに出る:

- 境界を 1 本落とした → `segmentCount` が減る(状態は偶然一致することがある)
- (C) のグリッドが `state.tick` 起点に退行した → `stochasticStepCount` は同じでも分割時に `stochasticTrialCount` が変わる
- 回復イベントを状態遷移付きに戻した → `rateChangeEventCount` は同じで**状態ダイジェストだけ**変わる(逆向きの検出)

「状態ハッシュ + カウンタ」の 2 面で見ることで、片方だけの死角を互いに埋める。

### 3.3 分割不変なのは状態だけ。カウンタは分割不変ではない

**この非対称性をフォーマットに明示しておくことが T5 のバグ再発検出の要である。**

`advance(0→T)` と `advance(0→T1) + advance(T1→T)` は最終状態が一致する(advance.ts §3)。一方カウンタは一致しない:

- `segmentCount`: T1 で区間が 2 本に割れるので**増える**。
- `rateChangeEventCount`: **減ることがある**。半開区間の規約(scheduler.ts §2)で tick == toTick のイベントは処理されず、次回の advance では `buildEventQueue` が `until > state.tick` でしか回復イベントを積まないため、ちょうど回復 tick で区切ると回復イベントはどちらの advance でも発火しない。回復は状態遷移を持たない境界イベント(recall.ts 末尾)なので最終状態は一致する。
- `stochasticStepCount` / `stochasticTrialCount` / `recallOccurrenceCount`: グリッドが tick の絶対値に固定されている限り**一致する**(一致しなくなったら (C) の退行)。

したがって:

- `expected.counters` = **一括実行**のカウンタ
- `splitCounters` = **分割実行**のカウンタ合計(`splitTicks` が空なら null)
- 一致を要求するのは **状態ダイジェストのみ**(一括 == 分割)

生成器は「分割ありのベクタでカウンタも一致するはず」と書いてはならない。書くと `split-at-recovery-tick` の検出器が壊れる。

### 3.4 ダイジェストの作り方と 2 つの落とし穴

入力は `JSON.stringify(toSerializable(state))`。serialize.ts §1 が「同じ内容の state からは必ず同じバイト列」を保証しているので、ブラウザ 3 エンジン(ADR-017)でも同一になる。ハッシュは engine の FNV-1a-32 を **4 つの異なる初期値で 4 回**通し、各パスの末尾に入力長を畳んで 32 桁 16 進(128bit)にする(`digestOfCanonicalJson`)。engine の既存実装を再利用するのは、別実装を書くと「ハッシュ実装の差」が「挙動の差」に化けるため。

**落とし穴 (1): 循環参照を作らないこと。** `toSerializable` の出力にはメタ 3 軸(`saveSchemaVersion` / `contentVersion` / `algoVersion`)が載る。もしシナリオがこれらを「現在の engine の版」から読むと、`algoVersion` を bump した瞬間に全ダイジェストが変わり、ADR-016 の「golden 変化 ⟺ algoVersion bump」が**恒真になって無意味化する**。したがって:

> シナリオの初期 state のメタ 3 軸は **固定リテラル** `saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1` とする。`content/balance.json` の `algoVersion` からも、engine 側の定数からも読まない。ベクタ群を生成した engine の版は `index.json` の `algoVersion` に記録する(そちらは人間向けの記録であり digest に入らない)。

**落とし穴 (2): ハッシュ強度を過大に主張しないこと。** FNV-1a-32 は暗号学的ハッシュではなく、4 本は同じ関数族なので完全独立ではない。golden vector は**変化検出器であって改竄検出器ではない**(敵対的な衝突生成は脅威モデル外。セーブの改竄耐性は ADR-012 が「無し」と明記済み)。この強度で足りる。併せて `canonicalJsonLength` を持たせ、長さが変わる種類の変化はハッシュ以前に落ちるようにしてある。

### 3.5 プローブ値

ダイジェストは変化の**有無**しか教えない。不一致時に「どの部分系が変わったか」を人間が読めるよう、部分系ごとに 1 個ずつスカラを置く(`GoldenProbe`)。状態全体を持たせないのは二重管理を避けるため。

| フィールド | 何を切り分けるか |
| --- | --- |
| `tick` | advance の到達点(クランプ経路の確認) |
| `entityCount` | 盤面の構造 |
| `resourceStockSumRaw` | (A) 生産の総量 |
| `researchProgressSumRaw` / `researchCompletedCount` | (B) の積分と発火回数 |
| `recallImpairedResidentCount` / `recallImpairedUntilTickSum` | (C) の帰結と持続抽選 |
| `rngStateDomainCount` / `rngStateWordsXor` | 逐次ストリームの使用有無と位置 |

### 3.6 ファイル配置と命名(Windows 260 文字・計画書 §3.3)

```
conformance/
├─ coverage.json                  # 経路レジストリ(人間が編集)
├─ goldenVector.ts                # フォーマット定義
├─ scenarios.ts                   # シナリオ実装(T7 後半)
└─ vectors/
   ├─ index.json                  # マニフェスト(formatVersion / algoVersion / vectors / baseContentVectorIds)
   ├─ coverage-matrix.json        # 経路 ID → ベクタ ID(生成物)
   └─ <vectorId>.json             # 1 ファイル 1 ベクタ
```

- 名前は `<vectorId>.json`。vectorId は**小文字英数とハイフンのみ**(`VECTOR_ID_PATTERN`)= Linux runner との大小文字差異を排除(計画書 §3.3)。
- 全体 40 文字以内(`VECTOR_FILE_NAME_MAX_LENGTH`)。超える場合だけ `v-<8桁hex>.json`(vectorId の FNV 短縮)へ落とす(`vectorFileName()` が強制)。
- 予算計算: リポジトリルートの絶対パスを 160 文字と見積もっても 160 + `conformance/vectors/`(20) + 40 = **220 < 260**。
- **ダイジェストをファイル名に入れない**のは意図的。挙動が変わったとき git に「リネーム」ではなく「同じファイルの中身の差分」として出したいため(ADR-016 の「golden 差分あり ⟺ algoVersion bump」を人間がレビューできる形にする)。

---

## 4. シナリオ設計

### 4.1 シナリオとは

1 シナリオ = **(content patch, 初期 state)** の組。乱数を使わず、コードで一意に構築する。

- **content patch** — `content/*.json` の raw JSON に対する差分。patch 適用後も必ず `validateContentBundle` → `loadEngineContent` の正規経路を通す(= patch でスキーマ外の content を作れない)。
- **base content シナリオ**(patch = null)は ADR-017 の週次 content パイプラインゲートが使う部分集合。`index.json` の `baseContentVectorIds` に載る。patch 付きは engine 側の境界被覆用であり、週次 content の代表 seed 群ではない。

patch 機構が**必須**な理由(設計上の逃げではない):

1. 1 分 tick Fallback(ADR-014(3))は `balance.coarseTickMinutes = 1` を要求するが、本番 content は 10。
2. 現行 content の `researchCost`(25〜36)と `lvCurve`(80〜262/tick)の比では研究が 1 tick で完了し、(B) の境界(グリッド上/外・切り上げ)を作れない。
3. `mulFix` の BigInt フォールバック境界は人間単位 5600 超の産出を要求し、本番バランスに存在しない。
4. `damp` タグを持つ施設と記憶巧者 trait が現行ダミー content に無い(`content/trait.json` に trait を足すと既存テストの件数アサートを壊すため、T7 では patch で供給する)。

### 4.2 メタ 3 軸と共通前提

- メタは全シナリオ共通で `saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1`(§3.4 落とし穴 (1))。
- `fromTick` は原則 0。初期 state の `tick` は `fromTick` と一致させる。
- 格子は 6×8(`cellIndex = y*6 + x`, 0〜47)。
- entity ID は `^[a-z][a-zA-Z0-9_]*$`(ADR-011)。**vectorId / scenarioId の命名規則(小文字ハイフン)とは別物**なので混同しないこと。
- 施設定義 ID / tech ID は content 由来(`hearth` / `forge` / `workbench` / `techFireStarting` / `techPottery` / `techBasketWeaving`)。
- 資源 entity の `resourceId` は content の `facility.output.resourceId`(`firewood` / `iron`)と一致させる。一致しないと `applyProduction` が例外を投げる(産出を静かに捨てない設計)。

### 4.3 シナリオ一覧(16 件)

| id | content patch | 初期 state(要点) | 主に踏む経路 |
| --- | --- | --- | --- |
| `sc01-steady` | なし | 施設 `facilityHearthA`(hearth, cell 7, Lv1, 就労 `residentAnn`)/ `facilityForgeA`(forge, cell 8, Lv2, 就労 `residentBen`)、資源 `resourceFirewood`(firewood, 0)/ `resourceIron`(iron, 0)、住民 2 名(morale 50・mastery 0・非派遣・trait なし・impaired 0)。research entity **なし** | `a-closed-form` `a-worker-scaling` `a-level-curve` `adj-seed-offset-applied` `adj-target-resolution` `c-step-grid` `rng-state-empty-roundtrip` |
| `sc02-idle` | なし | 施設 `facilityHearthA`(hearth, cell 0, Lv1, **就労者なし**)、資源 `resourceFirewood`、住民 `residentAnn`(**無配属**・morale 50)、research `researchFire`(techFireStarting, progress 0) | `a-zero-rate` `b-research-zero-rate` `c-p-zero` `c-trial-count` `rng-state-empty-roundtrip` |
| `sc03-research` | `tech.techFireStarting.researchCost = 8000` | 施設 `facilityDeskA`(workbench, cell 20, Lv1, 就労 `residentAnn`)、住民 1 名(morale 50)、research `researchFire`(techFireStarting)/ `researchPottery`(techPottery, progress 0) | `b-research-on-grid` `b-research-queue-advance` `tie-multi-event-same-tick` `c-trial-count` `b-research-at-horizon` |
| `sc04-offgrid` | `tech.techFireStarting.researchCost = 8010` | sc03 と同じ盤面 | `b-research-off-grid` `b-research-ceil` `fp-floor-negative` |
| `sc05-preloaded` | なし | sc03 の盤面から research `researchFire` の `progress` を **techFireStarting の researchCost と等しく**(= 30 人間単位)しておく | `b-research-preloaded` |
| `sc06-recall` | なし | 施設 `facilityForgeA`(forge=**過酷業務**, cell 8, Lv1, 就労 `residentAda` `residentBea` `residentCal`)、資源 `resourceIron`、住民 3 名(**morale 10**・mastery 0・非派遣)、research 3 件(3 tech すべて・progress 0・researchCost は content のまま) | `b-recall-recovery-boundary` `c-duration-draw` `c-linear-proration` `c-no-reroll-while-impaired` `c-trial-count` `rng-state-nonempty-roundtrip` |
| `sc07-clamp-p` | なし | sc06 の盤面 + `residentAda` を `dispatched: true`(p = 0.05×2.0 + 0.20 + 0.15 = 0.45 → p_max 0.35 でクランプ) | `c-p-clamp-max` `c-dispatch-weight` |
| `sc08-mastery` | なし | sc06 の盤面 + `residentAda.mastery = 0.5`(上限 0.2 で打ち止め。打ち止めが無ければ p が 0 になる差で観測可能) | `c-mastery-cap` |
| `sc09-memkeeper` | `trait` 配列へ `traitMemoryKeeper` を追加 + `balance.recallRiskParams.memoryKeeperTraitId = "traitMemoryKeeper"` | sc06 の盤面 + `residentAda.traitIds = ["traitMemoryKeeper"]`(p 0.15 vs 他 0.30) | `c-memory-keeper` |
| `sc10-morale-edge` | なし | forge 就労の住民 4 名を morale = **15 / 14.999999 / 30 / 29.999999** に置く(閾値ちょうどは加算されない側) | `c-morale-thresholds` |
| `sc11-overcrowd` | `adjacency.tagMatrix["heat|heat"] = { effect:"forgeYield", target:"any", valueFP:0.4 }`、`adjacency.tagMatrix["noise|noise"] = { effect:"efficiency", target:"any", valueFP:0.1 }`、`facility` に `smelter`(tags `["heat","noise"]`, harshWork true, output resource `iron`)と `cistern`(tags `["damp"]`, harshWork false, output resource `firewood`)を追加 | 中心 cell 7 に `facilitySmelterA`(smelter, Lv1, 就労 1 名)、その 8 近傍のうち cell **1 / 2 / 6 / 8** に hearth を 4 基、cell 13 に `facilityCisternA`(cistern)、さらに四隅 cell **0 / 5 / 42 / 47** に hearth を配置(盤端の回り込み検査)。**cell 0 は四隅であると同時に cell 7 の NW 近傍**なので、中心から見た heat 近傍は 5 件(0/1/2/6/8)= 有効 2 件 + 超過 3 件になる(§4.4)。資源 2 件・住民は各施設に 1 名 | `adj-overcrowd-effective-limit`(超過ペナ側のみ) `adj-bonus-clamp` `adj-neighbor-edge` `adj-target-resolution` |
| `sc12-bigstock` | `facility.hearth.lvCurve = [6000000, 6900000, 7935000, 9125250, 10494037.5]` | 施設 `facilityHearthA`(hearth, cell 0, Lv1, 就労 1 名)、資源 `resourceFirewood`(stock 0)、住民 1 名 | `fp-mulfix-bigint-fallback` |
| `sc13-onemin` | `balance.coarseTickMinutes = 1` | sc06 と同じ盤面 | `clock-fallback-one-minute` `c-step-grid` `c-trial-count` |
| `sc14-offset-zero` | `adjacency.seedOffsetRange = { min: 0, max: 0 }` | sc01 と同じ盤面 | `adj-seed-offset-identity` |
| `sc15-tie` | `tech.techFireStarting.researchCost = 80000` | 施設 `facilityDeskA`(workbench, cell 20, Lv1, 就労 `residentCal`)、research `researchFire`(techFireStarting, progress 0)/ `researchPottery`、住民 `residentAda` `residentBea`(ともに `recallImpairedUntilTick = 1000`・無配属)+ `residentCal`。**tick 1000 に「回復 2 件 + 粗粒度ステップ + 研究完了」が同時に来る**(80000/80 = 1000、1000 % 10 == 0) | `tie-multi-event-same-tick` `tie-same-stage-entity-order` `split-at-recovery-tick` `split-at-completion-tick` |
| `sc16-overcrowd-fine`<br>**[2026-07-26 追加]** | sc11 と同じ facility 追加(`smelter` / `cistern`)+ `adjacency.tagMatrix["heat|heat"] = { effect:"forgeYield", target:"any", valueFP:0.1 }`、`adjacency.tagMatrix["noise|noise"] = { effect:"efficiency", target:"any", valueFP:0.1 }`、`adjacency.overcrowd.penaltyPerExcessFP = -0.15` | 中心 cell 7 に `facilitySmelterA`(smelter, Lv1, 就労 1 名)。その 8 近傍 **0 / 1 / 2 / 6 / 8 / 12 / 13 / 14 を全て埋める**。うち cell 8 は 2 基目の smelter(`facilitySmelterB`・heat+noise)、残り 7 セルは hearth。資源 2 件(iron / firewood)・住民は各施設に 1 名。research entity なし | `adj-overcrowd-effective-limit`(本数制限側) `adj-overcrowd-multi-tag` `adj-penalty-clamp` |

**sc15 は本設計で最も価値の高いシナリオ**である。T5 で実際にバグが出た 2 つの区切り位置(回復 tick / 完了 tick)が同一 tick に重なり、かつ同段 2 件の entityId 順が同時に効く。ここを 1 本のベクタで固定すると、分割不変性の退行はほぼ必ずここで落ちる。

### 4.4 sc11 の過密判定の詳細 **[2026-07-26 裁定により全面改訂]**

**改訂前の記述は誤りだった。** 旧版は「heat 近傍 4 件 → 先頭 2 件(cell 1, 2)有効・超過 2 件」と書き、さらに「方向順で列挙してから辞書順へ再ソートする二段が観測できる配置になっている」と主張していた。前者は近傍の数え落とし、後者は原理的に成立しない主張である。以下が実態(engine 実挙動と突合済み)。

#### (1) 近傍は 4 件ではなく 5 件(発見 A)

`cellIdOf` は `c00`〜`c47` の 2 桁ゼロ埋めなので**辞書順 = セル番号昇順**。中心 cell 7 の 8 近傍は方向順 N, NE, E, SE, S, SW, W, NW で `[1, 2, 8, 14, 13, 12, 6, 0]` であり、**この列挙自体に cell 0 が含まれている**。sc11 は「盤端の回り込み検査」として四隅 0 / 5 / 42 / 47 にも hearth を置くので、cell 0 は四隅であると同時に中心 cell 7 の NW 近傍でもある。したがって:

- heat バケツ = 方向順 `[1, 2, 8, 6, 0]` → セル ID 辞書順へ再ソート `[0, 1, 2, 6, 8]` の **5 件**
- 有効件数 = `threshold - 1` = **2 件**、超過 = **3 件**(旧版の「超過 2 件」は誤り)
- 過密ペナルティ = 3 × −0.10 = **−0.30**

`seedAlpha` での実測(§4.3 の patch 適用後・シード揺らぎ焼き込み後の係数は `heat|heat` = +0.461694, `damp|heat` = −0.080968, `noise|noise` = +0.080558):

| 施設 | cell | bonus(クランプ後) | ペナルティ | 乗数 | 超過数 |
| --- | --- | --- | --- | --- | --- |
| `facilitySmelterA` | 7 | +0.600000(生値 2×0.461694 − 0.080968 = **0.842420** → ±60% クランプ) | −0.300000 | 1.300000 | 3 |
| `facilityHeat1` | 1 | +0.600000 | −0.300000 | 1.300000 | 3 |
| `facilityHeat2` / `facilityHeat6` / `facilityHeat8` / `facilityCorner0` | 2 / 6 / 8 / 0 | +0.600000 | −0.100000 | 1.500000 | 1 |
| `facilityCisternA` | 13 | 0 | −0.100000 | 0.900000 | 1 |
| `facilityCorner5` / `facilityCorner42` / `facilityCorner47` | 5 / 42 / 47 | 0 | 0 | 1.000000 | 0 |

#### (2) 「辞書順で選ばれた個体」は観測不能(発見 B・主張の撤回)

`src/engine/adjacency.ts` の `computeCellAdjacency`(§3 の 2 重ループ)は、辞書順へ再ソートした結果 `ordered` の**要素そのものを一度も読まない**。ボーナス項は `matrix.pairEffects.get(tagPairKey(selfTag, tag))` だけで決まり、`i` は「何件ぶん加算するか」のカウンタとしてしか使われない:

```ts
for (let i = 0; i < effectiveCount; i++) {
  for (const selfTag of subject.tags) {
    const effect = matrix.pairEffects.get(tagPairKey(selfTag, tag));   // ordered[i] は使わない
```

これは engine のバグではなく **GDD 6.2 の効果モデル(タグ × タグの対称行列・施設ペア非依存)に忠実な実装**である。効果が近傍の個体に依存しない以上、「先頭 (threshold-1) 件として**どの個体が**選ばれたか」は乗数に影響しようがなく、**いかなる配置・いかなる golden vector でも観測できない**。旧版が主張した「方向順と辞書順が食い違う cell 6 / 8 を含めてあるので二段ソートが観測できる」は成立しない(方向順のまま先頭 2 件を採っても、辞書順で採っても、加算される値は同じ 2 項なので digest は一致する)。よって:

- この主張は**撤回**する。engine は変更しない(GDD 忠実実装であり正しい)。
- 経路 ID `adj-overcrowd-lexical-top2` は `adj-overcrowd-effective-limit` へ改名し、title を「有効ボーナスが (threshold-1) 件分に制限され、超過数 × ペナが積まれる」= **実際に観測できる 2 つ**へ書き直した(`conformance/coverage.json`)。
- 「効果が施設ペア依存に拡張されない限り、GDD 6.3(c) の辞書順選抜規則は permanently vacuous(挙動上無意味)」という判断は §8-9 に要ユーザー判断事項として記録した。

#### (3) sc11 では本数制限もペナ側クランプも観測できない(発見 C / D)

上表のとおり sc11 の中心 smelter は、有効 2 件でも生値 0.842420、仮に本数制限が壊れて 5 件全部が効いても 5×0.461694 − 0.080968 = 2.227502 で、**どちらも ±60% クランプに吸われて bonus = +0.600000 になる**。つまり sc11 の digest は「有効件数」を区別できない。sc11 が実際に固定しているのは:

- **超過数 × ペナルティ**(3 × −0.10 = −0.30。数え落とせば digest が動く)
- **ボーナス側の ±60% クランプ**(`adj-bonus-clamp`。生値 0.842420 > 0.6 なので発動している)
- 盤端の回り込み無し(`adj-neighbor-edge`)と target 3 形の解決(`adj-target-resolution`)

一方で以下は sc11 では観測できないので、経路の申告から外して sc16 へ移した:

- `adj-penalty-clamp` — ペナルティは最大 −0.30 で `clampFP` = 0.6 に届かない。**クランプが壊れていても sc11 は pass する**(発見 C)。
- `adj-overcrowd-multi-tag` — `noise` タグを持つ施設は中心 smelter だけであり、「noise を持つ**近傍**」がどの施設にも存在しない。よって `noise|noise` は一度も発火せず、複数タグ施設はバケツへ参加するだけで効果も超過数も動かさない(発見 D)。

### 4.5 sc16 の過密判定の詳細 **[2026-07-26 追加]**

sc16 は §4.4(3) で観測不能と判明した 3 経路を**実際に観測できる**ようにするためのシナリオである。中心 cell 7 の 8 近傍 `[0, 1, 2, 6, 8, 12, 13, 14]` を全て埋め、cell 8 だけを 2 基目の smelter(heat + noise)にする。

`seedAlpha` での実測(patch 後・シード揺らぎ焼き込み後の係数は `heat|heat` = +0.115423, `noise|noise` = +0.080558, `damp|heat` = −0.080968(sc16 の盤面に damp 施設は無いので不発)):

| 施設 | cell | bonus | ペナルティ | 乗数 | 超過数 |
| --- | --- | --- | --- | --- | --- |
| `facilitySmelterA`(中心) | 7 | **+0.311404** | **−0.600000**(生値 6 × −0.15 = −0.900000 → clampFP で切られる) | **0.711404** | 6 |
| `facilitySmelterB` | 8 | +0.311404 | −0.450000 | 0.861404 | 3 |
| `facilityHearth1` / `6` / `13` | 1 / 6 / 13 | +0.230846 | −0.450000 | 0.780846 | 3 |
| `facilityHearth0` / `2` / `12` / `14` | 0 / 2 / 12 / 14 | +0.230846 | −0.150000 | 1.080846 | 1 |

中心 smelter の bonus の内訳: heat バケツ **8 件中 有効 2 件** × 0.115423 = 0.230846、noise バケツ **1 件**(cell 8 の smelter)× 0.080558 = 0.080558、計 **0.311404**。

この配置で 3 つが digest として立つ:

1. **本数制限(`adj-overcrowd-effective-limit`)** — 有効 2 件なら bonus 0.311404(クランプ**未発動**)。本数制限が壊れて 8 件全部が効くと 8 × 0.115423 + 0.080558 = 1.003942 → ±60% クランプで 0.600000 となり、乗数は 0.711404 ではなく 1.000000 になる。**係数を 0.4 ではなく 0.1 にしたのはこのため**(sc11 は両側ともクランプに吸われて区別できなかった)。
2. **ペナ側クランプ(`adj-penalty-clamp`)** — 超過 6 件 × −0.15 = −0.900000 が `clampFP` = 0.6 で −0.600000 へ切られる。クランプが無ければ乗数は 0.411404 になるので、**クランプの発動そのものが digest に出る**。
3. **複数タグの同時参加(`adj-overcrowd-multi-tag`)** — cell 8 の smelter は中心から見て heat バケツ(過密カウント 8 件目)と noise バケツ(`noise|noise` +0.080558)の**両方**に参加する。タグごとの独立集計が壊れて 1 タグにしか数えないと bonus が 0.230846 へ落ちる。

ベクタは `sc16-overcrowd-fine-alpha`(seed alpha・0→1440・分割なし)1 本。research entity を置いていないのでベルヌーイ試行は 0 件、`rngState` も空のままであり、**観測される差分は隣接乗数だけ**になる(実測 `probe.resourceStockSumRaw` = 1,186,377,120,000 = 各施設 100/tick × 乗数 × 1440 tick の総和、`stateDigest` = `20b9530e8db78e6a46ba749c27077b9e`)。

---

## 5. seed 群設計

worldSeed は文字列で、`fnv1a32(worldSeed)` で uint32 になる(`worldSeedToUint32`)。seed は「ランダムに散らす」のではなく **hash 経路の境界を踏ませる**目的で選ぶ。

| slug | worldSeed | 選んだ理由 |
| --- | --- | --- |
| `alpha` | `seedAlpha` | 基準。T5 のテストフィクスチャと同じ値なので既存テストとの照合が容易 |
| `beta` | `seedBeta` | 2 本目の基準。同一シナリオで digest が変わることを確認して「seed が実際に効いている」を固定する |
| `empty` | `` (空文字列) | FNV-1a-32 の畳み込みが **0 回** = offset basis そのまま。ループ境界 |
| `longz` | `zzzzzzzzzzzzzzzz` | 16 回の畳み込み。`Math.imul` の uint32 ラップを多数回通す(ADR-006 許可リスト) |
| `kanji` | `種火` | 非 ASCII BMP。`fnv1a32` は `charCodeAt`(UTF-16 コードユニット)単位であり UTF-8 バイト単位の標準 FNV とは値が異なる(fnv1a32.ts 冒頭)。**ブラウザ 3 エンジンで文字列走査が一致することの検出器**(ADR-017 / 計測 #7) |
| `emoji` | `🔥火` | サロゲートペア(コードユニット 2 個)+ BMP。canonicalize.ts §2 が明示したサロゲート扱いを実 run 経路でも固定する |

seed とシナリオの全直積は張らない(16 × 6 = 96 は保守が重い)。`rng-` 系の経路は「worldSeed を実際に消費するシナリオ」= `sc01-steady`(adjacency 揺らぎ)と `sc06-recall`((C) 抽選)に限って seed を振る。

---

## 6. ベクタ一覧(37 本)

`plan` 列: `toTick` / `elapsedMonotonicMs` / `splitTicks` の指定。`splitTicks` の `<推定>` は生成器が §7.2 の規則で求めて JSON へ焼く。

| # | vectorId | scenario | seed | plan | 申告する paths |
| --- | --- | --- | --- | --- | --- |
| 1 | `sc01-steady-alpha` | sc01 | alpha | 0→4320 | `a-closed-form` `a-worker-scaling` `a-level-curve` `adj-seed-offset-applied` `adj-target-resolution` `c-step-grid` `rng-state-empty-roundtrip` |
| 2 | `sc01-steady-beta` | sc01 | beta | 0→4320 | `rng-worldseed-variation` |
| 3 | `sc01-steady-empty` | sc01 | empty | 0→4320 | `rng-worldseed-empty` |
| 4 | `sc01-steady-kanji` | sc01 | kanji | 0→4320 | `rng-worldseed-nonascii` |
| 5 | `sc01-steady-emoji` | sc01 | emoji | 0→4320 | `rng-worldseed-surrogate` |
| 6 | `sc01-steady-longz` | sc01 | longz | 0→4320 | `fp-imul-wrap` |
| 7 | `sc01-clamp-under` | sc01 | alpha | elapsedMs = 4319×60000 + 59999 → 0→4319 | `clock-clamp-72h` |
| 8 | `sc01-clamp-exact` | sc01 | alpha | elapsedMs = 4320×60000 → 0→4320 | `clock-clamp-72h` |
| 9 | `sc01-clamp-over` | sc01 | alpha | elapsedMs = 10000×60000 → 0→4320 | `clock-clamp-72h` |
| 10 | `sc01-split-offgrid` | sc01 | alpha | 0→4320, splits [1237] | `split-off-grid` |
| 11 | `sc01-split-step` | sc01 | alpha | 0→4320, splits [1240] | `split-at-step-tick` |
| 12 | `sc02-idle-alpha` | sc02 | alpha | 0→4320 | `a-zero-rate` `b-research-zero-rate` `c-p-zero` `c-trial-count` `rng-state-empty-roundtrip` |
| 13 | `sc03-research-alpha` | sc03 | alpha | 0→300 | `b-research-on-grid` `b-research-queue-advance` `tie-multi-event-same-tick` `c-trial-count` |
| 14 | `sc03-horizon-alpha` | sc03 | alpha | 0→100 | `b-research-at-horizon` |
| 15 | `sc03-split-done-alpha` | sc03 | alpha | 0→300, splits [100] | `split-at-completion-tick` |
| 16 | `sc04-offgrid-alpha` | sc04 | alpha | 0→300 | `b-research-off-grid` `b-research-ceil` `fp-floor-negative` |
| 17 | `sc04-split-done-alpha` | sc04 | alpha | 0→300, splits [101] | `split-at-completion-tick` |
| 18 | `sc05-preloaded-alpha` | sc05 | alpha | 0→50 | `b-research-preloaded` |
| 19 | `sc06-recall-alpha` | sc06 | alpha | 0→4320 | `b-recall-recovery-boundary` `c-duration-draw` `c-linear-proration` `c-no-reroll-while-impaired` `c-trial-count` `rng-state-nonempty-roundtrip` |
| 20 | `sc06-recall-beta` | sc06 | beta | 0→4320 | `rng-worldseed-variation` |
| 21 | `sc06-recall-empty` | sc06 | empty | 0→4320 | `rng-worldseed-empty` |
| 22 | `sc06-recall-kanji` | sc06 | kanji | 0→4320 | `rng-worldseed-nonascii` |
| 23 | `sc06-recall-emoji` | sc06 | emoji | 0→4320 | `rng-worldseed-surrogate` |
| 24 | `sc06-split-recover-a` | sc06 | alpha | 0→4320, splits [`<推定>` 最初の回復 tick] | `split-at-recovery-tick` |
| 25 | `sc06-split-many-alpha` | sc06 | alpha | 0→720, splits [10, 20, …, 710] | `split-many` |
| 26 | `sc07-clamp-p-alpha` | sc07 | alpha | 0→4320 | `c-p-clamp-max` `c-dispatch-weight` |
| 27 | `sc08-mastery-alpha` | sc08 | alpha | 0→4320 | `c-mastery-cap` |
| 28 | `sc09-memkeeper-alpha` | sc09 | alpha | 0→4320 | `c-memory-keeper` |
| 29 | `sc10-morale-edge-alpha` | sc10 | alpha | 0→4320 | `c-morale-thresholds` |
| 30 | `sc11-overcrowd-alpha` | sc11 | alpha | 0→1440 | `adj-overcrowd-effective-limit` `adj-bonus-clamp` `adj-neighbor-edge` `adj-target-resolution` |
| 31 | `sc11-overcrowd-beta` | sc11 | beta | 0→1440 | `rng-worldseed-variation` |
| 32 | `sc12-bigstock-alpha` | sc12 | alpha | 0→100 | `fp-mulfix-bigint-fallback` |
| 33 | `sc13-onemin-alpha` | sc13 | alpha | 0→4320 | `clock-fallback-one-minute` `c-step-grid` `c-trial-count` |
| 34 | `sc14-offset-zero-alpha` | sc14 | alpha | 0→4320 | `adj-seed-offset-identity` |
| 35 | `sc15-tie-alpha` | sc15 | alpha | 0→2000 | `tie-multi-event-same-tick` `tie-same-stage-entity-order` |
| 36 | `sc15-tie-split-alpha` | sc15 | alpha | 0→2000, splits [1000] | `split-at-recovery-tick` `split-at-completion-tick` |
| 37 | `sc16-overcrowd-fine-alpha`<br>**[2026-07-26 追加]** | sc16 | alpha | 0→1440 | `adj-overcrowd-effective-limit` `adj-overcrowd-multi-tag` `adj-penalty-clamp` |

base content ベクタ(`index.json` の `baseContentVectorIds`)= sc01 / sc02 / sc05 / sc06 / sc07 / sc08 / sc10 由来の全ベクタ。patch 付き(sc03 / sc04 / sc09 / sc11 / sc12 / sc13 / sc14 / sc15 / sc16)は engine 境界被覆用。

**改訂履歴**: 2026-07-25 に 36 本で確定。2026-07-26 の裁定(§4.4)で #30 の申告 paths から `adj-overcrowd-multi-tag` / `adj-penalty-clamp` を外し(sc11 では観測不能だったため)、`adj-overcrowd-lexical-top2` を `adj-overcrowd-effective-limit` へ改名、#37 を追加して 37 本にした。**#1〜#36 の `expected`(digest / counters / probe)は 1 バイトも変わっていない**(変わるのは #30 の `paths` 配列と `index.json` / `coverage-matrix.json` だけ)。

---

## 7. T7 後半(Sonnet)への実装指示書

### 7.1 作るもの

| ファイル | 内容 |
| --- | --- |
| `conformance/scenarios.ts` | §4.3 の 16 シナリオ。`SCENARIOS: readonly Scenario[]` を export。`Scenario = { id, contentPatch: ((raw: RawContentBundle) => RawContentBundle) \| null, buildState: (worldSeed: string) => GameState }`。content は `validateContentBundle` → `loadEngineContent`(`schema/engineContent.ts`)の正規経路で読む。**patch は raw JSON 段で当てる**(検証を迂回しない) |
| `conformance/vectorPlans.ts` | §6 の 37 プラン。`VECTOR_PLANS: readonly VectorPlan[]`。`VectorPlan = { vectorId, scenarioId, worldSeed, fromTick, toTick \| null, elapsedMonotonicMs \| null, splitTicks \| "first-recall-recovery" \| "every-coarse-step", paths }` |
| `tools/genGoldenVectors.ts` | 生成器 + 検証器。`--check`(既存ベクタと突合・差分を stderr へ)と `--write`(再生成)の 2 モード。`conformance/vectors/*.json` / `index.json` / `coverage-matrix.json` を出力 |
| `tests/conformance/goldenVectors.test.ts` | 全ベクタを再実行して `compareObservations` が空配列であること / 分割不変性 / `checkCoverage` が空配列であること |
| `package.json` | `"golden:check": "node --experimental-strip-types tools/genGoldenVectors.ts --check"` と `"golden:write": "... --write"` を追加(実行方法は着手時に Node 24 で確認すること。`tsx` 等の**新規依存は入れない**) |

### 7.2 生成器の規則(ここを外すとベクタの意味が変わる)

1. **メタ 3 軸は固定リテラル**(§3.4 落とし穴 (1))。`algoVersion` を state へ動的に流し込まない。
2. `splitTicks` の解決:
   - `"first-recall-recovery"` — 一括 run を `collectSegments: true` で 1 回走らせ、`segments[].endEventKinds` に `"recallRecover"` を含む最初の区間の `toTick` を採る。**求めた値は JSON へ数値として焼く**(以後は固定値。毎回探索し直すと挙動変更時に「探索結果も変わる」ので変化が隠れる)。
   - `"every-coarse-step"` — `fromTick + coarse, fromTick + 2×coarse, …`(< toTick)。
   - 該当イベントが 1 件も無い場合は**エラーで停止**(空の splitTicks へ黙って落とさない。落とすと検出器が無音で死ぬ)。
3. `elapsedMonotonicMs` 付きプランは `computeTargetTick(fromTick, elapsedMonotonicMs)` で `toTick` を求め、プランの `toTick`(あれば)と一致することを確認する。
4. 分割 run は `advance` の結果 state を次の run の入力へ渡す。`AdvanceContext` は **run ごとに作り直さない**(配置は変わらないので作り直すと `createAdvanceContext` のコストを無駄に払う。ただし結果は同じであることをテストで確認してよい)。
5. **状態ダイジェストのみ**一括 == 分割を要求する。カウンタは別々に記録する(§3.3)。
6. `rng-state-nonempty-roundtrip` を申告するベクタでは、追加で `toSerializable` → `JSON.parse(JSON.stringify(...))` → `fromSerializable` を通した state から digest を取り、一括 run の digest と一致することを確認する(往復不変性の実挙動側の固定)。
7. JSON 出力は `canonicalizeJson` を通し、`JSON.stringify(value, null, 2) + "\n"`、改行は LF(`.gitattributes` が強制済み)。prettier のチェック対象になるので整形を合わせること。
8. 生成器は engine を**改変しない**。ベクタが期待どおりにならない場合は、まずシナリオ/プランの設計ミスを疑い、engine の挙動が仕様(ADR/GDD)と食い違うと判断したら**修正せず報告する**。

### 7.3 注意点・禁止事項

- **既存テスト 583 件を壊さない・変更しない。**
- `conformance/` は engine の外なので純粋性 lint は掛からないが、`Math.random` / `Date.now` / `new Date()` を書かない(ベクタが再現しなくなる)。
- ベクタ JSON に「現在時刻」「実行環境」「絶対パス」を書かない。
- `paths` の申告は**実際に踏む経路だけ**にする。踏んでいない経路を申告すると `checkCoverage` が通ってしまい被覆の穴が隠れる(= 残余リスク #9 が復活する)。迷ったら申告せず、代わりにレジストリの `note` へ「未被覆」と書いて報告する。
- 経路 ID を増やしたくなったら `conformance/coverage.json` へ追記する(勝手に別の場所へ経路の概念を作らない)。
- ベクタ数を増やすのは自由だが、**§6 の 37 本は減らさない**。減らす提案は理由付きで報告する。
- `content/*.json` を書き換えない(patch はコード側で当てる)。

### 7.4 完了条件

1. `npm test` / `npm run typecheck` / `npm run lint` / `npm run format` が全 pass。
2. `npm run golden:check` が差分ゼロ。
3. `checkCoverage` が空配列(= `observedBy` に golden 観測を含む全経路が 1 本以上のベクタから申告されている)。
4. `conformance/vectors/coverage-matrix.json` が生成され、経路 ID → ベクタ ID の対応が読める。
5. 72h(4320 tick)ベクタの生成時間を計測して報告(計測 #3 の sec/run 校正の一次データになる)。

---

## 8. 要ユーザー判断・未確定事項

T5/T6 から持ち越したものを含む。**いずれも本 spec の実装をブロックしない**が、文書側の追記が必要。

1. **schema の省略可フィールド 3 種**(`facility.harshWork` / `facility.output` / `balance.recallRiskParams.durationTicksMin|Max` / 同 `memoryKeeperTraitId`)を T7 で追加した。ADR「entity スキーマ」616行・641行のスケッチには無い。最終形では `output` は recipe entity 側に載る想定であり、**現状は「schema では省略可・ローダーでは必須」の二段構え**にしている(既存 content・既存テストを壊さずに additive 拡張するため)。ADR 側へ注記を入れるかは判断待ち。
2. **content ローダーの配置**を `schema/engineContent.ts` にした。ADR リポ構成には content ローダーの居場所が書かれていない。根拠は「engine 内では `Object.keys` 禁止(canonicalize.ts のみ免除)と schema からの import 禁止で実装不能」+「`schema/` が CODEOWNERS 人間専用ゆえ、engine が受け付ける content 語彙という決定論 critical な判断を運営 LLM が勝手に広げられない」。ADR リポ構成へ 1 行加えるかは判断待ち。
3. **隣接効果語彙のレジストリ**を `ENGINE_EFFECT_BY_CONTENT_EFFECT`(`forgeYield` / `efficiency` / `foodYield` → `yieldMul`)と `UNREPRESENTABLE_CONTENT_EFFECTS`(`health` / `codifySpeed` / `defense`)として engine 外に定義した。GDD 6.2 の効果表を英字 ID へ写したものだが、**GDD 側に英字 ID の正本が無い**(表は日本語の効果名のみ)。GDD へ ID 列を追記すべき。
4. **GDD 6.2「学芸 3連接 → 成文化 +30%」はタグペア行列では表現できない**(ペアは 2 者関係、3 連接は 3 者関係)。現状は `codifySpeed` として「engine 未実装ゆえ reject」に分類しているが、成文化を実装する段でモデル自体の見直しが必要。
5. **GDD 6.2 の表は tag×tag と tag×facility が混在している**(「汚染 × 寝床・療養所」「湿潤 × 菜園」)。実装は `tagMatrix` のキーを tag|tag に限り、施設指定を `target` 側で表現している。GDD へこの表現規約を明記すべき。
6. **【2026-07-27裁定・解消済み】`adjacency.seedOffsetRange` の「揺らぎ無し」表現。** `{min: 0, max: 0}` を**揺らぎ無し(恒等)の慣用表現として正式化**する(裁定N9)。schema は変更しない(null 許容にしない)。理由: 必須フィールドのまま値で表現できるなら型を緩めるより表現規約で閉じるほうが検証器を単純に保てる。engine 内部の `seedOffset: null` は content からは到達不能なままでよい。
7. **【本タスクで検出・修正済み】ダミー content に 1e6 で厳密表現できない値があった。** `content/facility.json` の `forge.lvCurve[4] = 262.3509375`(= 150 × 1.15⁴ を倍精度で展開したままの値)は小数第 7 位を持ち、1e6 固定小数点では表現できない。ローダーの 10 進厳密変換がこれを reject したため `262.350937`(GDD 11.7 の floor 方向に統一)へ修正した。**オーサリングツール(`tools/`・ADR リポ構成581行)は `1.15^(Lv-1)` 展開値を必ず 6 桁で floor して書き出す必要がある**。ツール実装時にこの規則を組み込むこと(現状は人手で書いたダミーなので同種の値が再混入しうる)。
9. **【2026-07-26 裁定・要ユーザー判断】GDD 6.3(c) の「セル ID 辞書順で先頭 (threshold-1) 件のみ有効」規則は、現行の効果モデルの下では permanently vacuous(挙動上無意味)である。** 隣接効果は GDD 6.2 が定めるとおり**タグ × タグの対称行列**で表現され、ボーナス項は (自施設のタグ, 近傍のタグ) のペアのみで決まって近傍の**個体**には依存しない(`computeCellAdjacency` の再ソート結果 `ordered[i]` は一度も読まれない)。したがって「有効な (threshold-1) 件として**どの近傍が**選ばれるか」は乗数に一切影響せず、golden vector でも単体テストでも(挙動として)観測できない。観測できるのは「有効件数 = threshold-1」と「超過数 × ペナルティ」の 2 つだけである。判断が必要なのは次の 2 点:
   - **engine 側**: 現状維持を推奨する。実装は GDD 6.3(c) に忠実であり、将来効果が施設ペア依存(例: 「同じ施設定義が隣接すると減衰」)へ拡張された瞬間に辞書順選抜が意味を持ち始める。ここで「無意味だから」とソートを削ると、その拡張時に**順序非決定**(`Map` 反復順・方向順依存)が静かに混入する。ソートは決定論の保険として残す価値がある。
   - **GDD 側**: 6.3(c) の文言を「先頭 (threshold-1) 件**のみ**有効」から「有効件数は (threshold-1) 件。どの個体が有効になるかは現行の効果モデルでは結果に影響しないが、決定論のため常にセル ID 辞書順で選ぶ」へ改めるか、あるいは効果モデル自体を施設ペア依存へ拡張するか。**ユーザー判断**。
   - 被覆側は本裁定で正直化済み: 経路 ID を `adj-overcrowd-effective-limit` へ改名し、`conformance/coverage.json` の note に観測不能性を明記した。旧 ID `adj-overcrowd-lexical-top2` の `observedBy: ["digest","probe"]` は「辞書順選抜を観測している」という**虚偽の申告**だった。
10. T5/T6 の既報 9 件(GDD 11.7 の想起困難 2 段の位置 / p_step 線形按分の GDD 明記 / eventQueueSnapshot 非セーブ / rngState 空省略 / adjacency effect 語彙 / footprint 2×1・2×2 未実装 / adjacency クランプ ±60% の engine 定数化 / content のカテゴリ 1 ファイル方式 / `tech.prereqs` 長さ 0 許可)は未処理のまま。うち **adjacency effect 語彙は本タスクで実装済み**(上記 3)。

---

## 9. MVP 期間の conformance 拡張規律 **[2026-07-28][M2]**

本節はロードマップ Phase 0 の M2 の成果物であり、§1〜§8(T7 時点・縮約盤面前提)の**延長規則**である。§1〜§8 の記述は変更しない。実行主体は conformance 拡張 #1〜#4(M10 / M15 / M20 / M25)と最終確定の M43 であり、**M2 では conformance 配下のファイルを 1 バイトも変更しない**(規則の文書化のみ)。

### 9.1 拡張の基準点(2026-07-28 実測)

| 指標 | 現在値 | 出典 |
| --- | --- | --- |
| 経路(`conformance/coverage.json`) | 58 件。うち `requiresVector()` が true(= golden 観測)= **49**、`unit-test` / `loader-reject` のみ = **9** | 実測(下記注) |
| シナリオ(`conformance/scenarios.ts`) | 16 | §4.3 |
| ベクタ(`conformance/vectors/*.json`) | 37(base content 23 / patch 付き 14) | §6 / `index.json` |
| 1 経路を守るベクタ本数 | 要ベクタ 49 経路のうち **36 経路が 1 本のみ**で守られている | `coverage-matrix.json` 実測 |
| 1 ベクタの entity 数 | 最小 3(`sc12-bigstock-alpha`)/ 最大 22(`sc11-overcrowd-*`)/ 中央値 6〜8 | 各ベクタの `expected.probe.entityCount` |
| `npm run golden:check` 全体 | **1 秒未満**(実測 0.92s。4320 tick 級 23 本の内訳合計は約 90ms、最長は `sc13-onemin-alpha` の 17ms) | 2026-07-28 実行 |

> 注: §2.2 は要ベクタ外の経路を「5 + 3 件」と書いているが、同じ括弧内の列挙は 4 件 + `load-*` 5 件 = 9 件である(実測も 9)。**本節は実測値 49 / 9 を使う。**§2.2 の数え方の食い違いは既存ベクタに影響しないので本タスクでは修正しない(M10 で `checkCoverage` 周辺を触る際に併せて直すこと)。

MVP では施設 14 種 × Lv1〜5・住民系・footprint 2×1/2×2・探索/event・衛星拠点・プレステージが入り、代表盤面の entity 数は現行の十数倍(数十〜百数十件)になる。ただし**ベクタの生成コストは entity 数ではなく区間数で決まる**(上表の最長が `sc13-onemin-alpha` = 粗粒度 1 分で 4320 区間であることがそれを示す)。拡張の律速は「盤面の大きさ」ではなく「長い run を何本持つか」である。

### 9.2 シナリオ / ベクタの成長規則

#### (1) 切る単位は「系統」ではなく「壊れ方」

既存 16 シナリオは 1 系統 = 1 シナリオになっていない。(C) 想起リスク系統だけで sc06〜sc10 の 5 本があり、それぞれ「基準」「p の上側クランプ」「mastery 上限」「trait 分岐」「閾値の境界」と**壊れ方**で分かれている。MVP でもこの切り方を維持する。「1 系統 = 1 シナリオ」にすると次の 3 つが必ず漏れる。

- **不発の側** — 系統が何もしない状態(レート 0・p = 0・対象ゼロ件)。sc02 が (A)(B)(C) すべての不発を 1 本で押さえている型。不発が壊れる(余計な区間が切れる)と `counters` だけが動き状態は一致するので、稼働シナリオでは検出できない。
- **クランプの発動側と未発動側** — §4.4 発見 C/D の実例。sc11 は「ペナ側クランプが壊れていても pass する」盤面だった。1 本で「クランプ前の値」と「クランプ後の値」の両方は観測できないので、係数を振り直した 2 本目(sc16)が要る。
- **同 tick 衝突** — 系統が単独で動く盤面では tie-break の全順序が観測されない。sc15 のように「回復 + 粗粒度ステップ + 研究完了」を同一 tick へ重ねる専用シナリオが要る。

#### (2) 系統ごとの最小被覆基準(C1〜C7)

新しい系統を conformance へ入れるとき、以下 7 軸のうち**その系統に該当するものすべて**を最低 1 本のベクタで踏む。該当しない軸は `conformance/coverage.json` の `note` へ「該当なし」と理由を書く(黙って落とさない)。

| 軸 | 内容 | 既存の型 |
| --- | --- | --- |
| **C1 不発** | レート 0 / 確率 0 / 対象ゼロ件で状態も区間も動かない | `a-zero-rate` `b-research-zero-rate` `c-p-zero`(sc02) |
| **C2 グリッド上** | 系統が生む境界イベントの tick が粗粒度ステップのグリッドに乗る | `b-research-on-grid`(sc03) |
| **C3 グリッド外** | 乗らない(端数の ceil / floor が効く) | `b-research-off-grid` `b-research-ceil`(sc04) |
| **C4 飽和** | 上限 / 下限 / クランプの**発動側と未発動側の両方** | `c-p-clamp-max`(sc07)・`adj-bonus-clamp`(sc11) と `adj-penalty-clamp`(sc16) |
| **C5 tie** | 他系統のイベントと同一 tick に重なる(段の順 + 同段の entityId 順) | `tie-*`(sc15) |
| **C6 分割不変性** | C2 / C3 / C5 の tick **ちょうど**で `splitTicks` を切る | `split-*`(sc03 / sc04 / sc06 / sc15) |
| **C7 seed** | 逐次乱数(`rngState`)を消費する系統は seed を振る | `rng-worldseed-variation`(sc01 / sc06 / sc11) |

**C7 の節約規則**: §5 の 6 seed を全系統へ張り直さない。新系統には `alpha` / `beta` の 2 本だけを義務とし、hash 境界 seed(`empty` / `kanji` / `emoji` / `longz`)は **engine が文字列走査の経路を新しく増やしたときだけ**足す。現行 4 本が `fnv1a32` の走査境界を既に固定しており(§5)、系統ごとに張り直しても同じ関数を通るだけで新しい情報が出ないため。

#### (3) 反証義務 — 経路を申告する前に「壊れたら動く」ことを数値で示す

§4.4 の教訓を規則へ昇格する。

> **新しい経路 ID を申告するベクタは、その経路が壊れた場合に `expected` のどのフィールドがどの値へ動くかを、追加時点で一度だけ数値で確認する。**

- 確認結果は spec の当該小節(§4.4 / §4.5 と同じ形)か `coverage.json` の `note` へ残す。
- 確認できない = **観測不能**なので申告してはならない。§7.3 の「踏んでいない経路を申告しない」に対する実効的な判定手段がこれである。
- 両側ともクランプに吸われて同値になる場合は、**シナリオの係数を観測可能な範囲へ振り直す**(sc11 の `heat|heat` = 0.4 に対し sc16 は 0.1 にした)。engine を変えて観測可能にするのではない。
- entity 数が増えるほど効果の重ね合わせが上限へ届きやすく、この飽和は起きやすくなる。MVP ではこの確認を省略しない。

#### (4) 診断可能性は「プローブを増やす」のではなく「シナリオを小さく保つ」ことで担保する

`GoldenProbe` の 9 フィールド(§3.5)は部分系ごとに 1 スカラであり、entity が百件規模になると「和のどこが動いたか」は読めなくなる。ここでプローブを増やすと `GOLDEN_VECTOR_FORMAT_VERSION` を上げることになり、**既存全ベクタの再生成**が発生する(挙動不変なら bump は不要だが、レビュー対象の差分が全ファイルに広がる)。したがって MVP 期は次のようにする。

- **フォーマットは `formatVersion` 1 のまま据え置く**(唯一の拡張候補は (5) のプレステージ = 周回をまたぐ run)。
- 代わりに、系統別シナリオには**その系統に関係しない entity を置かない**。sc12(entity 3 件)や sc16(20 件だが research entity ゼロ = ベルヌーイ試行 0 件で「観測される差分は隣接乗数だけ」・§4.5)がその型。
- **全系統が同時に動く大盤面シナリオは M43 で 1〜2 本だけ**作る。これは診断用ではなく「全系統が同一 tick で衝突したときの全順序」を固定する統合ベクタであり、差分が出たら系統別シナリオ側で切り分ける、という二層構成にする。

#### (5) 系統別の追加計画

| 系統(対応タスク) | 主に足すシナリオ | ベクタ本数の目安 | 「1 系統 1 シナリオ」では漏れるもの |
| --- | --- | --- | --- |
| **生産・消費・資源**<br>(M5 → M10) | ① 施設 14 種が同時稼働する定常盤面(閉形式 × 種別)② 保管庫が上限へ到達する盤面(オーバーフロー 3 出口・GDD 6.7)③ 消費で在庫が 0 に張り付く盤面 ④ 全施設就労ゼロ | 6〜9<br>(split 2 / seed 1) | 在庫上限への到達は (B) 型の境界イベントを**新しく生む**。定常盤面では到達 tick に届かず C2/C3/C6 がまるごと漏れる。3 出口の分岐は資源種別 × 在庫状態で変わるので 1 本では 1 出口しか踏めない |
| **研究・成文化**<br>(M6 → M10) | ① E1〜E3 の 24 tech を prereqs 順に消化する長回し(キュー前進の全順序)② 成文化完了が研究完了と同一 tick(tie)③ 記録媒体 2 種(石板 / 紙)の並存 ④ E3 印刷 = 紙のみの分岐 | 5〜8<br>(split 2) | 媒体別コスト / 時間は 1 本の中では `researchProgressSumRaw` の 1 スカラに埋もれる。媒体ごとにシナリオを割ると差が digest に立つ |
| **住民系**<br>(M7/M11/M12/M13 → M15) | ① 寿命で住民 entity が消える tick を含む長回し ② 人口下限保証の発動 ③ memoirLog テンプレ選択 ④ 想起リスク本式(tech 別停止・(B) 一回性喪失)⑤ mastery 上限と閾値境界(sc08 / sc10 の本式版) | 10〜14<br>(seed 必須) | **entity が消える**のは他の全経路の前提(entityId 順の tie-break・probe の和)を揺らす唯一の経路なので専用シナリオが要る。`canonicalJsonLength` が動く数少ない系統でもある。memoirLog はテンプレ選択順に `Map` 反復順依存が混入しやすく、単独シナリオの価値が高い |
| **footprint / 過密**<br>(M16/M17 → M20) | ① 2×1 / 2×2 の占有と基準セル導出 ② 大型施設の近傍集合(占有セルの近傍が重なる配置)③ 複数タグ過密の独立集計(sc16 の footprint 版)④ 盤端で配置不可になる境界 | 5〜8 | 大型施設は近傍集合が重なるため「重複を数えるか否か」の差が出ない配置になりやすい。**(3) の反証をここで必ず行う**(sc11 と同じ失敗が最も起きやすい系統) |
| **探索 / event**<br>(M21/M22/M23 → M25) | ① 派遣枠 2 の同時解決順 ② 距離帯 3(`near`/`far`/`deep`)③ 全滅 ④ choices の判定前分岐(代表 2 本)⑤ item overflow ⑥ `destroyRecords`(content 側未使用のまま挙動固定) | 8〜12<br>(seed 必須) | event は「同じ seed で別ノードへ行く」= 分岐被覆であり 1 シナリオ = 1 経路しか踏まない。**全 50 ノードを golden へ載せない**(生成時間と保守が破綻する)。ノード到達率は sim 側(GDD 11.4-10 / M38)で見て golden は代表ノードの固定に限る、という線引きを `coverage.json` の `note` へ明記する |
| **プレステージ**<br>(M28 → M43) | ① 周回シード導出のバイト同一(GDD 10.5)② 2 プールナップサックの解決順 ③ 継承点の上限クランプ | 3〜5 | **現行フォーマットで表現できない可能性がある。** 1 ベクタ = `fromTick → toTick` の 1 run であり、大移動を挟んだ 2 周回は表現できない。表現できないと判明した時点で (a) 大移動を 1 run 内の境界イベントとして扱えるか (b) `formatVersion` 2 へ拡張するか を M28 / M43 で判断する。**`formatVersion` を上げても `expected` が変わらないなら algoVersion bump は不要**(§9.4(1)) |
| **bot / sim**<br>(M36〜M38) | — | 0 | golden の対象外。bot の決定論は「同一 seed 1000 回一致」(GDD 11.4-5)で担保する。**`coverage.json` に bot 経路を作らない**(`observedBy` のどれにも載せられない経路が増えると表が濁る) |

#### (6) 本数と生成時間の予算

- ベクタ総数の目安は **80〜110 本**(既存 37 + 系統別 40〜60 + 統合 3〜5)。§6 の 37 本は減らさない(§7.3)。**vectorId は再利用しない**(過去の ID を別の意味で使い回すと、そのベクタが何を固定していたかを git 履歴から追えなくなる)。
- 予算は **`npm run golden:check` 全体で 60 秒以内**とする。現状 1 秒未満で 60 倍の余裕があるが、entity 数十数倍 × 本数 3 倍でおおむね 40 倍規模になるため、余裕は「潤沢」ではなく「概算で足りる」水準である。各拡張タスクは完了時に実測秒数を報告し(§7.4 完了条件 5 の継続)、M43 で最終値を確定する。
- vectorId は 40 文字以内(`VECTOR_FILE_NAME_MAX_LENGTH`・§3.6)。`sc<番号>-<系統略号>-<seed slug>` の形を守れば足りる。

### 9.3 被覆レジストリ `conformance/coverage.json` の成長規則

#### (1) レジストリは既に存在する。M2 ではファイルを増やさない

§2.1 のとおり `conformance/coverage.json`(58 経路)が唯一のレジストリであり、`checkCoverage()` / `buildCoverageMatrix()` / `requiresVector()`(`conformance/goldenVector.ts`)が実装済みで、`tools/genGoldenVectors.ts` と `tests/conformance/goldenVectors.test.ts` の両方から実行されている。**本節が新設を提案するもの(接頭辞予約の機械可読化・単一被覆の警告)はファイル追加かコード変更を伴うため、M2 では規則の文書化に留め、実装は M10 に委ねる。**

#### (2) 追記のタイミングと粒度

- 経路の追記は**実装 PR と同一 PR**で行う。「実装だけ入って経路が未登録」の期間を作らない(その期間は `checkCoverage` が緑のまま被覆が薄くなる = 残余リスク #9 の再発)。
- 逆順(経路だけ先に登録)は**許可する**。実装前は `observedBy: ["unit-test"]` で登録しておけば `requiresVector()` が false になりベクタ申告を要求しないので、CI を割らずに「まだ被覆していない」を可視化できる。
- **1 経路 = 1 つの壊れ方。** 「〜系統全体」のような粗い経路を作らない(壊れても誰も落ちないため、登録した瞬間に嘘になる)。

#### (3) 接頭辞の予約

現行 10 接頭辞(§2.3)に対し MVP で追加する接頭辞を予約する。**既存接頭辞の意味を変えない** — 特に `fp-` は固定小数点(fixed point)であって footprint ではない。footprint は `foot-` を使う。

| 接頭辞 | 対象 | 追加タスク |
| --- | --- | --- |
| `prod-` | 生産・消費の全系統化(施設 14 種・ステータス 5 種・trait 倍率) | M5 → M10 |
| `sto-` | 保管庫オーバーフロー・廃材スポンジ・3 出口(GDD 6.7) | M5 → M10 |
| `codex-` | 成文化キュー・記録媒体 2 種(GDD 11.1 追補) | M6 → M10 |
| `stat-` | 住民ステータス正本 ID と派生値 `combatPower`(裁定 B8) | M7 → M10 |
| `life-` | 寿命・人口下限保証・獲得(GDD 7.5〜7.7) | M11 → M15 |
| `mem-` | memoirLog・bond・記憶可視化のデータ層(GDD 7.3) | M12 → M15 |
| `foot-` | footprint 2×1 / 2×2 の占有・基準セル導出(裁定 B5) | M16 → M20 |
| `exp-` | 探索(派遣枠 2・距離帯 3・全滅・ROI) | M21 → M25 |
| `ev-` | event ランタイム(cond DSL・choices 分岐・item overflow・`destroyRecords`) | M22 → M25 |
| `out-` | 衛星拠点 3 タイプ(GDD 9.2) | M24 → M25 |
| `pres-` | 大移動・2 プール・周回シード導出・継承点(GDD 10.2〜10.5) | M28 → M43 |

`c-`(想起リスク)は M13 の本実装で経路が増えるが、接頭辞は据え置いて既存 ID の隣へ追記する(`c-` の意味は変わらない)。

#### (4) `observedBy` の更新規則

- 値の語彙は §2.2 の 6 種から**増やさない**。増やすと `requiresVector()` の判定 = CI の歯止めそのものを書き換えることになる。
- **昇格**(`unit-test` / `loader-reject` → `digest` 等。`requiresVector()` が false → true になる変更)は、その瞬間からベクタ申告が必須になる。**昇格とベクタ追加は同一 PR で行う**(分けると `checkCoverage` が赤の中間コミットができる)。
- **降格**(`digest` → `unit-test`)は「golden では観測できないと判明した」場合に限り、**理由を `note` へ書く**。§4.4 の `adj-overcrowd-lexical-top2` → `adj-overcrowd-effective-limit` が先例(このときは経路の意味自体を書き直した)。降格を「ベクタを作るのが面倒だから」の逃げに使わない。
- 複数値の併記は「golden でも単体テストでも見る」を意味する(`fp-floor-negative` / `fp-imul-wrap` の型)。**一部だけ golden で見える**場合は、どこまでが golden 側かを `note` に書く。

#### (5) 機械検出できること / できないこと(正直な線引き)

`checkCoverage()` が検出するのは §2.1 の 3 種(形式違反 / 未被覆 / 未登録申告)だけである。**登録されていない経路 = 誰も気づいていない分岐は検出できない。** これは原理的な穴であり、拡張しても消えない。補うのは次の 3 つで、いずれも `checkCoverage` の外にある。

1. **ADR-016(2) の manifest tripwire** — 決定論 critical ファイルが変わったのに golden が動かない場合の二次警告。
2. **実装 PR に経路追記を義務づける手続き**((2))。機械ではなくレビュー観点。
3. **単一被覆の可視化** — 現状、要ベクタ 49 経路のうち **36 経路がベクタ 1 本のみ**で守られている(9.1 実測)。そのベクタが消える / プランが変わると穴が空くが `checkCoverage` は緑のままである。`coverage-matrix.json` から「ベクタ 1 本のみの経路」を一覧する**警告**(fail ではない)を出す実装は **M10 の範囲**とし、`checkCoverage` のシグネチャを変えずに別関数として足す。

### 9.4 algoVersion bump 判定フロー(ADR-016「golden 変化 ⟺ bump」の維持手順)

#### (1) 原則 — 判定対象は「既存ベクタの観測値」だけ

ADR-016(1) の必要十分条件「golden vector が変化すること」を MVP 期の運用語彙へ落とすと次になる。

> **bump が必要 = 既存 `conformance/vectors/<vectorId>.json` の `expected` または `splitCounters` が変わったとき。それ以外は bump 不要。**

| 変更の種類 | 既存ベクタの `expected` | bump |
| --- | --- | --- |
| 新シナリオ / 新ベクタの**追加のみ** | 不変 | **不要** |
| 新経路の登録・既存ベクタへの `paths` 追記 | 不変(`paths` は `expected` の外) | **不要** |
| engine の挙動変更 | 変わる | **必要** |
| コメント・リネーム・型注釈のみ | 不変 | **不要**(ADR-016 が排除した偽陽性 bump) |

新ベクタ追加で bump が不要である理由は、`algoVersion` が守っている対象が「**既存セーブの未来 tick が変わらないこと**」だからである。ベクタが増えても既存セーブの計算結果は変わらない。一方 `conformance/vectors/index.json` は `vectors` / `baseContentVectorIds` が必ず変わるが、これはベクタ群の**マニフェスト**であって観測値ではないので bump 判定に入れない(`coverage-matrix.json` も同様)。

#### (2) 既存ベクタが変わってしまった場合の切り分けフロー

`npm run golden:check` は vectorId 単位・フィールド単位で差分行を出す(`diffVectors` / `compareObservations` / `compareCounters`)。**差分の形から一次分類できる**ので、まず読む。

| 差分の形 | 一次仮説 | 参照 |
| --- | --- | --- |
| `counters.*` のみ(`stateDigest` 不変) | 区間分割が変わった(境界を 1 本落とした / 余分に切った) | §3.2 |
| `stateDigest` のみ(`counters` 不変) | 状態遷移が変わった(境界イベントに状態遷移を付けた等) | §3.2 |
| `probe.*` が動く | どの部分系かが分かる(資源 / 研究 / 想起 / rng) | §3.5 |
| `splitCounters` のみ | 分割時のイベント処理規約(半開区間)が変わった | §3.3 |
| `canonicalJsonLength` が動く | 状態の**構造**が変わった(entity・フィールドの増減)。セーブ migration の要否も併せて判断 | §3.4 |
| 分割ありのベクタで `stochasticTrialCount` だけ動く | (C) の粗粒度グリッドが `state.tick` 起点へ退行した疑い(T5 バグの再発) | §3.2 / §3.3 |

次に **3 択で判定する**。

1. **仕様が先に変わっていて実装が追従した** → 意図した挙動変更。**bump する**((3) の手順)。仕様変更が ADR / GDD へ反映済みであることを先に確認する(未反映なら文書が先)。
2. **仕様は変えていないのに動いた** → **バグの疑い**。ベクタを再生成せず、実装を修正 / revert して golden を元へ戻す。**`npm run golden:write` で緑にするのは禁止**(テストを通すためにテストを書き換えるのと同型)。原因が特定できないまま 3 回試して直らなければ停止して報告する。
3. **シナリオ / プラン側の変更が原因**(content patch の値・`toTick`・`splitTicks` を触った)→ engine 挙動は不変なので **bump 不要**。ただしこの場合は、**既存ベクタを書き換えるのではなく新しい vectorId のベクタを足す**のが原則である(既存ベクタの意味を後から変えると、そのベクタが過去に何を固定していたかが読めなくなる)。既存ベクタの `expected` を書き換えてよいのは 1. の場合だけ。

**[2026-07-29 M10 追記] `content/*.json`(base content 本体)の値そのものを修正する場合の扱い。** 上記 3 択はシナリオ側の patch を前提にしているが、base content(patch なしで全シナリオが共有して読む入力)の**欠陥修正**は次のように扱う。統率者裁定: **fixture/content の値修正は engine 挙動変更ではないので algoVersion bump ではない**(bump の権威は「同一シナリオ・同一 content での観測挙動」= ADR-016(1)であり、content 自体の値が変わるのは前提が変わっただけで engine の挙動関数は 1 行も変わっていない)。この点は 3. の「シナリオ/プラン側の変更」と結論(bump 不要)は同じだが、**「既存ベクタは書き換えず新規 vectorId を足す」という手続きまでは適用しない**— base content は特定のシナリオが恣意的に選んだ値ではなく全シナリオの共有入力であり、欠陥修正後の値が新しい正本になるため、**base content シナリオ(patch なし)の既存ベクタは `golden:write` で上書き再生成してよい**。ただし必須条件が 2 つある: ①再生成前に反証(§9.2(3))と同じ精神で「どの経路がどう動くか、あるいは動かないか」を実際の値で確認し報告すること ②動いたベクタがあれば §9.5 のチェックリストと同様に diff の形を報告すること。**M10 の実例(実測・0 本が動いた)**: `techBasketWeaving.researchCost`(25→GDD 12.3 帯内の 40)と trait ID 統一(`traitLivingLibrary`→`traitMemoryKeeper`)はいずれも `npm run golden:check` で確認した結果、37 本中 1 本も動かなかった。理由は数値で説明できる: 前者は researchCost を参照する `sc06Board`(sc06/07/08/09/13 が使う共通盤面)に研究産出施設(workbench)が無く `researchRateFix` が常に 0 のため、研究コストの値そのものが一度も評価されない(`ticksUntilResearchComplete` はレート 0 で常に null を返す)。後者は sc09 が trait を付ける対象施設 `forge` の実 content `statWeights` が `intellect: 0` を明示しているため、trait の `intellect +5` 加算効果が生産式の重み付き和(`Σ weight_s × stat_s`)に一切寄与しない(想起困難側の `recallResist` 効果は元々 trait の effects テーブルを経由せず `balance.recallRiskParams.memoryKeeperTraitId` の直接参照で実装されているため、ID の呼び名を変えても resolveable な参照が保たれていれば無関係)。**「0 本動く」ことも「動いたベクタが具体的に何本、なぜ動くか」と同じ重みの結論であり、動かなかった理由を数値で示せないなら安易に「動かなかった」と報告してはならない。**

#### (3) bump する手順

1. ADR / GDD 側の該当節が変更済みであることを確認する(未反映なら先に文書)。
2. `content/balance.json` の `algoVersion` を +1 する。
3. `npm run golden:write` → `git diff` を読み、**動いたベクタすべてについて「なぜ動いたか」を 1 行で説明できること**を確認する。説明できない差分が 1 本でもあれば (2) の 2. へ戻る。
4. §0.4 の共通条件(`npm test` / `typecheck` / `lint` / `format`)+ `npm run conformance:e2e`(3 エンジン一致・ADR-017)。
5. コミットメッセージに bump の理由と動いたベクタ本数を書く。ADR-025 の sunset(ライブ 3 世代上限)に触れる場合は退役手順の要否も併記する。

**レビュー可能な不変条件**(CI ジョブ化は M46 の正準パイプライン結線 / M43 の範囲):

> `conformance/vectors/*.json` の `expected` または `splitCounters` を変更する diff を含むコミットは、`content/balance.json` の `algoVersion` の +1 を同時に含むこと。逆に、**ベクタ本体の差分がゼロなのに `algoVersion` だけが動くコミットは原則 reject**(= ADR-016 が排除したかった偽陽性 bump)。

後者が判定できるのは、`index.json` の `algoVersion` が `content/balance.json` から読まれる(`tools/genGoldenVectors.ts` の `currentAlgoVersion()`)一方で、**ベクタ JSON 13 フィールドのどこにも `algoVersion` が無い**ためである。実測: `content/balance.json` の `algoVersion` を 1 → 999 にして `npm run golden:check` を走らせると、報告される差分は **`conformance/vectors/index.json` の 1 件だけ**でベクタ本体は 1 本も動かない(2026-07-28 M2 実測)。

#### (4) 「ダイジェストに `algoVersion` を入れない」原則が拡張後も保たれる条件

2026-07-25(T7 前半)の決定 = §3.4 落とし穴 (1)。入れると bump のたびに全 golden が変わり「golden 変化 ⟺ bump」が恒真化して無意味になる。MVP 拡張でこれが破れる経路は 4 つあり、**それぞれ保つべき条件がある**。

| # | 破れる経路 | 保つ条件 | 危険なタスク |
| --- | --- | --- | --- |
| **A** | 新シナリオが初期 state のメタ 3 軸を engine / content から読む | `conformance/scenarios.ts` の **`baseMeta()` を唯一のメタ供給点として維持**する(現状 `createGameState` の呼び出し 9 箇所すべてが `baseMeta(worldSeed)` を通り、`{saveSchemaVersion: 1, contentVersion: 1, algoVersion: 1}` を返す)。新シナリオもこれを通す | M10・M15・M20・M25 |
| **B** | engine が実行時に「現在の `algoVersion`」を state へ書き込む | engine 内で `algoVersion` を state へ書く新経路を作らない。セーブエンベロープ(`{saveFormatVersion, integrityChecksum, payload}`・裁定 B2)は state の外に置き、分岐木ノードや周回シード導出に `algoVersion` を混ぜない | **M3**(セーブ層)・**M28**(周回シード導出) |
| **C** | ベクタ JSON 自体に `algoVersion` を持たせる | `GoldenVector` に `algoVersion` フィールドを足さない。版の記録は `GoldenVectorIndex.algoVersion`(= `index.json`)だけに置く | M10 以降すべて |
| **D** | rules が `content/balance.json` の `algoVersion` を読む | `algoVersion` を balance の他の係数と同じ扱いにしない。現状 engine は読んでおらず(`schema/balance.ts` が保持し、`currentAlgoVersion()` が `index.json` 用に読むだけ)、この形を維持する | **M5・M6**(balance の全系統化) |

**再現可能な検査手順**(各拡張タスクで 1 回実行し、結果を報告する):

> `content/balance.json` の `algoVersion` を一時的に別の値へ変えて `npm run golden:check` を走らせる。**差分が `conformance/vectors/index.json` の 1 件だけなら原則は保たれている。** ベクタ本体が 1 本でも動いたら A〜D のどれかが破れているので、bump を進める前に原因を特定する。実行後は必ず値を戻し、`git status` がクリーンであることを確認する。
>
> 2026-07-28(M2)実測結果: **差分は `index.json` のみ = 原則は保たれている。**

### 9.5 拡張タスク共通のチェックリスト(M10 / M15 / M20 / M25 / M43)

ロードマップ §0.4 の全タスク共通条件に加えて、conformance 拡張タスクは以下を満たす。

1. 追加した系統について C1〜C7(§9.2(2))を踏んだか。踏まない軸は `note` に理由があるか。
2. 新規申告した経路すべてに反証(§9.2(3))の数値確認があるか。
3. `checkCoverage()` が空配列(§7.4 完了条件 3)。
4. **既存ベクタの `expected` / `splitCounters` が 1 バイトも動いていない**ことを確認したか。動いた場合は §9.4(2) の切り分け結果を報告したか。
5. §9.4(4) の再現検査(`algoVersion` を変えて `golden:check` → 差分が `index.json` のみ)を 1 回実行したか。
6. `npm run golden:check` の実測秒数を報告したか(§9.2(6) の予算追跡)。
7. `npm run conformance:e2e` で 3 エンジン一致(ADR-017)。
8. base content シナリオ(`contentPatch: null`)を減らしていないか。`index.json` の `baseContentVectorIds` は ADR-017 の週次 content パイプラインゲートが使う部分集合なので、**本番 content のまま踏める経路は patch を使わずに書く**(patch は engine 境界被覆に限る・§4.1)。
