// ---------------------------------------------------------------------------
// セーブのマイグレーション連鎖 — M3 / ADR-012(裁定 B2/B3/B4)/ ADR「バージョニング / マイグレーション(3軸)」
//
// ===========================================================================
// 0. 2 つの版軸(このモジュールが扱うのはこの 2 つだけ)
// ===========================================================================
//   (i)  **エンベロープ版** `saveFormatVersion` — IDB に入る値そのものの形。
//        v0 = エンベロープ化以前の「生 payload 文書」、v1 = 裁定 B2 の
//        `{saveFormatVersion, integrityChecksum, payload}`。
//        適用位置: `objectStore.get` の直後、**checksum 検証の前**。
//        (v0 セーブは envelope の checksum を持たないので、検証より前に
//         包み直さないと必ず PersistenceError になる)
//
//   (ii) **セーブスキーマ版** `saveSchemaVersion` — payload の中身の形
//        (ADR 3軸(a))。適用位置: `JSON.parse` の直後、`fromSerializable` の前
//        (`persistence.ts` §5(d) が予約していた位置)。
//
//   ADR 3軸の残り 2 つ((b) contentVersion 差 = 未知 ID のグレースフル無視 /
//   tombstone 救済、(c) algoVersion 差 = 旧版バンドルでの計算)は**本モジュールの
//   担当ではない**。(b) は content ロード側、(c) は ADR-025 の退役ビルド運用であり、
//   どちらもセーブの**形**を変換する話ではないため、ここへ混ぜると
//   「マイグレーション = 形の変換」という不変条件が崩れる。
//
// ===========================================================================
// 1. マイグレーション段の規律(ここを外すと連鎖が壊れる)
// ===========================================================================
//   (a) **純関数**。IDB にも時刻にも触れない(だから vitest で直接叩ける)。
//   (b) **1 段 = +1 版**。`from + 1 === to` を満たさない段は登録時に拒否する。
//       欠番があると「どの版から来たか」で経路が分岐し、組合せが爆発する。
//   (c) **構造の変換だけを行い、意味を解釈しない**。段の中で `fromSerializable`
//       を呼んではならない。それは「現行スキーマの目」で旧セーブを読むことに
//       なり、将来 saveSchemaVersion が上がった瞬間に旧セーブの v0→v1 段が
//       壊れる(v0 セーブは古いスキーマのまま v1 へ包まれるべきで、スキーマの
//       前進は (ii) の軸が担当する)。
//   (d) **未来版は変換しない**。現行より新しい版のセーブは「読めない」であって
//       「直せる」ではない。(i) は未変換のまま返し、呼び出し側の
//       `verifySaveRecord` に版不一致として拒否させる。(ii) は自分で拒否する。
//
// ===========================================================================
// 2. v0(エンベロープ化以前)の定義 — 何を「旧形式」と呼ぶか
// ===========================================================================
//   ADR「セーブフォーマット」節の**旧記述**そのもの、すなわち
//   `integrityChecksum` を `entityStateById` と同階層に持つ 1 枚の文書である。
//   裁定 B2/B3/B4 で 3 点が変わったので、v0→v1 段はその 3 点をそのまま実装する:
//
//     B2: `integrityChecksum` を落とす(エンベロープ側へ移動。チェックサムは
//         自分自身を含む文書を覆えないため、payload には残せない)
//     B3: `eventQueueSnapshot` を落とす(state から全再構成可能であり、
//         残すと state と queue が二重の真実になる)
//     B4: `rngState` が空オブジェクトならキーごと落とす(空 ⇔ キー不在 の
//         1 対 1 対応が正準形。`toSerializable` と同じ規約)
//
//   それ以外のキーは**触らない**。v0 セーブが持っていた未知キーを捨てるのは
//   (c) の「意味を解釈しない」に反する(現行 `fromSerializable` は名指しで
//   読むので、余分なキーがあっても復元結果は変わらない)。
//
// ===========================================================================
// 3. 出力が「現行ビルドが書いたセーブとバイト同一」になる理由
// ===========================================================================
//   v0→v1 段は落としたあとの文書を `canonicalizeJson`(engine の正準化パス)へ
//   通してから `JSON.stringify` する。`toSerializable` も最後に同じ関数を通す
//   ので、同じ内容なら**キー順まで同一の文字列**が出る。よって
//   「旧セーブを migrate した payload」と「同じ state を encode した payload」は
//   バイト同一になり、checksum も一致する(tests/platform/migration.test.ts)。
// ---------------------------------------------------------------------------

import { canonicalizeJson } from "../engine/canonicalize";
import { fnv1a32 } from "../engine/rng/fnv1a32";

/**
 * マイグレーション連鎖の失敗(未知のセーブ形・欠番の版・未来版)。
 *
 * `catchUp.ts` の `CatchUpError` と同じく platform モジュール固有の Error
 * サブクラスである(層で 1 つの基底に寄せていない = 既存の流儀)。
 */
export class SaveMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveMigrationError";
  }
}

// --- 1. 連鎖の骨組み(2 軸で共有する) --------------------------------------

/** 1 段 = ある版から次の版への純粋な形の変換。 */
export interface SaveMigrationStep {
  /** 入力の版。 */
  readonly from: number;
  /** 出力の版。必ず `from + 1`。 */
  readonly to: number;
  /** 何をした段かの 1 行説明(結果に載せて呼び出し側がログに出せる)。 */
  readonly summary: string;
  /** 形の変換本体。入力は検証前の未知の値。 */
  migrate(value: unknown): unknown;
}

/** 連鎖の実行結果。 */
export interface SaveMigrationResult {
  /** 変換後の値(現行版。未検証であることに注意)。 */
  readonly value: unknown;
  /** 入力が名乗っていた版。 */
  readonly fromVersion: number;
  /** 適用した段の `summary`(1 段も適用しなければ空配列)。 */
  readonly appliedSteps: readonly string[];
}

/**
 * 段の一覧が「`from` 昇順・欠番なし・`from + 1 === to`」であることを検査する
 * (§1(b))。モジュール読み込み時に一度だけ走らせ、登録ミスを即座に落とす
 * (`domainTags.ts` の `assertUniqueDomainTags` と同じ流儀)。
 *
 * @throws {SaveMigrationError} 連鎖が繋がっていない場合
 */
export function assertMigrationChain(
  steps: readonly SaveMigrationStep[],
  targetVersion: number,
  axis: string,
): void {
  let expected = targetVersion - steps.length;
  if (expected < 0) {
    throw new SaveMigrationError(`${axis}: 段が多すぎる(現行版 ${String(targetVersion)})`);
  }
  for (const step of steps) {
    if (step.from !== expected || step.to !== expected + 1) {
      throw new SaveMigrationError(
        `${axis}: 段は 1 版ずつ連続していること(期待 ${String(expected)}→${String(expected + 1)} / 実際 ${String(step.from)}→${String(step.to)})`,
      );
    }
    expected += 1;
  }
}

function runMigrationChain(
  steps: readonly SaveMigrationStep[],
  fromVersion: number,
  targetVersion: number,
  value: unknown,
  axis: string,
): SaveMigrationResult {
  const applied: string[] = [];
  let current = value;
  let version = fromVersion;
  while (version < targetVersion) {
    const step = steps.find((candidate) => candidate.from === version);
    if (step === undefined) {
      throw new SaveMigrationError(
        `${axis}: 版 ${String(version)} から現行版 ${String(targetVersion)} への移行経路が無い`,
      );
    }
    current = step.migrate(current);
    applied.push(step.summary);
    version = step.to;
  }
  return { value: current, fromVersion, appliedSteps: applied };
}

// --- 2. 共通の小道具 --------------------------------------------------------

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "配列";
  return typeof value;
}

/** 版番号として読める値(0 以上の安全整数)だけを通す。 */
function readVersion(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SaveMigrationError(
      `${what} が 0 以上の整数でない(実際: ${typeof value === "number" ? String(value) : describe(value)})`,
    );
  }
  return value;
}

// --- 3. 軸 (i): エンベロープ版 ---------------------------------------------

/** エンベロープ化以前(裁定 B2 前)の生 payload 文書を指す版番号。 */
export const LEGACY_ENVELOPE_VERSION = 0;

/**
 * v0→v1 で payload 文書から落とすキー(§2)。
 * `rngState` は「空のときだけ落とす」ので別扱い(下記)。
 */
const LEGACY_DROPPED_KEYS: readonly string[] = [
  // 裁定 B2: チェックサムはエンベロープ側へ移動した。
  "integrityChecksum",
  // 裁定 B3: イベントキューはセーブに持たない(scheduler.buildEventQueue が単一の真実)。
  "eventQueueSnapshot",
];

function isEmptyPlainObject(value: unknown): boolean {
  return isRecordObject(value) && Object.keys(value).length === 0;
}

/**
 * v0 の生 payload 文書を裁定 B2 のエンベロープへ包み直す。
 *
 * 落とすもの 3 点(B2/B3/B4)は §2 に、出力がバイト同一になる理由は §3 にある。
 */
const migrateEnvelopeV0ToV1: SaveMigrationStep = {
  from: 0,
  to: 1,
  summary:
    "エンベロープ化以前の生 payload 文書を {saveFormatVersion, integrityChecksum, payload} へ包み直し、" +
    "integrityChecksum(B2)/ eventQueueSnapshot(B3)/ 空の rngState(B4)を落とす",
  migrate(value: unknown): unknown {
    if (!isRecordObject(value)) {
      throw new SaveMigrationError(`旧形式セーブがオブジェクトでない(実際: ${describe(value)})`);
    }
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (LEGACY_DROPPED_KEYS.includes(key)) continue;
      // 裁定 B4: 空の rngState は「空オブジェクトを書く」ではなく「書かない」が正準形。
      if (key === "rngState" && isEmptyPlainObject(value[key])) continue;
      kept[key] = value[key];
    }
    // canonicalizeJson は JSON で表現できない値(undefined / function / Map …)を
    // ここで reject する = 壊れた旧セーブを黙って通さない入口にもなっている。
    const payload = JSON.stringify(canonicalizeJson(kept));
    return {
      saveFormatVersion: 1,
      // `persistence.computeIntegrityChecksum` と同一の関数。循環 import を
      // 避けるため engine の実装を直接呼ぶ(等価性はテストで固定してある)。
      integrityChecksum: fnv1a32(payload),
      payload,
    };
  },
};

/** エンベロープ版の連鎖(`from` 昇順)。 */
export const ENVELOPE_MIGRATIONS: readonly SaveMigrationStep[] = [migrateEnvelopeV0ToV1];

/**
 * 現行のエンベロープ版 = 連鎖の終端。`persistence.ts` はこの値を
 * `SAVE_FORMAT_VERSION` として再輸出する(定義が 2 箇所に分かれてずれるのを防ぐ)。
 */
export const SAVE_FORMAT_VERSION =
  ENVELOPE_MIGRATIONS[ENVELOPE_MIGRATIONS.length - 1]?.to ?? LEGACY_ENVELOPE_VERSION;

assertMigrationChain(ENVELOPE_MIGRATIONS, SAVE_FORMAT_VERSION, "saveFormatVersion");

/**
 * IDB から出てきた値が名乗っている**エンベロープ版**を判定する。
 *
 * `saveFormatVersion` を持たない値は、payload 文書の目印である
 * `entityStateById` を持つときに限り v0(エンベロープ化以前)と解釈する。
 * 目印が無ければ「未知の形」であって v0 ではない(何でも v0 と見なすと、
 * 別アプリのレコードや壊れた値を migrate しようとしてしまう)。
 *
 * @throws {SaveMigrationError} オブジェクトでない / 版が整数でない / 目印が無い
 */
export function detectSaveFormatVersion(stored: unknown): number {
  if (!isRecordObject(stored)) {
    throw new SaveMigrationError(`セーブレコードがオブジェクトでない(実際: ${describe(stored)})`);
  }
  if ("saveFormatVersion" in stored) {
    return readVersion(stored["saveFormatVersion"], "saveFormatVersion");
  }
  if ("entityStateById" in stored) {
    return LEGACY_ENVELOPE_VERSION;
  }
  throw new SaveMigrationError(
    "セーブの形が判別できない(saveFormatVersion も entityStateById も無い)",
  );
}

/**
 * IDB から出てきた値を現行のエンベロープ版へ引き上げる。
 * **checksum 検証の前**に呼ぶこと(§0(i))。
 *
 * 現行版のレコードは 1 段も適用せずそのまま返す(版の読み取り 1 回だけ =
 * B2 区間へ載る追加コストは定数)。未来版も**変換せずに返し**、版不一致の
 * 拒否は呼び出し側の `verifySaveRecord` に委ねる(§1(d))。
 *
 * @throws {SaveMigrationError} 形が判別できない / 経路が無い場合
 */
export function migrateStoredSave(stored: unknown): SaveMigrationResult {
  const fromVersion = detectSaveFormatVersion(stored);
  if (fromVersion >= SAVE_FORMAT_VERSION) {
    return { value: stored, fromVersion, appliedSteps: [] };
  }
  return runMigrationChain(
    ENVELOPE_MIGRATIONS,
    fromVersion,
    SAVE_FORMAT_VERSION,
    stored,
    "saveFormatVersion",
  );
}

// --- 4. 軸 (ii): セーブスキーマ版 -------------------------------------------

/**
 * payload の中身の版(ADR 3軸(a))。現行 = 5([M52] 地形/瓦礫の導入)。
 *
 * `tests/engine/fixtures.ts` の `META.saveSchemaVersion` はこの値と一致させてある
 * (= 現行ビルドが書くセーブの形)。
 *
 * **`conformance/scenarios.ts` の `baseMeta()` は 1 のまま**である。golden vector は
 * 「過去に採った観測値」であって現行ビルドのセーブではなく、メタ 3 軸を固定
 * リテラルにしてあるのは意図(golden-vector-spec §3.4)だからである。結果として
 * 40 本のベクタは **v1 セーブの実物corpus**として機能し、v1→v2 の移行が壊れれば
 * それらを読む経路のテストが落ちる。
 */
export const SAVE_SCHEMA_VERSION = 5;

/**
 * [M16] v1 → v2: facility の `footprint`(GDD 6.1 の 2×1 / 2×2)導入。
 *
 * **構造の変換は無く、版だけを進める**。v1 のセーブは全施設が 1×1 であり、v2 では
 * 1×1 は `footprint` キーを持たない正準形(serialize.ts §7)だからで、
 * 「v1 の payload をそのまま v2 として読む」と現行挙動に厳密一致する。
 *
 * それでも版を上げる理由は**旧ビルドに新セーブを読ませない**ことである:
 * `fromSerializable` は entity の未知フィールドを読み飛ばす(serialize.ts §2)ので、
 * v1 ビルドが v2 のセーブを読むと 2×2 の施設が**黙って 1×1 になる**
 * ——盤面が別物になり、隣接乗数も産出も静かにずれる。`migrateSavePayload` の
 * 未来版拒否(§1(d))が働くのは payload の `saveSchemaVersion` が現行より大きい
 * ときだけなので、この版差が無いと旧ビルドはその静かな縮退を検出できない。
 *
 * 版フィールドを書き換えるのは §1(c) の「意味を解釈しない」に反しない(v0→v1 段が
 * `saveFormatVersion: 1` を立てるのと同じ)。書き換えないと復元後の state が
 * v1 を名乗り続け、保存し直しても永久に v1 のままになる。
 */
const migratePayloadV1ToV2: SaveMigrationStep = {
  from: 1,
  to: 2,
  summary:
    "facility の footprint(GDD 6.1 の 2×1 / 2×2)を導入。v1 の全施設は 1×1 = v2 の既定値" +
    "(キー省略)なので構造変換は無く、saveSchemaVersion のみ 2 へ進める",
  migrate(value: unknown): unknown {
    if (!isRecordObject(value)) {
      throw new SaveMigrationError(`v1 の payload がオブジェクトでない(実際: ${describe(value)})`);
    }
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      next[key] = value[key];
    }
    next["saveSchemaVersion"] = 2;
    return next;
  },
};

/**
 * [M21] v2 → v3: 探索(`dispatchSnapshots`)と帰還ログ(`renderedLogs`)の導入。
 *
 * v1→v2 と同じく**構造の変換は無く、版だけを進める**(v2 のセーブは派遣を 1 件も
 * 持たず、v3 では空のとき両キーとも省略が正準形・serialize.ts §9)。
 *
 * それでも版を上げる理由は M16 と同じ **旧ビルドに新セーブを読ませない**ことで
 * ある。`fromSerializable` はトップレベルの未知キーを読み飛ばすので、v2 ビルドが
 * v3 のセーブを読むと:
 *   (a) 未帰還の派遣が**黙って消える**(報酬も脱落も永久に来ない)
 *   (b) 派遣中の住民は `dispatched: true` のまま**永久に帰ってこない**
 *       (帰還イベントを積む材料が state から消えるため = 就労も再派遣も不可)
 * という静かな破壊が起きる。「旧ビルドで読んだとき黙って壊れるか」という
 * ADR-012 [2026-07-30追記] の線引きに照らして、これは版差で塞ぐ側である。
 */
const migratePayloadV2ToV3: SaveMigrationStep = {
  from: 2,
  to: 3,
  summary:
    "探索(dispatchSnapshots)と帰還ログ(renderedLogs)を導入。v2 のセーブは" +
    "どちらも空 = v3 の既定値(キー省略)なので構造変換は無く、saveSchemaVersion のみ 3 へ進める",
  migrate(value: unknown): unknown {
    if (!isRecordObject(value)) {
      throw new SaveMigrationError(`v2 の payload がオブジェクトでない(実際: ${describe(value)})`);
    }
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      next[key] = value[key];
    }
    next["saveSchemaVersion"] = 3;
    return next;
  },
};

/**
 * [M22] v3 → v4: event ランタイム(`dispatchSnapshots[].resolvedTree.choices[]` の
 * `effects` / `choiceIndex` / `branchIndex` / `logText` と `eventId`)の導入。
 *
 * v1→v2 / v2→v3 と同じく**構造の変換は無く、版だけを進める**(v3 のセーブは
 * event content 由来のノードを 1 つも持たず、v4 では全キーとも省略が正準形・
 * serialize.ts §9)。
 *
 * それでも版を上げる理由は同じ **旧ビルドに新セーブを読ませない**ことである。
 * `fromSerializable` はノードの未知フィールドを読み飛ばすので、v3 ビルドが v4 の
 * セーブを読むと **`effects`(`destroyRecords` 等)が黙って消える** ——
 * 帰還時に燃えるはずの記録が燃えず、成文化状態と (B) 喪失が静かに食い違う。
 * `logText` の脱落も帰還ログの本文が変わる(GDD 8.4 の完成文字列保存の破れ)。
 * ADR-012 [2026-07-30追記] の線引き(「旧ビルドで読んだとき黙って壊れるか」)に
 * 照らして版差で塞ぐ側である。
 */
const migratePayloadV3ToV4: SaveMigrationStep = {
  from: 3,
  to: 4,
  summary:
    "event ランタイム(派遣ノードの effects / choiceIndex / branchIndex / logText と eventId)を" +
    "導入。v3 のセーブは event 由来ノードを持たず = v4 の既定値(キー省略)なので構造変換は無く、" +
    "saveSchemaVersion のみ 4 へ進める",
  migrate(value: unknown): unknown {
    if (!isRecordObject(value)) {
      throw new SaveMigrationError(`v3 の payload がオブジェクトでない(実際: ${describe(value)})`);
    }
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      next[key] = value[key];
    }
    next["saveSchemaVersion"] = 4;
    return next;
  },
};

/**
 * [M52] v4 → v5: 地形 / 瓦礫(payload の `terrain`)の導入。
 *
 * これまでの 3 段と同じく**構造の変換は無く、版だけを進める**(v4 のセーブは
 * 瓦礫を 1 枚も持たず、v5 では「瓦礫ゼロ かつ 解放数 0」はキー省略が正準形・
 * serialize.ts §10)。これが M52 検収条件「旧セーブが**全セル開墾済み**として
 * 無損失ロードされる」の migration 側の実装である。
 *
 * **bump 要否の判断(ADR-012 [2026-07-30追記] の線引きへの当てはめ)**
 *
 * 線引きは「省略可フィールドでも、旧ビルドが新セーブを読むと**黙って壊れる**類の
 * 変更は版差で塞ぐ」。両論を検討した結果、**塞ぐ側**と判断した。
 *
 *   (a) bump 不要側の論拠 — `terrain` が落ちても state は壊れない。瓦礫が消えて
 *       「全セル開墾済み」になるだけで、例外も矛盾も起きず、UI も普通に動く。
 *       M22 の `effects`(燃えるはずの記録が燃えない = 明白な機能欠落)とは
 *       違って、失われるのは**制約**であって機能ではない。
 *   (b) bump 必要側の論拠(採用) — 3 つある。
 *       ① **静かにルールが緩む**: 旧ビルドでは瓦礫の上に施設が建つ。盤面の
 *         広さが変わる = 産出も隣接乗数も別ゲームになる。M16 の footprint 脱落
 *         (2×2 が黙って 1×1 になる)と**同じ「盤面幾何が黙って変わる」類**で
 *         あり、あちらを版差で塞いだ以上こちらも塞ぐのが一貫している。
 *       ② **書き戻しで不可逆に失われる**: 旧ビルドが読んで保存し直すと、瓦礫の
 *         配置も解放数も永久に消える。読むだけで壊れないなら受容できるが、
 *         `fromSerializable` → `toSerializable` の往復で落ちるフィールドは
 *         セーブの破壊であり、これは M21 の未帰還派遣の脱落と同型である。
 *       ③ **経済の exploit になる**: `reclaimedCount` が消えるとコスト式
 *         `base × 1.15^解放数` の指数が 0 に戻る = 開墾コストが base まで
 *         下がる。旧ビルドと新ビルドを往復させるだけで最安値の開墾を無限に
 *         繰り返せる。
 *   決め手は ②③ で、①だけなら「制約が緩むだけ」と見る余地があるが、
 *   往復でデータが消えて経済が壊れる以上「読めない」を明示する版差が要る。
 */
const migratePayloadV4ToV5: SaveMigrationStep = {
  from: 4,
  to: 5,
  summary:
    "地形 / 瓦礫(terrain)を導入。v4 のセーブは瓦礫ゼロ = v5 の既定値(キー省略)" +
    "なので構造変換は無く、saveSchemaVersion のみ 5 へ進める",
  migrate(value: unknown): unknown {
    if (!isRecordObject(value)) {
      throw new SaveMigrationError(`v4 の payload がオブジェクトでない(実際: ${describe(value)})`);
    }
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      next[key] = value[key];
    }
    next["saveSchemaVersion"] = 5;
    return next;
  },
};

/**
 * セーブスキーマ版の連鎖(`from` 昇順)。
 *
 * 段を足すときは `{from: N, to: N+1, migrate}` を末尾へ追加し
 * {@link SAVE_SCHEMA_VERSION} を +1 するだけでよい(§1(b) の検査が自動で効く)。
 */
export const PAYLOAD_MIGRATIONS: readonly SaveMigrationStep[] = [
  migratePayloadV1ToV2,
  migratePayloadV2ToV3,
  migratePayloadV3ToV4,
  migratePayloadV4ToV5,
];

assertMigrationChain(PAYLOAD_MIGRATIONS, SAVE_SCHEMA_VERSION, "saveSchemaVersion");

/**
 * `JSON.parse` 済みの payload を現行のセーブスキーマ版へ引き上げる。
 * `fromSerializable` の**直前**に呼ぶこと(§0(ii))。
 *
 * 現行より新しい版は**ここで拒否する**。`fromSerializable` は
 * `saveSchemaVersion` を「0 以上の整数」としか見ないので、未来のセーブを
 * 現行スキーマの目で読んで部分的に成功してしまう経路をここで塞ぐ。
 *
 * @throws {SaveMigrationError} 版が読めない / 未来版 / 経路が無い場合
 */
export function migrateSavePayload(parsed: unknown): SaveMigrationResult {
  if (!isRecordObject(parsed)) {
    throw new SaveMigrationError(`payload がオブジェクトでない(実際: ${describe(parsed)})`);
  }
  const fromVersion = readVersion(parsed["saveSchemaVersion"], "payload の saveSchemaVersion");
  if (fromVersion > SAVE_SCHEMA_VERSION) {
    throw new SaveMigrationError(
      `セーブのスキーマ版 ${String(fromVersion)} は現行ビルド(${String(SAVE_SCHEMA_VERSION)})より新しい。` +
        `新しいビルドで作られたセーブは現行ビルドでは読めない(ADR-025)`,
    );
  }
  if (fromVersion === SAVE_SCHEMA_VERSION) {
    return { value: parsed, fromVersion, appliedSteps: [] };
  }
  return runMigrationChain(
    PAYLOAD_MIGRATIONS,
    fromVersion,
    SAVE_SCHEMA_VERSION,
    parsed,
    "saveSchemaVersion",
  );
}
