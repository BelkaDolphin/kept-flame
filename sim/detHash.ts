// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- sim bot 用の決定論ハッシュ(固定規則) — 先行計測計画 §2.1 P2
//
// bot の意思決定(配属替え・派遣の代表負荷)を決定論にする方法として、T9 指示書は
// 「rng ドメイン or 固定規則」の 2 択を挙げている。ここでは後者(固定規則)を
// 採る: `src/engine/rng/domainTags.ts` は人間専用(CODEOWNERS・ADR-024(2))であり、
// sim 専用の新規ドメインをそこへ追加しない方針のため、bot は
// `hash(worldSeedU32, tick, label)` という**GameState.rngState を一切消費しない**
// 純関数のハッシュだけで決定論を得る。engine の FNV-1a-32 実装を再利用するので、
// ハッシュ実装自体を二重に持つことはない。
// ---------------------------------------------------------------------------

import { fnv1a32, fnv1a32Uint32 } from "../src/engine/rng/fnv1a32";
import { UINT32_SPAN } from "../src/engine/stochastic";

/**
 * `hash(worldSeedU32, tick, label)` → uint32。bot の意思決定の入力にする。
 * 同じ引数なら常に同じ値(GameState.rngState を読み書きしない = 遅延初期化や
 * ドメインレジストリと無関係に決定論)。
 */
export function botDecisionHash(worldSeedU32: number, tick: number, label: string): number {
  const withTick = fnv1a32Uint32(worldSeedU32 >>> 0, tick >>> 0);
  return fnv1a32(label, withTick);
}

/**
 * uint32 の draw を [0, 100) のパーセンタイルへ落とす(しきい値判定用)。
 * `floor(draw * 100 / 2^32)`。中間積 `draw * 100` は最大でも
 * `(2^32-1) * 100 ≈ 4.29e11 < 2^53-1` なので float 乗算でも厳密(倍精度の
 * 乗算・除算は IEEE754 で正確丸めが規定されており、engine の fp.ts が使う
 * 論法と同じ)。
 */
export function hashPercent(drawUint32: number): number {
  return Math.floor(((drawUint32 >>> 0) * 100) / UINT32_SPAN);
}
