import type { ChannelOpener, DesktopChannel } from "./channel";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  presenceWire,
  type DesktopReport,
  type DesktopSetting,
} from "./desktop-protocol";
import type { PlatformId } from "./preferences";
import type { Presence } from "./presence";
import type { PresenceTransport } from "./transport";

/** A steady pace, not a backoff: quick enough to notice Desktop starting, slow enough to cost nothing. */
export const RETRY_DELAY_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 5000;
/** How long an unneeded connection stays open, so switching tabs doesn't reconnect every time. */
const LINGER_MS = 30_000;

/**
 * - `idle`: not connected because nothing needs Desktop right now.
 * - `disconnected`: needed, but nothing answered (Desktop isn't running).
 *   Retrying every `RETRY_DELAY_MS`.
 * - `not_allowed`: Desktop answered, but this extension build isn't one it
 *   trusts; someone has to allow its origin on Desktop.
 * - `incompatible`: Desktop speaks another protocol version.
 */
export type DesktopStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "not_allowed"
  | "incompatible";

export interface ConnectionState {
  status: DesktopStatus;
}

/** Runs `run` after `delayMs`; returns a cancel function. */
export type Timer = (run: () => void, delayMs: number) => () => void;

export interface DesktopConnectionOptions {
  channel: ChannelOpener;
  /** Shown in Desktop's client list, e.g. "Firefox on Linux". */
  clientName: string;
  /** Test seam; defaults to `setTimeout`. */
  setTimer?: Timer;
}

/** What the background script and UI need from the connection. */
export interface DesktopLink extends PresenceTransport {
  /** Where Desktop may show this browser's Presence (Settings > Platforms). */
  setPlatforms(platforms: readonly PlatformId[]): void;
  acquire(): () => void;
  getState(): ConnectionState;
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  reconnect(): void;
  requestStatus(): Promise<DesktopReport | null>;
  setSetting(setting: DesktopSetting, value: boolean): Promise<DesktopReport | null>;
}

interface Session {
  channel: DesktopChannel;
  ready: boolean;
  cancelTimeout: (() => void) | null;
}

const idleChannel: DesktopChannel = { send: () => {}, close: () => {} };

const defaultTimer: Timer = (run, delayMs) => {
  const id = setTimeout(run, delayMs);
  return () => clearTimeout(id);
};

/**
 * The browser's connection to Parousia Desktop.
 *
 * Demand-driven: it connects only while something needs Desktop (an Activity
 * is being reported, or a popup or dashboard is open), and lets go
 * `LINGER_MS` after the last need. Retries happen only while needed, from
 * in-memory timers, so an idle browser holds no socket and runs no timers.
 * Keeping an MV3 background alive meanwhile is the background script's job
 * (see platforms/background.ts), not this connection's.
 */
export class DesktopConnection implements DesktopLink {
  readonly #opener: ChannelOpener;
  readonly #clientName: string;
  readonly #setTimer: Timer;

  #latest: Presence | null = null;
  /** `null` until chosen: Desktop then shows it everywhere. */
  #platforms: readonly PlatformId[] | null = null;
  #uiDemand = 0;
  #session: Session | null = null;
  /** Desktop refused this build or version; don't retry until someone looks. */
  #blocked = false;
  #stopped = false;
  #paused = false;
  #cancelRetry: (() => void) | null = null;
  #cancelLinger: (() => void) | null = null;
  /** Replies to `status`/`set`, which Desktop answers in order. */
  readonly #pending: Array<(report: DesktopReport | null) => void> = [];
  #state: ConnectionState = { status: "idle" };
  readonly #listeners = new Set<(state: ConnectionState) => void>();

  constructor(options: DesktopConnectionOptions) {
    this.#opener = options.channel;
    this.#clientName = options.clientName;
    this.#setTimer = options.setTimer ?? defaultTimer;
  }

  /** Only the latest Presence matters: it's sent now if connected, and again after every reconnect. */
  send(presence: Presence): void {
    this.#latest = presence;
    this.#sendPresence();
    this.#evaluate();
  }

  /** Sent with every Presence; a change resends the current one so Desktop can act on it. */
  setPlatforms(platforms: readonly PlatformId[]): void {
    const current = this.#platforms;
    if (current?.length === platforms.length && current.every((id, i) => id === platforms[i])) {
      return;
    }
    this.#platforms = [...platforms];
    this.#sendPresence();
  }

  /** Keeps the connection up while a UI is showing its state; call the returned function when it closes. */
  acquire(): () => void {
    this.#uiDemand++;
    // Someone is looking: try again even if Desktop refused us before.
    this.#blocked = false;
    this.#evaluate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#uiDemand--;
      this.#evaluate();
    };
  }

  /**
   * Tries again now instead of waiting for the next retry (or after a refusal), for
   * someone who just started Desktop or allowed this build. An attempt
   * already under way, or a working connection, is left alone.
   */
  reconnect(): void {
    if (this.#halted() || this.#session) return;
    this.#cancelPendingRetry();
    this.#blocked = false;
    this.#evaluate();
  }

  requestStatus(): Promise<DesktopReport | null> {
    return this.#request({ type: "status" });
  }

  /** Desktop only honors this from a connection the OS confirms is this user's. */
  setSetting(setting: DesktopSetting, value: boolean): Promise<DesktopReport | null> {
    return this.#request({ type: "set", setting, value });
  }

  getState(): ConnectionState {
    return this.#state;
  }

  /** The listener isn't called with the current state; read `getState()` for that. */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Lets go of Desktop at once, until `resume()`. For a page being left: it
   * may come back from the back/forward cache, and until then its timers
   * don't run, so a lingering connection would never close.
   */
  pause(): void {
    if (this.#paused || this.#stopped) return;
    this.#paused = true;
    this.#endSession();
    this.#cancelPendingRetry();
    this.#setState("idle");
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#evaluate();
  }

  /** Stops for good (tests, teardown). */
  close(): void {
    this.#stopped = true;
    this.#endSession();
    this.#cancelPendingRetry();
    this.#setState("idle");
  }

  #request(message: object): Promise<DesktopReport | null> {
    if (!this.#session?.ready) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#pending.push(resolve);
      this.#session?.channel.send(message);
    });
  }

  #halted(): boolean {
    return this.#stopped || this.#paused;
  }

  #wanted(): boolean {
    return this.#uiDemand > 0 || this.#latest?.activity != null;
  }

  /** Reconciles what's open with what's needed. Called after anything changes. */
  #evaluate(): void {
    if (this.#halted()) return;
    if (!this.#wanted()) {
      this.#cancelPendingRetry();
      if (this.#session?.ready) {
        this.#startLinger();
      } else {
        this.#endSession();
        this.#setState("idle");
      }
      return;
    }
    this.#stopLinger();
    if (this.#session || this.#cancelRetry || this.#blocked) return;
    this.#setState("connecting");
    this.#open();
  }

  #open(): void {
    const session: Session = { channel: idleChannel, ready: false, cancelTimeout: null };
    /** Nothing usable answered: give up on this attempt and retry later. */
    const failed = (): void => {
      if (this.#session !== session) return;
      this.#endSession();
      this.#retry();
    };
    this.#session = session;
    session.channel = this.#opener.open({
      onOpen: () => {
        if (this.#session !== session) return;
        session.channel.send({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          name: this.#clientName,
        });
      },
      onMessage: (raw) => {
        if (this.#session === session) this.#receive(session, raw, failed);
      },
      onClose: failed,
    });
    session.cancelTimeout = this.#setTimer(failed, HANDSHAKE_TIMEOUT_MS);
  }

  #receive(session: Session, raw: unknown, failed: () => void): void {
    const message = parseServerMessage(raw);
    if (!session.ready) {
      if (message?.type === "welcome" && message.protocolVersion === PROTOCOL_VERSION) {
        this.#ready(session);
      } else if (
        message?.type === "reject" &&
        (message.reason === "origin_not_allowed" || message.reason === "unsupported_version")
      ) {
        // Retrying can't change this answer; wait until someone looks.
        this.#endSession();
        this.#blocked = true;
        this.#setState(message.reason === "origin_not_allowed" ? "not_allowed" : "incompatible");
      } else {
        // Another reject, or something that isn't Desktop squatting the port.
        failed();
      }
      return;
    }
    if (message?.type === "status") {
      this.#pending.shift()?.(message.status);
    } else if (message?.type === "reject" && message.reason === "not_permitted") {
      this.#pending.shift()?.(null);
    }
    // `pong`, and Desktop's non-fatal rejects of single frames: nothing to do.
  }

  #ready(session: Session): void {
    session.cancelTimeout?.();
    session.cancelTimeout = null;
    session.ready = true;
    this.#setState("connected");
    this.#sendPresence();
    this.#evaluate();
  }

  #sendPresence(): void {
    const latest = this.#latest;
    if (!latest || !this.#session?.ready) return;
    const presence = presenceWire(latest);
    const platforms = this.#platforms;
    this.#session.channel.send(
      platforms ? { type: "presence", presence, platforms } : { type: "presence", presence },
    );
  }

  #retry(): void {
    this.#setState("disconnected");
    if (this.#halted() || !this.#wanted()) {
      this.#evaluate();
      return;
    }
    this.#cancelRetry = this.#setTimer(() => {
      this.#cancelRetry = null;
      this.#evaluate();
    }, RETRY_DELAY_MS);
  }

  #cancelPendingRetry(): void {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
  }

  #endSession(): void {
    const session = this.#session;
    this.#stopLinger();
    for (const resolve of this.#pending.splice(0)) resolve(null);
    if (!session) return;
    this.#session = null;
    session.cancelTimeout?.();
    session.channel.close();
  }

  #startLinger(): void {
    if (this.#cancelLinger) return;
    this.#cancelLinger = this.#setTimer(() => {
      this.#cancelLinger = null;
      if (this.#wanted()) return;
      this.#endSession();
      this.#setState("idle");
    }, LINGER_MS);
  }

  #stopLinger(): void {
    this.#cancelLinger?.();
    this.#cancelLinger = null;
  }

  #setState(status: DesktopStatus): void {
    if (this.#state.status === status) return;
    this.#state = { status };
    for (const listener of this.#listeners) listener(this.#state);
  }
}
