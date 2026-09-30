import type {
  Activity,
  ActivityAssets,
  ActivityButton,
  ActivityTimestamps,
  PageDataKind,
} from "../core/activity";
import type { ActivityManifest } from "../activities/manifest";

/**
 * PreMiD's `PresenceData` as the page runtime sends it (src/premid/page.ts):
 * text read out of nodes, image and link elements as their URLs, dates as
 * numbers. Untrusted: a page script can send anything, so it's parsed field
 * by field and bounded again in `toActivity`.
 *
 * Left out for now: `type` (Listening, Watching), `statusDisplayType`,
 * `party`, and links on the images, which Parousia's Activity doesn't carry
 * yet, and Blob images, which PreMiD uploads to its own image host.
 */
export interface PresenceDataWire {
  name?: string;
  details?: string;
  state?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
  detailsUrl?: string;
  stateUrl?: string;
  buttons?: Array<{ label: string; url: string }>;
}

const TEXT_FIELDS = [
  "name",
  "details",
  "state",
  "largeImageKey",
  "largeImageText",
  "smallImageKey",
  "smallImageText",
  "detailsUrl",
  "stateUrl",
] as const;

/** Longest text kept from a page; Discord shows 128, Desktop takes 512. */
const MAX_TEXT = 256;
const MAX_URL = 512;
/** Before 5138 in seconds, after 1973 in milliseconds: PreMiD takes either. */
const SECONDS_BELOW = 1e11;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parsePresenceData(value: unknown): PresenceDataWire | null {
  if (!isObject(value)) return null;
  const data: PresenceDataWire = {};
  for (const field of TEXT_FIELDS) {
    const text = value[field];
    if (typeof text === "string") data[field] = text;
  }
  for (const field of ["startTimestamp", "endTimestamp"] as const) {
    const time = value[field];
    if (typeof time === "number" && Number.isFinite(time)) data[field] = time;
  }
  if (Array.isArray(value.buttons)) {
    data.buttons = value.buttons
      .filter(
        (button): button is { label: string; url: string } =>
          isObject(button) && typeof button.label === "string" && typeof button.url === "string",
      )
      .slice(0, 2)
      .map(({ label, url }) => ({ label, url }));
  }
  return data;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= MAX_TEXT ? trimmed : [...trimmed].slice(0, MAX_TEXT).join("");
}

const web = (value: string | undefined): string | undefined =>
  value !== undefined && /^https?:\/\//i.test(value) && value.length <= MAX_URL ? value : undefined;

/** An image URL, or a Discord asset key (a PreMiD Activity's own Application may have uploaded some). */
const image = (value: string | undefined): string | undefined =>
  web(value) ?? (value !== undefined && /^[\w-]{1,64}$/.test(value) ? value : undefined);

/** Whole Unix milliseconds, rounded to the second so a media clock's jitter isn't a change. */
function time(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  const ms = value < SECONDS_BELOW ? value * 1000 : value;
  return Math.round(ms / 1000) * 1000;
}

/**
 * What a PreMiD Activity reported, as Parousia's Activity. `page` is the tab's
 * URL, kept without its query string or fragment; `clientId` is the
 * Application its script picked, already checked against its source.
 */
export function toActivity(
  entry: ActivityManifest,
  data: PresenceDataWire,
  page: URL,
  clientId: string,
): Activity {
  const assets: ActivityAssets = {};
  const largeImage = image(data.largeImageKey) ?? web(entry.info.icon);
  if (largeImage) assets.largeImage = largeImage;
  const largeText = text(data.largeImageText);
  if (largeText) assets.largeText = largeText;
  const smallImage = image(data.smallImageKey);
  if (smallImage) assets.smallImage = smallImage;
  const smallText = text(data.smallImageText);
  if (smallText) assets.smallText = smallText;

  const timestamps: ActivityTimestamps = {};
  const start = time(data.startTimestamp);
  if (start !== undefined) timestamps.start = start;
  const end = time(data.endTimestamp);
  if (end !== undefined) timestamps.end = end;

  const buttons: ActivityButton[] = [];
  for (const button of data.buttons ?? []) {
    const label = text(button.label);
    const url = web(button.url);
    if (label && url) buttons.push({ label, url });
  }

  const activity: Activity = {
    id: entry.info.id,
    name: text(data.name) ?? entry.info.name,
    url: `${page.origin}${page.pathname}`,
    discordClientId: clientId,
  };
  const details = text(data.details);
  if (details) activity.details = details;
  const state = text(data.state);
  if (state) activity.state = state;
  const detailsUrl = web(data.detailsUrl);
  if (detailsUrl) activity.detailsUrl = detailsUrl;
  const stateUrl = web(data.stateUrl);
  if (stateUrl) activity.stateUrl = stateUrl;
  if (Object.keys(assets).length > 0) activity.assets = assets;
  if (Object.keys(timestamps).length > 0) activity.timestamps = timestamps;
  if (buttons.length > 0) activity.buttons = buttons;
  return activity;
}

/** PreMiD's own image host: images there are an Activity's assets, not something read from a page. */
const OWN_ASSETS = "https://cdn.rcd.gg/PreMiD/";
const ownImage = (value: string): boolean =>
  !/^https?:\/\//i.test(value) || value.startsWith(OWN_ASSETS);

/**
 * What a PreMiD Activity reported, without the page data kinds switched off
 * in Settings > Privacy. Its code reads the page directly, so the kinds are
 * held back here, on the way out:
 *
 * - `media`: what's playing (details, state, their links, buttons, times,
 *   captions, and a name it set from the page, like a song's title).
 * - `thumbnails`: a large image from the page (its own icon shows instead).
 * - `creatorIcons`: a small image from the page.
 *
 * Its own images (Discord asset keys, PreMiD's asset host) aren't page data and stay.
 */
export function limitPageData(
  activity: Activity,
  allowed: readonly PageDataKind[],
  own: { name: string; icon?: string },
): Activity {
  const limited: Activity = { ...activity };
  const assets: ActivityAssets = { ...activity.assets };
  const { icon } = own;
  if (!allowed.includes("media")) {
    limited.name = own.name;
    delete limited.details;
    delete limited.state;
    delete limited.detailsUrl;
    delete limited.stateUrl;
    delete limited.buttons;
    delete limited.timestamps;
    delete assets.largeText;
    delete assets.smallText;
  }
  if (!allowed.includes("thumbnails") && assets.largeImage && !ownImage(assets.largeImage)) {
    if (icon) assets.largeImage = icon;
    else delete assets.largeImage;
  }
  if (!allowed.includes("creatorIcons") && assets.smallImage && !ownImage(assets.smallImage)) {
    delete assets.smallImage;
    delete assets.smallText;
  }
  if (Object.keys(assets).length > 0) limited.assets = assets;
  else delete limited.assets;
  return limited;
}
