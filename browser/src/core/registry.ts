import type { Activity } from "./activity";

export type ActivityMatcher = (url: URL) => boolean;
export type ActivityDetector = (url: URL) => Activity | null;

export interface RegisteredActivity {
  matcher: ActivityMatcher;
  detect: ActivityDetector;
}

export class ActivityRegistry {
  private readonly activities: RegisteredActivity[] = [];

  register(activity: RegisteredActivity): void {
    this.activities.push(activity);
  }

  resolve(url: URL): RegisteredActivity | null {
    return this.activities.find((activity) => activity.matcher(url)) ?? null;
  }
}
