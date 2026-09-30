import type { PageDataKind } from "../core/activity";
import type { PageData, PageMedia } from "../core/registry";
import { PAGE_DATA_PORT, parseToCollector } from "./messages";

/**
 * Parousia's page-data collector: how a native Activity that declares page
 * data gets it. No Activity code runs in the page; this reads only the kinds
 * the background says it may (declared, not switched off, and the site
 * granted), and only from what pages publish in standard places:
 *
 * - `media`: the page's Media Session (title, artist, album, and whether it
 *   says it's playing) and its playing (or first) `<video>`/`<audio>` element
 *   (whether it's playing if the session doesn't say, duration, and the clock
 *   as `start` and `end`).
 * - `thumbnails`: the Media Session's largest `https` artwork, or the page's
 *   `og:image`.
 *
 * It's shared by every native Activity that declares these, and runs only
 * for one that does: injected (as `activities/collector.js`) into the active
 * tab's page, it reads once a second while the page is visible and sends
 * only changes. A song playing through is no change: its `start` and `end`
 * stay put until it's paused or seeked.
 */
export const COLLECTOR_KEY = "__parousiaCollector";
const TICK_MS = 1000;
const MAX_TEXT = 256;
const MAX_URL = 512;
const MAX_ELEMENTS = 16;
/** How far a playing item's clock may drift from the last one sent before it's news (seeking moves it by more). */
const DRIFT_MS = 1500;

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
};
const https = (value: string | null | undefined): string | undefined =>
  value?.startsWith("https://") && value.length <= MAX_URL ? value : undefined;
const finite = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 ? value : undefined;

/** The width in `sizes` ("512x512 256x256"), for picking the largest artwork. */
function width(sizes: string | undefined): number {
  return Math.max(0, ...(sizes ?? "").split(/\s+/).map((size) => Number.parseInt(size, 10) || 0));
}

/** Reads `kinds` from `doc` and `nav`, and nothing else. */
export function collect(
  kinds: readonly PageDataKind[],
  doc: Pick<Document, "querySelector" | "querySelectorAll">,
  nav: { mediaSession?: { metadata: MediaMetadata | null; playbackState?: string } },
  now: number = Date.now(),
): PageData {
  const data: PageData = {};
  const session = nav.mediaSession?.metadata ?? null;
  if (kinds.includes("media")) {
    const media: PageMedia = {};
    const title = text(session?.title);
    if (title) media.title = title;
    const artist = text(session?.artist);
    if (artist) media.artist = artist;
    const album = text(session?.album);
    if (album) media.album = album;
    const elements = [...doc.querySelectorAll<HTMLMediaElement>("video, audio")].slice(
      0,
      MAX_ELEMENTS,
    );
    const element = elements.find((candidate) => !candidate.paused) ?? elements[0];
    // What the page says about its own playback outranks what one of its elements does.
    const said = nav.mediaSession?.playbackState;
    if (said === "playing" || said === "paused") media.playing = said === "playing";
    else if (element) media.playing = !element.paused;
    if (element) {
      const duration = finite(element.duration);
      if (duration !== undefined) media.duration = duration;
      const position = finite(element.currentTime);
      if (media.playing && position !== undefined) {
        // Whole seconds, so the clock's own jitter isn't a change.
        const start = Math.round((now - position * 1000) / 1000) * 1000;
        media.start = start;
        if (duration !== undefined) media.end = start + Math.round(duration) * 1000;
      }
    }
    if (Object.keys(media).length > 0) data.media = media;
  }
  if (kinds.includes("thumbnails")) {
    const artwork = [...(session?.artwork ?? [])]
      .filter((image) => https(image.src))
      .sort((a, b) => width(b.sizes) - width(a.sizes))[0]?.src;
    const thumbnail =
      https(artwork) ??
      https(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"));
    if (thumbnail) data.thumbnail = thumbnail;
  }
  return data;
}

const withoutClock = (data: PageData): string =>
  JSON.stringify({ ...data, media: data.media && { ...data.media, start: 0, end: 0 } });

/**
 * Whether `data` says what `before` (the last sent) did. Playing through is
 * no news: the clock may drift a little. Anything else is: a new song, a pause,
 * a seek.
 */
export function unchanged(data: PageData, before: PageData | null): boolean {
  if (before === null || withoutClock(data) !== withoutClock(before)) return false;
  const now = data.media?.start;
  const last = before.media?.start;
  return (
    now === last || (now !== undefined && last !== undefined && Math.abs(now - last) <= DRIFT_MS)
  );
}

/** Collects for one Activity in this document until the background says stop. */
export function startCollector(activity: string): void {
  let kinds: PageDataKind[] = [];
  let sent: PageData | null = null;
  let closed = false;
  let port: chrome.runtime.Port | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    closed = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", schedule);
    try {
      port?.disconnect();
    } catch {
      // Already gone.
    }
    port = null;
  };

  /** Opens the port (saying hello) unless it's open. */
  const open = (): void => {
    if (closed || port) return;
    try {
      const opened = chrome.runtime.connect({ name: PAGE_DATA_PORT });
      opened.onMessage.addListener((raw: unknown) => {
        const message = parseToCollector(raw);
        if (message?.type === "stop") {
          stop();
        } else if (message?.type === "collect") {
          kinds = message.kinds;
          sent = null;
          tick();
        }
      });
      opened.onDisconnect.addListener(() => {
        // The background restarted: say everything again on the next tick.
        if (port === opened) port = null;
        sent = null;
      });
      opened.postMessage({ type: "hello", activity });
      port = opened;
    } catch {
      // The extension was reloaded or removed.
      stop();
    }
  };

  const post = (message: object): void => {
    open();
    try {
      port?.postMessage(message);
    } catch {
      port = null;
    }
  };

  function tick(): void {
    if (closed || document.hidden) return;
    if (kinds.length === 0) {
      // Not told what to read yet (or the background restarted): ask.
      open();
      return;
    }
    const data = collect(kinds, document, navigator);
    if (unchanged(data, sent)) return;
    sent = data;
    post({ type: "data", data });
  }

  function schedule(): void {
    if (closed) return;
    if (!document.hidden && timer === null) timer = setInterval(tick, TICK_MS);
    else if (document.hidden && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener("visibilitychange", schedule);
  schedule();
  tick();
}

/** Sets up `start`, once per document, for the background to call with the Activity's id. */
export function installCollector(scope: object = globalThis): void {
  if (Reflect.has(scope, COLLECTOR_KEY)) return;
  const started = new Set<string>();
  Reflect.set(scope, COLLECTOR_KEY, {
    start(activity: unknown): void {
      if (typeof activity !== "string" || started.has(activity)) return;
      started.add(activity);
      startCollector(activity);
    },
  });
}
