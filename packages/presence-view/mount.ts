import { renderPresence } from "./render";
import type { PresenceSource, PresenceViewOptions } from "./types";

/**
 * Renders once, then again whenever the page becomes visible, such as a
 * fullscreen view left open in a background tab. No polling.
 */
export function mountPresenceView(
  root: HTMLElement,
  source: PresenceSource,
  options: PresenceViewOptions = {},
): void {
  async function refresh(): Promise<void> {
    renderPresence(root, await source(), options);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refresh();
    }
  });

  void refresh();
}

export { formatElapsed, renderPresence } from "./render";
export type {
  PresenceActivity,
  PresenceIconName,
  PresenceSnapshot,
  PresenceSource,
  PresenceViewOptions,
} from "./types";
