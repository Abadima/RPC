import { PAROUSIA_DISCORD_CLIENT_ID } from "../compat/discord-rpc-extension";
import { DiscordRpcServerLink } from "../compat/discord-rpc-server";
import type { Activity, ActivityInfo } from "../core/activity";
import { webSocketChannel } from "../core/channel";
import { describeClient } from "../core/client-name";
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
  loadPreferences,
  watchPreferences,
  type Preferences,
} from "../core/preferences";
import { builtInActivities } from "../core/activities";
import { PresenceRuntime } from "../core/runtime";
import type { PresenceTransport } from "../core/transport";
import { UI_PORT_NAME, parseUiRequest, type BridgeState, type UiEvent } from "../core/ui-port";

export interface Background {
  /** The Activity currently detected on the active tab, if any. */
  getActivity: () => Activity | null;
  getState: () => ConnectionState;
}

export function createDesktopConnection(): DesktopConnection {
  return new DesktopConnection({ channel: webSocketChannel(), clientName: describeClient() });
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
  acquire(): () => void;
  getState(): BridgeState;
  onStateChange(listener: (state: BridgeState) => void): () => void;
}

/** Each Activity shows in Discord as its own Discord Application, falling back to Parousia's. */
export function createDiscordBridge(activities: readonly ActivityInfo[]): DiscordBridge {
  const clientIds = new Map(activities.map((info) => [info.id, info.discordClientId]));
  return new DiscordRpcServerLink({
    clientIdFor: (activity) => clientIds.get(activity.id) ?? PAROUSIA_DISCORD_CLIENT_ID,
    extId: chrome.runtime.id,
  });
}

/**
 * Serves the popup and dashboard (see ui-port.ts): pushes connection state,
 * answers status and settings requests, and keeps the connections wanted
 * while one is open. Only this extension's own pages can open the port.
 */
function serveUi(link: DesktopLink, discord: DiscordBridge): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== UI_PORT_NAME || port.sender?.id !== chrome.runtime.id) return;

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
    post({ type: "state", state: link.getState() });
    post({ type: "discord", state: discord.getState() });

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
      release();
      releaseDiscord();
    });
  });
}

/**
 * Wires the Activity/Presence lifecycle to the tabs API and publishes it to
 * Parousia Desktop, and to Discord through Discord-RPC-Extension's app when
 * that's on. Shared by Chromium, Firefox, and Safari (all expose `chrome.*`);
 * platform-specific integrations are composed in each entry file.
 */
export function startBackground(
  appName: string,
  link: DesktopLink = createDesktopConnection(),
  discord?: DiscordBridge,
): Background {
  const logger = createLogger(appName);
  const activities = builtInActivities();
  const bridge = discord ?? createDiscordBridge(activities.list());

  serveUi(link, bridge);
  const keepAlive = backgroundKeepalive();
  // Every Presence goes to Desktop and, for Discord, to Discord-RPC-Extension's app if enabled.
  const controller = new PresenceController(new PresenceRuntime(activities), {
    send: (presence) => {
      keepAlive(presence.activity !== null);
      link.send(presence);
      bridge.send(presence);
    },
  });

  let activeTabId: number | null = null;
  let windowFocused = true;
  let preferences: Preferences = DEFAULT_PREFERENCES;
  /** Clears presence once the idle timeout runs out after the browser loses focus. */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function stopIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }

  async function refresh(): Promise<void> {
    if (activeTabId === null) {
      stopIdleTimer();
      controller.clear();
      return;
    }
    if (!windowFocused) {
      // Keep sharing for the idle timeout, if there is one (the keepalive
      // holds the background up meanwhile).
      const minutes = preferences.idleTimeoutMinutes;
      if (minutes === 0) {
        stopIdleTimer();
        controller.clear();
      } else {
        idleTimer ??= setTimeout(() => {
          idleTimer = null;
          controller.clear();
        }, minutes * 60_000);
      }
      return;
    }
    stopIdleTimer();

    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (!tab.url) {
        controller.clear();
        return;
      }
      controller.update(new URL(tab.url), (activity) =>
        applyPreferences(activity, preferences, tab.incognito),
      );
    } catch {
      // Tab vanished between the event firing and this lookup running.
      controller.clear();
    }
  }

  const usePreferences = (next: Preferences): void => {
    preferences = next;
    bridge.setEnabled(next.platforms.discord && next.discordRpcExtension);
    void refresh();
  };
  watchPreferences(usePreferences);
  loadPreferences().then(usePreferences, () =>
    logger.info("preferences unreadable, using the defaults"),
  );

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    activeTabId = tabId;
    void refresh();
  });

  // Chromium throws "This event does not support filters" for a filter
  // argument on tabs.onUpdated (unlike some other tabs events), so unrelated
  // updates (title, favicon, audible, pinned, ...) are discarded here instead
  // of at the browser level.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === activeTabId && changeInfo.url !== undefined) {
      void refresh();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabId) {
      activeTabId = null;
      controller.clear();
    }
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
    void refresh();
  });

  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab?.id ?? null;
    await refresh();
  })();

  logger.info("initialized");

  return {
    getActivity: () => controller.getActivity(),
    getState: () => link.getState(),
  };
}
