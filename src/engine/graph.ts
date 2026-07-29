// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 唯一保持者再取得可能性の静的グラフ解析 — GDD 11.4-2 / 7.4 / 10.2
//
// ===========================================================================
// 1. このモジュールが答える問い(GDD 11.4-2)
// ===========================================================================
//   「prereq グラフ上で、各 (A) テックの `fieldRequirement` を満たす **role** が
//   常時 ≥1 人 再構成可能か」。言い換えると:
//
//     唯一保持者が全員死に、記録も全て失われた**最悪の盤面**からでも、
//     全ての (A) criticalRecoverable テックを研究し直せるか(= ソフトロックしないか)。
//
//   ここでいう **role** = 「実地要件の施設で、実地要件のレシピを回す就労者 1 人」。
//   その role が立つには、静的には次の 3 つが同時に要る:
//     (i)   実地要件の施設が content に実在する
//     (ii)  その施設に就労枠が 1 つ以上ある(全 Lv で 0 なら誰も置けない)
//     (iii) その施設を建て直せる = 初期解禁か、**再構成可能なテック**が解禁する
//   人の側の「≥1 人」は GDD 7.6 の人口下限保証(`min(寝床×0.5, 6)`・M11)が
//   動的に担保する。本モジュールが担うのは**構造側**、つまり
//   「人はいるのに置く場所(role)が復元できない」形のソフトロックの検出である。
//
// ===========================================================================
// 2. なぜ「最小不動点 1 回」で「常時」を尽くせるのか(証明)
// ===========================================================================
//   再構成可能性は知識集合について**単調**である: 既に持っている知識が増えて
//   困ることはない(前提充足も施設解禁も「持っていれば通る」条件しかない)。
//   よって任意の途中盤面 S に対し
//        reconstructible(∅) ⊆ reconstructible(S)
//   が成り立つ。**最悪盤面 = 全喪失 = ∅** なので、∅ からの最小不動点が
//   全 (A) を含めば、どの途中盤面からでも含む = 「常時」再取得可能。
//   したがって全盤面を列挙する必要はなく、不動点 1 回で足りる。
//
//   (B) rareIrreversible は GDD 7.4 /10.2 が「永久喪失」と定めている
//   (「(A)は次周再取得可・(B)は永久喪失」)。よって最悪盤面では **(B) は
//   二度と手に入らない**ものとして扱う = 不動点に入れない。これが
//   「(A) が (B) に(前提でも施設ゲートでも)ぶら下がっていたらソフトロック」
//   という本検査の骨格になる。
//
// ===========================================================================
// 3. 入力が EngineContent ではなく content 形の構造体である理由
// ===========================================================================
//   本検査が読む 3 つの値は、いずれも `EngineContent`(rules/types.ts)に無い:
//     - `tech.fieldRequirement`  : 縮約 rules が読まないので写していない
//     - `tech.unlocks`           : 同上
//     - `facility.slots`         : 同上(生産式は就労者の側から入る)
//   さらに `fieldRequirement.recipe` は **recipe カテゴリ自体が未ロード**
//   (schema/tech.ts 冒頭)であり、engine 内部表現へ入れると「engine が実在確認
//   できない参照」を抱え込むことになる。よって本モジュールは EngineContent に
//   依存せず、**呼び出し側が渡す content 形の最小構造体**を入力に取る。
//   `schema/tech.ts` の `TechContent` / `schema/facility.ts` の `FacilityContent`
//   は下の {@link TechGraphSource} / {@link FacilityGraphSource} に構造的に
//   代入可能なので、検証済みバンドルをそのまま渡せる(import は発生しない =
//   engine → schema の依存を作らない)。
//
// ===========================================================================
// 4. なぜ content ロード経路で強制しないのか
// ===========================================================================
//   rules/techTree.ts §3 と同じ理由 + 上記 §3。すなわち
//   (a) ロード経路(`loadEngineContent`)は golden vector のシナリオ patch を
//       通す必要があり、静的解析の失敗でロードを止めると検証系が回らない、
//   (b) そもそも入力が EngineContent ではないのでロード経路に置けない。
//   よって**独立した検査関数**として提供し、実 content に対してテスト
//   (= CI ゲート)から回す。GDD 12.4 の運営パイプラインでも、スキーマ検証段の
//   1 ステップとしてここを呼ぶ想定(sim の 11.4-2 判定と対になる静的側)。
//
// ===========================================================================
// 5. rules/techTree.ts との関係(重複と差分)
// ===========================================================================
//   techTree.ts の `reachabilityIssues` (4) は「(A) の前提の閉包に (B) が
//   混ざっていないか」を見る。これは本モジュールの検査の **prereq だけの特殊形**
//   である。本モジュールが追加で捕まえるのは:
//     - 実地要件の施設が無い / 就労枠 0 / (B) だけが解禁する施設に依存している
//     - 上記が原因で再構成不能になったテックへ**さらにぶら下がる**連鎖
//     - 「自分自身(または自分の後続)しか解禁しない施設」を実地要件に持つ堂々巡り
//   両者は入力型が違う(EngineContent vs content 形)ため関数としては合流させず、
//   テスト側で両方を回す。techTree.ts は無改変。
//
// ===========================================================================
// 6. 決定論(GDD 11.7 / ADR-010)
// ===========================================================================
//   - 入力配列は構築時に **ID の UTF-16 昇順**へ正規化し、以後の走査は全て
//     その配列を辿る。Map/Set の反復順に依存しない。
//   - 返す配列も全て ID 昇順。
//   - 不動点は**最小不動点**なので、単調規則の適用順に依らず結果が一意
//     (chaotic iteration の合流性)。ID 昇順の走査は途中経過まで固定する。
//   - Math は max のみ(ADR-006 許可リスト)。乱数・時刻・浮動小数演算は無し
//     (整数の比較しかしない)。
//
// ===========================================================================
// 7. 計算量
// ===========================================================================
//   T = テック数, F = 施設数, P = 前提辺数, U = unlocks 辺数 とすると
//     構築     : O(T log T + F log F + P + U)
//     不動点   : 1 巡 O(T + F + P) で、1 巡ごとに最低 1 本が確定するか終了する
//                ので巡回数 ≤ T+1 ⇒ **O(T·(T + F + P))**
//   MVP は T=24 / F=3 なので実測上は無視できる。数千テック規模になったら
//   Kahn 型のワークリスト(O(T+F+P))へ置き換えられる(結果は同じ最小不動点)。
//
// ===========================================================================
// 8. 既知の限界(正直な開示・ADR 残余リスク #8)
// ===========================================================================
//   - recipe カテゴリが未実装なので「そのレシピが実在するか」「その施設で回せるか」
//     は検査できない。recipe が content 化されたらここに足すこと。
//   - 資源の枯渇・面積(6×8 格子の空き)・研究点の供給といった**量的**な詰みは
//     対象外(GDD 11.4-2 前半「クリティカル資源の生産レート >0」= sim 側の担当)。
//   - `unlocks[]` の要素のうち **facility カテゴリの ID に解決できるもの**を
//     「その施設の建設解禁」と解釈している。GDD 12.1 は `unlocks[]` の中身を
//     明示していないため**これは解釈であり、確認が要る**。現 content の
//     `unlocks[]` は全て tech ID なので、この解釈でも施設ゲートは 1 本も生えない
//     (= 現時点の判定結果には影響しない)。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "./canonicalize";
import type { TechLossClass } from "./rules/types";

// --- 1. 入力(content 形の最小構造体・§3) ---------------------------------

/**
 * 実地要件(GDD 12.1 `tech.fieldRequirement`)のうち本解析が読む部分。
 * `recipe` / `count` は**判定には使わず**、診断メッセージにだけ現れる(§8)。
 */
export interface FieldRequirementSource {
  readonly facility: string;
  readonly recipe: string;
  readonly count: number;
}

/**
 * Lv 別の就労枠(GDD 7.7 `facility.slots`)。schema 側で Lv 昇順に単調非減少が
 * 強制されているが、本モジュールはそれに依存せず最大値を取る。
 */
export interface FacilitySlotsSource {
  readonly lv1: number;
  readonly lv2: number;
  readonly lv3: number;
  readonly lv4: number;
  readonly lv5: number;
}

/** tech content のうち本解析が読む部分(`schema/tech.ts` の TechContent 互換)。 */
export interface TechGraphSource {
  readonly id: string;
  readonly lossClass: TechLossClass;
  readonly prereqs: readonly string[];
  readonly fieldRequirement: FieldRequirementSource;
  readonly unlocks: readonly string[];
}

/** facility content のうち本解析が読む部分(`schema/facility.ts` の FacilityContent 互換)。 */
export interface FacilityGraphSource {
  readonly id: string;
  readonly slots: FacilitySlotsSource;
}

// --- 2. 正規化済みグラフ ---------------------------------------------------

/** グラフ構築時の不変条件違反(ID 重複・カテゴリ跨ぎの衝突)。 */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

/** 正規化済みのテックノード。配列は全て ID 昇順・重複なし。 */
export interface TechNode {
  readonly id: string;
  readonly lossClass: TechLossClass;
  readonly prereqs: readonly string[];
  readonly fieldRequirement: FieldRequirementSource;
}

/** 正規化済みの施設ノード。 */
export interface FacilityNode {
  readonly id: string;
  /** 全 Lv を通じた就労枠の最大値。0 ならこの施設に role を 1 人も置けない。 */
  readonly maxWorkerSlots: number;
  /**
   * この施設の建設を解禁するテック(ID 昇順・重複なし)。
   * **空 = 初期から建てられる**(どのテックにもゲートされていない)。
   */
  readonly gateTechIds: readonly string[];
}

/** 静的解析の対象グラフ。{@link buildRecoverabilityGraph} だけが作る。 */
export interface RecoverabilityGraph {
  /** ID 昇順。走査順の唯一の根拠。 */
  readonly techIds: readonly string[];
  readonly techNodeById: ReadonlyMap<string, TechNode>;
  /** ID 昇順。 */
  readonly facilityIds: readonly string[];
  readonly facilityNodeById: ReadonlyMap<string, FacilityNode>;
}

// --- 3. 検査結果 -----------------------------------------------------------

/**
 * 再取得不能の原因分類。並びは UTF-16 昇順(レジストリの正準順)。
 *
 *   facilityGateUnrecoverable : 実地要件の施設を解禁するテックが全て再構成不能
 *   facilityMissing           : 実地要件の施設が content に無い
 *   facilityNoWorkerSlot      : 実地要件の施設の就労枠が全 Lv で 0
 *   prereqMissing             : 前提テックが content に無い
 *   prereqUnrecoverable       : 前提テックが再構成不能((B) 永久喪失またはその連鎖)
 */
export const RECOVERABILITY_ISSUE_KINDS = [
  "facilityGateUnrecoverable",
  "facilityMissing",
  "facilityNoWorkerSlot",
  "prereqMissing",
  "prereqUnrecoverable",
] as const;

/** {@link RECOVERABILITY_ISSUE_KINDS} のいずれか。 */
export type RecoverabilityIssueKind = (typeof RECOVERABILITY_ISSUE_KINDS)[number];

/** 再取得保証(GDD 11.4-2)が破れている (A) テック 1 件。 */
export interface RecoverabilityIssue {
  /** 再取得できない (A) テック。 */
  readonly techId: string;
  /** 原因が施設側にあるときの施設 ID。前提側が原因なら null。 */
  readonly facilityId: string | null;
  readonly kind: RecoverabilityIssueKind;
  /** 原因になったテック(ID 昇順)。施設の欠落・枠 0 が原因なら空。 */
  readonly blockedByTechIds: readonly string[];
  readonly message: string;
}

// --- 4. グラフ構築 ---------------------------------------------------------

/**
 * content 形の入力を正規化グラフへ写す。
 *
 * `unlocks[]` の要素のうち **facility カテゴリの ID に解決できるもの**を
 * 「その施設の建設を解禁する」辺として拾う(§8)。tech ID に解決するものや
 * どちらにも解決しないものは、この解析では辺にならない(黙って無視する = 施設
 * ゲートの有無だけが本検査の関心であり、tech→tech の解禁ヒントは prereq の
 * 逆辺として既に表現されているため)。
 *
 * @throws {GraphError} ID がカテゴリ内で重複、または tech と facility で衝突した場合
 *   (どちらも ADR-024(1) のグローバル一意性で上流が弾いているはずのもの)
 */
export function buildRecoverabilityGraph(
  techs: readonly TechGraphSource[],
  facilities: readonly FacilityGraphSource[],
): RecoverabilityGraph {
  const sortedFacilities = [...facilities].sort((l, r) => compareUtf16(l.id, r.id));
  const maxWorkerSlotsById = new Map<string, number>();
  for (const facility of sortedFacilities) {
    if (maxWorkerSlotsById.has(facility.id)) {
      throw new GraphError(`buildRecoverabilityGraph: facility ID "${facility.id}" が重複している`);
    }
    maxWorkerSlotsById.set(facility.id, maxWorkerSlotsOf(facility.slots));
  }

  const sortedTechs = [...techs].sort((l, r) => compareUtf16(l.id, r.id));
  const techNodeById = new Map<string, TechNode>();
  const gateTechIdsByFacilityId = new Map<string, string[]>();
  for (const tech of sortedTechs) {
    if (techNodeById.has(tech.id)) {
      throw new GraphError(`buildRecoverabilityGraph: tech ID "${tech.id}" が重複している`);
    }
    if (maxWorkerSlotsById.has(tech.id)) {
      throw new GraphError(
        `buildRecoverabilityGraph: ID "${tech.id}" が tech と facility の両方にある` +
          "(ADR-024(1) のグローバル ID 一意性違反。施設ゲートの解決が曖昧になる)",
      );
    }
    techNodeById.set(tech.id, {
      id: tech.id,
      lossClass: tech.lossClass,
      prereqs: sortedUnique(tech.prereqs),
      fieldRequirement: {
        facility: tech.fieldRequirement.facility,
        recipe: tech.fieldRequirement.recipe,
        count: tech.fieldRequirement.count,
      },
    });
    for (const unlockId of sortedUnique(tech.unlocks)) {
      if (!maxWorkerSlotsById.has(unlockId)) continue;
      const gates = gateTechIdsByFacilityId.get(unlockId);
      if (gates === undefined) {
        gateTechIdsByFacilityId.set(unlockId, [tech.id]);
      } else {
        gates.push(tech.id);
      }
    }
  }

  const facilityNodeById = new Map<string, FacilityNode>();
  for (const facility of sortedFacilities) {
    facilityNodeById.set(facility.id, {
      id: facility.id,
      maxWorkerSlots: maxWorkerSlotsById.get(facility.id) ?? 0,
      // 追加順は tech の ID 昇順なので既に昇順だが、順序の根拠を 1 箇所に置く。
      gateTechIds: sortedUnique(gateTechIdsByFacilityId.get(facility.id) ?? []),
    });
  }

  return {
    techIds: sortedTechs.map((tech) => tech.id),
    techNodeById,
    facilityIds: sortedFacilities.map((facility) => facility.id),
    facilityNodeById,
  };
}

// --- 5. 不動点(§2) -------------------------------------------------------

/**
 * 全喪失盤面(∅)から再構成できるテックの最小不動点。ID 昇順。
 *
 * (B) rareIrreversible は永久喪失(GDD 7.4 / 10.2)なので**決して入らない**。
 *
 * @throws {GraphError} 巡回上限を超えても収束しない場合(単調性が壊れた = 実装バグ)
 */
export function recoverableTechIds(graph: RecoverabilityGraph): readonly string[] {
  const recoverable = new Set<string>();
  // 1 巡ごとに最低 1 本確定するか終了するので、T+1 巡あれば必ず収束する。
  const roundLimit = graph.techIds.length + 1;

  for (let round = 0; round <= roundLimit; round++) {
    const rebuildable = rebuildableFacilityIdSet(graph, recoverable);
    let changed = false;
    for (const techId of graph.techIds) {
      if (recoverable.has(techId)) continue;
      const node = graph.techNodeById.get(techId);
      if (node === undefined) continue;
      if (node.lossClass !== "criticalRecoverable") continue;
      if (blockingReasonOf(graph, node, recoverable, rebuildable) !== null) continue;
      recoverable.add(techId);
      changed = true;
    }
    if (!changed) return [...recoverable].sort(compareUtf16);
  }

  throw new GraphError(
    `recoverableTechIds: ${String(roundLimit)} 巡しても不動点に達しない(単調性が壊れている = 実装バグ)`,
  );
}

/**
 * 全喪失盤面から建て直せて、かつ就労者を 1 人置ける施設。ID 昇順。
 * = 「role の置き場所として当てにできる施設」の全体。
 */
export function rebuildableFacilityIds(graph: RecoverabilityGraph): readonly string[] {
  const recoverable = new Set(recoverableTechIds(graph));
  return [...rebuildableFacilityIdSet(graph, recoverable)].sort(compareUtf16);
}

// --- 6. 検査(GDD 11.4-2)-------------------------------------------------

/**
 * GDD 11.4-2 の静的側:「各 (A) テックの `fieldRequirement` を満たす role が
 * 常時 ≥1 人 再構成可能か」。破れているものを ID 昇順で返す(空 = 合格)。
 *
 * 1 テックにつき 1 件だけ、**最初に見つかった阻害要因**を報告する
 * (前提を ID 昇順に見てから実地要件を見る)。連鎖で詰んだテックは
 * 一次原因と別の件として全て並ぶので、直す順序は自分で選べる。
 *
 * @throws {GraphError} 不動点に入らないのに阻害要因が見つからない場合(実装バグ)
 */
export function recoverabilityIssues(graph: RecoverabilityGraph): readonly RecoverabilityIssue[] {
  const recoverable = new Set(recoverableTechIds(graph));
  const rebuildable = rebuildableFacilityIdSet(graph, recoverable);
  const issues: RecoverabilityIssue[] = [];

  for (const techId of graph.techIds) {
    const node = graph.techNodeById.get(techId);
    if (node === undefined) continue;
    // 保証範囲は (A) のみ。(B) は一回性喪失を許容する(GDD 7.4)。
    if (node.lossClass !== "criticalRecoverable") continue;
    if (recoverable.has(techId)) continue;

    const reason = blockingReasonOf(graph, node, recoverable, rebuildable);
    if (reason === null) {
      throw new GraphError(
        `recoverabilityIssues: tech "${techId}" が不動点に入っていないのに阻害要因が無い(実装バグ)`,
      );
    }
    issues.push({
      techId,
      facilityId: reason.facilityId,
      kind: reason.kind,
      blockedByTechIds: reason.blockedByTechIds,
      message: messageOf(node, reason),
    });
  }
  return issues;
}

/**
 * content 形の入力から {@link recoverabilityIssues} まで一息に回す入口。
 * 検証済みバンドルの `tech` / `facility` をそのまま渡せる(§3)。
 */
export function soleKeeperRecoverabilityIssues(
  techs: readonly TechGraphSource[],
  facilities: readonly FacilityGraphSource[],
): readonly RecoverabilityIssue[] {
  return recoverabilityIssues(buildRecoverabilityGraph(techs, facilities));
}

// --- 7. 内部 --------------------------------------------------------------

/** 1 テックが再構成できない理由(最初に見つかったもの)。 */
interface BlockingReason {
  readonly kind: RecoverabilityIssueKind;
  readonly facilityId: string | null;
  readonly blockedByTechIds: readonly string[];
}

/**
 * `node` を今の知識集合から研究し直せない理由。研究し直せるなら null。
 *
 * 判定順は「前提(ID 昇順)→ 実地要件(実在 → 就労枠 → 施設ゲート)」で固定。
 * この順序が診断メッセージの決定性の根拠でもある。
 */
function blockingReasonOf(
  graph: RecoverabilityGraph,
  node: TechNode,
  recoverable: ReadonlySet<string>,
  rebuildable: ReadonlySet<string>,
): BlockingReason | null {
  for (const prereqId of node.prereqs) {
    if (!graph.techNodeById.has(prereqId)) {
      return { kind: "prereqMissing", facilityId: null, blockedByTechIds: [prereqId] };
    }
    if (!recoverable.has(prereqId)) {
      return { kind: "prereqUnrecoverable", facilityId: null, blockedByTechIds: [prereqId] };
    }
  }

  const facilityId = node.fieldRequirement.facility;
  const facility = graph.facilityNodeById.get(facilityId);
  if (facility === undefined) {
    return { kind: "facilityMissing", facilityId, blockedByTechIds: [] };
  }
  if (facility.maxWorkerSlots < 1) {
    return { kind: "facilityNoWorkerSlot", facilityId, blockedByTechIds: [] };
  }
  if (!rebuildable.has(facilityId)) {
    return {
      kind: "facilityGateUnrecoverable",
      facilityId,
      blockedByTechIds: facility.gateTechIds,
    };
  }
  return null;
}

/**
 * 今の知識集合で「建て直せて、かつ就労者を 1 人置ける」施設の集合。
 * 反復は {@link RecoverabilityGraph.facilityIds}(ID 昇順)を辿るだけで、
 * 戻り値の Set は membership 判定にしか使わない(反復順に依存しない)。
 */
function rebuildableFacilityIdSet(
  graph: RecoverabilityGraph,
  recoverable: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const facilityId of graph.facilityIds) {
    const node = graph.facilityNodeById.get(facilityId);
    if (node === undefined) continue;
    if (node.maxWorkerSlots < 1) continue;
    if (node.gateTechIds.length === 0) {
      result.add(facilityId);
      continue;
    }
    for (const gateTechId of node.gateTechIds) {
      if (!recoverable.has(gateTechId)) continue;
      result.add(facilityId);
      break;
    }
  }
  return result;
}

/** 診断メッセージ。role の言葉(施設 × レシピ × 回数)を必ず含める。 */
function messageOf(node: TechNode, reason: BlockingReason): string {
  const requirement = node.fieldRequirement;
  const role =
    `実地要件の role(施設 "${requirement.facility}" でレシピ "${requirement.recipe}" を ` +
    `${String(requirement.count)} 回)`;

  switch (reason.kind) {
    case "prereqMissing":
      return (
        `前提 "${String(reason.blockedByTechIds[0])}" が content に無いので研究し直せない` +
        "(GDD 11.4-2: (A)技術再取得ルート常時存在)"
      );
    case "prereqUnrecoverable":
      return (
        `前提 "${String(reason.blockedByTechIds[0])}" が全喪失盤面から再構成できない` +
        "((B) の永久喪失かその連鎖)。(A) の再取得保証が破れている(GDD 7.4 / 11.4-2)"
      );
    case "facilityMissing":
      return `${role}の施設が content に無いので、role を 1 人も立てられない(GDD 11.4-2)`;
    case "facilityNoWorkerSlot":
      return (
        `${role}の施設の就労枠が全 Lv で 0 なので、role に住民を 1 人も置けない` +
        "(GDD 11.4-2「role が常時 ≥1人」)"
      );
    case "facilityGateUnrecoverable":
      return (
        `${role}の施設を解禁するテック(${reason.blockedByTechIds.join(", ")})が` +
        "全喪失盤面から再構成できないので、施設ごと建て直せず role を復元できない" +
        (reason.blockedByTechIds.includes(node.id)
          ? "。自分自身が解禁するテックになっており堂々巡りになっている"
          : "") +
        "(GDD 11.4-2)"
      );
  }
}

/** 全 Lv を通じた就労枠の最大値(Math.max は ADR-006 の許可リスト内)。 */
function maxWorkerSlotsOf(slots: FacilitySlotsSource): number {
  return Math.max(slots.lv1, slots.lv2, slots.lv3, slots.lv4, slots.lv5);
}

/** ID 配列を重複除去して UTF-16 昇順にする(走査順を 1 箇所に固定するため)。 */
function sortedUnique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort(compareUtf16);
}
