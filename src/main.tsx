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
import {
  createBackupReminderPromptTracker,
  createBackupReminderTracker,
  saveBackupReminderPromptSnapshot,
} from "./platform/backupReminder";
import { LIVE_ADVANCE_MAX_TICK_DELTA } from "./platform/catchUp";
import { createTickDriver, performanceClock } from "./platform/clock";
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
import {
  loadLatestSave,
  openSaveDb,
  saveGameState,
  SaveNotFoundError,
} from "./platform/persistence";
import {
  loadPromotionPromptSnapshot,
  PromotionPromptTracker,
  savePromotionPromptSnapshot,
} from "./platform/promotionPrompt";
import { createBrowserRouterHost, createHashRouter } from "./platform/router";
import { SaveScheduler, attachLifecycleFlush } from "./platform/saveScheduler";
import { createScaledClock } from "./platform/timeScale";
import { startCatchUpWorker } from "./platform/workerClient";
import { createNewGameState } from "./newGame";
import {
  AppShell,
  type BackupReminderViewModel,
  type InstallPromotionViewModel,
  type LoadFailureViewModel,
  type NotificationOptInViewModel,
  type OnboardingViewModel,
} from "./ui/AppShell";
import {
  DEFAULT_SCREEN_ID,
  RETURN_DIGEST_SCREEN_ID,
  SCREEN_IDS,
  type ScreenId,
} from "./ui/screens";
import { createShellSession } from "./ui/shellSession";
import { createGameStore, type GameStore } from "./ui/store";
import { createTestplaySpeedController } from "./ui/testplaySpeed";

// `beforeinstallprompt` はページ生存中いつでも来うるが、条件を満たしていれば
// 早い段階で発火することが多い。boot() の非同期処理(content 検証・セーブ
// 復元)より前、モジュール評価の同期区間で listener を張ることで取りこぼしを
// 減らす(platform/installPromptEvent.ts §1)。イベントが来なければ
// `getState()` は `"unavailable"` のままで、誘導バナーはテキスト誘導へ
// フォールバックする(iOS Safari 等)。
const installPromptController = createInstallPromptController(window);

/** 復帰時に⑫帰還ダイジェストを出す tick 差のしきい値(1 ゲーム時間)。 */
const DIGEST_MIN_ELAPSED_TICKS = 60;

/**
 * [M57] 初回ガイドの表示済みフラグ(localStorage キー)。`promotionPrompt.ts`
 * §4 の永続化ヘルパは「キー1本ぶん・複数バナー種で共有する実装」として
 * 汎用化済みなので、`platform/` へ新規ファイルを追加せず(タスク制約)
 * `PromotionPromptTracker` をそのまま再利用する(installPromotion.ts/
 * notificationCapability.ts/backupReminder.ts の 3 種に続く 4 種類目)。
 */
const ONBOARDING_PROMPT_STORAGE_KEY = "kept-flame:onboarding-guide";

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
  /**
   * [M54] セーブは**あったのに読めなかった**(破損・版違反・migration 失敗等)か。
   * `SaveNotFoundError`(初回起動でまだ何も保存していないだけ)は含まない——
   * 区別しないと「初めて遊ぶ人」にまで「読み込みに失敗しました」を誤表示する。
   */
  readonly loadFailed: boolean;
}

function freshNewGameState(content: EngineContent): GameState {
  return createNewGameState(content, { algoVersion: balanceJson.algoVersion });
}

async function loadOrCreateState(
  db: IDBDatabase | null,
  content: EngineContent,
): Promise<BootState> {
  if (db !== null) {
    try {
      const restored = await loadLatestSave(db);
      return { state: restored.state, source: "save", loadFailed: false };
    } catch (error) {
      if (error instanceof SaveNotFoundError) {
        // 初回起動(まだ何も保存していない)。黙って新規開始する(M29 以来の挙動)。
      } else {
        // セーブはあったが読めなかった(破損・版違反・migration 失敗・上界超過等)。
        // 破損時の救済 UI(インポート導線)は＋設定画面(M33)の常設フォームだが、
        // それだけでは「進行状況が消えた」ことにその場で気づけない(M29 申し送り)
        // ので、`loadFailed: true` を立てて呼び出し側(AppShell)にバナーを出させる
        // (ロードマップ M54 行「起動失敗のその場通知」)。boot 自体は続行する。
        return { state: freshNewGameState(content), source: "newGame", loadFailed: true };
      }
    }
  }
  return { state: freshNewGameState(content), source: "newGame", loadFailed: false };
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

  const store: GameStore = createGameStore({
    state: booted.state,
    content,
    // 世界の入れ替え(インポート / 最初からやり直す)の唯一の結線点。実体は
    // 下の `handleWorldLoaded`(関数宣言なので巻き上げ済み。呼ばれるのは
    // プレイヤー操作の時点 = driver / scheduler が揃った後)。
    onWorldLoaded: (state) => {
      handleWorldLoaded(state);
    },
    // [M62/FC2] プレイヤー操作(engine コマンド)をセーブのトリガへ結線する
    // 唯一の口。以前は画面から直接 `store.dispatch({type:"commandApplied"})`
    // を呼ぶ経路が 10 箇所以上あり、どこも `scheduler.recordCommandOutcome`
    // を呼んでいなかった(プレイテスト R2-FC2・M54 発見の既知ギャップ)。
    // ×1(倍速なし)では最大 15 秒(絶対フラッシュの締切)まで、操作の直後に
    // タブを閉じる等すると直近の操作が黙って失われる窓があった。
    // `handleWorldLoaded` と同じ理由で「ストアの唯一の書き込み口 dispatch の
    // 中」に置く(画面ごとの呼び忘れが構造的に起きなくなる)。`scheduler` は
    // この下で定義されるが、このコールバック自体はコマンドが実際に dispatch
    // された時点(boot() のこの同期区間よりずっと後)まで呼ばれないので
    // 参照して問題ない(`handleWorldLoaded` の前方参照と同型)。
    // `recordCommandOutcome` 自身が拒否/無変化を弾くので、ここでは分岐しない。
    onCommandApplied: (result) => {
      scheduler?.recordCommandOutcome(result);
    },
  });

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
  //
  // [M59] `createTickDriver` へ渡す clock だけを倍速ラッパ(`timeScale.ts`)で
  // 包む。**セーブ/バックアップ推奨/PWA 誘導/このあとの起動時オフライン復帰
  // 計算(`bootPlan`)には絶対に触れない**——それらは `performanceClock`/壁時計を
  // 個別に読んでおり(saveScheduler.ts の `systemSaveClock` 等)、ここでは
  // tick 駆動の 1 箇所だけを差し替える。既定 speed=1 なので、通常時は
  // `performanceClock` と完全に同じ値を返す(挙動不変)。
  const scaledClock = createScaledClock(performanceClock);
  const testplaySpeed = createTestplaySpeedController(scaledClock);

  let catchUpInFlight = false;
  /**
   * 世界の版番号。`worldLoaded`(インポート/最初からやり直す)のたびに 1 進む。
   * 飛行中の Worker catch-up は**入れ替え前の世界**を進めているので、完了時に
   * 版が変わっていたらその結果は捨てる(据えると入れ替えが黙って巻き戻るか、
   * 古い tick のスナップショットとして `catchUpApplied` が例外になる)。
   */
  let worldGeneration = 0;

  const driver = createTickDriver({
    startTick: store.peekState().tick,
    clock: scaledClock,
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
    const generation = worldGeneration;
    const current = store.peekState();
    if (toTick <= current.tick) return;
    try {
      const worker = await startCatchUpWorker(content);
      try {
        const result = await worker.catchUp(current, toTick);
        // 待っている間に世界が入れ替わっていたら、この結果はもう別世界のもの。
        if (generation !== worldGeneration) return;
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
      if (generation !== worldGeneration) return;
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

  // --- 世界の入れ替え(インポート / 最初からやり直す)の後始末 ----------------
  //
  //   `store.dispatch({type:"worldLoaded"})` は state を丸ごと差し替えるが、
  //   **ストアの外にある 2 つの前提**までは直せない:
  //     (1) tick 駆動のアンカー(clock.ts §6)。引き直さないと、driver は旧世界
  //         基準の targetTick を出し続け、ストアが「tick 差が前景経路の上限を
  //         超える」で例外を投げ、ゲーム内時刻が二度と進まなくなる(R1-A01/A02)。
  //     (2) IndexedDB のセーブ。書かないとリロードで入れ替え前の世界に戻る
  //         (インポートによる救済が「成功しました」と言いながら消える)。
  //   ストア側は `worldLoaded` を適用し終えた直後にここを 1 回だけ呼ぶ
  //   (`src/ui/store.ts` §5)ので、画面がこの後始末を呼び忘れる余地は無い。
  //
  //   **ここを Worker catch-up 経路へ回さない理由**(ADR-026(3)の判断基準):
  //   catch-up は「実時間が経ったのにまだシミュレーションしていない tick」を
  //   埋める仕組みである。世界の入れ替えには埋めるべき経過が無い —— 新しい
  //   state の tick は**今この瞬間の値そのもの**であり、engine を 1 tick も
  //   回す必要がない。11 ゲーム時間前のセーブをインポートしたときに 660 tick を
  //   catch-up で進めてしまえば、「昔の状態へ戻す」というインポートの意味自体が
  //   消える。よってここは同期の `syncTo`(アンカーの引き直しだけ)が正しく、
  //   Worker 経路は起動時/復帰時の tick 差(= 実時間の経過)に対して従来どおり
  //   `onCatchUpRequired` が担う。
  function handleWorldLoaded(state: GameState): void {
    worldGeneration++;
    driver.syncTo(state.tick);
    if (scheduler === null) return;
    // 既存のセーブ導線をそのまま使う(新しい保存形式も経路も作らない)。
    // `recordCommands` で最新 state を積み、明示フラッシュで即座に 1 回書く。
    scheduler.recordCommands(state);
    void scheduler.flush("manual");
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

  // --- 定期バックアップ推奨バナー(M54・GDD 13.4 の精神)----------------------
  // データ条件(`BackupReminderTracker`・M4 実装済み)AND 表示頻度
  // (`PromotionPromptTracker`・M34 と同型)の 2 層 AND を、Add-to-Home/通知と
  // 同じ「起動時に 1 回だけ判定する」形で結線する(backupReminder.ts §3)。
  // **commandsSinceExport 軸は本タスク(M62/FC2)でも未結線のまま**(★非
  // ブロッキング・最終報告参照): `BackupReminderTracker` 自身が持つ独立した
  // コマンドカウンタ(`recordCommands`)を指しており、`store` の
  // `onCommandApplied` 通知(M62 で新設・上の `createGameStore` 呼び出し参照)
  // とは別物。~~`SaveScheduler.recordCommandOutcome` も同じ制約で未結線~~
  // **[M62/FC2 で解消]** `SaveScheduler` 側は上で結線済み。
  // `BackupReminderTracker.recordCommands` の結線は引き続き別タスクの担当。
  // 経過実時間(既定 24h)軸のみで周期表示を成立させている。
  const backupReminderTracker = createBackupReminderTracker({ storage: promotionStorage });
  const backupReminderPromptTracker = createBackupReminderPromptTracker({
    storage: promotionStorage,
  });
  const backupReminderVisible =
    backupReminderTracker.status().shouldRemind && backupReminderPromptTracker.status().shouldShow;
  if (backupReminderVisible) {
    backupReminderPromptTracker.recordShown();
    saveBackupReminderPromptSnapshot(promotionStorage, backupReminderPromptTracker.snapshot());
  }
  const backupReminder: BackupReminderViewModel = { visible: backupReminderVisible };

  // --- 起動失敗のその場通知(M54)---------------------------------------------
  // 判定は `loadOrCreateState` が済ませ済み(`booted.loadFailed`)。ここでは
  // view model へ写すだけ(main.tsx はこれ以上の判定を持たない)。
  const loadFailure: LoadFailureViewModel = { visible: booted.loadFailed };

  // --- 初回ガイドの自動表示(M57・台帳v9 必-3・UXレポート M-5 正面対応)-------
  // **検収条件「初回起動でのみ出る(セーブ復帰では出ない)」**を
  // `booted.source === "newGame"` で機械的に満たす(⑫帰還ダイジェストが
  // `booted.source === "save"` を条件にしているのと対称)。加えて
  // `PromotionPromptTracker`(`maxShowCount: 1`)を AND することで、同一
  // ブラウザで「セーブがまだ一度も書かれていない newGame 状態のままリロード」
  // を繰り返しても 2 度目以降は出ない(スキップ/最終カード確定のどちらでも
  // シェル側は `recordShown` を待たず、表示すると決めた直後にここで記録する
  // ——Add-to-Home/通知/バックアップ推奨の 3 バナーと同じ規約)。
  const onboardingPromptSnapshot = loadPromotionPromptSnapshot(
    promotionStorage,
    ONBOARDING_PROMPT_STORAGE_KEY,
  );
  const onboardingPromptTracker = new PromotionPromptTracker({
    maxShowCount: 1,
    ...(onboardingPromptSnapshot === null ? {} : { initialSnapshot: onboardingPromptSnapshot }),
  });
  const onboardingVisible =
    booted.source === "newGame" && onboardingPromptTracker.status().shouldShow;
  if (onboardingVisible) {
    onboardingPromptTracker.recordShown();
    savePromotionPromptSnapshot(
      promotionStorage,
      ONBOARDING_PROMPT_STORAGE_KEY,
      onboardingPromptTracker.snapshot(),
    );
  }
  const onboarding: OnboardingViewModel = { visible: onboardingVisible };

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
      backupReminder={backupReminder}
      loadFailure={loadFailure}
      onboarding={onboarding}
      testplaySpeed={testplaySpeed}
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
