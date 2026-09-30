import { describe, expect, test } from "bun:test";
import type { ActivityInfo } from "../core/activity";
import type { ActivityStates } from "../core/activity-state";
import {
  NO_FILTERS,
  filterActivities,
  filterCount,
  parseFilters,
  serializeFilters,
  sortActivities,
  type ActivityFilters,
} from "./activity-list";

const info = (
  id: string,
  name: string,
  source: "parousia" | "premid",
  reads = source === "premid",
): ActivityInfo => ({
  id,
  name,
  hosts: [`${id}.example`],
  source,
  ...(reads && { origins: [`*://${id}.example/*`] }),
});

// Native ones are on until turned off; ones that read pages are off until turned on.
const jena = info("jena", "Jena Hub", "parousia");
const chess = info("chess", "Chess", "parousia");
const radio2 = info("premid:Radio 2", "Radio 2", "premid");
const radio10 = info("premid:Radio 10", "Radio 10", "premid");
const alpha = info("premid:Alpha", "Alpha", "premid");
const zulu = info("premid:Zulu", "Zulu", "premid");
const all = [zulu, radio10, jena, alpha, radio2, chess];

const states: ActivityStates = {
  [zulu.id]: { on: true },
  [radio10.id]: { on: true },
  [chess.id]: { on: false },
};

const filters = (
  status: Array<"enabled" | "disabled"> = [],
  source: Array<"parousia" | "premid"> = [],
): ActivityFilters => ({ status: new Set(status), source: new Set(source) });

const ids = (list: readonly ActivityInfo[]): string[] => list.map((entry) => entry.id);

describe("sorting", () => {
  test("enabled first, then disabled, each by name with numbers in order", () => {
    // On: Jena Hub (native, default), Radio 10, Zulu. Off: Alpha, Chess (turned off), Radio 2.
    expect(ids(sortActivities(all, states))).toEqual([
      "jena",
      "premid:Radio 10",
      "premid:Zulu",
      "premid:Alpha",
      "chess",
      "premid:Radio 2",
    ]);
  });

  test("is the same whatever order the catalog came in", () => {
    const expected = ids(sortActivities(all, states));
    expect(ids(sortActivities([...all].reverse(), states))).toEqual(expected);
    const byId = [...all].sort((a, b) => a.id.localeCompare(b.id));
    expect(ids(sortActivities(byId, states))).toEqual(expected);
  });

  test("names that are the same are told apart by id", () => {
    const first = info("a-radio", "Radio", "parousia");
    const second = info("b-radio", "Radio", "parousia");
    expect(ids(sortActivities([second, first], {}))).toEqual(["a-radio", "b-radio"]);
    expect(ids(sortActivities([first, second], {}))).toEqual(["a-radio", "b-radio"]);
  });

  test("doesn't change what it was given", () => {
    const copy = [...all];
    sortActivities(all, states);
    expect(all).toEqual(copy);
  });

  test("an Activity turned on moves up the next time it's sorted", () => {
    const before = ids(sortActivities(all, states));
    const after = ids(sortActivities(all, { ...states, [alpha.id]: { on: true } }));
    expect(before.indexOf(alpha.id)).toBeGreaterThan(after.indexOf(alpha.id));
    expect(after.slice(0, 4)).toEqual(["premid:Alpha", "jena", "premid:Radio 10", "premid:Zulu"]);
  });
});

describe("filtering", () => {
  test("no filter shows everything", () => {
    expect(filterCount(NO_FILTERS)).toBe(0);
    expect(ids(filterActivities(all, states, NO_FILTERS))).toEqual(ids(all));
  });

  test("enabled and disabled each keep their own, and both keep everything", () => {
    expect(ids(filterActivities(all, states, filters(["enabled"])))).toEqual([
      "premid:Zulu",
      "premid:Radio 10",
      "jena",
    ]);
    expect(ids(filterActivities(all, states, filters(["disabled"])))).toEqual([
      "premid:Alpha",
      "premid:Radio 2",
      "chess",
    ]);
    expect(filterActivities(all, states, filters(["enabled", "disabled"]))).toHaveLength(6);
  });

  test("Parousia's and PreMiD's each keep their own, and both keep everything", () => {
    expect(ids(filterActivities(all, states, filters([], ["parousia"])))).toEqual([
      "jena",
      "chess",
    ]);
    expect(filterActivities(all, states, filters([], ["premid"]))).toHaveLength(4);
    expect(filterActivities(all, states, filters([], ["parousia", "premid"]))).toHaveLength(6);
  });

  test("across groups they narrow, within a group they add up", () => {
    expect(ids(filterActivities(all, states, filters(["enabled"], ["premid"])))).toEqual([
      "premid:Zulu",
      "premid:Radio 10",
    ]);
    expect(ids(filterActivities(all, states, filters(["disabled"], ["parousia"])))).toEqual([
      "chess",
    ]);
    expect(
      filterActivities(all, states, filters(["enabled", "disabled"], ["parousia"])),
    ).toHaveLength(2);
    expect(filterCount(filters(["enabled", "disabled"], ["premid"]))).toBe(3);
  });

  test("a website in both sources is filtered as the implementation it is showing", () => {
    const variants = ["video", "premid:Video"];
    const ours: ActivityInfo = { ...info("video", "Video", "parousia"), variants };
    const theirs: ActivityInfo = { ...info("premid:Video", "Video", "premid"), variants };
    // Listed once, as whichever is chosen (see `listed`): here PreMiD's, turned on.
    const chosen = { video: { use: theirs.id }, [theirs.id]: { on: true } };
    expect(filterActivities([theirs], chosen, filters([], ["parousia"]))).toEqual([]);
    expect(filterActivities([theirs], chosen, filters(["enabled"], ["premid"]))).toEqual([theirs]);
    expect(filterActivities([ours], {}, filters(["enabled"], ["parousia"]))).toEqual([ours]);
  });

  test("survives a round trip through the page's address, and ignores what it doesn't know", () => {
    const chosen = filters(["disabled"], ["parousia", "premid"]);
    expect(serializeFilters(chosen)).toBe("disabled,parousia,premid");
    expect(parseFilters(serializeFilters(chosen))).toEqual(chosen);
    expect(serializeFilters(NO_FILTERS)).toBe("");
    expect(parseFilters(null)).toEqual(NO_FILTERS);
    expect(parseFilters("enabled,bogus,,__proto__,PREMID")).toEqual(filters(["enabled"]));
  });
});
