// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑨衛星拠点管理(M32・束B/B-2で文言改訂)— GDD 9.2 / 11.4-7
//
// ===========================================================================
// 1. このファイルがやること・やらないこと
// ===========================================================================
//   拠点一覧(3タイプ)・供給レート・維持費・危険度(hazard)・拠点網 ROI の
//   **表示**。`rules/outpost.ts` の `outpostNetworkRoi` をそのまま呼ぶ
//   (derived.ts の `outpostOverview`)。(B) 損失項(`expectedRareLossApprox`)を
//   隠さない。
//
//   **[2026-08-01 M50 で engine 側は解消] 拠点操作コマンド(設置/放棄/駐在割当/
//   駐在解除の 4 種)は M50 が実装済み**(`commands.ts` の
//   `establishOutpost`/`abandonOutpost`/`stationResident`/`unstationResident`)。
//   ただし M50 は UI 非接触の縛りで実施されたため、**本画面からそれらを呼ぶ
//   結線はまだ無い**(表示専用のまま・次の UI タスクで接続予定)。以前の
//   「engine に未実装」という注記は M50 完了後の今は事実と異なるため削除した。
// ---------------------------------------------------------------------------

import type { OutpostRosterEntry } from "../../derived";
import {
  distanceBandLabel,
  outpostTypeLabel,
  residentDisplayName,
  resourceLabel,
} from "../contentLabels";
import { formatGameClock } from "../format";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./outpostsScreen.css";

// --- 1. 拠点カード(hooks 不使用・直接テスト可能) ----------------------------

export interface OutpostCardProps {
  readonly outpost: OutpostRosterEntry;
}

export function OutpostCard({ outpost }: OutpostCardProps) {
  return (
    <li class="kf-outpost-card">
      <h4 class="kf-outpost-card__title">
        {outpostTypeLabel(outpost.outpostTypeId)}({outpost.outpostId})・Lv{outpost.level}・
        {distanceBandLabel(outpost.band)}
      </h4>
      <p class="kf-outpost-card__residents">
        常駐:{" "}
        {outpost.residentIds.length > 0
          ? outpost.residentIds.map((residentId) => residentDisplayName(residentId)).join("・")
          : "無し"}
      </p>
      <p class="kf-outpost-card__established">設置: {formatGameClock(outpost.establishedTick)}</p>
      <p class="kf-outpost-card__supply">
        供給: {outpost.supplyApprox.toFixed(2)}/tick {resourceLabel(outpost.resourceId)}
      </p>
      <p class="kf-outpost-card__upkeep">維持費: {outpost.upkeepApprox.toFixed(2)}/tick</p>
      <p class="kf-outpost-card__net">
        ネット収益: {outpost.netRevenueApprox.toFixed(2)}/tick
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
        採算(ROI): {outpost.roiApprox === null ? "算出不可(分母0)" : outpost.roiApprox.toFixed(2)}
      </p>
    </li>
  );
}

// --- 2. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function OutpostsScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "outposts", { activate: false });

  const overview = useSignalValue(store.derived.outpostOverview);

  return (
    <section class="kf-outposts-screen" aria-labelledby="kf-outposts-screen-title">
      <h2 class="kf-outposts-screen__title" id="kf-outposts-screen-title">
        衛星拠点管理
      </h2>
      <p class="kf-screen-intro">
        本拠の外に置いた採取拠点(鉱山/農園/林)の供給・維持費・常駐者を失う危険度をまとめて確認します。
      </p>

      <section class="kf-outposts-screen__network" aria-label="拠点網の採算">
        <p class="kf-outposts-screen__network-count">拠点数: {overview.network.outpostCount}</p>
        <p class="kf-outposts-screen__network-supply">
          合計供給: {overview.network.totalSupplyApprox.toFixed(2)}/tick
        </p>
        <p class="kf-outposts-screen__network-upkeep">
          合計維持費: {overview.network.totalUpkeepApprox.toFixed(2)}/tick
        </p>
        <p class="kf-outposts-screen__network-net">
          合計ネット収益: {overview.network.totalNetRevenueApprox.toFixed(2)}/tick
        </p>
        <p class="kf-outposts-screen__network-loss" data-testid="outpost-network-b-loss">
          拠点網の(B)喪失リスク合計: {overview.network.totalExpectedRareLossApprox.toFixed(2)}
        </p>
        <p class="kf-outposts-screen__network-roi">
          拠点網全体の採算(ROI):{" "}
          {overview.network.roiApprox === null
            ? "算出不可(分母0)"
            : overview.network.roiApprox.toFixed(2)}
        </p>
      </section>

      <p class="kf-outposts-screen__note">
        拠点の操作(駐在の割当/解除、設置/放棄)は今後のアップデートで追加されます。
      </p>

      {overview.roster.length === 0 ? (
        <p class="kf-outposts-screen__empty">拠点はまだありません。</p>
      ) : (
        <ul class="kf-outposts-screen__list">
          {overview.roster.map((outpost) => (
            <OutpostCard key={outpost.outpostId} outpost={outpost} />
          ))}
        </ul>
      )}

      <div class="kf-outposts-screen__nav">
        <button
          type="button"
          class="kf-outposts-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          ④住民一覧へ
        </button>
        <button
          type="button"
          class="kf-outposts-screen__nav-button"
          onClick={() => onNavigate("expedition")}
        >
          ⑦探索本部へ
        </button>
      </div>
    </section>
  );
}
