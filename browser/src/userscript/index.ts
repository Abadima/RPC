import { webSocketChannel } from "../core/channel";
import { describeClient } from "../core/client-name";
import { DesktopConnection } from "../core/desktop-connection";
import { PresenceController } from "../core/lifecycle";
import { createLogger } from "../core/logger";
import { builtInActivities } from "../core/activities";
import { PresenceRuntime } from "../core/runtime";
import { connectionStatusLabel } from "../shared/connection-status";

const logger = createLogger("Parousia/userscript");

/**
 * A userscript connects with the origin of the page it runs on (or `null`,
 * from Firefox's content scripts), which Desktop can't tell apart from the
 * page itself, so Desktop only accepts it once "Allow userscripts" is turned
 * on there.
 */
const connection = new DesktopConnection({
  channel: webSocketChannel(),
  clientName: describeClient(navigator, "Userscript in "),
});

const runtime = new PresenceRuntime(builtInActivities());
const controller = new PresenceController(runtime, connection);

/**
 * A userscript has no popup, so this is how to see whether it can reach
 * Desktop: connect briefly and report where that ended up. Desktop turns
 * web origins away without saying why (so pages can't probe for it), which
 * makes "userscripts not allowed" look like "not running"; the hint covers that.
 */
GM_registerMenuCommand("Parousia Desktop status", () => {
  const release = connection.acquire();
  let unsubscribe = (): void => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = (): boolean => !["connecting", "idle"].includes(connection.getState().status);
  const report = (): void => {
    unsubscribe();
    clearTimeout(timeout);
    const state = connection.getState();
    const hint =
      state.status === "disconnected"
        ? " If it's running, turn on “Allow userscripts” in its settings (tray menu, the Parousia dashboard, or `Parousia-Desktop set userscripts on`)."
        : "";
    alert(`Parousia: ${connectionStatusLabel(state)}.${hint}`);
    release();
  };
  if (settled()) {
    report();
    return;
  }
  unsubscribe = connection.onStateChange(() => {
    if (settled()) report();
  });
  // Desktop answers within milliseconds; this only bounds a hung attempt.
  timeout = setTimeout(report, 10_000);
});

function refresh(): void {
  if (document.hidden) {
    controller.clear();
    return;
  }
  const url = new URL(window.location.href);
  controller.update({ url, title: document.title });
  watchTitle(runtime.matches(url));
}

/**
 * A title matters only on a page an Activity looks at, where single-page
 * sites often set it a moment after the URL. Everywhere else, nothing is
 * watched.
 */
let titleObserver: MutationObserver | null = null;
function watchTitle(on: boolean): void {
  if (!on) {
    titleObserver?.disconnect();
    titleObserver = null;
    return;
  }
  if (titleObserver) return;
  let title = document.title;
  titleObserver = new MutationObserver(() => {
    if (document.title === title) return;
    title = document.title;
    refresh();
  });
  titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true });
}

/**
 * The isolated world can't see the page's own `history.pushState` calls, so
 * single-page-app navigation is observed through the Navigation API, whose
 * events every world sees. Where it's missing, only full navigations,
 * back/forward, and hash changes are noticed. No polling either way.
 */
function watchNavigation(onChange: () => void): void {
  const navigation = (globalThis as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("currententrychange", onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
}

watchNavigation(refresh);
document.addEventListener("visibilitychange", refresh);
// Leaving the page: let go of Desktop right away. The page may sit in the
// back/forward cache with its timers frozen, where a lingering connection
// would never close; it resumes if the page comes back.
window.addEventListener("pagehide", () => {
  controller.clear();
  connection.pause();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  connection.resume();
  refresh();
});
refresh();
logger.info("initialized");
