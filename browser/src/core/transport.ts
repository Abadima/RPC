import type { Presence } from "./presence";

export interface PresenceTransport {
  send(presence: Presence): void;
}
