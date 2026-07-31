// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑧冒険記ビューア(M32)— GDD 7.3 / 8.4 / 12.5-9
//
// ===========================================================================
// 1. このファイルがやること
// ===========================================================================
//   帰還ログ(GDD 8.4・レンダリング済み文字列・50件上限+畳んだ件数)の一覧・
//   時系列表示と、住民 memoir(GDD 7.3・加入/死亡/絆節目/保護 等)の一覧。
//   **engine の既存データを読むだけ**(新規計算なし・タスク指示どおり)。
//
// ===========================================================================
// 2. memoir の文言はこの画面が持つ(ReturnDigest.tsx と同じ作法)
// ===========================================================================
//   `state.ts` の doc が明記するとおり、memoirLog は「テンプレ ID + 決定論
//   パラメータ」だけを持ち実際の文言(日本語プロース)は持たない。本画面は
//   その最小限の事実(誰が・いつ・何が起きたか)だけを組み立てる —— 出自/
//   口癖/恐れの**具体的な内容**(GDD 7.3 の flavor text)は content/UI 層が
//   別途持つ設計であり、ここでは「候補の何番目が選ばれたか」という決定論
//   パラメータ以上のことを捏造しない。
// ---------------------------------------------------------------------------

import type { MemoirEntry } from "../../../engine/state/state";
import type { MemoirFeedEntry } from "../../derived";
import { distanceBandLabel, residentDisplayName } from "../contentLabels";
import { formatGameClock } from "../format";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./chronicleScreen.css";

// --- 1. memoir の文言(hooks 不使用・直接テスト可能) -------------------------

/**
 * memoir 1 件の事実だけの文言(§2)。網羅 switch で全種別を強制する
 * (derived.ts の homeBadges と同じ「未知 kind は例外」規律)。
 * [束B/B-3] 住民 ID(partnerId/rescuedId)は `residentDisplayName` を通す。
 */
export function memoirEntryText(entry: MemoirEntry): string {
  switch (entry.kind) {
    case "arrival":
      return "加入した。";
    case "death":
      return "亡くなった。";
    case "bondMilestone":
      return `${residentDisplayName(entry.partnerId)} との絆が深まった(節目${String(entry.tier)})。`;
    case "partnerLost":
      return `絆を結んでいた ${residentDisplayName(entry.partnerId)} を喪った。`;
    case "explorationRescue":
      return `${distanceBandLabel(entry.band)}探索で ${residentDisplayName(entry.rescuedId)} を保護した。`;
    case "bioCatchphrase":
      return `口癖が記録された(候補#${String(entry.variantIndex)})。`;
    case "bioFear":
      return `恐れが記録された(候補#${String(entry.variantIndex)})。`;
    case "bioOrigin":
      return `出自が記録された(候補#${String(entry.variantIndex)})。`;
    default: {
      const unhandled: never = entry;
      throw new TypeError(`未知の memoir kind ${JSON.stringify(unhandled)}`);
    }
  }
}

export interface MemoirRowProps {
  readonly feedEntry: MemoirFeedEntry;
}

export function MemoirRow({ feedEntry }: MemoirRowProps) {
  return (
    <li class="kf-chronicle__memoir-row">
      <span class="kf-chronicle__memoir-tick">{formatGameClock(feedEntry.entry.tick)}</span>
      <span class="kf-chronicle__memoir-subject">{residentDisplayName(feedEntry.residentId)}</span>
      <span class="kf-chronicle__memoir-text">{memoirEntryText(feedEntry.entry)}</span>
    </li>
  );
}

// --- 2. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function ChronicleScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "chronicle", { activate: false });

  const renderedLog = useSignalValue(store.derived.renderedLog);
  const memoirFeed = useSignalValue(store.derived.memoirFeed);

  return (
    <section class="kf-chronicle-screen" aria-labelledby="kf-chronicle-screen-title">
      <h2 class="kf-chronicle-screen__title" id="kf-chronicle-screen-title">
        冒険記ビューア
      </h2>
      <p class="kf-screen-intro">
        探索の帰還記録と、住民一人ひとりに起きた出来事を時系列で振り返ります。
      </p>

      <h3 class="kf-chronicle-screen__subtitle">帰還ログ(時系列・上限50件)</h3>
      {renderedLog.entries.length === 0 ? (
        <p class="kf-chronicle-screen__empty">帰還ログはまだありません。</p>
      ) : (
        <ul class="kf-chronicle__log-list">
          {renderedLog.entries.map((entry) => (
            <li class="kf-chronicle__log-row" key={`${String(entry.tick)}:${entry.text}`}>
              <span class="kf-chronicle__log-tick">{formatGameClock(entry.tick)}</span>
              <span class="kf-chronicle__log-text">{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
      {renderedLog.foldedCount > 0 && (
        <p class="kf-chronicle__folded">
          古い帰還記録 {renderedLog.foldedCount} 件は要約に畳まれています(上限50件)。
        </p>
      )}

      <h3 class="kf-chronicle-screen__subtitle">住民の歩み</h3>
      {memoirFeed.length === 0 ? (
        <p class="kf-chronicle-screen__empty">記録はまだありません。</p>
      ) : (
        <ul class="kf-chronicle__memoir-list">
          {memoirFeed.map((feedEntry, index) => (
            <MemoirRow
              key={`${String(feedEntry.entry.tick)}:${String(index)}`}
              feedEntry={feedEntry}
            />
          ))}
        </ul>
      )}

      <div class="kf-chronicle-screen__nav">
        <button
          type="button"
          class="kf-chronicle-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          ④住民一覧へ
        </button>
      </div>
    </section>
  );
}
