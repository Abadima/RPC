import { ActivityRegistry } from "./registry";

/**
 * The built-in Activities, defined once for the background script, popup,
 * and dashboard, so what's detected and what's listed never disagree. None
 * ship yet; the first is planned in `project/roadmap.md`.
 */
export function builtInActivities(): ActivityRegistry {
  return new ActivityRegistry();
}
