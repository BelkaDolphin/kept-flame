// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- engine コマンド層 — M49 / ADR-002(1) / ADR-012(1)(3) / GDD 6.6
//
// プレイヤー操作が state を動かす**唯一の入口**。UI(src/ui/store.ts)は
// `{ type: "commandApplied", command }` を dispatch し、ストアはここの
// {@link apply} を呼んだ結果を据えるだけで、判定は 1 行も持たない。
//
// ===========================================================================
// 0. なぜ「単一入口」なのか
// ===========================================================================
//   M8 の時点では、画面が engine の純関数を直接呼んで作った state を
//   `stateApplied` という暫定イベントでストアへ渡していた(architecture.md §7-2)。
//   この形には 2 つの穴がある:
//     (a) 「置けるか」「払えるか」の判定が画面側に散る。同じ判定を 12 画面が
//         別々に書けば、必ずどこかがずれる(= UI ごとに違うルールのゲームになる)。
//     (b) セーブのコマンド計数(ADR-012(1) の「25 コマンドごとの強制フラッシュ」)が
//         数えるべき「1 コマンド」の実体がどこにも無い。
//   本モジュールはその 2 つを閉じる。コマンドは**値**であり、適用は純関数、
//   結果は成功 state か機械可読の reject である。
//
// ===========================================================================
// 1. 決定論(ADR-006/007/026)
// ===========================================================================
//   コマンドの解決に使ってよい入力は **state(tick を含む)・content・引数** だけ。
//   実時刻(Date/performance)も乱数も読まない。RNG が要る操作(探索派遣の
//   イベント列生成 = GDD 8.2)は `hash(worldSeed, domainTag, …)` 経由で domainTag
//   レジストリに登録してから実装すること(M21)。現時点で実装済みのコマンドは
//   **1 つも RNG を引かない**(引く必要が無い操作しか実装していない)。
//
//   コマンドは `state.tick` を進めない。「今」は常に `state.tick` である。
//
// ===========================================================================
// 2. scheduler の中心不変条件との関係(scheduler.ts §1)
// ===========================================================================
//   scheduler は「レートを変える全状態変化が heap のイベントとして境界化されて
//   いる」ことを不変条件にしている。コマンドはレートを変える(施設を建てる /
//   就労者を動かす / Lv を上げる)が、**advance の外**で、区間の内側ではなく
//   区間と区間の**あいだ**で起きる:
//
//       advance(t0→t1) … [コマンド適用(tick は t1 のまま)] … advance(t1→t2)
//
//   `buildEventQueue`(scheduler.ts)は advance のたびに state から heap を
//   作り直す(= キューはセーブに持たない・裁定 B3)ので、コマンドで変わった
//   レートは次の advance の最初の区間から自動的に反映される。よって
//   **コマンドのために新しい境界イベントを積む必要は無い**。
//   逆に言えば「advance の実行中にコマンドを適用する」ことだけは禁止であり、
//   engine の同期純関数構成(lint で async 禁止)がそれを構造的に不可能にしている。
//
// ===========================================================================
// 3. reject は例外ではなく値(silent failure 禁止)
// ===========================================================================
//   資源不足・占有衝突・上限超過のような**プレイヤーが普通に起こす失敗**は、
//   例外でも「黙って何もしない」でもなく {@link CommandRejection} として返す。
//   理由は 3 つ:
//     (a) 黙って無視すると、UI は「押したのに何も起きない」を表示できない。
//     (b) 例外にすると呼び出し側が try/catch でまとめて握り潰しやすく、
//         結果として (a) と同じ壊れ方になる。
//     (c) reject の理由は `code` で機械可読にしておくと、UI の文言・sim の
//         統計・#11 の reject 再試行コスト計測がすべて同じ分類を使える。
//
//   一方、**事前検査を通ったのに rules が RulesError を投げた**場合は握り潰さない
//   (それは content とコマンド層の食い違い = 実装バグであり、静かに戻り値へ
//   化けさせると原因が消える)。
//
// ===========================================================================
// 4. スコープ(M49 が実装するもの / 型だけ予約するもの)
// ===========================================================================
//   実装 : 配置 / 解体 / 増築 / 住民割当 / 割当解除 / 成文化指示 /
//          廃材→研究点変換(GDD 6.7 3出口(3))
//   予約 : 探索派遣確定(M21)/ 瓦礫開墾(M18)/ 研究対象の選択(担当未割当)
//   予約分は語彙(型)と reject コード `notImplemented` + 担当タスク名だけを持ち、
//   **それらしい名前で何もしないコマンドにはしない**(store.ts §1 と同じ規律)。
//   {@link RESERVED_COMMAND_OWNER_TASK} が機械可読の正本である。
//
//   実装済みコマンドが**建設コストを払わない**のは content にコストが無いため
//   (GDD 12.1 の facility スキーマは `(id, tags[], slots, lvCurve,
//   overflowCapPolicy)` でコスト項が無い)。GDD 6.7 の廃材 3 出口(1)
//   「施設増築コストの一部代替」も、代替すべきコストが存在しないので実装できない
//   (`substituteCostWithWaste` は成文化 = 出口(2) からのみ呼ばれている)。
//   これは M49 の手抜きではなく content スキーマ側の穴であり、要ユーザー判断。
// ---------------------------------------------------------------------------

import { GRID_CELL_COUNT } from "./adjacency";
import { compareUtf16 } from "./canonicalize";
import { toRaw, type Fix } from "./fp";
import {
  beginCodification as beginCodificationRule,
  codifyWasteSubstitution,
  isPrintingUnlocked,
  planCodification,
} from "./rules/codify";
import { currentResearch } from "./rules/research";
import { convertWasteToResearchPoints, wasteStockOf, wasteToResearchPoints } from "./rules/storage";
import type { EngineContent, FacilityDef, RecordMedium } from "./rules/types";
import {
  entitiesOfKind,
  getEntity,
  isAliveResident,
  type EntityId,
  type FacilityState,
  type GameState,
  type ResidentState,
} from "./state/state";
import { putEntity, removeEntity, setField, updateEntity } from "./state/update";

// --- 1. コマンド語彙 --------------------------------------------------------

/**
 * 施設を 1 基置く(GDD 6.6 の「タップ選択 → 配置先タップ」の 2 ステップ目)。
 *
 * 1 ステップ目(選択)は UI 状態であって state を動かさないので、コマンドは
 * 確定の 1 発だけである(store の `cellSelected` が選択側の担当)。
 *
 * **footprint は 1×1 固定**(2×1 / 2×2 は M16 で state 側に占有セル集合が
 * 入ってから)。よって占有衝突の検査は `cellIndex` 1 個で閉じている。
 */
export interface PlaceFacilityCommand {
  readonly kind: "placeFacility";
  /** 新しく作る施設 entity の ID(既存 ID と衝突したら reject)。 */
  readonly facilityId: EntityId;
  /** content の facility 定義 ID。 */
  readonly defId: EntityId;
  /** 6×8 格子の通し番号 0〜47。 */
  readonly cellIndex: number;
}

/**
 * 施設を解体する。就労者は**engine 側で**全員外す(UI に後始末をさせない)。
 * 解体で資源は戻らない(建設コストが content に無いため・§4)。
 */
export interface DemolishFacilityCommand {
  readonly kind: "demolishFacility";
  readonly facilityId: EntityId;
}

/** 施設を 1 段増築する(Lv+1)。上限は {@link facilityMaxLevel}。 */
export interface UpgradeFacilityCommand {
  readonly kind: "upgradeFacility";
  readonly facilityId: EntityId;
}

/**
 * 住民を施設へ就労させる(GDD 7.7 の割り振り)。
 *
 * 1 住民は高々 1 施設にしか就けないので、別施設に就いていれば**同じコマンドの
 * 中で**外す(2 コマンドに割ると、途中の state で二重就労が観測できてしまう)。
 */
export interface AssignResidentCommand {
  readonly kind: "assignResident";
  readonly residentId: EntityId;
  readonly facilityId: EntityId;
}

/** 住民の就労を解除する(無配属にする)。 */
export interface UnassignResidentCommand {
  readonly kind: "unassignResident";
  readonly residentId: EntityId;
}

/**
 * 成文化を指示する(GDD 6.2 / 11.1 [2026-07-27追補])。媒体は engine 既知の 2 種。
 * 同一 tech の別媒体は並存できるが、同一媒体の重複は reject。
 */
export interface BeginCodificationCommand {
  readonly kind: "beginCodification";
  /** 新しく作る codify entity(= 記録 1 枚)の ID。 */
  readonly codifyId: EntityId;
  readonly techId: EntityId;
  readonly medium: RecordMedium;
}

/**
 * 廃材を研究点へ変換する(GDD 6.7 の 3 出口(3)「廃材 N → RP 1」)。
 * 連続流ではなく**コマンド実行時の純関数**であることが GDD 6.7 [2026-07-28追補]
 * の正本(storage.ts §4)。
 */
export interface ConvertWasteToResearchCommand {
  readonly kind: "convertWasteToResearch";
  /** 投入する廃材の量(Fix)。 */
  readonly wasteAmountFix: Fix;
}

/**
 * **型のみ予約**(担当 M21): 探索派遣の確定(GDD 8.1 / 8.2)。
 *
 * 確定時に `seed = hash(worldSeed, "exploration", dispatchTick, teamIds, destId)` を
 * 固定してイベント列を丸ごとスナップショットする = 本コマンドが **RNG を引く
 * 唯一のコマンド**になる予定であり、domainTag `exploration` は登録済み。
 * 分岐木ノードの上界(§5)もここで効く。
 */
export interface DispatchExpeditionCommand {
  readonly kind: "dispatchExpedition";
  /** 目的地 content の ID。 */
  readonly destinationId: EntityId;
  /** チーム(1〜4 名・GDD 8.1)。 */
  readonly teamResidentIds: readonly EntityId[];
}

/** **型のみ予約**(担当 M18): 瓦礫セルの開墾(GDD 9.1)。地形は state に無い。 */
export interface ReclaimCellCommand {
  readonly kind: "reclaimCell";
  readonly cellIndex: number;
}

/**
 * **型のみ予約**(担当未割当): 研究対象の選択。
 *
 * 現 engine の研究は「未完了 research entity の ID 昇順で先頭 1 本」という縮約
 * (research.ts §2)であり、プレイヤーが選ぶ余地が無い。選択を入れるには縮約の
 * 解消(キューの明示的な順序 or 対象フラグ)が要り、それは golden vector が動く
 * 変更である。**どのタスクが持つかがロードマップに無い**ため、語彙だけ予約して
 * 報告する(M8 が `commands.ts` の担当不在を見つけたのと同じ形の穴)。
 */
export interface BeginResearchCommand {
  readonly kind: "beginResearch";
  /** 新しく作る research entity の ID。 */
  readonly researchId: EntityId;
  readonly techId: EntityId;
}

/** プレイヤー操作の全語彙。 */
export type Command =
  | AssignResidentCommand
  | BeginCodificationCommand
  | BeginResearchCommand
  | ConvertWasteToResearchCommand
  | DemolishFacilityCommand
  | DispatchExpeditionCommand
  | PlaceFacilityCommand
  | ReclaimCellCommand
  | UnassignResidentCommand
  | UpgradeFacilityCommand;

export type CommandKind = Command["kind"];

/**
 * {@link apply} の入力。**1 個または列**を受ける。
 *
 * 列は「1 つでも reject なら全部捨てる」原子適用である(§6)。用途は
 * 「解体してから同じセルへ建て直す」のように、途中の state を誰にも見せたくない
 * 操作。UI から見ると dispatch 1 回 = 再描画 1 回 = セーブ計数 1 件になる。
 */
export type CommandInput = Command | readonly Command[];

/** 実装済みコマンドの種別(UTF-16 昇順・機械可読の正本)。 */
export const IMPLEMENTED_COMMAND_KINDS: readonly CommandKind[] = [
  "assignResident",
  "beginCodification",
  "convertWasteToResearch",
  "demolishFacility",
  "placeFacility",
  "unassignResident",
  "upgradeFacility",
];

/**
 * 語彙だけ予約してあるコマンドと、その実装を持つ担当タスク(§4)。
 * `apply` は `notImplemented` で reject し、この文字列を `ownerTask` に載せる。
 */
export const RESERVED_COMMAND_OWNER_TASK: { readonly [K in CommandKind]?: string } = {
  beginResearch: "未割当(研究の単一キュー縮約の解消が前提・research.ts §2)",
  dispatchExpedition: "M21(探索エンジン・GDD 8.1/8.2)",
  reclaimCell: "M18(瓦礫セルの state 化・GDD 9.1)",
};

/** その種別が実装済みか(予約語彙なら false)。 */
export function isImplementedCommandKind(kind: CommandKind): boolean {
  for (const implemented of IMPLEMENTED_COMMAND_KINDS) {
    if (implemented === kind) return true;
  }
  return false;
}

// --- 2. reject(§3) --------------------------------------------------------

/**
 * reject の分類(機械可読)。UI の分岐・sim の統計・計測 #11 はこの `code` を見る
 * こと(`message` は人間向けであり、文言は予告なく変わる)。
 */
export const COMMAND_REJECTION_CODES = [
  /** 引数そのものが不正(範囲外の数値・空の列・効果が 0 になる量など)。 */
  "invalidArgument",
  /** 語彙は在るが実装がまだ無い(担当は `ownerTask`)。 */
  "notImplemented",
  /** 参照した entity が state に無い / 種別が違う。 */
  "entityNotFound",
  /** 新規に作る entity の ID が既に使われている。 */
  "entityIdInUse",
  /** content に定義が無い(facility 定義 / tech 定義)。 */
  "unknownContentDef",
  /** content にその機構のパラメータが無い(recordMedia / storage 未設定)。 */
  "contentUnsupported",
  /** セル番号が格子の外。 */
  "cellOutOfRange",
  /** そのセルに既に施設が建っている(GDD 6.1: 1 セル = 1 施設)。 */
  "cellOccupied",
  /** これ以上増築できない(Lv 上限)。 */
  "levelAtMax",
  /** 就労スロットが埋まっている(GDD 7.7)。 */
  "facilitySlotsFull",
  /** 住民がその操作を受けられない(死亡 / 探索派遣中)。 */
  "residentUnavailable",
  /** 既にその施設に就労している。 */
  "alreadyAssigned",
  /** 就労していないので解除できない。 */
  "notAssigned",
  /** 同じ (tech, 媒体) の記録が既にある(GDD 11.1 追補)。 */
  "duplicateRecord",
  /** 資源が足りない。 */
  "insufficientResource",
  /** 研究点の受け皿(未完了の research)が無い。 */
  "noResearchTarget",
] as const;

export type CommandRejectionCode = (typeof COMMAND_REJECTION_CODES)[number];

/**
 * コマンド層の契約違反(語彙外のコマンド・列の穴)。**プレイヤー操作の失敗ではない**
 * (そちらは {@link CommandRejection})ので、値に化けさせず例外にする。
 */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * 拒否の理由。**全フィールドが常に存在する**(該当しない項目は null)。
 * 省略可フィールドにしないのは、呼び出し側が `in` 演算子や undefined 判定で
 * 分岐を書き分けずに済むようにするため(= JSON へそのまま落とせる形)。
 */
export interface CommandRejection {
  readonly code: CommandRejectionCode;
  /** どのコマンドが落ちたか。入力そのものの不正(空の列)では null。 */
  readonly commandKind: CommandKind | null;
  /** 列入力のとき何番目で落ちたか(単体なら 0)。 */
  readonly commandIndex: number;
  /** 主対象の entity ID(該当しなければ null)。 */
  readonly subjectId: EntityId | null;
  /** セル番号(該当しなければ null)。 */
  readonly cellIndex: number | null;
  /** 上限値 / 実測値(件数系の reject 以外は null)。 */
  readonly limit: number | null;
  readonly actual: number | null;
  /** 不足した資源の定義 ID と、必要量 / 手持ち(Fix の raw)。 */
  readonly resourceId: EntityId | null;
  readonly requiredRaw: number | null;
  readonly availableRaw: number | null;
  /** `notImplemented` のときの担当タスク(§4)。 */
  readonly ownerTask: string | null;
  /** 人間向けの説明。分岐に使わないこと。 */
  readonly message: string;
}

/** 適用できたときの結果。 */
export interface CommandAccepted {
  readonly ok: true;
  /** 適用後の state(構造共有・ADR-028)。 */
  readonly state: GameState;
  /**
   * state が実際に変わったか(参照比較)。冪等なコマンドを弾いているので通常は
   * true だが、rules 側が「変化なし」を返す経路(廃材 0 変換など)があるため
   * 呼び出し側が無駄なセーブ計数を避けられるよう明示して返す。
   */
  readonly changed: boolean;
  /** 適用したコマンド数(列入力なら要素数)。セーブのコマンド計数の単位。 */
  readonly commandCount: number;
}

/** 拒否されたときの結果。**state は 1 bit も変わっていない**(部分適用しない)。 */
export interface CommandRejected {
  readonly ok: false;
  readonly rejection: CommandRejection;
}

export type CommandResult = CommandAccepted | CommandRejected;

/** reject を組み立てる唯一の口(フィールドの埋め忘れを型で防ぐ)。 */
interface RejectionInput {
  readonly code: CommandRejectionCode;
  readonly message: string;
  readonly subjectId?: EntityId;
  readonly cellIndex?: number;
  readonly limit?: number;
  readonly actual?: number;
  readonly resourceId?: EntityId;
  readonly requiredRaw?: number;
  readonly availableRaw?: number;
  readonly ownerTask?: string;
}

function rejected(kind: CommandKind | null, index: number, input: RejectionInput): CommandRejected {
  return {
    ok: false,
    rejection: {
      code: input.code,
      commandKind: kind,
      commandIndex: index,
      subjectId: input.subjectId ?? null,
      cellIndex: input.cellIndex ?? null,
      limit: input.limit ?? null,
      actual: input.actual ?? null,
      resourceId: input.resourceId ?? null,
      requiredRaw: input.requiredRaw ?? null,
      availableRaw: input.availableRaw ?? null,
      ownerTask: input.ownerTask ?? null,
      message: input.message,
    },
  };
}

// --- 3. 参照ヘルパ ---------------------------------------------------------

function facilityAt(state: GameState, cellIndex: number): FacilityState | undefined {
  for (const facility of entitiesOfKind(state, "facility")) {
    if (facility.cellIndex === cellIndex) return facility;
  }
  return undefined;
}

function facilityOf(state: GameState, id: EntityId): FacilityState | undefined {
  const entity = getEntity(state, id);
  if (entity === undefined || entity.kind !== "facility") return undefined;
  return entity;
}

function residentOf(state: GameState, id: EntityId): ResidentState | undefined {
  const entity = getEntity(state, id);
  if (entity === undefined || entity.kind !== "resident") return undefined;
  return entity;
}

/**
 * その施設が受け入れられる就労者数(GDD 7.7「施設ごと就労スロット(Lvで増加)」)。
 *
 * **content に `slots` が無い定義では undefined = 上限なし**。engine のテスト
 * フィクスチャのように縮約された facility 定義でも動くようにするためであり、
 * 実 content(`content/facility.json` の `slots`)は必ず値を持つ
 * (`schema/engineContent.ts` が写す)。
 *
 * Lv が配列より大きい場合(定義を縮めた content で古いセーブを読んだ等)は
 * **最後の段の値**を使う。undefined を返して「上限なし」に倒すと、content を
 * 縮めた瞬間に静かに無制限へ緩む — 定義の欠落を緩和方向へ解釈しない。
 */
export function facilityWorkerSlots(def: FacilityDef, level: number): number | undefined {
  const slots = def.workerSlotsByLevel;
  if (slots === undefined) return undefined;
  if (slots.length === 0) return 0;
  return slots[level - 1] ?? slots[slots.length - 1];
}

/**
 * その施設が到達できる最大 Lv。Lv 別の配列を持つ定義フィールドの**最短**で決まる
 * (産出だけ Lv5 まであって容量が Lv3 までなら、Lv4 は「定義に無い値を読む」
 * 状態になり rules が RulesError を投げるため、そこを上限にする)。
 */
export function facilityMaxLevel(def: FacilityDef): number {
  let max = def.outputPerTickByLevel.length;
  const storage = def.storage;
  if (storage !== undefined && storage.capacityByLevel.length < max) {
    max = storage.capacityByLevel.length;
  }
  const beds = def.bedCapacityByLevel;
  if (beds !== undefined && beds.length < max) max = beds.length;
  const slots = def.workerSlotsByLevel;
  if (slots !== undefined && slots.length < max) max = slots.length;
  return max;
}

/** ID 昇順を保ったまま就労者を足す(state.ts の `workerIds` の不変条件)。 */
function withWorkerAdded(
  workerIds: readonly EntityId[],
  residentId: EntityId,
): readonly EntityId[] {
  const next: EntityId[] = [];
  let inserted = false;
  for (const id of workerIds) {
    if (id === residentId) return workerIds;
    if (!inserted && compareUtf16(residentId, id) < 0) {
      next.push(residentId);
      inserted = true;
    }
    next.push(id);
  }
  if (!inserted) next.push(residentId);
  return next;
}

/** 就労者を外す(居なければ元の配列をそのまま返す)。 */
function withWorkerRemoved(
  workerIds: readonly EntityId[],
  residentId: EntityId,
): readonly EntityId[] {
  let found = false;
  const next: EntityId[] = [];
  for (const id of workerIds) {
    if (id === residentId) {
      found = true;
      continue;
    }
    next.push(id);
  }
  return found ? next : workerIds;
}

/**
 * その住民を**全施設の** workerIds から外す。
 *
 * `resident.assignedFacilityId` だけを見て外さないのは、片側だけ壊れたセーブ
 * (assignedFacilityId は null なのに workerIds には残っている等)を静かに
 * 通さないためである。走査は施設 entity の ID 昇順(正準順)。
 */
function detachWorkerFromAllFacilities(state: GameState, residentId: EntityId): GameState {
  let next = state;
  for (const facility of entitiesOfKind(state, "facility")) {
    const workerIds = withWorkerRemoved(facility.workerIds, residentId);
    if (workerIds === facility.workerIds) continue;
    next = updateEntity(next, facility.id, "facility", (f) => setField(f, "workerIds", workerIds));
  }
  return next;
}

/** その住民がどこかの施設の workerIds に載っているか。 */
function isListedAsWorker(state: GameState, residentId: EntityId): boolean {
  for (const facility of entitiesOfKind(state, "facility")) {
    for (const id of facility.workerIds) {
      if (id === residentId) return true;
    }
  }
  return false;
}

// --- 4. 個別コマンドの適用 -------------------------------------------------

function applyPlaceFacility(
  state: GameState,
  content: EngineContent,
  command: PlaceFacilityCommand,
  index: number,
): CommandResult {
  const def = content.facilityDefs.get(command.defId);
  if (def === undefined) {
    return rejected("placeFacility", index, {
      code: "unknownContentDef",
      subjectId: command.defId,
      message: `facility 定義 "${command.defId}" が content に無い`,
    });
  }
  if (facilityMaxLevel(def) < 1) {
    // Lv1 の定義が無い施設を建てると、生産式が「定義に無い Lv」を読んで
    // RulesError で落ちる。建てる前に止める(壊れた content を state へ入れない)。
    return rejected("placeFacility", index, {
      code: "unknownContentDef",
      subjectId: command.defId,
      limit: 0,
      actual: 1,
      message: `facility 定義 "${command.defId}" は Lv1 の値を持たない(Lv 別配列が空)`,
    });
  }
  if (
    !Number.isSafeInteger(command.cellIndex) ||
    command.cellIndex < 0 ||
    command.cellIndex >= GRID_CELL_COUNT
  ) {
    return rejected("placeFacility", index, {
      code: "cellOutOfRange",
      cellIndex: command.cellIndex,
      limit: GRID_CELL_COUNT - 1,
      message: `セル番号 ${String(command.cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})の外`,
    });
  }
  if (state.entityStateById.has(command.facilityId)) {
    return rejected("placeFacility", index, {
      code: "entityIdInUse",
      subjectId: command.facilityId,
      message: `entity ID "${command.facilityId}" は既に使われている`,
    });
  }
  const occupant = facilityAt(state, command.cellIndex);
  if (occupant !== undefined) {
    return rejected("placeFacility", index, {
      code: "cellOccupied",
      cellIndex: command.cellIndex,
      subjectId: occupant.id,
      message: `セル ${String(command.cellIndex)} には施設 "${occupant.id}" が建っている(1 セル = 1 施設・GDD 6.1)`,
    });
  }

  const next = putEntity(state, {
    kind: "facility",
    id: command.facilityId,
    defId: command.defId,
    level: 1,
    cellIndex: command.cellIndex,
    workerIds: [],
  });
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

function applyDemolishFacility(
  state: GameState,
  command: DemolishFacilityCommand,
  index: number,
): CommandResult {
  const facility = facilityOf(state, command.facilityId);
  if (facility === undefined) {
    return rejected("demolishFacility", index, {
      code: "entityNotFound",
      subjectId: command.facilityId,
      message: `施設 "${command.facilityId}" が state に無い`,
    });
  }

  // 就労者の後始末を engine 側で完結させる(UI に掃除させない = ぶら下がり参照を
  // 作らせない)。走査は住民 entity の ID 昇順(正準順)。
  let next = state;
  for (const resident of entitiesOfKind(state, "resident")) {
    if (resident.assignedFacilityId !== command.facilityId) continue;
    next = updateEntity(next, resident.id, "resident", (r) =>
      setField(r, "assignedFacilityId", null),
    );
  }
  next = removeEntity(next, command.facilityId);
  return { ok: true, state: next, changed: true, commandCount: 1 };
}

function applyUpgradeFacility(
  state: GameState,
  content: EngineContent,
  command: UpgradeFacilityCommand,
  index: number,
): CommandResult {
  const facility = facilityOf(state, command.facilityId);
  if (facility === undefined) {
    return rejected("upgradeFacility", index, {
      code: "entityNotFound",
      subjectId: command.facilityId,
      message: `施設 "${command.facilityId}" が state に無い`,
    });
  }
  const def = content.facilityDefs.get(facility.defId);
  if (def === undefined) {
    return rejected("upgradeFacility", index, {
      code: "unknownContentDef",
      subjectId: facility.defId,
      message: `facility 定義 "${facility.defId}" が content に無い`,
    });
  }
  const maxLevel = facilityMaxLevel(def);
  if (facility.level >= maxLevel) {
    return rejected("upgradeFacility", index, {
      code: "levelAtMax",
      subjectId: facility.id,
      limit: maxLevel,
      actual: facility.level,
      message: `施設 "${facility.id}" は既に Lv${String(facility.level)}(上限 Lv${String(maxLevel)})`,
    });
  }

  const next = updateEntity(state, facility.id, "facility", (f) =>
    setField(f, "level", f.level + 1),
  );
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

function applyAssignResident(
  state: GameState,
  content: EngineContent,
  command: AssignResidentCommand,
  index: number,
): CommandResult {
  const resident = residentOf(state, command.residentId);
  if (resident === undefined) {
    return rejected("assignResident", index, {
      code: "entityNotFound",
      subjectId: command.residentId,
      message: `住民 "${command.residentId}" が state に無い`,
    });
  }
  const facility = facilityOf(state, command.facilityId);
  if (facility === undefined) {
    return rejected("assignResident", index, {
      code: "entityNotFound",
      subjectId: command.facilityId,
      message: `施設 "${command.facilityId}" が state に無い`,
    });
  }
  if (!isAliveResident(resident)) {
    return rejected("assignResident", index, {
      code: "residentUnavailable",
      subjectId: resident.id,
      message: `住民 "${resident.id}" は死亡している(GDD 7.5 の tombstone)`,
    });
  }
  if (resident.dispatched) {
    return rejected("assignResident", index, {
      code: "residentUnavailable",
      subjectId: resident.id,
      message: `住民 "${resident.id}" は探索派遣中で本拠の就労スロットから外れている(GDD 8.1)`,
    });
  }
  if (resident.assignedFacilityId === facility.id) {
    return rejected("assignResident", index, {
      code: "alreadyAssigned",
      subjectId: resident.id,
      message: `住民 "${resident.id}" は既に施設 "${facility.id}" に就労している`,
    });
  }

  const def = content.facilityDefs.get(facility.defId);
  if (def === undefined) {
    return rejected("assignResident", index, {
      code: "unknownContentDef",
      subjectId: facility.defId,
      message: `facility 定義 "${facility.defId}" が content に無い`,
    });
  }
  const slots = facilityWorkerSlots(def, facility.level);
  if (slots !== undefined && facility.workerIds.length >= slots) {
    return rejected("assignResident", index, {
      code: "facilitySlotsFull",
      subjectId: facility.id,
      limit: slots,
      actual: facility.workerIds.length,
      message:
        `施設 "${facility.id}" の Lv${String(facility.level)} 就労スロットは ${String(slots)} 人まで` +
        `(現在 ${String(facility.workerIds.length)} 人・GDD 7.7)`,
    });
  }

  // 旧配属から外す → 新配属へ入れる → 住民側の参照を更新、の 3 段を 1 コマンドで。
  let next = detachWorkerFromAllFacilities(state, resident.id);
  next = updateEntity(next, facility.id, "facility", (f) =>
    setField(f, "workerIds", withWorkerAdded(f.workerIds, resident.id)),
  );
  next = updateEntity(next, resident.id, "resident", (r) =>
    setField(r, "assignedFacilityId", facility.id),
  );
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

function applyUnassignResident(
  state: GameState,
  command: UnassignResidentCommand,
  index: number,
): CommandResult {
  const resident = residentOf(state, command.residentId);
  if (resident === undefined) {
    return rejected("unassignResident", index, {
      code: "entityNotFound",
      subjectId: command.residentId,
      message: `住民 "${command.residentId}" が state に無い`,
    });
  }
  if (resident.assignedFacilityId === null && !isListedAsWorker(state, resident.id)) {
    return rejected("unassignResident", index, {
      code: "notAssigned",
      subjectId: resident.id,
      message: `住民 "${resident.id}" はどの施設にも就労していない`,
    });
  }

  let next = detachWorkerFromAllFacilities(state, resident.id);
  next = updateEntity(next, resident.id, "resident", (r) =>
    setField(r, "assignedFacilityId", null),
  );
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

/**
 * 成文化の資源コストが払えるかを**先に**確かめる(§3: rules 側の
 * `spendResources` は在庫不足で RulesError を投げるので、そこへ持ち込まない)。
 * 払えないときは不足している資源 1 件を reject に載せる。
 */
function checkCodifyAffordable(
  state: GameState,
  content: EngineContent,
  command: BeginCodificationCommand,
  index: number,
): CommandRejected | null {
  const plan = planCodification(
    content,
    command.techId,
    command.medium,
    isPrintingUnlocked(state, content),
  );
  const substitution = codifyWasteSubstitution(state, content, plan);
  const wasteResourceId = content.storage?.wasteResourceId ?? null;

  const costs = new Map<EntityId, number>();
  const remaining = toRaw(substitution.remainingCostFix);
  if (remaining > 0) costs.set(plan.costResourceId, remaining);
  const wasteSpent = toRaw(substitution.wasteSpentFix);
  if (wasteSpent > 0 && wasteResourceId !== null) {
    costs.set(wasteResourceId, (costs.get(wasteResourceId) ?? 0) + wasteSpent);
  }

  const stockByResourceId = new Map<EntityId, number>();
  for (const resource of entitiesOfKind(state, "resource")) {
    stockByResourceId.set(resource.resourceId, toRaw(resource.stock));
  }
  for (const [resourceId, required] of costs) {
    const available = stockByResourceId.get(resourceId);
    if (available === undefined) {
      return rejected("beginCodification", index, {
        code: "insufficientResource",
        resourceId,
        requiredRaw: required,
        availableRaw: 0,
        message: `資源 "${resourceId}" の在庫が state に無い(成文化コストの受け皿が不在)`,
      });
    }
    if (available < required) {
      return rejected("beginCodification", index, {
        code: "insufficientResource",
        resourceId,
        requiredRaw: required,
        availableRaw: available,
        message: `資源 "${resourceId}" が不足(必要 ${String(required)} / 在庫 ${String(available)})`,
      });
    }
  }
  return null;
}

function applyBeginCodification(
  state: GameState,
  content: EngineContent,
  command: BeginCodificationCommand,
  index: number,
): CommandResult {
  if (content.recordMedia === undefined) {
    return rejected("beginCodification", index, {
      code: "contentUnsupported",
      message:
        "content に balance の recordMedia ブロックが無いので成文化できない(GDD 11.1 [2026-07-27追補])",
    });
  }
  if (content.techDefs.get(command.techId) === undefined) {
    return rejected("beginCodification", index, {
      code: "unknownContentDef",
      subjectId: command.techId,
      message: `tech 定義 "${command.techId}" が content に無い`,
    });
  }
  if (state.entityStateById.has(command.codifyId)) {
    return rejected("beginCodification", index, {
      code: "entityIdInUse",
      subjectId: command.codifyId,
      message: `entity ID "${command.codifyId}" は既に使われている`,
    });
  }
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.techId === command.techId && codify.medium === command.medium) {
      return rejected("beginCodification", index, {
        code: "duplicateRecord",
        subjectId: codify.id,
        message:
          `tech "${command.techId}" の媒体 "${command.medium}" の記録は既にある(entity "${codify.id}")。` +
          `媒体別の並存は可だが同一媒体の重複は作らない(GDD 11.1 追補)`,
      });
    }
  }
  const unaffordable = checkCodifyAffordable(state, content, command, index);
  if (unaffordable !== null) return unaffordable;

  const next = beginCodificationRule(state, content, {
    codifyId: command.codifyId,
    techId: command.techId,
    medium: command.medium,
  });
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

function applyConvertWasteToResearch(
  state: GameState,
  content: EngineContent,
  command: ConvertWasteToResearchCommand,
  index: number,
): CommandResult {
  const storage = content.storage;
  if (storage === undefined || storage.wasteResourceId === null) {
    return rejected("convertWasteToResearch", index, {
      code: "contentUnsupported",
      message: "content に storage.wasteResourceId が無い(廃材が定義されていない・GDD 6.7)",
    });
  }
  const amount = toRaw(command.wasteAmountFix);
  if (amount <= 0) {
    return rejected("convertWasteToResearch", index, {
      code: "invalidArgument",
      requiredRaw: amount,
      message: `投入する廃材の量 ${String(amount)} が 0 以下`,
    });
  }
  const research = currentResearch(state);
  if (research === undefined) {
    return rejected("convertWasteToResearch", index, {
      code: "noResearchTarget",
      message: "未完了の研究が無い(廃材を消費してから捨てることになるので変換しない)",
    });
  }
  const available = toRaw(wasteStockOf(state, content));
  if (available < amount) {
    return rejected("convertWasteToResearch", index, {
      code: "insufficientResource",
      resourceId: storage.wasteResourceId,
      requiredRaw: amount,
      availableRaw: available,
      message: `廃材が不足(必要 ${String(amount)} / 在庫 ${String(available)})`,
    });
  }
  const gain = toRaw(
    wasteToResearchPoints(command.wasteAmountFix, storage.wasteToResearchRatioFix),
  );
  if (gain === 0) {
    return rejected("convertWasteToResearch", index, {
      code: "invalidArgument",
      resourceId: storage.wasteResourceId,
      requiredRaw: amount,
      message:
        `廃材 ${String(amount)} は変換率に対して小さすぎて研究点が 0 になる` +
        `(黙って廃材だけ消さないため拒否・GDD 6.7 3出口(3))`,
    });
  }

  const next = convertWasteToResearchPoints(state, content, command.wasteAmountFix);
  return { ok: true, state: next, changed: next !== state, commandCount: 1 };
}

function rejectReserved(kind: CommandKind, index: number): CommandRejected {
  const ownerTask = RESERVED_COMMAND_OWNER_TASK[kind] ?? "未定";
  return rejected(kind, index, {
    code: "notImplemented",
    ownerTask,
    message: `コマンド "${kind}" は語彙のみ予約されており実装が無い(担当: ${ownerTask})`,
  });
}

// --- 5. 分岐木ノード上界(ADR-012(3))--------------------------------------
//
//   ADR-012(3): 「各派遣の resolvedTree は撤退枝が以降ノードを打ち切る性質 +
//   choices が各ノード最大2分岐ゆえ、総ノード ≤2×maxNodes(8)=16/派遣、
//   同時派遣 ≤2 で ≤32 ノード」。
//
//   **正本をここに置く理由**: 上界を実際に満たすのは「派遣確定コマンドが何本の
//   木を何ノード作るか」という engine 側の生成規則であって、セーブ層はそれを
//   検算しているだけである(`platform/persistence.ts` の
//   `assertDispatchTreeBounds` は本ファイルの定数を再輸出して使う)。
//   定数が 2 箇所にあると、片方だけ直したときに「セーブは通るが生成が上界を
//   破る」/「生成は正しいのにセーブが弾く」という食い違いが起きる。
//
//   **マジックナンバーでなく積の形**で書くのは ADR の「拡張時は再算定」に
//   対応するため。派遣枠やイベントノード数が動いたら下の 3 つの素の定数だけを
//   直せば、派生する 2 つの上界が自動で追随する。

/** 1 派遣で生成されるイベントノードの最大数(GDD 8.2: イベント列 3〜8 ノード)。 */
export const DISPATCH_EVENT_NODES_MAX = 8;

/** choices の分岐数(撤退 / 強行の 2 分岐・GDD 8.3)。 */
export const DISPATCH_BRANCH_FACTOR = 2;

/** 同時派遣枠(GDD 8.1「派遣枠上限＝同時2枠」)。 */
export const CONCURRENT_DISPATCH_MAX = 2;

/** 1 派遣の resolvedTree の総ノード上界 = 2 × 8 = 16。 */
export const DISPATCH_TREE_NODES_MAX = DISPATCH_BRANCH_FACTOR * DISPATCH_EVENT_NODES_MAX;

/** セーブ 1 本が持ちうる分岐木ノードの総数上界 = 16 × 2 = 32。 */
export const DISPATCH_TREE_NODES_TOTAL_MAX = DISPATCH_TREE_NODES_MAX * CONCURRENT_DISPATCH_MAX;

/**
 * いま state に載っている派遣の本数。
 *
 * 探索の state 表現(`dispatchSnapshots`)は M21 の担当でまだ存在しないため、
 * **現時点では常に 0** である。0 を返すこと自体は嘘ではない(派遣は 1 件も
 * 存在し得ない)が、M21 が state を足したらここを実データに差し替えること。
 * 上界検査({@link dispatchSlotsAvailable})を先に用意してあるのは、派遣確定
 * コマンドの実装者が上界の存在に気づかず通り過ぎるのを防ぐため。
 */
export function activeDispatchCount(state: GameState): number {
  // 「探索派遣中の住民が居るか」は数えられるが、それは**派遣の本数ではない**
  // (1 派遣 = 1〜4 名・GDD 8.1)ので枠判定には使えない。派遣そのものを表す
  // state(`dispatchSnapshots`)が無い現状、0 を返す以外に正しい実装が無い。
  // 引数に state を取ってあるのは M21 の差し替え点を型で固定するためである。
  void state;
  return 0;
}

/** 派遣枠(GDD 8.1 の同時 2 枠)に空きがあるか。 */
export function dispatchSlotsAvailable(state: GameState): boolean {
  return activeDispatchCount(state) < CONCURRENT_DISPATCH_MAX;
}

// --- 6. 単一入口(§0) -----------------------------------------------------

function applyOne(
  state: GameState,
  content: EngineContent,
  command: Command,
  index: number,
): CommandResult {
  switch (command.kind) {
    case "placeFacility":
      return applyPlaceFacility(state, content, command, index);
    case "demolishFacility":
      return applyDemolishFacility(state, command, index);
    case "upgradeFacility":
      return applyUpgradeFacility(state, content, command, index);
    case "assignResident":
      return applyAssignResident(state, content, command, index);
    case "unassignResident":
      return applyUnassignResident(state, command, index);
    case "beginCodification":
      return applyBeginCodification(state, content, command, index);
    case "convertWasteToResearch":
      return applyConvertWasteToResearch(state, content, command, index);
    case "beginResearch":
    case "dispatchExpedition":
    case "reclaimCell":
      return rejectReserved(command.kind, index);
    default: {
      const unhandled: never = command;
      throw new CommandError(`未知のコマンド ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * 入力を列へ正規化する。単体を渡す形を許しているのは呼び出し側の見た目のためで
 * あり、内部の適用経路は 1 本(列)だけにしてある。
 */
function toCommandList(input: CommandInput): readonly Command[] {
  if (Array.isArray(input)) return input as readonly Command[];
  return [input as Command];
}

/**
 * プレイヤー操作を state へ適用する**唯一の入口**(§0)。
 *
 * - 純関数。`state` は変更されず、成功時は構造共有された新しい state が返る。
 * - 列を渡した場合は先頭から順に適用し、**1 つでも reject したら全体を捨てる**
 *   (部分適用しない)。`rejection.commandIndex` が何番目で落ちたかを示す。
 * - 空の列は `invalidArgument`(「何もしないコマンド」を成功にしない)。
 *
 * @example
 *   const result = apply(state, content, { kind: "placeFacility", … });
 *   if (!result.ok) showMessage(result.rejection.code);
 *   else store.install(result.state);
 *
 * @throws {CommandError} 語彙外のコマンドを渡した場合
 * @throws {RulesError} 事前検査を通ったのに rules が契約違反を検出した場合(§3)
 */
export function apply(
  state: GameState,
  content: EngineContent,
  input: CommandInput,
): CommandResult {
  const commands = toCommandList(input);
  if (commands.length === 0) {
    return rejected(null, 0, {
      code: "invalidArgument",
      message: "空のコマンド列は適用できない(何もしない操作を成功にしない)",
    });
  }

  let next = state;
  let changed = false;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (command === undefined) {
      throw new CommandError(`コマンド列の ${String(i)} 番目が undefined`);
    }
    const result = applyOne(next, content, command, i);
    if (!result.ok) return result;
    next = result.state;
    changed = changed || result.changed;
  }
  return { ok: true, state: next, changed, commandCount: commands.length };
}
