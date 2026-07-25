// ---------------------------------------------------------------------------
// adjacency content スキーマ — GDD §6.2/§6.3/§12.1、ADR「entity スキーマ」620行
//
// `adjacency(tagMatrix, seedOffsetRange)`。id を持たないシングルトン設定
// (ADR リポ構成「adjacency.json townParams.json balance.json」は id 無し
// フラットファイル)なので、グローバル ID レジストリ(idRegistry.ts)の対象外。
//
// tagMatrix のキーは対称タグペア "tagA|tagB" を正準形(タグ7種の中で
// tagA <= tagB の辞書順)に限定する。逆順キー(例 "clean|heat")は reject し、
// 同じ意味のエントリが2表記で二重登録される余地を構造的に閉じる
// (canonicalize.ts のキーソートとは別軸だが、同じ「正準形1つに畳む」思想を
// タグペアの表記にも適用したもの)。
// ---------------------------------------------------------------------------

import { FACILITY_TAGS, type FacilityTag } from "./facility";
import {
  IssueCollector,
  expectInteger,
  expectNumber,
  expectRecord,
  expectString,
  fail,
  ok,
  type ValidationResult,
} from "./common";

/** adjacency のタグ全域は facility.ts の FACILITY_TAGS と同一集合(単一ソース)。 */
const TAG_UNIVERSE: readonly FacilityTag[] = FACILITY_TAGS;

/** GDD 6.2 の効果例(+20%/-15%/-10%/+30%)を包含する保守レンジ(-100%〜+100%)。 */
const RULE_VALUE_RANGE = { min: -1, max: 1 };
const OVERCROWD_THRESHOLD_RANGE = { min: 1, max: 8 };
const OVERCROWD_PENALTY_RANGE = { min: -1, max: 0 };
/** GDD 6.3: 全ボーナス加算 → 単一係数 ±60%上限クランプ。0〜1 の対称クランプ幅として保持。 */
const CLAMP_RANGE = { min: 0, max: 1 };
const SEED_OFFSET_RANGE = { min: -1, max: 1 };

export interface AdjacencyRule {
  readonly effect: string;
  readonly target: string;
  readonly valueFP: number;
}

export interface AdjacencyOvercrowd {
  readonly threshold: number;
  readonly penaltyPerExcessFP: number;
  readonly clampFP: number;
}

export interface AdjacencySeedOffsetRange {
  readonly min: number;
  readonly max: number;
}

export interface AdjacencyContent {
  readonly schemaVersion: number;
  readonly tagMatrix: Readonly<Record<string, AdjacencyRule>>;
  readonly overcrowd: AdjacencyOvercrowd;
  readonly seedOffsetRange: AdjacencySeedOffsetRange;
}

function parseTagPairKey(key: string): readonly [FacilityTag, FacilityTag] | undefined {
  const parts = key.split("|");
  if (parts.length !== 2) return undefined;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return undefined;
  if (
    !(TAG_UNIVERSE as readonly string[]).includes(a) ||
    !(TAG_UNIVERSE as readonly string[]).includes(b)
  ) {
    return undefined;
  }
  return [a as FacilityTag, b as FacilityTag];
}

function validateRule(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): AdjacencyRule | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const effect = expectString(obj["effect"], `${path}.effect`, issues);
  const target = expectString(obj["target"], `${path}.target`, issues);
  const valueFP = expectNumber(obj["valueFP"], `${path}.valueFP`, issues, RULE_VALUE_RANGE);
  if (effect === undefined || target === undefined || valueFP === undefined) return undefined;
  return { effect, target, valueFP };
}

function validateTagMatrix(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): Readonly<Record<string, AdjacencyRule>> | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;

  const keys = [...Object.keys(obj)];
  if (keys.length === 0) {
    issues.add(path, "tagMatrix は1エントリ以上必須");
    return undefined;
  }

  const issuesBefore = issues.list().length;
  const result: Record<string, AdjacencyRule> = {};
  for (const key of keys) {
    const pair = parseTagPairKey(key);
    if (pair === undefined) {
      issues.add(`${path}.${key}`, `キーは "tagA|tagB"(タグ7種: ${TAG_UNIVERSE.join(",")})が必須`);
      continue;
    }
    const [a, b] = pair;
    if (a > b) {
      issues.add(
        `${path}.${key}`,
        `対称タグペアは正準形(辞書順: "${b}|${a}")のみ許可。逆順キーは重複登録の余地を作るため reject`,
      );
      continue;
    }
    const rule = validateRule(obj[key], `${path}.${key}`, issues);
    if (rule === undefined) continue;
    result[key] = rule;
  }

  return issues.list().length === issuesBefore ? result : undefined;
}

function validateOvercrowd(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): AdjacencyOvercrowd | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const threshold = expectInteger(
    obj["threshold"],
    `${path}.threshold`,
    issues,
    OVERCROWD_THRESHOLD_RANGE,
  );
  const penaltyPerExcessFP = expectNumber(
    obj["penaltyPerExcessFP"],
    `${path}.penaltyPerExcessFP`,
    issues,
    OVERCROWD_PENALTY_RANGE,
  );
  const clampFP = expectNumber(obj["clampFP"], `${path}.clampFP`, issues, CLAMP_RANGE);
  if (threshold === undefined || penaltyPerExcessFP === undefined || clampFP === undefined)
    return undefined;
  return { threshold, penaltyPerExcessFP, clampFP };
}

function validateSeedOffsetRange(
  raw: unknown,
  path: string,
  issues: IssueCollector,
): AdjacencySeedOffsetRange | undefined {
  const obj = expectRecord(raw, path, issues);
  if (obj === undefined) return undefined;
  const min = expectNumber(obj["min"], `${path}.min`, issues, SEED_OFFSET_RANGE);
  const max = expectNumber(obj["max"], `${path}.max`, issues, SEED_OFFSET_RANGE);
  if (min === undefined || max === undefined) return undefined;
  if (min > max) {
    issues.add(path, `min (${String(min)}) は max (${String(max)}) 以下が必須`);
    return undefined;
  }
  return { min, max };
}

export function validateAdjacency(raw: unknown): ValidationResult<AdjacencyContent> {
  const issues = new IssueCollector();
  const obj = expectRecord(raw, "$", issues);
  if (obj === undefined) return fail(issues.list());

  const schemaVersion = expectInteger(obj["schemaVersion"], "$.schemaVersion", issues, {
    min: 1,
    max: 1_000,
  });
  const tagMatrix = validateTagMatrix(obj["tagMatrix"], "$.tagMatrix", issues);
  const overcrowd = validateOvercrowd(obj["overcrowd"], "$.overcrowd", issues);
  const seedOffsetRange = validateSeedOffsetRange(
    obj["seedOffsetRange"],
    "$.seedOffsetRange",
    issues,
  );

  if (
    schemaVersion === undefined ||
    tagMatrix === undefined ||
    overcrowd === undefined ||
    seedOffsetRange === undefined
  ) {
    return fail(issues.list());
  }

  return ok({ schemaVersion, tagMatrix, overcrowd, seedOffsetRange });
}
