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
// 2. 増築コストについて(★ 要ユーザー判断・architecture.md §9-5 の追認)
// ===========================================================================
//   GDD 12.1 の facility スキーマにコスト項が無く、`upgradeFacility` は
//   現行実装で資源を 1 つも消費しない(architecture.md §9 の要ユーザー判断 5)。
//   本画面はこれを**捏造せず正直に表示する**(「コストなし」と明記し、実在
//   しないコスト内訳をでっち上げない)。コスト項をどこへ足すかは M50 の担当。
//
// ===========================================================================
// 3. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   増築ボタンは Lv 上限に達していても**非活性にしない**——上限判定も
//   engine の `apply` が返す `levelAtMax` reject に委ねる(7箇条目が「上限」を
//   名指しで挙げている)。押した結果は `RejectionBanner` で見せる。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import type { EntityId } from "../../../engine/state/state";
import type { FacilityDetailView, FacilityWorkerView } from "../../derived";
import { facilityLabel, resourceLabel } from "../contentLabels";
import { CellBreakdownView } from "../grid/CellBreakdownView";
import "../grid/gridBoard.css";
import { TagChip } from "../grid/TagChip";
import { TagIconDefs } from "../grid/TagIcons";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
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
      <span class="kf-facility-detail__worker-id">{worker.residentId}</span>
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
          増築コスト: 現行の engine 実装では資源を消費しません(コスト項が content
          スキーマに未実装・要ユーザー判断)
        </p>
        <button type="button" class="kf-facility-detail__upgrade-button" onClick={onUpgrade}>
          Lv{detail.level + 1}へ増築
        </button>
      </div>
    </section>
  );
}

// --- 3. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function FacilityScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "facility", { activate: false });

  const detail = useSignalValue(store.derived.selectedFacilityDetail);
  const breakdown = useSignalValue(store.derived.selectedCellBreakdown);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);

  function handleUpgrade(facilityId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "upgradeFacility", facilityId },
    });
    setLastRejection(
      result.command !== null && !result.command.ok ? result.command.rejection : null,
    );
  }

  return (
    <section class="kf-facility-screen" aria-labelledby="kf-facility-screen-title">
      <h2 class="kf-facility-screen__title" id="kf-facility-screen-title">
        施設詳細/増築
      </h2>

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {detail === null ? (
        <p class="kf-facility-screen__empty">
          施設が選択されていません。②格子ビューで施設をタップして選択してください。
        </p>
      ) : (
        <>
          <FacilityDetailPanel detail={detail} onUpgrade={() => handleUpgrade(detail.facilityId)} />
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
