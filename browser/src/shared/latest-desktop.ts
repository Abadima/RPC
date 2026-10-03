import type { PreferenceArea } from "../core/preferences";
import { parseRelease } from "../core/version";

/**
 * The newest Parousia Desktop there is, from GitHub's latest release. Desktop
 * and the extension version on their own, so the release's tag is not
 * Desktop's: the release workflow puts Desktop's version in the notes as
 * `<!-- parousia-desktop: 1.0.1 -->`, which is what's read here.
 *
 * The only request the extension makes to anyone but the computer it runs on,
 * and only from a popup or dashboard that is about to say "update Desktop".
 * It is unauthenticated and carries no cookies, referrer, or identifier. The
 * answer is kept for a day (an hour after a failure), so a user makes about one
 * a day at most.
 */
export const RELEASES_API = "https://api.github.com/repos/Abadima/RPC/releases/latest";

const STORAGE_KEY = "latestDesktop";
const FRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
/** A release's notes are a few KB; anything much bigger isn't one. */
const MAX_CHARS = 200_000;
const MARKER = /<!--\s*parousia-desktop:\s*(\d{1,9}\.\d{1,9}\.\d{1,9})\s*-->/;

/** The Desktop version a latest-release response names, or `null` for anything else. Untrusted text. */
export function parseLatestRelease(text: string): string | null {
  if (text.length > MAX_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const body: unknown = Reflect.get(value, "body");
  if (typeof body !== "string") return null;
  const version = MARKER.exec(body)?.[1];
  return version && parseRelease(version) ? version : null;
}

interface Remembered {
  version: string | null;
  at: number;
}

function parseRemembered(value: unknown): Remembered | null {
  if (typeof value !== "object" || value === null) return null;
  const version: unknown = Reflect.get(value, "version");
  const at: unknown = Reflect.get(value, "at");
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (version === null) return { version: null, at };
  return typeof version === "string" && parseRelease(version) ? { version, at } : null;
}

export interface LatestDesktopOptions {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  area?: PreferenceArea;
  now?: () => number;
}

/** The newest Desktop version, or `null` when it can't be told (offline, rate limited, no such note). */
export async function latestDesktopVersion({
  fetcher = (url, init) => fetch(url, init),
  area = chrome.storage.local,
  now = Date.now,
}: LatestDesktopOptions = {}): Promise<string | null> {
  const current = now();
  let remembered: Remembered | null = null;
  try {
    remembered = parseRemembered((await area.get(STORAGE_KEY))[STORAGE_KEY]);
  } catch {
    // No cache: ask.
  }
  if (remembered && current - remembered.at >= 0) {
    const age = current - remembered.at;
    if (age < (remembered.version === null ? RETRY_MS : FRESH_MS)) return remembered.version;
  }

  let version: string | null = null;
  try {
    const response = await fetcher(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (response.ok) version = parseLatestRelease(await response.text());
  } catch {
    // Offline or blocked: no answer, and no banner.
  }
  try {
    await area.set({ [STORAGE_KEY]: { version, at: current } });
  } catch {
    // The answer still stands without a cache.
  }
  return version;
}
