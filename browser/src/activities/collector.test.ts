import { describe, expect, test } from "bun:test";
import { collect, loadedImages, unchanged } from "./collector";

/** Enough of a document: its media elements, and an og:image. */
function page(
  media: Array<{ paused: boolean; currentTime: number; duration: number }>,
  ogImage?: string,
) {
  return {
    querySelectorAll: () => media,
    querySelector: () => (ogImage ? { getAttribute: () => ogImage } : null),
  } as unknown as Pick<Document, "querySelector" | "querySelectorAll">;
}

const session = {
  mediaSession: {
    metadata: {
      title: "  Song  ",
      artist: "Artist",
      album: "",
      artwork: [
        { src: "https://img.example/96.jpg", sizes: "96x96" },
        { src: "http://img.example/1024.jpg", sizes: "1024x1024" },
        { src: "https://img.example/512.jpg", sizes: "512x512" },
      ],
    } as unknown as MediaMetadata,
  },
};

describe("the page-data collector", () => {
  test("reads what's playing from the Media Session and the playing media element", () => {
    const data = collect(
      ["media"],
      page([
        { paused: true, currentTime: 5, duration: 60 },
        { paused: false, currentTime: 42.5, duration: Number.NaN },
      ]),
      session,
      1_700_000_000_000,
    );
    expect(data).toEqual({
      media: { title: "Song", artist: "Artist", playing: true, start: 1_699_999_958_000 },
    });
  });

  test("says whether the element it read is a video or an audio", () => {
    const element = (localName: string) => ({
      localName,
      paused: false,
      currentTime: 1,
      duration: 10,
    });
    const kind = (localName: string) =>
      collect(["media"], page([element(localName) as never]), {}, 0).media?.kind;
    expect(kind("video")).toBe("video");
    expect(kind("audio")).toBe("audio");
    expect(kind("div")).toBeUndefined();
  });

  test("gives a playing item's clock as timestamps, rounded to the second", () => {
    const now = 1_700_000_000_400;
    const media = collect(
      ["media"],
      page([{ paused: false, currentTime: 42.5, duration: 200.4 }]),
      session,
      now,
    ).media;
    expect(media?.duration).toBe(200.4);
    expect(media?.start).toBe(1_699_999_958_000);
    expect(media?.end).toBe(1_699_999_958_000 + 200_000);
    // Paused: no clock to show.
    const paused = collect(
      ["media"],
      page([{ paused: true, currentTime: 42.5, duration: 200 }]),
      session,
      now,
    ).media;
    expect(paused).toEqual({ title: "Song", artist: "Artist", playing: false, duration: 200 });
  });

  test("the page's own word on whether it's playing outranks its media element", () => {
    const element = [{ paused: false, currentTime: 1, duration: 10 }];
    const said = (playbackState: string) => ({
      mediaSession: { ...session.mediaSession, playbackState },
    });
    expect(collect(["media"], page(element), said("paused")).media?.playing).toBe(false);
    expect(collect(["media"], page(element), said("paused")).media?.start).toBeUndefined();
    expect(collect(["media"], page(element), said("none")).media?.playing).toBe(true);
    const idle = [{ paused: true, currentTime: 0, duration: 10 }];
    expect(collect(["media"], page(idle), said("playing")).media?.playing).toBe(true);
    // No element at all (a page that only sets the session): the session still says.
    expect(collect(["media"], page([]), said("playing")).media).toEqual({
      title: "Song",
      artist: "Artist",
      playing: true,
    });
  });

  test("a song playing through is no news; a pause, a seek, or a new song is", () => {
    const at = (now: number, time: number, title = "Song") =>
      collect(
        ["media"],
        page([{ paused: false, currentTime: time, duration: 200 }]),
        {
          mediaSession: {
            metadata: { title } as unknown as MediaMetadata,
            playbackState: "playing",
          },
        },
        now,
      );
    const first = at(1_700_000_000_000, 10);
    expect(unchanged(first, null)).toBe(false);
    expect(unchanged(at(1_700_000_001_000, 11), first)).toBe(true);
    expect(unchanged(at(1_700_000_002_000, 12.4), first)).toBe(true);
    expect(unchanged(at(1_700_000_003_000, 60), first)).toBe(false);
    expect(unchanged(at(1_700_000_001_000, 11, "Other"), first)).toBe(false);
    const paused = collect(["media"], page([{ paused: true, currentTime: 11, duration: 200 }]), {
      mediaSession: {
        metadata: { title: "Song" } as unknown as MediaMetadata,
        playbackState: "paused",
      },
    });
    expect(unchanged(paused, first)).toBe(false);
    expect(unchanged(paused, paused)).toBe(true);
  });

  test("takes the largest https artwork, or the page's og:image", () => {
    expect(collect(["thumbnails"], page([]), session)).toEqual({
      thumbnail: "https://img.example/512.jpg",
    });
    expect(collect(["thumbnails"], page([], "https://site.example/og.png"), {})).toEqual({
      thumbnail: "https://site.example/og.png",
    });
    expect(collect(["thumbnails"], page([], "javascript:alert(1)"), {})).toEqual({});
  });

  test("lists the page's loaded https images, in page order, with their alt text", () => {
    const img = (src: string, alt: string, side = 230, complete = true) => ({
      currentSrc: src,
      src,
      alt,
      complete,
      naturalWidth: side,
      naturalHeight: side,
    });
    const doc = {
      querySelectorAll: () => [
        img("https://site.example/logo.png", "", 20), // an icon
        img("https://site.example/cover-large.jpg", "  Show cover  "),
        img("https://site.example/cover-large.jpg", "again"), // repeated
        img("http://site.example/insecure.jpg", "no"),
        img("https://site.example/loading.jpg", "not yet", 230, false),
        img("https://site.example/avatar.png", "Abadima", 100),
        { src: "", currentSrc: "", alt: "", complete: true, naturalWidth: 200, naturalHeight: 200 },
        img(`https://site.example/${"x".repeat(400)}.jpg`, "too long"),
      ],
    } as unknown as Pick<Document, "querySelectorAll">;
    expect(loadedImages(doc)).toEqual([
      { src: "https://site.example/cover-large.jpg", alt: "Show cover" },
      { src: "https://site.example/avatar.png", alt: "Abadima" },
    ]);
    expect(collect(["thumbnails"], { ...doc, querySelector: () => null }, {}).images?.length).toBe(
      2,
    );
    expect(collect(["media"], { ...doc, querySelector: () => null }, {}).images).toBeUndefined();
  });

  test("keeps at most a message's worth of images", () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      currentSrc: `https://site.example/${index}.jpg`,
      src: "",
      alt: "",
      complete: true,
      naturalWidth: 100,
      naturalHeight: 100,
    }));
    const doc = { querySelectorAll: () => many } as unknown as Pick<Document, "querySelectorAll">;
    expect(loadedImages(doc)).toHaveLength(24);
  });

  test("reads nothing it isn't allowed", () => {
    expect(
      collect(
        [],
        page([{ paused: false, currentTime: 1, duration: 2 }], "https://x.example/a.png"),
        session,
      ),
    ).toEqual({});
    expect(
      collect(["thumbnails"], page([{ paused: false, currentTime: 1, duration: 2 }]), session)
        .media,
    ).toBeUndefined();
  });
});
