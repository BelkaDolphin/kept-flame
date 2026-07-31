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
//
// ===========================================================================
// 5. [M11] 住民の `life` は 3 値を 1 オブジェクトにまとめる
// ===========================================================================
//   §4 の「無ければキーごと出さない」を守りつつ、`bornTick` / `lifespanTick` /
//   `diedTick` を独立した省略可フィールドにすると、生スプレッド禁止(ADR-028(1))の
//   もとで書き分けるリテラルが 2^3 = 8 通りに膨れる。3 値は「生涯」という 1 つの
//   意味の分解であって独立に欠けることが無いので、state 側(state.ts の
//   {@link ResidentLife})から 1 オブジェクトにまとめてあり、直列化の分岐も
//   `stats` × `life` の 4 通りで済む。
//
//   `diedTick` はオブジェクト内では**省略しない**(生存中は明示的に null)。
//   「キーが無い = 生きている」という表現にすると、`life` 自体の不在(= 寿命を
//   持たない住民)と区別が付きにくくなるため。
//
// ===========================================================================
// 6. [M12] `resident.memoir` は §4/§5 と同じ規約、`bondByPairKey` は §3 と同型
// ===========================================================================
//   `memoir` は §4 の「無ければキーごと出さない」規約に従う省略可フィールドで
//   あり、`stats` / `life` と組み合わせると分岐が 2^3 = 8 通りに膨れる
//   (state.ts の `ResidentState.memoir` の doc 参照。独立 entity にしなかった
//   理由 = `src/ui/derived.ts` 等の既存の網羅 switch を壊さないため)。
//
//   `bondByPairKey` は GameState 直下の Map であり、**§3 の rngState と全く同じ
//   規約**(空なら書き出さない・キーは正準順)に従う。キー文字列
//   `"residentAId|residentBId"`(前者が辞書順で必ず前)の妥当性は
//   `fromSerializable` の入口で検査する(未知の domainTag を reject するのと
//   同じ層)。
//
// ===========================================================================
// 7. [M16] `facility.footprint` は §4 と同じ規約 + 「1×1 の明示は非正準形」
// ===========================================================================
//   `footprint`(GDD 6.1 の 2×1 / 2×2)は §4 の「無ければキーごと出さない」規約に
//   従う省略可フィールドであり、**省略 ⇔ 1×1** の 1 対 1 対応とする(footprint.ts §2)。
//
//   §4 との違いは、`{"width":1,"height":1}` という**書けてしまう非正準形**が
//   存在する点である。これを黙って受け入れると
//   `toSerializable(fromSerializable(j)) === j` (§1 の契約)が破れる —— 読み込み
//   時に 1×1 は undefined へ畳まれ、書き出しでキーが消えるためバイト列が変わる。
//   よって **1×1 を明示した直列化形は reject** する(resource の
//   `cumulativeProduced` / `cumulativeOverflow` の片側だけの形を reject するのと
//   同じ理屈: 正準形を 1 通りに保つことで往復不変性を定理として維持する)。
//
//   幅・高さの値域(1〜`FOOTPRINT_DIM_MAX`)もここで検査する。これは §2 が
//   「値域は schema 検証器の担当」と書いているのと矛盾しない —— cellIndex や Lv と
//   違い、footprint の値域は**セーブの表現能力そのもの**(3×3 を許すと占有形状の
//   モデルが変わる)であり、`lifespanTick >= 1`(§5)と同じ層の不変条件である。
//
// ===========================================================================
// 8. [M13] `techMemoryByKey` は §3 と同型、`research.loss` は §4 と同じ規約
// ===========================================================================
//   `techMemoryByKey`(住民 × 技術の記憶・GDD 11.2 / 7.4)は GameState 直下の
//   Map であり、**§3 の rngState / §6 の bondByPairKey と全く同じ規約**
//   (空なら書き出さない・キーは正準順)に従う。キー文字列 `"residentId|techId"`
//   の妥当性は `fromSerializable` の入口で検査する(bondByPairKey と同じ層)。
//
//   `research.loss`(技術喪失)は §4 の「無ければキーごと出さない」規約に従う
//   省略可フィールドである。
//
//   **省略可フィールドの組み立て方の変更**: 省略可トップレベルキーが 3 つに
//   なったため、`toSerializable` の「2^n 通りのリテラルを書き分ける」形を
//   「必須キーのリテラル + 省略可キーの entries 連結」へ改めた(生スプレッドは
//   ADR-028(1) でこのファイルも禁止だが、`Object.entries`/`Object.fromEntries` は
//   ADR-028(2) の単一正準実装としてこのファイルだけが免除されている)。
//
// ===========================================================================
// 9. [M21] `dispatchSnapshots` / `renderedLogs` は §3 と同型(空なら省略)
// ===========================================================================
//   探索(GDD 8.2 / 12.5-7)と帰還ログ(GDD 8.4)は GameState 直下に載るが、
//   **空なら書き出さない**規約は rngState / bondByPairKey / techMemoryByKey と
//   同一である。既存セーブ・golden vector 56 本のバイト列が 1 bit も動かない
//   ことの根拠がここにある(探索は既存シナリオに 1 件も存在しない)。
//
//   `dispatchSnapshots` だけは Map ではなく**配列**である。ADR のセーブ
//   フォーマットが配列で定義され、`platform/persistence.ts` の
//   `assertDispatchTreeBounds` がその形で ADR-012(3) の上界を検算するためで、
//   正準順(派遣 ID 昇順)の維持責務は state/update.ts にある。ノード列を
//   `resolvedTree.choices` に載せているのも同じ理由(検算側の `countTreeNodes`
//   が `choices`/`children` を子ノードのキーとして歩く)。
//
//   帰還ログは memoirLog と違い**レンダリング済み文字列**を持つ。非対称なのは
//   GDD 12.5-7 が帰還ログについてだけ「完成文字列保存(再参照禁止)」を
//   求めているためである(理由は state.ts の RenderedLogEntry の doc)。
//
// ===========================================================================
// 10. [M52] `terrain`(瓦礫)は §3 と同型 —— ただし「空 = 全セル開墾済み」
// ===========================================================================
//   地形(GDD 9.1)は GameState 直下の値オブジェクトであり、**瓦礫ゼロ かつ
//   解放数 0 なら書き出さない**規約は rngState / renderedLogs / outpostsById と
//   同一である。これが「既存セーブ・golden vector 64 本のバイト列が 1 bit も
//   動かない」ことと「瓦礫フィールドを持たない旧セーブが**全セル開墾済み**として
//   無損失でロードされる」ことを**同時に**満たす仕掛けである(M52 検収条件)。
//
//   §7(footprint)と同じく**書けてしまう非正準形**が 1 つある:
//   `{"rubbleCells":[],"reclaimedCount":0}` を明示した形は読み込みで
//   {@link EMPTY_TERRAIN} へ畳まれ、書き出しでキーが消えるため往復のバイト列が
//   変わる。よって**空の terrain を明示した直列化形は reject** する
//   (1×1 footprint の明示を reject するのと全く同じ理屈)。
//   一方 `{"rubbleCells":[],"reclaimedCount":7}`(全部開墾し終えた盤面)は
//   正準形である —— 解放数は次の開墾コストを決める生きた情報であり、空ではない。
//
//   セル番号の昇順・重複なし・値域(0〜47)と解放数の非負は
//   `createGameState`(update.ts の `requireValidTerrain`)が復元時に強制する。
//   これは §2 の「値域は schema 検証器の担当」と矛盾しない —— footprint の値域と
//   同じく**セーブの表現能力そのもの**(順序が崩れた配列は正準形が一意でなくなり
//   §1 の往復不変性が定理として成り立たなくなる)だからである。
//
// ===========================================================================
// 11. [M28] `progression`(周回 / 継承点)は §10 と全く同じ形
// ===========================================================================
//   周回進行(GDD 10.2〜10.5)は GameState 直下の値オブジェクトであり、
//   **1 周目 かつ 累計継承点 0 かつ 購入段ゼロ なら書き出さない**。既存セーブ・
//   golden vector 73 本のバイト列が 1 bit も動かないことの根拠がここにある
//   (既存シナリオは 1 件も大移動を実行しない)。
//
//   §10 と同じく**書けてしまう非正準形**が 1 つある:
//   `{"runCount":0,"cumulativeInheritPoints":0,"inheritTiers":[]}` を明示した
//   形は読み込みで {@link EMPTY_PROGRESSION} へ畳まれ、書き出しでキーが消える。
//   よって**既定値を明示した直列化形は reject** する(空 terrain の明示・
//   1×1 footprint の明示を reject するのと全く同じ理屈)。
//
//   `inheritTiers` は **`[]` を常に書く**(オブジェクト内で更に省略しない)。
//   省略可の入れ子を作ると「progression は書くが inheritTiers は書かない」形と
//   「両方書く」形の 2 通りが同じ state を表せてしまい、正準形が一意でなくなる。
//   ADR「セーブフォーマット」が `runCount` / `cumulativeInheritPoints` を
//   payload のトップレベルキーとして列挙しているのに対して 1 オブジェクトへ
//   まとめてあるのは state.ts の [M28] 節に理由がある(要点: 3 つめの値
//   `inheritTiers` が必要であること + 必須トップレベルキーは既存 73 本の
//   バイト列を全て動かすこと)。
//
// ===========================================================================
// 12. [M50] `selectedResearchId`(研究対象の選択)は §10/§11 と同じ形
// ===========================================================================
//   研究対象の選択(GDD 5・`commands.ts` の `beginResearch`)は GameState 直下の
//   スカラであり、**未選択(null)なら書き出さない**。既存セーブ・golden vector
//   73 本のバイト列が 1 bit も動かないことの根拠がここにある(既存シナリオは
//   1 件も選択を持たない = `currentResearch` の従来経路のまま)。
//
//   §10/§11 と同じく**書けてしまう非正準形**がある: `"selectedResearchId": null`
//   を明示した形は読み込みで未選択へ畳まれ、書き出しでキーが消える。よって
//   **null を明示した直列化形は reject** する(空 terrain の明示と同じ理屈)。
//
//   **`saveSchemaVersion` は上げていない**(v6 のまま)。ADR-012(a) の線引きは
//   「旧ビルドが新セーブを読むと **黙って潰れる**類の変更は版差で塞ぐ」であり、
//   既存 5 段(footprint / 派遣 / event 効果 / 地形 / 周回)はいずれも
//   **回復不能な損失か exploit** を伴っていた。選択の欠落はそのどちらでもない:
//   各 research entity の `progress` は選択と独立に保存され続け、失われるのは
//   「どれへ点を入れるか」の 1 スカラだけで、再選択 1 回で完全に元へ戻る。
//   詳細な両論と bump したい場合の手順は M50 の★報告に記録してある。
// ---------------------------------------------------------------------------

import { canonicalizeJson, compareUtf16 } from "../canonicalize";
import { FOOTPRINT_DIM_MAX, isUnitFootprint, isValidFootprintDims } from "../footprint";
import { fixFromRaw, toRaw, type Fix } from "../fp";
import type { ResidentStats } from "../rules/stats";
import {
  RECORD_MEDIA,
  isDistanceBand,
  isRecordMedium,
  type DistanceBand,
  type RecordMedium,
} from "../rules/types";
import { isDomainTag, type DomainTag } from "../rng/domainTags";
import type { Xoshiro128State } from "../rng/xoshiro128";
import {
  EMPTY_PROGRESSION,
  EMPTY_RENDERED_LOGS,
  EMPTY_TERRAIN,
  entityIdFromString,
  isDispatchStance,
  isEntityId,
  isInheritTrack,
  isMemoirEntryKind,
  type CodifyState,
  type DispatchEffect,
  type DispatchNode,
  type DispatchSnapshot,
  type DispatchStance,
  type RenderedLogEntry,
  type RenderedLogState,
  type EntityId,
  type EntityState,
  type FacilityFootprint,
  type FacilityState,
  type GameState,
  type GameStateMeta,
  type InheritTierEntry,
  type MemoirEntry,
  type MemoirEntryKind,
  type MemoirLogState,
  type OutpostState,
  type ProgressionState,
  type ResearchState,
  type ResidentLife,
  type ResidentState,
  type ResourceState,
  type TechLossState,
  type TechMemoryState,
  type TerrainState,
} from "./state";
import { createGameState, setField } from "./update";

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

/** [M11] 住民の生涯(GDD 7.5)。値は素の tick 整数(Fix ではない)。 */
export type SerializedResidentLife = {
  readonly bornTick: number;
  readonly lifespanTick: number;
  readonly diedTick: number | null;
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
  /** [M11] 寿命を持たない住民は**キーごと省略**する(§5)。 */
  readonly life?: SerializedResidentLife;
  /** [M12] memoirLog を持たない住民は**キーごと省略**する(§6)。 */
  readonly memoir?: SerializedMemoirLog;
};

/** [M16] 占有形状(GDD 6.1)。1×1 は**キーごと省略**するので値も 1×1 にならない(§7)。 */
export type SerializedFacilityFootprint = {
  readonly width: number;
  readonly height: number;
};

export type SerializedFacility = {
  readonly kind: "facility";
  readonly id: string;
  readonly defId: string;
  readonly level: number;
  readonly cellIndex: number;
  readonly workerIds: readonly string[];
  /** [M16] 1×1(既定)なら**キーごと省略**する(§7)。 */
  readonly footprint?: SerializedFacilityFootprint;
};

/** [M13] 技術喪失(state.ts の {@link TechLossState})。EntityId は素の文字列。 */
export type SerializedTechLoss = {
  readonly tick: number;
  readonly irreversible: boolean;
  /** [M22] 記録の焼失による喪失には最後の保持者が居ないので**省略可**。 */
  readonly lastHolderId?: string;
};

export type SerializedResearch = {
  readonly kind: "research";
  readonly id: string;
  readonly techId: string;
  readonly progress: number;
  readonly completedTick: number | null;
  /** [M13] 一度も喪失していない tech は**キーごと省略**する(§8)。 */
  readonly loss?: SerializedTechLoss;
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

/**
 * [M6] 成文化ジョブ / 記録(state.ts の {@link CodifyState})。
 * 省略可フィールドは無い(未着手の記録という状態が無いため)。
 */
export type SerializedCodify = {
  readonly kind: "codify";
  readonly id: string;
  readonly techId: string;
  readonly medium: string;
  readonly requiredWork: number;
  readonly progress: number;
  readonly completedTick: number | null;
};

/**
 * [M12] memoirLog 1 件の直列化形(kind で判別)。値は素の tick/index/文字列。
 * `state.ts` の {@link MemoirEntry} と 1 対 1(EntityId は素の文字列として載る)。
 */
export type SerializedMemoirEntry =
  | { readonly kind: "arrival"; readonly tick: number }
  | {
      readonly kind: "bioCatchphrase" | "bioFear" | "bioOrigin";
      readonly tick: number;
      readonly variantIndex: number;
    }
  | {
      readonly kind: "bondMilestone";
      readonly tick: number;
      readonly partnerId: string;
      readonly tier: number;
    }
  | { readonly kind: "death"; readonly tick: number }
  | {
      readonly kind: "explorationRescue";
      readonly tick: number;
      readonly rescuedId: string;
      readonly band: string;
    }
  | { readonly kind: "partnerLost"; readonly tick: number; readonly partnerId: string };

/**
 * [M12] memoirLog(state.ts の {@link MemoirLogState})。resident 側の省略可
 * フィールドの値の形(§6)であり、それ自体に省略可フィールドは無い(件数上限の
 * 折り畳みは `foldedCount` という値の形で表すので、キー自体を省略する必要が
 * 無い)。
 */
export type SerializedMemoirLog = {
  readonly entries: readonly SerializedMemoirEntry[];
  readonly foldedCount: number;
};

export type SerializedEntity =
  | SerializedCodify
  | SerializedFacility
  | SerializedResearch
  | SerializedResident
  | SerializedResource;

/**
 * GameState の直列化形。ADR「セーブフォーマット」(649行)のうち現状扱う範囲
 * (state.ts §3 / §4 参照)。
 *
 * `rngState` は空のとき省略される(§3)。[M12] `bondByPairKey` も同じ規約で
 * 省略される(§6)。
 */
export type SerializedGameState = {
  readonly saveSchemaVersion: number;
  readonly contentVersion: number;
  readonly algoVersion: number;
  readonly worldSeed: string;
  readonly tick: number;
  readonly entityStateById: { readonly [id: string]: SerializedEntity };
  readonly rngState?: { readonly [domainTag: string]: readonly number[] };
  /** [M12] pairKey(`"residentAId|residentBId"`)→ 蓄積 bond 値(raw 整数)。 */
  readonly bondByPairKey?: { readonly [pairKey: string]: number };
  /**
   * [M13] キー(`"residentId|techId"`)→ 住民 × 技術の記憶(§8)。
   * 空なら `rngState` / `bondByPairKey` と同じ規約でキーごと省略される。
   */
  readonly techMemoryByKey?: { readonly [key: string]: SerializedTechMemory };
  /**
   * [M21] 未帰還の探索派遣(GDD 8.2 / 12.5-7・§9)。**配列**であり、空なら
   * キーごと省略される。`platform/persistence.ts` の `assertDispatchTreeBounds`
   * はこのキーを見て ADR-012(3) の上界を検算する。
   */
  readonly dispatchSnapshots?: readonly SerializedDispatchSnapshot[];
  /** [M21] 帰還ログ(GDD 8.4)。空なら省略される。 */
  readonly renderedLogs?: SerializedRenderedLogs;
  /**
   * [M24] 衛星拠点(GDD 9.2・§9 と同型)。キーは拠点 ID。
   * 空なら `rngState` 等と同じ規約でキーごと省略される。
   */
  readonly outpostsById?: { readonly [id: string]: SerializedOutpost };
  /**
   * [M52] 地形 / 瓦礫(GDD 9.1・§10)。**瓦礫ゼロ かつ 解放数 0 なら
   * キーごと省略**され、キー不在 = 全 48 セル開墾済みと解釈される。
   */
  readonly terrain?: SerializedTerrain;
  /**
   * [M28] 周回 / 継承点(GDD 10.2〜10.5・§11)。**1 周目 かつ 累計 0 かつ
   * 購入段ゼロならキーごと省略**され、キー不在 = まだ 1 度も大移動していないと
   * 解釈される。
   */
  readonly progression?: SerializedProgression;
  /**
   * [M50] 研究対象の選択(GDD 5・§12)。**未選択(null)ならキーごと省略**され、
   * キー不在 = 未選択 = 従来どおり ID 昇順先頭が対象、と解釈される。
   */
  readonly selectedResearchId?: string;
};

/**
 * [M21] スナップショットされたイベントノード(state.ts の {@link DispatchNode})。
 *
 * **[M22] 末尾 4 つは省略可**(event content 由来のノードだけが持つ)。省略時は
 * M21 の手続き生成ノードそのものであり、既存セーブ・既存 golden vector の
 * バイト列は 1 bit も動かない(§9 の「無ければキーごと出さない」規約)。
 */
export type SerializedDispatchNode = {
  readonly difficulty: number;
  readonly roll: number;
  readonly success: boolean;
  readonly reward: number;
  readonly injury: number;
  readonly rescue: boolean;
  /** [M22] 選ばれた choice の添字(GDD 8.3)。 */
  readonly choiceIndex?: number;
  /** [M22] 成立した branch の添字。 */
  readonly branchIndex?: number;
  /** [M22] 分岐ログのレンダリング済み完成文字列(GDD 8.4)。 */
  readonly logText?: string;
  /** [M22] 帰還時に適用する効果(`destroyRecords` 等)。 */
  readonly effects?: readonly SerializedDispatchEffect[];
};

/** [M22] 焼き込まれた効果(state.ts の {@link DispatchEffect})。 */
export type SerializedDispatchEffect = {
  readonly kind: string;
  readonly medium: string;
  readonly scope: string;
};

/**
 * [M21] 派遣スナップショット(state.ts の {@link DispatchSnapshot})。
 *
 * ノード列は `resolvedTree.choices` に載せる。ADR-012(3) の分岐木上界を検算する
 * `platform/persistence.ts` の `countTreeNodes` が `choices` / `children` を
 * 子ノードのキーとして歩くためであり(「木の形の唯一の仮定」と同ファイルが
 * 明記している)、engine 側の表現(平坦な配列)と検算側の表現をこの 1 箇所で
 * 突き合わせる。
 */
export type SerializedDispatchSnapshot = {
  readonly id: string;
  readonly destinationId: string;
  readonly band: string;
  readonly stance: string;
  readonly memberIds: readonly string[];
  readonly dispatchTick: number;
  readonly returnTick: number;
  readonly teamPower: number;
  readonly withdrawn: boolean;
  readonly reward: number;
  readonly rewardResourceId: string;
  readonly casualtyMemberIds: readonly string[];
  readonly resolvedTree: { readonly choices: readonly SerializedDispatchNode[] };
  /** [M22] 出所になった event content の ID。手続き生成なら**キーごと省略**。 */
  readonly eventId?: string;
};

/** [M21] 帰還ログ(state.ts の {@link RenderedLogState})。 */
export type SerializedRenderedLogs = {
  readonly entries: readonly { readonly tick: number; readonly text: string }[];
  readonly foldedCount: number;
};

/** [M13] 住民 × 技術の記憶(state.ts の {@link TechMemoryState})。 */
export type SerializedTechMemory = {
  /** 定着度の raw 整数。 */
  readonly mastery: number;
  /** 想起困難が解ける tick(素の整数)。 */
  readonly impairedUntilTick: number;
};

/**
 * [M52] 地形 / 瓦礫(state.ts の {@link TerrainState})。省略可フィールドは無い
 * (「瓦礫ゼロ かつ 解放数 0」は**このオブジェクト自体を省略**することで表す・§10)。
 */
export type SerializedTerrain = {
  /** 未開墾セル番号(昇順・重複なし・0〜47)。 */
  readonly rubbleCells: readonly number[];
  /** これまでに開墾したセル数(GDD 9.1 の解放数)。 */
  readonly reclaimedCount: number;
};

/**
 * [M28] 周回 / 継承点(state.ts の {@link ProgressionState})。省略可フィールドは
 * 無い(「1 周目 かつ 累計 0 かつ 購入段ゼロ」は**このオブジェクト自体を省略**
 * することで表す・§11)。
 */
export type SerializedProgression = {
  /** 完了した大移動の回数(0 = 1 周目)。 */
  readonly runCount: number;
  /** 累計獲得した継承点(購入では減らない・GDD 10.5 のシード材料)。 */
  readonly cumulativeInheritPoints: number;
  /** 系統別の購入済み段数(track 昇順・重複なし・tier >= 1)。空でも書く。 */
  readonly inheritTiers: readonly { readonly track: string; readonly tier: number }[];
};

/** [M24] 衛星拠点(state.ts の {@link OutpostState})。省略可フィールドは無い。 */
export type SerializedOutpost = {
  readonly id: string;
  readonly outpostTypeId: string;
  readonly level: number;
  readonly band: string;
  readonly residentIds: readonly string[];
  readonly establishedTick: number;
};

// --- 2. state → JSON -------------------------------------------------------

/** [M12] memoirLog の直列化(state.ts の {@link MemoirLogState} 参照・§6)。 */
function serializeMemoirLog(log: MemoirLogState): SerializedMemoirLog {
  return {
    entries: log.entries.map(serializeMemoirEntry),
    foldedCount: log.foldedCount,
  };
}

/**
 * [M5/M11/M12] 省略可の `stats` / `life` / `memoir` を持つ resident の直列化
 * (§4 / §5 / §6 の 8 分岐)。3 つの独立した省略可フィールドを持つため、
 * 生スプレッド禁止(ADR-028(1)。このファイルも免除対象外)・
 * exactOptionalPropertyTypes 下では 2^3 = 8 通りのリテラルを素直に書き分ける
 * ほかない(state.ts の `ResidentState.memoir` の doc に経緯を記載)。
 * 共通の 8 フィールドはローカル変数へ切り出し、各分岐で明示的に書き並べる
 * (スプレッドではなく個別代入なので、値の再計算は起きない)。
 */
function serializeResident(entity: ResidentState): SerializedResident {
  const rawStats = entity.stats;
  const stats: SerializedResidentStats | undefined =
    rawStats === undefined
      ? undefined
      : {
          vigor: toRaw(rawStats.vigor),
          dexterity: toRaw(rawStats.dexterity),
          intellect: toRaw(rawStats.intellect),
          fortitude: toRaw(rawStats.fortitude),
          will: toRaw(rawStats.will),
        };
  const rawLife = entity.life;
  const life: SerializedResidentLife | undefined =
    rawLife === undefined
      ? undefined
      : {
          bornTick: rawLife.bornTick,
          lifespanTick: rawLife.lifespanTick,
          diedTick: rawLife.diedTick,
        };
  const rawMemoir = entity.memoir;
  const memoir: SerializedMemoirLog | undefined =
    rawMemoir === undefined ? undefined : serializeMemoirLog(rawMemoir);

  const id = entity.id;
  const morale = toRaw(entity.morale);
  const mastery = toRaw(entity.mastery);
  const assignedFacilityId = entity.assignedFacilityId;
  const dispatched = entity.dispatched;
  const traitIds = [...entity.traitIds];
  const recallImpairedUntilTick = entity.recallImpairedUntilTick;

  if (stats === undefined && life === undefined && memoir === undefined) {
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
  if (life === undefined && memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as SerializedResidentStats,
    };
  }
  if (stats === undefined && memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      life: life as SerializedResidentLife,
    };
  }
  if (stats === undefined && life === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      memoir: memoir as SerializedMemoirLog,
    };
  }
  if (memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as SerializedResidentStats,
      life: life as SerializedResidentLife,
    };
  }
  if (life === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as SerializedResidentStats,
      memoir,
    };
  }
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
      life,
      memoir,
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
    life,
    memoir,
  };
}

/**
 * [M16] 省略可の `footprint` を持つ facility の直列化(§7)。
 * 1×1(= キー不在と同義)は**書き出さない**ので分岐は 2 通りで済む。
 *
 * 値域外の footprint は**書き出さずに停止する**。読めない形を書くと
 * 「保存はできたのに次回ロードで SerializeError」= 静かなセーブ喪失になるため、
 * 書込側で止めるのが早い停止点である(`assertDispatchTreeBounds` を書込側に
 * 置いてあるのと同じ考え方・persistence.ts)。ここへ来るのは createGameState と
 * 配置コマンドの両方を迂回した場合だけ = engine のバグである。
 */
function serializeFacility(entity: FacilityState): SerializedFacility {
  const footprint = entity.footprint;
  if (footprint !== undefined && !isValidFootprintDims(footprint)) {
    throw new SerializeError(
      `toSerializable: 施設 "${entity.id}" の footprint ` +
        `${String(footprint.width)}×${String(footprint.height)} は値域外` +
        `(1〜${String(FOOTPRINT_DIM_MAX)} の整数・§7)。読めない形は書き出さない`,
    );
  }
  if (footprint === undefined || isUnitFootprint(footprint)) {
    return {
      kind: "facility",
      id: entity.id,
      defId: entity.defId,
      level: entity.level,
      cellIndex: entity.cellIndex,
      workerIds: [...entity.workerIds],
    };
  }
  return {
    kind: "facility",
    id: entity.id,
    defId: entity.defId,
    level: entity.level,
    cellIndex: entity.cellIndex,
    workerIds: [...entity.workerIds],
    footprint: { width: footprint.width, height: footprint.height },
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

/** [M12] memoirLog エントリ 1 件の直列化(state.ts の {@link MemoirEntry} 判別)。 */
function serializeMemoirEntry(entry: MemoirEntry): SerializedMemoirEntry {
  switch (entry.kind) {
    case "arrival":
      return { kind: "arrival", tick: entry.tick };
    case "bioCatchphrase":
    case "bioFear":
    case "bioOrigin":
      return { kind: entry.kind, tick: entry.tick, variantIndex: entry.variantIndex };
    case "bondMilestone":
      return {
        kind: "bondMilestone",
        tick: entry.tick,
        partnerId: entry.partnerId,
        tier: entry.tier,
      };
    case "death":
      return { kind: "death", tick: entry.tick };
    case "explorationRescue":
      return {
        kind: "explorationRescue",
        tick: entry.tick,
        rescuedId: entry.rescuedId,
        band: entry.band,
      };
    case "partnerLost":
      return { kind: "partnerLost", tick: entry.tick, partnerId: entry.partnerId };
    default: {
      const unhandled: never = entry;
      throw new SerializeError(
        `serializeMemoirEntry: 未知のエントリ種別 ${String((unhandled as MemoirEntry).kind)}`,
      );
    }
  }
}

/**
 * [M13] 省略可の `loss`(技術喪失・GDD 7.4)を持つ research の直列化(§8)。
 * 分岐は 2 通りだけなので素直に書き分ける(resident の 8 分岐と同じ理由で
 * 生スプレッドは使えない)。
 */
function serializeResearch(entity: ResearchState): SerializedResearch {
  const rawLoss = entity.loss;
  if (rawLoss === undefined) {
    return {
      kind: "research",
      id: entity.id,
      techId: entity.techId,
      progress: toRaw(entity.progress),
      completedTick: entity.completedTick,
    };
  }
  // [M22] `lastHolderId` は省略可(記録の焼失による喪失には最後の保持者が
  //       居ない・state.ts の TechLossState)。死亡起因の従来の喪失は必ず持つ
  //       ので、既存セーブのバイト列は動かない。
  const lastHolderId = rawLoss.lastHolderId;
  if (lastHolderId === undefined) {
    return {
      kind: "research",
      id: entity.id,
      techId: entity.techId,
      progress: toRaw(entity.progress),
      completedTick: entity.completedTick,
      loss: { tick: rawLoss.tick, irreversible: rawLoss.irreversible },
    };
  }
  return {
    kind: "research",
    id: entity.id,
    techId: entity.techId,
    progress: toRaw(entity.progress),
    completedTick: entity.completedTick,
    loss: { tick: rawLoss.tick, irreversible: rawLoss.irreversible, lastHolderId },
  };
}

/** [M24] 拠点の直列化(state.ts の {@link OutpostState})。省略可フィールドは無い。 */
function serializeOutpost(outpost: OutpostState): SerializedOutpost {
  return {
    id: outpost.id,
    outpostTypeId: outpost.outpostTypeId,
    level: outpost.level,
    band: outpost.band,
    residentIds: [...outpost.residentIds],
    establishedTick: outpost.establishedTick,
  };
}

function serializeEntity(entity: EntityState): SerializedEntity {
  switch (entity.kind) {
    case "codify":
      return {
        kind: "codify",
        id: entity.id,
        techId: entity.techId,
        medium: entity.medium,
        requiredWork: toRaw(entity.requiredWork),
        progress: toRaw(entity.progress),
        completedTick: entity.completedTick,
      };
    case "resident":
      return serializeResident(entity);
    case "facility":
      return serializeFacility(entity);
    case "research":
      return serializeResearch(entity);
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
 * [M21] 派遣ノード 1 件の直列化(§9)。
 *
 * **[M22] 省略可 4 キーは「値があるときだけ足す」**。生スプレッド禁止
 * (ADR-028(1)・このファイルは免除対象外)なので、必須キーのリテラルへ
 * `Object.entries` 連結で足す形にする(`toSerializable` の optional と同型)。
 */
function serializeDispatchNode(node: DispatchNode): SerializedDispatchNode {
  const required = {
    difficulty: toRaw(node.difficultyFix),
    roll: toRaw(node.rollFix),
    success: node.success,
    reward: toRaw(node.rewardFix),
    injury: toRaw(node.injuryFix),
    rescue: node.rescue,
  };
  const optional: [string, unknown][] = [];
  if (node.choiceIndex !== undefined) optional.push(["choiceIndex", node.choiceIndex]);
  if (node.branchIndex !== undefined) optional.push(["branchIndex", node.branchIndex]);
  if (node.logText !== undefined) optional.push(["logText", node.logText]);
  if (node.effects !== undefined && node.effects.length > 0) {
    optional.push([
      "effects",
      node.effects.map((effect) => ({
        kind: effect.kind,
        medium: effect.medium,
        scope: effect.scope,
      })),
    ]);
  }
  if (optional.length === 0) return required;
  return Object.fromEntries([
    ...Object.entries(required),
    ...optional,
  ]) as unknown as SerializedDispatchNode;
}

/** [M21] 派遣スナップショットの直列化(§9)。ノード列は `resolvedTree.choices` へ。 */
function serializeDispatchSnapshot(snapshot: DispatchSnapshot): SerializedDispatchSnapshot {
  const required = {
    id: snapshot.id,
    destinationId: snapshot.destinationId,
    band: snapshot.band,
    stance: snapshot.stance,
    memberIds: [...snapshot.memberIds],
    dispatchTick: snapshot.dispatchTick,
    returnTick: snapshot.returnTick,
    teamPower: toRaw(snapshot.teamPowerFix),
    withdrawn: snapshot.withdrawn,
    reward: toRaw(snapshot.rewardFix),
    rewardResourceId: snapshot.rewardResourceId,
    casualtyMemberIds: [...snapshot.casualtyMemberIds],
    resolvedTree: { choices: snapshot.nodes.map(serializeDispatchNode) },
  };
  if (snapshot.eventId === undefined) return required;
  return Object.fromEntries([
    ...Object.entries(required),
    ["eventId", snapshot.eventId],
  ]) as unknown as SerializedDispatchSnapshot;
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

  // [M12] bondByPairKey も rngState と同じ規約(§6): 空なら省略する。
  const bondEntries: [string, number][] = [];
  for (const [pairKey, value] of state.bondByPairKey) {
    bondEntries.push([pairKey, toRaw(value)]);
  }

  // [M13] techMemoryByKey も同じ規約(§8)。
  const techMemoryEntries: [string, SerializedTechMemory][] = [];
  for (const [key, value] of state.techMemoryByKey) {
    techMemoryEntries.push([
      key,
      { mastery: toRaw(value.masteryFix), impairedUntilTick: value.impairedUntilTick },
    ]);
  }

  // 空の rngState / bondByPairKey / techMemoryByKey はキーごと省略する
  // (§3 / §6 / §8)。オブジェクトの生スプレッドは ADR-028(1) で禁止(このファイルも
  // 免除対象外)なので、**必須キーだけのリテラル + 省略可キーの entries 連結**で
  // 組む。省略可フィールドが 3 つになり、2^3 = 8 通りのリテラル書き分けでは
  // 「1 箇所だけ直し忘れる」形の壊れ方を作るため、[M13] でこの形へ改めた
  // (`Object.entries` / `Object.fromEntries` はこのファイルだけが免除されている)。
  const required = {
    saveSchemaVersion: state.saveSchemaVersion,
    contentVersion: state.contentVersion,
    algoVersion: state.algoVersion,
    worldSeed: state.worldSeed,
    tick: state.tick,
    entityStateById,
  };
  const optional: [string, unknown][] = [];
  if (rngEntries.length > 0) optional.push(["rngState", Object.fromEntries(rngEntries)]);
  if (bondEntries.length > 0) optional.push(["bondByPairKey", Object.fromEntries(bondEntries)]);
  if (techMemoryEntries.length > 0) {
    optional.push(["techMemoryByKey", Object.fromEntries(techMemoryEntries)]);
  }
  // [M21] 探索(§9)。どちらも空なら省略 = M21 以前のセーブとバイト同一。
  if (state.dispatchSnapshots.length > 0) {
    optional.push(["dispatchSnapshots", state.dispatchSnapshots.map(serializeDispatchSnapshot)]);
  }
  const logs = state.renderedLogs;
  if (logs.entries.length > 0 || logs.foldedCount > 0) {
    optional.push([
      "renderedLogs",
      {
        entries: logs.entries.map((entry) => ({ tick: entry.tick, text: entry.text })),
        foldedCount: logs.foldedCount,
      },
    ]);
  }
  // [M24] 拠点(GDD 9.2)。空なら省略 = M24 以前のセーブとバイト同一(state.ts §h)。
  if (state.outpostsById.size > 0) {
    const outpostEntries: [string, SerializedOutpost][] = [];
    for (const [outpostId, outpost] of state.outpostsById) {
      outpostEntries.push([outpostId, serializeOutpost(outpost)]);
    }
    optional.push(["outpostsById", Object.fromEntries(outpostEntries)]);
  }
  // [M52] 地形(GDD 9.1・§10)。瓦礫ゼロ かつ 解放数 0 なら省略 = M52 以前の
  // セーブとバイト同一(= 既存 golden vector 64 本が動かないことの根拠)。
  const terrain = state.terrain;
  if (terrain.rubbleCells.length > 0 || terrain.reclaimedCount > 0) {
    optional.push([
      "terrain",
      { rubbleCells: [...terrain.rubbleCells], reclaimedCount: terrain.reclaimedCount },
    ]);
  }
  // [M28] 周回 / 継承点(GDD 10.2〜10.5・§11)。既定値なら省略 = M28 以前の
  // セーブとバイト同一(= 既存 golden vector 73 本が動かないことの根拠)。
  const progression = state.progression;
  if (
    progression.runCount > 0 ||
    progression.cumulativeInheritPoints > 0 ||
    progression.inheritTiers.length > 0
  ) {
    optional.push([
      "progression",
      {
        runCount: progression.runCount,
        cumulativeInheritPoints: progression.cumulativeInheritPoints,
        inheritTiers: progression.inheritTiers.map((entry) => ({
          track: entry.track,
          tier: entry.tier,
        })),
      },
    ]);
  }
  // [M50] 研究対象の選択(GDD 5・§12)。未選択なら省略 = M50 以前のセーブと
  // バイト同一(= 既存 golden vector 73 本が動かないことの根拠)。
  if (state.selectedResearchId !== null) {
    optional.push(["selectedResearchId", state.selectedResearchId]);
  }
  const raw: SerializedGameState =
    optional.length === 0
      ? required
      : (Object.fromEntries([
          ...Object.entries(required),
          ...optional,
        ]) as unknown as SerializedGameState);

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

/**
 * [M11] `life`(省略可・§5)を読む。キーが無ければ undefined。
 *
 * `bornTick` は**負値を許す**(ゲーム開始前に生まれた住民・state.ts の
 * {@link ResidentLife})。`lifespanTick` は 1 以上、`diedTick` は非負または null。
 */
function requireResidentLifeOrUndefined(value: unknown, path: string): ResidentLife | undefined {
  if (value === undefined) return undefined;
  const o = requireObject(value, path);
  const bornTick = requireInt(o["bornTick"], `${path}.bornTick`);
  const lifespanTick = requireInt(o["lifespanTick"], `${path}.lifespanTick`);
  if (lifespanTick < 1) {
    throw new SerializeError(
      `${path}.lifespanTick: 1 以上を期待したが ${String(lifespanTick)} だった(寿命 0 の住民は生成されない)`,
    );
  }
  const rawDied = o["diedTick"];
  const diedTick = rawDied === null ? null : requireNonNegativeInt(rawDied, `${path}.diedTick`);
  return { bornTick, lifespanTick, diedTick };
}

/**
 * [M5/M11/M12] resident の復元。`stats` / `life` / `memoir` の 3 つの独立した
 * 省略可フィールドを持つため、serializeResident と対になる 8 分岐(§4 / §5 / §6)。
 * exactOptionalPropertyTypes 下では `stats: undefined` を書けず、生スプレッドも
 * 使えないので素直に書き分ける。
 */
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
  const life = requireResidentLifeOrUndefined(o["life"], `${p}.life`);
  const memoir = requireMemoirLogOrUndefined(o["memoir"], `${p}.memoir`);

  if (stats === undefined && life === undefined && memoir === undefined) {
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
  if (life === undefined && memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as ResidentStats,
    };
  }
  if (stats === undefined && memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      life: life as ResidentLife,
    };
  }
  if (stats === undefined && life === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      memoir: memoir as MemoirLogState,
    };
  }
  if (memoir === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as ResidentStats,
      life: life as ResidentLife,
    };
  }
  if (life === undefined) {
    return {
      kind: "resident",
      id,
      morale,
      mastery,
      assignedFacilityId,
      dispatched,
      traitIds,
      recallImpairedUntilTick,
      stats: stats as ResidentStats,
      memoir,
    };
  }
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
      life,
      memoir,
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
    life,
    memoir,
  };
}

/**
 * [M16] `footprint`(省略可・§7)を読む。キーが無ければ undefined。
 *
 * 1×1 の明示と値域外はどちらも reject する(§7 の 2 つの理由: 正準形の一意性と、
 * セーブの表現能力の固定)。
 */
function requireFacilityFootprintOrUndefined(
  value: unknown,
  path: string,
): FacilityFootprint | undefined {
  if (value === undefined) return undefined;
  const o = requireObject(value, path);
  const footprint: FacilityFootprint = {
    width: requireInt(o["width"], `${path}.width`),
    height: requireInt(o["height"], `${path}.height`),
  };
  if (!isValidFootprintDims(footprint)) {
    throw new SerializeError(
      `${path}: 幅・高さは 1〜${String(FOOTPRINT_DIM_MAX)} の整数(GDD 6.1 の大型施設は 2×1 / 2×2)。` +
        `実際: ${String(footprint.width)}×${String(footprint.height)}`,
    );
  }
  if (isUnitFootprint(footprint)) {
    throw new SerializeError(
      `${path}: 1×1 は省略が正準形なのでキーごと書かないこと(§7)。` +
        "明示を許すと同じ state に 2 通りの直列化形ができ、往復のバイト同一性が壊れる",
    );
  }
  return footprint;
}

function deserializeFacility(id: EntityId, o: Record<string, unknown>, p: string): FacilityState {
  const defId = requireEntityId(o["defId"], `${p}.defId`);
  const level = requireNonNegativeInt(o["level"], `${p}.level`);
  const cellIndex = requireNonNegativeInt(o["cellIndex"], `${p}.cellIndex`);
  const workerIds = requireEntityIdArray(o["workerIds"], `${p}.workerIds`);
  const footprint = requireFacilityFootprintOrUndefined(o["footprint"], `${p}.footprint`);
  // 盤面へ収まるか(cellIndex と footprint の**関係**)の検査は createGameState の
  // 担当である(update.ts の requireValidFacilityFootprint)。ここは JSON としての
  // 形と値域までを見る(§2 の層分け)。
  if (footprint === undefined) {
    return { kind: "facility", id, defId, level, cellIndex, workerIds };
  }
  return { kind: "facility", id, defId, level, cellIndex, workerIds, footprint };
}

/** [M13] `research.loss`(省略可・§8)を読む。キーが無ければ undefined。 */
function requireTechLossOrUndefined(value: unknown, path: string): TechLossState | undefined {
  if (value === undefined) return undefined;
  const o = requireObject(value, path);
  const tick = requireInt(o["tick"], `${path}.tick`);
  const irreversible = requireBoolean(o["irreversible"], `${path}.irreversible`);
  const rawHolder = o["lastHolderId"];
  // [M22] キー不在 = 記録の焼失による喪失(最後の保持者が居ない)。
  if (rawHolder === undefined) return { tick, irreversible };
  return {
    tick,
    irreversible,
    lastHolderId: requireEntityId(rawHolder, `${path}.lastHolderId`),
  };
}

function deserializeResearch(id: EntityId, o: Record<string, unknown>, p: string): ResearchState {
  const techId = requireEntityId(o["techId"], `${p}.techId`);
  const progress = requireFix(o["progress"], `${p}.progress`);
  const completedTick = requireIntOrNull(o["completedTick"], `${p}.completedTick`);
  const loss = requireTechLossOrUndefined(o["loss"], `${p}.loss`);
  if (loss === undefined) {
    return { kind: "research", id, techId, progress, completedTick };
  }
  return { kind: "research", id, techId, progress, completedTick, loss };
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

/** [M6] 記録媒体は engine 既知の 2 種のみ(未知は reject・rules/types.ts §3c)。 */
function requireRecordMedium(value: unknown, path: string): RecordMedium {
  const raw = requireString(value, path);
  if (!isRecordMedium(raw)) {
    throw new SerializeError(
      `${path}: "${raw}" は記録媒体ではない(${RECORD_MEDIA.join(",")} のいずれか・GDD 11.1 追補)`,
    );
  }
  return raw;
}

function deserializeCodify(id: EntityId, o: Record<string, unknown>, p: string): CodifyState {
  return {
    kind: "codify",
    id,
    techId: requireEntityId(o["techId"], `${p}.techId`),
    medium: requireRecordMedium(o["medium"], `${p}.medium`),
    requiredWork: requireFix(o["requiredWork"], `${p}.requiredWork`),
    progress: requireFix(o["progress"], `${p}.progress`),
    completedTick: requireIntOrNull(o["completedTick"], `${p}.completedTick`),
  };
}

/** [M12] memoir エントリ種別を検査する(未知は reject)。 */
function requireMemoirEntryKind(value: unknown, path: string): MemoirEntryKind {
  const raw = requireString(value, path);
  if (!isMemoirEntryKind(raw)) {
    throw new SerializeError(
      `${path}: "${raw}" は memoir エントリ種別ではない(state.ts の MEMOIR_ENTRY_KINDS 参照)`,
    );
  }
  return raw;
}

/** [M21] 距離帯(裁定 B7)。レジストリ外の文字列は reject する。 */
function requireDistanceBand(value: unknown, path: string): DistanceBand {
  const raw = requireString(value, path);
  if (!isDistanceBand(raw)) {
    throw new SerializeError(
      `${path}: "${raw}" は距離帯ではない(rules/types.ts の DISTANCE_BANDS 参照・裁定 B7)`,
    );
  }
  return raw;
}

/** [M21] 派遣方針(GDD 8.3)。レジストリ外の文字列は reject する。 */
function requireDispatchStance(value: unknown, path: string): DispatchStance {
  const raw = requireString(value, path);
  if (!isDispatchStance(raw)) {
    throw new SerializeError(
      `${path}: "${raw}" は派遣方針ではない(state.ts の DISPATCH_STANCES 参照)`,
    );
  }
  return raw;
}

/** [M12] memoirLog エントリ 1 件の復元(state.ts の {@link MemoirEntry} 判別)。 */
function deserializeMemoirEntry(value: unknown, path: string): MemoirEntry {
  const o = requireObject(value, path);
  const kind = requireMemoirEntryKind(o["kind"], `${path}.kind`);
  const tick = requireNonNegativeInt(o["tick"], `${path}.tick`);
  switch (kind) {
    case "arrival":
      return { kind, tick };
    case "bioCatchphrase":
    case "bioFear":
    case "bioOrigin":
      return {
        kind,
        tick,
        variantIndex: requireNonNegativeInt(o["variantIndex"], `${path}.variantIndex`),
      };
    case "bondMilestone":
      return {
        kind,
        tick,
        partnerId: requireEntityId(o["partnerId"], `${path}.partnerId`),
        tier: requireNonNegativeInt(o["tier"], `${path}.tier`),
      };
    case "death":
      return { kind, tick };
    case "explorationRescue":
      return {
        kind,
        tick,
        rescuedId: requireEntityId(o["rescuedId"], `${path}.rescuedId`),
        band: requireDistanceBand(o["band"], `${path}.band`),
      };
    case "partnerLost":
      return { kind, tick, partnerId: requireEntityId(o["partnerId"], `${path}.partnerId`) };
    default: {
      const unhandled: never = kind;
      throw new SerializeError(`deserializeMemoirEntry: 未知の種別 ${String(unhandled)}`);
    }
  }
}

function deserializeMemoirEntryArray(value: unknown, path: string): readonly MemoirEntry[] {
  if (!Array.isArray(value)) {
    throw new SerializeError(`${path}: 配列を期待したが ${describe(value)} だった`);
  }
  const source = value as readonly unknown[];
  const result: MemoirEntry[] = [];
  for (let i = 0; i < source.length; i++) {
    result.push(deserializeMemoirEntry(source[i], `${path}[${String(i)}]`));
  }
  return result;
}

/**
 * [M12] `memoir`(省略可・§6)を読む。キーが無ければ undefined。
 * nested な `entries` は {@link deserializeMemoirEntryArray} を通す。
 */
function requireMemoirLogOrUndefined(value: unknown, path: string): MemoirLogState | undefined {
  if (value === undefined) return undefined;
  const o = requireObject(value, path);
  return {
    entries: deserializeMemoirEntryArray(o["entries"], `${path}.entries`),
    foldedCount: requireNonNegativeInt(o["foldedCount"], `${path}.foldedCount`),
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
    case "codify":
      return deserializeCodify(id, o, path);
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
 * [M12] pairKey が `bondPairKeyOf`(rules/bond.ts)の正準形 `"a|b"`(a<b・
 * 両者とも ID 規則に合致)かを検査して分解する。
 */
function splitBondPairKey(pairKey: string, path: string): readonly [EntityId, EntityId] {
  const parts = pairKey.split("|");
  if (parts.length !== 2) {
    throw new SerializeError(
      `${path}: pairKey "${pairKey}" は "residentAId|residentBId" の形式でない`,
    );
  }
  const [rawA, rawB] = parts;
  const residentAId = requireEntityId(rawA, `${path}(residentAId)`);
  const residentBId = requireEntityId(rawB, `${path}(residentBId)`);
  if (compareUtf16(residentAId, residentBId) >= 0) {
    throw new SerializeError(
      `${path}: "${residentAId}" は "${residentBId}" より辞書順で前でなければならない` +
        "(rules/bond.ts の bondPairKeyOf が課す正準形)",
    );
  }
  return [residentAId, residentBId];
}

/**
 * [M12] `bondByPairKey`(§6)を読む。キーは `"residentAId|residentBId"`
 * (a<b の正準形)、値は raw 整数。未登録形式・辞書順違反は reject する
 * (rngState の未登録 domainTag reject と同じ層)。
 */
function deserializeBondByPairKey(value: unknown): readonly (readonly [string, Fix])[] {
  if (value === undefined) return [];
  const o = requireObject(value, "$.bondByPairKey");
  const result: (readonly [string, Fix])[] = [];
  for (const key of Object.keys(o)) {
    const path = `$.bondByPairKey.${key}`;
    splitBondPairKey(key, path); // 形式検査のみ(戻り値は Map のキーには使わない)。
    result.push([key, requireFix(o[key], path)]);
  }
  return result;
}

/**
 * [M13] `techMemoryByKey`(§8)を読む。キーは `"residentId|techId"`
 * (`rules/techMemory.ts` の `techMemoryKeyOf` の正準形。両者とも ID 規則に合致)、
 * 値は `{mastery, impairedUntilTick}`。形式違反は reject する
 * (bondByPairKey の形式検査と同じ層)。
 *
 * bond と違い**辞書順の制約は無い**(キーは (住民, 技術) の**順序付き**対であり、
 * 住民 ID と技術 ID を入れ替えた形は別の意味になるため)。
 */
function deserializeTechMemoryByKey(
  value: unknown,
): readonly (readonly [string, TechMemoryState])[] {
  if (value === undefined) return [];
  const o = requireObject(value, "$.techMemoryByKey");
  const result: (readonly [string, TechMemoryState])[] = [];
  for (const key of Object.keys(o)) {
    const path = `$.techMemoryByKey.${key}`;
    const parts = key.split("|");
    if (parts.length !== 2) {
      throw new SerializeError(`${path}: キー "${key}" は "residentId|techId" の形式でない`);
    }
    requireEntityId(parts[0], `${path}(residentId)`);
    requireEntityId(parts[1], `${path}(techId)`);
    const entry = requireObject(o[key], path);
    result.push([
      key,
      {
        masteryFix: requireFix(entry["mastery"], `${path}.mastery`),
        impairedUntilTick: requireNonNegativeInt(
          entry["impairedUntilTick"],
          `${path}.impairedUntilTick`,
        ),
      },
    ]);
  }
  return result;
}

/**
 * [M24] 拠点 1 件の復元。省略可フィールドは無い(state.ts の {@link OutpostState})。
 */
function deserializeOutpost(id: EntityId, o: Record<string, unknown>, p: string): OutpostState {
  return {
    id,
    outpostTypeId: requireEntityId(o["outpostTypeId"], `${p}.outpostTypeId`),
    level: requireNonNegativeInt(o["level"], `${p}.level`),
    band: requireDistanceBand(o["band"], `${p}.band`),
    residentIds: requireEntityIdArray(o["residentIds"], `${p}.residentIds`),
    establishedTick: requireNonNegativeInt(o["establishedTick"], `${p}.establishedTick`),
  };
}

/**
 * [M24] `outpostsById`(§h)を読む。キーが無ければ空配列。キーは拠点 ID
 * (entity ではないが ID 規則 ADR-011 に従う・state.ts の OutpostState の doc)、
 * 値と自身の `id` の食い違いは `deserializeEntity` と同じ層で止める。
 */
function deserializeOutpostsById(value: unknown): readonly OutpostState[] {
  if (value === undefined) return [];
  const o = requireObject(value, "$.outpostsById");
  const result: OutpostState[] = [];
  for (const key of Object.keys(o)) {
    const path = `$.outpostsById.${key}`;
    if (!isEntityId(key)) {
      throw new SerializeError(`${path}: キー "${key}" は ID 規則に一致しない(ADR-011)`);
    }
    const id = entityIdFromString(key);
    const entryObj = requireObject(o[key], path);
    const declaredId = requireEntityId(entryObj["id"], `${path}.id`);
    if (declaredId !== id) {
      throw new SerializeError(`${path}: キー "${id}" と id フィールド "${declaredId}" が食い違う`);
    }
    result.push(deserializeOutpost(id, entryObj, path));
  }
  return result;
}

/**
 * [M21] `dispatchSnapshots`(§9)を読む。キーが無ければ空配列。
 *
 * ADR-012(3) の上界(同時派遣 2 / ノード 16)は**ここでは見ない** —— 上界の
 * 強制は `platform/persistence.ts` の `assertDispatchTreeBounds` が書込側と
 * インポート側で行う層分けであり(同ファイル §2)、engine 側の復元は
 * 「JSON として型が合っているか」までに留める(§2 の方針)。
 */
function deserializeDispatchSnapshots(value: unknown): readonly DispatchSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SerializeError(`$.dispatchSnapshots: 配列を期待したが ${describe(value)} だった`);
  }
  const source = value as readonly unknown[];
  const result: DispatchSnapshot[] = [];
  for (let i = 0; i < source.length; i++) {
    const path = `$.dispatchSnapshots[${String(i)}]`;
    const o = requireObject(source[i], path);
    const tree = requireObject(o["resolvedTree"], `${path}.resolvedTree`);
    const rawNodes = tree["choices"];
    if (!Array.isArray(rawNodes)) {
      throw new SerializeError(
        `${path}.resolvedTree.choices: 配列を期待したが ${describe(rawNodes)} だった`,
      );
    }
    const nodes: DispatchNode[] = [];
    const nodeSource = rawNodes as readonly unknown[];
    for (let n = 0; n < nodeSource.length; n++) {
      const nodePath = `${path}.resolvedTree.choices[${String(n)}]`;
      nodes.push(deserializeDispatchNode(requireObject(nodeSource[n], nodePath), nodePath));
    }
    const base: DispatchSnapshot = {
      id: requireEntityId(o["id"], `${path}.id`),
      destinationId: requireEntityId(o["destinationId"], `${path}.destinationId`),
      band: requireDistanceBand(o["band"], `${path}.band`),
      stance: requireDispatchStance(o["stance"], `${path}.stance`),
      memberIds: requireEntityIdArray(o["memberIds"], `${path}.memberIds`),
      dispatchTick: requireNonNegativeInt(o["dispatchTick"], `${path}.dispatchTick`),
      returnTick: requireNonNegativeInt(o["returnTick"], `${path}.returnTick`),
      teamPowerFix: requireFix(o["teamPower"], `${path}.teamPower`),
      nodes,
      withdrawn: requireBoolean(o["withdrawn"], `${path}.withdrawn`),
      rewardFix: requireFix(o["reward"], `${path}.reward`),
      rewardResourceId: requireEntityId(o["rewardResourceId"], `${path}.rewardResourceId`),
      casualtyMemberIds: requireEntityIdArray(o["casualtyMemberIds"], `${path}.casualtyMemberIds`),
    };
    const rawEventId = o["eventId"];
    // 生スプレッドは ADR-028(1) で禁止(このファイルは免除対象外)なので、
    // 省略可キーの追加は update.ts の単一コピー経路 `setField` を通す。
    result.push(
      rawEventId === undefined
        ? base
        : setField(base, "eventId", requireEntityId(rawEventId, `${path}.eventId`)),
    );
  }
  return result;
}

/**
 * [M22] 派遣ノード 1 件の復元(§9)。省略可 4 キーは**キーが無ければ持たせない**
 * (往復でバイト同一を保つため、`undefined` を明示的に入れない)。
 */
function deserializeDispatchNode(node: Record<string, unknown>, p: string): DispatchNode {
  let result: DispatchNode = {
    difficultyFix: requireFix(node["difficulty"], `${p}.difficulty`),
    rollFix: requireFix(node["roll"], `${p}.roll`),
    success: requireBoolean(node["success"], `${p}.success`),
    rewardFix: requireFix(node["reward"], `${p}.reward`),
    injuryFix: requireFix(node["injury"], `${p}.injury`),
    rescue: requireBoolean(node["rescue"], `${p}.rescue`),
  };
  const rawChoice = node["choiceIndex"];
  if (rawChoice !== undefined) {
    result = setField(result, "choiceIndex", requireNonNegativeInt(rawChoice, `${p}.choiceIndex`));
  }
  const rawBranch = node["branchIndex"];
  if (rawBranch !== undefined) {
    result = setField(result, "branchIndex", requireNonNegativeInt(rawBranch, `${p}.branchIndex`));
  }
  const rawLogText = node["logText"];
  if (rawLogText !== undefined) {
    result = setField(result, "logText", requireString(rawLogText, `${p}.logText`));
  }
  const rawEffects = node["effects"];
  if (rawEffects === undefined) return result;
  if (!Array.isArray(rawEffects)) {
    throw new SerializeError(`${p}.effects: 配列を期待したが ${describe(rawEffects)} だった`);
  }
  const source = rawEffects as readonly unknown[];
  const effects: DispatchEffect[] = [];
  for (let i = 0; i < source.length; i++) {
    const effectPath = `${p}.effects[${String(i)}]`;
    const effect = requireObject(source[i], effectPath);
    const kind = requireString(effect["kind"], `${effectPath}.kind`);
    if (kind !== "destroyRecords") {
      throw new SerializeError(
        `${effectPath}.kind: 未知の効果種別 "${kind}"(既知: destroyRecords)`,
      );
    }
    effects.push({
      kind,
      medium: requireString(effect["medium"], `${effectPath}.medium`),
      scope: requireString(effect["scope"], `${effectPath}.scope`),
    });
  }
  // 空配列は正準形として持たない(直列化側も長さ 0 ならキーを出さない)。
  return effects.length === 0 ? result : setField(result, "effects", effects);
}

/**
 * [M52] `terrain`(§10)を読む。**キーが無ければ瓦礫ゼロ**(= 全 48 セル
 * 開墾済み)であり、これが「M52 以前の旧セーブが無損失でロードされる」経路
 * そのものである。
 *
 * 空の terrain を明示した形は**非正準形として reject** する(§10。1×1 footprint の
 * 明示を reject するのと同じ理屈で、往復のバイト同一性を定理として保つため)。
 * 昇順・重複なし・値域は `createGameState` が強制するので、ここでは JSON として
 * 型が合っているかだけを見る(§2 の層分け)。
 */
function deserializeTerrain(value: unknown): TerrainState {
  if (value === undefined) return EMPTY_TERRAIN;
  const o = requireObject(value, "$.terrain");
  const rawCells = o["rubbleCells"];
  if (!Array.isArray(rawCells)) {
    throw new SerializeError(
      `$.terrain.rubbleCells: 配列を期待したが ${describe(rawCells)} だった`,
    );
  }
  const source = rawCells as readonly unknown[];
  const rubbleCells: number[] = [];
  for (let i = 0; i < source.length; i++) {
    rubbleCells.push(requireNonNegativeInt(source[i], `$.terrain.rubbleCells[${String(i)}]`));
  }
  const reclaimedCount = requireNonNegativeInt(o["reclaimedCount"], "$.terrain.reclaimedCount");
  if (rubbleCells.length === 0 && reclaimedCount === 0) {
    throw new SerializeError(
      "$.terrain: 瓦礫ゼロ かつ 解放数 0 の地形は**キーごと省略**が正準形" +
        "(明示するとキー不在の旧セーブと同じ state が別のバイト列になる・§10)",
    );
  }
  return { rubbleCells, reclaimedCount };
}

/**
 * [M28] `progression`(§11)を読む。**キーが無ければ {@link EMPTY_PROGRESSION}**
 * (= まだ 1 度も大移動していない)であり、これが「M28 以前の旧セーブが無損失で
 * ロードされる」経路そのものである。
 *
 * 既定値を明示した形は**非正準形として reject** する(§11。空 terrain の明示を
 * reject するのと同じ理屈)。track の昇順・重複なしと tier >= 1 は
 * `createGameState`(update.ts の `requireValidProgression`)が強制するので、
 * ここでは JSON として型が合っているかと**レジストリ整合**だけを見る
 * (未登録の系統名は `rngState` の未登録 domainTag と同じ層で弾く)。
 */
function deserializeProgression(value: unknown): ProgressionState {
  if (value === undefined) return EMPTY_PROGRESSION;
  const o = requireObject(value, "$.progression");
  const runCount = requireNonNegativeInt(o["runCount"], "$.progression.runCount");
  const cumulativeInheritPoints = requireNonNegativeInt(
    o["cumulativeInheritPoints"],
    "$.progression.cumulativeInheritPoints",
  );
  const rawTiers = o["inheritTiers"];
  if (!Array.isArray(rawTiers)) {
    throw new SerializeError(
      `$.progression.inheritTiers: 配列を期待したが ${describe(rawTiers)} だった`,
    );
  }
  const source = rawTiers as readonly unknown[];
  const inheritTiers: InheritTierEntry[] = [];
  for (let i = 0; i < source.length; i++) {
    const path = `$.progression.inheritTiers[${String(i)}]`;
    const entry = requireObject(source[i], path);
    const track = requireString(entry["track"], `${path}.track`);
    if (!isInheritTrack(track)) {
      throw new SerializeError(
        `${path}.track: 継承系統 "${track}" はレジストリ(INHERIT_TRACKS)に無い`,
      );
    }
    inheritTiers.push({ track, tier: requireNonNegativeInt(entry["tier"], `${path}.tier`) });
  }
  if (runCount === 0 && cumulativeInheritPoints === 0 && inheritTiers.length === 0) {
    throw new SerializeError(
      "$.progression: 1 周目 かつ 累計継承点 0 かつ 購入段ゼロの進行は**キーごと省略**が正準形" +
        "(明示するとキー不在の旧セーブと同じ state が別のバイト列になる・§11)",
    );
  }
  return { runCount, cumulativeInheritPoints, inheritTiers };
}

/**
 * [M50] `selectedResearchId`(§12)を読む。**キーが無ければ null**(= 未選択)で
 * あり、これが「M50 以前の旧セーブが無損失でロードされる」経路そのものである。
 *
 * `null` を明示した形は**非正準形として reject** する(§12。空 terrain / 既定
 * progression の明示を reject するのと同じ理屈)。指す research entity が実在
 * するかの検査は `createGameState`(update.ts の `requireValidSelectedResearch`)
 * の担当であり、ここでは ID 規則だけを見る(entityStateById のキー検査と同じ層)。
 */
function deserializeSelectedResearchId(value: unknown): EntityId | null {
  if (value === undefined) return null;
  if (value === null) {
    throw new SerializeError(
      "$.selectedResearchId: 未選択は**キーごと省略**が正準形" +
        "(明示するとキー不在の旧セーブと同じ state が別のバイト列になる・§12)",
    );
  }
  const id = requireString(value, "$.selectedResearchId");
  if (!isEntityId(id)) {
    throw new SerializeError(`$.selectedResearchId: "${id}" は ID 規則に一致しない(ADR-011)`);
  }
  return entityIdFromString(id);
}

/** [M21] `renderedLogs`(§9)を読む。キーが無ければ空(正準形)。 */
function deserializeRenderedLogs(value: unknown): RenderedLogState {
  if (value === undefined) return EMPTY_RENDERED_LOGS;
  const o = requireObject(value, "$.renderedLogs");
  const rawEntries = o["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new SerializeError(
      `$.renderedLogs.entries: 配列を期待したが ${describe(rawEntries)} だった`,
    );
  }
  const source = rawEntries as readonly unknown[];
  const entries: RenderedLogEntry[] = [];
  for (let i = 0; i < source.length; i++) {
    const path = `$.renderedLogs.entries[${String(i)}]`;
    const entry = requireObject(source[i], path);
    entries.push({
      tick: requireNonNegativeInt(entry["tick"], `${path}.tick`),
      text: requireString(entry["text"], `${path}.text`),
    });
  }
  return {
    entries,
    foldedCount: requireNonNegativeInt(o["foldedCount"], "$.renderedLogs.foldedCount"),
  };
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

  return createGameState(
    meta,
    entities,
    deserializeRngState(root["rngState"]),
    deserializeBondByPairKey(root["bondByPairKey"]),
    deserializeTechMemoryByKey(root["techMemoryByKey"]),
    deserializeDispatchSnapshots(root["dispatchSnapshots"]),
    deserializeRenderedLogs(root["renderedLogs"]),
    deserializeOutpostsById(root["outpostsById"]),
    deserializeTerrain(root["terrain"]),
    deserializeProgression(root["progression"]),
    deserializeSelectedResearchId(root["selectedResearchId"]),
  );
}
