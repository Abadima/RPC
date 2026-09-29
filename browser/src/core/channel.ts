import { MAX_SERVER_MESSAGE_CHARS } from "./desktop-protocol";

/**
 * The transport to Parousia Desktop: a WebSocket to `127.0.0.1`. It only
 * moves JSON messages; the protocol on top (desktop-connection.ts) never
 * sees the socket, and tests swap this for a fake.
 */
export interface ChannelHandlers {
  onOpen(): void;
  /** A parsed JSON message from Desktop (still untrusted: validate before use). */
  onMessage(message: unknown): void;
  /** The channel ended without `close()` being called: Desktop went away, or it never answered at all. */
  onClose(): void;
}

export interface DesktopChannel {
  send(message: object): void;
  /** Ends the channel. `onClose` is not called for a close we asked for. */
  close(): void;
}

export interface ChannelOpener {
  /** Never throws: a channel that can't open reports it through `onClose`. */
  open(handlers: ChannelHandlers): DesktopChannel;
}

export const DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:57179/ws";

/** The subset of the WebSocket API a channel uses; a test seam. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

const OPEN = 1;

function browserSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  const wrapper: WebSocketLike = {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => wrapper.onopen?.();
  socket.onmessage = (event) => wrapper.onmessage?.({ data: event.data });
  socket.onclose = () => wrapper.onclose?.();
  socket.onerror = () => wrapper.onerror?.();
  return wrapper;
}

export function webSocketChannel(
  url: string = DEFAULT_WEBSOCKET_URL,
  createSocket: (url: string) => WebSocketLike = browserSocket,
): ChannelOpener {
  return {
    open(handlers) {
      let socket: WebSocketLike;
      try {
        socket = createSocket(url);
      } catch {
        queueMicrotask(() => handlers.onClose());
        return { send: () => {}, close: () => {} };
      }
      let done = false;
      const detach = (): void => {
        done = true;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
      };
      const ended = (): void => {
        if (done) return;
        detach();
        handlers.onClose();
      };
      socket.onopen = () => handlers.onOpen();
      socket.onmessage = (event) => {
        // Something else squatting the port could send anything.
        if (typeof event.data !== "string" || event.data.length > MAX_SERVER_MESSAGE_CHARS) {
          detach();
          socket.close();
          handlers.onClose();
          return;
        }
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        handlers.onMessage(message);
      };
      socket.onclose = ended;
      socket.onerror = ended;
      return {
        send(message) {
          if (!done && socket.readyState === OPEN) socket.send(JSON.stringify(message));
        },
        close() {
          if (done) return;
          detach();
          socket.close();
        },
      };
    },
  };
}
