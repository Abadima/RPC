import type { ActivityInfo, ActivitySource } from "../core/activity";
import { isActivityOn, type ActivityStates } from "../core/activity-state";

export type StatusFilter = "enabled" | "disabled";

/**
 * The filters on the Activities page. Within one group the choices add up
 * (Enabled and Disabled is everything), and across groups they narrow
 * (Enabled and PreMiD is PreMiD's that are on). A group with nothing chosen
 * doesn't restrict.
 */
export interface ActivityFilters {
  status: ReadonlySet<StatusFilter>;
  /** The implementation the card is showing: Parousia's own, or PreMiD's. */
  source: ReadonlySet<ActivitySource>;
}

export const NO_FILTERS: ActivityFilters = { status: new Set(), source: new Set() };

/** Filters chosen, for the button's count. */
export function filterCount(filters: ActivityFilters): number {
  return filters.status.size + filters.source.size;
}

export function matchesFilters(
  info: ActivityInfo,
  states: ActivityStates,
  filters: ActivityFilters,
): boolean {
  if (filters.status.size > 0) {
    const status: StatusFilter = isActivityOn(info, states) ? "enabled" : "disabled";
    if (!filters.status.has(status)) return false;
  }
  return filters.source.size === 0 || filters.source.has(info.source);
}

export function filterActivities(
  activities: readonly ActivityInfo[],
  states: ActivityStates,
  filters: ActivityFilters,
): ActivityInfo[] {
  return filterCount(filters) === 0
    ? [...activities]
    : activities.filter((info) => matchesFilters(info, states, filters));
}

const collator = new Intl.Collator("en", { numeric: true });

/**
 * Enabled first, then disabled; within each, by name (numbers in order:
 * "Radio 2" before "Radio 10"), and by id where names are the same, so the
 * order never depends on how the catalog happened to be built.
 */
export function sortActivities(
  activities: readonly ActivityInfo[],
  states: ActivityStates,
): ActivityInfo[] {
  const enabled = new Map(activities.map((info) => [info.id, isActivityOn(info, states)]));
  return [...activities].sort(
    (a, b) =>
      Number(enabled.get(b.id)) - Number(enabled.get(a.id)) ||
      collator.compare(a.name, b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const STATUS_FILTERS: readonly StatusFilter[] = ["enabled", "disabled"];
const SOURCE_FILTERS: readonly ActivitySource[] = ["parousia", "premid"];

/** Filters as they're kept in the page's address: `enabled,premid`. */
export function serializeFilters(filters: ActivityFilters): string {
  return [
    ...STATUS_FILTERS.filter((value) => filters.status.has(value)),
    ...SOURCE_FILTERS.filter((value) => filters.source.has(value)),
  ].join(",");
}

/** The inverse of `serializeFilters`; anything it doesn't recognize is ignored. */
export function parseFilters(value: string | null): ActivityFilters {
  const words = new Set((value ?? "").split(","));
  return {
    status: new Set(STATUS_FILTERS.filter((filter) => words.has(filter))),
    source: new Set(SOURCE_FILTERS.filter((filter) => words.has(filter))),
  };
}
