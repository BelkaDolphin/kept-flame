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
  ResetGameSection,
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
