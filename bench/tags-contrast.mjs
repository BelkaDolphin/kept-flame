#!/usr/bin/env node
/**
 * bench/tags-contrast.mjs
 *
 * タグ7種 記号意匠仕様書 (docs/design/tags-spec.md) の §8.3 機械可読JSONブロックを
 * 唯一の入力として読み込み、WCAG 2.x の相対輝度式でコントラスト比を独立に再計算し、
 * 仕様書に記載された期待値(tags[].contrast.* / relLuminance)と突合する。
 *
 * 中立色(inkBody/inkMuted/lineGrid/lineRubble)は JSON ブロックに期待コントラスト値が
 * 含まれていないため、仕様書 §2.3 の表の数値をこのファイル内に個別転記し、その出典行を
 * コメントで明記した上で突合する(§2.3 の値自体を「正」として扱う。ズレがあれば report する)。
 *
 * このスクリプトは docs/measurements/ には一切書き込まない(実計測はT16)。標準出力のみ。
 *
 * 使い方: node bench/tags-contrast.mjs   (または npm run measure:contrast)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, "..", "docs", "design", "tags-spec.md");

// --- WCAG 2.x 相対輝度・コントラスト比 (tags-spec.md §3.1 の式をそのまま実装) ---

function hexToRgb8(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error("invalid hex color: " + hex);
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

function srgbChannelToLinear(cs) {
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb8(hex);
  const rl = srgbChannelToLinear(r / 255);
  const gl = srgbChannelToLinear(g / 255);
  const bl = srgbChannelToLinear(b / 255);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hexA, hexB) {
  const ya = relativeLuminance(hexA);
  const yb = relativeLuminance(hexB);
  const lighter = Math.max(ya, yb);
  const darker = Math.min(ya, yb);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- spec の機械可読JSONブロックを抽出 ---

function extractSpecJson(mdText) {
  const fenceRe = /```json\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  let last = null;
  while ((match = fenceRe.exec(mdText)) !== null) {
    last = match[1];
  }
  if (last === null) {
    throw new Error("tags-spec.md 内に ```json フェンスブロックが見つかりません");
  }
  return JSON.parse(last);
}

const specText = readFileSync(SPEC_PATH, "utf8");
const spec = extractSpecJson(specText);

// --- 中立色の期待コントラスト値 (tags-spec.md §2.3 の表からの転記。JSONブロックには含まれない) ---
// | トークン | 対 page | 対 cell | 対 rubble | 要件 |
const NEUTRAL_EXPECTED = {
  inkBody: { page: 16.17, cell: 15.26, rubble: 13.84, role: "text" }, // §2.3 1行目
  inkMuted: { page: 7.54, cell: 7.12, rubble: 6.46, role: "text" }, // §2.3 2行目
  lineGrid: { page: 3.66, cell: 3.46, rubble: 3.14, role: "nonText" }, // §2.3 3行目
  lineRubble: { page: 4.33, cell: 4.08, rubble: 3.7, role: "nonText" }, // §2.3 4行目
};

const WCAG_TEXT = spec.wcag.text; // 4.5
const WCAG_NON_TEXT = spec.wcag.nonText; // 3.0

// 許容誤差: relLuminance は spec 側が小数5桁表記(丸め誤差 <= 5e-6)なので 1e-4 で十分厳格。
// コントラスト比は spec 側が小数2桁の丸め表記(丸め誤差最大 5e-3)なので、比較用の許容誤差は
// 「丸め表記の半ULP」= 0.005 とする(1e-4 のまま比較すると丸め表記そのものによる差分を
// 「不一致」と誤判定してしまうため)。
const Y_TOLERANCE = 1e-4;
const CR_TOLERANCE = 0.005;

const rows = [];
let mismatchCount = 0;
let wcagFailCount = 0;

function addRow(row) {
  rows.push(row);
  if (row.specMatch === false) mismatchCount++;
  if (row.wcagPass === false) wcagFailCount++;
}

// --- 1. タグ ink の relLuminance 検証 ---
for (const tag of spec.tags) {
  const computedY = relativeLuminance(tag.ink);
  const diff = Math.abs(computedY - tag.relLuminance);
  addRow({
    category: "relLuminance",
    label: tag.id + " (" + tag.ink + ")",
    expected: tag.relLuminance.toFixed(5),
    computed: computedY.toFixed(5),
    diff: diff.toExponential(2),
    tolerance: Y_TOLERANCE,
    specMatch: diff <= Y_TOLERANCE,
    threshold: "-",
    wcagPass: null,
  });
}

// --- 2. タグ ink 対 全面 + 自tint のコントラスト比 (spec §3.2 / JSON tags[].contrast) ---
const surfaceOrder = ["page", "cell", "cellSelected", "previewAdd", "previewSub", "rubble"];
for (const tag of spec.tags) {
  for (const surfaceKey of surfaceOrder) {
    const surfaceHex = spec.surfaces[surfaceKey === "cellSelected" ? "cellSelected" : surfaceKey];
    const computed = contrastRatio(tag.ink, surfaceHex);
    const expected = tag.contrast[surfaceKey];
    const diff = Math.abs(computed - expected);
    addRow({
      category: "tag-ink vs surface",
      label: tag.id + " vs " + surfaceKey,
      expected: expected.toFixed(2),
      computed: computed.toFixed(4),
      diff: diff.toFixed(4),
      tolerance: CR_TOLERANCE,
      specMatch: diff <= CR_TOLERANCE,
      threshold: WCAG_TEXT + " / " + WCAG_NON_TEXT,
      wcagPass: computed >= WCAG_TEXT, // text用途(数値)にも使われるため厳しい方(4.5)で判定
    });
  }
  // 自 tint
  const computedTint = contrastRatio(tag.ink, tag.tint);
  const expectedTint = tag.contrast.tint;
  const diffTint = Math.abs(computedTint - expectedTint);
  addRow({
    category: "tag-ink vs own tint",
    label: tag.id + " vs tint",
    expected: expectedTint.toFixed(2),
    computed: computedTint.toFixed(4),
    diff: diffTint.toFixed(4),
    tolerance: CR_TOLERANCE,
    specMatch: diffTint <= CR_TOLERANCE,
    threshold: WCAG_TEXT + " / " + WCAG_NON_TEXT,
    wcagPass: computedTint >= WCAG_TEXT,
  });
}

// --- 3. 中立色 対 page/cell/rubble (spec §2.3) ---
for (const [key, expectedRow] of Object.entries(NEUTRAL_EXPECTED)) {
  const neutralHex = spec.neutrals[key];
  const threshold = expectedRow.role === "text" ? WCAG_TEXT : WCAG_NON_TEXT;
  for (const surfaceKey of ["page", "cell", "rubble"]) {
    const surfaceHex = spec.surfaces[surfaceKey];
    const computed = contrastRatio(neutralHex, surfaceHex);
    const expected = expectedRow[surfaceKey];
    const diff = Math.abs(computed - expected);
    addRow({
      category: "neutral vs surface",
      label: key + " (" + neutralHex + ") vs " + surfaceKey,
      expected: expected.toFixed(2),
      computed: computed.toFixed(4),
      diff: diff.toFixed(4),
      tolerance: CR_TOLERANCE,
      specMatch: diff <= CR_TOLERANCE,
      threshold: String(threshold),
      wcagPass: computed >= threshold,
    });
  }
}

// --- 出力 ---

function pad(str, len) {
  str = String(str);
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

console.log("=== bench/tags-contrast.mjs ===");
console.log("spec: " + SPEC_PATH);
console.log("wcag: text >= " + WCAG_TEXT + " / nonText >= " + WCAG_NON_TEXT);
console.log(
  "tolerance: relLuminance <= " +
    Y_TOLERANCE +
    " (spec 5桁丸め) / contrast ratio <= " +
    CR_TOLERANCE +
    " (spec 2桁丸めの半ULP)",
);
console.log("");

let currentCategory = null;
for (const row of rows) {
  if (row.category !== currentCategory) {
    currentCategory = row.category;
    console.log("--- " + currentCategory + " ---");
    console.log(
      pad("label", 28) +
        pad("expected", 10) +
        pad("computed", 10) +
        pad("diff", 10) +
        pad("specMatch", 11) +
        pad("threshold", 12) +
        "wcagPass",
    );
  }
  console.log(
    pad(row.label, 28) +
      pad(row.expected, 10) +
      pad(row.computed, 10) +
      pad(row.diff, 10) +
      pad(row.specMatch === null ? "-" : row.specMatch ? "OK" : "MISMATCH", 11) +
      pad(row.threshold, 12) +
      (row.wcagPass === null ? "-" : row.wcagPass ? "PASS" : "FAIL"),
  );
}

console.log("");
console.log("=== summary ===");
console.log("rows: " + rows.length);
console.log("spec mismatches (beyond tolerance): " + mismatchCount);
console.log("WCAG threshold failures: " + wcagFailCount);

if (mismatchCount === 0 && wcagFailCount === 0) {
  console.log("RESULT: ALL PASS");
  process.exit(0);
} else {
  console.log("RESULT: FAILURES FOUND — spec側/実装側どちらが正しいか要調査。自動で書き換えない。");
  process.exit(1);
}
