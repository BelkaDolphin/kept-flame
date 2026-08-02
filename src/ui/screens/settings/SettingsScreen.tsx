// ---------------------------------------------------------------------------
// 継ぐ火 -Kept Flame- ＋セーブ/設定(M33)— GDD 12.5 / 13.3 / 2.2
//
// ===========================================================================
// 1. この画面がやること
// ===========================================================================
//   (a) エクスポート: `platform/exchange.ts` の {@link exportSaveText} を
//       そのまま呼び、ファイルとしてダウンロードする(+ 手動コピー用に
//       テキストも表示する)。
//   (b) インポート: {@link importSaveText} をそのまま呼び、成功したら
//       `worldLoaded`(`source: "import"`)を dispatch する。
//       **[R1-A01/A02] 入れ替え後の後始末(tick 駆動アンカーの引き直しと即時
//       保存)はこの画面の仕事ではない**。ストアが `worldLoaded` を適用した
//       直後に composition root へ 1 本だけ通知し(`src/ui/store.ts` §5)、
//       `src/main.tsx` の `handleWorldLoaded` が両方を行う。ここで個別に呼ぶと
//       「最初からやり直す」等の別経路で呼び忘れが再発するので、足さないこと。
//   (c) 破損セーブの救済: (b) と**同じ導線**である。`src/main.tsx` は
//       起動時のセーブ読出しに失敗すると「セーブが無い」と同じ扱いで新規
//       ゲームを始める(申し送り済み・main.tsx のコメント参照)ため、
//       「起動直後に進行状況が消えている」に気づいたプレイヤーがここへ来て
//       以前エクスポートしたファイルを読み込めば復元できる、という**常時
//       利用可能な**救済導線として実装する(失敗検出のリアルタイム表示は
//       main.tsx 側の変更が要るため本タスクのスコープ外・★報告)。
//   (d) 容量/難度シード表示(ui-spec ＋行「エクスポート/インポート、容量、
//       バックアップリマインド、難度シード表示」): `saveCapacity.ts` の
//       {@link checkSaveCapacity}(「UI 表示は後続タスク」と明記済み = 本タスク)
//       と `state.worldSeed` をそのまま表示する。
//
// ===========================================================================
// 2. 新規 platform ファイルを追加しない(タスク制約)
// ===========================================================================
//   export/import に必要な直列化関数(`encodeSaveRecord`/`exportSaveText`/
//   `importSaveText`/`checkSaveCapacity`)はすべて M4 で実装済みであり、
//   本画面はそれらを呼ぶだけである。ファイルのダウンロード/選択は標準の
//   Web API(Blob/URL.createObjectURL/FileReader)を使うだけで新規 npm 依存は
//   追加しない。
// ---------------------------------------------------------------------------

import { useState } from "preact/hooks";

import { recordBackupExported } from "../../../platform/backupReminder";
import { exportSaveText, importSaveText } from "../../../platform/exchange";
import { resolveLocalStorage } from "../../../platform/localStorageMirror";
import { encodeSaveRecord } from "../../../platform/persistence";
import { checkSaveCapacity, type SaveCapacityCheck } from "../../../platform/saveCapacity";
import { createNewGameState } from "../../../newGame";
import { TESTPLAY_SPEEDS, type TestplaySpeed } from "../../testplaySpeed";
import type { ScreenProps } from "../screenProps";
import { useToastStack, ToastStackView } from "../Toast";
import { useScreenMount, useSignalValue } from "../useStoreSignal";
import "./settingsScreen.css";

// --- 1. インポート結果の表示モデル -------------------------------------------

export interface ImportOutcomeView {
  readonly status: "success" | "error";
  readonly message: string;
}

// --- 2. 部品(hooks 不使用・直接テスト可能) ----------------------------------

export interface ExportPanelProps {
  /** `null` = まだエクスポートを実行していない。 */
  readonly exportedText: string | null;
  readonly onExport: () => void;
}

export function ExportPanel({ exportedText, onExport }: ExportPanelProps) {
  return (
    <section class="kf-settings__export" aria-label="エクスポート">
      <h3 class="kf-settings__section-title">エクスポート</h3>
      <p class="kf-settings__section-note">
        セーブをファイルとして書き出します。特に大移動や継承点購入の直後は、今すぐエクスポートして
        バックアップを取ることを強く推奨します。
      </p>
      <button type="button" class="kf-settings__export-button" onClick={onExport}>
        エクスポートしてダウンロード
      </button>
      {exportedText !== null && (
        <textarea
          class="kf-settings__export-text"
          readOnly
          value={exportedText}
          aria-label="エクスポートされたセーブデータ(コピー用)"
        />
      )}
    </section>
  );
}

export interface ImportPanelProps {
  readonly importText: string;
  readonly onImportTextChange: (value: string) => void;
  readonly onFileSelected: (event: Event) => void;
  readonly onSubmit: () => void;
  readonly outcome: ImportOutcomeView | null;
  /** [束B/m-6] 選択済みファイル名(未選択は null)。SettingsScreen が保持する。 */
  readonly selectedFileName: string | null;
}

/**
 * [束B/m-6] ファイル選択は `<input type="file">` を視覚的に隠し、44px 以上の
 * 日本語ラベルボタン「ファイルを選ぶ」でラップする(ブラウザ既定の入力欄は
 * OS 依存の見た目で 44px を保証できず、文言も英語になりがちなため)。
 * `<label for=...>` によるネイティブな委譲でクリックを転送するので、
 * hooks(ref)を持ち込まずに済む(このコンポーネントの「hooks 不使用」規約を
 * 保ったまま実現できる)。選択後のファイル名は自前で表示する。
 */
export function ImportPanel({
  importText,
  onImportTextChange,
  onFileSelected,
  onSubmit,
  outcome,
  selectedFileName,
}: ImportPanelProps) {
  function handleTextareaChange(event: Event): void {
    onImportTextChange((event.target as HTMLTextAreaElement).value);
  }

  return (
    <section class="kf-settings__import" aria-label="インポート/破損セーブの救済">
      <h3 class="kf-settings__section-title">インポート・破損セーブの救済</h3>
      <p class="kf-settings__section-note">
        起動に失敗した場合や、進行状況が急に消えてしまった場合は、以前エクスポートしたファイルを
        ここから読み込むことで復元できます。
      </p>
      <div class="kf-settings__import-file-row">
        <input
          type="file"
          id="kf-settings-import-file-input"
          class="kf-settings__import-file"
          accept="application/json,.json"
          onChange={onFileSelected}
          aria-label="バックアップファイルを選択"
        />
        <label for="kf-settings-import-file-input" class="kf-settings__import-file-button">
          ファイルを選ぶ
        </label>
        <span class="kf-settings__import-file-name">
          {selectedFileName ?? "選択されていません"}
        </span>
      </div>
      <textarea
        class="kf-settings__import-text"
        value={importText}
        onChange={handleTextareaChange}
        aria-label="またはエクスポートしたテキストを直接貼り付け"
        placeholder="エクスポートしたテキストをここに貼り付けることもできます"
      />
      <button
        type="button"
        class="kf-settings__import-button"
        disabled={importText.length === 0}
        onClick={onSubmit}
      >
        インポートを実行
      </button>
      {outcome !== null && (
        <p
          class={`kf-settings__import-outcome kf-settings__import-outcome--${outcome.status}`}
          role={outcome.status === "error" ? "alert" : "status"}
        >
          {outcome.message}
        </p>
      )}
    </section>
  );
}

// --- 2b. [M54] 最初からやり直す(hooks 不使用・直接テスト可能) ----------------

/**
 * 「最初からやり直す」導線の確認 2 段(ロードマップ M54 行「誤タップ防止」)。
 *
 * 大移動の実行前確認(`MigrationScreen.tsx` の `confirming`)は 1 段だが、
 * こちらは**現在の周回の全データを無条件に捨てる**(大移動と違い継承点も
 * 何も残らない)ため、誤タップの重大度が一段高いと判断し 2 段にした
 * (タスク指示どおり)。
 *
 *   段 0: 「最初からやり直す」ボタンのみ。
 *   段 1: 警告(データは消える・エクスポート推奨)+「次へ」/「キャンセル」。
 *   段 2: 最終確認(取り消せない旨の念押し)+「消去して新規開始する」/「キャンセル」。
 */
export interface ResetGameSectionProps {
  readonly step: 0 | 1 | 2;
  readonly onStart: () => void;
  readonly onProceed: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ResetGameSection({
  step,
  onStart,
  onProceed,
  onConfirm,
  onCancel,
}: ResetGameSectionProps) {
  return (
    <section class="kf-settings__reset" aria-label="最初からやり直す">
      <h3 class="kf-settings__section-title">最初からやり直す</h3>
      {step === 0 && (
        <>
          <p class="kf-settings__section-note">
            現在の周回のデータを消して、新しいゲームとして最初から開始できます。難度シードは既定の
            まま引き継がれます。
          </p>
          <button type="button" class="kf-settings__reset-start-button" onClick={onStart}>
            最初からやり直す
          </button>
        </>
      )}
      {step === 1 && (
        <section class="kf-settings__reset-warning" role="alertdialog" aria-label="やり直しの確認1">
          <p class="kf-settings__reset-warning-message">
            現在のデータは全て消えます。元に戻せないので、まだエクスポートしていなければ先に上の
            「エクスポートしてダウンロード」で退避することを強くお勧めします。
          </p>
          <div class="kf-settings__reset-actions">
            <button type="button" class="kf-settings__reset-proceed-button" onClick={onProceed}>
              次へ(理解した上で続ける)
            </button>
            <button type="button" class="kf-settings__reset-cancel-button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </section>
      )}
      {step === 2 && (
        <section class="kf-settings__reset-warning" role="alertdialog" aria-label="やり直しの確認2">
          <p class="kf-settings__reset-warning-message">
            本当によろしいですか。この操作は取り消せません。現在のセーブは新しいゲームの初期状態で
            上書きされます。
          </p>
          <div class="kf-settings__reset-actions">
            <button type="button" class="kf-settings__reset-confirm-button" onClick={onConfirm}>
              はい、消去して新規開始する
            </button>
            <button type="button" class="kf-settings__reset-cancel-button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

// --- 2c. [M59] テストプレイ支援(hooks 不使用・直接テスト可能) ----------------
//
// 実際の速度変更(`ScaledClock.setSpeed`)とその UI 反応系ブリッジ
// (`createTestplaySpeedController`)は `src/platform/timeScale.ts` /
// `src/ui/testplaySpeed.ts` に既にあるので、ここは ×1/×60/×720 の3択ボタンと
// 現在値の表示だけを持つ薄い部品にする(`ResetGameSection` と同じ「hooks を
// 持たない・値とコールバックだけを props で受ける」形)。

export interface TestplaySpeedSectionProps {
  readonly speed: number;
  readonly onSetSpeed: (speed: TestplaySpeed) => void;
}

export function TestplaySpeedSection({ speed, onSetSpeed }: TestplaySpeedSectionProps) {
  return (
    <section class="kf-settings__testplay" aria-label="テストプレイ支援">
      <h3 class="kf-settings__section-title">テストプレイ支援</h3>
      <p class="kf-settings__section-note">
        時間の進みを速めて動作確認をしやすくします。セッション限りの設定です(リロードすると必ず ×1
        に戻ります)。
      </p>
      <p class="kf-settings__testplay-current">
        現在の速度: <strong>×{speed}</strong>
      </p>
      <div class="kf-settings__testplay-buttons" role="group" aria-label="速度選択">
        {TESTPLAY_SPEEDS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            class="kf-settings__testplay-button"
            aria-pressed={candidate === speed}
            onClick={() => onSetSpeed(candidate)}
          >
            ×{candidate}
          </button>
        ))}
      </div>
      {speed !== 1 && (
        <p class="kf-settings__testplay-warning" role="status">
          いま ×{speed} で進行しています。ヘッダにインジケータが常時表示されます。テストが終わったら
          ×1 に戻すことを推奨します。
        </p>
      )}
    </section>
  );
}

// --- 3. 画面本体(hooks を持つのはここだけ) ----------------------------------

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SettingsScreen({ store, onNavigate, testplaySpeed }: ScreenProps) {
  // 現在地の宣言はシェル(shellSession)の仕事なので activate は false(M18★5)。
  useScreenMount(store, "settings", { activate: false });
  // [M59] ヘッダのインジケータと同じ signal を購読するので、設定画面で切り替えた
  // 直後に AppShell 側の表示も揃う(2 箇所とも同じ `TestplaySpeedController`)。
  const testplaySpeedValue = useSignalValue(testplaySpeed.speed);

  const [exportedText, setExportedText] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcomeView | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  // [M54] 「最初からやり直す」の確認 2 段(0=未着手/1=第1確認/2=最終確認)。
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const toastStack = useToastStack();

  const state = store.peekState();
  let capacity: SaveCapacityCheck | null = null;
  try {
    capacity = checkSaveCapacity(encodeSaveRecord(state).payload);
  } catch {
    // 分岐木ノード上界超過等で符号化できない場合(SaveBoundsError)。容量欄は
    // 出さない(推測で数値を捏造しない)。エクスポート自体は下の handleExport
    // が同じ例外を投げるので、押した結果として気づける。
    capacity = null;
  }

  function handleExport(): void {
    const text = exportSaveText(store.peekState());
    setExportedText(text);
    downloadTextFile(`kept-flame-save-tick${String(store.peekState().tick)}.json`, text);
    // [M54] 定期バックアップ推奨バナーのデータ条件(backupReminder.ts §3)を
    // リセットする。実際にエクスポートした事実だけを記録し、判定は書かない。
    recordBackupExported(resolveLocalStorage());
  }

  function handleFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) return;
    setSelectedFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(typeof reader.result === "string" ? reader.result : "");
    };
    reader.readAsText(file);
  }

  function handleImportSubmit(): void {
    try {
      const imported = store.peekContent();
      const importedState = importSaveText(importText);
      store.dispatch({
        type: "worldLoaded",
        state: importedState,
        content: imported,
        source: "import",
      });
      setOutcome({
        status: "success",
        message: "インポートに成功しました。セーブを復元しました。",
      });
      setImportText("");
    } catch (error) {
      setOutcome({
        status: "error",
        message:
          `インポートに失敗しました: ${error instanceof Error ? error.message : String(error)}。` +
          "セーブが破損しているか、別のバックアップファイルを試す必要があります。",
      });
    }
  }

  // [M54] 最初からやり直す(確認 2 段・ResetGameSection の doc 参照)。
  function handleResetStart(): void {
    setResetStep(1);
  }

  function handleResetProceed(): void {
    setResetStep(2);
  }

  function handleResetCancel(): void {
    setResetStep(0);
  }

  function handleResetConfirm(): void {
    const content = store.peekContent();
    const current = store.peekState();
    // `newGame.ts` の既定(worldSeed/難度シード)をそのまま使う(タスク指示
    // 「難度シードは既定のまま」)。algoVersion だけは現在の state から引く
    // (main.tsx の起動時 `createNewGameState` 呼び出しと同じ考え方)。
    const fresh = createNewGameState(content, { algoVersion: current.algoVersion });
    store.dispatch({ type: "worldLoaded", state: fresh, content, source: "newGame" });
    setResetStep(0);
    toastStack.push("最初からやり直しました(新しいゲームを開始しました)。");
  }

  return (
    <section class="kf-settings-screen" aria-labelledby="kf-settings-screen-title">
      <h2 class="kf-settings-screen__title" id="kf-settings-screen-title">
        セーブ/設定
      </h2>
      <p class="kf-screen-intro">
        セーブデータの書き出し・読み込みと、進行状況が消えたときの復元を行います。
      </p>

      <ToastStackView toasts={toastStack.toasts} />

      <section class="kf-settings__info" aria-label="現在のセーブ情報">
        <p class="kf-settings__seed">難度シード: {state.worldSeed}</p>
        {capacity !== null && (
          <p class="kf-settings__capacity" data-capacity-level={capacity.level}>
            セーブ容量: 約{(capacity.byteLength / 1024).toFixed(1)}KB
            {capacity.level === "warning" &&
              "(警告: 1.5MB以上・そろそろエクスポートで退避を検討してください)"}
            {capacity.level === "abort" &&
              "(危険: 4MB以上・このままでは書込が中止されます。今すぐエクスポートしてください)"}
            {capacity.level === "ok" && capacity.exceedsTarget && "(目標の容量を超えています)"}
          </p>
        )}
      </section>

      <ExportPanel exportedText={exportedText} onExport={handleExport} />
      <ImportPanel
        importText={importText}
        onImportTextChange={setImportText}
        onFileSelected={handleFileSelected}
        onSubmit={handleImportSubmit}
        outcome={outcome}
        selectedFileName={selectedFileName}
      />

      <TestplaySpeedSection speed={testplaySpeedValue} onSetSpeed={testplaySpeed.setSpeed} />

      <ResetGameSection
        step={resetStep}
        onStart={handleResetStart}
        onProceed={handleResetProceed}
        onConfirm={handleResetConfirm}
        onCancel={handleResetCancel}
      />

      <div class="kf-settings-screen__nav">
        <button
          type="button"
          class="kf-settings-screen__nav-button"
          onClick={() => onNavigate("home")}
        >
          ①ホームハブへ
        </button>
      </div>
    </section>
  );
}
