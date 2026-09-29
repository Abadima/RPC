import type { ConnectionState, DesktopStatus } from "./desktop-connection";
import { isDesktopReport, type DesktopReport, type DesktopSetting } from "./desktop-protocol";

/**
 * The popup and dashboard talk to the background script over one long-lived
 * `runtime.connect` port each. A UI never reaches Desktop itself; the
 * background owns the only connection. An open port also tells the
 * background someone is looking, which keeps the Desktop connection up (and
 * the MV3 background alive) exactly as long as a UI is showing.
 */
export const UI_PORT_NAME = "parousia-ui";

export type UiRequest =
  | { type: "status-request" }
  /** Try Desktop again now, instead of waiting for the next retry. */
  | { type: "reconnect" }
  | { type: "set"; setting: DesktopSetting; value: boolean };

/**
 * Another way to reach a platform without Desktop, such as Discord through
 * Discord-RPC-Extension's app (see `compat/discord-rpc-server.ts`), as a UI
 * shows it. Defined here so `core/` never depends on `compat/`.
 */
export type BridgeStatus = "off" | "idle" | "connecting" | "connected" | "unavailable";
export interface BridgeState {
  status: BridgeStatus;
  version: string | null;
}

export type UiEvent =
  | { type: "state"; state: ConnectionState }
  /** `null`: not connected, or Desktop refused (a `set` from an unverified connection). */
  | { type: "report"; report: DesktopReport | null }
  | { type: "discord"; state: BridgeState };

const BRIDGE_STATUSES: ReadonlySet<string> = new Set<BridgeStatus>([
  "off",
  "idle",
  "connecting",
  "connected",
  "unavailable",
]);

const STATUSES: ReadonlySet<string> = new Set<DesktopStatus>([
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "not_allowed",
  "incompatible",
]);

export function parseUiRequest(value: unknown): UiRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "status-request") return { type: "status-request" };
  if (message.type === "reconnect") return { type: "reconnect" };
  if (
    message.type === "set" &&
    message.setting === "allowUserscripts" &&
    typeof message.value === "boolean"
  ) {
    return { type: "set", setting: message.setting, value: message.value };
  }
  return null;
}

export function parseUiEvent(value: unknown): UiEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "state") {
    const state = message.state as Record<string, unknown> | null;
    if (typeof state?.status === "string" && STATUSES.has(state.status)) {
      return { type: "state", state: { status: state.status as DesktopStatus } };
    }
    return null;
  }
  if (message.type === "report" && (message.report === null || isDesktopReport(message.report))) {
    return { type: "report", report: message.report };
  }
  if (message.type === "discord") {
    const state = message.state as Record<string, unknown> | null;
    if (
      typeof state?.status === "string" &&
      BRIDGE_STATUSES.has(state.status) &&
      (state.version === null || (typeof state.version === "string" && state.version.length <= 32))
    ) {
      return {
        type: "discord",
        state: { status: state.status as BridgeStatus, version: state.version },
      };
    }
  }
  return null;
}
