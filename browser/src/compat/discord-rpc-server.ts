import type { Activity } from "../core/activity";
import type { Timer } from "../core/desktop-connection";
import type { Presence } from "../core/presence";
import type { PresenceTransport } from "../core/transport";
import type { BridgeState, BridgeStatus } from "../core/ui-port";
import { toDiscordPresence } from "./discord-rpc-extension";

/**
 * Discord Rich Presence through Discord-RPC-Extension's own app
 * (github.com/lolamtisch/Discord-RPC-Extension: `discord_rpc_ext` on Linux,
 * its Node `server.js` elsewhere), for anyone without Parousia Desktop.
 *
 * The app is a WebSocket server on port 6969 with no authentication, so this
 * is locked down to plain Rich Presence, checked against its `server.js` and
 * `Server/presence.js`:
 *
 * - Only two messages are ever sent: `{clientId, presence, extId}` to show an
 *   activity (`extId` is required: without it the app throws on a new client
 *   id and exits), and `{action: "disconnect"}` to clear it. Never `party` or
 *   `reply`.
 * - Of what the app sends back, only `{version}` is read. Its `join`,
 *   `spectate`, and `joinRequest` messages are ignored.
 * - The app clears a presence it hasn't heard about for 30 seconds, so a
 *   shown one is resent every 15.
 * - "Clear" is only sent after this link showed something, so it never wipes
 *   presence another tool (MAL-Sync, the real extension) put there.
 * - Only `127.0.0.1` is used, even though the app listens on every interface.
 */
export const DISCORD_RPC_SERVER_URL = "ws://127.0.0.1:6969";
const RESEND_MS = 15_000;
const RETRY_MS = 10_000;
const LINGER_MS = 30_000;
const MAX_VERSION_CHARS = 32;

/** `version` is the app's own, once it has said it. */
export type DiscordLinkState = BridgeState;
type DiscordLinkStatus = BridgeStatus;

/** The slice of `WebSocket` this uses; tests pass a fake. */
export interface ServerSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface DiscordRpcServerOptions {
  /** The Discord Application to show `activity` as, or `null` if it has none. */
  clientIdFor: (activity: Activity) => string | null;
  /** Identifies this extension to the app; any stable string. */
  extId: string;
  open?: (url: string) => ServerSocket;
  setTimer?: Timer;
}

function parseVersion(data: unknown): string | null {
  if (typeof data !== "string" || data.length > 256) return null;
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null || !("version" in message)) return null;
    const { version } = message;
    return typeof version === "string" && version.length <= MAX_VERSION_CHARS ? version : null;
  } catch {
    return null;
  }
}

/** A real WebSocket behind the narrow ServerSocket shape. */
function openWebSocket(url: string): ServerSocket {
  const socket = new WebSocket(url);
  const adapter: ServerSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  socket.onopen = () => adapter.onopen?.();
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  // An error is always followed by a close, which is where it's handled.
  socket.onclose = () => adapter.onclose?.();
  return adapter;
}

const defaultTimer: Timer = (run, delayMs) => {
  const id = setTimeout(run, delayMs);
  return () => clearTimeout(id);
};

/**
 * Connects on demand, like the Desktop link: while a popup or dashboard is
 * open (to show whether the app is there) or while there's an activity to
 * show, retrying every 10 seconds, and letting go 30 seconds after the last
 * need.
 *
 * It can also yield: while `setYielding(true)`, it neither connects, probes,
 * nor shows anything, and what it had shown is cleared at once. The
 * background yields while Parousia Desktop is connected (or hasn't yet
 * failed), so this app is only a fallback.
 */
export class DiscordRpcServerLink implements PresenceTransport {
  readonly #options: Required<DiscordRpcServerOptions>;
  #enabled = false;
  #yielding = false;
  #uiDemand = 0;
  #latest: Activity | null = null;
  #socket: ServerSocket | null = null;
  #open = false;
  /** This link showed a presence that it hasn't cleared yet. */
  #showing = false;
  #state: DiscordLinkState = { status: "off", version: null };
  readonly #listeners = new Set<(state: DiscordLinkState) => void>();
  #cancelRetry: (() => void) | null = null;
  #cancelResend: (() => void) | null = null;
  #cancelLinger: (() => void) | null = null;

  constructor(options: DiscordRpcServerOptions) {
    this.#options = {
      open: openWebSocket,
      setTimer: defaultTimer,
      ...options,
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#clear();
      this.#close();
      this.#setState("off", null);
      return;
    }
    this.#setState("idle", null);
    this.#evaluate();
  }

  /**
   * Steps aside for, or takes back from, the primary transport: a yielding
   * link clears what it showed, closes, and stays quiet whatever wants it.
   */
  setYielding(yielding: boolean): void {
    if (yielding === this.#yielding) return;
    this.#yielding = yielding;
    if (!this.#enabled) return;
    if (yielding) {
      this.#clear();
      this.#close();
      this.#setState("idle", null);
    } else {
      this.#evaluate();
    }
  }

  /** Keeps the link up while a UI shows its state; call the returned function when it closes. */
  acquire(): () => void {
    this.#uiDemand++;
    this.#evaluate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#uiDemand--;
      this.#evaluate();
    };
  }

  send(presence: Presence): void {
    this.#latest = presence.activity;
    if (this.#open) this.#publish();
    this.#evaluate();
  }

  getState(): DiscordLinkState {
    return this.#state;
  }

  onStateChange(listener: (state: DiscordLinkState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The activity to show and the Discord Application to show it as, if there's both. */
  #shareable(): { activity: Activity; clientId: string } | null {
    const activity = this.#latest;
    const clientId = activity && this.#options.clientIdFor(activity);
    return activity && clientId ? { activity, clientId } : null;
  }

  #wanted(): boolean {
    return this.#enabled && !this.#yielding && (this.#uiDemand > 0 || this.#shareable() !== null);
  }

  #evaluate(): void {
    if (!this.#enabled) return;
    if (!this.#wanted()) {
      this.#cancelRetry?.();
      this.#cancelRetry = null;
      if (this.#open) {
        this.#cancelLinger ??= this.#options.setTimer(() => {
          this.#cancelLinger = null;
          this.#close();
          this.#setState("idle", null);
        }, LINGER_MS);
      } else if (!this.#socket) {
        this.#setState("idle", null);
      }
      return;
    }
    this.#cancelLinger?.();
    this.#cancelLinger = null;
    if (this.#socket || this.#cancelRetry) return;
    this.#connect();
  }

  #connect(): void {
    this.#setState("connecting", null);
    const socket = this.#options.open(DISCORD_RPC_SERVER_URL);
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#open = true;
      this.#setState("connected", this.#state.version);
      this.#publish();
    };
    socket.onmessage = ({ data }) => {
      const version = this.#socket === socket ? parseVersion(data) : null;
      if (version) this.#setState("connected", version);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#dropSocket();
      // The app clears everything it showed for a connection that's gone.
      this.#showing = false;
      this.#setState(this.#enabled ? "unavailable" : "off", null);
      if (!this.#wanted()) {
        if (this.#enabled) this.#setState("idle", null);
        return;
      }
      this.#cancelRetry = this.#options.setTimer(() => {
        this.#cancelRetry = null;
        this.#evaluate();
      }, RETRY_MS);
    };
  }

  /** Shows the current activity, or clears the one this link showed. */
  #publish(): void {
    this.#cancelResend?.();
    this.#cancelResend = null;
    const shareable = this.#shareable();
    if (!shareable) {
      this.#clear();
      return;
    }
    this.#write({
      clientId: shareable.clientId,
      presence: toDiscordPresence(shareable.activity),
      extId: this.#options.extId,
    });
    this.#showing = true;
    this.#cancelResend = this.#options.setTimer(() => {
      this.#cancelResend = null;
      if (this.#open) this.#publish();
    }, RESEND_MS);
  }

  #clear(): void {
    if (this.#showing && this.#open) this.#write({ action: "disconnect" });
    this.#showing = false;
  }

  #write(message: object): void {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch {
      // Closing; onclose follows.
    }
  }

  #dropSocket(): void {
    this.#socket = null;
    this.#open = false;
    this.#cancelResend?.();
    this.#cancelResend = null;
    this.#cancelLinger?.();
    this.#cancelLinger = null;
  }

  #close(): void {
    const socket = this.#socket;
    this.#dropSocket();
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }

  #setState(status: DiscordLinkStatus, version: string | null): void {
    if (status === this.#state.status && version === this.#state.version) return;
    this.#state = { status, version };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
