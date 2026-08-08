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
import { mediumLabel, residentDisplayName, techLabel, traitLabel } from "../contentLabels";
import { formatApproxDecimal1, formatApproxDecimal2 } from "../format";
import { LossClassBadge } from "../LossClassBadge";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import { useStickyActionsClearance } from "../useStickyActionsClearance";
import "./migrationScreen.css";

// --- 1. 表示文言(判定は engine・ここは文言だけ) -----------------------------

/**
 * [束B] `mediumLabel` は contentLabels.ts へ集約した(CodifyScreen.tsx と
 * 同じ定義を 2 箇所で持たないため)。re-export のみで既存テストの import 経路
 * (`from ".../MigrationScreen"`)を壊さない。
 */
export { mediumLabel };

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
        {/* [M70/R5-A12] 素の toFixed(2) を整形ヘルパへ(小数第2位まで要る値
            (紙0.25等)は formatApproxDecimal1 だと丸まって判別できないため
            formatApproxDecimal2 を使う・小数の二重基準の残存の掃討)。 */}
        <span class="kf-exodus__record-weight">枠 {formatApproxDecimal2(record.weightApprox)}</span>
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
        <span class="kf-exodus__crew-id">{residentDisplayName(resident.id)}</span>
        <span class="kf-exodus__crew-morale">
          士気{formatApproxDecimal1(resident.moraleApprox)}
        </span>
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

/**
 * GDD 10.2 の「何が落ちるか」プレビュー(積み込み=記録/住民の選択に依存する
 * 値だけを持つ)。**[M70/R5-A10] 獲得予定の継承点はここに含めない**
 * (`ExodusInheritPointsNote` へ分離した理由の doc 参照)。
 */
export function ExodusPreviewPanel({ resolution }: ExodusPreviewPanelProps) {
  if (resolution === null) {
    return <p class="kf-exodus__preview-inactive">現在のデータでは大移動を算出できません。</p>;
  }
  return (
    <section class="kf-exodus__preview" aria-label="積み込みプレビュー">
      <p class="kf-exodus__preview-capacity">
        {/* [M63/R4-A12/A13] 素の toFixed(2) を整形ヘルパへ(「キャラバン1.00」の
            不揃い解消。戦力/士気と同じ「資源以外の近似値」枠なので
            formatApproxDecimal1 を使う)。 */}
        キャラバン: {formatApproxDecimal1(toApproxNumber(resolution.usedCaravanWeightFix))} /{" "}
        {formatApproxDecimal1(toApproxNumber(resolution.caravanCapacityFix))} 枠・乗員:{" "}
        {resolution.carriedCrewIds.length} / {resolution.crewCapacity} 名
      </p>
      {resolution.droppedRecordIds.length > 0 && (
        <p class="kf-exodus__preview-dropped" data-testid="exodus-dropped-records">
          容量超過で長夜に還る記録: {resolution.droppedRecordIds.join("・")}
        </p>
      )}
      {resolution.droppedCrewIds.length > 0 && (
        <p class="kf-exodus__preview-dropped" data-testid="exodus-dropped-crew">
          定員超過で置いていく住民:{" "}
          {resolution.droppedCrewIds.map((crewId) => residentDisplayName(crewId)).join("・")}
        </p>
      )}
      {resolution.lostRareTechIds.length > 0 && (
        <p class="kf-exodus__preview-lost" data-testid="exodus-lost-tech">
          永久喪失する(B)技術:{" "}
          {resolution.lostRareTechIds.map((techId) => techLabel(techId)).join("・")}
        </p>
      )}
    </section>
  );
}

// --- 4b. [M70/R5-A10] 獲得予定の継承点(積み込みプレビューとは別セクション) --
//
// GDD 10.3 の継承点式(エラ+成文化+生存)は積み込み(記録/住民の選択)に
// **依存しない**。旧実装は `ExodusPreviewPanel`(積み込みで変わる容量/落ちる
// ものと同じ section)の内側に置いていたため、選択で変わって見えると誤解
// された(R5-A10「積み込みプレビュー内側にあり選択で変わるように見える」)。
// 別セクション+注記で独立性を明示する。

export interface ExodusInheritPointsNoteProps {
  /** `null` = content に exodus/recordMedia ブロックが無く算出不能。 */
  readonly resolution: ExodusResolution | null;
}

export function ExodusInheritPointsNote({ resolution }: ExodusInheritPointsNoteProps) {
  if (resolution === null) return null;
  return (
    <section class="kf-exodus__inherit-points" aria-label="獲得予定の継承点">
      <p class="kf-exodus__preview-earned">
        獲得予定の継承点: {resolution.earnedInheritPoints}
        <span class="kf-exodus__preview-earned-note">(下の記録・住民の選択には左右されません)</span>
      </p>
    </section>
  );
}

// --- 4c. [M74/⑰] 次の周回の開始人口予告 ---------------------------------------
//
// 乗員定員は `ceil(生存 × 0.5) + 継承ボーナス`(GDD 10.2・rules/exodus.ts の
// `crewCapacity`)なので、人口を立て直さないまま大移動を繰り返すと連れて行ける
// 人数は周回ごとに半分ずつ縮み、継承点の生存項(`生存住民数 × 2`・GDD 10.3)も
// 一緒に縮む。**これは仕様どおりの挙動**だが、旧 UI は「乗員 X / 定員 Y」を
// 出すだけで、その X が**次の周回の開始人口そのもの**であることをどこにも
// 書いていなかった(縮小の螺旋に入っていることが実行するまで分からない)。
//
// ここでは engine の `resolveExodusPlan` が返した値(`carriedCrewIds` /
// `crewCapacity` / `earnedInheritPoints`)を言い換えるだけで、次周回の定員を
// UI 側で先に計算したりはしない(半分になる規則は文で言う・数値は捏造しない)。

export interface ExodusNextRunPreviewProps {
  /** `null` = content に exodus/recordMedia ブロックが無く算出不能。 */
  readonly resolution: ExodusResolution | null;
}

export function ExodusNextRunPreview({ resolution }: ExodusNextRunPreviewProps) {
  if (resolution === null) return null;
  return (
    <section class="kf-exodus__next-run" aria-label="次の周回の見込み">
      <p class="kf-exodus__next-run-crew" data-testid="exodus-next-run-crew">
        次の周回は乗員 {resolution.carriedCrewIds.length}人 から始まります(いま連れて行ける上限は{" "}
        {resolution.crewCapacity}名)。
      </p>
      <p class="kf-exodus__next-run-points">
        このとき獲得する継承点: {resolution.earnedInheritPoints}
      </p>
      <p class="kf-exodus__next-run-note" role="note">
        次の周回で連れて行ける上限は、その周回を終えるときの生存人数の半分(端数繰り上げ)です。
        人口を立て直さずに大移動を続けると、連れて行ける人数も獲得できる継承点も周回ごとに
        小さくなります。
      </p>
    </section>
  );
}

// --- 4d. [M76/台帳v25必-4] 乗員不足の事前表示(GDD 10.2・M75 最少乗員ガード) --
//
// M75 で `content/balance.json` の `exodus.minCrew` を下回る乗員選抜が
// `exodusNoCrew` reject になったが、旧 UI はボタンを押すまでそれを知らせな
// かった(R8-03 と同種の「押すまで払えるか分からない」)。ここでは engine の
// 判定述語を UI で再実装せず、`content.exodus.minCrew`(省略時 = ガード不活性
// = 警告なし・`rules/types.ts` の `ExodusParams.minCrew` doc と同じ規約)と
// 現在の選抜人数を比べるだけの**表示専用**の事前警告を出す。実際に押せるかは
// 従来どおり `executeExodus` の reject(§4 の `exodusNoCrew`)に委ねる
// (ボタンは非活性にしない・architecture.md §6 の規律)。

export interface ExodusCrewShortfallWarningProps {
  /** `content.exodus?.minCrew ?? null`。null = ガード不活性(警告を出さない)。 */
  readonly minCrew: number | null;
  readonly selectedCrewCount: number;
}

export function ExodusCrewShortfallWarning({
  minCrew,
  selectedCrewCount,
}: ExodusCrewShortfallWarningProps) {
  if (minCrew === null || selectedCrewCount >= minCrew) return null;
  return (
    <p class="kf-exodus__crew-shortfall" role="alert" data-testid="exodus-crew-shortfall">
      ▲ 乗員が最少 {minCrew}名に足りません(選抜 {selectedCrewCount}
      名)。このままでは大移動を実行できません。
    </p>
  );
}

/**
 * [M74/⑰] 確認パネル(§2)の本文。取り消せないことに加えて、**次の周回の
 * 開始乗員と獲得予定の継承点を数値で**言う——確認の瞬間に見えていないと、
 * 上のプレビューまで戻って読み直す必要があり、実質「見ずに押す」になる。
 * 数値は `resolveExodusPlan` の結果をそのまま読む(UI 側で計算しない)。
 */
export function exodusConfirmMessage(resolution: ExodusResolution | null): string {
  if (resolution === null) {
    return (
      "本当によろしいですか。この操作は取り消せません。" +
      "上のプレビューに表示された内容で確定します。"
    );
  }
  return (
    "本当によろしいですか。この操作は取り消せません。次の周回は乗員" +
    `${String(resolution.carriedCrewIds.length)}人・継承点+${String(resolution.earnedInheritPoints)}` +
    "で始まります(落ちるもの・永久喪失する技術は上のプレビューのとおり)。"
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
  // [M61/FC3] プール件数・確認ダイアログの開閉(=sticky バー自身の高さも変わる)
  // のいずれかが変わるたびに sticky バーとの重なりを測り直す。
  const stickyClearance = useStickyActionsClearance([
    codifyViews.length,
    residentViews.length,
    confirming,
  ]);

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
  // [M76/台帳v25必-4] `exodusNoCrew` の reject と同じ値(content 直読・engine 側の
  // 既定値展開はローダーの担当なので、ここで 1 をハードコードしない・§4d 参照)。
  const minCrew = content.exodus?.minCrew ?? null;

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
      <p class="kf-screen-intro">
        今の本拠を畳んで、次の周回へ引き継ぐ記録と住民を選びます。取り消せない操作です。
      </p>
      <p class="kf-migration-screen__note">
        大移動は本拠(施設を含む)を捨てて次の周回へ進む、取り消せない操作です。
        積めなかった記録・連れて行けなかった住民は長夜に還ります。
      </p>

      {completedEarnedPoints !== null && (
        <ExodusCompletedNotice
          earnedInheritPoints={completedEarnedPoints}
          onGoToSettings={() => onNavigate("settings")}
        />
      )}

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {!exodusActive && (
        <p class="kf-migration-screen__inactive">現在のデータでは大移動は実行できません。</p>
      )}

      {/* [M70/R5-A10] 積み込み(記録/住民の選択)に依存しない値なので、選択を
          始める前(おまかせ選択ボタンの下・石版プールの上)に独立した節として
          出す。積み込みプレビュー(下部・選択で変わる値)とは別セクション。 */}
      <ExodusInheritPointsNote resolution={resolution} />

      <button
        type="button"
        class="kf-migration-screen__recommend-button"
        onClick={applyRecommendation}
        disabled={!exodusActive}
      >
        おまかせ選択(自動でおすすめの記録・住民を選びます)
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

      {/* [M61/FC11・R1-A27] 見出しの分母(生存住民の総数=選べる上限)と、下の
          積み込みプレビューが出す「乗員: X / 定員」の分母(次周へ運べる乗員
          定員)は**別の数値**だが、どちらも「X/Y」表記だったため矛盾に見えた
          (大移動直後は定員が住民総数より小さくなりうる)。ラベルを分けて
          明示する。 */}
      <h3 class="kf-migration-screen__subtitle">
        乗員プール(生存住民 {crewPool.length}名中 {validCrewIds.length}名を選択)
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

      <h3 class="kf-migration-screen__subtitle">積み込みプレビュー</h3>
      {/* [M61/FC3・R1-C04] sticky確定バーとの実測重なり補正(プレビュー+シード
          指定欄をまとめて1つの塊として押し下げる対象にする)。 */}
      <div ref={stickyClearance.contentRef}>
        <ExodusPreviewPanel resolution={resolution} />

        {/* [M74/⑰] 次の周回の開始人口予告(§4c)。sticky の確認パネルではなく
            その直前(押す前に必ず目に入る位置)へ置く——確認パネル自体の高さは
            appShell.css の --kf-sticky-actions-reserve(実測値)に縛られるので、
            そこへ 3 行足さずに本文へ出し、確認パネル側は 1 行の要約
            (exodusConfirmMessage)で同じ数値を再掲する。 */}
        <ExodusNextRunPreview resolution={resolution} />

        {/* [M76/台帳v25必-4] 乗員不足の事前表示(§4d)。ExodusNextRunPreview と
            同じく sticky バーの直前(押す前に必ず目に入る位置)へ置く。 */}
        <ExodusCrewShortfallWarning minCrew={minCrew} selectedCrewCount={validCrewIds.length} />

        <label class="kf-migration-screen__seed-label">
          次の周回のシードを指定(任意)
          {/* [M70/R5-A09と同型] Preact の onChange は blur 発火(change イベント)
              なので、入力直後に他欄へ移らず「大移動を実行」まで進むと入力が
              反映されないまま実行されうる。onInput(input イベント)へ統一。 */}
          <input
            type="text"
            class="kf-migration-screen__seed-input"
            value={worldSeedOverride}
            onInput={(event) => setWorldSeedOverride((event.target as HTMLInputElement).value)}
            placeholder="空欄なら自動で決まります"
          />
        </label>
      </div>

      {/* [束A/M-3] 確定操作(大移動を実行 → 確認)は画面下部の sticky バーへ。
          記録/乗員の一覧が長くても、選びながら常に押せる位置に留まる。 */}
      <div class="kf-sticky-actions" ref={stickyClearance.stickyRef}>
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
            <p class="kf-migration__confirm-message">{exodusConfirmMessage(resolution)}</p>
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
      </div>

      <div class="kf-migration-screen__nav">
        <button
          type="button"
          class="kf-migration-screen__nav-button"
          onClick={() => onNavigate("inheritance")}
        >
          継承点購入へ
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
