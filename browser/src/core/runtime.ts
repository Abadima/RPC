import type { Activity, ActivityInfo } from "./activity";
import { settingValues } from "./activity-state";
import { createPresence, type Presence } from "./presence";
import type { ActivityRegistry, Page, RegisteredActivity, SettingValues } from "./registry";

export interface RuntimeOptions {
  /** Whether an Activity may run at `url`: turned on, and granted the site if it reads pages. By default, every one may. */
  usable?: (info: ActivityInfo, url: URL) => boolean;
  /** Its settings as set; by default, each at its default. */
  settings?: (info: ActivityInfo) => SettingValues;
  /** What to share when no Activity has anything to: the Default Activity, if one is set up. */
  fallback?: () => Activity | null;
}

/**
 * The Discord Application to show `activity` as: the catalog's, except that a
 * PreMiD Activity's script may pick another of its own (the PreMiD host only
 * lets through ones its source names).
 */
function stampClientId({ info }: RegisteredActivity, activity: Activity): Activity {
  const { discordClientId: own, ...rest } = activity;
  const discordClientId = (info.source === "premid" ? own : undefined) ?? info.discordClientId;
  return discordClientId ? { ...rest, discordClientId } : rest;
}

export class PresenceRuntime {
  constructor(
    private readonly registry: ActivityRegistry,
    private readonly options: RuntimeOptions = {},
  ) {}

  private find(url: URL): RegisteredActivity | null {
    const usable = this.options.usable;
    return this.registry.resolve(url, usable && ((info) => usable(info, url)));
  }

  /** The Presence for `page`, or for no page at all (a browser page, a new tab): the fallback, if any. */
  resolve(page: Page | null): Presence {
    const registered = page && this.find(page.url);
    let activity: Activity | null = null;
    if (page && registered) {
      const settings = this.options.settings?.(registered.info) ?? settingValues(registered.info);
      try {
        const detected = registered.detect(page, settings);
        activity = detected && stampClientId(registered, detected);
      } catch {
        // A broken Activity shows nothing rather than stopping detection for every other one.
      }
    }
    return createPresence(activity ?? this.options.fallback?.() ?? null);
  }

  /** Whether `url` is a page some Activity looks at (so its title matters too). */
  matches(url: URL): boolean {
    return this.find(url) !== null;
  }
}
