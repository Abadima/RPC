import type { PreferenceArea } from "../core/preferences";

/**
 * The popup and dashboard's theme, chosen in Settings > Appearance. It has
 * its own storage key, apart from Preferences, because the background redoes
 * its presence work on every Preferences change and a theme is only for the
 * views. A copy in localStorage lets theme.js (in each page's <head>) draw
 * the right theme before any async read could return; storage stays the
 * source of truth, since a browser can clear an extension's localStorage.
 */
export const THEME_IDS = ["atelier", "botanique", "monolith"] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "atelier";

const STORAGE_KEY = "theme";
const HINT_KEY = "parousia-theme";

/** A stored or cached value, which may be anything; unknown ones mean the default. */
export function parseTheme(value: unknown): ThemeId {
  return THEME_IDS.find((id) => id === value) ?? DEFAULT_THEME;
}

export async function loadTheme(area: PreferenceArea = chrome.storage.local): Promise<ThemeId> {
  return parseTheme((await area.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function saveTheme(
  theme: ThemeId,
  area: PreferenceArea = chrome.storage.local,
): Promise<void> {
  await area.set({ [STORAGE_KEY]: parseTheme(theme) });
}

/** Calls `listener` whenever any view saves a theme; returns a function that stops it. */
export function watchTheme(listener: (theme: ThemeId) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const change = changes[STORAGE_KEY];
    if (area === "local" && change) listener(parseTheme(change.newValue));
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}

/** The slice of localStorage the hint needs; tests pass a fake. */
export interface HintStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage, or `null` where the browser blocks it (reading the property can throw). */
function hintStore(): HintStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The theme last applied in any view, read synchronously; the default if missing or blocked. */
export function readThemeHint(store: HintStore | null = hintStore()): ThemeId {
  try {
    return parseTheme(store?.getItem(HINT_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Themes `root` (normally <html>) and remembers the choice for the next first paint. */
export function applyTheme(
  theme: ThemeId,
  root: { dataset: DOMStringMap } = document.documentElement,
  store: HintStore | null = hintStore(),
): void {
  const id = parseTheme(theme);
  if (root.dataset.theme !== id) root.dataset.theme = id;
  try {
    store?.setItem(HINT_KEY, id);
  } catch {
    // Blocked or full: the next page opens in the default theme until storage answers.
  }
}
