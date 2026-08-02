#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/content-semantics-gate.ts — M51「additive 意味論 diff の機械強制」
// (ADR-015 正準順序 5/10 拡張・GDD 12.4/12.5-2/12.5-3)
//
// ===========================================================================
// 0. 何を守るゲートか(M46 が「未実装」と正直申告した残件)
// ===========================================================================
//   scripts/content-diff-gate.mjs(M46)は git の**構文**(index mode)だけを見る
//   guardrail で、symlink/実行可能ファイル/gitlink を reject する。本スクリプトは
//   その次段として、content/*.json の**値そのもの**(canonicalize 後の JSON
//   構造比較)を base ブランチと突き合わせ、以下 4 点を機械 reject する:
//     1. 既存 ID の削除(GDD 12.5-2)
//     2. 既存 ID のリネーム(削除+新規追加として現れる。検出方針は §2 参照)
//     3. 既存 ID の意味変更(型変更・構造変更。GDD 12.4「既存entityの
//        prereqs/unlocks 改変禁止」+ GDD 12.5-2「意味変更禁止」)
//     4. tombstone 逆参照(GDD 12.5-3: prereqs/fieldRequirement/unlocks/
//        balance 側の実在参照が tombstone 化された ID を指し続けたら reject)
//   **数値のみの変更(バランス調整)は reject しない**(GDD 12.5-8。M39〜M41 が
//   正当に content 数値を変更する)。
//
// ===========================================================================
// 1. 判定は git diff の構文ではなく JSON 意味論で行う
// ===========================================================================
//   base ref の content/<category>.json を `git show <ref>:<path>` で読み、
//   head(= 作業ツリー。CI では PR head を checkout 済み)の同ファイルと共に
//   **canonicalizeJson(engine の単一実装・ADR-023)を通してから**比較する。
//   これにより「キー順序だけ変わった差分」はそもそも差分として現れず、
//   意味を持つ構造差分だけを見る(タスク指示の検分観点そのもの)。
//
// ===========================================================================
// 2. リネーム検出方針(タスク指示: 明記必須)
// ===========================================================================
//   本ゲートは「類似度ヒューリスティック」を一切使わない。リネームは常に
//   「旧 ID が head から消えている」という事実として現れるため、ルール1
//   (削除 reject)がそのまま捕捉する — 新 ID が追加されていようがいまいが、
//   旧 ID の消失それ自体が reject 理由になる(ADR-023「既存ファイル削除+
//   別ID新ファイル追加による実質ID抹消/差替え、およびID跨ぎリネームを
//   旧ID消失として捕捉する」と同型の設計をカテゴリ内 ID 単位へ適用)。
//   正しい「リネーム」の手順は存在しない: 新 ID を additive 追加し、
//   旧 ID は削除せず tombstone 化する(GDD 12.5-2)。
//
// ===========================================================================
// 3. 意味変更 reject の判定規則(数値チューニングとの境界)
// ===========================================================================
//   既存 ID (base に存在し head にも存在する ID) の値を再帰比較し、
//     - 数値 vs 数値: 値が異なっていても許容(バランス調整・GDD 12.5-8)
//     - それ以外(string/boolean/null/型そのもの/配列長/オブジェクトの
//       キー集合)の変化: 1箇所でもあれば reject
//   という規則で「数値のみの変更」だけを additive の範囲として通す。
//   配列長の変化(例: tech.prereqs へ要素を足す/削く)も reject する対象に
//   含む — GDD 12.4 が「既存entityの prereqs/unlocks 改変禁止(leaf限定)」を
//   明記しており、既存 tech の prereqs 配列を書き換える行為はそもそも
//   週次運営で許可されていないため、この境界は GDD と整合する。
//
// ===========================================================================
// 4. tombstone の表現と reverse-reference チェック(§4)
// ===========================================================================
//   tombstone は「entity を配列から消す」のではなく「`tombstoned: true` を
//   立てたまま ID をファイルに残す」soft-delete として表現する(GDD 12.5-2
//   「削除はtombstone化」・ADR-023「tombstone soft-delete のみ許可」)。
//   schema/*.ts はこのフィールドを未知キーとして無視するだけで reject しない
//   (schema/common.ts の各 validate* は既知キーの取り出しのみでキー集合を
//   allowlist しない = 追加フィールドは形式上 additive)。
//   本ゲートが対象とする「既存 ID」カテゴリは、ADR-024(1)のグローバル ID
//   一意性(`schema/idRegistry.ts` の checkGlobalIdUniqueness)と同じ
//   5 カテゴリ(tech/facility/trait/event/outpostType)。balance/adjacency は
//   ID 配列を持たない単一 config のため対象外(balance は既存 tagMatrix/
//   entry 書換の reject を含め別スコープ = 据え置き。最終報告に明記)。
//
//   reverse-reference チェックは head 状態だけを見る静的な不変条件
//   (「tombstone 化された ID を指し続けるものが1つでもあれば reject」)で、
//   base との diff ではない。対象は GDD 12.5-3 が名指しする
//   prereqs/unlocks に加え、contentBundle.ts が既に検証しているクロス
//   カテゴリ参照(fieldRequirement.facility / balance.recallRiskParams.
//   memoryKeeperTraitId / balance.eras[].gateTechId /
//   balance.recordMedia.printingTechId)。event.nodes[].branches[].cond の
//   jsep AST 経由の trait 参照(hasTrait(traitId))は cond DSL のパースを
//   要し本タスクのスコープ外(据え置き。最終報告に明記)。recipe.inputs は
//   contentBundle.ts 自身が「T6 のロード対象外」と明記しているカテゴリで
//   未実装のため同様に対象外。
//
// ===========================================================================
// 5. 決定論・LLM 非依存
// ===========================================================================
//   入力は git show の出力と content JSON のみ。Math.random/Date.now は
//   使わない。走査順は ID を compareUtf16(ADR-010)で昇順ソートしてから行う。
//   LLM/外部サービス呼び出しは一切含まない(CLAUDE.md 絶対ルール)。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalizeJson,
  compareUtf16,
  type JsonObject,
  type JsonValue,
} from "../src/engine/canonicalize";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CONTENT_SEMANTICS_GATE_ROOT
  ? path.resolve(process.env.CONTENT_SEMANTICS_GATE_ROOT)
  : path.resolve(__dirname, "..");
const CONTENT_DIR = process.env.CONTENT_SEMANTICS_GATE_DIR || "content";

/**
 * ID がグローバル一意性の対象になるカテゴリ(schema/idRegistry.ts の
 * checkGlobalIdUniqueness が実際に検証する5カテゴリと一致させる・§4)。
 */
export const ID_NAMESPACED_CATEGORIES = [
  "tech",
  "facility",
  "trait",
  "event",
  "outpostType",
] as const;
export type IdNamespacedCategory = (typeof ID_NAMESPACED_CATEGORIES)[number];

/** GDD 12.5-2「削除はtombstone化」を表現するフィールド名(§4)。 */
export const TOMBSTONE_FIELD = "tombstoned";

// --- JSON 値の小さな型ガード群(noUncheckedIndexedAccess 対応・§3/§4) ---------

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) return null;
  // JsonValue は再帰的なユニオン型のため、TS の制御フロー解析だけでは
  // ここで readonly JsonValue[] 側を確実に排除しきれない(既知の制約)。
  // 上の3ガードで実行時には JsonObject しか残らないことを保証済みなので
  // 型だけ明示する(実行時分岐は素通しの単純キャスト)。
  return value as JsonObject;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";

function jsonKind(value: JsonValue): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return t;
  return "object";
}

function omitKey(obj: JsonObject, key: string): JsonObject {
  if (!(key in obj)) return obj;
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k] as JsonValue;
  }
  return out;
}

// ===========================================================================
// §3: 意味変更 reject の判定(数値のみの差分を許容する再帰比較)
// ===========================================================================

/**
 * base/head を再帰比較し、「数値 vs 数値」以外の差分パスを out へ追記する
 * (純関数・テストから直接叩けるよう export)。
 */
export function diffValueNonNumeric(
  base: JsonValue,
  head: JsonValue,
  path_: string,
  out: string[],
): void {
  if (base === head) return;
  const baseKind = jsonKind(base);
  const headKind = jsonKind(head);
  if (baseKind !== headKind) {
    out.push(path_);
    return;
  }
  if (baseKind === "number") return; // 数値の変更は常に許容(GDD 12.5-8)

  if (baseKind === "array") {
    const baseArr = base as JsonArray;
    const headArr = head as JsonArray;
    if (baseArr.length !== headArr.length) {
      out.push(path_);
      return;
    }
    for (let i = 0; i < baseArr.length; i++) {
      const bv = baseArr[i];
      const hv = headArr[i];
      if (bv === undefined || hv === undefined) {
        // 長さ一致を確認済みなので理論上到達しない。noUncheckedIndexedAccess の
        // 型上のケアとして安全側(構造差分として報告)に倒す。
        out.push(`${path_}[${String(i)}]`);
        continue;
      }
      diffValueNonNumeric(bv, hv, `${path_}[${String(i)}]`, out);
    }
    return;
  }

  if (baseKind === "object") {
    const baseObj = base as JsonObject;
    const headObj = head as JsonObject;
    const baseKeys = Object.keys(baseObj);
    const headKeys = Object.keys(headObj);
    // canonicalizeJson 済みなのでキーは UTF-16 昇順。集合比較は配列比較でよい。
    if (baseKeys.length !== headKeys.length || baseKeys.some((k, i) => k !== headKeys[i])) {
      out.push(path_);
      return;
    }
    for (const key of baseKeys) {
      const bv = baseObj[key];
      const hv = headObj[key];
      if (bv === undefined || hv === undefined) {
        out.push(`${path_}.${key}`);
        continue;
      }
      diffValueNonNumeric(bv, hv, `${path_}.${key}`, out);
    }
    return;
  }

  // string/boolean/null: 同じ kind で base !== head ならそのまま差分。
  out.push(path_);
}

type JsonArray = readonly JsonValue[];

export type EntityChangeStatus =
  "unchanged" | "numericTuning" | "newlyTombstoned" | "resurrected" | "semanticChange";

export interface EntityDiff {
  readonly id: string;
  readonly status: EntityChangeStatus;
  /** status === "semanticChange" のときの非数値差分パス一覧。 */
  readonly changedPaths: readonly string[];
}

/**
 * 同一 ID の base/head エンティティ1件を比較する(§3/§4)。
 * `tombstoned` フィールドは soft-delete の合図として個別ルールで扱い、
 * それ以外のフィールドは §3 の「数値のみ許容」規則で比較する。
 */
export function diffEntity(id: string, base: JsonObject, head: JsonObject): EntityDiff {
  const baseTombstoned = base[TOMBSTONE_FIELD] === true;
  const headTombstoned = head[TOMBSTONE_FIELD] === true;

  const baseRest = omitKey(base, TOMBSTONE_FIELD);
  const headRest = omitKey(head, TOMBSTONE_FIELD);
  const changedPaths: string[] = [];
  diffValueNonNumeric(baseRest, headRest, "$", changedPaths);

  if (baseTombstoned && !headTombstoned) {
    // tombstone は一方向の soft-delete。復活は認めない(GDD 12.5-2/3)。
    return { id, status: "resurrected", changedPaths };
  }
  if (!baseTombstoned && headTombstoned) {
    if (changedPaths.length > 0) {
      // tombstone化と同時に他の非数値フィールドを変更する抱き合わせは
      // 意味変更として reject する(tombstone を隠れ蓑にした改変の防止)。
      return { id, status: "semanticChange", changedPaths };
    }
    return { id, status: "newlyTombstoned", changedPaths: [] };
  }
  if (changedPaths.length > 0) {
    return { id, status: "semanticChange", changedPaths };
  }
  // canonicalizeJson 済みなので JSON.stringify はキー順に依存せず安定した
  // 深い等価判定になる(数値のみ違えば false、完全一致なら true)。
  const identical = JSON.stringify(baseRest) === JSON.stringify(headRest);
  return { id, status: identical ? "unchanged" : "numericTuning", changedPaths: [] };
}

// ===========================================================================
// §1/§2: カテゴリ単位の diff(削除・リネーム・意味変更)
// ===========================================================================

export interface CategoryDiff {
  readonly category: IdNamespacedCategory;
  readonly addedIds: readonly string[];
  readonly deletedIds: readonly string[];
  readonly semanticChangeViolations: readonly {
    readonly id: string;
    readonly changedPaths: readonly string[];
  }[];
  readonly resurrectedIds: readonly string[];
  readonly newlyTombstonedIds: readonly string[];
}

function toEntityMap(
  entities: readonly JsonValue[],
  category: string,
  side: string,
): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const raw of entities) {
    const entity = asObject(raw);
    if (entity === null) {
      throw new Error(
        `content/${category}.json(${side}): 配列要素が object でない(schema検証を経ていない入力の可能性)`,
      );
    }
    const id = asString(entity["id"]);
    if (id === null || id.length === 0) {
      throw new Error(
        `content/${category}.json(${side}): id が string でない要素がある(schema検証を経ていない入力の可能性)`,
      );
    }
    map.set(id, entity);
  }
  return map;
}

/** 1カテゴリぶんの base/head 比較(純関数・export)。 */
export function diffCategory(
  category: IdNamespacedCategory,
  baseEntities: readonly JsonValue[],
  headEntities: readonly JsonValue[],
): CategoryDiff {
  const baseMap = toEntityMap(baseEntities, category, "base");
  const headMap = toEntityMap(headEntities, category, "head");

  const deletedIds: string[] = [];
  const addedIds: string[] = [];
  const semanticChangeViolations: { id: string; changedPaths: readonly string[] }[] = [];
  const resurrectedIds: string[] = [];
  const newlyTombstonedIds: string[] = [];

  const baseIds = [...baseMap.keys()].sort(compareUtf16);
  for (const id of baseIds) {
    const baseEntity = baseMap.get(id);
    const headEntity = headMap.get(id);
    if (baseEntity === undefined) continue; // 到達しない(baseIds は baseMap のキー)
    if (headEntity === undefined) {
      // ルール1(削除) — リネームも「旧IDの消失」として同じ経路で捕捉する(§2)。
      deletedIds.push(id);
      continue;
    }
    const diff = diffEntity(id, baseEntity, headEntity);
    if (diff.status === "semanticChange") {
      semanticChangeViolations.push({ id, changedPaths: diff.changedPaths });
    } else if (diff.status === "resurrected") {
      resurrectedIds.push(id);
    } else if (diff.status === "newlyTombstoned") {
      newlyTombstonedIds.push(id);
    }
  }

  const headIds = [...headMap.keys()].sort(compareUtf16);
  for (const id of headIds) {
    if (!baseMap.has(id)) addedIds.push(id);
  }

  return {
    category,
    addedIds,
    deletedIds,
    semanticChangeViolations,
    resurrectedIds,
    newlyTombstonedIds,
  };
}

// ===========================================================================
// §4: tombstone reverse-reference チェック(head 状態の静的不変条件)
// ===========================================================================

export interface ReferenceEdge {
  readonly from: string;
  readonly targetId: string;
}

/**
 * head content バンドルから「実在 ID を指す」参照エッジを集める。
 * 対象は GDD 12.5-3(prereqs/unlocks)+ contentBundle.ts が既に検証している
 * クロスカテゴリ参照(§4 のコメント参照)。cond DSL 内の hasTrait()/
 * recipe.inputs はスコープ外(据え置き)。
 */
export function collectReferenceEdges(
  headByCategory: ReadonlyMap<IdNamespacedCategory, readonly JsonValue[]>,
  headBalance: JsonValue | null,
): readonly ReferenceEdge[] {
  const edges: ReferenceEdge[] = [];

  for (const raw of headByCategory.get("tech") ?? []) {
    const tech = asObject(raw);
    if (tech === null) continue;
    const id = asString(tech["id"]) ?? "?";

    const prereqs = asArray(tech["prereqs"]) ?? [];
    prereqs.forEach((p, i) => {
      const targetId = asString(p);
      if (targetId !== null) edges.push({ from: `tech.${id}.prereqs[${String(i)}]`, targetId });
    });

    const unlocks = asArray(tech["unlocks"]) ?? [];
    unlocks.forEach((u, i) => {
      const targetId = asString(u);
      if (targetId !== null) edges.push({ from: `tech.${id}.unlocks[${String(i)}]`, targetId });
    });

    const fieldRequirement = asObject(tech["fieldRequirement"]);
    if (fieldRequirement !== null) {
      const facility = asString(fieldRequirement["facility"]);
      if (facility !== null) {
        edges.push({ from: `tech.${id}.fieldRequirement.facility`, targetId: facility });
      }
    }
  }

  const balance = asObject(headBalance ?? null);
  if (balance !== null) {
    const recallRiskParams = asObject(balance["recallRiskParams"]);
    if (recallRiskParams !== null) {
      const memoryKeeperTraitId = asString(recallRiskParams["memoryKeeperTraitId"]);
      if (memoryKeeperTraitId !== null) {
        edges.push({
          from: "balance.recallRiskParams.memoryKeeperTraitId",
          targetId: memoryKeeperTraitId,
        });
      }
    }

    const eras = asArray(balance["eras"]) ?? [];
    eras.forEach((eraRaw, i) => {
      const era = asObject(eraRaw);
      if (era === null) return;
      const gateTechId = asString(era["gateTechId"]);
      if (gateTechId !== null) {
        edges.push({ from: `balance.eras[${String(i)}].gateTechId`, targetId: gateTechId });
      }
    });

    const recordMedia = asObject(balance["recordMedia"]);
    if (recordMedia !== null) {
      const printingTechId = asString(recordMedia["printingTechId"]);
      if (printingTechId !== null) {
        edges.push({ from: "balance.recordMedia.printingTechId", targetId: printingTechId });
      }
    }
  }

  return edges;
}

/** head 状態で tombstoned:true が立っている ID の集合(全 ID 名前空間カテゴリ横断)。 */
export function collectTombstonedIds(
  headByCategory: ReadonlyMap<IdNamespacedCategory, readonly JsonValue[]>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entities of headByCategory.values()) {
    for (const raw of entities) {
      const entity = asObject(raw);
      if (entity === null) continue;
      const id = asString(entity["id"]);
      if (id !== null && entity[TOMBSTONE_FIELD] === true) ids.add(id);
    }
  }
  return ids;
}

export interface TombstoneReferenceViolation {
  readonly from: string;
  readonly tombstonedId: string;
}

export function findTombstoneReferenceViolations(
  edges: readonly ReferenceEdge[],
  tombstonedIds: ReadonlySet<string>,
): readonly TombstoneReferenceViolation[] {
  const violations: TombstoneReferenceViolation[] = [];
  for (const edge of edges) {
    if (tombstonedIds.has(edge.targetId)) {
      violations.push({ from: edge.from, tombstonedId: edge.targetId });
    }
  }
  return violations;
}

// ===========================================================================
// I/O: base(git ref) / head(作業ツリー)からの読み取り
// ===========================================================================

/**
 * `git show <ref>:<relPosixPath>` でファイル内容を読み、canonicalizeJson を
 * 通して返す。ref にそのパスが存在しない(= base 側にまだ無いカテゴリ)場合は
 * null を返す(新規カテゴリ追加は「全件が新規ID」として自然に additive 扱いになる)。
 */
export function readJsonAtRef(
  repoRoot: string,
  ref: string,
  relPosixPath: string,
): JsonValue | null {
  const result = spawnSync("git", ["show", `${ref}:${relPosixPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    if (/does not exist|exists on disk, but not in/.test(stderr)) {
      return null;
    }
    throw new Error(
      `git show ${ref}:${relPosixPath} に失敗しました(status=${String(result.status)}): ${stderr}`,
    );
  }
  return canonicalizeJson(JSON.parse(result.stdout) as JsonValue);
}

/**
 * 作業ツリーからファイルを読む(head = PR checkout 後の実ファイル)。
 * ファイルが存在しない場合は null(丸ごと削除された場合、base 側の全 ID が
 * 「消えた」として自然に検出される — toEntityMap([]) が空マップを返すため)。
 */
export function readJsonFromWorkingTree(repoRoot: string, relPath: string): JsonValue | null {
  let text: string;
  try {
    text = readFileSync(path.join(repoRoot, relPath), "utf8");
  } catch (err) {
    // このリポジトリは @types/node を持たない(ADR-001・tools/nodeShims.d.ts)ため
    // NodeJS.ErrnoException 型は使わず、code プロパティの存在だけを見る。
    const code = err !== null && typeof err === "object" && "code" in err ? err.code : undefined;
    if (code === "ENOENT") return null;
    throw err;
  }
  return canonicalizeJson(JSON.parse(text) as JsonValue);
}

// ===========================================================================
// 統括
// ===========================================================================

export interface ContentSemanticsGateResult {
  readonly baseRef: string;
  readonly categories: readonly CategoryDiff[];
  readonly tombstoneReferenceViolations: readonly TombstoneReferenceViolation[];
}

export function runContentSemanticsGate(
  repoRoot: string,
  contentDir: string,
  baseRef: string,
): ContentSemanticsGateResult {
  const headByCategory = new Map<IdNamespacedCategory, readonly JsonValue[]>();
  const categories: CategoryDiff[] = [];

  for (const category of ID_NAMESPACED_CATEGORIES) {
    const relPath = `${contentDir}/${category}.json`;
    const baseValue = readJsonAtRef(repoRoot, baseRef, relPath) ?? [];
    const headValue = readJsonFromWorkingTree(repoRoot, relPath) ?? [];
    const baseArr = asArray(baseValue);
    const headArr = asArray(headValue);
    if (baseArr === null)
      throw new Error(`content/${category}.json(base): トップレベルが配列でない`);
    if (headArr === null)
      throw new Error(`content/${category}.json(head): トップレベルが配列でない`);
    headByCategory.set(category, headArr);
    categories.push(diffCategory(category, baseArr, headArr));
  }

  const headBalance = readJsonFromWorkingTree(repoRoot, `${contentDir}/balance.json`);
  const edges = collectReferenceEdges(headByCategory, headBalance);
  const tombstonedIds = collectTombstonedIds(headByCategory);
  const tombstoneReferenceViolations = findTombstoneReferenceViolations(edges, tombstonedIds);

  return { baseRef, categories, tombstoneReferenceViolations };
}

export function hasViolations(result: ContentSemanticsGateResult): boolean {
  if (result.tombstoneReferenceViolations.length > 0) return true;
  for (const c of result.categories) {
    if (
      c.deletedIds.length > 0 ||
      c.semanticChangeViolations.length > 0 ||
      c.resurrectedIds.length > 0
    ) {
      return true;
    }
  }
  return false;
}

function formatViolationLines(result: ContentSemanticsGateResult): readonly string[] {
  const lines: string[] = [];
  for (const c of result.categories) {
    for (const id of c.deletedIds) {
      lines.push(
        `[削除/リネーム] content/${c.category}.json の既存 ID "${id}" が消えている(GDD 12.5-2)。` +
          `退役させる場合は削除ではなく "${TOMBSTONE_FIELD}": true を立てて ID をファイルに残すこと(soft delete)。` +
          `リネームのつもりで新IDを追加していても、旧IDの消失自体がこのルールに引っかかる(§2: 削除+新規追加として検出)。`,
      );
    }
    for (const v of c.semanticChangeViolations) {
      lines.push(
        `[意味変更] content/${c.category}.json の既存 ID "${v.id}" が数値以外のフィールドで変化している` +
          `(paths: ${v.changedPaths.join(", ")})。数値パラメータのバランス調整(GDD 12.5-8)は許容されるが、` +
          `型変更・構造変更(キー追加/削除・配列長変更・文字列/真偽値の変更)は reject(GDD 12.4/12.5-2)。`,
      );
    }
    for (const id of c.resurrectedIds) {
      lines.push(
        `[復活禁止] content/${c.category}.json の既存 ID "${id}" の tombstone が解除されている。` +
          `tombstone は一方向の soft-delete(GDD 12.5-2/3)。`,
      );
    }
  }
  for (const v of result.tombstoneReferenceViolations) {
    lines.push(
      `[tombstone逆参照] "${v.from}" が tombstone 化された ID "${v.tombstonedId}" を参照し続けている(GDD 12.5-3)。` +
        `参照側(prereqs/fieldRequirement/unlocks/balance.eras[].gateTechId/` +
        `balance.recordMedia.printingTechId/balance.recallRiskParams.memoryKeeperTraitId)を同時に修正すること。`,
    );
  }
  return lines;
}

function main(): void {
  const baseRef = process.env.CONTENT_SEMANTICS_GATE_BASE;
  if (baseRef === undefined || baseRef.length === 0) {
    console.error(
      "[content-semantics-gate] NG: 環境変数 CONTENT_SEMANTICS_GATE_BASE が未設定(比較先の base ref が不明)。",
    );
    console.error(
      "pull_request イベントでは base SHA を必ず渡すこと(.github/workflows/content-guardrail.yml の実装漏れの可能性)。",
    );
    process.exitCode = 1;
    return;
  }

  let result: ContentSemanticsGateResult;
  try {
    result = runContentSemanticsGate(REPO_ROOT, CONTENT_DIR, baseRef);
  } catch (err) {
    console.error(
      `[content-semantics-gate] NG: 検査自体が失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const violationLines = formatViolationLines(result);
  if (violationLines.length === 0) {
    const addedTotal = result.categories.reduce((n, c) => n + c.addedIds.length, 0);
    const tombstonedTotal = result.categories.reduce((n, c) => n + c.newlyTombstonedIds.length, 0);
    console.log(
      `[content-semantics-gate] OK: base=${baseRef} との比較で additive 意味論違反なし` +
        `(新規ID ${String(addedTotal)} 件 / 新規tombstone ${String(tombstonedTotal)} 件)。`,
    );
    process.exitCode = 0;
    return;
  }

  console.error(
    `[content-semantics-gate] NG: ${String(violationLines.length)} 件の additive 意味論違反を検出(base=${baseRef})。`,
  );
  for (const line of violationLines) {
    console.error(`  - ${line}`);
  }
  process.exitCode = 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
