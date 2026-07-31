// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 自前ハッシュルータ — ADR-027(1) / GDD 6.6
//
// ===========================================================================
// 1. なぜ自前なのか
// ===========================================================================
//   ADR-027(1): 「preact-router 等を入れず `location.hash` + 監視の自前極小
//   ルータ(数十行)で実装(ADR-001 依存最小)」。反応系(`src/ui/reactive.ts`)を
//   自前で書いたのと同じ理由であり、本ファイルもそれ 1 枚で閉じる。
//
// ===========================================================================
// 2. 画面 ID の語彙を platform が知らない(依存方向・architecture.md §1)
// ===========================================================================
//   「platform → ui の import は無い」が本リポジトリの 3 規則のひとつなので、
//   本ファイルは `src/ui/screens.ts` の `ScreenId` を **import しない**。
//   代わりにルート語彙を型引数と引数で受け取る汎用ルータにしてある:
//
//     createHashRouter(host, { routes: SCREEN_IDS, fallback: DEFAULT_SCREEN_ID })
//
//   結線するのは composition root(`src/main.tsx`)であり、そこでだけ
//   「ルート語彙 = 12画面 + 設定」という知識が現れる。
//
// ===========================================================================
// 3. 「現在地の権威はルータ」(src/ui/screens.ts §2 の裏取り)
// ===========================================================================
//   URL ハッシュが現在地の唯一の状態であり、ルータは履歴を自前で持たない。
//   ストアの `activeScreen` は**ルータが決めた現在地の写し**にすぎず、
//   ストアから URL を書き換える経路は作らない(逆流を作らない)。
//
//   画面コンポーネントが `mountScreen(..., { activate: true })` で自分を
//   「現在地だ」と宣言する形も採らない —— それを許すと権威が 2 箇所になり、
//   「マウントされているが現在地ではない画面」を表現できなくなる(M18★5)。
//   `screenOpened` を dispatch するのはアプリシェル 1 箇所である。
//
// ===========================================================================
// 4. DOM を直接掴まない(テスト可能性)
// ===========================================================================
//   vitest は `environment: "node"`(ADR-001 により jsdom を入れていない)なので、
//   `location` / `addEventListener` を直に触ると 1 行もテストできない。
//   そこで「ハッシュを読む・書く・変化を購読する」の 3 つだけを
//   {@link RouterHost} として切り出し、ブラウザ実装
//   ({@link createBrowserRouterHost})とテスト用の素朴な実装を差し替えられる形に
//   してある。ルータ本体のロジック(検証・正準化・通知)は host の実装に依存しない。
//
// ===========================================================================
// 5. ハッシュの形
// ===========================================================================
//   正準形は `#/<routeId>`(例 `#/home`)。受理するのは以下:
//     ""            → fallback(初回起動)
//     "#"  / "#/"   → fallback
//     "#/home"      → home(正準形)
//     "#home"       → home(スラッシュ無しも受理し、正準形へ書き直す)
//     "#/unknown"   → **fallback へ倒し URL を書き直す**
//   クエリ・サブパス(`#/grid/3`)は MVP では持たない。持たせるなら
//   「画面 ID の語彙(screens.ts)を増やさずにパラメータを足す」設計が要るので、
//   その時点で ADR-027 の改訂を伴う。
// ---------------------------------------------------------------------------

/** ルータの使い方の誤り(語彙外のルート・dispose 後の操作など)。 */
export class RouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterError";
  }
}

// --- 1. 純関数(ハッシュ ⇄ ルート ID・§5) -----------------------------------

/** ルート ID → 正準のハッシュ文字列。 */
export function routeHash(route: string): string {
  return `#/${route}`;
}

/**
 * ハッシュ文字列 → ルート ID。**語彙外は null**(呼び出し側が fallback へ倒す)。
 *
 * `location.hash` は先頭 `#` 付き、`""`(ハッシュ無し)もありうる。
 * 大小文字は正規化しない —— ルート ID は小文字始まりの英字 ID と決めてあり
 * (`src/ui/screens.ts`)、勝手に寄せると「別 URL が同じ画面」を作ってしまう。
 */
export function parseRouteHash<TRoute extends string>(
  hash: string,
  routes: readonly TRoute[],
): TRoute | null {
  let rest = hash.startsWith("#") ? hash.slice(1) : hash;
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (rest.length === 0) return null;
  for (const route of routes) {
    if (route === rest) return route;
  }
  return null;
}

// --- 2. ホスト(DOM 境界・§4) -----------------------------------------------

/** ルータが外界に要求する最小の口。 */
export interface RouterHost {
  getHash(): string;
  /** 履歴に積む形で書き換える(戻るで前の画面へ戻れる)。 */
  setHash(hash: string): void;
  /** 履歴に積まずに書き換える(不正ハッシュの正準化など)。 */
  replaceHash(hash: string): void;
  /** `hashchange` 相当の購読。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
}

/** ブラウザの `location.hash` + `hashchange` を使うホスト。 */
export function createBrowserRouterHost(): RouterHost {
  return {
    getHash: () => window.location.hash,
    setHash: (hash) => {
      window.location.hash = hash;
    },
    replaceHash: (hash) => {
      // `location.replace` は同一ドキュメント内のハッシュ変更でも履歴を汚さない。
      window.location.replace(`${window.location.pathname}${window.location.search}${hash}`);
    },
    subscribe: (listener) => {
      window.addEventListener("hashchange", listener);
      return () => {
        window.removeEventListener("hashchange", listener);
      };
    },
  };
}

// --- 3. ルータ本体 -----------------------------------------------------------

export interface HashRouter<TRoute extends string> {
  /** 現在地(常に語彙内のルート ID)。 */
  current(): TRoute;
  /** ルートを開く(履歴に積む)。同じルートなら何もしない。 */
  navigate(route: TRoute): void;
  /** ルートを開く(履歴に積まない。復帰時の初期画面など)。 */
  replace(route: TRoute): void;
  /** 現在地の変化を購読する。**登録時には呼ばれない**。 */
  subscribe(listener: (route: TRoute) => void): () => void;
  /** ホストの購読を切る。以後 navigate すると例外。 */
  dispose(): void;
}

export interface CreateHashRouterOptions<TRoute extends string> {
  /** ルート語彙(`SCREEN_IDS` を渡す)。 */
  readonly routes: readonly TRoute[];
  /** 語彙外・空ハッシュのときの行き先(`DEFAULT_SCREEN_ID`)。 */
  readonly fallback: TRoute;
  /**
   * URL にハッシュが無いときに開くルート。復帰時の⑫帰還ダイジェスト
   * (GDD 4.2「復帰時に必ず最初に表示」)はここへ `digest` を渡して表現する。
   * **ハッシュが既にある場合は URL が勝つ**(リロードで画面が飛ばない)。
   */
  readonly initial?: TRoute;
}

/**
 * 自前ハッシュルータを作る。アプリ 1 起動につき 1 個。
 * 構築時点で URL を正準形へ揃える(語彙外・スラッシュ無しの書き直し)。
 *
 * @throws {RouterError} routes が空 / fallback・initial が語彙外の場合
 */
export function createHashRouter<TRoute extends string>(
  host: RouterHost,
  options: CreateHashRouterOptions<TRoute>,
): HashRouter<TRoute> {
  const routes = options.routes;
  if (routes.length === 0) throw new RouterError("ルート語彙が空");

  const known = (route: string): route is TRoute => routes.some((candidate) => candidate === route);
  if (!known(options.fallback)) {
    throw new RouterError(`fallback "${options.fallback}" が語彙外`);
  }
  if (options.initial !== undefined && !known(options.initial)) {
    throw new RouterError(`initial "${options.initial}" が語彙外`);
  }

  const listeners = new Set<(route: TRoute) => void>();
  let disposed = false;

  const fromUrl = parseRouteHash(host.getHash(), routes);
  let current: TRoute = fromUrl ?? options.initial ?? options.fallback;
  // 語彙外・スラッシュ無し・空のいずれでも、URL は必ず正準形になる。
  if (host.getHash() !== routeHash(current)) host.replaceHash(routeHash(current));

  function emit(): void {
    for (const listener of [...listeners]) listener(current);
  }

  function adopt(next: TRoute): void {
    if (next === current) return;
    current = next;
    emit();
  }

  const unsubscribeHost = host.subscribe(() => {
    if (disposed) return;
    const parsed = parseRouteHash(host.getHash(), routes);
    if (parsed === null) {
      // 語彙外へ飛ばされた(手打ち・古いブックマーク)。fallback へ倒して
      // URL も正準形へ戻す。履歴は汚さない。
      host.replaceHash(routeHash(options.fallback));
      adopt(options.fallback);
      return;
    }
    adopt(parsed);
  });

  function assertLive(): void {
    if (disposed) throw new RouterError("dispose 済みのルータを操作した");
  }

  return {
    current: () => current,

    navigate(route: TRoute): void {
      assertLive();
      if (!known(route)) throw new RouterError(`未知のルート ID "${String(route)}"`);
      if (route === current) return;
      // URL を書く → host の hashchange が来る実装(ブラウザ)でも、来ない実装
      // (テスト用の素朴なホスト)でも同じ現在地になるよう、ここでも adopt する。
      // adopt は同値なら何もしないので二重通知にはならない。
      host.setHash(routeHash(route));
      adopt(route);
    },

    replace(route: TRoute): void {
      assertLive();
      if (!known(route)) throw new RouterError(`未知のルート ID "${String(route)}"`);
      host.replaceHash(routeHash(route));
      adopt(route);
    },

    subscribe(listener: (route: TRoute) => void): () => void {
      assertLive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeHost();
      listeners.clear();
    },
  };
}
