import type { ActivityInfo, ActivitySetting, PageDataKind, SettingValue } from "./activity";
import type { PageDataPreferences, PreferenceArea } from "./preferences";
import type { SettingValues } from "./registry";

/**
 * What someone chose for each Activity, kept in `chrome.storage.local` beside
 * the preferences: whether it's on, and its settings. Only Activities someone
 * changed are stored.
 */
export interface ActivityState {
  on?: boolean;
  settings?: Record<string, SettingValue>;
  /** Settings the Activity's own script hid (PreMiD's `hideSetting`). */
  hidden?: string[];
  /** On a website's first variant (see `ActivityInfo.variants`): the one chosen to run there. */
  use?: string;
}

export type ActivityStates = Readonly<Record<string, ActivityState>>;

const STORAGE_KEY = "activities";
const MAX_ID = 256;
const MAX_TEXT = 256;
const MAX_HIDDEN = 64;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseState(value: unknown): ActivityState | null {
  if (!isObject(value)) return null;
  const state: ActivityState = {};
  if (typeof value.on === "boolean") state.on = value.on;
  if (isObject(value.settings)) {
    const settings: Record<string, SettingValue> = {};
    for (const [id, setting] of Object.entries(value.settings)) {
      if (
        typeof setting === "boolean" ||
        (typeof setting === "number" && Number.isFinite(setting)) ||
        (typeof setting === "string" && setting.length <= MAX_TEXT)
      ) {
        settings[id] = setting;
      }
    }
    state.settings = settings;
  }
  if (Array.isArray(value.hidden)) {
    state.hidden = value.hidden
      .filter((id): id is string => typeof id === "string")
      .slice(0, MAX_HIDDEN);
  }
  if (typeof value.use === "string" && value.use.length <= MAX_ID) state.use = value.use;
  return state;
}

/** Anything stored that isn't a valid state is dropped, Activity by Activity. */
export function parseActivityStates(value: unknown): ActivityStates {
  if (!isObject(value)) return {};
  const states: Record<string, ActivityState> = {};
  for (const [id, stored] of Object.entries(value)) {
    const state = id.length <= MAX_ID ? parseState(stored) : null;
    if (state) states[id] = state;
  }
  return states;
}

/** Whether `info` reads pages, so it runs only on sites someone granted it. */
export function needsAccess(info: ActivityInfo): boolean {
  return (info.origins?.length ?? 0) > 0;
}

/** Which of a website's implementations runs: the one chosen, or the first (native) one. */
export function chosenVariant(info: ActivityInfo, states: ActivityStates): string {
  const [first] = info.variants ?? [];
  if (first === undefined) return info.id;
  const use = states[first]?.use;
  return use !== undefined && info.variants?.includes(use) ? use : first;
}

/**
 * Whether it's turned on. An Activity that reads only URLs and titles is on
 * until turned off; one that reads pages is off until turned on, which asks
 * for its sites. Of a website's implementations, only the chosen one is ever
 * on. Being on isn't enough to run: see `site-access.ts`, `usable`.
 */
export function isActivityOn(info: ActivityInfo, states: ActivityStates): boolean {
  if (chosenVariant(info, states) !== info.id) return false;
  return states[info.id]?.on ?? !needsAccess(info);
}

/** The page data kinds `info` declares that Settings > Privacy allows (before site access). */
export function allowedData(info: ActivityInfo, pageData: PageDataPreferences): PageDataKind[] {
  return (info.data ?? []).filter((kind) => pageData[kind]);
}

function fits(setting: ActivitySetting, value: SettingValue): boolean {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value < (setting.choices?.length ?? 0)
      );
    case "text":
      return typeof value === "string" && value.length <= MAX_TEXT;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
  }
}

/** Each of `info`'s settings as stored, when that's a value it can take, or its default. */
export function settingValues(info: ActivityInfo, states: ActivityStates = {}): SettingValues {
  const stored = states[info.id]?.settings ?? {};
  const values: Record<string, SettingValue> = {};
  for (const setting of info.settings ?? []) {
    const value = stored[setting.id];
    values[setting.id] = value !== undefined && fits(setting, value) ? value : setting.default;
  }
  return values;
}

/** Whether a setting shows: its Activity hasn't hidden it, and its `when` conditions hold. */
export function settingShown(
  setting: ActivitySetting,
  values: SettingValues,
  hidden: readonly string[] = [],
): boolean {
  if (hidden.includes(setting.id)) return false;
  return Object.entries(setting.when ?? {}).every(([id, value]) => values[id] === value);
}

export async function loadActivityStates(
  area: PreferenceArea = chrome.storage.local,
): Promise<ActivityStates> {
  return parseActivityStates((await area.get(STORAGE_KEY))[STORAGE_KEY]);
}

/**
 * Merges each patch into its Activity's state (`settings` merge setting by
 * setting), in one read and one write, so changing many at once can't race
 * itself or write the whole record once per Activity.
 */
export async function saveActivityStates(
  patches: Readonly<Record<string, ActivityState>>,
  area: PreferenceArea = chrome.storage.local,
): Promise<ActivityStates> {
  const states = await loadActivityStates(area);
  const merged: Record<string, ActivityState> = { ...states };
  for (const [id, patch] of Object.entries(patches)) {
    const current = states[id] ?? {};
    const next: ActivityState = { ...current, ...patch };
    if (current.settings || patch.settings) {
      next.settings = { ...current.settings, ...patch.settings };
    }
    merged[id] = next;
  }
  const next = parseActivityStates(merged);
  await area.set({ [STORAGE_KEY]: next });
  return next;
}

/** Merges `patch` into one Activity's state; `settings` merge setting by setting. */
export function saveActivityState(
  id: string,
  patch: ActivityState,
  area: PreferenceArea = chrome.storage.local,
): Promise<ActivityStates> {
  return saveActivityStates({ [id]: patch }, area);
}

/**
 * Calls `listener` with every Activity's state whenever any view or the
 * background saves one. Returns a function that stops it.
 */
export function watchActivityStates(listener: (states: ActivityStates) => void): () => void {
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    const change = changes[STORAGE_KEY];
    if (area === "local" && change) listener(parseActivityStates(change.newValue));
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
