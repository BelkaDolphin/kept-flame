// ---------------------------------------------------------------------------
// src/ui/screens/settings/SettingsScreen.tsx のテスト(M33)。
//
// `ExportPanel`/`ImportPanel` は hooks を使わない純関数コンポーネントなので、
// Preact の render() を通さず直接呼んで vnode 構造を検証する
// (expeditionScreen.test.ts と同じ方針)。
//
// **検収条件「export/import が UI から往復できる」**の核は
// `platform/exchange.ts` の `exportSaveText`/`importSaveText`(既に
// `tests/platform/exchange.test.ts` がバイト同一往復を固定済み)を
// `SettingsScreen` がそのまま呼ぶだけであることなので、ここでは
// (a) 部品の表示 (b) `store.dispatch({type:"worldLoaded", source:"import"})`
// 経由でストアへ正しく反映されること、の 2 点を確認する。`SettingsScreen`
// 本体(hooks あり)は登録テスト(appShell.test.ts)のみで済ませる。
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import { exportSaveText, importSaveText } from "../../../src/platform/exchange";
import {
  ExportPanel,
  ImportPanel,
  OnboardingHelpSection,
  ResetGameSection,
  saveExportFilename,
  TestplaySpeedSection,
  type ImportOutcomeView,
} from "../../../src/ui/screens/settings/SettingsScreen";
import { createTestStore } from "../fixtures";

function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  const vnode = node as {
    readonly type?: unknown;
    readonly props?: { readonly children?: unknown };
  };
  if (typeof vnode.type === "function") {
    return flattenText((vnode.type as (props: unknown) => unknown)(vnode.props));
  }
  return flattenText(vnode.props?.children);
}

function hasTextareaChild(vnode: { readonly props: { readonly children?: unknown } }): boolean {
  const children = vnode.props.children as readonly unknown[];
  return children.some(
    (child) =>
      typeof child === "object" &&
      child !== null &&
      (child as { readonly type?: unknown }).type === "textarea",
  );
}

describe("[M63/R4-B03] saveExportFilename(エクスポートファイル名の内部語掃討)", () => {
  it("内部語 tick を含まない(旧: kept-flame-save-tick17019.json)", () => {
    const filename = saveExportFilename(17_019, new Date(2026, 7, 3, 15, 30, 45));
    expect(filename).not.toContain("tick");
  });

  it("ゲーム内日数(第N日相当)へ言い換える(1440tick=1日・GDD 11.1)", () => {
    expect(saveExportFilename(0, new Date(2026, 7, 3, 0, 0, 0))).toContain("day1");
    expect(saveExportFilename(1439, new Date(2026, 7, 3, 0, 0, 0))).toContain("day1");
    expect(saveExportFilename(1440, new Date(2026, 7, 3, 0, 0, 0))).toContain("day2");
    expect(saveExportFilename(17_019, new Date(2026, 7, 3, 0, 0, 0))).toContain("day12"); // floor(17019/1440)+1=12
  });

  it("実時刻を一意化のためだけに使う(コロン等ファイル名に使えない文字を含まない)", () => {
    const filename = saveExportFilename(0, new Date(2026, 7, 3, 15, 30, 45));
    expect(filename).not.toContain(":");
    expect(filename).toContain("20260803");
    expect(filename).toContain("153045");
  });

  it(".json で終わる", () => {
    expect(saveExportFilename(0, new Date(2026, 7, 3))).toMatch(/\.json$/);
  });

  it("同じゲーム内日数でも実時刻が違えば別ファイル名になる(上書き衝突を避ける)", () => {
    const a = saveExportFilename(100, new Date(2026, 7, 3, 10, 0, 0));
    const b = saveExportFilename(100, new Date(2026, 7, 3, 10, 0, 1));
    expect(a).not.toBe(b);
  });

  it("有限な非負整数でない tick は例外", () => {
    expect(() => saveExportFilename(-1, new Date())).toThrow(RangeError);
    expect(() => saveExportFilename(1.5, new Date())).toThrow(RangeError);
  });
});

describe("ExportPanel", () => {
  it("エクスポート前はテキストエリアを出さない(存在しない情報を捏造しない)", () => {
    const vnode = ExportPanel({ exportedText: null, onExport: () => undefined });
    expect(hasTextareaChild(vnode)).toBe(false);
  });

  it("エクスポート後はテキストエリアに内容を表示する", () => {
    const vnode = ExportPanel({
      exportedText: '{"saveFormatVersion":1}',
      onExport: () => undefined,
    });
    const children = vnode.props.children as readonly unknown[];
    const textarea = children.find(
      (child): child is { readonly props: { readonly value?: string } } =>
        typeof child === "object" &&
        child !== null &&
        (child as { readonly type?: unknown }).type === "textarea",
    );
    expect(textarea?.props.value).toBe('{"saveFormatVersion":1}');
  });

  it("押すと onExport が呼ばれる", () => {
    const onExport = vi.fn();
    const vnode = ExportPanel({ exportedText: null, onExport });
    const children = vnode.props.children as readonly {
      readonly props?: { readonly onClick?: () => void };
    }[];
    const button = children.find((child) => child.props?.onClick !== undefined);
    button?.props?.onClick?.();
    expect(onExport).toHaveBeenCalledOnce();
  });
});

describe("ImportPanel", () => {
  it("importText が空ならインポートボタンは disabled(判定は書かないが、空文字は構造的に無意味)", () => {
    const vnode = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: null,
    });
    const children = vnode.props.children as readonly {
      readonly props?: { readonly disabled?: boolean };
    }[];
    const button = children.find((child) => "disabled" in (child.props ?? {}));
    expect(button?.props?.disabled).toBe(true);
  });

  it("成功/失敗のメッセージを role で区別する(role=alert はエラーのみ)", () => {
    const success: ImportOutcomeView = { status: "success", message: "成功しました" };
    const successVnode = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: success,
      selectedFileName: null,
    });
    expect(flattenText(successVnode)).toContain("成功しました");

    const error: ImportOutcomeView = { status: "error", message: "失敗しました" };
    const errorVnode = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: error,
      selectedFileName: null,
    });
    expect(flattenText(errorVnode)).toContain("失敗しました");
  });

  it("破損セーブの救済を案内する文言を持つ(申し送り: main.tsx はロード失敗時に新規開始するのみ)", () => {
    const vnode = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: null,
    });
    expect(flattenText(vnode)).toContain("復元できます");
  });

  it("[束B/m-6] ファイル選択は44px以上の日本語ラベルボタンでラップし、選択済みファイル名を表示する", () => {
    const unselected = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: null,
    });
    expect(flattenText(unselected)).toContain("ファイルを選ぶ");
    expect(flattenText(unselected)).toContain("選択されていません");

    const selected = ImportPanel({
      importText: "",
      onImportTextChange: () => undefined,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: "kept-flame-save-tick1000.json",
    });
    expect(flattenText(selected)).toContain("kept-flame-save-tick1000.json");
  });

  it("[M70/R5-A09] 貼り付け欄は onInput で即時反映する(onChange=blur待ちだとモバイルで2タップ要求)", () => {
    const onImportTextChange = vi.fn();
    const vnode = ImportPanel({
      importText: "",
      onImportTextChange,
      onFileSelected: () => undefined,
      onSubmit: () => undefined,
      outcome: null,
      selectedFileName: null,
    });
    function findTextarea(node: unknown): {
      readonly props: { readonly onInput?: (e: Event) => void; readonly onChange?: unknown };
    } | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findTextarea(child);
          if (found !== null) return found;
        }
        return null;
      }
      if (node === null || node === undefined || typeof node !== "object") return null;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly children?: unknown };
      };
      if (candidate.type === "textarea") {
        return candidate as {
          readonly props: { readonly onInput?: (e: Event) => void; readonly onChange?: unknown };
        };
      }
      return findTextarea(candidate.props?.children);
    }
    const textarea = findTextarea(vnode);
    expect(textarea).not.toBeNull();
    expect(typeof textarea?.props.onInput).toBe("function");
    expect(textarea?.props.onChange).toBeUndefined();
    textarea?.props.onInput?.({ target: { value: "pasted" } } as unknown as Event);
    expect(onImportTextChange).toHaveBeenCalledWith("pasted");
  });
});

// [M59] ボタンの走査は ResetGameSection のテストと同じ vnode 再帰ヘルパを使う。
function findButtonsWithLabel(
  node: unknown,
  out: { readonly onClick: () => void; readonly text: string; readonly pressed: unknown }[],
): void {
  if (Array.isArray(node)) {
    for (const child of node) findButtonsWithLabel(child, out);
    return;
  }
  if (node === null || node === undefined || typeof node !== "object") return;
  const candidate = node as {
    readonly type?: unknown;
    readonly props?: {
      readonly onClick?: unknown;
      readonly children?: unknown;
      readonly "aria-pressed"?: unknown;
    };
  };
  if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
    out.push({
      onClick: candidate.props.onClick as () => void,
      text: flattenText(candidate.props.children),
      pressed: candidate.props["aria-pressed"],
    });
    return;
  }
  findButtonsWithLabel(candidate.props?.children, out);
}

describe("[M59] TestplaySpeedSection(テストプレイ加速モード・×1/×60/×720)", () => {
  it("3択ボタンを表示し、現在値を明示する(本文 + aria-pressed の両方)", () => {
    const vnode = TestplaySpeedSection({ speed: 60, onSetSpeed: () => undefined });
    const text = flattenText(vnode);
    expect(text).toContain("×60");
    expect(text).toContain("現在の速度");

    const buttons: { onClick: () => void; text: string; pressed: unknown }[] = [];
    findButtonsWithLabel(vnode, buttons);
    expect(buttons.map((b) => b.text)).toEqual(["×1", "×60", "×720"]);
    expect(buttons.map((b) => b.pressed)).toEqual([false, true, false]);
  });

  it("ボタンを押すと onSetSpeed がその速度で呼ばれる", () => {
    const onSetSpeed = vi.fn();
    const vnode = TestplaySpeedSection({ speed: 1, onSetSpeed });
    const buttons: { onClick: () => void; text: string; pressed: unknown }[] = [];
    findButtonsWithLabel(vnode, buttons);
    buttons[2]?.onClick(); // ×720
    expect(onSetSpeed).toHaveBeenCalledWith(720);
  });

  it("×1(既定)のときは戻し忘れ警告文を出さない", () => {
    const vnode = TestplaySpeedSection({ speed: 1, onSetSpeed: () => undefined });
    expect(flattenText(vnode)).not.toContain("戻すことを推奨");
  });

  it("×1 以外のときは戻し忘れ警告文を出す", () => {
    const vnode = TestplaySpeedSection({ speed: 720, onSetSpeed: () => undefined });
    expect(flattenText(vnode)).toContain("戻すことを推奨");
  });
});

describe("[M57] OnboardingHelpSection(初回ガイド・用語辞典の再表示導線)", () => {
  it("2つのボタンを表示し、それぞれ対応するコールバックを呼ぶ", () => {
    const onOpenGuide = vi.fn();
    const onOpenGlossary = vi.fn();
    const vnode = OnboardingHelpSection({ onOpenGuide, onOpenGlossary });

    const buttons: { onClick: () => void; text: string; pressed: unknown }[] = [];
    findButtonsWithLabel(vnode, buttons);
    expect(buttons.map((b) => b.text)).toEqual(["初回ガイドをもう一度見る", "用語ミニ辞典を開く"]);

    buttons[0]?.onClick();
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
    expect(onOpenGlossary).not.toHaveBeenCalled();

    buttons[1]?.onClick();
    expect(onOpenGlossary).toHaveBeenCalledTimes(1);
  });
});

describe("[M54] ResetGameSection(最初からやり直す・確認2段)", () => {
  it("段0はボタンのみ・警告パネルは出さない", () => {
    const vnode = ResetGameSection({
      step: 0,
      onStart: () => undefined,
      onProceed: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    const text = flattenText(vnode);
    expect(text).toContain("最初からやり直す");
    expect(text).not.toContain("取り消せません");
  });

  it("段0のボタンを押すと onStart が呼ばれる", () => {
    const onStart = vi.fn();
    const vnode = ResetGameSection({
      step: 0,
      onStart,
      onProceed: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    });
    function findFirstButton(node: unknown): (() => void) | null {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findFirstButton(child);
          if (found !== null) return found;
        }
        return null;
      }
      if (node === null || node === undefined || typeof node !== "object") return null;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly onClick?: unknown; readonly children?: unknown };
      };
      if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
        return candidate.props.onClick as () => void;
      }
      return findFirstButton(candidate.props?.children);
    }
    const onClick = findFirstButton(vnode);
    expect(onClick).not.toBeNull();
    onClick?.();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("段1はエクスポート推奨の警告と「次へ」/「キャンセル」を持つ", () => {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    const vnode = ResetGameSection({
      step: 1,
      onStart: () => undefined,
      onProceed,
      onConfirm: () => undefined,
      onCancel,
    });
    const text = flattenText(vnode);
    expect(text).toContain("全て消えます");
    expect(text).toContain("エクスポート");

    function findButtons(node: unknown, out: { onClick: () => void; text: string }[]): void {
      if (Array.isArray(node)) {
        for (const child of node) findButtons(child, out);
        return;
      }
      if (node === null || node === undefined || typeof node !== "object") return;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly onClick?: unknown; readonly children?: unknown };
      };
      if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
        out.push({
          onClick: candidate.props.onClick as () => void,
          text: flattenText(candidate.props.children),
        });
        return;
      }
      findButtons(candidate.props?.children, out);
    }
    const buttons: { onClick: () => void; text: string }[] = [];
    findButtons(vnode, buttons);
    expect(buttons).toHaveLength(2);
    buttons[0]?.onClick();
    expect(onProceed).toHaveBeenCalledOnce();
    buttons[1]?.onClick();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("段2は取り消せない旨の最終確認と「消去して新規開始する」/「キャンセル」を持つ", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const vnode = ResetGameSection({
      step: 2,
      onStart: () => undefined,
      onProceed: () => undefined,
      onConfirm,
      onCancel,
    });
    const text = flattenText(vnode);
    expect(text).toContain("取り消せません");
    expect(text).toContain("消去して新規開始する");

    function findButtons(node: unknown, out: { onClick: () => void }[]): void {
      if (Array.isArray(node)) {
        for (const child of node) findButtons(child, out);
        return;
      }
      if (node === null || node === undefined || typeof node !== "object") return;
      const candidate = node as {
        readonly type?: unknown;
        readonly props?: { readonly onClick?: unknown; readonly children?: unknown };
      };
      if (candidate.type === "button" && typeof candidate.props?.onClick === "function") {
        out.push({ onClick: candidate.props.onClick as () => void });
        return;
      }
      findButtons(candidate.props?.children, out);
    }
    const buttons: { onClick: () => void }[] = [];
    findButtons(vnode, buttons);
    expect(buttons).toHaveLength(2);
    buttons[0]?.onClick();
    expect(onConfirm).toHaveBeenCalledOnce();
    buttons[1]?.onClick();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("export→import 往復(検収条件そのもの・store 経由)", () => {
  it("exportSaveText → importSaveText → worldLoaded(source: import) で同じ tick の state が復元される", () => {
    const { store } = createTestStore();
    const originalTick = store.peekState().tick;
    const text = exportSaveText(store.peekState());

    const imported = importSaveText(text);
    const result = store.dispatch({
      type: "worldLoaded",
      state: imported,
      content: store.peekContent(),
      source: "import",
    });

    expect(result.stateChanged).toBe(true);
    expect(store.peekState().tick).toBe(originalTick);
    expect(store.peekState().worldSeed).toBe(imported.worldSeed);
  });

  it("壊れたテキストは importSaveText が例外を投げる(黙って通さない)", () => {
    expect(() => importSaveText("not json")).toThrow();
    expect(() => importSaveText("{}")).toThrow();
  });
});
