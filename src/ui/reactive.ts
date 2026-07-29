// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- UI 反応系プリミティブ — ADR-002 / ADR-027 / ADR-001
//
// 単一ストア(store.ts)の「派生値」を支える最小の signal / computed / effect。
//
// ===========================================================================
// 1. なぜ自前実装なのか(@preact/signals を入れない理由)
// ===========================================================================
//   ADR-001「依存最小」により新規 npm 依存を足さない。`preact` 本体は
//   devDependencies にあるが `@preact/signals` は入っておらず、追加は
//   ユーザー判断事項(docs/design/architecture.md §9)。ルータも自前(ADR-027(1))
//   なのと同じ理由で、反応系も本ファイル 1 枚(数百行)で閉じる。
//
//   実装は Preact signals / Solid と同じ **遅延 pull + 3 色(clean/check/dirty)
//   伝播**である。API も `.value` / `.peek()` に合わせてあるので、将来
//   @preact/signals を採用する場合は本ファイルを差し替えるだけで済む
//   (差し替え点を 1 ファイルに閉じ込めることが目的)。
//
// ===========================================================================
// 2. 「遅延 pull」であることが ADR-027 の要件そのもの
// ===========================================================================
//   computed は**読まれるまで計算しない**。よって非アクティブ画面が
//   アンマウントされて effect が dispose されれば、その画面が使っていた
//   computed は「dirty の印が付くだけ」で二度と評価されない(ADR-027(2)
//   「非表示画面の computed が裏で評価され続ける」経路の排除)。
//
//   印付け(notify)は O(観測者数) の定数作業であり、しかも既に dirty/check の
//   ノードで打ち切られる。**再計算(fn の実行)回数**が ADR-002(2) の
//   fan-in 上界の対象であり、それを直接数えられるように
//   {@link ReadonlyComputed.recomputeCount} を公開している(テストの検収条件)。
//
// ===========================================================================
// 3. 3 色伝播:「無効化されたが値は変わらなかった」を再計算に化けさせない
// ===========================================================================
//   signal が変わると、直接の観測者は **dirty**(再計算確定)、その先の
//   observer は **check**(要確認)になる。check のノードは読まれたときに
//   「依存の version が本当に変わったか」だけを見て、変わっていなければ
//   再計算せず clean に戻る。
//
//   この性質が無いと、例えば「セル 3 の施設 Lv だけ変えた」ときに
//   セル 3 の隣接 computed(値は不変)を経由して下流が芋づる式に再計算され、
//   fan-in 上界の主張が崩れる。
//
// ===========================================================================
// 4. 等価判定(equals)の既定は Object.is
// ===========================================================================
//   GameState は構造共有(ADR-028(1))なので「変わっていない部分は参照同一」。
//   つまり既定の参照比較だけで大半の無駄な伝播が消える。オブジェクトを
//   毎回作り直す派生値(ビューモデル等)には個別に equals を渡して、
//   下流への伝播を値の意味で止める。
// ---------------------------------------------------------------------------

/** 反応系の使い方の誤り(循環依存・dispose 後の使用・効果の発散など)。 */
export class ReactiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReactiveError";
  }
}

/** 値の等価判定。true を返した更新は伝播しない。 */
export type Equals<T> = (a: T, b: T) => boolean;

/** 購読の解除。 */
export type Dispose = () => void;

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;
type NodeStatus = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** 値を提供する側(signal / computed)。 */
interface Producer {
  readonly observers: Set<Consumer>;
  /** 値が**実際に変わった**ときだけ増える。check の判定に使う。 */
  readonly version: number;
  /** 依存として読まれる直前に最新化する(signal は何もしない)。 */
  refresh(): void;
  /** デバッグ表示用の名前。 */
  readonly name: string;
}

/** 値を読む側(computed / effect)。 */
interface Consumer {
  notify(status: NodeStatus): void;
}

/** 依存を記録する読み手。 */
interface TrackingConsumer extends Consumer {
  readonly sources: Map<Producer, number>;
}

// --- 1. 大域状態(トラッキング文脈と effect キュー) -------------------------

let activeConsumer: TrackingConsumer | null = null;
let batchDepth = 0;
let flushing = false;
const effectQueue: EffectNode[] = [];

/** effect が自分自身を再スケジュールし続ける発散を検出する上限。 */
const MAX_FLUSH_ITERATIONS = 10_000;

let signalWriteCount = 0;
let recomputeCount = 0;
let effectRunCount = 0;

/** 反応系の大域カウンタ(計測・テスト用)。 */
export interface ReactiveStats {
  /** 値が実際に変わった signal 書き込みの回数。 */
  readonly signalWrites: number;
  /** computed の本体関数を実行した回数(= 派生値の再計算回数)。 */
  readonly recomputes: number;
  /** effect の本体関数を実行した回数。 */
  readonly effectRuns: number;
}

export function getReactiveStats(): ReactiveStats {
  return { signalWrites: signalWriteCount, recomputes: recomputeCount, effectRuns: effectRunCount };
}

/** 大域カウンタを 0 に戻す(テストの区間計測用。本番経路では呼ばない)。 */
export function resetReactiveStats(): void {
  signalWriteCount = 0;
  recomputeCount = 0;
  effectRunCount = 0;
}

function trackRead(producer: Producer, version: number): void {
  const consumer = activeConsumer;
  if (consumer === null) return;
  consumer.sources.set(producer, version);
  producer.observers.add(consumer);
}

/**
 * トラッキング文脈を差し替えて fn を実行する(依存の記録先を consumer にする)。
 * `activeConsumer = this` を各所に書かず 1 箇所へ集める。
 */
function runTracked<T>(consumer: TrackingConsumer, fn: () => T): T {
  const previous = activeConsumer;
  activeConsumer = consumer;
  try {
    return fn();
  } finally {
    activeConsumer = previous;
  }
}

function unlinkSources(consumer: TrackingConsumer): void {
  for (const producer of consumer.sources.keys()) {
    producer.observers.delete(consumer);
  }
  consumer.sources.clear();
}

/**
 * 記録した依存のうち 1 つでも version が変わっていれば true。
 * computed の依存は先に refresh してから比較する(推移的な最新化)。
 */
function anySourceChanged(consumer: TrackingConsumer): boolean {
  for (const [producer, seenVersion] of consumer.sources) {
    producer.refresh();
    if (producer.version !== seenVersion) return true;
  }
  return false;
}

/**
 * effect を実行待ちに積む。**ここでは flush しない**。
 *
 * 積んだ場でいきなり実行すると「通知ループの最中に effect が依存を張り替え、
 * 通知元の observers Set が反復中に変化する」という再入が起きる(Set は
 * 反復中に delete → add された要素をもう一度訪れるので、購読を張り直す
 * effect が無限ループになる)。flush は書き込みの通知が全部終わってから、
 * {@link Signal.set} / {@link batch} の末尾で 1 回だけ行う。
 */
function scheduleEffect(node: EffectNode): void {
  effectQueue.push(node);
}

/** 観測者へ通知する。反復中の再購読で Set が変化しても安全なようスナップショットを取る。 */
function notifyObservers(observers: ReadonlySet<Consumer>, status: NodeStatus): void {
  if (observers.size === 0) return;
  for (const observer of [...observers]) {
    observer.notify(status);
  }
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  let iterations = 0;
  try {
    while (effectQueue.length > 0) {
      iterations++;
      if (iterations > MAX_FLUSH_ITERATIONS) {
        throw new ReactiveError(
          `effect の実行が ${String(MAX_FLUSH_ITERATIONS)} 回を超えた(effect が自分の依存を書き換えて発散している)`,
        );
      }
      const node = effectQueue.shift();
      if (node === undefined) break;
      node.runIfNeeded();
    }
  } finally {
    effectQueue.length = 0;
    flushing = false;
  }
}

/**
 * まとめて書き込み、effect の実行を末尾 1 回にする。
 * ストアの dispatch は必ずこの中で state を差し替える(store.ts)。
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushEffects();
  }
}

/** 依存として記録せずに読む(コマンド組み立て等、購読したくない読み出し)。 */
export function untracked<T>(fn: () => T): T {
  const previous = activeConsumer;
  activeConsumer = null;
  try {
    return fn();
  } finally {
    activeConsumer = previous;
  }
}

// --- 2. 読み取り専用の公開型 -----------------------------------------------

/**
 * 読み取り専用の値ノード。UI コンポーネントが受け取るのは常にこの型であり、
 * `set` は持たない(書き込み口はストアの dispatch 1 本・ADR-002)。
 */
export interface ReadonlySignal<T> {
  /** 依存として記録しつつ読む。 */
  readonly value: T;
  /** 依存として記録せずに読む。 */
  peek(): T;
  /** 値の変化を購読する(内部的には effect 1 個)。 */
  subscribe(run: (value: T) => void): Dispose;
  readonly name: string;
}

/** 派生値ノード。再計算回数と依存数を公開する(fan-in 上界のテスト用)。 */
export interface ReadonlyComputed<T> extends ReadonlySignal<T> {
  /** 本体関数を実行した回数。ADR-002(2) の検収条件はこの値で測る。 */
  readonly recomputeCount: number;
  /** 直近の計算で実際に読んだ依存の数(= fan-in)。 */
  readonly dependencyCount: number;
}

export interface SignalOptions<T> {
  readonly equals?: Equals<T>;
  readonly name?: string;
}

// --- 3. signal(根の可変ノード) --------------------------------------------

/**
 * 根の可変ノード。**ストアの外へ Signal 型のまま渡さないこと**
 * (公開面は {@link ReadonlySignal})。書き込みは store.dispatch 経由に限る。
 */
export class Signal<T> implements Producer, ReadonlySignal<T> {
  readonly observers = new Set<Consumer>();
  version = 0;
  readonly name: string;
  private current: T;
  private readonly equalsFn: Equals<T>;

  constructor(initial: T, options: SignalOptions<T> = {}) {
    this.current = initial;
    this.equalsFn = options.equals ?? Object.is;
    this.name = options.name ?? "signal";
  }

  /** 根なので常に最新。{@link Producer} の口を満たすだけの no-op。 */
  refresh(): void {
    // 何もしない(根の値は常に最新)。
  }

  get value(): T {
    trackRead(this, this.version);
    return this.current;
  }

  peek(): T {
    return this.current;
  }

  /**
   * 値を差し替える。**等価なら何もしない**(伝播も version 増加も起きない)。
   *
   * @returns 実際に変化したか
   */
  set(next: T): boolean {
    if (this.equalsFn(this.current, next)) return false;
    this.current = next;
    this.version++;
    signalWriteCount++;
    notifyObservers(this.observers, DIRTY);
    if (batchDepth === 0) flushEffects();
    return true;
  }

  subscribe(run: (value: T) => void): Dispose {
    return createEffect(() => {
      run(this.value);
    });
  }
}

// --- 4. computed(派生値) ---------------------------------------------------

export type ComputedOptions<T> = SignalOptions<T>;

class ComputedNode<T> implements Producer, TrackingConsumer, ReadonlyComputed<T> {
  readonly observers = new Set<Consumer>();
  readonly sources = new Map<Producer, number>();
  version = 0;
  recomputeCount = 0;
  readonly name: string;
  private status: NodeStatus = DIRTY;
  private computing = false;
  private disposed = false;
  private hasValue = false;
  private current: T | undefined = undefined;
  private readonly equalsFn: Equals<T>;
  private readonly compute: () => T;

  // パラメータプロパティ(`constructor(private x)`)は使わない: node の
  // `--experimental-strip-types`(tools/ の TS 直実行に使っている)が
  // 型を消すだけの変換しかできず、この構文だけ動かないため。
  constructor(compute: () => T, options: ComputedOptions<T> = {}) {
    this.compute = compute;
    this.equalsFn = options.equals ?? Object.is;
    this.name = options.name ?? "computed";
  }

  get dependencyCount(): number {
    return this.sources.size;
  }

  notify(status: NodeStatus): void {
    if (this.disposed) return;
    if (this.status >= status) return;
    const wasClean = this.status === CLEAN;
    this.status = status;
    // clean → 汚れた瞬間だけ下流へ「要確認」を配る。既に汚れているノードの
    // 下流は前回配布済みなので、伝播はグラフ 1 回ぶんに収まる。
    if (wasClean) {
      notifyObservers(this.observers, CHECK);
    }
  }

  refresh(): void {
    if (this.disposed) {
      throw new ReactiveError(
        `computed "${this.name}" は dispose 済み(画面スコープ外からの読み出し)`,
      );
    }
    if (this.status === CLEAN && this.hasValue) return;
    if (this.computing) {
      throw new ReactiveError(`computed "${this.name}" が自分自身に依存している(循環)`);
    }
    if (this.status === CHECK && this.hasValue) {
      if (!anySourceChanged(this)) {
        this.status = CLEAN;
        return;
      }
    }
    this.recompute();
  }

  private recompute(): void {
    unlinkSources(this);
    const compute = this.compute;
    this.computing = true;
    let next: T;
    try {
      next = runTracked(this, compute);
    } finally {
      this.computing = false;
    }
    recomputeCount++;
    this.recomputeCount++;
    if (!this.hasValue || !this.equalsFn(this.current as T, next)) {
      this.current = next;
      this.version++;
    }
    this.hasValue = true;
    this.status = CLEAN;
  }

  get value(): T {
    this.refresh();
    const value = this.currentValue();
    trackRead(this, this.version);
    return value;
  }

  peek(): T {
    this.refresh();
    return this.currentValue();
  }

  private currentValue(): T {
    if (!this.hasValue) {
      throw new ReactiveError(`computed "${this.name}" の値が未確定(refresh の実装不整合)`);
    }
    return this.current as T;
  }

  subscribe(run: (value: T) => void): Dispose {
    return createEffect(() => {
      run(this.value);
    });
  }

  /** 画面スコープの破棄で呼ぶ。依存グラフから切り離してキャッシュを捨てる。 */
  dispose(): void {
    if (this.disposed) return;
    unlinkSources(this);
    this.observers.clear();
    this.disposed = true;
    this.hasValue = false;
    this.current = undefined;
  }
}

/** 破棄できる派生値。画面スコープが抱えるのはこちら。 */
export interface DisposableComputed<T> extends ReadonlyComputed<T> {
  dispose(): void;
}

/** 派生値を作る。**読まれるまで計算されない**(§2)。 */
export function computed<T>(
  compute: () => T,
  options: ComputedOptions<T> = {},
): DisposableComputed<T> {
  return new ComputedNode(compute, options);
}

// --- 5. effect(購読) -------------------------------------------------------

class EffectNode implements TrackingConsumer {
  readonly sources = new Map<Producer, number>();
  private status: NodeStatus = DIRTY;
  private disposed = false;
  private readonly run: () => void;

  constructor(run: () => void) {
    this.run = run;
  }

  notify(status: NodeStatus): void {
    if (this.disposed) return;
    if (this.status >= status) return;
    this.status = status;
    scheduleEffect(this);
  }

  runIfNeeded(): void {
    if (this.disposed) return;
    if (this.status === CLEAN) return;
    if (this.status === CHECK && !anySourceChanged(this)) {
      this.status = CLEAN;
      return;
    }
    this.execute();
  }

  execute(): void {
    unlinkSources(this);
    const run = this.run;
    runTracked(this, run);
    effectRunCount++;
    this.status = CLEAN;
  }

  dispose(): void {
    if (this.disposed) return;
    unlinkSources(this);
    this.disposed = true;
  }
}

/**
 * 依存が変わったら再実行される購読を作る。作成時に 1 回実行する。
 *
 * **戻り値の dispose を必ず呼ぶこと**(ADR-027(2): 非アクティブ画面の
 * 購読解除)。画面から使う場合は {@link ReactiveScope} 経由が既定。
 */
export function createEffect(run: () => void): Dispose {
  const node = new EffectNode(run);
  node.execute();
  return () => {
    node.dispose();
  };
}

// --- 6. スコープ(画面のマウント単位) ---------------------------------------

/**
 * 購読と画面ローカル派生値の寿命をまとめて扱う入れ物(ADR-027(2))。
 * 画面のマウントで 1 個作り、アンマウントで dispose する。
 */
export class ReactiveScope {
  private readonly disposers: Dispose[] = [];
  private disposed = false;
  readonly name: string;

  constructor(name = "scope") {
    this.name = name;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** このスコープが抱えている購読/派生値の数。 */
  get size(): number {
    return this.disposers.length;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new ReactiveError(`スコープ "${this.name}" は dispose 済み(アンマウント後の購読追加)`);
    }
  }

  effect(run: () => void): Dispose {
    this.assertLive();
    const dispose = createEffect(run);
    this.disposers.push(dispose);
    return dispose;
  }

  computed<T>(compute: () => T, options: ComputedOptions<T> = {}): ReadonlyComputed<T> {
    this.assertLive();
    const node = computed(compute, options);
    this.disposers.push(() => {
      node.dispose();
    });
    return node;
  }

  /** 外部リソース(タイマ解除等)もスコープに載せる。 */
  add(dispose: Dispose): void {
    this.assertLive();
    this.disposers.push(dispose);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // 後から足したものを先に外す(依存の向きに素直な順序)。
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      const dispose = this.disposers[i];
      if (dispose !== undefined) dispose();
    }
    this.disposers.length = 0;
  }
}
