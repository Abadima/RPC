import { native } from "parousia:activities";
import { registered, type ActivityManifest } from "../activities/manifest";
import { ActivityRegistry } from "./registry";

/**
 * The native Activities this build includes (the build generates
 * `parousia:activities` from parousia-project/activities; see
 * scripts/activities/), for the background script and the userscript.
 * PreMiD Activities join a registry when they're turned on
 * (src/activities/host.ts).
 */
export function builtInActivities(): ActivityRegistry {
  const registry = new ActivityRegistry();
  for (const { manifest, module } of native) registry.register(registered(manifest, module));
  return registry;
}

/** The native Activities' manifests, for the page host (the ones that take page data). */
export function builtInManifests(): ActivityManifest[] {
  return native.map(({ manifest }) => manifest);
}
