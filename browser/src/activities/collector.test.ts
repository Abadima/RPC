import { afterEach, describe, expect, test } from "bun:test";
import { collect, loadedImages, startCollector, unchanged } from "./collector";

function page(
  media: Array<{ paused: boolean; currentTime: number; duration: number }>,
  ogImage?: string,
) {
  return {
    querySelectorAll: () => media,
    querySelector: () => (ogImage ? { getAttribute: () => ogImage } : null),
    images: [],
  } as unknown as Pick<Document, "querySelector" | "querySelectorAll" | "images">;
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

  test("artwork a page lists without end costs a bounded look, and never throws", () => {
    const long = `${"9".repeat(200_000)}x1`;
    const artwork = Array.from({ length: 10_000 }, (_, index) => ({
      src: `https://img.example/${index}.jpg`,
      sizes: index === 3 ? "1024x1024" : long,
    }));
    artwork.splice(20, 0, { src: "https://img.example/late.jpg", sizes: "4096x4096" });
    const huge = {
      mediaSession: { metadata: { title: "Song", artwork } as unknown as MediaMetadata },
    };
    expect(collect(["thumbnails"], page([]), huge)).toEqual({
      thumbnail: "https://img.example/3.jpg",
    });
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
      querySelectorAll: () => [],
      images: [
        img("https://site.example/logo.png", "", 20), // an icon
        img("https://site.example/cover-large.jpg", "  Show cover  "),
        img("https://site.example/cover-large.jpg", "again"), // repeated
        img("http://site.example/insecure.jpg", "no"),
        img("https://site.example/loading.jpg", "not yet", 230, false),
        img("https://site.example/avatar.png", "Abadima", 100),
        { src: "", currentSrc: "", alt: "", complete: true, naturalWidth: 200, naturalHeight: 200 },
        img(`https://site.example/${"x".repeat(400)}.jpg`, "too long"),
      ],
    } as unknown as Pick<Document, "querySelectorAll" | "images">;
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
    const doc = { images: many } as unknown as Pick<Document, "images">;
    expect(loadedImages(doc)).toHaveLength(24);
  });

  test("looks at the first 400 images only, however many the page has", () => {
    const read: number[] = [];
    const tiny = { currentSrc: "", src: "", alt: "", complete: true, naturalWidth: 1 };
    const images = new Proxy([] as unknown[], {
      get: (target, key) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          read.push(Number(key));
          return Number(key) < 5000 ? tiny : undefined;
        }
        return Reflect.get(target, key);
      },
    });
    expect(loadedImages({ images } as unknown as Pick<Document, "images">)).toEqual([]);
    expect(read).toHaveLength(400);
    expect(Math.max(...read)).toBe(399);
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

describe("the collector in a tab that is not shown", () => {
  const scope = globalThis as Record<string, unknown>;
  const globals = ["window", "document", "chrome", "location"] as const;
  const before = new Map<string, PropertyDescriptor | undefined>(
    [...globals, "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(scope, key)]),
  );
  afterEach(() => {
    for (const [key, descriptor] of before) {
      if (descriptor) Object.defineProperty(scope, key, descriptor);
      else delete scope[key];
    }
  });

  function playing() {
    const posted: Array<{ type: string; data?: { media?: { title?: string } } }> = [];
    const receivers: Array<(message: unknown) => void> = [];
    const documentListeners = new Map<string, () => void>();
    const metadata = { title: "Song A" };
    const document = {
      hidden: false,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: (type: string, listener: () => void) =>
        documentListeners.set(type, listener),
      removeEventListener: () => {},
    };
    const define = (key: string, value: unknown): void => {
      Object.defineProperty(scope, key, { value, configurable: true, writable: true });
    };
    define("window", { addEventListener: () => {}, removeEventListener: () => {} });
    define("location", { pathname: "/play", search: "" });
    define("document", document);
    define("navigator", { mediaSession: { metadata, playbackState: "playing" } });
    define("chrome", {
      runtime: {
        connect: () => ({
          postMessage: (message: (typeof posted)[number]) => posted.push(message),
          onMessage: { addListener: (l: (message: unknown) => void) => receivers.push(l) },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
        }),
      },
    });
    startCollector("tunes");
    const receive = (message: object): void => receivers.forEach((l) => l(message));
    return {
      receive,
      titles: () =>
        posted.filter((m) => m.type === "data").map((m) => m.data?.media?.title ?? null),
      setTitle: (title: string) => {
        metadata.title = title;
      },
      setHidden: (hidden: boolean) => {
        document.hidden = hidden;
        documentListeners.get("visibilitychange")?.();
      },
    };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1200));

  test("reads a new song only while the background keeps its music or video", async () => {
    const { receive, titles, setTitle, setHidden } = playing();
    receive({ type: "collect", kinds: ["media"] });
    expect(titles()).toEqual(["Song A"]);

    setTitle("Song B");
    await tick();
    expect(titles()).toEqual(["Song A", "Song B"]);

    setHidden(true);
    setTitle("Song C");
    await tick();
    expect(titles()).toEqual(["Song A", "Song B"]);

    receive({ type: "background", on: true });
    expect(titles()).toEqual(["Song A", "Song B", "Song C"]);
    setTitle("Song D");
    await tick();
    expect(titles()).toEqual(["Song A", "Song B", "Song C", "Song D"]);

    receive({ type: "background", on: false });
    setTitle("Song E");
    await tick();
    expect(titles()).toEqual(["Song A", "Song B", "Song C", "Song D"]);

    setHidden(false);
    await tick();
    expect(titles().at(-1)).toBe("Song E");
    receive({ type: "stop" });
  }, 15_000);
});
