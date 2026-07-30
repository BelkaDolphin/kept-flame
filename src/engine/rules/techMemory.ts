// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 住民 × 技術の記憶 — GDD 11.2 / 7.4 / 4 / M13
//
// ===========================================================================
// 1. 何を本式にしたのか(T5 縮約 → M13 本式)
// ===========================================================================
//   T5(先行計測)の想起困難は 3 点を縮約していた(rules/recall.ts §3)。M13 は
//   そのうち **(b) 停止の粒度**を本式へ上げ、あわせて GDD 11.2 の
//   `masteryResist(u,t)` と GDD 7.4 の (B) 一回性喪失を実装する:
//
//     縮約(T5)                          本式(M13)
//     ------------------------------------------------------------------
//     住民あたり 1 スカラで全生産停止    (住民, tech) ごとに停止し、
//     (resident.recallImpairedUntilTick) **その tech の実地要件施設での寄与だけ**
//                                        が 0 になる(GDD 11.2「当該住民の当該
//                                        tech 関連生産のみ停止」)
//     mastery は住民あたり 1 スカラ      (住民, tech) ごとに実地稼働で蓄積する
//                                        (GDD 4「解禁 → 実地稼働で記憶定着」)
//     喪失は存在しない                   保持者ゼロ かつ 記録ゼロ で喪失
//                                        (A) は停滞のみ / (B) は永久(GDD 7.4)
//
//   「関連生産」の解決には content の `tech.fieldRequirement.facility`
//   (= {@link TechDef.fieldFacilityId})を使う。GDD 5 の実地要件の「該当施設」で
//   あり、GDD 4 の「実地稼働」の場所でもあるので、停止範囲と定着の蓄積は同じ
//   1 つの関係から導かれる(engine が新しい語彙を発明しない)。
//
//   **fieldFacilityId を持たない tech へのフォールバック**: 停止範囲が決まらない
//   ので**住民単位の全停止**(= T5 縮約と同じ挙動)にする。黙って「何も止まらない」
//   にすると、想起困難が生産へ一切効かない静かな弱化になるため。
//
// ===========================================================================
// 2. 縮約のまま残した 2 点(正直な開示)
// ===========================================================================
//   (a) **判定ペア** — GDD 11.2 の `recallRisk(住民u, tech t)` は「u が記憶して
//       いる未成文の tech」を走るのが本来だが、判定ペアは T5 のまま
//       「全生存住民 × 全 research entity の techId」である。理由は 2 つ:
//         ・ADR-014 の「20人×3tech×2,304step = 138,240 判定/run」という
//           計測 #3/#4 の入力を保つため(保持者だけに絞ると判定数が盤面依存で
//           激減し、性能校正の前提が変わる)
//         ・保持していない tech の想起困難は「その tech の関連生産が止まる」だけ
//           であり、上界としては安全側
//       本式化の対象は M13 の指示にある 3 点(tech 別停止・mastery・(B)喪失)で
//       あり、判定ペアの絞り込みは含まれない。
//   (c) **回復条件** — 「通常業務就労かつ士気 ≥40 を持続、または療養所で休養1日」も
//       T5 のまま(持続 d の満了のみで回復)。療養所・士気回復は未実装。
//
// ===========================================================================
// 3. 決定論(Map 反復順に依存しない)
// ===========================================================================
//   `GameState.techMemoryByKey` の反復順はキー昇順が不変条件(state.ts (f))だが、
//   本モジュールは**それに頼らず**必要な走査順を自分で決める:
//     ・住民の保持 tech を列挙するとき  → キー昇順(state 側の正準順)を使い、
//       さらに techId で明示ソートし直す({@link heldTechIdsOf})
//     ・保持者を列挙するとき            → `livingResidents`(ID 昇順)を走る
//     ・定着の蓄積レートを組むとき      → 施設 ID 昇順 × workerIds(ID 昇順)×
//       tech ID 昇順(`content.techDefs` はロード側が ID 昇順で作る)。返す配列は
//       最後にキー昇順へ明示ソートする({@link MasteryGains})
//   これで「どの Map をどう回ったか」が結果へ漏れない(GDD 11.7)。
//
// ===========================================================================
// 4. 分割不変性((A) 区間の閉形式・advance.ts §3)
// ===========================================================================
//   定着の蓄積は生産と同型の「レート × 区間長」であり、上限クランプは**上側のみ**
//   (レートが非負)なので min 合成則で分割不変になる:
//     min(min(a + rΔ1, C) + rΔ2, C) = min(a + r(Δ1+Δ2), C)   (r >= 0)
//   レートは per-tick の Fix として**先に 1 回だけ floor 除算**して作る
//   (`floor(perDay × Δ / 1440)` を区間ごとに計算すると分割で丸め差が出る)。
//
//   定着は**どのレートも変えない**(生産レートは mastery に依存しない。mastery が
//   効くのは (C) 抽選の確率だけで、それは粗粒度ステップ境界 = 必ず区間境界で
//   評価される)ので、新しい境界イベントを要さない。
// ---------------------------------------------------------------------------

import {
  FIX_ZERO,
  addFix,
  clampFix,
  fixFromRaw,
  floorDivInt,
  mulFixInt,
  toRaw,
  type Fix,
} from "../fp";
import { GAME_DAY_TICKS } from "../stochastic";
import {
  entitiesOfKind,
  getTechMemory,
  isAliveResident,
  livingResidents,
  requireEntity,
  techMemoryKeys,
  type EntityId,
  type GameState,
  type ResearchState,
  type ResidentState,
  type TechMemoryState,
} from "../state/state";
import { setField, setTechMemories, setTechMemory, updateEntity } from "../state/update";
import { compareUtf16 } from "../canonicalize";
import { isCodified } from "./codify";
import { RulesError, lossClassOfTech, type EngineContent, type TechDef } from "./types";

// --- 1. キーと参照 ----------------------------------------------------------

/**
 * (住民, 技術) の記憶キー({@link GameState.techMemoryByKey} の doc 参照)。
 *
 * bond の `bondPairKeyOf` と違い**順序付き**の対なので正規化(辞書順入れ替え)は
 * しない。ID 規則(ADR-011)に `|` が含まれないので分解も一意。
 */
export function techMemoryKeyOf(residentId: EntityId, techId: EntityId): string {
  return `${residentId}|${techId}`;
}

/** その (住民, 技術) の記憶(未形成なら undefined)。 */
export function techMemoryOf(
  state: GameState,
  residentId: EntityId,
  techId: EntityId,
): TechMemoryState | undefined {
  return getTechMemory(state, techMemoryKeyOf(residentId, techId));
}

/** その (住民, 技術) の定着度(未形成なら 0)。 */
export function techMasteryOf(state: GameState, residentId: EntityId, techId: EntityId): Fix {
  return techMemoryOf(state, residentId, techId)?.masteryFix ?? FIX_ZERO;
}

/**
 * その (住民, 技術) が想起困難中か(`tick < impairedUntilTick`)。
 * 回復は「比較のみ」で表現する(rules/recall.ts 末尾の分割不変性の理由と同じ)。
 */
export function isTechImpaired(
  state: GameState,
  residentId: EntityId,
  techId: EntityId,
  tick: number,
): boolean {
  const memory = techMemoryOf(state, residentId, techId);
  return memory !== undefined && tick < memory.impairedUntilTick;
}

/**
 * その住民が記憶を持っている技術 ID(**techId 昇順**・§3)。
 * 「持っている」= キーが生えている(定着 0 でも想起困難の記録があれば含む)。
 */
export function memoryTechIdsOf(state: GameState, residentId: EntityId): readonly EntityId[] {
  const prefix = `${residentId}|`;
  const result: EntityId[] = [];
  for (const key of techMemoryKeys(state)) {
    if (!key.startsWith(prefix)) continue;
    result.push(key.slice(prefix.length) as EntityId);
  }
  return result.sort(compareUtf16);
}

/**
 * その住民が**保持者である**技術 ID(定着 > 0・techId 昇順)。
 * GDD 7.4 の (B) 一回性喪失判定における「保持者」の定義であり、
 * GDD 4「解禁 → 実地稼働で記憶定着」の「記憶定着」が起きた tech だけが並ぶ。
 */
export function heldTechIdsOf(state: GameState, residentId: EntityId): readonly EntityId[] {
  return memoryTechIdsOf(state, residentId).filter(
    (techId) => toRaw(techMasteryOf(state, residentId, techId)) > 0,
  );
}

/**
 * その技術の**生存**保持者(住民 ID 昇順)。tombstone された死者は含まない
 * (state.ts の `livingResidents` と同じ「生存」の定義)。
 */
export function techHoldersOf(state: GameState, techId: EntityId): readonly EntityId[] {
  const result: EntityId[] = [];
  for (const resident of livingResidents(state)) {
    if (toRaw(techMasteryOf(state, resident.id, techId)) > 0) result.push(resident.id);
  }
  return result;
}

// --- 2. 「関連生産」の解決(GDD 11.2 / §1) --------------------------------

/**
 * その tech の想起困難が、この施設定義での寄与を止めるか。
 *
 *   fieldFacilityId が一致        → 止める(本式・GDD 11.2「当該tech関連生産」)
 *   fieldFacilityId が省略        → 止める(縮約フォールバック・§1)
 *   fieldFacilityId が別施設      → 止めない
 */
export function techImpairmentStopsFacility(tech: TechDef, facilityDefId: EntityId): boolean {
  return tech.fieldFacilityId === undefined || tech.fieldFacilityId === facilityDefId;
}

/**
 * その住民が、この施設定義での寄与を想起困難で止められているか(GDD 11.2)。
 *
 * `techMemoryByKey` が空(= 既存セーブ・既存 conformance シナリオ)なら
 * **content を 1 度も読まずに false** を返す。これが「本機構が既定で完全に
 * 不活性」であることの実装上の根拠。
 *
 * **計算量**: 記憶キー全件の走査 O(住民数 × tech数)。tick ループの内側で就労者
 * ごとに呼ぶと二乗になるので、そこでは {@link buildImpairmentIndex} で 1 パスに
 * まとめる(この関数は単体テスト・診断・低頻度の問い合わせ向け。両者が同じ
 * 結果を返すことはテストで固定してある)。
 */
export function isTechRelatedImpaired(
  state: GameState,
  content: EngineContent,
  residentId: EntityId,
  facilityDefId: EntityId,
  tick: number,
): boolean {
  if (state.techMemoryByKey.size === 0) return false;
  for (const techId of memoryTechIdsOf(state, residentId)) {
    if (!isTechImpaired(state, residentId, techId, tick)) continue;
    const tech = content.techDefs.get(techId);
    // content から消えた tech(周回・content 改訂)は縮約側へ倒す = 止める。
    if (tech === undefined || techImpairmentStopsFacility(tech, facilityDefId)) return true;
  }
  return false;
}

/**
 * ある tick における「誰のどの施設が想起困難で止まっているか」の索引
 * ({@link isTechRelatedImpaired} を 1 パスへ畳んだもの)。
 *
 * Set は**メンバシップ照会にしか使わない**(反復しない)ので、反復順が結果へ
 * 漏れることはない(GDD 11.7 / state.ts §2 の趣旨)。
 */
export interface ImpairmentIndex {
  /** 1 件も想起困難が無い(この場合の照会は常に false)。 */
  readonly empty: boolean;
  /** 実地要件不明の tech で**全施設**が止まっている住民。 */
  readonly stopAll: ReadonlySet<EntityId>;
  /** 住民 → 止まっている施設定義 ID の集合。 */
  readonly stoppedFacilityDefIds: ReadonlyMap<EntityId, ReadonlySet<EntityId>>;
}

/** 空の索引(共有値・アロケーションを避ける)。 */
export const EMPTY_IMPAIRMENT_INDEX: ImpairmentIndex = {
  empty: true,
  stopAll: new Set(),
  stoppedFacilityDefIds: new Map(),
};

/**
 * {@link ImpairmentIndex} を記憶キー 1 パスで作る((A) 区間の入口で 1 回だけ呼ぶ)。
 */
export function buildImpairmentIndex(
  state: GameState,
  content: EngineContent,
  tick: number,
): ImpairmentIndex {
  if (state.techMemoryByKey.size === 0) return EMPTY_IMPAIRMENT_INDEX;
  const stopAll = new Set<EntityId>();
  const stoppedFacilityDefIds = new Map<EntityId, Set<EntityId>>();
  let empty = true;
  for (const key of techMemoryKeys(state)) {
    const memory = getTechMemory(state, key);
    if (memory === undefined || tick >= memory.impairedUntilTick) continue;
    const separator = key.indexOf("|");
    if (separator <= 0) continue;
    const residentId = key.slice(0, separator) as EntityId;
    const techId = key.slice(separator + 1) as EntityId;
    const fieldFacilityId = content.techDefs.get(techId)?.fieldFacilityId;
    empty = false;
    if (fieldFacilityId === undefined) {
      // 実地要件が解決できない = 停止範囲が決まらないので住民単位の全停止(§1)。
      stopAll.add(residentId);
      continue;
    }
    const existing = stoppedFacilityDefIds.get(residentId);
    if (existing === undefined) {
      stoppedFacilityDefIds.set(residentId, new Set([fieldFacilityId]));
    } else {
      existing.add(fieldFacilityId);
    }
  }
  return { empty, stopAll, stoppedFacilityDefIds };
}

/** {@link ImpairmentIndex} への照会({@link isTechRelatedImpaired} と同値)。 */
export function indexStopsFacility(
  index: ImpairmentIndex,
  residentId: EntityId,
  facilityDefId: EntityId,
): boolean {
  if (index.empty) return false;
  if (index.stopAll.has(residentId)) return true;
  return index.stoppedFacilityDefIds.get(residentId)?.has(facilityDefId) === true;
}

// --- 3. 想起困難の記録(rules/recall.ts から呼ばれる) ----------------------

/**
 * (住民, 技術) の想起困難の解ける tick を書き込む(既存の定着度は保つ)。
 */
export function setTechImpairedUntil(
  state: GameState,
  residentId: EntityId,
  techId: EntityId,
  untilTick: number,
): GameState {
  const key = techMemoryKeyOf(residentId, techId);
  const previous = getTechMemory(state, key);
  return setTechMemory(state, key, {
    masteryFix: previous?.masteryFix ?? FIX_ZERO,
    impairedUntilTick: untilTick,
  });
}

// --- 4. 定着度の蓄積((A) 区間の閉形式・§4) -------------------------------

/** 1 (住民, 技術) ぶんの定着度蓄積レート。 */
export interface MasteryGainEntry {
  readonly residentId: EntityId;
  readonly techId: EntityId;
  readonly gainPerTickFix: Fix;
}

/** {@link computeMasteryGains} の結果。`entries` はキー昇順(§3)。 */
export type MasteryGains = readonly MasteryGainEntry[];

/** 空のレート集合(アロケーションを避けるための共有値)。 */
export const NO_MASTERY_GAINS: MasteryGains = [];

/**
 * 1 ゲーム日あたりの蓄積量を 1 tick あたりへ落とす(§4: 先に 1 回だけ floor)。
 * content に `masteryGainPerFieldWorkDayFix` が無ければ 0 = 蓄積しない。
 */
export function masteryGainPerTickFix(content: EngineContent): Fix {
  const perDay = content.recallRisk.masteryGainPerFieldWorkDayFix;
  if (perDay === undefined) return FIX_ZERO;
  const raw = toRaw(perDay);
  if (raw <= 0) return FIX_ZERO;
  return fixFromRaw(floorDivInt(raw, GAME_DAY_TICKS));
}

/**
 * その技術が**解禁済み**か(= 完了した research entity がある)。
 * GDD 4「**解禁** → 実地稼働で記憶定着」の順序を守るためのゲートであり、
 * まだ研究していない技術の定着が実地稼働だけで生えるのを防ぐ。
 */
export function isTechUnlocked(state: GameState, techId: EntityId): boolean {
  for (const research of entitiesOfKind(state, "research")) {
    if (research.techId === techId && research.completedTick !== null) return true;
  }
  return false;
}

/** 解禁済み techId の集合(research entity 1 パス。メンバシップ照会専用)。 */
function unlockedTechIdSet(state: GameState): ReadonlySet<EntityId> {
  const result = new Set<EntityId>();
  for (const research of entitiesOfKind(state, "research")) {
    if (research.completedTick !== null) result.add(research.techId);
  }
  return result;
}

/**
 * 施設定義 ID → 実地稼働の対象になる技術(techId 昇順)。
 * 「解禁済み」かつ「実地要件がその施設」の tech だけが並ぶ。
 */
function fieldTechIdsByFacilityDefId(
  state: GameState,
  content: EngineContent,
): ReadonlyMap<EntityId, readonly EntityId[]> {
  const unlocked = unlockedTechIdSet(state);
  const grouped = new Map<EntityId, EntityId[]>();
  if (unlocked.size === 0) return grouped;
  for (const tech of content.techDefs.values()) {
    const facilityDefId = tech.fieldFacilityId;
    if (facilityDefId === undefined) continue;
    if (!unlocked.has(tech.id)) continue;
    const existing = grouped.get(facilityDefId);
    if (existing === undefined) grouped.set(facilityDefId, [tech.id]);
    else existing.push(tech.id);
  }
  for (const techIds of grouped.values()) {
    techIds.sort(compareUtf16);
  }
  return grouped;
}

/**
 * 現在の state から 1 tick あたりの定着度蓄積レートを計算する
 * ((A) 区間の入口・production.ts の `computeProductionRates` と同型)。
 *
 * `isActiveWorker` は「その住民が今この施設で稼働しているか」の述語で、
 * 呼び出し側(production.ts)が生産式と**同一の判定**を渡す(2 か所で「稼働」の
 * 定義が分岐しないようにするため。ここで独自に判定し直さない)。
 */
export function computeMasteryGains(
  state: GameState,
  content: EngineContent,
  isActiveWorker: (resident: ResidentState, facilityDefId: EntityId) => boolean,
): MasteryGains {
  const perTick = masteryGainPerTickFix(content);
  if (toRaw(perTick) <= 0) return NO_MASTERY_GAINS;

  const techIdsByFacilityDefId = fieldTechIdsByFacilityDefId(state, content);
  if (techIdsByFacilityDefId.size === 0) return NO_MASTERY_GAINS;

  const entries: MasteryGainEntry[] = [];
  for (const facility of entitiesOfKind(state, "facility")) {
    const techIds = techIdsByFacilityDefId.get(facility.defId);
    if (techIds === undefined || techIds.length === 0) continue;
    for (const workerId of facility.workerIds) {
      const resident = requireEntity(state, workerId, "resident");
      if (!isActiveWorker(resident, facility.defId)) continue;
      for (const techId of techIds) {
        entries.push({ residentId: workerId, techId, gainPerTickFix: perTick });
      }
    }
  }
  // 同じ (住民, tech) が 2 施設から来ることは有り得る(同じ定義の施設が 2 基あり
  // 両方に就いている state は無い = workerIds は施設ごとだが住民の配属は 1 つ)。
  // 念のためキー昇順へ明示ソートしてから返す(§3)。
  return entries.sort((a, b) =>
    compareUtf16(techMemoryKeyOf(a.residentId, a.techId), techMemoryKeyOf(b.residentId, b.techId)),
  );
}

/**
 * (A) 区間ぶんの定着度蓄積を一括適用する(§4)。上限は
 * `recallRisk.masteryResistMaxFix`(GDD 11.2 の 0.20)。
 *
 * @throws {RulesError} deltaTicks が 1 以上の整数でない場合
 */
export function applyMasteryProgress(
  state: GameState,
  content: EngineContent,
  gains: MasteryGains,
  deltaTicks: number,
): GameState {
  if (!Number.isSafeInteger(deltaTicks) || deltaTicks < 1) {
    throw new RulesError(`applyMasteryProgress: deltaTicks ${String(deltaTicks)} は 1 以上の整数`);
  }
  if (gains.length === 0) return state;

  const cap = content.recallRisk.masteryResistMaxFix;
  const updates: [string, TechMemoryState][] = [];
  for (const gain of gains) {
    const key = techMemoryKeyOf(gain.residentId, gain.techId);
    const previous = getTechMemory(state, key);
    const before = previous?.masteryFix ?? FIX_ZERO;
    const after = clampFix(
      addFix(before, mulFixInt(gain.gainPerTickFix, deltaTicks)),
      FIX_ZERO,
      cap,
    );
    if (toRaw(after) === toRaw(before)) continue;
    updates.push([key, { masteryFix: after, impairedUntilTick: previous?.impairedUntilTick ?? 0 }]);
  }
  // Map の複製を 1 枚に抑える(update.ts の setTechMemories)。gains はキー昇順で
  // 重複が無いので、1 件ずつ書いた場合と結果は同一。
  return setTechMemories(state, updates);
}

/**
 * GDD 11.2 の `masteryResist(u,t)` の「実地稼働で蓄積する定着度(0〜0.20)」の項。
 *
 * `resident.mastery`(住民単位のスカラ・T5 由来)と当該 tech の蓄積を**加算**して
 * 上限でクランプする。加算にしてある理由:
 *   ・`resident.mastery` は「住民一般の基礎定着度」として残す(sim の
 *     `harsh-high-mastery` パターン・conformance sc08 が直接この値を置く)
 *   ・techMemory が空なら加算項が 0 なので **M13 以前と厳密に同一**
 * 上限クランプは裁定 N12 の「上限 0.20 が過酷業務の `base_p × loadW` を完全に
 * 相殺しうる」挙動をそのまま維持する(意図的な仕様)。
 */
export function masteryResistBaseFix(
  state: GameState,
  content: EngineContent,
  resident: ResidentState,
  techId: EntityId,
): Fix {
  const accumulated = addFix(resident.mastery, techMasteryOf(state, resident.id, techId));
  return clampFix(accumulated, FIX_ZERO, content.recallRisk.masteryResistMaxFix);
}

// --- 5. (B) 一回性喪失(GDD 7.4 / §10.2 と同一規則)-----------------------

/** 喪失 1 件の記録({@link applyTechLossOnDeath} の戻り値)。 */
export interface TechLossOutcome {
  readonly techId: EntityId;
  /** (B) rareIrreversible なら true(= 永久喪失)。(A) は false(= 停滞のみ)。 */
  readonly irreversible: boolean;
}

/** {@link applyTechLossOnDeath} の結果。 */
export interface TechLossResult {
  readonly state: GameState;
  /** 喪失した技術(techId 昇順)。 */
  readonly lost: readonly TechLossOutcome[];
}

/** その techId の research entity(ID 昇順の先頭)。無ければ undefined。 */
function researchEntityOfTech(state: GameState, techId: EntityId): ResearchState | undefined {
  for (const research of entitiesOfKind(state, "research")) {
    if (research.techId === techId) return research;
  }
  return undefined;
}

/**
 * 住民 1 人の死亡に伴う技術喪失を適用する(GDD 7.4 / GDD §10.2 の追補
 * 「生存保持者ゼロかつ記録ゼロの場合のみ周回内喪失((A) は次周再取得可・
 * (B) は永久)」)。
 *
 * 判定は死亡**後**の state に対して行う(死者は `livingResidents` から外れて
 * いるので、`techHoldersOf` が空 = 生存保持者ゼロ)。呼び出し順は
 * scheduler.ts の段70 で `applyResidentDeath` → `recordDeathMemoir` →
 * `applyPartnerLossEffects` → 本関数 の順に固定してある。
 *
 * 喪失した tech は research entity を「未完了・進行度 0」へ戻し
 * (= 解禁の取り消し)、`loss` を書き込む。(A) はそのまま再研究できるが、
 * (B) は `loss.irreversible` が立つので `currentResearch` の対象から外れる
 * (rules/research.ts)。
 */
export function applyTechLossOnDeath(
  state: GameState,
  content: EngineContent,
  deceasedId: EntityId,
  tick: number,
): TechLossResult {
  const deceased = requireEntity(state, deceasedId, "resident");
  if (isAliveResident(deceased)) {
    throw new RulesError(
      `applyTechLossOnDeath: 住民 "${deceasedId}" は生存している(死亡処理の後に呼ぶこと)`,
    );
  }

  let next = state;
  const lost: TechLossOutcome[] = [];
  for (const techId of heldTechIdsOf(state, deceasedId)) {
    const applied = applyTechLossIfOrphaned(next, content, techId, tick, deceasedId);
    next = applied.state;
    if (applied.outcome !== undefined) lost.push(applied.outcome);
  }
  return { state: next, lost };
}

/**
 * [M22] 「生存保持者ゼロ かつ 記録ゼロ」に達した 1 技術へ喪失を適用する
 * (GDD 7.4 / GDD 11.1 [2026-07-27追補] の焼失セマンティクス)。
 *
 * {@link applyTechLossOnDeath}(死亡起因)と `rules/event.ts` の
 * `destroyRecords`(記録の焼失起因)の**共通の 1 箇所**であり、判定の順序も
 * 書き込む内容も両者で完全に同じになる(喪失判定が二重の真実にならない)。
 *
 * `lastHolderId` が null なのは記録の焼失で喪失した場合であり、そのときは
 * `research.loss.lastHolderId` をキーごと省略する(名指しできる保持者が
 * 居ないため・state.ts の {@link ../state/state.TechLossState})。
 *
 * 喪失しない(= 何もしない)条件は 3 つ:
 *   (a) 記録が 1 枚でも残っている
 *   (b) 生存保持者が 1 人でも残っている
 *   (c) その技術がそもそも解禁されていない(research entity が無い / 未完了)
 */
export function applyTechLossIfOrphaned(
  state: GameState,
  content: EngineContent,
  techId: EntityId,
  tick: number,
  lastHolderId: EntityId | null,
): { readonly state: GameState; readonly outcome: TechLossOutcome | undefined } {
  // 記録が 1 枚でも残っていれば知識は失われない(GDD 11.1 追補の焼失セマンティクス)。
  if (isCodified(state, techId)) return { state, outcome: undefined };
  // 生存保持者が 1 人でも残っていれば失われない。
  if (techHoldersOf(state, techId).length > 0) return { state, outcome: undefined };
  const research = researchEntityOfTech(state, techId);
  // 解禁されていない(research entity が無い / 未完了)技術は失うものが無い。
  if (research === undefined || research.completedTick === null) {
    return { state, outcome: undefined };
  }

  const irreversible = lossClassOfTech(content, techId) === "rareIrreversible";
  const loss =
    lastHolderId === null ? { tick, irreversible } : { tick, irreversible, lastHolderId };
  const next = updateEntity(state, research.id, "research", (r) =>
    setField(setField(setField(r, "completedTick", null), "progress", FIX_ZERO), "loss", loss),
  );
  return { state: next, outcome: { techId, irreversible } };
}

/** その research entity が (B) 一回性喪失で永久に失われているか(GDD 7.4)。 */
export function isIrreversiblyLost(research: ResearchState): boolean {
  return research.loss !== undefined && research.loss.irreversible;
}
