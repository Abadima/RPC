import { faArrowLeft } from "@fortawesome/free-solid-svg-icons/faArrowLeft";
import { faCircleExclamation } from "@fortawesome/free-solid-svg-icons/faCircleExclamation";
import { faDownload } from "@fortawesome/free-solid-svg-icons/faDownload";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import { faUpRightAndDownLeftFromCenter } from "@fortawesome/free-solid-svg-icons/faUpRightAndDownLeftFromCenter";
import { renderPresence } from "../shared/presence-view";
import type { ActivityInfo } from "../core/activity";
import {
  loadActivityStates,
  watchActivityStates,
  type ActivityStates,
} from "../core/activity-state";
import { DEFAULT_ACTIVITY_ID } from "../core/default-activity";
import type { ConnectionState } from "../core/desktop-connection";
import { NO_GRANTS, missingSites, siteName, type Grants } from "../core/site-access";
import type { UiActivity } from "../core/ui-port";
import {
  activityStatus,
  findActivity,
  loadActivityInfo,
  readGrants,
  requestAccess,
  turnOn,
  watchGrants,
  type ActivityStatus,
} from "../shared/activity-catalog";
import { activitySettings } from "../shared/activity-settings";
import { activityIcon } from "../shared/activity-ui";
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
  presenceIcons,
  presenceSnapshot,
  renderBadge,
  renderDiscordAside,
  renderOffline,
} from "../shared/views";

const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`popup.html is missing #${id}`);
  return element;
};
const buttonById = (id: string): HTMLButtonElement => {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} isn't a button`);
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
/** What the background is sharing; `undefined` until it says. */
let shared: UiActivity | null | undefined;
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
    renderHome();
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
  // What's being shared, as Privacy settings allow; the background pushes every change.
  (activity) => {
    shared = activity;
    sharing = activity !== null;
    if (activity) renderPresence(byId("content"), presenceSnapshot(activity), presenceIcons);
    byId("configure-button").hidden =
      !activity?.configurable && activity?.id !== DEFAULT_ACTIVITY_ID;
    renderBadge(byId("status-badge"), state, sharing);
    renderHome();
    if (!activity) void findForTab();
  },
);

// Home: what's shared; or else the tab's Activity that isn't running, and
// why; or else a line saying there's nothing to share here.

interface Found {
  info: ActivityInfo;
  status: ActivityStatus;
  url: URL;
}
let found: Found | null = null;
let states: ActivityStates = {};
let grants: Grants = NO_GRANTS;
let busy = false;
/** The browser declined the last request; the card says so until the next click or tab. */
let declined = false;

function renderHome(): void {
  const offline = isOffline(state);
  byId("offline-view").hidden = !offline;
  byId("activity-view").hidden = offline || !shared;
  const idle = !offline && shared === null;
  const offer = idle && found !== null && found.status !== "on" ? found : null;
  byId("suggestion-view").hidden = offer === null;
  byId("idle-view").hidden = !idle || offer !== null;
  byId("idle-view").textContent =
    found?.status === "on"
      ? `${found.info.name} is on. Nothing to share on this page yet.`
      : "Nothing to share on this page.";
  if (offer) renderOffer(offer);
}

function renderOffer({ info, status }: Found): void {
  byId("suggestion-icon").replaceChildren(activityIcon(info));
  byId("suggestion-name").textContent = info.name;
  byId("suggestion-site").textContent = info.hosts.join(", ");
  byId("suggestion-source").hidden = info.source !== "premid";
  const sites = [...new Set(missingSites(info, grants).map(siteName))].join(", ");
  const note = byId("suggestion-note");
  const action = buttonById("suggestion-action");
  if (status === "off") {
    note.textContent = declined
      ? "Your browser didn't allow access to its sites, so it stays off."
      : sites
        ? `An Activity for this site, turned off. Turning it on asks your browser for access to ${sites}.`
        : "An Activity for this site, turned off.";
    action.textContent = "Turn on";
  } else {
    note.textContent = declined
      ? `Your browser didn't allow access to ${sites}, so it still can't run here.`
      : `It's on, but your browser hasn't given it access to ${sites}, so it can't run here.`;
    action.textContent = "Allow access";
  }
  action.disabled = busy;
}

/** Looks for an Activity for the tab the popup belongs to, when nothing is being shared. */
let lookups = 0;
async function findForTab(): Promise<void> {
  const lookup = ++lookups;
  // The browser window the popup belongs to (the last focused one), not the popup itself.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let url: URL | null = null;
  try {
    url = tab?.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  const info = url ? await findActivity(url, states).catch(() => null) : null;
  if (lookup !== lookups) return;
  if (info?.id !== found?.info.id) declined = false;
  found = info && url ? { info, url, status: activityStatus(info, states, grants, url) } : null;
  renderHome();
}

function refreshFound(): void {
  if (found) found = { ...found, status: activityStatus(found.info, states, grants, found.url) };
  renderHome();
}

// Straight from the click: a browser only asks for sites then. Firefox closes
// the popup when it asks; turnOn saves the choice first, so it sticks.
byId("suggestion-action").addEventListener("click", () => {
  if (!found || busy) return;
  busy = true;
  declined = false;
  renderHome();
  const done =
    found.status === "off" ? turnOn(found.info, grants) : requestAccess(found.info, grants);
  void done.then((ok) => {
    busy = false;
    declined = !ok;
    refreshFound();
  });
});

watchActivityStates((next) => {
  states = next;
  if (shared === null) void findForTab();
});
watchGrants(() => {
  void readGrants().then((next) => {
    grants = next;
    refreshFound();
  });
});
void Promise.all([
  loadActivityStates().catch(() => ({})),
  readGrants().catch(() => NO_GRANTS),
]).then(([stored, granted]) => {
  states = stored;
  grants = granted;
  if (shared === null) void findForTab();
});

// Views: home, the settings list, one settings page, and the shared Activity's settings.
const homeView = byId("home-view");
const settingsView = byId("settings-view");
const settingsSlot = byId("settings-slot");
const configureView = byId("configure-view");
let openPage: SettingsPageView | null = null;
let currentPage: SettingsPageId | null = null;
let closeConfigure: (() => void) | null = null;

function showHome(): void {
  openPage?.destroy?.();
  openPage = null;
  currentPage = null;
  closeConfigure?.();
  closeConfigure = null;
  homeView.hidden = false;
  settingsView.hidden = true;
  configureView.hidden = true;
  byId("crumb-settings").hidden = false;
  byId("home-title").hidden = false;
  byId("settings-title").hidden = true;
  byId("settings-button").hidden = false;
  byId("status-badge").hidden = false;
  byId("settings-button").focus();
}

/** The shared Activity's own settings, the same as on its page in the dashboard. */
async function showConfigure(activity: UiActivity): Promise<void> {
  if (activity.id === DEFAULT_ACTIVITY_ID) {
    openDashboard("#default");
    return;
  }
  const info = await loadActivityInfo(activity.id);
  if (!info) return;
  const settings = activitySettings(info);
  closeConfigure = settings.destroy;
  byId("configure-slot").replaceChildren(settings.element);
  homeView.hidden = true;
  configureView.hidden = false;
  byId("home-title").hidden = true;
  byId("settings-title").hidden = false;
  byId("settings-button").hidden = true;
  byId("status-badge").hidden = true;
  byId("crumb-settings").hidden = true;
  byId("crumb-separator").hidden = true;
  byId("crumb-page").textContent = info.name;
  byId("back-button").focus();
}

function showSettings(page: SettingsPageId | null): void {
  currentPage = page;
  homeView.hidden = true;
  configureView.hidden = true;
  byId("crumb-settings").hidden = false;
  settingsView.hidden = false;
  byId("home-title").hidden = true;
  byId("settings-title").hidden = false;
  byId("settings-button").hidden = true;
  byId("status-badge").hidden = true;
  byId("settings-heading").hidden = page !== null;
  byId("crumb-separator").hidden = page === null;
  byId("crumb-page").textContent = page ? pageTitle(page) : "";
  // On the list, "Settings" is where you are; on a page, it's the way back.
  buttonById("crumb-settings").disabled = page === null;

  openPage?.destroy?.();
  if (page) {
    openPage = settingsPage(page, settings.actions, { inPopup: true });
    openPage.update(settings.context());
    settingsSlot.replaceChildren(openPage.element);
  } else {
    openPage = null;
    settingsSlot.replaceChildren(categoryList(showSettings));
  }
  byId("back-button").focus();
}

settings.subscribe((context) => openPage?.update(context));

byId("back-button").addEventListener("click", () =>
  currentPage ? showSettings(null) : showHome(),
);
byId("configure-button").addEventListener("click", () => {
  if (shared) void showConfigure(shared);
});
byId("crumb-settings").addEventListener("click", () => showSettings(null));
byId("settings-button").addEventListener("click", () => showSettings(null));
byId("retry-button").addEventListener("click", () => background.reconnect());
byId("expand-button").addEventListener("click", () =>
  openDashboard(settingsView.hidden ? "" : "#settings"),
);
