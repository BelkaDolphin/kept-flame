// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ④住民一覧・配置(M30)— GDD 7.1〜7.6 / 11.2
//
// ===========================================================================
// 1. このファイルがやること
// ===========================================================================
//   住民リスト(ステータス5種・trait・想起困難/派遣中/死亡tombstoneの状態表示)
//   と、施設就労スロットへの割当/解除(`assignResident`/`unassignResident`)。
//
// ===========================================================================
// 2. ソートは決定論(タスク指示どおり)
// ===========================================================================
//   `store.derived.residents`/`facilityRoster` は engine の `entitiesOfKind`
//   が返す ID 昇順(state.ts §3(a))をそのまま使う——画面側で並べ替えない
//   (derived.ts に独自ソートを書くと二重の正準順になり得るため)。
//
// ===========================================================================
// 3. 判定は書かない(architecture.md §6 の7箇条目)
// ===========================================================================
//   死亡/派遣中の住民でも就労先セレクトは活性のままにする——選んで送れば
//   engine の `residentUnavailable` reject が返るので、そこで初めて理由を
//   知らせる(バッジで状態を先に見せているので二度手間には見えるが、
//   「押せない理由を UI が判定して隠す」を避ける一貫性を優先する)。
//
//   **[M73/R8-12] 死亡だけは例外にする(規律側を優先したうえでの線引き)**:
//   §3 の規律が守っているのは「**いま**できないだけかもしれないことを UI が
//   先読みして隠さない」ことである(在庫不足・上限・派遣中・拠点常駐は、時間や
//   操作で解ける一時的な状態なので engine の reject に教えさせるのが正しい)。
//   死亡(GDD 7.5 の tombstone)は**恒久的に不能**で、成功しうる未来の state が
//   存在しない——「就労枠 0 の施設を候補から外す」(M70/R5-A11)と同じ
//   「構造的事実」の側であり、判定の先読みには当たらない。よって死亡住民には
//   セレクタ自体を出さず、理由(記録として一覧に残していること)を文で示す。
//   一時的な不能(派遣中/拠点常駐/想起困難)はこれまでどおりセレクタを活性の
//   まま残し、engine の reject に説明させる。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import type { CommandRejection } from "../../../engine/commands";
import { entityIdFromString, type EntityId } from "../../../engine/state/state";
import type { FacilityRosterEntry, ResidentView } from "../../derived";
import { cellCoordinateLabel } from "../cellCoordinate";
import { facilityLabel, residentDisplayName, techLabel, traitLabel } from "../contentLabels";
import { formatApproxDecimal1 } from "../format";
import { RejectionBanner } from "../RejectionBanner";
import type { ScreenProps } from "../screenProps";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./residentsScreen.css";

// --- 1. 住民 1 行(hooks 不使用・直接テスト可能) -----------------------------

export interface ResidentRowProps {
  readonly resident: ResidentView;
  readonly facilityRoster: readonly FacilityRosterEntry[];
  readonly onAssign: (residentId: EntityId, facilityId: EntityId) => void;
  readonly onUnassign: (residentId: EntityId) => void;
}

/** 想起困難/派遣中/死亡tombstoneの状態表示(GDD 7.1/7.5/11.2)。 */
function statusBadges(resident: ResidentView): readonly string[] {
  // [M70/R5-A02] `techImpairments`((住民,tech) 別・M13 本式)は
  // `recallImpaired`(住民単位スカラ)と独立の情報源。どちらかが立っていれば
  // 「想起困難」バッジを出す(derived.ts の ResidentView doc 参照)。
  const techImpairments = resident.techImpairments ?? [];
  // [M70/R5-A07] 衛星拠点に常駐中かどうか(省略時=既存テスト互換は null 扱い)。
  const stationedOutpostId = resident.stationedOutpostId ?? null;
  const badges: string[] = [];
  if (!resident.alive) badges.push("死亡");
  if (resident.dispatched) badges.push("派遣中");
  if (resident.recallImpaired || techImpairments.length > 0) badges.push("想起困難");
  if (stationedOutpostId !== null) badges.push("拠点常駐");
  if (
    resident.alive &&
    !resident.dispatched &&
    resident.assignedFacilityId === null &&
    stationedOutpostId === null
  ) {
    badges.push("無配属");
  }
  return badges;
}

export function ResidentRow({ resident, facilityRoster, onAssign, onUnassign }: ResidentRowProps) {
  function handleChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    if (target.value === "") {
      onUnassign(resident.entityId);
      return;
    }
    onAssign(resident.entityId, entityIdFromString(target.value));
  }

  const badges = statusBadges(resident);
  const techImpairments = resident.techImpairments ?? [];
  // [M70/R5-A11] 就労枠0の施設(寝床/保管庫等)は選んでも必ず reject される
  // だけなので候補から外す(commands.ts の判定を先読みするのではなく、
  // 「そもそも就ける枠が無い」という構造的事実を候補列挙の段階で反映するだけ・
  // §3 の「判定は書かない」規律には抵触しない=枠 0 は engine の apply 結果を
  // 待たずとも明らかな不変条件)。
  const assignableFacilities = facilityRoster.filter((facility) => facility.slotsMax !== 0);

  return (
    <li class="kf-resident-row">
      <div class="kf-resident-row__head">
        <span class="kf-resident-row__id">{residentDisplayName(resident.entityId)}</span>
        {badges.length > 0 && <span class="kf-resident-row__badges">{badges.join("・")}</span>}
      </div>
      {/* [M70/R5-A02] 「想起困難」バッジだけでは何のtechか分からない
          (derived.ts:326 の既知妥協への回答)。対象tech名を明示する。 */}
      {techImpairments.length > 0 && (
        <p class="kf-resident-row__impairment">
          想起困難の対象: {techImpairments.map((entry) => techLabel(entry.techId)).join("・")}
        </p>
      )}
      <ul class="kf-resident-row__stats">
        <li>体力{formatApproxDecimal1(resident.stats.vigorApprox)}</li>
        <li>器用{formatApproxDecimal1(resident.stats.dexterityApprox)}</li>
        <li>知性{formatApproxDecimal1(resident.stats.intellectApprox)}</li>
        <li>頑健{formatApproxDecimal1(resident.stats.fortitudeApprox)}</li>
        <li>意志{formatApproxDecimal1(resident.stats.willApprox)}</li>
        {/* [M73/R8-07] 士気(M72 で実際に動くようになった値)は探索本部・大移動には
            出ていたのに、配属を決めるこの画面には無かった(5能力だけ)。能力値と
            違って日々変動するので、区別できるクラスを付けて並べる。 */}
        <li class="kf-resident-row__morale">士気{formatApproxDecimal1(resident.moraleApprox)}</li>
      </ul>
      {resident.traitIds.length > 0 && (
        <p class="kf-resident-row__traits">
          {resident.traitIds.map((traitId) => traitLabel(traitId)).join("・")}
        </p>
      )}
      {/* [M73/R8-12] 死亡は恒久的に不能(§3 の線引き)。セレクタを出さず理由を書く。
          派遣中/拠点常駐/想起困難は一時的な状態なので従来どおりセレクタを残し、
          engine の reject に説明させる。 */}
      {resident.alive ? (
        <label class="kf-resident-row__assign">
          就労先
          <select
            class="kf-resident-row__select"
            value={resident.assignedFacilityId ?? ""}
            onChange={handleChange}
          >
            <option value="">(無配属)</option>
            {assignableFacilities.map((facility) => (
              <option key={facility.facilityId} value={facility.facilityId}>
                {facilityLabel(facility.defId)}({cellCoordinateLabel(facility.cellId)})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p class="kf-resident-row__assign-unavailable">
          亡くなった住民は就労できません(歩みの記録としてこの一覧に残しています)。
        </p>
      )}
    </li>
  );
}

// --- 2. 画面本体(hooks を持つのはここだけ) ----------------------------------

export function ResidentsScreen({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "residents", { activate: false });

  const residents = useSignalValue(store.derived.residents);
  const facilityRoster = useSignalValue(store.derived.facilityRoster);
  const [lastRejection, setLastRejection] = useState<CommandRejection | null>(null);
  // [M73/R8-12] 生存数(死亡 tombstone を除く)。判定は derived の `alive` をそのまま数える。
  const livingCount = residents.filter((resident) => resident.alive).length;

  function handleAssign(residentId: EntityId, facilityId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "assignResident", residentId, facilityId },
    });
    setLastRejection(
      result.command !== null && !result.command.ok ? result.command.rejection : null,
    );
  }

  function handleUnassign(residentId: EntityId): void {
    const result = store.dispatch({
      type: "commandApplied",
      command: { kind: "unassignResident", residentId },
    });
    setLastRejection(
      result.command !== null && !result.command.ok ? result.command.rejection : null,
    );
  }

  return (
    <section class="kf-residents-screen" aria-labelledby="kf-residents-screen-title">
      <h2 class="kf-residents-screen__title" id="kf-residents-screen-title">
        住民一覧・配置
      </h2>
      <p class="kf-screen-intro">
        住民の状態を確認し、就労先の施設を割り当てます。「想起困難」は技術を一時的に思い出せない
        状態で、時間が経てば回復します(記録を失ったわけではありません)。
      </p>
      {/* [M73/R8-12] 総数は死亡した住民(記録として残す)を含むので、ホームの
          「生存人口」と食い違って見えた。生存を主にして、亡くなった人数は
          別に添える(数を混ぜない)。 */}
      <p class="kf-residents-screen__summary">
        生存 {livingCount}人
        {residents.length > livingCount
          ? `(亡くなった住民 ${residents.length - livingCount}人)`
          : ""}
      </p>

      {lastRejection !== null && <RejectionBanner rejection={lastRejection} />}

      {residents.length === 0 ? (
        <p class="kf-residents-screen__empty">住民がいません。</p>
      ) : (
        <ul class="kf-residents-screen__list">
          {residents.map((resident) => (
            <ResidentRow
              key={resident.entityId}
              resident={resident}
              facilityRoster={facilityRoster}
              onAssign={handleAssign}
              onUnassign={handleUnassign}
            />
          ))}
        </ul>
      )}

      <div class="kf-residents-screen__nav">
        <button
          type="button"
          class="kf-residents-screen__nav-button"
          onClick={() => onNavigate("grid")}
        >
          格子ビューへ
        </button>
        <button
          type="button"
          class="kf-residents-screen__nav-button"
          onClick={() => onNavigate("facility")}
        >
          施設詳細へ
        </button>
      </div>
    </section>
  );
}
