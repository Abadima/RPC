import {
  CATALOG_PATH,
  HOSTS_PATH,
  INDEX_PATH,
  compileMatch,
  hostKeys,
  manifestPath,
  parseCatalog,
  parseHosts,
  parseIndex,
  parseManifest,
  type ActivityManifest,
} from "../activities/manifest";
import type { ActivityInfo } from "../core/activity";
import {
  chosenVariant,
  isActivityOn,
  loadActivityStates,
  needsAccess,
  saveActivityState,
  saveActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import {
  ALL_SITES,
  grantsFrom,
  missingSites,
  pageGranted,
  siteAccess,
  type Grants,
} from "../core/site-access";

async function fetchJson(path: string): Promise<unknown> {
  try {
    const response = await fetch(chrome.runtime.getURL(path));
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Every Activity this build includes, native and PreMiD's, as the catalog lists them. */
export async function loadCatalog(): Promise<ActivityInfo[]> {
  return parseCatalog(await fetchJson(CATALOG_PATH)).activities;
}

let index: Promise<Record<string, string>> | null = null;

async function loadManifest(file: string): Promise<ActivityManifest | null> {
  return parseManifest(await fetchJson(manifestPath(file)));
}

/** One Activity's full entry (its settings too), from its own manifest. */
export async function loadActivityInfo(id: string): Promise<ActivityInfo | null> {
  index ??= fetchJson(INDEX_PATH).then((value) => parseIndex(value).files);
  const file = (await index)[id];
  const manifest = file ? await loadManifest(file) : null;
  return manifest?.info.id === id ? manifest.info : null;
}

/**
 * The Activity for a page, turned on or not, as the popup offers it: the
 * implementation of its website that's chosen, found through the host
 * index and confirmed by its own matcher.
 */
export async function findActivity(url: URL, states: ActivityStates): Promise<ActivityInfo | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hosts = parseHosts(await fetchJson(HOSTS_PATH)).hosts;
  const files = [...new Set(hostKeys(url.hostname).flatMap((key) => hosts[key] ?? []))];
  for (const file of files) {
    const manifest = await loadManifest(file);
    if (!manifest) continue;
    let matches = false;
    try {
      matches = compileMatch(manifest.match)(url);
    } catch {
      // A pattern this browser can't compile matches nothing.
    }
    if (!matches) continue;
    const chosen = chosenVariant(manifest.info, states);
    return chosen === manifest.info.id ? manifest.info : loadActivityInfo(chosen);
  }
  return null;
}

/**
 * Where an Activity stands for someone looking at it: off, on and running,
 * or on but missing access to some or all of its sites (taken back, or never
 * granted), where it's unavailable.
 */
export type ActivityStatus = "off" | "on" | "needs-access";

export function activityStatus(
  info: ActivityInfo,
  states: ActivityStates,
  grants: Grants,
  url?: URL,
): ActivityStatus {
  if (!isActivityOn(info, states)) return "off";
  if (!needsAccess(info)) return "on";
  const granted = url ? pageGranted(url, grants) : siteAccess(info, grants) === "all";
  return granted ? "on" : "needs-access";
}

// Every call that asks the browser for access must run straight from a
// click, before anything else is awaited, or the browser won't ask.

/** The sites granted now. */
export async function readGrants(): Promise<Grants> {
  return grantsFrom(await chrome.permissions.getAll());
}

/** Calls `listener` whenever site access is granted or taken back, anywhere. Returns a function that stops it. */
export function watchGrants(listener: () => void): () => void {
  chrome.permissions.onAdded.addListener(listener);
  chrome.permissions.onRemoved.addListener(listener);
  return () => {
    chrome.permissions.onAdded.removeListener(listener);
    chrome.permissions.onRemoved.removeListener(listener);
  };
}

function requestSites(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return Promise.resolve(true);
  return chrome.permissions.request({ permissions: ["scripting"], origins }).catch(() => false);
}

/**
 * "Access your data for all websites": off by default, and only ever asked
 * for by its own switch. Turning it off leaves `scripting` for any site
 * still granted on its own.
 */
export function setAllSites(on: boolean): Promise<boolean> {
  return on
    ? requestSites([ALL_SITES])
    : chrome.permissions.remove({ origins: [ALL_SITES] }).catch(() => false);
}

/**
 * Turns an Activity on. One that reads pages asks for the sites it doesn't
 * have yet, in the same click, and is saved as on right away: a popup the
 * browser's prompt closes (Firefox's) still leaves the choice made, and the
 * Activity shows as needing access if the prompt was declined. Where the
 * answer arrives, a refusal turns it back off. Resolves whether it's on and
 * has its sites.
 */
export function turnOn(info: ActivityInfo, grants: Grants): Promise<boolean> {
  const granted = requestSites(missingSites(info, grants));
  const saved = saveActivityState(info.id, { on: true });
  return Promise.all([granted, saved]).then(
    async ([ok]) => {
      if (!ok) await saveActivityState(info.id, { on: false });
      return ok;
    },
    () => false,
  );
}

/** Asks again for the sites an Activity that's on is missing (declined, or taken back). */
export function requestAccess(info: ActivityInfo, grants: Grants): Promise<boolean> {
  return requestSites(missingSites(info, grants));
}

/**
 * Gives back the sites `released` had that no Activity still on needs, and
 * `scripting` once nothing does.
 */
async function releaseSites(
  released: readonly ActivityInfo[],
  catalog: readonly ActivityInfo[],
  states: ActivityStates,
  grants: Grants,
): Promise<void> {
  if (!released.some((info) => info.origins)) return;
  const gone = new Set(released.map((info) => info.id));
  const stillOn = catalog.filter(
    (other) => !gone.has(other.id) && needsAccess(other) && isActivityOn(other, states),
  );
  const kept = new Set(stillOn.flatMap((other) => other.origins ?? []));
  const origins = [...new Set(released.flatMap((info) => info.origins ?? []))].filter(
    (origin) => !kept.has(origin),
  );
  const permissions: chrome.runtime.ManifestPermission[] =
    grants.all || stillOn.length > 0 ? [] : ["scripting"];
  if (origins.length > 0 || permissions.length > 0) {
    await chrome.permissions.remove({ origins, permissions }).catch(() => false);
  }
}

/** Turns an Activity off, and gives back the sites only it needed. */
export async function turnOff(
  info: ActivityInfo,
  catalog: readonly ActivityInfo[],
  grants: Grants,
): Promise<ActivityStates> {
  const states = await saveActivityState(info.id, { on: false });
  await releaseSites([info], catalog, states, grants);
  return states;
}

/**
 * Makes `chosen` the implementation of its website that runs, on if the
 * website was on (or `on` says so). Turning it on asks for its sites in the
 * same click, one prompt for both steps, and the old one's sites go back; if
 * that's declined, nothing changes. Resolves whether it's chosen.
 */
export function chooseVariant(
  chosen: ActivityInfo,
  catalog: readonly ActivityInfo[],
  states: ActivityStates,
  grants: Grants,
  on?: boolean,
): Promise<boolean> {
  const [first] = chosen.variants ?? [];
  if (first === undefined) return Promise.resolve(false);
  const previous = catalog.find((info) => info.id === chosenVariant(chosen, states));
  const turnOnToo = on ?? (previous !== undefined && isActivityOn(previous, states));
  const granted = requestSites(turnOnToo ? missingSites(chosen, grants) : []);
  return granted.then(
    async (ok) => {
      if (!ok) return false;
      if (turnOnToo) await saveActivityState(chosen.id, { on: true });
      const next = await saveActivityState(first, { use: chosen.id });
      if (previous && previous.id !== chosen.id)
        await releaseSites([previous], catalog, next, grants);
      return true;
    },
    () => false,
  );
}

/** The catalog as the dashboard lists it: each website once, as the implementation chosen for it. */
export function listed(catalog: readonly ActivityInfo[], states: ActivityStates): ActivityInfo[] {
  return catalog.filter((info) => chosenVariant(info, states) === info.id);
}

/** What "Enable all" and "Disable all" would do to a set of Activities. */
export interface BulkPlan {
  /** Off, or on but missing sites: what "Enable all" turns on, or asks for again. */
  enable: ActivityInfo[];
  /** On: what "Disable all" turns off. */
  disable: ActivityInfo[];
  /** The sites "Enable all" asks the browser for, in one request. */
  sites: string[];
}

export function bulkPlan(
  targets: readonly ActivityInfo[],
  states: ActivityStates,
  grants: Grants,
): BulkPlan {
  const enable = targets.filter((info) => activityStatus(info, states, grants) !== "on");
  return {
    enable,
    disable: targets.filter((info) => isActivityOn(info, states)),
    sites: [...new Set(enable.flatMap((info) => missingSites(info, grants)))],
  };
}

export interface BulkResult {
  /** Activities now on. */
  changed: number;
  /** The Activities that stayed off (or unavailable) because their sites weren't granted. */
  declined: string[];
}

/**
 * Turns on every Activity in `plan.enable`. All the sites they need are
 * asked for in one request, made before anything is awaited (so the click
 * that called this still counts) and only for what isn't granted yet. The
 * browser answers for the whole request, so a refusal leaves off every
 * Activity that needed it; those that need nothing new are turned on either
 * way. Nothing is marked on for a site the browser didn't grant: after an
 * answer, the grants are read back rather than trusted.
 */
export function enableAll(plan: BulkPlan, grants: Grants): Promise<BulkResult> {
  return requestSites(plan.sites).then(async (ok) => {
    const now = ok && plan.sites.length > 0 ? await readGrants() : grants;
    const turnOn = plan.enable.filter((info) => missingSites(info, now).length === 0);
    await saveActivityStates(Object.fromEntries(turnOn.map((info) => [info.id, { on: true }])));
    const done = new Set(turnOn);
    const left = plan.enable.filter((info) => !done.has(info));
    return { changed: turnOn.length, declined: left.map((info) => info.id) };
  });
}

/**
 * Turns off every Activity in `targets` that's on, in one write, and gives
 * back the sites only they needed. Resolves how many it turned off.
 */
export async function disableAll(
  targets: readonly ActivityInfo[],
  catalog: readonly ActivityInfo[],
  grants: Grants,
): Promise<number> {
  const before = await loadActivityStates();
  const active = targets.filter((info) => isActivityOn(info, before));
  if (active.length === 0) return 0;
  const states = await saveActivityStates(
    Object.fromEntries(active.map((info) => [info.id, { on: false }])),
  );
  await releaseSites(active, catalog, states, grants);
  return active.length;
}
