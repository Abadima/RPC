import type {
  Activity,
  ActivityInfo,
  ActivitySource,
  PageDataKind,
  SettingValue,
} from "../core/activity";
import { matchPatterns } from "../core/match-pattern";
import type { PageMedia, RegisteredActivity, SettingValues } from "../core/registry";

/**
 * One Activity, from either source, as the build normalized it
 * (scripts/activities/): what the dashboard lists (`info`), how it recognizes
 * its pages (`match`), and, for PreMiD's, the script it runs in them. Native
 * and PreMiD Activities go through the same discovery, catalog, matching,
 * settings, and site access; only how each turns a page into an Activity
 * differs, and that's the one place they're told apart.
 */
export interface ActivityManifest {
  info: ActivityInfo;
  match: ActivityMatch;
  /** A PreMiD Activity's script, which runs in its pages. */
  script?: PageScript;
}

/**
 * Match patterns (a native Activity's `matches`), or a regular expression
 * over the whole URL (a PreMiD Activity's `regExp`).
 */
export type ActivityMatch = { patterns: string[] } | { regExp: string };

export interface PageScript {
  /** Packaged as `activities/premid/<file>.js`, and `<file>.iframe.js` for iframes. */
  file: string;
  /** Present when it has an iframe script: the iframes it runs in (`iFrameRegExp`), or `null` for any. */
  iframe?: { regExp: string | null };
  /** Every Discord Application its source names; the first is its default. */
  clientIds: string[];
  /** Settings with no choice here: its language picker, since Parousia shows PreMiD's strings in English. */
  fixed?: Record<string, SettingValue>;
}

/** What a native Activity's `detect` sees (Activity API version 1, `src/core/api.ts`). */
export interface NativePage {
  readonly url: URL;
  readonly title: string;
  /** The page data kinds it has on this page: declared, not switched off, and the site granted. */
  readonly granted: readonly PageDataKind[];
  /** With `media` granted: what's playing, when the page says. */
  readonly media?: PageMedia;
  /** With `thumbnails` granted: an image of what's shown, when the page has one. */
  readonly thumbnail?: string;
}

/** What a native Activity's `activity.ts` exports as its default. */
export interface NativeModule {
  detect(page: NativePage, settings: SettingValues): Activity | null;
}

/** Longer URLs aren't tested, so no pattern can be made to run long. */
const MAX_URL = 2048;

export function compileMatch(match: ActivityMatch): (url: URL) => boolean {
  if ("patterns" in match) return matchPatterns(match.patterns);
  const pattern = new RegExp(match.regExp);
  return (url) => url.href.length <= MAX_URL && pattern.test(url.href);
}

/**
 * An Activity for the registry. A native one runs its `detect` on the URL and
 * title (and the page data it's granted); a PreMiD one shows what its script
 * in the page reported. Where an Activity that reads pages has no access, the
 * runtime doesn't reach it at all (see `canRun`).
 */
export function registered(manifest: ActivityManifest, module?: NativeModule): RegisteredActivity {
  const { info } = manifest;
  const matcher = compileMatch(manifest.match);
  if (module) {
    return {
      info,
      matcher,
      detect: (page, settings) => {
        const activity = module.detect(
          {
            url: page.url,
            title: page.title,
            granted: page.granted ?? [],
            ...(page.data?.media && { media: page.data.media }),
            ...(page.data?.thumbnail && { thumbnail: page.data.thumbnail }),
          },
          settings,
        );
        return activity && { ...activity, id: info.id };
      },
    };
  }
  return {
    info,
    matcher,
    detect: (page) => (page.reported?.id === info.id ? page.reported : null),
  };
}

// The packaged files (the build writes them; see scripts/activities/build.ts).

/**
 * Every Activity's catalog entry, both sources, for the dashboard's list:
 * what it shows, searches, and needs to turn one on (`catalogEntry`). The
 * rest (settings, page data, Discord Applications) is in each manifest.
 */
export const CATALOG_PATH = "activities/catalog.json";
/**
 * Which file each Activity's manifest is in, by id (`premid/<name>`,
 * `native/<id>`), so the background reads only the PreMiD ones that are on,
 * and a page reads only the one it shows.
 */
export const INDEX_PATH = "activities/index.json";
/** Which Activities cover each site (their manifests' files), by host name, for the popup to find the one for a tab. */
export const HOSTS_PATH = "activities/hosts.json";
/** Parousia's page-data collector, for native Activities that take page data. */
export const COLLECTOR_PATH = "activities/collector.js";
/** PreMiD's API in the page, injected before each PreMiD Activity's script. */
export const PREMID_RUNTIME_PATH = "activities/premid/runtime.js";
export const manifestPath = (file: string): string => `activities/${file}.json`;
export const premidFile = (name: string): string => `premid/${name}`;
export const nativeFile = (id: string): string => `native/${id}`;

/** An Activity as the catalog lists it: everything but what only its own page needs. */
export function catalogEntry(info: ActivityInfo): ActivityInfo {
  const { settings: _settings, data: _data, discordClientId: _discordClientId, ...entry } = info;
  return entry;
}

export function scriptPaths(script: PageScript): { page: string[]; frame: string[] } {
  return {
    page: [PREMID_RUNTIME_PATH, `activities/premid/${script.file}.js`],
    frame: script.iframe ? [PREMID_RUNTIME_PATH, `activities/premid/${script.file}.iframe.js`] : [],
  };
}

/**
 * Where `activities/premid/runtime.js` leaves its bridge, in the
 * content-script world (pages can't see it), for each wrapped PreMiD
 * Activity script to `bind` to.
 */
export const BRIDGE_KEY = "__parousiaPreMiD";

/** Every PreMiD Activity's id is its service name under this prefix: `premid:YouTube`. */
export const PREMID_ID_PREFIX = "premid:";
export const premidId = (service: string): string => `${PREMID_ID_PREFIX}${service}`;

export interface Catalog {
  /** The revision of each source the build used (its `main` when fetched), for debugging, not a pin. */
  sources: Record<string, string>;
  activities: ActivityInfo[];
}

export interface CatalogIndex {
  files: Record<string, string>;
}

export interface HostIndex {
  /** Host name (`www.youtube.com`, or `example.com` for a pattern's every subdomain) to manifest files. */
  hosts: Record<string, string[]>;
}

// Reading packaged files back: they're this build's own output, but the
// shape is checked anyway, and anything without it is skipped.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SOURCES: ReadonlySet<unknown> = new Set<ActivitySource>(["parousia", "premid"]);

const isInfo = (value: unknown): value is ActivityInfo =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  SOURCES.has(value.source) &&
  Array.isArray(value.hosts);

export function parseCatalog(value: unknown): Catalog {
  const sources: Record<string, string> = {};
  if (isObject(value) && isObject(value.sources)) {
    for (const [name, commit] of Object.entries(value.sources)) {
      if (typeof commit === "string") sources[name] = commit;
    }
  }
  const activities =
    isObject(value) && Array.isArray(value.activities) ? value.activities.filter(isInfo) : [];
  return { sources, activities };
}

const FILE = /^(premid|native)\/[a-z0-9-]+$/;
const isFile = (value: unknown): value is string => typeof value === "string" && FILE.test(value);

export function parseIndex(value: unknown): CatalogIndex {
  const files: Record<string, string> = {};
  if (isObject(value) && isObject(value.files)) {
    for (const [id, file] of Object.entries(value.files)) {
      if (isFile(file)) files[id] = file;
    }
  }
  return { files };
}

export function parseHosts(value: unknown): HostIndex {
  const hosts: Record<string, string[]> = {};
  if (isObject(value) && isObject(value.hosts)) {
    for (const [host, files] of Object.entries(value.hosts)) {
      if (Array.isArray(files)) hosts[host] = files.filter(isFile);
    }
  }
  return { hosts };
}

/** The keys of a host index that can cover `hostname`: itself, then each parent domain. */
export function hostKeys(hostname: string): string[] {
  const labels = hostname.split(".");
  const keys = labels.map((_, i) => labels.slice(i).join("."));
  // A top-level domain alone covers nothing.
  return keys.length > 1 ? keys.slice(0, -1) : keys;
}

function parseScript(value: unknown): PageScript | null {
  if (!isObject(value) || typeof value.file !== "string") return null;
  const clientIds = Array.isArray(value.clientIds)
    ? value.clientIds.filter((id): id is string => typeof id === "string")
    : [];
  if (clientIds.length === 0) return null;
  const script: PageScript = { file: value.file, clientIds };
  if (isObject(value.iframe)) {
    script.iframe = {
      regExp: typeof value.iframe.regExp === "string" ? value.iframe.regExp : null,
    };
  }
  if (isObject(value.fixed)) {
    const fixed: Record<string, SettingValue> = {};
    for (const [id, setting] of Object.entries(value.fixed)) {
      if (
        typeof setting === "string" ||
        typeof setting === "number" ||
        typeof setting === "boolean"
      ) {
        fixed[id] = setting;
      }
    }
    script.fixed = fixed;
  }
  return script;
}

export function parseManifest(value: unknown): ActivityManifest | null {
  if (!isObject(value) || !isInfo(value.info) || !isObject(value.match)) return null;
  const { patterns, regExp } = value.match;
  let match: ActivityMatch;
  if (Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string")) {
    match = { patterns };
  } else if (typeof regExp === "string") {
    match = { regExp };
  } else {
    return null;
  }
  const manifest: ActivityManifest = { info: value.info, match };
  if (value.script !== undefined) {
    const script = parseScript(value.script);
    if (!script) return null;
    manifest.script = script;
  }
  return manifest;
}
