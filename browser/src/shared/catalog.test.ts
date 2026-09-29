import { describe, expect, test } from "bun:test";
import type { ActivityInfo } from "../core/activity";
import {
  PAGE_SIZE,
  indexActivities,
  pageNumbers,
  pageOf,
  paginate,
  rowsThatFit,
  searchActivities,
} from "./catalog";

/** A catalog the size PreMiD's will be, for sizing and paging, not real Activities. */
const catalog: ActivityInfo[] = Array.from({ length: 1400 }, (_, i) => ({
  id: `activity-${i}`,
  name: `Activity ${String(i).padStart(4, "0")}`,
  hosts: [`site${i}.example`],
}));

describe("searchActivities", () => {
  const index = indexActivities([
    ...catalog,
    { id: "cafe", name: "Café Reader", description: "Menus and orders", hosts: ["cafe.example"] },
    { id: "tube", name: "Tube", description: "Video playback", hosts: ["tube.example"] },
  ]);

  test("an empty query lists everything, sorted by name", () => {
    const all = searchActivities(index, "  ");
    expect(all).toHaveLength(1402);
    expect(all[0]?.name).toBe("Activity 0000");
  });

  test("matches every word across name, description, and sites, ignoring case and accents", () => {
    expect(searchActivities(index, "cafe").map((a) => a.id)).toEqual(["cafe"]);
    expect(searchActivities(index, "VIDEO tube.example").map((a) => a.id)).toEqual(["tube"]);
    expect(searchActivities(index, "video menus")).toEqual([]);
    expect(searchActivities(index, "site1399")).toHaveLength(1);
  });
});

describe("paginate", () => {
  test("splits 1,400 Activities into pages and says which ones are shown", () => {
    const first = paginate(catalog, 1);
    expect(first.items).toHaveLength(PAGE_SIZE);
    expect(first.pageCount).toBe(Math.ceil(1400 / PAGE_SIZE));
    expect([first.first, first.last, first.total]).toEqual([1, PAGE_SIZE, 1400]);

    const last = paginate(catalog, first.pageCount);
    expect(last.last).toBe(1400);
    expect(last.items.at(-1)?.id).toBe("activity-1399");
  });

  test("clamps pages out of range or not numbers", () => {
    expect(paginate(catalog, 999).page).toBe(paginate(catalog, 1).pageCount);
    expect(paginate(catalog, -3).page).toBe(1);
    expect(paginate(catalog, Number.NaN).page).toBe(1);
  });

  test("an empty list is one empty page", () => {
    expect(paginate([], 4)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      total: 0,
      first: 0,
      last: 0,
    });
  });
});

describe("pageNumbers", () => {
  test("keeps the ends and the neighbourhood, with gaps between", () => {
    expect(pageNumbers(5, 59)).toEqual([1, "gap", 4, 5, 6, "gap", 59]);
    expect(pageNumbers(1, 59)).toEqual([1, 2, "gap", 59]);
    expect(pageNumbers(59, 59)).toEqual([1, "gap", 58, 59]);
  });

  test("shows a lone skipped page instead of a gap", () => {
    expect(pageNumbers(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageNumbers(1, 1)).toEqual([1]);
  });
});

describe("fitting the screen", () => {
  test("counts the rows that fit, with a floor for short windows", () => {
    // 4K: about 1,700 px of room for 64 px cards with 12 px gaps.
    expect(rowsThatFit(1700, 64, 12)).toBe(22);
    expect(rowsThatFit(100, 64, 12)).toBe(3);
    expect(rowsThatFit(500, 0, 12)).toBe(3);
  });

  test("keeps the first card shown when the page size changes", () => {
    // Showing items 48-71 at 24 a page is page 3; at 70 a page, item 48 is on page 1.
    expect(pageOf(48, 24)).toBe(3);
    expect(pageOf(48, 70)).toBe(1);
    expect(pageOf(140, 70)).toBe(3);
  });
});
