// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- Map ↔ JSON 往復の単一正準実装 — ADR-028(2) / ADR-012
//
// JSON に Map 型は無いので、セーブ時に `entityStateById`(Map)をプレーン
// オブジェクトへ、ロード時にその逆へ変換する必要がある。この双方向変換は
// `toSerializable` / `fromSerializable` の 2 関数だけが行う。
// eslint.config.js の EXEMPT_STATE_SERIALIZE により、engine で唯一
// `Object.fromEntries` / `Object.keys` が許されるファイルである
// (= 他所で `new Map(Object.entries(x))` 相当を書けないのは意図的)。
//
// なお JSON 文字列化(JSON.stringify)と永続化そのものは engine の仕事ではなく
// platform/persistence.ts の担当。本モジュールが返すのは「JSON 化できる
// プレーンな値」までである(engine は I/O を持たない)。
//
// ===========================================================================
// 1. 往復不変性(このモジュールの契約)
// ===========================================================================
//   toSerializable(fromSerializable(j)) は j と**構造もキー順も同一**であり、
//   したがって JSON.stringify したバイト列も同一になる。根拠は 3 つ:
//
//   (a) entity の並び — `toSerializable` は最後に canonicalize.ts を通すので、
//       出力の全キー(トップレベル・entityStateById・各 entity)は UTF-16
//       コードユニット昇順に固定される。入力 state の Map 反復順にも、
//       entity オブジェクトのフィールド定義順にも依存しない。
//
//   (b) キー順が JSON.stringify に保存されること — JS のオブジェクトは
//       「正準数値文字列」のキーだけを先頭へ繰り上げて列挙する。entity ID は
//       ADR-011 の `^[a-z][a-zA-Z0-9_]*$` により必ず英小文字始まりなので
//       整数風キーになり得ず、繰り上げは構造的に発生しない。よって
//       `entityStateById` の列挙順 = 挿入順 = (a) の昇順が保たれる。
//       この前提は `fromSerializable` が全 ID を ID 規則で検査することで
//       実行時にも担保される(規則違反の ID は往復の入口で reject)。
//
//   (c) 値の正規化 — -0 は +0 に畳まれ、非有限数は reject される(canonicalize.ts
//       §1(4))。JSON 往復で消える表現差を state 側に残さない。
//
//   逆向き(state → JSON → state)についても、`fromSerializable` は
//   createGameState(update.ts)経由で Map を ID 昇順に作り直すため、
//   復元された GameState の Map 反復順は元の state と一致する。
//
// ===========================================================================
// 2. 検証の方針(セーブ復元は engine の外から来る値の入口)
// ===========================================================================
//   `fromSerializable` の入力は JSON.parse の結果 = `unknown` である。破損セーブや
//   手書き改変を「型があるから大丈夫」で通さないよう、全フィールドを実行時に
//   検査し、違反は SerializeError で**停止**する(黙って既定値で埋めない。
//   静かに分岐した状態は決定論の追跡を不可能にするため)。
//
//   一方、**やらない**ことも明示しておく:
//     - 値域の妥当性(Lv <= 5、cellIndex < 48、士気 0〜100 等)は schema 検証器
//       (T6)の担当。ここは「JSON として型が合っているか」までを見る。
//     - saveSchemaVersion 差のマイグレーション連鎖、未知 ID のグレースフル無視
//       (ADR 3軸(a)(b))は migration 層の担当。本モジュールは現行版の形だけを
//       受け付け、未知の entity 種別は reject する。
//     - integrityChecksum(破損検出)は platform 層で JSON blob に対して行う。
//   entity の未知フィールドは読み飛ばす(出力には現れないので往復は保たれる)。
//
// ===========================================================================
// 3. rngState は「空なら書き出さない」(state.ts §4)
// ===========================================================================
//   `rngState` は逐次 RNG ストリームを 1 度でも引いたドメインだけを持つ Map で
//   あり、**空の Map はキーごと省略する**。空 Map ⇔ キー不在 の 1 対 1 対応なので
//   往復不変性は保たれ(空で復元 → 空で書き出し)、次の 2 つが同時に成り立つ:
//     (a) ストリームを使っていないセーブのバイト列は rngState 導入前と同一
//         (= 導入前に採った golden vector / integrityChecksum がそのまま生きる)
//     (b) rngState を持たない旧セーブがマイグレーション無しでロードできる
//         (ADR 3軸(b) additive-only)
//   キーは domainTag、値は xoshiro128** の 4 語(uint32)配列。未登録の domainTag と
//   長さ 4 以外・uint32 範囲外は reject する(レジストリ整合・ADR-024(2))。
//
// ===========================================================================
// 4. entity の省略可フィールドも「無ければキーごと出さない」(M5)
// ===========================================================================
//   §3 と同じ規約を entity レベルへ広げる。M5 が足した
//     resident.stats                                   (ステータス 5 種)
//     resource.cumulativeProduced / cumulativeOverflow (オーバーフロー会計)
//   はいずれも**未設定という状態が意味を持つ**(前者は「中立既定値」、後者は
//   「上限が無いので会計しない」)。よって undefined を書き出すのではなく
//   キーごと省略し、キー不在 ⇔ undefined の 1 対 1 対応で往復不変性を保つ。
//
//   ねらいは §3(a)(b) と同一 — M5 以前に採った golden vector 37 本と
//   既存セーブのバイト列が 1 bit も動かないこと。オブジェクトの生スプレッドは
//   ADR-028(1) で禁止(このファイルも免除対象外)なので、rngState と同じく
//   条件分岐で複数のリテラルを書き分ける。
//
//   resource の 2 つの累計は**常に対で存在するか対で不在**である(会計は上限が
//   有限な資源でのみ走る)。片方だけの直列化形は壊れた入力として reject する。
// ---------------------------------------------------------------------------

import { canonicalizeJson } from "../canonicalize";
import { fixFromRaw, toRaw, type Fix } from "../fp";
import type { ResidentStats } from "../rules/stats";
import { isDomainTag, type DomainTag } from "../rng/domainTags";
import type { Xoshiro128State } from "../rng/xoshiro128";
import {
  entityIdFromString,
  isEntityId,
  type EntityId,
  type EntityState,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type ResearchState,
  type ResidentState,
  type ResourceState,
} from "./state";
import { createGameState } from "./update";

/** 直列化形が壊れている(型違い・未知種別・ID 規則違反など)。 */
export class SerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerializeError";
  }
}

// --- 1. 直列化形の型 -------------------------------------------------------
// interface ではなく type で書いてあるのは、JsonValue へ代入可能(暗黙の
// インデックスシグネチャを持つ)必要があるため。Fix は raw 整数、EntityId は
// 素の文字列として載る。

/** [M5] ステータス 5 種の直列化形(raw 整数)。キー順は canonicalize が揃える。 */
export type SerializedResidentStats = {
  readonly vigor: number;
  readonly dexterity: number;
  readonly intellect: number;
  readonly fortitude: number;
  readonly will: number;
};

export type SerializedResident = {
  readonly kind: "resident";
  readonly id: string;
  readonly morale: number;
  readonly mastery: number;
  readonly assignedFacilityId: string | null;
  readonly dispatched: boolean;
  readonly traitIds: readonly string[];
  readonly recallImpairedUntilTick: number;
  /** [M5] 未設定(中立既定値)なら**キーごと省略**する(§4)。 */
  readonly stats?: SerializedResidentStats;
};

export type SerializedFacility = {
  readonly kind: "facility";
  readonly id: string;
  readonly defId: string;
  readonly level: number;
  readonly cellIndex: number;
  readonly workerIds: readonly string[];
};

export type SerializedResearch = {
  readonly kind: "research";
  readonly id: string;
  readonly techId: string;
  readonly progress: number;
  readonly completedTick: number | null;
};

export type SerializedResource = {
  readonly kind: "resource";
  readonly id: string;
  readonly resourceId: string;
  readonly stock: number;
  /** [M5] オーバーフロー会計。上限が無い資源では**対でキーごと省略**する(§4)。 */
  readonly cumulativeProduced?: number;
  /** [M5] 同上(必ず {@link cumulativeProduced} と対)。 */
  readonly cumulativeOverflow?: number;
};

export type SerializedEntity =
  SerializedFacility | SerializedResearch | SerializedResident | SerializedResource;

/**
 * GameState の直列化形。ADR「セーブフォーマット」(649行)のうち現状扱う範囲
 * (state.ts §3 / §4 参照)。
 *
 * `rngState` は空のとき省略される(§3)。
 */
export type SerializedGameState = {
  readonly saveSchemaVersion: number;
  readonly contentVersion: number;
  readonly algoVersion: number;
  readonly worldSeed: string;
  readonly tick: number;
  readonly entityStateById: { readonly [id: string]: SerializedEntity };
  readonly rngState?: { readonly [domainTag: string]: readonly number[] };
};

// --- 2. state → JSON -------------------------------------------------------

/** [M5] 省略可の `stats` を持つ resident の直列化(§4 の 2 リテラル分岐)。 */
function serializeResident(entity: ResidentState): SerializedResident {
  const stats = entity.stats;
  if (stats === undefined) {
    return {
      kind: "resident",
      id: entity.id,
      morale: toRaw(entity.morale),
      mastery: toRaw(entity.mastery),
      assignedFacilityId: entity.assignedFacilityId,
      dispatched: entity.dispatched,
      traitIds: [...entity.traitIds],
      recallImpairedUntilTick: entity.recallImpairedUntilTick,
    };
  }
  return {
    kind: "resident",
    id: entity.id,
    morale: toRaw(entity.morale),
    mastery: toRaw(entity.mastery),
    assignedFacilityId: entity.assignedFacilityId,
    dispatched: entity.dispatched,
    traitIds: [...entity.traitIds],
    recallImpairedUntilTick: entity.recallImpairedUntilTick,
    stats: {
      vigor: toRaw(stats.vigor),
      dexterity: toRaw(stats.dexterity),
      intellect: toRaw(stats.intellect),
      fortitude: toRaw(stats.fortitude),
      will: toRaw(stats.will),
    },
  };
}

/** [M5] 省略可のオーバーフロー会計を持つ resource の直列化(§4)。 */
function serializeResource(entity: ResourceState): SerializedResource {
  const produced = entity.cumulativeProduced;
  const overflow = entity.cumulativeOverflow;
  if (produced === undefined || overflow === undefined) {
    return {
      kind: "resource",
      id: entity.id,
      resourceId: entity.resourceId,
      stock: toRaw(entity.stock),
    };
  }
  return {
    kind: "resource",
    id: entity.id,
    resourceId: entity.resourceId,
    stock: toRaw(entity.stock),
    cumulativeProduced: toRaw(produced),
    cumulativeOverflow: toRaw(overflow),
  };
}

function serializeEntity(entity: EntityState): SerializedEntity {
  switch (entity.kind) {
    case "resident":
      return serializeResident(entity);
    case "facility":
      return {
        kind: "facility",
        id: entity.id,
        defId: entity.defId,
        level: entity.level,
        cellIndex: entity.cellIndex,
        workerIds: [...entity.workerIds],
      };
    case "research":
      return {
        kind: "research",
        id: entity.id,
        techId: entity.techId,
        progress: toRaw(entity.progress),
        completedTick: entity.completedTick,
      };
    case "resource":
      return serializeResource(entity);
    default: {
      // union を網羅していれば到達しない(型検査で担保)。EntityState を
      // 増やしたのに case を足し忘れた場合だけここへ落ちる。
      const unhandled: never = entity;
      throw new SerializeError(
        `toSerializable: 未知の entity 種別 ${String((unhandled as EntityState).kind)}`,
      );
    }
  }
}

/**
 * GameState を JSON 化できるプレーンな値へ変換する(Map → オブジェクト)。
 * 戻り値のキー順は正準化済みなので、同じ内容の state からは必ず同じバイト列の
 * JSON が得られる(§1)。
 *
 * @throws {SerializeError} EntityState の union に未対応の種別があった場合
 */
export function toSerializable(state: GameState): SerializedGameState {
  const entries: [string, SerializedEntity][] = [];
  for (const entity of state.entityStateById.values()) {
    entries.push([entity.id, serializeEntity(entity)]);
  }
  const entityStateById: { readonly [id: string]: SerializedEntity } = Object.fromEntries(entries);

  const rngEntries: [string, readonly number[]][] = [];
  for (const [domainTag, words] of state.rngState) {
    rngEntries.push([domainTag, [...words]]);
  }

  // 空の rngState はキーごと省略する(§3)。オブジェクトの生スプレッドは
  // ADR-028(1) で禁止(このファイルも免除対象外)なので、条件分岐で 2 つの
  // リテラルを書き分けている。
  const raw: SerializedGameState =
    rngEntries.length === 0
      ? {
          saveSchemaVersion: state.saveSchemaVersion,
          contentVersion: state.contentVersion,
          algoVersion: state.algoVersion,
          worldSeed: state.worldSeed,
          tick: state.tick,
          entityStateById,
        }
      : {
          saveSchemaVersion: state.saveSchemaVersion,
          contentVersion: state.contentVersion,
          algoVersion: state.algoVersion,
          worldSeed: state.worldSeed,
          tick: state.tick,
          entityStateById,
          rngState: Object.fromEntries(rngEntries),
        };

  // 正準化がバイト同一性の根拠(§1(a))。ここを外すと呼び出し側の
  // オブジェクトリテラル定義順が JSON に漏れる。
  return canonicalizeJson(raw);
}

// --- 3. JSON → state ------------------------------------------------------

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SerializeError(`${path}: オブジェクトを期待したが ${describe(value)} だった`);
  }
  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "配列";
  return typeof value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new SerializeError(`${path}: 文字列を期待したが ${describe(value)} だった`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new SerializeError(`${path}: 真偽値を期待したが ${describe(value)} だった`);
  }
  return value;
}

/** 安全整数のみ許可(小数・NaN・Infinity・2^53 超は reject)。 */
function requireInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SerializeError(
      `${path}: 安全整数を期待したが ${typeof value === "number" ? String(value) : describe(value)} だった`,
    );
  }
  // -0 を +0 に畳む(canonicalize.ts §1(4) と同じ規約)。
  return value === 0 ? 0 : value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
  const n = requireInt(value, path);
  if (n < 0) {
    throw new SerializeError(`${path}: 0 以上を期待したが ${String(n)} だった`);
  }
  return n;
}

/** Fix の raw 値(1e6 スケール整数)を読む。生成は fp.ts の唯一の入口を通す。 */
function requireFix(value: unknown, path: string): Fix {
  return fixFromRaw(requireInt(value, path));
}

function requireEntityId(value: unknown, path: string): EntityId {
  const raw = requireString(value, path);
  if (!isEntityId(raw)) {
    throw new SerializeError(`${path}: "${raw}" は ID 規則に一致しない(ADR-011)`);
  }
  return entityIdFromString(raw);
}

function requireEntityIdOrNull(value: unknown, path: string): EntityId | null {
  return value === null ? null : requireEntityId(value, path);
}

function requireEntityIdArray(value: unknown, path: string): readonly EntityId[] {
  if (!Array.isArray(value)) {
    throw new SerializeError(`${path}: 配列を期待したが ${describe(value)} だった`);
  }
  const source = value as readonly unknown[];
  const result: EntityId[] = [];
  for (let i = 0; i < source.length; i++) {
    result.push(requireEntityId(source[i], `${path}[${String(i)}]`));
  }
  return result;
}

function requireIntOrNull(value: unknown, path: string): number | null {
  return value === null ? null : requireInt(value, path);
}

/** [M5] `stats`(省略可・§4)を読む。キーが無ければ undefined を返す。 */
function requireResidentStatsOrUndefined(value: unknown, path: string): ResidentStats | undefined {
  if (value === undefined) return undefined;
  const o = requireObject(value, path);
  return {
    vigor: requireFix(o["vigor"], `${path}.vigor`),
    dexterity: requireFix(o["dexterity"], `${path}.dexterity`),
    intellect: requireFix(o["intellect"], `${path}.intellect`),
    fortitude: requireFix(o["fortitude"], `${path}.fortitude`),
    will: requireFix(o["will"], `${path}.will`),
  };
}

function deserializeResident(id: EntityId, o: Record<string, unknown>, p: string): ResidentState {
  const morale = requireFix(o["morale"], `${p}.morale`);
  const mastery = requireFix(o["mastery"], `${p}.mastery`);
  const assignedFacilityId = requireEntityIdOrNull(
    o["assignedFacilityId"],
    `${p}.assignedFacilityId`,
  );
  const dispatched = requireBoolean(o["dispatched"], `${p}.dispatched`);
  const traitIds = requireEntityIdArray(o["traitIds"], `${p}.traitIds`);
  const recallImpairedUntilTick = requireNonNegativeInt(
    o["recallImpairedUntilTick"],
    `${p}.recallImpairedUntilTick`,
  );
  const stats = requireResidentStatsOrUndefined(o["stats"], `${p}.stats`);
  // exactOptionalPropertyTypes 下では `stats: undefined` を書けず、生スプレッドも
  // 使えない(§4)ので 2 リテラルに書き分ける。
  if (stats === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
    };
  }
  return {
    kind: "resident",
    id,
    morale,
    mastery,
    assignedFacilityId,
    dispatched,
    traitIds,
    recallImpairedUntilTick,
    stats,
  };
}

function deserializeFacility(id: EntityId, o: Record<string, unknown>, p: string): FacilityState {
  return {
    kind: "facility",
    id,
    defId: requireEntityId(o["defId"], `${p}.defId`),
    level: requireNonNegativeInt(o["level"], `${p}.level`),
    cellIndex: requireNonNegativeInt(o["cellIndex"], `${p}.cellIndex`),
    workerIds: requireEntityIdArray(o["workerIds"], `${p}.workerIds`),
  };
}

function deserializeResearch(id: EntityId, o: Record<string, unknown>, p: string): ResearchState {
  return {
    kind: "research",
    id,
    techId: requireEntityId(o["techId"], `${p}.techId`),
    progress: requireFix(o["progress"], `${p}.progress`),
    completedTick: requireIntOrNull(o["completedTick"], `${p}.completedTick`),
  };
}

function deserializeResource(id: EntityId, o: Record<string, unknown>, p: string): ResourceState {
  const resourceId = requireEntityId(o["resourceId"], `${p}.resourceId`);
  const stock = requireFix(o["stock"], `${p}.stock`);
  const rawProduced = o["cumulativeProduced"];
  const rawOverflow = o["cumulativeOverflow"];
  if ((rawProduced === undefined) !== (rawOverflow === undefined)) {
    throw new SerializeError(
      `${p}: cumulativeProduced / cumulativeOverflow は両方あるか両方無いかのいずれか` +
        "(オーバーフロー会計は上限が有限な資源でのみ対で走る・§4)",
    );
  }
  if (rawProduced === undefined || rawOverflow === undefined) {
    return { kind: "resource", id, resourceId, stock };
  }
  return {
    kind: "resource",
    id,
    resourceId,
    stock,
    cumulativeProduced: requireFix(rawProduced, `${p}.cumulativeProduced`),
    cumulativeOverflow: requireFix(rawOverflow, `${p}.cumulativeOverflow`),
  };
}

function deserializeEntity(id: EntityId, value: unknown, path: string): EntityState {
  const o = requireObject(value, path);
  const kind = requireString(o["kind"], `${path}.kind`);

  // キーと entity 自身の id の食い違いは、片方だけを書き換えた改変・実装バグの
  // 兆候なので必ず止める(GameState の不変条件(b))。
  const declaredId = requireEntityId(o["id"], `${path}.id`);
  if (declaredId !== id) {
    throw new SerializeError(`${path}: キー "${id}" と id フィールド "${declaredId}" が食い違う`);
  }

  switch (kind) {
    case "resident":
      return deserializeResident(id, o, path);
    case "facility":
      return deserializeFacility(id, o, path);
    case "research":
      return deserializeResearch(id, o, path);
    case "resource":
      return deserializeResource(id, o, path);
    default:
      throw new SerializeError(`${path}.kind: 未知の entity 種別 "${kind}"`);
  }
}

/** uint32(0〜2^32-1 の整数)のみ許可。xoshiro128** の state 語の値域。 */
function requireUint32(value: unknown, path: string): number {
  const n = requireInt(value, path);
  if (n < 0 || n > 0xffff_ffff) {
    throw new SerializeError(`${path}: uint32(0〜4294967295)を期待したが ${String(n)} だった`);
  }
  return n;
}

/**
 * rngState(§3)を読む。キーは登録済み domainTag、値は uint32 × 4。
 * 未登録タグ・長さ違い・値域外はすべて reject する(黙って捨てない)。
 */
function deserializeRngState(value: unknown): readonly (readonly [DomainTag, Xoshiro128State])[] {
  if (value === undefined) return [];
  const o = requireObject(value, "$.rngState");
  const result: (readonly [DomainTag, Xoshiro128State])[] = [];
  for (const key of Object.keys(o)) {
    const path = `$.rngState.${key}`;
    if (!isDomainTag(key)) {
      throw new SerializeError(
        `${path}: "${key}" は rng/domainTags.ts のレジストリに無い domainTag(ADR-024(2))`,
      );
    }
    const words = o[key];
    if (!Array.isArray(words) || words.length !== 4) {
      throw new SerializeError(`${path}: uint32 4 語の配列を期待した`);
    }
    const source = words as readonly unknown[];
    result.push([
      key,
      [
        requireUint32(source[0], `${path}[0]`),
        requireUint32(source[1], `${path}[1]`),
        requireUint32(source[2], `${path}[2]`),
        requireUint32(source[3], `${path}[3]`),
      ],
    ]);
  }
  return result;
}

/**
 * 直列化形(JSON.parse の結果)から GameState を復元する。オブジェクト → Map。
 * 入力のキー順には依存しない(必要なキーを名指しで読み、Map は ID 昇順で
 * 作り直す)ので、整形ツールがキー順を変えたセーブでも同じ state になる。
 *
 * @param input JSON.parse の戻り値など、検証前の未知の値
 * @throws {SerializeError} 構造・型・ID 規則の違反、未知の entity 種別
 * @throws {StateUpdateError} ID が重複している場合(update.ts の createGameState)
 */
export function fromSerializable(input: unknown): GameState {
  const root = requireObject(input, "$");

  const meta: GameStateMeta = {
    saveSchemaVersion: requireNonNegativeInt(root["saveSchemaVersion"], "$.saveSchemaVersion"),
    contentVersion: requireNonNegativeInt(root["contentVersion"], "$.contentVersion"),
    algoVersion: requireNonNegativeInt(root["algoVersion"], "$.algoVersion"),
    worldSeed: requireString(root["worldSeed"], "$.worldSeed"),
    tick: requireNonNegativeInt(root["tick"], "$.tick"),
  };

  const rawEntities = requireObject(root["entityStateById"], "$.entityStateById");
  const entities: EntityState[] = [];
  for (const key of Object.keys(rawEntities)) {
    const path = `$.entityStateById.${key}`;
    if (!isEntityId(key)) {
      throw new SerializeError(`${path}: キー "${key}" は ID 規則に一致しない(ADR-011)`);
    }
    entities.push(deserializeEntity(entityIdFromString(key), rawEntities[key], path));
  }

  return createGameState(meta, entities, deserializeRngState(root["rngState"]));
}
