import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";
import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare";
import { faBug } from "@fortawesome/free-solid-svg-icons/faBug";
import { faChevronDown } from "@fortawesome/free-solid-svg-icons/faChevronDown";
import { faChevronRight } from "@fortawesome/free-solid-svg-icons/faChevronRight";
import { faCircleInfo } from "@fortawesome/free-solid-svg-icons/faCircleInfo";
import { faCodeBranch } from "@fortawesome/free-solid-svg-icons/faCodeBranch";
import { faGlobe } from "@fortawesome/free-solid-svg-icons/faGlobe";
import { faLink } from "@fortawesome/free-solid-svg-icons/faLink";
import { faLock } from "@fortawesome/free-solid-svg-icons/faLock";
import { faMinus } from "@fortawesome/free-solid-svg-icons/faMinus";
import { faPalette } from "@fortawesome/free-solid-svg-icons/faPalette";
import { faPlus } from "@fortawesome/free-solid-svg-icons/faPlus";
import { faScaleBalanced } from "@fortawesome/free-solid-svg-icons/faScaleBalanced";
import { faShieldHalved } from "@fortawesome/free-solid-svg-icons/faShieldHalved";
import { faSliders } from "@fortawesome/free-solid-svg-icons/faSliders";
import { faTowerBroadcast } from "@fortawesome/free-solid-svg-icons/faTowerBroadcast";
import { PAGE_DATA_KINDS, type PageDataKind } from "../core/activity";
import type { DesktopReport, DesktopSetting } from "../core/desktop-protocol";
import type { BridgeState } from "../core/ui-port";
import { desktopPlatformLabel, discordBridgeLabel } from "./connection-status";
import {
  DEFAULT_PREFERENCES,
  PLATFORM_IDS,
  formatIdleTimeout,
  loadPreferences,
  savePreferences,
  stepIdleTimeout,
  watchPreferences,
  type IncognitoBehavior,
  type PlatformId,
  type Preferences,
} from "../core/preferences";
import { readGrants, setAllSites, watchGrants } from "./activity-catalog";
import {
  THEME_IDS,
  THEME_LABELS,
  applyTheme,
  loadTheme,
  parseTheme,
  saveTheme,
  watchTheme,
  type ThemeId,
} from "./appearance";
import { icon } from "./icons";
import { REPOSITORY } from "./links";

export type SettingsPageId =
  | "general"
  | "appearance"
  | "privacy"
  | "access"
  | "platforms"
  | "connections"
  | "about";

interface PageInfo {
  id: SettingsPageId;
  title: string;
  subtitle: string;
  icon: IconDefinition;
  soon?: boolean;
}

export const SETTINGS_PAGES: readonly PageInfo[] = [
  { id: "general", title: "General", subtitle: "Language, Parousia Desktop", icon: faSliders },
  { id: "appearance", title: "Appearance", subtitle: "Theme", icon: faPalette },
  {
    id: "privacy",
    title: "Privacy",
    subtitle: "What's shared, what Activities read, incognito",
    icon: faLock,
  },
  {
    id: "access",
    title: "Site access",
    subtitle: "Access to all websites",
    icon: faGlobe,
  },
  {
    id: "platforms",
    title: "Platforms",
    subtitle: "Discord, Fluxer, Stoat",
    icon: faTowerBroadcast,
  },
  {
    id: "connections",
    title: "Connections",
    subtitle: "Linked accounts",
    icon: faLink,
    soon: true,
  },
  { id: "about", title: "About", subtitle: "Version, license, links", icon: faCircleInfo },
];

/** How each kind of page data reads in Settings > Privacy. */
export const DATA_LABELS: Record<PageDataKind, { title: string; detail: string }> = {
  media: {
    title: "What's playing",
    detail: "Titles, artists, and progress of what you're watching or listening to.",
  },
  thumbnails: {
    title: "Thumbnails",
    detail:
      "Images of what you're watching or reading, such as a video's thumbnail or an album cover.",
  },
  creatorIcons: {
    title: "Creator icons",
    detail: "Pictures of the channel, artist, or creator.",
  },
};

const PLATFORM_NAMES: Record<PlatformId, string> = {
  discord: "Discord",
  fluxer: "Fluxer",
  stoat: "Stoat",
};

export interface SettingsContext {
  preferences: Preferences;
  report: DesktopReport | null;
  /** Desktop refused the last change: it couldn't confirm this connection is the user's own. */
  settingRefused: boolean;
  /** Discord-RPC-Extension's app, as the background last reported it. */
  discord: BridgeState;
}

export interface SettingsActions {
  savePreferences(patch: Partial<Preferences>): void;
  setDesktopSetting(setting: DesktopSetting, value: boolean): void;
}

/**
 * What the settings pages show, and what they change: the extension's own
 * preferences from storage, and Desktop's settings through the background.
 * The popup and the dashboard each keep one.
 */
export interface SettingsModel {
  context(): SettingsContext;
  actions: SettingsActions;
  /** Feed every Desktop report (or `null`) from the background here. */
  onReport(report: DesktopReport | null): void;
  onDiscord(state: BridgeState): void;
  subscribe(listener: (context: SettingsContext) => void): void;
}

export function createSettingsModel(
  setDesktopSetting: (setting: DesktopSetting, value: boolean) => void,
): SettingsModel {
  let context: SettingsContext = {
    preferences: DEFAULT_PREFERENCES,
    report: null,
    settingRefused: false,
    discord: { status: "off", version: null },
  };
  /** A `null` answer to a `set` means Desktop refused it; to anything else, that it's gone. */
  let settingPending = false;
  const listeners: Array<(context: SettingsContext) => void> = [];
  const change = (patch: Partial<SettingsContext>): void => {
    context = { ...context, ...patch };
    for (const listener of listeners) listener(context);
  };

  loadPreferences().then(
    (preferences) => change({ preferences }),
    () => {},
  );
  watchPreferences((preferences) => change({ preferences }));

  return {
    context: () => context,
    actions: {
      savePreferences: (patch) => {
        // Show it at once; storage confirms through watchPreferences.
        change({ preferences: { ...context.preferences, ...patch } });
        void savePreferences(patch);
      },
      setDesktopSetting: (setting, value) => {
        settingPending = true;
        setDesktopSetting(setting, value);
      },
    },
    onReport: (report) => {
      const refused = settingPending && report === null && context.report !== null;
      settingPending = false;
      // Refused: keep the last report, which puts the switches back.
      change(refused ? { settingRefused: true } : { report, settingRefused: false });
    },
    onDiscord: (discord) => change({ discord }),
    subscribe: (listener) => {
      listeners.push(listener);
      listener(context);
    },
  };
}

// Building blocks

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function sectionLabel(text: string): HTMLElement {
  return el("h3", "section-label", text);
}

export function settingText(title: string, detail: string): HTMLElement {
  const text = el("span", "setting-text");
  text.append(el("span", "setting-title", title), el("span", "setting-detail", detail));
  return text;
}

/** A row whose whole area toggles its switch. */
export function switchRow(
  title: string,
  detail: string,
  onChange: (checked: boolean) => void,
  id?: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("label", "setting");
  const input = el("input", "switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  if (id) input.id = id;
  input.addEventListener("change", () => onChange(input.checked));
  row.append(settingText(title, detail), input);
  return { row, input };
}

/** A row with a control that isn't a single input, named by the row's title. */
export function controlRow(title: string, detail: string, control: HTMLElement): HTMLElement {
  const row = el("div", "setting");
  const text = settingText(title, detail);
  const titleId = `setting-${title.toLowerCase().replaceAll(/\W+/g, "-")}`;
  text.firstElementChild?.setAttribute("id", titleId);
  control.setAttribute("aria-labelledby", titleId);
  row.append(text, control);
  return row;
}

export function select<T extends string>(
  options: Array<[T, string]>,
  onChange: (value: T) => void,
): { wrapper: HTMLElement; input: HTMLSelectElement } {
  const wrapper = el("span", "select");
  const input = el("select");
  for (const [value, label] of options) {
    const option = el("option", "", label);
    option.value = value;
    input.append(option);
  }
  input.addEventListener("change", () => {
    const chosen = options.find(([value]) => value === input.value);
    if (chosen) onChange(chosen[0]);
  });
  wrapper.append(input, icon(faChevronDown));
  return { wrapper, input };
}

export function group(...rows: HTMLElement[]): HTMLElement {
  const box = el("div", "settings-group");
  box.append(...rows);
  return box;
}

// Pages

export interface SettingsPageView {
  element: HTMLElement;
  update(context: SettingsContext): void;
  /** Called when leaving the page. */
  destroy?(): void;
}

function generalPage(actions: SettingsActions): SettingsPageView {
  const language = select([["en", "English"]], (value) =>
    actions.savePreferences({ language: value }),
  );
  const offline = el("p", "offline-note", "Connect to Parousia Desktop to see and change these.");
  const userscripts = switchRow(
    "Allow userscripts",
    "Any web page can connect while this is on. Userscripts can only publish presence, never read status or change settings.",
    (checked) => actions.setDesktopSetting("allowUserscripts", checked),
    "setting-allowUserscripts",
  );
  const note = el(
    "p",
    "settings-note",
    "Parousia Desktop couldn't confirm this connection is yours, so these can't be changed from here. Use the Parousia-Desktop set command or Desktop's own console instead.",
  );
  note.id = "settings-note";
  note.setAttribute("role", "alert");
  const desktop = group(userscripts.row, note);
  desktop.id = "desktop-report";

  const element = el("div", "settings-page-body");
  element.append(
    sectionLabel("Language"),
    group(controlRow("Language", "More languages are planned.", language.wrapper)),
    sectionLabel("Parousia Desktop"),
    offline,
    desktop,
  );
  return {
    element,
    update({ preferences, report, settingRefused }) {
      language.input.value = preferences.language;
      offline.hidden = report !== null;
      desktop.hidden = report === null;
      note.hidden = !settingRefused;
      if (report) userscripts.input.checked = report.settings.allowUserscripts;
    },
  };
}

/** A small picture of a theme, drawn with that theme's own tokens (data-theme scopes them). */
function themePreview(theme: ThemeId): HTMLElement {
  const preview = el("span", "theme-preview");
  preview.dataset.theme = theme;
  preview.setAttribute("aria-hidden", "true");
  const card = el("span", "theme-preview-card");
  card.append(el("span", "theme-preview-dot"), el("span", "theme-preview-line"));
  preview.append(card, el("span", "theme-preview-button"));
  return preview;
}

/**
 * The theme, as a radio group: native radios, so arrow keys, labels, and
 * screen readers work as they do anywhere. A choice applies at once and
 * reaches every other open view through storage.
 */
function appearancePage(): SettingsPageView {
  const options = THEME_IDS.map((id) => {
    const { name, description } = THEME_LABELS[id];
    const row = el("label", "setting theme-option");
    const input = el("input", "radio");
    input.type = "radio";
    input.name = "theme";
    input.value = id;
    const text = settingText(name, description);
    text.firstElementChild?.setAttribute("id", `theme-${id}-name`);
    text.lastElementChild?.setAttribute("id", `theme-${id}-description`);
    input.setAttribute("aria-labelledby", `theme-${id}-name`);
    input.setAttribute("aria-describedby", `theme-${id}-description`);
    input.addEventListener("change", () => {
      if (!input.checked) return;
      applyTheme(id);
      void saveTheme(id);
    });
    row.append(themePreview(id), text, input);
    return { id, input, row };
  });
  const show = (theme: ThemeId): void => {
    for (const { id, input } of options) input.checked = id === theme;
  };

  const label = sectionLabel("Theme");
  label.id = "theme-label";
  const choices = group(...options.map(({ row }) => row));
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-labelledby", "theme-label");

  const element = el("div", "settings-page-body");
  element.append(label, choices);
  // What's on screen now, then what storage says.
  show(parseTheme(document.documentElement.dataset.theme));
  loadTheme().then(show, () => {});
  const stop = watchTheme(show);
  return { element, update() {}, destroy: stop };
}

function privacyPage(actions: SettingsActions): SettingsPageView {
  const media = switchRow(
    "Share Media Details",
    "Include what you're watching or reading, not just the site's name.",
    (checked) => actions.savePreferences({ shareMediaDetails: checked }),
  );

  const stepper = el("div", "stepper");
  const minus = el("button", "stepper-button");
  const plus = el("button", "stepper-button");
  const value = el("output", "stepper-value");
  minus.type = plus.type = "button";
  minus.setAttribute("aria-label", "Shorter");
  plus.setAttribute("aria-label", "Longer");
  minus.append(icon(faMinus));
  plus.append(icon(faPlus));
  stepper.append(minus, value, plus);
  let minutes = DEFAULT_PREFERENCES.idleTimeoutMinutes;
  const step = (direction: 1 | -1): void =>
    actions.savePreferences({ idleTimeoutMinutes: stepIdleTimeout(minutes, direction) });
  minus.addEventListener("click", () => step(-1));
  plus.addEventListener("click", () => step(1));

  const incognito = select<IncognitoBehavior>(
    [
      ["pause", "Pause activity"],
      ["share", "Share as usual"],
    ],
    (behavior) => actions.savePreferences({ incognito: behavior }),
  );
  const incognitoRow = el("div", "setting setting-stacked");
  const incognitoText = settingText(
    "Incognito Behaviour",
    "What to do in private windows, if you've allowed Parousia there.",
  );
  incognitoText.firstElementChild?.setAttribute("id", "setting-incognito");
  incognito.input.setAttribute("aria-labelledby", "setting-incognito");
  incognitoRow.append(incognitoText, incognito.wrapper);

  // One choice for every Activity: switched off, a kind is never read (native
  // Activities) or never shown (PreMiD's, whose own code reads the page).
  let pageData = DEFAULT_PREFERENCES.pageData;
  const kinds = PAGE_DATA_KINDS.map((kind) => {
    const { title, detail } = DATA_LABELS[kind];
    const row = switchRow(title, detail, (on) =>
      actions.savePreferences({ pageData: { ...pageData, [kind]: on } }),
    );
    row.row.dataset.kind = kind;
    return { kind, input: row.input, row: row.row };
  });

  const element = el("div", "settings-page-body");
  element.append(
    sectionLabel("What leaves your browser"),
    group(
      media.row,
      controlRow(
        "Idle Timeout",
        "Keep sharing this long after you switch away from the browser. Sound playing keeps it going.",
        stepper,
      ),
      incognitoRow,
    ),
    sectionLabel("What Activities may read"),
    el(
      "p",
      "settings-hint",
      "On sites you've granted, Activities that read pages may take these. Switched off, Parousia doesn't read them, and doesn't show what an Activity's own code read.",
    ),
    group(...kinds.map(({ row }) => row)),
  );
  return {
    element,
    update({ preferences }) {
      pageData = preferences.pageData;
      for (const { kind, input } of kinds) input.checked = preferences.pageData[kind];
      media.input.checked = preferences.shareMediaDetails;
      minutes = preferences.idleTimeoutMinutes;
      value.textContent = formatIdleTimeout(minutes);
      minus.disabled = stepIdleTimeout(minutes, -1) === minutes;
      plus.disabled = stepIdleTimeout(minutes, 1) === minutes;
      incognito.input.value = preferences.incognito;
    },
  };
}

function platformsPage(actions: SettingsActions): SettingsPageView {
  const inputs = new Map<PlatformId, HTMLInputElement>();
  /** What Parousia Desktop last said about each platform. */
  const statuses = new Map<PlatformId, HTMLElement>();
  let currentPlatforms = DEFAULT_PREFERENCES.platforms;
  const rows = PLATFORM_IDS.map((id) => {
    const name = PLATFORM_NAMES[id];
    const { row, input } = switchRow(
      `${name} Rich Presence`,
      `Show your activity on ${name}.`,
      (checked) => {
        const platforms = { ...currentPlatforms, [id]: checked };
        actions.savePreferences({ platforms });
      },
    );
    const tile = el("span", "tile tile-letter", name.charAt(0));
    tile.setAttribute("aria-hidden", "true");
    row.prepend(tile);
    const status = el("span", "setting-status");
    row.querySelector(".setting-text")?.append(status);
    statuses.set(id, status);
    inputs.set(id, input);
    return row;
  });

  const note = el(
    "p",
    "info-note",
    "Parousia Desktop shows your activity on these apps. Discord works now; Fluxer and Stoat are still being built, so those choices are saved for when they arrive.",
  );

  const bridge = switchRow(
    "Discord-RPC-Extension",
    "Show Discord presence through Discord-RPC-Extension's app (discord_rpc_ext) on this computer, when it's running. Rich Presence only: nothing else is sent to it or accepted from it.",
    (checked) => actions.savePreferences({ discordRpcExtension: checked }),
  );
  const bridgeStatus = el("span", "setting-status");
  bridge.row.querySelector(".setting-text")?.append(bridgeStatus);

  const element = el("div", "settings-page-body");
  element.append(
    sectionLabel("Presence platforms"),
    note,
    group(...rows),
    sectionLabel("Discord without Parousia Desktop"),
    group(bridge.row),
  );
  return {
    element,
    update({ preferences, discord, report }) {
      currentPlatforms = preferences.platforms;
      for (const [id, input] of inputs) input.checked = preferences.platforms[id];
      for (const [id, status] of statuses) {
        const label = preferences.platforms[id] ? desktopPlatformLabel(report, id) : null;
        status.hidden = label === null;
        status.textContent = label ? `Parousia Desktop: ${label}` : "";
        const showing = report?.platforms.some((p) => p.platform === id && p.state === "showing");
        status.dataset.tone = showing ? "good" : "idle";
      }
      bridge.input.checked = preferences.discordRpcExtension;
      bridge.input.disabled = !preferences.platforms.discord;
      // A report means Desktop is connected, and then it shows Discord itself.
      bridgeStatus.textContent = !preferences.platforms.discord
        ? "Off while Discord Rich Presence is off"
        : report && preferences.discordRpcExtension
          ? "Standing by while Parousia Desktop shows Discord"
          : discordBridgeLabel(discord);
      bridgeStatus.dataset.tone = discord.status === "connected" && !report ? "good" : "idle";
    },
  };
}

/**
 * Site access: "Access your data for all websites", off by default and only
 * ever turned on here. Individual sites are the browser's to grant and take
 * back (its prompt when an Activity is turned on, its extension settings
 * after), so they aren't listed or revoked from here: a browser won't let an
 * extension take back every kind of grant, and a list that disagrees with the
 * browser's own would mislead. A browser only asks for access in response to
 * a click, and a popup can close when it asks (Firefox's does), so in the
 * popup this page shows the state and points to the dashboard.
 */
function accessPage(inPopup: boolean): SettingsPageView {
  const all = switchRow(
    "Access your data for all websites",
    "Off by default. With it on, Activities that read pages can read any site, without asking site by site. Parousia never turns it on by itself.",
    (on) => {
      all.input.disabled = true;
      void setAllSites(on).then(refresh);
    },
    "setting-allSites",
  );
  const element = el("div", "settings-page-body");
  element.append(
    sectionLabel("All websites"),
    group(all.row),
    el(
      "p",
      "info-note",
      "Otherwise your browser asks before an Activity reads a site, when you turn the Activity on. Sites you allowed are managed in your browser's settings for this extension.",
    ),
  );
  if (inPopup) {
    all.input.disabled = true;
    const open = el("button", "button button-block", "Change in the dashboard");
    open.type = "button";
    open.addEventListener("click", () => {
      void chrome.tabs.create({ url: chrome.runtime.getURL("fullscreen.html#settings/access") });
      window.close();
    });
    element.prepend(
      el(
        "p",
        "info-note",
        "Your browser asks before granting access, which it does from the dashboard.",
      ),
      open,
    );
  }

  function refresh(): void {
    void readGrants().then((grants) => {
      all.input.checked = grants.all;
      all.input.disabled = inPopup;
    });
  }
  const stop = watchGrants(refresh);
  refresh();
  return { element, update() {}, destroy: stop };
}

function connectionsPage(): SettingsPageView {
  const element = el("div", "settings-page-body");
  const empty = el("div", "empty-card");
  const visual = el("span", "empty-visual");
  visual.append(icon(faLink));
  empty.append(
    visual,
    el("span", "pill", "Coming soon"),
    el("p", "empty-title", "Linked accounts"),
    el(
      "p",
      "empty-text",
      "Link accounts such as Jena Cloud to share presence without Parousia Desktop.",
    ),
  );
  element.append(empty);
  return { element, update() {} };
}

function aboutPage(): SettingsPageView {
  const facts = el("dl", "facts settings-group");
  const fact = (term: string, value: string): HTMLElement => {
    const row = el("div");
    const dd = el("dd", "", value);
    row.append(el("dt", "", term), dd);
    facts.append(row);
    return dd;
  };
  fact("Extension", chrome.runtime.getManifest().version);
  const desktopVersion = fact("Parousia Desktop", "Not connected");
  fact("License", "Apache License 2.0");

  const links = el("div", "link-list");
  for (const [title, href, glyph] of [
    ["Source code on GitHub", REPOSITORY, faCodeBranch],
    ["Report an issue", `${REPOSITORY}/issues`, faBug],
    ["Security policy", `${REPOSITORY}/security/policy`, faShieldHalved],
    ["Apache License 2.0", `${REPOSITORY}/blob/main/LICENSE`, faScaleBalanced],
  ] as const) {
    const link = el("a", "row");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const tile = el("span", "tile");
    tile.append(icon(glyph));
    const text = el("span", "row-text");
    text.append(el("span", "row-title", title), el("span", "row-subtitle", href.slice(8)));
    const external = el("span", "row-chevron");
    external.append(icon(faArrowUpRightFromSquare));
    link.append(tile, text, external);
    links.append(link);
  }

  const element = el("div", "settings-page-body");
  element.append(sectionLabel("Versions"), facts, sectionLabel("Links"), links);
  return {
    element,
    update({ report }) {
      desktopVersion.textContent = report?.version ?? "Not connected";
    },
  };
}

export function settingsPage(
  page: SettingsPageId,
  actions: SettingsActions,
  { inPopup = false }: { inPopup?: boolean } = {},
): SettingsPageView {
  switch (page) {
    case "general":
      return generalPage(actions);
    case "appearance":
      return appearancePage();
    case "privacy":
      return privacyPage(actions);
    case "access":
      return accessPage(inPopup);
    case "platforms":
      return platformsPage(actions);
    case "connections":
      return connectionsPage();
    case "about":
      return aboutPage();
  }
}

/** The category rows, as buttons; `current` marks the one on show (the dashboard's two panes). */
export function categoryList(
  onOpen: (page: SettingsPageId) => void,
  current?: SettingsPageId,
): HTMLElement {
  const list = el("div", "category-list");
  for (const page of SETTINGS_PAGES) {
    const row = el("button", "row category");
    row.type = "button";
    if (page.id === current) row.setAttribute("aria-current", "page");
    const glyph = el("span", "category-icon");
    glyph.append(icon(page.icon));
    const text = el("span", "row-text");
    text.append(el("span", "row-title", page.title), el("span", "row-subtitle", page.subtitle));
    row.append(glyph, text);
    if (page.soon) row.append(el("span", "pill", "Soon"));
    const chevron = el("span", "row-chevron");
    chevron.append(icon(faChevronRight));
    row.append(chevron);
    row.addEventListener("click", () => onOpen(page.id));
    list.append(row);
  }
  return list;
}

export function pageTitle(page: SettingsPageId): string {
  return SETTINGS_PAGES.find((info) => info.id === page)?.title ?? "";
}
