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
//   - facility: `content/facility.json` は GDD 6.1 の 14 種(かまど/貯水槽/
//     菜園/寝床/作業台/炭焼き窯/製錬炉/鍛冶場/研究机/写字室/保管庫/見張り台/
//     探索本部/療養所)が出揃った(M58)。既存3種(hearth/forge/workbench)は
//     **ID の literal 直訳**(hearth=かまど/forge=鍛冶場/workbench=作業台)の
//     まま変更していない。[M58] 追加の 11 種は GDD 6.1 の名称と 1:1 対応する
//     (ID は英字での役割直訳・命名根拠は content/facility.json 追加時の設計
//     報告を参照: waterTank=貯水槽/kitchenGarden=菜園/charcoalKiln=炭焼き窯/
//     foundry=製錬炉/researchDesk=研究机/scriptorium=写字室/bed=寝床/
//     warehouse=保管庫/watchtower=見張り台/explorationHq=探索本部/
//     infirmary=療養所。foundry/waterTank/kitchenGarden は conformance の
//     fixture facility "smelter"/"cistern" や #12 計測サンプルの
//     "garden"/"reservoir" と ID が衝突するため素直な直訳から変えている)。
//   - resource: GDD 6.7 / 9.1 / 11.1 に出てくる資源名(薪/鉄/粘土/紙/廃材)を
//     そのまま英字 ID(firewood/iron/clay/paper/waste)へ対応させる。
//     [M58] 追加の charcoal(木炭・炭焼き窯の産出)/copper(銅・製錬炉(foundry)の
//     産出。GDD 5.2「製錬(銅→青銅)」に根拠)も同じ直訳方針。
//   - trait: GDD 7.2「学者/職人/探索者/記憶巧者(生きた書庫)/病弱/楽観/悲観/
//     怪力」の 8 種と content の trait ID(traitScholar 等)は 1:1 対応する
//     (ID が英訳そのものなので取り違えない)。
//
// **未登録の ID はテーブルへ追記するまで raw ID をそのまま表示する**
// (存在しない情報を捏造しない・PlaceholderScreen.tsx と同じ方針)。
// ---------------------------------------------------------------------------

import type { DistanceBand, RecordMedium } from "../../engine/rules/types";
import type { EntityId, InheritTrack } from "../../engine/state/state";

const FACILITY_LABELS: { readonly [key: string]: string } = {
  hearth: "かまど",
  forge: "鍛冶場",
  workbench: "作業台",
  // [M58] GDD 6.1 の残り 11 種(additive・設計根拠は content/facility.json 参照)。
  waterTank: "貯水槽",
  kitchenGarden: "菜園",
  bed: "寝床",
  charcoalKiln: "炭焼き窯",
  foundry: "製錬炉",
  researchDesk: "研究机",
  scriptorium: "写字室",
  warehouse: "保管庫",
  watchtower: "見張り台",
  explorationHq: "探索本部",
  infirmary: "療養所",
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
  // [M58] 新設施設(炭焼き窯/製錬炉)の産出資源。
  charcoal: "木炭",
  copper: "銅",
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

/**
 * [M61/FC5] 衛星拠点IDの表示専用整形(R1-A17「農園(outpostFarm1)」の
 * outpostId 生露出への対応)。`outposts/outpostId.ts` の `nextOutpostId` が
 * 発行する ID は `<outpostTypeId><連番>`(接頭辞の再プレフィックスをしない
 * 命名規約・同ファイルの doc)なので、`outpostTypeId` を先頭から取り除いた
 * 残りが連番になる。取り除けない(規則に合わない)場合は raw ID をそのまま
 * 残す(捏造しない・contentLabels.ts 全体の方針)。
 */
export function outpostDisplayLabel(outpostId: EntityId, outpostTypeId: EntityId): string {
  const raw: string = outpostId;
  const typeRaw: string = outpostTypeId;
  if (!raw.startsWith(typeRaw)) return `${outpostTypeLabel(outpostTypeId)}(${raw})`;
  const sequence = raw.slice(typeRaw.length);
  if (sequence.length === 0 || !/^\d+$/.test(sequence)) {
    return `${outpostTypeLabel(outpostTypeId)}(${raw})`;
  }
  return `${outpostTypeLabel(outpostTypeId)} ${sequence}号`;
}

/**
 * [M33] 継承系統(`INHERIT_TRACKS`・GDD 10.3)の日本語名。全件を必ず埋める
 * (型で強制)。engine 側の英字 ID(`caravanCapacity`/`crewCapacity`/
 * `startingStock`)と GDD 10.2/10.3 の用語(キャラバン容量/乗員定員/開始備蓄)の対応。
 */
const INHERIT_TRACK_LABELS: { readonly [K in InheritTrack]: string } = {
  caravanCapacity: "キャラバン容量",
  crewCapacity: "乗員定員",
  startingStock: "開始備蓄",
};

/** [M33] 継承系統 → 日本語名。 */
export function inheritTrackLabel(track: InheritTrack): string {
  return INHERIT_TRACK_LABELS[track];
}

/**
 * [束B/B-6] 記録媒体(`RecordMedium`)の日本語名。
 *
 * 元々 CodifyScreen.tsx/MigrationScreen.tsx がそれぞれ独立に持っていた同名関数
 * (7 行の軽い重複)を、束B でここへ集約した。両画面は re-export するだけにして
 * 既存のテスト import 経路(`from ".../CodifyScreen"` 等)を壊さない。
 */
export function mediumLabel(medium: RecordMedium): string {
  switch (medium) {
    case "stoneTablet":
      return "石板";
    case "paper":
      return "紙";
    default: {
      const unhandled: never = medium;
      throw new TypeError(`未知の記録媒体 ${JSON.stringify(unhandled)}`);
    }
  }
}

// ===========================================================================
// [束B/B-3] event ID → 日本語名
// ===========================================================================
//
// content/event.json の 10 件は id/destTags/nodes のみを持ち、和名フィールドは
// 無い(確認済み)。GDD 側にも対応表が無いため、**id の destTags(近郊/遠隔/深部)
// と本文中の choices.label / branches.logTemplate の情景描写から意味の通る
// 和名を起こした**(捏造ではなく、content 内の実テキストを出典とする命名)。
// 出典になった代表的な文言をコメントに残す。
//
// event.json に将来 `name` 相当のフィールドが追加された場合は、そちらを正とし
// このテーブルは上書きされる想定(content ローダーには触れないという束B の
// 制約により、本タスクでは content 側を変更していない)。
//
// 未登録の event ID は raw ID をそのまま返す(facility/resource 等と同じ方針)。

const EVENT_LABELS: { readonly [key: string]: string } = {
  // 近郊(near)
  eventNearRubbleSweep: "瓦礫原の捜索", // 「瓦礫原の奥へ進んだ」
  eventNearAshOrchard: "灰かぶりの果樹園", // 「灰をかぶった獣の群れ」「果樹園跡」
  eventNearDrainageTunnel: "埋もれた排水路", // 「半ば埋もれた排水路」
  // 遠隔(far)
  eventFarSignalRuins: "信号塔の廃墟", // 「傾いた鉄塔」「廃墟の中腹」
  eventFarSaltMarsh: "塩沼の渡渉路", // 「塩沼に潜む影」「渡渉路の先」
  eventFarWindworksMill: "軋む風車小屋", // 「軋む風車の羽根」「製粉機の銘板」
  // 深部(deep)
  eventDeepEmberVault: "燠火の地下庫", // 「燠火の熱気渦巻く坑道」
  eventDeepSunkenArchive: "水没した書庫", // 「水没した書架」「書庫の奥」
  eventDeepFrostboundMine: "氷結坑道", // 「凍てついた坑道」「氷結した奥室」
  eventDeepAshenSpire: "灰塵の尖塔", // 「降り積もる灰塵」「尖塔の中腹」
};

/** [束B/B-3] event ID → 日本語名(未登録は raw ID)。 */
export function eventLabel(eventId: EntityId): string {
  return labelOf(EVENT_LABELS, eventId);
}

// ===========================================================================
// [束B/B-3・M61/FC4で拡張] 住民の内部ID → 表示専用の整形名
// ===========================================================================
//
// `ResidentState` に name 系フィールドは無い(state.ts で確認済み)。正式な
// 名前生成は M53 が並行実装中であり、本タスクは state 構造に触れず**表示層
// だけ**を整える(タスク指示どおり)。
//
// 現行の開始住民 ID は `src/newGame.ts` の命名規則「"res" + 名前(小文字ローマ字。
// 例 "reshazu" = "res" + "hazu")」に従う。この規則にちょうど合う ID だけ
// prefix を外して先頭を大文字化する。
//
// [M61/FC4] プレイテスト R1-A06 が機械生成 ID の生露出(例
// "DispatchNear1Rescue0n2")を指摘した。該当する 2 形——
//   - 晴天漂着: `residentDrift<tick>`(`rules/population.ts` の
//     `ARRIVAL_RESIDENT_ID_PREFIX`)
//   - 探索保護: `<dispatchId>Rescue<dispatchTick>n<nodeIndex>`
//     (`rules/exploration.ts` の `rescueResidentIdOf`。dispatchId 自体は
//     `dispatch<Band大文字化><連番>`・`expedition/dispatchId.ts` の
//     `nextDispatchId`)
// ——は、固定音節表からの決定論的 pure 関数(`syntheticResidentName`)で
// 読みやすい名を生成する(同一IDは常に同一名・Math.random/Date.now不使用)。
// この 2 形に合わない ID(上記の "res..." 規則にも合わない、テストフィクスチャ
// 等の任意 ID)は従来どおり先頭大文字化のみに留める——存在しない情報を捏造
// しない(未登録 ID を raw のまま返す既存方針と同じ姿勢。過剰に「それらしい
// 名前」を当てはめない対象を機械生成 ID の既知 2 形だけに絞る★判断)。

const STARTING_RESIDENT_ID_PATTERN = /^res[a-z]+$/;

/** `rules/population.ts` の `ARRIVAL_RESIDENT_ID_PREFIX` と同じ規則(値の複製は
 * せず形だけを見る——engine 定数を re-export すると engine→ui 依存の向きが
 * 増えるため、ここでは正規表現でパターンだけ照合する)。 */
const DRIFT_RESIDENT_ID_PATTERN = /^residentDrift\d+$/;
/** `rules/exploration.ts` の `rescueResidentIdOf` + `expedition/dispatchId.ts`
 * の `nextDispatchId` が組み立てる ID の形。 */
const RESCUE_RESIDENT_ID_PATTERN = /^dispatch[A-Za-z]+\d+Rescue\d+n\d+$/;

function isMachineGeneratedResidentId(raw: string): boolean {
  return DRIFT_RESIDENT_ID_PATTERN.test(raw) || RESCUE_RESIDENT_ID_PATTERN.test(raw);
}

/**
 * [M61/FC4] 読みやすい表示名の材料になる固定音節表(ローマ字・和風の響き。
 * 既存の開始住民名 Hazu/Kaya/Mio/Rui/Seri/Tou と語感を揃える)。
 */
// prettier-ignore
const NAME_SYLLABLES: readonly string[] = [
  "ka", "ki", "ku", "ke", "ko",
  "sa", "shi", "su", "se", "so",
  "ta", "chi", "tsu", "te", "to",
  "na", "ni", "nu", "ne", "no",
  "ha", "hi", "fu", "he", "ho",
  "ma", "mi", "mu", "me", "mo",
  "ya", "yu", "yo",
  "ra", "ri", "ru", "re", "ro",
  "wa", "zu",
];

/**
 * FNV-1a 32bit 相当のハッシュ(決定論・純関数)。UI 表示専用のヘルパであり
 * engine の PRNG(xoshiro128**)を再利用する対象ではない——ここに要るのは
 * 「同じ文字列は常に同じ数値」という一様分布未満の弱い性質だけで、ゲーム内の
 * 抽選(GDD 11.5 等)には一切使わない(engine の決定論規則=CLAUDE.md 絶対
 * ルールは `src/engine` 配下限定であり、このファイルは対象外)。
 */
function hashStringToUint32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 機械生成 ID から決定論的に音節 2〜3 個の名前を合成する(同一IDは常に同一名)。 */
function syntheticResidentName(rawId: string): string {
  const hash = hashStringToUint32(rawId);
  const syllableCount = 2 + (hash % 2);
  const parts: string[] = [];
  let cursor = hash;
  for (let i = 0; i < syllableCount; i++) {
    const index = cursor % NAME_SYLLABLES.length;
    parts.push(NAME_SYLLABLES[index] as string);
    // 次の音節は桁をずらした値から選ぶ(同じ音節の連打を避ける・依然として
    // rawId のみから決まる決定論的な導出)。
    cursor = Math.floor(cursor / NAME_SYLLABLES.length) + hash * (i + 1);
    cursor = cursor >>> 0;
  }
  const raw = parts.join("");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** [束B/B-3・M61/FC4] 住民 ID の表示専用整形(名前の正式生成は M53)。 */
export function residentDisplayName(residentId: EntityId): string {
  const raw: string = residentId;
  if (STARTING_RESIDENT_ID_PATTERN.test(raw)) {
    const body = raw.slice(3);
    return body.length === 0 ? raw : body.charAt(0).toUpperCase() + body.slice(1);
  }
  if (isMachineGeneratedResidentId(raw)) return syntheticResidentName(raw);
  if (raw.length === 0) return raw;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
