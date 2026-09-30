import { describe, expect, test } from "bun:test";
import type { ActivityManifest } from "../activities/manifest";
import { limitPageData, parsePresenceData, toActivity } from "./presence-data";

const entry: ActivityManifest = {
  info: {
    id: "premid:Example",
    name: "Example",
    hosts: ["example.com"],
    source: "premid",
    icon: "https://cdn.example/logo.png",
    origins: ["*://example.com/*"],
    discordClientId: "503557087041683458",
  },
  match: { regExp: "^https?://example[.]com/" },
  script: { file: "example", clientIds: ["503557087041683458"] },
};
const page = new URL("https://example.com/watch?v=abc&token=secret#t=1");
const CLIENT = "503557087041683458";

describe("PreMiD PresenceData", () => {
  test("becomes Parousia's Activity, with the page's URL cut to its path", () => {
    const data = parsePresenceData({
      details: "  Never Gonna Give You Up  ",
      state: "Rick Astley",
      startTimestamp: 1_700_000_000,
      endTimestamp: 1_700_000_212_345,
      largeImageKey: "https://i.example/cover.jpg",
      largeImageText: "Whenever You Need Somebody",
      smallImageKey: "play",
      smallImageText: "Playing",
      detailsUrl: "https://example.com/watch?v=abc",
      buttons: [
        { label: "Watch", url: "https://example.com/watch?v=abc" },
        { label: "Channel", url: "javascript:alert(1)" },
        { label: "Third", url: "https://example.com/3" },
      ],
      type: 3,
      party: { partySize: 1, maxPartySize: 2 },
    });
    expect(data && toActivity(entry, data, page, CLIENT)).toEqual({
      id: "premid:Example",
      name: "Example",
      url: "https://example.com/watch",
      discordClientId: CLIENT,
      details: "Never Gonna Give You Up",
      state: "Rick Astley",
      detailsUrl: "https://example.com/watch?v=abc",
      assets: {
        largeImage: "https://i.example/cover.jpg",
        largeText: "Whenever You Need Somebody",
        smallImage: "play",
        smallText: "Playing",
      },
      // Seconds become milliseconds; milliseconds are rounded to the second.
      timestamps: { start: 1_700_000_000_000, end: 1_700_000_212_000 },
      buttons: [{ label: "Watch", url: "https://example.com/watch?v=abc" }],
    });
  });

  test("its own name wins, and without an image it shows its logo", () => {
    const activity = toActivity(entry, { name: "Example Music" }, page, CLIENT);
    expect(activity.name).toBe("Example Music");
    expect(activity.assets).toEqual({ largeImage: "https://cdn.example/logo.png" });
  });

  test("anything a page could slip in is dropped or bounded", () => {
    const data = parsePresenceData({
      details: "x".repeat(10_000),
      state: 42,
      largeImageKey: "data:image/png;base64,AAAA",
      smallImageKey: "not a key!",
      stateUrl: "file:///etc/passwd",
      startTimestamp: Number.NaN,
      endTimestamp: -5,
      buttons: "nope",
    });
    const activity = data && toActivity(entry, data, page, CLIENT);
    expect(activity?.details).toHaveLength(256);
    expect(activity?.state).toBeUndefined();
    expect(activity?.stateUrl).toBeUndefined();
    expect(activity?.timestamps).toBeUndefined();
    expect(activity?.buttons).toBeUndefined();
    expect(activity?.assets).toEqual({ largeImage: "https://cdn.example/logo.png" });
    expect(parsePresenceData("details")).toBeNull();
    expect(JSON.stringify(activity)).not.toContain("secret");
  });

  test("page data kinds switched off are held back; its own images stay", () => {
    const activity = toActivity(
      entry,
      {
        name: "Never Gonna Give You Up",
        details: "Never Gonna Give You Up",
        state: "Rick Astley",
        largeImageKey: "https://i.ytimg.com/vi/x/hq.jpg",
        largeImageText: "Album",
        smallImageKey: "https://yt3.ggpht.com/avatar.jpg",
        smallImageText: "Rick Astley",
        startTimestamp: 1_700_000_000,
        buttons: [{ label: "Watch", url: "https://example.com/watch" }],
      },
      page,
      CLIENT,
    );
    expect(activity.name).toBe("Never Gonna Give You Up");
    expect(limitPageData(activity, ["media", "thumbnails", "creatorIcons"], entry.info)).toEqual(
      activity,
    );
    // A name the Activity set from the page is what's playing too.
    expect(limitPageData(activity, [], entry.info)).toEqual({
      id: "premid:Example",
      name: "Example",
      url: "https://example.com/watch",
      discordClientId: CLIENT,
      assets: { largeImage: "https://cdn.example/logo.png" },
    });
    const own = toActivity(
      entry,
      {
        details: "Browsing",
        largeImageKey: "https://cdn.rcd.gg/PreMiD/websites/E/Example/assets/logo.png",
        smallImageKey: "https://cdn.rcd.gg/PreMiD/resources/play.png",
      },
      page,
      CLIENT,
    );
    expect(limitPageData(own, ["media"], entry.info).assets).toEqual({
      largeImage: "https://cdn.rcd.gg/PreMiD/websites/E/Example/assets/logo.png",
      smallImage: "https://cdn.rcd.gg/PreMiD/resources/play.png",
    });
  });
});
