import { faArrowLeft } from "@fortawesome/free-solid-svg-icons/faArrowLeft";
import { faCircleExclamation } from "@fortawesome/free-solid-svg-icons/faCircleExclamation";
import { faDesktop } from "@fortawesome/free-solid-svg-icons/faDesktop";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import { faFilter } from "@fortawesome/free-solid-svg-icons/faFilter";
import { faGaugeHigh } from "@fortawesome/free-solid-svg-icons/faGaugeHigh";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons/faMagnifyingGlass";
import { faPenToSquare } from "@fortawesome/free-solid-svg-icons/faPenToSquare";
import { faPuzzlePiece } from "@fortawesome/free-solid-svg-icons/faPuzzlePiece";
import { faSliders } from "@fortawesome/free-solid-svg-icons/faSliders";
import type { ActivityInfo } from "../core/activity";
import { loadCatalog } from "../shared/activity-catalog";
import {
  connectToBackground,
  displayedState,
  renderConnectionStatus,
} from "../shared/connection-status";
import { fillIcons } from "../shared/icons";
import { createSettingsModel } from "../shared/settings-view";
import { presenceSnapshot } from "../shared/views";
import { activitiesView } from "./activities";
import { activityView } from "./activity";
import { defaultView } from "./default";
import { overviewView } from "./overview";
import { settingsView } from "./settings";
import type { ShellState, View, ViewContext } from "./view";

const ICONS = {
  activities: faPuzzlePiece,
  alert: faCircleExclamation,
  back: faArrowLeft,
  default: faPenToSquare,
  desktop: faDesktop,
  download: faDownload,
  filter: faFilter,
  overview: faGaugeHigh,
  search: faMagnifyingGlass,
  settings: faSliders,
};

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`fullscreen.html is missing #${id}`);
  return element;
};

fillIcons(document, ICONS);

const settings = createSettingsModel((setting, value) => background.setSetting(setting, value));
let shell: ShellState = {
  connection: { status: "idle" },
  checking: false,
  snapshot: null,
  settings: settings.context(),
};
let view: View | null = null;

function update(patch: Partial<ShellState>): void {
  shell = { ...shell, ...patch };
  renderConnectionStatus(
    byId("status-dot"),
    byId("status-label"),
    shell.connection,
    shell.settings.report?.version,
  );
  view?.update(shell);
}

const background = connectToBackground(
  (next) => {
    const shown = displayedState(shell.connection, next);
    update({ connection: shown.state, checking: shown.checking });
    if (next.status === "connected") background.requestStatus();
    else if (next.status !== "connecting") settings.onReport(null);
  },
  settings.onReport,
  settings.onDiscord,
  // What's being shared, as Privacy settings allow; the background pushes every change.
  (activity) => update({ snapshot: presenceSnapshot(activity) }),
);

settings.subscribe((context) => update({ settings: context }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) background.requestStatus();
});

let catalog: Promise<ActivityInfo[]> | null = null;

// Pages: one at a time, from the URL: #overview, #activities?q=…&page=…,
// #activities/<id>, #default, #settings/privacy.
const context: ViewContext = {
  catalog: () => (catalog ??= loadCatalog()),
  settings: settings.actions,
  reconnect: () => background.reconnect(),
  origin: new URL(chrome.runtime.getURL("")).origin,
};
const root = byId("view");

/** An Activity id from the hash; a malformed one just finds no Activity. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function show(): void {
  const [path = "", query = ""] = location.hash.slice(1).split("?");
  const [name, segment] = path.split("/");
  const route =
    name === "activities" || name === "default" || name === "settings" ? name : "overview";
  view?.destroy?.();
  view =
    route === "activities" && segment
      ? activityView(context, decodeSegment(segment))
      : route === "activities"
        ? activitiesView(context, new URLSearchParams(query))
        : route === "default"
          ? defaultView()
          : route === "settings"
            ? settingsView(context, segment)
            : overviewView(context);
  fillIcons(view.element, ICONS);
  view.update(shell);
  root.replaceChildren(view.element);
  view.mounted?.();
  document.title = `${view.title} · Parousia`;
  for (const link of document.querySelectorAll<HTMLElement>(".nav-link")) {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", show);
show();
