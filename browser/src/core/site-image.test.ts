import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import { MAX_IMAGE, faviconImage, isShowableImage, withSiteImage } from "./site-image";

const ICON = "https://www.youtube.com/logo.png";
const base: Activity = { id: "site", name: "Site" };

describe("isShowableImage", () => {
  test("takes https addresses within Discord's limit and short asset keys", () => {
    expect(isShowableImage("https://i.ytimg.com/vi/abc/mqdefault.jpg")).toBe(true);
    expect(isShowableImage("parousia-square")).toBe(true);
    expect(isShowableImage(`https://x.example/${"a".repeat(MAX_IMAGE)}`)).toBe(false);
    expect(isShowableImage(`https://x.example/${"a".repeat(MAX_IMAGE - 18)}`)).toBe(true);
    expect(isShowableImage("http://insecure.example/a.png")).toBe(false);
    expect(isShowableImage("data:image/png;base64,AAAA")).toBe(false);
    expect(isShowableImage("has spaces")).toBe(false);
    expect(isShowableImage("")).toBe(false);
    expect(isShowableImage(undefined)).toBe(false);
  });

  test("refuses an https address that isn't a real one, which Discord couldn't fetch", () => {
    for (const value of [
      "https://",
      "https:///",
      "https:///logo.png",
      "https://?x=1",
      "https://#top",
      "https://exa mple.com/a.png",
      "https://exa<mple.com/a.png",
      "https://[::1/a.png",
      "https://example.com:99999/a.png",
      "HTTPS://",
    ]) {
      expect(isShowableImage(value)).toBe(false);
    }
    expect(isShowableImage("HTTPS://Example.com/a.png")).toBe(true);
    expect(isShowableImage("https://example.com:8443/a.png?v=1")).toBe(true);
  });
});

describe("faviconImage", () => {
  test("keeps only the icon's own address", () => {
    expect(faviconImage("https://example.com/icons/favicon-32.png?v=3#top")).toBe(
      "https://example.com/icons/favicon-32.png",
    );
  });

  test("refuses what Discord can't be relied on to show, or what carries more than an address", () => {
    for (const value of [
      "http://example.com/favicon.png",
      "https://example.com/favicon.ico",
      "https://example.com/favicon.SVG",
      "https://user:secret@example.com/favicon.png",
      "data:image/png;base64,AAAA",
      "chrome://favicon/https://example.com",
      "not a url",
      `https://example.com/${"a".repeat(MAX_IMAGE)}.png`,
      "",
      undefined,
    ]) {
      expect(faviconImage(value)).toBeUndefined();
    }
  });
});

describe("withSiteImage", () => {
  test("leaves an image Discord can show alone", () => {
    const activity: Activity = {
      ...base,
      assets: { largeImage: "https://i.ytimg.com/vi/abc/mqdefault.jpg", largeText: "Album" },
    };
    expect(withSiteImage(activity, { icon: ICON }, "https://x.example/f.png")).toBe(activity);
  });

  test("shows the site's logo where the Activity has no large image", () => {
    expect(withSiteImage(base, { icon: ICON })).toEqual({ ...base, assets: { largeImage: ICON } });
    // Captions and the small image stay.
    expect(
      withSiteImage(
        { ...base, assets: { largeText: "Album", smallImage: "play" } },
        { icon: ICON },
      ),
    ).toEqual({ ...base, assets: { largeText: "Album", smallImage: "play", largeImage: ICON } });
  });

  test("replaces an image Discord would drop (too long, or inline) with the site's logo", () => {
    const tooLong = `https://lh3.googleusercontent.com/${"a".repeat(300)}`;
    for (const largeImage of [tooLong, "data:image/png;base64,AAAA", "http://x.example/a.png"]) {
      const shown = withSiteImage({ ...base, assets: { largeImage } }, { icon: ICON });
      expect(shown.assets?.largeImage).toBe(ICON);
    }
  });

  test("a malformed https image falls back to the site's logo, then its favicon", () => {
    const favicon = "https://www.example.com/static/favicon-196.png";
    for (const largeImage of ["https://", "https:///x.png", "https://exa mple.com/a.png"]) {
      const activity: Activity = { ...base, assets: { largeImage, largeText: "Album" } };
      expect(withSiteImage(activity, { icon: ICON }).assets).toEqual({
        largeText: "Album",
        largeImage: ICON,
      });
      expect(withSiteImage(activity, {}, favicon).assets?.largeImage).toBe(favicon);
      expect(withSiteImage(activity, {}).assets).toEqual({ largeText: "Album" });
    }
    // A malformed icon doesn't block the favicon either.
    expect(withSiteImage(base, { icon: "https://" }, favicon).assets?.largeImage).toBe(favicon);
  });

  test("the site's logo comes before its favicon, and the favicon before nothing", () => {
    const favicon = "https://www.example.com/static/favicon-196.png?v=2";
    expect(withSiteImage(base, { icon: ICON }, favicon).assets?.largeImage).toBe(ICON);
    expect(withSiteImage(base, {}, favicon).assets?.largeImage).toBe(
      "https://www.example.com/static/favicon-196.png",
    );
    // An icon that can't be shown doesn't block the favicon.
    expect(
      withSiteImage(base, { icon: "http://x.example/a.png" }, favicon).assets?.largeImage,
    ).toBe("https://www.example.com/static/favicon-196.png");
  });

  test("with no site image at all, an image that couldn't be shown is left out, not sent to be dropped", () => {
    expect(withSiteImage(base, {})).toBe(base);
    const dropped = withSiteImage(
      { ...base, assets: { largeImage: "x".repeat(300), largeText: "Album" } },
      {},
      "https://example.com/favicon.ico",
    );
    expect(dropped.assets).toEqual({ largeText: "Album" });
    expect(
      withSiteImage({ ...base, assets: { largeImage: "x".repeat(300) } }, {}).assets,
    ).toBeUndefined();
  });
});
