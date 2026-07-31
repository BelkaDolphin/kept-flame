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
  readonly onPurchase: (track: InheritTrack) => void;
}

export function InheritTrackRow({
  track,
  currentTier,
  maxTier,
  currentBonus,
  bonusPerTier,
  nextCost,
  onPurchase,
}: InheritTrackRowProps) {
  const atMax = nextCost === null;
  return (
    <li class="kf-inherit-row" data-track={track}>
      <h3 class="kf-inherit-row__title">{inheritTrackLabel(track)}</h3>
      <p class="kf-inherit-row__tier">
        段階 {currentTier}/{maxTier}(現在ボーナス +{currentBonus}・1段あたり +{bonusPerTier})
      </p>
      <p class="kf-inherit-row__cost">
        {atMax ? "上限段に達しています(GDD 11.4-6 の青天井禁止)" : `次の1段のコスト: ${nextCost}点`}
      </p>
      <button
        type="button"
        class="kf-inherit-row__button"
        disabled={atMax}
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
        <p class="kf-inheritance-screen__inactive">
          content に exodus ブロックが無いので継承点購入は実行できません。
        </p>
        <div class="kf-inheritance-screen__nav">
          <button
            type="button"
            class="kf-inheritance-screen__nav-button"
            onClick={() => onNavigate("migration")}
          >
            ⑩大移動へ
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
      <p class="kf-inheritance-screen__balance">
        累計獲得: {cumulative}点・使用済み: {spent}点・残高: {available}点(GDD 10.3)
      </p>

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}
      {purchasedTrack !== null && (
        <p class="kf-inheritance-screen__purchased" role="status">
          {inheritTrackLabel(purchasedTrack)}の継承ボーナスを購入しました。
        </p>
      )}

      <ul class="kf-inheritance-screen__list">
        {INHERIT_TRACKS.map((track) => (
          <InheritTrackRow
            key={track}
            track={track}
            currentTier={inheritTierOf(state, track)}
            maxTier={maxTier}
            currentBonus={inheritBonusOf(state, content, track)}
            bonusPerTier={params.trackBonusPerTier[track]}
            nextCost={inheritTierCost(params, inheritTierOf(state, track))}
            onPurchase={handlePurchase}
          />
        ))}
      </ul>

      <div class="kf-inheritance-screen__nav">
        <button
          type="button"
          class="kf-inheritance-screen__nav-button"
          onClick={() => onNavigate("migration")}
        >
          ⑩大移動へ
        </button>
      </div>
    </section>
  );
}
