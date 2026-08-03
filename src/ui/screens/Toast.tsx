// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 成功トースト(束B/B-4)
//
// 建設/増築/開墾/成文化投入/研究開始のコマンドが**成功した後**に見せる差分
// フィードバック(例:「かまどを建てた(薪 60→30)」)。3秒程度で自動消滅し、
// 連続操作した分はスタックして並ぶ。
//
// engine には一切触れない(この画面が読むのは dispatch 済みの結果としての
// state だけであり、判定は 1 行も持たない・architecture.md §6 と同じ規律)。
// RejectionBanner.tsx と対になる「成功側」の共通部品として、②③⑤⑥の各画面が
// これを 1 個ずつマウントする。
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "preact/hooks";

import { toApproxNumber } from "../../engine/fp";
import { entitiesOfKind, type EntityId, type GameState } from "../../engine/state/state";
import { resourceLabel } from "./contentLabels";
import { formatResourceStock } from "./format";
import "./toast.css";

const TOAST_DURATION_MS = 3000;

export interface ToastItem {
  readonly id: number;
  readonly text: string;
}

export interface ToastStackApi {
  readonly toasts: readonly ToastItem[];
  readonly push: (text: string) => void;
}

/** 3秒で自動消滅・連続 push でスタックする最小限のトースト状態。 */
export function useToastStack(): ToastStackApi {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const nextId = useRef(0);

  const push = useCallback((text: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { id, text }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return { toasts, push };
}

export interface ToastStackViewProps {
  readonly toasts: readonly ToastItem[];
}

export function ToastStackView({ toasts }: ToastStackViewProps) {
  if (toasts.length === 0) return null;
  return (
    <ul class="kf-toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <li key={toast.id} class="kf-toast-stack__item">
          {toast.text}
        </li>
      ))}
    </ul>
  );
}

/** state から資源 1 件の在庫近似値を引く(受け皿 entity が無ければ null)。 */
export function resourceStockApprox(state: GameState, resourceId: EntityId): number | null {
  for (const resource of entitiesOfKind(state, "resource")) {
    if (resource.resourceId === resourceId) return toApproxNumber(resource.stock);
  }
  return null;
}

/**
 * 「薪 60→30」形式の差分句を作る。対象資源が無い/前後が同じなら空文字列
 * (呼び出し側は空文字列なら丸括弧ごと付けない)。
 */
export function resourceDeltaPhrase(
  resourceId: EntityId | null,
  beforeApprox: number | null,
  afterApprox: number | null,
): string {
  if (resourceId === null || beforeApprox === null || afterApprox === null) return "";
  const before = formatResourceStock(beforeApprox);
  const after = formatResourceStock(afterApprox);
  // 在庫は整数切り捨て表示(format.ts の formatResourceStock 参照)のため、
  // 端数だけの変動は表示上同値になる —— その場合も句を出さない。
  if (before === after) return "";
  return `${resourceLabel(resourceId)} ${before}→${after}`;
}

/** {@link resourceSpendBreakdownPhrase} が読む「前後の在庫」1 組。 */
export interface ResourceSpendSnapshot {
  readonly resourceId: EntityId | null;
  readonly beforeStockApprox: number | null;
  readonly afterStockApprox: number | null;
}

function spentAmountText(snapshot: ResourceSpendSnapshot): string | null {
  if (
    snapshot.resourceId === null ||
    snapshot.beforeStockApprox === null ||
    snapshot.afterStockApprox === null
  ) {
    return null;
  }
  const spent = snapshot.beforeStockApprox - snapshot.afterStockApprox;
  const text = formatResourceStock(spent);
  // 整数切り捨て後に 0 なら「消費した」と言えるほどの変化が無い。
  if (text === "0" || text === "-0") return null;
  return text;
}

/**
 * [M63/R4-A14] 廃材代替(GDD 6.7 の3出口(1)(2)・建設/増築は最大20%・成文化の
 * 粘土は低比率)が実際に起きたときの消費内訳句(「薪28+廃材7」)。
 *
 * 建設/増築/成文化投入は、廃材在庫があれば**黙って**コストの一部を廃材で
 * 肩代わりする(`substituteCostWithWaste`・engine 側は正しく動いている)。
 * ところが成功トーストは主資源の増減しか見せておらず、「表示は薪35のみ・
 * 実消費は薪28+廃材7」という無説明な内訳の欠落があった(R4-A14)。
 *
 * このヘルパは判定を一切しない(廃材代替が起きたかどうかも「前後の在庫差分」
 * という**観測**からしか判断しない・§B4 の規律どおり)。主資源の消費が無い
 * (在庫不足で reject された/コストが 0 等)なら空文字列、廃材の消費が無い
 * (代替が起きなかった/廃材資源が渡されていない)なら主資源だけの句
 * (「薪28」)を返す。
 */
export function resourceSpendBreakdownPhrase(
  primary: ResourceSpendSnapshot,
  waste: ResourceSpendSnapshot,
): string {
  const primaryText = spentAmountText(primary);
  if (primaryText === null || primary.resourceId === null) return "";
  const wasteText = spentAmountText(waste);
  if (wasteText === null || waste.resourceId === null) {
    return `${resourceLabel(primary.resourceId)}${primaryText}`;
  }
  return `${resourceLabel(primary.resourceId)}${primaryText}+${resourceLabel(waste.resourceId)}${wasteText}`;
}
