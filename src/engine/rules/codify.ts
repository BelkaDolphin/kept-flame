// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 成文化キューと記録媒体2種 — GDD 6.2 / 10.2 / 11.1 [2026-07-27追補]
//
// ===========================================================================
// 1. 位置づけ: 成文化は「(B) レート変化イベント」のもう一方の柱
// ===========================================================================
//   GDD 11.8(B) は「レート変化イベント(研究完了 / **成文化完了** / era 昇格)」と
//   書いており、成文化完了は研究完了と同じ形の離散事象である。よって本モジュールは
//   {@link ../rules/research.ts research.ts} と**意図的に同じ形**にしてある:
//
//     currentCodification        ↔ currentResearch          (キューの先頭 1 件)
//     codifyRemaining            ↔ researchRemaining
//     ticksUntilCodifyComplete   ↔ ticksUntilResearchComplete((B) 完了 tick 予測)
//     applyCodifyProgress        ↔ applyResearchProgress    ((A) 区間の一括加算)
//     completeCodification       ↔ completeResearch         ((B) 境界の状態遷移)
//
//   **M6 では tick ループへ結線しない。** scheduler / advance を触ると
//   「レートを変える全状態変化が heap のイベントとして境界化されている」という
//   中心不変条件(scheduler.ts §1)の再検証が要り、既存 golden vector 37 本の
//   リスクも負う。M6 は「成文化が動く形」までを純関数で用意し、結線は住民/コマンド
//   系(M13 以降)の担当とする。予測関数を research と同型にしてあるのは、
//   結線側が新しい概念を持ち込まずに済むようにするため。
//
// ===========================================================================
// 2. 媒体は engine 既知の 2 種固定(GDD 11.1 追補)
// ===========================================================================
//   記録媒体は content カテゴリではなく enum({@link RECORD_MEDIA})である。
//   数値パラメータだけが `balance.json` の `recordMedia` ブロックから来る。
//   コストと所要時間は
//
//     コスト   = baseCost × 時代係数(era_multiplier) × 媒体 costMul × 印刷補正
//     所要 tick = ceil(baseDurationTicks × 媒体 timeMul × 印刷補正)
//
//   で決まる。**印刷補正(GDD 5.2「E3印刷でコスト -50%・速度 ×2」)は紙のみ**
//   (GDD 11.1 追補で正本化)。「時代係数」は GDD 5.1 の era_multiplier
//   (E1=1 / E2=2 / E3=4)を用いる — GDD 11.1 は「粘土 × 時代係数」としか
//   書いておらず係数の実体を指定していないため、同じ表にある唯一のエラ係数を
//   採用した(要ユーザー判断として M6 報告に記載)。**エラ不明の tech では 1.0**。
//
// ===========================================================================
// 3. 「成文化済み」= 記録が 1 件以上存在すること
// ===========================================================================
//   同一 tech に媒体別の記録を**並存できる**(紙で速攻 → 後に石板へ写す副本動線)。
//   よって一意なのは (techId, medium) の組であり、`isCodified` は tech 単位で
//   「完了済み記録が 1 件以上あるか」を見る(GDD 11.1 追補)。
//
//   焼失(可燃記録の消滅)は event 効果プリミティブ `destroyRecords{medium,scope}`
//   として **M22 が実装する**。本モジュールは「どの記録が可燃か」を
//   {@link flammableRecords} で機械可読に出すところまでを担当し、破壊操作は持たない。
//
// ===========================================================================
// 4. 決定論上の注意
// ===========================================================================
//   (a) 走査は必ず entity ID 昇順(`entitiesOfKind` の正準順・GDD 11.7)。
//   (b) 所要作業量は**着手時にスナップショット**する(state.ts の
//       `CodifyState.requiredWork`)。作業中に印刷が解禁されても進行中ジョブの
//       所要量は動かない = 区間を分割しても結果が変わらない(GDD 12.5-8)。
//   (c) 非整数べき乗は使わない。ここに出る乗算は全て 1 回きりの mulFix。
// ---------------------------------------------------------------------------

import {
  FIX_ONE,
  FIX_SCALE,
  FIX_ZERO,
  addFix,
  fixFromInt,
  floorDivInt,
  mulFix,
  mulFixInt,
  subFix,
  toRaw,
  type Fix,
} from "../fp";
import {
  entitiesOfKind,
  requireEntity,
  type CodifyState,
  type EntityId,
  type GameState,
} from "../state/state";
import { putEntity, setField, updateEntity } from "../state/update";
import { spendResources, substituteCostWithWaste, wasteStockOf } from "./storage";
import {
  RECORD_MEDIA,
  RulesError,
  eraDefOfTech,
  requireTechDef,
  type EngineContent,
  type RecordMediaParams,
  type RecordMedium,
} from "./types";

// --- 1. パラメータの取得 ---------------------------------------------------

/**
 * `recordMedia` ブロックを引く。無ければ成文化は一切できない(§2)。
 *
 * @throws {RulesError} content に `recordMedia` が無い場合
 */
export function requireRecordMedia(content: EngineContent): RecordMediaParams {
  const params = content.recordMedia;
  if (params === undefined) {
    throw new RulesError(
      "成文化には balance の recordMedia ブロックが必要(GDD 11.1 [2026-07-27追補])",
    );
  }
  return params;
}

/**
 * E3「簡易印刷」が解禁済みか。`recordMedia.printingTechId` の research entity が
 * 完了していれば true。printingTechId が無い content では常に false。
 *
 * 走査は research entity の ID 昇順(正準順)。同じ tech を指す research entity が
 * 複数あっても「1 件でも完了していれば解禁」で解釈は一意。
 */
export function isPrintingUnlocked(state: GameState, content: EngineContent): boolean {
  const printingTechId = content.recordMedia?.printingTechId;
  if (printingTechId === undefined || printingTechId === null) return false;
  for (const research of entitiesOfKind(state, "research")) {
    if (research.techId === printingTechId && research.completedTick !== null) return true;
  }
  return false;
}

// --- 2. コストと所要時間(§2) ---------------------------------------------

/** 1 枚の記録を作るための確定値。`planCodification` が返す。 */
export interface CodifyPlan {
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  /** コストを支払う資源の定義 ID(石板 = 粘土 / 紙 = 紙)。 */
  readonly costResourceId: EntityId;
  /** 支払うコスト(時代係数・媒体倍率・印刷補正の適用後)。 */
  readonly costFix: Fix;
  /** 所要作業量 = 学者 1 人が働いたときの tick 数(1 tick = 1.0)。 */
  readonly durationTicks: number;
  /** 印刷バフが実際に適用されたか(紙 かつ 解禁済み のときだけ true)。 */
  readonly printingApplied: boolean;
  /** この媒体が可燃か(GDD 11.1 追補・焼失は M22)。 */
  readonly flammable: boolean;
  /** 大移動キャラバンの石版換算枠の消費量(GDD 10.2 追補)。 */
  readonly caravanWeightFix: Fix;
}

/**
 * 記録 1 枚のコスト/所要時間を確定する(§2)。
 *
 * `printingUnlocked` を引数で受けるのは、state を持たない呼び出し側(UI の見積り
 * 表示・sim の所要 tick 評価)からも使えるようにするため。state から求めるなら
 * {@link isPrintingUnlocked} を通すこと。
 *
 * 値域: baseCost / 時代係数 / 媒体倍率はいずれも schema でレンジ制約済みだが、
 * 積の上界を構造的に証明できないので **mulFix(自動 BigInt フォールバック)**を
 * 使う(fp.ts §4 の線引き: 「係数×係数」でも content 由来の上限が緩い経路は
 * 証明済み扱いにしない)。
 *
 * @throws {RulesError} content に `recordMedia` が無い / tech 定義が無い場合
 */
export function planCodification(
  content: EngineContent,
  techId: EntityId,
  medium: RecordMedium,
  printingUnlocked: boolean,
): CodifyPlan {
  const params = requireRecordMedia(content);
  // tech 定義の存在をここで必ず確かめる(存在しない tech の記録は作らせない)。
  requireTechDef(content, techId);
  const mediumParams = params.byMedium[medium];
  const eraMultiplierFix = eraDefOfTech(content, techId)?.multiplierFix ?? FIX_ONE;
  const printingApplied = printingUnlocked && medium === "paper";

  let costFix = mulFix(params.baseCostFix, eraMultiplierFix);
  costFix = mulFix(costFix, mediumParams.costMulFix);
  if (printingApplied) costFix = mulFix(costFix, params.printingCostMulFix);

  let durationFix = mulFix(fixFromInt(params.baseDurationTicks), mediumParams.timeMulFix);
  if (printingApplied) durationFix = mulFix(durationFix, params.printingTimeMulFix);

  return {
    techId,
    medium,
    costResourceId: mediumParams.costResourceId,
    costFix,
    durationTicks: ceilTicks(durationFix),
    printingApplied,
    flammable: mediumParams.flammable,
    caravanWeightFix: mediumParams.caravanWeightFix,
  };
}

/**
 * Fix の tick 数を切り上げて整数 tick にする。所要時間を切り**上げ**るのは、
 * 切り捨てると `timeMul` が極小の content で 0 tick(= 即完了)になり
 * 「作業」という概念が消えるため。最低 1 tick を保証する。
 */
function ceilTicks(durationFix: Fix): number {
  const raw = toRaw(durationFix);
  if (raw <= 0) return 1;
  // ceil(raw / FIX_SCALE) を -floor(-raw / FIX_SCALE) で(fp.ts の規約)。
  const ticks = -floorDivInt(-raw, FIX_SCALE);
  return ticks < 1 ? 1 : ticks;
}

/**
 * 石板のコストを廃材で一部代替する(GDD 6.7 の 3 出口(2) / 11.1 追補
 * 「粘土コストの廃材代替は**石板のみ**に適用」)。
 *
 * 紙では代替しない(代替上限 0 と同じ結果を返す)。`storage` ブロックが無い
 * content でも代替 0 を返すだけで例外にしない(成文化そのものは可能)。
 */
export function codifyWasteSubstitution(
  state: GameState,
  content: EngineContent,
  plan: CodifyPlan,
): { readonly wasteSpentFix: Fix; readonly remainingCostFix: Fix } {
  const storage = content.storage;
  if (plan.medium !== "stoneTablet" || storage === undefined || storage.wasteResourceId === null) {
    return { wasteSpentFix: FIX_ZERO, remainingCostFix: plan.costFix };
  }
  return substituteCostWithWaste(
    plan.costFix,
    wasteStockOf(state, content),
    storage.codifyWasteSubstitutionMaxFix,
  );
}

// --- 3. キューと記録の参照(§3) -------------------------------------------

/**
 * 成文化キューの先頭 = 未完了の codify entity のうち ID 昇順で最初の 1 件
 * (research.ts §2 の単一キューと同じ縮約)。全て完了済みなら undefined。
 */
export function currentCodification(state: GameState): CodifyState | undefined {
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.completedTick === null) return codify;
  }
  return undefined;
}

/** 未完了の成文化ジョブ(ID 昇順)。 */
export function codificationQueue(state: GameState): readonly CodifyState[] {
  return entitiesOfKind(state, "codify").filter((c) => c.completedTick === null);
}

/** 完成済みの記録(ID 昇順)。 */
export function completedRecords(state: GameState): readonly CodifyState[] {
  return entitiesOfKind(state, "codify").filter((c) => c.completedTick !== null);
}

/**
 * その tech が成文化済みか = 完了済みの記録が 1 件以上あるか(§3)。
 * 媒体は問わない(紙 1 枚でも成文化済み)。
 */
export function isCodified(state: GameState, techId: EntityId): boolean {
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.techId === techId && codify.completedTick !== null) return true;
  }
  return false;
}

/**
 * その tech の完了済み記録の媒体一覧({@link RECORD_MEDIA} の宣言順・重複なし)。
 * 「紙と石板の両方を持っている」= 副本ができている状態を機械可読に出す。
 */
export function recordMediaOfTech(state: GameState, techId: EntityId): readonly RecordMedium[] {
  const present = new Set<RecordMedium>();
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.techId === techId && codify.completedTick !== null) present.add(codify.medium);
  }
  const result: RecordMedium[] = [];
  for (const medium of RECORD_MEDIA) {
    if (present.has(medium)) result.push(medium);
  }
  return result;
}

/**
 * 可燃な完了済み記録(ID 昇順)。M22 の `destroyRecords{medium, scope}` が
 * 対象を選ぶときの母集合であり、本モジュールは**破壊しない**(§3)。
 */
export function flammableRecords(state: GameState, content: EngineContent): readonly CodifyState[] {
  const params = content.recordMedia;
  if (params === undefined) return [];
  return completedRecords(state).filter((c) => params.byMedium[c.medium].flammable);
}

/**
 * 大移動キャラバンの石版換算枠の消費量(GDD 10.2 [2026-07-27追補] 媒体別重み)。
 * 完了済み記録のみを数える(作業中のジョブは持ち出せない)。
 * 総和は ID 昇順(正準順)。
 */
export function caravanWeightOfRecords(state: GameState, content: EngineContent): Fix {
  const params = content.recordMedia;
  if (params === undefined) return FIX_ZERO;
  let total = FIX_ZERO;
  for (const record of completedRecords(state)) {
    total = addFix(total, params.byMedium[record.medium].caravanWeightFix);
  }
  return total;
}

/**
 * おまかせ成文化ヒューリスティックの媒体選択(GDD 11.1 追補「アシスト整合」):
 * **唯一保持 tech は石板、それ以外は紙**。80% 基準(GDD 2.1)は不変で、
 * この関数は媒体だけを決める。
 */
export function assistPreferredMedium(uniqueHolder: boolean): RecordMedium {
  return uniqueHolder ? "stoneTablet" : "paper";
}

// --- 4. キュー操作((B) の 2 つの半分・§1) --------------------------------

/**
 * 成文化を開始する(コマンド適用形)。
 *
 * 1. (techId, medium) の重複を拒否する(完了済み・作業中どちらでも)。
 *    同一 tech の**別媒体**は並存できる(§3)。
 * 2. コストを支払う。石板は廃材で一部代替する(GDD 6.7 3出口(2))。
 * 3. 所要作業量をスナップショットして codify entity を作る(§4(b))。
 *
 * 廃材の 3 出口と同じく「コマンド実行時の純関数」であり、tick 流量ではない
 * (storage.ts §4 と同じ理由: 連続流にすると在庫枯渇の境界イベントが要る)。
 *
 * @throws {RulesError} recordMedia 未設定 / tech 定義が無い / codifyId が既存 entity と衝突
 *                      / 同じ (tech, medium) が既にある / 在庫不足(spendResources)
 */
export function beginCodification(
  state: GameState,
  content: EngineContent,
  args: {
    readonly codifyId: EntityId;
    readonly techId: EntityId;
    readonly medium: RecordMedium;
  },
): GameState {
  // putEntity は既存 ID を**黙って差し替える**(update.ts)。ID の付け間違いで
  // 別種 entity を消さないよう、新規作成であることをここで明示的に確かめる。
  if (state.entityStateById.has(args.codifyId)) {
    throw new RulesError(
      `beginCodification: entity ID "${args.codifyId}" は既に使われている(新規の記録には未使用の ID を渡すこと)`,
    );
  }
  for (const codify of entitiesOfKind(state, "codify")) {
    if (codify.techId === args.techId && codify.medium === args.medium) {
      throw new RulesError(
        `beginCodification: tech "${args.techId}" の媒体 "${args.medium}" の記録は既にある` +
          `(entity "${codify.id}")。媒体別の並存は可だが同一媒体の重複は作らない(GDD 11.1 追補)`,
      );
    }
  }

  const plan = planCodification(
    content,
    args.techId,
    args.medium,
    isPrintingUnlocked(state, content),
  );
  const substitution = codifyWasteSubstitution(state, content, plan);

  const costs = new Map<EntityId, Fix>();
  if (toRaw(substitution.remainingCostFix) > 0) {
    costs.set(plan.costResourceId, substitution.remainingCostFix);
  }
  if (toRaw(substitution.wasteSpentFix) > 0) {
    const wasteResourceId = content.storage?.wasteResourceId;
    if (wasteResourceId === undefined || wasteResourceId === null) {
      throw new RulesError("beginCodification: 廃材代替が発生したのに廃材資源が未定義(実装バグ)");
    }
    // 廃材で払う資源が本コスト資源と同一なら合算する(粘土 = 廃材という content は
    // 想定しないが、合算しないと後勝ちで静かに払い漏れるため防御的に足す)。
    costs.set(
      wasteResourceId,
      addFix(costs.get(wasteResourceId) ?? FIX_ZERO, substitution.wasteSpentFix),
    );
  }

  const paid = spendResources(state, costs);
  return putEntity(paid, {
    kind: "codify",
    id: args.codifyId,
    techId: args.techId,
    medium: args.medium,
    requiredWork: fixFromInt(plan.durationTicks),
    progress: FIX_ZERO,
    completedTick: null,
  });
}

/**
 * 完成まで残っている作業量。0 以下なら完了条件を満たしている
 * (research.ts の `researchRemaining` と同型)。
 */
export function codifyRemaining(codify: CodifyState): Fix {
  return subFix(codify.requiredWork, codify.progress);
}

/**
 * 完成までに要する tick 数。レートが 0 以下なら null(到達しない)。
 * 規約は `ticksUntilResearchComplete` と完全に同じ(残り 0 以下なら 0 = 現在 tick で
 * 完了・切り上げで過小評価しない)。**同じ規約にしてあることが、結線側が
 * 研究と成文化で別の場合分けを持たずに済む根拠**である。
 */
export function ticksUntilCodifyComplete(remainingFix: Fix, ratePerTickFix: Fix): number | null {
  const rate = toRaw(ratePerTickFix);
  if (rate <= 0) return null;
  const remaining = toRaw(remainingFix);
  if (remaining <= 0) return 0;
  return -floorDivInt(-remaining, rate);
}

/**
 * (A) 区間ぶんの成文化作業を一括加算する(区分求積)。
 * レートが 0 なら state をそのまま返す。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない場合
 */
export function applyCodifyProgress(
  state: GameState,
  codifyId: EntityId,
  ratePerTickFix: Fix,
  deltaTicks: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyCodifyProgress: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  if (toRaw(ratePerTickFix) === 0) return state;
  const gain = mulFixInt(ratePerTickFix, deltaTicks);
  return updateEntity(state, codifyId, "codify", (c) =>
    setField(c, "progress", addFix(c.progress, gain)),
  );
}

/**
 * 記録を完成させる((B) イベントの状態遷移)。進行度は減らさない
 * (切り上げ由来の余剰をそのまま残す = research.ts と同じ規約)。
 *
 * @throws {RulesError} 既に完成している / 作業量が所要に届いていない場合
 */
export function completeCodification(
  state: GameState,
  codifyId: EntityId,
  tick: number,
): GameState {
  const codify = requireEntity(state, codifyId, "codify");
  if (codify.completedTick !== null) {
    throw new RulesError(
      `completeCodification: codify "${codifyId}" は既に tick ${String(codify.completedTick)} で完成している`,
    );
  }
  if (toRaw(codifyRemaining(codify)) > 0) {
    throw new RulesError(
      `completeCodification: codify "${codifyId}" の作業量が所要に届いていない` +
        `((B) の完了 tick 予測と実際の進行が食い違っている)`,
    );
  }
  return updateEntity(state, codifyId, "codify", (c) => setField(c, "completedTick", tick));
}
