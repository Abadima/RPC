/** Just enough of an Activity to display; deliberately independent of `browser/src/core`. */
export interface PresenceActivity {
  name: string;
  details?: string;
  state?: string;
  /** When the Activity started, in Unix milliseconds; shown as elapsed time. */
  startedAt?: number;
}

export interface PresenceSnapshot {
  /**
   * Whether a live source answered at all. False (a standalone PWA with no
   * extension to ask) is a different state from "asked, and nothing's
   * playing".
   */
  available: boolean;
  activity: PresenceActivity | null;
}

/** Host-specific adapter: how a given surface finds out what's currently happening. */
export type PresenceSource = () => Promise<PresenceSnapshot>;

export type PresenceIconName = "empty" | "unavailable" | "elapsed";

export interface PresenceViewOptions {
  /**
   * Icons for the view, from whatever icon set the host bundles. Optional so
   * this package stays dependency-free; without it the view draws no icons.
   */
  icon?: (name: PresenceIconName) => Element;
}
