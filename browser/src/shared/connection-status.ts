import type { ConnectionState, DesktopStatus } from "../core/desktop-connection";
import type { DesktopReport, DesktopSetting } from "../core/desktop-protocol";
import { UI_PORT_NAME, parseUiEvent, type BridgeState, type UiActivity } from "../core/ui-port";

export interface BackgroundLink {
  reconnect(): void;
  requestStatus(): void;
  setSetting(setting: DesktopSetting, value: boolean): void;
}

/**
 * Opens this view's port to the background script (see core/ui-port.ts) and
 * reports every connection state, Desktop report, and shared Activity it
 * pushes, for as long as the view stays open.
 */
export function connectToBackground(
  onState: (state: ConnectionState) => void,
  onReport: (report: DesktopReport | null) => void = () => {},
  onDiscord: (state: BridgeState) => void = () => {},
  onActivity: (activity: UiActivity | null) => void = () => {},
): BackgroundLink {
  const port = chrome.runtime.connect({ name: UI_PORT_NAME });
  port.onMessage.addListener((message: unknown) => {
    const event = parseUiEvent(message);
    if (event?.type === "state") onState(event.state);
    else if (event?.type === "report") onReport(event.report);
    else if (event?.type === "discord") onDiscord(event.state);
    else if (event?.type === "activity") onActivity(event.activity);
  });
  return {
    reconnect: () => port.postMessage({ type: "reconnect" }),
    requestStatus: () => port.postMessage({ type: "status-request" }),
    setSetting: (setting, value) => port.postMessage({ type: "set", setting, value }),
  };
}

/** Desktop is missing or refusing: the popup and Overview show the "not found" screen instead. */
export function isOffline(state: ConnectionState): boolean {
  return (
    state.status === "disconnected" ||
    state.status === "not_allowed" ||
    state.status === "incompatible"
  );
}

/**
 * What to show for `next` after `shown`. A retry in flight after Desktop went
 * missing keeps showing the missing state, with `checking` set, so the UI
 * doesn't flicker to "Connecting" and back every 10 seconds.
 */
export function displayedState(
  shown: ConnectionState,
  next: ConnectionState,
): { state: ConnectionState; checking: boolean } {
  return next.status === "connecting" && isOffline(shown)
    ? { state: shown, checking: true }
    : { state: next, checking: false };
}

/** Drives the status dot and badge colors (see theme.css, `data-tone`). */
export type ConnectionTone = "idle" | "busy" | "good" | "warn" | "bad";

interface StatusView {
  label: string;
  badge: string;
  tone: ConnectionTone;
}

const STATUS_VIEW: Record<DesktopStatus, StatusView> = {
  idle: { label: "Not connected", badge: "Idle", tone: "idle" },
  connecting: { label: "Connecting to Parousia Desktop…", badge: "Connecting", tone: "busy" },
  connected: { label: "Connected to Parousia Desktop", badge: "Connected", tone: "good" },
  disconnected: { label: "Not connected to Parousia Desktop", badge: "Disconnected", tone: "bad" },
  not_allowed: { label: "Not allowed by Parousia Desktop", badge: "Not allowed", tone: "warn" },
  incompatible: { label: "Parousia Desktop version mismatch", badge: "Mismatch", tone: "warn" },
};

/**
 * The footer line. `version` is Desktop's, from its status report, so it
 * appears once the report arrives. Pulled out of renderConnectionStatus so
 * the text is testable without a DOM.
 */
export function connectionStatusLabel(state: ConnectionState, version?: string): string {
  const label = STATUS_VIEW[state.status].label;
  return state.status === "connected" && version ? `${label} v${version}` : label;
}

/**
 * The header badge. Connected with nothing to share reads "Idle": the link
 * is fine, there's just no Activity on this tab.
 */
export function connectionBadge(
  state: ConnectionState,
  sharing = false,
): { text: string; tone: ConnectionTone } {
  if (state.status === "connected" && !sharing) return { text: "Idle", tone: "idle" };
  const { badge, tone } = STATUS_VIEW[state.status];
  return { text: badge, tone };
}

export interface ConnectionHelp {
  title: string;
  detail: string;
  /** A command to run, shown as copyable code. */
  command?: string;
}

/** What to do about a state, if anything; `origin` is this extension's own. */
export function connectionHelp(state: ConnectionState, origin: string): ConnectionHelp | null {
  switch (state.status) {
    case "not_allowed":
      return {
        title: "Parousia Desktop doesn't recognize this build",
        detail: "Allow it from the Parousia Desktop menu (Diagnostics), or run:",
        command: `Parousia-Desktop allow ${origin}`,
      };
    case "incompatible":
      return {
        title: "Versions don't match",
        detail:
          "This extension and Parousia Desktop are different versions. Update whichever is older.",
      };
    case "disconnected":
      return {
        title: "Parousia Desktop couldn't be found",
        detail: "Launch Parousia Desktop to share your browser activity.",
      };
    default:
      return null;
  }
}

/** Discord-RPC-Extension's app, as the Platforms page and Overview describe it. */
/**
 * How Parousia Desktop's adapter for `platform` is doing, from its last
 * report: `null` without a report (Desktop not connected) or an adapter.
 */
export function desktopPlatformLabel(
  report: DesktopReport | null,
  platform: string,
): string | null {
  const adapter = report?.platforms.find((p) => p.platform === platform);
  if (!adapter) return null;
  switch (adapter.state) {
    case "showing":
      return adapter.activity ? `Showing ${adapter.activity}` : "Showing your activity";
    case "connected":
    case "idle":
      return "Ready";
    case "connecting":
      return "Connecting…";
    case "not_running":
      return "Not running";
    case "refused":
      return adapter.error ? `Refused: ${adapter.error}` : "Refused";
  }
}

/**
 * Whether Overview mentions Discord-RPC-Extension's app. Once Parousia Desktop
 * is connected it shows Discord itself and the app stands down, so "Looking for
 * it…" would only be noise there. Settings > Platforms is where the app's
 * status lives; Overview mentions it only while Desktop isn't established.
 */
export function showsDiscordBridge(state: ConnectionState): boolean {
  return state.status !== "connected";
}

export function discordBridgeLabel(state: BridgeState): string {
  switch (state.status) {
    case "off":
      return "Off";
    case "connected":
      return state.version ? `Connected, v${state.version}` : "Connected";
    case "unavailable":
      return "Not running";
    default:
      return "Looking for it…";
  }
}

/**
 * Applies a state to an indicator dot and label. The dot's color comes from
 * CSS keyed off `data-tone` (see theme.css).
 */
export function renderConnectionStatus(
  dot: HTMLElement,
  label: HTMLElement,
  state: ConnectionState,
  version?: string,
): void {
  dot.dataset.tone = STATUS_VIEW[state.status].tone;
  label.textContent = connectionStatusLabel(state, version);
}
