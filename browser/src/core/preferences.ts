import type { Activity, PageDataKind } from "./activity";
import { LANGUAGES, t, type LanguagePreference } from "./i18n";

/**
 * The extension's own settings, kept in `chrome.storage.local` so the
 * background script and every open view read the same values. Desktop's
 * settings (the allowlist, userscripts) live in Desktop, not here.
 */
export type IncognitoBehavior = "pause" | "share";
export type PlatformId = "discord" | "fluxer" | "stoat";
/** Which kinds of page data Activities may read, for every Activity at once. */
export type PageDataPreferences = Readonly<Record<PageDataKind, boolean>>;

export interface Preferences {
  language: LanguagePreference;
  /** Off: publish only the Activity's name, never its details, state, or image captions. */
  shareMediaDetails: boolean;
  /** How long presence stays after the browser loses focus; 0 clears it at once. Sound playing in the tab keeps it either way. */
  idleTimeoutMinutes: number;
  incognito: IncognitoBehavior;
  /** Which platforms should show presence, for Parousia Desktop's adapters. */
  platforms: Record<PlatformId, boolean>;
  /** Also show Discord presence through Discord-RPC-Extension's app, when it's running. */
  discordRpcExtension: boolean;
  /** Show what the MAL-Sync extension recognizes on a page as the Activity, by asking it about the tab being shared. */
  malSync: boolean;
  /**
   * What Activities may read from pages they've been granted: switched off,
   * a kind is never collected (native Activities) or never shown (PreMiD's).
   */
  pageData: PageDataPreferences;
}

export const PLATFORM_IDS: readonly PlatformId[] = ["discord", "fluxer", "stoat"];
export const IDLE_TIMEOUT_STEPS: readonly number[] = [0, 1, 2, 5, 10, 15, 30, 60];

export const DEFAULT_PREFERENCES: Preferences = {
  language: "auto",
  shareMediaDetails: true,
  idleTimeoutMinutes: 1,
  incognito: "pause",
  platforms: { discord: true, fluxer: true, stoat: true },
  discordRpcExtension: true,
  malSync: false,
  pageData: { media: true, thumbnails: true, creatorIcons: true },
};

const STORAGE_KEY = "preferences";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

/** Anything stored that isn't a valid value falls back to its default, field by field. */
export function parsePreferences(value: unknown): Preferences {
  const stored = isObject(value) ? value : {};
  const platforms = isObject(stored.platforms) ? stored.platforms : {};
  const pageData = isObject(stored.pageData) ? stored.pageData : {};
  const flag = (candidate: unknown, fallback: boolean): boolean =>
    typeof candidate === "boolean" ? candidate : fallback;
  return {
    language: LANGUAGES.find((language) => language === stored.language) ?? "auto",
    shareMediaDetails: flag(stored.shareMediaDetails, DEFAULT_PREFERENCES.shareMediaDetails),
    idleTimeoutMinutes:
      typeof stored.idleTimeoutMinutes === "number" &&
      IDLE_TIMEOUT_STEPS.includes(stored.idleTimeoutMinutes)
        ? stored.idleTimeoutMinutes
        : DEFAULT_PREFERENCES.idleTimeoutMinutes,
    incognito:
      stored.incognito === "share" || stored.incognito === "pause"
        ? stored.incognito
        : DEFAULT_PREFERENCES.incognito,
    platforms: {
      discord: flag(platforms.discord, DEFAULT_PREFERENCES.platforms.discord),
      fluxer: flag(platforms.fluxer, DEFAULT_PREFERENCES.platforms.fluxer),
      stoat: flag(platforms.stoat, DEFAULT_PREFERENCES.platforms.stoat),
    },
    discordRpcExtension: flag(stored.discordRpcExtension, DEFAULT_PREFERENCES.discordRpcExtension),
    malSync: flag(stored.malSync, DEFAULT_PREFERENCES.malSync),
    pageData: {
      media: flag(pageData.media, DEFAULT_PREFERENCES.pageData.media),
      thumbnails: flag(pageData.thumbnails, DEFAULT_PREFERENCES.pageData.thumbnails),
      creatorIcons: flag(pageData.creatorIcons, DEFAULT_PREFERENCES.pageData.creatorIcons),
    },
  };
}

/** The next idle timeout step up or down, stopping at either end. */
export function stepIdleTimeout(current: number, direction: 1 | -1): number {
  const index = IDLE_TIMEOUT_STEPS.indexOf(current);
  const next = Math.min(Math.max(index + direction, 0), IDLE_TIMEOUT_STEPS.length - 1);
  return IDLE_TIMEOUT_STEPS[next] ?? DEFAULT_PREFERENCES.idleTimeoutMinutes;
}

export function formatIdleTimeout(minutes: number): string {
  return minutes === 0 ? t("Off") : minutes === 60 ? t("1 h") : t("{n} min", { n: minutes });
}

/**
 * What may be shared of `activity` under `preferences`, from a tab that may
 * be private. Without media details: the Activity's own name (`ownName`: an
 * Activity may set one from the page, like a song's title), link, and images
 * only (no captions, detail or state links, links on the images, buttons,
 * party, or choice of status line, which describe the media too). Its type
 * stays: "Watching" says nothing about what.
 */
export function applyPreferences(
  activity: Activity | null,
  preferences: Preferences,
  incognito = false,
  ownName?: string,
): Activity | null {
  if (!activity || (incognito && preferences.incognito === "pause")) return null;
  if (preferences.shareMediaDetails) return activity;
  const {
    name,
    details: _details,
    state: _state,
    detailsUrl: _detailsUrl,
    stateUrl: _stateUrl,
    buttons: _buttons,
    statusDisplayType: _statusDisplayType,
    party: _party,
    assets,
    ...rest
  } = activity;
  const images = assets && { largeImage: assets.largeImage, smallImage: assets.smallImage };
  const shared = { ...rest, name: ownName ?? name };
  return images ? { ...shared, assets: images } : shared;
}

/** The platforms turned on in Settings > Platforms, for Desktop. */
export function enabledPlatforms(preferences: Preferences): PlatformId[] {
  return PLATFORM_IDS.filter((id) => preferences.platforms[id]);
}

/** The slice of `chrome.storage.local` this needs; tests pass a fake. */
export interface PreferenceArea {
  get(key: string): Promise<Json>;
  set(items: Json): Promise<void>;
}

export async function loadPreferences(
  area: PreferenceArea = chrome.storage.local,
): Promise<Preferences> {
  return parsePreferences((await area.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function savePreferences(
  patch: Partial<Preferences>,
  area: PreferenceArea = chrome.storage.local,
): Promise<Preferences> {
  const next = parsePreferences({ ...(await loadPreferences(area)), ...patch });
  await area.set({ [STORAGE_KEY]: next });
  return next;
}

/** Calls `listener` with the new values whenever any view or the background saves them. */
export function watchPreferences(listener: (preferences: Preferences) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[STORAGE_KEY];
    if (area === "local" && change) listener(parsePreferences(change.newValue));
  });
}
