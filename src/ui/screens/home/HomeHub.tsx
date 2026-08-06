// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ①ホームハブ(M29)— GDD 6.6 / 4.1(a) / 2.2 / ADR-027(4)
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   GDD 6.6:「単一ストアで状態共有。**緊急度バッジから各タスクへワンタップ遷移**」。
//   つまりホームハブの本体は「今なにをすべきか」の一覧であって、数値ダッシュボード
//   ではない。よって
//     (a) 緊急度バッジ列(赤/黄/灰)を先頭に置き、1 タップで担当画面へ飛ばす
//     (b) その下にコロニー概況(件数だけ)を添える
//   の 2 段だけを持ち、格子や住民表そのものはここへ持ち込まない。
//
// ===========================================================================
// 2. 赤バッジは「限定点灯」(GDD 2.2)
// ===========================================================================
//   赤 = (B) レア資産が実際に喪失へ近づく特定状況にだけ点く。判定は
//   `src/ui/derived.ts` の `homeAlerts` にあり(engine の既存述語を呼ぶだけ)、
//   この画面には判定が 1 行も無い。ここが持つのは**文言と意匠**だけである。
//
// ===========================================================================
// 3. 色だけで意味を運ばない
// ===========================================================================
//   3 段はそれぞれ「記号 + 日本語ラベル + 件数」を必ず併記する(ADR-003 の
//   4 重符号化と同じ思想)。面の相対輝度も 0.08 / 0.68 / 0.84 と離してあるので
//   グレースケールでも判別できる(配色の根拠は docs/design/ui-spec.md §3.3)。
//
// ===========================================================================
// 4. 再描画の粒度(ADR-027(4))
// ===========================================================================
//   `homeAlerts` / `homeBadges` はどちらも **tick を含まない**件数だけの派生値
//   なので、毎分の tick 進行では再描画されない。時計表示はシェル側の
//   別コンポーネント(`ColonyClock`)に隔離してあり、そこだけが毎分更新される。
// ---------------------------------------------------------------------------

import type { HomeAlert, HomeAlertId, UrgencyLevel } from "../../derived";
import { formatApproxDecimal1, formatGameClock } from "../format";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import type { ScreenProps } from "../screenProps";
import type { ScreenId } from "../../screens";

// --- 1. 意匠テーブル(判定は derived.ts・ここは文言と記号だけ) ---------------

/** 段ごとの記号と呼び名(GDD 4.1(a) の赤/黄/灰)。 */
export const URGENCY_PRESENTATION: {
  readonly [K in UrgencyLevel]: { readonly mark: string; readonly name: string };
} = {
  critical: { mark: "!", name: "危機" },
  warn: { mark: "▲", name: "要対応" },
  info: { mark: "・", name: "任意" },
};

export interface HomeAlertText {
  /** 見出し(何が起きているか)。 */
  readonly label: string;
  /** 1 行の補足(どうすればよいか)。 */
  readonly hint: string;
  /** 件数の単位。 */
  readonly unit: string;
}

/** バッジ 1 種ごとの文言。`HomeAlertId` の全件を必ず埋める(型で強制)。 */
export const HOME_ALERT_TEXT: { readonly [K in HomeAlertId]: HomeAlertText } = {
  bLossImminent: {
    label: "失われかけている技術がある",
    hint: "唯一の保持者が派遣中か士気危機。書き残せば取り返しがつく",
    unit: "件",
  },
  recallImpaired: {
    label: "想起困難で手が止まっている",
    hint: "一時的な停止であって喪失ではない(時間で回復する)",
    unit: "人",
  },
  codifyPending: {
    label: "まだ書き残していない技術がある",
    hint: "保持者が居るうちに成文化しておく",
    unit: "件",
  },
  researchIdle: {
    label: "研究が止まっている",
    hint: "研究キューが空。次に何を解禁するか決める",
    unit: "件",
  },
  // [M73/R8-04 fatal] 研究点が満了しても実地要件(該当施設での稼働)が残っていると
  // 完了しない(進捗表示は 100% で止まる)。Round 8 実測ではこの状態の手がかりが
  // 全画面に 1 文字も無かったので、ホームから研究ツリーへ導線を出す。
  researchFieldBlocked: {
    label: "研究が実地要件を待っている",
    hint: "点は満ちた。該当の施設に人を就けて稼働させると完了する",
    unit: "件",
  },
  storageAtCapacity: {
    label: "保管上限に達している資源がある",
    hint: "産出が頭打ちになっている(一部は廃材化)。保管庫を建てると上限が増える",
    unit: "種",
  },
  // [M73/R8-05] 襲撃(3日ごと)は撃退でも略奪でも無音だったため、機構の存在自体が
  // 伝わっていなかった(見張り台を建てる動機も生まれない)。備えが無いことだけを
  // 灰(任意)で示す——実際に撃退できるかは乱数を含むので断定しない。
  raidUndefended: {
    label: "襲撃への備えがない",
    hint: "見張り台を建てると防衛戦力が上がる(格子の縁に置くほど有利)",
    unit: "件",
  },
  expeditionActive: {
    label: "探索に出ている隊がいる",
    hint: "帰還すると結果がまとめて届く",
    unit: "隊",
  },
  idleResidents: {
    label: "手の空いている住民がいる",
    hint: "施設に就ければ産出が増える",
    unit: "人",
  },
};

// --- 2. バッジ 1 個(hooks を使わないので直接テストできる) ------------------

export interface UrgencyBadgeProps {
  readonly alert: HomeAlert;
  readonly onNavigate: (screen: ScreenId) => void;
}

/**
 * 緊急度バッジ 1 個。**ボタンそのものが遷移**(GDD 6.6 の「ワンタップ遷移」)。
 * 44px 角の最小タップ領域は CSS 側(`.kf-badge`)で担保する。
 */
export function UrgencyBadge({ alert, onNavigate }: UrgencyBadgeProps) {
  const presentation = URGENCY_PRESENTATION[alert.level];
  const text = HOME_ALERT_TEXT[alert.id];
  return (
    <li>
      <button
        type="button"
        class={`kf-badge kf-badge--${alert.level}`}
        data-alert-id={alert.id}
        data-alert-level={alert.level}
        data-target-screen={alert.screen}
        onClick={() => onNavigate(alert.screen)}
      >
        <span class="kf-badge__pill">
          <span aria-hidden="true">{presentation.mark}</span>
          {presentation.name}
        </span>
        <span class="kf-badge__text">
          {text.label}
          <span class="kf-badge__hint">{text.hint}</span>
        </span>
        <span class="kf-badge__count">
          {alert.count}
          {text.unit}
        </span>
        <span class="kf-badge__chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}

// --- 3. 画面本体 -------------------------------------------------------------

export function HomeHub({ store, onNavigate }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事(M18★5)。
  useScreenMount(store, "home", { activate: false });
  const alerts = useSignalValue(store.derived.homeAlerts);
  const badges = useSignalValue(store.derived.homeBadges);
  // [M62/FC6b・R2-A08] 寝床上限の現在値表示(engine の既存 derived 呼びのみ)。
  const population = useSignalValue(store.derived.populationSummary);
  // [M73/R8-05] 襲撃の見通し(次回予定・防衛戦力 vs 強さ)。
  const raid = useSignalValue(store.derived.raidOutlook);

  return (
    <section class="kf-home" aria-labelledby="kf-home-alerts-title">
      <h2 class="kf-home__section-title" id="kf-home-alerts-title">
        いま手を入れるところ
      </h2>
      {alerts.alerts.length === 0 ? (
        <p class="kf-home__calm">
          急ぎの用はありません。72時間放置しても失われるものはありません。
        </p>
      ) : (
        <ul class="kf-badges">
          {alerts.alerts.map((alert) => (
            <UrgencyBadge key={alert.id} alert={alert} onNavigate={onNavigate} />
          ))}
        </ul>
      )}

      {/* [M62/FC9・R2-C02] 緊急度バッジは問題がある時だけ点く(GDD 2.2 の
          「限定点灯」)ため、研究/成文化は止まっていない限りホームから直接
          飛べる導線が無かった(効率のヒューリスティックで指摘)。バッジの
          有無に関わらず常設の近道を置く(ナビバー経由の遠回りをしなくてよい
          ようにする)。 */}
      <h2 class="kf-home__section-title">よく使う画面へ</h2>
      <ul class="kf-home__quicklinks">
        <li>
          <button
            type="button"
            class="kf-home__quicklink-button"
            onClick={() => onNavigate("research")}
          >
            研究ツリーへ
          </button>
        </li>
        <li>
          <button
            type="button"
            class="kf-home__quicklink-button"
            onClick={() => onNavigate("codify")}
          >
            成文化キューへ
          </button>
        </li>
      </ul>

      <h2 class="kf-home__section-title">コロニーの様子</h2>
      <ul class="kf-stats">
        {/* [M73/R8-12] 「住民 9」は死亡した住民(記録として残る)を含む総数で、
            すぐ下の「生存人口/寝床上限 7/9」と食い違って見えた。数える対象を
            生存者に揃え、亡くなった住民は別行に分けて出す(数を混ぜない)。 */}
        <li class="kf-stats__item">
          <span class="kf-stats__label">住民(生存)</span>
          <span class="kf-stats__value">{population.living}</span>
        </li>
        {badges.residentCount > population.living && (
          <li class="kf-stats__item">
            <span class="kf-stats__label">亡くなった住民</span>
            <span class="kf-stats__value">{badges.residentCount - population.living}</span>
          </li>
        )}
        {/* [M62/FC6b・R2-A08] 寝床上限の現在値表示。寝床は実は結線済み
            (人口下限保証・晴天漂着の上限に効く・facilityEffect.ts §2「寝床」)
            だが、以前はどの画面にも現在値が出ておらず伝わっていなかった。
            `population.living` は生存住民のみ(`badges.residentCount` は死亡
            tombstone を含む全件で意味が異なるため、値は混ぜず並べて出す)。 */}
        <li class="kf-stats__item">
          <span class="kf-stats__label">生存人口/寝床上限</span>
          <span class="kf-stats__value">
            {population.living}/{population.bedCapacity}
          </span>
        </li>
        {/* [M73/R8-05] 襲撃の見通し。engine の読み取り専用関数から作った値だけを
            出す(derived.ts §9)。防衛戦力と襲撃の強さを並べると、見張り台を
            建てる/外周へ動かす判断がここで付く。 */}
        {raid.active && (
          <>
            <li class="kf-stats__item">
              <span class="kf-stats__label">次の襲撃</span>
              <span class="kf-stats__value">
                {raid.nextRaidTick === null ? "—" : formatGameClock(raid.nextRaidTick)}
              </span>
            </li>
            <li class="kf-stats__item">
              <span class="kf-stats__label">防衛戦力/襲撃の強さ</span>
              <span class="kf-stats__value">
                {formatApproxDecimal1(raid.defenseApprox)}/
                {formatApproxDecimal1(raid.strengthApprox)}
                {raid.repelCertain ? "(撃退できる見込み)" : ""}
              </span>
            </li>
          </>
        )}
        <li class="kf-stats__item">
          <span class="kf-stats__label">施設</span>
          <span class="kf-stats__value">{badges.facilityCount}</span>
        </li>
        <li class="kf-stats__item">
          <span class="kf-stats__label">研究(進行/完了)</span>
          <span class="kf-stats__value">
            {badges.activeResearchCount}/{badges.completedResearchCount}
          </span>
        </li>
        <li class="kf-stats__item">
          <span class="kf-stats__label">記録(作業中/完了)</span>
          <span class="kf-stats__value">
            {badges.pendingCodifyCount}/{badges.completedCodifyCount}
          </span>
        </li>
        <li class="kf-stats__item">
          <span class="kf-stats__label">派遣中</span>
          <span class="kf-stats__value">{badges.dispatchedResidentCount}</span>
        </li>
      </ul>
    </section>
  );
}
