import type { Activity } from "./activity";
import type { Presence } from "./presence";

/**
 * The Parousia Desktop protocol (project/architecture.md, Communication
 * Protocol), over a `127.0.0.1` WebSocket. The client says `hello`, Desktop
 * answers `welcome` (or `reject`), then Presence flows. Nothing is secret:
 * Desktop decides who may connect from the WebSocket `Origin`, which the
 * browser sets and pages and other extensions can't forge.
 */

/**
 * Must match desktop/src/link/protocol.rs. Raised only when an older peer
 * can't read the wire any more; a new optional field doesn't (see core/version.ts).
 */
export const PROTOCOL_VERSION = 1;
/** Desktop's messages are small; anything near this is not from Desktop. */
export const MAX_SERVER_MESSAGE_CHARS = 16 * 1024;
const MAX_VERSION_CHARS = 32;

export type RejectReason =
  | "unsupported_version"
  | "malformed"
  | "timeout"
  | "origin_not_allowed"
  | "rate_limited"
  | "not_permitted";

const REJECT_REASONS: ReadonlySet<string> = new Set<RejectReason>([
  "unsupported_version",
  "malformed",
  "timeout",
  "origin_not_allowed",
  "rate_limited",
  "not_permitted",
]);

export type DesktopSetting = "allowUserscripts";

/** Desktop's `status` report, for Parousia's dashboard. */
export interface DesktopReport {
  version: string;
  clients: Array<{
    id: number;
    name: string;
    kind: string;
    identity: string;
    connectedSecs: number;
    activity: string | null;
  }>;
  transport: {
    address: string;
    sameUserCheck: boolean;
  };
  settings: { allowedOrigins: string[]; allowUserscripts: boolean };
  refused: Array<{ origin: string; count: number; secsAgo: number }>;
  events: Array<{ secsAgo: number; text: string }>;
  /** Each platform adapter's state (desktop/src/adapters/mod.rs). */
  platforms: DesktopPlatformStatus[];
}

export type AdapterState =
  | "idle"
  | "connecting"
  | "connected"
  | "showing"
  | "not_running"
  | "refused";

export interface DesktopPlatformStatus {
  platform: string;
  state: AdapterState;
  /** The Activity being shown, while `state` is `showing`. */
  activity: string | null;
  error: string | null;
}

const ADAPTER_STATES: ReadonlySet<string> = new Set<AdapterState>([
  "idle",
  "connecting",
  "connected",
  "showing",
  "not_running",
  "refused",
]);

export type ServerMessage =
  | { type: "welcome"; protocolVersion: number; version: string }
  | { type: "reject"; reason: RejectReason }
  | { type: "pong" }
  | { type: "status"; status: DesktopReport };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function everyItem(value: unknown, check: (item: Json) => boolean): boolean {
  return Array.isArray(value) && value.every((item) => isObject(item) && check(item));
}

/** Checks the shape of a report before anything renders it. */
export function isDesktopReport(value: unknown): value is DesktopReport {
  if (!isObject(value) || !isString(value.version)) return false;
  const { transport, settings } = value;
  return (
    everyItem(
      value.clients,
      (c) =>
        isNumber(c.id) &&
        isString(c.name) &&
        isString(c.kind) &&
        isString(c.identity) &&
        isNumber(c.connectedSecs) &&
        (c.activity === null || isString(c.activity)),
    ) &&
    isObject(transport) &&
    isString(transport.address) &&
    isBoolean(transport.sameUserCheck) &&
    isObject(settings) &&
    Array.isArray(settings.allowedOrigins) &&
    settings.allowedOrigins.every(isString) &&
    isBoolean(settings.allowUserscripts) &&
    everyItem(
      value.refused,
      (r) => isString(r.origin) && isNumber(r.count) && isNumber(r.secsAgo),
    ) &&
    everyItem(value.events, (e) => isNumber(e.secsAgo) && isString(e.text)) &&
    everyItem(
      value.platforms,
      (p) =>
        isString(p.platform) &&
        isString(p.state) &&
        ADAPTER_STATES.has(p.state) &&
        (p.activity === null || isString(p.activity)) &&
        (p.error === null || isString(p.error)),
    )
  );
}

/** Strict: anything that isn't exactly a message Desktop sends is `null`. */
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "welcome":
      return isNumber(value.protocolVersion) &&
        isString(value.version) &&
        value.version.length <= MAX_VERSION_CHARS
        ? { type: "welcome", protocolVersion: value.protocolVersion, version: value.version }
        : null;
    case "reject":
      return isString(value.reason) && REJECT_REASONS.has(value.reason)
        ? { type: "reject", reason: value.reason as RejectReason }
        : null;
    case "pong":
      return { type: "pong" };
    case "status":
      return isDesktopReport(value.status) ? { type: "status", status: value.status } : null;
    default:
      return null;
  }
}

/**
 * A Presence as it goes to Desktop: only the fields Desktop takes (its
 * schema refuses anything else), built field by field so nothing the
 * browser keeps for itself, like the page's address, leaves by accident.
 */
export function presenceWire(presence: Presence): Presence {
  const { activity } = presence;
  if (!activity) return { activity: null, updatedAt: presence.updatedAt };
  const wire: Activity = { id: activity.id, name: activity.name };
  if (activity.details !== undefined) wire.details = activity.details;
  if (activity.state !== undefined) wire.state = activity.state;
  if (activity.assets) wire.assets = { ...activity.assets };
  if (activity.timestamps) wire.timestamps = { ...activity.timestamps };
  if (activity.detailsUrl !== undefined) wire.detailsUrl = activity.detailsUrl;
  if (activity.stateUrl !== undefined) wire.stateUrl = activity.stateUrl;
  if (activity.buttons) wire.buttons = activity.buttons.map(({ label, url }) => ({ label, url }));
  if (activity.type !== undefined) wire.type = activity.type;
  if (activity.statusDisplayType !== undefined) wire.statusDisplayType = activity.statusDisplayType;
  if (activity.party) wire.party = { ...activity.party };
  if (activity.discordClientId !== undefined) wire.discordClientId = activity.discordClientId;
  return { activity: wire, updatedAt: presence.updatedAt };
}
