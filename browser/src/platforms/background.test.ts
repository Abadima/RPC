import { describe, expect, test } from "bun:test";
import type { ConnectionState, DesktopLink } from "../core/desktop-connection";
import type { DesktopReport, DesktopSetting } from "../core/desktop-protocol";
import type { Presence } from "../core/presence";
import { REPORT } from "../core/test-desktop";
import { UI_PORT_NAME, type BridgeState } from "../core/ui-port";
import {
  KEEPALIVE_MS,
  backgroundKeepalive,
  startBackground,
  type DiscordBridge,
} from "./background";

const EXTENSION_ID = "self";

/** Never a real socket: Discord-RPC-Extension's app may really be listening on 6969. */
function fakeBridge(): DiscordBridge & { enabled: boolean[]; sent: Presence[]; acquired: number } {
  let state: BridgeState = { status: "off", version: null };
  const bridge = {
    enabled: [] as boolean[],
    sent: [] as Presence[],
    acquired: 0,
    setEnabled: (on: boolean) => {
      bridge.enabled.push(on);
      state = { status: on ? "idle" : "off", version: null };
    },
    acquire: () => {
      bridge.acquired++;
      return () => {};
    },
    send: (presence: Presence) => bridge.sent.push(presence),
    getState: () => state,
    onStateChange: () => () => {},
  };
  return bridge;
}

/** Enough of a DesktopLink to observe what the background script does with it. */
function fakeLink(): DesktopLink & {
  sent: Presence[];
  acquired: number;
  released: number;
  reconnects: number;
  settings: Array<[DesktopSetting, boolean]>;
  setState: (state: ConnectionState) => void;
} {
  let state: ConnectionState = { status: "idle" };
  const listeners = new Set<(state: ConnectionState) => void>();
  const link = {
    sent: [] as Presence[],
    acquired: 0,
    released: 0,
    reconnects: 0,
    settings: [] as Array<[DesktopSetting, boolean]>,
    send: (presence: Presence) => link.sent.push(presence),
    acquire: () => {
      link.acquired++;
      return () => {
        link.released++;
      };
    },
    reconnect: () => {
      link.reconnects++;
    },
    requestStatus: async (): Promise<DesktopReport | null> => REPORT,
    setSetting: async (setting: DesktopSetting, value: boolean): Promise<DesktopReport | null> => {
      link.settings.push([setting, value]);
      return null;
    },
    getState: () => state,
    onStateChange: (listener: (state: ConnectionState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState: (next: ConnectionState) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
  return link;
}

interface FakeUiPort {
  posted: unknown[];
  onMessageListeners: Array<(message: unknown) => void>;
  onDisconnectListeners: Array<() => void>;
}

function installChromeMock(): {
  connect: (name: string, senderId?: string) => FakeUiPort;
  savePreferences: (value: unknown) => void;
  tabLookups: () => number;
} {
  const noop = { addListener: (): void => {} };
  const connectListeners: Array<(port: unknown) => void> = [];
  const storageListeners: Array<(changes: object, area: string) => void> = [];
  let tabLookups = 0;
  globalThis.chrome = {
    tabs: {
      onActivated: noop,
      onUpdated: noop,
      onRemoved: noop,
      get: (async () => {
        tabLookups++;
        return { url: "https://example.com" };
      }) as unknown as typeof chrome.tabs.get,
      query: (async () => [
        { id: 1, url: "https://example.com" },
      ]) as unknown as typeof chrome.tabs.query,
    },
    windows: { onFocusChanged: noop, WINDOW_ID_NONE: -1 },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: {
        addListener: (listener: (changes: object, area: string) => void) =>
          storageListeners.push(listener),
      },
    },
    runtime: {
      id: EXTENSION_ID,
      onConnect: {
        addListener: (listener: (port: unknown) => void) => connectListeners.push(listener),
      },
    },
  } as unknown as typeof chrome;

  return {
    savePreferences: (value) =>
      storageListeners.forEach((l) => l({ preferences: { newValue: value } }, "local")),
    tabLookups: () => tabLookups,
    connect(name, senderId = EXTENSION_ID) {
      const port: FakeUiPort = { posted: [], onMessageListeners: [], onDisconnectListeners: [] };
      for (const listener of connectListeners) {
        listener({
          name,
          sender: { id: senderId },
          postMessage: (message: unknown) => port.posted.push(message),
          onMessage: { addListener: (l: (m: unknown) => void) => port.onMessageListeners.push(l) },
          onDisconnect: { addListener: (l: () => void) => port.onDisconnectListeners.push(l) },
        });
      }
      return port;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("startBackground", () => {
  test("publishes the active tab's Presence through the Desktop link", async () => {
    installChromeMock();
    const link = fakeLink();
    startBackground("test", link, fakeBridge());
    await tick();
    // No Activity is registered yet, so the only thing to report is "nothing".
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]?.activity).toBeNull();
  });

  test("an open UI holds the connection and gets every state change", () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    startBackground("test", link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);
    link.setState({ status: "connected" });

    expect(link.acquired).toBe(1);
    expect(port.posted).toEqual([
      { type: "state", state: { status: "idle" } },
      { type: "discord", state: { status: "off", version: null } },
      { type: "state", state: { status: "connected" } },
    ]);
    port.onDisconnectListeners.forEach((listener) => listener());
    expect(link.released).toBe(1);
  });

  test("answers status and settings requests with Desktop's report", async () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    startBackground("test", link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);

    port.onMessageListeners.forEach((l) => l({ type: "status-request" }));
    port.onMessageListeners.forEach((l) =>
      l({ type: "set", setting: "allowUserscripts", value: true }),
    );
    port.onMessageListeners.forEach((l) => l({ type: "allow", origin: "chrome-extension://x" }));
    await tick();

    expect(link.settings).toEqual([["allowUserscripts", true]]);
    expect(port.posted.slice(2)).toEqual([
      { type: "report", report: REPORT },
      { type: "report", report: null },
    ]);
  });

  test("a reconnect request retries now and needs no reply", async () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    startBackground("test", link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);

    port.onMessageListeners.forEach((l) => l({ type: "reconnect" }));
    await tick();

    expect(link.reconnects).toBe(1);
    expect(port.posted).toHaveLength(2);
  });

  test("a saved preference change checks the active tab again", async () => {
    const chromeMock = installChromeMock();
    startBackground("test", fakeLink(), fakeBridge());
    await tick();
    const before = chromeMock.tabLookups();

    chromeMock.savePreferences({ shareMediaDetails: false });
    await tick();

    expect(chromeMock.tabLookups()).toBe(before + 1);
  });

  test("Discord-RPC-Extension's app follows the Discord and bridge preferences, and gets every Presence", async () => {
    const chromeMock = installChromeMock();
    const bridge = fakeBridge();
    startBackground("test", fakeLink(), bridge);
    await tick();
    expect(bridge.enabled.at(-1)).toBe(true);
    expect(bridge.sent.length).toBeGreaterThan(0);

    chromeMock.savePreferences({ discordRpcExtension: false });
    expect(bridge.enabled.at(-1)).toBe(false);
    chromeMock.savePreferences({ platforms: { discord: false } });
    expect(bridge.enabled.at(-1)).toBe(false);
    chromeMock.connect(UI_PORT_NAME);
    expect(bridge.acquired).toBe(1);
  });

  test("ignores ports with another name or from another extension", () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    startBackground("test", link, fakeBridge());
    chromeMock.connect("something-else");
    chromeMock.connect(UI_PORT_NAME, "another-extension");
    expect(link.acquired).toBe(0);
  });
});

describe("backgroundKeepalive", () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  test("pings only while switched on, with one timer however often it's switched", async () => {
    let pings = 0;
    const keepAlive = backgroundKeepalive(() => pings++, 5);
    await wait(20);
    expect(pings).toBe(0);

    keepAlive(true);
    keepAlive(true);
    await wait(28);
    const whileOn = pings;
    expect(whileOn).toBeGreaterThanOrEqual(3);
    expect(whileOn).toBeLessThanOrEqual(6);

    keepAlive(false);
    await wait(20);
    expect(pings).toBe(whileOn);
  });

  test("the interval stays under the 30-second MV3 idle limit", () => {
    expect(KEEPALIVE_MS).toBeLessThan(30_000);
  });
});
