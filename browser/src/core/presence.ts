import type { Activity, ActivityAssets, ActivityButton, ActivityTimestamps } from "./activity";

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

function buttonsEqual(a: ActivityButton[] = [], b: ActivityButton[] = []): boolean {
  return (
    a.length === b.length &&
    a.every((button, i) => button.label === b[i]?.label && button.url === b[i]?.url)
  );
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
    a.detailsUrl === b.detailsUrl &&
    a.stateUrl === b.stateUrl &&
    a.discordClientId === b.discordClientId &&
    assetsEqual(a.assets, b.assets) &&
    timestampsEqual(a.timestamps, b.timestamps) &&
    buttonsEqual(a.buttons, b.buttons)
  );
}

/** Whether two Presence values represent the same reported state, ignoring `updatedAt`. */
export function presenceEquals(a: Presence, b: Presence): boolean {
  return activityEquals(a.activity, b.activity);
}
