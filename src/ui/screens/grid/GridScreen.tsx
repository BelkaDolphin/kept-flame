// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ②格子ビュー(M30)— GDD 6.1〜6.6 / 9.1
//
// ===========================================================================
// 1. このファイルがやること
// ===========================================================================
//   M18(GridBoard・盤面描画+ジェスチャ)/ M19(配置プレビュー・凡例・内訳ビュー・
//   タグ4重符号化)の部品を**そのまま**結線し、この画面が新たに持つのは:
//     (a) 施設カタログ(「何を建てるか」の選択・タップ選択の1ステップ目)
//     (b) 施設 ID の採番(`facilityId.ts` の `nextFacilityId`・M18★4への回答)
//     (c) 瓦礫セルの開墾導線(GDD 9.1・M52 の state 化を受けた UI・M18/M52 申し
//         送り): 選択セルが瓦礫なら開墾コストを表示し `reclaimCell` を発行する
//     (d) コマンド拒否の表示(`DispatchResult.command.rejection.message`)
//   の 4 点だけである。M18/M19 のコンポーネント本体(GridBoard/LegendPanel/
//   CellBreakdownView/TagChip)は 1 行も書き直さない(タスク指示どおり)。
//
// ===========================================================================
// 2. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   施設カタログのボタンは「押せるか」を先読みしない——`pendingPlacement` を
//   立てるだけで、置けるかどうかは `placeFacility` の reject に委ねる。開墾も
//   同様に、コスト/在庫は**表示するだけ**でボタンは常に押せる状態にし、
//   足りなければ `reclaimCell` の `insufficientResource` reject を見せる。
// ---------------------------------------------------------------------------

import { useMemo, useState } from "preact/hooks";

import { GRID_CELL_COUNT } from "../../../engine/adjacency";
import type { CommandRejection, CommandResult } from "../../../engine/commands";
import { toApproxNumber } from "../../../engine/fp";
import type { EntityId } from "../../../engine/state/state";
import type { CellViewModel, FacilityCatalogEntry, ReclaimInfo, ResourceView } from "../../derived";
import { cellCoordinateLabel } from "../cellCoordinate";
import { facilityLabel, resourceLabel } from "../contentLabels";
import {
  bedCapacityEffectText,
  DORMANT_FACILITY_EFFECT_TEXT,
  facilityEffectKind,
  storageCapacityEffectText,
  workerEffectHintText,
} from "../facilityEffect";
import { formatResourceAmount, formatResourceStock } from "../format";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import {
  resourceDeltaPhrase,
  resourceSpendBreakdownPhrase,
  resourceStockApprox,
  useToastStack,
  ToastStackView,
} from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import { CellBreakdownView } from "./CellBreakdownView";
import { GridBoard, type PendingPlacement, type PlacementSuccessInfo } from "./GridBoard";
import "./gridBoard.css";
import { nextFacilityId } from "./facilityId";
import { LegendPanel, type LegendOvercrowdInfo } from "./LegendPanel";

// --- 1. 施設カタログ(hooks を使わないので直接テスト可能) --------------------

/** [束B/B-4] コスト資源の在庫が足りているか(判定ではなく表示上の目印)。 */
function isCatalogEntryInsufficient(
  entry: FacilityCatalogEntry,
  resources: readonly ResourceView[],
): boolean {
  if (entry.buildCostApprox === null || entry.buildCostResourceId === null) return false;
  const stock =
    resources.find((resource) => resource.resourceId === entry.buildCostResourceId)?.stockApprox ??
    0;
  return stock < entry.buildCostApprox;
}

export interface FacilityCatalogButtonProps {
  readonly entry: FacilityCatalogEntry;
  /** 配置待ち中のこのボタン(選択中)か。 */
  readonly active: boolean;
  /** [束B/B-4] 建設コストの資源が現在の在庫で足りないか。 */
  readonly insufficient: boolean;
  readonly onPick: (defId: EntityId) => void;
  /**
   * [M61/FC6] 建設前に見せる効果の一言(寝床の実効果 / 非稼働施設の「効果は
   * 未実装」)。`null`/省略 = 通常施設(何も添えない・既存呼び出し元との後方
   * 互換)。R1-C02「非稼働4施設が通常施設と同一の見た目でカタログに並ぶ」への
   * 対応。
   */
  readonly effectHint?: string | null;
}

/**
 * カタログ 1 件。44px 角の最小タップ領域は CSS(`.kf-catalog__button`)で担保。
 * [束B/B-4] コストを併記し、在庫不足は色 + 記号(▲)の両方で示す
 * (色だけに頼らない・LossClassBadge.tsx と同じ方針)。ボタン自体は
 * 非活性にしない(判定は engine の `insufficientResource` reject に委ねる)。
 */
export function FacilityCatalogButton({
  entry,
  active,
  insufficient,
  onPick,
  effectHint = null,
}: FacilityCatalogButtonProps) {
  const classes = ["kf-catalog__button"];
  if (active) classes.push("kf-catalog__button--active");
  if (insufficient) classes.push("kf-catalog__button--insufficient");
  return (
    <li>
      <button
        type="button"
        class={classes.join(" ")}
        data-def-id={entry.defId}
        aria-pressed={active}
        onClick={() => onPick(entry.defId)}
      >
        <span class="kf-catalog__label">{facilityLabel(entry.defId)}</span>
        <span class="kf-catalog__footprint" aria-hidden="true">
          {entry.footprint.width}×{entry.footprint.height}
        </span>
        <span class="kf-catalog__cost">
          {entry.buildCostApprox === null || entry.buildCostResourceId === null
            ? "コストなし"
            : `${insufficient ? "▲ " : ""}コスト ${entry.buildCostApprox} ${resourceLabel(entry.buildCostResourceId)}`}
        </span>
        {effectHint !== null && <span class="kf-catalog__effect-hint">{effectHint}</span>}
      </button>
    </li>
  );
}

export interface FacilityCatalogPanelProps {
  readonly catalog: readonly FacilityCatalogEntry[];
  /** 配置待ち中の defId(未選択は null)。 */
  readonly pendingDefId: EntityId | null;
  /** [束B/B-4] 在庫不足の色分け用(建設コストの判定はしない・表示のみ)。 */
  readonly resources: readonly ResourceView[];
  readonly onPick: (defId: EntityId) => void;
  readonly onCancel: () => void;
  /** [M61/FC6] defId → 建設前の効果ヒント(`null`/未指定=通常施設は何も無し)。 */
  readonly effectHintByDefId?: ReadonlyMap<EntityId, string>;
}

/** 「タップ選択 → 配置先タップ」の 1 ステップ目。 */
export function FacilityCatalogPanel({
  catalog,
  pendingDefId,
  resources,
  onPick,
  onCancel,
  effectHintByDefId,
}: FacilityCatalogPanelProps) {
  return (
    <section class="kf-catalog" aria-label="施設カタログ">
      <h3 class="kf-catalog__title">建てるものを選び、空きセルをタップ</h3>
      <ul class="kf-catalog__list">
        {catalog.map((entry) => (
          <FacilityCatalogButton
            key={entry.defId}
            entry={entry}
            active={entry.defId === pendingDefId}
            insufficient={isCatalogEntryInsufficient(entry, resources)}
            onPick={onPick}
            effectHint={effectHintByDefId?.get(entry.defId) ?? null}
          />
        ))}
      </ul>
      {pendingDefId !== null && (
        <button type="button" class="kf-catalog__cancel" onClick={onCancel}>
          配置をキャンセル
        </button>
      )}
    </section>
  );
}

// --- 2. 瓦礫の開墾パネル(GDD 9.1・hooks 不使用) -----------------------------

export interface ReclaimPanelProps {
  readonly cell: CellViewModel;
  readonly info: ReclaimInfo;
  readonly onReclaim: () => void;
}

/**
 * 瓦礫セル選択 → 通算解放数に応じたコスト表示 → `reclaimCell` 発行
 * (M52 申し送りどおりの導線)。**コストは表示するだけ**で在庫不足の判定は
 * しない(engine の `insufficientResource` reject に委ねる・§2)。
 * [束B/B-4] 在庫が足りないときは色 + 記号(▲)で明示する(表示のみ)。
 */
export function ReclaimPanel({ cell, info, onReclaim }: ReclaimPanelProps) {
  const insufficient =
    info.available &&
    info.nextCostApprox !== null &&
    (info.availableStockApprox ?? 0) < info.nextCostApprox;
  return (
    <section class="kf-reclaim" aria-label="瓦礫の開墾">
      <h3 class="kf-reclaim__title">未開墾({cellCoordinateLabel(cell.cellId)})</h3>
      {!info.available ? (
        <p class="kf-reclaim__inactive">この盤面では開墾システムが無効です。</p>
      ) : (
        <>
          {/* [M63/R4-A12/A13] 生の数値をそのまま埋め込んでいた(整形ヘルパを
              通していないため float 起因の端数がそのまま出うる=「開墾パネル
              在庫417.29」)。コストは formatResourceAmount(実額)、在庫は
              HUD と揃えて formatResourceStock(整数切り捨て)へ統一する。 */}
          <p class="kf-reclaim__cost">
            開墾コスト: {formatResourceAmount(info.nextCostApprox ?? 0)}
            {info.costResourceId !== null ? resourceLabel(info.costResourceId) : ""}
            (通算 {info.reclaimedCount} 枚目)
          </p>
          <p
            class={
              insufficient
                ? "kf-reclaim__stock kf-reclaim__stock--insufficient"
                : "kf-reclaim__stock"
            }
          >
            {insufficient ? "▲ " : ""}
            在庫: {formatResourceStock(info.availableStockApprox ?? 0)}
            {info.costResourceId !== null ? resourceLabel(info.costResourceId) : ""}
          </p>
          <button type="button" class="kf-reclaim__button" onClick={onReclaim}>
            開墾する
          </button>
        </>
      )}
    </section>
  );
}

// --- 3. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function GridScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "grid", { activate: false });

  const catalog = useSignalValue(store.derived.facilityCatalog);
  const selectedCell = useSignalValue(store.derived.selectedCell);
  const breakdown = useSignalValue(store.derived.selectedCellBreakdown);
  const reclaimInfo = useSignalValue(store.derived.reclaimInfo);
  const adjacencyMatrix = useSignalValue(store.derived.adjacencyMatrix);
  const summary = useSignalValue(store.derived.gridSummary);
  const resources = useSignalValue(store.derived.resources);
  // content は起動後に差し替わらないので非追跡の peek で読む(他画面前例どおり)。
  // [M61/FC6] カタログの建設前ヒント(寝床の実効果/非稼働の未実装表示)に使う。
  const content = store.peekContent();

  const [pendingDefId, setPendingDefId] = useState<EntityId | null>(null);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const toastStack = useToastStack();

  const effectHintByDefId = useMemo(() => {
    const hints = new Map<EntityId, string>();
    for (const [defId, def] of content.facilityDefs) {
      const kind = facilityEffectKind(def);
      if (kind === "bedCapacity") {
        const text = bedCapacityEffectText(def, 1);
        if (text !== null) hints.set(defId, text);
      } else if (kind === "storageCapacity") {
        // [M61/FC6・2026-08-02差し戻し] 保管庫: 「効果は未実装」ではなく実効果
        // (facilityEffect.ts §2「保管庫」)。[M63/R4-A01] 「現在庫が上限超なら
        // 建てると不利益」という警告は加算方式の下では逆情報だったため撤去
        // (facilityEffect.ts §2 追記参照。継続的な上限到達の警告は
        // HUD/ホームアラートの担当)。
        const text = storageCapacityEffectText(def, 1);
        if (text !== null) hints.set(defId, text);
      } else if (kind === "none") {
        hints.set(defId, DORMANT_FACILITY_EFFECT_TEXT);
      } else {
        // [M62/FC9・R2-C01] worker系(通常稼働)施設にも対称にヒントを出す
        // (以前は寝床/保管庫/非稼働の3 kindだけで、通常施設だけヒントが
        // 無い非対称があった)。基礎産出0(捏造しない対象外)なら出さない。
        const text = workerEffectHintText(def, 1);
        if (text !== null) hints.set(defId, text);
      }
    }
    return hints;
  }, [content]);

  // 採番は「選んだ瞬間の state」から 1 度だけ行い、配置が済む/キャンセルされる
  // までは同じ候補 ID を保つ(pendingDefId が変わらない限り再計算しない)。
  // store は 1 起動につき 1 個の不変参照(architecture.md §6-3)なので、
  // 依存配列は実質 pendingDefId だけで足りる。
  const pendingPlacement = useMemo<PendingPlacement | null>(() => {
    if (pendingDefId === null) return null;
    return { facilityId: nextFacilityId(store.peekState(), pendingDefId), defId: pendingDefId };
  }, [store, pendingDefId]);

  function pickCatalogEntry(defId: EntityId): void {
    setPendingDefId(defId);
    setLastRejection(null);
  }

  function cancelPending(): void {
    setPendingDefId(null);
    setLastRejection(null);
  }

  function handlePlacementResult(result: CommandResult): void {
    if (result.ok) {
      setPendingDefId(null);
      setLastRejection(null);
      return;
    }
    setLastRejection(result.rejection);
  }

  // [束B/B-4] 成功トースト。GridBoard 側で捕まえた投入前/投入後の在庫を
  // 文言へ組み立てるだけで、判定は一切しない。
  // [M63/R4-A14] 廃材代替の内訳(「薪28+廃材7」)を表示するため、消費量ベースの
  // `resourceSpendBreakdownPhrase` へ切り替える(旧「薪 60→30」の前後在庫表記
  // だと廃材代替で減った分が見えなかった)。
  function handlePlacementSuccess(info: PlacementSuccessInfo): void {
    const diff = resourceSpendBreakdownPhrase(
      {
        resourceId: info.resourceId,
        beforeStockApprox: info.beforeStockApprox,
        afterStockApprox: info.afterStockApprox,
      },
      {
        resourceId: info.wasteResourceId,
        beforeStockApprox: info.wasteBeforeStockApprox,
        afterStockApprox: info.wasteAfterStockApprox,
      },
    );
    toastStack.push(`${facilityLabel(info.defId)}を建てた${diff.length > 0 ? `(${diff})` : ""}`);
  }

  function handleReclaim(): void {
    if (selectedCell === null) return;
    const costResourceId = reclaimInfo.costResourceId;
    const beforeStockApprox =
      costResourceId === null ? null : resourceStockApprox(store.peekState(), costResourceId);
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "reclaimCell", cellIndex: selectedCell.cellIndex },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    const afterStockApprox =
      costResourceId === null ? null : resourceStockApprox(store.peekState(), costResourceId);
    const diff = resourceDeltaPhrase(costResourceId, beforeStockApprox, afterStockApprox);
    // [M61/FC5・R1-A17] トースト本文の cellId 生露出("c12を開墾した")を
    // 人間可読座標へ。
    toastStack.push(
      `${cellCoordinateLabel(selectedCell.cellId)}を開墾した${diff.length > 0 ? `(${diff})` : ""}`,
    );
  }

  const overcrowd: LegendOvercrowdInfo = {
    threshold: adjacencyMatrix.overcrowd.threshold,
    penaltyPerExcessPercent: Math.round(
      toApproxNumber(adjacencyMatrix.overcrowd.penaltyPerExcessFix) * 100,
    ),
  };

  return (
    <section class="kf-grid-screen" aria-labelledby="kf-grid-screen-title">
      {/* [束A/F-4] 見出しと集計は 1 行に畳む(fold 内へ盤面と内訳を入れるため)。 */}
      <div class="kf-grid-screen__head">
        <h2 class="kf-grid-screen__title" id="kf-grid-screen-title">
          格子ビュー
        </h2>
        <p class="kf-grid-screen__summary">
          設置 {summary.occupiedCellCount}/{GRID_CELL_COUNT}セル・過密{" "}
          {summary.overcrowdedFacilityCount}件
        </p>
      </div>
      <p class="kf-screen-intro">本拠の6×8マスに施設を配置し、隣接ボーナスを組み立てます。</p>

      <ToastStackView toasts={toastStack.toasts} />

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {/* [束A/F-4] 3 ブロックの並べ替えは CSS(gridBoard.css の grid-template-areas)
          の担当。ここは「カタログ → 盤面 → 内訳/凡例」というソース順だけを持つ:
          狭い画面はこの順に積み、広い画面は盤面を左カラムへ回す。 */}
      <div class="kf-grid-screen__layout">
        <div class="kf-grid-screen__catalog-area">
          <FacilityCatalogPanel
            catalog={catalog}
            pendingDefId={pendingDefId}
            resources={resources}
            onPick={pickCatalogEntry}
            onCancel={cancelPending}
            effectHintByDefId={effectHintByDefId}
          />
        </div>

        <div class="kf-grid-screen__board-area">
          <GridBoard
            store={store}
            pendingPlacement={pendingPlacement}
            onPlacementResult={handlePlacementResult}
            onPlacementSuccess={handlePlacementSuccess}
          />
        </div>

        <div class="kf-grid-screen__detail-area">
          {selectedCell !== null && selectedCell.isRubble ? (
            <ReclaimPanel cell={selectedCell} info={reclaimInfo} onReclaim={handleReclaim} />
          ) : (
            <CellBreakdownView
              cellId={selectedCell?.cellId ?? null}
              breakdown={breakdown}
              includeIconDefs={false}
            />
          )}

          {selectedCell !== null && selectedCell.occupied && (
            <button
              type="button"
              class="kf-grid-screen__to-facility"
              onClick={() => onNavigate("facility")}
            >
              この施設の詳細/増築へ
            </button>
          )}

          {/* 凡例は初見のための参照情報であり、毎回見るものではない
              (M19 の実装は無条件に 495px を消費していた)。既定は畳む。 */}
          <details class="kf-legend-fold">
            <summary class="kf-legend-fold__summary">タグ凡例(色+記号+パターン+数値)</summary>
            <LegendPanel overcrowd={overcrowd} includeIconDefs={false} />
          </details>
        </div>
      </div>
    </section>
  );
}
