import type { SettingValue } from "../core/activity";
import { BRIDGE_KEY } from "../activities/manifest";
import {
  MAX_MESSAGE,
  PREMID_FRAME_PORT,
  PREMID_PORT,
  jsonSize,
  parsePageSpec,
  parseToPage,
  type PageSpec,
  type ToPage,
} from "../activities/messages";
import { originOf, trackImageOrigins } from "./image-origin";
import type { PresenceDataWire } from "./presence-data";

/**
 * PreMiD's Activity API (github.com/PreMiD/Activities, `@types/premid`), in
 * the page: the `Presence`, `iFrame`, and `Slideshow` classes an unmodified
 * PreMiD Activity is written against, feeding Parousia's background instead
 * of PreMiD's. The background injects this (as `premid/runtime.js`) into the
 * content-script world of a page a turned-on Activity matches, then the
 * Activity's own script, which the build wraps to receive these classes from
 * `bind` (scripts/activities/premid.ts).
 *
 * Kept small on purpose: ticks run once a second and only while the page is
 * visible; what's sent is what changed. Not provided, so an Activity's
 * `supports()` checks see them missing: `onRequest`, and `execInPage` with a
 * function (it would need the page to evaluate code); the declarative form is.
 */

/** English strings from PreMiD's `general.json`, defined by the build. */
declare const __PREMID_STRINGS__: Readonly<Record<string, string>> | undefined;

const TICK_MS = 1000;
/**
 * How long an Activity may go without calling `setActivity` or
 * `clearActivity` while its page is shown before what it last reported is
 * dropped, and how long after the page's address changed. PreMiD runs
 * `UpdateData` every second and an Activity updates on each run, so one that
 * stays silent has stopped understanding its page (a site layout it doesn't
 * know, say). Its last report describes where the page was, not where it
 * is: better nothing than "Browsing home" under a song that's playing.
 */
export const STALE_MS = 30_000;
export const STALE_AFTER_MOVE_MS = 6000;
/** How long to wait for the background to answer before going on without it. */
const ANSWER_MS = 5000;
export const MIN_SLIDE_TIME = 5000;
/** The PreMiD extension version whose API this matches (activity names, detail and state links). */
const PREMID_VERSION = "2.8.0";

type Listener = (...args: unknown[]) => unknown;
type Data = Record<string, unknown>;

const isObject = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Ticking: every Presence and iFrame in this document, together.

const tickers = new Set<() => Promise<void>>();
const inFlight = new Set<() => Promise<void>>();
let timer: ReturnType<typeof setInterval> | null = null;
/** How long one update may take before it's given up on and the next one starts. */
export const MAX_UPDATE_MS = 10_000;

/**
 * Runs every update once. Each is on its own: a slow one skips ticks rather
 * than stacking them up, but only for `limitMs`. One that never settles (a
 * request that hangs, a promise an Activity forgot to resolve) would
 * otherwise stop that Activity, and every other one in the document, for as
 * long as the page lives; PreMiD itself never waits on an update before the
 * next tick.
 */
export async function runUpdates(
  runs: Iterable<() => Promise<void>>,
  running: Set<() => Promise<void>> = inFlight,
  limitMs = MAX_UPDATE_MS,
): Promise<void> {
  await Promise.all(
    [...runs].map(async (run) => {
      if (running.has(run)) return;
      running.add(run);
      let cancel = (): void => {};
      const expired = new Promise<void>((resolve) => {
        const id = setTimeout(resolve, limitMs);
        cancel = () => clearTimeout(id);
      });
      try {
        await Promise.race([run().catch(() => {}), expired]);
      } finally {
        cancel();
        running.delete(run);
      }
    }),
  );
}

const tick = (): Promise<void> => runUpdates(tickers);

function schedule(): void {
  const run = tickers.size > 0 && !document.hidden;
  if (run && timer === null) {
    timer = setInterval(() => void tick(), TICK_MS);
    // At once too, not a second from now: after the Activity's script has
    // added its listeners (it does, right after making its Presence), and
    // when the page is shown again.
    setTimeout(() => void tick(), 0);
  } else if (!run && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function emit(
  listeners: Map<string, Listener[]>,
  event: string,
  ...args: unknown[]
): Promise<void> {
  for (const listener of listeners.get(event) ?? []) {
    try {
      await listener(...args);
    } catch (error) {
      // One failing update doesn't stop the next; the console says why it failed.
      console.debug("[Parousia/PreMiD]", event, "failed:", error);
    }
  }
}

function listen(listeners: Map<string, Listener[]>, event: unknown, listener: unknown): void {
  if (typeof event !== "string" || typeof listener !== "function") return;
  const list = listeners.get(event) ?? [];
  list.push((...args) => Reflect.apply(listener, undefined, args));
  listeners.set(event, list);
}

/** `runtime.connect`, taken when the runtime installs, before any Activity's code runs. */
let connect: ((info: { name: string }) => chrome.runtime.Port) | null = null;

/**
 * Content scripts can read and write the extension's storage (its settings,
 * which Activities are on, the Default Activity). Chromium lets the
 * background take that away from them (`setAccessLevel`); Firefox doesn't,
 * so the runtime takes it away here, from the world PreMiD Activities' code
 * runs in, before any of it runs. Nothing in this world needs it.
 */
export function withholdStorage(scope: object = globalThis): void {
  for (const name of ["browser", "chrome"]) {
    const api: unknown = Reflect.get(scope, name);
    if (typeof api !== "object" || api === null || !Reflect.has(api, "storage")) continue;
    if (Reflect.deleteProperty(api, "storage") && !Reflect.has(api, "storage")) continue;
    try {
      Object.defineProperty(api, "storage", { value: undefined, configurable: false });
    } catch {
      // Neither deletable nor redefinable here: the background's restriction is all there is.
    }
  }
}

/** PreMiD's image service, which about a dozen Activities call: it never gets a request from here. */
const IMAGE_SERVICE = "https://pd.premid.app/create/";

/**
 * PreMiD's Activities shorten a long image address (Discord takes at most
 * 256 characters) by asking PreMiD's image service for a short one
 * (`GET pd.premid.app/create/<address>`), and a few upload a picture they
 * drew (`POST pd.premid.app/create/image`). Parousia talks to no PreMiD
 * server, so those requests are answered here, in the world PreMiD's code
 * runs in, and never leave the browser:
 *
 * - a shortening asks for the address back, which the Activity uses as it
 *   would have used the short one (Desktop leaves out an image that's too
 *   long for Discord, and the rest of the presence still shows);
 * - an upload gets an empty answer, so there's no image and everything else shows.
 *
 * Every Activity already falls back to the long address if the service
 * fails; this does what that does, without the request.
 */
export function answerImageService(scope: {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): void {
  const original = scope.fetch.bind(scope);
  scope.fetch = (input, init) => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!target.toLowerCase().startsWith(IMAGE_SERVICE)) return original(input, init);
    const rest = target.slice(IMAGE_SERVICE.length);
    return Promise.resolve(new Response(rest === "image" ? "" : rest));
  };
}

/**
 * One port to the background, opened on first use and again after the
 * background restarts (an MV3 background comes and goes). Closed for good
 * once the background says `stop` or the extension is gone.
 */
class Channel {
  private port: chrome.runtime.Port | null = null;
  closed = false;

  constructor(
    private readonly name: string,
    private readonly hello: () => object,
    private readonly receive: (message: ToPage) => void,
    /** The background forgot this page (it restarted): send everything again. */
    private readonly lost: () => void,
  ) {}

  open(): chrome.runtime.Port | null {
    if (this.closed) return null;
    if (this.port) return this.port;
    try {
      if (!connect) throw new Error("the runtime isn't installed");
      const port = connect({ name: this.name });
      port.onMessage.addListener((message: unknown) => {
        const parsed = parseToPage(message);
        if (parsed?.type === "stop") this.close();
        else if (parsed) this.receive(parsed);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.lost();
      });
      port.postMessage(this.hello());
      this.port = port;
      return port;
    } catch {
      // The extension was reloaded or removed: this script is orphaned.
      this.close();
      return null;
    }
  }

  post(message: object): void {
    try {
      this.open()?.postMessage(message);
    } catch {
      this.port = null;
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.port?.disconnect();
    } catch {
      // Already gone.
    }
    this.port = null;
  }
}

/** Page answers (`getPageVariable`, `execInPage`) by nonce, giving up after `ANSWER_MS`. */
class Answers {
  private nonce = 0;
  private readonly waiting = new Map<number, (value: unknown) => void>();

  ask(channel: Channel, spec: PageSpec): Promise<unknown> {
    const nonce = this.nonce++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiting.delete(nonce);
        resolve(undefined);
      }, ANSWER_MS);
      this.waiting.set(nonce, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      channel.post({ type: "page", nonce, spec });
    });
  }

  answer(nonce: number, value: unknown): void {
    this.waiting.get(nonce)?.(value);
    this.waiting.delete(nonce);
  }
}

function execSpec(channel: Channel, answers: Answers, spec: unknown): Promise<unknown> {
  if (typeof spec === "function") {
    return Promise.reject(
      new Error("Parousia runs execInPage only with a { get } or { call } spec"),
    );
  }
  const parsed = parsePageSpec(isObject(spec) ? { ...spec, kind: "exec" } : null);
  return parsed
    ? answers.ask(channel, parsed)
    : Promise.reject(new Error("unsupported execInPage spec"));
}

// PresenceData, as the background takes it.

const TEXT_FIELDS = ["name", "details", "state", "largeImageText", "smallImageText"] as const;
const IMAGE_FIELDS = ["largeImageKey", "smallImageKey"] as const;
const LINK_FIELDS = ["detailsUrl", "stateUrl", "largeImageUrl", "smallImageUrl"] as const;
const TIME_FIELDS = ["startTimestamp", "endTimestamp"] as const;
const NUMBER_FIELDS = ["type", "statusDisplayType"] as const;

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof Node !== "undefined" && value instanceof Node) return value.textContent ?? undefined;
  return undefined;
}

const MAX_IMAGE_CHARS = 2048;

/**
 * An image address or a Discord asset key. An inline image (`data:`, a
 * Blob) has no address to send, and one can be larger than a whole message
 * (YouTube's default thumbnail is a 140 KB PNG), so it becomes the address
 * of the picture it was made from when that's known (`image-origin.ts`), and
 * is left out when it isn't. The presence never depends on it: the
 * Activity's logo shows instead.
 */
function imageOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const inline = /^(data|blob):/i.test(value.trimStart());
    const address = inline ? originOf(value) : value;
    return address !== undefined && address.length <= MAX_IMAGE_CHARS ? address : undefined;
  }
  if (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) {
    return imageOf(value.currentSrc || value.src);
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) return originOf(value);
  return undefined;
}

function linkOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof HTMLAnchorElement !== "undefined" && value instanceof HTMLAnchorElement)
    return value.href;
  return undefined;
}

function timeOf(value: unknown): number | undefined {
  const time = value instanceof Date ? value.getTime() : value;
  return typeof time === "number" && Number.isFinite(time) ? time : undefined;
}

export function serializePresenceData(data: Data): PresenceDataWire {
  const wire: PresenceDataWire = {};
  for (const field of TEXT_FIELDS) {
    const value = textOf(data[field]);
    if (value !== undefined) wire[field] = value;
  }
  for (const field of IMAGE_FIELDS) {
    const value = imageOf(data[field]);
    if (value !== undefined) wire[field] = value;
  }
  for (const field of LINK_FIELDS) {
    const value = linkOf(data[field]);
    if (value !== undefined) wire[field] = value;
  }
  for (const field of TIME_FIELDS) {
    const value = timeOf(data[field]);
    if (value !== undefined) wire[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = data[field];
    if (typeof value === "number" && Number.isFinite(value)) wire[field] = value;
  }
  const party = data.party;
  if (
    isObject(party) &&
    typeof party.partySize === "number" &&
    typeof party.maxPartySize === "number"
  ) {
    wire.party = { partySize: party.partySize, maxPartySize: party.maxPartySize };
  }
  if (Array.isArray(data.buttons)) {
    const buttons: Array<{ label: string; url: string }> = [];
    for (const button of data.buttons) {
      if (!isObject(button)) continue;
      const label = textOf(button.label);
      const url = linkOf(button.url);
      if (label !== undefined && url !== undefined) buttons.push({ label, url });
    }
    if (buttons.length > 0) wire.buttons = buttons.slice(0, 2);
  }
  return wire;
}

/**
 * What an Activity shows, as a message that fits. One that doesn't (a long
 * list of buttons, a huge address) is sent without its images before it's
 * given up on, so the page still shows something; `null` if even that is too big.
 */
export function fitPresenceData(data: Data | null): PresenceDataWire | null | undefined {
  if (data === null) return null;
  const wire = serializePresenceData(data);
  if (JSON.stringify(wire).length <= MAX_MESSAGE) return wire;
  const { largeImageKey: _large, smallImageKey: _small, ...rest } = wire;
  return JSON.stringify(rest).length <= MAX_MESSAGE ? rest : undefined;
}

// Slideshows

export class SlideshowSlide {
  private _interval: number;

  constructor(
    public id: string,
    public data: Data,
    interval: number,
  ) {
    this._interval = Math.max(MIN_SLIDE_TIME, interval);
  }

  get interval(): number {
    return this._interval;
  }

  set interval(interval: number) {
    this._interval = Math.max(MIN_SLIDE_TIME, interval);
  }

  updateData(data?: Data): void {
    if (isObject(data)) this.data = data;
  }

  updateInterval(interval?: number): void {
    if (typeof interval === "number") this.interval = interval;
  }
}

/** Alternates between slides; advanced by the ticks of the Presence showing it. */
export class Slideshow {
  private slides: SlideshowSlide[] = [];
  private index = 0;
  private shownAt = 0;

  /** The slide due now, or `null` with no slides. */
  current(now = Date.now()): Data | null {
    if (this.slides.length === 0) return null;
    let slide = this.slides[this.index % this.slides.length];
    if (slide && now - this.shownAt >= slide.interval) {
      if (this.shownAt !== 0) this.index = (this.index + 1) % this.slides.length;
      this.shownAt = now;
      slide = this.slides[this.index];
    }
    return slide?.data ?? null;
  }

  get currentSlide(): Data {
    return this.current() ?? {};
  }

  addSlide(id: string, data: Data, interval: number): SlideshowSlide {
    const existing = this.slides.find((slide) => slide.id === id);
    if (existing) return this.updateSlide(id, data, interval);
    const slide = new SlideshowSlide(id, data, interval);
    this.slides.push(slide);
    return slide;
  }

  deleteSlide(id: string): void {
    this.slides = this.slides.filter((slide) => slide.id !== id);
  }

  deleteAllSlides(): void {
    this.slides = [];
    this.index = 0;
    this.shownAt = 0;
  }

  updateSlide(id: string, data?: Data, interval?: number): SlideshowSlide {
    const slide = this.slides.find((candidate) => candidate.id === id);
    if (!slide) return this.addSlide(id, data ?? {}, interval ?? MIN_SLIDE_TIME);
    slide.updateData(data);
    slide.updateInterval(interval);
    return slide;
  }

  hasSlide(id: string): boolean {
    return this.slides.some((slide) => slide.id === id);
  }

  getSlides(): SlideshowSlide[] {
    return [...this.slides];
  }
}

// Deprecated Presence helpers, the same as PreMiD's own (premid/src/functions/).

function getTimestamps(time: number, duration: number): [number, number] {
  const start = Date.now() / 1000 - time;
  return [Math.floor(start), Math.floor(start + duration)];
}

function timestampFromFormat(format: string): number {
  if (typeof format !== "string" || !/^\d+(?::\d{1,2}(?::\d{1,2})?)?$/.test(format)) return 0;
  const parts = format.split(":").map((part) => Number.parseInt(part, 10));
  while (parts.length < 3) parts.unshift(0);
  const [hours = 0, minutes = 0, seconds = 0] = parts;
  if (minutes >= 60 || seconds >= 60) return 0;
  return hours * 3600 + minutes * 60 + seconds;
}

export interface PremidApi {
  Presence: new (options: { clientId: string; injectOnComplete?: boolean }) => object;
  iFrame: new () => object;
  Slideshow: typeof Slideshow;
  SlideshowSlide: typeof SlideshowSlide;
  MIN_SLIDE_TIME: number;
}

const log = (activity: string, message: unknown): void =>
  console.debug(`[Parousia/PreMiD ${activity}]`, message);

/** The API for one Activity, whose own strings (its `<service>.json`) the build hands over. */
export function createApi(
  activity: string,
  strings: Readonly<Record<string, string>>,
  /** Collects every channel the Activity opens, for `installBridge` to tell when it's been stopped. */
  channels: Channel[] = [],
): PremidApi {
  const general = typeof __PREMID_STRINGS__ === "undefined" ? {} : __PREMID_STRINGS__;

  class Presence {
    private readonly clientId: string;
    private readonly listeners = new Map<string, Listener[]>();
    private readonly answers = new Answers();
    private readonly channel: Channel;
    private source: Data | Slideshow | null = null;
    /** What the background has, as JSON; `null` once it has to be sent again. */
    private sent: string | null = null;
    private settings: Record<string, SettingValue> | null = null;
    /** Which settings it has hidden (`true`) or shown, as the background was last told. */
    private readonly hiding = new Map<string, boolean>();
    private readonly settingsWaiting: Array<() => void> = [];
    /** When, and on which page address, the Activity last called `setActivity` or `clearActivity`. */
    private updatedAt = Date.now();
    private updatedOn = location.href;

    constructor(options: { clientId: string; injectOnComplete?: boolean }) {
      this.clientId = String(isObject(options) ? options.clientId : "");
      this.channel = new Channel(
        PREMID_PORT,
        () => ({ type: "hello", activity, clientId: this.clientId }),
        (message) => this.receive(message),
        () => {
          this.sent = null;
          this.hiding.clear();
        },
      );
      channels.push(this.channel);
      this.channel.open();
      const start = (): void => {
        tickers.add(this.tick);
        schedule();
      };
      if (
        isObject(options) &&
        options.injectOnComplete === true &&
        document.readyState !== "complete"
      ) {
        window.addEventListener("load", start, { once: true });
      } else {
        start();
      }
    }

    private readonly tick = async (): Promise<void> => {
      if (this.channel.closed) {
        tickers.delete(this.tick);
        schedule();
        return;
      }
      await emit(this.listeners, "UpdateData");
      this.expire();
      this.flush();
      this.watchFrames();
    };

    /** Drops what the Activity last reported once it has gone stale (see `STALE_MS`). */
    private expire(): void {
      if (this.source === null || this.source instanceof Slideshow) return;
      const limit = location.href === this.updatedOn ? STALE_MS : STALE_AFTER_MOVE_MS;
      if (Date.now() - this.updatedAt > limit) this.source = null;
    }

    private touch(): void {
      this.updatedAt = Date.now();
      this.updatedOn = location.href;
    }

    /** Which iframes the page has, so ones that load later get the Activity's iframe script too. */
    private frames = "";

    private watchFrames(): void {
      const sources: string[] = [];
      for (const frame of document.getElementsByTagName("iframe")) {
        sources.push(frame.src);
        if (sources.length === 32) break;
      }
      const frames = sources.join("\n");
      if (frames === this.frames) return;
      this.frames = frames;
      if (sources.length > 0) this.channel.post({ type: "frames" });
    }

    private receive(message: ToPage): void {
      if (message.type === "settings") {
        this.settings = message.values;
        for (const resume of this.settingsWaiting.splice(0)) resume();
      } else if (message.type === "page-result") {
        this.answers.answer(message.nonce, message.value);
      } else if (message.type === "frame-data") {
        void emit(this.listeners, "iFrameData", message.data);
      }
    }

    /** Sends what the Activity shows now, if the background doesn't have it yet. */
    private flush(): void {
      const data = this.source instanceof Slideshow ? this.source.current() : this.source;
      const wire = fitPresenceData(data);
      if (wire === undefined) return;
      const json = JSON.stringify(wire);
      if (json === this.sent) return;
      this.sent = json;
      this.channel.post({ type: "activity", clientId: this.clientId, data: wire });
    }

    on(event: unknown, listener: unknown): void {
      listen(this.listeners, event, listener);
    }

    async setActivity(data?: unknown): Promise<void> {
      // Without data, PreMiD shows just the name and logo.
      this.source = data instanceof Slideshow ? data : isObject(data) ? data : {};
      this.touch();
      this.flush();
    }

    clearActivity(): void {
      this.source = null;
      this.touch();
      this.flush();
    }

    getActivity(): Data {
      return this.source instanceof Slideshow ? this.source.currentSlide : (this.source ?? {});
    }

    private async loadSettings(): Promise<Record<string, SettingValue>> {
      if (!this.settings) {
        await new Promise<void>((resume) => {
          this.settingsWaiting.push(resume);
          setTimeout(resume, ANSWER_MS);
        });
      }
      return this.settings ?? {};
    }

    async getSetting(id: unknown): Promise<SettingValue | undefined> {
      if (typeof id !== "string") return undefined;
      const settings = await this.loadSettings();
      // Parousia shows PreMiD's strings in English, so an Activity's language setting is always English.
      return settings[id] ?? (id === "lang" ? "en" : undefined);
    }

    async hideSetting(ids: unknown): Promise<void> {
      this.toggleSettings(ids, true);
    }

    async showSetting(ids: unknown): Promise<void> {
      this.toggleSettings(ids, false);
    }

    private toggleSettings(ids: unknown, hidden: boolean): void {
      // Some Activities do this on every update, once a second: only a change is news.
      const list = (Array.isArray(ids) ? ids : [ids]).filter(
        (id): id is string => typeof id === "string" && this.hiding.get(id) !== hidden,
      );
      if (list.length === 0) return;
      const changed = list.slice(0, 64);
      for (const id of changed) this.hiding.set(id, hidden);
      this.channel.post({ type: "hide", ids: changed, hidden });
    }

    async getStrings(keys: unknown): Promise<Record<string, string>> {
      const result: Record<string, string> = {};
      if (!isObject(keys)) return result;
      for (const [name, key] of Object.entries(keys)) {
        if (typeof key !== "string") continue;
        const text = strings[key] ?? general[key];
        if (text !== undefined) result[name] = text;
      }
      return result;
    }

    async getPageVariable(...paths: unknown[]): Promise<Data> {
      const spec = parsePageSpec({ kind: "variables", paths });
      if (!spec) return {};
      const value = await this.answers.ask(this.channel, spec);
      return isObject(value) ? value : {};
    }

    async getPageletiable(name: unknown): Promise<unknown> {
      if (typeof name !== "string") return undefined;
      return (await this.getPageVariable(name))[name];
    }

    execInPage(spec: unknown): Promise<unknown> {
      return execSpec(this.channel, this.answers, spec);
    }

    async getLogs(): Promise<unknown[]> {
      return [];
    }

    getExtensionVersion(onlyNumeric?: boolean): string | number {
      return onlyNumeric ? Number(PREMID_VERSION.replaceAll(".", "")) : PREMID_VERSION;
    }

    getTimestamps(time: number, duration: number): [number, number] {
      return getTimestamps(time, duration);
    }

    getTimestampsfromMedia(media: HTMLMediaElement): [number, number] {
      return getTimestamps(media.currentTime, media.duration);
    }

    timestampFromFormat(format: string): number {
      return timestampFromFormat(format);
    }

    createSlideshow(): Slideshow {
      return new Slideshow();
    }

    info(message: unknown): void {
      log(activity, message);
    }

    success(message: unknown): void {
      log(activity, message);
    }

    error(message: unknown): void {
      log(activity, message);
    }
  }

  class iFrame {
    private readonly listeners = new Map<string, Listener[]>();
    private readonly answers = new Answers();
    private readonly channel: Channel;

    constructor() {
      this.channel = new Channel(
        PREMID_FRAME_PORT,
        () => ({ type: "hello", activity }),
        (message) => {
          if (message.type === "page-result") this.answers.answer(message.nonce, message.value);
        },
        () => {},
      );
      channels.push(this.channel);
      this.channel.open();
      tickers.add(this.tick);
      schedule();
    }

    private readonly tick = async (): Promise<void> => {
      if (this.channel.closed) {
        tickers.delete(this.tick);
        schedule();
        return;
      }
      await emit(this.listeners, "UpdateData");
    };

    send(data: unknown): void {
      if (jsonSize(data) <= MAX_MESSAGE) this.channel.post({ type: "data", data });
    }

    async getUrl(): Promise<string> {
      return location.href;
    }

    on(event: unknown, listener: unknown): void {
      listen(this.listeners, event, listener);
    }

    execInPage(spec: unknown): Promise<unknown> {
      return execSpec(this.channel, this.answers, spec);
    }
  }

  return { Presence, iFrame, Slideshow, SlideshowSlide, MIN_SLIDE_TIME };
}

/**
 * The API as the arguments a wrapped script is called with, in the order of
 * its parameters (`wrapScript`): the wrapper only names them, since it's
 * repeated in every one of the 1,500 packaged scripts.
 */
export type PremidArgs = readonly [
  PremidApi["Presence"],
  PremidApi["iFrame"],
  PremidApi["Slideshow"],
  PremidApi["SlideshowSlide"],
  PremidApi["MIN_SLIDE_TIME"],
];

const argsOf = (api: PremidApi): PremidArgs => [
  api.Presence,
  api.iFrame,
  api.Slideshow,
  api.SlideshowSlide,
  api.MIN_SLIDE_TIME,
];

/** An Activity's script, wrapped: called with the API it's bound to. */
export type PremidScript = (...api: PremidArgs) => void;

export interface PremidBridge {
  /** Runs an Activity's page script with its API, unless it already runs in this document. `strings` may be left out when there are none. */
  bind(activity: string, script: PremidScript, strings?: Readonly<Record<string, string>>): void;
  /** The same for its iframe script, only ever inside an iframe. */
  bindFrame(
    activity: string,
    script: PremidScript,
    strings?: Readonly<Record<string, string>>,
  ): void;
}

/** Sets up the bridge each wrapped Activity script calls, once per document (and world). */
export function installBridge(scope: object = globalThis): void {
  if (Reflect.has(scope, BRIDGE_KEY)) return;
  const runtime = chrome.runtime;
  connect = (info) => runtime.connect(info);
  withholdStorage(scope);
  if (typeof Reflect.get(scope, "fetch") === "function") {
    answerImageService(scope as Parameters<typeof answerImageService>[0]);
  }
  trackImageOrigins(scope);
  const bound = new Map<string, Channel[]>();
  /**
   * An Activity binds once per document, unless the background stopped it (it
   * was turned off, or its site taken back, and closed its channels): turned
   * on again, its script runs anew rather than staying dead until a reload.
   */
  const claim = (key: string): Channel[] | null => {
    const before = bound.get(key);
    if (before && !(before.length > 0 && before.every((channel) => channel.closed))) return null;
    const channels: Channel[] = [];
    bound.set(key, channels);
    return channels;
  };
  const topFrame = window.top === window;
  const bridge: PremidBridge = {
    bind: (activity, script, strings = {}) => {
      const channels = topFrame ? claim(`page:${activity}`) : null;
      if (channels) script(...argsOf(createApi(activity, strings, channels)));
    },
    bindFrame: (activity, script, strings = {}) => {
      const channels = topFrame ? null : claim(`frame:${activity}`);
      if (channels) script(...argsOf(createApi(activity, strings, channels)));
    },
  };
  Reflect.set(scope, BRIDGE_KEY, bridge);
  document.addEventListener("visibilitychange", schedule);
}
