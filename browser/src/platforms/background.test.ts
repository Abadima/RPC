import { describe, expect, jest, test } from "bun:test";
import type { ConnectionState, DesktopLink } from "../core/desktop-connection";
import type { DesktopReport, DesktopSetting } from "../core/desktop-protocol";
import type { PlatformId } from "../core/preferences";
import type { Presence } from "../core/presence";
import { REPORT } from "../core/test-desktop";
import { ActivityRegistry } from "../core/registry";
import { UI_PORT_NAME, type BridgeState } from "../core/ui-port";
import type { PageBrowser } from "../activities/host";
import {
  KEEPALIVE_MS,
  backgroundKeepalive,
  startBackground,
  type DiscordBridge,
} from "./background";

const EXTENSION_ID = "self";
const EXTENSION_PAGE = "chrome-extension://self/popup.html";

/**
 * A stand-in Activity for arcade.example: "Chess - Arcade" is "Playing Chess",
 * and before the title arrives, "Playing a game".
 */
function arcade(): ActivityRegistry {
  const registry = new ActivityRegistry();
  registry.register({
    info: { id: "arcade", name: "Arcade", hosts: ["arcade.example"], source: "parousia" },
    matcher: (url) => url.hostname === "arcade.example",
    detect: ({ url, title }) => {
      const game = /^(.+) - Arcade$/.exec(title)?.[1];
      return {
        id: "arcade",
        name: "Arcade",
        url: url.href,
        details: game ? `Playing ${game}` : "Playing a game",
      };
    },
  });
  return registry;
}

/** No page scripts: reading pages is tested in activities/host.test.ts. */
const quietPages: PageBrowser = {
  extensionId: EXTENSION_ID,
  onConnect: () => {},
  onAccessChange: () => {},
  grants: async () => ({ all: false, origins: [] }),
  inject: async () => {},
  startCollector: async () => {},
  readPage: async () => null,
  loadIndex: async () => ({}),
  loadManifest: async () => null,
  saveState: async () => {},
};

const start = (link: DesktopLink, bridge: DiscordBridge = fakeBridge()) =>
  startBackground("test", { link, bridge, registry: arcade(), pages: quietPages });

/** Never a real socket: Discord-RPC-Extension's app may really be listening on 6969. */
function fakeBridge(): DiscordBridge & {
  enabled: boolean[];
  yielding: boolean[];
  sent: Presence[];
  acquired: number;
} {
  let state: BridgeState = { status: "off", version: null };
  const bridge = {
    enabled: [] as boolean[],
    yielding: [] as boolean[],
    sent: [] as Presence[],
    acquired: 0,
    setEnabled: (on: boolean) => {
      bridge.enabled.push(on);
      state = { status: on ? "idle" : "off", version: null };
    },
    setYielding: (on: boolean) => {
      bridge.yielding.push(on);
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
  platforms: PlatformId[][];
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
    platforms: [] as PlatformId[][],
    acquired: 0,
    released: 0,
    reconnects: 0,
    settings: [] as Array<[DesktopSetting, boolean]>,
    send: (presence: Presence) => link.sent.push(presence),
    setPlatforms: (platforms: readonly PlatformId[]) => link.platforms.push([...platforms]),
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

interface FakeTab {
  /** Unset for a browser page the extension can't see. */
  url?: string;
  title?: string;
  /** Sound is playing in it. */
  audible?: boolean;
}

type UpdatedListener = (
  tabId: number,
  change: { url?: string; title?: string; audible?: boolean },
  tab: FakeTab,
) => void;

function installChromeMock(tab: FakeTab = { url: "https://example.com" }): {
  connect: (name: string, senderId?: string, senderUrl?: string) => FakeUiPort;
  savePreferences: (value: unknown) => void;
  saveDefault: (value: unknown) => void;
  tabLookups: () => number;
  update: (change: { url?: string; title?: string; audible?: boolean }, next?: FakeTab) => void;
  /** Opens a tab in `windowId`, where it becomes that window's active tab. */
  activate: (tabId: number, tab: FakeTab, windowId: number) => void;
  focus: (windowId: number) => void;
  /** Closes a window without saying where focus went; `focusNow` is what the browser reports after. */
  close: (windowId: number, focusNow: number) => void;
} {
  const noop = { addListener: (): void => {} };
  const activatedListeners: Array<(info: { tabId: number; windowId: number }) => void> = [];
  const focusListeners: Array<(windowId: number) => void> = [];
  const removedListeners: Array<(windowId: number) => void> = [];
  let lastFocused = 1;
  /** Tabs besides the first, and each window's active tab (window 1's is tab 1). */
  const others = new Map<number, FakeTab>();
  const activeIn = new Map<number, number>([[1, 1]]);
  const connectListeners: Array<(port: unknown) => void> = [];
  const storageListeners: Array<(changes: object, area: string) => void> = [];
  const updatedListeners: UpdatedListener[] = [];
  let current = tab;
  let tabLookups = 0;
  globalThis.chrome = {
    tabs: {
      onActivated: {
        addListener: (listener: (info: { tabId: number; windowId: number }) => void) =>
          activatedListeners.push(listener),
      },
      onUpdated: { addListener: (listener: UpdatedListener) => updatedListeners.push(listener) },
      onRemoved: noop,
      get: (async (tabId: number) => {
        tabLookups++;
        return others.get(tabId) ?? current;
      }) as unknown as typeof chrome.tabs.get,
      query: (async (query: { windowId?: number }) => {
        const windowId = query.windowId ?? 1;
        const id = activeIn.get(windowId) ?? 1;
        return [{ id, windowId, ...(others.get(id) ?? current) }];
      }) as unknown as typeof chrome.tabs.query,
    },
    windows: {
      onFocusChanged: {
        addListener: (listener: (windowId: number) => void) => focusListeners.push(listener),
      },
      onRemoved: {
        addListener: (listener: (windowId: number) => void) => removedListeners.push(listener),
      },
      getLastFocused: async () => ({ id: lastFocused, focused: lastFocused !== -1 }),
      WINDOW_ID_NONE: -1,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: {
        addListener: (listener: (changes: object, area: string) => void) =>
          storageListeners.push(listener),
      },
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onConnect: {
        addListener: (listener: (port: unknown) => void) => connectListeners.push(listener),
      },
    },
  } as unknown as typeof chrome;

  return {
    savePreferences: (value) =>
      storageListeners.forEach((l) => l({ preferences: { newValue: value } }, "local")),
    saveDefault: (value) =>
      storageListeners.forEach((l) => l({ defaultActivity: { newValue: value } }, "local")),
    tabLookups: () => tabLookups,
    activate: (tabId, tab, windowId) => {
      others.set(tabId, tab);
      activeIn.set(windowId, tabId);
      for (const listener of activatedListeners) listener({ tabId, windowId });
    },
    focus: (windowId) => {
      if (windowId !== -1) lastFocused = windowId;
      for (const listener of focusListeners) listener(windowId);
    },
    close: (windowId, focusNow) => {
      lastFocused = focusNow;
      for (const listener of removedListeners) listener(windowId);
    },
    update: (change, next = current) => {
      current = next;
      for (const listener of updatedListeners) listener(1, change, next);
    },
    connect(name, senderId = EXTENSION_ID, senderUrl = EXTENSION_PAGE) {
      const port: FakeUiPort = { posted: [], onMessageListeners: [], onDisconnectListeners: [] };
      for (const listener of connectListeners) {
        listener({
          name,
          sender: { id: senderId, url: senderUrl },
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
/** For tests with fake timers, where `tick` would never come: lets every pending promise run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("startBackground", () => {
  test("publishes the active tab's Presence through the Desktop link", async () => {
    installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    // example.com isn't a site any Activity looks at: the only thing to report is "nothing".
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]?.activity).toBeNull();
  });

  test("an open UI holds the connection and gets every state change", () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);
    link.setState({ status: "connected" });

    expect(link.acquired).toBe(1);
    expect(port.posted).toEqual([
      { type: "state", state: { status: "idle" } },
      { type: "discord", state: { status: "off", version: null } },
      { type: "activity", activity: null },
      { type: "state", state: { status: "connected" } },
    ]);
    port.onDisconnectListeners.forEach((listener) => listener());
    expect(link.released).toBe(1);
  });

  test("answers status and settings requests with Desktop's report", async () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);

    port.onMessageListeners.forEach((l) => l({ type: "status-request" }));
    port.onMessageListeners.forEach((l) =>
      l({ type: "set", setting: "allowUserscripts", value: true }),
    );
    port.onMessageListeners.forEach((l) => l({ type: "allow", origin: "chrome-extension://x" }));
    await tick();

    expect(link.settings).toEqual([["allowUserscripts", true]]);
    expect(
      port.posted.filter(
        (event) =>
          typeof event === "object" && event !== null && "type" in event && event.type === "report",
      ),
    ).toEqual([
      { type: "report", report: REPORT },
      { type: "report", report: null },
    ]);
  });

  test("a reconnect request retries now and needs no reply", async () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    const port = chromeMock.connect(UI_PORT_NAME);

    port.onMessageListeners.forEach((l) => l({ type: "reconnect" }));
    await tick();

    expect(link.reconnects).toBe(1);
    expect(port.posted).not.toContainEqual(expect.objectContaining({ type: "report" }));
  });

  test("a saved preference change checks the active tab again", async () => {
    const chromeMock = installChromeMock();
    start(fakeLink(), fakeBridge());
    await tick();
    const before = chromeMock.tabLookups();

    chromeMock.savePreferences({ shareMediaDetails: false });
    await tick();

    expect(chromeMock.tabLookups()).toBe(before + 1);
  });

  test("Discord-RPC-Extension's app follows the Discord and bridge preferences, and gets every Presence", async () => {
    const chromeMock = installChromeMock();
    const bridge = fakeBridge();
    start(fakeLink(), bridge);
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

  test("tells Desktop which platforms are turned on", async () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    expect(link.platforms.at(-1)).toEqual(["discord", "fluxer", "stoat"]);
    chromeMock.savePreferences({ platforms: { discord: false } });
    expect(link.platforms.at(-1)).toEqual(["fluxer", "stoat"]);
  });

  test("Discord-RPC-Extension's app is only a fallback: it yields until Desktop fails, and again once it connects", async () => {
    installChromeMock({ url: "https://arcade.example/chess", title: "Chess - Arcade" });
    const link = fakeLink();
    const bridge = fakeBridge();
    start(link, bridge);
    await tick();
    // Yielding from the start, before Desktop has had a chance to answer.
    expect(bridge.yielding.at(-1)).toBe(true);
    expect(bridge.sent.at(-1)?.activity?.details).toBe("Playing Chess");

    link.setState({ status: "connecting" });
    expect(bridge.yielding.at(-1)).toBe(true);
    link.setState({ status: "connected" });
    expect(bridge.yielding.at(-1)).toBe(true);

    // Desktop went away: the app takes over, and keeps that through each retry.
    link.setState({ status: "disconnected" });
    expect(bridge.yielding.at(-1)).toBe(false);
    link.setState({ status: "connecting" });
    expect(bridge.yielding.at(-1)).toBe(false);
    link.setState({ status: "disconnected" });
    link.setState({ status: "connected" });
    expect(bridge.yielding.at(-1)).toBe(true);

    // A Desktop that refuses this build isn't showing anything either.
    link.setState({ status: "not_allowed" });
    expect(bridge.yielding.at(-1)).toBe(false);
    link.setState({ status: "idle" });
    expect(bridge.yielding.at(-1)).toBe(true);
  });

  test("a new title is looked at only on a page an Activity looks at", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: game, title: "Arcade" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing a game");

    chromeMock.update({ title: "Chess - Arcade" }, { url: game, title: "Chess - Arcade" });
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");

    const lookups = chromeMock.tabLookups();
    chromeMock.update({ title: "(1) Inbox" }, { url: "https://example.com", title: "(1) Inbox" });
    await tick();
    expect(chromeMock.tabLookups()).toBe(lookups);
  });

  test("an open UI is told what's shared, and every change to it", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: game, title: "Arcade" });
    start(fakeLink(), fakeBridge());
    await tick();
    const port = chromeMock.connect(UI_PORT_NAME);
    expect(port.posted).toContainEqual({
      type: "activity",
      activity: { id: "arcade", name: "Arcade", details: "Playing a game" },
    });

    chromeMock.update({ title: "Chess - Arcade" }, { url: game, title: "Chess - Arcade" });
    await tick();
    expect(port.posted.at(-1)).toEqual({
      type: "activity",
      activity: { id: "arcade", name: "Arcade", details: "Playing Chess" },
    });
  });

  test("an open UI hears whether the shared Activity has settings to change from the popup", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: game, title: "Arcade" });
    const registry = arcade();
    const [entry] = [...registry.list()];
    if (entry)
      entry.settings = [{ id: "game", title: "Show the game", type: "boolean", default: true }];
    startBackground("test", {
      link: fakeLink(),
      bridge: fakeBridge(),
      registry,
      pages: quietPages,
    });
    await tick();
    const port = chromeMock.connect(UI_PORT_NAME);
    expect(port.posted).toContainEqual({
      type: "activity",
      activity: { id: "arcade", name: "Arcade", configurable: true, details: "Playing a game" },
    });
  });

  test("with no Activity for the tab, the Default Activity is shared, its elapsed time kept until something else shows", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: "https://example.com", title: "Example" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    chromeMock.saveDefault({
      enabled: true,
      name: "Studying",
      details: "Chapter 4",
      elapsed: true,
    });
    await tick();
    const shown = link.sent.at(-1)?.activity;
    expect(shown).toMatchObject({ id: "parousia:default", name: "Studying", details: "Chapter 4" });
    const since = shown?.timestamps?.start;
    expect(typeof since).toBe("number");

    // Another page no Activity covers: the same Default Activity, not resent.
    const sent = link.sent.length;
    chromeMock.update(
      { url: "https://example.org" },
      { url: "https://example.org", title: "Other" },
    );
    await tick();
    expect(link.sent).toHaveLength(sent);

    // A detected Activity takes over; afterwards the Default Activity starts over.
    chromeMock.update({ url: game }, { url: game, title: "Arcade" });
    await tick();
    expect(link.sent.at(-1)?.activity?.id).toBe("arcade");
    await new Promise((resolve) => setTimeout(resolve, 5));
    chromeMock.update(
      { url: "https://example.com" },
      { url: "https://example.com", title: "Example" },
    );
    await tick();
    expect(link.sent.at(-1)?.activity?.id).toBe("parousia:default");
    expect(link.sent.at(-1)?.activity?.timestamps?.start).toBeGreaterThan(since ?? Infinity);
  });

  test("a browser page the extension can't see gets the Default Activity too; one that's off or incomplete isn't shared", async () => {
    const chromeMock = installChromeMock({ title: "New Tab" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    chromeMock.saveDefault({ enabled: true, name: "Browsing", elapsed: false });
    await tick();
    expect(link.sent.at(-1)?.activity).toEqual({ id: "parousia:default", name: "Browsing" });

    chromeMock.saveDefault({ enabled: true, name: "B" });
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();
    chromeMock.saveDefault({ enabled: false, name: "Browsing" });
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();
  });

  test("shares the focused window's active tab, not a tab switched to in another window", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: "https://example.com", title: "Example" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    // A tab opening in the background in another window changes nothing.
    chromeMock.activate(2, { url: game, title: "Chess - Arcade" }, 2);
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    // Focusing that window shares its active tab.
    chromeMock.focus(2);
    await tick();
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");

    // And back: window 1's active tab again.
    chromeMock.focus(1);
    await tick();
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    // The focused window closing with no word on where focus went: asked, not assumed.
    chromeMock.focus(2);
    await tick();
    await tick();
    chromeMock.focus(-1);
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();
    chromeMock.close(2, 1);
    await tick();
    await tick();
    await tick();
    chromeMock.activate(3, { url: game, title: "Chess - Arcade" }, 1);
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");
  });

  test("away from the browser, nothing is shared at once unless sound is playing in the tab", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: game, title: "Chess - Arcade" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");

    chromeMock.focus(-1);
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    // Music keeps playing while someone looks at Discord, or opens the popup.
    chromeMock.update({ audible: true }, { url: game, title: "Chess - Arcade", audible: true });
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");

    // What's shared keeps following the tab while they're away.
    chromeMock.update({ title: "Go - Arcade" }, { url: game, title: "Go - Arcade", audible: true });
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Go");

    chromeMock.update({ audible: false }, { url: game, title: "Go - Arcade", audible: false });
    await tick();
    expect(link.sent.at(-1)?.activity).toBeNull();

    chromeMock.focus(1);
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Go");
  });

  test("with an Idle Timeout, what's shared keeps following the tab until the timeout runs out, and stays cleared until focus returns", async () => {
    const game = "https://arcade.example/chess";
    const chromeMock = installChromeMock({ url: game, title: "Chess - Arcade" });
    const link = fakeLink();
    start(link, fakeBridge());
    await tick();
    chromeMock.savePreferences({ idleTimeoutMinutes: 1 });
    await tick();
    jest.useFakeTimers();
    try {
      chromeMock.focus(-1);
      await settle();
      expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");
      chromeMock.update({ title: "Go - Arcade" }, { url: game, title: "Go - Arcade" });
      await settle();
      expect(link.sent.at(-1)?.activity?.details).toBe("Playing Go");

      jest.advanceTimersByTime(60_000);
      await settle();
      expect(link.sent.at(-1)?.activity).toBeNull();
      // Not brought back by the next thing the tab does.
      chromeMock.update({ title: "Chess - Arcade" }, { url: game, title: "Chess - Arcade" });
      await settle();
      expect(link.sent.at(-1)?.activity).toBeNull();
    } finally {
      jest.useRealTimers();
    }
    chromeMock.focus(1);
    await tick();
    expect(link.sent.at(-1)?.activity?.details).toBe("Playing Chess");
  });

  test("ignores ports with another name, from another extension, or from a content script", () => {
    const chromeMock = installChromeMock();
    const link = fakeLink();
    start(link, fakeBridge());
    chromeMock.connect("something-else");
    chromeMock.connect(UI_PORT_NAME, "another-extension");
    // A content script (where PreMiD Activities run) has this extension's id, but a web page's URL.
    chromeMock.connect(UI_PORT_NAME, EXTENSION_ID, "https://example.com/");
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
