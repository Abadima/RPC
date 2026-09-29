import type { Activity, ActivityInfo } from "./activity";

export type ActivityMatcher = (url: URL) => boolean;
export type ActivityDetector = (url: URL) => Activity | null;

export interface RegisteredActivity {
  info: ActivityInfo;
  matcher: ActivityMatcher;
  detect: ActivityDetector;
}

export class ActivityRegistry {
  private readonly activities: RegisteredActivity[] = [];

  register(activity: RegisteredActivity): void {
    this.activities.push(activity);
  }

  /** Every registered Activity's catalog entry, in registration order. */
  list(): ActivityInfo[] {
    return this.activities.map((activity) => activity.info);
  }

  resolve(url: URL): RegisteredActivity | null {
    return this.activities.find((activity) => activity.matcher(url)) ?? null;
  }
}
