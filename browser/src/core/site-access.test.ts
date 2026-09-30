import { describe, expect, test } from "bun:test";
import type { ActivityInfo } from "./activity";
import {
  NO_GRANTS,
  canRun,
  covers,
  grantsFrom,
  missingSites,
  pageGranted,
  siteAccess,
  siteGranted,
} from "./site-access";

const video: ActivityInfo = {
  id: "premid:Video",
  name: "Video",
  hosts: ["www.video.example", "m.video.example"],
  source: "premid",
  origins: ["*://www.video.example/*", "*://m.video.example/*"],
};

describe("site access", () => {
  test("reads the browser's grants, telling all websites apart from sites on their own", () => {
    expect(grantsFrom({ origins: ["*://www.video.example/*", "*://*/*"] })).toEqual({
      all: true,
      origins: ["*://www.video.example/*"],
    });
    expect(grantsFrom({ origins: ["<all_urls>"] }).all).toBe(true);
    expect(grantsFrom({})).toEqual(NO_GRANTS);
    // Every https site isn't every website: an http page stays ungranted.
    const https = grantsFrom({ origins: ["https://*/*"] });
    expect(https.all).toBe(false);
    expect(pageGranted(new URL("https://a.example/"), https)).toBe(true);
    expect(pageGranted(new URL("http://a.example/"), https)).toBe(false);
  });

  test("a site is granted on its own, by a wider pattern, or by all websites, and nothing else", () => {
    expect(covers("*://www.video.example/*", "*://www.video.example/*")).toBe(true);
    expect(covers("*://*.video.example/*", "*://m.video.example/*")).toBe(true);
    expect(covers("https://www.video.example/*", "*://www.video.example/*")).toBe(false);
    expect(covers("*://video.example/*", "*://www.video.example/*")).toBe(false);
    expect(covers("*://www.video.example/*", "*://www.video.example.evil.test/*")).toBe(false);
    expect(siteGranted("*://m.video.example/*", { all: true, origins: [] })).toBe(true);
    expect(
      pageGranted(new URL("https://www.video.example/watch"), {
        all: false,
        origins: ["*://www.video.example/*"],
      }),
    ).toBe(true);
    expect(
      pageGranted(new URL("https://other.example/"), {
        all: false,
        origins: ["*://www.video.example/*"],
      }),
    ).toBe(false);
  });

  test("an Activity that reads pages runs only where its site is granted; one that doesn't, anywhere", () => {
    const watch = new URL("https://www.video.example/watch");
    expect(canRun(video, watch, NO_GRANTS)).toBe(false);
    expect(canRun(video, watch, { all: false, origins: ["*://www.video.example/*"] })).toBe(true);
    expect(
      canRun(video, new URL("https://m.video.example/"), {
        all: false,
        origins: ["*://www.video.example/*"],
      }),
    ).toBe(false);
    expect(canRun(video, watch, { all: true, origins: [] })).toBe(true);
    expect(canRun({ ...video, origins: undefined }, watch, NO_GRANTS)).toBe(true);
    expect(missingSites(video, { all: false, origins: ["*://www.video.example/*"] })).toEqual([
      "*://m.video.example/*",
    ]);
    expect(missingSites(video, { all: true, origins: [] })).toEqual([]);
  });

  test("an Activity has every site it reads, some, none, or needs none", () => {
    expect(siteAccess(video, NO_GRANTS)).toBe("none");
    expect(siteAccess(video, { all: false, origins: ["*://www.video.example/*"] })).toBe("some");
    expect(siteAccess(video, { all: false, origins: video.origins ?? [] })).toBe("all");
    expect(siteAccess(video, { all: true, origins: [] })).toBe("all");
    expect(siteAccess({ ...video, origins: undefined }, NO_GRANTS)).toBe("unneeded");
  });
});
