// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 非稼働施設の正直表示(M61/FC6)
//
// ===========================================================================
// 1. 何が問題だったか(R1-A08 / R1-C02 / R1-D06)
// ===========================================================================
//   GDD 6.1 の 14 種のうち 4 種(寝床/保管庫/見張り台/療養所)は
//   `content/facility.json` の `slots` が全 Lv 0(= 就労スロットが無い)。
//   これらは③施設詳細で「産出0.00/tick・研究点」「就労0/0」と、あたかも
//   「本来は機能するが今は空き」であるかのように表示され、しかも有効な
//   「Lv2へ増築」ボタンで資源を払える(=資源トラップ)。
//
// ===========================================================================
// 2. 3種はそれぞれ違う扱いが要る(裁定記録・2026-08-02統率者検分で確定)
// ===========================================================================
//   **寝床**: `content/facility.json` の `bed` が `bedCapacityCurve` を持ち、
//   これは `schema/engineContent.ts` → `FacilityDef.bedCapacityByLevel` →
//   engine の `rules/population.ts` の
//   `bedCapacityOf`/`populationFloorOf`/晴天漂着判定(同ファイル §2)まで実際に
//   結線されている(確認済み・寝床上限が実際に人口下限と漂着加入の上限を
//   動かす)。「就労0/0」ではなく実効果(寝床上限 +N)を見せる。
//
//   **保管庫(warehouse)**: 当初「効果は未実装」表示で実装したが、統率者検分で
//   差し戻し(2026-08-02)。`storageCapacityCurve` が
//   `schema/engineContent.ts` の `toFacilityStorage` → `FacilityDef.storage` →
//   engine の `rules/storage.ts` の `resolveCapacityByResourceId`(125〜135行)
//   まで実際に結線されており、`storedResourceIds` が content に無い(= null)
//   ため **全資源**が対象になる(warehouse を 1 基建てるだけで全資源に Lv別の
//   保管上限(Lv1=400)が設定される)。上限は産出反映時に効き
//   (`rules/production.ts` 425行)、超過分は overflow 会計(廃材化/破棄)へ回る
//   ——既存在庫の没収ではないが、現行バランス(資源が数十万〜百万規模まで
//   伸びる)では実質「全資源の産出を上限で頭打ちにする」強い・プレイヤーに
//   とってほぼ確実に不利益な効果になる。**したがって「効果は未実装」は虚偽**
//   であり、実効果(保管上限の設定 + 超過分喪失の警告)を正直に見せる。
//   数値(400 が適正か・`storedResourceIds` を絞るべきか)はバランス調整であり
//   M39 の担当(本タスクでは content/engine に一切触れない)。
//
//   **見張り台/療養所**: `content/facility.json` にこの種の追加フィールドが
//   一切無く、engine 側の参照も確認できなかった(統率者側でも再確認済み)。
//   「効果は未実装(建設しても資源を消費するのみ)」のまま。
//
// ===========================================================================
// 3. [M62/FC9・R2-C01] カタログ効果ヒントの非対称の解消
// ===========================================================================
//   R2-C01: `GridScreen.tsx` の建設前ヒント(`effectHintByDefId`)は寝床/保管庫/
//   非稼働(見張り台・療養所)の 3 kind にしか文言を出さず、通常稼働(worker)系
//   施設だけヒントが無い非対称があった。`workerEffectHintText` は Lv1 時点の
//   基礎産出(隣接乗数・稼働就労者数を含まない近似値。カタログは建設前で盤面
//   位置が未定のため)を示す、対称な第4のヒント文言。
// ---------------------------------------------------------------------------

import type { FacilityDef } from "../../engine/rules/types";
import { toApproxNumber } from "../../engine/fp";
import type { EntityId } from "../../engine/state/state";
import { resourceLabel } from "./contentLabels";
import { formatRatePerMinute, formatResourceAmount } from "./format";

export type FacilityEffectKind = "worker" | "bedCapacity" | "storageCapacity" | "none";

function hasAnyWorkerSlot(def: FacilityDef): boolean {
  return (def.workerSlotsByLevel ?? []).some((count) => count > 0);
}

/**
 * 施設が「就労で稼働する」「寝床上限を持つ」「保管上限を持つ」
 * 「どれでもない(未実装)」のどれかを判定する(§2)。カタログ(建設前・Lv情報
 * なし)と詳細(建設後)のどちらからも呼べるよう、`FacilityDef` だけを見る
 * (state に依存しない)。
 */
export function facilityEffectKind(def: FacilityDef): FacilityEffectKind {
  if (hasAnyWorkerSlot(def)) return "worker";
  if (def.bedCapacityByLevel !== undefined) return "bedCapacity";
  if (def.storage !== undefined) return "storageCapacity";
  return "none";
}

/** `level`(1始まり)時点の寝床上限(`bedCapacityByLevel` が無ければ null)。 */
export function bedCapacityAt(def: FacilityDef, level: number): number | null {
  const curve = def.bedCapacityByLevel;
  if (curve === undefined || curve.length === 0) return null;
  return curve[level - 1] ?? curve[curve.length - 1] ?? null;
}

/** 寝床のカタログ/詳細向け効果文言(Lv省略時はLv1として見せる)。 */
export function bedCapacityEffectText(def: FacilityDef, level = 1): string | null {
  const value = bedCapacityAt(def, level);
  if (value === null) return null;
  return `寝床上限 +${String(value)}(住民の漂着加入の上限を増やす)`;
}

/** `level`(1始まり)時点の保管上限(近似値。`storage` が無ければ null)。 */
export function storageCapacityAt(def: FacilityDef, level: number): number | null {
  const curve = def.storage?.capacityByLevel;
  if (curve === undefined || curve.length === 0) return null;
  const fix = curve[level - 1] ?? curve[curve.length - 1];
  return fix === undefined ? null : toApproxNumber(fix);
}

/** 保管上限の対象資源(`storedResourceIds` が無ければ全資源=null)。 */
export function storageTargetResourceIds(def: FacilityDef): readonly EntityId[] | null {
  return def.storage?.resourceIds ?? null;
}

/**
 * 保管庫のカタログ/詳細向け効果文言(§2「保管庫」)。「効果は未実装」ではなく
 * 実効果を正直に見せる——上限設定そのものと、超過分が失われる(オーバー
 * フロー会計・GDD 6.7)ことの両方を明記する。
 */
export function storageCapacityEffectText(def: FacilityDef, level = 1): string | null {
  const value = storageCapacityAt(def, level);
  if (value === null) return null;
  const scope = storageTargetResourceIds(def) === null ? "全資源" : "対象資源";
  return `${scope}の保管上限を設定(Lv${String(level)}: ${formatResourceAmount(value)})。上限を超えた分の産出は失われます。`;
}

/**
 * 現在の在庫が保管上限を上回っている資源が1つでもあるか(建設/増築で新たに
 * 産出が頭打ちになる資源が出る、という不利益にプレイヤーが気づけるように
 * するための警告条件)。`resources` は `resourceId`/`stockApprox` を持つ
 * 軽量な形(`derived.ts` の `ResourceView` と構造的に互換)だけを要求する。
 */
export function storageCapacityWouldCapExistingStock(
  def: FacilityDef,
  level: number,
  resources: readonly { readonly resourceId: EntityId; readonly stockApprox: number }[],
): boolean {
  const cap = storageCapacityAt(def, level);
  if (cap === null) return false;
  const targets = storageTargetResourceIds(def);
  for (const resource of resources) {
    if (targets !== null && !targets.includes(resource.resourceId)) continue;
    if (resource.stockApprox > cap) return true;
  }
  return false;
}

/** 上の警告条件が真のときに添える一言。 */
export const STORAGE_CAPACITY_EXCEEDED_WARNING_TEXT =
  "現在の所持量が上限を大きく超えているため、建てると一部資源の産出が頭打ちになります。";

/** 効果未実装の施設に添える固定文言(見張り台/療養所のみ・§2)。 */
export const DORMANT_FACILITY_EFFECT_TEXT = "効果は未実装(建設しても資源を消費するのみ)";

/**
 * [M62/FC9・R2-C01] `level`(1始まり)時点の基礎産出(`outputPerTickByLevel` の
 * その段。隣接乗数・稼働就労者数は含まない近似値・`bedCapacityAt` と同じ
 * 「配列より大きい Lv は最後の段」規約)。基礎産出を持たない(=配列が空の
 * 縮約 `FacilityDef`)場合は null。
 */
export function workerBaseOutputAt(def: FacilityDef, level: number): number | null {
  const curve = def.outputPerTickByLevel;
  if (curve.length === 0) return null;
  const fix = curve[level - 1] ?? curve[curve.length - 1];
  return fix === undefined ? null : toApproxNumber(fix);
}

/**
 * worker系(通常稼働)施設のカタログ/詳細向け効果ヒント(§3)。寝床/保管庫/
 * 非稼働(§2)と対称に、建設前でも「何を産出するか」の目安を示す。
 *
 * 基礎産出が 0(=このタグでは実質稼働しない縮約施設等)なら null(捏造しない・
 * `nextLevelOutputApproxOf` の「基礎産出0は出さない」判断と同じ立場)。
 */
export function workerEffectHintText(def: FacilityDef, level = 1): string | null {
  const value = workerBaseOutputAt(def, level);
  if (value === null || value === 0) return null;
  const target = def.output.kind === "resource" ? resourceLabel(def.output.resourceId) : "研究点";
  return `Lv${String(level)}基礎産出 ${formatRatePerMinute(value)}${target}(就労者が必要・隣接ボーナスで変動)`;
}
