// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- レンダリング済みログ文字列の表示時ID変換(M61/FC4)
//
// ===========================================================================
// 1. なぜ「保存前変換」ではなく「表示時変換」か(方式選定・裁定台帳との差異)
// ===========================================================================
//   帰還ログ本文(`state.renderedLogs` の各 `text`)は GDD 12.5-7 により
//   「派遣確定時にレンダリング済みにした完成文字列を保存する(再参照禁止)」
//   仕様であり、`rules/exploration.ts` の `renderReturnLog`/`renderLogTemplate`
//   が **engine 内で** event ID(`destinationId`)・資源 ID(`rewardResourceId`)
//   を文字列へ直接埋め込む(例:「近郊探索「eventNearAshOrchard」より…」
//   「報酬 firewood 5850」)。engine 自体は無変更(タスクの絶対制約)なので、
//   この埋め込みは変えられない。
//
//   台帳v12の元指示は「保存前に変換」だったが、それは実装不可能な方式変更を
//   伴う(engine 側で日本語変換を行うには contentLabels.ts を engine から
//   参照させる必要があり、architecture.md §1 の依存規則(engine は誰も
//   import しない/DOM・contentの日本語化はUI層の責務)に反する)。
//
//   **本タスクでは「表示時変換」を採用する**(方式変更・要報告)。ここに置く
//   `labelizeLogText` は帰還ログ文字列を**表示直前**に和名へ置換する UI 層の
//   純関数であり、`state` 自体は 1 バイトも変更しない。この方式の利点:
//     - **既存セーブの過去ログも直る**(保存前変換だと、この変更より前に
//       確定した帰還ログは永久に内部ID表示のまま=事後修正不能)。
//     - engine 無変更(タスクの絶対制約)を厳密に守れる。
//   欠点(正直な開示): ログ文字列を毎回スキャンする軽いコストが掛かるが、
//   50件上限(`MAX_RENDERED_LOGS`)+ 短文なのでコストは無視できる。
//
// ===========================================================================
// 2. トークン化の安全性
// ===========================================================================
//   ID の命名規則は ADR-011(`ENTITY_ID_PATTERN = /^[a-z][a-zA-Z0-9_]*$/`)で
//   固定されている。日本語の地の文はこの文字集合(ラテン文字・数字・
//   アンダースコア)を一切含まないため、`ID_TOKEN_PATTERN` でラテン文字列の
//   連続部分だけを拾っても和文を誤って書き換えることは無い
//   (`content/event.json` の logTemplate 全件を確認済み・stray な英単語なし)。
//
//   拾った各トークンは event → resource → facility → tech の順で
//   `contentLabels.ts` の各 Label 関数へ通し、**値が変わった最初の結果**を
//   採用する(いずれも未登録 ID は raw をそのまま返す既存の「捏造しない」
//   契約があるため、この「変わったら採用」判定が安全に成立する)。4 種の ID
//   語彙は接頭辞/具体的な語がそれぞれ排他的なので衝突は起きない
//   (event*/tech* の接頭辞、facility/resource は固定の短い列挙)。
//
//   住民 ID はこのパイプラインでは意図的に扱わない——帰還ログ本文の
//   `LOG_TEMPLATE_PLACEHOLDERS`(`rules/event.ts`)に住民 ID を差し込む語彙が
//   無く(band/event/node/members/teamPower/difficulty/roll/injuryCount の
//   8種のみ)、`renderReturnLog` の外側テンプレも件数(`{rescuedCount}名を
//   保護`等)しか埋め込まない(確認済み)。住民 ID を露出する経路は
//   ChronicleScreen.tsx の memoir 表示だけで、そちらは既に `residentDisplayName`
//   を直接通している(§3 参照)。
// ---------------------------------------------------------------------------

import { entityIdFromString } from "../../engine/state/state";
import { eventLabel, facilityLabel, resourceLabel, techLabel } from "./contentLabels";

/** ADR-011 の ID 規則に一致するラテン文字列だけを拾う(§2)。 */
const ID_TOKEN_PATTERN = /[a-z][a-zA-Z0-9_]*/g;

/** `expedition/destinationOptions.ts` の `proceduralDestinationId` が作る
 * 手続き生成フォールバック ID の接尾辞。`ExpeditionScreen.tsx` の
 * `destinationDisplayName` と同じ判別・同じ文言(捏造した固有名詞を出さない)。 */
const PROCEDURAL_DESTINATION_SUFFIX = "Procedural";
const PROCEDURAL_DESTINATION_LABEL = "この距離帯のどこか";

/**
 * 帰還ログ本文(`RenderedLogEntry.text`)の表示時ID変換(§1)。
 *
 * 既知の event/資源/施設/tech ID を和名へ、手続き生成の目的地IDを
 * 「この距離帯のどこか」へ置換する。未登録の ID はそのまま残す(捏造しない・
 * `contentLabels.ts` と同じ方針)。`content` を引数に取らない(和名テーブルは
 * 全て静的な ID→日本語の対応であり、content インスタンスに依存しないため)。
 */
export function labelizeLogText(text: string): string {
  return text.replace(ID_TOKEN_PATTERN, (token) => {
    if (token.endsWith(PROCEDURAL_DESTINATION_SUFFIX)) return PROCEDURAL_DESTINATION_LABEL;
    const id = entityIdFromString(token);
    const event = eventLabel(id);
    if (event !== token) return event;
    const resource = resourceLabel(id);
    if (resource !== token) return resource;
    const facility = facilityLabel(id);
    if (facility !== token) return facility;
    const tech = techLabel(id);
    if (tech !== token) return tech;
    return token;
  });
}
