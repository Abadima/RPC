import { PAGE_DATA_KINDS, type PageDataKind, type SettingValue } from "../core/activity";
import type { PageData, PageImage, PageMedia } from "../core/registry";
import { parsePresenceData, type PresenceDataWire } from "../premid/presence-data";

/**
 * What runs in pages talks to the background over one `runtime.connect`
 * port each: a PreMiD Activity's top-frame `Presence` on `PREMID_PORT` and
 * its iframes' `iFrame` on `PREMID_FRAME_PORT` (src/premid/page.ts), and
 * Parousia's collector for native Activities on `PAGE_DATA_PORT`
 * (collector.ts). Everything arriving from a page is untrusted, so every
 * message is parsed into these shapes and bounded first.
 */
export const PREMID_PORT = "parousia-premid";
export const PREMID_FRAME_PORT = "parousia-premid-frame";
export const PAGE_DATA_PORT = "parousia-page-data";

/** Largest message either side accepts, as JSON. */
export const MAX_MESSAGE = 16 * 1024;
/** Largest answer read from a page's own variables, as JSON. */
export const MAX_PAGE_RESULT = 64 * 1024;

/** A read of the page's own variables (`getPageVariable`), or `execInPage`'s declarative form. */
export type PageSpec =
  | { kind: "variables"; paths: string[] }
  | {
      kind: "exec";
      get?: string;
      call?: string;
      args?: unknown[];
      pick?: string[];
      omit?: string[];
    };

export type PageMessage =
  | { type: "hello"; activity: string; clientId: string }
  /** `data: null` clears it. */
  | { type: "activity"; clientId: string; data: PresenceDataWire | null }
  | { type: "page"; nonce: number; spec: PageSpec }
  | { type: "hide"; ids: string[]; hidden: boolean }
  /** The page's iframes changed: new ones may need the Activity's iframe script. */
  | { type: "frames" };

export type FrameMessage =
  | { type: "hello"; activity: string }
  | { type: "data"; data: unknown }
  | { type: "page"; nonce: number; spec: PageSpec };

export type ToPage =
  | { type: "settings"; values: Record<string, SettingValue> }
  | { type: "page-result"; nonce: number; value: unknown }
  | { type: "frame-data"; data: unknown }
  /** Not wanted here (turned off, or not this page's): stop ticking and don't reconnect. */
  | { type: "stop" };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `JSON.stringify(value)`'s length, or `Infinity` when it can't be serialized. */
export function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const PATH = /^[\w$]+(?:\.[\w$]+)*$/;
/** Segments that lead to prototypes rather than a page's own data; `pick` and `omit` would write through them. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const isPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 256 &&
  PATH.test(value) &&
  value.split(".").every((key) => !PROTOTYPE_KEYS.has(key));
const paths = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= 32 && value.every(isPath) ? value : null;

export function parsePageSpec(value: unknown): PageSpec | null {
  if (!isObject(value)) return null;
  if (value.kind === "variables") {
    const list = paths(value.paths);
    return list && list.length > 0 ? { kind: "variables", paths: list } : null;
  }
  if (value.kind !== "exec") return null;
  const spec: PageSpec = { kind: "exec" };
  if (value.get !== undefined) {
    if (!isPath(value.get)) return null;
    spec.get = value.get;
  }
  if (value.call !== undefined) {
    if (!isPath(value.call)) return null;
    spec.call = value.call;
  }
  if ((spec.get === undefined) === (spec.call === undefined)) return null;
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || jsonSize(value.args) > MAX_MESSAGE) return null;
    spec.args = value.args;
  }
  for (const key of ["pick", "omit"] as const) {
    if (value[key] === undefined) continue;
    const list = paths(value[key]);
    if (!list) return null;
    spec[key] = list;
  }
  return spec;
}

const isId = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const isNonce = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parsePageMessage(value: unknown): PageMessage | null {
  if (!isObject(value) || jsonSize(value) > MAX_MESSAGE) return null;
  switch (value.type) {
    case "hello":
      return isId(value.activity, 256) && isId(value.clientId, 32)
        ? { type: "hello", activity: value.activity, clientId: value.clientId }
        : null;
    case "activity": {
      if (!isId(value.clientId, 32)) return null;
      if (value.data === null) return { type: "activity", clientId: value.clientId, data: null };
      const data = parsePresenceData(value.data);
      return data ? { type: "activity", clientId: value.clientId, data } : null;
    }
    case "page": {
      const spec = parsePageSpec(value.spec);
      return spec && isNonce(value.nonce) ? { type: "page", nonce: value.nonce, spec } : null;
    }
    case "hide": {
      const ids = value.ids;
      return Array.isArray(ids) &&
        ids.length <= 64 &&
        ids.every((id): id is string => isId(id, 64)) &&
        typeof value.hidden === "boolean"
        ? { type: "hide", ids, hidden: value.hidden }
        : null;
    }
    case "frames":
      return { type: "frames" };
    default:
      return null;
  }
}

export function parseFrameMessage(value: unknown): FrameMessage | null {
  if (!isObject(value) || jsonSize(value) > MAX_MESSAGE) return null;
  switch (value.type) {
    case "hello":
      return isId(value.activity, 256) ? { type: "hello", activity: value.activity } : null;
    case "data":
      return "data" in value ? { type: "data", data: value.data } : null;
    case "page": {
      const spec = parsePageSpec(value.spec);
      return spec && isNonce(value.nonce) ? { type: "page", nonce: value.nonce, spec } : null;
    }
    default:
      return null;
  }
}

/** What the background sends a page script; parsed there too, since a page only ever expects these. */
export function parseToPage(value: unknown): ToPage | null {
  if (!isObject(value)) return null;
  if (value.type === "settings" && isObject(value.values)) {
    const values: Record<string, SettingValue> = {};
    for (const [id, setting] of Object.entries(value.values)) {
      if (
        typeof setting === "string" ||
        typeof setting === "number" ||
        typeof setting === "boolean"
      ) {
        values[id] = setting;
      }
    }
    return { type: "settings", values };
  }
  if (value.type === "page-result" && isNonce(value.nonce)) {
    return { type: "page-result", nonce: value.nonce, value: value.value };
  }
  if (value.type === "frame-data" && "data" in value) {
    return { type: "frame-data", data: value.data };
  }
  if (value.type === "stop") return { type: "stop" };
  return null;
}

// Parousia's page-data collector (collector.ts), for native Activities.

export type CollectorMessage =
  | { type: "hello"; activity: string }
  | { type: "data"; data: PageData };

export type ToCollector =
  /** What to read: the kinds its Activity declares, isn't denied, and has access for. */
  { type: "collect"; kinds: PageDataKind[] } | { type: "stop" };

const MAX_TEXT = 256;
const MAX_URL = 512;
/** `images` as they're kept: a list that fits a message, of addresses that fit Discord's own limit. */
export const MAX_IMAGES = 24;
export const MAX_IMAGE_URL = 300;
export const MAX_IMAGE_ALT = 64;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined;
const seconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const unixMs = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/** Page data from a page, parsed and bounded. */
export function parsePageData(value: unknown): PageData | null {
  if (!isObject(value)) return null;
  const data: PageData = {};
  if (isObject(value.media)) {
    const media: PageMedia = {};
    for (const field of ["title", "artist", "album"] as const) {
      const found = text(value.media[field]);
      if (found) media[field] = found;
    }
    if (typeof value.media.playing === "boolean") media.playing = value.media.playing;
    if (value.media.kind === "video" || value.media.kind === "audio") media.kind = value.media.kind;
    const duration = seconds(value.media.duration);
    if (duration !== undefined) media.duration = duration;
    const start = unixMs(value.media.start);
    if (start !== undefined) media.start = start;
    const end = unixMs(value.media.end);
    if (end !== undefined) media.end = end;
    if (Object.keys(media).length > 0) data.media = media;
  }
  if (
    typeof value.thumbnail === "string" &&
    value.thumbnail.startsWith("https://") &&
    value.thumbnail.length <= MAX_URL
  ) {
    data.thumbnail = value.thumbnail;
  }
  if (Array.isArray(value.images)) {
    const images: PageImage[] = [];
    for (const item of value.images.slice(0, MAX_IMAGES)) {
      if (!isObject(item)) continue;
      const { src } = item;
      if (typeof src !== "string" || !src.startsWith("https://") || src.length > MAX_IMAGE_URL) {
        continue;
      }
      const alt = typeof item.alt === "string" ? item.alt.trim().slice(0, MAX_IMAGE_ALT) : "";
      images.push(alt ? { src, alt } : { src });
    }
    if (images.length > 0) data.images = images;
  }
  return data;
}

export function parseCollectorMessage(value: unknown): CollectorMessage | null {
  if (!isObject(value) || jsonSize(value) > MAX_MESSAGE) return null;
  if (value.type === "hello")
    return isId(value.activity, 256) ? { type: "hello", activity: value.activity } : null;
  if (value.type === "data") {
    const data = parsePageData(value.data);
    return data ? { type: "data", data } : null;
  }
  return null;
}

export function parseToCollector(value: unknown): ToCollector | null {
  if (!isObject(value)) return null;
  if (value.type === "stop") return { type: "stop" };
  if (value.type === "collect" && Array.isArray(value.kinds)) {
    const kinds: readonly unknown[] = value.kinds;
    return { type: "collect", kinds: PAGE_DATA_KINDS.filter((kind) => kinds.includes(kind)) };
  }
  return null;
}
