// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 統計クリープ検出 — M38 / ADR-015 正準順序 7/10 / GDD 12.4
//
// ===========================================================================
// 0. 何を守るゲートか
// ===========================================================================
//   GDD 12.4:「統計クリープ検出(**同カテゴリ同era効率分布の Z-score 外れ値監視**)」。
//   週次の additive な content 追加(GDD 12.4 の葉テック/施設/イベント)が、
//   1 件ずつは schema を通るのに**分布としてじわじわインフレする**のを止める。
//   ADR のリポ構成では `sim/creep.ts`(§12.4)がその置き場と決まっている。
//   M46 が枠だけ固定した `.github/workflows/content-guardrail.yml` の
//   「7. 統計クリープ検出」ジョブの実体である。
//
// ===========================================================================
// 1. 判定（全て不等式・masking と偽陽性の両方に手当てをする）
// ===========================================================================
//   各「グループ」（= 同カテゴリ・同 era）の中で 1 エンティティの指標 x について
//
//     looZ   = (x − mean_-x) / stdev_-x      … **自分自身を除いた**平均と標本標準偏差
//     relDev = |x − median_-x| / |median_-x|  … 自分自身を除いた中央値からの相対乖離
//
//   を出し、**両方が閾値を超えたときだけ**外れ値とする
//   （looZ > 3.0 かつ relDev > 1.0）。
//
//   ・**自分を除く（leave-one-out）のは masking 対策**である。素の z は、外れ値
//     自身が平均と標準偏差を引き上げるため、n が小さいほど自分を隠してしまう
//     （実測: 8 件の 10〜11 に 40 を 1 件混ぜると素の z = 2.66 で閾値 3.0 を
//     下回り検出できない。leave-one-out なら z = 57）。
//   ・**relDev を併用するのは偽陽性対策**である。looZ だけだと、分布が素直に
//     狭いグループ（現行 content の `facility/output=resource` の建設コストなど）
//     で「平均から 3σ 離れているが実額では 25 → 35」といった無害な差まで
//     赤くなる。relDev > 1.0（= 中央値の 2 倍以上ないし 0 以下）を要求すると、
//     クリープ検出が本来狙う「桁で効率が違う entity の刺し込み」だけが残る。
//   ・MAD ベースの修正 Z も **参考値として同時に出す**（判定には使わない）。
//     MAD は現行 content のように同値が過半を占めるグループで 0 になり、
//     単独では判定器にならないため。
//
//   **n < `MIN_GROUP_SIZE`（= 5）のグループは判定しない**。母数が足りない
//   分布に Z-score を当てるのは統計として意味がないので、`skipped` として
//   機械可読に残す（pass にはしない = 「検査した」と偽らない）。
//
// ===========================================================================
// 2. 指標(なぜこの 3 つか)
// ===========================================================================
//   (a) tech.researchCost / era     … 「安い葉テック」を刺し込むインフレ
//   (b) facility 産出効率 / 産出種別 … `lvCurve[0] ÷ buildCost.amount`。
//                                      「同じコストで倍出る施設」の刺し込み
//   (c) facility.buildCost / 産出種別 … コスト側の逆インフレ
//
//   event(GDD 12.4 の「新探索イベント」)は**未カバー**である。難度と報酬が
//   ノード/分岐ごとの `difficultyMod`/`rewardMod` に分散しており、「同カテゴリ
//   同era効率」に相当する 1 個のスカラを content から一意に導けないため
//   (§4 の `uncoveredCategories` に機械可読で開示する)。
//
// ===========================================================================
// 3. 決定論
// ===========================================================================
//   入力は content JSON だけ。Math.random / Date.now は使わない。グループ・
//   エンティティの走査順は ID の昇順に固定してある。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isMainModule, writeJsonReport } from "./cliUtil";

/** 判定に必要な最小標本数(§1)。 */
export const MIN_GROUP_SIZE = 5;
/** 標本 Z の閾値(§1)。 */
export const Z_THRESHOLD = 3.0;
/** 中央値からの相対乖離の閾値(§1)。1.0 = 中央値の 2 倍以上、または 0 以下。 */
export const RELATIVE_DEVIATION_THRESHOLD = 1.0;

const CONTENT_DIR = fileURLToPath(new URL("../content/", import.meta.url));

function readContentJson(fileName: string): unknown {
  return JSON.parse(readFileSync(`${CONTENT_DIR}${fileName}`, "utf8")) as unknown;
}

export interface CreepSample {
  readonly id: string;
  readonly value: number;
}

export interface CreepOutlier {
  readonly groupId: string;
  readonly entityId: string;
  readonly value: number;
  /** 自分自身を除いた平均 / 中央値 / 標本標準偏差（§1）。 */
  readonly meanWithout: number;
  readonly medianWithout: number;
  readonly stdevWithout: number;
  /** 判定に使う 2 つの実測値。 */
  readonly leaveOneOutZ: number;
  readonly relativeDeviation: number;
  /** 参考値（判定には使わない・§1）。 */
  readonly modifiedZ: number;
}

/**
 * **[2026-08-02裁定・台帳v15 必-4] 名前つき既知例外。**
 *
 * 検出器の閾値は 1 段も緩めない。「なぜ外れ値なのかが分かっていて、いつ解除するかも
 * 決まっている」1 件だけを名指しで抑止し、レポートには `suppressed(既知)` として
 * 必ず出す(黙殺にしない)。合致しなかった登録は {@link CreepReport.staleSuppressions}
 * に出るので、content が直ったのに登録だけ残ることも検出できる。
 */
export interface CreepSuppression {
  readonly groupId: string;
  readonly metric: string;
  readonly entityId: string;
  /** なぜこの外れ値が設計どおりなのか。 */
  readonly reason: string;
  /** いつ解除するか(ロードマップのマイルストーン ID)。 */
  readonly expiresAtMilestone: string;
}

/**
 * 既知例外リスト(**追加は裁定事項**。増やすときは reason と期限を必ず書く)。
 *
 * **[M40] 空になった。** 台帳v15 必-4 で登録した 1 件(`facility/output=
 * resource:resource` × `lvCurve[0]/buildCost.amount` × `hearth`・期限 M40)は、
 * M40 の資源再校正で解除した。解除の実体は「かまどの産出/建設費比を下げる」
 * ではなく **7 種の資源施設の産出と建設費を同じ尺度へ揃えた**ことであり、
 * 実測は relDev 5.481 → 0.667(閾値 1.0)。詳細は
 * `docs/measurements/balance-m40-e2-recalibration-2026-08-03.json`。
 */
export const KNOWN_CREEP_SUPPRESSIONS: readonly CreepSuppression[] = [];

function suppressionFor(
  groupId: string,
  metric: string,
  entityId: string,
): CreepSuppression | undefined {
  return KNOWN_CREEP_SUPPRESSIONS.find(
    (entry) => entry.groupId === groupId && entry.metric === metric && entry.entityId === entityId,
  );
}

/** 既知例外で抑止された外れ値(実測値はそのまま保持する)。 */
export interface SuppressedCreepOutlier extends CreepOutlier {
  readonly suppression: CreepSuppression;
}

export interface CreepGroupReport {
  readonly groupId: string;
  readonly metric: string;
  readonly sampleCount: number;
  readonly evaluated: boolean;
  /** `evaluated === false` のときの理由。 */
  readonly skipReason: string | null;
  readonly mean: number;
  readonly median: number;
  readonly stdev: number;
  readonly mad: number;
  /** そのグループで観測された |looZ| の最大値(実測値。閾値と対で報告する)。 */
  readonly maxAbsLeaveOneOutZ: number;
  /** そのグループで観測された相対乖離の最大値。 */
  readonly maxRelativeDeviation: number;
  /** 参考値(判定には使わない・§1)。 */
  readonly maxAbsModifiedZ: number;
  readonly outliers: readonly CreepOutlier[];
  /** 既知例外で抑止された外れ値(判定閾値は同じ・{@link KNOWN_CREEP_SUPPRESSIONS})。 */
  readonly suppressedOutliers: readonly SuppressedCreepOutlier[];
}

export interface CreepReport {
  readonly zThreshold: number;
  readonly relativeDeviationThreshold: number;
  readonly minGroupSize: number;
  readonly groups: readonly CreepGroupReport[];
  readonly outlierCount: number;
  /** 既知例外で抑止した件数(0 でないことが正常な状態ではない・期限つき)。 */
  readonly suppressedCount: number;
  /** 有効な既知例外の一覧(レポートに必ず載せる)。 */
  readonly suppressions: readonly CreepSuppression[];
  /** 登録されているが今回 1 度も合致しなかった既知例外(= 消し忘れの検出)。 */
  readonly staleSuppressions: readonly CreepSuppression[];
  readonly skippedGroupCount: number;
  /** クリープ検出が**まだ掛かっていない** content カテゴリ(正直な開示・§2)。 */
  readonly uncoveredCategories: readonly { readonly category: string; readonly reason: string }[];
}

// --- 統計 --------------------------------------------------------------------

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length === 0 ? 0 : sum / values.length;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((l, r) => l - r);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function stdevOf(values: readonly number[], m: number): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const value of values) sum += (value - m) * (value - m);
  return Math.sqrt(sum / (values.length - 1));
}

function madOf(values: readonly number[], med: number): number {
  return medianOf(values.map((value) => Math.abs(value - med)));
}

/** 1 グループぶんの外れ値判定（§1・テストから直接叩けるよう公開）。 */
export function analyzeGroup(
  groupId: string,
  metric: string,
  samples: readonly CreepSample[],
): CreepGroupReport {
  const ordered = [...samples].sort((l, r) => (l.id < r.id ? -1 : l.id > r.id ? 1 : 0));
  const values = ordered.map((sample) => sample.value);
  const m = mean(values);
  const med = medianOf(values);
  const sd = stdevOf(values, m);
  const mad = madOf(values, med);

  if (ordered.length < MIN_GROUP_SIZE) {
    return {
      groupId,
      metric,
      sampleCount: ordered.length,
      evaluated: false,
      skipReason: `標本数 ${String(ordered.length)} < ${String(MIN_GROUP_SIZE)}（Z-score が統計として成立しない）`,
      mean: m,
      median: med,
      stdev: sd,
      mad,
      maxAbsLeaveOneOutZ: 0,
      maxRelativeDeviation: 0,
      maxAbsModifiedZ: 0,
      outliers: [],
      suppressedOutliers: [],
    };
  }

  const outliers: CreepOutlier[] = [];
  const suppressedOutliers: SuppressedCreepOutlier[] = [];
  let maxAbsLeaveOneOutZ = 0;
  let maxRelativeDeviation = 0;
  let maxAbsModifiedZ = 0;

  for (let i = 0; i < ordered.length; i++) {
    const sample = ordered[i];
    if (sample === undefined) continue;
    const without = values.filter((_, index) => index !== i);
    const meanWithout = mean(without);
    const medianWithout = medianOf(without);
    const stdevWithout = stdevOf(without, meanWithout);

    const leaveOneOutZ = stdevWithout === 0 ? 0 : (sample.value - meanWithout) / stdevWithout;
    const relativeDeviation =
      medianWithout === 0
        ? Number.POSITIVE_INFINITY
        : Math.abs(sample.value - medianWithout) / Math.abs(medianWithout);
    const modifiedZ = mad === 0 ? 0 : (0.6745 * (sample.value - med)) / mad;

    if (Math.abs(leaveOneOutZ) > maxAbsLeaveOneOutZ) maxAbsLeaveOneOutZ = Math.abs(leaveOneOutZ);
    if (Number.isFinite(relativeDeviation) && relativeDeviation > maxRelativeDeviation) {
      maxRelativeDeviation = relativeDeviation;
    }
    if (Math.abs(modifiedZ) > maxAbsModifiedZ) maxAbsModifiedZ = Math.abs(modifiedZ);

    if (Math.abs(leaveOneOutZ) > Z_THRESHOLD && relativeDeviation > RELATIVE_DEVIATION_THRESHOLD) {
      const outlier: CreepOutlier = {
        groupId,
        entityId: sample.id,
        value: sample.value,
        meanWithout,
        medianWithout,
        stdevWithout,
        leaveOneOutZ,
        relativeDeviation,
        modifiedZ,
      };
      // 閾値判定は上で完了している。既知例外は「赤くするかどうか」だけを変え、
      // 実測値は suppressedOutliers に保持してレポートへ必ず出す(黙殺にしない)。
      const suppression = suppressionFor(groupId, metric, sample.id);
      if (suppression === undefined) outliers.push(outlier);
      else suppressedOutliers.push({ ...outlier, suppression });
    }
  }

  return {
    groupId,
    metric,
    sampleCount: ordered.length,
    evaluated: true,
    skipReason: null,
    mean: m,
    median: med,
    stdev: sd,
    mad,
    maxAbsLeaveOneOutZ,
    maxRelativeDeviation,
    maxAbsModifiedZ,
    outliers,
    suppressedOutliers,
  };
}

// --- content の読み取り -------------------------------------------------------

interface TechJson {
  readonly id: string;
  readonly era: string;
  readonly researchCost: number;
}

interface FacilityJson {
  readonly id: string;
  readonly lvCurve: readonly number[];
  readonly output?: { readonly kind: string; readonly resourceId?: string };
  readonly buildCost?: { readonly resourceId: string; readonly amount: number };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list === undefined) map.set(key, [item]);
    else list.push(item);
  }
  return map;
}

export function runCreepDetection(): CreepReport {
  const techs = readContentJson("tech.json") as readonly TechJson[];
  const facilities = readContentJson("facility.json") as readonly FacilityJson[];

  const groups: CreepGroupReport[] = [];

  // (a) tech.researchCost / era。
  for (const [era, list] of [...groupBy(techs, (tech) => tech.era)].sort((l, r) =>
    l[0] < r[0] ? -1 : 1,
  )) {
    groups.push(
      analyzeGroup(
        `tech/era=${era}`,
        "researchCost",
        list.map((tech) => ({ id: tech.id, value: tech.researchCost })),
      ),
    );
  }

  // (b)(c) facility の産出効率と建設コスト / 産出種別。
  const outputKindOf = (facility: FacilityJson): string =>
    `${facility.output?.kind ?? "none"}${facility.output?.resourceId === undefined ? "" : ":resource"}`;
  for (const [kind, list] of [...groupBy(facilities, outputKindOf)].sort((l, r) =>
    l[0] < r[0] ? -1 : 1,
  )) {
    const efficiency: CreepSample[] = [];
    const buildCost: CreepSample[] = [];
    for (const facility of list) {
      const base = facility.lvCurve[0] ?? 0;
      const cost = facility.buildCost?.amount ?? 0;
      if (cost > 0) efficiency.push({ id: facility.id, value: base / cost });
      buildCost.push({ id: facility.id, value: cost });
    }
    groups.push(analyzeGroup(`facility/output=${kind}`, "lvCurve[0]/buildCost.amount", efficiency));
    groups.push(analyzeGroup(`facility/output=${kind}`, "buildCost.amount", buildCost));
  }

  let outlierCount = 0;
  let suppressedCount = 0;
  let skippedGroupCount = 0;
  const matched = new Set<CreepSuppression>();
  for (const group of groups) {
    outlierCount += group.outliers.length;
    suppressedCount += group.suppressedOutliers.length;
    for (const entry of group.suppressedOutliers) matched.add(entry.suppression);
    if (!group.evaluated) skippedGroupCount++;
  }

  return {
    zThreshold: Z_THRESHOLD,
    relativeDeviationThreshold: RELATIVE_DEVIATION_THRESHOLD,
    minGroupSize: MIN_GROUP_SIZE,
    groups,
    outlierCount,
    suppressedCount,
    suppressions: KNOWN_CREEP_SUPPRESSIONS,
    staleSuppressions: KNOWN_CREEP_SUPPRESSIONS.filter((entry) => !matched.has(entry)),
    skippedGroupCount,
    uncoveredCategories: [
      {
        category: "event",
        reason:
          "難度・報酬がノード/分岐ごとの difficultyMod / rewardMod に分散しており、" +
          "『同カテゴリ同era効率』に相当する 1 個のスカラを content から一意に導けない" +
          "(距離帯パラメータ側の difficulty/reward は balance.json にあり event content の増加では動かない)。" +
          "解消条件 = GDD 12.4 に event の効率指標(例: 期待報酬 ÷ 期待難度)の定義を明記する",
      },
      {
        category: "trait",
        reason:
          "効果が stat 別の mul/add に分かれており共通尺度が無い。解消条件 = " +
          "trait 効果の正規化指標(例: 生産式へ写した後の実効倍率)の定義",
      },
      {
        category: "facility（産出種別グループの不均質）",
        reason:
          "`output.kind = research` のグループには就労枠 0 のカタログ枠（寝床/保管庫/" +
          "見張り台/療養所）と実際の研究施設が混在しており、効率分布が二峰になる。" +
          "就労枠の有無で分けるのが正しいが、現行 content ではどちらも n<5 になり" +
          "判定不能になるため分けていない。解消条件 = 施設が増えて " +
          "staffed/unstaffed のどちらも n>=5 になった時点でグループキーを分割する",
      },
      {
        category: "adjacency",
        reason:
          "tagMatrix は既存エントリの書換が content-diff-gate で reject されるため" +
          "(ADR-015)、additive 追加のみが起きる。ペア数が 7×7 の上限を持ち分布が" +
          "小さいので Z-score より個別レンジ検査(schema)が有効。解消条件 = " +
          "タグペアが十分に増えた段階での再検討",
      },
    ],
  };
}

// --- CLI ---------------------------------------------------------------------

async function main(): Promise<void> {
  const report = runCreepDetection();
  console.log(
    `\n=== 統計クリープ検出(ADR-015 正準順序 7/10・GDD 12.4)` +
      `looZ>${String(Z_THRESHOLD)} かつ relDev>${String(RELATIVE_DEVIATION_THRESHOLD)} ===`,
  );
  console.table(
    report.groups.map((group) => ({
      group: group.groupId,
      metric: group.metric,
      n: group.sampleCount,
      評価: group.evaluated ? "yes" : "skip",
      "max|looZ|": group.maxAbsLeaveOneOutZ.toFixed(3),
      maxRelDev: group.maxRelativeDeviation.toFixed(3),
      "max|modZ|(参考)": group.maxAbsModifiedZ.toFixed(3),
      外れ値: group.outliers.length,
      "suppressed(既知)": group.suppressedOutliers.length,
    })),
  );
  for (const group of report.groups) {
    if (group.skipReason !== null) {
      console.log(`  SKIP ${group.groupId} (${group.metric}): ${group.skipReason}`);
    }
    for (const entry of group.suppressedOutliers) {
      console.log(
        `  SUPPRESSED(既知) ${entry.groupId} (${group.metric}) ${entry.entityId}: ` +
          `値 ${String(entry.value)} / looZ ${entry.leaveOneOutZ.toFixed(3)} / ` +
          `relDev ${entry.relativeDeviation.toFixed(3)} — ${entry.suppression.reason} ` +
          `[解除期限: ${entry.suppression.expiresAtMilestone}]`,
      );
    }
    for (const outlier of group.outliers) {
      console.error(
        `  OUTLIER ${outlier.groupId} (${group.metric}) ${outlier.entityId}: ` +
          `値 ${String(outlier.value)} / 自分を除く平均 ${outlier.meanWithout.toFixed(3)} / ` +
          `looZ ${outlier.leaveOneOutZ.toFixed(3)}(閾値 ${String(Z_THRESHOLD)}) / ` +
          `relDev ${outlier.relativeDeviation.toFixed(3)}(閾値 ${String(RELATIVE_DEVIATION_THRESHOLD)})`,
      );
    }
  }
  for (const stale of report.staleSuppressions) {
    console.log(
      `  STALE(既知例外の消し忘れ) ${stale.groupId} (${stale.metric}) ${stale.entityId}: ` +
        `今回は外れ値として検出されなかった。KNOWN_CREEP_SUPPRESSIONS から削除できる`,
    );
  }
  console.log(
    `外れ値 ${String(report.outlierCount)} 件 / suppressed(既知) ${String(report.suppressedCount)} 件 ` +
      `/ 既知例外の消し忘れ ${String(report.staleSuppressions.length)} 件 ` +
      `/ 判定省略グループ ${String(report.skippedGroupCount)} 件 ` +
      `/ 未カバーカテゴリ ${String(report.uncoveredCategories.length)} 件`,
  );

  await writeJsonReport("sim/output/creep-report.json", report);
  if (report.outlierCount > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  await main();
}
