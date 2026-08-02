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
import { ToastStackView, useToastStack } from "../Toast";
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
      return "停滞中(再研究できます)";
    case "lostIrreversible":
      return "喪失(この周回では二度と得られません)";
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

/**
 * [束B/B-4] 「研究を開始」が確実に失敗する理由(前提未達/解禁済み/一回性喪失)。
 * 無ければ null。**判定ではなく表示上の予告**であり、ボタンは非活性にしない
 * (押した結果の最終判定は engine の apply が行う・architecture.md §6)。
 */
function guaranteedFailureReason(entry: ResearchTreeEntry): string | null {
  if (entry.status === "completed") return "既に解禁済みです";
  if (entry.status === "lostIrreversible") {
    return "取り返しのつかない喪失で、この周回では再研究できません";
  }
  if (!entry.prereqsMet) return "前提の技術がまだ解禁されていません";
  return null;
}

// --- 2. 1 行(hooks 不使用・直接テスト可能) ----------------------------------

export interface ResearchTechRowProps {
  readonly entry: ResearchTreeEntry;
  readonly onBeginResearch: (techId: EntityId) => void;
}

/**
 * 1 行 = 見出し行(名前 + (A)/(B) バッジ + 開始ボタン)+ 状態 + 前提/コスト。
 *
 * **[束A/M-3] 5 段組(名前/状態/前提/コスト/ボタン)を 3 段へ畳んだ**。
 * 24 本 × 150px で 4640px あった画面高を詰めるための変更であり、出す情報は
 * 1 つも減らしていない(前提とコストを同じ行に並べただけ)。
 *
 * **[束B/B-4] 確実に失敗する状態は淡色化 + aria-disabled + 理由の併記**。
 * クリックそのものは塞がない(reject 委譲方針は維持)。
 */
export function ResearchTechRow({ entry, onBeginResearch }: ResearchTechRowProps) {
  const failureReason = guaranteedFailureReason(entry);
  return (
    <li class="kf-research-row" data-tech-id={entry.techId} data-status={entry.status}>
      <div class="kf-research-row__head">
        <span class="kf-research-row__name">{techLabel(entry.techId)}</span>
        <LossClassBadge lossClass={entry.lossClass} />
        <button
          type="button"
          class={
            failureReason === null
              ? "kf-research-row__start-button"
              : "kf-research-row__start-button kf-research-row__start-button--unlikely"
          }
          aria-disabled={failureReason !== null}
          title={failureReason ?? undefined}
          onClick={() => onBeginResearch(entry.techId)}
        >
          研究を開始
        </button>
      </div>
      <p class="kf-research-row__status">{statusText(entry)}</p>
      {failureReason !== null && (
        <p class="kf-research-row__unlikely-reason">{failureReason}。押しても開始できません。</p>
      )}
      <p class="kf-research-row__prereqs">
        {prereqText(entry)}
        <span class="kf-research-row__cost">研究コスト: {entry.researchCostApprox.toFixed(1)}</span>
      </p>
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

/**
 * [束A/M-3] 既定で開くエラを決める。
 *
 * M31 の実装は 24 本を全部開いたまま積んでいたため画面高が 4640px になり、
 * 「今どこまで進んでいるか」を見るのに 7 画面ぶんスクロールが要った
 * (UX プレイテスト M-3)。開くのは
 *   (a) 研究中の tech を含むエラ(今まさに進んでいる場所)と
 *   (b) 未解禁が残る最初のエラ(次に手を付ける場所)
 * だけにする。全エラ解禁済みなら最後のエラを開く(空っぽの画面にしない)。
 *
 * hooks を使わない純関数なので直接テストできる。
 */
export function eraOpenFlags(groups: readonly ResearchEraGroup[]): readonly boolean[] {
  let frontier = groups.findIndex((group) =>
    group.entries.some((entry) => entry.status !== "completed"),
  );
  if (frontier === -1) frontier = groups.length - 1;
  return groups.map(
    (group, index) =>
      index === frontier || group.entries.some((entry) => entry.status === "researching"),
  );
}

export interface ResearchEraSectionProps {
  readonly group: ResearchEraGroup;
  readonly onBeginResearch: (techId: EntityId) => void;
  /** 既定で開くか(`eraOpenFlags`)。開閉そのものは details 要素の状態に任せる。 */
  readonly defaultOpen?: boolean;
}

export function ResearchEraSection({
  group,
  onBeginResearch,
  defaultOpen = false,
}: ResearchEraSectionProps) {
  const completed = group.entries.filter((entry) => entry.status === "completed").length;
  return (
    <details class="kf-research-era" open={defaultOpen}>
      <summary class="kf-research-era__summary">
        <span class="kf-research-era__title">{eraLabel(group.eraId)}</span>
        <span class="kf-research-era__count">
          解禁 {completed}/{group.entries.length}
        </span>
        {/* [M61/FC11・R1-A28] details/summary は開閉の視覚的手がかりが無かった
            (summary を display:flex にすると既定の▶マーカーが消える)。ナビの
            ▾/▴(AppShell.tsx の kf-nav__caret)と同じ記号を明示的に足す。
            開/閉の切替は details の [open] 属性を CSS 側(researchScreen.css)
            で見て記号を差し替える(JS 状態を持たない・ブラウザネイティブの
            開閉に追随)。 */}
        <span class="kf-research-era__caret" aria-hidden="true" />
      </summary>
      <ul class="kf-research-era__list">
        {group.entries.map((entry) => (
          <ResearchTechRow key={entry.techId} entry={entry} onBeginResearch={onBeginResearch} />
        ))}
      </ul>
    </details>
  );
}

// --- 4. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function ResearchScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "research", { activate: false });

  const tree = useSignalValue(store.derived.researchTree);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  const toastStack = useToastStack();

  function handleBeginResearch(techId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: {
        kind: "beginResearch",
        researchId: researchEntityIdFor(techId),
        techId,
      },
    });
    if (result.command !== null && !result.command.ok) {
      setLastRejection(result.command.rejection);
      return;
    }
    setLastRejection(null);
    // 研究は資源ではなく研究点(施設の稼働就労者)で進むので資源差分は無い
    // (成文化/建設と違い資源コストが無い・rules/research.ts)。
    toastStack.push(`「${techLabel(techId)}」の研究を開始した`);
  }

  const groups = groupResearchTreeByEra(tree);
  const openFlags = eraOpenFlags(groups);

  return (
    <section class="kf-research-screen" aria-labelledby="kf-research-screen-title">
      <h2 class="kf-research-screen__title" id="kf-research-screen-title">
        研究ツリー
      </h2>
      <p class="kf-screen-intro">
        テックツリーを進め、新しい施設や機能を解禁します。技術には(A)失っても取り戻せるものと
        (B)一度失うと二度と戻らないものがあり、常にバッジで区別しています。
      </p>

      <ToastStackView toasts={toastStack.toasts} />

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {tree.length === 0 ? (
        <p class="kf-research-screen__empty">tech 定義がありません。</p>
      ) : (
        groups.map((group, index) => (
          <ResearchEraSection
            key={group.eraId ?? "unknownEra"}
            group={group}
            onBeginResearch={handleBeginResearch}
            defaultOpen={openFlags[index] ?? false}
          />
        ))
      )}

      <div class="kf-research-screen__nav">
        <button
          type="button"
          class="kf-research-screen__nav-button"
          onClick={() => onNavigate("codify")}
        >
          成文化キューへ
        </button>
      </div>
    </section>
  );
}
