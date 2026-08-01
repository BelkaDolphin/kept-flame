// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- composition root(M29)
//
// **副作用を持つものを組み立てる唯一の場所**である。ここだけが content JSON /
// IndexedDB / Worker / `location` / タイマ / `performance.now()` を知っており、
// `src/ui/**` は組み立て済みのオブジェクトを props で受け取るだけになる
// (architecture.md §1 の依存規則)。
//
// 起動の順序(perf-boundaries.md §3 の B2 → B1 → B3 → B4 に対応):
//   1. content ロード(本番と同じ入口 = validateContentBundle → loadEngineContent)
//   2. セーブ復元(B2)。無ければ新規ゲーム(`src/newGame.ts`・M53)
//   3. ストア構築(B3)→ ルータ/tick driver/セーブを結線
//   4. tick 差が大きければ Worker catch-up(B1)へ回す
//   5. Preact マウント(B4)
//
// **このファイルはブラウザでしか動かないので vitest では 1 行も実行されない。**
// テスト可能なロジックは意図的に外へ出してある(`platform/router.ts` /
// `platform/clock.ts` / `ui/shellSession.ts` / `ui/derived.ts` / `newGame.ts`)。
// ここに残っているのは「それらを繋ぐ配線」だけである。
// ---------------------------------------------------------------------------

import { render } from "preact";

import adjacencyJson from "../content/adjacency.json";
import balanceJson from "../content/balance.json";
import eventJson from "../content/event.json";
import facilityJson from "../content/facility.json";
import outpostTypeJson from "../content/outpostType.json";
import techJson from "../content/tech.json";
import traitJson from "../content/trait.json";
import { validateContentBundle, type RawContentBundle } from "../schema/contentBundle";
import { loadEngineContentOrThrow } from "../schema/engineContent";

import { advance } from "./engine/advance";
import type { EngineContent } from "./engine/rules/types";
import type { GameState } from "./engine/state/state";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "./platform/catchUp";
import { createTickDriver } from "./platform/clock";
import {
  createInstallPromotionTracker,
  isStandaloneDisplayMode,
  saveInstallPromotionSnapshot,
} from "./platform/installPromotion";
import { createInstallPromptController } from "./platform/installPromptEvent";
import { resolveLocalStorage } from "./platform/localStorageMirror";
import {
  assessNotificationCapability,
  createNotificationOptInTracker,
  detectNotificationCapabilityEnv,
  requestNotificationPermission,
  saveNotificationOptInSnapshot,
  shouldOfferNotificationOptIn,
} from "./platform/notificationCapability";
import { loadLatestSave, openSaveDb, saveGameState } from "./platform/persistence";
import { createBrowserRouterHost, createHashRouter } from "./platform/router";
import { SaveScheduler, attachLifecycleFlush } from "./platform/saveScheduler";
import { startCatchUpWorker } from "./platform/workerClient";
import { createNewGameState } from "./newGame";
import {
  AppShell,
  type InstallPromotionViewModel,
  type NotificationOptInViewModel,
} from "./ui/AppShell";
import {
  DEFAULT_SCREEN_ID,
  RETURN_DIGEST_SCREEN_ID,
  SCREEN_IDS,
  type ScreenId,
} from "./ui/screens";
import { createShellSession } from "./ui/shellSession";
import { createGameStore, type GameStore } from "./ui/store";

// `beforeinstallprompt` はページ生存中いつでも来うるが、条件を満たしていれば
// 早い段階で発火することが多い。boot() の非同期処理(content 検証・セーブ
// 復元)より前、モジュール評価の同期区間で listener を張ることで取りこぼしを
// 減らす(platform/installPromptEvent.ts §1)。イベントが来なければ
// `getState()` は `"unavailable"` のままで、誘導バナーはテキスト誘導へ
// フォールバックする(iOS Safari 等)。
const installPromptController = createInstallPromptController(window);

/** 復帰時に⑫帰還ダイジェストを出す tick 差のしきい値(1 ゲーム時間)。 */
const DIGEST_MIN_ELAPSED_TICKS = 60;

function loadContent(): EngineContent {
  const raw: RawContentBundle = {
    adjacency: adjacencyJson,
    balance: balanceJson,
    event: eventJson,
    facility: facilityJson,
    outpostType: outpostTypeJson,
    tech: techJson,
    trait: traitJson,
  };
  const validated = validateContentBundle(raw);
  if (!validated.ok) {
    const detail = validated.issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`content/*.json が schema 検証を通らない:\n${detail}`);
  }
  return loadEngineContentOrThrow(validated.value);
}

interface BootState {
  readonly state: GameState;
  readonly source: "save" | "newGame";
}

async function loadOrCreateState(
  db: IDBDatabase | null,
  content: EngineContent,
): Promise<BootState> {
  if (db !== null) {
    try {
      const restored = await loadLatestSave(db);
      return { state: restored.state, source: "save" };
    } catch {
      // セーブが無い / 壊れている。破損時の救済 UI(インポート導線)は
      // ＋設定画面(M33)の担当なので、M29 は「セーブが無い」と同じ扱いで
      // 新規開始する(申し送り)。
    }
  }
  return {
    state: createNewGameState(content, { algoVersion: balanceJson.algoVersion }),
    source: "newGame",
  };
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (root === null) throw new Error("#app が index.html に無い");

  const content = loadContent();

  let db: IDBDatabase | null = null;
  try {
    db = await openSaveDb();
  } catch {
    // IndexedDB が使えない環境(プライベートモード等)。localStorage ミラーへの
    // 縮退は M33(セーブ/設定)の担当なので、ここでは「保存しない」で続行する。
    db = null;
  }
  const saveDb = db;

  const booted = await loadOrCreateState(saveDb, content);
  // ⑫帰還ダイジェストの「不在中」の起点(ui-spec §4)。catch-up の**前**に取る。
  const bootTick = booted.state.tick;

  const store: GameStore = createGameStore({ state: booted.state, content });

  const router = createHashRouter<ScreenId>(createBrowserRouterHost(), {
    routes: SCREEN_IDS,
    fallback: DEFAULT_SCREEN_ID,
  });
  const session = createShellSession({ store, router });

  // --- セーブ(architecture.md §8 の結線どおり) -----------------------------
  const scheduler =
    saveDb === null ? null : new SaveScheduler({ write: (state) => saveGameState(saveDb, state) });
  if (scheduler !== null) attachLifecycleFlush(scheduler, window);

  // --- tick 駆動(ADR-026)---------------------------------------------------
  // pump の呼ばれ方(rAF の発火回数)は結果に影響しない。進める量は
  // `planTick` が単調時刻から純関数で決める(platform/clock.ts §1)。
  let catchUpInFlight = false;

  const driver = createTickDriver({
    startTick: store.peekState().tick,
    onAdvance: (toTick) => {
      const result = store.dispatch({ type: "ticked", toTick });
      if (result.stateChanged) scheduler?.recordCommands(store.peekState());
    },
    onCatchUpRequired: (toTick) => {
      if (catchUpInFlight) return;
      catchUpInFlight = true;
      void runCatchUp(toTick).finally(() => {
        catchUpInFlight = false;
        driver.syncTo(store.peekState().tick);
        scheduler?.recordCommands(store.peekState());
      });
    },
  });

  /** 長い不在の catch-up。Worker が使えなければメインで刻む(分割不変・advance.ts §3)。 */
  async function runCatchUp(toTick: number): Promise<void> {
    const current = store.peekState();
    if (toTick <= current.tick) return;
    try {
      const worker = await startCatchUpWorker(content);
      try {
        const result = await worker.catchUp(current, toTick);
        store.dispatch({
          type: "catchUpApplied",
          snapshot: result.snapshot,
          advanceContext: result.advanceContext,
        });
        return;
      } finally {
        worker.terminate();
      }
    } catch {
      // Worker が無い環境(古い WebView 等)。ADR-019 の予算からは外れるが、
      // 「起動できない」よりは刻んで進める方がよい。区切り方は前景経路の上限
      // (600 tick)に合わせる。
      const ctx = store.peekAdvanceContext();
      let state = store.peekState();
      while (state.tick < toTick) {
        const step = Math.min(toTick - state.tick, LIVE_ADVANCE_MAX_TICK_DELTA);
        state = advance(state, ctx, state.tick + step);
      }
      store.dispatch({
        type: "catchUpApplied",
        snapshot: state,
        advanceContext: {
          worldSeedU32: ctx.worldSeedU32,
          multiplierByFacilityId: ctx.multiplierByFacilityId,
        },
      });
    }
  }

  // 起動直後の 1 回(可視復帰と同じ扱い・ADR-026(4))。
  const bootPlan = driver.pump();
  driver.start();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") driver.pump();
  });

  // --- Add-to-Home 誘導(M34・GDD 13.4・ADR-004(1))---------------------------
  // 判定は「最終起動 monotonicTimestamp のみ」(installPromotion.ts §1)。
  // standalone 検出は判定そのものには混ぜず、無意味な表示を止める役に限定する。
  const promotionStorage = resolveLocalStorage();
  const installTracker = createInstallPromotionTracker({ storage: promotionStorage });
  // iOS Safari 独自の `navigator.standalone`(lib.dom.d.ts に型定義なし)。
  // `exactOptionalPropertyTypes` の下では未定義キーを明示せず省略する。
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone;
  const standaloneEnv = {
    matchMedia: (query: string) => window.matchMedia(query),
    navigator: iosStandalone === undefined ? {} : { standalone: iosStandalone },
  };
  const installVisible =
    installTracker.status().shouldShow && !isStandaloneDisplayMode(standaloneEnv);
  if (installVisible) {
    // 表示すると決めた直後に記録する(永続化は installPromotion.ts §3 の規約)。
    installTracker.recordShown();
    saveInstallPromotionSnapshot(promotionStorage, installTracker.snapshot());
  }
  const installPromotion: InstallPromotionViewModel = {
    visible: installVisible,
    canPromptDirectly: installPromptController.getState() === "available",
    onInstall: () => {
      void installPromptController.promptInstall();
    },
  };

  // --- 通知の条件分岐(M34・GDD 13.3)-----------------------------------------
  // 実送信ロジック(Worker cron 等)は本タスク外。ここは「本命として使える
  // 環境か」を機能検出だけで判定し(notificationCapability.ts §2)、使えなければ
  // オプトインバナーを一切描かない(代替リテンションは①⑫等の既存導線が担う)。
  const notificationEnv = detectNotificationCapabilityEnv(window);
  const notificationCapability = assessNotificationCapability(notificationEnv);
  const notificationTracker = createNotificationOptInTracker({ storage: promotionStorage });
  const notificationVisible = shouldOfferNotificationOptIn(
    notificationCapability,
    notificationEnv.permission,
    notificationTracker.status(),
  );
  if (notificationVisible) {
    notificationTracker.recordShown();
    saveNotificationOptInSnapshot(promotionStorage, notificationTracker.snapshot());
  }
  const notificationOptIn: NotificationOptInViewModel = {
    visible: notificationVisible,
    onRequestPermission: () => {
      void requestNotificationPermission(window);
    },
  };

  // --- 初期画面(GDD 4.2「復帰時に必ず最初に表示」)---------------------------
  // 判定は **plan の targetTick** で行う。長期不在(> 600 tick)は Worker 経路が
  // 非同期に適用されるので、この時点の `store.peekState().tick` はまだ動いておらず、
  // それを見ると「不在が長いほど⑫が出ない」という逆さまの挙動になる。
  const elapsedTicks = bootPlan.targetTick - bootTick;
  if (booted.source === "save" && elapsedTicks >= DIGEST_MIN_ELAPSED_TICKS) {
    router.replace(RETURN_DIGEST_SCREEN_ID);
  }

  render(
    <AppShell
      store={store}
      session={session}
      bootTick={bootTick}
      installPromotion={installPromotion}
      notificationOptIn={notificationOptIn}
    />,
    root,
  );
}

void boot().catch((error: unknown) => {
  const root = document.getElementById("app");
  const message = error instanceof Error ? error.message : String(error);
  if (root !== null) root.textContent = `起動に失敗しました: ${message}`;
  throw error;
});
