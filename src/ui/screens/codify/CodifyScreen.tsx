// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑥成文化キュー(M31)— GDD 4.1(b) / 7.4 / 7.5 / 11.1追補 / 2.1
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   `store.derived.codifyTechs`(解禁済み tech の一覧・derived.ts §7)を並べ、
//   保持者数(唯一保持の強調)・残存想定tick(GDD 7.5)・想起リスク・記録済み
//   媒体・作業中の記録を表示する。媒体トグル(石板/紙)付きで
//   `beginCodification` を発行し(ロードマップ M31 行 [2026-07-27追補]
//   「⑥成文化キューの媒体トグル」)、おまかせ成文化(`engine/assist/codify.ts`)
//   の提案 → 確認 → 適用も持つ(ui-spec ⑥「おまかせ成文化の提案」)。
//
// ===========================================================================
// 2. 二重の正直な開示(derived.ts §7-1 と同じ内容をここにも明記)
// ===========================================================================
//   [2026-08-01 M50 で両方実装] (a) 成文化の tick 結線は M50 が実装した
//       (`PIPELINE_STAGE.codify` 段50・レート=研究点産出施設の稼働就労者)。
//       投入した記録は時間経過で完了する。(b) 取消コマンド
//       `cancelCodification`(返金なし)も M50 で新設済み。
//   [2026-08-01 M54 で解消] 本画面の取消ボタンを接続した(作業中の記録のみ
//       対象・完成済みは `codifyAlreadyCompleted` で reject)。**返金は一切
//       無い**ことを取消ボタンの近くと成功トーストの両方に明記し、正直に
//       開示する(`beginCodification` が着手時に資源を全額支払う契約・M50 の
//       ★報告どおり)。
//
// ===========================================================================
// 3. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   「キューに入れる」ボタンは在庫やコストを先読みせず常に活性。結果は
//   engine の `duplicateRecord`/`insufficientResource` 等の reject に委ねる。
// ---------------------------------------------------------------------------

import { useEffect, useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import { codifyRecordId } from "../../../engine/assist/codify";
import { toApproxNumber } from "../../../engine/fp";
import {
  assistPreferredMedium,
  isPrintingUnlocked,
  planCodification,
} from "../../../engine/rules/codify";
import type { RecordMedium } from "../../../engine/rules/types";
import type { EntityId } from "../../../engine/state/state";
import type {
  CodifySuggestionExclusionView,
  CodifySuggestionView,
  CodifyTechEntry,
} from "../../derived";
import { mediumLabel, resourceLabel, techLabel } from "../contentLabels";
import { formatResourceAmount, formatTickSpan } from "../format";
import { LossClassBadge } from "../LossClassBadge";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import {
  resourceSpendBreakdownPhrase,
  resourceStockFix,
  useToastStack,
  ToastStackView,
} from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./codifyScreen.css";

// --- 1. 表示文言(判定は derived.ts・ここは文言だけ) -------------------------

/**
 * [束B] `mediumLabel` は contentLabels.ts へ集約した(MigrationScreen.tsx と
 * 同じ定義を 2 箇所で持たないため)。この re-export は既存テストの
 * `import { mediumLabel } from "...CodifyScreen"` を壊さないためだけにある。
 */
export { mediumLabel };

// --- 2. 1 行(hooks 不使用・直接テスト可能) ----------------------------------

export interface CodifyTechRowProps {
  readonly entry: CodifyTechEntry;
  readonly selectedMedium: RecordMedium;
  readonly onMediumChange: (techId: EntityId, medium: RecordMedium) => void;
  readonly onEnqueue: (techId: EntityId, medium: RecordMedium) => void;
  /**
   * [M54] 作業中の記録(`entry.pendingRecords`)の取消。省略時は取消ボタンを
   * 描かない(既存テストの呼び出し互換・タスク指示の対象=進行中の記録のみ)。
   */
  readonly onCancel?: (codifyId: EntityId) => void;
  /**
   * [M61/FC11・R1-A15] 選択中媒体(`selectedMedium`)の必要資源(キューに入れる
   * 前のプレビュー)。`null` = 出さない(content に recordMedia が無い等)。
   * 在庫が足りるかどうかの判定はしない(表示のみ・engine の
   * `insufficientResource` reject に委ねる方針は維持)。
   */
  readonly costPreview?: { readonly resourceId: EntityId; readonly amountApprox: number } | null;
  /**
   * [M71/R6-C02] `costPreview` の資源が現在の在庫で足りないか。省略時は false
   * (既存呼び出し/既存テストとの後方互換)。**ボタンを disabled にはしない**
   * ——architecture.md §6-7「置けるか/払えるかは engine の reject に委ねる」を
   * この画面でも守る(§3 冒頭のコメントと同じ規律・格子カタログの
   * `FacilityCatalogButton`/`isCatalogEntryInsufficient` と同じ「色+▲記号は
   * 出すがクリックは常に通す」形)。それでも「事前に▲/理由表示が無く reject
   * 頼みになっている」という R6-C02 の指摘には、この視覚マーカーで応える。
   */
  readonly insufficient?: boolean;
}

export function CodifyTechRow({
  entry,
  selectedMedium,
  onMediumChange,
  onEnqueue,
  onCancel,
  costPreview = null,
  insufficient = false,
}: CodifyTechRowProps) {
  function handleMediumChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as RecordMedium;
    onMediumChange(entry.techId, value);
  }

  // [M71/R6-C03] 選択中の媒体が既に「作業中」(この tech の pendingRecords に
  // 同じ medium がある)なら、投入すると engine が確実に duplicateRecord で
  // reject する(commands.ts の applyBeginCodification・「同一媒体の重複は
  // 作らない」)。作業中一覧のすぐ下に同じフォームが生きたまま並んでいると
  // 「進行中なのに再投入できる」ように見える(R6-C03)ため、この場合だけ投入
  // フォーム(コストプレビュー+ボタン)を畳んで案内文へ差し替える——媒体
  // セレクタ自体は残す(石板が作業中でも紙側は新規に投入できるため。GDD 11.1
  // 追補「媒体別の並存は可」)。
  const selectedMediumInProgress = entry.pendingRecords.some(
    (record) => record.medium === selectedMedium,
  );

  return (
    <li class="kf-codify-row" data-tech-id={entry.techId}>
      <div class="kf-codify-row__head">
        <span class="kf-codify-row__name">{techLabel(entry.techId)}</span>
        <LossClassBadge lossClass={entry.lossClass} />
      </div>

      <p class="kf-codify-row__holders">
        保持者 {entry.holderIds.length}人{entry.uniqueHolder ? "(唯一保持)" : ""}
      </p>

      {/* [M73/R8-11] **記録済みの行では残存想定/想起リスクを「守られている」文脈へ
          畳む**。以前は未記録の行と同じ形でこの2値が残っていたため、成文化して
          守られたことが表示から読み取れなかった(残存想定は「保持者を失うまでの
          猶予」・想起リスクは「思い出せなくなる確率」であり、記録が1枚でもあれば
          技術そのものは失われない=rules/codify.ts の isCodified が喪失判定を
          止める)。数値そのものは畳んだ中に残す(情報は減らさない)。 */}
      {entry.isCodified ? (
        <>
          <p class="kf-codify-row__recorded kf-codify-row__recorded--safe">
            記録済み({entry.recordedMedia.map((medium) => mediumLabel(medium)).join("・")})
            ——保持者を失ってもこの技術は残ります。
          </p>
          {entry.holderIds.length > 0 && (
            <details class="kf-codify-row__risk-fold">
              <summary class="kf-codify-row__risk-summary">保持者の状態(参考)</summary>
              <p class="kf-codify-row__risk">
                残存想定: {entry.hasDeadline ? `約${formatTickSpan(entry.residualTick)}` : "無期限"}
                {entry.maxRecallRiskPercentApprox !== null &&
                  `・想起リスク約${entry.maxRecallRiskPercentApprox.toFixed(1)}%/日`}
                (記録があるため、これらは技術の喪失には繋がりません)
              </p>
            </details>
          )}
        </>
      ) : (
        <>
          {entry.holderIds.length > 0 && (
            <p class="kf-codify-row__risk">
              {/* [M61/FC5⑤] 生tick("約127830tick")を formatTickSpan へ。
                  「寿命モデル未設定」は実装用語のため落とす("無期限"はそのまま残す)。 */}
              残存想定: {entry.hasDeadline ? `約${formatTickSpan(entry.residualTick)}` : "無期限"}
              {entry.maxRecallRiskPercentApprox !== null &&
                `・想起リスク約${entry.maxRecallRiskPercentApprox.toFixed(1)}%/日`}
            </p>
          )}
          <p class="kf-codify-row__recorded">未記録</p>
        </>
      )}

      {entry.pendingRecords.length > 0 && (
        <ul class="kf-codify-row__pending">
          {entry.pendingRecords.map((record) => (
            <li key={record.entityId}>
              {/* [M70/R5-A12] 素の toFixed(1) を整形ヘルパへ(研究側は
                  formatResourceAmount で整数値の末尾 ".0" を出さないのに対し、
                  ここだけ常に小数第1位を出す非対称=「進行度 18.0/720.0」が
                  残っていた。他箇所(必要資源等)と同じ formatResourceAmount へ
                  統一する)。 */}
              作業中: {mediumLabel(record.medium)}(進行度{" "}
              {formatResourceAmount(record.progressApprox)}/
              {formatResourceAmount(record.requiredWorkApprox)})
              {onCancel !== undefined && (
                <button
                  type="button"
                  class="kf-codify-row__cancel-button"
                  onClick={() => onCancel(record.entityId)}
                >
                  取消(返金なし)
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <label class="kf-codify-row__medium">
        媒体
        <select
          class="kf-codify-row__medium-select"
          value={selectedMedium}
          onChange={handleMediumChange}
        >
          <option value="stoneTablet">石板</option>
          <option value="paper">紙</option>
        </select>
      </label>
      {/* [M71/R6-C03] 選択中媒体が作業中なら、投入フォームの代わりに案内文を
          出す(engine が確実に reject するフォームを生かしたままにしない)。 */}
      {selectedMediumInProgress ? (
        <p class="kf-codify-row__medium-in-progress" role="note">
          選択中の媒体({mediumLabel(selectedMedium)}
          )は既に作業中です。完了または取消をお待ちください (別の媒体を選べば新しく投入できます)。
        </p>
      ) : (
        <>
          {costPreview !== null && (
            <p
              class={
                insufficient
                  ? "kf-codify-row__cost-preview kf-codify-row__cost-preview--insufficient"
                  : "kf-codify-row__cost-preview"
              }
            >
              {/* [M63/R4-A12/A13] 素の toFixed(1) を整形ヘルパへ(「成文化予告20.0」の
                  不揃い解消)。[M71/R6-C02] 在庫不足は格子カタログと同じ「▲」記号で
                  事前に示す(判定・disabled 化はしない・§ 直前の doc 参照)。 */}
              {insufficient ? "▲ " : ""}
              必要資源: {resourceLabel(costPreview.resourceId)}{" "}
              {formatResourceAmount(costPreview.amountApprox)}
            </p>
          )}
          <button
            type="button"
            class={
              insufficient
                ? "kf-codify-row__enqueue-button kf-codify-row__enqueue-button--insufficient"
                : "kf-codify-row__enqueue-button"
            }
            onClick={() => onEnqueue(entry.techId, selectedMedium)}
          >
            キューに入れる
          </button>
        </>
      )}
    </li>
  );
}

// --- 3. おまかせ成文化の提案パネル(hooks 不使用) ----------------------------

export interface CodifySuggestionRowProps {
  readonly suggestion: CodifySuggestionView;
}

/**
 * [M61/FC11・R1-A21] 手書きの連番("{order}. ")を削除した——描画先が `<ol>`
 * (`CodifySuggestionPanel` の `kf-codify-assist__list`)なのでブラウザが既に
 * マーカー番号を出しており、二重表示("1. 1. 土器…")になっていた。
 * [M61/FC5⑤] 所要/累積/残存の生 tick 表示("所要720tick")を
 * `formatTickSpan`(「12時間」等)へ。
 */
export function CodifySuggestionRow({ suggestion }: CodifySuggestionRowProps) {
  return (
    <li class="kf-codify-assist__row" data-tech-id={suggestion.techId}>
      {techLabel(suggestion.techId)}({mediumLabel(suggestion.medium)})・所要
      {formatTickSpan(suggestion.durationTicks)}・累積{formatTickSpan(suggestion.cumulativeTicks)}・
      {suggestion.hasDeadline ? `残存約${formatTickSpan(suggestion.residualTick)}` : "無期限"}・
      {suggestion.onSchedule ? "間に合う見込み" : "間に合わない見込み"}
    </li>
  );
}

export interface CodifySuggestionApplyOutcome {
  readonly appliedCount: number;
  readonly total: number;
  readonly stoppedAtTechId: EntityId | null;
}

// --- 3a. [M71/R6-A01] 空メッセージの除外理由(hooks 不使用・直接テスト可能) ---
//
// 旧文言は「対象がありません(保持者がいる未成文の技術がありません)」の
// 1 パターン固定だった。実際には derived.ts の在庫フィルタ(R5-A08)が候補を
// 落としているだけのことがあり、その場合は同じ画面の成文化キュー本体に該当
// techが並んで見えるため「成文化できる技術が一切無い」という誤った説明になる
// (R6-A01)。除外理由(`codifySuggestionExclusions`)を媒体別に集計し、
// 0 件なら旧文言(真に対象が無い)、1 件以上なら理由つきの文言に差し替える。

interface CodifySuggestionExclusionGroup {
  readonly medium: RecordMedium;
  readonly count: number;
}

/** 媒体別に除外件数を集計する(順序は文字コード順で固定・表示の安定性のため)。 */
export function summarizeCodifySuggestionExclusions(
  exclusions: readonly CodifySuggestionExclusionView[],
): readonly CodifySuggestionExclusionGroup[] {
  const countByMedium = new Map<RecordMedium, number>();
  for (const exclusion of exclusions) {
    countByMedium.set(exclusion.medium, (countByMedium.get(exclusion.medium) ?? 0) + 1);
  }
  return [...countByMedium.entries()]
    .map(([medium, count]) => ({ medium, count }))
    .sort((a, b) => (a.medium < b.medium ? -1 : a.medium > b.medium ? 1 : 0));
}

/**
 * おまかせ成文化の提案が 0 件のときの説明文。除外理由が無ければ旧来どおり
 * 「対象が無い」だけを言う(真にゼロ件・R5-A08 以前と同じ文言=既存の意味を
 * 変えない)。除外理由があれば、何件が何の媒体の在庫不足で落ちたかを添える
 * (内部 ID・reject コードの生値は出さない・和名は `mediumLabel` 経由)。
 */
export function codifySuggestionEmptyMessage(
  exclusions: readonly CodifySuggestionExclusionView[],
): string {
  if (exclusions.length === 0) {
    return "対象がありません(保持者がいる未成文の技術がありません)。";
  }
  const reasons = summarizeCodifySuggestionExclusions(exclusions)
    .map(
      (group) =>
        `対象 ${String(group.count)}件は媒体(${mediumLabel(group.medium)})の在庫が不足しているため提案できません`,
    )
    .join("・");
  return `対象がありません(${reasons})。`;
}

export interface CodifySuggestionPanelProps {
  readonly suggestions: readonly CodifySuggestionView[];
  /** [M71/R6-A01] 空メッセージの理由づけに使う(§ 直前の doc 参照)。 */
  readonly exclusions: readonly CodifySuggestionExclusionView[];
  readonly outcome: CodifySuggestionApplyOutcome | null;
  readonly onApply: () => void;
}

export function CodifySuggestionPanel({
  suggestions,
  exclusions,
  outcome,
  onApply,
}: CodifySuggestionPanelProps) {
  return (
    <section class="kf-codify-assist" aria-label="おまかせ成文化">
      <h3 class="kf-codify-assist__title">おまかせ成文化の提案</h3>
      {suggestions.length === 0 ? (
        <p class="kf-codify-assist__empty">{codifySuggestionEmptyMessage(exclusions)}</p>
      ) : (
        <>
          <ol class="kf-codify-assist__list">
            {suggestions.map((suggestion) => (
              <CodifySuggestionRow key={suggestion.codifyId} suggestion={suggestion} />
            ))}
          </ol>
          <button type="button" class="kf-codify-assist__apply-button" onClick={onApply}>
            提案どおりに適用する
          </button>
        </>
      )}
      {outcome !== null && (
        <p class="kf-codify-assist__outcome">
          {outcome.appliedCount}/{outcome.total}件を適用しました
          {outcome.stoppedAtTechId !== null && `(${techLabel(outcome.stoppedAtTechId)}で停止)`}
        </p>
      )}
    </section>
  );
}

// --- 3b. [M62/FC5a] 媒体既定値の「初回だけ計算・以後は固定」(純関数) ---------
//
// R2-FC5(a) で発見されたバグ: 「ある行をキュー投入すると、操作していない
// 別の行の媒体セレクタが石板→紙へ勝手に変わる」。
//
// 原因は `mediumFor` が **毎レンダー** `defaultMediumFor`(§3 の「在庫が足りる
// 方」ヒューリスティック)を呼び直していたことにある。ある行をキューへ投入
// すると資源が減り、その資源を使う**別の行**の `defaultMediumFor` が
// 再評価されて別の結果(石板→紙)を返すようになる——ユーザーがその行を一度も
// 触っていなくても、である。
//
// 修正: 各 techId の既定値は**その行を最初に見た瞬間に一度だけ**計算して
// `mediumSelections` map へ書き込み、以後は明示的な `onMediumChange` でしか
// 変えない。既に値が入っている techId は絶対に上書きしない(=在庫が動いても
// 触っていない行の表示は変わらない)。
export function seedMissingMediumDefaults(
  previous: ReadonlyMap<EntityId, RecordMedium>,
  techs: readonly CodifyTechEntry[],
  defaultFor: (entry: CodifyTechEntry) => RecordMedium,
): ReadonlyMap<EntityId, RecordMedium> {
  let changed = false;
  const next = new Map(previous);
  for (const entry of techs) {
    if (next.has(entry.techId)) continue;
    next.set(entry.techId, defaultFor(entry));
    changed = true;
  }
  // 値が変わらなければ同じ参照を返す(不要な再描画/effect の再発火を避ける)。
  return changed ? next : previous;
}

// --- 3c. [M71/R6-A05] 媒体選択の画面またぎ持ち越し(hooks 不使用) -------------
//
// `mediumSelections` はコンポーネントローカルの `useState` だが、画面遷移の
// たびに `CodifyScreen` はアンマウント→リマウントされる(ADR-027(2)・
// `AppShell.tsx` の `ScreenHost` が `key={screenId}` で毎回作り直す)。素の
// `useState(new Map())` だと選択は毎回消え、リマウント後は §3b の
// `defaultMediumFor`(在庫依存のヒューリスティック)がゼロから再評価される。
// `beginCodification` は着手時に資源を**全額前払い**し `cancelCodification`
// は返金しない(§2)ため、「石板で投入」した直後は粘土在庫が既に減っている
// ——取消後に画面を往復すると、その減った在庫を見た `defaultMediumFor` が
// 「紙」側へ倒れる。これが R6-A05 の実際の機構であり(取消コマンド自体が
// 選択をリセットするのではない)、コンポーネント内だけで直すことはできない
// (アンマウントで useState が丸ごと破棄されるため)。
//
// モジュールスコープの Map(このファイルが読み込まれている間だけ生存)へ
// 直前の選択を都度書き写しておき、次回マウント時の初期値に使う。
// **store.sources のような GameState 側の永続化は意図的に選ばない**——
// techId は content 由来の安定 ID であり、別ワールド(新規ゲーム/インポート)
// へ選択が persist しても実害が無い(単なる好みの引き継ぎで、実際に押せるかは
// engine の reject が最終判定・§3 冒頭の「判定は書かない」規律のとおり)ため、
// state.ts の直列化・ADR-012 のセーブ互換を巻き込む必要が無い。
const persistedMediumSelections = new Map<EntityId, RecordMedium>();

// --- 4. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function CodifyScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "codify", { activate: false });

  const techs = useSignalValue(store.derived.codifyTechs);
  const suggestions = useSignalValue(store.derived.codifySuggestions);
  // [M71/R6-A01] 空メッセージの理由づけに使う(CodifySuggestionPanel へ渡すだけ)。
  const suggestionExclusions = useSignalValue(store.derived.codifySuggestionExclusions);
  const resources = useSignalValue(store.derived.resources);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  // [M62/FC5a] 「行ごとの現在の選択」(既定値を含む)。旧 `mediumOverrides` から
  // 改名——以前はユーザーの明示的な変更**だけ**を持つ差分マップだったが、今は
  // 初めて見た techId の既定値もここへ書き込んで固定する(§3b の doc 参照)。
  // [M71/R6-A05] 初期値は `persistedMediumSelections`(§3c)からの複製——マウント
  // のたびに空へ戻さない。
  const [mediumSelections, setMediumSelectionsState] = useState<
    ReadonlyMap<EntityId, RecordMedium>
  >(() => new Map(persistedMediumSelections));

  /**
   * [M71/R6-A05] `setMediumSelectionsState` の薄いラッパ。呼び出し側
   * (`handleMediumChange`/§3b の `useEffect`)は今までどおり
   * `setMediumSelections(updater)` を呼ぶだけでよく、ここで
   * `persistedMediumSelections`(§3c)への書き写しを一括して行う——次に
   * この画面がリマウントしたときの初期値になる。
   */
  function setMediumSelections(
    updater: (previous: ReadonlyMap<EntityId, RecordMedium>) => ReadonlyMap<EntityId, RecordMedium>,
  ): void {
    setMediumSelectionsState((previous) => {
      const next = updater(previous);
      if (next !== previous) {
        persistedMediumSelections.clear();
        for (const [techId, medium] of next) persistedMediumSelections.set(techId, medium);
      }
      return next;
    });
  }
  const [suggestionOutcome, setSuggestionOutcome] = useState<CodifySuggestionApplyOutcome | null>(
    null,
  );
  const toastStack = useToastStack();

  // content は起動後に差し替わらないので非追跡の peek で読む(他画面前例どおり)。
  const content = store.peekContent();

  function stockApprox(resourceId: EntityId): number {
    return resources.find((resource) => resource.resourceId === resourceId)?.stockApprox ?? 0;
  }

  /**
   * [束B/B-6] 媒体の既定選択を「在庫が足りる方」にする。両方(または片方だけ)
   * 足りるときは**石板を優先**し(粘土は序盤に潤沢・GDD 11.1 追補)、どちらも
   * 足りないときだけ従来のヒューリスティック(唯一保持なら石板)へ倒す。
   *
   * 廃材代替(`codifyWasteSubstitution`)は加味しない簡易判定
   * (★非ブロッキング: 廃材で足りるケースを見落として紙側の判定へ倒れることが
   * あるが、実際に押せるかは engine の reject が最終判定なので誤動作ではない)。
   * `recordMedia` ブロックが無い盤面では算出できない(`planCodification` が
   * 例外を投げる)ため、その場合は従来どおりのヒューリスティックのみで倒す。
   */
  function defaultMediumFor(entry: CodifyTechEntry): RecordMedium {
    if (content.recordMedia === undefined) return assistPreferredMedium(entry.uniqueHolder);
    const printingUnlocked = isPrintingUnlocked(store.peekState(), content);
    const stonePlan = planCodification(content, entry.techId, "stoneTablet", printingUnlocked);
    if (stockApprox(stonePlan.costResourceId) >= toApproxNumber(stonePlan.costFix)) {
      return "stoneTablet";
    }
    const paperPlan = planCodification(content, entry.techId, "paper", printingUnlocked);
    if (stockApprox(paperPlan.costResourceId) >= toApproxNumber(paperPlan.costFix)) {
      return "paper";
    }
    return assistPreferredMedium(entry.uniqueHolder);
  }

  // [M62/FC5a] techs の一覧が変わるたび(在庫変化での再計算含む)、まだ選択が
  // 無い techId にだけ既定値を割り当てる。既存の選択(ユーザー操作/以前の
  // 既定値)は絶対に上書きしない——これが R2-FC5(a) の「他行が勝手に変わる」
  // バグの直接の修正である。
  useEffect(() => {
    setMediumSelections((previous) => seedMissingMediumDefaults(previous, techs, defaultMediumFor));
    // 依存は意図的に `techs` だけ(ExpeditionReturnWatcher 等・AppShell.tsx と
    // 同じ規律)。defaultMediumFor は content/store.peekState()/resources を
    // 毎回閉じ込めた新しい関数だが、techs が変わらない限り「初めて見た
    // techId」は増えないので、この effect が無駄に発火しても実質 no-op
    // (seedMissingMediumDefaults が changed=false のとき同じ参照を返す)。
  }, [techs]);

  function mediumFor(entry: CodifyTechEntry): RecordMedium {
    // 効果が既に selections にあればそれを使う。effect が走る前の 1 フレームだけ
    // 起こりうる未セット状態のフォールバックとして defaultMediumFor を残す
    // (フォールバックの結果は selections へは書き込まない=1 回性の表示専用)。
    return mediumSelections.get(entry.techId) ?? defaultMediumFor(entry);
  }

  /**
   * [M61/FC11・R1-A15] 「キューに入れる」前に必要資源を見せる(以前は
   * `insufficientResource` reject で拒否されて初めて分かった)。
   * `planCodification` を呼ぶだけで、投入判定そのものは行わない(§既存の
   * 「判定は書かない」規律を維持・実際に足りるかは engine の reject に委ねる)。
   */
  function costPreviewFor(
    entry: CodifyTechEntry,
  ): { readonly resourceId: EntityId; readonly amountApprox: number } | null {
    if (content.recordMedia === undefined) return null;
    const medium = mediumFor(entry);
    const plan = planCodification(
      content,
      entry.techId,
      medium,
      isPrintingUnlocked(store.peekState(), content),
    );
    return { resourceId: plan.costResourceId, amountApprox: toApproxNumber(plan.costFix) };
  }

  /**
   * [M71/R6-C02] `costPreviewFor` の資源が現在の在庫で足りないか(表示専用の
   * 目印・判定はしない。§ `CodifyTechRowProps.insufficient` の doc 参照)。
   */
  function isInsufficientFor(entry: CodifyTechEntry): boolean {
    const preview = costPreviewFor(entry);
    if (preview === null) return false;
    return stockApprox(preview.resourceId) < preview.amountApprox;
  }

  function handleMediumChange(techId: EntityId, medium: RecordMedium): void {
    setMediumSelections((previous) => {
      const next = new Map(previous);
      next.set(techId, medium);
      return next;
    });
  }

  function handleEnqueue(techId: EntityId, medium: RecordMedium): void {
    const beforeState = store.peekState();
    // [束B/B-4] 成功トースト用の差分を取るため、投入前にコスト資源の在庫を
    // 控えておく(content に recordMedia が無ければ算出しない)。
    // [M63/R4-A14] 石板の粘土コストは廃材で低比率代替されうる(GDD 6.7・3出口
    // (2)・`codifyWasteSubstitution` は medium=stoneTablet のみ非0)ので、
    // 廃材資源の在庫も併せて控える(paper 等では単に動かないだけ)。
    const plan =
      content.recordMedia === undefined
        ? null
        : planCodification(content, techId, medium, isPrintingUnlocked(beforeState, content));
    // [M70/R5-A04] Fix のまま控える(resourceStockFix・Toast.tsx の
    // spentAmountText doc 参照。近似値どうしの減算は IEEE754 の丸め誤差で
    // ±1 ずれることがある)。
    const beforeStockFix =
      plan === null ? null : resourceStockFix(beforeState, plan.costResourceId);
    const wasteResourceId = content.storage?.wasteResourceId ?? null;
    const wasteBeforeStockFix =
      wasteResourceId === null ? null : resourceStockFix(beforeState, wasteResourceId);

    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "beginCodification",
        codifyId: codifyRecordId(techId, medium),
        techId,
        medium,
      },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    const afterStockFix =
      plan === null ? null : resourceStockFix(store.peekState(), plan.costResourceId);
    const wasteAfterStockFix =
      wasteResourceId === null ? null : resourceStockFix(store.peekState(), wasteResourceId);
    const diff = resourceSpendBreakdownPhrase(
      { resourceId: plan?.costResourceId ?? null, beforeStockFix, afterStockFix },
      {
        resourceId: wasteResourceId,
        beforeStockFix: wasteBeforeStockFix,
        afterStockFix: wasteAfterStockFix,
      },
    );
    toastStack.push(
      `「${techLabel(techId)}」を成文化キューに入れた${diff.length > 0 ? `(${diff})` : ""}`,
    );
  }

  /**
   * [M54] 作業中の記録を取り消す(`cancelCodification`・GDD 6.2)。
   * 返金は一切無い(§2)ので、成功トーストでもその旨をもう一度明記する。
   *
   * [M71/R6-C01] おまかせ成文化の成功バナー(`suggestionOutcome`)もここで
   * クリアする。取消は `suggestionOutcome` を一切参照しない独立の操作だが、
   * バナーは「以前の適用結果」を表示し続ける一方通行の state のため、取消後も
   * 古い「1/1件を適用しました」が残ったまま`codifySuggestions`側は「対象が
   * ありません」に変わるという矛盾並存が起きていた(R6-C01)。画面遷移(→
   * アンマウント)なら自然に消えるが、同一画面内で取消しただけでは消えない
   * ため、ここで明示的に消す。
   */
  function handleCancel(codifyId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "cancelCodification", codifyId },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    setSuggestionOutcome(null);
    toastStack.push("成文化の記録を取り消した(支払った資源は戻りません)");
  }

  // おまかせ成文化の適用: 提案順に 1 件ずつ dispatch する(1 本の atomic 列に
  // しない=途中の衝突で提案全体を巻き戻さないため。commands.ts §6 の列入力は
  // 「1 つでも reject なら全部捨てる」なので、ここではあえて使わない)。
  function handleApplySuggestions(): void {
    let appliedCount = 0;
    let stoppedAtTechId: EntityId | null = null;
    let rejection: CommandRejection | null = null;
    for (const suggestion of suggestions) {
      const result = store.dispatch({
        type: "commandApplied",
        command: {
          kind: "beginCodification",
          codifyId: suggestion.codifyId,
          techId: suggestion.techId,
          medium: suggestion.medium,
        },
      });
      if (result.command !== null && !result.command.ok) {
        stoppedAtTechId = suggestion.techId;
        rejection = result.command.rejection;
        break;
      }
      appliedCount++;
    }
    setSuggestionOutcome({ appliedCount, total: suggestions.length, stoppedAtTechId });
    setLastRejection(rejection);
  }

  return (
    <section class="kf-codify-screen" aria-labelledby="kf-codify-screen-title">
      <h2 class="kf-codify-screen__title" id="kf-codify-screen-title">
        成文化キュー
      </h2>
      <p class="kf-screen-intro">
        住民の頭の中にある知識を、失われないよう記録に残します。記録は研究点を産出する施設の
        稼働就労者によって少しずつ書き進み、時間が経つと完成します。
      </p>
      <p class="kf-codify-screen__note">
        作業中の記録は取り消せます。ただし支払った資源は戻りません(完成した記録は取り消せません)。
      </p>

      <ToastStackView toasts={toastStack.toasts} />

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      <CodifySuggestionPanel
        suggestions={suggestions}
        exclusions={suggestionExclusions}
        outcome={suggestionOutcome}
        onApply={handleApplySuggestions}
      />

      {techs.length === 0 ? (
        <p class="kf-codify-screen__empty">
          解禁済みの技術がありません(先に研究ツリーで研究を進めてください)。
        </p>
      ) : (
        <ul class="kf-codify-screen__list">
          {techs.map((entry) => (
            <CodifyTechRow
              key={entry.techId}
              entry={entry}
              selectedMedium={mediumFor(entry)}
              onMediumChange={handleMediumChange}
              onEnqueue={handleEnqueue}
              onCancel={handleCancel}
              costPreview={costPreviewFor(entry)}
              insufficient={isInsufficientFor(entry)}
            />
          ))}
        </ul>
      )}

      <div class="kf-codify-screen__nav">
        <button
          type="button"
          class="kf-codify-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          住民一覧へ
        </button>
        <button
          type="button"
          class="kf-codify-screen__nav-button"
          onClick={() => onNavigate("research")}
        >
          研究ツリーへ
        </button>
      </div>
    </section>
  );
}
