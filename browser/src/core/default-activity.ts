import type { Activity, ActivityAssets, ActivityButton } from "./activity";
import { t } from "./i18n";
import type { PreferenceArea } from "./preferences";

/**
 * The Default Activity: a presence someone writes themselves, shared
 * whenever no Activity has anything to share (a site no Activity covers, a
 * browser page, a new tab). It goes through the same runtime as a detected
 * Activity, so Privacy settings, private windows, the idle timeout, and
 * Settings > Platforms apply to it the same way. Kept in
 * `chrome.storage.local` under `defaultActivity`; blank fields are left out.
 */
export interface DefaultActivity {
  enabled: boolean;
  name: string;
  details: string;
  state: string;
  largeImage: string;
  largeText: string;
  smallImage: string;
  smallText: string;
  /** At most two; one with a blank label and link is left out. */
  buttons: ActivityButton[];
  /** Show how long it's been shown. */
  elapsed: boolean;
  /** A Discord Application of its own; blank for Parousia's. */
  discordClientId: string;
}

/** Its id: not a folder slug or `premid:` id, so no Activity can have it. */
export const DEFAULT_ACTIVITY_ID = "parousia:default";

export const DEFAULT_ACTIVITY_LIMITS = {
  /** Discord shows at most 128 characters of a line, and nothing under 2. */
  text: 128,
  image: 256,
  label: 32,
  link: 512,
  buttons: 2,
} as const;

export const EMPTY_DEFAULT_ACTIVITY: DefaultActivity = {
  enabled: false,
  name: "",
  details: "",
  state: "",
  largeImage: "",
  largeText: "",
  smallImage: "",
  smallText: "",
  buttons: [],
  elapsed: true,
  discordClientId: "",
};

export type DefaultActivityField =
  | "name"
  | "details"
  | "state"
  | "largeImage"
  | "largeText"
  | "smallImage"
  | "smallText"
  | "buttons"
  | "discordClientId";

const STORAGE_KEY = "defaultActivity";
const TEXT_FIELDS = ["name", "details", "state", "largeText", "smallText"] as const;
const IMAGE_FIELDS = ["largeImage", "smallImage"] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

function isWebUrl(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** An image Discord can show: an `https` URL (it fetches it through its own proxy), or an asset key of the Application's own. */
const isImage = (value: string): boolean =>
  isWebUrl(value, ["https:"]) || /^[a-z0-9_-]{1,64}$/.test(value);

/** Anything stored that isn't valid falls back field by field; lengths are capped. */
export function parseDefaultActivity(value: unknown): DefaultActivity {
  if (!isObject(value)) return EMPTY_DEFAULT_ACTIVITY;
  const { text: max, image, label, link, buttons: most } = DEFAULT_ACTIVITY_LIMITS;
  const buttons = Array.isArray(value.buttons)
    ? value.buttons
        .filter(isObject)
        .slice(0, most)
        .map((button) => ({ label: text(button.label, label), url: text(button.url, link) }))
    : [];
  return {
    enabled: value.enabled === true,
    name: text(value.name, max),
    details: text(value.details, max),
    state: text(value.state, max),
    largeImage: text(value.largeImage, image),
    largeText: text(value.largeText, max),
    smallImage: text(value.smallImage, image),
    smallText: text(value.smallText, max),
    buttons,
    elapsed: typeof value.elapsed === "boolean" ? value.elapsed : EMPTY_DEFAULT_ACTIVITY.elapsed,
    discordClientId: text(value.discordClientId, 20),
  };
}

/** What's wrong with it, by field, in words for the form. Empty: it can be shown. */
export function defaultActivityProblems(
  activity: DefaultActivity,
): Partial<Record<DefaultActivityField, string>> {
  const problems: Partial<Record<DefaultActivityField, string>> = {};
  if (activity.name.trim().length < 2)
    problems.name = t("Give it a name of at least 2 characters.");
  for (const field of TEXT_FIELDS) {
    const value = activity[field].trim();
    if (field !== "name" && value.length === 1) {
      problems[field] = t("Discord leaves out lines under 2 characters.");
    }
  }
  for (const field of IMAGE_FIELDS) {
    const value = activity[field].trim();
    if (value && !isImage(value)) {
      problems[field] = t(
        "Use an https image link, or an asset name from your own Discord Application.",
      );
    }
  }
  for (const button of activity.buttons) {
    const label = button.label.trim();
    const url = button.url.trim();
    if (!label && !url) continue;
    if (!label || !url) problems.buttons = t("A button needs both a label and a link.");
    else if (!isWebUrl(url, ["https:", "http:"]))
      problems.buttons = t("Button links start with https:// or http://.");
  }
  if (activity.discordClientId && !/^\d{17,20}$/.test(activity.discordClientId)) {
    problems.discordClientId = t("A Discord Application ID is 17 to 20 digits.");
  }
  return problems;
}

/**
 * The Activity to share, or `null` while it's off or can't be shown. `since`
 * is when it started being shown, for the elapsed time.
 */
export function defaultActivityToShow(activity: DefaultActivity, since: number): Activity | null {
  if (!activity.enabled || Object.keys(defaultActivityProblems(activity)).length > 0) return null;
  const shown: Activity = { id: DEFAULT_ACTIVITY_ID, name: activity.name.trim() };
  const details = activity.details.trim();
  const state = activity.state.trim();
  if (details) shown.details = details;
  if (state) shown.state = state;
  const assets: ActivityAssets = {};
  for (const [key, value] of [
    ["largeImage", activity.largeImage],
    ["largeText", activity.largeText],
    ["smallImage", activity.smallImage],
    ["smallText", activity.smallText],
  ] as const) {
    if (value.trim()) assets[key] = value.trim();
  }
  if (Object.keys(assets).length > 0) shown.assets = assets;
  const buttons = activity.buttons
    .map((button) => ({ label: button.label.trim(), url: button.url.trim() }))
    .filter((button) => button.label && button.url);
  if (buttons.length > 0) shown.buttons = buttons;
  if (activity.elapsed) shown.timestamps = { start: since };
  if (activity.discordClientId) shown.discordClientId = activity.discordClientId;
  return shown;
}

export async function loadDefaultActivity(
  area: PreferenceArea = chrome.storage.local,
): Promise<DefaultActivity> {
  return parseDefaultActivity((await area.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function saveDefaultActivity(
  activity: DefaultActivity,
  area: PreferenceArea = chrome.storage.local,
): Promise<DefaultActivity> {
  const next = parseDefaultActivity(activity);
  await area.set({ [STORAGE_KEY]: next });
  return next;
}

/** Calls `listener` whenever it's saved, from any view. Returns a function that stops it. */
export function watchDefaultActivity(listener: (activity: DefaultActivity) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const change = changes[STORAGE_KEY];
    if (area === "local" && change) listener(parseDefaultActivity(change.newValue));
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
