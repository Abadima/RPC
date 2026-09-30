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
 * Parousia's own Discord Application: what an Activity without its own
 * (`ActivityInfo.discordClientId`) shows as. Public, like every Discord
 * client id. Parousia Desktop falls back to the same one.
 */
export const PAROUSIA_DISCORD_CLIENT_ID = "1553980756731363428";

/**
 * The Discord Application to answer Discord-RPC-Extension's own extension
 * with. That cross-extension layer stays inert (registers with nothing,
 * answers nothing) until one is chosen (see project/roadmap.md, Compatibility).
 */
export const DISCORD_RPC_EXTENSION_CLIENT_ID: string | null = null;

/**
 * What Discord-RPC-Extension's app hands to its RPC library's `setActivity`
 * (@xhayper/discord-rpc), which renames these to Discord's own fields.
 */
export interface DiscordRpcExtensionPresence {
  name?: string;
  details?: string;
  detailsUrl?: string;
  state?: string;
  stateUrl?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  buttons?: Array<{ label: string; url: string }>;
  instance: boolean;
}

export type DiscordRpcExtensionResponse =
  | { clientId: string; presence: DiscordRpcExtensionPresence }
  | Record<string, never>;

const MAX_TEXT = 128;
const MIN_TEXT = 2;
const MAX_IMAGE = 256;
const MAX_LINK = 256;
const MAX_BUTTON_LABEL = 32;
const MAX_BUTTON_URL = 512;
const MAX_BUTTONS = 2;
const MAX_TIME = 2_147_483_647_000;

/** `value` if it's `min..=max` UTF-16 units; longer, the first `max - 1` (never half a pair) and "…". */
function cut(value: string, min: number, max: number): string | undefined {
  if (value.length < min) return undefined;
  if (value.length <= max) return value;
  let head = "";
  for (const char of value) {
    if (head.length + char.length >= max) break;
    head += char;
  }
  return `${head.trimEnd()}…`;
}

const text = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : cut(value.trim(), MIN_TEXT, MAX_TEXT);

function image(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= MAX_IMAGE ? trimmed : undefined;
}

const link = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && /^https?:\/\//.test(value) && value.length <= max ? value : undefined;

const time = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_TIME
    ? value
    : undefined;

/**
 * Parousia's Activity as a Discord activity. The same rules as Desktop's
 * `desktop/src/discord/activity.rs`, and both are tested against the cases in
 * `adapters/discord/activity-mapping.json`. Discord turns down a whole
 * activity over one field it doesn't accept, so a field it can't take is
 * left out instead:
 *
 * - Text (name, details, state, image captions) is trimmed. Under 2 UTF-16
 *   units it's left out; over 128 it's cut to 127 and ends in "…".
 * - Images (asset keys or URLs): at most 256 units.
 * - Links for the details and state lines: `http(s)`, at most 256.
 * - Buttons: the first 2 with a label, cut to 32 like text; URL `http(s)`, at most 512.
 * - Times: whole milliseconds from 1 through 2147483647000, the most the RPC
 *   library behind Discord-RPC-Extension's app accepts.
 */
export function toDiscordPresence(activity: Activity): DiscordRpcExtensionPresence {
  const buttons = (activity.buttons ?? [])
    .map((button) => ({
      label: cut(button.label.trim(), 1, MAX_BUTTON_LABEL),
      url: link(button.url, MAX_BUTTON_URL),
    }))
    .filter((button): button is { label: string; url: string } => !!button.label && !!button.url)
    .slice(0, MAX_BUTTONS);
  // Fields left `undefined` disappear when the presence is serialized.
  return {
    name: text(activity.name),
    details: text(activity.details),
    detailsUrl: link(activity.detailsUrl, MAX_LINK),
    state: text(activity.state),
    stateUrl: link(activity.stateUrl, MAX_LINK),
    startTimestamp: time(activity.timestamps?.start),
    endTimestamp: time(activity.timestamps?.end),
    largeImageKey: image(activity.assets?.largeImage),
    largeImageText: text(activity.assets?.largeText),
    smallImageKey: image(activity.assets?.smallImage),
    smallImageText: text(activity.assets?.smallText),
    buttons: buttons.length > 0 ? buttons : undefined,
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
 * protocol, if installed. A no-op until DISCORD_RPC_EXTENSION_CLIENT_ID is set.
 */
export function startDiscordRpcExtensionCompat(getActivity: () => Activity | null): void {
  if (!DISCORD_RPC_EXTENSION_CLIENT_ID) {
    return;
  }
  const clientId = DISCORD_RPC_EXTENSION_CLIENT_ID;
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
