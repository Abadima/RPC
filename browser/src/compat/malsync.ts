import type { Activity } from "../core/activity";
import type { Timer } from "../core/desktop-connection";
import { presenceEquals, createPresence } from "../core/presence";
import { MAX_MESSAGE, jsonSize } from "../activities/messages";
import { parsePresenceData, toActivity } from "../premid/presence-data";
import { onFirefox } from "./browser-family";

/**
 * MAL-Sync compatibility (github.com/MALSync/MALSync): what it recognizes on
 * anime and manga sites shows as the Activity, in place of the site's own.
 * Nothing in `core/` knows this exists but the runtime's `external` hook.
 * Checked against its source (src/index-webextension/serviceworker.ts,
 * src/pages-sync/syncPage.ts) and the shipped Firefox 0.12.5 build:
 *
 * - MAL-Sync never talks to Discord-RPC-Extension's app or its port 6969. Its
 *   content script registers with Discord-RPC-Extension's own browser
 *   extension (`runtime.sendMessage(<their id>, { mode: "active" })`, only
 *   with MAL-Sync's "Discord Rich Presence" setting on), and that extension
 *   asks back every 15 s.
 * - The asking is a cross-extension message to MAL-Sync's background,
 *   `{ tab, info }`, which relays it to that tab's content script and returns
 *   the reply: `{ clientId, presence }`, or `{}` when the page isn't one it
 *   has recognized. It checks neither who asks nor MAL-Sync's own "Discord
 *   Rich Presence" setting, and its manifest has no `externally_connectable`,
 *   so any extension can ask.
 * - So Parousia asks the same way, for the tab it shares, and takes the reply
 *   as its Activity. Nothing registers, nothing is listened for, and Parousia
 *   sends only a tab number: the browser delivers a reply to the extension
 *   that asked only from the extension asked, so no sender check is needed.
 *
 * MAL-Sync's reply is an untrusted page's reading, so it goes through the
 * same parsing and bounds as a PreMiD Activity's (`premid/presence-data.ts`,
 * whose field names it shares), and only Discord Applications MAL-Sync itself
 * uses are kept: a reply naming another is turned down whole.
 */

/** MAL-Sync's published extension IDs (Chrome Web Store, and the id of its listing on addons.mozilla.org). */
export const MALSYNC_EXTENSION_IDS = {
  chrome: "kekjfbackdeiabghhcdklcdoekaanoel",
  firefox: "{c84d89d9-a826-4015-957b-affebd9eb603}",
} as const;

/**
 * The Discord Applications MAL-Sync shows as: its own, and the Anime and
 * Manga ones it takes for "Name of the activity: Anime/Manga" (syncPage.ts).
 * Asset keys in a reply (its logo, play and pause icons) exist only there.
 */
const MALSYNC_CLIENT_IDS: readonly string[] = [
  "606504719212478504",
  "823563096747802695",
  "823563138669608980",
];

/** The id shown Activities carry; the prefix keeps it clear of any catalog id. */
export const MALSYNC_ACTIVITY_ID = "compat:malsync";
export const MALSYNC_NAME = "MAL-Sync";

/** How often to ask again while it has something to show: as often as Discord-RPC-Extension does. */
const POLL_MS = 15_000;
/**
 * After a page loads, or it stops having something to show, MAL-Sync is asked
 * again at these gaps and then left alone: a page's script (the first
 * question often comes before it's there) and its reading of the episode
 * arrive after the address does, and a tab it never answers for (any site
 * that isn't one of its own) costs three more questions, not a poll. They end
 * within 25 seconds, inside the 30 an idle MV3 background survives.
 */
const RETRY_MS: readonly number[] = [3000, 7000, 15_000];
/**
 * Its timestamps come from the player's clock at the moment of asking, so
 * they wander by about a second while one episode plays straight through.
 * Anything under this is the same playback, not a seek.
 */
const DRIFT_MS = 5000;

/** MAL-Sync's reply for `tabId`, or `undefined` where it isn't installed or has no script in that tab. */
function askMalSync(tabId: number): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const id = onFirefox() ? MALSYNC_EXTENSION_IDS.firefox : MALSYNC_EXTENSION_IDS.chrome;
      chrome.runtime.sendMessage(
        id,
        { tab: tabId, info: { action: "presence", active: true } },
        (reply: unknown) => {
          // Not being installed is the common case, not a failure to log.
          void chrome.runtime.lastError;
          resolve(reply);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

const bare = (host: string): string => host.replace(/^www\./, "");

/** Whether `link` is on the site `page` is: its own address, which stays in the browser. */
function onSite(link: string, page: URL): boolean {
  try {
    const host = bare(new URL(link).hostname);
    const own = bare(page.hostname);
    return host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`);
  } catch {
    return true;
  }
}

/**
 * MAL-Sync's reply as an Activity, or `null` for `{}` and anything else that
 * isn't a reply from MAL-Sync. `page` is the tab it was asked about: a link
 * to that site (MAL-Sync's "website" setting can make its button the stream's
 * own address) isn't passed on, since a page's address stays in the browser.
 */
export function parseMalSyncReply(reply: unknown, page: URL): Activity | null {
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("clientId" in reply) ||
    !("presence" in reply) ||
    jsonSize(reply) > MAX_MESSAGE
  ) {
    return null;
  }
  const { clientId, presence } = reply;
  if (typeof clientId !== "string" || !MALSYNC_CLIENT_IDS.includes(clientId)) return null;
  const data = parsePresenceData(presence);
  if (!data) return null;
  const activity = toActivity(
    { info: { id: MALSYNC_ACTIVITY_ID, name: MALSYNC_NAME } },
    data,
    page,
    clientId,
  );
  const keep = (url: string | undefined): boolean => url === undefined || !onSite(url, page);
  const buttons = activity.buttons?.filter(({ url }) => keep(url));
  if (buttons?.length) activity.buttons = buttons;
  else delete activity.buttons;
  if (!keep(activity.detailsUrl)) delete activity.detailsUrl;
  if (!keep(activity.stateUrl)) delete activity.stateUrl;
  const { assets } = activity;
  if (assets && !keep(assets.largeUrl)) delete assets.largeUrl;
  if (assets && !keep(assets.smallUrl)) delete assets.smallUrl;
  return activity;
}

const near = (a: number | undefined, b: number | undefined): boolean =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < DRIFT_MS;

/** `next`, with `previous`' timestamps kept when they differ by no more than a clock's drift. */
function steady(next: Activity, previous: Activity | null): Activity {
  const was = previous?.timestamps;
  const now = next.timestamps;
  return was && now && near(was.start, now.start) && near(was.end, now.end)
    ? { ...next, timestamps: was }
    : next;
}

export interface MalSyncOptions {
  /** Asks MAL-Sync for `tabId`'s presence; by default through the browser. */
  ask?: (tabId: number) => Promise<unknown>;
  setTimer?: Timer;
  /** Called when what MAL-Sync shows changes by itself, from an answer arriving. */
  onChange: () => void;
}

const defaultTimer: Timer = (run, delayMs) => {
  const id = setTimeout(run, delayMs);
  return () => clearTimeout(id);
};

/**
 * What MAL-Sync shows for the one tab being shared. While off, or with no
 * tab, nothing is asked and nothing runs. On a page MAL-Sync recognizes it's
 * asked every `POLL_MS`; elsewhere, a few times after the page opens and then
 * not at all until the address changes, so an idle tab never wakes it.
 * Turning on, off, or moving to another page changes what `current` says
 * without calling `onChange`: the background asks for a fresh look after each
 * of those anyway.
 */
export class MalSyncSource {
  readonly #ask: (tabId: number) => Promise<unknown>;
  readonly #setTimer: Timer;
  readonly #onChange: () => void;
  #enabled = false;
  #tab: { id: number; page: URL } | null = null;
  /** Bumped by every move, so an answer for an earlier one is ignored. */
  #generation = 0;
  #attempt = 0;
  #current: Activity | null = null;
  #cancel: (() => void) | null = null;

  constructor(options: MalSyncOptions) {
    this.#ask = options.ask ?? askMalSync;
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#onChange = options.onChange;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#restart();
  }

  /** The tab being shared and the page it's on, or `null` for none (a browser page, a private tab, away). */
  watch(tab: { id: number; url: URL } | null): void {
    const next = tab && { id: tab.id, page: tab.url };
    if (next?.id === this.#tab?.id && next?.page.href === this.#tab?.page.href) return;
    this.#tab = next;
    this.#restart();
  }

  /** What MAL-Sync last showed for the page being watched, if it still does. */
  current(): Activity | null {
    return this.#current;
  }

  #restart(): void {
    this.#generation++;
    this.#cancel?.();
    this.#cancel = null;
    this.#attempt = 0;
    this.#current = null;
    if (this.#enabled && this.#tab) this.#probe(this.#tab);
  }

  #probe(tab: { id: number; page: URL }): void {
    const generation = this.#generation;
    const answered = (reply: unknown): void => {
      if (generation === this.#generation) this.#answer(parseMalSyncReply(reply, tab.page), tab);
    };
    // A throw from `ask` counts as no answer, like an extension that isn't there.
    void Promise.resolve()
      .then(() => this.#ask(tab.id))
      .then(answered, () => answered(undefined));
  }

  #answer(activity: Activity | null, tab: { id: number; page: URL }): void {
    const before = this.#current;
    let delay: number | undefined;
    if (activity) {
      this.#attempt = 0;
      this.#current = steady(activity, before);
      delay = POLL_MS;
    } else {
      this.#current = null;
      delay = RETRY_MS[this.#attempt++];
    }
    if (delay !== undefined) {
      this.#cancel = this.#setTimer(() => {
        this.#cancel = null;
        this.#probe(tab);
      }, delay);
    }
    if (!presenceEquals(createPresence(before), createPresence(this.#current))) this.#onChange();
  }
}
