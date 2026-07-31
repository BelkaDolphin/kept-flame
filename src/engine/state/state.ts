// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 正規化 GameState の型定義 — ADR-028(1) / ADR-002(1)
//
// GameState は「正規化(normalized)」で保持する: 全 entity を入れ子にせず、
// グローバル一意 ID をキーとする単一の Map(`entityStateById`)に平坦に置き、
// entity どうしの関係は ID 参照で表す。入れ子を作らないので、1 entity の更新で
// 複製されるサブツリーが Map 1 段に限定され、構造共有(ADR-028(1))が
// 「Map を 1 枚と entity を 1 個作り直すだけ」に収まる。
//
// ===========================================================================
// 1. 単一 namespace であることの根拠(ADR「共通規約」602行 / ADR-024(1))
// ===========================================================================
//   ID は全カテゴリ横断でグローバル一意を schema 検証段階で強制するため、
//   カテゴリごとに Map を分けなくても衝突(シャドーイング)が起きない。よって
//   本モジュールはカテゴリ別 Map を持たず `entityStateById` 1 枚に統一する。
//   これはセーブフォーマット(ADR「セーブフォーマット」649行)の
//   `entityStateById` とそのまま 1 対 1 対応し、往復(serialize.ts)が
//   「Map ↔ 1 段のプレーンオブジェクト」で済む。
//
// ===========================================================================
// 2. Map の反復順は「ID の UTF-16 コードユニット昇順」で固定(正準順)
// ===========================================================================
//   `entityStateById` の反復順は常に ID 昇順であることを不変条件とする。
//   維持するのは state/update.ts(createGameState / putEntity)と
//   state/serialize.ts(fromSerializable)の 2 経路だけで、本モジュールは
//   その前提に乗って `entityIds` を無加工で返す(ここで防御的に再ソートすると
//   不変条件が壊れても検出できなくなる)。
//
//   ねらいは 2 つ:
//     (a) 到達経路(どの順で entity を追加したか)に依らず、同じ ID 集合なら
//         必ず同じ反復順になる = 反復順に依存するコードがあっても結果が
//         分岐しない。
//     (b) 直列化が Map の反復順をそのまま書き出せる = 往復のバイト同一性
//         (serialize.ts)を Map 側の性質として保証できる。
//   代償は新規 ID 追加時の Map 再構築(O(n log n))だが、entity 数は
//   施設 48 + 住民 20 + 研究/資源で高々 100 オーダーであり、かつ新規追加は
//   毎 tick の操作ではない(毎 tick 起きるのは既存 entity の値更新 = 挿入位置
//   不変)。
//
// ===========================================================================
// 3. このプロトタイプに含める entity と、含めないもの
// ===========================================================================
//   先行計測計画 §2.1 の P1 は「rules 縮約 3 本((A)生産 / (B)研究完了 /
//   (C)想起困難)が動く範囲」をスコープとする。よって entity は 4 種のみ:
//
//     resident : (C)想起困難の発生式(GDD 11.2)が読む住民個人変数
//     facility : (A)生産の主体。配置セルと従事者、Lv
//     research : (B)研究完了の進行度
//     resource : 生産/研究コストが読み書きする資源ストック
//     codify   : [M6] 成文化ジョブ / 記録 1 枚(GDD 11.1 [2026-07-27追補])。
//                縮約 3 本には要らないが、成文化は (B) レート変化イベントの
//                もう一方の柱(GDD 11.8(B))なので research と同型で足した。
//                既存 conformance シナリオは 1 件も持たないので、この追加で
//                golden vector のバイト列は動かない。
//
//   **含めない**(計測 12 項目のどれにも不要。GDD 全域のモデル化はしない):
//     探索/派遣・分岐木・冒険記 / 襲撃 / 衛星拠点 / 大移動・継承点・周回 /
//     item・在庫・装備 / memoirLog・bond / trait 定義本体(content 側) /
//     6×8 格子の地形・瓦礫 / 難度シード。
//   GameState の非 entity フィールドも同様に絞り、セーブフォーマット
//   (ADR 649行)のうち以下は持たない:
//     eventQueueSnapshot / inProgressOrders : 下記 §4 参照(T5 で不要と判断)。
//     commandLog / renderedLogs / dispatchSnapshots / integrityChecksum /
//     runCount / cumulativeInheritPoints / monotonicTimestamp : 上記の
//       「含めない」機能か、platform 層(永続化・時刻)の担当。
//
//   3 本の rules が読む値だけを持たせてあるので、フィールドを足すときは
//   「その rule が実際に読むか」を基準に additive で足すこと。
//
// ===========================================================================
// 4. rngState と eventQueueSnapshot(T5 で確定)
// ===========================================================================
//   **rngState**(セーブフォーマット 658行 `{ "domainTag": "xoshiro 4×uint32語" }`)を
//   `ReadonlyMap<DomainTag, Xoshiro128State>` として保持する。T4 では
//   domainTags レジストリが 'exploration' 1 件しか無かったため T5 送りにしていた。
//   T5 でレジストリに adjacency / recall / recallDuration が入り、うち
//   **逐次ストリームとして状態を進めるのは recallDuration のみ**である
//   (他は worldSeed + salt から毎回導出する hash アドレス方式なので状態を持たない。
//   どちらの方式かは rng/domainTags.ts のタグ別コメントに書いてある)。
//   反復順は domainTag の UTF-16 コードユニット昇順を正準順とし、維持責務は
//   state/update.ts(createGameState / setRngState)と state/serialize.ts
//   (fromSerializable)にある = entityStateById と全く同じ扱い(§2)。
//
//   **eventQueueSnapshot は持たない。** T5 の離散事象ヒープに載るイベントは
//   すべて state から決定論的に再構成できる(想起困難の回復 tick は
//   `recallImpairedUntilTick`、(C)粗粒度ステップは tick の絶対グリッド、
//   研究完了は進行度とレートからの予測)。再構成できるものをセーブに二重で
//   持つと「state とキューが食い違うセーブ」という壊れ方を作ってしまうため、
//   scheduler.ts の buildEventQueue が単一の真実になる。再構成不能な外因
//   イベント(襲撃の予定 tick 等)を入れる段階で、そのイベントだけを
//   eventQueueSnapshot として足すこと。
// ---------------------------------------------------------------------------

import type { Fix } from "../fp";
import type { DomainTag } from "../rng/domainTags";
import type { Xoshiro128State } from "../rng/xoshiro128";
// 型のみの参照(実行時依存は無い)。ステータス 5 種の正本 ID レジストリは
// 生産式側(rules/stats.ts)が権威なので、state はその型を借りるだけにする。
import type { ResidentStats } from "../rules/stats";
// 同上(型のみ)。記録媒体 enum / 距離帯 enum の権威は rules/types.ts。
import type { DistanceBand, RecordMedium } from "../rules/types";

// --- 1. ID -----------------------------------------------------------------

declare const ENTITY_ID_BRAND: unique symbol;

/**
 * entity の ID。実体は文字列だが、素の文字列と混ぜられないよう branded type に
 * してある。生成口は {@link entityIdFromString} だけ(brand を `as` で偽造
 * しないこと)。
 *
 * 不変条件: {@link ENTITY_ID_PATTERN} に一致する。
 */
export type EntityId = string & { readonly [ENTITY_ID_BRAND]: "EntityId" };

/**
 * ID の命名規則(ADR-011 / ADR「共通規約」602行)。先頭が英小文字なので
 * **正準整数インデックスになり得ない**。これは往復不変性の根拠でもある:
 *
 *   JS のオブジェクトは「正準数値文字列」のキー(`"0"`, `"12"`)を数値キーとして
 *   先頭に繰り上げて列挙するため、キーが整数風だと挿入順が保存されない。
 *   ID が必ず英小文字始まりであることにより、`entityStateById` の
 *   プレーンオブジェクト表現は列挙順 = 挿入順が保証され、JSON.stringify の
 *   出力バイト列が Map の反復順(= ID 昇順)にそのまま従う(ADR-028(2))。
 */
export const ENTITY_ID_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

/** ID 規則違反。content ロード・セーブ復元の境界で必ず停止させる。 */
export class EntityIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityIdError";
  }
}

/** 参照した entity が無い / 種別が食い違う。 */
export class EntityLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityLookupError";
  }
}

/** 文字列が ID 規則(ADR-011)に一致するか。 */
export function isEntityId(value: string): boolean {
  return ENTITY_ID_PATTERN.test(value);
}

/**
 * 文字列から EntityId を作る唯一の口。engine 外(content・セーブ・テスト)から
 * 来た文字列は必ずここを通す。
 *
 * @throws {EntityIdError} ADR-011 の命名規則に一致しない場合
 */
export function entityIdFromString(value: string): EntityId {
  if (!isEntityId(value)) {
    throw new EntityIdError(
      `entityIdFromString: "${value}" は ID 規則 ${ENTITY_ID_PATTERN.source} に一致しない(ADR-011)`,
    );
  }
  return value as EntityId;
}

// --- 2. entity ------------------------------------------------------------

/** entity の種別タグ。`entityStateById` の値を判別するための discriminant。 */
export type EntityKind = "codify" | "facility" | "research" | "resident" | "resource";

/**
 * [M7] 1 住民が保持できる trait の個数上限(GDD 7.2「1住民の trait 保持上限
 * ＝ 3個に固定」)。**engine 側の正本**であり、
 *   - state 構築時の強制  : `state/update.ts` の `createGameState`
 *     (セーブ復元もここを通るので、壊れたセーブは復元時点で停止する)
 *   - content 側の強制    : `schema/trait.ts` の `maxPerResident` がこの値を参照
 * の 2 経路で守る。
 *
 * この上限は飾りではなく **`rules/stats.ts` の mulFixProven の値域証明の前提**
 * でもある(1 住民あたりの加算効果の上界 = 30 × 6 効果 × 3 trait = 540)。
 * 緩めるなら証明側も同時に見直すこと。
 */
export const MAX_TRAITS_PER_RESIDENT = 3;

/**
 * [M11] 住民 1 人の生涯(GDD 7.5 住民寿命モデル)。
 *
 * **3 つの値が対で 1 つの意味を成す**ので、フィールドをばらさず 1 オブジェクトに
 * まとめてある(直列化の分岐が 2^3 通りに膨れるのを避ける実務上の理由もある・
 * serialize.ts §5)。
 *
 * ここに載る量はすべて **tick(整数)** であり、Fix ではない。寿命の抽選は
 * `rules/lifespan.ts` が content の分位テーブルから行う。
 *
 * ```
 *   deathTick   = bornTick + lifespanTick
 *   ageTick(t)  = t − bornTick
 *   残存想定tick(t) = lifespanTick − ageTick(t) = deathTick − t     ← GDD 11.4-4
 * ```
 */
export interface ResidentLife {
  /**
   * 誕生 tick。**負値を許す** — 晴天漂着(GDD 7.7)や初期住民はゲーム開始時点で
   * 既に年齢を持つため、`bornTick = 加入tick − 加入時年齢` が負になりうる。
   */
  readonly bornTick: number;
  /** 寿命(GDD 7.5 `lifespanTick`)。**期間**であって絶対 tick ではない。1 以上。 */
  readonly lifespanTick: number;
  /** 死亡した tick。生存中は null(GDD 11.7 段70「死亡/全滅判定」で書き込まれる)。 */
  readonly diedTick: number | null;
}

/**
 * 住民。(C)想起困難の発生式(GDD 11.2)
 * `p = clamp(0, base_p × loadW + moraleW + dispatchW − masteryResist, p_max)`
 * が読む変数だけを持つ。
 *
 * loadW(過酷業務か通常業務か)は施設側 content の属性から引くので、住民側は
 * 「どの施設に就いているか」(assignedFacilityId)だけを持つ。
 */
export interface ResidentState {
  readonly kind: "resident";
  readonly id: EntityId;
  /** 士気。人間単位 0〜100 の Fix(GDD 11.2 は <30 / <15 / >=40 を閾値に使う)。 */
  readonly morale: Fix;
  /** 実地稼働で蓄積する定着度 masteryResist。人間単位 0〜0.20 の Fix。 */
  readonly mastery: Fix;
  /** 就労中の施設 entity の ID。無配属は null。 */
  readonly assignedFacilityId: EntityId | null;
  /** 探索派遣中か(dispatchW +0.15 の条件)。派遣先の詳細は T4 では持たない。 */
  readonly dispatched: boolean;
  /**
   * 保持する trait の content ID(ID 昇順・重複なし)。記憶巧者 trait の判定と
   * 生産式の trait 倍率(GDD 11.1)に使う。
   *
   * 長さは {@link MAX_TRAITS_PER_RESIDENT} 以下(GDD 7.2)。順序と重複なしは
   * 「同種効果の総乗合成が floor 丸めを挟むため順序依存」という決定論要件から
   * 来る不変条件であり、`createGameState` が機械強制する。
   */
  readonly traitIds: readonly EntityId[];
  /** 想起困難が解ける tick。0 は「発生していない」。 */
  readonly recallImpairedUntilTick: number;
  /**
   * [M5] ステータス 5 種(裁定 B8 / GDD 7.1・人間単位 0〜100)。
   *
   * **省略可**。省略時は {@link NEUTRAL_RESIDENT_STATS}(全て基準 50)として
   * 扱われ、生産寄与が厳密に 1.0 になる(rules/stats.ts §1)。住民生成側で
   * 実際に振る本結線は M7 の担当であり、M5 は「生産式が受け取る形と中立既定値」
   * までを実装する。
   *
   * **直列化形では省略された state のキーを出さない**(serialize.ts §4)。
   * これにより既存セーブ・既存 golden vector のバイト列が 1 bit も動かない。
   */
  readonly stats?: ResidentStats;
  /**
   * [M11] 生涯(GDD 7.5)。**省略可**。
   *
   * **省略された住民は寿命で死なない**(死亡イベントが 1 件も積まれない)。これが
   * M11 以前と 1 bit も違わないことの根拠であり、既存 conformance シナリオの住民は
   * 全員この形のままなので golden vector 37 本が動かない。新規ゲーム・晴天漂着で
   * 生成される住民には `rules/lifespan.ts` の {@link createResidentLife} が必ず付ける。
   */
  readonly life?: ResidentLife;
  /**
   * [M12] memoirLog(GDD 7.3「決定論エピソードログ」)。**省略可**。
   *
   * 保存するのは「テンプレ ID({@link MemoirEntryKind})+ 決定論パラメータ」だけ
   * であり、実際の文言(日本語プロース)は持たない(M12 はデータ層のみ・UI は
   * 対象外)。ADR-012 のセーブ容量目標(512KB)と GDD 8.2 の探索スナップショット
   * 方式(結果を丸ごと保存せず、再現に要る最小パラメータだけを保存する)に倣った
   * 設計判断であり、テンプレ ID → 実文言の対応表は今後 content/UI 層が持つ。
   *
   * **独立 entity にしなかった理由**: 当初は `kind: "memoir"` の独立 entity 案を
   * 検討したが、`EntityKind`/`EntityState` へ新種別を足すと `src/ui/derived.ts`
   * 等の**既存の網羅 switch(`default: never`)が壊れる**ことが typecheck で
   * 判明した。UI 層はこのタスクの担当外(タスク指示「`src/ui/**` は触るな」)
   * なので、既存の union に手を入れない本フィールド方式を採用する。
   *
   * 代償は直列化の分岐が `stats?` / `life?` と合わせて 2^3 = 8 通りに膨れる
   * ことだが(serialize.ts §5 の教訓の延長)、生スプレッド禁止の下でも
   * `undefined` の 3 変数を素直に 8 リテラルへ書き分ければ済む(既存の 4 分岐と
   * 質的には同じパターン)。
   *
   * **省略された住民は memoirLog を持たない**(既存 conformance シナリオ・
   * 既存セーブは 1 bit も変わらない)。
   */
  readonly memoir?: MemoirLogState;
}

/**
 * [M11] その住民が生存しているか。**死亡判定の唯一の述語**であり、
 * 生産(rules/production.ts の isWorkerActive)・想起困難の判定ペア
 * (rules/recall.ts)・人口計数(rules/population.ts)がすべてここを通る。
 *
 * 死亡した住民は entity ごと消さず `life.diedTick` を立てて残す(tombstone)。
 * 消さない理由は 2 つ:
 *   (a) memoirLog / bond(GDD 7.3・M12)は「失った人が何を覚えていたか」を
 *       名指しで提示する = 死後もデータが要る
 *   (b) entity 削除は他 entity からの ID 参照(facility.workerIds 等)を
 *       ぶら下がり参照にする。死亡処理は参照側を掃除するが、掃除漏れが
 *       「黙って例外」でなく「黙って消える」形になるのを避ける
 */
export function isAliveResident(resident: ResidentState): boolean {
  return resident.life === undefined || resident.life.diedTick === null;
}

/**
 * [M16] 施設の占有形状(GDD 6.1「1 セル = 1 施設(大型は 2×1 / 2×2 占有)」)。
 *
 * 幅・高さはともに 1〜`FOOTPRINT_DIM_MAX`(= 2)の整数。占有セル集合そのものは
 * 持たず、基準セル(アンカー)`FacilityState.cellIndex` と本値から
 * `footprint.ts` の `occupiedCells` が導出する(理由は footprint.ts §1)。
 *
 * `ResidentLife` / `MemoirLogState` と同じく **`kind`/`id` を持たない値
 * オブジェクト**である(entity ではない)。
 */
export interface FacilityFootprint {
  /** 横方向(x)のセル数。1〜2。 */
  readonly width: number;
  /** 縦方向(y)のセル数。1〜2。 */
  readonly height: number;
}

/**
 * 施設。(A)生産の主体。
 *
 * tags / lvCurve / 過酷業務かどうかといった定義値は content 側(facility 定義)に
 * あり、state は「どの定義の実体が、どのセルに、Lv いくつで、誰が就いているか」
 * だけを持つ(正規化)。
 */
export interface FacilityState {
  readonly kind: "facility";
  readonly id: EntityId;
  /** content の facility 定義 ID。同じ定義の実体が複数あるので id とは別に持つ。 */
  readonly defId: EntityId;
  /** Lv 1〜5(GDD)。上限の検証は schema 検証器(T6)の担当。 */
  readonly level: number;
  /**
   * 6×8 格子の通し番号 0〜47(ADR-002(2) の近傍集計はこの番号で行う)。
   *
   * [M16] 大型施設では**占有矩形のアンカー(= 占有セル番号の最小 = 左上)**である。
   * 1×1 では従来どおり「建っているセル」そのものであり、意味は変わらない。
   */
  readonly cellIndex: number;
  /** 就労中の住民 ID(ID 昇順。順序は集合演算の決定論のため・GDD 11.7)。 */
  readonly workerIds: readonly EntityId[];
  /**
   * [M16] 占有形状(GDD 6.1)。**省略可**。
   *
   * **省略 ⇔ 1×1** の 1 対 1 対応であり、直列化形では 1×1 をキーごと省略する
   * (`stats` / `life` / `memoir` と同じ規約・serialize.ts §7)。これにより
   * M16 以前のセーブと golden vector 40 本のバイト列が 1 bit も動かない。
   *
   * content 側の定義(`FacilityDef.footprint`)から**配置時に焼き込む**
   * (`commands.ts` の `placeFacility`)。content の footprint 変更が既存盤面の
   * 占有形状を遡って書き換えないようにするためであり、理由は footprint.ts §1。
   */
  readonly footprint?: FacilityFootprint;
}

/**
 * 研究進行。(B)研究完了 = レート変化イベント(GDD 11.8(B))の対象。
 *
 * 研究コスト・prereq は content の tech 定義にあるので、state は進行度と
 * 完了 tick だけを持つ。
 */
export interface ResearchState {
  readonly kind: "research";
  readonly id: EntityId;
  /** content の tech 定義 ID。 */
  readonly techId: EntityId;
  /** 蓄積研究点。 */
  readonly progress: Fix;
  /** 完了した tick。未完了は null。 */
  readonly completedTick: number | null;
  /**
   * [M13] 技術喪失(GDD 7.4 の二層 / GDD §10.2 と同一規則)。**省略可**。
   *
   * 「生存保持者ゼロ かつ 記録ゼロ」になった瞬間に
   * `rules/techMemory.ts` の `applyTechLossOnDeath` が書き込む。書き込みと同時に
   * `completedTick` は null・`progress` は 0 へ戻る(= 解禁が取り消される)ので、
   *   (A) criticalRecoverable : 再研究できる = **停滞コストのみ**(GDD 7.4)
   *   (B) rareIrreversible    : {@link TechLossState.irreversible} が true で
   *                             `rules/research.ts` の `currentResearch` が
   *                             対象から外す = **一回性喪失**
   * という二層がこの 1 フィールドで表現される。
   *
   * **省略された research entity は一度も喪失していない**(既存 conformance
   * シナリオ・既存セーブは 1 bit も変わらない・serialize.ts §7)。
   */
  readonly loss?: TechLossState;
}

/**
 * [M13] 技術喪失 1 件の記録(GDD 7.4)。`ResearchState.loss` の値の形。
 *
 * `kind`/`id` を持たない**値オブジェクト**である(entity ではない)。
 */
export interface TechLossState {
  /** 喪失した tick(GDD 11.7 段70 = 死亡/全滅判定の tick)。 */
  readonly tick: number;
  /**
   * 一回性(取り返しのつかない)喪失か。`tech.lossClass` が
   * `rareIrreversible` のときだけ true(GDD 7.4「『取り返しのつかない喪失』は
   * (B) のみ、(A) には使わない」)。
   */
  readonly irreversible: boolean;
  /**
   * 最後の保持者(この住民の死亡で保持者ゼロになった)の ID。
   *
   * **[M22] 省略可になった。** 記録の焼失(`destroyRecords`・GDD 11.1 追補)で
   * 「生存保持者ゼロ かつ 記録ゼロ」に達した場合、喪失の引き金は**死亡ではなく
   * 記録の消滅**なので名指しできる保持者が居ない。そのときだけキーごと省略する
   * (= 従来の死亡起因の喪失は必ずキーを持つ = 既存セーブのバイト列は不変)。
   */
  readonly lastHolderId?: EntityId;
}

/**
 * 資源ストック。(A)生産の出力先であり (B)研究コストの引き落とし元。
 */
export interface ResourceState {
  readonly kind: "resource";
  readonly id: EntityId;
  /** content の resource 定義 ID。 */
  readonly resourceId: EntityId;
  /** 現在庫。 */
  readonly stock: Fix;
  /**
   * [M5] 累計産出(オーバーフロー損失率 GDD 11.4-7 の分母)。
   *
   * **上限が有限な資源についてのみ記録する**({@link cumulativeOverflow} と
   * 常に対で存在するか、対で存在しない)。上限無指定の資源では会計自体が
   * 意味を持たない(損失は構造的に 0)ので持たず、直列化形にもキーを出さない
   * = 既存セーブ・既存 golden vector のバイト列が動かない。
   */
  readonly cumulativeProduced?: Fix;
  /**
   * [M5] 累計オーバーフロー量(同分子)。廃材変換前の**超過そのもの**であり、
   * 廃材へ変換された分も破棄された分も両方含む(GDD 6.7)。
   *
   * 廃材生成量を「この累計値の差分」から導くことで、区間を分割しても
   * 生成量が一致する(rules/storage.ts §3 の telescoping)。
   */
  readonly cumulativeOverflow?: Fix;
}

/**
 * [M6] 成文化ジョブ / 記録(GDD 6.2 / 11.1 [2026-07-27追補])。
 *
 * **1 entity = 記録 1 枚**であり、`completedTick` が
 *   null      → 成文化キューに並んでいる(作業中)
 *   非 null   → 記録として存在している
 * を表す。研究 entity と同じ形(進行度 + 完了 tick)にしてあるのは、成文化完了が
 * 研究完了と同じ (B) レート変化イベント(GDD 11.8(B))だからである。
 *
 * 同一 tech に**媒体別の記録を並存できる**(GDD 11.1 追補: 紙で速攻 → 後に石板へ
 * 写す副本動線)。よって一意なのは (techId, medium) の組であり、techId 単独ではない。
 * 「その tech が成文化済み」= 完了済み記録が 1 件以上存在すること。
 */
export interface CodifyState {
  readonly kind: "codify";
  readonly id: EntityId;
  /** 成文化対象の tech 定義 ID。 */
  readonly techId: EntityId;
  /** 記録媒体(engine 既知の 2 種・GDD 11.1 追補)。 */
  readonly medium: RecordMedium;
  /**
   * **着手時点で確定した所要作業量**(GDD 12.5-8「着手済みオーダーは着手時点
   * パラメータをスナップショット確定」)。単位は「学者 1 人 × 1 tick = 1.0」。
   *
   * スナップショットにしているのは、作業中に E3 印刷が解禁されると所要時間が
   * 変わってしまい、同じ区間を分割して進めた結果が食い違う(分割不変性・
   * advance.ts §3)ため。
   */
  readonly requiredWork: Fix;
  /** 蓄積した作業量。 */
  readonly progress: Fix;
  /** 記録が完成した tick。作業中は null。 */
  readonly completedTick: number | null;
}

// ===========================================================================
// [M12] memoirLog(GDD 7.3「決定論エピソードログ」)
// ===========================================================================
//   保存するのは「テンプレ ID(MemoirEntryKind)+ 決定論パラメータ」だけであり、
//   実際の文言(日本語プロース)は**持たない**(M12 はデータ層のみ・UI は対象外)。
//   これは ADR-012 のセーブ容量目標(512KB)と GDD 8.2 の探索スナップショット
//   方式(結果を丸ごと保存せず、決定論的に再現可能な最小パラメータだけを保存
//   する)に倣った設計判断であり、テンプレ ID → 実文言の対応表は今後
//   content/UI 層が持つ。
//
//   bioOrigin / bioCatchphrase / bioFear : 加入時に決定論生成される簡易バイオ
//     (GDD 7.3「出自・口癖・恐れ」)。`variantIndex` は候補の何番目かを指す
//     (候補数・実文言の管理は rules/memoir.ts と将来の content/UI 層の担当)。
//   arrival       : 加入(誕生)の記録。
//   bondMilestone : 特定の相方(partnerId)との bond(rules/bond.ts が
//     GameState.bondByPairKey で管理)が節目(tier)を超えた。GDD 7.3
//     「記憶の可視化」が参照する主要な材料。
//   partnerLost   : bond を結んでいた相方(partnerId)を喪失した
//     (GDD 7.3「相方の喪失で bond 相手に一時的士気ペナ」の記録側)。
//   death         : 本人が死亡した(ResidentLife.diedTick と対になる記録)。

/**
 * [M12] memoirLog のエントリ種別(上記)。宣言順に意味は無く UTF-16 昇順に
 * 揃えてある(rules/memoir.ts の候補走査順は別に配列で固定するので、この定数の
 * 並びが選択の決定論性に影響することは無い)。
 */
export const MEMOIR_ENTRY_KINDS = [
  "arrival",
  "bioCatchphrase",
  "bioFear",
  "bioOrigin",
  "bondMilestone",
  "death",
  "explorationRescue",
  "partnerLost",
] as const;

/** {@link MEMOIR_ENTRY_KINDS} のいずれか。 */
export type MemoirEntryKind = (typeof MEMOIR_ENTRY_KINDS)[number];

/** 未知の文字列が memoir エントリ種別のいずれかか(型ガード)。 */
export function isMemoirEntryKind(value: string): value is MemoirEntryKind {
  for (const kind of MEMOIR_ENTRY_KINDS) {
    if (kind === value) return true;
  }
  return false;
}

/** GDD 7.3 の bio 3 カテゴリ(出自/口癖/恐れ)のいずれか。 */
export type MemoirBioKind = "bioCatchphrase" | "bioFear" | "bioOrigin";

/** 加入時に決定論生成されるバイオ 1 件(上記)。 */
export interface MemoirBioEntry {
  readonly kind: MemoirBioKind;
  readonly tick: number;
  /** 候補の何番目か(rules/memoir.ts の `MEMOIR_BIO_VARIANT_COUNT` 未満)。 */
  readonly variantIndex: number;
}

/** 加入(誕生)の記録。 */
export interface MemoirArrivalEntry {
  readonly kind: "arrival";
  readonly tick: number;
}

/** bond が節目を超えた記録(rules/bond.ts / GameState.bondByPairKey)。 */
export interface MemoirBondMilestoneEntry {
  readonly kind: "bondMilestone";
  readonly tick: number;
  readonly partnerId: EntityId;
  /** 節目の段(1 始まり・rules/bond.ts の `BOND_MILESTONE_TIER_FIXES` の添字+1)。 */
  readonly tier: number;
}

/** bond を結んでいた相方を喪失した記録。 */
export interface MemoirPartnerLostEntry {
  readonly kind: "partnerLost";
  readonly tick: number;
  readonly partnerId: EntityId;
}

/** 本人が死亡した記録。 */
export interface MemoirDeathEntry {
  readonly kind: "death";
  readonly tick: number;
}

/**
 * [M21] 探索で人を保護した記録(GDD 7.3 の例「近郊探索で△を保護した」)。
 *
 * 記録されるのは**保護した側**(帰還した派遣メンバー)であり、`rescuedId` が
 * 保護された住民 = GDD 7.7「探索での保護」で加入した本人を指す。晴天漂着
 * (段65 の定期加入)とは別口の加入経路である(rules/exploration.ts §5)。
 */
export interface MemoirExplorationRescueEntry {
  readonly kind: "explorationRescue";
  readonly tick: number;
  /** 保護されて加入した住民の ID。 */
  readonly rescuedId: EntityId;
  /** どの距離帯での出来事か(文言のレンダリングに使う)。 */
  readonly band: DistanceBand;
}

/** memoirLog 1 件のエントリ(判別共用体)。 */
export type MemoirEntry =
  | MemoirArrivalEntry
  | MemoirBioEntry
  | MemoirBondMilestoneEntry
  | MemoirDeathEntry
  | MemoirExplorationRescueEntry
  | MemoirPartnerLostEntry;

/**
 * [M12] 住民 1 人の memoirLog(GDD 7.3)。`ResidentState.memoir`(上記)の値の形。
 *
 * 独立 entity(`kind: "memoir"`)にする案も検討したが、`EntityKind`/`EntityState`
 * へ新種別を足すと `src/ui/derived.ts` 等の既存の網羅 switch が壊れる
 * (typecheck で確認済み・UI はこのタスクの担当外)ため、resident の省略可能
 * フィールドとして持つ(`ResidentState.memoir` の doc 参照)。
 *
 * `kind`/`id` を持たない**値オブジェクト**である(entity ではない)。
 */
export interface MemoirLogState {
  /**
   * 記録(古い順・重複なし)。件数上限(rules/memoir.ts の `MAX_MEMOIR_ENTRIES`)
   * を超えた分は先頭から落とし、{@link foldedCount} に繰り込む
   * (GDD 7.3「件数上限で古いものは要約に畳む」)。
   */
  readonly entries: readonly MemoirEntry[];
  /** 上限超過で畳まれた(=詳細を失った)件数。0 以上。 */
  readonly foldedCount: number;
}

// ===========================================================================
// [M21] 探索派遣のスナップショット(GDD 8.2 / 12.5-7)と帰還ログ(GDD 8.4)
// ===========================================================================
//   GDD 12.5-7 は「探索イベント列は派遣時点スナップショット固定(**再参照禁止**)、
//   帰還ログはレンダリング済み完成文字列保存(再参照禁止)」と定める。よって
//   この 2 つは state.ts §3 の「持たない」リストから外れ、GameState 直下の
//   フィールドになる(独立 entity にしないのは MemoirLogState と同じ理由 =
//   `src/ui/derived.ts` 等の既存の網羅 switch を壊さないため)。
//
//   **スナップショットは content を 1 度も再参照せずに再生できる**ことが要件で
//   あり、そのため難度・roll・判定結果・報酬額・脱落者まで確定値で持つ。
//   帰還 tick の処理は「保存された結果を state へ適用するだけ」になる。

/**
 * [M21] 派遣の方針(GDD 8.3「撤退 / 強行」の直前選択)。**派遣確定時に 1 度だけ
 * 選ぶ**のが MVP の縮約であり、ノードごとのプレイヤー対話(GDD 8.3 の本来形)は
 * event ランタイム(M22)+ 探索本部 UI(M32)の担当。
 *
 * 並びは UTF-16 昇順(集合演算の安定順序・GDD 11.7)。
 *   cautious : 累積負傷が閾値へ達したノードで撤退(報酬は半分・以降打ち切り)
 *   press    : 撤退しない。失敗時の負傷が ×1.5(GDD 8.3)
 */
export const DISPATCH_STANCES = ["cautious", "press"] as const;

/** {@link DISPATCH_STANCES} のいずれか。 */
export type DispatchStance = (typeof DISPATCH_STANCES)[number];

/** 未知の文字列が派遣方針のいずれかか(型ガード)。 */
export function isDispatchStance(value: string): value is DispatchStance {
  for (const stance of DISPATCH_STANCES) {
    if (stance === value) return true;
  }
  return false;
}

/**
 * [M21] スナップショットされたイベントノード 1 件(GDD 8.2)。
 * **確定済みの結果**であり、帰還時に再判定は行わない。
 *
 * `kind`/`id` を持たない値オブジェクトである(entity ではない)。
 */
export interface DispatchNode {
  /** 判定難度(人間単位の Fix。combatPower と同じ 0〜100 スケール)。 */
  readonly difficultyFix: Fix;
  /** `seededRoll(0..R)` の確定値(GDD 8.2)。 */
  readonly rollFix: Fix;
  /** 判定結果 = `チーム総合力 + 装備補正 + roll >= difficulty`(GDD 8.2)。 */
  readonly success: boolean;
  /** このノードで得た報酬(失敗なら 0)。撤退による半減は適用**前**。 */
  readonly rewardFix: Fix;
  /** このノードを終えた時点の累積負傷(GDD 8.5)。 */
  readonly injuryFix: Fix;
  /** このノードで「探索での保護」が起きたか(GDD 7.7)。 */
  readonly rescue: boolean;
  /**
   * [M22] 選ばれた choice の添字(GDD 8.3・`EventNodeDef.choices` の添字)。
   * **省略時は「選択肢が無かった」**(M21 の手続き生成ノードは常に省略)。
   */
  readonly choiceIndex?: number;
  /**
   * [M22] 成立した branch の添字(`EventNodeDef.branches` の添字)。
   * **省略時は「分岐を持たないノード」**(同上)。
   */
  readonly branchIndex?: number;
  /**
   * [M22] 成立した branch の `logTemplate` を**レンダリングし終えた完成文字列**
   * (GDD 8.4 / 12.5-7「帰還ログはレンダリング済み完成文字列保存(再参照禁止)」)。
   * **省略時は分岐ログ無し**。
   */
  readonly logText?: string;
  /**
   * [M22] 帰還 tick に適用する効果(GDD 12.1 追補の `destroyRecords` 等)。
   * **省略時は効果なし**。派遣確定時に確定済みの値だけを持つので、帰還処理は
   * content を読まずに適用できる(rules/exploration.ts §1)。
   */
  readonly effects?: readonly DispatchEffect[];
}

/**
 * [M22] スナップショットへ焼き込まれた効果 1 件。**確定値のみ**(content を
 * 指すのは resource / medium のような engine 既知の語彙だけ)。
 *
 * `kind`/`id` を持たない値オブジェクトである(entity ではない)。
 */
export type DispatchEffect = {
  readonly kind: "destroyRecords";
  /** 対象媒体(`rules/types.ts` の `DestroyRecordsMedium`)。 */
  readonly medium: string;
  /** 対象範囲(同 `DestroyRecordsScope`)。 */
  readonly scope: string;
};

/**
 * [M21] 派遣 1 本ぶんのスナップショット(GDD 8.2 / 12.5-7)。
 *
 * `nodes` は**実際に踏んだノードだけ**(撤退で打ち切られた以降は入らない)。
 * ADR-012(3) の上界「2 × maxNodes(8) = 16 ノード/派遣」に対し、撤退枝を
 * 材料化せず歩いた道だけを持つので実測は高々 8 + 器 1 = 9 ノードであり、
 * 上界には十分な余裕がある(`platform/persistence.ts` の
 * `assertDispatchTreeBounds` が書込・インポートの両方で検算する)。
 */
export interface DispatchSnapshot {
  /** 派遣の ID(entity ではないが ID 規則 ADR-011 に従う)。 */
  readonly id: EntityId;
  /** 目的地 content の ID(スナップショット。以後 content を再参照しない)。 */
  readonly destinationId: EntityId;
  /** 距離帯(裁定 B7)。 */
  readonly band: DistanceBand;
  /** 派遣方針(GDD 8.3)。 */
  readonly stance: DispatchStance;
  /** チーム(ID 昇順・1〜4 名・GDD 8.1)。 */
  readonly memberIds: readonly EntityId[];
  /** 派遣を確定した tick。 */
  readonly dispatchTick: number;
  /** 帰還して解決される tick(GDD 11.7 段60)。 */
  readonly returnTick: number;
  /** 判定に使った「チーム総合力 + 装備補正」(GDD 8.2)。 */
  readonly teamPowerFix: Fix;
  /** 踏んだイベントノード列(上記)。 */
  readonly nodes: readonly DispatchNode[];
  /** 撤退で打ち切ったか(GDD 8.3)。 */
  readonly withdrawn: boolean;
  /** 帰還時に受け取る総報酬(撤退の半減を適用**後**の確定値)。 */
  readonly rewardFix: Fix;
  /** 報酬を受け取る resource 定義 ID。 */
  readonly rewardResourceId: EntityId;
  /**
   * 脱落した(= 帰還後に死亡処理へ回る)メンバー(ID 昇順・GDD 8.5)。
   * `memberIds` と一致すれば全滅である。
   */
  readonly casualtyMemberIds: readonly EntityId[];
  /**
   * [M22] このイベント列の出所になった event content の ID(GDD 12.1)。
   * **省略時は M21 の手続き生成**(content に event が無い / 目的地に対応する
   * event が無い場合)であり、既存セーブのバイト列は 1 bit も動かない。
   *
   * スナップショットに焼くのは「どの event だったか」を後から示すためだけで
   * あり、帰還処理はこの ID で content を引き直さない(GDD 12.5-7)。
   */
  readonly eventId?: EntityId;
}

/**
 * [M21] 帰還ログ 1 件(GDD 8.4 / 12.5-7)。**レンダリング済みの完成文字列**を
 * 保存し、テンプレを再参照しない(後日のテンプレ修正・tombstone 化で過去ログが
 * 壊れないため)。memoirLog が「テンプレ ID + パラメータ」なのと**意図的に
 * 非対称**であり、根拠は GDD 12.5-7 が帰還ログについてだけ完成文字列を求めて
 * いることにある。
 */
export interface RenderedLogEntry {
  readonly tick: number;
  /** レンダリング済みの本文。 */
  readonly text: string;
}

/**
 * [M21] 帰還ログの保持(GDD 8.4「ログ保持上限 50 件、超過分は要約統計に畳む」/
 * 12.5-9)。`MemoirLogState` と同型(古い順・超過は先頭から落として件数だけ残す)。
 */
export interface RenderedLogState {
  /** 記録(古い順)。上限は `rules/exploration.ts` の `MAX_RENDERED_LOGS`。 */
  readonly entries: readonly RenderedLogEntry[];
  /** 上限超過で畳まれた件数。0 以上。 */
  readonly foldedCount: number;
}

/** 空の帰還ログ(正準形)。`GameState.renderedLogs` の既定値。 */
export const EMPTY_RENDERED_LOGS: RenderedLogState = { entries: [], foldedCount: 0 };

// ===========================================================================
// [M24] 衛星拠点(GDD 9.2 / 12.1)
// ===========================================================================
//   `EntityKind` へは足さない(M12 の memoir と同じ判断: 新種別を足すと
//   `src/ui/derived.ts` 等の既存の網羅 switch(`default: never`)が壊れる。
//   UI 層はこのタスクの担当外)。`DispatchSnapshot` と同じく、ID 規則
//   (ADR-011)には従うが entity ではない値オブジェクトとして GameState 直下の
//   Map(`outpostsById`)に持つ。

/**
 * [M24] 衛星拠点 1 基(GDD 9.2「探索確保地点に住民1〜4名常駐」)。
 *
 * 供給/維持費/hazard の決定論 rules は `src/engine/rules/outpost.ts` が持つ
 * (state はここに持たない。facility が Lv/産出先を content 側に持つのと同じ
 * 正規化)。
 */
export interface OutpostState {
  readonly id: EntityId;
  /** content の outpostType 定義 ID。 */
  readonly outpostTypeId: EntityId;
  /** 拠点 Lv(1 以上)。 */
  readonly level: number;
  /** 確保した距離帯(裁定 B7)。維持費の距離帯係数(GDD 9.2)に使う。 */
  readonly band: DistanceBand;
  /**
   * 常駐する住民 ID(ID 昇順・重複なし・1〜4 名・GDD 9.2)。**この配列に載る
   * 住民は本拠のどの facility.workerIds にも同時に載ってはならない**
   * (二重計上の防止・rules/outpost.ts の `computeOutpostSupplyRates` が計算の
   * たびに検査する)。
   */
  readonly residentIds: readonly EntityId[];
  /** 設置 tick。hazard の経過日数の起点(rules/outpost.ts)。 */
  readonly establishedTick: number;
}

// ===========================================================================
// [M52] 地形 / 瓦礫(GDD 9.1「本拠格子拡張」/ GDD 6.1「初期利用可は一部」)
// ===========================================================================
//   GDD 6.1 は「初期 6×8 = 48 セル。初期利用可は一部、残りは瓦礫セル(開墾で
//   解放)」と定める。state はこれを **「瓦礫セルの一覧」という例外集合**として
//   持ち、**開墾済みを既定**とする。逆向き(開墾済みセルの一覧)にしない理由は
//   縮約互換にある —— 瓦礫の概念を持たない既存セーブ・既存 golden vector 64 本は
//   「例外ゼロ」= 全 48 セル開墾済み、として 1 bit も変えずに読める
//   (serialize.ts §10。M52 検収条件「旧セーブが『全セル開墾済み』として無損失
//   ロードされる」の実装上の根拠)。開墾済み側を列挙する表現にすると、キーの
//   無い旧セーブが「1 セルも使えない盤面」に化ける。
//
//   `EntityKind` へ足さないのは M12 の memoir / M24 の outpost と同じ判断
//   (新種別を足すと `src/ui/derived.ts` 等の既存の網羅 switch が壊れる)。
//
//   2 つの値を 1 オブジェクトにまとめてあるのは {@link ResidentLife} と同じ理由
//   (独立した省略可フィールドにすると直列化の分岐が倍に増える・serialize.ts §5)。

/**
 * [M52] 本拠格子の地形(GDD 9.1)。`kind`/`id` を持たない**値オブジェクト**で
 * ある(entity ではない)。
 *
 * 「地形」という広い名前にしてあるのは、GDD 9.1 が瓦礫のほかに「新資源露頭
 * (鉄鉱脈セル等)」も同じ格子の属性として挙げているためで、そちらを足すときに
 * GameState 直下のキーを増やさず本オブジェクトへ additive で足せる。
 */
export interface TerrainState {
  /**
   * 未開墾の瓦礫セル(**セル番号の昇順・重複なし**・各値は 0〜47)。
   * **空 = 全セル開墾済み**であり、これが既定(= 旧セーブの解釈)である。
   *
   * 不変条件の強制は state/update.ts の `createGameState` / `setTerrain`
   * (セーブ復元もそこを通るので、壊れたセーブは復元時点で停止する)。
   */
  readonly rubbleCells: readonly number[];
  /**
   * これまでに開墾したセル数。GDD 9.1 のコスト式 `base × 1.15^解放数` の
   * **指数そのもの**であり、開墾 1 回ごとに +1 される。
   *
   * `rubbleCells` の長さからは導出できない —— 初期の瓦礫枚数は content 側の
   * 生成パラメータ(`balance.reclaim.initialRubbleCells`)であって state には
   * 残らないので、「何枚剥がしたか」は独立に数える必要がある。
   */
  readonly reclaimedCount: number;
}

/**
 * [M52] 瓦礫が 1 枚も無い地形(正準形)。`GameState.terrain` の既定値であり、
 * **直列化形ではキーごと省略される**({@link EMPTY_RENDERED_LOGS} と同じ規約・
 * serialize.ts §10)。
 */
export const EMPTY_TERRAIN: TerrainState = { rubbleCells: [], reclaimedCount: 0 };

// ===========================================================================
// [M28] 周回進行 / 継承点(GDD 10.2〜10.5 / 10.3 / 11.4-6)
// ===========================================================================
//   ADR「セーブフォーマット」は `runCount` と `cumulativeInheritPoints` を
//   payload の**トップレベルキー**として列挙しているが、本実装は 3 つの値を
//   1 つの値オブジェクト {@link ProgressionState} にまとめ、GameState 直下の
//   **省略可フィールド 1 つ**として持つ。理由は 2 つ:
//
//     (a) 継承点は「累計獲得」だけでは足りない —— GDD 10.3 の購入
//         (`cost(n) = 50 × 1.5^n`)を表すには**系統別の購入済み段数**が要る。
//         一方 GDD 10.5 の周回シード導出は「**累計**継承点」を材料にするので、
//         購入で減る残高を累計に混ぜてはならない。よって
//         「累計獲得(単調増加)」+「系統別段数(そこから残高を導出)」の
//         2 本立てになり、フィールドが 3 つになる。
//     (b) トップレベルの**必須**キーとして足すと、既存セーブ・既存 golden
//         vector 73 本の JSON バイト列が全て動く(必須キーは常に書き出される)。
//         `terrain`([M52])と同じ「既定値なら**キーごと省略**」規約に乗せる
//         には 1 オブジェクトにまとめるのが最短で、直列化の分岐も増えない
//         ({@link ResidentLife} と同じ理由・serialize.ts §5)。
//
//   `EntityKind` へ足さないのは memoir([M12])/ outpost([M24])/ terrain
//   ([M52])と同じ判断(新種別は `src/ui/derived.ts` 等の網羅 switch を壊す)。

/**
 * [M28] 継承ボーナスの系統(GDD 10.3「各ボーナスに上限段階」「全3系統」)。
 * **engine 既知の 3 種固定(enum)**であり content カテゴリではない
 * (`RecordMedium` / `DistanceBand` と同じ扱い)。並びは UTF-16 昇順 =
 * 集合演算の安定順序(GDD 11.7)。
 *
 *   caravanCapacity : 大移動キャラバンの石版換算枠 +N(GDD 10.2 の
 *                     `容量 = ceil(想定石版総数 × 0.35) + 継承点ボーナス`)
 *   crewCapacity    : 乗員定員 +N(同 `crewCap = ceil(生存人数 × 0.5) + 継承ボーナス`)
 *   startingStock   : 新周回の初期在庫 +N(GDD 10.6-1 が周回変化の軸として
 *                     「初期資源」を挙げているのに対応する恒久ボーナス側)
 *
 * 3 系統のうち GDD が式の中で名指ししているのは前 2 つだけであり、3 つめは
 * 「全3系統」という本数だけが与えられている。`startingStock` を充てたのは
 * **engine 内で完結して効果を出せる**(大移動が作る次周 state の資源在庫へ
 * そのまま乗る)ためで、他候補(研究速度・幕塵後退速度)は tick ループや
 * content 側の係数に手を入れる = golden vector を動かす変更になる。
 */
export const INHERIT_TRACKS = ["caravanCapacity", "crewCapacity", "startingStock"] as const;

/** {@link INHERIT_TRACKS} のいずれか。 */
export type InheritTrack = (typeof INHERIT_TRACKS)[number];

/** 未知の文字列が継承系統のいずれかか(型ガード)。 */
export function isInheritTrack(value: string): value is InheritTrack {
  for (const track of INHERIT_TRACKS) {
    if (track === value) return true;
  }
  return false;
}

/** [M28] 1 系統ぶんの購入済み段数。`kind`/`id` を持たない値オブジェクト。 */
export interface InheritTierEntry {
  readonly track: InheritTrack;
  /** 購入済み段数。**1 以上**(0 段はエントリごと持たないのが正準形)。 */
  readonly tier: number;
}

/**
 * [M28] 周回の進行(GDD 10.2〜10.5)。`kind`/`id` を持たない**値オブジェクト**で
 * ある(entity ではない)。
 */
export interface ProgressionState {
  /**
   * 完了した大移動の回数。**0 = 1 周目**(まだ 1 度も大移動していない)。
   * GDD 10.5 の周回シード導出 `hash(前worldSeed, 周回回数, 累計継承点)` の
   * 「周回回数」そのもの。
   */
  readonly runCount: number;
  /**
   * これまでに**獲得**した継承点の累計(GDD 10.3 の獲得式の総和)。
   * **購入では減らない**(減らすと GDD 10.5 のシード材料が過去へ巻き戻り、
   * 同じ周回で買い物をしただけで次周の世界が変わってしまう)。いま使える
   * 残高は `累計 − Σ(購入済み段のコスト)` として `rules/exodus.ts` が導出する。
   */
  readonly cumulativeInheritPoints: number;
  /**
   * 系統別の購入済み段数(**track の UTF-16 昇順・重複なし・tier >= 1**)。
   * 0 段の系統はエントリを持たない(= 遅延初期化。`bondByPairKey` と同じ規約)。
   */
  readonly inheritTiers: readonly InheritTierEntry[];
}

/**
 * [M28] まだ 1 周もしておらず継承点も持たない進行(正準形)。
 * `GameState.progression` の既定値であり、**直列化形ではキーごと省略される**
 * ({@link EMPTY_TERRAIN} と同じ規約・serialize.ts §11)。
 */
export const EMPTY_PROGRESSION: ProgressionState = {
  runCount: 0,
  cumulativeInheritPoints: 0,
  inheritTiers: [],
};

/** `entityStateById` に入る値の全体。`kind` で判別する。 */
export type EntityState =
  CodifyState | FacilityState | ResearchState | ResidentState | ResourceState;

/** 種別タグから entity 型を引く。`EntityOfKind<"resident">` = ResidentState。 */
export type EntityOfKind<K extends EntityKind> = Extract<EntityState, { readonly kind: K }>;

// --- 3. GameState ---------------------------------------------------------

/**
 * GameState のうち entity 以外のスカラ。createGameState の引数にも使う。
 *
 * 3 バージョン軸(ADR「バージョニング / マイグレーション(3軸)」)はセーブに
 * そのまま載るので state 側に保持する。
 */
export interface GameStateMeta {
  /** セーブ構造の版。差があればマイグレーション連鎖(ADR 3軸(a))。 */
  readonly saveSchemaVersion: number;
  /** content の版。差は additive-only で吸収(ADR 3軸(b))。 */
  readonly contentVersion: number;
  /** 決定論バンドルの版。golden vector 変化と 1 対 1(ADR-016 / 3軸(c))。 */
  readonly algoVersion: number;
  /** 世界シード。RNG への展開(hash → uint32)は T5 の rng 配線で行う。 */
  readonly worldSeed: string;
  /** ゲーム内時刻。1 tick = 1 分(ADR-026)。 */
  readonly tick: number;
}

/**
 * 正規化されたゲーム状態。**不変(immutable)**であり、更新は
 * state/update.ts の単一経路(updateEntity / updateIn / putEntity /
 * removeEntity / setField)だけを通す(ADR-028(1))。
 *
 * 不変条件:
 *   (a) `entityStateById` の反復順は ID の UTF-16 コードユニット昇順(§2)
 *   (b) キーと値の `id` が一致する
 *   (c) 全 ID が {@link ENTITY_ID_PATTERN} に一致する(§1)
 *   (d) `rngState` の反復順は domainTag の UTF-16 コードユニット昇順(§4)
 *   (e) [M12] `bondByPairKey` の反復順はキーの UTF-16 コードユニット昇順
 *       (rules/bond.ts の `bondPairKeyOf` が課す正準形。(d) と同じ扱い)
 *   (f) [M13] `techMemoryByKey` の反復順はキーの UTF-16 コードユニット昇順
 *       (rules/techMemory.ts の `techMemoryKeyOf` が課す正準形。(e) と同じ扱い)
 *   (g) [M21] `dispatchSnapshots` は派遣 ID の UTF-16 コードユニット昇順
 *       (配列だが正準順は同じ規約。維持責務は update.ts の
 *       createGameState / setDispatchSnapshots)
 *   (h) [M24] `outpostsById` の反復順は ID の UTF-16 コードユニット昇順
 *       (entityStateById と同じ扱い。維持責務は update.ts の
 *       createGameState / setOutpost / setOutposts)。各 OutpostState の
 *       `residentIds` も ID 昇順・重複なし・1〜4 件(GDD 9.2)
 *   (i) [M52] `terrain.rubbleCells` はセル番号の昇順・重複なし・全要素が
 *       0〜`GRID_CELL_COUNT-1` の整数、`terrain.reclaimedCount` は 0 以上の整数
 *       (維持責務は update.ts の createGameState / setTerrain)
 *   (j) [M28] `progression.inheritTiers` は track の UTF-16 昇順・重複なし・
 *       各 tier は 1 以上の整数、`runCount` / `cumulativeInheritPoints` は
 *       0 以上の整数(維持責務は update.ts の createGameState / setProgression)
 */
export interface GameState extends GameStateMeta {
  readonly entityStateById: ReadonlyMap<EntityId, EntityState>;
  /**
   * ドメイン別の逐次 RNG ストリーム状態(§4 / ADR-007)。
   *
   * 「まだ 1 度も引いていないドメイン」はキーを持たない(= 遅延初期化)。
   * 初回の draw で `hash(worldSeed, domainTag, [])` から seed 展開される
   * ため、キーの有無で結果が分岐することはない。hash アドレス方式のドメイン
   * (adjacency / recall)は永久にここへ現れない。
   */
  readonly rngState: ReadonlyMap<DomainTag, Xoshiro128State>;
  /**
   * [M12] 住民ペアの絆(GDD 7.3)。キーは `rules/bond.ts` の
   * `bondPairKeyOf(residentAId, residentBId)`(2 者の ID を UTF-16 昇順に
   * 正規化して `"a|b"` の形に合成した文字列)。値は蓄積した絆値(Fix)。
   *
   * まだ 1 組も bond を持たないペアはキーを持たない(= 0 と同義・遅延初期化。
   * rngState と同じ設計)。独立 entity にしなかった理由は
   * {@link MemoirLogState} の doc と同じ(`src/ui/derived.ts` 等の既存の
   * 網羅 switch を壊さないため)。
   */
  readonly bondByPairKey: ReadonlyMap<string, Fix>;
  /**
   * [M13] 住民 × 技術の記憶(GDD 11.2 の `masteryResist(u,t)` と
   * 「当該住民の当該 tech 関連生産のみ停止」の担い手)。キーは
   * `rules/techMemory.ts` の `techMemoryKeyOf(residentId, techId)`
   * (`"residentId|techId"`)。
   *
   * まだ実地稼働も想起困難も無いペアはキーを持たない(= 全ゼロと同義・遅延
   * 初期化。`bondByPairKey` と同じ設計)。**この Map が空である state は
   * M13 以前と 1 bit も違わない**(想起困難の抽選が per-tech 記録を書き始めた
   * 時点で初めてキーが生える)。
   *
   * 独立 entity(`kind: "techMemory"`)にしなかった理由は
   * {@link MemoirLogState} の doc と同じ(`src/ui/derived.ts` 等の既存の
   * 網羅 switch を壊さないため)。resident 側の省略可フィールドにしなかった
   * 理由は、`stats?` / `life?` / `memoir?` に 4 つめを足すと serialize.ts の
   * 分岐が 2^4 = 16 通りへ膨れるため(serialize.ts §7)。
   */
  readonly techMemoryByKey: ReadonlyMap<string, TechMemoryState>;
  /**
   * [M21] 未帰還の探索派遣(GDD 8.2 / 12.5-7)。**派遣 ID の UTF-16 昇順**
   * (不変条件 (g))で、帰還解決が済んだものは取り除かれる = 長さは
   * `CONCURRENT_DISPATCH_MAX`(2)以下(commands.ts §5)。
   *
   * Map ではなく配列なのは、セーブフォーマット(ADR「セーブフォーマット」)の
   * `dispatchSnapshots` が配列であり、`platform/persistence.ts` の
   * `assertDispatchTreeBounds` がその形で上界を検算しているためである。
   * 要素数が高々 2 なので、キー引きの計算量も問題にならない。
   *
   * **空配列なら直列化形からキーごと省略される**(rngState と同じ規約・
   * serialize.ts §9)= M21 以前のセーブ・golden vector のバイト列が 1 bit も
   * 動かないことの根拠。
   */
  readonly dispatchSnapshots: readonly DispatchSnapshot[];
  /**
   * [M21] 帰還ログ(GDD 8.4)。**レンダリング済み文字列**であり、空
   * (`entries` 空 かつ `foldedCount` 0)なら直列化形から省略される。
   */
  readonly renderedLogs: RenderedLogState;
  /**
   * [M24] 衛星拠点(GDD 9.2)。キーは拠点 ID(不変条件 (h))。
   * **空なら直列化形からキーごと省略される**(rngState と同じ規約)
   * = M24 以前のセーブ・既存 golden vector のバイト列が 1 bit も動かない
   * ことの根拠(既存シナリオは 1 件も拠点を持たない)。
   */
  readonly outpostsById: ReadonlyMap<EntityId, OutpostState>;
  /**
   * [M52] 本拠格子の地形(GDD 9.1・不変条件 (i))。**既定は
   * {@link EMPTY_TERRAIN} = 瓦礫ゼロ = 全 48 セル開墾済み**であり、空なら
   * 直列化形からキーごと省略される(`renderedLogs` と同じ規約)= M52 以前の
   * セーブ・既存 golden vector 64 本のバイト列が 1 bit も動かないことの根拠。
   *
   * 初期盤面の瓦礫は content(`balance.reclaim.initialRubbleCells`)から
   * `rules/reclaim.ts` の `initialTerrain` が組み立てる **明示的な生成
   * パラメータ**であり、`createGameState` の既定値ではない(既定を瓦礫ありに
   * すると既存 conformance シナリオの盤面が遡って変わる)。
   */
  readonly terrain: TerrainState;
  /**
   * [M28] 周回の進行(GDD 10.2〜10.5・不変条件 (j))。**既定は
   * {@link EMPTY_PROGRESSION} = 1 周目・継承点ゼロ**であり、既定なら
   * 直列化形からキーごと省略される(`terrain` と同じ規約)= M28 以前の
   * セーブ・既存 golden vector 73 本のバイト列が 1 bit も動かないことの根拠。
   *
   * 更新するのは `rules/exodus.ts`(大移動の実行と継承ボーナスの購入)だけで
   * あり、tick ループ(advance / scheduler)からは一切触らない —— これが
   * 「既存 conformance シナリオに構造的に無影響」の実装上の根拠でもある。
   */
  readonly progression: ProgressionState;
}

/**
 * [M13] 住民 1 人 × 技術 1 本ぶんの記憶(GDD 11.2 / 7.4)。
 * `GameState.techMemoryByKey` の値の形であり、値オブジェクト(entity ではない)。
 *
 * 2 つの量が 1 つの意味(「その人がその技術をどれだけ体で覚えているか / いま
 * 想起できているか」)を成すので、1 オブジェクトにまとめてある
 * (`ResidentLife` と同じ理由・serialize の分岐を増やさない)。
 */
export interface TechMemoryState {
  /**
   * 実地稼働で蓄積した定着度(GDD 11.2 `masteryResist` の「実地稼働で蓄積する
   * 定着度(0〜0.20)」の当該 tech ぶん)。人間単位の Fix。
   *
   * **0 より大きいことが「その住民がその技術の保持者である」ことの定義**
   * (GDD 7.4 の (B) 一回性喪失判定 = `rules/techMemory.ts` の `techHoldersOf`)。
   */
  readonly masteryFix: Fix;
  /**
   * その (住民, 技術) の想起困難が解ける tick。0 は「発生していない」。
   * 住民単位スカラの `ResidentState.recallImpairedUntilTick` の tech 別版で
   * あり、**本式(M13)の抽選はこちらへ書く**(rules/recall.ts §3)。
   */
  readonly impairedUntilTick: number;
}

// --- 4. 参照 ---------------------------------------------------------------

/** entity を引く。無ければ undefined。 */
export function getEntity(state: GameState, id: EntityId): EntityState | undefined {
  return state.entityStateById.get(id);
}

/**
 * entity を種別付きで引く。存在と種別を実行時に検査して narrowing する。
 * 「あるはず」の参照(rules から の参照はほぼ全てこれ)に使い、
 * 不在を黙って読み飛ばさない。
 *
 * @throws {EntityLookupError} 存在しない、または種別が食い違う場合
 */
export function requireEntity<K extends EntityKind>(
  state: GameState,
  id: EntityId,
  kind: K,
): EntityOfKind<K> {
  const entity = state.entityStateById.get(id);
  if (entity === undefined) {
    throw new EntityLookupError(`requireEntity: entity "${id}" が存在しない(期待種別 ${kind})`);
  }
  if (entity.kind !== kind) {
    throw new EntityLookupError(
      `requireEntity: entity "${id}" の種別は ${entity.kind} で、期待した ${kind} と違う`,
    );
  }
  return entity as EntityOfKind<K>;
}

/**
 * 全 entity の ID を正準順(ID 昇順・§2)で返す。Map の反復順をそのまま
 * 使うので、不変条件が守られている限り追加のソートは不要。
 */
export function entityIds(state: GameState): readonly EntityId[] {
  return [...state.entityStateById.keys()];
}

/**
 * 指定種別の entity を正準順(ID 昇順)で返す。集合演算(合計・按分)に渡す
 * 配列は必ずこの順序にすること(GDD 11.7: 加算順序が結果に影響する)。
 */
export function entitiesOfKind<K extends EntityKind>(
  state: GameState,
  kind: K,
): readonly EntityOfKind<K>[] {
  const result: EntityOfKind<K>[] = [];
  for (const entity of state.entityStateById.values()) {
    if (entity.kind === kind) {
      result.push(entity as EntityOfKind<K>);
    }
  }
  return result;
}

/**
 * [M11] 生存している住民を正準順(ID 昇順)で返す。人口(GDD 7.6 の下限判定・
 * 7.7 の規模)を数える唯一の入口。tombstone された住民は含まない。
 */
export function livingResidents(state: GameState): readonly ResidentState[] {
  const result: ResidentState[] = [];
  for (const entity of state.entityStateById.values()) {
    if (entity.kind === "resident" && isAliveResident(entity)) {
      result.push(entity);
    }
  }
  return result;
}

/**
 * ドメインの逐次 RNG ストリーム状態(§4)。まだ 1 度も引いていなければ
 * undefined。「引いたことがあるか」自体は結果に影響しない(遅延初期化)。
 */
export function getRngState(state: GameState, domainTag: DomainTag): Xoshiro128State | undefined {
  return state.rngState.get(domainTag);
}

/**
 * ストリーム状態を保持している domainTag を正準順(昇順・§4)で返す。
 * `entityIds` と同じく Map の反復順をそのまま使う(防御的な再ソートはしない)。
 */
export function rngStateDomains(state: GameState): readonly DomainTag[] {
  return [...state.rngState.keys()];
}

/**
 * [M12] 住民ペアの絆値(GameState.bondByPairKey の doc 参照)。まだ形成されて
 * いないペアは undefined(「引いたことがあるか」自体は結果に影響しない遅延
 * 初期化・rngState と同じ規約)。キーの構成は `rules/bond.ts` の
 * `bondPairKeyOf` を通すこと(このモジュールはキー文字列の意味を解釈しない)。
 */
export function getBondValue(state: GameState, pairKey: string): Fix | undefined {
  return state.bondByPairKey.get(pairKey);
}

/**
 * bond を保持しているペアキーを正準順(昇順)で返す。`rngStateDomains` と同じく
 * Map の反復順をそのまま使う(防御的な再ソートはしない)。
 */
export function bondPairKeys(state: GameState): readonly string[] {
  return [...state.bondByPairKey.keys()];
}

/**
 * [M13] 住民 × 技術の記憶({@link GameState.techMemoryByKey} の doc 参照)。
 * まだ実地稼働も想起困難も無いペアは undefined(遅延初期化・`getBondValue` と
 * 同じ規約)。キーの構成は `rules/techMemory.ts` の `techMemoryKeyOf` を通すこと
 * (このモジュールはキー文字列の意味を解釈しない)。
 */
export function getTechMemory(state: GameState, key: string): TechMemoryState | undefined {
  return state.techMemoryByKey.get(key);
}

/**
 * [M13] 記憶を保持しているキーを正準順(昇順)で返す。`bondPairKeys` と同じく
 * Map の反復順をそのまま使う(防御的な再ソートはしない)。
 */
export function techMemoryKeys(state: GameState): readonly string[] {
  return [...state.techMemoryByKey.keys()];
}

/**
 * [M21] 未帰還の派遣を引く(無ければ undefined)。走査は正準順(ID 昇順・
 * 不変条件 (g))で、要素数は高々 `CONCURRENT_DISPATCH_MAX`(2)。
 */
export function getDispatch(state: GameState, dispatchId: EntityId): DispatchSnapshot | undefined {
  for (const snapshot of state.dispatchSnapshots) {
    if (snapshot.id === dispatchId) return snapshot;
  }
  return undefined;
}

/**
 * [M21] その住民が今どれかの派遣に載っているか。`ResidentState.dispatched`
 * (GDD 11.2 の dispatchW の条件)と食い違うセーブを作らないための照合口。
 */
export function isResidentOnDispatch(state: GameState, residentId: EntityId): boolean {
  for (const snapshot of state.dispatchSnapshots) {
    for (const memberId of snapshot.memberIds) {
      if (memberId === residentId) return true;
    }
  }
  return false;
}

/** [M24] 衛星拠点を引く(無ければ undefined)。 */
export function getOutpost(state: GameState, outpostId: EntityId): OutpostState | undefined {
  return state.outpostsById.get(outpostId);
}

/**
 * [M24] 全拠点を正準順(ID 昇順・不変条件 (h))で返す。`entitiesOfKind` と同じく
 * Map の反復順をそのまま使う(防御的な再ソートはしない)。
 */
export function allOutposts(state: GameState): readonly OutpostState[] {
  return [...state.outpostsById.values()];
}

/**
 * [M52] そのセルが未開墾の瓦礫か(GDD 9.1)。**瓦礫を持たない state では常に
 * false** = 全セル開墾済み、という既定がここに 1 箇所だけある。
 *
 * 走査は昇順の配列を舐めるだけ(高々 48 件)。Set を作らないのは、地形の照会が
 * 起きるのは配置/開墾コマンドの実行時だけであり(tick ループには乗らない)、
 * Map/Set を state へ持たせると正準順の維持責務が 1 つ増えるためである。
 */
export function isRubbleCell(state: GameState, cellIndex: number): boolean {
  for (const cell of state.terrain.rubbleCells) {
    if (cell === cellIndex) return true;
  }
  return false;
}

/**
 * [M52] 指定したセル集合のうち**瓦礫であるセル番号の最小値**を返す(無ければ
 * null)。大型施設(footprint 2×1 / 2×2)の全占有セル検査に使う口であり、
 * 「どのセルが瓦礫で引っかかったか」を reject に載せられるよう、真偽ではなく
 * セル番号を返す。
 *
 * 入力の並び順に依存しない(明示的に最小を選ぶ)= 決定論。
 * `footprint.ts` の `findOccupancyConflict` が「衝突セルの最小」を返すのと同型。
 */
export function firstRubbleCellIn(state: GameState, cells: readonly number[]): number | null {
  let best: number | null = null;
  for (const cell of cells) {
    if (!isRubbleCell(state, cell)) continue;
    if (best === null || cell < best) best = cell;
  }
  return best;
}

/**
 * [M28] その系統の購入済み段数(GDD 10.3)。エントリを持たない系統は **0 段**
 * (遅延初期化・`getBondValue` と同じ規約で「引いたことがあるか」は結果に
 * 影響しない)。走査は昇順の配列を舐めるだけ(高々 3 件)。
 */
export function inheritTierOf(state: GameState, track: InheritTrack): number {
  for (const entry of state.progression.inheritTiers) {
    if (entry.track === track) return entry.tier;
  }
  return 0;
}
