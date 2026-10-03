import type { Activity, ActivityInfo, PageDataKind, SettingValue } from "./activity";

/**
 * What's playing on a page: its Media Session (title, artist, album, and its
 * own say on whether it's playing), and its media element for the clock.
 */
export interface PageMedia {
  title?: string;
  artist?: string;
  album?: string;
  playing?: boolean;
  /** Whether the element it reads is a `<video>` or an `<audio>`: "Watching" or "Listening to". */
  kind?: "video" | "audio";
  /** Seconds. */
  duration?: number;
  /**
   * While playing, when the item started and will end if it plays straight
   * through, in Unix milliseconds: an Activity's `timestamps` as they are. They
   * change only when playback is seeked or restarted, not as it plays.
   */
  start?: number;
  end?: number;
}

/** An image the page shows: its `https` address, and the alt text it gives. */
export interface PageImage {
  src: string;
  alt?: string;
}

/** What Parousia's collector read from a page, only of the kinds its Activity may take. */
export interface PageData {
  media?: PageMedia;
  /** An `https` image of what's shown. */
  thumbnail?: string;
  /**
   * The `https` images the page has loaded, in page order and a few of them:
   * for an Activity that knows where its site keeps a cover or an avatar
   * (the address says which), which a page's og:image seldom is.
   */
  images?: PageImage[];
}

/** What an Activity sees of a page: its URL, and its title (which `tabs` exposes, like the URL). */
export interface Page {
  url: URL;
  title: string;
  /** The tab's favicon, which `tabs` exposes like the URL: the last image to fall back on before Discord's Application icon. */
  favicon?: string;
  /** The page data kinds the Activity has here: declared, allowed in Settings > Privacy, and the site granted. */
  granted?: readonly PageDataKind[];
  /** What Parousia's collector read (native Activities that take page data). */
  data?: PageData;
  /** What a PreMiD Activity's script in this tab last reported (see `src/premid/`). */
  reported?: Activity | null;
}

/** An Activity's settings, each as set or at its default; a choice is its index. */
export type SettingValues = Readonly<Record<string, SettingValue>>;

export type ActivityMatcher = (url: URL) => boolean;
export type ActivityDetector = (page: Page, settings: SettingValues) => Activity | null;

export interface RegisteredActivity {
  info: ActivityInfo;
  matcher: ActivityMatcher;
  detect: ActivityDetector;
}

/**
 * Every Activity Parousia knows about, native or PreMiD's, in the order they
 * were registered: native ones first, so a site with both uses the native one.
 */
export class ActivityRegistry {
  private readonly activities = new Map<string, RegisteredActivity>();

  /** Adds an Activity, replacing one with the same id in place. */
  register(activity: RegisteredActivity): void {
    this.activities.set(activity.info.id, activity);
  }

  unregister(id: string): void {
    this.activities.delete(id);
  }

  /** A registered Activity's catalog entry. */
  get(id: string): ActivityInfo | null {
    return this.activities.get(id)?.info ?? null;
  }

  /** Every registered Activity's catalog entry, in registration order. */
  list(): ActivityInfo[] {
    return [...this.activities.values()].map((activity) => activity.info);
  }

  /** The first Activity that matches `url` and `usable` lets run there. */
  resolve(
    url: URL,
    usable: (info: ActivityInfo) => boolean = () => true,
  ): RegisteredActivity | null {
    for (const activity of this.activities.values()) {
      if (activity.matcher(url) && usable(activity.info)) return activity;
    }
    return null;
  }
}
