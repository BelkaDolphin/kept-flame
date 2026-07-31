// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- アプリシェルの結線(Preact 非依存)— ADR-027 / M29
//
// ===========================================================================
// 1. なぜ AppShell.tsx から切り出すのか
// ===========================================================================
//   シェルの本質は「ルータが決めた現在地をストアへ写す」ことであり、そこに
//   Preact は 1 行も要らない。切り出しておくと:
//
//     (a) vitest(`environment: "node"`・jsdom 無し)で**実際に動くコード**を
//         テストできる。M29 の検収条件「画面遷移でストアが再生成されないテスト」は
//         このファイルに対して書かれている(tests/ui/shellSession.test.ts)。
//     (b) 「現在地の権威はルータ 1 箇所」という ADR-027 の規律が、
//         `screenOpened` を dispatch する行がこのファイルにしか無いことで
//         機械的に読める。
//
// ===========================================================================
// 2. ストアは**作らない**(検収条件の本体)
// ===========================================================================
//   セッションは既に作られたストアを受け取るだけで、`createGameStore` を
//   呼ばない。画面遷移で起きるのは「`activeScreen` signal の書き換え」1 つ
//   だけであり、GameState も content も AdvanceContext も 1 バイトも動かない。
//   ストアの `stats()` がその証拠を出す(`advanceContextBuildCount` が増えない)。
//
// ===========================================================================
// 3. 画面側は自分を「現在地だ」と宣言しない(M18★5 への回答)
// ===========================================================================
//   `store.mountScreen(id, { activate: true })` は「マウント = 現在地」を
//   意味してしまい、権威がルータと画面の 2 箇所になる。M29 以降、画面
//   コンポーネントは `{ activate: false }` でマウントし、`screenOpened` を
//   出すのは本ファイルだけである。
// ---------------------------------------------------------------------------

import type { HashRouter } from "../platform/router";
import type { ScreenId } from "./screens";
import type { GameStore } from "./store";

export interface ShellSession {
  /** 現在地(ルータの写し)。 */
  screen(): ScreenId;
  /** 画面を開く(履歴に積む)。ルータ経由なので URL も動く。 */
  navigate(screen: ScreenId): void;
  /** 現在地の変化を購読する(**登録時には呼ばれない**)。 */
  subscribe(listener: (screen: ScreenId) => void): () => void;
  dispose(): void;
}

export interface CreateShellSessionInput {
  readonly store: GameStore;
  readonly router: HashRouter<ScreenId>;
}

/**
 * ルータとストアを結ぶ(アプリ 1 起動につき 1 個)。
 *
 * 構築時に現在地を 1 回だけストアへ写す(初回描画の前に `activeScreen` が
 * 正しくなるようにするため)。
 */
export function createShellSession(input: CreateShellSessionInput): ShellSession {
  const { store, router } = input;
  const listeners = new Set<(screen: ScreenId) => void>();
  let disposed = false;

  // 現在地の初期値をストアへ写す。ここが `screenOpened` の唯一の発行点(§3)。
  store.dispatch({ type: "screenOpened", screen: router.current() });

  const unsubscribeRouter = router.subscribe((screen) => {
    if (disposed) return;
    store.dispatch({ type: "screenOpened", screen });
    for (const listener of [...listeners]) listener(screen);
  });

  return {
    screen: () => router.current(),

    navigate(screen: ScreenId): void {
      router.navigate(screen);
    },

    subscribe(listener: (screen: ScreenId) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeRouter();
      listeners.clear();
    },
  };
}
