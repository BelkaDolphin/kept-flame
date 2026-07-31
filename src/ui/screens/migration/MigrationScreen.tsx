// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑩大移動ナップサックUI(M33)— GDD 10.2 / 10.4 / 10.5
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   2 プール(石版=成文化済み記録/同行者=生存住民)の選択 UI。容量・選択量・
//   超過時に何が落ちるかのプレビューは `rules/exodus.ts` の
//   {@link resolveExodusPlan}(engine の resolver)を**そのまま呼ぶ**——UI 側で
//   ナップサックの詰め直しロジックを再計算しない(タスク指示「UI再計算禁止」)。
//   おまかせ選択は同モジュールの {@link recommendExodusPlan}(正式アシスト外の
//   決定論ヒューリスティック・GDD 2.1 の 80% 基準対象外)を呼ぶだけで、適用は
//   確認してから(提案 → 選択へ反映、まだ実行しない)。
//
// ===========================================================================
// 2. 実行前の確認ステップ(不可逆操作・GDD 10.2)
// ===========================================================================
//   大移動は次周の盤面を新しく組み立てる(施設を含む本拠を捨てる・GDD 10.2)、
//   取り消せない操作である。「大移動を実行」ボタンは**即座に dispatch しない**。
//   まず `confirming` を立てて resolveExodusPlan のプレビュー(何が落ちる/何を
//   永久喪失するか/獲得予定の継承点)を再掲する確認パネルを出し、そこで
//   明示的に「実行する」を押した場合のみ `executeExodus` を dispatch する。
//
// ===========================================================================
// 3. バックアップリマインド導線(ロードマップ M33 行の検分条件)
// ===========================================================================
//   GDD 13.4「バックアップリマインド導線(大移動/継承点獲得時)」。継承点は
//   `executeExodus` の成功時にしか獲得しない(購入は消費であって獲得ではない・
//   ⑪継承点購入画面の doc 参照)ので、「大移動」と「継承点獲得」は実装上
//   **同一のイベント**である。実行成功の直後に、獲得した継承点数を明記した
//   バックアップ推奨バナー(＋設定画面への導線つき)を表示する。
//
// ===========================================================================
// 4. 判定は書かない(architecture.md §6)
// ===========================================================================
//   容量/定員に選択が収まるかは**先読みしない**。プレビュー(§1)はあくまで
//   「resolveExodusPlan が返す事実の表示」であり、実際に押せるかどうかは
//   `executeExodus` の reject(`exodusCapacityExceeded` 等)に委ねる
//   (commands.ts §3「1 件でも超過なら黙って積まず拒否する」)。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import { toApproxNumber } from "../../../engine/fp";
import {
  recommendExodusPlan,
  resolveExodusPlan,
  type ExodusPlan,
  type ExodusResolution,
} from "../../../engine/rules/exodus";
import {
  lossClassOfTech,
  type RecordMedium,
  type TechLossClass,
} from "../../../engine/rules/types";
import type { EntityId } from "../../../engine/state/state";
import { techLabel, traitLabel } from "../contentLabels";
import { LossClassBadge } from "../LossClassBadge";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./migrationScreen.css";

// --- 1. 表示文言(判定は engine・ここは文言だけ) -----------------------------

/** GDD 11.1 追補の媒体 2 種(石板/紙)。`CodifyScreen.tsx` の同名関数と同じ対応
 * だが、画面ファイル間の相互 import はこのプロジェクトに前例が無いため
 * ここに独立して持つ(7 行の重複・許容範囲)。 */
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

// --- 2. 選択プールの表示モデル -----------------------------------------------

/** 石版プールの 1 件(完了済み codify entity)。 */
export interface ExodusRecordOption {
  readonly id: EntityId;
  readonly techId: EntityId;
  readonly medium: RecordMedium;
  readonly lossClass: TechLossClass;
  /** 消費する石版換算枠(GDD 10.2 追補の媒体別重み)。 */
  readonly weightApprox: number;
}

/** 乗員プールの 1 件(生存住民)。 */
export interface ExodusCrewOption {
  readonly id: EntityId;
  readonly moraleApprox: number;
  readonly traitIds: readonly EntityId[];
}

// --- 3. 1 行(hooks 不使用・直接テスト可能) ----------------------------------

export interface ExodusRecordRowProps {
  readonly record: ExodusRecordOption;
  readonly selected: boolean;
  readonly onToggle: (id: EntityId) => void;
}

export function ExodusRecordRow({ record, selected, onToggle }: ExodusRecordRowProps) {
  return (
    <li class="kf-exodus__record">
      <button
        type="button"
        class="kf-exodus__record-button"
        aria-pressed={selected}
        onClick={() => onToggle(record.id)}
      >
        <span class="kf-exodus__record-tech">{techLabel(record.techId)}</span>
        <LossClassBadge lossClass={record.lossClass} />
        <span class="kf-exodus__record-medium">{mediumLabel(record.medium)}</span>
        <span class="kf-exodus__record-weight">枠 {record.weightApprox.toFixed(2)}</span>
      </button>
    </li>
  );
}

export interface ExodusCrewRowProps {
  readonly resident: ExodusCrewOption;
  readonly selected: boolean;
  readonly onToggle: (id: EntityId) => void;
}

export function ExodusCrewRow({ resident, selected, onToggle }: ExodusCrewRowProps) {
  return (
    <li class="kf-exodus__crew">
      <button
        type="button"
        class="kf-exodus__crew-button"
        aria-pressed={selected}
        onClick={() => onToggle(resident.id)}
      >
        <span class="kf-exodus__crew-id">{resident.id}</span>
        <span class="kf-exodus__crew-morale">士気{resident.moraleApprox}</span>
        {resident.traitIds.length > 0 && (
          <span class="kf-exodus__crew-traits">
            {resident.traitIds.map((traitId) => traitLabel(traitId)).join("・")}
          </span>
        )}
      </button>
    </li>
  );
}

// --- 4. プレビュー(resolveExodusPlan をそのまま表示するだけ・§1) ------------

export interface ExodusPreviewPanelProps {
  /** `null` = content に exodus/recordMedia ブロックが無く算出不能。 */
  readonly resolution: ExodusResolution | null;
}

/** GDD 10.2 の「何が落ちるか」プレビュー + GDD 10.3 の獲得予定継承点。 */
export function ExodusPreviewPanel({ resolution }: ExodusPreviewPanelProps) {
  if (resolution === null) {
    return (
      <p class="kf-exodus__preview-inactive">
        content に exodus/recordMedia ブロックが無いので大移動を算出できません。
      </p>
    );
  }
  return (
    <section class="kf-exodus__preview" aria-label="大移動プレビュー">
      <p class="kf-exodus__preview-capacity">
        キャラバン: {toApproxNumber(resolution.usedCaravanWeightFix).toFixed(2)} /{" "}
        {toApproxNumber(resolution.caravanCapacityFix).toFixed(2)} 枠・乗員:{" "}
        {resolution.carriedCrewIds.length} / {resolution.crewCapacity} 名
      </p>
      {resolution.droppedRecordIds.length > 0 && (
        <p class="kf-exodus__preview-dropped" data-testid="exodus-dropped-records">
          容量超過で長夜に還る記録: {resolution.droppedRecordIds.join("・")}
        </p>
      )}
      {resolution.droppedCrewIds.length > 0 && (
        <p class="kf-exodus__preview-dropped" data-testid="exodus-dropped-crew">
          定員超過で置いていく住民: {resolution.droppedCrewIds.join("・")}
        </p>
      )}
      {resolution.lostRareTechIds.length > 0 && (
        <p class="kf-exodus__preview-lost" data-testid="exodus-lost-tech">
          永久喪失する(B)技術:{" "}
          {resolution.lostRareTechIds.map((techId) => techLabel(techId)).join("・")}
        </p>
      )}
      <p class="kf-exodus__preview-earned">
        獲得予定の継承点(GDD 10.3): {resolution.earnedInheritPoints}
      </p>
    </section>
  );
}

// --- 5. 画面本体(hooks を持つのはここだけ) ----------------------------------

/** 実行成功直後に見せるバックアップ推奨(§3)。 */
export interface ExodusCompletedNoticeProps {
  readonly earnedInheritPoints: number;
  readonly onGoToSettings: () => void;
}

export function ExodusCompletedNotice({
  earnedInheritPoints,
  onGoToSettings,
}: ExodusCompletedNoticeProps) {
  return (
    <section class="kf-exodus__completed" role="status" aria-label="大移動完了">
      <p class="kf-exodus__completed-message">
        大移動が完了しました(継承点 +{earnedInheritPoints})。今すぐ＋設定画面でエクスポートし、
        バックアップを取ることを強くお勧めします。
      </p>
      <button type="button" class="kf-exodus__completed-button" onClick={onGoToSettings}>
        ＋設定画面へ
      </button>
    </section>
  );
}

export function MigrationScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "migration", { activate: false });

  // content は起動後に差し替わらないので非追跡の peek で読む
  // (ExpeditionScreen.tsx §2 と同じ立場)。
  const content = store.peekContent();
  // 記録/住民の一覧は既存の反応性シグナル(M31/M30)をそのまま使う。derived.ts の
  // 中央定義(StoreDerived インタフェース・createStoreDerived 本体)は M50 並行の
  // ため触らない方針(タスク指示)なので、新しいシグナルを足さずここで組み立てる。
  const codifyViews = useSignalValue(store.derived.codify);
  const residentViews = useSignalValue(store.derived.residents);

  const [selectedRecordIds, setSelectedRecordIds] = useState<ReadonlySet<EntityId>>(
    () => new Set(),
  );
  const [selectedCrewIds, setSelectedCrewIds] = useState<ReadonlySet<EntityId>>(() => new Set());
  const [worldSeedOverride, setWorldSeedOverride] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const [completedEarnedPoints, setCompletedEarnedPoints] = useState<number | null>(null);

  const recordPool: readonly ExodusRecordOption[] = codifyViews
    .filter((entry) => entry.completed)
    .map((entry) => ({
      id: entry.entityId,
      techId: entry.techId,
      medium: entry.medium,
      lossClass: lossClassOfTech(content, entry.techId),
      weightApprox:
        content.recordMedia === undefined
          ? 0
          : toApproxNumber(content.recordMedia.byMedium[entry.medium].caravanWeightFix),
    }));

  const crewPool: readonly ExodusCrewOption[] = residentViews
    .filter((entry) => entry.alive)
    .map((entry) => ({
      id: entry.entityId,
      moraleApprox: entry.moraleApprox,
      traitIds: entry.traitIds,
    }));

  // 選択済みだが現在の生きたプールから外れた ID は落とす(住民の死亡等で選択が
  // 古くなっても RulesError を起こさないための防御・§1)。
  const recordPoolIds = new Set(recordPool.map((entry) => entry.id));
  const crewPoolIds = new Set(crewPool.map((entry) => entry.id));
  const validRecordIds = [...selectedRecordIds].filter((id) => recordPoolIds.has(id));
  const validCrewIds = [...selectedCrewIds].filter((id) => crewPoolIds.has(id));

  const plan: ExodusPlan = { recordIds: validRecordIds, crewIds: validCrewIds };
  const state = store.peekState();
  const exodusActive = content.exodus !== undefined && content.recordMedia !== undefined;
  const resolution: ExodusResolution | null = exodusActive
    ? resolveExodusPlan(state, content, plan)
    : null;

  function toggleRecord(id: EntityId): void {
    setConfirming(false);
    setSelectedRecordIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCrew(id: EntityId): void {
    setConfirming(false);
    setSelectedCrewIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyRecommendation(): void {
    if (!exodusActive) return;
    const recommended = recommendExodusPlan(state, content);
    setSelectedRecordIds(new Set(recommended.recordIds));
    setSelectedCrewIds(new Set(recommended.crewIds));
    setConfirming(false);
  }

  function handleExecuteClick(): void {
    // 実行前の確認ステップ(§2・不可逆操作)。ここではまだ dispatch しない。
    setConfirming(true);
  }

  function handleCancel(): void {
    setConfirming(false);
  }

  function handleConfirm(): void {
    const earnedIfSuccessful = resolution?.earnedInheritPoints ?? 0;
    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "executeExodus",
        recordIds: validRecordIds,
        crewIds: validCrewIds,
        ...(worldSeedOverride.length > 0 ? { worldSeedOverride } : {}),
      },
    });
    setConfirming(false);
    if (result.command === null) return;
    if (!result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    setSelectedRecordIds(new Set());
    setSelectedCrewIds(new Set());
    setWorldSeedOverride("");
    setCompletedEarnedPoints(earnedIfSuccessful);
  }

  return (
    <section class="kf-migration-screen" aria-labelledby="kf-migration-screen-title">
      <h2 class="kf-migration-screen__title" id="kf-migration-screen-title">
        大移動
      </h2>
      <p class="kf-migration-screen__note">
        大移動は本拠(施設を含む)を捨てて次の周回へ進む、取り消せない操作です(GDD
        10.2)。積めなかった記録・連れて行けなかった住民は長夜に還ります。
      </p>

      {completedEarnedPoints !== null && (
        <ExodusCompletedNotice
          earnedInheritPoints={completedEarnedPoints}
          onGoToSettings={() => onNavigate("settings")}
        />
      )}

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {!exodusActive && (
        <p class="kf-migration-screen__inactive">
          content に exodus/recordMedia ブロックが無いので大移動は実行できません。
        </p>
      )}

      <button
        type="button"
        class="kf-migration-screen__recommend-button"
        onClick={applyRecommendation}
        disabled={!exodusActive}
      >
        おまかせ選択(決定論ヒューリスティック・GDD 2.1 の 80% 基準対象外)
      </button>

      <h3 class="kf-migration-screen__subtitle">
        石版プール(成文化済み記録・{validRecordIds.length}/{recordPool.length}件選択)
      </h3>
      {recordPool.length === 0 ? (
        <p class="kf-migration-screen__empty">積める記録がありません。</p>
      ) : (
        <ul class="kf-exodus__record-list">
          {recordPool.map((record) => (
            <ExodusRecordRow
              key={record.id}
              record={record}
              selected={validRecordIds.includes(record.id)}
              onToggle={toggleRecord}
            />
          ))}
        </ul>
      )}

      <h3 class="kf-migration-screen__subtitle">
        乗員プール(生存住民・{validCrewIds.length}/{crewPool.length}名選択)
      </h3>
      {crewPool.length === 0 ? (
        <p class="kf-migration-screen__empty">連れて行ける住民がいません。</p>
      ) : (
        <ul class="kf-exodus__crew-list">
          {crewPool.map((resident) => (
            <ExodusCrewRow
              key={resident.id}
              resident={resident}
              selected={validCrewIds.includes(resident.id)}
              onToggle={toggleCrew}
            />
          ))}
        </ul>
      )}

      <h3 class="kf-migration-screen__subtitle">プレビュー(GDD 10.2)</h3>
      <ExodusPreviewPanel resolution={resolution} />

      <label class="kf-migration-screen__seed-label">
        周回シードを指定(任意・GDD 10.5「UIで任意シード文字列入力も併設」)
        <input
          type="text"
          class="kf-migration-screen__seed-input"
          value={worldSeedOverride}
          onChange={(event) => setWorldSeedOverride((event.target as HTMLInputElement).value)}
          placeholder="空欄なら決定論的に自動導出"
        />
      </label>

      {!confirming ? (
        <button
          type="button"
          class="kf-migration-screen__execute-button"
          onClick={handleExecuteClick}
          disabled={!exodusActive}
        >
          大移動を実行
        </button>
      ) : (
        <section class="kf-migration__confirm" role="alertdialog" aria-label="大移動の確認">
          <p class="kf-migration__confirm-message">
            本当によろしいですか。この操作は取り消せません。上のプレビューに表示された内容(落ちるもの・
            永久喪失する技術・獲得予定の継承点)で確定します。
          </p>
          <div class="kf-migration__confirm-actions">
            <button
              type="button"
              class="kf-migration__confirm-execute-button"
              onClick={handleConfirm}
            >
              実行する(取り消せません)
            </button>
            <button
              type="button"
              class="kf-migration__confirm-cancel-button"
              onClick={handleCancel}
            >
              キャンセル
            </button>
          </div>
        </section>
      )}

      <div class="kf-migration-screen__nav">
        <button
          type="button"
          class="kf-migration-screen__nav-button"
          onClick={() => onNavigate("inheritance")}
        >
          ⑪継承点購入へ
        </button>
        <button
          type="button"
          class="kf-migration-screen__nav-button"
          onClick={() => onNavigate("settings")}
        >
          ＋設定へ
        </button>
      </div>
    </section>
  );
}
