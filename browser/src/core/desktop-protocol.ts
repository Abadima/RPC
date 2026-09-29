/**
 * The Parousia Desktop protocol (project/architecture.md, Communication
 * Protocol), over a `127.0.0.1` WebSocket. The client says `hello`, Desktop
 * answers `welcome` (or `reject`), then Presence flows. Nothing is secret:
 * Desktop decides who may connect from the WebSocket `Origin`, which the
 * browser sets and pages and other extensions can't forge.
 */

/** Must match desktop/src/protocol.rs. */
export const PROTOCOL_VERSION = 4;
/** Desktop's messages are small; anything near this is not from Desktop. */
export const MAX_SERVER_MESSAGE_CHARS = 16 * 1024;

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
}

export type ServerMessage =
  | { type: "welcome"; protocolVersion: number }
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
    everyItem(value.events, (e) => isNumber(e.secsAgo) && isString(e.text))
  );
}

/** Strict: anything that isn't exactly a message Desktop sends is `null`. */
export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "welcome":
      return isNumber(value.protocolVersion)
        ? { type: "welcome", protocolVersion: value.protocolVersion }
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
