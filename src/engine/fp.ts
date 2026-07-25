// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 固定小数点(スケール 1e6)演算層 — ADR-006 / GDD 11.7
//
// このモジュールは engine の全数値演算の土台であり、「同じ入力なら world 上の
// どのブラウザ/Node でも 1 bit 違わない」ことを型と実行時検査で担保する層である。
// 浮動小数の暗黙丸めを engine から締め出すのが目的なので、ここを迂回して素の
// number で算術する経路を作ってはならない。
//
// ===========================================================================
// 1. スケールと丸め規約(GDD 11.7)
// ===========================================================================
//   全数値は 1e6 固定スケールの整数(以下 raw)で保持する。人間可読値 v に対し
//   raw = v * 1e6。除算は常に floor(−∞方向)で、trunc(0方向)は使わない。
//   複合式は「各乗算後に都度スケール補正 + floor 丸め」の順序に固定する
//   = mulFix を積み重ねること。a*b*c を素の整数で作ってから最後に一度だけ
//   スケール補正する書き方は、丸め位置が変わるため禁止(式の評価順が変わると
//   golden vector が壊れる)。
//
// ===========================================================================
// 2. Fix の不変条件
// ===========================================================================
//   Fix は「安全整数の範囲に収まる raw 値」を表す branded number:
//     (a) Number.isSafeInteger(raw) === true   (|raw| <= 2^53-1)
//     (b) raw は -0 でない(-0 は常に +0 へ正規化する。JSON 往復で符号が消える
//         ため -0 を状態に残すと round-trip 前後で Object.is が食い違う)
//   生成口は fixFromRaw / fixFromInt と本モジュールの演算結果だけであり、
//   いずれも結果値域を asFix で検査する。よって各演算は入力を再検証しない
//   = 型検査が唯一の入口ガードである(brand を as で偽造しないこと)。
//   engine 外(content ロード・セーブ復元・UI 入力)から来た値は必ず
//   fixFromRaw / fixFromInt を通してから Fix として扱う。
//   値域違反・0 除算は例外(FixRangeError / FixDivisionByZeroError)で停止する。
//   例外は入力の純関数なので決定論を壊さない。黙って飽和させると状態が静かに
//   分岐するため、検知して止める方を取る(ADR-006「累算器で saturating 検知」)。
//
// ===========================================================================
// 3. 補題(number 経路が厳密である根拠)
// ===========================================================================
// L1【除算前ガードの健全性】
//   a, b を安全整数、P = a*b(数学的真値)、p = fl(a*b)(倍精度の丸め結果)と
//   する。IEEE754 の最近接丸めは単調(x <= y ⇒ fl(x) <= fl(y))で、2^53 は
//   倍精度で厳密表現できる。したがって |P| >= 2^53 ⇒ |p| >= 2^53。
//   対偶を取ると |p| <= 2^53-1 ⇒ |P| < 2^53 であり、このとき P は 2^53 未満の
//   整数なので厳密表現可能、すなわち p = P(丸め誤差ゼロ)。
//   ⇒「除算する前に |p| <= MAX_SAFE を検査して通れば中間積は厳密」が言える。
//   P が倍精度の範囲を超えて Infinity になる場合も |p| >= 2^53 側に落ちる。
//   旧設計(除算後に 2^53 を検査)はこの含意を持たない。例: a=1e9, b=1e12 raw
//   では p ≈ 1e21 が既に丸められており、/1e6 した 1e15 は 2^53 未満なので
//   検査を通過しながら値が誤る(ADR-006 が撤回した fatal そのもの)。
//   本モジュールの number 経路は必ず「除算前」に検査する。
//
// L2【number 経路の floor 除算が厳密】
//   n を |n| <= 2^53-1 の整数、d を 0 でない整数とすると、Math.floor(n / d) は
//   数学的な floor(n/d) に厳密一致する。
//   証明: q = n/d が整数なら |q| <= |n| < 2^53 で厳密表現可能、IEEE 除算は
//   正確丸めなので fl(q) = q。q が非整数なら、n = d*m + s(m = floor(n/d),
//   0 < |s| < |d|)より小数部 f は f >= 1/|d| かつ 1-f >= 1/|d| を満たす。
//   一方 fl の絶対誤差は |q| * 2^-53 <= (|n|/|d|) * 2^-53 < (2^53/|d|) * 2^-53
//   = 1/|d|(|q| >= 1/|d| >= 2^-53 なので正規化数域、指数下限の心配はない)。
//   誤差が隣接整数までの距離より真に小さいので floor は隣へ跨がない。
//   ⇒ 負数でも Math.floor が正しい floor を返すので、number 経路に符号補正は
//   不要。符号補正が要るのは BigInt 経路(BigInt の / は 0 方向 trunc)だけ。
//
// L3【加減算のオーバーフロー検出】
//   a, b を安全整数、S = a+b(真値)、s = fl(a+b) とすると、L1 と同じ単調性から
//   |S| >= 2^53 ⇒ |s| >= 2^53 ⇒ Number.isSafeInteger(s) === false。
//   対偶より isSafeInteger(s) が真なら |S| <= 2^53-1 かつ s = S(厳密)。
//   ⇒ 加減算は「結果に isSafeInteger を掛ける」だけで桁溢れを漏れなく検出でき、
//   入力の事前検査は不要。減算・累算(sumFix)も同様。
//
// L4【isqrt の中間値域】§7 の実装コメント参照。
//
// ===========================================================================
// 4. 値域証明済み経路 / 未証明経路の線引き(ADR-006 の中核)
// ===========================================================================
//   ADR-006 は「number 直演算は a*b < 2^53 が静的に証明できた式のみ、未証明の
//   全経路は BigInt 中間積を必須」と定める。本モジュールはこれを次の形で実装
//   する。呼び出し側は下記のどれを使うかで「証明済みか否か」を宣言すること。
//
//   [未証明経路] mulFix / floorDivFix / mulFixInt / sqrtFix (既定)
//       除算前ガード(L1)を通し、収まれば number、収まらなければ BigInt へ
//       フォールバックする。どんな入力でも常に厳密な値を返す。値域証明を
//       持たない経路は必ずこれを使う。証明が無い ⇒ 既定 API ⇒ 必要時に自動で
//       BigInt、が ADR-006 の「未証明経路は BigInt 必須」の実装形である。
//
//   [証明済み経路] mulFixProven
//       number 固定。ガードに掛かったら FixRangeError を投げる。先行計測で
//       ホットと判った式のうち、下記の証明を doc に書けたものだけを mulFix
//       から移す。黙って BigInt に落ちて遅くなる代わりに、証明が破れたことが
//       即座に露見する(性能特性が入力で変動しない)。
//
//   [BigInt 固定] mulFixBig / floorDivFixBig / isqrtBig
//       常に BigInt。巨大値が既知の経路と、テストのオラクル用。
//
//   ● 値域証明の書き方(呼び出し側の doc に必ず書く)
//     (1) 両オペランドの到達可能な絶対値上界 A, B と、その根拠
//         (schema の min/max 制約 / clamp / 型不変条件のいずれか。「たぶん
//          小さい」は根拠ではない)
//     (2) A * B <= 2^53 - 1 = 9007199254740991 の計算
//     根拠が content の schema 制約である場合、content 追加で証明が破れうる。
//     上界は schema 検証器の min/max と対で維持すること(片方だけ緩めない)。
//
//   ● number 経路が安全な入力範囲(早見表。すべて raw 値)
//     - 対称形    : |a|, |b| <= 94_906_265           (人間単位 ±94.906265)
//                   ※ 94_906_265 = floor(sqrt(2^53-1)) = FIX_MUL_SYMMETRIC_BOUND
//     - 係数 <= 2.0 (raw 2e6) × 量 : |量| <= 4_503_599_627  (人間単位 ±4503.5)
//     - 係数 <= 10.0(raw 1e7) × 量 : |量| <=   900_719_925  (人間単位 ±900.7)
//     - 係数 <= 100.0(raw 1e8)× 量 : |量| <=    90_071_992  (人間単位 ±90.07)
//     ⇒ 「資源ストック(人間単位で数千〜数万)× 係数」は number 経路では証明
//        できない。ストック系の乗算は mulFix(自動 BigInt)を使うこと。
//     ⇒ 一方「係数 × 係数」「率 × 率」(いずれも人間単位で高々数十)は対称形の
//        範囲に収まるので証明しやすい。
//
//   ● mulFix / mulFixProven / mulFixBig は全入力で同値を返す(mulFixProven は
//     同値を返すか FixRangeError を投げるかのいずれか)。この一致性は
//     tests/fp.spec.ts と tests/fp.property.spec.ts の差分テストで機械確認する。
//
// ===========================================================================
// 5. Math 許可リスト(ADR-006)
// ===========================================================================
//   本モジュールが使う Math は floor だけ(ECMA-262 が exact を規定)。
//   絶対値・min/max も Math ではなく比較演算で書いている(-0 の扱いを持ち込ま
//   ないため)。sqrt は correctly-rounded だが原則不使用の方針に従い、整数
//   ニュートン法 isqrt を自前実装している(§7)。pow/exp/log 等は
//   implementation-approximated でエンジン間 bit 不一致のため lint で禁止。
// ---------------------------------------------------------------------------

// --- 1. 型と定数 -----------------------------------------------------------

declare const FIX_BRAND: unique symbol;

/**
 * 1e6 固定小数点値。実体は raw 整数(人間可読値 * 1e6)だが、素の number と
 * 混ぜられないよう branded type にしてある。
 *
 * 不変条件: `Number.isSafeInteger(raw) === true` かつ raw は -0 でない。
 * 生成は {@link fixFromRaw} / {@link fixFromInt} と本モジュールの演算結果のみ。
 */
export type Fix = number & { readonly [FIX_BRAND]: "Fix" };

/** 固定小数点スケール。全数値共通で 1e6(GDD 11.7)。 */
export const FIX_SCALE = 1_000_000;

/** raw 値の絶対値上限 = 2^53-1。Fix の不変条件そのもの。 */
export const FIX_RAW_ABS_MAX = Number.MAX_SAFE_INTEGER;

/** 中間積ガードのしきい値。|中間積| がこれを超えたら BigInt 経路(L1)。 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const FIX_SCALE_BIG = 1_000_000n;
const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = -MAX_SAFE_BIG;

/**
 * mulFix の number 経路が対称形で安全な絶対値上界 = floor(sqrt(2^53-1))。
 * |a| <= この値 かつ |b| <= この値 なら |a*b| < 2^53 が保証される
 * (94_906_265^2 = 9_007_199_136_250_225 <= 2^53-1 < 94_906_266^2)。
 * 人間単位では ±94.906265。§4 の早見表を参照。
 */
export const FIX_MUL_SYMMETRIC_BOUND = 94_906_265;

/** fixFromInt が受け付ける人間単位整数の絶対値上限 = floor((2^53-1)/1e6)。 */
export const FIX_INT_ABS_MAX = 9_007_199_254;

/** 0.0 */
export const FIX_ZERO = 0 as Fix;

/** 1.0 */
export const FIX_ONE = FIX_SCALE as Fix;

/** raw 値の最大 (= 2^53-1、人間単位で約 9.007e9)。 */
export const FIX_MAX = FIX_RAW_ABS_MAX as Fix;

/** raw 値の最小 (= -(2^53-1))。値域は 0 を中心に対称。 */
export const FIX_MIN = -FIX_RAW_ABS_MAX as Fix;

// --- 2. 例外 ---------------------------------------------------------------

/**
 * 固定小数点の値域違反。中間積・結果が安全整数の範囲を外れた場合に投げる。
 * 入力の純関数なので決定論を壊さない(同じ入力なら必ず同じ例外)。
 */
export class FixRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixRangeError";
  }
}

/** 0 除算。floor 除算に 0 除数の定義は無いので必ず停止させる。 */
export class FixDivisionByZeroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixDivisionByZeroError";
  }
}

// --- 3. 内部ヘルパ ---------------------------------------------------------

/**
 * 演算結果を Fix の不変条件へ落とす唯一の口。
 * L3 より、結果に isSafeInteger を掛けるだけで加減算・乗算後の桁溢れを
 * 漏れなく検出できる。-0 は +0 へ正規化する(§2(b))。
 */
function asFix(raw: number, op: string): Fix {
  if (!Number.isSafeInteger(raw)) {
    throw new FixRangeError(`${op}: 結果 ${String(raw)} が安全整数の範囲(±(2^53-1))を外れた`);
  }
  // raw === 0 は -0 でも真。ここで +0 に畳む。
  return (raw === 0 ? 0 : raw) as Fix;
}

/** BigInt 経路の結果を Fix へ戻す。Number() は |v| <= 2^53-1 なら厳密。 */
function fixFromBig(value: bigint, op: string): Fix {
  if (value > MAX_SAFE_BIG || value < MIN_SAFE_BIG) {
    throw new FixRangeError(`${op}: 結果 ${value.toString()} が安全整数の範囲(±(2^53-1))を外れた`);
  }
  return Number(value) as Fix;
}

/**
 * BigInt の floor 除算。BigInt の `/` は 0 方向 trunc なので符号補正を入れる
 * (GDD 11.7「除算は floor 方向に統一」)。number 経路は L2 より Math.floor が
 * そのまま floor なので、補正が必要なのはこちら側だけ。
 */
function floorDivBig(n: bigint, d: bigint): bigint {
  const q = n / d;
  if (n % d !== 0n && n < 0n !== d < 0n) {
    return q - 1n;
  }
  return q;
}

/**
 * BigInt 経路に入る直前の入口検査。number 経路は Fix の不変条件(型)に依存して
 * 入力検査を省くが、ここは NaN/Infinity が紛れ込むと BigInt() が別種の例外を
 * 投げるので、フォールバック時にだけ支払う形で検査しておく。
 */
function requireSafeRaw(value: number, op: string, role: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new FixRangeError(`${op}: ${role} ${String(value)} が安全整数でない`);
  }
}

// --- 4. 生成と取り出し -----------------------------------------------------

/**
 * raw 値(1e6 スケール済み整数)から Fix を作る。content ロード・セーブ復元・
 * テストなど engine 外から来た数値の唯一の入口。
 *
 * @throws {FixRangeError} 安全整数でない場合(非整数・NaN・Infinity・範囲外)
 */
export function fixFromRaw(raw: number): Fix {
  return asFix(raw, "fixFromRaw");
}

/**
 * 人間単位の整数から Fix を作る(n * 1e6)。
 * |n| <= FIX_INT_ABS_MAX なら積は 2^53 未満なので厳密(L1)。
 *
 * @throws {FixRangeError} n が整数でない、または |n| > FIX_INT_ABS_MAX の場合
 */
export function fixFromInt(n: number): Fix {
  if (!Number.isSafeInteger(n) || n > FIX_INT_ABS_MAX || n < -FIX_INT_ABS_MAX) {
    throw new FixRangeError(`fixFromInt: ${String(n)} は ±${String(FIX_INT_ABS_MAX)} の整数でない`);
  }
  return asFix(n * FIX_SCALE, "fixFromInt");
}

/** Fix の raw 値(1e6 スケール整数)を取り出す。実行時は恒等。 */
export function toRaw(f: Fix): number {
  return f;
}

/**
 * 表示・ログ用の近似 number(raw / 1e6)。
 *
 * IEEE754 除算は正確丸めなので値自体は決定論的だが、10 進小数は一般に厳密
 * 表現できない。**この戻り値を engine の演算へ戻してはならない**(戻すと丸め
 * 誤差が状態へ入り込む)。Fix と別型(素の number)にしてあるのはその境界を
 * 型で示すため。
 */
export function toApproxNumber(f: Fix): number {
  return f / FIX_SCALE;
}

// --- 5. 加減算・比較・クランプ ---------------------------------------------

/**
 * 加算。L3 より結果の isSafeInteger 検査だけで桁溢れを漏れなく検出できる。
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function addFix(a: Fix, b: Fix): Fix {
  return asFix(a + b, "addFix");
}

/**
 * 減算。検出根拠は addFix と同じ(L3)。
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function subFix(a: Fix, b: Fix): Fix {
  return asFix(a - b, "subFix");
}

/** 符号反転。値域は対称なので常に成功する。 */
export function negFix(a: Fix): Fix {
  return asFix(-a, "negFix");
}

/** 絶対値。値域は対称なので常に成功する。 */
export function absFix(a: Fix): Fix {
  return asFix(a < 0 ? -a : a, "absFix");
}

/** 小さい方。Math.min を使わないのは -0 の扱いを持ち込まないため。 */
export function minFix(a: Fix, b: Fix): Fix {
  return a < b ? a : b;
}

/** 大きい方。Math.max を使わないのは -0 の扱いを持ち込まないため。 */
export function maxFix(a: Fix, b: Fix): Fix {
  return a > b ? a : b;
}

/**
 * lo..hi にクランプ。
 * @throws {FixRangeError} lo > hi の場合(呼び出し側の境界指定バグ)
 */
export function clampFix(value: Fix, lo: Fix, hi: Fix): Fix {
  if (lo > hi) {
    throw new FixRangeError(`clampFix: 下限 ${String(lo)} が上限 ${String(hi)} を超えている`);
  }
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * 総和。ADR-006 の「累算器で saturating 検知」に対応し、**各ステップで**桁溢れ
 * を検査する(最後にまとめて検査すると、途中で 2^53 を超えて精度を失った後に
 * 戻ってきた場合を取り逃す)。
 *
 * 加算順序は結果に影響する(floor 丸めは既に済んでいるので結合律自体は保たれる
 * が、途中の値域検査が順序依存)。GDD 11.7 の通り、集合演算は安定 ID の辞書順に
 * ソートした配列を渡すこと。
 *
 * @throws {FixRangeError} 途中経過または結果が安全整数の範囲を外れた場合
 */
export function sumFix(values: readonly Fix[]): Fix {
  let acc = 0;
  for (const v of values) {
    acc = asFix(acc + v, "sumFix");
  }
  return asFix(acc, "sumFix");
}

// --- 6. 乗除算(中間積ガードと BigInt 分岐) --------------------------------

/**
 * 固定小数点の乗算 = floor(a * b / 1e6)。**値域証明を持たない経路の既定 API**。
 *
 * 中間積 a*b を **除算前に** 2^53 境界で検査し(L1)、収まれば number 経路
 * (L2 より floor 除算も厳密)、収まらなければ BigInt 中間積へフォールバック
 * する。どんな入力でも数学的に厳密な floor((a*b)/1e6) を返す。
 *
 * number 経路が使える入力範囲と、証明の書き方はファイル冒頭 §4 を参照。
 * ホットパスで値域証明を書けた式だけを {@link mulFixProven} に移すこと。
 *
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function mulFix(a: Fix, b: Fix): Fix {
  // 中間積(除算前)。L1 より、この検査を通れば product は厳密。
  const product = a * b;
  if (product <= MAX_SAFE && product >= -MAX_SAFE) {
    return asFix(Math.floor(product / FIX_SCALE), "mulFix");
  }
  return mulFixBig(a, b);
}

/**
 * 固定小数点の乗算(**値域証明済みホットパス専用**、number 固定)。
 *
 * 呼び出し側は「両オペランドの到達可能上界の積が 2^53 未満」であることを doc に
 * 明記していること(§4 の証明の書き方)。証明が破れると黙って遅くなるのではなく
 * FixRangeError で露見する。証明が無い経路では使わず {@link mulFix} を使う。
 *
 * @throws {FixRangeError} 中間積が 2^53 境界を超えた場合(= 値域証明が破れた)
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function mulFixProven(a: Fix, b: Fix): Fix {
  const product = a * b;
  if (product > MAX_SAFE || product < -MAX_SAFE) {
    throw new FixRangeError(
      `mulFixProven: 値域証明が破れた(中間積 ${String(a)} * ${String(b)} が 2^53 境界を超過)。` +
        `この呼び出し側の上界の根拠を見直すか mulFix へ戻すこと`,
    );
  }
  return asFix(Math.floor(product / FIX_SCALE), "mulFixProven");
}

/**
 * 固定小数点の乗算(**常に BigInt 中間積**)。巨大値が既知の経路と、テストの
 * オラクル用。{@link mulFix} と全入力で同値。
 *
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function mulFixBig(a: Fix, b: Fix): Fix {
  requireSafeRaw(a, "mulFixBig", "被乗数");
  requireSafeRaw(b, "mulFixBig", "乗数");
  return fixFromBig(floorDivBig(BigInt(a) * BigInt(b), FIX_SCALE_BIG), "mulFixBig");
}

/**
 * Fix と「無次元の整数」の乗算 = a * k。スケール補正が入らないので、
 * mulFix(a, fixFromInt(k)) より 1e6 倍だけ中間積が小さい = number 経路に
 * 収まりやすい。人数・個数・tick 数を掛けるときはこちらを使う。
 *
 * 中間積は除算前ガードと同じ 2^53 検査を通り(L1)、超えたら BigInt へ落ちる。
 *
 * @throws {FixRangeError} k が安全整数でない、または結果が範囲外の場合
 */
export function mulFixInt(a: Fix, k: number): Fix {
  requireSafeRaw(k, "mulFixInt", "整数係数");
  const product = a * k;
  if (product <= MAX_SAFE && product >= -MAX_SAFE) {
    return asFix(product, "mulFixInt");
  }
  requireSafeRaw(a, "mulFixInt", "被乗数");
  return fixFromBig(BigInt(a) * BigInt(k), "mulFixInt");
}

/**
 * 固定小数点の除算 = floor(a * 1e6 / b)(floor 方向・GDD 11.7)。
 *
 * 中間積 a*1e6 を **除算前に** 2^53 境界で検査し(L1)、収まれば number 経路
 * (L2 より Math.floor がそのまま floor なので符号補正は不要)、収まらなければ
 * BigInt 経路(こちらは trunc なので floorDivBig で符号補正する)。
 * |a| > 9_007_199_254(人間単位 9007.2)で必ず BigInt 経路に落ちる。
 *
 * @throws {FixDivisionByZeroError} b が 0 の場合
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function floorDivFix(a: Fix, b: Fix): Fix {
  if (b === 0) {
    throw new FixDivisionByZeroError(`floorDivFix: 除数が 0(被除数 ${String(a)})`);
  }
  // 中間積(除算前)。
  const numerator = a * FIX_SCALE;
  if (numerator <= MAX_SAFE && numerator >= -MAX_SAFE) {
    return asFix(Math.floor(numerator / b), "floorDivFix");
  }
  return floorDivFixBig(a, b);
}

/**
 * 固定小数点の除算(**常に BigInt 中間積**)。{@link floorDivFix} と全入力で同値。
 *
 * @throws {FixDivisionByZeroError} b が 0 の場合
 * @throws {FixRangeError} 結果が安全整数の範囲を外れた場合
 */
export function floorDivFixBig(a: Fix, b: Fix): Fix {
  if (b === 0) {
    throw new FixDivisionByZeroError(`floorDivFixBig: 除数が 0(被除数 ${String(a)})`);
  }
  requireSafeRaw(a, "floorDivFixBig", "被除数");
  requireSafeRaw(b, "floorDivFixBig", "除数");
  return fixFromBig(floorDivBig(BigInt(a) * FIX_SCALE_BIG, BigInt(b)), "floorDivFixBig");
}

/**
 * 素の整数どうしの floor 除算(スケール補正なし)。tick 計算・個数按分など、
 * Fix ではない整数を floor 方向に割るための共通実装。
 *
 * L2 より、安全整数どうしなら Math.floor(a/b) が負数でも厳密な floor を返す
 * (JS の `/` + Math.floor は trunc ではないので追加の符号補正は不要)。
 * 結果の絶対値は |a| 以下なので値域を出ることはない。
 *
 * @throws {FixDivisionByZeroError} b が 0 の場合
 * @throws {FixRangeError} a または b が安全整数でない場合
 */
export function floorDivInt(a: number, b: number): number {
  if (b === 0) {
    throw new FixDivisionByZeroError(`floorDivInt: 除数が 0(被除数 ${String(a)})`);
  }
  requireSafeRaw(a, "floorDivInt", "被除数");
  requireSafeRaw(b, "floorDivInt", "除数");
  const q = Math.floor(a / b);
  return q === 0 ? 0 : q;
}

// --- 7. 平方根(整数ニュートン法) ------------------------------------------

/**
 * 整数平方根 floor(sqrt(n))。Math.sqrt は ADR-006 の方針(原則不使用)により
 * 使わず、整数ニュートン法で厳密に求める。
 *
 * L4【中間値域の証明】
 *   初期値 x0 は「x*x <= n を満たす最大の 2 冪の 2 倍」= 2^ceil(bitlen(n)/2) で、
 *   n <= 2^53-1 より x0 <= 2^27、かつ x0 > sqrt(n)。ループ中の x*x は 2 冪の
 *   平方(<= 2^54)なので厳密に表現でき比較も厳密。
 *   反復 x' = floor((x + floor(n/x)) / 2) は x0 >= isqrt(n) から始めると
 *   常に x >= isqrt(n) を保ちつつ単調減少し、isqrt(n) に到達して停止する
 *   (整数平方根の標準アルゴリズム。Cohen, A Course in Computational Algebraic
 *   Number Theory, Algorithm 1.7.1)。
 *   x >= isqrt(n) の間 floor(n/x) <= n/isqrt(n) < isqrt(n) + 2 <= 2^26.5 + 2 なので
 *   和 x + floor(n/x) < 2^28 で厳密、2 での除算は指数の増減のみで厳密、
 *   n/x の floor は L2 より厳密。したがって全中間値が厳密整数のまま進む。
 *
 * @param n 0 以上の安全整数
 * @throws {FixRangeError} n が安全整数でない、または負の場合
 */
export function isqrt(n: number): number {
  requireSafeRaw(n, "isqrt", "被開平数");
  if (n < 0) {
    throw new FixRangeError(`isqrt: 負数 ${String(n)} の平方根は定義しない`);
  }
  // n === 0 の分岐は -0 を +0 へ畳むため(§2(b))。
  if (n < 2) return n === 0 ? 0 : n;

  // x0 = 2^ceil(bitlen(n)/2) > sqrt(n)。x*x は 2 冪の平方なので厳密。
  let x = 1;
  while (x * x <= n) {
    x *= 2;
  }

  for (;;) {
    const next = Math.floor((x + Math.floor(n / x)) / 2);
    if (next >= x) return x;
    x = next;
  }
}

/**
 * 整数平方根(BigInt 版)。{@link isqrt} の値域外(2^53 以上)を扱う内部経路と
 * テストのオラクル用。アルゴリズムと停止性は isqrt と同じ。
 *
 * @throws {FixRangeError} n が負の場合
 */
export function isqrtBig(n: bigint): bigint {
  if (n < 0n) {
    throw new FixRangeError(`isqrtBig: 負数 ${n.toString()} の平方根は定義しない`);
  }
  if (n < 2n) return n;

  let x = 1n;
  while (x * x <= n) {
    x <<= 1n;
  }

  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

/**
 * 固定小数点の平方根 = floor(sqrt(a) をスケール込みで評価した値)。
 *
 * 人間可読値 v = a/1e6 に対し sqrt(v) を Fix で表すと
 * floor(sqrt(v) * 1e6) = floor(sqrt(a * 1e6)) なので、中間値 a*1e6 を作ってから
 * 整数平方根を取る。中間値は除算前ガードと同じ 2^53 検査を通り(L1)、
 * |a| > 9_007_199_254(人間単位 9007.2)で BigInt 経路に落ちる。
 * 結果は最大でも sqrt((2^53-1)*1e6) ≈ 9.49e10 なので値域を出ることはない。
 *
 * @throws {FixRangeError} a が負の場合
 */
export function sqrtFix(a: Fix): Fix {
  if (a < 0) {
    throw new FixRangeError(`sqrtFix: 負数 ${String(a)} の平方根は定義しない`);
  }
  const scaled = a * FIX_SCALE;
  if (scaled <= MAX_SAFE) {
    return asFix(isqrt(scaled), "sqrtFix");
  }
  requireSafeRaw(a, "sqrtFix", "被開平数");
  return fixFromBig(isqrtBig(BigInt(a) * FIX_SCALE_BIG), "sqrtFix");
}
