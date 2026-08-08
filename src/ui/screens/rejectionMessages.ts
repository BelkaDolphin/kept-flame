// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- コマンド拒否のプレイヤー語化(束B/B-1・最重要)
//
// ===========================================================================
// 1. なぜこのファイルが要るか
// ===========================================================================
//   `src/engine/commands.ts` の `CommandRejection.message` は**人間向けだが
//   開発者向け**の文言である(commands.ts §2 の doc が明記:「分岐に使わない
//   こと」)。実際に「資源 "firewood" が不足(必要 30000000 / 在庫 0)」のように
//   1e6 固定小数点の生値や英字 ID をそのまま含む。
//
//   本ファイルは `rejection.code`(機械可読・commands.ts の
//   `COMMAND_REJECTION_CODES`)を鍵に、プレイヤー向けの日本語文へ変換する層。
//   **engine 側の `message` 文字列は 1 文字も変更しない**(このファイルは
//   `rejection` を読むだけで、commands.ts には触れていない)。
//
// ===========================================================================
// 2. 数値・ID の変換方針
// ===========================================================================
//   - `requiredRaw`/`availableRaw`(Fix の raw = 1e6 スケール整数)は
//     `fixFromRaw` → `toApproxNumber` → `formatResourceAmount` の順に通す
//     (他画面の資源表示と同じ経路。UI 側で独自の割り算をしない)。
//   - `resourceId` は `contentLabels.ts` の `resourceLabel` で和名化する。
//   - 住民 ID は `residentDisplayName`、tech ID は `techLabel` を通す。
//   - research entity ID(`research_<techId>`)・codify record ID
//     (`<techId>RecordStone`/`<techId>RecordPaper`)は、ID そのものへ埋め込まれた
//     techId を取り出して `techLabel` へ渡す(捏造ではなく、UI 自身が発行した
//     ID 規則を逆算しているだけ——`ResearchScreen.tsx` の `researchEntityIdFor`、
//     `engine/assist/codify.ts` の `codifyRecordId` と同じ規則)。規則に合わない
//     ID は素直に諦めて汎用文へ倒す(存在しない情報を捏造しない)。
//
// ===========================================================================
// 3. 網羅性(★重要)
// ===========================================================================
//   `MESSAGE_BUILDERS` は `{ readonly [K in CommandRejectionCode]: ... }` 型で
//   宣言してあるため、commands.ts が新しい code を足すと**このファイルが
//   コンパイルエラーになる**(埋め忘れを型で防ぐ・他の `contentLabels.ts` の
//   網羅テーブルと同じ作法)。`tests/ui/screens/rejectionMessages.test.ts` は
//   `COMMAND_REJECTION_CODES`(commands.ts の正本配列)と本ファイルのキー集合を
//   突き合わせる網羅性テストを持つ。
//
//   `playerRejectionMessage` の**実行時**の参照は緩く型付けしてあり
//   (`Record<string, …|undefined>` 経由)、万一 `rejection.code` が
//   `COMMAND_REJECTION_CODES` に無い文字列だった場合(型システムをすり抜けた
//   異常系)は `rejection.message`(元の engine 文言)へフォールバックする
//   (タスク指示「未知codeは従来どおりmessage表示にフォールバック」)。
// ---------------------------------------------------------------------------

import type { CommandRejection, CommandRejectionCode } from "../../engine/commands";
import { fixFromRaw, toApproxNumber } from "../../engine/fp";
import type { RecordMedium } from "../../engine/rules/types";
import { entityIdFromString, type EntityId } from "../../engine/state/state";
import { mediumLabel, residentDisplayName, resourceLabel, techLabel } from "./contentLabels";
import { formatResourceAmount, formatResourceStock } from "./format";

// --- 1. 数値・ID の小さな変換ヘルパ(§2) ------------------------------------

/** `requiredRaw`(必要量)を表示用の量へ。コストなので端数も正直に出す。 */
function amountText(raw: number | null): string {
  if (raw === null) return "0";
  return formatResourceAmount(toApproxNumber(fixFromRaw(raw)));
}

/**
 * [M63/R4-A12 系] `availableRaw`(所持量)を表示用の量へ。
 *
 * HUD の資源チップ(`formatResourceStock`・整数切り捨て+3桁区切り)と表記が
 * 揃っていなかった——同じ在庫がホームでは整数、reject 文言では小数
 * (「所持20.1」)という二重基準になっていた(R4-A12/A13/D03)。在庫は
 * `formatResourceStock` へ統一する(コスト表示=`amountText` とは意図的に
 * 異なるヘルパにする。format.ts の「在庫は floor・コスト/レートは実額」の
 * 使い分けをここでも保つ)。
 */
function stockText(raw: number | null): string {
  if (raw === null) return "0";
  return formatResourceStock(toApproxNumber(fixFromRaw(raw)));
}

function resourceName(resourceId: EntityId | null): string {
  return resourceId === null ? "資源" : resourceLabel(resourceId);
}

function residentName(subjectId: EntityId | null): string {
  return subjectId === null ? "その住民" : residentDisplayName(subjectId);
}

const RESEARCH_ENTITY_ID_PREFIX = "research_";
const CODIFY_RECORD_SUFFIX: { readonly [K in RecordMedium]: string } = {
  stoneTablet: "RecordStone",
  paper: "RecordPaper",
};

/**
 * research entity ID(`research_<techId>`・`ResearchScreen.tsx` の
 * `researchEntityIdFor` が発行する規則)から techId を取り出す。合わなければ
 * null(捏造しない)。
 */
function techIdFromResearchEntityId(entityId: EntityId | null): EntityId | null {
  if (entityId === null) return null;
  const raw: string = entityId;
  if (!raw.startsWith(RESEARCH_ENTITY_ID_PREFIX)) return null;
  const rest = raw.slice(RESEARCH_ENTITY_ID_PREFIX.length);
  return rest.length === 0 ? null : entityIdFromString(rest);
}

/**
 * codify record ID(`<techId>RecordStone`/`<techId>RecordPaper`・
 * `engine/assist/codify.ts` の `codifyRecordId` が発行する規則)から
 * techId + 媒体を取り出す。合わなければ null(捏造しない)。
 */
function techAndMediumFromCodifyRecordId(
  entityId: EntityId | null,
): { readonly techId: EntityId; readonly medium: RecordMedium } | null {
  if (entityId === null) return null;
  const raw: string = entityId;
  for (const medium of ["stoneTablet", "paper"] as const) {
    const suffix = CODIFY_RECORD_SUFFIX[medium];
    if (!raw.endsWith(suffix)) continue;
    const techId = raw.slice(0, raw.length - suffix.length);
    return techId.length === 0 ? null : { techId: entityIdFromString(techId), medium };
  }
  return null;
}

/** research/codify のどちらの ID 規則にも合わないときの汎用フォールバック名。 */
function techNameOrFallback(techId: EntityId | null): string {
  return techId === null ? "その技術" : `「${techLabel(techId)}」`;
}

// --- 2. code → 文言(§3・全 32 種を網羅) ------------------------------------

type MessageBuilder = (rejection: CommandRejection) => string;

const MESSAGE_BUILDERS: { readonly [K in CommandRejectionCode]: MessageBuilder } = {
  invalidArgument: (r) => {
    if (r.limit !== null && r.actual !== null) {
      return `入力内容が条件に合いません(上限 ${String(r.limit)} に対し ${String(r.actual)})。`;
    }
    if (r.subjectId !== null) {
      return `入力内容に問題があります(対象: ${r.subjectId})。`;
    }
    return "入力内容に問題があります。もう一度選び直してください。";
  },
  notImplemented: () => "この機能は今後のアップデートで対応予定です。",
  entityNotFound: () =>
    "対象が見つかりませんでした(表示が古くなっている可能性があります。画面を開き直してください)。",
  // [M62/FC5b・R2-A05] 「内部の識別子が重複しています」は開発者向けの誤診断
  // 文言だった——CodifyScreen.tsx が同一 tech+媒体には常に同じ ID
  // (`codifyRecordId`)を発行するため、同一技術の二重投入は実質ここ
  // (`entityIdInUse`)で reject される(`duplicateRecord` の重複チェックへは
  // 到達しない・commands.ts の `applyBeginCodification` 参照)。プレイヤーが
  // 実際に踏むのは「もうキューにある/もう研究中」という状況であり、ID の
  // 衝突という実装詳細ではない。§2 のデコーダ(codify/research の ID 規則の
  // 逆算)を entityIdInUse へも適用し、合わない場合だけ汎用文へ倒す
  // (捏造しない・duplicateRecord/researchAlreadyCompleted と同じ立場)。
  entityIdInUse: (r) => {
    const codifyFound = techAndMediumFromCodifyRecordId(r.subjectId);
    if (codifyFound !== null) {
      return `${techNameOrFallback(codifyFound.techId)}の記録(${mediumLabel(codifyFound.medium)})は既にキューにあります。`;
    }
    const researchTechId = techIdFromResearchEntityId(r.subjectId);
    if (researchTechId !== null) {
      return `${techNameOrFallback(researchTechId)}は既に研究中か解禁済みです。`;
    }
    return "この操作は既に行われています。もう一度操作をやり直してください。";
  },
  unknownContentDef: () => "指定された定義が見つかりません(データの不整合の可能性があります)。",
  contentUnsupported: () => "この機能は現在のデータでは使えません(必要な設定が不足しています)。",
  cellOutOfRange: () => "セルの指定が盤面の範囲外です。",
  footprintOutOfGrid: () => "この位置には施設が収まりません(盤面の外へはみ出します)。",
  cellOccupied: () => "そのマスには既に施設が建っています。",
  cellIsRubble: () => "そのマスはまだ瓦礫です。先に開墾してください。",
  cellNotRubble: () => "そのマスは既に開墾済みです。開墾の必要はありません。",
  levelAtMax: (r) =>
    r.actual !== null && r.limit !== null
      ? `この施設は既に Lv${String(r.actual)} です(上限 Lv${String(r.limit)})。`
      : "この施設は既に上限レベルです。",
  facilitySlotsFull: (r) =>
    r.limit !== null && r.actual !== null
      ? `この施設の就労枠は ${String(r.limit)} 人までです(現在 ${String(r.actual)} 人)。`
      : "この施設の就労枠はいっぱいです。",
  dispatchSlotsFull: (r) =>
    r.limit !== null && r.actual !== null
      ? `同時に派遣できる隊は ${String(r.limit)} 隊までです(現在 ${String(r.actual)} 隊)。`
      : "これ以上同時に派遣できません。",
  // [M61/FC5・R1-A10] 「寿命モデル未設定」は稀な内部状態(engine
  // テストフィクスチャ等の異常系)で、プレイヤーには何を指すか伝わらない。
  // 実プレイで起こり得る理由だけを挙げ、それ以外の内部的な理由は「等の理由」で
  // 正直に一括りにする(捏造しない・実装詳細をそのまま列挙しない)。
  // [R8-01] 「衛星拠点に常駐中」を理由に加えた。拠点常駐者の派遣 / 就労は
  // 評価Round 8(2026-08-06 実測)まで素通りして進行不能ソフトロックになって
  // おり、その修正でこの code が返る**実プレイで最も踏みやすい**経路になった。
  // 「死亡・探索派遣中」だけを挙げていると、常駐者を選んだプレイヤーには次の
  // 一手(駐在の解除)が分からない。
  residentUnavailable: (r) =>
    `${residentName(r.subjectId)}は今この操作を行えません(死亡・探索派遣中・衛星拠点に常駐中等の理由)。` +
    "衛星拠点に常駐している場合は、衛星拠点管理の画面で駐在を解除してからやり直してください。",
  alreadyAssigned: (r) => `${residentName(r.subjectId)}は既にこの施設で就労しています。`,
  notAssigned: (r) => `${residentName(r.subjectId)}はどの施設にも就労していません。`,
  duplicateRecord: (r) => {
    const found = techAndMediumFromCodifyRecordId(r.subjectId);
    if (found === null) return "同じ技術・同じ媒体の記録は既にあります。";
    return `${techNameOrFallback(found.techId)}の記録(${mediumLabel(found.medium)})は既にあります。`;
  },
  insufficientResource: (r) =>
    `${resourceName(r.resourceId)}が足りません(必要 ${amountText(r.requiredRaw)} / 所持 ${stockText(r.availableRaw)})。`,
  noResearchTarget: () => "研究中の技術がありません。廃材はここでは使えません。",
  exodusCapacityExceeded: () =>
    "持ち出せる量を超えています。プレビューで何が積みきれないか確認してください。",
  // [M76/台帳v25必-4] `exodusNoCrew` は乗員 0 の拒否(`limit`/`actual` 無し)と
  // M75 の最少乗員ガード(`limit` = content の `exodus.minCrew`・`actual` =
  // 選抜人数)の**2 通りの reject を共有する**(commands.ts §4b の doc「新しい
  // code を足すと網羅テーブルまで波及する」)。旧文言は常に「1 人以上必要」と
  // 言っていたが、M75 の最少乗員が 1 を超える content では**虚偽**になる
  // (実際は N 人未満で reject される)。`limit`/`actual` が揃っているときは
  // それを使った「最少N人」表示へ切り替える——N をこのファイルにハードコード
  // しない(content の値が rejection 経由で届いたものをそのまま使う)。
  exodusNoCrew: (r) =>
    r.limit !== null && r.actual !== null
      ? `大移動には乗員が最少 ${String(r.limit)} 名必要です(選抜 ${String(r.actual)} 名)。`
      : "大移動には同行する住民が 1 人以上必要です。",
  dispatchInProgress: (r) =>
    r.actual !== null
      ? `未帰還の探索が ${String(r.actual)} 件あるあいだは大移動できません。`
      : "未帰還の探索があるあいだは大移動できません。",
  inheritTierAtMax: (r) =>
    r.limit !== null
      ? `この系統は既に上限(段${String(r.limit)})に達しています。`
      : "この系統は既に上限に達しています。",
  insufficientInheritPoints: (r) =>
    r.limit !== null && r.actual !== null
      ? `継承点が足りません(必要 ${String(r.limit)} 点 / 残高 ${String(r.actual)} 点)。`
      : "継承点が足りません。",
  researchAlreadyCompleted: (r) =>
    `${techNameOrFallback(techIdFromResearchEntityId(r.subjectId))}は既に解禁済みです。研究の必要はありません。`,
  researchIrreversiblyLost: (r) =>
    `${techNameOrFallback(techIdFromResearchEntityId(r.subjectId))}は取り返しのつかない喪失で永久に失われました。この周回では再研究できません。`,
  prereqNotMet: (r) => `前提の技術 ${techNameOrFallback(r.subjectId)} がまだ解禁されていません。`,
  codifyAlreadyCompleted: (r) => {
    const found = techAndMediumFromCodifyRecordId(r.subjectId);
    if (found === null) return "この記録は既に完成しているので取り消せません。";
    return `${techNameOrFallback(found.techId)}の記録(${mediumLabel(found.medium)})は既に完成しているので取り消せません。`;
  },
  outpostSlotsFull: (r) =>
    r.limit !== null && r.actual !== null
      ? `この拠点の常駐枠は ${String(r.limit)} 人までです(現在 ${String(r.actual)} 人)。`
      : "この拠点の常駐枠はいっぱいです。",
  outpostWouldBeEmpty: (r) =>
    r.limit !== null
      ? `常駐は最低 ${String(r.limit)} 人必要です。全員解除したい場合は拠点そのものを放棄してください。`
      : "常駐者を 0 人にはできません。全員解除したい場合は拠点そのものを放棄してください。",
  notStationed: (r) => `${residentName(r.subjectId)}はどの衛星拠点にも駐在していません。`,
  alreadyStationed: (r) => `${residentName(r.subjectId)}は既にこの拠点に駐在しています。`,
};

/**
 * `rejection.code` をプレイヤー向けの日本語文へ変換する(§1)。
 *
 * `MESSAGE_BUILDERS` の索引はあえて緩い型(`Record<string, …|undefined>`)を
 * 経由する(§3)——万一 `rejection.code` が型の想定外の文字列であっても
 * (実行時の異常系)ここで例外にせず、`rejection.message`(engine の原文)へ
 * フォールバックする。
 */
export function playerRejectionMessage(rejection: CommandRejection): string {
  const table = MESSAGE_BUILDERS as Record<string, MessageBuilder | undefined>;
  const build = table[rejection.code];
  return build !== undefined ? build(rejection) : rejection.message;
}

/**
 * `tests/ui/screens/rejectionMessages.test.ts` の網羅性テストが読む、
 * このファイルが実際にカバーしている code の集合(commands.ts の
 * `COMMAND_REJECTION_CODES` と突き合わせる)。
 */
export const REJECTION_MESSAGE_CODES: readonly CommandRejectionCode[] = Object.keys(
  MESSAGE_BUILDERS,
) as readonly CommandRejectionCode[];
