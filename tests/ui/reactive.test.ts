// ---------------------------------------------------------------------------
// UI 反応系プリミティブ(src/ui/reactive.ts)の単体テスト。
//
// ここで固定するのは「ADR-002(2) の fan-in 上界と ADR-027(2) の購読解除が
// 成り立つための土台の性質」であり、具体的には
//   (a) computed は読まれるまで計算されない(遅延)
//   (b) 無効化されても値が変わらなければ下流は再計算されない(3 色伝播)
//   (c) dispose した購読は二度と走らない
// の 3 点である。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  ReactiveError,
  ReactiveScope,
  Signal,
  batch,
  computed,
  createEffect,
  getReactiveStats,
  untracked,
} from "../../src/ui/reactive";

describe("Signal", () => {
  it("初期値を読める(value / peek で同じ)", () => {
    const s = new Signal(3);
    expect(s.value).toBe(3);
    expect(s.peek()).toBe(3);
  });

  it("set は変化があった場合だけ true を返し version を進める", () => {
    const s = new Signal(1);
    const before = s.version;
    expect(s.set(1)).toBe(false);
    expect(s.version).toBe(before);
    expect(s.set(2)).toBe(true);
    expect(s.version).toBe(before + 1);
  });

  it("カスタム equals が等価と判定した書き込みは伝播しない", () => {
    const s = new Signal({ n: 1 }, { equals: (a, b) => a.n === b.n });
    let runs = 0;
    const dispose = createEffect(() => {
      void s.value;
      runs++;
    });
    expect(runs).toBe(1);
    s.set({ n: 1 });
    expect(runs).toBe(1);
    s.set({ n: 2 });
    expect(runs).toBe(2);
    dispose();
  });

  it("subscribe は現在値を受け取り、dispose 後は呼ばれない", () => {
    const s = new Signal("a");
    const seen: string[] = [];
    const dispose = s.subscribe((value) => seen.push(value));
    s.set("b");
    dispose();
    s.set("c");
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("computed の遅延評価", () => {
  it("読まれるまで本体は 1 度も走らない", () => {
    const s = new Signal(1);
    let runs = 0;
    const c = computed(() => {
      runs++;
      return s.value * 2;
    });
    s.set(2);
    s.set(3);
    expect(runs).toBe(0);
    expect(c.value).toBe(6);
    expect(runs).toBe(1);
  });

  it("依存が変わらない限り再計算しない", () => {
    const s = new Signal(1);
    const c = computed(() => s.value * 2);
    expect(c.value).toBe(2);
    expect(c.value).toBe(2);
    expect(c.recomputeCount).toBe(1);
    s.set(2);
    expect(c.value).toBe(4);
    expect(c.recomputeCount).toBe(2);
  });

  it("依存の値が同じに戻れば下流は再計算されない(3 色伝播の check)", () => {
    const source = new Signal(2);
    // 偶奇だけを見る中間層: source が 2 → 4 と変わっても値は変わらない。
    const isEven = computed(() => source.value % 2 === 0);
    const downstream = computed(() => (isEven.value ? "even" : "odd"));

    expect(downstream.value).toBe("even");
    expect(downstream.recomputeCount).toBe(1);

    source.set(4);
    expect(downstream.value).toBe("even");
    // 中間層は再計算されるが、値が変わらないので下流は据え置き。
    expect(isEven.recomputeCount).toBe(2);
    expect(downstream.recomputeCount).toBe(1);

    source.set(5);
    expect(downstream.value).toBe("odd");
    expect(downstream.recomputeCount).toBe(2);
  });

  it("ダイヤモンド依存でも 1 回の書き込みで下流は 1 回だけ再計算される", () => {
    const root = new Signal(1);
    const left = computed(() => root.value + 1);
    const right = computed(() => root.value + 2);
    const bottom = computed(() => left.value + right.value);

    expect(bottom.value).toBe(5);
    expect(bottom.recomputeCount).toBe(1);
    root.set(2);
    expect(bottom.value).toBe(7);
    expect(bottom.recomputeCount).toBe(2);
  });

  it("分岐で読まれなくなった依存は購読から外れる(動的依存)", () => {
    const useLeft = new Signal(true);
    const left = new Signal("L");
    const right = new Signal("R");
    const c = computed(() => (useLeft.value ? left.value : right.value));

    expect(c.value).toBe("L");
    expect(c.dependencyCount).toBe(2);

    useLeft.set(false);
    expect(c.value).toBe("R");
    // right へ切り替わったので left はもう依存ではない。
    left.set("L2");
    expect(c.recomputeCount).toBe(2);
  });

  it("自分自身に依存する computed は ReactiveError", () => {
    let self: { value: number } | null = null;
    const c = computed<number>(() => (self === null ? 0 : self.value + 1));
    self = c;
    expect(() => c.value).toThrow(ReactiveError);
  });

  it("カスタム equals は下流への伝播を値の意味で止める", () => {
    const s = new Signal(1);
    const view = computed(() => ({ parity: s.value % 2 }), {
      equals: (a, b) => a.parity === b.parity,
    });
    const downstream = computed(() => view.value.parity);

    expect(downstream.value).toBe(1);
    s.set(3);
    expect(downstream.value).toBe(1);
    expect(view.recomputeCount).toBe(2);
    expect(downstream.recomputeCount).toBe(1);
  });
});

describe("effect と batch", () => {
  it("batch 内の複数書き込みで effect は末尾 1 回だけ走る", () => {
    const a = new Signal(1);
    const b = new Signal(1);
    let runs = 0;
    const dispose = createEffect(() => {
      void a.value;
      void b.value;
      runs++;
    });
    expect(runs).toBe(1);
    batch(() => {
      a.set(2);
      b.set(2);
      a.set(3);
    });
    expect(runs).toBe(2);
    dispose();
  });

  it("値が実際には変わらなかった経路では effect が走らない", () => {
    const source = new Signal(2);
    const isEven = computed(() => source.value % 2 === 0);
    let runs = 0;
    const dispose = createEffect(() => {
      void isEven.value;
      runs++;
    });
    expect(runs).toBe(1);
    source.set(4);
    expect(runs).toBe(1);
    source.set(5);
    expect(runs).toBe(2);
    dispose();
  });

  it("untracked で読んだ値は依存にならない", () => {
    const tracked = new Signal(1);
    const hidden = new Signal(1);
    let runs = 0;
    const dispose = createEffect(() => {
      void tracked.value;
      untracked(() => hidden.value);
      runs++;
    });
    hidden.set(2);
    expect(runs).toBe(1);
    tracked.set(2);
    expect(runs).toBe(2);
    dispose();
  });

  it("互いの依存を書き換え合う effect は発散として検出される(黙って固まらない)", () => {
    const a = new Signal(0);
    const b = new Signal(0);
    const disposeA = createEffect(() => {
      b.set(a.value + 1);
    });
    const disposeB = createEffect(() => {
      a.set(b.value + 1);
    });
    // 構築時点では互いに 1 回ずつで収まる。外から突くと ping-pong が始まる。
    expect(() => a.set(100)).toThrow(ReactiveError);
    disposeA();
    disposeB();
  });

  it("大域カウンタが再計算回数を数えている", () => {
    const before = getReactiveStats().recomputes;
    const s = new Signal(1);
    const c = computed(() => s.value + 1);
    expect(c.value).toBe(2);
    s.set(2);
    expect(c.value).toBe(3);
    expect(getReactiveStats().recomputes - before).toBe(2);
  });
});

describe("ReactiveScope(画面のマウント単位・ADR-027)", () => {
  it("dispose で購読が全部切れる", () => {
    const s = new Signal(1);
    const scope = new ReactiveScope("test");
    let runs = 0;
    scope.effect(() => {
      void s.value;
      runs++;
    });
    s.set(2);
    expect(runs).toBe(2);
    expect(scope.size).toBe(1);

    scope.dispose();
    s.set(3);
    expect(runs).toBe(2);
    expect(scope.isDisposed).toBe(true);
    expect(scope.size).toBe(0);
  });

  it("スコープ内 computed は dispose 後に読めない(寿命が切れたことを黙って隠さない)", () => {
    const s = new Signal(1);
    const scope = new ReactiveScope("test");
    const c = scope.computed(() => s.value * 2);
    expect(c.value).toBe(2);
    scope.dispose();
    expect(() => c.value).toThrow(ReactiveError);
  });

  it("dispose 済みスコープへの追加は例外", () => {
    const scope = new ReactiveScope("test");
    scope.dispose();
    expect(() =>
      scope.effect(() => {
        // 何もしない
      }),
    ).toThrow(ReactiveError);
  });

  it("dispose は追加の逆順に走り、二重 dispose は無害", () => {
    const order: string[] = [];
    const scope = new ReactiveScope("test");
    scope.add(() => order.push("first"));
    scope.add(() => order.push("second"));
    scope.dispose();
    scope.dispose();
    expect(order).toEqual(["second", "first"]);
  });
});
