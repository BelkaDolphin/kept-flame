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
import { toApproxNumber } from "../../../engine/fp";
import type { EngineContent } from "../../../engine/rules/types";
import type { EntityId } from "../../../engine/state/state";
import type { FacilityDetailView, FacilityRosterEntry, FacilityWorkerView } from "../../derived";
import { cellCoordinateLabel } from "../cellCoordinate";
import { facilityLabel, residentDisplayName, resourceLabel, techLabel } from "../contentLabels";
import {
  bedCapacityEffectText,
  DORMANT_FACILITY_EFFECT_TEXT,
  facilityEffectExtrasOf,
  facilityEffectKind,
  facilityEffectTextOf,
  storageCapacityEffectText,
  type FacilityEffectKind,
} from "../facilityEffect";
import { formatApproxDecimal1, formatRatePerMinute, formatResourceAmount } from "../format";
import { CellBreakdownView } from "../grid/CellBreakdownView";
import "../grid/gridBoard.css";
import { TagChip } from "../grid/TagChip";
import { TagIconDefs } from "../grid/TagIcons";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import {
  resourceSpendBreakdownPhrase,
  resourceStockFix,
  useToastStack,
  ToastStackView,
} from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./facilityScreen.css";

// --- 1. 就労者 1 行(hooks 不使用・直接テスト可能) --------------------------

export interface FacilityWorkerRowProps {
  readonly worker: FacilityWorkerView;
}

/** 想起困難/派遣中/死亡tombstoneの状態表示(GDD 7.1/7.5/11.2・④と同じ語彙)。 */
export function FacilityWorkerRow({ worker }: FacilityWorkerRowProps) {
  // [M70/R5-A02] `impairedTechIds` は (住民,tech) 別の想起困難(M13 本式)。
  // `recallImpaired`(住民単位スカラ)とは独立の情報源なので、どちらかが
  // 立っていれば「想起困難」バッジを出す(derived.ts の doc 参照)。
  const impairedTechIds = worker.impairedTechIds ?? [];
  const badges: string[] = [];
  if (!worker.alive) badges.push("死亡");
  if (worker.dispatched) badges.push("派遣中");
  if (worker.recallImpaired || impairedTechIds.length > 0) badges.push("想起困難");
  return (
    <li class="kf-facility-detail__worker">
      <span class="kf-facility-detail__worker-id">{residentDisplayName(worker.residentId)}</span>
      <span class="kf-facility-detail__worker-morale">
        士気{formatApproxDecimal1(worker.moraleApprox)}
      </span>
      {badges.length > 0 && (
        <span class="kf-facility-detail__worker-badges">{badges.join("・")}</span>
      )}
      {/* [M70/R5-A02] 「想起困難」バッジだけでは何のtechか分からない
          (derived.ts:326 の既知妥協への回答)。この施設の寄与を止めている
          tech名を明示する。 */}
      {impairedTechIds.length > 0 && (
        <span class="kf-facility-detail__worker-impairment">
          想起困難の対象: {impairedTechIds.map((techId) => techLabel(techId)).join("・")}
        </span>
      )}
    </li>
  );
}

// --- 2. 施設詳細パネル(hooks 不使用・直接テスト可能) ------------------------

export interface FacilityDetailPanelProps {
  readonly detail: FacilityDetailView;
  readonly onUpgrade: () => void;
  /**
   * [M61/FC6] 施設の効果種別(`facilityEffect.ts`)。省略時は "worker"
   * (=既存の通常施設と同じ表示)——既存呼び出し元/既存テストとの後方互換。
   */
  readonly effectKind?: FacilityEffectKind;
  /** [M61/FC6] `effectKind === "bedCapacity"` のときの効果文言。省略時は非表示。 */
  readonly bedEffectText?: string | null;
  /**
   * [M61/FC6・2026-08-02差し戻し] `effectKind === "storageCapacity"`
   * (保管庫)のときの効果文言。「効果は未実装」ではなく実効果(保管上限の設定
   * + 超過分喪失)を正直に見せる(facilityEffect.ts §2「保管庫」参照)。
   */
  readonly storageEffectText?: string | null;
  /**
   * [M73/R8-02] `effectKind` が `"defense"`(見張り台)/ `"careCapacity"`(療養所)
   * のときの効果文言(`facilityEffect.ts` §4)。M66 で実装済みの効果を持つ
   * ——「効果は未実装」も「増築しても効果は変わりません」も出さない。
   * 省略時は非表示(既存呼び出し元/既存テストとの後方互換)。
   */
  readonly effectText?: string | null;
  /**
   * [M61/FC11・R1-A14] 増築後の産出見込み(実行前プレビュー)。`null` = 出さない
   * (上限Lv・寝床/非稼働・content にLv曲線が無い等)。値は「増築ボタンを押す前に
   * 効果が分かる」ための表示専用近似値であり、engine 側の再計算(§3 の規律)は
   * 行わない——呼び出し元(FacilityScreen 本体)が
   * `outputPerTickApprox × (次Lv基礎産出/現Lv基礎産出)` という比率だけで求める
   * (隣接乗数・稼働就労者数は増築で変わらないため、この比率適用は近似ではなく
   * 厳密に一致する)。
   */
  readonly nextLevelOutputApprox?: number | null;
}

export function FacilityDetailPanel({
  detail,
  onUpgrade,
  effectKind = "worker",
  bedEffectText = null,
  storageEffectText = null,
  effectText = null,
  nextLevelOutputApprox = null,
}: FacilityDetailPanelProps) {
  const isDormant = effectKind === "none";
  const isBedCapacity = effectKind === "bedCapacity";
  const isStorageCapacity = effectKind === "storageCapacity";
  // [M73/R8-02] 見張り台/療養所。就労スロットを持たない点は寝床/保管庫と同じ
  // なので産出/就労の行は出さず、実効果(Lv 別カーブ)だけを見せる。
  const isCurveEffect = effectKind === "defense" || effectKind === "careCapacity";
  return (
    <section class="kf-facility-detail" aria-label="施設詳細">
      <TagIconDefs />
      <h3 class="kf-facility-detail__name">
        {facilityLabel(detail.defId)}({cellCoordinateLabel(detail.cellId)})
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
      {/* [M61/FC6・R1-A08/C02] 就労スロットを持たない施設(寝床/保管庫/見張り台/
          療養所)は「産出0.00/tick・就労0/0」を出さない——あたかも空きスロットが
          埋まれば動くかのように誤解させるため。寝床/保管庫は実効果を、
          見張り台/療養所は「効果は未実装」を明示する(facilityEffect.ts §2)。 */}
      {isDormant ? (
        <p class="kf-facility-detail__dormant" data-effect-kind="none">
          {DORMANT_FACILITY_EFFECT_TEXT}
        </p>
      ) : isBedCapacity ? (
        <p class="kf-facility-detail__bed-capacity" data-effect-kind="bedCapacity">
          {bedEffectText}
        </p>
      ) : isStorageCapacity ? (
        <p class="kf-facility-detail__storage-capacity" data-effect-kind="storageCapacity">
          {storageEffectText}
        </p>
      ) : isCurveEffect ? (
        <p class="kf-facility-detail__curve-effect" data-effect-kind={effectKind}>
          {effectText}
        </p>
      ) : (
        <>
          <p class="kf-facility-detail__output">
            {/* [M62/FC4・R2-D01] 内部語「/tick」を「/分」へ(tick=1分・GDD 11.1)。
                [M63/R4-A02] 数値整形は formatRatePerMinute(可変小数桁)へ——
                固定 1 桁の formatResourceAmount だと資材施設 7 種の産出が
                0.0(→「0/分」)に埋もれ、増築の Lv 間でレート差が判別できなく
                なる(台本T7)。formatRatePerMinute が「/分」まで含めて返すので
                以後のリテラル「/分・」は付けない。 */}
            産出: {formatRatePerMinute(detail.outputPerTickApprox)}
            {/* [M61/FC11・R1-A14] 増築前に効果(産出の伸び)を見せる。 */}
            {nextLevelOutputApprox !== null && ` → ${formatRatePerMinute(nextLevelOutputApprox)}`}・
            {detail.outputKind === "resource" && detail.outputResourceId !== null
              ? resourceLabel(detail.outputResourceId)
              : "研究点"}
            (隣接乗数 ×{detail.multiplierApprox.toFixed(2)})
          </p>
          {/* [M70/R5-A02] 就労1/1なのに産出0/分が延々続く=「壊れて見える」の
              解消(derived.ts:326 の既知妥協への回答)。理由を就労者一覧の前に
              明示する(詳細は各行の想起困難バッジ+対象techに出る)。 */}
          {detail.workers.some((worker) => (worker.impairedTechIds ?? []).length > 0) && (
            <p class="kf-facility-detail__impairment-note" role="note">
              ▲ 想起困難のため一部の就労者の生産が止まっています(下の就労者一覧を参照)。
              知識は人の記憶に宿るため、時間が経てば思い出して回復します。
            </p>
          )}
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
        </>
      )}
      <div class="kf-facility-detail__upgrade">
        <p class="kf-facility-detail__upgrade-cost">
          {detail.upgradeCostApprox === null || detail.upgradeCostResourceId === null
            ? detail.level >= detail.maxLevel
              ? "既に上限Lvです。"
              : "増築コストはかかりません。"
            : // [M63/R4-A12 系] 生の数値を直接埋め込んでいた(整形ヘルパを通していない
              // ため float 起因の端数がそのまま出うる)。formatResourceAmount へ統一。
              `増築コスト: ${resourceLabel(detail.upgradeCostResourceId)} ${formatResourceAmount(detail.upgradeCostApprox)}`}
        </p>
        {isDormant && detail.level < detail.maxLevel && (
          <p class="kf-facility-detail__dormant-upgrade-warning">
            この施設は効果が未実装のため、増築しても効果は変わりません。
          </p>
        )}
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
  /**
   * [M71/R6-A04] 現在選択中の施設 ID。**常設セレクタ化**に伴い追加(§ 直後の
   * doc 参照)。省略時は null 扱い(既存呼び出し/既存テストとの後方互換)——
   * 未選択なら従来どおりの案内文言、選択中ならどれが選ばれているか
   * (`aria-pressed`)を示し、案内文言も「切り替え」の言い方へ変える。
   */
  readonly selectedFacilityId?: EntityId | null;
}

/**
 * 施設の選択/切り替え(m-1 の未選択時フォールバックを常設セレクタへ拡張)。
 *
 * **[M71/R6-A04] 施設を選ぶと一覧が消え、別施設へは②格子ビューの往復
 * (+2タップ)が毎回必要という指摘への対応**: 選択済みかどうかに関わらず
 * 常にこの一覧を描く(呼び出し側 `FacilityScreen` が `detail` の有無で分岐
 * するのをやめ、`FacilityPicker` の下(または横)に詳細を並べて表示する形へ
 * 変更)。①格子ビューでのタップ選択は従来どおり有効なまま(この一覧は
 * それに代わる「もう1つの選び方」を追加するだけ)。
 */
export function FacilityPicker({ roster, onPick, selectedFacilityId = null }: FacilityPickerProps) {
  if (roster.length === 0) {
    return (
      <p class="kf-facility-screen__empty">
        まだ施設がありません。格子ビューでまず施設を建ててください。
      </p>
    );
  }
  return (
    <section class="kf-facility-picker" aria-label="施設を選ぶ">
      <p class="kf-screen-intro">
        {selectedFacilityId === null
          ? "施設が選択されていません。一覧から選ぶか、格子ビューで施設をタップして選択してください。"
          : "一覧から選ぶと他の施設へ切り替えられます(格子ビューへ往復する必要はありません)。"}
      </p>
      <ul class="kf-facility-picker__list">
        {roster.map((facility) => (
          <li key={facility.facilityId}>
            <button
              type="button"
              class="kf-facility-picker__button"
              aria-pressed={facility.facilityId === selectedFacilityId}
              onClick={() => onPick(facility.cellIndex)}
            >
              {facilityLabel(facility.defId)}({cellCoordinateLabel(facility.cellId)})・Lv
              {facility.level}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- 2c. [M61/FC6] content から効果種別/寝床効果文言を引く(hooks 不使用) ----

/** `content.facilityDefs` に定義が無い(理論上は起きない)場合は "worker" 扱い
 * (§3 の bLossImminentTechIds 等と同じ防御的フォールバック=通常表示に倒す)。 */
function facilityEffectKindOf(content: EngineContent, defId: EntityId): FacilityEffectKind {
  const def = content.facilityDefs.get(defId);
  return def === undefined ? "worker" : facilityEffectKind(def);
}

function bedEffectTextOf(content: EngineContent, defId: EntityId, level: number): string | null {
  const def = content.facilityDefs.get(defId);
  return def === undefined ? null : bedCapacityEffectText(def, level);
}

function storageEffectTextOf(
  content: EngineContent,
  defId: EntityId,
  level: number,
): string | null {
  const def = content.facilityDefs.get(defId);
  return def === undefined ? null : storageCapacityEffectText(def, level);
}

/**
 * [M73/R8-02] 見張り台/療養所の効果文言(`facilityEffect.ts` §4)。②カタログと
 * 同じ `facilityEffectTextOf` を通すので、両画面で文言が食い違わない。
 * 現在の Lv を渡すので「このLvの寄与/枠」は実際の値になる。
 */
function curveEffectTextOf(content: EngineContent, defId: EntityId, level: number): string | null {
  const def = content.facilityDefs.get(defId);
  if (def === undefined) return null;
  return facilityEffectTextOf(def, level, facilityEffectExtrasOf(content));
}

/**
 * [M61/FC11・R1-A14] 増築後の産出見込み(`FacilityDetailPanel` の doc 参照)。
 * `outputPerTickApprox × (次Lv基礎産出 / 現Lv基礎産出)`。基礎産出が 0(非稼働
 * 施設・寝床)・Lv曲線が欠けている・既に上限Lv、のいずれかなら null(捏造しない)。
 */
function nextLevelOutputApproxOf(
  content: EngineContent,
  detail: FacilityDetailView,
): number | null {
  if (detail.level >= detail.maxLevel) return null;
  const def = content.facilityDefs.get(detail.defId);
  if (def === undefined) return null;
  const currentBase = def.outputPerTickByLevel[detail.level - 1];
  const nextBase = def.outputPerTickByLevel[detail.level];
  if (currentBase === undefined || nextBase === undefined) return null;
  const currentBaseApprox = toApproxNumber(currentBase);
  if (currentBaseApprox === 0) return null;
  return detail.outputPerTickApprox * (toApproxNumber(nextBase) / currentBaseApprox);
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
  // content は起動後に差し替わらないので非追跡の peek で読む(他画面前例どおり・
  // ExpeditionScreen.tsx §2)。[M61/FC6] 非稼働施設の判定に facility 定義が要る。
  const content = store.peekContent();

  function handleUpgrade(current: FacilityDetailView): void {
    // [M70/R5-A04] 消費量表示の差分は Fix のまま取る(resourceStockFix・
    // Toast.tsx の spentAmountText doc 参照。近似値どうしの減算は IEEE754 の
    // 丸め誤差で ±1 ずれることがある)。
    const beforeStockFix =
      current.upgradeCostResourceId === null
        ? null
        : resourceStockFix(store.peekState(), current.upgradeCostResourceId);
    // [M63/R4-A14] 増築コストも建設と同じ廃材代替(GDD 6.7・最大20%)を受ける
    // ので、廃材資源の在庫も併せて控える。
    const wasteResourceId = content.storage?.wasteResourceId ?? null;
    const wasteBeforeStockFix =
      wasteResourceId === null ? null : resourceStockFix(store.peekState(), wasteResourceId);
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "upgradeFacility", facilityId: current.facilityId },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    const afterStockFix =
      current.upgradeCostResourceId === null
        ? null
        : resourceStockFix(store.peekState(), current.upgradeCostResourceId);
    const wasteAfterStockFix =
      wasteResourceId === null ? null : resourceStockFix(store.peekState(), wasteResourceId);
    const diff = resourceSpendBreakdownPhrase(
      {
        resourceId: current.upgradeCostResourceId,
        beforeStockFix,
        afterStockFix,
      },
      {
        resourceId: wasteResourceId,
        beforeStockFix: wasteBeforeStockFix,
        afterStockFix: wasteAfterStockFix,
      },
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

      {/* [M71/R6-A04] 選択後もピッカーを残す(常設セレクタ化)。以前は
          `detail === null` のときだけ描いていたため、選択後に別施設へ切り替える
          には②格子ビューへ毎回往復する必要があった。 */}
      <FacilityPicker
        roster={facilityRoster}
        onPick={handlePickFacility}
        selectedFacilityId={detail?.facilityId ?? null}
      />
      {detail !== null && (
        <>
          <FacilityDetailPanel
            detail={detail}
            onUpgrade={() => handleUpgrade(detail)}
            effectKind={facilityEffectKindOf(content, detail.defId)}
            bedEffectText={bedEffectTextOf(content, detail.defId, detail.level)}
            storageEffectText={storageEffectTextOf(content, detail.defId, detail.level)}
            effectText={curveEffectTextOf(content, detail.defId, detail.level)}
            nextLevelOutputApprox={nextLevelOutputApproxOf(content, detail)}
          />
          <CellBreakdownView cellId={detail.cellId} breakdown={breakdown} includeIconDefs={false} />
        </>
      )}

      <div class="kf-facility-screen__nav">
        <button
          type="button"
          class="kf-facility-screen__nav-button"
          onClick={() => onNavigate("grid")}
        >
          格子ビューへ戻る
        </button>
        <button
          type="button"
          class="kf-facility-screen__nav-button"
          onClick={() => onNavigate("residents")}
        >
          住民配置へ
        </button>
      </div>
    </section>
  );
}
