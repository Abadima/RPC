import type { Activity, ActivityAssets, ActivityTimestamps } from "./activity";

export interface Presence {
  activity: Activity | null;
  updatedAt: number;
}

export function createPresence(activity: Activity | null): Presence {
  return { activity, updatedAt: Date.now() };
}

function assetsEqual(a: ActivityAssets | undefined, b: ActivityAssets | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.largeImage === b.largeImage &&
    a.largeText === b.largeText &&
    a.smallImage === b.smallImage &&
    a.smallText === b.smallText
  );
}

function timestampsEqual(
  a: ActivityTimestamps | undefined,
  b: ActivityTimestamps | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

function activityEquals(a: Activity | null, b: Activity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.details === b.details &&
    a.state === b.state &&
    a.url === b.url &&
    assetsEqual(a.assets, b.assets) &&
    timestampsEqual(a.timestamps, b.timestamps)
  );
}

/** Whether two Presence values represent the same reported state, ignoring `updatedAt`. */
export function presenceEquals(a: Presence, b: Presence): boolean {
  return activityEquals(a.activity, b.activity);
}
