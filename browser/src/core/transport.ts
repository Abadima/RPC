import type { Presence } from "./presence";

/** Publishes a resolved Presence somewhere outside the browser (Parousia Desktop, a compatible backend, etc). */
export interface PresenceTransport {
  send(presence: Presence): void;
}
