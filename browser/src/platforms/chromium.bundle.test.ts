import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { activitiesPlugin } from "../../scripts/activities/plugin";

/**
 * Bundling can behave differently than running the same source directly (as
 * background.test.ts does): minification, tree-shaking, and Bun.build's own
 * ESM interop transforms have all previously turned working source into a
 * bundle that throws at runtime. Bundling the real entrypoint here and
 * running the actual output is the only way to catch that class of bug.
 */
describe("chromium bundle", () => {
  test("runs once bundled, stays idle, then tries Desktop's WebSocket when a UI opens", async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./chromium.ts", import.meta.url))],
      target: "browser",
      format: "esm",
      minify: true,
      // No Activities: this is about the bundle itself.
      plugins: [activitiesPlugin([])],
    });
    expect(result.success).toBe(true);

    const code = await result.outputs[0]!.text();
    const noop = { addListener: (): void => {} };
    const opened: string[] = [];
    const connectListeners: Array<(port: unknown) => void> = [];
    // Nothing answers, like a machine without Desktop running.
    globalThis.WebSocket = class {
      readyState = 0;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        opened.push(url);
        queueMicrotask(() => this.onclose?.());
      }
      send(): void {}
      close(): void {}
    } as unknown as typeof WebSocket;
    globalThis.chrome = {
      runtime: {
        id: "self",
        lastError: undefined,
        getURL: (path: string) => `chrome-extension://self/${path}`,
        getManifest: () => ({ version: "1.0.0" }),
        onConnect: {
          addListener: (listener: (port: unknown) => void) => connectListeners.push(listener),
        },
        onMessageExternal: noop,
        sendMessage: () => {},
      },
      tabs: {
        onActivated: noop,
        onUpdated: noop,
        onRemoved: noop,
        get: (async () => ({ url: "https://example.com" })) as unknown as typeof chrome.tabs.get,
        query: (async () => [
          { id: 1, url: "https://example.com" },
        ]) as unknown as typeof chrome.tabs.query,
      },
      windows: { onFocusChanged: noop, onRemoved: noop, WINDOW_ID_NONE: -1 },
      permissions: { onAdded: noop, onRemoved: noop, getAll: async () => ({ origins: [] }) },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: (): void => {} },
      },
    } as unknown as typeof chrome;

    expect(() => {
      // Executing the actual bundled output (not re-running the source) is the point of this test.
      // oxlint-disable-next-line no-eval
      (0, eval)(code);
    }).not.toThrow();

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await settle();
    // Nothing is detected, so nothing needs Desktop: no connection at all.
    expect(opened).toEqual([]);

    const posted: unknown[] = [];
    for (const listener of connectListeners) {
      listener({
        name: "parousia-ui",
        sender: { id: "self", url: "chrome-extension://self/popup.html" },
        postMessage: (message: unknown) => posted.push(message),
        onMessage: noop,
        onDisconnect: noop,
      });
    }
    await settle();
    // Desktop, and Discord-RPC-Extension's app.
    expect(opened.toSorted()).toEqual(["ws://127.0.0.1:57179/ws", "ws://127.0.0.1:6969"]);
    // Both links end up unreachable (nothing in this test answers either socket).
    expect(posted).toContainEqual({ type: "state", state: { status: "disconnected" } });
    expect(posted).toContainEqual({
      type: "discord",
      state: { status: "unavailable", version: null },
    });
  });
});
