// ---------------------------------------------------------------------------
// M34: `src/platform/installPromptEvent.ts`(`beforeinstallprompt` の薄い
// ラッパ)のテスト。
//
// `router.test.ts` の fakeHost と同じ方針(DOM を直接掴まないので偽の
// window-like オブジェクトで実コードそのものを検証できる)。固定するのは:
//   1. イベント未受信(iOS 等)では "unavailable" のまま・promptInstall は
//      何もせず "unavailable" を返す(投げない)
//   2. beforeinstallprompt 受信で preventDefault が呼ばれ "available" になる
//   3. promptInstall が prompt()/userChoice を経由して accepted/dismissed を
//      反映し、二重に prompt() できない(1 回使ったら deferred を消費する)
//   4. appinstalled で "installed" になる
//   5. dispose でリスナーが外れる
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
  createInstallPromptController,
  type BeforeInstallPromptEvent,
  type InstallPromptWindowLike,
} from "../../src/platform/installPromptEvent";

/** イベントリスナーを保持するだけの偽 window。 */
function fakeWindow(): InstallPromptWindowLike & {
  emitBeforeInstallPrompt(event: BeforeInstallPromptEvent): void;
  emitAppInstalled(): void;
  listenerCount(type: string): number;
} {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();

  function add(type: string, listener: (...args: never[]) => void): void {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  }
  function remove(type: string, listener: (...args: never[]) => void): void {
    listeners.get(type)?.delete(listener);
  }

  return {
    addEventListener: (type, listener) => add(type, listener as never),
    removeEventListener: (type, listener) => remove(type, listener as never),
    emitBeforeInstallPrompt(event) {
      for (const listener of [...(listeners.get("beforeinstallprompt") ?? [])]) {
        (listener as (e: BeforeInstallPromptEvent) => void)(event);
      }
    },
    emitAppInstalled() {
      for (const listener of [...(listeners.get("appinstalled") ?? [])]) {
        (listener as () => void)();
      }
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

function fakeBeforeInstallPromptEvent(
  outcome: "accepted" | "dismissed",
): BeforeInstallPromptEvent & { readonly preventDefaultCalls: number } {
  let preventDefaultCalls = 0;
  return {
    get preventDefaultCalls() {
      return preventDefaultCalls;
    },
    preventDefault: () => {
      preventDefaultCalls++;
    },
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome }),
  };
}

describe("イベント未受信(iOS Safari 等)", () => {
  it("getState は unavailable のまま", () => {
    const controller = createInstallPromptController(fakeWindow());
    expect(controller.getState()).toBe("unavailable");
  });

  it("promptInstall は何もせず unavailable を返す(投げない)", async () => {
    const controller = createInstallPromptController(fakeWindow());
    await expect(controller.promptInstall()).resolves.toBe("unavailable");
  });
});

describe("beforeinstallprompt 受信", () => {
  it("preventDefault を呼び、available になる", () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    const event = fakeBeforeInstallPromptEvent("accepted");
    win.emitBeforeInstallPrompt(event);
    expect(event.preventDefaultCalls).toBe(1);
    expect(controller.getState()).toBe("available");
  });

  it("promptInstall が accepted/dismissed を反映する", async () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("accepted"));
    await expect(controller.promptInstall()).resolves.toBe("accepted");
    expect(controller.getState()).toBe("accepted");
  });

  it("dismissed も同様に反映する", async () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("dismissed"));
    await expect(controller.promptInstall()).resolves.toBe("dismissed");
    expect(controller.getState()).toBe("dismissed");
  });

  it("1 度使った deferred は消費され、再度 promptInstall すると unavailable", async () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("accepted"));
    await controller.promptInstall();
    await expect(controller.promptInstall()).resolves.toBe("unavailable");
  });

  it("新しい beforeinstallprompt を受信すると再び available になる", () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("dismissed"));
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("accepted"));
    expect(controller.getState()).toBe("available");
  });
});

describe("appinstalled", () => {
  it("installed になり、以後 promptInstall は unavailable", async () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("accepted"));
    win.emitAppInstalled();
    expect(controller.getState()).toBe("installed");
    await expect(controller.promptInstall()).resolves.toBe("unavailable");
  });
});

describe("dispose", () => {
  it("リスナーを解除し、以後のイベントで状態が変わらない", () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    expect(win.listenerCount("beforeinstallprompt")).toBe(1);
    expect(win.listenerCount("appinstalled")).toBe(1);
    controller.dispose();
    expect(win.listenerCount("beforeinstallprompt")).toBe(0);
    expect(win.listenerCount("appinstalled")).toBe(0);

    win.emitBeforeInstallPrompt(fakeBeforeInstallPromptEvent("accepted"));
    expect(controller.getState()).toBe("unavailable");
  });
});

describe("vi.fn を使った preventDefault/prompt の呼び出し回数", () => {
  it("promptInstall は prompt() と userChoice を厳密に 1 回ずつ経由する", async () => {
    const win = fakeWindow();
    const controller = createInstallPromptController(win);
    const prompt = vi.fn(() => Promise.resolve());
    const event: BeforeInstallPromptEvent = {
      preventDefault: () => undefined,
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" }),
    };
    win.emitBeforeInstallPrompt(event);
    await controller.promptInstall();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
