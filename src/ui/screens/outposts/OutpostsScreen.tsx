// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑨衛星拠点管理(M32・束B/B-2で文言改訂・M54で操作結線)— GDD 9.2 / 11.4-7
//
// ===========================================================================
// 1. このファイルがやること・やらないこと
// ===========================================================================
//   拠点一覧(3タイプ)・供給レート・維持費・危険度(hazard)・拠点網 ROI の表示
//   (`rules/outpost.ts` の `outpostNetworkRoi` をそのまま呼ぶ・derived.ts の
//   `outpostOverview`)。(B) 損失項(`expectedRareLossApprox`)を隠さない。
//
//   **[2026-08-01 M54 で接続] 拠点操作 4 コマンド**(`establishOutpost`/
//   `abandonOutpost`/`stationResident`/`unstationResident`。M50 で実装済み)を
//   本画面へ結線した。設置は本ファイル `nextOutpostId`(施設 ID 採番=
//   `grid/facilityId.ts` と同型)で ID を発行する。以前の「表示専用」注記は
//   本タスクで解消したため削除した。
//
// ===========================================================================
// 2. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   常駐者候補は寿命/派遣中で絞り込まない(`ResidentsScreen.tsx` §3 と同じ
//   立場: 死亡/派遣中の住民でも選択自体はできる状態にし、実際に押せるかは
//   `establishOutpost`/`stationResident` の `residentUnavailable` reject に
//   委ねる)。常駐 1〜4 名・重複なし等も同様に先読みしない。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import { compareUtf16 } from "../../../engine/canonicalize";
import type { CommandRejection } from "../../../engine/commands";
import type { DistanceBand } from "../../../engine/rules/types";
import { type EntityId } from "../../../engine/state/state";
import type { OutpostRosterEntry, ResidentView } from "../../derived";
import {
  distanceBandLabel,
  outpostDisplayLabel,
  outpostTypeLabel,
  residentDisplayName,
  resourceLabel,
} from "../contentLabels";
import { formatGameClock, formatRatePerMinute } from "../format";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useToastStack, ToastStackView } from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import { nextOutpostId } from "./outpostId";
import "./outpostsScreen.css";

/** GDD 9.2 の読み順(近郊→遠隔→深部)。`DISTANCE_BANDS` は UTF-16 昇順
 * (deep/far/near)なので、`ExpeditionScreen.tsx` の `BAND_ORDER` と同じく
 * 表示専用にここで並べ直す。 */
const OUTPOST_BAND_ORDER: readonly DistanceBand[] = ["near", "far", "deep"];

// --- 1. 拠点カード(hooks 不使用・直接テスト可能) ----------------------------

export interface OutpostCardProps {
  readonly outpost: OutpostRosterEntry;
  /** [M54] この拠点へ新たに駐在させられる住民の一覧(判定は書かない・§2)。 */
  readonly residentOptions: readonly ResidentView[];
  /** [M54] 駐在させる住民セレクトの選択中の値("" = 未選択)。 */
  readonly stationSelectValue: EntityId | "";
  readonly onStationSelectChange: (residentId: EntityId | "") => void;
  readonly onStation: () => void;
  readonly onUnstation: (residentId: EntityId) => void;
  /**
   * [M61/FC8] 放棄の確認1段(`MigrationScreen.tsx` の `confirming` と同型)。
   * このコンポーネント自身は hooks を持たない(既存方針を維持)ので、確認中か
   * どうかの状態は親(`OutpostsScreen`)が持ち、拠点IDごとの開閉を props で渡す。
   */
  readonly confirmingAbandon: boolean;
  /** 「この拠点を放棄する」の初回タップ(確認パネルを開くだけ・まだ実行しない)。 */
  readonly onAbandonStart: () => void;
  /** 確認パネルの「実行する」。 */
  readonly onAbandonConfirm: () => void;
  /** 確認パネルの「キャンセル」。 */
  readonly onAbandonCancel: () => void;
}

export function OutpostCard({
  outpost,
  residentOptions,
  stationSelectValue,
  onStationSelectChange,
  onStation,
  onUnstation,
  confirmingAbandon,
  onAbandonStart,
  onAbandonConfirm,
  onAbandonCancel,
}: OutpostCardProps) {
  function handleStationSelectChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    onStationSelectChange(value === "" ? "" : (value as EntityId));
  }

  return (
    <li class="kf-outpost-card">
      <h4 class="kf-outpost-card__title">
        {/* [M61/FC5・R1-A17] outpostId の生露出("農園(outpostFarm1)")を
            outpostDisplayLabel(和名+連番+号)へ。 */}
        {outpostDisplayLabel(outpost.outpostId, outpost.outpostTypeId)}・Lv{outpost.level}・
        {distanceBandLabel(outpost.band)}
      </h4>
      {outpost.residentIds.length === 0 ? (
        <p class="kf-outpost-card__residents">常駐: 無し</p>
      ) : (
        <ul class="kf-outpost-card__resident-list" aria-label="常駐している住民">
          {outpost.residentIds.map((residentId) => (
            <li key={residentId} class="kf-outpost-card__resident-row">
              <span class="kf-outpost-card__resident-name">{residentDisplayName(residentId)}</span>
              <button
                type="button"
                class="kf-outpost-card__unstation-button"
                onClick={() => onUnstation(residentId)}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="kf-outpost-card__station-row">
        <label class="kf-outpost-card__station-label">
          駐在させる
          <select
            class="kf-outpost-card__station-select"
            value={stationSelectValue}
            onChange={handleStationSelectChange}
          >
            <option value="">(住民を選ぶ)</option>
            {residentOptions.map((resident) => (
              <option key={resident.entityId} value={resident.entityId}>
                {residentDisplayName(resident.entityId)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" class="kf-outpost-card__station-button" onClick={onStation}>
          駐在させる
        </button>
      </div>
      <p class="kf-outpost-card__established">設置: {formatGameClock(outpost.establishedTick)}</p>
      {/* [M62/FC4・R2-D01] 内部語「/tick」を「/分」へ(tick=1分・GDD 11.1)。
          formatRatePerMinute 経由で資源在庫表示(formatResourceAmount)と桁の
          整形を統一する(R2-FC9: 薪だけ小数第1位が付く不統一の解消)。 */}
      <p class="kf-outpost-card__supply">
        供給: {formatRatePerMinute(outpost.supplyApprox)} {resourceLabel(outpost.resourceId)}
      </p>
      <p class="kf-outpost-card__upkeep">維持費: {formatRatePerMinute(outpost.upkeepApprox)}</p>
      <p class="kf-outpost-card__net">
        ネット収益: {formatRatePerMinute(outpost.netRevenueApprox)}
        {outpost.netRevenueApprox < 0 ? "(維持費が供給を上回っています・放棄を検討)" : ""}
      </p>
      <p class="kf-outpost-card__hazard">
        危険度: {(outpost.hazardApprox * 100).toFixed(1)}
        %(常駐中に(B)一回性喪失の資産を失う確率の目安)
      </p>
      <p class="kf-outpost-card__loss" data-testid="outpost-b-loss">
        (B)喪失リスク: 期待損失 {outpost.expectedRareLossApprox.toFixed(2)}
        (対象 (B) 資産 {outpost.rareAssetCount} 件)
      </p>
      <p class="kf-outpost-card__roi">
        {/* [M73/R8-08] 英語の金融用語「ROI」を落とす(⑦探索本部と同じ和語化)。 */}
        採算(投資効率):{" "}
        {outpost.roiApprox === null
          ? "算出できません(比べる相手が0のため)"
          : outpost.roiApprox.toFixed(2)}
      </p>
      {/* [M61/FC8・R1-D05] 拠点放棄が確認0段(即時実行)だった。大移動(1段)・
          最初からやり直す(2段)と同じ「取り消せない操作は必ず確認を挟む」形へ
          揃える。1段(大移動と同型)を採用——拠点放棄は個々の拠点1件の喪失で、
          全周回データを失う「最初からやり直す」ほどの重大度ではない★判断。 */}
      {!confirmingAbandon ? (
        <button type="button" class="kf-outpost-card__abandon-button" onClick={onAbandonStart}>
          この拠点を放棄する
        </button>
      ) : (
        <section
          class="kf-outpost-card__abandon-confirm"
          role="alertdialog"
          aria-label="拠点放棄の確認"
        >
          <p class="kf-outpost-card__abandon-confirm-message">
            本当によろしいですか。この操作は取り消せません。常駐中の住民は解除され、この拠点からの
            供給は無くなります。
          </p>
          <div class="kf-outpost-card__abandon-confirm-actions">
            <button
              type="button"
              class="kf-outpost-card__abandon-confirm-button"
              onClick={onAbandonConfirm}
            >
              実行する(取り消せません)
            </button>
            <button
              type="button"
              class="kf-outpost-card__abandon-cancel-button"
              onClick={onAbandonCancel}
            >
              キャンセル
            </button>
          </div>
        </section>
      )}
    </li>
  );
}

// --- 2. 新規設置フォーム(hooks 不使用・直接テスト可能) ----------------------

export interface OutpostEstablishFormProps {
  /** content の outpostType 定義 ID 一覧(ID 昇順)。0 件 = 設置システムが不活性。 */
  readonly outpostTypeOptions: readonly EntityId[];
  readonly selectedTypeId: EntityId | null;
  readonly onTypeChange: (typeId: EntityId) => void;
  readonly band: DistanceBand;
  readonly onBandChange: (band: DistanceBand) => void;
  readonly residentOptions: readonly ResidentView[];
  readonly selectedResidentIds: ReadonlySet<EntityId>;
  readonly onToggleResident: (residentId: EntityId) => void;
  readonly onSubmit: () => void;
}

export function OutpostEstablishForm({
  outpostTypeOptions,
  selectedTypeId,
  onTypeChange,
  band,
  onBandChange,
  residentOptions,
  selectedResidentIds,
  onToggleResident,
  onSubmit,
}: OutpostEstablishFormProps) {
  if (outpostTypeOptions.length === 0) {
    return <p class="kf-outposts-establish__inactive">現在のデータでは拠点を設置できません。</p>;
  }

  function handleTypeChange(event: Event): void {
    onTypeChange((event.target as HTMLSelectElement).value as EntityId);
  }

  return (
    <section class="kf-outposts-establish" aria-label="新しい拠点を設置">
      <h3 class="kf-outposts-establish__title">新しい拠点を設置</h3>
      <label class="kf-outposts-establish__type-label">
        拠点タイプ
        <select
          class="kf-outposts-establish__type-select"
          value={selectedTypeId ?? ""}
          onChange={handleTypeChange}
        >
          {outpostTypeOptions.map((typeId) => (
            <option key={typeId} value={typeId}>
              {outpostTypeLabel(typeId)}
            </option>
          ))}
        </select>
      </label>
      <ul class="kf-outposts-establish__band-list" aria-label="距離帯">
        {OUTPOST_BAND_ORDER.map((option) => (
          <li key={option}>
            <button
              type="button"
              class="kf-outposts-establish__band-button"
              aria-pressed={option === band}
              onClick={() => onBandChange(option)}
            >
              {distanceBandLabel(option)}
            </button>
          </li>
        ))}
      </ul>
      <p class="kf-outposts-establish__resident-count">
        常駐させる住民({selectedResidentIds.size}/4名まで選択)
      </p>
      <ul class="kf-outposts-establish__resident-list" aria-label="常駐させる住民">
        {residentOptions.map((resident) => (
          <li key={resident.entityId}>
            <button
              type="button"
              class="kf-outposts-establish__resident-button"
              aria-pressed={selectedResidentIds.has(resident.entityId)}
              onClick={() => onToggleResident(resident.entityId)}
            >
              {residentDisplayName(resident.entityId)}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" class="kf-outposts-establish__submit-button" onClick={onSubmit}>
        設置する
      </button>
    </section>
  );
}

// --- 3. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function OutpostsScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "outposts", { activate: false });

  const overview = useSignalValue(store.derived.outpostOverview);
  const residents = useSignalValue(store.derived.residents);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const toastStack = useToastStack();

  // content は起動後に差し替わらないので非追跡の peek で読む(他画面前例どおり)。
  const content = store.peekContent();
  const outpostTypeIds: readonly EntityId[] =
    content.outpostTypeDefs === undefined
      ? []
      : [...content.outpostTypeDefs.keys()].sort(compareUtf16);

  const [establishTypeId, setEstablishTypeId] = useState<EntityId | null>(null);
  const [establishBand, setEstablishBand] = useState<DistanceBand>("near");
  const [establishResidentIds, setEstablishResidentIds] = useState<ReadonlySet<EntityId>>(
    () => new Set(),
  );
  const [stationSelections, setStationSelections] = useState<ReadonlyMap<EntityId, EntityId | "">>(
    () => new Map(),
  );
  // [M61/FC8] 放棄確認が開いている拠点ID(1件だけ・MigrationScreen.tsxの
  // confirmingと同じくbooleanでもよいが、拠点は複数枚のカードが並ぶため
  // 「どのカードが開いているか」をIDで持つ)。
  const [confirmingAbandonId, setConfirmingAbandonId] = useState<EntityId | null>(null);

  const effectiveEstablishTypeId = establishTypeId ?? outpostTypeIds[0] ?? null;

  function handleToggleEstablishResident(residentId: EntityId): void {
    setEstablishResidentIds((current) => {
      const next = new Set(current);
      if (next.has(residentId)) next.delete(residentId);
      else next.add(residentId);
      return next;
    });
  }

  function handleEstablish(): void {
    if (effectiveEstablishTypeId === null) return; // 設置対象の型が無い(content 不活性)。
    const outpostId = nextOutpostId(store.peekState(), effectiveEstablishTypeId);
    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "establishOutpost",
        outpostId,
        outpostTypeId: effectiveEstablishTypeId,
        band: establishBand,
        residentIds: [...establishResidentIds],
      },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    setEstablishResidentIds(new Set());
    // [M61/FC5] outpostId の生露出("outpostFarm1")を outpostDisplayLabel へ。
    toastStack.push(`${outpostDisplayLabel(outpostId, effectiveEstablishTypeId)}を設置した`);
  }

  // [M61/FC8] 「放棄する」初回タップ = 確認パネルを開くだけ(まだ dispatch しない)。
  function handleAbandonStart(outpostId: EntityId): void {
    setConfirmingAbandonId(outpostId);
    setLastRejection(null);
  }

  function handleAbandonCancel(): void {
    setConfirmingAbandonId(null);
  }

  function handleAbandonConfirm(outpost: OutpostRosterEntry): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "abandonOutpost", outpostId: outpost.outpostId },
    });
    setConfirmingAbandonId(null);
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    toastStack.push(`${outpostDisplayLabel(outpost.outpostId, outpost.outpostTypeId)}を放棄した`);
  }

  function handleUnstation(residentId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "unstationResident", residentId },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    toastStack.push(`${residentDisplayName(residentId)}の駐在を解除した`);
  }

  function handleStationSelectChange(outpostId: EntityId, residentId: EntityId | ""): void {
    setStationSelections((current) => {
      const next = new Map(current);
      next.set(outpostId, residentId);
      return next;
    });
  }

  function handleStation(outpostId: EntityId): void {
    const residentId = stationSelections.get(outpostId) ?? "";
    if (residentId === "") return; // 未選択(判定ではなく入力の欠落)。
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "stationResident", residentId, outpostId },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    setStationSelections((current) => {
      const next = new Map(current);
      next.delete(outpostId);
      return next;
    });
    // [M61/FC5] outpostId の生露出を outpostDisplayLabel へ(型が引けない
    // 万一のケースは raw ID を出さず「この拠点」に倒す・捏造しない)。
    const outpostTypeId = overview.roster.find(
      (entry) => entry.outpostId === outpostId,
    )?.outpostTypeId;
    const outpostLabel =
      outpostTypeId === undefined ? "この拠点" : outpostDisplayLabel(outpostId, outpostTypeId);
    toastStack.push(`${residentDisplayName(residentId)}を${outpostLabel}へ駐在させた`);
  }

  return (
    <section class="kf-outposts-screen" aria-labelledby="kf-outposts-screen-title">
      <h2 class="kf-outposts-screen__title" id="kf-outposts-screen-title">
        衛星拠点管理
      </h2>
      <p class="kf-screen-intro">
        本拠の外に置いた採取拠点(鉱山/農園/林)の供給・維持費・常駐者を失う危険度をまとめて確認します。
      </p>

      <ToastStackView toasts={toastStack.toasts} />

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      <section class="kf-outposts-screen__network" aria-label="拠点網の採算">
        <p class="kf-outposts-screen__network-count">拠点数: {overview.network.outpostCount}</p>
        <p class="kf-outposts-screen__network-supply">
          合計供給: {formatRatePerMinute(overview.network.totalSupplyApprox)}
        </p>
        <p class="kf-outposts-screen__network-upkeep">
          合計維持費: {formatRatePerMinute(overview.network.totalUpkeepApprox)}
        </p>
        <p class="kf-outposts-screen__network-net">
          合計ネット収益: {formatRatePerMinute(overview.network.totalNetRevenueApprox)}
        </p>
        <p class="kf-outposts-screen__network-loss" data-testid="outpost-network-b-loss">
          拠点網の(B)喪失リスク合計: {overview.network.totalExpectedRareLossApprox.toFixed(2)}
        </p>
        <p class="kf-outposts-screen__network-roi">
          拠点網全体の採算(投資効率):{" "}
          {overview.network.roiApprox === null
            ? "算出できません(比べる相手が0のため)"
            : overview.network.roiApprox.toFixed(2)}
        </p>
      </section>

      <OutpostEstablishForm
        outpostTypeOptions={outpostTypeIds}
        selectedTypeId={effectiveEstablishTypeId}
        onTypeChange={setEstablishTypeId}
        band={establishBand}
        onBandChange={setEstablishBand}
        residentOptions={residents}
        selectedResidentIds={establishResidentIds}
        onToggleResident={handleToggleEstablishResident}
        onSubmit={handleEstablish}
      />

      {overview.roster.length === 0 ? (
        <p class="kf-outposts-screen__empty">拠点はまだありません。</p>
      ) : (
        <ul class="kf-outposts-screen__list">
          {overview.roster.map((outpost) => (
            <OutpostCard
              key={outpost.outpostId}
              outpost={outpost}
              residentOptions={residents}
              stationSelectValue={stationSelections.get(outpost.outpostId) ?? ""}
              onStationSelectChange={(residentId) =>
                handleStationSelectChange(outpost.outpostId, residentId)
              }
              onStation={() => handleStation(outpost.outpostId)}
              onUnstation={handleUnstation}
              confirmingAbandon={confirmingAbandonId === outpost.outpostId}
              onAbandonStart={() => handleAbandonStart(outpost.outpostId)}
              onAbandonConfirm={() => handleAbandonConfirm(outpost)}
              onAbandonCancel={handleAbandonCancel}
            />
          ))}
        </ul>
      )}

      <div class="kf-outposts-screen__nav">
        <button
          type="button"
          class="kf-outposts-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          住民一覧へ
        </button>
        <button
          type="button"
          class="kf-outposts-screen__nav-button"
          onClick={() => onNavigate("expedition")}
        >
          探索本部へ
        </button>
      </div>
    </section>
  );
}
