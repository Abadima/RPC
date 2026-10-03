import { describe, expect, test } from "bun:test";
import { manualTimers } from "../core/test-desktop";
import {
  MALSYNC_ACTIVITY_ID,
  MALSYNC_EXTENSION_IDS,
  MalSyncSource,
  parseMalSyncReply,
} from "./malsync";

const MALSYNC = "606504719212478504";
const ANIME_APP = "823563096747802695";
const PAGE = new URL("https://stream.example/watch/frieren/3?token=secret");
const START = 1_700_000_000_000;

/** What MAL-Sync's content script answers on an episode it recognized (syncPage.ts, `presence`). */
function reply(overrides: Record<string, unknown> = {}, clientId = MALSYNC): unknown {
  return {
    clientId,
    presence: {
      details: "Sousou no Frieren",
      state: "Episode 3/28",
      largeImageKey: "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
      largeImageText: "MAL-Sync",
      smallImageKey: "play",
      smallImageText: "Playing",
      startTimestamp: START,
      endTimestamp: START + 1_440_000,
      buttons: [{ label: "View Anime", url: "https://myanimelist.net/anime/52991" }],
      instance: true,
      type: 3,
      ...overrides,
    },
  };
}

describe("parseMalSyncReply", () => {
  test("reads an episode as a Watching Activity under MAL-Sync's own Discord Application", () => {
    expect(parseMalSyncReply(reply(), PAGE)).toEqual({
      id: MALSYNC_ACTIVITY_ID,
      name: "MAL-Sync",
      url: "https://stream.example/watch/frieren/3",
      discordClientId: MALSYNC,
      details: "Sousou no Frieren",
      state: "Episode 3/28",
      type: "watching",
      assets: {
        largeImage: "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
        largeText: "MAL-Sync",
        smallImage: "play",
        smallText: "Playing",
      },
      timestamps: { start: START, end: START + 1_440_000 },
      buttons: [{ label: "View Anime", url: "https://myanimelist.net/anime/52991" }],
    });
  });

  test("takes the series title as the name when MAL-Sync puts it there, and the Anime and Manga Applications", () => {
    const activity = parseMalSyncReply(
      reply({ name: "Sousou no Frieren", details: undefined }, ANIME_APP),
      PAGE,
    );
    expect(activity?.name).toBe("Sousou no Frieren");
    expect(activity?.discordClientId).toBe(ANIME_APP);
    expect(activity?.details).toBeUndefined();
  });

  test("{} and anything that isn't its reply is nothing to show", () => {
    for (const value of [
      {},
      undefined,
      null,
      "presence",
      7,
      [],
      { clientId: MALSYNC },
      { presence: {} },
      { clientId: 606504719, presence: {} },
      { clientId: MALSYNC, presence: "x" },
    ]) {
      expect(parseMalSyncReply(value, PAGE)).toBeNull();
    }
  });

  test("turns down a reply for a Discord Application MAL-Sync doesn't use, whole", () => {
    expect(parseMalSyncReply(reply({}, "1553980756731363428"), PAGE)).toBeNull();
    expect(parseMalSyncReply(reply({}, "not-an-id"), PAGE)).toBeNull();
  });

  test("bounds what a page can put in it", () => {
    const activity = parseMalSyncReply(
      reply({
        details: "x".repeat(10_000),
        // Parsing keeps a presence's first two buttons, so the bad ones follow the good.
        buttons: [
          { label: "One", url: "https://a.example/1" },
          { label: "Bad", url: "javascript:alert(1)" },
          { label: "File", url: "file:///etc/passwd" },
          { label: "Three", url: "https://a.example/3" },
        ],
        largeImageKey: "data:image/png;base64,AAAA",
        startTimestamp: "now",
      }),
      PAGE,
    );
    expect(activity?.details).toHaveLength(256);
    expect(activity?.buttons).toEqual([{ label: "One", url: "https://a.example/1" }]);
    expect(activity?.assets?.largeImage).toBeUndefined();
    expect(activity?.timestamps?.start).toBeUndefined();
    expect(parseMalSyncReply(reply({ details: "x".repeat(20_000) }), PAGE)).toBeNull();
  });

  test("keeps the page's own address off the wire: a link to the site being watched isn't passed on", () => {
    const activity = parseMalSyncReply(
      reply({
        buttons: [
          { label: "View Anime", url: "https://myanimelist.net/anime/52991" },
          { label: "Watch", url: "https://www.stream.example/watch/frieren/3?token=secret" },
        ],
        detailsUrl: "https://stream.example/watch/frieren/3",
      }),
      PAGE,
    );
    expect(activity?.buttons).toEqual([
      { label: "View Anime", url: "https://myanimelist.net/anime/52991" },
    ]);
    expect(activity?.detailsUrl).toBeUndefined();
    const lone = parseMalSyncReply(reply({ buttons: [{ label: "Watch", url: PAGE.href }] }), PAGE);
    expect(lone?.buttons).toBeUndefined();
  });
});

describe("MalSyncSource", () => {
  function harness(answer: (tabId: number) => unknown = () => reply()) {
    const timers = manualTimers();
    const asked: number[] = [];
    let changes = 0;
    let handler = answer;
    const source = new MalSyncSource({
      ask: async (tabId) => {
        asked.push(tabId);
        const value = handler(tabId);
        if (value instanceof Error) throw value;
        return value;
      },
      setTimer: timers.setTimer,
      onChange: () => changes++,
    });
    return {
      source,
      timers,
      asked,
      changes: () => changes,
      answer: (next: (tabId: number) => unknown) => {
        handler = next;
      },
    };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** Time passing a second at a time: a retry is scheduled only once the answer to the last question has landed. */
  async function elapse(timers: { advance: (ms: number) => void }, ms: number): Promise<void> {
    for (let spent = 0; spent < ms; spent += 1000) {
      timers.advance(1000);
      await settle();
    }
  }
  const watching = { id: 7, url: PAGE };

  test("is idle until it's enabled and there's a tab: nothing asked, nothing scheduled", async () => {
    const { source, asked, timers, changes } = harness();
    source.watch(watching);
    await settle();
    expect(asked).toEqual([]);
    expect(timers.pending()).toBe(0);
    expect(source.current()).toBeNull();

    source.setEnabled(true);
    await settle();
    expect(asked).toEqual([7]);
    expect(source.current()?.details).toBe("Sousou no Frieren");
    expect(changes()).toBe(1);
  });

  test("asks again every 15 seconds while it has something to show, and only a change is news", async () => {
    const { source, asked, timers, changes, answer } = harness();
    source.setEnabled(true);
    source.watch(watching);
    await settle();
    expect(changes()).toBe(1);

    // The player's clock drifts a little between questions: the same playback.
    answer(() => reply({ startTimestamp: START + 1200, endTimestamp: START + 1_441_200 }));
    timers.advance(15_000);
    await settle();
    expect(asked).toHaveLength(2);
    expect(changes()).toBe(1);
    expect(source.current()?.timestamps).toEqual({ start: START, end: START + 1_440_000 });

    // Paused: a different Activity.
    answer(() =>
      reply({
        smallImageKey: "pause",
        smallImageText: "Paused",
        startTimestamp: START,
        endTimestamp: undefined,
      }),
    );
    timers.advance(15_000);
    await settle();
    expect(changes()).toBe(2);
    expect(source.current()?.assets?.smallImage).toBe("pause");

    // Resumed after a seek: far enough to be a new clock.
    answer(() => reply({ startTimestamp: START - 600_000, endTimestamp: START + 840_000 }));
    timers.advance(15_000);
    await settle();
    expect(changes()).toBe(3);
    expect(source.current()?.timestamps?.start).toBe(START - 600_000);
  });

  test("a page it has nothing for is asked about three more times and then left alone", async () => {
    const { source, asked, timers, changes } = harness(() => ({}));
    source.setEnabled(true);
    source.watch(watching);
    await settle();
    expect(asked).toHaveLength(1);

    for (const [wait, total] of [
      [3000, 2],
      [7000, 3],
      [15_000, 4],
    ] as const) {
      timers.advance(wait);
      await settle();
      expect(asked).toHaveLength(total);
    }
    expect(timers.pending()).toBe(0);
    await elapse(timers, 10 * 60_000);
    expect(asked).toHaveLength(4);
    expect(changes()).toBe(0);
  });

  test("an extension that isn't there, or throws, is the same as an empty answer", async () => {
    for (const absent of [undefined, new Error("Could not establish connection")]) {
      const { source, asked, timers, changes } = harness(() => absent);
      source.setEnabled(true);
      source.watch(watching);
      await settle();
      await elapse(timers, 60_000);
      expect(asked).toHaveLength(4);
      expect(timers.pending()).toBe(0);
      expect(changes()).toBe(0);
      expect(source.current()).toBeNull();
    }
    const throwing = new MalSyncSource({
      ask: () => {
        throw new Error("no runtime");
      },
      onChange: () => {},
    });
    throwing.setEnabled(true);
    expect(() => throwing.watch(watching)).not.toThrow();
  });

  test("something found, then gone, is cleared and told, then asked about a few more times", async () => {
    const { source, asked, timers, changes, answer } = harness();
    source.setEnabled(true);
    source.watch(watching);
    await settle();
    answer(() => ({}));
    timers.advance(15_000);
    await settle();
    expect(source.current()).toBeNull();
    expect(changes()).toBe(2);
    timers.advance(3000);
    await settle();
    expect(asked).toHaveLength(3);
  });

  test("moving to another page drops what the last one showed and ignores its late answer", async () => {
    let release: (value: unknown) => void = () => {};
    const timers = manualTimers();
    const source = new MalSyncSource({
      ask: (tabId) =>
        tabId === 7 ? new Promise((resolve) => (release = resolve)) : Promise.resolve({}),
      setTimer: timers.setTimer,
      onChange: () => {},
    });
    source.setEnabled(true);
    source.watch(watching);
    source.watch({ id: 8, url: new URL("https://stream.example/watch/other/1") });
    release(reply());
    await settle();
    expect(source.current()).toBeNull();

    source.watch(watching);
    expect(source.current()).toBeNull();
  });

  test("the same tab and page again isn't a new look; another address on the same tab is", async () => {
    const { source, asked } = harness();
    source.setEnabled(true);
    source.watch(watching);
    source.watch({ id: 7, url: new URL(PAGE.href) });
    await settle();
    expect(asked).toHaveLength(1);

    source.watch({ id: 7, url: new URL("https://stream.example/watch/frieren/4") });
    await settle();
    expect(asked).toHaveLength(2);
  });

  test("no tab, or turned off, stops everything at once", async () => {
    const { source, asked, timers } = harness();
    source.setEnabled(true);
    source.watch(watching);
    await settle();
    expect(timers.pending()).toBe(1);

    source.watch(null);
    expect(timers.pending()).toBe(0);
    expect(source.current()).toBeNull();

    source.watch(watching);
    await settle();
    expect(source.current()).not.toBeNull();
    source.setEnabled(false);
    expect(timers.pending()).toBe(0);
    expect(source.current()).toBeNull();
    await elapse(timers, 60_000);
    // Once for each time there was a tab to ask about, and nothing since.
    expect(asked).toHaveLength(2);
  });
});

describe("what MAL-Sync is asked", () => {
  test("goes to MAL-Sync's own ids only, and says nothing but a tab number", async () => {
    const calls: Array<{ id: unknown; message: unknown }> = [];
    const keep = globalThis.chrome;
    globalThis.chrome = {
      runtime: {
        getURL: (path: string) => `chrome-extension://self/${path}`,
        sendMessage: (id: unknown, message: unknown, callback: (reply: unknown) => void) => {
          calls.push({ id, message });
          callback(reply());
        },
        lastError: undefined,
      },
    } as unknown as typeof chrome;
    try {
      const source = new MalSyncSource({ onChange: () => {} });
      source.setEnabled(true);
      source.watch({ id: 12, url: PAGE });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toEqual([
        {
          id: MALSYNC_EXTENSION_IDS.chrome,
          message: { tab: 12, info: { action: "presence", active: true } },
        },
      ]);
      expect(JSON.stringify(calls)).not.toContain("stream.example");
      expect(JSON.stringify(calls)).not.toContain("secret");
      source.setEnabled(false);
    } finally {
      globalThis.chrome = keep;
    }
  });
});
