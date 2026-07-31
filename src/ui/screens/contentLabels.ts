// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- content ID → 日本語表示名(M30)
//
// content(facility/trait/resource の各 ID)は英字 ID のみを正本として持ち、
// 表示用の日本語名を持たない(schema/facility.ts・schema/trait.ts のいずれにも
// `label`/`ja` 相当のフィールドが無い——確認済み)。②③④画面はどれもこの表示名を
// 必要とするので、ここへ 1 箇所へ集約する。
//
// ===========================================================================
// 対応の根拠(捏造しないための出典)
// ===========================================================================
//   - facility: 現行 content(`content/facility.json`)は 3 種(hearth/forge/
//     workbench)のみ実装済み(M5 の申し送り「施設14種contentは未実施」)。
//     GDD 6.1 の 14 種のどれに対応するかの正式な対応表は無いため、**ID の
//     literal 直訳**(hearth=かまど/forge=鍛冶場/workbench=作業台)に留める。
//   - resource: GDD 6.7 / 9.1 / 11.1 に出てくる資源名(薪/鉄/粘土/紙/廃材)を
//     そのまま英字 ID(firewood/iron/clay/paper/waste)へ対応させる。
//   - trait: GDD 7.2「学者/職人/探索者/記憶巧者(生きた書庫)/病弱/楽観/悲観/
//     怪力」の 8 種と content の trait ID(traitScholar 等)は 1:1 対応する
//     (ID が英訳そのものなので取り違えない)。
//
// **未登録の ID はテーブルへ追記するまで raw ID をそのまま表示する**
// (存在しない情報を捏造しない・PlaceholderScreen.tsx と同じ方針)。
// ---------------------------------------------------------------------------

import type { EntityId } from "../../engine/state/state";

const FACILITY_LABELS: { readonly [key: string]: string } = {
  hearth: "かまど",
  forge: "鍛冶場",
  workbench: "作業台",
};

const RESOURCE_LABELS: { readonly [key: string]: string } = {
  firewood: "薪",
  iron: "鉄",
  clay: "粘土",
  paper: "紙",
  waste: "廃材",
};

/** GDD 7.2 の 8 種(裁定どおりの日本語名)。 */
const TRAIT_LABELS: { readonly [key: string]: string } = {
  traitScholar: "学者",
  traitFrail: "病弱",
  traitArtisan: "職人",
  traitExplorer: "探索者",
  traitMemoryKeeper: "記憶巧者",
  traitOptimist: "楽観",
  traitPessimist: "悲観",
  traitStrongArm: "怪力",
};

function labelOf(table: { readonly [key: string]: string }, entityId: EntityId): string {
  return table[entityId] ?? entityId;
}

export function facilityLabel(defId: EntityId): string {
  return labelOf(FACILITY_LABELS, defId);
}

export function resourceLabel(resourceId: EntityId): string {
  return labelOf(RESOURCE_LABELS, resourceId);
}

export function traitLabel(traitId: EntityId): string {
  return labelOf(TRAIT_LABELS, traitId);
}
