// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑨衛星拠点管理(M32)— GDD 9.2 / 11.4-7
//
// ===========================================================================
// 1. このファイルがやること・やらないこと(★要ユーザー判断・最終報告参照)
// ===========================================================================
//   拠点一覧(3タイプ)・供給レート・維持費・hazard・拠点網 ROI の**表示**。
//   `rules/outpost.ts` の `outpostNetworkRoi` をそのまま呼ぶ(derived.ts の
//   `outpostOverview`)。(B) 損失項(`expectedRareLossApprox`)を隠さない。
//
//   **駐在割当/解除のコマンドは engine に実装されていない。**
//   `src/engine/commands.ts` の `IMPLEMENTED_COMMAND_KINDS` に拠点系コマンドは
//   1 つも無く(語彙予約すら無い)、拠点を作る・住民を配属する・解除する手段が
//   engine に存在しない(state 上は `OutpostState` を直接組み立てるテスト
//   フィクスチャでしか登場しない)。タスク指示「コマンド発行はengine実装済みの
//   範囲のみ(無いものはUIを作らず★報告)」に従い、本画面は**表示専用**とし、
//   駐在割当/解除・拠点設置/放棄のボタンは 1 つも置かない。詳細は最終報告の
//   ★項目を参照。
// ---------------------------------------------------------------------------

import type { OutpostRosterEntry } from "../../derived";
import { distanceBandLabel, outpostTypeLabel, resourceLabel } from "../contentLabels";
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
        常駐: {outpost.residentIds.length > 0 ? outpost.residentIds.join("・") : "無し"}
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
        hazard: {(outpost.hazardApprox * 100).toFixed(1)}%(駐在員が (B) 資産を失う期待確率・GDD 9.2)
      </p>
      <p class="kf-outpost-card__loss" data-testid="outpost-b-loss">
        (B)喪失リスク: 期待損失 {outpost.expectedRareLossApprox.toFixed(2)}
        (対象 (B) 資産 {outpost.rareAssetCount} 件)
      </p>
      <p class="kf-outpost-card__roi">
        ROI: {outpost.roiApprox === null ? "算出不可(分母0)" : outpost.roiApprox.toFixed(2)}
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

      <section class="kf-outposts-screen__network" aria-label="拠点網 ROI">
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
          拠点網 ROI(GDD 11.4-7):{" "}
          {overview.network.roiApprox === null
            ? "算出不可(分母0)"
            : overview.network.roiApprox.toFixed(2)}
        </p>
      </section>

      <p class="kf-outposts-screen__note">
        駐在割当/解除・拠点の設置/放棄は現行 engine
        に未実装のため、本画面は表示専用です(★要ユーザー判断・最終報告参照)。
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
