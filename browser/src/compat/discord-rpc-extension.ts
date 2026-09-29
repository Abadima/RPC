import type { Activity } from "../core/activity";

/**
 * Discord-RPC-Extension compatibility (github.com/lolamtisch/Discord-RPC-Extension):
 * Parousia's Activity detection feeds that extension's own Desktop bridge, so
 * Rich Presence works without Parousia Desktop. Nothing in `core/` knows this
 * exists. Checked against its source (Extension/background.js, Examples/):
 *
 * - `chrome.runtime.sendMessage(<their id>, { mode })` registers. They branch
 *   on `sender.tab`, not `mode`: a background-script sender always becomes
 *   their "background" type, so the `mode` sent isn't load-bearing.
 * - They re-request presence about every 15 s with a cross-extension message,
 *   which arrives on `onMessageExternal`, not `onMessage`.
 * - Every request needs a response or they unregister us; `{}` means "still
 *   here, nothing to show".
 * - `externally_connectable.ids` narrows who can message us on Chrome only.
 *   Firefox never implemented it (bugzilla.mozilla.org/1319168), so the
 *   `sender.id` check below is the real, cross-browser restriction.
 */

/** Discord-RPC-Extension's own published, stable extension IDs (docs/api.md). */
export const DISCORD_RPC_EXTENSION_IDS = {
  chrome: "agnaejlkbiiggajjmnpmeheigkflbnoo",
  firefox: "{57081fef-67b4-482f-bcb0-69296e63ec4f}",
} as const;

/**
 * The Discord Application ID to present as. Discord-RPC-Extension's protocol
 * requires one to render anything at all; which one (Parousia's own, or an
 * Activity's) is decided when this layer is switched on. Until it's set,
 * this whole compatibility layer stays inert: it registers with nothing and
 * answers nothing, rather than ever claiming a made-up identity to Discord.
 */
export const PAROUSIA_DISCORD_CLIENT_ID: string | null = null;

export interface DiscordRpcExtensionPresence {
  state?: string;
  details?: string;
  startTimestamp?: number;
  instance?: boolean;
}

export type DiscordRpcExtensionResponse =
  | { clientId: string; presence: DiscordRpcExtensionPresence }
  | Record<string, never>;

/** Parousia's Activity as the Discord presence Discord-RPC-Extension passes on. Shared by both ways of reaching it. */
export function toDiscordPresence(activity: Activity): DiscordRpcExtensionPresence {
  return {
    state: activity.state,
    details: activity.details,
    startTimestamp: activity.timestamps?.start,
    instance: true,
  };
}

/** Translates Parousia's canonical Activity into Discord-RPC-Extension's response shape. Pure, and independent of whether a clientId is configured yet. */
export function toDiscordRpcExtensionResponse(
  clientId: string,
  activity: Activity | null,
): DiscordRpcExtensionResponse {
  if (!activity) {
    // Documented explicitly: an empty object keeps the registration alive
    // with nothing displayed, as opposed to no response, which unregisters us.
    return {};
  }
  return { clientId, presence: toDiscordPresence(activity) };
}

function currentExtensionId(): string {
  // The same feature-detection Discord-RPC-Extension's own integration
  // examples use: Firefox exposes a promise-based `browser` global
  // alongside `chrome`; Chrome only ever has `chrome`.
  return "browser" in globalThis
    ? DISCORD_RPC_EXTENSION_IDS.firefox
    : DISCORD_RPC_EXTENSION_IDS.chrome;
}

/**
 * Wires Parousia's current Activity to Discord-RPC-Extension's presence
 * protocol, if installed. A no-op until PAROUSIA_DISCORD_CLIENT_ID is set.
 */
export function startDiscordRpcExtensionCompat(getActivity: () => Activity | null): void {
  if (!PAROUSIA_DISCORD_CLIENT_ID) {
    return;
  }
  const clientId = PAROUSIA_DISCORD_CLIENT_ID;
  const extensionId = currentExtensionId();

  chrome.runtime.sendMessage(extensionId, { mode: "passive" }, () => {
    // Ignore chrome.runtime.lastError: Discord-RPC-Extension simply not
    // being installed is the expected common case, not a failure to log.
    void chrome.runtime.lastError;
  });

  chrome.runtime.onMessageExternal.addListener(
    (request: { action?: string }, sender, sendResponse) => {
      if (sender.id !== extensionId || request?.action !== "presence") {
        return false;
      }
      sendResponse(toDiscordRpcExtensionResponse(clientId, getActivity()));
      return false;
    },
  );
}
