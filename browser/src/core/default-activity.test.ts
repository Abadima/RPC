import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ACTIVITY_ID,
  EMPTY_DEFAULT_ACTIVITY,
  defaultActivityProblems,
  defaultActivityToShow,
  loadDefaultActivity,
  parseDefaultActivity,
  saveDefaultActivity,
  type DefaultActivity,
} from "./default-activity";
import type { PreferenceArea } from "./preferences";

const studying: DefaultActivity = {
  ...EMPTY_DEFAULT_ACTIVITY,
  enabled: true,
  name: "Studying",
  details: "Chapter 4",
  state: "Biology",
  largeImage: "https://example.com/book.png",
  largeText: "A book",
  buttons: [{ label: "Syllabus", url: "https://example.com/syllabus" }],
};

describe("Default Activity", () => {
  test("stored values are read field by field, capped, with anything else dropped", () => {
    expect(parseDefaultActivity(null)).toEqual(EMPTY_DEFAULT_ACTIVITY);
    const parsed = parseDefaultActivity({
      enabled: "yes",
      name: "x".repeat(500),
      details: 42,
      buttons: [{ label: "A", url: "https://a.example" }, "junk", { label: "B" }, { label: "C" }],
      elapsed: false,
      discordClientId: "1".repeat(40),
      extra: "ignored",
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.name).toHaveLength(128);
    expect(parsed.details).toBe("");
    expect(parsed.buttons).toEqual([
      { label: "A", url: "https://a.example" },
      { label: "B", url: "" },
    ]);
    expect(parsed.elapsed).toBe(false);
    expect(parsed.discordClientId).toHaveLength(20);
    expect(parsed).not.toHaveProperty("extra");
  });

  test("it can be shown only with a name, images Discord can show, whole buttons with web links, and a real Application id", () => {
    expect(defaultActivityProblems(studying)).toEqual({});
    const problems = defaultActivityProblems({
      ...studying,
      name: "S",
      details: "x",
      largeImage: "javascript:alert(1)",
      smallImage: "http://example.com/plain.png",
      buttons: [{ label: "Open", url: "file:///etc/passwd" }],
      discordClientId: "123",
    });
    expect(Object.keys(problems).sort()).toEqual([
      "buttons",
      "details",
      "discordClientId",
      "largeImage",
      "name",
      "smallImage",
    ]);
    expect(
      defaultActivityProblems({ ...studying, buttons: [{ label: "Half", url: "" }] }),
    ).toHaveProperty("buttons");
    // An asset name of the person's own Discord Application is an image too.
    expect(defaultActivityProblems({ ...studying, largeImage: "my_cover" })).toEqual({});
  });

  test("shown as an Activity only while on and valid, with blank fields left out", () => {
    expect(defaultActivityToShow({ ...studying, enabled: false }, 1)).toBeNull();
    expect(defaultActivityToShow({ ...studying, name: "" }, 1)).toBeNull();
    expect(
      defaultActivityToShow({ ...studying, discordClientId: "1553980756731363428" }, 1000),
    ).toEqual({
      id: DEFAULT_ACTIVITY_ID,
      name: "Studying",
      details: "Chapter 4",
      state: "Biology",
      assets: { largeImage: "https://example.com/book.png", largeText: "A book" },
      buttons: [{ label: "Syllabus", url: "https://example.com/syllabus" }],
      timestamps: { start: 1000 },
      discordClientId: "1553980756731363428",
    });
    expect(
      defaultActivityToShow(
        {
          ...EMPTY_DEFAULT_ACTIVITY,
          enabled: true,
          name: "  Idle  ",
          elapsed: false,
          buttons: [{ label: "", url: "" }],
        },
        1,
      ),
    ).toEqual({ id: DEFAULT_ACTIVITY_ID, name: "Idle" });
  });

  test("its id can't be any Activity's: not a folder slug, not a PreMiD id", () => {
    expect(DEFAULT_ACTIVITY_ID).not.toMatch(/^[a-z0-9-]+$/);
    expect(DEFAULT_ACTIVITY_ID.startsWith("premid:")).toBe(false);
  });

  test("saved and loaded through storage", async () => {
    const stored: Record<string, unknown> = {};
    const area: PreferenceArea = {
      get: async (key) => ({ [key]: stored[key] }),
      set: async (items) => {
        Object.assign(stored, items);
      },
    };
    await saveDefaultActivity(studying, area);
    expect(await loadDefaultActivity(area)).toEqual(studying);
  });
});
