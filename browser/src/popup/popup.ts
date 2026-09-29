import { faArrowLeft } from "@fortawesome/free-solid-svg-icons/faArrowLeft";
import { faCircleExclamation } from "@fortawesome/free-solid-svg-icons/faCircleExclamation";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import { faUpRightAndDownLeftFromCenter } from "@fortawesome/free-solid-svg-icons/faUpRightAndDownLeftFromCenter";
import { renderPresence } from "../../../packages/presence-view/mount";
import type { ConnectionState } from "../core/desktop-connection";
import type { Preferences } from "../core/preferences";
import {
  connectToBackground,
  displayedState,
  isOffline,
  renderConnectionStatus,
} from "../shared/connection-status";
import { fillIcons } from "../shared/icons";
import {
  categoryList,
  createSettingsModel,
  pageTitle,
  settingsPage,
  type SettingsPageId,
  type SettingsPageView,
} from "../shared/settings-view";
import {
  activeTabSnapshot,
  presenceIcons,
  renderBadge,
  renderDiscordAside,
  renderOffline,
} from "../shared/views";

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup.html is missing #${id}`);
  return element;
};

fillIcons(document, {
  alert: faCircleExclamation,
  back: faArrowLeft,
  download: faDownload,
  expand: faUpRightAndDownLeftFromCenter,
  settings: faGear,
});

function openDashboard(section = ""): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`fullscreen.html${section}`) });
  window.close();
}

const origin = new URL(chrome.runtime.getURL("")).origin;
/** What's shown, which lags the real state while a retry is in flight (see displayedState). */
let state: ConnectionState = { status: "idle" };
let sharing = false;

const settings = createSettingsModel((setting, value) => background.setSetting(setting, value));

/** The footer, as in the design: "Connected to Parousia Desktop v1.0.0" once the version is known. */
function renderFooter(): void {
  renderConnectionStatus(
    byId("status-dot"),
    byId("status-label"),
    state,
    settings.context().report?.version,
  );
}

const background = connectToBackground(
  (next) => {
    const shown = displayedState(state, next);
    state = shown.state;
    renderFooter();
    renderBadge(byId("status-badge"), state, sharing);
    // Desktop missing is its own screen (Figma: screen-3-disconnected), not a banner over the activity.
    const offline = isOffline(state);
    byId("activity-view").hidden = offline;
    byId("offline-view").hidden = !offline;
    renderOffline(byId("offline-view"), state, shown.checking, origin);
    if (next.status === "connected") background.requestStatus();
    else if (next.status !== "connecting") settings.onReport(null);
  },
  (report) => {
    settings.onReport(report);
    renderFooter();
  },
  (discord) => {
    settings.onDiscord(discord);
    renderDiscordAside(byId("discord-aside"), discord);
  },
);

// Current activity, as Privacy settings let it be shared; checked again when they change.
let shownPreferences: Preferences | null = null;
async function refreshPresence(preferences: Preferences): Promise<void> {
  const snapshot = await activeTabSnapshot({ currentWindow: true }, preferences);
  sharing = snapshot.activity !== null;
  renderPresence(byId("content"), snapshot, presenceIcons);
  renderBadge(byId("status-badge"), state, sharing);
}

// Views: home, the settings list, and one settings page.
const homeView = byId("home-view");
const settingsView = byId("settings-view");
const settingsSlot = byId("settings-slot");
let openPage: SettingsPageView | null = null;
let currentPage: SettingsPageId | null = null;

function showHome(): void {
  openPage = null;
  currentPage = null;
  homeView.hidden = false;
  settingsView.hidden = true;
  byId("home-title").hidden = false;
  byId("settings-title").hidden = true;
  byId("settings-button").hidden = false;
  byId("status-badge").hidden = false;
  byId("settings-button").focus();
}

function showSettings(page: SettingsPageId | null): void {
  currentPage = page;
  homeView.hidden = true;
  settingsView.hidden = false;
  byId("home-title").hidden = true;
  byId("settings-title").hidden = false;
  byId("settings-button").hidden = true;
  byId("status-badge").hidden = true;
  byId("settings-heading").hidden = page !== null;
  byId("crumb-separator").hidden = page === null;
  byId("crumb-page").textContent = page ? pageTitle(page) : "";
  // On the list, "Settings" is where you are; on a page, it's the way back.
  (byId("crumb-settings") as HTMLButtonElement).disabled = page === null;

  if (page) {
    openPage = settingsPage(page, settings.actions);
    openPage.update(settings.context());
    settingsSlot.replaceChildren(openPage.element);
  } else {
    openPage = null;
    settingsSlot.replaceChildren(categoryList(showSettings));
  }
  byId("back-button").focus();
}

settings.subscribe((context) => {
  openPage?.update(context);
  if (context.preferences !== shownPreferences) {
    shownPreferences = context.preferences;
    void refreshPresence(context.preferences);
  }
});

byId("back-button").addEventListener("click", () =>
  currentPage ? showSettings(null) : showHome(),
);
byId("crumb-settings").addEventListener("click", () => showSettings(null));
byId("settings-button").addEventListener("click", () => showSettings(null));
byId("retry-button").addEventListener("click", () => background.reconnect());
byId("expand-button").addEventListener("click", () =>
  openDashboard(settingsView.hidden ? "" : "#settings"),
);
