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

import { useState } from "preact/hooks";

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
import type { CodifySuggestionView, CodifyTechEntry } from "../../derived";
import { mediumLabel, techLabel } from "../contentLabels";
import { LossClassBadge } from "../LossClassBadge";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { resourceDeltaPhrase, resourceStockApprox, useToastStack, ToastStackView } from "../Toast";
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
}

export function CodifyTechRow({
  entry,
  selectedMedium,
  onMediumChange,
  onEnqueue,
  onCancel,
}: CodifyTechRowProps) {
  function handleMediumChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as RecordMedium;
    onMediumChange(entry.techId, value);
  }

  return (
    <li class="kf-codify-row" data-tech-id={entry.techId}>
      <div class="kf-codify-row__head">
        <span class="kf-codify-row__name">{techLabel(entry.techId)}</span>
        <LossClassBadge lossClass={entry.lossClass} />
      </div>

      <p class="kf-codify-row__holders">
        保持者 {entry.holderIds.length}人{entry.uniqueHolder ? "(唯一保持)" : ""}
      </p>

      {entry.holderIds.length > 0 && (
        <p class="kf-codify-row__risk">
          残存想定: {entry.hasDeadline ? `約${entry.residualTick}tick` : "無期限(寿命モデル未設定)"}
          {entry.maxRecallRiskPercentApprox !== null &&
            `・想起リスク約${entry.maxRecallRiskPercentApprox.toFixed(1)}%/日`}
        </p>
      )}

      <p class="kf-codify-row__recorded">
        {entry.isCodified
          ? `記録済み(${entry.recordedMedia.map((medium) => mediumLabel(medium)).join("・")})`
          : "未記録"}
      </p>

      {entry.pendingRecords.length > 0 && (
        <ul class="kf-codify-row__pending">
          {entry.pendingRecords.map((record) => (
            <li key={record.entityId}>
              作業中: {mediumLabel(record.medium)}(進行度 {record.progressApprox.toFixed(1)}/
              {record.requiredWorkApprox.toFixed(1)})
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
      <button
        type="button"
        class="kf-codify-row__enqueue-button"
        onClick={() => onEnqueue(entry.techId, selectedMedium)}
      >
        キューに入れる
      </button>
    </li>
  );
}

// --- 3. おまかせ成文化の提案パネル(hooks 不使用) ----------------------------

export interface CodifySuggestionRowProps {
  readonly suggestion: CodifySuggestionView;
  readonly order: number;
}

export function CodifySuggestionRow({ suggestion, order }: CodifySuggestionRowProps) {
  return (
    <li class="kf-codify-assist__row" data-tech-id={suggestion.techId}>
      {order}. {techLabel(suggestion.techId)}({mediumLabel(suggestion.medium)})・所要
      {suggestion.durationTicks}tick・累積{suggestion.cumulativeTicks}tick・
      {suggestion.hasDeadline ? `残存約${suggestion.residualTick}tick` : "無期限"}・
      {suggestion.onSchedule ? "間に合う見込み" : "間に合わない見込み"}
    </li>
  );
}

export interface CodifySuggestionApplyOutcome {
  readonly appliedCount: number;
  readonly total: number;
  readonly stoppedAtTechId: EntityId | null;
}

export interface CodifySuggestionPanelProps {
  readonly suggestions: readonly CodifySuggestionView[];
  readonly outcome: CodifySuggestionApplyOutcome | null;
  readonly onApply: () => void;
}

export function CodifySuggestionPanel({
  suggestions,
  outcome,
  onApply,
}: CodifySuggestionPanelProps) {
  return (
    <section class="kf-codify-assist" aria-label="おまかせ成文化">
      <h3 class="kf-codify-assist__title">おまかせ成文化の提案</h3>
      {suggestions.length === 0 ? (
        <p class="kf-codify-assist__empty">
          対象がありません(保持者がいる未成文の技術がありません)。
        </p>
      ) : (
        <>
          <ol class="kf-codify-assist__list">
            {suggestions.map((suggestion, index) => (
              <CodifySuggestionRow
                key={suggestion.codifyId}
                suggestion={suggestion}
                order={index + 1}
              />
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

// --- 4. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function CodifyScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "codify", { activate: false });

  const techs = useSignalValue(store.derived.codifyTechs);
  const suggestions = useSignalValue(store.derived.codifySuggestions);
  const resources = useSignalValue(store.derived.resources);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const [mediumOverrides, setMediumOverrides] = useState<ReadonlyMap<EntityId, RecordMedium>>(
    new Map(),
  );
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

  function mediumFor(entry: CodifyTechEntry): RecordMedium {
    return mediumOverrides.get(entry.techId) ?? defaultMediumFor(entry);
  }

  function handleMediumChange(techId: EntityId, medium: RecordMedium): void {
    setMediumOverrides((previous) => {
      const next = new Map(previous);
      next.set(techId, medium);
      return next;
    });
  }

  function handleEnqueue(techId: EntityId, medium: RecordMedium): void {
    const beforeState = store.peekState();
    // [束B/B-4] 成功トースト用の差分を取るため、投入前にコスト資源の在庫を
    // 控えておく(content に recordMedia が無ければ算出しない)。
    const plan =
      content.recordMedia === undefined
        ? null
        : planCodification(content, techId, medium, isPrintingUnlocked(beforeState, content));
    const beforeStockApprox =
      plan === null ? null : resourceStockApprox(beforeState, plan.costResourceId);

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
    const afterStockApprox =
      plan === null ? null : resourceStockApprox(store.peekState(), plan.costResourceId);
    const diff = resourceDeltaPhrase(
      plan?.costResourceId ?? null,
      beforeStockApprox,
      afterStockApprox,
    );
    toastStack.push(
      `「${techLabel(techId)}」を成文化キューに入れた${diff.length > 0 ? `(${diff})` : ""}`,
    );
  }

  /**
   * [M54] 作業中の記録を取り消す(`cancelCodification`・GDD 6.2)。
   * 返金は一切無い(§2)ので、成功トーストでもその旨をもう一度明記する。
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
        outcome={suggestionOutcome}
        onApply={handleApplySuggestions}
      />

      {techs.length === 0 ? (
        <p class="kf-codify-screen__empty">
          解禁済みの技術がありません(先に⑤研究ツリーで研究を進めてください)。
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
          ④住民一覧へ
        </button>
        <button
          type="button"
          class="kf-codify-screen__nav-button"
          onClick={() => onNavigate("research")}
        >
          ⑤研究ツリーへ
        </button>
      </div>
    </section>
  );
}
