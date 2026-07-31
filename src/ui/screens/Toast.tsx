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
import { formatResourceAmount } from "./format";
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
  if (beforeApprox === afterApprox) return "";
  return `${resourceLabel(resourceId)} ${formatResourceAmount(beforeApprox)}→${formatResourceAmount(afterApprox)}`;
}
