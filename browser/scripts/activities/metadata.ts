import type {
  ActivityInfo,
  ActivitySetting,
  ActivitySource,
  PageDataKind,
} from "../../src/core/activity";
import type { ActivityManifest, ActivityMatch } from "../../src/activities/manifest";
import { patternHost } from "../../src/core/match-pattern";

/**
 * What each source's adapter (native.ts, premid.ts) reads out of a website's
 * folder, in Parousia's terms. An adapter only maps its source's own names
 * onto this (PreMiD's `service`, `url`, `logo`, `altnames`; a native
 * Activity's `name`, `matches`, `icon`); the limits, the settings rules, the
 * sites to ask for, and the words to search by are decided here, once, for
 * both, and so is the manifest the rest of the pipeline gets.
 */
export interface Draft {
  source: ActivitySource;
  id: string;
  name: string;
  description?: string;
  hosts: string[];
  match: ActivityMatch;
  icon?: string;
  keywords?: string[];
  discordClientId?: string;
  settings?: ActivitySetting[];
  data?: PageDataKind[];
  /** The sites it reads pages on, when it reads pages. */
  origins?: string[];
}

export const LIMITS = {
  name: 64,
  description: 256,
  keyword: 64,
  keywords: 64,
  icon: 512,
  settings: 32,
  settingTitle: 64,
  settingDescription: 256,
  placeholder: 128,
  choice: 64,
  choices: 32,
  text: 256,
} as const;

export const SETTING_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const CLIENT_ID = /^\d{17,20}$/;

/** What's wrong with a setting, by the rules both sources' settings follow, or `null`. */
export function checkSetting(setting: ActivitySetting): string | null {
  if (!SETTING_ID.test(setting.id)) return "its id isn't 1 to 64 letters, digits, _ or -";
  if (!setting.title.trim() || setting.title.length > LIMITS.settingTitle) {
    return `its title isn't 1 to ${LIMITS.settingTitle} characters`;
  }
  if (setting.description !== undefined && setting.description.length > LIMITS.settingDescription) {
    return "its description is too long";
  }
  if (setting.placeholder !== undefined && setting.placeholder.length > LIMITS.placeholder) {
    return "its placeholder is too long";
  }
  const value = setting.default;
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "a switch's default is true or false";
    case "choice": {
      const choices = setting.choices ?? [];
      if (
        choices.length === 0 ||
        choices.length > LIMITS.choices ||
        choices.some((choice) => !choice.trim() || choice.length > LIMITS.choice)
      ) {
        return `a choice lists 1 to ${LIMITS.choices} choices of 1 to ${LIMITS.choice} characters`;
      }
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value < choices.length
        ? null
        : "a choice's default is the index of one of its choices";
    }
    case "text":
      return typeof value === "string" && value.length <= LIMITS.text
        ? null
        : "text defaults are at most 256 characters";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "a number's default is a number";
  }
}

/** Words to find an Activity by, from any of its lists: trimmed, unique, and capped. */
export function keywordsFrom(...lists: ReadonlyArray<readonly unknown[] | undefined>): string[] {
  const words = new Set<string>();
  for (const list of lists) {
    for (const word of list ?? []) {
      if (typeof word !== "string") continue;
      const trimmed = word.trim().slice(0, LIMITS.keyword);
      if (trimmed) words.add(trimmed);
    }
  }
  return [...words].slice(0, LIMITS.keywords);
}

/** A match pattern's site, as the origin pattern to ask access for: `https://example.com/watch*` is `https://example.com/*`. */
export function patternOrigin(pattern: string): string {
  const [scheme = "*"] = pattern.split("://");
  return `${scheme}://${pattern.includes("://*.") ? "*." : ""}${patternHost(pattern)}/*`;
}

/** A host's origin pattern: `www.youtube.com` is `*://www.youtube.com/*`. */
export const hostOrigin = (host: string): string => `*://${host}/*`;

/** The manifest for a draft: optional fields only where there's something in them. */
export function manifestFrom(draft: Draft): ActivityManifest {
  const info: ActivityInfo = {
    id: draft.id,
    name: draft.name.slice(0, LIMITS.name),
    hosts: [...new Set(draft.hosts)],
    source: draft.source,
  };
  const description = draft.description?.trim().slice(0, LIMITS.description);
  if (description) info.description = description;
  if (draft.keywords && draft.keywords.length > 0) info.keywords = keywordsFrom(draft.keywords);
  if (draft.icon) info.icon = draft.icon;
  if (draft.discordClientId) info.discordClientId = draft.discordClientId;
  const settings = (draft.settings ?? []).slice(0, LIMITS.settings);
  if (settings.length > 0) info.settings = settings;
  if (draft.data && draft.data.length > 0) {
    info.data = [...new Set(draft.data)];
    info.origins = [...new Set(draft.origins ?? draft.hosts.map(hostOrigin))];
  }
  return { info, match: draft.match };
}
