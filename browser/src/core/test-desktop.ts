/**
 * Test helpers: a fake Parousia Desktop speaking the current protocol, a
 * channel wired to it, and manual timers.
 */
import type { ChannelHandlers, ChannelOpener, DesktopChannel } from "./channel";
import { PROTOCOL_VERSION, type DesktopReport, type RejectReason } from "./desktop-protocol";
import type { Timer } from "./desktop-connection";

type Behavior =
  /** Speaks the protocol. */
  | "normal"
  /** Nothing listening: the channel closes before any message. */
  | "absent"
  /** Accepts the connection and never says anything. */
  | "silent"
  /** Something that isn't Desktop: sends garbage first. */
  | "garbage";

export const REPORT: DesktopReport = {
  version: "1.0.0",
  clients: [],
  transport: { address: "127.0.0.1:57179", sameUserCheck: true },
  settings: { allowedOrigins: [], allowUserscripts: false },
  refused: [],
  events: [],
  platforms: [{ platform: "discord", state: "idle", activity: null, error: null }],
};

export class FakeDesktop {
  protocolVersion = PROTOCOL_VERSION;
  /** Answer `hello` with this reject instead of `welcome`. */
  rejectHello: RejectReason | null = null;
  /** Answer `set` with `not_permitted`. */
  refuseSettings = false;
  readonly received: Array<Record<string, unknown>> = [];
  readonly connections: FakeServerConnection[] = [];

  presences(): unknown[] {
    return this.received.filter((m) => m.type === "presence").map((m) => m.presence);
  }
}

export class FakeServerConnection implements DesktopChannel {
  ended = false;
  closedByClient = false;

  constructor(
    private readonly desktop: FakeDesktop,
    private readonly handlers: ChannelHandlers,
    private readonly behavior: Behavior,
  ) {}

  start(): void {
    queueMicrotask(() => {
      if (this.behavior === "absent") {
        this.end();
        return;
      }
      this.handlers.onOpen();
      if (this.behavior === "garbage") this.reply({ hello: "i am a different server" });
    });
  }

  reply(message: object): void {
    if (this.ended || this.closedByClient) return;
    this.handlers.onMessage(JSON.parse(JSON.stringify(message)));
  }

  /** Desktop (or the network) ends the connection. */
  end(): void {
    if (this.ended || this.closedByClient) return;
    this.ended = true;
    this.handlers.onClose();
  }

  send(message: object): void {
    if (this.ended || this.closedByClient) return;
    const parsed = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
    this.desktop.received.push(parsed);
    if (this.behavior !== "normal") return;
    queueMicrotask(() => this.answer(parsed));
  }

  private answer(message: Record<string, unknown>): void {
    switch (message.type) {
      case "hello":
        if (this.desktop.rejectHello) {
          this.reply({ type: "reject", reason: this.desktop.rejectHello });
          this.end();
        } else {
          this.reply({ type: "welcome", protocolVersion: this.desktop.protocolVersion });
        }
        return;
      case "ping":
        this.reply({ type: "pong" });
        return;
      case "status":
        this.reply({ type: "status", status: REPORT });
        return;
      case "set":
        this.reply(
          this.desktop.refuseSettings
            ? { type: "reject", reason: "not_permitted" }
            : {
                type: "status",
                status: {
                  ...REPORT,
                  settings: { ...REPORT.settings, [String(message.setting)]: message.value },
                },
              },
        );
        return;
    }
  }

  close(): void {
    this.closedByClient = true;
  }
}

export interface FakeChannel extends ChannelOpener {
  behavior: Behavior;
  readonly opened: FakeServerConnection[];
}

export function fakeChannel(desktop: FakeDesktop, behavior: Behavior = "normal"): FakeChannel {
  const channel: FakeChannel = {
    behavior,
    opened: [],
    open(handlers) {
      const conn = new FakeServerConnection(desktop, handlers, channel.behavior);
      channel.opened.push(conn);
      desktop.connections.push(conn);
      conn.start();
      return conn;
    },
  };
  return channel;
}

export interface ManualTimers {
  setTimer: Timer;
  /** Runs every timer that's due within `ms` from now, in order. */
  advance(ms: number): void;
  pending(): number;
}

export function manualTimers(): ManualTimers {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer(run, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, run });
      return () => timers.delete(id);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/** Lets queued microtasks settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
