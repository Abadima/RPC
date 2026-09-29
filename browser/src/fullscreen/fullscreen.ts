import { faCircleExclamation } from "@fortawesome/free-solid-svg-icons/faCircleExclamation";
import { faDesktop } from "@fortawesome/free-solid-svg-icons/faDesktop";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import { faGaugeHigh } from "@fortawesome/free-solid-svg-icons/faGaugeHigh";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons/faMagnifyingGlass";
import { faPuzzlePiece } from "@fortawesome/free-solid-svg-icons/faPuzzlePiece";
import { faSliders } from "@fortawesome/free-solid-svg-icons/faSliders";
import { builtInActivities } from "../core/activities";
import type { Preferences } from "../core/preferences";
import {
  connectToBackground,
  displayedState,
  renderConnectionStatus,
} from "../shared/connection-status";
import { fillIcons } from "../shared/icons";
import { createSettingsModel } from "../shared/settings-view";
import { activeTabSnapshot } from "../shared/views";
import { activitiesView } from "./activities";
import { overviewView } from "./overview";
import { settingsView } from "./settings";
import type { ShellState, View, ViewContext } from "./view";

const ICONS = {
  activities: faPuzzlePiece,
  alert: faCircleExclamation,
  desktop: faDesktop,
  download: faDownload,
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
);

// The current tab's Activity, as Privacy settings let it be shared.
async function refreshPresence(): Promise<void> {
  update({
    snapshot: await activeTabSnapshot({ lastFocusedWindow: true }, shell.settings.preferences),
  });
}
let shownPreferences: Preferences | null = null;
settings.subscribe((context) => {
  update({ settings: context });
  if (context.preferences !== shownPreferences) {
    shownPreferences = context.preferences;
    void refreshPresence();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  background.requestStatus();
  void refreshPresence();
});

// Pages: one at a time, from the URL: #overview, #activities?q=…&page=…, #settings/privacy.
const context: ViewContext = {
  activities: builtInActivities().list(),
  settings: settings.actions,
  reconnect: () => background.reconnect(),
  origin: new URL(chrome.runtime.getURL("")).origin,
};
const root = byId("view");

function show(): void {
  const [path = "", query = ""] = location.hash.slice(1).split("?");
  const [name, segment] = path.split("/");
  const route = name === "activities" || name === "settings" ? name : "overview";
  view?.destroy?.();
  view =
    route === "activities"
      ? activitiesView(context, new URLSearchParams(query))
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
