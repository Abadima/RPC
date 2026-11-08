import type { ConnectionState } from "../core/desktop-connection";
import { t } from "../core/i18n";
import type { PreferenceArea } from "../core/preferences";
import { isNewerRelease } from "../core/version";
import { latestDesktopVersion } from "./latest-desktop";
import { DESKTOP_DOWNLOAD } from "./links";

/**
 * What to tell someone whose Desktop and extension work together but aren't the
 * same release (core/version.ts), with a dismissal remembered per pair of
 * versions. A newer extension beside an older Desktop is normal, so "update
 * Desktop" is said only when GitHub lists a newer Desktop than the connected
 * one (`latestDesktop`).
 */
export interface UpdateNotice {
  key: string;
  title: string;
  detail: string;
  href?: string;
  action?: string;
}

const STORAGE_KEY = "dismissedUpdate";

export function updateNotice(
  state: ConnectionState,
  extensionVersion: string,
  latestDesktop?: string | null,
): UpdateNotice | null {
  if (state.status !== "connected" || !state.update || !state.desktopVersion) return null;
  const pair = `${state.update}:${extensionVersion}:${state.desktopVersion}`;
  if (state.update === "desktop") {
    if (!latestDesktop || !isNewerRelease(latestDesktop, state.desktopVersion)) return null;
    return {
      key: `${pair}:${latestDesktop}`,
      title: t("A newer Parousia Desktop is available"),
      detail: t(
        "This extension is newer than Parousia Desktop {version}. They still work together. Update Desktop to get everything the extension offers.",
        { version: state.desktopVersion },
      ),
      href: DESKTOP_DOWNLOAD,
      action: t("Update Parousia Desktop"),
    };
  }
  return {
    key: pair,
    title: t("A newer Parousia extension is available"),
    detail: t(
      "Parousia Desktop {version} is newer than this extension. They still work together. Update the extension from your browser's extension page.",
      { version: state.desktopVersion },
    ),
  };
}

export async function loadDismissedUpdate(
  area: PreferenceArea = chrome.storage.local,
): Promise<string | null> {
  const stored = (await area.get(STORAGE_KEY))[STORAGE_KEY];
  return typeof stored === "string" ? stored : null;
}

export async function dismissUpdate(
  key: string,
  area: PreferenceArea = chrome.storage.local,
): Promise<void> {
  await area.set({ [STORAGE_KEY]: key });
}

/**
 * Shows `notice` in `banner` (an element with a `[data-help]` body, as the
 * connection help uses), or hides it. A link to the update, if there is one,
 * and "Not now", which hides it and remembers.
 */
export function renderUpdateNotice(
  banner: HTMLElement,
  notice: UpdateNotice | null,
  dismissed: string | null,
  onDismiss: (key: string) => void,
): void {
  const body = banner.querySelector("[data-help]");
  banner.hidden = !notice || notice.key === dismissed || !body;
  if (!notice || banner.hidden || !body) return;
  const title = document.createElement("p");
  title.className = "banner-title";
  title.textContent = notice.title;
  const detail = document.createElement("p");
  detail.className = "banner-detail";
  detail.textContent = notice.detail;
  body.replaceChildren(title, detail);

  const actions = document.createElement("div");
  actions.className = "banner-actions";
  if (notice.href && notice.action) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = notice.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = notice.action;
    actions.append(link);
  }
  const later = document.createElement("button");
  later.className = "link-button";
  later.type = "button";
  later.textContent = t("Not now");
  later.addEventListener("click", () => onDismiss(notice.key));
  actions.append(later);
  banner.querySelector(".banner-actions")?.remove();
  banner.append(actions);
}

/**
 * Keeps `banner` showing the notice for the latest state, once what was
 * dismissed before has been read (so a dismissed notice never flashes).
 * Call the returned function with every connection state.
 */
export function updateBanner(
  banner: HTMLElement,
  lookUp: () => Promise<string | null> = () => latestDesktopVersion(),
): (state: ConnectionState) => void {
  let state: ConnectionState = { status: "idle" };
  let dismissed: string | null = null;
  let loaded = false;
  let latest: string | null | undefined;
  let asked = false;
  const show = (): void => {
    if (!loaded) return;
    renderUpdateNotice(
      banner,
      updateNotice(state, chrome.runtime.getManifest().version, latest),
      dismissed,
      (key) => {
        dismissed = key;
        void dismissUpdate(key).catch(() => {});
        show();
      },
    );
  };
  const ask = (): void => {
    if (asked || state.status !== "connected" || state.update !== "desktop") return;
    asked = true;
    lookUp()
      .catch(() => null)
      .then((version) => {
        latest = version;
        show();
      });
  };
  loadDismissedUpdate()
    .catch(() => null)
    .then((key) => {
      dismissed = key;
      loaded = true;
      show();
    });
  return (next) => {
    state = next;
    ask();
    show();
  };
}
