import { describe, expect, test } from "bun:test";
import { collect } from "./collector";
import { PlayerBridge, SILENT_MS, parsePlayerMessage, type FrameLike } from "./player-bridge";

const SOURCE = { name: "the iframe's window" };
const PLAYER = "https://plyr.animex.one";

/** A frame, as `document.querySelectorAll("iframe")` gives it. */
function frame(
  src: string,
  window: unknown = SOURCE,
): FrameLike & { isConnected: boolean; src: string } {
  return { contentWindow: window as Window, src, isConnected: true };
}

/** What AnimeX's own player sends (plyr.animex.one), cut to the fields that matter. */
const anmx = (name: string, state: Record<string, unknown>) => ({
  source: "aniembed",
  version: 1,
  type: "event",
  name,
  data: {
    animeId: "dan-da-dan-season-2-od6gt",
    episode: 1,
    language: "sub",
    providerId: "yuki",
    currentTime: 0,
    duration: 1447.04,
    paused: false,
    playbackRate: 1,
    ...state,
  },
});
/** What a MegaCloud-family player sends (megaplay.buzz) several times a second while it plays. */
const log = (currentTime: number, duration = 1447.04) => ({
  type: "watching-log",
  currentTime,
  duration,
});

/** A bridge over one iframe, which stays the same element as it does in a page. */
const bridgeFor = (src: string) => {
  const frames = [frame(src)];
  return new PlayerBridge(() => frames);
};

const T0 = 1_700_000_000_000;
const send = (
  bridge: PlayerBridge,
  data: unknown,
  now: number,
  origin = PLAYER,
  source: unknown = SOURCE,
) => bridge.accept({ data, source, origin }, now);

describe("what a player's message says", () => {
  test("AnimeX's player says where it is, and whether it's paused, in every event", () => {
    expect(parsePlayerMessage(anmx("progress", { currentTime: 5.06 }))).toEqual({
      type: "reading",
      time: 5.06,
      duration: 1447.04,
      paused: false,
      rate: 1,
      stream: false,
      seeked: false,
    });
    expect(parsePlayerMessage(anmx("pause", { paused: true, currentTime: 14.9 }))).toMatchObject({
      paused: true,
      time: 14.9,
    });
    expect(parsePlayerMessage(anmx("seeked", { currentTime: 600 }))).toMatchObject({
      time: 600,
      seeked: true,
    });
    expect(parsePlayerMessage(anmx("progress", { playbackRate: 2 }))).toMatchObject({ rate: 2 });
    expect(parsePlayerMessage(anmx("ended", { paused: false, currentTime: 1447 }))).toMatchObject({
      paused: true,
    });
  });

  test("a command's answer carries its state one level down, and isn't a report", () => {
    expect(
      parsePlayerMessage({
        ...anmx("command-result", {}),
        data: { ok: true, state: { currentTime: 3 } },
      }),
    ).toBeNull();
  });

  test("a new source drops what was known", () => {
    expect(parsePlayerMessage(anmx("providerchange", { language: "dub" }))).toEqual({
      type: "reset",
    });
  });

  test("a MegaCloud-style time stream is a reading with nothing about pausing", () => {
    expect(parsePlayerMessage(log(1.12))).toEqual({
      type: "reading",
      time: 1.12,
      duration: 1447.04,
      stream: true,
      seeked: false,
    });
    expect(
      parsePlayerMessage({
        channel: "megacloud",
        event: "time",
        time: 2.5,
        duration: 1447,
        percent: 0.2,
      }),
    ).toMatchObject({ time: 2.5, stream: true });
  });

  test("anything else, or anything out of range, says nothing", () => {
    for (const data of [
      null,
      "watching-log",
      { playerStatus: "Playing" },
      { event: "PLAYER_READY" },
      { source: "aniembed", version: 2, name: "progress", data: { currentTime: 1 } },
      { source: "aniembed", version: 1, name: "settingschange", data: { currentTime: 1 } },
      anmx("progress", { currentTime: -1 }),
      anmx("progress", { currentTime: Number.POSITIVE_INFINITY }),
      anmx("progress", { currentTime: "5" }),
      log(1e12),
      { type: "watching-log", currentTime: Number.NaN },
    ]) {
      expect(parsePlayerMessage(data)).toBeNull();
    }
    // Bad extras are left out; the reading stands.
    expect(parsePlayerMessage(anmx("progress", { duration: -5, playbackRate: 0 }))).toEqual({
      type: "reading",
      time: 0,
      paused: false,
      stream: false,
      seeked: false,
    });
  });
});

describe("the player bridge", () => {
  test("nothing has played until a frame says so", () => {
    expect(bridgeFor(`${PLAYER}/e/1/1`).clock(T0)).toBeNull();
  });

  test("AnimeX's player gives the clock while it plays: where it is, as when it started and will end", () => {
    const bridge = bridgeFor(`${PLAYER}/e/1/1?lang=sub`);
    expect(send(bridge, anmx("progress", { currentTime: 600 }), T0)).toBe(true);
    expect(bridge.clock(T0)).toEqual({
      playing: true,
      duration: 1447.04,
      start: T0 - 600_000,
      end: T0 - 600_000 + 1447_000,
    });
    // It plays on between its reports (every five seconds): the same clock, not a new one.
    expect(bridge.clock(T0 + 3000)).toEqual(bridge.clock(T0));
    expect(send(bridge, anmx("progress", { currentTime: 605.1 }), T0 + 5100)).toBe(false);
    expect(bridge.clock(T0 + 5100)?.start).toBe(T0 - 600_000);
  });

  test("a pause has no clock, and a seek or a resume makes a new one", () => {
    const bridge = bridgeFor(`${PLAYER}/e/1/1`);
    send(bridge, anmx("progress", { currentTime: 600 }), T0);
    expect(send(bridge, anmx("pause", { paused: true, currentTime: 614.9 }), T0 + 14_900)).toBe(
      true,
    );
    expect(bridge.clock(T0 + 60_000)).toEqual({ playing: false, duration: 1447.04 });
    expect(send(bridge, anmx("seeked", { paused: true, currentTime: 100 }), T0 + 61_000)).toBe(
      true,
    );
    expect(send(bridge, anmx("play", { paused: false, currentTime: 100 }), T0 + 61_000)).toBe(true);
    expect(bridge.clock(T0 + 61_000)?.start).toBe(T0 + 61_000 - 100_000);
    // Seeking while it plays moves the clock too.
    expect(send(bridge, anmx("seeked", { currentTime: 900 }), T0 + 70_000)).toBe(true);
    expect(bridge.clock(T0 + 70_000)?.start).toBe(T0 + 70_000 - 900_000);
  });

  test("a faster player is further along sooner, so it ends sooner", () => {
    const bridge = bridgeFor(`${PLAYER}/e/1/1`);
    send(bridge, anmx("progress", { currentTime: 610, playbackRate: 2 }), T0);
    expect(bridge.clock(T0)).toMatchObject({ start: T0 - 305_000, end: T0 - 305_000 + 724_000 });
  });

  test("a different Sub/Dub or server is a new source: the old clock is dropped until it plays", () => {
    const frames = [frame(`${PLAYER}/e/1/1?lang=sub&t=0`)];
    const bridge = new PlayerBridge(() => frames);
    send(bridge, anmx("progress", { currentTime: 10 }), T0);
    expect(bridge.clock(T0)?.playing).toBe(true);

    // The player says it's switching (and the page reloads it at the same spot).
    expect(send(bridge, anmx("providerchange", { language: "dub" }), T0 + 1000)).toBe(true);
    expect(bridge.clock(T0 + 1000)).toBeNull();
    frames[0]!.src = `${PLAYER}/e/1/1?lang=dub&t=10`;
    send(bridge, anmx("ready", { language: "dub", paused: true }), T0 + 2000);
    send(bridge, anmx("seeked", { language: "dub", paused: true, currentTime: 10 }), T0 + 2400);
    send(bridge, anmx("play", { language: "dub", currentTime: 10 }), T0 + 2400);
    expect(bridge.clock(T0 + 2400)).toMatchObject({
      playing: true,
      start: Math.round((T0 + 2400 - 10_000) / 1000) * 1000,
    });
  });

  test("a frame pointed somewhere else, or taken away, takes its clock with it", () => {
    const frames = [frame(`${PLAYER}/e/1/1`)];
    const bridge = new PlayerBridge(() => frames);
    send(bridge, anmx("progress", { currentTime: 10 }), T0);

    frames[0]!.src = `${PLAYER}/e/1/2`; // The next episode.
    expect(bridge.clock(T0 + 100)).toBeNull();

    send(bridge, anmx("progress", { currentTime: 5 }), T0 + 5000);
    expect(bridge.clock(T0 + 5000)?.playing).toBe(true);
    frames[0]!.isConnected = false; // The player was removed.
    expect(bridge.clock(T0 + 5100)).toBeNull();
  });

  test("a single-page site moving on drops what the old page's player said", () => {
    const frames = [frame(`${PLAYER}/e/1/1`)];
    let where = "/watch/show-1-episode-1";
    const bridge = new PlayerBridge(
      () => frames,
      () => where,
    );
    send(bridge, anmx("progress", { currentTime: 798 }), T0);
    expect(bridge.clock(T0)?.playing).toBe(true);

    // The address is the next episode's; the old player is still on screen, still playing the old one.
    where = "/watch/show-1-episode-2";
    expect(bridge.clock(T0 + 1500)).toBeNull();

    // The new episode's player speaks (the page's script swaps it in): its word counts.
    frames[0] = frame(`${PLAYER}/e/1/2`);
    send(bridge, anmx("progress", { currentTime: 5 }), T0 + 8000);
    expect(bridge.clock(T0 + 8000)).toMatchObject({ playing: true, start: T0 + 8000 - 5000 });
  });

  test("a time stream plays while it's talking, and has paused when it goes quiet", () => {
    const bridge = bridgeFor("https://megaplay.buzz/stream/ani/185660/1/sub");
    for (let step = 0; step < 4; step++) {
      send(bridge, log(1 + step * 0.26), T0 + step * 260, "https://megaplay.buzz");
    }
    const talking = bridge.clock(T0 + 800);
    expect(talking).toMatchObject({ playing: true, duration: 1447.04 });
    expect(talking?.start).toBe(Math.round((T0 + 780 - 1780) / 1000) * 1000);

    const quiet = bridge.clock(T0 + 780 + SILENT_MS + 1);
    expect(quiet).toEqual({ playing: false, duration: 1447.04 });
    // And it's talking again once it plays.
    send(bridge, log(1.8), T0 + 10_000, "https://megaplay.buzz");
    expect(bridge.clock(T0 + 10_000)?.playing).toBe(true);
  });

  test("a player that only says it's playing has no clock to give", () => {
    // ZEN's embed sends { playerStatus: "Playing" } and nothing else.
    const bridge = bridgeFor("https://flixcloud.cc/e/abc?v=1");
    expect(send(bridge, { playerStatus: "Playing" }, T0, "https://flixcloud.cc")).toBe(false);
    expect(bridge.clock(T0)).toBeNull();
  });

  test("only the page's own iframes, from the origin they loaded, can speak", () => {
    const other = { name: "another window" };
    const bridge = bridgeFor(`${PLAYER}/e/1/1`);
    const report = anmx("progress", { currentTime: 10 });

    expect(send(bridge, report, T0, "https://evil.example")).toBe(false); // Not the frame's origin.
    expect(send(bridge, report, T0, PLAYER, other)).toBe(false); // Not one of the page's frames (the page itself, a popup).
    expect(send(bridge, report, T0, PLAYER, null)).toBe(false);
    expect(bridge.clock(T0)).toBeNull();

    const gone = new PlayerBridge(() => [{ ...frame(`${PLAYER}/e/1/1`), isConnected: false }]);
    expect(send(gone, report, T0)).toBe(false);
    const empty = new PlayerBridge(() => [{ ...frame(""), src: "" }]);
    expect(send(empty, report, T0, "")).toBe(false);
  });
});

describe("the collector with a player in a frame", () => {
  const doc = (media: unknown[] = []) =>
    ({ querySelectorAll: () => media, querySelector: () => null }) as unknown as Pick<
      Document,
      "querySelector" | "querySelectorAll"
    >;
  const clock = { playing: true, duration: 1447.04, start: T0 - 600_000, end: T0 + 847_000 };

  test("the frame's clock is the clock, as a video's", () => {
    expect(collect(["media"], doc(), {}, T0, clock)).toEqual({
      media: {
        kind: "video",
        playing: true,
        duration: 1447.04,
        start: T0 - 600_000,
        end: T0 + 847_000,
      },
    });
  });

  test("it outranks what the page's own elements say (a muted background video, say)", () => {
    const hero = [{ localName: "video", paused: false, currentTime: 3, duration: 20 }];
    expect(collect(["media"], doc(hero), {}, T0).media).toMatchObject({
      playing: true,
      duration: 20,
    });
    expect(
      collect(["media"], doc(hero), {}, T0, { playing: false, duration: 1447.04 }).media,
    ).toEqual({
      kind: "video",
      playing: false,
      duration: 1447.04,
    });
  });

  test("with no frame having spoken, nothing changes; without 'media' granted, it adds nothing", () => {
    expect(collect(["media"], doc(), {}, T0, null)).toEqual({});
    expect(collect(["thumbnails"], doc(), {}, T0, clock)).toEqual({});
  });
});
