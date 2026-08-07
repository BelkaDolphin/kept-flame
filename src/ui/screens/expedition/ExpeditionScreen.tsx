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
  type ResourceView,
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
import { useToastStack, ToastStackView } from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import { useStickyActionsClearance } from "../useStickyActionsClearance";
import {
  formatApproxDecimal1,
  formatApproxDecimal2,
  formatGameClock,
  formatResourceAmount,
  formatTickSpan,
} from "../format";
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
        <span class="kf-expedition__candidate-power">
          戦力{formatApproxDecimal1(candidate.combatPowerApprox)}
        </span>
        <span class="kf-expedition__candidate-morale">
          士気{formatApproxDecimal1(candidate.moraleApprox)}
        </span>
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

/**
 * 投資効率(ROI)と(B)損失リスク項(M32 の検収条件)。
 *
 * **[M73/R8-08] 3 点を直す**:
 *   (a) 「ROI」だけが英語の金融用語のまま残っていた(軸D規約=内部語・英語生値を
 *       露出しない)。**「投資効率」**へ和語化し、比であることを式で添える。
 *   (b) 目的地別の値になっていなかった(engine 側 API は Phase D で入っていたのに
 *       UI が渡していなかった)。結線は画面本体側で済ませ、ここでは
 *       `report.sourceEventIds` から**何を根拠にした見積りか**を注記する。
 *   (c) 近似値である注記が無かった。ここは事前期待値(乱数を 0..R 一様として
 *       解析的に解いた確率モデル)であって、実際の解決は決定論で 1 つに決まる
 *       (rules/exploration.ts の explorationRoi の doc)。その差を 1 行で言う。
 *
 * **[M74/⑮] 成功確率を先頭に出す**。engine は `explorationRoi` の
 * `successProbabilityFix`(1 ノードの期待成功確率・R6 期に整備済み)を返していた
 * のに、この画面は全滅確率(その裏返しに見えて実は別式=安全曲線)と期待報酬
 * しか出していなかった。結果として「必要人数を 1 人下回った途端に成功率が急落
 * する」という編成人数の崖が**派遣前にはどこにも見えず**、帰還後の失敗でしか
 * 分からなかった。ここでも UI は式を持たず、engine の値を % へ直すだけである。
 */
export function RoiPanel({ report, rewardResourceId, teamSize }: RoiPanelProps) {
  if (teamSize === 0) {
    return <p class="kf-expedition__roi-inactive">住民を選ぶと予測を表示します。</p>;
  }
  if (report === null) {
    return (
      <p class="kf-expedition__roi-inactive">現在のデータでは派遣前の見込みを算出できません。</p>
    );
  }
  // [M70/R5-A12] 素の toFixed(2)/(1) を整形ヘルパへ統一(「期待報酬109.81薪」
  // 「逸失生産73.44」(単位なし)のような、画面ごとに桁ルールが違う「小数の
  // 二重基準」の掃討)。期待報酬/逸失生産/期待損失は資源相当の量なので
  // formatResourceAmount(他画面のコスト表示と同じ丸め・桁区切り規則)、
  // 確率%は formatApproxDecimal1(常に小数第1位)、ROI比は 0.25 のような値も
  // 判別できるよう formatApproxDecimal2 を使う。
  //
  // [M71/R6-C04] 逸失生産(機会費用)/期待損失は ROI 式(GDD 8.6)の分母を
  // 成す項で、分子の期待報酬と同じ単位(`rewardResourceId` 相当の資源換算量・
  // `forgoneOutputPerWorkerTickFix`/`rareAssetValueFix` とも同じ換算・
  // rules/exploration.ts の explorationRoi の doc 参照)なのに、隣の期待報酬行
  // だけ資源名が付き、この2つは単位なしのままだった(R5-A12 の残り)。
  // 同じ rewardResourceId を付けて統一する。
  return (
    <section class="kf-expedition__roi" aria-label="派遣前の見込み">
      {/* [M74/⑮] 編成人数の崖(§ 直前の doc)。いまの顔ぶれ・人数での成功確率を
          期待報酬より前に置く——報酬は「成功したら」の話なので、先に成否の目安が
          要る。人数を変えるとこの値が動くことを添えて、崖の存在自体を示す。 */}
      <p class="kf-expedition__roi-success" data-testid="expedition-success-probability">
        成功確率(1ノードあたり):{" "}
        {formatApproxDecimal1(toApproxNumber(report.successProbabilityFix) * 100)}%
        <span class="kf-expedition__roi-success-note">
          (いまの{teamSize}名の顔ぶれでの見込み。人数を減らすと急に下がることがあります)
        </span>
      </p>
      <p class="kf-expedition__roi-reward">
        期待報酬: {formatResourceAmount(toApproxNumber(report.expectedRewardFix))}
        {rewardResourceId !== null ? resourceLabel(rewardResourceId) : ""}
      </p>
      <p class="kf-expedition__roi-forgone">
        逸失生産(機会費用): {formatResourceAmount(toApproxNumber(report.forgoneOutputFix))}
        {rewardResourceId !== null ? resourceLabel(rewardResourceId) : ""}
      </p>
      <p class="kf-expedition__roi-loss" data-testid="expedition-b-loss">
        (B)喪失リスク: 期待損失 {formatResourceAmount(toApproxNumber(report.expectedRareLossFix))}
        {rewardResourceId !== null ? resourceLabel(rewardResourceId) : ""}
        (対象 (B) 資産 {report.rareAssetCount} 件・全滅確率{" "}
        {formatApproxDecimal1(toApproxNumber(report.wipeProbabilityFix) * 100)}%)
      </p>
      <p class="kf-expedition__roi-value">
        投資効率(期待報酬 ÷ 逸失生産と喪失リスクの合計):{" "}
        {report.roiFix === null
          ? "算出できません(比べる相手が0のため)"
          : formatApproxDecimal2(toApproxNumber(report.roiFix))}
      </p>
      <p class="kf-expedition__roi-travel">往復所要: {formatTickSpan(report.travelTicks)}</p>
      {/* [M73/R8-08] 近似であることの注記(§ 直前の doc (c))。目的地を選んでいれば
          その行き先の実体から、選べる行き先が無い距離帯なら距離帯の平均的な難度
          からの見積りであることも併せて言う。 */}
      <p class="kf-expedition__roi-note" role="note">
        {report.sourceEventIds.length === 0
          ? "この距離帯には具体的な行き先の記録がないため、距離帯の平均的な難度から見積もっています。"
          : report.sourceEventIds.length === 1
            ? "選んでいる行き先の内容から見積もった値です。"
            : "この距離帯で行ける先すべての平均から見積もった値です。"}
        実際の成否は出発後に決まるため、この数値は目安です。
      </p>
    </section>
  );
}

/**
 * [台帳v18 必-1] 派遣中カードの「持ち帰り予定」が、倉庫満杯で満額受け取れない
 * 可能性を判定する。**engine の再計算はしない**(タスク指示どおり=決定論の
 * 二重実装禁止)——現在の在庫/上限(`store.derived.resources`、engine 唯一の
 * 正本 `resolveCapacityByResourceId` から作られた値をそのまま読むだけ)と
 * 粗報酬を突き合わせるだけの見込み判定であり、帰還時に engine が実際に適用
 * する加算式保管上限+スポンジ処理(rules/storage.ts の
 * `applyCappedLumpIntake`)を UI 側で模倣しない。「正確な受領予測」ではなく
 * 「満額は怪しい」という注記だけを出す。
 */
export function rewardMayOverflow(
  resources: readonly ResourceView[],
  rewardResourceId: EntityId,
  rewardApprox: number,
): boolean {
  const resource = resources.find((entry) => entry.resourceId === rewardResourceId);
  if (resource === undefined || resource.capacityApprox === null) return false;
  return resource.atCapacity || resource.stockApprox + rewardApprox > resource.capacityApprox;
}

export interface DispatchRowProps {
  readonly dispatch: ExpeditionDispatchView;
  /**
   * [台帳v18 必-1] `rewardMayOverflow` の結果。省略時(既存呼び出し互換)は
   * false 扱い=注記を出さない。
   */
  readonly mayOverflow?: boolean;
}

export function DispatchRow({ dispatch, mayOverflow = false }: DispatchRowProps) {
  return (
    <li class="kf-expedition__dispatch-row">
      <p class="kf-expedition__dispatch-head">
        {distanceBandLabel(dispatch.band)}・{destinationDisplayName(dispatch.destinationId)}・
        {STANCE_LABELS[dispatch.stance]}
      </p>
      <p class="kf-expedition__dispatch-members">
        隊員: {dispatch.memberIds.map((memberId) => residentDisplayName(memberId)).join("・")}
      </p>
      {/* [台帳v18 必-1] 「持ち帰り予定」は粗報酬(倉庫上限を通す前)の見込み値。
          M64 で帰還ログ側は実受領額+あふれ量を開示済みだが、派遣中カード側は
          そもそも金額を出していなかった(この行が無かった)ので新設する。 */}
      <p class="kf-expedition__dispatch-reward">
        持ち帰り予定(見込み): {formatResourceAmount(dispatch.rewardApprox)}
        {resourceLabel(dispatch.rewardResourceId)}
      </p>
      {mayOverflow && (
        <p class="kf-expedition__dispatch-reward-warning">
          ▲ 倉庫がこの資源の保管上限に近いため、実際に持ち帰れる量はこれより少なくなる場合が
          あります(帰還時に受領額を確定します)。
        </p>
      )}
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
  // [台帳v18 必-1] 「持ち帰り予定」の満杯注記に使う(rewardMayOverflow の doc 参照)。
  const resources = useSignalValue(store.derived.resources);
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
  // [M61/FC7] R1-D07: この画面は成功トースト基盤(Toast.tsx)を import していな
  // かった(束B以降の他画面は全て導入済み)。派遣確定の成功フィードバックを追加。
  const toastStack = useToastStack();
  // [M61/FC3] 候補一覧の件数(=画面の総高さに影響)が変わるたびに sticky バーとの
  // 重なりを測り直す。
  const stickyClearance = useStickyActionsClearance([candidates.length, dispatches.length]);

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

  // [M73/R8-08] 目的地と方針を engine の ROI へ渡す(既存 API の結線漏れ)。
  // 以前は帯平均のままだったので、近郊の3目的地で表示が 1 文字も変わらなかった。
  const roiReport = useMemo(
    () =>
      previewExplorationRoi(store.peekState(), content, band, selectedMemberIds, {
        destinationId: effectiveDestinationId,
        stance,
      }),
    [store, content, band, selectedMemberIds, effectiveDestinationId, stance],
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
    const teamSize = selectedMemberIds.length;
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
      // [M61/FC7] R1-D07: 派遣確定の成功トースト(他画面の建設/増築等と同じ形)。
      toastStack.push(
        `${distanceBandLabel(band)}・${destinationDisplayName(effectiveDestinationId)}へ${String(teamSize)}名を派遣した`,
      );
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

      <ToastStackView toasts={toastStack.toasts} />

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
              {/* [M61/FC5・R1-A09] 住民IDの生露出("提案: resrui・resseri")を
                  residentDisplayName で和名化する。 */}
              提案: {proposedSuggestion.memberIds.map((id) => residentDisplayName(id)).join("・")}
              {/* [M70/R5-A12] 同じ「戦力」の値なのに CandidateRow は
                  formatApproxDecimal1 経由・ここだけ素の toFixed(1) だった
                  (同一ファイル内の二重基準)ので統一する。 */}
              (戦力 {formatApproxDecimal1(toApproxNumber(proposedSuggestion.teamPowerFix))} / 目標{" "}
              {formatApproxDecimal1(toApproxNumber(proposedSuggestion.targetTeamPowerFix))} /
              理論最大 {formatApproxDecimal1(toApproxNumber(proposedSuggestion.bestTeamPowerFix))})
            </p>
            <button type="button" class="kf-expedition__apply-button" onClick={applySuggestion}>
              この編成を適用する
            </button>
          </div>
        )}
      </section>

      <h3 class="kf-expedition-screen__subtitle">派遣前の見込み</h3>
      {/* [M61/FC3・R1-C03] sticky確定バーとの実測重なり補正(§1のdoc参照)。
          候補一覧の件数が変わると内容の総高さも変わるので、それを
          recomputeKey にして測り直す。 */}
      <div ref={stickyClearance.contentRef}>
        <RoiPanel
          report={roiReport}
          rewardResourceId={rewardResourceId}
          teamSize={selectedMemberIds.length}
        />
      </div>

      {/* [束A/M-3] 確定操作(派遣する)は画面下部の sticky バーへ。候補一覧が
          長くても、選びながら常に押せる位置に留まる(ナビの直上に固定)。 */}
      <div class="kf-sticky-actions" ref={stickyClearance.stickyRef}>
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
            <DispatchRow
              key={dispatch.dispatchId}
              dispatch={dispatch}
              mayOverflow={rewardMayOverflow(
                resources,
                dispatch.rewardResourceId,
                dispatch.rewardApprox,
              )}
            />
          ))}
        </ul>
      )}

      <div class="kf-expedition-screen__nav">
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          住民一覧へ
        </button>
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("chronicle")}
        >
          冒険記へ
        </button>
        <button
          type="button"
          class="kf-expedition-screen__nav-button"
          onClick={() => onNavigate("outposts")}
        >
          衛星拠点へ
        </button>
      </div>
    </section>
  );
}
