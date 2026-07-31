// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑦探索本部(M32)— GDD 8.1〜8.6
//
// ===========================================================================
// 1. このファイルがやること
// ===========================================================================
//   目的地(距離帯 + M22 event content があれば具体的な行き先)・チーム
//   1〜4名・方針(cautious/press)を選び、`dispatchExpedition` コマンドを発行
//   する。編成テンプレ(assist/exploration.ts の `suggestExpeditionTeams`)の
//   提案→確認表示→適用と、派遣前の ROI + (B) 損失リスク(GDD 8.6・本タスクの
//   検収条件そのもの)を持つ。
//
// ===========================================================================
// 2. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   チームが 1〜4 名か・寿命なし住民が混ざっていないか等は**先読みしない**。
//   候補一覧は `derived.ts` の `expeditionCandidates`(= 寿命なし住民を事前
//   除外した `assist/exploration.ts` の候補プール)を出すところまでで、
//   実際に押せるかどうかは `dispatchExpedition` の reject に委ねる。
//
// ===========================================================================
// 3. ROI プレビューは engine の唯一の実装をそのまま呼ぶ
// ===========================================================================
//   `derived.ts` の `previewExplorationRoi` が `rules/exploration.ts` の
//   `explorationRoi`(GDD 8.6 の式そのもの)を呼ぶだけであり、この画面は
//   Fix → 近似値の変換以外の計算を 1 つも持たない。
// ---------------------------------------------------------------------------

import { useMemo, useState } from "preact/hooks";

import {
  suggestExpeditionTeams,
  type TeamPlan,
  type TeamRequest,
} from "../../../engine/assist/exploration";
import type { CommandRejection } from "../../../engine/commands";
import { toApproxNumber } from "../../../engine/fp";
import {
  DISPATCH_TEAM_MAX,
  DISPATCH_TEAM_MIN,
  type ExplorationRoiReport,
} from "../../../engine/rules/exploration";
import type { DistanceBand } from "../../../engine/rules/types";
import { type DispatchStance, type EntityId } from "../../../engine/state/state";
import {
  explorationDestinationsForBand,
  previewExplorationRoi,
  type ExpeditionCandidateView,
  type ExpeditionDispatchView,
} from "../../derived";
import {
  distanceBandLabel,
  eventLabel,
  residentDisplayName,
  resourceLabel,
  traitLabel,
} from "../contentLabels";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import { formatGameClock } from "../format";
import { nextDispatchId } from "./dispatchId";
import { proceduralDestinationId } from "./destinationOptions";
import "./expeditionScreen.css";

/** GDD 8.1 の読み順(近郊→遠隔→深部)。`DISTANCE_BANDS`(rules/types.ts)は
 * UTF-16 昇順(deep/far/near)なので画面表示専用にここで並べ直す。 */
const BAND_ORDER: readonly DistanceBand[] = ["near", "far", "deep"];

/** GDD 8.3「撤退＝資源半分確保で以降ノード打ち切り安全帰還 / 強行＝全取得を
 * 狙うが失敗時の負傷リスク×1.5」をそのまま短縮した文言。 */
const STANCE_LABELS: { readonly [K in DispatchStance]: string } = {
  cautious: "撤退重視(安全帰還)",
  press: "強行(全取得を狙う)",
};

const TEAM_SIZE_OPTIONS: readonly number[] = [1, 2, 3, 4];

/**
 * [束B/B-3] 目的地の表示名。手続き生成フォールバック(`destinationOptions.ts`
 * の `proceduralDestinationId`・ID 末尾が固定で "Procedural")は具体的な
 * event が無いことの印であり、event 名として和名化しようとしない
 * (捏造しない)。それ以外は `eventLabel`(content/event.json 由来の和名)。
 */
function destinationDisplayName(destinationId: EntityId): string {
  const raw: string = destinationId;
  if (raw.endsWith("Procedural")) return "この距離帯のどこか";
  return eventLabel(destinationId);
}

// --- 1. 部品(hooks 不使用・直接テスト可能) ----------------------------------

export interface BandPickerProps {
  readonly band: DistanceBand;
  readonly onPick: (band: DistanceBand) => void;
}

export function BandPicker({ band, onPick }: BandPickerProps) {
  return (
    <ul class="kf-expedition__band-list" aria-label="目的地(距離帯)">
      {BAND_ORDER.map((option) => (
        <li key={option}>
          <button
            type="button"
            class="kf-expedition__band-button"
            aria-pressed={option === band}
            onClick={() => onPick(option)}
          >
            {distanceBandLabel(option)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface DestinationPickerProps {
  readonly options: readonly EntityId[];
  readonly destinationId: EntityId;
  readonly onPick: (destinationId: EntityId) => void;
}

/**
 * [束B/B-3] `procedural` フラグは受け取らない——手続き生成フォールバックかは
 * `destinationDisplayName` が ID 末尾から自分で判別できるため
 * (`options` そのものが呼び出し側で procedural 用の1件に絞られている)。
 */
export function DestinationPicker({ options, destinationId, onPick }: DestinationPickerProps) {
  return (
    <ul class="kf-expedition__destination-list" aria-label="目的地(具体的な行き先)">
      {options.map((option) => (
        <li key={option}>
          <button
            type="button"
            class="kf-expedition__destination-button"
            aria-pressed={option === destinationId}
            onClick={() => onPick(option)}
          >
            {/* [束B/B-3] procedural フォールバックの ID も destinationDisplayName が
                自分で判別する(末尾 "Procedural" の印)ので、ここでは分岐しない。 */}
            {destinationDisplayName(option)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface StancePickerProps {
  readonly stance: DispatchStance;
  readonly onPick: (stance: DispatchStance) => void;
}

export function StancePicker({ stance, onPick }: StancePickerProps) {
  return (
    <ul class="kf-expedition__stance-list" aria-label="方針">
      {(Object.keys(STANCE_LABELS) as DispatchStance[]).map((option) => (
        <li key={option}>
          <button
            type="button"
            class="kf-expedition__stance-button"
            aria-pressed={option === stance}
            onClick={() => onPick(option)}
          >
            {STANCE_LABELS[option]}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface CandidateRowProps {
  readonly candidate: ExpeditionCandidateView;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: (entityId: EntityId) => void;
}

export function CandidateRow({ candidate, selected, disabled, onToggle }: CandidateRowProps) {
  return (
    <li class="kf-expedition__candidate">
      <button
        type="button"
        class="kf-expedition__candidate-button"
        aria-pressed={selected}
        disabled={disabled && !selected}
        onClick={() => onToggle(candidate.entityId)}
      >
        <span class="kf-expedition__candidate-id">{residentDisplayName(candidate.entityId)}</span>
        <span class="kf-expedition__candidate-power">戦力{candidate.combatPowerApprox}</span>
        <span class="kf-expedition__candidate-morale">士気{candidate.moraleApprox}</span>
        {candidate.traitIds.length > 0 && (
          <span class="kf-expedition__candidate-traits">
            {candidate.traitIds.map((traitId) => traitLabel(traitId)).join("・")}
          </span>
        )}
      </button>
    </li>
  );
}

export interface RoiPanelProps {
  readonly report: ExplorationRoiReport | null;
  readonly rewardResourceId: EntityId | null;
  /** [束B/m-8] 現在選ばれているチーム人数(0 人なら予測の代わりに案内を出す)。 */
  readonly teamSize: number;
}

/** ROI と(B)損失リスク項(本タスクの検収条件)。 */
export function RoiPanel({ report, rewardResourceId, teamSize }: RoiPanelProps) {
  if (teamSize === 0) {
    return <p class="kf-expedition__roi-inactive">住民を選ぶと予測を表示します。</p>;
  }
  if (report === null) {
    return (
      <p class="kf-expedition__roi-inactive">現在のデータでは派遣前の見込みを算出できません。</p>
    );
  }
  return (
    <section class="kf-expedition__roi" aria-label="派遣前 ROI">
      <p class="kf-expedition__roi-reward">
        期待報酬: {toApproxNumber(report.expectedRewardFix).toFixed(2)}
        {rewardResourceId !== null ? resourceLabel(rewardResourceId) : ""}
      </p>
      <p class="kf-expedition__roi-forgone">
        逸失生産(機会費用): {toApproxNumber(report.forgoneOutputFix).toFixed(2)}
      </p>
      <p class="kf-expedition__roi-loss" data-testid="expedition-b-loss">
        (B)喪失リスク: 期待損失 {toApproxNumber(report.expectedRareLossFix).toFixed(2)}
        (対象 (B) 資産 {report.rareAssetCount} 件・全滅確率{" "}
        {(toApproxNumber(report.wipeProbabilityFix) * 100).toFixed(1)}%)
      </p>
      <p class="kf-expedition__roi-value">
        ROI: {report.roiFix === null ? "算出不可(分母0)" : toApproxNumber(report.roiFix).toFixed(2)}
      </p>
      <p class="kf-expedition__roi-travel">往復所要: {report.travelTicks} tick</p>
    </section>
  );
}

export interface DispatchRowProps {
  readonly dispatch: ExpeditionDispatchView;
}

export function DispatchRow({ dispatch }: DispatchRowProps) {
  return (
    <li class="kf-expedition__dispatch-row">
      <p class="kf-expedition__dispatch-head">
        {distanceBandLabel(dispatch.band)}・{destinationDisplayName(dispatch.destinationId)}・
        {STANCE_LABELS[dispatch.stance]}
      </p>
      <p class="kf-expedition__dispatch-members">
        隊員: {dispatch.memberIds.map((memberId) => residentDisplayName(memberId)).join("・")}
      </p>
      <p class="kf-expedition__dispatch-tick">帰還予定: {formatGameClock(dispatch.returnTick)}</p>
      {dispatch.casualtyMemberIds.length > 0 && (
        <p class="kf-expedition__dispatch-casualty">
          脱落見込み:{" "}
          {dispatch.casualtyMemberIds.map((memberId) => residentDisplayName(memberId)).join("・")}
        </p>
      )}
    </li>
  );
}

// --- 2. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function ExpeditionScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "expedition", { activate: false });

  const candidates = useSignalValue(store.derived.expeditionCandidates);
  const dispatches = useSignalValue(store.derived.expeditionDispatches);
  const slots = useSignalValue(store.derived.expeditionSlots);
  // content は起動後に差し替わらない(sources.ts の doc)ので非追跡の peek で
  // 読む——architecture.md §6 が禁じるのは `store.sources.*` の**購読**であり、
  // 一時的な読み出し(`store.peekState()` と同じ立場)は他画面にも前例がある
  // (GridScreen.tsx の `nextFacilityId(store.peekState(), …)`)。
  const content = store.peekContent();

  const [band, setBand] = useState<DistanceBand>("near");
  const [destinationId, setDestinationId] = useState<EntityId | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<readonly EntityId[]>([]);
  const [stance, setStance] = useState<DispatchStance>("cautious");
  const [teamSizeForSuggestion, setTeamSizeForSuggestion] = useState<number>(3);
  const [suggestion, setSuggestion] = useState<TeamPlan | null>(null);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);

  const destinationOptions = useMemo(
    () => explorationDestinationsForBand(content, band),
    [content, band],
  );
  const procedural = destinationOptions.length === 0;
  const effectiveDestinationId =
    destinationId ?? destinationOptions[0] ?? proceduralDestinationId(band);

  function pickBand(nextBand: DistanceBand): void {
    setBand(nextBand);
    setDestinationId(null);
    setSuggestion(null);
  }

  function toggleMember(entityId: EntityId): void {
    setSuggestion(null);
    setSelectedMemberIds((current) => {
      if (current.includes(entityId)) return current.filter((id) => id !== entityId);
      if (current.length >= DISPATCH_TEAM_MAX) return current;
      return [...current, entityId];
    });
  }

  const roiReport = useMemo(
    () => previewExplorationRoi(store.peekState(), content, band, selectedMemberIds),
    [store, content, band, selectedMemberIds],
  );
  const rewardResourceId = content.exploration?.byBand[band].rewardResourceId ?? null;

  function handleSuggest(): void {
    const state = store.peekState();
    const request: TeamRequest = {
      dispatchId: nextDispatchId(state, band),
      destinationId: effectiveDestinationId,
      band,
      stance,
      teamSize: teamSizeForSuggestion,
    };
    setSuggestion(suggestExpeditionTeams(state, content, [request]));
  }

  function applySuggestion(): void {
    const proposed = suggestion?.suggestions[0];
    if (proposed === undefined) return;
    setSelectedMemberIds(proposed.memberIds);
    setSuggestion(null);
  }

  function handleDispatch(): void {
    const dispatchId = nextDispatchId(store.peekState(), band);
    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "dispatchExpedition",
        dispatchId,
        destinationId: effectiveDestinationId,
        band,
        stance,
        teamResidentIds: selectedMemberIds,
      },
    });
    if (result.command === null) return;
    if (result.command.ok) {
      setSelectedMemberIds([]);
      setSuggestion(null);
      setLastRejection(null);
      return;
    }
    setLastRejection(result.command.rejection);
  }

  const proposedSuggestion = suggestion?.suggestions[0] ?? null;
  const unfulfilled = (suggestion?.unfulfilledRequests.length ?? 0) > 0;

  return (
    <section class="kf-expedition-screen" aria-labelledby="kf-expedition-screen-title">
      <h2 class="kf-expedition-screen__title" id="kf-expedition-screen-title">
        探索本部
      </h2>
      <p class="kf-screen-intro">
        住民を送り出して外の資源や記録を探索します。行き先・方針・チームを選んで派遣してください。
      </p>
      <p class="kf-expedition-screen__slots">
        派遣枠: {slots.used}/{slots.max}
      </p>

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      <h3 class="kf-expedition-screen__subtitle">目的地</h3>
      <BandPicker band={band} onPick={pickBand} />
      <DestinationPicker
        options={procedural ? [proceduralDestinationId(band)] : destinationOptions}
        destinationId={effectiveDestinationId}
        onPick={setDestinationId}
      />

      <h3 class="kf-expedition-screen__subtitle">方針</h3>
      <StancePicker stance={stance} onPick={setStance} />

      <h3 class="kf-expedition-screen__subtitle">
        チーム({selectedMemberIds.length}/{DISPATCH_TEAM_MAX}名・下限{DISPATCH_TEAM_MIN}名)
      </h3>
      {candidates.length === 0 ? (
        <p class="kf-expedition-screen__no-candidates">
          派遣できる住民がいません(生存していて寿命があり、まだ派遣中でない住民だけが候補になります)。
        </p>
      ) : (
        <ul class="kf-expedition__candidate-list">
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.entityId}
              candidate={candidate}
              selected={selectedMemberIds.includes(candidate.entityId)}
              disabled={selectedMemberIds.length >= DISPATCH_TEAM_MAX}
              onToggle={toggleMember}
            />
          ))}
        </ul>
      )}

      <section class="kf-expedition__template" aria-label="編成テンプレ">
        <h3 class="kf-expedition-screen__subtitle">編成テンプレ(強めの編成を自動で提案します)</h3>
        <ul class="kf-expedition__team-size-list" aria-label="提案する人数">
          {TEAM_SIZE_OPTIONS.map((size) => (
            <li key={size}>
              <button
                type="button"
                class="kf-expedition__team-size-button"
                aria-pressed={size === teamSizeForSuggestion}
                onClick={() => setTeamSizeForSuggestion(size)}
              >
                {size}名
              </button>
            </li>
          ))}
        </ul>
        <button type="button" class="kf-expedition__suggest-button" onClick={handleSuggest}>
          編成テンプレを提案する
        </button>
        {unfulfilled && (
          <p class="kf-expedition__template-unfulfilled">
            候補が不足しており提案できません(生存・非派遣中・寿命ありの住民が{" "}
            {teamSizeForSuggestion} 名必要)。
          </p>
        )}
        {proposedSuggestion !== null && (
          <div class="kf-expedition__template-preview">
            <p class="kf-expedition__template-members">
              提案: {proposedSuggestion.memberIds.join("・")}(戦力{" "}
              {toApproxNumber(proposedSuggestion.teamPowerFix).toFixed(1)} / 目標{" "}
              {toApproxNumber(proposedSuggestion.targetTeamPowerFix).toFixed(1)} / 理論最大{" "}
              {toApproxNumber(proposedSuggestion.bestTeamPowerFix).toFixed(1)})
            </p>
            <button type="button" class="kf-expedition__apply-button" onClick={applySuggestion}>
              この編成を適用する
            </button>
          </div>
        )}
      </section>

      <h3 class="kf-expedition-screen__subtitle">派遣前の見込み(ROI)</h3>
      <RoiPanel
        report={roiReport}
        rewardResourceId={rewardResourceId}
        teamSize={selectedMemberIds.length}
      />

      {/* [束A/M-3] 確定操作(派遣する)は画面下部の sticky バーへ。候補一覧が
          長くても、選びながら常に押せる位置に留まる(ナビの直上に固定)。 */}
      <div class="kf-sticky-actions">
        <button
          type="button"
          class="kf-expedition__dispatch-button"
          onClick={handleDispatch}
          disabled={selectedMemberIds.length < DISPATCH_TEAM_MIN}
        >
          派遣する({selectedMemberIds.length}/{DISPATCH_TEAM_MAX}名)
        </button>
      </div>

      <h3 class="kf-expedition-screen__subtitle">未帰還の派遣</h3>
      {dispatches.length === 0 ? (
        <p class="kf-expedition-screen__no-dispatches">未帰還の派遣はありません。</p>
      ) : (
        <ul class="kf-expedition__dispatch-list">
          {dispatches.map((dispatch) => (
            <DispatchRow key={dispatch.dispatchId} dispatch={dispatch} />
          ))}
        </ul>
      )}

      <div class="kf-expedition-screen__nav">
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          ④住民一覧へ
        </button>
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("chronicle")}
        >
          ⑧冒険記へ
        </button>
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("outposts")}
        >
          ⑨衛星拠点へ
        </button>
      </div>
    </section>
  );
}
