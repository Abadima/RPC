import type { Activity } from "./activity";

/**
 * Whether `activity` presents music or video: as "Listening to" or "Watching",
 * or with an end time, which a track or a video of some length has. Whether it
 * plays now is the tab's sound, which the browser reports and a page can't
 * claim. Ordinary browsing is neither, nor is elapsed time alone.
 */
export function isMediaActivity(activity: Activity): boolean {
  return (
    activity.type === "listening" ||
    activity.type === "watching" ||
    activity.timestamps?.end !== undefined
  );
}

/**
 * The tabs that showed music or video while they were the one shared, for
 * "Show media presence": one of them keeps its presence going while another
 * tab is shared that has nothing of its own. Only tabs that were shared get
 * here, so a page never gets its music or video shown without having been
 * looked at first.
 *
 * Which one wins is when each was last shared, not which changed last: a
 * player that moves on to its next track in the background doesn't take
 * over, so two playing at once never trade places.
 */
export class MediaTabs {
  /** Tabs by the order in which they were last shared with music or video playing. */
  private readonly sharedAt = new Map<number, number>();
  private clock = 0;

  /** `onChange` hears every change to which tabs are remembered, and to which is the most recent. */
  constructor(private readonly onChange: (tabs: readonly number[]) => void = () => {}) {}

  /** The tabs remembered, the one shared longest ago first. */
  order(): number[] {
    return [...this.sharedAt].sort(([, a], [, b]) => a - b).map(([tab]) => tab);
  }

  private changed(): void {
    this.onChange(this.order());
  }

  /**
   * The tab being shared, with `own`, what its Activity detects there (none
   * for a site without one), and whether sound is playing in it. Playing
   * music or video makes it the most recent; paused, a tab already
   * remembered stays, to count again when it resumes; anything else forgets it.
   */
  shared(tabId: number, own: Activity | null, audible: boolean): void {
    if (own === null || !isMediaActivity(own)) {
      this.forget(tabId);
    } else if (audible) {
      const known = this.sharedAt.has(tabId);
      const newest = this.order().at(-1);
      this.sharedAt.set(tabId, ++this.clock);
      if (!known || newest !== tabId) this.changed();
    }
  }

  /**
   * Puts back tabs remembered before the background restarted (`order`, the
   * oldest first), as older than any shared since. A tab that has closed
   * meanwhile is forgotten when it is next looked at.
   */
  restore(order: readonly number[]): void {
    const fresh = [...new Set(order)].filter((tab) => !this.sharedAt.has(tab));
    fresh.forEach((tab, index) => this.sharedAt.set(tab, index - fresh.length));
    if (fresh.length > 0) this.changed();
  }

  has(tabId: number): boolean {
    return this.sharedAt.has(tabId);
  }

  forget(tabId: number): void {
    if (this.sharedAt.delete(tabId)) this.changed();
  }

  clear(): void {
    if (this.sharedAt.size === 0) return;
    this.sharedAt.clear();
    this.changed();
  }

  /**
   * The most recently shared tab, other than `except` (the one being shared),
   * for which `media` has something: its music or video as it is now. A tab
   * `media` throws for is gone, and forgotten.
   */
  async pick<T>(
    except: number,
    media: (tabId: number) => Promise<T | null>,
  ): Promise<{ tab: number; media: T } | null> {
    const newest = [...this.sharedAt]
      .filter(([tab]) => tab !== except)
      .sort(([, a], [, b]) => b - a);
    for (const [tab] of newest) {
      try {
        const found = await media(tab);
        if (found !== null) return { tab, media: found };
      } catch {
        this.forget(tab);
      }
    }
    return null;
  }
}
