import type { Activity } from "./activity";
import { createPresence, presenceEquals, type Presence } from "./presence";
import type { Page } from "./registry";
import type { PresenceRuntime } from "./runtime";
import type { PresenceTransport } from "./transport";

/**
 * Owns the single Presence Parousia currently reports, resolving URLs through
 * a PresenceRuntime and forwarding the result to a transport only when it
 * actually changes, so a stale or repeated Presence never gets resent.
 */
export class PresenceController {
  private current: Presence | null = null;

  constructor(
    private readonly runtime: PresenceRuntime,
    private readonly transport: PresenceTransport,
  ) {}

  /**
   * Resolve `page` (or no page: a browser page, which only the Default
   * Activity covers) and publish it if it differs from the last published
   * Presence. `share` decides what of the Activity may leave the browser
   * (see preferences.ts); by default, all of it.
   */
  update(
    page: Page | null,
    share: (activity: Activity | null) => Activity | null = (a) => a,
  ): void {
    this.publish(createPresence(share(this.runtime.resolve(page).activity)));
  }

  /** Publish an explicit "nothing" Presence, e.g. when a tab closes or loses focus. */
  clear(): void {
    this.publish(createPresence(null));
  }

  /** For a consumer that polls instead of receiving pushes, such as a compatibility layer answering another extension's request. */
  getActivity(): Presence["activity"] {
    return this.current?.activity ?? null;
  }

  private publish(presence: Presence): void {
    if (this.current !== null && presenceEquals(this.current, presence)) {
      return;
    }
    this.current = presence;
    this.transport.send(presence);
  }
}
