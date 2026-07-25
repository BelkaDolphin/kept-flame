// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 構造共有の単一更新経路 — ADR-028(1) / ADR-002(1)
//
// GameState の不変更新は**すべて**このファイルの関数を通す。immer 等の追加依存は
// 入れない(ADR-001 依存最小)。eslint.config.js の EXEMPT_STATE_UPDATE により、
// engine で唯一「オブジェクトの生スプレッド / Object.assign / delete」が許される
// ファイルであり、裏を返すと**他所で `{...obj, field: v}` と書けないのは意図的**
// である(手書きスプレッドは「どのサブツリーを新しくしたか」がレビューでしか
// 追えず、ADR-028 が閉じた穴そのもの)。
//
// ===========================================================================
// 1. 構造共有の定義(このモジュールが守る性質)
// ===========================================================================
//   更新後の state について、**変更パス上のオブジェクトだけが新しい参照**になり、
//   それ以外は元の参照をそのまま共有する:
//
//     updateEntity(state, "residentA", ...) の後
//       next !== state                                    // GameState は新品
//       next.entityStateById !== state.entityStateById    // Map は新品
//       next.entityStateById.get("residentA") !== 旧       // 対象 entity は新品
//       next.entityStateById.get("facilityB") === 旧       // 無関係 entity は同一
//       next.worldSeed === state.worldSeed                // スカラも同値
//
//   さらに「値が変わらなかったら参照も変えない」を全経路で守る:
//   updater が同一参照を返した場合・setField の新旧値が Object.is で等しい場合は、
//   コピーを作らず入力をそのまま返す。これにより「無変更 tick は state 全体が
//   参照同一」= UI 側の再描画判定が参照比較だけで済む(ADR-002)。
//
// ===========================================================================
// 2. Map の複製コストと、catch-up での回避(ADR-029(1))
// ===========================================================================
//   正規化 state の代償として、entity 1 個の更新でも `new Map(prev)`(O(n))が
//   走る。n は施設 48 + 住民 20 + 研究/資源で高々 100 オーダーなので foreground の
//   live play(短い差分)では問題にならない。
//   一方 72h catch-up(最大 4320 tick)でこれを毎 tick 走らせるとアロケーションが
//   膨らむため、ADR-029(1) は catch-up を「Worker-local の可変ドラフトを in-place
//   更新し、完了時に一度だけ不変スナップショット化する」方式に分けている。
//   **この使い分けは意図的**であり、本モジュールを catch-up の内側ループで
//   使うことは想定していない(engine 純粋性と決定論はドラフト側でも維持される)。
//
// ===========================================================================
// 3. 正準順の維持(state.ts §2)
// ===========================================================================
//   `entityStateById` の反復順は常に ID の UTF-16 コードユニット昇順である。
//   維持責務はこのファイル(createGameState / putEntity)と serialize.ts
//   (fromSerializable)にある。
//     - 既存 ID の差し替え: Map.set は挿入位置を変えないので順序は不変。
//     - 新規 ID の追加    : 挿入順のままだと追加順序が反復順に漏れるため、
//                           全 entity を ID 昇順にソートし直して Map を作り直す。
//   新規追加は毎 tick の操作ではない(毎 tick 起きるのは既存 entity の値更新)
//   ので、この O(n log n) は catch-up の内側ループには乗らない。
//
// ===========================================================================
// 4. 配列の更新について
// ===========================================================================
//   配列スプレッド `[...arr]` / `arr.slice()` は engine 全域で許可されている
//   (eslint.config.js: 「配列スプレッド/引数スプレッドは構造共有と無関係なため
//   対象外」)。要素数の増減を伴う配列更新は呼び出し側で普通に書いてよく、
//   結果を setField / updateIn で state へ差し込む形にすること。
//   `updateIn` の path に配列添字を混ぜた場合も内部で slice コピーになる。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "../canonicalize";
import {
  EntityLookupError,
  isEntityId,
  requireEntity,
  type EntityId,
  type EntityKind,
  type EntityOfKind,
  type EntityState,
  type GameState,
  type GameStateMeta,
} from "./state";

/** 更新経路の使い方の誤り(空 path・ID 不整合・重複 ID など)。 */
export class StateUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUpdateError";
  }
}

// --- 1. 汎用の浅いコピー ---------------------------------------------------

/**
 * オブジェクト/配列の 1 キーだけを差し替えた浅いコピーを作る、本モジュール唯一の
 * コピー実装。生スプレッドがここに 1 箇所しか無いことが ADR-028(1) の要点。
 *
 * プレーンオブジェクトを前提とする(prototype は引き継がれない)。GameState 配下は
 * すべてプレーンオブジェクト・配列・Map であり、クラスインスタンスは置かない。
 */
function shallowCopyWith(target: object, key: PropertyKey, value: unknown): object {
  if (Array.isArray(target)) {
    const copy: unknown[] = target.slice();
    copy[key as number] = value;
    return copy;
  }
  const copy = { ...target } as Record<PropertyKey, unknown>;
  copy[key] = value;
  return copy;
}

/**
 * オブジェクトの 1 フィールドを差し替えた新しいオブジェクトを返す
 * (他フィールドは参照を共有)。
 *
 * 新旧が `Object.is` で等しければ**コピーせず target をそのまま返す**(§1)。
 *
 * @example setField(resident, "morale", nextMorale)
 */
export function setField<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): T {
  if (Object.is(target[key], value)) return target;
  return shallowCopyWith(target, key, value) as T;
}

function updateAt(
  target: object,
  path: readonly PropertyKey[],
  updater: (value: unknown) => unknown,
): object {
  const key = path[0];
  if (key === undefined) {
    throw new StateUpdateError("updateIn: path が空で更新先が決まらない");
  }

  const current = (target as Record<PropertyKey, unknown>)[key];
  const rest = path.slice(1);

  let next: unknown;
  if (rest.length === 0) {
    next = updater(current);
  } else {
    if (current === null || typeof current !== "object") {
      throw new StateUpdateError(
        `updateIn: path 途中の "${String(key)}" がオブジェクトでないため掘り下げられない`,
      );
    }
    next = updateAt(current, rest, updater);
  }

  if (Object.is(current, next)) return target;
  return shallowCopyWith(target, key, next);
}

/**
 * 入れ子の path を辿って 1 箇所だけ更新した新しいオブジェクトを返す。
 * path 上のオブジェクトだけが新しくなり、それ以外は参照を共有する(§1)。
 *
 * 深さ 1〜3 の型付きオーバーロードを用意してある(正規化 state は平坦なので
 * 実用上これで足りる)。updater が同じ参照/値を返したときはコピーを作らない。
 *
 * @example updateIn(state, ["tick"], (t) => t + 1)
 * @throws {StateUpdateError} path が空、または path 途中がオブジェクトでない場合
 */
export function updateIn<T extends object, K1 extends keyof T>(
  target: T,
  path: readonly [K1],
  updater: (value: T[K1]) => T[K1],
): T;
export function updateIn<T extends object, K1 extends keyof T, K2 extends keyof T[K1]>(
  target: T,
  path: readonly [K1, K2],
  updater: (value: T[K1][K2]) => T[K1][K2],
): T;
export function updateIn<
  T extends object,
  K1 extends keyof T,
  K2 extends keyof T[K1],
  K3 extends keyof T[K1][K2],
>(target: T, path: readonly [K1, K2, K3], updater: (value: T[K1][K2][K3]) => T[K1][K2][K3]): T;
export function updateIn(
  target: object,
  path: readonly PropertyKey[],
  updater: (value: never) => unknown,
): object {
  return updateAt(target, path, updater as (value: unknown) => unknown);
}

// --- 2. entity Map の構築 --------------------------------------------------

/**
 * ID 昇順に並べた entity 列から Map を作る(§3)。重複 ID はここで止める
 * (グローバル ID 一意性の最終防波堤。schema 検証器・ADR-024(1) が本来の担当)。
 */
function buildEntityMap(
  sortedEntities: readonly EntityState[],
): ReadonlyMap<EntityId, EntityState> {
  const map = new Map<EntityId, EntityState>();
  for (const entity of sortedEntities) {
    if (map.has(entity.id)) {
      throw new StateUpdateError(`entity ID "${entity.id}" が重複している(グローバル一意違反)`);
    }
    map.set(entity.id, entity);
  }
  return map;
}

/** ID 規則(ADR-011)の検査。新しい ID が state へ入る箇所だけで呼ぶ。 */
function requireValidId(entity: EntityState): void {
  if (!isEntityId(entity.id)) {
    throw new StateUpdateError(
      `entity ID "${entity.id}" が ID 規則に一致しない(ADR-011。EntityId を as で偽造していないか)`,
    );
  }
}

function sortedById(entities: readonly EntityState[]): EntityState[] {
  return [...entities].sort((a, b) => compareUtf16(a.id, b.id));
}

/**
 * GameState を作る唯一の入口。entity 列は渡された順に依らず ID 昇順の正準順で
 * Map 化される(§3)。新規セーブの生成と fromSerializable(serialize.ts)が使う。
 *
 * @throws {StateUpdateError} ID 規則違反または ID 重複がある場合
 */
export function createGameState(meta: GameStateMeta, entities: readonly EntityState[]): GameState {
  for (const entity of entities) {
    requireValidId(entity);
  }
  return {
    saveSchemaVersion: meta.saveSchemaVersion,
    contentVersion: meta.contentVersion,
    algoVersion: meta.algoVersion,
    worldSeed: meta.worldSeed,
    tick: meta.tick,
    entityStateById: buildEntityMap(sortedById(entities)),
  };
}

/**
 * entity を追加または差し替える。既存 ID の差し替えは挿入位置を変えず、新規 ID は
 * 正準順を保つため Map を作り直す(§3)。
 *
 * 渡した entity が既存と同一参照なら state をそのまま返す(§1)。
 *
 * @throws {StateUpdateError} 新規 ID が ID 規則に一致しない場合
 */
export function putEntity(state: GameState, entity: EntityState): GameState {
  const previous = state.entityStateById.get(entity.id);

  if (previous !== undefined) {
    if (Object.is(previous, entity)) return state;
    const next = new Map(state.entityStateById);
    next.set(entity.id, entity);
    return setField(state, "entityStateById", next);
  }

  requireValidId(entity);
  const merged = sortedById([...state.entityStateById.values(), entity]);
  return setField(state, "entityStateById", buildEntityMap(merged));
}

/**
 * entity を取り除く。不在での呼び出しは黙って無視せず例外にする(消したつもりの
 * ID 違いを検知するため)。残りの entity の相対順序は保たれる。
 *
 * @throws {EntityLookupError} 対象 ID が存在しない場合
 */
export function removeEntity(state: GameState, id: EntityId): GameState {
  if (!state.entityStateById.has(id)) {
    throw new EntityLookupError(`removeEntity: entity "${id}" が存在しない`);
  }
  const next = new Map(state.entityStateById);
  next.delete(id);
  return setField(state, "entityStateById", next);
}

/**
 * entity 1 個を種別付きで更新する、rules から見た主経路(ADR-028(1))。
 * updater は現在の entity を受け取り、新しい entity を返す純関数であること
 * (中身の書き換えではなく setField / updateIn で新しい値を作る)。
 *
 * updater が同じ参照を返したら state もそのまま返す(§1)。
 *
 * @example
 *   updateEntity(state, id, "resident", (r) => setField(r, "morale", nextMorale))
 *
 * @throws {EntityLookupError} 対象が存在しない、または種別が食い違う場合
 * @throws {StateUpdateError} updater が id / kind の違う entity を返した場合
 */
export function updateEntity<K extends EntityKind>(
  state: GameState,
  id: EntityId,
  kind: K,
  updater: (entity: EntityOfKind<K>) => EntityOfKind<K>,
): GameState {
  const previous = requireEntity(state, id, kind);
  const next = updater(previous);
  if (Object.is(previous, next)) return state;

  if (next.id !== id) {
    throw new StateUpdateError(
      `updateEntity: updater が別 ID の entity を返した(期待 "${id}" / 実際 "${next.id}")`,
    );
  }
  if (next.kind !== kind) {
    throw new StateUpdateError(
      `updateEntity: updater が別種別の entity を返した(期待 ${kind} / 実際 ${next.kind})`,
    );
  }
  return putEntity(state, next);
}
