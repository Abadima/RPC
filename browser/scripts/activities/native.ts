import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActivitySetting, PageDataKind, SettingValue } from "../../src/core/activity";
import { compileMatchPattern, patternHost } from "../../src/core/match-pattern";
import type { ActivityManifest } from "../../src/activities/manifest";
import { FOLDER_NAME, activityId, folderLetter, type WebsiteFolder } from "./discover";
import { CLIENT_ID, LIMITS, checkSetting, manifestFrom, patternOrigin } from "./metadata";

/**
 * The adapter for native Activities (github.com/parousia-project/activities):
 * a website's folder holds a metadata.json and an activity.ts. That
 * repository checks its own Activities, and this checks them again, strictly,
 * since the extension runs what it includes: any problem stops the build.
 */

/** A checked native Activity: its manifest, and its module for the bundle. */
export interface NativeFound {
  /** Its website, as the folder's id: the same website in PreMiD's repository has the same one. */
  site: string;
  manifest: ActivityManifest;
  modulePath: string;
}

/** The page data a native Activity can declare: what Parousia's collector reads (src/activities/collector.ts). */
const NATIVE_DATA: readonly PageDataKind[] = ["media", "thumbnails"];

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isValue = (value: unknown): value is SettingValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const METADATA_KEYS = new Set([
  "$schema",
  "apiVersion",
  "id",
  "name",
  "description",
  "version",
  "authors",
  "matches",
  "discordClientId",
  "icon",
  "data",
  "settings",
]);
const SETTING_KEYS = new Set([
  "id",
  "title",
  "description",
  "type",
  "default",
  "choices",
  "placeholder",
  "when",
]);

/** A setting as metadata.json has it, in Parousia's model (the same as PreMiD's are mapped into). */
function parseSetting(value: unknown, problems: string[]): ActivitySetting | null {
  if (!isObject(value) || Object.keys(value).some((key) => !SETTING_KEYS.has(key))) {
    problems.push(`a setting isn't an object of ${[...SETTING_KEYS].join(", ")}`);
    return null;
  }
  const { id, title, description, type, choices, placeholder, when } = value;
  const fallback = value.default;
  if (typeof id !== "string" || typeof title !== "string" || !isValue(fallback)) {
    problems.push("a setting needs an id, a title, and a default");
    return null;
  }
  if (type !== "boolean" && type !== "choice" && type !== "text" && type !== "number") {
    problems.push(`setting ${id}: type is boolean, choice, text, or number`);
    return null;
  }
  const setting: ActivitySetting = { id, title, type, default: fallback };
  if (typeof description === "string") setting.description = description;
  if (typeof placeholder === "string") setting.placeholder = placeholder;
  if (Array.isArray(choices))
    setting.choices = choices.filter((c): c is string => typeof c === "string");
  if (when !== undefined) {
    if (!isObject(when) || !Object.values(when).every(isValue)) {
      problems.push(`setting ${id}: "when" must map setting ids to values`);
    } else {
      setting.when = Object.fromEntries(
        Object.entries(when).filter((entry): entry is [string, SettingValue] => isValue(entry[1])),
      );
    }
  }
  const problem = checkSetting(setting);
  if (problem) {
    problems.push(`setting ${id}: ${problem}`);
    return null;
  }
  return setting;
}

/** metadata.json from `websites/<letter>/<folder>/`, as a manifest, or what's wrong with it. */
export function parseNativeMetadata(
  value: unknown,
  folder: string,
): { manifest?: ActivityManifest; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(value)) return { problems: ["metadata.json isn't a JSON object"] };
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) problems.push(`unknown key "${key}"`);
  }
  const {
    apiVersion,
    id,
    name,
    description,
    version,
    authors,
    matches,
    discordClientId,
    icon,
    data,
    settings,
  } = value;
  if (apiVersion !== 1) {
    problems.push("apiVersion must be 1 (the only Activity API this build implements)");
  }
  const expected = activityId(folder);
  if (!expected || id !== expected) {
    problems.push(`id must be "${expected}", the folder's name in lowercase words joined by "-"`);
  }
  if (!isText(name, LIMITS.name)) problems.push(`name must be 1 to ${LIMITS.name} characters`);
  if (!isText(description, LIMITS.description)) {
    problems.push(`description must be 1 to ${LIMITS.description} characters`);
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    problems.push("version must be MAJOR.MINOR.PATCH");
  }
  if (
    !Array.isArray(authors) ||
    authors.length === 0 ||
    !authors.every((author) => isObject(author) && isText(author.name, 64))
  ) {
    problems.push("authors must list at least one { name }");
  }
  const patterns: string[] = [];
  if (!Array.isArray(matches) || matches.length === 0 || matches.length > 32) {
    problems.push("matches must list 1 to 32 match patterns");
  } else {
    for (const pattern of matches) {
      if (typeof pattern === "string" && compileMatchPattern(pattern)) patterns.push(pattern);
      else
        problems.push(
          `matches: ${JSON.stringify(pattern)} isn't a match pattern for particular sites`,
        );
    }
  }
  if (
    discordClientId !== undefined &&
    (typeof discordClientId !== "string" || !CLIENT_ID.test(discordClientId))
  ) {
    problems.push("discordClientId must be a Discord application id");
  }
  if (
    icon !== undefined &&
    (typeof icon !== "string" || !icon.startsWith("https://") || icon.length > 256)
  ) {
    problems.push("icon must be an https image URL of at most 256 characters");
  }
  const kinds: PageDataKind[] = [];
  if (data !== undefined) {
    if (!Array.isArray(data) || data.length === 0) {
      problems.push(`data must list the page data it takes: ${NATIVE_DATA.join(", ")}`);
    } else {
      for (const kind of data) {
        const known = NATIVE_DATA.find((candidate) => candidate === kind);
        if (!known)
          problems.push(`data: ${JSON.stringify(kind)} isn't one of ${NATIVE_DATA.join(", ")}`);
        else if (!kinds.includes(known)) kinds.push(known);
      }
    }
  }
  const parsedSettings: ActivitySetting[] = [];
  if (settings !== undefined) {
    if (!Array.isArray(settings) || settings.length > LIMITS.settings) {
      problems.push(`settings must be a list of at most ${LIMITS.settings}`);
    } else {
      for (const setting of settings) {
        const parsed = parseSetting(setting, problems);
        if (!parsed) continue;
        if (parsedSettings.some((other) => other.id === parsed.id)) {
          problems.push(`setting ${parsed.id} is listed twice`);
        }
        parsedSettings.push(parsed);
      }
      const ids = new Set(parsedSettings.map((setting) => setting.id));
      for (const setting of parsedSettings) {
        for (const other of Object.keys(setting.when ?? {})) {
          if (!ids.has(other))
            problems.push(`setting ${setting.id}: "when" names ${other}, which isn't a setting`);
        }
      }
    }
  }
  if (
    problems.length > 0 ||
    typeof id !== "string" ||
    !isText(name, LIMITS.name) ||
    !isText(description, LIMITS.description)
  ) {
    return { problems };
  }
  const manifest = manifestFrom({
    source: "parousia",
    id,
    name,
    description,
    hosts: patterns.map(patternHost),
    match: { patterns },
    ...(typeof icon === "string" && { icon }),
    ...(typeof discordClientId === "string" && { discordClientId }),
    settings: parsedSettings,
    data: kinds,
    origins: patterns.map(patternOrigin),
  });
  return { manifest, problems };
}

/** A website's folder as a native Activity, or what's wrong with it. */
export async function adaptNative(
  folder: WebsiteFolder,
): Promise<{ found?: NativeFound; problems: string[] }> {
  if (!FOLDER_NAME.test(folder.name)) {
    return { problems: ["the folder name must be letters, digits, spaces, and . ' & + _ -"] };
  }
  if (folder.letter !== folderLetter(folder.name)) {
    return { problems: [`it goes in websites/${folderLetter(folder.name)}/`] };
  }
  const metadataPath = join(folder.dir, "metadata.json");
  const modulePath = join(folder.dir, "activity.ts");
  if (!existsSync(metadataPath) || !existsSync(modulePath)) {
    return { problems: ["needs metadata.json and activity.ts"] };
  }
  let value: unknown;
  try {
    value = await Bun.file(metadataPath).json();
  } catch {
    return { problems: ["metadata.json isn't valid JSON"] };
  }
  const { manifest, problems } = parseNativeMetadata(value, folder.name);
  if (!manifest) return { problems };
  const module: unknown = await import(modulePath);
  const exported = isObject(module) ? module.default : undefined;
  if (!isObject(exported) || typeof exported.detect !== "function") {
    return { problems: ["activity.ts must export { detect } as its default"] };
  }
  return { found: { site: activityId(folder.name), manifest, modulePath }, problems };
}
