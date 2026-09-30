import { describe, expect, test } from "bun:test";
import { ActivityRegistry } from "../core/registry";
import { PresenceRuntime } from "../core/runtime";
import {
  catalogEntry,
  compileMatch,
  hostKeys,
  parseCatalog,
  parseHosts,
  parseIndex,
  parseManifest,
  registered,
  type ActivityManifest,
} from "./manifest";

const native: ActivityManifest = {
  info: {
    id: "tunes",
    name: "Tunes",
    hosts: ["tunes.example"],
    source: "parousia",
    data: ["media"],
    origins: ["https://tunes.example/*"],
    settings: [{ id: "prefix", title: "Prefix", type: "text", default: "Listening to" }],
  },
  match: { patterns: ["https://tunes.example/*"] },
};
const premid: ActivityManifest = {
  info: {
    id: "premid:Tunes",
    name: "Tunes",
    hosts: ["tunes.example"],
    source: "premid",
    icon: "https://cdn.example/tunes.png",
    origins: ["*://tunes.example/*"],
  },
  match: { regExp: "^https?://tunes[.]example/" },
  script: { file: "tunes", clientIds: ["503557087041683458"] },
};

describe("one manifest for both sources", () => {
  test("match patterns and PreMiD's regExp go through the same compiler", () => {
    for (const manifest of [native, premid]) {
      const matches = compileMatch(manifest.match);
      expect(matches(new URL("https://tunes.example/song/1"))).toBe(true);
      expect(matches(new URL("https://tunes.example.evil.test/"))).toBe(false);
    }
    expect(compileMatch(premid.match)(new URL(`https://tunes.example/${"x".repeat(3000)}`))).toBe(
      false,
    );
  });

  test("a native Activity gets the page data it's granted, and nothing a page script reported", () => {
    const activity = registered(native, {
      detect: (page, settings) => ({
        id: "anything",
        name: "Tunes",
        url: page.url.href,
        details: page.media?.title ? `${String(settings.prefix)} ${page.media.title}` : page.title,
        state: page.granted.join(","),
      }),
    });
    const registry = new ActivityRegistry();
    registry.register(activity);
    const runtime = new PresenceRuntime(registry);
    const url = new URL("https://tunes.example/song/1");
    expect(
      runtime.resolve({
        url,
        title: "Song - Tunes",
        granted: ["media"],
        data: { media: { title: "Song" } },
        reported: { id: "tunes", name: "Spoofed", url: url.href },
      }).activity,
    ).toEqual({
      id: "tunes",
      name: "Tunes",
      url: url.href,
      details: "Listening to Song",
      state: "media",
    });
    // With every kind switched off in Settings > Privacy: the URL and title.
    expect(runtime.resolve({ url, title: "Song - Tunes", granted: [] }).activity).toMatchObject({
      details: "Song - Tunes",
      state: "",
    });
  });

  test("a PreMiD Activity shows its own report, and nothing else", () => {
    const activity = registered(premid);
    const url = new URL("https://tunes.example/song/1?session=secret");
    expect(activity.detect({ url, title: "" }, {})).toBeNull();
    expect(
      activity.detect(
        { url, title: "", reported: { id: "premid:Other", name: "Other", url: url.href } },
        {},
      ),
    ).toBeNull();
    const own = { id: "premid:Tunes", name: "Tunes", details: "Listening" };
    expect(activity.detect({ url, title: "", reported: own }, {})).toEqual(own);
  });

  test("packaged files are read back only when they have the expected shape", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(premid)))).toEqual(premid);
    expect(parseManifest({ ...premid, match: {} })).toBeNull();
    expect(parseManifest({ ...premid, script: { file: "x", clientIds: [] } })).toBeNull();
    expect(
      parseCatalog({ sources: { premid: "abc" }, activities: [native.info, { id: 1 }] }),
    ).toEqual({
      sources: { premid: "abc" },
      activities: [native.info],
    });
    expect(
      parseIndex({
        files: { a: "premid/a-b", b: "native/b", c: "../secret", d: "premid/A", e: 1 },
      }),
    ).toEqual({ files: { a: "premid/a-b", b: "native/b" } });
    expect(
      parseHosts({
        hosts: { "a.example": ["premid/a", "/etc/passwd", 3], "b.example": "premid/b" },
      }),
    ).toEqual({ hosts: { "a.example": ["premid/a"] } });
  });

  test("an index of sites finds a page's host, and each domain above it, never a top-level domain alone", () => {
    expect(hostKeys("www.youtube.com")).toEqual(["www.youtube.com", "youtube.com"]);
    expect(hostKeys("a.b.example.co.uk")).toEqual([
      "a.b.example.co.uk",
      "b.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(hostKeys("localhost")).toEqual(["localhost"]);
  });

  test("the catalog lists an Activity without what only its own page needs", () => {
    const entry = catalogEntry({
      ...native.info,
      settings: [{ id: "a", title: "A", type: "boolean", default: true }],
      data: ["media"],
      origins: ["https://tunes.example/*"],
      discordClientId: "1553980756731363428",
      variants: ["tunes", "premid:Tunes"],
    });
    expect(entry).toEqual({
      id: "tunes",
      name: "Tunes",
      hosts: ["tunes.example"],
      source: "parousia",
      origins: ["https://tunes.example/*"],
      variants: ["tunes", "premid:Tunes"],
    });
  });
});
