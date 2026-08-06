// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑪継承点購入(M33)— GDD 10.3 / 11.4-6
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   3系統(`INHERIT_TRACKS`・state.ts)の現在段数・次段コスト・上限段・
//   1段あたりのボーナス・現在のボーナス反映量を表示し、`purchaseInheritBonus`
//   を発行する。数値は全て `rules/exodus.ts` の既存関数(`inheritTierOf` は
//   state.ts・`inheritTierCost`/`inheritTierMax`/`inheritBonusOf`/
//   `availableInheritPoints`/`spentInheritPoints` は rules/exodus.ts)を
//   そのまま呼ぶだけで、UI 側に式を 1 つも書き直さない。
//
// ===========================================================================
// 2. 判定は書かない(architecture.md §6)
// ===========================================================================
//   購入ボタンは「上限段に達している(構造的事実)」場合のみ非活性にする
//   (`inheritTierCost` が null を返す = これ以上買いようがない)。**残高が
//   足りるかは先読みしない**——足りなければ engine が
//   `insufficientInheritPoints` で拒否し、`RejectionBanner` で見せる。
//
// ===========================================================================
// 3. 継承点獲得時のバックアップリマインドは⑩大移動画面が担う
// ===========================================================================
//   GDD 13.4「バックアップリマインド導線(大移動/継承点獲得時)」の「継承点
//   獲得」は `executeExodus` の成功時にしか起きない(この画面の
//   `purchaseInheritBonus` は獲得ではなく**消費**)ので、獲得時の導線は
//   ⑩大移動画面(`MigrationScreen.tsx` §3)に実装してある。ここで「獲得した」
//   という誤った文言を出さないよう、購入成功時のメッセージは「購入しました」
//   に留める。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import {
  availableInheritPoints,
  earnedInheritPoints,
  inheritBonusOf,
  inheritTierCost,
  inheritTierMax,
  spentInheritPoints,
} from "../../../engine/rules/exodus";
import type { ExodusParams } from "../../../engine/rules/types";
import { INHERIT_TRACKS, inheritTierOf, type InheritTrack } from "../../../engine/state/state";
import { inheritTrackLabel } from "../contentLabels";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount } from "../useStoreSignal";
import "./inheritanceScreen.css";

// --- 1. 1 行(hooks 不使用・直接テスト可能) ----------------------------------

export interface InheritTrackRowProps {
  readonly track: InheritTrack;
  readonly currentTier: number;
  readonly maxTier: number;
  readonly currentBonus: number;
  readonly bonusPerTier: number;
  /** `null` = 上限段に達していて次の段が無い。 */
  readonly nextCost: number | null;
  /** [束B/B-4] 残高不足で確実に失敗するか(判定ではなく表示上の目印)。 */
  readonly insufficientBalance: boolean;
  /**
   * [M73/R8-06] 現在の残高。**不足量を「あと何点」の形で言う**ために渡す
   * (Round 8: 初回周回は獲得49点に対し3項目とも1段目50点で、何一つ買えないうえ
   * 不足量も次の周回で届くのかも手がかりが無かった)。省略時は不足量を出さない。
   */
  readonly availablePoints?: number | null;
  /**
   * [M73/R8-06] いま大移動した場合に得られる継承点(engine の
   * `earnedInheritPoints` の値)。「次の周回で届く見込み」を**捏造せずに**言う
   * ための材料であり、`残高 + これ >= 次段コスト` なら届く見込みと言える。
   * 省略時はその一文を出さない。
   */
  readonly earnedIfExodusNow?: number | null;
  readonly onPurchase: (track: InheritTrack) => void;
}

/**
 * [束B/B-4] 上限段(`nextCost === null`)は構造的事実なので従来どおり
 * `disabled` で非活性にする。**残高不足はそうではない**(先読みしない方針・
 * §2)ので、非活性にはせず淡色化 + aria-disabled + 理由の併記に留める。
 */
export function InheritTrackRow({
  track,
  currentTier,
  maxTier,
  currentBonus,
  bonusPerTier,
  nextCost,
  insufficientBalance,
  availablePoints = null,
  earnedIfExodusNow = null,
  onPurchase,
}: InheritTrackRowProps) {
  const atMax = nextCost === null;
  const willFail = !atMax && insufficientBalance;
  // [M73/R8-06] 不足量(あと何点)と、次の周回で届く見込みかどうか。
  const shortfall =
    nextCost === null || availablePoints === null ? null : Math.max(0, nextCost - availablePoints);
  const reachableNextRun =
    nextCost === null || availablePoints === null || earnedIfExodusNow === null
      ? null
      : availablePoints + earnedIfExodusNow >= nextCost;
  return (
    <li class="kf-inherit-row" data-track={track}>
      <h3 class="kf-inherit-row__title">{inheritTrackLabel(track)}</h3>
      <p class="kf-inherit-row__tier">
        段階 {currentTier}/{maxTier}(現在ボーナス +{currentBonus}・1段あたり +{bonusPerTier})
      </p>
      <p class="kf-inherit-row__cost">
        {atMax
          ? "上限段に達しています(これ以上は購入できません)"
          : `次の1段のコスト: ${nextCost}点`}
      </p>
      {willFail && (
        <p class="kf-inherit-row__insufficient">
          {shortfall === null
            ? "残高が足りません。押しても購入できません。"
            : `残高があと${String(shortfall)}点足りません。押しても購入できません。`}
          {/* [M73/R8-06] 「次の周回で届くのか」を engine の獲得式
              (`earnedInheritPoints`)から言う。獲得見込みは今の盤面(到達エラ・
              成文化率・生存住民数)で決まるので、届かない場合は何を伸ばせばよいかも
              添える(数値の調整そのものは content 側の担当)。 */}
          {reachableNextRun === true &&
            earnedIfExodusNow !== null &&
            `いま大移動すると+${String(earnedIfExodusNow)}点なので、次の周回では購入できる見込みです。`}
          {reachableNextRun === false &&
            earnedIfExodusNow !== null &&
            `いま大移動しても+${String(earnedIfExodusNow)}点なので、次の周回でもまだ届きません(成文化を進める・住民を増やす・より先の時代へ到達すると獲得点が増えます)。`}
        </p>
      )}
      <button
        type="button"
        class={
          willFail
            ? "kf-inherit-row__button kf-inherit-row__button--unlikely"
            : "kf-inherit-row__button"
        }
        disabled={atMax}
        aria-disabled={willFail}
        onClick={() => onPurchase(track)}
      >
        {atMax ? "上限" : "購入する"}
      </button>
    </li>
  );
}

// --- 2. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function InheritanceScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "inheritance", { activate: false });

  const content = store.peekContent();
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const [purchasedTrack, setPurchasedTrack] = useState<InheritTrack | null>(null);

  if (content.exodus === undefined) {
    return (
      <section class="kf-inheritance-screen" aria-labelledby="kf-inheritance-screen-title">
        <h2 class="kf-inheritance-screen__title" id="kf-inheritance-screen-title">
          継承点購入
        </h2>
        <p class="kf-inheritance-screen__inactive">現在のデータでは継承点購入は使えません。</p>
        <div class="kf-inheritance-screen__nav">
          <button
            type="button"
            class="kf-inheritance-screen__nav-button"
            onClick={() => onNavigate("migration")}
          >
            大移動へ
          </button>
        </div>
      </section>
    );
  }
  const params: ExodusParams = content.exodus;
  const state = store.peekState();
  const available = availableInheritPoints(state, content);
  const cumulative = state.progression.cumulativeInheritPoints;
  const spent = spentInheritPoints(state.progression, params);
  const maxTier = inheritTierMax(params);
  // [M73/R8-06] いま大移動した場合の獲得点(engine の獲得式そのまま・GDD 10.3)。
  const earnedNow = earnedInheritPoints(state, content);

  function handlePurchase(track: InheritTrack): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "purchaseInheritBonus", track },
    });
    if (result.command === null) return;
    if (!result.command.ok) {
      setLastRejection(result.command.rejection);
      setPurchasedTrack(null);
      return;
    }
    setLastRejection(null);
    setPurchasedTrack(track);
  }

  return (
    <section class="kf-inheritance-screen" aria-labelledby="kf-inheritance-screen-title">
      <h2 class="kf-inheritance-screen__title" id="kf-inheritance-screen-title">
        継承点購入
      </h2>
      <p class="kf-screen-intro">
        大移動で得た継承点を使い、次の周回を有利にするボーナスを買います。
      </p>
      <p class="kf-inheritance-screen__balance">
        累計獲得: {cumulative}点・使用済み: {spent}点・残高: {available}点
      </p>

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}
      {purchasedTrack !== null && (
        <p class="kf-inheritance-screen__purchased" role="status">
          {inheritTrackLabel(purchasedTrack)}の継承ボーナスを購入しました。
        </p>
      )}

      <ul class="kf-inheritance-screen__list">
        {INHERIT_TRACKS.map((track) => {
          const nextCost = inheritTierCost(params, inheritTierOf(state, track));
          return (
            <InheritTrackRow
              key={track}
              track={track}
              currentTier={inheritTierOf(state, track)}
              maxTier={maxTier}
              currentBonus={inheritBonusOf(state, content, track)}
              bonusPerTier={params.trackBonusPerTier[track]}
              nextCost={nextCost}
              insufficientBalance={nextCost !== null && nextCost > available}
              availablePoints={available}
              earnedIfExodusNow={earnedNow}
              onPurchase={handlePurchase}
            />
          );
        })}
      </ul>

      <div class="kf-inheritance-screen__nav">
        <button
          type="button"
          class="kf-inheritance-screen__nav-button"
          onClick={() => onNavigate("migration")}
        >
          大移動へ
        </button>
      </div>
    </section>
  );
}
