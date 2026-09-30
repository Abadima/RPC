import { faClock } from "@fortawesome/free-solid-svg-icons/faClock";
import { faMoon } from "@fortawesome/free-solid-svg-icons/faMoon";
import type { PresenceSnapshot, PresenceViewOptions } from "./presence-view";
import type { ConnectionState } from "../core/desktop-connection";
import type { BridgeState, UiActivity } from "../core/ui-port";
import { connectionBadge, connectionHelp, type ConnectionHelp } from "./connection-status";
import { icon } from "./icons";
import { DESKTOP_DOWNLOAD } from "./links";

/** Icons for the shared presence view, the same in the popup and dashboard. */
export const presenceIcons: PresenceViewOptions = {
  icon: (name) => icon(name === "elapsed" ? faClock : faMoon),
};

/**
 * What the presence view shows: the Activity the background is sharing (it
 * pushes every change), already as Privacy settings allow. Asking the
 * background rather than looking at the tab here is what makes a PreMiD
 * Activity, which only its page script knows, show up too.
 */
export function presenceSnapshot(activity: UiActivity | null): PresenceSnapshot {
  return { activity };
}

export function renderBadge(badge: HTMLElement, state: ConnectionState, sharing: boolean): void {
  const { text, tone } = connectionBadge(state, sharing);
  badge.dataset.tone = tone;
  badge.textContent = text;
}

/**
 * Fills a `.banner` with what to do about the connection, or hides it. The
 * banner keeps its text in its own `[data-help]` element, so its text content
 * reads as one message (e2e scripts check it) and the actions stay separate.
 */
export function renderHelp(banner: HTMLElement, help: ConnectionHelp | null): void {
  banner.hidden = help === null;
  const body = banner.querySelector("[data-help]");
  if (!help || !body) return;
  const title = document.createElement("p");
  title.className = "banner-title";
  title.textContent = help.title;
  const detail = document.createElement("p");
  detail.className = "banner-detail";
  detail.textContent = help.detail;
  body.replaceChildren(title, detail);
  if (help.command) {
    const command = document.createElement("code");
    command.className = "banner-command";
    command.textContent = help.command;
    body.append(command);
  }
}

/**
 * The "Parousia Desktop couldn't be found" screen (Figma: screen-3-disconnected),
 * shared by the popup and the dashboard's Overview: what's wrong, a way to
 * get Desktop, and a Retry that can't be spammed while a check is running.
 */
export function renderOffline(
  screen: HTMLElement,
  state: ConnectionState,
  checking: boolean,
  origin: string,
): void {
  const banner = screen.querySelector<HTMLElement>(".banner");
  const download = screen.querySelector<HTMLAnchorElement>("[data-download]");
  const label = screen.querySelector("[data-download-label]");
  const retry = screen.querySelector<HTMLButtonElement>("[data-retry]");
  if (!banner || !download || !label || !retry) throw new Error("incomplete offline screen");

  banner.dataset.tone = connectionBadge(state).tone;
  renderHelp(banner, connectionHelp(state, origin));
  // Refused builds already have Desktop; a version mismatch needs a newer one.
  download.hidden = state.status === "not_allowed";
  download.href = DESKTOP_DOWNLOAD;
  label.textContent =
    state.status === "incompatible" ? "Update Parousia Desktop" : "Get Parousia Desktop";
  retry.disabled = checking;
  retry.textContent = checking ? "Checking…" : "Retry Connection";
}

/** Under the not-found screen: Discord can still work without Desktop when Discord-RPC-Extension's app is running. */
export function renderDiscordAside(aside: HTMLElement, discord: BridgeState): void {
  aside.hidden = discord.status !== "connected";
  aside.textContent =
    "Discord-RPC-Extension is running, so Discord can still show your activity without Parousia Desktop.";
}
