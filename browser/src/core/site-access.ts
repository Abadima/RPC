import type { ActivityInfo } from "./activity";
import { needsAccess } from "./activity-state";

/**
 * Which sites Parousia may read pages on: the browser's own record of
 * granted host access (`permissions.getAll()`), read into one shape. Every
 * site is granted explicitly, one by one when an Activity is turned on or
 * from its page, or all at once through "Access your data for all
 * websites", which is off by default and only ever asked for by that switch.
 */
export const ALL_SITES = "*://*/*";

export interface Grants {
  /** "Access your data for all websites" is on. */
  all: boolean;
  /** Each site granted on its own, as origin patterns (`*://www.youtube.com/*`). */
  origins: readonly string[];
}

export const NO_GRANTS: Grants = { all: false, origins: [] };

const PATTERN = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)\/.*$/;

/**
 * The browser's granted permissions as `Grants`. Only `ALL_SITES` (or
 * `<all_urls>`) is every website; a grant of every `https` site is kept as a
 * pattern, since it doesn't cover `http` pages.
 */
export function grantsFrom(permissions: { origins?: string[] }): Grants {
  const origins = permissions.origins ?? [];
  const all = origins.some((origin) => origin === ALL_SITES || origin === "<all_urls>");
  return { all, origins: origins.filter((origin) => PATTERN.test(origin) && origin !== ALL_SITES) };
}

/** Whether `grant` covers `origin` (both origin patterns): its scheme and host, ignoring the path. */
export function covers(grant: string, origin: string): boolean {
  const g = PATTERN.exec(grant);
  const o = PATTERN.exec(origin);
  if (!g || !o) return false;
  const [, grantScheme = "", grantHost = ""] = g;
  const [, scheme = "", host = ""] = o;
  const schemeOk = grantScheme === "*" ? true : grantScheme === scheme;
  if (!schemeOk) return false;
  if (grantHost === "*") return true;
  if (grantHost.startsWith("*.")) {
    const domain = grantHost.slice(2);
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    return bare === domain || bare.endsWith(`.${domain}`);
  }
  return grantHost === host;
}

/** Whether Parousia may read pages at `origin`, a site's origin pattern. */
export function siteGranted(origin: string, grants: Grants): boolean {
  return grants.all || grants.origins.some((grant) => covers(grant, origin));
}

/** Whether Parousia may read the page at `url`. */
export function pageGranted(url: URL, grants: Grants): boolean {
  return siteGranted(`${url.protocol.slice(0, -1)}://${url.hostname}/*`, grants);
}

/**
 * Whether `info` can run at `url`: it reads only URLs and titles, or the
 * site was granted. Without access an Activity that reads pages is
 * unavailable there, rather than showing less.
 */
export function canRun(info: ActivityInfo, url: URL, grants: Grants): boolean {
  return !needsAccess(info) || pageGranted(url, grants);
}

/** The sites `info` reads that aren't granted, to ask for. */
export function missingSites(info: ActivityInfo, grants: Grants): string[] {
  return (info.origins ?? []).filter((origin) => !siteGranted(origin, grants));
}

/**
 * How much of what `info` reads it has access to: every site it needs,
 * some, none, or it needs none (it reads only URLs and titles).
 */
export type SiteAccess = "all" | "some" | "none" | "unneeded";

export function siteAccess(info: ActivityInfo, grants: Grants): SiteAccess {
  const origins = info.origins ?? [];
  if (origins.length === 0) return "unneeded";
  const granted = origins.filter((origin) => siteGranted(origin, grants)).length;
  return granted === origins.length ? "all" : granted > 0 ? "some" : "none";
}

/** The site an origin pattern names: `*://www.youtube.com/*` is `www.youtube.com`. */
export function siteName(origin: string): string {
  return /^[^:]+:\/\/([^/]+)\//.exec(origin)?.[1]?.replace(/^\*\./, "") ?? origin;
}
