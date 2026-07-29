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
// 同上(型のみ)。記録媒体 enum の権威は rules/types.ts。
import type { RecordMedium } from "../rules/types";

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
  /** 6×8 格子の通し番号 0〜47(ADR-002(2) の近傍集計はこの番号で行う)。 */
  readonly cellIndex: number;
  /** 就労中の住民 ID(ID 昇順。順序は集合演算の決定論のため・GDD 11.7)。 */
  readonly workerIds: readonly EntityId[];
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
