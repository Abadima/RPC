import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import { ActivityRegistry } from "./registry";
import { PresenceRuntime } from "./runtime";

describe("PresenceRuntime", () => {
  test("resolves a registered activity for a matching url", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "example", name: "Example", hosts: ["example.com"], source: "parousia" },
      matcher: (url) => url.hostname === "example.com",
      detect: ({ url }) => ({ id: "example", name: "Example", url: url.href }),
    });

    const runtime = new PresenceRuntime(registry);
    const presence = runtime.resolve({ url: new URL("https://example.com"), title: "" });

    expect(presence.activity?.id).toBe("example");
  });

  test("hands detection the title, and stamps the catalog's Discord Application", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: {
        id: "titled",
        name: "Titled",
        hosts: ["example.com"],
        source: "parousia",
        discordClientId: "1553980756731363428",
      },
      matcher: (url) => url.hostname === "example.com",
      detect: ({ url, title }) => ({ id: "titled", name: title, url: url.href }),
    });
    const runtime = new PresenceRuntime(registry);
    const presence = runtime.resolve({ url: new URL("https://example.com"), title: "Chess" });

    expect(presence.activity).toEqual({
      id: "titled",
      name: "Chess",
      url: "https://example.com/",
      discordClientId: "1553980756731363428",
    });
    expect(runtime.matches(new URL("https://example.com/x"))).toBe(true);
    expect(runtime.matches(new URL("https://other.example"))).toBe(false);
  });

  test("an Activity from another extension takes a page over, and only a page", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "example", name: "Example", hosts: ["example.com"], source: "parousia" },
      matcher: (url) => url.hostname === "example.com",
      detect: ({ url }) => ({ id: "example", name: "Example", url: url.href }),
    });
    let external: Activity | null = { id: "compat:other", name: "Other" };
    const runtime = new PresenceRuntime(registry, {
      external: () => external,
      fallback: () => ({ id: "default", name: "Default" }),
    });
    const page = { url: new URL("https://example.com"), title: "" };

    expect(runtime.resolve(page).activity?.id).toBe("compat:other");
    expect(
      runtime.resolve({ url: new URL("https://unmatched.example"), title: "" }).activity?.id,
    ).toBe("compat:other");
    // No page (a browser page) is only ever the fallback.
    expect(runtime.resolve(null).activity?.id).toBe("default");

    external = null;
    expect(runtime.resolve(page).activity?.id).toBe("example");
  });

  test("returns a null activity when nothing matches", () => {
    const runtime = new PresenceRuntime(new ActivityRegistry());
    const presence = runtime.resolve({ url: new URL("https://unmatched.example"), title: "" });

    expect(presence.activity).toBeNull();
  });

  test("skips Activities that are off, and hands detection its settings", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: {
        id: "first",
        name: "First",
        hosts: ["example.com"],
        source: "parousia",
      },
      matcher: () => true,
      detect: ({ url }) => ({ id: "first", name: "First", url: url.href }),
    });
    registry.register({
      info: {
        id: "second",
        name: "Second",
        hosts: ["example.com"],
        source: "parousia",
        settings: [{ id: "label", title: "Label", type: "text", default: "Default" }],
      },
      matcher: () => true,
      detect: ({ url }, settings) => ({
        id: "second",
        name: String(settings.label),
        url: url.href,
      }),
    });
    const page = { url: new URL("https://example.com"), title: "" };

    expect(new PresenceRuntime(registry).resolve(page).activity?.id).toBe("first");
    const second = new PresenceRuntime(registry, { usable: (info) => info.id !== "first" });
    expect(second.resolve(page).activity?.name).toBe("Default");
    const set = new PresenceRuntime(registry, {
      usable: (info) => info.id !== "first",
      settings: () => ({ label: "Chosen" }),
    });
    expect(set.resolve(page).activity?.name).toBe("Chosen");
    expect(new PresenceRuntime(registry, { usable: () => false }).matches(page.url)).toBe(false);
    // Usable is decided per page: an Activity without access to one site still runs on another.
    const perSite = new PresenceRuntime(registry, {
      usable: (info, url) => info.id !== "first" || url.hostname === "granted.example",
    });
    expect(
      perSite.resolve({ url: new URL("https://granted.example"), title: "" }).activity?.id,
    ).toBe("first");
    expect(perSite.resolve(page).activity?.id).toBe("second");
  });

  test("only a PreMiD Activity's own report picks its Discord Application", () => {
    const registry = new ActivityRegistry();
    for (const source of ["parousia", "premid"] as const) {
      registry.register({
        info: {
          id: source,
          name: source,
          hosts: [`${source}.example`],
          source,
          discordClientId: "1111111111111111111",
        },
        matcher: (url) => url.hostname === `${source}.example`,
        detect: ({ url }) => ({
          id: source,
          name: source,
          url: url.href,
          discordClientId: "2222222222222222222",
        }),
      });
    }
    const runtime = new PresenceRuntime(registry);
    const clientId = (host: string): string | undefined =>
      runtime.resolve({ url: new URL(`https://${host}`), title: "" }).activity?.discordClientId;

    expect(clientId("parousia.example")).toBe("1111111111111111111");
    expect(clientId("premid.example")).toBe("2222222222222222222");
  });

  describe("the large image", () => {
    const LOGO = "https://music.youtube.com/img/favicon_32.png";
    const COVER = "https://lh3.googleusercontent.com/cover=w544-h544";

    /** A music site: the song's cover when the page gave one, nothing else. */
    function music(source: "parousia" | "premid", icon?: string): PresenceRuntime {
      const registry = new ActivityRegistry();
      registry.register({
        info: {
          id: "music",
          name: "Music",
          hosts: ["music.example"],
          source,
          ...(icon && { icon }),
        },
        matcher: (url) => url.hostname === "music.example",
        detect: ({ url, data }) => ({
          id: "music",
          name: "Music",
          url: url.href,
          ...(data?.thumbnail && { assets: { largeImage: data.thumbnail } }),
        }),
      });
      return new PresenceRuntime(registry);
    }
    const page = (extra: object = {}) => ({
      url: new URL("https://music.example/watch"),
      title: "Song",
      ...extra,
    });

    test("is the site's logo, not Discord's Application icon, when the Activity has none", () => {
      // Paused, browsing, thumbnails switched off, or a page with no artwork: no image of its own.
      for (const source of ["parousia", "premid"] as const) {
        const { activity } = music(source, LOGO).resolve(page());
        expect(activity?.assets).toEqual({ largeImage: LOGO });
      }
    });

    test("is the Activity's own when Discord can show it", () => {
      const { activity } = music("parousia", LOGO).resolve(page({ data: { thumbnail: COVER } }));
      expect(activity?.assets).toEqual({ largeImage: COVER });
    });

    test("is the site's logo when the Activity's own is one Discord would drop", () => {
      // Desktop and Discord-RPC-Extension's mapping both drop an image over 256 characters.
      const long = `https://lh3.googleusercontent.com/${"a".repeat(300)}=w544-h544`;
      const { activity } = music("parousia", LOGO).resolve(page({ data: { thumbnail: long } }));
      expect(activity?.assets).toEqual({ largeImage: LOGO });
    });

    test("falls back to the tab's favicon when the Activity has no icon", () => {
      const runtime = music("parousia");
      const favicon = "https://music.example/static/favicon-192.png?v=9";
      expect(runtime.resolve(page({ favicon })).activity?.assets).toEqual({
        largeImage: "https://music.example/static/favicon-192.png",
      });
      // The catalog's icon is the site's logo: it comes first.
      expect(music("parousia", LOGO).resolve(page({ favicon })).activity?.assets).toEqual({
        largeImage: LOGO,
      });
    });

    test("is left out, so Discord's own icon shows, only with no site image at all", () => {
      const runtime = music("parousia");
      expect(runtime.resolve(page()).activity?.assets).toBeUndefined();
      // A favicon Discord can't show doesn't count.
      expect(
        runtime.resolve(page({ favicon: "https://music.example/favicon.ico" })).activity?.assets,
      ).toBeUndefined();
    });

    test("isn't borrowed from a page for the Default Activity, which isn't a site's", () => {
      const registry = new ActivityRegistry();
      const fallback = { id: "parousia:default", name: "Away" };
      const runtime = new PresenceRuntime(registry, { fallback: () => fallback });
      const { activity } = runtime.resolve({
        url: new URL("https://unmatched.example"),
        title: "",
        favicon: "https://unmatched.example/favicon.png",
      });
      expect(activity).toEqual(fallback);
    });
  });

  test("an Activity that throws shows nothing, and doesn't stop detection", () => {
    const registry = new ActivityRegistry();
    registry.register({
      info: { id: "broken", name: "Broken", hosts: ["example.com"], source: "parousia" },
      matcher: () => true,
      detect: () => {
        throw new Error("broken");
      },
    });
    const runtime = new PresenceRuntime(registry);
    expect(runtime.resolve({ url: new URL("https://example.com"), title: "" }).activity).toBeNull();
  });

  test("lists each registered Activity's catalog entry, in order", () => {
    const registry = new ActivityRegistry();
    for (const id of ["a", "b"]) {
      registry.register({
        info: { id, name: id.toUpperCase(), hosts: [`${id}.example`], source: "parousia" },
        matcher: () => false,
        detect: () => null,
      });
    }
    expect(registry.list().map((info) => info.id)).toEqual(["a", "b"]);
  });
});
