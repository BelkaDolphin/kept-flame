// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- memoirLog(決定論エピソードログ)— GDD 7.3 / M12
//
// ===========================================================================
// 1. 位置づけ(M12「memoirLog + bond + 記憶可視化のデータ層」)
// ===========================================================================
//   GDD 7.3 の 3 機構のうち「決定論エピソードログ」を担当する。**データ層のみ**
//   (UI は対象外)であり、テンプレの**実際の文言**(日本語プロース)は持たない。
//   保存するのは「テンプレ ID(state.ts の MemoirEntryKind)+ 決定論パラメータ」
//   だけであり、これは ADR-012 のセーブ容量目標(512KB)と GDD 8.2 の探索
//   スナップショット方式(結果を丸ごと保存せず、再現に要る最小パラメータだけを
//   保存する)に倣った設計判断である。実際の文言をレンダリングする層(UI/content)
//   が M12 より後でテンプレ ID → 文言の対応表を持つことになる。
//
//   **M6(成文化)・M11(寿命)と同じく tick ループへは結線しない。**
//   scheduler.ts・rules/population.ts 等の既存ファイルは意図的に無改変とし
//   (並行作業中の M49 との衝突回避・タスク指示による制約)、「動く形」までを
//   純関数で用意する。結線(住民生成時の bio 付与・死亡時の記録)は後続タスクの
//   担当とする。
//
// ===========================================================================
// 2. 保存形式は resident の省略可フィールド(state.ts の MemoirLogState 参照)
// ===========================================================================
//   独立 entity(`kind: "memoir"`)にする案も検討したが、`EntityKind`/
//   `EntityState` へ新種別を足すと `src/ui/derived.ts` 等の既存の網羅 switch
//   (`default: never`)が壊れることが typecheck で判明した(UI はこのタスクの
//   担当外・タスク指示「`src/ui/**` は触るな」)。そのため resident 側の
//   `memoir?: MemoirLogState` フィールドとして持つ。代償は直列化の分岐が
//   `stats?` / `life?` と合わせて 2^3 = 8 通りに膨れることだが
//   (serialize.ts §6)、生スプレッド禁止の下でも undefined の 3 変数を素直に
//   8 リテラルへ書き分ければ済む。
//
// ===========================================================================
// 3. テンプレ選択の決定論性(検収条件「Map 反復順依存が無いこと」への回答)
// ===========================================================================
//   bio 3 カテゴリの走査順は {@link MEMOIR_BIO_KINDS} という**配列リテラル**の
//   宣言順に固定してあり、Map/Set の反復順には一切依存しない。各カテゴリの
//   候補選択も `hashedDrawUint32`(hash アドレス方式・stochastic.ts §2(a))で
//   `(worldSeed, residentId, bioKind)` から直接導出するので、呼び出し順・
//   他の住民の生成順・content のロード順のいずれにも依存しない。
// ---------------------------------------------------------------------------

import { DOMAIN_TAGS } from "../rng/domainTags";
import { hashedDrawUint32, saltFromId, uniformIntFromDraw } from "../stochastic";
import {
  requireEntity,
  type EntityId,
  type GameState,
  type MemoirBioKind,
  type MemoirEntry,
  type MemoirLogState,
} from "../state/state";
import { setField, updateEntity } from "../state/update";

// --- 1. 定数(GDD に明示の無い engine 定数・要ユーザー判断) -----------------

/**
 * bio 1 カテゴリあたりの候補テンプレ数。**GDD に明示が無い engine 定数**
 * (要ユーザー判断)。実際の文言は未実装(§1)であり、この数は「決定論選択の
 * 候補数」という構造だけを先に固定するプレースホルダである。
 */
export const MEMOIR_BIO_VARIANT_COUNT = 8;

/**
 * memoirLog の保持件数上限(GDD 7.3「件数上限で古いものは要約に畳む」)。
 * **上限の具体値は GDD に無い engine 定数**(要ユーザー判断)。
 */
export const MAX_MEMOIR_ENTRIES = 12;

/** bio 3 カテゴリ(§3)。宣言順が選択走査順であり Map を経由しない。 */
export const MEMOIR_BIO_KINDS: readonly MemoirBioKind[] = [
  "bioOrigin",
  "bioCatchphrase",
  "bioFear",
];

/** {@link recentMemoirHighlights} の既定件数。**GDD に無い engine 定数**(要ユーザー判断)。 */
export const DEFAULT_MEMOIR_HIGHLIGHT_LIMIT = 3;

// --- 2. クエリ ---------------------------------------------------------------

/**
 * 住民の memoirLog を引く(まだ 1 件も無ければ undefined)。
 *
 * @throws {EntityLookupError} 住民が存在しない場合(state/state.ts の requireEntity)
 */
export function memoirLogOf(state: GameState, residentId: EntityId): MemoirLogState | undefined {
  return requireEntity(state, residentId, "resident").memoir;
}

// --- 3. テンプレ選択(§3) ---------------------------------------------------

/**
 * bio 1 カテゴリの候補選択(hash アドレス方式・stochastic.ts §2(a))。
 * 同じ (worldSeed, residentId, bioKind) なら常に同じ値であり、他の住民の
 * 生成順・呼び出し順に依存しない。
 */
export function pickBioVariantIndex(
  worldSeedU32: number,
  residentId: EntityId,
  bioKind: MemoirBioKind,
): number {
  const draw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.memoir, [
    saltFromId(residentId),
    saltFromId(bioKind),
  ]);
  return uniformIntFromDraw(draw, 0, MEMOIR_BIO_VARIANT_COUNT - 1);
}

/**
 * 加入時に決定論生成される bio 3 件(GDD 7.3「出自・口癖・恐れ」)。
 * 走査順は {@link MEMOIR_BIO_KINDS} の宣言順で固定(§3)。
 */
export function generateResidentBioEntries(
  worldSeedU32: number,
  residentId: EntityId,
  tick: number,
): readonly MemoirEntry[] {
  return MEMOIR_BIO_KINDS.map((bioKind) => ({
    kind: bioKind,
    tick,
    variantIndex: pickBioVariantIndex(worldSeedU32, residentId, bioKind),
  }));
}

// --- 4. 追記と件数上限の折り畳み(GDD 7.3「件数上限で古いものは要約に畳む」) -

/**
 * {@link MemoirLogState} へ 1 件追記した結果を作る純関数(state を触らない)。
 * 上限({@link MAX_MEMOIR_ENTRIES})を超えたら最古の 1 件を落として
 * `foldedCount` を +1 する(詳細は失うが「N 件の古い記憶は淡くなった」という
 * **要約**として件数だけ残る = GDD の「要約に畳む」の最小実装)。
 */
export function foldedAppend(
  log: MemoirLogState | undefined,
  entry: MemoirEntry,
  maxEntries: number = MAX_MEMOIR_ENTRIES,
): MemoirLogState {
  const priorEntries = log?.entries ?? [];
  const priorFolded = log?.foldedCount ?? 0;

  const merged = [...priorEntries, entry];
  const overflow = merged.length - maxEntries;
  const entries = overflow > 0 ? merged.slice(overflow) : merged;
  const foldedCount = overflow > 0 ? priorFolded + overflow : priorFolded;
  return { entries, foldedCount };
}

/**
 * memoirLog へ 1 件追記する。
 *
 * **呼び出し順が memoirLog のバイト列を決める**(このモジュールは並べ替えを
 * 行わない・純粋な追記のみ)。同一 seed で同じ順序の呼び出し列を再現できれば
 * バイト同一になる。scheduler へ結線する際は tie-break の全順序
 * (scheduler.ts §3: tick → パイプライン段 → entityId)と同じ順序で呼び出すこと
 * (このモジュール自身は tick ループを持たないので強制はできない。呼び出し側の
 * 責務として明記する)。
 *
 * @throws {EntityLookupError} 住民が存在しない場合
 */
export function appendMemoirEntry(
  state: GameState,
  residentId: EntityId,
  entry: MemoirEntry,
  maxEntries: number = MAX_MEMOIR_ENTRIES,
): GameState {
  return updateEntity(state, residentId, "resident", (r) =>
    setField(r, "memoir", foldedAppend(r.memoir, entry, maxEntries)),
  );
}

/** {@link appendMemoirEntry} を「加入記録 → bio 3 件」の順にまとめて行う便宜口。 */
export function initializeResidentMemoir(
  state: GameState,
  worldSeedU32: number,
  residentId: EntityId,
  tick: number,
): GameState {
  let next = appendMemoirEntry(state, residentId, { kind: "arrival", tick });
  for (const entry of generateResidentBioEntries(worldSeedU32, residentId, tick)) {
    next = appendMemoirEntry(next, residentId, entry);
  }
  return next;
}

/** 本人の死亡を memoirLog へ記録する(GDD 7.3「〇〇は...と長夜に還した」の記録側)。 */
export function recordDeathMemoir(state: GameState, residentId: EntityId, tick: number): GameState {
  return appendMemoirEntry(state, residentId, { kind: "death", tick });
}

// --- 5. 記憶可視化のためのクエリ(GDD 7.3「記憶の可視化」データ層) ----------

/**
 * 「この人にしかない記憶」の一覧化(GDD 7.3)に使うハイライト抽出。
 *
 * 抽出対象は 2 種(正直な開示):
 *   bondMilestone     : 共働の絆の節目(M12)
 *   explorationRescue : [M21] 探索での保護(GDD 7.3 の例「近郊探索で△を保護した」)
 * GDD 7.3 が挙げる残りの例(成文化した技術)は、`rules/codify.ts` の
 * `CodifyState` に**作業者の紐付けが無い**ため今も対象外である。成文化が
 * 「誰が書き残したか」を持つようになったらこのリストへ追加すること。
 *
 * 戻り値は memoirLog の記録順(= 追記順・古い順)のまま末尾 `limit` 件。
 */
export function recentMemoirHighlights(
  log: MemoirLogState | undefined,
  limit: number = DEFAULT_MEMOIR_HIGHLIGHT_LIMIT,
): readonly MemoirEntry[] {
  if (log === undefined || limit <= 0) return [];
  const highlightable = log.entries.filter(
    (entry) => entry.kind === "bondMilestone" || entry.kind === "explorationRescue",
  );
  return limit >= highlightable.length ? highlightable : highlightable.slice(-limit);
}
