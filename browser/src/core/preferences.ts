import type { Activity } from "./activity";

/**
 * The extension's own settings, kept in `chrome.storage.local` so the
 * background script and every open view read the same values. Desktop's
 * settings (the allowlist, userscripts) live in Desktop, not here.
 */
export type IncognitoBehavior = "pause" | "share";
export type PlatformId = "discord" | "fluxer" | "stoat";
export type Language = "en";

export interface Preferences {
  language: Language;
  /** Off: publish only the Activity's name, never its details, state, or image captions. */
  shareMediaDetails: boolean;
  /** How long presence stays after the browser loses focus; 0 clears it at once. */
  idleTimeoutMinutes: number;
  incognito: IncognitoBehavior;
  /** Which platforms should show presence, for Parousia Desktop's adapters. */
  platforms: Record<PlatformId, boolean>;
  /** Also show Discord presence through Discord-RPC-Extension's app, when it's running. */
  discordRpcExtension: boolean;
}

export const PLATFORM_IDS: readonly PlatformId[] = ["discord", "fluxer", "stoat"];
export const IDLE_TIMEOUT_STEPS: readonly number[] = [0, 1, 2, 5, 10, 15, 30, 60];

export const DEFAULT_PREFERENCES: Preferences = {
  language: "en",
  shareMediaDetails: true,
  idleTimeoutMinutes: 0,
  incognito: "pause",
  platforms: { discord: true, fluxer: true, stoat: true },
  discordRpcExtension: true,
};

const STORAGE_KEY = "preferences";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;

/** Anything stored that isn't a valid value falls back to its default, field by field. */
export function parsePreferences(value: unknown): Preferences {
  const stored = isObject(value) ? value : {};
  const platforms = isObject(stored.platforms) ? stored.platforms : {};
  const flag = (candidate: unknown, fallback: boolean): boolean =>
    typeof candidate === "boolean" ? candidate : fallback;
  return {
    language: "en",
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
  };
}

/** The next idle timeout step up or down, stopping at either end. */
export function stepIdleTimeout(current: number, direction: 1 | -1): number {
  const index = IDLE_TIMEOUT_STEPS.indexOf(current);
  const next = Math.min(Math.max(index + direction, 0), IDLE_TIMEOUT_STEPS.length - 1);
  return IDLE_TIMEOUT_STEPS[next] ?? DEFAULT_PREFERENCES.idleTimeoutMinutes;
}

export function formatIdleTimeout(minutes: number): string {
  return minutes === 0 ? "Off" : minutes === 60 ? "1 h" : `${minutes} min`;
}

/** What may be shared of `activity` under `preferences`, from a tab that may be private. */
export function applyPreferences(
  activity: Activity | null,
  preferences: Preferences,
  incognito = false,
): Activity | null {
  if (!activity || (incognito && preferences.incognito === "pause")) return null;
  if (preferences.shareMediaDetails) return activity;
  const { details: _details, state: _state, assets, ...rest } = activity;
  const images = assets && { largeImage: assets.largeImage, smallImage: assets.smallImage };
  return images ? { ...rest, assets: images } : rest;
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
