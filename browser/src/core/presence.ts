import type { Activity } from "./activity";

export interface Presence {
  activity: Activity | null;
  updatedAt: number;
}

export function createPresence(activity: Activity | null): Presence {
  return { activity, updatedAt: Date.now() };
}
