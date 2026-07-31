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

import type { DistanceBand } from "../../engine/rules/types";
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
  // [M32] GDD 9.2「タイプ別供給(鉱山＝鉄/石炭、農園＝穀物、林＝薪/繊維)」の
  // 農園が産出する資源(`content/outpostType.json` の `outpostFarm.resource`)。
  grain: "穀物",
};

/**
 * [M32] 衛星拠点タイプ(GDD 9.2「[2026-07-31裁定] MVP の拠点タイプは
 * 鉱山(iron)/農園(grain)/林(firewood) の3種」)。`content/outpostType.json` の
 * ID(outpostMine/outpostFarm/outpostForest)と GDD が直接使う日本語名の対応
 * であり、facility と違い ID の literal 直訳ではなく GDD 本文の用語をそのまま
 * 採る(捏造ではなく出典つきの対応)。
 */
const OUTPOST_TYPE_LABELS: { readonly [key: string]: string } = {
  outpostMine: "鉱山",
  outpostFarm: "農園",
  outpostForest: "林",
};

/**
 * [M32] 距離帯(裁定 B7「近郊 = near / 遠隔 = far / 深部 = deep」)。engine の
 * 定数(`rules/exploration.ts` の `BAND_LABEL`)と同じ対応を UI 側にも 1 つ
 * 持つ(⑦⑧⑨の 3 画面が共有するため contentLabels.ts へ集約)。
 */
const DISTANCE_BAND_LABELS: { readonly [K in DistanceBand]: string } = {
  near: "近郊",
  far: "遠隔",
  deep: "深部",
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

/**
 * [M31] tech(`content/tech.json` の 24 本)の日本語名。
 *
 * 出典は 2 種混在(facility と同じ「捏造しないための出典」規律): GDD 5.2 の
 * 表が代表テック/壁テックとして直接名指ししている 18 本は**その名前をそのまま**
 * 使う(コメントに "GDD5.2" と明記)。表に無い残り 6 本(横展開の葉テック:
 * techBasketWeaving/techIrrigation/techMetalCasting/techLens、および壁テック
 * 自体では無いが同名で言及される techPottery/techStorage の内訳)は facility の
 * hearth→かまど と同じ「ID の literal 直訳」(コメントに "直訳" と明記)。
 * GDD 5.1 の gate 対応は `content/balance.json` の `eras[].gateTechId` で確認済み
 * (e1=techStorage / e2=techSmelting / e3=techSteamEngine)。
 */
const TECH_LABELS: { readonly [key: string]: string } = {
  // E1(GDD5.2: 代表「火起こし/石器/水汲み/採集小屋/簡易寝床」・壁「土器と貯蔵」)
  techFireStarting: "火起こし", // GDD5.2
  techStoneTools: "石器", // GDD5.2
  techWaterDrawing: "水汲み", // GDD5.2
  techGatheringHut: "採集小屋", // GDD5.2
  techBedding: "簡易寝床", // GDD5.2
  techPottery: "土器", // GDD5.2(壁テック「土器と貯蔵」の前段)
  techStorage: "貯蔵", // GDD5.2(壁テック「土器と貯蔵」・era e1 の gateTechId)
  techBasketWeaving: "編みかご", // 直訳(GDD5.2に名指し無し・recipeBasket由来)
  // E2(GDD5.2: 代表「炭焼き窯/農耕/製陶/骨皮加工/基礎医術」・壁「製錬(銅→青銅)」)
  techCharcoalKiln: "炭焼き窯", // GDD5.2
  techAgriculture: "農耕", // GDD5.2
  techCeramics: "製陶", // GDD5.2
  techBoneHideWorking: "骨皮加工", // GDD5.2
  techBasicMedicine: "基礎医術", // GDD5.2
  techSmelting: "製錬", // GDD5.2(era e2 の gateTechId)
  techIrrigation: "灌漑", // 直訳(GDD5.2に名指し無し・recipeChannelDitch由来)
  // E3(GDD5.2: 代表「高炉/鍛冶/機械部品/水車動力/ガラス/簡易印刷」・壁「蒸気機関」)
  techBlastFurnace: "高炉", // GDD5.2
  techBlacksmithing: "鍛冶", // GDD5.2
  techMachineParts: "機械部品", // GDD5.2
  techWaterWheel: "水車動力", // GDD5.2
  techGlass: "ガラス", // GDD5.2
  techPrinting: "簡易印刷", // GDD5.2
  techSteamEngine: "蒸気機関", // GDD5.2(era e3 の gateTechId)
  techMetalCasting: "鋳造", // 直訳(GDD5.2に名指し無し・recipeCastMold由来)
  techLens: "研磨レンズ", // 直訳(GDD5.2に名指し無し・recipeGroundLens由来。lossClass=rareIrreversible)
};

/** [M31] エラ(`content/balance.json` の `eras[].id`)の日本語名(GDD 5.2 の表そのまま)。 */
const ERA_LABELS: { readonly [key: string]: string } = {
  e1: "灰の時代",
  e2: "窯と畑の時代",
  e3: "鉄と歯車の時代",
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

/** [M31] 未登録の tech ID は raw ID をそのまま返す(facility/resource/trait と同じ方針)。 */
export function techLabel(techId: EntityId): string {
  return labelOf(TECH_LABELS, techId);
}

/** [M31] `eraId` が null/未登録なら raw ID(または "?")をそのまま返す。 */
export function eraLabel(eraId: string | null): string {
  if (eraId === null) return "?";
  return ERA_LABELS[eraId] ?? eraId;
}

/** [M32] outpostType ID → 日本語名(GDD 9.2 の用語)。 */
export function outpostTypeLabel(outpostTypeId: EntityId): string {
  return labelOf(OUTPOST_TYPE_LABELS, outpostTypeId);
}

/** [M32] 距離帯 → 日本語名(裁定 B7)。全件を必ず埋める(型で強制)。 */
export function distanceBandLabel(band: DistanceBand): string {
  return DISTANCE_BAND_LABELS[band];
}
