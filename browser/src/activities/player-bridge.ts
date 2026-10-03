/**
 * Players that live in an iframe. The collector reads the page it's injected
 * into, and a `<video>` in another origin's frame is out of its reach, but
 * the page that embeds one usually hears from it: an embedded player reports
 * its clock with `postMessage` to the page around it, which is how the page's
 * own controls follow it. Those messages are visible to the collector too
 * (it's a listener on the same window), so this reads the same reports the
 * page does, and nothing else: no frame's markup, no stream, no command sent
 * to a player.
 *
 * Two kinds of report are understood, both seen from real embeds:
 *
 * - `aniembed` (AnimeX's own player, plyr.animex.one): events with the
 *   player's whole state, `{ source: "aniembed", version: 1, name, data }`.
 *   `play`, `pause`, `seeked`, `progress` and `ended` carry `currentTime`,
 *   `duration`, `paused` and `playbackRate`, so a pause, a seek and a change of
 *   speed are all said outright. `providerchange` says the source is being
 *   replaced (a different Sub/Dub or server), so what was known is dropped.
 * - A stream of `{ type: "watching-log", currentTime, duration }` (or
 *   `{ channel: "megacloud", event: "time", time, duration }`), several
 *   times a second while it plays, as MegaCloud-family embeds send (AnimeX's
 *   KOTO). It says nothing when it's paused, so silence is a pause.
 *
 * A message counts only if it comes from an iframe of this document, from the
 * origin that iframe was loaded from, so another frame can't speak for it.
 * Everything in one is bounded and checked before it's used.
 */

/** What a player's last report implies about the clock. */
export interface PlayerClock {
  playing: boolean;
  /** Seconds, when the player said. */
  duration?: number;
  /** While playing, in Unix milliseconds, at normal clock speed whatever the player's own. */
  start?: number;
  end?: number;
}

/** A report, parsed. */
export type PlayerEvent =
  | {
      type: "reading";
      time: number;
      duration?: number;
      paused?: boolean;
      rate?: number;
      stream: boolean;
      seeked: boolean;
    }
  /** The source is being replaced: nothing known about it holds. */
  | { type: "reset" };

/** Longest item believed: a week of seconds. A page can send anything. */
const MAX_SECONDS = 7 * 24 * 3600;
const MAX_RATE = 16;
/** A time stream that goes quiet this long has paused; its reports come several times a second. */
export const SILENT_MS = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const seconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS
    ? value
    : undefined;

/** `aniembed` events that say where a player is. */
const ANIEMBED_READINGS: ReadonlySet<string> = new Set([
  "ready",
  "play",
  "pause",
  "seeked",
  "progress",
  "ended",
]);

/** Parses one `message` event's data as a player's report, or `null` if it isn't one. */
export function parsePlayerMessage(data: unknown): PlayerEvent | null {
  if (!isObject(data)) return null;

  if (data.source === "aniembed" && data.version === 1 && typeof data.name === "string") {
    if (data.name === "providerchange") return { type: "reset" };
    if (!ANIEMBED_READINGS.has(data.name) || !isObject(data.data)) return null;
    const state = isObject(data.data.state) ? data.data.state : data.data;
    const time = seconds(state.currentTime);
    if (time === undefined) return null;
    const duration = seconds(state.duration);
    const rate =
      typeof state.playbackRate === "number" &&
      Number.isFinite(state.playbackRate) &&
      state.playbackRate > 0 &&
      state.playbackRate <= MAX_RATE
        ? state.playbackRate
        : undefined;
    const paused =
      typeof state.paused === "boolean"
        ? state.paused
        : data.name === "pause" || data.name === "ended" || data.name === "ready"
          ? true
          : data.name === "play"
            ? false
            : undefined;
    return {
      type: "reading",
      time,
      ...(duration !== undefined && duration > 0 && { duration }),
      ...(paused !== undefined && { paused: data.name === "ended" ? true : paused }),
      ...(rate !== undefined && { rate }),
      stream: false,
      seeked: data.name === "seeked",
    };
  }

  const streamed =
    data.type === "watching-log"
      ? seconds(data.currentTime)
      : data.channel === "megacloud" && data.event === "time"
        ? seconds(data.time)
        : undefined;
  if (streamed === undefined) return null;
  const duration = seconds(data.duration);
  return {
    type: "reading",
    time: streamed,
    ...(duration !== undefined && duration > 0 && { duration }),
    stream: true,
    seeked: false,
  };
}

interface Reading {
  time: number;
  duration?: number;
  paused: boolean;
  rate: number;
  stream: boolean;
  at: number;
}

/** What it needs of an iframe. */
export type FrameLike = Pick<HTMLIFrameElement, "contentWindow" | "src" | "isConnected">;

/** The one player a page is playing in, as its frame last reported it. */
export class PlayerBridge {
  #frame: FrameLike | null = null;
  #src = "";
  #reading: Reading | null = null;
  #page = "";

  /** `where` is the page's address, so a report is about the page it came in on, not the one a single-page site has moved on to. */
  constructor(
    private readonly frames: () => Iterable<FrameLike>,
    private readonly where: () => string = () => "",
  ) {}

  /**
   * Takes a `message` event. Returns whether it changed what's playing in a
   * way worth reporting now (a pause, a seek, a new source), not just a
   * reading that moves the clock along.
   */
  accept(event: { data: unknown; source: unknown; origin: string }, now: number): boolean {
    const parsed = parsePlayerMessage(event.data);
    if (parsed === null || event.source === null || event.source === undefined) return false;
    const frame = [...this.frames()].find(
      (candidate) => candidate.isConnected && candidate.contentWindow === event.source,
    );
    if (!frame) return false;
    try {
      if (new URL(frame.src).origin !== event.origin) return false;
    } catch {
      return false;
    }

    // Another frame, or the same one pointed somewhere else: what was known is about something gone.
    const same = frame === this.#frame && frame.src === this.#src;
    if (!same) this.#reading = null;
    this.#frame = frame;
    this.#src = frame.src;
    this.#page = this.where();

    if (parsed.type === "reset") {
      const had = this.#reading !== null;
      this.#reading = null;
      return had;
    }

    const before = this.#reading;
    const paused = parsed.stream ? false : (parsed.paused ?? before?.paused ?? true);
    this.#reading = {
      time: parsed.time,
      duration: parsed.duration ?? before?.duration,
      paused,
      rate: parsed.rate ?? before?.rate ?? 1,
      stream: parsed.stream,
      at: now,
    };
    return before === null || before.paused !== paused || parsed.seeked;
  }

  /** What the player's last report makes of the clock at `now`, or `null` if no player has spoken (or the one that did is gone). */
  clock(now: number): PlayerClock | null {
    const frame = this.#frame;
    if (!frame || !frame.isConnected || frame.src !== this.#src || this.where() !== this.#page) {
      this.#frame = null;
      this.#reading = null;
      return null;
    }
    const reading = this.#reading;
    if (!reading) return null;

    const playing = !reading.paused && (!reading.stream || now - reading.at <= SILENT_MS);
    const clock: PlayerClock = { playing };
    if (reading.duration !== undefined) clock.duration = reading.duration;
    if (playing) {
      // Whole seconds, as the collector gives elsewhere, so the clock's own jitter isn't a change.
      const start = Math.round((reading.at - (reading.time * 1000) / reading.rate) / 1000) * 1000;
      clock.start = start;
      if (reading.duration !== undefined) {
        clock.end = start + Math.round(reading.duration / reading.rate) * 1000;
      }
    }
    return clock;
  }
}
