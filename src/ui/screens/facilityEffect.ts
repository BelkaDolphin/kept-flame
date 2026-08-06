// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 非稼働施設の正直表示(M61/FC6)
//
// ===========================================================================
// 1. 何が問題だったか(R1-A08 / R1-C02 / R1-D06)
// ===========================================================================
//   GDD 6.1 の 14 種のうち 4 種(寝床/保管庫/見張り台/療養所)は
//   `content/facility.json` の `slots` が全 Lv 0(= 就労スロットが無い)。
//   これらは③施設詳細で「産出0.00/tick・研究点」「就労0/0」と、あたかも
//   「本来は機能するが今は空き」であるかのように表示され、しかも有効な
//   「Lv2へ増築」ボタンで資源を払える(=資源トラップ)。
//
// ===========================================================================
// 2. 3種はそれぞれ違う扱いが要る(裁定記録・2026-08-02統率者検分で確定)
// ===========================================================================
//   **寝床**: `content/facility.json` の `bed` が `bedCapacityCurve` を持ち、
//   これは `schema/engineContent.ts` → `FacilityDef.bedCapacityByLevel` →
//   engine の `rules/population.ts` の
//   `bedCapacityOf`/`populationFloorOf`/晴天漂着判定(同ファイル §2)まで実際に
//   結線されている(確認済み・寝床上限が実際に人口下限と漂着加入の上限を
//   動かす)。「就労0/0」ではなく実効果(寝床上限 +N)を見せる。
//
//   **保管庫(warehouse)**: 当初「効果は未実装」表示で実装したが、統率者検分で
//   差し戻し(2026-08-02)。`storageCapacityCurve` が
//   `schema/engineContent.ts` の `toFacilityStorage` → `FacilityDef.storage` →
//   engine の `rules/storage.ts` の `resolveCapacityByResourceId`(125〜135行)
//   まで実際に結線されており、`storedResourceIds` が content に無い(= null)
//   ため **全資源**が対象になる。上限は産出反映時に効き(`rules/production.ts`
//   425行)、超過分は overflow 会計(廃材化/破棄)へ回る——既存在庫の没収では
//   ないが、プレイヤーにとってほぼ確実に不利益な効果になる。
//   **したがって「効果は未実装」は虚偽**であり、実効果(保管上限の設定 +
//   超過分喪失の警告)を正直に見せる。
//
//   **[2026-08-03/M63・R4-A01 fatal] 加算方式への追従**: GDD 6.7
//   [2026-08-02裁定] により保管上限は「基礎400(倉庫なし)+建っている倉庫の
//   Lv合計×400」の**加算**方式に確定した(`balance.storage.baseCapacity` 全
//   8資源400 + warehouse curve [400,800,1200,1600,2000])。旧文言
//   「上限を設定(Lv1: 400)」はこの倉庫**単体**の値がそのまま絶対上限になる
//   かのように読め、実際には基礎400にこの倉庫の寄与が**加算**される(倉庫が
//   複数あれば合算)ため虚偽表示だった(Round 4 実測で確認・fatal)。本ファイルは
//   `def`+`level` だけを引数に取る設計(state を持たない・カタログ/詳細どちらの
//   呼び出し元からも呼べる)なので、「現在の合計上限」までは計算せず、GDD の
//   加算式そのものを文言に明記したうえで「このLvの寄与」だけを数値で示す
//   (捏造しない・唯一の正本実装は `engine/rules/storage.ts` の
//   `resolveCapacityByResourceId` で、現在の合計値が要る画面はそちらを呼ぶこと)。
//   **在庫超過警告(`storageCapacityWouldCapExistingStock`)は撤去**した——
//   旧実装は「このLvの寄与(倉庫単体)」だけを上限とみなして現在庫と比べており、
//   加算方式のもとでは倉庫は上限を単調に押し上げるだけ(建てて上限が下がる
//   ことは無い)なので、この警告は「建てると不利益になる」という逆方向の
//   誤情報になっていた(Round 4 実測)。現在庫が実際に上限へ達しているか
//   どうかの継続的な警告は HUD/ホームアラート(`derived.ts` の `homeAlerts`・
//   M63 で追加)が state を見て正しく担う。
//
//   **見張り台/療養所**: `content/facility.json` にこの種の追加フィールドが
//   一切無く、engine 側の参照も確認できなかった(統率者側でも再確認済み)。
//   「効果は未実装(建設しても資源を消費するのみ)」のまま。
//   → **[M73/R8-02 fatal] この記述は M66 で無効になった**(下の §4)。
//
// ===========================================================================
// 3. [M62/FC9・R2-C01] カタログ効果ヒントの非対称の解消
// ===========================================================================
//   R2-C01: `GridScreen.tsx` の建設前ヒント(`effectHintByDefId`)は寝床/保管庫/
//   非稼働(見張り台・療養所)の 3 kind にしか文言を出さず、通常稼働(worker)系
//   施設だけヒントが無い非対称があった。`workerEffectHintText` は Lv1 時点の
//   基礎産出(隣接乗数・稼働就労者数を含まない近似値。カタログは建設前で盤面
//   位置が未定のため)を示す、対称な第4のヒント文言。
//
// ===========================================================================
// 4. [M73/R8-02 fatal] 見張り台 / 療養所の効果は M66 で実装済み
// ===========================================================================
//   §2 末尾の「見張り台/療養所は効果未実装」は **M66 で無効になった**のに、
//   本ファイルの `facilityEffectKind()` が 2 つの新フィールドを判定しないまま
//   だったため、両施設は 3 体一致・8 箇所で「効果は未実装(建設しても資源を
//   消費するのみ)」と表示され続けていた(Round 8 実測・虚偽表示)。
//   増築警告「効果が未実装のため増築しても効果は変わりません」も同根の虚偽で、
//   実際にはどちらの効果曲線も Lv 単調増加である(schema/facility.ts が
//   単調非減少を必須検証)。
//
//   **見張り台(`defenseCurve` → `FacilityDef.defenseByLevel`)**:
//   `engine/rules/raid.ts` の `colonyDefenseFix` が「防衛係数を持つ施設の
//   Lv 別値 ×(外周なら配置ボーナス)」を総和し、`resolveRaid` が
//   `Σ防衛戦力 + seededRoll >= 襲撃強度` で撃退を決める。よって実効果は
//   「襲撃への防衛戦力 + Lv 別の寄与」+「外周に置くと倍率が乗る」。
//
//   **療養所(`careCapacityCurve` → `FacilityDef.careCapacityByLevel`)**:
//   `engine/rules/care.ts` の `careCapacityOf` が Lv 別値を総和し、
//   `careRecipientsAt` が「その tick に想起困難中の生存住民を枠数まで」自動で
//   休養させる(配属コマンドは無い)。回復は `balance.care.restRecoveryTicks`
//   (発生からの経過)まで**短縮**され、抽選された持続がそれより短いときは
//   延ばさない。よって実効果は「同時に休養できる人数 + Lv 別の枠」+
//   「想起困難の住民が自動で休養して回復が早まる」。
//
//   **配置ボーナス倍率 / 休養までの時間は content 側(`balance.raid` /
//   `balance.care`)にある**が、本ファイルは `def`+`level` だけを引数に取る
//   設計(state/content 非依存)なので、§2「保管庫」の加算式のように文言へ
//   焼き込まず **呼び出し側から任意で渡す**形にした(渡されなければその一文を
//   出さない=捏造しない)。数値の正本は engine/content 側にあり複製しない。
// ---------------------------------------------------------------------------

import type { EngineContent, FacilityDef } from "../../engine/rules/types";
import { toApproxNumber } from "../../engine/fp";
import type { EntityId } from "../../engine/state/state";
import { resourceLabel } from "./contentLabels";
import {
  formatApproxDecimal1,
  formatRatePerMinute,
  formatResourceAmount,
  formatTickSpan,
} from "./format";

export type FacilityEffectKind =
  | "worker"
  | "bedCapacity"
  | "storageCapacity"
  /** [M73/R8-02] 見張り台(襲撃への防衛戦力・§4)。 */
  | "defense"
  /** [M73/R8-02] 療養所(想起困難の休養枠・§4)。 */
  | "careCapacity"
  | "none";

function hasAnyWorkerSlot(def: FacilityDef): boolean {
  return (def.workerSlotsByLevel ?? []).some((count) => count > 0);
}

/**
 * 施設が「就労で稼働する」「寝床上限を持つ」「保管上限を持つ」
 * 「どれでもない(未実装)」のどれかを判定する(§2)。カタログ(建設前・Lv情報
 * なし)と詳細(建設後)のどちらからも呼べるよう、`FacilityDef` だけを見る
 * (state に依存しない)。
 */
export function facilityEffectKind(def: FacilityDef): FacilityEffectKind {
  if (hasAnyWorkerSlot(def)) return "worker";
  if (def.bedCapacityByLevel !== undefined) return "bedCapacity";
  if (def.storage !== undefined) return "storageCapacity";
  // [M73/R8-02] M66 で実効化された 2 種(§4)。宣言順は「既存 3 種を 1 bit も
  // 動かさない」ことを優先して末尾へ足す(寝床/保管庫と両立する定義は現行
  // content に無いので、判定順が表示を変えることは実際には起きない)。
  if (def.defenseByLevel !== undefined) return "defense";
  if (def.careCapacityByLevel !== undefined) return "careCapacity";
  return "none";
}

/** `level`(1始まり)時点の寝床上限(`bedCapacityByLevel` が無ければ null)。 */
export function bedCapacityAt(def: FacilityDef, level: number): number | null {
  const curve = def.bedCapacityByLevel;
  if (curve === undefined || curve.length === 0) return null;
  return curve[level - 1] ?? curve[curve.length - 1] ?? null;
}

/** 寝床のカタログ/詳細向け効果文言(Lv省略時はLv1として見せる)。 */
export function bedCapacityEffectText(def: FacilityDef, level = 1): string | null {
  const value = bedCapacityAt(def, level);
  if (value === null) return null;
  return `寝床上限 +${String(value)}(住民の漂着加入の上限を増やす)`;
}

/** `level`(1始まり)時点の保管上限(近似値。`storage` が無ければ null)。 */
export function storageCapacityAt(def: FacilityDef, level: number): number | null {
  const curve = def.storage?.capacityByLevel;
  if (curve === undefined || curve.length === 0) return null;
  const fix = curve[level - 1] ?? curve[curve.length - 1];
  return fix === undefined ? null : toApproxNumber(fix);
}

/** 保管上限の対象資源(`storedResourceIds` が無ければ全資源=null)。 */
export function storageTargetResourceIds(def: FacilityDef): readonly EntityId[] | null {
  return def.storage?.resourceIds ?? null;
}

/**
 * 保管庫のカタログ/詳細向け効果文言(§2「保管庫」)。「効果は未実装」ではなく
 * 実効果を正直に見せる。
 *
 * **[M63/R4-A01 fatal] 加算方式(GDD 6.7 [2026-08-02裁定])に合わせた文言**:
 * 「上限を設定(Lv1: 400)」(この倉庫単体の値がそのまま絶対上限であるかの
 * ような書き方)は虚偽——実際は基礎400にこの倉庫の寄与が**加算**される
 * (倉庫を複数建てれば合算)。本関数は `def`+`level` しか持たない(state 非依存)
 * ため「現在の合計上限」は計算せず、加算式そのものと「このLvの寄与」だけを
 * 明記する。超過分の扱いも「原則失われる。ただし薪など一部の低次資源は
 * 一定比率が廃材になる」と GDD 6.7 の記述どおりに正直化する(旧文言の
 * 「上限を超えた分の産出は失われます」という全資源一律の断定は、実際には
 * firewood にしか廃材化(比0.5)が設定されておらず不正確だった)。
 */
export function storageCapacityEffectText(def: FacilityDef, level = 1): string | null {
  const value = storageCapacityAt(def, level);
  if (value === null) return null;
  const scope = storageTargetResourceIds(def) === null ? "全資源" : "対象資源";
  return (
    `${scope}の保管上限に加算(基礎400 + 建っている保管庫のLv合計×400)。` +
    `このLv${String(level)}の寄与は +${formatResourceAmount(value)}。` +
    `上限を超えた産出は原則失われます(薪など一部の低次資源は超過分の一定比率が廃材になります)。`
  );
}

/**
 * [M73/R8-02] `level`(1始まり)時点の防衛係数(`defenseByLevel` が無ければ null)。
 * 「配列より大きい Lv は最後の段」規約は `bedCapacityAt` と同じ。
 */
export function defenseAt(def: FacilityDef, level: number): number | null {
  const curve = def.defenseByLevel;
  if (curve === undefined || curve.length === 0) return null;
  const fix = curve[level - 1] ?? curve[curve.length - 1];
  return fix === undefined ? null : toApproxNumber(fix);
}

/**
 * [M73/R8-02] 見張り台のカタログ/詳細向け効果文言(§4)。
 *
 * `perimeterMulApprox` は外周セルに置いたときの配置ボーナス倍率
 * (`balance.raid.perimeterDefenseMul`)。**呼び出し側が content から渡す**
 * (省略/null ならその一文を出さない=数値を捏造しない・§4 末尾)。
 */
export function defenseEffectText(
  def: FacilityDef,
  level = 1,
  perimeterMulApprox: number | null = null,
): string | null {
  const value = defenseAt(def, level);
  if (value === null) return null;
  const perimeter =
    perimeterMulApprox === null || perimeterMulApprox <= 1
      ? "格子の外周(縁)に置くと寄与が上がります。"
      : `格子の外周(縁)に置くと寄与が${formatApproxDecimal1(perimeterMulApprox)}倍になります。`;
  return (
    `襲撃に対する防衛戦力に加算(このLv${String(level)}の寄与は +${formatResourceAmount(value)})。` +
    `${perimeter}防衛戦力が襲撃の強さを上回れば撃退でき、届かなければ蓄えの一部を奪われます。` +
    `増築すると寄与が増えます。`
  );
}

/**
 * [M73/R8-02] `level`(1始まり)時点の休養枠(`careCapacityByLevel` が無ければ null)。
 */
export function careCapacityAt(def: FacilityDef, level: number): number | null {
  const curve = def.careCapacityByLevel;
  if (curve === undefined || curve.length === 0) return null;
  return curve[level - 1] ?? curve[curve.length - 1] ?? null;
}

/**
 * [M73/R8-02] 療養所のカタログ/詳細向け効果文言(§4)。
 *
 * `restRecoveryText` は「休養で回復するまでの時間」の**整形済み**文言
 * (`balance.care.restRecoveryTicks` を `formatTickSpan` に通したもの)。
 * 呼び出し側が content から渡す(省略/null ならその一文を出さない)。
 */
export function careCapacityEffectText(
  def: FacilityDef,
  level = 1,
  restRecoveryText: string | null = null,
): string | null {
  const value = careCapacityAt(def, level);
  if (value === null) return null;
  const recovery =
    restRecoveryText === null
      ? "回復までの時間が短くなります。"
      : `休養に入ると${restRecoveryText}で回復します(それより早く回復する見込みのときは短い方が優先されます)。`;
  return (
    `同時に休養できる枠(このLv${String(level)}の枠は ${String(value)}人)。` +
    `想起困難の住民が枠の空いている範囲で自動的に休養します(配属の操作は不要)。${recovery}` +
    `枠が足りないときは一部の住民だけが休養します。増築すると枠が増えます。`
  );
}

/** 効果未実装の施設に添える固定文言(現行 content には該当なし・§2/§4)。 */
export const DORMANT_FACILITY_EFFECT_TEXT = "効果は未実装(建設しても資源を消費するのみ)";

/**
 * [M73/R8-02] 効果文言のうち **content 側にしか無い係数**(§4 末尾)。
 * `def`+`level` からは分からないので呼び出し側が渡す。null は「渡されなかった」
 * = その一文を出さない(捏造しない)。
 */
export interface FacilityEffectExtras {
  /** 外周配置ボーナス倍率(`balance.raid.perimeterDefenseMul`)。 */
  readonly perimeterDefenseMulApprox: number | null;
  /** 休養で回復するまでの整形済み時間(`balance.care.restRecoveryTicks`)。 */
  readonly restRecoveryText: string | null;
}

/** 係数を 1 つも持たない既定値(content に raid/care ブロックが無い盤面)。 */
export const NO_FACILITY_EFFECT_EXTRAS: FacilityEffectExtras = {
  perimeterDefenseMulApprox: null,
  restRecoveryText: null,
};

/** [M73/R8-02] content から {@link FacilityEffectExtras} を取り出す(判定は無い)。 */
export function facilityEffectExtrasOf(content: EngineContent): FacilityEffectExtras {
  const raid = content.raid;
  const care = content.care;
  return {
    perimeterDefenseMulApprox:
      raid === undefined ? null : toApproxNumber(raid.perimeterDefenseMulFix),
    restRecoveryText: care === undefined ? null : formatTickSpan(care.restRecoveryTicks),
  };
}

/**
 * [M73/R8-02] 種別に応じた効果文言の単一入口(②カタログと③施設詳細が同じ文言を
 * 見せるための集約点)。種別ごとの分岐を画面側で 2 度書かないためのもので、
 * 個別の文言関数はそのまま公開したまま(既存呼び出し元との後方互換)。
 */
export function facilityEffectTextOf(
  def: FacilityDef,
  level: number,
  extras: FacilityEffectExtras = NO_FACILITY_EFFECT_EXTRAS,
): string | null {
  const kind = facilityEffectKind(def);
  switch (kind) {
    case "worker":
      return workerEffectHintText(def, level);
    case "bedCapacity":
      return bedCapacityEffectText(def, level);
    case "storageCapacity":
      return storageCapacityEffectText(def, level);
    case "defense":
      return defenseEffectText(def, level, extras.perimeterDefenseMulApprox);
    case "careCapacity":
      return careCapacityEffectText(def, level, extras.restRecoveryText);
    case "none":
      return DORMANT_FACILITY_EFFECT_TEXT;
    default: {
      const unhandled: never = kind;
      throw new TypeError(`未知の施設効果種別 ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * [M62/FC9・R2-C01] `level`(1始まり)時点の基礎産出(`outputPerTickByLevel` の
 * その段。隣接乗数・稼働就労者数は含まない近似値・`bedCapacityAt` と同じ
 * 「配列より大きい Lv は最後の段」規約)。基礎産出を持たない(=配列が空の
 * 縮約 `FacilityDef`)場合は null。
 */
export function workerBaseOutputAt(def: FacilityDef, level: number): number | null {
  const curve = def.outputPerTickByLevel;
  if (curve.length === 0) return null;
  const fix = curve[level - 1] ?? curve[curve.length - 1];
  return fix === undefined ? null : toApproxNumber(fix);
}

/**
 * worker系(通常稼働)施設のカタログ/詳細向け効果ヒント(§3)。寝床/保管庫/
 * 非稼働(§2)と対称に、建設前でも「何を産出するか」の目安を示す。
 *
 * 基礎産出が 0(=このタグでは実質稼働しない縮約施設等)なら null(捏造しない・
 * `nextLevelOutputApproxOf` の「基礎産出0は出さない」判断と同じ立場)。
 */
export function workerEffectHintText(def: FacilityDef, level = 1): string | null {
  const value = workerBaseOutputAt(def, level);
  if (value === null || value === 0) return null;
  const target = def.output.kind === "resource" ? resourceLabel(def.output.resourceId) : "研究点";
  return `Lv${String(level)}基礎産出 ${formatRatePerMinute(value)}${target}(就労者が必要・隣接ボーナスで変動)`;
}
