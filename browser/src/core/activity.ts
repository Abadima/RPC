export interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  /** Where clicking the large image goes; `http(s)` only. */
  largeUrl?: string;
  smallImage?: string;
  smallText?: string;
  /** Where clicking the small image goes; `http(s)` only. */
  smallUrl?: string;
}

/** The verb Discord puts before the name: "Playing", "Listening to", "Watching", "Competing in". */
export type ActivityType = "playing" | "listening" | "watching" | "competing";

/** Which line Discord shows in the member list's status text. */
export type StatusDisplayType = "name" | "state" | "details";

/** A group the Activity belongs to, as "size of max". */
export interface ActivityParty {
  size: number;
  max: number;
}

export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

export type SettingValue = string | number | boolean;

/**
 * Page data an Activity may take from the pages it runs on, beyond their URL
 * and title. Each needs access to the site, which someone grants explicitly,
 * and each can be switched off for every Activity at once (Settings >
 * Privacy).
 */
export type PageDataKind = "media" | "thumbnails" | "creatorIcons";
export const PAGE_DATA_KINDS: readonly PageDataKind[] = ["media", "thumbnails", "creatorIcons"];

/** One of an Activity's own settings, shown on its page in the dashboard. */
export interface ActivitySetting {
  id: string;
  title: string;
  description?: string;
  /** `boolean`: a switch. `choice`: one of `choices`, kept as its index. `text`, `number`: typed in. */
  type: "boolean" | "choice" | "text" | "number";
  default: SettingValue;
  choices?: string[];
  placeholder?: string;
  /** Shown only while each named setting has the given value. */
  when?: Record<string, SettingValue>;
}

/**
 * Where an Activity comes from: Parousia's own (parousia-project/activities),
 * or PreMiD's (PreMiD/Activities), run through the compatibility layer in
 * `src/premid/`.
 */
export type ActivitySource = "parousia" | "premid";

/** What the dashboard's Activities page lists: one entry per registered Activity. */
export interface ActivityInfo {
  id: string;
  name: string;
  description?: string;
  /** The sites it recognizes, for display and search, e.g. `youtube.com`. */
  hosts: string[];
  source: ActivitySource;
  /** More words to find it by: other names, tags. */
  keywords?: string[];
  /** Its icon: an `https` image URL, shown in the dashboard when it loads. */
  icon?: string;
  /** The Discord Application it shows as, like each PreMiD Activity has its own. */
  discordClientId?: string;
  settings?: ActivitySetting[];
  /** Page data it takes, beyond the URL and title. None: it reads only the URL and title. */
  data?: PageDataKind[];
  /**
   * The sites it reads pages on, as origin patterns. Turning it on asks for
   * access to them, and it runs only where that's granted. None: it reads
   * only URLs and titles, so it needs no access.
   */
  origins?: string[];
  /**
   * Every implementation of the same website, this one included, when more
   * than one source has it (a native Activity and a PreMiD one): the native
   * one first. Only the one chosen runs, and the dashboard lists them once.
   */
  variants?: string[];
}

export interface ActivityButton {
  label: string;
  /** `http(s)` only. */
  url: string;
}

export interface Activity {
  id: string;
  name: string;
  details?: string;
  state?: string;
  /** The page it's about. It stays in the browser: nothing it's sent to needs it. */
  url?: string;
  assets?: ActivityAssets;
  timestamps?: ActivityTimestamps;
  /** Links for the details and state lines; `http(s)` only. */
  detailsUrl?: string;
  stateUrl?: string;
  /** At most two. Discord shows them to others, not to you. */
  buttons?: ActivityButton[];
  /** Left out: "playing". */
  type?: ActivityType;
  statusDisplayType?: StatusDisplayType;
  /** Shown only on a "playing" Activity. */
  party?: ActivityParty;
  /**
   * Stamped by the runtime from `ActivityInfo`. Only a PreMiD Activity's own
   * script picks its own, and only among the Applications its source names.
   */
  discordClientId?: string;
}
