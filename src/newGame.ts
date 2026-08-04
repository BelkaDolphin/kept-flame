// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 新規ゲーム生成 — M53(M29 暫定実装の置き換え)
//
// ===========================================================================
// 0. 何を置き換えたか
// ===========================================================================
//   M29 暫定版(このファイルの旧版・コミット履歴参照)は以下を「未割当」として
//   明示していた:
//     (a) worldSeed は固定文字列で、難度シードの選択機構が無い
//     (b) 住民は `life` を持たない(寿命で死なない・探索派遣の候補にならない)
//     (c) 初期資源・人数に根拠が無い
//     (d) 大移動後の新周回開始状態(初期施設配置)を作るタスクが無い
//   本版はロードマップ M53(台帳v5 必-1 / [2026-08-01裁定] 台帳v7 必-2)として
//   これを正式化する。(d) は `rules/exodus.ts` の `executeExodus` が
//   `rules/worldGen.ts` の {@link placeStartingFacilities} を直接呼ぶ形で対応
//   済み(このファイルも同じ関数を呼ぶ = 「初回起動と同じ生成器を通す」)。
//
// ===========================================================================
// 1. 生成順(worldSeed 展開・ドメイン分離)
// ===========================================================================
//   1. 難度シード(GDD 2.2)を content へ適用する(`rules/difficulty.ts` の
//      `applyDifficultySeed`)。**RNG を 1 切引かない純粋な値変換**。
//   2. worldSeed(文字列)を uint32 へ落とす(`worldSeedToUint32`)。
//   3. 初期住民を**宣言順**に生成する。1 人につき:
//        life    : `rules/lifespan.ts` の `createResidentLife`
//                  (domainTag `lifespan`/`joinAge`。GDD 7.7「人物・寿命は
//                  seed 決定論生成」を新規ゲームでも同じ関数で満たす)
//        trait   : 本ファイルの `rollInitialTraits`(domainTag `newGame`。
//                  新規登録・§3 参照)
//      salt は常に `residentId` 由来(生成順に依存しない・hash アドレス方式)。
//   4. 住民 + 初期研究(火起こし)だけの「施設ゼロ」state を組み立てる。
//   5. `placeStartingFacilities`(engine・`rules/worldGen.ts`)で開始施設
//      (かまど・作業台・[M68] 寝床)と詰み防止の開墾資源・石板1枚ぶんの粘土の
//      最低保証(§4)を一括で適用する。
//
//   同じ (worldSeed, 難度シード, algoVersion, contentVersion) からは常に同じ
//   byte 列の state になる(Date.now/Math.random を 1 度も読まない・
//   tests/engine/newGame.test.ts の往復テストで固定)。
//
// ===========================================================================
// 2. 初期住民数(★要ユーザー判断・GDD に明記なし)
// ===========================================================================
//   6 名を維持する(M29 版から変更なし)。根拠は GDD 7.6 の人口下限
//   `min(寝床上限 × 0.5, 6)` の絶対保証側(6)に合わせた値であり、「下限ちょうど
//   から始める」という設計選択。人数そのものの最適値は M39〜M41 のバランス調整
//   対象(ロードマップ M53 行・数値は暫定)。
//
// ===========================================================================
// 3. domainTag `newGame`(★要ユーザー判断)
// ===========================================================================
//   trait の抽選規則は GDD に定義が無い。本実装は「0〜2 個(上限 3 の下、全員
//   フル装備にはしない)を等確率で個数決定 → 重複無く等確率で選ぶ」という
//   最小の決定論規則を採る。`content.traitDefs` が無い/空の content では
//   trait を 1 つも付けない(= M11 以前や trait 無し content と 1 bit も違わない
//   既定の「省略時は不活性」規約)。
//
// ===========================================================================
// 4. 初期資源(★要ユーザー判断・根拠は各コメント参照)
// ===========================================================================
//   薪(firewood 相当)は `placeStartingFacilities` が開墾コスト
//   (`content.reclaim.costResourceId` の解放数 0 の 1 回ぶん)を下限保証する
//   (GDD 9.1)。**粘土 1 枚ぶん**(`content.recordMedia` の石板コスト =
//   `baseCostFix × byMedium.stoneTablet.costMulFix`)も同じ `placeStartingFacilities`
//   が積む([M68] 旧版はこのファイルにだけ粘土の下限保証があり、`executeExodus`
//   側(新周回)には無かったため石板成文化が新周回で構造的に不可能だった=R4-A11。
//   `rules/worldGen.ts` の共通生成器へ引き上げて新規ゲーム・新周回のどちらでも
//   満たすようにした)。ねらいは GDD 2.3「開始5分の体験」の②(小クラフト完成)
//   ③(成文化前の喪失)を初手から遊べるようにする最小限。`content.recordMedia`
//   が無い content では粘土を積まない(同じ「省略時は不活性」規約)。
// ---------------------------------------------------------------------------

import { compareUtf16 } from "./engine/canonicalize";
import { fixFromInt } from "./engine/fp";
import { DOMAIN_TAGS } from "./engine/rng/domainTags";
import { createResidentLife } from "./engine/rules/lifespan";
import { initialTerrain } from "./engine/rules/reclaim";
import { RulesError, requireFacilityDef, type EngineContent } from "./engine/rules/types";
import { placeStartingFacilities } from "./engine/rules/worldGen";
import {
  entityIdFromString,
  MAX_TRAITS_PER_RESIDENT,
  type EntityId,
  type EntityState,
  type GameState,
  type GameStateMeta,
  type ResidentState,
} from "./engine/state/state";
import { createGameState } from "./engine/state/update";
import {
  hashedDrawUint32,
  saltFromId,
  uniformIntFromDraw,
  worldSeedToUint32,
} from "./engine/stochastic";
import {
  DEFAULT_DIFFICULTY_SEED_ID,
  applyDifficultySeed,
  type DifficultySeedId,
} from "./difficulty";
import { SAVE_SCHEMA_VERSION } from "./platform/migration";

const eid = entityIdFromString;

/** 【暫定】固定の世界シード(§1 の worldSeed 既定値・UI 側の入力欄は未実装)。 */
export const NEW_GAME_WORLD_SEED = "kept-flame-mvp-2026";

/** 【★要ユーザー判断・§2】開始時の住民 6 名(GDD 7.6 の人口下限に合わせた数)。 */
const STARTING_RESIDENT_NAMES = ["rui", "kaya", "seri", "tou", "mio", "hazu"] as const;

/** 【★要ユーザー判断・§3】1 住民が初期状態で持つ trait 数の上限(0〜2)。 */
const INITIAL_TRAIT_COUNT_MAX = 2;

export interface NewGameOptions {
  /**
   * 決定論バンドルの版(ADR-016 の 3 軸(c))。**content の `balance.algoVersion`
   * をそのまま渡す**。`EngineContent` はこの値を持たない(engine が読む必要が
   * 無い値なので `schema/engineContent.ts` が写していない)ため、composition
   * root が content JSON から渡す。
   */
  readonly algoVersion: number;
  /** content の版(ADR 3 軸(b))。既定 1。 */
  readonly contentVersion?: number;
  /** 世界シード。既定は {@link NEW_GAME_WORLD_SEED}。 */
  readonly worldSeed?: string;
  /** 難度シード(GDD 2.2)。既定は {@link DEFAULT_DIFFICULTY_SEED_ID}(`"standard"`)。 */
  readonly difficultySeedId?: DifficultySeedId;
}

/**
 * 初期住民 1 人の trait 抽選(§3)。`content.traitDefs` が無い/空なら常に空配列。
 *
 * 個数(0〜{@link INITIAL_TRAIT_COUNT_MAX})を 1 回引き、残りは「候補集合から
 * 1 個引いて外す」を個数ぶん繰り返す(非復元抽出・重複なしが構造的に保証される)。
 * 戻り値は ID 昇順(`ResidentState.traitIds` の不変条件・state.ts)。
 */
function rollInitialTraits(
  worldSeedU32: number,
  residentId: EntityId,
  content: EngineContent,
): readonly EntityId[] {
  const defs = content.traitDefs;
  if (defs === undefined || defs.size === 0) return [];

  const residentSalt = saltFromId(residentId);
  const countDraw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.newGame, [residentSalt, 0]);
  const maxCount = Math.min(INITIAL_TRAIT_COUNT_MAX, MAX_TRAITS_PER_RESIDENT, defs.size);
  const count = uniformIntFromDraw(countDraw, 0, maxCount);
  if (count === 0) return [];

  // 候補は ID 昇順に正準化してから引く(content Map の反復順に依存させない)。
  const pool = [...defs.keys()].sort(compareUtf16);
  const chosen: EntityId[] = [];
  for (let slot = 1; slot <= count; slot++) {
    const draw = hashedDrawUint32(worldSeedU32, DOMAIN_TAGS.newGame, [residentSalt, slot]);
    const index = uniformIntFromDraw(draw, 0, pool.length - 1);
    const picked = pool[index];
    if (picked === undefined) {
      throw new RulesError(
        `rollInitialTraits: 候補プールの添字 ${String(index)} が引けない(実装バグ)`,
      );
    }
    chosen.push(picked);
    pool.splice(index, 1);
  }
  return [...chosen].sort(compareUtf16);
}

/**
 * 新規ゲームの初期 state を組み立てる(§1)。
 *
 * @throws {RulesError} content に hearth / workbench の定義が無い場合
 *   (**[M53] 現状は要求のまま維持**: 開始施設が置けない content は MVP の
 *   起動要件を満たさないため、`placeStartingFacilities` の「省略時は不活性」
 *   より早い段階(起動時)で気付けるよう、ここで明示的に確認する)
 * @throws {RulesError} content に `townParams`(`content.town`)が無い場合
 *   (初期住民の life が生成できない・GDD 7.5)
 */
export function createNewGameState(content: EngineContent, options: NewGameOptions): GameState {
  const hearthDefId = eid("hearth");
  const workbenchDefId = eid("workbench");
  requireFacilityDef(content, hearthDefId);
  requireFacilityDef(content, workbenchDefId);

  const town = content.town;
  if (town === undefined) {
    throw new RulesError(
      "createNewGameState: content に townParams(content.town)が無いので" +
        "初期住民の life が生成できない(GDD 7.5)",
    );
  }

  const seededContent = applyDifficultySeed(
    content,
    options.difficultySeedId ?? DEFAULT_DIFFICULTY_SEED_ID,
  );
  const worldSeed = options.worldSeed ?? NEW_GAME_WORLD_SEED;
  const worldSeedU32 = worldSeedToUint32(worldSeed);

  const residentIds: EntityId[] = STARTING_RESIDENT_NAMES.map((name) => eid(`res${name}`));

  const entities: EntityState[] = [];
  for (const residentId of residentIds) {
    const resident: ResidentState = {
      kind: "resident",
      id: residentId,
      morale: fixFromInt(60),
      mastery: fixFromInt(0),
      assignedFacilityId: null,
      dispatched: false,
      traitIds: rollInitialTraits(worldSeedU32, residentId, seededContent),
      recallImpairedUntilTick: 0,
      life: createResidentLife(worldSeedU32, residentId, 0, town),
    };
    entities.push(resident);
  }

  // 最初の研究は「火起こし」= 拠点の全ての起点(GDD 5.2)。engine の研究は
  // 「未完了 research entity の ID 昇順で先頭 1 本」という縮約なので
  // (rules/research.ts §2 / architecture.md §9-6)、開始時は 1 本だけ積む。
  entities.push({
    kind: "research",
    id: eid("resFireStarting"),
    techId: eid("techFireStarting"),
    progress: fixFromInt(0),
    completedTick: null,
  });

  const meta: GameStateMeta = {
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    contentVersion: options.contentVersion ?? 1,
    algoVersion: options.algoVersion,
    worldSeed,
    tick: 0,
  };

  const bare = createGameState(
    meta,
    entities,
    [],
    [],
    [],
    [],
    undefined,
    [],
    initialTerrain(seededContent),
  );
  // [M53・M68] 開始施設(かまど・作業台・寝床)・詰み防止の開墾資源・石板1枚
  // ぶんの粘土は、大移動の新周回と共通の生成器が一括で保証する(§4 / rules/
  // worldGen.ts §1・§2(e))。
  return placeStartingFacilities(bare, seededContent);
}
