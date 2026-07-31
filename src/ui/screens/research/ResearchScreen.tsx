// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ⑤研究ツリー(M31)— GDD 5 / 7.4 / 11.4-1
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   `store.derived.researchTree`(エラ順 × エラ内 ID 昇順・derived.ts §7)を
//   一覧表示する。各行は (A)/(B) 二層(GDD 7.4)を**常時**バッジで示し、状態
//   (未着手/研究中/解禁済み/停滞喪失/一回性喪失)と前提関係を文章で表す。
//
// ===========================================================================
// 2. 「研究を開始」ボタンの判定は engine に委ねる
// ===========================================================================
//   [2026-08-01 M50 で結線済み] `beginResearch` は M50 が実装した(選択が
//   有効ならそれ/無ければ従来の ID 昇順先頭、の2段)。本画面は M31 時点から
//   **判定を画面に書かない**という architecture.md §6 の規律で組んであり、
//   ボタンは常に活性・常に dispatch する。engine が
//   `notImplemented`(担当 M50)で拒否するので、その理由を `RejectionBanner`
//   でそのまま見せる。M50 が実装された瞬間、この画面は 1 行も変えずに
//   実際に研究を開始できるようになる(FacilityScreen の増築ボタン・
//   ResidentsScreen の割当セレクトと同じ設計)。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import { entityIdFromString, type EntityId } from "../../../engine/state/state";
import type { ResearchTreeEntry, ResearchTreeStatus } from "../../derived";
import { eraLabel, techLabel } from "../contentLabels";
import { LossClassBadge } from "../LossClassBadge";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./researchScreen.css";

// --- 1. 表示文言(判定は derived.ts・ここは文言だけ) -------------------------

/** `ResearchTreeStatus` の全件を必ず埋める(型で強制)。 */
function statusText(entry: ResearchTreeEntry): string {
  const status: ResearchTreeStatus = entry.status;
  switch (status) {
    case "notStarted":
      return "未着手";
    case "researching": {
      const progress = entry.progressApprox ?? 0;
      const queueNote = entry.isCurrentResearchTarget ? "" : "(キュー待ち)";
      return `研究中: 進行度 ${progress.toFixed(1)}/${entry.researchCostApprox.toFixed(1)}${queueNote}`;
    }
    case "completed":
      return "解禁済み";
    case "lostRecoverable":
      return "停滞中(GDD 7.4 (A): 再研究できます)";
    case "lostIrreversible":
      return "喪失(GDD 7.4 (B): この周回では二度と得られません)";
    default: {
      const unhandled: never = status;
      throw new TypeError(`未知の研究状態 ${JSON.stringify(unhandled)}`);
    }
  }
}

function prereqText(entry: ResearchTreeEntry): string {
  if (entry.prereqTechIds.length === 0) return "前提: なし(起点テック)";
  const names = entry.prereqTechIds.map((techId) => techLabel(techId)).join("・");
  return `前提: ${names}(${entry.prereqsMet ? "すべて解禁済み" : "未解禁のものがあります"})`;
}

/** `beginResearch` へ渡す research entity ID を techId から決定論的に作る。 */
export function researchEntityIdFor(techId: EntityId): EntityId {
  return entityIdFromString(`research_${techId}`);
}

// --- 2. 1 行(hooks 不使用・直接テスト可能) ----------------------------------

export interface ResearchTechRowProps {
  readonly entry: ResearchTreeEntry;
  readonly onBeginResearch: (techId: EntityId) => void;
}

export function ResearchTechRow({ entry, onBeginResearch }: ResearchTechRowProps) {
  return (
    <li class="kf-research-row" data-tech-id={entry.techId} data-status={entry.status}>
      <div class="kf-research-row__head">
        <span class="kf-research-row__name">{techLabel(entry.techId)}</span>
        <LossClassBadge lossClass={entry.lossClass} />
      </div>
      <p class="kf-research-row__status">{statusText(entry)}</p>
      <p class="kf-research-row__prereqs">{prereqText(entry)}</p>
      <p class="kf-research-row__cost">研究コスト: {entry.researchCostApprox.toFixed(1)}</p>
      <button
        type="button"
        class="kf-research-row__start-button"
        onClick={() => onBeginResearch(entry.techId)}
      >
        研究を開始
      </button>
    </li>
  );
}

// --- 3. エラごとの区切り(GDD 5.2「エラ別テック一覧」) -----------------------

export interface ResearchEraGroup {
  readonly eraId: string | null;
  readonly entries: readonly ResearchTreeEntry[];
}

/**
 * `researchTree` は既にエラ順(derived.ts の `orderedTechIds`)なので、
 * 同じエラの連続を 1 グループへまとめるだけでよい(並べ替えない)。
 */
export function groupResearchTreeByEra(
  entries: readonly ResearchTreeEntry[],
): readonly ResearchEraGroup[] {
  const groups: { eraId: string | null; entries: ResearchTreeEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.eraId === entry.eraId) {
      last.entries.push(entry);
    } else {
      groups.push({ eraId: entry.eraId, entries: [entry] });
    }
  }
  return groups;
}

export interface ResearchEraSectionProps {
  readonly group: ResearchEraGroup;
  readonly onBeginResearch: (techId: EntityId) => void;
}

export function ResearchEraSection({ group, onBeginResearch }: ResearchEraSectionProps) {
  return (
    <section class="kf-research-era" aria-label={eraLabel(group.eraId)}>
      <h3 class="kf-research-era__title">{eraLabel(group.eraId)}</h3>
      <ul class="kf-research-era__list">
        {group.entries.map((entry) => (
          <ResearchTechRow key={entry.techId} entry={entry} onBeginResearch={onBeginResearch} />
        ))}
      </ul>
    </section>
  );
}

// --- 4. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function ResearchScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "research", { activate: false });

  const tree = useSignalValue(store.derived.researchTree);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);

  function handleBeginResearch(techId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "beginResearch",
        researchId: researchEntityIdFor(techId),
        techId,
      },
    });
    setLastRejection(
      result.command !== null && !result.command.ok ? result.command.rejection : null,
    );
  }

  const groups = groupResearchTreeByEra(tree);

  return (
    <section class="kf-research-screen" aria-labelledby="kf-research-screen-title">
      <h2 class="kf-research-screen__title" id="kf-research-screen-title">
        研究ツリー
      </h2>
      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {tree.length === 0 ? (
        <p class="kf-research-screen__empty">tech 定義がありません。</p>
      ) : (
        groups.map((group) => (
          <ResearchEraSection
            key={group.eraId ?? "unknownEra"}
            group={group}
            onBeginResearch={handleBeginResearch}
          />
        ))
      )}

      <div class="kf-research-screen__nav">
        <button
          type="button"
          class="kf-research-screen__nav-button"
          onClick={() => onNavigate("codify")}
        >
          ⑥成文化キューへ
        </button>
      </div>
    </section>
  );
}
