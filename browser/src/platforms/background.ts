import { PAROUSIA_DISCORD_CLIENT_ID } from "../compat/discord-rpc-extension";
import { DiscordRpcServerLink } from "../compat/discord-rpc-server";
import { MALSYNC_NAME, MalSyncSource } from "../compat/malsync";
import { PAGE_DATA_KINDS, type Activity } from "../core/activity";
import {
  loadActivityStates,
  settingValues,
  watchActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import { webSocketChannel } from "../core/channel";
import { describeClient } from "../core/client-name";
import {
  DEFAULT_ACTIVITY_ID,
  EMPTY_DEFAULT_ACTIVITY,
  defaultActivityToShow,
  loadDefaultActivity,
  watchDefaultActivity,
  type DefaultActivity,
} from "../core/default-activity";
import {
  DesktopConnection,
  type ConnectionState,
  type DesktopLink,
} from "../core/desktop-connection";
import { createLogger } from "../core/logger";
import { PresenceController } from "../core/lifecycle";
import {
  DEFAULT_PREFERENCES,
  applyPreferences,
  enabledPlatforms,
  loadPreferences,
  watchPreferences,
  type Preferences,
} from "../core/preferences";
import { ActivityRegistry } from "../core/registry";
import { PresenceRuntime } from "../core/runtime";
import type { PresenceTransport } from "../core/transport";
import {
  UI_PORT_NAME,
  parseUiRequest,
  type BridgeState,
  type UiActivity,
  type UiEvent,
} from "../core/ui-port";
import { PageHost, chromePageBrowser, type PageBrowser } from "../activities/host";
import type { ActivityManifest } from "../activities/manifest";
import { limitPageData } from "../premid/presence-data";

export interface Background {
  /** The Activity currently detected on the active tab, if any. */
  getActivity: () => Activity | null;
  getState: () => ConnectionState;
}

export function createDesktopConnection(): DesktopConnection {
  return new DesktopConnection({
    channel: webSocketChannel(),
    clientName: describeClient(),
    version: chrome.runtime.getManifest().version,
  });
}

export const KEEPALIVE_MS = 20_000;

/**
 * An MV3 background is stopped after about 30 seconds without extension
 * events or API calls, and its connections close with it: Desktop and
 * Discord-RPC-Extension's app then drop the presence being shared. While an
 * Activity is shared, a cheap API call every `KEEPALIVE_MS` keeps it
 * running. Socket traffic isn't enough: measured, Firefox 150 stops an event
 * page with an open, busy WebSocket, while `runtime.getPlatformInfo()`
 * resets its idle timer (as it does Chromium's, since Chrome 110).
 *
 * Returns a switch: `true` while there's something to share.
 */
export function backgroundKeepalive(
  ping: () => void = () => void chrome.runtime.getPlatformInfo(),
  intervalMs: number = KEEPALIVE_MS,
): (active: boolean) => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  return (active) => {
    if (active && timer === null) {
      timer = setInterval(ping, intervalMs);
    } else if (!active && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** What the background needs from Discord-RPC-Extension's app link (see compat/discord-rpc-server.ts). */
export interface DiscordBridge extends PresenceTransport {
  setEnabled(enabled: boolean): void;
  /** Steps aside while Parousia Desktop is the way to Discord. */
  setYielding(yielding: boolean): void;
  acquire(): () => void;
  getState(): BridgeState;
  onStateChange(listener: (state: BridgeState) => void): () => void;
}

/** Each Activity shows in Discord as its own Discord Application, falling back to Parousia's. */
export function createDiscordBridge(): DiscordBridge {
  return new DiscordRpcServerLink({
    clientIdFor: (activity) => activity.discordClientId ?? PAROUSIA_DISCORD_CLIENT_ID,
    extId: chrome.runtime.id,
  });
}

/**
 * The shared Activity as the popup and dashboard show it; `configurable`
 * when it has settings of its own (the Default Activity is set up on its own
 * page).
 */
export function uiActivity(activity: Activity | null, configurable = false): UiActivity | null {
  if (!activity) return null;
  return {
    id: activity.id,
    name: activity.name,
    ...(configurable && { configurable }),
    ...(activity.details !== undefined && { details: activity.details }),
    ...(activity.state !== undefined && { state: activity.state }),
    ...(activity.timestamps?.start !== undefined && { startedAt: activity.timestamps.start }),
  };
}

/** The Activity being shared, as UIs show it, and news of every change to it. */
interface SharedActivity {
  get(): UiActivity | null;
  onChange(listener: (activity: UiActivity | null) => void): () => void;
}

/**
 * Serves the popup and dashboard (see ui-port.ts): pushes connection state
 * and the shared Activity, answers status and settings requests, and keeps
 * the connections wanted while one is open. Only this extension's own pages
 * can use the port: a content script (which runs PreMiD Activities' code)
 * carries the same extension id but a web page's URL.
 */
function serveUi(link: DesktopLink, discord: DiscordBridge, shared: SharedActivity): void {
  const pages = chrome.runtime.getURL("");
  chrome.runtime.onConnect.addListener((port) => {
    if (
      port.name !== UI_PORT_NAME ||
      port.sender?.id !== chrome.runtime.id ||
      !port.sender.url?.startsWith(pages)
    ) {
      return;
    }

    const post = (event: UiEvent): void => {
      try {
        port.postMessage(event);
      } catch {
        // The UI closed between the event and this post.
      }
    };
    const release = link.acquire();
    const releaseDiscord = discord.acquire();
    const unsubscribe = link.onStateChange((state) => post({ type: "state", state }));
    const unsubscribeDiscord = discord.onStateChange((state) => post({ type: "discord", state }));
    const unsubscribeActivity = shared.onChange((activity) => post({ type: "activity", activity }));
    post({ type: "state", state: link.getState() });
    post({ type: "discord", state: discord.getState() });
    post({ type: "activity", activity: shared.get() });

    port.onMessage.addListener((message: unknown) => {
      const request = parseUiRequest(message);
      if (!request) return;
      if (request.type === "reconnect") {
        // The outcome arrives as state changes.
        link.reconnect();
        return;
      }
      const reply =
        request.type === "status-request"
          ? link.requestStatus()
          : link.setSetting(request.setting, request.value);
      void reply.then((report) => post({ type: "report", report }));
    });
    port.onDisconnect.addListener(() => {
      unsubscribe();
      unsubscribeDiscord();
      unsubscribeActivity();
      release();
      releaseDiscord();
    });
  });
}

/**
 * Content scripts run PreMiD Activities' code, and by default they can read
 * and write `storage.local` (preferences, which Activities are on). Where the
 * browser can restrict that, only the extension's own pages keep access.
 */
function restrictStorage(): void {
  const local = chrome.storage.local;
  if (!("setAccessLevel" in local)) return;
  try {
    void local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  } catch {
    // Not supported for this storage area here.
  }
}

export interface BackgroundOptions {
  /** The native Activities (see core/activities.ts); PreMiD ones join it as they're turned on. */
  registry?: ActivityRegistry;
  /** The native Activities' manifests: the page host runs the collector for ones that take page data. */
  natives?: readonly ActivityManifest[];
  link?: DesktopLink;
  bridge?: DiscordBridge;
  /** How Activities reach pages; by default, the extension's own APIs. */
  pages?: PageBrowser;
  /** Asks the MAL-Sync extension for a tab's presence; by default through the browser (see compat/malsync.ts). */
  askMalSync?: (tabId: number) => Promise<unknown>;
}

/**
 * Wires the Activity/Presence lifecycle to the tabs API and publishes it to
 * Parousia Desktop, and to Discord through Discord-RPC-Extension's app when
 * that's on. Shared by Chromium and Firefox (both expose `chrome.*`);
 * platform-specific integrations are composed in each entry file.
 */
export function startBackground(appName: string, options: BackgroundOptions = {}): Background {
  const logger = createLogger(appName);
  restrictStorage();
  const registry = options.registry ?? new ActivityRegistry();
  const link = options.link ?? createDesktopConnection();
  const bridge = options.bridge ?? createDiscordBridge();
  let states: ActivityStates = {};
  let activeTabId: number | null = null;
  let windowFocused = true;
  let preferences: Preferences = DEFAULT_PREFERENCES;
  let defaultActivity: DefaultActivity = EMPTY_DEFAULT_ACTIVITY;
  /** When the Default Activity started being shown, so its elapsed time doesn't restart on every refresh. */
  let defaultSince: number | null = null;
  /** Clears presence once the idle timeout runs out after the browser loses focus. */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The idle timeout ran out: nothing is shared again until the browser has focus, or sound plays. */
  let idleExpired = false;

  const pages = new PageHost(
    registry,
    options.pages ?? chromePageBrowser(),
    options.natives ?? [],
    (tabId) => {
      if (tabId === activeTabId) void refresh();
    },
  );
  const malSync = new MalSyncSource({
    ...(options.askMalSync && { ask: options.askMalSync }),
    onChange: () => void refresh(),
  });
  const runtime = new PresenceRuntime(registry, {
    usable: (info, url) => pages.usable(info, url),
    settings: (info) => settingValues(info, states),
    fallback: () => defaultActivityToShow(defaultActivity, defaultSince ?? Date.now()),
    // What MAL-Sync shows is a page's own reading, so Settings > Privacy limits it like a PreMiD
    // Activity's. Its cover is the series itself: without media details it isn't a picture to share.
    external: () => {
      const shown = malSync.current();
      const allowed = preferences.shareMediaDetails
        ? PAGE_DATA_KINDS.filter((kind) => preferences.pageData[kind])
        : [];
      return shown && limitPageData(shown, allowed, { name: MALSYNC_NAME });
    },
  });
  const keepAlive = backgroundKeepalive();

  /**
   * Discord-RPC-Extension's app stands in for Desktop rather than running
   * beside it: while Desktop is connected it shows Discord itself, and the
   * same presence twice would be two activities on the profile. So the app's
   * link yields (no connecting, no probing, nothing shown) until Desktop has
   * failed to answer, and again as soon as it does. While Desktop is being
   * tried it keeps its last answer, so neither a retry nor a first attempt
   * makes the app flicker.
   */
  bridge.setYielding(true);
  link.onStateChange(({ status }) => {
    if (status === "connected" || status === "idle") bridge.setYielding(true);
    else if (status !== "connecting") bridge.setYielding(false);
  });

  const watchers = new Set<(activity: UiActivity | null) => void>();
  /** The shared Activity as UIs show it: with whether it has settings to change from the popup. */
  const shown = (activity: Activity | null): UiActivity | null => {
    const info = activity && activity.id !== DEFAULT_ACTIVITY_ID ? registry.get(activity.id) : null;
    return uiActivity(activity, (info?.settings?.length ?? 0) > 0);
  };
  const controller = new PresenceController(runtime, {
    send: (presence) => {
      const { activity } = presence;
      keepAlive(activity !== null);
      defaultSince =
        activity?.id === DEFAULT_ACTIVITY_ID ? (activity.timestamps?.start ?? defaultSince) : null;
      link.send(presence);
      bridge.send(presence);
      if (watchers.size > 0) {
        const ui = shown(activity);
        for (const watcher of watchers) watcher(ui);
      }
    },
  });

  serveUi(link, bridge, {
    get: () => shown(controller.getActivity()),
    onChange: (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  });

  function stopIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /**
   * Whether to share `tab` now. With the browser in focus, always. Away from
   * it, only while sound is playing in the tab (music doesn't stop because
   * someone looked at Discord, or opened the popup), or for the Idle Timeout,
   * if there is one. Either way, what's shared keeps following the tab: a song
   * that changes while someone's in another window changes in Discord too.
   */
  function sharingWhileAway(tab: chrome.tabs.Tab): boolean {
    if (windowFocused || tab.audible === true) {
      stopIdleTimer();
      if (windowFocused) idleExpired = false;
      return true;
    }
    const minutes = preferences.idleTimeoutMinutes;
    if (minutes === 0 || idleExpired) {
      stopIdleTimer();
      controller.clear();
      return false;
    }
    idleTimer ??= setTimeout(() => {
      idleTimer = null;
      idleExpired = true;
      controller.clear();
    }, minutes * 60_000);
    return true;
  }

  async function refresh(): Promise<void> {
    if (activeTabId === null) {
      stopIdleTimer();
      malSync.watch(null);
      controller.clear();
      return;
    }
    try {
      const tabId = activeTabId;
      const tab = await chrome.tabs.get(tabId);
      if (tabId !== activeTabId) return;
      if (!sharingWhileAway(tab)) {
        malSync.watch(null);
        return;
      }
      const share = (activity: Activity | null): Activity | null =>
        applyPreferences(
          activity,
          preferences,
          tab.incognito,
          activity ? registry.get(activity.id)?.name : undefined,
        );
      if (!tab.url) {
        // A page the extension can't see (a browser page): only the Default Activity, if one is set up.
        malSync.watch(null);
        controller.update(null, share);
        return;
      }
      const url = new URL(tab.url);
      // A private tab that's paused is never asked about, so MAL-Sync isn't woken for it either.
      const asked =
        /^https?:$/.test(url.protocol) && !(tab.incognito && preferences.incognito === "pause");
      malSync.watch(asked ? { id: tabId, url } : null);
      // Site access, the page data it's granted, and what the page gave, for an Activity that reads pages.
      const page = await pages.page(tabId, url);
      if (tabId !== activeTabId) return;
      controller.update(
        {
          url,
          title: tab.title ?? "",
          ...(tab.favIconUrl && { favicon: tab.favIconUrl }),
          ...page,
        },
        share,
      );
    } catch {
      // Tab vanished between the event firing and this lookup running.
      malSync.watch(null);
      controller.clear();
    }
  }

  const usePreferences = (next: Preferences): void => {
    preferences = next;
    pages.setPageData(next.pageData);
    link.setPlatforms(enabledPlatforms(next));
    bridge.setEnabled(next.platforms.discord && next.discordRpcExtension);
    malSync.setEnabled(next.malSync);
    void refresh();
  };
  watchPreferences(usePreferences);
  loadPreferences().then(usePreferences, () =>
    logger.info("preferences unreadable, using the defaults"),
  );

  const useStates = async (next: ActivityStates): Promise<void> => {
    states = next;
    await pages.setStates(next);
    void refresh();
  };
  watchActivityStates((next) => void useStates(next));
  loadActivityStates().then(
    (next) => useStates(next),
    () => useStates({}),
  );

  const useDefault = (next: DefaultActivity): void => {
    defaultActivity = next;
    void refresh();
  };
  watchDefaultActivity(useDefault);
  loadDefaultActivity().then(useDefault, () => {});

  // What's shared is the active tab of the focused window. A tab activated
  // in another window (one opening in the background, or the tab next to a
  // closed one) doesn't change that; focusing a window does.
  let focusedWindow: number | null = null;
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (focusedWindow !== null && windowId !== focusedWindow) return;
    activeTabId = tabId;
    void refresh();
  });

  // Chromium throws "This event does not support filters" for a filter
  // argument on tabs.onUpdated (unlike some other tabs events), so unrelated
  // updates (favicon, audible, pinned, ...) are discarded here instead of at
  // the browser level. A title (or favicon) matters only on a page an Activity
  // looks at: single-page sites often set it a moment after the URL. A finished load
  // matters only while an Activity that reads pages is on: the new document
  // needs its script again.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const loaded = changeInfo.status === "complete" && pages.active;
    if (loaded) pages.loaded(tabId);
    if (tabId !== activeTabId) return;
    // The favicon is the last image an Activity without one falls back on, and tabs report it after the page.
    const titleMatters =
      (changeInfo.title !== undefined || changeInfo.favIconUrl !== undefined) &&
      tab.url !== undefined &&
      runtime.matches(new URL(tab.url));
    // Sound starting or stopping decides whether a tab is shared while the browser is out of focus.
    if (
      changeInfo.url !== undefined ||
      titleMatters ||
      loaded ||
      changeInfo.audible !== undefined
    ) {
      void refresh();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pages.forget(tabId);
    if (tabId === activeTabId) {
      activeTabId = null;
      malSync.watch(null);
      controller.clear();
    }
  });

  const focusWindow = (windowId: number): void => {
    windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
    if (!windowFocused || windowId === focusedWindow) {
      void refresh();
      return;
    }
    focusedWindow = windowId;
    void chrome.tabs.query({ active: true, windowId }).then(
      ([tab]) => {
        if (focusedWindow !== windowId) return;
        activeTabId = tab?.id ?? null;
        void refresh();
      },
      () => void refresh(),
    );
  };
  chrome.windows.onFocusChanged.addListener(focusWindow);
  // Closing the focused window doesn't always say where focus went (a
  // headless browser, one closed while the browser itself wasn't focused).
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId !== focusedWindow) return;
    focusedWindow = null;
    chrome.windows.getLastFocused().then(
      (window) =>
        focusWindow(
          window.focused && window.id !== undefined ? window.id : chrome.windows.WINDOW_ID_NONE,
        ),
      () => focusWindow(chrome.windows.WINDOW_ID_NONE),
    );
  });

  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab?.id ?? null;
    focusedWindow ??= tab?.windowId ?? null;
    await refresh();
  })();

  logger.info("initialized");

  return {
    getActivity: () => controller.getActivity(),
    getState: () => link.getState(),
  };
}
