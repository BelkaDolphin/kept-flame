// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- 単一グローバルストア — ADR-002 / ADR-026 / ADR-027 / ADR-028
//
// 12画面が同一状態をリアルタイム共有するための唯一のストア。書き込み口は
// {@link GameStore.dispatch} 1 本だけで、根 signal(sources.ts)への `set` は
// 本ファイルの内部からしか呼ばれない。
//
// ===========================================================================
// 1. イベント語彙(store 形状の正本)
// ===========================================================================
//   | イベント          | 誰が出すか                       | 何が起きるか |
//   |-------------------|----------------------------------|--------------|
//   | `worldLoaded`     | 起動/セーブ復元/インポート(M29/M33) | content + state を総入れ替え |
//   | `ticked`          | フォアグラウンド tick 駆動(M29)   | engine advance で toTick まで進める |
//   | `catchUpApplied`  | Worker catch-up 完了(platform/workerClient) | スナップショットを据える |
//   | `commandApplied`  | プレイヤー操作(画面)             | engine の `apply(Command)` の結果を据える |
//   | `cellSelected`    | ②格子ビューのタップ(M18/M30)     | 選択セルの変更(UI 状態)。**[M18] 占有セルはアンカーへ正規化**(§1 末尾/`CellSelectedEvent`) |
//   | `screenOpened`    | 自前ハッシュルータ(M29・ADR-027) | 現在画面の写しを更新 |
//
//   **[M49] `stateApplied`(コマンド適用の暫定口)は撤去した。** 世界の中の
//   state 遷移は `ticked` / `catchUpApplied` / `commandApplied` の 3 経路だけで
//   あり、engine の外で組み立てた任意の state を据えられるのは**世界の総入れ替え
//   (`worldLoaded`)だけ**である。判定(置けるか・払えるか)は engine の
//   `src/engine/commands.ts` にあり、ストアにも画面にも 1 行も無い。
//
//   コマンドが拒否されたときは**例外を投げない**。`DispatchResult.command` に
//   engine の {@link CommandResult}(`ok: false` + 機械可読の `rejection`)が
//   そのまま載るので、画面はそれを見てメッセージを出す(黙って何も起きない、を
//   作らない・commands.ts §3)。
//
// ===========================================================================
// 2. state は複製しない(ADR-028 の単一正準実装から外れる経路を作らない)
// ===========================================================================
//   ストアは GameState を**受け取って参照を持つだけ**であり、複製も部分更新も
//   しない。state を新しくするのは engine の advance / update.ts だけで、
//   ストア側にコピー経路(スプレッド・structuredClone・Object.assign)は無い。
//   `dispatch({type:"ticked"})` の戻した state が engine の `advance()` の
//   戻り値と参照同一であることをテストで固定してある。
//
// ===========================================================================
// 3. AdvanceContext の作り直しは「配置が変わったときだけ」
// ===========================================================================
//   `createAdvanceContext` は隣接乗数 48 セルぶんの precompute(advance.ts §2)で
//   あり、毎 tick 走らせるものではない。ストアは同期時に「配置素性が変わった
//   セル」が 1 つでもあれば作り直し、無ければ据え置く。
//   Worker catch-up の完了時は**転送されてきた乗数をそのまま据える**
//   (`restoreAdvanceContext`)ので、メインスレッドでの engine 再計算は 0 =
//   perf-boundaries §3 B3 の「B3 は engine の再計算を含まない」を保つ。
//
// ===========================================================================
// 4. 長い catch-up をメインスレッドで走らせない
// ===========================================================================
//   `ticked` は `chooseCatchUpRoute`(platform/catchUp.ts)で経路を判定し、
//   Worker 経路の領域(> 600 tick)なら**例外にする**。ここで黙って走らせると
//   ADR-019/ADR-029 の予算設計が無言で破れるため。呼び出し側は Worker へ回して
//   `catchUpApplied` を投げる。
//
// ===========================================================================
// 5. 世界の入れ替えは外へ 1 本だけ通知する(`onWorldLoaded`)
// ===========================================================================
//   `worldLoaded` は state を丸ごと差し替えるので、**ストアの外にある「今の
//   tick はこれだ」という前提が全部無効になる**: tick 駆動のアンカー
//   (platform/clock.ts §6)と、IndexedDB に載っているセーブの内容である。
//   AIプレイテスト Round 1 の fatal 2 件(インポート後・最初からやり直した後に
//   ゲーム内時刻が永久凍結し、リロードで入れ替え前に戻る)は、この 2 つを
//   画面側が個別に呼ぶ設計になっておらず**どこからも呼ばれていなかった**
//   ことが原因だった。
//
//   対策として、通知を**唯一の書き込み口である dispatch の中**へ置いた。
//   世界の入れ替え経路が今後増えても(どの画面から `worldLoaded` を出しても)
//   結線は自動的に効く = 呼び忘れが構造的に起きない。ストアが知っているのは
//   「コールバックを 1 個呼ぶ」ことだけで、アンカーもセーブも知らない
//   (実際の再アンカー/保存は composition root `src/main.tsx` の担当。
//   architecture.md §1 の「platform → ui は無い」を保つ)。
//
//   通知は `batch` の**外**(全 signal が落ち着いた後)で呼ぶ。コールバックから
//   `dispatch` を呼び返すことは想定していない(再入は禁止)。
// ---------------------------------------------------------------------------

import { advance, createAdvanceContext } from "../engine/advance";
import { GRID_CELL_COUNT } from "../engine/adjacency";
import { apply, type CommandInput, type CommandResult } from "../engine/commands";
import type { AdvanceContext, EngineContent } from "../engine/rules/types";
import type { GameState } from "../engine/state/state";
import { worldSeedToUint32 } from "../engine/stochastic";
import {
  LIVE_ADVANCE_MAX_TICK_DELTA,
  chooseCatchUpRoute,
  restoreAdvanceContext,
  type TransferableAdvanceContext,
} from "../platform/catchUp";
import { createStoreDerived, type StoreDerived } from "./derived";
import { ReactiveScope, batch, getReactiveStats, type ReactiveStats } from "./reactive";
import { isScreenId, type ScreenId } from "./screens";
import {
  createStoreSources,
  syncSourcesFromState,
  type ReadonlyStoreSources,
  type SourceSyncReport,
} from "./sources";

/** ストアの使い方の誤り(未来でない tick・前景経路の上限超過・不正なセル番号)。 */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

// --- 1. イベント語彙 -------------------------------------------------------

/** 世界の入れ替え元。`worldLoaded` の由来(ログ/計測の分類にだけ使う)。 */
export type WorldLoadSource = "import" | "newGame" | "save";

/**
 * content + state の総入れ替え。新規開始・セーブ復元・インポートの 3 経路。
 *
 * `advanceContext` を渡すと `createAdvanceContext` を呼ばずにそれを据える
 * (Worker が計算済みの隣接乗数を持って復帰する経路・§3)。
 */
export interface WorldLoadedEvent {
  readonly type: "worldLoaded";
  readonly state: GameState;
  readonly content: EngineContent;
  readonly source: WorldLoadSource;
  readonly advanceContext?: TransferableAdvanceContext;
}

/**
 * フォアグラウンドの tick 進行(ADR-026)。`toTick` は
 * `computeTargetTick(state.tick, 経過ms)` の結果であり、**タイマーの発火回数から
 * 作ってはならない**(算出は platform/clock.ts + engine/advance.ts の担当)。
 */
export interface TickedEvent {
  readonly type: "ticked";
  readonly toTick: number;
}

/** Worker catch-up の完了スナップショット(ADR-019/029)。 */
export interface CatchUpAppliedEvent {
  readonly type: "catchUpApplied";
  readonly snapshot: GameState;
  readonly advanceContext: TransferableAdvanceContext;
}

/**
 * [M49] プレイヤー操作(engine コマンド)の適用。
 *
 * ストアは `apply(state, content, command)` を呼んで結果を据えるだけで、
 * **判定は 1 行も持たない**。`command` には 1 個または列(原子適用)を渡せる。
 *
 * 拒否は例外ではなく `DispatchResult.command` に載る(§1)。tick は動かない。
 */
export interface CommandAppliedEvent {
  readonly type: "commandApplied";
  readonly command: CommandInput;
}

/**
 * 選択セルの変更(GDD 6.6 の 2 ステップ配置)。null は選択解除。
 *
 * **[M18・★裁定] 占有セルを選択すると常にアンカーへ正規化される**(`applyEvent`
 * の `cellSelected` 分岐を参照)。大型施設(GDD 6.1 の 2×1/1×2/2×2)は
 * `anchorCellIndex === cellIndex` のセルにしか選択枠を描かない設計(M17 申し
 * 送り・derived.ts の `CellViewModel` コメント)なので、非アンカーをタップして
 * 生の cellIndex をそのまま選択に据えると「タップしたのに枠が出ない」矛盾が
 * 起きる。代替案(非正規化のまま画面側で都度アンカーへ解決)も検討したが、
 * `selectedCell` 派生値・将来の全画面が同じ解決を書く羽目になるため、ストアの
 * 単一箇所(ここ)で正規化する方を採った。空きセルの選択はそのまま(アンカーの
 * 概念が無い)。
 */
export interface CellSelectedEvent {
  readonly type: "cellSelected";
  readonly cellIndex: number | null;
}

/** ルータが決めた現在画面の写し(ADR-027・権威は platform/router.ts)。 */
export interface ScreenOpenedEvent {
  readonly type: "screenOpened";
  readonly screen: ScreenId;
}

export type StoreEvent =
  | CatchUpAppliedEvent
  | CellSelectedEvent
  | CommandAppliedEvent
  | ScreenOpenedEvent
  | TickedEvent
  | WorldLoadedEvent;

export type StoreEventType = StoreEvent["type"];

/** dispatch の結果。診断・テスト・計測が読む(UI の描画には使わない)。 */
export interface DispatchResult {
  readonly type: StoreEventType;
  /** GameState signal が実際に差し替わったか。 */
  readonly stateChanged: boolean;
  /** 配置素性が変わったセル(昇順)。空なら隣接 computed は 1 個も汚れない。 */
  readonly changedPlacementCells: readonly number[];
  /** `createAdvanceContext`(engine の precompute)を走らせたか(§3)。 */
  readonly advanceContextRebuilt: boolean;
  /** 転送済みコンテキストを据えたか(engine 再計算なし・§3)。 */
  readonly advanceContextRestored: boolean;
  /**
   * [M49] `commandApplied` のときの engine の判定結果(他のイベントでは null)。
   *
   * DispatchResult の他のフィールドは診断用だが、**これだけは画面が読んでよい**
   * — 拒否されたことを利用者へ伝える手段が他に無いため(黙って何も起きない、を
   * 作らない・§1)。分岐は `rejection.code` で行い、`message` は表示のみに使う。
   */
  readonly command: CommandResult | null;
}

// --- 2. 画面のマウント単位(ADR-027) ---------------------------------------

export interface ScreenMount {
  readonly screenId: ScreenId;
  /** この画面が作る購読・画面ローカル派生値の入れ物。 */
  readonly scope: ReactiveScope;
  /** アンマウント。購読は全部切れる(ADR-027(2))。 */
  dispose(): void;
}

export interface MountScreenOptions {
  /** マウントと同時に現在画面にするか(既定 true)。常駐シェルは false。 */
  readonly activate?: boolean;
}

// --- 3. 診断 ---------------------------------------------------------------

export interface StoreStats {
  readonly dispatchCount: number;
  /** GameState signal を実際に差し替えた回数。 */
  readonly stateInstallCount: number;
  /** 配置素性が変わった同期の回数(隣接 computed が汚れた回数)。 */
  readonly placementChangeCount: number;
  /** `createAdvanceContext` を走らせた回数(= engine precompute の回数)。 */
  readonly advanceContextBuildCount: number;
  /** 転送済みコンテキストを据えた回数(engine 再計算なし)。 */
  readonly advanceContextRestoreCount: number;
  readonly mountedScreenCount: number;
  readonly reactive: ReactiveStats;
}

// --- 4. ストア本体 ---------------------------------------------------------

export interface GameStore {
  /** 根 signal 群(読み取り専用ビュー)。**画面から直接読まない**(sources.ts §3)。 */
  readonly sources: ReadonlyStoreSources;
  /** 画面が購読してよい派生値。 */
  readonly derived: StoreDerived;
  /** 唯一の書き込み口。 */
  dispatch(event: StoreEvent): DispatchResult;
  /** 非追跡の state 読み出し(コマンド組み立て・保存など)。 */
  peekState(): GameState;
  peekContent(): EngineContent;
  peekAdvanceContext(): AdvanceContext;
  /** 画面をマウントする(購読スコープを作る)。 */
  mountScreen(screenId: ScreenId, options?: MountScreenOptions): ScreenMount;
  mountedScreenIds(): readonly ScreenId[];
  stats(): StoreStats;
}

export interface CreateGameStoreInput {
  readonly state: GameState;
  readonly content: EngineContent;
  /**
   * 既に計算済みの隣接乗数(復帰経路)。渡さない場合はここで
   * `createAdvanceContext` を 1 回だけ走らせる。
   */
  readonly advanceContext?: TransferableAdvanceContext;
  /**
   * 世界が入れ替わった(`worldLoaded` を適用し終えた)直後に 1 回だけ呼ばれる
   * 通知(§5)。渡さなければ何も起きない(テスト・部品単体での利用)。
   *
   * 受け取るのは**据えたあとの** state と、その由来(`import`/`newGame`/`save`)。
   * `src/main.tsx` はこれで tick 駆動のアンカー引き直し(`TickDriver.syncTo`)と
   * 即時保存(`SaveScheduler`)を行う。**このコールバックから `dispatch` を
   * 呼び返さないこと**(再入は想定していない)。
   */
  readonly onWorldLoaded?: (state: GameState, source: WorldLoadSource) => void;
  /**
   * [M62/FC2] `commandApplied` を適用し終えた直後に 1 回だけ呼ばれる通知
   * (`onWorldLoaded` と同じ設計・§5 の理由がそのまま当てはまる)。渡さなければ
   * 何も起きない(テスト・部品単体での利用)。
   *
   * 拒否も含め、engine の判定結果(`CommandResult`)をそのまま渡す
   * ——「記録するかどうか」の判定(拒否は数えない・列は要素数ぶん数える)は
   * `saveScheduler.recordCommandOutcome` 自身が持つので、ここでは分岐しない。
   * `src/main.tsx` はこれで `SaveScheduler.recordCommandOutcome` を呼ぶ
   * (architecture.md §4-1 が元々指していた結線点。**呼び出し箇所が
   * 画面ごとに散っていると呼び忘れが起きる**——`onWorldLoaded` が R1 fatal
   * 2 件で証明した教訓と同型なので、同じ「唯一の書き込み口 dispatch の中で
   * 通知する」形を踏襲する)。**このコールバックから `dispatch` を呼び返さない
   * こと**(再入は想定していない)。
   */
  readonly onCommandApplied?: (result: CommandResult) => void;
}

/**
 * ストアを作る。**アプリ 1 起動につき 1 個**であり、画面遷移では作り直さない
 * (M29 の検収条件「画面遷移でストアが再生成されないテスト」の前提)。
 */
export function createGameStore(input: CreateGameStoreInput): GameStore {
  let dispatchCount = 0;
  let stateInstallCount = 0;
  let placementChangeCount = 0;
  let advanceContextBuildCount = 0;
  let advanceContextRestoreCount = 0;

  const initialContext =
    input.advanceContext === undefined
      ? createAdvanceContext(input.state, input.content)
      : restoreAdvanceContext(input.content, input.advanceContext);
  if (input.advanceContext === undefined) advanceContextBuildCount++;
  else advanceContextRestoreCount++;

  const sources = createStoreSources({
    state: input.state,
    content: input.content,
    advanceContext: initialContext,
  });
  const derived = createStoreDerived(sources);

  // 根 signal の初期化。ここで 48 セルが埋まる。
  const initialSync = syncSourcesFromState(sources, input.state, input.content);
  if (initialSync.changedPlacementCells.length > 0) placementChangeCount++;

  const mounts = new Set<ScreenMount>();

  interface InstallOutcome {
    readonly report: SourceSyncReport;
    readonly rebuilt: boolean;
    readonly restored: boolean;
  }

  function installWorldState(
    nextState: GameState,
    nextContent: EngineContent,
    transferred: TransferableAdvanceContext | null,
    forceContextRebuild: boolean,
  ): InstallOutcome {
    return batch<InstallOutcome>(() => {
      const contentChanged = sources.content.set(nextContent);
      sources.worldSeedU32.set(worldSeedToUint32(nextState.worldSeed));
      const report = syncSourcesFromState(sources, nextState, nextContent);

      if (report.stateChanged) stateInstallCount++;
      if (report.changedPlacementCells.length > 0) placementChangeCount++;

      if (transferred !== null) {
        // Worker が計算済み = メインで engine を再計算しない(§3)。
        sources.advanceContext.set(restoreAdvanceContext(nextContent, transferred));
        advanceContextRestoreCount++;
        return { report, rebuilt: false, restored: true };
      }
      if (forceContextRebuild || contentChanged || report.changedPlacementCells.length > 0) {
        sources.advanceContext.set(createAdvanceContext(nextState, nextContent));
        advanceContextBuildCount++;
        return { report, rebuilt: true, restored: false };
      }
      return { report, rebuilt: false, restored: false };
    });
  }

  function requireCellIndex(cellIndex: number): void {
    if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= GRID_CELL_COUNT) {
      throw new StoreError(
        `セル番号 ${String(cellIndex)} が格子の範囲(0〜${String(GRID_CELL_COUNT - 1)})を外れている`,
      );
    }
  }

  function applyTicked(event: TickedEvent): DispatchResult {
    const current = sources.state.peek();
    if (!Number.isSafeInteger(event.toTick)) {
      throw new StoreError(`toTick ${String(event.toTick)} が安全整数でない`);
    }
    const delta = event.toTick - current.tick;
    if (delta < 0) {
      throw new StoreError(
        // 巻き戻しの検知は platform/clock.ts の担当(GDD 11.9)
        `toTick ${String(event.toTick)} が現在 tick ${String(current.tick)} より過去`,
      );
    }
    if (delta === 0) {
      return {
        type: "ticked",
        stateChanged: false,
        changedPlacementCells: [],
        advanceContextRebuilt: false,
        advanceContextRestored: false,
        command: null,
      };
    }
    if (chooseCatchUpRoute(delta) !== "main-structural-sharing") {
      throw new StoreError(
        `tick 差 ${String(delta)} は前景経路の上限 ${String(LIVE_ADVANCE_MAX_TICK_DELTA)} を超える。` +
          `Worker catch-up(platform/workerClient.ts)へ回して catchUpApplied を dispatch すること(ADR-026(3)/ADR-019)`,
      );
    }

    const nextState = advance(current, sources.advanceContext.peek(), event.toTick);
    const installed = installWorldState(nextState, sources.content.peek(), null, false);
    return {
      type: "ticked",
      stateChanged: installed.report.stateChanged,
      changedPlacementCells: installed.report.changedPlacementCells,
      advanceContextRebuilt: installed.rebuilt,
      advanceContextRestored: installed.restored,
      command: null,
    };
  }

  function applyCatchUp(event: CatchUpAppliedEvent): DispatchResult {
    const current = sources.state.peek();
    if (event.snapshot.tick < current.tick) {
      throw new StoreError(
        `catch-up スナップショットの tick ${String(event.snapshot.tick)} が現在 tick ${String(current.tick)} より過去(古い応答を据えると巻き戻る)`,
      );
    }
    const installed = installWorldState(
      event.snapshot,
      sources.content.peek(),
      event.advanceContext,
      false,
    );
    return {
      type: "catchUpApplied",
      stateChanged: installed.report.stateChanged,
      changedPlacementCells: installed.report.changedPlacementCells,
      advanceContextRebuilt: installed.rebuilt,
      advanceContextRestored: installed.restored,
      command: null,
    };
  }

  function applyWorldLoaded(event: WorldLoadedEvent): DispatchResult {
    const installed = installWorldState(
      event.state,
      event.content,
      event.advanceContext ?? null,
      true,
    );
    // 別の世界のセル選択は意味を持たないので落とす。現在画面は据え置き
    // (どの画面から復帰したかはルータが決める・ADR-027)。
    sources.selectedCellIndex.set(null);
    return {
      type: "worldLoaded",
      stateChanged: installed.report.stateChanged,
      changedPlacementCells: installed.report.changedPlacementCells,
      advanceContextRebuilt: installed.rebuilt,
      advanceContextRestored: installed.restored,
      command: null,
    };
  }

  /**
   * [M49] プレイヤー操作。**engine の判定結果をそのまま据える**だけで、
   * ストア側に検査は無い(worldSeed / tick の整合は `apply` が現在の state から
   * 次の state を作る構造そのものが保証している)。
   */
  function applyCommand(event: CommandAppliedEvent): DispatchResult {
    const result = apply(sources.state.peek(), sources.content.peek(), event.command);
    if (!result.ok) {
      // 拒否は例外にしない(§1)。state も signal も 1 つも動かさない。
      return {
        type: "commandApplied",
        stateChanged: false,
        changedPlacementCells: [],
        advanceContextRebuilt: false,
        advanceContextRestored: false,
        command: result,
      };
    }
    const installed = installWorldState(result.state, sources.content.peek(), null, false);
    return {
      type: "commandApplied",
      stateChanged: installed.report.stateChanged,
      changedPlacementCells: installed.report.changedPlacementCells,
      advanceContextRebuilt: installed.rebuilt,
      advanceContextRestored: installed.restored,
      command: result,
    };
  }

  function applyEvent(event: StoreEvent): DispatchResult {
    switch (event.type) {
      case "worldLoaded":
        return applyWorldLoaded(event);
      case "commandApplied":
        return applyCommand(event);
      case "ticked":
        return applyTicked(event);
      case "catchUpApplied":
        return applyCatchUp(event);
      case "cellSelected": {
        let normalizedCellIndex = event.cellIndex;
        if (normalizedCellIndex !== null) {
          requireCellIndex(normalizedCellIndex);
          // [M18・★裁定] 占有セルはアンカーへ正規化する(CellSelectedEvent の
          // コメント参照)。空きセル(placement === null)はそのまま。
          const placement = sources.cellPlacement[normalizedCellIndex]?.peek() ?? null;
          if (placement !== null) normalizedCellIndex = placement.anchorCellIndex;
        }
        sources.selectedCellIndex.set(normalizedCellIndex);
        return {
          type: "cellSelected",
          stateChanged: false,
          changedPlacementCells: [],
          advanceContextRebuilt: false,
          advanceContextRestored: false,
          command: null,
        };
      }
      case "screenOpened": {
        if (!isScreenId(event.screen)) {
          throw new StoreError(`未知の画面 ID "${String(event.screen)}"(screens.ts の語彙外)`);
        }
        sources.activeScreen.set(event.screen);
        return {
          type: "screenOpened",
          stateChanged: false,
          changedPlacementCells: [],
          advanceContextRebuilt: false,
          advanceContextRestored: false,
          command: null,
        };
      }
      default: {
        const unhandled: never = event;
        throw new StoreError(`未知のストアイベント ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return {
    sources,
    derived,

    dispatch(event: StoreEvent): DispatchResult {
      dispatchCount++;
      // 1 dispatch = 1 回の再描画。途中経過を effect に見せない。
      const result = batch(() => applyEvent(event));
      if (event.type === "worldLoaded") {
        // 世界の入れ替えを外へ 1 本だけ通知する(§5)。batch の外なので、
        // 受け手が見る signal は全て新しい世界のものに揃っている。
        input.onWorldLoaded?.(sources.state.peek(), event.source);
      }
      if (event.type === "commandApplied" && result.command !== null) {
        // [M62/FC2] コマンド適用の結果を外へ 1 本だけ通知する(onWorldLoaded と
        // 同型・batch の外)。`result.command` は `applyCommand` が必ず埋める
        // ので commandApplied イベントでは非 null(store.ts §1 の doc どおり)。
        input.onCommandApplied?.(result.command);
      }
      return result;
    },

    peekState: () => sources.state.peek(),
    peekContent: () => sources.content.peek(),
    peekAdvanceContext: () => sources.advanceContext.peek(),

    mountScreen(screenId: ScreenId, options: MountScreenOptions = {}): ScreenMount {
      if (!isScreenId(screenId)) {
        throw new StoreError(`未知の画面 ID "${String(screenId)}"(screens.ts の語彙外)`);
      }
      const scope = new ReactiveScope(`screen:${screenId}`);
      const mount: ScreenMount = {
        screenId,
        scope,
        dispose(): void {
          if (!mounts.has(mount)) return;
          mounts.delete(mount);
          scope.dispose();
        },
      };
      mounts.add(mount);
      if (options.activate !== false) {
        sources.activeScreen.set(screenId);
      }
      return mount;
    },

    mountedScreenIds(): readonly ScreenId[] {
      const ids: ScreenId[] = [];
      for (const mount of mounts) ids.push(mount.screenId);
      return ids;
    },

    stats(): StoreStats {
      return {
        dispatchCount,
        stateInstallCount,
        placementChangeCount,
        advanceContextBuildCount,
        advanceContextRestoreCount,
        mountedScreenCount: mounts.size,
        reactive: getReactiveStats(),
      };
    },
  };
}
