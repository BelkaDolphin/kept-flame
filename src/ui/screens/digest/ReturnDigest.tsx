// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑫帰還ダイジェスト(復帰専用・M29)— GDD 4.2 / 6.6 / 8.4
//
// ===========================================================================
// 1. 3 段構成(GDD 4.2 が形まで決めている)
// ===========================================================================
//   「復帰専用**『帰還ダイジェスト画面』**を情報アーキテクチャに独立追加。
//     復帰時に必ず最初に表示。**ネガティブ先頭単独表示 → ダイジェスト →
//     ドリルダウン**の3段。」
//
//   1 段目: いちばん重い悪い知らせを**1 件だけ**単独で出す(並べない)。
//   2 段目: 不在中に起きたことの要約行(件数)。
//   3 段目: 各行がそのまま担当画面へのワンタップ遷移になっている。
//
// ===========================================================================
// 2. engine の既存データを読むだけ(新しい engine 計算を足さない)
// ===========================================================================
//   表示モデルは `src/ui/derived.ts` §6 の `buildReturnDigest`(純関数)が作る。
//   この画面は「呼んで並べる」だけであり、tick を進めることも、engine の
//   ルール関数を呼ぶこともしない。
//
//   ネタバレ防止のため、**未帰還の派遣スナップショットから結果を読まない**
//   (派遣確定時に脱落者まで確定している = GDD 12.5-7)。詳細は derived.ts §6(b)。
//
// ===========================================================================
// 3. 「不在中」の起点
// ===========================================================================
//   `bootTick`(起動直後・catch-up 前の tick)をシェルから受け取る。engine の
//   state には「最後に見た tick」が無く、足すと engine 変更になるため
//   (docs/design/ui-spec.md §4)。
// ---------------------------------------------------------------------------

import { useMemo } from "preact/hooks";

import { buildReturnDigest, type DigestLeadKind, type DigestRowId } from "../../derived";
import { formatGameClock, formatTickSpan } from "../format";
import { labelizeLogText } from "../idLabelize";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import type { ScreenProps } from "../screenProps";

// --- 1. 文言テーブル(判定・集計は derived.ts) ------------------------------

export interface DigestLeadText {
  readonly mark: string;
  readonly title: string;
  readonly body: string;
  /** ドリルダウンのボタン文言。 */
  readonly action: string;
}

/** 1 段目の文言。`DigestLeadKind` の全件を必ず埋める(型で強制)。 */
export const DIGEST_LEAD_TEXT: { readonly [K in DigestLeadKind]: DigestLeadText } = {
  rareTechLost: {
    mark: "✕",
    title: "取り返しのつかない技術が失われました",
    body: "書き残す前に、その技術を知る最後の一人が居なくなりました。この技術は再研究できません。",
    action: "研究ツリーで確認する",
  },
  residentDeath: {
    mark: "✕",
    title: "住民が亡くなりました",
    body: "その人が抱えていた未成文の技術は、いま誰が持っているかを確かめてください。",
    action: "住民一覧で確認する",
  },
  recoverableTechLost: {
    mark: "△",
    title: "技術が失われました(再研究できます)",
    body: "保持者と記録がどちらも無くなりましたが、研究しなおせば取り戻せます。",
    action: "研究ツリーで確認する",
  },
  partnerLost: {
    mark: "△",
    title: "絆を結んでいた相手を喪いました",
    body: "残された側の士気が下がっています。",
    action: "冒険記で読む",
  },
  none: {
    mark: "○",
    title: "悪い知らせはありません",
    body: "失われたものはありませんでした。",
    action: "ホームハブへ",
  },
};

export interface DigestRowText {
  readonly mark: string;
  readonly label: string;
  readonly unit: string;
}

/** 2 段目の行文言。`DigestRowId` の全件を必ず埋める(型で強制)。 */
export const DIGEST_ROW_TEXT: { readonly [K in DigestRowId]: DigestRowText } = {
  residentDeaths: { mark: "✕", label: "亡くなった住民", unit: "人" },
  techLosses: { mark: "✕", label: "失われた技術", unit: "件" },
  returnLogs: { mark: "▸", label: "探索隊の帰還記録", unit: "件" },
  rescues: { mark: "＋", label: "保護して迎え入れた人", unit: "人" },
  arrivals: { mark: "＋", label: "新しく加わった人", unit: "人" },
  bondMilestones: { mark: "▸", label: "絆が深まった記録", unit: "件" },
  expeditionsInFlight: { mark: "▸", label: "まだ帰っていない隊", unit: "隊" },
  overcrowdedFacilities: { mark: "△", label: "過密で出力が落ちている施設", unit: "基" },
};

// --- 2. 画面本体 -------------------------------------------------------------

export function ReturnDigest({ store, onNavigate, bootTick }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事(M18★5)。
  useScreenMount(store, "digest", { activate: false });

  // ⑫は `gridSummary`(48セル依存の全体集計)を読んでよい数少ない画面である
  // (derived.ts §1(b) の用途制限がまさに「②の凡例/総数と⑫帰還ダイジェスト」)。
  const gridSummary = useSignalValue(store.derived.gridSummary);
  const tick = useSignalValue(store.derived.tick);

  const digest = useMemo(
    // `tick` は依存配列のためだけに読む(state の参照は peek で取る)。
    () => buildReturnDigest(store.peekState(), { sinceTick: bootTick, gridSummary }),
    [store, bootTick, gridSummary, tick],
  );

  const lead = DIGEST_LEAD_TEXT[digest.lead.kind];

  return (
    <section class="kf-digest" aria-labelledby="kf-digest-lead-title">
      <div
        class={`kf-digest__lead${digest.lead.kind === "none" ? " kf-digest__lead--none" : ""}`}
        data-lead-kind={digest.lead.kind}
      >
        <h2 class="kf-digest__lead-title" id="kf-digest-lead-title">
          <span class="kf-digest__lead-mark" aria-hidden="true">
            {lead.mark}
          </span>
          {lead.title}
          {digest.lead.count > 1 ? `(${String(digest.lead.count)}件)` : ""}
        </h2>
        <p class="kf-digest__lead-body">{lead.body}</p>
        <button
          type="button"
          class="kf-placeholder__back"
          onClick={() => onNavigate(digest.lead.screen)}
        >
          {lead.action}
        </button>
      </div>

      {/* [M61/FC11・R1-A24] 「不在のあいだ」は連続プレイ中(特にテストプレイ加速中)に
          ⑫を開くと実態と異なる(離席していないのに「不在」と言われる)。
          離席を主張しない「経過」表現へ言い換える(オフライン復帰・連続プレイの
          どちらでも文として成立する)。 */}
      <p class="kf-digest__meta">
        前回の確認から {formatTickSpan(digest.elapsedTicks)} が経過しました(
        {formatGameClock(digest.sinceTick)} → {formatGameClock(digest.nowTick)})。
      </p>

      {digest.rows.length === 0 ? (
        <p class="kf-home__calm">報告することはありません。</p>
      ) : (
        <ul class="kf-digest__rows">
          {digest.rows.map((row) => {
            const text = DIGEST_ROW_TEXT[row.id];
            return (
              <li key={row.id}>
                <button
                  type="button"
                  class={`kf-digest__row${row.negative ? " kf-digest__row--negative" : ""}`}
                  data-row-id={row.id}
                  data-target-screen={row.screen}
                  onClick={() => onNavigate(row.screen)}
                >
                  <span class="kf-digest__row-mark" aria-hidden="true">
                    {text.mark}
                  </span>
                  <span class="kf-digest__row-text">{text.label}</span>
                  <span class="kf-digest__row-count">
                    {row.count}
                    {text.unit}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {digest.logEntries.length > 0 && (
        <ul class="kf-digest__logs">
          {digest.logEntries.map((entry) => (
            <li class="kf-digest__log" key={`${String(entry.tick)}:${entry.text}`}>
              <span class="kf-digest__log-tick">{formatGameClock(entry.tick)}</span>
              {/* [M61/FC4] ChronicleScreen.tsx と同じ表示時ID変換。 */}
              {labelizeLogText(entry.text)}
            </li>
          ))}
        </ul>
      )}

      {digest.foldedLogCount > 0 && (
        <p class="kf-digest__folded">
          古い帰還記録 {digest.foldedLogCount} 件は要約に畳まれています(上限50件)。
        </p>
      )}
    </section>
  );
}
