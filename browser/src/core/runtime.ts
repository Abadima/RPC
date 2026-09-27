import { createPresence, type Presence } from "./presence";
import type { ActivityRegistry } from "./registry";

export class PresenceRuntime {
  constructor(private readonly registry: ActivityRegistry) {}

  resolve(url: URL): Presence {
    const registered = this.registry.resolve(url);
    const activity = registered?.detect(url) ?? null;
    return createPresence(activity);
  }
}
