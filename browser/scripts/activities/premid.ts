import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { PAGE_DATA_KINDS, type ActivitySetting, type SettingValue } from "../../src/core/activity";
import { LANGUAGES, type Language } from "../../src/core/i18n";
import {
  BRIDGE_KEY,
  descriptionsPath,
  premidId,
  type ActivityManifest,
  type PageScript,
} from "../../src/activities/manifest";
import { activityId, type WebsiteFolder } from "./discover";
import {
  CLIENT_ID,
  LIMITS,
  checkSetting,
  hostOrigin,
  keywordsFrom,
  manifestFrom,
} from "./metadata";

/**
 * The adapter for PreMiD's Activities (github.com/PreMiD/Activities), read the
 * way PreMiD's own tooling reads them (cli/src/util/getActivities.ts): a
 * website's folder holds a metadata.json, a presence.ts, and, for Activities
 * that read iframes, an iframe.ts, or one `v<n>/` folder of those per API
 * version. Each one that fits becomes the same manifest a native Activity
 * does, plus its script, compiled for the extension's package; the rest are
 * listed with the reason they were left out.
 */

export interface Exclusion {
  service: string;
  reason: string;
}

export interface PremidFound {
  /** Its website, as the folder's id: the same website in Parousia's repository has the same one. */
  site: string;
  /** Its script's `file` is set when it's compiled. */
  manifest: ActivityManifest & { script: PageScript };
  /** The folder its sources are in: the website's, or its `v1/`. */
  dir: string;
  /** Its own English strings (`<service>.json`), by key, for `getStrings`. */
  strings: Record<string, string>;
  /** Its description in each language Parousia's views have besides English, where PreMiD's metadata.json has one. */
  descriptions: Partial<Record<Language, string>>;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

/** metadata.json's `url` pattern (schemas.premid.app/metadata/1.17). */
const HOST = /^(([a-z0-9-]+\.)*[0-9a-z_-]+(\.[a-z]+)+|(\d{1,3}\.){3}\d{1,3}|localhost)$/;
/** Parousia shows PreMiD's strings in English, so an Activity's language picker has one answer. */
const LANGUAGE = "en";

/**
 * Every Discord Application an Activity's sources name, the default (the
 * first in presence.ts) first. The same rules as PreMiD's own check
 * (cli/src/classes/AssetsManager.ts, `getClientIds`): `clientId: '<id>'`,
 * and every member of an enum referenced as `clientId: Enum.Member`.
 */
export function extractClientIds(sources: readonly string[]): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (id && CLIENT_ID.test(id) && !ids.includes(id)) ids.push(id);
  };
  for (const source of sources) {
    for (const match of source.matchAll(/clientId\s*:\s*['"`](\d+)['"`]/g)) add(match[1]);
    const enums = new Set(
      [...source.matchAll(/clientId\s*:\s*(\w+)\.\w+/g)].map((match) => match[1]),
    );
    for (const name of enums) {
      const declaration = new RegExp(`enum\\s+${name}\\s*\\{[^}]*\\}`).exec(source);
      for (const member of declaration?.[0].matchAll(/['"](\d+)['"]/g) ?? []) add(member[1]);
    }
  }
  return ids;
}

/**
 * PreMiD settings (metadata.json `settings`) as Parousia's: `value` alone is
 * a switch, text, or number by its type; `values` makes a choice, whose value
 * is the chosen index (PreMiD's `getSetting` answers the same); `if` is
 * `when`. A `multiLanguage` language picker has no choice here: it's fixed.
 */
export function mapPremidSettings(value: unknown): {
  settings: ActivitySetting[];
  fixed: Record<string, SettingValue>;
} {
  const settings: ActivitySetting[] = [];
  const fixed: Record<string, SettingValue> = {};
  if (!Array.isArray(value)) return { settings, fixed };
  for (const raw of value) {
    if (!isObject(raw) || !isString(raw.id) || raw.id.length > 64) continue;
    if (raw.multiLanguage === true) {
      fixed[raw.id] = LANGUAGE;
      continue;
    }
    if (!isString(raw.title) || !raw.title.trim()) continue;
    const setting: ActivitySetting = {
      id: raw.id,
      title: raw.title.slice(0, 64),
      type: "boolean",
      default: false,
    };
    if (isString(raw.description) && raw.description.trim())
      setting.description = raw.description.slice(0, 256);
    if (isString(raw.placeholder) && raw.placeholder.trim())
      setting.placeholder = raw.placeholder.slice(0, 128);

    if (Array.isArray(raw.values) && raw.values.length > 0) {
      const choices = raw.values.map((choice) => String(choice).slice(0, 64));
      // The default is an index, but one Activity names the choice instead.
      const index = typeof raw.value === "number" ? raw.value : choices.indexOf(String(raw.value));
      setting.type = "choice";
      setting.choices = choices;
      setting.default = Number.isInteger(index) && index >= 0 && index < choices.length ? index : 0;
    } else if (typeof raw.value === "boolean") {
      setting.default = raw.value;
    } else if (typeof raw.value === "string") {
      setting.type = "text";
      setting.default = raw.value.slice(0, 256);
    } else if (typeof raw.value === "number" && Number.isFinite(raw.value)) {
      setting.type = "number";
      setting.default = raw.value;
    } else {
      continue;
    }
    if (isObject(raw.if)) {
      const when: Record<string, SettingValue> = {};
      for (const [id, expected] of Object.entries(raw.if)) {
        if (isString(expected) || typeof expected === "boolean" || typeof expected === "number") {
          when[id] = expected;
        }
      }
      setting.when = when;
    }
    if (checkSetting(setting) === null) settings.push(setting);
  }
  // A condition on the fixed language picker is settled now: dropped when it
  // holds, and the setting with it when it can't.
  const shown: ActivitySetting[] = [];
  for (const setting of settings) {
    const when = Object.entries(setting.when ?? {});
    if (when.some(([id, expected]) => id in fixed && expected !== fixed[id])) continue;
    const rest = when.filter(([id]) => !(id in fixed));
    const { when: _, ...plain } = setting;
    shown.push(rest.length > 0 ? { ...plain, when: Object.fromEntries(rest) } : plain);
  }
  return { settings: shown, fixed };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch {
    return null;
  }
}

/**
 * The description's translations PreMiD's metadata.json carries, in the
 * languages the extension's views are in. They're the only translated text in
 * PreMiD's Activities repository: a service's own strings (`<service>.json`)
 * are translated on PreMiD's Crowdin and served by its API, which Parousia
 * never calls.
 */
export function readDescriptions(description: unknown): Partial<Record<Language, string>> {
  const found: Partial<Record<Language, string>> = {};
  if (!isObject(description)) return found;
  for (const language of LANGUAGES) {
    const text = description[language];
    if (language !== "en" && isString(text) && text.trim()) {
      found[language] = text.trim().slice(0, LIMITS.description);
    }
  }
  return found;
}

/** `activities/descriptions/<language>.json` for each language some Activity has a description in. */
export function descriptionFiles(activities: readonly PremidFound[]): Map<string, string> {
  const byLanguage = new Map<Language, Record<string, string>>();
  for (const { manifest, descriptions } of activities) {
    for (const [language, text] of Object.entries(descriptions) as Array<[Language, string]>) {
      const texts = byLanguage.get(language) ?? {};
      texts[manifest.info.id] = text;
      byLanguage.set(language, texts);
    }
  }
  return new Map(
    [...byLanguage].map(([language, texts]) => [descriptionsPath(language), JSON.stringify(texts)]),
  );
}

/** English messages from a PreMiD strings file (`general.json`, `<service>.json`). */
export async function readStrings(path: string): Promise<Record<string, string>> {
  const value = existsSync(path) ? await readJson(path) : null;
  const strings: Record<string, string> = {};
  if (!isObject(value)) return strings;
  for (const [key, entry] of Object.entries(value)) {
    if (isObject(entry) && isString(entry.message)) strings[key] = entry.message;
  }
  return strings;
}

async function sourcesOf(folder: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: folder })) {
    if (!file.includes("node_modules/") && !file.endsWith(".d.ts")) files.push(file);
  }
  // presence.ts first, so its client id is the default.
  files.sort((a, b) => (a === "presence.ts" ? -1 : b === "presence.ts" ? 1 : a.localeCompare(b)));
  return Promise.all(files.map((file) => Bun.file(join(folder, file)).text()));
}

/** Long enough for a list of every server of a federated site (Mastodon's is 3,342 characters). */
const MAX_REGEXP = 8192;

function testRegExp(source: unknown): string | null {
  if (!isString(source) || source.length > MAX_REGEXP) return null;
  try {
    new RegExp(source);
    return source;
  } catch {
    return null;
  }
}

/** A subdomain no real site has, to ask a regular expression whether it takes any. */
const PROBE = "parousia-probe";
const PROBE_PATHS = ["/", "/a", "/a/b"];

/**
 * The sites to ask access for, from what the Activity's `regExp` really
 * matches. An Activity runs where its `regExp` matches, but `url` only names
 * a site (`archlinux.org`), and a grant for that host alone doesn't cover
 * `wiki.archlinux.org`, which the same `regExp` takes: the Activity matched
 * there and was then unavailable for want of access. So for each `url` host,
 * the regular expression is asked about a made-up subdomain (every
 * subdomain: `*://*.host/*`, which includes the host), and about `www.`
 * (which `url: "duolingo.com"` with a `(www|preview)[.]duolingo` regExp
 * needs). It's asked with a few paths, since most regExps take any; one that
 * only takes a particular path is asked nothing it can't answer, and keeps
 * the host as named.
 */
export function originsFor(hosts: readonly string[], regExp: string): string[] {
  const pattern = new RegExp(regExp);
  const takes = (host: string): boolean =>
    PROBE_PATHS.some((path) => pattern.test(`https://${host}${path}`));
  const origins: string[] = [];
  for (const host of hosts) {
    // An address has no subdomains, and nothing to be asked about.
    if (/^(\d{1,3}\.){3}\d{1,3}$|^localhost$/.test(host)) {
      origins.push(hostOrigin(host));
      continue;
    }
    if (takes(`${PROBE}.${host}`)) {
      origins.push(`*://*.${host}/*`);
      continue;
    }
    const own = takes(host);
    const www = !host.startsWith("www.") && takes(`www.${host}`);
    if (own || !www) origins.push(hostOrigin(host));
    if (www) origins.push(hostOrigin(`www.${host}`));
  }
  return [...new Set(origins)];
}

/** One metadata.json and its folder, as a PreMiD Activity for the extension, or why it's left out. */
async function readActivity(
  folder: string,
  site: string,
  metadata: Json,
): Promise<PremidFound | string> {
  const {
    service,
    description,
    url,
    regExp,
    iFrameRegExp,
    iframe,
    logo,
    altnames,
    tags,
    category,
  } = metadata;
  if (!isString(service)) return "metadata.json has no service";
  if (metadata.apiVersion !== 1)
    return `Activity API ${String(metadata.apiVersion)} isn't supported yet`;
  const pattern = testRegExp(regExp);
  if (!pattern) return `its regExp isn't a regular expression of at most ${MAX_REGEXP} characters`;
  const hosts = [
    ...new Set(
      (Array.isArray(url) ? url : [url]).filter(
        (host): host is string => isString(host) && HOST.test(host),
      ),
    ),
  ];
  if (hosts.length === 0) return "it names no site (url)";
  if (!isString(logo) || !logo.startsWith("https://")) return "its logo isn't an https URL";
  if (!existsSync(join(folder, "presence.ts"))) return "it has no presence.ts";
  if (existsSync(join(folder, "package.json"))) {
    const manifest = await readJson(join(folder, "package.json"));
    const dependencies =
      isObject(manifest) && isObject(manifest.dependencies)
        ? Object.keys(manifest.dependencies)
        : [];
    if (dependencies.length > 0) {
      return `it needs its own npm packages (${dependencies.join(", ")}), which Parousia doesn't install`;
    }
  }
  const hasIframe = iframe === true;
  if (hasIframe && !existsSync(join(folder, "iframe.ts")))
    return "metadata.json says iframe, but there's no iframe.ts";
  const iframeRegExp = iFrameRegExp === undefined ? null : testRegExp(iFrameRegExp);
  if (hasIframe && iFrameRegExp !== undefined && !iframeRegExp) {
    return `its iFrameRegExp isn't a regular expression of at most ${MAX_REGEXP} characters`;
  }

  const clientIds = extractClientIds(await sourcesOf(folder));
  if (clientIds.length === 0) return "no Discord client id in its source";

  const { settings, fixed } = mapPremidSettings(metadata.settings);
  const { info, match } = manifestFrom({
    source: "premid",
    id: premidId(service),
    name: service,
    ...(isObject(description) && isString(description.en) && { description: description.en }),
    hosts,
    match: { regExp: pattern },
    icon: logo,
    keywords: keywordsFrom(
      Array.isArray(altnames) ? altnames : [],
      Array.isArray(tags) ? tags : [],
      [category],
    ),
    discordClientId: clientIds[0],
    settings,
    // Its code reads the page directly, so it may take any of them; each can be switched off.
    data: [...PAGE_DATA_KINDS],
    origins: originsFor(hosts, pattern),
  });

  const script: PageScript = { file: "", clientIds };
  if (hasIframe) script.iframe = { regExp: iframeRegExp };
  if (Object.keys(fixed).length > 0) script.fixed = fixed;
  return {
    site,
    manifest: { info, match, script },
    dir: folder,
    strings: await readStrings(join(folder, `${service}.json`)),
    descriptions: readDescriptions(description),
  };
}

/**
 * Services whose scripts assign page text to `innerHTML`, which add-on
 * reviews flag and which Parousia won't ship. Left out at build time, by the
 * name in their metadata.json; a native replacement, where one is practical
 * (it never builds markup from page text), lives in the activities repository.
 */
export const UNSAFE_MARKUP: ReadonlySet<string> = new Set(["VLC", "TLX Toki", "Weverse"]);

/** Services PreMiD lists in its `dmca.json`, which stay out. */
export async function readDmca(root: string): Promise<Set<string>> {
  const dmca = await readJson(join(root, "dmca.json"));
  return new Set(
    isObject(dmca) && Array.isArray(dmca.services) ? dmca.services.filter(isString) : [],
  );
}

/**
 * A website's folder as a PreMiD Activity, or why it's left out. A service
 * with one folder per API version uses its `v1/`, the version Parousia runs.
 */
export async function adaptPremid(
  folder: WebsiteFolder,
  blocked: ReadonlySet<string>,
): Promise<PremidFound | Exclusion> {
  let dir = folder.dir;
  if (!existsSync(join(dir, "metadata.json"))) {
    const versions = [...new Bun.Glob("v*/metadata.json").scanSync({ cwd: dir })]
      // Bun's glob gives `v1\metadata.json` on Windows.
      .map((file) => file.split(/[\\/]/)[0] ?? "")
      .filter((version) => /^v\d+$/.test(version))
      .sort();
    const version = versions.includes("v1") ? "v1" : versions[0];
    if (!version) return { service: folder.name, reason: "it has no metadata.json" };
    dir = join(dir, version);
  }
  const metadata = await readJson(join(dir, "metadata.json"));
  const service = isObject(metadata) && isString(metadata.service) ? metadata.service : folder.name;
  if (!isObject(metadata)) return { service, reason: "metadata.json isn't valid JSON" };
  if (blocked.has(service)) return { service, reason: "it's on PreMiD's DMCA list" };
  if (UNSAFE_MARKUP.has(service)) {
    return {
      service,
      reason: "its script assigns page text to innerHTML, which Parousia won't ship",
    };
  }
  const result = await readActivity(dir, activityId(folder.name), metadata);
  return isString(result) ? { service, reason: result } : result;
}

/** A file name for an Activity's scripts: readable, and unique among `taken`. */
function fileName(service: string, taken: Set<string>): string {
  const slug =
    service
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "activity";
  let name = slug;
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  taken.add(name);
  return name;
}

/**
 * An Activity's compiled script, wrapped so its `Presence` and `iFrame` are
 * Parousia's, bound to it (src/premid/page.ts). It does nothing if the
 * runtime isn't there or already ran it in this document.
 */
export function wrapScript(
  code: string,
  id: string,
  strings: Record<string, string>,
  frame: boolean,
): string {
  const bind = frame ? "bindFrame" : "bind";
  const given = Object.keys(strings).length > 0 ? `,${JSON.stringify(strings)}` : "";
  return [
    `globalThis.${BRIDGE_KEY}?.${bind}(${JSON.stringify(id)},(Presence,iFrame,Slideshow,SlideshowSlide,MIN_SLIDE_TIME)=>{`,
    code,
    `}${given});`,
    "",
  ].join("\n");
}

async function compile(entrypoint: string, plugin: Bun.BunPlugin): Promise<string | Error> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "iife",
    minify: true,
    plugins: [plugin],
    throw: false,
  });
  const [output] = result.outputs;
  if (!result.success || !output) {
    const [first] = result.logs;
    return new Error(first ? String(first.message) : "it doesn't build");
  }
  return output.text();
}

/**
 * Compiles every found Activity (its `premid` imports from PreMiD's own
 * helper package in the same checkout), returning the scripts by file name
 * under `premid/`, the catalog entries, and any that failed to build.
 */
export async function compilePremid(
  root: string,
  found: readonly PremidFound[],
): Promise<{
  activities: PremidFound[];
  scripts: Map<string, string>;
  excluded: Exclusion[];
}> {
  const helper = join(root, "premid", "src", "index.ts");
  const plugin: Bun.BunPlugin = {
    name: "premid-helpers",
    setup(build) {
      build.onResolve({ filter: /^premid$/ }, () => ({ path: helper }));
    },
  };
  const activities: PremidFound[] = [];
  const scripts = new Map<string, string>();
  const excluded: Exclusion[] = [];
  const taken = new Set<string>();

  for (const entry of found) {
    const { manifest, dir, strings } = entry;
    const page = await compile(join(dir, "presence.ts"), plugin);
    const frame = manifest.script.iframe ? await compile(join(dir, "iframe.ts"), plugin) : null;
    const failure = page instanceof Error ? page : frame instanceof Error ? frame : null;
    if (failure || typeof page !== "string") {
      excluded.push({
        service: manifest.info.name,
        reason: `it doesn't build (${failure?.message ?? relative(root, dir)})`,
      });
      continue;
    }
    const file = fileName(manifest.info.name, taken);
    scripts.set(`${file}.js`, wrapScript(page, manifest.info.id, strings, false));
    if (typeof frame === "string") {
      scripts.set(`${file}.iframe.js`, wrapScript(frame, manifest.info.id, strings, true));
    }
    activities.push({ ...entry, manifest: { ...manifest, script: { ...manifest.script, file } } });
  }
  return { activities, scripts, excluded };
}
