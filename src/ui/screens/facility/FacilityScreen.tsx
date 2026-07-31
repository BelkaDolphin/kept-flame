// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ③施設詳細/増築(M30)— GDD 6.1 / 6.5 / 6.7
//
// ===========================================================================
// 1. このファイルがやること
// ===========================================================================
//   選択中セル(②からの `cellSelected` 遷移)の施設について、Lv・産出・
//   就労者一覧・隣接内訳を表示し、`upgradeFacility` コマンドを発行する。
//   隣接内訳は **M19 の `CellBreakdownView`/`adjacencyBreakdown.ts` を
//   そのまま再利用**(タスク指示どおり・独自の内訳計算を書かない)。
//
// ===========================================================================
// 2. 増築コスト(束B/B-2・B-4 で解消)
// ===========================================================================
//   [2026-08-01 M50 で解消] `upgradeFacility` は content 定義の資源コストを
//   実際に消費するようになった(commands.ts §4 の [M50] payFacilityCost)。
//   束B では derived.ts に `upgradeCostApprox`/`upgradeCostResourceId` を足し、
//   このパネルが実額を表示する(以前の「コストなし」表記は M50 前の暫定実装の
//   名残であり、今は虚偽なので削除した)。
//
// ===========================================================================
// 3. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   増築ボタンは Lv 上限に達していても**非活性にしない**——上限判定も
//   engine の `apply` が返す `levelAtMax` reject に委ねる(7箇条目が「上限」を
//   名指しで挙げている)。押した結果は `RejectionBanner` で見せる。
//
// ===========================================================================
// 4. [束B/m-1] 未選択時は施設一覧から選ばせる
// ===========================================================================
//   `store.sources.selectedCellIndex` は画面をまたいでも保持される
//   (worldLoaded 以外でリセットされない・store.ts §1 の `CellSelectedEvent`
//   doc)ので、②で一度選んだ施設は③へ直接ナビしても表示され続ける。
//   本画面が追加するのは「一度も選んだことが無い」場合のフォールバックだけ:
//   ②へ強制送還する 1 行だけの案内に代えて、`facilityRoster` から選べる
//   一覧を出す(UX プレイテスト m-1)。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import type { FacilityDetailView, FacilityRosterEntry, FacilityWorkerView } from "../../derived";
import { facilityLabel, residentDisplayName, resourceLabel } from "../contentLabels";
import { CellBreakdownView } from "../grid/CellBreakdownView";
import "../grid/gridBoard.css";
import { TagChip } from "../grid/TagChip";
import { TagIconDefs } from "../grid/TagIcons";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { resourceDeltaPhrase, resourceStockApprox, useToastStack, ToastStackView } from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./facilityScreen.css";

// --- 1. 就労者 1 行(hooks 不使用・直接テスト可能) --------------------------

export interface FacilityWorkerRowProps {
  readonly worker: FacilityWorkerView;
}

/** 想起困難/派遣中/死亡tombstoneの状態表示(GDD 7.1/7.5/11.2・④と同じ語彙)。 */
export function FacilityWorkerRow({ worker }: FacilityWorkerRowProps) {
  const badges: string[] = [];
  if (!worker.alive) badges.push("死亡");
  if (worker.dispatched) badges.push("派遣中");
  if (worker.recallImpaired) badges.push("想起困難");
  return (
    <li class="kf-facility-detail__worker">
      <span class="kf-facility-detail__worker-id">{residentDisplayName(worker.residentId)}</span>
      <span class="kf-facility-detail__worker-morale">士気{worker.moraleApprox}</span>
      {badges.length > 0 && (
        <span class="kf-facility-detail__worker-badges">{badges.join("・")}</span>
      )}
    </li>
  );
}

// --- 2. 施設詳細パネル(hooks 不使用・直接テスト可能) ------------------------

export interface FacilityDetailPanelProps {
  readonly detail: FacilityDetailView;
  readonly onUpgrade: () => void;
}

export function FacilityDetailPanel({ detail, onUpgrade }: FacilityDetailPanelProps) {
  return (
    <section class="kf-facility-detail" aria-label="施設詳細">
      <TagIconDefs />
      <h3 class="kf-facility-detail__name">
        {facilityLabel(detail.defId)}({detail.cellId})
      </h3>
      <ul class="kf-facility-detail__tags">
        {detail.tags.map((tag) => (
          <li key={tag}>
            <TagChip tag={tag} />
          </li>
        ))}
      </ul>
      <p class="kf-facility-detail__level">
        Lv{detail.level} / 上限 Lv{detail.maxLevel}
      </p>
      <p class="kf-facility-detail__output">
        産出: {detail.outputPerTickApprox.toFixed(2)}/tick・
        {detail.outputKind === "resource" && detail.outputResourceId !== null
          ? resourceLabel(detail.outputResourceId)
          : "研究点"}
        (隣接乗数 ×{detail.multiplierApprox.toFixed(2)})
      </p>
      <p class="kf-facility-detail__slots">
        就労: {detail.workers.length}
        {detail.slotsMax !== null ? `/${String(detail.slotsMax)}` : "(上限なし)"}
      </p>
      <ul class="kf-facility-detail__workers">
        {detail.workers.length === 0 ? (
          <li class="kf-facility-detail__no-workers">就労者がいません</li>
        ) : (
          detail.workers.map((worker) => (
            <FacilityWorkerRow key={worker.residentId} worker={worker} />
          ))
        )}
      </ul>
      <div class="kf-facility-detail__upgrade">
        <p class="kf-facility-detail__upgrade-cost">
          {detail.upgradeCostApprox === null || detail.upgradeCostResourceId === null
            ? detail.level >= detail.maxLevel
              ? "既に上限Lvです。"
              : "増築コストはかかりません。"
            : `増築コスト: ${resourceLabel(detail.upgradeCostResourceId)} ${detail.upgradeCostApprox}`}
        </p>
        <button type="button" class="kf-facility-detail__upgrade-button" onClick={onUpgrade}>
          Lv{detail.level + 1}へ増築
        </button>
      </div>
    </section>
  );
}

// --- 2b. [束B/m-1] 未選択時の施設一覧(hooks 不使用・直接テスト可能) ---------

export interface FacilityPickerProps {
  readonly roster: readonly FacilityRosterEntry[];
  readonly onPick: (cellIndex: number) => void;
}

/**
 * 選択中の施設が無いときのフォールバック。②へ強制送還する案内だけでなく、
 * 既に建っている施設から直接選べるようにする(m-1)。
 */
export function FacilityPicker({ roster, onPick }: FacilityPickerProps) {
  if (roster.length === 0) {
    return (
      <p class="kf-facility-screen__empty">
        まだ施設がありません。②格子ビューでまず施設を建ててください。
      </p>
    );
  }
  return (
    <section class="kf-facility-picker" aria-label="施設を選ぶ">
      <p class="kf-screen-intro">
        施設が選択されていません。一覧から選ぶか、②格子ビューで施設をタップして選択してください。
      </p>
      <ul class="kf-facility-picker__list">
        {roster.map((facility) => (
          <li key={facility.facilityId}>
            <button
              type="button"
              class="kf-facility-picker__button"
              onClick={() => onPick(facility.cellIndex)}
            >
              {facilityLabel(facility.defId)}({facility.cellId})・Lv{facility.level}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- 3. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function FacilityScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "facility", { activate: false });

  const detail = useSignalValue(store.derived.selectedFacilityDetail);
  const breakdown = useSignalValue(store.derived.selectedCellBreakdown);
  const facilityRoster = useSignalValue(store.derived.facilityRoster);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const toastStack = useToastStack();

  function handleUpgrade(current: FacilityDetailView): void {
    const beforeStockApprox =
      current.upgradeCostResourceId === null
        ? null
        : resourceStockApprox(store.peekState(), current.upgradeCostResourceId);
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "upgradeFacility", facilityId: current.facilityId },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    const afterStockApprox =
      current.upgradeCostResourceId === null
        ? null
        : resourceStockApprox(store.peekState(), current.upgradeCostResourceId);
    const diff = resourceDeltaPhrase(
      current.upgradeCostResourceId,
      beforeStockApprox,
      afterStockApprox,
    );
    toastStack.push(
      `${facilityLabel(current.defId)}をLv${String(current.level + 1)}へ増築した${diff.length > 0 ? `(${diff})` : ""}`,
    );
  }

  function handlePickFacility(cellIndex: number): void {
    store.dispatch({ type: "cellSelected", cellIndex });
  }

  return (
    <section class="kf-facility-screen" aria-labelledby="kf-facility-screen-title">
      <h2 class="kf-facility-screen__title" id="kf-facility-screen-title">
        施設詳細/増築
      </h2>
      <p class="kf-screen-intro">選んだ施設の中身を見て、資源を払って増築します。</p>

      <ToastStackView toasts={toastStack.toasts} />

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {detail === null ? (
        <FacilityPicker roster={facilityRoster} onPick={handlePickFacility} />
      ) : (
        <>
          <FacilityDetailPanel detail={detail} onUpgrade={() => handleUpgrade(detail)} />
          <CellBreakdownView cellId={detail.cellId} breakdown={breakdown} includeIconDefs={false} />
        </>
      )}

      <div class="kf-facility-screen__nav">
        <button
          type="button"
          class="kf-facility-screen__nav-button"
          onClick={() => onNavigate("grid")}
        >
          ②格子ビューへ戻る
        </button>
        <button
          type="button"
          class="kf-facility-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          ④住民配置へ
        </button>
      </div>
    </section>
  );
}
